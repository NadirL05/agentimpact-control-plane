/**
 * Dashboard navigateur — fichiers statiques + login session HttpOnly.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono, type Context } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { constantTimeEqualString } from '../core/secure-compare.js';
import {
  issueSignedSessionToken,
  sessionCookieHeader,
} from '../core/signed-session.js';
import { dashboardSessionSecret, hasValidDashboardSession } from '../core/dashboard-session.js';
import { createLoginRateLimiter, loginClientKey } from '../core/login-rate-limit.js';
import { z } from 'zod';
import {
  BOARD_FILTERS, matchesFilter, parsePrices, toBoardItem, weekTotals, type MissionRow,
} from '../core/mission-board.js';
import { createPrStatusClient, type PrStatusClient } from '../core/pr-status.js';

const __dirname_local = fileURLToPath(new URL('.', import.meta.url));
// src/api → src/dashboard (dev, tests) ; dist/api → dist/dashboard (image Docker).
const DASHBOARD_ROOT = normalize(join(__dirname_local, '../dashboard'));

const STATIC_FILES: Record<string, string> = {
  '/login.html': 'text/html; charset=utf-8',
  '/app.js': 'application/javascript; charset=utf-8',
  '/login.js': 'application/javascript; charset=utf-8',
  '/missions.js': 'application/javascript; charset=utf-8',
};

/** Fichiers servis sans session (la page de connexion et son script). */
const PUBLIC_FILES = new Set(['/login.html', '/login.js']);

function maxLoginAttempts(): number {
  const n = Number(process.env.DASHBOARD_LOGIN_MAX_ATTEMPTS);
  return Number.isInteger(n) && n >= 1 && n <= 50 ? n : 5;
}

let limiter = createLoginRateLimiter(maxLoginAttempts());

/** Tests uniquement : repart d'un compteur vide. */
export function resetDashboardLoginLimiter(): void {
  limiter = createLoginRateLimiter(maxLoginAttempts());
}

/** Cookie `Secure` en production (servi derrière HTTPS par Cloudflare). */
function secureCookies(): boolean {
  return process.env.NODE_ENV === 'production' && process.env.DASHBOARD_COOKIE_SECURE !== '0';
}

function loadDashboardFile(relativePath: string): string | null {
  const resolved = normalize(join(DASHBOARD_ROOT, relativePath));
  if (!resolved.startsWith(DASHBOARD_ROOT)) return null;
  if (!existsSync(resolved)) return null;
  return readFileSync(resolved, 'utf-8');
}

function dashboardSecret(): string | null {
  return dashboardSessionSecret();
}

export { hasValidDashboardSession } from '../core/dashboard-session.js';

const app = new Hono();

// En-têtes de sécurité sur tout /dashboard (docs/SECURITY.md) : scripts et
// connexions du même domaine seulement, pas d'iframe, pas de détection de type.
app.use('*', secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:'],
    connectSrc: ["'self'"],
    frameAncestors: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    objectSrc: ["'none'"],
  },
  strictTransportSecurity: 'max-age=31536000; includeSubDomains',
  xFrameOptions: 'DENY',
  xContentTypeOptions: 'nosniff',
  referrerPolicy: 'no-referrer',
}));

app.post('/login', async (c) => {
  const secret = dashboardSecret();
  if (!secret) {
    return c.json({ error: 'dashboard_unavailable' }, 503);
  }

  const key = loginClientKey(c.req.raw.headers);
  if (limiter.isBlocked(key)) {
    return c.json({ error: 'too_many_attempts' }, 429);
  }

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.password !== 'string' || body.password.length === 0 || body.password.length > 512) {
    return c.json({ error: 'invalid_body' }, 400);
  }

  if (!constantTimeEqualString(body.password, secret)) {
    limiter.recordFailure(key);
    return c.json({ error: 'unauthorized' }, 401);
  }

  limiter.reset(key);
  const token = issueSignedSessionToken('dashboard', secret);
  c.header(
    'Set-Cookie',
    sessionCookieHeader('ai_dashboard', token, '/', 8 * 60 * 60, secureCookies()),
  );
  return c.json({ ok: true });
});

type BoardQuery = (sql: string, params: unknown[]) => Promise<{ rows: MissionRow[] }>;
// Import paresseux : db.js exige les variables PG dès son chargement.
let boardQuery: BoardQuery = async (sql, params) =>
  (await import('./db.js')).pool.query(sql, params) as unknown as { rows: MissionRow[] };

