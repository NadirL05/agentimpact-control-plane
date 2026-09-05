import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ExecutionControl } from './execution.js';
import { MissionStore } from './store.js';
import { executionTestConfig, readyMission, testExecutionOptions, testMutation } from './testing/execution-database.js';

// Accept only the disposable cluster created by our isolated native test runner.
// Every connection specifies the private Unix socket, database and test user.
const socket = process.env.V2_TEST_PG_SOCKET;
const privateSocket = socket && /^\/tmp\/v2-a-pg-[A-Za-z0-9]+\/socket$/.test(socket);
const worker = 'fake-worker-1';
const proof = (attempt: {id: string; worker_instance_id: string; fencing_token: string}) => ({
  attempt_id: attempt.id, worker_instance_id: attempt.worker_instance_id, fencing_token: attempt.fencing_token,
});

describe.skipIf(!privateSocket)('V2-F native PostgreSQL concurrent execution control', () => {
  let pool: Pool;
  let execution: ExecutionControl;
  let store: MissionStore;
  let isolatedSchema: string;
  beforeAll(async () => {
    const connection = {host: socket, port: 55437, database: 'postgres', user: 'v2_test', password: ''};
    const bootstrap = new Pool({...connection, max: 1});
    const schema = `v2_f_${randomUUID().replaceAll('-', '')}`;
    isolatedSchema = schema;
    try { await bootstrap.query(`CREATE SCHEMA ${schema}`); } finally { await bootstrap.end(); }
    pool = new Pool({...connection, max: 8, options: `-c search_path=${schema}`});
    await pool.query(await readFile(new URL('./testing/schema.sql', import.meta.url), 'utf8'));
    for (const migration of ['001_cursor_proposals.sql', '002_slack_router.sql', '003_async_long_running_missions.sql', '004_v2_mission_foundation.sql', '005_v2_execution_control.sql']) {
      await pool.query(await readFile(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8'));
    }
    execution = new ExecutionControl(pool, executionTestConfig);
    store = new MissionStore(pool, executionTestConfig);
  }, 30000);
  afterAll(async () => { await pool?.end(); });

  async function running() {
    const mission = await readyMission(pool);
    const attempt = await execution.queue(mission.id, testMutation(), testExecutionOptions());
    const identity = proof(attempt);
    await execution.claim(attempt.id, worker, identity, testMutation());
    await execution.start(identity, worker, testMutation());
    return {mission, attempt, proof: identity};
  }

  it('allows exactly one of eight simultaneous attempt admissions', async () => {
    const mission = await readyMission(pool);
    const results = await Promise.allSettled(Array.from({length: 8}, () => execution.queue(mission.id, testMutation(), testExecutionOptions())));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(7);
    expect((await pool.query('SELECT count(*)::int AS n FROM mission_attempts WHERE mission_id=$1', [mission.id])).rows).toEqual([{n: 1}]);
  });

  it('serializes duplicate claim receipts without creating multiple running generations', async () => {
    const mission = await readyMission(pool);
    const attempt = await execution.queue(mission.id, testMutation(), testExecutionOptions());
    const mutation = testMutation();
    const results = await Promise.all(Array.from({length: 5}, () => execution.claim(attempt.id, worker, proof(attempt), mutation)));
    expect(new Set(results.map(result => result.id)).size).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM mission_attempts WHERE mission_id=$1 AND status='claimed'", [mission.id])).rows).toEqual([{n: 1}]);
    expect((await pool.query("SELECT count(*)::int AS n FROM mission_events WHERE mission_id=$1 AND event_type='attempt_claimed'", [mission.id])).rows).toEqual([{n: 1}]);
  });

  it.each(['worktree_path', 'branch'] as const)('protects %s ownership across concurrent different missions', async field => {
    const first = await readyMission(pool), second = await readyMission(pool);
    const firstOptions = testExecutionOptions(), secondOptions = testExecutionOptions();
    secondOptions.workspace[field] = firstOptions.workspace[field];
    const results = await Promise.allSettled([
      execution.queue(first.id, testMutation(), firstOptions),
      execution.queue(second.id, testMutation(), secondOptions),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM mission_attempts WHERE mission_id=ANY($1::uuid[])', [[first.id, second.id]])).rows).toEqual([{n: 1}]);
  });

  it('rejects concurrent lexically equivalent canonical workspace paths', async () => {
    const first = await readyMission(pool), second = await readyMission(pool);
    const firstOptions = testExecutionOptions(), secondOptions = testExecutionOptions();
    const suffix = randomUUID();
    firstOptions.workspace.worktree_path = `/fake/${suffix}/.`;
    secondOptions.workspace.worktree_path = `/fake//a/../${suffix}`;
    const results = await Promise.allSettled([
      execution.queue(first.id,testMutation(),firstOptions),
      execution.queue(second.id,testMutation(),secondOptions),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect((await pool.query('SELECT worktree_path FROM worktree_leases WHERE mission_id=ANY($1::uuid[])',[[first.id,second.id]])).rows)
      .toEqual([{worktree_path:`/fake/${suffix}`}]);
  });

  it('checks dependencies after waiting for a concurrent failed prerequisite transaction', async () => {
    const dependency = await readyMission(pool);
    await pool.query("UPDATE agent_missions SET lifecycle_state='completed' WHERE id=$1", [dependency.id]);
    const dependent = await readyMission(pool, [{mission_id: dependency.id, type: 'artifact'}]);
    const attempt = await execution.queue(dependent.id, testMutation(), testExecutionOptions());
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      const writerPid = (await writer.query<{id: number}>('SELECT pg_backend_pid() AS id')).rows[0].id;
      await writer.query("UPDATE agent_missions SET lifecycle_state='failed_permanent' WHERE id=$1", [dependency.id]);
      // Start claim while the independent prerequisite transaction still owns
      // its lock. Handle rejection immediately so no rejected promise escapes.
      const claim = execution.claim(attempt.id, worker, proof(attempt), testMutation()).then(
        value => ({value, error: undefined}), error => ({value: undefined, error}),
      );
      let blocked = false;
      for (let turn = 0; turn < 100 && !blocked; turn++) {
        const waiting = await pool.query<{blocked: boolean}>(
          'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked', [writerPid]);
        blocked = waiting.rows[0].blocked;
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(blocked).toBe(true);
      await writer.query('COMMIT');
      const result = await claim;
      expect(result.error).toBeTruthy();
      expect(result.value).toBeUndefined();
      expect((await store.get(dependent.id)).lifecycle_state).toBe('blocked');
      expect((await pool.query('SELECT status FROM mission_attempts WHERE id=$1', [attempt.id])).rows).toEqual([{status: 'queued'}]);
    } finally { await writer.query('ROLLBACK'); writer.release(); }
  });

  it('does not lose cancellation when it races a completion on another connection', async () => {
    const item = await running();
    const outcomes = await Promise.allSettled([
      execution.complete(item.proof, worker, {outcome: 'completed'}, testMutation()),
      execution.cancel(item.mission.id, testMutation()),
    ]);
    expect(outcomes.some(outcome => outcome.status === 'fulfilled')).toBe(true);
    const mission = await store.get(item.mission.id);
    expect(['cancel_requested', 'cancelling', 'cancelled']).toContain(mission.lifecycle_state);
    await execution.reconcile(item.attempt.id, {kind: 'stopped', worker_instance_id: worker, fencing_token: item.proof.fencing_token}, testMutation());
    expect((await store.get(item.mission.id)).lifecycle_state).toBe('cancelled');
    expect((await pool.query('SELECT count(*)::int AS n FROM mission_attempts WHERE mission_id=$1', [item.mission.id])).rows).toEqual([{n: 1}]);
  });

  it('stores only one outcome for duplicate complete callbacks from separate connections', async () => {
    const item = await running();
    const output = {outcome: 'completed' as const, head_sha: 'a'.repeat(40)};
    const callbacks = await Promise.all(Array.from({length: 5}, () => execution.complete(item.proof, worker, output, testMutation())));
    expect(new Set(callbacks.map(callback => callback.id)).size).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM mission_events WHERE mission_id=$1 AND event_type='attempt_completed'", [item.mission.id])).rows).toEqual([{n: 1}]);
    expect((await store.get(item.mission.id)).lifecycle_state).toBe('reviewing');
  });

  it('serializes scanner and expired heartbeat without resurrecting the stale owner', async () => {
    const item = await running();
    await pool.query("UPDATE mission_attempts SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [item.attempt.id]);
    const results = await Promise.allSettled([
      execution.heartbeat(item.proof, worker, testMutation()), execution.scanExpired(), execution.scanExpired(),
    ]);
    expect(results[0].status).toBe('rejected');
    expect((await pool.query('SELECT status FROM mission_attempts WHERE id=$1', [item.attempt.id])).rows).toEqual([{status: 'stale'}]);
    expect((await pool.query("SELECT count(*)::int AS n FROM mission_events WHERE mission_id=$1 AND event_type='attempt_stale'", [item.mission.id])).rows).toEqual([{n: 1}]);
  });

  it('rejects bad callbacks and records metrics without deadlocking a one-connection pool', async () => {
    const item = await running();
    // A short acquisition timeout also lets the fixture clean itself up if a
    // regression tries to acquire a second client while holding the first.
    const single = new Pool({host: socket, port: 55437, database: 'postgres', user: 'v2_test', password: '',
      max: 1, connectionTimeoutMillis: 750, options: `-c search_path=${isolatedSchema}`});
    try {
      const control = new ExecutionControl(single, executionTestConfig);
      const before = await execution.metrics();
      const started = performance.now();
      await expect(control.heartbeat(item.proof, 'fake-worker-2', testMutation())).rejects.toMatchObject({code: 'wrong_worker'});
      expect(performance.now() - started).toBeLessThan(1000);
      const after = await execution.metrics();
      expect(after.callbacks_rejected_total).toBe(before.callbacks_rejected_total + 1);
      expect(after.fencing_rejections_total).toBe(before.fencing_rejections_total + 1);
    } finally { await single.end(); }
  });
});
