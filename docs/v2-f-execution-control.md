# V2-F — Contrôle d'exécution avant les workers réels

Mission : `AGENTIMPACT-V2-F-EXECUTION-CONTROL`.

## Phase 0 et limites d'intervention

BASE_SHA : `4c4d8eccb68b55169c30f71ca735419ddec8e0bf`, merge de V2-A
(PR #36) dans `origin/main`, confirmé par fetch et `git ls-remote`.
Branche : `feat/v2-f-execution-control`, créée depuis ce SHA exact.

Git contient les migrations 001 à 004 ; 004 est le socle utilisé par les
tests isolés avant 005. Aucun playbook ne déclenche 004 ou 005 : les commandes
SQL d'application versionnées restent limitées à 001, 002 et 003.
La mission V2-A précédente n'avait appliqué aucune migration en production.
L'accès direct au schéma de production du compte runner reste indisponible ;
une confirmation de Nadir a été demandée concernant une éventuelle application
manuelle de 004 depuis le merge. Son absence ne doit pas être présentée comme
une vérification SQL de non-application. Aucun droit supplémentaire n'est demandé.

La santé systemd des composants existants a été lue : routeur, consumers
Hermès/Ana et socket Grok actifs. Leur activité ne prouve pas une version de
schéma. Le SHA déployé exact reste non résolu : Ansible construit en staging
puis synchronise les artefacts runtime. L'ancien `.git` runtime n'est pas
une preuve de provenance. Aucun drift runtime n'est corrigé dans V2-F.

Aucun déploiement, merge, migration production, vrai worktree, secret,
credential ou provider IA n'est modifié ou appelé par cette mission.

## Autorité et activation

PostgreSQL conserve missions, tentatives, réservations, reçus et événements.
Hermès reste décisionnel ; le contrôle d'exécution applique les règles avant
chaque transition. Les décisions du contenu d'une mission ne configurent ni
l'identité du worker, ni ses permissions, ni le budget.

Le flag V2-A et le flag F sont tous deux requis pour l'intégration opérateur :

```text
AGENTIMPACT_V2_ENABLED=1
AGENTIMPACT_V2_PROJECTS=IMANE
AGENTIMPACT_V2_EXECUTION_ENABLED=1
```

Tous sont absents/OFF par défaut. Aucune variable secrète n'est ajoutée.
Le câblage F configure uniquement une identité fake et un plafond en unités
synthétiques. Il ne démarre aucun superviseur ou timer dans le serveur API.
L'activation d'un worker réel exige une autre phase, avec validation des
permissions, de l'isolation et d'un budget réellement imposable.

## Tentatives, leases et fencing

Une tentative distincte possède son numéro, son worker assigné, son fencing
token et son historique. PostgreSQL génère les fences monotones et impose
l'unicité du numéro et de la tentative active. Une tentative stale reste
quarantainée tant que sa réconciliation n'est pas prouvée.

Les callbacks internes fournissent attempt_id, worker_instance_id et
fencing_token. L'identité authentifiée est un argument séparé, fourni par
le superviseur de confiance. Le contrôle vérifie le propriétaire, la tentative
courante, la génération, le statut et les expirations avec l'horloge PostgreSQL.
Une identité dans le seul payload ne vaut jamais authentification.

Paramètres initiaux : heartbeat 15 secondes, lease 90 secondes, scanner
30 secondes. La deadline borne la durée totale ; un heartbeat ne peut pas
la repousser. Un callback tardif ne réactive pas une tentative expirée.
Les constantes peuvent être raccourcies explicitement dans les tests.

Une completion répétée à l'identique retrouve son reçu durable ; même clé
avec contenu différent est refusée. Un ancien callback ne peut pas terminer
la nouvelle tentative après RETRY. Une perte de réponse après commit ne
relance pas un travail ni un effet.

## Annulation, retry et reprise

CANCEL persiste la demande, empêche le claim, puis attend l'arrêt.
Le superviseur fake distingue arrêt confirmé et résultat inconnu. Un arrêt
incertain conserve `cancelling` et les réservations. Aucune branche, aucun
workspace, événement ou tentative n'est supprimé.

RETRY exige que l'ancienne génération ne soit plus capable de produire des
effets. Il crée attempt_number + 1 et un nouveau fence. Les dépendances,
réservations, quota et approbations sont revalidés. La politique fake stockée
sert de base ; le payload d'une commande Slack ou HTTP ne peut pas ajouter
un budget. Une approbation de l'ancienne tentative ne passe pas le nouveau claim.

Le superviseur déterministe retrouve les tentatives actives depuis la DB.
Après expiration, il marque stale puis inspecte l'état fake. Une absence de
preuve reste inconnue ; elle ne devient jamais un succès. Le nettoyage
physique est explicitement séparé de la réconciliation logique.

## Réservations et dépendances

`worktree_leases` réserve repo, base SHA, branche et chemin, avec ownership
par tentative et fence. Les contraintes d'unicité incluent la quarantaine.
Les chemins sont synthétiques : le moteur ne lance aucune commande Git ou shell.
Avant comparaison, réservation et persistance, le chemin candidat absolu est
normalisé lexicalement contre `workspace_root=/fake`. Les segments `.` et `..`,
les slash multiples et le slash final produisent un `canonical_path` unique.
Un chemin relatif ou dont le résultat sort du workspace est refusé. Cette
normalisation ne résout pas les liens symboliques : le vrai worker V2-B devra
résoudre le chemin sur le filesystem depuis son sandbox, puis vérifier à nouveau
son appartenance au workspace avant toute écriture.

`budget_reservations` utilise des montants entiers, sans flottants ni
facturation réelle. Le provider est fake. Absence de réservation, quota
inconnu ou épuisement bloque le claim. Réservation et libération sont
transactionnelles et restent associées à la tentative historique.
Le quota fake borne la somme des réservations actives. Il ne constitue pas
un plafond de dépenses cumulées. Le modèle conserve les montants consommés,
mais V2-F ne fournit aucun collecteur de consommation ni facturation réelle.
STATUS sépare donc `budget_reservation_state` de `quota_state`. La source du
quota fournisseur vaut `none`, son état vaut `UNKNOWN` et `quota_checked_at`
reste nul. Une réservation fake ne constitue jamais une preuve de quota chez
Codex, Cursor, Devin ou un autre fournisseur.

Le contrôle vérifie toutes les dépendances persistées, y compris l'historique
conservateur hérité de V2-A. Une dépendance incomplète, failed ou cancelled
bloque la mission. Les dépendances Git exigent le SHA exact ; une dépendance
sur un merge humain exige une preuve distincte. Une completion, une URL ou
une approbation de review ne prouve pas un merge.

## Approbations et revue

Les décisions restent dans `agent_actions` et `agent_approvals`.
Les bindings lient action, mission, tentative, type d'effet, payload_hash,
head_sha éventuel et expiration. Les vérifications utilisent l'heure DB.
La décision humaine doit provenir de l'identité serveur existante
`human-admin`, avec une décision approved et des empreintes identiques.
Les anciennes approbations, expirées ou associées à un autre head ou payload,
ne peuvent pas autoriser la nouvelle génération.

Le helper `approvalPayload(attempt, actionType, headSha)` construit l'enveloppe
canonique à soumettre au circuit existant `POST /actions`. Son ordre des
champs est compatible avec le hash de `JSON.stringify(payload)` de cette
route ; `approvalPayloadHash` calcule le hash attendu par le binding.
L'action utilise l'intent `execute` ou `review`, puis une décision humaine
existante est liée par la route de binding. Aucun nouveau circuit de décision
n'est introduit. Les empreintes du plan, payload et base sont revérifiées
contre la tentative immuable ; le head de lancement est revérifié au claim/start.

La completion d'un fake worker place la mission en revue ; elle ne vaut
pas validation humaine. L'opérateur demande `awaiting_nadir_approval`, puis
la completion de la mission exige le binding exact. Aucun exécuteur de
merge ou de déploiement n'est fourni.

La mutation V2-A directe du plan ou du lifecycle est refusée dès qu'une
tentative existe. Cela empêche de contourner les gates par l'ancienne route
`/state` ou `/plan`. Les décisions de replanification après exécution devront
passer par un mécanisme explicite qui invalide les preuves dépendantes.

## Interfaces et observabilité

Interfaces opérateur, sous les scopes existants :

- `POST /api/v2/missions/:id/cancel` ;
- `POST /api/v2/missions/:id/retry` ;
- `POST /api/v2/missions/:id/review`, admin uniquement ;
- `POST /api/v2/missions/:id/approvals/bind`, admin uniquement ;
- `GET /api/v2/missions/:id` et `/api/v2/status?project=IMANE` ;
- `GET /api/v2/metrics`.

Les mutations exigent `Idempotency-Key`. Ni bridge, ni un mode `SKIP_AUTH`
ne donnent accès aux commandes F. Aucun endpoint HTTP de claim, heartbeat
ou completion worker n'est exposé ; leur transport authentifié appartient
à l'intégration du premier vrai worker.

Slack offre `CANCEL <mission_id>`, `RETRY <mission_id>` et STATUS déterministe,
réservés à l'identité Nadir configurée. Une commande F désactivée ne devient
pas un prompt exécuté par Hermès V1. Les commandes ne créent aucune
approbation humaine sur la seule base du texte Slack.

STATUS affiche état, phase, tentative courante, numéro, worker, lease,
ancienneté du heartbeat, dépendances, budget, approval et blocage.
Le projet est limité aux 100 missions les plus récentes dans l'API ; Slack
en affiche au plus 20 et indique les autres résultats de cet ensemble.
Les métriques exposent les compteurs et gauges demandés sans labels par
mission ou tentative. Les erreurs et événements restent structurés et
bornés, sans prompts, credentials ni sorties libres du worker.

## Migration et rollback

005 est additive et transactionnelle sur le socle 004. Les champs et
contrats V1 restent inchangés ; son status projeté reste indépendant du
lifecycle V2. Les réservations/tentatives sont historiques ; leurs
suppressions et le TRUNCATE sont interdits par le modèle.

Les migrations sont testées uniquement dans des bases jetables. Elles ne
sont ajoutées à aucune commande d'application production.

005 est une migration one-shot, volontairement non idempotente. Avant de
l'appliquer, l'opérateur doit vérifier le registre de migrations de
l'environnement cible. En l'absence de registre, il doit contrôler au minimum
`to_regclass('mission_attempts')` et la présence attendue des colonnes,
contraintes, index, triggers et métriques de 005. Si aucun objet n'existe, 005
s'applique une fois sur un schéma 004 validé. Si tous les objets attendus sont
présents, elle est considérée déjà appliquée et ne doit pas être rejouée. Un
état partiel ou contradictoire impose un arrêt et une investigation ; il ne doit
jamais être masqué par `IF NOT EXISTS`.

Une réexécution directe échoue actuellement avec PostgreSQL `42701`
(`duplicate_column`) dans la transaction. L'opérateur doit effectuer le
`ROLLBACK`, confirmer que le schéma complet et les données précédentes sont
intacts, puis enregistrer/réconcilier l'état de migration avant toute autre
opération. Un test isolé couvre ce rejet et l'intégrité après rollback.

Rollback fonctionnel : arrêter les admissions/claims, réconcilier les
exécutions fake, désactiver F et conserver les données et les filtres V1.
Une situation incertaine reste quarantainée. Ne jamais rendre une mission
V2 à un consumer V1 ni réutiliser son workspace sans preuve d'arrêt.

## Validation et limites avant V2-B

Les tests SQL exécutent 004 puis 005 sur PGlite. Les courses réelles utilisent
PostgreSQL natif sur un socket Unix privé, avec plusieurs connexions et une
DB jetable. La reprise simulée reconstruit le superviseur depuis PostgreSQL.
Aucune connexion TCP ou credential de production n'est nécessaire.

Les nombres de validation propres à chaque PR sont consignés dans son rapport
et dans la CI associée. Aucun test ne contacte un provider IA.

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

V2-B doit qualifier l'identité du worker, l'isolation exécutable, le contrôle
des ressources Git et la publication médiée. Il doit remplacer les observations
fake de budget/quota et d'arrêt par des preuves imposables, ajouter une
comptabilité cumulée et une collecte de consommation, puis vérifier
le contrat fournisseur sur fixtures avant un canari autorisé. Le verrou
transactionnel conservateur hérité de V2-A reste un plafond de débit, pas
un ordonnanceur optimisé.
