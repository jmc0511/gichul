-- 보안 점검(2026-11-24)에서 나온 두 가지 보완.
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 한 번.

-- ──────────────────────────────────────────────────────────────
-- 1) 쿠폰 코드 추측 막기
--    redeem_coupon 에 시도 제한이 없어, 계정 하나로 코드를 무한정 넣어 볼 수 있었다.
--    맞히면 하루 한도를 건너뛰므로 손해는 소유자의 Claude 사용량이다.
-- ──────────────────────────────────────────────────────────────
create table if not exists public.coupon_tries (
  id        bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  client_ip text,
  user_id   uuid,
  code      text
);
create index if not exists coupon_tries_ip   on public.coupon_tries (client_ip, at desc);
create index if not exists coupon_tries_user on public.coupon_tries (user_id, at desc);
alter table public.coupon_tries enable row level security;
revoke all on public.coupon_tries from anon, authenticated;

alter table public.limits add column if not exists coupon_tries_daily int not null default 20;

/* 쿠폰 등록. 2026-11-17 본문 + 시도 제한.
   실패도 한 번으로 세고, 같은 코드를 이미 쓴 경우(already)는 세지 않는다(사용자가 다시 눌러 볼 수 있게). */
create or replace function public.redeem_coupon(p_code text)
returns json language plpgsql security definer set search_path = public as $$
declare c coupons; uid uuid := auth.uid(); ip text := client_ip();
        norm text; until timestamptz; tries int; cap int;
begin
  if uid is null or is_guest() then
    return json_build_object('ok', false, 'reason', 'login_required');
  end if;

  norm := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  if norm = '' then return json_build_object('ok', false, 'reason', 'empty'); end if;

  -- 이미 쓴 코드면 횟수를 더 올리지도, 시도로 세지도 않는다
  if exists (select 1 from coupon_grants where user_id = uid and code = norm) then
    select valid_until into until from coupon_grants where user_id = uid and code = norm;
    return json_build_object('ok', false, 'reason', 'already', 'until', until);
  end if;

  select coupon_tries_daily into cap from limits where id = 1;
  select count(*) into tries from coupon_tries
   where at > now() - interval '1 day' and (user_id = uid or client_ip = ip);
  if tries >= cap then
    return json_build_object('ok', false, 'reason', 'too_many');
  end if;
  insert into coupon_tries (client_ip, user_id, code) values (ip, uid, norm);
  delete from coupon_tries where at < now() - interval '7 days';

  select * into c from coupons where code = norm;
  if not found or not c.active then
    return json_build_object('ok', false, 'reason', 'not_found');
  end if;
  if c.expires_at is not null and c.expires_at <= now() then
    return json_build_object('ok', false, 'reason', 'expired');
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

-- ──────────────────────────────────────────────────────────────
-- 2) IP 판정에서 위조 가능한 값 쓰지 않기
--    x-forwarded-for 의 **맨 앞**을 쓰면 공격자가 보낸 값이 그대로 들어온다
--    (Cloudflare 는 진짜 IP 를 **뒤에** 붙인다). 맨 뒤를 쓰면 위조해도 소용없다.
-- ──────────────────────────────────────────────────────────────
create or replace function public.client_ip()
returns text language sql stable as $$
  with h as (select string_to_array(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ',') a)
  select coalesce(
    nullif(current_setting('request.headers', true)::json ->> 'cf-connecting-ip', ''),
    -- 맨 뒤 = 가장 가까운 프록시가 적은 값 (앞쪽은 클라이언트가 지어낼 수 있다)
    (select nullif(trim(a[array_length(a, 1)]), '') from h),
    'unknown')
$$;

-- 확인
select public.client_ip() as 지금_내_ip, (select coupon_tries_daily from limits where id = 1) as 쿠폰_하루시도;
