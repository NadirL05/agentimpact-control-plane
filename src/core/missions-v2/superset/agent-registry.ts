/** Agent registry preparation for Superset-backed workers. Feature flags off. */

export type AgentCapability =
  | 'workspace.create'
  | 'terminal.read'
  | 'terminal.send'
  | 'diff.read'
  | 'tests.run'
  | 'agent.start'
  | 'agent.stop';

export type AgentRegistryEntry = {
  id: 'CODEX' | 'CURSOR' | 'GROK' | 'ANA' | 'GROK_BOT';
  enabled: boolean;
  execution_backend: 'superset' | 'custom';
  /** Ready means adapter path prepared — not live canary. */
  superset_ready: boolean;
  capabilities: AgentCapability[];
  notes: string;
};

export const AGENT_REGISTRY_V2: AgentRegistryEntry[] = [
  {
    id: 'CODEX',
    enabled: false,
    execution_backend: 'superset',
    superset_ready: true,
    capabilities: [
      'workspace.create', 'agent.start', 'terminal.read', 'terminal.send',
      'agent.stop', 'tests.run', 'diff.read',
    ],
    notes: 'First Superset worker; dedicated auth; no publisher credential; API fallback OFF.',
  },
  {
    id: 'CURSOR',
    enabled: false,
    execution_backend: 'superset',
    /** Not blocked on Cursor CLI install — prepared, not live. */
    superset_ready: false,
    capabilities: [
      'workspace.create', 'agent.start', 'terminal.read', 'terminal.send',
      'agent.stop', 'tests.run', 'diff.read',
    ],
    notes: 'Same adapter as Codex; enable only after Cursor CLI availability check.',
  },
  {
    id: 'GROK',
    enabled: false,
    execution_backend: 'superset',
    superset_ready: false,
    capabilities: ['workspace.create', 'agent.start', 'terminal.read', 'agent.stop', 'diff.read'],
    notes: 'Prepared slot; not wired.',
  },
  {
    id: 'ANA',
    enabled: false,
    execution_backend: 'superset',
    superset_ready: false,
    capabilities: ['workspace.create', 'agent.start', 'terminal.read', 'agent.stop'],
    notes: 'Prepared slot; not wired.',
  },
  {
    id: 'GROK_BOT',
    enabled: false,
    execution_backend: 'superset',
    superset_ready: false,
    capabilities: ['terminal.read', 'agent.stop'],
    notes: 'Prepared slot; not wired.',
  },
];

/** Jarvis → Hermès typed operator actions (not direct shell). */
export const JARVIS_OPERATOR_POLICY = {
  AUTO: [
    'status', 'workspace.create', 'agent.start', 'terminal.read', 'terminal.send',
    'agent.stop', 'tests.run', 'diff.read',
  ],
  APPROVAL: [
    'push', 'PR', 'merge', 'deploy', 'migrations', 'secrets', 'destructive', 'large_spend',
  ],
  DENY: [
    'unrestricted_root_shell', 'docker.sock', 'arbitrary_secret_reads', 'bypass_approvals',
  ],
} as const;
