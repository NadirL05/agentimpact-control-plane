import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {assertCodexWorkAdmission,codexOutputSchema,codexWorkSchema,codexWorkerConfig,NodeCodexRuntime,type CodexWork} from '../core/missions-v2/codex-worker.js';
import {codexRepositoryRegistrySchema} from '../core/missions-v2/codex-policy.js';
import {allowedWorkspacePath,CodexWorkspaceManager} from '../core/missions-v2/codex-workspace.js';
import {localWorkerRequest,WorkerTransportAuthenticator,type LocalWorkerMessage,type SignedWorkerRequest} from '../core/missions-v2/codex-transport.js';
import {digest,MissionError} from '../core/missions-v2/model.js';
import {z} from 'zod';
const safeError=(error:unknown)=>error instanceof MissionError?error.code:'codex_worker_failed';

async function main(){
  const attemptId=process.argv[2];if(!z.string().uuid().safeParse(attemptId).success)throw new MissionError('invalid_attempt_id',400);
  const config=codexWorkerConfig();if(!config.enabled)throw new MissionError(config.blockedReason??'codex_worker_disabled',503);
  const credentialPath=process.env.AGENTIMPACT_CODEX_CONTROL_CREDENTIAL;if(!credentialPath)throw new MissionError('worker_transport_credential_missing',503);
  const auth=new WorkerTransportAuthenticator(await readFile(credentialPath));
  const assignmentPath=`${config.runtimeRoot}/${attemptId}/assignment.json`;
  const assignment=JSON.parse(await readFile(assignmentPath,'utf8')) as SignedWorkerRequest;
  auth.verify(assignment.message,assignment.signature);
  if(assignment.message.operation!=='assignment')throw new MissionError('worker_transport_rejected',403);
  if(assignment.message.payload_hash!==digest(assignment.payload))throw new MissionError('worker_transport_rejected',403);
  const work=codexWorkSchema.parse(assignment.payload) as CodexWork;if(work.attempt_id!==attemptId)throw new MissionError('codex_attempt_binding_invalid',409);
  assertCodexWorkAdmission(work,config);
  if(work.quota_state!==config.quotaState||new Date(work.deadline_at).getTime()<=Date.now()||new Date(work.lease_expires_at).getTime()<=Date.now())
    throw new MissionError('codex_contract_expired',409);
  const registry=codexRepositoryRegistrySchema.parse(JSON.parse(await readFile('/etc/agentimpact/codex-repositories.json','utf8')));
  const manager=new CodexWorkspaceManager(config.workspaceRoot,registry.repositories);
  if(work.allowed_paths.some(path=>!allowedWorkspacePath(path,manager.allowedPaths(work.repo_id))))throw new MissionError('validation_path_forbidden',403);
  const prepared=await manager.prepare(work.repo_id,work.attempt_id,work.base_sha,work.branch);
  if(prepared.canonical_path!==work.workspace_path)throw new MissionError('codex_workspace_binding_invalid',409);
  const socket=`${config.runtimeRoot}/control.sock`;
  const send=async(operation:string,payload:unknown)=>{const message:LocalWorkerMessage={attempt_id:work.attempt_id,worker_instance_id:work.worker_instance_id,
    fencing_token:work.fencing_token,operation,timestamp:Math.floor(Date.now()/1000),nonce:randomUUID(),payload_hash:digest(payload)};
    return localWorkerRequest(socket,{message,payload,signature:auth.sign(message)});};
  await send('claim',{contract:work});await send('start',{});
  const runtime=new NodeCodexRuntime(),session=await runtime.launch((await import('../core/missions-v2/codex-worker.js')).codexInvocation(work,config));
  let heartbeatError:unknown=null,cancelling=false;const heartbeat=setInterval(()=>void send('heartbeat',{}).then(async response=>{
    if((response as {cancel_requested?:boolean})?.cancel_requested&&!cancelling){cancelling=true;const stopped=await runtime.cancel(session.id,10000);
      await send('cancel',{kind:stopped});heartbeatError=new MissionError(stopped==='stopped'?'codex_cancelled':'worker_stop_unconfirmed');}
  }).catch(error=>{heartbeatError=error;if(!cancelling){cancelling=true;void runtime.cancel(session.id,10000).then(stopped=>send('cancel',{kind:stopped})).catch(()=>undefined);}}),15000);
  const deadline=setTimeout(()=>{if(!cancelling){cancelling=true;heartbeatError=new MissionError('deadline_exceeded');
    void runtime.cancel(session.id,10000).then(stopped=>send('cancel',{kind:stopped,reason:'deadline_exceeded'})).catch(()=>undefined);}},
    Math.min(2147483647,new Date(work.deadline_at).getTime()-Date.now()));
  try {const collected=await runtime.collect(session.id,`${config.runtimeRoot}/${attemptId}/result.json`);if(heartbeatError)throw heartbeatError;
    const output=codexOutputSchema.parse(collected.output);await send('complete',{exit_code:collected.exitCode,output});
  } finally {clearInterval(heartbeat);clearTimeout(deadline);}
}

void main().catch(error=>{process.stderr.write(`${safeError(error)}\n`);process.exitCode=1;});
