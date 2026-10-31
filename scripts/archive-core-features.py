"""Bind fresh package audits to frozen byte hashes, then verify ZIP members.

Run --freeze BEFORE running the three package audits in a fresh report directory.
Run without --freeze after the audits pass. This proves byte correspondence,
assuming trusted local audit reports, and does not authenticate audit evidence.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import sys
import uuid
import zipfile

WORKSPACE = Path(__file__).resolve().parents[1]
AUDITS = ("final-package-correspondence.json", "final-package-boundaries.json", "package-privacy.json")
FROZEN = "frozen-package-inventory.json"
SOURCE_PREFIX = "source/ae-switch/"


class ArchiveFailure(Exception):
    """Fixed diagnostic labels only; no raw file or audit contents."""


def require(condition: bool, label: str) -> None:
    if not condition:
        raise ArchiveFailure(label)


def guard(value: Path, *, missing: bool = False) -> Path:
    # Check before resolving: resolving first would hide a redirected input.
    target = Path(os.path.abspath(value))
    require(target.drive.lower() == "g:" and target.is_relative_to(WORKSPACE),
            "archive_paths_must_stay_in_g_workspace")
    for ancestor in (target, *target.parents):
        try:
            metadata = ancestor.lstat()
        except FileNotFoundError:
            require(missing, "required_archive_path_missing")
            continue
        require(not stat.S_ISLNK(metadata.st_mode)
                and not getattr(metadata, "st_file_attributes", 0) & 0x400,
                "redirected_archive_path_rejected")
        require(os.path.normcase(os.path.realpath(ancestor)) == os.path.normcase(str(ancestor)),
                "noncanonical_archive_path_rejected")
    return target


def sha256_file(path: Path) -> str:
    with guard(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def load_json(path: Path) -> tuple[dict, str]:
    try:
        content = guard(path).read_bytes()
        value = json.loads(content.decode("utf-8-sig"))
    except (ValueError, UnicodeError):
        raise ArchiveFailure("invalid_archive_evidence_json") from None
    require(isinstance(value, dict), "archive_evidence_object_required")
    return value, hashlib.sha256(content).hexdigest()


def write_json_new(path: Path, value: dict) -> None:
    guard(path, missing=True)
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def member_name(value: str) -> str:
    require(isinstance(value, str) and value and "\\" not in value and "\x00" not in value,
            "invalid_package_member_name")
    path = PurePosixPath(value)
    require(not path.is_absolute() and ".." not in path.parts and ":" not in value
            and str(path) == value, "invalid_package_member_name")
    return value


def tree_inventory(package: Path) -> dict[str, dict]:
    package = guard(package)
    require(package.is_dir(), "package_directory_required")
    result, folded, pending = {}, set(), [package]
    while pending:
        for path in sorted(guard(pending.pop()).iterdir()):
            path = guard(path)
            metadata = path.lstat()
            if stat.S_ISDIR(metadata.st_mode):
                pending.append(path)
                continue
            require(stat.S_ISREG(metadata.st_mode), "nonordinary_package_entry")
            name = member_name(path.relative_to(package).as_posix())
            require(name.casefold() not in folded, "duplicate_package_member_name")
            folded.add(name.casefold())
            before = (metadata.st_size, metadata.st_mtime_ns, metadata.st_ino)
            digest = sha256_file(path)
            after = guard(path).lstat()
            require(before == (after.st_size, after.st_mtime_ns, after.st_ino),
                    "package_changed_during_inventory")
            result[name] = {"bytes": after.st_size, "sha256": digest}
    require(bool(result), "empty_package_rejected")
    return dict(sorted(result.items()))


def inventory_digest(inventory: dict) -> str:
    payload = json.dumps(inventory, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def timestamp(value: object) -> datetime:
    require(isinstance(value, str), "audit_timestamp_required")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise ArchiveFailure("invalid_audit_timestamp") from None
    require(parsed.tzinfo is not None, "audit_timestamp_timezone_required")
    return parsed.astimezone(timezone.utc)


def freeze(package: Path, reports: Path) -> dict:
    require(not any((reports / name).exists() for name in (*AUDITS, FROZEN)),
            "freeze_requires_fresh_reports_before_audits")
    inventory = tree_inventory(package)
    require(tree_inventory(package) == inventory, "package_changed_during_freeze")
    receipt = {"schemaVersion": 1, "packageDirectory": str(package),
               "frozenAt": datetime.now(timezone.utc).isoformat(),
               "inventoryDigest": inventory_digest(inventory), "files": inventory}
    write_json_new(reports / FROZEN, receipt)
    return {"passed": True, "phase": "freeze", "files": len(inventory),
            "inventoryDigest": receipt["inventoryDigest"], "auditsRequiredAfterFreeze": True}


def validate_evidence(package: Path, reports: Path) -> tuple[dict, dict]:
    frozen, frozen_digest = load_json(reports / FROZEN)
    require(frozen.get("schemaVersion") == 1 and frozen.get("packageDirectory") == str(package),
            "frozen_package_binding_mismatch")
    inventory = frozen.get("files")
    require(isinstance(inventory, dict) and bool(inventory), "frozen_inventory_required")
    for name, entry in inventory.items():
        member_name(name)
        require(isinstance(entry, dict) and set(entry) == {"bytes", "sha256"}
                and isinstance(entry["bytes"], int) and entry["bytes"] >= 0
                and isinstance(entry["sha256"], str) and len(entry["sha256"]) == 64
                and all(ch in "0123456789abcdef" for ch in entry["sha256"]),
                "invalid_frozen_inventory_entry")
    require(inventory_digest(inventory) == frozen.get("inventoryDigest"),
            "frozen_inventory_digest_mismatch")
    require(tree_inventory(package) == inventory, "package_changed_since_freeze")
    frozen_at = timestamp(frozen.get("frozenAt"))
    bindings, values = {FROZEN: frozen_digest}, {}
    for name in AUDITS:
        report, report_digest = load_json(reports / name)
        require(report.get("passed") is True, "package_audit_must_pass")
        # Timestamp is only an auxiliary ordering check. Complete privacy-byte
        # inventory equality below is the substantive audit-to-package binding.
        require(timestamp(report.get("recordedAt")) >= frozen_at, "package_audit_predates_freeze")
        if name != "package-privacy.json":
            require(report.get("packageDirectory") == str(package), "audit_package_binding_mismatch")
            for field, executable in (("desktopSha256", "AE-Switch.exe"), ("cliSha256", "AE-Switch-core.exe")):
                require(executable in inventory and report.get(field) == inventory[executable]["sha256"],
                        "audit_executable_binding_mismatch")
        values[name] = report
        bindings[name] = report_digest
    privacy_inventory = values["package-privacy.json"].get("inventory")
    require(isinstance(privacy_inventory, list), "complete_privacy_inventory_required")
    prefix = package.relative_to(WORKSPACE).as_posix() + "/"
    audited = {}
    for entry in privacy_inventory:
        require(isinstance(entry, dict) and isinstance(entry.get("path"), str),
                "invalid_privacy_inventory_entry")
        if not entry["path"].startswith(prefix):
            continue
        relative = entry["path"][len(prefix):]
        # The privacy scanner additionally inventories decompressed members.
        # Those virtual entries are not ordinary package files; their parent
        # archive's raw bytes must still be present and match the frozen set.
        if "!/" in relative:
            continue
        member_name(relative)
        require(relative not in audited, "duplicate_privacy_inventory_entry")
        audited[relative] = {"bytes": entry.get("bytes"), "sha256": entry.get("sha256")}
    require(audited == inventory, "privacy_inventory_does_not_match_frozen_package")
    return inventory, bindings


def verify_evidence_unchanged(reports: Path, bindings: dict) -> None:
    require(all(sha256_file(reports / name) == digest for name, digest in bindings.items()),
            "audit_evidence_changed_during_archive")


def make_archive(base: Path, prefix: str, items: dict, temporary: Path) -> dict:
    guard(temporary, missing=True)
    with zipfile.ZipFile(temporary, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as writer:
        for relative, expected in sorted(items.items()):
            source = guard(base / relative)
            digest, size = hashlib.sha256(), 0
            info = zipfile.ZipInfo.from_file(source, prefix + "/" + relative)
            info.compress_type = zipfile.ZIP_DEFLATED
            with source.open("rb") as reader, writer.open(info, "w", force_zip64=True) as destination:
                while chunk := reader.read(4 * 1024 * 1024):
                    size += len(chunk)
                    digest.update(chunk)
                    destination.write(chunk)
            require(size == expected["bytes"] and digest.hexdigest() == expected["sha256"],
                    "package_changed_while_writing_archive")
    with zipfile.ZipFile(guard(temporary)) as reader:
        entries = reader.infolist()
        require(len(entries) == len(items) == len({entry.filename for entry in entries}),
                "archive_member_set_mismatch")
        for entry in entries:
            require(entry.filename.startswith(prefix + "/"), "archive_member_prefix_mismatch")
            relative = member_name(entry.filename[len(prefix) + 1:])
            require(relative in items and entry.file_size == items[relative]["bytes"],
                    "archive_member_size_mismatch")
            with reader.open(entry) as stream:
                require(hashlib.file_digest(stream, "sha256").hexdigest() == items[relative]["sha256"],
                        "archive_member_hash_mismatch")
    return {"bytes": temporary.stat().st_size, "sha256": sha256_file(temporary),
            "verifiedEntries": len(items), "passed": True}


def archive(package: Path, reports: Path) -> dict:
    require(not (reports / "archive-verification.json").exists(), "fresh_archive_receipt_required")
    inventory, bindings = validate_evidence(package, reports)
    source_items = {name[len(SOURCE_PREFIX):]: entry for name, entry in inventory.items()
                    if name.startswith(SOURCE_PREFIX)}
    require(bool(source_items), "source_archive_input_required")
    portable_name = package.name + ".zip"
    source_name = package.name.replace("portable-win-x64", "source") + ".zip"
    require(source_name != portable_name, "package_name_must_identify_portable_win_x64")
    plans = [(package, package.name, inventory, package.parent / portable_name),
             (package / "source/ae-switch", "ae-switch", source_items, package.parent / source_name)]
    for _, _, _, output in plans:
        guard(output, missing=True)
        require(not output.exists(), "archive_output_already_exists")
    sums_paths = (reports / "SHA256SUMS.txt", package.parent / (package.name + "-SHA256SUMS.txt"))
    require(not any(path.exists() for path in sums_paths), "fresh_checksum_outputs_required")
    staged = []
    try:
        for base, prefix, items, output in plans:
            temporary = output.with_name(output.name + ".partial-" + uuid.uuid4().hex)
            # Track before writing, so a rejected write leaves no partial ZIP.
            staged.append((temporary, output, None))
            result = make_archive(base, prefix, items, temporary)
            staged[-1] = (temporary, output, result)
        require(tree_inventory(package) == inventory, "package_changed_before_archive_publication")
        verify_evidence_unchanged(reports, bindings)
        results = []
        for temporary, output, result in staged:
            guard(output, missing=True)
            require(not output.exists(), "archive_output_appeared_during_write")
            temporary.rename(output)
            results.append({"file": output.name, **result})
        receipt = {"passed": True,
                   "scope": "Every ZIP member equals pre-audit frozen bytes and the complete passing privacy audit inventory",
                   "inventoryDigest": inventory_digest(inventory), "evidenceSha256": bindings,
                   "limitations": ["Trusted local audit reports are assumed; byte binding does not authenticate evidence.",
                                   "Byte equality does not prove official client or upstream acceptance."],
                   "archives": results}
        write_json_new(reports / "archive-verification.json", receipt)
        sums = "".join(item["sha256"] + "  " + item["file"] + "\n" for item in results)
        for output in sums_paths:
            guard(output, missing=True)
            with output.open("x", encoding="utf-8", newline="\n") as stream:
                stream.write(sums)
        return receipt
    finally:
        for temporary, _, _ in staged:
            if temporary.exists():
                guard(temporary).unlink()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", required=True, type=Path)
    parser.add_argument("--report-directory", required=True, type=Path)
    parser.add_argument("--freeze", action="store_true", help="Create byte baseline before fresh package audits")
    options = parser.parse_args()
    package, reports = guard(options.package), guard(options.report_directory, missing=True)
    require(package != WORKSPACE and reports != WORKSPACE and not reports.is_relative_to(package),
            "package_and_report_directories_must_be_separate")
    reports.mkdir(parents=True, exist_ok=True)
    result = freeze(package, reports) if options.freeze else archive(package, reports)
    print(json.dumps({key: result[key] for key in ("passed", "phase", "files", "inventoryDigest", "archives")
                      if key in result}, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ArchiveFailure as error:
        print(json.dumps({"passed": False, "reason": str(error)}), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print(json.dumps({"passed": False, "reason": "archive_operation_failed_raw_details_suppressed"}), file=sys.stderr)
        sys.exit(1)
