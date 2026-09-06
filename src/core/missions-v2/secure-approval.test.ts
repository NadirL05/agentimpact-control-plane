import {afterAll,afterEach,beforeAll,describe,expect,it} from 'vitest';
import {PGlite as PG16} from '@electric-sql/pglite-pg16';
import {PGlite as PG18} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {ExecutionControl,approvalPayloadHash} from './execution.js';
import {readyMission,testMutation} from './testing/execution-database.js';

const signature='public.mission_execution_approval_valid(uuid,uuid,text,text,text)';
const callback='agentimpact_codex_control';
const owner='agentimpact_approval_validator';
const relations=['mission_approval_bindings','agent_actions','agent_approvals','mission_attempts'] as const;
const migration=await readFile(new URL('../../migrations/008_v2_controlled_canary_prerequisites.sql',import.meta.url),'utf8');
const repair=await readFile(new URL('../../migrations/009_v2_secure_approval_repair.sql',import.meta.url),'utf8');
const original=await readFile(new URL('./testing/vulnerable-008.sql',import.meta.url),'utf8');
const scripts=await Promise.all(['001_cursor_proposals.sql','002_slack_router.sql','003_async_long_running_missions.sql',
  '004_v2_mission_foundation.sql','005_v2_execution_control.sql','006_v2_codex_worker.sql','007_v2_codex_predeploy_hardening.sql']
  .map(file=>readFile(new URL(`../../migrations/${file}`,import.meta.url),'utf8')));

