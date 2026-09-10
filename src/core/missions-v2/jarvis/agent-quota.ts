/**
 * Jarvis V1.2 agent quota authority — freshness-aware, fail-closed.
 * Operator/synthetic sources NEVER authorize real provider execution.
 * Codex and Cursor states are isolated (no shared availability).
 */
export type JarvisWorkerType = 'codex' | 'cursor';

export type QuotaState = 'available' | 'limited' | 'exhausted' | 'unknown';

export type QuotaAuthoritySource =
  | 'provider'
  | 'provider_cli'
  | 'provider_api'
  | 'execution_observation'
  | 'operator'
  | 'synthetic'
  | 'unknown';

export type QuotaAuthorizationClass =
  | 'ALLOW'
  | 'ALLOW_BOUNDED_ONE_SHOT'
  | 'DENY_EXHAUSTED'
  | 'DENY_UNKNOWN'
  | 'DENY_STALE'
  | 'DENY_OPERATOR'
  | 'DENY_SYNTHETIC'
  | 'DENY_LIMITED';

/** Provider-sourced availability fresher than this is required for ALLOW. */
export const QUOTA_FRESHNESS_MS = 15 * 60 * 1000;

export const PROVIDER_TRUSTED_SOURCES: ReadonlySet<QuotaAuthoritySource> = new Set([
  'provider',
  'provider_cli',
  'provider_api',
]);

export type AgentQuotaRow = {
  worker_type: JarvisWorkerType | string;
  quota_state: QuotaState | string;
  source: string;
  reason?: string | null;
  observed_at?: string | Date | null;
  expires_at?: string | Date | null;
  updated_at?: string | Date | null;
  note?: string | null;
};

export type AgentQuotaDecision = {
  workerType: JarvisWorkerType;
  quotaState: QuotaState;
  source: QuotaAuthoritySource;
  fresh: boolean;
  observedAt: string | null;
  expiresAt: string | null;
  authorizationClass: QuotaAuthorizationClass;
  reason: string;
  /** Auth session health is independent of quota; never imply available. */
  authStateHint?: 'authenticated' | 'unknown' | 'unauthenticated';
};

export type CurrentQuotaClassification =
  | 'LEGACY_CANARY_RESIDUE'
  | 'MANUAL_OPERATOR_STATE'
  | 'PROVIDER_OBSERVATION'
  | 'SYSTEM_DERIVED'
  | 'UNKNOWN';

export function normalizeQuotaSource(raw: string | null | undefined): QuotaAuthoritySource {
  const s = String(raw || 'unknown').trim().toLowerCase();
  if (
    s === 'provider' || s === 'provider_cli' || s === 'provider_api'
    || s === 'execution_observation' || s === 'operator' || s === 'synthetic' || s === 'unknown'
  ) {
    return s;
  }
  if (s === 'control_plane' || s === 'db') return 'unknown';
  return 'unknown';
}

export function normalizeQuotaState(raw: string | null | undefined): QuotaState {
  const s = String(raw || 'unknown').trim().toLowerCase();
  if (s === 'available' || s === 'limited' || s === 'exhausted' || s === 'unknown') return s;
  return 'unknown';
}

