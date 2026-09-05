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
une enveloppe HMAC chargée par `LoadCredential`, un timestamp, un nonce non
réutilisable et le hash du payload. Le control-plane revérifie attempt, worker,
fence, lease et état avec PostgreSQL. Le socket n'est pas une API publique.

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
le lancement. Une réservation AgentImpact en devise `FAKE` ne prouve aucun
quota fournisseur. Il n'existe aucun fallback API ni changement automatique
d'identité.

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
Le credential HMAC monté par systemd est le seul credential de contrôle ; aucun
credential GitHub ou SSH agent n'est fourni.

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

## Migration 006 et rollback

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

## Authentification manuelle ultérieure

1. Nadir valide l'identité et le mode de facturation dédiés au worker.
2. L'opérateur installe l'IaC, vérifie le compte sans sudo et l'absence du groupe
   Docker, puis crée le credential HMAC hors Git.
3. Depuis une session administrée, il lance `codex login --device-auth` sous
   `agentimpact-codex-worker` avec son HOME et son CODEX_HOME dédiés. Il ne copie
   aucun ancien `~/.codex` et ne met aucun token en argument ou dans les logs.
4. Il exécute `codex login status` sous ce compte et renseigne seulement les
   états non secrets d'authentification, facturation et quota après vérification.
5. Il garde publisher à zéro et ne modifie les trois flags d'exécution qu'au
   moment du canari approuvé.

## Procédure de canari contrôlé

1. Confirmer migration 006 sur une base non production et tous les tests verts.
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
