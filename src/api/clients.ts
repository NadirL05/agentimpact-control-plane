/**
 * Produit client recurrent et metriques d'autonomie (semaines 7-8 de la
 * roadmap).
 *
 * Vertical retenu : Client Intelligence OS (agence / consultant). C'est le
 * seul dont tous les connecteurs necessaires sont deja operationnels ici
 * (Drive, Calendar, Slack) : un pilote peut demarrer sans nouvelle
 * integration, donc sans nouveau risque.
 *
 * Le rapport de valeur ne se fabrique pas : il agrege ce que l'audit contient
 * reellement. Une metrique sans donnee est affichee comme telle, jamais a 0.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { pool } from './db.js';
import { driveSearch } from './google.js';
import { postMessage, slackConfigured } from './slack.js';

const app = new Hono();

/** Minutes economisees par type d'action, valeurs assumees et revisables. */
const MINUTES_SAVED: Record<string, number> = {
  fullenrich_enrich: 12,
  drive_move_files: 8,
  github_create_issue: 20,
  outreach_draft: 15,
  morning_brief: 25,
};

const clientSchema = z.object({
  client_key: z.string().regex(/^[a-z0-9-]{2,40}$/),
  name: z.string().min(2).max(120),
  vertical: z
    .enum(['client-intelligence-os', 'devis-prepare', 'factures-relance', 'avis-google', 'leads-qualification'])
    .default('client-intelligence-os'),
  drive_folder_id: z.string().min(5).optional(),
  slack_channel: z.string().min(2).optional(),
  promise: z.string().min(10).max(300),
  setup_fee_eur: z.number().int().min(0).max(100_000).default(1500),
  monthly_fee_eur: z.number().int().min(0).max(100_000).default(450),
});

/** Cree ou met a jour la fiche d'un client pilote. */
app.post('/', async (c) => {
  const parsed = clientSchema.safeParse(await c.req.json().catch(() => null));

  if (!parsed.success) {
    return c.json({ error: 'invalid_body', details: parsed.error.flatten() }, 400);
  }

  const client = parsed.data;

  const existing = await pool.query<{ id: string }>(
    `select id from client_entities where client_key = $1 and entity_type = 'client'`,
    [client.client_key],
  );

  if (existing.rows.length > 0) {
    await pool.query(
      `update client_entities set data = $2::jsonb, updated_at = now() where id = $1`,
      [existing.rows[0].id, JSON.stringify(client)],
    );
    return c.json({ ok: true, updated: true, client_key: client.client_key });
  }

  const inserted = await pool.query<{ id: string }>(
    `insert into client_entities (client_key, entity_type, external_id, data)
     values ($1, 'client', $2, $3::jsonb)
     returning id`,
    [client.client_key, client.drive_folder_id ?? null, JSON.stringify(client)],
  );

  return c.json({ ok: true, id: inserted.rows[0].id, client_key: client.client_key }, 201);
});

app.get('/', async (c) => {
  const result = await pool.query(
    `select client_key, data, created_at
       from client_entities
      where entity_type = 'client'
      order by created_at desc`,
  );

  return c.json({ count: result.rows.length, items: result.rows });
});

type MetricsRow = { status: string; n: string };

/**
 * Metriques d'autonomie. Ce sont elles qui decident si un workflow merite
 * d'etre delie, pas une impression.
 */
async function computeMetrics(days: number) {
  const window = `${days} days`;

  const byStatus = await pool.query<MetricsRow>(
    `select status, count(*)::text as n
       from agent_actions
      where created_at > now() - $1::interval
      group by status`,
    [window],
  );

  const counts: Record<string, number> = {};
  for (const row of byStatus.rows) counts[row.status] = Number(row.n);

  const proposed = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const approved = counts.approved ?? 0;
  const rejected = counts.rejected ?? 0;
  const executed = counts.executed ?? 0;
  const failed = counts.failed ?? 0;
  const rolledBack = counts.rolled_back ?? 0;

  const byIntent = await pool.query<{ intent: string; n: string }>(
    `select intent, count(*)::text as n
       from agent_actions
      where created_at > now() - $1::interval and status in ('executed', 'approved')
      group by intent`,
    [window],
  );

  let minutesSaved = 0;
  const volumes: Record<string, number> = {};

  for (const row of byIntent.rows) {
    const n = Number(row.n);
    volumes[row.intent] = n;
    minutesSaved += n * (MINUTES_SAVED[row.intent] ?? 5);
  }

  const briefs = await pool.query<{ n: string }>(
    `select count(*)::text as n
       from agent_audit_events
      where details->>'stage' = 'morning_brief' and created_at > now() - $1::interval`,
    [window],
  );

  minutesSaved += Number(briefs.rows[0]?.n ?? 0) * MINUTES_SAVED.morning_brief;

  const blocked = await pool.query<{ n: string }>(
    `select count(*)::text as n
       from agent_audit_events
      where event_type = 'blocked_by_policy' and created_at > now() - $1::interval`,
    [window],
  );

  const corrections = await pool.query<{ n: string }>(
    `select count(*)::text as n from agent_corrections where created_at > now() - $1::interval`,
    [window],
  );

  const decided = approved + rejected;

  // Un ratio sans denominateur est faux : on renvoie null, pas 0.
  const ratio = (numerator: number, denominator: number) =>
    denominator > 0 ? Math.round((numerator / denominator) * 100) : null;

  return {
    fenetre_jours: days,
    actions: { proposees: proposed, approuvees: approved, refusees: rejected, executees: executed, echouees: failed, rollback: rolledBack },
    taux_approbation_pct: ratio(approved, decided),
    taux_correction_humaine_pct: ratio(Number(corrections.rows[0]?.n ?? 0), executed),
    taux_rollback_pct: ratio(rolledBack, executed),
    taux_echec_pct: ratio(failed, executed + failed),
    actions_bloquees_par_policy: Number(blocked.rows[0]?.n ?? 0),
    volumes_par_intention: volumes,
    temps_gagne_minutes: minutesSaved,
    temps_gagne_heures: Math.round((minutesSaved / 60) * 10) / 10,
    briefs_envoyes: Number(briefs.rows[0]?.n ?? 0),
    connecteurs: {
      slack: Boolean(process.env.SLACK_BOT_TOKEN),
      fullenrich: Boolean(process.env.FULLENRICH_API_KEY),
      github: Boolean(process.env.GITHUB_TOKEN),
      google: true,
    },
  };
}

