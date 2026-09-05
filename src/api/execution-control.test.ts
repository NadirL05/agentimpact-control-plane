import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../core/hono-env.js';
import type { AuthScope } from '../core/auth-scopes.js';
import { isRouteAllowed } from '../core/auth-scopes.js';
import type { ExecutionControl } from '../core/missions-v2/execution.js';
import { configuredExecution, executionEnabled } from '../core/missions-v2/execution-config.js';
import type { MissionStore } from '../core/missions-v2/store.js';
import { createMissionsV2Api } from './missions-v2.js';
import type { Pool } from 'pg';

const id='d2bfaeb0-ed17-47e5-b77e-e7e020de38fb';
const attemptId='e2bfaeb0-ed17-47e5-b77e-e7e020de38fb';
function setup(scope: AuthScope='hermes', enabled=true) {
  const calls={cancel:vi.fn(async()=>({id,lifecycle_state:'cancel_requested'})),
    retry:vi.fn(async()=>({id:attemptId,attempt_number:2})),review:vi.fn(async()=>({id,lifecycle_state:'completed'})),
    bindApproval:vi.fn(async()=>({id})),metrics:vi.fn(async()=>({attempts_running:0})),
    status:vi.fn(async()=>({id,phase:'executing'})),statusProject:vi.fn(async()=>[{id,phase:'executing'}])};
  const app=new Hono<AppEnv>();
  app.use('*',async(c,next)=>{c.set('authScope',scope);await next();});
  app.route('/api/v2',createMissionsV2Api({} as MissionStore,enabled ? calls as unknown as ExecutionControl : undefined));
  return {app,calls};
}
const post=(data:unknown={})=>({method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'test-command'},body:JSON.stringify(data)});
describe('execution operator boundary',()=>{
  it('defaults OFF and never accesses the pool on configuration',()=>{
    expect(executionEnabled({})).toBe(false);
    expect(executionEnabled({AGENTIMPACT_V2_EXECUTION_ENABLED:'1'})).toBe(false);
    expect(configuredExecution({} as Pool,{})).toBeUndefined();
  });
  it('persists CANCEL with identity from auth scope',async()=>{
    const {app,calls}=setup();
    const r=await app.request(`/api/v2/missions/${id}/cancel`,post({principal:'admin'}));
    expect(r.status).toBe(200);
    expect(calls.cancel).toHaveBeenCalledWith(id,{principal:'api:hermes',key:'test-command'});
  });
  it('RETRY cannot inject a new fake budget or worker',async()=>{
    const {app,calls}=setup();
    expect((await app.request(`/api/v2/missions/${id}/retry`,post({max_amount:999999,worker:'real'}))).status).toBe(200);
    expect(calls.retry).toHaveBeenCalledWith(id,{principal:'api:hermes',key:'test-command'});
  });
  it('refuses commands while F is disabled',async()=>{
    const {app,calls}=setup('hermes',false);
    expect((await app.request(`/api/v2/missions/${id}/retry`,post())).status).toBe(503);
    expect(calls.retry).not.toHaveBeenCalled();
  });
  it('reserves approval binding and review for authenticated admin',async()=>{
    const {app,calls}=setup();
    expect((await app.request(`/api/v2/missions/${id}/review`,post({state:'completed'}))).status).toBe(403);
    expect((await app.request(`/api/v2/missions/${id}/approvals/bind`,post())).status).toBe(403);
    expect(calls.review).not.toHaveBeenCalled();expect(calls.bindApproval).not.toHaveBeenCalled();
    const admin=setup('admin');
    expect((await admin.app.request(`/api/v2/missions/${id}/review`,post({state:'completed'}))).status).toBe(200);
    expect(admin.calls.review).toHaveBeenCalledWith(id,'completed',{principal:'api:admin',key:'test-command'});
  });
  it('returns deterministic extended status and unlabeled metrics',async()=>{
    const {app,calls}=setup();
    expect((await app.request(`/api/v2/missions/${id}`)).status).toBe(200);
    expect((await app.request('/api/v2/status?project=IMANE')).status).toBe(200);
    expect((await (await app.request('/api/v2/metrics')).json())).toEqual({attempts_running:0});
    expect(calls.status).toHaveBeenCalledWith(id);
  });
  it('grants no worker callbacks or new bridge rights',()=>{
    for(const scope of ['bridge','hermes','admin'] as const) {
      expect(isRouteAllowed(scope,'POST',`/api/v2/attempts/${attemptId}/complete`)).toBe(false);
      expect(isRouteAllowed(scope,'POST','/api/v2/worker/claim')).toBe(false);
    }
    expect(isRouteAllowed('bridge','POST',`/api/v2/missions/${id}/retry`)).toBe(false);
    expect(isRouteAllowed('hermes','POST',`/api/v2/missions/${id}/review`)).toBe(false);
    expect(isRouteAllowed('admin','POST',`/api/v2/missions/${id}/review`)).toBe(true);
  });
});
