/**
 * Jarvis V1.1 safe mutation registry — durable records without agent/provider execution.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { MissionError, digest } from '../model.js';
import type { JarvisAction, JarvisActionResult, JarvisTestProfile } from './contract.js';
import { jarvisTestProfileSchema } from './contract.js';

export type JarvisMissionRecord = {
  id: string;
  organization_id: string;
  project: string;
  title: string;
  objective: string;
  requested_worker_type: 'codex' | 'cursor';
  lifecycle_state: 'queued' | 'cancelled' | 'cancel_requested';
  actor: string;
  reason: string;
  agent_started: false;
};

export type JarvisWorkspaceRecord = {
  id: string;
  organization_id: string;
  mission_id: string;
  attempt_id: string;
  fencing_token: string;
  project_id: string;
  name: string;
  branch: string;
  deleted: boolean;
  /** Synthetic marker for unsafe/unbounded child activity — blocks delete. */
  unsafe_active_process: boolean;
  publisher_active: boolean;
};

const SHELLISH = /\b(rm\s+-rf|bash\s+-c|sh\s+-c|\/bin\/|npm\s+test|pytest|uname\s+-a)\b/i;

export function assertNoShellishText(...values: string[]): void {
  for (const value of values) {
    if (SHELLISH.test(value)) throw new MissionError('shellish_content_denied', 400);
  }
}

export function assertFence(
  store: Map<string, string>,
  attemptId: string,
  token: string,
): void {
  const previous = store.get(attemptId);
  if (previous !== undefined && token < previous) {
    throw new MissionError('stale_fencing_token', 409);
  }
  if (previous === undefined || token > previous) {
    store.set(attemptId, token);
  }
}

export class JarvisMutationRegistry {
  readonly missions = new Map<string, JarvisMissionRecord>();
  readonly workspaces = new Map<string, JarvisWorkspaceRecord>();
  readonly fences = new Map<string, string>();
  readonly stops = new Map<string, { status: string }>();
  readonly testRuns = new Map<string, {
    id: string; profile: JarvisTestProfile; status: string; summary: string; duration_ms: number;
  }>();
  readonly idempotency = new Map<string, { hash: string; result: JarvisActionResult }>();

  constructor(private readonly pool?: Pool) {}

  private hash(action: JarvisAction): string {
    return digest({
      action: action.action,
      organization_id: action.organization_id,
      parameters: action.parameters,
      mission_id: action.mission_id,
      attempt_id: action.attempt_id,
      fencing_token: action.fencing_token,
    });
  }

  async replayOrConflict(action: JarvisAction): Promise<JarvisActionResult | undefined> {
    const hash = this.hash(action);
    const known = this.idempotency.get(action.request_id);
    if (known) {
      if (known.hash !== hash) throw new MissionError('jarvis_request_id_conflict', 409);
      return { ...known.result, error_code: known.result.error_code ?? 'idempotent_replay' };
    }
    if (this.pool) {
      try {
        const row = await this.pool.query(
          `SELECT payload_hash, response FROM jarvis_mutation_idempotency WHERE request_id=$1::uuid`,
          [action.request_id],
        );
        if (row.rows[0]) {
          if (row.rows[0].payload_hash !== hash) throw new MissionError('jarvis_request_id_conflict', 409);
          const result = row.rows[0].response as JarvisActionResult;
          this.idempotency.set(action.request_id, { hash, result });
          return result;
        }
      } catch (error) {
        if (error instanceof MissionError) throw error;
        // table may be absent in unit tests without pool schema
      }
    }
    return undefined;
  }

