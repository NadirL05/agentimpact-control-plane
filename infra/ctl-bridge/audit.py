"""Journal audit structuré — journald, sans secrets."""

from __future__ import annotations

import hashlib
import json
import logging
import sys
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger("agentimpact-ctl-bridge.audit")


def setup_audit_logging() -> None:
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False


def params_digest(params: dict[str, Any]) -> str:
    canonical = json.dumps(params, sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def log_request(
    *,
    peer_uid: int,
    peer_pid: int,
    peer_gid: int,
    request_id: str,
    cmd: str,
    params: dict[str, Any],
    ok: bool,
    error_code: str | None,
    duration_ms: int,
    upstream_status: int | None,
) -> None:
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "peer_uid": peer_uid,
        "peer_pid": peer_pid,
        "peer_gid": peer_gid,
        "request_id": request_id,
        "cmd": cmd,
        "params_digest": params_digest(params),
        "ok": ok,
        "error_code": error_code,
        "duration_ms": duration_ms,
        "upstream_status": upstream_status,
    }
    logger.info(json.dumps(entry, separators=(",", ":")))
