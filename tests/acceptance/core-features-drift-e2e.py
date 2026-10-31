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
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time

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


def ordinary_tree(root, marker_before, require):
    require(root.drive.lower() == "g:" and root.name.isalnum() and len(root.name) == 32,
            "cleanup_exact_g_uuid_owner_required")
    require(root.parent == WORKSPACE / ".cache/core-features-cli-e2e",
            "cleanup_owner_parent_mismatch")
    marker = root / "owner.json"
    require(marker.read_bytes() == marker_before, "cleanup_owner_marker_changed")
    owner = json.loads(marker_before)
    require(owner.get("schema") == "ae-switch-core-features-cli-e2e-v1"
            and owner.get("ownerId") == root.name
            and owner.get("purpose") == "local-synthetic-cli-fixtures",
            "cleanup_owner_marker_identity_mismatch")
    for ancestor in (root, *root.parents):
        metadata = ancestor.lstat()
        require(not stat.S_ISLNK(metadata.st_mode)
                and not getattr(metadata, "st_file_attributes", 0) & 0x400,
                "cleanup_redirected_ancestor_rejected")
    files, directories, pending = [], [], [root]
    while pending:
        directory = pending.pop()
        directories.append(directory)
        for entry in directory.iterdir():
            metadata = entry.lstat()
            require(not stat.S_ISLNK(metadata.st_mode)
                    and not getattr(metadata, "st_file_attributes", 0) & 0x400,
                    "cleanup_redirected_entry_rejected")
            require(entry.is_relative_to(root), "cleanup_entry_outside_owner")
            if stat.S_ISDIR(metadata.st_mode):
                pending.append(entry)
            else:
                require(stat.S_ISREG(metadata.st_mode), "cleanup_nonordinary_entry_rejected")
                if entry != marker:
                    files.append(entry)
    return files, sorted(directories, key=lambda path: len(path.parts), reverse=True)


def prove_no_owner_processes(harness, require):
    environment = harness.environment.copy()
    environment["AE_DRIFT_CLEANUP_ROOT"] = str(harness.owner)
    environment["PSModuleAnalysisCachePath"] = str(harness.owner / "process-cache/module-analysis")
    program = WORKSPACE / ".tools/pwsh/pwsh.exe"
    require(program.is_file(), "cleanup_workspace_powershell_required")
    # Query only. Raw command lines remain inside PowerShell and never enter
    # child output, retained evidence, or a termination API.
    script = r"""
$ErrorActionPreference='Stop'
$scope=[IO.Path]::GetFullPath($env:AE_DRIFT_CLEANUP_ROOT).TrimEnd('\','/')
$matches=@(Get-CimInstance Win32_Process | Where-Object {
  ($_.ExecutablePath -and ($_.ExecutablePath -ieq $scope -or $_.ExecutablePath.StartsWith($scope+'\',[StringComparison]::OrdinalIgnoreCase))) -or
  ($_.CommandLine -and $_.CommandLine.IndexOf($scope,[StringComparison]::OrdinalIgnoreCase) -ge 0)
})
@{processesReferencingOwner=$matches.Count;processesStopped=0}|ConvertTo-Json -Compress
"""
    result = subprocess.run([str(program), "-NoProfile", "-NonInteractive", "-Command", script],
                            env=environment, cwd=WORKSPACE, capture_output=True, text=True,
                            encoding="utf-8", errors="replace", timeout=60,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), check=False)
    require(result.returncode == 0, "cleanup_process_query_failed")
    try:
        proof = json.loads(result.stdout)
    except ValueError:
        raise RuntimeError("cleanup_process_proof_invalid") from None
    require(proof.get("processesReferencingOwner") == 0 and proof.get("processesStopped") == 0,
            "cleanup_live_owner_reference_refused")
    return proof


def cleanup(harness, marker_before, require):
    ordinary_tree(harness.owner, marker_before, require)
    proof = prove_no_owner_processes(harness, require)
    # Recheck after the process scan; deletion never follows a link and uses
    # explicit children, with the owner marker retained until everything else.
    # PowerShell may create its own module cache inside the owned root. Its
    # subprocess has exited; enumerate the complete final ordinary tree now.
    files, directories = ordinary_tree(harness.owner, marker_before, require)
    for file in files:
        metadata = file.lstat()
        require(stat.S_ISREG(metadata.st_mode)
                and not getattr(metadata, "st_file_attributes", 0) & 0x400,
                "cleanup_file_changed_before_delete")
        file.unlink()
    for directory in directories:
        if directory != harness.owner:
            directory.rmdir()
    marker = harness.owner / "owner.json"
    require(marker.read_bytes() == marker_before, "cleanup_marker_changed_before_delete")
    require(set(harness.owner.iterdir()) == {marker}, "cleanup_unexpected_root_entry")
    marker.unlink()
    harness.owner.rmdir()
    return {"passed": not harness.owner.exists(), "removed": not harness.owner.exists(),
            "ownerMarkerVerified": True, "ordinaryTreeVerified": True,
            "processesReferencingOwner": proof["processesReferencingOwner"],
            "processesStopped": 0, "removedFiles": len(files) + 1,
            "removedDirectories": len(directories)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path,
                        default=WORKSPACE / ".cache/release-audit-ui-64ccdd27024145f1af6c9b745bb0f97c/AE-Switch-core.exe")
    parser.add_argument("--expected-sha256", default=None)
    options = parser.parse_args()
    fixture = load_fixture_harness()
    require = fixture.require
    harness = None
    marker = None
    failure = None
    checks = []
    cleanup_result = {"passed": False, "removed": False}
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
        marker = (harness.owner / "owner.json").read_bytes()
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
    except fixture.CheckFailure as error:
        failure = str(error)
    except Exception:
        failure = "drift_fixture_operation_failed_raw_details_suppressed"
    finally:
        if harness is not None and marker is not None:
            try:
                cleanup_result = cleanup(harness, marker, require)
            except fixture.CheckFailure as error:
                cleanup_result = {"passed": False, "removed": False, "failure": str(error)}
                failure = failure or "owned_cleanup_not_proved"
            except Exception:
                cleanup_result = {"passed": False, "removed": False,
                                  "failure": "owned_cleanup_refused_or_failed_raw_details_suppressed"}
                failure = failure or "owned_cleanup_not_proved"
    report = {
        "schema": "ae-switch-compiled-core-drift-e2e-v1",
        "ownerId": harness.owner_id if harness else None,
        "binarySha256": harness.binary_sha256 if harness else None,
        "scriptSha256": sha256(Path(__file__)),
        "fixtureHelperSha256": sha256(Path(__file__).with_name("core-features-cli-e2e.py")),
        "passed": failure is None and cleanup_result["passed"], "failure": failure,
        "checks": [{"name": name, "passed": True} for name in checks],
        "checkCount": len(checks), "cliCommands": harness.command_count if harness else 0,
        "elapsedSeconds": round(time.monotonic() - started, 3), "cleanup": cleanup_result,
        "scope": "synthetic local compiled-core Codex configuration drift and safe disconnect",
        "officialClientsExecuted": False, "upstreamRequestsMade": 0,
        "modelInferenceCalls": 0, "realClientE2EPassed": False,
        "sensitiveStateIncluded": False, "allMutableDataOnG": True,
    }
    if harness is not None:
        receipt = WORKSPACE / ".cache/core-features-drift-e2e" / (harness.owner_id + ".json")
        receipt.parent.mkdir(parents=True, exist_ok=True)
        with receipt.open("x", encoding="utf-8") as stream:
            stream.write(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
