import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { admissionSchema, assertTransition, assertV2, digest, MissionError, planSchema,
  type Admission, type Plan, type State } from './model.js';

export type Mission = {
  id: string; orchestration_version: number; project: string; lifecycle_state: State;
  state_version: number; plan_version: number; parent_mission_id: string | null;
  request_hash: string; requested_by: string;
};
export type SlackInput = { team_id: string; event_id: string; channel: string;
  thread_ts: string; user: string; is_root: boolean };
export type Mutation = { principal: string; key: string };
export type FoundationConfig = { enabled: boolean; projects: ReadonlySet<string> };
const columns = 'id, orchestration_version, project, lifecycle_state, state_version, plan_version, parent_mission_id, request_hash, requested_by';

export class MissionStore {
  constructor(private pool: Pool, private config: FoundationConfig) {}
  private gate(project?: string) {
    if (!this.config.enabled) throw new MissionError('v2_disabled', 503);
    if (project && !this.config.projects.has(project)) throw new MissionError('project_not_allowed', 403);
  }
  private async mutate(meta: Mutation, payload: unknown, run: (c: PoolClient) => Promise<Mission>): Promise<Mission> {
    this.gate();
    if (!/^[A-Za-z0-9:_.-]{1,200}$/.test(meta.key) || !/^[A-Za-z0-9:_.-]{1,200}$/.test(meta.principal)) {
      throw new MissionError('invalid_mutation_identity', 400);
    }
    const hash = digest(payload);
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      // Foundation has no throughput scheduler. Serialize mutations across connections,
      // including receipts, provenance, hierarchy and DAG validation, using PostgreSQL.
      await c.query('LOCK TABLE agent_missions IN SHARE ROW EXCLUSIVE MODE');
      const receipt = await c.query('SELECT payload_hash, response FROM mission_receipts WHERE principal=$1 AND idempotency_key=$2', [meta.principal, meta.key]);
      if (receipt.rows[0]) {
        if (receipt.rows[0].payload_hash !== hash) throw new MissionError('idempotency_conflict');
        this.gate(receipt.rows[0].response.project);
        await c.query('COMMIT');
        return receipt.rows[0].response;
      }
      const mission = await run(c);
      await c.query('INSERT INTO mission_receipts(principal,idempotency_key,payload_hash,mission_id,response) VALUES($1,$2,$3,$4,$5)',
        [meta.principal, meta.key, hash, mission.id, JSON.stringify(mission)]);
      await c.query('COMMIT');
      return mission;
    } catch (error) {
      await c.query('ROLLBACK').catch(() => undefined);
      if (error instanceof MissionError) throw error;
      const code = (error as {code?: string}).code;
      if (code === '23505') throw new MissionError('provenance_conflict');
      if (code === '23514' || code === '23503') throw new MissionError('mission_constraint_conflict');
      // Do not expose PostgreSQL detail fields (may contain input values).
      throw new MissionError('mission_storage_unavailable', 503);
    } finally { c.release(); }
  }
  private async event(c: PoolClient, m: Mission, type: string) {
    await c.query('INSERT INTO mission_events(mission_id,event_type,state_version,plan_version,lifecycle_state) VALUES($1,$2,$3,$4,$5)',
      [m.id,type,m.state_version,m.plan_version,m.lifecycle_state]);
  }
  async admit(input: Admission, meta: Mutation, slack?: SlackInput): Promise<Mission> {
    const parsed = admissionSchema.safeParse(input);
    if (!parsed.success) throw new MissionError('invalid_admission', 400);
    const data = parsed.data;
    this.gate(data.project);
    if ((data.source_type === 'slack') !== Boolean(slack)) throw new MissionError('invalid_source', 400);
    if ((data.source_type === 'child') !== Boolean(data.parent_mission_id)) throw new MissionError('invalid_parent_source', 400);
    const hash = digest({data, slack, principal: meta.principal});
    return this.mutate(meta, {op:'admit', data, slack}, async c => {
      const existing = await c.query(`SELECT ${columns} FROM agent_missions WHERE source_type=$1 AND source_id=$2`, [data.source_type, data.source_id]);
      if (existing.rows[0]) {
        assertV2(existing.rows[0]);
        if (existing.rows[0].request_hash !== hash) throw new MissionError('provenance_conflict');
        return existing.rows[0];
      }
      if (data.parent_mission_id) {
        const parent = await this.getTx(c, data.parent_mission_id);
        if (parent.project !== data.project) throw new MissionError('invalid_parent');
      }
      if (slack) {
        const tkey = `${slack.team_id}:${slack.channel}:${slack.thread_ts}`;
        if (slack.is_root) await c.query(`INSERT INTO slack_thread_owners(thread_key,team_id,channel_id,thread_root_ts,owner)
          VALUES($1,$2,$3,$4,'hermes') ON CONFLICT DO NOTHING`, [tkey,slack.team_id,slack.channel,slack.thread_ts]);
        const owner = await c.query('SELECT owner FROM slack_thread_owners WHERE thread_key=$1', [tkey]);
        if (owner.rows[0]?.owner !== 'hermes') throw new MissionError('thread_not_owned', 403);
        const dedup = await c.query(`INSERT INTO slack_event_dedup(team_id,event_id) VALUES($1,$2)
          ON CONFLICT DO NOTHING RETURNING event_id`, [slack.team_id,slack.event_id]);
        if (!dedup.rowCount) throw new MissionError('event_already_owned');
      }
      const result = await c.query(`INSERT INTO agent_missions(id, action_id,target_agent,source_type,source_id,title,payload,
        priority,status,dry_run,requires_human_validation,orchestration_version,project,objective,
        parent_mission_id,lifecycle_state,request_hash,requested_by)
        VALUES($1,NULL,'hermes',$2,$3,$4,'{}','medium','pending',true,true,2,$5,$6,$7,'queued',$8,$9)
        RETURNING ${columns}`, [randomUUID(),data.source_type,data.source_id,data.title,data.project,data.objective,
        data.parent_mission_id ?? null,hash,meta.principal]);
      const m = result.rows[0] as Mission;
      if (slack) await c.query(`INSERT INTO slack_gateway_inbox(target,prompt,channel_id,thread_ts,user_id,event_id,
        delivery_mode,mission_title,orchestration_version,mission_id)
        VALUES('hermes',$1,$2,$3,$4,$5,'async',$6,2,$7)`,
        [data.objective,slack.channel,slack.thread_ts,slack.user,slack.event_id,data.title,m.id]);
      await this.event(c,m,'admitted');
      return m;
    });
  }
  private async getTx(c: Pick<PoolClient,'query'>, id: string): Promise<Mission> {
    if (!z.string().uuid().safeParse(id).success) throw new MissionError('invalid_mission_id',400);
    const result = await c.query(`SELECT ${columns} FROM agent_missions WHERE id=$1`, [id]);
    assertV2(result.rows[0]);
    const row = result.rows[0] as Mission;
    this.gate(row.project);
    return row;
  }
  async allowsThread(team: string, channel: string, thread: string): Promise<boolean> {
    this.gate();
    const result = await this.pool.query('SELECT owner FROM slack_thread_owners WHERE thread_key=$1', [`${team}:${channel}:${thread}`]);
    return !result.rows[0] || result.rows[0].owner === 'hermes';
  }
  async get(id: string): Promise<Mission> { this.gate(); return this.getTx(this.pool,id); }
  async status(project: string): Promise<Mission[]> {
    this.gate(project);
    const r = await this.pool.query(`SELECT ${columns} FROM agent_missions WHERE orchestration_version=2 AND project=$1 ORDER BY created_at DESC,id LIMIT 100`, [project]);
    return r.rows;
  }
  async plan(id: string): Promise<{version:number;plan:Plan} | null> {
    await this.get(id);
    const r = await this.pool.query('SELECT version,plan FROM mission_plans WHERE mission_id=$1 ORDER BY version DESC LIMIT 1', [id]);
    return r.rows[0] ?? null;
  }
  async events(id: string, after = '0') {
    await this.get(id);
    return (await this.pool.query('SELECT * FROM mission_events WHERE mission_id=$1 AND id>$2::bigint ORDER BY id LIMIT 100', [id,after])).rows;
  }
  async transition(id: string, version: number, to: State, meta: Mutation): Promise<Mission> {
    return this.mutate(meta,{op:'transition',id,version,to},async c => {
      const row = await this.getTx(c,id);
      if (row.state_version !== version) throw new MissionError('state_version_conflict');
      assertTransition(row.lifecycle_state,to);
      const r = await c.query(`UPDATE agent_missions SET lifecycle_state=$2,state_version=state_version+1,updated_at=now()
        WHERE id=$1 AND orchestration_version=2 AND state_version=$3 RETURNING ${columns}`, [id,to,version]);
      if (!r.rowCount) throw new MissionError('state_version_conflict');
      await this.event(c,r.rows[0],'state_changed');
      return r.rows[0];
    });
  }
  async savePlan(id: string, version: number, input: Plan, meta: Mutation): Promise<Mission> {
    const parsed = planSchema.safeParse(input);
    if (!parsed.success) throw new MissionError('invalid_plan',400);
    const plan = parsed.data;
    return this.mutate(meta,{op:'plan',id,version,plan},async c => {
      const row = await this.getTx(c,id);
      if (row.state_version !== version) throw new MissionError('state_version_conflict');
      if (row.lifecycle_state !== 'planning') throw new MissionError('plan_requires_planning');
      const next = row.plan_version + 1;
      await c.query('INSERT INTO mission_plans(mission_id,version,plan) VALUES($1,$2,$3)', [id,next,JSON.stringify(plan)]);
      for (const dependency of plan.dependencies) {
        const target = await this.getTx(c,dependency.mission_id);
        if (target.project !== row.project) throw new MissionError('invalid_dependency');
        await c.query(`INSERT INTO mission_dependencies(mission_id,depends_on_id,dependency_type,reference,plan_version)
          VALUES($1,$2,$3,$4,$5)`, [id,target.id,dependency.type,dependency.reference ?? null,next]);
      }
      const deps = await c.query('SELECT 1 FROM mission_dependencies WHERE mission_id=$1 LIMIT 1',[id]);
      const state = deps.rowCount ? 'waiting_dependencies' : 'ready';
      const r = await c.query(`UPDATE agent_missions SET plan_version=$2,state_version=state_version+1,lifecycle_state=$3,updated_at=now()
        WHERE id=$1 AND orchestration_version=2 AND state_version=$4 RETURNING ${columns}`, [id,next,state,version]);
      if (!r.rowCount) throw new MissionError('state_version_conflict');
      await this.event(c,r.rows[0],'plan_saved');
      return r.rows[0];
    });
  }
}
