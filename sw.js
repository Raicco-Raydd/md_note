/* MindDepot Note 鈥?Service Worker
 * 绛栫暐锛氶绻佹洿鏂扮殑鏂囦欢锛坅pp.js/index.html/blocks.js锛夌綉缁滀紭鍏堬紱
 * 绋冲畾搴擄紙marked/highlight/mdutils锛夌紦瀛樹紭鍏堜繚绂荤嚎
 */
const CACHE = "md-note-v8";
const CORE = [
  "./",
  "./index.html",
  "./app.js",
  "./blocks.js",
  "./rag.js",
  "./vendor/transformers.js",
  "./vendor/ort-wasm-simd-threaded.jsep.wasm",
  "./vendor/ort-wasm-simd-threaded.jsep.mjs",
  "./mdutils.js",
  "./marked.min.js",
  "./highlight.min.js",
  "./manifest.webmanifest",
  "./assets/icons/mind-depot-dark.png",
  "./assets/icons/mind-depot-light.png",
  "./assets/icons/mind-depot-dark-192.png",
  "./assets/icons/mind-depot-dark-512.png",
  "./assets/icons/mind-depot-light-192.png",
  "./assets/icons/mind-depot-light-512.png",
];
const DYNAMIC = ["/index.html", "/app.js", "/blocks.js", "/rag.js", "/vendor/transformers.js"];

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
    // 缃戠粶浼樺厛锛氫繚璇佹渶鏂颁唬鐮侊紝澶辫触鍥為€€缂撳瓨锛堢绾匡級
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
    // 缂撳瓨浼樺厛锛氱ǔ瀹氬簱绂荤嚎鍙敤
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
  }
});
