import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { database } from '../core/missions-v2/testing/database.js';
import { MissionStore } from '../core/missions-v2/store.js';
const state=vi.hoisted(()=>({pool:null as Pool | null}));
vi.mock('./db.js',()=>({pool:{query:(...args:unknown[])=>Reflect.apply(state.pool!.query,state.pool,args),connect:()=>state.pool!.connect()}}));
import missions from './missions.js';
import inbox from './gateway-inbox.js';
const app=new Hono();app.route('/missions',missions);app.route('/inbox',inbox);
const body=(data:unknown,method='POST')=>({method,headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
let db: Awaited<ReturnType<typeof database>>;
beforeAll(async()=>{db=await database();state.pool=db.pool;},30000);
afterAll(async()=>{await db?.db.close();});
describe('actual V1 endpoints with V2 SQL rows',()=>{
  it('cannot list, dispatch, complete or claim V2, even if given an explicit ID',async()=>{
    const store=new MissionStore(db.pool,{enabled:true,projects:new Set(['IMANE'])});
    const m=await store.admit({project:'IMANE',title:'Synthetic request',objective:'Validate V1 isolation',source_type:'slack',source_id:randomUUID()},
      {principal:'test:operator',key:randomUUID()},
      {team_id:'T1',event_id:randomUUID(),channel:'C1',thread_ts:'1.0',user:'U1',is_root:true});
    const listed=await (await app.request('/missions')).json() as {items:unknown[]};expect(listed.items).toEqual([]);
    expect((await app.request(`/missions/${m.id}`)).status).toBe(404);
    expect((await app.request(`/missions/${m.id}/dispatch`,body({}))).status).toBe(404);
    expect((await app.request(`/missions/${m.id}/result`,body({result:{summary:'fake'}},'PATCH'))).status).toBe(404);
    expect((await app.request('/inbox/claim',body({target:'hermes'}))).status).toBe(204);
    const row=await db.db.query<{id:string}>('SELECT id FROM slack_gateway_inbox WHERE mission_id=$1',[m.id]);
    expect((await app.request(`/inbox/${row.rows[0].id}/complete`,body({text:'fake'}))).status).toBe(409);
    expect((await store.get(m.id)).lifecycle_state).toBe('queued');
  });
  it('V1 continues to claim and complete on schema 003, before migration 004',async()=>{
    const old=await database(undefined,false);state.pool=old.pool;
    try {
      const r=await old.db.query<{id:string}>(`INSERT INTO slack_gateway_inbox(target,prompt,channel_id,thread_ts,user_id,event_id)
        VALUES('hermes','Synthetic input','C1','1.0','U1','Ev1') RETURNING id`);
      const claimed=await app.request('/inbox/claim',body({target:'hermes'}));
      expect(claimed.status).toBe(200);expect((await claimed.json() as {item:{orchestration_version:number}}).item.orchestration_version).toBe(1);
      expect((await app.request(`/inbox/${r.rows[0].id}/complete`,body({text:'Synthetic result'}))).status).toBe(200);
      expect((await app.request('/missions')).status).toBe(200);
    } finally {state.pool=db.pool;await old.db.close();}
  },30000);
});
