// 시험지 완성 알림을 보내는 Supabase Edge Function.
//
// 부르는 쪽: Database Webhooks → public.requests 의 UPDATE
// 하는 일 : 요청이 done·error 가 되면 그 요청을 기다리던 기기(push_watch)로 FCM 알림을 보낸다.
//
// 설정값 (대시보드 > Edge Functions > Secrets):
//   FCM_SERVICE_ACCOUNT  Firebase 서비스 계정 키 JSON 통째로
//   PUSH_SECRET          웹훅 헤더 x-push-secret 과 같은 아무 문자열
// (SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY 는 Supabase 가 알아서 넣어 준다)
import { createClient } from "jsr:@supabase/supabase-js@2";

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
let cachedToken: { value: string; until: number } | null = null;

/** 서비스 계정으로 FCM 보낼 권한(액세스 토큰)을 받아 온다. 한 시간쯤 재사용. */
async function accessToken(account: Record<string, string>): Promise<string> {
  if (cachedToken && cachedToken.until > Date.now() + 60_000) return cachedToken.value;

  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: account.client_email,
    scope: FCM_SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const b64 = (data: string) =>
    btoa(data).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const head = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64(JSON.stringify(claim));

  const pem = account.private_key.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${head}.${body}`),
  );
  const jwt = `${head}.${body}.${
    b64(String.fromCharCode(...new Uint8Array(signature)))
  }`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`구글 토큰 실패: ${JSON.stringify(json)}`);
  cachedToken = { value: json.access_token, until: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return cachedToken.value;
}

/** 알림 문구. 사이트의 완료 알림과 같은 말투로. */
function message(record: Record<string, unknown>) {
  const ok = record.status === "done";
  const regen = record.regen_exam != null;
  const name = (record.subject as string) ||
    ((record.files as string[] | null) ?? []).join(", ") ||
    "요청한 시험지";
  if (!ok) {
    return { title: "출제에 실패했어요", body: `"${name}" 출제에 실패했어요. 문제집에서 다시 시도할 수 있어요.` };
  }
  if (regen) {
    return { title: "문제를 바꿨어요", body: `${Number(record.regen_idx ?? 0) + 1}번 문제를 새 문제로 바꿨어요.` };
  }
  return { title: "시험지가 완성됐어요", body: `"${name}" 시험지를 문제집에서 열어 보세요.` };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");

  const secret = Deno.env.get("PUSH_SECRET");
  if (secret && req.headers.get("x-push-secret") !== secret) {
    return new Response("no", { status: 401 });
  }

  const payload = await req.json().catch(() => null);
  const record = payload?.record as Record<string, unknown> | undefined;
  const before = payload?.old_record as Record<string, unknown> | undefined;
  if (!record?.id) return new Response("skip: no record");

  const status = record.status;
  if (status !== "done" && status !== "error") return new Response("skip: still working");
  if (before?.status === status) return new Response("skip: same status");

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data: watching, error } = await db
    .from("push_watch")
    .select("device")
    .eq("request_id", record.id);
  if (error) return new Response(`db: ${error.message}`, { status: 500 });
  if (!watching?.length) return new Response("skip: 기다리는 기기 없음");

  const account = JSON.parse(Deno.env.get("FCM_SERVICE_ACCOUNT")!);
  const token = await accessToken(account);
  const { title, body } = message(record);
  const send = `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`;
  const data = {
    exam_id: String(record.exam_id ?? ""),
    request_id: String(record.id),
    status: String(status),
  };

  const dead: string[] = [];
  for (const row of watching) {
    const res = await fetch(send, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          token: row.device,
          notification: { title, body },
          data,
          // 채널을 따로 만들지 않았으므로 FCM 기본 채널로 간다
          android: { priority: "HIGH", notification: { sound: "default" } },
          apns: {
            headers: { "apns-priority": "10" },
            payload: { aps: { sound: "default", badge: 1 } },
          },
        },
      }),
    });
    // 앱을 지웠거나 낡은 토큰(404 NOT_FOUND = UNREGISTERED)만 정리한다
    if (res.status === 404) dead.push(row.device);
    if (!res.ok) console.error("FCM", res.status, await res.text());
  }

  if (dead.length) await db.from("push_devices").delete().in("device", dead);
  // 이 요청은 끝났으니 더 지켜볼 필요가 없다
  await db.from("push_watch").delete().eq("request_id", record.id);

  return new Response(`보냄 ${watching.length - dead.length}/${watching.length}`);
});
