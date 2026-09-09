import type { Pool } from 'pg';
import { enabled, projects } from './model.js';
import { ExecutionControl } from './execution.js';
import {codexWorkerConfig} from './codex-worker.js';
import {
  isSupersetExecutionEnabled,
  resolveExecutionBackendMode,
  type ExecutionBackendMode,
} from './superset/config.js';

export function executionEnabled(env = process.env): boolean {
  return enabled(env) && env.AGENTIMPACT_V2_EXECUTION_ENABLED === '1';
}

/** custom (default) | superset — Superset stays OFF unless explicitly flagged. */
export function executionBackendMode(env = process.env): ExecutionBackendMode {
  return resolveExecutionBackendMode(env);
}

/** Live Superset mission execution — false by default; no scheduler rewrite. */
export function supersetExecutionLive(env = process.env): boolean {
  return isSupersetExecutionEnabled(env);
}

/** Configuration never starts a process. The Codex identity is admitted only
 * after every dedicated worker gate is explicitly satisfied. */
export function configuredExecution(pool: Pool, env = process.env): ExecutionControl | undefined {
  if (!executionEnabled(env)) return undefined;
  const codex=codexWorkerConfig(env),workerIds=new Set(['fake-supervisor']),workerTypes=new Set<'fake'|'codex'>(['fake']);
  if(codex.enabled){workerIds.add('codex-worker-1');workerTypes.add('codex');}
  const repoIds=new Set((env.AGENTIMPACT_CODEX_REPO_IDS??'').split(',').filter(value=>/^[A-Za-z0-9_.:-]{1,200}$/.test(value)));
  return new ExecutionControl(pool, {
    enabled: true,
    projects: projects(env),
    workerIds,workerTypes,workspaceRoots:{fake:'/fake',codex:codex.workspaceRoot},repoIds,
    leaseSeconds: 90,
    deadlineSeconds: 600,
    quotaAmount: 10000, // Synthetic units only; never a real billing authorization.
  });
}
