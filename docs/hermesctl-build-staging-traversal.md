# Worksheet — staging build hermesctl (traversal `/var/lib/agentimpact`)

Worktree : `/opt/agentimpact/runner/worktrees/hermesctl-build-staging-traversal`
Branche : `fix/hermesctl-build-staging-traversal`
Base : `origin/main` @ `446d592`

## Cause racine

Le build Node s'exécute en `become_user: hermes` dans :

```text
/var/lib/agentimpact/build-staging/hermesctl-v1
```

Or `/var/lib/agentimpact` est **`root:root 0750`**. Hermès n'a ni `x` sur le parent → `cd: Permission denied`, même si le sous-répertoire staging est `hermes:hermes 0750`.

**Interdit** : affaiblir `/var/lib/agentimpact` (chmod/chown) pour rendre le parent traversable.

## État partiel observé (incident réel)

| Élément | État |
| --- | --- |
| Compte `agentimpact-ctl` | Créé |
| `bridge.env` | `agentimpact-ctl:agentimpact-ctl 0400` |
| Bundle rollback `hermesctl-v1` | Présent (anciens scripts, `app-src`, `compose.yml`, dump PG) |
| `compose.yml` + `app/src` sur disque | Déjà synchronisés (état « nouveau ») |
| Migration 001 | Non appliquée |
| `app/dist` | Non installé depuis le staging |
| Conteneurs API/DB | Existants, non recréés |
| Bridge systemd | Absent / inactif |
| Build staging | Échec avant `npm ci` |

## Correction

| Avant | Après |
| --- | --- |
| `/var/lib/agentimpact/build-staging/hermesctl-v1` | `/var/lib/agentimpact-build/hermesctl-v1` |
| Parent non traversable par hermes | `/var/lib/agentimpact-build` = `hermes:hermes 0750` |

Le playbook :

1. crée `build_root_dir` puis `build_staging_dir` ;
2. vérifie `root:root 750` sur `/var/lib/agentimpact` (non modifié) ;
3. vérifie que hermes peut `cd` dans le staging **avant** `npm ci` ;
4. conserve `npm ci` / `npm run build` en hermes, suppression `node_modules` sous `app/src`, contrôles world-writable.

## Stratégie de reprise (bundle)

Avant toute sauvegarde / sync (tâches partagées `tasks/hermesctl_v1_rollback_bundle.yml`) :

1. **Détecter** le bundle `/var/lib/agentimpact/rollback/hermesctl-v1` :
   - `complete` = `scripts/` + `app-src/` + `compose.yml` + dump via `pg-backup/latest-001.path` valide ;
   - `absent` = rien d'utilisable ;
   - `partial` = **échec** (`rollback_bundle_incomplete`) — pas d'écrasement.
2. Si **complete** : `reuse_rollback_bundle=true` — **aucune** resynchronisation vers le bundle, **aucun** nouveau `pg_dump`.
3. Si **absent** : créer le bundle et le dump **avant** sync compose/API ; si `app/dist` manquait, écrire `app-dist.absent`.
4. Valider `latest-001.path` : sous `pg-backup`, cible régulière non vide, pas de symlink, `root:root`, pas de lecture group/other ; erreur générique `invalid_pg_backup_pointer` (sans chemin).

Rollback : si `app-dist.absent` est présent, **supprimer** `/opt/agentimpact/app/dist` au lieu de restaurer un dist inventé.

## Rollback

Playbook : `infra/ansible/playbooks/hermesctl-v1-rollback.yml` (inchangé pour le staging).

- Restaure scripts / app-src / compose / dist depuis le bundle.
- N'utilise pas `/var/lib/agentimpact-build`.
- L'ancien chemin `/var/lib/agentimpact/build-staging` peut rester orphelin (nettoyage manuel hors playbook, après validation Nadir).

## Commandes de vérification (sans secret)

```bash
# Parent inchangé
stat -c '%U:%G %a' /var/lib/agentimpact
# attendu : root:root 750

# Nouveau staging traversable par hermes
stat -c '%U:%G %a' /var/lib/agentimpact-build
stat -c '%U:%G %a' /var/lib/agentimpact-build/hermesctl-v1
# attendu : hermes:hermes 750

sudo -u hermes test -x /var/lib/agentimpact-build \
  && sudo -u hermes test -x /var/lib/agentimpact-build/hermesctl-v1 \
  && echo hermes_traverse_ok

# Bundle réutilisable (présence uniquement — pas de cat du dump)
test -d /var/lib/agentimpact/rollback/hermesctl-v1/scripts
test -d /var/lib/agentimpact/rollback/hermesctl-v1/app-src
test -s /var/lib/agentimpact/rollback/hermesctl-v1/compose.yml
test -f /var/lib/agentimpact/rollback/hermesctl-v1/pg-backup/latest-001.path
# taille dump sans afficher le chemin secret éventuel ailleurs :
pointer=/var/lib/agentimpact/rollback/hermesctl-v1/pg-backup/latest-001.path
test -s "$(tr -d '[:space:]' < "$pointer")" && echo dump_ok

# Pas de node_modules sous app/src
test ! -d /opt/agentimpact/app/src/node_modules && echo no_host_node_modules
```

## Procédure de reprise après merge (validation Nadir requise)

1. Merger / déployer le playbook corrigé (sans relancer Docker/migration hors playbook).
2. Confirmer bundle **complete** (commandes ci-dessus).
3. Relancer uniquement : `ansible-playbook …/infra/ansible/playbooks/hermesctl-v1.yml` (chemin worktree après checkout).
4. Attendu logs : `reuse_rollback_bundle=true`, pas de nouveau `pre-001-*.dump`, build dans `/var/lib/agentimpact-build/hermesctl-v1`.
5. Vérifier `app/dist`, migration 001, bridge systemd selon le playbook.
6. En cas d'échec : rollback via `hermesctl-v1-rollback.yml` (bundle initial intact).

## Fichiers touchés

| Fichier | Rôle |
| --- | --- |
| `infra/ansible/playbooks/hermesctl-v1.yml` | Staging + reprise bundle |
| `infra/ansible/test_playbooks.py` | Tests non-régression |
| `docs/hermesctl-build-staging-traversal.md` | Ce worksheet |
| `docs/hermesctl-v1.md` | Chemin staging + reprise |
| `docs/deployment-backup-rollback.md` | Note réutilisation bundle |
