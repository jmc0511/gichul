-- 보안 강화: 아무나 올릴 수 있는 곳의 남용 막기.
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 한 번.

-- 1) 요청 그림 업로드: 사이트가 만드는 모양(요청id/01.jpg ~ 20.jpg)만, 요청 하나에 20장까지
--    (방문자는 저장소 목록을 볼 수 없어서, 개수는 이 함수가 대신 셈)
create or replace function public.request_image_count(folder text)
returns int language sql stable security definer set search_path = public, storage as $$
  select count(*)::int from storage.objects where bucket_id = 'request-images' and split_part(name, '/', 1) = folder
$$;
revoke all on function public.request_image_count(text) from public;
grant execute on function public.request_image_count(text) to anon, authenticated;

drop policy if exists "visitors upload request images" on storage.objects;
drop policy if exists "signed-in users upload request images" on storage.objects;
drop policy if exists "upload request images (site format only)" on storage.objects;
create policy "upload request images (site format only)" on storage.objects
  for insert to anon, authenticated
  with check (
    bucket_id = 'request-images'
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(0[1-9]|1[0-9]|20)\.jpg$'
    and public.request_image_count(split_part(name, '/', 1)) < 20
  );
update storage.buckets set allowed_mime_types = array['image/jpeg'], file_size_limit = 3145728 where id = 'request-images';

-- 2) 계정별 동기화 데이터 크기 줄이기 (오답노트 300문항이면 보통 0.5MB 안쪽)
alter table public.user_data drop constraint if exists user_data_size;
alter table public.user_data add constraint user_data_size check (
  pg_column_size(wrongs) < 1000000
  and jsonb_array_length(reqs) <= 30
  and jsonb_array_length(exams) <= 30
);

-- 확인
select policyname from pg_policies where tablename = 'objects' and policyname like 'upload request images%';
