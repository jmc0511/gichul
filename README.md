# 기출 출제실 배포 가이드

```
기출출제실/
├─ site/                 ← 이 폴더만 배포 (HTML/CSS/JS)
│  ├─ index.html
│  ├─ style.css
│  ├─ app.js
│  └─ config.js          ← Supabase 주소 + 공개 키 입력
├─ supabase-setup.sql    ← DB 만들기 (한 번만)
├─ queue.ps1             ← 대기열 처리 도구 (내 PC 전용)
├─ secret.json           ← 직접 만들기. 절대 배포·공유 금지
└─ 대기열처리.md          ← Claude가 따르는 처리 절차
```

## 1. Supabase 준비 (무료)
1. https://supabase.com 가입 → New project.
2. SQL Editor → `supabase-setup.sql` 내용 붙여넣고 Run, 이어서 `supabase-private.sql` 도 Run.
3. Project Settings → API (또는 API Keys) 에서 복사:
   - Project URL
   - 공개 키 (anon 또는 publishable) → `site/config.js`
   - 비밀 키 (service_role 또는 secret) → `secret.json`

`secret.json` (이 폴더에, site 밖):
```json
{ "url": "https://xxxx.supabase.co", "key": "비밀 키" }
```

## 2. 배포
`site` 폴더를 아무 정적 호스팅에 올리면 됩니다. (GitHub Pages, Netlify 드래그앤드롭, Cloudflare Pages 등)
로컬 확인: `site/index.html` 을 브라우저로 열기.

## 3. 요청 처리
Claude Code에서:
```
/loop 10m C:\Users\KDZ\기출출제실\대기열처리.md 대로 기출 출제실 대기열 처리해줘
```
또는 그때그때 "기출 출제실 대기열 처리해줘".
