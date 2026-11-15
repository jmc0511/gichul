-- 출력 종류: 시험지 · 요약 · 설명
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 한 번.
--
-- 지금까지는 자료를 올리면 시험지만 만들었다. 같은 자료로 '요약'과 '설명'도 고를 수 있게 한다.
-- 표를 새로 만들지 않고 requests·exams 에 종류를 붙인다.
-- 그래야 문제집 목록·삭제·공유·14일 청소·푸시 알림·요청 한도가 손대지 않고 그대로 동작한다.
--
-- 요약·설명은 문항이 없으므로 questions 는 빈 배열([])로 두고 본문은 sections 에 넣는다.
-- (questions 의 not null 을 풀지 않는 이유: 기존 코드가 전부 배열이라고 믿고 있어서)

-- 1) 요청에 종류를 붙인다. 기존 행은 전부 시험지.
alter table public.requests
  add column if not exists kind text not null default 'exam';

alter table public.requests
  drop constraint if exists requests_kind_check;
alter table public.requests
  add constraint requests_kind_check check (kind in ('exam', 'summary', 'explain'));

-- 2) 결과에도 같은 종류와, 요약·설명의 본문 자리를 만든다.
alter table public.exams
  add column if not exists kind text not null default 'exam';

alter table public.exams
  drop constraint if exists exams_kind_check;
alter table public.exams
  add constraint exams_kind_check check (kind in ('exam', 'summary', 'explain'));

alter table public.exams
  add column if not exists sections jsonb;

-- 3) 방문자가 요청을 넣을 때 종류도 함께 넣을 수 있게 (나머지 권한은 그대로)
grant insert (kind) on public.requests to anon;
grant insert (kind) on public.requests to authenticated;

-- 4) 목록·열기에서 종류와 본문이 함께 오게 한다.
--    (supabase-private.sql 의 함수를 덮어쓴다. 반환 열이 바뀌므로 drop 후 다시 만든다)
drop function if exists public.get_exams(uuid[]);
create function public.get_exams(ids uuid[])
returns table (
  id uuid, created_at timestamptz, title text, subject text,
  questions jsonb, kind text, sections jsonb
)
language sql stable security definer set search_path = public as $$
  select e.id, e.created_at, e.title, e.subject, e.questions, e.kind, e.sections
  from exams e where e.id = any(ids[1:50]) order by e.created_at desc;
$$;

revoke all on function public.get_exams(uuid[]) from public;
grant execute on function public.get_exams(uuid[]) to anon;
grant execute on function public.get_exams(uuid[]) to authenticated;

-- 5) 요청 목록에도 종류를 실어 준다 (문제집에서 배지로 보여 주려고).
--    get_requests 는 progress → ops → more 로 세 번 바뀌었다.
--    마지막 모양(supabase-more.sql)에 kind 만 더해 다시 만든다. 앞의 열 순서는 그대로 둔다.
drop function if exists public.get_requests(uuid[]);
create function public.get_requests(ids uuid[])
returns table (
  id uuid, created_at timestamptz, status text, subject text, files text[],
  exam_id uuid, error text, progress text,
  reusable boolean, retry_of uuid, regen_exam uuid, regen_idx int, kind text
)
language sql stable security definer set search_path = public as $$
  select r.id, r.created_at, r.status, r.subject, r.files, r.exam_id, r.error, r.progress,
         r.status in ('done', 'error') and r.material <> '', r.retry_of, r.regen_exam, r.regen_idx,
         r.kind
  from requests r where r.id = any(ids[1:30]) order by r.created_at desc;
$$;

revoke all on function public.get_requests(uuid[]) from public;
grant execute on function public.get_requests(uuid[]) to anon;
grant execute on function public.get_requests(uuid[]) to authenticated;
