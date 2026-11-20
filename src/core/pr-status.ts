/**
 * État des PR des missions pour l'onglet Missions (docs/IMPLEMENTATION_PLAN.md, étape 5).
 * Lecture seule, dépôts autorisés seulement, cache 5 min ; toute panne donne « inconnu ».
 */

export type PrState = 'open' | 'merged' | 'closed' | 'unknown';

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

/** Dépôts que Dev Senior modifie (squad-agents-config, PROJECT_REPOS). */
export function isAllowedRepo(owner: string, repo: string): boolean {
  return owner === 'NadirL05' || (owner === 'ERP-AxENR' && repo === 'home-eco-enr');
}

export function parsePrUrl(url: unknown): PrRef | null {
  if (typeof url !== 'string') return null;
  const m = url.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/pull\/([1-9][0-9]{0,6})$/);
  if (!m || !isAllowedRepo(m[1], m[2])) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean; status: number; json(): Promise<unknown>;
}>;

export interface PrStatusClient {
  state(url: unknown): Promise<PrState>;
}

export function createPrStatusClient(options: {
  token?: string;
  fetch?: FetchLike;
  now?: () => number;
  ttlMs?: number;
  unknownTtlMs?: number;
  timeoutMs?: number;
} = {}): PrStatusClient {
  const fetchFn = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? 5 * 60 * 1000;
  const unknownTtl = options.unknownTtlMs ?? 60 * 1000;
  const timeout = options.timeoutMs ?? 5000;
  const cache = new Map<string, { state: PrState; until: number }>();

  return {
    async state(url) {
      const ref = parsePrUrl(url);
      if (!ref || !options.token) return 'unknown';
      const key = `${ref.owner}/${ref.repo}#${ref.number}`;
      const hit = cache.get(key);
      if (hit && hit.until > now()) return hit.state;
      let state: PrState = 'unknown';
      try {
        const res = await fetchFn(`https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, {
          headers: {
            Authorization: `Bearer ${options.token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'agentimpact-control-plane',
          },
          signal: AbortSignal.timeout(timeout),
        });
        if (res.ok) {
          const body = (await res.json()) as { state?: unknown; merged?: unknown; merged_at?: unknown };
          if (body.merged === true || (typeof body.merged_at === 'string' && body.merged_at)) state = 'merged';
          else if (body.state === 'open') state = 'open';
          else if (body.state === 'closed') state = 'closed';
        }
      } catch {
        state = 'unknown';
      }
      cache.set(key, { state, until: now() + (state === 'unknown' ? unknownTtl : ttl) });
      if (cache.size > 2000) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      return state;
    },
  };
}
