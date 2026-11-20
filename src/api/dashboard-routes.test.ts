import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import dashboardRoutes, { resetDashboardLoginLimiter, setMissionBoardQuery, setPrStatusClient } from './dashboard-routes.js';
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


describe('dashboard-routes API missions (T4)', () => {
  const rows = [
    { id: '00000000-0000-4000-8000-000000000001', source_id: 'AGE-9001', source_url: null, title: 'AGE-9001 A',
      status: 'completed', action_status: 'executed', payload: { repo: 'test/demo', linear_issue: 'AGE-9001' },
      result: { pr_url: 'https://github.com/test/demo/pull/1', delivery: 'pull_request' }, error_message: null,
      created_at: new Date(Date.now() - 3600_000), processed_at: new Date() },
    { id: '00000000-0000-4000-8000-000000000002', source_id: 'AGE-9002', source_url: null, title: 'AGE-9002 B',
      status: 'failed', action_status: 'failed', payload: {}, result: null,
      error_message: 'RuntimeError:server_tests_failed:regression:test', created_at: new Date(), processed_at: new Date() },
    { id: '00000000-0000-4000-8000-000000000003', source_id: 'AGE-9003', source_url: null, title: 'AGE-9003 C',
      status: 'in_progress', action_status: 'approved', payload: {}, result: null, error_message: null,
      created_at: new Date(), processed_at: null },
  ];
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.DASHBOARD_ACCESS_TOKEN;
    process.env.DASHBOARD_ACCESS_TOKEN = SECRET;
    setMissionBoardQuery(async () => ({ rows: rows as never }));
    setPrStatusClient({ state: async () => 'open' });
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.DASHBOARD_ACCESS_TOKEN;
    else process.env.DASHBOARD_ACCESS_TOKEN = saved;
  });
  const get = (q = '', cookie = true) => app().request('/dashboard/api/missions' + q,
    cookie ? { headers: { Cookie: sessionCookie() } } : {});

  it('exige la session du tableau de bord (un jeton agent ne suffit pas)', async () => {
    expect((await get('', false)).status).toBe(401);
    const bearer = await app().request('/dashboard/api/missions', { headers: { Authorization: 'Bearer agent-token' } });
    expect(bearer.status).toBe(401);
  });

  it('filtre « à relire » par défaut, compte chaque filtre', async () => {
    const body = await (await get()).json();
    expect(body.filter).toBe('a_relire');
    expect(body.items.map((i: { ticket: string }) => i.ticket)).toEqual(['AGE-9001']);
    expect(body.counts).toEqual({ a_relire: 1, bloquees: 1, en_cours: 1, toutes: 3 });
    expect(body.week.missions).toBe(3);
  });

  it('bloquées avec explication, en cours, toutes et pagination', async () => {
    const blocked = await (await get('?filter=bloquees')).json();
    expect(blocked.items[0].block.text).toContain('échoue maintenant (test)');
    expect((await (await get('?filter=en_cours')).json()).items).toHaveLength(1);
    const page = await (await get('?filter=toutes&limit=2&offset=2')).json();
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(1);
  });

  it('refuse un filtre ou une pagination invalides', async () => {
    for (const q of ['?filter=tout', '?limit=0', '?limit=101', '?offset=-1']) {
      expect((await get(q)).status, q).toBe(400);
    }
  });

  it('renvoie une erreur générique si la base ne répond pas', async () => {
    setMissionBoardQuery(async () => { throw new Error('connect ECONNREFUSED 10.0.0.1:5432'); });
    const res = await get();
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('ECONNREFUSED');
  });

  it('la requête SQL tourne sur le schéma réel des missions', async () => {
    const { database } = await import('../core/missions-v2/testing/database.js');
    const { pool } = await database(undefined, false);
    const action = await pool.query(`insert into agent_actions (status) values ('approved') returning id`);
    await pool.query(`insert into agent_missions (action_id, target_agent, source_type, source_id, title, status, payload)
      values ($1, 'dev-senior', 'linear', 'AGE-9100', 'AGE-9100 T', 'pending', '{"repo":"test/demo"}'),
             ($1, 'hermes', 'linear', 'AGE-9101', 'AGE-9101 autre agent', 'pending', '{}')`, [action.rows[0].id]);
    setMissionBoardQuery((sql, params) => pool.query(sql, params) as never);
    const body = await (await get('?filter=toutes')).json();
    expect(body.items.map((i: { ticket: string; category: string }) => [i.ticket, i.category])).toEqual([['AGE-9100', 'en_cours']]);
  }, 30_000); // PGlite démarre une base complète : lent quand toute la suite tourne en parallèle.
});

describe('dashboard-routes état des PR (T5)', () => {
  const pr = (n: number) => ({ id: `00000000-0000-4000-8000-00000000000${n}`, source_id: `AGE-90${n}`, source_url: null,
    title: `AGE-90${n} T`, status: 'completed', action_status: 'executed', payload: {},
    result: { pr_url: `https://github.com/NadirL05/demo/pull/${n}`, delivery: 'pull_request' },
    error_message: null, created_at: new Date(), processed_at: new Date() });
  beforeEach(() => {
    process.env.DASHBOARD_ACCESS_TOKEN = SECRET;
    setMissionBoardQuery(async () => ({ rows: [pr(1), pr(2), pr(3)] as never }));
  });
  afterEach(() => setPrStatusClient(null));

  it('ne garde « à relire » que les PR ouvertes ou d’état inconnu', async () => {
    const states: Record<string, 'open' | 'merged' | 'closed'> = { 1: 'open', 2: 'merged', 3: 'closed' };
    setPrStatusClient({ state: async (url) => states[String(url).split('/').pop() as string] });
    const body = await (await app().request('/dashboard/api/missions', { headers: { Cookie: sessionCookie() } })).json();
    expect(body.items.map((i: { ticket: string; pr_state: string }) => [i.ticket, i.pr_state])).toEqual([['AGE-901', 'open']]);
    expect(body.counts.a_relire).toBe(1);
  });

  it('GitHub en panne : la page répond, PR « inconnu » laissées à relire', async () => {
    setPrStatusClient({ state: async () => 'unknown' });
    const res = await app().request('/dashboard/api/missions', { headers: { Cookie: sessionCookie() } });
    expect(res.status).toBe(200);
    expect((await res.json()).items.every((i: { pr_state: string }) => i.pr_state === 'unknown')).toBe(true);
  });
});

