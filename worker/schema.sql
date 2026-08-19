-- 同期キー(sync_key)ごとに完全に別のデータを持つ。友達それぞれに別のキーを渡せば
-- お互いの曲・セットリストは見えない(2026-08-16にマルチテナント化)。
-- uuidはcrypto.randomUUID()生成でグローバルに一意なため、主キーはuuid単独のままで
-- 衝突しない。参照・更新・削除はすべてsync_keyでも絞ること。

CREATE TABLE IF NOT EXISTS songs (
  uuid TEXT PRIMARY KEY,
  sync_key TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  bpm INTEGER,
  speed INTEGER NOT NULL DEFAULT 40,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  memos TEXT NOT NULL DEFAULT '[]',
  youtube_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_songs_key ON songs(sync_key, updated_at DESC);

CREATE TABLE IF NOT EXISTS setlists (
  uuid TEXT PRIMARY KEY,
  sync_key TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  items_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_setlists_key ON setlists(sync_key, updated_at DESC);

-- 削除の同期用tombstone。他端末が「サーバーに無い=まだアップロードしていない」と
-- 誤解して復活アップロードしてしまわないよう、削除された事実と時刻を記録しておく。
CREATE TABLE IF NOT EXISTS deleted_songs (
  uuid TEXT PRIMARY KEY,
  sync_key TEXT NOT NULL DEFAULT '',
  deleted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deleted_songs_key ON deleted_songs(sync_key);

CREATE TABLE IF NOT EXISTS deleted_setlists (
  uuid TEXT PRIMARY KEY,
  sync_key TEXT NOT NULL DEFAULT '',
  deleted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deleted_setlists_key ON deleted_setlists(sync_key);

-- 練習ToDoリスト。本棚(sync_key)ごとに1つなので、個別レコードではなく
-- sync_keyを主キーにした1行にJSONをまるごと保存する、setlistsのitems_jsonと同じ考え方。
CREATE TABLE IF NOT EXISTS practice_todos (
  sync_key TEXT PRIMARY KEY,
  items_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- メモのスタンプ(定型文言)一覧。practice_todosと同じ持ち方。
CREATE TABLE IF NOT EXISTS memo_stamps (
  sync_key TEXT PRIMARY KEY,
  items_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- 音楽関連サイトのリンク集(2026-08-19)。practice_todosと同じ持ち方。
CREATE TABLE IF NOT EXISTS music_links (
  sync_key TEXT PRIMARY KEY,
  items_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- フレーズ集(2026-08-19)。楽譜エディタで作った譜面データそのもの。
-- practice_todosと同じ持ち方(1件ごとにプレビューPNGを持つぶん行は大きい)。
CREATE TABLE IF NOT EXISTS music_phrases (
  sync_key TEXT PRIMARY KEY,
  items_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- 使用を許可する同期キーの一覧。POST /api/invite で、既に有効なキーを
-- 持っている人なら誰でも新しいキーをここに追加できる(2026-08-16)。
CREATE TABLE IF NOT EXISTS allowed_keys (
  key TEXT PRIMARY KEY,
  label TEXT,
  created_at INTEGER NOT NULL
);
