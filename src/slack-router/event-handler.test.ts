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
import type { MissionStore } from '../core/missions-v2/store.js';

function testConfig(overrides: Partial<SlackRouterEnvConfig> = {}): SlackRouterEnvConfig {
  return {
    nadirUserId: 'UNADIR001',
    nativeAgentUserIds: new Set<string>(),
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

function dispatchCfg(config: SlackRouterEnvConfig) {
  return {
    nadirUserId: config.nadirUserId,
    nativeAgentUserIds: config.nativeAgentUserIds,
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

    const first = await dispatchSlackMessage(event, stores, dispatchCfg(config));
    expect(first.action).toBe('delegate');

    const second = await dispatchSlackMessage(event, stores, dispatchCfg(config));
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
    await dispatchSlackMessage(root, stores, dispatchCfg(config));

    const reroute = {
      ...root,
      event_id: 'E-reroute',
      text: 'ROUTE GROK: test',
    };
    const result = await dispatchSlackMessage(reroute, stores, dispatchCfg(config));
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
      dispatchCfg(config),
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

const NATIVE_IDS = new Set(['UCURSOR01', 'UCODEX001', 'UDEVIN001']);

describe('apps Slack natives', () => {
  it('ignore un fil @Cursor sans appeler Hermès/Grok/Codex/Ana', async () => {
    const posts: string[] = [];
    const hermesExecute = vi.fn();
    const grokExecute = vi.fn();
    const codexExecute = vi.fn();
    const anaExecute = vi.fn();
    const config = testConfig({ nativeAgentUserIds: NATIVE_IDS });
    const stores = createTestDispatchStores(config);

    await handleSlackEnvelope(
      envelope('E-cursor', 'Peux-tu demander à <@UCURSOR01|Cursor> ?'),
      stores,
      {
        config,
        metrics: createMetrics(),
        poster: {
          postThreadReply: async (_c, _t, text) => {
            posts.push(text);
          },
        },
        logLine: () => undefined,
        relays: [
          { target: 'hermes' as const, execute: hermesExecute },
          { target: 'grok' as const, execute: grokExecute },
          { target: 'codex' as const, execute: codexExecute },
          { target: 'ana' as const, execute: anaExecute },
        ],
      },
    );

    expect(posts).toHaveLength(0);
    expect(hermesExecute).not.toHaveBeenCalled();
    expect(grokExecute).not.toHaveBeenCalled();
    expect(codexExecute).not.toHaveBeenCalled();
    expect(anaExecute).not.toHaveBeenCalled();
  });

  it('ignore les follow-ups persistants après redémarrage simulé', async () => {
    const persistence = createMemoryPersistence();
    const config = testConfig({ nativeAgentUserIds: NATIVE_IDS });
    const stores = { ...createTestDispatchStores(config), persistence };

    const root = {
      type: 'message' as const,
      event_id: 'E-native-root',
      team_id: 'T1',
      channel: 'C1',
      user: 'U1',
      text: 'Question pour <@UCODEX001|Codex>',
      ts: '50.0',
    };
    const rootResult = await dispatchSlackMessage(root, stores, dispatchCfg(config));
    expect(rootResult).toMatchObject({ action: 'ignore', reason: 'native_agent_thread' });

    const follow = {
      ...root,
      event_id: 'E-native-follow',
      text: 'suite humaine',
      ts: '50.1',
      thread_ts: '50.0',
    };
    const followResult = await dispatchSlackMessage(follow, stores, dispatchCfg(config));
    expect(followResult).toMatchObject({ action: 'ignore', reason: 'native_agent_thread' });

    const replay = await dispatchSlackMessage(root, stores, dispatchCfg(config));
    expect(replay.action).toBe('deduplicated');
  });

  it('ROUTE GROK normal reste fonctionnel hors fil natif', async () => {
    const posts: string[] = [];
    const config = testConfig({ nativeAgentUserIds: NATIVE_IDS });
    const stores = createTestDispatchStores(config);
    const grokExecute = vi.fn(async () => ({ ok: true as const, text: 'grok ok' }));

    await handleSlackEnvelope(envelope('E-grok-ok', 'ROUTE GROK: test KPI'), stores, {
      config,
      metrics: createMetrics(),
      poster: {
        postThreadReply: async (_c, _t, text) => {
          posts.push(text);
        },
      },
      logLine: () => undefined,
      relays: [{ target: 'grok' as const, execute: grokExecute }],
    });

    expect(grokExecute).toHaveBeenCalledOnce();
    expect(posts[0]).toBe('grok ok');
  });

  it('mission longue Hermès → ACK immédiat posté, routes courtes non impactées', async () => {
    const posts: string[] = [];
    const config = testConfig();
    const stores = createTestDispatchStores(config);
    const hermesExecute = vi.fn(async () => ({
      ok: true as const,
      text: [
        'Mission IMANE-PROJECT-AUDIT-V1 enregistrée.',
        'ID: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        'Agent: Hermès',
        'Statut: queued',
      ].join('\n'),
      run_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    }));
    const grokExecute = vi.fn();

    await handleSlackEnvelope(
      envelope(
        'E-async-mission',
        'Mission réelle\nNom de mission :\nIMANE-PROJECT-AUDIT-V1\nhttps://github.com/NadirL05/imane-projet audit',
      ),
      stores,
      {
        config,
        metrics: createMetrics(),
        poster: {
          postThreadReply: async (_c, _t, text) => {
            posts.push(text);
          },
        },
        logLine: () => undefined,
        relays: [
          { target: 'hermes' as const, execute: hermesExecute },
          { target: 'grok' as const, execute: grokExecute },
        ],
      },
    );

    expect(hermesExecute).toHaveBeenCalledOnce();
    expect(grokExecute).not.toHaveBeenCalled();
    expect(posts[0]).toContain('enregistrée');
    expect(posts[0]).toContain('queued');
  });

  it('racine <@NATIVE_ID> + ROUTE GROK : ignore, aucun Grok, aucune réponse Slack', async () => {
    const posts: string[] = [];
    const grokExecute = vi.fn();
    const hermesExecute = vi.fn();
    const config = testConfig({ nativeAgentUserIds: NATIVE_IDS });
    const stores = createTestDispatchStores(config);

    await handleSlackEnvelope(
      envelope('E-native-grok', 'ROUTE GROK: aide <@UCURSOR01|Cursor>'),
      stores,
      {
        config,
        metrics: createMetrics(),
        poster: {
          postThreadReply: async (_c, _t, text) => {
            posts.push(text);
          },
        },
        logLine: () => undefined,
        relays: [
          { target: 'hermes' as const, execute: hermesExecute },
          { target: 'grok' as const, execute: grokExecute },
        ],
      },
    );

    expect(posts).toHaveLength(0);
    expect(grokExecute).not.toHaveBeenCalled();
    expect(hermesExecute).not.toHaveBeenCalled();
  });
});

describe('ROUTE CODEX smoke V1', () => {
  it('message exact smoke → createCodexRelay appelé, métrique ok', async () => {
    const posts: string[] = [];
    const metrics = createMetrics();
    const config = testConfig({ bridgeToken: 'bridge-test' });
    const stores = createTestDispatchStores(config);
    const smoke =
      'ROUTE CODEX: créer une proposition de test V1 pour revue Nadir uniquement';
    const codexExecute = vi.fn(async () => ({
      ok: true as const,
      text: 'Proposition Codex enregistrée (`prop-smoke`). Aucun lancement automatique — revue Nadir requise.',
    }));

    await handleSlackEnvelope(envelope('E-codex-smoke', smoke), stores, {
      config,
      metrics,
      poster: {
        postThreadReply: async (_c, _t, text) => {
          posts.push(text);
        },
      },
      logLine: () => undefined,
      relays: [{ target: 'codex' as const, execute: codexExecute }],
    });

    expect(codexExecute).toHaveBeenCalledTimes(1);
    expect(codexExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'créer une proposition de test V1 pour revue Nadir uniquement',
      }),
    );
    expect(posts[0]).toContain('Aucun lancement automatique');
    expect(metrics.codex_runs_ok).toBe(1);
    expect(metrics.codex_runs_failed).toBe(0);
    expect(metrics.hermes_runs_ok + metrics.hermes_runs_failed).toBe(0);
  });
});


it('reserved V2 command never falls back to a real relay while flag is off',async()=>{
  const config=testConfig(), execute=vi.fn(), log=vi.fn();
  const post=vi.fn(async()=>undefined);
  await handleSlackEnvelope(envelope('E-v2','  MISSION V2 IMANE PRIVATE_INPUT_SENTINEL'),createTestDispatchStores(config),{
    config,metrics:createMetrics(),poster:{postThreadReply:post},logLine:log,
    relays:[{target:'hermes',execute}],
  });
  expect(execute).not.toHaveBeenCalled();
  expect(post).toHaveBeenCalledWith('C1','100.001','V2 désactivée.');
  expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_INPUT_SENTINEL');
});

it.each(['CANCEL','RETRY'])('does not send %s to V1 when execution is disabled',async command=>{
  const config=testConfig(),execute=vi.fn(),post=vi.fn(async()=>undefined);
  await handleSlackEnvelope(envelope('F-control',`${command} d2bfaeb0-ed17-47e5-b77e-e7e020de38fb`),createTestDispatchStores(config),{
    config,metrics:createMetrics(),poster:{postThreadReply:post},logLine:()=>undefined,
    relays:[{target:'hermes',execute}],
  });
  expect(execute).not.toHaveBeenCalled();
  expect(post).toHaveBeenCalledWith('C1','100.001','V2 désactivée.');
});

it.each(['CANCEL','RETRY'].flatMap(command=>['codex','ana'].flatMap(owner=>[false,true].map(mention=>({command,owner,mention})))))
('reserves $command in $owner thread with native mention=$mention and F disabled',async({command,owner,mention})=>{
  const config=testConfig({nativeAgentUserIds:NATIVE_IDS}),execute=vi.fn(),post=vi.fn(async()=>undefined);
  const stores=createTestDispatchStores(config);
  await dispatchSlackMessage({type:'message',event_id:'F-root',team_id:'T1',channel:'C1',user:'UNADIR001',
    ts:'100.001',text:`ROUTE ${owner.toUpperCase()}: fixture`},stores,dispatchCfg(config));
  const input=envelope('F-reserved',`${command} d2bfaeb0-ed17-47e5-b77e-e7e020de38fb${mention?' <@UCURSOR01>':''}`,'UNADIR001');
  const missionsV2={allowsThread:async()=>false} as unknown as MissionStore;
  await handleSlackEnvelope(input,stores,{config,missionsV2,metrics:createMetrics(),poster:{postThreadReply:post},
    logLine:()=>undefined,relays:[{target:'codex',execute},{target:'ana',execute},{target:'hermes',execute},{target:'grok',execute}]});
  expect(execute).not.toHaveBeenCalled();
  expect(post).toHaveBeenCalledOnce();
  expect(post.mock.calls[0]).toContain(mention?'Commande V2 refusée avec une mention d’agent natif.':'Commande V2 refusée dans ce fil.');
});
