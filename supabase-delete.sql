-- 요청 취소 / 내 시험지 삭제.
-- 요청 id(요청한 브라우저만 알고 있음)를 아는 사람만 그 요청과 거기서 나온 시험지를 지울 수 있음.
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 한 번.

create or replace function public.delete_request(req uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from exams where request_id = req;
  delete from requests where id = req;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

revoke all on function public.delete_request(uuid) from public;
grant execute on function public.delete_request(uuid) to anon;
