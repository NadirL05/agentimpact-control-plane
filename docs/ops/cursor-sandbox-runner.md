# NADIR-26 — sandbox Cursor sous Superset

## Statut et décision

`CURSOR_SANDBOX_RUNTIME=PATCH_READY_NOT_LIVE_VERIFIED`

Le payload épinglé Cursor `2026.09.08-6caf4ff` échoue aujourd'hui avant tout
appel fournisseur : son helper natif ne peut pas créer de user namespace.
Deux contrôles indépendants l'expliquent :

1. `agentimpact-superset-host.service` a `RestrictNamespaces=yes` ;
2. `kernel.apparmor_restrict_unprivileged_userns=1` et aucun profil Cursor ne
   permet `userns`.

Un runner systemd séparé ne peut pas recevoir uniquement Cursor avec le contrat
Superset installé : `agents create --agent cursor-agent` lance le payload comme
descendant direct du host. Interposer un autre service demanderait une
modification non disponible du host Superset ou un contournement du garde.

Le correctif conserve donc le host principal et :

- autorise les types de namespaces au filtre systemd du host ;
- conserve `NoNewPrivileges=yes`, `PrivateTmp=yes`, `ProtectSystem=strict`, les
  capabilities vides et la restriction AppArmor globale ;
- accorde `userns` uniquement à
  `/var/lib/agentimpact-superset/toolchains/cursor/2026.09.08-6caf4ff/payload/cursorsandbox` ;
- vérifie avant chaque démarrage les SHA-256, propriétaires et modes du wrapper,
  de Node, du bundle JS et du helper ;
- exécute `cursorsandbox --preflight-only`, sans prompt, appel fournisseur ni
  commande dans le workspace ;
- rend le toolchain en lecture seule aussi dans l'exécuteur RPC privé.

Le garde Cursor et son permis root one-shot ne changent pas. `--sandbox
enabled` reste obligatoire.

## Effet sur les autres agents

Le redémarrage du host interrompt tous les agents/terminaux Superset qui en sont
descendants. Planifier une fenêtre sans tentative active et réconcilier toute
lease avant application. Le filtre systemd autorise ensuite les syscalls de
namespace à tous les descendants du host, mais le noyau/AppArmor continue de
refuser la création d'un user namespace à tout exécutable sauf le helper Cursor
exact. Sans user namespace ou capabilities, les autres types de namespaces ne
donnent pas de privilège supplémentaire aux autres agents.

## Prérequis root

- revue sécurité et approbation de ce commit ;
- aucune mission, canary, lease ou autorisation one-shot en cours ;
- Ubuntu AppArmor 4 avec
  `kernel.apparmor_restrict_unprivileged_userns=1` ;
- service `agentimpact-superset-host.service` sous
  `User=agentimpact-superset`, `NoNewPrivileges=yes`, `PrivateTmp=yes` et
  `ProtectSystem=strict` ;
- payload exact présent, root:root, non modifiable, avec les hashes intégrés au
  préflight ;
- `/usr/sbin/apparmor_parser`, `/sbin/sysctl`, `/usr/bin/timeout` et systemd ;
- shell administrateur root. Ne pas réutiliser ou élargir le permis one-shot du
  garde Cursor pour cette installation.

## Vérification sûre avant application

Depuis un checkout propre du commit approuvé :

```bash
cd /var/lib/agentimpact-superset/home/.superset/worktrees/agentimpact-control-plane/codex/cursor-sandbox-runner-20261012
python3 infra/ansible/test_cursor_sandbox_runner.py -q
bash -n infra/scripts/cursor-sandbox-preflight.sh
./infra/scripts/cursor-sandbox-preflight.sh --static
/usr/sbin/apparmor_parser -p infra/apparmor/agentimpact-cursor-sandbox >/dev/null
```

Le mode `--static` ne crée aucun namespace. Avant application, un lancement
manuel de `--runtime` depuis Superset doit encore produire `EPERM` ; ce constat
est attendu et ne doit pas être transformé en test CI.

## Mise en service administrateur

Ne jamais exécuter ni installer en root directement depuis le worktree
Superset, modifiable par `agentimpact-superset`. Root crée d'abord un checkout
detached depuis GitHub au SHA complet approuvé par la PR. L'URL ne contient
aucun secret : le dépôt est public. La PR publie le SHA complet à utiliser ; le
nom du staging doit contenir exactement ce SHA, sinon l'installateur refuse.

