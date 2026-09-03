#!/usr/bin/env bash
# Migration fail-closed du seul pointeur PostgreSQL historique admissible.
set -euo pipefail

err() {
  echo "invalid_pg_backup_pointer" >&2
  exit 1
}

: "${ROLLBACK_PG_BACKUP_DIR:?}"
: "${HERMESCTL_REQUIRE_ROOT_OWNER:?}"

pointer="${ROLLBACK_PG_BACKUP_DIR}/latest-001.path"

[ -e "$pointer" ] || exit 3
[ ! -L "$pointer" ] || exit 3
[ -f "$pointer" ] || exit 3
[ "$(stat -c '%a' "$pointer")" = "644" ] || exit 3

if [ "$HERMESCTL_REQUIRE_ROOT_OWNER" = "true" ] &&
  [ "$(stat -c '%U:%G' "$pointer")" != "root:root" ]; then
  err
fi

[ "$(wc -l < "$pointer")" -eq 1 ] || err
IFS= read -r raw < "$pointer" || err
[ -n "$raw" ] || err
[[ "$raw" == /* ]] || err

canon_pgdir=$(readlink -f -- "$ROLLBACK_PG_BACKUP_DIR") || err
canon_dump=$(readlink -f -- "$raw") || err
[[ "$canon_dump" == "$canon_pgdir"/* ]] || err
[ ! -L "$raw" ] || err
[ -f "$raw" ] || err
[ -s "$raw" ] || err
[ "$(stat -c '%a' "$raw")" = "600" ] || err

if [ "$HERMESCTL_REQUIRE_ROOT_OWNER" = "true" ] &&
  [ "$(stat -c '%U:%G' "$raw")" != "root:root" ]; then
  err
fi

chmod 0600 "$pointer"
