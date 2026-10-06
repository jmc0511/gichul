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
    busy: false,
    timer: null,       // 시험 모드 { endAt, startedAt, mins }
    timerPick: false,  // 시간 고르는 칸 열림
    elapsed: null,     // 시험 모드로 푼 시간(ms)
    reportOpen: {},    // 신고 칸이 열린 문제
    rank: null,        // 순위 { list, submitted }
    printKey: null     // 인쇄 중: true 정답 포함 / false 문제만
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
    if (curExamId) { state.exam = EXAMPLE; state.isExample = true; curExamId = null; resetRun(); persist(); renderAll(); }
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
  // 시험지를 바꾸거나 처음부터 다시 풀 때: 답·채점·시험 모드·순위를 모두 비움
  function resetRun() {
    state.answers = {}; state.self = {}; state.open = {}; state.graded = false;
    state.timer = null; state.timerPick = false; state.elapsed = null; state.reportOpen = {}; state.rank = null;
    clearInterval(tickTimer);
  }
  function persist() { store("gichul.exam", { exam: state.exam, isExample: state.isExample, answers: state.answers, examId: curExamId, timer: state.timer }); }
  function restore() {
    const d = load("gichul.exam", null);
    if (!d || !d.exam || !Array.isArray(d.exam.questions)) return false;
    state.exam = d.exam; state.isExample = !!d.isExample; state.answers = d.answers || {}; curExamId = d.examId || null;
    state.timer = d.timer && d.timer.endAt ? d.timer : null;
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
    return blobToJpeg(await zipFile.async("blob"));
  }
  async function blobToJpeg(blob) {
    const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
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

  /* 사진(필기 노트·교재 사진): 글자는 Claude가 그림으로 직접 읽음 */
  async function readImage(file) {
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); }
    catch (e) { throw new Error(/hei[cf]/i.test(file.name + file.type) ? "heic" : "image"); }
    bmp.close?.();
    return { pages: [""], visuals: [{ page: 0, score: 1000, render: () => blobToJpeg(file) }], kind: "image", scanned: true };
  }
  // 자료 안에서 쪽을 부르는 이름
  const pageName = (f, i) => f.kind === "pptx" ? `슬라이드 ${i + 1}` : f.kind === "image" ? "사진" : `p.${i + 1}`;

  const isPdf = (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);
  const isPptx = (f) => /\.pptx$/i.test(f.name);
  const isImage = (f) => /^image\//i.test(f.type) || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(f.name);

  async function addFiles(list) {
    const files = [...list].filter((f) => isPdf(f) || isPptx(f) || isImage(f));
    if (!files.length) {
      const old = [...list].some((f) => /\.ppt$/i.test(f.name));
      setStatus(old ? "예전 형식(.ppt)은 읽을 수 없어요. PowerPoint에서 .pptx나 PDF로 저장해서 올려 주세요." : "PDF, PPTX, 사진(JPG·PNG) 파일만 올릴 수 있어요.", true);
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
        } else if (isImage(f)) {
          Object.assign(item, await readImage(f), { loading: false });
        } else {
          if (!window.pdfjsLib) throw new Error("no pdfjs");
          Object.assign(item, await readPdf(f), { loading: false });
        }
      } catch (e) {
        state.files = state.files.filter((x) => x !== item);
        setStatus(e?.message === "heic"
          ? `"${f.name}"은(는) 아이폰 HEIC 사진이라 이 브라우저에서 못 읽어요. JPG로 바꿔 올리거나, 아이폰 설정 > 카메라 > 포맷 > '높은 호환성'으로 찍어 주세요.`
          : `"${f.name}"을(를) 읽지 못했습니다. 암호가 걸려 있거나 손상된 파일일 수 있습니다.`, true);
      }
      renderFiles();
    }
  }

  function renderFiles() {
    $("files").replaceChildren(...state.files.map((f) => {
      let meta = "읽는 중…";
      if (!f.loading) {
        meta = f.kind === "image" ? "사진" : f.pages.length + (f.kind === "pptx" ? "장" : "쪽");
        if (f.scanned && f.kind !== "image") meta += " · 스캔본";
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
    limit_daily: "오늘 보낼 수 있는 요청을 다 썼어요. 밤 12시가 지나면 다시 보낼 수 있어요.",
    limit_site: "오늘은 사이트 전체 요청이 마감됐어요. 밤 12시가 지나면 다시 열려요."
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
    q.textContent = `오늘 남은 요청 ${Math.max(0, quota.limit - quota.used)}/${quota.limit} · 매일 0시 초기화`;
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
      c.label = c.f.kind === "image" ? `${c.f.name} (사진)` : `${c.f.name} ${pageName(c.f, c.page)}`;
    });
    return chosen;
  }

  function buildMaterial(images = []) {
    const ready = state.files.filter((f) => !f.loading);
    const tag = (f, i) => {
      const nos = images.filter((c) => c.f === f && c.page === i).map((c) => "#" + c.no);
      return nos.length ? `\n[이 쪽의 그림: 첨부 이미지 ${nos.join(", ")}]` : "";
    };
    const blocks = ready.map((f) => ({ name: f.name, text: f.pages.map((p, i) => `[${pageName(f, i)}]\n${p}${tag(f, i)}`).join("\n\n") }));
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
    askNotify();
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

  // 같은 자료·같은 조건으로 새 문제 받기 (자료는 끝난 뒤 14일 동안 서버에 남아 있음)
  async function retryRequest(r, btn) {
    askNotify();
    await loadQuota();
    if (quotaBlock()) { setStatus(quotaBlock(), true); return; }
    btn.disabled = true;
    const id = crypto.randomUUID();
    const { data, error } = await sb.rpc("retry_request", { src: r.id, new_id: id });
    if (error || !data) {
      btn.disabled = false;
      const code = error && Object.keys(LIMIT_MSG).find((k) => String(error.message || "").includes(k));
      setStatus(code ? LIMIT_MSG[code] : error ? "요청을 보내지 못했어요. 잠시 후 다시 시도해 주세요." : "자료 보관 기간(14일)이 지나 다시 낼 수 없어요. 자료를 다시 올려 주세요.", true);
      if (!error) { r.reusable = false; renderLib(); }
      loadQuota();
      return;
    }
    store("gichul.myreqs", [id, ...myRequestIds()].slice(0, 30));
    notifyWorker();
    setStatus("같은 자료로 새 문제를 요청했어요. 앞서 낸 문제와 겹치지 않게 만들어요.");
    await refresh();
  }
  // 이 시험지를 만든 내 요청 ('문제 다시' 요청 말고 원래 요청)
  const ownRequest = (examId) => requests.find((r) => r.exam_id === examId && r.regen_exam == null);
  const regenPending = (examId) => requests.find((r) => r.regen_exam === examId && (r.status === "pending" || r.status === "working"));

  // 시험지의 문제 하나만 새로 받기
  async function regenQuestion(q, pos) {
    const src = ownRequest(curExamId);
    if (!src || !Number.isInteger(q._i)) return;
    askNotify();
    await loadQuota();
    if (quotaBlock()) { setStatus(quotaBlock(), true); renderSheet(); return; }
    const id = crypto.randomUUID();
    const { data, error } = await sb.rpc("regen_question", { src: src.id, idx: q._i, new_id: id });
    if (error || !data) {
      const m = String(error?.message || "");
      const code = Object.keys(LIMIT_MSG).find((k) => m.includes(k));
      setStatus(m.includes("regen_busy") ? "이 시험지에서 이미 다른 문제를 바꾸는 중이에요. 끝나면 다시 눌러 주세요."
        : code ? LIMIT_MSG[code] : error ? "요청을 보내지 못했어요. 잠시 후 다시 시도해 주세요." : "자료 보관 기간(14일)이 지나 문제를 바꿀 수 없어요.", true);
      renderSheet();
      return;
    }
    store("gichul.myreqs", [id, ...myRequestIds()].slice(0, 30));
    notifyWorker();
    setStatus(`${pos + 1}번 문제를 새로 만드는 중이에요. 보통 1분 안팎 걸려요.`);
    await refresh();
    renderSheet();
  }

  function retryButton(r, label) {
    const b = el("button", { type: "button", class: "link retry", text: label, title: "자료를 다시 올리지 않고, 같은 범위·같은 조건으로 다른 문제를 받아요" });
    b.addEventListener("click", () => retryRequest(r, b));
    return b;
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
      let finished = [];
      if (ids.length) {
        const rq = await sb.rpc("get_requests", { ids });
        if (!rq.error) {
          const before = new Map(requests.map((r) => [r.id, r.status]));
          requests = rq.data || [];
          finished = requests.filter((r) => (r.status === "done" || r.status === "error") && before.get(r.id) && before.get(r.id) !== r.status);
        }
      }
      // 내 요청으로 만들어진 시험지 + 링크로 받아서 열어 본 시험지
      const examIds = [...new Set([...requests.map((r) => r.exam_id).filter(Boolean), ...myExamIds()])].slice(0, 50);
      if (examIds.length) {
        const ex = await sb.rpc("get_exams", { ids: examIds });
        if (!ex.error) exams = ex.data || [];
      }
      for (const r of finished) announceFinished(r);
    } catch (e) {}
    renderLib();
    syncChannels();
    loadQuota();
    schedulePoll();
  }

  /* ---------- 완료 알림 ---------- */
  const BASE_TITLE = document.title;
  function askNotify() {
    try { if ("Notification" in window && Notification.permission === "default") Notification.requestPermission(); } catch (e) {}
  }
  function announceFinished(r) {
    const ok = r.status === "done";
    const isRegen = r.regen_exam != null;
    const name = r.subject || (r.files || []).join(", ") || "요청한 시험지";
    const msg = !ok ? `"${name}" 출제에 실패했어요. 문제집에서 다시 시도할 수 있어요.`
      : isRegen ? `${r.regen_idx + 1}번 문제를 새 문제로 바꿨어요.`
      : `"${name}" 시험지가 완성됐어요. 문제집에서 열어 보세요.`;
    if (!state.busy) setStatus(msg, !ok);
    // 보고 있던 시험지의 문제가 바뀌었으면 그 문제만 새로 그림
    if (ok && isRegen && curExamId === r.regen_exam) reloadExam(r.regen_exam, r.regen_idx);
    if (!document.hidden) return;
    document.title = (ok ? "✅ " : "⚠️ ") + (isRegen ? "문제 교체 완료" : ok ? "시험지 완성" : "출제 실패") + " · " + BASE_TITLE;
    try {
      if ("Notification" in window && Notification.permission === "granted") {
        const n = new Notification(ok ? (isRegen ? "문제를 바꿨어요" : "시험지가 완성됐어요") : "출제에 실패했어요", { body: ok && !isRegen ? name : msg, tag: "gichuri-" + r.id });
        n.onclick = () => { window.focus(); if (ok && r.exam_id) openExam(r.exam_id); n.close(); };
      }
    } catch (e) {}
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) document.title = BASE_TITLE; });

  // 시험지를 다시 받아 오되, 바뀐 문제 말고는 푼 답을 그대로 둠
  function reloadExam(id, changedIdx) {
    const d = exams.find((x) => x.id === id);
    if (!d) return;
    const fresh = normalize(d);
    const pos = fresh.questions.findIndex((q) => q._i === changedIdx);
    state.exam = fresh;
    if (pos >= 0) { delete state.answers[pos]; delete state.self[pos]; delete state.open[pos]; }
    persist(); renderAll();
    if (pos >= 0) $("q" + pos)?.scrollIntoView({ behavior: "smooth", block: "center" });
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
    resetRun();
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
      resetRun();
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
    const mine = ownRequest(x.id);
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
      const base = r.subject || (Array.isArray(r.files) ? r.files.join(", ") : "요청");
      const name = r.regen_exam != null ? `${r.regen_idx + 1}번 문제 다시 · ${base}` : base;
      const live = r.status === "pending" || r.status === "working";
      const action = live
        ? confirmButton("취소", "정말 취소?", () => deleteRequest(r, "요청을 취소했어요."))
        : confirmButton("지우기", "정말 지울까요?", () => deleteRequest(r, "요청을 지웠어요."));
      return el("li", null,
        el("span", { class: "t", title: name, text: (r.retry_of ? "↻ " : "") + name }),
        el("span", { class: "pill " + (r.status || "pending"), text: (r.status === "working" && r.progress) || STATUS[r.status] || "대기 중" }),
        el("span", { class: "s row" },
          el("span", { text: when(r.created_at) + (r.status === "error" && r.error ? " · " + r.error : "") }),
          el("span", { class: "acts" }, r.status === "error" && r.reusable && r.regen_exam == null ? retryButton(r, "다시 시도") : null, action)));
    }));
    const noteItem = renderNoteItem();
    $("examList").replaceChildren(...(noteItem ? [noteItem] : []), ...(exams.length ? exams.map((x) => {
      const req = ownRequest(x.id);
      return el("li", { class: x.id === curExamId ? "cur" : "" },
        el("span", { class: "t", title: x.title, text: x.title || "시험지" }),
        el("button", { type: "button", class: "open", text: x.id === curExamId ? "보는 중" : "풀기", onclick: () => openExam(x.id) }),
        el("span", { class: "s row" },
          el("span", { text: `${(x.questions || []).length}문항 · ${when(x.created_at)}` }),
          el("span", { class: "acts" },
            req?.reusable ? retryButton(req, "새 문제로 다시") : null,
            req ? confirmButton("삭제", "정말 삭제?", () => deleteExam(x)) : confirmButton("목록에서 빼기", "정말 뺄까요?", () => deleteExam(x)))));
    }) : noteItem ? [] : [el("li", null, el("span", { class: "s", text: sb ? "아직 시험지가 없어요. 출제를 요청하거나 친구가 보낸 링크를 열면 여기에 쌓입니다." : "사이트 설정 후 이용할 수 있어요." }))]));
  }

  /* ---------- 시험지 데이터 정리 ---------- */
  function normalize(data) {
    const qs = (data && Array.isArray(data.questions) ? data.questions : []).map((q, rawIdx) => {
      const type = ["mc", "ox", "short", "essay"].includes(q.type) ? q.type : (Array.isArray(q.choices) && q.choices.length ? "mc" : "short");
      const out = {
        _i: rawIdx,   // DB 시험지 안의 원래 번호 (신고·문제 다시에 씀)
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
  /* 복습 주기: 틀리면 오늘 바로 → 오답노트에서 맞히면 1일 뒤 → 또 맞히면 3일 뒤 → 또 맞히면 졸업(빠짐).
     오답노트에서 또 틀리면 처음부터(내일 다시). */
  const DAY = 864e5;
  const REVIEW_GAP = [0, 1, 3];   // stage 별 다음 복습까지 날짜
  const GRADUATE = 3;
  const tomorrow = () => { const d = new Date(); d.setHours(24, 0, 0, 0); return d.getTime(); };
  const isDue = (w) => !w.due || w.due <= Date.now();
  const subjectOf = (w) => w.subject || "과목 없음";

  // 채점 결과를 오답노트에 반영
  function recordResults() {
    if (!state.exam || state.isExample || !state.graded) return;
    const inNote = curExamId === NOTE_ID;
    let wrongs = loadWrongs();
    let added = 0, moved = 0, graduated = 0;
    state.exam.questions.forEach((q, i) => {
      // 객관식·OX는 채점하면 바로 판정(안 고른 것도 틀림), 단답·서술은 맞음/틀림을 표시해야 판정
      const decided = q.type === "mc" || q.type === "ox" || state.self[i] != null;
      if (!decided) return;
      const key = q._key || qKey(q);
      const idx = wrongs.findIndex((w) => w.key === key);
      const w = wrongs[idx];
      if (!isRight(i)) {
        if (w) {
          // 같은 채점에서 두 번 세지 않도록 채점 회차로 구분
          if (w.lastRound !== state.round) { w.count++; w.lastRound = state.round; }
          w.stage = 0;
          w.due = inNote ? tomorrow() : Date.now();
        } else {
          const { _key, _from, _count, _exam, _i, _subject, _stage, ...clean } = q;
          wrongs.unshift({
            key, from: q._from || state.exam.title, subject: state.exam.subject || "",
            exam: curExamId, idx: Number.isInteger(_i) ? _i : null,
            q: clean, count: 1, at: Date.now(), lastRound: state.round, stage: 0, due: Date.now()
          });
          added++;
        }
      } else if (w && inNote) {
        if (w.lastRound === state.round) return; // 이번 채점에서 이미 반영함
        w.lastRound = state.round;
        w.stage = (w.stage || 0) + 1;
        if (w.stage >= GRADUATE) { wrongs.splice(idx, 1); graduated++; }
        else { w.due = Date.now() + REVIEW_GAP[w.stage] * DAY; moved++; }
      } else if (w && w.lastRound === state.round && w.count === 1) {
        // 방금 '틀림'으로 눌렀다가 '맞음'으로 고친 경우
        wrongs.splice(idx, 1);
      }
    });
    saveWrongs(wrongs);
    if (added) setStatus(`틀린 문제 ${added}개를 오답노트에 넣었어요.`);
    else if (moved || graduated) setStatus([moved ? `${moved}개는 며칠 뒤 다시 복습` : "", graduated ? `${graduated}개는 오답노트 졸업!` : ""].filter(Boolean).join(" · "));
    renderLib();
  }

  // filter: { due: 오늘 복습할 것만, subject: 과목 }
  let noteFilter = { due: true, subject: "" };
  function openWrongNote(filter) {
    if (filter) noteFilter = { ...noteFilter, ...filter };
    const all = loadWrongs();
    let list = all.filter((w) => !noteFilter.subject || subjectOf(w) === noteFilter.subject);
    if (noteFilter.due) list = list.filter(isDue);
    if (!list.length) {
      setStatus(noteFilter.due ? "오늘 복습할 문제를 다 풀었어요. 전체 풀기로 미리 볼 수도 있어요." : "오답노트가 비었어요.");
      renderLib();
      return false;
    }
    state.exam = {
      title: "오답노트" + (noteFilter.subject ? " · " + noteFilter.subject : ""),
      subject: noteFilter.due ? `오늘 복습 ${list.length}문항` : `전체 ${list.length}문항`,
      questions: list.map((w) => ({ ...w.q, _key: w.key, _from: w.from, _count: w.count, _exam: w.exam, _i: w.idx, _stage: w.stage || 0 }))
    };
    state.isExample = false; curExamId = NOTE_ID;
    resetRun();
    persist(); renderAll(); renderLib();
    $("sheet").scrollIntoView({ behavior: "smooth", block: "start" });
    return true;
  }

  function renderNoteItem() {
    const wrongs = loadWrongs();
    if (!wrongs.length) return null;
    const subjects = [...new Set(wrongs.map(subjectOf))];
    if (noteFilter.subject && !subjects.includes(noteFilter.subject)) noteFilter.subject = "";
    const pool = wrongs.filter((w) => !noteFilter.subject || subjectOf(w) === noteFilter.subject);
    const due = pool.filter(isDue).length;
    const nextDue = pool.filter((w) => !isDue(w)).map((w) => w.due).sort((a, b) => a - b)[0];
    const viewing = curExamId === NOTE_ID;
    const sub = due ? `오늘 복습 ${due}문항 · 맞히면 1일·3일 뒤 다시, 3번 맞히면 졸업`
      : nextDue ? `오늘 복습 끝! 다음 복습 ${new Date(nextDue).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" })}` : "";
    const picker = subjects.length > 1 ? el("select", { class: "note-subject", "aria-label": "과목 고르기",
      onchange: (e) => { noteFilter.subject = e.target.value; renderLib(); } },
      el("option", { value: "", text: `전체 과목 (${wrongs.length})` }),
      ...subjects.map((s) => { const o = el("option", { value: s, text: `${s} (${wrongs.filter((w) => subjectOf(w) === s).length})` }); o.selected = s === noteFilter.subject; return o; })) : null;
    return el("li", { class: "note-item" + (viewing ? " cur" : "") },
      el("span", { class: "t", text: `오답노트 · ${pool.length}문항` }),
      el("button", { type: "button", class: "open", text: due ? `오늘 복습 ${due}` : "전체 풀기", onclick: () => openWrongNote({ due: !!due }) }),
      picker ? el("span", { class: "s" }, picker) : null,
      el("span", { class: "s row" },
        el("span", { text: sub }),
        el("span", { class: "acts" },
          due ? el("button", { type: "button", class: "link retry", text: "전체 풀기", onclick: () => openWrongNote({ due: false }) }) : null,
          confirmButton("비우기", noteFilter.subject ? "이 과목 비울까요?" : "정말 비울까요?", () => {
            saveWrongs(noteFilter.subject ? wrongs.filter((w) => subjectOf(w) !== noteFilter.subject) : []);
            if (viewing) { state.exam = EXAMPLE; state.isExample = true; curExamId = null; resetRun(); persist(); renderAll(); }
            setStatus("오답노트를 비웠어요.");
            renderLib();
          }))));
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
    if (state.isExample) nodes.push(el("div", { class: "ex-flag", text: "예시 시험지 · 자료를 올려 내 자료로 출제하세요" }));
    const tools = [];
    if (!state.graded && !state.timer) tools.push(el("button", { type: "button", class: "btn", text: "⏱ 시험 모드", "aria-expanded": state.timerPick ? "true" : "false", onclick: () => { state.timerPick = !state.timerPick; renderSheet(); } }));
    if (realExam()) tools.push(el("button", { type: "button", class: "btn", text: "링크 복사", onclick: copyLink }));
    if (tools.length) nodes.push(el("div", { class: "sheet-tools" }, ...tools));
    if (state.timerPick && !state.timer && !state.graded) nodes.push(timerPicker(ex));
    if (state.timer) nodes.push(el("div", { class: "exam-bar", role: "status" },
      el("span", null, "시험 중 · 남은 시간 ", el("b", { class: "timer-left", text: timeLeft() })),
      el("span", { class: "exam-bar-note", text: "해설은 채점 후에 볼 수 있어요" }),
      el("button", { type: "button", class: "btn primary", text: "시험 끝내기", onclick: grade })));
    nodes.push(
      el("div", { class: "sheet-head" },
        el("div", { class: "kicker", text: (ex.subject || "예상 기출") + (state.printKey ? " · 문제지 · 정답 포함" : " · 문제지") }),
        el("h2", { text: ex.title })),
      el("div", { class: "sheet-meta" },
        el("span", null, "문항 수 ", el("span", { class: "tn", text: String(ex.questions.length) }), " · 배점 ", el("span", { class: "tn", text: total + "점" })),
        el("span", null, "성명 ", el("span", { class: "blank" }), "  학번 ", el("span", { class: "blank" }))));
    if (state.graded && realExam()) nodes.push(renderRank());
    nodes.push(el("div", { class: "questions" }, ...ex.questions.map((q, i) => renderQ(q, i))));
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
    if (state.printKey || ((state.open[i] || state.graded) && !state.timer)) art.append(renderSol(q, i));
    const tools = [];
    if (!state.graded && !state.timer) {
      tools.push(el("button", { type: "button", class: "link", text: state.open[i] ? "해설 접기" : "정답·해설 보기", onclick: () => { state.open[i] = !state.open[i]; renderSheet(); } }));
    }
    // 내가 만든 시험지면 이 문제만 새로 받기
    const own = !state.timer && curExamId && curExamId !== NOTE_ID && Number.isInteger(q._i) ? ownRequest(curExamId) : null;
    if (own?.reusable) {
      const busy = regenPending(curExamId);
      if (busy && busy.regen_idx === q._i) tools.push(el("span", { class: "q-busy", text: (busy.status === "working" && busy.progress ? busy.progress.replace(/문항 \d+\/\d+ /, "") : "새 문제 만드는 중") + "…" }));
      else if (!busy) {
        const b = confirmButton("이 문제 다시", "새 문제로 바꿀까요?", () => regenQuestion(q, i));
        b.classList.add("q-regen");
        tools.push(b);
      }
    }
    const target = !state.timer ? reportTarget(q) : null;
    if (target) {
      tools.push(isReported(target) ? el("span", { class: "q-busy", text: "신고함" })
        : el("button", { type: "button", class: "link", text: state.reportOpen[i] ? "신고 닫기" : "문제 신고", onclick: () => { state.reportOpen[i] = !state.reportOpen[i]; renderSheet(); } }));
    }
    if (tools.length) art.append(el("div", { class: "q-tools" }, ...tools));
    if (target && state.reportOpen[i] && !isReported(target)) art.append(reportForm(q, i, target));
    return art;
  }

  /* ---------- 문제 신고 ---------- */
  const REPORT_REASONS = ["정답이 틀려요", "해설이 이상해요", "문제가 애매해요", "자료에 없는 내용", "기타"];
  function reportTarget(q) {
    const exam = q._exam || (curExamId !== NOTE_ID ? curExamId : null);
    return sb && !state.isExample && exam && UUID_RE.test(exam) && Number.isInteger(q._i) ? { exam, idx: q._i } : null;
  }
  const reportedKey = (t) => t.exam + ":" + t.idx;
  const isReported = (t) => load("gichul.reported", []).includes(reportedKey(t));
  function markReported(t) { store("gichul.reported", [reportedKey(t), ...load("gichul.reported", [])].slice(0, 500)); }
  function dropFromWrongs(q) {
    const key = q._key || qKey(q);
    const w = loadWrongs();
    const rest = w.filter((x) => x.key !== key);
    if (rest.length === w.length) return false;
    saveWrongs(rest); renderLib();
    return true;
  }
  function reportForm(q, i, t) {
    let reason = REPORT_REASONS[0];
    const note = el("textarea", { class: "report-note", maxlength: "500", rows: "2", placeholder: "어디가 이상한지 적어 주면 고치기 쉬워요 (선택)", "aria-label": "신고 내용" });
    const chips = el("div", { class: "seg", role: "radiogroup", "aria-label": "신고 이유" }, ...REPORT_REASONS.map((r, k) => {
      const inp = el("input", { type: "radio", name: "report" + i, value: r });
      inp.checked = k === 0;
      inp.addEventListener("change", () => { reason = r; });
      return el("label", null, inp, el("span", { text: r }));
    }));
    const send = el("button", { type: "button", class: "btn primary", text: "신고 보내기" });
    send.addEventListener("click", async () => {
      send.disabled = true;
      const { data, error } = await sb.rpc("report_question", { exam: t.exam, idx: t.idx, reason, note: note.value.trim() || null });
      if (error || !data) {
        send.disabled = false;
        setStatus(String(error?.message || "").includes("limit_report") ? "오늘은 신고를 더 보낼 수 없어요." : "신고를 보내지 못했어요. 잠시 후 다시 시도해 주세요.", true);
        return;
      }
      markReported(t);
      const dropped = dropFromWrongs(q);
      delete state.reportOpen[i];
      setStatus("신고했어요. 확인해서 고칠게요." + (dropped ? " 이 문제는 오답노트에서 뺐어요." : ""));
      renderSheet();
    });
    return el("div", { class: "report" },
      el("p", { class: "report-h", text: "이 문제의 어떤 점이 이상한가요?" }), chips, note,
      el("div", { class: "report-actions" }, send,
        el("button", { type: "button", class: "link", text: "닫기", onclick: () => { delete state.reportOpen[i]; renderSheet(); } })));
  }

  /* ---------- 시험 모드 (제한 시간) ---------- */
  let tickTimer = null;
  const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  const timeLeft = () => state.timer ? mmss(state.timer.endAt - Date.now()) : "";
  function timerPicker(ex) {
    const suggest = Math.min(120, Math.max(5, Math.round((ex.questions.length * 1.5) / 5) * 5));
    const opts = [...new Set([suggest, 10, 20, 30, 50, 60])].sort((a, b) => a - b);
    return el("div", { class: "timer-pick" },
      el("p", { text: "제한 시간을 고르면 바로 시작해요. 시간이 끝나면 자동으로 채점하고, 그 전에는 해설을 볼 수 없어요." }),
      el("div", { class: "seg" }, ...opts.map((m) => el("button", { type: "button", class: "chip" + (m === suggest ? " on" : ""), onclick: () => startTimer(m) }, `${m}분`, m === suggest ? el("small", { text: " 추천" }) : null))));
  }
  function startTimer(mins) {
    const now = Date.now();
    state.timer = { endAt: now + mins * 60000, startedAt: now, mins };
    state.timerPick = false; state.answers = {}; state.self = {}; state.open = {}; state.reportOpen = {}; state.elapsed = null;
    persist(); renderAll(); ensureTick();
    $("sheet").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function ensureTick() {
    clearInterval(tickTimer);
    if (!state.timer) return;
    const tick = () => {
      if (!state.timer) { clearInterval(tickTimer); return; }
      const left = state.timer.endAt - Date.now();
      document.querySelectorAll(".timer-left").forEach((n) => { n.textContent = mmss(left); n.classList.toggle("low", left < 60000); });
      if (left <= 0) { clearInterval(tickTimer); grade(); setStatus("시간이 끝나서 자동으로 채점했어요."); }
    };
    tick();
    tickTimer = setInterval(tick, 1000);
  }

  /* ---------- 친구와 점수 비교 ---------- */
  const realExam = () => !!sb && !state.isExample && !!curExamId && curExamId !== NOTE_ID;
  function myPlayer() {
    let p = load("gichul.player", null);
    if (!p || !UUID_RE.test(p)) { p = crypto.randomUUID(); store("gichul.player", p); }
    return p;
  }
  async function loadRank() {
    if (!realExam()) return;
    const exam = curExamId;
    state.rank = { list: null, submitted: false };
    const { data, error } = await sb.rpc("get_scores", { exam });
    if (curExamId !== exam || !state.rank) return;
    state.rank.list = error ? [] : data || [];
    state.rank.submitted = state.rank.list.some((r) => r.player === myPlayer());
    if (state.graded) renderSheet();
  }
  function renderRank() {
    const rk = state.rank || { list: null };
    const s = score();
    const me = myPlayer();
    const pending = state.exam.questions.filter((q, i) => (q.type === "short" || q.type === "essay") && state.self[i] == null).length;
    const nick = el("input", { type: "text", class: "rank-nick", maxlength: "12", placeholder: "닉네임", "aria-label": "닉네임", value: load("gichul.nick", "") });
    const send = el("button", { type: "button", class: "btn primary", text: rk.submitted ? "점수 다시 올리기" : "내 점수 올리기" });
    send.addEventListener("click", async () => {
      const name = nick.value.trim();
      if (!name) { nick.focus(); setStatus("닉네임을 적어 주세요.", true); return; }
      send.disabled = true;
      const { data, error } = await sb.rpc("submit_score", { exam: curExamId, who: me, nick: name, got: s.got, total: s.total });
      if (error || !data) {
        send.disabled = false;
        setStatus(String(error?.message || "").includes("limit_score") ? "이 기기에서 올린 점수가 너무 많아요." : "점수를 올리지 못했어요.", true);
        return;
      }
      store("gichul.nick", name);
      setStatus("순위에 올렸어요. 같은 사람은 최고 점수만 남아요.");
      loadRank();
    });
    const list = rk.list;
    return el("section", { class: "rank" },
      el("div", { class: "rank-head" },
        el("h3", { text: "이 시험지 순위" }),
        el("span", { class: "rank-sub", text: "시험지 링크를 받은 사람끼리만 보여요" })),
      list === null ? el("p", { class: "rank-sub", text: "불러오는 중…" })
        : list.length ? el("ol", { class: "rank-list" }, ...list.slice(0, 10).map((r, k) => el("li", { class: r.player === me ? "me" : "" },
          el("span", { class: "rk", text: String(k + 1) }), el("span", { class: "nm", text: r.name + (r.player === me ? " (나)" : "") }),
          el("span", { class: "sc", text: `${r.got} / ${r.total}점` }))))
        : el("p", { class: "rank-sub", text: "아직 아무도 올리지 않았어요. 첫 번째로 올리고 링크를 친구에게 보내 보세요." }),
      el("div", { class: "rank-form" }, nick, send,
        el("span", { class: "rank-sub", text: `${s.got} / ${s.total}점` + (pending ? ` · 자가채점 ${pending}문항 남음` : "") })));
  }

  /* ---------- 인쇄 · PDF ---------- */
  async function printSheet(withKey) {
    if (!state.exam) return;
    state.printKey = withKey;
    document.body.classList.toggle("print-key", withKey);
    renderSheet();
    // 그림이 다 불러와진 뒤 인쇄 (최대 3초 기다림)
    const imgs = [...$("sheet").querySelectorAll("img")];
    imgs.forEach((img) => { img.loading = "eager"; });
    await Promise.race([
      Promise.all(imgs.map((img) => img.complete ? null : new Promise((r) => { img.addEventListener("load", r, { once: true }); img.addEventListener("error", r, { once: true }); }))),
      new Promise((r) => setTimeout(r, 3000))
    ]);
    document.title = (state.exam.title || "기추리 시험지") + (withKey ? " (정답 포함)" : "");
    window.print();
  }
  window.addEventListener("afterprint", () => {
    if (state.printKey == null) return;
    state.printKey = null;
    document.body.classList.remove("print-key");
    document.title = BASE_TITLE;
    renderSheet();
  });

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
      $("scoreSub").textContent = `/ ${s.total}점` + (state.elapsed != null ? ` · ${mmss(state.elapsed)} 걸림` : "") + (pending ? ` · 서술·단답 ${pending}문항 자가채점 남음` : "");
    } else {
      const done = Object.keys(state.answers).filter((k) => state.answers[k] !== "" && state.answers[k] != null).length;
      $("scoreBig").textContent = `${done}/${ex.questions.length}`;
      $("scoreSub").replaceChildren(...(state.timer ? ["남은 시간 ", el("b", { class: "timer-left", text: timeLeft() })] : ["답을 고른 뒤 채점하세요"]));
    }
    $("grade").textContent = state.graded ? "다시 풀기" : state.timer ? "시험 끝내기" : "채점하기";
    $("mGrade").textContent = $("grade").textContent;
    const prog = $("mProg");
    if (state.graded) prog.replaceChildren("점수 ", el("b", { text: String(s.got) }), ` / ${s.total}점`);
    else if (state.timer) prog.replaceChildren("⏱ ", el("b", { class: "timer-left", text: timeLeft() }), ` · ${$("scoreBig").textContent}`);
    else prog.replaceChildren("푼 문항 ", el("b", { text: $("scoreBig").textContent }));
    $("showAll").hidden = state.graded || !!state.timer;
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
  // 채점하기 ↔ 다시 풀기 (시험 모드에서는 '시험 끝내기'와 시간 종료도 여기로)
  function grade() {
    if (!state.exam) return;
    if (state.graded) {
      // 오답노트를 다시 풀면 맞혀서 넘어간 문제를 뺀 새 노트로 시작
      if (curExamId === NOTE_ID) {
        if (openWrongNote()) return;
        state.exam = EXAMPLE; state.isExample = true; curExamId = null;
      }
      resetRun(); persist();
    } else {
      if (state.timer) { state.elapsed = Math.min(Date.now(), state.timer.endAt) - state.timer.startedAt; state.timer = null; clearInterval(tickTimer); }
      state.graded = true;
      state.timerPick = false;
      state.round = Date.now();
      persist();
      recordResults();
      loadRank();
    }
    renderAll();
    if (state.graded) $("sheet").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  $("grade").addEventListener("click", grade);
  $("print").addEventListener("click", () => printSheet(false));
  $("printKey").addEventListener("click", () => printSheet(true));
  $("mGrade").addEventListener("click", () => $("grade").click());
  $("mOmr").addEventListener("click", () => document.querySelector(".omr").scrollIntoView({ behavior: "smooth", block: "start" }));
  $("showAll").addEventListener("click", () => {
    if (!state.exam) return;
    const allOpen = state.exam.questions.every((_, i) => state.open[i]);
    state.exam.questions.forEach((_, i) => { state.open[i] = !allOpen; });
    $("showAll").textContent = allOpen ? "해설 모두 보기" : "해설 모두 접기";
    renderSheet();
  });
  $("reset").addEventListener("click", () => { resetRun(); persist(); renderAll(); });
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
  if (state.timer) ensureTick(); // 시험 모드 중에 새로고침했으면 이어서 (시간이 지났으면 바로 채점)
  renderFiles();
  renderLib();
  initAuth();
  refresh().then(openFromLink);
})();
