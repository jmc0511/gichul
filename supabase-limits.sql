-- 요청 횟수 제한. Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 한 번.
-- 숫자 바꾸기: Table Editor > limits 표에서 값 수정 (바로 적용)
--
-- 한도는 네 겹이다. 위에서부터 먼저 걸린다.
--   게스트    : 같은 IP에서 하루 guest_daily 번. 더 쓰려면 로그인.
--   회원      : 계정마다 하루 member_daily 번. 같은 집에서 둘이 로그인해도 각자 받는다.
--   같은 IP   : 로그인 여부와 상관없이 하루 per_ip_daily 번. 계정을 여러 개 만들어 도는 것을 막는다.
--   사이트 전체: 하루 total_daily 번. AI 비용 상한.

-- 1) 한도 설정 (한 줄짜리 표)
create table if not exists public.limits (
  id                  int primary key default 1 check (id = 1),
  per_ip_daily        int not null default 5,    -- 한 사람(IP)당 하루 요청 수
  per_ip_open         int not null default 1,    -- 한 사람이 동시에 대기/출제 중일 수 있는 요청 수
  total_daily         int not null default 30    -- 사이트 전체 하루 요청 수
);
insert into public.limits (id) values (1) on conflict (id) do nothing;

-- 게스트·회원 한도를 나눈다 (이미 쓰던 DB에도 그대로 붙는다)
alter table public.limits add column if not exists guest_daily  int not null default 2;
alter table public.limits add column if not exists member_daily int not null default 5;

-- 같은 IP 상한은 계정 여러 개를 막는 용도라 회원 한도보다 넉넉해야 한다
update public.limits set per_ip_daily = 10 where id = 1 and per_ip_daily < 10;

alter table public.limits enable row level security;
revoke all on public.limits from anon, authenticated;

-- 2) 요청 기록 (요청·시험지를 지워도 남음 → 지웠다 다시 요청해서 한도 피하기 방지)
create table if not exists public.request_log (
  id          bigint generated always as identity primary key,
  client_ip   text not null,
  created_at  timestamptz not null default now()
);
alter table public.request_log add column if not exists user_id uuid;
alter table public.request_log add column if not exists is_admin boolean not null default false;
create index if not exists request_log_ip_time on public.request_log (client_ip, created_at);
create index if not exists request_log_user_time on public.request_log (user_id, created_at);
alter table public.request_log enable row level security;
revoke all on public.request_log from anon, authenticated;

alter table public.requests add column if not exists client_ip text;

-- 3) 요청한 사람의 IP (Supabase 앞단이 붙여 주는 헤더)
create or replace function public.client_ip()
returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.headers', true)::json ->> 'cf-connecting-ip', ''),
    nullif(trim(split_part(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ',', 1)), ''),
    'unknown')
$$;

-- 로그인하지 않았거나 게스트로 시작한 사람
create or replace function public.is_guest()
returns boolean language sql stable as $$
  select auth.uid() is null
      or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)
$$;

-- 4) 남은 횟수 (사이트 표시용)
--    기준 시각은 한국 시간 오늘 0시 (supabase-midnight.sql), 관리자는 무제한 (supabase-admin-unlimited.sql).
--    이 파일을 다시 돌리면 그 두 파일의 내용까지 여기 들어 있으니 따로 다시 돌리지 않아도 된다.
create or replace function public.my_quota()
returns json language plpgsql stable security definer set search_path = public as $$
declare
  ip text := client_ip(); uid uuid := auth.uid(); guest boolean := is_guest();
  l limits; by_ip int; by_user int; open_n int; total int; lim int; used int;
begin
  if is_admin() then
    return json_build_object('unlimited', true, 'guest', false, 'used', 0, 'limit', 0,
                             'open', 0, 'open_limit', 0, 'site_full', false);
  end if;

  select * into l from limits where id = 1;
  select count(*) into by_ip   from request_log where client_ip = ip and not is_admin and created_at >= kst_today();
  select count(*) into by_user from request_log where user_id = uid and not is_admin and created_at >= kst_today();
  select count(*) into open_n  from requests    where client_ip = ip and status in ('pending', 'working');
  select count(*) into total   from request_log where not is_admin and created_at >= kst_today();

  -- 게스트는 IP로 센다 (기록을 지우고 새 게스트가 돼도 같은 IP면 이어서 센다)
  if guest then lim := l.guest_daily;  used := by_ip;
  else          lim := l.member_daily; used := by_user;
  end if;

  return json_build_object(
    'guest', guest,
    'used', used, 'limit', lim,
    'open', open_n, 'open_limit', l.per_ip_open,
    'ip_used', by_ip, 'ip_limit', l.per_ip_daily,
    'site_full', total >= l.total_daily);
end;
$$;
revoke all on function public.my_quota() from public;
grant execute on function public.my_quota() to anon;

-- 5) 요청이 들어올 때 검사 (요청은 사이트에서만 들어오므로 모든 요청에 적용)
create or replace function public.requests_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare ip text := client_ip(); uid uuid := auth.uid(); guest boolean := is_guest(); l limits; n int;
begin
  new.client_ip := ip;

  if is_admin() then
    insert into request_log (client_ip, user_id, is_admin) values (ip, uid, true);
    return new;
  end if;

  select * into l from limits where id = 1;

  select count(*) into n from requests where client_ip = ip and status in ('pending', 'working');
  if n >= l.per_ip_open then raise exception 'limit_open' using errcode = 'P0001'; end if;

  if guest then
    -- 게스트: IP 기준. 막히면 로그인하라고 안내한다 (limit_guest)
    select count(*) into n from request_log where client_ip = ip and not is_admin and created_at >= kst_today();
    if n >= l.guest_daily then raise exception 'limit_guest' using errcode = 'P0001'; end if;
  else
    -- 회원: 계정 기준
    select count(*) into n from request_log where user_id = uid and not is_admin and created_at >= kst_today();
    if n >= l.member_daily then raise exception 'limit_daily' using errcode = 'P0001'; end if;
  end if;

  -- 로그인해도 같은 IP에서 무한정은 안 된다 (계정 여러 개 돌려쓰기 방지)
  select count(*) into n from request_log where client_ip = ip and not is_admin and created_at >= kst_today();
  if n >= l.per_ip_daily then raise exception 'limit_daily' using errcode = 'P0001'; end if;

  select count(*) into n from request_log where not is_admin and created_at >= kst_today();
  if n >= l.total_daily then raise exception 'limit_site' using errcode = 'P0001'; end if;

  insert into request_log (client_ip, user_id) values (ip, uid);
  return new;
end;
$$;

drop trigger if exists requests_guard on public.requests;
create trigger requests_guard before insert on public.requests
  for each row execute function public.requests_guard();

-- 확인
select guest_daily, member_daily, per_ip_daily, per_ip_open, total_daily from public.limits where id = 1;
