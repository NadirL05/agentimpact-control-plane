# TRD — AgentImpact Control Plane

Rédigé le 20/11/2026 depuis le code (`main` b9e3089). **[LU]** constaté (fichier:ligne) ; **[DÉDUIT]** interprétation ; **[À CONFIRMER]** manquant.

## Stack et justification

| Choix | Raison |
|---|---|
| Node 22 + TypeScript ESM, Hono 4 (`src/package.json`) **[LU]** | API légère, typée ; même langage que les agents et scripts. CI en Node 20 (`.github/workflows/ci-src.yml`) **[LU]** : à aligner sur 22. |
| PostgreSQL 16 (`infra/compose.yml`, conteneur `agentimpact-db`) **[LU]** | Transactions et contraintes pour l'audit, l'anti-rejeu et le fencing des missions. |
| SQL brut paramétré via `pg` (`src/api/db.ts`) **[LU]** | Contrôle fin des requêtes, pas d'ORM à auditer. |
| Zod (`src/package.json`) **[LU]** | Validation serveur des entrées. |
| Dashboard HTML/JS statique sans framework (`dashboard/`) **[LU]** | Pas de build front ; servi par l'API. Conservé pour l'onglet Missions. |
| Docker (node:22-alpine, `USER node`, conteneur read-only) **[LU : src/Dockerfile, compose]** | Isolation et déploiement reproductible (`infra/deploy/*.sh`). |
| Cloudflare Tunnel + Access devant `/dashboard` **[NOUVEAU]** | Aucun port ouvert sur le serveur ; connexion par e-mail vérifié avant même d'atteindre l'API ; cloudflared déjà utilisé **[LU : commentaire compose]**. [À CONFIRMER : domaine, ex. pilotage.agentimpact.fr]. |

## Architecture

**[LU]**

- **`agentimpact-api`** (Hono, :3000, lié à 127.0.0.1 et 127.0.0.1:3443) : API par rôles, monte le dashboard sur `/dashboard` (`server.ts:73`).
- **`agentimpact-db`** : PostgreSQL 16 sur 127.0.0.1:5432.
- **Processus annexes** : slack-router (Socket Mode), codex-worker, grok-worker, ctl-bridge, gateway-inbox (`infra/systemd/*`).
- **Exécuteur des missions Dev Senior** : hors de ce dépôt (squad-agents-config, `/opt/agentimpact/scripts/mission_executor.py`). Il lit et met à jour les missions par `cp-api.sh hermes` (`GET/PATCH /missions`).

**[NOUVEAU]**

- Le tableau de bord passe par Cloudflare Access puis un tunnel cloudflared, jusqu'à `127.0.0.1:3000/dashboard/*`. Seul le préfixe `/dashboard` est publié ; le reste de l'API n'est pas exposé.
- `GET /dashboard/api/missions` : route lue avec le cookie de session du tableau de bord. Elle agrège :
  - `agent_missions` et `agent_actions` ;
  - l'état des PR GitHub, en cache 5 min ;
  - une explication des blocages tirée d'un dictionnaire statique ;
  - une estimation du coût à partir de `result.usage`.

## Modèle de données

**[LU]** Les tables V1 cœur n'ont pas de migration dans le dépôt : leur schéma de référence est la fixture `src/core/missions-v2/testing/schema.sql`.

### Tables V1 cœur

- **agent_actions** : id, status, profile, intent, targets, payload, payload_hash, risk_level, dry_run, approval_expires_at, approved_at/by, executed_at, error_message, created_at.
  - Relations : 1-N avec agent_approvals et agent_audit_events ; 1-1 avec agent_missions.
- **agent_approvals** : action_id → agent_actions, approver, decision, reason, payload_hash, expires_at ; `UNIQUE(action_id, payload_hash)`.
- **agent_missions** : id, action_id → agent_actions, target_agent, source_type, source_id (unique avec source_type), source_url, title, payload (repo, linear_issue, objective, requested_via), priority, status, dry_run, result jsonb, processed_at, error_message, created_at, updated_at. Plus les colonnes V2 (004, 005).
- **agent_audit_events**, **policies** (policy_key, enabled, rules), **leads**, **outreach_drafts**, **suppression_list**, **conversations**, **demo_sites**, **client_entities**, **training_sessions** : colonnes listées dans le code, sans DDL dans le dépôt.

### Tables issues des migrations

001 à 017 : cursor_proposals, tables slack_*, mission_plans/dependencies/events/receipts, mission_attempts, worktree_leases, budget_reservations, execution_*, codex_*, jarvis_*, operator_request_nonces.

### Champs `result` utilisés par l'onglet Missions

