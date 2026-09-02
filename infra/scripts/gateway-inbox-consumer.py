#!/usr/bin/env python3
"""Consumer inbox gateway Hermès/Ana — localhost + token bridge uniquement."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

API_BASE = os.environ.get("CONTROL_PLANE_URL", "http://127.0.0.1:3000").rstrip("/")
BRIDGE_TOKEN = os.environ.get("SLACK_ROUTER_BRIDGE_TOKEN", "")
TARGET = os.environ.get("GATEWAY_INBOX_TARGET", "")
PROFILE = os.environ.get("HERMES_PROFILE", "")
HERMES_BIN = os.environ.get(
    "HERMES_BIN",
    "/usr/local/lib/hermes-agent/venv/bin/python -m hermes_cli.main",
)


def api_post(path: str, body: dict | None = None) -> tuple[int, dict]:
    url = f"{API_BASE}{path}"
    headers = {
        "Authorization": f"Bearer {BRIDGE_TOKEN}",
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
    if not PROFILE:
        raise RuntimeError("HERMES_PROFILE unset")
    cmd = [
        "/opt/agentimpact/scripts/run-with-profile.sh",
        PROFILE,
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


def main() -> int:
    if TARGET not in {"hermes", "ana"}:
        sys.stderr.write("GATEWAY_INBOX_TARGET must be hermes or ana\n")
        return 2
    if not BRIDGE_TOKEN:
        sys.stderr.write("SLACK_ROUTER_BRIDGE_TOKEN required\n")
        return 2

    status, payload = api_post("/api/gateway-inbox/claim", {"target": TARGET})
    if status == 204:
        return 0
    if status != 200 or "item" not in payload:
        sys.stderr.write(f"claim failed status={status}\n")
        return 1

    item = payload["item"]
    item_id = item["id"]
    prompt = item["prompt"]

    try:
        text = run_hermes(prompt)
        complete_status, _ = api_post(
            f"/api/gateway-inbox/{item_id}/complete",
            {"text": text[:4000]},
        )
        if complete_status != 200:
            return 1
        return 0
    except Exception as exc:
        api_post(
            f"/api/gateway-inbox/{item_id}/complete",
            {"error_code": str(exc)[:120]},
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
