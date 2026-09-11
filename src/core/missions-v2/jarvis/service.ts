/**
 * Jarvis V1 / V1.1 service — plan → policy → bounded Hermès/CP / safe mutations.
 * Never talks to Superset CLI, executor.sock, docker, or credentials.
 */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { MissionStore } from '../store.js';
import type { Plan } from '../model.js';
import { MissionError } from '../model.js';
import { configuredSupersetRpcBackend } from '../superset/runtime.js';
import type { SupersetExecutionBackend } from '../superset/backend.js';
import {
  jarvisRequestSchema,
  jarvisResponseSchema,
  jarvisActionParametersSchema,
  SAFE_MUTATION_ACTIONS,
  type JarvisAction,
  type JarvisActionName,
  type JarvisActionResult,
  type JarvisIntent,
  type JarvisPolicyResult,
  type JarvisRequest,
  type JarvisResponse,
  READ_ONLY_ACTIONS,
} from './contract.js';
import { planJarvisActions } from './planner.js';
import {
  decisionIsExecutable,
  evaluateJarvisPolicy,
  resolveJarvisPolicyFlags,
  type JarvisPolicyFlags,
} from './policy.js';
import type { JarvisAuditLog } from './audit.js';
import { MemoryJarvisAuditLog } from './audit.js';
import { jarvisConfig } from './config.js';
import { JarvisMutationRegistry } from './mutations.js';
import { AgentStartController, agentStartDecisionToPolicy } from './agent-start.js';
import {
  CANARY_MAX_RUNTIME_SECONDS,
  OneShotCodexCallGuard,
  providerInvokeArmed,
} from './codex-canary.js';

function requestFingerprint(request: JarvisRequest): string {
  return createHash('sha256').update(JSON.stringify({
    organization_id: request.organization_id,
    message: request.message ?? null,
    action: request.action ?? null,
    parameters: request.parameters ?? null,
  })).digest('hex');
}

export type JarvisHermesBridge = {
  submitMission?(input: {
    title: string;
    objective?: string;
    project?: string;
    organization_id: string;
    actor: string;
    request_id: string;
  }): Promise<{ execution_backend: 'scheduler_owned'; publisher: 'off'; plan?: Plan }>;
};

export type JarvisServiceOptions = {
  enabled: boolean;
  store?: MissionStore;
  audit?: JarvisAuditLog;
  hermes?: JarvisHermesBridge;
  superset?: () => SupersetExecutionBackend | undefined;
  flags?: JarvisPolicyFlags;
  mutations?: JarvisMutationRegistry;
  agentStart?: AgentStartController;
  pool?: Pool;
  idempotency?: Map<string, JarvisResponse>;
  /** Arm only for Nadir-authorized canary — never default true. */
  allowProviderInvoke?: boolean;
};

export class JarvisService {
  private readonly audit: JarvisAuditLog;
  private readonly idempotency: Map<string, { fingerprint: string; response: JarvisResponse }>;
  private readonly mutations: JarvisMutationRegistry;
  readonly agentStart: AgentStartController;

  constructor(private readonly options: JarvisServiceOptions) {
    this.audit = options.audit ?? new MemoryJarvisAuditLog();
    this.idempotency = new Map();
    if (options.idempotency) {
      for (const [key, response] of options.idempotency) {
        this.idempotency.set(key, {
          fingerprint: requestFingerprint({
            request_id: key,
            organization_id: response.intent.organization_id,
            message: response.intent.message,
          }),
          response,
        });
      }
    }
    this.mutations = options.mutations ?? new JarvisMutationRegistry(options.pool);
    this.agentStart = options.agentStart ?? new AgentStartController({
      pool: options.pool,
      mutations: this.mutations,
      audit: this.audit,
      lowRiskAuto: (process.env.AGENTIMPACT_JARVIS_AGENT_LOW_RISK_AUTO || '0') === '1',
      allowProviderInvoke: options.allowProviderInvoke === true,
    });
  }

