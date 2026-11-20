// Serveur du test E2E (docs/TESTING.md, T7) : vraies routes /dashboard, missions
// fictives (tickets AGE-90xx, dépôt test/demo), GitHub simulé. Aucune vraie donnée.
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import dashboardRoutes, { setMissionBoardQuery, setPrStatusClient } from '../api/dashboard-routes.js';

const port = Number(process.env.E2E_PORT || 8790);
process.env.DASHBOARD_ACCESS_TOKEN = process.env.E2E_PASSWORD || 'e2e-mot-de-passe-de-test-32-caracteres';
process.env.MISSION_COST_PRICES = JSON.stringify({ models: { default: { input: 1, cached_input: 0.1, output: 8 } } });

const ago = (hours: number) => new Date(Date.now() - hours * 3600_000);
const pr = (n: number) => `https://github.com/NadirL05/demo/pull/${n}`;
const rows = [
  { id: '00000000-0000-4000-8000-000000000004', source_id: 'AGE-9004', source_url: null, title: 'AGE-9004 Mission en cours',
    status: 'in_progress', action_status: 'approved', payload: { repo: 'test/demo', linear_issue: 'AGE-9004' }, result: null,
    error_message: null, created_at: ago(0.2), processed_at: null },
  { id: '00000000-0000-4000-8000-000000000003', source_id: 'AGE-9003', source_url: null, title: 'AGE-9003 Mission bloquée',
    status: 'failed', action_status: 'failed', payload: { repo: 'test/demo', linear_issue: 'AGE-9003' }, result: null,
    error_message: 'RuntimeError:server_tests_failed:regression:test', created_at: ago(1), processed_at: ago(0.9) },
  { id: '00000000-0000-4000-8000-000000000002', source_id: 'AGE-9002', source_url: null, title: 'AGE-9002 PR déjà fusionnée',
    status: 'completed', action_status: 'executed', payload: { repo: 'test/demo', linear_issue: 'AGE-9002' },
    result: { pr_url: pr(2), delivery: 'pull_request', test_mode: 'server', server_checks: ['lint'] }, error_message: null,
    created_at: ago(3), processed_at: ago(2.7) },
  { id: '00000000-0000-4000-8000-000000000001', source_id: 'AGE-9001', source_url: null, title: 'AGE-9001 PR à relire',
    status: 'completed', action_status: 'executed', payload: { repo: 'test/demo', linear_issue: 'AGE-9001' },
    result: { pr_url: pr(1), delivery: 'pull_request', test_mode: 'server', server_checks: ['lint', 'test'],
      usage: { codex: { input_tokens: 500000, cached_input_tokens: 400000, output_tokens: 3000, model: 'test-model' } } },
    error_message: null, created_at: ago(5), processed_at: ago(4.8) },
];
setMissionBoardQuery(async () => ({ rows: rows as never }));
setPrStatusClient({ state: async (url) => (url === pr(2) ? 'merged' : 'open') });

const app = new Hono();
app.route('/dashboard', dashboardRoutes);
// L'accueil appelle ces registres : réponses vides pour un écran propre.
for (const path of ['/profiles', '/policies', '/workflows']) app.get(path, (c) => c.json({ count: 0, items: [] }));
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => console.log(`e2e fixture ready on ${port}`));
