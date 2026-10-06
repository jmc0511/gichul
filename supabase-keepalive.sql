-- Supabase 접속 유지용 함수 (GitHub Actions가 하루 한 번 공개 키로 호출)
-- 데이터를 읽거나 바꾸지 않고, DB가 살아 있다는 것만 돌려줌.
create or replace function public.keepalive()
returns text
language sql
stable
as $$ select 'ok ' || now()::text $$;

revoke all on function public.keepalive() from public;
grant execute on function public.keepalive() to anon, authenticated;
