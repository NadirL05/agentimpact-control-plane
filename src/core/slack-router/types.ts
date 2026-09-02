/** Agent backend cible pour un fil Slack. `native` = app Slack officielle (Cursor, Codex, …). */
export type SlackRouteTarget = 'hermes' | 'grok' | 'codex' | 'ana' | 'devin' | 'native';

export type SlackRouteDecision = {
  target: SlackRouteTarget;
  /** Texte utilisateur après suppression de la directive ROUTE / ESCALADE. */
  prompt: string;
  /** Directive explicite détectée dans le message. */
  explicit: boolean;
};

export type SlackMessageEvent = {
  type: 'message';
  event_id: string;
  team_id: string;
  channel: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
  /** Métadonnée interne optionnelle (ex. cron) — jamais exposée dans les logs. */
  source?: string;
};

export type RouterDispatchResult =
  | { action: 'ignore'; reason: string }
  | { action: 'deduplicated'; event_id: string }
  | { action: 'delegate'; target: SlackRouteTarget; thread_key: string; prompt: string }
  | { action: 'reject'; reason: string; thread_key?: string };

export type SafeRouterLogEntry = {
  event_id: string;
  thread_ts: string;
  route: SlackRouteTarget | 'none';
  status: string;
  duration_ms: number;
  run_id?: string;
};

export type GrokSpawnSpec = {
  executable: string;
  args: string[];
  /** Variables d'environnement non secrètes — le worker Grok charge CURSOR_API_KEY seul. */
  env: Record<string, string>;
  cwd: string;
  timeoutMs: number;
  /** Le prompt est écrit dans un fichier éphémère par l'appelant (voir grok-agent-run.sh). */
  promptFilePlaceholder: boolean;
};

export const GROK_DEFAULTS = {
  executable: '/var/lib/cursor-grok-worker/.local/bin/agent',
  model: 'cursor-grok-4.6-medium',
  workspace: '/opt/agentimpact/grokbot/workspace',
  apiKeyFile: '/etc/agentimpact/credentials/cursor-grok-api-key',
  timeoutMs: 300_000,
  killSwitchPath: '/etc/agentimpact/flags/grokbot.disabled',
} as const;
