#!/usr/bin/env bash
# Historical direct-token publisher. Kept as a tombstone so old automation
# fails closed instead of putting a GitHub credential in git's argv.
set -eu
echo 'DIRECT_GITHUB_PUBLISHER_DISABLED: use the approval-bound publisher service described in docs/ops/agentimpact-infrastructure-v2.md' >&2
exit 78
