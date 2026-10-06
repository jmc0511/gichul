-- 다시 출제 · 저장소 청소 · 관리자 화면.
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 한 번.
-- 맨 아래 "관리자 등록"의 이메일을 확인한 뒤 실행하세요.

-- 1) 요청에 칸 추가
alter table public.requests add column if not exists retry_of    uuid;         -- 어느 요청을 다시 낸 것인지
alter table public.requests add column if not exists started_at  timestamptz;  -- 처리기가 잡은 시각
alter table public.requests add column if not exists finished_at timestamptz;  -- 끝난 시각
alter table public.requests add column if not exists fail_detail text;         -- 실패 원인 (관리자만 봄)

-- 2) 내 요청 목록에 "다시 출제 가능" 여부 추가
drop function if exists public.get_requests(uuid[]);
create function public.get_requests(ids uuid[])
returns table (id uuid, created_at timestamptz, status text, subject text, files text[], exam_id uuid, error text, progress text, reusable boolean, retry_of uuid)
language sql stable security definer set search_path = public as $$
  select r.id, r.created_at, r.status, r.subject, r.files, r.exam_id, r.error, r.progress,
         r.status in ('done', 'error') and r.material <> '', r.retry_of
  from requests r where r.id = any(ids[1:30]) order by r.created_at desc;
$$;
revoke all on function public.get_requests(uuid[]) from public;
grant execute on function public.get_requests(uuid[]) to anon, authenticated;

-- 3) 같은 자료로 다시 출제: 요청 id를 아는 사람만. 횟수 제한(requests_guard)은 그대로 적용됨
create or replace function public.retry_request(src uuid, new_id uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare r requests;
begin
  select * into r from requests where id = src;
  if not found or r.status not in ('done', 'error') or r.material = '' then return false; end if;
  insert into requests (id, subject, files, pages, instructions, material, images, retry_of)
  values (new_id, r.subject, r.files, r.pages, r.instructions, r.material, r.images, src);
  return true;
end;
$$;
revoke all on function public.retry_request(uuid, uuid) from public;
grant execute on function public.retry_request(uuid, uuid) to anon, authenticated;

-- 4) 오래된 자료 비우기 (처리기가 하루 한 번 호출). 끝난 지 keep_days 지난 요청의 자료·그림 목록을 지움
create or replace function public.purge_old_requests(keep_days int default 14)
returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update requests set material = '', images = null
  where status in ('done', 'error') and created_at < now() - make_interval(days => keep_days)
    and (material <> '' or images is not null);
  get diagnostics n = row_count;
  delete from request_log where created_at < now() - interval '30 days';
  return n;
end;
$$;
revoke all on function public.purge_old_requests(int) from public, anon, authenticated;
grant execute on function public.purge_old_requests(int) to service_role;

-- 5) 지워도 되는 저장소 파일 목록 (어디에서도 안 쓰는 그림)
--    request-images: 자료가 남아 있는 요청이 가리키지 않는 폴더 (올린 지 1시간 지난 것만)
--    exam-figures:   어떤 시험지도 가리키지 않는 폴더 (올린 지 1일 지난 것만)
create or replace function public.cleanup_targets()
returns table (bucket text, name text)
language sql stable security definer set search_path = public, storage as $$
  with live_req as (
    select distinct split_part(im ->> 'path', '/', 1) as folder
    from requests r, jsonb_array_elements(r.images) im
    where r.images is not null and im ->> 'path' is not null
  ), live_fig as (
    select distinct split_part(q -> 'figure' ->> 'path', '/', 1) as folder
    from exams e, jsonb_array_elements(e.questions) q
    where jsonb_typeof(e.questions) = 'array' and q -> 'figure' ->> 'path' is not null
  )
  select o.bucket_id::text, o.name from storage.objects o
  where o.bucket_id = 'request-images' and o.created_at < now() - interval '1 hour'
    and not exists (select 1 from live_req l where l.folder = split_part(o.name, '/', 1))
  union all
  select o.bucket_id::text, o.name from storage.objects o
  where o.bucket_id = 'exam-figures' and o.created_at < now() - interval '1 day'
    and not exists (select 1 from live_fig l where l.folder = split_part(o.name, '/', 1))
  limit 1000;
$$;
revoke all on function public.cleanup_targets() from public, anon, authenticated;
grant execute on function public.cleanup_targets() to service_role;

