-- 출제 모델 고르기: 꼼꼼하게(기본) / 빠르게
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 한 번.
--
-- 요청마다 어느 모델로 만들지 표시해 둔다. 처리기가 이 값을 보고 --model 을 바꿔 부른다.
-- 기본값은 false(꼼꼼하게) — 품질이 제품이라 빠른 쪽은 고르는 사람만 쓴다.

alter table public.requests add column if not exists fast boolean not null default false;

-- 사이트가 요청을 넣을 때 이 칸도 쓸 수 있게
grant insert (fast) on public.requests to anon;
grant insert (fast) on public.requests to authenticated;

-- 확인
select count(*) filter (where fast) as 빠르게, count(*) filter (where not fast) as 꼼꼼하게 from public.requests;
