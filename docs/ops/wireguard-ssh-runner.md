# SSH officiel Cursor/Codex via WireGuard

Chemin normal (pas l'IP publique VPS) :

```text
Mac (10.66.66.2)
  → WireGuard (wg0)
  → 10.66.66.1:22
  → agentimpact-runner
```

## Constantes réseau (pas des secrets)

```bash
AGENTIMPACT_RUNNER_SSH_HOST=10.66.66.1
AGENTIMPACT_RUNNER_SSH_USER=agentimpact-runner
AGENTIMPACT_RUNNER_SSH_INTERFACE=wg0
AGENTIMPACT_MAC_WG_IP=10.66.66.2
```

## Modèle `~/.ssh/config` (Mac uniquement — ne pas gérer depuis le VPS)

```sshconfig
Host agentimpact
    HostName 10.66.66.1
    User agentimpact-runner
    IdentityFile ~/.ssh/agentimpact_runner_ed25519
    IdentitiesOnly yes
    ServerAliveInterval 30
    ServerAliveCountMax 3
    TCPKeepAlive yes
```

**Ne jamais committer la clé privée.** Le VPS ne doit pas écrire `~/.ssh/config` du Mac.

## UFW — ordre attendu

1. `ALLOW` `10.66.66.2` → `10.66.66.1:22/tcp` sur `wg0` (règle canonique IaC)
2. Règles SSH publiques explicites conservées si présentes (break-glass / exceptions temporaires)
3. `LIMIT 22/tcp Anywhere` (rate-limit public — **jamais** `ALLOW Anywhere` sur 22)

La règle WireGuard doit être **avant** le `LIMIT`, sinon Cursor/Codex (rafales SSH) se font bloquer sur `wg0`.

## Break-glass

- WireGuard SSH = chemin normal Cursor/Codex
- SSH public = secours (rate-limité)
- Ne pas fermer le SSH public dans cette mission

## Exceptions IP temporaires

Des ALLOW publics ponctuels peuvent exister après diagnostic, notamment :

- `45.144.113.141`
- `176.171.153.193`

Ils ne font **pas** partie du design permanent. Ne les supprimer qu'après :

1. déploiement IaC WireGuard
2. vérification ordre UFW
3. smoke Mac `ssh agentimpact` + 15 connexions
4. absence de nouveaux `UFW LIMIT BLOCK` `IN=wg0 SRC=10.66.66.2 DPT=22`

La règle historique `82.224.78.70` doit être analysée séparément (pas de suppression automatique).

## Linger runner

```bash
loginctl enable-linger agentimpact-runner
loginctl show-user agentimpact-runner -p Linger
# Linger=yes
```

Pérennisé via le playbook (fichier `/var/lib/systemd/linger/agentimpact-runner`).

## Playbook

```bash
cd /chemin/vers/agentimpact-control-plane
ANSIBLE_CONFIG=infra/ansible/ansible.cfg \
  ansible-playbook -i localhost, -c local \
  infra/ansible/playbooks/wireguard-ssh-runner.yml
```

Prérequis : exécution **root**, pas de reboot, WireGuard déjà up (`wg0` = `10.66.66.1/24`).

Rollback bundle (sans secret) :

`/var/lib/agentimpact/rollback/wireguard-ssh-runner/`

- `ufw-status-numbered.pre.txt` / `.post.txt`
- `ufw-status-verbose.pre.txt`
- `iptables-save.pre.txt`

## Dettes hors périmètre (documentées, non corrigées ici)

| Flag | Valeur | Note |
| --- | --- | --- |
| `CURSOR_ROOT_REMOTE_DEBT` | `YES` | Processus Cursor observés sous `root` **et** `agentimpact-runner`. Cible = runner seulement. Migration destructive reportée. |
| `CURSOR_PROCESS_ARG_SECRET_EXPOSURE` | `YES` | Une API key Cursor a été visible dans les arguments d'un processus (`ps`). **Rotation/révocation côté Cursor requise.** Ne pas logger ni committer la valeur. |
| `GIT_SAFE_DIRECTORY_DEBT` | `YES` | Des `safe.directory` Git ont été ajoutés manuellement. Ne jamais `safe.directory=*`. Audit séparé — ne pas casser les worktrees actifs. |

## Smoke Mac (à lancer sur le Mac)

```bash
# 1) Une connexion
ssh agentimpact 'echo OK && hostname && whoami'

# 2) Stress 15 connexions consécutives
for i in $(seq 1 15); do
  ssh -o ConnectTimeout=5 agentimpact "echo PASS-$i" || echo "FAIL-$i"
done
```

Puis sur le VPS (root), confirmer l'absence de nouveaux blocs :

```bash
grep 'UFW LIMIT BLOCK' /var/log/ufw.log | grep 'IN=wg0' | grep 'SRC=10.66.66.2' | grep 'DPT=22' | tail
```
