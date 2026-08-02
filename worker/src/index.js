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

    const requireKey = () => {
      const key = getKey();
      if (!key || key !== env.SYNC_KEY) return null;
      return key;
    };

    const rowToSong = (row) => ({
      uuid: row.uuid,
      name: row.name,
      bpm: row.bpm,
      speed: row.speed,
      fileName: row.file_name,
      mimeType: row.mime_type,
      memos: row.memos ? JSON.parse(row.memos) : [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });

    try {
      // 曲一覧(メタデータのみ)
      if (path === '/api/songs' && request.method === 'GET') {
        if (!requireKey()) return err('invalid key', 401);
        const { results } = await env.DB.prepare('SELECT * FROM songs ORDER BY updated_at DESC').all();
        return json(results.map(rowToSong));
      }

      const songIdMatch = path.match(/^\/api\/songs\/([0-9a-f-]{36})$/);

      // 曲を追加/更新(メタデータ+ファイル本体をmultipart/form-dataで一度に送る)
      if (songIdMatch && request.method === 'PUT') {
        if (!requireKey()) return err('invalid key', 401);
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
        const createdAt = parseInt(form.get('createdAt'), 10);
        const updatedAt = parseInt(form.get('updatedAt'), 10);

        if (!file || !name || !fileName || !mimeType || !Number.isFinite(updatedAt)) {
          return err('missing fields');
        }

        const r2Key = `songs/${uuid}`;
        await env.BUCKET.put(r2Key, file.stream(), {
          httpMetadata: { contentType: mimeType },
        });

        await env.DB.prepare(
          `INSERT INTO songs (uuid, name, bpm, speed, file_name, mime_type, r2_key, memos, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(uuid) DO UPDATE SET
             name = excluded.name, bpm = excluded.bpm, speed = excluded.speed,
             file_name = excluded.file_name, mime_type = excluded.mime_type,
             r2_key = excluded.r2_key, memos = excluded.memos, updated_at = excluded.updated_at`
        ).bind(uuid, name, bpm, speed || 40, fileName, mimeType, r2Key, memosRaw || '[]', createdAt || Date.now(), updatedAt).run();

        return json({ ok: true });
      }

      // 曲のファイル本体取得
      const fileMatch = path.match(/^\/api\/songs\/([0-9a-f-]{36})\/file$/);
      if (fileMatch && request.method === 'GET') {
        if (!requireKey()) return err('invalid key', 401);
        const uuid = fileMatch[1];
        const row = await env.DB.prepare('SELECT r2_key, mime_type FROM songs WHERE uuid = ?').bind(uuid).first();
        if (!row) return err('not found', 404);
        const object = await env.BUCKET.get(row.r2_key);
        if (!object) return err('file not found in storage', 404);
        return new Response(object.body, {
          headers: { ...CORS, 'Content-Type': row.mime_type },
        });
      }

      // 曲の削除
      if (songIdMatch && request.method === 'DELETE') {
        if (!requireKey()) return err('invalid key', 401);
        const uuid = songIdMatch[1];
        const row = await env.DB.prepare('SELECT r2_key FROM songs WHERE uuid = ?').bind(uuid).first();
        if (row) await env.BUCKET.delete(row.r2_key);
        await env.DB.prepare('DELETE FROM songs WHERE uuid = ?').bind(uuid).run();
        return json({ ok: true });
      }

      return err('not found', 404);
    } catch (e) {
      return err(e.message || String(e), 500);
    }
  },
};
