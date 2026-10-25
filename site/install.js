// 앱 안내: 아이폰·아이패드·PC는 App Store 앱을, 안드로이드는 홈 화면 앱(PWA) 설치를 권함 + 서비스 워커 등록
(function () {
  const inApp = /GichuriApp/.test(navigator.userAgent); // iOS 앱(Flutter) 안에서 열린 경우
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if ("serviceWorker" in navigator && !inApp) {
    window.addEventListener("load", () => { navigator.serviceWorker.register("/sw.js").catch(() => {}); });
  }
  const storeLink = document.getElementById("appStoreLink");
  if (inApp) { if (storeLink) storeLink.hidden = true; return; }

  const APP_STORE = "https://apps.apple.com/kr/app/id6826055075";
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const android = /Android/.test(ua);
  if (android && storeLink) storeLink.hidden = true; // 안드로이드 앱은 아직 없음
  const bar = document.getElementById("installBar");
  const btn = document.getElementById("installBtn");
  const txt = document.getElementById("installText");
  const link = document.getElementById("installLink");
  if (!bar) return;
  let prompt = null;

  // 닫으면 14일 동안 안 보임 (앱 출시 안내는 예전 설치 안내와 따로 기억)
  const KEY = android ? "gichul.installHide" : "gichul.appHide";
  const dismissed = () => { try { return Number(localStorage.getItem(KEY) || 0) > Date.now(); } catch (e) { return false; } };
  const hide = (days) => {
    bar.hidden = true;
    try { localStorage.setItem(KEY, String(Date.now() + days * 864e5)); } catch (e) {}
  };
  document.getElementById("installClose").addEventListener("click", () => hide(14));

  // 아이폰·아이패드·PC: App Store 앱 홍보 (홈 화면에 추가해 쓰던 사람에게도: 앱은 시험지 완성 알림이 옴)
  if (!android) {
    if (ios) {
      txt.innerHTML = "<b>기추리 앱이 App Store에 나왔어요!</b> 시험지가 완성되면 알림으로 바로 알려 드려요.";
      btn.textContent = "앱 받기";
    } else {
      txt.innerHTML = "<b>아이폰·아이패드 앱이 나왔어요!</b> App Store에서 ‘기추리’를 검색하세요. 시험지 완성 알림까지 받아 볼 수 있어요.";
      btn.textContent = "App Store";
    }
    btn.addEventListener("click", () => {
      if (ios) location.href = APP_STORE; else window.open(APP_STORE, "_blank", "noopener");
    });
    if (!dismissed()) bar.hidden = false;
    return;
  }

  // 안드로이드: 아직 Play 스토어 전이라 홈 화면 앱(PWA) 설치
  if (standalone) return;
  async function install() {
    if (prompt) {
      prompt.prompt();
      const { outcome } = await prompt.userChoice.catch(() => ({}));
      prompt = null;
      if (outcome === "accepted") { bar.hidden = true; link.hidden = true; }
    } else {
      txt.textContent = "브라우저 메뉴(⋮)에서 '앱 설치' 또는 '홈 화면에 추가'를 눌러 주세요.";
      btn.hidden = true;
      bar.hidden = false;
    }
  }
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    prompt = e;
    link.hidden = false;
    if (!dismissed()) bar.hidden = false;
  });
  window.addEventListener("appinstalled", () => { bar.hidden = true; link.hidden = true; });
  btn.addEventListener("click", install);
  link.addEventListener("click", (e) => { e.preventDefault(); install(); });
})();
