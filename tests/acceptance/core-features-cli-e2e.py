"""Exercise the compiled AE Switch CLI against eight synthetic native profiles.

This is a local binary integration check. It never launches a client fixture,
contacts an upstream, queries an inference model, or proves official client E2E.
All mutable state and the summary report are confined to a fresh G: owner root.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import uuid


AGENTS = (
    "claude_code", "codex", "hermes", "oh_my_pi", "opencode", "zcode",
    "workbuddy", "deepseek_harness",
)
MODEL = "gpt-6.1-sol"
SCHEMA = "ae-switch-core-features-cli-e2e-v1"


class CheckFailure(Exception):
    """Contains only a fixed check label, never child output or native values."""


def require(condition: bool, label: str) -> None:
    if not condition:
        raise CheckFailure(label)


def g_path(value: Path) -> Path:
    resolved = value.resolve()
    require(resolved.drive.lower() == "g:", "all_paths_must_remain_on_g_drive")
    current = resolved
    while current != current.parent:
        if current.exists():
            require(not current.is_symlink(), "symbolic_link_path_rejected")
            stat = current.stat(follow_symlinks=False)
            require(not getattr(stat, "st_file_attributes", 0) & 0x400,
                    "reparse_point_path_rejected")
        current = current.parent
    return resolved


def json_text(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def parse_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        raise CheckFailure("persisted_json_readback_failed") from None


class Harness:
    def __init__(self, binary: Path, workspace: Path) -> None:
        self.owner_id = uuid.uuid4().hex
        self.owner = g_path(workspace / ".cache" / "core-features-cli-e2e" / self.owner_id)
        require(not self.owner.exists(), "owner_root_must_be_new")
        self.owner.mkdir(parents=True)
        self.portable = self.owner / "portable"
        self.portable.mkdir()
        self.binary = self.portable / "AE-Switch-core.exe"
        shutil.copy2(binary, self.binary)
        self.binary_sha256 = digest(self.binary)
        self.data = self.portable / "data"
        self.stage = "initialize"
        self.command_count = 0
        self.checks: list[str] = []
        self.environment = os.environ.copy()
        # The process bootstrap also redirects these variables, but setting the
        # originals prevents discovery from consulting an actual user profile.
        redirected = {
            "AE_SWITCH_PORTABLE_ROOT": self.portable,
            "HOME": self.portable / "fixture-process-home",
            "USERPROFILE": self.portable / "fixture-process-home",
            "APPDATA": self.portable / "fixture-process-home/AppData/Roaming",
            "LOCALAPPDATA": self.portable / "fixture-process-home/AppData/Local",
            "TEMP": self.portable / "process-tmp",
            "TMP": self.portable / "process-tmp",
            "TMPDIR": self.portable / "process-tmp",
            "XDG_CONFIG_HOME": self.portable / "process-config",
            "XDG_DATA_HOME": self.portable / "process-data",
            "XDG_STATE_HOME": self.portable / "process-state",
            "XDG_CACHE_HOME": self.portable / "process-cache",
            "PYTHONPYCACHEPREFIX": self.portable / "process-cache/pycache",
            "RTK_TEE_DIR": self.portable / "process-cache/rtk/tee",
            "RTK_DB_PATH": self.portable / "process-cache/rtk/history.db",
        }
        for variable, path in redirected.items():
            g_path(path)
            if variable != "RTK_DB_PATH":
                path.mkdir(parents=True, exist_ok=True)
            self.environment[variable] = str(path)
        self.environment["HTTPS_PROXY"] = ""
        self.environment["HTTP_PROXY"] = ""
        self.environment["ALL_PROXY"] = ""
        self.environment["NO_PROXY"] = "127.0.0.1,localhost,::1"
        for variable in (
            "CODEX_HOME", "CLAUDE_CONFIG_DIR", "ZCODE_STORAGE_DIR",
            "ZCODE_DATA_BASE_DIR", "OMP_PROFILE", "PI_PROFILE", "PI_CONFIG_DIR",
            "DSH_HOME", "WORKBUDDY_HOME", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR",
            "OPENCODE_CONFIG_CONTENT", "AE_SWITCH_TOOLS_DIR",
        ):
            self.environment.pop(variable, None)
        write_text(self.owner / "owner.json", json_text({
            "schema": SCHEMA, "ownerId": self.owner_id,
            "purpose": "local-synthetic-cli-fixtures",
        }))
        self.profiles: dict[str, dict[str, str]] = {}
        self.originals: dict[Path, bytes | None] = {}
        self.histories: dict[Path, bytes] = {}
        self.main_paths: dict[str, Path] = {}

    def command(self, name: str, *args: str, payload: object | None = None,
                expected_error: str | None = None) -> object:
        self.command_count += 1
        try:
            result = subprocess.run(
                [str(self.binary), name, *args],
                input=None if payload is None else json_text(payload),
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                cwd=self.portable, env=self.environment, timeout=90,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                check=False,
            )
        except subprocess.TimeoutExpired:
            raise CheckFailure("cli_command_timeout") from None
        except OSError:
            raise CheckFailure("cli_process_start_failed") from None
        # stdout/stderr can contain native path details. Never echo or persist
        # them, including on an unexpected failure.
        if expected_error is not None:
            require(result.returncode != 0, "stale_preview_was_not_rejected")
            try:
                error = json.loads(result.stderr.strip())
            except ValueError:
                raise CheckFailure("cli_error_was_not_structured") from None
            require(error.get("code") == expected_error, "unexpected_cli_error_code")
            return error
        require(result.returncode == 0, "cli_command_failed")
        try:
            return json.loads(result.stdout)
        except ValueError:
            raise CheckFailure("cli_output_was_not_structured") from None

    def fixture(self, agent: str) -> None:
        root = self.portable / "native-fixtures" / agent
        home, directory, workspace = root / "home", root / "config", root / "workspace"
        for path in (home, directory, workspace):
            path.mkdir(parents=True)
        executable = root / "official-fixture.exe"
        executable.write_bytes(b"Synthetic validation fixture. NEVER EXECUTE.\r\n")
        profile = {
            "directory": str(directory), "homeDirectory": str(home),
            "workspaceDirectory": str(workspace), "executablePath": str(executable),
        }
        if agent == "claude_code":
            main = directory / "settings.json"
            seed = '{"fixtureUserSetting":"original","permissions":{"allow":["Read(*)"]}}\n'
            paths = [main]
        elif agent == "codex":
            main = directory / "config.toml"
            seed = '# original fixture comment\nfixture_user_setting = "original"\n[features]\nmemory_tool = true\n'
            paths = [main]
        elif agent == "hermes":
            main = directory / "config.yaml"
            seed = '# original fixture comment\nfixture_user_setting: original\n'
            paths = [main]
        elif agent == "oh_my_pi":
            main = directory / "models.yml"
            seed = '{}\n'
            secondary = directory / "config.yml"
            write_text(secondary, '# original fixture comment\nfixture_user_setting: original\n')
            paths = [main, secondary]
        elif agent == "opencode":
            main = directory / "opencode.json"
            seed = '{"fixtureUserSetting":"original","permission":{"edit":"ask"}}\n'
            paths = [main]
        elif agent == "zcode":
            main = home / ".zcode/v2/provider_config.json"
            state = home / ".zcode/v2/agents-state.json"
            profile["configFile"] = str(main)
            profile["stateFile"] = str(state)
            # Default personal path matches HOME, so no unrelated Built-in path
            # is granted. The missing read-only Built-in file remains missing.
            seed = '{}\n'
            write_text(state, json_text({
                "fixtureHistory": "preserve",
                "builtInModelSelectionOverrides": {
                    "general-purpose": {"providerId": "fixture-original", "modelId": "fixture-original"},
                    "Explore": {"providerId": "fixture-original", "modelId": "fixture-original"},
                },
            }))
            paths = [main, state, directory / "builtin-providers.json"]
        elif agent == "workbuddy":
            main = directory / "models.json"
            seed = '[]\n'
            paths = [main]
        else:
            main = directory / "cordis.patch.yml"
            seed = '[]\n'
            dsh_data = home / ".dsh"
            dsh_data.mkdir()
            profile["dataDirectory"] = str(dsh_data)
            profile["profileName"] = "headless"
            package = directory / "package.json"
            write_text(package, json_text({
                "private": True,
                "dsh": {"profile": {"bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"]}},
                "fixtureUserSetting": "original",
            }))
            paths = [main, dsh_data / ".credentials.yaml", package]
        write_text(main, seed)
        history = home / "sessions/history.keep"
        history_bytes = ("Synthetic original history for " + agent + "\n").encode("utf-8") + bytes(range(32))
        history.parent.mkdir(parents=True)
        history.write_bytes(history_bytes)
        self.histories[history] = history_bytes
        for path in paths:
            self.originals[path] = path.read_bytes() if path.exists() else None
        self.profiles[agent] = profile
        self.main_paths[agent] = main

    def configure_all(self, provider: str, effort: str) -> None:
        for agent in AGENTS:
            configured = self.command("configure-profile", payload={
                "agentId": agent, "providerId": provider, "model": MODEL,
                "profile": self.profiles[agent],
            })
            require(isinstance(configured, dict) and configured.get("configured") is True,
                    "native_fixture_configuration_not_confirmed")
        self.verify_selections(provider, effort)

    def verify_selections(self, provider: str, effort: str) -> None:
        saved = parse_json(self.data / "agent-selection.json")
        require(isinstance(saved, dict) and set(saved) == set(AGENTS),
                "persisted_agent_selection_set_mismatch")
        for agent in AGENTS:
            selection = saved[agent]
            require(selection.get("providerId") == provider and selection.get("model") == MODEL
                    and selection.get("reasoningEffort") == effort,
                    "persisted_provider_model_effort_mismatch")
            require(selection.get("profile") == self.profiles[agent], "native_profile_target_changed")
            text = self.main_paths[agent].read_text(encoding="utf-8")
            require(MODEL in text and "127.0.0.1" in text,
                    "native_configuration_model_or_gateway_missing")
            safety = self.command("configuration-safety", agent)
            require(safety.get("status") == "healthy" and safety.get("canDisconnect") is True,
                    "native_configuration_ownership_is_not_healthy")

    def saved_profile(self, name: str) -> dict:
        profile = self.command("save-config-profile", payload={"name": name, "agentIds": list(AGENTS)})
        require(isinstance(profile, dict) and len(profile.get("entries", [])) == 8,
                "named_profile_did_not_capture_all_clients")
        return profile

    def apply_profile(self, profile: dict) -> None:
        preview = self.command("preview-config-profile", profile["id"])
        require(len(preview.get("entries", [])) == 8, "batch_preview_target_count_mismatch")
        applied = self.command("apply-config-profile", payload={
            "id": profile["id"], "revision": profile["revision"],
            "fingerprint": preview["fingerprint"],
        })
        require(set(applied.get("appliedAgentIds", [])) == set(AGENTS),
                "batch_apply_target_count_mismatch")

    def run(self) -> None:
        self.stage = "native-fixtures"
        for agent in AGENTS:
            self.fixture(agent)
        self.checks.append("eight_owned_native_profile_fixtures_created_without_executing_clients")
        providers = []
        self.stage = "synthetic-providers"
        for label, effort in (("A", "ultra"), ("B", "high")):
            result = self.command("save-provider", payload={
                "family": "codex", "name": "Synthetic core fixture " + label,
                "baseUrl": "https://invalid.example/v1",
                "apiKey": "ae-switch-synthetic-core-fixture-" + self.owner_id + label,
                "model": MODEL, "authMode": "bearer", "reasoningEffort": effort,
                "codexOptions": {"upstreamProtocol": "openai", "models": [{
                    "id": MODEL, "enabled": True, "reasoningEfforts": ["high", "ultra"],
                }]},
            })
            require(isinstance(result, dict) and isinstance(result.get("id"), str),
                    "synthetic_provider_was_not_saved")
            providers.append(result["id"])
        self.checks.append("two_synthetic_provider_references_same_selected_model_no_inference")
        self.stage = "configure-and-capture-A"
        self.configure_all(providers[0], "ultra")
        profile_a = self.saved_profile("Synthetic A")
        self.stage = "configure-and-capture-B"
        self.configure_all(providers[1], "high")
        profile_b = self.saved_profile("Synthetic B")
        self.checks.append("all_eight_clients_configured_and_two_named_profiles_saved")
        self.stage = "apply-profile-A"
        self.apply_profile(profile_a)
        self.verify_selections(providers[0], "ultra")
        self.checks.append("batch_A_applied_and_native_files_selection_provider_effort_read_back")
        self.stage = "stale-preview"
        preview_b = self.command("preview-config-profile", profile_b["id"])
        changed = self.main_paths["claude_code"]
        value = parse_json(changed)
        require(isinstance(value, dict), "expected_json_fixture_object")
        value["fixtureUserLater"] = "must-survive-profile-apply-and-disconnect"
        write_text(changed, json_text(value))
        before_reject = {path: path.read_bytes() if path.exists() else None for path in self.originals}
        before_selection = (self.data / "agent-selection.json").read_bytes()
        self.command("apply-config-profile", payload={
            "id": profile_b["id"], "revision": profile_b["revision"],
            "fingerprint": preview_b["fingerprint"],
        }, expected_error="configuration_profile_changed")
        require((self.data / "agent-selection.json").read_bytes() == before_selection,
                "stale_preview_modified_selection")
        require(all((path.read_bytes() if path.exists() else None) == before
                    for path, before in before_reject.items()), "stale_preview_modified_native_files")
        self.checks.append("stale_preview_rejected_without_changing_selection_or_native_files")
        self.stage = "fresh-preview-and-apply-B"
        self.apply_profile(profile_b)
        self.verify_selections(providers[1], "high")
        require(parse_json(changed).get("fixtureUserLater") == "must-survive-profile-apply-and-disconnect",
                "fresh_batch_apply_lost_unowned_setting")
        self.checks.append("fresh_batch_B_preserved_later_user_setting")
        self.stage = "eight-safe-disconnects"
        for agent in AGENTS:
            inspected = self.command("configuration-safety", agent)
            require(inspected.get("status") == "healthy", "pre_disconnect_drift_detected")
            preview = self.command("preview-disconnect", agent)
            require(preview.get("canDisconnect") is True and isinstance(preview.get("previewToken"), str),
                    "disconnect_preview_not_available")
            result = self.command("disconnect-agent", payload={
                "agentId": agent, "previewToken": preview["previewToken"],
            })
            require(result.get("disconnected") is True, "disconnect_not_confirmed")
            saved = parse_json(self.data / "agent-selection.json")
            require(agent not in saved, "disconnect_did_not_remove_agent_selection")
        require(parse_json(self.data / "agent-selection.json") == {},
                "disconnect_left_client_selections")
        for path, before in self.originals.items():
            if path == changed:
                require(parse_json(path) == {
                    "fixtureUserSetting": "original", "permissions": {"allow": ["Read(*)"]},
                    "fixtureUserLater": "must-survive-profile-apply-and-disconnect",
                }, "disconnect_lost_original_or_later_user_setting")
            else:
                require((path.read_bytes() if path.exists() else None) == before,
                        "disconnect_did_not_restore_original_native_bytes")
        require(all(path.read_bytes() == before for path, before in self.histories.items()),
                "original_history_bytes_changed")
        self.checks.append("eight_disconnects_restored_original_fields_and_preserved_original_history_bytes")
        self.stage = "delete-named-profiles"
        for profile in (profile_a, profile_b):
            result = self.command("delete-config-profile", profile["id"], str(profile["revision"]))
            require(result.get("deleted") is True, "profile_delete_not_confirmed")
        require(self.command("list-config-profiles") == [], "named_profiles_remained_after_delete")
        self.checks.append("both_named_profiles_deleted_without_touching_history")
        self.stage = "complete"

    def report(self, passed: bool, failure: str | None, seconds: float) -> dict:
        return {
            "schema": SCHEMA, "ownerId": self.owner_id, "binarySha256": self.binary_sha256,
            "passed": passed, "stage": self.stage, "failure": failure,
            "elapsedSeconds": round(seconds, 3), "cliCommands": self.command_count,
            "agents": list(AGENTS), "checks": self.checks,
            "scope": "compiled CLI with isolated local synthetic native configuration fixtures",
            "officialClientsExecuted": False, "upstreamRequestsMade": 0,
            "modelInferenceCalls": 0, "realClientE2EPassed": False, "publicReady": False,
            "sensitiveStateIncluded": False, "allMutableDataOnG": True,
        }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, type=Path,
                        help="Compiled final AE Switch core CLI executable on G:")
    parser.add_argument("--workspace", type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    harness = None
    started = time.monotonic()
    try:
        binary, workspace = g_path(args.binary), g_path(args.workspace)
        require(binary.is_file(), "compiled_cli_binary_missing")
        harness = Harness(binary, workspace)
        harness.run()
        report = harness.report(True, None, time.monotonic() - started)
    except CheckFailure as error:
        if harness is None:
            print(json_text({"schema": SCHEMA, "passed": False, "failure": str(error)}), end="")
            return 1
        report = harness.report(False, str(error), time.monotonic() - started)
    except Exception:
        # No Python traceback: it can include fixture values or subprocess text.
        if harness is None:
            print(json_text({"schema": SCHEMA, "passed": False, "failure": "harness_setup_failed"}), end="")
            return 1
        report = harness.report(False, "unexpected_harness_failure", time.monotonic() - started)
    write_text(harness.owner / "report.json", json_text(report))
    print(json_text(report), end="")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.dont_write_bytecode = True
    raise SystemExit(main())
