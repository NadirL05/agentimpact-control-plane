/**
 * Production Superset runtime wiring.
 * RPC is the only Control Plane → Superset transport when the public socket is configured.
 *
 * CAPABILITY_ARMED != PROVIDER_EXECUTION_AUTHORIZED
 * Boot must succeed when capability flags are set; real provider invoke still requires
 * the full Control Plane agent.start chain (approval/quota/budget/lease/fence/workspace).
 */
import { randomUUID } from 'node:crypto';
import { SupersetExecutionBackend } from './backend.js';
import {
  createSupersetRpcRunner,
  SupersetRpcClient,
  type SupersetRpcContext,
} from './rpc-client.js';

export const DEFAULT_SUPERSET_RPC_SOCKET = '/run/agentimpact-superset-rpc/bridge.sock';

export type SupersetRpcRuntimeConfig = {
  socketPath: string;
  context: SupersetRpcContext;
};

export type SupersetAgentGateReason =
  | 'v2_disabled'
  | 'superset_agent_disabled'
  | 'provider_not_armed'
  | 'one_shot_missing'
  | 'publisher_enabled'
  | 'armed';

export type SupersetAgentExecutionGateState = {
  v2ExecutionEnabled: boolean;
  supersetAgentExecutionEnabled: boolean;
  providerInvokeArmed: boolean;
  rootOneShotCanary: boolean;
  publisherEnabled: boolean;
  /** Env capability window open — does NOT authorize a provider call by itself. */
  capabilityArmed: boolean;
  reason: SupersetAgentGateReason;
  CONTROL_PLANE_AGENT_GATE: 'PASS' | 'DENY';
  RPC_BRIDGE_AGENT_GATE: 'PASS' | 'DENY';
  /** Both CP capability and RPC bridge agent flag must allow. Still not a provider call. */
  PROVIDER_INVOKE_MULTI_GATE: 'PASS' | 'DENY';
  PUBLISHER_HARD_SEPARATION: 'PASS' | 'FAIL';
};

function flagOn(env: NodeJS.ProcessEnv, key: string): boolean {
  return (env[key] || '0').trim() === '1';
}

/**
 * Explicit typed multi-gate. Never throws. Safe to evaluate at boot.
 */
export function evaluateSupersetAgentExecutionGate(
  env: NodeJS.ProcessEnv = process.env,
): SupersetAgentExecutionGateState {
  const v2ExecutionEnabled = flagOn(env, 'AGENTIMPACT_V2_EXECUTION_ENABLED');
  const supersetAgentExecutionEnabled = flagOn(env, 'AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED');
  const providerInvokeArmed = flagOn(env, 'AGENTIMPACT_JARVIS_PROVIDER_INVOKE_ARMED');
  const rootOneShotCanary = flagOn(env, 'AGENTIMPACT_JARVIS_ROOT_ONE_SHOT_CANARY');
  const publisherEnabled = flagOn(env, 'AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED');

  let reason: SupersetAgentGateReason;
  if (publisherEnabled && (supersetAgentExecutionEnabled || providerInvokeArmed || rootOneShotCanary)) {
    reason = 'publisher_enabled';
  } else if (!v2ExecutionEnabled) {
    reason = 'v2_disabled';
  } else if (!supersetAgentExecutionEnabled) {
    reason = 'superset_agent_disabled';
  } else if (!providerInvokeArmed) {
    reason = 'provider_not_armed';
  } else if (!rootOneShotCanary) {
    reason = 'one_shot_missing';
  } else {
    reason = 'armed';
  }

  const capabilityArmed = reason === 'armed';
  const CONTROL_PLANE_AGENT_GATE: 'PASS' | 'DENY' = capabilityArmed ? 'PASS' : 'DENY';
  // RPC bridge independently reads SUPERSET_AGENT_EXECUTION_ENABLED.
  const RPC_BRIDGE_AGENT_GATE: 'PASS' | 'DENY' = supersetAgentExecutionEnabled ? 'PASS' : 'DENY';
  const PROVIDER_INVOKE_MULTI_GATE: 'PASS' | 'DENY' =
    capabilityArmed && RPC_BRIDGE_AGENT_GATE === 'PASS' ? 'PASS' : 'DENY';
  const PUBLISHER_HARD_SEPARATION: 'PASS' | 'FAIL' =
    reason === 'publisher_enabled' ? 'FAIL' : 'PASS';

  return {
    v2ExecutionEnabled,
    supersetAgentExecutionEnabled,
    providerInvokeArmed,
    rootOneShotCanary,
    publisherEnabled,
    capabilityArmed,
    reason,
    CONTROL_PLANE_AGENT_GATE,
    RPC_BRIDGE_AGENT_GATE,
    PROVIDER_INVOKE_MULTI_GATE,
    PUBLISHER_HARD_SEPARATION,
  };
}

/** Explicit socket path enables the RPC client without enabling V2 business execution. */
export function resolveSupersetRpcSocket(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = (env.AGENTIMPACT_SUPERSET_RPC_SOCKET || '').trim();
  if (!configured) return undefined;
  if (configured !== DEFAULT_SUPERSET_RPC_SOCKET) {
    throw new Error('superset_rpc_socket_not_allowlisted');
  }
  return configured;
}

/**
 * @deprecated Historical hard-stop. Replaced by evaluateSupersetAgentExecutionGate.
 * Kept for smoke callers that expect default-safe (capability not armed).
 * Does NOT throw merely because SUPERSET_AGENT=1 — boot must succeed.
 * Throws only on publisher conflict when agent capability is requested.
 */
export function assertSupersetAgentExecutionDisabled(env: NodeJS.ProcessEnv = process.env): void {
  const gate = evaluateSupersetAgentExecutionGate(env);
  if (gate.reason === 'publisher_enabled') {
    throw new Error('superset_agent_execution_denied_publisher_on');
  }
}

/**
 * @deprecated Boot must not hard-fail when V2=1. Use evaluateSupersetAgentExecutionGate.
 * Throws only on publisher conflict with agent capability request.
 */
export function assertBusinessExecutionOff(env: NodeJS.ProcessEnv = process.env): void {
  const gate = evaluateSupersetAgentExecutionGate(env);
  if (gate.reason === 'publisher_enabled') {
    throw new Error('business_execution_denied_publisher_on');
  }
}

/** True when env capability window is fully armed (still not a provider call). */
export function isSupersetAgentCapabilityArmed(env: NodeJS.ProcessEnv = process.env): boolean {
  return evaluateSupersetAgentExecutionGate(env).capabilityArmed;
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
 * Must not crash API boot when agent capability flags are set.
 * agent.create remains blocked unless the public bridge agent gate allows it
 * AND Control Plane agent.start authorizes the invoke.
 */
export function createSupersetRpcBackend(
  config?: Partial<SupersetRpcRuntimeConfig>,
  env: NodeJS.ProcessEnv = process.env,
): SupersetExecutionBackend {
  // Evaluate gate for observability; never throw for capability arming alone.
  void evaluateSupersetAgentExecutionGate(env);
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
