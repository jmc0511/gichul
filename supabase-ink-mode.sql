-- 손글씨 인식에 '글자 모드' 추가 (한자·가나·한글을 직접 써서 답하는 문제용).
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 한 번. (supabase-ink.sql 다음)
--
-- 지금까지는 손글씨를 늘 수식(LaTeX)으로 읽었다. 한자 쓰기 문제에서는
-- 「火」를 그리면 $火$ 가 나와 버려서, 무엇으로 읽을지 요청에 적어 둔다.
--   latex = 수식 (기본, 지금까지 하던 것)
--   text  = 보이는 글자 그대로 (한자·히라가나·가타카나·한글·알파벳 …)

alter table public.ink add column if not exists mode text not null default 'latex'
  check (mode in ('latex', 'text'));

/* 손글씨 보내기. mode 를 받도록 바꾼다(안 주면 지금까지처럼 수식).
   막힐 때 reason: too_big · limit_ip · open · empty */
create or replace function public.ink_new(png text, p_mode text default 'latex')
returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_variable
declare ip text := client_ip(); cap int; n int; new_id uuid; m text;
begin
  if png is null or length(png) < 100 then return jsonb_build_object('ok', false, 'reason', 'empty'); end if;
  if length(png) > 2000000 then return jsonb_build_object('ok', false, 'reason', 'too_big'); end if;

  m := case when p_mode = 'text' then 'text' else 'latex' end;

  select ink_per_ip into cap from limits where id = 1;
  select count(*) into n from ink i where i.client_ip = ip and i.created_at > now() - interval '1 day';
  if n >= cap then return jsonb_build_object('ok', false, 'reason', 'limit_ip'); end if;

  select count(*) into n from ink i
   where i.client_ip = ip and i.status in ('pending', 'working') and i.created_at > now() - interval '5 minutes';
  if n >= 2 then return jsonb_build_object('ok', false, 'reason', 'open'); end if;

  insert into ink (client_ip, png, mode) values (ip, png, m) returning id into new_id;
  return jsonb_build_object('ok', true, 'id', new_id);
end;
$$;

-- 옛 이름(인자 하나)도 남겨 둔다 — 캐시된 예전 사이트가 아직 그걸 부를 수 있다
create or replace function public.ink_new(png text)
returns jsonb
language sql security definer set search_path = public as $$
  select public.ink_new(png, 'latex')
$$;

revoke all on function public.ink_new(text, text) from public;
revoke all on function public.ink_new(text) from public;
grant execute on function public.ink_new(text, text) to anon, authenticated;
grant execute on function public.ink_new(text) to anon, authenticated;

-- 확인
select count(*) filter (where mode = 'text') as 글자모드, count(*) filter (where mode = 'latex') as 수식모드 from public.ink;
