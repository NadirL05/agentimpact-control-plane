import type {Pool} from 'pg';
import {digest,MissionError} from './model.js';
import type {CodexOutput, CodexStateRecorder, CodexWork, CodexWorkerConfig} from './codex-worker.js';

export class CodexStateStore implements CodexStateRecorder {
  constructor(private pool:Pool){}
  async register(work:CodexWork,config:CodexWorkerConfig){
    if(work.quota_state!==config.quotaState||work.workspace_path!==`${config.workspaceRoot}/attempts/${work.attempt_id}/workspace`)
      throw new MissionError('codex_attempt_binding_invalid',409);
    const contractHash=digest(work);
    const result=await this.pool.query(`INSERT INTO codex_attempt_metadata(attempt_id,adapter_version,contract_hash,max_attempts,auth_mode,billing_mode,quota_source,quota_state,
      quota_checked_at,workspace_id,workspace_root,canonical_path,cgroup_name)
      SELECT a.id,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $8='UNKNOWN' THEN NULL ELSE clock_timestamp() END,$9,$10,$11,$12
      FROM mission_attempts a JOIN budget_reservations b ON b.attempt_id=a.id JOIN worktree_leases w ON w.attempt_id=a.id
      WHERE a.id=$1 AND a.mission_id=$13 AND a.worker_type='codex' AND a.worker_instance_id=$14 AND a.fencing_token=$15::bigint
        AND b.id=$16 AND b.status='reserved' AND w.id=$9 AND w.repo=$17 AND w.base_sha=$18 AND w.branch=$19 AND w.worktree_path=$11
      ON CONFLICT(attempt_id) DO NOTHING RETURNING attempt_id`,[work.attempt_id,'1.0.0',contractHash,work.max_attempts,config.authMode,config.billingMode,
        work.quota_state==='UNKNOWN'?'none':'operator_verified',work.quota_state,work.workspace_id,config.workspaceRoot,work.workspace_path,
        `agentimpact-codex-worker@${work.attempt_id}.service`,work.mission_id,work.worker_instance_id,work.fencing_token,work.budget_reservation_id,
        work.repo_id,work.base_sha,work.branch]);
    if(!result.rowCount){const existing=await this.pool.query<{contract_hash:string}>('SELECT contract_hash FROM codex_attempt_metadata WHERE attempt_id=$1',[work.attempt_id]);
      if(existing.rows[0]?.contract_hash!==contractHash)throw new MissionError('codex_attempt_binding_invalid',409);}
  }
  async process(attemptId:string,pid:number|null){await this.pool.query(`UPDATE codex_attempt_metadata SET process_id=$2,updated_at=clock_timestamp()
    WHERE attempt_id=$1`,[attemptId,pid]);}
  async validation(attemptId:string,state:'running'|'passed'|'failed'|'quarantined'){await this.pool.query(`UPDATE codex_attempt_metadata SET validation_state=$2,updated_at=clock_timestamp()
    WHERE attempt_id=$1`,[attemptId,state]);}
  async artifacts(attemptId:string,items:CodexOutput['artifacts']){for(const item of items)await this.pool.query(`INSERT INTO codex_artifacts(attempt_id,kind,relative_path,sha256,size_bytes)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(attempt_id,kind,relative_path,sha256) DO NOTHING`,[attemptId,item.kind,item.relative_path,item.sha256,item.size_bytes]);}
  async result(attemptId:string,output:CodexOutput,resultHash:string){const client=await this.pool.connect();try{await client.query('BEGIN');
    await client.query(`UPDATE codex_attempt_metadata SET provider_session_present=$2,result_hash=$3,updated_at=clock_timestamp() WHERE attempt_id=$1`,
      [attemptId,output.provider_session_id!==null,resultHash]);
    const sessionReference=output.provider_session_id===null?null:`sha256:${digest(output.provider_session_id)}`;
    await client.query('UPDATE mission_attempts SET provider_session_id=$2,updated_at=clock_timestamp() WHERE id=$1',[attemptId,sessionReference]);
    await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
  async metric(name:string,delta=1){const allowed=new Set(['codex_attempts_total','codex_attempts_failed_total','codex_timeouts_total','codex_cancellations_total',
    'codex_output_invalid_total','codex_validation_failures_total','codex_publish_requests_total','codex_publish_failures_total']);
    if(!allowed.has(name))throw new MissionError('codex_metric_invalid',400);
    await this.pool.query('UPDATE execution_metrics SET value=value+$2 WHERE name=$1',[name,delta]);}
}
