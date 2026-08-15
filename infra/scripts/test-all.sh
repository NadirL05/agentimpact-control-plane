#!/usr/bin/env bash
# Lance toute la verification du control plane, dans l'ordre du moins cher au
# plus cher : types, logique pure, puis systeme reellement deploye.
#
# Usage : test-all.sh

set -uo pipefail

SRC=/opt/agentimpact/app/src
failures=0

step() { printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }

step "1/3 Types (tsc)"
if (cd "$SRC" && npx tsc --noEmit); then echo "types ok"; else echo "TYPES KO"; failures=$((failures + 1)); fi

step "2/3 Logique pure (vitest)"
if (cd "$SRC" && npx vitest run 2>&1 | tail -8); then :; else failures=$((failures + 1)); fi

step "3/3 Systeme deploye (integration)"
if /opt/agentimpact/scripts/integration-test.sh; then :; else failures=$((failures + 1)); fi

printf '\n\033[1m===================================\033[0m\n'
if [ "$failures" -eq 0 ]; then
  printf '\033[32mTOUT EST VERT\033[0m\n'
else
  printf '\033[31m%d etape(s) en echec\033[0m\n' "$failures"
fi
exit "$failures"
