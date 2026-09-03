# hermesctl — activation systemd socket FD 3

## Statut

Correctif de l'activation systemd du bridge `hermesctl`. Le bridge écoute un socket
Unix (`/run/agentimpact/hermesctl.sock`) et reçoit le descripteur d'écoute via le
protocole systemd `LISTEN_FDS` (FD 3). L'incident décrit ci-dessous rendait `hermesctl`
indisponible.

## Cause racine

L'unité `agentimpact-ctl-bridge.service` contenait `StandardInput=socket`. Cette
directive correspond au modèle inetd où systemd passe la **connexion acceptée** sur
stdin. Or `bridge.py` lit le socket d'écoute via `LISTEN_FDS` (FD 3) avec
`socket.fromfd(3, ...)`, pas via stdin. Les deux modèles sont incompatibles :

- avec `StandardInput=socket`, systemd tente de passer la connexion acceptée sur
  stdin, mais `bridge.py` n'utilise pas stdin ;
- le service était aussi `enabled` directement par le playbook
  (`hermesctl-v1.yml`) et démarré via `state: started` **sans** activation par
  socket, donc `LISTEN_FDS` n'était jamais positionné ;
- `bridge.py` échouait immédiatement (`LISTEN_FDS missing`) ;
- `Restart=on-failure` relançait le service en boucle.

## Comportement avant / après

| Aspect | Avant | Après |
| --- | --- | --- |
| `StandardInput` du service | `socket` | absent |
| `[Install]` du service | `WantedBy=multi-user.target` | absent (non enable) |
| `Service=` côté socket | absent | `agentimpact-ctl-bridge.service` |
| `TriggeredBy=` côté service | absent | `agentimpact-ctl-bridge.socket` |
| Démarrage service par playbook | direct (`enabled+started`) | jamais direct |
| Activation service | enable direct → boucle | socket activation seule |
| `LISTEN_FDS` au démarrage | absent (démarrage direct) | positionné par systemd |
| Boucle de restart | oui | non (`StartLimitIntervalSec/Burst`) |

## Correction

### Unité service `agentimpact-ctl-bridge.service`

- retrait de `StandardInput=socket` ;
- retrait de la section `[Install]` (le service ne peut pas être enabled
  directement) ;
- ajout de `TriggeredBy=agentimpact-ctl-bridge.socket` ;
- ajout de `StartLimitIntervalSec=300` / `StartLimitBurst=5` pour borner toute
  boucle de restart ;
- conservation de `Requires`/`After` le socket, du durcissement
  (`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`,
  `RestrictAddressFamilies`, `CapabilityBoundingSet=`) et de
  `ConditionPathExists=/etc/agentimpact/tokens/bridge.env` (fail-closed).

### Unité socket `agentimpact-ctl-bridge.socket`

- ajout de `Service=agentimpact-ctl-bridge.service` (association explicite) ;
- conservation de `SocketMode=0660`, `SocketUser=agentimpact-ctl`,
  `SocketGroup=agentimpact-ctl`, `DirectoryMode=0750`, `Accept=no` ;
- conservation de `[Install] WantedBy=sockets.target`.

### Playbook `hermesctl-v1.yml`

- `systemctl daemon-reload` explicite après installation des unités ;
- désactivation + arrêt de l'ancien démarrage direct du service
  (`agentimpact-ctl-bridge.service` → `enabled: false`, `state: stopped`) pour
  annuler l'état hérité de l'ancien playbook ;
- **ajout de `agentimpact-runner` au groupe `agentimpact-ctl` avant l'activation
  du socket** (`state: present`, `append: true`) — le smoke test s'exécute comme
  `agentimpact-runner` et doit accéder au socket `0660 agentimpact-ctl:agentimpact-ctl` ;
- activation + démarrage **uniquement** du socket
  (`agentimpact-ctl-bridge.socket` → `enabled: true`, `state: started`) ;
- aucun démarrage direct du service ;
- smoke test `hermesctl health` borné (`timeout 10`, `become_user: agentimpact-runner`)
  qui déclenche le socket via le client, puis vérifie `ok: true` ;
- vérifications post-smoke : socket `active`, service `active`, service **non**
  enabled (`disabled` ou `static`).

Cet ordre garantit qu'une installation neuve comme une reprise après rollback
permettent au smoke test (exécuté comme `agentimpact-runner`) d'accéder au
socket `0660 agentimpact-ctl:agentimpact-ctl`.

### `bridge.py`

Aucun changement nécessaire : `systemd_listen_fd()` lève déjà `RuntimeError`
immédiatement si `LISTEN_FDS` est absent (fail-fast, sans attente ni retry), et
renvoie `3` sinon. Le comportement est couvert par les tests de non-régression.

## Déploiement contrôlé (après merge)

