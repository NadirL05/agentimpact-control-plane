import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { pool } from './db.js';
import { tryAutopilot } from './autopilot.js';
import { canDispatch } from '../core/mission-rules.js';
import { parseMissionPagination } from '../core/mission-pagination.js';

const app = new Hono();

const priorities = ['low', 'medium', 'high', 'critical'] as const;

app.get('/', async (c) => {
  const { limit, offset } = parseMissionPagination(
    c.req.query('limit'),
    c.req.query('offset'),
  );

  const targetAgent = c.req.query('target_agent') ?? null;
  const status = c.req.query('status') ?? null;

  const result = await pool.query(
    `select
       m.id,
       1 as orchestration_version,
       m.created_at,
       m.updated_at,
       m.action_id,
       m.target_agent,
       m.source_type,
       m.source_id,
       m.source_url,
       m.title,
       m.payload,
       m.priority,
       m.status,
       m.dry_run,
       m.requires_human_validation,
       m.result,
      m.processed_at,
      m.error_message,
      a.payload_hash,
       a.status as action_status
     from agent_missions m
     join agent_actions a on a.id = m.action_id
     where coalesce(to_jsonb(m)->>'orchestration_version', '1') = '1' AND ($1::text is null or m.target_agent = $1)
       and ($2::text is null or m.status = $2)
     order by m.created_at desc
     limit $3 offset $4`,
    [targetAgent, status, limit, offset],
  );

  return c.json({ count: result.rows.length, items: result.rows, limit, offset });
});

app.get('/:id', async (c) => {
  const missionId = c.req.param('id');
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      missionId,
    )
  ) {
    return c.json({ error: 'Invalid mission id.' }, 400);
  }

  const result = await pool.query(
    `select
       m.id,
       1 as orchestration_version,
       m.created_at,
       m.updated_at,
       m.action_id,
       m.target_agent,
       m.source_type,
       m.source_id,
       m.source_url,
       m.title,
       m.payload,
       m.priority,
       m.status,
       m.dry_run,
       m.requires_human_validation,
       m.result,
       m.processed_at,
       m.error_message,
       a.payload_hash,
       a.status as action_status
     from agent_missions m
     join agent_actions a on a.id = m.action_id
     where m.id = $1 AND coalesce(to_jsonb(m)->>'orchestration_version', '1') = '1'`,
    [missionId],
  );

  if (result.rows.length === 0) {
    return c.json({ error: 'Mission not found.' }, 404);
  }

  return c.json({ item: result.rows[0] });
});

app.post('/', async (c) => {
  const body = await c.req.json().catch(() => null);

  if (
    !body ||
    typeof body.target_agent !== 'string' ||
    typeof body.source_type !== 'string' ||
    typeof body.source_id !== 'string' ||
    typeof body.title !== 'string'
  ) {
    return c.json(
      {
        error:
          'Invalid mission. Required: target_agent, source_type, source_id, title.',
      },
      400,
    );
  }

  const priority = body.priority ?? 'medium';

  if (!priorities.includes(priority)) {
    return c.json({ error: 'Invalid priority.' }, 400);
  }

  const payload =
    body.payload && typeof body.payload === 'object'
      ? body.payload
      : {};

  const missionPayload = {
    target_agent: body.target_agent,
    source_type: body.source_type,
    source_id: body.source_id,
    source_url: typeof body.source_url === 'string' ? body.source_url : null,
    title: body.title,
    payload,
    priority,
    dry_run: true,
    requires_human_validation: true,
  };

  const canonicalPayload = {
    profile: 'agentimpact-growth-scanner',
    intent: 'create_agent_mission',
    targets: [body.source_id],
    risk_level: 'read_only',
    dry_run: true,
    payload: missionPayload,
  };

  const payloadHash = createHash('sha256')
    .update(JSON.stringify(canonicalPayload))
    .digest('hex');

  const client = await pool.connect();

  try {
    await client.query('begin');

    const actionResult = await client.query(
      `insert into agent_actions (
         profile,
         intent,
         targets,
         payload,
         payload_hash,
         risk_level,
         dry_run,
         status
       )
       values ($1, $2, $3, $4, $5, $6, true, 'proposed')
       returning id, created_at, payload_hash, status`,
      [
        'agentimpact-growth-scanner',
        'create_agent_mission',
        JSON.stringify([body.source_id]),
        JSON.stringify(missionPayload),
        payloadHash,
        'read_only',
      ],
    );

    const action = actionResult.rows[0];

    await client.query(
      `insert into agent_audit_events (
         action_id,
         event_type,
         actor,
         details
       )
       values ($1, 'created', $2, $3)`,
      [
        action.id,
        'agentimpact-growth-scanner',
        JSON.stringify({
          intent: 'create_agent_mission',
          source_type: body.source_type,
          source_id: body.source_id,
          dry_run: true,
          payload_hash: payloadHash,
        }),
      ],
    );

    const missionResult = await client.query(
      `insert into agent_missions (
         action_id,
         target_agent,
         source_type,
         source_id,
         source_url,
         title,
         payload,
         priority,
         status,
         dry_run,
         requires_human_validation
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', true, true)
       returning *`,
      [
        action.id,
        body.target_agent,
        body.source_type,
        body.source_id,
        typeof body.source_url === 'string' ? body.source_url : null,
        body.title,
        JSON.stringify(payload),
        priority,
      ],
    );

    await client.query('commit');

    // Autopilote scope volontairement etroit : uniquement les missions vers
    // dev-senior (branche + PR, jamais de merge possible cote GitHub — voir
    // la protection de branche). Toute autre cible reste manuelle.
    let autopilot: { engaged: boolean; reason?: string } | null = null;
    const skipAutopilot = body.source_type === 'cursor-hermesctl';
    if (body.target_agent === 'dev-senior' && !skipAutopilot) {
      autopilot = await tryAutopilot(action.id, 'create_agent_mission', action.payload_hash, 'read_only');
    }

    return c.json(
      {
        item: missionResult.rows[0],
        action: {
          id: action.id,
          payload_hash: action.payload_hash,
          status: autopilot?.engaged ? 'approved' : action.status,
        },
        autopilot,
      },
      201,
    );
  } catch (error) {
    await client.query('rollback');

    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === '23505'
    ) {
      return c.json(
        {
          error: 'Duplicate mission.',
          message: 'This source has already generated a mission.',
        },
        409,
      );
    }

    throw error;
  } finally {
    client.release();
  }
});