  async handle(raw: unknown, actor: string): Promise<JarvisResponse> {
    if (!this.options.enabled) throw new MissionError('jarvis_disabled', 503);
    const parsed = jarvisRequestSchema.safeParse(raw);
    if (!parsed.success) throw new MissionError('invalid_jarvis_request', 400);
    const request = parsed.data;

    const cacheKey = request.request_id;
    const fingerprint = requestFingerprint(request);
    const cached = this.idempotency.get(cacheKey);
    if (cached) {
      if (cached.fingerprint !== fingerprint) {
        throw new MissionError('jarvis_request_id_conflict', 409);
      }
      return cached.response;
    }

    await this.audit.append({
      request_id: request.request_id,
      event_type: 'jarvis.request.received',
      actor,
      organization_id: request.organization_id,
      details: {
        message_len: request.message?.length ?? 0,
        typed_action: request.action ?? null,
      },
    });

    let intent: JarvisIntent;
    let actions: JarvisAction[];

    if (request.action) {
      // Strict typed contracts for allowlisted actions. Extra keys (command/pid/argv)
      // are intentionally rejected here except where mutation handlers enforce denials
      // for adversarial probes (tests.run + command, agent.stop + pid).
      const strictParams = jarvisActionParametersSchema.safeParse({
        action: request.action,
        parameters: request.parameters ?? {},
      });
      const params = request.parameters ?? {};
      const adversarialProbe = (
        (request.action === 'tests.run' && ('command' in params || 'argv' in params || 'shell' in params || 'cmd' in params))
        || (request.action === 'agent.stop' && ('pid' in params || 'process' in params))
        || (request.action === 'agent.start' && Object.keys(params).some((k) => ['shell', 'argv', 'pid', 'command', 'env'].includes(k)))
      );
      if (!strictParams.success && !adversarialProbe) {
        throw new MissionError('invalid_jarvis_request', 400);
      }
      intent = {
        request_id: request.request_id,
        actor,
        organization_id: request.organization_id,
        message: request.message ?? `typed:${request.action}`,
        timestamp: new Date().toISOString(),
        inferred_intent: `typed:${request.action}`,
        confidence: 'high',
      };
      actions = [{
        request_id: request.request_id,
        actor,
        organization_id: request.organization_id,
        timestamp: new Date().toISOString(),
        action: request.action,
        parameters: params,
        reason: `typed:${request.action}`,
        risk_level: SAFE_MUTATION_ACTIONS.has(request.action) ? 'medium' : 'low',
        mission_id: typeof params.mission_id === 'string' ? params.mission_id : undefined,
        attempt_id: typeof params.attempt_id === 'string' ? params.attempt_id : undefined,
        fencing_token: typeof params.fencing_token === 'string' ? params.fencing_token : undefined,
      }];
    } else {
      const planned = planJarvisActions({
        request_id: request.request_id,
        actor,
        organization_id: request.organization_id,
        message: request.message!,
      });
      intent = planned.intent;
      if (!planned.ok) {
        const response = jarvisResponseSchema.parse({
          intent,
          actions: [],
          policy: [],
          results: [{
            action: 'status.get',
            decision: 'DENY',
            ok: false,
            simulated: false,
            error_code: planned.error_code,
            duration_ms: 0,
          }],
        });
        this.idempotency.set(cacheKey, { fingerprint, response });
        return response;
      }
      actions = planned.actions;
    }

    await this.audit.append({
      request_id: request.request_id,
      event_type: 'jarvis.intent.parsed',
      actor,
      organization_id: request.organization_id,
      details: { inferred_intent: intent.inferred_intent, confidence: intent.confidence },
    });
    await this.audit.append({
      request_id: request.request_id,
      event_type: 'jarvis.action.planned',
      actor,
      organization_id: request.organization_id,
      details: { actions: actions.map((a) => a.action) },
    });

    const flags = this.options.flags ?? resolveJarvisPolicyFlags();
    const policy: JarvisPolicyResult[] = [];
    const results: JarvisActionResult[] = [];

    for (const action of actions) {
      const isMutation = SAFE_MUTATION_ACTIONS.has(action.action);
      if (isMutation) {
        await this.audit.append({
          request_id: action.request_id, event_type: 'jarvis.mutation.requested', actor,
          organization_id: action.organization_id, action: action.action,
          mission_id: action.mission_id, attempt_id: action.attempt_id,
        });
      }

      const decision = evaluateJarvisPolicy(action, flags);
      policy.push(decision);

      if (decision.decision === 'ALLOW' && (action.action === 'agent.start' || action.action === 'agent.create')) {
        // Controller owns the real decision; run immediately and replace coarse deferral.
        const evaluated = await this.agentStart.evaluate(action, flags);
        const mapped = agentStartDecisionToPolicy(evaluated.decision);
        policy[policy.length - 1] = {
          action: action.action,
          decision: evaluated.decision as JarvisPolicyResult['decision'],
          reason: evaluated.reason,
          approval: evaluated.stages.approval === 'required' || evaluated.stages.approval === 'missing'
            ? { required: true, reason: 'agent_start_default_approval', approver_roles: ['nadir', 'admin'] }
            : undefined,
        };
        // Ensure schema-compatible decision if needed
        if (!['ALLOW', 'DENY', 'REQUIRE_APPROVAL', 'BLOCKED_BY_FEATURE_FLAG', 'CONFLICT', 'STALE_FENCE',
          'QUOTA_EXCEEDED', 'BUDGET_EXCEEDED', 'CONCURRENCY_LIMIT', 'LEASE_CONFLICT', 'INVALID_STATE'].includes(evaluated.decision)) {
          policy[policy.length - 1]!.decision = mapped;
        }
        await this.audit.append({
          request_id: request.request_id,
          event_type: evaluated.ok ? 'jarvis.policy.allowed' : 'jarvis.policy.denied',
          actor, organization_id: request.organization_id, action: action.action,
          decision: String(evaluated.decision), mission_id: action.mission_id, attempt_id: action.attempt_id,
        });
        results.push({
          action: action.action,
          decision: evaluated.decision as JarvisActionResult['decision'],
          ok: evaluated.ok,
          simulated: evaluated.provider_call !== 'invoked',
          data: evaluated,
          error_code: evaluated.ok ? undefined : evaluated.reason.slice(0, 100),
          duration_ms: 0,
        });
        continue;
      }

      if (decision.decision === 'ALLOW') {
        await this.audit.append({
          request_id: request.request_id,
          event_type: isMutation ? 'jarvis.mutation.allowed' : 'jarvis.policy.allowed',
          actor, organization_id: request.organization_id, action: action.action,
          decision: decision.decision, mission_id: action.mission_id, attempt_id: action.attempt_id,
        });
      } else if (decision.decision === 'DENY' || decision.decision === 'BLOCKED_BY_FEATURE_FLAG'
        || decision.decision === 'CONFLICT' || decision.decision === 'STALE_FENCE') {
        await this.audit.append({
          request_id: request.request_id,
          event_type: isMutation ? 'jarvis.mutation.denied' : 'jarvis.policy.denied',
          actor, organization_id: request.organization_id, action: action.action,
          decision: decision.decision, error_code: decision.reason,
        });
      } else if (decision.decision === 'REQUIRE_APPROVAL') {
        await this.audit.append({
          request_id: request.request_id, event_type: 'jarvis.approval.required', actor,
          organization_id: request.organization_id, action: action.action, decision: decision.decision,
        });
      }

      if (!decisionIsExecutable(decision.decision)) {
        results.push({
          action: action.action,
          decision: decision.decision,
          ok: false,
          simulated: false,
          error_code: decision.reason,
          duration_ms: 0,
        });
        continue;
      }

      results.push(await this.execute(action, actor, isMutation));
    }

    const response = jarvisResponseSchema.parse({ intent, actions, policy, results });
    this.idempotency.set(cacheKey, { fingerprint, response });
    return response;
  }

