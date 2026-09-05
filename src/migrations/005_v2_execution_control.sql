-- V2-F only. Apply explicitly to an isolated database after 004 for validation.
-- This change does not deploy workers, run a scheduler, or enable V2.
BEGIN;

ALTER TABLE agent_missions
  ADD COLUMN current_attempt_id uuid,
  ADD COLUMN phase text CHECK (phase IS NULL OR phase IN
    ('queued','preparing','executing','validating','reviewing','waiting_approval','reconciling','stopping','finished')),
  ADD COLUMN blocked_reason text CHECK (blocked_reason IS NULL OR blocked_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  ADD COLUMN head_sha text CHECK (head_sha IS NULL OR head_sha ~ '^[0-9a-f]{40}$'),
  ADD COLUMN base_sha text CHECK (base_sha IS NULL OR base_sha ~ '^[0-9a-f]{40}$'),
  ADD COLUMN execution_payload_hash text CHECK (execution_payload_hash IS NULL OR execution_payload_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT agent_missions_v1_execution_contract CHECK (
    orchestration_version = 2 OR (current_attempt_id IS NULL AND phase IS NULL
      AND blocked_reason IS NULL AND head_sha IS NULL AND base_sha IS NULL AND execution_payload_hash IS NULL)
  );
-- Keep 004's V1 status projection ('pending') intact. V2 lifecycle_state is
-- authoritative and the existing V1 consumers exclude orchestration_version=2.

CREATE TABLE mission_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id uuid NOT NULL REFERENCES agent_missions(id),
  project text NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  plan_version integer NOT NULL CHECK (plan_version > 0),
  worker_type text NOT NULL DEFAULT 'fake' CHECK (worker_type = 'fake'),
  worker_instance_id text NOT NULL CHECK (worker_instance_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN
    ('queued','claimed','running','completing','completed','stale','cancelled','failed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  fencing_token bigint GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME mission_attempt_fencing_seq NO CYCLE)
    NOT NULL CHECK (fencing_token > 0),
  deadline_at timestamptz NOT NULL,
  retryable boolean NOT NULL DEFAULT true,
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  error_summary text CHECK (error_summary IS NULL OR error_summary ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- F has no provider sessions. Reserve the column without accepting provider data.
  provider_session_id text CHECK (provider_session_id IS NULL),
  execution_payload_hash text NOT NULL CHECK (execution_payload_hash ~ '^[0-9a-f]{64}$'),
  head_sha text CHECK (head_sha IS NULL OR head_sha ~ '^[0-9a-f]{40}$'),
  base_sha text CHECK (base_sha IS NULL OR base_sha ~ '^[0-9a-f]{40}$'),
  approval_required boolean NOT NULL DEFAULT false,
  callback_hash text CHECK (callback_hash IS NULL OR callback_hash ~ '^[0-9a-f]{64}$'),
  reconciled_at timestamptz,
  stop_proof_at timestamptz,
  UNIQUE (mission_id, attempt_number),
  UNIQUE (fencing_token),
  UNIQUE (mission_id, id),
  UNIQUE (id, mission_id, worker_instance_id, fencing_token),
  FOREIGN KEY (mission_id, plan_version) REFERENCES mission_plans(mission_id, version),
  CHECK (isfinite(deadline_at) AND deadline_at > created_at),
  CHECK (lease_expires_at IS NULL OR lease_expires_at <= deadline_at),
  CHECK (reconciled_at IS NULL OR stop_proof_at IS NOT NULL)
);
-- Stale is still an owned, quarantined generation until proof of stop and
-- reconciliation. A clock timeout alone never makes another attempt safe.
CREATE UNIQUE INDEX mission_attempts_one_active ON mission_attempts(mission_id)
  WHERE status IN ('queued','claimed','running','completing')
    OR (status = 'stale' AND reconciled_at IS NULL);
CREATE INDEX mission_attempts_lease_scan ON mission_attempts(lease_expires_at, id)
  WHERE status IN ('claimed','running','completing');
ALTER TABLE agent_missions ADD CONSTRAINT agent_missions_current_attempt_fk
  FOREIGN KEY (id, current_attempt_id) REFERENCES mission_attempts(mission_id, id);

CREATE TABLE worktree_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id uuid NOT NULL REFERENCES agent_missions(id),
  attempt_id uuid NOT NULL UNIQUE,
  repo text NOT NULL CHECK (repo ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$'),
  base_sha text NOT NULL CHECK (base_sha ~ '^[0-9a-f]{40}$'),
  branch text NOT NULL CHECK (branch ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$'),
  -- F reserves names only; no filesystem operation is performed by this model.
  worktree_path text NOT NULL CHECK (worktree_path ~ '^/fake/[A-Za-z0-9_./-]{1,240}$'),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','leased','quarantined','released')),
  owner_worker text NOT NULL,
  fencing_token bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  leased_at timestamptz,
  lease_expires_at timestamptz,
  released_at timestamptz,
  FOREIGN KEY (attempt_id, mission_id, owner_worker, fencing_token)
    REFERENCES mission_attempts(id, mission_id, worker_instance_id, fencing_token)
);
CREATE UNIQUE INDEX worktree_leases_active_branch ON worktree_leases(repo, branch)
  WHERE status IN ('reserved','leased','quarantined');
CREATE UNIQUE INDEX worktree_leases_active_path ON worktree_leases(worktree_path)
  WHERE status IN ('reserved','leased','quarantined');

CREATE TABLE budget_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id uuid NOT NULL REFERENCES agent_missions(id),
  attempt_id uuid NOT NULL UNIQUE,
  provider text NOT NULL CHECK (provider = 'fake'),
  cost_class text NOT NULL CHECK (cost_class ~ '^[a-z][a-z0-9_]{0,31}$'),
  currency text NOT NULL CHECK (currency ~ '^[A-Z][A-Z0-9_]{1,15}$'),
  -- Integer smallest units, no floating point/NaN/infinity or real billing.
  max_amount bigint NOT NULL CHECK (max_amount > 0 AND max_amount <= 9007199254740991),
  reserved_amount bigint NOT NULL CHECK (reserved_amount > 0),
  consumed_amount bigint NOT NULL DEFAULT 0 CHECK (consumed_amount >= 0),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','consuming','released','exhausted','cancelled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_at timestamptz,
  FOREIGN KEY (mission_id, attempt_id) REFERENCES mission_attempts(mission_id, id),
  CHECK (reserved_amount <= max_amount AND consumed_amount <= reserved_amount)
);
CREATE INDEX budget_reservations_active ON budget_reservations(status)
  WHERE status IN ('reserved','consuming');

-- Decisions remain in the existing agent_actions / agent_approvals circuit.
-- This immutable binding limits a decision to one attempt, payload and head.
CREATE TABLE mission_approval_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id uuid NOT NULL REFERENCES agent_missions(id),
  attempt_id uuid NOT NULL,
  action_id uuid NOT NULL REFERENCES agent_actions(id),
  action_type text NOT NULL CHECK (action_type ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  head_sha text CHECK (head_sha IS NULL OR head_sha ~ '^[0-9a-f]{40}$'),
  expires_at timestamptz NOT NULL CHECK (isfinite(expires_at)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (mission_id, attempt_id) REFERENCES mission_attempts(mission_id, id)
);
CREATE INDEX mission_approval_bindings_attempt ON mission_approval_bindings(attempt_id, action_type, created_at, id);

-- Exact human-merge evidence can only be recorded through the trusted operator
-- control plane. No worker callback can create evidence or perform a merge.
CREATE TABLE mission_dependency_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id uuid NOT NULL,
  depends_on_id uuid NOT NULL,
  plan_version integer NOT NULL,
  head_sha text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  kind text NOT NULL DEFAULT 'human_merge' CHECK (kind = 'human_merge'),
  recorded_by text NOT NULL CHECK (recorded_by ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (mission_id, depends_on_id, plan_version)
    REFERENCES mission_dependencies(mission_id, depends_on_id, plan_version),
  UNIQUE (mission_id, depends_on_id, plan_version, head_sha)
);

ALTER TABLE mission_events
  DROP CONSTRAINT mission_events_event_type_check,
  ADD COLUMN attempt_id uuid,
  ADD CONSTRAINT mission_events_event_type_check CHECK (event_type IN
    ('admitted','plan_saved','state_changed','attempt_created','attempt_claimed','attempt_started',
     'heartbeat','progress','attempt_completed','attempt_failed','attempt_stale','cancel_requested',
     'cancelling','cancelled','retried','reconciled','dependency_blocked','approval_bound','reviewed')),
  ADD CONSTRAINT mission_events_attempt_fk FOREIGN KEY (mission_id, attempt_id)
    REFERENCES mission_attempts(mission_id, id);
-- Existing append-only event trigger and UNIQUE(mission_id,state_version) remain.

-- Callback/control receipts are deduplication records, never a work queue.
CREATE TABLE execution_receipts (
  principal text NOT NULL CHECK (principal ~ '^[A-Za-z0-9:_.-]{1,200}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_.-]{1,200}$'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  mission_id uuid NOT NULL REFERENCES agent_missions(id),
  attempt_id uuid,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (principal, idempotency_key),
  FOREIGN KEY (mission_id, attempt_id) REFERENCES mission_attempts(mission_id, id)
);
CREATE TABLE execution_metrics (
  name text PRIMARY KEY CHECK (name IN
    ('attempts_created_total','attempts_running','attempts_stale_total','leases_expired_total',
     'callbacks_rejected_total','fencing_rejections_total','cancellations_total','retries_total',
     'budget_reservations_active','dependency_blocks_total')),
  value bigint NOT NULL DEFAULT 0 CHECK (value >= 0)
);
INSERT INTO execution_metrics(name) VALUES
  ('attempts_created_total'),('attempts_running'),('attempts_stale_total'),('leases_expired_total'),
  ('callbacks_rejected_total'),('fencing_rejections_total'),('cancellations_total'),('retries_total'),
  ('budget_reservations_active'),('dependency_blocks_total');

CREATE FUNCTION mission_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mission_project text; mission_plan integer;
BEGIN
  SELECT project, plan_version INTO mission_project, mission_plan FROM agent_missions
    WHERE id = NEW.mission_id AND orchestration_version = 2;
  IF NOT FOUND THEN RAISE EXCEPTION 'wrong_orchestration_version' USING ERRCODE='23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.project IS NULL THEN NEW.project := mission_project; END IF;
    IF NEW.plan_version IS NULL THEN NEW.plan_version := mission_plan; END IF;
  END IF;
  IF NEW.project IS DISTINCT FROM mission_project THEN
    RAISE EXCEPTION 'attempt_project_mismatch' USING ERRCODE='23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id
    OR NEW.mission_id IS DISTINCT FROM OLD.mission_id OR NEW.project IS DISTINCT FROM OLD.project
    OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number OR NEW.plan_version IS DISTINCT FROM OLD.plan_version
    OR NEW.worker_type IS DISTINCT FROM OLD.worker_type OR NEW.worker_instance_id IS DISTINCT FROM OLD.worker_instance_id
    OR NEW.fencing_token IS DISTINCT FROM OLD.fencing_token OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.deadline_at IS DISTINCT FROM OLD.deadline_at OR NEW.execution_payload_hash IS DISTINCT FROM OLD.execution_payload_hash
    OR NEW.head_sha IS DISTINCT FROM OLD.head_sha OR NEW.base_sha IS DISTINCT FROM OLD.base_sha
    OR NEW.approval_required IS DISTINCT FROM OLD.approval_required) THEN
    RAISE EXCEPTION 'immutable_attempt_identity' USING ERRCODE='23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IN ('completed','cancelled','failed') AND NEW.status <> OLD.status THEN
      RAISE EXCEPTION 'terminal_attempt' USING ERRCODE='23514';
    END IF;
    IF OLD.status = 'stale' AND (NEW.status NOT IN ('stale','cancelled','failed')
      OR (NEW.status <> 'stale' AND NEW.stop_proof_at IS NULL)) THEN
      RAISE EXCEPTION 'unreconciled_attempt' USING ERRCODE='23514';
    END IF;
    IF (OLD.callback_hash IS NOT NULL AND NEW.callback_hash IS DISTINCT FROM OLD.callback_hash)
      OR (OLD.stop_proof_at IS NOT NULL AND NEW.stop_proof_at IS DISTINCT FROM OLD.stop_proof_at)
      OR (OLD.reconciled_at IS NOT NULL AND NEW.reconciled_at IS DISTINCT FROM OLD.reconciled_at) THEN
      RAISE EXCEPTION 'immutable_attempt_evidence' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER mission_attempt_identity BEFORE INSERT OR UPDATE ON mission_attempts
  FOR EACH ROW EXECUTE FUNCTION mission_attempt_guard();
CREATE TRIGGER mission_attempts_history BEFORE DELETE OR TRUNCATE ON mission_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION mission_v2_immutable();

CREATE FUNCTION worktree_lease_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.mission_id IS DISTINCT FROM OLD.mission_id
    OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id OR NEW.repo IS DISTINCT FROM OLD.repo
    OR NEW.base_sha IS DISTINCT FROM OLD.base_sha OR NEW.branch IS DISTINCT FROM OLD.branch
    OR NEW.worktree_path IS DISTINCT FROM OLD.worktree_path OR NEW.owner_worker IS DISTINCT FROM OLD.owner_worker
    OR NEW.fencing_token IS DISTINCT FROM OLD.fencing_token OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'immutable_worktree_owner' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM mission_attempts WHERE id = NEW.attempt_id AND base_sha = NEW.base_sha) THEN
    RAISE EXCEPTION 'worktree_base_mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.status = 'released' AND NOT EXISTS (
    SELECT 1 FROM mission_attempts WHERE id = NEW.attempt_id AND stop_proof_at IS NOT NULL
  ) THEN RAISE EXCEPTION 'stop_unconfirmed' USING ERRCODE='23514'; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'released' AND NEW.status <> 'released' THEN
    RAISE EXCEPTION 'released_worktree_lease' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER worktree_lease_identity BEFORE INSERT OR UPDATE ON worktree_leases
  FOR EACH ROW EXECUTE FUNCTION worktree_lease_guard();
CREATE TRIGGER worktree_leases_history BEFORE DELETE OR TRUNCATE ON worktree_leases
  FOR EACH STATEMENT EXECUTE FUNCTION mission_v2_immutable();

CREATE FUNCTION budget_reservation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.mission_id IS DISTINCT FROM OLD.mission_id
    OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.cost_class IS DISTINCT FROM OLD.cost_class OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.max_amount IS DISTINCT FROM OLD.max_amount OR NEW.reserved_amount IS DISTINCT FROM OLD.reserved_amount
    OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'immutable_budget_reservation' USING ERRCODE='23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.consumed_amount < OLD.consumed_amount THEN
    RAISE EXCEPTION 'budget_consumption_regression' USING ERRCODE='23514';
  END IF;
  IF NEW.status IN ('released','cancelled') AND NOT EXISTS (
    SELECT 1 FROM mission_attempts WHERE id = NEW.attempt_id AND stop_proof_at IS NOT NULL
  ) THEN RAISE EXCEPTION 'stop_unconfirmed' USING ERRCODE='23514'; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('released','cancelled') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'released_budget_reservation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER budget_reservation_identity BEFORE INSERT OR UPDATE ON budget_reservations
  FOR EACH ROW EXECUTE FUNCTION budget_reservation_guard();
CREATE TRIGGER budget_reservations_history BEFORE DELETE OR TRUNCATE ON budget_reservations
  FOR EACH STATEMENT EXECUTE FUNCTION mission_v2_immutable();

CREATE FUNCTION mission_dependency_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.plan_version IS NULL THEN
    SELECT plan_version INTO NEW.plan_version FROM agent_missions WHERE id=NEW.mission_id AND orchestration_version=2;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM mission_dependencies WHERE mission_id=NEW.mission_id
    AND depends_on_id=NEW.depends_on_id AND plan_version=NEW.plan_version AND dependency_type='human_merge') THEN
    RAISE EXCEPTION 'invalid_merge_evidence' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER mission_dependency_evidence_valid BEFORE INSERT ON mission_dependency_evidence
  FOR EACH ROW EXECUTE FUNCTION mission_dependency_evidence_guard();
CREATE TRIGGER mission_dependency_evidence_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON mission_dependency_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION mission_v2_immutable();
CREATE TRIGGER mission_approval_bindings_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON mission_approval_bindings
  FOR EACH STATEMENT EXECUTE FUNCTION mission_v2_immutable();
CREATE TRIGGER execution_receipts_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON execution_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION mission_v2_immutable();
CREATE TRIGGER execution_receipt_version_guard BEFORE INSERT ON execution_receipts
  FOR EACH ROW EXECUTE FUNCTION mission_v2_reference_guard();

COMMIT;
