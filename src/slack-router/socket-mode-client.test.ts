import { describe, expect, it, vi } from 'vitest';
import {
  createSocketModeRunner,
  nextBackoffMs,
  normalizeSocketModeSlackEvent,
} from './socket-mode-client.js';
import type { SocketModeSlackEvent, SocketModeTransport } from './socket-mode-client.js';
import { isEventsApiEnvelope } from './slack-envelope.js';

describe('nextBackoffMs', () => {
  it('double jusqu au plafond 30s', () => {
    expect(nextBackoffMs(1)).toBe(1000);
    expect(nextBackoffMs(2)).toBe(2000);
    expect(nextBackoffMs(6)).toBe(30000);
    expect(nextBackoffMs(10)).toBe(30000);
  });
});

/**
 * Régression : @slack/socket-mode 2.0.7 émet slack_event avec body = payload,
 * pas une enveloppe { type, envelope_id, payload }. Sans normalisation,
 * isEventsApiEnvelope rejette silencieusement tous les événements.
 */
describe('normalizeSocketModeSlackEvent (socket-mode 2.0.7)', () => {
  const payload = {
    team_id: 'T1',
    event_id: 'Ev1',
    event: { type: 'message', channel: 'C1', user: 'U1', text: 'hi', ts: '1.0' },
  };

  function sdkEvent(overrides: Partial<SocketModeSlackEvent> = {}): SocketModeSlackEvent {
    return {
      envelope_id: 'env-1',
      type: 'events_api',
      body: payload,
      ack: async () => undefined,
      ...overrides,
    };
  }

  it('reconstruit une enveloppe Events API valide pour handleSlackEnvelope', () => {
    const raw = normalizeSocketModeSlackEvent(sdkEvent());
    expect(raw).toEqual({
      envelope_id: 'env-1',
      type: 'events_api',
      payload,
    });
    expect(isEventsApiEnvelope(raw)).toBe(true);
    if (isEventsApiEnvelope(raw)) {
      expect(raw.payload.event_id).toBe('Ev1');
      expect(raw.payload.team_id).toBe('T1');
    }
  });

  it('ne passe pas isEventsApiEnvelope si on transmet seulement event.body (bug historique)', () => {
    const event = sdkEvent();
    expect(isEventsApiEnvelope(event.body)).toBe(false);
  });

  it('filtre les types non events_api via le runner', async () => {
    const transport = mockTransport();
    const onEnvelope = vi.fn(async () => undefined);
    const client = createSocketModeRunner(
      transport,
      { onEnvelope },
      () => undefined,
    );
    await client.start();

    transport.handlers?.onMessage(
      normalizeSocketModeSlackEvent(sdkEvent({ type: 'disconnect' })),
    );
    expect(onEnvelope).not.toHaveBeenCalled();

    transport.handlers?.onMessage(normalizeSocketModeSlackEvent(sdkEvent()));
    expect(onEnvelope).toHaveBeenCalledTimes(1);
    expect(onEnvelope.mock.calls[0][0]).toMatchObject({
      envelope_id: 'env-1',
      type: 'events_api',
      payload,
    });
  });
});

function mockTransport(): SocketModeTransport & {
  handlers: { onMessage: (d: unknown) => void; onDisconnect: () => void } | null;
  connected: boolean;
  connectCalls: number;
} {
  return {
    handlers: null,
    connected: false,
    connectCalls: 0,
    setHandlers(h) {
      this.handlers = h;
    },
    async connect() {
      this.connectCalls += 1;
      this.connected = true;
    },
    async disconnect() {
      this.connected = false;
    },
    isConnected() {
      return this.connected;
    },
  };
}

describe('createSocketModeRunner reconnect', () => {
  it('reconnecte avec backoff puis s arrête après max tentatives', async () => {
    vi.useFakeTimers();
    const transport = mockTransport();
    let connectCalls = 0;
    transport.connect = vi.fn(async function (this: typeof transport) {
      connectCalls += 1;
      if (connectCalls === 1) {
        this.connected = true;
        return;
      }
      throw new Error('connect_failed');
    });

    const fatal = vi.fn();
    const reconnects = vi.fn();
    const client = createSocketModeRunner(
      transport,
      {
        onEnvelope: async () => undefined,
        onReconnect: reconnects,
        onFatalError: fatal,
      },
      () => undefined,
      2,
    );

    await client.start();
    expect(client.isConnected()).toBe(true);

    transport.handlers?.onDisconnect();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);

    expect(reconnects).toHaveBeenCalled();
    expect(fatal).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'socket_reconnect_exhausted' }),
    );

    vi.useRealTimers();
  });
});
