import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { pool } from './db.js';

const app = new Hono();

const APPROVAL_WINDOW_MINUTES = Number(process.env.APPROVAL_WINDOW_MINUTES ?? 15);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const createSchema = z.object({
  title: z.string().min(3).max(200),
  instruction: z.string().min(10).max(8000),
  target_agent: z.literal('dev-senior'),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
  source_url: z.string().url().startsWith('https://').max(500).nullish(),
  proposed_by_uid: z.number().int().nonnegative(),
  proposed_by: z.string().min(1).max(128).default('agentimpact-runner'),
});

const promoteSchema = z.object({
  reviewed_by: z.string().min(1).max(128),
});

const rejectSchema = z.object({
  reviewed_by: z.string().min(1).max(128),
  reason: z.string().max(2000).optional(),
});

function sanitizeProposal(row: Record<string, unknown>) {
  return {
    id: row.id,
    created_at: row.created_at,
    proposed_by_uid: row.proposed_by_uid,
    proposed_by: row.proposed_by,
    target_agent: row.target_agent,
    title: row.title,
    instruction: row.instruction,
    source_url: row.source_url,
    priority: row.priority,
    status: row.status,
    reviewed_at: row.reviewed_at,
    reviewed_by: row.reviewed_by,
    promoted_action_id: row.promoted_action_id,
    promoted_mission_id: row.promoted_mission_id,
  };
}

app.post('/', async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', details: parsed.error.flatten() }, 400);
  }

  const body = parsed.data;
  const result = await pool.query(
    `insert into cursor_proposals (
       proposed_by_uid, proposed_by, target_agent, title, instruction,
       source_url, priority, status
     )
     values ($1, $2, $3, $4, $5, $6, $7, 'awaiting_nadir_review')
     returning *`,
    [
      body.proposed_by_uid,
      body.proposed_by,
      body.target_agent,
      body.title,
      body.instruction,
      body.source_url ?? null,
      body.priority,
    ],
  );

  const row = result.rows[0];
  return c.json(
    {
      item: sanitizeProposal(row),
      message:
        'Proposition enregistrée. Promotion manuelle par Nadir requise avant toute mission.',
    },
    201,
  );
});

app.get('/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) {
    return c.json({ error: 'invalid_id' }, 400);
  }

  const result = await pool.query(
    `select * from cursor_proposals where id = $1`,
    [id],
  );

  if (result.rows.length === 0) {
    return c.json({ error: 'not_found' }, 404);
  }

  return c.json({ item: sanitizeProposal(result.rows[0]) });
});

app.post('/:id/promote', async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) {
    return c.json({ error: 'invalid_id' }, 400);
  }

  const parsed = promoteSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', details: parsed.error.flatten() }, 400);
  }

  const { reviewed_by: reviewedBy } = parsed.data;
  const client = await pool.connect();

  try {
    await client.query('begin');

    const proposalResult = await client.query(
      `select * from cursor_proposals where id = $1 for update`,
      [id],
    );

    if (proposalResult.rows.length === 0) {
      await client.query('rollback');
      return c.json({ error: 'not_found' }, 404);
    }

    const proposal = proposalResult.rows[0];

    if (proposal.status !== 'awaiting_nadir_review') {
      await client.query('rollback');
      return c.json(
        { error: 'invalid_status', status: proposal.status },
        409,
      );
    }

    const sourceId = `cursor-proposal-${id}`;
    const missionPayload = {
      target_agent: proposal.target_agent,
      source_type: 'cursor-hermesctl',
      source_id: sourceId,
      source_url: proposal.source_url,
      title: proposal.title,
      payload: { instruction: proposal.instruction },
      priority: proposal.priority,
      dry_run: true,
      requires_human_validation: true,
      proposal_id: id,
    };

    const canonicalPayload = {
      profile: 'agentimpact-dev',
      intent: 'create_agent_mission',
      targets: [sourceId],
      risk_level: 'reversible_write',
      dry_run: true,
      payload: missionPayload,
    };

    const payloadHash = createHash('sha256')
      .update(JSON.stringify(canonicalPayload))
      .digest('hex');

    const actionResult = await client.query(
      `insert into agent_actions (
         profile, intent, targets, payload, payload_hash,
         risk_level, dry_run, status, approval_expires_at
       )
       values ($1, $2, $3, $4, $5, $6, true, 'proposed', now() + ($7 || ' minutes')::interval)
       returning id, payload_hash, status, approval_expires_at`,
      [
        'agentimpact-dev',
        'create_agent_mission',
        JSON.stringify([sourceId]),
        JSON.stringify(missionPayload),
        payloadHash,
        'reversible_write',
        String(APPROVAL_WINDOW_MINUTES),
      ],
    );

    const action = actionResult.rows[0];

    await client.query(
      `insert into agent_audit_events (action_id, event_type, actor, details)
       values ($1, 'created', $2, $3)`,
      [
        action.id,
        reviewedBy,
        JSON.stringify({
          intent: 'create_agent_mission',
          source_type: 'cursor-hermesctl',
          proposal_id: id,
          payload_hash: payloadHash,
          autopilot_skipped: true,
        }),
      ],
    );

    const missionResult = await client.query(
      `insert into agent_missions (
         action_id, target_agent, source_type, source_id, source_url,
         title, payload, priority, status, dry_run, requires_human_validation
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', true, true)
       returning id`,
      [
        action.id,
        proposal.target_agent,
        'cursor-hermesctl',
        sourceId,
        proposal.source_url,
        proposal.title,
        JSON.stringify({ instruction: proposal.instruction }),
        proposal.priority === 'normal' ? 'medium' : proposal.priority,
      ],
    );

    const missionId = missionResult.rows[0].id;

    await client.query(
      `update cursor_proposals
       set status = 'promoted',
           reviewed_at = now(),
           reviewed_by = $2,
           promoted_action_id = $3,
           promoted_mission_id = $4
       where id = $1`,
      [id, reviewedBy, action.id, missionId],
    );

    await client.query('commit');

    return c.json({
      proposal_id: id,
      status: 'promoted',
      action_id: action.id,
      mission_id: missionId,
      message:
        'Mission créée en pending. Validation et dispatch restent soumis au workflow existant.',
    });
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
});

app.post('/:id/reject', async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) {
    return c.json({ error: 'invalid_id' }, 400);
  }

  const parsed = rejectSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', details: parsed.error.flatten() }, 400);
  }

  const result = await pool.query(
    `update cursor_proposals
     set status = 'rejected',
         reviewed_at = now(),
         reviewed_by = $2
     where id = $1 and status = 'awaiting_nadir_review'
     returning *`,
    [id, parsed.data.reviewed_by],
  );

  if (result.rows.length === 0) {
    return c.json({ error: 'not_found_or_not_pending' }, 404);
  }

  return c.json({ item: sanitizeProposal(result.rows[0]) });
});

export default app;
