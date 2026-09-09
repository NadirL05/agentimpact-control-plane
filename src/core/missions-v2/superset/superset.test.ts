import { describe, expect, it, vi } from 'vitest';
import {
  extractJsonObject,
  parseStrict,
  projectCreateSchema,
  SupersetParseError,
  terminalCreateSchema,
  terminalReadSchema,
  workspaceCreateSchema,
} from './json.js';
import { redactSecrets } from './cli.js';
import { SupersetExecutionBackend } from './backend.js';
import { assertExecutionLease } from './identity.js';
import {
  isSupersetExecutionEnabled,
  resolveExecutionBackendMode,
  resolveSupersetRuntimeEnv,
} from './config.js';
import { prepareCodexViaSuperset, CODEX_SUPERSET_INVARIANTS } from './codex-via-superset.js';
import { AGENT_REGISTRY_V2, JARVIS_OPERATOR_POLICY } from './agent-registry.js';
import type { CliResult, CliRunner } from './cli.js';

const WS = '3f4d0e5c-918e-4ddd-8aa0-d75a5168cfd9';
const PROJ = '7e276c59-59ca-4745-82c5-17609af20028';
const TERM = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

function ok(stdout: string): CliResult {
  return { exitCode: 0, stdout, stderr: '', timedOut: false };
}

function mockRunner(handler: (args: string[]) => CliResult | Promise<CliResult>): CliRunner {
  return async (args) => handler(args);
}

describe('superset json parser', () => {
  it('parses terminal create terminalId', () => {
    const t = parseStrict(terminalCreateSchema, JSON.stringify({ terminalId: TERM }));
    expect(t.terminalId).toBe(TERM);
  });

  it('rejects id instead of terminalId (fail closed)', () => {
    expect(() => parseStrict(terminalCreateSchema, JSON.stringify({ id: TERM })))
      .toThrow(SupersetParseError);
  });

  it('parses terminal read text', () => {
    const t = parseStrict(terminalReadSchema, JSON.stringify({ text: 'hello' }));
    expect(t.text).toBe('hello');
  });

  it('parses project create', () => {
    const p = parseStrict(projectCreateSchema, JSON.stringify({ id: PROJ, name: 'poc' }));
    expect(p.id).toBe(PROJ);
  });

  it('parses workspace create with worktreePath', () => {
    const w = parseStrict(workspaceCreateSchema, JSON.stringify({
      id: WS,
      worktreePath: '/var/lib/agentimpact-superset/home/.superset/worktrees/x',
      branch: 'poc/execution-poc-1',
    }));
    expect(w.id).toBe(WS);
    expect(w.worktreePath).toContain('agentimpact-superset');
  });

  it('maps path alias to worktreePath', () => {
    const w = parseStrict(workspaceCreateSchema, JSON.stringify({
      id: WS,
      path: '/var/lib/agentimpact-superset/ws',
    }));
    expect(w.worktreePath).toBe('/var/lib/agentimpact-superset/ws');
  });

  it('rejects malformed json', () => {
    expect(() => extractJsonObject('not-json')).toThrow(/non_json|malformed/);
  });

  it('rejects empty output', () => {
    expect(() => extractJsonObject('')).toThrow(SupersetParseError);
  });

  it('unwraps data envelope', () => {
    const t = parseStrict(terminalCreateSchema, JSON.stringify({ data: { terminalId: TERM } }));
    expect(t.terminalId).toBe(TERM);
  });
});

describe('secret redaction', () => {
  it('never leaves API key patterns in logs', () => {
    expect(redactSecrets('SUPERSET_API_KEY=not-a-real-secret')).toContain('[REDACTED]');
    expect(redactSecrets('Bearer test.token.value')).toContain('[REDACTED]');
    const stripeLike = ['sk', 'live', ''].join('_');
    expect(redactSecrets(`prefix ${stripeLike} suffix`)).toContain('[REDACTED]');
  });
});

describe('feature flags', () => {
  it('defaults to custom backend', () => {
    expect(resolveExecutionBackendMode({})).toBe('custom');
    expect(isSupersetExecutionEnabled({})).toBe(false);
  });

  it('requires both flags for live superset', () => {
    expect(isSupersetExecutionEnabled({
      AGENTIMPACT_EXECUTION_BACKEND: 'superset',
      AGENTIMPACT_V2_EXECUTION_ENABLED: '1',
    })).toBe(true);
    expect(isSupersetExecutionEnabled({
      AGENTIMPACT_EXECUTION_BACKEND: 'superset',
    })).toBe(false);
  });

  it('rejects API key in process env', () => {
    expect(() => resolveSupersetRuntimeEnv({
      SUPERSET_ORGANIZATION_ID: 'org-abcdef12',
      SUPERSET_API_KEY: 'forbidden-in-cp-env',
    })).toThrow(/must_not_be_in_process_env/);
  });

  it('requires organization id', () => {
    expect(() => resolveSupersetRuntimeEnv({})).toThrow(/ORGANIZATION/);
  });
});

