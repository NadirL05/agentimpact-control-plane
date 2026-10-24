# Suivi des missions AgentImpact dans Linear

Projet : [AgentImpact — Missions Hermes](https://linear.app/agentimpact/project/agentimpact-missions-hermes-40501cc62b55)

## Périmètre

Le service `agentimpact-linear-sync` lit toutes les missions structurées du control plane (`agent_missions` V1/V2) et les missions longues Slack V1 (`slack_gateway_inbox.delivery_mode = 'async'`). Une mission V2 liée à une ligne inbox ne produit qu'un ticket. Les échanges ordinaires avec les bots Hermes dans Slack ne sont pas des missions enregistrées et n'entrent pas dans ce flux.

Le sens de synchronisation est **AgentImpact → Linear**. AgentImpact conserve l'état de référence. Le service crée un ticket par mission, actualise son titre et son état, puis publie son lien dans le fil Slack d'origine si celui-ci est connu. Il rattrape aussi les missions déjà présentes à sa première exécution. Il ne copie ni prompt, ni résultat, ni contenu de conversation ; le titre, l'identifiant, l'agent, l'état et le lien du fil Slack sont visibles dans Linear. Éviter donc les données sensibles dans les titres de mission.

| État AgentImpact | État Linear |
| --- | --- |
| En attente ou inconnu | Todo |
| En cours ou annulation demandée | In Progress |
| En revue, bloqué, échec ou timeout | In Review |
| Terminé | Done |
| Rejeté ou annulé | Canceled |

Les échecs restent en revue pour qu'un humain puisse les traiter. Déplacer manuellement un ticket Linear ne pilote pas l'exécution Hermes ; la prochaine mise à jour AgentImpact rétablit l'état calculé.

## Déploiement

Prérequis : accès root sur le VPS, migrations existantes du routeur et des missions appliquées, Docker/Postgres et systemd actifs. Le service utilise l'utilisateur existant `agentimpact-slack-router` et les credentials Slack/Postgres existants. Un administrateur Linear doit créer une clé API ayant accès à l'équipe Agentimpact et au projet de missions. Ne pas communiquer cette clé dans Slack ni dans un ticket.

Depuis le checkout de la branche `feature/linear-mission-tracking` présent sur le VPS, lancer `sudo bash infra/scripts/deploy-linear-sync.sh`. Le script demande la clé en saisie masquée si elle n'est pas déjà installée et l'enregistre hors Git dans `/etc/agentimpact/credentials/linear-api-key` (`root:root`, mode `0600`). Il construit le commit dans un répertoire de staging, sauvegarde et vérifie un dump PostgreSQL avant la migration, installe les fichiers puis démarre ou redémarre le service. Il échoue si un prérequis manque.

Les étapes manuelles ci-dessous servent à vérifier ou reprendre un déploiement interrompu :

1. Construire la branche dans un répertoire de staging (`cd <checkout>/src && npm ci && npm run build`). Le build produit `<checkout>/src/dist/linear-sync/`. Installer ce répertoire dans `/opt/agentimpact/app/dist/linear-sync/`, avec le même propriétaire et des permissions de lecture que les artefacts runtime existants ; vérifier ensuite `/opt/agentimpact/app/dist/linear-sync/daemon.js`. Ne pas supposer que `npm run build` dans `app/src` écrira directement dans `app/dist`.
2. Appliquer `src/migrations/010_linear_mission_sync.sql` à la base `agentimpact`, par le même chemin opérateur que les migrations précédentes. La migration est additive et réexécutable.
3. Installer `infra/templates/linear-sync.env.example` comme `/etc/agentimpact/linear-sync.env` (`root:root`, `0640`), puis vérifier les identifiants d'équipe, projet et workflow Linear avant activation.
4. Installer `infra/systemd/agentimpact-linear-sync.service` dans `/etc/systemd/system/`, puis exécuter `systemctl daemon-reload`, `systemctl enable --now agentimpact-linear-sync.service`.
5. Vérifier `systemctl status agentimpact-linear-sync.service`, les lignes `linear_sync` du journal, le nombre de lignes dans `linear_mission_links` et les tickets du projet. Tester une nouvelle mission longue dans un fil Slack autorisé et vérifier le ticket, son état et le lien dans ce même fil.

Pour une première vérification sans boucle, exécuter `node /opt/agentimpact/app/dist/linear-sync/daemon.js --once` **sous l'unité systemd** ou avec les mêmes credentials chargés par systemd. Ne pas copier les secrets dans des variables de shell persistantes. Les erreurs enregistrées dans `linear_mission_links.error_code` sont des codes courts sans corps de requête. Les retries utilisent un délai croissant plafonné à 30 minutes. Le service interroge les missions toutes les 60 secondes, avec un maximum de 50 candidates par lot.

## Retour arrière et limites

Arrêter/désactiver l'unité suffit à arrêter les nouvelles écritures. La table `linear_mission_links` et les tickets existants peuvent rester pour audit ; ne pas supprimer les tickets automatiquement. L'écriture Slack est au moins une fois : une interruption après `chat.postMessage` mais avant l'enregistrement local pourrait republier le lien. Le `client_msg_id` stable réduit ce risque, sans être une garantie transactionnelle entre Slack et Postgres.

Les conversations Slack natives des gateways Hermes/Ana/Pablito ne disposent actuellement d'aucun enregistrement universel de « mission » dans le control plane. Pour les inclure, il faudra définir puis instrumenter un événement de début et de fin de mission dans leurs propres flux. Cette extension n'est pas couverte par le présent service.
