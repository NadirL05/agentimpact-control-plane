"""Allowlist des commandes hermesctl v1."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

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


@dataclass(frozen=True)
class HandlerSpec:
    method: str
    path_template: str
    build_body: Callable[[dict[str, Any]], dict[str, Any] | None] | None = None


def _proposal_body(params: dict[str, Any]) -> dict[str, Any]:
    return {
        "title": params["title"],
        "instruction": params["instruction"],
        "target_agent": params.get("target_agent", "dev-senior"),
        "priority": params.get("priority", "normal"),
        "source_url": params.get("source_url"),
        "proposed_by_uid": params.get("proposed_by_uid", 1001),
        "proposed_by": params.get("proposed_by", "agentimpact-runner"),
    }


HANDLERS: dict[str, HandlerSpec] = {
    "health": HandlerSpec("GET", "/health"),
    "status": HandlerSpec("GET", "/health"),
    "missions.list": HandlerSpec("GET", "/missions"),
    "missions.show": HandlerSpec("GET", "/missions/{id}"),
    "approvals.pending": HandlerSpec("GET", "/api/approvals/pending"),
    "mission.propose": HandlerSpec("POST", "/api/proposals", _proposal_body),
}


def validate_params(cmd: str, params: dict[str, Any]) -> str | None:
    if cmd == "missions.list":
        for key in ("status", "target_agent", "limit", "offset"):
            if key in params and params[key] is not None:
                if key == "limit":
                    limit = int(params["limit"])
                    if limit < 1 or limit > 100:
                        return "limit out of range"
                if key == "offset":
                    offset = int(params["offset"])
                    if offset < 0 or offset > 10000:
                        return "offset out of range"
        return None

    if cmd == "missions.show":
        mission_id = params.get("id")
        if not mission_id or len(str(mission_id)) != 36:
            return "invalid mission id"
        return None

    if cmd == "mission.propose":
        title = params.get("title", "")
        instruction = params.get("instruction", "")
        if not (3 <= len(title) <= 200):
            return "invalid title"
        if not (10 <= len(instruction) <= 8000):
            return "invalid instruction"
        if params.get("target_agent", "dev-senior") != "dev-senior":
            return "invalid target_agent"
        source_url = params.get("source_url")
        if source_url is not None and not str(source_url).startswith("https://"):
            return "invalid source_url"
        return None

    if cmd == "approvals.pending":
        if "limit" in params:
            limit = int(params["limit"])
            if limit < 1 or limit > 100:
                return "limit out of range"
        return None

    return None
