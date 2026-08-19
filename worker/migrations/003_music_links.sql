-- 音楽関連サイトのリンク集(2026-08-19)。
--
-- 背景: ChordWiki・U-FRET・YouTubeなど、練習中に開きたい音楽系サイトが多いため、
-- 名前付きのリンクをアプリ内に貯められるようにした。本棚(sync_key)ごとに1つの
-- リストなので、practice_todos / memo_stamps とまったく同じ「sync_keyを主キーに
-- した1行にJSONをまるごと保存する」持ち方にしている。
--
-- 実行方法は worker/README-migration.md を参照。
-- 新規テーブルを足すだけなので既存データには影響しない。

CREATE TABLE IF NOT EXISTS music_links (
  sync_key TEXT PRIMARY KEY,
  items_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL DEFAULT 0
);
