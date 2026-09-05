-- V2-A only. Apply separately after deploying V1 guards; never applied by this PR.
BEGIN;
ALTER TABLE agent_missions
  ADD COLUMN orchestration_version smallint NOT NULL DEFAULT 1 CHECK (orchestration_version IN (1,2)),
  ADD COLUMN project text,
  ADD COLUMN objective text,
  ADD COLUMN parent_mission_id uuid REFERENCES agent_missions(id),
  ADD COLUMN lifecycle_state text,
  ADD COLUMN state_version integer NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  ADD COLUMN plan_version integer NOT NULL DEFAULT 0 CHECK (plan_version >= 0),
  ADD COLUMN request_hash text,
  ADD COLUMN requested_by text,
  ALTER COLUMN action_id DROP NOT NULL;
ALTER TABLE agent_missions ADD CONSTRAINT agent_missions_version_contract CHECK (
  (orchestration_version = 1 AND action_id IS NOT NULL AND lifecycle_state IS NULL
    AND parent_mission_id IS NULL AND project IS NULL AND objective IS NULL
    AND state_version = 0 AND plan_version = 0 AND request_hash IS NULL AND requested_by IS NULL)
  OR
  (orchestration_version = 2 AND project IS NOT NULL AND objective IS NOT NULL
    AND requested_by IS NOT NULL AND request_hash IS NOT NULL
    AND lifecycle_state IS NOT NULL AND lifecycle_state IN
      ('queued','planning','ready','waiting_dependencies','blocked','running','reviewing',
       'awaiting_nadir_approval','completed','retry_wait','failed_permanent',
       'cancel_requested','cancelling','cancelled','rejected')
    AND status = 'pending' AND target_agent = 'hermes' AND dry_run = true AND requires_human_validation = true)
);
CREATE INDEX agent_missions_v2_project_idx ON agent_missions(project, created_at, id)
  WHERE orchestration_version = 2;
CREATE INDEX agent_missions_parent_idx ON agent_missions(parent_mission_id)
  WHERE parent_mission_id IS NOT NULL;
ALTER TABLE slack_gateway_inbox
  ADD COLUMN orchestration_version smallint NOT NULL DEFAULT 1 CHECK (orchestration_version IN (1,2)),
  ADD COLUMN mission_id uuid UNIQUE REFERENCES agent_missions(id),
  ADD CONSTRAINT slack_inbox_version_contract CHECK (
    (orchestration_version = 1 AND mission_id IS NULL) OR
    (orchestration_version = 2 AND mission_id IS NOT NULL AND target = 'hermes' AND status = 'pending')
  );
CREATE TABLE mission_plans (
  mission_id uuid NOT NULL REFERENCES agent_missions(id),
  version integer NOT NULL CHECK (version > 0),
  plan jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mission_id, version)
);
CREATE TABLE mission_dependencies (
  mission_id uuid NOT NULL REFERENCES agent_missions(id),
  depends_on_id uuid NOT NULL REFERENCES agent_missions(id),
  dependency_type text NOT NULL CHECK (dependency_type IN ('artifact','commit','human_merge')),
  reference text,
  plan_version integer NOT NULL,
  PRIMARY KEY (mission_id, depends_on_id, plan_version),
  FOREIGN KEY (mission_id, plan_version) REFERENCES mission_plans(mission_id, version),
  CHECK (mission_id <> depends_on_id),
  CHECK (dependency_type <> 'commit' OR reference ~ '^[0-9a-f]{40}$')
);
-- No raw prompt, provider output, arbitrary actor text or free-form JSON in events.
CREATE TABLE mission_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mission_id uuid NOT NULL REFERENCES agent_missions(id),
  event_type text NOT NULL CHECK (event_type IN ('admitted','plan_saved','state_changed')),
  state_version integer NOT NULL,
  plan_version integer NOT NULL,
  lifecycle_state text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mission_id, state_version)
);
-- Receipts are mutation deduplication records, never executable work or a queue.
CREATE TABLE mission_receipts (
  principal text NOT NULL,
  idempotency_key text NOT NULL,
  payload_hash text NOT NULL,
  mission_id uuid NOT NULL REFERENCES agent_missions(id),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal, idempotency_key)
);
CREATE FUNCTION mission_v2_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable_mission_record' USING ERRCODE = '23514'; END;
$$;
CREATE TRIGGER mission_events_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON mission_events
  FOR EACH STATEMENT EXECUTE FUNCTION mission_v2_immutable();
