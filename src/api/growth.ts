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

const app = new Hono();

const PROFILE = 'agentimpact-growth';

const qualifySchema = z.object({ lead_id: z.string().uuid() });

const draftSchema = z.object({
  lead_id: z.string().uuid(),
  channel: z.enum(['email', 'linkedin']).default('email'),
  template: z.string().min(1).optional(),
});

type LeadRow = {
  id: string;
  company_name: string | null;
  contact_name: string | null;
  contact_role: string | null;
  website: string | null;
  email: string | null;
  linkedin_url: string | null;
  source: string | null;
  signal: string | null;
  pain_point: string | null;
  status: string;
  priority: string;
  fullenrich_status: string | null;
  contact_work_emails: unknown;
  contact_phones: unknown;
  created_at: string;
};

type Fiche = {
  lead_id: string;
  entreprise: string;
  secteur: string;
  signal_detecte: string;
  probleme_probable: string;
  preuve: string[];
  use_case_agentimpact: string;
  angle_approche: string;
  priorite: 'A' | 'B' | 'C';
  score: number;
  manques: string[];
};

function count(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * Score deterministe. Chaque point vient d'une donnee verifiable en base :
 * pas de score "au feeling", et le detail est renvoye pour pouvoir discuter.
 */
function scoreLead(lead: LeadRow): { score: number; preuve: string[]; manques: string[] } {
  const preuve: string[] = [];
  const manques: string[] = [];
  let score = 0;

  if (lead.company_name) {
    score += 10;
    preuve.push(`Entreprise identifiée : ${lead.company_name} (table \`leads\`)`);
  } else {
    manques.push('nom d entreprise');
  }

  if (lead.website) {
    score += 10;
    preuve.push(`Site public : ${lead.website}`);
  } else {
    manques.push('site web');
  }

  if (lead.linkedin_url) {
    score += 15;
    preuve.push(`Profil LinkedIn public : ${lead.linkedin_url}`);
  } else {
    manques.push('profil LinkedIn');
  }

  const emails = count(lead.contact_work_emails);
  if (emails > 0 || lead.email) {
    score += 25;
    preuve.push(
      `Contact joignable : ${emails} email(s) pro trouvé(s) par FullEnrich (table \`leads\`)`,
    );
  } else {
    manques.push('email professionnel');
  }

  if (count(lead.contact_phones) > 0) {
    score += 10;
    preuve.push('Téléphone trouvé par FullEnrich');
  }

  if (lead.signal) {
    score += 20;
    preuve.push(`Signal métier renseigné : ${lead.signal}`);
  } else {
    manques.push('signal métier (le vrai déclencheur de la prise de contact)');
  }

  if (lead.contact_role) {
    score += 10;
    preuve.push(`Rôle du contact : ${lead.contact_role}`);
  } else {
    manques.push('rôle du contact');
  }

  return { score: Math.min(score, 100), preuve, manques };
}

function priorityOf(score: number): 'A' | 'B' | 'C' {
  if (score >= 70) return 'A';
  if (score >= 45) return 'B';
  return 'C';
}

function guessSector(lead: LeadRow): string {
  const haystack = `${lead.company_name ?? ''} ${lead.website ?? ''} ${lead.contact_role ?? ''}`.toLowerCase();

  const rules: Array<[RegExp, string]> = [
    [/comptab|expert-comptable|fiduciaire/, 'Cabinet comptable'],
    [/avocat|juridique|notaire/, 'Juridique'],
    [/immobilier|agence immo/, 'Immobilier'],
    [/piscine|paysag|batiment|btp|artisan|renov/, 'Artisanat / BTP'],
    [/restaur|brasserie|traiteur/, 'Restauration'],
    [/agence|conseil|consulting|marketing/, 'Agence / conseil'],
    [/solaire|photovolt|energie|enr/, 'Énergie renouvelable'],
  ];

  for (const [pattern, label] of rules) {
    if (pattern.test(haystack)) return label;
  }

  return 'Secteur non déterminé';
}

const USE_CASES: Record<string, { probleme: string; useCase: string; angle: string }> = {
  'Cabinet comptable': {
    probleme: 'Temps passé à relancer les clients pour les pièces manquantes',
    useCase: 'Relance automatique des pièces, avec validation humaine avant envoi',
    angle: 'Partir du volume de relances mensuelles, pas de la technologie',
  },
  'Agence / conseil': {
    probleme: 'Comptes-rendus et suivi client dispersés entre Drive, mails et notes',
    useCase: 'Client Intelligence OS : synthèse hebdomadaire par client, sourcée',
    angle: 'Partir du temps passé à préparer les points client',
  },
  'Artisanat / BTP': {
    probleme: 'Délai de réponse aux demandes de devis',
    useCase: 'Formulaire → devis préparé automatiquement, validé avant envoi',
    angle: 'Partir du nombre de devis perdus faute de réponse rapide',
  },
  'Immobilier': {
    probleme: 'Qualification manuelle des leads entrants',
    useCase: 'Leads → qualification → relance préparée',
    angle: 'Partir du taux de leads jamais rappelés',
  },
  'Restauration': {
    probleme: 'Avis Google sans réponse',
    useCase: 'Avis → réponse proposée, validée avant publication',
    angle: 'Partir des avis négatifs restés sans réponse',
  },
  'Énergie renouvelable': {
    probleme: 'Suivi administratif des dossiers (Enedis, Consuel) chronophage',
    useCase: 'Suivi de dossier automatisé avec relances préparées',
    angle: 'Partir du délai moyen de mise en service',
  },
};

const DEFAULT_USE_CASE = {
  probleme: 'Tâches répétitives à faible valeur non identifiées précisément',
  useCase: 'Diagnostic IA : cartographie des tâches automatisables',
  angle: 'Partir d un irritant concret cité par le prospect, pas d une promesse générale',
};

function buildFiche(lead: LeadRow): Fiche {
  const { score, preuve, manques } = scoreLead(lead);
  const secteur = guessSector(lead);
  const useCase = USE_CASES[secteur] ?? DEFAULT_USE_CASE;

  return {
    lead_id: lead.id,
    entreprise: lead.company_name ?? '(inconnue)',
    secteur,
    signal_detecte: lead.signal ?? 'Aucun signal renseigné — à compléter avant contact',
    probleme_probable: lead.pain_point ?? useCase.probleme,
    preuve,
    use_case_agentimpact: useCase.useCase,
    angle_approche: useCase.angle,
    priorite: priorityOf(score),
    score,
    manques,
  };
}

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

function renderDraft(fiche: Fiche, lead: LeadRow, channel: 'email' | 'linkedin') {
  const prenom = (lead.contact_name ?? '').trim().split(/\s+/)[0] || 'bonjour';
  const signal =
    lead.signal ?? `votre activité (${fiche.secteur.toLowerCase()})`;

  const subject = `${fiche.entreprise} — ${fiche.probleme_probable.toLowerCase()}`;

  const body =
    channel === 'linkedin'
      ? [
          `Bonjour ${prenom},`,
          '',
          `J'ai vu ${signal}.`,
          `Chez ${fiche.entreprise}, le point qui coûte le plus cher est souvent : ${fiche.probleme_probable.toLowerCase()}.`,
          '',
          `Ce qu'on met en place dans ce cas : ${fiche.use_case_agentimpact.toLowerCase()}.`,
          '',
          "Est-ce un sujet chez vous en ce moment ?",
          '',
          'Nadir',
        ].join('\n')
      : [
          `Bonjour ${prenom},`,
          '',
          `J'ai vu ${signal}.`,
          '',
          `Dans les structures comme ${fiche.entreprise}, ce qui revient le plus souvent : ${fiche.probleme_probable.toLowerCase()}.`,
          // La mention de validation n'est ajoutee que si le use case ne la porte pas deja.
          `Ce qu'on met en place : ${fiche.use_case_agentimpact.toLowerCase()}${
            /validation humaine/i.test(fiche.use_case_agentimpact)
              ? '.'
              : ' — avec validation humaine avant toute action.'
          }`,
          '',
          "Si le sujet est d'actualité, je vous montre le fonctionnement en 20 minutes.",
          '',
          'Nadir Lahyani',
          'Agent Impact',
        ].join('\n');

  return { subject, body };
}

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
