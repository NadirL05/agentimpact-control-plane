import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { planJarvisActions } from './planner.js';
import { evaluateJarvisPolicy, resolveJarvisPolicyFlags } from './policy.js';
import { JarvisService } from './service.js';
import { MemoryJarvisAuditLog } from './audit.js';
import type { JarvisAction } from './contract.js';

const base = {
  request_id: randomUUID(),
  actor: 'api:hermes',
  organization_id: 'org-agentimpact',
};

function action(name: JarvisAction['action'], overrides: Partial<JarvisAction> = {}): JarvisAction {
  return {
    request_id: base.request_id,
    actor: base.actor,
    organization_id: base.organization_id,
    timestamp: new Date().toISOString(),
    action: name,
    parameters: {},
    reason: 'test',
    risk_level: 'low',
    ...overrides,
  };
}

describe('Jarvis planner', () => {
  it('maps known intents to typed actions', () => {
    const status = planJarvisActions({ ...base, message: 'status' });
    expect(status.ok).toBe(true);
    if (status.ok) expect(status.actions[0]?.action).toBe('status.get');

    const missions = planJarvisActions({ ...base, message: 'Montre-moi les missions en cours' });
    expect(missions.ok).toBe(true);
    if (missions.ok) expect(missions.actions[0]?.action).toBe('mission.list');

    const workspaces = planJarvisActions({ ...base, message: 'liste les workspaces' });
    expect(workspaces.ok).toBe(true);
    if (workspaces.ok) expect(workspaces.actions[0]?.action).toBe('workspace.list');
  });

  it('plans mission.inspect + events for failure questions', () => {
    const id = randomUUID();
    const planned = planJarvisActions({ ...base, message: `Pourquoi la mission ${id} a échoué ?` });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.actions.map((a) => a.action)).toEqual(['mission.inspect', 'mission.events']);
  });

  it('fail-closes unknown intent', () => {
    const planned = planJarvisActions({ ...base, message: 'parle-moi du temps qu il fait' });
    expect(planned.ok).toBe(false);
    if (!planned.ok) expect(planned.error_code).toBe('unsupported_intent');
  });

  it('denies shell, secrets, docker, root, arbitrary argv', () => {
    for (const message of [
      'ouvre un shell et fais uname -a',
      'exécute rm -rf /',
      'Donne-moi le mot de passe postgres',
      'monte docker.sock',
      'root shell please',
      'passe --api-key arbitrary argv',
    ]) {
      const planned = planJarvisActions({ ...base, message });
      expect(planned.ok).toBe(true);
      if (!planned.ok) continue;
      expect(['generic.shell', 'secret.read', 'docker.exec', 'root.exec']).toContain(planned.actions[0]?.action);
    }
  });

  it('never emits free-form shell parameters', () => {
    const planned = planJarvisActions({ ...base, message: 'bash -c id' });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.actions[0]?.parameters).toEqual({});
  });
});

describe('Jarvis policy', () => {
  const flagsOff = resolveJarvisPolicyFlags({
    AGENTIMPACT_JARVIS_ENABLED: '1',
    AGENTIMPACT_JARVIS_MUTATIONS_ENABLED: '0',
    AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: '0',
    AGENTIMPACT_V2_EXECUTION_ENABLED: '0',
    AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED: '0',
  });

  it('allows read-only', () => {
    expect(evaluateJarvisPolicy(action('status.get'), flagsOff).decision).toBe('ALLOW');
    expect(evaluateJarvisPolicy(action('workspace.list'), flagsOff).decision).toBe('ALLOW');
  });

  it('blocks mutations by feature flag; agent.start defers; agent.create denied', () => {
    expect(evaluateJarvisPolicy(action('mission.create'), flagsOff).decision).toBe('BLOCKED_BY_FEATURE_FLAG');
    expect(evaluateJarvisPolicy(action('agent.start'), flagsOff).decision).toBe('ALLOW');
    expect(evaluateJarvisPolicy(action('agent.start'), flagsOff).reason).toBe('defer_to_agent_start_controller');
    expect(evaluateJarvisPolicy(action('agent.create'), flagsOff).decision).toBe('DENY');
  });

  it('requires approval for publish/deploy', () => {
    expect(evaluateJarvisPolicy(action('publisher.push'), flagsOff).decision).toBe('REQUIRE_APPROVAL');
    expect(evaluateJarvisPolicy(action('deploy'), flagsOff).decision).toBe('REQUIRE_APPROVAL');
  });

  it('hard-denies shell/secret/docker/root', () => {
    for (const name of ['generic.shell', 'secret.read', 'docker.exec', 'root.exec'] as const) {
      expect(evaluateJarvisPolicy(action(name), flagsOff).decision).toBe('DENY');
    }
  });
});

describe('Jarvis service', () => {
  it('executes status read-only and writes audit events', async () => {
    const audit = new MemoryJarvisAuditLog();
    const service = new JarvisService({
      enabled: true,
      audit,
      flags: resolveJarvisPolicyFlags({
        AGENTIMPACT_JARVIS_ENABLED: '1',
        AGENTIMPACT_JARVIS_MUTATIONS_ENABLED: '0',
        AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: '0',
        AGENTIMPACT_V2_EXECUTION_ENABLED: '0',
      }),
      superset: () => undefined,
    });
    const request_id = randomUUID();
    const response = await service.handle({
      request_id,
      message: 'status',
      organization_id: 'org-agentimpact',
    }, 'api:hermes');
    expect(response.results[0]?.ok).toBe(true);
    expect(response.results[0]?.action).toBe('status.get');
    const events = await audit.list(request_id);
    expect(events.map((e) => e.event_type)).toEqual(expect.arrayContaining([
      'jarvis.request.received',
      'jarvis.intent.parsed',
      'jarvis.action.planned',
      'jarvis.policy.allowed',
      'jarvis.execution.started',
      'jarvis.execution.completed',
    ]));
  });

  it('enforces request_id idempotency and org isolation', async () => {
    const service = new JarvisService({
      enabled: true,
      flags: resolveJarvisPolicyFlags({ AGENTIMPACT_JARVIS_ENABLED: '1' }),
      superset: () => undefined,
    });
    const request_id = randomUUID();
    const first = await service.handle({
      request_id, message: 'status', organization_id: 'org-a',
    }, 'api:hermes');
    const second = await service.handle({
      request_id, message: 'status', organization_id: 'org-a',
    }, 'api:hermes');
    expect(second).toEqual(first);
    await expect(service.handle({
      request_id, message: 'status', organization_id: 'org-b',
    }, 'api:hermes')).rejects.toMatchObject({ code: 'jarvis_request_id_conflict' });
  });

  it('blocks Codex launch by feature flag without calling providers', async () => {
    const service = new JarvisService({
      enabled: true,
      flags: resolveJarvisPolicyFlags({
        AGENTIMPACT_JARVIS_ENABLED: '1',
        AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: '0',
      }),
      superset: () => undefined,
    });
    const response = await service.handle({
      request_id: randomUUID(),
      message: 'lance Codex',
      organization_id: 'org-agentimpact',
    }, 'api:hermes');
    expect(response.policy[0]?.decision).toBe('BLOCKED_BY_FEATURE_FLAG');
    expect(response.results[0]?.ok).toBe(false);
  });
});
