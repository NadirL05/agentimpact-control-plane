import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  buildCanaryAuthObject,
  consumeCanaryNonce,
  isStrictRootAuthMode,
  verifyCanaryAuthFile,
  CANARY_AUTH_SCOPE,
} from './codex-canary-auth.js';
import { evaluateCanaryQuota } from './codex-canary-quota.js';

describe('Jarvis V1.2 canary root one-shot auth', () => {
  it('accepts strict 0400 mode and rejects group/other bits', () => {
    expect(isStrictRootAuthMode(0o400)).toBe(true);
    expect(isStrictRootAuthMode(0o440)).toBe(false);
    expect(isStrictRootAuthMode(0o600)).toBe(false);
    expect(isStrictRootAuthMode(0o644)).toBe(false);
  });

  it('verifies schema, sha, expiry, provider, scope', () => {
    const sha = 'a'.repeat(64);
    const auth = buildCanaryAuthObject({ script_sha256: sha, ttl_seconds: 600 });
    const path = '/tmp/fake-auth';
    const result = verifyCanaryAuthFile({
      authPath: path,
      expectedScriptSha256: sha,
      readFile: () => JSON.stringify(auth),
      stat: () => ({
        uid: 0, gid: 0, mode: 0o100400, isFile: () => true, isDirectory: () => false,
      }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.auth.scope).toBe(CANARY_AUTH_SCOPE);

    expect(verifyCanaryAuthFile({
      authPath: path,
      expectedScriptSha256: 'b'.repeat(64),
      readFile: () => JSON.stringify(auth),
      stat: () => ({ uid: 0, gid: 0, mode: 0o100400, isFile: () => true, isDirectory: () => false }),
    }).ok).toBe(false);

    const expired = { ...auth, expires_at: new Date(Date.now() - 1000).toISOString() };
    expect(verifyCanaryAuthFile({
      authPath: path,
      expectedScriptSha256: sha,
      readFile: () => JSON.stringify(expired),
      stat: () => ({ uid: 0, gid: 0, mode: 0o100400, isFile: () => true, isDirectory: () => false }),
    }).ok).toBe(false);

    expect(verifyCanaryAuthFile({
      authPath: path,
      expectedScriptSha256: sha,
      readFile: () => JSON.stringify({ ...auth, provider: 'cursor' }),
      stat: () => ({ uid: 0, gid: 0, mode: 0o100400, isFile: () => true, isDirectory: () => false }),
    }).ok).toBe(false);

    expect(verifyCanaryAuthFile({
      authPath: path,
      expectedScriptSha256: sha,
      readFile: () => JSON.stringify(auth),
      stat: () => ({ uid: 1000, gid: 0, mode: 0o100400, isFile: () => true, isDirectory: () => false }),
    }).ok).toBe(false);
  });

  it('consumes nonce exactly once (replay protection)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jarvis-canary-nonce-'));
    try {
      const nonce = randomUUID();
      const first = consumeCanaryNonce({ nonce, consumedDir: dir });
      expect(first.ok).toBe(true);
      const second = consumeCanaryNonce({ nonce, consumedDir: dir });
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.reason).toMatch(/consumed|replay|race/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects generic authorized=1 style payloads', () => {
    const r = verifyCanaryAuthFile({
      authPath: '/x',
      expectedScriptSha256: 'a'.repeat(64),
      readFile: () => JSON.stringify({ authorized: '1' }),
      stat: () => ({ uid: 0, gid: 0, mode: 0o100400, isFile: () => true, isDirectory: () => false }),
    });
    expect(r.ok).toBe(false);
  });
});

describe('Jarvis V1.2 canary quota fail-closed', () => {
  it('never treats unknown/exhausted as pass; does not invent available', () => {
    expect(evaluateCanaryQuota({
      worker_type: 'codex', quota_state: 'unknown', canary_authorization_pass: true, source: 'db',
    })).toMatchObject({ QUOTA_CHECK: 'BLOCKED_UNKNOWN', continue: false });
    expect(evaluateCanaryQuota({
      worker_type: 'codex', quota_state: 'exhausted', canary_authorization_pass: true, source: 'db',
    })).toMatchObject({ QUOTA_CHECK: 'BLOCKED_EXHAUSTED', continue: false });
    expect(evaluateCanaryQuota({
      worker_type: 'codex', quota_state: 'available', canary_authorization_pass: true, source: 'db',
    })).toMatchObject({ QUOTA_CHECK: 'BLOCKED_UNKNOWN', continue: false });
    expect(evaluateCanaryQuota({
      worker_type: 'codex', quota_state: 'available', canary_authorization_pass: true, source: 'operator',
    })).toMatchObject({ QUOTA_CHECK: 'BLOCKED_UNKNOWN', continue: false });
    expect(evaluateCanaryQuota({
      worker_type: 'codex', quota_state: 'available', canary_authorization_pass: true, source: 'provider_cli',
    })).toMatchObject({ QUOTA_CHECK: 'PASS', continue: true });
  });

  it('allows limited only with trusted source + explicit canary authorization', () => {
    expect(evaluateCanaryQuota({
      worker_type: 'codex', quota_state: 'limited', canary_authorization_pass: false, source: 'provider_cli',
    }).continue).toBe(false);
    expect(evaluateCanaryQuota({
      worker_type: 'codex', quota_state: 'limited', canary_authorization_pass: true, source: 'db',
    })).toMatchObject({ QUOTA_CHECK: 'BLOCKED_UNKNOWN', continue: false });
    expect(evaluateCanaryQuota({
      worker_type: 'codex', quota_state: 'limited', canary_authorization_pass: true, source: 'provider_cli',
    })).toMatchObject({ QUOTA_CHECK: 'PASS', continue: true });
  });

  it('blocks cursor worker for codex canary', () => {
    expect(evaluateCanaryQuota({
      worker_type: 'cursor', quota_state: 'available', canary_authorization_pass: true,
    }).QUOTA_CHECK).toBe('BLOCKED_WORKER');
  });
});
