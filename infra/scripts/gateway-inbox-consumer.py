#!/usr/bin/env python3
"""Consumer inbox gateway Hermès/Ana — localhost + token bridge uniquement."""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

API_BASE = os.environ.get("CONTROL_PLANE_URL", "http://127.0.0.1:3000").rstrip("/")
HERMES_BIN = os.environ.get(
    "HERMES_BIN",
    "/usr/local/lib/hermes-agent/venv/bin/python -m hermes_cli.main",
)
LOOP_MIN_SLEEP_SEC = float(os.environ.get("GATEWAY_INBOX_LOOP_MIN_SEC", "1"))
LOOP_MAX_SLEEP_SEC = float(os.environ.get("GATEWAY_INBOX_LOOP_MAX_SEC", "30"))

ALLOWED_TARGETS = frozenset({"hermes", "ana"})
REJECTED_TARGETS = frozenset({"devin", "codex", "grok"})

_SHUTDOWN = False
_IN_FLIGHT = False


def inbox_target() -> str:
    return os.environ.get("GATEWAY_INBOX_TARGET", "").strip()


def hermes_profile() -> str:
    return os.environ.get("HERMES_PROFILE", "").strip()


def _handle_shutdown(signum: int, _frame: object) -> None:
    del signum
    global _SHUTDOWN
    _SHUTDOWN = True
    if _IN_FLIGHT:
        sys.stderr.write("gateway-inbox-consumer: shutdown requested during processing\n")


def load_bridge_token(*, require_file: bool = False) -> str:
    token_file = os.environ.get("SLACK_ROUTER_BRIDGE_TOKEN_FILE", "").strip()
    if token_file:
        with open(token_file, encoding="utf-8") as handle:
            return handle.read().strip()
    if require_file:
        return ""
    return os.environ.get("SLACK_ROUTER_BRIDGE_TOKEN", "").strip()


def api_post(path: str, body: dict | None = None, token: str = "") -> tuple[int, dict]:
    url = f"{API_BASE}{path}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    }
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        if exc.code == 204:
            return 204, {}
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(raw) if raw else {"error": "upstream_error"}
        except json.JSONDecodeError:
            payload = {"error": "upstream_error"}
        return exc.code, payload


def run_hermes(prompt: str) -> str:
    profile = hermes_profile()
    target = inbox_target()
    if not profile:
        raise RuntimeError("HERMES_PROFILE unset")
    if target in REJECTED_TARGETS:
        raise RuntimeError("forbidden_target")
    cmd = [
        "/opt/agentimpact/scripts/run-with-profile.sh",
        profile,
        *HERMES_BIN.split(),
        "-z",
        prompt,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600, check=False)
    output = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode != 0:
        raise RuntimeError(f"hermes_exit_{proc.returncode}")
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    return lines[-1] if lines else "Réponse Hermès vide."


def process_once(token: str) -> str:
    """Retourne 'empty', 'processed', 'failed', 'shutdown'."""
    global _IN_FLIGHT
    target = inbox_target()
    if _SHUTDOWN:
        return "shutdown"

    status, payload = api_post("/api/gateway-inbox/claim", {"target": target}, token=token)
    if status == 204:
        return "empty"
    if status != 200 or "item" not in payload:
        sys.stderr.write(f"claim failed status={status}\n")
        return "failed"

    item = payload["item"]
    item_id = item["id"]
    item_target = item.get("target", "")
    if item_target != target:
        sys.stderr.write(f"target_mismatch expected={target} got={item_target}\n")
        api_post(
            f"/api/gateway-inbox/{item_id}/complete",
            {"error_code": "target_mismatch"},
            token=token,
        )
        return "failed"

    if _SHUTDOWN:
        api_post(
            f"/api/gateway-inbox/{item_id}/complete",
            {"error_code": "consumer_shutdown"},
            token=token,
        )
        return "shutdown"

    _IN_FLIGHT = True
    try:
        text = run_hermes(item["prompt"])
        if _SHUTDOWN:
            api_post(
                f"/api/gateway-inbox/{item_id}/complete",
                {"error_code": "consumer_shutdown"},
                token=token,
            )
            return "shutdown"
        complete_status, _ = api_post(
            f"/api/gateway-inbox/{item_id}/complete",
            {"text": text[:4000]},
            token=token,
        )
        if complete_status != 200:
            return "failed"
        return "processed"
    except Exception as exc:
        api_post(
            f"/api/gateway-inbox/{item_id}/complete",
            {"error_code": str(exc)[:120]},
            token=token,
        )
        return "failed"
    finally:
        _IN_FLIGHT = False


def validate_target() -> int:
    target = inbox_target()
    if target in REJECTED_TARGETS:
        sys.stderr.write(f"GATEWAY_INBOX_TARGET forbidden: {target}\n")
        return 2
    if target not in ALLOWED_TARGETS:
        sys.stderr.write("GATEWAY_INBOX_TARGET must be hermes or ana\n")
        return 2
    return 0


def run_once() -> int:
    rc = validate_target()
    if rc != 0:
        return rc
    token = load_bridge_token()
    if not token:
        sys.stderr.write("SLACK_ROUTER_BRIDGE_TOKEN required\n")
        return 2
    outcome = process_once(token)
    if outcome == "failed":
        return 1
    return 0


def run_loop() -> int:
    rc = validate_target()
    if rc != 0:
        return rc
    token = load_bridge_token(require_file=True)
    if not token:
        sys.stderr.write("SLACK_ROUTER_BRIDGE_TOKEN_FILE required in loop mode\n")
        return 2

    signal.signal(signal.SIGTERM, _handle_shutdown)
    signal.signal(signal.SIGINT, _handle_shutdown)

    sleep_sec = LOOP_MIN_SLEEP_SEC
    while not _SHUTDOWN:
        outcome = process_once(token)
        if outcome == "shutdown":
            return 0
        if outcome == "empty":
            time.sleep(sleep_sec)
            sleep_sec = min(sleep_sec * 2, LOOP_MAX_SLEEP_SEC)
            continue
        if outcome == "processed":
            sleep_sec = LOOP_MIN_SLEEP_SEC
            continue
        time.sleep(sleep_sec)
        sleep_sec = min(sleep_sec * 2, LOOP_MAX_SLEEP_SEC)

    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Gateway inbox consumer Hermès/Ana")
    parser.add_argument(
        "--loop",
        action="store_true",
        help="Mode long-running avec backoff borné (systemd)",
    )
    args = parser.parse_args()
    if args.loop:
        return run_loop()
    return run_once()


if __name__ == "__main__":
    raise SystemExit(main())
