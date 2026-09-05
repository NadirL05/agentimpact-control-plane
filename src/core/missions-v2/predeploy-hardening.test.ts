import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {ExecutionControl} from './execution.js';
import {readyMission,testMutation} from './testing/execution-database.js';

const socket=process.env.V2_TEST_PG_SOCKET;
const privateSocket=socket&&/^\/tmp\/v2-a-pg-[A-Za-z0-9]+\/socket$/.test(socket);
const migrations=['001_cursor_proposals.sql','002_slack_router.sql','003_async_long_running_missions.sql',
  '004_v2_mission_foundation.sql','005_v2_execution_control.sql','006_v2_codex_worker.sql'];
const connection={host:socket,port:55437,database:'postgres',user:'v2_test',password:''};

describe.skipIf(!privateSocket)('V2-B pre-deploy PostgreSQL hardening',()=>{
  const schemas:string[]=[];
  let bootstrap:Pool;
  async function isolated(files=migrations){
    const schema=`v2_b_${randomUUID().replaceAll('-','')}`;schemas.push(schema);
    await bootstrap.query(`CREATE SCHEMA ${schema}`);
    const pool=new Pool({...connection,max:8,options:`-c search_path=${schema}`});
    await pool.query(await readFile(new URL('./testing/schema.sql',import.meta.url),'utf8'));
    for(const file of files)await pool.query(await readFile(new URL(`../../migrations/${file}`,import.meta.url),'utf8'));
    return{pool,schema};
  }
  async function harden(pool:Pool){await pool.query(await readFile(new URL('../../migrations/007_v2_codex_predeploy_hardening.sql',import.meta.url),'utf8'));}
  const control=(pool:Pool,repos:string[])=>new ExecutionControl(pool,{enabled:true,projects:new Set(['IMANE']),
    workerIds:new Set(['codex-one']),workerTypes:new Set(['codex']),workspaceRoots:{codex:'/var/lib/agentimpact-codex-worker/workspaces'},
    repoIds:new Set(repos),quotaAmount:1000});
  const options=(repo:string)=>({worker_type:'codex' as const,worker_instance_id:'codex-one',workspace:{repo,base_sha:'a'.repeat(40),
    branch:`codex/${randomUUID()}`,workspace_root:'/var/lib/agentimpact-codex-worker/workspaces'},
    budget:{max_amount:10,reserved_amount:10,currency:'FAKE' as const}});

  beforeAll(()=>{bootstrap=new Pool({...connection,max:2});});
  afterAll(async()=>{for(const schema of schemas)await bootstrap.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await bootstrap.end();});

  it('migrates a fresh 004 -> 005 -> 006 chain and leaves no active state in the writer index',async()=>{
    const {pool}=await isolated();try{await harden(pool);
      const row=(await pool.query(`SELECT pg_get_expr(indpred,indrelid) predicate FROM pg_index
        WHERE indexrelid='worktree_leases_one_codex_writer_per_repo'::regclass`)).rows[0];
      expect(row.predicate).toContain("'reserved'");expect(row.predicate).toContain("'leased'");
      expect(row.predicate).toContain("'quarantined'");expect(row.predicate).not.toContain("'active'");
      await expect(harden(pool)).rejects.toThrow();
    }finally{await pool.end();}
  });

  it.each(['leased','quarantined'] as const)('blocks another Codex writer while the existing repo is %s',async status=>{
    const {pool}=await isolated();try{await harden(pool);const execution=control(pool,['same-repo']);
      const first=await execution.queue((await readyMission(pool)).id,testMutation(),options('same-repo'));
      await pool.query('UPDATE worktree_leases SET status=$2 WHERE attempt_id=$1',[first.id,status]);
      await expect(execution.queue((await readyMission(pool)).id,testMutation(),options('same-repo')))
        .rejects.toMatchObject({code:'execution_ownership_conflict'});
    }finally{await pool.end();}
  });

  it('keeps reserved versus leased exclusive, permits another repo, and permits reuse after release',async()=>{
    const {pool}=await isolated();try{await harden(pool);const execution=control(pool,['repo-a','repo-b']);
      const first=await execution.queue((await readyMission(pool)).id,testMutation(),options('repo-a'));
      await expect(execution.queue((await readyMission(pool)).id,testMutation(),options('repo-a')))
        .rejects.toMatchObject({code:'execution_ownership_conflict'});
      await expect(execution.queue((await readyMission(pool)).id,testMutation(),options('repo-b'))).resolves.toBeTruthy();
      await pool.query('UPDATE mission_attempts SET stop_proof_at=clock_timestamp() WHERE id=$1',[first.id]);
      await pool.query("UPDATE worktree_leases SET status='released' WHERE attempt_id=$1",[first.id]);
      await expect(execution.queue((await readyMission(pool)).id,testMutation(),options('repo-a'))).resolves.toBeTruthy();
    }finally{await pool.end();}
  });

  it('fails closed when migration 006 is absent or its writer index is unexpected',async()=>{
    const without006=await isolated(migrations.slice(0,-1));
    try{await expect(harden(without006.pool)).rejects.toThrow();}finally{await without006.pool.end();}
    const altered=await isolated();try{
      await altered.pool.query('DROP INDEX worktree_leases_one_codex_writer_per_repo');
      await altered.pool.query("CREATE INDEX worktree_leases_one_codex_writer_per_repo ON worktree_leases(repo) WHERE worker_type='codex'");
      await expect(harden(altered.pool)).rejects.toThrow();
    }finally{await altered.pool.end();}
  });
});
