/**
 * Deterministic NL → typed action planner. Fail-closed on ambiguity / injection.
 * Never emits shell, argv, filesystem paths, or credentials.
 */
import {
  type JarvisAction,
  type JarvisActionName,
  type JarvisIntent,
  type JarvisRiskLevel,
  BLOCKED_ACTIONS,
} from './contract.js';

export type PlanOutcome =
  | { ok: true; intent: JarvisIntent; actions: JarvisAction[] }
  | { ok: false; intent: JarvisIntent; error_code: 'ambiguous_intent' | 'denied_intent' | 'unsupported_intent' };

type Ctx = {
  request_id: string;
  actor: string;
  organization_id: string;
  message: string;
};

const DENY_PATTERNS: Array<{ re: RegExp; action: JarvisActionName; intent: string }> = [
  { re: /\b(rm\s+-rf|sudo\s+|bash\s+-c|sh\s+-c|\/bin\/(?:ba)?sh|uname\s+-a|curl\s+|wget\s+)/i, action: 'generic.shell', intent: 'shell_injection' },
  { re: /\b(shell|terminal\s+shell|pty|executer?\s+une?\s+commande)\b/i, action: 'generic.shell', intent: 'generic_shell' },
  { re: /\b(mot\s+de\s+passe|password|secret|api[_-]?key|credential|token\s+postgres|postgres\s+password)\b/i, action: 'secret.read', intent: 'secret_exfiltration' },
  { re: /\b(docker\.sock|docker\s+exec|container\s+root)\b/i, action: 'docker.exec', intent: 'docker_access' },
  { re: /\b(root\s+shell|unrestricted\s+root|become\s+root)\b/i, action: 'root.exec', intent: 'root_access' },
  { re: /\b(executor\.sock|superset-cred|\/etc\/credstore|LoadCredential|private\s+executor)\b/i, action: 'secret.read', intent: 'direct_superset_private' },
  { re: /\b(argv|arbitrary\s+cli|--api-key)\b/i, action: 'generic.shell', intent: 'arbitrary_argv' },
];

type Rule = {
  re: RegExp;
  intent: string;
  action: JarvisActionName;
  risk: JarvisRiskLevel;
  params?: (message: string) => Record<string, unknown>;
};

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

function extractUuid(message: string): string | undefined {
  return message.match(UUID_RE)?.[0]?.toLowerCase();
}

const RULES: Rule[] = [
  { re: /\b(status|sant[eé]|health|etat\s+du\s+systeme|état\s+du\s+système)\b/i, intent: 'status', action: 'status.get', risk: 'low' },
  { re: /\b(liste|montre|affiche).{0,40}(mission)/i, intent: 'mission_list', action: 'mission.list', risk: 'low' },
  { re: /\bmissions?\s+(en\s+cours|ouvertes|actives)\b/i, intent: 'mission_list', action: 'mission.list', risk: 'low' },
  { re: /\b(pourquoi|inspecte|d[eé]tail|montre).{0,40}mission\b/i, intent: 'mission_inspect', action: 'mission.inspect', risk: 'low',
    params: (m) => ({ mission_id: extractUuid(m) }) },
  { re: /\b(events?|historique|journal).{0,40}mission\b/i, intent: 'mission_events', action: 'mission.events', risk: 'low',
    params: (m) => ({ mission_id: extractUuid(m) }) },
  { re: /\b(liste|montre|affiche).{0,40}workspaces?\b/i, intent: 'workspace_list', action: 'workspace.list', risk: 'low' },
  { re: /\bworkspaces?\b/i, intent: 'workspace_list', action: 'workspace.list', risk: 'low' },
  { re: /\b(liste|montre|affiche).{0,40}projects?\b/i, intent: 'project_list', action: 'project.list', risk: 'low' },
  { re: /\bprojects?\s+list\b/i, intent: 'project_list', action: 'project.list', risk: 'low' },
  { re: /\b(cr[eé]e|creer|créer).{0,40}mission\b/i, intent: 'mission_create', action: 'mission.create', risk: 'medium',
    params: (m) => ({ title: m.replace(/^.*mission(?:\s+(?:pour|de))?\s*/i, '').trim().slice(0, 200) || 'mission jarvis' }) },
  { re: /\b(annule|cancel).{0,40}mission\b/i, intent: 'mission_cancel', action: 'mission.cancel', risk: 'medium',
    params: (m) => ({ mission_id: extractUuid(m) }) },
  { re: /\b(arr[eê]te|stoppe?|stop).{0,40}agent\b/i, intent: 'agent_stop', action: 'agent.stop', risk: 'medium',
    params: (m) => ({ mission_id: extractUuid(m) }) },
  { re: /\b(lance|d[eé]marre|start).{0,40}(codex|cursor|agent)\b/i, intent: 'agent_start', action: 'agent.start', risk: 'high',
    params: (m) => {
      const worker = /\bcursor\b/i.test(m) ? 'cursor' : 'codex';
      return {
        requested_worker_type: worker,
        reason: 'jarvis_nl_agent_start',
        mission_id: extractUuid(m),
      };
    } },
  { re: /\b(agent\.create|agents\s+create|cr[eé]e\s+un\s+agent)\b/i, intent: 'agent_create', action: 'agent.create', risk: 'critical' },
  { re: /\b(push|pousse).{0,40}(github|git)\b/i, intent: 'publisher_push', action: 'publisher.push', risk: 'critical' },
  { re: /\b(cr[eé]e|ouvrir).{0,40}(pr|pull\s+request)\b/i, intent: 'publisher_pr', action: 'publisher.pr_create', risk: 'critical' },
  { re: /\b(merge|fusionne).{0,40}(pr|pull|branche)\b/i, intent: 'publisher_merge', action: 'publisher.merge', risk: 'critical' },
  { re: /\b(d[eé]ploie|deploy).{0,40}(prod|production|staging)?\b/i, intent: 'deploy', action: 'deploy', risk: 'critical',
    params: () => ({ target: 'prod' }) },
  { re: /\b(migrat)/i, intent: 'database_migrate', action: 'database.migrate', risk: 'critical' },
];