  private async execute(action: JarvisAction, actor: string, isMutation: boolean): Promise<JarvisActionResult> {
    const started = Date.now();
    await this.audit.append({
      request_id: action.request_id,
      event_type: isMutation ? 'jarvis.mutation.started' : 'jarvis.execution.started',
      actor, organization_id: action.organization_id, action: action.action,
      mission_id: action.mission_id, attempt_id: action.attempt_id,
    });

    try {
      if (isMutation) {
        const replay = await this.mutations.replayOrConflict(action);
        if (replay) {
          await this.audit.append({
            request_id: action.request_id, event_type: 'jarvis.mutation.idempotent_replay', actor,
            organization_id: action.organization_id, action: action.action,
            mission_id: action.mission_id, duration_ms: Date.now() - started,
          });
          return { ...replay, duration_ms: Date.now() - started };
        }
      }

      const data = isMutation
        ? await this.dispatchMutation(action)
        : await this.dispatchRead(action);
      const duration_ms = Date.now() - started;
      const result: JarvisActionResult = {
        action: action.action,
        decision: 'ALLOW',
        ok: true,
        simulated: data.simulated === true,
        data: data.payload,
        duration_ms,
      };
      if (isMutation) await this.mutations.persistIdempotent(action, result);
      await this.audit.append({
        request_id: action.request_id,
        event_type: isMutation ? 'jarvis.mutation.completed' : 'jarvis.execution.completed',
        actor, organization_id: action.organization_id, action: action.action,
        mission_id: action.mission_id, duration_ms, decision: 'ALLOW',
      });
      return result;
    } catch (error) {
      if (error instanceof MissionError && error.code === 'jarvis_request_id_conflict') {
        throw error;
      }
      const duration_ms = Date.now() - started;
      const code = error instanceof MissionError ? error.code
        : error instanceof Error ? error.message.slice(0, 100) : 'execution_failed';
      const decision = code === 'stale_fencing_token' ? 'STALE_FENCE'
        : code === 'workspace_duplicate' ? 'CONFLICT'
          : 'ALLOW';
      if (code === 'stale_fencing_token') {
        await this.audit.append({
          request_id: action.request_id, event_type: 'jarvis.mutation.stale_fence', actor,
          organization_id: action.organization_id, action: action.action,
          mission_id: action.mission_id, attempt_id: action.attempt_id, error_code: code,
        });
      }
      await this.audit.append({
        request_id: action.request_id,
        event_type: isMutation ? 'jarvis.mutation.failed' : 'jarvis.execution.failed',
        actor, organization_id: action.organization_id, action: action.action,
        mission_id: action.mission_id, duration_ms, error_code: code,
      });
      return {
        action: action.action,
        decision,
        ok: false,
        simulated: false,
        error_code: code,
        duration_ms,
      };
    }
  }

