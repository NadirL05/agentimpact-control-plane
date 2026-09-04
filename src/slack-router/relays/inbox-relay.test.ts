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

describe('createGatewayInboxRelay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout par défaut aligné sur Hermès 600s', async () => {
    const pool = mockPool([
      { rows: [{ id: '11111111-1111-1111-1111-111111111111' }] },
      ...Array.from({ length: 5 }, () => ({
        rows: [{ status: 'pending', response_text: null, run_id: null, error_code: null }],
      })),
    ]);
    const relay = createGatewayInboxRelay('hermes', pool as never);

    const pending = relay.execute({
      prompt: 'ping',
      channel: 'C1',
      threadTs: '1.0',
      userId: 'U1',
      eventId: 'Ev1',
    });

    // Avant 600s : toujours en cours
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

  it('retourne ok quand status done avec response_text', async () => {
    const pool = mockPool([
      { rows: [{ id: '22222222-2222-2222-2222-222222222222' }] },
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
      prompt: 'ping',
      channel: 'C1',
      threadTs: '1.0',
      userId: 'U1',
      eventId: 'Ev2',
    });
    expect(result).toEqual({ ok: true, text: 'réponse hermès', run_id: 'r1' });
  });

  it('retourne failed avec error_code du consumer', async () => {
    const pool = mockPool([
      { rows: [{ id: '33333333-3333-3333-3333-333333333333' }] },
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
      prompt: 'ping',
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
