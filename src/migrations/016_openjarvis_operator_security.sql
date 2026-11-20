-- OpenJarvis operator boundary: durable replay protection and one-shot actions.
-- Idempotent and additive; older releases safely ignore these objects.

CREATE TABLE IF NOT EXISTS operator_request_nonces (
  request_id UUID PRIMARY KEY,
  organization_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK (expires_at > requested_at)
);

CREATE INDEX IF NOT EXISTS operator_request_nonces_expiry_idx
  ON operator_request_nonces (expires_at);

ALTER TABLE agent_actions
  ADD COLUMN IF NOT EXISTS execution_claimed_at TIMESTAMPTZ;

ALTER TABLE agent_actions
  ADD COLUMN IF NOT EXISTS execution_claimed_by TEXT;

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS fullenrich_request_id UUID;
