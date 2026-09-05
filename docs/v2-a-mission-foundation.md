# V2-A — Fondation durable des missions

Mission : `AGENTIMPACT-V2-A-MISSION-FOUNDATION`.

## Baseline et provenance

- BASE_SHA : `1b238db743560406f909f961701919dca96de3de` (`origin/main`).
- Branche : `feat/v2-a-mission-foundation`, créée depuis ce SHA exact.
- Baseline de développement validée par Nadir, puis vérifiée par fetch Git.
- DEPLOYED_SHA : `UNRESOLVED`.
- RUNTIME_PROVENANCE : `ANSIBLE_BUILD_AND_SYNCHRONIZE`.
- RUNTIME_GIT_HEAD_AUTHORITATIVE : `NO`.

L'ancien `.git` de `/opt/agentimpact/app` ne représente pas les artefacts
exécutés. Ansible copie les sources vers
`/var/lib/agentimpact-build/hermesctl-v1`, installe les dépendances, compile
puis synchronise `dist` et les artefacts vers `/opt/agentimpact/app`.
L'absence de manifeste de build associant SHA et empreintes reste une dette.

Les vérifications root communiquées par Nadir confirment le schéma V1,
les tables missions/actions/approvals/inbox/proposals/router-runs,
l'absence de triggers initiaux et de table de suivi des migrations.
Les colonnes, contraintes et index de 003 sont matériellement présents.
Ces preuves sont fournies par Nadir, pas une nouvelle inspection SQL root
réalisée pendant l'implémentation.

Correspondance runtime signalée : `src/slack-router/daemon.ts`,
`src/slack-router/dispatch.ts`, `src/api/gateway-inbox.ts`.
Drift signalé : `src/core/slack-router/router.ts` et
`src/core/slack-router/parse-route.ts`. Ces deux fichiers restent inchangés.
Aucun nettoyage runtime, déploiement, merge ou migration production.

## Décision : action_id et séparation V1/V2

La migration `004_v2_mission_foundation.sql` étend `agent_missions`.
`action_id` devient nullable, avec contrainte conditionnelle : toute ligne
V1 conserve son action non nulle et sa FK. Une mission V2 peut exister sans
approbation ni action artificielle. Une action réelle pourra être associée
ultérieurement sans supprimer cette FK.

Créer une fausse action aurait mélangé admission et approbation ; une table
mission parallèle aurait dupliqué l'autorité. La contrainte conditionnelle
préserve le contrat V1 au niveau PostgreSQL, même pour les écritures directes.

`orchestration_version` vaut 1 par défaut. Sa valeur ne peut plus changer
après création, comme la provenance, le projet et le parent.
Les lecteurs, dispatchers, résultats, claims, completions et notifier V1
excluent les lignes V2. Les filtres `to_jsonb(row)` fonctionnent aussi avant
004. Le consumer Python refuse explicitement une réponse marquée V2.
Les entrées V2 restent dans l'inbox, en attente, sans traitement V1.

## Autorité et cycle de vie

Hermès propose les décisions et les plans via l'API authentifiée.
Le control-plane valide le projet autorisé, le discriminateur, la version,
les transitions et le DAG. PostgreSQL conserve le seul état durable.

Transitions actives dans V2-A :

- `queued` vers `planning` ou `blocked` ;
- `planning` vers `blocked`, ou publication du plan ;
- publication du plan vers `ready` ou `waiting_dependencies` ;
- `ready` et `waiting_dependencies` vers `planning` ou `blocked` ;
- `blocked` vers `planning`.

Le vocabulaire des états V2-F est réservé dans le modèle, mais aucune
transition vers une exécution réelle, completion, annulation ou retry
n'est exposée dans V2-A. `status` V1 reste `pending` pour les missions V2-A ;
`lifecycle_state` est leur autorité. Aucun appel de provider ni scheduler
exécutable n'est installé.

## Modèle et transactions

Tables ajoutées : `mission_plans`, `mission_dependencies`, `mission_events`,
`mission_receipts`. Aucune nouvelle queue d'exécution.

Les plans sont immuables et versionnés : critères d'acceptation, étapes,
paths estimés, risques, critères de fin et dépendances typées.
Les missions enfants sont créées explicitement avec `parent_mission_id`.
Parent et dépendances doivent appartenir au même projet V2.

Les arêtes sont immuables et versionnées. La détection de cycles inclut
l'historique : retirer une dépendance d'un nouveau plan ne libère pas
silencieusement un prérequis. Les dépendances restent en attente jusqu'à
l'implémentation de leur validation déterministe en V2-F.

Les mutations V2 prennent un verrou transactionnel de table PostgreSQL,
puis vérifient les versions et les reçus. Ce choix conservateur sérialise
le socle et peut temporairement retarder des écritures V1. Le scheduler F
devra affiner la granularité sans perdre l'exclusion et l'atomicité.
`state_version` est comparée puis incrémentée pour chaque mutation.
Les reçus rejouent le résultat original, même après d'autres mutations.
Même clé et payload différent : HTTP 409. Provenance déjà utilisée avec
une autre demande : HTTP 409. Les erreurs SQL détaillées ne sont pas renvoyées.

## Admission Slack et STATUS

Configuration externe, absente/OFF par défaut :

```text
AGENTIMPACT_V2_ENABLED=1
AGENTIMPACT_V2_PROJECTS=IMANE
```

L'activation future exige la migration et les guards V1 déjà présents.
La liste des projets est une allowlist de configuration serveur.
Aucun `.env` réel n'est ajouté.

Commandes explicites de Nadir quand V2 est activée :

```text
MISSION V2 IMANE Préparer le plan de développement
STATUS IMANE
STATUS <mission_uuid>
```

