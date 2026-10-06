// 기출 출제실 대기열 도구 (NAS 컨테이너용)
// runner.mjs 가 함수로 가져다 쓰고, 손으로도 쓸 수 있다:
//   node queue.mjs list | fail <id> <사유> | cleanup
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
  const got = await call("PATCH", `/requests?id=eq.${id}&status=eq.pending`, { status: "working", progress: "자료 읽는 중", started_at: new Date().toISOString() });
  if (!got.length) return null;
  const [row] = await call("GET", `/requests?id=eq.${id}&select=instructions,material,images,retry_of,regen_exam,regen_idx`);
  return row;
}

/** 시험지 문제 목록 */
export async function examQuestions(examId) {
  const [e] = await call("GET", `/exams?id=eq.${examId}&select=questions`);
  return e?.questions || null;
}

/** '이 문제만 다시': 시험지의 idx번 문제를 바꾸고 요청을 완료로 */
export async function finishRegen(id, examId, idx, question) {
  const qs = await examQuestions(examId);
  if (!qs || idx < 0 || idx >= qs.length) throw new Error("바꿀 시험지·문제를 찾지 못함");
  qs[idx] = question;
  await call("PATCH", `/exams?id=eq.${examId}`, { questions: qs });
  await call("PATCH", `/requests?id=eq.${id}`, { status: "done", exam_id: examId, progress: null, material: "", images: null, finished_at: new Date().toISOString() });
}

/** 다시 출제한 요청이면, 앞서 같은 자료로 낸 시험지들의 문제 (최대 5번 거슬러 올라감) */
export async function earlierQuestions(retryOf) {
  const out = [];
  let id = retryOf;
  for (let depth = 0; id && depth < 5; depth++) {
    const [r] = await call("GET", `/requests?id=eq.${id}&select=exam_id,retry_of`);
    if (!r) break;
    if (r.exam_id) {
      const [e] = await call("GET", `/exams?id=eq.${r.exam_id}&select=questions`);
      for (const q of e?.questions || []) if (q?.question) out.push(String(q.question));
    }
    id = r.retry_of;
  }
  return out;
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
  // 자료(material)는 "같은 자료로 다시 출제"를 위해 남겨 둠 → 14일 뒤 purge_old_requests 가 비움
  await call("PATCH", `/requests?id=eq.${id}`, { status: "done", exam_id: saved.id, progress: null, finished_at: new Date().toISOString() });
  return saved.id;
}

export async function failReq(id, reason, detail) {
  await call("PATCH", `/requests?id=eq.${id}`, {
    status: "error", error: String(reason || "출제 실패").slice(0, 200), progress: null,
    finished_at: new Date().toISOString(), fail_detail: detail ? String(detail).slice(0, 1000) : null
  });
}

/** 처리기가 살아 있다는 표시 (관리자 화면용) */
export async function heartbeat(info) {
  await call("PATCH", "/worker_status?id=eq.1", { seen_at: new Date().toISOString(), info });
}

/* ---------- 하루 한 번 청소 ---------- */
async function rpc(name, body = {}) {
  return call("POST", "/rpc/" + name, body);
}
async function removeObjects(bucket, paths) {
  for (let i = 0; i < paths.length; i += 100) {
    const res = await fetch(`${URL_}/storage/v1/object/${bucket}`, {
      method: "DELETE", headers: storageHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ prefixes: paths.slice(i, i + 100) })
    });
    if (!res.ok) throw new Error(`${bucket} 지우기 실패 ${res.status} ${await res.text()}`);
  }
}
/** 14일 지난 요청의 자료를 비우고, 어디에서도 안 쓰는 그림 파일을 지움. 지운 개수를 돌려줌 */
export async function cleanup(keepDays = 14) {
  const purged = await rpc("purge_old_requests", { keep_days: keepDays });
  const targets = await rpc("cleanup_targets");
  const byBucket = {};
  for (const t of targets || []) (byBucket[t.bucket] ||= []).push(t.name);
  for (const [bucket, paths] of Object.entries(byBucket)) await removeObjects(bucket, paths);
  return { purged, files: (targets || []).length };
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
    case "cleanup": {
      const r = await cleanup();
      return console.log(`자료 비운 요청 ${r.purged}개, 지운 그림 ${r.files}개`);
    }
    default:
      throw new Error(`알 수 없는 명령: ${cmd} (list | fail | cleanup)`);
  }
}

if (process.argv[1]?.endsWith("queue.mjs")) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
}