function toIso(v: string | Date | null | undefined): string | null {
  if (v == null || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function classifyCurrentQuotaRow(row: AgentQuotaRow | null | undefined): CurrentQuotaClassification {
  if (!row) return 'UNKNOWN';
  const source = normalizeQuotaSource(row.source);
  const note = String(row.note || '');
  const reason = String(row.reason || '');
  if (PROVIDER_TRUSTED_SOURCES.has(source) || source === 'execution_observation') {
    return 'PROVIDER_OBSERVATION';
  }
  if (source === 'operator') {
    if (
      note.includes('canary') || reason.includes('canary') || note.includes('legacy')
      || reason.includes('legacy_operator') || note.includes('operator_advisory')
    ) {
      return 'LEGACY_CANARY_RESIDUE';
    }
    if (note.includes('fail_closed_until_operator') || reason.includes('migration')) {
      return 'MANUAL_OPERATOR_STATE';
    }
    return 'MANUAL_OPERATOR_STATE';
  }
  if (source === 'synthetic') return 'SYSTEM_DERIVED';
  return 'UNKNOWN';
}

export function isQuotaFresh(input: {
  observedAt: string | null;
  expiresAt: string | null;
  nowMs?: number;
  freshnessMs?: number;
}): boolean {
  const now = input.nowMs ?? Date.now();
  if (input.expiresAt) {
    const exp = Date.parse(input.expiresAt);
    if (!Number.isNaN(exp) && exp <= now) return false;
  }
  if (!input.observedAt) return false;
  const obs = Date.parse(input.observedAt);
  if (Number.isNaN(obs)) return false;
  const window = input.freshnessMs ?? QUOTA_FRESHNESS_MS;
  return now - obs <= window;
}

/**
 * Typed quota decision. Callers must not interpret raw DB rows for execution.
 *
 * Bounded one-shot for unknown is NOT enabled by default (fail-closed).
 * Pass allowBoundedOneShotOnlyIfExplicitPolicy=true only from an explicit Nadir policy path.
 */
export function getAgentQuotaDecision(
  row: AgentQuotaRow | null | undefined,
  opts?: {
    workerType?: JarvisWorkerType;
    nowMs?: number;
    /** Reserved — must stay false unless every explicit canary gate is enforced by caller. */
    allowBoundedOneShotExplicitPolicy?: boolean;
  },
): AgentQuotaDecision {
  const workerType = (opts?.workerType
    ?? (row?.worker_type === 'cursor' ? 'cursor' : 'codex')) as JarvisWorkerType;
  const nowMs = opts?.nowMs ?? Date.now();

  if (!row) {
    return {
      workerType,
      quotaState: 'unknown',
      source: 'unknown',
      fresh: false,
      observedAt: null,
      expiresAt: null,
      authorizationClass: 'DENY_UNKNOWN',
      reason: 'quota_row_missing',
    };
  }

  const quotaState = normalizeQuotaState(row.quota_state);
  const source = normalizeQuotaSource(row.source);
  const observedAt = toIso(row.observed_at) ?? toIso(row.updated_at);
  const expiresAt = toIso(row.expires_at);
  const fresh = isQuotaFresh({ observedAt, expiresAt, nowMs });
  const reasonBase = String(row.reason || '').slice(0, 200) || 'none';

  // Operator / synthetic never authorize real execution.
  if (source === 'operator') {
    return {
      workerType,
      quotaState: quotaState === 'exhausted' ? 'exhausted' : 'unknown',
      source,
      fresh: false,
      observedAt,
      expiresAt,
      authorizationClass: quotaState === 'exhausted' ? 'DENY_EXHAUSTED' : 'DENY_OPERATOR',
      reason: `operator_non_authoritative:${reasonBase}`,
    };
  }
  if (source === 'synthetic') {
    return {
      workerType,
      quotaState: 'unknown',
      source,
      fresh: false,
      observedAt,
      expiresAt,
      authorizationClass: 'DENY_SYNTHETIC',
      reason: `synthetic_non_authoritative:${reasonBase}`,
    };
  }

  if (quotaState === 'exhausted') {
    return {
      workerType,
      quotaState: 'exhausted',
      source,
      fresh,
      observedAt,
      expiresAt,
      authorizationClass: 'DENY_EXHAUSTED',
      reason: reasonBase === 'none' ? 'quota_exhausted' : reasonBase,
    };
  }

  if (source === 'execution_observation') {
    // Negative observations are authoritative; positive historical success alone is not "available forever".
    if (quotaState === 'limited') {
      return {
        workerType,
        quotaState: 'limited',
        source,
        fresh,
        observedAt,
        expiresAt,
        authorizationClass: fresh ? 'DENY_LIMITED' : 'DENY_STALE',
        reason: fresh ? 'execution_observation_limited' : 'execution_observation_stale',
      };
    }
    return {
      workerType,
      quotaState: 'unknown',
      source,
      fresh: false,
      observedAt,
      expiresAt,
      authorizationClass: 'DENY_UNKNOWN',
      reason: 'execution_observation_not_availability_authority',
    };
  }

  if (PROVIDER_TRUSTED_SOURCES.has(source)) {
    if (quotaState === 'available') {
      if (!fresh) {
        return {
          workerType,
          quotaState: 'unknown',
          source,
          fresh: false,
          observedAt,
          expiresAt,
          authorizationClass: 'DENY_STALE',
          reason: 'provider_available_stale',
        };
      }
      return {
        workerType,
        quotaState: 'available',
        source,
        fresh: true,
        observedAt,
        expiresAt,
        authorizationClass: 'ALLOW',
        reason: reasonBase === 'none' ? 'provider_available_fresh' : reasonBase,
      };
    }
    if (quotaState === 'limited') {
      if (!fresh) {
        return {
          workerType,
          quotaState: 'unknown',
          source,
          fresh: false,
          observedAt,
          expiresAt,
          authorizationClass: 'DENY_STALE',
          reason: 'provider_limited_stale',
        };
      }
      // Limited is a deterministic bounded result: allow continue under agent-start limited path.
      return {
        workerType,
        quotaState: 'limited',
        source,
        fresh: true,
        observedAt,
        expiresAt,
        authorizationClass: 'ALLOW',
        reason: reasonBase === 'none' ? 'provider_limited_fresh' : reasonBase,
      };
    }
  }

  // unknown source/state — optional explicit bounded one-shot never auto-enabled
  if (
    opts?.allowBoundedOneShotExplicitPolicy === true
    && quotaState === 'unknown'
  ) {
    return {
      workerType,
      quotaState: 'unknown',
      source,
      fresh: false,
      observedAt,
      expiresAt,
      authorizationClass: 'ALLOW_BOUNDED_ONE_SHOT',
      reason: 'explicit_bounded_one_shot_policy',
    };
  }

  return {
    workerType,
    quotaState: 'unknown',
    source,
    fresh: false,
    observedAt,
    expiresAt,
    authorizationClass: 'DENY_UNKNOWN',
    reason: reasonBase === 'none' ? 'quota_unknown_fail_closed' : reasonBase,
  };
}

/** Map decision to in-memory QuotaState for AgentStartController fail-closed path. */
export function decisionToRuntimeQuotaState(d: AgentQuotaDecision): QuotaState {
  if (d.authorizationClass === 'ALLOW') return d.quotaState;
  if (d.authorizationClass === 'DENY_EXHAUSTED') return 'exhausted';
  // ALLOW_BOUNDED_ONE_SHOT reserved — treat as unknown until explicit canary policy wires it.
  return 'unknown';
}

export function parseNegativeProviderSignal(message: string): {
  quota_state: 'limited' | 'exhausted';
  source: 'execution_observation';
  reason: string;
} | null {
  const m = message.toLowerCase();
  // Strip potential secret-bearing payloads — keep only short normalized reason codes.
  if (/quota\s*exceeded|usage\s*exhausted|billing|allowance\s*exhausted|out of (credits|quota)/.test(m)) {
    return { quota_state: 'exhausted', source: 'execution_observation', reason: 'provider_signal_exhausted' };
  }
  if (/rate\s*limit|too many requests|429|throttl/.test(m)) {
    return { quota_state: 'limited', source: 'execution_observation', reason: 'provider_signal_rate_limit' };
  }
  return null;
}

/** Persist payload for negative observations — no raw error bodies / secrets. */
export type NegativeQuotaObservationWrite = {
  worker_type: JarvisWorkerType;
  quota_state: 'limited' | 'exhausted';
  source: 'execution_observation';
  reason: string;
  observed_at: string;
  expires_at: string;
  note: string;
};

export function buildNegativeQuotaObservationWrite(
  workerType: JarvisWorkerType,
  signal: NonNullable<ReturnType<typeof parseNegativeProviderSignal>>,
  opts?: { nowMs?: number; ttlMs?: number },
): NegativeQuotaObservationWrite {
  const nowMs = opts?.nowMs ?? Date.now();
  const ttlMs = opts?.ttlMs ?? (signal.quota_state === 'exhausted' ? 60 * 60 * 1000 : 15 * 60 * 1000);
  return {
    worker_type: workerType,
    quota_state: signal.quota_state,
    source: 'execution_observation',
    reason: signal.reason.slice(0, 120),
    observed_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + ttlMs).toISOString(),
    note: 'execution_observation_negative_signal',
  };
}

export const UPSERT_NEGATIVE_QUOTA_SQL = `
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

export async function persistNegativeQuotaObservation(
  pool: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  write: NegativeQuotaObservationWrite,
): Promise<void> {
  await pool.query(UPSERT_NEGATIVE_QUOTA_SQL, [
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

export const CODEX_QUOTA_DISCOVERY = {
  method: 'codex_app_server_account_rateLimits_read',
  trust_level: 'experimental_provider_cli',
  notes: [
    'No official codex status --json.',
    'codex app-server JSON-RPC account/rateLimits/read is experimental and no-model.',
    'Do not read auth.json tokens in Control Plane.',
    'Persist source=provider_cli only when observation is trustworthy.',
    'Ambiguous/unavailable → keep legacy row; authorization DENY_UNKNOWN.',
  ],
} as const;
