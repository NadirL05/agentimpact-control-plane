#!/usr/bin/env python3
"""Create one short-lived, exact local confirmation for a destructive MCP call."""
from __future__ import annotations

import argparse
import json
import sys

from agentimpact_mcp import CONFIRMATION_REQUIRED, write_confirmation


def main() -> int:
    parser = argparse.ArgumentParser(prog="agentimpact-openjarvis-confirm")
    parser.add_argument("operation", choices=sorted(CONFIRMATION_REQUIRED))
    parser.add_argument("arguments_json", help="Exact JSON object that OpenJarvis will send")
    args = parser.parse_args()
    try:
        arguments = json.loads(args.arguments_json)
    except json.JSONDecodeError as exc:
        parser.error(f"invalid JSON: {exc}")
    if not isinstance(arguments, dict):
        parser.error("arguments_json must be a JSON object")
    if not sys.stdin.isatty():
        print("interactive_terminal_required", file=sys.stderr)
        return 2
    print(json.dumps({"operation": args.operation, "arguments": arguments}, indent=2, ensure_ascii=False))
    if input("Type APPROVE to create a 120-second one-shot confirmation: ") != "APPROVE":
        print("confirmation_cancelled", file=sys.stderr)
        return 3
    write_confirmation(args.operation, arguments)
    print("confirmation_ready")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
