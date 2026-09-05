import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ExecutionControl, type Attempt, type WorkerProof } from './execution.js';
import { MissionError } from './model.js';
import type { Mutation } from './store.js';

export const CODEX_ADAPTER_VERSION = '1.0.0';
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const safeId = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
const relativePath = z.string().regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_.\/-]{1,300}$/);
export const codexWorkSchema = z.object({
  contract_version:z.literal(1),mission_id:z.string().uuid(),attempt_id:z.string().uuid(),
  worker_instance_id:z.string().regex(/^codex-[A-Za-z0-9_.:-]{1,120}$/),
  fencing_token:z.string().regex(/^[1-9][0-9]{0,18}$/),correlation_id:safeId,
  objective:z.string().min(3).max(8000),acceptance_criteria:z.array(z.string().min(1).max(1000)).min(1).max(30),
  allowed_paths:z.array(relativePath).min(1).max(100),repo_id:safeId,base_sha:sha,
  branch:z.string().regex(/^(?!main$|master$)[A-Za-z0-9][A-Za-z0-9_.\/-]{0,199}$/),
  workspace_id:z.string().uuid(),workspace_path:z.string().min(1).max(400),
  budget_reservation_id:z.string().uuid(),deadline_at:z.string().datetime(),lease_expires_at:z.string().datetime(),
  max_attempts:z.number().int().min(1).max(3),quota_state:z.enum(['UNKNOWN','ADMISSIBLE','EXHAUSTED']),
}).strict();
export type CodexWork = z.infer<typeof codexWorkSchema>;
export const codexOutputSchema = z.object({
  outcome:z.enum(['completed','failed']),error_code:z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).nullable(),
  retryable:z.boolean(),summary:z.string().max(1000),provider_session_id:safeId.nullable(),base_sha:sha,
  changed_paths:z.array(relativePath).max(500),test_results:z.array(z.object({name:safeId,exit_code:z.number().int(),duration_ms:z.number().int().nonnegative()}).strict()).max(100),
  artifacts:z.array(z.object({kind:z.enum(['diff','test_report']),relative_path:relativePath,sha256:z.string().regex(/^[0-9a-f]{64}$/),size_bytes:z.number().int().nonnegative().max(10485760)}).strict()).max(100),
  usage_observed:z.object({input_tokens:z.number().int().nonnegative().nullable(),output_tokens:z.number().int().nonnegative().nullable()}).strict(),
}).strict();
export type CodexOutput = z.infer<typeof codexOutputSchema>;

export type CodexWorkerConfig = {enabled:boolean;publisherEnabled:boolean;binary:string;profile:string;
  authMode:'chatgpt'|'api_key'|'access_token'|'unknown';billingMode:'chatgpt_plan'|'api_billing'|'unknown';
  codexHome:string;workerHome:string;workspaceRoot:string;outputSchemaPath:string;runtimeRoot:string;quotaState:'UNKNOWN'|'ADMISSIBLE'|'EXHAUSTED';
  blockedReason:'feature_disabled'|'codex_auth_not_configured'|'codex_billing_unknown'|'codex_quota_not_admissible'|null};
export function codexWorkerConfig(env = process.env): CodexWorkerConfig {
  const auth = z.enum(['chatgpt','api_key','access_token']).safeParse(env.AGENTIMPACT_CODEX_AUTH_MODE);
  const billing = z.enum(['chatgpt_plan','api_billing']).safeParse(env.AGENTIMPACT_CODEX_BILLING_MODE);
  const quota = z.enum(['UNKNOWN','ADMISSIBLE','EXHAUSTED']).safeParse(env.AGENTIMPACT_CODEX_QUOTA_STATE);
  const baseEnabled = env.AGENTIMPACT_V2_ENABLED === '1' && env.AGENTIMPACT_V2_EXECUTION_ENABLED === '1';
  const requested=baseEnabled&&env.AGENTIMPACT_V2_CODEX_WORKER_ENABLED==='1';
  const blockedReason=!requested?'feature_disabled':!auth.success?'codex_auth_not_configured':!billing.success?'codex_billing_unknown':
    !quota.success||quota.data!=='ADMISSIBLE'?'codex_quota_not_admissible':null;
  return {enabled:blockedReason===null,
    publisherEnabled:false,
    binary:env.AGENTIMPACT_CODEX_BINARY ?? '/opt/agentimpact/codex/bin/codex',profile:'agentimpact-worker',
    authMode:auth.success?auth.data:'unknown',billingMode:billing.success?billing.data:'unknown',
    codexHome:env.CODEX_HOME ?? '/var/lib/agentimpact-codex-worker/codex-home',workerHome:'/var/lib/agentimpact-codex-worker/home',
    workspaceRoot:'/var/lib/agentimpact-codex-worker/workspaces',
    outputSchemaPath:'/opt/agentimpact/app/codex-worker-output.schema.json',runtimeRoot:'/run/agentimpact-codex-worker',
    quotaState:quota.success?quota.data:'UNKNOWN',blockedReason};
}

