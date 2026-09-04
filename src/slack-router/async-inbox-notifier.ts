import type { Pool } from 'pg';

export type AsyncInboxPoster = {
  postThreadReply(channel: string, threadTs: string, text: string): Promise<void>;
};

export type AsyncInboxNotifierDeps = {
  pool: Pool;
  poster: AsyncInboxPoster;
  logLine?: (line: string) => void;
  pollIntervalMs?: number;
};

type NotifyRow = {
  id: string;
  status: string;
  channel_id: string;
  thread_ts: string;
  mission_title: string | null;
  response_text: string | null;
  error_code: string | null;
  slack_started_at: Date | null;
  slack_notified_at: Date | null;
  target: string;
};

function agentLabel(target: string): string {
  return target === 'ana' ? 'Ana' : 'Hermès';
}

function startedMessage(row: NotifyRow): string {
  const title = row.mission_title?.trim() || 'mission';
  return `Mission ${title} démarrée.\nID: ${row.id}\nAgent: ${agentLabel(row.target)}\nStatut: running`;
}

function finalMessage(row: NotifyRow): string {
  const title = row.mission_title?.trim() || 'mission';
  if (row.status === 'done') {
    const body = (row.response_text ?? '').trim() || '(réponse vide)';
    return `Mission ${title} terminée.\nID: ${row.id}\nStatut: completed\n\n${body}`;
  }
  const code = row.error_code ?? row.status;
  return `Mission ${title} échouée.\nID: ${row.id}\nStatut: ${row.status}\nCode: ${code}`;
}

/**
 * Notifie Slack pour les items inbox async sans maintenir de connexion HTTP
 * pendant toute la durée Hermès. Idempotent via slack_started_at / slack_notified_at.
 */
export async function drainAsyncInboxNotifications(
  pool: Pool,
  poster: AsyncInboxPoster,
): Promise<{ started: number; finalized: number }> {
  let started = 0;
  let finalized = 0;

  const startCandidates = await pool.query<NotifyRow>(
    `SELECT id, status, channel_id, thread_ts, mission_title, response_text, error_code,
            slack_started_at, slack_notified_at, target
     FROM slack_gateway_inbox
     WHERE delivery_mode = 'async'
       AND status = 'processing'
       AND slack_started_at IS NULL
     ORDER BY updated_at ASC
     LIMIT 20`,
  );

  for (const row of startCandidates.rows) {
    await poster.postThreadReply(row.channel_id, row.thread_ts, startedMessage(row));
    await pool.query(
      `UPDATE slack_gateway_inbox
       SET slack_started_at = now(), updated_at = now()
       WHERE id = $1 AND slack_started_at IS NULL`,
      [row.id],
    );
    started += 1;
  }

  const finalCandidates = await pool.query<NotifyRow>(
    `SELECT id, status, channel_id, thread_ts, mission_title, response_text, error_code,
            slack_started_at, slack_notified_at, target
     FROM slack_gateway_inbox
     WHERE delivery_mode = 'async'
       AND status IN ('done', 'failed', 'timeout', 'cancelled')
       AND slack_notified_at IS NULL
     ORDER BY updated_at ASC
     LIMIT 20`,
  );

  for (const row of finalCandidates.rows) {
    await poster.postThreadReply(row.channel_id, row.thread_ts, finalMessage(row));
    await pool.query(
      `UPDATE slack_gateway_inbox
       SET slack_notified_at = now(), updated_at = now()
       WHERE id = $1 AND slack_notified_at IS NULL`,
      [row.id],
    );
    finalized += 1;
  }

  return { started, finalized };
}

export function startAsyncInboxNotifier(deps: AsyncInboxNotifierDeps): {
  stop: () => void;
  tick: () => Promise<{ started: number; finalized: number }>;
} {
  const intervalMs = deps.pollIntervalMs ?? 2_000;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;

  const tick = async () => {
    if (inFlight) return { started: 0, finalized: 0 };
    inFlight = true;
    try {
      return await drainAsyncInboxNotifications(deps.pool, deps.poster);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'notify_failed';
      deps.logLine?.(`status=async_inbox_notify_error error=${msg}`);
      return { started: 0, finalized: 0 };
    } finally {
      inFlight = false;
    }
  };

  timer = setInterval(() => {
    void tick();
  }, intervalMs);

  return {
    stop: () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    tick,
  };
}