app.post('/:id/dispatch', async (c) => {
  const missionId = c.req.param('id');
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      missionId,
    )
  ) {
    return c.json({ error: 'Invalid mission id.' }, 400);
  }

  const client = await pool.connect();

  try {
    await client.query('begin');

    const currentResult = await client.query(
      `select m.id, m.status as mission_status, a.status as action_status
       from agent_missions m
       join agent_actions a on a.id = m.action_id
       where m.id = $1 AND coalesce(to_jsonb(m)->>'orchestration_version', '1') = '1'
       for update`,
      [missionId],
    );

    if (currentResult.rows.length === 0) {
      await client.query('rollback');
      return c.json({ error: 'Mission not found.' }, 404);
    }

    const row = currentResult.rows[0];
    const verdict = canDispatch(row.mission_status, row.action_status);

    if (!verdict.allowed) {
      await client.query('rollback');
      return c.json(
        { error: verdict.reason, httpStatus: verdict.httpStatus },
        verdict.httpStatus,
      );
    }

    const updated = await client.query(
      `update agent_missions m
       set status = 'in_progress', updated_at = now()
       where id = $1 AND coalesce(to_jsonb(m)->>'orchestration_version', '1') = '1'
       returning *`,
      [missionId],
    );

    await client.query(
      `insert into agent_audit_events (action_id, event_type, actor, details)
       select action_id, 'dispatched', 'dispatch-missions', $2::jsonb
       from agent_missions m where id = $1 AND coalesce(to_jsonb(m)->>'orchestration_version', '1') = '1'`,
      [
        missionId,
        JSON.stringify({ mission_id: missionId, source: 'dispatch-api' }),
      ],
    );

    await client.query('commit');

    return c.json({ item: updated.rows[0], status: 'in_progress' });
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
});

app.patch('/:id/result', async (c) => {
  const missionId = c.req.param('id');
  const body = await c.req.json().catch(() => null);

  if (
    !body ||
    !body.result ||
    typeof body.result !== 'object' ||
    body.result === null
  ) {
    return c.json(
      { error: 'Required body field: result object.' },
      400,
    );
  }

  const status = body.status ?? 'completed';

  if (!['completed', 'failed', 'rejected'].includes(status)) {
    return c.json(
      { error: 'Status must be completed, failed or rejected.' },
      400,
    );
  }

  const errorMessage =
    typeof body.error_message === 'string'
      ? body.error_message
      : null;

  const client = await pool.connect();

  try {
    await client.query('begin');

    const currentResult = await client.query(
      `select id, action_id, status
       from agent_missions m
       where id = $1 AND coalesce(to_jsonb(m)->>'orchestration_version', '1') = '1'
       for update`,
      [missionId],
    );

    if (currentResult.rows.length === 0) {
      await client.query('rollback');
      return c.json({ error: 'Mission not found.' }, 404);
    }

    const current = currentResult.rows[0];

    if (!['pending', 'in_progress'].includes(current.status)) {
      await client.query('rollback');
      return c.json(
        {
          error: 'Mission is not processable.',
          status: current.status,
        },
        409,
      );
    }

    const missionResult = await client.query(
      `update agent_missions m
       set result = $1,
           status = $2,
           processed_at = now(),
           updated_at = now(),
           error_message = $3
       where id = $4 AND coalesce(to_jsonb(m)->>'orchestration_version', '1') = '1'
       returning *`,
      [
        JSON.stringify(body.result),
        status,
        errorMessage,
        missionId,
      ],
    );

    const actionStatus =
      status === 'completed'
        ? 'executed'
        : status === 'rejected'
          ? 'rejected'
          : 'failed';

    const eventType =
      status === 'completed'
        ? 'executed'
        : status === 'rejected'
          ? 'rejected'
          : 'failed';

    await client.query(
      `update agent_actions
       set status = $1,
           executed_at = now(),
           error_message = $2
       where id = $3`,
      [actionStatus, errorMessage, current.action_id],
    );

    await client.query(
      `insert into agent_audit_events (
         action_id,
         event_type,
         actor,
         details
       )
       values ($1, $2, $3, $4)`,
      [
        current.action_id,
        eventType,
        'agentimpact-growth',
        JSON.stringify({
          mission_id: missionId,
          status,
          source: 'dispatcher',
          error_message: errorMessage,
        }),
      ],
    );

    await client.query('commit');

    return c.json({
      item: missionResult.rows[0],
      status,
    });
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
});

export default app;
