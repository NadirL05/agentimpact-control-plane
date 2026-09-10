import { describe, expect, it } from 'vitest';
import {
  CODEX_QUOTA_DISCOVERY,
  buildNegativeQuotaObservationWrite,
  classifyCurrentQuotaRow,
  decisionToRuntimeQuotaState,
  getAgentQuotaDecision,
  isQuotaFresh,
  parseNegativeProviderSignal,
  QUOTA_FRESHNESS_MS,
} from './agent-quota.js';

const now = Date.parse('2026-09-10T21:00:00.000Z');
const freshObs = new Date(now - 60_000).toISOString();
const staleObs = new Date(now - QUOTA_FRESHNESS_MS - 60_000).toISOString();

describe('Jarvis agent quota authority', () => {
  it('fresh provider available → ALLOW', () => {
    const d = getAgentQuotaDecision({
      worker_type: 'codex',
      quota_state: 'available',
      source: 'provider_cli',
      observed_at: freshObs,
    }, { nowMs: now });
    expect(d.authorizationClass).toBe('ALLOW');
    expect(d.fresh).toBe(true);
    expect(decisionToRuntimeQuotaState(d)).toBe('available');
  });

  it('stale provider available → DENY_STALE', () => {
    const d = getAgentQuotaDecision({
      worker_type: 'codex',
      quota_state: 'available',
      source: 'provider',
      observed_at: staleObs,
    }, { nowMs: now });
    expect(d.authorizationClass).toBe('DENY_STALE');
    expect(d.quotaState).toBe('unknown');
    expect(decisionToRuntimeQuotaState(d)).toBe('unknown');
  });

  it('provider exhausted → DENY_EXHAUSTED', () => {
    const d = getAgentQuotaDecision({
      worker_type: 'codex',
      quota_state: 'exhausted',
      source: 'provider_api',
      observed_at: freshObs,
    }, { nowMs: now });
    expect(d.authorizationClass).toBe('DENY_EXHAUSTED');
  });

  it('provider limited fresh → ALLOW (deterministic bounded)', () => {
    const d = getAgentQuotaDecision({
      worker_type: 'codex',
      quota_state: 'limited',
      source: 'provider_cli',
      observed_at: freshObs,
    }, { nowMs: now });
    expect(d.authorizationClass).toBe('ALLOW');
    expect(d.quotaState).toBe('limited');
  });

  it('operator available → NOT ALLOW', () => {
    const d = getAgentQuotaDecision({
      worker_type: 'codex',
      quota_state: 'available',
      source: 'operator',
      observed_at: freshObs,
      note: 'fail_closed_until_operator_sets_state',
    }, { nowMs: now });
    expect(d.authorizationClass).toBe('DENY_OPERATOR');
    expect(decisionToRuntimeQuotaState(d)).toBe('unknown');
    expect(classifyCurrentQuotaRow({
      worker_type: 'codex', quota_state: 'unknown', source: 'operator',
      note: 'fail_closed_until_operator_sets_state',
    })).toBe('MANUAL_OPERATOR_STATE');
  });

  it('synthetic available → NOT ALLOW', () => {
    const d = getAgentQuotaDecision({
      worker_type: 'codex',
      quota_state: 'available',
      source: 'synthetic',
      observed_at: freshObs,
    }, { nowMs: now });
    expect(d.authorizationClass).toBe('DENY_SYNTHETIC');
  });

  it('missing row / discovery failure → DENY_UNKNOWN', () => {
    expect(getAgentQuotaDecision(null, { workerType: 'codex' }).authorizationClass).toBe('DENY_UNKNOWN');
  });

  it('Codex auth valid + quota unknown remains unknown', () => {
    const d = getAgentQuotaDecision({
      worker_type: 'codex',
      quota_state: 'unknown',
      source: 'unknown',
    }, { nowMs: now });
    expect(d.authorizationClass).toBe('DENY_UNKNOWN');
    expect(d.quotaState).toBe('unknown');
  });

  it('Codex != Cursor isolation', () => {
    const codex = getAgentQuotaDecision({
      worker_type: 'codex', quota_state: 'available', source: 'provider_cli', observed_at: freshObs,
    }, { nowMs: now });
    const cursor = getAgentQuotaDecision({
      worker_type: 'cursor', quota_state: 'exhausted', source: 'provider_cli', observed_at: freshObs,
    }, { nowMs: now, workerType: 'cursor' });
    expect(codex.workerType).toBe('codex');
    expect(cursor.workerType).toBe('cursor');
    expect(codex.authorizationClass).toBe('ALLOW');
    expect(cursor.authorizationClass).toBe('DENY_EXHAUSTED');
  });

  it('recent exhaustion signal blocks; parseNegativeProviderSignal', () => {
    expect(parseNegativeProviderSignal('HTTP 429 rate limit exceeded')).toMatchObject({
      quota_state: 'limited', source: 'execution_observation',
    });
    expect(parseNegativeProviderSignal('quota exceeded for plan')).toMatchObject({
      quota_state: 'exhausted',
    });
    const d = getAgentQuotaDecision({
      worker_type: 'codex',
      quota_state: 'exhausted',
      source: 'execution_observation',
      observed_at: freshObs,
      reason: 'provider_signal_exhausted',
    }, { nowMs: now });
    expect(d.authorizationClass).toBe('DENY_EXHAUSTED');
  });

  it('bounded one-shot never implicit; only explicit opt-in class', () => {
    const denied = getAgentQuotaDecision({
      worker_type: 'codex', quota_state: 'unknown', source: 'unknown',
    }, { nowMs: now });
    expect(denied.authorizationClass).toBe('DENY_UNKNOWN');
    const explicit = getAgentQuotaDecision({
      worker_type: 'codex', quota_state: 'unknown', source: 'unknown',
    }, { nowMs: now, allowBoundedOneShotExplicitPolicy: true });
    expect(explicit.authorizationClass).toBe('ALLOW_BOUNDED_ONE_SHOT');
    // Runtime still maps to unknown until canary wires every gate
    expect(decisionToRuntimeQuotaState(explicit)).toBe('unknown');
  });

  it('freshness helper + discovery constants', () => {
    expect(isQuotaFresh({ observedAt: freshObs, expiresAt: null, nowMs: now })).toBe(true);
    expect(isQuotaFresh({ observedAt: staleObs, expiresAt: null, nowMs: now })).toBe(false);
    expect(CODEX_QUOTA_DISCOVERY.trust_level).toBe('experimental_provider_cli');
    expect(CODEX_QUOTA_DISCOVERY.method).toContain('rateLimits');
  });

  it('legacy canary residue classification', () => {
    expect(classifyCurrentQuotaRow({
      worker_type: 'codex',
      quota_state: 'unknown',
      source: 'operator',
      reason: 'legacy_operator_non_authoritative',
      note: 'operator_advisory_only_not_execution_authority',
    })).toBe('LEGACY_CANARY_RESIDUE');
  });

  it('buildNegativeQuotaObservationWrite has no secret payload', () => {
    const signal = parseNegativeProviderSignal('quota exceeded for plan')!;
    const write = buildNegativeQuotaObservationWrite('codex', signal, { nowMs: now });
    expect(write.source).toBe('execution_observation');
    expect(write.quota_state).toBe('exhausted');
    expect(write.reason).toBe('provider_signal_exhausted');
    expect(JSON.stringify(write)).not.toMatch(/token|secret|password/i);
  });
});
