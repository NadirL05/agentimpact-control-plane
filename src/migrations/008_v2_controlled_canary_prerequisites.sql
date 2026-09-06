-- Secure fresh installation; one-shot after complete 004–007.
-- Inventory persistent environments before selecting a repair migration.
-- Run as a trusted DBA with current_schema() set to the application schema.
-- Identifiers are formatted only at installation. The installed function is
-- static SQL and never accepts callback-supplied identifiers.
BEGIN;

DO $migration$
DECLARE
  app_schema pg_catalog.name := pg_catalog.current_schema();
  owner_name CONSTANT pg_catalog.name := 'agentimpact_approval_validator';
  callback_name CONSTANT pg_catalog.name := 'agentimpact_codex_control';
  relation_name pg_catalog.text;
  function_oid pg_catalog.oid;
  unexpected_grantee record;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user) THEN
    RAISE EXCEPTION 'trusted_dba_required_for_approval_owner_installation' USING ERRCODE='42501';
  END IF;
  IF app_schema IS NULL OR (app_schema <> 'public' AND app_schema !~ '^v2_[a-z0-9_]+$') THEN
    RAISE EXCEPTION 'untrusted_application_schema' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=callback_name
      AND NOT (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolreplication)) THEN
    RAISE EXCEPTION 'codex_callback_role_missing_or_privileged' USING ERRCODE='55000';
  END IF;
  IF pg_catalog.has_schema_privilege(callback_name,app_schema,'CREATE') OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace n,
      LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) a
    LEFT JOIN pg_catalog.pg_roles r ON r.oid=a.grantee
    WHERE n.nspname=app_schema AND a.privilege_type='CREATE'
      AND a.grantee<>n.nspowner AND NOT COALESCE(r.rolsuper,false)
  ) THEN
    -- No global privilege revocation that could affect V1.
    RAISE EXCEPTION 'application_schema_writable_by_untrusted_role' USING ERRCODE='55000';
  END IF;
  FOREACH relation_name IN ARRAY ARRAY['agent_missions','mission_attempts','mission_approval_bindings',
      'agent_actions','agent_approvals','codex_attempt_metadata','worktree_leases'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=app_schema AND c.relname=relation_name AND c.relkind='r') THEN
      RAISE EXCEPTION 'v2_approval_schema_prerequisite_missing' USING ERRCODE='55000';
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class x ON x.oid=i.indexrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=x.relnamespace
      WHERE n.nspname=app_schema AND x.relname='worktree_leases_one_codex_writer_per_repo'
        AND i.indisunique AND i.indisvalid AND i.indisready
        AND pg_catalog.pg_get_expr(i.indpred,i.indrelid) ~ $p$ARRAY\['reserved'::text, 'leased'::text, 'quarantined'::text\]$p$
        AND pg_catalog.pg_get_expr(i.indpred,i.indrelid) ~ $p$worker_type = 'codex'::text$p$) THEN
    RAISE EXCEPTION 'migration_007_prerequisite_missing' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=app_schema AND p.proname='mission_execution_approval_valid') THEN
    RAISE EXCEPTION 'migration_008_already_present_requires_inventory' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=owner_name) THEN
    RAISE EXCEPTION 'approval_validator_owner_already_exists_requires_inventory' USING ERRCODE='55000';
  ELSE
    CREATE ROLE agentimpact_approval_validator NOLOGIN NOSUPERUSER NOCREATEDB
      NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=owner_name
      AND NOT (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls))
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members a JOIN pg_catalog.pg_roles r
        ON r.oid=a.roleid OR r.oid=a.member WHERE r.rolname=owner_name) THEN
    RAISE EXCEPTION 'approval_validator_owner_not_isolated' USING ERRCODE='55000';
  END IF;
  -- FOR SHARE requires UPDATE on at least one column. Only the isolated NOLOGIN
  -- owner gets UPDATE(id); the callback cannot SET ROLE as this owner.
  EXECUTE pg_catalog.format('GRANT USAGE ON SCHEMA %I TO %I',app_schema,owner_name);
  EXECUTE pg_catalog.format('GRANT SELECT ON %1$I.mission_approval_bindings,%1$I.agent_actions,%1$I.agent_approvals,%1$I.mission_attempts TO %2$I',app_schema,owner_name);
  EXECUTE pg_catalog.format('GRANT UPDATE(id) ON %1$I.agent_actions,%1$I.agent_approvals TO %2$I',app_schema,owner_name);

  EXECUTE pg_catalog.format($ddl$
    CREATE FUNCTION %1$I.mission_execution_approval_valid(
      p_mission_id pg_catalog.uuid,p_attempt_id pg_catalog.uuid,p_action_type pg_catalog.text,
      p_payload_hash pg_catalog.text,p_head_sha pg_catalog.text
    ) RETURNS pg_catalog.bool
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
    DECLARE valid_until pg_catalog.timestamptz;
    BEGIN
      SELECT LEAST(b.expires_at,x.approval_expires_at,p.expires_at) INTO valid_until
      FROM %1$I.mission_approval_bindings b
      JOIN %1$I.agent_actions x ON x.id OPERATOR(pg_catalog.=) b.action_id
      JOIN %1$I.agent_approvals p ON p.action_id OPERATOR(pg_catalog.=) x.id
      WHERE b.mission_id OPERATOR(pg_catalog.=) p_mission_id
        AND b.attempt_id OPERATOR(pg_catalog.=) p_attempt_id
        AND b.action_type OPERATOR(pg_catalog.=) p_action_type
        AND b.payload_hash OPERATOR(pg_catalog.=) p_payload_hash
        AND b.head_sha IS NOT DISTINCT FROM p_head_sha
        AND b.expires_at OPERATOR(pg_catalog.>) pg_catalog.clock_timestamp()
        AND x.intent OPERATOR(pg_catalog.=) b.action_type
        AND x.payload_hash OPERATOR(pg_catalog.=) b.payload_hash
        AND x.status OPERATOR(pg_catalog.=) 'approved'
        AND x.approval_expires_at OPERATOR(pg_catalog.>) pg_catalog.clock_timestamp()
        AND p.payload_hash OPERATOR(pg_catalog.=) b.payload_hash
        AND p.decision OPERATOR(pg_catalog.=) 'approved'
        AND p.expires_at OPERATOR(pg_catalog.>) pg_catalog.clock_timestamp()
        AND p.approver OPERATOR(pg_catalog.=) 'human-admin'
        AND p.decided_at OPERATOR(pg_catalog.>=) (
          SELECT created_at FROM %1$I.mission_attempts WHERE id OPERATOR(pg_catalog.=) p_attempt_id)
      LIMIT 1 FOR SHARE OF x,p;
      -- Time may have elapsed while waiting for locks even without a row update.
      RETURN COALESCE(valid_until OPERATOR(pg_catalog.>) pg_catalog.clock_timestamp(),false);
    END;
    $function$;
  $ddl$,app_schema);
  function_oid := pg_catalog.to_regprocedure(pg_catalog.format('%I.mission_execution_approval_valid(uuid,uuid,text,text,text)',app_schema));
  EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO %I',function_oid::pg_catalog.regprocedure,owner_name);
  EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',function_oid::pg_catalog.regprocedure);
  -- Also remove grants inherited from installer default privileges.
  FOR unexpected_grantee IN
    SELECT DISTINCT r.rolname FROM pg_catalog.pg_proc p,
      LATERAL pg_catalog.aclexplode(p.proacl) a JOIN pg_catalog.pg_roles r ON r.oid=a.grantee
      WHERE p.oid=function_oid AND r.rolname<>owner_name AND r.rolname<>callback_name
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %I',function_oid::pg_catalog.regprocedure,unexpected_grantee.rolname);
  END LOOP;
  EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO %I',function_oid::pg_catalog.regprocedure,callback_name);
END;
$migration$;

COMMIT;
