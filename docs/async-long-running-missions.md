# Missions longues asynchrones (Slack → Hermès/Ana)

Branche : `feat/async-long-running-missions`

## Cause racine (IMANE-PROJECT-AUDIT-V1)

Le routeur insérait dans `slack_gateway_inbox` puis **pollait synchronement** jusqu’à `done` (timeout 600s). Hermès a travaillé ~440s puis a renvoyé :

`API call failed after 3 retries: Upstream idle timeout exceeded`

Cette chaîne est émise par **Hermès** (`agent/conversation_loop.py`) après épuisement de `api_max_retries` (défaut 3) sur **un appel API LLM** (provider OpenRouter), pas par le routeur AgentImpact.

| Question | Réponse |
| --- | --- |
| Composant émetteur | Hermès conversation loop (stdout → consumer → inbox `response_text`) |
| Timeout atteint | Idle timeout **upstream provider/proxy** pendant un tour LLM (raisonnement / stream) |
| Les 3 retries | Retries **d’un appel API** dans le même tour Hermès — **pas** 3 relances de la mission AgentImpact |
| Inbox | 1 insert, 1 claim, 1 subprocess — pas de duplication AgentImpact |
| `agent_missions` | Aucune ligne créée pour Imane (flux 100 % inbox) |

## Architecture retenue

Réutilise `slack_gateway_inbox` (pas de seconde queue).

```text
FAST PATH (sync)          LONG PATH (async)
Slack → insert → poll     Slack → insert delivery_mode=async
      → réponse           → ACK <2s (queued)
                          → consumer claim atomique
                          → Hermès worker
                          → notifier Slack (started / final)
```

### Timeouts séparés

| Couche | Rôle | Valeur |
| --- | --- | --- |
| ACK Router | Relais async retourne immédiatement | < 2s (pas de poll) |
| Poll sync | Fast path Hermès/Ana seulement | 600s |
| Worker subprocess | `GATEWAY_INBOX_HERMES_TIMEOUT_SEC` | 600s (borné 30–3600) |
| LLM / upstream | Provider Hermès (`stale_timeout`, idle proxy) | hors AgentImpact |

Aucun proxy HTTP ne reste ouvert pendant toute une mission longue.

### Idempotence

- Dedup Slack existante `(team_id, event_id)`
- `UNIQUE (event_id)` sur `slack_gateway_inbox`
- `INSERT … ON CONFLICT DO NOTHING` → même mission si rejeu
- Claim `FOR UPDATE SKIP LOCKED` (inchangé)
- Notifications : `slack_started_at` / `slack_notified_at`

### États

`pending`→queued, `processing`→running, `done`→completed, `failed` / `timeout` / `cancelled`.

## Accès repositories (recommandé, non déployé ici)

Le VPS n’a **pas** de clone `imane-projet`. Hermès a échoué sur `git clone` HTTPS (`could not read Username`).

Recommandation :

1. Workspace isolé : `/opt/agentimpact/projects/<owner>/<repo>`
2. Clone/worktree éphémère via deploy key lecture seule (LoadCredential)
3. Jamais de token GitHub dans le prompt Slack ni en clair dans la DB
4. Politique : pas de `git push` main depuis un agent sans revue

## UX Slack

1. ACK : Mission … enregistrée / ID / Agent / Statut queued  
2. Optionnel : Mission démarrée (running)  
3. Final : résultat ou échec dans le **même thread**

Commandes futures `STATUS` / `CANCEL` : hors scope de ce correctif.

## Rollback

1. Redéployer le binaire/routeur de `main` précédent  
2. Migration 003 est additive (colonnes + index) — laisser en place est sûr  
3. Pour forcer sync partout : `UPDATE slack_gateway_inbox SET delivery_mode='sync' WHERE delivery_mode='async' AND status='pending'`

## Relancer IMANE-PROJECT-AUDIT-V1 (après smoke + accès repo)

**Ne pas lancer tant que le workspace projet n’est pas provisionné.**

Dans Slack (nouveau message, pas un rejeu de l’ancien `event_id`) :

```text
Mission réelle V1 — projet Imane
Projet : https://github.com/NadirL05/imane-projet
… (même corps)
Nom de mission :
IMANE-PROJECT-AUDIT-V1
```

Ou préfixe explicite : `ASYNC MISSION: …`
