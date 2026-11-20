/**
 * Codex-via-Superset worker path — prepared, not live.
 *
 * Flow (feature flags OFF by default):
 * mission → attempt → execution lease → Superset workspace
 * → Superset terminal → Codex → diff/tests → CP validator → completed
 *
 * Invariants retained from R8.2 (without using R8.2 as engine):
 * dedicated auth, one attempt, bounded budget, quota state,
 * API fallback OFF, allowed paths, diff/test validation, no publisher credential.
 *
 * Publisher remains a separate circuit.
 */
import type { ExecutionBackend } from './types.js';
import { assertExecutionLease, assertWorkspaceIdentity } from './identity.js';
import type { WorkspaceIdentityExpectation } from './types.js';
import type { LeaseGuardInput } from './identity.js';
import { SupersetParseError } from './json.js';

export type CodexSupersetStartInput = {
  backend: ExecutionBackend;
  identity: WorkspaceIdentityExpectation;
  lease: LeaseGuardInput;
  /** Codex command to run inside Superset terminal — never starts if disabled. */
  codexCommand: string;
  enabled: boolean;
};

export type CodexSupersetPrepared = {
  ready: true;
  workspaceId: string;
  projectId: string;
  message: 'codex_superset_prepared_not_started';
};

/**
 * Validates gates for Codex-on-Superset. Does not spawn Codex unless enabled=true
 * AND caller is an explicit canary (not used in this PR).
 */
export async function prepareCodexViaSuperset(
  input: CodexSupersetStartInput,
): Promise<CodexSupersetPrepared> {
  if (input.backend.kind !== 'superset') {
    throw new SupersetParseError('wrong_execution_backend');
  }
  assertExecutionLease(input.lease);
  // Identity check requires a real path — skip filesystem when not enabled.
  if (input.enabled) {
    assertWorkspaceIdentity(input.identity);
    throw new SupersetParseError('codex_canary_not_authorized');
  }
  return {
    ready: true,
    workspaceId: input.identity.workspaceId,
    projectId: input.identity.projectId,
    message: 'codex_superset_prepared_not_started',
  };
}

export const CODEX_SUPERSET_INVARIANTS = [
  'dedicated_auth',
  'one_attempt',
  'bounded_budget',
  'quota_state',
  'api_fallback_off',
  'allowed_paths',
  'diff_validation',
  'test_validation',
  'no_publisher_credential',
] as const;
