-- 공부자료 속 그림·스캔 페이지를 이미지로 함께 보내기.
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 한 번.

-- 1) 요청에 이미지 목록 칸 추가 ([{path, label}], 최대 20장)
alter table public.requests add column if not exists images jsonb;
alter table public.requests drop constraint if exists images_max;
alter table public.requests add constraint images_max check (images is null or jsonb_array_length(images) <= 20);
grant insert (images) on public.requests to anon;

-- 2) 비공개 저장소: 방문자는 올리기만, 읽기·삭제는 처리기(비밀 키)만
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('request-images', 'request-images', false, 3145728, array['image/jpeg', 'image/png'])
on conflict (id) do nothing;

drop policy if exists "visitors upload request images" on storage.objects;
create policy "visitors upload request images" on storage.objects
  for insert to anon with check (bucket_id = 'request-images');
