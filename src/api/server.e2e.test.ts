import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { getHermesProfiles } from '../core/hermes-profiles.js';
import { getPolicies } from '../core/policies.js';
import { getWorkflows } from '../core/workflows.js';

// Recré·¢er l'app pour les tests sans lancer le server
const app = new Hono();

app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/profiles', (c) => {
  const profiles = getHermesProfiles();
  return c.json({ count: profiles.length, items: profiles });
});

app.get('/policies', (c) => {
  const policies = getPolicies();
  return c.json({ count: policies.length, items: policies });
});

app.get('/workflows', (c) => {
  const workflows = getWorkflows();
  return c.json({ count: workflows.length, items: workflows });
});

describe('API E2E', () => {
  it('GET /health retourne 200 et status ok', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      status?: string;
      count: number;
      items: unknown[];
    };
    expect(json.status).toBe('ok');
  });

  it('GET /profiles retourne 200 et 4 profils', async () => {
    const res = await app.request('/profiles');
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      status?: string;
      count: number;
      items: unknown[];
    };
    expect(json.count).toBe(4);
    expect(json.items).toHaveLength(4);
  });

  it('GET /policies retourne 200 et au moins 4 policies', async () => {
    const res = await app.request('/policies');
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      status?: string;
      count: number;
      items: unknown[];
    };
    expect(json.count).toBeGreaterThanOrEqual(4);
    expect(json.items.length).toBeGreaterThanOrEqual(4);
  });

  it('GET /workflows retourne 200 et 4 workflows', async () => {
    const res = await app.request('/workflows');
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      status?: string;
      count: number;
      items: unknown[];
    };
    expect(json.count).toBe(4);
    expect(json.items).toHaveLength(4);
  });
});
