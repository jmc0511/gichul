-- 출제 진행 상황("문항 4/10 작성 중")을 저장할 칸 추가.
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 한 번.

alter table public.requests add column if not exists progress text;

drop function if exists public.get_requests(uuid[]);
create function public.get_requests(ids uuid[])
returns table (id uuid, created_at timestamptz, status text, subject text, files text[], exam_id uuid, error text, progress text)
language sql stable security definer set search_path = public as $$
  select r.id, r.created_at, r.status, r.subject, r.files, r.exam_id, r.error, r.progress
  from requests r where r.id = any(ids[1:30]) order by r.created_at desc;
$$;
revoke all on function public.get_requests(uuid[]) from public;
grant execute on function public.get_requests(uuid[]) to anon;
