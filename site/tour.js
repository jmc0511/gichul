/* 첫 방문 안내: 설명할 부분만 밝게 비추고 옆에 설명 카드를 띄운다 */
(function () {
  const KEY = "gichul.tour.done";
  const STEPS = [
    { target: "#drop", title: "1. 공부자료 올리기",
      body: "강의노트나 강의 슬라이드를 PDF·PPTX로 올리세요. 여러 개를 한 번에 올려도 되고, 회로도·그래프 같은 그림이나 스캔한 페이지도 읽어요." },
    { target: ".panel .step:nth-of-type(2)", title: "2. 출제 조건 고르기",
      body: "문항 수, 문제 유형, 난이도를 고르세요. 외국어 시험이면 어휘·문법·독해 영역과 문제 언어도 정할 수 있어요. 원하는 범위가 있으면 '추가 요청'에 적어 주세요." },
    { target: "#go", title: "3. 출제 요청 보내기",
      body: "보내면 보통 1~2분 안에 시험지가 완성돼요. 아래 문제집에서 '문항 4/10 작성 중'처럼 진행 상황을 볼 수 있고, 마음이 바뀌면 취소할 수 있어요." },
    { target: "#sheet", title: "4. 시험지 풀기",
      body: "완성된 시험지는 '내 시험지'에서 열어요. 수식과 그림도 함께 나오고, 문제마다 정답·해설을 볼 수 있어요. 시험지 위 '링크 복사'로 친구와 공유할 수 있어요." },
    { target: ".omr", mobileTarget: ".mbar", title: "5. 답안지로 채점",
      body: "OMR 칸을 눌러 답을 고르고 '채점하기'를 누르세요. 단답형·서술형은 모범답안과 비교해 맞음·틀림을 직접 표시하면 점수에 들어가요. 틀린 문제는 오답노트에 모여요." },
    { target: "#account", title: "6. 로그인 (선택)",
      body: "로그인 없이도 쓸 수 있어요. 구글로 로그인하면 내 시험지와 오답노트가 PC·휴대폰 어디서나 똑같이 보여요. '게스트로 시작'은 이 기기에서 바로 쓰다가, 나중에 구글 계정을 연결하면 기록이 그대로 옮겨져요." }
  ];

  let i = 0, hole, card, shield, onKey, onMove;
  const narrow = () => window.matchMedia("(max-width: 820px)").matches;

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
    const step = STEPS[i], t = targetOf(step);
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
