/**
 * Jarvis V1.2 controlled agent.start — Control Plane gates before any provider call.
 * Never launches agents directly. Publisher remains OFF. Default: REQUIRE_APPROVAL.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { MissionError, digest } from '../model.js';
import type { JarvisAction, JarvisPolicyDecision } from './contract.js';
import type { JarvisAuditLog } from './audit.js';
import type { JarvisPolicyFlags } from './policy.js';
import type { JarvisMutationRegistry } from './mutations.js';

export type JarvisWorkerType = 'codex' | 'cursor';
export type SupersetAgentId = 'codex' | 'cursor-agent';
export type QuotaState = 'available' | 'limited' | 'exhausted' | 'unknown';

export type AgentStartDecision =
  | JarvisPolicyDecision
  | 'QUOTA_EXCEEDED'
  | 'BUDGET_EXCEEDED'
  | 'CONCURRENCY_LIMIT'
  | 'LEASE_CONFLICT'
  | 'INVALID_STATE';

export type AgentStartApproval = {
  approval_id: string;
  organization_id: string;
  mission_id: string;
  attempt_id: string;
  worker_type: JarvisWorkerType;
  request_id: string;
  payload_hash: string;
  risk_level: string;
  budget_ceiling: number;
  actor: string;
  expires_at: string;
  consumed_at: string | null;
};

export type AgentStartResult = {
  decision: AgentStartDecision;
  ok: boolean;
  provider_call: 'blocked' | 'authorized_but_not_invoked' | 'invoked';
  real_codex_calls: 0 | 1;
  real_cursor_calls: 0 | 1;
  stages: {
    typed_action: boolean;
    policy_evaluated: boolean;
    approval: 'missing' | 'required' | 'valid' | 'invalid' | 'expired' | 'consumed_replay';
    quota: QuotaState | 'skipped';
    budget: 'none' | 'reserved' | 'denied' | 'released';
    attempt: 'ok' | 'missing' | 'mismatch' | 'invalid_state';
    lease: 'none' | 'acquired' | 'conflict' | 'skipped';
    fencing: 'ok' | 'stale' | 'missing' | 'skipped';
    workspace: 'ok' | 'missing' | 'mismatch' | 'skipped';
    scheduler: 'evaluated' | 'authorized' | 'blocked';
    feature_flags: {
      v2_execution: boolean;
      superset_agent_execution: boolean;
      publisher: boolean;
    };
  };
  worker_mapping: { requested_worker_type: JarvisWorkerType; superset_agent_id: SupersetAgentId };
  approval_id?: string;
  lease_id?: string;
  budget_reservation_id?: string;
  reason: string;
  completion_confidence?: 'INSUFFICIENT' | 'SUFFICIENT';
};

const FORBIDDEN_KEYS = new Set([
  'shell', 'argv', 'pid', 'binary', 'binary_path', 'workspace_path', 'path',
  'env', 'environment', 'credential', 'credentials', 'api_key', 'model',
  'superset_options', 'cli', 'command', 'cmd',
]);

export function mapWorkerToSupersetAgent(worker: JarvisWorkerType): SupersetAgentId {
  return worker === 'cursor' ? 'cursor-agent' : 'codex';
}

export function agentStartPayloadHash(input: {
  organization_id: string;
  mission_id: string;
  attempt_id: string;
  requested_worker_type: JarvisWorkerType;
  reason: string;
  execution_profile?: string;
  max_runtime_seconds?: number;
  budget_class?: string;
}): string {
  return digest({
    organization_id: input.organization_id,
    mission_id: input.mission_id,
    attempt_id: input.attempt_id,
    requested_worker_type: input.requested_worker_type,
    reason: input.reason,
    execution_profile: input.execution_profile ?? null,
    max_runtime_seconds: input.max_runtime_seconds ?? null,
    budget_class: input.budget_class ?? null,
  });
}

function requestFingerprint(action: JarvisAction): string {
  return createHash('sha256').update(JSON.stringify({
    action: action.action,
    organization_id: action.organization_id,
    parameters: action.parameters,
  })).digest('hex');
}

export class AgentStartController {
  readonly approvals = new Map<string, AgentStartApproval>();
  readonly quotas = new Map<JarvisWorkerType, QuotaState>([
    ['codex', 'unknown'],
    ['cursor', 'unknown'],
  ]);
  readonly budgets = new Map<string, {
    id: string; status: 'requested' | 'reserved' | 'consumed' | 'released';
    organization_id: string; mission_id: string; attempt_id: string;
    worker_type: JarvisWorkerType; request_id: string; budget_ceiling: number;
  }>();
  readonly leases = new Map<string, {
    id: string; status: 'reserved' | 'leased' | 'released' | 'quarantined';
    organization_id: string; mission_id: string; attempt_id: string;
    worker_type: JarvisWorkerType; workspace_id?: string; fencing_token: string;
  }>();
  /** attempt_id → active lease id */
  readonly activeLeaseByAttempt = new Map<string, string>();
  readonly idempotency = new Map<string, { hash: string; result: AgentStartResult }>();
  /** Workspace bindings: workspace_id → binding */
  readonly workspaces = new Map<string, {
    organization_id: string; mission_id: string; attempt_id: string; fencing_token: string;
  }>();

  constructor(
    private readonly options: {
      pool?: Pool;
      mutations?: JarvisMutationRegistry;
      audit?: JarvisAuditLog;
      /** Explicit low-risk auto only when env AGENTIMPACT_JARVIS_AGENT_LOW_RISK_AUTO=1 */
      lowRiskAuto?: boolean;
      /** Never invoke provider in unit/stage A/B unless true (canary). */
      allowProviderInvoke?: boolean;
      /** Optional real provider hook — must enforce one-shot Codex only. */
      invokeProvider?: (ctx: {
        workspace_id: string;
        mission_id: string;
        attempt_id: string;
        fencing_token: string;
        prompt: string;
        request_id: string;
        superset_agent_id: SupersetAgentId;
      }) => Promise<{ agent_id?: string; raw?: unknown }>;
    } = {},
  ) {}

  setQuota(worker: JarvisWorkerType, state: QuotaState): void {
    this.quotas.set(worker, state);
  }

  async hydrateFromPool(): Promise<void> {
    if (!this.options.pool) return;
    try {
      const { getAgentQuotaDecision, decisionToRuntimeQuotaState } = await import('./agent-quota.js');
      const q = await this.options.pool.query(
        `SELECT worker_type, quota_state, source, reason, observed_at, expires_at, updated_at, note
         FROM jarvis_agent_quota_state`,
      );
      for (const row of q.rows) {
        if (row.worker_type !== 'codex' && row.worker_type !== 'cursor') continue;
        const decision = getAgentQuotaDecision(row, { workerType: row.worker_type });
        this.quotas.set(row.worker_type, decisionToRuntimeQuotaState(decision));
      }
    } catch {
      // table may be absent — leave fail-closed defaults (unknown)
    }
  }

  async loadApproval(approvalId: string): Promise<AgentStartApproval | undefined> {
    const mem = this.approvals.get(approvalId);
    if (mem) return mem;
    if (!this.options.pool) return undefined;
    try {
      const r = await this.options.pool.query(
        `SELECT approval_id, organization_id, mission_id, attempt_id, worker_type, request_id,
                payload_hash, risk_level, budget_ceiling, actor, expires_at, consumed_at
         FROM jarvis_agent_start_approvals WHERE approval_id=$1::uuid`,
        [approvalId],
      );
      const row = r.rows[0];
      if (!row) return undefined;
      const approval: AgentStartApproval = {
        approval_id: row.approval_id,
        organization_id: row.organization_id,
        mission_id: row.mission_id,
        attempt_id: row.attempt_id,
        worker_type: row.worker_type,
        request_id: row.request_id,
        payload_hash: row.payload_hash,
        risk_level: row.risk_level,
        budget_ceiling: Number(row.budget_ceiling),
        actor: row.actor,
        expires_at: new Date(row.expires_at).toISOString(),
        consumed_at: row.consumed_at ? new Date(row.consumed_at).toISOString() : null,
      };
      this.approvals.set(approval.approval_id, approval);
      return approval;
    } catch {
      return undefined;
    }
  }

  issueApproval(input: Omit<AgentStartApproval, 'approval_id' | 'consumed_at'> & { approval_id?: string }): AgentStartApproval {
    const approval: AgentStartApproval = {
      approval_id: input.approval_id ?? randomUUID(),
      organization_id: input.organization_id,
      mission_id: input.mission_id,
      attempt_id: input.attempt_id,
      worker_type: input.worker_type,
      request_id: input.request_id,
      payload_hash: input.payload_hash,
      risk_level: input.risk_level,
      budget_ceiling: input.budget_ceiling,
      actor: input.actor,
      expires_at: input.expires_at,
      consumed_at: null,
    };
    this.approvals.set(approval.approval_id, approval);
    return approval;
  }

  bindWorkspace(workspaceId: string, binding: {
    organization_id: string; mission_id: string; attempt_id: string; fencing_token: string;
  }): void {
    this.workspaces.set(workspaceId, binding);
  }

  async evaluate(
    action: JarvisAction,
    flags: JarvisPolicyFlags,
    now = Date.now(),
  ): Promise<AgentStartResult> {
    if (action.action === 'agent.create') {
      return this.finish({
        decision: 'DENY',
        ok: false,
        provider_call: 'blocked',
        real_codex_calls: 0,
        real_cursor_calls: 0,
        stages: this.emptyStages(flags),
        worker_mapping: { requested_worker_type: 'codex', superset_agent_id: 'codex' },
        reason: 'agent_create_permanently_denied',
      }, action);
    }
    if (action.action !== 'agent.start') {
      throw new MissionError('not_agent_start', 400);
    }

    const hash = requestFingerprint(action);
    const known = this.idempotency.get(action.request_id);
    if (known) {
      if (known.hash !== hash) throw new MissionError('jarvis_request_id_conflict', 409);
      return { ...known.result, reason: `${known.result.reason}:idempotent_replay` };
    }

    await this.hydrateFromPool();
    await this.audit('jarvis.agent_start.requested', action, {});

    for (const key of Object.keys(action.parameters)) {
      if (FORBIDDEN_KEYS.has(key)) {
        return this.persist(action, hash, await this.denied(action, flags, 'DENY', 'shell_argv_injection_denied'));
      }
    }

    const missionId = typeof action.parameters.mission_id === 'string' ? action.parameters.mission_id : '';
    const attemptId = typeof action.parameters.attempt_id === 'string' ? action.parameters.attempt_id : '';
    const workerRaw = action.parameters.requested_worker_type;
    const worker: JarvisWorkerType = workerRaw === 'cursor' ? 'cursor' : workerRaw === 'codex' ? 'codex' : 'codex';
    const reason = typeof action.parameters.reason === 'string' ? action.parameters.reason : '';
    const fencingToken = typeof action.parameters.fencing_token === 'string'
      ? action.parameters.fencing_token
      : (action.fencing_token ?? '');
    const workspaceId = typeof action.parameters.workspace_id === 'string' ? action.parameters.workspace_id : '';
    const approvalId = typeof action.parameters.approval_id === 'string' ? action.parameters.approval_id : '';
    const executionProfile = typeof action.parameters.execution_profile === 'string'
      ? action.parameters.execution_profile : undefined;
    const maxRuntime = typeof action.parameters.max_runtime_seconds === 'number'
      ? action.parameters.max_runtime_seconds : undefined;
    const budgetClass = typeof action.parameters.budget_class === 'string'
      ? action.parameters.budget_class : undefined;
    const budgetCeiling = typeof action.parameters.budget_ceiling === 'number'
      ? action.parameters.budget_ceiling : 1;

    const mapping = {
      requested_worker_type: worker,
      superset_agent_id: mapWorkerToSupersetAgent(worker),
    };

    const stages = this.emptyStages(flags);
    stages.typed_action = Boolean(missionId && attemptId && reason && (workerRaw === 'codex' || workerRaw === 'cursor'));
    stages.policy_evaluated = true;
    await this.audit('jarvis.agent_start.policy_evaluated', action, { worker_type: worker });

    if (!stages.typed_action) {
      stages.attempt = 'missing';
      stages.scheduler = 'evaluated';
      stages.approval = 'required';
      await this.audit('jarvis.agent_start.approval_required', action, { reason: 'contract_incomplete' });
      // Stage A: incomplete NL still proves flag-block before provider.
      if (!flags.businessExecutionEnabled || !flags.agentExecutionEnabled) {
        return this.persist(action, hash, {
          decision: 'BLOCKED_BY_FEATURE_FLAG',
          ok: false,
          provider_call: 'blocked',
          real_codex_calls: 0,
          real_cursor_calls: 0,
          stages,
          worker_mapping: mapping,
          reason: !flags.businessExecutionEnabled
            ? 'AGENTIMPACT_V2_EXECUTION_ENABLED=0'
            : 'AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED=0',
          completion_confidence: 'INSUFFICIENT',
        });
      }
      stages.scheduler = 'blocked';
      return this.persist(action, hash, {
        decision: 'INVALID_STATE',
        ok: false,
        provider_call: 'blocked',
        real_codex_calls: 0,
        real_cursor_calls: 0,
        stages,
        worker_mapping: mapping,
        reason: 'agent_start_contract_incomplete',
      });
    }

    // Mission / attempt ownership via Jarvis mutation registry when present
    const mission = this.options.mutations?.missions.get(missionId);
    if (!mission || mission.organization_id !== action.organization_id) {
      stages.attempt = 'mismatch';
      stages.scheduler = 'blocked';
      return this.persist(action, hash, {
        decision: 'DENY',
        ok: false,
        provider_call: 'blocked',
        real_codex_calls: 0,
        real_cursor_calls: 0,
        stages,
        worker_mapping: mapping,
        reason: 'mission_ownership_denied',
      });
    }
    if (mission.lifecycle_state === 'cancelled') {
      stages.attempt = 'invalid_state';
      stages.scheduler = 'blocked';
      return this.persist(action, hash, {
        decision: 'INVALID_STATE',
        ok: false,
        provider_call: 'blocked',
        real_codex_calls: 0,
        real_cursor_calls: 0,
        stages,
        worker_mapping: mapping,
        reason: 'mission_cancelled',
      });
    }
    stages.attempt = 'ok';

    // Publisher never via agent.start
    if (flags.publisherEnabled) {
      // Still block publisher side-effects even if misconfigured
    }
    if (action.parameters.publisher === true || action.parameters.git_push === true) {
      return this.persist(action, hash, await this.denied(action, flags, 'DENY', 'publisher_requested_via_agent_start'));
    }

    // Feature flags — Stage A/B stop before provider
    if (!flags.businessExecutionEnabled) {
      stages.scheduler = 'evaluated';
      await this.audit('jarvis.agent_start.approval_required', action, { reason: 'v2_off_still_evaluates_approval' });
      stages.approval = 'required';
      return this.persist(action, hash, {
        decision: 'BLOCKED_BY_FEATURE_FLAG',
        ok: false,
        provider_call: 'blocked',
        real_codex_calls: 0,
        real_cursor_calls: 0,
        stages,
        worker_mapping: mapping,
        reason: 'AGENTIMPACT_V2_EXECUTION_ENABLED=0',
        completion_confidence: 'INSUFFICIENT',
      });
    }

    // V2 ON — continue gates; agent flag may still block provider
    stages.scheduler = 'evaluated';

    const payloadHash = agentStartPayloadHash({
      organization_id: action.organization_id,
      mission_id: missionId,
      attempt_id: attemptId,
      requested_worker_type: worker,
      reason,
      execution_profile: executionProfile,
      max_runtime_seconds: maxRuntime,
      budget_class: budgetClass,
    });

    // Approval boundary (default REQUIRE_APPROVAL)
    const lowRiskAuto = this.options.lowRiskAuto === true
      && executionProfile === 'jarvis_low_risk_noop'
      && (maxRuntime ?? 0) > 0
      && (maxRuntime ?? 0) <= 60;

    if (!lowRiskAuto) {
      await this.audit('jarvis.agent_start.approval_required', action, { payload_hash: payloadHash });
      if (!approvalId) {
        stages.approval = 'missing';
        stages.scheduler = 'blocked';
        // When agent flag also off, prefer feature flag decision for Stage B clarity after approval missing...
        // Spec: approval missing → blocked. If agent exec off, still REQUIRE_APPROVAL first when V2 on? 
        // Stage B wants scheduler authorize path but provider blocked.
        // Missing approval → REQUIRE_APPROVAL (not provider).
        return this.persist(action, hash, {
          decision: 'REQUIRE_APPROVAL',
          ok: false,
          provider_call: 'blocked',
          real_codex_calls: 0,
          real_cursor_calls: 0,
          stages,
          worker_mapping: mapping,
          reason: 'agent_start_approval_required',
        });
      }
      const approval = (await this.loadApproval(approvalId)) ?? this.approvals.get(approvalId);
      if (!approval) {
        stages.approval = 'invalid';
        return this.persist(action, hash, {
          decision: 'DENY',
          ok: false,
          provider_call: 'blocked',
          real_codex_calls: 0,
          real_cursor_calls: 0,
          stages,
          worker_mapping: mapping,
          reason: 'approval_not_found',
        });
      }
      if (approval.organization_id !== action.organization_id
        || approval.mission_id !== missionId
        || approval.attempt_id !== attemptId
        || approval.worker_type !== worker
        || approval.payload_hash !== payloadHash) {
        stages.approval = 'invalid';
        return this.persist(action, hash, {
          decision: 'DENY',
          ok: false,
          provider_call: 'blocked',
          real_codex_calls: 0,
          real_cursor_calls: 0,
          stages,
          worker_mapping: mapping,
          reason: 'approval_binding_mismatch',
        });
      }
      if (Date.parse(approval.expires_at) <= now) {
        stages.approval = 'expired';
        return this.persist(action, hash, {
          decision: 'DENY',
          ok: false,
          provider_call: 'blocked',
          real_codex_calls: 0,
          real_cursor_calls: 0,
          stages,
          worker_mapping: mapping,
          reason: 'approval_expired',
        });
      }
      if (approval.consumed_at) {
        stages.approval = 'consumed_replay';
        return this.persist(action, hash, {
          decision: 'DENY',
          ok: false,
          provider_call: 'blocked',
          real_codex_calls: 0,
          real_cursor_calls: 0,
          stages,
          worker_mapping: mapping,
          reason: 'approval_already_consumed',
        });
      }
      stages.approval = 'valid';
      await this.audit('jarvis.agent_start.approved', action, { approval_id: approval.approval_id });
    } else {
      stages.approval = 'valid';
    }

    // Quota — independent per worker; UNKNOWN fail-closed
    const quota = this.quotas.get(worker) ?? 'unknown';
    stages.quota = quota;
    await this.audit('jarvis.agent_start.quota_checked', action, { quota_state: quota, worker_type: worker });
    if (quota === 'exhausted') {
      return this.persist(action, hash, {
        decision: 'QUOTA_EXCEEDED',
        ok: false,
        provider_call: 'blocked',
        real_codex_calls: 0,
        real_cursor_calls: 0,
        stages,
        worker_mapping: mapping,
        reason: 'quota_exhausted',
      });
    }
    if (quota === 'unknown') {
      return this.persist(action, hash, {
        decision: 'DENY',
        ok: false,
        provider_call: 'blocked',
        real_codex_calls: 0,
        real_cursor_calls: 0,
        stages,
        worker_mapping: mapping,
        reason: 'quota_unknown_fail_closed',
      });
    }

    // Budget reservation
    if (budgetCeiling < 1) {
      stages.budget = 'denied';
      return this.persist(action, hash, {
        decision: 'BUDGET_EXCEEDED',
        ok: false,
        provider_call: 'blocked',
        real_codex_calls: 0,
        real_cursor_calls: 0,
        stages,
        worker_mapping: mapping,
        reason: 'budget_denied',
      });
    }
    const budgetId = randomUUID();
    this.budgets.set(budgetId, {
      id: budgetId,
      status: 'reserved',
      organization_id: action.organization_id,
      mission_id: missionId,
      attempt_id: attemptId,
      worker_type: worker,
      request_id: action.request_id,
      budget_ceiling: budgetCeiling,
    });
    stages.budget = 'reserved';
    await this.audit('jarvis.agent_start.budget_reserved', action, { budget_reservation_id: budgetId });

    // Fencing
    if (!fencingToken) {
      stages.fencing = 'missing';
      this.releaseBudget(budgetId);
      stages.budget = 'released';
      return this.persist(action, hash, {
        decision: 'INVALID_STATE',
        ok: false,
        provider_call: 'blocked',
        real_codex_calls: 0,
        real_cursor_calls: 0,
        stages,
        worker_mapping: mapping,
        budget_reservation_id: budgetId,
        reason: 'fencing_token_required',
      });
    }
    const fenceStore = this.options.mutations?.fences;
    if (fenceStore) {
      const previous = fenceStore.get(attemptId);
      if (previous !== undefined && fencingToken < previous) {
        stages.fencing = 'stale';
        this.releaseBudget(budgetId);
        stages.budget = 'released';
        await this.audit('jarvis.mutation.stale_fence', action, { fencing_token: fencingToken });
        return this.persist(action, hash, {
          decision: 'STALE_FENCE',
          ok: false,
          provider_call: 'blocked',
          real_codex_calls: 0,
          real_cursor_calls: 0,
          stages,
          worker_mapping: mapping,
          budget_reservation_id: budgetId,
          reason: 'stale_fencing_token',
        });
      }
      if (previous === undefined || fencingToken > previous) fenceStore.set(attemptId, fencingToken);
    }
    stages.fencing = 'ok';

    // Workspace binding
    if (workspaceId) {
      const ws = this.workspaces.get(workspaceId) ?? this.options.mutations?.workspaces.get(workspaceId);
      if (!ws) {
        stages.workspace = 'missing';
        this.releaseBudget(budgetId);
        stages.budget = 'released';
        return this.persist(action, hash, {
          decision: 'DENY',
          ok: false,
          provider_call: 'blocked',
          real_codex_calls: 0,
          real_cursor_calls: 0,
          stages,
          worker_mapping: mapping,
          budget_reservation_id: budgetId,
          reason: 'workspace_not_found',
        });
      }
      const orgOk = 'organization_id' in ws && ws.organization_id === action.organization_id;
      const missionOk = ws.mission_id === missionId;
      const attemptOk = ws.attempt_id === attemptId;
      if (!orgOk || !missionOk || !attemptOk) {
        stages.workspace = 'mismatch';
        this.releaseBudget(budgetId);
        stages.budget = 'released';
        return this.persist(action, hash, {
          decision: 'DENY',
          ok: false,
          provider_call: 'blocked',
          real_codex_calls: 0,
          real_cursor_calls: 0,
          stages,
          worker_mapping: mapping,
          budget_reservation_id: budgetId,
          reason: 'workspace_binding_mismatch',
        });
      }
      stages.workspace = 'ok';
    } else {
      stages.workspace = 'missing';
      this.releaseBudget(budgetId);
      stages.budget = 'released';
      return this.persist(action, hash, {
        decision: 'INVALID_STATE',
        ok: false,
        provider_call: 'blocked',
        real_codex_calls: 0,
        real_cursor_calls: 0,
        stages,
        worker_mapping: mapping,
        budget_reservation_id: budgetId,
        reason: 'workspace_binding_required',
      });
    }

    // Lease — one writer per attempt
    if (this.activeLeaseByAttempt.has(attemptId)) {
      stages.lease = 'conflict';
      this.releaseBudget(budgetId);
      stages.budget = 'released';
      return this.persist(action, hash, {
        decision: 'LEASE_CONFLICT',
        ok: false,
        provider_call: 'blocked',
        real_codex_calls: 0,
        real_cursor_calls: 0,
        stages,
        worker_mapping: mapping,
        budget_reservation_id: budgetId,
        reason: 'lease_already_active',
      });
    }
    const leaseId = randomUUID();
    this.leases.set(leaseId, {
      id: leaseId,
      status: 'leased',
      organization_id: action.organization_id,
      mission_id: missionId,
      attempt_id: attemptId,
      worker_type: worker,
      workspace_id: workspaceId,
      fencing_token: fencingToken,
    });
    this.activeLeaseByAttempt.set(attemptId, leaseId);
    stages.lease = 'acquired';
    await this.audit('jarvis.agent_start.lease_acquired', action, { lease_id: leaseId });

    stages.scheduler = 'authorized';

    // Provider gate
    if (!flags.agentExecutionEnabled) {
      // Release lease/budget — no provider side effect for Stage B
      this.releaseLease(leaseId);
      this.releaseBudget(budgetId);
      stages.lease = 'none';
      stages.budget = 'released';
      stages.scheduler = 'authorized';
      return this.persist(action, hash, {
        decision: 'BLOCKED_BY_FEATURE_FLAG',
        ok: false,
        provider_call: 'blocked',
        real_codex_calls: 0,
        real_cursor_calls: 0,
        stages: { ...stages, lease: 'acquired' }, // prove lease path was authorized before provider block
        worker_mapping: mapping,
        approval_id: approvalId || undefined,
        lease_id: leaseId,
        budget_reservation_id: budgetId,
        reason: 'AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED=0',
        completion_confidence: 'INSUFFICIENT',
      });
    }

    // Both flags ON — still require allowProviderInvoke for actual call (canary gate)
    if (!this.options.allowProviderInvoke) {
      this.releaseLease(leaseId);
      this.releaseBudget(budgetId);
      await this.audit('jarvis.agent_start.provider_requested', action, {
        blocked: true,
        reason: 'provider_invoke_not_armed',
      });
      return this.persist(action, hash, {
        decision: 'BLOCKED_BY_FEATURE_FLAG',
        ok: false,
        provider_call: 'authorized_but_not_invoked',
        real_codex_calls: 0,
        real_cursor_calls: 0,
        stages,
        worker_mapping: mapping,
        approval_id: approvalId || undefined,
        lease_id: leaseId,
        budget_reservation_id: budgetId,
        reason: 'provider_invoke_not_armed_awaiting_nadir_canary',
        completion_confidence: 'INSUFFICIENT',
      });
    }

    if (worker !== 'codex') {
      this.releaseLease(leaseId);
      this.releaseBudget(budgetId);
      return this.persist(action, hash, {
        decision: 'DENY',
        ok: false,
        provider_call: 'blocked',
        real_codex_calls: 0,
        real_cursor_calls: 0,
        stages,
        worker_mapping: mapping,
        reason: 'canary_codex_only',
        completion_confidence: 'INSUFFICIENT',
      });
    }

    if (!this.options.invokeProvider) {
      this.releaseLease(leaseId);
      this.releaseBudget(budgetId);
      return this.persist(action, hash, {
        decision: 'DENY',
        ok: false,
        provider_call: 'blocked',
        real_codex_calls: 0,
        real_cursor_calls: 0,
        stages,
        worker_mapping: mapping,
        reason: 'provider_invoke_hook_missing',
        completion_confidence: 'INSUFFICIENT',
      });
    }

    const prompt = typeof action.parameters.canary_prompt === 'string'
      ? action.parameters.canary_prompt
      : 'Jarvis V1.2 canary: fix src/increment.js so increment(n) returns n+1. Modify ONLY that file.';

    if (approvalId) {
      const approval = this.approvals.get(approvalId);
      if (approval) approval.consumed_at = new Date(now).toISOString();
    }
    await this.audit('jarvis.agent_start.provider_requested', action, {
      lease_id: leaseId,
      budget_reservation_id: budgetId,
      superset_agent_id: mapping.superset_agent_id,
    });

    try {
      const providerResult = await this.options.invokeProvider({
        workspace_id: workspaceId,
        mission_id: missionId,
        attempt_id: attemptId,
        fencing_token: fencingToken,
        prompt,
        request_id: action.request_id,
        superset_agent_id: mapping.superset_agent_id,
      });
      await this.audit('jarvis.agent_start.running', action, {
        agent_id: providerResult.agent_id ?? null,
      });
      return this.persist(action, hash, {
        decision: 'ALLOW',
        ok: true,
        provider_call: 'invoked',
        real_codex_calls: 1,
        real_cursor_calls: 0,
        stages,
        worker_mapping: mapping,
        approval_id: approvalId || undefined,
        lease_id: leaseId,
        budget_reservation_id: budgetId,
        reason: 'provider_invoked_controlled_canary',
        completion_confidence: 'INSUFFICIENT',
      });
    } catch (error) {
      this.releaseLease(leaseId);
      this.releaseBudget(budgetId);
      const code = error instanceof Error ? error.message.slice(0, 100) : 'provider_invoke_failed';
      // Authoritative negative quota signals only — never store raw secret payloads.
      try {
        const { parseNegativeProviderSignal, buildNegativeQuotaObservationWrite, persistNegativeQuotaObservation } =
          await import('./agent-quota.js');
        const signal = parseNegativeProviderSignal(code);
        if (signal) {
          this.quotas.set(worker, signal.quota_state);
          if (this.options.pool) {
            const write = buildNegativeQuotaObservationWrite(worker, signal);
            await persistNegativeQuotaObservation(this.options.pool, write);
          }
        }
      } catch {
        // observation persist is best-effort; fail-closed decision below still applies
      }
      await this.audit('jarvis.agent_start.failed', action, { error_code: code });
      return this.persist(action, hash, {
        decision: 'DENY',
        ok: false,
        provider_call: 'blocked',
        real_codex_calls: 0,
        real_cursor_calls: 0,
        stages,
        worker_mapping: mapping,
        approval_id: approvalId || undefined,
        lease_id: leaseId,
        budget_reservation_id: budgetId,
        reason: code,
        completion_confidence: 'INSUFFICIENT',
      });
    }
  }

  private releaseBudget(id: string): void {
    const b = this.budgets.get(id);
    if (b && (b.status === 'reserved' || b.status === 'requested')) b.status = 'released';
  }

  private releaseLease(id: string): void {
    const lease = this.leases.get(id);
    if (!lease) return;
    if (lease.status === 'leased' || lease.status === 'reserved') {
      lease.status = 'released';
      this.activeLeaseByAttempt.delete(lease.attempt_id);
    }
  }

  private emptyStages(flags: JarvisPolicyFlags): AgentStartResult['stages'] {
    return {
      typed_action: false,
      policy_evaluated: false,
      approval: 'required',
      quota: 'skipped',
      budget: 'none',
      attempt: 'missing',
      lease: 'skipped',
      fencing: 'skipped',
      workspace: 'skipped',
      scheduler: 'blocked',
      feature_flags: {
        v2_execution: flags.businessExecutionEnabled,
        superset_agent_execution: flags.agentExecutionEnabled,
        publisher: flags.publisherEnabled,
      },
    };
  }

  private async denied(
    action: JarvisAction,
    flags: JarvisPolicyFlags,
    decision: AgentStartDecision,
    reason: string,
  ): Promise<AgentStartResult> {
    const stages = this.emptyStages(flags);
    stages.policy_evaluated = true;
    stages.scheduler = 'blocked';
    return {
      decision,
      ok: false,
      provider_call: 'blocked',
      real_codex_calls: 0,
      real_cursor_calls: 0,
      stages,
      worker_mapping: { requested_worker_type: 'codex', superset_agent_id: 'codex' },
      reason,
    };
  }

  private async finish(result: AgentStartResult, action: JarvisAction): Promise<AgentStartResult> {
    await this.audit('jarvis.agent_start.failed', action, { decision: result.decision, reason: result.reason });
    return result;
  }

  private persist(action: JarvisAction, hash: string, result: AgentStartResult): AgentStartResult {
    this.idempotency.set(action.request_id, { hash, result });
    return result;
  }

  private async audit(eventType: string, action: JarvisAction, details: Record<string, unknown>): Promise<void> {
    if (!this.options.audit) return;
    await this.options.audit.append({
      request_id: action.request_id,
      event_type: eventType as never,
      actor: action.actor,
      organization_id: action.organization_id,
      action: action.action,
      mission_id: typeof action.parameters.mission_id === 'string' ? action.parameters.mission_id : action.mission_id,
      attempt_id: typeof action.parameters.attempt_id === 'string' ? action.parameters.attempt_id : action.attempt_id,
      decision: typeof details.decision === 'string' ? details.decision : undefined,
      details,
    });
  }
}

export function agentStartDecisionToPolicy(decision: AgentStartDecision): JarvisPolicyDecision {
  switch (decision) {
    case 'ALLOW':
    case 'DENY':
    case 'REQUIRE_APPROVAL':
    case 'BLOCKED_BY_FEATURE_FLAG':
    case 'CONFLICT':
    case 'STALE_FENCE':
      return decision;
    case 'QUOTA_EXCEEDED':
    case 'BUDGET_EXCEEDED':
    case 'CONCURRENCY_LIMIT':
    case 'LEASE_CONFLICT':
    case 'INVALID_STATE':
      return 'DENY';
    default:
      return 'DENY';
  }
}
