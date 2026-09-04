import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createGatewayInboxRelay } from './inbox-relay.js';

type QueryResult<T> = { rows: T[] };

function mockPool(sequence: Array<QueryResult<Record<string, unknown>>>) {
  let i = 0;
  return {
    query: vi.fn(async () => {
      const next = sequence[i] ?? sequence[sequence.length - 1]!;
      i += 1;
      return next;
    }),
  };
}

const SHORT = 'ping';

const LONG_MISSION = `Mission réelle V1 — projet Imane
Projet : https://github.com/NadirL05/imane-projet
Objectif : analyses le repository
Nom de mission :
IMANE-PROJECT-AUDIT-V1
`;

describe('createGatewayInboxRelay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout par défaut aligné sur Hermès 600s (fast path sync)', async () => {
    const pool = mockPool([
      {
        rows: [
          {
            id: '11111111-1111-1111-1111-111111111111',
            status: 'pending',
            delivery_mode: 'sync',
            mission_title: null,
            response_text: null,
            run_id: null,
            error_code: null,
          },
        ],
      },
      ...Array.from({ length: 5 }, () => ({
        rows: [{ status: 'pending', response_text: null, run_id: null, error_code: null }],
      })),
    ]);
    const relay = createGatewayInboxRelay('hermes', pool as never);

    const pending = relay.execute({
      prompt: SHORT,
      channel: 'C1',
      threadTs: '1.0',
      userId: 'U1',
      eventId: 'Ev1',
    });

    await vi.advanceTimersByTimeAsync(119_000);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(481_000);
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('inbox_timeout');
    }
  });

  it('mission longue → ACK immédiat sans attendre le worker', async () => {
    const pool = mockPool([
      {
        rows: [
          {
            id: '44444444-4444-4444-4444-444444444444',
            status: 'pending',
            delivery_mode: 'async',
            mission_title: 'IMANE-PROJECT-AUDIT-V1',
            response_text: null,
            run_id: null,
            error_code: null,
          },
        ],
      },
    ]);
    const relay = createGatewayInboxRelay('hermes', pool as never, {
      pollIntervalMs: 10,
      timeoutMs: 60_000,
    });

    const started = Date.now();
    const result = await relay.execute({
      prompt: LONG_MISSION,
      channel: 'C1',
      threadTs: '1.0',
      userId: 'U1',
      eventId: 'EvAsync1',
    });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(50);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain('IMANE-PROJECT-AUDIT-V1');
      expect(result.text).toContain('queued');
      expect(result.text).toContain('44444444-4444-4444-4444-444444444444');
      expect(result.run_id).toBe('44444444-4444-4444-4444-444444444444');
    }
    // Un seul INSERT — pas de poll SELECT status
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('duplicate Slack event_id → même mission, pas de double insert exécutable', async () => {
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('ON CONFLICT')) {
          return { rows: [] };
        }
        return {
          rows: [
            {
              id: '55555555-5555-5555-5555-555555555555',
              status: 'processing',
              delivery_mode: 'async',
              mission_title: 'IMANE-PROJECT-AUDIT-V1',
              response_text: null,
              run_id: null,
              error_code: null,
            },
          ],
        };
      }),
    };
    const relay = createGatewayInboxRelay('hermes', pool as never);
    const result = await relay.execute({
      prompt: LONG_MISSION,
      channel: 'C1',
      threadTs: '1.0',
      userId: 'U1',
      eventId: 'EvDup',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain('55555555-5555-5555-5555-555555555555');
      expect(result.text).toContain('running');
    }
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('retourne ok quand status done avec response_text (sync)', async () => {
    const pool = mockPool([
      {
        rows: [
          {
            id: '22222222-2222-2222-2222-222222222222',
            status: 'pending',
            delivery_mode: 'sync',
            mission_title: null,
            response_text: null,
            run_id: null,
            error_code: null,
          },
        ],
      },
      {
        rows: [
          {
            status: 'done',
            response_text: 'réponse hermès',
            run_id: 'r1',
            error_code: null,
          },
        ],
      },
    ]);
    const relay = createGatewayInboxRelay('hermes', pool as never, {
      pollIntervalMs: 10,
      timeoutMs: 1_000,
    });
    const result = await relay.execute({
      prompt: SHORT,
      channel: 'C1',
      threadTs: '1.0',
      userId: 'U1',
      eventId: 'Ev2',
    });
    expect(result).toEqual({ ok: true, text: 'réponse hermès', run_id: 'r1' });
  });

  it('retourne failed avec error_code du consumer (sync)', async () => {
    const pool = mockPool([
      {
        rows: [
          {
            id: '33333333-3333-3333-3333-333333333333',
            status: 'pending',
            delivery_mode: 'sync',
            mission_title: null,
            response_text: null,
            run_id: null,
            error_code: null,
          },
        ],
      },
      {
        rows: [
          {
            status: 'failed',
            response_text: null,
            run_id: null,
            error_code: 'hermes_exit_1',
          },
        ],
      },
    ]);
    const relay = createGatewayInboxRelay('hermes', pool as never, {
      pollIntervalMs: 10,
      timeoutMs: 1_000,
    });
    const result = await relay.execute({
      prompt: SHORT,
      channel: 'C1',
      threadTs: '1.0',
      userId: 'U1',
      eventId: 'Ev3',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('hermes_exit_1');
    }
  });
});