  private async dispatchMutation(action: JarvisAction): Promise<{ payload: unknown; simulated?: boolean }> {
    switch (action.action as JarvisActionName) {
      case 'mission.create': {
        if (this.options.store) {
          const input = {
            project: String(action.parameters.project),
            title: String(action.parameters.title),
            objective: String(action.parameters.objective),
            source_type: 'command' as const,
            source_id: action.request_id,
          };
          let mission = await this.options.store.admit(input, {
            principal: action.actor,
            key: `jarvis:${action.request_id}`,
          });
          const handoff = await this.options.hermes?.submitMission?.({
            title: input.title,
            objective: input.objective,
            project: input.project,
            organization_id: action.organization_id,
            actor: action.actor,
            request_id: action.request_id,
          });
          if (handoff?.plan && mission.lifecycle_state === 'queued') {
            mission = await this.options.store.transition(mission.id, mission.state_version, 'planning', {
              principal: action.actor,
              key: `jarvis-hermes-plan:${action.request_id}`,
            });
            mission = await this.options.store.savePlan(mission.id, mission.state_version, handoff.plan, {
              principal: action.actor,
              key: `jarvis-hermes-save:${action.request_id}`,
            });
          }
          return {
            payload: {
              mission_id: mission.id,
              lifecycle_state: mission.lifecycle_state,
              requested_worker_type: action.parameters.requested_worker_type,
              hermes_handoff: handoff ? 'accepted' : 'stored_for_hermes',
              execution_backend: 'scheduler_owned',
              publisher: 'off',
              AGENT_STARTED: false,
              MISSION_CREATED: true,
            },
          };
        }
        const mission = this.mutations.createMission(action);
        return {
          payload: {
            mission_id: mission.id,
            lifecycle_state: mission.lifecycle_state,
            requested_worker_type: mission.requested_worker_type,
            execution_backend: 'scheduler_owned',
            publisher: 'off',
            AGENT_STARTED: false,
            MISSION_CREATED: true,
          },
        };
      }
      case 'mission.cancel':
        return { payload: { mission: this.mutations.cancelMission(action) } };
      case 'workspace.create':
        return {
          payload: {
            workspace: this.mutations.createWorkspace(action),
            via: 'jarvis_registry_then_rpc_capable',
          },
        };
      case 'workspace.delete':
        return { payload: { workspace: this.mutations.deleteWorkspace(action) } };
      case 'tests.run':
        return { payload: this.mutations.runTests(action) };
      case 'agent.stop':
        return { payload: this.mutations.stopAgent(action) };
      default:
        throw new MissionError('mutation_not_executable', 403);
    }
  }

