/**
 * Brief quotidien Chief of Staff (semaine 4 de la roadmap).
 *
 * Lecture seule stricte : aucune ecriture hors journal d'execution. La collecte
 * est deterministe (SQL + API GitHub), pas de LLM : un brief faux est pire
 * qu'un brief absent, et chaque ligne doit pouvoir citer sa source.
 *
 * Regles roadmap : 10 elements maximum, chaque recommandation cite sa source,
 * pas de creation de ticket, pas d'envoi externe.
 */

import { Hono } from 'hono';
import { pool } from './db.js';
import { postMessage, slackConfigured } from './slack.js';
import { todayEvents } from './google.js';

const app = new Hono();

const MAX_ITEMS = 10;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPOS = (process.env.GITHUB_REPOS ?? '')
  .split(',')
  .map((r) => r.trim())
  .filter(Boolean);

type Section = {
  emoji: string;
  title: string;
  lines: string[];
};

type PullRequest = {
  repo: string;
  number: number;
  title: string;
  url: string;
  draft: boolean;
  ageDays: number;
};

function ageLabel(from: string | Date): string {
  const ms = Date.now() - new Date(from).getTime();
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "moins d'1 h";
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} j`;
}

/** Actions en attente d'une decision humaine : le coeur du brief. */
async function pendingDecisions(): Promise<string[]> {
  const result = await pool.query<{
    id: string;
    intent: string;
    profile: string;
    risk_level: string;
    created_at: string;
    approval_expires_at: string | null;
  }>(
    `select id, intent, profile, risk_level, created_at, approval_expires_at
       from agent_actions
      where status in ('proposed', 'approval_requested')
      order by created_at asc
      limit 5`,
  );

  return result.rows.map((row) => {
    const expired =
      row.approval_expires_at != null &&
      new Date(row.approval_expires_at).getTime() <= Date.now();
    const suffix = expired ? ' — *fenêtre expirée, à reproposer*' : '';
    return `\`${row.id.slice(0, 8)}\` ${row.intent} (${row.profile}, ${row.risk_level}, ${ageLabel(row.created_at)})${suffix} — source : \`agent_actions\``;
  });
}

/** Ce qui a echoue ou a ete bloque dans les dernieres 24 h. */
async function risks(): Promise<string[]> {
  const lines: string[] = [];

  const failed = await pool.query<{ intent: string; error_message: string | null; n: string }>(
    `select intent, error_message, count(*)::text as n
       from agent_actions
      where status = 'failed' and created_at > now() - interval '24 hours'
      group by intent, error_message
      order by count(*) desc
      limit 3`,
  );

  for (const row of failed.rows) {
    lines.push(
      `${row.n} action(s) \`${row.intent}\` en échec : ${row.error_message ?? 'sans message'} — source : \`agent_actions\``,
    );
  }

  const blocked = await pool.query<{ n: string }>(
    `select count(*)::text as n
       from agent_audit_events
      where event_type = 'blocked_by_policy' and created_at > now() - interval '24 hours'`,
  );

  if (Number(blocked.rows[0]?.n ?? 0) > 0) {
    lines.push(
      `${blocked.rows[0].n} action(s) bloquée(s) par policy — source : \`agent_audit_events\``,
    );
  }

  const stuck = await pool.query<{ n: string }>(
    `select count(*)::text as n
       from leads
      where fullenrich_status = 'pending'
        and fullenrich_started_at is not null
        and fullenrich_started_at < now() - interval '6 hours'`,
  );

  if (Number(stuck.rows[0]?.n ?? 0) > 0) {
    lines.push(
      `${stuck.rows[0].n} enrichissement(s) sans callback depuis plus de 6 h — vérifier le tunnel — source : \`leads\``,
    );
  }

  return lines;
}

