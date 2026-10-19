# Prospection : premier contrôle en lecture seule

Mission HQ : `missions/backlog/2026-10-20-prospection-apollo-hermes.md`.
Doctrine relue à la tête HQ `ec927163429aa6e3b47dff274c22bd8a836b14ec` :
`AGENTS.md`, `SECURITY.md`, `QUALITY.md`, `agents/SECURITY_POLICY.md`.
Branche isolée : `agent/codex/prospection-apollo-observer`.

## Résultat livré et limites

`infra/scripts/prospection_observer.py` confronte les messages Apollo à leurs
compteurs et vérifie la visibilité locale du profil Growth. Un service actif
ne devient jamais une preuve d'accès au modèle. Un message `completed` sans
preuve de départ reste non confirmé. Les compteurs envoyé et livré se
recouvrent : ils ne sont jamais additionnés.

Ce premier incrément fonctionne sur un instantané exporté en lecture via le
connecteur Apollo. Il ne constitue pas encore l'adaptateur API permanent, un
moniteur planifié, un raccordement au gateway ni un système d'envoi. Il ne
teste pas l'inférence. Le contrôle des identités et de l'ICP reste à construire.

Aucune dépendance ajoutée. Aucune clé requise. Aucun appel réseau, lecture de
configuration ou de secret, changement de permission, lancement de modèle,
écriture en base, approbation, inscription ou action commerciale.

## Utilisation

```bash
python3 infra/scripts/prospection_observer.py --runtime-only
python3 infra/scripts/prospection_observer.py --snapshot /chemin/prive/apollo.json
python3 infra/scripts/prospection_observer.py --snapshot - --probe-runtime < /chemin/prive/apollo.json
python3 -m unittest discover -s infra/scripts -p test_prospection_observer.py -v
```

La sonde locale demande uniquement les métadonnées systemd de
`hermes-gateway-growth.service`, la présence des binaires et le droit de
traverser/lire le dossier du profil existant. Elle ne lit ni son contenu ni
les variables du processus. Le chemin du profil est explicite et fixe.

Code de sortie 0 : observation complète sans anomalie détectée dans son
périmètre. **Ce code ne vaut jamais autorisation ou capacité d'envoi.**
Code 2 : anomalie ou preuve manquante. La sonde runtime renvoie toujours
`inference_not_tested`, même si le dossier est accessible.

## Contrat d'instantané

Objet JSON, version 1 :

| Champ | Contenu |
| --- | --- |
| `schema_version` | Entier `1` |
| `observed_at` | ISO 8601 avec fuseau, début de la collecte |
| `campaign_pages` | Toutes les pages `apollo_emailer_campaigns_search` |
| `message_pages` | Dictionnaire ID de campagne active vers toutes ses pages `apollo_emailer_messages_search` sans filtre de statut |
| `metadata_by_campaign` | Dictionnaire ID de campagne active vers sa réponse `metadata_mode` |

Les objets Apollo bruts et leurs enveloppes MCP textuelles ou
`structuredContent` sont acceptés. La pagination est obligatoire. Les
campagnes inactives sont comptées mais leurs messages ne sont pas inspectés.
Conserver l'instantané dans un espace opérationnel privé, jamais dans Git/HQ.
Les fixtures de test sont synthétiques.

L'instantané doit dater de moins de 30 minutes. Tout export incomplet,
doublon d'identifiant, total changé pendant la collecte, mauvais rattachement
de campagne ou contradiction de statut invalide la lecture. Le collecteur
doit alors refaire une collecte complète, sans réutiliser le résultat
partiel. Cette vérification ne garantit pas un instantané transactionnel
chez Apollo : les comparaisons de compteurs détectent certaines courses,
pas toutes. Il n'y a ni curseur durable ni reprise automatique dans ce lot.

Les sorties contiennent uniquement les identifiants de campagnes, agrégats
et codes de diagnostic. Noms, coordonnées, corps, identifiants de messages
et erreurs libres ne sont pas reproduits. Une raison d'échec inconnue est
classée `other`. Une entrée invalide ne produit jamais de trace brute.

## Suite nécessaire

1. Revue indépendante du code, puis décision humaine de merge.
2. Raccorder une collecte Apollo authentifiée avec droits et capacités prouvés.
3. Préparer une interface de consultation limitée vers le profil Growth
   existant ; aucune extension de permission n'est incluse ici.
4. Ajouter état durable, qualification, messages figés et lot consultable.
5. Valider le lot et le lancement avant toute recette commerciale réelle.

La configuration du profil Growth existant référence aussi une URL d'accès
fournisseur directement dans le dépôt public. La valeur n'est ni reprise ni
utilisée dans ce lot. Son caractère sensible et son remplacement doivent
être traités selon `runbooks/SECURITY_INCIDENT.md` du HQ avant toute nouvelle
utilisation de cet accès ; aucune rotation ou modification de production
n'a été effectuée ici.

## Rollback et revue

Pas de déploiement, migration ou modification du chemin d'envoi. Le retrait
de ces trois fichiers annule ce lot sans toucher les services existants.
La CI Python existante découvre automatiquement le nouveau fichier de tests.
Une revue indépendante reste requise avant merge. Les vérifications de ce
lot ne valent pas validation de l'ensemble du système de prospection.
