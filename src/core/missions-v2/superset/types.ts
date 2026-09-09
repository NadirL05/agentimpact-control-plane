/** Execution backend abstraction — Control Plane V2. */

export type ExecutionBackendKind = 'custom' | 'superset';

export type ProjectRef = {
  id: string;
  name?: string;
};

export type WorkspaceRef = {
  id: string;
  worktreePath: string;
  branch: string;
  name?: string;
};

export type TerminalRef = {
  terminalId: string;
};

export type TerminalRead = {
  text: string;
};

export type GitState = {
  branch: string;
  headSha: string;
  baseSha?: string;
  dirty: boolean;
};

export type DiffResult = {
  patch: string;
  files: string[];
};

export type HealthStatus = {
  ok: boolean;
  running: boolean;
  healthy: boolean;
  cloudRegistered: boolean;
  detail?: string;
};

export type CreateWorkspaceInput = {
  projectId: string;
  name: string;
  branch: string;
  /** Source repo URL or local path — never GitHub writable credentials. */
  source?: string;
};

export type CreateTerminalInput = {
  workspaceId: string;
  command: string;
};

export type WorkspaceIdentityExpectation = {
  workspaceId: string;
  projectId: string;
  worktreePath: string;
  branch: string;
  baseSha: string;
  headSha: string;
  attemptId: string;
  fencingToken: number;
  leaseId: string;
};

export interface ExecutionBackend {
  readonly kind: ExecutionBackendKind;
  health(): Promise<HealthStatus>;
  ensureProject(name: string): Promise<ProjectRef>;
  createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceRef>;
  getWorkspace(workspaceId: string): Promise<WorkspaceRef>;
  listWorkspaces(projectId?: string): Promise<WorkspaceRef[]>;
  createTerminal(input: CreateTerminalInput): Promise<TerminalRef>;
  readTerminal(workspaceId: string, terminalId: string): Promise<TerminalRead>;
  sendTerminal(workspaceId: string, terminalId: string, text: string): Promise<void>;
  closeTerminal(workspaceId: string, terminalId: string): Promise<{ disposed: boolean }>;
  getGitState(workspaceId: string, worktreePath: string): Promise<GitState>;
  getDiff(workspaceId: string, worktreePath: string, baseSha: string): Promise<DiffResult>;
  stopExecution(workspaceId: string, terminalId?: string): Promise<void>;
  /**
   * Fail-closed delete. On Superset refusal → quarantine (never rm -rf).
   */
  deleteWorkspace(workspaceId: string, expectedPath: string): Promise<{ deleted: boolean; quarantined: boolean }>;
}
