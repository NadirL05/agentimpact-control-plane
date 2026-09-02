# Sauvegardes et restauration PostgreSQL (playbooks hermesctl / slack-grok)

Les playbooks produisent un `pg_dump` custom **avant** chaque migration :

| Playbook | Répertoire dump | Fichier pointeur |
| --- | --- | --- |
| hermesctl-v1 | `/var/lib/agentimpact/rollback/hermesctl-v1/pg-backup/` | `latest-001.path` |
| slack-grok-router-v1 | `/var/lib/agentimpact/rollback/slack-grok-router-v1/pg-backup/` | `latest-002.path` |

Propriétés :

- format `pg_dump --format=custom` ;
- permissions `0600` (root uniquement) ;
- échec fail-closed si dump vide ;
- chemin enregistré dans Ansible via `debug` (sans contenu).

## Restauration manuelle (ne pas exécuter sans validation Nadir)

```bash
# Exemple migration 002 — remplacer DUMP par le chemin lu dans latest-002.path
docker compose -f /opt/agentimpact/compose.yml exec -T db \
  pg_restore -U agentimpact_app -d agentimpact --clean --if-exists \
  < /var/lib/agentimpact/rollback/slack-grok-router-v1/pg-backup/pre-002-YYYYMMDDHHMMSS.dump
```

## Contenu des bundles rollback (sans secrets)

### hermesctl-v1 (`/var/lib/agentimpact/rollback/hermesctl-v1/`)

| Chemin | Contenu |
| --- | --- |
| `scripts/` | scripts `/opt/agentimpact/scripts` |
| `app-src/` | sources `/opt/agentimpact/app/src` |
| `app-dist/` | artefacts `/opt/agentimpact/app/dist` |
| `compose.yml` | compose pré-déploiement |
| `pg-backup/*.dump` | dumps PostgreSQL (`0600`) |

**Exclus** : `/etc/agentimpact/credentials/*`, `/etc/agentimpact/tokens/*`

### slack-grok-router-v1 (`/var/lib/agentimpact/rollback/slack-grok-router-v1/`)

| Chemin | Contenu |
| --- | --- |
| `app-dist/` | dist pré-déploiement |
| `scripts/` | `grok-agent-run.sh`, `gateway-inbox-consumer.py` |
| `systemd/` | unités systemd installées |
| `tmpfiles/` | `agentimpact-slack-router.conf` |
| `config/` | `slack-router.env`, `grok-worker.env`, `gateway-inbox.env` (non secrets) |
| `pg-backup/*.dump` | dumps PostgreSQL (`0600`) |

**Exclus** : credentials, tokens, `.env` racine avec `DB_PASSWORD`
