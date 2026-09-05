#!/usr/bin/env python3
"""Consumer inbox gateway Hermès/Ana — localhost + token bridge uniquement.

Résilience réseau : URLError / timeout ne quittent pas la boucle --loop.
Backoff borné 1–30 s entre tentatives.

Item resté en status ``processing`` : si le traitement Hermès réussit mais
l'appel ``/complete`` échoue (transport), l'item n'est pas marqué done/failed.
Il reste ``processing`` jusqu'à intervention manuelle ou expiration côté API.
Aucune double exécution Hermès sur reprise : le claim suivant prend un autre
item pending (FOR UPDATE SKIP LOCKED côté API).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import socket
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


class TransportError(Exception):
    """Erreur réseau/API indisponible — la boucle long-running doit continuer."""


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
    except (urllib.error.URLError, TimeoutError, socket.timeout, ConnectionError, OSError):
        raise TransportError("transport_error") from None


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
    # Timeout worker (subprocess) distinct du timeout ACK routeur et du timeout LLM.
    # Les missions async ne maintiennent plus de poll HTTP côté Slack pendant cette durée.
    worker_timeout = int(os.environ.get("GATEWAY_INBOX_HERMES_TIMEOUT_SEC", "600"))
    if worker_timeout < 30:
        worker_timeout = 30
    if worker_timeout > 3600:
        worker_timeout = 3600
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=worker_timeout, check=False
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("hermes_timeout") from exc
    output = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode != 0:
        raise RuntimeError(format_hermes_exit_error(proc.returncode, proc.stderr or ""))
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    return lines[-1] if lines else "Réponse Hermès vide."


_SECRETISH_RE = re.compile(
    r"(token|secret|password|api[_-]?key|bearer|authorization)\s*[:=]",
    re.IGNORECASE,
)


def format_hermes_exit_error(returncode: int, stderr: str) -> str:
    """Mappe returncode → hermes_exit_N, avec snippet stderr sanitisé (config only)."""
    base = f"hermes_exit_{returncode}"
    for raw in stderr.splitlines():
        line = raw.strip()
        if not line or _SECRETISH_RE.search(line):
            continue
        if any(
            marker in line
            for marker in (
                "HERMES_PROFILE",
                "Fichier manquant",
                "Profil inconnu",
                "ne resout",
                "Usage:",
            )
        ):
            # Pas de prompt ni chemin trop long ; error_code API ≤ 120.
            snippet = line[:80]
            return f"{base}:{snippet}"[:120]
    return base

def _try_complete_error(item_id: str, token: str, error_code: str) -> str:
    """Tente de marquer failed ; retourne outcome si transport bloque."""
    try:
        complete_status, _ = api_post(
            f"/api/gateway-inbox/{item_id}/complete",
            {"error_code": error_code[:120]},
            token=token,
        )
        if complete_status != 200:
            return "failed"
        return "failed"
    except TransportError:
        sys.stderr.write("complete transport_error after hermes failure\n")
        return "transport_error"


def process_once(token: str) -> str:
    """Retourne empty, processed, failed, transport_error ou shutdown."""
    global _IN_FLIGHT
    target = inbox_target()
    if _SHUTDOWN:
        return "shutdown"

    try:
        status, payload = api_post("/api/gateway-inbox/claim", {"target": target}, token=token)
    except TransportError:
        sys.stderr.write("claim transport_error\n")
        return "transport_error"

    if status == 204:
        return "empty"
    if status != 200 or "item" not in payload:
        sys.stderr.write(f"claim failed status={status}\n")
        return "failed"

    item = payload["item"]
    if item.get("orchestration_version", 1) != 1:
        sys.stderr.write("wrong_orchestration_version\n")
        return "wrong_orchestration_version"
    item_id = item["id"]
    item_target = item.get("target", "")
    if item_target != target:
        sys.stderr.write(f"target_mismatch expected={target} got={item_target}\n")
        return _try_complete_error(item_id, token, "target_mismatch")

    if _SHUTDOWN:
        return _try_complete_error(item_id, token, "consumer_shutdown")

    _IN_FLIGHT = True
    try:
        text = run_hermes(item["prompt"])
        if _SHUTDOWN:
            return _try_complete_error(item_id, token, "consumer_shutdown")
        try:
            complete_status, _ = api_post(
                f"/api/gateway-inbox/{item_id}/complete",
                {"text": text[:4000]},
                token=token,
            )
        except TransportError:
            sys.stderr.write("complete transport_error after hermes success\n")
            return "transport_error"
        if complete_status != 200:
            sys.stderr.write(f"complete failed status={complete_status}\n")
            return "failed"
        return "processed"
    except TransportError:
        sys.stderr.write("complete transport_error\n")
        return "transport_error"
    except Exception as exc:
        return _try_complete_error(item_id, token, str(exc))
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


def sleep_backoff(seconds: float) -> bool:
    """Dort par tranches ; retourne False si SIGTERM reçu."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if _SHUTDOWN:
            return False
        remaining = deadline - time.monotonic()
        time.sleep(min(0.5, max(remaining, 0.0)))
    return True


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
        try:
            outcome = process_once(token)
        except Exception:
            sys.stderr.write("unexpected consumer error\n")
            outcome = "transport_error"

        if outcome == "shutdown":
            return 0
        if outcome == "processed":
            sleep_sec = LOOP_MIN_SLEEP_SEC
            continue
        if outcome in ("empty", "failed", "transport_error"):
            if not sleep_backoff(sleep_sec):
                return 0
            sleep_sec = min(sleep_sec * 2, LOOP_MAX_SLEEP_SEC)
            continue

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
