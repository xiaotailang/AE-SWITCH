import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) =>
  path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const hashPattern = /^[a-f0-9]{64}$/u;

export function trayNativeCommand(request) {
  try {
    const url = new URL(request.url());
    if (
      request.method() !== "POST" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !(
        (["http:", "https:"].includes(url.protocol) &&
          url.hostname === "ipc.localhost") ||
        (url.protocol === "ipc:" && url.hostname === "localhost")
      )
    )
      return null;
    return decodeURIComponent(url.pathname.slice(1));
  } catch {
    return null;
  }
}

export function trayLookupFailureEvidence(record, action) {
  const lookup = record?.lastIconLookup || {};
  const integer = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const bounds = (value) => Array.isArray(value) && value.length === 4
    && value.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))
    ? [...value] : null;
  const boolean = (value) => typeof value === "boolean" ? value : null;
  const diagnostics = (rows) => Array.isArray(rows) ? rows.slice(0, 64).map((row) => ({
    samples: integer(row?.samples),
    stableSamples: integer(row?.stableSamples),
    moves: integer(row?.moves),
    buttonPairsCompleted: integer(row?.buttonPairsCompleted),
    doubleClickLimitMs: integer(row?.doubleClickLimitMs),
    pairIntervalMs: row?.pairIntervalMs === -1 ? -1 : integer(row?.pairIntervalMs),
    validationDurationMs: integer(row?.validationDurationMs),
    inputElapsedMs: integer(row?.inputElapsedMs),
    actualInputCompleted: boolean(row?.actualInputCompleted),
    doubleClickDeadlineExceeded: boolean(row?.doubleClickDeadlineExceeded),
  })) : [];
  return {
    action,
    ownerPid: integer(lookup.ownerPid),
    callbackHwnd: typeof lookup.callbackHwnd === "string" && /^\d+$/u.test(lookup.callbackHwnd)
      ? lookup.callbackHwnd : null,
    internalUid: integer(lookup.internalUid),
    exactVisibleMatches: integer(lookup.exactVisibleMatches),
    notificationBounds: bounds(lookup.bounds),
    uiaBounds: bounds(lookup.uiaBounds),
    tooltipMatches: typeof lookup.tooltipMatches === "boolean" ? lookup.tooltipMatches : null,
    uiaCenterInsideNotification: typeof lookup.uiaCenterInsideNotification === "boolean"
      ? lookup.uiaCenterInsideNotification : null,
    iconInputCount: Array.isArray(record?.iconInputs) ? record.iconInputs.length : null,
    iconPreparationDiagnostics: diagnostics(record?.iconPreparationDiagnostics),
    iconInputs: diagnostics(record?.iconInputs),
  };
}

