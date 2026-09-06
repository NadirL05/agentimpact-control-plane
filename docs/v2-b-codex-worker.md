# V2-B — Codex Worker

Mission : `AGENTIMPACT-V2-B-CODEX-WORKER`.

## Baseline et qualification locale

La branche part du merge de la PR 38, SHA
`310c9c9ab0f83470382f49cd18da53db21f6d78f`. La qualification en lecture seule
a trouvé `/home/agentimpact-runner/.local/bin/codex`, lien vers le binaire
standalone `0.153.4`. `codex exec` accepte le prompt sur stdin, `--ephemeral`,
`--ignore-user-config`, `--output-schema`, `--json`, `--output-last-message`,
`--sandbox workspace-write`, `--ask-for-approval never` et `--cd`. Le processus
peut être arrêté par signal et les commandes `resume`/`fork` existent. Aucun
appel modèle n'a été lancé pendant cette qualification.

Le compte humain `agentimpact-runner` est connecté avec ChatGPT. Cette session
personnelle n'est pas une identité worker et n'est ni copiée ni montée dans le
service. Le compte dédié `agentimpact-codex-worker` n'existait pas lors de la
qualification et son mode d'authentification et de facturation restent inconnus.
Le worker retourne donc `codex_auth_not_configured` et reste désactivé.

L'état livré par V2-B est
`CODEX_WORKER_READY_FOR_CONTROLLED_CANARY`. Il signifie que le code, le sandbox
et la procédure sont prêts pour une qualification séparée après merge. Il ne
signifie jamais `CODEX_WORKER_PRODUCTION_ENABLED` : l'authentification dédiée
n'est pas configurée, les flags restent à zéro et le canari réel est interdit
pendant cette mission.

## Contrat et autorités

PostgreSQL reste l'autorité pour la mission, la tentative, la lease, le fence,
la réservation, les approvals et les transitions. Le worker ne reçoit qu'un
contrat borné signé contenant les identifiants de la génération, l'objectif,
les critères, les chemins autorisés, le dépôt enregistré, le SHA de base, la
branche réservée, la deadline et la réservation. Le prompt brut n'est jamais
ajouté aux événements.

Le CLI est lancé directement avec argv, le profil contrôlé `agentimpact-worker`
du CODEX_HOME dédié et la spécification sur stdin. Aucun
shell n'interprète le contenu de la mission. L'environnement transmis contient
uniquement `PATH`, `HOME` et `CODEX_HOME`. La sortie doit satisfaire le schéma
JSON versionné ; une phrase libre ne peut pas terminer une tentative. Les
sorties complètes et stderr fournisseur sont écartés. Seuls des codes bornés,
empreintes, états et références d'artefacts peuvent être persistés.

Les mutations utilisent un socket Unix sous `/run/agentimpact-codex-worker`,
une enveloppe HMAC par attempt chargée par `LoadCredential`, un timestamp, un
nonce non réutilisable et le hash du payload. Le serveur sélectionne le secret
avec l'`attempt_id` avant de vérifier la signature : un worker ne peut donc pas
signer le callback d'une autre tentative. Le control-plane revérifie attempt,
worker, fence, lease et état avec PostgreSQL. Le socket n'est pas une API
publique.

## Activation fail-closed

Les quatre portes suivantes valent zéro par défaut :

```text
AGENTIMPACT_V2_ENABLED=0
AGENTIMPACT_V2_EXECUTION_ENABLED=0
AGENTIMPACT_V2_CODEX_WORKER_ENABLED=0
AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED=0
```

Même demandée par flag, l'exécution reste bloquée si auth, facturation ou quota
ne sont pas sourcés. Le quota `UNKNOWN` est un état de premier ordre et interdit
le lancement ordinaire. Une réservation AgentImpact en devise `FAKE` ne prouve
aucun quota fournisseur. Il n'existe aucun fallback API ni changement automatique
d'identité.

Un unique canari contrôlé peut être explicitement préparé avec
`AGENTIMPACT_V2_CODEX_CANARY_ATTEMPT_ID=<uuid>` : il ne contourne pas l'état
`UNKNOWN` du fournisseur. Il est accepté seulement pour cet attempt, avec
`max_attempts=1`, une deadline de cinq minutes maximum et un publisher désactivé.
PostgreSQL impose toujours la réservation, lease, fence et l'approval liée à la
mission, l'attempt, le payload et le SHA. Toute autre tentative, replay ou
deadline invalide est refusé. Cette variable est absente par défaut et ne doit
être installée qu'après le gate humain du canari.

## Isolation et arrêt

