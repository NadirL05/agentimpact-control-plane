import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  ARMED_CANARY_V2_SHA256,
  authObjectKeysAllowed,
  parseAuthHelperArgv,
} from './auth-helper-argv.js';

const REPO = '/opt/agentimpact/runner/repos/agentimpact-control-plane.git';
const AUTH_HELPER_V2 = join(
  REPO,
  'infra/jarvis/root-authorize-jarvis-v1-2-one-codex-canary-v2.sh',
);
const CANARY_V2 = join(
  REPO,
  'infra/jarvis/root-run-jarvis-v1-2-codex-canary-armed-v2.sh',
);
const LEGACY =
  '/tmp/agentimpact-superset-poc-stage/superset-linux-x64.tar.gz';

function runParseOnly(args: string[]) {
  return spawnSync('bash', [AUTH_HELPER_V2, '--parse-only', ...args], {
    encoding: 'utf8',
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' },
  });
}

describe('auth helper outer-compat argv (static)', () => {
  it('accepts zero positionals (direct invoke)', () => {
    const r = parseAuthHelperArgv([], {
      scriptPath: CANARY_V2,
      ttlSeconds: 900,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.legacyPositionalCount).toBe(0);
      expect(r.legacyIgnored).toBe(false);
    }
  });

  it('accepts exactly one legacy outer-verify positional and ignores it', () => {
    const r = parseAuthHelperArgv([LEGACY], { scriptPath: CANARY_V2 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.legacyPositionalCount).toBe(1);
      expect(r.legacyIgnored).toBe(true);
      expect(r.scriptPath).toBe(CANARY_V2);
    }
  });

  it('rejects more than one unexpected positional (fail closed)', () => {
    const r = parseAuthHelperArgv([LEGACY, 'extra'], { scriptPath: CANARY_V2 });
    expect(r).toEqual({ ok: false, reason: 'EXTRA_POSITIONALS' });
  });

  it('rejects unknown flags', () => {
    expect(parseAuthHelperArgv(['--authorized=1']).ok).toBe(false);
  });

  it('authorization schema never carries legacy tarball', () => {
    expect(
      authObjectKeysAllowed({
        scope: 'ONE_REAL_CODEX_CANARY_ONLY',
        script_sha256: ARMED_CANARY_V2_SHA256,
        provider: 'codex',
        max_provider_calls: 1,
        publisher: 'off',
        created_at: '2026-01-01T00:00:00Z',
        expires_at: '2026-01-01T00:15:00Z',
        nonce: 'x'.repeat(36),
        tarball: LEGACY,
      }),
    ).toBe(false);
    expect(
      authObjectKeysAllowed({
        scope: 'ONE_REAL_CODEX_CANARY_ONLY',
        script_sha256: ARMED_CANARY_V2_SHA256,
        provider: 'codex',
        max_provider_calls: 1,
        publisher: 'off',
        created_at: '2026-01-01T00:00:00Z',
        expires_at: '2026-01-01T00:15:00Z',
        nonce: 'x'.repeat(36),
      }),
    ).toBe(true);
  });

  it('shell --parse-only: no arg OK; legacy OK; extra denied; SHA bound; no Codex', () => {
    const canarySha = createHash('sha256')
      .update(readFileSync(CANARY_V2))
      .digest('hex');
    expect(canarySha).toBe(ARMED_CANARY_V2_SHA256);

    const noArg = runParseOnly([`--script`, CANARY_V2]);
    expect(noArg.status).toBe(0);
    expect(noArg.stdout).toContain('AUTH_HELPER_LEGACY_POSITIONAL=ABSENT_OK');
    expect(noArg.stdout).toContain(`CANARY_SCRIPT_SHA256=${ARMED_CANARY_V2_SHA256}`);
    expect(noArg.stdout).toContain('CODEX_EXECUTION=NO');
    expect(noArg.stdout).toContain('REAL_CODEX_CALLS=0');

    const legacy = runParseOnly([`--script`, CANARY_V2, LEGACY]);
    expect(legacy.status).toBe(0);
    expect(legacy.stdout).toContain('AUTH_HELPER_LEGACY_POSITIONAL=ACCEPTED_IGNORED');
    expect(legacy.stdout).toContain('AUTH_HELPER_LEGACY_INFLUENCES_AUTH=NO');
    expect(legacy.stdout).toContain(`CANARY_SCRIPT_SHA256=${ARMED_CANARY_V2_SHA256}`);
    expect(legacy.stdout).not.toContain(LEGACY);
    expect(legacy.stdout).toContain('CODEX_EXECUTION=NO');

    // Exact outer-verify invoke shape: sole legacy tarball positional, default pinned canary path.
    const outerStyle = runParseOnly([LEGACY]);
    expect(outerStyle.status).toBe(0);
    expect(outerStyle.stdout).toContain('AUTH_HELPER_OUTER_COMPAT=PASS');
    expect(outerStyle.stdout).toContain('AUTH_HELPER_LEGACY_POSITIONAL=ACCEPTED_IGNORED');
    expect(outerStyle.stdout).toContain('AUTH_HELPER_LEGACY_INFLUENCES_AUTH=NO');
    expect(outerStyle.stdout).toContain(`CANARY_SCRIPT_SHA256=${ARMED_CANARY_V2_SHA256}`);
    expect(outerStyle.stdout).not.toContain(LEGACY);
    expect(outerStyle.stdout).toContain('CODEX_EXECUTION=NO');

    const extra = runParseOnly([LEGACY, 'another']);
    expect(extra.status).toBe(1);
    expect(extra.stderr + extra.stdout).toMatch(/extra positional/i);
    expect(extra.stderr + extra.stdout).toContain('AUTH_HELPER_EXTRA_ARGS_DENIED=PASS');
  });
});
