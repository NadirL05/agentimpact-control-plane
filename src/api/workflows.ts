import { Hono } from 'hono';
import { startWorkflow, getWorkflowRun, listWorkflowRuns } from '../core/workflow-engine.js';

const app = new Hono();

// Lister tous les runs
app.get('/runs', (c) => {
  const runs = listWorkflowRuns();
  return c.json({ count: runs.length, items: runs });
});

// Lancer un workflow
app.post('/:workflowId/run', async (c) => {
  const workflowId = c.req.param('workflowId');
  try {
    const run = await startWorkflow(workflowId);
    return c.json({ status: 'started', run }, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// Status d'un run
app.get('/runs/:runId', (c) => {
  const runId = c.req.param('runId');
  const run = getWorkflowRun(runId);
  if (!run) {
    return c.json({ error: 'Run not found' }, 404);
  }
  return c.json(run);
});

export default app;