describe('SupersetExecutionBackend offline', () => {
  const cli = {
    binary: 'superset-cred-run',
    organizationId: 'org-abcdef12-3456-7890-abcd-ef1234567890',
  };

  it('maps project create', async () => {
    const backend = new SupersetExecutionBackend({
      cli,
      runner: mockRunner(() => ok(JSON.stringify({ id: PROJ, name: 'poc' }))),
    });
    const p = await backend.ensureProject('poc');
    expect(p.id).toBe(PROJ);
  });

  it('maps workspace create', async () => {
    const backend = new SupersetExecutionBackend({
      cli,
      runner: mockRunner(() => ok(JSON.stringify({
        id: WS,
        worktreePath: '/var/lib/agentimpact-superset/ws',
        branch: 'feat/x',
      }))),
    });
    const w = await backend.createWorkspace({
      projectId: PROJ,
      name: 'w1',
      branch: 'feat/x',
    });
    expect(w.id).toBe(WS);
    expect(w.worktreePath).toBe('/var/lib/agentimpact-superset/ws');
  });

  it('terminal create/read/send/close', async () => {
    const calls: string[][] = [];
    const backend = new SupersetExecutionBackend({
      cli,
      runner: mockRunner((args) => {
        calls.push(args);
        if (args.includes('create')) return ok(JSON.stringify({ terminalId: TERM }));
        if (args.includes('read')) return ok(JSON.stringify({ text: 'out' }));
        if (args.includes('send')) return ok('{}');
        if (args.includes('close')) return ok(JSON.stringify({ status: 'disposed' }));
        return { exitCode: 1, stdout: '', stderr: 'unknown', timedOut: false };
      }),
    });
    const t = await backend.createTerminal({ workspaceId: WS, command: 'echo hi' });
    expect(t.terminalId).toBe(TERM);
    expect(await backend.readTerminal(WS, TERM)).toEqual({ text: 'out' });
    await backend.sendTerminal(WS, TERM, 'input\n');
    expect(await backend.closeTerminal(WS, TERM)).toEqual({ disposed: true });
    expect(calls.every((c) => c.includes('--json'))).toBe(true);
    expect(calls.some((c) => c.includes('--local') && c.includes('terminals'))).toBe(false);
  });

  it('accepts disposed terminal as closed', async () => {
    const backend = new SupersetExecutionBackend({
      cli,
      runner: mockRunner(() => ({
        exitCode: 1,
        stdout: '',
        stderr: 'terminal already disposed',
        timedOut: false,
      })),
    });
    expect(await backend.closeTerminal(WS, TERM)).toEqual({ disposed: true });
  });

  it('fails closed on malformed output', async () => {
    const backend = new SupersetExecutionBackend({
      cli,
      runner: mockRunner(() => ok('not-json-at-all')),
    });
    await expect(backend.ensureProject('x')).rejects.toThrow(SupersetParseError);
  });

  it('fails on timeout', async () => {
    const backend = new SupersetExecutionBackend({
      cli,
      runner: mockRunner(() => ({
        exitCode: 1, stdout: '', stderr: '', timedOut: true,
      })),
    });
    await expect(backend.ensureProject('x')).rejects.toThrow(/timeout/);
  });

  it('reports unavailable host', async () => {
    const backend = new SupersetExecutionBackend({
      cli,
      runner: mockRunner(() => ({
        exitCode: 1, stdout: '', stderr: 'down', timedOut: false,
      })),
    });
    const h = await backend.health();
    expect(h.ok).toBe(false);
    expect(h.detail).toBe('superset_unavailable');
  });

  it('reports unhealthy host', async () => {
    const backend = new SupersetExecutionBackend({
      cli,
      runner: mockRunner(() => ok(JSON.stringify({
        running: true, healthy: false, cloudRegistered: false,
      }))),
    });
    const h = await backend.health();
    expect(h.ok).toBe(false);
  });

  it('rejects wrong workspace uuid', async () => {
    const backend = new SupersetExecutionBackend({
      cli,
      runner: mockRunner(() => ok('{}')),
    });
    await expect(backend.getWorkspace('not-a-uuid')).rejects.toThrow(/invalid_workspace/);
  });

  it('cleanup fail-closed quarantines when not validated', async () => {
    const backend = new SupersetExecutionBackend({
      cli,
      cleanupValidated: false,
      runner: mockRunner(() => ok('{}')),
    });
    const r = await backend.deleteWorkspace(WS, '/var/lib/agentimpact-superset/ws');
    expect(r).toEqual({ deleted: false, quarantined: true });
  });

  it('cleanup quarantines when delete refused', async () => {
    const backend = new SupersetExecutionBackend({
      cli,
      cleanupValidated: true,
      runner: mockRunner((args) => {
        if (args.includes('get')) {
          return ok(JSON.stringify({
            id: WS,
            worktreePath: '/var/lib/agentimpact-superset/ws',
            branch: 'b',
          }));
        }
        if (args.includes('delete')) {
          return { exitCode: 1, stdout: '', stderr: 'refused', timedOut: false };
        }
        return ok('[]');
      }),
    });
    const r = await backend.deleteWorkspace(WS, '/var/lib/agentimpact-superset/ws');
    expect(r.quarantined).toBe(true);
    expect(r.deleted).toBe(false);
  });

  it('rejects GitHub credential patterns in argv via runner', async () => {
    const { createSupersetCliRunner } = await import('./cli.js');
    const run = createSupersetCliRunner({
      binary: 'true',
      organizationId: 'org-abcdef12',
    });
    await expect(run(['auth', 'login', '--api-key', 'forbidden-on-argv']))
      .rejects.toThrow(/api_key_on_argv/);
  });
});

