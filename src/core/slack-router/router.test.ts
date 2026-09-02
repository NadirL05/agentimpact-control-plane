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

describe('routeSlackMessage', () => {
  it('ignore les messages bot', () => {
    const result = routeSlackMessage(
      baseEvent({ bot_id: 'B123', user: undefined }),
      stores(),
      { nadirUserId: 'U_NADIR' },
    );
    expect(result.action).toBe('ignore');
  });

  it('déduplique event_id', () => {
    const s = stores();
    const cfg = { nadirUserId: 'U_NADIR' };
    const ev = baseEvent({ event_id: 'Ev-fixed' });
    expect(routeSlackMessage(ev, s, cfg).action).toBe('delegate');
    expect(routeSlackMessage(ev, s, cfg).action).toBe('deduplicated');
  });

  it('défaut → hermes', () => {
    const result = routeSlackMessage(baseEvent(), stores(), { nadirUserId: 'U_NADIR' });
    expect(result).toMatchObject({ action: 'delegate', target: 'hermes' });
  });

  it('ROUTE GROK explicite', () => {
    const result = routeSlackMessage(
      baseEvent({ text: 'ROUTE GROK: analyse ce CSV' }),
      stores(),
      { nadirUserId: 'U_NADIR' },
    );
    expect(result).toMatchObject({ action: 'delegate', target: 'grok' });
  });

  it('propriété de fil : follow-up sans ROUTE reste sur grok', () => {
    const s = stores();
    const cfg = { nadirUserId: 'U_NADIR' };
    routeSlackMessage(baseEvent({ text: 'ROUTE GROK: start', ts: '200.001' }), s, cfg);
    const follow = routeSlackMessage(
      baseEvent({
        text: 'suite de la question',
        ts: '200.002',
        thread_ts: '200.001',
        event_id: 'Ev-follow',
      }),
      s,
      cfg,
    );
    expect(follow).toMatchObject({ action: 'delegate', target: 'grok' });
  });

  it('ESCALADE DEVIN réservé à Nadir', () => {
    const ok = routeSlackMessage(
      baseEvent({ text: 'ESCALADE DEVIN', user: 'U_NADIR' }),
      stores(),
      { nadirUserId: 'U_NADIR' },
    );
    expect(ok).toMatchObject({ action: 'delegate', target: 'devin' });

    const deny = routeSlackMessage(
      baseEvent({ text: 'ESCALADE DEVIN', user: 'U_OTHER' }),
      stores(),
      { nadirUserId: 'U_NADIR' },
    );
    expect(deny.action).toBe('reject');
  });

  it('Grok jamais auto sur source cron', () => {
    const result = routeSlackMessage(
      baseEvent({ text: 'erreur cron', source: 'cron' }),
      stores(),
      { nadirUserId: 'U_NADIR', blockedAutoGrokSources: new Set(['cron']) },
    );
    expect(result).toMatchObject({ action: 'delegate', target: 'hermes' });
  });

  it('Grok explicite bloqué si source cron', () => {
    const result = routeSlackMessage(
      baseEvent({ text: 'ROUTE GROK: help', source: 'cron' }),
      stores(),
      { nadirUserId: 'U_NADIR', blockedAutoGrokSources: new Set(['cron']) },
    );
    expect(result.action).toBe('ignore');
  });
});
