import { createHmac, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../core/hono-env.js';
import type { OperatorService } from '../core/operator/service.js';
import { createOperatorV2Api } from './operator.js';

function signed(raw:string,token:string,requestId:string,at:string){
  return `v1=${createHmac('sha256',token).update(`${at}\n${requestId}\n${raw}`).digest('hex')}`;
}

describe('OpenJarvis operator API boundary',()=>{
  it('requires operator HMAC, organization, timestamp and one-shot nonce',async()=>{
    const token='operator-test-token-with-more-than-32-characters';
    process.env.CTL_OPERATOR_TOKEN=token;
    process.env.AGENTIMPACT_ORGANIZATION_ID='org-agentimpact';
    const handle=vi.fn(async(request: {request_id:string;operation:string})=>({
      request_id:request.request_id,operation:request.operation,ok:true,status:'completed',
      data:{safe:true},explanation:'ok',
    }));
    const app=new Hono<AppEnv>();
    app.use('*',async(c,next)=>{c.set('authScope','operator');await next();});
    const claimRequest=vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    app.route('/api/v2/operator',createOperatorV2Api({handle,claimRequest} as unknown as OperatorService));
    const request_id=randomUUID(),requested_at=new Date().toISOString();
    const raw=JSON.stringify({request_id,organization_id:'org-agentimpact',requested_at,
      operation:'agentimpact.health',parameters:{}});
    const headers={'content-type':'application/json','x-agentimpact-nonce':request_id,
      'x-agentimpact-timestamp':requested_at,'x-agentimpact-signature':signed(raw,token,request_id,requested_at)};
    const first=await app.request('/api/v2/operator/actions',{method:'POST',headers,body:raw});
    expect(first.status).toBe(200);
    expect(handle).toHaveBeenCalledOnce();
    const replay=await app.request('/api/v2/operator/actions',{method:'POST',headers,body:raw});
    expect(replay.status).toBe(409);
  });

  it('rejects unknown fields before the service',async()=>{
    const token='operator-test-token-with-more-than-32-characters';
    process.env.CTL_OPERATOR_TOKEN=token;
    const handle=vi.fn();
    const app=new Hono<AppEnv>();
    app.use('*',async(c,next)=>{c.set('authScope','operator');await next();});
    app.route('/api/v2/operator',createOperatorV2Api({handle,claimRequest:vi.fn().mockResolvedValue(true)} as unknown as OperatorService));
    const request_id=randomUUID(),requested_at=new Date().toISOString();
    const raw=JSON.stringify({request_id,organization_id:'org-agentimpact',requested_at,
      operation:'agentimpact.health',parameters:{shell:'id'}});
    const response=await app.request('/api/v2/operator/actions',{method:'POST',headers:{
      'content-type':'application/json','x-agentimpact-nonce':request_id,'x-agentimpact-timestamp':requested_at,
      'x-agentimpact-signature':signed(raw,token,request_id,requested_at)},body:raw});
    expect(response.status).toBe(400);
    expect(handle).not.toHaveBeenCalled();
  });

  it('rejects an oversized body before parsing or signature work',async()=>{
    const app=new Hono<AppEnv>();
    app.use('*',async(c,next)=>{c.set('authScope','operator');await next();});
    const handle=vi.fn();
    app.route('/api/v2/operator',createOperatorV2Api({handle,claimRequest:vi.fn()} as unknown as OperatorService));
    const result=await app.request('/api/v2/operator/actions',{method:'POST',headers:{'content-type':'application/json'},body:'x'.repeat(65*1024)});
    expect(result.status).toBe(413);
    expect(handle).not.toHaveBeenCalled();
  });

  it('separates operator action origination from the admin decision channel',async()=>{
    const handle=vi.fn();
    const service={handle,claimRequest:vi.fn()} as unknown as OperatorService;
    const admin=new Hono<AppEnv>();
    admin.use('*',async(c,next)=>{c.set('authScope','admin');await next();});
    admin.route('/api/v2/operator',createOperatorV2Api(service));
    const base={request_id:randomUUID(),organization_id:'org-agentimpact',requested_at:new Date().toISOString()};
    const prepare=await admin.request('/api/v2/operator/actions',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({...base,operation:'agentimpact.deploy.prepare',parameters:{release_id:'20260911T120000Z-0123456789ab',
        source_commit:'0123456789abcdef0123456789abcdef01234567',target:'production',rollback_release_id:'20260911T110000Z-abcdef012345',
        publisher_action_id:randomUUID(),repository:'NadirL05/agentimpact-control-plane',base_branch:'main'}})});
    expect(prepare.status).toBe(403);

    const operator=new Hono<AppEnv>();
    operator.use('*',async(c,next)=>{c.set('authScope','operator');await next();});
    operator.route('/api/v2/operator',createOperatorV2Api(service));
    const approve=await operator.request('/api/v2/operator/actions',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({...base,request_id:randomUUID(),operation:'agentimpact.approvals.approve',parameters:{
        action_id:randomUUID(),payload_hash:'a'.repeat(64),decision:'rejected'}})});
    expect(approve.status).toBe(403);
    expect(handle).not.toHaveBeenCalled();
  });
});
