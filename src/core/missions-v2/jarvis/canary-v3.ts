/**
 * Jarvis V1.2 Codex canary V3 — pure fail-closed logic (no provider I/O).
 * Live root harness is infra/jarvis/root-run-jarvis-v1-2-codex-canary-v3.sh.
 */
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CANARY_V3_SCOPE = 'ONE_REAL_CODEX_CANARY_ONLY' as const;
export const CANARY_V3_PROVIDER = 'codex' as const;
export const CANARY_V3_MAX_PROVIDER_CALLS = 1 as const;
export const CANARY_V3_ALLOWED_PATH = 'src/increment.js' as const;
export const CANARY_V3_BASE_COMPOSE = '/opt/agentimpact/compose.yml' as const;
export const CANARY_V3_AUTH_PATH = '/run/agentimpact-jarvis-canary/codex-one-shot.auth' as const;
export const CANARY_V3_AUTH_DIR = '/run/agentimpact-jarvis-canary' as const;
export const CANARY_V3_CANONICAL_SCRIPT =
  '/opt/agentimpact/runner/superset-rpc-bridge/scripts/root-run-jarvis-v1-2-codex-canary-v3.sh' as const;

export const CANARY_V3_PHASES = [
  'authorized',
  'preflight',
  'quota_checked',
  'budget_reserved',
  'approved',
  'attempt_ready',
  'lease_acquired',
  'workspace_ready',
  'flags_armed',
  'provider_requested',
  'provider_running',
  'result_verified',
  'stop_requested',
  'reconciled',
  'flags_restored',
  'completed',
] as const;

export type CanaryV3Phase = (typeof CANARY_V3_PHASES)[number];

export const CANARY_V3_TIMEOUTS = {
  api_readiness_sec: 180,
  workspace_create_sec: 60,
  agent_launch_sec: 60,
  execution_runtime_sec: 300,
  stop_sec: 60,
  cleanup_sec: 120,
} as const;

export type CanaryV3Timeouts = typeof CANARY_V3_TIMEOUTS;

export function parseOuterLegacyArgv(argv: string[]):
  | { ok: true; legacyCount: 0 | 1 }
  | { ok: false; reason: 'FLAGS_DENIED' | 'EXTRA_POSITIONALS' } {
  const positionals: string[] = [];
  for (const a of argv) {
    if (a.startsWith('-')) return { ok: false, reason: 'FLAGS_DENIED' };
    positionals.push(a);
  }
  if (positionals.length > 1) return { ok: false, reason: 'EXTRA_POSITIONALS' };
  return { ok: true, legacyCount: positionals.length as 0 | 1 };
}

/** Temporary Compose override — never mutates base compose.yml. */
export function buildComposeOverrideYaml(opts?: {
  v2?: '0' | '1';
  agent?: '0' | '1';
  armed?: '0' | '1';
  oneShot?: '0' | '1';
  publisher?: '0' | '1';
}): string {
  const v2 = opts?.v2 ?? '1';
  const agent = opts?.agent ?? '1';
  const armed = opts?.armed ?? '1';
  const oneShot = opts?.oneShot ?? '1';
  const publisher = opts?.publisher ?? '0';
  return [
    '# Jarvis V1.2 Codex canary V3 — temporary override only.',
    '# BASE_COMPOSE_IMMUTABLE=YES — do not edit /opt/agentimpact/compose.yml',
    'services:',
    '  api:',
    '    environment:',
    `      AGENTIMPACT_V2_EXECUTION_ENABLED: "${v2}"`,
    `      AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: "${agent}"`,
    `      AGENTIMPACT_JARVIS_PROVIDER_INVOKE_ARMED: "${armed}"`,
    `      AGENTIMPACT_JARVIS_ROOT_ONE_SHOT_CANARY: "${oneShot}"`,
    `      AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED: "${publisher}"`,
    '',
  ].join('\n');
}

export function composeOverridePath(nonce: string): string {
  if (!/^[a-f0-9-]{8,64}$/i.test(nonce)) {
    throw new Error('invalid_override_nonce');
  }
  return `${CANARY_V3_AUTH_DIR}/compose-canary-${nonce}.yml`;
}

export function validateComposeOverrideYaml(yaml: string): {
  ok: boolean;
  reason: string;
} {
  if (!yaml.includes('AGENTIMPACT_V2_EXECUTION_ENABLED: "1"')) {
    return { ok: false, reason: 'missing_v2_on' };
  }
  if (!yaml.includes('AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: "1"')) {
    return { ok: false, reason: 'missing_agent_on' };
  }
  if (!yaml.includes('AGENTIMPACT_JARVIS_PROVIDER_INVOKE_ARMED: "1"')) {
    return { ok: false, reason: 'missing_armed' };
  }
  if (yaml.includes('AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED: "0"') === false) {
    return { ok: false, reason: 'publisher_not_off' };
  }
  // Disallow any write/mutation directive toward base compose (comments OK).
  if (/(?:^|\n)\s*(?:cat|tee|sed|echo).{0,80}\/opt\/agentimpact\/compose\.yml/m.test(yaml)) {
    return { ok: false, reason: 'must_not_reference_mutating_base' };
  }
  // crude YAML structure check
  if (!/^services:\n {2}api:\n {4}environment:\n/m.test(yaml)) {
    return { ok: false, reason: 'invalid_structure' };
  }
  return { ok: true, reason: 'valid' };
}

