// 기출 출제실 처리기
// - 사이트가 보내는 실시간 알림("queue" 채널)을 받으면 바로, 아니면 POLL_SECONDS마다 대기열 확인
// - 요청마다 Claude를 한 번만 호출(자료+지시 → 시험지 JSON). 도구 왕복 없음
// - 쓰는 동안 "문항 n/N 작성 중"을 DB와 실시간 채널로 알림
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { pending, claim, finish, failReq, setProgress, stillWanted, resetStale, broadcast, downloadImage, uploadFigure, earlierQuestions, examQuestions, finishRegen, heartbeat, cleanup, SUPABASE_URL, SUPABASE_SECRET } from "./queue.mjs";

const INTERVAL = (parseInt(process.env.POLL_SECONDS, 10) || 30) * 1000;
const MAX_PARALLEL = parseInt(process.env.MAX_PARALLEL, 10) || 3;
const MODEL = process.env.CLAUDE_MODEL || "";
const RUN_TIMEOUT = 15 * 60 * 1000;
const RULES = readFileSync(new URL("./PROMPT.md", import.meta.url), "utf8");
const log = (...a) => console.log(new Date().toISOString(), ...a);
const running = new Set();
const short = (id) => id.slice(0, 8);

/* ---------- Claude 한 번 호출, 글이 써지는 대로 onText ---------- */
// content: Claude 메시지 내용 블록 배열 (글 + 그림)
function askClaude(content, onText, onSpawn, timeout = RUN_TIMEOUT) {
  return new Promise((resolve, reject) => {
    // 보안: 자료에 숨긴 지시문이 있어도 아무 도구도 못 쓰게 함
    // --tools "" = 기본 도구(명령 실행·파일 읽기 등) 전부 끔, --strict-mcp-config = 계정에 연결된 Google Drive 같은 외부 도구도 끔
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--max-turns", "1", "--tools", "", "--strict-mcp-config"];
    if (MODEL) args.push("--model", MODEL);
    // Windows(PC 테스트)에서는 claude.cmd 라 shell 이 필요
    const p = spawn("claude", args, { cwd: process.env.WORK_DIR || "/work", stdio: ["pipe", "pipe", "inherit"], shell: process.platform === "win32" });
    onSpawn?.(p);
    let buf = "", text = "", result = null;
    const timer = setTimeout(() => { p.kill("SIGTERM"); reject(new Error("시간 초과")); }, timeout);
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === "stream_event" && ev.event?.delta?.type === "text_delta") {
          text += ev.event.delta.text;
          onText(text);
        } else if (ev.type === "result") {
          result = ev;
        }
      }
    });
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("exit", (code) => {
      clearTimeout(timer);
      if (result && result.subtype === "success" && typeof result.result === "string") resolve(result.result);
      else if (text) resolve(text);
      else reject(new Error(`claude 종료 코드 ${code}${result ? " (" + result.subtype + ")" : ""}`));
    });
    p.stdin.end(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
  });
}

function parseExam(raw) {
  let s = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("JSON을 찾지 못함");
  const exam = JSON.parse(s.slice(a, b + 1));
  if (!Array.isArray(exam.questions) || !exam.questions.length) throw new Error("questions 가 비어 있음");
  return exam;
}

/* ---------- 문제에 붙일 그림 ---------- */
function validCrop(c) {
  if (!Array.isArray(c) || c.length !== 4 || c.some((v) => typeof v !== "number" || !isFinite(v))) return null;
  const pad = 0.01; // Claude가 잡은 영역에서 아주 조금만 넓힘 (넓히면 슬라이드 제목·바닥글이 딸려 들어옴)
  let [x0, y0, x1, y1] = c.map((v) => Math.min(1, Math.max(0, v)));
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (y1 < y0) [y0, y1] = [y1, y0];
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(1, x1 + pad); y1 = Math.min(1, y1 + pad);
  if (x1 - x0 < 0.08 || y1 - y0 < 0.05) return null;
  if (x0 === 0 && y0 === 0 && x1 === 1 && y1 === 1) return null;
  return [x0, y0, x1, y1].map((v) => Math.round(v * 1000) / 1000);
}

