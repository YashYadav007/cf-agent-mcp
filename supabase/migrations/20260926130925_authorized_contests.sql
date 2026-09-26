create table public.authorized_contests (
  contest_id bigint primary key check (contest_id > 0),
  status text not null check (status in ('active', 'completed', 'blocked')),
  authorized_at timestamptz not null default now(),
  expires_at timestamptz,
  source text not null default 'watcher' check (length(source) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.authorized_contests enable row level security;
revoke all on public.authorized_contests from anon, authenticated;
grant select, insert, update on public.authorized_contests to service_role;
