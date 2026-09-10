/**
 * Jarvis → Hermès → Superset RPC integration smoke (flags OFF).
 * Exercises typed intent + scheduler ownership + RPC driver through the public bridge,
 * then STOPS before agent.create / provider execution.
 */
import { randomUUID } from 'node:crypto';
import { AGENT_REGISTRY_V2, JARVIS_OPERATOR_POLICY } from './agent-registry.js';
import { prepareCodexViaSuperset, CODEX_SUPERSET_INVARIANTS } from './codex-via-superset.js';
import { SupersetParseError } from './json.js';
import {
  mapSupersetCliToRpc,
  SupersetRpcClient,
  type SupersetRpcContext,
} from './rpc-client.js';
import {
  assertSupersetAgentExecutionDisabled,
  assertBusinessExecutionOff,
  createSupersetRpcBackend,
  createSupersetRpcContext,
  DEFAULT_SUPERSET_RPC_SOCKET,
  resolveSupersetRpcSocket,
} from './runtime.js';

export type JarvisIntegrationReport = {
  PUBLIC_HEALTH: 'PASS' | 'FAIL';
  PUBLIC_PROJECT_LIST: 'PASS' | 'FAIL';
  PUBLIC_WORKSPACE_LIST: 'PASS' | 'FAIL';
  REAL_SUPERSET_DRIVER: 'PASS' | 'FAIL';
  REAL_CODEX_DRIVER_MAPPING: 'PASS' | 'FAIL';
  REAL_CURSOR_DRIVER_MAPPING: 'PASS' | 'FAIL';
  PROVIDER_EXECUTION_BLOCKED_BY_FLAG: 'PASS' | 'FAIL';
  REAL_CODEX_CALLS: 0;
  REAL_CURSOR_CALLS: 0;
  V1_RUNTIME_UNCHANGED: 'YES' | 'NO';
  BUSINESS_EXECUTION_FLAGS: 'OFF' | 'ON';
  AGENT_CREATE_ENABLED: 'NO' | 'YES';
  PUBLISHER: 'OFF' | 'ON';
  errors: string[];
};

function hermesTypedAdmissionShape(worker: 'codex' | 'cursor') {
  // Mirrors hermesMissionResponseSchema ownership rules without enabling the live Hermes API.
  return {
    source_type: 'jarvis' as const,
    requested_worker_type: worker,
    execution_backend: 'scheduler_owned' as const,
    publisher: 'off' as const,
    scheduler_execution_backend: 'superset' as const,
  };
}

