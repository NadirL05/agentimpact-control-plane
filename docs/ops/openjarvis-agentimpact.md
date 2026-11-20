# OpenJarvis operator layer for AgentImpact

## Pinned upstream and role

The personal/operator product is [OpenJarvis](https://github.com/open-jarvis/OpenJarvis),
not a second AgentImpact orchestrator.

```text
OPENJARVIS_UPSTREAM_URL=https://github.com/open-jarvis/OpenJarvis.git
OPENJARVIS_UPSTREAM_COMMIT=fbbdb23c86627c18b859369b19746a9245f1ce0b
OPENJARVIS_VERSION=v1.0.4.dev1107-7-gfbbdb23
```

The pin was inspected from upstream `main` on 2026-09-11. OpenJarvis provides
the local engine, agent, memory, voice, desktop and API experience. AgentImpact
remains authoritative for mission state, policy, approvals, quota, budget,
leases, fencing, Superset execution, publishing and deploy.

```text
Mac OpenJarvis -> signed operator request over WireGuard
  -> AgentImpact operator API -> Hermes plan -> Control Plane
  -> scheduler/policy/approval/quota/budget/lease/fence
  -> public Superset RPC -> private executor -> Codex/Cursor
```

No OpenJarvis runtime is installed as root on the VPS. The VPS adds only the
operator API and a revocable operator credential. The upstream API server is
useful on the Mac for the desktop UI and binds to `127.0.0.1:8000` only.

Legacy naming is classified as follows:

| Existing area | Classification | Migration treatment |
| --- | --- | --- |
| `/api/v2/jarvis/actions`, contract, policy and audit | `KEEP_AS_GENERIC_OPERATOR_API` / legacy naming only | Keep as the V1 compatibility surface; new clients use `/api/v2/operator/actions`. |
| Deterministic intent planner and Hermes mission handoff | `MIGRATE_TO_OPENJARVIS_ADAPTER` | OpenJarvis now performs intent collection and invokes typed tools; Control Plane remains authoritative. |
| `infra/jarvis` historical deployment/canary scripts | `DEPRECATE` | Retain for release/canary evidence; do not use for normal operation. |
| Any separate custom personal Jarvis runtime | `REMOVE_AFTER_MIGRATION` | No new service is deployed; remove only after confirming there are no external consumers. |

## Security boundary

The AgentImpact server implements 21 typed operations. The OpenJarvis model is
shown 20 of them: `agentimpact.approvals.approve` is intentionally withheld and
is accepted only through the separately authenticated admin channel. The
profile enables no OpenJarvis `shell_exec`, file-write, code
interpreter, browser, GitHub, database or Superset tool. The adapter accepts no
arbitrary command, argv, PID or filesystem path.

Requests use a dedicated `operator` bearer identity plus an HMAC over the exact
body, UTC timestamp and UUID nonce. The API allows two minutes of clock skew,
claims each nonce durably in PostgreSQL, caps request bodies at 64 KiB,
rate-limits the identity, binds it to
`org-agentimpact`, and writes the existing operator audit trail. The token is
revocable by replacing `/etc/agentimpact/tokens/operator.env` and restarting
only the API. Hermes, bridge, admin, Superset, Codex and GitHub credentials are
separate.

Hermès V2 planning uses a fifth, narrow `planner` token that authorizes only
health and typed inbox claim/complete. The model subprocess runs in bubblewrap
with `/run/credentials` and `/etc/agentimpact/tokens` hidden and credential
environment variables removed. Compromise of a mission prompt therefore does
not grant the broader Hermès API identity.

OpenJarvis upstream currently loads external MCP tools on `jarvis ask` and
`jarvis serve`; its interactive `jarvis chat` code path does not load them.
Use the server/desktop UI or `ask` commands below until upstream aligns that
path. The current upstream HTTP/desktop path considers configured tools
pre-approved. The adapter therefore requires a local, exact, 120-second,
one-shot confirmation file before cancellation, start/stop, test execution,
publication or deployment. MCP annotations are informational only; the local
confirmation and AgentImpact server gates are the enforcing controls.

## Mac installation

Prerequisites are an active WireGuard peer (`10.66.66.2`), Git, `uv`, Ollama
and a local chat model. Transfer the dedicated token without displaying it:

```bash
install -d -m 700 "$HOME/.openjarvis/agentimpact"
umask 077
ssh root@10.66.66.1 'cat /etc/agentimpact/tokens/operator.env' \
  >"$HOME/.openjarvis/agentimpact/operator.env"
chmod 600 "$HOME/.openjarvis/agentimpact/operator.env"
```

Copy `integrations/openjarvis/` from this repository to the Mac, then run:

```bash
cd integrations/openjarvis
./install-macos.sh
ollama pull qwen3.5:9b
```

The installer clones the canonical repository and checks out the exact pin. It
backs up an existing OpenJarvis config as `*.pre-agentimpact`, installs the MCP
adapter in the pinned virtual environment and `~/.local/bin`, and never copies
the token into the source checkout.

Start the local desktop/API backend:

```bash
~/.local/bin/agentimpact-openjarvis serve --host 127.0.0.1 --port 8000
```

Optional voice is local and never authorizes a destructive action by itself:

```bash
cd "$HOME/.local/share/agentimpact-openjarvis"
uv sync --extra server --extra speech --extra voice
~/.local/bin/agentimpact-openjarvis ask --agent orchestrator "Etat AgentImpact"
```

A keyboard shortcut or the OpenJarvis desktop application should call the
loopback server. Double-clap is intentionally not installed.

## Normal operation

```bash
~/.local/bin/agentimpact-openjarvis ask --agent orchestrator "Qu'est-ce qui tourne sur AgentImpact ?"
~/.local/bin/agentimpact-openjarvis ask --agent orchestrator "Montre les missions PLU-IA"
~/.local/bin/agentimpact-openjarvis ask --agent orchestrator "Pourquoi la mission UUID a echoue ?"
~/.local/bin/agentimpact-openjarvis ask --agent orchestrator "Corrige les tests PLU-IA avec Codex"
~/.local/bin/agentimpact-openjarvis ask --agent orchestrator "Montre le diff de la mission UUID"
~/.local/bin/agentimpact-openjarvis ask --agent orchestrator "Liste les approbations en attente"
```

High-risk flows are two phase: `publisher.prepare` or `deploy.prepare` returns
an action UUID, exact payload hash and expiry; a separate explicit request must
approve that exact tuple. Approval does not bypass Publisher/deploy flags,
credential checks, validation, or immutable release checks.

Production `deploy.prepare` additionally requires an already executed
Publisher action for the same commit, canonical repository and protected base
branch, including numeric PR evidence. The root deploy executor consumes the
approval exactly once and repeats those checks against the local GitHub origin.

OpenJarvis cannot approve its own action. Nadir approves through the existing
admin/dashboard/Slack channel, which records `human-admin`. Before asking
OpenJarvis to perform a destructive operator action, create one exact local
confirmation from an interactive terminal. For example:

```bash
agentimpact-openjarvis-confirm agentimpact.missions.cancel \
  '{"mission_id":"MISSION_UUID","reason":"operator requested cancellation"}'
~/.local/bin/agentimpact-openjarvis ask --agent orchestrator \
  "Annule la mission MISSION_UUID: operator requested cancellation"
```

The arguments must match byte-for-byte after canonical JSON normalization. The
grant expires after 120 seconds and is atomically consumed once. Voice input
cannot create it.

## VPS health and incidents

```bash
sudo /opt/agentimpact/scripts/infra-v2-health.sh
sudo systemctl --failed --no-pager
sudo docker compose -f /opt/agentimpact/compose.yml ps
```

The operator endpoint is published only on WireGuard
`10.66.66.1:3443`; HTTP is acceptable because the WireGuard tunnel supplies
authenticated encryption. Never publish port 3443 on `eth0`. The standard API
remains loopback-only on `127.0.0.1:3000`.

`AWAITING_RECONCILIATION` means stop is not proved: retain lease and workspace.
`LEASE_CONFLICT` means another generation owns the writer lease. Quota unknown,
stale or synthetic states fail closed. Publisher/deploy disabled means the
preparation may be inspected but no outbound effect occurred.

## Publisher, deploy and rollback

Publisher must use the repository-scoped GitHub App described by
`integrations/openjarvis/github-app-manifest.json`. Workers and OpenJarvis never
receive its private key. App creation/installation is a one-time external
account action by Nadir.

One-time provisioning:

1. In GitHub Settings → Developer settings → GitHub Apps, create from the
   checked-in manifest values, keeping webhooks inactive.
2. Install it only on `NadirL05/agentimpact-control-plane`.
3. Generate one private key and place it on the VPS as
   `/etc/agentimpact/publisher/github-app.pem`, owner `root:root`, mode `0600`.
4. Record only the App ID and installation ID in the root-owned Publisher
   environment. Do not put the private key or a personal token in the API,
   OpenJarvis, Hermès, Superset or a worker.

Until these external steps are complete, Publisher and production deploy stay
fail-closed; no personal broad GitHub token is an accepted substitute.

Rollback an AgentImpact release without overwriting PostgreSQL:

```bash
release=YYYYMMDDTHHMMSSZ-0123456789ab
sudo sh -c "cd /var/backups/agentimpact/releases/$release && sha256sum -c SHA256SUMS"
sudo /opt/agentimpact/current/infra/deploy/rollback.sh "$release"
sudo /opt/agentimpact/scripts/infra-v2-health.sh
```

Database restore is separate, destructive and requires a business-data
decision. Token rotation is non-destructive: replace the mode-0600 operator
file, restart the API, then securely replace the Mac copy.
