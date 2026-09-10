import { describe, expect, it } from 'vitest';
import { QUOTA_FRESHNESS_MS, getAgentQuotaDecision } from './agent-quota.js';
import {
  normalizeCodexRateLimitPayload,
  observationToPersistWrite,
  stripSensitiveFields,
  RATE_LIMIT_LIMITED_PERCENT,
} from './codex-ratelimit-discovery.js';

const now = Date.parse('2026-09-11T00:00:00.000Z');

describe('Codex rate-limit discovery normalizer', () => {
  it('strips sensitive fields', () => {
    const cleaned = stripSensitiveFields({
      access_token: 'SECRET',
      rateLimits: { primary: { usedPercent: 10 } },
    }) as Record<string, unknown>;
    expect(cleaned.access_token).toBe('[REDACTED]');
    expect((cleaned.rateLimits as { primary: { usedPercent: number } }).primary.usedPercent).toBe(10);
  });

  it('fresh low usage → available + trustworthy', () => {
    const obs = normalizeCodexRateLimitPayload({
      rateLimits: { primary: { usedPercent: 12, windowDurationMins: 60 } },
    }, { nowMs: now });
    expect(obs.discovery).toBe('PASS');
    expect(obs.quota_state).toBe('available');
    expect(obs.source).toBe('provider_cli');
    expect(obs.trustworthy).toBe(true);
    const write = observationToPersistWrite(obs)!;
    expect(write.quota_state).toBe('available');
    const decision = getAgentQuotaDecision({
      worker_type: 'codex',
      quota_state: write.quota_state,
      source: write.source,
      reason: write.reason,
      observed_at: write.observed_at,
      expires_at: write.expires_at,
    }, { nowMs: now });
    expect(decision.authorizationClass).toBe('ALLOW');
    expect(decision.fresh).toBe(true);
  });

  it('high usage → limited', () => {
    const obs = normalizeCodexRateLimitPayload({
      rate_limits: { primary: { used_percent: RATE_LIMIT_LIMITED_PERCENT } },
    }, { nowMs: now });
    expect(obs.quota_state).toBe('limited');
    expect(obs.trustworthy).toBe(true);
  });

  it('100% or reached type → exhausted', () => {
    expect(normalizeCodexRateLimitPayload({
      rateLimits: { primary: { usedPercent: 100 } },
    }, { nowMs: now }).quota_state).toBe('exhausted');
    expect(normalizeCodexRateLimitPayload({
      rateLimits: {
        primary: { usedPercent: 10 },
        rateLimitReachedType: { type: 'workspace_member_usage_limit_reached' },
      },
    }, { nowMs: now }).quota_state).toBe('exhausted');
  });

  it('ambiguous empty windows → unknown, not persistable', () => {
    const obs = normalizeCodexRateLimitPayload({ rateLimits: {} }, { nowMs: now });
    expect(obs.quota_state).toBe('unknown');
    expect(obs.trustworthy).toBe(false);
    expect(observationToPersistWrite(obs)).toBeNull();
    const decision = getAgentQuotaDecision({
      worker_type: 'codex',
      quota_state: 'unknown',
      source: 'provider_cli',
      observed_at: obs.observed_at,
    }, { nowMs: now });
    expect(decision.authorizationClass).toBe('DENY_UNKNOWN');
  });

  it('expires_at bounded by freshness and optional reset', () => {
    const resetSec = Math.floor((now + 5 * 60 * 1000) / 1000);
    const obs = normalizeCodexRateLimitPayload({
      rateLimits: { primary: { usedPercent: 5, resetsAt: resetSec } },
    }, { nowMs: now, freshnessMs: QUOTA_FRESHNESS_MS });
    expect(Date.parse(obs.expires_at)).toBe(now + 5 * 60 * 1000);
  });

  it('Codex only — never invents cursor state', () => {
    const obs = normalizeCodexRateLimitPayload({
      rateLimits: { primary: { usedPercent: 1 } },
    }, { nowMs: now });
    expect(obs.worker_type).toBe('codex');
  });
});
