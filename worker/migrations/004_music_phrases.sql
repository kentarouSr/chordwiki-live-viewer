-- フレーズ集(2026-08-19)。
--
-- 背景: 楽譜エディタで作った譜面データ(音符・コード名・拍子・調号)そのものを
-- 保存して、後から開き直して編集・転調したり、曲の譜面に貼ったりできるようにした。
-- 本棚(sync_key)ごとに1つのリストなので、practice_todos / memo_stamps /
-- music_links と同じ「sync_keyを主キーにした1行にJSONをまるごと保存する」持ち方。
--
-- 1件ごとに一覧表示用のプレビューPNG(data URL)を持つぶん、他のテーブルより
-- 1行が大きくなりうる。数十件程度の想定なのでこの持ち方のままで問題ないが、
-- 件数が増えて重くなるようなら曲と同じくR2に逃がすことを検討する。
--
-- 実行方法は worker/README-migration.md を参照。
-- 新規テーブルを足すだけなので既存データには影響しない。

CREATE TABLE IF NOT EXISTS music_phrases (
  sync_key TEXT PRIMARY KEY,
  items_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL DEFAULT 0
);
