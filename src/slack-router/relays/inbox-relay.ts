import type { Pool } from 'pg';
import type { SlackRouteTarget } from '../../core/slack-router/types.js';
import {
  detectLongRunningMission,
  formatAsyncMissionAck,
  mapInboxStatusToUx,
} from '../../core/slack-router/long-running-mission.js';
import { failClosed, type RelayAdapter, type RelayContext, type RelayResult } from './types.js';

const INBOX_TARGETS = new Set<SlackRouteTarget>(['hermes', 'ana']);

export type InboxRelayConfig = {
  pollIntervalMs: number;
  /** Timeout poll sync uniquement — jamais utilisé pour delivery_mode=async. */
  timeoutMs: number;
};

const DEFAULT_INBOX_CONFIG: InboxRelayConfig = {
  pollIntervalMs: 500,
  // Aligné sur le timeout subprocess Hermès (600s) du consumer (fast path).
  timeoutMs: 600_000,
};

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

type InboxRow = {
  id: string;
  status: string;
  delivery_mode: string;
  mission_title: string | null;
  response_text: string | null;
  run_id: string | null;
  error_code: string | null;
};

async function insertOrGetInbox(
  pool: Pool,
  target: 'hermes' | 'ana',
  ctx: RelayContext,
  deliveryMode: 'sync' | 'async',
  missionTitle: string | null,
): Promise<InboxRow | null> {
  const inserted = await pool.query<InboxRow>(
    `INSERT INTO slack_gateway_inbox
       (target, prompt, channel_id, thread_ts, user_id, event_id, status, delivery_mode, mission_title)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING id, status, delivery_mode, mission_title, response_text, run_id, error_code`,
    [
      target,
      ctx.prompt,
      ctx.channel,
      ctx.threadTs,
      ctx.userId,
      ctx.eventId,
      deliveryMode,
      missionTitle,
    ],
  );

  if (inserted.rows[0]) return inserted.rows[0];

  const existing = await pool.query<InboxRow>(
    `SELECT id, status, delivery_mode, mission_title, response_text, run_id, error_code
     FROM slack_gateway_inbox WHERE event_id = $1`,
    [ctx.eventId],
  );
  return existing.rows[0] ?? null;
}

function asyncAck(target: 'hermes' | 'ana', row: InboxRow): RelayResult {
  return {
    ok: true,
    text: formatAsyncMissionAck({
      missionId: row.id,
      agent: target,
      status: mapInboxStatusToUx(row.status),
      missionTitle: row.mission_title,
    }),
    run_id: row.id,
  };
}

export function createGatewayInboxRelay(
  target: 'hermes' | 'ana',
  pool: Pool,
  config: InboxRelayConfig = DEFAULT_INBOX_CONFIG,
): RelayAdapter {
  return {
    target,
    async execute(ctx: RelayContext): Promise<RelayResult> {
      if (!INBOX_TARGETS.has(target)) {
        return failClosed(target, 'invalid_inbox_target', 'Cible inbox invalide.');
      }

      const decision = detectLongRunningMission(ctx.prompt);

      let row: InboxRow;
      try {
        const upserted = await insertOrGetInbox(
          pool,
          target,
          ctx,
          decision.mode,
          decision.missionTitle,
        );
        if (!upserted) {
          return failClosed(
            target,
            'inbox_insert_failed',
            `Inbox ${target} indisponible (stockage).`,
          );
        }
        row = upserted;
      } catch {
        return failClosed(
          target,
          'inbox_insert_failed',
          `Inbox ${target} indisponible (stockage).`,
        );
      }

      // Chemin async : ACK immédiat — le worker + notifier livrent le résultat.
      if (row.delivery_mode === 'async' || decision.mode === 'async') {
        return asyncAck(target, row);
      }

      const deadline = Date.now() + config.timeoutMs;
      while (Date.now() < deadline) {
        try {
          const polled = await pool.query<{
            status: string;
            response_text: string | null;
            run_id: string | null;
            error_code: string | null;
          }>(
            `SELECT status, response_text, run_id, error_code
             FROM slack_gateway_inbox WHERE id = $1`,
            [row.id],
          );
          const item = polled.rows[0];
          if (!item) {
            return failClosed(target, 'inbox_missing', `Entrée inbox ${target} perdue.`);
          }

          if (item.status === 'done' && item.response_text) {
            return { ok: true, text: item.response_text, run_id: item.run_id ?? undefined };
          }
          if (item.status === 'failed' || item.status === 'timeout' || item.status === 'cancelled') {
            return failClosed(
              target,
              item.error_code ?? 'inbox_failed',
              `Gateway ${target} n'a pas pu traiter la demande.`,
            );
          }
        } catch {
          return failClosed(
            target,
            'inbox_poll_failed',
            `Inbox ${target} injoignable (stockage).`,
          );
        }

        await sleep(config.pollIntervalMs);
      }

      return failClosed(
        target,
        'inbox_timeout',
        `Gateway ${target} n'a pas répondu à temps — vérifiez le consumer inbox.`,
      );
    },
  };
}
