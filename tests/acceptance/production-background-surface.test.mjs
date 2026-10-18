import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  assertEmergencyCleanupEligible,
  assertRegistrySnapshot,
  verifyBackgroundRoundTrip,
} from "./production-background-surface.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const expectedCommand = '"G:\\synthetic-owned\\AE-Switch.exe" --background';
const binding = {
  expectedCommand,
  expectedCommandSha256: sha(expectedCommand),
};
function snapshot(present = false, foreign = false) {
  const otherValues = [
    {
      nameSha256: sha("Other"),
      kind: "String",
      dataSha256: sha("synthetic data"),
    },
  ];
  return {
    schemaVersion: 1,
    hive: "HKEY_CURRENT_USER",
    registryView: "Registry64",
    subkey: "Software\\Microsoft\\Windows\\CurrentVersion\\Run",
    valueName: "AE Switch",
    keyPresent: true,
    target: present
      ? {
          present: true,
          kind: "String",
          registryType: "REG_SZ",
          commandSha256: sha(foreign ? "foreign command" : expectedCommand),
        }
      : { present: false },
    otherValues,
    otherEntryCount: otherValues.length,
    otherValuesSha256: sha(JSON.stringify(otherValues)),
  };
}
function fixture({
  existing = false,
  disableFailure = false,
  enableFailureAfterWrite = false,
  foreignRace = false,
  otherDrift = false,
} = {}) {
  let registry = snapshot(existing);
  let checked = false;
  let waiter;
  let requestListener;
  const clicks = [];
  let emergencyCalls = 0;
  const checkbox = {
    count: async () => 1,
    waitFor: async () => {},
    isEnabled: async () => true,
    isChecked: async () => checked,
    setChecked: async (enabled) => {
      assert.notEqual(
        checked,
        enabled,
        "A mock native event needs an actual checkbox transition",
      );
      clicks.push(enabled);
      const request = {
        method: () => "POST",
        url: () => "http://ipc.localhost/set_background_start",
        postDataJSON: () => ({ enabled }),
      };
      requestListener(request);
      let ok = true;
      if (foreignRace && enabled) {
        registry = snapshot(true, true);
        ok = false;
      } else if (!enabled && disableFailure) ok = false;
      else {
        registry = snapshot(enabled);
        if (otherDrift && enabled) {
          registry.otherValues[0].dataSha256 = sha("concurrently changed");
          registry.otherValuesSha256 = sha(
            JSON.stringify(registry.otherValues),
          );
        }
        if (enableFailureAfterWrite && enabled) ok = false;
      }
      if (ok) checked = enabled;
      const response = {
        request: () => request,
        headerValue: async () => (ok ? "ok" : "error"),
        json: async () =>
          ok ? { supported: true, enabled } : { code: "synthetic failure" },
      };
      assert.ok(waiter(response));
    },
  };
  checkbox.click = () => checkbox.setChecked(!checked);
  const page = {
    getByRole: () => checkbox,
    on: (event, listener) => {
      assert.equal(event, "request");
      requestListener = listener;
    },
    off: (event, listener) => {
      assert.equal(event, "request");
      assert.equal(requestListener, listener);
      requestListener = undefined;
    },
    waitForResponse: (predicate) =>
      new Promise((resolve) => {
        waiter = (response) => {
          if (predicate(response)) {
            resolve(response);
            return true;
          }
          return false;
        };
      }),
  };
  const inputs = {
    page,
    binding,
    readonlyNative: async (command) => {
      assert.equal(command, "get_background_settings");
      return {
        supported: true,
        enabled:
          registry.target.present &&
          registry.target.commandSha256 === binding.expectedCommandSha256,
      };
    },
    readRegistry: async () => structuredClone(registry),
    emergencyCleanup: async () => {
      emergencyCalls++;
      assertEmergencyCleanupEligible(snapshot(), registry, binding);
      registry = snapshot();
      return { removed: true, exactOwnedValueOnly: true };
    },
  };
  return {
    inputs,
    clicks,
    emergencyCalls: () => emergencyCalls,
    registry: () => registry,
  };
}

