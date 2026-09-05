-- V2-B Codex worker metadata. Apply once to an isolated 004+005 database.
-- This migration does not enable or start a worker, publisher or provider call.
BEGIN;

ALTER TABLE mission_attempts DROP CONSTRAINT mission_attempts_worker_type_check;
ALTER TABLE mission_attempts ADD CONSTRAINT mission_attempts_worker_type_check
  CHECK (worker_type IN ('fake','codex'));
ALTER TABLE mission_attempts DROP CONSTRAINT mission_attempts_provider_session_id_check;
ALTER TABLE mission_attempts ADD CONSTRAINT mission_attempts_provider_session_id_check
  CHECK (provider_session_id IS NULL OR provider_session_id ~ '^[A-Za-z0-9_.:-]{1,200}$');
ALTER TABLE worktree_leases DROP CONSTRAINT worktree_leases_worktree_path_check;
ALTER TABLE worktree_leases ADD CONSTRAINT worktree_leases_worktree_path_check CHECK
  ((worktree_path ~ '^/fake/[A-Za-z0-9_./-]{1,240}$'
   OR worktree_path ~ '^/var/lib/agentimpact-codex-worker/workspaces/[A-Za-z0-9_./-]{1,200}$')
   AND worktree_path !~ '(^|/)\.\.(/|$)' AND worktree_path !~ '(^|/)\.(/|$)' AND worktree_path !~ '//') NOT VALID;
ALTER TABLE worktree_leases ADD COLUMN worker_type text NOT NULL DEFAULT 'fake'
  CHECK (worker_type IN ('fake','codex'));
CREATE UNIQUE INDEX worktree_leases_one_codex_writer_per_repo ON worktree_leases(repo)
  WHERE worker_type='codex' AND status IN ('reserved','active','quarantined');
CREATE OR REPLACE FUNCTION worktree_lease_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.mission_id IS DISTINCT FROM OLD.mission_id
    OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id OR NEW.repo IS DISTINCT FROM OLD.repo
    OR NEW.base_sha IS DISTINCT FROM OLD.base_sha OR NEW.branch IS DISTINCT FROM OLD.branch
    OR NEW.worktree_path IS DISTINCT FROM OLD.worktree_path OR NEW.owner_worker IS DISTINCT FROM OLD.owner_worker
    OR NEW.worker_type IS DISTINCT FROM OLD.worker_type OR NEW.fencing_token IS DISTINCT FROM OLD.fencing_token
    OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'immutable_worktree_owner' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM mission_attempts WHERE id=NEW.attempt_id AND base_sha=NEW.base_sha AND worker_type=NEW.worker_type) THEN
    RAISE EXCEPTION 'worktree_base_mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.status='released' AND NOT EXISTS (SELECT 1 FROM mission_attempts WHERE id=NEW.attempt_id AND stop_proof_at IS NOT NULL) THEN
    RAISE EXCEPTION 'stop_unconfirmed' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='released' AND NEW.status<>'released' THEN
    RAISE EXCEPTION 'released_worktree_lease' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE codex_attempt_metadata (
  attempt_id uuid PRIMARY KEY REFERENCES mission_attempts(id),
  adapter_version text NOT NULL CHECK (adapter_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  contract_version integer NOT NULL DEFAULT 1 CHECK (contract_version = 1),
  contract_hash text NOT NULL CHECK (contract_hash ~ '^[0-9a-f]{64}$'),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 3),
  auth_mode text NOT NULL CHECK (auth_mode IN ('chatgpt','api_key','access_token','unknown')),
  billing_mode text NOT NULL CHECK (billing_mode IN ('chatgpt_plan','api_billing','unknown')),
  quota_source text NOT NULL DEFAULT 'none' CHECK (quota_source IN ('none','operator_verified')),
  quota_state text NOT NULL DEFAULT 'UNKNOWN' CHECK (quota_state IN ('UNKNOWN','ADMISSIBLE','EXHAUSTED')),
  quota_checked_at timestamptz,
  workspace_id uuid NOT NULL UNIQUE REFERENCES worktree_leases(id),
  workspace_root text NOT NULL CHECK (workspace_root='/var/lib/agentimpact-codex-worker/workspaces'),
  canonical_path text NOT NULL UNIQUE CHECK
    (canonical_path ~ '^/var/lib/agentimpact-codex-worker/workspaces/attempts/[0-9a-f-]{36}/workspace$'),
  validation_state text NOT NULL DEFAULT 'pending' CHECK (validation_state IN ('pending','running','passed','failed','quarantined')),
  publisher_state text NOT NULL DEFAULT 'disabled' CHECK (publisher_state IN ('disabled','pending','published','failed')),
  provider_session_present boolean NOT NULL DEFAULT false,
  result_hash text CHECK (result_hash IS NULL OR result_hash ~ '^[0-9a-f]{64}$'),
  process_id integer CHECK (process_id IS NULL OR process_id > 1),
  cgroup_name text CHECK (cgroup_name IS NULL OR cgroup_name ~ '^agentimpact-codex-worker@[0-9a-f-]{36}[.]service$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((quota_state='UNKNOWN' AND quota_checked_at IS NULL AND quota_source='none')
    OR (quota_state<>'UNKNOWN' AND quota_checked_at IS NOT NULL AND quota_source<>'none'))
);