```bash
umask 022
sha=FULL_40_HEX_SHA_PINNED_IN_PR_COMMENT
stage="/var/lib/agentimpact-staging/nadir-26-$sha"
install -d -m 0755 -o root -g root /var/lib/agentimpact-staging
git clone --no-checkout https://github.com/NadirL05/agentimpact-control-plane.git "$stage"
git -C "$stage" checkout --detach "$sha"
test "$(git -C "$stage" rev-parse HEAD)" = "$sha"
test -z "$(git -C "$stage" status --porcelain)"
chown -R root:root "$stage" && chmod -R go-w "$stage"
```

Un clone déjà créé par root sous `umask 077` reste accepté : les sources
`0600` et scripts `0700` sont plus restrictifs et l'installateur vérifie
toujours propriétaire, groupe, absence d'écriture groupe/autrui, commit et
propreté Git. Il installe ensuite les destinations avec leurs modes explicites
`0644` ou `0755`; aucun `chmod` correctif du checkout n'est requis.

Après ce clone sécurisé, l'unique commande d'installation à coller dans la
console root hPanel est :

```bash
"$stage/infra/scripts/root-install-cursor-sandbox-runner.sh" --ack-agent-interruption
```

Le flag est l'accusé explicite déjà autorisé par le propriétaire ; aucune autre
question interactive n'est posée. L'installateur :

- vérifie checkout detached/propre, origine GitHub, ownership root, modes,
  identité systemd, hashes du payload et syntaxe AppArmor ;
- annonce `AGENT_INTERRUPTION=YES` avant tout changement ;
- sauvegarde chaque cible et l'état des services dans un bundle `0700` avec
  sommes SHA-256 avant la première mutation ;
- installe atomiquement les quatre artefacts et la commande de rollback ;
- redémarre seulement l'exécuteur privé s'il était actif, puis le host ;
- exige le préflight runtime dans l'invocation systemd courante ;
- déclenche automatiquement le rollback si une installation, un reload, un
  restart ou une vérification post-restart échoue ;
- retourne `ALREADY_CONVERGED` sans redémarrer si le même état a déjà réussi.

Un résultat `PATCH_APPLIED_PREFLIGHT_PASS_NOT_LIVE_VERIFIED` prouve uniquement
que le bac à sable peut être construit. Il ne prouve pas qu'un agent Cursor
complet fonctionne.

## Canal administrateur disponible

Aucun mécanisme distant existant n'est autorisé pour ce patch :

- le bridge `hermesctl` est non-root, sans capabilities, et limité à la lecture
  et aux propositions ;
- `agentimpact.deploy.execute` reste bloqué par `deploy_worker_unavailable` ;
- le déploiement général nécessite lui-même un shell sudo local et des preuves
  Publisher/déploiement sans rapport avec NADIR-26 ;
- GitHub Actions utilise un runner hébergé sans accès au VPS ;
- les playbooks Ansible sont locaux avec `become: true` et exigent donc aussi
  une autorité root sur l'hôte.

La console root hPanel reste nécessaire. Ne pas détourner le bridge, un agent,
le permis Cursor ou un workflow CI pour appliquer ces fichiers.

## Smoke test réel requis

Après succès du préflight, utiliser la procédure existante du garde, avec un
nouveau permis root one-shot explicitement approuvé, sur une revue jetable et
sans secret. Exiger simultanément :

- invocation du payload épinglé ;
- `--sandbox enabled` visible dans l'évidence du garde ;
- commande bornée en lecture seule dans le workspace ;
- code retour zéro et absence de
  `Sandbox mode is enabled but not available on this system` ;
- aucune tentative sans sandbox et aucune réutilisation du permis.

Avant ce smoke test, publier uniquement
`CURSOR_SANDBOX_RUNTIME=PATCH_APPLIED_PREFLIGHT_PASS`; ne pas annoncer Cursor
fonctionnel.

## Retour arrière

Le rollback interrompt à nouveau le host. Il ne supprime ni workspace, ni
lease, ni donnée Superset. L'installateur l'appelle automatiquement en cas
d'échec. Après une installation réussie, la commande manuelle courte est :

```bash
agentimpact-cursor-sandbox-rollback
```

Le script vérifie les sommes du bundle, restaure exactement présent/absent,
profil AppArmor, état des services et valeur `RestrictNamespaces`, puis devient
un no-op explicite après succès. Le résultat attendu est le retour à
`RestrictNamespaces=yes` et à l'échec Cursor `EPERM`, sans désactiver le sandbox
ni modifier le sysctl AppArmor.
