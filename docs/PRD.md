# PRD — AgentImpact Control Plane

Rédigé le 20/11/2026 à partir du code (`main` b9e3089) et des docs existantes (README, AGENTS.md, docs/current-state.md, docs/architecture.md, roadmap-8-semaines.md). **[LU]** = constaté dans le code ou un doc ; **[DÉDUIT]** = interprétation ; **[À CONFIRMER]** = information manquante.

## Problème

Point de vue de Nadir, seul opérateur humain **[LU : « awaiting_nadir_review », approbateur `human-admin`]** :

> « Mes agents IA (Hermès, Dev Senior, Anna…) proposent des actions et réalisent des missions de code sur 14 projets. Je les valide dans Slack, mais je n'ai aucun endroit où voir d'un coup d'œil ce qui tourne, ce qui attend ma relecture, ce qui a bloqué et pourquoi, ni combien ça a pris de temps et d'IA. Le tableau de bord existant ne s'ouvre pas et ne montre pas les missions. »

Constats au 20/11/2026 :

- le tableau de bord renvoie 404 sur le serveur (`/dashboard/`, `/dashboard/login.html`) **[LU : curl 127.0.0.1:3000]** et n'est joignable que depuis le serveur (ports liés à 127.0.0.1) **[LU : infra/compose.yml]** ;
- il ne montre que profils, policies et workflows **[LU : src/dashboard/app.js:76-80]** ;
- les missions Dev Senior sont lancées par « go AGE-xx » dans Slack depuis le 20/11 (dépôt squad-agents-config, étapes 22-23) **[LU]**.

## Client cible

Usage interne : Nadir Lahyani, fondateur d'AgentImpact, qui pilote seul ses agents. Pas de client externe pour ce tableau de bord **[DÉDUIT]**.

## Proposition de valeur

Voir en moins de 30 secondes, depuis n'importe quel appareil, l'état de toutes les missions des agents, ce qui attend ma relecture et ce que chacune a coûté.

## Fonctionnalités MVP

### Indispensable (5)

1. **Approbation humaine des actions** liée à l'empreinte du contenu (`payload_hash`), expiration, anti-rejeu, anti-auto-approbation **[LU : existant, server.ts, approvals.ts]**.
2. **Bus de missions agents et autopilote** borné (read_only / reversible_write, coupe-circuit 24 h) **[LU : existant, missions.ts, autopilot.ts]**.
3. **Tableau de bord accessible par une adresse web protégée** (aujourd'hui en 404) : correction du service des fichiers, connexion durcie **[NOUVEAU, choix de Nadir du 20/11]**.
4. **Onglet Missions** : liste des missions (ticket, projet, statut, lien PR), filtre « à relire » (PR ouvertes non fusionnées), blocages expliqués en une phrase avec l'action à faire **[NOUVEAU, choix de Nadir du 20/11]**.
5. **Durée et coût IA estimé par mission** : durée « go → fin », tokens consommés et équivalent en euros selon un tarif configurable **[NOUVEAU, choix de Nadir du 20/11]**.

### Utile (existant, conservé tel quel)

- Growth OS : leads, qualification, brouillons, envoi Brevo, liste de suppression, réponses Gmail, FullEnrich **[LU]**.
- Brief quotidien, Drive Intelligence, Delivery Factory GitHub (sans fusion), sites de démo, métriques clients **[LU]**.

### Plus tard

- Missions V2 (Superset, Codex worker, Jarvis, operator) : présentes, désactivées par drapeaux **[LU : compose, AGENTIMPACT_V2_*=0]**.
- Comptes individuels (aujourd'hui un mot de passe partagé), page workflows (routes non montées) **[LU]**.

## Hors périmètre

- Accès de clients (Marine, Home Eco ENR) ou d'autres personnes au tableau de bord.
- Facturation réelle et rapprochement avec les abonnements IA (le coût affiché reste une estimation).
- Actions depuis l'onglet Missions (relancer, annuler, fusionner) : lecture seule au MVP.
- Correction des dettes listées dans SECURITY.md qui ne concernent pas le tableau de bord (webhooks FullEnrich/Brevo, routes sans scope) : suivies à part.
- Suivi sportif personnel (`/training`) **[LU]** : inchangé.

## Modèle de revenu et prix

N/A : outil interne, non vendu **[DÉDUIT]**. [À CONFIRMER] si une version client est envisagée.

## Indicateurs de succès

| Indicateur | Cible | Échéance |
|---|---|---|
| Missions dev-senior visibles dans l'onglet après leur fin | 100 %, en moins de 60 s | 2026-12-04 |
| Temps pour savoir quelles PR relire | moins de 30 s depuis l'ouverture de la page | 2026-12-04 |
| Accès non authentifiés aboutis au tableau de bord | 0 sur 30 jours (journaux Cloudflare et API) | 2027-01-04 |
| Missions avec durée et tokens renseignés | ≥ 95 % des missions lancées après la mise en ligne | 2026-12-18 |

## Hypothèses à valider

- L'adresse web protégée devant le tableau de bord passe par Cloudflare Tunnel + Access (un tunnel cloudflared existe déjà pour un webhook) **[LU : commentaire infra/compose.yml ; DÉDUIT pour le choix]** [À CONFIRMER : domaine et méthode de connexion].
- Le tarif servant à estimer le coût IA [À CONFIRMER : prix par million de tokens pour gpt-6-astra (Codex, abonnement ChatGPT) et pour la relecture Claude].
- La production (release b37c3813, 11/09/2026) a 7 commits de retard sur `main` **[LU : compare GitHub]** : leur contenu partira avec le premier déploiement [À CONFIRMER : Nadir accepte ce lot].
