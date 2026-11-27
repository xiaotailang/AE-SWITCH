"""Compiled-core Codex drift rejection using an isolated synthetic G: profile.

No official client is executed and no upstream or inference request is made.
Only this run's UUID fixture tree is removed, after process and ordinary-tree
checks. The retained receipt contains hashes/counts and fixed check labels only.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys
import time
from uuid import uuid4

sys.dont_write_bytecode = True
WORKSPACE = Path(__file__).resolve().parents[2]
EXPECTED_CORE_SHA256 = "7fcf8914db44ba6942c142da082f308901ec384204d6e7ccebfc3df651d347d0"


def load_fixture_harness():
    filename = Path(__file__).with_name("core-features-cli-e2e.py")
    spec = importlib.util.spec_from_file_location("ae_drift_cli_fixture", filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path,
                        default=WORKSPACE / ".cache/release-audit-ui-64ccdd27024145f1af6c9b745bb0f97c/AE-Switch-core.exe")
    parser.add_argument("--expected-sha256", default=None)
    parser.add_argument("--report", type=Path)
    options = parser.parse_args()
    fixture = load_fixture_harness()
    require = fixture.require
    try:
        receipt = fixture.receipt_path(options.report)
    except fixture.CheckFailure as error:
        print(json.dumps({"passed": False, "failure": str(error)}))
        return 1
    harness = None
    failure = None
    checks = []
    setup_cleanup = None
    started = time.monotonic()
    try:
        binary = fixture.g_path(options.binary)
        require(binary.is_file(), "compiled_core_missing")
        core_sha256 = sha256(binary)
        if options.expected_sha256 is not None:
            require(re.fullmatch(r"[a-f0-9]{64}", options.expected_sha256) is not None
                    and core_sha256 == options.expected_sha256, "compiled_core_hash_mismatch")
        else:
            require(core_sha256 == EXPECTED_CORE_SHA256, "compiled_core_expected_hash_mismatch")
        harness = fixture.Harness(binary, WORKSPACE)
        harness.fixture("codex")
        config = harness.main_paths["codex"]
        original = config.read_bytes()
        original_hash = hashlib.sha256(original).hexdigest()
        history_hashes = {path: sha256(path) for path in harness.histories}
        provider = harness.command("save-provider", payload={
            "family": "codex", "name": "Synthetic drift acceptance",
            "baseUrl": "https://invalid.example/v1",
            "apiKey": "ae-switch-synthetic-drift-" + harness.owner_id,
            "model": "gpt-6.1-sol", "authMode": "bearer", "reasoningEffort": "xhigh",
            "codexOptions": {"upstreamProtocol": "openai", "models": [{
                "id": "gpt-6.1-sol", "enabled": True, "reasoningEfforts": ["xhigh"],
            }]},
        })
        harness.command("configure-profile", payload={
            "agentId": "codex", "providerId": provider["id"], "model": "gpt-6.1-sol",
            "profile": harness.profiles["codex"],
        })
        healthy = harness.command("configuration-safety", "codex")
        require(healthy.get("status") == "healthy" and healthy.get("canDisconnect") is True,
                "initial_configuration_not_healthy")
        preview = harness.command("preview-disconnect", "codex")
        require(preview.get("canDisconnect") is True and isinstance(preview.get("previewToken"), str),
                "healthy_preview_missing")
        checks.append("compiled_cli_configure_and_healthy_disconnect_preview")
        managed_before = config.read_bytes()
        text = managed_before.decode("utf-8")
        # Change exactly the root model string. The fake identifier is inert
        # fixture text; no run/probe endpoint is ever called.
        changed, count = re.subn(r'(?m)^model\s*=\s*"gpt-6\.1-sol"\s*$',
                                'model = "ae-synthetic-manual-model"', text, count=1)
        require(count == 1, "expected_root_managed_model_not_found")
        manual_bytes = changed.encode("utf-8")
        require(config.read_bytes() == managed_before, "fixture_cas_before_manual_change_failed")
        config.write_bytes(manual_bytes)
        selection_path = harness.data / "agent-selection.json"
        selected_before_rejection = selection_path.read_bytes()
        drifted = harness.command("configuration-safety", "codex")
        require(drifted.get("status") == "drifted" and drifted.get("canDisconnect") is False
                and drifted.get("previewToken") is None
                and sum(row.get("changedFields", 0) for row in drifted.get("files", [])) > 0,
                "managed_manual_change_not_reported_as_drift")
        denied_preview = harness.command("preview-disconnect", "codex")
        require(denied_preview.get("status") == "drifted"
                and denied_preview.get("canDisconnect") is False
                and denied_preview.get("previewToken") is None,
                "drifted_disconnect_preview_was_available")
        harness.command("disconnect-agent", payload={"agentId": "codex", "previewToken": preview["previewToken"]},
                        expected_error="agent_configuration_changed")
        require(config.read_bytes() == manual_bytes, "rejected_disconnect_overwrote_manual_model")
        require(selection_path.read_bytes() == selected_before_rejection,
                "rejected_disconnect_changed_selection")
        require(all(sha256(path) == value for path, value in history_hashes.items()),
                "rejected_disconnect_changed_original_history")
        checks.append("positive_managed_drift_report_and_preview_denial")
        checks.append("old_preview_disconnect_rejected_preserving_manual_bytes_selection_and_history")
        # CAS restoration touches only our own exact injected bytes. A differing
        # file is an external change and is preserved by failing this run.
        require(config.read_bytes() == manual_bytes, "fixture_cas_manual_bytes_changed")
        config.write_bytes(managed_before)
        require(config.read_bytes() == managed_before, "fixture_cas_restore_readback_failed")
        again = harness.command("configuration-safety", "codex")
        require(again.get("status") == "healthy" and again.get("canDisconnect") is True,
                "cas_restored_managed_configuration_not_healthy")
        fresh = harness.command("preview-disconnect", "codex")
        disconnected = harness.command("disconnect-agent", payload={"agentId": "codex", "previewToken": fresh["previewToken"]})
        require(disconnected.get("disconnected") is True, "healthy_disconnect_not_confirmed")
        require(config.read_bytes() == original, "disconnect_original_config_bytes_not_restored")
        require(json.loads(selection_path.read_text(encoding="utf-8")) == {},
                "disconnect_selection_not_removed")
        require(all(sha256(path) == value for path, value in history_hashes.items()),
                "disconnect_original_history_changed")
        checks.append("cas_fixture_restore_returns_healthy_and_normal_disconnect_restores_original_bytes")
        require(sha256(config) == original_hash, "original_configuration_hash_mismatch")
    except fixture.FixtureSetupFailure as error:
        harness, setup_cleanup, failure = error.harness, error.harness.cleanup, str(error)
    except fixture.CheckFailure as error:
        failure = str(error)
    except Exception:
        failure = "drift_fixture_operation_failed_raw_details_suppressed"
    report = {
        "schema": "ae-switch-compiled-core-drift-e2e-v1",
        "ownerId": harness.owner_id if harness else None,
        "binarySha256": harness.binary_sha256 if harness else None,
        "scriptSha256": sha256(Path(__file__)),
        "fixtureHelperSha256": sha256(Path(__file__).with_name("core-features-cli-e2e.py")),
        "passed": failure is None, "failure": failure,
        "checks": [{"name": name, "passed": True} for name in checks],
        "checkCount": len(checks), "cliCommands": harness.command_count if harness else 0,
        "elapsedSeconds": round(time.monotonic() - started, 3),
        "scope": "synthetic local compiled-core Codex configuration drift and safe disconnect",
        "officialClientsExecuted": False, "upstreamRequestsMade": 0,
        "modelInferenceCalls": 0, "realClientE2EPassed": False,
        "sensitiveStateIncluded": False, "allMutableDataOnG": True,
    }
    cleanup = setup_cleanup if setup_cleanup is not None else fixture.finish_owned_fixture(harness)
    report["cleanup"] = cleanup
    if not cleanup["passed"]:
        report["passed"] = False
        report["failure"] = failure or "owned_cleanup_not_proved"
    owner_id = harness.owner_id if harness and harness.owner_id else uuid4().hex
    receipt = receipt or WORKSPACE / "artifacts/acceptance/core-features-drift-e2e" / f"{owner_id}.json"
    try:
        fixture.write_receipt(receipt, report)
    except Exception:
        report["passed"] = False
        report["receiptFailure"] = "acceptance_receipt_not_written"
    print(json.dumps(report))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