app.get('/metrics', async (c) => {
  const days = Math.min(Math.max(Number(c.req.query('days') ?? 30), 1), 365);
  return c.json({ ok: true, metrics: await computeMetrics(days) });
});

/**
 * Verdict d'autonomie : une intention ne se delie que si elle a un historique
 * suffisant, un taux d'approbation eleve et aucun rollback.
 */
app.get('/autonomy', async (c) => {
  const result = await pool.query<{
    intent: string;
    total: string;
    approved: string;
    rejected: string;
    rolled_back: string;
    failed: string;
  }>(
    `select intent,
            count(*)::text as total,
            count(*) filter (where status in ('approved', 'executed'))::text as approved,
            count(*) filter (where status = 'rejected')::text as rejected,
            count(*) filter (where status = 'rolled_back')::text as rolled_back,
            count(*) filter (where status = 'failed')::text as failed
       from agent_actions
      group by intent`,
  );

  const items = result.rows.map((row) => {
    const total = Number(row.total);
    const approved = Number(row.approved);
    const rejected = Number(row.rejected);
    const rolledBack = Number(row.rolled_back);
    const failed = Number(row.failed);
    const approvalRate = total > 0 ? approved / total : 0;

    const blockers: string[] = [];
    if (total < 20) blockers.push(`historique insuffisant (${total}/20)`);
    if (approvalRate < 0.95) blockers.push(`taux d approbation ${Math.round(approvalRate * 100)}% < 95%`);
    if (rolledBack > 0) blockers.push(`${rolledBack} rollback(s)`);
    if (failed > 0) blockers.push(`${failed} echec(s)`);
    if (rejected > 0) blockers.push(`${rejected} refus`);

    return {
      intent: row.intent,
      total,
      taux_approbation_pct: Math.round(approvalRate * 100),
      autonomie_recommandee: blockers.length === 0,
      blocages: blockers,
    };
  });

  return c.json({ count: items.length, items });
});

/**
 * Client Intelligence OS : synthese par client. Lecture seule, chaque ligne
 * pointe sa source.
 */
app.post('/:clientKey/report', async (c) => {
  const clientKey = c.req.param('clientKey');

  const clientResult = await pool.query<{ data: Record<string, unknown> }>(
    `select data from client_entities where client_key = $1 and entity_type = 'client'`,
    [clientKey],
  );

  const client = clientResult.rows[0]?.data;

  if (!client) return c.json({ error: 'client_not_found', client_key: clientKey }, 404);

  const metrics = await computeMetrics(30);

  let documents: string[] = [];
  const folderId = client.drive_folder_id as string | undefined;

  if (folderId) {
    try {
      const files = await driveSearch(
        `'${folderId}' in parents and trashed = false`,
        10,
      );
      documents = files.map(
        (file) =>
          `${file.name} (modifié le ${new Date(file.modifiedTime).toLocaleDateString('fr-FR')})`,
      );
    } catch {
      documents = ['Dossier Drive injoignable'];
    }
  }

  const lines = [
    `*Rapport de valeur — ${client.name as string}*`,
    `Promesse : ${client.promise as string}`,
    '',
    `• Temps gagné : ${metrics.temps_gagne_heures} h sur 30 jours — source : \`agent_actions\``,
    `• Volume traité : ${Object.values(metrics.volumes_par_intention).reduce((a, b) => a + b, 0)} action(s) — source : \`agent_actions\``,
    `• Erreurs évitées : ${metrics.actions_bloquees_par_policy} action(s) bloquée(s) par policy — source : \`agent_audit_events\``,
    `• Taux d'approbation : ${metrics.taux_approbation_pct ?? 'sans décision sur la période'}${
      metrics.taux_approbation_pct != null ? ' %' : ''
    }`,
    `• Rollback : ${metrics.taux_rollback_pct ?? 'aucune exécution'}${
      metrics.taux_rollback_pct != null ? ' %' : ''
    }`,
    documents.length > 0 ? `\n*Documents suivis*\n${documents.map((d) => `• ${d}`).join('\n')}` : '',
    '',
    `_Validation humaine obligatoire sur chaque écriture. Facturation : ${client.setup_fee_eur as number} € setup + ${client.monthly_fee_eur as number} €/mois._`,
  ].filter(Boolean);

  const text = lines.join('\n');

  const slack = slackConfigured()
    ? await postMessage(text, undefined, client.slack_channel as string | undefined)
    : { ok: false as const, error: 'slack_not_configured' };

  await pool.query(
    `insert into agent_audit_events (event_type, actor, details)
     values ('executed', $1, $2::jsonb)`,
    [
      'client-report',
      JSON.stringify({ stage: 'client_report', client_key: clientKey, slack_ok: slack.ok }),
    ],
  );

  return c.json({ ok: true, client_key: clientKey, text, metrics, slack });
});

export default app;
