import type { GrokSpawnSpec } from './types.js';
import { GROK_DEFAULTS } from './types.js';

export type GrokExecutorConfig = {
  wrapperPath?: string;
  model?: string;
  workspace?: string;
  timeoutMs?: number;
};

/**
 * Spec du wrapper grok-agent-run.sh (prompt via fichier éphémère + positional `[prompt...]`).
 * CURSOR_API_KEY : injectée uniquement par agentimpact-grok-worker (LoadCredential).
 */
export function buildGrokSpawnSpec(
  _prompt: string,
  config: GrokExecutorConfig = {},
): GrokSpawnSpec {
  const wrapperPath = config.wrapperPath ?? '/opt/agentimpact/scripts/grok-agent-run.sh';
  const workspace = config.workspace ?? GROK_DEFAULTS.workspace;
  const model = config.model ?? GROK_DEFAULTS.model;

  return {
    executable: wrapperPath,
    args: [],
    env: {
      HOME: '/var/lib/cursor-grok-worker',
      GROK_AGENT_BIN: '/var/lib/cursor-grok-worker/.local/bin/agent',
      GROK_AGENT_MODEL: model,
      GROK_AGENT_WORKSPACE: workspace,
      GROK_AGENT_TIMEOUT_SEC: String((config.timeoutMs ?? GROK_DEFAULTS.timeoutMs) / 1000),
    },
    cwd: workspace,
    timeoutMs: config.timeoutMs ?? GROK_DEFAULTS.timeoutMs,
    promptFilePlaceholder: true,
  };
}

export function assertNoSecretsInArgv(args: string[]): void {
  for (const arg of args) {
    if (/^xox[bap]-/.test(arg)) {
      throw new Error('secret_in_argv');
    }
    if (/^cursor_[a-z0-9]/i.test(arg)) {
      throw new Error('secret_in_argv');
    }
    if (arg.length > 40 && /^[A-Za-z0-9_\-]{40,}$/.test(arg)) {
      throw new Error('secret_in_argv');
    }
  }
}
