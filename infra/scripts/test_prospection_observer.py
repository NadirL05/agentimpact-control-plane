#!/usr/bin/env python3
"""Synthetic tests: no Apollo connection, inference, credentials or real data."""

from __future__ import annotations

import copy
import json
import subprocess
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import prospection_observer as observer

CAMPAIGN = "a" * 24
OTHER = "b" * 24
NOW = datetime(2026, 10, 20, 8, tzinfo=timezone.utc)


def page(key: str, rows: list, number=1, total=None, last=1) -> dict:
    return {key: rows, "pagination": {"page": number, "total_entries": len(rows) if total is None else total, "total_pages": last}}


def snapshot() -> dict:
    rows = [
        {"id": "1" * 24, "emailer_campaign_id": CAMPAIGN, "status": "completed", "delivered": True},
        {"id": "2" * 24, "emailer_campaign_id": CAMPAIGN, "status": "scheduled"},
        {"id": "3" * 24, "emailer_campaign_id": CAMPAIGN, "status": "failed", "not_sent_reason": "ai_variable_generation_failed"},
    ]
    return {
        "schema_version": 1,
        "observed_at": NOW.isoformat(),
        "campaign_pages": [page("emailer_campaigns", [{"id": CAMPAIGN, "active": True, "emailer_steps": [{"type": "auto_email"}]}])],
        "message_pages": {CAMPAIGN: [page("emailer_messages", rows)]},
        "metadata_by_campaign": {CAMPAIGN: {"total_count": 3, "status_counts": [
            {"status": "sent", "count": 1}, {"status": "delivered", "count": 1},
            {"status": "scheduled", "count": 1}, {"status": "failed_other", "count": 1},
        ]}},
    }


