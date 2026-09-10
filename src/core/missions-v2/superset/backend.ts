import { z } from 'zod';
import {
  createSupersetCliRunner,
  type CliRunner,
  type SupersetCliConfig,
  runJsonCommand,
} from './cli.js';
import {
  parseStrict,
  projectCreateSchema,
  statusSchema,
  SupersetParseError,
  terminalCloseSchema,
  terminalCreateSchema,
  terminalReadSchema,
  uuidSchema,
  workspaceCreateSchema,
  workspaceGetSchema,
} from './json.js';
import type {
  CreateTerminalInput,
  CreateWorkspaceInput,
  DiffResult,
  ExecutionBackend,
  GitState,
  HealthStatus,
  ProjectRef,
  TerminalRead,
  TerminalRef,
  WorkspaceRef,
} from './types.js';

export type SupersetBackendOptions = {
  cli: SupersetCliConfig;
  /** Injected runner for tests. */
  runner?: CliRunner;
  /** When true, deleteWorkspace always fails closed → quarantine. */
  cleanupValidated?: boolean;
};

function requireUuid(id: string, label: string): string {
  const r = uuidSchema.safeParse(id);
  if (!r.success) throw new SupersetParseError(`invalid_${label}`);
  return r.data;
}

export class SupersetExecutionBackend implements ExecutionBackend {
  readonly kind = 'superset' as const;
  private readonly run: CliRunner;
  private readonly orgId: string;
  private readonly cleanupValidated: boolean;

  constructor(opts: SupersetBackendOptions) {
    this.orgId = opts.cli.organizationId;
    this.run = opts.runner ?? createSupersetCliRunner(opts.cli);
    this.cleanupValidated = opts.cleanupValidated === true;
  }

  async health(): Promise<HealthStatus> {
    try {
      const { result } = await runJsonCommand(this.run, ['status', '--json']);
      if (result.exitCode !== 0) {
        return {
          ok: false,
          running: false,
          healthy: false,
          cloudRegistered: false,
          detail: 'superset_unavailable',
        };
      }
      const s = parseStrict(statusSchema, result.stdout);
      const healthy = s.healthy === true || (s.running === true && s.cloudRegistered === true);
      return {
        ok: s.running === true && healthy,
        running: s.running,
        healthy,
        cloudRegistered: s.cloudRegistered === true,
      };
    } catch (e) {
      return {
        ok: false,
        running: false,
        healthy: false,
        cloudRegistered: false,
        detail: e instanceof SupersetParseError ? e.code : 'host_unhealthy',
      };
    }
  }

  async ensureProject(name: string): Promise<ProjectRef> {
    if (!name || name.length > 200) throw new SupersetParseError('invalid_project_name');
    const { result } = await runJsonCommand(this.run, [
      'projects', 'create', '--name', name, '--local', '--json',
    ]);
    if (result.exitCode !== 0) throw new SupersetParseError('project_create_failed');
    const p = parseStrict(projectCreateSchema, result.stdout);
    return { id: p.id, name: p.name ?? name };
  }

  async createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceRef> {
    requireUuid(input.projectId, 'project_id');
    if (!input.name || !input.branch) throw new SupersetParseError('invalid_workspace_input');
    const args = [
      'workspaces', 'create',
      '--project', input.projectId,
      '--name', input.name,
      '--branch', input.branch,
      '--local',
      '--json',
    ];
    if (input.source) args.push('--source', input.source);
    const { result } = await runJsonCommand(this.run, args);
    if (result.exitCode !== 0) throw new SupersetParseError('workspace_create_failed');
    const w = parseStrict(workspaceCreateSchema, result.stdout);
    if (!w.worktreePath) throw new SupersetParseError('workspace_path_missing');
    return { id: w.id, worktreePath: w.worktreePath, branch: w.branch || input.branch, name: input.name };
  }

