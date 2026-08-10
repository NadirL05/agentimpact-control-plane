/**
 * API HTTP simple avec Hono.
 */

import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { getHermesProfiles } from '../core/hermes-profiles.js';
import { getPolicies } from '../core/policies.js';
import { getWorkflows } from '../core/workflows.js';
import workflowsApi from './workflows.js';

const app = new Hono();

// Logging middleware
app.use('*', logger());

// Endpoint racine - liste des endpoints
app.get('/', (c) => {
  return c.json({
    name: 'AgentImpact Control Plane API',
    version: '0.1.0',
    endpoints: [
      { method: 'GET', path: '/', description: 'Liste des endpoints' },
      { method: 'GET', path: '/health', description: 'Health check' },
      { method: 'GET', path: '/profiles', description: 'Liste des profils Hermes' },
      { method: 'GET', path: '/policies', description: 'Liste des policies' },
      { method: 'GET', path: '/workflows', description: 'Liste des workflows' },
      { method: 'GET', path: '/workflows/runs', description: 'Liste des workflow runs' },
      { method: 'POST', path: '/workflows/:workflowId/run', description: 'Lancer un workflow' },
      { method: 'GET', path: '/workflows/runs/:runId', description: 'Status d\'un workflow run' },
    ],
  });
});

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Registries
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

// Workflows API
app.route('/workflows', workflowsApi);

const port = Number(process.env.PORT) || 3000;
console.log(`Server starting on port ${port}`);

export default { port, handler: app.fetch };

if (import.meta.vitest == null) {
  const { serve } = await import('@hono/node-server');
  serve({
    fetch: app.fetch,
    port,
  });
}