/* 그림 영역 다듬기: 시험지 전체를 쓰는 동안 잡은 영역은 엉성해서(슬라이드 제목·바닥글이 딸려 옴),
   그림 문항마다 그 쪽 이미지 하나와 문제만 따로 보여 주고 영역을 다시 받음. 실패하면 처음 영역을 그대로 씀 */
const CROP_RULE = [
  "figure_crop은 그림 자체만 딱 맞게 잡으세요. 그래프라면 축·축 이름·눈금 숫자·범례·그림 안의 화살표와 라벨까지가 그림입니다.",
  "다음은 빼세요: 슬라이드 제목, 그림 위아래의 설명 문장·글머리표(•) 목록, 학교 이름·로고, 과목명, 쪽 번호, 머리글·바닥글, 문제와 상관없는 다른 그림,",
  "그리고 출처·인용·저작권 문구(예: \"Adapted from Fig. …\", \"Data obtained from …\", \"copyright …\", \"Callister …\" 같은 작은 글 덩어리).",
  "영역 경계가 글자를 반쯤 자르지 않게 하세요. 바깥쪽 여유는 1% 정도만 두세요.",
  "figure_crop 안에 어쩔 수 없이 남는 위 같은 글 덩어리(그래프 안쪽에 붙은 출처 문구 등)는 hide 목록에 그 글 덩어리를 감싸는 네모를 넣으세요. 시험지에서 흰색으로 가려집니다.",
  "hide는 그림의 선·점·사진·축·라벨을 덮으면 안 됩니다. 가릴 게 없으면 빈 목록 []. 정답이 그림 속 글자로 그대로 적혀 있으면 그 부분도 hide에 넣으세요."
].join("\n");
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const isBox = (b) => Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === "number" && isFinite(v));
function parseCropReply(raw) {
  const s = String(raw), a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b < a) return null;
  try {
    const o = JSON.parse(s.slice(a, b + 1));
    if (!isBox(o.figure_crop)) return null;
    const hide = (Array.isArray(o.hide) ? o.hide : []).filter(isBox).slice(0, 4)
      .map((h) => h.map(clamp01)).filter(([x0, y0, x1, y1]) => x1 - x0 > 0.01 && y1 - y0 > 0.01 && (x1 - x0) * (y1 - y0) < 0.25);
    return { crop: o.figure_crop, hide };
  } catch { return null; }
}
async function refineCrops(exam, bufs, isCancelled) {
  const jobs = exam.questions.filter((q) => bufs.has(parseInt(q.figure, 10))).slice(0, 8);
  let fixed = 0;
  await Promise.all(jobs.map(async (q) => {
    if (isCancelled()) return;
    const choices = Array.isArray(q.choices) ? "\n보기: " + q.choices.join(" / ") : "";
    const content = [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: bufs.get(parseInt(q.figure, 10)).toString("base64") } },
      { type: "text", text: `위 이미지는 강의자료 한 쪽입니다. 아래 시험 문제에 붙일 그림 영역을 잡아 주세요.\n[문제] ${String(q.question || "").slice(0, 500)}${choices.slice(0, 400)}\n\n${CROP_RULE}\n\nJSON 하나만 출력: {"figure_crop":[왼쪽,위,오른쪽,아래],"hide":[[왼쪽,위,오른쪽,아래]]} (모두 이미지 전체 기준 0~1 비율, 소수 둘째 자리까지)` }
    ];
    try {
      const r = parseCropReply(await askClaude(content, () => {}, () => {}, 90 * 1000));
      if (r && validCrop(r.crop)) { q.figure_crop = r.crop; q.figure_hide = r.hide; fixed++; }
    } catch (e) { log("그림 영역 다듬기 실패:", e.message); }
  }));
  return fixed;
}

