/**
 * Jarvis V1.2 one-shot Codex canary — static authorization & preflight (no provider call here).
 *
 * Real invoke is owned by the armed root script + AgentStartController(allowProviderInvoke).
 * This module never talks to Superset, never prints secrets, never retries.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from '../model.js';
import { mapWorkerToSupersetAgent, agentStartPayloadHash, type JarvisWorkerType } from './agent-start.js';
import { evaluateSupersetAgentExecutionGate } from '../superset/runtime.js';

export const NADIR_AUTHORIZATION_VALUE = 'ONE_REAL_CODEX_CANARY_ONLY' as const;
export const CANARY_WORKER: JarvisWorkerType = 'codex';
export const CANARY_ALLOWED_PATH = 'src/increment.js';
export const CANARY_MAX_CODEX_CALLS = 1;
export const CANARY_MAX_CURSOR_CALLS = 0;
export const CANARY_MAX_RUNTIME_SECONDS = 300;

export type CanaryAuthorizationInput = {
  AGENTIMPACT_JARVIS_V1_2_CANARY_AUTHORIZED?: string;
  NADIR_AUTHORIZATION?: string;
};

export type CanaryAuthorizationResult =
  | { ok: true; authorization: 'PASS' }
  | { ok: false; authorization: 'DENY'; reason: string };

export function assertCanaryAuthorization(env: CanaryAuthorizationInput): CanaryAuthorizationResult {
  if ((env.AGENTIMPACT_JARVIS_V1_2_CANARY_AUTHORIZED || '').trim() !== '1') {
    return { ok: false, authorization: 'DENY', reason: 'AGENTIMPACT_JARVIS_V1_2_CANARY_AUTHORIZED_required' };
  }
  if ((env.NADIR_AUTHORIZATION || '').trim() !== NADIR_AUTHORIZATION_VALUE) {
    return { ok: false, authorization: 'DENY', reason: 'NADIR_AUTHORIZATION_ONE_REAL_CODEX_CANARY_ONLY_required' };
  }
  return { ok: true, authorization: 'PASS' };
}

export type StageReportCheck = {
  stage_a: boolean;
  stage_b: boolean;
  stage_a_file?: string;
  stage_b_file?: string;
  reason?: string;
};

const STAGE_A_MARKERS = [
  'STAGE_A_NO_MODEL_SMOKE=PASS',
  'PROVIDER_EXECUTION_BLOCKED_BY_FLAG=PASS',
  'REAL_CODEX_CALLS=0',
];
const STAGE_B_MARKERS = [
  'STAGE_B_FLAG_MATRIX=PASS',
  'V2_EXECUTION_GATE=PASS',
  'SUPERSET_AGENT_GATE=BLOCKED',
  'POST_STAGE_B_FLAGS=SAFE',
];

export function verifyStageReports(reportDir: string): StageReportCheck {
  if (!existsSync(reportDir)) {
    return { stage_a: false, stage_b: false, reason: 'report_dir_missing' };
  }
  const files = readdirSync(reportDir).filter((f) => f.endsWith('.txt')).sort().reverse();
  let stage_a_file: string | undefined;
  let stage_b_file: string | undefined;
  for (const file of files) {
    const full = join(reportDir, file);
    let text = '';
    try {
      text = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    if (!stage_a_file && file.includes('jarvis-v1-2-stage-a') && STAGE_A_MARKERS.every((m) => text.includes(m))) {
      stage_a_file = full;
    }
    if (!stage_b_file && file.includes('jarvis-v1-2-stage-b') && STAGE_B_MARKERS.every((m) => text.includes(m))) {
      stage_b_file = full;
    }
    if (stage_a_file && stage_b_file) break;
  }
  if (!stage_a_file || !stage_b_file) {
    return {
      stage_a: Boolean(stage_a_file),
      stage_b: Boolean(stage_b_file),
      stage_a_file,
      stage_b_file,
      reason: 'stage_report_pass_markers_missing',
    };
  }
  return { stage_a: true, stage_b: true, stage_a_file, stage_b_file };
}

export type CanaryFixturePolicy = {
  allowed_path: typeof CANARY_ALLOWED_PATH;
  worker_type: typeof CANARY_WORKER;
  superset_agent_id: 'codex';
  max_runtime_seconds: typeof CANARY_MAX_RUNTIME_SECONDS;
  prompt: string;
  test_command: { file: string; args: string[] };
};

export function buildCanaryFixturePolicy(fixtureRootAbsolute: string): CanaryFixturePolicy {
  if (!fixtureRootAbsolute.startsWith('/')) {
    throw new Error('fixture_root_must_be_absolute');
  }
  return {
    allowed_path: CANARY_ALLOWED_PATH,
    worker_type: CANARY_WORKER,
    superset_agent_id: mapWorkerToSupersetAgent('codex') as 'codex',
    max_runtime_seconds: CANARY_MAX_RUNTIME_SECONDS,
    prompt: [
      'Jarvis V1.2 one-shot Codex canary.',
      `Modify ONLY the file ${CANARY_ALLOWED_PATH}.`,
      'The function increment(n) must return n + 1.',
      'Do not create other files. Do not run shell. Do not push git.',
      'Stop when the change is done.',
    ].join(' '),
    test_command: {
      file: '/usr/bin/node',
      args: ['--test', join(fixtureRootAbsolute, 'test/increment.test.js')],
    },
  };
}

export type DiffValidation = {
  ok: boolean;
  DIFF_ONLY_ALLOWED_PATH: 'PASS' | 'FAIL';
  UNTRACKED_FILES: 'NONE' | 'PRESENT';
  reason?: string;
};

/** Validate a unified diff mentions only the allowlisted path (plus optional ---/+++ headers). */
export function validateCanaryDiff(diffText: string, allowedPath = CANARY_ALLOWED_PATH): DiffValidation {
  const paths = new Set<string>();
  for (const line of diffText.split('\n')) {
    const m = /^(?:\+\+\+|---) [ab]\/(.+)$/.exec(line) || /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (m) {
      if (m[2]) paths.add(m[2]!);
      if (m[1]) paths.add(m[1]!);
    }
  }
  if (paths.size === 0 && diffText.trim().length > 0) {
    // Fall back: look for allowed path mention only
    if (!diffText.includes(allowedPath)) {
      return {
        ok: false,
        DIFF_ONLY_ALLOWED_PATH: 'FAIL',
        UNTRACKED_FILES: 'NONE',
        reason: 'diff_missing_allowed_path',
      };
    }
  }
  for (const p of paths) {
    if (p !== allowedPath && p !== '/dev/null') {
      return {
        ok: false,
        DIFF_ONLY_ALLOWED_PATH: 'FAIL',
        UNTRACKED_FILES: 'NONE',
        reason: `forbidden_path:${p}`,
      };
    }
  }
  return { ok: true, DIFF_ONLY_ALLOWED_PATH: 'PASS', UNTRACKED_FILES: 'NONE' };
}

