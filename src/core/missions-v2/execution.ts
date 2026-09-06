import { randomUUID } from 'node:crypto';
import { posix as path } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { assertV2, digest, MissionError, type State } from './model.js';
import type { Mission, Mutation } from './store.js';

export type ExecutionConfig = { enabled: boolean; projects: ReadonlySet<string>; workerIds: ReadonlySet<string>;
  leaseSeconds?: number; deadlineSeconds?: number; quotaAmount?: number | null; workerTypes?: ReadonlySet<'fake'|'codex'>;
  workspaceRoots?: Partial<Record<'fake'|'codex',string>>; repoIds?: ReadonlySet<string> };
export type WorkerProof = { attempt_id: string; worker_instance_id: string; fencing_token: string };
export type Attempt = {
  id: string; attempt_id: string; mission_id: string; attempt_number: number; plan_version: number; worker_type: 'fake'|'codex'; worker_instance_id: string;
  status: 'queued'|'claimed'|'running'|'completing'|'completed'|'stale'|'cancelled'|'failed';
  fencing_token: string; execution_payload_hash: string; head_sha: string|null; base_sha: string|null;
  created_at: Date; started_at: Date|null; updated_at: Date; completed_at: Date|null;
  lease_expires_at: Date|null; heartbeat_at: Date|null; deadline_at: Date;
  retryable: boolean; error_code: string|null; error_summary: string|null; provider_session_id: string|null;
  reconciled_at: Date|null; stop_proof_at: Date|null; callback_hash: string|null; approval_required: boolean;
};
type ExecutionMission = Mission & { current_attempt_id: string|null; phase: string|null; blocked_reason: string|null;
  head_sha: string|null; base_sha: string|null; execution_payload_hash: string|null };
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const identity = z.string().regex(/^[A-Za-z0-9:_.-]{1,200}$/);
const proofSchema = z.object({ attempt_id: z.string().uuid(), worker_instance_id: identity,
  fencing_token: z.string().regex(/^[1-9][0-9]{0,18}$/) }).strict();
const workspaceSchema = z.object({ repo: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.\/-]{0,199}$/), base_sha: sha,
  branch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.\/-]{0,199}$/),
  workspace_root: z.string().startsWith('/').max(200).optional(),
  worktree_path: z.string().min(1).max(300).optional(),
}).strict().refine(w => ![w.repo,w.branch].some(v => v.includes('..') || v.includes('//')));
const optionsSchema = z.object({ worker_instance_id: identity.optional(), worker_type:z.enum(['fake','codex']).optional(), workspace: workspaceSchema.optional(),
  budget: z.object({ max_amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    reserved_amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), currency: z.literal('FAKE').optional(),
  }).strict().refine(b => b.reserved_amount <= b.max_amount).optional(),
  payload_hash: hash.optional(), head_sha: sha.optional(), approval_required: z.boolean().optional(),
}).strict();
export type QueueOptions = z.infer<typeof optionsSchema>;
export type CanonicalWorkspacePath = {workspace_root:string;candidate_path:string;canonical_path:string};
export type ProviderQuotaStatus = {quota_source:'none';quota_state:'UNKNOWN';quota_checked_at:null};
const unknownProviderQuota: ProviderQuotaStatus = {quota_source:'none',quota_state:'UNKNOWN',quota_checked_at:null};

/** Lexical normalization only. A real worker must additionally resolve symlinks
 * inside its sandbox before touching the filesystem. */
export function canonicalWorkspacePath(candidatePath: string,workspaceRoot = '/fake'): CanonicalWorkspacePath {
  if (!path.isAbsolute(workspaceRoot) || path.normalize(workspaceRoot)!==workspaceRoot || workspaceRoot==='/' ||
    !path.isAbsolute(candidatePath) || candidatePath.includes('\0'))
    throw new MissionError('invalid_workspace_path',400);
  const canonicalPath = path.normalize(candidatePath);
  if (canonicalPath === workspaceRoot || !canonicalPath.startsWith(`${workspaceRoot}/`))
    throw new MissionError('workspace_path_escape',400);
  return {workspace_root:workspaceRoot,candidate_path:candidatePath,canonical_path:canonicalPath};
}
const completionSchema = z.object({ outcome: z.enum(['completed','failed']),retryable: z.boolean().optional(),
  head_sha: sha.optional(),error_code: z.enum(['fake_failure','worker_failed','validation_failed','deadline_exceeded']).optional(),
}).strict();
export type Completion = z.infer<typeof completionSchema>;
const terminalMissions: State[] = ['completed','failed_permanent','cancelled','rejected'];
const liveAttempt = ['queued','claimed','running','completing'];
const missionColumns = 'id,orchestration_version,project,lifecycle_state,state_version,plan_version,parent_mission_id,request_hash,requested_by,current_attempt_id,phase,blocked_reason,head_sha,base_sha,execution_payload_hash';
// These codes are deliberately bounded: no exception text, prompts or worker output is stored.
class DurableRejection extends MissionError {}
const attemptRow = (row: Attempt): Attempt => ({...row,attempt_id:row.id,fencing_token:String(row.fencing_token)});

export function approvalPayload(a: Pick<Attempt,'id'|'mission_id'|'execution_payload_hash'>,actionType:'execute'|'review',headSha: string|null = null) {
  // Stable alphabetical insertion order also matches the existing /actions
  // JSON.stringify hashing contract; no alternate approval engine is needed.
  return {action_type:actionType,attempt_id:a.id,execution_payload_hash:a.execution_payload_hash,head_sha:headSha,mission_id:a.mission_id};
}
export function approvalPayloadHash(a: Pick<Attempt,'id'|'mission_id'|'execution_payload_hash'>,actionType:'execute'|'review',headSha: string|null = null): string {
  return digest(approvalPayload(a,actionType,headSha));
}

/** Internal fake-only execution boundary. The worker identity comes from a trusted caller,
 * separately from the untrusted proof; this class is not a public worker transport. */