describe('execution lease guards', () => {
  it('blocks concurrent writer', () => {
    expect(() => assertExecutionLease({
      activeLeaseAttemptId: 'a',
      requestedAttemptId: 'b',
      leaseStatus: 'active',
      fencingTokenStored: 1,
      fencingTokenRequest: 1,
      attemptDeadlineMs: Date.now() + 60_000,
    })).toThrow(/concurrent/);
  });

  it('blocks quarantined workspace', () => {
    expect(() => assertExecutionLease({
      activeLeaseAttemptId: 'a',
      requestedAttemptId: 'a',
      leaseStatus: 'quarantined',
      fencingTokenStored: 1,
      fencingTokenRequest: 1,
      attemptDeadlineMs: Date.now() + 60_000,
    })).toThrow(/quarantined/);
  });

  it('blocks stale fencing token', () => {
    expect(() => assertExecutionLease({
      activeLeaseAttemptId: 'a',
      requestedAttemptId: 'a',
      leaseStatus: 'active',
      fencingTokenStored: 2,
      fencingTokenRequest: 1,
      attemptDeadlineMs: Date.now() + 60_000,
    })).toThrow(/stale_fencing/);
  });

  it('blocks stale attempt', () => {
    expect(() => assertExecutionLease({
      activeLeaseAttemptId: 'a',
      requestedAttemptId: 'a',
      leaseStatus: 'active',
      fencingTokenStored: 1,
      fencingTokenRequest: 1,
      attemptDeadlineMs: Date.now() - 1,
    })).toThrow(/stale_attempt/);
  });
});

describe('codex via superset preparation', () => {
  it('prepares without starting when disabled', async () => {
    const backend = new SupersetExecutionBackend({
      cli: { binary: 'x', organizationId: 'org-abcdef12' },
      runner: mockRunner(() => ok('{}')),
    });
    const r = await prepareCodexViaSuperset({
      backend,
      enabled: false,
      codexCommand: 'codex',
      identity: {
        workspaceId: WS,
        projectId: PROJ,
        worktreePath: '/var/lib/agentimpact-superset/ws',
        branch: 'b',
        baseSha: '2d5bba47173be50b4cac804b6bc0aef58fae9963',
        headSha: '2d5bba47173be50b4cac804b6bc0aef58fae9963',
        attemptId: '11111111-1111-1111-1111-111111111111',
        fencingToken: 1,
        leaseId: '22222222-2222-2222-2222-222222222222',
      },
      lease: {
        activeLeaseAttemptId: '11111111-1111-1111-1111-111111111111',
        requestedAttemptId: '11111111-1111-1111-1111-111111111111',
        leaseStatus: 'active',
        fencingTokenStored: 1,
        fencingTokenRequest: 1,
        attemptDeadlineMs: Date.now() + 60_000,
      },
    });
    expect(r.message).toBe('codex_superset_prepared_not_started');
    expect(CODEX_SUPERSET_INVARIANTS).toContain('no_publisher_credential');
  });
});

describe('agent registry + jarvis policy', () => {
  it('lists CODEX ready and CURSOR prepared-not-ready', () => {
    const codex = AGENT_REGISTRY_V2.find((a) => a.id === 'CODEX');
    const cursor = AGENT_REGISTRY_V2.find((a) => a.id === 'CURSOR');
    expect(codex?.superset_ready).toBe(true);
    expect(codex?.enabled).toBe(false);
    expect(cursor?.superset_ready).toBe(false);
  });

  it('denies unrestricted shell and docker.sock', () => {
    expect(JARVIS_OPERATOR_POLICY.DENY).toContain('docker.sock');
    expect(JARVIS_OPERATOR_POLICY.DENY).toContain('unrestricted_root_shell');
    expect(JARVIS_OPERATOR_POLICY.APPROVAL).toContain('push');
  });
});

describe('recovery marker', () => {
  it('health ok after simulated host restart (status recovers)', async () => {
    let n = 0;
    const backend = new SupersetExecutionBackend({
      cli: { binary: 'x', organizationId: 'org-abcdef12' },
      runner: mockRunner(() => {
        n += 1;
        if (n === 1) {
          return { exitCode: 1, stdout: '', stderr: 'down', timedOut: false };
        }
        return ok(JSON.stringify({
          running: true, healthy: true, cloudRegistered: true,
        }));
      }),
    });
    expect((await backend.health()).ok).toBe(false);
    expect((await backend.health()).ok).toBe(true);
  });
});

// silence unused vi if any
void vi;
