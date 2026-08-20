-- 不具合・要望の受け止め先と、使われ方の記録(2026-08-21)
--
-- Twitterで公開する予定なので、同期キーを持たない人(=クラウド同期を使わず
-- 端末内だけで使う人)からも報告を受け取れるようにする。キーを必須にすると
-- 新規の人がまったく報告できないため。
--
-- そのぶん誰でも投げられるので、荒らし対策として
--   ・本文の長さをWorker側で制限
--   ・同じIPからの連投を制限(ip_hash で数える。生のIPは保存しない)
-- を入れている。
CREATE TABLE IF NOT EXISTS feedback (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,          -- 'bug' | 'request'
  body        TEXT NOT NULL,
  app_version TEXT,
  user_agent  TEXT,
  key_tail    TEXT,                   -- 同期キーの末尾4文字だけ(誰からか大まかに分かる程度)
  ip_hash     TEXT,                   -- 連投制限用。生のIPは保存しない
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_ip_time ON feedback (ip_hash, created_at);

-- 使われ方の記録。個人を特定しない。
-- anon_id は端末ごとにアプリが作るランダムなID(誰かは分からない)。
-- 「日ごとに何人が開いたか」を数えるためだけに使う。
-- 同じ日・同じ端末は1行にまとまる(PRIMARY KEY)ので、行数は増え続けない。
CREATE TABLE IF NOT EXISTS usage_daily (
  day         TEXT NOT NULL,          -- 'YYYY-MM-DD'(UTC)
  anon_id     TEXT NOT NULL,
  app_version TEXT,
  opens       INTEGER NOT NULL DEFAULT 1,
  last_at     INTEGER NOT NULL,
  PRIMARY KEY (day, anon_id)
);
CREATE INDEX IF NOT EXISTS idx_usage_day ON usage_daily (day);