Le dépôt principal `/opt/agentimpact/runner/repos/agentimpact-control-plane.git` est
actuellement utilisé par la branche `feat/growth-brevo-codex` — ne **pas** y faire
`git checkout main`/`git pull`. Utiliser une release détachée propre depuis
`origin/main`, comme les déploiements précédents.

### 1. Préparer une release détachée depuis le bare repo

```bash
git -C /opt/agentimpact/runner/repos/agentimpact-control-plane.git fetch origin \
  refs/heads/main:refs/remotes/origin/main --prune
sha="$(git -C /opt/agentimpact/runner/repos/agentimpact-control-plane.git \
  rev-parse origin/main)"
git -C /opt/agentimpact/runner/repos/agentimpact-control-plane.git worktree remove \
  /opt/agentimpact/runner/worktrees/deploy-main-<ancien-sha> 2>/dev/null || true
git -C /opt/agentimpact/runner/repos/agentimpact-control-plane.git worktree add --detach \
  /opt/agentimpact/runner/worktrees/deploy-main-"$sha" origin/main
```

### 2. Exécuter le playbook depuis le worktree détaché

```bash
cd /opt/agentimpact/runner/worktrees/deploy-main-"$sha"
ansible-playbook infra/ansible/playbooks/hermesctl-v1.yml
```

Le playbook désactive/arrête l'ancien démarrage direct du service, recharge
systemd, active uniquement le socket, exécute le smoke test borné (en tant
que `agentimpact-runner`), puis vérifie socket `active`, service `active`,
service **non** enabled.

### 3. Vérifier

```bash
systemctl is-active agentimpact-ctl-bridge.socket   # active
systemctl is-active agentimpact-ctl-bridge.service  # active (socket-activé)
systemctl is-enabled agentimpact-ctl-bridge.service # disabled ou static
systemctl is-enabled agentimpact-ctl-bridge.socket  # enabled
timeout 10 /opt/agentimpact/runner/bin/hermesctl health
stat -c '%a %U:%G' /run/agentimpact/hermesctl.sock   # 660 agentimpact-ctl:agentimpact-ctl
```

### 4. Impact

Aucun impact sur l'API, PostgreSQL ou les migrations (le playbook ne touche
ni `db`, ni `api` au-delà du cycle normal).

## Rollback

Le playbook `hermesctl-v1-rollback.yml` arrête et désactive déjà
`agentimpact-ctl-bridge.service` et `agentimpact-ctl-bridge.socket`. Avec la
correction, le service n'ayant plus de `[Install]`, `enabled: false` est un
no-op inoffensif ; l'arrêt du socket stoppe l'activation. Le rollback restaure
ensuite dist, scripts, sources API et compose, puis redémarre l'API. Aucun
impact sur API, PostgreSQL ou migrations.

Rollback manuel ciblé si nécessaire :

```bash
systemctl stop agentimpact-ctl-bridge.socket
systemctl disable agentimpact-ctl-bridge.socket
systemctl stop agentimpact-ctl-bridge.service   # inactif sans socket
```

## Vérifications

- `git diff --check` ;
- tests Python bridge (`test_bridge_resilience.py`) ;
- tests Ansible (`test_playbooks.py`, `test_hermesctl_bridge_preflight_runtime.py`,
  `test_hermesctl_bundle_resume_runtime.py`, `test_hermesctl_loop_preflight_runtime.py`) ;
- `ansible-playbook --syntax-check` des 4 playbooks ;
- `npm run build`, `npm run lint`, `npm test`, `npm run lint:md` (Node 22),
  `npm audit` ;
- scan de secrets sur le diff ;
- `systemd-analyze verify` sur les unités corrigées.

## Audit des unités Grok (LISTEN_FDS)

Les unités `agentimpact-grok-worker.socket` / `agentimpact-grok-worker.service`
utilisent le bon modèle d'activation par socket :

- `Service=agentimpact-grok-worker.service` côté socket ;
- pas de `StandardInput=socket` ;
- pas de section `[Install]` côté service ;
- `StartLimitIntervalSec` / `StartLimitBurst` présents.

**Défect détecté (suivi séparé, hors de cette branche)** : l'unité
`agentimpact-grok-worker.service` contient une directive manuelle
`TriggeredBy=agentimpact-grok-worker.socket`. Comme pour le bridge, `TriggeredBy=`
est une propriété systemd calculée automatiquement depuis `Service=` du socket et
ne devrait pas être maintenue manuellement. `systemd-analyze verify` émet le même
avertissement `Unknown key name 'TriggeredBy'` pour cette unité.

Ce défaut n'est **pas** bloquant pour le bridge (le socket Grok fonctionne
correctement car `Service=` est présent côté socket), et Slack-Grok n'est **pas**
modifié dans cette mission. Suivi séparé recommandé : retirer la directive
`TriggeredBy=` manuelle de `agentimpact-grok-worker.service` dans une branche
dédiée `fix/grok-worker-triggeredby-cleanup`.
