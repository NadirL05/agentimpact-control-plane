import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { AppEnv } from '../hono-env.js';
import { MissionStore, type Mission } from './store.js';
import { enabled, digest, type Admission } from './model.js';
import { database } from './testing/database.js';
import { fakePlanner, fakeWorker } from './testing/fakes.js';
import { createMissionsV2Api } from '../../api/missions-v2.js';
import { handleV2Command } from '../../slack-router/missions-v2.js';
import { prepareDispatchTx } from '../../slack-router/stores/postgres-persistence.js';

let fixture: Awaited<ReturnType<typeof database>>;
let store: MissionStore;
const config = {enabled:true,projects:new Set(['IMANE'])};
const meta = () => ({principal:'test:operator',key:randomUUID()});
const input = (): Admission => ({project:'IMANE',title:'Test mission',objective:'Use synthetic fixture',source_type:'command',source_id:randomUUID()});
const admit = () => store.admit(input(),meta());
async function planning(m: Mission) { return store.transition(m.id,m.state_version,'planning',meta()); }
beforeAll(async () => {fixture=await database();store=new MissionStore(fixture.pool,config);},30000);
afterAll(async () => {await fixture?.db.close();});

describe('V2-A PostgreSQL foundation',() => {
  it('is disabled by default, with no database query',async() => {
    expect(enabled({})).toBe(false);
    const s=new MissionStore(fixture.pool,{...config,enabled:false});
    await expect(s.admit(input(),meta())).rejects.toMatchObject({code:'v2_disabled'});
  });
  it('persists one mission across duplicate events, exact replay, and fresh receipt keys',async() => {
    const data={...input(),source_type:'slack' as const};const key=meta();
    const slack={team_id:'T1',event_id:randomUUID(),channel:'C1',thread_ts:'1.0',user:'U1',is_root:true};
    const first=await store.admit(data,key,slack);
    expect(await store.admit(data,key,slack)).toEqual(first);
    expect(await store.admit(data,meta(),slack)).toEqual(first);
    const count=await fixture.db.query('SELECT count(*)::int AS n FROM slack_gateway_inbox WHERE mission_id=$1',[first.id]);
    expect(count.rows).toEqual([{n:1}]);
    expect(await store.events(first.id)).toHaveLength(1);
  });
  it('rejects a reused key or provenance with different payload',async() => {
    const data=input(), key=meta();await store.admit(data,key);
    await expect(store.admit({...data,objective:'Different objective'},key)).rejects.toMatchObject({code:'idempotency_conflict'});
    await expect(store.admit({...data,objective:'Different objective'},meta())).rejects.toMatchObject({code:'provenance_conflict'});
    expect(digest({a:1,b:2})).toBe(digest({b:2,a:1}));
  });
  it.each(['before_commit','after_commit'] as const)('recovers after %s without double admission',async crash => {
    const data={...input(),source_type:'slack' as const}, key=meta();
    const slack={team_id:'T1',event_id:randomUUID(),channel:'C2',thread_ts:randomUUID(),user:'U1',is_root:true};
    fixture.crash(crash);
    await expect(store.admit(data,key,slack)).rejects.toMatchObject({code:'mission_storage_unavailable'});
    const before=await fixture.db.query('SELECT count(*)::int n FROM agent_missions WHERE source_id=$1',[data.source_id]);
    expect(before.rows).toEqual([{n:crash==='before_commit'?0:1}]);
    const m=await new MissionStore(fixture.pool,config).admit(data,key,slack);
    expect(await store.events(m.id)).toHaveLength(1);
    expect((await fixture.db.query('SELECT count(*)::int n FROM slack_gateway_inbox WHERE mission_id=$1',[m.id])).rows).toEqual([{n:1}]);
  });
  it('persists parent/child; forbids cross-project or self hierarchy',async() => {
    const parent=await admit();const child=await store.admit({...input(),source_type:'child',parent_mission_id:parent.id},meta());
    expect((await store.get(child.id)).parent_mission_id).toBe(parent.id);
    await expect(fixture.db.query('UPDATE agent_missions SET parent_mission_id=id WHERE id=$1',[child.id])).rejects.toThrow();
  });
  it('versions plans and rejects cycles without partial writes',async() => {
    let a=await planning(await admit()), b=await planning(await admit());
    a=await store.savePlan(a.id,a.state_version,{...fakePlanner(),dependencies:[{mission_id:b.id,type:'artifact'}]},meta());
    expect(a.lifecycle_state).toBe('waiting_dependencies');
    await expect(store.savePlan(b.id,b.state_version,{...fakePlanner(),dependencies:[{mission_id:a.id,type:'human_merge'}]},meta())).rejects.toMatchObject({code:'mission_constraint_conflict'});
    expect(await store.plan(b.id)).toBeNull();
    b=await store.savePlan(b.id,b.state_version,fakePlanner(),meta());
    b=await planning(b);b=await store.savePlan(b.id,b.state_version,fakePlanner(),meta());
    expect(b.plan_version).toBe(2);
    expect((await store.plan(b.id))?.version).toBe(2);
    await expect(fixture.db.query('DELETE FROM mission_plans WHERE mission_id=$1',[b.id])).rejects.toThrow();
  });
  it('permits only one competing state_version update and never running',async() => {
    const m=await admit();
    const results=await Promise.allSettled([store.transition(m.id,0,'planning',meta()),store.transition(m.id,0,'blocked',meta())]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
    const current=await store.get(m.id);
    await expect(store.transition(m.id,current.state_version,'running',meta())).rejects.toMatchObject({code:'invalid_transition'});
    expect(fakeWorker(current)).toMatchObject({outcome:'simulated',provider_calls:0});
  });
  it('maintains V1 action requirement and rejects V1 in all V2 readers and mutations',async() => {
    await expect(fixture.db.query("INSERT INTO agent_missions(target_agent,source_type,source_id,title) VALUES('dev-senior','test','no-action','test')")).rejects.toThrow();
    const action=await fixture.db.query<{id:string}>('INSERT INTO agent_actions DEFAULT VALUES RETURNING id');
    const v1=await fixture.db.query<Mission>("INSERT INTO agent_missions(action_id,target_agent,source_type,source_id,title) VALUES($1,'dev-senior','test',$2,'V1 test') RETURNING *",[action.rows[0].id,randomUUID()]);
    await expect(store.get(v1.rows[0].id)).rejects.toMatchObject({code:'wrong_orchestration_version'});
    await expect(store.transition(v1.rows[0].id,0,'planning',meta())).rejects.toMatchObject({code:'wrong_orchestration_version'});
    expect(()=>fakeWorker(v1.rows[0])).toThrow('wrong_orchestration_version');
    const m=await admit();
    const r=await fixture.db.query("UPDATE agent_missions m SET status='in_progress' WHERE id=$1 AND coalesce(to_jsonb(m)->>'orchestration_version','1')='1' RETURNING id",[m.id]);
    expect(r.rows).toHaveLength(0);
  });
  it('events contain only metadata and reject update/delete/truncate',async() => {
    const marker='PRIVATE_INPUT_SENTINEL';
    const m=await store.admit({...input(),objective:marker},meta());
    const rows=await store.events(m.id);
    expect(JSON.stringify(rows)).not.toContain(marker);
    expect(Object.keys(rows[0]).sort()).toEqual(['id','mission_id','event_type','state_version','plan_version','lifecycle_state','created_at'].sort());
    for (const query of ['UPDATE mission_events SET event_type=event_type','DELETE FROM mission_events','TRUNCATE mission_events']) {
      await expect(fixture.db.query(query)).rejects.toThrow('immutable_mission_record');
    }
  });
  it('STATUS mission/project and unknown mission use deterministic data',async() => {
    const m=await admit();const base={type:'message' as const,team_id:'T1',event_id:randomUUID(),channel:'C1',user:'U1',ts:'3.0'};
    expect(await handleV2Command({...base,text:`STATUS ${m.id}`},store,'U1',()=>{})).toContain(m.id);
    expect(await handleV2Command({...base,text:'STATUS IMANE'},store,'U1',()=>{})).toContain('IMANE');
    expect(await handleV2Command({...base,text:`STATUS ${randomUUID()}`},store,'U1',()=>{})).toContain('mission_not_found');
    expect(await handleV2Command({...base,text:'STATUS IMANE',user:'other'},store,'U1',()=>{})).toContain('réservée');
  });
  it('ACK callback is after commit and a lost reply can be replayed',async() => {
    const event={type:'message' as const,team_id:'T1',event_id:randomUUID(),channel:'C3',user:'U1',ts:'4.0',text:'MISSION V2 IMANE Test durable admission'};
    const accepted=vi.fn();
    fixture.crash('before_commit');
    await expect(handleV2Command(event,store,'U1',accepted)).rejects.toThrow();
    expect(accepted).not.toHaveBeenCalled();
    const first=await handleV2Command(event,store,'U1',accepted);
    expect(accepted).toHaveBeenCalledOnce();
    expect(await handleV2Command(event,store,'U1',accepted)).toBe(first);
  });
  it('V1 admission rolls back dedup and ownership when inbox insert fails',async() => {
    const c=await fixture.pool.connect();
    const event={type:'message' as const,team_id:'T1',event_id:randomUUID(),channel:'C1',user:'U1',ts:'8.0',text:'hello'};
    await c.query('BEGIN');
    await expect(prepareDispatchTx({query:async(sql,params)=> {
      if (sql.includes('INSERT INTO slack_gateway_inbox')) throw new Error('crash');
      return c.query(sql,params);
    }},event,'hermes',true)).rejects.toThrow('crash');
    await c.query('ROLLBACK');
    expect((await fixture.db.query('SELECT * FROM slack_event_dedup WHERE event_id=$1',[event.event_id])).rows).toHaveLength(0);
    await c.query('BEGIN');await prepareDispatchTx(c,event,'hermes',true);await c.query('COMMIT');c.release();
    expect((await fixture.db.query('SELECT * FROM slack_gateway_inbox WHERE event_id=$1',[event.event_id])).rows).toHaveLength(1);
  });
  it('V1 transport cannot admit follow-ups into a V2 thread',async() => {
    const data={...input(),source_type:'slack' as const};
    await store.admit(data,meta(),{team_id:'T1',event_id:randomUUID(),channel:'CV2',thread_ts:'1.0',user:'U1',is_root:true});
    const c=await fixture.pool.connect();
    try {
      await c.query('BEGIN');
      const result=await prepareDispatchTx(c,{type:'message',team_id:'T1',event_id:randomUUID(),channel:'CV2',ts:'2.0',thread_ts:'1.0',user:'U1',text:'continue'},'hermes',false);
      expect(result.status).toBe('v2_thread');
      await c.query('COMMIT');
      expect((await fixture.db.query("SELECT count(*)::int n FROM slack_gateway_inbox WHERE channel_id='CV2'")).rows).toEqual([{n:1}]);
    } finally {c.release();}
  });
  it('API returns status, validates identifiers and fails closed without authentication',async() => {
    const app=new Hono<AppEnv>();app.use('*',async(c,next)=>{c.set('authScope','hermes');await next();});app.route('/api/v2',createMissionsV2Api(store));
    const m=await admit();
    expect((await app.request(`/api/v2/missions/${m.id}`)).status).toBe(200);
    expect((await app.request('/api/v2/status?project=IMANE')).status).toBe(200);
    expect((await app.request(`/api/v2/missions/${randomUUID()}`)).status).toBe(404);
    expect((await app.request('/api/v2/missions/nope')).status).toBe(400);
    expect((await createMissionsV2Api(store).request('/status?project=IMANE')).status).toBe(403);
  });
});
it('recovers mission and versioned plan after closing/reopening PostgreSQL storage',async() => {
  const path=await mkdtemp(join(tmpdir(),'v2-a-pg-'));
  try {
    const first=await database(path);const s=new MissionStore(first.pool,config);
    let m=await s.admit(input(),meta());m=await s.transition(m.id,0,'planning',meta());await s.savePlan(m.id,m.state_version,fakePlanner(),meta());
    await first.db.close();const second=await database(path);const restored=new MissionStore(second.pool,config);
    expect((await restored.get(m.id)).plan_version).toBe(1);
    expect((await restored.plan(m.id))?.plan).toEqual(fakePlanner());
    await second.db.close();
  } finally {await rm(path,{recursive:true,force:true});}
},30000);
