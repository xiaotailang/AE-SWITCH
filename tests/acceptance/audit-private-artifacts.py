"""Read-only known-private-value audit for G: artifacts and ZIP members.

Never prints private values or raw exception details. No archive is extracted.
Use explicit private input files; do not put credentials in command arguments.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
from datetime import datetime, timezone
import urllib.parse
import zipfile

WORKSPACE = Path(__file__).resolve().parents[2]
MAX_MEMBER_BYTES = 2 * 1024**3
MAX_ARCHIVE_BYTES = 12 * 1024**3


def guard(value, missing=False):
    target = Path(os.path.abspath(value))
    if target.drive.lower() != "g:" or not target.is_relative_to(WORKSPACE):
        raise ValueError("G workspace boundary")
    for ancestor in [target, *target.parents]:
        try:
            metadata = ancestor.lstat()
        except FileNotFoundError:
            if missing:
                continue
            raise
        if stat.S_ISLNK(metadata.st_mode) or getattr(metadata, "st_file_attributes", 0) & 0x400:
            raise ValueError("Redirected audit path")
        if os.path.normcase(os.path.realpath(ancestor)) != os.path.normcase(str(ancestor)):
            raise ValueError("Noncanonical audit path")
    return target


def variants(value):
    literal_forms = {
        value,
        json.dumps(value, ensure_ascii=True)[1:-1],
        json.dumps(value, ensure_ascii=False)[1:-1],
        value.replace("/", "\\/"),
        value.replace("\\", "\\\\"),
        urllib.parse.quote(value, safe=""),
        urllib.parse.quote(value, safe="/:"),
        base64.b64encode(value.encode("utf-8")).decode("ascii"),
        "".join("\\u%04x" % ord(character) for character in value),
        "".join("\\u%04X" % ord(character) for character in value),
    }
    literal_forms.update(json.dumps(form, ensure_ascii=False)[1:-1] for form in list(literal_forms))
    return {form.encode(encoding) for form in literal_forms if form for encoding in ["utf-8", "utf-16-le", "utf-16-be"]}


def private_patterns(inputs, public_endpoints=()):
    patterns = {}
    public_origins = {urllib.parse.urlsplit(value).scheme + "://" + urllib.parse.urlsplit(value).netloc for value in public_endpoints}
    keys, endpoints = set(), set()
    for filename in inputs:
        text = guard(filename).read_text(encoding="utf-8-sig")
        keys.update(item.strip().strip("\"'") for item in re.findall(r'(?im)["\']?api[-_ ]?key["\']?\s*[:：=]\s*["\']?([^\r\n"\']+)', text))
        keys.update(re.findall(r"\bsk-[A-Za-z0-9_-]{12,}", text))
        for item in re.findall(r'(?im)(?:端点|endpoint|base[_ -]?url)["\']?\s*[:：=]\s*["\']?(https?://[^\s"<>]+)', text):
            parsed = urllib.parse.urlsplit(item.rstrip(",;，；。"))
            if parsed.hostname:
                if parsed.scheme + "://" + parsed.netloc in public_origins and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment:
                    continue
                endpoints.update({item.rstrip(",;，；。/"), parsed.scheme + "://" + parsed.netloc, parsed.hostname})
    if not keys:
        raise ValueError("No designated known credentials")
    for category, values in [("known_key", keys), ("private_endpoint", endpoints), ("developer_path", {str(WORKSPACE), str(WORKSPACE).replace("\\", "/"), "\\\\?\\" + str(WORKSPACE)})]:
        for value in values:
            for pattern in variants(value):
                patterns[pattern] = category
    return patterns, len(keys), len(endpoints)


def audit_stream(stream, expression, patterns, tail_bytes):
    digest = hashlib.sha256()
    categories, previous, size = set(), b"", 0
    while chunk := stream.read(4 * 1024 * 1024):
        size += len(chunk)
        digest.update(chunk)
        combined = previous + chunk
        # UTF-16BE variants often begin with NUL. A large regex alternation
        # retries those branches at almost every zero byte in EXE/DLL files.
        # Native byte searches stay bounded per pattern, cover overlapping
        # matches, and avoid scanning a category again after it was detected.
        for pattern, category in patterns.items():
            if category not in categories and pattern in combined:
                categories.add(category)
        previous = combined[-tail_bytes:]
    return size, digest.hexdigest(), sorted(categories)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--private-input", action="append", required=True)
    parser.add_argument("--public-endpoint", action="append", default=[], help="Explicit already-public product service origin, excluded from endpoint findings only; keys remain scanned")
    parser.add_argument("--scan", action="append", required=True)
    parser.add_argument("--report", required=True)
    options = parser.parse_args()
    inputs = [guard(value) for value in options.private_input]
    scans = [guard(value) for value in options.scan]
    report_file = guard(options.report, missing=True)
    if report_file.exists():
        raise ValueError("Fresh audit report required")
    if any(target.is_dir() and report_file.is_relative_to(target) for target in scans):
        raise ValueError("Audit report cannot be inside a scanned directory")
    patterns, key_count, endpoint_count = private_patterns(inputs, options.public_endpoint)
    expression = re.compile(b"|".join(re.escape(value) for value in sorted(patterns, key=len, reverse=True)))
    tail_bytes = max(map(len, patterns)) - 1
    findings, inventory, archives = [], [], []

    def safe_name(value):
        body = str(value).encode("utf-8")
        return expression.sub(b"<redacted>", body).decode("utf-8", errors="replace")

    def record(stream, name):
        size, digest, categories = audit_stream(stream, expression, patterns, tail_bytes)
        inventory.append({"path": safe_name(name), "bytes": size, "sha256": digest})
        if categories:
            findings.append({"path": safe_name(name), "categories": categories})

    def scan_file(filename):
        filename = guard(filename)
        name = filename.relative_to(WORKSPACE).as_posix()
        with filename.open("rb") as stream:
            record(stream, name)
        if zipfile.is_zipfile(filename):
            with zipfile.ZipFile(filename) as archive:
                total = sum(member.file_size for member in archive.infolist())
                if total > MAX_ARCHIVE_BYTES:
                    raise ValueError("Archive exceeds audit budget")
                count = 0
                for member in archive.infolist():
                    member_name = PurePosixPath(member.filename.replace("\\", "/"))
                    mode = member.external_attr >> 16
                    if member_name.is_absolute() or ".." in member_name.parts or stat.S_ISLNK(mode):
                        raise ValueError("Unsafe archive member")
                    if member.is_dir():
                        continue
                    if member.file_size > MAX_MEMBER_BYTES:
                        raise ValueError("Archive member exceeds audit budget")
                    with archive.open(member) as stream:
                        record(stream, name + "!/" + member.filename)
                    count += 1
                archives.append({"path": safe_name(name), "membersScanned": count, "uncompressedBytes": total})

    for target in scans:
        if target.is_dir():
            pending = [target]
            while pending:
                current = guard(pending.pop())
                for entry in sorted(current.iterdir()):
                    entry = guard(entry)
                    if entry.is_dir():
                        pending.append(entry)
                    elif entry.is_file():
                        scan_file(entry)
                    else:
                        raise ValueError("Nonordinary artifact entry")
        elif target.is_file():
            scan_file(target)
        else:
            raise ValueError("Nonordinary scan input")
    report = {
        "schemaVersion": 1, "recordedAt": datetime.now(timezone.utc).isoformat(),
        "scope": "All raw artifact bytes plus decompressed ZIP member bytes; designated known values and encoding variants",
        "knownKeyCount": key_count, "privateEndpointVariantCount": endpoint_count,
        "explicitPublicEndpointOrigins": sorted({urllib.parse.urlsplit(value).scheme + "://" + urllib.parse.urlsplit(value).netloc for value in options.public_endpoint}),
        "patternCount": len(patterns), "scannedEntries": len(inventory),
        "scannedBytes": sum(item["bytes"] for item in inventory),
        "archives": archives, "findings": findings, "passed": not findings,
        "privateInputs": [{"sha256": hashlib.sha256(filename.read_bytes()).hexdigest(), "bytes": filename.stat().st_size} for filename in inputs],
        "limitations": ["Unknown secrets, arbitrary encodings, image text and non-ZIP embedded compressed resources are not proven absent.", "Known endpoints are derived from explicit endpoint/base_url labels in the designated private input files.", "No artifact is modified, deleted, extracted, uploaded or published."],
        "inventory": inventory,
    }
    report_file.parent.mkdir(parents=True, exist_ok=True)
    report_file.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({name: report[name] for name in ["passed", "scannedEntries", "scannedBytes", "knownKeyCount", "patternCount"]}))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print("Private artifact audit could not complete; raw exception content was suppressed.", file=sys.stderr)
        sys.exit(1)