test("actual UI transitions need matching native receipts, registry type/command and independent reads", async () => {
  const value = fixture();
  const result = await verifyBackgroundRoundTrip(value.inputs);
  assert.equal(result.passed, true);
  assert.equal(result.status, "passed");
  assert.deepEqual(value.clicks, [true, false]);
  assert.equal(result.uiRequests.length, 2);
  assert.equal(result.restoration.baselineRestored, true);
  assert.equal(result.otherEntriesUnchanged, true);
  assert.equal(result.windowsLoginExecuted, false);
  assert.equal(result.windowsLoginAutostartClaimed, false);
});

test("an existing same-name value is retained without any checkbox mutation", async () => {
  const value = fixture({ existing: true });
  const result = await verifyBackgroundRoundTrip(value.inputs);
  assert.equal(result.status, "conflict");
  assert.equal(result.passed, false);
  assert.deepEqual(value.clicks, []);
  assert.equal(value.emergencyCalls(), 0);
  assert.equal(value.registry().target.present, true);
});

test("failed UI removal may use exact-value cleanup but cannot pass", async () => {
  const value = fixture({ disableFailure: true });
  const result = await verifyBackgroundRoundTrip(value.inputs);
  assert.equal(result.passed, false);
  assert.equal(result.restoration.emergencyUsed, true);
  assert.equal(result.restoration.baselineRestored, true);
  assert.equal(value.emergencyCalls(), 1);
});

test("a UI enable failure after writing still attempts UI recovery before emergency cleanup", async () => {
  const value = fixture({ enableFailureAfterWrite: true });
  const result = await verifyBackgroundRoundTrip(value.inputs);
  assert.equal(result.passed, false);
  assert.equal(result.restoration.uiRecoveryAttempted, true);
  assert.equal(result.restoration.emergencyUsed, true);
  assert.equal(result.restoration.baselineRestored, true);
});

test("a foreign value racing the UI is never removed", async () => {
  const value = fixture({ foreignRace: true });
  const result = await verifyBackgroundRoundTrip(value.inputs);
  assert.equal(result.passed, false);
  assert.equal(result.restoration.baselineRestored, false);
  assert.equal(value.emergencyCalls(), 0);
  assert.deepEqual(value.clicks, [true]);
});

test("changed other entries fail even when target cleanup restores its baseline", async () => {
  const value = fixture({ otherDrift: true });
  const result = await verifyBackgroundRoundTrip(value.inputs);
  assert.equal(result.passed, false);
  assert.equal(result.otherEntriesUnchanged, false);
  assert.equal(result.restoration.baselineRestored, true);
});

test("unsupported native settings and a missing Run key are unvalidated without writes", async () => {
  for (const missingKey of [false, true]) {
    const value = fixture();
    if (missingKey)
      value.inputs.readRegistry = async () => ({
        ...snapshot(),
        keyPresent: false,
        otherValues: [],
        otherEntryCount: 0,
        otherValuesSha256: sha("[]"),
      });
    else
      value.inputs.readonlyNative = async () => ({
        supported: false,
        enabled: false,
      });
    const result = await verifyBackgroundRoundTrip(value.inputs);
    assert.equal(result.status, "unvalidated");
    assert.deepEqual(value.clicks, []);
  }
});

test("emergency cleanup rejects existing baseline, foreign command and wrong registry type", () => {
  assert.doesNotThrow(() =>
    assertEmergencyCleanupEligible(snapshot(), snapshot(true), binding),
  );
  assert.throws(() =>
    assertEmergencyCleanupEligible(snapshot(true), snapshot(true), binding),
  );
  assert.throws(() =>
    assertEmergencyCleanupEligible(snapshot(), snapshot(true, true), binding),
  );
  const wrongType = snapshot(true);
  wrongType.target.kind = "ExpandString";
  wrongType.target.registryType = "REG_EXPAND_SZ";
  assert.throws(() =>
    assertEmergencyCleanupEligible(snapshot(), wrongType, binding),
  );
});

