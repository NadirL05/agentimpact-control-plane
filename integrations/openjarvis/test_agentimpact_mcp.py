import io
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
import agentimpact_mcp as adapter


class FakeResponse:
    def __init__(self, payload): self.payload = payload
    def __enter__(self): return self
    def __exit__(self, *_): return None
    def read(self, _): return json.dumps(self.payload).encode()


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        token = Path(self.temp.name) / "operator.env"
        token.write_text("CTL_OPERATOR_TOKEN=" + "a" * 64 + "\n")
        token.chmod(stat.S_IRUSR | stat.S_IWUSR)
        os.environ["AGENTIMPACT_OPERATOR_TOKEN_FILE"] = str(token)
        os.environ["AGENTIMPACT_OPERATOR_API_URL"] = "http://10.66.66.1:3443"
        os.environ["AGENTIMPACT_CONFIRMATION_DIR"] = str(Path(self.temp.name) / "confirmations")

    def tearDown(self): self.temp.cleanup()

    def test_lists_only_explicit_typed_tools(self):
        result, error = adapter.handle({"method": "tools/list"})
        self.assertIsNone(error)
        names = {item["name"] for item in result["tools"]}
        self.assertIn("agentimpact.missions.create", names)
        self.assertIn("agentimpact.deploy.execute", names)
        self.assertNotIn("agentimpact.approvals.approve", names)
        self.assertNotIn("shell_exec", names)
        self.assertTrue(all(item["inputSchema"]["additionalProperties"] is False for item in result["tools"]))

    @patch("urllib.request.urlopen")
    def test_signs_fixed_operator_endpoint_without_token_in_body(self, urlopen):
        urlopen.return_value = FakeResponse({"ok": True, "status": "completed"})
        result = adapter.call_agentimpact("agentimpact.health", {})
        self.assertTrue(result["ok"])
        request = urlopen.call_args.args[0]
        body = request.data.decode()
        self.assertNotIn("a" * 64, body)
        self.assertEqual(request.full_url, "http://10.66.66.1:3443/api/v2/operator/actions")
        self.assertTrue(request.headers["X-agentimpact-signature"].startswith("v1="))

    def test_refuses_plaintext_public_endpoint(self):
        os.environ["AGENTIMPACT_OPERATOR_API_URL"] = "http://example.com"
        with self.assertRaisesRegex(RuntimeError, "private_ip"):
            adapter._api_url()

    @patch("urllib.request.urlopen")
    def test_destructive_tool_requires_exact_one_shot_confirmation(self, urlopen):
        urlopen.return_value = FakeResponse({"ok": True, "status": "accepted"})
        arguments = {"mission_id": "00000000-0000-4000-8000-000000000001", "reason": "operator requested"}
        with self.assertRaisesRegex(RuntimeError, "local_confirmation_required"):
            adapter.call_agentimpact("agentimpact.missions.cancel", arguments)
        adapter.write_confirmation("agentimpact.missions.cancel", arguments)
        self.assertTrue(adapter.call_agentimpact("agentimpact.missions.cancel", arguments)["ok"])
        with self.assertRaisesRegex(RuntimeError, "local_confirmation_required"):
            adapter.call_agentimpact("agentimpact.missions.cancel", arguments)


if __name__ == "__main__": unittest.main()