/** Signaux commerciaux : nouveaux leads, enrichissements aboutis. */
async function opportunities(): Promise<string[]> {
  const lines: string[] = [];

  const fresh = await pool.query<{ n: string }>(
    `select count(*)::text as n from leads where created_at > now() - interval '24 hours'`,
  );

  if (Number(fresh.rows[0]?.n ?? 0) > 0) {
    lines.push(`${fresh.rows[0].n} nouveau(x) lead(s) sur 24 h — source : \`leads\``);
  }

  const enriched = await pool.query<{ company_name: string | null; email: string | null }>(
    `select company_name, email
       from leads
      where fullenrich_status = 'completed'
        and fullenriched_at is null
        and fullenrich_completed_at > now() - interval '24 hours'
        and email is not null
      order by fullenrich_completed_at desc
      limit 3`,
  );

  for (const row of enriched.rows) {
    lines.push(
      `${row.company_name ?? 'lead sans nom'} : contact trouvé, prêt pour un brouillon — source : \`leads\``,
    );
  }

  return lines;
}

/** Rendez-vous du jour. Lecture seule ; un calendrier muet ne bloque pas le brief. */
async function meetings(): Promise<string[]> {
  try {
    const events = await todayEvents();
    return events.slice(0, 4).map((event) => {
      const hour = event.start.includes('T')
        ? new Date(event.start).toLocaleTimeString('fr-FR', {
            hour: '2-digit',
            minute: '2-digit',
          })
        : 'journée';
      const people = event.attendees > 0 ? `, ${event.attendees} participant(s)` : '';
      const prep = event.attendees > 2 ? ' — préparation conseillée' : '';
      return `${hour} ${event.summary}${people}${prep} — source : Google Calendar`;
    });
  } catch (error) {
    return [
      `Calendrier injoignable (${error instanceof Error ? error.message : 'erreur'}) — source : Google Calendar`,
    ];
  }
}

