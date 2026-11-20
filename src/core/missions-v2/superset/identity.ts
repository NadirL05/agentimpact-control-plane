import { realpathSync, existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SupersetParseError } from './json.js';
import type { WorkspaceIdentityExpectation } from './types.js';

/**
 * PR46-style workspace identity — do not trust Superset worktree blindly.
 */
export function assertWorkspaceIdentity(expected: WorkspaceIdentityExpectation): void {
  if (!expected.worktreePath.startsWith('/')) {
    throw new SupersetParseError('invalid_worktree_path');
  }
  if (!existsSync(expected.worktreePath)) {
    throw new SupersetParseError('workspace_path_missing');
  }
  const st = lstatSync(expected.worktreePath);
  if (st.isSymbolicLink()) throw new SupersetParseError('workspace_symlink_forbidden');
  if (!st.isDirectory()) throw new SupersetParseError('workspace_not_directory');

  let resolved: string;
  try {
    resolved = realpathSync(expected.worktreePath);
  } catch {
    throw new SupersetParseError('workspace_realpath_failed');
  }
  if (resolved !== expected.worktreePath) {
    throw new SupersetParseError('workspace_realpath_mismatch');
  }

  const gitDir = spawnSync('git', ['-C', expected.worktreePath, 'rev-parse', '--git-dir'], { encoding: 'utf8' });
  const commonDir = spawnSync('git', ['-C', expected.worktreePath, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' });
  if (gitDir.status !== 0 || commonDir.status !== 0) {
    throw new SupersetParseError('gitdir_incoherent');
  }

  const head = spawnSync('git', ['-C', expected.worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const branch = spawnSync('git', ['-C', expected.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
  if (head.status !== 0 || branch.status !== 0) throw new SupersetParseError('git_state_failed');
  if (head.stdout.trim() !== expected.headSha) throw new SupersetParseError('head_sha_mismatch');
  if (branch.stdout.trim() !== expected.branch) throw new SupersetParseError('branch_mismatch');

  // base sha must be ancestor
  const ancestor = spawnSync(
    'git',
    ['-C', expected.worktreePath, 'merge-base', '--is-ancestor', expected.baseSha, 'HEAD'],
    { encoding: 'utf8' },
  );
  if (ancestor.status !== 0) throw new SupersetParseError('base_sha_not_ancestor');

  // Soft markers for lease/attempt/fence — caller must bind DB separately.
  if (!expected.attemptId || expected.fencingToken < 1 || !expected.leaseId) {
    throw new SupersetParseError('lease_or_fence_missing');
  }
  if (!expected.workspaceId || !expected.projectId) {
    throw new SupersetParseError('workspace_or_project_missing');
  }

  // Reject nested .git that is a file pointing outside expected common-dir (basic)
  const gitFile = join(expected.worktreePath, '.git');
  if (existsSync(gitFile) && lstatSync(gitFile).isFile()) {
    const content = readFileSync(gitFile, 'utf8');
    if (!content.startsWith('gitdir:')) throw new SupersetParseError('gitdir_incoherent');
  }
}

export type LeaseGuardInput = {
  activeLeaseAttemptId: string | null;
  requestedAttemptId: string;
  leaseStatus: 'active' | 'released' | 'quarantined' | string;
  fencingTokenStored: number;
  fencingTokenRequest: number;
  attemptDeadlineMs: number;
  nowMs?: number;
};

export function assertExecutionLease(input: LeaseGuardInput): void {
  const now = input.nowMs ?? Date.now();
  if (input.leaseStatus === 'quarantined') {
    throw new SupersetParseError('workspace_quarantined');
  }
  if (input.leaseStatus === 'active' && input.activeLeaseAttemptId
      && input.activeLeaseAttemptId !== input.requestedAttemptId) {
    throw new SupersetParseError('concurrent_workspace_writer');
  }
  if (input.fencingTokenRequest !== input.fencingTokenStored) {
    throw new SupersetParseError('stale_fencing_token');
  }
  if (input.attemptDeadlineMs > 0 && now > input.attemptDeadlineMs) {
    throw new SupersetParseError('stale_attempt');
  }
}
