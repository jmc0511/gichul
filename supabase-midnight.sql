-- 요청 횟수를 "최근 24시간" 대신 "한국 시간 오늘(0시부터)" 기준으로 셈.
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 한 번. (권한은 그대로 유지됨)

-- 한국 시간 오늘 0시
create or replace function public.kst_today()
returns timestamptz language sql stable as $$
  select date_trunc('day', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul'
$$;

-- 남은 횟수 (사이트 표시용)
create or replace function public.my_quota()
returns json language plpgsql stable security definer set search_path = public as $$
declare ip text := client_ip(); l limits; used int; open_n int; total int;
begin
  select * into l from limits where id = 1;
  select count(*) into used  from request_log where client_ip = ip and created_at >= kst_today();
  select count(*) into open_n from requests where client_ip = ip and status in ('pending', 'working');
  select count(*) into total from request_log where created_at >= kst_today();
  return json_build_object(
    'used', used, 'limit', l.per_ip_daily,
    'open', open_n, 'open_limit', l.per_ip_open,
    'site_full', total >= l.total_daily);
end;
$$;

-- 요청이 들어올 때 검사
create or replace function public.requests_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare ip text := client_ip(); l limits; n int;
begin
  new.client_ip := ip;
  select * into l from limits where id = 1;
  select count(*) into n from requests where client_ip = ip and status in ('pending', 'working');
  if n >= l.per_ip_open then raise exception 'limit_open' using errcode = 'P0001'; end if;
  select count(*) into n from request_log where client_ip = ip and created_at >= kst_today();
  if n >= l.per_ip_daily then raise exception 'limit_daily' using errcode = 'P0001'; end if;
  select count(*) into n from request_log where created_at >= kst_today();
  if n >= l.total_daily then raise exception 'limit_site' using errcode = 'P0001'; end if;
  insert into request_log (client_ip) values (ip);
  return new;
end;
$$;

-- 확인: 오늘 0시(한국 시간)가 맞게 나오면 성공
select kst_today() at time zone 'Asia/Seoul' as "오늘 0시 (한국)";
