"""Lifecycle for synthetic Python acceptance fixtures created by this process."""

import json
import os
from pathlib import Path
import stat
from uuid import uuid4


WORKSPACE = Path(__file__).absolute().parents[2]
FIXTURES = {
    "local-synthetic-cli-fixtures": ".cache/core-features-cli-e2e",
    "compiled-core-activity-http-fixture": ".cache/core-activity-http-e2e",
    "codex-native-model-switch-e2e": ".cache/codex-native-model-switch-e2e",
}
_owned = {}


def _extended(path: Path) -> Path:
    return Path("\\\\?\\" + str(path))


def _ordinary(path: Path, *, directory: bool) -> os.stat_result:
    metadata = _extended(path).lstat()
    matches = stat.S_ISDIR if directory else stat.S_ISREG
    if (not matches(metadata.st_mode)
            or getattr(metadata, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
            or not directory and metadata.st_nlink != 1):
        raise ValueError("fixture_path_not_ordinary")
    return metadata


def _directory(path: Path, *, create: bool = False) -> Path:
    path = path.absolute()
    if path.drive.lower() != "g:" or ".." in path.parts:
        raise ValueError("fixture_path_must_be_on_g")
    for ancestor in (*reversed(path.parents), path):
        try:
            _ordinary(ancestor, directory=True)
        except FileNotFoundError:
            if not create:
                raise
            _extended(ancestor).mkdir(exist_ok=True)
            _ordinary(ancestor, directory=True)
    return path


def create_owned_fixture(workspace: Path, purpose: str) -> tuple[Path, str]:
    workspace = _directory(workspace)
    if not workspace.is_relative_to(_directory(WORKSPACE)):
        raise ValueError("fixture_workspace_mismatch")
    parent = _directory(workspace / FIXTURES[purpose], create=True)
    owner_id = uuid4().hex
    root = parent / owner_id
    _extended(root).mkdir()
    marker = root / "owner.json"
    content = {
        "ownerId": owner_id,
        "processId": os.getpid(),
        "purpose": purpose,
    }
    if purpose == "local-synthetic-cli-fixtures":
        content["schema"] = "ae-switch-core-features-cli-e2e-v1"
    with _extended(marker).open("x", encoding="utf-8") as output:
        json.dump(content, output)
    _owned[root] = (purpose, _extended(marker).read_bytes())
    return root, owner_id


def _check_marker(marker: Path, expected: bytes) -> None:
    _ordinary(marker, directory=False)
    if _extended(marker).read_bytes() != expected:
        raise ValueError("fixture_owner_marker_changed")


def _unlink_owned_file(path: Path, marker: Path, expected_marker: bytes) -> None:
    _directory(path.parent)
    original = _ordinary(path, directory=False)
    file = _extended(path)
    try:
        file.unlink()
        return
    except PermissionError as error:
        # DeleteFile reports access denied for Windows read-only files. Other
        # permissions errors must propagate without changing attributes.
        if (getattr(error, "winerror", None) != 5
                or not original.st_file_attributes & stat.FILE_ATTRIBUTE_READONLY):
            raise

    _check_marker(marker, expected_marker)
    _directory(path.parent)
    current = _ordinary(path, directory=False)
    if (current.st_dev, current.st_ino, current.st_file_attributes) != (
            original.st_dev, original.st_ino, original.st_file_attributes):
        raise ValueError("fixture_read_only_file_changed")

    # On Windows chmod only changes the read-only attribute. Refuse links at
    # open time as well as during the ordinary/single-link stat checks.
    os.chmod(file, stat.S_IWRITE, follow_symlinks=False)
    changed = _ordinary(path, directory=False)
    expected_attributes = (original.st_file_attributes & ~stat.FILE_ATTRIBUTE_READONLY
                           or stat.FILE_ATTRIBUTE_NORMAL)
    if (changed.st_dev, changed.st_ino, changed.st_file_attributes) != (
            original.st_dev, original.st_ino, expected_attributes):
        raise ValueError("fixture_read_only_change_unexpected")
    file.unlink()


def cleanup_owned_fixture(root: Path, owner_id: str, purpose: str) -> None:
    """Call after test children exit. A previous invocation is never eligible."""
    root = _directory(root)
    marker = root / "owner.json"
    registration = _owned.get(root)
    if registration is None or root.name != owner_id or registration[0] != purpose:
        raise ValueError("fixture_owner_mismatch")
    _check_marker(marker, registration[1])
    # Inspect the complete tree before the first unlink, including Windows junctions.
    files, directories = [], [root]
    for directory in directories:
        for name in os.listdir(_extended(directory)):
            entry = directory / name
            if entry == marker:
                continue
            if stat.S_ISDIR(_extended(entry).lstat().st_mode):
                _ordinary(entry, directory=True)
                directories.append(entry)
            else:
                _ordinary(entry, directory=False)
                files.append(entry)
    for file in files:
        _unlink_owned_file(file, marker, registration[1])
    for directory in reversed(directories[1:]):
        _extended(_directory(directory)).rmdir()
    _check_marker(marker, registration[1])
    if os.listdir(_extended(root)) != [marker.name]:
        raise ValueError("fixture_owner_tree_changed")
    _unlink_owned_file(marker, marker, registration[1])
    _extended(root).rmdir()
    if _extended(root).exists():
        raise OSError("fixture_root_still_present")
    del _owned[root]


def fresh_receipt_path(path: Path) -> Path:
    path = path.absolute()
    receipt_root = _directory(WORKSPACE) / "artifacts/acceptance"
    if not path.is_relative_to(receipt_root) or path.suffix != ".json" or ".." in path.parts:
        raise ValueError("receipt_outside_acceptance_directory")
    _directory(path.parent, create=True)
    try:
        _extended(path).lstat()
    except FileNotFoundError:
        return path
    raise FileExistsError("receipt_already_exists")


def write_receipt(path: Path, value: object) -> None:
    payload = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    with _extended(fresh_receipt_path(path)).open("x", encoding="utf-8") as output:
        output.write(payload)
