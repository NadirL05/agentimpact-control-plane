import { describe, expect, it } from 'vitest';
import { dispatchSlackMessage, type DispatchStores } from '../dispatch.js';
import { createMemoryRateLimitStore } from '../../core/slack-router/rate-limit.js';
import type { SlackMessageEvent, SlackRouteTarget } from '../../core/slack-router/types.js';
import { createPostgresPersistenceWithQueryable } from './postgres-persistence.js';

type OwnerRow = { owner: SlackRouteTarget };

class FakePgClient {
  eventDedup = new Set<string>();
  owners = new Map<string, OwnerRow>();
  inserts: Array<{ threadKey: string; owner: SlackRouteTarget }> = [];

  async query(sql: string, params: unknown[] = []): Promise<{ rowCount: number; rows: OwnerRow[] }> {
    const normalized = sql.replace(/\s+/g, ' ').trim();

    if (normalized.startsWith('BEGIN') || normalized.startsWith('COMMIT') || normalized.startsWith('ROLLBACK')) {
      return { rowCount: 0, rows: [] };
    }

    if (normalized.includes('INSERT INTO slack_event_dedup')) {
      const key = `${params[0]}:${params[1]}`;
      if (this.eventDedup.has(key)) {
        return { rowCount: 0, rows: [] };
      }
      this.eventDedup.add(key);
      return { rowCount: 1, rows: [] };
    }

    if (normalized.includes('INSERT INTO slack_thread_owners')) {
      const threadKey = String(params[0]);
      const owner = params[4] as SlackRouteTarget;
      if (!this.owners.has(threadKey)) {
        this.owners.set(threadKey, { owner });
        this.inserts.push({ threadKey, owner });
      }
      return { rowCount: 1, rows: [] };
    }

    if (normalized.includes('SELECT owner FROM slack_thread_owners')) {
      const row = this.owners.get(String(params[0]));
      if (!row) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 1, rows: [row] };
    }

    throw new Error(`unexpected_sql:${normalized}`);
  }
}

function storesFor(client: FakePgClient): DispatchStores {
  return {
    persistence: createPostgresPersistenceWithQueryable(async () => client),
    grokRateLimit: createMemoryRateLimitStore({
      perUserWindowMs: 60_000,
      perUserMax: 10,
      perChannelWindowMs: 60_000,
      perChannelMax: 20,
    }),
    grokInFlight: { active: false },
  };
}

const NATIVE_IDS = new Set(['UCURSOR01']);
const dispatchCfg = {
  nadirUserId: 'UNADIR001',
  nativeAgentUserIds: NATIVE_IDS,
};

function event(overrides: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
  return {
    type: 'message',
    event_id: 'E-root',
    team_id: 'T1',
    channel: 'C1',
    user: 'U1',
    text: 'ROUTE GROK: aide <@UCURSOR01|Cursor>',
    ts: '70.0',
    ...overrides,
  };
}

describe('persistance PostgreSQL owner native', () => {
  it('écrit owner native en SQL avant tout parse ROUTE', async () => {
    const client = new FakePgClient();
    const result = await dispatchSlackMessage(event(), storesFor(client), dispatchCfg);
    expect(result).toMatchObject({ action: 'ignore', reason: 'native_agent_thread' });
    expect(client.inserts).toEqual([
      { threadKey: 'T1:C1:70.0', owner: 'native' },
    ]);
    expect(client.owners.get('T1:C1:70.0')).toEqual({ owner: 'native' });
  });

  it('ignore un follow-up après reconstruction du routeur (store SQL, pas cache mémoire)', async () => {
    const durable = new FakePgClient();
    const first = await dispatchSlackMessage(event(), storesFor(durable), dispatchCfg);
    expect(first).toMatchObject({ action: 'ignore', reason: 'native_agent_thread' });

    const reconstructed = new FakePgClient();
    reconstructed.owners = durable.owners;
    reconstructed.eventDedup = new Set();

    const follow = await dispatchSlackMessage(
      event({
        event_id: 'E-follow',
        text: 'suite humaine sans mention',
        ts: '70.1',
        thread_ts: '70.0',
      }),
      storesFor(reconstructed),
      dispatchCfg,
    );
    expect(follow).toMatchObject({ action: 'ignore', reason: 'native_agent_thread' });
    expect(reconstructed.inserts).toHaveLength(0);
    expect(reconstructed.owners.get('T1:C1:70.0')).toEqual({ owner: 'native' });
  });
});
