"""One bounded read-only DNS/TCP/TLS/models observation; no inference or retries."""
import argparse
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from datetime import datetime, timezone
import hashlib
import http.client
import json
from pathlib import Path
import re
import socket
import ssl
import sys
import time
import urllib.parse

from importlib.util import spec_from_file_location, module_from_spec
spec = spec_from_file_location("artifact_privacy", Path(__file__).with_name("audit-private-artifacts.py"))
privacy = module_from_spec(spec)
spec.loader.exec_module(privacy)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--private-input", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--report", required=True)
    options = parser.parse_args()
    private_file = privacy.guard(options.private_input)
    report_file = privacy.guard(options.report, missing=True)
    if report_file.exists():
        raise ValueError("Fresh report required")
    lines = private_file.read_text(encoding="utf-8-sig").splitlines()
    blocks = []
    for index, line in enumerate(lines):
        match = re.search(r'https?://[^\s"<>]+', line)
        if match:
            blocks.append({"line": index + 1, "url": match.group().rstrip(",;，；。/"), "keys": []})
        key = re.match(r"\s*api[-_ ]?key\s*[:：]\s*(.+)", line, re.I)
        if key and blocks:
            blocks[-1]["keys"].append((index + 1, key.group(1).strip()))
    if not blocks or not blocks[-1]["keys"]:
        raise ValueError("Missing final designated connection block")
    selected = blocks[-1]
    parsed = urllib.parse.urlsplit(selected["url"])
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Ordinary HTTPS endpoint required")
    # The user explicitly selected the final krill block. No other endpoint is probed.
    if "krill" not in parsed.hostname.lower():
        raise ValueError("The final designated block is not the requested supplier")
    key_line, key = selected["keys"][-1]
    models_path = parsed.path.rstrip("/")
    models_path = models_path + "/models" if models_path.endswith("/v1") else models_path + "/v1/models"
    report = {
        "schemaVersion": 1, "recordedAt": datetime.now(timezone.utc).isoformat(),
        "scope": "One direct DNS/TCP/TLS observation and one authenticated GET models request against the final designated supplier block; no inference",
        "model": options.model, "privateInputSha256": hashlib.sha256(private_file.read_bytes()).hexdigest(),
        "privateInputEndpointLine": selected["line"], "privateInputKeyLine": key_line,
        "supplierSelection": "last explicit krill block", "attempts": 1,
        "proxyUsed": False, "fallbackEndpointUsed": False, "fallbackModelUsed": False,
        "inferenceRequests": 0, "dns": {"passed": False}, "tcp": {"passed": False},
        "tls": {"passed": False}, "http": {"observed": False},
        "selectedModelListed": None, "reasoningEfforts": {"state": "unknown", "values": []},
        "passed": False,
    }
    start = time.monotonic()
    deadline = start + 35
    pool = ThreadPoolExecutor(max_workers=1)
    sock = None
    try:
        future = pool.submit(socket.getaddrinfo, parsed.hostname, parsed.port or 443, 0, socket.SOCK_STREAM)
        addresses = future.result(timeout=8)
        report["dns"] = {"passed": True, "addressCount": len(addresses), "milliseconds": round((time.monotonic() - start) * 1000)}
        family, sock_type, protocol, _canonical, address = addresses[0]
        sock = socket.socket(family, sock_type, protocol)
        sock.settimeout(max(0.1, min(8, deadline - time.monotonic())))
        tcp_start = time.monotonic()
        sock.connect(address)
        report["tcp"] = {"passed": True, "milliseconds": round((time.monotonic() - tcp_start) * 1000)}
        sock.settimeout(max(0.1, min(8, deadline - time.monotonic())))
        tls_start = time.monotonic()
        sock = ssl.create_default_context().wrap_socket(sock, server_hostname=parsed.hostname)
        report["tls"] = {"passed": True, "version": sock.version(), "certificateVerified": True, "milliseconds": round((time.monotonic() - tls_start) * 1000)}
        request = f"GET {models_path} HTTP/1.1\r\nHost: {parsed.netloc}\r\nAuthorization: Bearer {key}\r\nAccept: application/json\r\nConnection: close\r\nUser-Agent: AE-Switch-readonly-model-preflight\r\n\r\n".encode("utf-8")
        sock.sendall(request)
        sock.settimeout(max(0.1, min(10, deadline - time.monotonic())))
        response = http.client.HTTPResponse(sock)
        response.begin()
        body = response.read(2 * 1024 * 1024 + 1)
        report["http"] = {"observed": True, "status": response.status, "responseBytes": len(body), "responseSha256": hashlib.sha256(body).hexdigest(), "bodyRetained": False}
        if len(body) > 2 * 1024 * 1024:
            report["http"]["overLimit"] = True
        elif response.status == 200:
            payload = json.loads(body)
            models = payload.get("data", payload.get("models", []))
            report["http"]["modelCount"] = len(models) if isinstance(models, list) else None
            matching = next((item for item in models if isinstance(item, dict) and item.get("id") == options.model), None) if isinstance(models, list) else None
            report["selectedModelListed"] = matching is not None
            if matching:
                efforts = matching.get("reasoningEfforts", matching.get("reasoning_efforts"))
                allowed = {"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"}
                if isinstance(efforts, list) and all(item in allowed for item in efforts):
                    report["reasoningEfforts"] = {"state": "declared", "values": efforts}
            report["passed"] = matching is not None
    except TimeoutError:
        report["failure"] = {"kind": "TimeoutError", "stage": "dns"}
    except Exception as error:
        stage = "dns" if not report["dns"]["passed"] else "tcp" if not report["tcp"]["passed"] else "tls" if not report["tls"]["passed"] else "http"
        report["failure"] = {"kind": type(error).__name__, "stage": stage, "errno": getattr(error, "errno", None), "rawMessageRetained": False}
    finally:
        if sock:
            sock.close()
        pool.shutdown(wait=False, cancel_futures=True)
        report["milliseconds"] = round((time.monotonic() - start) * 1000)
        report_file.parent.mkdir(parents=True, exist_ok=True)
        report_file.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({name: report[name] for name in ["passed", "dns", "tcp", "tls", "http", "selectedModelListed", "reasoningEfforts", "milliseconds"]}))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print("Private endpoint preflight could not complete; raw exception content was suppressed.", file=sys.stderr)
        sys.exit(1)
