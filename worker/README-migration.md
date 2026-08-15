# 同期キーごとにデータを分ける移行手順(2026-08-16)

それまでは同期キー(`SYNC_KEY`)を単なる「合言葉」としてだけ使っていて、テーブルには
ユーザーを区別する列が無かった。そのため**キーを知っている人は全員まったく同じ1つの
本棚を共有する**形になっていた。友達それぞれが自分の曲を持てるように、全テーブルに
`sync_key` 列を足し、以後すべてのクエリをこの列で絞るようにした。

移行はローカルD1で「移行前の本番と同じスキーマ+サンプルデータ」を作って通しで検証済み
(曲2件・セトリ1件・ToDo・スタンプがすべて件数もJSONの中身も保たれること、
別キーからは互いのデータが見えないこと、他人の曲を上書きできないこと=403、
他人のファイルを読めないこと=404を確認)。

## 前提

- 既存データはすべて**あなたの今のキー**の本棚に入る(友達は空の本棚から始まる)。
- 作業中は同期が一時的に失敗する。念のため**先に「書き出す」でZIPバックアップを取っておくこと**。

## 手順

### 1. 移行前の件数を控える

移行後に同じ件数が残っているかを照合するため、先に控えておく。

```sh
cd worker
npx wrangler d1 execute chordwiki-live-viewer --remote --command \
  "SELECT (SELECT COUNT(*) FROM songs) songs, (SELECT COUNT(*) FROM setlists) setlists"
```

### 2. スキーマを移行する

```sh
npx wrangler d1 execute chordwiki-live-viewer --remote --file=./migrations/001_multitenant.sql
```

`18 commands executed successfully.` のように出れば成功。

### 3. 既存データを自分の本棚に割り当てる

この時点では既存の行は `sync_key = ''`(持ち主なし)なので、あなたのキーを入れる。
`<あなたの今の同期キー>` は、アプリの「同期キーを設定」ボタンで確認できる値に置き換える。

```sh
KEY='<あなたの今の同期キー>'
for t in songs setlists deleted_songs deleted_setlists practice_todos memo_stamps; do
  npx wrangler d1 execute chordwiki-live-viewer --remote \
    --command "UPDATE $t SET sync_key='$KEY' WHERE sync_key=''"
done
```

### 4. 許可するキーの一覧を登録する

**誰でも好きなキーで使えるようにすると、Worker のURLさえ分かれば第三者にストレージを
使われてしまう**(無料枠を食い潰される)ため、許可リストに載っているキーだけを
受け付ける方式にしてある。あなたのキーと友達のキーをカンマ区切りで登録する。

```sh
npx wrangler secret put SYNC_KEYS
# 例: あなたのキー,友達1のキー,友達2のキー
```

キーは推測されないよう、友達ぶんも**十分長いランダム文字列**にすること。例:

```sh
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

### 5. デプロイ

```sh
npx wrangler deploy
```

### 6. 動作確認

```sh
# 自分のキー: 今までの曲が出る
curl -s -H "X-Sync-Key: <あなたのキー>" https://<worker>/api/songs | head -c 200
# 友達のキー: 空([])で始まる
curl -s -H "X-Sync-Key: <友達のキー>" https://<worker>/api/songs
# 許可外のキー: 401
curl -s -o /dev/null -w "%{http_code}\n" -H "X-Sync-Key: dummy" https://<worker>/api/songs
```

最後にアプリ側でも「今すぐ同期」を押して、曲が消えていないことを確認する。

## 友達を増やす時(2026-08-16以降: アプリの「👥 友達を招待」ボタンで完結)

上記の移行後は、許可リストがWorkerのシークレット(`SYNC_KEYS`)からD1の
`allowed_keys` テーブルに移っている。**CLIを使わなくても、アプリの「☁ クラウド同期」
グループにある「👥 友達を招待」ボタンを押すだけで完結する**:

1. 今すでに有効なキーを持っている人(=今アプリを使えている人なら誰でも)が
   「👥 友達を招待」を押す
2. `POST /api/invite` がサーバー側で新しいランダムキーを発行し、`allowed_keys` に登録
3. キー入りのセットアップURLが自動でクリップボードにコピーされる
4. そのURLを友達に送る。友達が開くと、その人専用の空の本棚が使える

**新しく発行したキーで招待された人も、さらに別の人を招待できる**(信頼の連鎖)。
小規模な友達内利用を前提にした設計で、招待の可否に上限や承認フローは無い。

CLIから直接キーを足したい場合(招待ボタンを使わない場合)は、
`allowed_keys` テーブルに直接INSERTすればよい:

```sh
npx wrangler d1 execute chordwiki-live-viewer --remote --command \
  "INSERT INTO allowed_keys (key, label, created_at) VALUES ('<新しいキー>', '手動登録', $(date +%s000))"
```

キーを無効化(締め出し)たい場合も同様にDELETEするだけ:

```sh
npx wrangler d1 execute chordwiki-live-viewer --remote --command \
  "DELETE FROM allowed_keys WHERE key = '<無効化したいキー>'"
```

(旧方式の `SYNC_KEYS` シークレットは後方互換のフォールバックとして残っているが、
実行時に書き換えられないため、通常の運用ではD1側だけを使えばよい。)

## 注意点

- **同じキーを共有した人どうしは、今まで通り1つの本棚を共有する**。バンドで曲・セトリを
  共有したい相手には同じキーを、各自で持ちたい相手には別のキーを渡す。
- 同じ本棚を共有している場合、**誰か1人が曲を削除すると全員の端末からも消える**
  (tombstone方式のため他端末で復活しない)。定期的なZIPバックアップを勧める。
