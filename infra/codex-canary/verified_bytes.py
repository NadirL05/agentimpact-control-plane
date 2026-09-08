"""Verify and compile one byte buffer. Never reopen a launcher after checking."""
import hashlib
import hmac
from pathlib import Path
import re


def prepare(path, expected):
    if not isinstance(expected, str) or re.fullmatch(r"[0-9a-f]{64}", expected) is None:
        raise ValueError("expected_hash_invalid")
    source = Path(path).read_bytes()
    if not hmac.compare_digest(hashlib.sha256(source).hexdigest(), expected):
        raise ValueError("launcher_hash_mismatch")
    return compile(source, str(path), "exec")