Le registre serveur résout `repo_id` vers un miroir absolu et une allowlist de
chemins. Chaque attempt reçoit un clone privé sous
`/var/lib/agentimpact-codex-worker/workspaces/attempts/<attempt_id>/workspace`,
un checkout détaché du SHA exact et une branche distincte. La normalisation
lexicale, `realpath` et le contrôle de chaque symlink protègent la racine. Un
seul writer actif est permis par les leases PostgreSQL. Les workspaces ambigus
restent en quarantaine et ne sont jamais supprimés automatiquement.

Le template systemd utilise l'utilisateur sans login
`agentimpact-codex-worker`, un HOME et un CODEX_HOME privés, un cgroup par
attempt, `ProtectSystem=strict`, `ProtectHome=yes`, aucune capability, des
limites de mémoire/processus/fichiers et des chemins d'écriture bornés. Le
socket Docker, `/root`, `/home` et les credentials généraux sont inaccessibles.
Le credential HMAC propre à l'instance, monté depuis le fichier root `%i` par
systemd, est le seul credential de contrôle. Chaque unité reçoit une vue tmpfs
privée de `/run/credentials` et du runtime ; seuls son répertoire `%i` et le
socket de contrôle y sont remontés. Le répertoire source reste inaccessible au
worker et le répertoire `%d` n'expose que son secret. Aucun credential GitHub
ou SSH agent n'est fourni.

CANCEL persiste d'abord `cancel_requested`. SIGTERM puis la grâce systemd
s'appliquent au cgroup. Seule une inspection `stopped` avec le fence et le
worker propriétaires permet `cancelled`. Un résultat inconnu conserve
`cancelling`, `worker_stop_unconfirmed` et la quarantaine. Au redémarrage, les
attempts non terminales sont relues depuis PostgreSQL ; l'absence de session
processus locale vaut `UNKNOWN`, jamais succès. Un retry Codex exige une
nouvelle réservation explicite de workspace.

## Validation et publication

Le validateur de confiance recalcule le diff depuis `base_sha`, sa taille, les
chemins changés, les symlinks et les signatures usuelles de secrets. Il compare
la liste déclarée et refuse tout test en échec. Pour le canari, les recettes de
tests obligatoires proviennent du registre serveur et doivent être relancées
hors décision du worker. Le résultat Codex reste une proposition jusqu'à cette
validation et la revue de Nadir.

Le worker ne publie rien. L'interface publisher est distincte et le publisher
réel reste absent/désactivé avec `publisher_credential_not_configured`. Le fake
de test refuse les dépôts non enregistrés, main/master et force push, et
retrouve son reçu idempotent. Une implémentation réelle devra recréer un checkout
propre, appliquer le patch validé, relancer les tests, vérifier l'ownership de
branche et retrouver la PR avant toute création. Elle ne pourra ni merger ni
déployer.

## Migrations 006, 007, 008 et rollback

006 s'applique en transaction sur une base isolée ayant reçu 004 puis 005. Elle
étend les contraintes de type worker et de workspace, ajoute uniquement les
métadonnées Codex et références d'artefacts, et complète les noms de métriques.
Elle ne modifie aucune ligne V1 et ne démarre rien. Elle est one-shot : vérifier
le registre de migrations et tous les objets attendus avant application. Un
second passage doit échouer puis être rollbacké ; un schéma partiel impose un
arrêt opérateur et ne doit pas être masqué par `IF NOT EXISTS`.

Le rollback fonctionnel met les quatre flags à zéro, arrête les cgroups et
conserve missions, attempts, événements et workspaces pour réconciliation. La
migration n'est pas appliquée en production par cette mission.

008 est additive et one-shot après la chaîne complète 004–007. Elle installe
une fonction PostgreSQL `SECURITY DEFINER` à recherche fixe, exécutable seulement
par le rôle callback dédié. Elle conserve les row locks nécessaires au contrôle
d'approval sans accorder `UPDATE` sur `agent_actions` ni `agent_approvals`. Une
absence de rôle ou de tables attendues fait échouer la migration ; elle ne masque
pas un schéma partiel. L'opérateur applique 008 dans une transaction distincte,
vérifie son objet et son ACL, puis conserve les flags à zéro jusqu'au gate canari.

007 est une correction additive one-shot à appliquer uniquement après une 006
complète. Elle vérifie la définition de l'index incorrect livré par 006 et le
contrat des états avant de remplacer cet index. Le prédicat final bloque
`reserved`, `leased` et `quarantined`. La quarantaine reste exclusive car elle
signale un processus ou un workspace dont l'arrêt n'est pas encore réconcilié ;
seul `released` autorise une nouvelle réservation. Un index absent, déjà
modifié, non unique, invalide, portant sur une autre colonne, ou un contrat
d'états inattendu fait échouer 007 avant le `DROP INDEX`. Un second passage
échoue également : il ne masque donc jamais un schéma partiel.