async function fetchPullRequests(): Promise<PullRequest[]> {
  if (!GITHUB_TOKEN || GITHUB_REPOS.length === 0) return [];

  const results: PullRequest[] = [];

  for (const repo of GITHUB_REPOS) {
    try {
      const response = await fetch(
        `https://api.github.com/repos/${repo}/pulls?state=open&per_page=5`,
        {
          headers: {
            Authorization: `Bearer ${GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'agentimpact-control-plane',
          },
          signal: AbortSignal.timeout(10_000),
        },
      );

      if (!response.ok) continue;

      const pulls = (await response.json()) as Array<{
        number: number;
        title: string;
        html_url: string;
        draft: boolean;
        created_at: string;
      }>;

      for (const pull of pulls) {
        results.push({
          repo,
          number: pull.number,
          title: pull.title,
          url: pull.html_url,
          draft: pull.draft,
          ageDays: Math.floor(
            (Date.now() - new Date(pull.created_at).getTime()) / 86_400_000,
          ),
        });
      }
    } catch {
      // Un connecteur muet ne doit pas empecher le brief de partir.
    }
  }

  return results;
}

/** Sante des connecteurs : ce qui casse silencieusement se voit ici. */
async function connectorHealth(): Promise<string[]> {
  const lines: string[] = [];

  const missing: string[] = [];
  if (!process.env.FULLENRICH_API_KEY) missing.push('FullEnrich');
  if (!process.env.SLACK_BOT_TOKEN) missing.push('Slack');
  if (!GITHUB_TOKEN) missing.push('GitHub');
  if (!process.env.FULLENRICH_WEBHOOK_URL) missing.push('webhook FullEnrich');

  if (missing.length > 0) {
    lines.push(`Connecteur(s) non configuré(s) : ${missing.join(', ')}`);
  }

  return lines;
}

/** Top 3 deterministe : priorite au bloquant, puis au risque, puis au business. */
function topActions(sections: Record<string, string[]>): string[] {
  const top: string[] = [];

  if (sections.decisions.length > 0) {
    top.push(`Traiter ${sections.decisions.length} validation(s) en attente`);
  }
  if (sections.risks.length > 0) {
    top.push(`Corriger : ${sections.risks[0].split(' — source')[0]}`);
  }
  if (sections.delivery.length > 0) {
    top.push(`Revoir : ${sections.delivery[0].split(' — source')[0]}`);
  }
  if (sections.opportunities.length > 0 && top.length < 3) {
    top.push(`Exploiter : ${sections.opportunities[0].split(' — source')[0]}`);
  }

  return top.slice(0, 3);
}

function renderBrief(sections: Section[], truncated: number): string {
  const date = new Date().toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  const parts = [`*Brief du ${date}*`];

  for (const section of sections) {
    if (section.lines.length === 0) continue;
    parts.push(
      `\n${section.emoji} *${section.title}*\n${section.lines.map((l) => `• ${l}`).join('\n')}`,
    );
  }

  if (parts.length === 1) {
    parts.push('\nRien à signaler. Aucune action en attente, aucun échec sur 24 h.');
  }

  if (truncated > 0) {
    parts.push(`\n_${truncated} élément(s) non affiché(s) — plafond de ${MAX_ITEMS}._`);
  }

  return parts.join('\n');
}

async function buildBrief() {
  const [decisions, riskLines, opportunityLines, pulls, health, meetingLines] =
    await Promise.all([
      pendingDecisions(),
      risks(),
      opportunities(),
      fetchPullRequests(),
      connectorHealth(),
      meetings(),
    ]);

  const delivery = pulls.map(
    (pull) =>
      `${pull.repo}#${pull.number} ${pull.title}${pull.draft ? ' (draft)' : ''}, ouverte depuis ${pull.ageDays} j — source : GitHub`,
  );

  const grouped = {
    decisions,
    risks: riskLines,
    meetings: meetingLines,
    opportunities: opportunityLines,
    delivery: [...delivery, ...health],
  };

  // Plafond global a 10 elements : au-dela, le brief n'est plus lu.
  let budget = MAX_ITEMS;
  let truncated = 0;
  const capped: Record<string, string[]> = {};

  for (const [key, lines] of Object.entries(grouped)) {
    const kept = lines.slice(0, Math.max(budget, 0));
    truncated += lines.length - kept.length;
    budget -= kept.length;
    capped[key] = kept;
  }

  const sections: Section[] = [
    { emoji: '🟣', title: 'Décisions à prendre aujourd’hui', lines: capped.decisions },
    { emoji: '🟠', title: 'Risques / blocages', lines: capped.risks },
    { emoji: '🔵', title: 'Rendez-vous et préparation', lines: capped.meetings },
    { emoji: '🟢', title: 'Opportunités business', lines: capped.opportunities },
    { emoji: '⚙️', title: 'PR, CI et automatisations', lines: capped.delivery },
    { emoji: '🎯', title: 'Top 3 actions recommandées', lines: topActions(capped) },
  ];

  return {
    text: renderBrief(sections, truncated),
    counts: Object.fromEntries(
      Object.entries(capped).map(([key, lines]) => [key, lines.length]),
    ),
  };
}

/** Previsualisation, sans envoi Slack. */
app.get('/daily', async (c) => {
  const brief = await buildBrief();
  return c.json({ ok: true, ...brief });
});

/** Compose et publie le brief. Appele par le cron du matin. */
app.post('/daily', async (c) => {
  const brief = await buildBrief();

  if (!slackConfigured()) {
    return c.json({ ok: false, error: 'slack_not_configured', ...brief }, 503);
  }

  const slack = await postMessage(brief.text);

  await pool.query(
    `insert into agent_audit_events (event_type, actor, details)
     values ('executed', 'briefs', $1::jsonb)`,
    [JSON.stringify({ stage: 'morning_brief', ...brief.counts, slack_ok: slack.ok })],
  );

  return c.json({ ok: slack.ok, slack, counts: brief.counts }, slack.ok ? 200 : 502);
});

export default app;
