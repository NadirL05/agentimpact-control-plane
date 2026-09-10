import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  ARMED_CANARY_V2_SHA256,
  AUTH_HELPER_TTL_SECONDS,
  CANONICAL_ARMED_CANARY_PATH,
  buildFinalAuthObjectFields,
  canaryScriptHashBinding,
  parseFinalAuthHelperArgv,
} from './auth-helper-final.js';
import {
  consumeCanaryNonce,
  isStrictRootAuthMode,
  verifyCanaryAuthFile,
  buildCanaryAuthObject,
} from './codex-canary-auth.js';
import { randomUUID } from 'node:crypto';

const REPO = '/opt/agentimpact/runner/repos/agentimpact-control-plane.git';
const HELPER_FINAL = join(
  REPO,
  'infra/jarvis/root-authorize-jarvis-v1-2-one-codex-canary-final.sh',
);
const LEGACY = '/tmp/agentimpact-superset-poc-stage/superset-linux-x64.tar.gz';

function probe(args: string[], envExtra: Record<string, string> = {}) {
  return spawnSync('bash', [HELPER_FINAL, ...args], {
    encoding: 'utf8',
    env: {
      PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
      LANG: 'C.UTF-8',
      AGENTIMPACT_AUTH_HELPER_STATIC_PROBE: '1',
      ...envExtra,
    },
  });
}

