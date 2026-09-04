# Sauvegardes et restauration PostgreSQL (playbooks hermesctl / slack-grok)

Les playbooks produisent un `pg_dump` custom **avant** chaque migration :

| Playbook | Répertoire dump | Fichier pointeur |
| --- | --- | --- |
| hermesctl-v1 | `/var/lib/agentimpact/rollback/hermesctl-v1/pg-backup/` | `latest-001.path` |
| slack-grok-router-v1 | `/var/lib/agentimpact/rollback/slack-grok-router-v1/pg-backup/` | `latest-002.path` |

Propriétés :

- format `pg_dump --format=custom` ;
- dump et pointeur `root:root` `0600`, fichiers réguliers non symlink ;
- écriture atomique du pointeur (`mktemp` + `chmod 0600` + `mv`) ;
- cible du pointeur canonique confinée sous `pg-backup/` ;
- échec fail-closed si dump vide ou pointeur invalide (`invalid_pg_backup_pointer`, sans chemin) ;
- reprise idempotente : un `latest-00N.path` valide est réutilisé (dump initial non remplacé) ;
- Ansible annonce `pg_backup_00N=ok` (sans chemin ni contenu).

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

**Reprise de déploiement** : si ce bundle est déjà complet (scripts + app-src + compose + dump `latest-001.path` valide **et** `app-dist/` **ou** `app-dist.absent`), `hermesctl-v1.yml` le réutilise et **n'écrase pas** le dump pre-001 ni les sauvegardes sources. Un bundle partiel fait échouer le playbook (`rollback_bundle_incomplete`). Pointeur invalide → `invalid_pg_backup_pointer` (sans chemin). Bundle legacy sans état dist + `app/dist` courant absent → migration atomique `app-dist.absent` (`legacy_dist_marker_migrated`) ; si `app/dist` existe → `rollback_bundle_dist_state_unknown`. Les deux états dist simultanés → `rollback_bundle_dist_state_conflict`. Si `app-dist.absent` est présent, le rollback **supprime** `/opt/agentimpact/app/dist` au lieu de restaurer.

### slack-grok-router-v1 (`/var/lib/agentimpact/rollback/slack-grok-router-v1/`)

| Chemin | Contenu |
| --- | --- |
| `app-dist/` | dist pré-déploiement |
| `scripts/` | `grok-agent-run.sh`, `gateway-inbox-consumer.py` |
| `systemd/` | unités systemd installées |
| `tmpfiles/` | `agentimpact-slack-router.conf` |
| `config/` | `slack-router.env`, `grok-worker.env`, `gateway-inbox.env` (non secrets) |
| `pg-backup/*.dump` | dumps PostgreSQL (`root:root` `0600`, régulier, non vide) |
| `pg-backup/latest-002.path` | pointeur vers dump (cible régulière sous `pg-backup`, `root:root` `0600`, pas group/other) |

**Exclus** : credentials, tokens, `.env` racine avec `DB_PASSWORD`

**Reprise de déploiement** : si `latest-002.path` est déjà valide (régulier `0600`, dump associé non vide confiné sous `pg-backup/`), le playbook le réutilise et **n'écrase pas** le dump pre-002. Pointeur invalide → `invalid_pg_backup_pointer` (sans chemin).

**Rollback** (`slack-grok-router-v1-rollback.yml`) : stop services + restauration bundle ; **aucune** suppression de tables SQL ni `pg_restore --clean`.
