"""Static deployment guardrails for the Superset RPC bridge."""
from pathlib import Path
import unittest


ROOT=Path(__file__).resolve().parents[2]


class SupersetRpcBridgeDeploymentTest(unittest.TestCase):
    def test_socket_is_local_and_group_restricted(self):
        source=(ROOT/'infra/systemd/agentimpact-superset-rpc.socket').read_text()
        self.assertIn('ListenStream=/run/agentimpact-superset-rpc/bridge.sock',source)
        self.assertIn('SocketMode=0660',source)
        self.assertIn('SocketGroup=agentimpact-superset-rpc-client',source)
        self.assertIn('DirectoryMode=0711',source)
        self.assertNotIn('ListenStream=0.0.0.0',source)

    def test_private_socket_is_not_a_public_or_docker_endpoint(self):
        source=(ROOT/'infra/systemd/agentimpact-superset-private.socket').read_text()
        self.assertIn('ListenStream=/run/agentimpact-superset-rpc/executor.sock',source)
        self.assertIn('SocketUser=agentimpact-superset-rpc',source)
        self.assertIn('SocketGroup=agentimpact-superset',source)
        self.assertIn('SocketMode=0660',source)
        self.assertIn('DirectoryMode=0711',source)
        self.assertNotIn('ListenStream=0.0.0.0',source)

    def test_compose_mounts_only_the_public_socket(self):
        source=(ROOT/'infra/compose.yml').read_text()
        self.assertIn('/run/agentimpact-superset-rpc/bridge.sock',source)
        self.assertNotIn('executor.sock',source)
        self.assertIn('AGENTIMPACT_SUPERSET_RPC_SOCKET: /run/agentimpact-superset-rpc/bridge.sock',source)
        self.assertIn('AGENTIMPACT_V2_EXECUTION_ENABLED: "0"',source)
        self.assertIn('AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: "0"',source)
        self.assertNotIn('/etc/credstore',source)
        self.assertNotIn('docker.sock',source)

    def test_public_service_is_unprivileged_and_has_no_credential_or_docker_access(self):
        source=(ROOT/'infra/systemd/agentimpact-superset-rpc.service').read_text()
        self.assertIn('User=agentimpact-superset-rpc',source)
        self.assertIn('NoNewPrivileges=yes',source)
        self.assertIn('ProtectSystem=strict',source)
        self.assertIn('/run/docker.sock',source)
        self.assertIn('/var/lib/agentimpact-superset',source)
        self.assertIn('AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED=0',source)
        self.assertIn('SUPERSET_RPC_CLIENT_UID=1000',source)
        self.assertNotIn('Environment=SUPERSET_API_KEY=',source)
        self.assertNotIn('LoadCredential=',source)

    def test_private_service_is_the_only_credential_holder(self):
        source=(ROOT/'infra/systemd/agentimpact-superset-private.service').read_text()
        self.assertIn('User=agentimpact-superset',source)
        self.assertIn('LoadCredential=superset_api_key:',source)
        self.assertIn('EnvironmentFile=/etc/agentimpact/superset-rpc-private.env',source)
        self.assertIn('AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED=0',source)
        self.assertIn('RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',source)
        self.assertNotIn('IPAddressDeny=',source)
        self.assertNotIn('User=root',source)

    def test_quota_discovery_uses_typed_rpc_and_scoped_userns(self):
        script=(ROOT/'src/scripts/jarvis-codex-ratelimit-discover.ts').read_text()
        profile=(ROOT/'infra/apparmor/agentimpact-codex').read_text()
        self.assertIn('queryCodexRateLimitsViaSupersetRpc',script)
        self.assertNotIn('queryCodexAppServerRateLimits()',script)
        self.assertIn('profile agentimpact-codex',profile)
        self.assertIn('userns,',profile)
        self.assertNotIn('kernel.apparmor_restrict_unprivileged_userns=0',profile)

    def test_deployment_has_no_acl_bridge_to_private_superset_state(self):
        source=(ROOT/'infra/ansible/playbooks/superset-rpc-bridge.yml').read_text()
        self.assertIn('bridge_must_not_read_private_manifest',source)
        self.assertNotIn('setfacl',source)
        self.assertNotIn('notify:',source)
        self.assertIn('Ensure the shared socket directory is traversable but not listable',source)
        self.assertIn('bridge_must_not_share_superset_runtime_home',source)
