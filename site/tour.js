/* 첫 방문 안내: 설명할 부분만 밝게 비추고 옆에 설명 카드를 띄운다 */
(function () {
  const KEY = "gichul.tour.done";
  const STEPS = [
    { view: "make", target: "#fileStep", title: "1. 공부자료 올리기",
      body: "강의노트나 강의 슬라이드를 PDF·PPTX로 올리세요. 필기 노트나 교재 사진(JPG·PNG)도 돼요. 여러 개를 한 번에 올려도 되고, 회로도·그래프 같은 그림이나 스캔한 페이지도 읽어요. 올린 자료는 이 기기에 보관돼서 다음에 체크만 하면 다시 쓸 수 있어요." },
    { view: "make", target: "#condStep", title: "2. 출제 조건 고르기",
      body: "문항 수, 문제 유형, 난이도를 고르세요. 난이도는 여러 개 고르면 섞어서 나와요. 과목명, 외국어 영역, 문제 언어, 그림, 추가 요청은 '자세히'를 펼치면 있어요." },
    { view: "make", target: "#go", title: "3. 출제 요청 보내기",
      body: "이 버튼을 눌러야 시험지를 만들기 시작해요. 보내면 문제집으로 넘어가서 '문항 4/10 작성 중'처럼 진행 상황이 보이고, 보통 1~2분 뒤 시험지가 올라와요. 마음이 바뀌면 취소할 수 있어요." },
    { target: "#tabBook", title: "4. 문제집에서 풀기",
      body: "완성된 시험지는 문제집에 쌓여요. 누르면 시험지가 열리고, OMR 답안지로 답을 고른 뒤 '채점하기'를 누르면 돼요. 문제마다 정답·해설, '이 문제 다시', '문제 신고'가 있고, '⏱ 시험 모드'와 '링크 복사'로 친구와 점수를 겨룰 수도 있어요." },
    { target: "#tabWrong", title: "5. 오답노트로 복습",
      body: "채점하면 틀린 문제가 오답노트에 모여요. 맞히면 1일·3일 뒤 다시 나오고, 3번 맞히면 졸업해요. 무작위로 뽑는 오답 모의고사도 풀 수 있어요." },
    { target: "#account", title: "6. 로그인 (선택)",
      body: "로그인 없이도 쓸 수 있어요. 구글로 로그인하면 내 시험지와 오답노트가 PC·휴대폰 어디서나 똑같이 보여요. '게스트로 시작'은 이 기기에서 바로 쓰다가, 나중에 구글 계정을 연결하면 기록이 그대로 옮겨져요." }
  ];

  let i = 0, hole, card, shield, onKey, onMove;
  const narrow = () => window.matchMedia("(max-width: 720px)").matches;

  function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; }

  function targetOf(step) {
    const sel = narrow() && step.mobileTarget ? step.mobileTarget : step.target;
    const t = document.querySelector(sel);
    return t && t.getClientRects().length ? t : null;
  }

  function place() {
    const step = STEPS[i], t = targetOf(step);
    if (!t) { hole.style.opacity = "0"; return; }
    const r = t.getBoundingClientRect(), pad = 8;
    // 화면보다 큰 대상(시험지 등)은 보이는 부분만 비춤
    const top = Math.max(r.top - pad, 8), bottom = Math.min(r.bottom + pad, window.innerHeight - 8);
    Object.assign(hole.style, { opacity: "1", left: r.left - pad + "px", top: top + "px", width: r.width + pad * 2 + "px", height: Math.max(bottom - top, 40) + "px" });

    if (narrow()) { card.classList.add("docked"); card.style.left = card.style.top = ""; return; }
    card.classList.remove("docked");
    const cw = card.offsetWidth, ch = card.offsetHeight, gap = 14;
    let left = r.right + gap, topC = Math.max(16, Math.min(r.top, window.innerHeight - ch - 16));
    if (left + cw > window.innerWidth - 16) left = r.left - cw - gap;           // 오른쪽 자리가 없으면 왼쪽
    if (left < 16) {                                                         // 양옆 다 없으면 아래/위
      left = Math.max(16, Math.min(r.left, window.innerWidth - cw - 16));
      topC = r.bottom + gap + ch < window.innerHeight ? r.bottom + gap : Math.max(16, r.top - ch - gap);
    }
    card.style.left = left + "px"; card.style.top = topC + "px";
  }

  function show() {
    const step = STEPS[i];
    // 설명할 부분이 있는 화면으로 옮김 (#make 등, 화면 전환은 app.js 가 주소를 보고 함)
    if (step.view && location.hash.slice(1) !== step.view) { location.hash = step.view; setTimeout(show, 40); return; }
    const t = targetOf(step);
    card.replaceChildren(
      el("span", "tour-count", `${i + 1} / ${STEPS.length}`),
      el("h3", "tour-title", step.title),
      el("p", "tour-body", step.body),
      (() => {
        const row = el("div", "tour-actions");
        const skip = el("button", "tour-skip", i === STEPS.length - 1 ? "" : "건너뛰기");
        skip.type = "button"; skip.onclick = end; if (i === STEPS.length - 1) skip.hidden = true;
        const back = el("button", "btn", "이전"); back.type = "button"; back.onclick = () => go(-1); back.hidden = i === 0;
        const next = el("button", "btn primary", i === STEPS.length - 1 ? "시작하기" : "다음"); next.type = "button"; next.onclick = () => go(1);
        row.append(skip, el("span", "tour-spacer"), back, next);
        setTimeout(() => next.focus({ preventScroll: true }), 0);
        return row;
      })()
    );
    if (t) {
      const r = t.getBoundingClientRect();
      const fits = r.top >= 0 && r.bottom <= window.innerHeight;
      if (!fits) t.scrollIntoView({ block: r.height > window.innerHeight * 0.8 ? "start" : "center", behavior: "smooth" });
    }
    place();
    setTimeout(place, 350); // 스크롤이 끝난 뒤 위치 다시 맞춤
  }

  function go(d) {
    i += d;
    if (i >= STEPS.length) return end();
    if (i < 0) i = 0;
    show();
  }

  function end() {
    try { localStorage.setItem(KEY, "1"); } catch (e) {}
    [hole, card, shield].forEach((n) => n && n.remove());
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", onMove);
    window.removeEventListener("scroll", onMove, true);
    document.getElementById("tourBtn")?.focus({ preventScroll: true });
  }

  function start() {
    if (card) end();
    i = 0;
    shield = el("div", "tour-shield"); shield.onclick = () => go(1);
    hole = el("div", "tour-hole");
    card = el("div", "tour-card");
    card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "true"); card.setAttribute("aria-label", "사용법 안내");
    document.body.append(shield, hole, card);
    onKey = (e) => {
      if (e.key === "Escape") end();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
    };
    onMove = () => requestAnimationFrame(place);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    show();
  }

  document.getElementById("tourBtn")?.addEventListener("click", start);
  let seen = false;
  try { seen = localStorage.getItem(KEY) === "1"; } catch (e) {}
  // 공유 링크로 시험지를 바로 열러 온 사람에게는 자동으로 띄우지 않음
  if (!seen && !new URLSearchParams(location.search).has("exam")) setTimeout(start, 600);
})();
