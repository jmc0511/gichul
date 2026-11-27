// 기추리 서비스 워커: 인터넷이 없어도 **이미 받아 둔 시험지는 풀 수 있게** 한다.
// (새로 만드는 건 서버가 필요해서 못 한다. 앱 안에서도 이 워커가 돈다 — install.js 참고)
//
// 성격이 다른 세 가지를 다르게 다룬다.
//  1) 사이트 파일 — 늘 새것을 먼저 받는다(배포가 바로 반영되게). 실패하면 저장해 둔 것.
//  2) 바깥 라이브러리·글꼴 — 주소에 판 번호가 박혀 있어 내용이 바뀌지 않는다. 저장해 둔 것 먼저.
//     이게 없으면 인터넷이 끊겼을 때 수식이 $x^2$ 처럼 날것으로 보인다.
//  3) 시험지 그림 — 주소가 UUID 라 역시 바뀌지 않는다. 저장해 둔 것 먼저, 개수만 제한.
// Supabase REST·실시간은 **건드리지 않는다**. 오래된 답을 돌려주면 안 되는 것들이다.
const SHELL_CACHE = "gichuri-shell-v2";
const LIB_CACHE = "gichuri-lib-v1";
const FIG_CACHE = "gichuri-fig-v1";
const KEEP = [SHELL_CACHE, LIB_CACHE, FIG_CACHE];

const SHELL = ["/", "/style.css", "/app.js", "/tour.js", "/install.js", "/config.js", "/manifest.webmanifest", "/icon-192.png", "/favicon-32.png"];

// index.html 의 <link>·<script> 와 같은 주소여야 한다. 판을 올리면 여기도 같이 고칠 것.
// 첫 방문 때 미리 받아 둔다 — 그때는 이 워커가 아직 페이지를 맡기 전이라 그냥 두면 안 담긴다.
const LIB_URLS = [
  "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.11/katex.min.css",
  "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.11/katex.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.11/contrib/auto-render.min.js",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js",
  "https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css"
];
const LIB = /^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;
const FIG = /^https:\/\/[a-z0-9]+\.supabase\.co\/storage\/v1\/object\/public\//;
const FIG_MAX = 400; // 시험지 한 장에 그림 20장 남짓이니 넉넉하다

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    await shell.addAll(SHELL);
    const lib = await caches.open(LIB_CACHE);
    // 하나가 안 받아져도 설치는 되게 (글꼴 하나 때문에 오프라인 전체를 잃지 않도록)
    await Promise.all(LIB_URLS.map((u) => lib.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/** 저장해 둔 것 먼저. 없으면 받아서 저장한다 (내용이 바뀌지 않는 주소에만 쓴다) */
async function cacheFirst(req, name, max) {
  const c = await caches.open(name);
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === "opaque")) {
    c.put(req, res.clone()).then(() => max && trim(name, max)).catch(() => {});
  }
  return res;
}

/** 오래된 것부터 버린다 (Cache 의 열쇠는 넣은 차례대로 나온다) */
async function trim(name, max) {
  const c = await caches.open(name);
  const keys = await c.keys();
  if (keys.length <= max) return;
  await Promise.all(keys.slice(0, keys.length - max).map((k) => c.delete(k)));
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin !== location.origin) {
    if (LIB.test(req.url)) e.respondWith(cacheFirst(req, LIB_CACHE));
    else if (FIG.test(req.url)) e.respondWith(cacheFirst(req, FIG_CACHE, FIG_MAX));
    return; // 그 밖의 바깥 요청(Supabase REST·실시간)은 그대로 둔다
  }

  // 첫 화면은 ?exam= 같은 주소 뒤 값과 상관없이 한 칸에 저장
  const home = req.mode === "navigate" && (url.pathname === "/" || url.pathname === "/index.html");
  const key = home ? "/" : url.pathname;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === "basic") {
        const copy = res.clone();
        caches.open(SHELL_CACHE).then((c) => c.put(key, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const hit = await caches.match(key) || (req.mode === "navigate" ? await caches.match("/") : null);
      if (hit) return hit;
      throw err;
    }
  })());
});
