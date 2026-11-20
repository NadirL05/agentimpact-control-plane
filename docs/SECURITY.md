# SECURITY — AgentImpact Control Plane

Rédigé le 20/11/2026 depuis le code (`main` b9e3089). Une case n'est cochée qu'avec sa preuve (commande, fichier, capture). « État actuel » = constat **[LU]** ou **[DÉDUIT]** ; « À faire » renvoie au plan.

- [ ] **Aucun secret dans le code, l'historique git ou le bundle front ; `.env*` dans `.gitignore`.**
  - État actuel : tokens lus par variables d'environnement et fichiers `/etc/agentimpact/tokens/*.env` (compose) **[LU]** ; le tableau de bord ne contient aucune clé **[LU : dashboard/*.js]**.
  - À faire : vérifier `.gitignore` et lancer un scan de l'historique (gitleaks ou GitGuardian) avant de cocher.
- [ ] **Seules les clés publiques sont exposées côté client.**
  - État actuel : aucune clé dans `dashboard/` **[LU]**. L'onglet Missions n'expose que des liens de PR et des comptes de tokens, jamais de jeton GitHub ni de détails d'erreur bruts.
- [ ] **Toutes les entrées validées côté serveur (Zod ou équivalent).**
  - État actuel : zod sur leads, approvals, outreach, fullenrich, proposals, missions V2, operator **[LU]**. Validation manuelle ou absente sur `POST /api/actions`, `PATCH /actions/:id/reject` (acteur fourni par le client) et `PATCH /missions/:id/result` **[LU / DÉDUIT]**.
  - À faire (étape 4) : filtres et pagination de `/dashboard/api/missions` validés par zod. Dette existante suivie hors de ce lot.
- [ ] **Contrôle d'accès vérifié côté serveur sur chaque route ; Row Level Security sur toutes les tables Supabase.**
  - État actuel : allowlist route × rôle et tokens en temps constant **[LU]**. Plusieurs routes n'ont **aucun scope** (refusées à tout token) : PATCH /actions/:id/approve et reject, GET /leads/:id, POST /api/briefs/daily, drive propose/rollback, github execute/review, growth draft, clients, demos register/extend **[LU / DÉDUIT : inaccessibles ou oubliées]**.
  - À faire : la nouvelle route n'accepte que le cookie de session (T4).
  - RLS : N/A, ce produit n'utilise pas Supabase (PostgreSQL direct, rôles DB dédiés pour la validation d'approbation, migrations 008-009) **[LU]**.
- [ ] **Messages d'erreur génériques côté utilisateur ; détails techniques uniquement dans les logs serveur.**
  - État actuel : pas de `onError` global ; certaines routes renvoient `error.message` brut (`server.ts:566`, `:605`) **[LU]**.
  - À faire (étapes 2 et 4) : réponses génériques sur `/dashboard/*`. Les extraits de logs des tests restent dans l'état de l'exécuteur, jamais dans la page.
- [ ] **Rate limiting sur connexion, inscription, réinitialisation de mot de passe, OTP et endpoints coûteux (LLM, voix, SMS, e-mails).**
  - État actuel : limite seulement sur operator (60/min) et Grok **[LU]** ; aucune sur `/dashboard/login`, d'où un risque de force brute **[LU]**.
  - À faire (étape 2) : 5 essais par 15 min et par IP sur la connexion.
  - Inscription, réinitialisation et OTP : N/A (pas de comptes ; l'OTP e-mail est géré par Cloudflare Access).
  - Envoi Brevo : limité par approbation humaine **[LU]**.
- [ ] **Signature vérifiée sur chaque webhook entrant (Stripe, n8n, etc.).**
  - État actuel : GitHub vérifie la signature HMAC **[LU]**. FullEnrich accepte un token partagé y compris en query ; Brevo un token en query seulement, sans signature **[LU]**.
  - À faire : passer FullEnrich et Brevo en en-tête ou en signature (hors de ce lot, dette suivie). L'onglet Missions n'ajoute aucun webhook.
- [ ] **En-têtes de sécurité (CSP, HSTS) ; cookies `HttpOnly`, `Secure`, `SameSite`.**
  - État actuel : aucun en-tête de sécurité ; cookie `ai_dashboard` en HttpOnly et SameSite=Lax mais **sans Secure** **[LU : signed-session.ts:64]**.
  - À faire (étape 2) : CSP stricte sur `/dashboard/*` (scripts du même domaine seulement), HSTS, X-Frame-Options DENY, nosniff, cookie `Secure`.
- [ ] **`npm audit` (ou équivalent) sans vulnérabilité critique.**
  - État actuel : lancé par `infra/deploy/preflight.sh`, absent de la CI **[LU]** ; résultat non mesuré au 20/11.
  - À faire (étape 9) : joindre la sortie de `npm audit --audit-level=critical`.
- [ ] **RGPD : données collectées listées, durée de conservation, mentions présentes.**
  - Données collectées **[LU]** :
    - leads et contacts prospects : nom, rôle, e-mails pro et perso, téléphones issus de FullEnrich ;
    - conversations e-mail, liste de suppression, audit des actions ;
    - missions : titres de tickets et objectifs.
  - L'onglet Missions n'ajoute aucune donnée personnelle (tokens, durées, liens).
  - [À CONFIRMER] durée de conservation des leads et conversations, et mentions d'information des prospects.

## Spécifique à l'accès web (étape 8)

- Seul `/dashboard/*` est publié par le tunnel ; l'API par rôles reste sur 127.0.0.1. Preuve attendue : T8.
- Cloudflare Access n'admet que l'e-mail de Nadir [À CONFIRMER] ; le mot de passe du tableau de bord reste exigé en second facteur.
- Le tableau de bord est en lecture seule : aucune action d'approbation ni de fusion depuis la page.
