#!/usr/bin/env node
// 평가셋 케이스 만들기 — PDF에서 공부자료 원문 뽑기
//
//   node eval/extract.mjs <케이스이름> <파일.pdf> [파일2.pdf …]
//
// 사이트(site/app.js 의 readPdf)와 **같은 pdf.js 같은 버전**으로 같은 방식으로 글자를 뽑고,
// buildMaterial 과 같은 모양(===== 자료: 이름 ===== / [p.n])으로 eval/cases/<이름>/material.txt 에 쓴다.
// 조건 파일(instructions.txt)은 eval/instructions-template.txt 를 복사해 두니 문항 수·유형만 고쳐 쓰면 된다.
//
// 그림은 뽑지 않는다. 그림이 중요한 자료라면 사이트에서 한 번 요청을 보낸 뒤
// requests 표의 material·images 를 그대로 가져오는 쪽이 정확하다 (14일 안에).
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const pdfjsLib = require_("pdfjs-dist/legacy/build/pdf.js");
const HERE = dirname(fileURLToPath(import.meta.url));

// site/app.js readPdf 의 글자 뽑는 부분과 같은 규칙
async function pagesOf(path) {
  const data = new Uint8Array(readFileSync(path));
  const pdf = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;
  const pages = [];
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      pages.push(tc.items.map((it) => (it.str || "") + (it.hasEOL ? "\n" : " ")).join("")
        .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim());
      page.cleanup();
    }
  } finally { await pdf.destroy(); }
  return pages;
}

const [name, ...files] = process.argv.slice(2);
if (!name || !files.length) { console.error("쓰는 법: node eval/extract.mjs <케이스이름> <파일.pdf> …"); process.exit(1); }

const dir = join(HERE, "cases", name);
mkdirSync(dir, { recursive: true });
const blocks = [];
for (const f of files) {
  const pages = await pagesOf(f);
  const chars = pages.reduce((a, p) => a + p.length, 0);
  console.log(`${basename(f)}: ${pages.length}쪽 ${chars}자${chars / pages.length < 40 ? " (글자가 거의 없음 — 스캔본일 수 있음)" : ""}`);
  blocks.push(`===== 자료: ${basename(f)} =====\n` + pages.map((p, i) => `[p.${i + 1}]\n${p}`).join("\n\n"));
}
const material = blocks.join("\n\n");
writeFileSync(join(dir, "material.txt"), material);
const instr = join(dir, "instructions.txt");
if (!existsSync(instr)) copyFileSync(join(HERE, "instructions-template.txt"), instr);
console.log(`→ eval/cases/${name}/material.txt (${material.length}자)`);
console.log(`→ eval/cases/${name}/instructions.txt ${existsSync(instr) ? "(문항 수·유형을 자료에 맞게 고치세요)" : ""}`);
