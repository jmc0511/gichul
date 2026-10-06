// 기출 출제실 대기열 도구 (NAS 컨테이너용)
// runner.mjs 가 함수로 가져다 쓰고, 손으로도 쓸 수 있다:
//   node queue.mjs list | fail <id> <사유>
// 환경변수: SUPABASE_URL, SUPABASE_SECRET

const URL_ = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SECRET || "";
if (!URL_ || !KEY) { console.error("SUPABASE_URL / SUPABASE_SECRET 환경변수가 필요합니다"); process.exit(2); }

export const SUPABASE_URL = URL_;
export const SUPABASE_SECRET = KEY;

function headers() {
  const h = {
    apikey: KEY,
    "Content-Type": "application/json",
    Prefer: "return=representation",
    // 브라우저처럼 보이면 Supabase가 비밀 키를 거부함
    "User-Agent": "gichul-queue/1.0"
  };
  if (KEY.startsWith("eyJ")) h.Authorization = "Bearer " + KEY;
  return h;
}

async function call(method, path, body) {
  const res = await fetch(URL_ + "/rest/v1" + path, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

export async function pending() {
  return call("GET", "/requests?status=eq.pending&select=id,created_at,subject,files,pages&order=created_at.asc");
}

/** 요청을 '출제 중'으로 잡고 지시·자료를 돌려줌. 이미 다른 곳이 잡았으면 null */
export async function claim(id) {
  const got = await call("PATCH", `/requests?id=eq.${id}&status=eq.pending`, { status: "working", progress: "자료 읽는 중" });
  if (!got.length) return null;
  const [row] = await call("GET", `/requests?id=eq.${id}&select=instructions,material,images`);
  return row;
}

/* ---------- 요청에 딸린 그림 (Storage: request-images) ---------- */
const BUCKET = "request-images";
function storageHeaders(extra = {}) {
  const h = { apikey: KEY, "User-Agent": "gichul-queue/1.0", ...extra };
  if (KEY.startsWith("eyJ")) h.Authorization = "Bearer " + KEY;
  return h;
}

export async function downloadImage(path) {
  const res = await fetch(`${URL_}/storage/v1/object/${BUCKET}/${path}`, { headers: storageHeaders() });
  if (!res.ok) throw new Error(`그림 받기 실패 ${res.status} ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

/** 시험지용 그림 저장소(exam-figures, 공개 주소)에 올림 */
export async function uploadFigure(path, buf) {
  const res = await fetch(`${URL_}/storage/v1/object/exam-figures/${path}`, {
    method: "POST", headers: storageHeaders({ "Content-Type": "image/jpeg", "x-upsert": "true" }), body: buf
  });
  if (!res.ok) throw new Error(`그림 올리기 실패 ${res.status} ${await res.text()}`);
}

export async function deleteImages(paths) {
  if (!paths?.length) return;
  try {
    await fetch(`${URL_}/storage/v1/object/${BUCKET}`, {
      method: "DELETE", headers: storageHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ prefixes: paths })
    });
  } catch (e) {}
}

/** 30분 넘게 '출제 중'에 멈춘 요청만 다시 대기로 돌림 (다른 처리기가 작업 중인 건 건드리지 않음) */
export async function resetStale() {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const rows = await call("PATCH", `/requests?status=eq.working&created_at=lt.${encodeURIComponent(cutoff)}`, { status: "pending", progress: null });
  return rows.length;
}

/** 진행 상황 기록. 요청이 취소(삭제)됐으면 false */
export async function setProgress(id, progress) {
  const rows = await call("PATCH", `/requests?id=eq.${id}&status=eq.working`, { progress });
  return rows.length > 0;
}

/** 요청이 아직 살아 있는지 (사용자가 취소하면 행이 지워짐) */
export async function stillWanted(id) {
  const rows = await call("GET", `/requests?id=eq.${id}&select=id`);
  return rows.length > 0;
}

export async function finish(id, exam) {
  const [saved] = await call("POST", "/exams", { request_id: id, title: String(exam.title || "예상 기출문제"), subject: String(exam.subject || ""), questions: exam.questions });
  await call("PATCH", `/requests?id=eq.${id}`, { status: "done", exam_id: saved.id, material: "", progress: null });
  return saved.id;
}

export async function failReq(id, reason) {
  await call("PATCH", `/requests?id=eq.${id}`, { status: "error", error: String(reason || "출제 실패").slice(0, 200), progress: null });
}

/** 사이트에 바로 알림 (실패해도 사이트가 주기적으로 확인하므로 무시) */
export async function broadcast(topic, event, payload) {
  try {
    await fetch(URL_ + "/realtime/v1/api/broadcast", {
      method: "POST", headers: headers(),
      body: JSON.stringify({ messages: [{ topic, event, payload }] })
    });
  } catch (e) {}
}

async function main([cmd, id, arg]) {
  switch (cmd) {
    case "list": {
      const rows = await pending();
      if (!rows.length) return console.log("대기 중인 요청 없음");
      for (const r of rows) console.log(`${r.id}  ${r.created_at}  ${r.pages}쪽  ${r.subject || (r.files || []).join(", ")}`);
      return;
    }
    case "fail":
      await failReq(id, arg);
      return console.log("실패 처리: " + id);
    default:
      throw new Error(`알 수 없는 명령: ${cmd} (list | fail)`);
  }
}

if (process.argv[1]?.endsWith("queue.mjs")) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
}
