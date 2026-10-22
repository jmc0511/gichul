// Supabase 애플 로그인에 넣을 "Secret Key (for OAuth)" 를 만든다.
// 애플이 주는 .p8 키 파일은 이 컴퓨터에만 두고, 만들어진 긴 글자만 Supabase 에 붙여 넣는다.
// (애플 규칙상 최대 6개월짜리 — 만료되면 다시 만들어 Supabase 에 넣으면 된다)
//
//   node tool/apple-client-secret.mjs --p8 ~/Downloads/AuthKey_ABC123.p8 \
//     --team TEAM12345 --key ABC123 --services site.gichul.app.signin
import { readFileSync } from "node:fs";
import { createPrivateKey, sign } from "node:crypto";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
const need = ["p8", "team", "key", "services"];
const missing = need.filter((k) => !args[k]);
if (missing.length) {
  console.error(`빠진 값: ${missing.map((m) => "--" + m).join(", ")}`);
  console.error("예: node tool/apple-client-secret.mjs --p8 AuthKey_ABC123.p8 --team TEAM12345 --key ABC123 --services site.gichul.app.signin");
  process.exit(1);
}

const months = 6;
const now = Math.floor(Date.now() / 1000);
const exp = now + months * 30 * 24 * 60 * 60; // 애플 최대치(6개월)에 맞춤

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const head = b64({ alg: "ES256", kid: args.key });
const body = b64({
  iss: args.team,
  iat: now,
  exp,
  aud: "https://appleid.apple.com",
  sub: args.services,
});

const privateKey = createPrivateKey(readFileSync(args.p8, "utf8"));
const signature = sign("sha256", Buffer.from(`${head}.${body}`), {
  key: privateKey,
  dsaEncoding: "ieee-p1363", // JWT 는 DER 이 아니라 r|s 형식
}).toString("base64url");

console.log(`${head}.${body}.${signature}`);
console.error(`\n유효기간: ${new Date(exp * 1000).toLocaleDateString("ko-KR")} 까지`);
