// 홈 화면 앱(PWA): 서비스 워커 등록 + '앱으로 설치' 안내
// 안드로이드·PC 크롬은 설치 창을 바로 띄우고, 아이폰 사파리는 '공유 → 홈 화면에 추가' 방법을 보여 줌
(function () {
  const inApp = /GichuriApp/.test(navigator.userAgent); // iOS 앱(Flutter) 안에서 열린 경우
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if ("serviceWorker" in navigator && !inApp) {
    window.addEventListener("load", () => { navigator.serviceWorker.register("/sw.js").catch(() => {}); });
  }
  if (inApp || standalone) return;

  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const iosSafari = ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|KAKAOTALK|NAVER|Instagram|FBAN/.test(ua);
  const bar = document.getElementById("installBar");
  const btn = document.getElementById("installBtn");
  const txt = document.getElementById("installText");
  const link = document.getElementById("installLink");
  if (!bar) return;
  let prompt = null;

  const dismissed = () => { try { return Number(localStorage.getItem("gichul.installHide") || 0) > Date.now(); } catch (e) { return false; } };
  const hide = (days) => {
    bar.hidden = true;
    try { localStorage.setItem("gichul.installHide", String(Date.now() + days * 864e5)); } catch (e) {}
  };
  const iosHelp = () => {
    txt.textContent = "아래 공유 버튼(□↑)을 누르고 '홈 화면에 추가'를 고르면 앱처럼 쓸 수 있어요.";
    btn.hidden = true;
    bar.hidden = false;
  };
  async function install() {
    if (prompt) {
      prompt.prompt();
      const { outcome } = await prompt.userChoice.catch(() => ({}));
      prompt = null;
      if (outcome === "accepted") { bar.hidden = true; link.hidden = true; }
    } else if (ios) iosHelp();
    else {
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
  // 아이폰은 설치 창이 없어서, 사파리일 때만 방법을 알려 줌 (카톡·인스타 안 브라우저에선 홈 화면 추가가 안 됨)
  if (iosSafari) {
    link.hidden = false;
    if (!dismissed()) { txt.textContent = "홈 화면에 추가하면 앱처럼 바로 열 수 있어요."; bar.hidden = false; }
  }
  btn.addEventListener("click", install);
  link.addEventListener("click", (e) => { e.preventDefault(); install(); });
  document.getElementById("installClose").addEventListener("click", () => hide(14));
})();
