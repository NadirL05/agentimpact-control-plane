-- Missions longues asynchrones : mode livraison + idempotence event_id + notification Slack.

alter table slack_gateway_inbox
  add column if not exists delivery_mode text not null default 'sync',
  add column if not exists mission_title text,
  add column if not exists slack_started_at timestamptz,
  add column if not exists slack_notified_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'slack_gateway_inbox_delivery_mode_check'
  ) then
    alter table slack_gateway_inbox
      add constraint slack_gateway_inbox_delivery_mode_check
      check (delivery_mode in ('sync', 'async'));
  end if;
end $$;

alter table slack_gateway_inbox
  drop constraint if exists slack_gateway_inbox_status_check;

alter table slack_gateway_inbox
  add constraint slack_gateway_inbox_status_check
  check (status in (
    'pending',
    'processing',
    'done',
    'failed',
    'cancelled',
    'timeout'
  ));

create unique index if not exists slack_gateway_inbox_event_id_uidx
  on slack_gateway_inbox (event_id);

create index if not exists slack_gateway_inbox_async_notify_idx
  on slack_gateway_inbox (delivery_mode, status, slack_notified_at, created_at)
  where delivery_mode = 'async';
