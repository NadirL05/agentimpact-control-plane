from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[1]

class CodexWorkerIaCTest(unittest.TestCase):
    def setUp(self):
        self.unit=(ROOT/'systemd/agentimpact-codex-worker@.service').read_text()
        self.control=(ROOT/'systemd/agentimpact-codex-control.service').read_text()
        self.socket=(ROOT/'systemd/agentimpact-codex-control.socket').read_text()
        self.play=(ROOT/'ansible/playbooks/v2-codex-worker.yml').read_text()
        self.rollback=(ROOT/'ansible/playbooks/v2-codex-worker-rollback.yml').read_text()
        self.runbook=(ROOT.parent/'docs/v2-b-codex-worker.md').read_text()

    def test_non_root_and_no_privileged_surfaces(self):
        for value in ('User=agentimpact-codex-worker','NoNewPrivileges=yes','ProtectSystem=strict',
                      'ProtectHome=yes','CapabilityBoundingSet=','RestrictAddressFamilies=AF_UNIX',
                      'InaccessiblePaths=/run/docker.sock /var/run/docker.sock',
                      'TemporaryFileSystem=/run/credentials:ro /run/agentimpact-codex-worker:ro',
                      'BindReadOnlyPaths=/run/agentimpact-codex-worker/control.sock',
                      'BindPaths=/run/agentimpact-codex-worker/%i'):
            self.assertIn(value,self.unit)
        self.assertNotIn('User=root',self.unit)
        self.assertNotIn('SupplementaryGroups=docker',self.unit)

    def test_control_socket_has_one_systemd_owner_and_minimal_permissions(self):
        self.assertIn('ListenStream=/run/agentimpact-codex-worker/control.sock',self.socket)
        self.assertIn('SocketUser=agentimpact-codex-worker',self.socket)
        self.assertIn('SocketGroup=agentimpact-codex-worker',self.socket)
        self.assertIn('SocketMode=0600',self.socket)
        self.assertIn('RemoveOnStop=yes',self.socket)
        self.assertNotIn('WantedBy=',self.socket)
        for value in ('User=agentimpact-codex-worker','NoNewPrivileges=yes','RuntimeDirectory=agentimpact-codex-control',
                      'RuntimeDirectoryMode=0700','ProtectSystem=strict','ProtectHome=yes','CapabilityBoundingSet=',
                      'LoadCredential=database-url:','LoadCredential=attempt-hmac:'):
            self.assertIn(value,self.control)
        self.assertNotIn('User=root',self.control)

    def test_flags_are_off_and_no_autostart(self):
        for flag in ('AGENTIMPACT_V2_ENABLED=0','AGENTIMPACT_V2_EXECUTION_ENABLED=0',
                     'AGENTIMPACT_V2_CODEX_WORKER_ENABLED=0','AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED=0'):
            self.assertIn(flag,self.unit)
        self.assertNotIn('WantedBy=',self.unit)
        self.assertNotIn('enabled: true',self.play)
        self.assertIn('name: agentimpact-codex-control.socket',self.play)
        self.assertIn('name: agentimpact-codex-control.service',self.play)
        self.assertGreaterEqual(self.play.count('enabled: false'),2)

    def test_credentials_are_referenced_but_never_created(self):
        self.assertIn(
            'LoadCredential=control-hmac:/etc/agentimpact/credentials/'
            'codex-worker-control-hmac/%i', self.unit
        )
        self.assertNotIn('content: |',self.play)
        self.assertIn('UnsetEnvironment=SSH_AUTH_SOCK GITHUB_TOKEN GH_TOKEN',self.unit)
        self.assertNotIn('LoadCredential=github',self.unit.lower())
        self.assertNotIn('LoadCredential=github',self.control.lower())

    def test_control_daemon_is_deployed_and_rollback_stops_transport(self):
        self.assertIn('control-daemon.js',self.play)
        self.assertIn('codex-controller.js',self.play)
        self.assertNotIn('control-daemon-fixture.js',self.play)
        self.assertNotIn('codex-worker.test.js',self.play)
        self.assertIn('agentimpact-codex-control.service',self.play)
        self.assertIn('agentimpact-codex-control.socket',self.play)
        self.assertIn('agentimpact-codex-control.socket',self.rollback)
        self.assertIn('agentimpact-codex-control.service',self.rollback)

    def test_manual_auth_uses_only_the_dedicated_identity(self):
        auth_section = self.runbook.split(
            '## Authentification manuelle ultérieure', 1
        )[1].split('## Procédure de canari contrôlé', 1)[0]
        required = (
            '/usr/sbin/runuser --user agentimpact-codex-worker --',
            '/usr/bin/env -i',
            'HOME=/var/lib/agentimpact-codex-worker/home',
            'CODEX_HOME=/var/lib/agentimpact-codex-worker/codex-home',
            '/opt/agentimpact/codex/bin/codex login --device-auth',
            '/opt/agentimpact/codex/bin/codex login status',
            'CODEX_WORKER_READY_FOR_CONTROLLED_CANARY',
        )
        for value in required:
            self.assertIn(value, self.runbook)
        self.assertNotIn('/opt/agentimpact/codex/bin/codex exec', auth_section)
        self.assertNotIn('OPENAI_API_KEY=', auth_section)
        self.assertNotIn('CODEX_API_KEY=', auth_section)
        self.assertNotIn('cp ', auth_section)

if __name__=='__main__':
    unittest.main()
