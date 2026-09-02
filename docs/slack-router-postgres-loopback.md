# Worksheet — publication PostgreSQL loopback (routeur Slack Grok)

Worktree : `/opt/agentimpact/runner/worktrees/slack-router-postgres-loopback`
Branche : `fix/slack-router-postgres-loopback`
Base : `origin/main` @ `31471ede90e290f962edda82c81fdb3dd3c2f8ab`

## Constat

- Le service systemd `agentimpact-slack-router` exige PostgreSQL sur `PGHOST=127.0.0.1` / `PGPORT=5432`.
- Le conteneur Docker Compose `db` (`agentimpact-db`) est **healthy** mais n’expose **aucun** port sur l’hôte (`ss` ne voit pas `:5432`).
- `docker compose ps` affiche seulement `5432/tcp` (port interne réseau bridge).
- Au démarrage, le routeur échoue en boucle : stockage Postgres indisponible côté hôte.

## Cause racine

`infra/compose.yml` ne publiait pas le service `db` sur l’interface loopback de l’hôte. Seul le service `api` avait une publication `127.0.0.1:3000:3000`. Les processus **hors** du réseau Compose (routeur systemd) ne pouvaient pas joindre PostgreSQL.

## Architecture retenue

| Composant | Accès PostgreSQL |
| --- | --- |
| `api` (conteneur) | `PGHOST=db` — réseau Docker interne |
| `agentimpact-slack-router` (systemd hôte) | `PGHOST=127.0.0.1` — via publication loopback |
| Migrations Ansible | `docker compose exec -T db psql … < fichier.sql` — **inchangé** |

Publication ajoutée **exclusivement** :

```yaml
ports:
  - "127.0.0.1:5432:5432"
```

Interdictions explicites : `0.0.0.0:5432`, `:::5432`, ou tout binding public.

## Fichiers concernés

| Fichier | Changement |
| --- | --- |
| `infra/compose.yml` | Publication loopback `db` |
| `infra/test-fixtures/compose.config.env.example` | Fixture sans secret pour `docker compose config` |
| `infra/ansible/test_playbooks.py` | Tests non-régression Compose / template routeur |
| `docs/slack-router-postgres-loopback.md` | Ce worksheet |

**Inchangés (cohérence vérifiée)** :

- `infra/templates/slack-router.env.example` — `PGHOST=127.0.0.1`
- `src/slack-router/stores/pg-pool.ts` — lit `PGHOST` / `PGPORT`
- `infra/systemd/agentimpact-slack-router.service` — `PGPASSWORD` via LoadCredential
- Playbooks `hermesctl-v1*.yml`, `slack-grok-router-v1*.yml` — migrations via `exec -T db`

## Risques

| Risque | Mitigation |
| --- | --- |
| Recréation du conteneur `db` au prochain `compose up` | Volume `postgres_data` persiste ; **pg_dump obligatoire avant apply** |
| Exposition accidentelle de PostgreSQL | Binding strict `127.0.0.1` ; tests interdisent `0.0.0.0` / `::` |
| Conflit port 5432 local | Vérifier `ss -tlnp \| grep 5432` avant déploiement |

## Tests

- `infra/ansible/test_playbooks.py` — publication loopback, absence d’exposition publique, template routeur, `docker compose config`
- Suite CI habituelle : build, lint, Vitest, markdownlint, ansible syntax-check, npm audit

## Procédure de déploiement (Nadir — hors scope auto)

1. **Sauvegarde** : `pg_dump` via playbook ou commande documentée dans `slack-grok-router-v1.yml`.
2. Synchroniser `compose.yml` vers `/opt/agentimpact/compose.yml`.
3. `docker compose -f /opt/agentimpact/compose.yml up -d db` (recréation contrôlée possible).
4. Vérifier runtime (ci-dessous).
5. Déployer / démarrer routeur selon runbook existant.

## Vérification runtime

```bash
ss -tlnp | grep 5432
# Attendu : 127.0.0.1:5432 uniquement

docker compose -f /opt/agentimpact/compose.yml ps db
# Attendu : 127.0.0.1:5432->5432/tcp (pas seulement 5432/tcp)

docker compose -f /opt/agentimpact/compose.yml exec -T db pg_isready -U agentimpact_app -d agentimpact
```

## Rollback

1. Restaurer l’ancien `compose.yml` depuis le bundle rollback (`slack-grok-router-v1` ou sauvegarde manuelle).
2. `docker compose up -d db` — le volume `postgres_data` conserve les données.
3. Le routeur systemd redeviendra incapable de joindre Postgres jusqu’à nouvelle correction (comportement connu pré-fix).

## Interdiction d’exposition publique PostgreSQL

Ne **jamais** publier PostgreSQL sur `0.0.0.0`, `[::]` ou une interface autre que `127.0.0.1`. Toute PR modifiant `ports:` du service `db` doit conserver ce contrôle et faire passer les tests `ComposeRegressionTest`.
