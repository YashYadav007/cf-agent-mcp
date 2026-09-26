-- One active, version-checked future wakeup per orchestrated contest run.
-- Existing rows remain unscheduled until their next manual or discovery pass.
alter table public.cf_contest_runs
  add column next_reconcile_at timestamptz,
  add column next_reconcile_reason text check (next_reconcile_reason in
    ('registration', 'start', 'problem', 'manual_auth', 'rating')),
  add column scheduled_task_name text,
  add column last_rating_check_at timestamptz,
  add constraint cf_contest_runs_wakeup_fields_check check (
    (next_reconcile_at is null and next_reconcile_reason is null and scheduled_task_name is null)
    or (next_reconcile_at is not null and next_reconcile_reason is not null and scheduled_task_name is not null)
  );

create index cf_contest_runs_next_reconcile_idx
  on public.cf_contest_runs (next_reconcile_at)
  where next_reconcile_at is not null;
