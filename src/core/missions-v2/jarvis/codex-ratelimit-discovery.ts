/**
 * Codex app-server account/rateLimits/read — no-model quota discovery.
 *
 * Never launches completions. Never reads/prints auth.json tokens.
 * Persists only normalized states with source=provider_cli when trustworthy.
 */
import { spawn } from 'node:child_process';
import {
  QUOTA_FRESHNESS_MS,
  type JarvisWorkerType,
  type QuotaState,
} from './agent-quota.js';

export const CODEX_RATELIMIT_RPC_METHOD = 'account/rateLimits/read' as const;
export const CODEX_RATELIMIT_SOURCE = 'provider_cli' as const;

/** Conservative thresholds — prefer limited/unknown over false available. */
export const RATE_LIMIT_EXHAUSTED_PERCENT = 100;
export const RATE_LIMIT_LIMITED_PERCENT = 85;

export type CodexRateLimitDiscoveryStatus =
  | 'PASS'
  | 'UNAVAILABLE'
  | 'AMBIGUOUS'
  | 'AUTH_REQUIRED'
  | 'ERROR';

export type CodexRateLimitObservation = {
  worker_type: 'codex';
  quota_state: QuotaState;
  source: 'provider_cli' | 'unknown';
  reason: string;
  observed_at: string;
  expires_at: string;
  /** True only for available|limited|exhausted from clear provider metadata. */
  trustworthy: boolean;
  discovery: CodexRateLimitDiscoveryStatus;
  /** Auth health hint — independent of quota availability. */
  auth_state: 'authenticated' | 'unauthenticated' | 'unknown';
};

export type PersistProviderCliQuotaWrite = {
  worker_type: JarvisWorkerType;
  quota_state: Exclude<QuotaState, 'unknown'>;
  source: 'provider_cli';
  reason: string;
  observed_at: string;
  expires_at: string;
  note: string;
};

const SENSITIVE_KEY = /token|secret|password|authorization|api[_-]?key|cookie|refresh|bearer/i;

export function stripSensitiveFields(value: unknown, depth = 0): unknown {
  if (depth > 8 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => stripSensitiveFields(v, depth + 1));
  if (typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(k)) {
      out[k] = '[REDACTED]';
      continue;
    }
    out[k] = stripSensitiveFields(v, depth + 1);
  }
  return out;
}

function usedPercent(window: unknown): number | null {
  if (!window || typeof window !== 'object') return null;
  const w = window as Record<string, unknown>;
  const raw = w.usedPercent ?? w.used_percent;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw);
  return null;
}

function resetAtMs(window: unknown): number | null {
  if (!window || typeof window !== 'object') return null;
  const w = window as Record<string, unknown>;
  const raw = w.resetsAt ?? w.reset_at ?? w.resets_at;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // unix seconds vs ms
    return raw > 1e12 ? raw : raw * 1000;
  }
  return null;
}

function reachedType(snapshot: Record<string, unknown>): string | null {
  const raw = snapshot.rateLimitReachedType ?? snapshot.rate_limit_reached_type;
  if (raw == null) return null;
  if (typeof raw === 'string') return raw.toLowerCase();
  if (typeof raw === 'object' && raw !== null) {
    const t = (raw as Record<string, unknown>).type;
    if (typeof t === 'string') return t.toLowerCase();
  }
  return 'reached';
}

function pickSnapshot(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;
  const rl = root.rateLimits ?? root.rate_limits ?? root;
  if (!rl || typeof rl !== 'object') return null;
  return rl as Record<string, unknown>;
}

/**
 * Normalize app-server GetAccountRateLimitsResponse → Control Plane quota state.
 * Never invents availability from missing data.
 */