-- 6) 처리기 상태 (처리기가 5분마다 기록)
create table if not exists public.worker_status (
  id       int primary key default 1 check (id = 1),
  seen_at  timestamptz,
  info     jsonb
);
insert into public.worker_status (id) values (1) on conflict (id) do nothing;
alter table public.worker_status enable row level security;
revoke all on public.worker_status from anon, authenticated;

-- 7) 관리자
create table if not exists public.admins (user_id uuid primary key references auth.users (id) on delete cascade);
alter table public.admins enable row level security;
revoke all on public.admins from anon, authenticated;

create or replace function public.admin_stats()
returns json
language plpgsql stable security definer set search_path = public, storage as $$
declare res json;
begin
  if auth.uid() is null or not exists (select 1 from admins where user_id = auth.uid()) then
    raise exception 'not_admin' using errcode = 'P0001';
  end if;
  select json_build_object(
    'now', now(),
    'worker', (select json_build_object('seen_at', seen_at, 'info', info) from worker_status where id = 1),
    'queue', json_build_object(
      'pending', (select count(*) from requests where status = 'pending'),
      'working', (select count(*) from requests where status = 'working'),
      'oldest_pending', (select min(created_at) from requests where status = 'pending')),
    'today', (select json_build_object(
      'total', count(*),
      'done', count(*) filter (where status = 'done'),
      'error', count(*) filter (where status = 'error'),
      'retries', count(*) filter (where retry_of is not null),
      'avg_wait', round(avg(extract(epoch from started_at - created_at)) filter (where started_at is not null)),
      'avg_run', round(avg(extract(epoch from finished_at - started_at)) filter (where status = 'done' and finished_at is not null)))
      from requests where created_at > now() - interval '1 day'),
    -- total 은 지운 요청도 세는 request_log 기준, done/error 는 남아 있는 요청 기준
    'days', (select coalesce(json_agg(d order by d.day), '[]') from (
      select g.day,
             (select count(*) from request_log l where (l.created_at at time zone 'Asia/Seoul')::date = g.day) as total,
             (select count(*) from requests q where q.status = 'done' and (q.created_at at time zone 'Asia/Seoul')::date = g.day) as done,
             (select count(*) from requests q where q.status = 'error' and (q.created_at at time zone 'Asia/Seoul')::date = g.day) as error
      from (select generate_series((now() at time zone 'Asia/Seoul')::date - 13, (now() at time zone 'Asia/Seoul')::date, interval '1 day')::date as day) g) d),
    'failures', (select coalesce(json_agg(f), '[]') from (
      select id, created_at, subject, files, error, fail_detail
      from requests where status = 'error' order by created_at desc limit 15) f),
    'top_ips', (select coalesce(json_agg(t), '[]') from (
      select regexp_replace(client_ip, '\.\d+\.\d+$', '.*.*') as ip, count(*) as n
      from request_log where created_at > now() - interval '1 day'
      group by client_ip order by count(*) desc limit 5) t),
    'usage', json_build_object(
      'db_bytes', pg_database_size(current_database()),
      'request_images', (select json_build_object('n', count(*), 'bytes', coalesce(sum((metadata ->> 'size')::bigint), 0)) from storage.objects where bucket_id = 'request-images'),
      'exam_figures', (select json_build_object('n', count(*), 'bytes', coalesce(sum((metadata ->> 'size')::bigint), 0)) from storage.objects where bucket_id = 'exam-figures'),
      'requests', (select count(*) from requests),
      'exams', (select count(*) from exams),
      'users', (select count(*) from auth.users),
      'google_users', (select count(*) from auth.users where not coalesce(is_anonymous, false))),
    'limits', (select row_to_json(l) from limits l where id = 1)
  ) into res;
  return res;
end;
$$;
revoke all on function public.admin_stats() from public, anon;
grant execute on function public.admin_stats() to authenticated;

-- 8) 관리자 등록: 사이트에서 이 구글 계정으로 한 번 로그인한 뒤 실행해야 들어감
--    (다른 구글 계정이면 이메일을 바꾸세요)
insert into public.admins (user_id)
select id from auth.users where email = '관리자-구글-이메일@example.com'
on conflict do nothing;
select count(*) as "등록된 관리자 수" from public.admins;
