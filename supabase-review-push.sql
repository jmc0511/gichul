-- 오늘 복습할 문제가 있으면 아침에 한 번 알려 주는 알림.
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 한 번. (supabase-push.sql 다음)
--
-- 오답노트는 '틀리면 오늘 → 맞히면 1일 뒤 → 또 맞히면 3일 뒤 → 세 번 맞히면 졸업' 으로 돌아간다.
-- 그런데 복습할 날이 됐다는 걸 알려 주는 장치가 없어서, 앱을 직접 열어야만 알 수 있었다.
-- 로그인한 사람의 오답노트는 user_data.wrongs 에 올라와 있으므로 서버에서 셀 수 있다.

alter table public.push_devices add column if not exists review_on      boolean not null default true;
alter table public.push_devices add column if not exists review_sent_at timestamptz;

/* 지금 알림을 보낼 기기와 복습할 문항 수.
   - 로그인한 기기만 (오답노트가 서버에 올라와 있어야 셀 수 있다)
   - 복습할 게 하나도 없으면 보내지 않는다
   - 하루에 한 번만 (20시간 안에 보냈으면 건너뛴다) */
create or replace function public.review_push_targets()
returns table (device text, platform text, due int)
language sql security definer set search_path = public as $$
  select d.device, d.platform, c.due
  from push_devices d
  join user_data u on u.user_id = d.user_id
  cross join lateral (
    select count(*)::int as due
    from jsonb_array_elements(u.wrongs) w
    where (w ->> 'due') is null
       or (w ->> 'due')::numeric <= extract(epoch from now()) * 1000
  ) c
  where d.user_id is not null
    and d.review_on
    and c.due > 0
    and (d.review_sent_at is null or d.review_sent_at < now() - interval '20 hours')
$$;

/* 보냈다고 표시 (같은 날 또 보내지 않게) */
create or replace function public.review_push_sent(p_devices text[])
returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update push_devices set review_sent_at = now() where device = any(p_devices);
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.review_push_targets() from public, anon, authenticated;
revoke all on function public.review_push_sent(text[]) from public, anon, authenticated;
grant execute on function public.review_push_targets() to service_role;
grant execute on function public.review_push_sent(text[]) to service_role;

/* 앱에서 끄고 켜기. 남의 기기를 건드리지 못하게, 로그인한 기기는 본인 것만 바꿀 수 있다 */
create or replace function public.set_review_push(p_device text, p_on boolean)
returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update push_devices set review_on = p_on
   where device = p_device and (user_id is null or user_id = auth.uid());
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

/* 지금 켜져 있는지 (없는 기기면 null) */
create or replace function public.my_review_push(p_device text)
returns boolean
language sql security definer set search_path = public as $$
  select review_on from push_devices
   where device = p_device and (user_id is null or user_id = auth.uid())
$$;

revoke all on function public.set_review_push(text, boolean) from public;
revoke all on function public.my_review_push(text) from public;
grant execute on function public.set_review_push(text, boolean) to anon, authenticated;
grant execute on function public.my_review_push(text) to anon, authenticated;

-- 확인
select count(*) as 알림_받을_기기 from public.push_devices where review_on;
