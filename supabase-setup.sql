-- 기출 출제실 DB 설정. Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 한 번.

create table if not exists public.requests (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  status       text not null default 'pending' check (status in ('pending', 'working', 'done', 'error')),
  subject      text check (char_length(subject) <= 200),
  files        text[],
  pages        int,
  instructions text not null check (char_length(instructions) <= 8000),
  material     text not null check (char_length(material) <= 160000),
  exam_id      uuid,
  error        text
);

create table if not exists public.exams (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  request_id  uuid references public.requests(id) on delete set null,
  title       text not null,
  subject     text,
  questions   jsonb not null
);

alter table public.requests enable row level security;
alter table public.exams    enable row level security;

-- 방문자(anon): 요청은 "넣기"와 상태 확인만. 자료 원문(material)과 출제 지시는 못 읽음.
revoke all on public.requests from anon, authenticated;
revoke all on public.exams    from anon, authenticated;
grant insert (subject, files, pages, instructions, material) on public.requests to anon;
grant select (id, created_at, status, subject, files, exam_id, error) on public.requests to anon;
grant select on public.exams to anon;

drop policy if exists "visitors submit requests" on public.requests;
drop policy if exists "visitors read request status" on public.requests;
drop policy if exists "visitors read exams" on public.exams;
create policy "visitors submit requests"   on public.requests for insert to anon with check (true);
create policy "visitors read request status" on public.requests for select to anon using (true);
create policy "visitors read exams"        on public.exams    for select to anon using (true);

-- 시험지 작성·상태 변경은 secret(service_role) 키를 쓰는 처리 스크립트만 할 수 있음 (RLS 우회).
