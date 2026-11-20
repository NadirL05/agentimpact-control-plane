import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  assertCanaryAuthorization,
  assertApprovalBindingMatch,
  buildCanaryFixturePolicy,
  buildTypedAgentCreateRpc,
  canaryApprovalPayloadHash,
  codexAuthContextInvariants,
  OneShotCodexCallGuard,
  providerInvokeArmed,
  validateCanaryDiff,
  verifyStageReports,
  NADIR_AUTHORIZATION_VALUE,
  CANARY_ALLOWED_PATH,
} from './codex-canary.js';
import {
  brokenIncrementSource,
  fixedIncrementSource,
  incrementTestSource,
  packageJsonSource,
} from './canary-fixture.js';
import { randomUUID } from 'node:crypto';

describe('Jarvis V1.2 armed Codex canary (static / no-model)', () => {
  it('refuses unless BOTH authorization variables match exactly', () => {
    expect(assertCanaryAuthorization({}).ok).toBe(false);
    expect(assertCanaryAuthorization({
      AGENTIMPACT_JARVIS_V1_2_CANARY_AUTHORIZED: '1',
    }).ok).toBe(false);
    expect(assertCanaryAuthorization({
      AGENTIMPACT_JARVIS_V1_2_CANARY_AUTHORIZED: '1',
      NADIR_AUTHORIZATION: 'YES',
    }).ok).toBe(false);
    expect(assertCanaryAuthorization({
      AGENTIMPACT_JARVIS_V1_2_CANARY_AUTHORIZED: '1',
      NADIR_AUTHORIZATION: NADIR_AUTHORIZATION_VALUE,
    })).toEqual({ ok: true, authorization: 'PASS' });
  });

  it('requires Stage A/B report PASS markers (does not trust env alone)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jarvis-v12-reports-'));
    try {
      expect(verifyStageReports(dir).reason).toBe('stage_report_pass_markers_missing');
      writeFileSync(join(dir, 'jarvis-v1-2-stage-a-x.txt'), [
        'STAGE_A_NO_MODEL_SMOKE=PASS',
        'PROVIDER_EXECUTION_BLOCKED_BY_FLAG=PASS',
        'REAL_CODEX_CALLS=0',
      ].join('\n'));
      writeFileSync(join(dir, 'jarvis-v1-2-stage-b-x.txt'), [
        'STAGE_B_FLAG_MATRIX=PASS',
        'V2_EXECUTION_GATE=PASS',
        'SUPERSET_AGENT_GATE=BLOCKED',
        'POST_STAGE_B_FLAGS=SAFE',
      ].join('\n'));
      const check = verifyStageReports(dir);
      expect(check.stage_a).toBe(true);
      expect(check.stage_b).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enforces one Codex call max and forbids Cursor/retry', () => {
    const g = new OneShotCodexCallGuard();
    g.recordCodexCall();
    expect(g.snapshot()).toEqual({
      REAL_CODEX_CALLS: 1,
      REAL_CURSOR_CALLS: 0,
      PROVIDER_RETRIES: 0,
      REAL_AGENT_CALLS: 1,
    });
    expect(() => g.recordCodexCall()).toThrow(/REAL_CODEX_CALLS_EXCEEDED/);
    expect(() => g.recordCursorCall()).toThrow(/CURSOR/);
    expect(() => g.recordRetry()).toThrow(/RETRIES/);
  });

  it('validates approval binding and worker=codex only', () => {
    const binding = {
      organization_id: 'org-canary',
      mission_id: randomUUID(),
      attempt_id: randomUUID(),
      worker_type: 'codex' as const,
      request_id: randomUUID(),
      budget_ceiling: 1,
      actor: 'nadir',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      reason: 'one_codex_canary',
    };
    const hash = canaryApprovalPayloadHash(binding);
    expect(assertApprovalBindingMatch({ ...binding, payload_hash: hash }, binding).APPROVAL_BINDING).toBe('PASS');
    expect(assertApprovalBindingMatch({
      ...binding,
      payload_hash: hash,
      mission_id: randomUUID(),
    }, binding).APPROVAL_BINDING).toBe('FAIL');
  });

  it('builds typed agent.create RPC with codex only (no argv/shell)', () => {
    const req = buildTypedAgentCreateRpc({
      request_id: randomUUID(),
      mission_id: randomUUID(),
      attempt_id: randomUUID(),
      fencing_token: randomUUID(),
      workspace_id: randomUUID(),
      prompt: 'fix increment only',
    });
    expect(req.operation).toBe('agent.create');
    expect(req.parameters.agent).toBe('codex');
    expect(Object.keys(req.parameters).sort()).toEqual(['agent', 'prompt', 'workspace_id']);
  });

  it('diff allowlist rejects foreign paths', () => {
    const ok = validateCanaryDiff(`diff --git a/${CANARY_ALLOWED_PATH} b/${CANARY_ALLOWED_PATH}
--- a/${CANARY_ALLOWED_PATH}
+++ b/${CANARY_ALLOWED_PATH}
@@ -1 +1 @@
-return n;
+return n + 1;
`);
    expect(ok.DIFF_ONLY_ALLOWED_PATH).toBe('PASS');
    const bad = validateCanaryDiff(`diff --git a/src/evil.js b/src/evil.js
--- a/src/evil.js
+++ b/src/evil.js
`);
    expect(bad.DIFF_ONLY_ALLOWED_PATH).toBe('FAIL');
  });

  it('fixture is FAIL before fix and PASS after (deterministic local test)', () => {
    const root = mkdtempSync(join(tmpdir(), 'jarvis-v12-fixture-'));
    try {
      mkdirSync(join(root, 'src'));
      mkdirSync(join(root, 'test'));
      writeFileSync(join(root, 'package.json'), packageJsonSource());
      writeFileSync(join(root, 'src/increment.js'), brokenIncrementSource());
      writeFileSync(join(root, 'test/increment.test.js'), incrementTestSource());
      const before = spawnSync(process.execPath, ['--test', join(root, 'test/increment.test.js')], {
        encoding: 'utf8',
      });
      expect(before.status).not.toBe(0);
      writeFileSync(join(root, 'src/increment.js'), fixedIncrementSource());
      const after = spawnSync(process.execPath, ['--test', join(root, 'test/increment.test.js')], {
        encoding: 'utf8',
      });
      expect(after.status).toBe(0);
      expect(readFileSync(join(root, 'src/increment.js'), 'utf8')).toContain('n + 1');
      const policy = buildCanaryFixturePolicy(root);
      expect(policy.allowed_path).toBe(CANARY_ALLOWED_PATH);
      expect(policy.superset_agent_id).toBe('codex');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('provider invoke arming requires full multi-gate (V2+agent+armed+one-shot+publisher off)', () => {
    expect(providerInvokeArmed({})).toBe(false);
    expect(providerInvokeArmed({
      AGENTIMPACT_JARVIS_PROVIDER_INVOKE_ARMED: '1',
      AGENTIMPACT_JARVIS_ROOT_ONE_SHOT_CANARY: '1',
    })).toBe(false);
    expect(providerInvokeArmed({
      AGENTIMPACT_V2_EXECUTION_ENABLED: '1',
      AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: '1',
      AGENTIMPACT_JARVIS_PROVIDER_INVOKE_ARMED: '1',
      AGENTIMPACT_JARVIS_ROOT_ONE_SHOT_CANARY: '1',
      AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED: '0',
    })).toBe(true);
    expect(providerInvokeArmed({
      AGENTIMPACT_V2_EXECUTION_ENABLED: '1',
      AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: '1',
      AGENTIMPACT_JARVIS_PROVIDER_INVOKE_ARMED: '1',
      AGENTIMPACT_JARVIS_ROOT_ONE_SHOT_CANARY: '1',
      AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED: '1',
    })).toBe(false);
  });

  it('Codex contract invariants (no API key argv)', () => {
    expect(codexAuthContextInvariants()).toEqual({
      CODEX_DRIVER_MAPPING: 'PASS',
      CODEX_AUTH_CONTEXT: 'PASS',
      CODEX_API_KEY_ARGV: 'NO',
    });
  });
});
