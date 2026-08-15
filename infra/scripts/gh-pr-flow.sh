#!/usr/bin/env bash
# Ouvre une branche + PR au lieu de pousser sur main.
#
# Depuis la protection de branche (main = required PR, enforce_admins),
# `git push origin main` echoue toujours, y compris pour le token owner.
# C'est voulu : cree pour que personne (humain ou agent) ne l'oublie.
#
# Usage : gh-pr-flow.sh <branch-name> <pr-title> [pr-body]
# Doit etre lance depuis un repo avec des commits locaux en avance sur main.

set -euo pipefail

[ $# -ge 2 ] || { echo "Usage: gh-pr-flow.sh <branch> <title> [body]" >&2; exit 64; }

BRANCH="$1"
TITLE="$2"
BODY="${3:-}"

set -a
[ -f /root/agents/.env ] && . /root/agents/.env
set +a

: "${GITHUB_TOKEN:?GITHUB_TOKEN manquant}"

REPO_URL="$(git remote get-url origin)"
REPO_SLUG="$(printf '%s' "$REPO_URL" | sed -E 's#.*github\.com[:/]([^/]+/[^/.]+)(\.git)?#\1#')"

git push "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO_SLUG}.git" "HEAD:refs/heads/${BRANCH}" 2>&1 |
  sed -E 's#https://[^@]*@#https://***@#g'

PR_BODY_JSON=$(python3 -c "
import json, sys
print(json.dumps({'title': sys.argv[1], 'head': sys.argv[2], 'base': 'main', 'body': sys.argv[3]}))
" "$TITLE" "$BRANCH" "$BODY")

curl --silent --show-error \
  -H "Authorization: Bearer ${GITHUB_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  -X POST "https://api.github.com/repos/${REPO_SLUG}/pulls" \
  -d "$PR_BODY_JSON"
