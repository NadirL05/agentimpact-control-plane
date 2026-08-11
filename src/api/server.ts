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
import leads from './leads.js';

const app = new Hono();

app.route('/leads', leads);

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

async function approveActionWithPayload(
  actionId: string,
  approver: string,
  payloadHash: string,
  client: any,
) {
  const result = await client.query(
    `select id, profile, intent, payload, payload_hash, risk_level, status
     from agent_actions
     where id = $1
     for update`,
    [actionId],
  );

  if (result.rows.length === 0) {
    throw new Error('Action not found');
  }

  const action = result.rows[0];

  if (!APPROVABLE_STATUSES.includes(action.status)) {
    throw new Error(`Action cannot be approved from status ${action.status}`);
  }

  if (action.payload_hash !== payloadHash) {
    throw new Error('Payload hash mismatch');
  }

  await client.query(
    `insert into agent_approvals (
      action_id, approver, decision, payload_hash
    )
    values ($1, $2, 'approved', $3)`,
    [actionId, approver, payloadHash],
  );

  await client.query(
    `insert into agent_audit_events (
      action_id, event_type, actor, details
    )
    values ($1, 'approved', $2, $3)`,
    [
      actionId,
      approver,
      JSON.stringify({
        payload_hash: payloadHash,
        source: 'approval-api',
      }),
    ],
  );

  let createdLead = null;
  const shouldCreateLead = action.intent === 'create_lead';

  if (shouldCreateLead) {
    const lead = action.payload?.lead;

    if (!lead || typeof lead.company_name !== 'string') {
      throw new Error('Invalid create_lead payload');
    }

    const leadResult = await client.query(
      `insert into leads (
        source, company_name, contact_name, contact_role,
        website, email, status, priority, pain_point,
        signal, last_note, owner_profile
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
      )
      returning id, created_at, company_name, status, priority, owner_profile`,
      [
        lead.source ?? null,
        lead.company_name,
        lead.contact_name ?? null,
        lead.contact_role ?? null,
        lead.website ?? null,
        lead.email ?? null,
        lead.status ?? 'new',
        lead.priority ?? 'medium',
        lead.pain_point ?? null,
        lead.signal ?? null,
        lead.last_note ?? null,
        lead.owner_profile ?? action.profile,
      ],
    );

    createdLead = leadResult.rows[0];
  }

  const finalStatus = shouldCreateLead ? 'executed' : 'approved';

  const updateResult = await client.query(
    `update agent_actions
     set status = $1,
         executed_at = case when $1 = 'executed' then now() else executed_at end
     where id = $2
     returning id, status, executed_at`,
    [finalStatus, actionId],
  );

  if (shouldCreateLead) {
    await client.query(
      `insert into agent_audit_events (
        action_id, event_type, actor, details
      )
      values ($1, 'executed', $2, $3)`,
      [
        actionId,
        approver,
        JSON.stringify({
          payload_hash: payloadHash,
          effect: 'lead_created',
          lead_id: createdLead.id,
        }),
      ],
    );
  }

  return {
    action: updateResult.rows[0],
    lead: createdLead,
  };
}

app.patch('/actions/:id/approve', async (c) => {
  const actionId = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));

  if (
    typeof body.approver !== 'string' ||
    body.approver.trim().length === 0 ||
    typeof body.payload_hash !== 'string' ||
    body.payload_hash.length !== 64
  ) {
    return c.json(
      {
        error: 'Approval requires approver and exact payload_hash.',
      },
      400,
    );
  }

  const client = await pool.connect();

  try {
    await client.query('begin');

    const result = await approveActionWithPayload(
      actionId,
      body.approver,
      body.payload_hash,
      client,
    );

    await client.query('commit');

    return c.json(
      {
        approved: true,
        item: result.action,
        lead: result.lead,
      },
    );
  } catch (error) {
    await client.query('rollback');

    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === '23505'
    ) {
      return c.json(
        {
          error: 'Approval already exists for this action and payload hash.',
        },
        409,
      );
    }

    if (error instanceof Error) {
      if (error.message === 'Action not found') {
        return c.json({ error: error.message }, 404);
      }

      if (
        error.message.includes('cannot be approved') ||
        error.message.includes('Payload hash mismatch') ||
        error.message.includes('Invalid create_lead payload')
      ) {
        return c.json({ error: error.message }, 409);
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