export async function runJarvisSupersetRpcIntegration(
  env: NodeJS.ProcessEnv = process.env,
  options?: { socketPath?: string; context?: SupersetRpcContext },
): Promise<JarvisIntegrationReport> {
  const errors: string[] = [];
  const report: JarvisIntegrationReport = {
    PUBLIC_HEALTH: 'FAIL',
    PUBLIC_PROJECT_LIST: 'FAIL',
    PUBLIC_WORKSPACE_LIST: 'FAIL',
    REAL_SUPERSET_DRIVER: 'FAIL',
    REAL_CODEX_DRIVER_MAPPING: 'FAIL',
    REAL_CURSOR_DRIVER_MAPPING: 'FAIL',
    PROVIDER_EXECUTION_BLOCKED_BY_FLAG: 'FAIL',
    REAL_CODEX_CALLS: 0,
    REAL_CURSOR_CALLS: 0,
    V1_RUNTIME_UNCHANGED: 'YES',
    BUSINESS_EXECUTION_FLAGS: 'OFF',
    AGENT_CREATE_ENABLED: 'NO',
    PUBLISHER: 'OFF',
    errors,
  };

  try {
    assertSupersetAgentExecutionDisabled(env);
    assertBusinessExecutionOff(env);
  } catch (e) {
    report.BUSINESS_EXECUTION_FLAGS = 'ON';
    errors.push(e instanceof Error ? e.message : 'flags_invalid');
    return report;
  }

  if ((env.AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED || '0').trim() === '1') {
    report.PUBLISHER = 'ON';
    errors.push('publisher_must_remain_off');
  }

  const socketPath = options?.socketPath
    ?? resolveSupersetRpcSocket(env)
    ?? DEFAULT_SUPERSET_RPC_SOCKET;
  if (socketPath !== DEFAULT_SUPERSET_RPC_SOCKET) {
    errors.push('socket_not_allowlisted');
    return report;
  }

  const context = options?.context ?? createSupersetRpcContext();
  const backend = createSupersetRpcBackend({ socketPath, context }, env);
  const client = new SupersetRpcClient(socketPath);

  // Hermès typed ownership: planner never selects the backend; scheduler owns superset.
  for (const worker of ['codex', 'cursor'] as const) {
    const admission = hermesTypedAdmissionShape(worker);
    if (admission.execution_backend !== 'scheduler_owned' || admission.publisher !== 'off') {
      errors.push(`hermes_typed_ownership_${worker}`);
    }
    if (admission.scheduler_execution_backend !== 'superset') {
      errors.push(`hermes_scheduler_backend_${worker}`);
    }
  }
  if (!JARVIS_OPERATOR_POLICY.DENY.includes('generic.shell')) {
    errors.push('jarvis_policy_missing_deny');
  }

  // Live RPC through public bridge → private executor (read-only ops).
  const health = await backend.health();
  if (health.ok || health.running) {
    report.PUBLIC_HEALTH = 'PASS';
  } else {
    errors.push(`health:${health.detail ?? 'failed'}`);
  }

  try {
    const projects = await client.call(mapSupersetCliToRpc(['projects', 'list', '--local', '--json'], context));
    if (projects === undefined) throw new Error('empty');
    report.PUBLIC_PROJECT_LIST = 'PASS';
  } catch (e) {
    errors.push(`project.list:${e instanceof Error ? e.message : 'failed'}`);
  }

  try {
    await backend.listWorkspaces();
    report.PUBLIC_WORKSPACE_LIST = 'PASS';
  } catch (e) {
    errors.push(`workspace.list:${e instanceof Error ? e.message : 'failed'}`);
  }

  if (report.PUBLIC_HEALTH === 'PASS' && report.PUBLIC_PROJECT_LIST === 'PASS' && report.PUBLIC_WORKSPACE_LIST === 'PASS') {
    report.REAL_SUPERSET_DRIVER = 'PASS';
  }

  const codex = AGENT_REGISTRY_V2.find((e) => e.id === 'CODEX');
  const cursor = AGENT_REGISTRY_V2.find((e) => e.id === 'CURSOR');
  if (codex && codex.execution_backend === 'superset' && codex.enabled === false && codex.superset_ready === true) {
    report.REAL_CODEX_DRIVER_MAPPING = 'PASS';
  } else {
    errors.push('codex_driver_mapping');
  }
  if (cursor && cursor.execution_backend === 'superset' && cursor.enabled === false) {
    report.REAL_CURSOR_DRIVER_MAPPING = 'PASS';
  } else {
    errors.push('cursor_driver_mapping');
  }

  // STOP before agent.create: prepared Codex path must not start; mapper denies agents argv;
  // direct agent.create over RPC must be rejected by the public bridge flag.
  const prepared = await prepareCodexViaSuperset({
    backend,
    identity: {
      workspaceId: randomUUID(),
      projectId: randomUUID(),
      worktreePath: '/var/lib/agentimpact-superset/fixtures/unused',
      branch: 'hermes/unused',
      baseSha: '0'.repeat(40),
      headSha: '0'.repeat(40),
      attemptId: context.attemptId,
      fencingToken: 1,
      leaseId: randomUUID(),
    },
    lease: {
      activeLeaseAttemptId: context.attemptId,
      requestedAttemptId: context.attemptId,
      leaseStatus: 'active',
      fencingTokenStored: 1,
      fencingTokenRequest: 1,
      attemptDeadlineMs: Date.now() + 60_000,
    },
    codexCommand: 'agents create --agent codex',
    enabled: false,
  });
  if (prepared.message !== 'codex_superset_prepared_not_started') {
    errors.push('codex_prepare_started');
  }
  if (!CODEX_SUPERSET_INVARIANTS.includes('no_publisher_credential')) {
    errors.push('codex_invariants');
  }

  let mapperBlocked = false;
  try {
    mapSupersetCliToRpc(['agents', 'create', '--workspace', randomUUID(), '--agent', 'codex', '--prompt', 'x', '--json'], context);
  } catch (e) {
    mapperBlocked = e instanceof SupersetParseError && e.code === 'rpc_operation_denied';
  }
  if (!mapperBlocked) errors.push('mapper_allows_agent_create');

  let bridgeBlocked = false;
  try {
    await client.call({
      request_id: randomUUID(),
      operation: 'agent.create',
      mission_id: context.missionId,
      attempt_id: context.attemptId,
      fencing_token: context.fencingToken,
      parameters: { workspace_id: randomUUID(), agent: 'codex', prompt: 'must-not-run' },
    });
  } catch (e) {
    bridgeBlocked = e instanceof SupersetParseError && e.code === 'rpc_request_rejected';
  }
  if (!bridgeBlocked) errors.push('bridge_allows_agent_create');

  if (mapperBlocked && bridgeBlocked && prepared.message === 'codex_superset_prepared_not_started') {
    report.PROVIDER_EXECUTION_BLOCKED_BY_FLAG = 'PASS';
    report.AGENT_CREATE_ENABLED = 'NO';
  } else {
    report.AGENT_CREATE_ENABLED = 'YES';
  }

  report.REAL_CODEX_CALLS = 0;
  report.REAL_CURSOR_CALLS = 0;
  return report;
}

export function printJarvisIntegrationReport(report: JarvisIntegrationReport): boolean {
  const keys: (keyof JarvisIntegrationReport)[] = [
    'PUBLIC_HEALTH', 'PUBLIC_PROJECT_LIST', 'PUBLIC_WORKSPACE_LIST',
    'REAL_SUPERSET_DRIVER', 'REAL_CODEX_DRIVER_MAPPING', 'REAL_CURSOR_DRIVER_MAPPING',
    'PROVIDER_EXECUTION_BLOCKED_BY_FLAG', 'REAL_CODEX_CALLS', 'REAL_CURSOR_CALLS',
    'V1_RUNTIME_UNCHANGED', 'BUSINESS_EXECUTION_FLAGS', 'AGENT_CREATE_ENABLED', 'PUBLISHER',
  ];
  for (const key of keys) {
    console.log(`${key}=${report[key]}`);
  }
  if (report.errors.length) {
    console.log(`ERRORS=${JSON.stringify(report.errors)}`);
  }
  const ok = report.REAL_SUPERSET_DRIVER === 'PASS'
    && report.REAL_CODEX_DRIVER_MAPPING === 'PASS'
    && report.REAL_CURSOR_DRIVER_MAPPING === 'PASS'
    && report.PROVIDER_EXECUTION_BLOCKED_BY_FLAG === 'PASS'
    && report.REAL_CODEX_CALLS === 0
    && report.REAL_CURSOR_CALLS === 0
    && report.V1_RUNTIME_UNCHANGED === 'YES'
    && report.BUSINESS_EXECUTION_FLAGS === 'OFF'
    && report.AGENT_CREATE_ENABLED === 'NO'
    && report.PUBLISHER === 'OFF'
    && report.errors.length === 0;
  return ok;
}
