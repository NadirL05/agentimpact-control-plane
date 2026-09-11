/**
 * Bounded Jarvis V1 HTTP surface — typed actions only.
 * POST /api/v2/jarvis/actions
 */
import { Hono } from 'hono';
import type { AppEnv } from '../core/hono-env.js';
import { MissionError } from '../core/missions-v2/model.js';
import type { JarvisService } from '../core/missions-v2/jarvis/service.js';

export function createJarvisV2Api(service?: JarvisService) {
  const app = new Hono<AppEnv>();
  const organizationId = (process.env.AGENTIMPACT_ORGANIZATION_ID || 'org-agentimpact').trim();
  app.onError((error, c) => error instanceof MissionError
    ? c.json({ error: error.code }, error.status)
    : c.json({ error: 'jarvis_request_failed' }, 503));

  app.use('*', async (c, next) => {
    if (!['admin', 'hermes'].includes(c.get('authScope'))) {
      return c.json({ error: 'forbidden' }, 403);
    }
    if (!service) return c.json({ error: 'jarvis_disabled' }, 503);
    return next();
  });

  app.post('/actions', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object'
      || (body as {organization_id?: unknown}).organization_id !== organizationId) {
      return c.json({ error: 'organization_forbidden' }, 403);
    }
    const actor = `api:${c.get('authScope')}`;
    const result = await service!.handle(body, actor);
    return c.json(result);
  });

  return app;
}
