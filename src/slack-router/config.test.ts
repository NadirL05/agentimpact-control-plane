import { describe, expect, it, vi, afterEach } from 'vitest';
import { loadSlackRouterConfig, assertRouterHasNoCursorKeyEnv } from './config.js';

const BASE_ENV = {
  SLACK_BOT_TOKEN_FILE: '/dev/null',
  SLACK_APP_TOKEN_FILE: '/dev/null',
  PGHOST: '127.0.0.1',
  PGDATABASE: 'agentimpact',
  PGUSER: 'agentimpact_app',
  PGPASSWORD: 'test',
} as const;

describe('loadSlackRouterConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('fail-closed si SLACK_NADIR_USER_ID absent', () => {
    vi.stubEnv('SLACK_BOT_TOKEN_FILE', BASE_ENV.SLACK_BOT_TOKEN_FILE);
    vi.stubEnv('SLACK_APP_TOKEN_FILE', BASE_ENV.SLACK_APP_TOKEN_FILE);
    vi.stubEnv('PGHOST', BASE_ENV.PGHOST);
    vi.stubEnv('PGDATABASE', BASE_ENV.PGDATABASE);
    vi.stubEnv('PGUSER', BASE_ENV.PGUSER);
    vi.stubEnv('PGPASSWORD', BASE_ENV.PGPASSWORD);
    vi.stubEnv('SLACK_NADIR_USER_ID', '');
    expect(() => loadSlackRouterConfig()).toThrow(/missing_required_env/);
  });

  it('fail-closed si Postgres absent', () => {
    vi.stubEnv('SLACK_BOT_TOKEN_FILE', BASE_ENV.SLACK_BOT_TOKEN_FILE);
    vi.stubEnv('SLACK_APP_TOKEN_FILE', BASE_ENV.SLACK_APP_TOKEN_FILE);
    vi.stubEnv('SLACK_NADIR_USER_ID', 'UNADIR001');
    expect(() => loadSlackRouterConfig()).toThrow(/missing_required_env:PGHOST/);
  });

  it('refuse CURSOR_API_KEY côté routeur', () => {
    vi.stubEnv('CURSOR_API_KEY', 'cursor_secret');
    expect(() => assertRouterHasNoCursorKeyEnv()).toThrow(/router_must_not_load_cursor_api_key/);
  });

  it('parse SLACK_NATIVE_AGENT_USER_IDS', () => {
    vi.stubEnv('SLACK_BOT_TOKEN_FILE', BASE_ENV.SLACK_BOT_TOKEN_FILE);
    vi.stubEnv('SLACK_APP_TOKEN_FILE', BASE_ENV.SLACK_APP_TOKEN_FILE);
    vi.stubEnv('PGHOST', BASE_ENV.PGHOST);
    vi.stubEnv('PGDATABASE', BASE_ENV.PGDATABASE);
    vi.stubEnv('PGUSER', BASE_ENV.PGUSER);
    vi.stubEnv('PGPASSWORD', BASE_ENV.PGPASSWORD);
    vi.stubEnv('SLACK_NADIR_USER_ID', 'UNADIR001');
    vi.stubEnv('SLACK_NATIVE_AGENT_USER_IDS', 'UCURSOR01, UCODEX001');
    const config = loadSlackRouterConfig();
    expect([...config.nativeAgentUserIds]).toEqual(['UCURSOR01', 'UCODEX001']);
  });

  it('rejette un ID natif malformé', () => {
    vi.stubEnv('SLACK_BOT_TOKEN_FILE', BASE_ENV.SLACK_BOT_TOKEN_FILE);
    vi.stubEnv('SLACK_APP_TOKEN_FILE', BASE_ENV.SLACK_APP_TOKEN_FILE);
    vi.stubEnv('PGHOST', BASE_ENV.PGHOST);
    vi.stubEnv('PGDATABASE', BASE_ENV.PGDATABASE);
    vi.stubEnv('PGUSER', BASE_ENV.PGUSER);
    vi.stubEnv('PGPASSWORD', BASE_ENV.PGPASSWORD);
    vi.stubEnv('SLACK_NADIR_USER_ID', 'UNADIR001');
    vi.stubEnv('SLACK_NATIVE_AGENT_USER_IDS', 'bad-id');
    expect(() => loadSlackRouterConfig()).toThrow(/invalid_slack_native_agent_user_id/);
  });

  it('fail-closed en production si SLACK_NATIVE_AGENT_USER_IDS absent', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SLACK_BOT_TOKEN_FILE', BASE_ENV.SLACK_BOT_TOKEN_FILE);
    vi.stubEnv('SLACK_APP_TOKEN_FILE', BASE_ENV.SLACK_APP_TOKEN_FILE);
    vi.stubEnv('PGHOST', BASE_ENV.PGHOST);
    vi.stubEnv('PGDATABASE', BASE_ENV.PGDATABASE);
    vi.stubEnv('PGUSER', BASE_ENV.PGUSER);
    vi.stubEnv('PGPASSWORD', BASE_ENV.PGPASSWORD);
    vi.stubEnv('SLACK_NADIR_USER_ID', 'UNADIR001');
    vi.stubEnv('SLACK_NATIVE_AGENT_USER_IDS', '');
    expect(() => loadSlackRouterConfig()).toThrow(/missing_required_env:SLACK_NATIVE_AGENT_USER_IDS/);
  });
});
