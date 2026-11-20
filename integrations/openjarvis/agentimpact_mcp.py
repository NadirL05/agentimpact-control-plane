#!/usr/bin/env python3
"""OpenJarvis stdio MCP adapter for the bounded AgentImpact operator API.

No shell, argv, filesystem path, database, provider, GitHub or Superset
credential is accepted as a tool argument. The only secret is read locally
from a mode-0600 token file and used to authenticate fixed HTTPS/WireGuard API
requests.
"""
from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import os
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PROTOCOL_VERSION = "2025-03-26"
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
CONFIRMATION_TTL_SECONDS = 120

UUID = {"type": "string", "format": "uuid"}
PROJECT = {"type": "string", "pattern": "^[A-Z][A-Z0-9_-]{0,63}$"}
SHA = {"type": "string", "pattern": "^[0-9a-f]{40}$"}
HASH = {"type": "string", "pattern": "^[0-9a-f]{64}$"}
REASON = {"type": "string", "minLength": 3, "maxLength": 2000}


def obj(properties: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {"type": "object", "properties": properties, "required": required or [], "additionalProperties": False}


TOOLS: dict[str, dict[str, Any]] = {
    "agentimpact.status": obj({"project": PROJECT}),
    "agentimpact.health": obj({}),
    "agentimpact.missions.list": obj({"project": PROJECT, "limit": {"type": "integer", "minimum": 1, "maximum": 100}}),
    "agentimpact.missions.inspect": obj({"mission_id": UUID}, ["mission_id"]),
    "agentimpact.missions.create": obj({"project": PROJECT, "title": {"type": "string", "minLength": 3, "maxLength": 200}, "objective": {"type": "string", "minLength": 3, "maxLength": 8000}, "requested_worker_type": {"enum": ["codex", "cursor"]}, "reason": REASON}, ["project", "title", "objective", "requested_worker_type", "reason"]),
    "agentimpact.missions.cancel": obj({"mission_id": UUID, "reason": REASON}, ["mission_id", "reason"]),
    "agentimpact.missions.events": obj({"mission_id": UUID, "after": {"type": "string", "pattern": "^\\d{1,18}$"}}, ["mission_id"]),
    "agentimpact.agent.status": obj({"mission_id": UUID}, ["mission_id"]),
    "agentimpact.agent.start": obj({"mission_id": UUID, "attempt_id": UUID, "requested_worker_type": {"enum": ["codex", "cursor"]}, "reason": REASON, "fencing_token": {"type": "string", "pattern": "^[1-9]\\d{0,18}$"}, "workspace_id": UUID, "approval_id": UUID, "budget_ceiling": {"type": "integer", "minimum": 1, "maximum": 1000000}}, ["mission_id", "attempt_id", "requested_worker_type", "reason", "fencing_token", "workspace_id", "budget_ceiling"]),
    "agentimpact.agent.stop": obj({"mission_id": UUID, "attempt_id": UUID, "reason": REASON}, ["mission_id", "attempt_id", "reason"]),
    "agentimpact.workspace.inspect": obj({"mission_id": UUID}, ["mission_id"]),
    "agentimpact.tests.run": obj({"mission_id": UUID, "attempt_id": UUID, "test_profile": {"enum": ["unit", "integration", "lint", "typecheck", "mission_validation"]}}, ["mission_id", "attempt_id", "test_profile"]),
    "agentimpact.tests.status": obj({"mission_id": UUID}, ["mission_id"]),
    "agentimpact.diff.read": obj({"mission_id": UUID}, ["mission_id"]),
    "agentimpact.approvals.list": obj({"limit": {"type": "integer", "minimum": 1, "maximum": 100}}),
    "agentimpact.approvals.inspect": obj({"action_id": UUID}, ["action_id"]),
    "agentimpact.approvals.approve": obj({"action_id": UUID, "payload_hash": HASH, "decision": {"enum": ["approved", "rejected"]}, "reason": REASON}, ["action_id", "payload_hash", "decision"]),
    "agentimpact.publisher.prepare": obj({"mission_id": UUID, "attempt_id": UUID, "repository": {"type": "string", "pattern": "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"}, "head_sha": SHA, "base_branch": {"enum": ["main", "master", "staging"], "default": "main"}}, ["mission_id", "attempt_id", "repository", "head_sha"]),
    "agentimpact.publisher.publish": obj({"action_id": UUID, "payload_hash": HASH}, ["action_id", "payload_hash"]),
    "agentimpact.deploy.prepare": obj({"release_id": {"type": "string", "pattern": "^\\d{8}T\\d{6}Z-[0-9a-f]{12}$"}, "source_commit": SHA, "target": {"enum": ["staging", "production"]}, "rollback_release_id": {"type": "string", "pattern": "^\\d{8}T\\d{6}Z-[0-9a-f]{12}$"}, "publisher_action_id": UUID, "repository": {"type": "string", "pattern": "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"}, "base_branch": {"enum": ["main", "master", "staging"]}}, ["release_id", "source_commit", "target", "rollback_release_id", "publisher_action_id", "repository", "base_branch"]),
    "agentimpact.deploy.execute": obj({"action_id": UUID, "payload_hash": HASH}, ["action_id", "payload_hash"]),
}

# Human approval is deliberately not model-callable. It remains a typed server
# operation for the separately authenticated admin channel.
HUMAN_ONLY_TOOLS = {"agentimpact.approvals.approve"}
MODEL_TOOLS = {name: schema for name, schema in TOOLS.items() if name not in HUMAN_ONLY_TOOLS}
CONFIRMATION_REQUIRED = {
    "agentimpact.missions.cancel",
    "agentimpact.agent.start",
    "agentimpact.agent.stop",
    "agentimpact.tests.run",
    "agentimpact.publisher.publish",
    "agentimpact.deploy.execute",
}

DESCRIPTIONS = {
    "agentimpact.status": "Vue consolidee des missions, tentatives, quota, budget, approbations, Superset, Publisher et deploy.",
    "agentimpact.health": "Sante du Control Plane, de PostgreSQL et du pont Superset.",
    "agentimpact.missions.list": "Liste bornee des missions AgentImpact.",
    "agentimpact.missions.inspect": "Detail complet et preuves d une mission.",
    "agentimpact.missions.create": "Cree une mission structuree pour Hermes; ne lance pas directement un worker.",
    "agentimpact.missions.cancel": "Demande l annulation; conserve lease/quarantaine tant que l arret n est pas prouve.",
    "agentimpact.missions.events": "Evenements append-only d une mission.",
    "agentimpact.agent.status": "Etat du worker et de sa preuve de terminaison.",
    "agentimpact.agent.start": "Demande un lancement via policy, approbation, quota, budget, lease et fencing.",
    "agentimpact.agent.stop": "Demande un arret lie a la mission et a la tentative, jamais a un PID libre.",
    "agentimpact.workspace.inspect": "Inspecte le workspace et son lease sans accepter de chemin libre.",
    "agentimpact.tests.run": "Demande un profil de tests allowliste au scheduler.",
    "agentimpact.tests.status": "Lit les preuves de tests et validation.",
    "agentimpact.diff.read": "Lit le diff via le pont Superset borne.",
    "agentimpact.approvals.list": "Liste les approbations exactes en attente.",
    "agentimpact.approvals.inspect": "Inspecte payload hash, expiration et decisions d une approbation.",
    "agentimpact.approvals.approve": "Approuve ou rejette un payload hash exact et expirant.",
    "agentimpact.publisher.prepare": "Prepare une publication apres validation independante; aucun effet GitHub.",
    "agentimpact.publisher.publish": "Execute uniquement une publication exactement approuvee via Publisher.",
    "agentimpact.deploy.prepare": "Prepare un deploiement immutable avec release de rollback.",
    "agentimpact.deploy.execute": "Execute uniquement un deploiement exactement approuve par l autorite serveur.",
}


def _token() -> str:
    configured = os.environ.get("AGENTIMPACT_OPERATOR_TOKEN_FILE", "~/.openjarvis/agentimpact/operator.env")
    path = Path(configured).expanduser()
    st = path.stat()
    if st.st_mode & 0o077:
        raise RuntimeError("operator_token_file_permissions_must_be_0600")
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line and not line.lstrip().startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()
    token = values.get("CTL_OPERATOR_TOKEN", "")
    if len(token) < 32:
        raise RuntimeError("operator_token_missing_or_too_short")
    return token


def _api_url() -> str:
    raw = os.environ.get("AGENTIMPACT_OPERATOR_API_URL", "http://10.66.66.1:3443").rstrip("/")
    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password or parsed.query or parsed.fragment or not parsed.hostname:
        raise RuntimeError("invalid_operator_api_url")
    if parsed.scheme == "http":
        try:
            address = ipaddress.ip_address(parsed.hostname)
        except ValueError as exc:
            raise RuntimeError("plaintext_operator_api_requires_private_ip") from exc
        if not (address.is_private or address.is_loopback):
            raise RuntimeError("plaintext_operator_api_requires_private_ip")
    return raw


def _canonical_arguments(operation: str, arguments: dict[str, Any]) -> bytes:
    return json.dumps(
        {"operation": operation, "arguments": arguments},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")


def _confirmation_dir() -> Path:
    configured = os.environ.get(
        "AGENTIMPACT_CONFIRMATION_DIR",
        "~/.openjarvis/agentimpact/confirmations",
    )
    return Path(configured).expanduser()


def _confirmation_path(operation: str, arguments: dict[str, Any]) -> Path:
    key = hashlib.sha256(_canonical_arguments(operation, arguments)).hexdigest()
    return _confirmation_dir() / f"{key}.json"


def write_confirmation(operation: str, arguments: dict[str, Any], now: float | None = None) -> Path:
    if operation not in CONFIRMATION_REQUIRED:
        raise RuntimeError("operation_does_not_accept_local_confirmation")
    directory = _confirmation_dir()
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory.chmod(0o700)
    issued = time.time() if now is None else now
    target = _confirmation_path(operation, arguments)
    temporary = directory / f".{target.stem}.{uuid.uuid4()}.tmp"
    record = {
        "operation": operation,
        "arguments_sha256": target.stem,
        "issued_at": issued,
        "expires_at": issued + CONFIRMATION_TTL_SECONDS,
    }
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(record, stream, sort_keys=True, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    finally:
        if temporary.exists():
            temporary.unlink()
    return target


def consume_confirmation(operation: str, arguments: dict[str, Any], now: float | None = None) -> None:
    if operation not in CONFIRMATION_REQUIRED:
        return
    directory = _confirmation_dir()
    try:
        directory_stat = directory.stat()
    except FileNotFoundError as exc:
        raise RuntimeError("local_confirmation_required") from exc
    if not stat.S_ISDIR(directory_stat.st_mode) or directory_stat.st_uid != os.getuid() or directory_stat.st_mode & 0o077:
        raise RuntimeError("local_confirmation_directory_insecure")
    target = _confirmation_path(operation, arguments)
    try:
        target_stat = target.lstat()
    except FileNotFoundError as exc:
        raise RuntimeError("local_confirmation_required") from exc
    if not stat.S_ISREG(target_stat.st_mode) or target_stat.st_uid != os.getuid() or target_stat.st_mode & 0o077:
        raise RuntimeError("local_confirmation_file_insecure")
    consuming = directory / f".{target.stem}.{uuid.uuid4()}.consuming"
    try:
        os.replace(target, consuming)
    except FileNotFoundError as exc:
        raise RuntimeError("local_confirmation_required") from exc
    try:
        record = json.loads(consuming.read_text(encoding="utf-8"))
        current = time.time() if now is None else now
        if (
            record.get("operation") != operation
            or record.get("arguments_sha256") != target.stem
            or not isinstance(record.get("expires_at"), (int, float))
            or record["expires_at"] < current
        ):
            raise RuntimeError("local_confirmation_invalid_or_expired")
    finally:
        consuming.unlink(missing_ok=True)


def call_agentimpact(operation: str, arguments: dict[str, Any]) -> dict[str, Any]:
    if operation not in MODEL_TOOLS:
        raise RuntimeError("unknown_agentimpact_operation")
    # Validate local delivery configuration before consuming the one-shot
    # confirmation. A transport failure after consumption remains fail-safe and
    # intentionally requires a fresh human confirmation.
    token = _token()
    api_url = _api_url()
    consume_confirmation(operation, arguments)
    request_id = str(uuid.uuid4())
    requested_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    payload = {"request_id": request_id, "organization_id": os.environ.get("AGENTIMPACT_ORGANIZATION_ID", "org-agentimpact"), "requested_at": requested_at, "operation": operation, "parameters": arguments}
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    signature = hmac.new(token.encode(), requested_at.encode() + b"\n" + request_id.encode() + b"\n" + body, hashlib.sha256).hexdigest()
    req = urllib.request.Request(api_url + "/api/v2/operator/actions", data=body, method="POST", headers={
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-AgentImpact-Timestamp": requested_at,
        "X-AgentImpact-Nonce": request_id,
        "X-AgentImpact-Signature": "v1=" + signature,
        "User-Agent": "openjarvis-agentimpact-adapter/1.0",
    })
    try:
        with urllib.request.urlopen(req, timeout=25) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as exc:
        raw = exc.read(MAX_RESPONSE_BYTES + 1)
    if len(raw) > MAX_RESPONSE_BYTES:
        raise RuntimeError("operator_response_too_large")
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise RuntimeError("invalid_operator_response")
    return parsed


def _reply(request_id: Any, result: dict[str, Any] | None = None, error: dict[str, Any] | None = None) -> None:
    message: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id}
    if error is not None:
        message["error"] = error
    else:
        message["result"] = result or {}
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def handle(message: dict[str, Any]) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    method = message.get("method")
    if method == "initialize":
        return {"protocolVersion": PROTOCOL_VERSION, "capabilities": {"tools": {"listChanged": False}}, "serverInfo": {"name": "agentimpact-openjarvis-adapter", "version": "1.0.0"}}, None
    if method == "tools/list":
        return {"tools": [{"name": name, "description": DESCRIPTIONS[name], "inputSchema": schema, "annotations": {"readOnlyHint": name in {"agentimpact.status", "agentimpact.health"} or any(part in name for part in (".list", ".inspect", ".status", ".events", ".read")), "destructiveHint": name in CONFIRMATION_REQUIRED, "idempotentHint": not name.endswith(".create") and not name.endswith(".prepare")}} for name, schema in MODEL_TOOLS.items()]}, None
    if method == "tools/call":
        params = message.get("params") or {}
        name, arguments = params.get("name"), params.get("arguments") or {}
        if name not in MODEL_TOOLS or not isinstance(arguments, dict):
            return None, {"code": -32602, "message": "invalid_tool_call"}
        try:
            result = call_agentimpact(name, arguments)
            return {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}], "isError": not bool(result.get("ok", False))}, None
        except Exception as exc:
            return {"content": [{"type": "text", "text": json.dumps({"ok": False, "error_code": str(exc)[:120]})}], "isError": True}, None
    return None, {"code": -32601, "message": "method_not_found"}


def main() -> None:
    for line in sys.stdin:
        try:
            message = json.loads(line)
            if not isinstance(message, dict):
                raise ValueError("request_not_object")
            if "id" not in message:
                continue
            result, error = handle(message)
            _reply(message.get("id"), result, error)
        except Exception:
            _reply(None, error={"code": -32700, "message": "parse_error"})


if __name__ == "__main__":
    main()
