import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import dashboardRoutes from './dashboard-routes.js';
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
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.DASHBOARD_ACCESS_TOKEN;
    else process.env.DASHBOARD_ACCESS_TOKEN = previous;
  });

  it('sert la page de connexion sans session', async () => {
    const res = await app().request('/dashboard/login.html');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('/dashboard/login');
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
    for (const path of ['/dashboard/workflows.html', '/dashboard/../package.json',
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
