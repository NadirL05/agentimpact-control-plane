#!/usr/bin/env bash
# Attend PostgreSQL AgentImpact (conteneur compose) — prêt réel, pas docker.service.
# Aucun secret : pg_isready dans le conteneur db.
# Usage systemd (root) : ExecStartPre=+/opt/agentimpact/scripts/wait-postgres-ready.sh
set -euo pipefail

COMPOSE_FILE="${AGENTIMPACT_COMPOSE_FILE:-/opt/agentimpact/compose.yml}"
TIMEOUT_SEC="${WAIT_POSTGRES_TIMEOUT_SEC:-90}"
INTERVAL_SEC="${WAIT_POSTGRES_INTERVAL_SEC:-2}"
# Surcharge tests uniquement (ne pas utiliser en prod).
CHECK_CMD="${WAIT_POSTGRES_CHECK_CMD:-}"

if ! [[ "$TIMEOUT_SEC" =~ ^[0-9]+$ ]] || [ "$TIMEOUT_SEC" -lt 1 ] || [ "$TIMEOUT_SEC" -gt 300 ]; then
  echo "wait_postgres_ready: invalid timeout" >&2
  exit 64
fi
if ! [[ "$INTERVAL_SEC" =~ ^[0-9]+$ ]] || [ "$INTERVAL_SEC" -lt 1 ] || [ "$INTERVAL_SEC" -gt 30 ]; then
  echo "wait_postgres_ready: invalid interval" >&2
  exit 64
fi

check_once() {
  if [ -n "$CHECK_CMD" ]; then
    # shellcheck disable=SC2086
    eval "$CHECK_CMD"
    return $?
  fi
  docker compose -f "$COMPOSE_FILE" exec -T db \
    pg_isready -U agentimpact_app -d agentimpact >/dev/null 2>&1
}

deadline=$((SECONDS + TIMEOUT_SEC))
while [ "$SECONDS" -lt "$deadline" ]; do
  if check_once; then
    echo "wait_postgres_ready: ok" >&2
    exit 0
  fi
  echo "wait_postgres_ready: waiting" >&2
  sleep "$INTERVAL_SEC"
done

echo "wait_postgres_ready: timeout_sec=${TIMEOUT_SEC}" >&2
exit 1
