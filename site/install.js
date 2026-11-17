// 맨 위 띠 두 개(공지 · 앱 안내)와 서비스 워커 등록.
// 앱 안내: 아이폰·아이패드는 App Store, 안드로이드는 Play 스토어
// (2026-11-16 안드로이드 출시 전에는 안드로이드에 홈 화면 앱(PWA) 설치를 권했다. 이제 둘 다 스토어 앱으로 보낸다)
/* ---------- 공지 ----------
   내용을 바꿀 때는 index.html 의 글과 함께 아래 NOTICE_ID 도 바꾼다.
   그래야 전에 닫은 사람에게도 새 공지가 다시 보인다. */
(function () {
  const NOTICE_ID = "team08";
  const KEY = "gichul.noticeHide";
  const bar = document.getElementById("noticeBar");
  const close = document.getElementById("noticeClose");
  if (!bar || !close) return;

  let hidden = false;
  try { hidden = localStorage.getItem(KEY) === NOTICE_ID; } catch (e) {}
  if (!hidden) bar.hidden = false;

  close.addEventListener("click", () => {
    bar.hidden = true;
    try { localStorage.setItem(KEY, NOTICE_ID); } catch (e) {}
  });
})();

(function () {
  const inApp = /GichuriApp/.test(navigator.userAgent); // 앱(Flutter 웹뷰) 안에서 열린 경우
  if ("serviceWorker" in navigator && !inApp) {
    window.addEventListener("load", () => { navigator.serviceWorker.register("/sw.js").catch(() => {}); });
  }

  const storeLink = document.getElementById("appStoreLink");
  const playLink = document.getElementById("playStoreLink");
  if (inApp) {
    if (storeLink) storeLink.hidden = true;
    if (playLink) playLink.hidden = true;
    return;
  }

  const APP_STORE = "https://apps.apple.com/kr/app/id6826055075";
  const PLAY_STORE = "https://play.google.com/store/apps/details?id=site.gichul.app";
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const android = /Android/.test(ua);

  // 자기 기기에 없는 스토어 링크는 푸터에서 숨긴다 (PC 에서는 둘 다 보여 준다)
  if (android && storeLink) storeLink.hidden = true;
  if (ios && playLink) playLink.hidden = true;

  const bar = document.getElementById("installBar");
  const btn = document.getElementById("installBtn");
  const txt = document.getElementById("installText");
  if (!bar) return;

  // 닫으면 14일 동안 안 보임.
  // 안드로이드는 예전에 'installHide'(PWA 설치 안내)를 썼다. 앱 출시 안내는 새 열쇠라 한 번은 다시 뜬다.
  const KEY = android ? "gichul.playHide" : "gichul.appHide";
  const dismissed = () => { try { return Number(localStorage.getItem(KEY) || 0) > Date.now(); } catch (e) { return false; } };
  document.getElementById("installClose").addEventListener("click", () => {
    bar.hidden = true;
    try { localStorage.setItem(KEY, String(Date.now() + 14 * 864e5)); } catch (e) {}
  });

  // 홈 화면에 추가해 쓰던 사람에게도 권한다 — 앱은 시험지 완성 알림이 온다
  if (android) {
    txt.innerHTML = "<b>기추리 앱이 Play 스토어에 나왔어요!</b> 시험지가 완성되면 알림으로 바로 알려 드려요.";
    btn.textContent = "앱 받기";
    btn.addEventListener("click", () => { location.href = PLAY_STORE; });
  } else if (ios) {
    txt.innerHTML = "<b>기추리 앱이 App Store에 나왔어요!</b> 시험지가 완성되면 알림으로 바로 알려 드려요.";
    btn.textContent = "앱 받기";
    btn.addEventListener("click", () => { location.href = APP_STORE; });
  } else {
    txt.innerHTML = "<b>아이폰·안드로이드 앱이 나왔어요!</b> 스토어에서 ‘기추리’를 검색하세요. 시험지 완성 알림까지 받아 볼 수 있어요.";
    btn.textContent = "App Store";
    btn.addEventListener("click", () => { window.open(APP_STORE, "_blank", "noopener"); });
  }

  if (!dismissed()) bar.hidden = false;
})();
