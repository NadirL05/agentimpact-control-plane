import hashlib
from pathlib import Path
import tempfile
import unittest

from verified_bytes import prepare


class VerifiedBytesTests(unittest.TestCase):
    def test_path_replacement_after_verification_does_not_change_executed_code(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "launcher.py"
            data = b"result = 'verified'\n"
            path.write_bytes(data)
            code = prepare(path, hashlib.sha256(data).hexdigest())
            path.write_bytes(b"raise AssertionError('replacement executed')\n")
            namespace = {}
            exec(code, namespace)
            self.assertEqual(namespace["result"], "verified")

    def test_bad_hash_rejected_before_any_execution(self):
        for invalid in ("a" * 68, "A" * 64, "a" * 63, "g" * 64, "a" * 64 + "\n"):
            with self.subTest(invalid=invalid):
                with self.assertRaisesRegex(ValueError, "expected_hash_invalid"):
                    prepare(Path("/does-not-exist"), invalid)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "launcher.py"
            path.write_bytes(b"raise AssertionError('must not execute')\n")
            with self.assertRaisesRegex(ValueError, "launcher_hash_mismatch"):
                prepare(path, "0" * 64)


if __name__ == "__main__":
    unittest.main()
