#!/usr/bin/env python3
"""Normalise la règle UFW SSH WireGuard canonique (idempotent).

Objectif conceptuel :
  1. ALLOW 10.66.66.2 -> 10.66.66.1:22 on wg0  (exactement une)
  2. autres règles (exceptions IP publiques temporaires préservées)
  3. LIMIT 22/tcp Anywhere (conservé, jamais remplacé par ALLOW Anywhere)

Ne touche pas à la cryptographie WireGuard ni aux peers.
Ne crée jamais 22/tcp ALLOW Anywhere.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass


NUMBERED_RE = re.compile(
    r"^\[\s*(\d+)\]\s+(.+?)\s{2,}(ALLOW|DENY|REJECT|LIMIT)\s+(IN|OUT)\s+(.+)$"
)


@dataclass(frozen=True)
class UfwRule:
    number: int
    raw: str
    action: str
    direction: str
    left: str
    right: str


def run_ufw(args: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["LANG"] = "C"
    env["LC_ALL"] = "C"
    return subprocess.run(
        ["ufw", *args],
        check=check,
        capture_output=True,
        text=True,
        env=env,
    )


def parse_numbered(status_text: str) -> list[UfwRule]:
    rules: list[UfwRule] = []
    for line in status_text.splitlines():
        line = line.strip()
        match = NUMBERED_RE.match(line)
        if not match:
            continue
        number = int(match.group(1))
        left = match.group(2).strip()
        action = match.group(3)
        direction = match.group(4)
        right = match.group(5).strip()
        if "(v6)" in left or "(v6)" in right:
            continue
        rules.append(
            UfwRule(
                number=number,
                raw=line,
                action=action,
                direction=direction,
                left=left,
                right=right,
            )
        )
    return rules


def is_public_ssh_limit(rule: UfwRule) -> bool:
    if rule.action != "LIMIT" or rule.direction != "IN":
        return False
    left = rule.left.lower()
    right = rule.right.lower()
    if "22/tcp" not in left:
        return False
    if " on " in left:
        return False
    return right.startswith("anywhere")


def is_public_ssh_allow_anywhere(rule: UfwRule) -> bool:
    """Ouverture SSH publique globale (interdit par design)."""
    if rule.action != "ALLOW" or rule.direction != "IN":
        return False
    left = rule.left.lower()
    right = rule.right.lower()
    if "22/tcp" not in left:
        return False
    if " on " in left:
        return False
    # from-ip spécifique → exception temporaire, pas globale
    if not left.startswith("22/tcp"):
        return False
    return right.startswith("anywhere")


def is_wg_ssh_allow(
    rule: UfwRule,
    *,
    source: str,
    destination: str,
    interface: str,
    port: str,
) -> bool:
    if rule.action != "ALLOW" or rule.direction != "IN":
        return False
    left = rule.left.lower()
    right = rule.right.lower()
    iface = interface.lower()
    src = source.lower()
    dst = destination.lower()
    port_token = f"{port}/tcp"

    if f"on {iface}" not in left:
        return False
    if port_token not in left:
        return False
    if src not in left:
        return False
    if dst not in right and dst not in left:
        return False
    return True


def ensure_canonical(
    *,
    source: str,
    destination: str,
    interface: str,
    port: str,
    proto: str,
    remove_duplicates: bool,
    apply: bool,
) -> dict:
    status = run_ufw(["status", "numbered"])
    rules = parse_numbered(status.stdout)

    limits = [r for r in rules if is_public_ssh_limit(r)]
    global_allows = [r for r in rules if is_public_ssh_allow_anywhere(r)]
    wg_allows = [
        r
        for r in rules
        if is_wg_ssh_allow(
            r,
            source=source,
            destination=destination,
            interface=interface,
            port=port,
        )
    ]

    if global_allows:
        return {
            "ok": False,
            "error": "public_ssh_allow_anywhere_present",
            "changed": False,
            "global_allow_rules": [r.raw for r in global_allows],
        }

    if not limits:
        return {
            "ok": False,
            "error": "public_ssh_limit_missing",
            "changed": False,
        }

    limit_rule = min(limits, key=lambda r: r.number)
    actions: list[str] = []
    changed = False

    canonical_before_limit = [r for r in wg_allows if r.number < limit_rule.number]
    state_clean = len(wg_allows) == 1 and wg_allows[0].number < limit_rule.number
    state_acceptable = len(canonical_before_limit) >= 1 and not remove_duplicates

    if state_clean or state_acceptable:
        return {
            "ok": True,
            "changed": False,
            "actions": [],
            "canonical_rule": canonical_before_limit[0].raw,
            "limit_rule": limit_rule.raw,
            "wg_ssh_rule_first": True,
            "public_ssh_limit": True,
            "public_ssh_allow_anywhere": False,
            "duplicates_removed": 0,
            "duplicates_count": max(0, len(wg_allows) - 1),
        }

    if not apply:
        return {
            "ok": True,
            "changed": True,
            "dry_run": True,
            "would_insert_before": limit_rule.number,
            "current_wg_rules": [r.raw for r in wg_allows],
            "limit_rule": limit_rule.raw,
            "wg_ssh_rule_first": bool(canonical_before_limit),
            "public_ssh_limit": True,
            "public_ssh_allow_anywhere": False,
            "duplicates_count": max(0, len(wg_allows) - len(canonical_before_limit[:1])),
        }

    to_delete = list(wg_allows)
    for rule in sorted(to_delete, key=lambda r: r.number, reverse=True):
        run_ufw(["--force", "delete", str(rule.number)])
        actions.append(f"deleted:{rule.number}")
        changed = True

    status_after = run_ufw(["status", "numbered"])
    rules_after = parse_numbered(status_after.stdout)
    limits_after = [r for r in rules_after if is_public_ssh_limit(r)]
    if not limits_after:
        return {
            "ok": False,
            "error": "public_ssh_limit_missing_after_delete",
            "changed": changed,
            "actions": actions,
        }
    limit_after = min(limits_after, key=lambda r: r.number)
    insert_at = limit_after.number

    insert_cmd = [
        "insert",
        str(insert_at),
        "allow",
        "in",
        "on",
        interface,
        "from",
        source,
        "to",
        destination,
        "port",
        port,
        "proto",
        proto,
    ]
    run_ufw(insert_cmd)
    actions.append(f"inserted:{insert_at}")
    changed = True

    final_status = run_ufw(["status", "numbered"])
    final_rules = parse_numbered(final_status.stdout)
    final_limits = [r for r in final_rules if is_public_ssh_limit(r)]
    final_wg = [
        r
        for r in final_rules
        if is_wg_ssh_allow(
            r,
            source=source,
            destination=destination,
            interface=interface,
            port=port,
        )
    ]
    final_global = [r for r in final_rules if is_public_ssh_allow_anywhere(r)]

    if final_global:
        return {
            "ok": False,
            "error": "public_ssh_allow_anywhere_present",
            "changed": changed,
            "actions": actions,
        }
    if not final_limits:
        return {
            "ok": False,
            "error": "public_ssh_limit_missing",
            "changed": changed,
            "actions": actions,
        }
    if len(final_wg) != 1:
        return {
            "ok": False,
            "error": "canonical_wg_ssh_count_invalid",
            "changed": changed,
            "actions": actions,
            "final_wg_rules": [r.raw for r in final_wg],
        }
    if final_wg[0].number >= min(final_limits, key=lambda r: r.number).number:
        return {
            "ok": False,
            "error": "wg_ssh_not_before_limit",
            "changed": changed,
            "actions": actions,
            "canonical_rule": final_wg[0].raw,
            "limit_rule": min(final_limits, key=lambda r: r.number).raw,
        }

    return {
        "ok": True,
        "changed": changed,
        "actions": actions,
        "canonical_rule": final_wg[0].raw,
        "limit_rule": min(final_limits, key=lambda r: r.number).raw,
        "wg_ssh_rule_first": True,
        "public_ssh_limit": True,
        "public_ssh_allow_anywhere": False,
        "duplicates_removed": max(0, len(to_delete) - 1) if to_delete else 0,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--destination", required=True)
    parser.add_argument("--interface", required=True)
    parser.add_argument("--port", default="22")
    parser.add_argument("--proto", default="tcp")
    parser.add_argument("--keep-duplicates", action="store_true")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args()

    remove_duplicates = not args.keep_duplicates
    apply = args.apply and not args.check_only

    try:
        result = ensure_canonical(
            source=args.source,
            destination=args.destination,
            interface=args.interface,
            port=args.port,
            proto=args.proto,
            remove_duplicates=remove_duplicates,
            apply=apply,
        )
    except subprocess.CalledProcessError as exc:
        payload = {
            "ok": False,
            "error": "ufw_command_failed",
            "returncode": exc.returncode,
            "stderr": (exc.stderr or "")[:500],
        }
        print(json.dumps(payload, ensure_ascii=True))
        return 2

    print(json.dumps(result, ensure_ascii=True))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
