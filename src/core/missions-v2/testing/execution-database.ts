import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { database } from './database.js';
import { MissionStore } from '../store.js';
import { fakePlanner } from './fakes.js';
import type { Plan } from '../model.js';

export const executionTestConfig = {
  enabled: true,
  projects: new Set(['IMANE']),
  workerIds: new Set(['fake-worker-1', 'fake-worker-2']),
  quotaAmount: 1000,
};
export const testMutation = () => ({principal: 'test:operator', key: randomUUID()});
export const testWorkspace = () => {
  const suffix = randomUUID();
  return {repo: 'fixture', base_sha: 'a'.repeat(40), branch: `fixture/${suffix}`, worktree_path: `/fake/${suffix}`};
};
export const testExecutionOptions = () => ({
  workspace: testWorkspace(),
  budget: {max_amount: 10, reserved_amount: 10, currency: 'FAKE' as const},
  worker_instance_id: 'fake-worker-1',
});

// All amounts, identities and paths are synthetic. This helper only migrates
// the PGlite fixture and never reads production PostgreSQL environment variables.
export async function executionDatabase(path?: string) {
  const fixture = await database(path);
  const exists = await fixture.db.query("SELECT to_regclass('public.mission_attempts') AS name");
  if (!(exists.rows[0] as {name: string | null}).name) {
    await fixture.db.exec(await readFile(new URL('../../../migrations/005_v2_execution_control.sql', import.meta.url), 'utf8'));
  }
  return fixture;
}

export async function codexDatabase(path?: string) {
  const fixture=await executionDatabase(path);
  const exists=await fixture.db.query("SELECT to_regclass('public.codex_attempt_metadata') AS name");
  if (!(exists.rows[0] as {name:string|null}).name) {
    await fixture.db.exec(await readFile(new URL('../../../migrations/006_v2_codex_worker.sql',import.meta.url),'utf8'));
  }
  const hardened=await fixture.db.query("SELECT obj_description(to_regclass('public.worktree_leases_one_codex_writer_per_repo'),'pg_class') AS value");
  if (!(hardened.rows[0] as {value:string|null}).value) {
    await fixture.db.exec(await readFile(new URL('../../../migrations/007_v2_codex_predeploy_hardening.sql',import.meta.url),'utf8'));
  }
  return fixture;
}

export async function readyMission(pool: Pool, dependencies: Plan['dependencies'] = []) {
  const store = new MissionStore(pool, executionTestConfig);
  let mission = await store.admit({
    project: 'IMANE', title: 'Execution fixture', objective: 'Validate synthetic execution only',
    source_type: 'command', source_id: randomUUID(),
  }, testMutation());
  mission = await store.transition(mission.id, mission.state_version, 'planning', testMutation());
  return store.savePlan(mission.id, mission.state_version, {...fakePlanner(), dependencies}, testMutation());
}
