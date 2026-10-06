-- 로그인(게스트·구글) + 기기 간 동기화.
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 한 번.

-- 1) 사용자별 데이터: 내 요청 id, 내 시험지 id, 오답노트
create table if not exists public.user_data (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  reqs        jsonb not null default '[]',
  exams       jsonb not null default '[]',
  wrongs      jsonb not null default '[]',
  updated_at  timestamptz not null default now()
);
alter table public.user_data enable row level security;
revoke all on public.user_data from anon;
grant select, insert, update, delete on public.user_data to authenticated;

drop policy if exists "own data" on public.user_data;
create policy "own data" on public.user_data for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 크기 제한 (오답노트 300문항 정도)
alter table public.user_data drop constraint if exists user_data_size;
alter table public.user_data add constraint user_data_size check (pg_column_size(wrongs) < 2000000);

-- 2) 로그인한 사용자(게스트 포함)도 지금까지 방문자(anon)가 하던 일을 그대로 할 수 있게
grant insert (id, subject, files, pages, instructions, material, images) on public.requests to authenticated;
drop policy if exists "signed-in users submit requests" on public.requests;
create policy "signed-in users submit requests" on public.requests for insert to authenticated with check (true);

grant execute on function public.get_requests(uuid[]) to authenticated;
grant execute on function public.get_exams(uuid[])    to authenticated;
grant execute on function public.delete_request(uuid) to authenticated;
grant execute on function public.my_quota()           to authenticated;

drop policy if exists "signed-in users upload request images" on storage.objects;
create policy "signed-in users upload request images" on storage.objects
  for insert to authenticated with check (bucket_id = 'request-images');