// 문항의 "figure": n 을 시험지용 공개 저장소의 그림으로 바꿈. 붙인 그림 수를 돌려줌
async function attachFigures(exam, bufs) {
  const folder = crypto.randomUUID();
  const uploaded = new Map();
  for (const q of exam.questions) {
    const n = parseInt(q.figure, 10);
    const crop = validCrop(q.figure_crop);
    // 가릴 칸이 잘라 낸 영역의 가장자리에 닿아 있으면 바깥 여유(pad)까지 늘림 → 경계에 글자 조각이 남지 않게
    const raw = Array.isArray(q.figure_crop) ? q.figure_crop : [0, 0, 1, 1];
    const near = (a, b) => Math.abs(a - b) < 0.025;
    const hide = Array.isArray(q.figure_hide) && q.figure_hide.length ? q.figure_hide.map(([x0, y0, x1, y1]) => [
      near(x0, raw[0]) ? 0 : x0, near(y0, raw[1]) ? 0 : y0, near(x1, raw[2]) ? 1 : x1, near(y1, raw[3]) ? 1 : y1
    ].map((v) => Math.round(v * 1000) / 1000)) : null;
    delete q.figure_crop; delete q.figure_hide;
    if (!bufs.has(n)) { delete q.figure; continue; }
    try {
      if (!uploaded.has(n)) {
        const path = `${folder}/${String(n).padStart(2, "0")}.jpg`;
        await uploadFigure(path, bufs.get(n));
        uploaded.set(n, path);
      }
      q.figure = { path: uploaded.get(n), crop, ...(hide ? { hide } : {}) };
    } catch (e) {
      log("그림 올리기 실패:", e.message);
      delete q.figure;
    }
  }
  return uploaded.size;
}

