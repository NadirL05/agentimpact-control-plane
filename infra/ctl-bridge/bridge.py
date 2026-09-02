#!/usr/bin/env python3
"""Daemon bridge hermesctl — socket Unix (LISTEN_FDS) + API authentifiée."""

from __future__ import annotations

import json
import os
import socket
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
from typing import Any

from allowlist import ALLOWED_CMDS, HANDLERS, build_query_path, validate_params
from audit import log_request, setup_audit_logging

MAX_REQUEST_BYTES = 64 * 1024
ALLOWED_PEER_UIDS = {
    int(x)
    for x in os.environ.get("ALLOWED_PEER_UIDS", "1001").split(",")
    if x.strip()
}
BRIDGE_VERSION = os.environ.get("BRIDGE_VERSION", "1.0.0")
API_BASE = os.environ.get("CONTROL_PLANE_URL", "")
BRIDGE_TOKEN = os.environ.get("CTL_BRIDGE_TOKEN", "")
READ_TIMEOUT_SECONDS = float(os.environ.get("BRIDGE_READ_TIMEOUT_SECONDS", "30"))


def systemd_listen_fd() -> int:
    listen_fds = int(os.environ.get("LISTEN_FDS", "0"))
    if listen_fds < 1:
        raise RuntimeError("LISTEN_FDS missing — lancer via agentimpact-ctl-bridge.socket")
    return 3


def peer_credentials(conn: socket.socket) -> tuple[int, int, int]:
    cred = conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    pid, uid, gid = struct.unpack("3i", cred)
    return pid, uid, gid


def error_response(req_id: str, code: str, message: str, peer_uid: int, duration_ms: int) -> dict[str, Any]:
    return {
        "v": 1,
        "id": req_id,
        "ok": False,
        "error": {"code": code, "message": message},
        "meta": {
            "bridge_version": BRIDGE_VERSION,
            "duration_ms": duration_ms,
            "peer_uid": peer_uid,
        },
    }


def success_response(req_id: str, data: Any, peer_uid: int, duration_ms: int) -> dict[str, Any]:
    return {
        "v": 1,
        "id": req_id,
        "ok": True,
        "data": data,
        "meta": {
            "bridge_version": BRIDGE_VERSION,
            "duration_ms": duration_ms,
            "peer_uid": peer_uid,
        },
    }


def upstream_request(method: str, path: str, body: dict[str, Any] | None = None) -> tuple[int, Any]:
    url = f"{API_BASE}{path}"
    headers = {
        "Authorization": f"Bearer {BRIDGE_TOKEN}",
        "Accept": "application/json",
    }
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read().decode("utf-8")
            status = resp.status
            return status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(raw) if raw else {"error": "upstream_error"}
        except json.JSONDecodeError:
            payload = {"error": "upstream_error"}
        return exc.code, payload


def gateway_status() -> dict[str, str]:
    units = [
        "hermes-gateway.service",
        "hermes-gateway-growth.service",
        "hermes-gateway-memoire.service",
        "hermes-dashboard.service",
    ]
    states: dict[str, str] = {}
    for unit in units:
        try:
            proc = subprocess.run(
                ["systemctl", "show", unit, "-p", "ActiveState", "--value"],
                check=False,
                capture_output=True,
                text=True,
                timeout=5,
            )
            states[unit] = (proc.stdout or "unknown").strip() or "unknown"
        except (OSError, subprocess.TimeoutExpired):
            states[unit] = "unknown"
    return states


def handle_command(
    cmd: str,
    params: dict[str, Any],
    peer_uid: int,
) -> tuple[bool, str | None, Any, int | None]:
    if cmd not in ALLOWED_CMDS:
        return False, "UNKNOWN_CMD", None, None

    param_error = validate_params(cmd, params)
    if param_error:
        return False, "INVALID_PARAMS", {"message": param_error}, None

    if cmd == "status":
        status_code, health = upstream_request("GET", "/health")
        if status_code >= 400:
            return False, "UPSTREAM_ERROR", health, status_code
        return True, None, {
            "control_plane": health,
            "hermes_gateways": gateway_status(),
            "hermes_legacy_unit": "masked",
        }, status_code

    spec = HANDLERS[cmd]
    path = spec.path_template
    if cmd == "missions.show":
        path = path.format(id=params["id"])
    elif cmd == "missions.list":
        path = build_query_path(cmd, path, params)

    body = spec.build_body(params, peer_uid) if spec.build_body else None
    status_code, payload = upstream_request(spec.method, path, body)

    if status_code >= 400:
        return False, "UPSTREAM_ERROR", payload, status_code

    if cmd == "mission.propose":
        return True, None, {
            "proposal_id": payload.get("item", {}).get("id"),
            "status": payload.get("item", {}).get("status", "awaiting_nadir_review"),
            "message": payload.get("message"),
        }, status_code

    if cmd == "health":
        return True, None, {
            "bridge": "ok",
            "control_plane_reachable": payload.get("status") == "ok",
        }, status_code

    return True, None, payload, status_code


