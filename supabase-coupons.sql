-- 쿠폰 코드로 무제한권 지급.
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 Run. (supabase-kinds.sql 다음)
--
-- 설계
-- - 코드 하나를 여러 명이 쓴다(max_uses 로 인원 제한). 등록하면 grant_days 동안 무제한.
-- - "무제한"은 **개인 한도만** 푼다: 게스트/회원 하루 한도와 같은 IP 하루 한도를 건너뛴다.
--   동시 요청 수(per_ip_open)와 사이트 전체 하루(total_daily)는 그대로 적용한다 — NAS 가 주저앉지 않게.
-- - 게스트는 등록할 수 없다. 구글 로그인한 계정에만 붙는다(기록이 남아야 기간을 셀 수 있다).
--
-- 주의: 이 파일은 requests_guard 와 my_quota 를 **덮어쓴다.**
-- 2026-11-17 기준 DB 에 실제로 들어 있던 본문에 쿠폰 분기만 더한 것이다.
-- 나중에 supabase-limits.sql 이나 supabase-admin-unlimited.sql 을 다시 실행하면 쿠폰 분기가 사라진다.

-- 1) 쿠폰
create table if not exists public.coupons (
  code        text primary key,                      -- 대문자로 저장한다 (입력은 대소문자 가림 없음)
  grant_days  int  not null default 30,              -- 등록하면 며칠 동안 무제한인지
  max_uses    int,                                   -- 몇 명까지 쓸 수 있는지. null 이면 인원 제한 없음
  used_count  int  not null default 0,
  expires_at  timestamptz,                           -- 코드 자체를 쓸 수 있는 기한. null 이면 무기한
  note        text,                                  -- 어디에 뿌린 코드인지 (운영용 메모)
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  constraint coupons_code_shape check (code ~ '^[A-Z0-9]{4,24}$'),
  constraint coupons_grant_days check (grant_days between 1 and 3650),
  constraint coupons_max_uses   check (max_uses is null or max_uses > 0)
);

-- 2) 누가 어떤 코드를 썼고 언제까지인지
create table if not exists public.coupon_grants (
  user_id     uuid not null references auth.users (id) on delete cascade,
  code        text not null references public.coupons (code) on delete cascade,
  granted_at  timestamptz not null default now(),
  valid_until timestamptz not null,
  primary key (user_id, code)
);

create index if not exists coupon_grants_user_idx on public.coupon_grants (user_id, valid_until desc);

alter table public.coupons       enable row level security;
alter table public.coupon_grants enable row level security;
revoke all on public.coupons       from anon, authenticated;
revoke all on public.coupon_grants from anon, authenticated;
-- 읽기도 막는다. 코드 목록이 보이면 아무나 가져다 쓴다. 전부 아래 함수로만 다룬다.

-- 3) 지금 이 사람이 쿠폰으로 무제한인지
create or replace function public.has_coupon()
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null
     and exists (select 1 from coupon_grants
                 where user_id = auth.uid() and valid_until > now())
$$;
revoke all on function public.has_coupon() from public;
grant execute on function public.has_coupon() to anon, authenticated;

-- 언제까지인지 (여러 장이면 가장 늦은 것)
create or replace function public.coupon_until()
returns timestamptz language sql stable security definer set search_path = public as $$
  select max(valid_until) from coupon_grants
  where user_id = auth.uid() and valid_until > now()
$$;
revoke all on function public.coupon_until() from public;
grant execute on function public.coupon_until() to anon, authenticated;

-- 4) 쿠폰 등록
create or replace function public.redeem_coupon(p_code text)
returns json language plpgsql security definer set search_path = public as $$
declare c coupons; uid uuid := auth.uid(); norm text; until timestamptz;
begin
  if uid is null or is_guest() then
    return json_build_object('ok', false, 'reason', 'login_required');
  end if;

  norm := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  if norm = '' then return json_build_object('ok', false, 'reason', 'empty'); end if;

  select * into c from coupons where code = norm;
  if not found or not c.active then
    return json_build_object('ok', false, 'reason', 'not_found');
  end if;
  if c.expires_at is not null and c.expires_at <= now() then
    return json_build_object('ok', false, 'reason', 'expired');
  end if;

  -- 이미 쓴 코드면 횟수를 더 올리지 않고 지금 상태만 알려 준다
  if exists (select 1 from coupon_grants where user_id = uid and code = norm) then
    select valid_until into until from coupon_grants where user_id = uid and code = norm;
    return json_build_object('ok', false, 'reason', 'already', 'until', until);
  end if;

  if c.max_uses is not null and c.used_count >= c.max_uses then
    return json_build_object('ok', false, 'reason', 'used_up');
  end if;

  until := now() + make_interval(days => c.grant_days);
  insert into coupon_grants (user_id, code, valid_until) values (uid, norm, until);
  update coupons set used_count = used_count + 1 where code = norm;

  return json_build_object('ok', true, 'until', until, 'days', c.grant_days);