let prStatus: PrStatusClient | null = null;
function prClient(): PrStatusClient {
  prStatus ??= createPrStatusClient({ token: process.env.GITHUB_TOKEN });
  return prStatus;
}

/** Tests uniquement : remplace le client GitHub. */
export function setPrStatusClient(client: PrStatusClient | null): void {
  prStatus = client;
}

/** Tests uniquement : remplace l'accès à la base. */
export function setMissionBoardQuery(query: BoardQuery): void {
  boardQuery = query;
}

const boardParams = z.object({
  filter: z.enum(BOARD_FILTERS).default('a_relire'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(450).default(0),
});

// 500 dernières missions Dev Senior : assez pour la semaine et l'historique récent.
const BOARD_SQL = `select m.id, m.source_id, m.source_url, m.title, m.status, a.status as action_status,
    m.payload, m.result, m.error_message, m.created_at, m.processed_at
  from agent_missions m
  left join agent_actions a on a.id = m.action_id
  where m.target_agent = 'dev-senior'
    and coalesce(to_jsonb(m)->>'orchestration_version', '1') = '1'
  order by m.created_at desc
  limit 500`;

// Onglet Missions (étape 4) : lecture seule, cookie de session obligatoire.
app.get('/api/missions', async (c) => {
  if (!hasValidDashboardSession(c.req.header('Cookie'))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const parsed = boardParams.safeParse({
    filter: c.req.query('filter') ?? undefined,
    limit: c.req.query('limit') ?? undefined,
    offset: c.req.query('offset') ?? undefined,
  });
  if (!parsed.success) return c.json({ error: 'invalid_query' }, 400);
  const { filter, limit, offset } = parsed.data;
  try {
    const { rows } = await boardQuery(BOARD_SQL, []);
    const now = new Date();
    const prices = parsePrices(process.env.MISSION_COST_PRICES);
    const all = rows.map((row) => toBoardItem(row, prices, now));
    // Étape 5 : une PR fusionnée ou fermée n'est plus « à relire ». 50 PR au plus
    // par requête, 5 appels GitHub en parallèle, réponses en cache 5 min.
    const toCheck = all.filter((i) => i.category === 'a_relire' && i.pr_url).slice(0, 50);
    for (let k = 0; k < toCheck.length; k += 5) {
      await Promise.all(toCheck.slice(k, k + 5).map(async (item) => {
        item.pr_state = await prClient().state(item.pr_url);
        if (item.pr_state === 'merged' || item.pr_state === 'closed') item.category = 'terminee';
      }));
    }
    const selected = all.filter((i) => matchesFilter(i.category, filter));
    if (filter === 'a_relire') selected.reverse(); // la plus ancienne PR à relire en premier
    const counts = Object.fromEntries(BOARD_FILTERS.map((f) => [f, all.filter((i) => matchesFilter(i.category, f)).length]));
    c.header('Cache-Control', 'no-store');
    return c.json({
      filter, limit, offset, total: selected.length, counts,
      week: weekTotals(all, now), prices_configured: prices !== null,
      items: selected.slice(offset, offset + limit),
    });
  } catch (error) {
    console.error('dashboard missions query failed', error instanceof Error ? error.message : 'unknown');
    return c.json({ error: 'missions_unavailable' }, 503);
  }
});

/** Chemin relatif au montage : `c.req.path` est le chemin complet (`/dashboard/app.js`). */
function relativePath(fullPath: string): string {
  const rel = fullPath.replace(/^\/dashboard(?=\/|$)/, '');
  return rel === '' ? '/' : rel;
}

function serveIndex(c: Context) {
  if (!hasValidDashboardSession(c.req.header('Cookie'))) {
    return c.redirect('/dashboard/login.html', 302);
  }
  const html = loadDashboardFile('index.html');
  if (!html) return c.text('Dashboard unavailable', 503);
  return c.html(html);
}

app.get('/', serveIndex);

app.get('/*', (c) => {
  const path = relativePath(c.req.path);
  if (path === '/') return serveIndex(c);
  const contentType = STATIC_FILES[path];
  if (!contentType) {
    return c.notFound();
  }

  if (!PUBLIC_FILES.has(path) && !hasValidDashboardSession(c.req.header('Cookie'))) {
    return c.redirect('/dashboard/login.html', 302);
  }

  const content = loadDashboardFile(path.slice(1));
  if (!content) return c.notFound();
  return c.body(content, 200, { 'Content-Type': contentType });
});

export default app;
