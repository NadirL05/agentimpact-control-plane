# hermesctl v1

Client lecture + proposition pour Cursor (`agentimpact-runner`) via bridge Unix socket.

## Développement

Worktree Git canonique :

```
/opt/agentimpact/runner/worktrees/hermesctl-v1-atomic
```

Branche : `feature/hermesctl-v1-atomic`

## Déploiement atomique

1. Installer tokens dans `/etc/agentimpact/tokens/{bridge,hermes,admin}.env`
2. Migrer scripts (`cp-api.sh` + scripts patchés)
3. Redémarrer API avec auth fail-closed
4. Activer `agentimpact-ctl-bridge.socket` puis `.service`
5. Ajouter `agentimpact-runner` au groupe `agentimpact-ctl`

Playbook : `infra/ansible/playbooks/hermesctl-v1.yml`

## Reconnexion Cursor après ajout au groupe

Linux n'applique pas un nouveau groupe à une session SSH existante.

1. Fermer la session Cursor distante
2. Se reconnecter en SSH (nouvelle session → groupes à jour)
3. Vérifier : `id agentimpact-runner` doit lister `agentimpact-ctl`
4. Tester : `hermesctl health`

## Rollback

`infra/ansible/playbooks/hermesctl-v1-rollback.yml`

## Interdictions v1

ACP, MCP, chat Hermès, dispatch, approve, merge, deploy, shell arbitraire.
