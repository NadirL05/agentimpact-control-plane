/**
 * Onglet Missions du tableau de bord (docs/IMPLEMENTATION_PLAN.md, étape 4).
 * Fonctions pures : catégorie, durée, explication des blocages, coût estimé.
 */

export const BOARD_FILTERS = ['a_relire', 'bloquees', 'en_cours', 'toutes'] as const;
export type BoardFilter = (typeof BOARD_FILTERS)[number];

export type BoardCategory = 'a_relire' | 'bloquee' | 'en_cours' | 'en_attente' | 'terminee' | 'refusee';

export interface MissionRow {
  id: string;
  source_id: string;
  source_url: string | null;
  title: string;
  status: string;
  action_status: string | null;
  payload: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error_message: string | null;
  created_at: Date | string;
  processed_at: Date | string | null;
}

export interface Prices {
  /** Prix par million de tokens, par modèle (`default` en repli), en euros. */
  models: Record<string, { input?: number; cached_input?: number; output?: number }>;
  /** Conversion du coût de relecture (USD) en euros. */
  usd_to_eur?: number;
}

/** Lit MISSION_COST_PRICES ; tout format invalide donne « pas de prix » (coût affiché « — »). */
export function parsePrices(raw: string | undefined): Prices | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const v = value as Record<string, unknown>;
    if (!v.models || typeof v.models !== 'object') return null;
    const models: Prices['models'] = {};
    for (const [name, p] of Object.entries(v.models as Record<string, unknown>)) {
      if (!p || typeof p !== 'object') continue;
      const entry: Prices['models'][string] = {};
      for (const k of ['input', 'cached_input', 'output'] as const) {
        const n = (p as Record<string, unknown>)[k];
        if (typeof n === 'number' && Number.isFinite(n) && n >= 0) entry[k] = n;
      }
      models[name] = entry;
    }
    const rate = typeof v.usd_to_eur === 'number' && v.usd_to_eur > 0 ? v.usd_to_eur : undefined;
    return { models, usd_to_eur: rate };
  } catch {
    return null;
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

export function categoryOf(row: MissionRow): BoardCategory {
  switch (row.status) {
    case 'completed':
      return str(row.result?.pr_url) && row.result?.delivery !== 'merged' ? 'a_relire' : 'terminee';
    case 'failed':
      return 'bloquee';
    case 'rejected':
      return 'refusee';
    case 'in_progress':
      return 'en_cours';
    default:
      return row.action_status === 'approved' ? 'en_cours' : 'en_attente';
  }
}

export function matchesFilter(category: BoardCategory, filter: BoardFilter): boolean {
  if (filter === 'toutes') return true;
  if (filter === 'a_relire') return category === 'a_relire';
  if (filter === 'bloquees') return category === 'bloquee';
  return category === 'en_cours' || category === 'en_attente';
}

const BLOCKS: Array<{ match: RegExp; text: string; action: string }> = [
  { match: /server_tests_failed:regression:install/, text: "L'installation du projet échoue avec les changements de la mission, alors qu'elle marchait avant.", action: 'Ouvrir la PR et vérifier les dépendances modifiées.' },
  { match: /server_tests_failed:regression:([\w,-]+)/, text: 'Un contrôle qui passait avant la mission échoue maintenant ($1).', action: 'Ouvrir la PR, corriger ou relancer la mission avec plus de précisions.' },
  { match: /server_tests_timeout/, text: 'Les tests sur le serveur ont dépassé 45 minutes.', action: 'Relancer la mission ; si ça se répète, vérifier les tests du dépôt.' },
  { match: /server_tests_no_result|server_tests_not_started/, text: "Les tests sur le serveur n'ont pas pu démarrer ou rendre un résultat.", action: "Relancer la mission ; vérifier l'état du serveur si ça se répète." },
  { match: /worker_timeout_no_pr/, text: "L'agent n'a pas ouvert de PR en 30 minutes.", action: 'Préciser le ticket (critères, fichiers) puis relancer.' },
  { match: /independent_review_not_approved/, text: 'La relecture indépendante a demandé des corrections.', action: 'Lire la relecture dans le rapport, puis corriger ou relancer.' },
  { match: /ci_wait_timeout/, text: "La CI GitHub n'est pas devenue verte en 20 minutes.", action: 'Ouvrir la PR et regarder les contrôles GitHub.' },
  { match: /out_of_scope_diff/, text: "L'agent a modifié des fichiers hors de son périmètre (ou supprimé, renommé).", action: 'Relire la PR ; élargir le périmètre du dépôt si le besoin est légitime.' },
  { match: /reviewed_head_changed|workspace_head_changed/, text: 'La PR a changé après la relecture (nouveau commit, souvent la correction automatique).', action: 'Relire la PR telle quelle ou relancer la mission.' },
  { match: /review_diff_too_large|export_too_large/, text: 'Les changements sont trop gros pour la relecture automatique (plus de 60 Ko).', action: 'Découper le ticket en plusieurs plus petits.' },
  { match: /unexpected_pull_request|merge_forbidden|merge_not_allowed/, text: "La PR ne vise pas la bonne branche ou demande une fusion interdite.", action: 'Fermer la PR et relancer la mission.' },
  { match: /workspace_|unexpected_workspace|unexpected_created_workspace|ambiguous_launch/, text: "L'espace de travail de l'agent n'a pas pu être préparé correctement.", action: 'Relancer la mission ; vérifier Superset si ça se répète.' },
  { match: /hermes_linear_plan_unverified/, text: "Hermès n'a pas pu lire le ticket Linear pour faire le plan.", action: "Vérifier l'accès Linear de Dev Senior puis relancer." },
  { match: /linear_report_unverified/, text: "Le rapport n'a pas pu être écrit dans Linear (le travail est fait).", action: 'Ouvrir la PR ; vérifier l’accès Linear.' },
  { match: /command_failed|cp_api_rejected|operation_failed/, text: 'Une commande technique a échoué sur le serveur.', action: 'Relancer la mission ; prévenir Claude si ça se répète.' },
  { match: /test_cancelled|superseded/, text: 'Mission annulée ou remplacée par une autre.', action: 'Rien à faire.' },
];

/** Phrase simple et action conseillée ; jamais le message technique brut. */
export function explainBlock(row: MissionRow): { text: string; action: string } | null {
  if (row.status !== 'failed' && row.status !== 'rejected') return null;
  const raw = `${row.error_message ?? ''} ${str(row.result?.error) ?? ''}`;
  for (const b of BLOCKS) {
    const m = raw.match(b.match);
    if (m) return { text: b.text.replace('$1', (m[1] ?? '').replace(/,/g, ', ')), action: b.action };
  }
  return { text: 'La mission a été arrêtée pour une raison non répertoriée.', action: 'Ouvrir le rapport de la mission ou demander à Claude.' };
}

function seconds(from: Date | string, to: Date | string | null, now: Date): number | null {
  const start = new Date(from).getTime();
  const end = to ? new Date(to).getTime() : now.getTime();
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.round((end - start) / 1000) : null;
}

export interface UsageSummary {
  tokens: number | null;
  model: string | null;
  cost_eur: number | null;
}

export function usageOf(row: MissionRow, prices: Prices | null): UsageSummary {
  const usage = row.result?.usage as Record<string, unknown> | null | undefined;
  const codex = (usage && typeof usage.codex === 'object' ? usage.codex : null) as Record<string, unknown> | null;
  const review = (usage && typeof usage.review === 'object' ? usage.review : null) as Record<string, unknown> | null;
  const input = num(codex?.input_tokens);
  const cached = num(codex?.cached_input_tokens) ?? 0;
  const output = num(codex?.output_tokens) ?? 0;
  const tokens = input === null ? null : input + output + (num(review?.input_tokens) ?? 0) + (num(review?.output_tokens) ?? 0);
  const model = str(codex?.model);
  let cost: number | null = null;
  if (prices && input !== null) {
    const p = prices.models[model ?? ''] ?? prices.models.default;
    if (p && p.input !== undefined && p.output !== undefined) {
      const fresh = Math.max(0, input - cached);
      cost = (fresh * p.input + cached * (p.cached_input ?? p.input) + output * p.output) / 1_000_000;
      const reviewUsd = num(review?.cost_usd);
      if (reviewUsd !== null && prices.usd_to_eur) cost += reviewUsd * prices.usd_to_eur;
      cost = Math.round(cost * 100) / 100;
    }
  }
  return { tokens, model, cost_eur: cost };
}

export interface BoardItem {
  id: string;
  ticket: string;
  title: string;
  repo: string | null;
  linear_url: string | null;
  category: BoardCategory;
  created_at: string;
  duration_s: number | null;
  pr_url: string | null;
  tests: string | null;
  block: { text: string; action: string } | null;
  usage: UsageSummary;
}

function testsLine(result: Record<string, unknown> | null): string | null {
  if (!result) return null;
  const mode = result.test_mode;
  if (mode === 'server') {
    const checks = Array.isArray(result.server_checks) ? result.server_checks.filter((c) => typeof c === 'string') : [];
    return checks.length ? `OK sur le serveur (${checks.join(', ')})` : 'Aucun test dans ce dépôt, relecture seule';
  }
  if (mode === 'ci-only') {
    const checks = Array.isArray(result.ci_checks) ? result.ci_checks.filter((c) => typeof c === 'string') : [];
    return 'CI GitHub verte' + (checks.length ? ` (${checks.join(' ; ')})` : '');
  }
  const count = num(result.test_count);
  return count !== null ? `${count} tests locaux OK` : null;
}

export function toBoardItem(row: MissionRow, prices: Prices | null, now = new Date()): BoardItem {
  const payload = row.payload ?? {};
  const ticket = str(payload.linear_issue) ?? row.source_id.split('-essai-')[0];
  const created = new Date(row.created_at);
  return {
    id: row.id,
    ticket,
    title: row.title.startsWith(ticket + ' ') ? row.title.slice(ticket.length + 1) : row.title,
    repo: str(payload.repo),
    linear_url: str(row.source_url),
    category: categoryOf(row),
    created_at: Number.isFinite(created.getTime()) ? created.toISOString() : String(row.created_at),
    duration_s: seconds(row.created_at, row.processed_at, now),
    pr_url: str(row.result?.pr_url),
    tests: row.status === 'completed' ? testsLine(row.result) : null,
    block: explainBlock(row),
    usage: usageOf(row, prices),
  };
}

export function weekTotals(items: BoardItem[], now = new Date()) {
  const since = now.getTime() - 7 * 24 * 3600 * 1000;
  const week = items.filter((i) => new Date(i.created_at).getTime() >= since);
  const costs = week.map((i) => i.usage.cost_eur).filter((c): c is number => c !== null);
  return {
    missions: week.length,
    tokens: week.reduce((sum, i) => sum + (i.usage.tokens ?? 0), 0),
    cost_eur: costs.length ? Math.round(costs.reduce((a, b) => a + b, 0) * 100) / 100 : null,
  };
}
