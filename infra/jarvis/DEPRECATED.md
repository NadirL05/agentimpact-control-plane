# Historical Jarvis deployment artifacts

The `PIN-*`, `root-deploy-*`, `root-run-*`, and old `root-authorize-*` files in
this directory are forensic records of staged canaries. They are not deployment
entrypoints and are intentionally non-executable.

The authoritative deployment flow is `infra/deploy/deploy.sh`. The only current
provider canary entrypoint is
`root-authorize-jarvis-v1-2-one-codex-canary-v2.sh`; it still requires the
explicit one-shot authorization argument and must never be called by routine
deployment automation.

Routine quota verification uses the no-model discovery command documented in
`docs/ops/agentimpact-infrastructure-v2.md`. Historical scripts must not be
copied into `/opt/agentimpact/app` or used to patch a running container.
