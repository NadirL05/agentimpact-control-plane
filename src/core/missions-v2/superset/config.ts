/**
 * Execution backend selection — Superset OFF by default (rollback-safe).
 * AGENTIMPACT_EXECUTION_BACKEND=custom|superset
 */
export type ExecutionBackendMode = 'custom' | 'superset';

export function resolveExecutionBackendMode(
  env: NodeJS.ProcessEnv = process.env,
): ExecutionBackendMode {
  const raw = (env.AGENTIMPACT_EXECUTION_BACKEND || 'custom').trim().toLowerCase();
  if (raw === 'superset') return 'superset';
  return 'custom';
}

export function isSupersetExecutionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveExecutionBackendMode(env) === 'superset'
    && (env.AGENTIMPACT_V2_EXECUTION_ENABLED || '').trim() === '1';
}

export type SupersetRuntimeEnv = {
  organizationId: string;
  binary: string;
  cleanupValidated: boolean;
};

/**
 * Resolve Superset process-only config. Never reads API key into logs.
 * SUPERSET_API_KEY must only exist via credential wrapper / LoadCredential.
 */
export function resolveSupersetRuntimeEnv(env: NodeJS.ProcessEnv = process.env): SupersetRuntimeEnv {
  const organizationId = (env.SUPERSET_ORGANIZATION_ID || '').trim();
  if (!organizationId) {
    throw new Error('SUPERSET_ORGANIZATION_ID_required');
  }
  if (env.SUPERSET_API_KEY) {
    // Fail closed: Control Plane process must not hold the key in env.
    throw new Error('SUPERSET_API_KEY_must_not_be_in_process_env');
  }
  const binary = (env.SUPERSET_CRED_RUN || env.SUPERSET_BINARY || 'superset-cred-run').trim();
  const cleanupValidated = (env.AGENTIMPACT_SUPERSET_CLEANUP_VALIDATED || '').trim() === '1';
  return { organizationId, binary, cleanupValidated };
}
