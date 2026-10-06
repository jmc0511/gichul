-- 문제 신고 · 이 문제만 다시 · 친구와 점수 비교 · 계정 삭제.
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 한 번. (supabase-ops.sql 다음)

-- 1) 문제 신고 ---------------------------------------------------------------
create table if not exists public.reports (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  exam_id     uuid not null,
  q_index     int not null,
  question    jsonb,                  -- 신고 당시 문제 (시험지에서 복사)
  reason      text not null check (char_length(reason) <= 40),
  note        text check (char_length(note) <= 500),
  client_ip   text,
  resolved_at timestamptz
);
create index if not exists reports_open on public.reports (resolved_at, created_at desc);
alter table public.reports enable row level security;
revoke all on public.reports from anon, authenticated;

create or replace function public.report_question(exam uuid, idx int, reason text, note text default null)
returns boolean
language plpgsql security definer set search_path = public as $$
#variable_conflict use_variable
declare ip text := client_ip(); q jsonb; n int;
begin
  select e.questions -> idx into q from exams e where e.id = exam;
  if q is null then return false; end if;
  select count(*) into n from reports r where r.client_ip = ip and r.created_at > now() - interval '1 day';
  if n >= 30 then raise exception 'limit_report' using errcode = 'P0001'; end if;
  insert into reports (exam_id, q_index, question, reason, note, client_ip)
  values (exam, idx, q, left(reason, 40), nullif(left(coalesce(note, ''), 500), ''), ip);
  return true;
end;
$$;
revoke all on function public.report_question(uuid, int, text, text) from public;
grant execute on function public.report_question(uuid, int, text, text) to anon, authenticated;

-- 관리자: 신고 목록 · 처리 완료
create or replace function public.admin_reports()
returns table (id bigint, created_at timestamptz, exam_id uuid, q_index int, question jsonb, reason text, note text, title text, same_q int)
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not exists (select 1 from admins where user_id = auth.uid()) then
    raise exception 'not_admin' using errcode = 'P0001';
  end if;
  return query
    select r.id, r.created_at, r.exam_id, r.q_index, r.question, r.reason, r.note, e.title,
           (select count(*)::int from reports x where x.exam_id = r.exam_id and x.q_index = r.q_index and x.resolved_at is null)
    from reports r left join exams e on e.id = r.exam_id
    where r.resolved_at is null order by r.created_at desc limit 50;
end;
$$;
revoke all on function public.admin_reports() from public, anon;
grant execute on function public.admin_reports() to authenticated;

create or replace function public.admin_resolve_report(rid bigint)
returns boolean
language plpgsql security definer set search_path = public as $$
declare r reports;
begin
  if auth.uid() is null or not exists (select 1 from admins where user_id = auth.uid()) then
    raise exception 'not_admin' using errcode = 'P0001';
  end if;
  select * into r from reports where id = rid;
  if not found then return false; end if;
  -- 같은 문제에 대한 신고를 한꺼번에 처리
  update reports set resolved_at = now() where exam_id = r.exam_id and q_index = r.q_index and resolved_at is null;
  return true;
end;
$$;
revoke all on function public.admin_resolve_report(bigint) from public, anon;
grant execute on function public.admin_resolve_report(bigint) to authenticated;

-- 2) 이 문제만 다시 -----------------------------------------------------------
alter table public.requests add column if not exists regen_exam uuid;  -- 바꿀 시험지
alter table public.requests add column if not exists regen_idx  int;   -- 바꿀 문제 번호(0부터)

