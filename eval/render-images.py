#!/usr/bin/env python3
"""평가셋 케이스에 자료 속 그림 넣기 (스캔본·그림 위주 PDF용).

    python3 eval/render-images.py <케이스이름> <파일.pdf> [--pages 1-20]

사이트(site/app.js)가 하는 것과 같게 맞춘다:
  - 폭 1100px 기준, 배율은 min(2, 1100/쪽너비) — renderPdfPage
  - JPEG 품질 0.75 — canvasToJpeg
  - 최대 20장 — MAX_IMAGES
  - 글자가 거의 없는 쪽(40자 미만)은 점수 1000. 같은 점수가 20장을 넘으면 **자료 전체에서 고르게** 뽑는다 (pickImages)

material.txt 의 해당 쪽에는 "[이 쪽의 그림: 첨부 이미지 #n]" 을 붙이고,
images/labels.json 에 사이트와 같은 이름표를 쓴다.

필요: pip install pymupdf  (렌더링용. 사이트는 pdf.js 로 그리지만 결과 그림은 사실상 같다)
"""
import json, os, re, sys

import pymupdf

MAX_IMAGES = 20
IMG_MAX_W = 1100
JPEG_QUALITY = 75

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    opts = dict(a.split("=", 1) for a in sys.argv[1:] if a.startswith("--") and "=" in a)
    if len(args) < 2:
        print("쓰는 법: python3 eval/render-images.py <케이스이름> <파일.pdf> [--pages=1-20]")
        sys.exit(1)
    name, path = args[0], args[1]
    here = os.path.dirname(os.path.abspath(__file__))
    case = os.path.join(here, "cases", name)
    imgdir = os.path.join(case, "images")
    os.makedirs(imgdir, exist_ok=True)

    doc = pymupdf.open(path)
    base = os.path.basename(path)

    # 글자 수로 사이트와 같은 판정 (40자 미만이면 그림으로 보낸다)
    texts = [re.sub(r"[ \t]+", " ", p.get_text()).strip() for p in doc]
    scored = [(i, 1000 if len(t) < 40 else 0) for i, t in enumerate(texts)]
    want = [i for i, s in scored if s]
    if "--pages" in opts or "pages" in opts:
        a, _, b = opts.get("pages", opts.get("--pages", "")).partition("-")
        want = [i for i in range(int(a) - 1, int(b or a)) if i < len(texts)]
    # 점수가 같은 쪽이 자리보다 많으면 자료 전체에 고르게 (pickImages 와 같은 계산)
    if len(want) > MAX_IMAGES:
        chosen = [want[(2 * i + 1) * len(want) // (2 * MAX_IMAGES)] for i in range(MAX_IMAGES)]
    else:
        chosen = want
    if not chosen:
        print("그림으로 보낼 쪽이 없습니다 (글자가 충분한 자료입니다)")
        sys.exit(1)

    labels = {}
    for n, i in enumerate(chosen, 1):
        page = doc[i]
        s = min(2.0, IMG_MAX_W / page.rect.width)
        pix = page.get_pixmap(matrix=pymupdf.Matrix(s, s), colorspace=pymupdf.csRGB)
        out = os.path.join(imgdir, f"{n:02d}.jpg")
        pix.pil_save(out, format="JPEG", quality=JPEG_QUALITY)
        labels[str(n)] = f"이미지 #{n} ({base} p.{i + 1})"
    json.dump(labels, open(os.path.join(imgdir, "labels.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)

    # material.txt 를 다시 쓴다 — 그림을 붙인 쪽에 표시를 남긴다
    tag = {i: n for n, i in enumerate(chosen, 1)}
    body = [f"===== 자료: {base} ====="]
    for i, t in enumerate(texts):
        mark = f"\n[이 쪽의 그림: 첨부 이미지 #{tag[i]}]" if i in tag else ""
        body.append(f"[p.{i + 1}]\n{t}{mark}")
    open(os.path.join(case, "material.txt"), "w", encoding="utf-8").write(body[0] + "\n" + "\n\n".join(body[1:]))

    total = sum(os.path.getsize(os.path.join(imgdir, f)) for f in os.listdir(imgdir) if f.endswith(".jpg"))
    print(f"{base}: {doc.page_count}쪽 중 {len(chosen)}장 그림으로 ({chosen[0] + 1}~{chosen[-1] + 1}쪽), {total // 1024}KB")
    if len(want) > MAX_IMAGES:
        print(f"※ 그림이 필요한 쪽 {len(want)}개 중 {MAX_IMAGES}장만 간다 — 나머지 {len(want) - MAX_IMAGES}쪽은 모델이 못 본다 (사이트도 같다)")

main()
