/**
 * Deterministic Jarvis policy — evaluated after planning, before execution.
 * V1.1: safe mutations AUTO when flag on; agent.stop allowed without provider execution.
 * V1.2: agent.start is NEVER unconditional AUTO — routed through AgentStartController.
 *        Coarse policy here only hard-denies agent.create and defers agent.start to controller.
 */
import {
  type JarvisAction,
  type JarvisActionName,
  type JarvisPolicyDecision,
  type JarvisPolicyResult,
  BLOCKED_ACTIONS,
  MUTATION_ACTIONS,
  READ_ONLY_ACTIONS,
  SAFE_MUTATION_ACTIONS,
} from './contract.js';

export type JarvisPolicyFlags = {
  jarvisEnabled: boolean;
  mutationsEnabled: boolean;
  agentExecutionEnabled: boolean;
  businessExecutionEnabled: boolean;
  publisherEnabled: boolean;
};

export function resolveJarvisPolicyFlags(env: NodeJS.ProcessEnv = process.env): JarvisPolicyFlags {
  return {
    jarvisEnabled: (env.AGENTIMPACT_JARVIS_ENABLED || '0').trim() === '1',
    mutationsEnabled: (env.AGENTIMPACT_JARVIS_MUTATIONS_ENABLED || '0').trim() === '1',
    agentExecutionEnabled: (env.AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED || '0').trim() === '1',
    businessExecutionEnabled: (env.AGENTIMPACT_V2_EXECUTION_ENABLED || '0').trim() === '1',
    publisherEnabled: (env.AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED || '0').trim() === '1',
  };
}

const APPROVAL_ACTIONS = new Set<JarvisActionName>([
  'publisher.push', 'publisher.pr_create', 'publisher.merge',
  'deploy', 'database.migrate', 'secret.write',
]);

const HARD_DENY = new Set<JarvisActionName>([
  'secret.read', 'root.exec', 'docker.exec', 'generic.shell',
]);

export function evaluateJarvisPolicy(
  action: JarvisAction,
  flags: JarvisPolicyFlags = resolveJarvisPolicyFlags(),
): JarvisPolicyResult {
  const name = action.action;

  if (HARD_DENY.has(name)) {
    return { action: name, decision: 'DENY', reason: `hard_deny:${name}` };
  }

  // agent.create remains permanently denied (not a safe mutation, not start).
  if (name === 'agent.create') {
    return {
      action: name,
      decision: 'DENY',
      reason: 'agent_create_permanently_denied',
    };
  }

  // agent.start: coarse gate only — full evaluation is AgentStartController.
  // Mark as ALLOW so the controller runs; controller returns the real decision.
  if (name === 'agent.start') {
    return {
      action: name,
      decision: 'ALLOW',
      reason: 'defer_to_agent_start_controller',
      approval: { required: true, reason: 'agent_start_default_approval', approver_roles: ['nadir', 'admin'] },
    };
  }

  if (APPROVAL_ACTIONS.has(name)) {
    return {
      action: name,
      decision: 'REQUIRE_APPROVAL',
      reason: flags.publisherEnabled && name.startsWith('publisher.')
        ? `approval_required:${name}`
        : (name.startsWith('publisher.') ? 'publisher_off_requires_approval' : `approval_required:${name}`),
      approval: { required: true, reason: name, approver_roles: ['nadir', 'admin'] },
    };
  }

  if (SAFE_MUTATION_ACTIONS.has(name) || MUTATION_ACTIONS.has(name)) {
    if (!flags.mutationsEnabled) {
      return {
        action: name,
        decision: 'BLOCKED_BY_FEATURE_FLAG',
        reason: 'AGENTIMPACT_JARVIS_MUTATIONS_ENABLED=0',
      };
    }
    if (name === 'terminal.send' && !SAFE_MUTATION_ACTIONS.has(name)) {
      return { action: name, decision: 'DENY', reason: 'terminal_send_not_in_v1_1_allowlist' };
    }
    if (!SAFE_MUTATION_ACTIONS.has(name)) {
      return { action: name, decision: 'DENY', reason: 'mutation_not_in_safe_allowlist' };
    }
    return { action: name, decision: 'ALLOW', reason: 'safe_mutation_auto' };
  }

  if (READ_ONLY_ACTIONS.has(name)) {
    return { action: name, decision: 'ALLOW', reason: 'read_only_auto' };
  }

  if (BLOCKED_ACTIONS.has(name)) {
    return { action: name, decision: 'DENY', reason: `blocked_action:${name}` };
  }

  return { action: name, decision: 'DENY', reason: 'unknown_action_fail_closed' };
}

export function decisionIsExecutable(decision: JarvisPolicyDecision): boolean {
  return decision === 'ALLOW';
}
