#!/usr/bin/env bash
# Lance une commande dans le contexte d'un profil AgentImpact.
#
# Ordre de chargement (le plus specifique gagne) :
#   1. /home/hermes/.hermes/.env            secrets partages, jamais dupliques
#   2. /opt/agentimpact/profiles/<p>/.env   surcharges du profil
#
# Usage :
#   run-with-profile.sh <profil> <commande...>
#   run-with-profile.sh agentimpact-growth ./scripts/fullenrich-enrich.sh <uuid> --dry-run
#   run-with-profile.sh agentimpact-growth env | grep PROFILE
#
# A utiliser dans les cron pour qu'une tache ne s'execute jamais avec les
# tokens ou la memoire d'un autre profil.

set -euo pipefail

PROFILES_DIR="${AGENTIMPACT_PROFILES_DIR:-/opt/agentimpact/profiles}"
SHARED_ENV="${HERMES_SHARED_ENV:-/home/hermes/.hermes/.env}"

usage() {
  echo "Usage: $(basename "$0") <profil> <commande...>" >&2
  echo "Profils: $(ls -1 "$PROFILES_DIR" 2>/dev/null | tr '\n' ' ')" >&2
  exit 64
}

[ $# -ge 2 ] || usage

PROFILE="$1"
shift

PROFILE_ENV="${PROFILES_DIR}/${PROFILE}/.env"

if [ ! -d "${PROFILES_DIR}/${PROFILE}" ]; then
  echo "Profil inconnu: ${PROFILE}" >&2
  usage
fi

if [ ! -f "$PROFILE_ENV" ]; then
  echo "Fichier manquant: ${PROFILE_ENV} (copier .env.example)" >&2
  exit 78
fi

set -a
# shellcheck disable=SC1090
[ -f "$SHARED_ENV" ] && . "$SHARED_ENV"
# shellcheck disable=SC1090
. "$PROFILE_ENV"
set +a

if [ -z "${HERMES_PROFILE:-}" ] && [ "$PROFILE" != 'client-template' ]; then
  echo "HERMES_PROFILE vide dans ${PROFILE_ENV}" >&2
  exit 78
fi

# HERMES_PROFILE attend le CHEMIN ABSOLU du profil, pas son nom : passer un
# nom nu fait retomber Hermes sur ~/.hermes/config.yaml sans avertissement,
# ce qui a fait tourner une mission entiere sous la mauvaise config.
HERMES_PROFILES_ROOT="${HERMES_PROFILES_ROOT:-/home/hermes/.hermes/profiles}"
if [ -n "${HERMES_PROFILE:-}" ] && [ ! -d "$HERMES_PROFILE" ]; then
  RESOLVED="${HERMES_PROFILES_ROOT}/${HERMES_PROFILE}"
  if [ -d "$RESOLVED" ]; then
    export HERMES_PROFILE="$RESOLVED"
  else
    echo "HERMES_PROFILE='${HERMES_PROFILE}' ne resout vers aucun dossier existant (essaye: ${RESOLVED})" >&2
    exit 78
  fi
fi

exec "$@"