export function assertBaseComposeImmutable(
  beforeSha256: string,
  afterSha256: string,
): { BASE_COMPOSE_IMMUTABLE: 'YES' | 'NO' } {
  return {
    BASE_COMPOSE_IMMUTABLE: beforeSha256 === afterSha256 ? 'YES' : 'NO',
  };
}

export class CanaryV3StateMachine {
  private phase: CanaryV3Phase | 'init' = 'init';
  readonly history: Array<{ phase: CanaryV3Phase; at_ms: number }> = [];

  current(): CanaryV3Phase | 'init' {
    return this.phase;
  }

  transition(to: CanaryV3Phase, nowMs = Date.now()): { ok: true } | { ok: false; reason: string } {
    const idx = CANARY_V3_PHASES.indexOf(to);
    if (idx < 0) return { ok: false, reason: 'unknown_phase' };
    if (this.phase === 'init') {
      if (to !== 'authorized') return { ok: false, reason: 'must_start_authorized' };
    } else {
      const cur = CANARY_V3_PHASES.indexOf(this.phase);
      // Allow forward only, or jump to flags_restored / reconciled on fail-safe
      const failSafe = to === 'flags_restored' || to === 'reconciled' || to === 'completed';
      if (!failSafe && idx !== cur + 1) {
        return { ok: false, reason: `illegal_transition:${this.phase}->${to}` };
      }
    }
    this.phase = to;
    this.history.push({ phase: to, at_ms: nowMs });
    return { ok: true };
  }
}

export type GateBlock =
  | { continue: false; code: string; REAL_CODEX_CALLS: 0 }
  | { continue: true };

export function gateQuota(state: string, authPass: boolean): GateBlock & {
  QUOTA_CHECK: string;
} {
  const s = state.toLowerCase();
  if (s === 'available' || (s === 'limited' && authPass)) {
    return { continue: true, QUOTA_CHECK: 'PASS' };
  }
  if (s === 'exhausted') {
    return { continue: false, code: 'BLOCKED_EXHAUSTED', REAL_CODEX_CALLS: 0, QUOTA_CHECK: 'BLOCKED_EXHAUSTED' };
  }
  return { continue: false, code: 'BLOCKED_UNKNOWN', REAL_CODEX_CALLS: 0, QUOTA_CHECK: 'BLOCKED_UNKNOWN' };
}

export function gateBudget(ok: boolean): GateBlock & { BUDGET_RESERVATION: string } {
  if (ok) return { continue: true, BUDGET_RESERVATION: 'PASS' };
  return { continue: false, code: 'BUDGET_FAIL', REAL_CODEX_CALLS: 0, BUDGET_RESERVATION: 'FAIL' };
}

export function gateApproval(ok: boolean): GateBlock & { APPROVAL_BINDING: string } {
  if (ok) return { continue: true, APPROVAL_BINDING: 'PASS' };
  return { continue: false, code: 'APPROVAL_FAIL', REAL_CODEX_CALLS: 0, APPROVAL_BINDING: 'FAIL' };
}

export function gateLease(conflict: boolean): GateBlock & { LEASE_BINDING: string } {
  if (!conflict) return { continue: true, LEASE_BINDING: 'PASS' };
  return { continue: false, code: 'LEASE_CONFLICT', REAL_CODEX_CALLS: 0, LEASE_BINDING: 'FAIL' };
}

export function gateFence(stale: boolean): GateBlock & { FENCING: string } {
  if (!stale) return { continue: true, FENCING: 'PASS' };
  return { continue: false, code: 'STALE_FENCE', REAL_CODEX_CALLS: 0, FENCING: 'FAIL' };
}

export function gateWorkspace(bound: boolean): GateBlock & { WORKSPACE_BINDING: string } {
  if (bound) return { continue: true, WORKSPACE_BINDING: 'PASS' };
  return { continue: false, code: 'WORKSPACE_UNBOUND', REAL_CODEX_CALLS: 0, WORKSPACE_BINDING: 'FAIL' };
}

/** TOCTOU-safe: create exclusive evidence file BEFORE provider invoke. */
export function reserveProviderInvocationEvidence(input: {
  evidenceDir: string;
  requestId: string;
  scriptSha256: string;
}): { ok: true } | { ok: false; reason: string } {
  mkdirSync(input.evidenceDir, { recursive: true });
  const path = join(input.evidenceDir, input.requestId);
  try {
    const fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify({
      request_id: input.requestId,
      script_sha256: input.scriptSha256,
      reserved_at: new Date().toISOString(),
      max_provider_calls: 1,
    }) + '\n');
    closeSync(fd);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'provider_invocation_already_attempted' };
  }
}

