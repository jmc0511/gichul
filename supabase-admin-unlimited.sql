-- 관리자(admins 표에 등록된 계정)는 요청 횟수 제한 없음.
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 한 번. (supabase-midnight.sql 다음)
-- 사이트에서 관리자 구글 계정으로 로그인한 상태여야 적용돼요.

-- 지금 요청한 사람이 관리자인지
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and exists (select 1 from admins where user_id = auth.uid())
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

-- 관리자 요청은 기록은 남기되 사이트 전체 한도 계산에서는 뺌
alter table public.request_log add column if not exists is_admin boolean not null default false;

create or replace function public.my_quota()
returns json language plpgsql stable security definer set search_path = public as $$
declare ip text := client_ip(); l limits; used int; open_n int; total int;
begin
  if is_admin() then
    return json_build_object('unlimited', true, 'used', 0, 'limit', 0, 'open', 0, 'open_limit', 0, 'site_full', false);
  end if;
  select * into l from limits where id = 1;
  select count(*) into used  from request_log where client_ip = ip and not is_admin and created_at >= kst_today();
  select count(*) into open_n from requests where client_ip = ip and status in ('pending', 'working');
  select count(*) into total from request_log where not is_admin and created_at >= kst_today();
  return json_build_object(
    'used', used, 'limit', l.per_ip_daily,
    'open', open_n, 'open_limit', l.per_ip_open,
    'site_full', total >= l.total_daily);
end;
$$;

create or replace function public.requests_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare ip text := client_ip(); l limits; n int;
begin
  new.client_ip := ip;
  if is_admin() then
    insert into request_log (client_ip, is_admin) values (ip, true);
    return new;
  end if;
  select * into l from limits where id = 1;
  select count(*) into n from requests where client_ip = ip and status in ('pending', 'working');
  if n >= l.per_ip_open then raise exception 'limit_open' using errcode = 'P0001'; end if;
  select count(*) into n from request_log where client_ip = ip and not is_admin and created_at >= kst_today();
  if n >= l.per_ip_daily then raise exception 'limit_daily' using errcode = 'P0001'; end if;
  select count(*) into n from request_log where not is_admin and created_at >= kst_today();
  if n >= l.total_daily then raise exception 'limit_site' using errcode = 'P0001'; end if;
  insert into request_log (client_ip) values (ip);
  return new;
end;
$$;
