import { readFileSync } from 'node:fs';
import { readOptionalSecret, readRequiredSecret } from '../core/read-secret-env.js';

export type SlackRouterEnvConfig = {
  nadirUserId: string;
  botToken: string;
  appToken: string;
  controlPlaneUrl: string;
  bridgeToken: string;
  grokWorkerSocket: string;
  healthPort: number;
  killSwitchPath: string;
  grokRateUserMax: number;
  grokRateUserWindowMs: number;
  grokRateChannelMax: number;
  grokRateChannelWindowMs: number;
};

function readSecretFile(path: string | undefined, label: string): string {
  if (!path) {
    throw new Error(`missing_${label}_file`);
  }
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    throw new Error(`unreadable_${label}_file`);
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`missing_required_env:${name}`);
  }
  return value;
}

/** Fail-closed : SLACK_NADIR_USER_ID obligatoire (Slack user_id, jamais display name). */
export function loadSlackRouterConfig(): SlackRouterEnvConfig {
  const nadirUserId = required('SLACK_NADIR_USER_ID');
  if (!/^U[A-Z0-9]+$/i.test(nadirUserId)) {
    throw new Error('invalid_slack_nadir_user_id');
  }

  for (const pgVar of ['PGHOST', 'PGDATABASE', 'PGUSER'] as const) {
    if (!process.env[pgVar]?.trim()) {
      throw new Error(`missing_required_env:${pgVar}`);
    }
  }
  readRequiredSecret('PGPASSWORD_FILE', 'postgres_password', 'PGPASSWORD');

  return {
    nadirUserId,
    botToken: readSecretFile(process.env.SLACK_BOT_TOKEN_FILE, 'slack_bot_token'),
    appToken: readSecretFile(process.env.SLACK_APP_TOKEN_FILE, 'slack_app_token'),
    controlPlaneUrl: process.env.CONTROL_PLANE_URL?.trim() || 'http://127.0.0.1:3000',
    bridgeToken: readOptionalSecret(
      'SLACK_ROUTER_BRIDGE_TOKEN_FILE',
      'SLACK_ROUTER_BRIDGE_TOKEN',
    ),
    grokWorkerSocket:
      process.env.GROK_WORKER_SOCKET?.trim() || '/run/agentimpact-grok-worker/grok.sock',
    healthPort: Number(process.env.SLACK_ROUTER_HEALTH_PORT ?? 9120),
    killSwitchPath:
      process.env.GROK_KILL_SWITCH_PATH?.trim() || '/etc/agentimpact/flags/grokbot.disabled',
    grokRateUserMax: Number(process.env.GROK_RATE_USER_MAX ?? 6),
    grokRateUserWindowMs: Number(process.env.GROK_RATE_USER_WINDOW_MS ?? 60_000),
    grokRateChannelMax: Number(process.env.GROK_RATE_CHANNEL_MAX ?? 20),
    grokRateChannelWindowMs: Number(process.env.GROK_RATE_CHANNEL_WINDOW_MS ?? 60_000),
  };
}

/** Vérifie que le routeur ne charge jamais CURSOR_API_KEY. */
export function assertRouterHasNoCursorKeyEnv(): void {
  if (process.env.CURSOR_API_KEY?.trim() || process.env.CURSOR_API_KEY_FILE?.trim()) {
    throw new Error('router_must_not_load_cursor_api_key');
  }
}