def handle_client(conn: socket.socket) -> None:
    started = time.monotonic()
    conn.settimeout(READ_TIMEOUT_SECONDS)
    pid, uid, gid = peer_credentials(conn)
    req_id = ""
    cmd = ""
    params: dict[str, Any] = {}
    upstream_status: int | None = None

    try:
        if uid not in ALLOWED_PEER_UIDS:
            resp = error_response(req_id or "unknown", "FORBIDDEN_PEER", "peer not allowed", uid, 0)
            conn.sendall((json.dumps(resp) + "\n").encode("utf-8"))
            log_request(
                peer_uid=uid,
                peer_pid=pid,
                peer_gid=gid,
                request_id=req_id or "unknown",
                cmd="(rejected)",
                params={},
                ok=False,
                error_code="FORBIDDEN_PEER",
                duration_ms=0,
                upstream_status=None,
            )
            return

        raw = conn.recv(MAX_REQUEST_BYTES + 1)
    except socket.timeout:
        resp = error_response(req_id or "unknown", "READ_TIMEOUT", "read timeout", uid, 0)
        conn.sendall((json.dumps(resp) + "\n").encode("utf-8"))
        log_request(
            peer_uid=uid,
            peer_pid=pid,
            peer_gid=gid,
            request_id=req_id or "unknown",
            cmd=cmd or "(timeout)",
            params={},
            ok=False,
            error_code="READ_TIMEOUT",
            duration_ms=int((time.monotonic() - started) * 1000),
            upstream_status=None,
        )
        conn.close()
        return

    try:
        if len(raw) > MAX_REQUEST_BYTES:
            resp = error_response("unknown", "PAYLOAD_TOO_LARGE", "request too large", uid, 0)
            conn.sendall((json.dumps(resp) + "\n").encode("utf-8"))
            return

        try:
            message = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            resp = error_response("unknown", "PROTOCOL_ERROR", "invalid json", uid, 0)
            conn.sendall((json.dumps(resp) + "\n").encode("utf-8"))
            return

        req_id = str(message.get("id", "unknown"))
        cmd = str(message.get("cmd", ""))
        raw_params = message.get("params")
        if raw_params is None:
            params = {}
        elif isinstance(raw_params, dict):
            params = raw_params
        else:
            resp = error_response(req_id, "INVALID_PARAMS", "invalid params", uid, 0)
            conn.sendall((json.dumps(resp) + "\n").encode("utf-8"))
            return

        if message.get("v") != 1:
            resp = error_response(req_id, "PROTOCOL_ERROR", "unsupported version", uid, 0)
            conn.sendall((json.dumps(resp) + "\n").encode("utf-8"))
            return

        try:
            ok, error_code, data, upstream_status = handle_command(cmd, params, uid)
        except Exception:
            ok, error_code, data, upstream_status = (
                False,
                "INTERNAL_ERROR",
                {"message": "internal error"},
                None,
            )
        duration_ms = int((time.monotonic() - started) * 1000)

        if ok:
            resp = success_response(req_id, data, uid, duration_ms)
        else:
            resp = error_response(
                req_id,
                error_code or "INTERNAL_ERROR",
                (data or {}).get("error", "request failed")
                if isinstance(data, dict)
                else "request failed",
                uid,
                duration_ms,
            )

        conn.sendall((json.dumps(resp) + "\n").encode("utf-8"))
        log_request(
            peer_uid=uid,
            peer_pid=pid,
            peer_gid=gid,
            request_id=req_id,
            cmd=cmd,
            params=params,
            ok=ok,
            error_code=error_code,
            duration_ms=duration_ms,
            upstream_status=upstream_status,
        )
    finally:
        conn.close()


def main() -> int:
    if not BRIDGE_TOKEN:
        print("CTL_BRIDGE_TOKEN required", file=sys.stderr)
        return 1
    if not API_BASE:
        print("CONTROL_PLANE_URL required", file=sys.stderr)
        return 1

    setup_audit_logging()
    fd = systemd_listen_fd()
    sock = socket.fromfd(fd, socket.AF_UNIX, socket.SOCK_STREAM)

    while True:
        conn, _addr = sock.accept()
        handle_client(conn)


if __name__ == "__main__":
    raise SystemExit(main())
