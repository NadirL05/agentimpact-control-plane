/**
 * Circuit de validation (semaine 3 de la roadmap, + autopilote).
 *
 * Regles tenues ici, pas cote client :
 *  - une approbation porte sur un payload_hash precis, jamais sur "oui vas-y" ;
 *  - une approbation expire (fenetre courte) ;
 *  - une approbation ne peut pas etre rejouee (contrainte unique
 *    agent_approvals(action_id, payload_hash)) ;
 *  - un profil ne peut pas s'auto-approuver ;
 *  - un refus est audite au meme titre qu'une acceptation.
 *
 * recordDecision() est le seul chemin d'ecriture d'une decision — humaine via
 * POST /, ou automatique via autopilot.ts. Meme regles, meme audit, la seule
 * difference est qui figure comme `approver`.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { pool } from './db.js';
import { approvalBlocks, postMessage, slackConfigured } from './slack.js';
import {
  APPROVABLE_STATUSES,
  evaluateApproval,
  isApprovable,
} from '../core/approval-rules.js';
import { resolveHumanApprover } from '../core/approval-identity.js';
import type { AppEnv } from '../core/hono-env.js';

const app = new Hono<AppEnv>();

const APPROVAL_WINDOW_MINUTES = Number(process.env.APPROVAL_WINDOW_MINUTES ?? 15);

const requestSchema = z.object({
  action_id: z.string().uuid(),
  channel: z.string().min(1).optional(),
});

const decisionSchema = z.object({
  action_id: z.string().uuid(),
  decision: z.enum(['approved', 'rejected']),
  payload_hash: z.string().min(8).optional(),
  reason: z.string().max(2000).optional(),
});

export type ActionRow = {
  id: string;
  profile: string;
  intent: string;
  targets: unknown;
  payload: unknown;
  payload_hash: string;
  risk_level: string;
  dry_run: boolean;
  status: string;
  approval_expires_at: string | null;
};

export async function logEvent(
  actionId: string,
  eventType: 'created' | 'approval_requested' | 'approved' | 'rejected' | 'blocked_by_policy',
  actor: string,
  details: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `insert into agent_audit_events (action_id, event_type, actor, details)
     values ($1, $2, $3, $4::jsonb)`,
    [actionId, eventType, actor, JSON.stringify(details)],
  );
}

export type DecisionResult =
  | { ok: true; httpStatus: 200; action: unknown; approval: unknown }
  | { ok: false; httpStatus: 404 | 409 | 400 | 403; error: string; details?: Record<string, unknown> };

/**
 * Enregistre une decision (approuve/refuse), qu'elle vienne d'un humain ou
 * d'une politique d'autopilote. Transaction unique, verrouillee.
 */
export async function recordDecision(params: {
  actionId: string;
  decision: 'approved' | 'rejected';
  approver: string;
  payloadHash?: string;
  reason?: string;
}): Promise<DecisionResult> {
  const { actionId, decision, approver, payloadHash: providedHash, reason } = params;
  const client = await pool.connect();

  try {
    await client.query('begin');

    const result = await client.query<ActionRow>(
      `select id, profile, intent, targets, payload, payload_hash, risk_level,
              dry_run, status, approval_expires_at
         from agent_actions
        where id = $1
        for update`,
      [actionId],
    );

    const action = result.rows[0];

    if (!action) {
      await client.query('rollback');
      return { ok: false, httpStatus: 404, error: 'action_not_found' };
    }

    const verdict = evaluateApproval(
      {
        profile: action.profile,
        status: action.status,
        payload_hash: action.payload_hash,
        approval_expires_at: action.approval_expires_at,
      },
      { decision, approver, payload_hash: providedHash },
      Date.now(),
    );

    if (!verdict.allowed) {
      if (verdict.reason === 'approval_expired') {
        await client.query(
          `update agent_actions set status = 'rejected', error_message = 'approval_expired'
            where id = $1`,
          [actionId],
        );
        await client.query('commit');
        await logEvent(actionId, 'rejected', approver, {
          reason: 'approval_expired',
          expires_at: action.approval_expires_at,
        });
        return {
          ok: false,
          httpStatus: verdict.httpStatus,
          error: 'approval_expired',
          details: { expires_at: action.approval_expires_at },
        };
      }

      await client.query('rollback');

      if (
        verdict.reason === 'payload_hash_mismatch' ||
        verdict.reason === 'self_approval_forbidden'
      ) {
        await logEvent(actionId, 'blocked_by_policy', approver, { reason: verdict.reason });
      }

      return {
        ok: false,
        httpStatus: verdict.httpStatus,
        error: verdict.reason,
        details: {
          ...(verdict.reason === 'payload_hash_required' || verdict.reason === 'payload_hash_mismatch'
            ? { expected: action.payload_hash }
            : {}),
          ...(verdict.reason === 'invalid_status' ? { status: action.status } : {}),
        },
      };
    }

    const approvalResult = await client.query(
      `insert into agent_approvals (action_id, approver, decision, reason, payload_hash, expires_at)
       values ($1, $2, $3, $4, $5, $6)
       returning id, action_id, approver, decision, decided_at`,
      [actionId, approver, decision, reason ?? null, action.payload_hash, action.approval_expires_at],
    );

    const updateResult = await client.query(
      `update agent_actions
          set status = $2, approved_at = now(), approved_by = $3
        where id = $1
        returning id, status, approved_at, approved_by`,
      [actionId, decision, approver],
    );

    await client.query('commit');

    await logEvent(actionId, decision, approver, {
      payload_hash: action.payload_hash,
      reason: reason ?? null,
    });

    if (slackConfigured()) {
      const verb = decision === 'approved' ? 'validée' : 'refusée';
      await postMessage(
        `Action ${verb} par ${approver} — ${action.intent} (\`${actionId}\`)${
          reason ? ` · ${reason}` : ''
        }`,
      );
    }

    return {
      ok: true,
      httpStatus: 200,
      action: updateResult.rows[0],
      approval: approvalResult.rows[0],
    };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);

    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === '23505'
    ) {
      return {
        ok: false,
        httpStatus: 409,
        error: 'approval_already_used',
        details: { message: 'Cette approbation a deja ete utilisee.' },
      };
    }

    throw error;
  } finally {
    client.release();
  }
}

