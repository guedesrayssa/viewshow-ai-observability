#!/usr/bin/env python3
"""Create a private Terraform state backup using directory-relative opens."""

import json
import os
import stat
import sys


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def main():
    source_path, directory_path, target_name, identity_json = sys.argv[1:]
    expected = json.loads(identity_json)
    uid = os.getuid()
    directory_fd = source_fd = destination_fd = None
    try:
        directory_fd = os.open(
            directory_path,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
        )
        directory_stat = os.fstat(directory_fd)
        require(
            stat.S_ISDIR(directory_stat.st_mode)
            and directory_stat.st_uid == uid
            and stat.S_IMODE(directory_stat.st_mode) == 0o700
            and [directory_stat.st_dev, directory_stat.st_ino]
            == expected["directory"],
            "backup directory changed identity",
        )

        source_fd = os.open(source_path, os.O_RDONLY | os.O_NOFOLLOW)
        source_before = os.fstat(source_fd)
        require(
            stat.S_ISREG(source_before.st_mode)
            and source_before.st_uid == uid
            and source_before.st_nlink == 1
            and [source_before.st_dev, source_before.st_ino] == expected["source"],
            "state source changed identity",
        )

        destination_fd = os.open(
            target_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=directory_fd,
        )
        destination_before = os.fstat(destination_fd)
        require(
            stat.S_ISREG(destination_before.st_mode)
            and destination_before.st_uid == uid
            and destination_before.st_nlink == 1
            and stat.S_IMODE(destination_before.st_mode) == 0o600,
            "backup file is not private",
        )

        copied = bytearray()
        while True:
            block = os.read(source_fd, 1024 * 1024)
            if not block:
                break
            copied.extend(block)
            view = memoryview(block)
            while view:
                written = os.write(destination_fd, view)
                view = view[written:]

        state = json.loads(copied)
        require(
            state.get("lineage") == expected["lineage"]
            and state.get("serial") == expected["serial"],
            "state source version changed before backup",
        )

        os.fsync(destination_fd)
        source_after = os.fstat(source_fd)
        require(
            [source_before.st_dev, source_before.st_ino, source_before.st_size,
             source_before.st_mtime_ns, source_before.st_ctime_ns]
            == [source_after.st_dev, source_after.st_ino, source_after.st_size,
                source_after.st_mtime_ns, source_after.st_ctime_ns],
            "state source changed while it was copied",
        )
        os.fsync(directory_fd)
    finally:
        for descriptor in (destination_fd, source_fd, directory_fd):
            if descriptor is not None:
                os.close(descriptor)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.stderr.write(f"secure state backup failed: {error}\n")
        sys.exit(1)
