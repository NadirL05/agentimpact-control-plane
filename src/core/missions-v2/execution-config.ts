import type { Pool } from 'pg';
import { enabled, projects } from './model.js';
import { ExecutionControl } from './execution.js';

export function executionEnabled(env = process.env): boolean {
  return enabled(env) && env.AGENTIMPACT_V2_EXECUTION_ENABLED === '1';
}

/** No worker is started here. Only the deterministic fake contract is configured. */
export function configuredExecution(pool: Pool, env = process.env): ExecutionControl | undefined {
  if (!executionEnabled(env)) return undefined;
  return new ExecutionControl(pool, {
    enabled: true,
    projects: projects(env),
    workerIds: new Set(['fake-supervisor']),
    leaseSeconds: 90,
    deadlineSeconds: 600,
    quotaAmount: 10000, // Synthetic units only; never a real billing authorization.
  });
}
