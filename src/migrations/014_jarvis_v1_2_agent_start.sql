-- Jarvis V1.2 controlled agent.start — durable gates (no publisher, no auto provider).
-- Complements ExecutionControl; does not replace mission_attempts / worktree_leases authority.

CREATE TABLE IF NOT EXISTS jarvis_agent_quota_state (
  worker_type TEXT PRIMARY KEY CHECK (worker_type IN ('codex','cursor')),
  quota_state TEXT NOT NULL CHECK (quota_state IN ('available','limited','exhausted','unknown')),
  source TEXT NOT NULL DEFAULT 'operator',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note TEXT NOT NULL DEFAULT ''
);

INSERT INTO jarvis_agent_quota_state(worker_type, quota_state, source, note)
VALUES
  ('codex', 'unknown', 'operator', 'fail_closed_until_operator_sets_state'),
  ('cursor', 'unknown', 'operator', 'fail_closed_until_operator_sets_state')
ON CONFLICT (worker_type) DO NOTHING;

CREATE TABLE IF NOT EXISTS jarvis_agent_start_approvals (
  approval_id UUID PRIMARY KEY,
  organization_id TEXT NOT NULL,
  mission_id UUID NOT NULL,
  attempt_id UUID NOT NULL,
  worker_type TEXT NOT NULL CHECK (worker_type IN ('codex','cursor')),
  request_id UUID NOT NULL,
  payload_hash TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  budget_ceiling INTEGER NOT NULL CHECK (budget_ceiling > 0),
  actor TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS jarvis_agent_start_approvals_request_idx
  ON jarvis_agent_start_approvals (request_id);

CREATE TABLE IF NOT EXISTS jarvis_agent_budget_reservations (
  id UUID PRIMARY KEY,
  organization_id TEXT NOT NULL,
  mission_id UUID NOT NULL,
  attempt_id UUID NOT NULL,
  worker_type TEXT NOT NULL CHECK (worker_type IN ('codex','cursor')),
  request_id UUID NOT NULL,
  budget_ceiling INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('requested','reserved','consumed','released')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jarvis_agent_start_leases (
  id UUID PRIMARY KEY,
  organization_id TEXT NOT NULL,
  mission_id UUID NOT NULL,
  attempt_id UUID NOT NULL,
  worker_type TEXT NOT NULL CHECK (worker_type IN ('codex','cursor')),
  workspace_id UUID,
  fencing_token UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved','leased','released','quarantined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS jarvis_agent_start_leases_active_attempt_idx
  ON jarvis_agent_start_leases (attempt_id)
  WHERE status IN ('reserved','leased');

CREATE TABLE IF NOT EXISTS jarvis_agent_start_idempotency (
  request_id UUID PRIMARY KEY,
  organization_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  response JSONB NOT NULL,
  provider_called BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
