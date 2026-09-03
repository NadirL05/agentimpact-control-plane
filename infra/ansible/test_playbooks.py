"""Tests de non-régression pour les playbooks hermesctl et slack-grok-router."""

from __future__ import annotations

import re
import shutil
import subprocess
import unittest
from pathlib import Path

PLAYBOOKS = Path(__file__).resolve().parent / "playbooks"


def _ansible_task_blocks(content: str) -> list[str]:
    return re.split(r"\n    - name:", content)[1:]


class LoopPreflightRegressionTest(unittest.TestCase):
    def test_no_failed_when_register_results_inside_same_loop_task(self) -> None:
        invalid: list[str] = []
        for playbook in sorted(PLAYBOOKS.glob("*.yml")):
            for block in _ansible_task_blocks(playbook.read_text(encoding="utf-8")):
                if "loop:" in block and re.search(r"failed_when:.*\.results", block):
                    invalid.append(playbook.name)
                    break
        self.assertEqual(invalid, [])

    def test_token_and_credential_stat_disable_checksum_and_mime(self) -> None:
        for playbook in sorted(PLAYBOOKS.glob("*.yml")):
            for block in _ansible_task_blocks(playbook.read_text(encoding="utf-8")):
                if "stat:" not in block:
                    continue
                if "/tokens/" not in block and "/credentials/" not in block:
                    continue
                self.assertIn(
                    "get_checksum: false",
                    block,
                    f"{playbook.name}: stat token/credential sans get_checksum: false",
                )
                self.assertIn(
                    "get_mime: false",
                    block,
                    f"{playbook.name}: stat token/credential sans get_mime: false",
                )

    def test_token_and_credential_stat_use_no_log(self) -> None:
        for playbook in sorted(PLAYBOOKS.glob("*.yml")):
            for block in _ansible_task_blocks(playbook.read_text(encoding="utf-8")):
                if "stat:" not in block:
                    continue
                if "/tokens/" not in block and "/credentials/" not in block:
                    continue
                self.assertIn(
                    "no_log: true",
                    block,
                    f"{playbook.name}: stat token/credential sans no_log: true",
                )

    def test_no_tracked_env_fixture_files(self) -> None:
        repo_root = Path(__file__).resolve().parents[2]
        tracked = subprocess.run(
            ["git", "ls-files", "*.env", "**/*.env"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=False,
        )
        tracked_paths = [line.strip() for line in tracked.stdout.splitlines() if line.strip()]
        new_env_fixtures = [
            p
            for p in tracked_paths
            if "test-fixtures/loop-preflight" in p and p.endswith(".env")
        ]
        self.assertEqual(new_env_fixtures, [], tracked_paths)

    def test_loop_preflight_fixture_sources_not_env_suffix(self) -> None:
        fixture_root = Path(__file__).resolve().parent / "test-fixtures" / "loop-preflight"
        env_sources = list(fixture_root.rglob("*.env"))
        self.assertEqual(env_sources, [])

    def test_runtime_playbook_stat_uses_no_log_and_hardening(self) -> None:
        runtime = (
            Path(__file__).resolve().parent
            / "test-fixtures"
            / "loop-preflight"
            / "runtime-playbook.yml"
        ).read_text(encoding="utf-8")
        stat_block = runtime[runtime.index("Stat loop tokens") : runtime.index("Assert all tokens")]
        self.assertIn("get_checksum: false", stat_block)
        self.assertIn("get_mime: false", stat_block)
        self.assertIn("no_log: true", stat_block)
        self.assertIn("fail_msg: missing_required_token", runtime)

    def test_hermesctl_tokens_use_assert_after_stat_loop(self) -> None:
        content = (PLAYBOOKS / "hermesctl-v1.yml").read_text(encoding="utf-8")
        stat_idx = content.index("Vérifier tokens présents")
        assert_idx = content.index("Échec si un token requis est absent")
        bridge_idx = content.index("Vérifier bridge.env pré-déploiement")
        self.assertLess(stat_idx, assert_idx)
        self.assertLess(assert_idx, bridge_idx)
        assert_block = content[assert_idx : content.index("Vérifier bridge.env pré-déploiement")]
        self.assertIn("token_files.results", assert_block)
        self.assertIn("assert:", assert_block)

    def test_slack_router_credentials_use_assert_after_stat_loop(self) -> None:
        content = (PLAYBOOKS / "slack-grok-router-v1.yml").read_text(encoding="utf-8")
        stat_idx = content.index("Vérifier credentials routeur Slack")
        assert_idx = content.index("Échec si un credential routeur est absent")
        grok_stat_idx = content.index("Vérifier credential Grok worker")
        grok_assert_idx = content.index("Échec si credential Grok absent")
        self.assertLess(stat_idx, assert_idx)
        self.assertLess(assert_idx, grok_stat_idx)
        self.assertLess(grok_stat_idx, grok_assert_idx)
        assert_block = content[assert_idx : content.index("Vérifier credential Grok worker")]
        self.assertIn("missing_required_credential", assert_block)

    def test_host_dist_artifacts_use_assert_after_stat_loop(self) -> None:
        content = (PLAYBOOKS / "slack-grok-router-v1.yml").read_text(encoding="utf-8")
        stat_idx = content.index("Vérifier artefacts build host requis")
        assert_idx = content.index("Échec si un artefact build host est absent")
        rollback_idx = content.index("Créer répertoire rollback bundle slack-grok-router-v1")
        self.assertLess(stat_idx, assert_idx)
        self.assertLess(assert_idx, rollback_idx)


class HermesctlPlaybookRegressionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.content = (PLAYBOOKS / "hermesctl-v1.yml").read_text(encoding="utf-8")
        self.rollback = (PLAYBOOKS / "hermesctl-v1-rollback.yml").read_text(encoding="utf-8")
        self.bundle_tasks = (
            Path(__file__).resolve().parent / "tasks" / "hermesctl_v1_rollback_bundle.yml"
        ).read_text(encoding="utf-8")

    def test_work_src_points_to_repo_root_not_infra_infra(self) -> None:
        self.assertIn('work_src: "{{ playbook_dir }}/../../../"', self.content)
        self.assertNotIn("infra/infra/", self.content)

    def test_migration_uses_compose_service_db(self) -> None:
        self.assertIn('docker compose -f "{{ repo_root }}/compose.yml" exec -T db', self.content)
        self.assertNotIn("agentimpact-db", self.content)

    def test_creates_agentimpact_ctl_user_before_systemd(self) -> None:
        user_idx = self.content.index("Créer compte système agentimpact-ctl")
        socket_idx = self.content.index("Installer unités systemd")
        self.assertLess(user_idx, socket_idx)

    def test_syncs_api_and_compose_before_rebuild(self) -> None:
        sync_api_idx = self.content.index("Synchroniser code API vers app/src")
        rebuild_idx = self.content.index("Redémarrer API (auth fail-closed)")
        self.assertLess(sync_api_idx, rebuild_idx)

    def test_host_build_before_api_restart(self) -> None:
        build_idx = self.content.index("Build Node dans staging")
        rebuild_idx = self.content.index("Redémarrer API (auth fail-closed)")
        self.assertLess(build_idx, rebuild_idx)

    def test_host_build_uses_hermes_in_staging(self) -> None:
        self.assertIn("host_build_user: hermes", self.content)
        self.assertIn("build_staging_dir:", self.content)
        self.assertIn('become_user: "{{ host_build_user }}"', self.content)
        self.assertNotIn("host_build_user: agentimpact-runner", self.content)
        self.assertIn("npm ci", self.content)
        self.assertIn("npm run build", self.content)
        self.assertIn("Installer dist staging vers app/dist", self.content)
        self.assertIn("Propriétaire app/dist hermes", self.content)
        self.assertIn("Supprimer node_modules hôte sous app/src", self.content)

    def test_build_staging_outside_agentimpact_var_lib(self) -> None:
        self.assertIn(
            "build_staging_dir: /var/lib/agentimpact-build/hermesctl-v1",
            self.content,
        )
        self.assertIn("build_root_dir: /var/lib/agentimpact-build", self.content)
        self.assertNotIn(
            "build_staging_dir: /var/lib/agentimpact/build-staging",
            self.content,
        )
        self.assertIn("Créer racine build hermes", self.content)
        self.assertIn("Vérifier staging accessible par hermes avant build", self.content)

    def test_never_weakens_var_lib_agentimpact_permissions(self) -> None:
        self.assertIn("root:root 750", self.content)
        # Aucun chmod/chown ciblant le parent /var/lib/agentimpact.
        self.assertNotRegex(
            self.content,
            r"(chmod|chown).*/var/lib/agentimpact[^\-/a-z]",
        )
        root_block = self.content[
            self.content.index("Créer racine build hermes") :
            self.content.index("Créer répertoire staging build")
        ]
        self.assertIn('mode: "0750"', root_block)
        self.assertIn('owner: "{{ app_owner }}"', root_block)
        self.assertNotIn("0777", root_block)
        self.assertNotIn("0755", root_block)

    def test_resume_reuses_complete_rollback_bundle(self) -> None:
        self.assertIn("hermesctl_v1_rollback_bundle.yml", self.content)
        self.assertIn("Détecter état du bundle rollback hermesctl-v1", self.bundle_tasks)
        self.assertIn("reuse_rollback_bundle", self.bundle_tasks)
        self.assertIn('echo "complete"', self.bundle_tasks)
        include_idx = self.content.index("Préparer / réutiliser le bundle rollback hermesctl-v1")
        sync_idx = self.content.index("Synchroniser compose.yml")
        mig_idx = self.content.index("Appliquer migration SQL proposals")
        self.assertLess(include_idx, sync_idx)
        self.assertLess(sync_idx, mig_idx)
        backup_scripts = self.bundle_tasks[
            self.bundle_tasks.index("Sauvegarder scripts pre-hermesctl-v1") :
            self.bundle_tasks.index("Sauvegarder sources API pre-hermesctl-v1")
        ]
        self.assertIn("not (reuse_rollback_bundle | bool)", backup_scripts)
        pg_block = self.bundle_tasks[
            self.bundle_tasks.index("Sauvegarde PostgreSQL pre-migration 001 (docker)") :
            self.bundle_tasks.index("Sauvegarde PostgreSQL pre-migration 001 (fixture test)")
        ]
        self.assertIn("not (reuse_rollback_bundle | bool)", pg_block)

    def test_resume_refuses_partial_rollback_bundle(self) -> None:
        self.assertIn("Échec si bundle rollback partiel ou incohérent", self.bundle_tasks)
        self.assertIn("rollback_bundle_incomplete", self.bundle_tasks)
        self.assertIn('echo "partial"', self.bundle_tasks)

    def test_fresh_install_creates_bundle_before_sync(self) -> None:
        create_idx = self.bundle_tasks.index("Créer répertoire rollback bundle hermesctl-v1")
        backup_idx = self.bundle_tasks.index("Sauvegarder sources API pre-hermesctl-v1")
        include_idx = self.content.index("Préparer / réutiliser le bundle rollback hermesctl-v1")
        sync_idx = self.content.index("Synchroniser code API vers app/src")
        self.assertLess(create_idx, backup_idx)
        self.assertLess(include_idx, sync_idx)
        create_block = self.bundle_tasks[
            create_idx : self.bundle_tasks.index("Créer répertoire sauvegarde PostgreSQL")
        ]
        self.assertIn("not (reuse_rollback_bundle | bool)", create_block)

    def test_bundle_validation_precedes_any_app_sync_or_migration(self) -> None:
        include_idx = self.content.index("Préparer / réutiliser le bundle rollback hermesctl-v1")
        for name in (
            "Synchroniser compose.yml",
            "Synchroniser migrations SQL vers app/src/migrations",
            "Synchroniser code API vers app/src",
            "Appliquer migration SQL proposals",
            "Installer dist staging vers app/dist",
        ):
            self.assertLess(include_idx, self.content.index(name), name)

    def test_latest_001_path_validated_without_leaking_path(self) -> None:
        self.assertIn("Valider pointeur latest-001.path et dump associé", self.bundle_tasks)
        self.assertIn("invalid_pg_backup_pointer", self.bundle_tasks)
        self.assertIn('echo "invalid_pg_backup_pointer"', self.bundle_tasks)
        self.assertIn("readlink -f", self.bundle_tasks)
        self.assertIn("pg_backup_001=ok", self.bundle_tasks)
        self.assertNotIn("pg_backup_001={{ pg_backup_001.stdout", self.bundle_tasks)

    def test_app_dist_absent_marker_recorded_and_honored_on_rollback(self) -> None:
        self.assertIn("Enregistrer absence initiale de app/dist", self.bundle_tasks)
        self.assertIn("app-dist.absent", self.bundle_tasks)
        self.assertIn("Supprimer dist créé par déploiement (aucun dist initial)", self.rollback)
        self.assertIn("app-dist.absent", self.rollback)
        restore_block = self.rollback[
            self.rollback.index("Restaurer dist versionné pre-hermesctl-v1") :
            self.rollback.index("Restaurer scripts versionnés pre-hermesctl-v1")
        ]
        self.assertIn("not (dist_absent_marker.stat.exists", restore_block)

    def test_pg_dump_permissions_0600(self) -> None:
        self.assertIn("chmod 0600", self.bundle_tasks)
        self.assertIn("latest-001.path", self.bundle_tasks)

    def test_rollback_bundle_excludes_credentials_copy(self) -> None:
        self.assertNotRegex(self.content, r"Sauvegarder[^\n]*credentials")
        self.assertNotRegex(self.content, r"dest:.*rollback.*credentials")
        self.assertNotRegex(self.bundle_tasks, r"dest:.*rollback.*credentials")

    def test_backups_dist_before_sync(self) -> None:
        self.assertIn("Sauvegarder dist pre-hermesctl-v1", self.bundle_tasks)
        include_idx = self.content.index("Préparer / réutiliser le bundle rollback hermesctl-v1")
        sync_api_idx = self.content.index("Synchroniser code API vers app/src")
        self.assertLess(include_idx, sync_api_idx)

    def test_pg_backup_before_migration(self) -> None:
        self.assertIn("Sauvegarde PostgreSQL pre-migration 001 (docker)", self.bundle_tasks)
        include_idx = self.content.index("Préparer / réutiliser le bundle rollback hermesctl-v1")
        migration_idx = self.content.index("Appliquer migration SQL proposals")
        self.assertLess(include_idx, migration_idx)

    def test_compose_readable_validation(self) -> None:
        self.assertIn("Vérifier compose.yml lisible par root", self.content)
        self.assertIn("Vérifier services api et db dans compose", self.content)

    def test_tmpfiles_create_on_deploy(self) -> None:
        self.assertIn("systemd-tmpfiles --create /etc/tmpfiles.d/agentimpact-ctl.conf", self.content)

    def test_uses_compose_service_api_not_container_name(self) -> None:
        self.assertIn("up -d --build api", self.content)
        self.assertNotIn("agentimpact-api", self.content)

    def test_rollback_restores_dist_before_api(self) -> None:
        restore_dist_idx = self.rollback.index("Restaurer dist versionné")
        api_idx = self.rollback.index("Redémarrer API après restauration bundle complète")
        self.assertLess(restore_dist_idx, api_idx)

    def test_rollback_restores_scripts_before_api(self) -> None:
        restore_scripts_idx = self.rollback.index("Restaurer scripts versionnés")
        restore_api_idx = self.rollback.index("Restaurer sources API versionnées")
        restore_compose_idx = self.rollback.index("Restaurer compose.yml versionné")
        api_idx = self.rollback.index("Redémarrer API après restauration bundle complète")
        self.assertLess(restore_scripts_idx, api_idx)
        self.assertLess(restore_api_idx, api_idx)
        self.assertLess(restore_compose_idx, api_idx)

    def test_deploy_backups_api_and_compose_before_sync(self) -> None:
        self.assertIn("Sauvegarder sources API pre-hermesctl-v1", self.bundle_tasks)
        self.assertIn("Sauvegarder compose.yml pre-hermesctl-v1", self.bundle_tasks)
        include_idx = self.content.index("Préparer / réutiliser le bundle rollback hermesctl-v1")
        sync_api_idx = self.content.index("Synchroniser code API vers app/src")
        sync_compose_idx = self.content.index("Synchroniser compose.yml")
        self.assertLess(include_idx, sync_compose_idx)
        self.assertLess(include_idx, sync_api_idx)
        self.assertLess(sync_compose_idx, sync_api_idx)

    def test_rollback_fails_on_incomplete_bundle(self) -> None:
        self.assertIn("bundle hermesctl-v1 incomplet", self.rollback)
        self.assertIn("rollback_api_src_dir", self.rollback)
        self.assertIn("rollback_compose_file", self.rollback)

    def test_deploy_validates_training_and_dashboard_env(self) -> None:
        self.assertIn("TRAINING_FORM_TOKEN=.+'", self.content)
        self.assertIn("DASHBOARD_ACCESS_TOKEN=.+'", self.content)

    def test_rollback_uses_gpasswd_not_user_module_remove(self) -> None:
        self.assertIn("gpasswd -d agentimpact-runner agentimpact-ctl", self.rollback)
        self.assertNotRegex(
            self.rollback,
            r"user:\s*\n\s*name:\s*agentimpact-runner\s*\n\s*groups:.*\n\s*remove:\s*true",
        )

    def test_rollback_uses_compose_service_api(self) -> None:
        self.assertIn("up -d api", self.rollback)
        self.assertNotIn("agentimpact-api", self.rollback)

    def test_bridge_env_preflight_accepts_root_before_ctl_user(self) -> None:
        self.assertIn("Vérifier bridge.env pré-déploiement", self.content)
        self.assertIn("root:root|root:agentimpact-ctl", self.content)
        preflight_idx = self.content.index("Vérifier bridge.env pré-déploiement")
        user_idx = self.content.index("Créer compte système agentimpact-ctl")
        self.assertLess(preflight_idx, user_idx)

    def test_bridge_env_applied_after_ctl_user_creation(self) -> None:
        user_idx = self.content.index("Créer compte système agentimpact-ctl")
        apply_idx = self.content.index("Appliquer propriétaire bridge.env pour lecture agentimpact-ctl")
        verify_idx = self.content.index("Vérifier permissions finales bridge.env")
        systemd_idx = self.content.index("Installer unités systemd")
        self.assertLess(user_idx, apply_idx)
        self.assertLess(apply_idx, verify_idx)
        self.assertLess(verify_idx, systemd_idx)
        self.assertIn('path: /etc/agentimpact/tokens/bridge.env', self.content)
        self.assertIn("owner: agentimpact-ctl", self.content)
        self.assertIn("group: agentimpact-ctl", self.content)
        self.assertIn('mode: "0400"', self.content)

    def test_bridge_env_final_mode_0400_no_group_other_read(self) -> None:
        block = self.content[
            self.content.index("Vérifier permissions finales bridge.env") :
            self.content.index("Vérifier hermes.env et admin.env restent root:root 0600")
        ]
        self.assertIn("agentimpact-ctl:agentimpact-ctl", block)
        self.assertIn('"400"', block)
        self.assertIn('"$group" -ge 4', block)
        self.assertIn('"$other" -ge 4', block)

    def test_hermes_admin_tokens_remain_root_0600_not_bridge_accessible(self) -> None:
        block = self.content[
            self.content.index("Vérifier hermes.env et admin.env restent root:root 0600") :
            self.content.index("Vérifier secrets training et dashboard dans .env")
        ]
        self.assertIn("/etc/agentimpact/tokens/hermes.env", block)
        self.assertIn("/etc/agentimpact/tokens/admin.env", block)
        self.assertIn("root:root", block)
        self.assertIn('"600"', block)
        apply_block = self.content[
            self.content.index("Appliquer propriétaire bridge.env") :
            self.content.index("Vérifier permissions finales bridge.env")
        ]
        self.assertNotIn("hermes.env", apply_block)
        self.assertNotIn("admin.env", apply_block)

    def test_token_tasks_never_display_secrets(self) -> None:
        token_section = self.content[
            self.content.index("Vérifier tokens présents") :
            self.content.index("Vérifier espace disque suffisant")
        ]
        self.assertIn("stat:", token_section)
        self.assertNotIn("slurp:", token_section)
        self.assertNotIn("cat ", token_section)
        self.assertNotIn("debug:", token_section)

    def test_rollback_does_not_modify_token_permissions(self) -> None:
        self.assertNotIn("/etc/agentimpact/tokens", self.rollback)
        self.assertNotIn("bridge.env", self.rollback)
        self.assertNotIn("chown", self.rollback)
        self.assertNotIn("chmod", self.rollback)


class BridgeTokenPermissionsRegressionTest(unittest.TestCase):
    PLAYBOOK = PLAYBOOKS / "hermesctl-v1.yml"
    SERVICE = Path(__file__).resolve().parents[1] / "systemd" / "agentimpact-ctl-bridge.service"
    BRIDGE_EXAMPLE = Path(__file__).resolve().parents[1] / "tokens" / "bridge.env.example"

    def setUp(self) -> None:
        self.playbook = self.PLAYBOOK.read_text(encoding="utf-8")
        self.service = self.SERVICE.read_text(encoding="utf-8")
        self.example = self.BRIDGE_EXAMPLE.read_text(encoding="utf-8")

    def test_service_and_playbook_use_same_bridge_env_path(self) -> None:
        path = "/etc/agentimpact/tokens/bridge.env"
        self.assertIn(f"ConditionPathExists={path}", self.service)
        self.assertIn(f"EnvironmentFile={path}", self.service)
        self.assertIn(path, self.playbook)

    def test_bridge_env_example_documents_0400_agentimpact_ctl(self) -> None:
        self.assertIn("0400 agentimpact-ctl:agentimpact-ctl", self.example)
        self.assertNotIn("0600 root:agentimpact-ctl", self.example)

    def test_bridge_service_runs_as_agentimpact_ctl(self) -> None:
        self.assertIn("User=agentimpact-ctl", self.service)
        self.assertIn("Group=agentimpact-ctl", self.service)


class SlackGrokPlaybookRegressionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.content = (PLAYBOOKS / "slack-grok-router-v1.yml").read_text(encoding="utf-8")
        self.rollback = (PLAYBOOKS / "slack-grok-router-v1-rollback.yml").read_text(encoding="utf-8")

    def test_migration_002_uses_compose_service_db(self) -> None:
        self.assertIn('docker compose -f "{{ repo_root }}/compose.yml" exec -T db', self.content)
        self.assertIn("002_slack_router.sql", self.content)
        self.assertIn("ON_ERROR_STOP=1", self.content)
        self.assertRegex(
            self.content,
            r'exec -T db\s*\\\n\s*psql -v ON_ERROR_STOP=1',
        )
        self.assertIn('< "{{ repo_root }}/app/src/migrations/002_slack_router.sql"', self.content)
        self.assertNotRegex(self.content, r"psql\s+-h\s+127\.0\.0\.1")
        self.assertNotRegex(self.content, r"environment:\s*\n\s*PGPASSWORD")

    def test_creates_cursor_grok_worker_idempotently(self) -> None:
        self.assertIn("Vérifier si cursor-grok-worker existe déjà", self.content)
        self.assertIn("Créer utilisateur cursor-grok-worker si absent", self.content)
        self.assertIn("home: /var/lib/cursor-grok-worker", self.content)

    def test_validates_grok_cli_and_workspace(self) -> None:
        self.assertIn("/var/lib/cursor-grok-worker/.local/bin/agent", self.content)
        self.assertIn("/opt/agentimpact/grokbot/workspace", self.content)
        self.assertIn("--version", self.content)

    def test_atomic_backup_before_install(self) -> None:
        backup_dist_idx = self.content.index("Sauvegarder dist pre-slack-grok")
        install_idx = self.content.index("Installer unités systemd routeur")
        self.assertLess(backup_dist_idx, install_idx)

    def test_pg_backup_before_migration_002(self) -> None:
        backup_idx = self.content.index("Sauvegarde PostgreSQL pre-migration 002")
        migration_idx = self.content.index("Appliquer migration 002 slack router")
        self.assertLess(backup_idx, migration_idx)

    def test_inbox_consumer_services_installed(self) -> None:
        self.assertIn("agentimpact-gateway-inbox-hermes.service", self.content)
        self.assertIn("agentimpact-gateway-inbox-ana.service", self.content)

    def test_router_not_auto_started(self) -> None:
        self.assertIn("sans démarrage routeur", self.content)
        self.assertNotRegex(
            self.content,
            r"name:\s*agentimpact-slack-router\.service\s*\n\s*enabled:\s*true",
        )
        self.assertNotIn("state: started", self.content)

    def test_rollback_stops_all_services(self) -> None:
        self.assertIn("agentimpact-gateway-inbox-hermes.service", self.rollback)
        self.assertIn("agentimpact-gateway-inbox-ana.service", self.rollback)
        self.assertIn("grokbot.disabled", self.rollback)

    def test_rollback_restores_bundle(self) -> None:
        self.assertIn("Restaurer dist versionné", self.rollback)
        self.assertIn("Restaurer scripts gérés versionnés", self.rollback)
        self.assertIn("Restaurer unités systemd versionnées", self.rollback)
        self.assertIn("systemctl daemon-reload", self.rollback)

    def test_validates_host_dist_artifacts(self) -> None:
        self.assertIn("slack-router/daemon.js", self.content)
        self.assertIn("grok-worker/server.js", self.content)

    def test_configs_non_secretes_validation(self) -> None:
        self.assertIn("Vérifier configs non secrètes avant sauvegarde", self.content)
        self.assertIn("secret_in_non_secret_config", self.content)

    def test_rollback_bundle_excludes_credentials_copy(self) -> None:
        self.assertNotRegex(self.content, r"Sauvegarder[^\n]*credentials")
        self.assertNotRegex(self.rollback, r"dest:.*credentials")

    def test_slack_router_db_credential_required(self) -> None:
        self.assertIn("slack-router-db-password", self.content)


class SystemdRegressionTest(unittest.TestCase):
    SYSTEMD = Path(__file__).resolve().parents[1] / "systemd"

    def test_router_depends_on_grok_socket_not_service(self) -> None:
        content = (self.SYSTEMD / "agentimpact-slack-router.service").read_text(encoding="utf-8")
        self.assertIn("Requires=agentimpact-grok-worker.socket", content)
        self.assertNotIn("Requires=agentimpact-grok-worker.service", content)

    def test_grok_socket_activation(self) -> None:
        socket = (self.SYSTEMD / "agentimpact-grok-worker.socket").read_text(encoding="utf-8")
        service = (self.SYSTEMD / "agentimpact-grok-worker.service").read_text(encoding="utf-8")
        self.assertIn("Service=agentimpact-grok-worker.service", socket)
        self.assertIn("SocketGroup=agentimpact-grok-client", socket)
        self.assertIn("SocketMode=0660", socket)
        self.assertIn("TriggeredBy=agentimpact-grok-worker.socket", service)
        self.assertNotIn("[Install]", service)

    def test_grok_socket_group_is_grok_client(self) -> None:
        socket = (self.SYSTEMD / "agentimpact-grok-worker.socket").read_text(encoding="utf-8")
        self.assertIn("SocketGroup=agentimpact-grok-client", socket)

    def test_grok_socket_mode_is_0660(self) -> None:
        socket = (self.SYSTEMD / "agentimpact-grok-worker.socket").read_text(encoding="utf-8")
        self.assertIn("SocketMode=0660", socket)
        self.assertNotIn("SocketMode=0777", socket)
        self.assertNotIn("SocketMode=0666", socket)

    def test_grok_runtime_directory_mode_owner_and_group_only(self) -> None:
        socket = (self.SYSTEMD / "agentimpact-grok-worker.socket").read_text(encoding="utf-8")
        tmpfiles = (
            self.SYSTEMD / "agentimpact-slack-router.tmpfiles.conf"
        ).read_text(encoding="utf-8")
        self.assertIn("DirectoryMode=0750", socket)
        self.assertNotIn("DirectoryMode=0755", socket)
        self.assertNotIn("DirectoryMode=0777", socket)
        self.assertRegex(
            tmpfiles,
            r"d /run/agentimpact-grok-worker 0750 cursor-grok-worker agentimpact-grok-client",
        )

    def test_grok_worker_service_does_not_claim_runtime_directory(self) -> None:
        service = (self.SYSTEMD / "agentimpact-grok-worker.service").read_text(encoding="utf-8")
        self.assertNotIn("RuntimeDirectory=", service)
        self.assertNotIn("RuntimeDirectoryMode=", service)
        self.assertIn("Requires=agentimpact-grok-worker.socket", service)

    def test_grok_runtime_directory_authority_is_socket_unit(self) -> None:
        socket = (self.SYSTEMD / "agentimpact-grok-worker.socket").read_text(encoding="utf-8")
        service = (self.SYSTEMD / "agentimpact-grok-worker.service").read_text(encoding="utf-8")
        tmpfiles = (
            self.SYSTEMD / "agentimpact-slack-router.tmpfiles.conf"
        ).read_text(encoding="utf-8")
        self.assertIn("ListenStream=/run/agentimpact-grok-worker/grok.sock", socket)
        self.assertIn("SocketUser=cursor-grok-worker", socket)
        self.assertIn("SocketGroup=agentimpact-grok-client", socket)
        self.assertNotIn("RuntimeDirectory=", service)
        self.assertRegex(
            tmpfiles,
            r"d /run/agentimpact-grok-worker 0750 cursor-grok-worker agentimpact-grok-client",
        )

    def test_grok_socket_supports_repeated_router_connections(self) -> None:
        """Socket activation garde le descripteur ; le worker ne reprend pas le répertoire."""
        socket = (self.SYSTEMD / "agentimpact-grok-worker.socket").read_text(encoding="utf-8")
        service = (self.SYSTEMD / "agentimpact-grok-worker.service").read_text(encoding="utf-8")
        router = (self.SYSTEMD / "agentimpact-slack-router.service").read_text(encoding="utf-8")
        self.assertIn("Service=agentimpact-grok-worker.service", socket)
        self.assertIn("SocketGroup=agentimpact-grok-client", socket)
        self.assertNotIn("RuntimeDirectory=", service)
        self.assertIn("SupplementaryGroups=agentimpact-grok-client", router)
        self.assertIn("ReadOnlyPaths=/etc/agentimpact/flags /run/agentimpact-grok-worker", router)

    def test_grok_worker_restart_preserves_router_socket_access(self) -> None:
        """Redémarrage worker : socket inchangé (unité socket), groupe client conservé."""
        socket = (self.SYSTEMD / "agentimpact-grok-worker.socket").read_text(encoding="utf-8")
        service = (self.SYSTEMD / "agentimpact-grok-worker.service").read_text(encoding="utf-8")
        router = (self.SYSTEMD / "agentimpact-slack-router.service").read_text(encoding="utf-8")
        self.assertIn("Restart=on-failure", service)
        self.assertNotIn("RuntimeDirectory=", service)
        self.assertIn("TriggeredBy=agentimpact-grok-worker.socket", service)
        self.assertIn("Requires=agentimpact-grok-worker.socket", router)
        self.assertNotIn("Requires=agentimpact-grok-worker.service", router)
        self.assertIn("SocketGroup=agentimpact-grok-client", socket)

    def test_router_sets_node_env_production(self) -> None:
        content = (self.SYSTEMD / "agentimpact-slack-router.service").read_text(encoding="utf-8")
        self.assertIn("Environment=NODE_ENV=production", content)

    def test_router_loadcredential_secrets(self) -> None:
        content = (self.SYSTEMD / "agentimpact-slack-router.service").read_text(encoding="utf-8")
        self.assertIn("LoadCredential=slack-router-db-password", content)
        self.assertIn("PGPASSWORD_FILE=%d/slack-router-db-password", content)
        self.assertNotIn("PGPASSWORD=", content)

    def test_inbox_services_use_hermes_not_root(self) -> None:
        for name in ("agentimpact-gateway-inbox-hermes.service", "agentimpact-gateway-inbox-ana.service"):
            content = (self.SYSTEMD / name).read_text(encoding="utf-8")
            self.assertIn("User=hermes", content)
            self.assertNotIn("User=root", content)
            self.assertIn("LoadCredential=gateway-bridge-token", content)
            self.assertIn("Restart=on-failure", content)
            self.assertNotIn("state: started", content)

    def test_inbox_hermes_uses_nadir_operator_profile(self) -> None:
        content = (self.SYSTEMD / "agentimpact-gateway-inbox-hermes.service").read_text(
            encoding="utf-8"
        )
        self.assertIn("HERMES_PROFILE=nadir-operator", content)
        self.assertNotIn("HERMES_PROFILE=default", content)

    def test_inbox_ana_uses_agentimpact_growth_profile(self) -> None:
        content = (self.SYSTEMD / "agentimpact-gateway-inbox-ana.service").read_text(
            encoding="utf-8"
        )
        self.assertIn("HERMES_PROFILE=agentimpact-growth", content)
        self.assertNotIn("HERMES_PROFILE=default", content)


class ComposeRegressionTest(unittest.TestCase):
    def test_api_loads_tokens_via_env_file(self) -> None:
        content = (Path(__file__).resolve().parents[1] / "compose.yml").read_text(
            encoding="utf-8"
        )
        self.assertIn("env_file:", content)
        self.assertIn("/etc/agentimpact/tokens/bridge.env", content)
        self.assertIn("/etc/agentimpact/tokens/hermes.env", content)
        self.assertIn("/etc/agentimpact/tokens/admin.env", content)
        self.assertIn("TRAINING_FORM_TOKEN:", content)
        self.assertIn("DASHBOARD_ACCESS_TOKEN:", content)
        self.assertIn("TRAINING_FORM_TOKEN manquant", content)
        self.assertIn("DASHBOARD_ACCESS_TOKEN manquant", content)

    def test_db_mounts_migrations_volume(self) -> None:
        content = (Path(__file__).resolve().parents[1] / "compose.yml").read_text(
            encoding="utf-8"
        )
        self.assertRegex(content, r"\./app/src/migrations:/migrations:ro")

    def test_db_publishes_loopback_5432_only(self) -> None:
        content = (Path(__file__).resolve().parents[1] / "compose.yml").read_text(
            encoding="utf-8"
        )
        self.assertIn('"127.0.0.1:5432:5432"', content)
        self.assertNotRegex(content, r'["\']0\.0\.0\.0:5432')
        self.assertNotRegex(content, r'["\']:::5432')
        self.assertNotRegex(content, r'["\']5432:5432"')

    def test_api_pghost_uses_compose_service_not_loopback(self) -> None:
        """L'API conteneurisée reste sur le réseau Docker interne (PGHOST=db)."""
        content = (Path(__file__).resolve().parents[1] / "compose.yml").read_text(
            encoding="utf-8"
        )
        self.assertRegex(content, r"PGHOST:\s*db")
        self.assertNotRegex(content, r"PGHOST:\s*127\.0\.0\.1")

    def test_slack_router_env_example_uses_loopback_pghost(self) -> None:
        template = (
            Path(__file__).resolve().parents[1]
            / "templates"
            / "slack-router.env.example"
        ).read_text(encoding="utf-8")
        self.assertIn("PGHOST=127.0.0.1", template)
        self.assertIn("PGPORT=5432", template)
        self.assertIn("SLACK_NATIVE_AGENT_USER_IDS", template)
        self.assertNotRegex(template, r"^PGPASSWORD=", re.MULTILINE)

    def test_compose_config_db_loopback_without_secret_leak(self) -> None:
        import subprocess
        import tempfile

        if shutil.which("docker") is None:
            self.skipTest("Docker CLI indisponible dans cet environnement")

        infra = Path(__file__).resolve().parents[1]
        compose = infra / "compose.yml"
        env_file = infra / "test-fixtures" / "compose.config.env.example"
        full = compose.read_text(encoding="utf-8")
        db_block = re.search(r"^  db:\n(?:    .+\n)+", full, re.MULTILINE)
        self.assertIsNotNone(db_block, "bloc service db introuvable dans compose.yml")

        with tempfile.TemporaryDirectory() as tmp:
            minimal = Path(tmp) / "compose.db-test.yml"
            minimal.write_text(
                "services:\n" + db_block.group(0) + "\nvolumes:\n  postgres_data:\n",
                encoding="utf-8",
            )
            proc = subprocess.run(
                [
                    "docker",
                    "compose",
                    "-f",
                    str(minimal),
                    "--env-file",
                    str(env_file),
                    "config",
                ],
                capture_output=True,
                text=True,
                check=False,
                timeout=60,
            )
        if proc.returncode != 0:
            self.skipTest("docker compose config indisponible dans cet environnement")
        rendered = proc.stdout
        self.assertIn("host_ip: 127.0.0.1", rendered)
        self.assertIn('published: "5432"', rendered)
        self.assertIn("target: 5432", rendered)
        self.assertNotIn("host_ip: 0.0.0.0", rendered)
        self.assertNotIn("host_ip: ::", rendered)


class GatewayInboxConsumerRegressionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.script = (
            Path(__file__).resolve().parents[1] / "scripts" / "gateway-inbox-consumer.py"
        ).read_text(encoding="utf-8")

    def test_supports_loop_mode(self) -> None:
        self.assertIn('"--loop"', self.script)
        self.assertIn("run_loop", self.script)

    def test_bounded_backoff(self) -> None:
        self.assertIn("LOOP_MAX_SLEEP_SEC", self.script)
        self.assertIn("min(sleep_sec * 2", self.script)

    def test_loadcredential_file_support(self) -> None:
        self.assertIn("SLACK_ROUTER_BRIDGE_TOKEN_FILE", self.script)

    def test_devin_not_allowed(self) -> None:
        self.assertIn("forbidden_target", self.script)
        self.assertIn("REJECTED_TARGETS", self.script)
        self.assertIn("target_mismatch", self.script)


if __name__ == "__main__":
    unittest.main()
