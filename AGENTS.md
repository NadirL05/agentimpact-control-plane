# Profils Hermes — Rô·´´les et capacit&#233;s

Ce fichier d&#233;crit les profils Hermes utilis&#233;s dans le control plane AgentImpact.

## Principes

- Chaque profil Hermes = r&#244;le + capacit&#233;s + limites.
- Un profil est assign&#233; &#224; un type d’agent ou &#224; une famille de workflows.
- Les profils &#233;voluent via PR et revue s&#233;curit&#233;.

## Profils

### Hermes-Operator

- **R&#244;le** : op&#233;rateur principal du control plane.
- **Capacit&#233;s** :
  - lecture/&#233;criture sur les registres de profils et policies ;
  - d&#233;clenchement des workflows d’audit et de review ;
  - acc&#232;s au dashboard et aux indicateurs.
- **Limites** :
  - pas d’acc&#232;s direct aux donn&#233;es sensibles sans policy explicite ;
  - pas de modification des policies core sans validation.

### Hermes-Auditor

- **R&#244;le** : audit et conformit&#233;.
- **Capacit&#233;s** :
  - lecture des logs, traces et m&#233;triques ;
  - g&#233;n&#233;ration de rapports d’audit ;
  - v&#233;rification des policies.
- **Limites** :
  - pas d’&#233;criture sur les configs de production ;
  - pas de d&#233;clenchement de workflows mutatifs.

### Hermes-Deployer

- **R&#244;le** : d&#233;ploiements et changements.
- **Capacit&#233;s** :
  - ex&#233;cution des pipelines de d&#233;ploiement ;
  - application des changes valid&#233;s en review.
- **Limites** :
  - ne peut pas approuver ses propres changes ;
  - soumis aux gates de s&#233;curit&#233; et tests.

### Hermes-Viewer

- **R&#244;le** : lecture seule.
- **Capacit&#233;s** :
  - acc&#232;s aux docs, m&#233;triques et logs en lecture.
- **Limites** :
  - aucune &#233;criture, aucun d&#233;clenchement de workflow.

## Ajout d’un profil

Pour ajouter un profil :

1. Cr&#233;er une section dans ce fichier.
2. D&#233;crire r&#244;le, capacit&#233;s, limites.
3. Soumettre une PR avec justification et revue s&#233;curit&#233;.