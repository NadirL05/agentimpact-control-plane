# src — Control Plane AgentImpact

Ce dossier contient le code source du control plane AgentImpact.

## Objectifs

- Implémenter les registres (profils Hermes, policies, workflows).
- Orchestration des workflows core (audit, onboarding, review, déploiement).
- Exposition d'une API / SDK pour les agents et opérateurs.
- Intégration avec le dashboard de pilotage.

## Structure proposée

- `api/` : points d'entrée API (REST / gRPC / GraphQL, à définir).
- `core/` : logique métier (registres, policies, workflows).
- `infra/` : intégrations (DB, secrets, logs, métriques).
- `services/` : services long-running (orchestrateur, workers).
- `cli/` : outils CLI pour les opérateurs.

## Prochaines étapes

1. Choisir le langage principal (ex. TypeScript, Python, Go).
2. Mettre en place le squelette de projet (package manager, lint, tests).
3. Implémenter un premier module simple (ex. registre des profils Hermes).
4. Ajouter les premières API et tests d'intégration.
