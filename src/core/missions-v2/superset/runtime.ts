/**
 * Production Superset runtime wiring.
 * RPC is the only Control Plane → Superset transport when the public socket is configured.
 * Business execution and agent.create remain gated separately (flags OFF by default).
 * One-shot Codex canary may temporarily arm agent execution only under dual Nadir auth.
 */
import { randomUUID } from 'node:crypto';
import { SupersetExecutionBackend } from './backend.js';
import {
  createSupersetRpcRunner,
  SupersetRpcClient,
  type SupersetRpcContext,
} from './rpc-client.js';
import { providerInvokeArmed } from '../jarvis/codex-canary.js';

export const DEFAULT_SUPERSET_RPC_SOCKET = '/run/agentimpact-superset-rpc/bridge.sock';

export type SupersetRpcRuntimeConfig = {
  socketPath: string;
  context: SupersetRpcContext;
};

/** Explicit socket path enables the RPC client without enabling V2 business execution. */
export function resolveSupersetRpcSocket(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = (env.AGENTIMPACT_SUPERSET_RPC_SOCKET || '').trim();
  if (!configured) return undefined;
  if (configured !== DEFAULT_SUPERSET_RPC_SOCKET) {
    throw new Error('superset_rpc_socket_not_allowlisted');
  }
  return configured;
}

export function assertSupersetAgentExecutionDisabled(env: NodeJS.ProcessEnv = process.env): void {
  if ((env.AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED || '0').trim() === '1') {
    if (providerInvokeArmed(env)) return; // dual-auth canary window only
    throw new Error('superset_agent_execution_must_remain_disabled');
  }
}

export function assertBusinessExecutionOff(env: NodeJS.ProcessEnv = process.env): void {
  if ((env.AGENTIMPACT_V2_EXECUTION_ENABLED || '0').trim() === '1') {
    if (providerInvokeArmed(env)) return;
    throw new Error('business_execution_must_remain_disabled');
  }
}

export function createSupersetRpcContext(partial?: Partial<SupersetRpcContext>): SupersetRpcContext {
  return {
    missionId: partial?.missionId ?? randomUUID(),
    attemptId: partial?.attemptId ?? randomUUID(),
    fencingToken: partial?.fencingToken ?? randomUUID(),
  };
}

/**
 * Build the live SupersetExecutionBackend over the public UDS bridge.
 * Never mounts credentials, private executor socket, or a local CLI binary.
 * agent.create remains blocked by the public bridge regardless of V2 mission flags.
 */
export function createSupersetRpcBackend(
  config?: Partial<SupersetRpcRuntimeConfig>,
  env: NodeJS.ProcessEnv = process.env,
): SupersetExecutionBackend {
  assertSupersetAgentExecutionDisabled(env);
  const socketPath = config?.socketPath ?? resolveSupersetRpcSocket(env) ?? DEFAULT_SUPERSET_RPC_SOCKET;
  if (socketPath !== DEFAULT_SUPERSET_RPC_SOCKET) {
    throw new Error('superset_rpc_socket_not_allowlisted');
  }
  const context = config?.context ?? createSupersetRpcContext();
  const client = new SupersetRpcClient(socketPath);
  return new SupersetExecutionBackend({
    // organizationId is unused for RPC; private executor owns org resolution.
    cli: { organizationId: '00000000-0000-4000-8000-000000000000', binary: 'rpc-unused' },
    runner: createSupersetRpcRunner(client, context),
    cleanupValidated: false,
  });
}

/** Returns a backend only when the compose/runtime socket env is explicitly set. */
export function configuredSupersetRpcBackend(
  env: NodeJS.ProcessEnv = process.env,
): SupersetExecutionBackend | undefined {
  const socket = resolveSupersetRpcSocket(env);
  if (!socket) return undefined;
  return createSupersetRpcBackend({ socketPath: socket }, env);
}
