import { describe, expect, it, vi } from 'vitest';
import { createSocketModeRunner, nextBackoffMs } from './socket-mode-client.js';
import type { SocketModeTransport } from './socket-mode-client.js';

describe('nextBackoffMs', () => {
  it('double jusqu au plafond 30s', () => {
    expect(nextBackoffMs(1)).toBe(1000);
    expect(nextBackoffMs(2)).toBe(2000);
    expect(nextBackoffMs(6)).toBe(30000);
    expect(nextBackoffMs(10)).toBe(30000);
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
