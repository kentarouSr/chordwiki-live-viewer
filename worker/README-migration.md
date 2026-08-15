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

## 友達を増やす時

キーを生成して渡し、`SYNC_KEYS` に足して登録し直すだけ(コード変更・再デプロイ不要)。

```sh
npx wrangler secret put SYNC_KEYS   # 既存の一覧に新しいキーを足して貼り直す
```

友達側は、アプリを開いて「同期キーを設定」に渡されたキーを入れるか、
「他の端末用リンクをコピー」で作ったキー入りURLを開くだけ。

## 注意点

- **同じキーを共有した人どうしは、今まで通り1つの本棚を共有する**。バンドで曲・セトリを
  共有したい相手には同じキーを、各自で持ちたい相手には別のキーを渡す。
- 同じ本棚を共有している場合、**誰か1人が曲を削除すると全員の端末からも消える**
  (tombstone方式のため他端末で復活しない)。定期的なZIPバックアップを勧める。
