import { describe, expect, it, vi, afterEach } from 'vitest';
import { createCodexRelay } from './codex-relay.js';
import type { SlackRouterEnvConfig } from '../config.js';

function baseConfig(overrides: Partial<SlackRouterEnvConfig> = {}): SlackRouterEnvConfig {
  return {
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    nadirUserId: 'UNADIR001',
    nativeAgentUserIds: new Set(),
    controlPlaneUrl: 'http://127.0.0.1:3000',
    bridgeToken: 'bridge-test-token',
    grokWorkerSocket: '/tmp/grok.sock',
    healthPort: 9120,
    killSwitchPath: '/tmp/grokbot.disabled',
    grokRateUserMax: 6,
    grokRateUserWindowMs: 60_000,
    grokRateChannelMax: 20,
    grokRateChannelWindowMs: 60_000,
    ...overrides,
  };
}

describe('createCodexRelay', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fail-closed si bridge token absent', async () => {
    const relay = createCodexRelay(baseConfig({ bridgeToken: '' }));
    const result = await relay.execute({
      prompt: 'instruction suffisamment longue pour Codex',
      channel: 'C1',
      threadTs: '1.0',
      userId: 'U1',
      eventId: 'Ev1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('bridge_token_missing');
  });

  it('succès HTTP 201 → proposition enregistrée sans lancement', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ item: { id: 'prop-1' } }), { status: 201 }),
      ),
    );
    const relay = createCodexRelay(baseConfig());
    const result = await relay.execute({
      prompt: 'instruction suffisamment longue pour Codex',
      channel: 'C1',
      threadTs: '1.0',
      userId: 'U1',
      eventId: 'Ev2',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain('prop-1');
      expect(result.text).toContain('Aucun lancement automatique');
    }
    const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('http://127.0.0.1:3000/api/proposals');
    const body = JSON.parse(call[1].body as string);
    expect(body.target_agent).toBe('dev-senior');
    expect(body.proposed_by).toBe('slack-router');
  });

  it('HTTP non-201 → codex_http_error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad', { status: 400 })),
    );
    const relay = createCodexRelay(baseConfig());
    const result = await relay.execute({
      prompt: 'trop court',
      channel: 'C1',
      threadTs: '1.0',
      userId: 'U1',
      eventId: 'Ev3',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('codex_http_error');
      expect(result.userMessage).toContain('HTTP 400');
    }
  });

  it('réseau down → codex_unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network');
      }),
    );
    const relay = createCodexRelay(baseConfig());
    const result = await relay.execute({
      prompt: 'instruction suffisamment longue pour Codex',
      channel: 'C1',
      threadTs: '1.0',
      userId: 'U1',
      eventId: 'Ev4',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('codex_unreachable');
  });
});
