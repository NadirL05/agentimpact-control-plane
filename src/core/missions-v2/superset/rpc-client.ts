import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import type { CliResult, CliRunner } from './cli.js';
import { SupersetParseError } from './json.js';

export type SupersetRpcContext={missionId:string;attemptId:string;fencingToken:string};
export type SupersetRpcRequest={request_id:string;operation:string;mission_id:string;attempt_id:string;fencing_token:string;parameters:Record<string,unknown>};

const id=(value:string,label:string)=>{
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new SupersetParseError(`invalid_${label}`);
  return value;
};
const value=(args:string[],flag:string)=>{
  const index=args.indexOf(flag); if(index<0||index+1>=args.length) throw new SupersetParseError('rpc_invalid_arguments'); return args[index+1];
};
const exact=(args:string[],allowed:string[])=>args.length===allowed.length&&args.every((item,index)=>item===allowed[index]);
const base=(operation:string,parameters:Record<string,unknown>,context:SupersetRpcContext):SupersetRpcRequest=>({request_id:randomUUID(),operation,
  mission_id:id(context.missionId,'mission_id'),attempt_id:id(context.attemptId,'attempt_id'),fencing_token:id(context.fencingToken,'fencing_token'),parameters});

/** Converts only the existing backend's fixed argv shapes. No caller-controlled CLI escapes this module. */
export function mapSupersetCliToRpc(args:string[],context:SupersetRpcContext):SupersetRpcRequest {
  if(args.length===4&&args[0]==='__agentimpact_rpc__'&&args[1]==='workspace.git_state'&&args[2]==='--workspace')
    return base('workspace.git_state',{workspace_id:value(args,'--workspace')},context);
  if(args.length===6&&args[0]==='__agentimpact_rpc__'&&args[1]==='workspace.diff'&&args[2]==='--workspace'&&args[4]==='--base-sha')
    return base('workspace.diff',{workspace_id:value(args,'--workspace'),base_sha:value(args,'--base-sha')},context);
  if(exact(args,['status','--json'])) return base('health',{},context);
  if(exact(args,['projects','list','--local','--json'])) return base('project.list',{},context);
  if(args[0]==='projects'&&args[1]==='create'&&args.includes('--name')&&args.includes('--local')&&args.includes('--json'))
    return base('project.create',{name:value(args,'--name')},context);
  if(args[0]==='workspaces'&&args[1]==='list'&&args.at(-1)==='--json')
    return base('workspace.list',args.includes('--project')?{project_id:value(args,'--project')}: {},context);
  if(args[0]==='workspaces'&&args[1]==='get'&&args.at(-1)==='--json') return base('workspace.inspect',{workspace_id:value(args,'--workspace')},context);
  if(args[0]==='workspaces'&&args[1]==='create'&&args.includes('--project')&&args.includes('--name')&&args.includes('--branch')&&args.includes('--source'))
    return base('workspace.create',{project_id:value(args,'--project'),name:value(args,'--name'),branch:value(args,'--branch'),source:value(args,'--source')},context);
  if(args[0]==='workspaces'&&args[1]==='delete') return base('workspace.delete',{workspace_id:value(args,'--workspace')},context);
  if(args[0]==='terminals'&&args[1]==='read') return base('terminal.read',{workspace_id:value(args,'--workspace'),terminal_id:value(args,'--terminal')},context);
  if(args[0]==='terminals'&&args[1]==='close') return base('terminal.close',{workspace_id:value(args,'--workspace'),terminal_id:value(args,'--terminal')},context);
  if(args[0]==='terminals'&&args[1]==='create') {
    if(value(args,'--command')!=='printf AGENTIMPACT_SUPERSET_RPC_SMOKE') throw new SupersetParseError('rpc_terminal_profile_required');
    return base('terminal.create',{workspace_id:value(args,'--workspace'),profile:'smoke.echo'},context);
  }
  throw new SupersetParseError('rpc_operation_denied');
}

export function buildCodexRateLimitsReadRpc(context: SupersetRpcContext): SupersetRpcRequest {
  return base('codex.rate_limits.read', {}, context);
}

export class SupersetRpcClient {
  constructor(private readonly socketPath:string,private readonly timeoutMs=30_000) {}
  call(request:SupersetRpcRequest):Promise<unknown> { return new Promise((resolve,reject)=>{
    const socket=connect({path:this.socketPath}); let raw=''; let settled=false;
    const finish=(error?:Error,value?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve(value);};
    const timer=setTimeout(()=>finish(new SupersetParseError('rpc_timeout')),this.timeoutMs);
    socket.once('error',()=>finish(new SupersetParseError('rpc_unavailable')));
    socket.on('data',chunk=>{raw+=chunk.toString('utf8');if(raw.length>1_048_576)finish(new SupersetParseError('rpc_result_too_large'));});
    socket.once('connect',()=>socket.end(JSON.stringify(request)));
    socket.once('end',()=>{try{const response=JSON.parse(raw) as {ok?:boolean;result?:unknown};if(response.ok!==true) throw new Error();finish(undefined,response.result);}catch{finish(new SupersetParseError('rpc_request_rejected'));}});
  }); }
}

/** Production adapter: it retains the existing backend API but has no child process or CLI binary. */
export function createSupersetRpcRunner(client:SupersetRpcClient,context:SupersetRpcContext):CliRunner {
  return async(args):Promise<CliResult>=>{
    const result=await client.call(mapSupersetCliToRpc(args,context));
    return {exitCode:0,stdout:JSON.stringify(result),stderr:'',timedOut:false};
  };
}