## Daemon de contrôle local

`agentimpact-codex-control.socket` est l'unique propriétaire de
`/run/agentimpact-codex-worker/control.sock`. systemd crée le socket en `0600`
pour l'utilisateur et le groupe dédiés, puis transmet le descripteur au daemon
`agentimpact-codex-control.service`. Le daemon instancie réellement
`LocalWorkerServer`, charge l'URL PostgreSQL bornée et les HMAC par tentative
uniquement par `LoadCredential`, puis relie le transport à
`CodexControlDispatcher`. Il ne contient aucun chemin de lancement Codex.

Le déploiement flags OFF choisit l'option B : service et socket sont installés,
arrêtés et désactivés. Après création de l'assignment, du registre et du HMAC
propres au canari, l'opérateur démarre explicitement le socket. La première
connexion active alors le daemon. Si un flag, l'authentification, la facturation
ou le quota manque, le dispatcher répond avec un code borné et aucune mutation
worker ou exécution fournisseur n'a lieu. Pour arrêter le transport, arrêter
d'abord le socket puis le service ; systemd retire le chemin du socket. Le
rollback exécute ces deux arrêts et conserve les données et workspaces.

## Authentification manuelle ultérieure

1. Nadir valide l'identité et le mode de facturation dédiés au worker.
2. L'opérateur installe l'IaC, vérifie le compte sans sudo et l'absence du groupe
   Docker, puis configure hors Git un credential HMAC distinct pour chaque
   attempt autorisée. Aucun secret partagé entre attempts n'est admis.
3. Après le merge seulement, depuis une session opérateur administrée, il lance
   la connexion interactive sous l'identité système dédiée avec un environnement
   vide :

   ```sh
   /usr/sbin/runuser --user agentimpact-codex-worker -- \
     /usr/bin/env -i \
     HOME=/var/lib/agentimpact-codex-worker/home \
     CODEX_HOME=/var/lib/agentimpact-codex-worker/codex-home \
     PATH=/opt/agentimpact/codex/bin:/usr/bin:/bin \
     /opt/agentimpact/codex/bin/codex login --device-auth
   ```

   `env -i` empêche la transmission de l'environnement de l'opérateur, notamment
   les variables API, GitHub et SSH. Aucun HOME, `~/.codex`, `auth.json`, profil
   personnel ou session interactive de `agentimpact-runner` ne doit être copié,
   lié ou monté. Aucun token ne doit être passé en argument ou journalisé.
4. Sans lancer `codex exec` ni aucune requête modèle, il vérifie la connexion avec
   exactement le même environnement dédié :

   ```sh
   /usr/sbin/runuser --user agentimpact-codex-worker -- \
     /usr/bin/env -i \
     HOME=/var/lib/agentimpact-codex-worker/home \
     CODEX_HOME=/var/lib/agentimpact-codex-worker/codex-home \
     PATH=/opt/agentimpact/codex/bin:/usr/bin:/bin \
     /opt/agentimpact/codex/bin/codex login status
   ```

   Il renseigne seulement les états non secrets d'authentification, facturation
   et quota après vérification. Il ne crée pas de clé API et ne configure aucun
   fallback API.
5. Il garde publisher à zéro et ne modifie les trois flags d'exécution qu'au
   moment du canari approuvé.

## Procédure de canari contrôlé

1. Confirmer la chaîne 004 → 005 → 006 → 007 sur une base non production et tous les tests verts.
2. Vérifier `systemd-analyze verify`, l'utilisateur, les permissions, les
   cgroups, l'absence d'accès Docker/GitHub et la connexion Codex dédiée.
3. Enregistrer un miroir de fixture sans secret, avec une seule branche canari
   et une allowlist minimale.
4. Faire approuver une mission courte, une tentative, un budget borné, une
   deadline courte, `max_attempts=1`, `concurrency=1` et aucun retry automatique.
5. Garder publisher désactivé. Sourcer explicitement un quota admissible, puis
   activer V2, l'exécution et le worker pour ce seul projet.
6. Démarrer uniquement l'instance systemd de cette tentative. Surveiller lease,
   heartbeat, PID/cgroup, diff et journaux filtrés.
7. Tester CANCEL si nécessaire et exiger une preuve de cgroup vide. Toute
   ambiguïté reste quarantainée et bloque le retry.
8. Repasser les trois flags d'exécution à zéro, valider manuellement le diff et
   les artefacts, puis documenter coût/quota et résultat. Ne pas publier,
   merger, déployer ou appliquer une migration production pendant ce canari.
