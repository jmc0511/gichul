-- 요청 한도 값 바꾸기.
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 Run.
-- 표 구조는 supabase-limits.sql 이 만든다. 이 파일은 **값만** 바꾼다.
-- 나중에 또 바꿀 때는 아래 숫자만 고쳐 다시 실행하면 된다.
--
-- 2026-11-16: 회원 하루 한도를 5 → 20 으로. 게스트는 2 그대로.

-- 1) 바꾸기 전 값 (실행 결과 첫 표)
select '바꾸기 전' as when, guest_daily, member_daily, per_ip_daily, per_ip_open, total_daily
from public.limits where id = 1;

-- 2) 값 적용
update public.limits set
  member_daily = 20,
  -- 같은 IP 상한은 계정 여러 개를 막는 용도라 회원 한도보다 넉넉해야 한다.
  -- 이게 회원 한도보다 낮으면 회원이 20번을 못 채우고 먼저 막힌다.
  per_ip_daily = greatest(per_ip_daily, 30)
where id = 1;

-- 3) 바꾼 뒤 값 + 사이트 전체 한도가 충분한지 점검 (실행 결과 둘째 표)
select
  '바꾼 뒤' as when, guest_daily, member_daily, per_ip_daily, per_ip_open, total_daily,
  case
    when total_daily < member_daily * 5
      then '⚠ 사이트 전체 한도가 낮습니다. 몇 사람만 써도 하루치가 다 찹니다'
    else '전체 한도 여유 있음'
  end as 전체한도_점검
from public.limits where id = 1;
