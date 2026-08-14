/**
 * Delivery Factory GitHub (semaine 6 de la roadmap).
 *
 * Ce que ce module fait : transformer un besoin en specification, ouvrir une
 * issue apres validation humaine, commenter une PR, signaler ce qui manque.
 *
 * Ce qu'il ne fait pas, volontairement : merger. Aucune route de merge
 * n'existe. Les titres, corps et commits de PR sont des entrees non fiables :
 * ils ne sont jamais interpretes comme des instructions, seulement cites.
 */

import { Hono } from 'hono';
import { createHash, randomUUID, timingSafeEqual, createHmac } from 'node:crypto';
import { z } from 'zod';
import { pool } from './db.js';
import { postMessage, slackConfigured } from './slack.js';

const app = new Hono();

const TOKEN = process.env.GITHUB_TOKEN;
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const PROFILE = 'agentimpact-dev';
const AGENT_LABEL = 'agent-ready';
const TIMEOUT_MS = 15_000;

const repoPattern = /^[\w.-]+\/[\w.-]+$/;

const specSchema = z.object({
  repo: z.string().regex(repoPattern),
  title: z.string().min(5).max(200),
  need: z.string().min(10).max(4000),
  acceptance_criteria: z.array(z.string().min(3)).min(1).max(10),
  edge_cases: z.array(z.string().min(3)).max(10).optional(),
});

const executeSchema = z.object({ action_id: z.string().uuid() });

const reviewSchema = z.object({
  repo: z.string().regex(repoPattern),
  pr_number: z.number().int().positive(),
  body: z.string().min(10).max(60_000),
});

async function githubFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'agentimpact-control-plane',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

async function logEvent(
  actionId: string | null,
  eventType: 'created' | 'executing' | 'executed' | 'failed' | 'blocked_by_policy',
  stage: string,
  details: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `insert into agent_audit_events (action_id, event_type, actor, details)
     values ($1, $2, $3, $4::jsonb)`,
    [actionId, eventType, PROFILE, JSON.stringify({ stage, ...details })],
  );
}

function renderIssueBody(spec: z.infer<typeof specSchema>): string {
  const edges = spec.edge_cases ?? [];

  return [
    '## Besoin',
    spec.need,
    '',
    "## Critères d'acceptation",
    ...spec.acceptance_criteria.map((criterion) => `- [ ] ${criterion}`),
    '',
    '## Cas limites',
    edges.length > 0
      ? edges.map((edge) => `- ${edge}`).join('\n')
      : '- _à compléter avant de lancer le développement_',
    '',
    '---',
    `Spécification préparée par le control plane AgentImpact (profil \`${PROFILE}\`),`,
    'après validation humaine. Le merge reste manuel.',
  ].join('\n');
}

/** Prepare une specification. N'ouvre rien : produit une action a valider. */
app.post('/spec', async (c) => {
  if (!TOKEN) return c.json({ error: 'missing_github_token' }, 503);

  const parsed = specSchema.safeParse(await c.req.json().catch(() => null));

  if (!parsed.success) {
    return c.json({ error: 'invalid_body', details: parsed.error.flatten() }, 400);
  }

  const spec = parsed.data;
  const payload = { ...spec, body: renderIssueBody(spec), label: AGENT_LABEL };

  const payloadHash = createHash('sha256')
    .update(JSON.stringify({ payload, nonce: randomUUID() }))
    .digest('hex');

  const result = await pool.query<{ id: string; payload_hash: string }>(
    `insert into agent_actions
       (profile, intent, targets, payload, payload_hash, risk_level, dry_run, status)
     values ($1, 'github_create_issue', $2::jsonb, $3::jsonb, $4, 'reversible_write', false, 'proposed')
     returning id, payload_hash`,
    [PROFILE, JSON.stringify([spec.repo]), JSON.stringify(payload), payloadHash],
  );

  const action = result.rows[0];

  await logEvent(action.id, 'created', 'github_spec_proposed', {
    repo: spec.repo,
    criteria: spec.acceptance_criteria.length,
  });

  if (slackConfigured()) {
    await postMessage(
      `Spécification prête pour *${spec.repo}* : ${spec.title}\n` +
        `${spec.acceptance_criteria.length} critère(s) d'acceptation, ${(spec.edge_cases ?? []).length} cas limite(s)\n` +
        `Valider : \`!approve ${action.id}\` · Refuser : \`!reject ${action.id} <raison>\``,
    );
  }

  return c.json({
    ok: true,
    action_id: action.id,
    payload_hash: action.payload_hash,
    preview: payload.body,
  });
});

