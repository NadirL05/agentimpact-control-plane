"""Offline-capable R8 archive publication. No subprocess, network or worker API.

Production callers must pin both this module and archive bytes before invocation.
The root argument is injectable for tests; production_root fixes the allowlist.
"""
import ctypes
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import tarfile
import uuid


class Blocked(RuntimeError):
    """Safe, constant diagnostic code only."""


def require(condition, code):
    if not condition:
        raise Blocked(code)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def rename_new(source, destination):
    """Linux renameat2 RENAME_NOREPLACE; no unsafe fallback."""
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int,
                       ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    result = rename(-100, os.fsencode(source), -100, os.fsencode(destination), 1)
    if result != 0:
        raise Blocked("atomic_rename_refused")
    sync_dir(source.parent)
    sync_dir(destination.parent)


def write_new(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400)
    try:
        with os.fdopen(fd, "wb", closefd=False) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(fd)
    finally:
        os.close(fd)


def directory(path, uid, gid):
    metadata = path.lstat()
    require(stat.S_ISDIR(metadata.st_mode) and metadata.st_uid == uid
            and metadata.st_gid == gid and stat.S_IMODE(metadata.st_mode) == 0o700,
            "directory_metadata_invalid")


def trusted_ancestors(path, uid):
    require(path.is_absolute() and path == Path(os.path.normpath(path)), "root_not_canonical")
    for ancestor in reversed((path, *path.parents)):
        info = ancestor.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid in (0, uid)
                and not info.st_mode & 0o022, "unsafe_root_ancestor")


def archive_files(data, expected_sha):
    require(re.fullmatch(r"[0-9a-f]{64}", expected_sha) is not None, "hash_format_invalid")
    require(len(data) <= 8 * 1024 * 1024 and sha(data) == expected_sha, "archive_hash_invalid")
    records = {}
    total = 0
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
            for member in archive:
                name = member.name
                require(len(records) < 2048 and len(name) <= 300, "archive_count_or_path_limit")
                require(re.fullmatch(r"[A-Za-z0-9_./-]+", name) is not None
                        and not name.startswith("/")
                        and all(part not in ("", ".", "..") for part in name.split("/")),
                        "archive_path_invalid")
                require(name not in records and not member.pax_headers,
                        "archive_duplicate_or_extended_metadata")
                require((member.isfile() or member.isdir()) and not member.mode & 0o7000,
                        "archive_type_or_mode_invalid")
                require(0 <= member.size <= 1024 * 1024, "archive_file_size_limit")
                total += member.size
                require(total <= 8 * 1024 * 1024, "archive_total_size_limit")
                if member.isdir():
                    require(member.size == 0, "archive_directory_size_invalid")
                    records[name] = None
                else:
                    stream = archive.extractfile(member)
                    require(stream is not None, "archive_file_unreadable")
                    content = stream.read(member.size + 1)
                    require(len(content) == member.size, "archive_truncated")
                    records[name] = content
    except (tarfile.TarError, EOFError, OSError) as error:
        raise Blocked("archive_format_invalid") from error
    require(bool(records), "archive_empty")
    for name in records:
        for parent in Path(name).parents:
            if str(parent) != ".":
                require(parent.as_posix() in records and records[parent.as_posix()] is None,
                        "archive_parent_missing")
    return records


def inventory(path, uid, gid):
    directory(path, uid, gid)
    result = {}
    for item in sorted(path.rglob("*")):
        info = item.lstat()
        name = item.relative_to(path).as_posix()
        require(info.st_uid == uid and info.st_gid == gid, "inventory_owner_invalid")
        if stat.S_ISDIR(info.st_mode):
            directory(item, uid, gid)
            result[name] = None
        else:
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                    and stat.S_IMODE(info.st_mode) == 0o400, "inventory_type_or_mode_invalid")
            result[name] = sha(item.read_bytes())
    return result


def manifest_read(path, uid, gid):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == uid
            and info.st_gid == gid and stat.S_IMODE(info.st_mode) == 0o400,
            "manifest_metadata_invalid")
    return json.loads(path.read_bytes())


