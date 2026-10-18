import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { isNativeRequest } from "./production-ui-eight-contract.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const execute = promisify(execFile);
const samePath = (left, right) =>
  path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
const checkboxName = "随 Windows 启动，在后台运行";
const hashPattern = /^[a-f0-9]{64}$/u;

export function assertRegistrySnapshot(record) {
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.hive, "HKEY_CURRENT_USER");
  assert.equal(record.registryView, "Registry64");
  assert.equal(
    record.subkey,
    "Software\\Microsoft\\Windows\\CurrentVersion\\Run",
  );
  assert.equal(record.valueName, "AE Switch");
  assert.equal(typeof record.keyPresent, "boolean");
  assert.equal(typeof record.target?.present, "boolean");
  assert.ok(Array.isArray(record.otherValues));
  assert.equal(record.otherEntryCount, record.otherValues.length);
  assert.equal(
    new Set(record.otherValues.map((row) => row.nameSha256)).size,
    record.otherValues.length,
  );
  for (const row of record.otherValues) {
    assert.match(row.nameSha256, hashPattern);
    assert.match(row.dataSha256, hashPattern);
    assert.equal(typeof row.kind, "string");
  }
  assert.equal(
    record.otherValuesSha256,
    sha(JSON.stringify(record.otherValues)),
  );
  if (!record.keyPresent) {
    assert.equal(record.target.present, false);
    assert.deepEqual(record.otherValues, []);
  }
  return record;
}

function ownedValue(record, binding) {
  return (
    record.target.present === true &&
    record.target.kind === "String" &&
    record.target.registryType === "REG_SZ" &&
    record.target.commandSha256 === binding.expectedCommandSha256
  );
}

export function assertEmergencyCleanupEligible(baseline, current, binding) {
  assertRegistrySnapshot(baseline);
  assertRegistrySnapshot(current);
  assert.equal(
    baseline.target.present,
    false,
    "A pre-existing startup value cannot be removed",
  );
  assert.equal(baseline.keyPresent, true);
  assert.equal(binding.expectedCommandSha256, sha(binding.expectedCommand));
  assert.equal(
    ownedValue(current, binding),
    true,
    "Only the exact owned REG_SZ startup command may be removed",
  );
}

