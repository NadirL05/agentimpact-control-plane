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
| `app-dist/` | artefacts `/opt/agentimpact/app/dist` (si présents) |
| `app-dist.absent` | marqueur si aucun dist n'existait avant le déploiement |
| `compose.yml` | compose pré-déploiement |
| `pg-backup/*.dump` | dumps PostgreSQL (`0600`) |
| `pg-backup/latest-001.path` | pointeur vers dump (cible régulière sous `pg-backup`, `root:root`, pas group/other) |

**Exclus** : `/etc/agentimpact/credentials/*`, `/etc/agentimpact/tokens/*`

Le rollback hermesctl-v1 ne restaure ni ne modifie les permissions des fichiers token. `bridge.env` reste typiquement `agentimpact-ctl:agentimpact-ctl 0400` après rollback — compatible avec un redéploiement ou redémarrage manuel du bridge.

**Reprise de déploiement** : si ce bundle est déjà complet (scripts + app-src + compose + dump `latest-001.path` valide), `hermesctl-v1.yml` le réutilise et **n'écrase pas** le dump pre-001 ni les sauvegardes sources. Un bundle partiel fait échouer le playbook (`rollback_bundle_incomplete`). Pointeur invalide → `invalid_pg_backup_pointer` (sans chemin). Si `app-dist.absent` est présent, le rollback **supprime** `/opt/agentimpact/app/dist` au lieu de restaurer.

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
