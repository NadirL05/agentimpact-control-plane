# AgentImpact infrastructure V2 operations

This is the authoritative runbook for the AgentImpact control plane. The Git
repository and its reviewed convergence branch are the source of truth.
`/opt/agentimpact/app/.git` is historical and must never be used for a build.

## Architecture and trust boundaries

The request path is:

```text
operator -> OpenJarvis typed MCP tool -> AgentImpact operator API
         -> Hermes typed plan -> Control Plane policy
         -> scheduler -> approval/quota/budget -> attempt/lease/fence
         -> public Superset RPC socket -> private executor -> Superset
         -> Codex or Cursor
```

OpenJarvis and Hermes cannot invoke the Superset CLI, manipulate worktrees, or
reach the private executor. The API sees only
`/run/agentimpact-superset-rpc/bridge.sock`. The public bridge validates typed
requests and converts them to a fixed argv. The private service owns the
Superset credential and authenticated Codex runtime. Neither API nor workers
receive a GitHub token or Docker socket.

Publishing is a separate trust domain. It starts from an independently
validated artifact and a human-bound approval. The current live default is
OFF. The historical `infra/scripts/gh-pr-flow.sh` is a fail-closed tombstone
because it placed a token in git's argv. GitHub push, PR creation, optional
merge, and production deployment must stay outside the agent workspace and
must each consume the matching approval. The operator exposes only typed
prepare/execute requests; there is no generic shell or workspace deploy route.

## Services, identities, ports, and sockets

| Component | Identity | Endpoint | Credential owner |
| --- | --- | --- | --- |
| Control Plane API | container user `node` | `127.0.0.1:3000` | API bearer and application integrations only |
| PostgreSQL | container `agentimpact-db` | `127.0.0.1:5432` | application database role |
| ctl bridge | hardened systemd unit | `/run/agentimpact/hermesctl.sock` | bridge token file |
| Superset public bridge | `agentimpact-superset-rpc` | `/run/agentimpact-superset-rpc/bridge.sock` | no private credential |
| Superset private executor | `agentimpact-superset` | `/run/agentimpact-superset-rpc/executor.sock` | Superset and Codex auth |
| Superset host | `agentimpact-superset` | local PTY socket | dedicated Superset state |
| Hermès gateway | `hermes` | gateway/platform connections | Hermès home, mode `0700`/`0600` |
| V2 planning transport | `hermes` inside bubblewrap | typed inbox claim/complete only | dedicated narrow `planner` token; hidden from model child |
| Dashboard | systemd unit | `127.0.0.1:9120` | dashboard token |
| Codex worker | `agentimpact-codex-worker` | per-attempt systemd unit | one LoadCredential HMAC; no GitHub token |

Internet listeners are limited by UFW to SSH, HTTP/HTTPS, WireGuard, and the
existing Syncthing service. PostgreSQL, Control Plane, dashboard, Superset RPC,
and internal gateways use loopback or Unix sockets.

## Flags

Conservative production defaults are:

```text
AGENTIMPACT_V2_ENABLED=1
AGENTIMPACT_JARVIS_ENABLED=1
AGENTIMPACT_JARVIS_MUTATIONS_ENABLED=1
AGENTIMPACT_V2_EXECUTION_ENABLED=0
AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED=0
AGENTIMPACT_JARVIS_PROVIDER_INVOKE_ARMED=0
AGENTIMPACT_JARVIS_ROOT_ONE_SHOT_CANARY=0
AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED=0
AGENTIMPACT_PUBLISHER_ENABLED=0
AGENTIMPACT_DEPLOY_ENABLED=0
```

No single flag authorizes a provider call. The one-shot Codex canary additionally
requires a typed request, actor and organization ownership, mission/attempt and
workspace binding, fresh provider quota, bounded budget, exact approval, lease,
fence, worker allowlist, and the private bridge gate. The authorized script
enforces `MAX_CODEX_CALLS=1`, `PROVIDER_RETRIES=0`, `REAL_CURSOR_CALLS=0`, and
`CURSOR_FALLBACK=NO`. Do not run it without Nadir's explicit provider-call
authorization.