/** Actions en attente d'une decision humaine. */
app.get('/pending', async (c) => {
  const result = await pool.query(
    `select id, created_at, profile, intent, targets, payload_hash, risk_level,
            dry_run, status, approval_expires_at
       from agent_actions
      where status = any($1)
      order by created_at desc
      limit 50`,
    [APPROVABLE_STATUSES],
  );

  const now = Date.now();
  const items = result.rows.map((row) => ({
    ...row,
    expired:
      row.approval_expires_at != null &&
      new Date(row.approval_expires_at).getTime() <= now,
  }));

  return c.json({ count: items.length, items });
});

/**
 * Demande une validation : arme la fenetre d'expiration et notifie Slack.
 * Le message porte le payload : l'humain valide un effet precis.
 */
app.post('/request', async (c) => {
  const parsed = requestSchema.safeParse(await c.req.json().catch(() => null));

  if (!parsed.success) {
    return c.json({ error: 'invalid_body', details: parsed.error.flatten() }, 400);
  }

  const { action_id: actionId, channel } = parsed.data;

  const result = await pool.query<ActionRow>(
    `select id, profile, intent, targets, payload, payload_hash, risk_level,
            dry_run, status, approval_expires_at
       from agent_actions
      where id = $1`,
    [actionId],
  );

  const action = result.rows[0];

  if (!action) return c.json({ error: 'action_not_found' }, 404);

  if (!isApprovable(action.status)) {
    return c.json(
      { error: 'invalid_status', status: action.status, message: 'Action deja traitee.' },
      409,
    );
  }

  const updated = await pool.query<{ approval_expires_at: string }>(
    `update agent_actions
        set status = 'approval_requested',
            approval_expires_at = now() + ($2 || ' minutes')::interval
      where id = $1
      returning approval_expires_at`,
    [actionId, String(APPROVAL_WINDOW_MINUTES)],
  );

  const expiresAt = updated.rows[0].approval_expires_at;

  await logEvent(actionId, 'approval_requested', action.profile, {
    payload_hash: action.payload_hash,
    expires_at: expiresAt,
    window_minutes: APPROVAL_WINDOW_MINUTES,
  });

  const slack = slackConfigured()
    ? await postMessage(
        `Validation demandée : ${action.intent} (${action.profile})`,
        approvalBlocks({ ...action, expires_at: expiresAt }),
        channel,
      )
    : ({ ok: false, error: 'slack_not_configured' } as const);

  return c.json({
    ok: true,
    action_id: actionId,
    payload_hash: action.payload_hash,
    expires_at: expiresAt,
    slack,
  });
});

/** Enregistre la decision humaine (scope admin uniquement, identité serveur). */
app.post('/', async (c) => {
  const scope = c.get('authScope');
  const approver = resolveHumanApprover(scope);
  if (!approver) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const parsed = decisionSchema.safeParse(await c.req.json().catch(() => null));

  if (!parsed.success) {
    return c.json({ error: 'invalid_body', details: parsed.error.flatten() }, 400);
  }

  const result = await recordDecision({
    actionId: parsed.data.action_id,
    decision: parsed.data.decision,
    approver,
    payloadHash: parsed.data.payload_hash,
    reason: parsed.data.reason,
  });

  if (!result.ok) {
    return c.json({ error: result.error, ...result.details }, result.httpStatus);
  }

  return c.json({ success: true, action: result.action, approval: result.approval });
});

export default app;
