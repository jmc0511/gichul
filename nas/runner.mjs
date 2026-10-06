// 기출 출제실 처리기
// - 사이트가 보내는 실시간 알림("queue" 채널)을 받으면 바로, 아니면 POLL_SECONDS마다 대기열 확인
// - 요청마다 Claude를 한 번만 호출(자료+지시 → 시험지 JSON). 도구 왕복 없음
// - 쓰는 동안 "문항 n/N 작성 중"을 DB와 실시간 채널로 알림
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { pending, claim, finish, failReq, setProgress, stillWanted, resetStale, broadcast, downloadImage, deleteImages, uploadFigure, SUPABASE_URL, SUPABASE_SECRET } from "./queue.mjs";

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
function askClaude(content, onText, onSpawn) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--max-turns", "1"];
    if (MODEL) args.push("--model", MODEL);
    // Windows(PC 테스트)에서는 claude.cmd 라 shell 이 필요
    const p = spawn("claude", args, { cwd: process.env.WORK_DIR || "/work", stdio: ["pipe", "pipe", "inherit"], shell: process.platform === "win32" });
    onSpawn?.(p);
    let buf = "", text = "", result = null;
    const timer = setTimeout(() => { p.kill("SIGTERM"); reject(new Error("시간 초과")); }, RUN_TIMEOUT);
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
  const pad = 0.02;
  let [x0, y0, x1, y1] = c.map((v) => Math.min(1, Math.max(0, v)));
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (y1 < y0) [y0, y1] = [y1, y0];
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(1, x1 + pad); y1 = Math.min(1, y1 + pad);
  if (x1 - x0 < 0.08 || y1 - y0 < 0.05) return null;
  if (x0 === 0 && y0 === 0 && x1 === 1 && y1 === 1) return null;
  return [x0, y0, x1, y1].map((v) => Math.round(v * 1000) / 1000);
}

// 문항의 "figure": n 을 시험지용 공개 저장소의 그림으로 바꿈. 붙인 그림 수를 돌려줌
async function attachFigures(exam, bufs) {
  const folder = crypto.randomUUID();
  const uploaded = new Map();
  for (const q of exam.questions) {
    const n = parseInt(q.figure, 10);
    const crop = validCrop(q.figure_crop);
    delete q.figure_crop;
    if (!bufs.has(n)) { delete q.figure; continue; }
    try {
      if (!uploaded.has(n)) {
        const path = `${folder}/${String(n).padStart(2, "0")}.jpg`;
        await uploadFigure(path, bufs.get(n));
        uploaded.set(n, path);
      }
      q.figure = { path: uploaded.get(n), crop };
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
  let cancelled = false, proc = null, imagePaths = [];
  const imgBufs = new Map();
  const cancel = () => { if (cancelled) return; cancelled = true; log(`[${short(id)}] 사용자가 취소함 → 중단`); proc?.kill("SIGTERM"); };
  const watcher = setInterval(() => { stillWanted(id).then((ok) => { if (!ok) cancel(); }).catch(() => {}); }, 5000);
  try {
    const row = await claim(id);
    if (!row) return; // 다른 처리기가 이미 가져감
    const total = parseInt((row.instructions.match(/정확히\s*(\d+)\s*문항/) || [])[1], 10) || 0;
    await broadcast("req-" + id, "update", { status: "working", progress: "자료 읽는 중" });
    log(`[${short(id)}] 출제 시작 (${total || "?"}문항)`);

    imagePaths = (row.images || []).map((im) => im.path);
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
    content.push({ type: "text", text: `${RULES}\n\n${row.instructions}\n\n[공부자료 원문]\n${row.material}${nImg ? `\n\n[첨부 이미지] 위에 자료 속 그림 ${nImg}장을 붙였습니다. 본문의 "[이 쪽의 그림: 첨부 이미지 #n]" 표시와 이미지 이름으로 어느 쪽 그림인지 알 수 있습니다.` : ""}\n\n[다시 한 번] 위 형식의 JSON 하나만 출력하세요.` });
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

    const figs = await attachFigures(exam, imgBufs);
    if (figs) log(`[${short(id)}] 문제에 그림 ${figs}장 붙임`);
    const examId = await finish(id, exam);
    await broadcast("req-" + id, "update", { status: "done", exam_id: examId });
    log(`[${short(id)}] 완료 (${exam.questions.length}문항, ${Math.round((Date.now() - started) / 1000)}초)`);
  } catch (e) {
    if (!cancelled) {
      log(`[${short(id)}] 실패: ${e.message}`);
      await failReq(id, "출제 중 오류가 났어요. 다시 요청해 주세요.").catch(() => {});
      await broadcast("req-" + id, "update", { status: "error" });
    }
  } finally {
    clearInterval(watcher);
    deleteImages(imagePaths); // 끝났든 취소됐든 그림은 지움
    running.delete(id);
    kick(); // 자리가 났으니 남은 요청 확인
  }
}

/* ---------- 대기열 확인 (실시간 알림 또는 주기) ---------- */
let wake = null, checking = false, lastStaleCheck = 0;
function kick() { if (wake) wake(); }

async function check() {
  if (checking) return;
  checking = true;
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