-- 시험지를 만든 요청 id를 아는 사람만 (= 요청한 사람)
create or replace function public.regen_question(src uuid, idx int, new_id uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare r requests; n int;
begin
  select * into r from requests where id = src;
  if not found or r.status <> 'done' or r.material = '' or r.exam_id is null then return false; end if;
  select jsonb_array_length(questions) into n from exams where id = r.exam_id;
  if n is null or idx < 0 or idx >= n then return false; end if;
  -- 같은 시험지에 이미 진행 중인 '문제 다시'가 있으면 거절
  if exists (select 1 from requests where regen_exam = r.exam_id and status in ('pending', 'working')) then
    raise exception 'regen_busy' using errcode = 'P0001';
  end if;
  insert into requests (id, subject, files, pages, instructions, material, images, retry_of, regen_exam, regen_idx)
  values (new_id, r.subject, r.files, r.pages, r.instructions, r.material, r.images, src, r.exam_id, idx);
  return true;
end;
$$;
revoke all on function public.regen_question(uuid, int, uuid) from public;
grant execute on function public.regen_question(uuid, int, uuid) to anon, authenticated;

-- 내 요청 목록에 '문제 다시' 정보 추가
drop function if exists public.get_requests(uuid[]);
create function public.get_requests(ids uuid[])
returns table (id uuid, created_at timestamptz, status text, subject text, files text[], exam_id uuid, error text, progress text,
               reusable boolean, retry_of uuid, regen_exam uuid, regen_idx int)
language sql stable security definer set search_path = public as $$
  select r.id, r.created_at, r.status, r.subject, r.files, r.exam_id, r.error, r.progress,
         r.status in ('done', 'error') and r.material <> '', r.retry_of, r.regen_exam, r.regen_idx
  from requests r where r.id = any(ids[1:30]) order by r.created_at desc;
$$;
revoke all on function public.get_requests(uuid[]) from public;
grant execute on function public.get_requests(uuid[]) to anon, authenticated;

-- 요청을 지울 때 '문제 다시' 요청은 시험지를 지우지 않음 (시험지는 원래 요청의 것)
create or replace function public.delete_request(req uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from exams where request_id = req;
  delete from requests where id = req or (regen_exam is not null and retry_of = req);
  get diagnostics n = row_count;
  return n > 0;
end;
$$;
revoke all on function public.delete_request(uuid) from public;
grant execute on function public.delete_request(uuid) to anon, authenticated;

-- 3) 친구와 점수 비교 ---------------------------------------------------------
create table if not exists public.scores (
  exam_id     uuid not null references public.exams (id) on delete cascade,
  player      uuid not null,                 -- 브라우저마다 만든 무작위 id
  name        text not null check (char_length(name) between 1 and 12),
  got         int not null,
  total       int not null,
  created_at  timestamptz not null default now(),
  client_ip   text,
  primary key (exam_id, player)
);
alter table public.scores enable row level security;
revoke all on public.scores from anon, authenticated;

-- 같은 사람은 최고 점수만 남김
create or replace function public.submit_score(exam uuid, who uuid, nick text, got int, total int)
returns boolean
language plpgsql security definer set search_path = public as $$
#variable_conflict use_variable
declare ip text := client_ip(); n int;
begin
  if not exists (select 1 from exams where id = exam) then return false; end if;
  if total < 1 or total > 1000 or got < 0 or got > total then return false; end if;
  select count(*) into n from scores s where s.exam_id = exam and s.client_ip = ip and s.player <> who;
  if n >= 10 then raise exception 'limit_score' using errcode = 'P0001'; end if;
  insert into scores (exam_id, player, name, got, total, client_ip)
  values (exam, who, left(trim(nick), 12), got, total, ip)
  on conflict (exam_id, player) do update
    set name = excluded.name,
        got = greatest(scores.got, excluded.got),
        created_at = case when excluded.got > scores.got then now() else scores.created_at end;
  return true;
end;
$$;
revoke all on function public.submit_score(uuid, uuid, text, int, int) from public;
grant execute on function public.submit_score(uuid, uuid, text, int, int) to anon, authenticated;

-- 시험지 id를 아는 사람(= 링크를 받은 사람)만 순위를 봄. player 는 본인 것만 알아볼 수 있게 그대로 돌려줌
create or replace function public.get_scores(exam uuid)
returns table (player uuid, name text, got int, total int, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select s.player, s.name, s.got, s.total, s.created_at from scores s
  where s.exam_id = exam order by (s.got::float / s.total) desc, s.created_at asc limit 30;
$$;
revoke all on function public.get_scores(uuid) from public;
grant execute on function public.get_scores(uuid) to anon, authenticated;

-- 하루 청소에 '180일 지난 신고 지우기' 추가 (개인정보처리방침의 보관 기간)
create or replace function public.purge_old_requests(keep_days int default 14)
returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update requests set material = '', images = null
  where status in ('done', 'error') and created_at < now() - make_interval(days => keep_days)
    and (material <> '' or images is not null);
  get diagnostics n = row_count;
  delete from request_log where created_at < now() - interval '30 days';
  delete from reports where created_at < now() - interval '180 days';
  return n;
end;
$$;
revoke all on function public.purge_old_requests(int) from public, anon, authenticated;
grant execute on function public.purge_old_requests(int) to service_role;

-- 4) 계정 삭제 (개인정보처리방침의 '탈퇴') ---------------------------------------
-- 로그인한 본인 계정과, 그 계정에 저장된 내 요청·시험지를 모두 지움
create or replace function public.delete_my_account()
returns boolean
language plpgsql security definer set search_path = public, auth as $$
declare uid uuid := auth.uid(); d user_data;
begin
  if uid is null then return false; end if;
  select * into d from user_data where user_id = uid;
  if found then
    delete from exams where request_id in (select (jsonb_array_elements_text(d.reqs))::uuid);
    delete from requests where id in (select (jsonb_array_elements_text(d.reqs))::uuid);
  end if;
  delete from auth.users where id = uid;  -- user_data 는 on delete cascade 로 함께 지워짐
  return true;
end;
$$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
