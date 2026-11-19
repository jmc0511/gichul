-- 손글씨 수식 인식 (손으로 쓴 수식 → LaTeX)
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 한 번.
--
-- 출제 요청(requests)과 **따로** 돈다. 하루 출제 횟수를 깎지 않는다.
-- 다만 로그인 없이 쓰는 경로라, 소유자의 Claude 사용량이 남용되지 않게 IP별 상한만 둔다.

create table if not exists public.ink (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  client_ip   text,
  png         text not null,                       -- 손글씨 그림 (base64, data: 접두사 없이)
  status      text not null default 'pending',     -- pending | working | done | error
  latex       text,
  error       text,
  started_at  timestamptz,
  finished_at timestamptz
);
create index if not exists ink_pending on public.ink (status, created_at);
create index if not exists ink_by_ip on public.ink (client_ip, created_at desc);

alter table public.ink enable row level security;
revoke all on public.ink from anon, authenticated;   -- 아래 함수로만 드나든다

-- 한도: 출제와 따로 센다
alter table public.limits add column if not exists ink_per_ip int not null default 200;

/* 손글씨 보내기. 돌려주는 id 로 결과를 받아 간다.
   막힐 때 reason: too_big(그림이 너무 큼) · limit_ip(오늘 많이 씀) · open(아직 인식 중) */
create or replace function public.ink_new(png text)
returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_variable
declare ip text := client_ip(); cap int; n int; new_id uuid;
begin
  if png is null or length(png) < 100 then return jsonb_build_object('ok', false, 'reason', 'empty'); end if;
  -- base64 기준 2MB. 캔버스 한 장이면 보통 100KB 아래다
  if length(png) > 2000000 then return jsonb_build_object('ok', false, 'reason', 'too_big'); end if;

  select ink_per_ip into cap from limits where id = 1;
  select count(*) into n from ink i where i.client_ip = ip and i.created_at > now() - interval '1 day';
  if n >= cap then return jsonb_build_object('ok', false, 'reason', 'limit_ip'); end if;

  -- 같은 사람이 한꺼번에 여러 장 던지지 못하게 (기다리는 중인 게 있으면 거절)
  select count(*) into n from ink i
   where i.client_ip = ip and i.status in ('pending', 'working') and i.created_at > now() - interval '5 minutes';
  if n >= 2 then return jsonb_build_object('ok', false, 'reason', 'open'); end if;

  insert into ink (client_ip, png) values (ip, png) returning id into new_id;
  return jsonb_build_object('ok', true, 'id', new_id);
end;
$$;

/* 결과 받아 가기. 그림(png)은 돌려주지 않는다 */
create or replace function public.ink_get(ink_id uuid)
returns jsonb
language sql security definer set search_path = public as $$
  select coalesce(
    (select jsonb_build_object('status', i.status, 'latex', i.latex, 'error', i.error) from ink i where i.id = ink_id),
    jsonb_build_object('status', 'gone'))
$$;

revoke all on function public.ink_new(text) from public;
revoke all on function public.ink_get(uuid) from public;
grant execute on function public.ink_new(text) to anon, authenticated;
grant execute on function public.ink_get(uuid) to anon, authenticated;

/* 청소: 손글씨는 오래 둘 이유가 없다. 하루 지난 것은 지운다 (처리기가 하루 한 번 부른다) */
create or replace function public.purge_old_ink(keep_hours int default 24)
returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from ink where created_at < now() - make_interval(hours => keep_hours);
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.purge_old_ink(int) from public, anon, authenticated;
grant execute on function public.purge_old_ink(int) to service_role;

-- 확인
select ink_per_ip from limits where id = 1;
