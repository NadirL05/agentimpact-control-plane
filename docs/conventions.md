# Conventions — Control Plane AgentImpact

Ce document décrit les conventions de branches, commits, PR et code style.

## Branches

- `main` : branche de production, toujours stable.
- `feat/*` : nouvelles fonctionnalités.
- `fix/*` : corrections de bugs.
- `docs/*` : changements de documentation.
- `chore/*` : tâches de maintenance, CI, tooling.

Format : `type/description-courte` (ex. `feat/audit-workflow`, `fix/login-timeout`).

## Commits

Convention inspirée de Conventional Commits :

- `feat: ajout de X`
- `fix: correction de Y`
- `docs: mise à jour de la doc Z`
- `chore: mise à jour CI / tooling`

Messages en français, courts et explicites.

## Pull Requests

- Titre : `type: description` (ex. `feat: workflow d'audit v1`).
- Description :
  - contexte et objectif ;
  - changements principaux ;
  - lien vers tickets/issues associés.
- Checklist :
  - [ ] CI passante
  - [ ] Tests / vérifs locales faites
  - [ ] Doc mise à jour si nécessaire

Revue :
- Au moins 1 approbation requise avant merge.
- Revue sécurité obligatoire pour les changements de policies / profils Hermes.

## Code style

- Langage principal : _à définir (ex. TypeScript / Python / Go)_
- Style :
  - suivre les guidelines officiels du langage ;
  - lint activé en CI ;
  - formatage automatique (prettier / black / gofmt, etc.).
- Tests :
  - unitaires pour les fonctions critiques ;
  - intégration pour les workflows core.
