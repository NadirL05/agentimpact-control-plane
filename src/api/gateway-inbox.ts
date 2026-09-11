/**
 * API inbox gateway Hermès/Ana — localhost + token bridge uniquement.
 * Consommée par infra/scripts/gateway-inbox-consumer.py côté gateway.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../core/hono-env.js';
import { pool } from './db.js';
import type { MissionStore } from '../core/missions-v2/store.js';
import { planSchema } from '../core/missions-v2/model.js';

export function createGatewayInboxApi(store?: MissionStore) {
const app = new Hono<AppEnv>();

app.post('/claim', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { target?: string; include_v2?: boolean } | null;
  const target = body?.target?.trim();
  if (target !== 'hermes' && target !== 'ana') {
    return c.json({ error: 'invalid_target' }, 400);
  }
  const scope=c.get('authScope');
  if(scope==='planner'&&(body?.include_v2!==true||target!=='hermes')) {
    return c.json({error:'planner_v2_only'},403);
  }
  if(body?.include_v2===true&&scope!=='planner') return c.json({error:'v2_planner_identity_required'},403);
  const includeV2=store!==undefined&&body?.include_v2===true&&target==='hermes'&&scope==='planner';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claimed = await client.query<{
      id: string;
      prompt: string;
      channel_id: string;
      thread_ts: string;
      user_id: string;
      event_id: string;
      delivery_mode: string;
      mission_title: string | null;
      orchestration_version: number;
      mission_id: string | null;
      project: string | null;
    }>(
      `SELECT id, prompt, channel_id, thread_ts, user_id, event_id,
              coalesce(delivery_mode, 'sync') as delivery_mode,
              mission_title,coalesce(to_jsonb(i)->>'orchestration_version','1')::int AS orchestration_version,
              to_jsonb(i)->>'mission_id' AS mission_id,
              (SELECT to_jsonb(m)->>'project' FROM agent_missions m
                WHERE m.id::text=to_jsonb(i)->>'mission_id') AS project
       FROM slack_gateway_inbox i
       WHERE coalesce(to_jsonb(i)->>'orchestration_version', '1') ${includeV2 ? "IN ('1','2')" : "= '1'"} AND target = $1 AND status = 'pending'
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
      [target],
    );

    if ((claimed.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      return c.body(null, 204);
    }

    const row = claimed.rows[0]!;
    await client.query(
      `UPDATE slack_gateway_inbox i SET status = 'processing', updated_at = now() WHERE id = $1 AND coalesce(to_jsonb(i)->>'orchestration_version', '1') = $2`,
      [row.id,String(row.orchestration_version ?? 1)],
    );
    await client.query('COMMIT');

    return c.json({
      item: {
        id: row.id,
        orchestration_version: row.orchestration_version ?? 1,
        mission_id: row.mission_id,
        project: row.project,
        target,
        prompt: row.prompt,
        channel_id: row.channel_id,
        thread_ts: row.thread_ts,
        user_id: row.user_id,
        event_id: row.event_id,
        delivery_mode: row.delivery_mode,
        mission_title: row.mission_title,
      },
    });
  } catch {
    await client.query('ROLLBACK');
    return c.json({ error: 'claim_failed' }, 503);
  } finally {
    client.release();
  }
});

app.post('/:id/complete', async (c) => {
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as
    | { text?: string; run_id?: string; error_code?: string; status?: string; plan?: unknown }
    | null;

  if (!body) {
    return c.json({ error: 'invalid_body' }, 400);
  }

  if (store) {
    const claimed=await pool.query<{orchestration_version:number;mission_id:string|null;status:string}>(
      `SELECT coalesce(orchestration_version,1) AS orchestration_version,mission_id,status
       FROM slack_gateway_inbox WHERE id=$1`,[id]);
    const inbox=claimed.rows[0];
    if(c.get('authScope')==='planner'&&inbox?.orchestration_version!==2) {
      return c.json({error:'planner_v2_only'},403);
    }
    if(inbox?.orchestration_version===2) {
      if(c.get('authScope')!=='planner') return c.json({error:'v2_planner_identity_required'},403);
      if(inbox.status!=='processing'||!inbox.mission_id) return c.json({error:'inbox_not_processable'},409);
      const parsed=planSchema.safeParse((body as {plan?:unknown}).plan);
      if(parsed.success) {
        let mission=await store.get(inbox.mission_id);
        if(mission.lifecycle_state==='queued') mission=await store.transition(mission.id,mission.state_version,'planning',
          {principal:'gateway:hermes',key:`v2-plan-start:${id}`});
        if(mission.lifecycle_state==='planning') mission=await store.savePlan(mission.id,mission.state_version,parsed.data,
          {principal:'gateway:hermes',key:`v2-plan-save:${id}`});
        const done=await pool.query(`UPDATE slack_gateway_inbox SET status='done',response_text='typed_plan_saved',updated_at=now()
          WHERE id=$1 AND orchestration_version=2 AND status='processing'`,[id]);
        if(!done.rowCount) return c.json({error:'inbox_not_processable'},409);
        return c.json({ok:true,mission_id:mission.id,lifecycle_state:mission.lifecycle_state});
      }
      const errorCode=(body.error_code??'invalid_hermes_plan').slice(0,120);
      let mission=await store.get(inbox.mission_id);
      if(['queued','planning'].includes(mission.lifecycle_state)) mission=await store.transition(mission.id,mission.state_version,'blocked',
        {principal:'gateway:hermes',key:`v2-plan-failed:${id}`});
      await pool.query(`UPDATE slack_gateway_inbox SET status='failed',error_code=$2,updated_at=now()
        WHERE id=$1 AND orchestration_version=2 AND status='processing'`,[id,errorCode]);
      return c.json({ok:false,error:errorCode,mission_id:mission.id},409);
    }
  }

  if (body.text && body.text.trim()) {
    const result = await pool.query(
      `UPDATE slack_gateway_inbox i
       SET status = 'done', response_text = $2, run_id = $3, updated_at = now()
       WHERE id = $1 AND coalesce(to_jsonb(i)->>'orchestration_version', '1') = '1' AND status = 'processing'`,
      [id, body.text.trim(), body.run_id ?? null],
    );
    if (!result.rowCount) return c.json({ error: 'inbox_not_processable' }, 409);
    return c.json({ ok: true });
  }

  const errorCode = (body.error_code ?? 'consumer_failed').slice(0, 120);
  const terminal =
    body.status === 'timeout' || errorCode === 'hermes_timeout' || errorCode === 'inbox_timeout'
      ? 'timeout'
      : body.status === 'cancelled'
        ? 'cancelled'
        : 'failed';

  const result = await pool.query(
    `UPDATE slack_gateway_inbox i
     SET status = $2, error_code = $3, updated_at = now()
     WHERE id = $1 AND coalesce(to_jsonb(i)->>'orchestration_version', '1') = '1' AND status = 'processing'`,
    [id, terminal, errorCode],
  );
  if (!result.rowCount) return c.json({ error: 'inbox_not_processable' }, 409);
  return c.json({ ok: true });
});

return app;
}

export default createGatewayInboxApi();
