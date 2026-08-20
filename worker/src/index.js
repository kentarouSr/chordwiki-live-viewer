const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Key',
};

// 自動発行した置き場所(self_issued = 1)にかける上限。
// R2の無料枠が10GBなので、数十人が使っても収まる大きさにしてある。
// 持ち主が手で足したキーには一切かからない。
const SPACE_MAX_SONGS = 150;
const SPACE_MAX_BYTES = 200 * 1024 * 1024; // 200MB
// 同じ回線から1日に発行できる数。1人が携帯・タブレット・PCで開くと
// それぞれ別のURLになりうるので、少しだけ余裕を持たせている。
const SPACE_ISSUE_PER_IP_PER_DAY = 5;

// IPをそのまま保存せず、連投を数えるためだけのハッシュにする
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });

    const err = (msg, status = 400) => json({ error: msg }, status);

    const getKey = () =>
      request.headers.get('X-Sync-Key') || url.searchParams.get('key');

    // 同期キーは「合言葉」であると同時に「どの本棚か」の識別子でもある。
    // キーごとに完全に別のデータを持つので、友達それぞれに別のキーを渡せば
    // お互いの曲・セットリストは見えない。
    //
    // 誰でも好きなキーで使えるようにすると、URLさえ分かれば第三者にストレージを
    // 使われてしまう(無料枠を食い潰される)ため、許可リストに載っているキーだけを
    // 受け付ける。許可リストはD1の allowed_keys テーブルで持つ(Workerのシークレット
    // だと実行時に書き換えられないため)。
    // env.SYNC_KEYS / env.SYNC_KEY はD1移行前からの後方互換のフォールバック。
    const envAllowedKeys = () =>
      String(env.SYNC_KEYS || env.SYNC_KEY || '')
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean);

    const requireKey = async () => {
      const key = getKey();
      if (!key) return null;
      if (envAllowedKeys().includes(key)) return key;
      const row = await env.DB.prepare('SELECT 1 FROM allowed_keys WHERE key = ?').bind(key).first();
      return row ? key : null;
    };

    // あなた用のURLはアプリ側が作る(初回訪問した時点でアドレスバーに入れて
    // しまい、あとから登録しても**URLが変わらない**ようにするため。
    // サーバーが作ると、登録の瞬間にURLが変わってしまう)。
    // ここでは形だけ確かめる: base64urlの32文字、つまり24バイトぶん。
    const isValidSpaceKey = (k) => typeof k === 'string' && /^[A-Za-z0-9_-]{32}$/.test(k);

    // この置き場所が自動発行された物かどうか。上限をかけるのはこちらだけ。
    const isSelfIssued = async (key) => {
      const row = await env.DB.prepare('SELECT self_issued FROM allowed_keys WHERE key = ?')
        .bind(key).first();
      return !!(row && row.self_issued);
    };

    const rowToSong = (row) => ({
      uuid: row.uuid,
      name: row.name,
      bpm: row.bpm,
      speed: row.speed,
      fileName: row.file_name,
      mimeType: row.mime_type,
      youtubeUrl: row.youtube_url || null,
      memos: row.memos ? JSON.parse(row.memos) : [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });

    const rowToSetlist = (row) => {
      let items = row.items_json ? JSON.parse(row.items_json) : [];
      // 移行前(曲uuidの配列のみ)のデータをその場で正規化する
      items = items.map((it) => (typeof it === 'string' ? { type: 'song', uuid: it } : it));
      return {
        uuid: row.uuid,
        name: row.name,
        items,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    };

    try {
      // 曲一覧(メタデータのみ)
      if (path === '/api/songs' && request.method === 'GET') {
        const key = await requireKey();
        if (!key) return err('invalid key', 401);
        const { results } = await env.DB
          .prepare('SELECT * FROM songs WHERE sync_key = ? ORDER BY updated_at DESC')
          .bind(key).all();
        return json(results.map(rowToSong));
      }

      // 曲の削除tombstone一覧(他端末が削除を検知して復活アップロードしないため)
      if (path === '/api/songs/tombstones' && request.method === 'GET') {
        const key = await requireKey();
        if (!key) return err('invalid key', 401);
        const { results } = await env.DB
          .prepare('SELECT uuid, deleted_at FROM deleted_songs WHERE sync_key = ?')
          .bind(key).all();
        return json(results.map((r) => ({ uuid: r.uuid, deletedAt: r.deleted_at })));
      }

      const songIdMatch = path.match(/^\/api\/songs\/([0-9a-f-]{36})$/);

      // 曲を追加/更新(メタデータ+ファイル本体をmultipart/form-dataで一度に送る)
      if (songIdMatch && request.method === 'PUT') {
        const key = await requireKey();
        if (!key) return err('invalid key', 401);
        const uuid = songIdMatch[1];
        const form = await request.formData();
        const file = form.get('file');
        const name = form.get('name');
        const fileName = form.get('fileName');
        const mimeType = form.get('mimeType');
        const speed = parseInt(form.get('speed'), 10);
        const bpmRaw = form.get('bpm');
        const bpm = bpmRaw ? parseInt(bpmRaw, 10) : null;
        const memosRaw = form.get('memos');
        const youtubeUrlRaw = form.get('youtubeUrl');
        const createdAt = parseInt(form.get('createdAt'), 10);
        const updatedAt = parseInt(form.get('updatedAt'), 10);

        if (!file || !name || !fileName || !mimeType || !Number.isFinite(updatedAt)) {
          return err('missing fields');
        }

        // 別の本棚の同じuuidを上書きしてしまわないよう、既存行があれば持ち主を確認する
        // (uuidはランダムなので実際には起きないが、他人のデータを壊さない保証として)。
        const owner = await env.DB.prepare('SELECT sync_key FROM songs WHERE uuid = ?').bind(uuid).first();
        if (owner && owner.sync_key !== key) return err('forbidden', 403);

        // 自動発行された置き場所には上限をかける。
        // 上書き(既にある曲の更新)は曲数を増やさないので、新規の時だけ数える。
        const size = Number(file.size) || 0;
        if (await isSelfIssued(key)) {
          const used = await env.DB.prepare(
            'SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes'
            + ' FROM songs WHERE sync_key = ? AND uuid <> ?'
          ).bind(key, uuid).first();
          const n = (used && used.n) || 0;
          const bytes = (used && used.bytes) || 0;
          if (!owner && n >= SPACE_MAX_SONGS) {
            return err(`このURLに保存できる曲は${SPACE_MAX_SONGS}曲までです。`
              + '不要な曲を削除するか、ZIPバックアップに移してください。', 413);
          }
          if (bytes + size > SPACE_MAX_BYTES) {
            const mb = Math.round(SPACE_MAX_BYTES / 1024 / 1024);
            return err(`このURLに保存できる容量(${mb}MB)を超えました。`
              + '不要な曲を削除するか、ZIPバックアップに移してください。', 413);
          }
        }

        const r2Key = `songs/${uuid}`;
        await env.BUCKET.put(r2Key, file.stream(), {
          httpMetadata: { contentType: mimeType },
        });

        await env.DB.prepare(
          `INSERT INTO songs (uuid, sync_key, name, bpm, speed, file_name, mime_type, r2_key, memos, youtube_url, size_bytes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(uuid) DO UPDATE SET
             name = excluded.name, bpm = excluded.bpm, speed = excluded.speed,
             file_name = excluded.file_name, mime_type = excluded.mime_type,
             r2_key = excluded.r2_key, memos = excluded.memos, youtube_url = excluded.youtube_url,
             size_bytes = excluded.size_bytes,
             updated_at = excluded.updated_at`
        ).bind(uuid, key, name, bpm, speed || 20, fileName, mimeType, r2Key, memosRaw || '[]', youtubeUrlRaw || null, size, createdAt || Date.now(), updatedAt).run();
        // 過去に削除されていても、それより新しい更新なら復活とみなしtombstoneを消す
        await env.DB.prepare('DELETE FROM deleted_songs WHERE uuid = ? AND sync_key = ?').bind(uuid, key).run();

        return json({ ok: true });
      }

      // 曲のファイル本体取得
      const fileMatch = path.match(/^\/api\/songs\/([0-9a-f-]{36})\/file$/);
      if (fileMatch && request.method === 'GET') {
        const key = await requireKey();
        if (!key) return err('invalid key', 401);
        const uuid = fileMatch[1];
        const row = await env.DB
          .prepare('SELECT r2_key, mime_type FROM songs WHERE uuid = ? AND sync_key = ?')
          .bind(uuid, key).first();
        if (!row) return err('not found', 404);
        const object = await env.BUCKET.get(row.r2_key);
        if (!object) return err('file not found in storage', 404);
        return new Response(object.body, {
          headers: { ...CORS, 'Content-Type': row.mime_type },
        });
      }

      // 曲の削除
      if (songIdMatch && request.method === 'DELETE') {
        const key = await requireKey();
        if (!key) return err('invalid key', 401);
        const uuid = songIdMatch[1];
        const row = await env.DB
          .prepare('SELECT r2_key FROM songs WHERE uuid = ? AND sync_key = ?')
          .bind(uuid, key).first();
        if (row) await env.BUCKET.delete(row.r2_key);
        await env.DB.prepare('DELETE FROM songs WHERE uuid = ? AND sync_key = ?').bind(uuid, key).run();
        await env.DB.prepare(
          `INSERT INTO deleted_songs (uuid, sync_key, deleted_at) VALUES (?, ?, ?)
           ON CONFLICT(uuid) DO UPDATE SET deleted_at = excluded.deleted_at, sync_key = excluded.sync_key`
        ).bind(uuid, key, Date.now()).run();
        return json({ ok: true });
      }

      // セットリスト一覧
      if (path === '/api/setlists' && request.method === 'GET') {
        const key = await requireKey();
        if (!key) return err('invalid key', 401);
        const { results } = await env.DB
          .prepare('SELECT * FROM setlists WHERE sync_key = ? ORDER BY updated_at DESC')
          .bind(key).all();
        return json(results.map(rowToSetlist));
      }

      // セットリストの削除tombstone一覧
      if (path === '/api/setlists/tombstones' && request.method === 'GET') {
        const key = await requireKey();
        if (!key) return err('invalid key', 401);
        const { results } = await env.DB
          .prepare('SELECT uuid, deleted_at FROM deleted_setlists WHERE sync_key = ?')
          .bind(key).all();
        return json(results.map((r) => ({ uuid: r.uuid, deletedAt: r.deleted_at })));
      }

      const setlistIdMatch = path.match(/^\/api\/setlists\/([0-9a-f-]{36})$/);

      // セットリストの追加/更新(バイナリを含まないのでJSONで送る)
      if (setlistIdMatch && request.method === 'PUT') {
        const key = await requireKey();
        if (!key) return err('invalid key', 401);
        const uuid = setlistIdMatch[1];
        const body = await request.json();
        const { name, items, createdAt, updatedAt } = body;
        if (!name || !Array.isArray(items) || !Number.isFinite(updatedAt)) {
          return err('missing fields');
        }

        const owner = await env.DB.prepare('SELECT sync_key FROM setlists WHERE uuid = ?').bind(uuid).first();
        if (owner && owner.sync_key !== key) return err('forbidden', 403);

        await env.DB.prepare(
          `INSERT INTO setlists (uuid, sync_key, name, items_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(uuid) DO UPDATE SET
             name = excluded.name, items_json = excluded.items_json, updated_at = excluded.updated_at`
        ).bind(uuid, key, name, JSON.stringify(items), createdAt || Date.now(), updatedAt).run();
        await env.DB.prepare('DELETE FROM deleted_setlists WHERE uuid = ? AND sync_key = ?').bind(uuid, key).run();

        return json({ ok: true });
      }

      // セットリストの削除
      if (setlistIdMatch && request.method === 'DELETE') {
        const key = await requireKey();
        if (!key) return err('invalid key', 401);
        const uuid = setlistIdMatch[1];
        await env.DB.prepare('DELETE FROM setlists WHERE uuid = ? AND sync_key = ?').bind(uuid, key).run();
        await env.DB.prepare(
          `INSERT INTO deleted_setlists (uuid, sync_key, deleted_at) VALUES (?, ?, ?)
           ON CONFLICT(uuid) DO UPDATE SET deleted_at = excluded.deleted_at, sync_key = excluded.sync_key`
        ).bind(uuid, key, Date.now()).run();
        return json({ ok: true });
      }

      // 練習ToDo(本棚ごとに1つ、sync_keyを主キーにした1行にまるごとJSONを保存)
      if (path === '/api/todos' && request.method === 'GET') {
        const key = await requireKey();
        if (!key) return err('invalid key', 401);
        const row = await env.DB
          .prepare('SELECT items_json, updated_at FROM practice_todos WHERE sync_key = ?')
          .bind(key).first();
        if (!row) return json({ items: [], updatedAt: 0 });
        return json({ items: JSON.parse(row.items_json), updatedAt: row.updated_at });
      }
      if (path === '/api/todos' && request.method === 'PUT') {
        const key = await requireKey();
        if (!key) return err('invalid key', 401);
        const body = await request.json();
        const { items, updatedAt } = body;
        if (!Array.isArray(items) || !Number.isFinite(updatedAt)) return err('missing fields');
        await env.DB.prepare(
          `INSERT INTO practice_todos (sync_key, items_json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(sync_key) DO UPDATE SET items_json = excluded.items_json, updated_at = excluded.updated_at`
        ).bind(key, JSON.stringify(items), updatedAt).run();
        return json({ ok: true });
      }

      // メモのスタンプ(本棚ごとに1つ、練習ToDoと同じ持ち方)
      if (path === '/api/stamps' && request.method === 'GET') {
        const key = await requireKey();
        if (!key) return err('invalid key', 401);
        const row = await env.DB
          .prepare('SELECT items_json, updated_at FROM memo_stamps WHERE sync_key = ?')
          .bind(key).first();
        if (!row) return json({ items: [], updatedAt: 0 });
        return json({ items: JSON.parse(row.items_json), updatedAt: row.updated_at });
      }
      if (path === '/api/stamps' && request.method === 'PUT') {
        const key = await requireKey();
        if (!key) return err('invalid key', 401);
        const body = await request.json();
        const { items, updatedAt } = body;
        if (!Array.isArray(items) || !Number.isFinite(updatedAt)) return err('missing fields');
        await env.DB.prepare(
          `INSERT INTO memo_stamps (sync_key, items_json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(sync_key) DO UPDATE SET items_json = excluded.items_json, updated_at = excluded.updated_at`
        ).bind(key, JSON.stringify(items), updatedAt).run();
        return json({ ok: true });
      }

      // 音楽関連サイトのリンク集(本棚ごとに1つ、練習ToDoと同じ持ち方)
      if (path === '/api/links' && request.method === 'GET') {
        const key = await requireKey();
        if (!key) return err('invalid key', 401);
        const row = await env.DB
          .prepare('SELECT items_json, updated_at FROM music_links WHERE sync_key = ?')
          .bind(key).first();
        if (!row) return json({ items: [], updatedAt: 0 });
        return json({ items: JSON.parse(row.items_json), updatedAt: row.updated_at });
      }
      if (path === '/api/links' && request.method === 'PUT') {
        const key = await requireKey();
        if (!key) return err('invalid key', 401);
        const body = await request.json();
        const { items, updatedAt } = body;
        if (!Array.isArray(items) || !Number.isFinite(updatedAt)) return err('missing fields');
        await env.DB.prepare(
          `INSERT INTO music_links (sync_key, items_json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(sync_key) DO UPDATE SET items_json = excluded.items_json, updated_at = excluded.updated_at`
        ).bind(key, JSON.stringify(items), updatedAt).run();
        return json({ ok: true });
      }

      // フレーズ集(本棚ごとに1つ、練習ToDoと同じ持ち方)。
      // 1件ごとにプレビュー用のPNG(data URL)を持つぶん他より重くなりうるが、
      // 数十件程度の想定なのでJSONまるごと方式のままで問題ない。
      if (path === '/api/phrases' && request.method === 'GET') {
        const key = await requireKey();
        if (!key) return err('invalid key', 401);
        const row = await env.DB
          .prepare('SELECT items_json, updated_at FROM music_phrases WHERE sync_key = ?')
          .bind(key).first();
        if (!row) return json({ items: [], updatedAt: 0 });
        return json({ items: JSON.parse(row.items_json), updatedAt: row.updated_at });
      }
      if (path === '/api/phrases' && request.method === 'PUT') {
        const key = await requireKey();
        if (!key) return err('invalid key', 401);
        const body = await request.json();
        const { items, updatedAt } = body;
        if (!Array.isArray(items) || !Number.isFinite(updatedAt)) return err('missing fields');
        await env.DB.prepare(
          `INSERT INTO music_phrases (sync_key, items_json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(sync_key) DO UPDATE SET items_json = excluded.items_json, updated_at = excluded.updated_at`
        ).bind(key, JSON.stringify(items), updatedAt).run();
        return json({ ok: true });
      }

      // ------------------------------------------------------------------
      // あなた用のURLの登録(2026-08-20)
      // ------------------------------------------------------------------
      // アプリは初回訪問した時点で自分でURLを作り、アドレスバーに入れる。
      // ただしその時点では**まだ登録しない**。実際に中身を変える操作をした時に
      // 初めてここへ来る。見に来ただけで帰る人がD1に行を作らないようにするため。
      //
      // 誰でも呼べるので、同じ回線からの1日あたりの発行数を制限する。
      // 既に登録済みのキーが来た場合は、そのまま成功として返す
      // (通信が途中で切れた時などに、アプリが安心して呼び直せるように)。
      if (path === '/api/space' && request.method === 'POST') {
        const payload = await request.json().catch(() => null);
        if (!payload) return err('bad body');
        const key = String(payload.key || '');
        if (!isValidSpaceKey(key)) return err('bad key');

        const existing = await env.DB.prepare('SELECT 1 FROM allowed_keys WHERE key = ?')
          .bind(key).first();
        if (existing) return json({ ok: true, alreadyRegistered: true });

        const ipHash = await sha256Hex(
          (request.headers.get('CF-Connecting-IP') || 'unknown') + '|cwlv-space'
        );
        const since = Date.now() - 24 * 60 * 60 * 1000;
        const recent = await env.DB.prepare(
          'SELECT COUNT(*) AS n FROM allowed_keys WHERE ip_hash = ? AND created_at > ?'
        ).bind(ipHash, since).first();
        if (recent && recent.n >= SPACE_ISSUE_PER_IP_PER_DAY) {
          return err('しばらく待ってからお試しください(発行が多すぎます)。'
            + 'このままでも、この端末の中だけでは今まで通り全機能が使えます。', 429);
        }

        await env.DB.prepare(
          'INSERT INTO allowed_keys (key, label, created_at, self_issued, ip_hash)'
          + ' VALUES (?, ?, ?, 1, ?)'
        ).bind(key, 'self-issued', Date.now(), ipHash).run();
        return json({ ok: true, maxSongs: SPACE_MAX_SONGS, maxBytes: SPACE_MAX_BYTES });
      }

      // ------------------------------------------------------------------
      // 不具合・要望の受け取り(2026-08-21)
      // ------------------------------------------------------------------
      // **鍵(URLのパラメータ)を必須にしない。** 一般公開する予定で、
      // 鍵を持たない人(クラウド保存を使わず端末内だけで使う人)が大半になる
      // 見込みだから。鍵が要ると新規の人がまったく報告できず、
      // 受け取り口の意味が無くなる。
      //
      // そのぶん誰でも投げられるので、荒らし対策を2つ入れている:
      //   ・本文とバージョン/UAの長さを切る(D1を埋められないように)
      //   ・同じIPからの連投を1時間あたり10件までにする
      //     (IPはそのまま保存せず、ハッシュにして数えるためだけに使う)
      if (path === '/api/feedback' && request.method === 'POST') {
        const payload = await request.json().catch(() => null);
        if (!payload) return err('bad body');
        const kind = payload.kind === 'bug' ? 'bug' : 'request';
        const body = String(payload.body || '').trim().slice(0, 4000);
        if (!body) return err('本文が空です');
        const appVersion = String(payload.appVersion || '').slice(0, 40);
        const ua = String(request.headers.get('User-Agent') || '').slice(0, 300);
        const key = getKey();
        const keyTail = key ? String(key).slice(-4) : null;

        const ipHash = await sha256Hex(
          (request.headers.get('CF-Connecting-IP') || 'unknown') + '|cwlv-feedback'
        );
        const since = Date.now() - 60 * 60 * 1000;
        const recent = await env.DB.prepare(
          'SELECT COUNT(*) AS n FROM feedback WHERE ip_hash = ? AND created_at > ?'
        ).bind(ipHash, since).first();
        if (recent && recent.n >= 10) {
          return err('しばらく待ってから送信してください(送信が多すぎます)', 429);
        }

        await env.DB.prepare(
          'INSERT INTO feedback (id, kind, body, app_version, user_agent, key_tail, ip_hash, created_at)'
          + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(crypto.randomUUID(), kind, body, appVersion, ua, keyTail, ipHash, Date.now()).run();
        return json({ ok: true });
      }

      // ------------------------------------------------------------------
      // 使われ方の記録(2026-08-21)
      // ------------------------------------------------------------------
      // 「日ごとに何人が開いたか」だけを数える。anon_id は端末ごとにアプリが作る
      // ランダムなIDで、誰かは分からない。同じ日・同じ端末は1行にまとまるので
      // 行数は増え続けない。こちらも鍵は不要(鍵を持たない人こそ数えたいため)。
      if (path === '/api/usage' && request.method === 'POST') {
        const payload = await request.json().catch(() => null);
        if (!payload) return err('bad body');
        const anonId = String(payload.anonId || '').slice(0, 64);
        if (!anonId) return err('bad id');
        const appVersion = String(payload.appVersion || '').slice(0, 40);
        const now = Date.now();
        const day = new Date(now).toISOString().slice(0, 10);
        await env.DB.prepare(
          'INSERT INTO usage_daily (day, anon_id, app_version, opens, last_at)'
          + ' VALUES (?, ?, ?, 1, ?)'
          + ' ON CONFLICT(day, anon_id) DO UPDATE SET'
          + '   opens = opens + 1, app_version = excluded.app_version, last_at = excluded.last_at'
        ).bind(day, anonId, appVersion, now).run();
        return json({ ok: true });
      }

      return err('not found', 404);
    } catch (e) {
      return err(e.message || String(e), 500);
    }
  },
};
