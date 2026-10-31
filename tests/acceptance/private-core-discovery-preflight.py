"""One read-only real Rust supplier discovery through inherited proxy settings.

This older compiled-core observation is not acceptance for the new revision.
All private output stays in memory; the exact owned G: sandbox is retained.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import uuid
from importlib.util import spec_from_file_location, module_from_spec

spec = spec_from_file_location("artifact_privacy", Path(__file__).with_name("audit-private-artifacts.py"))
privacy = module_from_spec(spec)
spec.loader.exec_module(privacy)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--private-input", required=True)
    parser.add_argument("--core", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--report", required=True)
    options = parser.parse_args()
    workspace = privacy.WORKSPACE
    private_file = privacy.guard(options.private_input)
    core = privacy.guard(options.core)
    report_file = privacy.guard(options.report, missing=True)
    if report_file.exists():
        raise ValueError("Fresh report required")
    text = private_file.read_text(encoding="utf-8-sig")
    blocks = []
    for line in text.splitlines():
        url = re.search(r'https?://[^\s"<>]+', line)
        if url:
            blocks.append({"endpoint": url.group().rstrip(",;，；。/"), "keys": []})
        key = re.match(r"\s*api[-_ ]?key\s*[:：]\s*(.+)", line, re.I)
        if key and blocks:
            blocks[-1]["keys"].append(key.group(1).strip())
    if not blocks or not blocks[-1]["keys"] or "krill" not in blocks[-1]["endpoint"].lower():
        raise ValueError("Final requested supplier block missing")
    selected = blocks[-1]
    owner_id = uuid.uuid4().hex
    root = privacy.guard(workspace / ".cache/acceptance" / ("core-discovery-preflight-" + owner_id), missing=True)
    root.mkdir()
    (root / ".ae-core-discovery-owner.json").write_text(json.dumps({"ownerId": owner_id, "purpose": "One old-compiled-core supplier discovery; no inference", "workspace": str(workspace)}), encoding="utf-8")
    executable = root / "AE-Switch-core.exe"
    shutil.copyfile(core, executable)
    # Only the final explicitly selected block is passed to Rust. No other
    # connection is discovered, retried, or used as fallback.
    credential_file = root / "acceptance-credentials.txt"
    credential_file.write_text("端点: " + selected["endpoint"] + "\napi-key: " + selected["keys"][-1] + "\n", encoding="utf-8")
    proxy_names = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]
    environment = dict(os.environ)
    for name in list(environment):
        if re.search(r"^AE_SWITCH_|^UNI_SWITCH_QA_|^AE_NATIVE_", name, re.I):
            del environment[name]
    paths = {
        "HOME": "home", "USERPROFILE": "home", "APPDATA": "home/AppData/Roaming", "LOCALAPPDATA": "home/AppData/Local",
        "TEMP": "tmp", "TMP": "tmp", "TMPDIR": "tmp", "XDG_CONFIG_HOME": "config", "XDG_DATA_HOME": "data-xdg", "XDG_STATE_HOME": "state", "XDG_CACHE_HOME": "cache",
        "NODE_COMPILE_CACHE": "node-cache", "PYTHONPYCACHEPREFIX": "pycache",
    }
    for name, relative in paths.items():
        directory = privacy.guard(root / relative, missing=True)
        directory.mkdir(parents=True, exist_ok=True)
        environment[name] = str(directory)
    environment["AE_SWITCH_PORTABLE_ROOT"] = str(root)
    report = {
        "schemaVersion": 1, "ownerId": owner_id, "recordedAt": datetime.now(timezone.utc).isoformat(),
        "scope": "Existing compiled production Rust core supplier::discover_connection under inherited proxy presence; connectivity observation only",
        "model": options.model, "attempts": 1, "inferenceRequests": 0, "fallbackUsed": False,
        "privateInputSha256": hashlib.sha256(private_file.read_bytes()).hexdigest(),
        "coreSha256": hashlib.sha256(core.read_bytes()).hexdigest(), "currentRevisionAcceptance": False,
        "proxyVariablesPresent": {name: bool(os.environ.get(name)) for name in proxy_names},
        "dnsTcpTlsSeparatelyObserved": False, "httpStatus": None, "selectedModelListed": None,
        "reasoningEfforts": {"state": "unknown", "values": []}, "passed": False,
        "sandboxWorkspaceRelativePath": root.relative_to(workspace).as_posix(),
        "cleanup": {"performed": False, "retainedPrivateSandbox": True, "ownerId": owner_id},
    }
    start = time.monotonic()
    try:
        outcome = subprocess.run([str(executable), "discover", str(credential_file)], cwd=root, env=environment, stdin=subprocess.DEVNULL, capture_output=True, timeout=125, creationflags=subprocess.CREATE_NO_WINDOW)
        report["exitCode"] = outcome.returncode
        report["stdoutBytes"] = len(outcome.stdout)
        report["stderrBytes"] = len(outcome.stderr)
        report["rawOutputRetained"] = False
        report["stderrSha256"] = hashlib.sha256(outcome.stderr).hexdigest()
        if outcome.returncode == 0:
            provider = json.loads(outcome.stdout)
            models = provider.get("codexOptions", {}).get("models", [])
            matching = next((item for item in models if item.get("id") == options.model and item.get("enabled", True)), None)
            report["httpStatus"] = 200
            report["modelCount"] = len(models)
            report["selectedModelListed"] = matching is not None
            if matching and matching.get("reasoningEfforts"):
                values = matching["reasoningEfforts"]
                if all(item in {"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"} for item in values):
                    report["reasoningEfforts"] = {"state": "declared", "values": values}
            report["passed"] = matching is not None
        else:
            try:
                error = json.loads(outcome.stderr)
                code = error.get("code")
                report["productErrorCode"] = code if isinstance(code, str) and re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", code) else "unclassified"
                status = re.search(r"(?:HTTP|status|状态码)\D{0,12}([45]\d\d)", str(error.get("message", "")), re.I)
                if status:
                    report["httpStatus"] = int(status.group(1))
            except Exception:
                report["productErrorCode"] = "unparsed_private_error"
    except subprocess.TimeoutExpired:
        report["timedOut"] = True
        report["productErrorCode"] = "bounded_core_discovery_timeout"
    except Exception as error:
        report["failureKind"] = type(error).__name__
    finally:
        report["milliseconds"] = round((time.monotonic() - start) * 1000)
        report_file.parent.mkdir(parents=True, exist_ok=True)
        report_file.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({name: report.get(name) for name in ["passed", "proxyVariablesPresent", "exitCode", "httpStatus", "selectedModelListed", "reasoningEfforts", "productErrorCode", "milliseconds", "ownerId"]}))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print("Rust private discovery preflight could not complete; raw diagnostic content was suppressed.", file=sys.stderr)
        sys.exit(1)
