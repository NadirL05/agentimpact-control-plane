# Prérequis worker Grok (installation manuelle)

Le playbook `slack-grok-router-v1.yml` **ne télécharge jamais** le CLI Cursor
automatiquement. Ces étapes sont à exécuter une fois, en root, avant le premier
déploiement sur une machine neuve.

## Compte système

```bash
# Idempotent — le playbook crée le compte s'il est absent sans modifier UID/GID existants
getent passwd cursor-grok-worker || useradd --system --home /var/lib/cursor-grok-worker \
  --shell /usr/sbin/nologin --user-group cursor-grok-worker
```

## CLI Cursor Agent

Installer le binaire dans le home du worker (exemple) :

```bash
sudo -u cursor-grok-worker bash -lc '
  mkdir -p ~/.local/bin
  # Installation selon la procédure Cursor validée par Nadir
  # Le binaire final doit être : ~/.local/bin/agent
  test -x ~/.local/bin/agent
  ~/.local/bin/agent --version
'
```

Le playbook vérifie :

- existence et exécutabilité de `/var/lib/cursor-grok-worker/.local/bin/agent` ;
- `agent --version` (aucun appel payant).

## Workspace

```bash
mkdir -p /opt/agentimpact/grokbot/workspace
chown cursor-grok-worker:cursor-grok-worker /opt/agentimpact/grokbot/workspace
chmod 0750 /opt/agentimpact/grokbot/workspace
```

## Credentials requis

| Fichier | Permissions attendues |
| --- | --- |
| `/etc/agentimpact/credentials/cursor-grok-api-key` | `0600` root:root |
| `/etc/agentimpact/credentials/slack-router-db-password` | `0600` root:root |
| `/etc/agentimpact/credentials/gateway-inbox-bridge-token` | `0600` root:root |
| `/etc/agentimpact/credentials/slack-router-bot-token` | `0600` root:root |
| `/etc/agentimpact/credentials/slack-router-app-token` | `0600` root:root |

Le token `gateway-inbox-bridge-token` doit correspondre au scope `bridge`
(`CTL_BRIDGE_TOKEN`).

## VPS actuel

Sur le VPS de production, ces prérequis sont déjà en place (smoke test Grok OK).
Le playbook les valide de manière idempotente sans réinstaller le CLI.
