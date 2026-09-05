import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { MissionStore } from './store.js';
import { fakePlanner } from './testing/fakes.js';

// Only the private socket created by test-v2-a-postgres.sh is accepted. No PG*
// production environment or TCP connection is used by this suite.
const socket = process.env.V2_TEST_PG_SOCKET;
const valid = socket && /^\/tmp\/v2-a-pg-[A-Za-z0-9]+\/socket$/.test(socket);
describe.skipIf(!valid)('native PostgreSQL multi-connection isolation',()=>{
  let pool: Pool;
  let store: MissionStore;
  beforeAll(async()=>{
    pool=new Pool({host:socket,port:55437,database:'postgres',user:'v2_test',max:5});
    await pool.query(await readFile(new URL('./testing/schema.sql',import.meta.url),'utf8'));
    for (const file of ['001_cursor_proposals.sql','002_slack_router.sql','003_async_long_running_missions.sql','004_v2_mission_foundation.sql']) {
      await pool.query(await readFile(new URL(`../../migrations/${file}`,import.meta.url),'utf8'));
    }
    store=new MissionStore(pool,{enabled:true,projects:new Set(['IMANE'])});
  });
  afterAll(async()=>{await pool?.end();});
  const meta=()=>({principal:'test:operator',key:randomUUID()});
  const input=()=>({project:'IMANE',title:'Concurrent fixture',objective:'Test isolation',source_type:'command' as const,source_id:randomUUID()});
  it('serializes duplicate admissions on distinct connections',async()=>{
    const data=input(), key=meta();
    const results=await Promise.all(Array.from({length:5},()=>store.admit(data,key)));
    expect(new Set(results.map(m=>m.id)).size).toBe(1);
    expect((await pool.query('SELECT count(*)::int n FROM mission_events WHERE mission_id=$1',[results[0].id])).rows).toEqual([{n:1}]);
  });
  it('rejects one competing version update',async()=>{
    const m=await store.admit(input(),meta());
    const results=await Promise.allSettled([store.transition(m.id,0,'planning',meta()),store.transition(m.id,0,'blocked',meta())]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
    expect((await store.get(m.id)).state_version).toBe(1);
  });
  it('concurrent opposing DAG edges cannot both commit',async()=>{
    const a=await store.admit(input(),meta()), b=await store.admit(input(),meta());
    await store.transition(a.id,0,'planning',meta());await store.transition(b.id,0,'planning',meta());
    const results=await Promise.allSettled([
      store.savePlan(a.id,1,{...fakePlanner(),dependencies:[{mission_id:b.id,type:'artifact'}]},meta()),
      store.savePlan(b.id,1,{...fakePlanner(),dependencies:[{mission_id:a.id,type:'artifact'}]},meta()),
    ]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
    expect((await pool.query('SELECT count(*)::int n FROM mission_dependencies')).rows).toEqual([{n:1}]);
  });
});
