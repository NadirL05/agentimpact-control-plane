"""Tests de non-régression pour les playbooks hermesctl et slack-grok-router."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

PLAYBOOKS = Path(__file__).resolve().parent / "playbooks"


class HermesctlPlaybookRegressionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.content = (PLAYBOOKS / "hermesctl-v1.yml").read_text(encoding="utf-8")
        self.rollback = (PLAYBOOKS / "hermesctl-v1-rollback.yml").read_text(encoding="utf-8")

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

    def test_pg_dump_permissions_0600(self) -> None:
        self.assertIn("chmod 0600", self.content)
        self.assertIn("latest-001.path", self.content)

    def test_rollback_bundle_excludes_credentials_copy(self) -> None:
        self.assertNotRegex(self.content, r"Sauvegarder[^\n]*credentials")
        self.assertNotRegex(self.content, r"dest:.*rollback.*credentials")

    def test_backups_dist_before_sync(self) -> None:
        backup_dist_idx = self.content.index("Sauvegarder dist pre-hermesctl-v1")
        sync_api_idx = self.content.index("Synchroniser code API vers app/src")
        self.assertLess(backup_dist_idx, sync_api_idx)

    def test_pg_backup_before_migration(self) -> None:
        backup_idx = self.content.index("Sauvegarde PostgreSQL pre-migration 001")
        migration_idx = self.content.index("Appliquer migration SQL proposals")
        self.assertLess(backup_idx, migration_idx)

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
        backup_api_idx = self.content.index("Sauvegarder sources API pre-hermesctl-v1")
        backup_compose_idx = self.content.index("Sauvegarder compose.yml pre-hermesctl-v1")
        sync_api_idx = self.content.index("Synchroniser code API vers app/src")
        sync_compose_idx = self.content.index("Synchroniser compose.yml")
        self.assertLess(backup_api_idx, sync_api_idx)
        self.assertLess(backup_compose_idx, sync_compose_idx)

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