export function assertTrayHelperReceipt(record, setup, launch, action) {
  assert.equal(record.schemaVersion, 1);
  for (const field of [
    "ownerId",
    "productionSha256",
    "sourceDigest",
    "buildAuditId",
  ])
    assert.equal(record[field], setup[field]);
  assert.equal(record.pid, launch.pid);
  assert.equal(
    new Date(record.startedAt).getTime(),
    new Date(launch.startedAt).getTime(),
  );
  assert.equal(record.action, action);
  for (const field of [
    "passed",
    "retainedHandleValidated",
    "sourceInputsValidated",
  ])
    assert.equal(record[field], true, field);
  for (const field of [
    "processStopped",
    "actualExitConfirmed",
    "win32ShowWindowUsed",
    "callbackInjectionUsed",
    "qaHooksUsed",
  ])
    assert.equal(record[field], false, field);
  assert.match(record.helperSha256, hashPattern);
  assert.equal(record.notificationIdentity.pid, launch.pid);
  assert.equal(record.notificationIdentity.uid, 2);
  assert.ok(
    Number.isSafeInteger(record.notificationIdentity.hwnd) &&
      record.notificationIdentity.hwnd > 0,
  );
  for (const state of [record.before, record.after]) {
    assert.match(state.hwnd, /^[1-9][0-9]*$/u);
    for (const flag of ["visible", "minimized", "enabled"])
      assert.equal(typeof state[flag], "boolean");
  }
  assert.equal(record.before.hwnd, record.after.hwnd);
  if (action === "Observe") return record;
  for (const field of [
    "cursorRestored",
    "overflowRestored",
    "dpiContextRestored",
  ])
    assert.equal(record[field], true, field);
  const lookup = record.lastIconLookup;
  assert.equal(lookup.ownerPid, launch.pid);
  assert.equal(lookup.callbackHwnd, String(record.notificationIdentity.hwnd));
  assert.equal(lookup.internalUid, 2);
  assert.equal(lookup.guidNull, true);
  assert.equal(
    lookup.identityMethod,
    "retained-PID-callback-HWND-uID-Shell_NotifyIconGetRect",
  );
  assert.equal(lookup.exactVisibleMatches, 1);
  assert.ok(Array.isArray(record.iconInputs) && record.iconInputs.length === 1);
  const input = record.iconInputs[0];
  assert.equal(input.exactOwnerHitTest, true);
  assert.equal(input.actualInputCompleted, true);
  assert.equal(input.buttonPairsCompleted, action === "DoubleClick" ? 2 : 1);
  assert.equal(input.doubleClick, action === "DoubleClick");
  assert.equal(
    input.icon.notificationOwnerHwnd,
    record.notificationIdentity.hwnd,
  );
  assert.equal(input.icon.notificationUid, 2);
  assert.ok(input.stableSamples >= 2);
  assert.equal(record.after.visible, true);
  assert.equal(record.after.minimized, false);
  assert.equal(record.after.enabled, true);
  if (action === "DoubleClick" || action === "OpenMenu")
    assert.equal(record.before.visible, false);
  if (action !== "DoubleClick") {
    assert.equal(record.menuInputs.length, 1);
    const menu = record.menuInputs[0];
    assert.equal(menu.nativeProcessId, launch.pid);
    assert.equal(
      menu.requestedName,
      action === "OpenMenu" ? "打开 AE Switch" : "退出应用…",
    );
    assert.equal(menu.exactOwnedMenuHit, true);
    assert.equal(menu.input, "actual-left-mouse");
    assert.equal(menu.hoverHighlighted, true);
    assert.equal(menu.menuDismissed, true);
  }
  if (action === "CancelExit") {
    assert.equal(record.exitDialogObserved, true);
    assert.equal(record.exitCancelled, true);
    assert.match(record.exitDialogHwnd, /^[1-9][0-9]*$/u);
    assert.equal(record.dialogButtonDiagnostics.length, 1);
    const button = record.dialogButtonDiagnostics[0];
    assert.equal(button.requestedName, "取消");
    assert.equal(button.selectedName, "取消");
    assert.equal(button.actualInputCompleted, true);
    assert.equal(record.cancelReadiness.ready, true);
  }
  return record;
}