export type CodexInvocation = {file:string;args:string[];cwd:string;stdin:string;env:Record<string,string>;resultFile:string};
export function codexInvocation(work: CodexWork,config: CodexWorkerConfig): CodexInvocation {
  const parsed=codexWorkSchema.safeParse(work);
  if(!parsed.success) throw new MissionError('codex_contract_invalid',400);
  const resultFile=`${config.runtimeRoot}/${work.attempt_id}/result.json`;
  const spec={contract_version:1,mission_id:work.mission_id,attempt_id:work.attempt_id,objective:work.objective,
    acceptance_criteria:work.acceptance_criteria,allowed_paths:work.allowed_paths,base_sha:work.base_sha};
  return {file:config.binary,cwd:work.workspace_path,resultFile,
    args:['--ask-for-approval','never','--sandbox','workspace-write','exec','--profile',config.profile,'--strict-config','--ephemeral','--ignore-user-config','--ignore-rules',
      '--output-schema',config.outputSchemaPath,'--output-last-message',resultFile,'--json','--cd',work.workspace_path,'-'],
    stdin:JSON.stringify(spec),env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:config.workerHome,CODEX_HOME:config.codexHome}};
}

export type RuntimeInspection={state:'running'|'stopped'|'unknown';pid:number|null};
export interface CodexRuntime { launch(invocation:CodexInvocation):Promise<{id:string;pid:number|null}>; inspect(id:string):Promise<RuntimeInspection>;
  cancel(id:string,graceMs:number):Promise<'stopped'|'unknown'>; collect(id:string,resultFile:string):Promise<{exitCode:number;output:unknown}>; }
export interface CodexStateRecorder {register(work:CodexWork,config:CodexWorkerConfig):Promise<void>;process(attemptId:string,pid:number|null):Promise<void>;
  metric(name:string,delta?:number):Promise<void>;}
type Session={child:ChildProcessWithoutNullStreams;done:Promise<number>};
export class NodeCodexRuntime implements CodexRuntime {
  private sessions=new Map<string,Session>();
  async launch(invocation:CodexInvocation) {
    const child=spawn(invocation.file,invocation.args,{cwd:invocation.cwd,env:invocation.env,stdio:['pipe','pipe','pipe'],shell:false,detached:false});
    let outputBytes=0; child.stdout.on('data',(chunk:Buffer)=>{outputBytes+=chunk.length;if(outputBytes>1048576)child.kill('SIGTERM');});
    child.stderr.on('data',()=>undefined); // Never persist raw provider output or credentials.
    child.stdin.end(invocation.stdin);
    const done=new Promise<number>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code??1));});
    const id=randomUUID();this.sessions.set(id,{child,done});return{id,pid:child.pid??null};
  }
  async inspect(id:string):Promise<RuntimeInspection>{const s=this.sessions.get(id);return !s?{state:'unknown',pid:null}:
    {state:s.child.exitCode===null&&s.child.signalCode===null?'running':'stopped',pid:s.child.pid??null};}
  async cancel(id:string,graceMs:number){const s=this.sessions.get(id);if(!s)return'unknown';
    if(s.child.exitCode!==null||s.child.signalCode!==null)return'stopped';
    s.child.kill('SIGTERM');const stopped=await Promise.race([s.done.then(()=>true),new Promise<boolean>(r=>setTimeout(()=>r(false),graceMs))]);
    if(!stopped){s.child.kill('SIGKILL');await Promise.race([s.done,new Promise<number>(r=>setTimeout(()=>r(1),2000))]);}
    return (await this.inspect(id)).state==='stopped'?'stopped':'unknown';}
  async collect(id:string,resultFile:string){const s=this.sessions.get(id);if(!s)throw new MissionError('codex_runtime_unknown');
    const exitCode=await s.done;let output:unknown=null;try{output=JSON.parse(await readFile(resultFile,'utf8'));}catch{output=null;}
    return{exitCode,output};}
}

