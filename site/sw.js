// 기추리 서비스 워커: 홈 화면 앱으로 설치되게 하고, 인터넷이 끊겨도 화면은 열리게 함
// - 같은 사이트 파일만 다룸 (Supabase·CDN 요청은 건드리지 않음)
// - 항상 새 파일을 먼저 받고(배포가 바로 반영되게), 실패할 때만 저장해 둔 것을 씀
const CACHE = "gichuri-v1";
const SHELL = ["/", "/style.css", "/app.js", "/tour.js", "/install.js", "/config.js", "/manifest.webmanifest", "/icon-192.png", "/favicon-32.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  // 첫 화면은 ?exam= 같은 주소 뒤 값과 상관없이 한 칸에 저장
  const home = req.mode === "navigate" && (url.pathname === "/" || url.pathname === "/index.html");
  const key = home ? "/" : url.pathname;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === "basic") {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(key, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const hit = await caches.match(key) || (req.mode === "navigate" ? await caches.match("/") : null);
      if (hit) return hit;
      throw err;
    }
  })());
});