function buildAction(
  ctx: Ctx,
  action: JarvisActionName,
  risk: JarvisRiskLevel,
  reason: string,
  parameters: Record<string, unknown>,
): JarvisAction {
  const mission_id = typeof parameters.mission_id === 'string' ? parameters.mission_id : undefined;
  return {
    request_id: ctx.request_id,
    actor: ctx.actor,
    organization_id: ctx.organization_id,
    timestamp: new Date().toISOString(),
    action,
    parameters,
    reason,
    risk_level: risk,
    ...(mission_id ? { mission_id } : {}),
  };
}

export function planJarvisActions(ctx: Ctx): PlanOutcome {
  const normalized = ctx.message.trim();
  const baseIntent = {
    request_id: ctx.request_id,
    actor: ctx.actor,
    organization_id: ctx.organization_id,
    message: normalized,
    timestamp: new Date().toISOString(),
  };

  for (const deny of DENY_PATTERNS) {
    if (deny.re.test(normalized)) {
      const intent: JarvisIntent = {
        ...baseIntent,
        inferred_intent: deny.intent,
        confidence: 'high',
      };
      return {
        ok: true,
        intent,
        actions: [buildAction(ctx, deny.action, 'critical', `denied:${deny.intent}`, {})],
      };
    }
  }

  const matches = RULES.filter((rule) => rule.re.test(normalized));
  if (matches.length === 0) {
    return {
      ok: false,
      intent: { ...baseIntent, inferred_intent: 'unknown', confidence: 'none' },
      error_code: 'unsupported_intent',
    };
  }

  // Prefer the most specific (longer regex source) when multiple match.
  matches.sort((a, b) => b.re.source.length - a.re.source.length);
  const primary = matches[0]!;
  const secondary = matches.filter((m) => m.intent !== primary.intent);

  // mission inspect + events when "pourquoi ... échoué"
  const actions: JarvisAction[] = [];
  const params = primary.params?.(normalized) ?? {};
  if ((primary.action === 'mission.inspect' || primary.action === 'mission.events' || primary.action === 'mission.cancel' || primary.action === 'agent.stop')
    && !params.mission_id && !/\bmission\b/i.test(normalized)) {
    return {
      ok: false,
      intent: { ...baseIntent, inferred_intent: primary.intent, confidence: 'low' },
      error_code: 'ambiguous_intent',
    };
  }
  if ((primary.action === 'mission.inspect' || primary.action === 'mission.events' || primary.action === 'mission.cancel' || primary.action === 'agent.stop')
    && !params.mission_id) {
    return {
      ok: false,
      intent: { ...baseIntent, inferred_intent: primary.intent, confidence: 'low' },
      error_code: 'ambiguous_intent',
    };
  }

  actions.push(buildAction(ctx, primary.action, primary.risk, `planned:${primary.intent}`, params));

  if (/\bpourquoi\b/i.test(normalized) && primary.action === 'mission.inspect' && params.mission_id) {
    actions.push(buildAction(ctx, 'mission.events', 'low', 'planned:mission_events_followup', {
      mission_id: params.mission_id,
    }));
  }

  // Conflicting high-risk secondary intents → fail closed unless they are the deny class already handled.
  if (secondary.some((s) => BLOCKED_ACTIONS.has(s.action) && s.action !== primary.action)) {
    return {
      ok: false,
      intent: { ...baseIntent, inferred_intent: 'ambiguous_mixed', confidence: 'low' },
      error_code: 'ambiguous_intent',
    };
  }

  return {
    ok: true,
    intent: { ...baseIntent, inferred_intent: primary.intent, confidence: 'high' },
    actions,
  };
}
