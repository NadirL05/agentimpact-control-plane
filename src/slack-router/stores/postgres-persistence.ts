import { parseRoute } from '../../core/slack-router/parse-route.js';
import { detectLongRunningMission } from '../../core/slack-router/long-running-mission.js';
import { threadKey } from '../../core/slack-router/event-filter.js';
import type { SlackMessageEvent, SlackRouteTarget } from '../../core/slack-router/types.js';
import type { PersistencePrepareResult, RouterPersistence } from './persistence.js';
import { getSlackRouterPool } from './pg-pool.js';

export type SqlQueryResult = { rowCount: number | null; rows: Array<{ owner?: SlackRouteTarget }> };

export type SqlClient = {
  query(sql: string, params?: unknown[]): Promise<SqlQueryResult>;
};

export async function prepareDispatchTx(
  client: SqlClient,
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

  const ownerRow = await client.query(
    `SELECT owner FROM slack_thread_owners WHERE thread_key = $1`,
    [tKey],
  );

  if ((ownerRow.rowCount ?? 0) === 0) {
    return { status: 'unowned_thread' };
  }

  const owner = ownerRow.rows[0]!.owner;
  if (!owner) {
    return { status: 'unowned_thread' };
  }
  if (owner === 'hermes' || owner === 'ana') {
    const v2 = await client.query(`SELECT id FROM slack_gateway_inbox i
      WHERE channel_id=$1 AND thread_ts=$2 AND coalesce(to_jsonb(i)->>'orchestration_version','1')='2' LIMIT 1`,
      [event.channel,threadRootTs]);
    if (v2.rowCount) return {status:'v2_thread'};
    const prompt = parseRoute(event.text ?? '').prompt || (event.text ?? '').trim();
    const decision = detectLongRunningMission(prompt);
    await client.query(`INSERT INTO slack_gateway_inbox
      (target,prompt,channel_id,thread_ts,user_id,event_id,status,delivery_mode,mission_title)
      VALUES($1,$2,$3,$4,$5,$6,'pending',$7,$8)`,
      [owner,prompt,event.channel,threadRootTs,event.user,event.event_id,decision.mode,decision.missionTitle]);
  }
  return { status: 'ready', owner, thread_key: tKey };
}

export function createPostgresPersistence(): RouterPersistence {
  const pool = getSlackRouterPool();

  return {
    async prepare(event, candidate, isRoot) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await prepareDispatchTx(
          {
            query: async (sql, params) => {
              const result = await client.query(sql, params);
              return { rowCount: result.rowCount, rows: result.rows };
            },
          },
          event,
          candidate,
          isRoot,
        );
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
  connect: () => Promise<SqlClient & { release?: () => void }>,
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