// Test seam uses synthetic page/native receipts. Production below supplies exact OS helpers only.
export async function verifyTrayRoundTrip({
  page,
  setup,
  launch,
  readonlyNative,
  runHelper,
  cancelEligible,
}) {
  const report = {
    schemaVersion: 1,
    scope:
      "Production UI close and actual process-owned tray double-click/menu restore; conditional exit confirmation cancellation",
    ownerId: setup.ownerId,
    productionSha256: setup.productionSha256,
    sourceDigest: setup.sourceDigest,
    buildAuditId: setup.buildAuditId,
    passed: false,
    fullAcceptancePassed: false,
    processStopped: false,
    actualExitConfirmed: false,
    win32ShowWindowUsed: false,
    qaHooksUsed: false,
    uiCloseRequests: [],
    restorations: [],
    exitCancel: {
      status: "unvalidated",
      reason:
        "No exact ordinary agent-selection.json; clicking exit on a fresh store would terminate it",
    },
    startedAt: new Date().toISOString(),
  };
  let callbackHwnd;
  const helper = async (action) => {
    const record = assertTrayHelperReceipt(
      await runHelper(action),
      setup,
      launch,
      action,
    );
    callbackHwnd ??= record.notificationIdentity.hwnd;
    assert.equal(
      record.notificationIdentity.hwnd,
      callbackHwnd,
      "Exact retained tray callback HWND changed across actions",
    );
    return record;
  };
  async function close() {
    const command = "plugin:window|close";
    const requests = [];
    const onRequest = (request) => {
      if (trayNativeCommand(request) === command) requests.push(request);
    };
    page.on("request", onRequest);
    const observed = page.waitForResponse(
      (response) =>
        requests.includes(response.request()) &&
        trayNativeCommand(response.request()) === command,
      { timeout: 15000 },
    );
    observed.catch(() => {});
    try {
      await page
        .getByRole("button", { name: "关闭窗口并留在托盘", exact: true })
        .click();
      const response = await observed;
      const status = await response.headerValue("Tauri-Response");
      report.uiCloseRequests.push({
        command,
        nativeRequestCount: requests.length,
        nativeResponse: status,
        actualUiRequestObserved: true,
      });
      assert.equal(requests.length, 1);
      assert.equal(status, "ok");
    } finally {
      page.off("request", onRequest);
    }
    const deadline = Date.now() + 10000;
    let state;
    do {
      state = await helper("Observe");
      if (!state.after.visible) break;
      assert.ok(
        Date.now() < deadline,
        "Real UI close did not hide the exact retained HWND",
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (true);
    assert.equal(state.after.hwnd, report.initial.after.hwnd);
    assert.equal(
      (await readonlyNative("agent_hub_overview")).bridgeHealthy,
      true,
    );
    return state;
  }
  try {
    report.initial = await helper("Observe");
    assert.equal(report.initial.after.visible, true);
    assert.equal(report.initial.after.minimized, false);
    for (const action of ["DoubleClick", "OpenMenu"]) {
      const hidden = await close();
      const restoration = await helper(action);
      assert.equal(restoration.after.hwnd, hidden.after.hwnd);
      assert.equal(
        (await readonlyNative("agent_hub_overview")).bridgeHealthy,
        true,
      );
      report.restorations.push({
        action,
        hidden,
        restoration,
        bridgeHealthyAfterRestore: true,
      });
    }
    if (await cancelEligible()) {
      const cancellation = await helper("CancelExit");
      assert.equal(cancellation.after.hwnd, report.initial.after.hwnd);
      assert.equal(
        (await readonlyNative("agent_hub_overview")).bridgeHealthy,
        true,
      );
      report.exitCancel = {
        status: "passed",
        cancellation,
        bridgeHealthyAfterCancel: true,
      };
    }
    report.executedGatesPassed = true;
  } catch (error) {
    report.failure = error.message;
    if (error.trayLookupFailure) report.lookupFailure = error.trayLookupFailure;
  } finally {
    try {
      report.final = await helper("Observe");
      if (!report.final.after.visible) {
        report.recovery = await helper("DoubleClick");
        report.final = await helper("Observe");
      }
      assert.equal(report.final.after.visible, true);
      assert.equal(report.final.after.minimized, false);
      if (report.initial)
        assert.equal(report.final.after.hwnd, report.initial.after.hwnd);
      report.pageRestored = true;
    } catch (error) {
      report.recoveryFailure = error.message;
      if (error.trayLookupFailure) report.recoveryLookupFailure = error.trayLookupFailure;
    }
  }
  report.passed =
    report.executedGatesPassed === true &&
    report.pageRestored === true &&
    !report.failure &&
    !report.recoveryFailure;
  report.finishedAt = new Date().toISOString();
  return report;
}

function ordinary(file, root) {
  const full = path.resolve(file),
    boundary = path.resolve(root);
  assert.match(full, /^[Gg]:[\\/]/u);
  assert.ok(
    same(full, boundary) ||
      full.toLowerCase().startsWith(boundary.toLowerCase() + path.sep),
  );
  for (let cursor = full; ; cursor = path.dirname(cursor)) {
    assert.equal(
      fs.lstatSync(cursor).isSymbolicLink(),
      false,
      "Tray alias/reparse path refused",
    );
    assert.ok(same(fs.realpathSync.native(cursor), cursor));
    if (path.dirname(cursor) === cursor) break;
  }
  assert.ok(fs.statSync(full).isFile());
  return full;
}

export async function verifyProductionTray({
  page,
  setup,
  launch,
  readonlyNative,
}) {
  assert.equal(process.platform, "win32");
  const workspace = path.resolve(
    fileURLToPath(new URL("../../", import.meta.url)),
  );
  assert.ok(same(setup.workspace, workspace));
  assert.equal(setup.schemaVersion, 2);
  assert.match(setup.ownerId, /^[a-f0-9]{32}$/u);
  const root = path.join(workspace, ".cache/native-e2e-sandbox", setup.ownerId);
  assert.ok(same(setup.root, root));
  for (const field of ["productionSha256", "sourceDigest"])
    assert.match(setup[field], hashPattern);
  assert.match(setup.buildAuditId, /^[a-f0-9]{32}$/u);
  assert.equal(launch.ownerId, setup.ownerId);
  assert.equal(launch.productionSha256, setup.productionSha256);
  assert.ok(same(launch.productionProgram, setup.productionProgram));
  assert.equal(launch.retainedHandleValidated, true);
  assert.equal(launch.cdpListener?.retainedDescendantValidated, true);
  assert.ok(Number.isSafeInteger(launch.pid) && launch.pid > 0);
  for (const record of [setup, launch]) {
    assert.equal(record.qaHooksUsed, false);
    assert.equal(record.discoveryContextInjected, false);
  }
  const setupFile = ordinary(path.join(root, "setup.json"), root);
  const launchFile = ordinary(
    path.join(root, "production-launch-receipt.json"),
    root,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(setupFile, "utf8")), setup);
  assert.deepEqual(JSON.parse(fs.readFileSync(launchFile, "utf8")), launch);
  const marker = ordinary(
    path.join(root, ".ae-production-ui-eight-owner.json"),
    root,
  );
  const program = ordinary(setup.productionProgram, root);
  assert.equal(path.basename(program), "AE-Switch.exe");
  const manifestFile = ordinary(setup.sourceManifest, workspace);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  assert.equal(manifest.digest, setup.sourceDigest);
  const helper = ordinary(
    fileURLToPath(new URL("./production-owned-tray.ps1", import.meta.url)),
    workspace,
  );
  const bindings = [
    fileURLToPath(import.meta.url),
    helper,
    setupFile,
    launchFile,
    marker,
    manifestFile,
  ].map((file) => ({
    path: file,
    sha256: sha(fs.readFileSync(ordinary(file, workspace))),
  }));
  function validate() {
    for (const entry of bindings)
      assert.equal(
        sha(fs.readFileSync(ordinary(entry.path, workspace))),
        entry.sha256,
      );
    assert.equal(
      sha(fs.readFileSync(ordinary(program, root))),
      setup.productionSha256,
    );
    const owner = JSON.parse(fs.readFileSync(marker, "utf8"));
    assert.equal(owner.schemaVersion, 2);
    for (const field of [
      "ownerId",
      "productionSha256",
      "sourceDigest",
      "buildAuditId",
    ])
      assert.equal(owner[field], setup[field]);
    assert.ok(same(owner.workspace, workspace));
    const lines = manifest.files
      .map((row) => {
        assert.match(row.sha256, hashPattern);
        const actual = sha(
          fs.readFileSync(ordinary(path.join(workspace, row.path), workspace)),
        );
        assert.equal(
          actual,
          row.sha256,
          "Current production source input changed",
        );
        return row.path + "\0" + actual + "\n";
      })
      .join("");
    assert.equal(sha(lines), setup.sourceDigest);
  }
  validate();
  const helperSha256 = bindings.find((row) => same(row.path, helper)).sha256;
  const powershell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  );
  const runHelper = async (action) => {
    validate();
    let stdout;
    try {
      ({ stdout } = await execute(
        powershell,
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          helper,
          "-SetupFile",
          setupFile,
          "-LaunchFile",
          launchFile,
          "-ExpectedHelperSha256",
          helperSha256,
          "-Action",
          action,
        ],
        {
          encoding: "utf8",
          timeout: 45000,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
        },
      ));
    } catch (error) {
      const receipt = error.stdout?.trim();
      if (receipt) {
        try {
          const failed = JSON.parse(receipt.replace(/^\uFEFF/u, ""));
          const rejected = new Error(failed.error || "Owned tray helper rejected action");
          rejected.trayLookupFailure = trayLookupFailureEvidence(failed, action);
          throw rejected;
        } catch (parseError) {
          if (!(parseError instanceof SyntaxError)) throw parseError;
        }
      }
      throw new Error("Owned tray helper rejected " + action);
    }
    validate();
    const record = JSON.parse(stdout.replace(/^\uFEFF/u, ""));
    assert.equal(record.helperSha256, helperSha256);
    return record;
  };
  const cancelEligible = async () => {
    validate();
    assert.ok(same(setup.portableRoot, path.join(root, "portable")));
    const selection = path.join(
      setup.portableRoot,
      "data/agent-selection.json",
    );
    if (!fs.existsSync(selection)) return false;
    ordinary(selection, root);
    return true;
  };
  const receipt = await verifyTrayRoundTrip({
    page,
    setup,
    launch,
    readonlyNative,
    runHelper,
    cancelEligible,
  });
  validate();
  return {
    ...receipt,
    helperBindings: bindings.slice(0, 2),
    productionIdentityUnchanged: true,
    sourceInputsUnchanged: true,
  };
}
