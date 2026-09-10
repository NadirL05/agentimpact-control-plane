import { describe, expect, it, vi } from 'vitest';
import { AGENT_REGISTRY_V2 } from './agent-registry.js';
import { mapSupersetCliToRpc } from './rpc-client.js';
import {
  assertBusinessExecutionOff,
  assertSupersetAgentExecutionDisabled,
  resolveSupersetRpcSocket,
  DEFAULT_SUPERSET_RPC_SOCKET,
} from './runtime.js';
import { createSupersetRpcContext } from './runtime.js';

describe('Superset RPC runtime flags', () => {
  it('allowlists only the public bridge socket', () => {
    expect(resolveSupersetRpcSocket({})).toBeUndefined();
    expect(resolveSupersetRpcSocket({
      AGENTIMPACT_SUPERSET_RPC_SOCKET: DEFAULT_SUPERSET_RPC_SOCKET,
    })).toBe(DEFAULT_SUPERSET_RPC_SOCKET);
    expect(() => resolveSupersetRpcSocket({
      AGENTIMPACT_SUPERSET_RPC_SOCKET: '/tmp/evil.sock',
    })).toThrow('superset_rpc_socket_not_allowlisted');
  });

  it('keeps agent execution and business flags off by default', () => {
    expect(() => assertSupersetAgentExecutionDisabled({})).not.toThrow();
    expect(() => assertBusinessExecutionOff({})).not.toThrow();
    expect(() => assertSupersetAgentExecutionDisabled({
      AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: '1',
    })).toThrow(/disabled/);
    expect(() => assertBusinessExecutionOff({
      AGENTIMPACT_V2_EXECUTION_ENABLED: '1',
    })).toThrow(/business_execution/);
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
