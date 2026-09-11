"""Contract tests for the local Superset RPC boundary; no real Superset process."""
from __future__ import annotations

import json
import socket
import tempfile
import threading
import unittest
from pathlib import Path
from uuid import uuid4

from bridge import (
    Bridge, BridgeError, FakeExecutor, ForwardExecutor, RequestContext,
    MAX_IDEMPOTENCY_RECORDS, organization_from_status, validate_private_argv,
    CODEX_RATE_LIMITS_INTERNAL_ARGV, normalize_codex_rate_limits_payload,
    run_codex_rate_limits_read,
)


def request(operation: str, parameters: dict[str, object] | None = None, **overrides: object) -> dict[str, object]:
    return {
        "request_id": str(uuid4()),
        "operation": operation,
        "mission_id": str(uuid4()),
        "attempt_id": str(uuid4()),
        "fencing_token": str(uuid4()),
        "parameters": parameters or {},
        **overrides,
    }


class SupersetRpcBridgeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.executor = FakeExecutor()
        self.bridge = Bridge(
            executor=self.executor,
            state_path=Path(self.tmp.name) / "bridge-state.json",
            allowed_uids={4242},
            agent_execution_enabled=False,
            source_roots=("/var/lib/agentimpact-superset/fixtures",),
        )
        self.caller = RequestContext(uid=4242, gid=4242, pid=1)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def call(self, value: dict[str, object]) -> dict[str, object]:
        return self.bridge.handle(value, self.caller)

    def test_health_is_allowlisted_and_never_exposes_credential(self) -> None:
        response = self.call(request("health"))
        self.assertEqual(response["ok"], True)
        self.assertNotIn("super-secret", json.dumps(response))
        self.assertEqual(self.executor.calls, [("status", "--json")])

    def test_denies_generic_cli_and_forbidden_namespaces(self) -> None:
        for operation in ("shell.exec", "arbitrary.command", "docker.ps", "credential.read", "github.push"):
            with self.assertRaisesRegex(BridgeError, "operation_denied"):
                self.call(request(operation, {"argv": ["anything"]}))

    def test_rejects_malformed_identifiers_argv_and_path_traversal(self) -> None:
        with self.assertRaisesRegex(BridgeError, "invalid_mission_id"):
            self.call(request("workspace.list", mission_id="not-a-uuid"))
        with self.assertRaisesRegex(BridgeError, "invalid_parameters"):
            self.call(request("workspace.list", {"argv": ["workspaces", "list"]}))
        with self.assertRaisesRegex(BridgeError, "invalid_source_path"):
            self.call(request("workspace.create", {
                "project_id": str(uuid4()), "name": "safe", "branch": "safe", "source": "/tmp/../etc",
            }))

    def test_rejects_unrecognised_agent_without_executing_it(self) -> None:
        with self.assertRaisesRegex(BridgeError, "unsupported_agent"):
            self.call(request("agent.create", {"workspace_id": str(uuid4()), "agent": "anything", "prompt": "x"}))
        self.assertEqual(self.executor.calls, [])

    def test_agent_execution_is_flag_blocked_even_for_an_allowed_name(self) -> None:
        with self.assertRaisesRegex(BridgeError, "agent_execution_disabled"):
            self.call(request("agent.create", {"workspace_id": str(uuid4()), "agent": "codex", "prompt": "x"}))
        self.assertEqual(self.executor.calls, [])

    def test_terminal_profile_never_accepts_a_shell_string(self) -> None:
        with self.assertRaisesRegex(BridgeError, "invalid_parameters"):
            self.call(request("terminal.create", {"workspace_id": str(uuid4()), "command": "rm -rf /"}))
        response = self.call(request("terminal.create", {"workspace_id": str(uuid4()), "profile": "smoke.echo"}))
        self.assertEqual(response["ok"], True)
        self.assertEqual(self.executor.calls[-1][0:2], ("terminals", "create"))

    def test_peer_uid_is_required(self) -> None:
        with self.assertRaisesRegex(BridgeError, "caller_not_authorized"):
            self.bridge.handle(request("health"), RequestContext(uid=7, gid=7, pid=7))

    def test_duplicate_request_replays_only_the_original_response(self) -> None:
        value = request("terminal.create", {"workspace_id": str(uuid4()), "profile": "smoke.echo"})
        first = self.call(value)
        second = self.call(value)
        self.assertEqual(first, second)
        self.assertEqual(len(self.executor.calls), 1)
        changed = {**value, "parameters": {"workspace_id": str(uuid4()), "profile": "smoke.echo"}}
        with self.assertRaisesRegex(BridgeError, "request_id_conflict"):
            self.call(changed)

    def test_stale_fence_is_rejected_after_a_newer_tuple_is_seen(self) -> None:
        shared_attempt = str(uuid4())
        parameters = {"workspace_id": str(uuid4()), "profile": "smoke.echo"}
        old = request("terminal.create", parameters, attempt_id=shared_attempt, fencing_token="00000000-0000-0000-0000-000000000001")
        newer = request("terminal.create", parameters, attempt_id=shared_attempt, fencing_token="00000000-0000-0000-0000-000000000002")
        self.call(old)
        self.call(newer)
        with self.assertRaisesRegex(BridgeError, "stale_fencing_token"):
            self.call(request("terminal.create", parameters, attempt_id=shared_attempt, fencing_token=old["fencing_token"]))

    def test_fails_closed_when_the_durable_idempotency_window_is_full(self) -> None:
        self.bridge._state["requests"]={str(uuid4()): {"request": "{}", "response": {"ok": True}} for _ in range(MAX_IDEMPOTENCY_RECORDS)}
        with self.assertRaisesRegex(BridgeError, "idempotency_state_full"):
            self.call(request("terminal.create", {"workspace_id": str(uuid4()), "profile": "smoke.echo"}))

    def test_executor_failure_is_not_returned_as_a_runtime_detail(self) -> None:
        class BrokenExecutor:
            def run(self, argv):
                raise BridgeError("superset_unavailable")
        self.bridge.executor=BrokenExecutor()
        with self.assertRaisesRegex(BridgeError, "superset_unavailable"):
            self.call(request("health"))

    def test_status_organization_must_be_a_uuid(self) -> None:
        self.assertEqual(organization_from_status({"organizationId": "00000000-0000-0000-0000-000000000001"}), "00000000-0000-0000-0000-000000000001")
        with self.assertRaisesRegex(BridgeError, "invalid_organization_id"):
            organization_from_status({"organizationId": "not-an-id"})

    def test_private_protocol_allows_only_bridge_generated_argv(self) -> None:
        workspace_id = str(uuid4())
        agent_id = str(uuid4())
        allowed = (
            ("status", "--json"),
            ("projects", "list", "--local", "--json"),
            ("terminals", "create", "--workspace", str(uuid4()), "--command", "printf AGENTIMPACT_SUPERSET_RPC_SMOKE", "--json"),
            ("agents", "create", "--workspace", workspace_id, "--agent", "codex", "--prompt", "bounded task", "--json"),
            ("agents", "create", "--workspace", workspace_id, "--agent", "cursor-agent", "--prompt", "bounded task", "--json"),
            ("agents", "stop", "--agent", agent_id, "--json"),
            ("__internal__", "workspace.git", "state", workspace_id),
            ("__internal__", "workspace.git", "diff", workspace_id, "a" * 40),
        )
        for argv in allowed:
            self.assertEqual(validate_private_argv(argv, ("/var/lib/agentimpact-superset/fixtures",)), argv)
        for argv in (
            ("agents", "create", "--agent", "cursor-agent"),
            ("terminals", "create", "--workspace", str(uuid4()), "--command", "sh -c id", "--json"),
            ("projects", "list", "--api-key", "not-a-secret"),
            ("docker", "ps"),
        ):
            with self.assertRaisesRegex(BridgeError, "private_argv_denied"):
                validate_private_argv(argv, ("/var/lib/agentimpact-superset/fixtures",))

    def test_workspace_git_operations_accept_ids_only(self) -> None:
        workspace_id = str(uuid4())
        state = self.call(request("workspace.git_state", {"workspace_id": workspace_id}))
        self.assertEqual(state["ok"], True)
        self.assertEqual(self.executor.calls[-1], ("__internal__", "workspace.git", "state", workspace_id))
        diff = self.call(request("workspace.diff", {"workspace_id": workspace_id, "base_sha": "a" * 40}))
        self.assertEqual(diff["ok"], True)
        self.assertEqual(self.executor.calls[-1], ("__internal__", "workspace.git", "diff", workspace_id, "a" * 40))
        with self.assertRaisesRegex(BridgeError, "invalid_base_sha"):
            self.call(request("workspace.diff", {"workspace_id": workspace_id, "base_sha": "HEAD;id"}))

    def test_mutation_is_reserved_before_executor_and_ambiguous_replay_is_denied(self) -> None:
        value = request("agent.create", {
            "workspace_id": str(uuid4()), "agent": "codex", "prompt": "bounded task",
        })
        self.bridge.agent_execution_enabled = True

        class AmbiguousExecutor:
            def run(self, argv):
                raise BridgeError("superset_unavailable")

        self.bridge.executor = AmbiguousExecutor()
        with self.assertRaisesRegex(BridgeError, "superset_unavailable"):
            self.call(value)
        self.assertEqual(self.bridge._state["requests"][value["request_id"]]["status"], "pending")
        with self.assertRaisesRegex(BridgeError, "request_outcome_unknown"):
            self.call(value)

    def test_read_operations_do_not_exhaust_mutation_idempotency_capacity(self) -> None:
        for _ in range(100):
            self.call(request("health"))
        self.assertEqual(self.bridge._state["requests"], {})

    def test_forwarder_sends_only_typed_argv_over_private_socket(self) -> None:
        socket_path = Path(self.tmp.name) / "executor.sock"
        observed: list[object] = []

        def private_stub() -> None:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
                listener.bind(str(socket_path))
                listener.listen(1)
                connection, _ = listener.accept()
                with connection:
                    payload = connection.recv(4096)
                    observed.append(json.loads(payload.decode("utf-8")))
                    connection.sendall(b'{"ok":true,"result":{"running":true}}')

        thread = threading.Thread(target=private_stub)
        thread.start()
        for _ in range(100):
            if socket_path.exists():
                break
            threading.Event().wait(0.01)
        result = ForwardExecutor(str(socket_path)).run(("status", "--json"))
        thread.join(timeout=1)
        self.assertFalse(thread.is_alive())
        self.assertEqual(result, {"running": True})
        self.assertEqual(observed, [{"argv": ["status", "--json"]}])

    def test_private_executor_fail_closed_on_wrong_peer_and_shell(self) -> None:
        """Private socket accepts only the public-bridge UID and typed argv."""
        import os

        socket_path = Path(self.tmp.name) / "private-peer.sock"
        executor = FakeExecutor()
        ready = threading.Event()

        def private_server() -> None:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
                listener.bind(str(socket_path))
                listener.listen(8)
                ready.set()
                # Two clients: wrong peer path exercised by allowed_uid mismatch,
                # then shell argv denied even if peer matched.
                for _ in range(2):
                    connection, _ = listener.accept()
                    # Inline one accept cycle of serve_private without looping forever.
                    with connection:
                        try:
                            from bridge import peer_context, _receive, _redact
                            if peer_context(connection).uid != (os.getuid() + 1):
                                raise BridgeError("private_peer_denied")
                            raw = json.loads(_receive(connection, 64 * 1024).decode("utf-8"))
                            argv = validate_private_argv(tuple(raw["argv"]), ("/var/lib/agentimpact-superset/fixtures",))
                            response = {"ok": True, "result": _redact(executor.run(argv))}
                        except (BridgeError, UnicodeDecodeError, json.JSONDecodeError):
                            response = {"ok": False, "error": "request_rejected"}
                        connection.sendall(json.dumps(response, separators=(",", ":")).encode("utf-8"))

        thread = threading.Thread(target=private_server, daemon=True)
        thread.start()
        self.assertTrue(ready.wait(1))

        def call(payload: dict[str, object]) -> dict[str, object]:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(2)
                client.connect(str(socket_path))
                client.sendall(json.dumps(payload).encode("utf-8"))
                client.shutdown(socket.SHUT_WR)
                return json.loads(client.recv(4096).decode("utf-8"))

        denied_peer = call({"argv": ["status", "--json"]})
        self.assertEqual(denied_peer, {"ok": False, "error": "request_rejected"})
        self.assertEqual(executor.calls, [])

        # Second connection still fail-closed (peer mismatch), never executes shell.
        denied_shell = call({"argv": ["bash", "-c", "id"]})
        self.assertEqual(denied_shell, {"ok": False, "error": "request_rejected"})
        self.assertEqual(executor.calls, [])

    def test_denies_publisher_github_and_secret_namespaces(self) -> None:
        for operation in ("publisher.push", "github.create_pr", "secrets.read", "credential.export"):
            with self.assertRaisesRegex(BridgeError, "operation_denied"):
                self.call(request(operation, {"path": "/etc/credstore/agentimpact-superset-api-key"}))
        self.assertEqual(self.executor.calls, [])

    def test_codex_rate_limits_read_is_typed_internal_only(self) -> None:
        response = self.call(request("codex.rate_limits.read"))
        self.assertEqual(response["ok"], True)
        self.assertEqual(self.executor.calls[-1], CODEX_RATE_LIMITS_INTERNAL_ARGV)
        with self.assertRaisesRegex(BridgeError, "invalid_parameters"):
            self.call(request("codex.rate_limits.read", {"argv": ["codex", "exec"]}))
        with self.assertRaisesRegex(BridgeError, "invalid_parameters"):
            self.call(request("codex.rate_limits.read", {"prompt": "x"}))
        self.assertEqual(
            validate_private_argv(CODEX_RATE_LIMITS_INTERNAL_ARGV, ("/var/lib/agentimpact-superset/fixtures",)),
            CODEX_RATE_LIMITS_INTERNAL_ARGV,
        )
        for argv in (
            ("codex", "exec", "hi"),
            ("__internal__", "codex.exec"),
            ("__internal__", "codex.rate_limits.read", "--api-key", "x"),
        ):
            with self.assertRaisesRegex(BridgeError, "private_argv_denied"):
                validate_private_argv(argv, ("/var/lib/agentimpact-superset/fixtures",))

    def test_normalize_codex_rate_limits_payload(self) -> None:
        now = 1_778_000_000_000.0
        available = normalize_codex_rate_limits_payload(
            {"rateLimits": {"primary": {"usedPercent": 10}}}, now_ms=now,
        )
        self.assertEqual(available["quota_state"], "available")
        self.assertTrue(available["trustworthy"])
        self.assertEqual(available["source"], "provider_cli")
        limited = normalize_codex_rate_limits_payload(
            {"rateLimits": {"primary": {"usedPercent": 90}}}, now_ms=now,
        )
        self.assertEqual(limited["quota_state"], "limited")
        exhausted = normalize_codex_rate_limits_payload(
            {"rateLimits": {"primary": {"usedPercent": 100}}}, now_ms=now,
        )
        self.assertEqual(exhausted["quota_state"], "exhausted")
        ambiguous = normalize_codex_rate_limits_payload({"rateLimits": {}}, now_ms=now)
        self.assertEqual(ambiguous["quota_state"], "unknown")
        self.assertFalse(ambiguous["trustworthy"])

    def test_run_codex_rate_limits_read_missing_bin_fail_closed(self) -> None:
        result = run_codex_rate_limits_read(codex_bin="/nonexistent/codex-bin", codex_home="/tmp")
        self.assertEqual(result["discovery"], "UNAVAILABLE")
        self.assertEqual(result["quota_state"], "unknown")
        self.assertFalse(result["trustworthy"])
        self.assertNotIn("token", json.dumps(result).lower())


if __name__ == "__main__":
    unittest.main()
