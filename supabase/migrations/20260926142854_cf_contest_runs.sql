-- Server-only progress for one controlled four-problem contest run.
-- The watcher/Work orchestration layer performs version-checked updates.
create table public.cf_contest_runs (
  contest_id bigint primary key check (contest_id > 0),
  status text not null check (status in ('planned', 'active', 'completed')),
  problem_order text[] not null check (cardinality(problem_order) = 4),
  current_problem text,
  distinct_problems_started text[] not null default '{}',
  distinct_problems_completed text[] not null default '{}',
  submission_attempts jsonb not null default '{}'::jsonb,
  verdicts jsonb not null default '{}'::jsonb,
  schedule_targets jsonb not null,
  started_at timestamptz,
  completed_at timestamptz,
  version bigint not null default 0 check (version >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cf_contest_runs_completed_time check (status <> 'completed' or completed_at is not null),
  constraint cf_contest_runs_started_limit check (cardinality(distinct_problems_started) <= 4),
  constraint cf_contest_runs_completed_limit check (cardinality(distinct_problems_completed) <= 4)
);

alter table public.cf_contest_runs enable row level security;
revoke all on public.cf_contest_runs from anon, authenticated;
grant select, insert, update on public.cf_contest_runs to service_role;
