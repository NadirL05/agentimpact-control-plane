import { describe, expect, it, vi } from 'vitest';
import { createSocketModeRunner } from './socket-mode-client.js';
import type { SocketModeTransport } from './socket-mode-client.js';
import type { SlackSocketEnvelope } from './slack-envelope.js';

function mockTransport(): SocketModeTransport & {
  handlers: { onMessage: (d: unknown) => void; onDisconnect: () => void } | null;
  connected: boolean;
} {
  return {
    handlers: null,
    connected: false,
    setHandlers(h) {
      this.handlers = h;
    },
    async connect() {
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

describe('createSocketModeRunner', () => {
  it('ACK immédiat via callback et traitement envelope', async () => {
    const transport = mockTransport();
    const ack = vi.fn();
    const envelopes: SlackSocketEnvelope[] = [];

    const client = createSocketModeRunner(
      transport,
      {
        onEnvelope: async (e) => {
          envelopes.push(e);
        },
      },
      ack,
    );

    await client.start();
    expect(client.isConnected()).toBe(true);

    const sample: SlackSocketEnvelope = {
      envelope_id: 'env-abc',
      type: 'events_api',
      payload: {
        team_id: 'T1',
        event_id: 'Ev1',
        event: { type: 'message', channel: 'C1', user: 'U1', text: 'hi', ts: '1.0' },
      },
    };

    transport.handlers?.onMessage(sample);
    await new Promise((r) => setTimeout(r, 10));
    expect(ack).toHaveBeenCalledWith('env-abc');
    expect(envelopes).toHaveLength(1);
  });
});
