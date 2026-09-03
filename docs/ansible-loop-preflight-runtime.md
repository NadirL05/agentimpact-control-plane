# Worksheet — incident preflight Ansible loop (`register.results`)

Worktree : `/opt/agentimpact/runner/worktrees/ansible-loop-preflight-runtime`
Branche : `fix/ansible-loop-preflight-runtime`

## Incident

Le déploiement **hermesctl-v1** a échoué **avant toute mutation** sur la tâche « Vérifier tokens présents ».

Erreur observée :

```text
'dict object' has no attribute 'results'
```

## Cause racine

Une tâche `stat` avec `loop` et `register: token_files` utilisait dans **la même tâche** :

```yaml
failed_when: not token_files.results | map(attribute='stat.exists') | list | min
```

Ansible évalue `failed_when` **à chaque itération**. Pendant la boucle, `register` ne contient pas encore `.results` (agrégat disponible uniquement après la fin de la boucle).

## Correction

1. `stat` en boucle **sans** `failed_when` sur `.results`.
2. Tâche `assert` **séparée** après la boucle pour valider que tous les fichiers existent.
3. Pour tout `stat` sur token/credential : `get_checksum: false` et `get_mime: false` (aucun checksum ni MIME dans les logs).
4. Même pattern appliqué à :
   - credentials routeur Slack (`slack-grok-router-v1.yml`) ;
   - artefacts build host (`slack-grok-router-v1.yml`).

## Fichiers modifiés

| Fichier | Changement |
| --- | --- |
| `infra/ansible/playbooks/hermesctl-v1.yml` | stat loop + assert tokens |
| `infra/ansible/playbooks/slack-grok-router-v1.yml` | stat loop + assert credentials et dist |
| `infra/ansible/test_playbooks.py` | tests statiques anti-régression |
| `infra/ansible/test_loop_preflight_runtime.py` | exécution Ansible réelle sur fixtures |
| `infra/ansible/test-fixtures/loop-preflight/` | fixtures + playbook runtime |

## Tests runtime

```bash
python3 infra/ansible/test_loop_preflight_runtime.py
python3 infra/ansible/test_playbooks.py
```

- Fixtures `present/` : sources `*.env.fixture` copiées en répertoire temporaire (`bridge.env`, …) — **jamais versionnées**.
- Fixtures `missing/` : `admin.env` absent après copie → échec `missing_required_token`.

Les tâches `stat` sur tokens/credentials utilisent `no_log: true`, `get_checksum: false`, `get_mime: false`.

## Rollback

Aucun changement de rollback requis : l'incident se produisait en **preflight**, avant création de répertoires rollback, sync code ou migration.
