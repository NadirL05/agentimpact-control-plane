# Runbook — Rollback Superset Execution Adapter

## Goal

Disable Superset as execution backend without removing code or breaking V1.

**No production deploy of this adapter is authorized by this PR.**

## Immediate disable (runtime)

1. Set `AGENTIMPACT_EXECUTION_BACKEND=custom` (or unset).
2. Ensure `AGENTIMPACT_V2_EXECUTION_ENABLED` is not `1` for business missions.
3. Restart Control Plane / workers that read env.
4. Confirm no new attempts receive `execution_backend=superset`.

## Credential / host

1. Keep Superset host unit disabled if unused: `agentimpact-superset-host.service`.
2. Do not copy `SUPERSET_API_KEY` into Control Plane process env.
3. Organization id stays process-only when probing; never commit it.

## Database

Migration `010` is **additive** (nullable columns + checks NOT VALID).

Rollback of schema is optional and should be a separate Nadir-approved migration.
Leaving columns NULL is safe while flags are OFF.

Do **not** reverse migrations `008` / `009` as part of this rollback.

## Quarantine

If a Superset workspace delete fails:

1. Mark lease `quarantined` with reason `cleanup_refused` (or equivalent).
2. Do **not** `rm -rf`.
3. Operator investigates via Hermès / typed API only.

## Publisher

Publisher credentials remain separate. Rollback never merges publisher into
Superset terminal env.

## Verification checklist

- [ ] `AGENTIMPACT_EXECUTION_BACKEND=custom`
- [ ] No live Codex/Cursor canary scheduled
- [ ] Custom worktree runtime still present (deprecated, not removed)
- [ ] Fencing / approvals / budgets / quotas unchanged
- [ ] Secret scan clean (no API key in logs or repo)
