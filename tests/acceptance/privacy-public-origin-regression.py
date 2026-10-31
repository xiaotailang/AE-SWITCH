"""A public default endpoint exemption must never exempt its API key."""
import importlib.util
import json
from pathlib import Path
import tempfile

workspace = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("artifact_privacy", Path(__file__).with_name("audit-private-artifacts.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory(prefix="privacy-origin-", dir=workspace / ".cache/tmp") as directory:
    private = Path(directory) / "synthetic-input.txt"
    private.write_text("endpoint: https://default.example\napi-key: synthetic-public-origin-test-secret\nendpoint: https://private.example\n", encoding="utf-8")
    patterns, key_count, endpoint_count = module.private_patterns([private], ["https://default.example"])
    assert key_count == 1
    assert b"synthetic-public-origin-test-secret" in patterns
    assert b"https://default.example" not in patterns
    assert b"private.example" in patterns
    private.write_text("endpoint: https://default.example?token=synthetic-value\napi-key: synthetic-public-origin-test-secret\n", encoding="utf-8")
    patterns, _, _ = module.private_patterns([private], ["https://default.example"])
    assert b"https://default.example?token=synthetic-value" in patterns
report = {"passed": True, "publicOriginOnlyExcluded": True, "apiKeyStillScanned": True, "queryCredentialStillPrivate": True, "scope": "synthetic public origin exception regression"}
output = workspace / "artifacts/acceptance/core-features-20261030/privacy-public-origin-regression.json"
output.write_text(json.dumps(report, indent=2), encoding="utf-8")
print(json.dumps(report))