  private async dispatchRead(action: JarvisAction): Promise<{ payload: unknown; simulated?: boolean }> {
    switch (action.action) {
      case 'status.get': {
        const backend = this.superset();
        if (backend) return { payload: { health: await backend.health(), via: 'superset_rpc' } };
        return { payload: { ok: true, jarvis: 'ready', business_execution: 'off' }, simulated: true };
      }
      case 'project.list': {
        const backend = this.superset();
        if (!backend) return { payload: { projects: [], via: 'unavailable' }, simulated: true };
        const { createSupersetRpcContext, DEFAULT_SUPERSET_RPC_SOCKET, resolveSupersetRpcSocket } = await import('../superset/runtime.js');
        const { mapSupersetCliToRpc, SupersetRpcClient } = await import('../superset/rpc-client.js');
        const socket = resolveSupersetRpcSocket(process.env) ?? DEFAULT_SUPERSET_RPC_SOCKET;
        const client = new SupersetRpcClient(socket);
        const ctx = createSupersetRpcContext();
        const result = await client.call(mapSupersetCliToRpc(['projects', 'list', '--local', '--json'], ctx));
        return { payload: { projects: result, via: 'superset_rpc' } };
      }
      case 'workspace.list': {
        const backend = this.superset();
        if (!backend) return { payload: { workspaces: [], via: 'unavailable' }, simulated: true };
        const projectId = typeof action.parameters.project_id === 'string' ? action.parameters.project_id : undefined;
        return { payload: { workspaces: await backend.listWorkspaces(projectId), via: 'superset_rpc' } };
      }
      case 'mission.list': {
        if (!this.options.store) return { payload: { items: [], via: 'store_unavailable' }, simulated: true };
        const projectRaw = typeof action.parameters.project === 'string' ? action.parameters.project : undefined;
        if (!projectRaw) return { payload: { items: [], note: 'project_required' }, simulated: true };
        return { payload: { items: await this.options.store.status(projectRaw as never), project: projectRaw } };
      }
      case 'mission.inspect': {
        if (!this.options.store) throw new MissionError('mission_store_unavailable', 503);
        return { payload: { item: await this.options.store.get(String(action.parameters.mission_id)) } };
      }
      case 'mission.events': {
        if (!this.options.store) throw new MissionError('mission_store_unavailable', 503);
        const after = typeof action.parameters.after === 'string' ? action.parameters.after : '0';
        return { payload: { items: await this.options.store.events(String(action.parameters.mission_id), after) } };
      }
      case 'diff.read':
      case 'tests.status':
      case 'agent.status':
      case 'terminal.read':
      case 'workspace.inspect':
        return { payload: { status: 'unavailable_readonly_or_noop', action: action.action }, simulated: true };
      default:
        if (READ_ONLY_ACTIONS.has(action.action)) return { payload: { status: 'noop' }, simulated: true };
        throw new MissionError('jarvis_action_not_executable', 403);
    }
  }