/* ---------- 요청 하나 처리 ---------- */
async function handle(id) {
  running.add(id);
  const started = Date.now();
  // 사용자가 요청을 취소하면(행 삭제) Claude를 바로 멈춰 사용량을 아낌
  let cancelled = false, proc = null;
  const imgBufs = new Map();
  const cancel = () => { if (cancelled) return; cancelled = true; log(`[${short(id)}] 사용자가 취소함 → 중단`); proc?.kill("SIGTERM"); };
  const watcher = setInterval(() => { stillWanted(id).then((ok) => { if (!ok) cancel(); }).catch(() => {}); }, 5000);
  try {
    const row = await claim(id);
    if (!row) return; // 다른 처리기가 이미 가져감
    const regen = row.regen_exam ? { examId: row.regen_exam, idx: row.regen_idx } : null;
    const total = regen ? 1 : parseInt((row.instructions.match(/정확히\s*(\d+)\s*문항/) || [])[1], 10) || 0;
    await broadcast("req-" + id, "update", { status: "working", progress: "자료 읽는 중" });
    log(`[${short(id)}] ${regen ? `문제 하나 다시 (${regen.idx + 1}번)` : `출제 시작 (${total || "?"}문항)`}`);

    let retryNote = "";
    if (regen) {
      // 이 문제만 다시: 지금 시험지를 보여 주고 idx번 하나만 새로 만들게 함
      const qs = await examQuestions(regen.examId);
      const old = qs?.[regen.idx];
      if (!old) throw new Error("바꿀 문제를 찾지 못함");
      const list = qs.map((q, k) => `${k + 1}. ${String(q.question || "").replace(/\s+/g, " ").slice(0, 160)}`).join("\n");
      retryNote = `\n\n[문제 하나만 다시] 위 출제 조건의 문항 수는 무시하고, 아래 시험지의 ${regen.idx + 1}번 문제를 대신할 새 문제 **1개만** 만드세요.\n- 유형은 원래 문제와 같은 "${old.type}"로.\n- 원래 문제와 다른 개념이나 다른 각도로, 시험지의 다른 문제와도 겹치지 않게.\n- 출력 형식은 같고 questions 배열에 문제 1개만 넣으세요.\n[지금 시험지]\n${list}\n[바꿀 문제] ${regen.idx + 1}번: ${String(old.question || "").slice(0, 400)}`;
    } else if (row.retry_of) {
      // 같은 자료로 다시 출제한 요청이면 앞서 낸 문제와 겹치지 않게
      const prev = await earlierQuestions(row.retry_of).catch(() => []);
      if (prev.length) {
        const list = prev.slice(0, 80).map((q) => "- " + q.replace(/\s+/g, " ").slice(0, 160)).join("\n");
        retryNote = `\n\n[다시 출제] 이 학생은 같은 자료로 이미 아래 문제를 풀었습니다. 이 문제들과 겹치지 않게, 아직 묻지 않은 개념이나 다른 각도·다른 수치로 새 문제를 만드세요. 시험지 제목도 앞의 것과 구분되게 정하세요.\n${list}`;
        log(`[${short(id)}] 다시 출제 (앞서 낸 문제 ${prev.length}개 피함)`);
      }
    }

    const content = [];
    for (const im of row.images || []) {
      try {
        const buf = await downloadImage(im.path);
        imgBufs.set(parseInt(im.path.split("/").pop(), 10), buf); // 파일 이름 = 이미지 번호
        content.push({ type: "text", text: im.label }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: buf.toString("base64") } });
      } catch (e) { log(`[${short(id)}] ${e.message}`); }
    }
    const nImg = content.length / 2;
    if (nImg) log(`[${short(id)}] 그림 ${nImg}장 함께 보냄`);
    content.push({ type: "text", text: `${RULES}\n\n${row.instructions}${retryNote}\n\n[공부자료 원문]\n${row.material}${nImg ? `\n\n[첨부 이미지] 위에 자료 속 그림 ${nImg}장을 붙였습니다. 본문의 "[이 쪽의 그림: 첨부 이미지 #n]" 표시와 이미지 이름으로 어느 쪽 그림인지 알 수 있습니다.` : ""}\n\n[다시 한 번] 위 형식의 JSON 하나만 출력하세요.` });
    let lastShown = 0, lastDb = 0, lastCount = -1;
    const onText = (text) => {
      const n = (text.match(/"question"\s*:/g) || []).length;
      if (n === lastCount) return;
      lastCount = n;
      const now = Date.now();
      const label = total ? `문항 ${Math.min(n, total)}/${total} 작성 중` : `문항 ${n}개 작성 중`;
      if (now - lastShown > 800) { lastShown = now; broadcast("req-" + id, "update", { status: "working", progress: label }); }
      if (now - lastDb > 4000) { lastDb = now; setProgress(id, label).then((ok) => { if (!ok) cancel(); }).catch(() => {}); }
    };

    let exam, lastErr;
    for (let attempt = 1; attempt <= 2 && !exam && !cancelled; attempt++) {
      try { exam = parseExam(await askClaude(content, onText, (p) => { proc = p; })); }
      catch (e) { lastErr = e; if (!cancelled) log(`[${short(id)}] ${attempt}번째 시도 실패: ${e.message}`); }
    }
    if (cancelled || !(await stillWanted(id))) { cancelled = true; return; }
    if (!exam) throw lastErr;

    const target = regen ? { questions: exam.questions.slice(0, 1) } : exam;
    if (/\[그림 없이\]/.test(row.instructions)) {
      // 출제 조건에서 '문제에 그림 넣기: 빼기'를 고른 요청
      for (const q of target.questions) { delete q.figure; delete q.figure_crop; }
    } else if (target.questions.some((q) => imgBufs.has(parseInt(q.figure, 10)))) {
      broadcast("req-" + id, "update", { status: "working", progress: "그림 다듬는 중" });
      setProgress(id, "그림 다듬는 중").catch(() => {});
      const fixed = await refineCrops(target, imgBufs, () => cancelled);
      if (fixed) log(`[${short(id)}] 그림 영역 ${fixed}개 다시 잡음`);
      if (cancelled || !(await stillWanted(id))) { cancelled = true; return; }
    }

    if (regen) {
      const one = target;
      await attachFigures(one, imgBufs);
      await finishRegen(id, regen.examId, regen.idx, one.questions[0]);
      await broadcast("req-" + id, "update", { status: "done", exam_id: regen.examId });
      log(`[${short(id)}] 완료 (${regen.idx + 1}번 문제 교체, ${Math.round((Date.now() - started) / 1000)}초)`);
      return;
    }
    const figs = await attachFigures(exam, imgBufs);
    if (figs) log(`[${short(id)}] 문제에 그림 ${figs}장 붙임`);
    const examId = await finish(id, exam);
    await broadcast("req-" + id, "update", { status: "done", exam_id: examId });
    log(`[${short(id)}] 완료 (${exam.questions.length}문항, ${Math.round((Date.now() - started) / 1000)}초)`);
  } catch (e) {
    if (!cancelled) {
      log(`[${short(id)}] 실패: ${e.message}`);
      await failReq(id, "출제 중 오류가 났어요. 다시 시도해 주세요.", e?.message).catch(() => {});
      await broadcast("req-" + id, "update", { status: "error" });
    }
  } finally {
    clearInterval(watcher);
    // 그림은 "다시 출제"에 쓰도록 남겨 둠 → 하루 한 번 청소(cleanup)가 안 쓰는 것을 지움
    running.delete(id);
    kick(); // 자리가 났으니 남은 요청 확인
  }
}

