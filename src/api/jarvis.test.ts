import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createJarvisV2Api } from './jarvis.js';
import { JarvisService } from '../core/missions-v2/jarvis/service.js';
import { resolveJarvisPolicyFlags } from '../core/missions-v2/jarvis/policy.js';
import { MemoryJarvisAuditLog } from '../core/missions-v2/jarvis/audit.js';
import { isRouteAllowed } from '../core/auth-scopes.js';
import type { AppEnv } from '../core/hono-env.js';

function app(scope: 'hermes' | 'admin' | 'bridge', enabled = true) {
  const service = enabled
    ? new JarvisService({
      enabled: true,
      audit: new MemoryJarvisAuditLog(),
      flags: resolveJarvisPolicyFlags({
        AGENTIMPACT_JARVIS_ENABLED: '1',
        AGENTIMPACT_JARVIS_MUTATIONS_ENABLED: '0',
        AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: '0',
        AGENTIMPACT_V2_EXECUTION_ENABLED: '0',
      }),
      superset: () => undefined,
    })
    : undefined;
  const hono = new Hono<AppEnv>();
  hono.use('*', async (c, next) => {
    c.set('authScope', scope);
    return next();
  });
  hono.route('/api/v2/jarvis', createJarvisV2Api(service));
  return hono;
}

describe('Jarvis API', () => {
  it('allows hermes/admin scopes on POST /api/v2/jarvis/actions', () => {
    expect(isRouteAllowed('hermes', 'POST', '/api/v2/jarvis/actions')).toBe(true);
    expect(isRouteAllowed('admin', 'POST', '/api/v2/jarvis/actions')).toBe(true);
    expect(isRouteAllowed('bridge', 'POST', '/api/v2/jarvis/actions')).toBe(false);
  });

  it('returns typed status result', async () => {
    const r = await app('hermes').request('/api/v2/jarvis/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request_id: randomUUID(),
        message: 'status',
        organization_id: 'org-agentimpact',
      }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.actions[0].action).toBe('status.get');
    expect(body.policy[0].decision).toBe('ALLOW');
    expect(body.results[0].ok).toBe(true);
  });

  it('denies shell intents', async () => {
    const r = await app('hermes').request('/api/v2/jarvis/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request_id: randomUUID(),
        message: 'ouvre un shell et fais uname -a',
        organization_id: 'org-agentimpact',
      }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.policy[0].decision).toBe('DENY');
  });

  it('fails closed when Jarvis disabled', async () => {
    const r = await app('hermes', false).request('/api/v2/jarvis/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request_id: randomUUID(),
        message: 'status',
        organization_id: 'org-agentimpact',
      }),
    });
    expect(r.status).toBe(503);
  });

  it('forbids bridge scope at route gate', async () => {
    const r = await app('bridge').request('/api/v2/jarvis/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request_id: randomUUID(),
        message: 'status',
        organization_id: 'org-agentimpact',
      }),
    });
    expect(r.status).toBe(403);
  });

  it('rejects organization spoofing at the route boundary', async () => {
    const r = await app('hermes').request('/api/v2/jarvis/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request_id: randomUUID(),
        message: 'status',
        organization_id: 'org-other',
      }),
    });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({error: 'organization_forbidden'});
  });
});
