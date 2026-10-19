#!/usr/bin/env python3
"""Read-only Apollo snapshot reconciliation and local Growth access preflight.

No API key, inference call, campaign mutation, scheduler or database write.
Only aggregate counters and fixed diagnostic codes leave this process.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MAX_INPUT_BYTES = 10 * 1024 * 1024
KNOWN_REASONS = {"ai_variable_generation_failed", "snippets_missing"}
PROFILE = Path("/home/hermes/.hermes/profiles/agentimpact-growth")


class InvalidSnapshot(ValueError):
    """Never include input content in errors: snapshots may contain PII."""


def integer(value: Any) -> int:
    if isinstance(value, str) and value.isascii() and value.isdigit():
        value = int(value)
    if type(value) is not int or not 0 <= value <= 100_000:
        raise InvalidSnapshot("invalid_counter")
    return value


def unwrap(value: Any) -> dict:
    """Accept raw Apollo objects or the MCP envelopes used by the connector."""
    if not isinstance(value, dict) or value.get("isError") is True:
        raise InvalidSnapshot("invalid_provider_response")
    if isinstance(value.get("structuredContent"), dict):
        return unwrap(value["structuredContent"])
    if isinstance(value.get("content"), list):
        texts = [c.get("text") for c in value["content"] if isinstance(c, dict) and c.get("type") == "text"]
        if len(texts) != 1:
            raise InvalidSnapshot("invalid_provider_response")
        try:
            return unwrap(json.loads(texts[0]))
        except (ValueError, TypeError):
            raise InvalidSnapshot("invalid_provider_response") from None
    return value


def collect_pages(pages: Any, key: str) -> list[dict]:
    if not isinstance(pages, list) or not pages:
        raise InvalidSnapshot("missing_pages")
    records: dict[str, dict] = {}
    page_numbers: set[int] = set()
    expected: tuple[int, int] | None = None
    for raw in pages:
        payload = unwrap(raw)
        pagination = payload.get("pagination")
        if not isinstance(pagination, dict):
            raise InvalidSnapshot("missing_pagination")
        total, last = (integer(pagination.get(k)) for k in ("total_entries", "total_pages"))
        number = integer(pagination.get("page"))
        if number < 1 or number > max(1, last) or number in page_numbers:
            raise InvalidSnapshot("invalid_page_number")
        if expected is not None and expected != (total, last):
            raise InvalidSnapshot("pagination_changed_during_read")
        expected = (total, last)
        page_numbers.add(number)
        rows = payload.get(key)
        if not isinstance(rows, list):
            raise InvalidSnapshot("missing_records")
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not re.fullmatch(r"[a-f0-9]{24}", row["id"]):
                raise InvalidSnapshot("invalid_record")
            if row["id"] in records:
                raise InvalidSnapshot("duplicate_record_during_read")
            records[row["id"]] = row
    assert expected is not None
    total, last = expected
    if len(records) != total or page_numbers != set(range(1, max(1, last) + 1)):
        raise InvalidSnapshot("incomplete_pages")
    if (last == 0) != (total == 0) and not (last == 1 and total == 0):
        raise InvalidSnapshot("invalid_pagination")
    return list(records.values())


def message_counts(rows: list[dict], campaign_id: str) -> tuple[dict, dict]:
    counts = Counter({k: 0 for k in ("delivered", "sent_only", "scheduled", "failed", "unconfirmed")})
    reasons: Counter[str] = Counter()
    for row in rows:
        if row.get("emailer_campaign_id") != campaign_id:
            raise InvalidSnapshot("message_campaign_mismatch")
        for flag in ("delivered", "sent"):
            if flag in row and type(row[flag]) is not bool:
                raise InvalidSnapshot("invalid_delivery_flag")
        status = row.get("status")
        if not isinstance(status, str):
            raise InvalidSnapshot("invalid_message_state")
        delivered = row.get("delivered") is True or status == "delivered"
        sent = delivered or row.get("sent") is True or status == "sent"
        if sent and status in {"failed", "scheduled"}:
            raise InvalidSnapshot("contradictory_message_state")
        if delivered:
            counts["delivered"] += 1
        elif sent:
            counts["sent_only"] += 1
        elif status in {"scheduled", "failed"}:
            counts[status] += 1
        else:
            # completed/active/enrolled alone are not proof of a send.
            counts["unconfirmed"] += 1
        if status == "failed":
            reason = row.get("not_sent_reason")
            reasons[reason if isinstance(reason, str) and reason in KNOWN_REASONS else "other"] += 1
    counts["confirmed_sent"] = counts["delivered"] + counts["sent_only"]
    counts["total"] = len(rows)
    return dict(counts), dict(reasons)


def metadata_issues(raw: Any, counts: dict) -> list[str]:
    meta = unwrap(raw)
    if integer(meta.get("total_count")) != counts["total"]:
        return ["metadata_total_mismatch"]
    rows = meta.get("status_counts")
    if not isinstance(rows, list):
        raise InvalidSnapshot("missing_metadata_statuses")
    statuses: dict[str, int] = {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("status"), str):
            raise InvalidSnapshot("invalid_metadata_status")
        if row["status"] in statuses:
            raise InvalidSnapshot("duplicate_metadata_status")
        statuses[row["status"]] = integer(row.get("count"))
    # Apollo's status tallies overlap. Never add sent and delivered together.
    pairs = (("delivered", "delivered"), ("scheduled", "scheduled"), ("failed_other", "failed"))
    return ["metadata_state_mismatch" for source, target in pairs if statuses.get(source, 0) != counts[target]]


def observe(snapshot: Any, *, now: datetime | None = None, max_age_minutes: int = 30) -> dict:
    if not isinstance(snapshot, dict) or type(snapshot.get("schema_version")) is not int or snapshot["schema_version"] != 1:
        raise InvalidSnapshot("unsupported_snapshot")
    try:
        observed = datetime.fromisoformat(snapshot["observed_at"].replace("Z", "+00:00"))
    except (KeyError, AttributeError, TypeError, ValueError):
        raise InvalidSnapshot("invalid_observation_time") from None
    if observed.tzinfo is None:
        raise InvalidSnapshot("timezone_required")
    age = ((now or datetime.now(timezone.utc)) - observed).total_seconds()
    if age < -60 or age > max_age_minutes * 60:
        raise InvalidSnapshot("stale_or_future_snapshot")
    campaigns = collect_pages(snapshot.get("campaign_pages"), "emailer_campaigns")
    page_map, metadata = snapshot.get("message_pages"), snapshot.get("metadata_by_campaign")
    if not isinstance(page_map, dict) or not isinstance(metadata, dict):
        raise InvalidSnapshot("missing_campaign_observations")
    items = []
    for campaign in campaigns:
        if type(campaign.get("active")) is not bool:
            raise InvalidSnapshot("invalid_campaign_state")
        if not campaign["active"]:
            continue
        campaign_id = campaign["id"]
        rows = collect_pages(page_map.get(campaign_id), "emailer_messages")
        counts, reasons = message_counts(rows, campaign_id)
        issues = metadata_issues(metadata.get(campaign_id), counts)
        steps = campaign.get("emailer_steps")
        if not isinstance(steps, list) or not steps:
            issues.append("missing_sequence_steps")
            steps = []
        types = [s.get("type") if isinstance(s, dict) else None for s in steps]
        if any(not isinstance(t, str) or t not in {"auto_email", "manual_email"} for t in types):
            issues.append("unverified_step_type")
        if types and all(t == "manual_email" for t in types):
            issues.append("manual_email_steps")
        if counts["failed"]:
            issues.append("messages_failed")
        if counts["unconfirmed"]:
            issues.append("send_evidence_missing")
        if counts["total"] == 0:
            issues.append("no_message_records")
        # Names, recipients, bodies, message ids and unknown reasons are not emitted.
        items.append({"campaign_id": campaign_id, "counts": counts, "failure_reasons": reasons, "issues": sorted(set(issues))})
    return {"schema_version": 1, "mode": "observation_only", "observed_at": observed.isoformat(), "inactive_campaigns_not_scanned": len(campaigns) - len(items), "campaigns": items}


def runtime_preflight() -> dict:
    """Probe metadata only. An active gateway does not prove accessible inference."""
    result: dict[str, Any] = {
        "uid": os.geteuid(),
        "hermes_binary_present": shutil.which("hermes") is not None,
        "hermesctl_binary_present": shutil.which("hermesctl") is not None,
        "growth_profile_readable": os.access(PROFILE, os.R_OK | os.X_OK),
        "inference_verified": False,
        "issues": [],
    }
    systemctl = shutil.which("systemctl")
    if systemctl:
        try:
            proc = subprocess.run(
                [systemctl, "show", "hermes-gateway-growth.service", "-p", "ActiveState", "-p", "SubState", "-p", "User", "--no-pager"],
                capture_output=True, text=True, timeout=5, check=False,
            )
            fields = dict(line.split("=", 1) for line in proc.stdout.splitlines() if "=" in line)
            result["growth_service_running"] = proc.returncode == 0 and fields.get("ActiveState") == "active" and fields.get("SubState") == "running"
            result["growth_service_uses_hermes"] = fields.get("User") == "hermes"
        except (OSError, subprocess.TimeoutExpired):
            result["issues"].append("service_probe_failed")
    else:
        result["issues"].append("service_probe_unavailable")
    if not result["growth_profile_readable"]:
        result["issues"].append("growth_profile_inaccessible")
    if not result["hermesctl_binary_present"]:
        result["issues"].append("hermesctl_unavailable")
    result["issues"].append("inference_not_tested")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--snapshot", help="private JSON file, or - for stdin")
    source.add_argument("--runtime-only", action="store_true")
    parser.add_argument("--probe-runtime", action="store_true")
    args = parser.parse_args()
    try:
        report: dict = {"mode": "observation_only"}
        if args.snapshot:
            if args.snapshot == "-":
                data = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
            else:
                with Path(args.snapshot).open("rb") as handle:
                    data = handle.read(MAX_INPUT_BYTES + 1)
            if len(data) > MAX_INPUT_BYTES:
                raise InvalidSnapshot("snapshot_too_large")
            report = observe(json.loads(data))
        if args.probe_runtime or args.runtime_only:
            report["runtime"] = runtime_preflight()
        print(json.dumps(report, ensure_ascii=True, sort_keys=True))
        issues = [issue for campaign in report.get("campaigns", []) for issue in campaign["issues"]]
        issues.extend(report.get("runtime", {}).get("issues", []))
        return 2 if issues else 0
    except InvalidSnapshot as exc:
        print(json.dumps({"mode": "observation_only", "error": "invalid_snapshot", "reason": str(exc)}))
        return 2
    except (OSError, ValueError, RecursionError):
        # Do not echo exception details: filenames/provider bodies can contain PII.
        print(json.dumps({"mode": "observation_only", "error": "invalid_or_unreadable_snapshot"}))
        return 2


if __name__ == "__main__":
    sys.exit(main())
