import io
from pathlib import Path
import tarfile
import tempfile
import unittest
import uuid
from unittest.mock import patch

import bootstrap as b


def archive(entries):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w:gz", format=tarfile.USTAR_FORMAT) as out:
        for name, content, kind in entries:
            item = tarfile.TarInfo(name)
            item.type = kind
            item.mode = 0o700 if kind == tarfile.DIRTYPE else 0o400
            item.size = len(content) if kind == tarfile.REGTYPE else 0
            out.addfile(item, io.BytesIO(content) if item.isfile() else None)
    return stream.getvalue()


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.ids = {key: str(uuid.uuid4()) for key in ("preflight", "mission", "attempt")}
        self.entries = [("fixture", b"", tarfile.DIRTYPE),
                        ("fixture/empty", b"", tarfile.DIRTYPE),
                        ("fixture/file", b"known bytes", tarfile.REGTYPE)]
        self.data = archive(self.entries)
        self.expected = {"fixture": None, "fixture/empty": None,
                         "fixture/file": b.sha(b"known bytes")}

    def publish(self, data=None, expected=None):
        payload = self.data if data is None else data
        return b.publish(self.root, self.ids, payload,
                         b.sha(payload) if expected is None else expected, self.expected)

    def test_fresh_then_repeated_preserves_inode_without_reextracting(self):
        state, path = self.publish()
        self.assertEqual(state, "PUBLISHED")
        before = path.stat().st_ino
        with patch.object(b, "write_new", side_effect=AssertionError("reextraction")):
            state, repeated = self.publish()
        self.assertEqual(state, "EXACT_MATCH_REUSABLE")
        self.assertEqual(repeated.stat().st_ino, before)
        self.assertTrue((path / "fixture/empty").is_dir())

    def test_existing_wrong_destination_untouched(self):
        destination = self.root / self.ids["preflight"]
        destination.mkdir(mode=0o700)
        marker = destination / "keep"
        marker.write_bytes(b"preserve")
        with self.assertRaisesRegex(b.Blocked, "MISMATCH_BLOCK"):
            self.publish()
        self.assertEqual(marker.read_bytes(), b"preserve")

    def test_corrupt_archive_preserved_unpublished(self):
        with self.assertRaises(b.Blocked):
            self.publish(b"not a tar")
        destination = self.root / self.ids["preflight"]
        self.assertFalse(any((destination / "published").iterdir()))
        self.assertEqual(len(list((destination / "failed").iterdir())), 1)
        self.assertTrue(list((destination / "manifest").glob("*.failed.json")))

    def test_changed_published_content_blocks(self):
        _, path = self.publish()
        target = path / "fixture/file"
        target.chmod(0o600)
        target.write_bytes(b"changed")
        target.chmod(0o400)
        with self.assertRaisesRegex(b.Blocked, "MISMATCH_BLOCK"):
            self.publish()

    def test_invalid_hash(self):
        with self.assertRaisesRegex(b.Blocked, "hash_format_invalid"):
            self.publish(expected="a" * 68)

    def test_digest_mismatch(self):
        with self.assertRaisesRegex(b.Blocked, "archive_hash_invalid"):
            self.publish(expected="0" * 64)

    def test_traversal_and_link_types(self):
        for name, kind in (("../escape", tarfile.REGTYPE),
                           ("/absolute", tarfile.REGTYPE),
                           ("link", tarfile.SYMTYPE), ("hard", tarfile.LNKTYPE),
                           ("fifo", tarfile.FIFOTYPE), ("device", tarfile.CHRTYPE)):
            with self.subTest(name=name):
                data = archive([(name, b"", kind)])
                with self.assertRaises(b.Blocked):
                    b.archive_files(data, b.sha(data))

    def test_missing_parents_rejected(self):
        data = archive([("a/b/file", b"x", tarfile.REGTYPE)])
        with self.assertRaisesRegex(b.Blocked, "archive_parent_missing"):
            b.archive_files(data, b.sha(data))

    def test_atomic_rename_never_overwrites(self):
        first, second = self.root / "first", self.root / "second"
        first.mkdir()
        second.mkdir()
        with self.assertRaises(b.Blocked):
            b.rename_new(first, second)
        self.assertTrue(first.exists())
        self.assertTrue(second.exists())

    def test_destination_symlink_rejected(self):
        (self.root / self.ids["preflight"]).symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(b.Blocked, "MISMATCH_BLOCK"):
            self.publish()

    def test_interrupted_publication_is_not_reused(self):
        original = b.write_new
        def interrupted(path, data):
            if path.name == "success.json":
                raise OSError("simulated")
            original(path, data)
        with patch.object(b, "write_new", side_effect=interrupted):
            with self.assertRaises(OSError):
                self.publish()
        with self.assertRaisesRegex(b.Blocked, "MISMATCH_BLOCK"):
            self.publish()
        self.assertFalse(any((self.root / self.ids["preflight"] / "published").iterdir()))

    def test_archive_duplicate_rejected(self):
        data = archive(self.entries + [self.entries[-1]])
        with self.assertRaisesRegex(b.Blocked, "duplicate"):
            b.archive_files(data, b.sha(data))


if __name__ == "__main__":
    unittest.main()
