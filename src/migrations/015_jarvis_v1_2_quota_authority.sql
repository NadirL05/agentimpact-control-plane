-- Jarvis V1.2 Codex/Cursor quota authority — freshness + provenance (idempotent).
-- Preserves existing rows; does not delete operator history.

ALTER TABLE jarvis_agent_quota_state
  ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT '';

ALTER TABLE jarvis_agent_quota_state
  ADD COLUMN IF NOT EXISTS observed_at TIMESTAMPTZ;

ALTER TABLE jarvis_agent_quota_state
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- Broaden source vocabulary while keeping legacy 'operator' values.
-- Drop old unconstrained source if needed is unsafe; use check via trigger-free text.
-- Document allowed sources in application layer:
-- provider | provider_cli | provider_api | execution_observation | operator | synthetic | unknown

CREATE TABLE IF NOT EXISTS jarvis_agent_quota_state_history (
  id BIGSERIAL PRIMARY KEY,
  worker_type TEXT NOT NULL CHECK (worker_type IN ('codex','cursor')),
  quota_state TEXT NOT NULL,
  source TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  observed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note TEXT NOT NULL DEFAULT ''
);

-- Annotate current operator rows as non-authoritative without deleting evidence.
UPDATE jarvis_agent_quota_state
SET
  reason = CASE
    WHEN reason = '' AND source = 'operator' THEN 'legacy_operator_non_authoritative'
    ELSE reason
  END,
  note = CASE
    WHEN note = '' AND source = 'operator' THEN 'operator_advisory_only_not_execution_authority'
    WHEN note NOT LIKE '%operator_advisory%' AND source = 'operator'
      THEN note || ';operator_advisory_only_not_execution_authority'
    ELSE note
  END
WHERE source = 'operator';

-- Provenance snapshot into history (once per distinct current state).
INSERT INTO jarvis_agent_quota_state_history (
  worker_type, quota_state, source, reason, observed_at, expires_at, note
)
SELECT
  q.worker_type,
  q.quota_state,
  q.source,
  COALESCE(NULLIF(q.reason, ''), 'migration_015_snapshot'),
  q.observed_at,
  q.expires_at,
  COALESCE(NULLIF(q.note, ''), 'migration_015_history_preserve')
FROM jarvis_agent_quota_state q
WHERE NOT EXISTS (
  SELECT 1 FROM jarvis_agent_quota_state_history h
  WHERE h.worker_type = q.worker_type
    AND h.note LIKE 'migration_015_history_preserve%'
);