export function normalizeCodexRateLimitPayload(
  payload: unknown,
  opts?: { nowMs?: number; freshnessMs?: number },
): CodexRateLimitObservation {
  const nowMs = opts?.nowMs ?? Date.now();
  const freshnessMs = opts?.freshnessMs ?? QUOTA_FRESHNESS_MS;
  const observed_at = new Date(nowMs).toISOString();
  const defaultExpiry = new Date(nowMs + freshnessMs).toISOString();
  const safe = stripSensitiveFields(payload);

  const snapshot = pickSnapshot(safe);
  if (!snapshot) {
    return {
      worker_type: 'codex',
      quota_state: 'unknown',
      source: 'provider_cli',
      reason: 'rate_limits_payload_missing',
      observed_at,
      expires_at: defaultExpiry,
      trustworthy: false,
      discovery: 'AMBIGUOUS',
      auth_state: 'unknown',
    };
  }

  const reached = reachedType(snapshot);
  if (reached && /exhausted|usage_limit|limit_reached|quota|allowance|billing/.test(reached)) {
    return {
      worker_type: 'codex',
      quota_state: 'exhausted',
      source: 'provider_cli',
      reason: 'provider_rate_limit_reached',
      observed_at,
      expires_at: defaultExpiry,
      trustworthy: true,
      discovery: 'PASS',
      auth_state: 'authenticated',
    };
  }
  if (reached) {
    return {
      worker_type: 'codex',
      quota_state: 'limited',
      source: 'provider_cli',
      reason: 'provider_rate_limit_flag',
      observed_at,
      expires_at: defaultExpiry,
      trustworthy: true,
      discovery: 'PASS',
      auth_state: 'authenticated',
    };
  }

  const primary = snapshot.primary;
  const secondary = snapshot.secondary;
  const percents = [usedPercent(primary), usedPercent(secondary)].filter(
    (n): n is number => n != null,
  );

  if (percents.length === 0) {
    // Credits-only or empty windows — ambiguous, do not authorize.
    return {
      worker_type: 'codex',
      quota_state: 'unknown',
      source: 'provider_cli',
      reason: 'rate_limits_windows_absent',
      observed_at,
      expires_at: defaultExpiry,
      trustworthy: false,
      discovery: 'AMBIGUOUS',
      auth_state: 'authenticated',
    };
  }

  const maxUsed = Math.max(...percents);
  let quota_state: QuotaState;
  let reason: string;
  if (maxUsed >= RATE_LIMIT_EXHAUSTED_PERCENT) {
    quota_state = 'exhausted';
    reason = 'provider_used_percent_exhausted';
  } else if (maxUsed >= RATE_LIMIT_LIMITED_PERCENT) {
    quota_state = 'limited';
    reason = 'provider_used_percent_limited';
  } else {
    quota_state = 'available';
    reason = 'provider_used_percent_ok';
  }

  const resets = [resetAtMs(primary), resetAtMs(secondary)].filter(
    (n): n is number => n != null && n > nowMs,
  );
  const expiryMs = Math.min(nowMs + freshnessMs, ...(resets.length ? resets : [nowMs + freshnessMs]));

  return {
    worker_type: 'codex',
    quota_state,
    source: 'provider_cli',
    reason,
    observed_at,
    expires_at: new Date(expiryMs).toISOString(),
    trustworthy: true,
    discovery: 'PASS',
    auth_state: 'authenticated',
  };
}

export function observationToPersistWrite(
  obs: CodexRateLimitObservation,
): PersistProviderCliQuotaWrite | null {
  if (!obs.trustworthy) return null;
  if (obs.quota_state === 'unknown') return null;
  if (obs.source !== 'provider_cli') return null;
  return {
    worker_type: 'codex',
    quota_state: obs.quota_state,
    source: 'provider_cli',
    reason: obs.reason.slice(0, 120),
    observed_at: obs.observed_at,
    expires_at: obs.expires_at,
    note: 'provider_cli_ratelimit_observation',
  };
}

export const SNAPSHOT_ACTIVE_QUOTA_TO_HISTORY_SQL = `
INSERT INTO jarvis_agent_quota_state_history (
  worker_type, quota_state, source, reason, observed_at, expires_at, note
)
SELECT
  worker_type, quota_state, source,
  COALESCE(NULLIF(reason, ''), 'pre_provider_cli_snapshot'),
  observed_at, expires_at,
  COALESCE(NULLIF(note, ''), '') || ';pre_provider_cli_observation'
FROM jarvis_agent_quota_state
WHERE worker_type = $1
`;

export const UPSERT_PROVIDER_CLI_QUOTA_SQL = `
INSERT INTO jarvis_agent_quota_state (
  worker_type, quota_state, source, reason, observed_at, expires_at, updated_at, note
) VALUES ($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,now(),$7)
ON CONFLICT (worker_type) DO UPDATE SET
  quota_state = EXCLUDED.quota_state,
  source = EXCLUDED.source,
  reason = EXCLUDED.reason,
  observed_at = EXCLUDED.observed_at,
  expires_at = EXCLUDED.expires_at,
  updated_at = now(),
  note = EXCLUDED.note
`;

/**
 * Replace active authority only for trusted provider_cli observations.
 * Snapshots prior row into history (preserves legacy operator provenance).
 */
