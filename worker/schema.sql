CREATE TABLE IF NOT EXISTS songs (
  uuid TEXT PRIMARY KEY,
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

CREATE TABLE IF NOT EXISTS setlists (
  uuid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  items_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 削除の同期用tombstone。他端末が「サーバーに無い=まだアップロードしていない」と
-- 誤解して復活アップロードしてしまわないよう、削除された事実と時刻を記録しておく。
CREATE TABLE IF NOT EXISTS deleted_songs (
  uuid TEXT PRIMARY KEY,
  deleted_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS deleted_setlists (
  uuid TEXT PRIMARY KEY,
  deleted_at INTEGER NOT NULL
);

-- 練習ToDoリスト。アプリ全体で1つなので、個別レコードではなく単一行
-- (id=1固定)にJSONをまるごと保存する、setlistsのitems_jsonと同じ考え方。
CREATE TABLE IF NOT EXISTS practice_todos (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  items_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL DEFAULT 0
);
