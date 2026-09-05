import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {ExecutionControl} from './execution.js';
import {MissionError} from './model.js';

export type StopInspection='running'|'stopped'|'unknown';
export interface AttemptInspector{inspect(attemptId:string):Promise<StopInspection>}
const execute=promisify(execFile);
export class SystemdAttemptInspector implements AttemptInspector {
  async inspect(attemptId:string):Promise<StopInspection>{
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(attemptId))return'unknown';
    try{const unit=`agentimpact-codex-worker@${attemptId}.service`;
      const {stdout}=await execute('/usr/bin/systemctl',['show',unit,'--property=ActiveState,ControlGroup,MainPID','--value'],{timeout:5000,maxBuffer:4096});
      const [active,cgroup,pid]=stdout.trim().split('\n');
      if(cgroup!==`/system.slice/${unit}`)return'unknown';
      const processes=await readFile(`/sys/fs/cgroup${cgroup}/cgroup.procs`,'utf8').catch(()=>null);
      if(active==='active'||Number(pid)>1||processes===null||processes.trim())return active==='active'?'running':'unknown';
      return'stopped';
    }catch{return'unknown';}
  }
}

export class CodexRecoverySupervisor {
  constructor(private control:ExecutionControl,private inspector:AttemptInspector){}
  async tick(){const expired=await this.control.scanExpired(),pending=await this.control.pendingReconciliation();let stopped=0,unknown=0,running=0;
    for(const attempt of pending.filter(item=>item.worker_type==='codex')){const neverStarted=!attempt.started_at&&!attempt.heartbeat_at;
      const observation=neverStarted?'stopped':await this.inspector.inspect(attempt.id);if(observation==='running'){running++;continue;}
      const kind=observation==='stopped'?'stopped':'unknown';try{await this.control.reconcile(attempt.id,{kind,worker_instance_id:attempt.worker_instance_id,
        fencing_token:attempt.fencing_token},{principal:'codex-supervisor',key:randomUUID()});kind==='stopped'?stopped++:unknown++;}
      catch(error){if(!(error instanceof MissionError)||!['attempt_not_current','reconciliation_not_required','mission_terminal'].includes(error.code))throw error;}
    }return{expired,stopped,unknown,running};}
}
