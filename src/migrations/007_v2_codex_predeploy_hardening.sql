-- V2-B pre-deploy correction. Apply once, after the complete migration 006.
-- A quarantined Codex workspace remains an ambiguous writer and blocks reuse.
BEGIN;

LOCK TABLE worktree_leases IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  index_row record;
  status_contract text;
  target_table regclass := to_regclass('worktree_leases');
BEGIN
  IF target_table IS NULL THEN
    RAISE EXCEPTION 'missing_worktree_leases' USING ERRCODE='55000';
  END IF;
  SELECT i.indisunique, i.indisvalid, i.indisready, i.indnkeyatts, i.indnatts,
         a.attname AS key_name, pg_get_expr(i.indpred, i.indrelid) AS predicate
    INTO index_row
    FROM pg_class x
    JOIN pg_namespace n ON n.oid=x.relnamespace
    JOIN pg_index i ON i.indexrelid=x.oid
    JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=i.indkey[0]
   WHERE n.nspname=current_schema()
     AND x.relname='worktree_leases_one_codex_writer_per_repo'
     AND i.indrelid=target_table;

  IF NOT FOUND
     OR NOT index_row.indisunique OR NOT index_row.indisvalid OR NOT index_row.indisready
     OR index_row.indnkeyatts<>1 OR index_row.indnatts<>1 OR index_row.key_name<>'repo'
     OR index_row.predicate !~ $pattern$worker_type = 'codex'::text$pattern$
     OR index_row.predicate !~ $pattern$ARRAY\['reserved'::text, 'active'::text, 'quarantined'::text\]$pattern$
     OR index_row.predicate ~ $pattern$'leased'|'released'$pattern$ THEN
    RAISE EXCEPTION 'unexpected_v2_codex_writer_index' USING ERRCODE='55000';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO status_contract
    FROM pg_constraint
   WHERE conrelid=target_table
     AND conname='worktree_leases_status_check' AND contype='c' AND convalidated;
  IF status_contract IS NULL
     OR status_contract !~ $pattern$'reserved'$pattern$ OR status_contract !~ $pattern$'leased'$pattern$
     OR status_contract !~ $pattern$'quarantined'$pattern$ OR status_contract !~ $pattern$'released'$pattern$
     OR status_contract ~ $pattern$'active'$pattern$ THEN
    RAISE EXCEPTION 'unexpected_worktree_lease_state_contract' USING ERRCODE='55000';
  END IF;
END $$;

DROP INDEX worktree_leases_one_codex_writer_per_repo;
CREATE UNIQUE INDEX worktree_leases_one_codex_writer_per_repo ON worktree_leases(repo)
  WHERE worker_type='codex' AND status IN ('reserved','leased','quarantined');
COMMENT ON INDEX worktree_leases_one_codex_writer_per_repo IS
  'One Codex writer per repository; quarantine remains exclusive until reconciled release.';

COMMIT;
