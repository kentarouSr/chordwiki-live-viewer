const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Key',
};

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
    // だと実行時に書き換えられず、アプリからの「招待」ボタンで新しいキーを発行
    // できないため)。/api/invite で「今すでに有効なキーを持っている人なら誰でも、
    // 新しいキーをその場で発行できる」仕組みにしている。
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

    // base64url、24バイト(=32文字)のランダムキーを生成する。招待で発行する
    // キーも、最初の1本(ユーザー自身が決めたもの)と同程度の強度にするため。
    const generateInviteKey = () => {
      const bytes = crypto.getRandomValues(new Uint8Array(24));
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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

        const r2Key = `songs/${uuid}`;
        await env.BUCKET.put(r2Key, file.stream(), {
          httpMetadata: { contentType: mimeType },
        });

        await env.DB.prepare(
          `INSERT INTO songs (uuid, sync_key, name, bpm, speed, file_name, mime_type, r2_key, memos, youtube_url, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(uuid) DO UPDATE SET
             name = excluded.name, bpm = excluded.bpm, speed = excluded.speed,
             file_name = excluded.file_name, mime_type = excluded.mime_type,
             r2_key = excluded.r2_key, memos = excluded.memos, youtube_url = excluded.youtube_url,
             updated_at = excluded.updated_at`
        ).bind(uuid, key, name, bpm, speed || 20, fileName, mimeType, r2Key, memosRaw || '[]', youtubeUrlRaw || null, createdAt || Date.now(), updatedAt).run();
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

      // 招待: 今すでに有効なキーを持っている人なら誰でも、新しい(別の本棚の)キーを
      // その場で発行できる。発行されたキーはこのリクエストのキーとは完全に独立した
      // 新しい本棚になる(データを共有しない、一からの空の本棚)。
      if (path === '/api/invite' && request.method === 'POST') {
        const key = await requireKey();
        if (!key) return err('invalid key', 401);
        const newKey = generateInviteKey();
        await env.DB.prepare(
          'INSERT INTO allowed_keys (key, label, created_at) VALUES (?, ?, ?)'
        ).bind(newKey, `invited (via key ...${key.slice(-4)})`, Date.now()).run();
        return json({ key: newKey });
      }

      return err('not found', 404);
    } catch (e) {
      return err(e.message || String(e), 500);
    }
  },
};
