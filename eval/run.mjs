#!/usr/bin/env node
// 출제 평가셋 — 실행기
//
// 같은 자료·같은 조건을 돌려 두고, 프롬프트나 모델을 바꾼 뒤 다시 돌려 품질 변화를 숫자로 본다.
// 신고는 문항 1,901개에 14건이라 통계가 안 되고, 실제 요청의 자료는 14일 뒤 지워져서(purge_old_requests)
// 과거 요청으로는 다시 재현할 수 없다. 그래서 자료를 따로 붙잡아 둔다.
//
//   node eval/run.mjs              모든 케이스
//   node eval/run.mjs os_scheduling  케이스 하나
//
// 케이스 한 개 = eval/cases/<이름>/
//   material.txt      공부자료 원문 (사이트가 보내는 형식 그대로)
//   instructions.txt  출제 조건 (사이트의 buildInstructions 결과)
//   images/01.jpg …   (선택) 자료 속 그림. 파일 이름 숫자가 이미지 번호
//   images/labels.json(선택) {"1":"이미지 #1 (강의노트.pdf p.3)", …}
//
// 결과: eval/results/<케이스>/<시각>.exam.json
//
// 주의: NAS 처리기(nas/runner.mjs)와 **같은 규칙 파일·같은 호출 방식**을 쓴다.
//       runner.mjs 의 askClaude 인자나 content 조립이 바뀌면 여기도 같이 고쳐야 한다.
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CASES = join(HERE, "cases");
const RESULTS = join(HERE, "results");
// NAS 의 docker-compose.yml 과 같은 값으로 맞춘다.
// CLAUDE_MODEL= (빈 값) 으로 돌리면 --model 을 빼고 CLI 기본 모델로 돈다.
// 이 모델을 쓰려면 Claude Code 2.1.280 이상이 필요하다 ("claude update").
const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";
const TIMEOUT = 15 * 60 * 1000;

export function askClaude(content, timeout = TIMEOUT) {
  return new Promise((resolve, reject) => {
    // runner.mjs 와 같은 인자. --tools "" 로 자료 속 숨은 지시문이 도구를 못 쓰게 막는다
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--include-partial-messages", "--max-turns", "1", "--tools", "", "--strict-mcp-config"];
    if (MODEL) args.push("--model", MODEL);
    const p = spawn("claude", args, { stdio: ["pipe", "pipe", "inherit"] });
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
          process.stderr.write(".");
        } else if (ev.type === "result") result = ev;
      }
    });
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("exit", (code) => {
      clearTimeout(timer);
      process.stderr.write("\n");
      if (result && result.subtype === "success" && typeof result.result === "string") resolve(result.result);
      else if (text) resolve(text);
      else reject(new Error(`claude 종료 코드 ${code}${result ? " (" + result.subtype + ")" : ""}`));
    });
    p.stdin.end(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
  });
}

export function parseJson(raw) {
  const s = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  // 바깥 괄호가 { 인지 [ 인지 먼저 나오는 쪽으로 정한다 (시험지는 객체, 채점 결과는 배열)
  const o = s.indexOf("{"), a = s.indexOf("[");
  const arr = a >= 0 && (o < 0 || a < o);
  const start = arr ? a : o;
  const end = arr ? s.lastIndexOf("]") : s.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("JSON을 찾지 못함");
  return JSON.parse(s.slice(start, end + 1));
}

export function loadCase(name) {
  const dir = join(CASES, name);
  const material = readFileSync(join(dir, "material.txt"), "utf8");
  const instructions = readFileSync(join(dir, "instructions.txt"), "utf8");
  const imgDir = join(dir, "images");
  const labels = existsSync(join(imgDir, "labels.json"))
    ? JSON.parse(readFileSync(join(imgDir, "labels.json"), "utf8")) : {};
  const images = existsSync(imgDir)
    ? readdirSync(imgDir).filter((f) => /\.jpe?g$/i.test(f)).sort()
      .map((f) => { const no = parseInt(f, 10); return { no, label: labels[no] || `이미지 #${no}`, data: readFileSync(join(imgDir, f)) }; })
    : [];
  return { name, dir, material, instructions, images };
}

// runner.mjs 의 content 조립과 같은 순서·같은 문구
export function buildContent(c, rules) {
  const content = [];
  for (const im of c.images) {
    content.push({ type: "text", text: im.label },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: im.data.toString("base64") } });
  }
  const nImg = c.images.length;
  content.push({ type: "text", text: `${rules}\n\n${c.instructions}\n\n[공부자료 원문]\n${c.material}` +
    (nImg ? `\n\n[첨부 이미지] 위에 자료 속 그림 ${nImg}장을 붙였습니다. 본문의 "[이 쪽의 그림: 첨부 이미지 #n]" 표시와 이미지 이름으로 어느 쪽 그림인지 알 수 있습니다.` : "") +
    `\n\n[다시 한 번] 위 형식의 JSON 하나만 출력하세요.` });
  return content;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

async function main() {
  const rules = readFileSync(join(ROOT, "nas/PROMPT-exam.md"), "utf8");
  const only = process.argv.slice(2);
  const names = (only.length ? only : readdirSync(CASES).filter((n) => existsSync(join(CASES, n, "material.txt")))).sort();
  if (!names.length) { console.error("케이스가 없습니다. eval/cases/<이름>/material.txt 를 만드세요 (eval/README.md 참고)"); process.exit(1); }
  console.log(`모델 ${MODEL} · 케이스 ${names.length}개`);
  for (const name of names) {
    const c = loadCase(name);
    const t0 = Date.now();
    console.log(`\n[${name}] 자료 ${c.material.length}자 · 그림 ${c.images.length}장 · 출제 중`);
    let exam, err;
    try { exam = parseJson(await askClaude(buildContent(c, rules))); }
    catch (e) { err = e.message; }
    const sec = Math.round((Date.now() - t0) / 1000);
    const dir = join(RESULTS, name);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${stamp()}.exam.json`);
    writeFileSync(file, JSON.stringify({ case: name, model: MODEL, at: new Date().toISOString(), sec, error: err || null, exam: exam || null }, null, 1));
    console.log(err ? `[${name}] 실패: ${err} (${sec}초)` : `[${name}] 문항 ${exam.questions?.length ?? 0}개 · ${sec}초 → ${file.replace(ROOT + "/", "")}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
