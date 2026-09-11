import { describe, expect, it, vi } from 'vitest';
import { AGENT_REGISTRY_V2 } from './agent-registry.js';
import { mapSupersetCliToRpc } from './rpc-client.js';
import {
  assertBusinessExecutionOff,
  assertSupersetAgentExecutionDisabled,
  createSupersetRpcBackend,
  evaluateSupersetAgentExecutionGate,
  isSupersetAgentCapabilityArmed,
  resolveSupersetRpcSocket,
  DEFAULT_SUPERSET_RPC_SOCKET,
  createSupersetRpcContext,
} from './runtime.js';
import { providerInvokeArmed } from '../jarvis/codex-canary.js';

const canaryArmed = {
  AGENTIMPACT_V2_EXECUTION_ENABLED: '1',
  AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: '1',
  AGENTIMPACT_JARVIS_PROVIDER_INVOKE_ARMED: '1',
  AGENTIMPACT_JARVIS_ROOT_ONE_SHOT_CANARY: '1',
  AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED: '0',
  AGENTIMPACT_SUPERSET_RPC_SOCKET: DEFAULT_SUPERSET_RPC_SOCKET,
};

describe('Superset agent execution multi-gate', () => {
  it('flags off → boot-safe backend, capability denied, provider blocked', () => {
    const env = { AGENTIMPACT_SUPERSET_RPC_SOCKET: DEFAULT_SUPERSET_RPC_SOCKET };
    const g = evaluateSupersetAgentExecutionGate(env);
    expect(g.reason).toBe('v2_disabled');
    expect(g.capabilityArmed).toBe(false);
    expect(g.CONTROL_PLANE_AGENT_GATE).toBe('DENY');
    expect(g.RPC_BRIDGE_AGENT_GATE).toBe('DENY');
    expect(g.PROVIDER_INVOKE_MULTI_GATE).toBe('DENY');
    expect(() => createSupersetRpcBackend({}, env)).not.toThrow();
    expect(providerInvokeArmed(env)).toBe(false);
  });

  it('V2 only → boot pass, provider blocked', () => {
    const env = {
      AGENTIMPACT_V2_EXECUTION_ENABLED: '1',
      AGENTIMPACT_SUPERSET_RPC_SOCKET: DEFAULT_SUPERSET_RPC_SOCKET,
    };
    const g = evaluateSupersetAgentExecutionGate(env);
    expect(g.reason).toBe('superset_agent_disabled');
    expect(g.capabilityArmed).toBe(false);
    expect(() => createSupersetRpcBackend({}, env)).not.toThrow();
    expect(() => assertBusinessExecutionOff(env)).not.toThrow();
  });

  it('V2 + Superset agent → boot pass, provider blocked', () => {
    const env = {
      AGENTIMPACT_V2_EXECUTION_ENABLED: '1',
      AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: '1',
      AGENTIMPACT_SUPERSET_RPC_SOCKET: DEFAULT_SUPERSET_RPC_SOCKET,
    };
    const g = evaluateSupersetAgentExecutionGate(env);
    expect(g.reason).toBe('provider_not_armed');
    expect(g.RPC_BRIDGE_AGENT_GATE).toBe('PASS');
    expect(g.CONTROL_PLANE_AGENT_GATE).toBe('DENY');
    expect(g.capabilityArmed).toBe(false);
    expect(() => createSupersetRpcBackend({}, env)).not.toThrow();
    expect(() => assertSupersetAgentExecutionDisabled(env)).not.toThrow();
  });

  it('V2 + Superset + provider armed (no one-shot) → boot, no capability', () => {
    const env = {
      AGENTIMPACT_V2_EXECUTION_ENABLED: '1',
      AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: '1',
      AGENTIMPACT_JARVIS_PROVIDER_INVOKE_ARMED: '1',
      AGENTIMPACT_SUPERSET_RPC_SOCKET: DEFAULT_SUPERSET_RPC_SOCKET,
    };
    const g = evaluateSupersetAgentExecutionGate(env);
    expect(g.reason).toBe('one_shot_missing');
    expect(g.capabilityArmed).toBe(false);
    expect(providerInvokeArmed(env)).toBe(false);
    expect(() => createSupersetRpcBackend({}, env)).not.toThrow();
  });

  it('full canary gates + publisher off → capability armed, no auto provider', () => {
    const g = evaluateSupersetAgentExecutionGate(canaryArmed);
    expect(g.reason).toBe('armed');
    expect(g.capabilityArmed).toBe(true);
    expect(g.CONTROL_PLANE_AGENT_GATE).toBe('PASS');
    expect(g.RPC_BRIDGE_AGENT_GATE).toBe('PASS');
    expect(g.PROVIDER_INVOKE_MULTI_GATE).toBe('PASS');
    expect(g.PUBLISHER_HARD_SEPARATION).toBe('PASS');
    expect(isSupersetAgentCapabilityArmed(canaryArmed)).toBe(true);
    expect(providerInvokeArmed(canaryArmed)).toBe(true);
    // Boot still succeeds — capability ≠ execution
    expect(() => createSupersetRpcBackend({}, canaryArmed)).not.toThrow();
  });

  it('publisher on with agent capability request → denied', () => {
    const env = { ...canaryArmed, AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED: '1' };
    const g = evaluateSupersetAgentExecutionGate(env);
    expect(g.reason).toBe('publisher_enabled');
    expect(g.capabilityArmed).toBe(false);
    expect(g.PUBLISHER_HARD_SEPARATION).toBe('FAIL');
    expect(g.PROVIDER_INVOKE_MULTI_GATE).toBe('DENY');
    expect(() => assertSupersetAgentExecutionDisabled(env)).toThrow(/publisher/);
  });
});

describe('Superset RPC runtime socket allowlist', () => {
  it('allowlists only the public bridge socket', () => {
    expect(resolveSupersetRpcSocket({})).toBeUndefined();
    expect(resolveSupersetRpcSocket({
      AGENTIMPACT_SUPERSET_RPC_SOCKET: DEFAULT_SUPERSET_RPC_SOCKET,
    })).toBe(DEFAULT_SUPERSET_RPC_SOCKET);
    expect(() => resolveSupersetRpcSocket({
      AGENTIMPACT_SUPERSET_RPC_SOCKET: '/tmp/evil.sock',
    })).toThrow('superset_rpc_socket_not_allowlisted');
  });
});

describe('driver mappings and provider block', () => {
  it('maps CODEX and CURSOR to execution_backend=superset while disabled', () => {
    const codex = AGENT_REGISTRY_V2.find((e) => e.id === 'CODEX');
    const cursor = AGENT_REGISTRY_V2.find((e) => e.id === 'CURSOR');
    expect(codex).toMatchObject({ execution_backend: 'superset', enabled: false, superset_ready: true });
    expect(cursor).toMatchObject({ execution_backend: 'superset', enabled: false });
  });

  it('denies agents create in the RPC mapper (stop before agent.create)', () => {
    const context = createSupersetRpcContext();
    expect(() => mapSupersetCliToRpc(
      ['agents', 'create', '--workspace', context.missionId, '--agent', 'codex', '--prompt', 'x', '--json'],
      context,
    )).toThrow(/rpc_operation_denied/);
  });
});

describe('jarvis integration report helpers', () => {
  it('exports a runnable smoke module', async () => {
    vi.resetModules();
    const mod = await import('./jarvis-integration-smoke.js');
    expect(typeof mod.runJarvisSupersetRpcIntegration).toBe('function');
    expect(typeof mod.printJarvisIntegrationReport).toBe('function');
  });
});