## Mission state and controls

OpenJarvis asks the operator API to admit a durable V2 mission. The Control
Plane queues it for the dedicated Hermès planning consumer, which validates
and stores the typed plan. Its narrow credential cannot access missions,
integrations, approvals, workers, Publisher or deploy and bubblewrap hides all
Control Plane credential paths from the model subprocess. The scheduler owns
backend selection. A planned mission reaches `ready`; it does not start a
coding provider automatically.

Execution uses durable `mission_attempts`, `budget_reservations`,
`mission_approval_bindings`, and `worktree_leases`. A budget moves through
requested/reserved and then consumed or released. Timeout, stop, and crash use
reconciliation. Approval binds mission, attempt, action payload, worker,
current head where applicable, expiry, and human approver. Operator or
synthetic quota observations never authorize execution; unknown, stale, and
exhausted fail closed.

A lease binds mission, attempt, repository/workspace, worker, and fencing
token. The database unique indexes permit one writer. Lease history is
immutable. Unconfirmed process stop or cleanup quarantines the lease and
workspace. Terminal mission states are completed, failed, cancelled,
awaiting reconciliation, or quarantined as presented by the operational API;
the durable schema uses `failed_permanent`, `blocked/reconciling`, and a
quarantined lease for the corresponding internal cases. Completion is accepted
only after worker identity, fence, callback, test/diff validation, and stop
proof checks.

## Clean-source deployment

Run from a clean authoritative checkout:

```bash
cd /opt/agentimpact/runner/worktrees/infra-final-codex
./infra/deploy/preflight.sh
```

Production deploy is deliberately impossible until Publisher has recorded an
executed repository-scoped PR action for the same commit. Compute the proposed
immutable release, ask OpenJarvis for `agentimpact.deploy.prepare` with the
Publisher action UUID, repository, protected base branch and current rollback
release, then approve its exact action UUID/hash through the separate admin
channel. Only then run:

```bash
sha=$(git rev-parse HEAD)
release="$(date -u +%Y%m%dT%H%M%SZ)-${sha:0:12}"
./infra/deploy/deploy.sh "$release" DEPLOY_ACTION_UUID DEPLOY_PAYLOAD_HASH
```

Do not call `agentimpact.deploy.execute` before this command while the optional
privileged deploy worker is absent: it reports the manual handoff as blocked
and deliberately leaves the exact approval unconsumed for `deploy.sh`.

The script atomically consumes the exact unexpired approval and independently
checks source, release, rollback, GitHub origin, protected branch, PR evidence
and Publisher action before the first live mutation. Reuse and cross-repository
approvals fail closed.

The host Google token must remain `0640 hermes:hermes`. The API receives only
the Hermes group GID and the single read-only token bind mount; it does not see
the rest of `/home/hermes`.

The host must provide Ubuntu's `bubblewrap` package. The deploy installs the
source-controlled `infra/apparmor/agentimpact-codex` profile, which grants
`userns` only to the root-managed Superset Codex binaries while preserving
`kernel.apparmor_restrict_unprivileged_userns=1` globally.

Preflight uses Node 22, builds compiled production output, lints, runs all
TypeScript and RPC tests, executes the PostgreSQL 16 concurrency tests, applies
migrations 001–017 in a disposable database, audits production and development
dependencies, validates Compose, and builds the image. Deploy creates an
immutable release in `/opt/agentimpact/releases`, captures a PostgreSQL custom
dump and live config, checks backup hashes, tags the prior image, updates the
stable symlinks, starts Compose without rebuilding, and runs health checks. An
error after the first live mutation invokes rollback automatically.

No deployment copies individual TypeScript files or patches a running
container. The reviewed deploy applies only migrations 016 and 017 after the
verified backup and exact deployment approval. Any future migration needs a
reviewed inventory, backup, disposable-chain validation, and an explicit
safe-migration decision.

## Health and ordinary operation

Run the complete installed health check:

```bash
sudo /opt/agentimpact/scripts/infra-v2-health.sh
sudo systemctl --failed --no-pager
sudo docker compose -f /opt/agentimpact/compose.yml ps
```

The supported personal layer is OpenJarvis; see
`docs/ops/openjarvis-agentimpact.md`. The old Jarvis route remains a V1
compatibility alias for the generic operator backend, not a second personal
assistant. Legacy health checks may use it through the authenticated helper:

```bash
cd /opt/agentimpact/current
request=$(mktemp)
python3 - "$request" <<'PY'
import json,sys,uuid
json.dump({"request_id":str(uuid.uuid4()),"organization_id":"org-agentimpact","message":"status"},open(sys.argv[1],"w"))
PY
./infra/scripts/cp-api.sh hermes POST /api/v2/jarvis/actions "$request"
unlink "$request"
```

This route is compatibility-only. New mission creation uses OpenJarvis; it
admits the mission and queues Hermès planning while provider execution remains
gated. For state tied to a mission, use typed calls with its UUID:

```bash
./infra/scripts/cp-api.sh hermes GET /api/v2/status?project=PLU-IA
./infra/scripts/cp-api.sh hermes GET /api/v2/missions/MISSION_UUID
./infra/scripts/cp-api.sh hermes GET /api/v2/missions/MISSION_UUID/events
```

`agent.stop`, tests, diff, publishing, and deploy use typed identifiers from
the mission status; they do not accept a PID, command, argv, or caller path.

No-model quota discovery runs only `account/rateLimits/read` inside the
dedicated authenticated runtime. Use the installed quota smoke script and
verify it reports provider provenance, freshness, and authorization class. It
must never infer availability from authentication alone. Cursor remains on the
historically validated Superset contract unless a change invalidates it.

## Incidents and lifecycle recovery

1. Read the mission, attempt, workspace, lease, quota, budget, approval, tests,
   diff, lifecycle, publisher/deploy, error, and timestamp fields through V2
   status and events.
2. Use typed `agent.stop`; never kill an arbitrary PID as the primary path.
3. Confirm the provider process and all child processes stopped.
4. Reconcile with the current worker identity and fencing token.
5. If confirmation or cleanup is uncertain, retain the quarantined lease and
   workspace. Never delete lease history or reuse the writer.

Expected stop evidence is `STOP_REQUEST=PASS` and `STOP_CONFIRMATION=PASS`.
Otherwise the safe result is `LEASE_QUARANTINED=YES` and
`WORKSPACE_QUARANTINED=YES`.

## Rollback

Every release prints its release ID and backup directory. Verify the snapshot,
then restore code/config/image with:

```bash
release=YYYYMMDDTHHMMSSZ-0123456789ab
sudo sh -c "cd /var/backups/agentimpact/releases/$release && sha256sum -c SHA256SUMS"
sudo /opt/agentimpact/current/infra/deploy/rollback.sh "$release"
sudo /opt/agentimpact/scripts/infra-v2-health.sh
```

The rollback does not overwrite PostgreSQL. Restoring the database is a
separate destructive recovery step and requires a confirmed business-data
decision. After approval, stop writers, restore the custom dump into a new
database, validate it, and switch over; do not restore over the live database.

The logrotate permission repair can be reverted with:

```bash
sudo setfacl --restore=/var/backups/agentimpact/live-fixes/20260911T002109Z-logrotate/log-acl.txt
```

## Removing temporary root access

The temporary grant is exactly
`/etc/sudoers.d/agentimpact-codex-bootstrap`. Restore the session ACL snapshot
and remove the grant from one already-authorized shell:

```bash
sudo sh -c 'setfacl --restore=/tmp/agentimpact-infra-session/pre-acl.txt && visudo -cf /etc/sudoers && unlink /etc/sudoers.d/agentimpact-codex-bootstrap && visudo -cf /etc/sudoers'
sudo -n true && echo UNEXPECTED_SUDO || echo TEMP_ROOT_ACCESS_REMOVED
```

This removes only the temporary broad grant. Do not change SSH keys, firewall
rules, or unrelated sudo policy.