  private superset(): SupersetExecutionBackend | undefined {
    if (this.options.superset) return this.options.superset();
    return configuredSupersetRpcBackend();
  }
}

export function configuredJarvisService(
  store: MissionStore | undefined,
  audit: JarvisAuditLog | undefined,
  env: NodeJS.ProcessEnv = process.env,
  pool?: Pool,
): JarvisService | undefined {
  const cfg = jarvisConfig(env);
  if (!cfg.enabled) return undefined;
  const mutations = new JarvisMutationRegistry(pool);
  const auditLog = audit ?? new MemoryJarvisAuditLog();
  const armed = providerInvokeArmed(env);
  const callGuard = new OneShotCodexCallGuard();
  const agentStart = new AgentStartController({
    pool,
    mutations,
    audit: auditLog,
    lowRiskAuto: (env.AGENTIMPACT_JARVIS_AGENT_LOW_RISK_AUTO || '0') === '1',
    allowProviderInvoke: armed,
    invokeProvider: armed
      ? async (ctx) => {
        if (ctx.superset_agent_id !== 'codex') throw new Error('canary_codex_only');
        callGuard.recordCodexCall();
        const { SupersetRpcClient } = await import('../superset/rpc-client.js');
        const { DEFAULT_SUPERSET_RPC_SOCKET, resolveSupersetRpcSocket } = await import('../superset/runtime.js');
        const { buildTypedAgentCreateRpc } = await import('./codex-canary.js');
        const socket = resolveSupersetRpcSocket(env) ?? DEFAULT_SUPERSET_RPC_SOCKET;
        const client = new SupersetRpcClient(socket, CANARY_MAX_RUNTIME_SECONDS * 1000);
        const request = buildTypedAgentCreateRpc({
          request_id: ctx.request_id,
          mission_id: ctx.mission_id,
          attempt_id: ctx.attempt_id,
          fencing_token: ctx.fencing_token,
          workspace_id: ctx.workspace_id,
          prompt: ctx.prompt,
        });
        const raw = await client.call(request);
        const agentId = raw && typeof raw === 'object' && 'id' in (raw as object)
          ? String((raw as { id: unknown }).id)
          : undefined;
        return { agent_id: agentId, raw };
      }
      : undefined,
  });
  return new JarvisService({
    enabled: true,
    store,
    audit: auditLog,
    pool,
    flags: resolveJarvisPolicyFlags(env),
    mutations,
    agentStart,
    allowProviderInvoke: armed,
    hermes: {
      async submitMission(input) {
        return {
          execution_backend: 'scheduler_owned' as const,
          publisher: 'off' as const,
          plan: {
            acceptance_criteria: [
              `Objective satisfied: ${input.objective ?? input.title}`.slice(0, 1000),
              'Configured tests pass',
              'Diff is limited to mission-owned files',
            ],
            steps: [
              { title: 'Inspect the repository and reproduce the failure', allowed_paths: [] },
              { title: 'Apply the smallest coherent fix', allowed_paths: [] },
              { title: 'Run configured tests and validate the diff', allowed_paths: [] },
            ],
            risks: ['Unexpected repository-specific side effects require reconciliation'],
            completion_criteria: ['Tests pass', 'Diff validation passes', 'Provider and child processes are stopped'],
            dependencies: [],
          },
        };
      },
    },
  });
}
