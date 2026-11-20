-- Linear is a read-only projection of AgentImpact missions. No prompt/result is stored here.
BEGIN;
CREATE TABLE IF NOT EXISTS linear_mission_links (
  source_kind text NOT NULL CHECK (source_kind IN ('agent_mission', 'async_inbox')),
  source_id uuid NOT NULL,
  linear_issue_id uuid NOT NULL UNIQUE,
  linear_identifier text,
  linear_url text,
  synced_hash text,
  synced_at timestamptz,
  slack_notified_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  retry_after timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_kind, source_id)
);
CREATE INDEX IF NOT EXISTS linear_mission_links_retry_idx
  ON linear_mission_links (retry_after) WHERE retry_after IS NOT NULL;
COMMIT;
