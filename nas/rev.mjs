// 지금 도는 코드가 어느 버전인지 알아내는 지문.
//
// 코드는 이미지에 넣지 않고 폴더째 연결해서 쓴다(docker-compose.yml). 파일을 덮어쓰고
// 컨테이너만 다시 시작하면 반영되는데, **일부만 덮어써도 처리기는 멀쩡히 뜬다** —
// 그래서 "새 기능이 안 먹네" 하면 코드 탓인지 업로드 누락인지 구분이 안 됐다.
// 처리기는 뜰 때 이 지문을 상태(worker_status.info.rev)에 적어 둔다. 내 컴퓨터에서
//   node nas/rev.mjs
// 를 돌려 같은 값이 나오면 올라간 코드가 맞고, 다르면 뭔가 안 올라갔다.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// 처리기가 실제로 읽는 파일들. 하나라도 없으면 일부러 터뜨린다(조용히 옛 동작으로 도는 것보다 낫다)
export const CODE_FILES = [
  "runner.mjs", "queue.mjs", "rev.mjs", "package.json",
  "PROMPT-exam.md", "PROMPT-summary.md", "PROMPT-explain.md",
  "PROMPT-ink.md", "PROMPT-ink-text.md"
];

export function codeRev(dirUrl) {
  const dir = fileURLToPath(dirUrl);
  const h = createHash("sha256");
  for (const name of CODE_FILES) {
    h.update(name).update("\0").update(readFileSync(`${dir}/${name}`)).update("\0");
  }
  return h.digest("hex").slice(0, 10);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(codeRev(new URL("./", import.meta.url)));
}
