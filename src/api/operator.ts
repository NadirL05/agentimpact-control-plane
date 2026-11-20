import { createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { AppEnv } from '../core/hono-env.js';
import { MissionError } from '../core/missions-v2/model.js';
import { operatorRequestSchema } from '../core/operator/contract.js';
import type { OperatorService } from '../core/operator/service.js';

const WINDOW_MS = 2 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 60;
const MAX_BODY_BYTES = 64 * 1024;
const rateBuckets = new Map<string,{window:number;count:number}>();

async function readBoundedBody(request: Request): Promise<string | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isInteger(length) || length < 0 || length > MAX_BODY_BYTES) return null;
  }
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

function signatureValid(secret:string, timestamp:string, nonce:string, raw:string, supplied:string):boolean {
  if (!/^v1=[0-9a-f]{64}$/.test(supplied)) return false;
  const expected=`v1=${createHmac('sha256',secret).update(`${timestamp}\n${nonce}\n${raw}`).digest('hex')}`;
  const a=Buffer.from(supplied),b=Buffer.from(expected);
  return a.length===b.length&&timingSafeEqual(a,b);
}

export function createOperatorV2Api(service?:OperatorService) {
  const app=new Hono<AppEnv>();
  const organizationId=(process.env.AGENTIMPACT_ORGANIZATION_ID||'org-agentimpact').trim();
  app.onError((error,c)=>error instanceof MissionError
    ? c.json({error:error.code},error.status)
    : c.json({error:'operator_request_failed'},503));

  app.post('/actions',async c=>{
    const scope=c.get('authScope');
    if(!['operator','admin'].includes(scope)) return c.json({error:'forbidden'},403);
    if(!service) return c.json({error:'operator_disabled'},503);

    const now=Date.now();
    const bucket=rateBuckets.get(scope)??{window:now,count:0};
    if(now-bucket.window>=RATE_WINDOW_MS){bucket.window=now;bucket.count=0;}
    bucket.count+=1;
    rateBuckets.set(scope,bucket);
    if(bucket.count>RATE_LIMIT){c.header('Retry-After','60');return c.json({error:'operator_rate_limited'},429);}

    const raw=await readBoundedBody(c.req.raw);
    if(raw===null) return c.json({error:'operator_request_too_large'},413);
    const parsed=operatorRequestSchema.safeParse((()=>{try{return JSON.parse(raw);}catch{return null;}})());
    if(!parsed.success) return c.json({error:'invalid_operator_request'},400);
    const request=parsed.data;
    if(request.organization_id!==organizationId) return c.json({error:'organization_forbidden'},403);
    // Admin is the independent human-decision identity. It may approve or
    // reject an exact action, but cannot originate work on this surface and
    // then approve work created by the same credential.
    if(scope==='admin'&&request.operation!=='agentimpact.approvals.approve') {
      return c.json({error:'admin_operator_action_forbidden'},403);
    }
    if(scope==='operator'&&request.operation==='agentimpact.approvals.approve') {
      return c.json({error:'human_confirmation_channel_required'},403);
    }

    if(scope==='operator'){
      const secret=process.env.CTL_OPERATOR_TOKEN||'';
      const nonce=c.req.header('X-AgentImpact-Nonce')||'';
      const timestamp=c.req.header('X-AgentImpact-Timestamp')||'';
      const signature=c.req.header('X-AgentImpact-Signature')||'';
      const requestedAt=Date.parse(request.requested_at);
      if(secret.length<32||nonce!==request.request_id||timestamp!==request.requested_at
        ||!Number.isFinite(requestedAt)||Math.abs(now-requestedAt)>WINDOW_MS
        ||!signatureValid(secret,timestamp,nonce,raw,signature)) return c.json({error:'operator_signature_invalid'},401);
      const claimed=await service.claimRequest(request);
      if(!claimed) return c.json({error:'operator_replay_denied'},409);
    }

    const result=await service.handle(request,scope==='operator'?'nadir:openjarvis':'api:admin');
    return c.json(result,result.ok?200:result.status==='approval_required'?202:409);
  });
  return app;
}