**[LU : écrits par l'exécuteur squad-agents-config]**

- Toujours : pr_url, head_sha, delivery, base_branch, linear_issue, test_mode, test_count, review.
- Selon le mode de test : ci_checks (ci-only) ; server_checks et server_note (server).
- En cas d'échec : error, phase.

**[NOUVEAU]** `result.usage` : `{codex: {input_tokens, cached_input_tokens, output_tokens}, review: {cost_usd?}, hermes: null}`. Il est écrit par l'exécuteur. **Pas de migration** : on reste dans le jsonb `result`.

**[DÉDUIT]** Aucun coût LLM réel n'est stocké aujourd'hui. `budget_reservations` est synthétique (`provider='fake'`).

## Auth et rôles

**[LU]**

- Tokens Bearer par rôle : bridge, hermes, planner, operator, admin (`middleware/auth.ts:36-54`). Comparaison en temps constant ; allowlist route × rôle (`core/auth-scopes.ts`).
- Tableau de bord : mot de passe partagé `DASHBOARD_ACCESS_TOKEN`. Il donne un cookie `ai_dashboard` signé HMAC, valable 8 h, HttpOnly, SameSite=Lax, **sans Secure** (`core/signed-session.ts:64`). Ce cookie n'ouvre que GET /profiles, /policies, /workflows (`auth.ts:15-19`).

**[NOUVEAU]**

- Le cookie de session ouvre aussi `GET /dashboard/api/missions`.
- Le cookie reçoit le flag `Secure` derrière HTTPS.
- La connexion est limitée à 5 essais par 15 min et par IP.
- Rôle unique : Nadir, en lecture seule.
- Cloudflare Access n'admet que l'e-mail de Nadir [À CONFIRMER : adresse].

## Intégrations et webhooks

**[LU]**

| Intégration | Mode |
|---|---|
| Slack | sortant `chat.postMessage` ; entrant en Socket Mode |
| GitHub | spec / issues / review ; webhook HMAC |
| FullEnrich | webhook à token, accepté aussi en query |
| Brevo | webhook à token en query |
| Gmail, Google Calendar/Drive | — |
| Superset, Codex, Grok/Cursor | désactivés en V2 |

Aucune intégration Linear.

**[NOUVEAU]**

- **GitHub, lecture de l'état des PR** : `GET /repos/{owner}/{repo}/pulls/{n}` pour les PR des missions. Le dépôt est déduit de `pr_url`, limité à NadirL05/* et ERP-AxENR/home-eco-enr. Jeton existant `GITHUB_TOKEN` [À CONFIRMER : couvre les 14 dépôts en lecture, dont ERP-AxENR]. Cache 5 min.
- **Cloudflare Tunnel et Access** : configuration hors code (cloudflared, politique Access).

## Variables d'environnement (noms seulement)

**[LU]**

- **Base** : PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, PORT, NODE_ENV, SKIP_AUTH.
- **Tokens et sessions** : CTL_BRIDGE_TOKEN, CTL_HERMES_TOKEN, CTL_ADMIN_TOKEN, CTL_OPERATOR_TOKEN, CTL_PLANNER_TOKEN, DASHBOARD_ACCESS_TOKEN, TRAINING_FORM_TOKEN.
- **Slack** : SLACK_BOT_TOKEN(_FILE), SLACK_APP_TOKEN_FILE, SLACK_HOME_CHANNEL.
- **GitHub** : GITHUB_TOKEN, GITHUB_REPOS, GITHUB_WEBHOOK_SECRET, GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID.
- **Brevo** : BREVO_*. **FullEnrich** : FULLENRICH_*. **Google** : GOOGLE_TOKEN_PATH.
- **Exécution** : drapeaux AGENTIMPACT_V2_*, AGENTIMPACT_JARVIS_*, AGENTIMPACT_EXECUTION_BACKEND. Superset : SUPERSET_*. Grok : GROK_*, CURSOR_API_KEY(_FILE).
- Liste complète : à tenir à jour avec le code.

**[NOUVEAU]**

- MISSION_COST_PRICES (JSON de prix par million de tokens et par modèle) [À CONFIRMER : valeurs].
- DASHBOARD_LOGIN_MAX_ATTEMPTS (défaut 5).

## Exigences non fonctionnelles

- **Onglet Missions** : réponse en moins de 1 s pour 200 missions ; appels GitHub en cache ; dégradation propre si GitHub est indisponible (état de PR « inconnu », pas d'erreur de page).
- **Fraîcheur** : une mission terminée apparaît au plus tard 60 s après sa fin (rechargement auto toutes les 30 s).
- **Mobile** : lisible sur 375 px de large.
- **Disponibilité** : outil interne, aucune garantie ; l'arrêt du tableau de bord ne doit jamais bloquer l'API ni l'exécuteur.

## Contraintes

**[LU]**

- Serveur AWS unique (8 CPU, 30 Go de RAM, environ 250 Go libres).
- La production est sur la release `20260911T095530Z-b37c3813d41e`, avec 7 commits de retard sur `main`.
- Le déploiement passe par `infra/deploy/{preflight,deploy,health,rollback}.sh`.

Autres :

- **Minutes GitHub Actions limitées** (3 000/mois, choix de Nadir du 20/11) : la CI existante reste (`ci-src.yml`), pas de nouveaux workflows coûteux.
- Le tableau de bord n'est pas copié dans l'image Docker et sa route statique compare un chemin complet à des clés relatives (`dashboard-routes.ts:19-22`) **[DÉDUIT]**. Deux causes probables du 404, à corriger à l'étape 1 du plan.
