-- 011_v2_superset_cursor_worker_type.sql
-- Additive: allow worker_type='cursor' alongside fake/codex.
-- Does NOT enable business Cursor missions.
-- Does NOT apply auth, publisher, or GitHub credentials.
-- Does NOT rewrite tables; existing rows unchanged.
--
-- ROLLBACK (manual, after Nadir approval only):
--   1) Ensure no rows with worker_type='cursor' remain:
--        SELECT count(*) FROM mission_attempts WHERE worker_type='cursor';
--        SELECT count(*) FROM worktree_leases WHERE worker_type='cursor';
--   2) DROP INDEX IF EXISTS worktree_leases_one_cursor_writer_per_repo;
--   3) Recreate CHECKs as IN ('fake','codex') (same DROP/ADD pattern as below).
--
-- VERIFY after apply:
--   SELECT conname, pg_get_constraintdef(oid)
--     FROM pg_constraint
--    WHERE conname IN (
--      'mission_attempts_worker_type_check',
--      'worktree_leases_worker_type_check'
--    );
--   Expect: worker_type = ANY (ARRAY['fake'::text, 'codex'::text, 'cursor'::text])
--        or equivalent IN ('fake','codex','cursor').
--   \d worktree_leases_one_cursor_writer_per_repo
--   Expect unique partial index on repo WHERE worker_type='cursor'
--     AND status IN ('reserved','leased','quarantined').

BEGIN;

-- ---------------------------------------------------------------------------
-- mission_attempts.worker_type
-- Live (post-006): CONSTRAINT mission_attempts_worker_type_check
--   CHECK (worker_type IN ('fake','codex'))
-- ---------------------------------------------------------------------------
ALTER TABLE mission_attempts
  DROP CONSTRAINT IF EXISTS mission_attempts_worker_type_check;

ALTER TABLE mission_attempts
  ADD CONSTRAINT mission_attempts_worker_type_check
  CHECK (worker_type IN ('fake', 'codex', 'cursor'));

-- ---------------------------------------------------------------------------
-- worktree_leases.worker_type
-- Live (post-006): column CHECK typically named worktree_leases_worker_type_check
--   CHECK (worker_type IN ('fake','codex'))
-- Also covered by worktree_lease_guard() matching attempt.worker_type (no enum).
-- Unique writer index for codex (007) remains untouched.
-- ---------------------------------------------------------------------------
ALTER TABLE worktree_leases
  DROP CONSTRAINT IF EXISTS worktree_leases_worker_type_check;

ALTER TABLE worktree_leases
  ADD CONSTRAINT worktree_leases_worker_type_check
  CHECK (worker_type IN ('fake', 'codex', 'cursor'));

-- One Cursor writer per repository (mirror Codex 007 contract; independent predicate).
CREATE UNIQUE INDEX IF NOT EXISTS worktree_leases_one_cursor_writer_per_repo
  ON worktree_leases(repo)
  WHERE worker_type = 'cursor'
    AND status IN ('reserved', 'leased', 'quarantined');

COMMENT ON INDEX worktree_leases_one_cursor_writer_per_repo IS
  'One Cursor writer per repository; quarantine remains exclusive until reconciled release.';

-- ---------------------------------------------------------------------------
-- Sanity: refuse apply if unexpected worker_type values already exist
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  bad_attempts bigint;
  bad_leases bigint;
BEGIN
  SELECT count(*) INTO bad_attempts
    FROM mission_attempts
   WHERE worker_type IS NOT NULL
     AND worker_type NOT IN ('fake', 'codex', 'cursor');
  SELECT count(*) INTO bad_leases
    FROM worktree_leases
   WHERE worker_type IS NOT NULL
     AND worker_type NOT IN ('fake', 'codex', 'cursor');
  IF bad_attempts > 0 OR bad_leases > 0 THEN
    RAISE EXCEPTION 'unexpected_worker_type_values attempts=% leases=%',
      bad_attempts, bad_leases
      USING ERRCODE = '23514';
  END IF;
END $$;

COMMIT;
