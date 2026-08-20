-- あなた用のURLの自動発行と、その置き場所の上限(2026-08-20)
--
-- これまで allowed_keys は持ち主が手で足す運用だった。そのため一般公開しても
-- 新規の人はクラウド保存を一切使えなかった。
--
-- 今回、アプリが初回訪問時にその場でURLを作り(まだ登録しない)、
-- **中身を変える操作を実際にした時だけ**このテーブルに登録する方式にする。
-- 見に来ただけで帰る人が行を作らないので、公開しても行が無駄に増えない。
--
-- そのぶん誰でも登録できる形になるので、2つの歯止めを入れる:
--   ・発行元(ip_hash)を記録して、同じ回線からの1日あたりの発行数を制限する
--   ・self_issued = 1 の置き場所には、曲数と合計容量の上限をかける
-- 持ち主が手で足したキー(self_issued = 0)は今まで通り無制限。

ALTER TABLE allowed_keys ADD COLUMN self_issued INTEGER NOT NULL DEFAULT 0;
-- 生のIPは保存しない。発行数を数えるためだけのハッシュ。
ALTER TABLE allowed_keys ADD COLUMN ip_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_allowed_keys_ip_time ON allowed_keys (ip_hash, created_at);

-- 合計容量を数えるために、曲ごとのファイルサイズを持つ。
-- 0 は「移行前に入っていた曲」を意味する(サイズが分からない)。
-- 上限の判定では 0 の曲はサイズ不明として数えないが、曲数には数える。
ALTER TABLE songs ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_songs_sync_key ON songs (sync_key);