CREATE TRIGGER mission_plans_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON mission_plans
  FOR EACH STATEMENT EXECUTE FUNCTION mission_v2_immutable();
CREATE TRIGGER mission_dependencies_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON mission_dependencies
  FOR EACH STATEMENT EXECUTE FUNCTION mission_v2_immutable();
CREATE TRIGGER mission_receipts_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON mission_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION mission_v2_immutable();
CREATE FUNCTION mission_v2_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.orchestration_version <> OLD.orchestration_version
      OR NEW.parent_mission_id IS DISTINCT FROM OLD.parent_mission_id
      OR NEW.project IS DISTINCT FROM OLD.project
      OR NEW.source_type <> OLD.source_type OR NEW.source_id <> OLD.source_id) THEN
    RAISE EXCEPTION 'immutable_mission_identity' USING ERRCODE = '23514';
  END IF;
  IF NEW.parent_mission_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM agent_missions WHERE id = NEW.parent_mission_id
      AND orchestration_version = 2 AND project = NEW.project AND id <> NEW.id
  ) THEN RAISE EXCEPTION 'invalid_parent' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER mission_version_guard BEFORE INSERT OR UPDATE ON agent_missions
  FOR EACH ROW EXECUTE FUNCTION mission_v2_guard();
CREATE FUNCTION mission_dependency_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Serialize graph writers. A concurrent lock upgrade may abort and must be retried.
  LOCK TABLE mission_dependencies IN SHARE ROW EXCLUSIVE MODE;
  IF NOT EXISTS (SELECT 1 FROM agent_missions m JOIN agent_missions d ON d.id = NEW.depends_on_id
    WHERE m.id = NEW.mission_id AND m.orchestration_version = 2 AND d.orchestration_version = 2
      AND m.project = d.project) THEN
    RAISE EXCEPTION 'invalid_dependency' USING ERRCODE = '23514';
  END IF;
  -- Conservatively include historical edges; plans never silently remove prerequisites.
  IF EXISTS (
    WITH RECURSIVE ancestors(id) AS (
      SELECT NEW.depends_on_id UNION
      SELECT d.depends_on_id FROM mission_dependencies d JOIN ancestors a ON d.mission_id = a.id
    ) SELECT 1 FROM ancestors WHERE id = NEW.mission_id
  ) THEN RAISE EXCEPTION 'dependency_cycle' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER mission_dependency_valid BEFORE INSERT ON mission_dependencies
  FOR EACH ROW EXECUTE FUNCTION mission_dependency_guard();
-- Bind all V2-only records to V2 missions at the database boundary as well.
CREATE FUNCTION mission_v2_reference_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM agent_missions WHERE id=NEW.mission_id AND orchestration_version=2) THEN
    RAISE EXCEPTION 'wrong_orchestration_version' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER mission_plan_version_guard BEFORE INSERT ON mission_plans
  FOR EACH ROW EXECUTE FUNCTION mission_v2_reference_guard();
CREATE TRIGGER mission_event_version_guard BEFORE INSERT ON mission_events
  FOR EACH ROW EXECUTE FUNCTION mission_v2_reference_guard();
CREATE TRIGGER mission_receipt_version_guard BEFORE INSERT ON mission_receipts
  FOR EACH ROW EXECUTE FUNCTION mission_v2_reference_guard();
CREATE FUNCTION mission_inbox_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.orchestration_version <> OLD.orchestration_version
    OR NEW.mission_id IS DISTINCT FROM OLD.mission_id) THEN
    RAISE EXCEPTION 'immutable_inbox_identity' USING ERRCODE='23514';
  END IF;
  IF NEW.orchestration_version=2 AND NOT EXISTS (
    SELECT 1 FROM agent_missions WHERE id=NEW.mission_id AND orchestration_version=2
  ) THEN RAISE EXCEPTION 'wrong_orchestration_version' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER mission_inbox_version_valid BEFORE INSERT OR UPDATE ON slack_gateway_inbox
  FOR EACH ROW EXECUTE FUNCTION mission_inbox_version_guard();
COMMIT;
