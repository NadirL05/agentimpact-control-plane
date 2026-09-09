-- V2 Superset execution adapter refs (additive only).
-- Does NOT enable Superset for business missions.
-- Does NOT mutate migrations 008/009.
-- Feature flag default remains OFF (AGENTIMPACT_EXECUTION_BACKEND=custom).
BEGIN;

-- Attempt-level Superset references (nullable; custom runtime unchanged).
ALTER TABLE mission_attempts
  ADD COLUMN IF NOT EXISTS execution_backend text;

ALTER TABLE mission_attempts
  ADD COLUMN IF NOT EXISTS superset_project_id uuid;

ALTER TABLE mission_attempts
  ADD COLUMN IF NOT EXISTS superset_workspace_id uuid;

ALTER TABLE mission_attempts
  ADD COLUMN IF NOT EXISTS superset_terminal_id uuid;

ALTER TABLE mission_attempts
  ADD COLUMN IF NOT EXISTS workspace_path text;

ALTER TABLE mission_attempts
  ADD COLUMN IF NOT EXISTS branch text;

-- head_sha / base_sha already exist on mission_attempts.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'mission_attempts_execution_backend_check'
  ) THEN
    ALTER TABLE mission_attempts
      ADD CONSTRAINT mission_attempts_execution_backend_check
      CHECK (execution_backend IS NULL OR execution_backend IN ('custom', 'superset'))
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'mission_attempts_superset_refs_check'
  ) THEN
    ALTER TABLE mission_attempts
      ADD CONSTRAINT mission_attempts_superset_refs_check
      CHECK (
        (execution_backend IS DISTINCT FROM 'superset')
        OR (
          superset_project_id IS NOT NULL
          AND superset_workspace_id IS NOT NULL
          AND workspace_path IS NOT NULL
          AND workspace_path ~ '^/var/lib/agentimpact-superset/[A-Za-z0-9_./-]{1,400}$'
          AND workspace_path !~ '(^|/)\.\.(/|$)'
          AND workspace_path !~ '//'
          AND branch IS NOT NULL
          AND branch ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$'
        )
      ) NOT VALID;
  END IF;
END $$;

COMMENT ON COLUMN mission_attempts.execution_backend IS
  'Execution backend for this attempt: custom (legacy worktree) or superset. NULL = legacy/unset.';
COMMENT ON COLUMN mission_attempts.superset_project_id IS
  'Superset project UUID when execution_backend=superset.';
COMMENT ON COLUMN mission_attempts.superset_workspace_id IS
  'Superset workspace UUID when execution_backend=superset.';
COMMENT ON COLUMN mission_attempts.superset_terminal_id IS
  'Active Superset terminal UUID (nullable after dispose).';
COMMENT ON COLUMN mission_attempts.workspace_path IS
  'Expected absolute worktree path (identity check); not a trust substitute for Superset.';
COMMENT ON COLUMN mission_attempts.branch IS
  'Expected branch name bound to this attempt.';

-- Evolve worktree_leases toward execution lease without dropping the table.
ALTER TABLE worktree_leases
  ADD COLUMN IF NOT EXISTS execution_backend text;

ALTER TABLE worktree_leases
  ADD COLUMN IF NOT EXISTS quarantine_reason text;

ALTER TABLE worktree_leases
  ADD COLUMN IF NOT EXISTS superset_workspace_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'worktree_leases_execution_backend_check'
  ) THEN
    ALTER TABLE worktree_leases
      ADD CONSTRAINT worktree_leases_execution_backend_check
      CHECK (execution_backend IS NULL OR execution_backend IN ('custom', 'superset'))
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'worktree_leases_quarantine_reason_check'
  ) THEN
    ALTER TABLE worktree_leases
      ADD CONSTRAINT worktree_leases_quarantine_reason_check
      CHECK (
        quarantine_reason IS NULL
        OR quarantine_reason ~ '^[a-z][a-z0-9_]{0,63}$'
      ) NOT VALID;
  END IF;
END $$;

-- Allow Superset worktree paths under dedicated state root (additive OR).
ALTER TABLE worktree_leases DROP CONSTRAINT IF EXISTS worktree_leases_worktree_path_check;
ALTER TABLE worktree_leases ADD CONSTRAINT worktree_leases_worktree_path_check CHECK
  ((worktree_path ~ '^/fake/[A-Za-z0-9_./-]{1,240}$'
   OR worktree_path ~ '^/var/lib/agentimpact-codex-worker/workspaces/[A-Za-z0-9_./-]{1,200}$'
   OR worktree_path ~ '^/var/lib/agentimpact-superset/[A-Za-z0-9_./-]{1,400}$')
   AND worktree_path !~ '(^|/)\.\.(/|$)' AND worktree_path !~ '(^|/)\.(/|$)' AND worktree_path !~ '//')
  NOT VALID;

COMMENT ON COLUMN worktree_leases.execution_backend IS
  'Execution lease role: AgentImpact owns the right to use; Superset owns the physical workspace when backend=superset.';
COMMENT ON COLUMN worktree_leases.quarantine_reason IS
  'Set when cleanup fails closed (e.g. cleanup_refused) instead of rm -rf.';
COMMENT ON COLUMN worktree_leases.superset_workspace_id IS
  'Superset workspace UUID bound to this lease when execution_backend=superset.';

-- One logical Superset workspace cannot be leased by two active attempts.
CREATE UNIQUE INDEX IF NOT EXISTS worktree_leases_one_active_superset_workspace
  ON worktree_leases(superset_workspace_id)
  WHERE execution_backend = 'superset'
    AND superset_workspace_id IS NOT NULL
    AND status IN ('reserved', 'leased', 'quarantined');

COMMIT;