/** Ouvre l'issue une fois la specification approuvee. */
app.post('/execute', async (c) => {
  if (!TOKEN) return c.json({ error: 'missing_github_token' }, 503);

  const parsed = executeSchema.safeParse(await c.req.json().catch(() => null));

  if (!parsed.success) {
    return c.json({ error: 'invalid_body', details: parsed.error.flatten() }, 400);
  }

  const { action_id: actionId } = parsed.data;

  const result = await pool.query<{
    id: string;
    intent: string;
    status: string;
    payload: { repo: string; title: string; body: string; label: string };
  }>(`select id, intent, status, payload from agent_actions where id = $1`, [actionId]);

  const action = result.rows[0];

  if (!action) return c.json({ error: 'action_not_found' }, 404);
  if (action.intent !== 'github_create_issue') {
    return c.json({ error: 'wrong_intent', intent: action.intent }, 400);
  }
  if (action.status !== 'approved') {
    return c.json(
      { error: 'not_approved', status: action.status, message: 'Issue non validée.' },
      403,
    );
  }

  const response = await githubFetch(`/repos/${action.payload.repo}/issues`, {
    method: 'POST',
    body: JSON.stringify({
      title: action.payload.title,
      body: action.payload.body,
      labels: [action.payload.label],
    }),
  });

  const body = (await response.json()) as { html_url?: string; number?: number; message?: string };

  if (!response.ok || !body.number) {
    await pool.query(
      `update agent_actions set status = 'failed', executed_at = now(), error_message = $2
        where id = $1`,
      [actionId, `github_http_${response.status}: ${body.message ?? ''}`.slice(0, 500)],
    );
    await logEvent(actionId, 'failed', 'github_issue_failed', { status: response.status });
    return c.json({ error: 'github_error', status: response.status, message: body.message }, 502);
  }

  await pool.query(
    `update agent_actions
        set status = 'executed', executed_at = now(),
            payload = payload || $2::jsonb
      where id = $1`,
    [actionId, JSON.stringify({ issue_number: body.number, issue_url: body.html_url })],
  );

  await logEvent(actionId, 'executed', 'github_issue_created', {
    repo: action.payload.repo,
    number: body.number,
  });

  if (slackConfigured()) {
    await postMessage(`Issue ouverte : ${body.html_url}`);
  }

  return c.json({ ok: true, issue_number: body.number, issue_url: body.html_url });
});

/**
 * Poste une review sur une PR. Commentaire uniquement : aucun merge, aucune
 * approbation GitHub formelle n'est emise par l'agent.
 */
app.post('/review', async (c) => {
  if (!TOKEN) return c.json({ error: 'missing_github_token' }, 503);

  const parsed = reviewSchema.safeParse(await c.req.json().catch(() => null));

  if (!parsed.success) {
    return c.json({ error: 'invalid_body', details: parsed.error.flatten() }, 400);
  }

  const { repo, pr_number: prNumber, body } = parsed.data;

  const response = await githubFetch(`/repos/${repo}/issues/${prNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body: `${body}\n\n---\n_Review automatique — le merge reste humain._` }),
  });

  if (!response.ok) {
    const detail = (await response.json()) as { message?: string };
    return c.json({ error: 'github_error', status: response.status, message: detail.message }, 502);
  }

  const comment = (await response.json()) as { html_url?: string };

  await logEvent(null, 'executed', 'github_review_posted', { repo, pr_number: prNumber });

  return c.json({ ok: true, comment_url: comment.html_url });
});

/** Controles de recevabilite d'une PR. Signale, ne bloque pas techniquement. */
async function inspectPullRequest(repo: string, prNumber: number) {
  const filesResponse = await githubFetch(`/repos/${repo}/pulls/${prNumber}/files?per_page=100`);

  if (!filesResponse.ok) return null;

  const files = (await filesResponse.json()) as Array<{ filename: string }>;
  const hasTests = files.some((file) =>
    /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[jt]sx?$/.test(file.filename),
  );

  return { fileCount: files.length, hasTests };
}

/**
 * Webhook GitHub. La signature HMAC est verifiee avant toute lecture du
 * contenu : sans secret configure, l'endpoint refuse tout.
 */
app.post('/webhook', async (c) => {
  if (!WEBHOOK_SECRET) return c.json({ error: 'webhook_secret_not_configured' }, 503);

  const raw = await c.req.text();
  const signature = c.req.header('x-hub-signature-256') ?? '';
  const expected = `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex')}`;

  const provided = Buffer.from(signature);
  const computed = Buffer.from(expected);

  if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) {
    return c.json({ error: 'invalid_signature' }, 401);
  }

  const event = c.req.header('x-github-event');
  const payload = JSON.parse(raw) as {
    action?: string;
    number?: number;
    repository?: { full_name?: string };
    pull_request?: { title?: string; html_url?: string; user?: { login?: string }; draft?: boolean };
  };

  if (event !== 'pull_request' || !['opened', 'reopened', 'ready_for_review'].includes(payload.action ?? '')) {
    return c.json({ ok: true, ignored: true, event, action: payload.action });
  }

  const repo = payload.repository?.full_name;
  const prNumber = payload.number;

  if (!repo || !prNumber) return c.json({ error: 'incomplete_payload' }, 400);

  const inspection = await inspectPullRequest(repo, prNumber);

  await logEvent(null, 'executed', 'github_pr_received', {
    repo,
    pr_number: prNumber,
    has_tests: inspection?.hasTests ?? null,
  });

  if (slackConfigured()) {
    const warning =
      inspection && !inspection.hasTests
        ? '\nAucun fichier de test dans la PR — critère de recevabilité non tenu.'
        : '';

    // Le titre vient de l'exterieur : cite entre backticks, jamais execute.
    await postMessage(
      `PR à revoir sur *${repo}* #${prNumber} : \`${(payload.pull_request?.title ?? '').slice(0, 200)}\`\n` +
        `${payload.pull_request?.html_url ?? ''}${warning}`,
    );
  }

  return c.json({ ok: true, repo, pr_number: prNumber, inspection });
});

export default app;
