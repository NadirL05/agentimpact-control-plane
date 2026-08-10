# Policies — Control Plane AgentImpact

Ce document d\u00e9crit les policies d'acc\u00e8s, de s\u00e9curit\u00e9 et de conformit\u00e9 du control plane.

## RBAC et profils Hermes

- Chaque utilisateur / agent est associ\u00e9 \u00e0 un profil Hermes (Operator, Auditor, Deployer, Viewer).
- Les permissions sont d\u00e9finies par profil dans `AGENTS.md`.
- Toute modification de profil ou de policy doit passer par une PR et une revue s\u00e9curit\u00e9.

## Gestion des secrets

- Les secrets (tokens, cl\u00e9s API, credentials) sont stock\u00e9s dans un gestionnaire de secrets d\u00e9di\u00e9.
- Aucun secret n'est commit\u00e9 dans le repo.
- Rotation r\u00e9guli\u00e8re des secrets critiques.

## Audit et logs

- Toutes les actions sensibles sont journalis\u00e9es (qui, quoi, quand, o\u00f9).
- Les logs sont conserv\u00e9s selon une dur\u00e9e d\u00e9finie par la policy de r\u00e9tention.
- Hermes-Auditor a acc\u00e8s en lecture aux logs et peut g\u00e9n\u00e9rer des rapports d'audit.

## R\u00e8gles de d\u00e9ploiement

- Tout d\u00e9ploiement doit \u00eatre li\u00e9 \u00e0 une PR approuv\u00e9e.
- Les d\u00e9ploiements en production n\u00e9cessitent :
  - une revue s\u00e9curit\u00e9 ;
  - des tests automatis\u00e9s passants ;
  - un feu vert explicite d'un Hermes-Operator.
- Rollback pr\u00e9-configur\u00e9 pour chaque d\u00e9ploiement critique.

## Conformit\u00e9

- Contr\u00f4les r\u00e9guliers de conformit\u00e9 aux policies.
- Les \u00e9carts sont document\u00e9s et corrig\u00e9s via des tickets d\u00e9di\u00e9s.
