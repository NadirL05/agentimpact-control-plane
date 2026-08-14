/**
 * Garde-fous d'envoi (semaine 1-2 phase Growth), sans I/O.
 *
 * Deux protections independantes de la validation humaine par message :
 *  - un domaine d'envoi neuf grille sa reputation en quelques jours s'il
 *    envoie trop vite ("warmup") ;
 *  - une adresse supprimee (desabonnement, bounce dur, plainte) ne doit
 *    jamais revenir, meme si le lead est recree plus tard.
 */

export type SendVerdict =
  | { allowed: true }
  | { allowed: false; reason: 'suppressed' | 'quota_exceeded'; httpStatus: 403 | 429 };

/**
 * Palier de warmup. Volontairement prudent : un domaine grille est plus
 * cher a reparer que quelques jours de patience. Plafond bas et durable
 * plutot qu'un ramp-up agressif.
 */
export function dailySendLimit(daysSinceLaunch: number): number {
  if (daysSinceLaunch < 0) return 0;
  if (daysSinceLaunch < 3) return 5;
  if (daysSinceLaunch < 7) return 10;
  if (daysSinceLaunch < 14) return 20;
  if (daysSinceLaunch < 30) return 40;
  return 60;
}

export function canSend(params: {
  isSuppressed: boolean;
  sentToday: number;
  daysSinceLaunch: number;
}): SendVerdict {
  if (params.isSuppressed) {
    return { allowed: false, reason: 'suppressed', httpStatus: 403 };
  }

  const limit = dailySendLimit(params.daysSinceLaunch);

  if (params.sentToday >= limit) {
    return { allowed: false, reason: 'quota_exceeded', httpStatus: 429 };
  }

  return { allowed: true };
}

/**
 * Classification deterministe et prudente des reponses entrantes : seuls des
 * signaux explicites (regex ciblees) tranchent. Tout le reste retombe sur
 * `unknown`, jamais sur une supposition — un faux "not_interested" ferait
 * perdre un lead chaud, un faux "interested" ferait harceler un refus.
 */
// Ordre volontaire : "pas interesse" contient "interesse" comme sous-chaine,
// donc toute regle de refus doit etre testee AVANT la regle d'interet, sinon
// une negation se ferait classer comme un interet.
const CLASSIFICATION_RULES: Array<[RegExp, string]> = [
  [/\b(desabonn|desinscri|unsubscribe|stop\b|ne plus (recevoir|etre contacte))/i, 'unsubscribe'],
  [/\b(pas int[ée]ress|non merci|ne me contactez plus|refus)/i, 'not_interested'],
  [/\b(plus tard|pas maintenant|revenez|rappelez[- ]moi|dans (\d+ )?(mois|semaines))/i, 'later'],
  [/\b(interess|int[ée]ress|volontiers|dispo(nible)? pour|on en parle|ça m'intéresse|30 ?min)/i, 'interested'],
  [/\?\s*$/, 'question'],
];

export function classifyReply(text: string): string {
  for (const [pattern, label] of CLASSIFICATION_RULES) {
    if (pattern.test(text)) return label;
  }
  return 'unknown';
}
