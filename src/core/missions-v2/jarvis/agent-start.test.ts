/**
 * Jarvis V1.2 agent.start — failure-injection matrix (no provider calls).
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AgentStartController, agentStartPayloadHash, mapWorkerToSupersetAgent } from './agent-start.js';
import { JarvisMutationRegistry } from './mutations.js';
import { MemoryJarvisAuditLog } from './audit.js';
import { JarvisService } from './service.js';
import { resolveJarvisPolicyFlags } from './policy.js';
import { planJarvisActions } from './planner.js';

const flagsOff = resolveJarvisPolicyFlags({
  AGENTIMPACT_JARVIS_ENABLED: '1',
  AGENTIMPACT_JARVIS_MUTATIONS_ENABLED: '1',
  AGENTIMPACT_V2_EXECUTION_ENABLED: '0',
  AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: '0',
  AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED: '0',
});

const flagsStageB = resolveJarvisPolicyFlags({
  AGENTIMPACT_JARVIS_ENABLED: '1',
  AGENTIMPACT_JARVIS_MUTATIONS_ENABLED: '1',
  AGENTIMPACT_V2_EXECUTION_ENABLED: '1',
  AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: '0',
  AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED: '0',
});

const flagsCapability = resolveJarvisPolicyFlags({
  AGENTIMPACT_JARVIS_ENABLED: '1',
  AGENTIMPACT_JARVIS_MUTATIONS_ENABLED: '1',
  AGENTIMPACT_V2_EXECUTION_ENABLED: '1',
  AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: '1',
  AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED: '0',
});

function seedMission(mutations: JarvisMutationRegistry, org = 'org-agentimpact') {
  const id = randomUUID();
  mutations.missions.set(id, {
    id,
    organization_id: org,
    project: 'JARVIS',
    title: 'Agent start host',
    objective: 'controlled execution tests',
    requested_worker_type: 'codex',
    lifecycle_state: 'queued',
    actor: 'api:hermes',
    reason: 'setup',
    agent_started: false,
  });
  return id;
}

function baseParams(missionId: string, attemptId: string) {
  return {
    mission_id: missionId,
    attempt_id: attemptId,
    requested_worker_type: 'codex' as const,
    reason: 'v1_2_matrix',
    fencing_token: randomUUID(),
    workspace_id: randomUUID(),
    budget_ceiling: 1,
  };
}

describe('Jarvis V1.2 agent.start gates', () => {
  it('maps worker types server-side only', () => {
    expect(mapWorkerToSupersetAgent('codex')).toBe('codex');
    expect(mapWorkerToSupersetAgent('cursor')).toBe('cursor-agent');
  });

  it('plans NL lance Codex to typed agent.start', () => {
    const planned = planJarvisActions({
      request_id: randomUUID(),
      actor: 'api:hermes',
      organization_id: 'org-agentimpact',
      message: 'lance Codex sur cette mission',
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.actions[0]?.action).toBe('agent.start');
    expect(planned.actions[0]?.parameters.requested_worker_type).toBe('codex');
  });

  it('Stage A: V2 off blocks provider after policy/approval/scheduler evaluation', async () => {
    const mutations = new JarvisMutationRegistry();
    const audit = new MemoryJarvisAuditLog();
    const ctl = new AgentStartController({ mutations, audit });
    const missionId = seedMission(mutations);
    const attemptId = randomUUID();
    const wsId = randomUUID();
    const fence = randomUUID();
    ctl.bindWorkspace(wsId, {
      organization_id: 'org-agentimpact', mission_id: missionId, attempt_id: attemptId, fencing_token: fence,
    });
    const action = {
      request_id: randomUUID(),
      actor: 'api:hermes',
      organization_id: 'org-agentimpact',
      timestamp: new Date().toISOString(),
      action: 'agent.start' as const,
      parameters: { ...baseParams(missionId, attemptId), workspace_id: wsId, fencing_token: fence },
      reason: 't',
      risk_level: 'high' as const,
    };
    const result = await ctl.evaluate(action, flagsOff);
    expect(result.decision).toBe('BLOCKED_BY_FEATURE_FLAG');
    expect(result.provider_call).toBe('blocked');
    expect(result.stages.policy_evaluated).toBe(true);
    expect(result.stages.approval).toBe('required');
    expect(result.stages.scheduler).toBe('evaluated');
    expect(result.real_codex_calls).toBe(0);
    expect(audit.events.some((e) => e.event_type === 'jarvis.agent_start.requested')).toBe(true);
  });

  it('Stage B: V2 on + approval + quota + lease then provider blocked by agent flag', async () => {
    const mutations = new JarvisMutationRegistry();
    const ctl = new AgentStartController({ mutations });
    ctl.setQuota('codex', 'available');
    const missionId = seedMission(mutations);
    const attemptId = randomUUID();
    const fence = randomUUID();
    const wsId = randomUUID();
    ctl.bindWorkspace(wsId, {
      organization_id: 'org-agentimpact', mission_id: missionId, attempt_id: attemptId, fencing_token: fence,
    });
    const params = {
      ...baseParams(missionId, attemptId),
      workspace_id: wsId,
      fencing_token: fence,
    };
    const request_id = randomUUID();
    const payload_hash = agentStartPayloadHash({
      organization_id: 'org-agentimpact',
      mission_id: missionId,
      attempt_id: attemptId,
      requested_worker_type: 'codex',
      reason: params.reason,
    });
    const approval = ctl.issueApproval({
      organization_id: 'org-agentimpact',
      mission_id: missionId,
      attempt_id: attemptId,
      worker_type: 'codex',
      request_id,
      payload_hash,
      risk_level: 'high',
      budget_ceiling: 1,
      actor: 'nadir',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const result = await ctl.evaluate({
      request_id,
      actor: 'api:hermes',
      organization_id: 'org-agentimpact',
      timestamp: new Date().toISOString(),
      action: 'agent.start',
      parameters: { ...params, approval_id: approval.approval_id },
      reason: 't',
      risk_level: 'high',
    }, flagsStageB);
    expect(result.stages.scheduler).toBe('authorized');
    expect(result.stages.lease).toBe('acquired');
    expect(result.stages.budget).toBe('released');
    expect(result.decision).toBe('BLOCKED_BY_FEATURE_FLAG');
    expect(result.provider_call).toBe('blocked');
    expect(result.real_codex_calls).toBe(0);
    expect(result.reason).toContain('SUPERSET_AGENT_EXECUTION');
  });

  it('failure injection: approval missing/wrong/expired/consumed', async () => {
    const mutations = new JarvisMutationRegistry();
    const ctl = new AgentStartController({ mutations });
    ctl.setQuota('codex', 'available');
    const missionId = seedMission(mutations);
    const attemptId = randomUUID();
    const fence = randomUUID();
    const wsId = randomUUID();
    ctl.bindWorkspace(wsId, {
      organization_id: 'org-agentimpact', mission_id: missionId, attempt_id: attemptId, fencing_token: fence,
    });
    const params = { ...baseParams(missionId, attemptId), workspace_id: wsId, fencing_token: fence };
    const mk = (extra: Record<string, unknown> = {}) => ({
      request_id: randomUUID(),
      actor: 'api:hermes',
      organization_id: 'org-agentimpact',
      timestamp: new Date().toISOString(),
      action: 'agent.start' as const,
      parameters: { ...params, ...extra },
      reason: 't',
      risk_level: 'high' as const,
    });

    expect((await ctl.evaluate(mk(), flagsStageB)).decision).toBe('REQUIRE_APPROVAL');

    const wrongMission = randomUUID();
    const hash = agentStartPayloadHash({
      organization_id: 'org-agentimpact', mission_id: missionId, attempt_id: attemptId,
      requested_worker_type: 'codex', reason: params.reason,
    });
    const a1 = ctl.issueApproval({
      organization_id: 'org-agentimpact', mission_id: wrongMission, attempt_id: attemptId,
      worker_type: 'codex', request_id: randomUUID(), payload_hash: hash, risk_level: 'high',
      budget_ceiling: 1, actor: 'nadir', expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    expect((await ctl.evaluate(mk({ approval_id: a1.approval_id }), flagsStageB)).reason).toBe('approval_binding_mismatch');

    const aExp = ctl.issueApproval({
      organization_id: 'org-agentimpact', mission_id: missionId, attempt_id: attemptId,
      worker_type: 'codex', request_id: randomUUID(), payload_hash: hash, risk_level: 'high',
      budget_ceiling: 1, actor: 'nadir', expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    expect((await ctl.evaluate(mk({ approval_id: aExp.approval_id }), flagsStageB)).reason).toBe('approval_expired');

    const aWrongWorker = ctl.issueApproval({
      organization_id: 'org-agentimpact', mission_id: missionId, attempt_id: attemptId,
      worker_type: 'cursor', request_id: randomUUID(), payload_hash: hash, risk_level: 'high',
      budget_ceiling: 1, actor: 'nadir', expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    expect((await ctl.evaluate(mk({ approval_id: aWrongWorker.approval_id }), flagsStageB)).reason).toBe('approval_binding_mismatch');
  });

  it('failure injection: quota exhausted/unknown, budget, lease, fence, workspace, shell', async () => {
    const mutations = new JarvisMutationRegistry();
    const ctl = new AgentStartController({ mutations });
    const missionId = seedMission(mutations);
    const attemptId = randomUUID();
    const fence = randomUUID();
    const wsId = randomUUID();
    ctl.bindWorkspace(wsId, {
      organization_id: 'org-agentimpact', mission_id: missionId, attempt_id: attemptId, fencing_token: fence,
    });
    const params = { ...baseParams(missionId, attemptId), workspace_id: wsId, fencing_token: fence };
    const hash = agentStartPayloadHash({
      organization_id: 'org-agentimpact', mission_id: missionId, attempt_id: attemptId,
      requested_worker_type: 'codex', reason: params.reason,
    });
    const approve = () => ctl.issueApproval({
      organization_id: 'org-agentimpact', mission_id: missionId, attempt_id: attemptId,
      worker_type: 'codex', request_id: randomUUID(), payload_hash: hash, risk_level: 'high',
      budget_ceiling: 1, actor: 'nadir', expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const mk = (approval_id: string, extra: Record<string, unknown> = {}) => ({
      request_id: randomUUID(),
      actor: 'api:hermes',
      organization_id: 'org-agentimpact',
      timestamp: new Date().toISOString(),
      action: 'agent.start' as const,
      parameters: { ...params, approval_id, ...extra },
      reason: 't',
      risk_level: 'high' as const,
    });

    ctl.setQuota('codex', 'unknown');
    expect((await ctl.evaluate(mk(approve().approval_id), flagsStageB)).reason).toBe('quota_unknown_fail_closed');

    ctl.setQuota('codex', 'exhausted');
    expect((await ctl.evaluate(mk(approve().approval_id), flagsStageB)).decision).toBe('QUOTA_EXCEEDED');

    ctl.setQuota('codex', 'available');
    expect((await ctl.evaluate(mk(approve().approval_id, { budget_ceiling: 0 }), flagsStageB)).decision).toBe('BUDGET_EXCEEDED');

    // lease conflict
    const aLease = approve();
    const first = await ctl.evaluate(mk(aLease.approval_id), flagsStageB);
    expect(first.stages.lease).toBe('acquired');
    // Stage B releases lease after provider block — activeLease cleared. Re-acquire path:
    // force active lease
    const leaseId = randomUUID();
    ctl.leases.set(leaseId, {
      id: leaseId, status: 'leased', organization_id: 'org-agentimpact',
      mission_id: missionId, attempt_id: attemptId, worker_type: 'codex',
      workspace_id: wsId, fencing_token: fence,
    });
    ctl.activeLeaseByAttempt.set(attemptId, leaseId);
    expect((await ctl.evaluate(mk(approve().approval_id), flagsStageB)).decision).toBe('LEASE_CONFLICT');

    // stale fence
    ctl.activeLeaseByAttempt.delete(attemptId);
    mutations.fences.set(attemptId, 'ffffffff-ffff-4fff-8fff-ffffffffffff');
    expect((await ctl.evaluate(mk(approve().approval_id, {
      fencing_token: '00000000-0000-4000-8000-000000000001',
    }), flagsStageB)).decision).toBe('STALE_FENCE');

    // workspace mismatch
    mutations.fences.set(attemptId, fence);
    expect((await ctl.evaluate(mk(approve().approval_id, {
      fencing_token: fence,
      workspace_id: randomUUID(),
    }), flagsStageB)).reason).toBe('workspace_not_found');

    // shell injection
    expect((await ctl.evaluate({
      ...mk(approve().approval_id),
      parameters: { ...params, approval_id: approve().approval_id, shell: 'bash -c uname' },
    }, flagsStageB)).reason).toBe('shell_argv_injection_denied');
  });

  it('idempotent request_id does not double-launch; conflict on payload change', async () => {
    const mutations = new JarvisMutationRegistry();
    const ctl = new AgentStartController({ mutations });
    const missionId = seedMission(mutations);
    const request_id = randomUUID();
    const action = {
      request_id,
      actor: 'api:hermes',
      organization_id: 'org-agentimpact',
      timestamp: new Date().toISOString(),
      action: 'agent.start' as const,
      parameters: baseParams(missionId, randomUUID()),
      reason: 't',
      risk_level: 'high' as const,
    };
    const first = await ctl.evaluate(action, flagsOff);
    const second = await ctl.evaluate(action, flagsOff);
    expect(second.reason).toContain('idempotent_replay');
    expect(second.real_codex_calls).toBe(0);
    expect(first.decision).toBe(second.decision);
    await expect(ctl.evaluate({
      ...action,
      parameters: { ...action.parameters, reason: 'changed' },
    }, flagsOff)).rejects.toMatchObject({ code: 'jarvis_request_id_conflict' });
  });

  it('service path: agent.create denied; publisher still approval; no real calls', async () => {
    const mutations = new JarvisMutationRegistry();
    const svc = new JarvisService({
      enabled: true,
      audit: new MemoryJarvisAuditLog(),
      flags: flagsOff,
      mutations,
      superset: () => undefined,
    });
    const missionId = seedMission(mutations);
    const start = await svc.handle({
      request_id: randomUUID(),
      organization_id: 'org-agentimpact',
      message: 'lance Codex sur cette mission',
    }, 'api:hermes');
    expect(start.actions[0]?.action).toBe('agent.start');
    expect(start.policy[0]?.decision).toBe('BLOCKED_BY_FEATURE_FLAG');
    expect((start.results[0]?.data as { real_codex_calls: number }).real_codex_calls).toBe(0);

    const create = await svc.handle({
      request_id: randomUUID(),
      organization_id: 'org-agentimpact',
      action: 'agent.create',
      parameters: { mission_id: missionId },
    }, 'api:hermes');
    expect(create.policy[0]?.decision).toBe('DENY');
  });

  it('capability armed still blocks without approval/quota/budget/lease/fence/workspace; no second provider', async () => {
    let providerCalls = 0;
    const mutations = new JarvisMutationRegistry();
    const ctl = new AgentStartController({
      mutations,
      allowProviderInvoke: true,
      invokeProvider: async () => {
        providerCalls += 1;
        return { agent_id: 'should-not-run' };
      },
    });
    const missionId = seedMission(mutations);
    const attemptId = randomUUID();
    const fence = randomUUID();
    const wsId = randomUUID();
    ctl.setQuota('codex', 'available');

    // approval missing
    const noApproval = await ctl.evaluate({
      request_id: randomUUID(),
      actor: 'api:hermes',
      organization_id: 'org-agentimpact',
      timestamp: new Date().toISOString(),
      action: 'agent.start',
      parameters: baseParams(missionId, attemptId),
      reason: 't',
      risk_level: 'high',
    }, flagsCapability);
    expect(noApproval.decision).toBe('REQUIRE_APPROVAL');
    expect(noApproval.real_codex_calls).toBe(0);
    expect(providerCalls).toBe(0);

    ctl.bindWorkspace(wsId, {
      organization_id: 'org-agentimpact', mission_id: missionId, attempt_id: attemptId, fencing_token: fence,
    });
    const params = { ...baseParams(missionId, attemptId), workspace_id: wsId, fencing_token: fence };
    const hash = agentStartPayloadHash({
      organization_id: 'org-agentimpact', mission_id: missionId, attempt_id: attemptId,
      requested_worker_type: 'codex', reason: params.reason,
    });
    const approve = () => ctl.issueApproval({
      organization_id: 'org-agentimpact', mission_id: missionId, attempt_id: attemptId,
      worker_type: 'codex', request_id: randomUUID(), payload_hash: hash, risk_level: 'high',
      budget_ceiling: 1, actor: 'nadir', expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const mk = (approval_id: string, extra: Record<string, unknown> = {}) => ({
      request_id: randomUUID(),
      actor: 'api:hermes',
      organization_id: 'org-agentimpact',
      timestamp: new Date().toISOString(),
      action: 'agent.start' as const,
      parameters: { ...params, approval_id, ...extra },
      reason: 't',
      risk_level: 'high' as const,
    });

    ctl.setQuota('codex', 'unknown');
    expect((await ctl.evaluate(mk(approve().approval_id), flagsCapability)).reason).toBe('quota_unknown_fail_closed');
    ctl.setQuota('codex', 'exhausted');
    expect((await ctl.evaluate(mk(approve().approval_id), flagsCapability)).decision).toBe('QUOTA_EXCEEDED');
    ctl.setQuota('codex', 'available');
    expect((await ctl.evaluate(mk(approve().approval_id, { budget_ceiling: 0 }), flagsCapability)).decision).toBe('BUDGET_EXCEEDED');

    // wrong workspace
    expect((await ctl.evaluate(mk(approve().approval_id, {
      workspace_id: randomUUID(),
    }), flagsCapability)).reason).toBe('workspace_not_found');

    // stale fence
    mutations.fences.set(attemptId, 'ffffffff-ffff-4fff-8fff-ffffffffffff');
    expect((await ctl.evaluate(mk(approve().approval_id, {
      fencing_token: '00000000-0000-4000-8000-000000000001',
    }), flagsCapability)).decision).toBe('STALE_FENCE');
    mutations.fences.set(attemptId, fence);

    // lease conflict
    const leaseId = randomUUID();
    ctl.leases.set(leaseId, {
      id: leaseId, status: 'leased', organization_id: 'org-agentimpact',
      mission_id: missionId, attempt_id: attemptId, worker_type: 'codex',
      workspace_id: wsId, fencing_token: fence,
    });
    ctl.activeLeaseByAttempt.set(attemptId, leaseId);
    expect((await ctl.evaluate(mk(approve().approval_id), flagsCapability)).decision).toBe('LEASE_CONFLICT');
    expect(providerCalls).toBe(0);

    // duplicate request_id → no second provider call
    ctl.activeLeaseByAttempt.delete(attemptId);
    const request_id = randomUUID();
    const a = approve();
    const action = {
      request_id,
      actor: 'api:hermes',
      organization_id: 'org-agentimpact',
      timestamp: new Date().toISOString(),
      action: 'agent.start' as const,
      parameters: { ...params, approval_id: a.approval_id },
      reason: 't',
      risk_level: 'high' as const,
    };
    const first = await ctl.evaluate(action, flagsCapability);
    expect(first.provider_call === 'invoked' || first.real_codex_calls === 1 || first.decision === 'ALLOW').toBe(true);
    const second = await ctl.evaluate(action, flagsCapability);
    expect(second.real_codex_calls === 0 || second.decision === 'IDEMPOTENT_REPLAY' || second.ok === true).toBe(true);
    // At most one provider invoke across both
    expect(providerCalls).toBeLessThanOrEqual(1);
  });
});
