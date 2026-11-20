-- Jarvis V1.1 safe mutations: durable idempotency + lightweight mission/workspace records.
-- Does not enable business execution or agent providers.

CREATE TABLE IF NOT EXISTS jarvis_mutation_idempotency (
  request_id UUID PRIMARY KEY,
  organization_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jarvis_missions (
  id UUID PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project TEXT NOT NULL,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  requested_worker_type TEXT NOT NULL CHECK (requested_worker_type IN ('codex','cursor')),
  lifecycle_state TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  agent_started BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jarvis_missions_org_idx ON jarvis_missions (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS jarvis_workspaces (
  id UUID PRIMARY KEY,
  organization_id TEXT NOT NULL,
  mission_id UUID NOT NULL REFERENCES jarvis_missions(id),
  attempt_id UUID NOT NULL,
  fencing_token UUID NOT NULL,
  project_id UUID NOT NULL,
  name TEXT NOT NULL,
  branch TEXT NOT NULL,
  deleted BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS jarvis_workspaces_mission_name_alive_idx
  ON jarvis_workspaces (mission_id, name) WHERE deleted = false;

CREATE TABLE IF NOT EXISTS jarvis_fences (
  attempt_id UUID PRIMARY KEY,
  organization_id TEXT NOT NULL,
  fencing_token UUID NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jarvis_test_runs (
  id UUID PRIMARY KEY,
  organization_id TEXT NOT NULL,
  mission_id UUID NOT NULL REFERENCES jarvis_missions(id),
  attempt_id UUID NOT NULL,
  fencing_token UUID NOT NULL,
  profile TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jarvis_agent_stops (
  id UUID PRIMARY KEY,
  organization_id TEXT NOT NULL,
  mission_id UUID NOT NULL REFERENCES jarvis_missions(id),
  attempt_id UUID NOT NULL,
  fencing_token UUID NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
