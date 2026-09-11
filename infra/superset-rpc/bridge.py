#!/usr/bin/python3
"""Narrow local RPC bridge for Superset.  It never exposes a generic CLI."""
from __future__ import annotations

import argparse
import json
import os
import re
import socket
import struct
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol
from uuid import UUID


MAX_REQUEST_BYTES = 64 * 1024
MAX_RESULT_BYTES = 1024 * 1024
MAX_IDEMPOTENCY_RECORDS = 10_000
UUID_FIELDS = ("request_id", "mission_id", "attempt_id", "fencing_token")
OPERATIONS = frozenset({
    "health", "project.create", "project.list", "workspace.create", "workspace.list",
    "workspace.inspect", "workspace.delete", "terminal.create", "terminal.read",
    "terminal.send", "terminal.close", "agent.create", "agent.stop",
    "codex.rate_limits.read",
    "workspace.git_state", "workspace.diff",
})
MUTATIONS = frozenset({
    "project.create", "workspace.create", "workspace.delete", "terminal.create",
    "terminal.send", "terminal.close", "agent.create", "agent.stop",
})
# Fixed internal argv only — never a generic Codex CLI or caller-controlled path.
CODEX_RATE_LIMITS_INTERNAL_ARGV = ("__internal__", "codex.rate_limits.read")
INTERNAL_WORKSPACE_GIT_PREFIX = ("__internal__", "workspace.git")
CODEX_BIN = "/var/lib/agentimpact-superset/install/bin/codex"
CODEX_HOME = "/var/lib/agentimpact-superset/codex-home"
CODEX_RATE_LIMITS_TIMEOUT_SEC = 15
CODEX_QUOTA_FRESHNESS_SEC = 15 * 60
RATE_LIMIT_EXHAUSTED_PERCENT = 100
RATE_LIMIT_LIMITED_PERCENT = 85
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$")
BRANCH = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$")
SENSITIVE = re.compile(
    r"(?i)(super(set)?_api_key|bearer\s+[A-Za-z0-9._-]+|sk_(?:live|test)_[A-Za-z0-9_-]+|"
    r"access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?secret|authorization)"
)


class BridgeError(Exception):
    """A stable, secret-free public bridge error."""


@dataclass(frozen=True)
class RequestContext:
    uid: int
    gid: int
    pid: int


class Executor(Protocol):
    def run(self, argv: tuple[str, ...]) -> Any: ...


