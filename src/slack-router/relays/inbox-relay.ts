import type { Pool } from 'pg';
import type { SlackRouteTarget } from '../../core/slack-router/types.js';
import { failClosed, type RelayAdapter, type RelayContext, type RelayResult } from './types.js';

const INBOX_TARGETS = new Set<SlackRouteTarget>(['hermes', 'ana']);

export type InboxRelayConfig = {
  pollIntervalMs: number;
  timeoutMs: number;
};

const DEFAULT_INBOX_CONFIG: InboxRelayConfig = {
  pollIntervalMs: 500,
  timeoutMs: 120_000,
};

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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

      let inboxId: string;
      try {
        const inserted = await pool.query<{ id: string }>(
          `INSERT INTO slack_gateway_inbox
             (target, prompt, channel_id, thread_ts, user_id, event_id, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending')
           RETURNING id`,
          [target, ctx.prompt, ctx.channel, ctx.threadTs, ctx.userId, ctx.eventId],
        );
        inboxId = inserted.rows[0]!.id;
      } catch {
        return failClosed(
          target,
          'inbox_insert_failed',
          `Inbox ${target} indisponible (stockage).`,
        );
      }

      const deadline = Date.now() + config.timeoutMs;
      while (Date.now() < deadline) {
        try {
          const row = await pool.query<{
            status: string;
            response_text: string | null;
            run_id: string | null;
            error_code: string | null;
          }>(
            `SELECT status, response_text, run_id, error_code
             FROM slack_gateway_inbox WHERE id = $1`,
            [inboxId],
          );
          const item = row.rows[0];
          if (!item) {
            return failClosed(target, 'inbox_missing', `Entrée inbox ${target} perdue.`);
          }

          if (item.status === 'done' && item.response_text) {
            return { ok: true, text: item.response_text, run_id: item.run_id ?? undefined };
          }
          if (item.status === 'failed') {
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
