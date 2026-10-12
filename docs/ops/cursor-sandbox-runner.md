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
aucun secret ; l'administrateur doit employer son mécanisme GitHub root déjà
approuvé si le dépôt exige une authentification.

```bash
approved_sha=APPROVED_FULL_40_HEX_SHA_FROM_PR
case "$approved_sha" in (*[!0-9a-f]*|'') exit 64;; esac
test "${#approved_sha}" -eq 40
staging="/var/lib/agentimpact-staging/nadir-26-$approved_sha"
sudo test ! -e "$staging"
sudo install -d -m 0755 -o root -g root /var/lib/agentimpact-staging
sudo git clone --no-checkout https://github.com/NadirL05/agentimpact-control-plane.git "$staging"
sudo git -C "$staging" fetch origin "$approved_sha"
sudo git -C "$staging" checkout --detach "$approved_sha"
test "$(sudo git -C "$staging" rev-parse HEAD)" = "$approved_sha"
test -z "$(sudo git -C "$staging" status --porcelain)"
sudo chown -R root:root "$staging"
sudo chmod -R go-w "$staging"

sudo -u agentimpact-superset "$staging/infra/scripts/cursor-sandbox-preflight.sh" --static
sudo /usr/sbin/apparmor_parser -p "$staging/infra/apparmor/agentimpact-cursor-sandbox" >/dev/null
```

Le bundle fixe ci-dessous refuse explicitement l'écrasement. Conserver ce
bundle pour le rollback. Continuer dans le même shell, avec `staging` défini :

```bash
sudo test ! -e /var/lib/agentimpact/rollback/nadir-26-cursor-sandbox
sudo install -d -m 0700 /var/lib/agentimpact/rollback/nadir-26-cursor-sandbox
sudo systemctl is-active agentimpact-superset-host.service \
  | sudo tee /var/lib/agentimpact/rollback/nadir-26-cursor-sandbox/host.was-active >/dev/null
sudo systemctl is-active agentimpact-superset-private.service \
  | sudo tee /var/lib/agentimpact/rollback/nadir-26-cursor-sandbox/private.was-active >/dev/null || true

for spec in \
  /etc/apparmor.d/agentimpact-cursor-sandbox:apparmor \
  /etc/systemd/system/agentimpact-superset-host.service.d/50-cursor-sandbox.conf:host-dropin \
  /etc/systemd/system/agentimpact-superset-private.service.d/50-cursor-toolchain-readonly.conf:private-dropin \
  /usr/local/libexec/agentimpact-cursor-sandbox-preflight:preflight; do
  target="${spec%%:*}"
  name="${spec##*:}"
  if sudo test -e "$target"; then
    sudo cp -a "$target" "/var/lib/agentimpact/rollback/nadir-26-cursor-sandbox/$name.previous"
  else
    sudo install -m 0600 /dev/null "/var/lib/agentimpact/rollback/nadir-26-cursor-sandbox/$name.absent"
  fi
done
sudo install -m 0600 /dev/null /var/lib/agentimpact/rollback/nadir-26-cursor-sandbox/BACKUP_COMPLETE

sudo install -d -m 0755 \
  /etc/systemd/system/agentimpact-superset-host.service.d \
  /etc/systemd/system/agentimpact-superset-private.service.d \
  /usr/local/libexec
sudo install -m 0755 "$staging/infra/scripts/cursor-sandbox-preflight.sh" \
  /usr/local/libexec/agentimpact-cursor-sandbox-preflight
sudo install -m 0644 "$staging/infra/systemd/agentimpact-superset-host.service.d/50-cursor-sandbox.conf" \
  /etc/systemd/system/agentimpact-superset-host.service.d/50-cursor-sandbox.conf
sudo install -m 0644 "$staging/infra/systemd/agentimpact-superset-private.service.d/50-cursor-toolchain-readonly.conf" \
  /etc/systemd/system/agentimpact-superset-private.service.d/50-cursor-toolchain-readonly.conf
sudo install -m 0644 "$staging/infra/apparmor/agentimpact-cursor-sandbox" \
  /etc/apparmor.d/agentimpact-cursor-sandbox

sudo /usr/sbin/apparmor_parser -r /etc/apparmor.d/agentimpact-cursor-sandbox
sudo systemctl daemon-reload
sudo systemctl restart agentimpact-superset-private.service
sudo systemctl restart agentimpact-superset-host.service
sudo systemctl --no-pager --full status agentimpact-superset-host.service
sudo journalctl -u agentimpact-superset-host.service -n 30 --no-pager \
  | grep 'CURSOR_SANDBOX_PREFLIGHT=PASS'
sudo systemctl show agentimpact-superset-host.service \
  -p RestrictNamespaces -p NoNewPrivileges -p PrivateTmp -p ProtectSystem
sudo grep '^agentimpact-cursor-sandbox ' /sys/kernel/security/apparmor/profiles
```

Ces contrôles prouvent seulement que le bac à sable peut être construit sous
les contraintes réelles du service. Ils ne prouvent pas qu'un agent Cursor
complet fonctionne.

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
lease, ni donnée Superset.

```bash
sudo test -f /var/lib/agentimpact/rollback/nadir-26-cursor-sandbox/BACKUP_COMPLETE
sudo systemctl stop agentimpact-superset-host.service
sudo systemctl stop agentimpact-superset-private.service

for spec in \
  /etc/systemd/system/agentimpact-superset-host.service.d/50-cursor-sandbox.conf:host-dropin \
  /etc/systemd/system/agentimpact-superset-private.service.d/50-cursor-toolchain-readonly.conf:private-dropin \
  /usr/local/libexec/agentimpact-cursor-sandbox-preflight:preflight; do
  target="${spec%%:*}"
  name="${spec##*:}"
  if sudo test -f "/var/lib/agentimpact/rollback/nadir-26-cursor-sandbox/$name.previous"; then
    sudo cp -a "/var/lib/agentimpact/rollback/nadir-26-cursor-sandbox/$name.previous" "$target"
  else
    sudo unlink "$target"
  fi
done

if sudo test -f /var/lib/agentimpact/rollback/nadir-26-cursor-sandbox/apparmor.previous; then
  sudo cp -a /var/lib/agentimpact/rollback/nadir-26-cursor-sandbox/apparmor.previous \
    /etc/apparmor.d/agentimpact-cursor-sandbox
  sudo /usr/sbin/apparmor_parser -r /etc/apparmor.d/agentimpact-cursor-sandbox
else
  sudo /usr/sbin/apparmor_parser -R /etc/apparmor.d/agentimpact-cursor-sandbox
  sudo unlink /etc/apparmor.d/agentimpact-cursor-sandbox
fi

sudo systemctl daemon-reload
if sudo grep -qx active /var/lib/agentimpact/rollback/nadir-26-cursor-sandbox/private.was-active; then
  sudo systemctl start agentimpact-superset-private.service
fi
if sudo grep -qx active /var/lib/agentimpact/rollback/nadir-26-cursor-sandbox/host.was-active; then
  sudo systemctl start agentimpact-superset-host.service
fi
sudo systemctl show agentimpact-superset-host.service -p RestrictNamespaces
```

Le résultat attendu après rollback est le retour à `RestrictNamespaces=yes` et
le retour de l'échec Cursor `EPERM`, sans désactiver le sandbox ni modifier le
sysctl AppArmor.
