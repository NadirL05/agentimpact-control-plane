import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../core/hono-env.js';
import { MissionStore } from '../core/missions-v2/store.js';
import { admissionSchema, MissionError, planSchema, projectSchema, states } from '../core/missions-v2/model.js';

export function createMissionsV2Api(store: MissionStore) {
  const app = new Hono<AppEnv>();
  app.onError((error,c) => error instanceof MissionError
    ? c.json({error:error.code},error.status) : c.json({error:'v2_request_failed'},503));
  app.use('*',async(c,next) => {
    // Even SKIP_AUTH must never expose the V2 mutation surface.
    if (!['admin','hermes'].includes(c.get('authScope'))) return c.json({error:'forbidden'},403);
    const id = c.req.param('id');
    if (id && !z.string().uuid().safeParse(id).success) return c.json({error:'invalid_mission_id'},400);
    return next();
  });
  const meta = (scope: string, key: string | undefined) => ({principal:`api:${scope}`,key:key ?? ''});
  app.post('/missions',async c => {
    const data = admissionSchema.safeParse(await c.req.json().catch(() => null));
    if (!data.success || data.data.source_type === 'slack') return c.json({error:'invalid_admission'},400);
    return c.json({item:await store.admit(data.data,meta(c.get('authScope'),c.req.header('Idempotency-Key')))},201);
  });
  app.get('/missions/:id',async c => c.json({item:await store.get(c.req.param('id'))}));
  app.get('/missions/:id/plan',async c => c.json({item:await store.plan(c.req.param('id'))}));
  app.get('/missions/:id/events',async c => {
    const after = c.req.query('after') ?? '0';
    if (!/^\d{1,18}$/.test(after)) return c.json({error:'invalid_cursor'},400);
    return c.json({items:await store.events(c.req.param('id'),after)});
  });
  app.get('/status',async c => {
    const project = projectSchema.safeParse(c.req.query('project'));
    if (!project.success) return c.json({error:'invalid_project'},400);
    return c.json({items:await store.status(project.data),limit:100});
  });
  app.post('/missions/:id/plan',async c => {
    const body = z.object({state_version:z.number().int().nonnegative(),plan:planSchema}).strict().safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({error:'invalid_plan'},400);
    return c.json({item:await store.savePlan(c.req.param('id'),body.data.state_version,body.data.plan,meta(c.get('authScope'),c.req.header('Idempotency-Key')))});
  });
  app.post('/missions/:id/state',async c => {
    const body = z.object({state_version:z.number().int().nonnegative(),state:z.enum(states)}).strict().safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({error:'invalid_state'},400);
    return c.json({item:await store.transition(c.req.param('id'),body.data.state_version,body.data.state,meta(c.get('authScope'),c.req.header('Idempotency-Key')))});
  });
  return app;
}