describe('final auth helper — argv + canonical binding (static)', () => {
  it('HELPER_NO_ARG / HELPER_ONE_LEGACY / HELPER_TWO denied; flags denied', () => {
    expect(parseFinalAuthHelperArgv([])).toMatchObject({
      ok: true,
      legacyPositionalCount: 0,
      canonicalScriptOnly: true,
      ttlSeconds: 900,
    });
    expect(parseFinalAuthHelperArgv([LEGACY])).toMatchObject({
      ok: true,
      legacyPositionalCount: 1,
      canonicalScriptOnly: true,
    });
    expect(parseFinalAuthHelperArgv([LEGACY, 'extra'])).toEqual({
      ok: false,
      reason: 'EXTRA_POSITIONALS',
    });
    expect(parseFinalAuthHelperArgv(['--script', '/evil.sh'])).toEqual({
      ok: false,
      reason: 'FLAGS_DENIED',
    });
    expect(parseFinalAuthHelperArgv(['--ttl-seconds', '60'])).toEqual({
      ok: false,
      reason: 'FLAGS_DENIED',
    });
  });

  it('ARBITRARY_SCRIPT_SELECTION=IMPOSSIBLE; hash binding PASS/FAIL', () => {
    const obj = buildFinalAuthObjectFields({
      created_at: '2026-09-10T00:00:00.000Z',
      expires_at: '2026-09-10T00:15:00.000Z',
      nonce: randomUUID(),
    });
    expect(obj.script_sha256).toBe(ARMED_CANARY_V2_SHA256);
    expect(Object.keys(obj)).not.toContain('script');
    expect(canaryScriptHashBinding(ARMED_CANARY_V2_SHA256)).toBe('PASS');
    expect(canaryScriptHashBinding('0'.repeat(64))).toBe('FAIL');
  });

  it('TTL_BOUNDED=PASS (hardcoded 900)', () => {
    expect(AUTH_HELPER_TTL_SECONDS).toBe(900);
  });

  it('AUTH_FILE_OWNER_ROOT / MODE_0400 policy + replay', () => {
    expect(isStrictRootAuthMode(0o400)).toBe(true);
    expect(isStrictRootAuthMode(0o644)).toBe(false);
    const auth = buildCanaryAuthObject({
      script_sha256: ARMED_CANARY_V2_SHA256,
      ttl_seconds: 900,
    });
    const ok = verifyCanaryAuthFile({
      authPath: '/x',
      expectedScriptSha256: ARMED_CANARY_V2_SHA256,
      readFile: () => JSON.stringify(auth),
      stat: () => ({
        uid: 0,
        gid: 0,
        mode: 0o100400,
        isFile: () => true,
        isDirectory: () => false,
      }),
    });
    expect(ok.ok).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), 'jarvis-final-nonce-'));
    try {
      const nonce = randomUUID();
      expect(consumeCanaryNonce({ nonce, consumedDir: dir }).ok).toBe(true);
      expect(consumeCanaryNonce({ nonce, consumedDir: dir }).ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shell static probe: no-arg, one legacy, two denied, wrong hash, no Codex', () => {
    const canarySha = createHash('sha256')
      .update(readFileSync(CANONICAL_ARMED_CANARY_PATH))
      .digest('hex');
    expect(canarySha).toBe(ARMED_CANARY_V2_SHA256);

    const noArg = probe([]);
    expect(noArg.status).toBe(0);
    expect(noArg.stdout).toContain('HELPER_NO_ARG=PASS');
    expect(noArg.stdout).toContain('AUTH_HELPER_OUTER_COMPAT=PASS');
    expect(noArg.stdout).toContain('AUTH_HELPER_CANONICAL_SCRIPT_BINDING=PASS');
    expect(noArg.stdout).toContain('ARBITRARY_SCRIPT_SELECTION=IMPOSSIBLE');
    expect(noArg.stdout).toContain('CANARY_SCRIPT_HASH_BINDING=PASS');
    expect(noArg.stdout).toContain(`CANARY_SCRIPT_SHA256=${ARMED_CANARY_V2_SHA256}`);
    expect(noArg.stdout).toContain('TTL_BOUNDED=PASS');
    expect(noArg.stdout).toContain('TTL_SECONDS=900');
    expect(noArg.stdout).toContain('AUTH_FILE_OWNER_ROOT=PASS');
    expect(noArg.stdout).toContain('AUTH_FILE_MODE_0400=PASS');
    expect(noArg.stdout).toContain('AUTH_REPLAY_PROTECTION=PASS');
    expect(noArg.stdout).toContain('CANARY_AUTHORIZATION_FILE=NOT_CREATED');
    expect(noArg.stdout).toContain('REAL_CODEX_CALLS=0');
    expect(noArg.stdout).toContain('REAL_CURSOR_CALLS=0');
    expect(noArg.stdout).toContain('CODEX_EXECUTION=NO');
    expect(noArg.stdout).not.toContain(LEGACY);

    const one = probe([LEGACY]);
    expect(one.status).toBe(0);
    expect(one.stdout).toContain('HELPER_ONE_LEGACY_POSITIONAL_ARG=PASS');
    expect(one.stdout).toContain('AUTH_HELPER_LEGACY_INFLUENCES_AUTH=NO');
    expect(one.stdout).toContain(`CANARY_SCRIPT_SHA256=${ARMED_CANARY_V2_SHA256}`);
    expect(one.stdout).not.toContain(LEGACY);
    expect(one.stdout).toContain('CANARY_AUTHORIZATION_FILE=NOT_CREATED');

    const two = probe([LEGACY, 'extra']);
    expect(two.status).toBe(1);
    expect(two.stderr + two.stdout).toContain('HELPER_TWO_POSITIONAL_ARGS=DENIED');
    expect(two.stderr + two.stdout).toContain('AUTH_HELPER_EXTRA_ARGS_DENIED=PASS');

    const flag = probe(['--script', '/tmp/evil.sh']);
    expect(flag.status).toBe(1);
    expect(flag.stderr + flag.stdout).toContain('ARBITRARY_SCRIPT_SELECTION=IMPOSSIBLE');

    const wrong = probe([], {
      AGENTIMPACT_AUTH_HELPER_STATIC_EXPECTED_SHA: '0'.repeat(64),
    });
    expect(wrong.status).toBe(1);
    expect(wrong.stderr + wrong.stdout).toContain('CANARY_SCRIPT_HASH=FAIL');
    expect(wrong.stderr + wrong.stdout).toContain('WRONG_CANARY_HASH=DENIED');
    expect(wrong.stderr + wrong.stdout).toContain('REAL_CODEX_CALLS=0');

    // Wrong file content at alternate path (static only) still denied vs expected pin.
    const tmp = mkdtempSync(join(tmpdir(), 'jarvis-wrong-canary-'));
    try {
      const evil = join(tmp, 'evil.sh');
      writeFileSync(evil, '#!/bin/bash\necho evil\n');
      const wrongPath = probe([], {
        AGENTIMPACT_AUTH_HELPER_STATIC_CANARY_PATH: evil,
      });
      expect(wrongPath.status).toBe(1);
      expect(wrongPath.stderr + wrongPath.stdout).toContain('WRONG_CANARY_HASH=DENIED');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
