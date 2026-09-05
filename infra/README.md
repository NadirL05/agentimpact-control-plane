# Infra AgentImpact (scripts + config Hermes)

Ce dossier version-controle ce qui, jusqu'au 15 aout 2026, vivait uniquement
sur le VPS avec des `.bak` manuels : les scripts operationnels et la
configuration des profils Hermes. **Aucun secret ici** — `.gitignore` bloque
tout `.env` reel ; seuls les `.env.example` (gabarits sans valeurs) sont
suivis.

## scripts/

Deployes sur le VPS a `/opt/agentimpact/scripts/`. Beaucoup pilotent le
control plane via son API HTTP (`localhost:3000`), pas de dependance directe
au code TypeScript de `src/`.

- `run-with-profile.sh` — lance une commande dans le contexte d'un profil
  AgentImpact (charge `.env` partage + `.env` du profil).
- `dispatch-missions.sh` / `consume-dev-mission.sh` — bus de missions
  inter-agents (cron 2 et 3 min).
- `poll-replies.sh` — classification des reponses Gmail entrantes (cron 5 min).
- `gh-pr-flow.sh` — ouvre une branche + PR (main est protegee : push direct
  impossible, y compris avec un token admin).
- `test-all.sh` — types + tests unitaires + integration, en une commande.
- `integration-test.sh` — 36 controles sur le systeme reellement deploye.
- Le reste (`enrich-leads-*`, `fullenrich-*`, `approve-action.sh`,
  `generate-outreach-drafts.sh`) : scripts d'exploitation anterieurs a cette
  reorganisation, non re-audites ligne a ligne au-dela du scan de secrets.

## compose.yml, nginx-demos.conf

`compose.yml` deploye sur le VPS a `/opt/agentimpact/compose.yml`
(`docker compose up -d`). Inclut le service `demo-static` (nginx, sert
`/opt/agentimpact/demos/` sur `demo.agentimpact.fr`) — sites de demonstration
client statiques, expiration automatique par `scripts/expire-demos.sh`
(cron 4h du matin), sauf reponse du lead entre-temps (table
`conversations`).

## hermes-profiles/

`config.yaml` de chaque profil Hermes personnalise (`default` = config
globale `~/.hermes/config.yaml`, plus `dev-senior`, `agentimpact-growth`,
`briefs`, `agent-memoire-master`). Jamais les `.env` associes — secrets et
tokens y vivent, jamais suivis.

A redeployer sur le VPS : copier vers `/home/hermes/.hermes/config.yaml` ou
`/home/hermes/.hermes/profiles/<nom>/config.yaml`, puis
`systemctl restart hermes-gateway.service`.

MCP Brevo (profil `agentimpact-growth` uniquement) : voir
[docs/brevo-mcp-growth.md](../docs/brevo-mcp-growth.md) et
`infra/scripts/deploy-brevo-mcp-growth.sh`.

## ansible/ — SSH WireGuard runner

Playbook `infra/ansible/playbooks/wireguard-ssh-runner.yml` + rôle
`wireguard_ssh_runner` : pérennise la règle UFW prioritaire
`10.66.66.2 → 10.66.66.1:22 on wg0` **avant** le `LIMIT 22/tcp` public, et
le linger `agentimpact-runner`. Doc :
[docs/ops/wireguard-ssh-runner.md](../docs/ops/wireguard-ssh-runner.md).

## agentimpact-profiles/

`.env.example` (gabarits) des 5 profils AgentImpact
(`/opt/agentimpact/profiles/<nom>/`). Les vrais `.env` restent uniquement
sur le VPS.
