# MCP Brevo — profil agentimpact-growth

Intégration du serveur MCP HTTP officiel Brevo pour le profil Hermes
**agentimpact-growth** (ana) uniquement.

Date de mise en place : 2026-09-02.

## Rôle

- **agentimpact-growth** : consultation Brevo, analyse, préparation commerciale,
  brouillons — avec barrières d'approbation pour toute écriture/envoi.
- **agentimpact-chief-of-staff** et autres profils : **aucun** accès MCP Brevo ;
  délégation vers Growth pour les missions commerciales.

## Endpoint MCP

```text
https://mcp.brevo.com/v1/brevo/mcp
```

Authentification : `Authorization: Bearer ${BREVO_MCP_TOKEN}` (expansion Hermes
depuis le secret du service Growth).

## Secret (hors Git)

Fichier serveur :

```text
/etc/agentimpact/hermes-growth.env
```

- Permissions : `600`
- Propriétaire : `hermes:hermes`
- Variable : `BREVO_MCP_TOKEN`
- Placeholder initial : `À_REMPLACER_MANUELLEMENT`

Chargé **uniquement** par `hermes-gateway-growth.service` via le drop-in systemd
`10-brevo-env.conf`. Jamais dans `config.yaml`, HQ, wrappers ou le dépôt Git.

### Remplacer ou révoquer le token

1. Brevo → Paramètres → SMTP & API → Clés API & MCP.
2. Révoquer l'ancienne clé MCP si compromise.
3. Générer une clé nommée `Hermes AgentImpact Growth` (option MCP activée).
4. Sur le serveur, éditer localement `/etc/agentimpact/hermes-growth.env`
   (ne jamais coller le token dans Cursor, GitHub ou Slack).
5. `sudo systemctl restart hermes-gateway-growth.service`

## Déploiement

Depuis la racine du dépôt control-plane :

```bash
sudo infra/scripts/deploy-brevo-mcp-growth.sh
```

Copie :

- `infra/hermes-profiles/agentimpact-growth/config.yaml` →
  `/home/hermes/.hermes/profiles/agentimpact-growth/config.yaml`
- `SOUL.md` Growth + Chief of Staff
- drop-in systemd Brevo env

Sauvegardes datées : `*.bak-<timestamp>` à côté des fichiers remplacés.

## Redémarrage

Uniquement le gateway Growth :

```bash
sudo systemctl restart hermes-gateway-growth.service
```

Ne pas redémarrer `hermes-gateway.service` ni `hermes-gateway-memoire.service`
pour cette intégration.

## Approbation des envois

Barrières techniques (Hermes v0.20.2) :

1. **`trust: untrusted`** sur le serveur MCP `brevo` — tout outil non
   `readOnlyHint` exige une approbation utilisateur dans l'UI Hermes.
2. **`approvals.mode: manual`** déjà actif sur le profil Growth.
3. **`tools.exclude`** — motifs bloqués sans discovery : envoi, suppression,
   programmation, import/export massif, SMS/WhatsApp.
4. **Règles SOUL** Growth — seconde barrière textuelle ; ne remplace pas
   l'approbation technique pour les outils encore exposés.

Aucun email ni campagne ne doit partir sans validation humaine explicite de Nadir.

## Tests non destructifs

```bash
infra/scripts/verify-brevo-mcp-growth.sh
```

Avec token réel configuré (root/hermes) :

```bash
sudo -u hermes env HERMES_HOME=/home/hermes/.hermes/profiles/agentimpact-growth \
  /usr/local/lib/hermes-agent/venv/bin/python /usr/local/lib/hermes-agent/hermes mcp test brevo
```

Ne pas appeler d'outils d'envoi, de suppression ou d'import.

Vérifier l'isolation Chief / autres profils :

```bash
sudo -u hermes env HERMES_HOME=/home/hermes/.hermes \
  /usr/local/lib/hermes-agent/venv/bin/python /usr/local/lib/hermes-agent/hermes mcp list | rg brevo || echo "OK — pas de brevo"
```

## Désactivation immédiate

```bash
# 1. Désactiver le serveur dans config Growth
#    brevo.enabled: false  (puis redeploy)
# 2. Ou révoquer le token dans Brevo
# 3. Redémarrer Growth
sudo systemctl restart hermes-gateway-growth.service
```

## Limites connues

- Le token placeholder empêche toute connexion MCP — l'intégration n'est
  fonctionnelle qu'après remplacement manuel du secret.
- Les noms d'outils MCP exacts sont découverts à la connexion ; le filtre
  `exclude` utilise des globs (`*send*`, etc.) — affiner après `hermes mcp test brevo`
  si un outil dangereux échappe au motif.
- L'instruction SOUL seule ne bloque pas techniquement un modèle ; `trust: untrusted`
  et `exclude` sont les garde-fous primaires.
- Le déploiement live requiert **root** (accès `/home/hermes`, `/etc/agentimpact`).

## Fichiers versionnés

- `infra/hermes-profiles/agentimpact-growth/config.yaml` — bloc `mcp_servers.brevo`
- `infra/hermes-profiles/agentimpact-growth/SOUL.md` — règles Brevo
- `infra/hermes-profiles/agentimpact-chief-of-staff/SOUL.md` — délégation
- `infra/systemd/hermes-gateway-growth-brevo.env.conf`
- `infra/templates/hermes-growth.env.example`
- `infra/scripts/deploy-brevo-mcp-growth.sh`
- `infra/scripts/verify-brevo-mcp-growth.sh`