class FakeExecutor:
    """Test-only executor.  It intentionally contains no credential material."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, ...]] = []

    def run(self, argv: tuple[str, ...]) -> Any:
        self.calls.append(argv)
        return {"argv": list(argv), "status": "ok"}


class ForwardExecutor:
    """Forwards already-validated argv to the private executor over UDS."""

    def __init__(self, socket_path: str) -> None:
        self.socket_path = socket_path

    def run(self, argv: tuple[str, ...]) -> Any:
        payload = json.dumps({"argv": list(argv)}, separators=(",", ":")).encode("utf-8")
        if len(payload) > MAX_REQUEST_BYTES:
            raise BridgeError("private_executor_unavailable")
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(35)
                connection.connect(self.socket_path)
                connection.sendall(payload)
                connection.shutdown(socket.SHUT_WR)
                raw = _receive(connection, MAX_RESULT_BYTES)
        except (OSError, TimeoutError):
            raise BridgeError("private_executor_unavailable") from None
        try:
            response = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise BridgeError("private_executor_unavailable") from None
        if not isinstance(response, dict) or response.get("ok") is not True or set(response) != {"ok", "result"}:
            raise BridgeError("private_executor_unavailable")
        return response["result"]


def _iso_now(ts: float | None = None) -> str:
    import datetime as _dt
    return _dt.datetime.fromtimestamp(ts if ts is not None else __import__("time").time(), tz=_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _used_percent(window: Any) -> float | None:
    if not isinstance(window, dict):
        return None
    raw = window.get("usedPercent", window.get("used_percent"))
    if isinstance(raw, (int, float)) and raw == raw:
        return float(raw)
    if isinstance(raw, str) and raw.strip():
        try:
            return float(raw)
        except ValueError:
            return None
    return None


def _reset_at_ms(window: Any, now_ms: float) -> float | None:
    if not isinstance(window, dict):
        return None
    raw = window.get("resetsAt", window.get("reset_at", window.get("resets_at")))
    if not isinstance(raw, (int, float)):
        return None
    ms = float(raw) if raw > 1e12 else float(raw) * 1000.0
    return ms if ms > now_ms else None


def normalize_codex_rate_limits_payload(payload: Any, *, now_ms: float | None = None) -> dict[str, Any]:
    """Return normalized quota metadata only — never raw tokens/session material."""
    import time as _time
    now = now_ms if now_ms is not None else _time.time() * 1000.0
    observed_at = _iso_now(now / 1000.0)
    default_expiry = _iso_now((now / 1000.0) + CODEX_QUOTA_FRESHNESS_SEC)
    base = {
        "worker_type": "codex",
        "source": "provider_cli",
        "observed_at": observed_at,
        "expires_at": default_expiry,
        "used_percent_max": None,
    }
    if not isinstance(payload, dict):
        return {
            **base,
            "quota_state": "unknown",
            "reason": "rate_limits_payload_missing",
            "trustworthy": False,
            "discovery": "AMBIGUOUS",
            "auth_state": "unknown",
        }
    snapshot = payload.get("rateLimits", payload.get("rate_limits", payload))
    if not isinstance(snapshot, dict):
        return {
            **base,
            "quota_state": "unknown",
            "reason": "rate_limits_payload_missing",
            "trustworthy": False,
            "discovery": "AMBIGUOUS",
            "auth_state": "unknown",
        }
    reached = snapshot.get("rateLimitReachedType", snapshot.get("rate_limit_reached_type"))
    reached_s = ""
    if isinstance(reached, str):
        reached_s = reached.lower()
    elif isinstance(reached, dict) and isinstance(reached.get("type"), str):
        reached_s = reached["type"].lower()
    if reached_s and any(x in reached_s for x in ("exhausted", "usage_limit", "limit_reached", "quota", "allowance", "billing")):
        return {
            **base, "quota_state": "exhausted", "reason": "provider_rate_limit_reached",
            "trustworthy": True, "discovery": "PASS", "auth_state": "authenticated",
        }
    if reached_s:
        return {
            **base, "quota_state": "limited", "reason": "provider_rate_limit_flag",
            "trustworthy": True, "discovery": "PASS", "auth_state": "authenticated",
        }
    percents = [p for p in (_used_percent(snapshot.get("primary")), _used_percent(snapshot.get("secondary"))) if p is not None]
    if not percents:
        return {
            **base, "quota_state": "unknown", "reason": "rate_limits_windows_absent",
            "trustworthy": False, "discovery": "AMBIGUOUS", "auth_state": "authenticated",
        }
    max_used = max(percents)
    if max_used >= RATE_LIMIT_EXHAUSTED_PERCENT:
        state, reason = "exhausted", "provider_used_percent_exhausted"
    elif max_used >= RATE_LIMIT_LIMITED_PERCENT:
        state, reason = "limited", "provider_used_percent_limited"
    else:
        state, reason = "available", "provider_used_percent_ok"
    resets = [r for r in (_reset_at_ms(snapshot.get("primary"), now), _reset_at_ms(snapshot.get("secondary"), now)) if r is not None]
    expiry_ms = min([now + CODEX_QUOTA_FRESHNESS_SEC * 1000.0, *resets])
    return {
        **base,
        "quota_state": state,
        "reason": reason,
        "expires_at": _iso_now(expiry_ms / 1000.0),
        "trustworthy": True,
        "discovery": "PASS",
        "auth_state": "authenticated",
        "used_percent_max": max_used,
    }


def run_codex_rate_limits_read(
    *,
    codex_bin: str = CODEX_BIN,
    codex_home: str = CODEX_HOME,
    timeout_sec: float = CODEX_RATE_LIMITS_TIMEOUT_SEC,
) -> dict[str, Any]:
    """
    Private-executor-only: fixed Codex app-server metadata lifecycle.
    initialize → account/rateLimits/read → terminate. No prompt / no completion.
    Never prints auth.json or tokens. Never puts credentials on argv.
    """
    if "--api-key" in (codex_bin, codex_home) or not Path(codex_bin).is_file():
        return {
            "worker_type": "codex", "quota_state": "unknown", "source": "provider_cli",
            "reason": "codex_runtime_unavailable", "observed_at": _iso_now(),
            "expires_at": _iso_now(__import__("time").time() + CODEX_QUOTA_FRESHNESS_SEC),
            "trustworthy": False, "discovery": "UNAVAILABLE", "auth_state": "unknown",
            "used_percent_max": None,
        }
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": str(Path(codex_home).parent),
        "CODEX_HOME": codex_home,
        "CI": "1",
        "LANG": "C.UTF-8",
    }
    # Intentionally minimal env: auth is file-backed under CODEX_HOME only.
    # Never put API keys / tokens on argv or in this env map.
    child = None
    try:
        child = subprocess.Popen(
            [codex_bin, "app-server", "--stdio"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            env=env,
            cwd="/",
        )
        assert child.stdin is not None and child.stdout is not None
        child.stdin.write(json.dumps({
            "id": 1,
            "method": "initialize",
            "params": {"clientInfo": {"name": "agentimpact-superset-rpc", "title": "AgentImpact", "version": "1.2.0"}},
        }) + "\n")
        child.stdin.flush()

        def _readline() -> str:
            assert child is not None and child.stdout is not None
            line = child.stdout.readline()
            if not line:
                raise BridgeError("codex_app_server_closed")
            return line

        deadline = __import__("time").monotonic() + timeout_sec
        init_done = False
        result_payload: Any = None
        while __import__("time").monotonic() < deadline:
            remaining = max(0.1, deadline - __import__("time").monotonic())
            # Best-effort line read with process poll
            if child.poll() is not None and not init_done:
                raise BridgeError("codex_app_server_closed")
            child.stdout.flush()
            # Use select for bounded read when available
            import select
            ready, _, _ = select.select([child.stdout], [], [], min(1.0, remaining))
            if not ready:
                if child.poll() is not None:
                    break
                continue
            line = _readline().strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(msg, dict):
                continue
            if msg.get("id") == 1:
                if msg.get("error"):
                    err = msg["error"] if isinstance(msg["error"], dict) else {}
                    message = str(err.get("message", "initialize_failed")).lower()
                    auth = "unauthenticated" if any(x in message for x in ("auth", "login", "unauthorized")) else "unknown"
                    return {
                        "worker_type": "codex", "quota_state": "unknown", "source": "provider_cli",
                        "reason": "codex_auth_required_for_rate_limits" if auth == "unauthenticated" else "rate_limits_rpc_error",
                        "observed_at": _iso_now(), "expires_at": _iso_now(__import__("time").time() + CODEX_QUOTA_FRESHNESS_SEC),
                        "trustworthy": False,
                        "discovery": "AUTH_REQUIRED" if auth == "unauthenticated" else "ERROR",
                        "auth_state": auth, "used_percent_max": None,
                    }
                child.stdin.write(json.dumps({"method": "initialized", "params": {}}) + "\n")
                child.stdin.write(json.dumps({"id": 2, "method": "account/rateLimits/read", "params": {}}) + "\n")
                child.stdin.flush()
                init_done = True
                continue
            if msg.get("id") == 2:
                if msg.get("error"):
                    err = msg["error"] if isinstance(msg["error"], dict) else {}
                    message = str(err.get("message", "rate_limits_failed")).lower()
                    auth = "unauthenticated" if any(x in message for x in ("auth", "login", "unauthorized")) else "unknown"
                    return {
                        "worker_type": "codex", "quota_state": "unknown", "source": "provider_cli",
                        "reason": "codex_auth_required_for_rate_limits" if auth == "unauthenticated" else "rate_limits_rpc_error",
                        "observed_at": _iso_now(), "expires_at": _iso_now(__import__("time").time() + CODEX_QUOTA_FRESHNESS_SEC),
                        "trustworthy": False,
                        "discovery": "AUTH_REQUIRED" if auth == "unauthenticated" else "ERROR",
                        "auth_state": auth, "used_percent_max": None,
                    }
                result_payload = msg.get("result")
                break
        if result_payload is None:
            return {
                "worker_type": "codex", "quota_state": "unknown", "source": "provider_cli",
                "reason": "rate_limits_rpc_timeout", "observed_at": _iso_now(),
                "expires_at": _iso_now(__import__("time").time() + CODEX_QUOTA_FRESHNESS_SEC),
                "trustworthy": False, "discovery": "UNAVAILABLE", "auth_state": "unknown",
                "used_percent_max": None,
            }
        return normalize_codex_rate_limits_payload(result_payload)
    except (OSError, BridgeError):
        return {
            "worker_type": "codex", "quota_state": "unknown", "source": "provider_cli",
            "reason": "codex_app_server_unavailable", "observed_at": _iso_now(),
            "expires_at": _iso_now(__import__("time").time() + CODEX_QUOTA_FRESHNESS_SEC),
            "trustworthy": False, "discovery": "UNAVAILABLE", "auth_state": "unknown",
            "used_percent_max": None,
        }
    finally:
        if child is not None:
            try:
                if child.stdin:
                    child.stdin.close()
            except OSError:
                pass
            try:
                child.terminate()
                child.wait(timeout=2)
            except Exception:
                try:
                    child.kill()
                except Exception:
                    pass


class SupersetExecutor:
    def __init__(self, runner: str, env: dict[str, str] | None = None) -> None:
        self.runner = runner
        self.env = env or {}
        self.organization_id: str | None = None

    def _run(self, argv: tuple[str, ...], extra_env: dict[str, str]) -> Any:
        # The systemd-provided CREDENTIALS_DIRECTORY is inherited.  No secret is
        # read by Python or added to argv/logs; superset-cred-run consumes it.
        runtime_env = {**os.environ, "PATH": "/usr/local/bin:/usr/bin:/bin", "CI": "1", **self.env, **extra_env}
        runtime_env.pop("SUPERSET_API_KEY", None)
        try:
            completed = subprocess.run(
                [self.runner, *argv], shell=False, check=False, text=True,
                stdin=subprocess.DEVNULL, capture_output=True,
                timeout=30, env=runtime_env,
            )
        except (OSError, subprocess.TimeoutExpired):
            raise BridgeError("superset_unavailable") from None
        if completed.returncode != 0:
            raise BridgeError("superset_operation_failed")
        raw = completed.stdout
        if len(raw.encode("utf-8")) > MAX_RESULT_BYTES:
            raise BridgeError("superset_result_too_large")
        try:
            return json.loads(raw) if raw.strip() else {}
        except json.JSONDecodeError:
            raise BridgeError("superset_malformed_result") from None

    def run(self, argv: tuple[str, ...]) -> Any:
        if argv == CODEX_RATE_LIMITS_INTERNAL_ARGV:
            return run_codex_rate_limits_read()
        if argv[:2] == INTERNAL_WORKSPACE_GIT_PREFIX:
            return self._workspace_git(argv)
        if argv[0] != "status" and self.organization_id is None:
            self.organization_id = organization_from_status(self._run(("status", "--json"), {}))
        return self._run(argv, {} if self.organization_id is None else {"SUPERSET_ORGANIZATION_ID": self.organization_id})

    def _workspace_git(self, argv: tuple[str, ...]) -> Any:
        workspace_id = _uuid(argv[3], "workspace_id")
        if self.organization_id is None:
            self.organization_id = organization_from_status(self._run(("status", "--json"), {}))
        details = self._run(
            ("workspaces", "get", "--workspace", workspace_id, "--json"),
            {"SUPERSET_ORGANIZATION_ID": self.organization_id},
        )
        raw_path = details.get("worktreePath") if isinstance(details, dict) else None
        if not isinstance(raw_path, str):
            raise BridgeError("workspace_path_unavailable")
        worktree = Path(raw_path).resolve(strict=True)
        workspace_root = Path("/var/lib/agentimpact-superset").resolve(strict=True)
        if workspace_root not in worktree.parents or not worktree.is_dir():
            raise BridgeError("workspace_path_denied")

        def git(*args: str, limit: int = MAX_RESULT_BYTES) -> str:
            try:
                completed = subprocess.run(
                    ["/usr/bin/git", "-C", str(worktree), *args], shell=False,
                    check=False, text=True, stdin=subprocess.DEVNULL,
                    capture_output=True, timeout=20,
                )
            except (OSError, subprocess.TimeoutExpired):
                raise BridgeError("git_operation_failed") from None
            if completed.returncode != 0 or len(completed.stdout.encode("utf-8")) > limit:
                raise BridgeError("git_operation_failed")
            return completed.stdout

        if argv[2] == "state" and len(argv) == 4:
            head = git("rev-parse", "HEAD").strip()
            branch = git("rev-parse", "--abbrev-ref", "HEAD").strip()
            dirty = bool(git("status", "--porcelain").strip())
            if not re.fullmatch(r"[0-9a-f]{40}", head) or not BRANCH.fullmatch(branch):
                raise BridgeError("git_operation_failed")
            return {"branch": branch, "head_sha": head, "dirty": dirty}
        if argv[2] == "diff" and len(argv) == 5:
            base_sha = argv[4]
            if not re.fullmatch(r"[0-9a-f]{40}", base_sha):
                raise BridgeError("invalid_base_sha")
            patch = git("diff", "--no-ext-diff", "--binary", base_sha, "--", limit=900_000)
            names = git("diff", "--name-only", base_sha, "--")
            untracked = git("ls-files", "--others", "--exclude-standard")
            files = sorted(set(filter(None, (names + "\n" + untracked).splitlines())))
            return {"patch": patch, "files": files, "untracked_files": list(filter(None, untracked.splitlines()))}
        raise BridgeError("private_argv_denied")


def _uuid(value: object, label: str) -> str:
    if not isinstance(value, str):
        raise BridgeError(f"invalid_{label}")
    try:
        return str(UUID(value))
    except ValueError:
        raise BridgeError(f"invalid_{label}") from None


def organization_from_status(value: Any) -> str:
    if not isinstance(value, dict):
        raise BridgeError("superset_organization_unavailable")
    return _uuid(value.get("organizationId"), "organization_id")


def _text(value: object, label: str, pattern: re.Pattern[str], limit: int = 200) -> str:
    if not isinstance(value, str) or len(value) > limit or not pattern.fullmatch(value):
        raise BridgeError("invalid_parameters")
    return value


def _redact(value: Any) -> Any:
    if isinstance(value, str):
        return SENSITIVE.sub("[REDACTED]", value)
    if isinstance(value, list):
        return [_redact(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _redact(item) for key, item in value.items()}
    return value


def _private_source(value: str, source_roots: tuple[str, ...]) -> str:
    candidate = Path(value).resolve(strict=False)
    roots = tuple(Path(root).resolve() for root in source_roots)
    if not any(candidate == root or root in candidate.parents for root in roots):
        raise BridgeError("private_argv_denied")
    return str(candidate)


def validate_private_argv(argv: tuple[str, ...], source_roots: tuple[str, ...]) -> tuple[str, ...]:
    """Defence in depth: accept only argv shapes generated by Bridge._argv."""
    if not isinstance(argv, tuple) or not 1 <= len(argv) <= 16 or any(not isinstance(value, str) or len(value) > 4096 for value in argv):
        raise BridgeError("private_argv_denied")
    if any(value in {"--api-key", "--token", "--credential", "--shell", "-c"} for value in argv):
        raise BridgeError("private_argv_denied")
    if argv == CODEX_RATE_LIMITS_INTERNAL_ARGV:
        return argv
    if len(argv) == 4 and argv[:3] == (*INTERNAL_WORKSPACE_GIT_PREFIX, "state"):
        _uuid(argv[3], "workspace_id")
        return argv
    if len(argv) == 5 and argv[:3] == (*INTERNAL_WORKSPACE_GIT_PREFIX, "diff"):
        _uuid(argv[3], "workspace_id")
        if not re.fullmatch(r"[0-9a-f]{40}", argv[4]):
            raise BridgeError("private_argv_denied")
        return argv
    if argv in {("status", "--json"), ("projects", "list", "--local", "--json"), ("workspaces", "list", "--json")}:
        return argv
    if len(argv) == 6 and argv[:3] == ("projects", "create", "--name") and argv[-2:] == ("--local", "--json"):
        _text(argv[3], "name", NAME)
        return argv
    if len(argv) == 5 and argv[:3] == ("workspaces", "list", "--project") and argv[-1] == "--json":
        _uuid(argv[3], "project_id")
        return argv
    if len(argv) == 5 and argv[:3] == ("workspaces", "get", "--workspace") and argv[-1] == "--json":
        _uuid(argv[3], "workspace_id")
        return argv
    if len(argv) == 5 and argv[:3] == ("workspaces", "delete", "--local") and argv[-1] == "--json":
        _uuid(argv[3], "workspace_id")
        return argv
    if len(argv) == 12 and argv[:3] == ("workspaces", "create", "--project") and argv[4] == "--name" and argv[6] == "--branch" and argv[8] == "--source" and argv[-2:] == ("--local", "--json"):
        _uuid(argv[3], "project_id")
        _text(argv[5], "name", NAME)
        _text(argv[7], "branch", BRANCH)
        _private_source(argv[9], source_roots)
        return argv
    if len(argv) == 7 and argv[:3] == ("terminals", "create", "--workspace") and argv[4:6] == ("--command", "printf AGENTIMPACT_SUPERSET_RPC_SMOKE") and argv[-1] == "--json":
        _uuid(argv[3], "workspace_id")
        return argv
    if len(argv) == 7 and argv[0] == "terminals" and argv[1] in {"read", "close"} and argv[2] == "--workspace" and argv[4] == "--terminal" and argv[-1] == "--json":
        _uuid(argv[3], "workspace_id")
        _uuid(argv[5], "terminal_id")
        return argv
    if len(argv) == 10 and argv[:3] == ("terminals", "send", "--workspace") and argv[4] == "--terminal" and argv[6] == "--text" and argv[7] == "\\u0003" and argv[-1] == "--json":
        _uuid(argv[3], "workspace_id")
        _uuid(argv[5], "terminal_id")
        return argv
    if len(argv) == 9 and argv[:3] == ("agents", "create", "--workspace") and argv[4] == "--agent" and argv[6] == "--prompt" and argv[-1] == "--json":
        _uuid(argv[3], "workspace_id")
        if argv[5] not in ("codex", "cursor-agent"):
            raise BridgeError("private_argv_denied")
        prompt = argv[7]
        if not 1 <= len(prompt) <= 4096 or "\x00" in prompt:
            raise BridgeError("private_argv_denied")
        return argv
    if len(argv) == 5 and argv[:3] == ("agents", "stop", "--agent") and argv[-1] == "--json":
        _uuid(argv[3], "agent_id")
        return argv
    raise BridgeError("private_argv_denied")


class Bridge:
    def __init__(
        self, *, executor: Executor, state_path: Path, allowed_uids: set[int],
        agent_execution_enabled: bool, source_roots: tuple[str, ...],
    ) -> None:
        self.executor = executor
        self.state_path = state_path
        self.allowed_uids = allowed_uids
        self.agent_execution_enabled = agent_execution_enabled
        self.source_roots = tuple(Path(root).resolve() for root in source_roots)
        self._state = self._load_state()

    def _load_state(self) -> dict[str, dict[str, Any]]:
        if not self.state_path.exists():
            return {"requests": {}, "fences": {}}
        try:
            data = json.loads(self.state_path.read_text(encoding="utf-8"))
            if not isinstance(data, dict) or not isinstance(data.get("requests"), dict) or not isinstance(data.get("fences"), dict):
                raise ValueError
            return data
        except (OSError, ValueError, json.JSONDecodeError):
            raise BridgeError("bridge_state_invalid") from None

    def _save_state(self) -> None:
        self.state_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix="bridge-state-", dir=self.state_path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                os.fchmod(handle.fileno(), 0o600)
                json.dump(self._state, handle, sort_keys=True, separators=(",", ":"))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.state_path)
            os.chmod(self.state_path, 0o600)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def _validate(self, raw: object) -> tuple[dict[str, Any], str]:
        if not isinstance(raw, dict) or set(raw) != {"request_id", "operation", "mission_id", "attempt_id", "fencing_token", "parameters"}:
            raise BridgeError("invalid_request")
        request = dict(raw)
        for label in UUID_FIELDS:
            request[label] = _uuid(request[label], label)
        operation = request["operation"]
        if not isinstance(operation, str) or operation not in OPERATIONS:
            raise BridgeError("operation_denied")
        if not isinstance(request["parameters"], dict):
            raise BridgeError("invalid_parameters")
        parameters = request["parameters"]
        if any(key in parameters for key in ("argv", "command", "shell", "path", "flags", "environment")):
            raise BridgeError("invalid_parameters")
        return request, json.dumps(request, sort_keys=True, separators=(",", ":"))

    def _fence(self, request: dict[str, Any]) -> None:
        # Fence values are UUIDs.  The bridge stores the greatest observed token
        # per attempt and rejects a previously superseded token after restart.
        attempt, token = request["attempt_id"], request["fencing_token"]
        previous = self._state["fences"].get(attempt)
        if previous is not None and token < previous:
            raise BridgeError("stale_fencing_token")
        if previous is None or token > previous:
            self._state["fences"][attempt] = token

    def _source(self, value: object) -> str:
        if not isinstance(value, str) or len(value) > 500 or "\\x00" in value:
            raise BridgeError("invalid_source_path")
        candidate = Path(value).resolve(strict=False)
        if not any(candidate == root or root in candidate.parents for root in self.source_roots):
            raise BridgeError("invalid_source_path")
        return str(candidate)

    def _argv(self, request: dict[str, Any]) -> tuple[str, ...]:
        op, p = request["operation"], request["parameters"]
        if op == "health": return ("status", "--json")
        if op == "project.list": return ("projects", "list", "--local", "--json")
        if op == "project.create": return ("projects", "create", "--name", _text(p.get("name"), "name", NAME), "--local", "--json")
        if op == "workspace.list":
            project = p.get("project_id")
            return ("workspaces", "list", "--project", _uuid(project, "project_id"), "--json") if project is not None else ("workspaces", "list", "--json")
        if op == "workspace.inspect": return ("workspaces", "get", "--workspace", _uuid(p.get("workspace_id"), "workspace_id"), "--json")
        if op == "workspace.delete": return ("workspaces", "delete", "--local", _uuid(p.get("workspace_id"), "workspace_id"), "--json")
        if op == "workspace.create":
            return ("workspaces", "create", "--project", _uuid(p.get("project_id"), "project_id"), "--name", _text(p.get("name"), "name", NAME), "--branch", _text(p.get("branch"), "branch", BRANCH), "--source", self._source(p.get("source")), "--local", "--json")
        if op == "terminal.create":
            if set(p) != {"workspace_id", "profile"} or p.get("profile") != "smoke.echo": raise BridgeError("invalid_parameters")
            return ("terminals", "create", "--workspace", _uuid(p.get("workspace_id"), "workspace_id"), "--command", "printf AGENTIMPACT_SUPERSET_RPC_SMOKE", "--json")
        if op == "terminal.read": return ("terminals", "read", "--workspace", _uuid(p.get("workspace_id"), "workspace_id"), "--terminal", _uuid(p.get("terminal_id"), "terminal_id"), "--json")
        if op == "terminal.close": return ("terminals", "close", "--workspace", _uuid(p.get("workspace_id"), "workspace_id"), "--terminal", _uuid(p.get("terminal_id"), "terminal_id"), "--json")
        if op == "terminal.send":
            if set(p) != {"workspace_id", "terminal_id", "intent"} or p.get("intent") != "request_stop": raise BridgeError("invalid_parameters")
            return ("terminals", "send", "--workspace", _uuid(p.get("workspace_id"), "workspace_id"), "--terminal", _uuid(p.get("terminal_id"), "terminal_id"), "--text", "\\u0003", "--json")
        if op == "codex.rate_limits.read":
            if p:
                raise BridgeError("invalid_parameters")
            return CODEX_RATE_LIMITS_INTERNAL_ARGV
        if op == "workspace.git_state":
            if set(p) != {"workspace_id"}: raise BridgeError("invalid_parameters")
            return (*INTERNAL_WORKSPACE_GIT_PREFIX, "state", _uuid(p.get("workspace_id"), "workspace_id"))
        if op == "workspace.diff":
            if set(p) != {"workspace_id", "base_sha"}: raise BridgeError("invalid_parameters")
            base_sha = p.get("base_sha")
            if not isinstance(base_sha, str) or not re.fullmatch(r"[0-9a-f]{40}", base_sha): raise BridgeError("invalid_base_sha")
            return (*INTERNAL_WORKSPACE_GIT_PREFIX, "diff", _uuid(p.get("workspace_id"), "workspace_id"), base_sha)
        if op == "agent.create":
            agent = p.get("agent")
            if agent not in ("codex", "cursor-agent"): raise BridgeError("unsupported_agent")
            if not self.agent_execution_enabled: raise BridgeError("agent_execution_disabled")
            prompt = p.get("prompt")
            if not isinstance(prompt, str) or not 1 <= len(prompt) <= 4096: raise BridgeError("invalid_parameters")
            return ("agents", "create", "--workspace", _uuid(p.get("workspace_id"), "workspace_id"), "--agent", agent, "--prompt", prompt, "--json")
        if op == "agent.stop":
            if not self.agent_execution_enabled: raise BridgeError("agent_execution_disabled")
            return ("agents", "stop", "--agent", _uuid(p.get("agent_id"), "agent_id"), "--json")
        raise BridgeError("operation_denied")

    def handle(self, raw: object, caller: RequestContext) -> dict[str, Any]:
        if caller.uid not in self.allowed_uids:
            raise BridgeError("caller_not_authorized")
        request, canonical = self._validate(raw)
        known = self._state["requests"].get(request["request_id"])
        if known is not None:
            if known["request"] != canonical: raise BridgeError("request_id_conflict")
            if known.get("status") == "pending" or "response" not in known:
                raise BridgeError("request_outcome_unknown")
            return known["response"]
        argv = self._argv(request)
        if request["operation"] in MUTATIONS:
            self._fence(request)
            if len(self._state["requests"]) >= MAX_IDEMPOTENCY_RECORDS:
                raise BridgeError("idempotency_state_full")
            # Reserve the one-shot request before crossing the private
            # executor boundary. A crash after the side effect becomes an
            # explicit unknown outcome and can never launch a duplicate.
            self._state["requests"][request["request_id"]] = {
                "request": canonical, "status": "pending",
            }
            self._save_state()
        response = {"ok": True, "result": _redact(self.executor.run(argv))}
        if request["operation"] in MUTATIONS:
            self._state["requests"][request["request_id"]] = {
                "request": canonical, "status": "completed", "response": response,
            }
            self._save_state()
        return response


def peer_context(connection: socket.socket) -> RequestContext:
    raw = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    pid, uid, gid = struct.unpack("3i", raw)
    return RequestContext(uid=uid, gid=gid, pid=pid)


def _receive(connection: socket.socket, maximum: int) -> bytes:
    chunks: list[bytes] = []
    size = 0
    while True:
        chunk = connection.recv(min(16_384, maximum + 1 - size))
        if not chunk:
            break
        chunks.append(chunk)
        size += len(chunk)
        if size > maximum:
            raise BridgeError("request_too_large")
    if not chunks:
        raise BridgeError("request_too_large")
    return b"".join(chunks)


def _drain(connection: socket.socket) -> None:
    """Consume unread bytes so a peer-denied close does not RST the client."""
    connection.settimeout(0.25)
    try:
        while True:
            chunk = connection.recv(16_384)
            if not chunk:
                break
    except (OSError, TimeoutError):
        return


def _send_response(connection: socket.socket, response: dict[str, Any]) -> None:
    try:
        connection.sendall(json.dumps(response, separators=(",", ":")).encode("utf-8"))
    except OSError:
        return


def serve(listener: socket.socket, bridge: Bridge) -> None:
    while True:
        connection, _ = listener.accept()
        with connection:
            try:
                payload = _receive(connection, MAX_REQUEST_BYTES)
                response = bridge.handle(json.loads(payload.decode("utf-8")), peer_context(connection))
            except (BridgeError, UnicodeDecodeError, json.JSONDecodeError):
                response = {"ok": False, "error": "request_rejected"}
            _send_response(connection, response)


def serve_private(listener: socket.socket, executor: Executor, allowed_uid: int, source_roots: tuple[str, ...]) -> None:
    """Serve a strictly typed, peer-authenticated executor protocol."""
    while True:
        connection, _ = listener.accept()
        with connection:
            response: dict[str, Any] = {"ok": False, "error": "request_rejected"}
            try:
                # Peer auth first; never treat root (or any other UID) as allowed.
                if peer_context(connection).uid != allowed_uid:
                    _drain(connection)
                    raise BridgeError("private_peer_denied")
                raw = json.loads(_receive(connection, MAX_REQUEST_BYTES).decode("utf-8"))
                if not isinstance(raw, dict) or set(raw) != {"argv"} or not isinstance(raw["argv"], list):
                    raise BridgeError("private_argv_denied")
                argv = validate_private_argv(tuple(raw["argv"]), source_roots)
                response = {"ok": True, "result": _redact(executor.run(argv))}
            except (BridgeError, UnicodeDecodeError, json.JSONDecodeError):
                response = {"ok": False, "error": "request_rejected"}
            _send_response(connection, response)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--role", choices=("public", "private"), required=True)
    parser.add_argument("--state", default="/var/lib/agentimpact-superset-rpc/bridge-state.json")
    parser.add_argument("--upstream-socket", default="/run/agentimpact-superset-rpc/executor.sock")
    args = parser.parse_args()
    fd = 3 if os.environ.get("LISTEN_FDS") == "1" else None
    if fd is None: raise SystemExit("socket_activation_required")
    listener = socket.socket(fileno=fd)
    source_roots = ("/var/lib/agentimpact-superset/fixtures",)
    if args.role == "public":
        try:
            client_uid = int(os.environ["SUPERSET_RPC_CLIENT_UID"])
            if client_uid <= 0:
                raise ValueError
        except (KeyError, ValueError):
            raise SystemExit("public_client_uid_required") from None
        agent_execution_enabled = os.environ.get("AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED", "0").strip() == "1"
        bridge = Bridge(
            executor=ForwardExecutor(args.upstream_socket), state_path=Path(args.state), allowed_uids={client_uid},
            agent_execution_enabled=agent_execution_enabled, source_roots=source_roots,
        )
        serve(listener, bridge)
        return
    try:
        allowed_uid = int(os.environ["SUPERSET_RPC_PUBLIC_UID"])
    except (KeyError, ValueError):
        raise SystemExit("private_peer_uid_required") from None
    serve_private(
        listener, SupersetExecutor("/var/lib/agentimpact-superset/install/bin/superset-cred-run"),
        allowed_uid, source_roots,
    )


if __name__ == "__main__": main()
