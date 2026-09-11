#!/usr/bin/env node
/**
 * Live no-model Codex rate-limit discovery.
 *
 *   node --import tsx scripts/jarvis-codex-ratelimit-discover.ts --probe-only
 *   node --import tsx scripts/jarvis-codex-ratelimit-discover.ts --persist
 *
 * --probe-only: app-server account/rateLimits/read only (no DB, no completion).
 * --persist: probe + persist trusted provider_cli observation (history-preserving).
 *
 * Never prints auth tokens. Never starts model completions.
 */
import {
  getAgentQuotaDecision,
  classifyCurrentQuotaRow,
  CODEX_QUOTA_DISCOVERY,
  type AgentQuotaRow,
} from '../core/missions-v2/jarvis/agent-quota.js';
import {
  queryCodexRateLimitsViaSupersetRpc,
  observationToPersistWrite,
  persistTrustedProviderCliQuota,
  type CodexRateLimitObservation,
} from '../core/missions-v2/jarvis/codex-ratelimit-discovery.js';
import { SupersetRpcClient } from '../core/missions-v2/superset/rpc-client.js';
import {
  createSupersetRpcContext,
  DEFAULT_SUPERSET_RPC_SOCKET,
  resolveSupersetRpcSocket,
} from '../core/missions-v2/superset/runtime.js';

function discoveryLabel(d: CodexRateLimitObservation['discovery']): 'PASS' | 'UNAVAILABLE' {
  return d === 'PASS' ? 'PASS' : 'UNAVAILABLE';
}

async function loadCodexRow(): Promise<AgentQuotaRow | null> {
  const { pool } = await import('../api/db.js');
  try {
    const r = await pool.query(
      `SELECT worker_type, quota_state, source, reason, observed_at, expires_at, updated_at, note
       FROM jarvis_agent_quota_state WHERE worker_type='codex'`,
    );
    return (r.rows[0] as AgentQuotaRow) ?? null;
  } catch {
    return null;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function main() {
  const probeOnly = process.argv.includes('--probe-only');
  const persist = process.argv.includes('--persist');

  const socket = resolveSupersetRpcSocket(process.env) ?? DEFAULT_SUPERSET_RPC_SOCKET;
  const observation = await queryCodexRateLimitsViaSupersetRpc(
    new SupersetRpcClient(socket),
    createSupersetRpcContext(),
  );
  let persisted = false;

  if (persist && !probeOnly) {
    const write = observationToPersistWrite(observation);
    if (write) {
      const { pool } = await import('../api/db.js');
      await persistTrustedProviderCliQuota(pool, write);
      persisted = true;
    }
  }

  let row: AgentQuotaRow | null = null;
  let decision = null;
  if (!probeOnly) {
    row = await loadCodexRow();
    decision = getAgentQuotaDecision(row, { workerType: 'codex' });
  } else {
    // Probe-only: decision from observation alone (not DB) for smoke pre-persist.
    decision = getAgentQuotaDecision(
      observation.trustworthy
        ? {
            worker_type: 'codex',
            quota_state: observation.quota_state,
            source: observation.source,
            reason: observation.reason,
            observed_at: observation.observed_at,
            expires_at: observation.expires_at,
          }
        : {
            worker_type: 'codex',
            quota_state: 'unknown',
            source: observation.source,
            reason: observation.reason,
            observed_at: observation.observed_at,
            expires_at: observation.expires_at,
          },
      { workerType: 'codex' },
    );
  }

  const out = {
    CODEX_QUOTA_DISCOVERY: discoveryLabel(observation.discovery),
    CODEX_QUOTA_DISCOVERY_STATUS: observation.discovery,
    CODEX_AUTH_STATE: observation.auth_state,
    CODEX_QUOTA_STATE: decision.quotaState,
    CODEX_QUOTA_SOURCE: decision.source,
    CODEX_QUOTA_FRESH: decision.fresh,
    CODEX_QUOTA_AUTHORIZATION_CLASS: decision.authorizationClass,
    OBSERVATION_QUOTA_STATE: observation.quota_state,
    OBSERVATION_SOURCE: observation.source,
    OBSERVATION_TRUSTWORTHY: observation.trustworthy,
    OBSERVATION_REASON: observation.reason,
    OBSERVED_AT: observation.observed_at,
    EXPIRES_AT: observation.expires_at,
    PERSISTED: persisted,
    LEGACY_OPERATOR_STATE_PRESERVED: 'YES',
    CURRENT_CODEX_QUOTA_CLASSIFICATION: row
      ? classifyCurrentQuotaRow(row)
      : (observation.trustworthy ? 'PROVIDER_OBSERVATION' : 'UNKNOWN'),
    CODEX_QUOTA_DISCOVERY_METHOD: CODEX_QUOTA_DISCOVERY.method,
    CODEX_QUOTA_DISCOVERY_TRUST_LEVEL: CODEX_QUOTA_DISCOVERY.trust_level,
    REAL_CODEX_CALLS: 0,
    REAL_CURSOR_CALLS: 0,
  };
  process.stdout.write(JSON.stringify(out) + '\n');
}

main().catch(async (e) => {
  process.stderr.write(String(e instanceof Error ? e.message : e).slice(0, 200) + '\n');
  process.stdout.write(JSON.stringify({
    CODEX_QUOTA_DISCOVERY: 'UNAVAILABLE',
    CODEX_QUOTA_DISCOVERY_STATUS: 'ERROR',
    CODEX_AUTH_STATE: 'unknown',
    CODEX_QUOTA_STATE: 'unknown',
    CODEX_QUOTA_SOURCE: 'unknown',
    CODEX_QUOTA_FRESH: false,
    CODEX_QUOTA_AUTHORIZATION_CLASS: 'DENY_UNKNOWN',
    OBSERVATION_TRUSTWORTHY: false,
    PERSISTED: false,
    LEGACY_OPERATOR_STATE_PRESERVED: 'YES',
    REAL_CODEX_CALLS: 0,
    REAL_CURSOR_CALLS: 0,
  }) + '\n');
  process.exit(0);
});
