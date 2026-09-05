import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalPayload, approvalPayloadHash, canonicalWorkspacePath, ExecutionControl } from './execution.js';
import { FakeSupervisor, FakeWorker } from './supervisor.js';
import { MissionStore } from './store.js';
import { digest } from './model.js';
import { fakePlanner } from './testing/fakes.js';
import {
  executionDatabase, executionTestConfig, readyMission, testExecutionOptions, testMutation,
} from './testing/execution-database.js';

let fixture: Awaited<ReturnType<typeof executionDatabase>>;
let execution: ExecutionControl;
let store: MissionStore;
const worker = 'fake-worker-1';
const proof = (attempt: {id: string; worker_instance_id: string; fencing_token: string}) => ({
  attempt_id: attempt.id, worker_instance_id: attempt.worker_instance_id, fencing_token: attempt.fencing_token,
});
async function queued() {
  const mission = await readyMission(fixture.pool);
  const attempt = await execution.queue(mission.id, testMutation(), testExecutionOptions());
  return {mission, attempt, proof: proof(attempt)};
}
async function running() {
  const value = await queued();
  await execution.claim(value.attempt.id, worker, value.proof, testMutation());
  await execution.start(value.proof, worker, testMutation());
  return value;
}
async function expire(attemptId: string) {
  await fixture.db.query("UPDATE mission_attempts SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [attemptId]);
}
async function approval(actionType: string, payloadHash: string, expired = false) {
  const action = await fixture.db.query<{id: string}>(
    `INSERT INTO agent_actions(intent,status,payload_hash,approval_expires_at)
     VALUES($1,'approved',$2,clock_timestamp()+interval '1 hour') RETURNING id`, [actionType, payloadHash]);
  await fixture.db.query(
    `INSERT INTO agent_approvals(action_id,decision,payload_hash,approver,expires_at)
     VALUES($1,'approved',$2,'human-admin',clock_timestamp()+$3::interval)`,
    [action.rows[0].id, payloadHash, expired ? '-1 second' : '1 hour']);
  return action.rows[0].id;
}

beforeAll(async () => {
  fixture = await executionDatabase();
  execution = new ExecutionControl(fixture.pool, executionTestConfig);
  store = new MissionStore(fixture.pool, executionTestConfig);
}, 30000);
afterAll(async () => { await fixture?.db.close(); });

describe('V2-F isolated PostgreSQL execution control', () => {
  it('fails closed with the V2 flag disabled', async () => {
    const mission = await readyMission(fixture.pool);
    const disabled = new ExecutionControl(fixture.pool, {...executionTestConfig, enabled: false});
    await expect(disabled.queue(mission.id, testMutation(), testExecutionOptions())).rejects.toMatchObject({code: 'v2_disabled'});
    expect((await fixture.db.query('SELECT id FROM mission_attempts WHERE mission_id=$1', [mission.id])).rows).toHaveLength(0);
  });

  it('retains exactly one active attempt when two queue requests compete', async () => {
    const mission = await readyMission(fixture.pool);
    const results = await Promise.allSettled([
      execution.queue(mission.id, testMutation(), testExecutionOptions()),
      execution.queue(mission.id, testMutation(), testExecutionOptions()),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect((await fixture.db.query('SELECT attempt_number,status FROM mission_attempts WHERE mission_id=$1', [mission.id])).rows)
      .toEqual([{attempt_number: 1, status: 'queued'}]);
  });

  it('renews a lease only with the owner and the current fence', async () => {
    const item = await running();
    await expect(execution.heartbeat(item.proof, worker, testMutation())).resolves.toMatchObject({id: item.attempt.id});
    const lease = await fixture.db.query<{valid: boolean; heartbeat: boolean}>(
      'SELECT lease_expires_at>clock_timestamp() AS valid,heartbeat_at IS NOT NULL AS heartbeat FROM mission_attempts WHERE id=$1', [item.attempt.id]);
    expect(lease.rows).toEqual([{valid: true, heartbeat: true}]);
    await expect(execution.heartbeat(item.proof, 'fake-worker-2', testMutation())).rejects.toThrow();
    await expect(execution.heartbeat({...item.proof, worker_instance_id: 'fake-worker-2'}, worker, testMutation())).rejects.toThrow();
    await expect(execution.heartbeat({...item.proof, fencing_token: '0'}, worker, testMutation())).rejects.toThrow();
    expect((await store.get(item.mission.id)).lifecycle_state).toBe('running');
  });

  it('keeps execution ownership out of the foundation transition and planner paths', async () => {
    const item = await queued();
    const current = await store.get(item.mission.id);
    await expect(store.transition(current.id, current.state_version, 'planning', testMutation()))
      .rejects.toMatchObject({code: 'execution_control_required'});
    await expect(store.savePlan(current.id, current.state_version, fakePlanner(), testMutation()))
      .rejects.toMatchObject({code: 'execution_control_required'});
    await expect(execution.progress(item.proof, worker, {phase: 'executing'}, testMutation())).rejects.toThrow();
    await execution.claim(item.attempt.id, worker, item.proof, testMutation());
    await execution.start(item.proof, worker, testMutation());
    await execution.progress(item.proof, worker, {phase: 'validating'}, testMutation());
    expect((await fixture.db.query('SELECT phase FROM agent_missions WHERE id=$1', [current.id])).rows).toEqual([{phase: 'validating'}]);
  });

  it('rejects unknown provider and non-fake workspace inputs before admission', async () => {
    const mission = await readyMission(fixture.pool);
    await expect(execution.queue(mission.id, testMutation(), {...testExecutionOptions(), worker_instance_id: 'real-worker'})).rejects.toThrow();
    const options = testExecutionOptions();
    await expect(execution.queue(mission.id, testMutation(), {...options, workspace: {...options.workspace, worktree_path: '/opt/production'}})).rejects.toThrow();
    expect((await fixture.db.query('SELECT id FROM mission_attempts WHERE mission_id=$1', [mission.id])).rows).toHaveLength(0);
  });

  it('canonicalizes fake workspace paths before reservation and rejects lexical escape', async () => {
    expect(canonicalWorkspacePath('/fake/job/.').canonical_path).toBe('/fake/job');
    expect(canonicalWorkspacePath('/fake//job').canonical_path).toBe('/fake/job');
    expect(canonicalWorkspacePath('/fake/a/../job').canonical_path).toBe('/fake/job');
    expect(() => canonicalWorkspacePath('/fake/job/../../etc')).toThrow();
    expect(() => canonicalWorkspacePath('fake/job')).toThrow();

    const suffix = randomUUID(), first = await readyMission(fixture.pool), second = await readyMission(fixture.pool);
    const firstOptions = testExecutionOptions(), secondOptions = testExecutionOptions();
    firstOptions.workspace.worktree_path = `/fake/${suffix}/.`;
    secondOptions.workspace.worktree_path = `/fake//${suffix}`;
    await execution.queue(first.id, testMutation(), firstOptions);
    await expect(execution.queue(second.id, testMutation(), secondOptions)).rejects.toMatchObject({code: 'execution_ownership_conflict'});
    expect((await fixture.db.query('SELECT worktree_path FROM worktree_leases WHERE mission_id=$1',[first.id])).rows)
      .toEqual([{worktree_path:`/fake/${suffix}`}]);
  });

  it('refuses to claim without a budget reservation', async () => {
    const mission = await readyMission(fixture.pool);
    const options = testExecutionOptions();
    const attempt = await execution.queue(mission.id, testMutation(), {workspace: options.workspace, worker_instance_id: options.worker_instance_id});
    await expect(execution.claim(attempt.id, worker, proof(attempt), testMutation())).rejects.toThrow();
    expect((await store.get(mission.id)).lifecycle_state).not.toBe('running');
  });

  it('refuses an exhausted reservation and an unknown quota', async () => {
    const item = await queued();
    await fixture.db.query("UPDATE budget_reservations SET status='exhausted',consumed_amount=reserved_amount WHERE attempt_id=$1", [item.attempt.id]);
    await expect(execution.claim(item.attempt.id, worker, item.proof, testMutation())).rejects.toThrow();
    const unknown = new ExecutionControl(fixture.pool, {...executionTestConfig, quotaAmount: null});
    const other = await readyMission(fixture.pool);
    await expect(unknown.queue(other.id, testMutation(), testExecutionOptions())).rejects.toThrow();
    expect((await fixture.db.query('SELECT id FROM mission_attempts WHERE mission_id=$1', [other.id])).rows).toHaveLength(0);
  });

  it.each(['worktree_path', 'branch'] as const)('rejects competing %s ownership without partial attempt admission', async field => {
    const first = await queued();
    const lease = await fixture.db.query<Record<string, string>>('SELECT worktree_path,branch FROM worktree_leases WHERE attempt_id=$1', [first.attempt.id]);
    const second = await readyMission(fixture.pool);
    const options = testExecutionOptions();
    options.workspace[field] = lease.rows[0][field];
    await expect(execution.queue(second.id, testMutation(), options)).rejects.toThrow();
    expect((await fixture.db.query('SELECT id FROM mission_attempts WHERE mission_id=$1', [second.id])).rows).toHaveLength(0);
  });

  it.each(['ready', 'failed_permanent', 'cancelled'] as const)('blocks a %s dependency and persists its blocked reason', async dependencyState => {
    const prerequisite = await readyMission(fixture.pool);
    if (dependencyState !== 'ready') {
      await fixture.db.query('UPDATE agent_missions SET lifecycle_state=$2 WHERE id=$1', [prerequisite.id, dependencyState]);
    }
    const child = await readyMission(fixture.pool, [{mission_id: prerequisite.id, type: 'artifact'}]);
    await expect(execution.queue(child.id, testMutation(), testExecutionOptions())).rejects.toThrow();
    const state = await fixture.db.query<{lifecycle_state: string; blocked_reason: string | null}>(
      'SELECT lifecycle_state,blocked_reason FROM agent_missions WHERE id=$1', [child.id]);
    expect(state.rows[0].lifecycle_state).toBe('blocked');
    expect(state.rows[0].blocked_reason).toBeTruthy();
    expect((await fixture.db.query('SELECT id FROM mission_attempts WHERE mission_id=$1', [child.id])).rows).toHaveLength(0);
  });

  it('revalidates completed Git dependency head against the requested base', async () => {
    const prerequisite = await readyMission(fixture.pool);
    await fixture.db.query("UPDATE agent_missions SET lifecycle_state='completed',head_sha=$2 WHERE id=$1", [prerequisite.id, 'b'.repeat(40)]);
    const child = await readyMission(fixture.pool, [{mission_id: prerequisite.id, type: 'commit', reference: 'b'.repeat(40)}]);
    const options = testExecutionOptions();
    await expect(execution.queue(child.id, testMutation(), options)).rejects.toThrow();
    options.workspace.base_sha = 'b'.repeat(40);
    const attempt = await execution.queue(child.id, testMutation(), options);
    await expect(execution.claim(attempt.id, worker, proof(attempt), testMutation())).resolves.toMatchObject({id: attempt.id});
  });

  it('rejects callbacks immediately after expiry and scans stale only once', async () => {
    const item = await running();
    await expire(item.attempt.id);
    await expect(execution.complete(item.proof, worker, {outcome: 'completed'}, testMutation())).rejects.toThrow();
    // An expired callback may itself durably mark the generation stale.
    await execution.scanExpired();
    expect((await fixture.db.query('SELECT status FROM mission_attempts WHERE id=$1', [item.attempt.id])).rows).toEqual([{status: 'stale'}]);
    const eventsBefore = await store.events(item.mission.id);
    await execution.scanExpired();
    expect(await store.events(item.mission.id)).toEqual(eventsBefore);
    await expect(execution.heartbeat(item.proof, worker, testMutation())).rejects.toThrow();
  });

  it('quarantines a stale workspace until owner-specific stop reconciliation', async () => {
    const item = await running();
    const lease = await fixture.db.query<Record<string, string>>('SELECT repo,base_sha,branch,worktree_path FROM worktree_leases WHERE attempt_id=$1', [item.attempt.id]);
    await expire(item.attempt.id);
    await execution.scanExpired();
    await expect(execution.retry(item.mission.id, testMutation(), testExecutionOptions())).rejects.toThrow();
    const other = await readyMission(fixture.pool);
    const options = {...testExecutionOptions(), workspace: lease.rows[0] as ReturnType<typeof testExecutionOptions>['workspace']};
    await expect(execution.queue(other.id, testMutation(), options)).rejects.toThrow();
    await execution.reconcile(item.attempt.id, {kind: 'unknown', worker_instance_id: worker, fencing_token: item.proof.fencing_token}, testMutation());
    await expect(execution.queue(other.id, testMutation(), options)).rejects.toThrow();
    await expect(execution.reconcile(item.attempt.id, {kind: 'stopped', worker_instance_id: 'fake-worker-2', fencing_token: item.proof.fencing_token}, testMutation())).rejects.toThrow();
    await execution.reconcile(item.attempt.id, {kind: 'stopped', worker_instance_id: worker, fencing_token: item.proof.fencing_token}, testMutation());
    await expect(execution.queue(other.id, testMutation(), options)).resolves.toMatchObject({mission_id: other.id});
  });

  it('retries with attempt+1 and a larger fence, preserving history and rejecting the previous callback', async () => {
    const first = await running();
    await execution.complete(first.proof, worker, {outcome: 'failed', retryable: true, error_code: 'fake_failure'}, testMutation());
    const next = await execution.retry(first.mission.id, testMutation(), testExecutionOptions());
    expect(next.attempt_number).toBe(2);
    expect(BigInt(next.fencing_token)).toBeGreaterThan(BigInt(first.attempt.fencing_token));
    expect(next.id).not.toBe(first.attempt.id);
    expect((await fixture.db.query('SELECT attempt_number,status FROM mission_attempts WHERE mission_id=$1 ORDER BY attempt_number', [first.mission.id])).rows)
      .toEqual([{attempt_number: 1, status: 'failed'}, {attempt_number: 2, status: 'queued'}]);
    await expect(execution.complete(first.proof, worker, {outcome: 'completed'}, testMutation())).rejects.toThrow();
    await execution.claim(next.id, worker, proof(next), testMutation());
    await execution.start(proof(next), worker, testMutation());
    await expect(execution.heartbeat({...proof(next), fencing_token: first.proof.fencing_token}, worker, testMutation())).rejects.toMatchObject({code: 'fencing_rejected'});
    await expect(execution.complete({...first.proof, attempt_id: next.id}, worker, {outcome: 'completed'}, testMutation())).rejects.toThrow();
    expect((await store.get(first.mission.id)).lifecycle_state).toBe('running');
  });

  it.each(['before_commit', 'after_commit'] as const)('recovers a queue %s fault by replay without creating a second attempt', async fault => {
    const mission = await readyMission(fixture.pool);
    const options = testExecutionOptions(), mutation = testMutation();
    fixture.crash(fault);
    await expect(execution.queue(mission.id, mutation, options)).rejects.toThrow();
    const reconnected = new ExecutionControl(fixture.pool, executionTestConfig);
    const attempt = await reconnected.queue(mission.id, mutation, options);
    expect((await fixture.db.query('SELECT id FROM mission_attempts WHERE mission_id=$1', [mission.id])).rows).toEqual([{id: attempt.id}]);
  });

  it('makes complete idempotent across lost replies and rejects changed payload under the same receipt', async () => {
    const item = await running();
    const mutation = testMutation(), output = {outcome: 'completed' as const, head_sha: 'c'.repeat(40)};
    fixture.crash('after_commit');
    await expect(execution.complete(item.proof, worker, output, mutation)).rejects.toThrow();
    const first = await execution.complete(item.proof, worker, output, mutation);
    expect(await execution.complete(item.proof, worker, output, testMutation())).toMatchObject({id: first.id, status: first.status});
    await expect(execution.complete(item.proof, worker, {...output, head_sha: 'd'.repeat(40)}, mutation)).rejects.toMatchObject({code: 'idempotency_conflict'});
    await expect(execution.complete(item.proof, worker, {...output, head_sha: 'd'.repeat(40)}, testMutation())).rejects.toThrow();
    expect((await store.get(item.mission.id)).lifecycle_state).toBe('reviewing');
  });

  it('runs accepted completion persistence once and in the completion transaction', async () => {
    const item = await running();
    const persist = vi.fn(async () => undefined);
    const output = {outcome: 'completed' as const, head_sha: 'c'.repeat(40)};
    await execution.complete(item.proof, worker, output, testMutation(), persist);
    await execution.complete(item.proof, worker, output, testMutation(), persist);
    expect(persist).toHaveBeenCalledTimes(1);

    const rollback = await running();
    await expect(execution.complete(rollback.proof, worker, output, testMutation(), async () => {
      throw new Error('persist failed');
    })).rejects.toMatchObject({code:'execution_storage_unavailable'});
    expect((await fixture.db.query('SELECT status,callback_hash FROM mission_attempts WHERE id=$1',[rollback.attempt.id])).rows)
      .toEqual([{status:'running',callback_hash:null}]);
  });

  it('durably cancels and retains attempts and leases until positive stop evidence', async () => {
    const item = await running();
    await execution.cancel(item.mission.id, testMutation());
    expect(['cancel_requested', 'cancelling']).toContain((await store.get(item.mission.id)).lifecycle_state);
    const restarted = new ExecutionControl(fixture.pool, executionTestConfig);
    await restarted.reconcile(item.attempt.id, {kind: 'unknown', worker_instance_id: worker, fencing_token: item.proof.fencing_token}, testMutation());
    expect((await store.get(item.mission.id)).lifecycle_state).toBe('cancelling');
    await expect(restarted.complete(item.proof, worker, {outcome: 'completed'}, testMutation())).rejects.toThrow();
    await restarted.reconcile(item.attempt.id, {kind: 'stopped', worker_instance_id: worker, fencing_token: item.proof.fencing_token}, testMutation());
    expect((await store.get(item.mission.id)).lifecycle_state).toBe('cancelled');
    expect((await store.events(item.mission.id)).slice(-2).map(event => event.lifecycle_state)).toEqual(['cancelling', 'cancelled']);
    expect((await fixture.db.query('SELECT status FROM mission_attempts WHERE id=$1', [item.attempt.id])).rows).toEqual([{status: 'cancelled'}]);
    expect((await fixture.db.query('SELECT id FROM worktree_leases WHERE attempt_id=$1', [item.attempt.id])).rows).toHaveLength(1);
    expect((await store.events(item.mission.id)).length).toBeGreaterThan(4);
    await expect(restarted.retry(item.mission.id, testMutation(), testExecutionOptions())).rejects.toThrow();
  });

  it('does not let cancel and complete races produce a completed mission', async () => {
    const item = await running();
    const results = await Promise.allSettled([
      execution.cancel(item.mission.id, testMutation()),
      execution.complete(item.proof, worker, {outcome: 'completed'}, testMutation()),
    ]);
    expect(results.some(result => result.status === 'fulfilled')).toBe(true);
    expect(['cancel_requested', 'cancelling', 'cancelled']).toContain((await store.get(item.mission.id)).lifecycle_state);
    expect((await store.get(item.mission.id)).lifecycle_state).not.toBe('completed');
  });

  it('cancels a mission under review without rewriting the completed attempt history', async () => {
    const item = await running();
    await execution.complete(item.proof, worker, {outcome: 'completed'}, testMutation());
    const before = (await fixture.db.query('SELECT status,completed_at,callback_hash,stop_proof_at FROM mission_attempts WHERE id=$1', [item.attempt.id])).rows[0];
    await execution.cancel(item.mission.id, testMutation());
    await execution.reconcile(item.attempt.id, {kind: 'stopped', worker_instance_id: worker, fencing_token: item.proof.fencing_token}, testMutation());
    expect((await store.get(item.mission.id)).lifecycle_state).toBe('cancelled');
    expect((await fixture.db.query('SELECT status,completed_at,callback_hash,stop_proof_at FROM mission_attempts WHERE id=$1', [item.attempt.id])).rows[0]).toEqual(before);
  });

  it('preserves reconciled stale proof through a late unknown result and subsequent cancellation', async () => {
    const item = await running();
    await expire(item.attempt.id);
    await execution.scanExpired();
    await execution.reconcile(item.attempt.id, {kind: 'stopped', worker_instance_id: worker, fencing_token: item.proof.fencing_token}, testMutation());
    const before = (await fixture.db.query<{status: string}>('SELECT status,completed_at,reconciled_at,stop_proof_at FROM mission_attempts WHERE id=$1', [item.attempt.id])).rows[0];
    const events = await store.events(item.mission.id);
    await execution.reconcile(item.attempt.id, {kind: 'unknown', worker_instance_id: worker, fencing_token: item.proof.fencing_token}, testMutation());
    expect((await store.get(item.mission.id)).lifecycle_state).toBe('retry_wait');
    expect(await store.events(item.mission.id)).toEqual(events);
    await execution.cancel(item.mission.id, testMutation());
    await new FakeSupervisor(new ExecutionControl(fixture.pool, executionTestConfig), []).tick();
    expect((await store.get(item.mission.id)).lifecycle_state).toBe('cancelled');
    expect(before.status).toBe('stale');
    expect((await fixture.db.query('SELECT status,completed_at,reconciled_at,stop_proof_at FROM mission_attempts WHERE id=$1', [item.attempt.id])).rows[0]).toEqual(before);
  });

  it('records the complete cancellation lifecycle when no attempt was ever admitted', async () => {
    const mission = await readyMission(fixture.pool);
    expect((await execution.cancel(mission.id, testMutation())).lifecycle_state).toBe('cancelled');
    const events = await store.events(mission.id);
    expect(events.slice(-3).map(event => event.lifecycle_state)).toEqual(['cancel_requested', 'cancelling', 'cancelled']);
    expect((await fixture.db.query('SELECT id FROM mission_attempts WHERE mission_id=$1', [mission.id])).rows).toHaveLength(0);
    await expect(execution.queue(mission.id, testMutation(), testExecutionOptions())).rejects.toThrow();
  });

  it('uses a fresh fake supervisor to reconcile a crash, then retry and deduplicate completion', async () => {
    const item = await queued();
    const fake = new FakeWorker(execution, worker);
    const identity = await fake.claim(item.attempt);
    await fake.start(identity);
    await fake.heartbeat(identity);
    await fake.progress(identity, 'validating');
    fake.crash(identity);
    await expect(fake.complete(identity, {outcome: 'completed'})).rejects.toMatchObject({code: 'fake_not_running'});
    expect((await store.get(item.mission.id)).lifecycle_state).toBe('running');
    await expire(item.attempt.id);
    const restored = new ExecutionControl(fixture.pool, executionTestConfig);
    const tick = await new FakeSupervisor(restored, [fake]).tick();
    expect(tick.expired).toBeGreaterThanOrEqual(1);
    expect(tick.reconciled).toBeGreaterThanOrEqual(1);
    expect((await store.get(item.mission.id)).lifecycle_state).toBe('retry_wait');
    const retry = await restored.retry(item.mission.id, testMutation(), testExecutionOptions());
    expect(retry.attempt_number).toBe(2);
    await expect(fake.complete(identity, {outcome: 'completed'})).rejects.toThrow();
    const retryProof = await fake.claim(retry);
    await fake.start(retryProof);
    const receipt = testMutation();
    const complete = await fake.complete(retryProof, {outcome: 'completed'}, receipt);
    expect(await fake.complete(retryProof, {outcome: 'completed'}, receipt)).toMatchObject({id: complete.id, status: 'completed'});
    expect((await store.get(item.mission.id)).lifecycle_state).toBe('reviewing');
  });

  it('keeps cancellation uncertain after supervisor restart until the fake proves it stopped', async () => {
    const item = await queued();
    const fake = new FakeWorker(execution, worker), identity = await fake.claim(item.attempt);
    await fake.start(identity);
    fake.setStopUnknown(identity);
    await execution.cancel(item.mission.id, testMutation());
    const restored = new ExecutionControl(fixture.pool, executionTestConfig);
    const emptySupervisor = new FakeSupervisor(restored, [new FakeWorker(restored, worker)]);
    expect((await emptySupervisor.tick()).unknown).toBeGreaterThanOrEqual(1);
    expect((await store.get(item.mission.id)).lifecycle_state).toBe('cancelling');
    expect((await fixture.db.query('SELECT status FROM worktree_leases WHERE attempt_id=$1', [item.attempt.id])).rows).toEqual([{status: 'quarantined'}]);
    await expect(restored.retry(item.mission.id, testMutation(), testExecutionOptions())).rejects.toThrow();
    fake.crash(identity);
    await new FakeSupervisor(restored, [fake]).tick();
    expect((await store.get(item.mission.id)).lifecycle_state).toBe('cancelled');
    expect((await fixture.db.query('SELECT status FROM worktree_leases WHERE attempt_id=$1', [item.attempt.id])).rows).toEqual([{status: 'released'}]);
  });

  it('cancels a never-claimed fake attempt after losing all in-memory worker state', async () => {
    const item = await queued();
    await execution.cancel(item.mission.id, testMutation());
    await new FakeSupervisor(new ExecutionControl(fixture.pool, executionTestConfig), []).tick();
    expect((await store.get(item.mission.id)).lifecycle_state).toBe('cancelled');
    expect((await fixture.db.query('SELECT status,started_at FROM mission_attempts WHERE id=$1', [item.attempt.id])).rows).toEqual([{status: 'cancelled', started_at: null}]);
  });

  it('rejects expired approvals and binds valid approvals to a precise attempt and payload', async () => {
    const mission = await readyMission(fixture.pool);
    const payloadHash = digest({fixture: 'approval'});
    const attempt = await execution.queue(mission.id, testMutation(), {...testExecutionOptions(), payload_hash: payloadHash, approval_required: true});
    const approvedHash = approvalPayloadHash(attempt, 'execute');
    const expired = await approval('execute', approvedHash, true);
    await expect(execution.bindApproval(mission.id, attempt.id, {action_id: expired, action_type: 'execute', payload_hash: approvedHash}, testMutation())).rejects.toThrow();
    await expect(execution.claim(attempt.id, worker, proof(attempt), testMutation())).rejects.toThrow();
    const valid = await approval('execute', approvedHash);
    await expect(execution.bindApproval(mission.id, attempt.id, {action_id: valid, action_type: 'execute', payload_hash: digest({fixture: 'changed'})}, testMutation())).rejects.toThrow();
    await execution.bindApproval(mission.id, attempt.id, {action_id: valid, action_type: 'execute', payload_hash: approvedHash}, testMutation());
    await execution.claim(attempt.id, worker, proof(attempt), testMutation());
    await execution.start(proof(attempt), worker, testMutation());
    await execution.complete(proof(attempt), worker, {outcome: 'failed', retryable: true, error_code: 'fake_failure'}, testMutation());
    const next = await execution.retry(mission.id, testMutation(), {...testExecutionOptions(), payload_hash: payloadHash, approval_required: true});
    await expect(execution.claim(next.id, worker, proof(next), testMutation())).rejects.toThrow();
    await expect(execution.bindApproval(mission.id, next.id, {action_id: valid, action_type: 'execute', payload_hash: approvedHash}, testMutation())).rejects.toThrow();
    expect((await fixture.db.query('SELECT attempt_id FROM mission_approval_bindings WHERE mission_id=$1', [mission.id])).rows).toEqual([{attempt_id: attempt.id}]);
  });

  it('rechecks approval expiry at claim even after a valid durable binding', async () => {
    const mission = await readyMission(fixture.pool);
    const attempt = await execution.queue(mission.id, testMutation(), {...testExecutionOptions(), approval_required: true});
    const hash = approvalPayloadHash(attempt, 'execute'), action = await approval('execute', hash);
    await execution.bindApproval(mission.id, attempt.id, {action_id: action, action_type: 'execute', payload_hash: hash}, testMutation());
    await fixture.db.query("UPDATE agent_approvals SET expires_at=clock_timestamp()-interval '1 second' WHERE action_id=$1", [action]);
    await expect(execution.claim(attempt.id, worker, proof(attempt), testMutation())).rejects.toThrow();
    expect((await store.get(mission.id)).lifecycle_state).toBe('blocked');
    expect((await fixture.db.query('SELECT status FROM mission_attempts WHERE id=$1', [attempt.id])).rows).toEqual([{status: 'queued'}]);
  });

  it('reports approval status from the same current binding and decision invariants as authorization', async () => {
    async function bound() {
      const mission = await readyMission(fixture.pool);
      const attempt = await execution.queue(mission.id,testMutation(),{...testExecutionOptions(),approval_required:true});
      const payloadHash = approvalPayloadHash(attempt,'execute'),action = await approval('execute',payloadHash);
      await execution.bindApproval(mission.id,attempt.id,{action_id:action,action_type:'execute',payload_hash:payloadHash},testMutation());
      return {mission,attempt,action};
    }
    const valid = await bound();
    expect(await execution.status(valid.mission.id)).toMatchObject({approval_state:'valid'});

    const payload = await bound();
    await fixture.db.query('UPDATE agent_missions SET execution_payload_hash=$2 WHERE id=$1',[payload.mission.id,digest({changed:'payload'})]);
    expect(await execution.status(payload.mission.id)).toMatchObject({approval_state:'invalid'});

    const head = await bound();
    await fixture.db.query('UPDATE agent_missions SET head_sha=$2 WHERE id=$1',[head.mission.id,'b'.repeat(40)]);
    expect(await execution.status(head.mission.id)).toMatchObject({approval_state:'invalid'});

    const changedAttempt = await bound();
    await execution.claim(changedAttempt.attempt.id,worker,proof(changedAttempt.attempt),testMutation());
    await execution.start(proof(changedAttempt.attempt),worker,testMutation());
    await execution.complete(proof(changedAttempt.attempt),worker,{outcome:'failed',retryable:true},testMutation());
    await execution.retry(changedAttempt.mission.id,testMutation(),{...testExecutionOptions(),approval_required:true});
    expect(await execution.status(changedAttempt.mission.id)).toMatchObject({approval_state:'invalid'});

    const expired = await bound();
    await fixture.db.query("UPDATE agent_approvals SET expires_at=clock_timestamp()-interval '1 second' WHERE action_id=$1",[expired.action]);
    expect(await execution.status(expired.mission.id)).toMatchObject({approval_state:'invalid'});

    const rejected = await bound();
    await fixture.db.query("UPDATE agent_actions SET status='rejected' WHERE id=$1",[rejected.action]);
    expect(await execution.status(rejected.mission.id)).toMatchObject({approval_state:'invalid'});
  });

  it('exports an approval payload compatible with the existing actions JSON hashing contract', async () => {
    const item = await queued();
    for (const actionType of ['execute', 'review'] as const) {
      const head = actionType === 'review' ? 'd'.repeat(40) : null;
      const payload = approvalPayload(item.attempt, actionType, head);
      const existingActionsHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      expect(existingActionsHash).toBe(approvalPayloadHash(item.attempt, actionType, head));
      expect(payload).toMatchObject({mission_id: item.mission.id, attempt_id: item.attempt.id, head_sha: head});
    }
  });

  it.each(['execution_payload_hash', 'base_sha', 'plan_version', 'head_sha'] as const)(
    'refuses an approved launch when the current mission %s changed after binding', async field => {
      const mission = await readyMission(fixture.pool);
      const attempt = await execution.queue(mission.id, testMutation(), {...testExecutionOptions(), approval_required: true});
      const hash = approvalPayloadHash(attempt, 'execute'), action = await approval('execute', hash);
      await execution.bindApproval(mission.id, attempt.id, {action_id: action, action_type: 'execute', payload_hash: hash}, testMutation());
      const changed = field === 'execution_payload_hash' ? digest({fixture: 'changed execution'}) : field === 'plan_version' ? 2 : 'b'.repeat(40);
      await fixture.db.query(`UPDATE agent_missions SET ${field}=$2 WHERE id=$1`, [mission.id, changed]);
      await expect(execution.claim(attempt.id, worker, proof(attempt), testMutation())).rejects.toMatchObject({code: 'execution_binding_changed'});
      expect((await fixture.db.query('SELECT status FROM mission_attempts WHERE id=$1', [attempt.id])).rows).toEqual([{status: 'queued'}]);
    },
  );

  it.each(['execution_payload_hash', 'head_sha'] as const)(
    'refuses final review when the approved mission %s changed', async field => {
      const item = await running(), head = 'e'.repeat(40);
      await execution.complete(item.proof, worker, {outcome: 'completed', head_sha: head}, testMutation());
      await execution.review(item.mission.id, 'awaiting_nadir_approval', testMutation());
      const hash = approvalPayloadHash(item.attempt, 'review', head), action = await approval('review', hash);
      await execution.bindApproval(item.mission.id, item.attempt.id, {action_id: action, action_type: 'review', payload_hash: hash, head_sha: head}, testMutation());
      await fixture.db.query(`UPDATE agent_missions SET ${field}=$2 WHERE id=$1`,
        [item.mission.id, field === 'head_sha' ? 'f'.repeat(40) : digest({fixture: 'changed execution'})]);
      await expect(execution.review(item.mission.id, 'completed', testMutation())).rejects.toThrow();
      expect((await store.get(item.mission.id)).lifecycle_state).toBe('awaiting_nadir_approval');
    },
  );

  it('keeps worker completion in review until a current-head human approval is bound', async () => {
    const item = await running();
    const head = 'e'.repeat(40);
    await execution.complete(item.proof, worker, {outcome: 'completed', head_sha: head}, testMutation());
    expect(await execution.status(item.mission.id)).toMatchObject({mission_state: 'reviewing', approval_state: 'required'});
    await execution.review(item.mission.id, 'awaiting_nadir_approval', testMutation());
    await expect(execution.review(item.mission.id, 'completed', testMutation())).rejects.toThrow();
    const payloadHash = approvalPayloadHash(item.attempt, 'review', head), action = await approval('review', payloadHash);
    await expect(execution.bindApproval(item.mission.id, item.attempt.id, {action_id: action, action_type: 'review', payload_hash: payloadHash, head_sha: 'f'.repeat(40)}, testMutation())).rejects.toThrow();
    await execution.bindApproval(item.mission.id, item.attempt.id, {action_id: action, action_type: 'review', payload_hash: payloadHash, head_sha: head}, testMutation());
    expect((await execution.review(item.mission.id, 'completed', testMutation())).lifecycle_state).toBe('completed');
    expect(await execution.status(item.mission.id)).toMatchObject({mission_state: 'completed', approval_state: 'valid'});
  });

  it('returns database-backed mission/project status and rejects unknown or V1 missions', async () => {
    const item = await running();
    const status = await execution.status(item.mission.id);
    expect(status).toMatchObject({budget_reservation_state:'consuming',quota_source:'none',quota_state:'UNKNOWN',quota_checked_at:null});
    expect(JSON.stringify(status)).toContain(item.mission.id);
    expect(JSON.stringify(status)).toContain(item.attempt.id);
    expect(JSON.stringify(status)).toContain(worker);
    const stable = (rows: Awaited<ReturnType<ExecutionControl['statusProject']>>) => rows.map(row => ({
      id: row.id, mission_state: row.mission_state, attempt_number: row.attempt_number, assigned_worker: row.assigned_worker,
      budget_state: row.budget_state, approval_state: row.approval_state,
    }));
    expect(stable(await new ExecutionControl(fixture.pool, executionTestConfig).statusProject('IMANE')))
      .toEqual(stable(await execution.statusProject('IMANE')));
    await expect(execution.status(randomUUID())).rejects.toMatchObject({code: 'mission_not_found'});
    const action = await fixture.db.query<{id: string}>('INSERT INTO agent_actions DEFAULT VALUES RETURNING id');
    const legacy = await fixture.db.query<{id: string}>(
      "INSERT INTO agent_missions(action_id,target_agent,source_type,source_id,title) VALUES($1,'dev-senior','test',$2,'Legacy fixture') RETURNING id", [action.rows[0].id, randomUUID()]);
    await expect(execution.queue(legacy.rows[0].id, testMutation(), testExecutionOptions())).rejects.toMatchObject({code: 'wrong_orchestration_version'});
    await expect(execution.status(legacy.rows[0].id)).rejects.toMatchObject({code: 'wrong_orchestration_version'});
    await fixture.db.query("UPDATE agent_missions SET status='in_progress' WHERE id=$1", [legacy.rows[0].id]);
    expect((await fixture.db.query('SELECT status,orchestration_version FROM agent_missions WHERE id=$1', [legacy.rows[0].id])).rows).toEqual([{status: 'in_progress', orchestration_version: 1}]);
  });

  it('preserves counters across controller restarts without mission labels or arbitrary event payloads', async () => {
    const metrics = await execution.metrics();
    expect(await new ExecutionControl(fixture.pool, executionTestConfig).metrics()).toEqual(metrics);
    const serialized = JSON.stringify(metrics);
    for (const name of ['attempts_created_total', 'attempts_running', 'attempts_stale_total', 'leases_expired_total', 'callbacks_rejected_total', 'fencing_rejections_total', 'cancellations_total', 'retries_total', 'budget_reservations_active', 'dependency_blocks_total']) {
      expect(serialized).toContain(name);
    }
    expect(serialized).not.toContain('mission_id');
    const events = await fixture.db.query('SELECT * FROM mission_events');
    expect(JSON.stringify(events.rows)).not.toContain('Validate synthetic execution only');
    expect(JSON.stringify(events.rows)).not.toContain('payload_hash');
    expect(JSON.stringify(events.rows)).not.toContain('provider_session_id');
  });

  it('updates running and reservation gauges through successful fake completion', async () => {
    const before = await execution.metrics();
    const item = await running();
    const active = await execution.metrics();
    expect(active.attempts_created_total).toBe(before.attempts_created_total + 1);
    expect(active.attempts_running).toBe(before.attempts_running + 1);
    expect(active.budget_reservations_active).toBe(before.budget_reservations_active + 1);
    await execution.complete(item.proof, worker, {outcome: 'completed'}, testMutation());
    const complete = await execution.metrics();
    expect(complete.attempts_running).toBe(before.attempts_running);
    expect(complete.budget_reservations_active).toBe(before.budget_reservations_active);
  });
});

it('treats migration 005 as one-shot and rolls back a detected re-run', async () => {
  const isolated = await executionDatabase();
  try {
    const migration = await readFile(new URL('../../migrations/005_v2_execution_control.sql',import.meta.url),'utf8');
    await expect(isolated.db.exec(migration)).rejects.toMatchObject({code:'42701'});
    await isolated.db.exec('ROLLBACK');
    expect((await isolated.db.query("SELECT to_regclass('public.mission_attempts') AS name")).rows)
      .toEqual([{name:'mission_attempts'}]);
    expect((await isolated.db.query('SELECT count(*)::int AS count FROM execution_metrics')).rows)
      .toEqual([{count:10}]);
  } finally { await isolated.db.close(); }
});

it('recovers an active execution and stale scanner after closing and reopening PostgreSQL storage', async () => {
  const path = await mkdtemp(join(tmpdir(), 'v2-f-pglite-'));
  try {
    const first = await executionDatabase(path);
    const initial = new ExecutionControl(first.pool, executionTestConfig);
    const mission = await readyMission(first.pool);
    const attempt = await initial.queue(mission.id, testMutation(), testExecutionOptions());
    await initial.claim(attempt.id, worker, proof(attempt), testMutation());
    await initial.start(proof(attempt), worker, testMutation());
    await first.db.close();
    const second = await executionDatabase(path);
    try {
      const restored = new ExecutionControl(second.pool, executionTestConfig);
      expect(JSON.stringify(await restored.status(mission.id))).toContain(attempt.id);
      await restored.heartbeat(proof(attempt), worker, testMutation());
      await second.db.query("UPDATE mission_attempts SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [attempt.id]);
      expect(await restored.scanExpired()).toBe(1);
      expect((await second.db.query('SELECT status FROM mission_attempts WHERE id=$1', [attempt.id])).rows).toEqual([{status: 'stale'}]);
      await expect(restored.complete(proof(attempt), worker, {outcome: 'completed'}, testMutation())).rejects.toThrow();
    } finally { await second.db.close(); }
  } finally { await rm(path, {recursive: true, force: true}); }
}, 30000);