CREATE TABLE codex_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES mission_attempts(id),
  kind text NOT NULL CHECK (kind IN ('diff','test_report','validation_report')),
  relative_path text NOT NULL CHECK (relative_path ~ '^[A-Za-z0-9][A-Za-z0-9_.\/-]{0,299}$'
    AND relative_path !~ '(^|/)\.\.(/|$)' AND relative_path !~ '(^|/)\.(/|$)'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 10485760),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(attempt_id,kind,relative_path,sha256)
);

ALTER TABLE execution_metrics DROP CONSTRAINT execution_metrics_name_check;
ALTER TABLE execution_metrics ADD CONSTRAINT execution_metrics_name_check CHECK (name IN
  ('attempts_created_total','attempts_running','attempts_stale_total','leases_expired_total',
   'callbacks_rejected_total','fencing_rejections_total','cancellations_total','retries_total',
   'budget_reservations_active','dependency_blocks_total','codex_attempts_total','codex_attempts_running',
   'codex_attempts_failed_total','codex_timeouts_total','codex_cancellations_total','codex_output_invalid_total',
   'codex_validation_failures_total','codex_publish_requests_total','codex_publish_failures_total'));
INSERT INTO execution_metrics(name) VALUES
 ('codex_attempts_total'),('codex_attempts_running'),('codex_attempts_failed_total'),('codex_timeouts_total'),
 ('codex_cancellations_total'),('codex_output_invalid_total'),('codex_validation_failures_total'),
 ('codex_publish_requests_total'),('codex_publish_failures_total');

CREATE TRIGGER codex_attempt_metadata_history BEFORE DELETE OR TRUNCATE ON codex_attempt_metadata
  FOR EACH STATEMENT EXECUTE FUNCTION mission_v2_immutable();
CREATE TRIGGER codex_artifacts_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON codex_artifacts
  FOR EACH STATEMENT EXECUTE FUNCTION mission_v2_immutable();

CREATE FUNCTION codex_attempt_binding_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.attempt_id IS DISTINCT FROM OLD.attempt_id OR NEW.adapter_version IS DISTINCT FROM OLD.adapter_version
    OR NEW.contract_version IS DISTINCT FROM OLD.contract_version OR NEW.contract_hash IS DISTINCT FROM OLD.contract_hash
    OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts OR NEW.auth_mode IS DISTINCT FROM OLD.auth_mode
    OR NEW.billing_mode IS DISTINCT FROM OLD.billing_mode OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.workspace_root IS DISTINCT FROM OLD.workspace_root OR NEW.canonical_path IS DISTINCT FROM OLD.canonical_path
    OR NEW.cgroup_name IS DISTINCT FROM OLD.cgroup_name THEN
    RAISE EXCEPTION 'codex attempt binding is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER codex_attempt_binding_guard BEFORE UPDATE ON codex_attempt_metadata
  FOR EACH ROW EXECUTE FUNCTION codex_attempt_binding_immutable();

COMMIT;
