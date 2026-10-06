-- 요청 횟수 제한. Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 한 번.
-- 숫자 바꾸기: Table Editor > limits 표에서 값 수정 (바로 적용)

-- 1) 한도 설정 (한 줄짜리 표)
create table if not exists public.limits (
  id                  int primary key default 1 check (id = 1),
  per_ip_daily        int not null default 5,    -- 한 사람(IP)당 하루 요청 수
  per_ip_open         int not null default 1,    -- 한 사람이 동시에 대기/출제 중일 수 있는 요청 수
  total_daily         int not null default 30    -- 사이트 전체 하루 요청 수
);
insert into public.limits (id) values (1) on conflict (id) do nothing;
alter table public.limits enable row level security;
revoke all on public.limits from anon, authenticated;

-- 2) 요청 기록 (요청·시험지를 지워도 남음 → 지웠다 다시 요청해서 한도 피하기 방지)
create table if not exists public.request_log (
  id          bigint generated always as identity primary key,
  client_ip   text not null,
  created_at  timestamptz not null default now()
);
create index if not exists request_log_ip_time on public.request_log (client_ip, created_at);
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

-- 4) 남은 횟수 (사이트 표시용)
create or replace function public.my_quota()
returns json language plpgsql stable security definer set search_path = public as $$
declare ip text := client_ip(); l limits; used int; open_n int; total int;
begin
  select * into l from limits where id = 1;
  select count(*) into used  from request_log where client_ip = ip and created_at > now() - interval '1 day';
  select count(*) into open_n from requests where client_ip = ip and status in ('pending', 'working');
  select count(*) into total from request_log where created_at > now() - interval '1 day';
  return json_build_object(
    'used', used, 'limit', l.per_ip_daily,
    'open', open_n, 'open_limit', l.per_ip_open,
    'site_full', total >= l.total_daily);
end;
$$;
revoke all on function public.my_quota() from public;
grant execute on function public.my_quota() to anon;

-- 5) 요청이 들어올 때 검사 (요청은 사이트에서만 들어오므로 모든 요청에 적용)
create or replace function public.requests_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare ip text := client_ip(); l limits; n int;
begin
  new.client_ip := ip;
  select * into l from limits where id = 1;
  select count(*) into n from requests where client_ip = ip and status in ('pending', 'working');
  if n >= l.per_ip_open then raise exception 'limit_open' using errcode = 'P0001'; end if;
  select count(*) into n from request_log where client_ip = ip and created_at > now() - interval '1 day';
  if n >= l.per_ip_daily then raise exception 'limit_daily' using errcode = 'P0001'; end if;
  select count(*) into n from request_log where created_at > now() - interval '1 day';
  if n >= l.total_daily then raise exception 'limit_site' using errcode = 'P0001'; end if;
  insert into request_log (client_ip) values (ip);
  return new;
end;
$$;

drop trigger if exists requests_guard on public.requests;
create trigger requests_guard before insert on public.requests
  for each row execute function public.requests_guard();