end;
$$;
revoke all on function public.redeem_coupon(text) from public;
grant execute on function public.redeem_coupon(text) to authenticated;

-- 5) 한도 검사에 쿠폰 반영
--    (2026-11-17 DB 에 있던 본문 + 쿠폰 분기. 관리자 처리와 순서는 그대로 둔다)
create or replace function public.requests_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare ip text := client_ip(); uid uuid := auth.uid(); guest boolean := is_guest();
        unlimited boolean := has_coupon(); l limits; n int;
begin
  new.client_ip := ip;

  if is_admin() then
    insert into request_log (client_ip, user_id, is_admin) values (ip, uid, true);
    return new;
  end if;

  select * into l from limits where id = 1;

  -- 동시 요청은 쿠폰이 있어도 막는다 (NAS 한 번에 돌릴 수 있는 양이 정해져 있다)
  select count(*) into n from requests where client_ip = ip and status in ('pending', 'working');
  if n >= l.per_ip_open then raise exception 'limit_open' using errcode = 'P0001'; end if;

  -- 개인 하루 한도: 쿠폰이 있으면 건너뛴다
  if not unlimited then
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
  end if;

  -- 사이트 전체 한도는 쿠폰이 있어도 적용한다
  select count(*) into n from request_log where not is_admin and created_at >= kst_today();
  if n >= l.total_daily then raise exception 'limit_site' using errcode = 'P0001'; end if;

  insert into request_log (client_ip, user_id) values (ip, uid);
  return new;
end;
$$;

-- 6) 화면에 보여 줄 한도 정보에도 쿠폰 반영
create or replace function public.my_quota()
returns json language plpgsql stable security definer set search_path = public as $$
declare
  ip text := client_ip(); uid uuid := auth.uid(); guest boolean := is_guest();
  l limits; by_ip int; by_user int; open_n int; total int; lim int; used int;
  until timestamptz;
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

  until := coupon_until();
  if until is not null then
    -- 쿠폰: 개인 한도만 풀린다. 동시 요청과 사이트 전체는 그대로라 그 값도 함께 준다.
    -- used 는 "오늘 몇 번 썼는지" 표시용으로만 보낸다 (한도가 없으니 limit 은 0).
    return json_build_object(
      'unlimited', true, 'coupon_until', until, 'guest', false,
      'used', by_user, 'limit', 0,
      'open', open_n, 'open_limit', l.per_ip_open,
      'site_full', total >= l.total_daily);
  end if;

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

-- 7) 관리자용: 쿠폰 만들기 · 목록 · 끄기
create or replace function public.admin_create_coupon(
  p_code text, p_grant_days int default 30, p_max_uses int default null,
  p_expires_at timestamptz default null, p_note text default null)
returns json language plpgsql security definer set search_path = public as $$
declare norm text;
begin
  if not is_admin() then return json_build_object('ok', false, 'reason', 'not_admin'); end if;

  norm := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  if norm !~ '^[A-Z0-9]{4,24}$' then
    return json_build_object('ok', false, 'reason', 'bad_code');
  end if;
  if exists (select 1 from coupons where code = norm) then
    return json_build_object('ok', false, 'reason', 'duplicate');
  end if;

  insert into coupons (code, grant_days, max_uses, expires_at, note)
  values (norm, p_grant_days, p_max_uses, p_expires_at, p_note);

  return json_build_object('ok', true, 'code', norm);
end;
$$;
revoke all on function public.admin_create_coupon(text, int, int, timestamptz, text) from public;
grant execute on function public.admin_create_coupon(text, int, int, timestamptz, text) to authenticated;

create or replace function public.admin_coupons()
returns json language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then return '[]'::json; end if;
  return coalesce((
    select json_agg(x order by x.created_at desc) from (
      select c.code, c.grant_days, c.max_uses, c.used_count, c.expires_at, c.note, c.active, c.created_at,
             (select count(*) from coupon_grants g where g.code = c.code and g.valid_until > now()) as active_now
      from coupons c
    ) x), '[]'::json);
end;
$$;
revoke all on function public.admin_coupons() from public;
grant execute on function public.admin_coupons() to authenticated;

create or replace function public.admin_set_coupon(p_code text, p_active boolean)
returns json language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then return json_build_object('ok', false, 'reason', 'not_admin'); end if;
  update coupons set active = p_active where code = upper(p_code);
  return json_build_object('ok', found);
end;
$$;
revoke all on function public.admin_set_coupon(text, boolean) from public;
grant execute on function public.admin_set_coupon(text, boolean) to authenticated;

-- 확인용: 지금 값 보기
-- select * from public.coupons;
-- select * from public.coupon_grants where valid_until > now();
