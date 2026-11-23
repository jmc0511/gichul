-- 처리기가 "마지막으로 손댄 시각"을 따로 둔다.
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 한 번.
--
-- 끊긴 요청을 되살리는 기준(resetStale)으로 started_at 을 밀었더니
-- finished_at - started_at 이 더 이상 '걸린 시간'이 아니게 됐다. 칸을 나눈다.
--   started_at  = 집어 든 시각 (안 바뀜 → 걸린 시간 계산용)
--   touched_at  = 마지막 진행 기록 (계속 밀림 → 살아 있는지 판정용)

alter table public.requests add column if not exists touched_at timestamptz;

-- 지금 돌고 있는 것이 있으면 기준을 채워 둔다
update public.requests set touched_at = started_at where status = 'working' and touched_at is null;

select count(*) filter (where status = 'working') as 진행중, count(*) filter (where touched_at is not null) as 기록있음 from public.requests;
