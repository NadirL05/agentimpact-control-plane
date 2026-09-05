#!/usr/bin/env node
import { MissionStore } from '../core/missions-v2/store.js';
import { enabled, projects } from '../core/missions-v2/model.js';
import { loadSlackRouterConfig, assertRouterHasNoCursorKeyEnv } from './config.js';
import {
  createDefaultRelays,
  createDispatchStores,
  handleSlackEnvelope,
} from './event-handler.js';
import { startAsyncInboxNotifier } from './async-inbox-notifier.js';
import { startHealthServer } from './health-server.js';
import { createMetrics, metricsSnapshot } from './metrics.js';
import { createSlackSocketTransport, createSocketModeRunner } from './socket-mode-client.js';
import { getSlackRouterPool } from './stores/pg-pool.js';
import { WebClient } from '@slack/web-api';

async function main(): Promise<void> {
  assertRouterHasNoCursorKeyEnv();
  const config = loadSlackRouterConfig();
  const metrics = createMetrics();
  const stores = createDispatchStores(config);
  const relays = createDefaultRelays(config);
  const missionsV2 = enabled() ? new MissionStore(getSlackRouterPool(), {enabled:true,projects:projects()}) : undefined;

  if (!(await stores.persistence.healthcheck())) {
    throw new Error('postgres_unavailable');
  }

  const slack = new WebClient(config.botToken);
  const poster = {
    async postThreadReply(channel: string, threadTs: string, text: string) {
      await slack.chat.postMessage({ channel, thread_ts: threadTs, text });
    },
  };

  const logLine = (line: string) => {
    process.stdout.write(`${line}\n`);
  };

  const asyncNotifier = startAsyncInboxNotifier({
    pool: getSlackRouterPool(),
    poster,
    logLine,
    pollIntervalMs: 2_000,
  });

  let shuttingDown = false;

  const health = startHealthServer(
    config.healthPort,
    () => metricsSnapshot(metrics),
    () => socket.isConnected() && !shuttingDown,
  );

  const transport = createSlackSocketTransport(config);
  const socket = createSocketModeRunner(
    transport,
    {
      onEnvelope: async (envelope, accepted) => {
        await handleSlackEnvelope(envelope, stores, {
          config,
          poster,
          metrics,
          logLine,
          relays,
          missionsV2,
        }, accepted);
      },
      onReconnect: () => {
        metrics.socket_reconnects += 1;
      },
      onFatalError: (err) => {
        logLine(`status=fatal error=${err.message}`);
        void shutdown(1);
      },
    },
    () => undefined,
  );

  async function shutdown(code = 0): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    asyncNotifier.stop();
    await socket.stop();
    health.close();
    process.exit(code);
  }

  process.on('SIGTERM', () => void shutdown(0));
  process.on('SIGINT', () => void shutdown(0));

  await socket.start();
  logLine('status=started');
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : 'startup_failed';
  process.stderr.write(`slack-router startup error: ${msg}\n`);
  process.exit(1);
});
