import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import dashboardRoutes, { resetDashboardLoginLimiter } from './dashboard-routes.js';
import { issueSignedSessionToken } from '../core/signed-session.js';

// T1 (docs/TESTING.md) : le tableau de bord est servi sous /dashboard comme dans server.ts.
const SECRET = 'dashboard-test-secret-at-least-32-chars';

function app() {
  const root = new Hono();
  root.route('/dashboard', dashboardRoutes);
  return root;
}

function sessionCookie() {
  return `ai_dashboard=${issueSignedSessionToken('dashboard', SECRET)}`;
}

describe('dashboard-routes (T1)', () => {
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.DASHBOARD_ACCESS_TOKEN;
    process.env.DASHBOARD_ACCESS_TOKEN = SECRET;
    resetDashboardLoginLimiter();
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.DASHBOARD_ACCESS_TOKEN;
    else process.env.DASHBOARD_ACCESS_TOKEN = previous;
  });

  it('sert la page de connexion sans session', async () => {
    const res = await app().request('/dashboard/login.html');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('src="login.js"');
  });

  it('redirige l’accueil vers la connexion sans session (avec et sans slash final)', async () => {
    for (const path of ['/dashboard/', '/dashboard']) {
      const res = await app().request(path);
      expect(res.status, path).toBe(302);
      expect(res.headers.get('location')).toBe('/dashboard/login.html');
    }
  });

  it('sert l’accueil et app.js avec une session valide', async () => {
    const headers = { Cookie: sessionCookie() };
    const index = await app().request('/dashboard/', { headers });
    expect(index.status).toBe(200);
    expect(await index.text()).toContain('<html');
    const js = await app().request('/dashboard/app.js', { headers });
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('javascript');
  });

  it('protège app.js sans session', async () => {
    const res = await app().request('/dashboard/app.js');
    expect(res.status).toBe(302);
  });

  it('refuse les fichiers inconnus et la remontée de dossier', async () => {
    const headers = { Cookie: sessionCookie() };
    for (const path of ['/dashboard/workflows.html', '/dashboard/workflows-app.js', '/dashboard/../package.json',
      '/dashboard/%2e%2e/package.json', '/dashboard/README.md']) {
      const res = await app().request(path, { headers });
      expect(res.status, path).toBe(404);
    }
  });

  it('connexion : bon mot de passe → cookie, mauvais → 401', async () => {
    const ok = await app().request('/dashboard/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: SECRET }),
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('set-cookie')).toContain('ai_dashboard=');
    const bad = await app().request('/dashboard/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    });
    expect(bad.status).toBe(401);
  });
});

function login(password: string, ip = '203.0.113.7') {
  return app().request('/dashboard/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ password }),
  });
}

describe('dashboard-routes durcissement (T2)', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = { t: process.env.DASHBOARD_ACCESS_TOKEN, n: process.env.NODE_ENV, s: process.env.DASHBOARD_COOKIE_SECURE };
    process.env.DASHBOARD_ACCESS_TOKEN = SECRET;
    resetDashboardLoginLimiter();
  });
  afterEach(() => {
    for (const [k, name] of [['t', 'DASHBOARD_ACCESS_TOKEN'], ['n', 'NODE_ENV'], ['s', 'DASHBOARD_COOKIE_SECURE']] as const) {
      if (saved[k] === undefined) delete process.env[name];
      else process.env[name] = saved[k];
    }
  });

  it('pose un cookie Secure en production, pas en local', async () => {
    process.env.NODE_ENV = 'production';
    expect((await login(SECRET)).headers.get('set-cookie')).toMatch(/; Secure$/);
    process.env.NODE_ENV = 'test';
    expect((await login(SECRET)).headers.get('set-cookie')).not.toContain('Secure');
  });

  it('bloque le 6e essai en 15 min, même avec le bon mot de passe, par IP', async () => {
    for (let i = 0; i < 5; i++) expect((await login('mauvais')).status).toBe(401);
    const blocked = await login(SECRET);
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: 'too_many_attempts' });
    expect((await login(SECRET, '198.51.100.9')).status).toBe(200);
  });

  it('une connexion réussie remet le compteur à zéro', async () => {
    for (let i = 0; i < 4; i++) await login('mauvais');
    expect((await login(SECRET)).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await login('mauvais')).status).toBe(401);
  });

  it('message identique pour tout mauvais mot de passe', async () => {
    const a = await (await login('mauvais')).json();
    const b = await (await login('x'.repeat(40))).json();
    expect(a).toEqual({ error: 'unauthorized' });
    expect(b).toEqual(a);
  });

  it('pose les en-têtes de sécurité sur les pages', async () => {
    const res = await app().request('/dashboard/login.html');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(res.headers.get('strict-transport-security')).toContain('max-age=31536000');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('sert login.js sans session et aucune page n’a de script en ligne', async () => {
    const js = await app().request('/dashboard/login.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('javascript');
    const headers = { Cookie: sessionCookie() };
    for (const path of ['/dashboard/login.html', '/dashboard/']) {
      const html = await (await app().request(path, { headers })).text();
      expect(html, path).not.toMatch(/<script>(?!<\/script>)/);
      expect(html, path).not.toMatch(/\son[a-z]+="/);
    }
  });
});

