# V2 Superset Execution Adapter (HYBRID)

## Decision

`SUPERSET_DECISION=HYBRID`

Superset is the preferred **execution backend** for worktree / terminal / process.
Control Plane retains scheduler, mission attempts, fencing, approvals, budgets,
quotas, events/audit, and publisher separation.

Custom R8.2 runtime status: **DEPRECATED_NOT_REMOVED** (frozen).

## Feature flags (OFF by default)

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENTIMPACT_EXECUTION_BACKEND` | `custom` | `custom` \| `superset` |
| `AGENTIMPACT_V2_EXECUTION_ENABLED` | unset | Master V2 execution gate |
| `AGENTIMPACT_SUPERSET_CLEANUP_VALIDATED` | unset | Must be `1` before deleteWorkspace may delete |
| `SUPERSET_ORGANIZATION_ID` | process-only | Injected at runtime; never hardcoded |
| `SUPERSET_API_KEY` | **forbidden in CP env** | Only via credential wrapper / LoadCredential |

Superset remains fully disableable by setting `AGENTIMPACT_EXECUTION_BACKEND=custom`.

## Mapping

`mission_attempts` remains the business source of truth.

Additive refs (migration `010_v2_superset_execution_adapter.sql`):

- `execution_backend`
- `superset_project_id` / `superset_workspace_id` / `superset_terminal_id`
- `workspace_path` / `branch`
- existing `base_sha` / `head_sha`

Preserved: `attempt_id`, `mission_id`, `plan_version`, `fencing_token`,
`deadline`, `status`, `worker_type`, budget binding, approval binding.

## Execution lease

`worktree_leases` is **not** dropped. Role evolves to **execution lease**:

- Superset owns the physical workspace.
- AgentImpact owns the right to use it.
- Blocks concurrent writers, quarantined reuse, stale attempt, stale fence.

## Terminal contract (CLI 1.27.0)

- create → `terminalId`
- read → `text`
- send → `--text`
- close (not stop); `disposed` = closed OK
- no `--local` on terminals; `--local` on host mutations that support it

## Cleanup

`WORKSPACE_CLEANUP` was **not** validated in the POC.

`deleteWorkspace()` is fail-closed: quarantine on refusal; **never** `rm -rf`.

## Codex / Cursor

- Codex: first worker path prepared (`prepareCodexViaSuperset`); **not** live.
- Cursor: same adapter prepared; not blocked on CLI install; `superset_ready=false`.

## Jarvis / Hermès

Jarvis → Hermès typed operator API → Control Plane → `SupersetExecutionBackend`.

No direct shell from Jarvis. See `JARVIS_OPERATOR_POLICY` (AUTO / APPROVAL / DENY).

## Scheduler

This adapter does **not** rewrite the Control Plane scheduler.
