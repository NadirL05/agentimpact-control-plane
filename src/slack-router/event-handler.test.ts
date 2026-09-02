import { describe, expect, it, vi } from 'vitest';
import {
  createTestDispatchStores,
  handleSlackEnvelope,
} from './event-handler.js';
import type { SlackRouterEnvConfig } from './config.js';
import { createMetrics } from './metrics.js';
import type { SlackSocketEnvelope } from './slack-envelope.js';
import { createGrokRelay } from './relays/grok-relay.js';
import { createFailingPersistence, createMemoryPersistence } from './stores/persistence.js';
import { failClosed } from './relays/types.js';
import { writeFileSync, unlinkSync } from 'node:fs';
import { dispatchSlackMessage } from './dispatch.js';

function testConfig(overrides: Partial<SlackRouterEnvConfig> = {}): SlackRouterEnvConfig {
  return {
    nadirUserId: 'UNADIR001',
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    controlPlaneUrl: 'http://127.0.0.1:3000',
    bridgeToken: '',
    grokWorkerSocket: '/run/agentimpact-grok-worker/grok.sock',
    healthPort: 9120,
    killSwitchPath: '/tmp/grokbot.disabled',
    grokRateUserMax: 10,
    grokRateUserWindowMs: 60_000,
    grokRateChannelMax: 20,
    grokRateChannelWindowMs: 60_000,
    ...overrides,
  };
}

function envelope(eventId: string, text: string, user = 'U_HUMAN'): SlackSocketEnvelope {
  return {
    envelope_id: 'env-1',
    type: 'events_api',
    payload: {
      team_id: 'T1',
      event_id: eventId,
      event: {
        type: 'message',
        channel: 'C1',
        user,
        text,
        ts: '100.001',
      },
    },
  };
}

describe('handleSlackEnvelope', () => {
  it('inbox Hermès timeout fail-closed si consumer absent', async () => {
    const posts: string[] = [];
    const config = testConfig();
    const stores = createTestDispatchStores(config);
    const metrics = createMetrics();

    const failingInbox = {
      target: 'hermes' as const,
      execute: async () =>
        failClosed('hermes', 'inbox_timeout', 'Gateway hermes n\'a pas répondu à temps'),
    };

    await handleSlackEnvelope(envelope('E1', 'bonjour'), stores, {
      config,
      metrics,
      poster: {
        postThreadReply: async (_c, _t, text) => {
          posts.push(text);
        },
      },
      logLine: () => undefined,
      relays: [failingInbox],
    });

    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain('Gateway hermes');
  });

  it('dedup : second event_id identique ignoré', async () => {
    const config = testConfig();
    const stores = createTestDispatchStores(config);
    const metrics = createMetrics();
    let posts = 0;

    const deps = {
      config,
      metrics,
      poster: {
        postThreadReply: async () => {
          posts += 1;
        },
      },
      logLine: () => undefined,
      relays: [
        {
          target: 'hermes' as const,
          execute: async () => ({ ok: true as const, text: 'ok' }),
        },
      ],
    };

    await handleSlackEnvelope(envelope('E-dup', 'hello'), stores, deps);
    await handleSlackEnvelope(envelope('E-dup', 'hello'), stores, deps);
    expect(posts).toBe(1);
    expect(metrics.events_deduplicated).toBe(1);
  });

  it('ESCALADE DEVIN répond escalade non configurée pour Nadir', async () => {
    const posts: string[] = [];
    const config = testConfig();
    const stores = createTestDispatchStores(config);

    await handleSlackEnvelope(envelope('E-devin', 'ESCALADE DEVIN', 'UNADIR001'), stores, {
      config,
      metrics: createMetrics(),
      poster: {
        postThreadReply: async (_c, _t, text) => {
          posts.push(text);
        },
      },
      logLine: () => undefined,
      relays: [],
    });

    expect(posts[0]).toBe('Escalade non configurée.');
  });
});

describe('persistance et dispatch', () => {
  it('événement rejoué après redémarrage simulé', async () => {
    const persistence = createMemoryPersistence();
    const config = testConfig();
    const stores = { ...createTestDispatchStores(config), persistence };
    const event = {
      type: 'message' as const,
      event_id: 'E-restart',
      team_id: 'T1',
      channel: 'C1',
      user: 'U1',
      text: 'hello',
      ts: '1.0',
    };

    const first = await dispatchSlackMessage(event, stores, { nadirUserId: config.nadirUserId });
    expect(first.action).toBe('delegate');

    const second = await dispatchSlackMessage(event, stores, { nadirUserId: config.nadirUserId });
    expect(second.action).toBe('deduplicated');
  });

  it('ownership immuable sur fil existant', async () => {
    const persistence = createMemoryPersistence();
    const config = testConfig();
    const stores = { ...createTestDispatchStores(config), persistence };

    const root = {
      type: 'message' as const,
      event_id: 'E-root',
      team_id: 'T1',
      channel: 'C1',
      user: 'U1',
      text: 'bonjour',
      ts: '10.0',
    };
    await dispatchSlackMessage(root, stores, { nadirUserId: config.nadirUserId });

    const reroute = {
      ...root,
      event_id: 'E-reroute',
      text: 'ROUTE GROK: test',
    };
    const result = await dispatchSlackMessage(reroute, stores, { nadirUserId: config.nadirUserId });
    expect(result.action).toBe('delegate');
    if (result.action === 'delegate') {
      expect(result.target).toBe('hermes');
    }
  });

  it('fail-closed si stockage indisponible', async () => {
    const config = testConfig();
    const stores = {
      ...createTestDispatchStores(config),
      persistence: createFailingPersistence(),
    };
    const result = await dispatchSlackMessage(
      {
        type: 'message',
        event_id: 'E-store',
        team_id: 'T1',
        channel: 'C1',
        user: 'U1',
        text: 'hello',
        ts: '1.0',
      },
      stores,
      { nadirUserId: config.nadirUserId },
    );
    expect(result.action).toBe('reject');
    if (result.action === 'reject') {
      expect(result.reason).toBe('storage_unavailable');
    }
  });
});

describe('kill switch et concurrence Grok', () => {
  it('rejette Grok si kill switch actif', async () => {
    const flag = '/tmp/grokbot-kill-test.flag';
    writeFileSync(flag, '');
    const posts: string[] = [];
    const config = testConfig({ killSwitchPath: flag });
    const stores = createTestDispatchStores(config);

    await handleSlackEnvelope(envelope('E-kill', 'ROUTE GROK: test'), stores, {
      config,
      metrics: createMetrics(),
      poster: {
        postThreadReply: async (_c, _t, text) => {
          posts.push(text);
        },
      },
      logLine: () => undefined,
      relays: [createGrokRelay({ config, socketCall: vi.fn() as never })],
    });

    expect(posts[0]).toContain('kill switch');
    unlinkSync(flag);
  });
});
