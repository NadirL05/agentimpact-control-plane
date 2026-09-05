import { randomUUID } from 'node:crypto';
import { MissionError } from './model.js';
import { ExecutionControl, type Attempt, type Completion, type WorkerProof } from './execution.js';
import type { Mutation } from './store.js';

const mutation = (worker: string): Mutation => ({principal:worker,key:randomUUID()});
export const workerProof = (a: Attempt): WorkerProof => ({attempt_id:a.id,worker_instance_id:a.worker_instance_id,fencing_token:a.fencing_token});
type Session = {proof:WorkerProof;state:'claimed'|'running'|'stopped'|'unknown';acceptedCompletion?:boolean};

/** An in-memory test double. No process, provider, filesystem or timer is started. */
export class FakeWorker {
  private sessions = new Map<string,Session>();
  constructor(private control: ExecutionControl,readonly id: string) {
    if (!/^fake-[A-Za-z0-9_.:-]+$/.test(id)) throw new MissionError('worker_not_allowed',403);
  }
  async claim(a: Attempt): Promise<WorkerProof> {
    const proof = workerProof(a);
    await this.control.claim(a.id,this.id,proof,mutation(this.id));
    this.sessions.set(a.id,{proof,state:'claimed'});
    return proof;
  }
  private session(proof: WorkerProof): Session {
    const session = this.sessions.get(proof.attempt_id);
    if (!session || session.proof.fencing_token !== proof.fencing_token || proof.worker_instance_id !== this.id)
      throw new MissionError('fake_session_unknown');
    return session;
  }
  async start(proof: WorkerProof): Promise<Attempt> {
    const session = this.session(proof);
    if (session.state !== 'claimed') throw new MissionError('fake_not_claimed');
    const result = await this.control.start(proof,this.id,mutation(this.id));
    session.state = 'running'; return result;
  }
  async heartbeat(proof: WorkerProof): Promise<Attempt> {
    const session = this.session(proof);
    if (!['claimed','running'].includes(session.state)) throw new MissionError('fake_not_running');
    return this.control.heartbeat(proof,this.id,mutation(this.id));
  }
  async progress(proof: WorkerProof,phase:'preparing'|'executing'|'validating'): Promise<Attempt> {
    if (this.session(proof).state !== 'running') throw new MissionError('fake_not_running');
    return this.control.progress(proof,this.id,{phase},mutation(this.id));
  }
  async complete(proof: WorkerProof,result:Completion,meta = mutation(this.id)): Promise<Attempt> {
    const session = this.session(proof);
    if (session.state !== 'running' && !session.acceptedCompletion) throw new MissionError('fake_not_running');
    const completed = await this.control.complete(proof,this.id,result,meta);
    session.state = 'stopped'; session.acceptedCompletion = true; return completed;
  }
  crash(proof: WorkerProof): void { const session = this.session(proof); session.state = 'stopped'; session.acceptedCompletion = false; }
  setStopUnknown(proof: WorkerProof): void { const session = this.session(proof); session.state = 'unknown'; session.acceptedCompletion = false; }
  stop(proof: WorkerProof): 'stopped'|'unknown' {
    const session = this.sessions.get(proof.attempt_id);
    if (!session || session.proof.worker_instance_id !== proof.worker_instance_id || session.proof.fencing_token !== proof.fencing_token || session.state === 'unknown') return 'unknown';
    session.state = 'stopped'; return 'stopped';
  }
}

/** Explicit ticks make recovery tests deterministic. A new supervisor discovers
 * current ownership in PostgreSQL; lost process knowledge never means success. */
export class FakeSupervisor {
  private workers: Map<string,FakeWorker>;
  constructor(private control: ExecutionControl,workers: Iterable<FakeWorker>) {
    this.workers = new Map([...workers].map(worker=>[worker.id,worker]));
  }
  async tick(): Promise<{expired:number;reconciled:number;unknown:number}> {
    const expired = await this.control.scanExpired();
    const pending = await this.control.pendingReconciliation();
    let reconciled = 0,unknown = 0;
    for (const attempt of pending) {
      const proof = workerProof(attempt);
      // A queued generation has never been offered execution. Durable absence
      // of claim, or an already accepted stop proof, is sufficient evidence.
      const neverClaimed = !attempt.heartbeat_at && !attempt.started_at;
      const kind = attempt.stop_proof_at || neverClaimed ? 'stopped' : this.workers.get(attempt.worker_instance_id)?.stop(proof) ?? 'unknown';
      try {
        await this.control.reconcile(attempt.id,{kind,worker_instance_id:proof.worker_instance_id,fencing_token:proof.fencing_token},mutation('fake-supervisor'));
        if (kind === 'stopped') reconciled++; else unknown++;
      } catch (error) {
        // A concurrent supervisor/control mutation can supersede this snapshot.
        // Re-read on the next explicit tick; never infer a successful execution.
        if (!(error instanceof MissionError) || !['attempt_not_current','reconciliation_not_required','mission_terminal'].includes(error.code)) throw error;
      }
    }
    return {expired,reconciled,unknown};
  }
}
