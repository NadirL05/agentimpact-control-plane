/**
 * Authoritative quota evaluation for Jarvis V1.2 Codex canary.
 * Never manufactures available state. Never writes quota rows.
 */
export type QuotaState = 'available' | 'limited' | 'exhausted' | 'unknown';

export type QuotaEvalInput = {
  worker_type: 'codex' | 'cursor';
  quota_state: QuotaState | string;
  /** Must already be true: root one-shot auth + canary scope validated. */
  canary_authorization_pass: boolean;
  source?: string;
};

export type QuotaEvalResult = {
  QUOTA_STATE: string;
  QUOTA_AUTHORITY_SOURCE: string;
  QUOTA_CHECK: 'PASS' | 'BLOCKED_UNKNOWN' | 'BLOCKED_EXHAUSTED' | 'BLOCKED_WORKER' | 'BLOCKED_POLICY';
  continue: boolean;
  reason: string;
};

/**
 * Fail-closed quota gate. Does not invent remaining quota.
 * limited: allowed ONLY when canary_authorization_pass (explicit bounded one-shot).
 */
export function evaluateCanaryQuota(input: QuotaEvalInput): QuotaEvalResult {
  const source = (input.source || 'control_plane').slice(0, 120);
  if (input.worker_type !== 'codex') {
    return {
      QUOTA_STATE: String(input.quota_state),
      QUOTA_AUTHORITY_SOURCE: source,
      QUOTA_CHECK: 'BLOCKED_WORKER',
      continue: false,
      reason: 'cursor_forbidden_for_codex_canary',
    };
  }
  const state = String(input.quota_state).toLowerCase();
  if (state === 'unknown') {
    return {
      QUOTA_STATE: 'unknown',
      QUOTA_AUTHORITY_SOURCE: source,
      QUOTA_CHECK: 'BLOCKED_UNKNOWN',
      continue: false,
      reason: 'quota_unknown_fail_closed',
    };
  }
  if (state === 'exhausted') {
    return {
      QUOTA_STATE: 'exhausted',
      QUOTA_AUTHORITY_SOURCE: source,
      QUOTA_CHECK: 'BLOCKED_EXHAUSTED',
      continue: false,
      reason: 'quota_exhausted',
    };
  }
  if (state === 'available') {
    return {
      QUOTA_STATE: 'available',
      QUOTA_AUTHORITY_SOURCE: source,
      QUOTA_CHECK: 'PASS',
      continue: true,
      reason: 'quota_available',
    };
  }
  if (state === 'limited') {
    if (!input.canary_authorization_pass) {
      return {
        QUOTA_STATE: 'limited',
        QUOTA_AUTHORITY_SOURCE: source,
        QUOTA_CHECK: 'BLOCKED_POLICY',
        continue: false,
        reason: 'limited_requires_canary_authorization',
      };
    }
    return {
      QUOTA_STATE: 'limited',
      QUOTA_AUTHORITY_SOURCE: source,
      QUOTA_CHECK: 'PASS',
      continue: true,
      reason: 'limited_explicit_one_shot_canary',
    };
  }
  return {
    QUOTA_STATE: state,
    QUOTA_AUTHORITY_SOURCE: source,
    QUOTA_CHECK: 'BLOCKED_UNKNOWN',
    continue: false,
    reason: 'quota_state_unrecognized_fail_closed',
  };
}
