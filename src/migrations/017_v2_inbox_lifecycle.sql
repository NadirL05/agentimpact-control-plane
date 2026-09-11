-- Permit the typed Hermes consumer to advance V2 inbox records through the
-- status lifecycle already enforced by slack_gateway_inbox_status_check.
-- This repairs installations where migration 004's initial constraint only
-- allowed the pending state. Additive/idempotent for rolling deployment.

ALTER TABLE slack_gateway_inbox
  DROP CONSTRAINT IF EXISTS slack_inbox_version_contract;

ALTER TABLE slack_gateway_inbox
  ADD CONSTRAINT slack_inbox_version_contract CHECK (
    (orchestration_version = 1 AND mission_id IS NULL) OR
    (orchestration_version = 2 AND mission_id IS NOT NULL AND target = 'hermes')
  );
