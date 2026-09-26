create table public.cf_submission_metadata (
  submission_id bigint primary key,
  contest_id bigint not null,
  problem_index text not null,
  language text not null check (language = 'java17'),
  submitted_at timestamptz not null,
  created_at timestamptz not null default now()
);
create table public.cf_submission_attempts (
  attempt_id uuid primary key,
  contest_id bigint not null,
  problem_index text not null,
  language text not null check (language = 'java17'),
  submitted_at timestamptz not null,
  state text not null check (state in ('prepared', 'confirmed', 'uncertain')),
  submission_id bigint,
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now()
);
create index cf_submission_attempts_fingerprint_submitted_at_idx on public.cf_submission_attempts (fingerprint, submitted_at desc);
alter table public.cf_submission_metadata enable row level security;
alter table public.cf_submission_attempts enable row level security;
revoke all on public.cf_submission_metadata, public.cf_submission_attempts from anon, authenticated;
grant select, insert, update on public.cf_submission_metadata, public.cf_submission_attempts to service_role;

create function public.cf_reserve_submission_attempt(
  p_attempt_id uuid, p_contest_id bigint, p_problem_index text, p_language text,
  p_submitted_at timestamptz, p_fingerprint text, p_window_seconds integer
) returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if p_language <> 'java17' or p_window_seconds < 1 or p_window_seconds > 3600
     or p_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid submission reservation';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_fingerprint, 0));
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
