# Worksheet — staging build hermesctl + reprise bundle (legacy app-dist)

Worktree : `/opt/agentimpact/runner/worktrees/hermesctl-legacy-dist-marker`
Branche : `fix/hermesctl-legacy-dist-marker`
Base : `origin/main` @ `4184ff3`

## Cause racine (staging) — déjà corrigée sur main

Le build Node s'exécute sous `hermes` dans `/var/lib/agentimpact-build/hermesctl-v1`.
`/var/lib/agentimpact` reste `root:root 0750` (non affaibli).

## Bug legacy app-dist (ce correctif)

Le premier déploiement a créé un bundle **noyau complet** sans état dist explicite :

| Élément bundle | État réel |
| --- | --- |
| `scripts/`, `app-src/`, `compose.yml` | présents |
| `pg-backup/latest-001.path` + dump | valides |
| `app-dist/` | **absent** |
| `app-dist.absent` | **absent** |

Sur disque : `/opt/agentimpact/app/dist` également absent ; migration 001 non appliquée.

Le code mergé classait ce bundle `complete` sans exiger `app-dist/` **ou** `app-dist.absent`.
Un redéploiement puis rollback **laisserait** le nouveau dist en place.

## Modèle d'état dist

| Observation | État |
| --- | --- |
| `app-dist/` seul | `dist_present` |
| `app-dist.absent` seul | `dist_absent` |
| les deux | conflit → `rollback_bundle_dist_state_conflict` |
| aucun | `legacy_unknown` |

Marqueur `app-dist.absent` : fichier régulier, pas de symlink, pas de bits group/other, `root:root` en production ; sinon `invalid_app_dist_absent_marker`.

## Migration sûre `legacy_unknown`

Uniquement si le **noyau** est complet :

1. Si `repo_root/app/dist` **absent** : créer atomiquement `app-dist.absent` (`mktemp` + `mv`, mode `0600`, `root:root` en prod) ; message `legacy_dist_marker_migrated` ; revalider ; `reuse_rollback_bundle=true` ; **aucun** nouveau dump / aucune réécriture scripts/compose/pointer.
2. Si `repo_root/app/dist` **présent** : échec immédiat `rollback_bundle_dist_state_unknown` (avant sync/migration) — pas de conjecture.
3. Si le seul écart est le pointeur historique `pg-backup/latest-001.path` en `root:root 0644`, il est migré à `0600` uniquement après validation de son format (une ligne, chemin absolu) et de sa cible canonique sous `pg-backup/` (`root:root 0600`, régulière, non-symlink, non vide). La migration journalise `legacy_pg_pointer_permissions_migrated`, ne réécrit ni contenu ni mtime, puis la validation stricte est relancée. Tout autre écart est refusé sans `chmod`.

Voir aussi `docs/hermesctl-resume-preflight-idempotency.md` (préflight `bridge.env` idempotent sur reprise).

## Stratégie de reprise (bundle)

Avant toute sync / migration (`tasks/hermesctl_v1_rollback_bundle.yml`) :

1. Détecter noyau + état dist.
2. `partial` → `rollback_bundle_incomplete`.
3. Conflit / marqueur invalide → échec générique.
4. `legacy_unknown` → migration ou échec (ci-dessus).
5. `complete` (dist connu) → réutilisation sans écrasement.
6. `absent` → créer bundle + dump ; si dist courant manquant → `app-dist.absent`.

Rollback : si `app-dist.absent` présent, **supprimer** `/opt/agentimpact/app/dist`.

## Commandes de vérification (sans secret)

```bash
stat -c '%U:%G %a' /var/lib/agentimpact
# attendu : root:root 750

test -d /var/lib/agentimpact/rollback/hermesctl-v1/scripts
test -d /var/lib/agentimpact/rollback/hermesctl-v1/app-src
test -s /var/lib/agentimpact/rollback/hermesctl-v1/compose.yml
test -f /var/lib/agentimpact/rollback/hermesctl-v1/pg-backup/latest-001.path

# Après reprise corrigée : exactement un des deux
test -f /var/lib/agentimpact/rollback/hermesctl-v1/app-dist.absent \
  || test -d /var/lib/agentimpact/rollback/hermesctl-v1/app-dist
# pas les deux
```

## Procédure de reprise (validation Nadir)

1. Merger / déployer ce correctif (sans Docker/migration hors playbook).
2. Relancer `hermesctl-v1.yml`.
3. Attendu : `legacy_dist_marker_migrated` puis `reuse_rollback_bundle=true`, pas de nouveau `pre-001-*.dump`.
4. Si dist courant était déjà présent sans état bundle → échec `rollback_bundle_dist_state_unknown` (intervention manuelle Nadir).

## Fichiers touchés

| Fichier | Rôle |
| --- | --- |
| `infra/ansible/tasks/hermesctl_v1_rollback_bundle.yml` | États dist + migration legacy |
| `infra/ansible/test_hermesctl_bundle_resume_runtime.py` | Tests runtime |
| `infra/ansible/test-fixtures/hermesctl-bundle-resume/*` | Fixtures |
| `infra/ansible/test_playbooks.py` | Tests statiques |
| `docs/hermesctl-build-staging-traversal.md` | Ce worksheet |
| `docs/hermesctl-v1.md` / `docs/deployment-backup-rollback.md` | Doc reprise |