export function providerAlreadyAttempted(evidenceDir: string, requestId: string): boolean {
  return existsSync(join(evidenceDir, requestId));
}

export type DiffValidation = {
  DIFF_ONLY_ALLOWED_PATH: 'PASS' | 'FAIL';
  UNTRACKED_FILES: 'NONE' | 'PRESENT';
  CANARY_RESULT?: 'FAIL_SAFE';
};

export function validateFixtureDiff(input: {
  changedPaths: string[];
  untrackedPaths: string[];
  allowedPath?: string;
}): DiffValidation {
  const allowed = input.allowedPath ?? CANARY_V3_ALLOWED_PATH;
  const onlyAllowed =
    input.changedPaths.length === 1 && input.changedPaths[0] === allowed;
  const untracked = input.untrackedPaths.length === 0 ? 'NONE' : 'PRESENT';
  if (!onlyAllowed || untracked === 'PRESENT') {
    return {
      DIFF_ONLY_ALLOWED_PATH: onlyAllowed ? 'PASS' : 'FAIL',
      UNTRACKED_FILES: untracked,
      CANARY_RESULT: 'FAIL_SAFE',
    };
  }
  return { DIFF_ONLY_ALLOWED_PATH: 'PASS', UNTRACKED_FILES: 'NONE' };
}

export type LifecycleOutcome =
  | 'FULL_PASS'
  | 'FUNCTIONAL_PASS_LIFECYCLE_PENDING'
  | 'FAIL_SAFE';

export function reconcileLifecycle(input: {
  testAfter: 'PASS' | 'FAIL';
  diffOk: boolean;
  providerStopped: boolean;
  stopConfirmed: boolean;
  noChildProcesses: boolean;
  leaseReleasable: boolean;
}): {
  outcome: LifecycleOutcome;
  LEASE_QUARANTINED?: 'YES';
  WORKSPACE_QUARANTINED?: 'YES';
  STOP_CONFIRMATION: 'PASS' | 'FAIL';
} {
  if (input.testAfter !== 'PASS' || !input.diffOk) {
    return {
      outcome: 'FAIL_SAFE',
      STOP_CONFIRMATION: input.stopConfirmed ? 'PASS' : 'FAIL',
      LEASE_QUARANTINED: input.stopConfirmed ? undefined : 'YES',
      WORKSPACE_QUARANTINED: input.stopConfirmed ? undefined : 'YES',
    };
  }
  if (!input.stopConfirmed) {
    return {
      outcome: 'FAIL_SAFE',
      STOP_CONFIRMATION: 'FAIL',
      LEASE_QUARANTINED: 'YES',
      WORKSPACE_QUARANTINED: 'YES',
    };
  }
  if (input.providerStopped && input.noChildProcesses && input.leaseReleasable) {
    return { outcome: 'FULL_PASS', STOP_CONFIRMATION: 'PASS' };
  }
  // Completion detector debt — functional pass with quarantine-safe pending
  return {
    outcome: 'FUNCTIONAL_PASS_LIFECYCLE_PENDING',
    STOP_CONFIRMATION: 'PASS',
  };
}

export function verifySafeFlags(env: Record<string, string | undefined>): {
  SAFE_FLAG_RESTORE: 'PASS' | 'FAIL';
  details: string[];
} {
  const details: string[] = [];
  const need: Record<string, string> = {
    AGENTIMPACT_V2_EXECUTION_ENABLED: '0',
    AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: '0',
    AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED: '0',
    AGENTIMPACT_JARVIS_PROVIDER_INVOKE_ARMED: '0',
  };
  let ok = true;
  for (const [k, v] of Object.entries(need)) {
    const cur = (env[k] || '').trim();
    // ARMED may be absent (= safe) or explicitly 0
    if (k === 'AGENTIMPACT_JARVIS_PROVIDER_INVOKE_ARMED' && cur === '') continue;
    if (cur !== v) {
      ok = false;
      details.push(`${k}=${env[k] ?? 'missing'}`);
    }
  }
  return { SAFE_FLAG_RESTORE: ok ? 'PASS' : 'FAIL', details };
}

/** Base compose must validate before any auth consumption. */
export function requireBaseComposePrecheck(configOk: boolean): {
  BASE_COMPOSE_PRECHECK: 'PASS' | 'FAIL';
  consumeAuth: boolean;
} {
  if (!configOk) {
    return { BASE_COMPOSE_PRECHECK: 'FAIL', consumeAuth: false };
  }
  return { BASE_COMPOSE_PRECHECK: 'PASS', consumeAuth: true };
}

export function phaseElapsed(startMs: number, nowMs: number): {
  PHASE_ELAPSED_SECONDS: number;
} {
  return { PHASE_ELAPSED_SECONDS: Math.max(0, Math.floor((nowMs - startMs) / 1000)) };
}

export function boundedPollAllowed(
  elapsedSec: number,
  timeoutSec: number,
): boolean {
  return elapsedSec < timeoutSec;
}
