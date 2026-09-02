"""Tests de non-régression pour les playbooks hermesctl."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

PLAYBOOKS = Path(__file__).resolve().parent / "playbooks"


class PlaybookRegressionTest(unittest.TestCase):
    def test_work_src_points_to_repo_root_not_infra_infra(self) -> None:
        content = (PLAYBOOKS / "hermesctl-v1.yml").read_text(encoding="utf-8")
        self.assertIn('work_src: "{{ playbook_dir }}/../../../"', content)
        self.assertNotIn("infra/infra/", content)

    def test_migration_uses_compose_service_db(self) -> None:
        content = (PLAYBOOKS / "hermesctl-v1.yml").read_text(encoding="utf-8")
        self.assertIn('docker compose -f "{{ repo_root }}/compose.yml" exec -T db', content)
        self.assertNotIn("agentimpact-db", content)

    def test_creates_agentimpact_ctl_user_before_systemd(self) -> None:
        content = (PLAYBOOKS / "hermesctl-v1.yml").read_text(encoding="utf-8")
        user_idx = content.index("Créer compte système agentimpact-ctl")
        socket_idx = content.index("Installer unités systemd")
        self.assertLess(user_idx, socket_idx)

    def test_syncs_api_and_compose_before_rebuild(self) -> None:
        content = (PLAYBOOKS / "hermesctl-v1.yml").read_text(encoding="utf-8")
        sync_api_idx = content.index("Synchroniser code API vers app/src")
        rebuild_idx = content.index("Redémarrer API (auth fail-closed)")
        self.assertLess(sync_api_idx, rebuild_idx)

    def test_uses_compose_service_api_not_container_name(self) -> None:
        content = (PLAYBOOKS / "hermesctl-v1.yml").read_text(encoding="utf-8")
        self.assertIn("up -d --build api", content)
        self.assertNotIn("agentimpact-api", content)

    def test_rollback_restores_scripts_before_api(self) -> None:
        content = (PLAYBOOKS / "hermesctl-v1-rollback.yml").read_text(encoding="utf-8")
        restore_scripts_idx = content.index("Restaurer scripts versionnés")
        restore_api_idx = content.index("Restaurer sources API versionnées")
        restore_compose_idx = content.index("Restaurer compose.yml versionné")
        api_idx = content.index("Redémarrer API après restauration bundle complète")
        self.assertLess(restore_scripts_idx, api_idx)
        self.assertLess(restore_api_idx, api_idx)
        self.assertLess(restore_compose_idx, api_idx)

    def test_deploy_backups_api_and_compose_before_sync(self) -> None:
        content = (PLAYBOOKS / "hermesctl-v1.yml").read_text(encoding="utf-8")
        backup_api_idx = content.index("Sauvegarder sources API pre-hermesctl-v1")
        backup_compose_idx = content.index("Sauvegarder compose.yml pre-hermesctl-v1")
        sync_api_idx = content.index("Synchroniser code API vers app/src")
        sync_compose_idx = content.index("Synchroniser compose.yml")
        self.assertLess(backup_api_idx, sync_api_idx)
        self.assertLess(backup_compose_idx, sync_compose_idx)

    def test_rollback_fails_on_incomplete_bundle(self) -> None:
        content = (PLAYBOOKS / "hermesctl-v1-rollback.yml").read_text(encoding="utf-8")
        self.assertIn("bundle hermesctl-v1 incomplet", content)
        self.assertIn("rollback_api_src_dir", content)
        self.assertIn("rollback_compose_file", content)

    def test_deploy_validates_training_and_dashboard_env(self) -> None:
        content = (PLAYBOOKS / "hermesctl-v1.yml").read_text(encoding="utf-8")
        self.assertIn("TRAINING_FORM_TOKEN=.+'", content)
        self.assertIn("DASHBOARD_ACCESS_TOKEN=.+'", content)

    def test_rollback_uses_gpasswd_not_user_module_remove(self) -> None:
        content = (PLAYBOOKS / "hermesctl-v1-rollback.yml").read_text(encoding="utf-8")
        self.assertIn("gpasswd -d agentimpact-runner agentimpact-ctl", content)
        self.assertNotRegex(content, r"user:\s*\n\s*name:\s*agentimpact-runner\s*\n\s*groups:.*\n\s*remove:\s*true")

    def test_rollback_uses_compose_service_api(self) -> None:
        content = (PLAYBOOKS / "hermesctl-v1-rollback.yml").read_text(encoding="utf-8")
        self.assertIn("up -d api", content)
        self.assertNotIn("agentimpact-api", content)


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


if __name__ == "__main__":
    unittest.main()
