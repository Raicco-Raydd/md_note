/* MindDepot Note — Service Worker
 * 策略：频繁更新的文件（app.js/index.html/blocks.js）网络优先；
 * 稳定库（marked/highlight/mdutils）缓存优先保离线
 */
const CACHE = "md-note-v5";
const CORE = [
  "./",
  "./index.html",
  "./app.js",
  "./blocks.js",
  "./mdutils.js",
  "./marked.min.js",
  "./highlight.min.js",
  "./manifest.webmanifest",
];
const DYNAMIC = ["/index.html", "/app.js", "/blocks.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  const isDynamic = e.request.mode === "navigate" || DYNAMIC.some((p) => url.pathname.endsWith(p));

  if (isDynamic) {
    // 网络优先：保证最新代码，失败回退缓存（离线）
    e.respondWith(
      fetch(e.request)
        .then((r) => {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return r;
        })
        .catch(() => caches.match(e.request))
    );
  } else {
    // 缓存优先：稳定库离线可用
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
  }
});
