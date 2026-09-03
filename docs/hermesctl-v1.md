# hermesctl v1

Client lecture + proposition pour Cursor (`agentimpact-runner`) via bridge Unix socket.

## Développement

Worktree Git canonique :

```text
/opt/agentimpact/runner/worktrees/hermesctl-v1-atomic
```

Branche : `feature/hermesctl-v1-atomic`

## Déploiement atomique

1. Installer tokens dans `/etc/agentimpact/tokens/{bridge,hermes,admin}.env`
2. Migrer scripts (`cp-api.sh` + scripts patchés)
3. Redémarrer API avec auth fail-closed
4. Activer `agentimpact-ctl-bridge.socket` puis `.service`
5. Ajouter `agentimpact-runner` au groupe `agentimpact-ctl`

Playbook : `infra/ansible/playbooks/hermesctl-v1.yml`

### Staging build (hermes)

Le build Node s'exécute sous `hermes` dans `/var/lib/agentimpact-build/hermesctl-v1` (parent `hermes:hermes 0750`).
Il **ne** passe **pas** par `/var/lib/agentimpact/build-staging` : `/var/lib/agentimpact` reste `root:root 0750` et n'est pas affaibli.

### Reprise après déploiement partiel

Si le bundle `/var/lib/agentimpact/rollback/hermesctl-v1` est **complet** (scripts, app-src, compose, dump `latest-001.path` valide **et** état dist explicite `app-dist/` ou `app-dist.absent`), le playbook le **réutilise** sans resynchroniser ni refaire `pg_dump`.
Un bundle **partiel** provoque un échec explicite (`rollback_bundle_incomplete`).
Cas **legacy** (noyau complet sans état dist) : si `app/dist` courant est absent, création atomique de `app-dist.absent` (`legacy_dist_marker_migrated`) puis réutilisation ; s'il est présent → `rollback_bundle_dist_state_unknown`.
Si `app/dist` était absent au premier backup, le marqueur `app-dist.absent` est enregistré ; le rollback **supprime** alors le dist créé par le déploiement.

Voir `docs/hermesctl-build-staging-traversal.md`.

### Permissions des fichiers token

| Fichier | Propriétaire final | Mode | Lu par |
| --- | --- | --- | --- |
| `bridge.env` | `agentimpact-ctl:agentimpact-ctl` | `0400` | `agentimpact-ctl-bridge` (systemd) |
| `hermes.env` | `root:root` | `0600` | API Docker (root conteneur) |
| `admin.env` | `root:root` | `0600` | API Docker (root conteneur) |

**Preflight** (avant création du compte `agentimpact-ctl`) : `bridge.env` peut être `root:root 0600` ou `root:agentimpact-ctl 0600` — aucune lecture group/other.

**Post-création compte** : le playbook impose `bridge.env` en `agentimpact-ctl:agentimpact-ctl 0400`. Le mode `0600 root:agentimpact-ctl` est incorrect : le groupe ne peut pas lire un fichier `0600` dont le propriétaire est root.

Le service systemd et le playbook utilisent le même chemin : `/etc/agentimpact/tokens/bridge.env` (`EnvironmentFile` dans `agentimpact-ctl-bridge.service`).

Les tâches Ansible n'affichent jamais le contenu des tokens (`stat` uniquement, pas de `slurp`/`cat`).

## Reconnexion Cursor après ajout au groupe

Linux n'applique pas un nouveau groupe à une session SSH existante.

1. Fermer la session Cursor distante
2. Se reconnecter en SSH (nouvelle session → groupes à jour)
3. Vérifier : `id agentimpact-runner` doit lister `agentimpact-ctl`
4. Tester : `hermesctl health`

## Rollback

`infra/ansible/playbooks/hermesctl-v1-rollback.yml`

Le rollback hermesctl-v1 :

- arrête `agentimpact-ctl-bridge.service` et `.socket` ;
- restaure dist, scripts, sources API et `compose.yml` ;
- **ne modifie pas** `/etc/agentimpact/tokens/*` (hors bundle, comme les credentials).

Après rollback, `bridge.env` conserve `agentimpact-ctl:agentimpact-ctl 0400` — état correct pour un futur redémarrage du bridge. Aucune action manuelle sur les permissions token n'est requise sauf retour complet à un état pré-hermesctl (hors scope du playbook).

## Interdictions v1

ACP, MCP, chat Hermès, dispatch, approve, merge, deploy, shell arbitraire.
