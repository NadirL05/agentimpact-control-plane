import {readFile,readdir} from 'node:fs/promises';
import {Pool} from 'pg';
import {z} from 'zod';
import {pathToFileURL} from 'node:url';
import {CodexControlDispatcher} from '../core/missions-v2/codex-controller.js';
import {CodexStateStore} from '../core/missions-v2/codex-store.js';
import {LocalWorkerServer,WorkerTransportAuthenticator,type SignedWorkerRequest} from '../core/missions-v2/codex-transport.js';
import {codexWorkSchema,codexWorkerConfig,type CodexWork} from '../core/missions-v2/codex-worker.js';
import {CodexResultValidator} from '../core/missions-v2/codex-workspace.js';
import {ExecutionControl} from '../core/missions-v2/execution.js';
import {digest,MissionError,projects} from '../core/missions-v2/model.js';

const attemptId=z.string().uuid();
const safeId=z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
const registrySchema=z.object({repositories:z.array(z.object({repoId:safeId,mirrorPath:z.string().startsWith('/'),
  allowedPaths:z.array(z.string().regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_.\/-]{1,300}$/)).min(1).max(100),
  maxDiffBytes:z.number().int().positive().max(10*1024*1024).default(1024*1024),
  requiredTests:z.array(z.object({name:safeId,file:z.string().startsWith('/'),args:z.array(z.string().max(500)).max(50)}).strict()).max(30).default([]),
}).strict()).min(1).max(20)}).strict();

export class CodexControlDaemon {
  private stopping=false;
  constructor(private server:LocalWorkerServer,private listenFd:number|undefined,private log:(code:string)=>void=code=>process.stdout.write(`${code}\n`)){}
  async start(){await this.server.listen(this.listenFd);this.log('codex_control_ready');}
  async stop(){if(this.stopping)return;this.stopping=true;await this.server.close();this.log('codex_control_stopped');}
  installSignalHandlers(){for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>void this.stop().catch(()=>{process.exitCode=1;}));}
}

function socketActivationFd(env=process.env){
  if(env.LISTEN_PID!==String(process.pid)||env.LISTEN_FDS!=='1')throw new MissionError('codex_control_socket_activation_required',503);
  return 3;
}

async function production(){
  if(process.getuid?.()===0)throw new MissionError('codex_control_root_forbidden',503);
  const runtimeRoot='/run/agentimpact-codex-worker',socketPath=`${runtimeRoot}/control.sock`;
  const credentials=process.env.CREDENTIALS_DIRECTORY;
  if(!credentials?.startsWith('/run/credentials/'))throw new MissionError('codex_control_credentials_missing',503);
  const databaseUrl=(await readFile(`${credentials}/database-url`,'utf8')).trim();
  if(!databaseUrl)throw new MissionError('codex_control_database_credential_invalid',503);
  const authenticators=new Map<string,WorkerTransportAuthenticator>();
  for(const entry of await readdir(credentials,{withFileTypes:true})){
    const match=/^attempt-hmac_([0-9a-f-]{36})$/.exec(entry.name);
    if(!match||!entry.isFile()||!attemptId.safeParse(match[1]).success)continue;
    authenticators.set(match[1],new WorkerTransportAuthenticator(await readFile(`${credentials}/${entry.name}`)));
  }
  const auth=(id:string)=>{const value=authenticators.get(id);if(!value)throw new MissionError('worker_transport_credential_missing',503);return value;};
  const registry=registrySchema.parse(JSON.parse(await readFile('/etc/agentimpact/codex-repositories.json','utf8')));
  const policy=new Map(registry.repositories.map(repo=>[repo.repoId,repo]));
  const assignments=new Map<string,CodexWork>();
  const assignment=async(id:string)=>{
    const cached=assignments.get(id);if(cached)return cached;
    if(!attemptId.safeParse(id).success)throw new MissionError('invalid_attempt_id',400);
    const envelope=JSON.parse(await readFile(`${runtimeRoot}/${id}/assignment.json`,'utf8')) as SignedWorkerRequest;
    if(envelope.message.operation!=='assignment'||envelope.message.attempt_id!==id||envelope.message.payload_hash!==digest(envelope.payload))
      throw new MissionError('codex_attempt_binding_invalid',409);
    auth(id).verify(envelope.message,envelope.signature);
    const work=codexWorkSchema.parse(envelope.payload);if(!policy.has(work.repo_id))throw new MissionError('repo_not_allowed',403);
    assignments.set(id,work);return work;
  };
  const config=codexWorkerConfig(),repoIds=new Set(registry.repositories.map(repo=>repo.repoId));
  const workerIds=new Set((process.env.AGENTIMPACT_CODEX_WORKER_IDS??'codex-worker-1').split(',').filter(id=>/^codex-[A-Za-z0-9_.:-]{1,120}$/.test(id)));
  const pool=new Pool({connectionString:databaseUrl,max:4,application_name:'agentimpact-codex-control'});
  const control=new ExecutionControl(pool,{enabled:config.enabled,projects:projects(),workerIds,workerTypes:new Set(['codex']),
    workspaceRoots:{codex:config.workspaceRoot},repoIds,leaseSeconds:90,deadlineSeconds:600,quotaAmount:10000});
  const dispatcher=new CodexControlDispatcher(control,new CodexStateStore(pool),assignment,new CodexResultValidator(),work=>{
    const entry=policy.get(work.repo_id);if(!entry)throw new MissionError('repo_not_allowed',403);
    return{maxDiffBytes:entry.maxDiffBytes,requiredTests:entry.requiredTests};
  },config);
  const server=new LocalWorkerServer(socketPath,auth,request=>dispatcher.dispatch(request));
  const daemon=new CodexControlDaemon(server,socketActivationFd());daemon.installSignalHandlers();
  await daemon.start();
  process.once('beforeExit',()=>void pool.end());
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  void production().catch(error=>{
    process.stderr.write(`${error instanceof MissionError?error.code:'codex_control_failed'}\n`);
    process.exitCode=1;
  });
}
