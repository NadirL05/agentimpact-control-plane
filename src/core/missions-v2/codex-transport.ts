import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createConnection, createServer, type Server } from 'node:net';
import {mkdir,writeFile} from 'node:fs/promises';
import { MissionError, digest } from './model.js';
import {z} from 'zod';

export type LocalWorkerMessage={attempt_id:string;worker_instance_id:string;fencing_token:string;operation:string;
  timestamp:number;nonce:string;payload_hash:string};
const messageSchema=z.object({attempt_id:z.string().uuid(),worker_instance_id:z.string().regex(/^codex-[A-Za-z0-9_.:-]{1,120}$/),
  fencing_token:z.string().regex(/^[1-9][0-9]{0,18}$/),operation:z.enum(['assignment','claim','start','heartbeat','progress','inspect','cancel','complete','collect']),
  timestamp:z.number().int().nonnegative(),nonce:z.string().uuid(),payload_hash:z.string().regex(/^[0-9a-f]{64}$/)}).strict();
export class WorkerTransportAuthenticator{
  private seen=new Map<string,number>();constructor(private credential:Buffer,private maxSkewSeconds=30){if(credential.length<32)throw new MissionError('worker_transport_credential_invalid',503);}
  sign(message:LocalWorkerMessage){return createHmac('sha256',this.credential).update(digest(message)).digest('hex');}
  verify(message:LocalWorkerMessage,signature:string,now=Math.floor(Date.now()/1000)){for(const [nonce,seenAt] of this.seen)if(now-seenAt>this.maxSkewSeconds)this.seen.delete(nonce);
    if(!messageSchema.safeParse(message).success||!/^[0-9a-f]{64}$/.test(signature)||Math.abs(now-message.timestamp)>this.maxSkewSeconds||this.seen.has(message.nonce))throw new MissionError('worker_transport_rejected',403);
    const expected=Buffer.from(this.sign(message),'hex'),provided=Buffer.from(signature,'hex');if(expected.length!==provided.length||!timingSafeEqual(expected,provided))throw new MissionError('worker_transport_rejected',403);
    this.seen.set(message.nonce,now);return true;}
}

export type SignedWorkerRequest={message:LocalWorkerMessage;signature:string;payload:unknown};
const MAX_FRAME_BYTES=1024*1024;
export async function writeSignedAssignment(runtimeRoot:string,payload:{attempt_id:string;worker_instance_id:string;fencing_token:string},auth:WorkerTransportAuthenticator){
  if(runtimeRoot!=='/run/agentimpact-codex-worker')throw new MissionError('worker_runtime_root_invalid',400);
  const message:LocalWorkerMessage={attempt_id:payload.attempt_id,worker_instance_id:payload.worker_instance_id,fencing_token:payload.fencing_token,
    operation:'assignment',timestamp:Math.floor(Date.now()/1000),nonce:randomUUID(),payload_hash:digest(payload)};
  const directory=`${runtimeRoot}/${payload.attempt_id}`;await mkdir(directory,{recursive:false,mode:0o750});
  await writeFile(`${directory}/assignment.json`,`${JSON.stringify({message,payload,signature:auth.sign(message)})}\n`,{encoding:'utf8',mode:0o440,flag:'wx'});
}
export class LocalWorkerServer {
  private server:Server|null=null;
  constructor(private socketPath:string,private auth:WorkerTransportAuthenticator,
    private dispatch:(request:SignedWorkerRequest)=>Promise<unknown>,private socketRoot='/run/agentimpact-codex-worker'){}
  async listen(){if(!this.socketPath.startsWith(`${this.socketRoot}/`))throw new MissionError('worker_socket_path_invalid',400);
    this.server=createServer(socket=>{let body='';socket.setEncoding('utf8');socket.on('data',chunk=>{
      body+=chunk;if(Buffer.byteLength(body)>MAX_FRAME_BYTES){socket.destroy();return;}const newline=body.indexOf('\n');if(newline<0)return;
      socket.pause();void this.handle(body.slice(0,newline)).then(result=>socket.end(`${JSON.stringify({ok:true,result})}\n`),
        error=>socket.end(`${JSON.stringify({ok:false,error:error instanceof MissionError?error.code:'worker_transport_error'})}\n`));});});
    await new Promise<void>((resolveListen,reject)=>{this.server!.once('error',reject);this.server!.listen(this.socketPath,resolveListen);});}
  private async handle(raw:string){let request:SignedWorkerRequest;try{request=JSON.parse(raw) as SignedWorkerRequest;}catch{throw new MissionError('worker_transport_rejected',400);}
    if(request.message.payload_hash!==digest(request.payload))throw new MissionError('worker_transport_rejected',403);
    this.auth.verify(request.message,request.signature);return this.dispatch(request);}
  async close(){if(!this.server)return;await new Promise<void>((resolveClose,reject)=>this.server!.close(error=>error?reject(error):resolveClose()));this.server=null;}
}

export async function localWorkerRequest(socketPath:string,request:SignedWorkerRequest,socketRoot='/run/agentimpact-codex-worker'):Promise<unknown>{
  if(!socketPath.startsWith(`${socketRoot}/`))throw new MissionError('worker_socket_path_invalid',400);
  return new Promise((resolveRequest,reject)=>{const socket=createConnection(socketPath);let body='';socket.setEncoding('utf8');
    socket.once('error',reject);socket.on('data',chunk=>{body+=chunk;if(Buffer.byteLength(body)>MAX_FRAME_BYTES){socket.destroy();reject(new MissionError('worker_transport_response_too_large'));}});
    socket.once('connect',()=>socket.end(`${JSON.stringify(request)}\n`));socket.once('end',()=>{try{const response=JSON.parse(body) as {ok:boolean;result?:unknown;error?:string};
      if(!response.ok)reject(new MissionError(response.error??'worker_transport_error'));else resolveRequest(response.result);}catch{reject(new MissionError('worker_transport_invalid_response'));}});});
}
