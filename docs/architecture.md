# Architecture — Control Plane AgentImpact

Ce document d\u00e9crit l'architecture g\u00e9n\u00e9rale du control plane AgentImpact.

## Objectifs

- Centraliser la gestion des profils Hermes, policies et workflows.
- Fournir un dashboard de pilotage unifi\u00e9.
- Garantir la tra\u00e7abilit\u00e9 et l'auditabilit\u00e9 des op\u00e9rations.

## Composants

### Registres

- **Registre des profils Hermes** : d\u00e9finit les r\u00f4les, capacit\u00e9s et limites de chaque profil.
- **Registre des policies** : r\u00e8gles d'acc\u00e8s, de s\u00e9curit\u00e9 et de conformit\u00e9.
- **Registre des workflows** : d\u00e9finition des workflows core (audit, onboarding, review, d\u00e9ploiement).

### Moteur de workflows

- Orchestre l'ex\u00e9cution des workflows.
- S'appuie sur les policies pour les contr\u00f4les d'acc\u00e8s et de conformit\u00e9.
- G\u00e9n\u00e8re logs et traces pour audit.

### Dashboard

- Agr\u00e8ge m\u00e9triques, logs et \u00e9tats des workflows.
- Permet aux profils Hermes-Operator et Hermes-Auditor de piloter et auditer le syst\u00e8me.

## Flux de donn\u00e9es

1. Les agents et op\u00e9rateurs interagissent avec le control plane via des API / UI.
2. Le moteur de workflows consulte les registres (profils, policies, workflows).
3. Les \u00e9v\u00e9nements sont journalis\u00e9s et envoy\u00e9s au dashboard.
4. Les auditors consultent les logs et g\u00e9n\u00e8rent des rapports.

## Principes de s\u00e9curit\u00e9

- Moindre privil\u00e8ge : chaque profil Hermes a uniquement les capacit\u00e9s n\u00e9cessaires.
- Journalisation syst\u00e9matique des actions sensibles.
- S\u00e9paration des environnements (dev, staging, prod).
- Revue r\u00e9guli\u00e8re des policies et profils.
