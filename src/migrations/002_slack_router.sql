-- Routeur Slack AgentImpact : déduplication, propriété de fil, inbox gateway, audit.

create table if not exists slack_event_dedup (
  team_id text not null,
  event_id text not null,
  seen_at timestamptz not null default now(),
  primary key (team_id, event_id)
);

create index if not exists slack_event_dedup_seen_at_idx on slack_event_dedup (seen_at);

create table if not exists slack_thread_owners (
  thread_key text primary key,
  team_id text not null,
  channel_id text not null,
  thread_root_ts text not null,
  owner text not null check (owner in ('hermes', 'grok', 'codex', 'ana', 'devin', 'native')),
  assigned_at timestamptz not null default now(),
  constraint slack_thread_owners_root_unique unique (team_id, channel_id, thread_root_ts)
);

create table if not exists slack_gateway_inbox (
  id uuid primary key default gen_random_uuid(),
  target text not null check (target in ('hermes', 'ana')),
  prompt text not null,
  channel_id text not null,
  thread_ts text not null,
  user_id text not null,
  event_id text not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'done', 'failed')),
  response_text text,
  run_id text,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists slack_gateway_inbox_target_status_idx
  on slack_gateway_inbox (target, status, created_at);

create table if not exists slack_router_runs (
  id uuid primary key default gen_random_uuid(),
  event_id text not null,
  thread_key text not null,
  route text not null,
  status text not null,
  duration_ms integer not null,
  run_id text,
  created_at timestamptz not null default now()
);

create index if not exists slack_router_runs_thread_key_idx on slack_router_runs (thread_key);
create index if not exists slack_router_runs_created_at_idx on slack_router_runs (created_at);