export class ExecutionControl {
  readonly heartbeatSeconds = 15;
  readonly scanSeconds = 30;
  private leaseSeconds: number;
  private deadlineSeconds: number;
  private quota: number|null;
  constructor(private pool: Pool, private config: ExecutionConfig) {
    this.leaseSeconds = config.leaseSeconds ?? 90;
    this.deadlineSeconds = config.deadlineSeconds ?? 3600;
    this.quota = config.quotaAmount === undefined ? 100000 : config.quotaAmount;
    if (!Number.isInteger(this.leaseSeconds) || this.leaseSeconds < 1 || this.leaseSeconds > 3600 ||
      !Number.isInteger(this.deadlineSeconds) || this.deadlineSeconds < 1 || this.deadlineSeconds > 86400 ||
      (this.quota !== null && (!Number.isSafeInteger(this.quota) || this.quota < 0))) throw new MissionError('invalid_execution_config',400);
  }
  private gate(project?: string) {
    if (!this.config.enabled) throw new MissionError('v2_disabled',503);
    if (project && !this.config.projects.has(project)) throw new MissionError('project_not_allowed',403);
  }
  private async counter(c: Pick<PoolClient,'query'>,name: string,amount = 1) {
    await c.query(`INSERT INTO execution_metrics(name,value) VALUES($1,$2)
      ON CONFLICT(name) DO UPDATE SET value=execution_metrics.value+EXCLUDED.value`,[name,amount]);
  }
  private async transact<T>(meta: Mutation, payload: unknown, run: (c: PoolClient) => Promise<T>,
    replay?: (c: PoolClient,response: T) => Promise<void>, callback = false): Promise<T> {
    this.gate();
    if (!identity.safeParse(meta.principal).success || !identity.safeParse(meta.key).success) throw new MissionError('invalid_mutation_identity',400);
    const payloadHash = digest(payload);
    const c = await this.pool.connect();
    let committed = false;
    try {
      await c.query('BEGIN');
      await c.query('LOCK TABLE agent_missions IN SHARE ROW EXCLUSIVE MODE');
      const receipt = await c.query(`SELECT payload_hash,response,mission_id FROM execution_receipts WHERE principal=$1 AND idempotency_key=$2`,[meta.principal,meta.key]);
      if (receipt.rows[0]) {
        await this.mission(c,receipt.rows[0].mission_id);
        if (receipt.rows[0].payload_hash !== payloadHash) throw new MissionError('idempotency_conflict');
        if (replay) await replay(c,receipt.rows[0].response);
        await c.query('COMMIT'); committed = true;
        return receipt.rows[0].response;
      }
      const response = await run(c);
      const result = response as {id?:string;mission_id?:string;attempt_id?:string};
      const missionId = result.mission_id ?? result.id;
      if (missionId) await c.query(`INSERT INTO execution_receipts(principal,idempotency_key,payload_hash,mission_id,attempt_id,response)
        VALUES($1,$2,$3,$4,$5,$6)`,[meta.principal,meta.key,payloadHash,missionId,result.attempt_id ?? null,JSON.stringify(response)]);
      await c.query('COMMIT'); committed = true;
      return response;
    } catch (error) {
      if (error instanceof DurableRejection) { await c.query('COMMIT'); committed = true; }
      if (!committed) await c.query('ROLLBACK').catch(() => undefined);
      if (callback && error instanceof MissionError) {
        // Rejected callbacks are observable even when their mutation rolled back.
        await this.counter(c,'callbacks_rejected_total').catch(() => undefined);
        if (['fencing_rejected','wrong_worker','attempt_not_current'].includes(error.code))
          await this.counter(c,'fencing_rejections_total').catch(() => undefined);
      }
      if (error instanceof MissionError) throw error;
      const code = (error as {code?: string}).code;
      if (code === '23505') throw new MissionError('execution_ownership_conflict');
      if (code === '23514' || code === '23503') throw new MissionError('execution_constraint_conflict');
      throw new MissionError('execution_storage_unavailable',503);
    } finally { c.release(); }
  }
  private async mission(c: Pick<PoolClient,'query'>,id: string): Promise<ExecutionMission> {
    if (!z.string().uuid().safeParse(id).success) throw new MissionError('invalid_mission_id',400);
    const r = await c.query(`SELECT ${missionColumns} FROM agent_missions WHERE id=$1`,[id]);
    assertV2(r.rows[0]); this.gate(r.rows[0].project);
    return r.rows[0];
  }
  private async attempt(c: Pick<PoolClient,'query'>,id: string): Promise<Attempt> {
    if (!z.string().uuid().safeParse(id).success) throw new MissionError('invalid_attempt_id',400);
    const r = await c.query('SELECT * FROM mission_attempts WHERE id=$1',[id]);
    if (!r.rows[0]) throw new MissionError('attempt_not_found',404);
    await this.mission(c,r.rows[0].mission_id);
    return attemptRow(r.rows[0]);
  }
  private async event(c: PoolClient,m: ExecutionMission,state = m.lifecycle_state,phase = m.phase,reason: string|null = m.blocked_reason,eventType = 'state_changed'): Promise<ExecutionMission> {
    const r = await c.query(`UPDATE agent_missions SET lifecycle_state=$2,phase=$3,blocked_reason=$4,state_version=state_version+1,
      updated_at=clock_timestamp() WHERE id=$1 AND orchestration_version=2 RETURNING ${missionColumns}`,[m.id,state,phase,reason]);
    const next = r.rows[0];
    await c.query(`INSERT INTO mission_events(mission_id,event_type,state_version,plan_version,lifecycle_state,attempt_id)
      VALUES($1,$6,$2,$3,$4,$5)`,[next.id,next.state_version,next.plan_version,next.lifecycle_state,next.current_attempt_id,eventType]);
    return next;
  }
  private async block(c: PoolClient,m: ExecutionMission,reason: string): Promise<never> {
    await this.event(c,m,'blocked',m.phase,reason,reason.startsWith('dependency_')?'dependency_blocked':'state_changed');
    if (reason.startsWith('dependency_')) await this.counter(c,'dependency_blocks_total');
    throw new DurableRejection(reason);
  }
  private async dependencyReason(c: Pick<PoolClient,'query'>,m: ExecutionMission,baseSha?: string|null): Promise<string|null> {
    const r = await c.query(`SELECT d.*,p.lifecycle_state,p.head_sha,EXISTS(
      SELECT 1 FROM mission_dependency_evidence e WHERE e.mission_id=d.mission_id AND e.depends_on_id=d.depends_on_id
      AND e.plan_version=d.plan_version AND e.kind='human_merge' AND e.head_sha=p.head_sha) AS merge_verified
      FROM mission_dependencies d JOIN agent_missions p ON p.id=d.depends_on_id
      WHERE d.mission_id=$1 ORDER BY d.plan_version,d.depends_on_id`,[m.id]);
    for (const d of r.rows) {
      if (['failed_permanent','rejected'].includes(d.lifecycle_state)) return 'dependency_failed';
      if (d.lifecycle_state === 'cancelled') return 'dependency_cancelled';
      if (d.lifecycle_state !== 'completed') return 'dependency_incomplete';
      if (d.dependency_type === 'commit' || d.dependency_type === 'human_merge') {
        if (!d.head_sha || d.reference !== d.head_sha || (baseSha && baseSha !== d.head_sha)) return 'dependency_git_mismatch';
        if (d.dependency_type === 'human_merge' && !d.merge_verified) return 'dependency_merge_unverified';
      }
    }
    return null;
  }
  private async approvalValid(c: Pick<PoolClient,'query'>,a: Attempt,actionType: 'execute'|'review',headSha: string|null = a.head_sha,lock = false): Promise<boolean> {
    if (lock) {
      const protectedCheck=await c.query(`SELECT mission_execution_approval_valid($1,$2,$3,$4,$5::text) AS valid`,
        [a.mission_id,a.id,actionType,approvalPayloadHash(a,actionType,headSha),headSha]);
      return Boolean(protectedCheck.rows[0]?.valid);
    }
    const r = await c.query(`SELECT 1 FROM mission_approval_bindings b
      JOIN agent_actions x ON x.id=b.action_id JOIN agent_approvals p ON p.action_id=x.id
      WHERE b.mission_id=$1 AND b.attempt_id=$2 AND b.action_type=$3 AND b.payload_hash=$4
        AND b.head_sha IS NOT DISTINCT FROM $5::text AND b.expires_at>clock_timestamp()
        AND x.intent=b.action_type AND x.payload_hash=b.payload_hash AND x.status='approved'
        AND x.approval_expires_at>clock_timestamp() AND p.payload_hash=b.payload_hash
        AND p.decision='approved' AND p.expires_at>clock_timestamp()
        AND p.approver='human-admin' AND p.decided_at >= (SELECT created_at FROM mission_attempts WHERE id=$2)
      LIMIT 1`,[a.mission_id,a.id,actionType,approvalPayloadHash(a,actionType,headSha),headSha]);
    return Boolean(r.rowCount);
  }
  private bindingCurrent(m: ExecutionMission,a: Attempt,actionType: 'execute'|'review'): boolean {
    return m.current_attempt_id === a.id && m.execution_payload_hash === a.execution_payload_hash &&
      m.base_sha === a.base_sha && m.plan_version === a.plan_version &&
      (actionType === 'review' || m.head_sha === a.head_sha);
  }
  private async approvalState(c: Pick<PoolClient,'query'>,m: ExecutionMission,a: Attempt,
    actionType: 'execute'|'review',headSha: string|null): Promise<'valid'|'invalid'|'required'|'not_required'> {
    const bindings = await c.query(`SELECT attempt_id FROM mission_approval_bindings
      WHERE mission_id=$1 AND action_type=$2 ORDER BY created_at DESC,id DESC`,[m.id,actionType]);
    const current = bindings.rows.some(row => row.attempt_id === a.id);
    if (current) return this.bindingCurrent(m,a,actionType) && await this.approvalValid(c,a,actionType,headSha)
      ? 'valid' : 'invalid';
    if (bindings.rowCount) return 'invalid';
    return a.approval_required || actionType === 'review' ? 'required' : 'not_required';
  }
  private parseOptions(input: QueueOptions): QueueOptions {
    const p = optionsSchema.safeParse(input);
    if (!p.success) throw new MissionError('invalid_execution_options',400);
    if (!p.data.workspace) return p.data;
    const workerType=p.data.worker_type??'fake';
    const configuredRoot=this.config.workspaceRoots?.[workerType]??(workerType==='fake'?'/fake':undefined);
    if(!configuredRoot||p.data.workspace.workspace_root && p.data.workspace.workspace_root!==configuredRoot)throw new MissionError('invalid_workspace_path',400);
    if(workerType==='codex'&&this.config.repoIds&&!this.config.repoIds.has(p.data.workspace.repo))throw new MissionError('repo_not_allowed',403);
    if(workerType==='codex'){if(p.data.workspace.worktree_path)throw new MissionError('codex_workspace_path_is_server_derived',400);
      return {...p.data,workspace:{...p.data.workspace,workspace_root:configuredRoot}};}
    if(!p.data.workspace.worktree_path)throw new MissionError('invalid_workspace_path',400);
    const normalized = canonicalWorkspacePath(p.data.workspace.worktree_path,configuredRoot);
    return {...p.data,workspace:{...p.data.workspace,workspace_root:normalized.workspace_root,
      worktree_path:normalized.canonical_path}};
  }
  private workerId(options: QueueOptions): string {
    const worker = options.worker_instance_id ?? [...this.config.workerIds].sort()[0];
    const workerType = options.worker_type ?? 'fake';
    const types = this.config.workerTypes ?? new Set<'fake'|'codex'>(['fake']);
    if (!worker || !worker.startsWith(`${workerType}-`) || !types.has(workerType) || !this.config.workerIds.has(worker))
      throw new MissionError('worker_not_allowed',403);
    return worker;
  }
  private async create(c: PoolClient,m: ExecutionMission,options: QueueOptions,retry: boolean): Promise<Attempt> {
    const reason = await this.dependencyReason(c,m,options.workspace?.base_sha);
    if (reason) return this.block(c,m,reason);
    if (options.budget && this.quota === null) return this.block(c,m,'budget_unknown');
    if (options.budget) {
      const used = await c.query(`SELECT COALESCE(sum(reserved_amount),0)::text AS amount FROM budget_reservations
        WHERE status IN ('reserved','consuming','exhausted')`,[]);
      if (Number(used.rows[0].amount)+options.budget.reserved_amount > this.quota!) return this.block(c,m,'budget_exhausted');
    }
    const id = randomUUID();
    const worker = this.workerId(options);
    const workerType=options.worker_type??'fake';
    const payloadHash = options.payload_hash ?? digest({mission_id:m.id,plan_version:m.plan_version,base_sha:options.workspace?.base_sha ?? null});
    const r = await c.query(`INSERT INTO mission_attempts(id,mission_id,project,attempt_number,worker_type,worker_instance_id,status,
      deadline_at,execution_payload_hash,head_sha,base_sha,plan_version,approval_required)
      SELECT $1,$2,$3,COALESCE(max(attempt_number),0)+1,$11,$4,'queued',
      clock_timestamp()+make_interval(secs=>$5),$6,$7,$8,$9,$10 FROM mission_attempts WHERE mission_id=$2 RETURNING *`,
    [id,m.id,m.project,worker,this.deadlineSeconds,payloadHash,options.head_sha ?? null,options.workspace?.base_sha ?? null,m.plan_version,
      workerType==='codex'||(options.approval_required??false),workerType]);
    const a = attemptRow(r.rows[0]);
    if (options.workspace) {const worktreePath=workerType==='codex'?`${this.config.workspaceRoots!.codex}/attempts/${id}/workspace`:options.workspace.worktree_path!;
      const values=[randomUUID(),m.id,id,options.workspace.repo,options.workspace.base_sha,options.workspace.branch,worktreePath,worker,a.fencing_token];
      if(workerType==='codex')await c.query(`INSERT INTO worktree_leases(id,mission_id,attempt_id,repo,base_sha,branch,worktree_path,status,owner_worker,fencing_token,worker_type)
        VALUES($1,$2,$3,$4,$5,$6,$7,'reserved',$8,$9,'codex')`,values);
      else await c.query(`INSERT INTO worktree_leases(id,mission_id,attempt_id,repo,base_sha,branch,worktree_path,status,owner_worker,fencing_token)
        VALUES($1,$2,$3,$4,$5,$6,$7,'reserved',$8,$9)`,values);}
    if (options.budget) await c.query(`INSERT INTO budget_reservations(id,mission_id,attempt_id,provider,cost_class,currency,max_amount,reserved_amount,consumed_amount,status)
      VALUES($1,$2,$3,'fake','test','FAKE',$4,$5,0,'reserved')`,[randomUUID(),m.id,id,options.budget.max_amount,options.budget.reserved_amount]);
    await c.query(`UPDATE agent_missions SET current_attempt_id=$2,execution_payload_hash=$3,head_sha=$4,base_sha=$5 WHERE id=$1`,
      [m.id,id,payloadHash,a.head_sha,a.base_sha]);
    await this.event(c,{...m,current_attempt_id:id},'ready','queued',null,retry?'retried':'attempt_created');
    await this.counter(c,'attempts_created_total');
    if (retry) await this.counter(c,'retries_total');
    return a;
  }
  async queue(id: string,meta: Mutation,input: QueueOptions = {}): Promise<Attempt> {
    const options = this.parseOptions(input);
    return this.transact(meta,{op:'queue',id,options},async c => {
      const m = await this.mission(c,id);
      if (m.current_attempt_id) throw new MissionError('attempt_already_exists');
      if (!['ready','waiting_dependencies','blocked'].includes(m.lifecycle_state) || m.plan_version < 1) throw new MissionError('mission_not_ready');
      return this.create(c,m,options,false);
    });
  }
  private assertBinding(m: ExecutionMission,a: Attempt,launch = false): void {
    if (!this.bindingCurrent(m,a,launch ? 'execute':'review')) throw new MissionError('execution_binding_changed');
  }
  private async verify(c: PoolClient,proof: WorkerProof,authenticatedWorker: string,allowCompleted = false,launch = false): Promise<{a:Attempt;m:ExecutionMission}> {
    if (!proofSchema.safeParse(proof).success) throw new MissionError('invalid_worker_proof',400);
    const a = await this.attempt(c,proof.attempt_id);
    const m = await this.mission(c,a.mission_id);
    if (!this.config.workerIds.has(authenticatedWorker) || authenticatedWorker !== proof.worker_instance_id || a.worker_instance_id !== authenticatedWorker)
      throw new MissionError('wrong_worker',403);
    if (a.fencing_token !== proof.fencing_token) throw new MissionError('fencing_rejected');
    if (m.current_attempt_id !== a.id) throw new MissionError('attempt_not_current');
    this.assertBinding(m,a,launch);
    if (allowCompleted && ['completed','failed'].includes(a.status) && a.callback_hash) return {a,m};
    if (!liveAttempt.includes(a.status)) throw new MissionError('attempt_terminal');
    const expires = await c.query(`SELECT deadline_at<=clock_timestamp() AS deadline_expired,
      lease_expires_at IS NOT NULL AND lease_expires_at<=clock_timestamp() AS lease_expired FROM mission_attempts WHERE id=$1`,[a.id]);
    if (expires.rows[0].deadline_expired || expires.rows[0].lease_expired) {
      await this.expire(c,a,m,Boolean(expires.rows[0].deadline_expired));
      throw new DurableRejection('lease_expired');
    }
    if (['cancel_requested','cancelling','cancelled'].includes(m.lifecycle_state)) throw new MissionError('mission_cancelling');
    return {a,m};
  }
  private callback<T>(meta: Mutation,op: string,proof: WorkerProof,worker: string,payload: unknown,
    fn:(c:PoolClient,a:Attempt,m:ExecutionMission)=>Promise<T>,allowCompleted = false): Promise<T> {
    return this.transact(meta,{op,proof,worker,payload},async c => {
      const {a,m} = await this.verify(c,proof,worker,allowCompleted,op === 'claim' || op === 'start');
      return fn(c,a,m);
    },async c => { await this.verify(c,proof,worker,allowCompleted,op === 'claim' || op === 'start'); },true);
  }
  async claim(id: string,worker: string,proof: WorkerProof,meta: Mutation): Promise<Attempt> {
    if (id !== proof.attempt_id) throw new MissionError('invalid_worker_proof',400);
    return this.callback(meta,'claim',proof,worker,null,async(c,a,m) => {
      if (a.status !== 'queued' || !['ready','blocked'].includes(m.lifecycle_state)) throw new MissionError('attempt_not_claimable');
      const reason = await this.dependencyReason(c,m,a.base_sha);
      if (reason) return this.block(c,m,reason);
      const w = await c.query(`SELECT 1 FROM worktree_leases WHERE attempt_id=$1 AND status='reserved' AND owner_worker=$2 AND fencing_token=$3`,[a.id,worker,a.fencing_token]);
      if (!w.rowCount) return this.block(c,m,'workspace_missing');
      if (this.quota === null) return this.block(c,m,'budget_unknown');
      const budget = await c.query('SELECT * FROM budget_reservations WHERE attempt_id=$1',[a.id]);
      if (!budget.rows[0]) return this.block(c,m,'budget_missing');
      if (budget.rows[0].status !== 'reserved' || Number(budget.rows[0].reserved_amount) <= Number(budget.rows[0].consumed_amount)) return this.block(c,m,'budget_exhausted');
      const used = await c.query(`SELECT COALESCE(sum(reserved_amount),0)::text AS amount FROM budget_reservations WHERE status IN ('reserved','consuming','exhausted')`);
      if (Number(used.rows[0].amount) > this.quota) return this.block(c,m,'budget_exhausted');
      if (a.approval_required && !await this.approvalValid(c,a,'execute',a.head_sha,true)) return this.block(c,m,'approval_invalid');
      await this.verify(c,proof,worker);
      const r = await c.query(`UPDATE mission_attempts SET status='claimed',heartbeat_at=clock_timestamp(),updated_at=clock_timestamp(),
        lease_expires_at=LEAST(deadline_at,clock_timestamp()+make_interval(secs=>$2)) WHERE id=$1 RETURNING *`,[a.id,this.leaseSeconds]);
      await c.query(`UPDATE worktree_leases SET status='leased',leased_at=clock_timestamp(),lease_expires_at=$2 WHERE attempt_id=$1`,[a.id,r.rows[0].lease_expires_at]);
      await c.query(`UPDATE budget_reservations SET status='consuming' WHERE attempt_id=$1`,[a.id]);
      await this.event(c,m,'running','preparing',null,'attempt_claimed');
      return attemptRow(r.rows[0]);
    });
  }
  async start(proof: WorkerProof,worker: string,meta: Mutation): Promise<Attempt> {
    return this.callback(meta,'start',proof,worker,null,async(c,a,m) => {
      if (a.status !== 'claimed') throw new MissionError('attempt_not_claimed');
      const dependency = await this.dependencyReason(c,m,a.base_sha);
      if (dependency) return this.block(c,m,dependency);
      if (a.approval_required && !await this.approvalValid(c,a,'execute',a.head_sha,true)) return this.block(c,m,'approval_invalid');
      if (this.quota === null) return this.block(c,m,'budget_unknown');
      const budget = await c.query(`SELECT 1 FROM budget_reservations WHERE attempt_id=$1 AND status='consuming' AND consumed_amount<reserved_amount`,[a.id]);
      if (!budget.rowCount) return this.block(c,m,'budget_exhausted');
      const used = await c.query(`SELECT COALESCE(sum(reserved_amount),0)::text AS amount FROM budget_reservations WHERE status IN ('reserved','consuming','exhausted')`);
      if (Number(used.rows[0].amount)>this.quota) return this.block(c,m,'budget_exhausted');
      await this.verify(c,proof,worker);
      const r = await c.query(`UPDATE mission_attempts SET status='running',started_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,[a.id]);
      await this.event(c,m,'running','executing',null,'attempt_started');
      return attemptRow(r.rows[0]);
    });
  }
  async heartbeat(proof: WorkerProof,worker: string,meta: Mutation): Promise<Attempt> {
    return this.callback(meta,'heartbeat',proof,worker,null,async(c,a,m) => {
      if (!['claimed','running','completing'].includes(a.status)) throw new MissionError('attempt_not_running');
      const r = await c.query(`UPDATE mission_attempts SET heartbeat_at=clock_timestamp(),updated_at=clock_timestamp(),
        lease_expires_at=LEAST(deadline_at,clock_timestamp()+make_interval(secs=>$2)) WHERE id=$1 RETURNING *`,[a.id,this.leaseSeconds]);
      await c.query(`UPDATE worktree_leases SET lease_expires_at=$2 WHERE attempt_id=$1 AND status='leased'`,[a.id,r.rows[0].lease_expires_at]);
      await this.event(c,m,m.lifecycle_state,m.phase,m.blocked_reason,'heartbeat');
      return attemptRow(r.rows[0]);
    });
  }
  async progress(proof: WorkerProof,worker: string,input: {phase:'preparing'|'executing'|'validating'},meta: Mutation): Promise<Attempt> {
    const parsed = z.object({phase:z.enum(['preparing','executing','validating'])}).strict().safeParse(input);
    if (!parsed.success) throw new MissionError('invalid_progress',400);
    return this.callback(meta,'progress',proof,worker,parsed.data,async(c,a,m) => {
      if (a.status !== 'running') throw new MissionError('attempt_not_running');
      await c.query('UPDATE mission_attempts SET updated_at=clock_timestamp() WHERE id=$1',[a.id]);
      await this.event(c,m,'running',parsed.data.phase,null,'progress');
      return this.attempt(c,a.id);
    });
  }
  private async release(c: PoolClient,a: Attempt,cancelled: boolean) {
    await c.query(`UPDATE worktree_leases SET status='released',released_at=clock_timestamp(),lease_expires_at=NULL WHERE attempt_id=$1 AND status<>'released'`,[a.id]);
    await c.query(`UPDATE budget_reservations SET status=$2,released_at=clock_timestamp() WHERE attempt_id=$1 AND status NOT IN ('released','cancelled')`,[a.id,cancelled?'cancelled':'released']);
  }
  async complete(proof: WorkerProof,worker: string,input: Completion,meta: Mutation,
    persistAccepted?: (c: PoolClient) => Promise<void>): Promise<Attempt> {
    const parsed = completionSchema.safeParse(input);
    if (!parsed.success) throw new MissionError('invalid_completion',400);
    const result = parsed.data;
    const callbackHash = digest(result);
    return this.callback(meta,'complete',proof,worker,result,async(c,a,m) => {
      if (a.callback_hash) {
        if (a.callback_hash !== callbackHash) throw new MissionError('completion_conflict');
        return a;
      }
      if (a.status !== 'running') throw new MissionError('attempt_not_running');
      await c.query(`UPDATE mission_attempts SET status='completing',updated_at=clock_timestamp() WHERE id=$1`,[a.id]);
      const failed = result.outcome === 'failed';
      const nextState = failed ? (result.retryable ? 'retry_wait':'failed_permanent') : 'reviewing';
      const r = await c.query(`UPDATE mission_attempts SET status=$2,completed_at=clock_timestamp(),updated_at=clock_timestamp(),
        retryable=$3,error_code=$4,error_summary=$4,callback_hash=$5,stop_proof_at=clock_timestamp(),reconciled_at=clock_timestamp(),lease_expires_at=NULL
        WHERE id=$1 RETURNING *`,[a.id,failed?'failed':'completed',failed && Boolean(result.retryable),failed?(result.error_code ?? 'fake_failure'):null,callbackHash]);
      // Attempt head is the immutable input binding. Output head belongs to the mission.
      await c.query('UPDATE agent_missions SET head_sha=$2 WHERE id=$1',[m.id,result.head_sha ?? m.head_sha]);
      await this.release(c,a,false);
      await this.event(c,m,nextState,failed?'finished':'reviewing',failed?(result.error_code ?? 'fake_failure'):null,failed?'attempt_failed':'attempt_completed');
      if (persistAccepted) await persistAccepted(c);
      return attemptRow(r.rows[0]);
    },true);
  }
  private async expire(c: PoolClient,a: Attempt,m: ExecutionMission,deadline: boolean) {
    await c.query(`UPDATE mission_attempts SET status='stale',retryable=true,error_code=$2,error_summary=$2,updated_at=clock_timestamp()
      WHERE id=$1`,[a.id,deadline?'deadline_exceeded':'lease_expired']);
    await c.query(`UPDATE worktree_leases SET status='quarantined' WHERE attempt_id=$1 AND status<>'released'`,[a.id]);
    const cancelling = ['cancel_requested','cancelling'].includes(m.lifecycle_state);
    await this.event(c,m,cancelling?'cancelling':'blocked',cancelling?'stopping':'reconciling','lease_expired','attempt_stale');
    await this.counter(c,'attempts_stale_total');
    await this.counter(c,'leases_expired_total');
  }
  async scanExpired(): Promise<number> {
    this.gate();
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN'); await c.query('LOCK TABLE agent_missions IN SHARE ROW EXCLUSIVE MODE');
      const r = await c.query(`SELECT a.*,a.deadline_at<=clock_timestamp() AS deadline_expired FROM mission_attempts a
        JOIN agent_missions m ON m.id=a.mission_id WHERE a.status IN ('queued','claimed','running','completing')
        AND (a.deadline_at<=clock_timestamp() OR a.lease_expires_at<=clock_timestamp())
        AND m.orchestration_version=2 AND m.project=ANY($1::text[]) ORDER BY a.created_at,a.id`,[[...this.config.projects]]);
      for (const row of r.rows) await this.expire(c,attemptRow(row),await this.mission(c,row.mission_id),row.deadline_expired);
      await c.query('COMMIT'); return r.rows.length;
    } catch (e) { await c.query('ROLLBACK').catch(()=>undefined); if (e instanceof MissionError) throw e; throw new MissionError('execution_storage_unavailable',503); }
    finally { c.release(); }
  }
  async cancel(id: string,meta: Mutation): Promise<ExecutionMission> {
    return this.transact(meta,{op:'cancel',id},async c => {
      const m = await this.mission(c,id);
      if (terminalMissions.includes(m.lifecycle_state)) throw new MissionError('mission_terminal');
      if (['cancel_requested','cancelling'].includes(m.lifecycle_state)) return m;
      await this.counter(c,'cancellations_total');
      const requested = await this.event(c,m,'cancel_requested','stopping',null,'cancel_requested');
      if (!m.current_attempt_id) {
        const stopping = await this.event(c,requested,'cancelling','stopping',null,'cancelling');
        return this.event(c,stopping,'cancelled','finished',null,'cancelled');
      }
      return requested;
    });
  }
  async reconcile(id: string,proof: {kind:'stopped'|'unknown';worker_instance_id:string;fencing_token:string},meta: Mutation): Promise<Attempt> {
    const parsed = z.object({kind:z.enum(['stopped','unknown']),worker_instance_id:identity,fencing_token:z.string().regex(/^[1-9][0-9]{0,18}$/)}).strict().safeParse(proof);
    if (!parsed.success) throw new MissionError('invalid_stop_proof',400);
    return this.transact(meta,{op:'reconcile',id,proof},async c => {
      const a = await this.attempt(c,id); const m = await this.mission(c,a.mission_id);
      if (m.current_attempt_id !== id) throw new MissionError('attempt_not_current');
      if (a.worker_instance_id !== proof.worker_instance_id || !this.config.workerIds.has(proof.worker_instance_id)) throw new MissionError('wrong_worker',403);
      if (a.fencing_token !== proof.fencing_token) throw new MissionError('fencing_rejected');
      const cancelling = ['cancel_requested','cancelling'].includes(m.lifecycle_state);
      if (!cancelling && a.status !== 'stale') throw new MissionError('reconciliation_not_required');
      if (!cancelling && a.reconciled_at && a.stop_proof_at) return a;
      if (proof.kind === 'unknown' && !(a.stop_proof_at && ['completed','failed','cancelled','stale'].includes(a.status))) {
        await c.query(`UPDATE worktree_leases SET status='quarantined' WHERE attempt_id=$1 AND status<>'released'`,[id]);
        if (m.blocked_reason !== 'stop_unconfirmed' || m.lifecycle_state !== (cancelling?'cancelling':'blocked'))
          await this.event(c,m,cancelling?'cancelling':'blocked',cancelling?'stopping':'reconciling','stop_unconfirmed',cancelling?'cancelling':'reconciled');
        return a;
      }
      if (cancelling && ['completed','failed','cancelled','stale'].includes(a.status) && a.stop_proof_at) {
        const stopping = await this.event(c,m,'cancelling','stopping',null,'cancelling');
        await this.event(c,stopping,'cancelled','finished',null,'cancelled');
        return a;
      }
      const r = await c.query(`UPDATE mission_attempts SET status=$2,reconciled_at=clock_timestamp(),stop_proof_at=clock_timestamp(),
        completed_at=COALESCE(completed_at,clock_timestamp()),updated_at=clock_timestamp(),lease_expires_at=NULL WHERE id=$1 RETURNING *`,[id,cancelling?'cancelled':'stale']);
      await this.release(c,a,cancelling);
      const stoppedMission = cancelling ? await this.event(c,m,'cancelling','stopping',null,'cancelling') : m;
      await this.event(c,stoppedMission,cancelling?'cancelled':'retry_wait',cancelling?'finished':'reconciling',cancelling?null:'lease_expired',cancelling?'cancelled':'reconciled');
      return attemptRow(r.rows[0]);
    });
  }
  async retry(id: string,meta: Mutation,input?: QueueOptions): Promise<Attempt> {
    const options = input === undefined ? undefined : this.parseOptions(input);
    return this.transact(meta,{op:'retry',id,options},async c => {
      const m = await this.mission(c,id);
      if (!m.current_attempt_id || !['retry_wait','blocked'].includes(m.lifecycle_state)) throw new MissionError('retry_not_permitted');
      const previous = await this.attempt(c,m.current_attempt_id);
      if (!previous.retryable || !['failed','stale'].includes(previous.status) || !previous.stop_proof_at || !previous.reconciled_at) throw new MissionError('retry_requires_stop_proof');
      if(previous.worker_type==='codex'){
        const policy=await c.query('SELECT max_attempts FROM codex_attempt_metadata WHERE attempt_id=$1',[previous.id]);
        if(!policy.rows[0]||previous.attempt_number>=Number(policy.rows[0].max_attempts))throw new MissionError('max_attempts_exhausted');}
      let nextOptions = options;
      if (!nextOptions && previous.worker_type === 'codex') throw new MissionError('codex_retry_requires_new_workspace');
      if (!nextOptions) {
        const w = (await c.query('SELECT * FROM worktree_leases WHERE attempt_id=$1',[previous.id])).rows[0];
        const b = (await c.query('SELECT * FROM budget_reservations WHERE attempt_id=$1',[previous.id])).rows[0];
        nextOptions = this.parseOptions({worker_instance_id:previous.worker_instance_id,worker_type:previous.worker_type,payload_hash:previous.execution_payload_hash,
          head_sha:previous.head_sha ?? undefined,approval_required:previous.approval_required,
          workspace:w ? {repo:w.repo,base_sha:w.base_sha,branch:`${w.branch}/attempt-${previous.attempt_number+1}`,
            worktree_path:`${w.worktree_path}/attempt-${previous.attempt_number+1}`} : undefined,
          budget:b ? {max_amount:Number(b.max_amount),reserved_amount:Number(b.reserved_amount),currency:'FAKE'} : undefined});
      }
      if (previous.approval_required && nextOptions.approval_required === false) throw new MissionError('approval_policy_immutable');
      nextOptions = {...nextOptions,approval_required:previous.approval_required || nextOptions.approval_required};
      // A retry may prepare a queued attempt; its new approval binding is checked at claim.
      return this.create(c,m,nextOptions,true);
    });
  }
  async bindApproval(id: string,attemptId: string,input: {action_id:string;action_type:string;payload_hash:string;head_sha?:string},meta: Mutation): Promise<Attempt> {
    const parsed = z.object({action_id:z.string().uuid(),action_type:z.enum(['execute','review']),payload_hash:hash,head_sha:sha.optional()}).strict().safeParse(input);
    if (!parsed.success) throw new MissionError('invalid_approval_binding',400);
    const binding = parsed.data;
    return this.transact(meta,{op:'bind_approval',id,attemptId,binding},async c => {
      const m = await this.mission(c,id); const a = await this.attempt(c,attemptId);
      if (a.mission_id !== id || m.current_attempt_id !== a.id) throw new MissionError('attempt_not_current');
      this.assertBinding(m,a,binding.action_type === 'execute');
      const expectedHead = binding.action_type === 'review' ? m.head_sha : a.head_sha;
      if (binding.payload_hash !== approvalPayloadHash(a,binding.action_type,expectedHead) || (binding.head_sha ?? null) !== expectedHead) throw new MissionError('approval_binding_mismatch');
      const r = await c.query(`SELECT LEAST(x.approval_expires_at,p.expires_at) AS expires_at FROM agent_actions x
        JOIN agent_approvals p ON p.action_id=x.id WHERE x.id=$1 AND x.intent=$2 AND x.payload_hash=$3 AND x.status='approved'
        AND x.approval_expires_at>clock_timestamp() AND p.payload_hash=$3 AND p.decision='approved' AND p.expires_at>clock_timestamp()
        AND p.approver='human-admin' AND p.decided_at >= $4 ORDER BY p.expires_at DESC LIMIT 1 FOR SHARE OF x,p`,[binding.action_id,binding.action_type,binding.payload_hash,a.created_at]);
      if (!r.rows[0]) throw new MissionError('approval_invalid');
      const fresh = await c.query('SELECT $1::timestamptz>clock_timestamp() AS valid',[r.rows[0].expires_at]);
      if (!fresh.rows[0].valid) throw new MissionError('approval_invalid');
      const oldBinding = await c.query(`SELECT 1 FROM mission_approval_bindings WHERE action_id=$1
        AND (attempt_id<>$2 OR action_type<>$3 OR payload_hash<>$4 OR head_sha IS DISTINCT FROM $5::text) LIMIT 1`,
        [binding.action_id,a.id,binding.action_type,binding.payload_hash,expectedHead]);
      if (oldBinding.rowCount) throw new MissionError('approval_already_bound');
      await c.query(`INSERT INTO mission_approval_bindings(mission_id,attempt_id,action_id,action_type,payload_hash,head_sha,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,a.id,binding.action_id,binding.action_type,binding.payload_hash,expectedHead,r.rows[0].expires_at]);
      await this.event(c,m,m.lifecycle_state,m.phase,m.blocked_reason,'approval_bound');
      return a;
    });
  }
  async review(id: string,to:'awaiting_nadir_approval'|'completed',meta: Mutation): Promise<ExecutionMission> {
    if (!['awaiting_nadir_approval','completed'].includes(to)) throw new MissionError('invalid_review_transition',400);
    return this.transact(meta,{op:'review',id,to},async c => {
      const m = await this.mission(c,id);
      if (!m.current_attempt_id) throw new MissionError('attempt_not_found',404);
      const a = await this.attempt(c,m.current_attempt_id);
      this.assertBinding(m,a);
      if (a.status !== 'completed') throw new MissionError('attempt_not_completed');
      if ((to === 'awaiting_nadir_approval' && m.lifecycle_state !== 'reviewing') ||
          (to === 'completed' && m.lifecycle_state !== 'awaiting_nadir_approval')) throw new MissionError('invalid_review_transition');
      if (to === 'completed' && !await this.approvalValid(c,a,'review',m.head_sha,true)) throw new MissionError('approval_invalid');
      return this.event(c,m,to,to === 'completed'?'finished':'waiting_approval',null,'reviewed');
    });
  }
  async recordMergeEvidence(id: string,dependencyId: string,headSha: string,meta: Mutation): Promise<ExecutionMission> {
    if (!sha.safeParse(headSha).success) throw new MissionError('invalid_merge_evidence',400);
    return this.transact(meta,{op:'merge_evidence',id,dependencyId,headSha},async c => {
      const m = await this.mission(c,id); const dependency = await this.mission(c,dependencyId);
      if (dependency.project !== m.project || dependency.lifecycle_state !== 'completed' || dependency.head_sha !== headSha) throw new MissionError('invalid_merge_evidence');
      const r = await c.query(`INSERT INTO mission_dependency_evidence(mission_id,depends_on_id,plan_version,head_sha,kind,recorded_by)
        SELECT mission_id,depends_on_id,plan_version,$3,'human_merge',$4 FROM mission_dependencies
        WHERE mission_id=$1 AND depends_on_id=$2 AND dependency_type='human_merge' AND reference=$3 RETURNING id`,[id,dependencyId,headSha,meta.principal]);
      if (!r.rowCount) throw new MissionError('invalid_merge_evidence');
      return this.event(c,m);
    });
  }
  async pendingReconciliation(): Promise<Array<Attempt & {mission_state:State}>> {
    this.gate();
    const r = await this.pool.query(`SELECT a.*,m.lifecycle_state AS mission_state FROM mission_attempts a JOIN agent_missions m ON m.id=a.mission_id
      WHERE m.current_attempt_id=a.id AND m.orchestration_version=2 AND m.project=ANY($1::text[])
      AND ((a.status='stale' AND a.reconciled_at IS NULL) OR m.lifecycle_state IN ('cancel_requested','cancelling')) ORDER BY a.created_at,a.id`,[[...this.config.projects]]);
    return r.rows.map(r => ({...attemptRow(r),mission_state:r.mission_state}));
  }
  private async statusTx(c: Pick<PoolClient,'query'>,id: string) {
    const m = await this.mission(c,id);
    const a = m.current_attempt_id ? await this.attempt(c,m.current_attempt_id) : null;
    const timing = a ? (await c.query(`SELECT CASE WHEN lease_expires_at IS NULL THEN 'none' WHEN lease_expires_at<=clock_timestamp()
      THEN 'expired' ELSE 'valid' END AS lease_status,EXTRACT(EPOCH FROM clock_timestamp()-heartbeat_at)::double precision AS heartbeat_age
      FROM mission_attempts WHERE id=$1`,[a.id])).rows[0] : {lease_status:'none',heartbeat_age:null};
    const dependencies = (await c.query(`SELECT d.depends_on_id,d.dependency_type,d.reference,d.plan_version,m.lifecycle_state,m.head_sha
      FROM mission_dependencies d JOIN agent_missions m ON m.id=d.depends_on_id WHERE d.mission_id=$1 ORDER BY d.plan_version,d.depends_on_id`,[id])).rows;
    const budget = a ? (await c.query('SELECT provider,currency,max_amount,reserved_amount,consumed_amount,status FROM budget_reservations WHERE attempt_id=$1',[a.id])).rows[0] ?? null : null;
    const workspace = a ? (await c.query('SELECT repo,base_sha,branch,status FROM worktree_leases WHERE attempt_id=$1',[a.id])).rows[0] ?? null : null;
    const reviewPhase = ['reviewing','awaiting_nadir_approval','completed'].includes(m.lifecycle_state);
    const approval = a ? await this.approvalState(c,m,a,reviewPhase?'review':'execute',reviewPhase?m.head_sha:a.head_sha) : 'not_required';
    const codexTable = (await c.query("SELECT to_regclass('public.codex_attempt_metadata') AS name")).rows[0]?.name;
    const codex = a && codexTable ? (await c.query(`SELECT adapter_version,contract_version,max_attempts,auth_mode,billing_mode,quota_source,quota_state,
      quota_checked_at,workspace_id,canonical_path,validation_state,publisher_state,provider_session_present,result_hash,process_id,cgroup_name
      FROM codex_attempt_metadata WHERE attempt_id=$1`,[a.id])).rows[0] ?? null : null;
    return {...m,mission_state:m.lifecycle_state,active_attempt:a,attempt_number:a?.attempt_number ?? null,assigned_worker:a?.worker_instance_id ?? null,
      ...timing,dependencies,budget,budget_state:budget?.status ?? 'missing',
      budget_reservation_state:budget?.status ?? 'missing',...(codex?{quota_source:codex.quota_source,quota_state:codex.quota_state,quota_checked_at:codex.quota_checked_at}:unknownProviderQuota),
      agent:a?.worker_type ?? null,adapter_version:codex?.adapter_version ?? null,auth_mode:codex?.auth_mode ?? null,
      billing_mode:codex?.billing_mode ?? null,deadline:a?.deadline_at ?? null,workspace_state:workspace?.status ?? 'missing',
      validation_state:codex?.validation_state ?? null,publisher_state:codex?.publisher_state ?? null,
      provider_session_present:codex?.provider_session_present ?? false,codex,
      approval_state:approval};
  }
  private async snapshot<T>(run:(c:PoolClient)=>Promise<T>): Promise<T> {
    this.gate(); const c = await this.pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = await run(c); await c.query('COMMIT'); return result;
    } catch (error) { await c.query('ROLLBACK').catch(()=>undefined); if (error instanceof MissionError) throw error; throw new MissionError('execution_storage_unavailable',503); }
    finally { c.release(); }
  }
  async status(id: string) { return this.snapshot(c=>this.statusTx(c,id)); }
  async statusProject(project: string) {
    this.gate(project);
    return this.snapshot(async c => {
      const r = await c.query(`SELECT id FROM agent_missions WHERE orchestration_version=2 AND project=$1 ORDER BY created_at DESC,id LIMIT 100`,[project]);
      const rows = [];
      for (const row of r.rows) rows.push(await this.statusTx(c,row.id));
      return rows;
    });
  }
  async metrics(): Promise<Record<string,number>> {
    this.gate();
    const result: Record<string,number> = Object.fromEntries(['attempts_created_total','attempts_running','attempts_stale_total','leases_expired_total',
      'callbacks_rejected_total','fencing_rejections_total','cancellations_total','retries_total','budget_reservations_active','dependency_blocks_total',
      'codex_attempts_total','codex_attempts_running','codex_attempts_failed_total','codex_timeouts_total','codex_cancellations_total',
      'codex_output_invalid_total','codex_validation_failures_total','codex_publish_requests_total','codex_publish_failures_total'].map(k=>[k,0]));
    const r = await this.pool.query('SELECT name,value FROM execution_metrics ORDER BY name');
    for (const row of r.rows) if (row.name in result) result[row.name] = Number(row.value);
    result.attempts_running = Number((await this.pool.query(`SELECT count(*) FROM mission_attempts WHERE status IN ('claimed','running','completing')`)).rows[0].count);
    result.budget_reservations_active = Number((await this.pool.query(`SELECT count(*) FROM budget_reservations WHERE status IN ('reserved','consuming','exhausted')`)).rows[0].count);
    if ((await this.pool.query("SELECT to_regclass('public.codex_attempt_metadata') AS name")).rows[0]?.name) {
      result.codex_attempts_running = Number((await this.pool.query(`SELECT count(*) FROM mission_attempts WHERE worker_type='codex' AND status IN ('claimed','running','completing')`)).rows[0].count);
    }
    return result;
  }
}

export type ExecutionStatus = Awaited<ReturnType<ExecutionControl['status']>>;
