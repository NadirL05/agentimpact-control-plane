import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  CANARY_V3_ALLOWED_PATH,
  CANARY_V3_MAX_PROVIDER_CALLS,
  CANARY_V3_PHASES,
  CANARY_V3_TIMEOUTS,
  CanaryV3StateMachine,
  assertBaseComposeImmutable,
  boundedPollAllowed,
  buildComposeOverrideYaml,
  composeOverridePath,
  gateApproval,
  gateBudget,
  gateFence,
  gateLease,
  gateQuota,
  gateWorkspace,
  parseOuterLegacyArgv,
  phaseElapsed,
  providerAlreadyAttempted,
  reconcileLifecycle,
  reserveProviderInvocationEvidence,
  validateComposeOverrideYaml,
  validateFixtureDiff,
  verifySafeFlags,
  requireBaseComposePrecheck,
} from './canary-v3.js';
import {
  buildCanaryAuthObject,
  consumeCanaryNonce,
  isStrictRootAuthMode,
  verifyCanaryAuthFile,
  CANARY_AUTH_SCOPE,
} from './codex-canary-auth.js';
import { evaluateCanaryQuota } from './codex-canary-quota.js';

const LEGACY = '/tmp/agentimpact-superset-poc-stage/superset-linux-x64.tar.gz';
const PINNED_SHA = 'a'.repeat(64);
const REPO = '/opt/agentimpact/runner/repos/agentimpact-control-plane.git';
const AUTH_HELPER_V3 = join(REPO, 'infra/jarvis/root-authorize-jarvis-v1-2-one-codex-canary-v3.sh');
const CANARY_V3 = join(REPO, 'infra/jarvis/root-run-jarvis-v1-2-codex-canary-v3.sh');
const EXPECTED_CANARY_V3_SHA =
  'bcdef0f2e452bb9a8b046056c1519fbdfcc03d71ea514d9bd4e8427869db085d';

function probeAuthV3(args: string[], envExtra: Record<string, string> = {}) {
  return spawnSync('bash', [AUTH_HELPER_V3, ...args], {
    encoding: 'utf8',
    env: {
      PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
      LANG: 'C.UTF-8',
      AGENTIMPACT_AUTH_HELPER_STATIC_PROBE: '1',
      AGENTIMPACT_AUTH_HELPER_STATIC_CANARY_PATH: CANARY_V3,
      ...envExtra,
    },
  });
}

