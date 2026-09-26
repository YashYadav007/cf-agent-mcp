-- Extends the applied contest-run schema without changing earlier migrations.
-- A run is created before official problems are published, then fixes four indices at contest start.
alter table public.cf_contest_runs
  drop constraint if exists cf_contest_runs_problem_order_check;
alter table public.cf_contest_runs
  add constraint cf_contest_runs_problem_order_check check (cardinality(problem_order) in (0, 4));

alter table public.cf_contest_runs
  add column run_id uuid not null default gen_random_uuid(),
  add column contest_name text,
  add column selected_division text not null default 'Div.1',
  add column handle text,
  add column rating_before integer,
  add column rating_after integer,
  add column rating_delta integer,
  add column rank_after text,
  add column max_rating_after integer,
  add column rated_for_account boolean,
  add column rating_source text,
  add column registration_status text,
  add column registration_confirmed_at timestamptz,
  add column contest_start_at timestamptz,
  add column current_problem_ordinal smallint check (current_problem_ordinal between 1 and 4),
  add column orchestration_state text,
  add column last_error_code text,
  add column last_error_message text,
  add column rating_deadline_at timestamptz,
  add column pending_operation text check (pending_operation in ('registration_status','registration','problem_fetch','submission','verdict','contest_state')),
  add column auth_required_at timestamptz,
  add column auth_recovered_at timestamptz,
  add column last_auth_check_at timestamptz,
  add column recovery_reason text,
  add column resume_state text,
  add column lease_owner uuid,
  add column lease_expires_at timestamptz;
alter table public.cf_contest_runs add constraint cf_contest_runs_run_id_key unique (run_id);
alter table public.cf_contest_runs add constraint cf_contest_runs_division_check check (selected_division = 'Div.1');
create index cf_contest_runs_orchestration_state_idx on public.cf_contest_runs (orchestration_state, contest_start_at);

create table public.cf_contest_run_problems (
  run_id uuid not null references public.cf_contest_runs(run_id) on delete cascade,
  ordinal smallint not null check (ordinal between 1 and 4),
  problem_index text not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  state text not null check (state in ('waiting','triggering','triggered','submitted','done','missed')),
  triggered_at timestamptz,
  github_branch text,
  github_pr_number integer,
  submission_id bigint unique,
  verdict text,
  last_error_code text,
  version bigint not null default 0 check (version >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (run_id, ordinal),
  unique (run_id, problem_index),
  check (window_end > window_start)
);
alter table public.cf_contest_run_problems enable row level security;
revoke all on public.cf_contest_run_problems from anon, authenticated;
grant select, insert, update on public.cf_contest_run_problems to service_role;

-- Keep the prior fingerprint guard, and add a contest/problem guard only for
-- orchestrated runs. An uncertain prepared attempt also occupies the one slot.
create or replace function public.cf_reserve_submission_attempt(
  p_attempt_id uuid, p_contest_id bigint, p_problem_index text, p_language text,
  p_submitted_at timestamptz, p_fingerprint text, p_window_seconds integer
) returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if p_language <> 'java17' or p_window_seconds < 1 or p_window_seconds > 3600
     or p_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid submission reservation';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'cf-problem:' || p_contest_id::text || ':' || pg_catalog.upper(p_problem_index), 0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_fingerprint, 0));
  if exists (select 1 from public.cf_contest_runs r
             where r.contest_id = p_contest_id and r.orchestration_state is not null) then
    if not exists (select 1 from public.cf_contest_runs r
      join public.cf_contest_run_problems p on p.run_id = r.run_id
      where r.contest_id = p_contest_id and pg_catalog.upper(p.problem_index) = pg_catalog.upper(p_problem_index)) then
      return false;
    end if;
    if exists (select 1 from public.cf_submission_attempts a
      where a.contest_id = p_contest_id and pg_catalog.upper(a.problem_index) = pg_catalog.upper(p_problem_index)) then
      return false;
    end if;
  end if;
  if exists (select 1 from public.cf_submission_attempts
             where fingerprint = p_fingerprint and submitted_at >= p_submitted_at - pg_catalog.make_interval(secs => p_window_seconds)) then
    return false;
  end if;
  insert into public.cf_submission_attempts(attempt_id,contest_id,problem_index,language,submitted_at,state,fingerprint)
  values (p_attempt_id,p_contest_id,p_problem_index,p_language,p_submitted_at,'prepared',p_fingerprint);
  return true;
end; $$;
revoke all on function public.cf_reserve_submission_attempt(uuid,bigint,text,text,timestamptz,text,integer) from public, anon, authenticated;
grant execute on function public.cf_reserve_submission_attempt(uuid,bigint,text,text,timestamptz,text,integer) to service_role;

-- MCP submission and watcher run in different processes. This marker is an
-- atomic, safe handoff when Codeforces asks for manual verification.
create function public.cf_mark_submission_manual_auth(p_contest_id bigint, p_problem_index text)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare changed integer;
begin
  update public.cf_contest_runs r
    set resume_state = r.orchestration_state,
        orchestration_state = 'NEEDS_MANUAL_AUTH',
        pending_operation = 'submission',
        auth_required_at = now(),
        auth_recovered_at = null,
        last_auth_check_at = null,
        recovery_reason = 'SESSION_REQUIRES_MANUAL_LOGIN',
        last_error_code = 'SESSION_REQUIRES_MANUAL_LOGIN',
        last_error_message = null,
        version = r.version + 1,
        updated_at = now()
  where r.contest_id = p_contest_id
    and r.orchestration_state in ('PROBLEM_1_TRIGGERED','PROBLEM_2_TRIGGERED',
      'PROBLEM_3_TRIGGERED','PROBLEM_4_TRIGGERED','SUBMISSION_RESULT_UNCERTAIN')
    and exists (select 1 from public.cf_contest_run_problems p
      where p.run_id = r.run_id and p.ordinal = r.current_problem_ordinal
        and p.problem_index = p_problem_index);
  get diagnostics changed = row_count;
  return changed = 1;
end; $$;
revoke all on function public.cf_mark_submission_manual_auth(bigint,text) from public, anon, authenticated;
grant execute on function public.cf_mark_submission_manual_auth(bigint,text) to service_role;
