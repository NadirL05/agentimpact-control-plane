# src — Control Plane AgentImpact

Ce dossier contient le code source du control plane AgentImpact.

## Installation

```bash
cd src
npm install
```

## Commandes

```bash
# Développement (watch)
npm run dev

# Build TypeScript
npm run build

# Lint
npm run lint

# Tests
npm run test
```

## Structure du code

- `src/index.ts` : point d'entré·¢e principal.
- `src/registries/` : registres JSON (profils Hermes, policies, workflows).
- `src/core/` : logique métier (à·¢ venir).
- `src/api/` : API / handlers (à·¢ venir).
- `src/infra/` : intégrations DB, secrets, logs (à·¢ venir).

## Infra hors code (scripts, config Hermes)

Les scripts operationnels (crons, dispatchers, tests d'integration) et la
configuration des profils Hermes sont version-controles a la racine du
depot, sous `infra/` — voir `infra/README.md`. Ils ne font pas partie du
build TypeScript de `src/` mais sont deployes sur le meme VPS.

## Prochaines étapes

1. Implé·¢menter le loader du registre Hermes (`src/core/hermes-profiles.ts`).
2. Ajouter validation Zod sur les profils.
3. Exposer une premiè·¢re API simple (ex. `GET /profiles`).
