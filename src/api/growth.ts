/**
 * Growth OS (semaine 7 de la roadmap) : machine de preparation commerciale.
 *
 * Deux garde-fous structurels :
 *  - aucune route d'envoi n'existe dans ce module. Un brouillon reste un
 *    brouillon ; l'envoi se fait ailleurs, apres decision humaine ;
 *  - une fiche sans preuve publique n'est pas qualifiee. Le champ `preuve`
 *    ne peut pas etre invente : il pointe une donnee reellement en base.
 */

import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { pool } from './db.js';
import { postMessage, slackConfigured } from './slack.js';
import {
  buildFiche,
  count,
  renderDraft,
  type LeadRow,
} from '../core/lead-scoring.js';

const app = new Hono();

const PROFILE = 'agentimpact-growth';

const qualifySchema = z.object({ lead_id: z.string().uuid() });

const draftSchema = z.object({
  lead_id: z.string().uuid(),
  channel: z.enum(['email', 'linkedin']).default('email'),
  template: z.string().min(1).optional(),
});

/** Fiche prospect d'un lead. Lecture seule. */
app.post('/qualify', async (c) => {
  const parsed = qualifySchema.safeParse(await c.req.json().catch(() => null));

  if (!parsed.success) {
    return c.json({ error: 'invalid_body', details: parsed.error.flatten() }, 400);
  }

  const result = await pool.query<LeadRow>(`select * from leads where id = $1`, [
    parsed.data.lead_id,
  ]);

  const lead = result.rows[0];
  if (!lead) return c.json({ error: 'lead_not_found' }, 404);

  return c.json({ ok: true, fiche: buildFiche(lead) });
});

/** Les fiches du portefeuille, triees par priorite. */
app.get('/pipeline', async (c) => {
  const result = await pool.query<LeadRow>(
    `select * from leads where status <> 'lost' order by created_at desc limit 50`,
  );

  const fiches = result.rows
    .map(buildFiche)
    .sort((a, b) => b.score - a.score);

  const byPriority = { A: 0, B: 0, C: 0 };
  for (const fiche of fiches) byPriority[fiche.priorite] += 1;

  return c.json({ count: fiches.length, by_priority: byPriority, items: fiches });
});

/**
 * Prepare un brouillon. Il reste en statut `draft` : aucune route de ce
 * module ne peut l'envoyer.
 */
app.post('/draft', async (c) => {
  const parsed = draftSchema.safeParse(await c.req.json().catch(() => null));

  if (!parsed.success) {
    return c.json({ error: 'invalid_body', details: parsed.error.flatten() }, 400);
  }

  const { lead_id: leadId, channel } = parsed.data;

  const result = await pool.query<LeadRow>(`select * from leads where id = $1`, [leadId]);
  const lead = result.rows[0];

  if (!lead) return c.json({ error: 'lead_not_found' }, 404);

  const fiche = buildFiche(lead);

  // Regle roadmap : chaque fiche doit porter une preuve publique.
  if (fiche.preuve.length === 0) {
    return c.json(
      { error: 'no_public_proof', message: 'Fiche sans preuve : pas de brouillon.', fiche },
      422,
    );
  }

  if (channel === 'email' && !lead.email && count(lead.contact_work_emails) === 0) {
    return c.json(
      { error: 'no_email', message: 'Aucun email connu : enrichir le lead d abord.', fiche },
      422,
    );
  }

  const { subject, body } = renderDraft(fiche, lead, channel);
  const toEmail = lead.email ?? (Array.isArray(lead.contact_work_emails) ? lead.contact_work_emails[0] : null);

  // Un brouillon email n'est envoyable qu'apres approbation de l'action liee
  // (voir outreach.ts:/send). draft.status seul ne suffit jamais a envoyer.
  const actionPayload = { lead_id: leadId, channel, to_email: toEmail, subject, body };
  const payloadHash = createHash('sha256')
    .update(JSON.stringify({ payload: actionPayload, nonce: randomUUID() }))
    .digest('hex');

  const action = await pool.query<{ id: string }>(
    `insert into agent_actions
       (profile, intent, targets, payload, payload_hash, risk_level, dry_run, status)
     values ($1, 'outreach_send', $2::jsonb, $3::jsonb, $4, 'sensitive', false, 'proposed')
     returning id`,
    [PROFILE, JSON.stringify([leadId]), JSON.stringify(actionPayload), payloadHash],
  );
  const actionId = action.rows[0].id;

  const inserted = await pool.query<{ id: string }>(
    `insert into outreach_drafts (lead_id, channel, subject, body, status, to_email, action_id)
     values ($1, $2, $3, $4, 'pending_approval', $5, $6)
     returning id`,
    [leadId, channel, channel === 'email' ? subject : null, body, toEmail, actionId],
  );
  const draftId = inserted.rows[0].id;

  await pool.query(
    `insert into agent_audit_events (action_id, event_type, actor, details)
     values ($1, 'created', $2, $3::jsonb)`,
    [
      actionId,
      PROFILE,
      JSON.stringify({
        stage: 'outreach_draft_created',
        draft_id: draftId,
        lead_id: leadId,
        channel,
        score: fiche.score,
        priorite: fiche.priorite,
      }),
    ],
  );

  if (slackConfigured()) {
    await postMessage(
      `Brouillon ${channel} préparé pour *${fiche.entreprise}* (priorité ${fiche.priorite}, score ${fiche.score}/100)\n` +
        `Preuve : ${fiche.preuve[0]}\n` +
        `\`\`\`${body.slice(0, 800)}\`\`\`\n` +
        `Valider : \`!approve ${actionId}\` puis \`POST /api/outreach/send {"draft_id":"${draftId}"}\`.`,
    );
  }

  return c.json({ ok: true, draft_id: draftId, action_id: actionId, payload_hash: payloadHash, fiche, subject, body });
});

/** Brouillons en attente de relecture humaine. */
app.get('/drafts', async (c) => {
  const result = await pool.query(
    `select d.id, d.lead_id, d.channel, d.subject, d.status, d.created_at,
            l.company_name
       from outreach_drafts d
       left join leads l on l.id = d.lead_id
      order by d.created_at desc
      limit 50`,
  );

  return c.json({ count: result.rows.length, items: result.rows });
});

export default app;
