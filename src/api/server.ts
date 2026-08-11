/**
 * API HTTP AgentImpact : control plane + audit PostgreSQL.
 */

import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getHermesProfiles } from '../core/hermes-profiles.js';
import { getPolicies } from '../core/policies.js';
import { getWorkflows } from '../core/workflows.js';
import { pool } from './db.js';

const app = new Hono();

app.use('*', cors({ origin: 'http://localhost:8081' }));

app.get('/health', async (c) => {
  try {
    await pool.query('select 1');
    return c.json({
      status: 'ok',
      database: 'ok',
      timestamp: new Date().toISOString(),
    });
  } catch {
    return c.json(
      {
        status: 'degraded',
        database: 'unavailable',
        timestamp: new Date().toISOString(),
      },
      503,
    );
  }
});

app.get('/profiles', (c) => {
  const profiles = getHermesProfiles();
  return c.json({ count: profiles.length, items: profiles });
});

app.get('/policies', (c) => {
  const policies = getPolicies();
  return c.json({ count: policies.length, items: policies });
});

app.get('/workflows', (c) => {
  const workflows = getWorkflows();
  return c.json({ count: workflows.length, items: workflows });
});

app.get('/actions', async (c) => {
  const requestedLimit = Number(c.req.query('limit') ?? 50);
  const limit = Number.isInteger(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 100)
    : 50;

  const result = await pool.query(
    `select
       id, created_at, profile, intent, targets, payload_hash,
       risk_level, dry_run, status, executed_at, error_message
     from agent_actions
     order by created_at desc
     limit $1`,
    [limit],
  );

  return c.json({ count: result.rows.length, items: result.rows });
});

app.post('/actions', async (c) => {
  const body = await c.req.json().catch(() => null);

  if (
    !body ||
    typeof body.profile !== 'string' ||
    typeof body.intent !== 'string' ||
    typeof body.risk_level !== 'string' ||
    typeof body.payload !== 'object' ||
    body.payload === null
  ) {
    return c.json(
      {
        error: 'Invalid action. Required: profile, intent, risk_level, payload.',
      },
      400,
    );
  }

  const allowedRiskLevels = [
    'read_only',
    'reversible_write',
    'irreversible_write',
    'sensitive',
  ];

  if (!allowedRiskLevels.includes(body.risk_level)) {
    return c.json({ error: 'Invalid risk_level.' }, 400);
  }

  const targets = Array.isArray(body.targets) ? body.targets : [];
  const dryRun = body.dry_run !== false;

  const canonicalPayload = {
    profile: body.profile,
    intent: body.intent,
    targets,
    payload: body.payload,
    risk_level: body.risk_level,
    dry_run: dryRun,
  };

  const payloadHash = createHash('sha256')
    .update(JSON.stringify(canonicalPayload))
    .digest('hex');

  const client = await pool.connect();

  try {
    await client.query('begin');

    const actionResult = await client.query(
      `insert into agent_actions (
        profile, intent, targets, payload, payload_hash,
        risk_level, dry_run, status
      )
      values ($1, $2, $3, $4, $5, $6, $7, 'proposed')
      returning id, created_at, profile, intent, targets, payload_hash,
                risk_level, dry_run, status`,
      [
        body.profile,
        body.intent,
        JSON.stringify(targets),
        JSON.stringify(body.payload),
        payloadHash,
        body.risk_level,
        dryRun,
      ],
    );

    const action = actionResult.rows[0];

    await client.query(
      `insert into agent_audit_events (
        action_id, event_type, actor, details
      )
      values ($1, 'created', $2, $3)`,
      [
        action.id,
        body.profile,
        JSON.stringify({
          payload_hash: payloadHash,
          dry_run: dryRun,
          source: 'api',
        }),
      ],
    );

    await client.query('commit');

    return c.json({ item: action }, 201);
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
          error: 'Duplicate action payload.',
          message: 'This exact action already exists.',
          payload_hash: payloadHash,
        },
        409,
      );
    }

    throw error;
  } finally {
    client.release();
  }
});

const APPROVABLE_STATUSES = ['proposed', 'approval_requested'];

async function updateActionStatus(
  actionId: string,
  newStatus: 'approved' | 'rejected',
  actor: string,
  client: any,
) {
  const currentResult = await client.query(
    `select id, status from agent_actions where id = $1`,
    [actionId],
  );

  if (currentResult.rows.length === 0) {
    throw new Error('Action not found');
  }

  const currentStatus = currentResult.rows[0].status;

  if (!APPROVABLE_STATUSES.includes(currentStatus)) {
    throw new Error(`Action cannot be ${newStatus}ed from status ${currentStatus}`);
  }

  const updateResult = await client.query(
    `update agent_actions
     set status = $1,
         executed_at = now()
     where id = $2
     returning id, status, executed_at`,
    [newStatus, actionId],
  );

  const updated = updateResult.rows[0];

  await client.query(
    `insert into agent_audit_events (
      action_id, event_type, actor, details
    )
    values ($1, $2, $3, $4)`,
    [
      actionId,
      newStatus,
      actor,
      JSON.stringify({
        previous_status: currentStatus,
        source: 'dashboard',
      }),
    ],
  );

  return updated;
}

app.patch('/actions/:id/approve', async (c) => {
  const actionId = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const actor = typeof body.actor === 'string' ? body.actor : 'dashboard-operator';

  const client = await pool.connect();

  try {
    await client.query('begin');

    const updated = await updateActionStatus(actionId, 'approved', actor, client);

    await client.query('commit');

    return c.json({ item: updated });
  } catch (error) {
    await client.query('rollback');

    if (
      typeof error === 'object' &&
      error !== null &&
      'message' in error &&
      typeof (error as any).message === 'string'
    ) {
      const msg = (error as any).message;
      if (msg.includes('not found')) {
        return c.json({ error: 'Action not found.' }, 404);
      }
      if (msg.includes('cannot be')) {
        return c.json({ error: msg }, 409);
      }
    }

    throw error;
  } finally {
    client.release();
  }
});

app.patch('/actions/:id/reject', async (c) => {
  const actionId = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const actor = typeof body.actor === 'string' ? body.actor : 'dashboard-operator';

  const client = await pool.connect();

  try {
    await client.query('begin');

    const updated = await updateActionStatus(actionId, 'rejected', actor, client);

    await client.query('commit');

    return c.json({ item: updated });
  } catch (error) {
    await client.query('rollback');

    if (
      typeof error === 'object' &&
      error !== null &&
      'message' in error &&
      typeof (error as any).message === 'string'
    ) {
      const msg = (error as any).message;
      if (msg.includes('not found')) {
        return c.json({ error: 'Action not found.' }, 404);
      }
      if (msg.includes('cannot be')) {
        return c.json({ error: msg }, 409);
      }
    }

    throw error;
  } finally {
    client.release();
  }
});

const port = Number(process.env.PORT) || 3000;
console.log(`Server starting on port ${port}`);

export default { port, handler: app.fetch };

if (import.meta.vitest == null) {
  const { serve } = await import('@hono/node-server');
  serve({
    fetch: app.fetch,
    port,
  });
}
