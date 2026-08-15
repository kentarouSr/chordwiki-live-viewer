-- 許可リストをWorkerのシークレット(SYNC_KEYS)からD1テーブルへ移す。
-- シークレットは実行時に書き換えられないため、アプリの「招待」ボタン
-- (POST /api/invite)から新しいキーをその場で発行することができなかった。
-- D1テーブルなら通常のINSERTで足せるので、招待APIが自己完結する。
--
-- 実行後、既存のSYNC_KEYSに入っていたキーをこのテーブルにも登録すること
-- (登録方法は README-migration.md 参照)。env.SYNC_KEYS / env.SYNC_KEY は
-- 後方互換のフォールバックとして残っているので、登録を忘れてもすぐには
-- ロックアウトされない。

CREATE TABLE IF NOT EXISTS allowed_keys (
  key TEXT PRIMARY KEY,
  label TEXT,
  created_at INTEGER NOT NULL
);
