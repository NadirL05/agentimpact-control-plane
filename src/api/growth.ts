/**
 * Growth OS (semaine 7 de la roadmap) : machine de preparation commerciale.
 *
 * Deux garde-fous structurels :
 *  - aucune route d'envoi n'existe dans ce module. Un brouillon reste un
 *    brouillon ; l'envoi se fait ailleurs, apres decision humaine ;
 *  - une fiche sans preuve publique n'est pas qualifiee. Le champ `preuve`
 *    ne peut pas etre invente : il pointe une donnee reellement en base.
 */

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

  const inserted = await pool.query<{ id: string }>(
    `insert into outreach_drafts (lead_id, channel, subject, body, status)
     values ($1, $2, $3, $4, 'draft')
     returning id`,
    [leadId, channel, channel === 'email' ? subject : null, body],
  );

  await pool.query(
    `insert into agent_audit_events (event_type, actor, details)
     values ('created', $1, $2::jsonb)`,
    [
      PROFILE,
      JSON.stringify({
        stage: 'outreach_draft_created',
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
        `_Brouillon non envoyé. Aucune route d'envoi n'existe côté agent._`,
    );
  }

  return c.json({ ok: true, draft_id: inserted.rows[0].id, fiche, subject, body });
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