  async persistIdempotent(action: JarvisAction, result: JarvisActionResult): Promise<void> {
    const hash = this.hash(action);
    this.idempotency.set(action.request_id, { hash, result });
    if (!this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO jarvis_mutation_idempotency(request_id, organization_id, action, payload_hash, response)
         VALUES ($1::uuid,$2,$3,$4,$5::jsonb)
         ON CONFLICT (request_id) DO NOTHING`,
        [action.request_id, action.organization_id, action.action, hash, JSON.stringify(result)],
      );
    } catch {
      // fail soft for memory-only environments
    }
  }

  createMission(action: JarvisAction): JarvisMissionRecord {
    const p = action.parameters;
    const title = String(p.title);
    const objective = String(p.objective);
    const project = String(p.project);
    const reason = String(p.reason);
    const worker = p.requested_worker_type === 'cursor' ? 'cursor' : 'codex';
    assertNoShellishText(title, objective, reason);
    const record: JarvisMissionRecord = {
      id: randomUUID(),
      organization_id: action.organization_id,
      project,
      title,
      objective,
      requested_worker_type: worker,
      lifecycle_state: 'queued',
      actor: action.actor,
      reason,
      agent_started: false,
    };
    this.missions.set(record.id, record);
    void this.pool?.query(
      `INSERT INTO jarvis_missions(id,organization_id,project,title,objective,requested_worker_type,lifecycle_state,actor,reason,agent_started)
       VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,false)`,
      [record.id, record.organization_id, record.project, record.title, record.objective,
        record.requested_worker_type, record.lifecycle_state, record.actor, record.reason],
    ).catch(() => undefined);
    return record;
  }

  cancelMission(action: JarvisAction): JarvisMissionRecord {
    const missionId = String(action.parameters.mission_id);
    const reason = String(action.parameters.reason);
    assertNoShellishText(reason);
    const mission = this.missions.get(missionId);
    if (!mission || mission.organization_id !== action.organization_id) {
      throw new MissionError('mission_not_found', 404);
    }
    if (mission.lifecycle_state === 'cancelled' || mission.lifecycle_state === 'cancel_requested') {
      return mission;
    }
    if (!['queued', 'cancel_requested'].includes(mission.lifecycle_state)) {
      // only allow cancel from queued in this lightweight registry
      if (mission.lifecycle_state !== 'queued') throw new MissionError('invalid_state_transition', 409);
    }
    mission.lifecycle_state = 'cancelled';
    mission.reason = reason;
    void this.pool?.query(
      `UPDATE jarvis_missions SET lifecycle_state='cancelled', reason=$2, updated_at=now() WHERE id=$1::uuid AND organization_id=$3`,
      [missionId, reason, action.organization_id],
    ).catch(() => undefined);
    return mission;
  }

  createWorkspace(action: JarvisAction): JarvisWorkspaceRecord {
    const missionId = String(action.parameters.mission_id);
    const attemptId = String(action.parameters.attempt_id);
    const fencingToken = String(action.parameters.fencing_token);
    const projectId = String(action.parameters.project_id);
    const name = String(action.parameters.name);
    const branch = String(action.parameters.branch);
    const mission = this.missions.get(missionId);
    if (!mission || mission.organization_id !== action.organization_id) {
      throw new MissionError('mission_not_found', 404);
    }
    assertFence(this.fences, attemptId, fencingToken);
    for (const existing of this.workspaces.values()) {
      if (!existing.deleted && existing.mission_id === missionId && existing.name === name) {
        throw new MissionError('workspace_duplicate', 409);
      }
    }
    const record: JarvisWorkspaceRecord = {
      id: randomUUID(),
      organization_id: action.organization_id,
      mission_id: missionId,
      attempt_id: attemptId,
      fencing_token: fencingToken,
      project_id: projectId,
      name,
      branch,
      deleted: false,
      unsafe_active_process: false,
      publisher_active: false,
    };
    this.workspaces.set(record.id, record);
    void this.pool?.query(
      `INSERT INTO jarvis_workspaces(id,organization_id,mission_id,attempt_id,fencing_token,project_id,name,branch,deleted)
       VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8,false)`,
      [record.id, record.organization_id, record.mission_id, record.attempt_id, record.fencing_token,
        record.project_id, record.name, record.branch],
    ).catch(() => undefined);
    return record;
  }

  deleteWorkspace(action: JarvisAction): JarvisWorkspaceRecord {
    const workspaceId = String(action.parameters.workspace_id);
    const missionId = String(action.parameters.mission_id);
    const attemptId = String(action.parameters.attempt_id);
    const fencingToken = String(action.parameters.fencing_token);
    const reason = String(action.parameters.reason);
    assertNoShellishText(reason);
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace || workspace.organization_id !== action.organization_id) {
      throw new MissionError('workspace_not_found', 404);
    }
    if (workspace.mission_id !== missionId) throw new MissionError('workspace_mission_mismatch', 403);
    if (workspace.attempt_id !== attemptId) throw new MissionError('workspace_attempt_mismatch', 403);
    assertFence(this.fences, attemptId, fencingToken);
    if (workspace.unsafe_active_process) {
      throw new MissionError('workspace_active_unsafe_process', 409);
    }
    if (workspace.publisher_active) {
      throw new MissionError('workspace_publisher_active', 409);
    }
    if (workspace.deleted) return workspace;
    workspace.deleted = true;
    void this.pool?.query(
      `UPDATE jarvis_workspaces SET deleted=true, deleted_at=now() WHERE id=$1::uuid AND organization_id=$2`,
      [workspaceId, action.organization_id],
    ).catch(() => undefined);
    return workspace;
  }

  runTests(action: JarvisAction): {
    test_run_id: string; profile: JarvisTestProfile; status: string; summary: string; duration_ms: number;
  } {
    const missionId = String(action.parameters.mission_id);
    const attemptId = String(action.parameters.attempt_id);
    const fencingToken = String(action.parameters.fencing_token);
    const profileParsed = jarvisTestProfileSchema.safeParse(action.parameters.test_profile);
    if (!profileParsed.success) throw new MissionError('invalid_test_profile', 400);
    // Reject any sneaky command-shaped fields
    for (const [key, value] of Object.entries(action.parameters)) {
      if (['command', 'argv', 'shell', 'cmd'].includes(key)) throw new MissionError('arbitrary_test_command_denied', 400);
      if (typeof value === 'string') assertNoShellishText(value);
    }
    const mission = this.missions.get(missionId);
    if (!mission || mission.organization_id !== action.organization_id) {
      throw new MissionError('mission_not_found', 404);
    }
    assertFence(this.fences, attemptId, fencingToken);
    const started = Date.now();
    const duration_ms = Math.max(1, Date.now() - started);
    const record = {
      id: randomUUID(),
      profile: profileParsed.data,
      status: 'passed',
      summary: `profile:${profileParsed.data}:noop`,
      duration_ms,
    };
    this.testRuns.set(record.id, record);
    void this.pool?.query(
      `INSERT INTO jarvis_test_runs(id,organization_id,mission_id,attempt_id,fencing_token,profile,status,summary,duration_ms)
       VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,$9)`,
      [record.id, action.organization_id, missionId, attemptId, fencingToken,
        record.profile, record.status, record.summary, record.duration_ms],
    ).catch(() => undefined);
    return {
      test_run_id: record.id,
      profile: record.profile,
      status: record.status,
      summary: record.summary,
      duration_ms: record.duration_ms,
    };
  }

  stopAgent(action: JarvisAction): { status: 'stopped' | 'already_stopped'; mission_id: string; attempt_id: string } {
    const missionId = String(action.parameters.mission_id);
    const attemptId = String(action.parameters.attempt_id);
    const fencingToken = String(action.parameters.fencing_token);
    const reason = String(action.parameters.reason);
    assertNoShellishText(reason);
    if ('pid' in action.parameters || 'process' in action.parameters) {
      throw new MissionError('arbitrary_pid_denied', 400);
    }
    const mission = this.missions.get(missionId);
    if (!mission || mission.organization_id !== action.organization_id) {
      throw new MissionError('mission_not_found', 404);
    }
    assertFence(this.fences, attemptId, fencingToken);
    const key = `${missionId}:${attemptId}`;
    const previous = this.stops.get(key);
    if (previous) return { status: 'already_stopped', mission_id: missionId, attempt_id: attemptId };
    this.stops.set(key, { status: 'stopped' });
    void this.pool?.query(
      `INSERT INTO jarvis_agent_stops(id,organization_id,mission_id,attempt_id,fencing_token,status)
       VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5::uuid,'stopped')`,
      [randomUUID(), action.organization_id, missionId, attemptId, fencingToken],
    ).catch(() => undefined);
    return { status: 'stopped', mission_id: missionId, attempt_id: attemptId };
  }
}

export function payloadFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
