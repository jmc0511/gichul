-- 시험지 문제에 들어가는 그림 저장소.
-- 주소에 추측할 수 없는 긴 id가 들어가서, 시험지 링크를 가진 사람만 사실상 볼 수 있음.
-- 방문자는 목록 조회·업로드 불가, 올리기는 처리기(비밀 키)만.
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 한 번.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('exam-figures', 'exam-figures', true, 3145728, array['image/jpeg', 'image/png'])
on conflict (id) do update set public = true;