// Shared logic is exercised with synthetic UI/registry fixtures; production supplies only real helpers.
export async function verifyBackgroundRoundTrip({
  page,
  readonlyNative,
  readRegistry,
  emergencyCleanup,
  binding,
}) {
  const report = {
    schemaVersion: 1,
    scope:
      "Actual UI autostart enable/disable with independent HKCU Run readback; Windows login is not exercised",
    startedAt: new Date().toISOString(),
    expectedCommandSha256: binding.expectedCommandSha256,
    passed: false,
    status: "unvalidated",
    uiRequests: [],
    windowsLoginExecuted: false,
    windowsLoginAutostartClaimed: false,
    restoration: {
      uiRecoveryAttempted: false,
      emergencyUsed: false,
      baselineRestored: false,
    },
  };
  let baseline,
    mutationAttempted = false,
    checkbox;
  let otherEntriesUnchanged = true;
  const read = async () => {
    const record = assertRegistrySnapshot(await readRegistry());
    if (baseline && record.otherValuesSha256 !== baseline.otherValuesSha256)
      otherEntriesUnchanged = false;
    return record;
  };
  async function toggle(enabled, recovery = false) {
    assert.equal(
      await checkbox.isEnabled(),
      true,
      "Native background checkbox is not ready",
    );
    assert.notEqual(
      await checkbox.isChecked(),
      enabled,
      "A real UI transition is required",
    );
    const startedAt = new Date().toISOString();
    const requests = [];
    const onRequest = (request) => {
      if (isNativeRequest(request, "set_background_start"))
        requests.push(request);
    };
    page.on("request", onRequest);
    const observed = page.waitForResponse(
      (response) =>
        requests.includes(response.request()) &&
        isNativeRequest(response.request(), "set_background_start"),
      { timeout: 15000 },
    );
    observed.catch(() => {});
    let response;
    try {
      await checkbox.click({ timeout: 15000 });
      response = await observed;
    } finally {
      page.off("request", onRequest);
    }
    const input = response.request().postDataJSON();
    const result = await response.json();
    const status = await response.headerValue("Tauri-Response");
    report.uiRequests.push({
      command: "set_background_start",
      invocationSurface: "ui-checkbox",
      actualUiRequestObserved: true,
      method: response.request().method(),
      url: response.request().url(),
      startedAt,
      finishedAt: new Date().toISOString(),
      input,
      tauriResponse: status,
      result,
      recovery,
    });
    assert.equal(
      requests.length,
      1,
      "A checkbox transition must emit exactly one native request",
    );
    assert.deepEqual(input, { enabled });
    assert.equal(status, "ok", "Background UI mutation was rejected");
    assert.deepEqual(result, { supported: true, enabled });
    const readyDeadline = Date.now() + 15000;
    while (
      !(await checkbox.isEnabled()) ||
      (await checkbox.isChecked()) !== enabled
    ) {
      assert.ok(
        Date.now() < readyDeadline,
        "Background checkbox did not settle after native response",
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(await checkbox.isChecked(), enabled);
  }
  try {
    baseline = report.baseline = await read();
    if (baseline.target.present) {
      report.status = "conflict";
      report.reason =
        "The existing AE Switch startup value was retained; this run requires an absent target baseline";
      return report;
    }
    if (!baseline.keyPresent) {
      report.reason =
        "The Run key is absent; the UI would create a key whose full baseline restoration is outside this value-only scope";
      return report;
    }
    report.nativeBefore = await readonlyNative("get_background_settings");
    if (report.nativeBefore.supported !== true) {
      report.reason = "Native system integration is unsupported or isolated";
      return report;
    }
    assert.equal(report.nativeBefore.enabled, false);
    checkbox = page.getByRole("checkbox", { name: checkboxName, exact: true });
    if (!(await checkbox.count()))
      await page.getByRole("button", { name: "快速上手", exact: true }).click();
    await checkbox.waitFor({ state: "visible", timeout: 15000 });
    assert.equal(await checkbox.isChecked(), false);
    assert.equal(
      (await read()).target.present,
      false,
      "Startup baseline changed before the UI write",
    );
    mutationAttempted = true;
    await toggle(true);
    report.enabledRegistry = await read();
    assert.equal(
      ownedValue(report.enabledRegistry, binding),
      true,
      "Enabled startup value type or exact command differs",
    );
    report.nativeEnabled = await readonlyNative("get_background_settings");
    assert.deepEqual(report.nativeEnabled, { supported: true, enabled: true });
    assert.equal(otherEntriesUnchanged, true, "Other startup entries changed");
    await toggle(false);
    report.disabledRegistry = await read();
    assert.equal(report.disabledRegistry.target.present, false);
    report.nativeDisabled = await readonlyNative("get_background_settings");
    assert.deepEqual(report.nativeDisabled, {
      supported: true,
      enabled: false,
    });
    report.uiRoundTripCompleted = true;
  } catch (error) {
    report.status = "failed";
    report.failure = error.message;
  } finally {
    if (baseline && mutationAttempted) {
      try {
        let current = await read();
        if (current.target.present) {
          assertEmergencyCleanupEligible(baseline, current, binding);
          report.restoration.uiRecoveryAttempted = true;
          try {
            // A failed mutation can leave the controlled checkbox stale. Resync through its real UI first.
            if (!(await checkbox.isChecked())) await toggle(true, true);
            await toggle(false, true);
            report.restoration.nativeUiRestored = true;
          } catch (error) {
            report.restoration.uiFailure = error.message;
          }
          current = await read();
          if (current.target.present) {
            assertEmergencyCleanupEligible(baseline, current, binding);
            report.restoration.emergencyUsed = true;
            report.restoration.emergencyReceipt = await emergencyCleanup();
            assert.equal(report.restoration.emergencyReceipt.removed, true);
            assert.equal(
              report.restoration.emergencyReceipt.exactOwnedValueOnly,
              true,
            );
            current = await read();
          }
        }
        report.restoration.finalRegistry = current;
        report.restoration.baselineRestored =
          current.target.present === false &&
          current.keyPresent === baseline.keyPresent;
      } catch (error) {
        report.restoration.failure = error.message;
      }
    }
    report.otherEntriesUnchanged = otherEntriesUnchanged;
    report.passed =
      report.uiRoundTripCompleted === true &&
      report.restoration.baselineRestored === true &&
      otherEntriesUnchanged &&
      !report.restoration.emergencyUsed &&
      !report.failure;
    if (report.passed) report.status = "passed";
    else if (mutationAttempted) report.status = "failed";
    report.finishedAt = new Date().toISOString();
  }
  return report;
}

function ordinaryOwnedFile(file, root) {
  const full = path.resolve(file);
  assert.match(full, /^G:\\/iu);
  assert.ok(
    samePath(full, root) ||
      full
        .toLowerCase()
        .startsWith(path.resolve(root).toLowerCase() + path.sep),
    "Background path escaped the exact owner root",
  );
  for (let cursor = full; ; cursor = path.dirname(cursor)) {
    assert.equal(
      fs.lstatSync(cursor).isSymbolicLink(),
      false,
      "Background reparse ancestor refused",
    );
    if (path.dirname(cursor) === cursor) break;
  }
  assert.equal(fs.statSync(full).isFile(), true);
  return full;
}

export async function verifyProductionBackground({
  page,
  setup,
  launch,
  readonlyNative,
}) {
  assert.equal(process.platform, "win32");
  const workspace = path.resolve(
    fileURLToPath(new URL("../../", import.meta.url)),
  );
  assert.ok(samePath(setup.workspace, workspace));
  assert.match(setup.ownerId, /^[a-f0-9]{32}$/u);
  const root = path.join(workspace, ".cache/native-e2e-sandbox", setup.ownerId);
  assert.ok(samePath(setup.root, root));
  assert.equal(setup.schemaVersion, 2);
  for (const field of ["productionSha256", "sourceDigest"])
    assert.match(setup[field], hashPattern);
  assert.match(setup.buildAuditId, /^[a-f0-9]{32}$/u);
  assert.equal(launch.ownerId, setup.ownerId);
  assert.equal(launch.retainedHandleValidated, true);
  assert.equal(launch.cdpListener?.retainedDescendantValidated, true);
  for (const record of [setup, launch]) {
    assert.equal(record.qaHooksUsed, false);
    assert.equal(record.discoveryContextInjected, false);
  }
  assert.equal(launch.productionSha256, setup.productionSha256);
  assert.ok(samePath(launch.productionProgram, setup.productionProgram));
  assert.ok(Number.isSafeInteger(launch.pid) && launch.pid > 0);
  const program = ordinaryOwnedFile(launch.productionProgram, root);
  assert.equal(path.basename(program), "AE-Switch.exe");
  assert.doesNotMatch(program, /["\r\n\0]/u);
  const marker = ordinaryOwnedFile(
    path.join(root, ".ae-production-ui-eight-owner.json"),
    root,
  );
  const markerSha256 = sha(fs.readFileSync(marker));
  function validateOwner() {
    assert.equal(
      sha(fs.readFileSync(ordinaryOwnedFile(program, root))),
      setup.productionSha256,
    );
    const bytes = fs.readFileSync(ordinaryOwnedFile(marker, root));
    assert.equal(sha(bytes), markerSha256);
    const owner = JSON.parse(bytes);
    for (const field of [
      "ownerId",
      "productionSha256",
      "sourceDigest",
      "buildAuditId",
    ])
      assert.equal(owner[field], setup[field]);
    assert.ok(samePath(owner.workspace, workspace));
  }
  validateOwner();
  const binding = {
    schemaVersion: 1,
    ownerId: setup.ownerId,
    workspace,
    root,
    productionProgram: program,
    productionSha256: setup.productionSha256,
    sourceDigest: setup.sourceDigest,
    buildAuditId: setup.buildAuditId,
    expectedCommand: '"' + program + '" --background',
  };
  binding.expectedCommandSha256 = sha(binding.expectedCommand);
  const powershell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  );
  const readHelper = fileURLToPath(
    new URL("./production-background-registry.ps1", import.meta.url),
  );
  const emergencyHelper = fileURLToPath(
    new URL("./restore-production-background.ps1", import.meta.url),
  );
  const helperBindings = [
    fileURLToPath(import.meta.url),
    readHelper,
    emergencyHelper,
  ].map((file) => ({ path: file, sha256: sha(fs.readFileSync(file)) }));
  const run = async (helper, extra = []) => {
    validateOwner();
    for (const file of helperBindings)
      assert.equal(sha(fs.readFileSync(file.path)), file.sha256);
    const { stdout } = await execute(
      powershell,
      ["-NoProfile", "-NonInteractive", "-File", helper, ...extra],
      {
        encoding: "utf8",
        timeout: 20000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    );
    return JSON.parse(stdout.replace(/^\uFEFF/u, ""));
  };
  let baselineSaved = false;
  const bindingFile = path.join(root, "background-emergency-binding.json");
  const readRegistry = async () => {
    const record = assertRegistrySnapshot(await run(readHelper));
    if (!baselineSaved) {
      binding.baselineFile = path.join(
        root,
        "background-registry-baseline.json",
      );
      const bytes = JSON.stringify(record, null, 2) + "\n";
      fs.writeFileSync(binding.baselineFile, bytes, { flag: "wx" });
      binding.baselineSha256 = sha(bytes);
      const { expectedCommand, ...persistedBinding } = binding;
      fs.writeFileSync(
        bindingFile,
        JSON.stringify(persistedBinding, null, 2) + "\n",
        { flag: "wx" },
      );
      baselineSaved = true;
    }
    return record;
  };
  const receipt = await verifyBackgroundRoundTrip({
    page,
    setup,
    launch,
    readonlyNative,
    binding,
    readRegistry,
    emergencyCleanup: () =>
      run(emergencyHelper, ["-BindingFile", bindingFile, "-EmergencyCleanup"]),
  });
  validateOwner();
  return {
    ...receipt,
    ownerId: setup.ownerId,
    productionSha256: setup.productionSha256,
    productionPid: launch.pid,
    sourceDigest: setup.sourceDigest,
    buildAuditId: setup.buildAuditId,
    helperBindings,
    productionBytesAndOwnerUnchanged: true,
  };
}
