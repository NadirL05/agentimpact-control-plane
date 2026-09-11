#!/usr/bin/env bash
# Jarvis V1.2 Codex canary — REFUSES to run until Nadir emits
# GATE_NADIR_JARVIS_V1_2_REAL_AGENT_CANARY_READY and sets
# AGENTIMPACT_JARVIS_V1_2_CANARY_AUTHORIZED=1.
#
# This script is intentionally a hard stop by default.
# outer-verify may pass unused tarball as $1 — ignore.
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "ERROR: must run as root" >&2
  exit 1
fi

echo "=== JARVIS V1.2 CODEX CANARY (GATED) ==="
echo "PUBLISHER=OFF"
echo "SUPERSET_AGENT_COMPLETION_DETECTOR_DEBT=OPEN"

if [[ "${AGENTIMPACT_JARVIS_V1_2_CANARY_AUTHORIZED:-0}" != "1" ]]; then
  echo "REFUSED: real agent canary not authorized."
  echo "Required:"
  echo "  1) GATE_NADIR_JARVIS_V1_2_REAL_AGENT_CANARY_READY emitted after Stage A/B"
  echo "  2) Nadir sets AGENTIMPACT_JARVIS_V1_2_CANARY_AUTHORIZED=1 for this run"
  echo "REAL_CODEX_CALLS=0"
  echo "REAL_CURSOR_CALLS=0"
  exit 2
fi

echo "ERROR: canary body not armed in this pin — awaiting separate Nadir authorization package." >&2
echo "REAL_CODEX_CALLS=0"
exit 3
