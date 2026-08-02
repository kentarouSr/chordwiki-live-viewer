CREATE TABLE IF NOT EXISTS songs (
  uuid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  bpm INTEGER,
  speed INTEGER NOT NULL DEFAULT 40,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  memos TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS setlists (
  uuid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  song_uuids TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