// Two genuine PostgreSQL WASM engines, disposable only. Native connection/lock
// contention is tested separately by execution-concurrency.test.ts in CI.
for(const [label,create] of [['PostgreSQL 16',()=>new PG16()],['PostgreSQL 18',()=>new PG18()]] as const){
  for(const route of ['fresh008','original008repair009','secure008repair009'] as const){
  describe(`${label} ${route} secure approval definer`,()=>{
    let db:ReturnType<typeof create>;
    let pool:Pool;
    let control:ExecutionControl;
    const query=async(sql:string,params?:unknown[])=>{
      const r=await db.query(sql,params);return {...r,rowCount:r.rows.length||r.affectedRows||0};
    };
    beforeAll(async()=>{
      db=create();await db.waitReady;
      expect((await db.query<{version:string}>('SELECT version() AS version')).rows[0].version).toContain(label+'.');
      await db.exec(await readFile(new URL('./testing/schema.sql',import.meta.url),'utf8'));
      for(const script of scripts)await db.exec(script);
      await db.exec(`CREATE ROLE ${callback} NOLOGIN; CREATE ROLE approval_outsider NOLOGIN;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT USAGE ON SCHEMA public TO ${callback},approval_outsider;
        GRANT TEMP ON DATABASE template1 TO ${callback};
        GRANT SELECT,UPDATE ON agent_missions,mission_attempts,worktree_leases,budget_reservations,codex_attempt_metadata TO ${callback};
        GRANT INSERT ON codex_attempt_metadata TO ${callback};
        GRANT SELECT ON agent_actions,agent_approvals,mission_plans,mission_dependencies,mission_dependency_evidence,mission_approval_bindings TO ${callback};
        GRANT INSERT ON mission_events TO ${callback};
        GRANT SELECT,INSERT ON execution_receipts,codex_artifacts TO ${callback};
        GRANT SELECT,INSERT,UPDATE ON execution_metrics TO ${callback};
        GRANT USAGE ON SEQUENCE mission_events_id_seq TO ${callback};
        ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO approval_outsider;`);
      await expect(db.exec(repair)).rejects.toMatchObject({code:'55000'});await db.exec('ROLLBACK');
      await db.exec(route==='original008repair009'?original:migration);
      pool={query,connect:async()=>({query,release(){}})} as unknown as Pool;
      control=new ExecutionControl(pool,{enabled:true,projects:new Set(['IMANE']),workerIds:new Set(['codex-test']),
        workerTypes:new Set(['codex']),workspaceRoots:{codex:'/var/lib/agentimpact-codex-worker/workspaces'}});
      if(route!=='fresh008'){
        const valid=await seed();
        const missing=await seed(false);
        const oid=(await db.query('SELECT $1::regprocedure::oid AS oid',[signature])).rows;
        const approvals=(await db.query('SELECT * FROM public.agent_approvals ORDER BY id')).rows;
        await db.exec(`CREATE VIEW public.approval_dependency_probe AS SELECT public.mission_execution_approval_valid(NULL,NULL,NULL,NULL,NULL) AS valid`);
        if(route==='original008repair009'){
          await db.exec(`SET ROLE ${callback}`);await shadow(missing.params);
          expect(await check(missing.params)).toBe(true);
          await db.exec('RESET ROLE; DISCARD TEMP');
        }
        // Historic ACL drift, including delegated grants, must be removed.
        await db.exec(`GRANT EXECUTE ON FUNCTION ${signature} TO ${callback} WITH GRANT OPTION;
          SET ROLE ${callback}; GRANT EXECUTE ON FUNCTION ${signature} TO approval_outsider; RESET ROLE;`);
        await db.exec(repair);
        expect((await db.query('SELECT $1::regprocedure::oid AS oid',[signature])).rows).toEqual(oid);
        expect((await db.query('SELECT * FROM public.agent_approvals ORDER BY id')).rows).toEqual(approvals);
        expect((await db.query('SELECT * FROM public.approval_dependency_probe')).rows).toEqual([{valid:false}]);
        await db.exec(`SET ROLE ${callback}`);
        expect(await check(valid.params)).toBe(true);
        await shadow(missing.params);expect(await check(missing.params)).toBe(false);
        await db.exec('RESET ROLE; DISCARD TEMP');
      }

    },30000);
    afterEach(async()=>{await db.exec('ROLLBACK; SET SESSION AUTHORIZATION postgres; RESET ROLE; SET search_path=public; DISCARD TEMP;');});
    afterAll(async()=>{await db?.close();});

    async function seed(approved=true){
      const mission=await readyMission(pool);
      const attempt=await control.queue(mission.id,testMutation(),{worker_type:'codex',worker_instance_id:'codex-test',
        workspace:{repo:randomUUID(),branch:`fixture/${randomUUID()}`,base_sha:'a'.repeat(40)},
        budget:{max_amount:10,reserved_amount:10,currency:'FAKE'}});
      const hash=approvalPayloadHash(attempt,'execute');
      let actionId:string|null=null;
      if(approved){
        const row=await db.query<{id:string}>(`INSERT INTO public.agent_actions(intent,status,payload_hash,approval_expires_at)
          VALUES('execute','approved',$1,clock_timestamp()+interval '1 hour') RETURNING id`,[hash]);
        actionId=row.rows[0].id;
        await db.query(`INSERT INTO public.agent_approvals(action_id,decision,payload_hash,approver,expires_at)
          VALUES($1,'approved',$2,'human-admin',clock_timestamp()+interval '1 hour')`,[actionId,hash]);
        await control.bindApproval(mission.id,attempt.id,{action_id:actionId,action_type:'execute',payload_hash:hash},testMutation());
      }
      return {mission,attempt,actionId,params:[mission.id,attempt.id,'execute',hash,null]};
    }
    async function check(params:unknown[]){
      return (await db.query<{valid:boolean}>('SELECT public.mission_execution_approval_valid($1,$2,$3,$4,$5) AS valid',params)).rows[0].valid;
    }
    async function shadow(params:unknown[]){
      for(const relation of relations)await db.exec(`CREATE TEMP TABLE ${relation} AS SELECT * FROM public.${relation} WITH NO DATA`);
      const action=randomUUID();
      await db.query(`INSERT INTO pg_temp.mission_approval_bindings(mission_id,attempt_id,action_type,payload_hash,head_sha,action_id,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '1 hour')`,[...params,action]);
      await db.query(`INSERT INTO pg_temp.agent_actions(id,intent,payload_hash,status,approval_expires_at)
        VALUES($1,'execute',$2,'approved',clock_timestamp()+interval '1 hour')`,[action,params[3]]);
      await db.query(`INSERT INTO pg_temp.agent_approvals(action_id,payload_hash,decision,expires_at,approver,decided_at)
        VALUES($1,$2,'approved',clock_timestamp()+interval '1 hour','human-admin',clock_timestamp())`,[action,params[3]]);
      await db.query("INSERT INTO pg_temp.mission_attempts(id,created_at) VALUES($1,clock_timestamp()-interval '1 minute')",[params[1]]);
    }

    it('blocks the exact four-table exploit despite callback TEMP privilege, without a privileged transition',async()=>{
      const f=await seed(false);
      const before=(await db.query('SELECT lifecycle_state,state_version FROM public.agent_missions WHERE id=$1',[f.mission.id])).rows;
      const count=(await db.query('SELECT count(*) FROM public.agent_approvals')).rows;
      await db.exec(`SET ROLE ${callback}`);
      expect((await db.query<{allowed:boolean}>("SELECT has_database_privilege(current_user,current_database(),'TEMP') AS allowed")).rows[0].allowed).toBe(true);
      expect(await check(f.params)).toBe(false);
      await shadow(f.params);
      expect(await check(f.params)).toBe(false);
      expect((await db.query('SELECT count(*) FROM public.agent_approvals')).rows).toEqual(count);
      expect((await db.query('SELECT lifecycle_state,state_version FROM public.agent_missions WHERE id=$1',[f.mission.id])).rows).toEqual(before);
    });

    it.each(relations)('ignores a temporary %s and accepts only the real valid binding',async relation=>{
      const f=await seed();await db.exec(`SET ROLE ${callback}`);
      await db.exec(`CREATE TEMP TABLE ${relation} AS SELECT * FROM public.${relation} WITH NO DATA`);
      expect(await check(f.params)).toBe(true);
    });

    it.each(['hostile,public','pg_temp,hostile,public','hostile,pg_temp'])('rejects substitution with caller search_path=%s',async path=>{
      const f=await seed(false);
      const expired=await seed();
      await db.query("UPDATE public.agent_approvals SET expires_at=clock_timestamp()-interval '1 second' WHERE action_id=$1",[expired.actionId]);
      await db.exec(`CREATE SCHEMA IF NOT EXISTS hostile AUTHORIZATION ${callback}; SET ROLE ${callback}`);
      await shadow(f.params);
      await db.exec(`CREATE OR REPLACE FUNCTION hostile.clock_timestamp() RETURNS timestamptz LANGUAGE sql AS 'SELECT ''2099-01-01''::timestamptz';
        CREATE FUNCTION pg_temp.clock_timestamp() RETURNS timestamptz LANGUAGE sql AS 'SELECT ''2099-01-01''::timestamptz';
        SET search_path=${path};`);
      expect(await check(f.params)).toBe(false);
      // Fake a callback-writable clock; even a real but expired approval stays refused.
      expect(await check(expired.params)).toBe(false);
    });

    it.each(['mission','attempt','action','payload','head','expired','rejected','approver','decision_before_attempt'])('rejects changed %s',async field=>{
      const f=await seed();
      if(field==='mission')f.params[0]=randomUUID();
      if(field==='attempt')f.params[1]=randomUUID();
      if(field==='action')f.params[2]='review';
      if(field==='payload')f.params[3]='c'.repeat(64);
      if(field==='head')f.params[4]='c'.repeat(40);
      if(field==='expired')await db.query("UPDATE public.agent_approvals SET expires_at=clock_timestamp()-interval '1 second' WHERE action_id=$1",[f.actionId]);
      if(field==='rejected')await db.query("UPDATE public.agent_approvals SET decision='rejected' WHERE action_id=$1",[f.actionId]);
      if(field==='approver')await db.query("UPDATE public.agent_approvals SET approver='untrusted' WHERE action_id=$1",[f.actionId]);
      if(field==='decision_before_attempt')await db.query("UPDATE public.agent_approvals SET decided_at='2000-01-01' WHERE action_id=$1",[f.actionId]);
      await db.exec(`SET ROLE ${callback}`);expect(await check(f.params)).toBe(false);
    });

    it('allows actual claim/start with the bounded callback grants and an approved attempt',async()=>{
      const f=await seed();await db.exec(`SET SESSION AUTHORIZATION ${callback}`);
      const proof={attempt_id:f.attempt.id,worker_instance_id:'codex-test',fencing_token:f.attempt.fencing_token};
      expect(await check(f.params)).toBe(true);
      expect((await control.claim(f.attempt.id,'codex-test',proof,testMutation())).status).toBe('claimed');
      expect((await control.start(proof,'codex-test',testMutation())).status).toBe('running');
      for(const table of ['agent_actions','agent_approvals']){
        await expect(db.exec(`UPDATE public.${table} SET id=gen_random_uuid()`)).rejects.toMatchObject({code:'42501'});
      }
      await expect(db.exec(`SET ROLE ${owner}`)).rejects.toMatchObject({code:'42501'});
    });

    it('denies outsiders and inherited default EXECUTE grants; public has no EXECUTE',async()=>{
      const f=await seed();await db.exec('SET ROLE approval_outsider');
      await expect(check(f.params)).rejects.toMatchObject({code:'42501'});
      await db.exec(`RESET ROLE; SET ROLE ${callback}`);
      expect(await check(f.params)).toBe(true);
      await expect(db.exec('CREATE TABLE public.callback_injection(id int)')).rejects.toMatchObject({code:'42501'});
    });

    it('pins installed owner, ACL, body, operators, and search_path against future migration regressions',async()=>{
      const p=(await db.query<{prosecdef:boolean;proconfig:string[];owner:string;definition:string;prosrc:string;grantees:string[]}>(`SELECT
        p.prosecdef,p.proconfig,pg_get_userbyid(p.proowner) AS owner,pg_get_functiondef(p.oid) AS definition,p.prosrc,
        ARRAY(SELECT (CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END)::text
          FROM aclexplode(p.proacl) a WHERE a.privilege_type='EXECUTE' ORDER BY 1) AS grantees
        FROM pg_proc p WHERE oid=$1::regprocedure`,[signature])).rows[0];
      expect(p.prosecdef).toBe(true);expect(p.proconfig).toEqual(['search_path=pg_catalog, pg_temp']);expect(p.owner).toBe(owner);
      expect(p.grantees).toEqual([owner,callback].sort());
      const body=migration.split('AS $function$')[1].split('$function$;')[0].replaceAll('%1$I','public');
      expect(p.prosrc).toBe(body);
      expect(p.definition).toContain("SET search_path TO 'pg_catalog', 'pg_temp'");
      for(const relation of relations)expect(p.prosrc).toMatch(new RegExp(`(?:FROM|JOIN) public\\.${relation}\\b`));
      expect(p.prosrc).not.toMatch(/\bEXECUTE\b|FROM CURRENT/);
      expect(p.prosrc).toContain('pg_catalog.clock_timestamp()');expect(p.prosrc).toContain('OPERATOR(pg_catalog.=)');
      const r=(await db.query<{rolcanlogin:boolean;rolsuper:boolean;rolcreaterole:boolean;rolcreatedb:boolean}>(
        'SELECT rolcanlogin,rolsuper,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=$1',[owner])).rows[0];
      expect(r).toEqual({rolcanlogin:false,rolsuper:false,rolcreaterole:false,rolcreatedb:false});
    });


    if(route!=='fresh008'){
      it('repeats 009 without changing the function identity, body or ACL',async()=>{
        const sql='SELECT oid,proowner,proacl,proconfig,prosrc FROM pg_proc WHERE oid=$1::regprocedure';
        const before=(await db.query(sql,[signature])).rows;
        await db.exec(repair);
        expect((await db.query(sql,[signature])).rows).toEqual(before);
      });
      it.each(['LOGIN','UPDATE'])('rejects owner privilege drift %s atomically',async drift=>{
        await db.exec(drift==='LOGIN'?`BEGIN; ALTER ROLE ${owner} LOGIN`:`BEGIN; GRANT UPDATE ON public.agent_approvals TO ${owner}`);
        await expect(db.exec(repair)).rejects.toMatchObject({code:'55000'});
        await db.exec('ROLLBACK');
        expect((await db.query<{rolcanlogin:boolean}>('SELECT rolcanlogin FROM pg_roles WHERE rolname=$1',[owner])).rows[0].rolcanlogin).toBe(false);
      });
    }

    it('refuses a second passage and preserves the installed function',async()=>{
      const before=(await db.query('SELECT pg_get_functiondef($1::regprocedure) AS definition',[signature])).rows;
      await expect(db.exec(migration)).rejects.toMatchObject({code:'55000'});await db.exec('ROLLBACK');
      expect((await db.query('SELECT pg_get_functiondef($1::regprocedure) AS definition',[signature])).rows).toEqual(before);
    });
  });
}
}