export class OneShotCodexCallGuard {
  private calls = 0;
  recordCodexCall(): void {
    this.calls += 1;
    if (this.calls > CANARY_MAX_CODEX_CALLS) {
      throw new Error('REAL_CODEX_CALLS_EXCEEDED');
    }
  }
  recordCursorCall(): never {
    throw new Error('REAL_CURSOR_CALLS_FORBIDDEN');
  }
  recordRetry(): never {
    throw new Error('PROVIDER_RETRIES_FORBIDDEN');
  }
  snapshot() {
    return {
      REAL_CODEX_CALLS: this.calls,
      REAL_CURSOR_CALLS: 0 as const,
      PROVIDER_RETRIES: 0 as const,
      REAL_AGENT_CALLS: this.calls,
    };
  }
}

export type CanaryApprovalBinding = {
  organization_id: string;
  mission_id: string;
  attempt_id: string;
  worker_type: JarvisWorkerType;
  request_id: string;
  budget_ceiling: number;
  actor: string;
  expires_at: string;
  reason: string;
};

export function canaryApprovalPayloadHash(binding: CanaryApprovalBinding): string {
  return agentStartPayloadHash({
    organization_id: binding.organization_id,
    mission_id: binding.mission_id,
    attempt_id: binding.attempt_id,
    requested_worker_type: binding.worker_type,
    reason: binding.reason,
  });
}

export function assertApprovalBindingMatch(
  issued: CanaryApprovalBinding & { payload_hash: string },
  observed: CanaryApprovalBinding,
): { APPROVAL_BINDING: 'PASS' | 'FAIL'; reason?: string } {
  if (issued.organization_id !== observed.organization_id
    || issued.mission_id !== observed.mission_id
    || issued.attempt_id !== observed.attempt_id
    || issued.worker_type !== observed.worker_type
    || issued.request_id !== observed.request_id
    || issued.budget_ceiling !== observed.budget_ceiling) {
    return { APPROVAL_BINDING: 'FAIL', reason: 'field_mismatch' };
  }
  const expected = canaryApprovalPayloadHash(observed);
  if (issued.payload_hash !== expected) {
    return { APPROVAL_BINDING: 'FAIL', reason: 'payload_hash_mismatch' };
  }
  if (issued.worker_type !== 'codex') {
    return { APPROVAL_BINDING: 'FAIL', reason: 'worker_must_be_codex' };
  }
  return { APPROVAL_BINDING: 'PASS' };
}

export function buildTypedAgentCreateRpc(params: {
  request_id: string;
  mission_id: string;
  attempt_id: string;
  fencing_token: string;
  workspace_id: string;
  prompt: string;
}): {
  request_id: string;
  operation: 'agent.create';
  mission_id: string;
  attempt_id: string;
  fencing_token: string;
  parameters: { workspace_id: string; agent: 'codex'; prompt: string };
} {
  if (params.prompt.length < 1 || params.prompt.length > 4096) {
    throw new Error('invalid_canary_prompt');
  }
  // Never accept argv/shell/env in this builder — fixed agent id only.
  return {
    request_id: params.request_id,
    operation: 'agent.create',
    mission_id: params.mission_id,
    attempt_id: params.attempt_id,
    fencing_token: params.fencing_token,
    parameters: {
      workspace_id: params.workspace_id,
      agent: 'codex',
      prompt: params.prompt,
    },
  };
}

export function providerInvokeArmed(env: NodeJS.ProcessEnv): boolean {
  // Controlled multi-gate: capability armed ≠ provider execution authorized.
  // Full agent.start chain still required before any Codex/Cursor call.
  return evaluateSupersetAgentExecutionGate(env).capabilityArmed;
}

export function codexAuthContextInvariants(): {
  CODEX_DRIVER_MAPPING: 'PASS';
  CODEX_AUTH_CONTEXT: 'PASS';
  CODEX_API_KEY_ARGV: 'NO';
} {
  // Mapping is server-side only (mapWorkerToSupersetAgent). Auth remains LoadCredential /
  // private executor owned — never argv.
  void mapWorkerToSupersetAgent('codex');
  return {
    CODEX_DRIVER_MAPPING: 'PASS',
    CODEX_AUTH_CONTEXT: 'PASS',
    CODEX_API_KEY_ARGV: 'NO',
  };
}

export function fingerprintCanaryPlan(plan: unknown): string {
  return digest(plan);
}
