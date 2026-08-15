/**
 * Sites de demonstration client (semaine 7 bis).
 *
 * dev-senior ecrit les fichiers directement dans le dossier partage monte
 * (/workspace-demos cote sandbox, /opt/agentimpact/demos cote hote, servi
 * par nginx sur demo.agentimpact.fr). Ce module ne genere rien : il
 * enregistre ce qui existe deja sur disque, avec une date d'expiration.
 *
 * L'envoi du lien au client passe par le circuit outreach existant
 * (approbation humaine) — ce module ne notifie jamais un client directement.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { pool } from './db.js';
import { postMessage, slackConfigured } from './slack.js';

const app = new Hono();

const DEMOS_ROOT = '/opt/agentimpact/demos';
const DEFAULT_TTL_DAYS = Number(process.env.DEMO_TTL_DAYS ?? 14);
const PUBLIC_BASE = process.env.DEMO_PUBLIC_BASE ?? 'https://demo.agentimpact.fr';

const slugPattern = /^[a-z0-9][a-z0-9-]{2,48}[a-z0-9]$/;

const registerSchema = z.object({
  slug: z.string().regex(slugPattern, 'slug: minuscules/chiffres/tirets, 4-50 caracteres'),
  title: z.string().min(3).max(200),
  lead_id: z.string().uuid().optional(),
  mission_id: z.string().uuid().optional(),
  ttl_days: z.number().int().min(1).max(60).optional(),
});

/**
 * Enregistre un demo deja ecrit sur disque par dev-senior. Refuse si le
 * fichier n'existe pas reellement : pas de ligne DB pour un site fantome.
 */
app.post('/register', async (c) => {
  const parsed = registerSchema.safeParse(await c.req.json().catch(() => null));

  if (!parsed.success) {
    return c.json({ error: 'invalid_body', details: parsed.error.flatten() }, 400);
  }

  const { slug, title, lead_id: leadId, mission_id: missionId, ttl_days: ttlDays } = parsed.data;

  const indexPath = `${DEMOS_ROOT}/${slug}/index.html`;
  if (!existsSync(indexPath)) {
    return c.json(
      { error: 'demo_not_found_on_disk', message: `${indexPath} n existe pas.` },
      404,
    );
  }

  const ttl = ttlDays ?? DEFAULT_TTL_DAYS;

  const inserted = await pool.query<{ id: string; expires_at: string }>(
    `insert into demo_sites (slug, title, lead_id, mission_id, expires_at)
     values ($1, $2, $3, $4, now() + ($5 || ' days')::interval)
     on conflict (slug) do update
       set title = excluded.title, expires_at = excluded.expires_at, status = 'live', deleted_at = null
     returning id, expires_at`,
    [slug, title, leadId ?? null, missionId ?? null, String(ttl)],
  );

  await pool.query(
    `insert into agent_audit_events (event_type, actor, details)
     values ('executed', 'dev-senior', $1::jsonb)`,
    [JSON.stringify({ stage: 'demo_registered', slug, ttl_days: ttl, lead_id: leadId ?? null })],
  );

  const url = `${PUBLIC_BASE}/${slug}/`;

  if (slackConfigured()) {
    await postMessage(
      `Démo prête : *${title}*\n${url}\nExpire le ${new Date(inserted.rows[0].expires_at).toLocaleDateString('fr-FR')} sauf réponse du lead.\n_Lien non envoyé automatiquement — passer par le circuit outreach pour le transmettre._`,
    );
  }

  return c.json({ ok: true, id: inserted.rows[0].id, url, expires_at: inserted.rows[0].expires_at });
});

app.get('/', async (c) => {
  const result = await pool.query(
    `select d.id, d.slug, d.title, d.status, d.created_at, d.expires_at, l.company_name
       from demo_sites d
       left join leads l on l.id = d.lead_id
      order by d.created_at desc
      limit 100`,
  );

  return c.json({ count: result.rows.length, items: result.rows });
});

/** Prolonge un demo (le lead a repondu, ou est encore chaud). */
app.post('/:slug/extend', async (c) => {
  const slug = c.req.param('slug');
  const days = Math.min(Math.max(Number((await c.req.json().catch(() => ({}))).days ?? 14), 1), 60);

  const result = await pool.query(
    `update demo_sites
        set expires_at = now() + ($2 || ' days')::interval, status = 'extended'
      where slug = $1 and status <> 'expired'
      returning id, expires_at`,
    [slug, String(days)],
  );

  if (result.rowCount === 0) return c.json({ error: 'demo_not_found_or_expired' }, 404);

  return c.json({ ok: true, expires_at: result.rows[0].expires_at });
});

/**
 * Decide si un demo doit expirer maintenant. Ne touche jamais au disque —
 * seul le script cron (qui a le droit d'ecriture sur le dossier hote)
 * supprime les fichiers, sur la base de la reponse `action: 'deleted'`.
 */
app.post('/:slug/check-expiry', async (c) => {
  const slug = c.req.param('slug');

  const demo = await pool.query<{ id: string; lead_id: string | null; expires_at: string; created_at: string }>(
    `select id, lead_id, expires_at, created_at from demo_sites where slug = $1 and status = 'live'`,
    [slug],
  );

  const row = demo.rows[0];
  if (!row) return c.json({ action: 'not_found_or_not_live' });

  if (new Date(row.expires_at).getTime() > Date.now()) {
    return c.json({ action: 'not_yet_expired' });
  }

  if (row.lead_id) {
    const reply = await pool.query(
      `select 1 from conversations
        where lead_id = $1 and direction = 'inbound' and created_at > $2
        limit 1`,
      [row.lead_id, row.created_at],
    );

    if (reply.rowCount! > 0) {
      // Une reponse est arrivee : on ne coupe jamais un lead qui repond,
      // meme si personne n'a pense a prolonger manuellement.
      await pool.query(
        `update demo_sites set expires_at = now() + interval '14 days', status = 'extended' where id = $1`,
        [row.id],
      );
      return c.json({ action: 'kept_response_received' });
    }
  }

  await pool.query(`update demo_sites set status = 'expired', deleted_at = now() where id = $1`, [row.id]);

  await pool.query(
    `insert into agent_audit_events (event_type, actor, details)
     values ('executed', 'expire-demos-cron', $1::jsonb)`,
    [JSON.stringify({ stage: 'demo_expired', slug })],
  );

  return c.json({ action: 'deleted' });
});

export default app;
