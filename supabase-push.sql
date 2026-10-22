-- 시험지 완성 알림(앱 푸시).
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 한 번.
-- 앱이 기기 토큰과 "결과를 기다리는 요청 id"를 넣어 두면,
-- 요청이 done·error 가 될 때 Database Webhook 이 Edge Function(push-exam-ready)을 불러 알림을 보낸다.

-- 1) 알림 받을 기기
create table if not exists public.push_devices (
  device      text primary key,                                    -- FCM 토큰
  user_id     uuid references auth.users (id) on delete cascade,   -- 로그인한 경우에만
  platform    text check (platform in ('ios', 'android')),
  updated_at  timestamptz not null default now()
);

-- 2) 어떤 요청의 결과를 어느 기기로 알려 줄지
--    (요청은 id 를 아는 사람만 볼 수 있는 구조라, 알림도 같은 방식으로 요청 id 로 묶는다)
create table if not exists public.push_watch (
  request_id  uuid not null references public.requests (id) on delete cascade,
  device      text not null references public.push_devices (device) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (request_id, device)
);
create index if not exists push_watch_request on public.push_watch (request_id);

alter table public.push_devices enable row level security;
alter table public.push_watch   enable row level security;
revoke all on public.push_devices from anon, authenticated;
revoke all on public.push_watch   from anon, authenticated;

-- 3) 앱이 부르는 등록 함수. 기기 토큰과 기다리는 요청 id 를 넣는다.
-- (칸 이름과 헷갈리지 않게 인자 이름은 앞에 p_ 를 붙인다. 앱이 보내는 이름도 이것과 같아야 한다)
create or replace function public.register_push(p_device text, p_platform text, p_reqs uuid[])
returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_device is null or length(p_device) < 20 or length(p_device) > 500 then
    raise exception 'bad device token';
  end if;

  insert into push_devices (device, user_id, platform, updated_at)
  values (p_device, auth.uid(), case when p_platform in ('ios', 'android') then p_platform end, now())
  on conflict (device) do update
    set user_id = excluded.user_id, platform = excluded.platform, updated_at = now();

  -- 있는 요청만, 그리고 아직 안 끝난 것만 (끝난 요청은 알릴 일이 없다)
  insert into push_watch (request_id, device)
  select r.id, p_device from requests r
   where r.id = any(p_reqs[1:30]) and r.status in ('pending', 'working')
  on conflict do nothing;
end;
$$;
revoke all on function public.register_push(text, text, uuid[]) from public;
grant execute on function public.register_push(text, text, uuid[]) to anon, authenticated;

-- 4) 청소: 오래된 기기(6개월 넘게 소식 없음)와 남은 감시 줄 지우기.
--    처리기가 하루 한 번 부르는 purge_old_requests 옆에서 같이 돌리면 된다.
create or replace function public.purge_push()
returns int
language sql security definer set search_path = public as $$
  with gone as (
    delete from push_devices where updated_at < now() - interval '180 days' returning 1
  ) select count(*)::int from gone;
$$;
revoke all on function public.purge_push() from public;
