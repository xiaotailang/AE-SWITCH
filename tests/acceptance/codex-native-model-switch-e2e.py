"""Real Codex app-server picker and turn switching through a scripted G-only AE route."""
import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
from queue import Empty, Queue
import shutil
import subprocess
import sys
import threading
import time
import tomllib
import urllib.request
from uuid import uuid4

sys.dont_write_bytecode = True

from owned_python_fixture import cleanup_owned_fixture, create_owned_fixture, fresh_receipt_path, write_receipt


WORKSPACE = Path(__file__).resolve().parents[2]
PURPOSE = "codex-native-model-switch-e2e"
DEFAULT = "gpt-6.2-astra"
ALTERNATE = "gpt-6.1-sol"


def hash_file(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def options():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("core", "codex", "report"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    for name in ("core-sha256", "codex-sha256"):
        parser.add_argument(f"--{name}", required=True)
    parser.add_argument("--alternate-window", type=int, choices=[80000, 105000, 128000], default=80000)
    arguments = parser.parse_args()
    arguments.core = arguments.core.resolve(strict=True)
    arguments.codex = arguments.codex.resolve(strict=True)
    if not arguments.core.is_relative_to(WORKSPACE) or WORKSPACE.drive.lower() != "g:":
        parser.error("the exact tested core must be under this G: workspace")
    for key in ("core", "codex"):
        digest = getattr(arguments, f"{key}_sha256")
        if hash_file(getattr(arguments, key)) != digest or len(digest) != 64:
            parser.error(f"{key} executable does not match the expected SHA-256")
    arguments.report = fresh_receipt_path(arguments.report)
    return arguments


def native_env(root):
    env = {
        name: value
        for name, value in os.environ.items()
        if name.upper() in {"SYSTEMROOT", "WINDIR", "COMSPEC", "SYSTEMDRIVE",
                            "USERNAME", "USERDOMAIN", "COMPUTERNAME", "OS",
                            "PROCESSOR_ARCHITECTURE"}
    }
    directories = {
        "AE_SWITCH_PORTABLE_ROOT": "ae",
        "CODEX_HOME": "profile",
        "HOME": "home",
        "USERPROFILE": "home",
        "APPDATA": "home/AppData/Roaming",
        "LOCALAPPDATA": "home/AppData/Local",
        "TEMP": "temp",
        "TMP": "temp",
        "TMPDIR": "temp",
        "XDG_CONFIG_HOME": "home/config",
        "XDG_CACHE_HOME": "home/cache",
        "XDG_DATA_HOME": "home/data",
        "XDG_STATE_HOME": "home/state",
    }
    for name, child in directories.items():
        directory = root / child
        directory.mkdir(parents=True, exist_ok=True)
        env[name] = str(directory)
    env.update({
        "PATH": str(WORKSPACE / ".tools/pwsh") + ";" + str(Path(env["SYSTEMROOT"]) / "System32"),
        "NO_PROXY": "127.0.0.1,localhost,::1",
        "HTTP_PROXY": "http://127.0.0.1:1",
        "HTTPS_PROXY": "http://127.0.0.1:1",
        "ALL_PROXY": "http://127.0.0.1:1",
        "CODEX_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        "DISABLE_TELEMETRY": "1",
        "DO_NOT_TRACK": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
    })
    return env


def response_events(model, label, effort):
    reply = "Synthetic test reply for " + label
    item = {
        "id": "msg_" + uuid4().hex, "type": "message", "role": "assistant",
        "status": "completed",
        "content": [{"type": "output_text", "text": reply, "annotations": []}],
    }
    response = {
        "id": "resp_" + uuid4().hex, "object": "response", "created_at": 1,
        "model": model, "status": "completed", "output": [item],
        "reasoning": {"effort": effort},
        "usage": {
            "input_tokens": 12, "output_tokens": 6, "total_tokens": 18,
            "input_tokens_details": {"cached_tokens": 0},
            "output_tokens_details": {"reasoning_tokens": 0},
        },
    }
    frames = [
        {"type": "response.created", "response": {**response, "status": "in_progress", "output": []}},
        {"type": "response.output_item.added", "output_index": 0, "item": {**item, "content": []}},
        {"type": "response.content_part.added", "output_index": 0, "content_index": 0,
         "item_id": item["id"], "part": {"type": "output_text", "text": "", "annotations": []}},
        {"type": "response.output_text.delta", "output_index": 0, "content_index": 0,
         "item_id": item["id"], "delta": reply},
        {"type": "response.output_text.done", "output_index": 0, "content_index": 0,
         "item_id": item["id"], "text": reply},
        {"type": "response.content_part.done", "output_index": 0, "content_index": 0,
         "item_id": item["id"], "part": item["content"][0]},
        {"type": "response.output_item.done", "output_index": 0, "item": item},
        {"type": "response.completed", "response": response},
    ]
    return "".join(
        f"event: {event['type']}\ndata: {json.dumps({**event, 'sequence_number': index})}\n\n"
        for index, event in enumerate(frames)
    ).encode()


def input_text(items):
    if isinstance(items, str):
        return items
    pieces = []
    for item in items or []:
        if not isinstance(item, dict) or item.get("role") != "user":
            continue
        content = item.get("content", [])
        if isinstance(content, str):
            pieces.append(content)
        else:
            pieces.extend(block.get("text", "") for block in content if isinstance(block, dict))
    return "\n".join(pieces)


class MockHandler(http.server.BaseHTTPRequestHandler):
    timeout = 8

    def log_message(self, *_):
        pass

    def do_POST(self):
        if (
            self.path not in {"/v1/responses", "/v1/responses/input_tokens"}
            or self.headers.get("Authorization") != "Bearer " + self.server.key
        ):
            self.send_error(400)
            return
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= 2 * 1024 * 1024:
            self.send_error(413)
            return
        body = json.loads(self.rfile.read(length))
        labels = {
            "native-qa-independent-start": "independent-start",
            "native-qa-switch-turn": "switch-turn",
            "native-qa-default-turn": "default-turn",
        }
        user = input_text(body.get("input"))
        label = next((name for marker, name in labels.items() if marker in user), None)
        if label is None:
            self.send_error(422)
            return
        actual = {
            "label": label, "model": body.get("model"), "requestBytes": length,
            "effort": (body.get("reasoning") or {}).get("effort"),
        }
        if label == "switch-turn":
            actual["payloadShape"] = {
                "keys": sorted(body),
                "inputItems": [
                    {
                        "type": item.get("type"),
                        "role": item.get("role"),
                        "contentTypes": [entry.get("type") for entry in item.get("content", [])
                                         if isinstance(entry, dict)],
                    }
                    for item in body.get("input", []) if isinstance(item, dict)
                ],
                "tools": [{
                    "type": item.get("type"), "name": item.get("name"),
                    "fields": sorted(item),
                    **({"children": [{
                        "type": child.get("type"), "name": child.get("name"), "fields": sorted(child)
                    } for child in item.get("tools", [])]} if item.get("type") == "namespace" else {}),
                } for item in body.get("tools", [])],
                "topLevelNonNull": sorted(key for key, value in body.items() if value is not None),
                "opaqueInputCount": sum(
                    item.get("type") in {"reasoning", "item_reference"} or item.get("encrypted_content") is not None
                    for item in body.get("input", []) if isinstance(item, dict)
                ),
                "truncation": body.get("truncation"),
            }
        if self.path.endswith("/input_tokens"):
            count = 12_200
            with self.server.requests_lock:
                self.server.token_counts.append({**actual, "inputTokens": count})
            wire = json.dumps({"object": "response.input_tokens", "input_tokens": count}).encode()
            mime_type = "application/json"
        else:
            actual["maxOutputTokens"] = body.get("max_output_tokens")
            with self.server.requests_lock:
                self.server.requests.append(actual)
                if label in self.server.parallel_turns:
                    self.server.parallel_turns[label].set()
            if label in self.server.parallel_turns:
                peer = "independent-start" if label == "switch-turn" else "switch-turn"
                if not self.server.parallel_turns[peer].wait(8):
                    self.send_error(504)
                    return
            wire = response_events(actual["model"], label, actual["effort"])
            mime_type = "text/event-stream"
        self.send_response(200)
        self.send_header("Content-Type", mime_type)
        self.send_header("Content-Length", str(len(wire)))
        self.end_headers()
        self.wfile.write(wire)


class MockEndpoint(http.server.ThreadingHTTPServer):
    daemon_threads = False

    def __init__(self, key):
        self.key = key
        self.requests = []
        self.token_counts = []
        self.parallel_turns = {
            label: threading.Event() for label in ("switch-turn", "independent-start")
        }
        self.requests_lock = threading.Lock()
        super().__init__(("127.0.0.1", 0), MockHandler)


class AppServer:
    def __init__(self, binary, cwd, env):
        self.events = []
        self.inbox = Queue()
        self.sequence = 0
        self.process = subprocess.Popen(
            [str(binary), "app-server", "--listen", "stdio://"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            cwd=cwd, env=env, encoding="utf-8", errors="replace", text=True,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )

        def read():
            try:
                with self.process.stdout as output:
                    for line in output:
                        try:
                            self.inbox.put(json.loads(line))
                        except json.JSONDecodeError:
                            continue
            finally:
                self.inbox.put(None)

        self.reader = threading.Thread(target=read, name="codex-app-server-stdout")
        self.reader.start()

    def send(self, message):
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def expect(self, predicate, phase, seconds=35):
        end = time.monotonic() + seconds
        while True:
            for index, message in enumerate(self.events):
                if predicate(message):
                    return self.events.pop(index)
            remaining = end - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(phase)
            try:
                message = self.inbox.get(timeout=remaining)
            except Empty:
                raise TimeoutError(phase) from None
            if message is None:
                raise RuntimeError(phase + "_codex_exited")
            self.events.append(message)

    def call(self, method, params):
        self.sequence += 1
        request_id = self.sequence
        self.send({"id": request_id, "method": method, "params": params})
        msg = self.expect(lambda item: item.get("id") == request_id and "method" not in item,
                          method.replace("/", "_"))
        if "error" in msg:
            error = msg["error"]
            raise RuntimeError(f"{method}_json_rpc_{error.get('code')}")
        return msg["result"]

    def start_thread(self, cwd):
        result = self.call("thread/start", {
            "cwd": str(cwd), "ephemeral": True, "sandbox": "read-only",
            "approvalPolicy": "never",
        })
        return result

    def start_turn(self, thread_id, label, model=None, effort=None):
        params = {
            "threadId": thread_id,
            "input": [{"type": "text", "text": "Reply with synthetic text only. No tools. native-qa-" + label}],
        }
        if model is not None:
            params.update(model=model, effort=effort)
        return self.call("turn/start", params)["turn"]["id"]

    def completed(self, turn_id):
        result = self.expect(
            lambda item: item.get("method") == "turn/completed"
            and item.get("params", {}).get("turn", {}).get("id") == turn_id,
            "turn_completed",
        )
        turn = result["params"]["turn"]
        if turn["status"] != "completed":
            error = turn.get("error") or {}
            info = error.get("codexErrorInfo")
            if isinstance(info, dict):
                info = next(iter(info), None)
            status = info if isinstance(info, str) else turn["status"]
            diagnostic = str(error.get("message") or "")[:160]
            raise RuntimeError(f"native_turn_failed {status}: {diagnostic}")

    def usage(self, turn_id):
        return self.expect(
            lambda item: item.get("method") == "thread/tokenUsage/updated"
            and item.get("params", {}).get("turnId") == turn_id,
            "native_token_usage",
        )["params"]["tokenUsage"]

    def close(self):
        try:
            if not self.process.stdin.closed:
                self.process.stdin.close()
        finally:
            stop_process(self.process, wait_for_exit=True)
            self.reader.join(10)
            if self.reader.is_alive():
                raise RuntimeError("codex_stdout_reader_still_running")


def stop_process(process, wait_for_exit=False):
    if process is None or process.poll() is not None:
        return
    if wait_for_exit:
        try:
            process.wait(timeout=10)
            return
        except subprocess.TimeoutExpired:
            pass
    process.terminate()
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def cli(core, env, cwd, name, data=None, *arguments):
    result = subprocess.run(
        [str(core), name, *arguments], input=json.dumps(data).encode(), capture_output=True,
        cwd=cwd, env=env, timeout=25, creationflags=subprocess.CREATE_NO_WINDOW,
    )
    if result.returncode != 0:
        raise RuntimeError(f"core_{name}_{result.returncode}")
    return json.loads(result.stdout)


def wait_gateway(root, gateway):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for _ in range(60):
        if gateway.poll() is not None:
            raise RuntimeError("gateway_process_exited")
        try:
            route = json.loads((root / "ae/data/protocol-bridge.json").read_text("utf-8"))
            req = urllib.request.Request(f"http://127.0.0.1:{route['port']}/health")
            req.add_header("Authorization", "Bearer " + route["token"])
            with opener.open(req, timeout=.5) as reply:
                if reply.status == 204:
                    return
        except (OSError, ValueError):
            pass
        time.sleep(.1)
    raise TimeoutError("gateway_health")


def verify(expected, message):
    if not expected:
        raise AssertionError(message)


def run():
    args = options()
    root, owner = create_owned_fixture(WORKSPACE, PURPOSE)
    report = {
        "scope": "Official Codex stdio app-server and compiled AE gateway using a scripted loopback endpoint",
        "ownerId": owner, "coreSha256": args.core_sha256, "codexSha256": args.codex_sha256,
        "modelWindows": {DEFAULT: 120000, ALTERNATE: args.alternate_window},
        "checks": [], "passed": False, "realInferenceExecuted": False, "userProfileTouched": False,
    }
    gateway = app = upstream = listener = None
    phase = "prepare"
    try:
        env = native_env(root)
        profile = Path(env["CODEX_HOME"])
        workspace = root / "workspace"
        workspace.mkdir()
        core = Path(env["AE_SWITCH_PORTABLE_ROOT"]) / "AE-Switch-core.exe"
        shutil.copyfile(args.core, core)
        verify(hash_file(core) == args.core_sha256, "copied_core_hash")
        config_path = profile / "config.toml"
        original_config = (
            '# Original isolated fixture\n'
            'model = "original-fixture-model"\nmodel_context_window = 64000\n'
            'model_auto_compact_token_limit = 50000\nmodel_reasoning_effort = "medium"\n'
            'web_search = "disabled"\ncheck_for_update_on_startup = false\n'
            '[analytics]\nenabled = false\n[feedback]\nenabled = false\n'
            '[features]\nshell_snapshot = false\n'
        ).encode()
        config_path.write_bytes(original_config)
        history_path = profile / "history.jsonl"
        original_history = b'{"session_id":"isolated-history","ts":1,"text":"original fixture history"}\n'
        history_path.write_bytes(original_history)
        version = subprocess.run(
            [str(args.codex), "--version"], capture_output=True, check=True,
            cwd=workspace, env=env, timeout=12, creationflags=subprocess.CREATE_NO_WINDOW,
        ).stdout.decode("utf-8").strip()
        report["codexVersion"] = version
        upstream = MockEndpoint("synthetic-native-model-switch-" + owner)
        listener = threading.Thread(target=upstream.serve_forever, name="scripted-native-upstream")
        listener.start()
        phase = "save_synthetic_provider"
        provider = cli(core, env, workspace, "save-provider", {
            "family": "codex", "name": "Scripted native model switch",
            "baseUrl": f"http://127.0.0.1:{upstream.server_port}/v1",
            "apiKey": upstream.key, "authMode": "bearer", "model": DEFAULT, "reasoningEffort": "xhigh",
            "codexOptions": {
                "upstreamProtocol": "openai",
                "modelsSyncedAt": 1780000000,
                "models": [
                    {"id": DEFAULT, "contextWindow": 120000, "enabled": True,
                     "reasoningEfforts": ["low", "high", "xhigh"]},
                    {"id": ALTERNATE, "contextWindow": args.alternate_window, "enabled": True,
                     "reasoningEfforts": ["low", "high"]},
                    {"id": "gpt-disabled-test", "contextWindow": 90000, "enabled": False,
                     "reasoningEfforts": ["high"]},
                ],
            },
        })
        phase = "configure_native_directory"
        native = cli(core, env, workspace, "configure-profile", {
            "agentId": "codex", "providerId": provider["id"], "model": DEFAULT,
            "allowNativeModelSwitching": True,
            "profile": {
                "directory": str(profile), "homeDirectory": env["HOME"], "workspaceDirectory": str(workspace),
                "executablePath": str(args.codex),
            },
        })
        verify(native.get("allowNativeModelSwitching") is True, "mode_not_enabled")
        config = tomllib.loads(config_path.read_text("utf-8"))
        catalog_path = profile / "ae-switch-approved-models.json"
        verify(Path(config["model_catalog_json"]) == catalog_path, "catalog_not_owned")
        verify(all(key not in config for key in (
            "model_context_window", "model_auto_compact_token_limit", "model_reasoning_effort",
        )), "global_model_overrides_left_enabled")
        catalog_rows = json.loads(catalog_path.read_text("utf-8"))["models"]
        model_settings = {
            row["slug"]: {"window": row["context_window"], "compact": row["auto_compact_token_limit"]}
            for row in catalog_rows
        }
        verify(model_settings == {
            DEFAULT: {"window": 120_000, "compact": 96_000},
            ALTERNATE: {"window": args.alternate_window, "compact": args.alternate_window * 80 // 100},
        }, "incorrect_native_catalog_context_or_compaction")
        report["nativeCatalogContext"] = model_settings
        report["checks"].append("AE configured only the approved native models and per-model 80% compaction")
        phase = "gateway_and_catalog"
        gateway = subprocess.Popen(
            [str(core), "serve"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            cwd=workspace, env=env, creationflags=subprocess.CREATE_NO_WINDOW,
        )
        wait_gateway(root, gateway)
        app = AppServer(args.codex, workspace, env)
        app.call("initialize", {
            "clientInfo": {"name": "ae_native_switch_e2e", "title": "AE native switch E2E", "version": "1.0.0"},
            "capabilities": {"experimentalApi": True},
        })
        app.send({"method": "initialized"})
        catalog = app.call("model/list", {"limit": 100, "includeHidden": False})["data"]
        actual_ids = sorted(entry["model"] if "model" in entry else entry["id"] for entry in catalog)
        verify(actual_ids == sorted((DEFAULT, ALTERNATE)), "unexpected_native_picker_catalog")
        saved = app.call("config/read", {"includeLayers": False})["config"]
        verify(saved["model"] == DEFAULT, "startup_model_changed")
        verify(saved["model_provider"] == "ae_switch", "startup_provider_changed")
        report["catalog"] = actual_ids
        by_id = {(entry.get("model") or entry["id"]): entry for entry in catalog}
        for ident, effort in [(DEFAULT, "xhigh"), (ALTERNATE, "high")]:
            verify(any(level.get("reasoningEffort") == effort
                       for level in by_id[ident].get("supportedReasoningEfforts", [])),
                   "picker_missing_expected_reasoning_effort")
        report["checks"].append("Actual Codex picker lists exactly two enabled models and their declared efforts")
        phase = "default_turn"
        first = app.start_thread(workspace)
        verify(first["model"] == DEFAULT, "first_thread_default")
        first_id = first["thread"]["id"]
        turn_default = app.start_turn(first_id, "default-turn")
        app.completed(turn_default)
        phase = "switch_and_independent"
        turn_switch = app.start_turn(first_id, "switch-turn", ALTERNATE, "high")
        independent = app.start_thread(workspace)
        verify(independent["model"] == DEFAULT, "new_thread_did_not_keep_startup_model")
        turn_independent = app.start_turn(independent["thread"]["id"], "independent-start")
        app.completed(turn_switch)
        app.completed(turn_independent)
        phase = "usage_and_context"
        windows = {}
        for name, turn, model in [
            ("default", turn_default, DEFAULT),
            ("alternate", turn_switch, ALTERNATE),
            ("independent", turn_independent, DEFAULT),
        ]:
            native_usage = app.usage(turn)
            windows[name] = native_usage.get("modelContextWindow")
            verify(windows[name] == model_settings[model]["window"] * 95 // 100,
                   f"wrong_usable_window_{name}_{windows[name]}")
            verify(native_usage["last"]["inputTokens"] == 12
                   and native_usage["last"]["outputTokens"] == 6, f"incorrect_native_usage_{name}")
        report["nativeUsableWindows"] = windows

        activity = cli(core, env, workspace, "activity", None, "codex")["records"]
        activity_models = {}
        for row in activity:
            model = row["model"]
            effort = "xhigh" if model == DEFAULT else "high"
            verify(
                row["endpoint"] == "responses" and row["configuredModel"] == model
                and row["reportedModel"] == model and row["configuredEffort"] == effort
                and row["reportedEffort"] == effort and row["state"] == "completed"
                and row["usage"]["inputTokens"] == 12 and row["usage"]["outputTokens"] == 6,
                "incorrect_gateway_activity_metadata",
            )
            activity_models[model] = 1 + activity_models.get(model, 0)
        verify(activity_models == {DEFAULT: 2, ALTERNATE: 1}, "wrong_activity_row_count")
        report["gatewayActivityModels"] = activity_models
        report["checks"].append("Native usable windows and synthetic response usage agree with gateway activity")

        observed = {
            (row["label"], row["model"], row["effort"]) for row in upstream.requests
        }
        verify(observed == {
            ("default-turn", DEFAULT, "xhigh"),
            ("switch-turn", ALTERNATE, "high"),
            ("independent-start", DEFAULT, "xhigh"),
        } and len(upstream.requests) == 3, "actual_model_reasoning_or_count_mismatch")
        verify(app.call("config/read", {"includeLayers": False})["config"]["model"] == DEFAULT,
               "native_turn_overwrote_startup_model")
        if args.alternate_window == 80_000:
            verify(len(upstream.token_counts) == 1, "expected_one_alternate_token_count")
            count = upstream.token_counts[0]
            verify(count["label"] == "switch-turn" and count["model"] == ALTERNATE
                   and count["inputTokens"] == 12_200, "incorrect_counted_model_or_turn")
            switched = next(row for row in upstream.requests if row["label"] == "switch-turn")
            verify(0 < switched["maxOutputTokens"] <= args.alternate_window - count["inputTokens"],
                   "counted_turn_missing_bounded_output")
            report["checks"].append("The alternate 80K model used its own input token count and bounded output")
        report["checks"].extend([
            "Codex changed models on the same thread through its native turn API",
            "Both model IDs and independent reasoning values arrived at the scripted HTTP upstream",
            "Independent default and alternate requests overlapped without changing persisted startup model",
        ])

        phase = "disconnect_and_restore"
        app.close()
        app = None
        stop_process(gateway)
        gateway = None
        safety = cli(core, env, workspace, "configuration-safety", None, "codex")
        verify(safety["status"] == "healthy", "native_profile_drifted")
        preview = cli(core, env, workspace, "preview-disconnect", None, "codex")
        verify(preview["canDisconnect"] is True and isinstance(preview["previewToken"], str),
               "disconnect_preview_denied")
        disconnected = cli(core, env, workspace, "disconnect-agent", {
            "agentId": "codex", "previewToken": preview["previewToken"],
        })
        verify(disconnected.get("disconnected") is True, "disconnect_not_confirmed")
        verify(config_path.read_bytes() == original_config, "disconnect_did_not_restore_original_config")
        verify(history_path.read_bytes() == original_history, "isolated_original_history_changed")
        verify(not catalog_path.exists(), "disconnect_left_owned_catalog")
        verify("codex" not in json.loads((root / "ae/data/agent-selection.json").read_text("utf-8")),
               "disconnect_left_agent_selection")
        report["checks"].append("Disconnect restored original config and history bytes and removed only the owned catalog")
        verify(hash_file(args.codex) == args.codex_sha256, "native_executable_bytes_changed")
        report["passed"] = True
    except (OSError, AssertionError, KeyError, RuntimeError, subprocess.SubprocessError, ValueError) as error:
        report["failure"] = {"phase": phase, "kind": type(error).__name__}
        if isinstance(error, (AssertionError, RuntimeError, TimeoutError)):
            report["failure"]["reason"] = str(error)[:120]
    finally:
        if upstream is not None:
            report["observedSyntheticUpstreamRequests"] = upstream.requests
            report["observedSyntheticInputCounts"] = upstream.token_counts
        failures = []
        for name, close in [
            ("codex", lambda: app.close() if app else None),
            ("gateway", lambda: stop_process(gateway)),
        ]:
            try:
                close()
            except (OSError, RuntimeError, subprocess.SubprocessError):
                failures.append(name + "_exit_failed")
        if upstream is not None:
            try:
                if listener.is_alive():
                    upstream.shutdown()
                    listener.join(8)
                upstream.server_close()
                if listener.is_alive():
                    failures.append("loopback_server_exit_failed")
            except OSError:
                failures.append("loopback_server_exit_failed")
        report["ownedProcessesExited"] = not failures
        report["ownedRootRemoved"] = False
        if not failures:
            try:
                cleanup_owned_fixture(root, owner, PURPOSE)
                report["ownedRootRemoved"] = not root.exists()
            except (OSError, ValueError) as error:
                failures.append(type(error).__name__)
        if not report["ownedRootRemoved"]:
            failures.append("owned_fixture_retained")
        if failures:
            report["passed"] = False
            report["cleanupFailures"] = failures
        write_receipt(args.report, report)
        print(json.dumps(report, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(run())