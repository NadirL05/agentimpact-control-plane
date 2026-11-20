# TESTING — AgentImpact Control Plane

Rédigé le 20/11/2026.

## Stratégie

- **Unitaires et intégration** : vitest 5, avec PostgreSQL en mémoire via `@electric-sql/pglite` (`src/vitest.config.ts`, 74 fichiers `*.test.ts`) **[LU]**. Les nouvelles routes sont testées sur l'app Hono réelle (`server.ts`). Ce n'est pas le cas de `server.e2e.test.ts`, qui recrée sa propre app **[LU]**.
- **Python (infra)** : `unittest` dans `infra/` **[LU]**.
- **E2E** : Playwright sur le tableau de bord, lancé en local et dans `preflight.sh`, pas en CI GitHub (quota de minutes) **[NOUVEAU]**.

## Couverture visée

Au moins 80 % des lignes du code nouveau : `dashboard-routes.ts`, nouvelle route missions, module coût et blocages. Le code existant n'est pas rattrapé dans ce lot.

## Tests par étape du plan

| Étape | Tests |
|---|---|
| T1 — service du tableau de bord | `/dashboard/login.html` et `/dashboard/app.js` en 200 avec le bon type ; `/dashboard/` en 302 sans session, 200 avec ; chemin `../` refusé ; fichier inconnu en 404. |
| T2 — durcissement | cookie avec `Secure` en production ; 6e essai de connexion en 15 min → 429 ; message identique pour mot de passe faux et inconnu ; en-têtes CSP, HSTS, X-Frame-Options et nosniff présents ; erreur réseau affichée « Impossible de charger » (test du rendu de `app.js` avec jsdom). |
| T3 — usage IA (dépôt squad-agents-config) | `result.usage` présent avec les tokens Codex de la session de la mission ; absent sans erreur si la session est introuvable ; jamais de chemin ni de secret dans le résultat. |
| T4 — API missions | sans cookie → 401 ; token agent seul → 403 ; filtres a_relire, bloquees, en_cours, toutes ; durée calculée ; coût = tokens × prix ; code de blocage inconnu → phrase générique ; aucun champ « None » ; pagination. |
| T5 — état des PR | PR ouverte, fusionnée ou fermée ; dépôt hors liste non interrogé ; GitHub en erreur → état « inconnu » et réponse 200 ; cache 5 min respecté (un seul appel). |
| T6 — interface | rendu des 4 filtres ; états vide, chargement et erreur ; ligne dépliée ; total de la semaine ; échappement HTML des titres. |
| T7 — E2E | scénario ci-dessous, vert. |
| T8 — accès protégé | depuis l'extérieur : `/dashboard` demande Cloudflare Access ; `/actions`, `/missions` et `/health` injoignables. Contrôle manuel consigné avec capture. |
| T9 — déploiement | `preflight.sh` vert (build, lint, test, npm audit) ; `health.sh` vert après déploiement ; retour arrière testé à blanc. |

## Scénario E2E du parcours principal

1. Base de test avec 4 missions fictives :
   - une terminée avec PR ouverte ;
   - une terminée avec PR fusionnée ;
   - une bloquée (`server_tests_failed:regression:test`) ;
   - une en cours.
2. GitHub simulé : la PR #1 est ouverte, la PR #2 est fusionnée.
3. Ouvrir `/dashboard/` : redirection vers la connexion. Saisir un mauvais mot de passe : message d'erreur. Saisir le bon : accueil.
4. Cliquer « Missions » : le filtre « À relire » affiche une seule ligne avec « Ouvrir la PR » pointant vers la PR #1.
5. Filtre « Bloquées » : une ligne avec la phrase « Un test qui passait avant la mission échoue maintenant… » et l'action conseillée.
6. Filtre « Toutes » : 4 lignes, durées et coût estimé affichés, aucun « None ».
7. Largeur 375 px : pas de défilement horizontal.

## Données et comptes de test

- Missions, actions et PR **fictives** : dépôts `test/demo`, tickets `AGE-9001…`. Aucune vraie donnée client, aucun vrai e-mail.
- Mot de passe du tableau de bord et secrets de session générés pour les tests (variables d'environnement de test), jamais ceux de la production.
- GitHub simulé par un faux `fetch`, sans appel réseau.

## Commande unique

```bash
cd src && npm run lint && npm run build && npm test && npm run test:e2e
```

`test:e2e` (Playwright) est ajouté à l'étape 7. Sur le serveur, `infra/deploy/preflight.sh` lance l'ensemble, plus `npm audit` et les tests Python d'infra **[LU]**.