export async function persistTrustedProviderCliQuota(
  pool: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  write: PersistProviderCliQuotaWrite,
): Promise<void> {
  await pool.query(SNAPSHOT_ACTIVE_QUOTA_TO_HISTORY_SQL, [write.worker_type]);
  await pool.query(UPSERT_PROVIDER_CLI_QUOTA_SQL, [
    write.worker_type,
    write.quota_state,
    write.source,
    write.reason,
    write.observed_at,
    write.expires_at,
    write.note,
  ]);
  await pool.query(
    `INSERT INTO jarvis_agent_quota_state_history (
       worker_type, quota_state, source, reason, observed_at, expires_at, note
     ) VALUES ($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7)`,
    [
      write.worker_type,
      write.quota_state,
      write.source,
      write.reason,
      write.observed_at,
      write.expires_at,
      write.note,
    ],
  ).catch(() => undefined);
}

type RpcMessage = { id?: number | string; method?: string; result?: unknown; error?: { code?: number; message?: string }; params?: unknown };

function classifyRpcError(message: string): CodexRateLimitObservation {
  const now = Date.now();
  const observed_at = new Date(now).toISOString();
  const expires_at = new Date(now + QUOTA_FRESHNESS_MS).toISOString();
  const m = message.toLowerCase();
  if (/authentication required|not authenticated|login|unauthorized|401/.test(m)) {
    return {
      worker_type: 'codex',
      quota_state: 'unknown',
      source: 'provider_cli',
      reason: 'codex_auth_required_for_rate_limits',
      observed_at,
      expires_at,
      trustworthy: false,
      discovery: 'AUTH_REQUIRED',
      auth_state: 'unauthenticated',
    };
  }
  return {
    worker_type: 'codex',
    quota_state: 'unknown',
    source: 'provider_cli',
    reason: 'rate_limits_rpc_error',
    observed_at,
    expires_at,
    trustworthy: false,
    discovery: 'ERROR',
    auth_state: 'unknown',
  };
}

/**
 * Bounded stdio JSON-RPC to local `codex app-server` — no completion methods.
 * Does not print raw credential material.
 */
export async function queryCodexAppServerRateLimits(opts?: {
  codexBin?: string;
  timeoutMs?: number;
  nowMs?: number;
}): Promise<CodexRateLimitObservation> {
  const bin = opts?.codexBin ?? process.env.AGENTIMPACT_CODEX_BIN ?? 'codex';
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const nowMs = opts?.nowMs ?? Date.now();

  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<typeof spawn> | undefined;
    const finish = (obs: CodexRateLimitObservation) => {
      if (settled) return;
      settled = true;
      try { child?.kill('SIGTERM'); } catch { /* ignore */ }
      resolve(obs);
    };

    try {
      child = spawn(bin, ['app-server', '--stdio'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Never force-print secrets
          CODEX_LOG_LEVEL: process.env.CODEX_LOG_LEVEL || 'error',
        },
      });
    } catch {
      finish({
        worker_type: 'codex',
        quota_state: 'unknown',
        source: 'unknown',
        reason: 'codex_app_server_spawn_failed',
        observed_at: new Date(nowMs).toISOString(),
        expires_at: new Date(nowMs + QUOTA_FRESHNESS_MS).toISOString(),
        trustworthy: false,
        discovery: 'UNAVAILABLE',
        auth_state: 'unknown',
      });
      return;
    }

    const timer = setTimeout(() => {
      finish({
        worker_type: 'codex',
        quota_state: 'unknown',
        source: 'provider_cli',
        reason: 'rate_limits_rpc_timeout',
        observed_at: new Date(nowMs).toISOString(),
        expires_at: new Date(nowMs + QUOTA_FRESHNESS_MS).toISOString(),
        trustworthy: false,
        discovery: 'UNAVAILABLE',
        auth_state: 'unknown',
      });
    }, timeoutMs);

    let buf = '';
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });

    const onLine = (line: string) => {
      if (!line.trim()) return;
      let msg: RpcMessage;
      try {
        msg = JSON.parse(line) as RpcMessage;
      } catch {
        return;
      }
      if (msg.id === 1 && msg.error) {
        clearTimeout(timer);
        finish(classifyRpcError(String(msg.error.message || 'initialize_failed')));
        return;
      }
      if (msg.id === 1 && msg.result !== undefined) {
        // Send initialized notification + rateLimits read
        child?.stdin?.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
        child?.stdin?.write(
          `${JSON.stringify({ id: 2, method: CODEX_RATELIMIT_RPC_METHOD, params: {} })}\n`,
        );
        return;
      }
      if (msg.id === 2) {
        clearTimeout(timer);
        if (msg.error) {
          finish(classifyRpcError(String(msg.error.message || 'rate_limits_failed')));
          return;
        }
        finish(normalizeCodexRateLimitPayload(msg.result, { nowMs }));
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        onLine(line);
      }
    });

    child.on('error', () => {
      clearTimeout(timer);
      finish({
        worker_type: 'codex',
        quota_state: 'unknown',
        source: 'unknown',
        reason: 'codex_app_server_unavailable',
        observed_at: new Date(nowMs).toISOString(),
        expires_at: new Date(nowMs + QUOTA_FRESHNESS_MS).toISOString(),
        trustworthy: false,
        discovery: 'UNAVAILABLE',
        auth_state: 'unknown',
      });
    });

    child.on('close', () => {
      clearTimeout(timer);
      if (!settled) {
        const hint = stderr.toLowerCase();
        finish({
          worker_type: 'codex',
          quota_state: 'unknown',
          source: 'provider_cli',
          reason: /auth/.test(hint) ? 'codex_app_server_closed_auth' : 'codex_app_server_closed_early',
          observed_at: new Date(nowMs).toISOString(),
          expires_at: new Date(nowMs + QUOTA_FRESHNESS_MS).toISOString(),
          trustworthy: false,
          discovery: 'UNAVAILABLE',
          auth_state: 'unknown',
        });
      }
    });

    child.stdin?.write(
      `${JSON.stringify({
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: {
            name: 'agentimpact-control-plane',
            title: 'AgentImpact Control Plane',
            version: '1.2.0',
          },
        },
      })}\n`,
    );
  });
}

