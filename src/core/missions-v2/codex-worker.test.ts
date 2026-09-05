import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {chmod,mkdir,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {CodexStateStore} from './codex-store.js';
import {CodexWorkerAdapter,NodeCodexRuntime,codexInvocation,codexOutputSchema,codexWorkerConfig,type CodexWork} from './codex-worker.js';
import {CodexResultValidator,CodexWorkspaceManager} from './codex-workspace.js';
import {CodexRecoverySupervisor} from './codex-supervisor.js';
import {DisabledCodexPublisher,FakeCodexPublisher} from './codex-publisher.js';
import {LocalWorkerServer,localWorkerRequest,WorkerTransportAuthenticator} from './codex-transport.js';
import {digest,MissionError} from './model.js';
import {approvalPayloadHash,ExecutionControl} from './execution.js';
import {codexDatabase,readyMission,testMutation} from './testing/execution-database.js';
import type {PoolClient} from 'pg';

const run=promisify(execFile);
let fixture:Awaited<ReturnType<typeof codexDatabase>>;
let temp:string;
const base='a'.repeat(40);
const enabledConfig=(overrides:Record<string,string>={})=>codexWorkerConfig({AGENTIMPACT_V2_ENABLED:'1',AGENTIMPACT_V2_EXECUTION_ENABLED:'1',
  AGENTIMPACT_V2_CODEX_WORKER_ENABLED:'1',AGENTIMPACT_CODEX_AUTH_MODE:'chatgpt',AGENTIMPACT_CODEX_BILLING_MODE:'chatgpt_plan',
  AGENTIMPACT_CODEX_QUOTA_STATE:'ADMISSIBLE',...overrides});

beforeAll(async()=>{fixture=await codexDatabase();temp=await mkdtemp(join(tmpdir(),'v2-b-'));},30000);
afterAll(async()=>{await fixture.db.close();await rm(temp,{recursive:true,force:true});});

describe('V2-B Codex worker boundary',()=>{
  it('is off by default and fails closed for unknown auth, billing, or quota',()=>{
    expect(codexWorkerConfig({})).toMatchObject({enabled:false,publisherEnabled:false,authMode:'unknown',billingMode:'unknown',quotaState:'UNKNOWN',blockedReason:'feature_disabled'});
    expect(codexWorkerConfig({AGENTIMPACT_V2_ENABLED:'1',AGENTIMPACT_V2_EXECUTION_ENABLED:'1',AGENTIMPACT_V2_CODEX_WORKER_ENABLED:'1'}))
      .toMatchObject({enabled:false,blockedReason:'codex_auth_not_configured'});
  });

  it('constructs an argv-only ephemeral invocation with bounded environment and stdin contract',()=>{
    const work=contract();const invocation=codexInvocation(work,enabledConfig());
    expect(invocation.args).toContain('--ephemeral');expect(invocation.args).toContain('--profile');expect(invocation.args).toContain('agentimpact-worker');
    expect(invocation.args).toContain('never');expect(invocation.args.at(-1)).toBe('-');
    expect(invocation.env).toEqual({PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/var/lib/agentimpact-codex-worker/home',CODEX_HOME:'/var/lib/agentimpact-codex-worker/codex-home'});
    expect(invocation.stdin).not.toContain('fencing_token');
  });

  it('runs a deterministic fake Codex binary without a shell or provider call',async()=>{
    const fake=join(temp,'fake-codex');const runtimeRoot=join(temp,'runtime'),work=contract({workspace_path:temp});
    await mkdir(join(runtimeRoot,work.attempt_id),{recursive:true});
    const fixtureOutput=JSON.stringify(JSON.stringify(output()));
    await writeFile(fake,`#!/usr/bin/python3\nimport json,sys\njson.load(sys.stdin)\np=sys.argv[sys.argv.index('--output-last-message')+1]\nopen(p,'w',encoding='utf-8').write(${fixtureOutput})\n`);
    await chmod(fake,0o700);const config={...enabledConfig(),binary:fake,runtimeRoot};const runtime=new NodeCodexRuntime();
    const invocation=codexInvocation(work,config),session=await runtime.launch(invocation),result=await runtime.collect(session.id,invocation.resultFile);
    expect(result.exitCode).toBe(0);expect(codexOutputSchema.parse(result.output)).toMatchObject({outcome:'completed'});
  });

  it('treats a signal-terminated child as stopped',async()=>{
    const runtime=new NodeCodexRuntime();
    const session=await runtime.launch({file:'/usr/bin/python3',args:['-c','import time; time.sleep(60)'],cwd:temp,stdin:'',
      env:{PATH:'/usr/bin:/bin'},resultFile:join(temp,'unused-result.json')});
    await expect(runtime.cancel(session.id,1000)).resolves.toBe('stopped');
    await expect(runtime.inspect(session.id)).resolves.toMatchObject({state:'stopped'});
  });

  it('rejects malformed output, unknown fields and raw secret-like provider ids',()=>{
    expect(codexOutputSchema.safeParse({...output(),extra:true}).success).toBe(false);
    expect(codexOutputSchema.safeParse({...output(),provider_session_id:'token with spaces'}).success).toBe(false);
  });

  it('authenticates a local message once and rejects tamper, replay and stale timestamps',()=>{
    const auth=new WorkerTransportAuthenticator(Buffer.alloc(32,7));const now=1000,payload={operation:'claim'};
    const message={attempt_id:randomUUID(),worker_instance_id:'codex-one',fencing_token:'1',operation:'claim',timestamp:now,nonce:randomUUID(),payload_hash:digest(payload)};
    const signature=auth.sign(message);expect(auth.verify(message,signature,now)).toBe(true);
    expect(()=>auth.verify(message,signature,now)).toThrow();
    expect(()=>auth.verify({...message,nonce:randomUUID(),payload_hash:'0'.repeat(64)},signature,now)).toThrow();
    const stale={...message,nonce:randomUUID(),timestamp:1};expect(()=>auth.verify(stale,auth.sign(stale),now)).toThrow();
  });

  it('round-trips one authenticated bounded frame over a private Unix socket',async()=>{
    const root=join(temp,'socket');await mkdir(root);const path=join(root,'control.sock'),key=Buffer.alloc(32,9);
    const serverAuth=new WorkerTransportAuthenticator(key),clientAuth=new WorkerTransportAuthenticator(key);
    const payload={phase:'executing'},message={attempt_id:randomUUID(),worker_instance_id:'codex-one',fencing_token:'2',operation:'progress',
      timestamp:Math.floor(Date.now()/1000),nonce:randomUUID(),payload_hash:digest(payload)};
    const server=new LocalWorkerServer(path,serverAuth,async request=>({accepted:request.message.operation}),root);await server.listen();
    try{await expect(localWorkerRequest(path,{message,payload,signature:clientAuth.sign(message)},root)).resolves.toEqual({accepted:'progress'});}
    finally{await server.close();}
  });

  it('rejects a signature made with another attempt credential',async()=>{
    const root=join(temp,`socket-${randomUUID()}`);await mkdir(root);const path=join(root,'control.sock');
    const firstId=randomUUID(),first=new WorkerTransportAuthenticator(Buffer.alloc(32,1));
    const second=new WorkerTransportAuthenticator(Buffer.alloc(32,2));
    const server=new LocalWorkerServer(path,attemptId=>attemptId===firstId?first:second,async()=>({accepted:true}),root);await server.listen();
    const payload={phase:'executing'},message={attempt_id:firstId,worker_instance_id:'codex-one',fencing_token:'2',operation:'progress',
      timestamp:Math.floor(Date.now()/1000),nonce:randomUUID(),payload_hash:digest(payload)};
    try{await expect(localWorkerRequest(path,{message,payload,signature:second.sign(message)},root)).rejects.toMatchObject({code:'worker_transport_rejected'});}
    finally{await server.close();}
  });

  it('queues a Codex attempt only in its configured root and records bounded metadata',async()=>{
    const root='/var/lib/agentimpact-codex-worker/workspaces';const mission=await readyMission(fixture.pool);
    const control=new ExecutionControl(fixture.pool,{enabled:true,projects:new Set(['IMANE']),workerIds:new Set(['codex-one']),workerTypes:new Set(['codex']),
      workspaceRoots:{codex:root},repoIds:new Set(['control-plane']),quotaAmount:100});
    const attempt=await control.queue(mission.id,testMutation(),{worker_type:'codex',worker_instance_id:'codex-one',
      workspace:{repo:'control-plane',base_sha:base,branch:`codex/${randomUUID()}`,workspace_root:root},
      budget:{max_amount:10,reserved_amount:10,currency:'FAKE'}});
    const workspace=`${root}/attempts/${attempt.id}/workspace`;
    const bindings=(await fixture.db.query<{workspace_id:string;budget_id:string}>(`SELECT w.id workspace_id,b.id budget_id FROM worktree_leases w JOIN budget_reservations b ON b.attempt_id=w.attempt_id WHERE w.attempt_id=$1`,[attempt.id])).rows[0];
    const work=contract({mission_id:mission.id,attempt_id:attempt.id,workspace_id:bindings.workspace_id,budget_reservation_id:bindings.budget_id,
      workspace_path:workspace,fencing_token:attempt.fencing_token,branch:(await fixture.db.query<{branch:string}>('SELECT branch FROM worktree_leases WHERE attempt_id=$1',[attempt.id])).rows[0].branch});
    const state=new CodexStateStore(fixture.pool);const runtime={launch:vi.fn(async()=>({id:'runtime-1',pid:4321})),inspect:vi.fn(),cancel:vi.fn(async()=> 'stopped' as const),collect:vi.fn()};
    const adapter=new CodexWorkerAdapter(control,runtime,state,enabledConfig());
    await expect(adapter.claim(work,testMutation())).rejects.toMatchObject({code:'approval_invalid'});expect(runtime.launch).not.toHaveBeenCalled();
    const payloadHash=approvalPayloadHash(attempt,'execute');
    const action=(await fixture.db.query<{id:string}>(`INSERT INTO agent_actions(intent,status,payload_hash,approval_expires_at)
      VALUES('execute','approved',$1,clock_timestamp()+interval '1 hour') RETURNING id`,[payloadHash])).rows[0];
    await fixture.db.query(`INSERT INTO agent_approvals(action_id,decision,payload_hash,approver,expires_at)
      VALUES($1,'approved',$2,'human-admin',clock_timestamp()+interval '1 hour')`,[action.id,payloadHash]);
    await control.bindApproval(mission.id,attempt.id,{action_id:action.id,action_type:'execute',payload_hash:payloadHash},testMutation());
    await adapter.claim(work,testMutation());await adapter.start(work,testMutation());
    expect((await fixture.db.query('SELECT auth_mode,quota_state,canonical_path,process_id FROM codex_attempt_metadata WHERE attempt_id=$1',[attempt.id])).rows)
      .toEqual([{auth_mode:'chatgpt',quota_state:'ADMISSIBLE',canonical_path:workspace,process_id:4321}]);
    const status=await control.status(mission.id);expect(status.codex).toMatchObject({adapter_version:'1.0.0',quota_state:'ADMISSIBLE'});
    await expect(state.register({...work,objective:'Changed after binding'},enabledConfig())).rejects.toMatchObject({code:'codex_attempt_binding_invalid'});
    await expect(adapter.cancel(work,'runtime-1',testMutation())).resolves.toBe('stopped');
    expect((await control.status(mission.id)).mission_state).toBe('cancelled');
  });

  it('keeps disabled, unknown quota and wrong worker callbacks outside execution',async()=>{
    const state={register:vi.fn(),process:vi.fn(),result:vi.fn(),artifacts:vi.fn(),metric:vi.fn()};
    const adapter=new CodexWorkerAdapter({} as ExecutionControl,{} as NodeCodexRuntime,state,codexWorkerConfig({}));
    expect(()=>adapter.validate(contract())).toThrowError(expect.objectContaining({code:'feature_disabled'}));
    const unknown=new CodexWorkerAdapter({} as ExecutionControl,{} as NodeCodexRuntime,state,enabledConfig({AGENTIMPACT_CODEX_QUOTA_STATE:'UNKNOWN'}));
    expect(()=>unknown.validate(contract())).toThrowError(expect.objectContaining({code:'codex_quota_not_admissible'}));
  });

  it('deduplicates repeated artifacts inside accepted completion persistence',async()=>{
    const artifact={kind:'diff' as const,relative_path:'artifacts/change.diff',sha256:'b'.repeat(64),size_bytes:12};
    const workerOutput=codexOutputSchema.parse(output());
    const query=vi.fn(async(_sql:unknown,_params?:unknown[])=>({rowCount:1,rows:[]}));
    const state=new CodexStateStore({} as never);
    await state.persistAcceptedCompletion({query} as unknown as Pick<PoolClient,'query'>,randomUUID(),workerOutput,digest(workerOutput),
      [artifact,artifact],'passed');
    expect(query.mock.calls.filter(([sql])=>String(sql).includes('INSERT INTO codex_artifacts'))).toHaveLength(1);
  });

  it('uses a trusted repository registry and rejects branch, SHA and attempt tricks before git',async()=>{
    const root=join(temp,'manager');await mkdir(root,{recursive:true});const git=vi.fn(async()=>({exitCode:0,stdout:''}));
    const manager=new CodexWorkspaceManager(root,[{repoId:'control-plane',mirrorPath:'/srv/git/control-plane.git',allowedPaths:['src']}],git);
    expect(()=>manager.candidate('../escape')).toThrow();
    await expect(manager.prepare('unknown',randomUUID(),base,'codex/test')).rejects.toMatchObject({code:'repo_not_allowed'});
    await expect(manager.prepare('control-plane',randomUUID(),'bad','main')).rejects.toMatchObject({code:'workspace_contract_invalid'});
    expect(git).not.toHaveBeenCalled();
  });

  it('independently validates the real diff, allowed paths, tests and secret scan',async()=>{
    const repo=join(temp,'validator');await mkdir(repo);await run('/usr/bin/git',['init',repo]);
    await run('/usr/bin/git',['-C',repo,'config','user.email','test@example.invalid']);await run('/usr/bin/git',['-C',repo,'config','user.name','Test']);
    await mkdir(join(repo,'src'));await writeFile(join(repo,'src','item.ts'),'before\n');await run('/usr/bin/git',['-C',repo,'add','.']);await run('/usr/bin/git',['-C',repo,'commit','-m','base']);
    const {stdout}=await run('/usr/bin/git',['-C',repo,'rev-parse','HEAD']);await writeFile(join(repo,'src','item.ts'),'after\n');
    const validator=new CodexResultValidator();const input={workspaceRoot:temp,workspacePath:repo,baseSha:stdout.trim(),allowedPaths:['src'],reportedPaths:['src/item.ts'],testResults:[{name:'unit',exit_code:0}],maxDiffBytes:10000};
    await expect(validator.validate(input)).resolves.toMatchObject({state:'passed',changed_paths:['src/item.ts']});
    await expect(validator.validate({...input,allowedPaths:['docs']})).rejects.toMatchObject({code:'validation_path_forbidden'});
    await writeFile(join(repo,'src','item.ts'),'github_pat_'+'x'.repeat(45));
    await expect(validator.validate(input)).rejects.toMatchObject({code:'validation_secret_detected'});
    await writeFile(join(repo,'src','item.ts'),'after\n');await symlink('/etc/passwd',join(repo,'src','escape'));
    await expect(validator.validate({...input,reportedPaths:['src/escape','src/item.ts']})).rejects.toMatchObject({code:'validation_symlink_escape'});
  });

  it('fails closed when any Git validation output exceeds its capture limit',async()=>{
    const repo=join(temp,`overflow-${randomUUID()}`);await mkdir(repo);
    const git=vi.fn(async(args:string[])=>args.includes('--binary')
      ? {exitCode:0,stdout:'truncated',overflowed:true}
      : {exitCode:0,stdout:''});
    const validator=new CodexResultValidator(git);
    await expect(validator.validate({workspaceRoot:temp,workspacePath:repo,baseSha:base,allowedPaths:['src'],reportedPaths:['src/item.ts'],
      testResults:[],maxDiffBytes:2*1024*1024})).rejects.toMatchObject({code:'validation_git_failed'});
  });

  it('keeps publication behind a disabled credential-free boundary with deterministic fake idempotency',async()=>{
    await expect(new DisabledCodexPublisher().publish({repoId:'r',baseSha:base,branch:'b',patch:'diff',force:false,title:'t'})).rejects.toMatchObject({code:'publisher_credential_not_configured'});
    const fake=new FakeCodexPublisher(new Set(['r']));const request={repoId:'r',baseSha:base,branch:'codex/change',patch:'diff',force:false,title:'title'};
    const first=await fake.publish(request),replay=await fake.publish(request);expect(replay).toMatchObject({branch:first.branch,commitSha:first.commitSha,prUrl:first.prUrl,replayed:true});
    await expect(fake.publish({...request,branch:'main'})).rejects.toBeInstanceOf(MissionError);
    await expect(fake.publish({...request,force:true})).rejects.toMatchObject({code:'publisher_force_push_forbidden'});
  });

  it('keeps migration 006 one-shot and rolls a second passage back without touching V1',async()=>{
    const v1=await fixture.db.query<{id:string}>("INSERT INTO agent_actions(intent,status) VALUES('fixture','pending') RETURNING id");
    const sql=await readFile(new URL('../../migrations/006_v2_codex_worker.sql',import.meta.url),'utf8');
    await expect(fixture.db.exec(sql)).rejects.toBeTruthy();
    await fixture.db.exec('ROLLBACK');
    expect((await fixture.db.query('SELECT status FROM agent_actions WHERE id=$1',[v1.rows[0].id])).rows).toEqual([{status:'pending'}]);
    expect((await fixture.db.query<{name:string}>("SELECT to_regclass('public.codex_attempt_metadata') AS name")).rows[0].name).toBe('codex_attempt_metadata');
  });

  it('keeps an unknown process UNKNOWN during supervisor recovery',async()=>{
    const attempt={id:randomUUID(),worker_type:'codex',worker_instance_id:'codex-one',fencing_token:'9',started_at:new Date(),heartbeat_at:new Date()};
    const control={scanExpired:vi.fn(async()=>1),pendingReconciliation:vi.fn(async()=>[attempt]),reconcile:vi.fn(async()=>attempt)};
    const supervisor=new CodexRecoverySupervisor(control as unknown as ExecutionControl,{inspect:vi.fn(async()=> 'unknown' as const)});
    await expect(supervisor.tick()).resolves.toEqual({expired:1,stopped:0,unknown:1,running:0});
    expect(control.reconcile).toHaveBeenCalledWith(attempt.id,expect.objectContaining({kind:'unknown',fencing_token:'9'}),expect.anything());
  });
});

function contract(overrides:Partial<CodexWork>={}):CodexWork{return {contract_version:1,mission_id:randomUUID(),attempt_id:randomUUID(),worker_instance_id:'codex-one',
  fencing_token:'1',correlation_id:randomUUID(),objective:'Change the requested fixture',acceptance_criteria:['Tests pass'],allowed_paths:['src'],repo_id:'control-plane',
  base_sha:base,branch:`codex/${randomUUID()}`,workspace_id:randomUUID(),workspace_path:'/var/lib/agentimpact-codex-worker/workspaces/attempt',budget_reservation_id:randomUUID(),
  deadline_at:new Date(Date.now()+60000).toISOString(),lease_expires_at:new Date(Date.now()+60000).toISOString(),max_attempts:3,quota_state:'ADMISSIBLE',...overrides};}
function output(){return {outcome:'completed',error_code:null,retryable:false,summary:'done',provider_session_id:null,base_sha:base,changed_paths:['src/item.ts'],
  test_results:[{name:'unit',exit_code:0,duration_ms:1}],artifacts:[],usage_observed:{input_tokens:null,output_tokens:null}};}