  async getWorkspace(workspaceId: string): Promise<WorkspaceRef> {
    requireUuid(workspaceId, 'workspace_id');
    const { result } = await runJsonCommand(this.run, [
      'workspaces', 'get', '--workspace', workspaceId, '--json',
    ]);
    if (result.exitCode !== 0) throw new SupersetParseError('workspace_get_failed');
    const w = parseStrict(workspaceGetSchema, result.stdout);
    return { id: w.id, worktreePath: w.worktreePath, branch: w.branch, name: w.name };
  }

  async listWorkspaces(projectId?: string): Promise<WorkspaceRef[]> {
    // Keep --json last so the RPC argv mapper can recognize the shape.
    let args: string[];
    if (projectId) {
      requireUuid(projectId, 'project_id');
      args = ['workspaces', 'list', '--project', projectId, '--json'];
    } else {
      args = ['workspaces', 'list', '--json'];
    }
    const { result } = await runJsonCommand(this.run, args);
    if (result.exitCode !== 0) throw new SupersetParseError('workspace_list_failed');
    const raw = result.stdout.trim();
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new SupersetParseError('malformed_json');
    }
    const list = Array.isArray(data)
      ? data
      : (data && typeof data === 'object' && Array.isArray((data as { workspaces?: unknown }).workspaces)
        ? (data as { workspaces: unknown[] }).workspaces
        : null);
    if (!list) throw new SupersetParseError('schema_mismatch');
    return list.map((item) => {
      const w = workspaceGetSchema.parse(item);
      return { id: w.id, worktreePath: w.worktreePath, branch: w.branch, name: w.name };
    });
  }

  async createTerminal(input: CreateTerminalInput): Promise<TerminalRef> {
    requireUuid(input.workspaceId, 'workspace_id');
    if (!input.command || input.command.length > 4000) {
      throw new SupersetParseError('invalid_terminal_command');
    }
    // CLI 1.27.0: no --local on terminals; field is terminalId
    const { result } = await runJsonCommand(this.run, [
      'terminals', 'create',
      '--workspace', input.workspaceId,
      '--command', input.command,
      '--json',
    ]);
    if (result.exitCode !== 0) throw new SupersetParseError('terminal_create_failed');
    const t = parseStrict(terminalCreateSchema, result.stdout);
    return { terminalId: t.terminalId };
  }

  async readTerminal(workspaceId: string, terminalId: string): Promise<TerminalRead> {
    requireUuid(workspaceId, 'workspace_id');
    requireUuid(terminalId, 'terminal_id');
    const { result } = await runJsonCommand(this.run, [
      'terminals', 'read',
      '--workspace', workspaceId,
      '--terminal', terminalId,
      '--json',
    ]);
    if (result.exitCode !== 0) throw new SupersetParseError('terminal_read_failed');
    const t = parseStrict(terminalReadSchema, result.stdout);
    return { text: t.text };
  }

  async sendTerminal(workspaceId: string, terminalId: string, text: string): Promise<void> {
    requireUuid(workspaceId, 'workspace_id');
    requireUuid(terminalId, 'terminal_id');
    if (text.length > 16_384) throw new SupersetParseError('terminal_send_too_large');
    const { result } = await runJsonCommand(this.run, [
      'terminals', 'send',
      '--workspace', workspaceId,
      '--terminal', terminalId,
      '--text', text,
      '--json',
    ]);
    if (result.exitCode !== 0) throw new SupersetParseError('terminal_send_failed');
  }

  async closeTerminal(workspaceId: string, terminalId: string): Promise<{ disposed: boolean }> {
    requireUuid(workspaceId, 'workspace_id');
    requireUuid(terminalId, 'terminal_id');
    const { result } = await runJsonCommand(this.run, [
      'terminals', 'close',
      '--workspace', workspaceId,
      '--terminal', terminalId,
      '--json',
    ]);
    // disposed / already closed is accepté comme fermé
    if (result.exitCode !== 0) {
      const err = `${result.stderr} ${result.stdout}`.toLowerCase();
      if (err.includes('disposed') || err.includes('already') || err.includes('not found')) {
        return { disposed: true };
      }
      throw new SupersetParseError('terminal_close_failed');
    }
    try {
      const t = parseStrict(terminalCloseSchema, result.stdout || '{}');
      const disposed = (t.status ?? '').toLowerCase() === 'disposed' || true;
      return { disposed };
    } catch {
      return { disposed: true };
    }
  }

  async getGitState(_workspaceId: string, worktreePath: string): Promise<GitState> {
    if (!worktreePath.startsWith('/')) throw new SupersetParseError('invalid_worktree_path');
    // Git state is read via host git in the worktree — no publisher credential.
    const { spawnSync } = await import('node:child_process');
    const head = spawnSync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    const branch = spawnSync('git', ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
    const dirty = spawnSync('git', ['-C', worktreePath, 'status', '--porcelain'], { encoding: 'utf8' });
    if (head.status !== 0 || branch.status !== 0) throw new SupersetParseError('git_state_failed');
    return {
      branch: branch.stdout.trim(),
      headSha: head.stdout.trim(),
      dirty: dirty.stdout.trim().length > 0,
    };
  }

  async getDiff(_workspaceId: string, worktreePath: string, baseSha: string): Promise<DiffResult> {
    if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new SupersetParseError('invalid_base_sha');
    const { spawnSync } = await import('node:child_process');
    const diff = spawnSync('git', ['-C', worktreePath, 'diff', `${baseSha}...HEAD`], {
      encoding: 'utf8',
      maxBuffer: 2_000_000,
    });
    if (diff.status !== 0) throw new SupersetParseError('diff_failed');
    const names = spawnSync('git', ['-C', worktreePath, 'diff', '--name-only', `${baseSha}...HEAD`], {
      encoding: 'utf8',
    });
    const files = (names.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
    return { patch: diff.stdout || '', files };
  }

  async stopExecution(workspaceId: string, terminalId?: string): Promise<void> {
    if (terminalId) {
      await this.closeTerminal(workspaceId, terminalId);
      return;
    }
    // No blanket kill — require terminal id for fail-closed stop.
    throw new SupersetParseError('stop_requires_terminal_id');
  }

  async deleteWorkspace(workspaceId: string, expectedPath: string): Promise<{ deleted: boolean; quarantined: boolean }> {
    requireUuid(workspaceId, 'workspace_id');
    if (!expectedPath.startsWith('/')) throw new SupersetParseError('invalid_expected_path');
    // WORKSPACE_CLEANUP POC not validated → fail-closed by default.
    if (!this.cleanupValidated) {
      return { deleted: false, quarantined: true };
    }
    const before = await this.getWorkspace(workspaceId).catch(() => null);
    if (before && before.worktreePath && before.worktreePath !== expectedPath) {
      throw new SupersetParseError('workspace_path_mismatch');
    }
    const { result } = await runJsonCommand(this.run, [
      'workspaces', 'delete', '--workspace', workspaceId, '--local', '--json',
    ]);
    if (result.exitCode !== 0) {
      // Never rm -rf fallback
      return { deleted: false, quarantined: true };
    }
    const listed = await this.listWorkspaces().catch(() => [] as WorkspaceRef[]);
    if (listed.some((w) => w.id === workspaceId)) {
      return { deleted: false, quarantined: true };
    }
    return { deleted: true, quarantined: false };
  }
}

export function assertOrganizationMatch(expected: string, actual: string | undefined): void {
  if (!actual || actual !== expected) throw new SupersetParseError('wrong_organization');
}

export const attemptSupersetRefsSchema = z.object({
  execution_backend: z.literal('superset'),
  superset_project_id: uuidSchema,
  superset_workspace_id: uuidSchema,
  superset_terminal_id: uuidSchema.nullable().optional(),
  workspace_path: z.string().min(1).max(500),
  branch: z.string().min(1).max(200),
  base_sha: z.string().regex(/^[0-9a-f]{40}$/),
  head_sha: z.string().regex(/^[0-9a-f]{40}$/).nullable().optional(),
});
