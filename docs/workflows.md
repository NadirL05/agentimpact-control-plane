# Workflows — Control Plane AgentImpact

Ce document d\u00e9crit les workflows core du control plane.

## Workflow d'audit

**Objectif** : v\u00e9rifier la conformit\u00e9 des op\u00e9rations et g\u00e9n\u00e9rer des rapports.

**D\u00e9clencheur** : planifi\u00e9 (ex. hebdo) ou \u00e0 la demande par Hermes-Auditor.

**\u00c9tapes** :
1. Collecte des logs et m\u00e9triques sur la p\u00e9riode.
2. V\u00e9rification des policies (RBAC, secrets, d\u00e9ploiements).
3. G\u00e9n\u00e9ration d'un rapport d'audit.
4. Notification aux Hermes-Operator en cas d'\u00e9cart critique.

## Workflow d'onboarding agent

**Objectif** : int\u00e9grer un nouvel agent dans le control plane.

**D\u00e9clencheur** : demande d'onboarding par un Hermes-Operator.

**\u00c9tapes** :
1. Cr\u00e9ation du profil Hermes associ\u00e9 \u00e0 l'agent.
2. Configuration des acc\u00e8s et permissions.
3. V\u00e9rification de conformit\u00e9 (secrets, policies).
4. Activation de l'agent et notification.

## Workflow de review & validation des changes

**Objectif** : valider les changements de config / code avant merge.

**D\u00e9clencheur** : ouverture d'une PR.

**\u00c9tapes** :
1. Checks automatiques (CI, lint, tests).
2. Revue par un pair (Hermes-Operator ou Hermes-Deployer).
3. Revue s\u00e9curit\u00e9 si changement de policy ou de profil.
4. Merge apr\u00e8s approbation.

## Workflow de d\u00e9ploiement

**Objectif** : d\u00e9ployer des changements en production de mani\u00e8re s\u00e9curis\u00e9e.

**D\u00e9clencheur** : PR merge sur `main` avec tag de version ou demande explicite.

**\u00c9tapes** :
1. Validation des pr\u00e9requis (tests, revue s\u00e9curit\u00e9 si n\u00e9cessaire).
2. Ex\u00e9cution du pipeline de d\u00e9ploiement (Hermes-Deployer).
3. V\u00e9rification post-d\u00e9ploiement (sanity checks).
4. Notification et mise \u00e0 jour du dashboard.
