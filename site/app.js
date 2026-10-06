(function () {
  const $ = (id) => document.getElementById(id);
  const MARKS = ["①", "②", "③", "④", "⑤"];
  const TYPE_LABEL = { mc: "객관식", ox: "O/X", short: "단답형", essay: "서술형" };
  const STATUS = { pending: "대기 중", working: "출제 중", done: "완료", error: "실패" };
  const TEXT_BUDGET = 150000;
  const POLL_MS = 15000;   // 실시간 알림이 끊겼을 때를 위한 예비 확인

  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  const EXAMPLE = {
    subject: "운영체제 중간고사",
    title: "운영체제 3장 · CPU 스케줄링 예상 기출",
    questions: [
      { type: "mc", question: "다음 중 선점형(preemptive) 스케줄링 알고리즘으로만 짝지어진 것은?", choices: ["FCFS, SJF", "SRTF, Round Robin", "FCFS, Round Robin", "SJF, HRN", "FCFS, HRN"], answer: 2, explanation: "SRTF는 남은 시간이 더 짧은 프로세스가 도착하면 CPU를 빼앗고, RR은 타임 퀀텀이 끝나면 강제로 CPU를 회수한다. FCFS·SJF·HRN은 비선점형이다.", source: "운영체제_3장.pdf p.12", points: 3 },
      { type: "mc", question: "도착 시간이 모두 0이고 CPU 버스트가 P1=24, P2=3, P3=3인 세 프로세스를 P1→P2→P3 순서로 FCFS 스케줄링할 때 평균 대기 시간은?", choices: ["3", "7", "13", "17", "27"], answer: 4, explanation: "대기 시간은 P1=0, P2=24, P3=27이므로 평균은 (0+24+27)/3 = 17이다. 짧은 작업이 긴 작업 뒤에서 기다리는 호위 효과(convoy effect)의 대표 예시이다.", source: "운영체제_3장.pdf p.15", points: 4 },
      { type: "ox", question: "Round Robin에서 타임 퀀텀을 매우 크게 설정하면 FCFS와 동일하게 동작한다.", answer: "O", explanation: "타임 퀀텀이 모든 버스트보다 길면 선점이 일어나지 않아 도착 순서대로 처리된다.", source: "운영체제_3장.pdf p.21", points: 2 },
      { type: "short", question: "우선순위 스케줄링에서 낮은 우선순위 프로세스가 무한히 기다리는 기아(starvation) 문제를 해결하기 위해, 대기 시간이 길어질수록 우선순위를 높여 주는 기법의 이름을 쓰시오.", answer: "에이징(Aging)", explanation: "에이징은 오래 기다린 프로세스의 우선순위를 점진적으로 올려 결국 실행되도록 보장한다.", source: "운영체제_3장.pdf p.18", points: 3 },
      { type: "essay", question: "다단계 피드백 큐(MLFQ)가 대화형 프로세스와 CPU 집중형 프로세스를 어떻게 구분해 다루는지, 큐 사이의 이동 규칙을 중심으로 서술하시오.", answer: "CPU를 오래 쓰는 프로세스는 하위(낮은 우선순위, 긴 퀀텀) 큐로 내려가고, 입출력 위주의 대화형 프로세스는 상위 큐에 머문다. 하위 큐에서 오래 기다린 프로세스는 에이징으로 상위 큐로 올려 기아를 막는다.", explanation: "채점 포인트: ① 퀀텀 소진 시 강등 ② 입출력 위주 프로세스는 상위 큐 유지 ③ 에이징을 통한 승격", source: "운영체제_3장.pdf p.24", points: 6 }
    ]
  };

  const state = {
    files: [],
    exam: null,
    isExample: true,
    answers: {},
    self: {},
    open: {},
    graded: false,
    round: 0,          // 채점 회차 (오답노트에서 같은 채점을 두 번 세지 않도록)
    busy: false
  };

  /* ---------- Supabase ---------- */
  const cfg = window.GICHUL_CONFIG || {};
  const configured = window.supabase && cfg.SUPABASE_URL && !/YOUR-/.test(cfg.SUPABASE_URL + cfg.SUPABASE_KEY);
  const sb = configured ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" }
  }) : null;

  let exams = [], requests = [], curExamId = null, pollTimer = null;

  /* ---------- 저장(내 브라우저에만) ---------- */
  function store(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
    if (SYNC_KEYS[key]) scheduleSync();
  }

  /* ---------- 로그인 · 기기 간 동기화 ----------
     로그인하면 내 요청·내 시험지·오답노트를 user_data 표에 저장하고, 다른 기기에서 불러온다.
     처음 로그인할 때는 이 기기에 있던 것과 서버 것을 합치고, 그다음부터는 서버를 기준으로 맞춘다. */
  const SYNC_KEYS = { "gichul.myreqs": "reqs", "gichul.myexams": "exams", "gichul.wrongs": "wrongs" };
  let user = null, syncTimer = null, applyingRemote = false;

  function scheduleSync() {
    if (!user || applyingRemote) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(pushSync, 1200);
  }
  async function pushSync() {
    clearTimeout(syncTimer); syncTimer = null;
    if (!user) return;
    await sb.from("user_data").upsert({
      user_id: user.id, reqs: myRequestIds(), exams: myExamIds(), wrongs: loadWrongs(), updated_at: new Date().toISOString()
    }).then(() => {}, () => {});
  }
  const unionIds = (a, b) => [...new Set([...(a || []), ...(b || [])])];
  function mergeWrongs(a, b) {
    const m = new Map();
    for (const w of [...(b || []), ...(a || [])]) { const p = m.get(w.key); if (!p || (w.count || 0) > (p.count || 0)) m.set(w.key, w); }
    return [...m.values()].sort((x, y) => (y.at || 0) - (x.at || 0));
  }
  function applyRemote(r, merge) {
    applyingRemote = true;
    store("gichul.myreqs", (merge ? unionIds(myRequestIds(), r.reqs) : r.reqs || []).slice(0, 30));
    store("gichul.myexams", (merge ? unionIds(myExamIds(), r.exams) : r.exams || []).slice(0, 30));
    store("gichul.wrongs", merge ? mergeWrongs(loadWrongs(), r.wrongs) : r.wrongs || []);
    applyingRemote = false;
  }
  async function pullSync() {
    if (!user) return;
    if (syncTimer) await pushSync(); // 아직 안 올린 변경부터 올림
    const { data, error } = await sb.from("user_data").select("reqs, exams, wrongs").eq("user_id", user.id).maybeSingle();
    if (error) return;
    const firstHere = load("gichul.synced_user", null) !== user.id;
    applyRemote(data || {}, firstHere);
    if (firstHere || !data) { store("gichul.synced_user", user.id); await pushSync(); }
  }

  const redirectTo = () => location.origin + location.pathname;
  async function signInGuest() {
    const { error } = await sb.auth.signInAnonymously();
    if (error) setStatus("게스트로 시작하지 못했어요. 잠시 후 다시 시도해 주세요.", true);
  }
  async function signInGoogle() {
    await pushSync();
    // 게스트라면 지금 계정에 구글을 연결해 데이터를 그대로 이어감
    if (user?.is_anonymous) {
      const { error } = await sb.auth.linkIdentity({ provider: "google", options: { redirectTo: redirectTo() } });
      if (!error) return;
      // 이미 다른 계정에 연결된 구글이면 그 계정으로 로그인 (이 기기 데이터는 합쳐짐)
    }
    const { error } = await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: redirectTo() } });
    if (error) setStatus("구글 로그인을 시작하지 못했어요.", true);
  }
  async function signOut() {
    await pushSync();
    await sb.auth.signOut();
    // 공용 컴퓨터를 위해 이 기기에 남은 내 목록을 지움 (서버에는 남아 있음)
    applyingRemote = true;
    ["gichul.myreqs", "gichul.myexams", "gichul.wrongs", "gichul.synced_user"].forEach((k) => { try { localStorage.removeItem(k); } catch (e) {} });
    applyingRemote = false;
    requests = []; exams = [];
    if (curExamId) { state.exam = EXAMPLE; state.isExample = true; curExamId = null; state.answers = {}; state.graded = false; persist(); renderAll(); }
    setStatus("로그아웃했어요. 다시 로그인하면 내 시험지와 오답노트가 돌아와요.");
    renderLib();
  }

  function renderAccount() {
    const box = $("account");
    if (!box || !sb) return;
    if (!user) {
      box.replaceChildren(
        el("button", { type: "button", class: "btn", text: "게스트로 시작", onclick: signInGuest, title: "이 기기에서 바로 시작해요. 나중에 구글 계정을 연결할 수 있어요." }),
        el("button", { type: "button", class: "btn google", onclick: signInGoogle }, el("span", { class: "g", text: "G" }), "구글로 로그인"));
      return;
    }
    const name = user.is_anonymous ? "게스트" : (user.user_metadata?.name || user.email || "내 계정");
    const parts = [
      el("span", { class: "who", title: user.is_anonymous ? "이 기기에서만 이어서 쓸 수 있어요. 구글 계정을 연결하면 다른 기기에서도 볼 수 있어요." : user.email || "" },
        el("span", { class: "dot" + (user.is_anonymous ? " guest" : "") }), name),
      user.is_anonymous ? el("button", { type: "button", class: "btn google", onclick: signInGoogle }, el("span", { class: "g", text: "G" }), "구글 계정 연결") : null,
      // 게스트는 로그아웃하면 다시 들어올 방법이 없어서 한 번 더 확인
      user.is_anonymous
        ? confirmButton("로그아웃", "기록이 사라져요. 정말?", signOut)
        : el("button", { type: "button", class: "link", text: "로그아웃", onclick: signOut })
    ];
    box.replaceChildren(...parts.filter(Boolean)); // 구글 계정이면 '연결' 버튼 자리가 비어 있음
  }

  function initAuth() {
    if (!sb) return;
    renderAccount();
    sb.auth.onAuthStateChange((event, session) => {
      const prev = user?.id;
      user = session?.user || null;
      renderAccount();
      if (user && (user.id !== prev || event === "USER_UPDATED")) {
        // 인증 콜백 안에서 바로 DB를 부르면 멈출 수 있어 다음 틱으로 미룸
        setTimeout(async () => {
          await pullSync();
          await refresh();
          if (event === "SIGNED_IN" && !user.is_anonymous) setStatus("로그인했어요. 내 시험지와 오답노트가 이 계정에 저장돼요.");
          if (event === "SIGNED_IN" && user.is_anonymous) setStatus("게스트로 시작했어요. 구글 계정을 연결하면 다른 기기에서도 볼 수 있어요.");
        }, 0);
      }
    });
    // 로그인 화면에서 돌아왔을 때 실패 메시지
    const err = new URLSearchParams(location.hash.slice(1)).get("error_description") || new URLSearchParams(location.search).get("error_description");
    if (err) {
      setStatus(/already/i.test(err) ? "이 구글 계정은 이미 다른 계정에 연결돼 있어요. '구글로 로그인'을 눌러 주세요." : "로그인하지 못했어요: " + err, true);
      history.replaceState(null, "", location.pathname);
    }
  }
  function load(key, fallback) { try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch (e) { return fallback; } }
  function persist() { store("gichul.exam", { exam: state.exam, isExample: state.isExample, answers: state.answers, examId: curExamId }); }
  function restore() {
    const d = load("gichul.exam", null);
    if (!d || !d.exam || !Array.isArray(d.exam.questions)) return false;
    state.exam = d.exam; state.isExample = !!d.isExample; state.answers = d.answers || {}; curExamId = d.examId || null;
    return true;
  }
  const myRequestIds = () => load("gichul.myreqs", []);
  const myExamIds = () => load("gichul.myexams", []);
  const rememberExam = (id) => store("gichul.myexams", [id, ...myExamIds().filter((x) => x !== id)].slice(0, 30));
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function examLink(id) {
    const u = new URL(location.href);
    u.search = ""; u.hash = "";
    u.searchParams.set("exam", id);
    return u.toString();
  }
  async function copyLink() {
    const url = examLink(curExamId);
    try { await navigator.clipboard.writeText(url); setStatus("시험지 링크를 복사했어요. 받은 사람은 이 링크로만 열 수 있어요."); }
    catch (e) { setStatus("복사하지 못했어요. 이 주소를 직접 복사하세요: " + url); }
  }

  /* 공유 링크(?exam=…)로 들어온 경우 그 시험지를 연다 */
  async function openFromLink() {
    const id = new URLSearchParams(location.search).get("exam");
    if (!id || !UUID_RE.test(id) || !sb) return;
    const { data, error } = await sb.rpc("get_exams", { ids: [id] });
    if (error || !data || !data.length) { setStatus("링크의 시험지를 찾을 수 없어요. 주소가 정확한지 확인해 주세요.", true); return; }
    rememberExam(id);
    exams = [data[0], ...exams.filter((x) => x.id !== id)];
    openExam(id);
    history.replaceState(null, "", location.pathname);
  }

  /* ---------- 작은 DOM 도우미 ---------- */
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === "class") n.className = attrs[k];
      else if (k === "text") n.textContent = attrs[k];
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] != null) n.setAttribute(k, attrs[k]);
    }
    for (const k of kids) if (k != null) n.append(k);
    return n;
  }
  function setStatus(msg, err) { const s = $("status"); s.textContent = msg; s.classList.toggle("err", !!err); }
  function when(iso) {
    try { return new Date(iso).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; }
  }

  /* ---------- PDF 읽기 ---------- */
  // 그림 판정: 사진/그림 객체가 있거나, 선·도형이 많거나(회로도·그래프), 글자가 거의 없는(스캔) 쪽
  async function pdfVisualScore(page, textLen) {
    if (textLen < 40) return 1000;
    const OPS = pdfjsLib.OPS;
    const ops = (await page.getOperatorList()).fnArray;
    let images = 0, paths = 0;
    for (const op of ops) {
      if (op === OPS.paintImageXObject || op === OPS.paintInlineImageXObject || op === OPS.paintImageMaskXObject) images++;
      else if (op === OPS.constructPath) paths++;
    }
    if (!images && paths < 40) return 0;
    return images * 10 + Math.min(paths, 400) / 10;
  }

  async function readPdf(file) {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const pages = [], visuals = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      const text = tc.items.map((it) => (it.str || "") + (it.hasEOL ? "\n" : " ")).join("")
        .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
      pages.push(text);
      let score = 0;
      try { score = await pdfVisualScore(page, text.length); } catch (e) {}
      if (score) visuals.push({ page: i - 1, score, render: () => renderPdfPage(pdf, i) });
    }
    const chars = pages.reduce((a, p) => a + p.length, 0);
    return { pages, visuals, scanned: chars / Math.max(1, pages.length) < 40 };
  }

  const IMG_MAX_W = 1400;
  async function canvasToJpeg(canvas) {
    return new Promise((ok) => canvas.toBlob(ok, "image/jpeg", 0.82));
  }
  async function renderPdfPage(pdf, n) {
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: Math.min(2, IMG_MAX_W / base.width) });
    const c = document.createElement("canvas");
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return canvasToJpeg(c);
  }
  // PPTX 속 그림 파일을 JPEG로 (크면 줄임)
  async function mediaToJpeg(zipFile) {
    const blob = await zipFile.async("blob");
    const bmp = await createImageBitmap(blob);
    const s = Math.min(1, IMG_MAX_W / bmp.width);
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    return canvasToJpeg(c);
  }

  /* PPTX: 슬라이드 XML에서 글자를, 연결된 발표자 노트에서 메모를 읽는다 */
  const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
  function xmlText(xml) {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    return [...doc.getElementsByTagNameNS(NS_A, "p")]
      .map((p) => [...p.getElementsByTagNameNS(NS_A, "t")].map((t) => t.textContent).join(""))
      .filter((s) => s.trim()).join("\n");
  }
  async function readPptx(file) {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const slides = Object.keys(zip.files)
      .map((n) => { const m = n.match(/^ppt\/slides\/slide(\d+)\.xml$/); return m ? { n, i: +m[1] } : null; })
      .filter(Boolean).sort((a, b) => a.i - b.i);
    if (!slides.length) throw new Error("no slides");
    const pages = [], visuals = [];
    for (const s of slides) {
      let text = xmlText(await zip.file(s.n).async("string"));
      const rels = zip.file(`ppt/slides/_rels/slide${s.i}.xml.rels`);
      if (rels) {
        const relXml = await rels.async("string");
        // 슬라이드에 들어간 그림 (emf/wmf 같은 벡터 형식은 브라우저가 못 그려서 제외)
        const media = [...relXml.matchAll(/Target="\.\.\/media\/([^"]+\.(?:png|jpe?g|gif|bmp|webp))"/gi)].map((m) => zip.file("ppt/media/" + m[1])).filter(Boolean);
        const page = pages.length;
        for (const mf of media) {
          const size = mf._data?.uncompressedSize || 0;
          if (size && size < 8000) continue; // 아이콘·로고 같은 작은 그림은 건너뜀
          visuals.push({ page, score: text.length < 15 ? 1000 : 20, render: () => mediaToJpeg(mf) });
        }
        const m = relXml.match(/Target="\.\.\/notesSlides\/(notesSlide\d+\.xml)"/);
        const notes = m && zip.file("ppt/notesSlides/" + m[1]);
        if (notes) {
          // 노트 파일에는 슬라이드 번호 자리표시자도 있어서 숫자만 있는 줄은 버림
          const memo = xmlText(await notes.async("string")).split("\n").filter((l) => !/^\s*\d+\s*$/.test(l)).join("\n");
          if (memo.trim()) text += "\n[발표자 노트]\n" + memo;
        }
      }
      pages.push(text.replace(/[ \t]+/g, " ").trim());
    }
    const chars = pages.reduce((a, p) => a + p.length, 0);
    return { pages, visuals, kind: "pptx", scanned: chars / pages.length < 15 };
  }

  const isPdf = (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);
  const isPptx = (f) => /\.pptx$/i.test(f.name);

  async function addFiles(list) {
    const files = [...list].filter((f) => isPdf(f) || isPptx(f));
    if (!files.length) {
      const old = [...list].some((f) => /\.ppt$/i.test(f.name));
      setStatus(old ? "예전 형식(.ppt)은 읽을 수 없어요. PowerPoint에서 .pptx나 PDF로 저장해서 올려 주세요." : "PDF나 PPTX 파일만 올릴 수 있습니다.", true);
      return;
    }
    for (const f of files) {
      const item = { name: f.name, pages: null, loading: true };
      state.files.push(item);
      renderFiles();
      try {
        if (isPptx(f)) {
          if (!window.JSZip) throw new Error("no jszip");
          Object.assign(item, await readPptx(f), { loading: false });
        } else {
          if (!window.pdfjsLib) throw new Error("no pdfjs");
          Object.assign(item, await readPdf(f), { loading: false });
        }
      } catch (e) {
        state.files = state.files.filter((x) => x !== item);
        setStatus(`"${f.name}"을(를) 읽지 못했습니다. 암호가 걸려 있거나 손상된 파일일 수 있습니다.`, true);
      }
      renderFiles();
    }
  }

  function renderFiles() {
    $("files").replaceChildren(...state.files.map((f) => {
      let meta = "읽는 중…";
      if (!f.loading) {
        meta = f.pages.length + (f.kind === "pptx" ? "장" : "쪽");
        if (f.scanned) meta += " · 스캔본";
        else if (f.visuals.length) meta += ` · 그림 ${f.visuals.length}`;
      }
      return el("li", null,
        el("span", { class: "nm", title: f.name, text: f.name }),
        el("span", { class: "meta", text: meta, title: f.scanned ? "글자가 없는 쪽은 이미지로 보내 Claude가 직접 읽습니다" : null }),
        el("button", { type: "button", "aria-label": f.name + " 빼기", text: "×", onclick: () => { state.files = state.files.filter((x) => x !== f); renderFiles(); } })
      );
    }));
    const ready = state.files.filter((f) => !f.loading);
    const block = quotaBlock();
    $("go").disabled = !sb || state.busy || !ready.length || state.files.some((f) => f.loading) || !!block;
    if (state.busy) return;
    if (block && ready.length) { setStatus(block, true); return; }
    if (!sb) setStatus("사이트 설정이 끝나지 않았습니다. config.js에 Supabase 주소와 공개 키를 넣어 주세요.", true);
    else if (!ready.length) setStatus("PDF를 올리고 요청을 보내면 문제를 만들어 문제집에 올려 드려요.");
    else {
      const pages = ready.reduce((a, f) => a + f.pages.length, 0);
      const vis = ready.reduce((a, f) => a + f.visuals.length, 0);
      setStatus(`자료 ${ready.length}개 · ${pages}쪽 준비됨` + (vis ? ` · 그림 ${Math.min(vis, MAX_IMAGES)}장 함께 보냄` + (vis > MAX_IMAGES ? ` (${vis}장 중 중요한 것만)` : "") : ""));
    }
  }

  /* ---------- 요청 한도 ---------- */
  let quota = null;
  const LIMIT_MSG = {
    limit_open: "진행 중인 요청이 끝나면 다시 보낼 수 있어요.",
    limit_daily: "오늘 보낼 수 있는 요청을 다 썼어요. 내일 다시 이용해 주세요.",
    limit_site: "오늘은 사이트 전체 요청이 마감됐어요. 내일 다시 이용해 주세요."
  };
  function quotaBlock() {
    if (!quota) return null;
    if (quota.site_full) return LIMIT_MSG.limit_site;
    if (quota.used >= quota.limit) return LIMIT_MSG.limit_daily;
    if (quota.open >= quota.open_limit) return LIMIT_MSG.limit_open;
    return null;
  }
  async function loadQuota() {
    if (!sb) return;
    const { data, error } = await sb.rpc("my_quota");
    if (error || !data) return;
    quota = data;
    const q = $("quota");
    q.hidden = false;
    q.textContent = `오늘 남은 요청 ${Math.max(0, quota.limit - quota.used)}/${quota.limit}`;
    q.classList.toggle("out", !!quotaBlock());
    renderFiles();
  }

  /* ---------- 출제 요청 ---------- */
  const MAX_IMAGES = 20;
  // 보낼 그림 고르기: 글자 없는 쪽 > 그림 많은 쪽 순으로 최대 20장, 자료 순서대로 번호를 붙임
  function pickImages() {
    const all = [];
    state.files.filter((f) => !f.loading).forEach((f, fi) => f.visuals.forEach((v, vi) => all.push({ f, fi, vi, ...v })));
    const chosen = all.sort((a, b) => b.score - a.score).slice(0, MAX_IMAGES)
      .sort((a, b) => a.fi - b.fi || a.page - b.page || a.vi - b.vi);
    chosen.forEach((c, k) => {
      c.no = k + 1;
      c.label = `${c.f.name} ${c.f.kind === "pptx" ? "슬라이드 " : "p."}${c.page + 1}`;
    });
    return chosen;
  }

  function buildMaterial(images = []) {
    const ready = state.files.filter((f) => !f.loading);
    const tag = (f, i) => {
      const nos = images.filter((c) => c.f === f && c.page === i).map((c) => "#" + c.no);
      return nos.length ? `\n[이 쪽의 그림: 첨부 이미지 ${nos.join(", ")}]` : "";
    };
    const blocks = ready.map((f) => ({ name: f.name, text: f.pages.map((p, i) => `[${f.kind === "pptx" ? "슬라이드 " : "p."}${i + 1}]\n${p}${tag(f, i)}`).join("\n\n") }));
    const total = blocks.reduce((a, b) => a + b.text.length, 0);
    const ratio = total > TEXT_BUDGET ? TEXT_BUDGET / total : 1;
    return blocks.map((b) => `===== 자료: ${b.name} =====\n` + (ratio < 1 ? b.text.slice(0, Math.floor(b.text.length * ratio)) + "\n(…이하 생략)" : b.text)).join("\n\n");
  }

  function buildInstructions() {
    const count = document.querySelector('input[name="count"]:checked').value;
    const types = [...document.querySelectorAll('input[name="type"]:checked')].map((i) => i.value);
    const level = document.querySelector('input[name="level"]:checked').value;
    const subject = $("subject").value.trim();
    const extra = $("extra").value.trim();
    const areas = [...document.querySelectorAll('input[name="area"]:checked')].map((i) => i.value);
    const lang = document.querySelector('input[name="lang"]:checked').value;
    const typeDesc = { mc: "객관식 5지선다(mc)", ox: "O/X(ox)", short: "단답형(short)", essay: "서술형(essay)" };
    const langRule = {
      ko: "- 문제·보기·해설은 한국어로 쓰세요. 단, 외국어 단어·문장·지문을 인용할 때는 원문 그대로 쓰세요.",
      src: "- 문제·보기·해설을 모두 자료의 주 언어로 쓰세요.",
      mix: "- 문제 지시문·지문·보기는 자료의 외국어로 쓰고, 정답 해설(explanation)만 한국어로 쓰세요. 실제 공인 외국어 시험의 문제 말투를 따르세요."
    }[lang];
    const areaRule = areas.length ? [
      "",
      "[외국어 시험 영역]",
      `- 영역: ${areas.join(", ")}. 고른 영역을 고르게 섞고, 각 문항의 area에 영역 이름을 쓰세요.`,
      areas.includes("어휘") ? "- 어휘: 자료에 나온 단어·숙어의 뜻, 유의어·반의어, 문맥에 맞는 단어 고르기." : null,
      areas.includes("문법") ? "- 문법: 빈칸에 알맞은 형태, 어법상 틀린 것 고르기, 문장 전환. 자료에서 다룬 문법 항목만." : null,
      areas.includes("독해") ? "- 독해: question 안에 지시문, 빈 줄, 지문(자료 문장을 활용하거나 자료 수준으로 새로 작성) 순서로 넣고, 내용 일치·주제·빈칸 추론을 묻으세요." : null,
      areas.includes("해석·작문") ? "- 해석·작문: 위에서 고른 유형과 관계없이 short 또는 essay 형식으로, 문장 해석이나 주어진 표현을 써서 영작하기. 모범답안을 answer에 쓰세요." : null
    ].filter((x) => x != null) : [];
    return [
      "당신은 대학 및 자격시험 출제위원입니다. 학생의 공부자료(강의노트·교재)를 근거로, 실제 시험에 출제될 법한 '기출 스타일' 문제를 만드세요.",
      "",
      "[출제 조건]",
      `- 시험명: ${subject || "자료 내용에 맞게 정하세요"}`,
      `- 문항 수: 정확히 ${count}문항`,
      `- 유형: ${types.map((t) => typeDesc[t]).join(", ")} (여러 유형이면 고르게 섞되 객관식 비중을 가장 크게)`,
      `- 난이도: ${level}`,
      extra ? `- 추가 요청: ${extra}` : null,
      "",
      "[출제 원칙]",
      "- 자료에서 강조된 개념, 정의, 비교, 공식·계산, 예시를 중심으로 시험에 자주 나오는 포인트를 고르세요.",
      "- 자료의 용어와 표기를 그대로 쓰고, 자료에 없는 내용으로 정답을 만들지 마세요.",
      "- 객관식은 보기 5개, 정답 1개. 오답은 학생이 헷갈릴 만한 그럴듯한 내용으로.",
      "- 단원·주제가 한쪽에 몰리지 않게 자료 전체에서 고르게 출제하세요.",
      "- 해설은 왜 정답인지와 오답의 함정을 2~4문장으로. 서술형 해설에는 채점 포인트를 쓰세요.",
      "- source에는 근거가 된 자료 파일명과 쪽수를 '파일명 p.쪽' 형식으로 쓰세요.",
      "- 배점(points)은 난이도에 따라 2~6점, 서술형은 5~10점.",
      "- 수식이나 기호가 들어간 식은 LaTeX로 쓰세요. 문장 속 수식은 $...$, 따로 놓을 수식은 $$...$$. 예: $\\frac{1}{2}mv^2$, $\\int_0^1 x\\,dx$, $V_{out} = -\\frac{R_f}{R_1}V_{in}$. JSON 문자열 안에서는 역슬래시를 \\\\ 처럼 두 번 써야 합니다. 수식이 아닌 곳(금액 등)에는 $ 기호를 쓰지 마세요.",
      langRule,
      ...areaRule,
      "",
      "[출력 형식] JSON 하나:",
      '{"title":"시험지 제목","subject":"과목명","questions":[{"type":"mc","question":"문제","choices":["보기1","보기2","보기3","보기4","보기5"],"answer":3,"explanation":"해설","source":"강의노트.pdf p.4","points":3},{"type":"ox","question":"진술문","answer":"O","explanation":"…","source":"…","points":2},{"type":"short","question":"…","answer":"모범답안","explanation":"…","source":"…","points":3}]}',
      "- mc의 answer는 1~5 숫자, ox의 answer는 \"O\" 또는 \"X\", short·essay의 answer는 모범답안 문자열.",
      areas.length ? "- 각 문항에 \"area\":\"어휘\" 처럼 영역 필드를 추가하세요." : null
    ].filter((x) => x != null).join("\n");
  }

  async function submitRequest() {
    if (!document.querySelectorAll('input[name="type"]:checked').length) { setStatus("문제 유형을 하나 이상 고르세요.", true); return; }
    const picked = pickImages();
    const material = buildMaterial(picked);
    const hasText = state.files.some((f) => !f.loading && f.pages.some((p) => p.trim()));
    if (!hasText && !picked.length) { setStatus("자료에서 글자도 그림도 찾지 못했어요. 다른 파일로 시도해 주세요.", true); return; }
    await loadQuota(); // 그림을 올리기 전에 한도부터 확인
    if (quotaBlock()) { setStatus(quotaBlock(), true); return; }
    state.busy = true; renderFiles();
    setStatus("요청을 보내는 중…");
    try {
      const ready = state.files.filter((f) => !f.loading);
      const id = crypto.randomUUID();

      // 그림을 먼저 올리고(처리기가 요청을 보자마자 쓸 수 있게) 요청을 넣음
      const images = [];
      for (const c of picked) {
        setStatus(`그림 올리는 중… ${images.length + 1}/${picked.length}`);
        const blob = await c.render();
        if (!blob) continue;
        const path = `${id}/${String(c.no).padStart(2, "0")}.jpg`;
        const up = await sb.storage.from("request-images").upload(path, blob, { contentType: "image/jpeg", upsert: false });
        if (up.error) throw up.error;
        images.push({ path, label: `이미지 #${c.no} (${c.label})` });
      }

      setStatus("요청을 보내는 중…");
      const { error } = await sb.from("requests").insert({
        id,
        subject: $("subject").value.trim() || null,
        files: ready.map((f) => f.name),
        pages: ready.reduce((a, f) => a + f.pages.length, 0),
        instructions: buildInstructions(),
        material,
        images: images.length ? images : null
      });
      if (error) throw error;
      store("gichul.myreqs", [id, ...myRequestIds()].slice(0, 30));
      notifyWorker();
      state.files = [];   // 같은 자료를 실수로 두 번 보내지 않도록 비움
      state.busy = false;
      renderFiles();
      setStatus("요청을 보냈습니다. 출제가 끝나면 아래 문제집에 시험지가 올라옵니다.");
      await refresh();
    } catch (e) {
      state.busy = false;
      renderFiles();
      const code = Object.keys(LIMIT_MSG).find((k) => String(e?.message || "").includes(k));
      setStatus(code ? LIMIT_MSG[code] : "요청을 보내지 못했습니다. 인터넷 연결을 확인하고 다시 시도해 주세요.", true);
      loadQuota();
    }
  }

  /* ---------- 실시간 알림 ---------- */
  // 처리기에게 "새 요청 있음"을 바로 알림 (실패해도 처리기가 주기적으로 확인함)
  function notifyWorker() {
    fetch(cfg.SUPABASE_URL.replace(/\/$/, "") + "/realtime/v1/api/broadcast", {
      method: "POST",
      headers: { apikey: cfg.SUPABASE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ topic: "queue", event: "new", payload: {} }] })
    }).catch(() => {});
  }

  // 처리 중인 내 요청마다 채널을 열어 진행 상황을 바로 받음
  const channels = new Map();
  function syncChannels() {
    if (!sb) return;
    const live = new Set(requests.filter((r) => r.status === "pending" || r.status === "working").map((r) => r.id));
    for (const [id, ch] of channels) if (!live.has(id)) { sb.removeChannel(ch); channels.delete(id); }
    for (const id of live) {
      if (channels.has(id)) continue;
      const ch = sb.channel("req-" + id).on("broadcast", { event: "update" }, ({ payload }) => {
        const r = requests.find((x) => x.id === id);
        if (!r || !payload) return;
        if (payload.status) r.status = payload.status;
        if (payload.progress !== undefined) r.progress = payload.progress;
        if (payload.status === "done" || payload.status === "error") refresh();
        else renderLib();
      }).subscribe();
      channels.set(id, ch);
    }
  }

  /* ---------- 문제집 ---------- */
  async function refresh() {
    if (!sb) return;
    const ids = myRequestIds();
    try {
      if (ids.length) {
        const rq = await sb.rpc("get_requests", { ids });
        if (!rq.error) {
          const before = new Map(requests.map((r) => [r.id, r.status]));
          requests = rq.data || [];
          if (requests.some((r) => r.status === "done" && before.get(r.id) && before.get(r.id) !== "done") && !state.busy) {
            setStatus("요청한 시험지가 완성됐어요. 문제집에서 열어 보세요.");
          }
        }
      }
      // 내 요청으로 만들어진 시험지 + 링크로 받아서 열어 본 시험지
      const examIds = [...new Set([...requests.map((r) => r.exam_id).filter(Boolean), ...myExamIds()])].slice(0, 50);
      if (examIds.length) {
        const ex = await sb.rpc("get_exams", { ids: examIds });
        if (!ex.error) exams = ex.data || [];
      }
    } catch (e) {}
    renderLib();
    syncChannels();
    loadQuota();
    schedulePoll();
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    const waiting = requests.some((r) => r.status === "pending" || r.status === "working");
    pollTimer = setTimeout(() => { if (!document.hidden) refresh(); else schedulePoll(); }, waiting ? POLL_MS : POLL_MS * 15);
  }

  function openExam(id) {
    const d = exams.find((x) => x.id === id);
    if (!d) { refresh(); return; }
    state.exam = normalize(d);
    state.isExample = false; curExamId = id;
    state.answers = {}; state.self = {}; state.open = {}; state.graded = false;
    persist(); renderAll(); renderLib();
    $("sheet").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* 한 번 누르면 "정말?"으로 바뀌고, 4초 안에 다시 누르면 실행 */
  function confirmButton(label, ask, run) {
    let armed = null;
    const b = el("button", { type: "button", class: "link danger", text: label });
    b.addEventListener("click", () => {
      if (!armed) {
        b.textContent = ask; b.classList.add("armed");
        armed = setTimeout(() => { armed = null; b.textContent = label; b.classList.remove("armed"); }, 4000);
        return;
      }
      clearTimeout(armed); armed = null;
      b.disabled = true;
      run();
    });
    return b;
  }

  function forgetRequest(reqId) {
    store("gichul.myreqs", myRequestIds().filter((x) => x !== reqId));
    requests = requests.filter((r) => r.id !== reqId);
  }
  function closeExamIfOpen(examId) {
    if (examId && examId === curExamId) {
      state.exam = EXAMPLE; state.isExample = true; curExamId = null;
      state.answers = {}; state.self = {}; state.open = {}; state.graded = false;
      persist(); renderAll();
    }
  }

  // 내 요청 취소/삭제: 요청과 거기서 나온 시험지를 DB에서 지움
  async function deleteRequest(r, doneMsg) {
    const { error } = await sb.rpc("delete_request", { req: r.id });
    if (error) { setStatus("지우지 못했어요. 잠시 후 다시 시도해 주세요.", true); renderLib(); return; }
    forgetRequest(r.id);
    if (r.exam_id) { exams = exams.filter((x) => x.id !== r.exam_id); closeExamIfOpen(r.exam_id); }
    setStatus(doneMsg);
    renderLib(); syncChannels();
  }

  // 내 시험지 삭제: 내가 요청한 것이면 DB에서, 링크로 받은 것이면 내 목록에서만
  async function deleteExam(x) {
    const mine = requests.find((r) => r.exam_id === x.id);
    if (mine) return deleteRequest(mine, "시험지를 삭제했어요.");
    store("gichul.myexams", myExamIds().filter((id) => id !== x.id));
    exams = exams.filter((e) => e.id !== x.id);
    closeExamIfOpen(x.id);
    setStatus("내 목록에서 뺐어요. 링크가 있으면 다시 열 수 있어요.");
    renderLib();
  }

  function renderLib() {
    // 완료된 요청은 "내 시험지"에 나오므로 요청 목록에서는 진행 중·실패만 보여줌
    const visible = requests.filter((r) => r.status !== "done").slice(0, 10);
    $("reqHead").hidden = !visible.length;
    $("reqList").replaceChildren(...visible.map((r) => {
      const name = r.subject || (Array.isArray(r.files) ? r.files.join(", ") : "요청");
      const live = r.status === "pending" || r.status === "working";
      const action = live
        ? confirmButton("취소", "정말 취소?", () => deleteRequest(r, "요청을 취소했어요."))
        : confirmButton("지우기", "정말 지울까요?", () => deleteRequest(r, "요청을 지웠어요."));
      return el("li", null,
        el("span", { class: "t", title: name, text: name }),
        el("span", { class: "pill " + (r.status || "pending"), text: (r.status === "working" && r.progress) || STATUS[r.status] || "대기 중" }),
        el("span", { class: "s row" },
          el("span", { text: when(r.created_at) + (r.status === "error" && r.error ? " · " + r.error : "") }),
          action));
    }));
    const wrongs = loadWrongs();
    const noteItem = wrongs.length ? el("li", { class: "note-item" + (curExamId === NOTE_ID ? " cur" : "") },
      el("span", { class: "t", text: `오답노트 · ${wrongs.length}문항` }),
      el("button", { type: "button", class: "open", text: curExamId === NOTE_ID ? "보는 중" : "다시 풀기", onclick: openWrongNote }),
      el("span", { class: "s row" },
        el("span", { text: "채점에서 틀린 문제 모음 · 맞히면 빠져요" }),
        confirmButton("비우기", "정말 비울까요?", () => {
          saveWrongs([]);
          if (curExamId === NOTE_ID) { state.exam = EXAMPLE; state.isExample = true; curExamId = null; state.answers = {}; state.self = {}; state.graded = false; persist(); renderAll(); }
          setStatus("오답노트를 비웠어요.");
          renderLib();
        }))) : null;
    $("examList").replaceChildren(...(noteItem ? [noteItem] : []), ...(exams.length ? exams.map((x) => {
      const mine = requests.some((r) => r.exam_id === x.id);
      return el("li", { class: x.id === curExamId ? "cur" : "" },
        el("span", { class: "t", title: x.title, text: x.title || "시험지" }),
        el("button", { type: "button", class: "open", text: x.id === curExamId ? "보는 중" : "풀기", onclick: () => openExam(x.id) }),
        el("span", { class: "s row" },
          el("span", { text: `${(x.questions || []).length}문항 · ${when(x.created_at)}` }),
          mine ? confirmButton("삭제", "정말 삭제?", () => deleteExam(x)) : confirmButton("목록에서 빼기", "정말 뺄까요?", () => deleteExam(x))));
    }) : noteItem ? [] : [el("li", null, el("span", { class: "s", text: sb ? "아직 시험지가 없어요. 출제를 요청하거나 친구가 보낸 링크를 열면 여기에 쌓입니다." : "사이트 설정 후 이용할 수 있어요." }))]));
  }

  /* ---------- 시험지 데이터 정리 ---------- */
  function normalize(data) {
    const qs = (data && Array.isArray(data.questions) ? data.questions : []).map((q) => {
      const type = ["mc", "ox", "short", "essay"].includes(q.type) ? q.type : (Array.isArray(q.choices) && q.choices.length ? "mc" : "short");
      const out = {
        type,
        question: String(q.question || "").trim(),
        explanation: String(q.explanation || "").trim(),
        source: String(q.source || "").trim(),
        area: String(q.area || "").trim().slice(0, 12),
        points: Math.max(1, Math.min(20, parseInt(q.points, 10) || 3))
      };
      if (q.figure && typeof q.figure.path === "string" && /^[0-9a-f-]{36}\/\d+\.jpg$/i.test(q.figure.path)) {
        const c = q.figure.crop;
        out.figure = { path: q.figure.path, crop: Array.isArray(c) && c.length === 4 && c.every((v) => typeof v === "number") ? c : null };
      }
      if (type === "mc") {
        out.choices = (q.choices || []).slice(0, 5).map((c) => String(c).replace(/^\s*[①②③④⑤]\s*/, ""));
        out.answer = parseInt(q.answer, 10);
        if (!(out.answer >= 1 && out.answer <= out.choices.length)) out.answer = null;
      } else if (type === "ox") {
        const a = String(q.answer || "").trim().toUpperCase();
        out.answer = a.startsWith("O") || a === "참" || a === "TRUE" ? "O" : "X";
      } else {
        out.answer = String(q.answer || "").trim();
      }
      return out;
    }).filter((q) => q.question && (q.type !== "mc" || q.choices.length >= 2));
    return { title: String(data?.title || "예상 기출문제"), subject: String(data?.subject || ""), questions: qs };
  }

  /* ---------- 오답노트 (이 브라우저에 저장) ---------- */
  const NOTE_ID = "wrongnote";
  const loadWrongs = () => load("gichul.wrongs", []);
  const saveWrongs = (w) => store("gichul.wrongs", w.slice(0, 300));
  function qKey(q) {
    const s = q.type + "|" + q.question + "|" + (q.choices || []).join("|");
    let h = 5381;
    for (let k = 0; k < s.length; k++) h = ((h << 5) + h + s.charCodeAt(k)) | 0;
    return (h >>> 0).toString(36);
  }
  // 채점 결과를 오답노트에 반영: 틀린 문제는 넣고, 오답노트에서 다시 맞힌 문제는 뺌
  function recordResults() {
    if (!state.exam || state.isExample || !state.graded) return;
    const inNote = curExamId === NOTE_ID;
    let wrongs = loadWrongs();
    let added = 0, cleared = 0;
    state.exam.questions.forEach((q, i) => {
      // 객관식·OX는 채점하면 바로 판정(안 고른 것도 틀림), 단답·서술은 맞음/틀림을 표시해야 판정
      const decided = q.type === "mc" || q.type === "ox" || state.self[i] != null;
      if (!decided) return;
      const key = q._key || qKey(q);
      const idx = wrongs.findIndex((w) => w.key === key);
      if (!isRight(i)) {
        if (idx >= 0) {
          // 같은 채점에서 두 번 세지 않도록 시험지·채점 회차로 구분
          if (wrongs[idx].lastRound !== state.round) { wrongs[idx].count++; wrongs[idx].lastRound = state.round; }
        } else {
          const { _key, _from, ...clean } = q;
          wrongs.unshift({ key, from: q._from || state.exam.title, q: clean, count: 1, at: Date.now(), lastRound: state.round });
          added++;
        }
      } else if (idx >= 0 && (inNote || (wrongs[idx].lastRound === state.round && wrongs[idx].count === 1))) {
        // 오답노트에서 맞혔거나, 방금 '틀림'으로 눌렀다가 '맞음'으로 고친 경우
        wrongs.splice(idx, 1);
        if (inNote) cleared++;
      }
    });
    saveWrongs(wrongs);
    if (added) setStatus(`틀린 문제 ${added}개를 오답노트에 넣었어요.`);
    else if (cleared) setStatus(`맞힌 문제 ${cleared}개를 오답노트에서 뺐어요.`);
    renderLib();
  }

  function openWrongNote() {
    const wrongs = loadWrongs();
    if (!wrongs.length) return;
    state.exam = {
      title: "오답노트",
      subject: `틀린 문제 ${wrongs.length}개 다시 풀기`,
      questions: wrongs.map((w) => ({ ...w.q, _key: w.key, _from: w.from, _count: w.count }))
    };
    state.isExample = false; curExamId = NOTE_ID;
    state.answers = {}; state.self = {}; state.open = {}; state.graded = false;
    persist(); renderAll(); renderLib();
    $("sheet").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ---------- 채점 ---------- */
  function isRight(i) {
    const q = state.exam.questions[i], a = state.answers[i];
    if (q.type === "mc") return a != null && a === q.answer;
    if (q.type === "ox") return a === q.answer;
    return state.self[i] === true;
  }
  function score() {
    let got = 0, total = 0;
    state.exam.questions.forEach((q, i) => { total += q.points; if (isRight(i)) got += q.points; });
    return { got, total };
  }

  /* ---------- 시험지 그리기 ---------- */
  function renderSheet() {
    const sheet = $("sheet");
    const ex = state.exam;
    if (!ex) { sheet.replaceChildren(el("p", { class: "empty", text: "공부자료를 올리고 출제하면 여기에 시험지가 나타납니다." })); return; }
    const total = ex.questions.reduce((a, q) => a + q.points, 0);
    const nodes = [];
    if (state.isExample) nodes.push(el("div", { class: "ex-flag", text: "예시 시험지 · PDF를 올려 내 자료로 출제하세요" }));
    else if (curExamId && curExamId !== NOTE_ID && sb) nodes.push(el("div", { class: "sheet-tools" }, el("button", { type: "button", class: "btn", text: "링크 복사", onclick: copyLink })));
    nodes.push(
      el("div", { class: "sheet-head" },
        el("div", { class: "kicker", text: (ex.subject || "예상 기출") + " · 문제지" }),
        el("h2", { text: ex.title })),
      el("div", { class: "sheet-meta" },
        el("span", null, "문항 수 ", el("span", { class: "tn", text: String(ex.questions.length) }), " · 배점 ", el("span", { class: "tn", text: total + "점" })),
        el("span", null, "성명 ", el("span", { class: "blank" }), "  학번 ", el("span", { class: "blank" }))),
      el("div", { class: "questions" }, ...ex.questions.map((q, i) => renderQ(q, i)))
    );
    sheet.replaceChildren(...nodes);
    renderMath(sheet);
    sheet.querySelectorAll("textarea.write").forEach(autoGrow);
  }

  /* 수식: $…$ 인라인, $$…$$ 블록 (KaTeX) */
  function renderMath(root) {
    if (!window.renderMathInElement) return;
    try {
      renderMathInElement(root, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "\\[", right: "\\]", display: true },
          { left: "$", right: "$", display: false },
          { left: "\\(", right: "\\)", display: false }
        ],
        throwOnError: false,
        ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"]
      });
    } catch (e) {}
  }

  function autoGrow(ta) {
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + 2 + "px";
  }

  function renderQ(q, i) {
    const a = state.answers[i];
    const art = el("article", { class: "q", id: "q" + i });
    art.append(el("p", { class: "q-text" },
      el("span", { class: "q-no", text: (i + 1) + "." }),
      q.question + " ",
      el("span", { class: "q-pts", text: `[${q.points}점]` }),
      el("span", { class: "q-type", text: TYPE_LABEL[q.type] }),
      q.area ? el("span", { class: "q-type", text: q.area }) : null,
      q._from ? el("span", { class: "q-from", text: q._from + (q._count > 1 ? ` · ${q._count}번 틀림` : "") }) : null
    ));
    if (q.figure) art.append(figureEl(q.figure, i));
    const choiceClass = (v) => {
      let cls = "choice";
      if (a === v) cls += " sel";
      if (state.graded && v === q.answer) cls += " right";
      if (state.graded && a === v && v !== q.answer) cls += " miss";
      return cls;
    };
    if (q.type === "mc") {
      art.append(el("ol", { class: "choices" }, ...q.choices.map((c, k) =>
        el("li", null, el("button", { type: "button", class: choiceClass(k + 1), "aria-pressed": a === k + 1 ? "true" : "false", onclick: () => pick(i, k + 1) },
          el("span", { class: "mk", text: MARKS[k] }), el("span", { text: c }))))));
    } else if (q.type === "ox") {
      art.append(el("div", { class: "ox" }, ...["O", "X"].map((v) =>
        el("button", { type: "button", class: choiceClass(v), "aria-pressed": a === v ? "true" : "false", onclick: () => pick(i, v), text: v }))));
    } else {
      const ta = el("textarea", { class: "write" + (q.type === "short" ? " short" : ""), id: "ans" + i, "aria-label": (i + 1) + "번 답안", placeholder: "답을 쓰세요 · 수식은 $x^2$ 처럼" });
      ta.value = typeof a === "string" ? a : "";
      // 답에 수식($…$)이 있으면 아래에 렌더링된 미리보기를 보여줌
      const preview = el("div", { class: "math-preview", "aria-live": "polite" });
      let pv = null;
      const updatePreview = () => {
        const v = ta.value;
        const has = /\$[^$]+\$|\\\(|\\\[/.test(v);
        preview.hidden = !has;
        if (!has) return;
        preview.replaceChildren(el("span", { class: "math-preview-label", text: "수식 미리보기" }), el("div", { class: "math-preview-body", text: v }));
        renderMath(preview);
      };
      ta.addEventListener("input", () => {
        state.answers[i] = ta.value; persist(); autoGrow(ta);
        clearTimeout(pv); pv = setTimeout(updatePreview, 250);
      });
      art.append(ta, preview);
      updatePreview();
    }
    if (state.open[i] || state.graded) art.append(renderSol(q, i));
    if (!state.graded) {
      art.append(el("div", { class: "q-tools" }, el("button", { type: "button", class: "link", text: state.open[i] ? "해설 접기" : "정답·해설 보기", onclick: () => { state.open[i] = !state.open[i]; renderSheet(); } })));
    }
    return art;
  }

  // 문제 그림: 쪽 이미지에서 crop 영역만 잘라 보여줌
  function figureEl(fig, i) {
    const src = cfg.SUPABASE_URL.replace(/\/$/, "") + "/storage/v1/object/public/exam-figures/" + fig.path;
    const img = el("img", { src, alt: `${i + 1}번 문제 그림`, loading: "lazy", decoding: "async" });
    const box = el("div", { class: "fig-box" }, img);
    const wrap = el("figure", { class: "fig" }, box);
    if (fig.crop) {
      const [x0, y0, x1, y1] = fig.crop;
      box.classList.add("cropped");
      img.addEventListener("load", () => {
        const w = (x1 - x0) * img.naturalWidth, h = (y1 - y0) * img.naturalHeight;
        box.style.aspectRatio = `${w} / ${h}`;
        box.style.maxWidth = Math.min(w, 560) + "px";
        img.style.width = 100 / (x1 - x0) + "%";
        img.style.left = (-x0 / (x1 - x0)) * 100 + "%";
        img.style.top = (-y0 / (y1 - y0)) * 100 + "%";
      });
    }
    img.addEventListener("error", () => { wrap.replaceChildren(el("figcaption", { class: "fig-missing", text: "그림을 불러오지 못했어요." })); });
    return wrap;
  }

  function renderSol(q, i) {
    const ans = q.type === "mc" ? (q.answer ? `${MARKS[q.answer - 1]} ${q.choices[q.answer - 1]}` : "정답 정보 없음") : q.answer;
    const box = el("div", { class: "sol" },
      el("p", { class: "ans", text: "정답  " + ans }),
      q.explanation ? el("p", { text: q.explanation }) : null,
      q.source ? el("p", { class: "src", text: "근거  " + q.source }) : null
    );
    if (q.type === "short" || q.type === "essay") {
      const v = state.self[i];
      box.append(el("div", { class: "selfcheck" },
        el("span", { text: "모범답안과 비교해 보세요" }),
        el("button", { type: "button", class: v === true ? "on-ok" : "", onclick: () => { state.self[i] = true; renderAll(); recordResults(); }, text: "맞음" }),
        el("button", { type: "button", class: v === false ? "on-no" : "", onclick: () => { state.self[i] = false; renderAll(); recordResults(); }, text: "틀림" })
      ));
    }
    return box;
  }

  function renderOmr() {
    const ex = state.exam, rows = $("omrRows");
    if (!ex) { rows.replaceChildren(); $("omrCount").textContent = ""; return; }
    $("omrCount").textContent = ex.questions.length + "문항";
    rows.replaceChildren(...ex.questions.map((q, i) => {
      const a = state.answers[i];
      let cls = "omr-row";
      if (state.graded) cls += isRight(i) ? " right" : (q.type === "mc" || q.type === "ox" || state.self[i] === false ? " wrongrow" : "");
      let body;
      if (q.type === "mc" || q.type === "ox") {
        const opts = q.type === "mc" ? q.choices.map((_, k) => k + 1) : ["O", "X"];
        body = el("div", { class: "bubbles" }, ...opts.map((v) => {
          let c = "bub";
          if (a === v) c += " on";
          if (state.graded && v === q.answer) c += " key";
          return el("button", { type: "button", class: c, "aria-label": `${i + 1}번 ${v}`, onclick: () => pick(i, v), text: String(v) });
        }));
      } else {
        const label = state.graded || state.self[i] != null
          ? (state.self[i] === true ? "맞음" : state.self[i] === false ? "틀림" : "자가채점 필요")
          : (typeof a === "string" && a.trim() ? "작성함" : TYPE_LABEL[q.type]);
        body = el("button", { type: "button", class: "link omr-note", onclick: () => $("q" + i).scrollIntoView({ behavior: "smooth", block: "center" }), text: label });
      }
      return el("div", { class: cls }, el("span", { class: "n", text: String(i + 1) }), body);
    }));
    const s = score();
    if (state.graded) {
      const pending = ex.questions.filter((q, i) => (q.type === "short" || q.type === "essay") && state.self[i] == null).length;
      $("scoreBig").textContent = `${s.got}`;
      $("scoreSub").textContent = `/ ${s.total}점` + (pending ? ` · 서술·단답 ${pending}문항 자가채점 남음` : "");
    } else {
      const done = Object.keys(state.answers).filter((k) => state.answers[k] !== "" && state.answers[k] != null).length;
      $("scoreBig").textContent = `${done}/${ex.questions.length}`;
      $("scoreSub").textContent = "답을 고른 뒤 채점하세요";
    }
    $("grade").textContent = state.graded ? "다시 풀기" : "채점하기";
    $("mGrade").textContent = $("grade").textContent;
    const prog = $("mProg");
    if (state.graded) prog.replaceChildren("점수 ", el("b", { text: String(s.got) }), ` / ${s.total}점`);
    else prog.replaceChildren("푼 문항 ", el("b", { text: $("scoreBig").textContent }));
    $("showAll").hidden = state.graded;
  }

  function renderAll() { renderSheet(); renderOmr(); }

  function pick(i, v) {
    if (state.graded) return;
    state.answers[i] = state.answers[i] === v ? null : v;
    persist();
    renderAll();
  }

  /* ---------- 파일로 저장 ---------- */
  function examText() {
    const ex = state.exam;
    const L = [ex.title, ex.subject ? "과목: " + ex.subject : "", ""];
    ex.questions.forEach((q, i) => {
      L.push(`${i + 1}. ${q.area ? "[" + q.area + "] " : ""}${q.question} [${q.points}점]`);
      if (q.figure) L.push("   (그림 있음 · 사이트에서 확인)");
      if (q.type === "mc") q.choices.forEach((c, k) => L.push(`   ${MARKS[k]} ${c}`));
      if (q.type === "ox") L.push("   ( O / X )");
      L.push("");
    });
    L.push("", "──────── 정답 및 해설 ────────", "");
    ex.questions.forEach((q, i) => {
      const ans = q.type === "mc" ? (q.answer ? MARKS[q.answer - 1] : "?") : q.answer;
      L.push(`${i + 1}. 정답: ${ans}`);
      if (q.explanation) L.push("   해설: " + q.explanation);
      if (q.source) L.push("   근거: " + q.source);
      L.push("");
    });
    return L.join("\n");
  }

  /* ---------- 이벤트 ---------- */
  const drop = $("drop");
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => { if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });
  $("file").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
  $("go").addEventListener("click", submitRequest);
  $("grade").addEventListener("click", () => {
    if (!state.exam) return;
    if (state.graded) {
      // 오답노트를 다시 풀면 맞혀서 빠진 문제를 뺀 새 노트로 시작
      if (curExamId === NOTE_ID) {
        if (loadWrongs().length) return openWrongNote();
        state.exam = EXAMPLE; state.isExample = true; curExamId = null;
        setStatus("오답노트를 다 비웠어요. 수고했어요!");
      }
      state.graded = false; state.answers = {}; state.self = {}; state.open = {}; persist();
    } else {
      state.graded = true;
      state.round = Date.now();
      recordResults();
    }
    renderAll();
    if (state.graded) $("sheet").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("mGrade").addEventListener("click", () => $("grade").click());
  $("mOmr").addEventListener("click", () => document.querySelector(".omr").scrollIntoView({ behavior: "smooth", block: "start" }));
  $("showAll").addEventListener("click", () => {
    if (!state.exam) return;
    const allOpen = state.exam.questions.every((_, i) => state.open[i]);
    state.exam.questions.forEach((_, i) => { state.open[i] = !allOpen; });
    $("showAll").textContent = allOpen ? "해설 모두 보기" : "해설 모두 접기";
    renderSheet();
  });
  $("reset").addEventListener("click", () => { state.answers = {}; state.self = {}; state.graded = false; persist(); renderAll(); });
  $("save").addEventListener("click", () => {
    if (!state.exam) return;
    const name = (state.exam.title || "기출문제").replace(/[\\/:*?"<>|]/g, " ").trim().slice(0, 80) + ".txt";
    const url = URL.createObjectURL(new Blob(["﻿" + examText()], { type: "text/plain;charset=utf-8" }));
    const a = el("a", { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  document.addEventListener("visibilitychange", async () => {
    if (document.hidden) { if (syncTimer) pushSync(); return; }
    await pullSync(); // 다른 기기에서 바뀐 것 가져오기
    refresh();
  });
  window.addEventListener("pagehide", () => { if (syncTimer) pushSync(); });

  /* ---------- 시작 ---------- */
  if (!restore()) { state.exam = EXAMPLE; state.isExample = true; }
  renderAll();
  renderFiles();
  renderLib();
  initAuth();
  refresh().then(openFromLink);
})();
