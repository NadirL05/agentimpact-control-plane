# Worksheet — ignorer les fils Slack des apps natives

Worktree : `/opt/agentimpact/runner/worktrees/slack-router-ignore-native-agents`
Branche : `fix/slack-router-ignore-native-agents`

## Problème

Slack encode une mention sous la forme `<@USER_ID>`. Un message `@Cursor` ou `@Codex` pouvait aussi être routé vers Hermès, et les réponses suivantes du fil récupérées par le routeur AgentImpact.

## Architecture retenue

| Composant | Comportement |
| --- | --- |
| `SLACK_NATIVE_AGENT_USER_IDS` | Liste CSV non secrète dans `/etc/agentimpact/slack-router.env` |
| Détection | Tokens exacts `<@U…>` ou `<@U…\|label>` — jamais le display name |
| Fil racine avec mention native | Owner `native`, aucun agent, aucune réponse Slack |
| Follow-ups humains | Ignorés tant que le fil est `native` |
| Messages bot | Ignorés (inchangé) |
| Directives AgentImpact | Fonctionnelles hors fils `native` |
| Production | Fail-closed si la liste est absente (`NODE_ENV=production` imposé par l'unité systemd) |
| Persistance | Owner `native` dans `slack_thread_owners` (migration 002) |

## Configuration des apps Slack officielles

1. Ouvrir **Slack → Paramètres workspace → Gérer les apps**.
2. Pour chaque app (Cursor, Codex, Devin, Hermès, Ana) :
   - Ouvrir la fiche app → **À propos** ou API `users.info` / `apps.info`.
   - Noter le **user_id** (`U…`) — pas le nom affiché.
3. Éditer `/etc/agentimpact/slack-router.env` (jamais Git), puis redémarrer le routeur **uniquement après validation Nadir** (hors scope de ce worksheet).

Exemple de valeur (IDs fictifs — remplacer sur le VPS) :

```bash
SLACK_NATIVE_AGENT_USER_IDS=UCURSORXXX,UCODEXXXX,UDEVINXXX,UHERMESXXX,UANAXXXXX
```

## Récupération des user IDs sans token affiché

- **Méthode admin Slack** : panneau apps → identifiant bot de l'app.
- **API Slack** (avec token admin) :

```bash
curl -s -H "Authorization: Bearer xoxb-…" \
  "https://slack.com/api/users.list" | jq '.members[] | select(.is_bot) | {id, name, real_name}'
```

- Filtrer les bots correspondant aux apps natives.
- Ne jamais committer les IDs réels : uniquement dans `slack-router.env` sur le VPS.

## Spaces Devin par dépôt

- Créer **un Space Devin par dépôt** (isolation contexte / secrets).
- Documenter le mapping dépôt → Space dans la doc interne ops (hors Git).
- **Interdiction Devin en root** : `ESCALADE DEVIN` reste réservée à Nadir et renvoie « Escalade non configurée » en v1.
- Les fils `@Devin` natifs sont ignorés par le routeur ; Devin répond via son intégration Slack propre.

## Chemins repos / worktrees

| Rôle | Chemin |
| --- | --- |
| Bare repo | `/opt/agentimpact/runner/repos/agentimpact-control-plane.git` |
| Worktree feature | `/opt/agentimpact/runner/worktrees/slack-router-ignore-native-agents` |
| App déployée | `/opt/agentimpact/app` |
| Config routeur | `/etc/agentimpact/slack-router.env` |
| Migration 002 | `src/migrations/002_slack_router.sql` |

## Test en canal privé

1. Configurer `SLACK_NATIVE_AGENT_USER_IDS` avec les IDs de test/staging.
2. Canal privé `#agentimpact-router-test` (accès Nadir + routeur uniquement).
3. Cas à valider :
   - Message `@Cursor` avec token `<@U…|Cursor>` → **silence** du routeur.
   - Follow-up humain dans le fil → **silence**.
   - Message `@Cursor` en texte libre (sans token) → **Hermès** répond (comportement normal).
   - `ROUTE GROK: …` dans un **autre** fil → Grok répond.
   - `ROUTE GROK` dans un fil déjà `@Codex` → **silence**.
4. Vérifier les logs : `ignored:native_agent_thread`.

## Rollback

1. Sauvegarder `/etc/agentimpact/slack-router.env` (Ansible `managed_configs`).
2. Retirer ou vider `SLACK_NATIVE_AGENT_USER_IDS` **uniquement en dev** ; en prod, la variable reste obligatoire après déploiement.
3. Revenir au binaire précédent (`slack-grok-router-v1-rollback.yml`).
4. La colonne owner `native` en base est inoffensive ; pas de migration down requise en urgence.
5. Confirmer qu'Hermès reprend les fils non marqués `native`.

## Fichiers modifiés (feature)

| Fichier | Changement |
| --- | --- |
| `src/core/slack-router/native-agent-mentions.ts` | Parsing IDs + détection mentions |
| `src/slack-router/config.ts` | Chargement env + fail-closed prod |
| `src/slack-router/dispatch.ts` | Ignore + persistance owner `native` |
| `src/core/slack-router/router.ts` | Parité logique in-memory |
| `src/migrations/002_slack_router.sql` | Owner `native` |
| `infra/templates/slack-router.env.example` | Documentation variable |
| `infra/systemd/agentimpact-slack-router.service` | `Environment=NODE_ENV=production` (fail-closed sans config manuelle) |
