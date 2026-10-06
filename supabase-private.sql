-- 시험지를 "요청한 사람 + 링크를 받은 사람"만 볼 수 있게 변경.
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 한 번.

-- 1) 방문자가 목록을 통째로 읽던 권한 제거
revoke select on public.requests from anon;
revoke select on public.exams    from anon;
drop policy if exists "visitors read request status" on public.requests;
drop policy if exists "visitors read exams" on public.exams;

-- 2) 요청 id는 브라우저가 직접 만들어서 넣음 (돌려받을 필요 없게)
grant insert (id) on public.requests to anon;

-- 3) id를 아는 것만 조회 가능 (id는 추측할 수 없는 UUID)
create or replace function public.get_requests(ids uuid[])
returns table (id uuid, created_at timestamptz, status text, subject text, files text[], exam_id uuid, error text)
language sql stable security definer set search_path = public as $$
  select r.id, r.created_at, r.status, r.subject, r.files, r.exam_id, r.error
  from requests r where r.id = any(ids[1:30]) order by r.created_at desc;
$$;

create or replace function public.get_exams(ids uuid[])
returns table (id uuid, created_at timestamptz, title text, subject text, questions jsonb)
language sql stable security definer set search_path = public as $$
  select e.id, e.created_at, e.title, e.subject, e.questions
  from exams e where e.id = any(ids[1:50]) order by e.created_at desc;
$$;

revoke all on function public.get_requests(uuid[]) from public;
revoke all on function public.get_exams(uuid[])    from public;
grant execute on function public.get_requests(uuid[]) to anon;
grant execute on function public.get_exams(uuid[])    to anon;