/**
 * Map private-executor normalized result (or raw rateLimits) into CP observation.
 * Never treats missing metadata as available.
 */
export function observationFromSupersetRpcResult(raw: unknown): CodexRateLimitObservation {
  if (!raw || typeof raw !== 'object') {
    const now = Date.now();
    return {
      worker_type: 'codex',
      quota_state: 'unknown',
      source: 'provider_cli',
      reason: 'rpc_result_missing',
      observed_at: new Date(now).toISOString(),
      expires_at: new Date(now + QUOTA_FRESHNESS_MS).toISOString(),
      trustworthy: false,
      discovery: 'UNAVAILABLE',
      auth_state: 'unknown',
    };
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.quota_state === 'string' && typeof o.discovery === 'string') {
    const qs = String(o.quota_state).toLowerCase();
    const quota_state: QuotaState =
      qs === 'available' || qs === 'limited' || qs === 'exhausted' || qs === 'unknown'
        ? qs
        : 'unknown';
    const discoveryRaw = String(o.discovery);
    const discovery: CodexRateLimitDiscoveryStatus =
      discoveryRaw === 'PASS' || discoveryRaw === 'UNAVAILABLE' || discoveryRaw === 'AMBIGUOUS'
      || discoveryRaw === 'AUTH_REQUIRED' || discoveryRaw === 'ERROR'
        ? discoveryRaw
        : 'UNAVAILABLE';
    const trustworthy = o.trustworthy === true && quota_state !== 'unknown' && discovery === 'PASS';
    return {
      worker_type: 'codex',
      quota_state,
      source: 'provider_cli',
      reason: String(o.reason || 'provider_rpc').slice(0, 120),
      observed_at: typeof o.observed_at === 'string' ? o.observed_at : new Date().toISOString(),
      expires_at: typeof o.expires_at === 'string'
        ? o.expires_at
        : new Date(Date.now() + QUOTA_FRESHNESS_MS).toISOString(),
      trustworthy,
      discovery,
      auth_state: o.auth_state === 'authenticated' || o.auth_state === 'unauthenticated'
        ? o.auth_state
        : 'unknown',
    };
  }
  return normalizeCodexRateLimitPayload(raw);
}

/**
 * Preferred path: typed Superset RPC codex.rate_limits.read (no host generic CLI).
 */
export async function queryCodexRateLimitsViaSupersetRpc(
  client: { call: (request: {
    request_id: string;
    operation: string;
    mission_id: string;
    attempt_id: string;
    fencing_token: string;
    parameters: Record<string, unknown>;
  }) => Promise<unknown> },
  context: { missionId: string; attemptId: string; fencingToken: string },
): Promise<CodexRateLimitObservation> {
  try {
    const { buildCodexRateLimitsReadRpc } = await import('../superset/rpc-client.js');
    const result = await client.call(buildCodexRateLimitsReadRpc(context));
    return observationFromSupersetRpcResult(result);
  } catch {
    const now = Date.now();
    return {
      worker_type: 'codex',
      quota_state: 'unknown',
      source: 'provider_cli',
      reason: 'codex_rate_limits_rpc_unavailable',
      observed_at: new Date(now).toISOString(),
      expires_at: new Date(now + QUOTA_FRESHNESS_MS).toISOString(),
      trustworthy: false,
      discovery: 'UNAVAILABLE',
      auth_state: 'unknown',
    };
  }
}