def publish(root, ids, data, expected_sha, expected_inventory):
    """Repetition verifies every byte. A partial previous transaction blocks."""
    uid, gid = os.geteuid(), os.getegid()
    require(set(ids) == {"preflight", "mission", "attempt"}, "ids_invalid")
    for value in ids.values():
        require(str(uuid.UUID(value)) == value, "id_not_canonical")
    require(len(set(ids.values())) == 3, "ids_not_distinct")
    directory(root, uid, gid)
    destination = root / ids["preflight"]
    expected = {"version": 1, "ids": ids, "archive_sha256": expected_sha,
                "inventory": expected_inventory}
    # The containing root is private; mkdir arbitrates competing publishers.
    try:
        destination.mkdir(mode=0o700)
    except FileExistsError:
        try:
            directory(destination, uid, gid)
            require(set(p.name for p in destination.iterdir()) ==
                    {"incoming", "extracting", "validated", "published", "failed", "manifest"},
                    "layout_mismatch")
            for name in ("incoming", "extracting", "validated", "published", "failed", "manifest"):
                directory(destination / name, uid, gid)
            saved = manifest_read(destination / "manifest/success.json", uid, gid)
            published = destination / "published/bundle"
            require(saved == {**expected, "inode": published.lstat().st_ino,
                              "device": published.lstat().st_dev}, "identity_mismatch")
            records = archive_files(data, expected_sha)
            require({k: None if v is None else sha(v) for k, v in records.items()} ==
                    expected_inventory, "archive_inventory_mismatch")
            require(inventory(published, uid, gid) == expected_inventory, "published_mismatch")
            require(inventory(destination / "incoming", uid, gid) ==
                    {"bundle.tar.gz": expected_sha}, "incoming_mismatch")
            require(all(not any((destination / name).iterdir()) for name in
                        ("extracting", "validated", "failed")), "partial_transaction_present")
            require(set(p.name for p in (destination / "manifest").iterdir()) == {"success.json"}
                    and set(p.name for p in (destination / "published").iterdir()) == {"bundle"},
                    "unexpected_published_file")
            return "EXACT_MATCH_REUSABLE", published
        except (OSError, ValueError, Blocked) as error:
            raise Blocked("MISMATCH_BLOCK") from error
    sync_dir(root)
    for name in ("incoming", "extracting", "validated", "published", "failed", "manifest"):
        (destination / name).mkdir(mode=0o700)
    nonce = str(uuid.uuid4())
    temporary = destination / "extracting" / nonce
    temporary.mkdir(mode=0o700)
    try:
        write_new(destination / "incoming/bundle.tar.gz", data)
        records = archive_files(data, expected_sha)
        require({k: None if v is None else sha(v) for k, v in records.items()} ==
                expected_inventory, "archive_inventory_mismatch")
        for name, content in sorted(records.items(), key=lambda entry: (entry[0].count("/"), entry[0])):
            target = temporary / name
            if content is None:
                target.mkdir(mode=0o700)
            else:
                write_new(target, content)
        require(inventory(temporary, uid, gid) == expected_inventory, "extracted_inventory_mismatch")
        for name, content in records.items():
            if content is None:
                sync_dir(temporary / name)
        sync_dir(temporary)
        validated = destination / "validated" / nonce
        rename_new(temporary, validated)
        temporary = validated
        published = destination / "published/bundle"
        rename_new(validated, published)
        temporary = published
        info = published.lstat()
        write_new(destination / "manifest/success.json",
                  canonical({**expected, "inode": info.st_ino, "device": info.st_dev}))
        sync_dir(destination / "manifest")
        return "PUBLISHED", published
    except Exception as error:
        if temporary.exists():
            rename_new(temporary, destination / "failed" / nonce)
        write_new(destination / "manifest" / (nonce + ".failed.json"), canonical({
            **expected, "error_type": type(error).__name__, "real_codex_calls": 0,
        }))
        sync_dir(destination / "manifest")
        raise


def production_root():
    require(os.geteuid() == 0 and os.getegid() == 0, "root_required")
    root = Path("/var/lib/agentimpact/deployments")
    trusted_ancestors(root, 0)
    directory(root, 0, 0)
    return root
