import type { SlackRouterEnvConfig } from './config.js';
import { isEventsApiEnvelope, type SlackSocketEnvelope } from './slack-envelope.js';

export type SocketAck = (envelopeId: string) => void;

export type SocketModeHandlers = {
  onEnvelope: (envelope: SlackSocketEnvelope) => Promise<void>;
  onReconnect?: () => void;
  onFatalError?: (error: Error) => void;
};

export type SocketModeClient = {
  start(): Promise<void>;
  stop(): Promise<void>;
  isConnected(): boolean;
};

export type SocketModeTransport = {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  setHandlers(handlers: {
    onMessage: (data: unknown) => void;
    onDisconnect: () => void;
  }): void;
};

/** Backoff borné : 1s → 2s → 4s … max 30s, max 8 tentatives puis fatal. */
export function nextBackoffMs(attempt: number, capMs = 30_000): number {
  const base = Math.min(capMs, 1000 * 2 ** Math.max(0, attempt - 1));
  return base;
}

/**
 * Forme émise par @slack/socket-mode 2.0.x sur `slack_event` :
 * `{ ack, envelope_id, type, body }` où `body` = payload Events API.
 * `isEventsApiEnvelope` attend `{ envelope_id, type, payload }`.
 */
export type SocketModeSlackEvent = {
  envelope_id: string;
  type: string;
  body: unknown;
  ack: () => Promise<void>;
};

/** Reconstruit l'enveloppe Events API à partir de l'événement SDK Socket Mode. */
export function normalizeSocketModeSlackEvent(event: SocketModeSlackEvent): {
  envelope_id: string;
  type: string;
  payload: unknown;
} {
  return {
    envelope_id: event.envelope_id,
    type: event.type,
    payload: event.body,
  };
}

export function createSocketModeRunner(
  transport: SocketModeTransport,
  handlers: SocketModeHandlers,
  ack: SocketAck,
  maxReconnectAttempts = 8,
): SocketModeClient {
  let stopped = false;
  let connected = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  transport.setHandlers({
    onMessage: (raw) => {
      if (!isEventsApiEnvelope(raw)) return;
      ack(raw.envelope_id);
      void handlers.onEnvelope(raw).catch((err) => {
        handlers.onFatalError?.(err instanceof Error ? err : new Error(String(err)));
      });
    },
    onDisconnect: () => {
      connected = false;
      if (stopped) return;
      scheduleReconnect();
    },
  });

  function scheduleReconnect(): void {
    if (stopped) return;
    if (reconnectAttempt >= maxReconnectAttempts) {
      handlers.onFatalError?.(new Error('socket_reconnect_exhausted'));
      return;
    }
    reconnectAttempt += 1;
    handlers.onReconnect?.();
    const delay = nextBackoffMs(reconnectAttempt);
    reconnectTimer = setTimeout(() => {
      void connectLoop();
    }, delay);
  }

  async function connectLoop(): Promise<void> {
    if (stopped) return;
    try {
      await transport.connect();
      connected = true;
      reconnectAttempt = 0;
    } catch (_err) {
      scheduleReconnect();
    }
  }

  return {
    async start() {
      stopped = false;
      await connectLoop();
    },
    async stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      await transport.disconnect();
      connected = false;
    },
    isConnected() {
      return connected && transport.isConnected();
    },
  };
}

/** Fabrique un transport Slack Socket Mode (production). */
export function createSlackSocketTransport(config: SlackRouterEnvConfig): SocketModeTransport {
  let client: import('@slack/socket-mode').SocketModeClient | null = null;
  let onMessage: ((data: unknown) => void) | null = null;
  let onDisconnect: (() => void) | null = null;

  return {
    setHandlers(handlers) {
      onMessage = handlers.onMessage;
      onDisconnect = handlers.onDisconnect;
    },
    async connect() {
      const { SocketModeClient } = await import('@slack/socket-mode');
      client = new SocketModeClient({ appToken: config.appToken });
      client.on('slack_event', async (event: SocketModeSlackEvent) => {
        await event.ack();
        onMessage?.(normalizeSocketModeSlackEvent(event));
      });
      client.on('disconnect', () => onDisconnect?.());
      await client.start();
    },
    async disconnect() {
      await client?.disconnect();
      client = null;
    },
    isConnected() {
      return Boolean(client);
    },
  };
}
