// ChordWikiライブビューア: オフライン起動用Service Worker
// キャッシュ更新は自動バージョン切替ではなく、アプリ内の「オフライン用データを更新」ボタンから
// 明示的に行う方式。CACHE_NAMEはアセット構成を大きく変えた時のみ手動で変更する。
const CACHE_NAME = 'cwlv-shell-v1';

const ASSET_LIST = [
  './',
  './index.html',
  './manual.html',
  './manifest.json',
  './vendor/pdfjs/pdf.min.js',
  './vendor/pdfjs/pdf.worker.min.js',
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

  const path = url.pathname.endsWith('/') ? url.pathname : url.pathname;
  const isAsset = ASSET_LIST.some((asset) => {
    const assetUrl = new URL(asset, self.location.href);
    return assetUrl.pathname === path;
  });
  if (!isAsset) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
