/**
 * Dashboard navigateur — fichiers statiques + login session HttpOnly.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono, type Context } from 'hono';
import { constantTimeEqualString } from '../core/secure-compare.js';
import {
  issueSignedSessionToken,
  sessionCookieHeader,
} from '../core/signed-session.js';
import { dashboardSessionSecret, hasValidDashboardSession } from '../core/dashboard-session.js';

const __dirname_local = fileURLToPath(new URL('.', import.meta.url));
// src/api → src/dashboard (dev, tests) ; dist/api → dist/dashboard (image Docker).
const DASHBOARD_ROOT = normalize(join(__dirname_local, '../dashboard'));

const STATIC_FILES: Record<string, string> = {
  '/login.html': 'text/html; charset=utf-8',
  '/app.js': 'application/javascript; charset=utf-8',
};

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

app.post('/login', async (c) => {
  const secret = dashboardSecret();
  if (!secret) {
    return c.json({ error: 'dashboard_unavailable' }, 503);
  }

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.password !== 'string' || body.password.length === 0) {
    return c.json({ error: 'invalid_body' }, 400);
  }

  if (!constantTimeEqualString(body.password, secret)) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const token = issueSignedSessionToken('dashboard', secret);
  c.header(
    'Set-Cookie',
    sessionCookieHeader('ai_dashboard', token, '/', 8 * 60 * 60),
  );
  return c.json({ ok: true });
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

  if (path !== '/login.html' && !hasValidDashboardSession(c.req.header('Cookie'))) {
    return c.redirect('/dashboard/login.html', 302);
  }

  const content = loadDashboardFile(path.slice(1));
  if (!content) return c.notFound();
  return c.body(content, 200, { 'Content-Type': contentType });
});

export default app;
