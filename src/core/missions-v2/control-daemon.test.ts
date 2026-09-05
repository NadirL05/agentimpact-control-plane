import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {spawn,type ChildProcess} from 'node:child_process';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {digest} from './model.js';
import {localWorkerRequest,WorkerTransportAuthenticator} from './codex-transport.js';

let temp:string;
beforeAll(async()=>{temp=await mkdtemp(join(tmpdir(),'codex-control-'));});
afterAll(async()=>{await rm(temp,{recursive:true,force:true});});

const key=Buffer.alloc(32,0x5a),keyHex=key.toString('hex');
const request=(auth:WorkerTransportAuthenticator,overrides:Record<string,unknown>={})=>{
  const payload={phase:'executing'},message={attempt_id:randomUUID(),worker_instance_id:'codex-one',fencing_token:'7',operation:'progress' as const,
    timestamp:Math.floor(Date.now()/1000),nonce:randomUUID(),payload_hash:digest(payload),...overrides};
  return{message,payload,signature:auth.sign(message)};
};
async function child(enabled:boolean){
  const root=await mkdtemp(join(temp,'run-')),socket=join(root,'control.sock');
  const proc=spawn(process.execPath,['--import','tsx','codex-worker/testing/control-daemon-fixture.ts'],{cwd:new URL('../..',import.meta.url).pathname,
    env:{PATH:processEnv('PATH'),CONTROL_TEST_SOCKET:socket,CONTROL_TEST_HMAC:keyHex,CONTROL_TEST_ENABLED:enabled?'1':'0'},stdio:['ignore','pipe','pipe']});
  let logs='';proc.stdout.on('data',chunk=>{logs+=chunk.toString();});proc.stderr.on('data',chunk=>{logs+=chunk.toString();});
  await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error(`daemon_start_timeout:${logs}`)),5000);
    const check=()=>{if(logs.includes('codex_control_ready')){clearTimeout(timeout);resolve();}};proc.stdout.on('data',check);proc.once('exit',code=>reject(new Error(`daemon_exited:${code}:${logs}`)));check();});
  return{process:proc,socket,logs:()=>logs};
}
const processEnv=(name:string)=>process.env[name]??'';
async function stop(child:ChildProcess){child.kill('SIGTERM');await new Promise<void>((resolve,reject)=>{
  const timeout=setTimeout(()=>reject(new Error('daemon_stop_timeout')),5000);child.once('exit',()=>{clearTimeout(timeout);resolve();});});}

describe('deployable Codex control daemon without provider execution',()=>{
  it('round-trips the real socket and rejects bad HMAC, replay, stale time, and fencing',async()=>{
    const running=await child(true),auth=new WorkerTransportAuthenticator(key),good=request(auth);
    try{
      expect((await stat(running.socket)).mode&0o777).toBe(0o600);
      await expect(localWorkerRequest(running.socket,good,join(running.socket,'..'))).resolves.toEqual({accepted:true,operation:'progress'});
      await expect(localWorkerRequest(running.socket,good,join(running.socket,'..'))).rejects.toMatchObject({code:'worker_transport_rejected'});
      const wrong=request(new WorkerTransportAuthenticator(Buffer.alloc(32,1)));
      await expect(localWorkerRequest(running.socket,wrong,join(running.socket,'..'))).rejects.toMatchObject({code:'worker_transport_rejected'});
      const stale=request(auth,{timestamp:1});
      await expect(localWorkerRequest(running.socket,stale,join(running.socket,'..'))).rejects.toMatchObject({code:'worker_transport_rejected'});
      const fenced=request(auth,{fencing_token:'8'});
      await expect(localWorkerRequest(running.socket,fenced,join(running.socket,'..'))).rejects.toMatchObject({code:'fencing_rejected'});
    }finally{await stop(running.process);}
    await expect(stat(running.socket)).rejects.toMatchObject({code:'ENOENT'});
    await expect(localWorkerRequest(running.socket,request(auth),join(running.socket,'..'))).rejects.toBeTruthy();
    expect(running.logs()).toContain('codex_control_stopped');
    expect(running.logs()).not.toContain(keyHex);expect(running.logs()).not.toContain('CONTROL_TEST_HMAC');
  });

  it('keeps launch operations fail-closed while feature flags are off and starts no Codex child',async()=>{
    const running=await child(false),auth=new WorkerTransportAuthenticator(key);
    try{await expect(localWorkerRequest(running.socket,request(auth,{operation:'claim'}),join(running.socket,'..')))
      .rejects.toMatchObject({code:'feature_disabled'});
      const children=await readFile(`/proc/${running.process.pid}/task/${running.process.pid}/children`,'utf8');expect(children.trim()).toBe('');
    }finally{await stop(running.process);}
  });
});
