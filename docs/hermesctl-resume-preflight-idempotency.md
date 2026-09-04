# Worksheet — reprise hermesctl : préflight `bridge.env` idempotent

Worktree : `/opt/agentimpact/runner/worktrees/hermesctl-resume-preflight-idempotency`
Branche : `fix/hermesctl-resume-preflight-idempotency`
Base : `origin/main` @ `20032f8`

## Incident

Reprise `hermesctl-v1.yml` échoue **avant mutation** :

```text
unexpected_bridge_owner_preflight:agentimpact-ctl:agentimpact-ctl
```

État légitime laissé par le premier déploiement partiel :

| Élément | État |
| --- | --- |
| `/etc/agentimpact/tokens/bridge.env` | `agentimpact-ctl:agentimpact-ctl` `0400` |
| Compte `agentimpact-ctl` | présent |
| Bridge systemd | inactif |
| Bundle rollback | intact |
| `app/dist` | absent |
| Migration 001 | absente |

## Cause

Le préflight n'acceptait que `root:root` et `root:agentimpact-ctl`, donc refusait l'état **final** que le même playbook impose après création du compte.

## Correction

Script partagé `infra/ansible/files/hermesctl_bridge_env_preflight.sh` :

1. `root:root` — aucune lecture group/other
2. `root:agentimpact-ctl` — aucune lecture group/other
3. `agentimpact-ctl:agentimpact-ctl` — mode exact `0400`, compte+groupe existants, fichier régulier non symlink, aucun bit group/other

Pas de lecture / affichage du contenu. Erreurs génériques (owner éventuellement cité, jamais le chemin ni le secret).

La tâche « Appliquer propriétaire bridge.env » reste `agentimpact-ctl:agentimpact-ctl` `0400` (idempotente).

## Inventaire d'audit — autres contrôles de reprise

| Contrôle | Refuse-t-il l'état final du playbook ? | Verdict |
| --- | --- | --- |
| Préflight `bridge.env` | Oui (bug) | **Corrigé** |
| Permissions tokens/credentials (group/other) | Non — `0400`/`0600` OK ; durci : refuse symlink + message sans chemin | OK / hygiène |
| Création groupe/user `agentimpact-ctl` | Non — `state: present` | OK |
| Apply + vérif finale `bridge.env` `0400` | Non — impose l'état final | OK |
| `hermes.env` / `admin.env` `root:root 0600` | Non — inchangés par le playbook | OK |
| Bundle rollback : pointeur PG `latest-001.path` | Oui — une ancienne version créait le pointeur `root:root 0644`, alors que la validation exige désormais `0600` | Corrigé : migration exclusive `0644`→`0600` après validation complète de la cible ; autres états refusés |
| Bundle rollback (reuse / legacy / partial) | Non — états `app-dist` déjà traités | OK |
| Pointeur `latest-002.path` du bundle Slack-Grok | Ancien flux : écriture non atomique, sans `chmod 0600`/`chown` explicites, debug exposant le chemin, pas de reprise | Corrigé dans `fix/slack-grok-final-preflight` (`slack_grok_pg_backup_002.yml`) |
| Staging `/var/lib/agentimpact-build` | Non — `file` + vérif `hermes:hermes 750` après création | OK |
| Unités systemd bridge | Non — `copy` + `enabled/started` idempotents | OK |
| `agentimpact-runner` ∈ `agentimpact-ctl` | Non — `append: true` | OK |
| Migration `001_cursor_proposals.sql` | Non — `CREATE TABLE/INDEX IF NOT EXISTS` | OK |
| `app/dist` ownership post-install | Non — vérifié après sync/chown | OK |
| `/var/lib/agentimpact` `root:root 750` | Non — assert de non-affaiblissement | OK |

Aucun autre préflight du même type (refus de l'état final auto-produit) identifié.

## Tests

- Runtime `test_hermesctl_bridge_preflight_runtime.py` (accept / reject / double préflight / no leak)
- Bundle resume 8/8 (non-régression)
- Statiques `test_playbooks.py`

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `infra/ansible/files/hermesctl_bridge_env_preflight.sh` | Logique préflight |
| `infra/ansible/playbooks/hermesctl-v1.yml` | Appel script + hygiène erreurs |
| `infra/ansible/test_hermesctl_bridge_preflight_runtime.py` | Runtime |
| `infra/ansible/test-fixtures/hermesctl-bridge-preflight/` | Fixture double run |
| `infra/ansible/test_playbooks.py` | Statiques |
| `docs/hermesctl-v1.md` | Doc reprise |
| `docs/hermesctl-build-staging-traversal.md` | Renvoi incident |
| `docs/hermesctl-resume-preflight-idempotency.md` | Ce worksheet |
