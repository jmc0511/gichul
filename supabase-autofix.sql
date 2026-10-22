-- 신고 자동 처리: NAS 처리기가 신고를 받으면 자료와 대조해 문제를 고치고 기록을 남긴다.
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 한 번. (supabase-security.sql 다음)

alter table public.reports add column if not exists auto_status text
  check (auto_status in ('working', 'fixed', 'ok', 'stale', 'failed', 'undone'));
alter table public.reports add column if not exists auto_note   text;        -- 무엇을 고쳤는지 / 왜 문제없다고 봤는지
alter table public.reports add column if not exists auto_before jsonb;       -- 고치기 전 문제 (되돌리기용)
alter table public.reports add column if not exists auto_after  jsonb;       -- 고친 뒤 문제
alter table public.reports add column if not exists auto_at     timestamptz;
create index if not exists reports_auto on public.reports (auto_status, created_at);

-- 관리자: 자동 처리 기록 (최근 30일, 문제마다 하나)
create or replace function public.admin_auto_reports()
returns table (id bigint, exam_id uuid, q_index int, title text, reason text, note text, auto_status text, auto_note text,
               auto_before jsonb, auto_after jsonb, auto_at timestamptz, same_q int)
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not exists (select 1 from admins where user_id = auth.uid()) then
    raise exception 'not_admin' using errcode = 'P0001';
  end if;
  return query
    select distinct on (r.exam_id, r.q_index, r.auto_at)
           r.id, r.exam_id, r.q_index, e.title, r.reason, r.note, r.auto_status, r.auto_note, r.auto_before, r.auto_after, r.auto_at,
           (select count(*)::int from reports x where x.exam_id = r.exam_id and x.q_index = r.q_index and x.auto_at = r.auto_at)
    from reports r left join exams e on e.id = r.exam_id
    where r.auto_status in ('fixed', 'ok', 'stale', 'undone') and r.auto_at > now() - interval '30 days'
    order by r.auto_at desc, r.exam_id, r.q_index, r.id
    limit 40;
end;
$$;
revoke all on function public.admin_auto_reports() from public, anon;
grant execute on function public.admin_auto_reports() to authenticated;

-- 관리자: 자동 수정 되돌리기 (그 사이 문제가 또 바뀌었으면 거절)
create or replace function public.admin_undo_autofix(rid bigint)
returns boolean
language plpgsql security definer set search_path = public as $$
declare r reports; cur jsonb;
begin
  if auth.uid() is null or not exists (select 1 from admins where user_id = auth.uid()) then
    raise exception 'not_admin' using errcode = 'P0001';
  end if;
  select * into r from reports where id = rid;
  if not found or r.auto_status <> 'fixed' or r.auto_before is null then return false; end if;
  select questions -> r.q_index into cur from exams where id = r.exam_id;
  if cur is distinct from r.auto_after then raise exception 'changed_since' using errcode = 'P0001'; end if;
  update exams set questions = jsonb_set(questions, array[r.q_index::text], r.auto_before) where id = r.exam_id;
  update reports set auto_status = 'undone' where exam_id = r.exam_id and q_index = r.q_index and auto_at = r.auto_at;
  return true;
end;
$$;
revoke all on function public.admin_undo_autofix(bigint) from public, anon;
grant execute on function public.admin_undo_autofix(bigint) to authenticated;
