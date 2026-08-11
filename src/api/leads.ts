import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { pool } from './db.js';

const app = new Hono();

const statuses = ['new', 'qualified', 'contacted', 'won', 'lost', 'nurture'] as const;
const priorities = ['low', 'medium', 'high'] as const;

const leadInputSchema = z.object({
  source: z.string().trim().max(100).optional().nullable(),
  company_name: z.string().trim().min(1).max(200),
  contact_name: z.string().trim().max(200).optional().nullable(),
  contact_role: z.string().trim().max(200).optional().nullable(),
  website: z.string().trim().max(500).optional().nullable(),
  email: z.string().trim().email().max(320).optional().nullable(),
  status: z.enum(statuses).default('new'),
  priority: z.enum(priorities).default('medium'),
  pain_point: z.string().trim().max(2000).optional().nullable(),
  signal: z.string().trim().max(2000).optional().nullable(),
  last_note: z.string().trim().max(2000).optional().nullable(),
  owner_profile: z.string().trim().max(100).default('agentimpact-growth'),
  dry_run: z.boolean().default(true),
});

const leadColumns = `
  id, created_at, source, company_name, contact_name,
  contact_role, website, email, status, priority,
  pain_point, signal, last_note, last_contact_at, owner_profile
`;

app.get('/', async (c) => {
  const rawLimit = Number(c.req.query('limit') ?? 50);
  const limit = Number.isInteger(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), 100)
    : 50;

  const status = c.req.query('status');
  const priority = c.req.query('priority');

  if (status && !statuses.includes(status as (typeof statuses)[number])) {
    return c.json({ error: 'Invalid status.' }, 400);
  }

  if (priority && !priorities.includes(priority as (typeof priorities)[number])) {
    return c.json({ error: 'Invalid priority.' }, 400);
  }

  const values: unknown[] = [];
  const conditions: string[] = [];

  if (status) {
    values.push(status);
    conditions.push(`status = $${values.length}`);
  }

  if (priority) {
    values.push(priority);
    conditions.push(`priority = $${values.length}`);
  }

  values.push(limit);

  const where = conditions.length
    ? `where ${conditions.join(' and ')}`
    : '';

  const result = await pool.query(
    `select ${leadColumns}
     from leads
     ${where}
     order by created_at desc
     limit $${values.length}`,
    values,
  );

  return c.json({ count: result.rows.length, items: result.rows });
});

app.get('/:id', async (c) => {
  const id = c.req.param('id');

  if (!z.string().uuid().safeParse(id).success) {
    return c.json({ error: 'Invalid lead id.' }, 400);
  }

  const result = await pool.query(
    `select ${leadColumns} from leads where id = $1`,
    [id],
  );

  if (result.rows.length === 0) {
    return c.json({ error: 'Lead not found.' }, 404);
  }

  return c.json({ item: result.rows[0] });
});

app.post('/', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = leadInputSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { error: 'Invalid lead.', details: parsed.error.flatten() },
      400,
    );
  }

  const lead = parsed.data;

  if (!lead.dry_run) {
    const actionPayload = {
      lead,
      source: 'api/leads',
    };

    const payloadHash = createHash('sha256')
      .update(JSON.stringify(actionPayload))
      .digest('hex');

    const client = await pool.connect();

    try {
      await client.query('begin');

      const actionResult = await client.query(
        `insert into agent_actions (
          profile, intent, targets, payload, payload_hash,
          risk_level, dry_run, status
        )
        values ($1, 'create_lead', $2, $3, $4, 'reversible_write', false, 'proposed')
        returning id, created_at, profile, intent, targets,
                  payload_hash, risk_level, dry_run, status`,
        [
          lead.owner_profile,
          JSON.stringify([lead.company_name]),
          JSON.stringify(actionPayload),
          payloadHash,
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
          lead.owner_profile,
          JSON.stringify({
            payload_hash: payloadHash,
            intent: 'create_lead',
            source: 'api/leads',
          }),
        ],
      );

      await client.query('commit');

      return c.json(
        {
          approval_required: true,
          message: 'Lead proposal created. Approval required before insertion.',
          action,
        },
        202,
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
            error: 'Duplicate lead proposal.',
            payload_hash: payloadHash,
          },
          409,
        );
      }

      throw error;
    } finally {
      client.release();
    }
  }

  return c.json(
    {
      dry_run: true,
      message: 'Lead validated but not persisted.',
      item: lead,
    },
    202,
  );
});

export default app;
