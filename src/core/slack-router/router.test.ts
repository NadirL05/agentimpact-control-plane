import { describe, expect, it } from 'vitest';
import { createMemoryDedupStore } from './dedup.js';
import { createMemoryRateLimitStore } from './rate-limit.js';
import { routeSlackMessage, type RouterStores } from './router.js';
import { createMemoryThreadOwnerStore } from './thread-ownership.js';
import type { SlackMessageEvent } from './types.js';

function baseEvent(overrides: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
  return {
    type: 'message',
    event_id: `Ev-${Math.random().toString(36).slice(2)}`,
    team_id: 'T001',
    channel: 'C001',
    user: 'U_HUMAN',
    text: 'hello',
    ts: '100.001',
    ...overrides,
  };
}

function stores(): RouterStores {
  return {
    dedup: createMemoryDedupStore(),
    threadOwners: createMemoryThreadOwnerStore(),
    grokRateLimit: createMemoryRateLimitStore({
      perUserWindowMs: 60_000,
      perUserMax: 10,
      perChannelWindowMs: 60_000,
      perChannelMax: 20,
    }),
    grokInFlight: { active: false },
  };
}

function cfg(overrides: Partial<import('./router.js').RouterConfig> = {}) {
  return { nadirUserId: 'U_NADIR', nativeAgentUserIds: new Set<string>(), ...overrides };
}

describe('routeSlackMessage', () => {
  it('ignore les messages bot', () => {
    const result = routeSlackMessage(
      baseEvent({ bot_id: 'B123', user: undefined }),
      stores(),
      cfg(),
    );
    expect(result.action).toBe('ignore');
  });

  it('déduplique event_id', () => {
    const s = stores();
    const c = cfg();
    const ev = baseEvent({ event_id: 'Ev-fixed' });
    expect(routeSlackMessage(ev, s, c).action).toBe('delegate');
    expect(routeSlackMessage(ev, s, c).action).toBe('deduplicated');
  });

  it('défaut → hermes', () => {
    const result = routeSlackMessage(baseEvent(), stores(), cfg());
    expect(result).toMatchObject({ action: 'delegate', target: 'hermes' });
  });

  it('ROUTE GROK explicite', () => {
    const result = routeSlackMessage(
      baseEvent({ text: 'ROUTE GROK: analyse ce CSV' }),
      stores(),
      cfg(),
    );
    expect(result).toMatchObject({ action: 'delegate', target: 'grok' });
  });

  it('propriété de fil : follow-up sans ROUTE reste sur grok', () => {
    const s = stores();
    const c = cfg();
    routeSlackMessage(baseEvent({ text: 'ROUTE GROK: start', ts: '200.001' }), s, c);
    const follow = routeSlackMessage(
      baseEvent({
        text: 'suite de la question',
        ts: '200.002',
        thread_ts: '200.001',
        event_id: 'Ev-follow',
      }),
      s,
      c,
    );
    expect(follow).toMatchObject({ action: 'delegate', target: 'grok' });
  });

  it('ESCALADE DEVIN réservé à Nadir', () => {
    const ok = routeSlackMessage(
      baseEvent({ text: 'ESCALADE DEVIN', user: 'U_NADIR' }),
      stores(),
      cfg(),
    );
    expect(ok).toMatchObject({ action: 'delegate', target: 'devin' });

    const deny = routeSlackMessage(
      baseEvent({ text: 'ESCALADE DEVIN', user: 'U_OTHER' }),
      stores(),
      cfg(),
    );
    expect(deny.action).toBe('reject');
  });

  it('Grok jamais auto sur source cron', () => {
    const result = routeSlackMessage(
      baseEvent({ text: 'erreur cron', source: 'cron' }),
      stores(),
      cfg({ blockedAutoGrokSources: new Set(['cron']) }),
    );
    expect(result).toMatchObject({ action: 'delegate', target: 'hermes' });
  });

  it('Grok explicite bloqué si source cron', () => {
    const result = routeSlackMessage(
      baseEvent({ text: 'ROUTE GROK: help', source: 'cron' }),
      stores(),
      cfg({ blockedAutoGrokSources: new Set(['cron']) }),
    );
    expect(result.action).toBe('ignore');
  });
});

