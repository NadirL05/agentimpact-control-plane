import { threadKey } from '../../core/slack-router/event-filter.js';
import type { SlackMessageEvent, SlackRouteTarget } from '../../core/slack-router/types.js';
import type { PersistencePrepareResult, RouterPersistence } from './persistence.js';
import { getSlackRouterPool, type PgQueryable } from './pg-pool.js';

export async function prepareDispatchTx(
  client: PgQueryable,
  event: SlackMessageEvent,
  candidate: SlackRouteTarget,
  isRoot: boolean,
): Promise<PersistencePrepareResult> {
  const dedupInsert = await client.query(
    `INSERT INTO slack_event_dedup (team_id, event_id)
     VALUES ($1, $2)
     ON CONFLICT (team_id, event_id) DO NOTHING
     RETURNING event_id`,
    [event.team_id, event.event_id],
  );

  if ((dedupInsert.rowCount ?? 0) === 0) {
    return { status: 'deduplicated' };
  }

  const tKey = threadKey(event);
  const threadRootTs = event.thread_ts && event.thread_ts !== event.ts ? event.thread_ts : event.ts;

  if (isRoot) {
    await client.query(
      `INSERT INTO slack_thread_owners (thread_key, team_id, channel_id, thread_root_ts, owner)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (thread_key) DO NOTHING`,
      [tKey, event.team_id, event.channel, threadRootTs, candidate],
    );
  }

  const ownerRow = await client.query<{ owner: SlackRouteTarget }>(
    `SELECT owner FROM slack_thread_owners WHERE thread_key = $1`,
    [tKey],
  );

  if ((ownerRow.rowCount ?? 0) === 0) {
    return { status: 'unowned_thread' };
  }

  const owner = ownerRow.rows[0]!.owner;
  return { status: 'ready', owner, thread_key: tKey };
}

export function createPostgresPersistence(): RouterPersistence {
  const pool = getSlackRouterPool();

  return {
    async prepare(event, candidate, isRoot) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await prepareDispatchTx(client, event, candidate, isRoot);
        if (result.status === 'deduplicated') {
          await client.query('ROLLBACK');
          return result;
        }
        if (result.status === 'unowned_thread') {
          await client.query('COMMIT');
          return result;
        }
        await client.query('COMMIT');
        return result;
      } catch {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore rollback failure
        }
        return { status: 'storage_error' };
      } finally {
        client.release();
      }
    },
    async healthcheck() {
      try {
        await pool.query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Expose la logique SQL pour tests sans Postgres réel. */
export function createPostgresPersistenceWithQueryable(
  connect: () => Promise<PgQueryable & { release?: () => void }>,
): RouterPersistence {
  return {
    async prepare(event, candidate, isRoot) {
      const client = await connect();
      try {
        await client.query('BEGIN');
        const result = await prepareDispatchTx(client, event, candidate, isRoot);
        if (result.status === 'deduplicated') {
          await client.query('ROLLBACK');
          return result;
        }
        if (result.status === 'unowned_thread') {
          await client.query('COMMIT');
          return result;
        }
        await client.query('COMMIT');
        return result;
      } catch {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore
        }
        return { status: 'storage_error' };
      } finally {
        client.release?.();
      }
    },
    async healthcheck() {
      return true;
    },
  };
}