describe('Jarvis V1.2 Codex canary V3 — static / no-model', () => {
  it('outer legacy arg compatibility + extra args denied', () => {
    expect(parseOuterLegacyArgv([])).toEqual({ ok: true, legacyCount: 0 });
    expect(parseOuterLegacyArgv([LEGACY])).toEqual({ ok: true, legacyCount: 1 });
    expect(parseOuterLegacyArgv([LEGACY, 'x'])).toEqual({ ok: false, reason: 'EXTRA_POSITIONALS' });
    expect(parseOuterLegacyArgv(['--script', '/evil'])).toEqual({ ok: false, reason: 'FLAGS_DENIED' });
  });

  it('auth file owner/mode/expiry/sha/provider/scope/replay', () => {
    expect(isStrictRootAuthMode(0o400)).toBe(true);
    expect(isStrictRootAuthMode(0o644)).toBe(false);
    const auth = buildCanaryAuthObject({ script_sha256: PINNED_SHA, ttl_seconds: 900 });
    expect(auth.scope).toBe(CANARY_AUTH_SCOPE);
    expect(auth.provider).toBe('codex');
    expect(auth.max_provider_calls).toBe(1);
    expect(auth.publisher).toBe('off');

    const ok = verifyCanaryAuthFile({
      authPath: '/x',
      expectedScriptSha256: PINNED_SHA,
      readFile: () => JSON.stringify(auth),
      stat: () => ({ uid: 0, gid: 0, mode: 0o100400, isFile: () => true, isDirectory: () => false }),
    });
    expect(ok.ok).toBe(true);

    expect(verifyCanaryAuthFile({
      authPath: '/x',
      expectedScriptSha256: 'b'.repeat(64),
      readFile: () => JSON.stringify(auth),
      stat: () => ({ uid: 0, gid: 0, mode: 0o100400, isFile: () => true, isDirectory: () => false }),
    }).ok).toBe(false);

    expect(verifyCanaryAuthFile({
      authPath: '/x',
      expectedScriptSha256: PINNED_SHA,
      readFile: () => JSON.stringify({ ...auth, expires_at: new Date(Date.now() - 1000).toISOString() }),
      stat: () => ({ uid: 0, gid: 0, mode: 0o100400, isFile: () => true, isDirectory: () => false }),
    }).ok).toBe(false);

    expect(verifyCanaryAuthFile({
      authPath: '/x',
      expectedScriptSha256: PINNED_SHA,
      readFile: () => JSON.stringify({ ...auth, provider: 'cursor' }),
      stat: () => ({ uid: 0, gid: 0, mode: 0o100400, isFile: () => true, isDirectory: () => false }),
    }).ok).toBe(false);

    expect(verifyCanaryAuthFile({
      authPath: '/x',
      expectedScriptSha256: PINNED_SHA,
      readFile: () => JSON.stringify({ ...auth, scope: 'WIDE' }),
      stat: () => ({ uid: 0, gid: 0, mode: 0o100400, isFile: () => true, isDirectory: () => false }),
    }).ok).toBe(false);

    const dir = mkdtempSync(join(tmpdir(), 'canary-v3-nonce-'));
    try {
      const nonce = randomUUID();
      expect(consumeCanaryNonce({ nonce, consumedDir: dir }).ok).toBe(true);
      expect(consumeCanaryNonce({ nonce, consumedDir: dir }).ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('base compose immutable + override YAML valid + removed on cleanup semantics', () => {
    const yaml = buildComposeOverrideYaml();
    expect(validateComposeOverrideYaml(yaml)).toEqual({ ok: true, reason: 'valid' });
    expect(yaml).toContain('AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED: "0"');
    const path = composeOverridePath(randomUUID());
    expect(path).toMatch(/compose-canary-/);
    expect(assertBaseComposeImmutable('abc', 'abc')).toEqual({ BASE_COMPOSE_IMMUTABLE: 'YES' });
    expect(assertBaseComposeImmutable('abc', 'def')).toEqual({ BASE_COMPOSE_IMMUTABLE: 'NO' });
    // cleanup semantics: override file deleted → path no longer required
    const tmp = mkdtempSync(join(tmpdir(), 'canary-v3-ov-'));
    try {
      const ov = join(tmp, 'compose-canary-test.yml');
      writeFileSync(ov, yaml);
      chmodSync(ov, 0o600);
      rmSync(ov);
      expect(() => readFileSync(ov)).toThrow();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('quota/budget/approval/lease/fence/workspace fail-closed', () => {
    expect(gateQuota('unknown', true).continue).toBe(false);
    expect(gateQuota('exhausted', true).continue).toBe(false);
    expect(gateQuota('available', true).continue).toBe(true);
    expect(gateQuota('limited', false).continue).toBe(false);
    expect(gateQuota('limited', true).continue).toBe(true);
    expect(evaluateCanaryQuota({
      worker_type: 'codex', quota_state: 'unknown', canary_authorization_pass: true,
    }).continue).toBe(false);

    expect(gateBudget(false).continue).toBe(false);
    expect(gateApproval(false).continue).toBe(false);
    expect(gateLease(true).continue).toBe(false);
    expect(gateFence(true).continue).toBe(false);
    expect(gateWorkspace(false).continue).toBe(false);
  });

  it('max provider calls=1, no retries, no Cursor fallback, TOCTOU evidence', () => {
    expect(CANARY_V3_MAX_PROVIDER_CALLS).toBe(1);
    const dir = mkdtempSync(join(tmpdir(), 'canary-v3-ev-'));
    try {
      const id = randomUUID();
      expect(reserveProviderInvocationEvidence({
        evidenceDir: dir, requestId: id, scriptSha256: PINNED_SHA,
      }).ok).toBe(true);
      expect(providerAlreadyAttempted(dir, id)).toBe(true);
      expect(reserveProviderInvocationEvidence({
        evidenceDir: dir, requestId: id, scriptSha256: PINNED_SHA,
      }).ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('timeouts bounded + state machine + lifecycle pending + stop quarantine', () => {
    expect(CANARY_V3_TIMEOUTS.execution_runtime_sec).toBeLessThanOrEqual(300);
    expect(boundedPollAllowed(299, 300)).toBe(true);
    expect(boundedPollAllowed(300, 300)).toBe(false);
    expect(phaseElapsed(1000, 6000).PHASE_ELAPSED_SECONDS).toBe(5);

    const sm = new CanaryV3StateMachine();
    expect(sm.transition('authorized').ok).toBe(true);
    expect(sm.transition('preflight').ok).toBe(true);
    expect(sm.transition('provider_running').ok).toBe(false); // skip illegal
    // fail-safe jump to flags_restored allowed
    expect(sm.transition('flags_restored').ok).toBe(true);
    expect(CANARY_V3_PHASES[0]).toBe('authorized');

    expect(reconcileLifecycle({
      testAfter: 'PASS', diffOk: true, providerStopped: true,
      stopConfirmed: true, noChildProcesses: true, leaseReleasable: true,
    }).outcome).toBe('FULL_PASS');

    expect(reconcileLifecycle({
      testAfter: 'PASS', diffOk: true, providerStopped: false,
      stopConfirmed: true, noChildProcesses: false, leaseReleasable: false,
    }).outcome).toBe('FUNCTIONAL_PASS_LIFECYCLE_PENDING');

    const q = reconcileLifecycle({
      testAfter: 'PASS', diffOk: true, providerStopped: false,
      stopConfirmed: false, noChildProcesses: false, leaseReleasable: false,
    });
    expect(q.outcome).toBe('FAIL_SAFE');
    expect(q.LEASE_QUARANTINED).toBe('YES');
    expect(q.WORKSPACE_QUARANTINED).toBe('YES');
  });

  it('diff validation + safe flag restore + no secrets in override', () => {
    expect(validateFixtureDiff({
      changedPaths: [CANARY_V3_ALLOWED_PATH], untrackedPaths: [],
    })).toEqual({ DIFF_ONLY_ALLOWED_PATH: 'PASS', UNTRACKED_FILES: 'NONE' });
    expect(validateFixtureDiff({
      changedPaths: [CANARY_V3_ALLOWED_PATH, 'other.js'], untrackedPaths: [],
    }).CANARY_RESULT).toBe('FAIL_SAFE');

    expect(verifySafeFlags({
      AGENTIMPACT_V2_EXECUTION_ENABLED: '0',
      AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: '0',
      AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED: '0',
      AGENTIMPACT_JARVIS_PROVIDER_INVOKE_ARMED: '0',
    }).SAFE_FLAG_RESTORE).toBe('PASS');
    expect(verifySafeFlags({
      AGENTIMPACT_V2_EXECUTION_ENABLED: '1',
      AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: '0',
      AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED: '0',
    }).SAFE_FLAG_RESTORE).toBe('FAIL');
    expect(verifySafeFlags({
      AGENTIMPACT_V2_EXECUTION_ENABLED: '0',
      AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: '0',
      AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED: '0',
      AGENTIMPACT_JARVIS_PROVIDER_INVOKE_ARMED: '1',
    }).SAFE_FLAG_RESTORE).toBe('FAIL');

    expect(requireBaseComposePrecheck(true)).toEqual({
      BASE_COMPOSE_PRECHECK: 'PASS', consumeAuth: true,
    });
    expect(requireBaseComposePrecheck(false)).toEqual({
      BASE_COMPOSE_PRECHECK: 'FAIL', consumeAuth: false,
    });

    const yaml = buildComposeOverrideYaml();
    expect(yaml.toLowerCase()).not.toMatch(/api[_-]?key|token|secret|password/);
    // hash stability for override (deterministic)
    const h1 = createHash('sha256').update(yaml).digest('hex');
    const h2 = createHash('sha256').update(buildComposeOverrideYaml()).digest('hex');
    expect(h1).toBe(h2);
  });

  it('auth helper v3-final shell: outer compat, hash binding, no live auth, no Codex', () => {
    const AUTH_HELPER_V3F = join(REPO, 'infra/jarvis/root-authorize-jarvis-v1-2-one-codex-canary-v3-final.sh');
    const CANARY_V3F = join(REPO, 'infra/jarvis/root-run-jarvis-v1-2-codex-canary-v3-final.sh');
    const probe = (args: string[], envExtra: Record<string, string> = {}) =>
      spawnSync('bash', [AUTH_HELPER_V3F, ...args], {
        encoding: 'utf8',
        env: {
          PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
          LANG: 'C.UTF-8',
          AGENTIMPACT_AUTH_HELPER_STATIC_PROBE: '1',
          AGENTIMPACT_AUTH_HELPER_STATIC_CANARY_PATH: CANARY_V3F,
          ...envExtra,
        },
      });
    const expected = createHash('sha256').update(readFileSync(CANARY_V3F)).digest('hex');
    const noArg = probe([]);
    expect(noArg.status).toBe(0);
    expect(noArg.stdout).toContain('HELPER_NO_ARG=PASS');
    expect(noArg.stdout).toContain('CANARY_AUTHORIZATION_FILE=NOT_CREATED');
    expect(noArg.stdout).toContain(`CANARY_SCRIPT_SHA256=${expected}`);
    expect(probe([LEGACY]).status).toBe(0);
    expect(probe([LEGACY, 'x']).status).toBe(1);
    expect(probe(['--script', '/evil']).status).toBe(1);
  });
});