const NATIVE_IDS = new Set(['UCURSOR01', 'UCODEX001', 'UDEVIN001']);

describe('routeSlackMessage — apps Slack natives', () => {
  it('ignore @Cursor via token Slack', () => {
    const result = routeSlackMessage(
      baseEvent({ text: 'Peux-tu regarder <@UCURSOR01|Cursor> ?' }),
      stores(),
      cfg({ nativeAgentUserIds: NATIVE_IDS }),
    );
    expect(result).toMatchObject({ action: 'ignore', reason: 'native_agent_thread' });
  });

  it('ignore @Codex via token Slack', () => {
    const result = routeSlackMessage(
      baseEvent({ text: 'Question pour <@UCODEX001>' }),
      stores(),
      cfg({ nativeAgentUserIds: NATIVE_IDS }),
    );
    expect(result).toMatchObject({ action: 'ignore', reason: 'native_agent_thread' });
  });

  it('ignore @Devin via token Slack', () => {
    const result = routeSlackMessage(
      baseEvent({ text: 'Escalade <@UDEVIN001|Devin>' }),
      stores(),
      cfg({ nativeAgentUserIds: NATIVE_IDS }),
    );
    expect(result).toMatchObject({ action: 'ignore', reason: 'native_agent_thread' });
  });

  it('ignore tous les follow-ups d\'un fil natif', () => {
    const s = stores();
    const c = cfg({ nativeAgentUserIds: NATIVE_IDS });
    routeSlackMessage(
      baseEvent({ text: 'Demande <@UCURSOR01|Cursor>', ts: '300.001', event_id: 'Ev-root' }),
      s,
      c,
    );
    const follow = routeSlackMessage(
      baseEvent({
        text: 'suite sans mention',
        ts: '300.002',
        thread_ts: '300.001',
        event_id: 'Ev-follow',
      }),
      s,
      c,
    );
    expect(follow).toMatchObject({ action: 'ignore', reason: 'native_agent_thread' });
  });

  it('ne confond pas le faux texte @Cursor avec une mention native', () => {
    const result = routeSlackMessage(
      baseEvent({ text: '@Cursor regarde ce diff' }),
      stores(),
      cfg({ nativeAgentUserIds: NATIVE_IDS }),
    );
    expect(result.action).toBe('delegate');
  });

  it('ROUTE GROK normal hors fil natif reste fonctionnel', () => {
    const result = routeSlackMessage(
      baseEvent({ text: 'ROUTE GROK: analyse KPI' }),
      stores(),
      cfg({ nativeAgentUserIds: NATIVE_IDS }),
    );
    expect(result).toMatchObject({ action: 'delegate', target: 'grok' });
  });

  it('racine <@NATIVE_ID> + ROUTE GROK ignore avant parseRoute', () => {
    const s = stores();
    const c = cfg({ nativeAgentUserIds: NATIVE_IDS });
    const result = routeSlackMessage(
      baseEvent({ text: 'ROUTE GROK: analyse <@UCURSOR01|Cursor>', ts: '410.001' }),
      s,
      c,
    );
    expect(result).toMatchObject({ action: 'ignore', reason: 'native_agent_thread' });
    expect(s.threadOwners.get('T001:C001:410.001')).toBe('native');
  });

  it('ROUTE GROK dans un fil natif reste ignoré', () => {
    const s = stores();
    const c = cfg({ nativeAgentUserIds: NATIVE_IDS });
    routeSlackMessage(
      baseEvent({ text: '<@UCODEX001|Codex> stp', ts: '400.001', event_id: 'Ev-n-root' }),
      s,
      c,
    );
    const reroute = routeSlackMessage(
      baseEvent({
        text: 'ROUTE GROK: ne doit pas partir',
        ts: '400.002',
        thread_ts: '400.001',
        event_id: 'Ev-n-reroute',
      }),
      s,
      c,
    );
    expect(reroute).toMatchObject({ action: 'ignore', reason: 'native_agent_thread' });
  });
});
