/**
 * Mise en forme du brief quotidien (semaine 4), sans I/O.
 *
 * Le plafond d'elements est une regle produit, pas un detail d'affichage :
 * un brief de 30 lignes n'est pas lu, donc il ne sert a rien. On le teste.
 */

export const MAX_ITEMS = 10;

export type Section = {
  emoji: string;
  title: string;
  lines: string[];
};

export type GroupedLines = {
  decisions: string[];
  risks: string[];
  meetings: string[];
  opportunities: string[];
  delivery: string[];
};

export function ageLabel(from: string | Date, now: number = Date.now()): string {
  const ms = now - new Date(from).getTime();
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "moins d'1 h";
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} j`;
}

/**
 * Applique le plafond global en respectant l'ordre de priorite des sections :
 * ce qui bloque une decision passe avant ce qui informe.
 */
export function capSections(grouped: GroupedLines): {
  capped: GroupedLines;
  truncated: number;
} {
  let budget = MAX_ITEMS;
  let truncated = 0;
  const capped = {} as GroupedLines;

  for (const key of Object.keys(grouped) as Array<keyof GroupedLines>) {
    const lines = grouped[key];
    const kept = lines.slice(0, Math.max(budget, 0));
    truncated += lines.length - kept.length;
    budget -= kept.length;
    capped[key] = kept;
  }

  return { capped, truncated };
}

/** Top 3 deterministe : bloquant, puis risque, puis livraison, puis business. */
export function topActions(sections: GroupedLines): string[] {
  const top: string[] = [];
  const label = (line: string) => line.split(' — source')[0];

  if (sections.decisions.length > 0) {
    top.push(`Traiter ${sections.decisions.length} validation(s) en attente`);
  }
  if (sections.risks.length > 0) top.push(`Corriger : ${label(sections.risks[0])}`);
  if (sections.delivery.length > 0) top.push(`Revoir : ${label(sections.delivery[0])}`);
  if (sections.opportunities.length > 0 && top.length < 3) {
    top.push(`Exploiter : ${label(sections.opportunities[0])}`);
  }

  return top.slice(0, 3);
}

export function renderBrief(
  sections: Section[],
  truncated: number,
  date = new Date(),
): string {
  const label = date.toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  const parts = [`*Brief du ${label}*`];

  for (const section of sections) {
    if (section.lines.length === 0) continue;
    parts.push(
      `\n${section.emoji} *${section.title}*\n${section.lines.map((l) => `• ${l}`).join('\n')}`,
    );
  }

  if (parts.length === 1) {
    parts.push('\nRien à signaler. Aucune action en attente, aucun échec sur 24 h.');
  }

  if (truncated > 0) {
    parts.push(`\n_${truncated} élément(s) non affiché(s) — plafond de ${MAX_ITEMS}._`);
  }

  return parts.join('\n');
}