export class CodexWorkerAdapter {
  constructor(private control:ExecutionControl,private runtime:CodexRuntime,private state:CodexStateRecorder,readonly config:CodexWorkerConfig){}
  validate(input:CodexWork):CodexWork{const parsed=codexWorkSchema.safeParse(input);if(!parsed.success)throw new MissionError('codex_contract_invalid',400);
    if(!this.config.enabled)throw new MissionError(this.config.blockedReason??'codex_worker_disabled',503);
    if(this.config.quotaState!=='ADMISSIBLE')throw new MissionError('codex_quota_not_admissible',503);
    if(new Date(input.deadline_at)<=new Date()||new Date(input.lease_expires_at)<=new Date())throw new MissionError('codex_contract_expired');return parsed.data;}
  proof(input:CodexWork):WorkerProof{return{attempt_id:input.attempt_id,worker_instance_id:input.worker_instance_id,fencing_token:input.fencing_token};}
  async claim(input:CodexWork,meta:Mutation):Promise<Attempt>{this.validate(input);await this.state.register(input,this.config);
    const claimed=await this.control.claim(input.attempt_id,input.worker_instance_id,this.proof(input),meta);await this.state.metric('codex_attempts_total');return claimed;}
  prepare(input:CodexWork):CodexInvocation{this.validate(input);return codexInvocation(input,this.config);}
  async start(input:CodexWork,meta:Mutation){const invocation=this.prepare(input);await this.control.start(this.proof(input),input.worker_instance_id,meta);
    const launched=await this.runtime.launch(invocation);await this.state.process(input.attempt_id,launched.pid);return launched;}
  heartbeat(input:CodexWork,meta:Mutation){return this.control.heartbeat(this.proof(input),input.worker_instance_id,meta);}
  progress(input:CodexWork,phase:'preparing'|'executing'|'validating',meta:Mutation){return this.control.progress(this.proof(input),input.worker_instance_id,{phase},meta);}
  inspect(runtimeId:string){return this.runtime.inspect(runtimeId);}
  async cancel(input:CodexWork,runtimeId:string,meta:Mutation){await this.control.cancel(input.mission_id,meta);const stopped=await this.runtime.cancel(runtimeId,10000);
    await this.control.reconcile(input.attempt_id,{kind:stopped,worker_instance_id:input.worker_instance_id,fencing_token:input.fencing_token},
      {...meta,key:`${meta.key}:reconcile`});await this.state.metric('codex_cancellations_total');return stopped;}
  async collect(input:CodexWork,runtimeId:string,meta:Mutation){const invocation=codexInvocation(input,this.config),raw=await this.runtime.collect(runtimeId,invocation.resultFile);
    const parsed=codexOutputSchema.safeParse(raw.output);if(!parsed.success){await this.state.metric('codex_output_invalid_total');throw new MissionError('codex_output_invalid');}
    void meta;return{exit_code:raw.exitCode,output:parsed.data};}
  /** Produces the authenticated callback envelope. Only CodexControlDispatcher
   * may validate it and mutate PostgreSQL. */
  complete(input:CodexWork,runtimeId:string,meta:Mutation){return this.collect(input,runtimeId,meta);}
  resultHash(output:CodexOutput){return createHash('sha256').update(JSON.stringify(output)).digest('hex');}
}
