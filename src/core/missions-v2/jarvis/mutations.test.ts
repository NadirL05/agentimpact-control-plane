import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { JarvisService } from './service.js';
import { resolveJarvisPolicyFlags, evaluateJarvisPolicy } from './policy.js';
import { MemoryJarvisAuditLog } from './audit.js';
import { JarvisMutationRegistry } from './mutations.js';
import type { JarvisAction } from './contract.js';

const flagsOn = resolveJarvisPolicyFlags({
  AGENTIMPACT_JARVIS_ENABLED: '1',
  AGENTIMPACT_JARVIS_MUTATIONS_ENABLED: '1',
  AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: '0',
  AGENTIMPACT_V2_EXECUTION_ENABLED: '0',
  AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED: '0',
});

function service(mutations = new JarvisMutationRegistry()) {
  return new JarvisService({
    enabled: true,
    audit: new MemoryJarvisAuditLog(),
    flags: flagsOn,
    mutations,
    superset: () => undefined,
  });
}

function typed(action: string, parameters: Record<string, unknown>) {
  return {
    request_id: randomUUID(),
    organization_id: 'org-agentimpact',
    action,
    parameters,
  };
}

describe('Jarvis V1.1 safe mutations', () => {
  it('mission.create does not start agents', async () => {
    const svc = service();
    const response = await svc.handle(typed('mission.create', {
      title: 'Fix PLU tests',
      objective: 'bounded mission record only',
      project: 'PLUIA',
      requested_worker_type: 'codex',
      reason: 'jarvis_v1_1_smoke',
    }), 'api:hermes');
    expect(response.policy[0]?.decision).toBe('ALLOW');
    expect(response.results[0]?.ok).toBe(true);
    expect(response.results[0]?.data).toMatchObject({
      MISSION_CREATED: true,
      AGENT_STARTED: false,
      publisher: 'off',
    });
  });

  it('mission.create is idempotent and conflicts on payload change', async () => {
    const svc = service();
    const request_id = randomUUID();
    const body = {
      request_id,
      organization_id: 'org-agentimpact',
      action: 'mission.create',
      parameters: {
        title: 'Same mission',
        objective: 'idempotent create',
        project: 'PLUIA',
        requested_worker_type: 'cursor',
        reason: 'idem',
      },
    };
    const first = await svc.handle(body, 'api:hermes');
    const second = await svc.handle(body, 'api:hermes');
    expect(second.results[0]?.data).toEqual(first.results[0]?.data);
    await expect(svc.handle({
      ...body,
      parameters: { ...body.parameters, title: 'Different titlexx' },
    }, 'api:hermes')).rejects.toMatchObject({ code: 'jarvis_request_id_conflict' });
  });

  it('mission.cancel is org-scoped and idempotent', async () => {
    const mutations = new JarvisMutationRegistry();
    const svc = service(mutations);
    const created = await svc.handle(typed('mission.create', {
      title: 'Cancel me please',
      objective: 'will cancel',
      project: 'PLUIA',
      requested_worker_type: 'codex',
      reason: 'setup',
    }), 'api:hermes');
    const missionId = (created.results[0]?.data as { mission_id: string }).mission_id;
    const cancelBody = typed('mission.cancel', { mission_id: missionId, reason: 'done' });
    const first = await svc.handle(cancelBody, 'api:hermes');
    expect(first.results[0]?.ok).toBe(true);
    const second = await svc.handle({
      ...cancelBody,
      request_id: randomUUID(),
    }, 'api:hermes');
    expect(second.results[0]?.ok).toBe(true);
    const cross = await svc.handle({
      request_id: randomUUID(),
      organization_id: 'org-other',
      action: 'mission.cancel',
      parameters: { mission_id: missionId, reason: 'theft' },
    }, 'api:hermes');
    expect(cross.results[0]?.ok).toBe(false);
    expect(cross.results[0]?.error_code).toBe('mission_not_found');
  });

  it('workspace create/delete enforce fence and binding', async () => {
    const mutations = new JarvisMutationRegistry();
    const svc = service(mutations);
    const created = await svc.handle(typed('mission.create', {
      title: 'Workspace host',
      objective: 'workspace fencing',
      project: 'PLUIA',
      requested_worker_type: 'codex',
      reason: 'setup',
    }), 'api:hermes');
    const missionId = (created.results[0]?.data as { mission_id: string }).mission_id;
    const attemptId = randomUUID();
    const oldTok = '00000000-0000-4000-8000-000000000001';
    const newTok = '00000000-0000-4000-8000-000000000002';
    const ws = await svc.handle(typed('workspace.create', {
      mission_id: missionId,
      attempt_id: attemptId,
      fencing_token: oldTok,
      project_id: randomUUID(),
      name: 'ws-safe-1',
      branch: 'jarvis/safe',
    }), 'api:hermes');
    expect(ws.results[0]?.ok).toBe(true);
    const workspaceId = (ws.results[0]?.data as { workspace: { id: string } }).workspace.id;

    const stale = await svc.handle(typed('workspace.create', {
      mission_id: missionId,
      attempt_id: attemptId,
      fencing_token: oldTok,
      project_id: randomUUID(),
      name: 'ws-safe-2',
      branch: 'jarvis/safe2',
    }), 'api:hermes');
    // same token after fence observed is ok if token not less; bump then stale
    await svc.handle(typed('workspace.create', {
      mission_id: missionId,
      attempt_id: attemptId,
      fencing_token: newTok,
      project_id: randomUUID(),
      name: 'ws-safe-3',
      branch: 'jarvis/safe3',
    }), 'api:hermes');
    const staleAfter = await svc.handle(typed('workspace.delete', {
      workspace_id: workspaceId,
      mission_id: missionId,
      attempt_id: attemptId,
      fencing_token: oldTok,
      reason: 'cleanup',
    }), 'api:hermes');
    expect(staleAfter.results[0]?.decision).toBe('STALE_FENCE');

    const wrongBind = await svc.handle(typed('workspace.delete', {
      workspace_id: workspaceId,
      mission_id: randomUUID(),
      attempt_id: attemptId,
      fencing_token: newTok,
      reason: 'cleanup',
    }), 'api:hermes');
    expect(wrongBind.results[0]?.ok).toBe(false);

    const blocked = mutations.workspaces.get(workspaceId)!;
    blocked.unsafe_active_process = true;
    const unsafe = await svc.handle(typed('workspace.delete', {
      workspace_id: workspaceId,
      mission_id: missionId,
      attempt_id: attemptId,
      fencing_token: newTok,
      reason: 'cleanup',
    }), 'api:hermes');
    expect(unsafe.results[0]?.error_code).toBe('workspace_active_unsafe_process');
    blocked.unsafe_active_process = false;

    const deleted = await svc.handle(typed('workspace.delete', {
      workspace_id: workspaceId,
      mission_id: missionId,
      attempt_id: attemptId,
      fencing_token: newTok,
      reason: 'cleanup',
    }), 'api:hermes');
    expect(deleted.results[0]?.ok).toBe(true);
  });

  it('tests.run accepts profiles only and denies command-shaped params', async () => {
    const mutations = new JarvisMutationRegistry();
    const svc = service(mutations);
    const created = await svc.handle(typed('mission.create', {
      title: 'Test profile host',
      objective: 'run fixed profile',
      project: 'PLUIA',
      requested_worker_type: 'codex',
      reason: 'setup',
    }), 'api:hermes');
    const missionId = (created.results[0]?.data as { mission_id: string }).mission_id;
    const ok = await svc.handle(typed('tests.run', {
      mission_id: missionId,
      attempt_id: randomUUID(),
      fencing_token: randomUUID(),
      test_profile: 'unit',
    }), 'api:hermes');
    expect(ok.results[0]?.ok).toBe(true);
    expect(ok.results[0]?.data).toMatchObject({ profile: 'unit', status: 'passed' });

    const denied = await svc.handle(typed('tests.run', {
      mission_id: missionId,
      attempt_id: randomUUID(),
      fencing_token: randomUUID(),
      test_profile: 'unit',
      command: 'npm test',
    }), 'api:hermes');
    expect(denied.results[0]?.ok).toBe(false);
    expect(denied.results[0]?.error_code).toBe('arbitrary_test_command_denied');
  });

  it('agent.stop is idempotent and rejects arbitrary pid', async () => {
    const mutations = new JarvisMutationRegistry();
    const svc = service(mutations);
    const created = await svc.handle(typed('mission.create', {
      title: 'Stop agent host',
      objective: 'bounded stop',
      project: 'PLUIA',
      requested_worker_type: 'codex',
      reason: 'setup',
    }), 'api:hermes');
    const missionId = (created.results[0]?.data as { mission_id: string }).mission_id;
    const attemptId = randomUUID();
    const fence = randomUUID();
    const first = await svc.handle(typed('agent.stop', {
      mission_id: missionId, attempt_id: attemptId, fencing_token: fence, reason: 'stop',
    }), 'api:hermes');
    expect(first.results[0]?.data).toMatchObject({ status: 'stopped' });
    const second = await svc.handle(typed('agent.stop', {
      mission_id: missionId, attempt_id: attemptId, fencing_token: fence, reason: 'stop again',
    }), 'api:hermes');
    expect(second.results[0]?.data).toMatchObject({ status: 'already_stopped' });

    const pid = await svc.handle(typed('agent.stop', {
      mission_id: missionId, attempt_id: randomUUID(), fencing_token: randomUUID(), reason: 'stop', pid: 1,
    }), 'api:hermes');
    expect(pid.results[0]?.error_code).toBe('arbitrary_pid_denied');
  });

  it('keeps agent.create denied, agent.start deferred, approvals for publisher/deploy', () => {
    const base: JarvisAction = {
      request_id: randomUUID(),
      actor: 'api:hermes',
      organization_id: 'org',
      timestamp: new Date().toISOString(),
      action: 'agent.start',
      parameters: {},
      reason: 't',
      risk_level: 'high',
    };
    expect(evaluateJarvisPolicy({ ...base, action: 'agent.start' }, flagsOn).decision).toBe('ALLOW');
    expect(evaluateJarvisPolicy({ ...base, action: 'agent.create' }, flagsOn).decision).toBe('DENY');
    expect(evaluateJarvisPolicy({ ...base, action: 'publisher.push' }, flagsOn).decision).toBe('REQUIRE_APPROVAL');
    expect(evaluateJarvisPolicy({ ...base, action: 'deploy' }, flagsOn).decision).toBe('REQUIRE_APPROVAL');
    expect(evaluateJarvisPolicy({ ...base, action: 'generic.shell' }, flagsOn).decision).toBe('DENY');
    expect(evaluateJarvisPolicy({ ...base, action: 'agent.stop' }, flagsOn).decision).toBe('ALLOW');
  });
});