test("registry snapshots reject wrong hive/view/path and unhashed other data", () => {
  for (const [name, value] of [
    ["hive", "HKEY_LOCAL_MACHINE"],
    ["registryView", "Registry32"],
    ["subkey", "other"],
    ["valueName", "other"],
    ["otherValuesSha256", "0".repeat(64)],
  ]) {
    const record = snapshot();
    record[name] = value;
    assert.throws(() => assertRegistrySnapshot(record));
  }
});

test(
  "read-only registry helper has no value mutation and emergency guards validate G-only fixture bytes",
  { skip: process.platform !== "win32" },
  () => {
    const workspace = path.resolve(
      fileURLToPath(new URL("../../", import.meta.url)),
    );
    const readScript = fileURLToPath(
      new URL("./production-background-registry.ps1", import.meta.url),
    );
    assert.doesNotMatch(
      fs.readFileSync(readScript, "utf8"),
      /DeleteValue|SetValue|CreateSubKey|Remove-Item|New-Item/u,
    );
    const ownerId = randomUUID().replaceAll("-", "");
    const root = path.join(workspace, ".cache/native-e2e-sandbox", ownerId);
    assert.equal(fs.existsSync(root), false);
    fs.mkdirSync(root, { recursive: true });
    const exe = path.join(root, "portable/AE-Switch.exe");
    fs.mkdirSync(path.dirname(exe));
    fs.writeFileSync(exe, "synthetic executable fixture, never launched");
    const productionSha256 = sha(fs.readFileSync(exe));
    const sourceDigest = "2".repeat(64),
      buildAuditId = "3".repeat(32);
    const owner = {
      schemaVersion: 2,
      ownerId,
      workspace,
      productionSha256,
      sourceDigest,
      buildAuditId,
    };
    const baselineFile = path.join(root, "background-registry-baseline.json");
    fs.writeFileSync(
      path.join(root, ".ae-production-ui-eight-owner.json"),
      JSON.stringify(owner),
    );
    fs.writeFileSync(baselineFile, JSON.stringify(snapshot()));
    const proof = {
      schemaVersion: 1,
      ownerId,
      workspace,
      root,
      productionProgram: exe,
      productionSha256,
      sourceDigest,
      buildAuditId,
      expectedCommandSha256: sha('"' + exe + '" --background'),
      baselineFile,
      baselineSha256: sha(fs.readFileSync(baselineFile)),
    };
    const bindingFile = path.join(root, "background-emergency-binding.json");
    const systemPowerShell = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    );
    const emergencyScript = fileURLToPath(
      new URL("./restore-production-background.ps1", import.meta.url),
    );
    const invoke = () =>
      execFileSync(
        systemPowerShell,
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          emergencyScript,
          "-BindingFile",
          bindingFile,
          "-ValidateOnly",
        ],
        { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] },
      );
    try {
      fs.writeFileSync(bindingFile, JSON.stringify(proof));
      assert.equal(
        JSON.parse(invoke().replace(/^\uFEFF/u, "")).registryAccessed,
        false,
      );
      const baselineBytes = fs.readFileSync(baselineFile);
      fs.writeFileSync(baselineFile, JSON.stringify(snapshot(true)));
      fs.writeFileSync(
        bindingFile,
        JSON.stringify({
          ...proof,
          baselineSha256: sha(fs.readFileSync(baselineFile)),
        }),
      );
      assert.throws(invoke);
      fs.writeFileSync(baselineFile, baselineBytes);
      fs.writeFileSync(
        bindingFile,
        JSON.stringify({ ...proof, expectedCommandSha256: "0".repeat(64) }),
      );
      assert.throws(invoke);
      fs.writeFileSync(bindingFile, JSON.stringify(proof));
      fs.writeFileSync(
        path.join(root, ".ae-production-ui-eight-owner.json"),
        JSON.stringify({ ...owner, sourceDigest: "f".repeat(64) }),
      );
      assert.throws(invoke);
      fs.writeFileSync(
        path.join(root, ".ae-production-ui-eight-owner.json"),
        JSON.stringify(owner),
      );
      fs.appendFileSync(exe, "changed");
      assert.throws(invoke);
    } finally {
      assert.equal(
        path.resolve(root),
        path.join(workspace, ".cache/native-e2e-sandbox", ownerId),
      );
      fs.rmSync(root, { recursive: true });
    }
  },
);
