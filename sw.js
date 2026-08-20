// ChordWikiライブビューア: オフライン起動用Service Worker
// 「裏で勝手に更新されるのが不安」という初期の要望で長らく手動更新オンリー
// (キャッシュ優先)だったが、「F5でリロードしても古いキャッシュのまま」で
// 混乱を招いたため、2026-08-06に完全自動更新へ方針転換した。
// オンライン時は常にネットワークを優先し(タイムアウト付き)、取得できたら
// キャッシュも更新する。オフライン時やネットワークが遅い時だけキャッシュに
// フォールバックすることで、機内モードでの起動性は維持する。
const CACHE_NAME = 'cwlv-shell-v10'; // v5: 「データを更新」をSW側に一本化(ページ側との名前の食い違いを解消)
const NETWORK_TIMEOUT_MS = 3000;

const ASSET_LIST = [
  './',
  './index.html',
  './manual.html',
  './start.html',
  './manifest.json',
  './vendor/pdfjs/pdf.min.js',
  './vendor/pdfjs/pdf.worker.min.js',
  './vendor/vexflow/vexflow.js',
  './vendor/vexflow/fonts/bravura.woff2',
  './vendor/vexflow/fonts/academico.woff2',
  './vendor/vexflow/fonts/academico-bold.woff2',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSET_LIST))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// 「データを更新」ボタンからの依頼でキャッシュを作り直す(2026-08-19〜)。
//
// 以前はページ側(index.html)がキャッシュ名とファイル一覧を自前で持って直接
// 書き換えていたが、sw.jsをv3→v4に上げた時にページ側がv3のままだったため、
// **Service Workerが読まないキャッシュに書き込む**状態になり、ボタンを押しても
// 何も起きなかった。二重管理をやめ、キャッシュ名とファイル一覧を知っている
// Service Worker側にまとめる。
self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'REFRESH_CACHE') return;
  const reply = (payload) => {
    if (event.ports && event.ports[0]) event.ports[0].postMessage(payload);
  };
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE_NAME);
      // cache:'reload'でブラウザのHTTPキャッシュも迂回し、必ずサーバーから取り直す
      for (const url of ASSET_LIST) {
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (!res || !res.ok) throw new Error(url + ' の取得に失敗しました');
        await cache.put(url, res);
      }
      // 古い世代のキャッシュ(cwlv-shell-v3など)が残っていると容量を食うだけなので消す
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith('cwlv-shell-') && n !== CACHE_NAME)
        .map((n) => caches.delete(n)));
      reply({ ok: true, cacheName: CACHE_NAME, count: ASSET_LIST.length });
    } catch (err) {
      reply({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;
  const isAsset = ASSET_LIST.some((asset) => {
    const assetUrl = new URL(asset, self.location.href);
    return assetUrl.pathname === path;
  });
  if (!isAsset) return;

  event.respondWith(networkFirstWithTimeout(event.request));
});

async function networkFirstWithTimeout(request) {
  const cache = await caches.open(CACHE_NAME);

  const networkPromise = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS));
  const fast = await Promise.race([networkPromise, timeoutPromise]);
  if (fast && fast.ok) return fast;

  // ネットワークが遅い/失敗した場合はキャッシュにフォールバック(機内モード対応)。
  // ネットワーク取得自体は裏で継続していて、成功すれば上のthenで次回用にキャッシュへ反映される。
  const cached = await cache.match(request);
  if (cached) return cached;

  // キャッシュが無い初回オフライン等では、遅くてもネットワークの結果を待つしかない
  const late = await networkPromise;
  if (late) return late;
  throw new Error('offline and no cache available');
}
