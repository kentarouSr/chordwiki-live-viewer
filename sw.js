// ChordWikiライブビューア: オフライン起動用Service Worker
// 「裏で勝手に更新されるのが不安」という初期の要望で長らく手動更新オンリー
// (キャッシュ優先)だったが、「F5でリロードしても古いキャッシュのまま」で
// 混乱を招いたため、2026-08-06に完全自動更新へ方針転換した。
// オンライン時は常にネットワークを優先し(タイムアウト付き)、取得できたら
// キャッシュも更新する。オフライン時やネットワークが遅い時だけキャッシュに
// フォールバックすることで、機内モードでの起動性は維持する。
const CACHE_NAME = 'cwlv-shell-v4'; // v4: 招待された友達向けのstart.htmlを追加
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
