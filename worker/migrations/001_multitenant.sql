-- 同期キーごとにデータを分ける(マルチテナント化)ためのマイグレーション。
--
-- 背景: それまでは env.SYNC_KEY 1本を「合言葉」としてだけ使っており、テーブルには
-- ユーザーを区別する列が無かった。そのためキーを知っている人は全員まったく同じ
-- 1つの本棚を共有する形になっていた。友達それぞれが自分の曲を持てるようにするため、
-- 全テーブルに sync_key 列を足し、以後すべてのクエリをこの列で絞る。
--
-- 【重要】既存データは全部 :EXISTING_KEY の本棚に入る。実行前に必ず
--   wrangler d1 execute chordwiki-live-viewer --remote --command "SELECT COUNT(*) FROM songs"
-- 等で件数を控えておき、実行後に同じ件数が残っていることを確認すること。
-- 実行方法は worker/README-migration.md を参照。

-- ---- songs ----
-- uuidはcrypto.randomUUID()生成でグローバルに一意なので、主キーはuuidのままでよい
-- (SQLiteは主キーの変更ができないため、列追加だけで済ませる)。
ALTER TABLE songs ADD COLUMN sync_key TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_songs_key ON songs(sync_key, updated_at DESC);

-- ---- setlists ----
ALTER TABLE setlists ADD COLUMN sync_key TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_setlists_key ON setlists(sync_key, updated_at DESC);

-- ---- 削除tombstone ----
-- 主キーがuuid単独のままだと、別々の本棚で同じuuidが削除された時に衝突しうる。
-- 実際にはuuidが一意なので起こらないが、念のため参照時もsync_keyで絞る。
ALTER TABLE deleted_songs ADD COLUMN sync_key TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_deleted_songs_key ON deleted_songs(sync_key);
ALTER TABLE deleted_setlists ADD COLUMN sync_key TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_deleted_setlists_key ON deleted_setlists(sync_key);

-- ---- 練習ToDo・メモのスタンプ ----
-- 元は「アプリ全体で1つ」なので id=1 固定の単一行だった(CHECK制約付き)。
-- SQLiteでは主キー・CHECK制約を後から変更できないので、作り直して中身を移す。
--
-- 下の2つのCREATEは、移行元テーブルがまだ無い環境(この2機能を使う前に作られたDB)で
-- 後続のINSERT ... SELECT が "no such table" で落ちないようにするための保険。
-- 既にあれば IF NOT EXISTS で何もしない。
CREATE TABLE IF NOT EXISTS practice_todos (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  items_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS memo_stamps (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  items_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS practice_todos_new (
  sync_key TEXT PRIMARY KEY,
  items_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT OR REPLACE INTO practice_todos_new (sync_key, items_json, updated_at)
  SELECT '', items_json, updated_at FROM practice_todos WHERE id = 1;

CREATE TABLE IF NOT EXISTS memo_stamps_new (
  sync_key TEXT PRIMARY KEY,
  items_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT OR REPLACE INTO memo_stamps_new (sync_key, items_json, updated_at)
  SELECT '', items_json, updated_at FROM memo_stamps WHERE id = 1;

DROP TABLE practice_todos;
DROP TABLE memo_stamps;
ALTER TABLE practice_todos_new RENAME TO practice_todos;
ALTER TABLE memo_stamps_new RENAME TO memo_stamps;