/* ---------- 대기열 확인 (실시간 알림 또는 주기) ---------- */
let wake = null, checking = false, lastStaleCheck = 0, lastBeat = 0, lastCleanup = 0;
function kick() { if (wake) wake(); }
const BOOTED = new Date().toISOString();

async function housekeeping() {
  const now = Date.now();
  if (now - lastBeat > 5 * 60 * 1000) {
    lastBeat = now;
    heartbeat({ running: running.size, max: MAX_PARALLEL, since: BOOTED, model: MODEL || "기본" }).catch((e) => log("상태 기록 실패:", e.message));
  }
  // 시작 1분 뒤 한 번, 그다음은 하루에 한 번
  if (!lastCleanup) lastCleanup = now - 24 * 3600 * 1000 + 60 * 1000;
  if (now - lastCleanup > 24 * 3600 * 1000) {
    lastCleanup = now;
    cleanup().then((r) => log(`청소: 자료 비운 요청 ${r.purged}개, 지운 그림 ${r.files}개`)).catch((e) => log("청소 실패:", e.message));
  }
}

async function check() {
  if (checking) return;
  checking = true;
  housekeeping();
  try {
    if (Date.now() - lastStaleCheck > 5 * 60 * 1000) {
      lastStaleCheck = Date.now();
      const n = await resetStale().catch(() => 0);
      if (n) log(`멈춰 있던 요청 ${n}개를 다시 대기열로`);
    }
    if (running.size < MAX_PARALLEL) {
      for (const r of await pending()) {
        if (running.size >= MAX_PARALLEL) break;
        if (!running.has(r.id)) handle(r.id);
      }
    }
  } catch (e) {
    log("확인 실패:", e.message);
  } finally {
    checking = false;
  }
}

const sb = createClient(SUPABASE_URL, SUPABASE_SECRET, { auth: { persistSession: false } });
sb.channel("queue")
  .on("broadcast", { event: "new" }, () => kick())
  .subscribe((status) => log("실시간 알림:", status));

log(`처리기 시작 (실시간 알림 + ${INTERVAL / 1000}초 간격 확인, 동시 ${MAX_PARALLEL}개${MODEL ? ", 모델 " + MODEL : ""})`);

for (;;) {
  await check();
  await new Promise((r) => { wake = r; setTimeout(r, INTERVAL); });
  wake = null;
}
