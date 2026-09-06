-- One-shot additive hardening after the complete 004 -> 005 -> 006 -> 007 chain.
-- The callback role must retain approval row locks without table/column UPDATE.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.mission_approval_bindings') IS NULL
    OR to_regclass('public.agent_actions') IS NULL
    OR to_regclass('public.agent_approvals') IS NULL
    OR to_regclass('public.codex_attempt_metadata') IS NULL
    OR to_regclass('public.worktree_leases_one_codex_writer_per_repo') IS NULL THEN
    RAISE EXCEPTION 'v2 approval schema prerequisite missing' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agentimpact_codex_control') THEN
    RAISE EXCEPTION 'codex callback role prerequisite missing' USING ERRCODE='23514';
  END IF;
END $$;

CREATE FUNCTION mission_execution_approval_valid(
  p_mission_id uuid, p_attempt_id uuid, p_action_type text, p_payload_hash text, p_head_sha text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE found_binding boolean := false;
BEGIN
  -- Fixed tables and predicates only. The FOR SHARE locks are retained until
  -- the caller transaction ends, protecting validity from concurrent mutation.
  SELECT true INTO found_binding
  FROM public.mission_approval_bindings b
  JOIN public.agent_actions x ON x.id=b.action_id
  JOIN public.agent_approvals p ON p.action_id=x.id
  WHERE b.mission_id=p_mission_id AND b.attempt_id=p_attempt_id AND b.action_type=p_action_type AND b.payload_hash=p_payload_hash
    AND b.head_sha IS NOT DISTINCT FROM p_head_sha AND b.expires_at>clock_timestamp()
    AND x.intent=b.action_type AND x.payload_hash=b.payload_hash AND x.status='approved'
    AND x.approval_expires_at>clock_timestamp() AND p.payload_hash=b.payload_hash
    AND p.decision='approved' AND p.expires_at>clock_timestamp() AND p.approver='human-admin'
    AND p.decided_at >= (SELECT created_at FROM public.mission_attempts WHERE id=p_attempt_id)
  LIMIT 1 FOR SHARE OF x,p;
  RETURN found_binding;
END;
$$;

REVOKE ALL ON FUNCTION mission_execution_approval_valid(uuid,uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mission_execution_approval_valid(uuid,uuid,text,text,text) TO agentimpact_codex_control;

COMMIT;
