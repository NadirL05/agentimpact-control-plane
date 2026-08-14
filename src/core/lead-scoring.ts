/**
 * Regles de qualification commerciale (semaine 7).
 *
 * Logique pure : aucune I/O, aucun acces base. C'est ce qui permet de la
 * tester exhaustivement, y compris les cas limites qu'on ne saurait pas
 * provoquer sur des donnees reelles.
 */

export type LeadRow = {
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

export type Fiche = {
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

export function count(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * Score deterministe. Chaque point vient d'une donnee verifiable en base :
 * pas de score "au feeling", et le detail est renvoye pour pouvoir discuter.
 */
export function scoreLead(lead: LeadRow): { score: number; preuve: string[]; manques: string[] } {
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

export function priorityOf(score: number): 'A' | 'B' | 'C' {
  if (score >= 70) return 'A';
  if (score >= 45) return 'B';
  return 'C';
}

export function guessSector(lead: LeadRow): string {
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

export const USE_CASES: Record<string, { probleme: string; useCase: string; angle: string }> = {
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

export const DEFAULT_USE_CASE = {
  probleme: 'Tâches répétitives à faible valeur non identifiées précisément',
  useCase: 'Diagnostic IA : cartographie des tâches automatisables',
  angle: 'Partir d un irritant concret cité par le prospect, pas d une promesse générale',
};

export function buildFiche(lead: LeadRow): Fiche {
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


export function renderDraft(fiche: Fiche, lead: LeadRow, channel: 'email' | 'linkedin') {
  // Sans prenom connu, on salue sans nom : "Bonjour bonjour," partait au prospect.
  const prenom = (lead.contact_name ?? '').trim().split(/\s+/)[0] ?? '';
  const salutation = prenom ? `Bonjour ${prenom},` : 'Bonjour,';
  const signal = lead.signal ?? `votre activité (${fiche.secteur.toLowerCase()})`;

  const subject = `${fiche.entreprise} — ${fiche.probleme_probable.toLowerCase()}`;

  const body =
    channel === 'linkedin'
      ? [
          salutation,
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
          salutation,
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

