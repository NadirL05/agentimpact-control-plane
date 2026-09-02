"""Allowlist des commandes hermesctl v1."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import quote

ALLOWED_CMDS = frozenset(
    {
        "health",
        "status",
        "missions.list",
        "missions.show",
        "approvals.pending",
        "mission.propose",
    }
)

PEER_IDENTITY = {
    1001: "agentimpact-runner",
}


@dataclass(frozen=True)
class HandlerSpec:
    method: str
    path_template: str
    build_body: Callable[[dict[str, Any], int], dict[str, Any] | None] | None = None


def _proposal_body(params: dict[str, Any], peer_uid: int) -> dict[str, Any]:
    """Identité dérivée exclusivement de SO_PEERCRED (peer_uid), jamais du client."""
    body: dict[str, Any] = {
        "title": params["title"],
        "instruction": params["instruction"],
        "target_agent": params.get("target_agent", "dev-senior"),
        "priority": params.get("priority", "normal"),
        "proposed_by_uid": peer_uid,
        "proposed_by": PEER_IDENTITY.get(peer_uid, f"uid:{peer_uid}"),
    }
    source_url = params.get("source_url")
    if source_url is not None:
        body["source_url"] = source_url
    return body


HANDLERS: dict[str, HandlerSpec] = {
    "health": HandlerSpec("GET", "/health"),
    "status": HandlerSpec("GET", "/health"),
    "missions.list": HandlerSpec("GET", "/missions"),
    "missions.show": HandlerSpec("GET", "/missions/{id}"),
    "approvals.pending": HandlerSpec("GET", "/api/approvals/pending"),
    "mission.propose": HandlerSpec("POST", "/api/proposals", _proposal_body),
}


def _parse_bounded_int(value: Any, *, minimum: int, maximum: int) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    if parsed < minimum or parsed > maximum:
        return None
    return parsed


def validate_params(cmd: str, params: Any) -> str | None:
    if not isinstance(params, dict):
        return "invalid params"

    try:
        return _validate_params(cmd, params)
    except (TypeError, ValueError, AttributeError):
        return "invalid params"


def _validate_params(cmd: str, params: dict[str, Any]) -> str | None:
    if cmd == "missions.list":
        if "limit" in params and params["limit"] is not None:
            if _parse_bounded_int(params["limit"], minimum=1, maximum=100) is None:
                return "limit out of range"
        if "offset" in params and params["offset"] is not None:
            if _parse_bounded_int(params["offset"], minimum=0, maximum=10000) is None:
                return "offset out of range"
        for key in ("status", "target_agent"):
            if key in params and params[key] is not None and not isinstance(params[key], str):
                return f"invalid {key}"
        return None

    if cmd == "missions.show":
        mission_id = params.get("id")
        if not isinstance(mission_id, str) or len(mission_id) != 36:
            return "invalid mission id"
        return None

    if cmd == "mission.propose":
        title = params.get("title", "")
        instruction = params.get("instruction", "")
        if not isinstance(title, str) or not (3 <= len(title) <= 200):
            return "invalid title"
        if not isinstance(instruction, str) or not (10 <= len(instruction) <= 8000):
            return "invalid instruction"
        target_agent = params.get("target_agent", "dev-senior")
        if target_agent != "dev-senior":
            return "invalid target_agent"
        source_url = params.get("source_url")
        if source_url is not None:
            if not isinstance(source_url, str) or not source_url.startswith("https://"):
                return "invalid source_url"
        priority = params.get("priority", "normal")
        if priority not in ("low", "normal", "high"):
            return "invalid priority"
        return None

    if cmd == "approvals.pending":
        if "limit" in params and params["limit"] is not None:
            if _parse_bounded_int(params["limit"], minimum=1, maximum=100) is None:
                return "limit out of range"
        return None

    return None


def build_query_path(cmd: str, path: str, params: dict[str, Any]) -> str:
    if cmd not in ("missions.list", "approvals.pending"):
        return path

    query_keys = (
        ("status", "target_agent", "limit", "offset")
        if cmd == "missions.list"
        else ("limit",)
    )
    query: list[str] = []
    for key in query_keys:
        if key not in params or params[key] is None:
            continue
        value = params[key]
        if key in ("limit", "offset"):
            if key == "limit":
                parsed = _parse_bounded_int(value, minimum=1, maximum=100)
            else:
                parsed = _parse_bounded_int(value, minimum=0, maximum=10000)
            if parsed is None:
                continue
            value = str(parsed)
        elif not isinstance(value, str):
            continue
        query.append(f"{quote(key)}={quote(value)}")
    if query:
        return f"{path}?{'&'.join(query)}"
    return path
