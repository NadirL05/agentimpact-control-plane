-- Jarvis V1 durable audit (no secrets). Independent of business execution flags.
CREATE TABLE IF NOT EXISTS jarvis_audit_events (
  id BIGSERIAL PRIMARY KEY,
  request_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  organization_id TEXT,
  action TEXT,
  mission_id UUID,
  attempt_id UUID,
  decision TEXT,
  duration_ms INTEGER,
  error_code TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jarvis_audit_events_request_id_idx
  ON jarvis_audit_events (request_id, id);

CREATE INDEX IF NOT EXISTS jarvis_audit_events_created_at_idx
  ON jarvis_audit_events (created_at DESC);