class ObserverTest(unittest.TestCase):
    def observe(self, data=None):
        return observer.observe(snapshot() if data is None else data, now=NOW)

    def test_delivered_is_one_send_not_two(self):
        campaign = self.observe()["campaigns"][0]
        counts = campaign["counts"]
        self.assertEqual((counts["confirmed_sent"], counts["delivered"], counts["total"]), (1, 1, 3))
        self.assertEqual(sum(counts[k] for k in ("delivered", "sent_only", "failed", "scheduled", "unconfirmed")), 3)
        self.assertEqual(campaign["failure_reasons"], {"ai_variable_generation_failed": 1})
        self.assertEqual(campaign["issues"], ["messages_failed"])

    def test_completed_without_delivery_evidence_is_not_sent(self):
        data = snapshot()
        del data["message_pages"][CAMPAIGN][0]["emailer_messages"][0]["delivered"]
        item = self.observe(data)["campaigns"][0]
        self.assertEqual(item["counts"]["confirmed_sent"], 0)
        self.assertIn("send_evidence_missing", item["issues"])
        self.assertIn("metadata_state_mismatch", item["issues"])

    def test_active_manual_campaign_with_no_messages_is_blocked(self):
        data = snapshot()
        data["campaign_pages"][0]["emailer_campaigns"][0]["emailer_steps"] = [{"type": "manual_email"}]
        data["message_pages"][CAMPAIGN] = [page("emailer_messages", [], last=0)]
        data["metadata_by_campaign"][CAMPAIGN] = {"total_count": 0, "status_counts": []}
        self.assertEqual(self.observe(data)["campaigns"][0]["issues"], ["manual_email_steps", "no_message_records"])

    def test_incomplete_pages_are_rejected(self):
        data = snapshot()
        data["message_pages"][CAMPAIGN][0]["pagination"].update(total_pages=2, total_entries=4)
        with self.assertRaisesRegex(observer.InvalidSnapshot, "incomplete_pages"):
            self.observe(data)

    def test_multipage_string_counters_are_supported(self):
        data = snapshot()
        rows = data["message_pages"][CAMPAIGN][0]["emailer_messages"]
        data["message_pages"][CAMPAIGN] = [page("emailer_messages", rows[:2], "1", "3", "2"), page("emailer_messages", rows[2:], "2", "3", "2")]
        self.assertEqual(self.observe(data)["campaigns"][0]["counts"]["total"], 3)

    def test_duplicates_cannot_inflate_totals(self):
        data = snapshot()
        rows = data["message_pages"][CAMPAIGN][0]["emailer_messages"]
        rows[1] = copy.deepcopy(rows[0])
        with self.assertRaisesRegex(observer.InvalidSnapshot, "duplicate_record"):
            self.observe(data)

    def test_changed_pagination_is_rejected(self):
        data = snapshot()
        rows = data["message_pages"][CAMPAIGN][0]["emailer_messages"]
        data["message_pages"][CAMPAIGN] = [page("emailer_messages", rows[:2], 1, 3, 2), page("emailer_messages", rows[2:], 2, 4, 2)]
        with self.assertRaisesRegex(observer.InvalidSnapshot, "pagination_changed"):
            self.observe(data)

    def test_cross_campaign_message_is_rejected(self):
        data = snapshot()
        data["message_pages"][CAMPAIGN][0]["emailer_messages"][0]["emailer_campaign_id"] = OTHER
        with self.assertRaisesRegex(observer.InvalidSnapshot, "message_campaign_mismatch"):
            self.observe(data)

    def test_invalid_flags_and_contradictory_states_are_rejected(self):
        for flag, status in (("false", "completed"), (True, "failed")):
            data = snapshot()
            data["message_pages"][CAMPAIGN][0]["emailer_messages"][0].update(delivered=flag, status=status)
            with self.subTest(flag=flag, status=status), self.assertRaises(observer.InvalidSnapshot):
                self.observe(data)

    def test_stale_future_and_naive_times_are_rejected(self):
        for timestamp in ((NOW - timedelta(minutes=31)).isoformat(), (NOW + timedelta(minutes=2)).isoformat(), "2026-10-20T08:00:00"):
            data = snapshot()
            data["observed_at"] = timestamp
            with self.subTest(timestamp=timestamp), self.assertRaises(observer.InvalidSnapshot):
                self.observe(data)

    def test_provider_metadata_disagreement_remains_visible(self):
        data = snapshot()
        data["metadata_by_campaign"][CAMPAIGN]["total_count"] = 4
        self.assertIn("metadata_total_mismatch", self.observe(data)["campaigns"][0]["issues"])

    def test_connector_envelopes_and_unknown_step_types(self):
        data = snapshot()
        data["campaign_pages"][0]["emailer_campaigns"][0]["emailer_steps"][0]["type"] = {"unexpected": "object"}
        data["campaign_pages"][0] = {"content": [{"type": "text", "text": json.dumps(data["campaign_pages"][0])}]}
        data["message_pages"][CAMPAIGN][0] = {"structuredContent": data["message_pages"][CAMPAIGN][0]}
        self.assertIn("unverified_step_type", self.observe(data)["campaigns"][0]["issues"])

    def test_personal_data_and_unknown_error_bodies_do_not_leave_report(self):
        data = snapshot()
        secret = "SYNTHETIC_PRIVATE_VALUE person@example.invalid"
        data["campaign_pages"][0]["emailer_campaigns"][0]["name"] = secret
        for row in data["message_pages"][CAMPAIGN][0]["emailer_messages"]:
            row.update(email=secret, body=secret, not_sent_reason=secret)
        output = json.dumps(self.observe(data))
        self.assertNotIn(secret, output)
        self.assertNotIn("1" * 24, output)
        self.assertEqual(self.observe(data)["campaigns"][0]["failure_reasons"], {"other": 1})

    def test_running_gateway_does_not_prove_usable_profile(self):
        proc = subprocess.CompletedProcess([], 0, "User=hermes\nActiveState=active\nSubState=running\n", "")
        with patch.object(observer.os, "access", return_value=False), patch.object(observer.shutil, "which", side_effect=lambda name: None if name == "hermesctl" else "/usr/bin/" + name), patch.object(observer.subprocess, "run", return_value=proc):
            result = observer.runtime_preflight()
        self.assertTrue(result["growth_service_running"])
        self.assertFalse(result["inference_verified"])
        self.assertIn("growth_profile_inaccessible", result["issues"])

    def test_cli_failure_does_not_echo_private_input(self):
        script = Path(__file__).with_name("prospection_observer.py")
        proc = subprocess.run([sys.executable, str(script), "--snapshot", "-"], input='{"secret":"person@example.invalid",', capture_output=True, text=True, check=False)
        self.assertEqual(proc.returncode, 2)
        self.assertNotIn("person@", proc.stdout + proc.stderr)
        self.assertEqual(json.loads(proc.stdout)["error"], "invalid_or_unreadable_snapshot")


if __name__ == "__main__":
    unittest.main()
