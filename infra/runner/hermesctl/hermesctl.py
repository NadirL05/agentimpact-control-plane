#!/usr/bin/env python3
"""Client hermesctl — parle au bridge via socket Unix uniquement."""

from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import uuid
from typing import Any

DEFAULT_SOCKET = os.environ.get(
    "HERMESCTL_SOCKET", "/run/agentimpact/hermesctl.sock"
)
MAX_RESPONSE_BYTES = 1024 * 1024


def send_request(cmd: str, params: dict[str, Any], sock_path: str) -> dict[str, Any]:
    request = {
        "v": 1,
        "id": str(uuid.uuid4()),
        "cmd": cmd,
        "params": params,
    }
    payload = (json.dumps(request) + "\n").encode("utf-8")

    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.connect(sock_path)
        sock.sendall(payload)
        chunks: list[bytes] = []
        while True:
            part = sock.recv(4096)
            if not part:
                break
            chunks.append(part)
            if sum(len(c) for c in chunks) > MAX_RESPONSE_BYTES:
                raise RuntimeError("response too large")
            if b"\n" in part:
                break

    raw = b"".join(chunks).decode("utf-8").strip()
    return json.loads(raw)


def emit(response: dict[str, Any]) -> int:
    print(json.dumps(response, indent=2, ensure_ascii=False))
    return 0 if response.get("ok") else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="hermesctl")
    parser.add_argument(
        "--socket",
        default=DEFAULT_SOCKET,
        help="Chemin du socket bridge",
    )

    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("health", help="Santé bridge + control plane")

    sub.add_parser("status", help="Statut control plane et gateways")

    missions = sub.add_parser("missions", help="Missions")
    missions_sub = missions.add_subparsers(dest="missions_cmd", required=True)
    missions_list = missions_sub.add_parser("list", help="Lister les missions")
    missions_list.add_argument("--status")
    missions_list.add_argument("--target-agent")
    missions_list.add_argument("--limit", type=int, default=50)
    missions_list.add_argument("--offset", type=int, default=0)
    missions_show = missions_sub.add_parser("show", help="Détail mission")
    missions_show.add_argument("id")

    approvals = sub.add_parser("approvals", help="Approbations")
    approvals_sub = approvals.add_subparsers(dest="approvals_cmd", required=True)
    approvals_pending = approvals_sub.add_parser("pending", help="File d'attente")
    approvals_pending.add_argument("--limit", type=int, default=50)

    mission = sub.add_parser("mission", help="Proposition (sans exécution)")
    mission_sub = mission.add_subparsers(dest="mission_cmd", required=True)
    mission_propose = mission_sub.add_parser("propose", help="Proposer une mission")
    mission_propose.add_argument("--title", required=True)
    mission_propose.add_argument("--instruction", required=True)
    mission_propose.add_argument("--target-agent", default="dev-senior")
    mission_propose.add_argument("--priority", default="normal")
    mission_propose.add_argument("--source-url")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    sock_path = args.socket

    if args.command == "health":
        return emit(send_request("health", {}, sock_path))

    if args.command == "status":
        return emit(send_request("status", {}, sock_path))

    if args.command == "missions" and args.missions_cmd == "list":
        params: dict[str, Any] = {
            "limit": args.limit,
            "offset": args.offset,
        }
        if args.status:
            params["status"] = args.status
        if args.target_agent:
            params["target_agent"] = args.target_agent
        return emit(send_request("missions.list", params, sock_path))

    if args.command == "missions" and args.missions_cmd == "show":
        return emit(send_request("missions.show", {"id": args.id}, sock_path))

    if args.command == "approvals" and args.approvals_cmd == "pending":
        return emit(send_request("approvals.pending", {"limit": args.limit}, sock_path))

    if args.command == "mission" and args.mission_cmd == "propose":
        params = {
            "title": args.title,
            "instruction": args.instruction,
            "target_agent": args.target_agent,
            "priority": args.priority,
            "proposed_by_uid": os.getuid(),
            "proposed_by": os.environ.get("USER", "agentimpact-runner"),
        }
        if args.source_url:
            params["source_url"] = args.source_url
        return emit(send_request("mission.propose", params, sock_path))

    parser.error("commande non supportée")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