Admission V2 : ownership du fil, dédup Slack, inbox, mission, événement et
reçu sont écrits dans une transaction. L'ACK Socket Mode n'est envoyé
qu'après COMMIT. Une panne de stockage empêche l'ACK. Un crash après COMMIT
ou la perte de la réponse Slack permet le rejeu sans nouvelle mission.
Les commandes V2 désactivées ne tombent pas sur Hermès V1 ; les suites
ordinaires des fils V2 ne déclenchent pas un worker V1.
Les threads possédés par les agents natifs gardent leur routage historique.

L'admission V1 Hermès/Ana écrit également l'inbox dans la transaction de
déduplication/ownership, avant l'ACK, sans attendre la réponse du worker.
Les routes directes historiques Codex-proposition et Grok conservent leur
modèle V1 ; elles ne constituent pas des adapters mission V2.
La correction ne rejoue pas les événements perdus avant son déploiement.
Les réponses Slack sont best-effort : la durabilité de la mission ne promet
pas une livraison exactement une fois des notifications.

## API V2

Allowlist Bearer existante : scopes Hermès/admin ; bridge exclu.
Même `SKIP_AUTH` n'ouvre pas V2. `requested_by` provient du scope authentifié,
pas du payload. Ces identités partagées ne prouvent pas une présence humaine
et n'autorisent aucune approbation sensible.

- `POST /api/v2/missions` : admission command ou child.
- `GET /api/v2/missions/:id` : état.
- `GET /api/v2/status?project=IMANE` : 100 missions les plus récentes.
- `GET /api/v2/missions/:id/plan` : dernière version durable.
- `GET /api/v2/missions/:id/events?after=0` : 100 événements par curseur.
- `POST /api/v2/missions/:id/state` : state et state_version attendue.
- `POST /api/v2/missions/:id/plan` : plan et state_version attendue.

Toute mutation exige `Idempotency-Key`. Les corps sont validés strictement.
Une mission absente renvoie 404 ; une mission V1 est refusée par V2.
Jarvis utilisera le modèle command via le futur gateway authentifié ; aucun
listener WireGuard ou code Mac n'est ajouté ici.

## Sécurité et tests

`mission_events` ne contient que des IDs, types bornés, états, versions et
horodatages. Aucun prompt brut, champ libre JSON ou sortie d'agent.
UPDATE, DELETE et TRUNCATE sont refusés par triggers ; les plans, arêtes et
reçus sont également immuables. Un administrateur DB peut toujours modifier
les droits ou le schéma : ce n'est pas une frontière contre le superuser.
Les prompts nécessaires à l'admission restent dans la mission et l'inbox,
pas dans les événements. Ne pas soumettre de credentials dans les demandes.

Les fixtures SQL sont synthétiques, fondées sur le contrat communiqué.
PGlite exécute les migrations et requêtes PostgreSQL sans production ; tests
de restart sur stockage temporaire, rollback, replay, DAG, versions et API.
Un cluster PostgreSQL 16 natif temporaire, sous le compte courant, écoute
uniquement sur un socket Unix privé et vérifie les courses entre connexions.
Le script le supprime après les tests ; aucun service système n'est modifié.

```bash
cd src
npm ci
npm run build
npm run lint
npm test
cd ..
bash infra/scripts/test-v2-a-postgres.sh
python3 -m unittest discover -s infra/scripts -p 'test_*.py'
```

Le script natif utilise `/usr/lib/postgresql/16/bin`, configurable par
`V2_TEST_PG_BIN`. Les tests natifs sont explicitement ignorés dans `npm test`
si le socket privé du script n'est pas fourni ; une étape CI dédiée les lance.
Fake planner et fake worker existent uniquement dans les modules de tests,
sans imports depuis les entrypoints runtime. Le futur registry contient
Hermès, Codex, Cursor, Devin, Grok, Grok Bot et Ana, tous désactivés,
sans adapter chargé.

## Migration, rollback et prérequis F

004 est transactionnelle et proposée uniquement dans cette PR. Elle n'est
ajoutée à aucun playbook d'application production. Avant activation future,
valider la migration sur une copie de schéma réelle et planifier les verrous
DDL. Aucun backfill ne transforme ou ne lance les anciennes missions.

Rollback fonctionnel : désactiver `AGENTIMPACT_V2_ENABLED`, conserver les
données et les guards V1, parquer V2. Ne pas revenir à un ancien consumer
sans filtre. Ne pas supprimer les tables ni rétablir globalement NOT NULL
sur `action_id` tant que des missions V2 sans action existent.

V2-F devra ajouter attempts, leases, fencing, budgets, isolation, arrêt,
retry et autorisations liées aux effets. Il devra également traiter la
validation des dépendances, la publication d'artefacts, la livraison durable
des notifications et la granularité des verrous. Aucun worker réel ne peut
être activé sur la seule base de V2-A.

## Vérification locale de cette PR

- TypeScript : 252 tests réussis ; les 3 tests natifs ignorés par la suite
  générale ont été exécutés séparément et réussissent également.
- PostgreSQL 16 natif : 3 tests de concurrence réussis, cluster temporaire
  arrêté et supprimé par le script.
- Python consumers/scripts : 34 tests réussis, providers simulés.
- Build et typecheck : réussis sous Node 22.
- ESLint : aucune erreur, 12 avertissements dans le code préexistant.
- Markdown et syntaxe Bash des scripts modifiés : réussis.
- Scan des fichiers modifiés : aucune signature de secret détectée et
  aucun fichier `.env` réel ajouté ; contrôle heuristique, pas une preuve
  exhaustive d'absence de secrets.
