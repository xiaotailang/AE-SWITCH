import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { waitExistingTauriPage } from "./wait-existing-tauri-page.mjs";
import { verifyProductionBackground } from "./production-background-surface.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const execute = promisify(execFile);
const same = (left, right) =>
  path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();

export function assertOwnedWindowState(record, setup, launch, expected = {}) {
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.ownerId, setup.ownerId);
  assert.equal(record.pid, launch.pid);
  assert.equal(
    new Date(record.startedAt).getTime(),
    new Date(launch.startedAt).getTime(),
  );
  assert.equal(record.productionSha256, setup.productionSha256);
  assert.equal(record.retainedHandleValidated, true);
  assert.equal(record.exactHwndValidated, true);
  assert.match(record.hwnd, /^[1-9][0-9]*$/u);
  assert.ok(
    typeof record.windowClass === "string" && record.windowClass.length > 0,
  );
  for (const field of ["visible", "minimized", "maximized", "setupRestoreUsed"])
    assert.equal(typeof record[field], "boolean");
  assert.equal(record.trayInteraction, false);
  assert.equal(record.trayRestoreClaimed, false);
  assert.equal(record.processStopped, false);
  if (record.setupRestoreUsed)
    assert.equal(
      record.restoreMethod,
      "owned Win32 ShowWindow(SW_RESTORE) setup",
    );
  else assert.equal(record.restoreMethod, null);
  for (const [field, value] of Object.entries(expected))
    assert.equal(
      record[field],
      value,
      "Independent owned window state differs",
    );
}

export function systemNativeCommand(request) {
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
    const command = decodeURIComponent(url.pathname.slice(1));
    return command && !command.includes("/") ? command : null;
  } catch {
    return null;
  }
}
const allowedSystemCommands = new Set([
  "get_overview",
  "agent_hub_overview",
  "agent_hub_discover",
  "get_background_settings",
  "set_background_start",
  "plugin:window|is_maximized",
  "plugin:window|minimize",
  "plugin:window|close",
  "plugin:event|listen",
  "plugin:event|unlisten",
]);
export function assertSystemCommands(commands) {
  assert.ok(Array.isArray(commands));
  for (const command of commands)
    assert.ok(
      allowedSystemCommands.has(command),
      "System-only run observed an unexpected native command",
    );
}

export function assertSystemReceipt(report) {
  assert.equal(report.schemaVersion, 1);
  assert.match(report.ownerId, /^[a-f0-9]{32}$/u);
  assert.equal(
    report.scope,
    "Production startup UI roundtrip and owned window minimize/hide; Win32 setup restores, no tray restoration claim",
  );
  assert.equal(report.complete, false);
  assert.equal(report.fullAcceptancePassed, false);
  assert.equal(report.officialClientsLaunched, false);
  assert.equal(report.credentialsRead, false);
  assert.equal(report.qaHooksUsed, false);
  assert.equal(report.applicationInvokeReplaced, false);
  assertSystemCommands(report.observedNativeCommands);
  for (const command of [
    "get_background_settings",
    "set_background_start",
    "plugin:window|minimize",
    "plugin:window|close",
    "agent_hub_overview",
  ])
    assert.ok(report.observedNativeCommands.includes(command));
  assert.equal(report.windowsLoginExecuted, false);
  assert.equal(report.trayRestoreClaimed, false);
  assert.equal(report.background.passed, true);
  assert.equal(report.background.restoration.baselineRestored, true);
  assert.equal(report.background.restoration.emergencyUsed, false);
  assert.equal(report.background.otherEntriesUnchanged, true);
  assert.equal(report.background.baseline.target.present, false);
  assert.equal(
    report.background.restoration.finalRegistry.target.present,
    false,
  );
  assert.equal(
    report.background.baseline.otherValuesSha256,
    report.background.restoration.finalRegistry.otherValuesSha256,
  );
  assert.equal(report.windowChecks.length, 2);
  assert.deepEqual(
    report.windowChecks.map((row) => row.action),
    ["minimize", "close-to-background"],
  );
  for (const row of report.windowChecks) {
    assert.equal(row.passed, true);
    assert.equal(row.nativeRequestCount, 1);
    assert.equal(row.nativeResponse, "ok");
    assert.equal(row.bridgeHealthyWhileHidden, true);
    assert.equal(row.restoration.setupRestoreUsed, true);
    assert.equal(row.restoration.trayRestoreClaimed, false);
    assert.equal(row.restoration.visible, true);
    assert.equal(row.restoration.minimized, false);
    assert.equal(row.before.hwnd, row.hidden.hwnd);
    assert.equal(row.hidden.hwnd, row.restoration.hwnd);
    if (row.action === "minimize") {
      assert.equal(row.command, "plugin:window|minimize");
      assert.equal(row.hidden.minimized, true);
    } else {
      assert.equal(row.command, "plugin:window|close");
      assert.equal(row.hidden.visible, false);
    }
  }
  assert.equal(report.pageRestored, true);
  assert.equal(report.productionIdentityUnchanged, true);
  assert.equal(report.helperBindingsUnchanged, true);
  assert.equal(report.nativeStoreUnchanged, true);
  assert.equal(report.nativeStateBeforeSha256, report.nativeStateAfterSha256);
  assert.equal(report.sourceInputsUnchanged, true);
  assert.equal(report.sharedRuntimeInputsUnchanged, true);
  assert.ok(
    report.unvalidated.some(
      (row) => row.name === "actual tray icon restore/exit" && row.reason,
    ),
  );
  assert.ok(
    report.unvalidated.some(
      (row) => row.name === "actual Windows login startup" && row.reason,
    ),
  );
}

function ownedPath(file, root, missing = false) {
  const full = path.resolve(file);
  assert.match(full, /^G:\\/iu);
  assert.ok(
    same(full, root) ||
      full
        .toLowerCase()
        .startsWith(path.resolve(root).toLowerCase() + path.sep),
    "System UI path escaped exact owner root",
  );
  for (let cursor = full; ; cursor = path.dirname(cursor)) {
    if (fs.existsSync(cursor))
      assert.equal(
        fs.lstatSync(cursor).isSymbolicLink(),
        false,
        "System UI reparse ancestor refused",
      );
    else assert.ok(missing, "Required system UI path absent");
    if (path.dirname(cursor) === cursor) break;
  }
  return full;
}

export async function runProductionSystemUi(setupFile, launchFile) {
  assert.equal(process.platform, "win32");
  const workspace = path.resolve(
    fileURLToPath(new URL("../../", import.meta.url)),
  );
  const setup = JSON.parse(
    fs.readFileSync(
      ownedPath(setupFile, path.join(workspace, ".cache/native-e2e-sandbox")),
      "utf8",
    ),
  );
  assert.equal(setup.schemaVersion, 2);
  assert.match(setup.ownerId, /^[a-f0-9]{32}$/u);
  assert.ok(same(setup.workspace, workspace));
  const root = path.join(workspace, ".cache/native-e2e-sandbox", setup.ownerId);
  assert.ok(same(setup.root, root));
  assert.ok(same(setupFile, path.join(root, "setup.json")));
  assert.ok(
    same(launchFile, path.join(root, "production-launch-receipt.json")),
  );
  const launch = JSON.parse(
    fs.readFileSync(ownedPath(launchFile, root), "utf8"),
  );
  const output = path.join(
    workspace,
    "artifacts/acceptance",
    "production-system-ui-" + setup.ownerId,
  );
  const report = {
    schemaVersion: 1,
    ownerId: setup.ownerId,
    scope:
      "Production startup UI roundtrip and owned window minimize/hide; Win32 setup restores, no tray restoration claim",
    complete: false,
    fullAcceptancePassed: false,
    officialClientsLaunched: false,
    credentialsRead: false,
    qaHooksUsed: false,
    applicationInvokeReplaced: false,
    windowsLoginExecuted: false,
    trayRestoreClaimed: false,
    startedAt: new Date().toISOString(),
    passed: false,
    productionSha256: setup.productionSha256,
    sourceDigest: setup.sourceDigest,
    buildAuditId: setup.buildAuditId,
    productionPid: launch.pid,
    productionStartedAt: launch.startedAt,
    setupReceiptSha256: sha(fs.readFileSync(setupFile)),
    launchReceiptSha256: sha(fs.readFileSync(launchFile)),
    windowChecks: [],
    pageErrors: [],
    observedNativeCommands: [],
    unvalidated: [
      {
        name: "actual tray icon restore/exit",
        reason:
          "Window recovery uses exact owned Win32 ShowWindow as setup; no tray icon identity, menu interaction or tray restoration is exercised.",
      },
      {
        name: "actual Windows login startup",
        reason: "HKCU UI value roundtrip does not execute a new Windows login.",
      },
      {
        name: "official clients, account/default/history and inference",
        reason:
          "This separate system run reads no credentials and launches no official clients; use distinct current-client receipts.",
      },
    ],
  };
  const write = () => {
    const destination = ownedPath(
      path.join(output, "production-system-ui-results.json"),
      output,
      true,
    );
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(destination, JSON.stringify(report, null, 2) + "\n");
  };
  const markerFile = ownedPath(
    path.join(root, ".ae-production-ui-eight-owner.json"),
    root,
  );
  const markerHash = sha(fs.readFileSync(markerFile));
  const helperNames = [
    "production-system-ui.mjs",
    "verify-production-system-ui.ps1",
    "production-owned-window-state.ps1",
    "production-background-surface.mjs",
    "production-background-registry.ps1",
    "restore-production-background.ps1",
    "production-ui-eight-contract.mjs",
    "wait-existing-tauri-page.mjs",
  ];
  report.helperBindings = helperNames.map((name) => {
    const file = ownedPath(
      path.join(workspace, "tests/acceptance", name),
      workspace,
    );
    return { path: file, sha256: sha(fs.readFileSync(file)) };
  });
  const sourceManifest = JSON.parse(
    fs.readFileSync(ownedPath(setup.sourceManifest, workspace), "utf8"),
  );
  assert.equal(sourceManifest.digest, setup.sourceDigest);
  const sourceHashes = () =>
    sourceManifest.files
      .map((file) => {
        const hash = sha(
          fs.readFileSync(
            ownedPath(path.join(workspace, file.path), workspace),
          ),
        );
        assert.equal(
          hash,
          file.sha256,
          "Current production source input changed",
        );
        return file.path + "\0" + hash + "\n";
      })
      .join("");
  const sharedBefore = Object.entries(setup.fixtures.sharedRuntimeFiles).map(
    ([file, hash]) => ({ path: file, sha256: hash }),
  );
  function validateOwner() {
    assert.equal(sha(fs.readFileSync(ownedPath(markerFile, root))), markerHash);
    const owner = JSON.parse(fs.readFileSync(markerFile, "utf8"));
    assert.equal(owner.schemaVersion, 2);
    for (const field of [
      "ownerId",
      "productionSha256",
      "sourceDigest",
      "buildAuditId",
    ])
      assert.equal(owner[field], setup[field]);
    assert.ok(same(owner.workspace, workspace));
    assert.equal(launch.ownerId, setup.ownerId);
    assert.equal(launch.productionSha256, setup.productionSha256);
    assert.equal(launch.retainedHandleValidated, true);
    assert.equal(launch.cdpListener?.retainedDescendantValidated, true);
    assert.ok(same(launch.productionProgram, setup.productionProgram));
    assert.ok(
      same(
        launch.ordinaryDiscoveryCwd,
        path.join(root, "installed-clients/workspace"),
      ),
    );
    for (const record of [setup, launch]) {
      assert.equal(record.qaHooksUsed, false);
      assert.equal(record.discoveryContextInjected, false);
    }
    assert.equal(
      sha(fs.readFileSync(ownedPath(setup.productionProgram, root))),
      setup.productionSha256,
    );
    assert.equal(sha(fs.readFileSync(setupFile)), report.setupReceiptSha256);
    assert.equal(sha(fs.readFileSync(launchFile)), report.launchReceiptSha256);
    for (const binding of report.helperBindings)
      assert.equal(sha(fs.readFileSync(binding.path)), binding.sha256);
  }
  let browser, page, baseline, failure;
  const powershell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  );
  const windowHelper = path.join(
    workspace,
    "tests/acceptance/production-owned-window-state.ps1",
  );
  const windowState = async (restore = false) => {
    validateOwner();
    const { stdout } = await execute(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        windowHelper,
        "-SetupFile",
        path.resolve(setupFile),
        "-LaunchFile",
        path.resolve(launchFile),
        ...(restore ? ["-RestoreForSetup"] : []),
      ],
      {
        encoding: "utf8",
        timeout: 20000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    );
    const state = JSON.parse(stdout.replace(/^\uFEFF/u, ""));
    assertOwnedWindowState(state, setup, launch, { setupRestoreUsed: restore });
    return state;
  };
  let initialWindow;
  try {
    validateOwner();
    assert.equal(
      Object.keys(process.env).some((name) =>
        /^UNI_SWITCH_QA_|^AE_NATIVE_/iu.test(name),
      ),
      false,
    );
    assert.equal(sha(sourceHashes()), setup.sourceDigest);
    for (const entry of sharedBefore)
      assert.equal(
        sha(fs.readFileSync(ownedPath(entry.path, workspace))),
        entry.sha256,
      );
    write();
    const require = createRequire(path.join(workspace, "app/package.json"));
    const { chromium } = require("playwright");
    browser = await chromium.connectOverCDP("http://127.0.0.1:9223", {
      timeout: 30000,
    });
    page = await waitExistingTauriPage(browser);
    page.setDefaultTimeout(15000);
    page.on("request", (request) => {
      const command = systemNativeCommand(request);
      if (command) report.observedNativeCommands.push(command);
    });
    page.on("pageerror", (error) =>
      report.pageErrors.push({
        name: error.name,
        message: "Production page error observed; raw input text omitted.",
      }),
    );
    await page
      .getByRole("heading", { name: "端点配置", exact: true })
      .waitFor();
    assert.equal(
      await page.evaluate(
        () => typeof window.__TAURI_INTERNALS__?.invoke === "function",
      ),
      true,
    );
    const readonlyNative = async (command) => {
      assert.ok(
        [
          "get_overview",
          "agent_hub_overview",
          "get_background_settings",
        ].includes(command),
      );
      return page.evaluate(
        (command) => window.__TAURI_INTERNALS__.invoke(command),
        command,
      );
    };
    const protectedState = async () => {
      const overview = await readonlyNative("get_overview");
      const hub = await readonlyNative("agent_hub_overview");
      return {
        providers: overview.providers,
        selections: hub.agents.map((agent) =>
          Object.fromEntries(
            [
              "id",
              "configured",
              "providerId",
              "model",
              "profile",
              "mode",
              "configurationRevision",
              "appliedAtMs",
            ].map((field) => [field, agent[field] ?? null]),
          ),
        ),
      };
    };
    baseline = await protectedState();
    assert.equal(
      baseline.providers.length,
      0,
      "A fresh system-only native store is required",
    );
    assert.equal(
      baseline.selections.every((agent) => !agent.configured),
      true,
    );
    initialWindow = await windowState();
    assertOwnedWindowState(initialWindow, setup, launch, {
      visible: true,
      minimized: false,
      maximized: false,
    });
    const backgroundBefore = await readonlyNative("get_background_settings");
    assert.deepEqual(backgroundBefore, { supported: true, enabled: false });
    if (
      !(await page
        .getByRole("checkbox", {
          name: "随 Windows 启动，在后台运行",
          exact: true,
        })
        .count())
    )
      await page.getByRole("button", { name: "快速上手", exact: true }).click();
    const backgroundReadyDeadline = Date.now() + 15000;
    while (
      !(await page
        .getByRole("checkbox", {
          name: "随 Windows 启动，在后台运行",
          exact: true,
        })
        .isEnabled())
    ) {
      assert.ok(
        Date.now() < backgroundReadyDeadline,
        "Production startup checkbox did not become ready",
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    report.background = await verifyProductionBackground({
      page,
      setup,
      launch,
      readonlyNative,
    });
    write();
    assert.equal(
      report.background.passed,
      true,
      "Production startup UI roundtrip did not pass",
    );
    if (await page.locator(".hub-help").count())
      await page
        .getByRole("button", { name: "关闭快速上手", exact: true })
        .click();
    for (const [action, label, command] of [
      ["minimize", "最小化窗口", "plugin:window|minimize"],
      ["close-to-background", "关闭窗口并留在托盘", "plugin:window|close"],
    ]) {
      const row = {
        action,
        command,
        startedAt: new Date().toISOString(),
        passed: false,
        before: await windowState(),
      };
      report.windowChecks.push(row);
      const requests = [];
      const onRequest = (request) => {
        if (systemNativeCommand(request) === command) requests.push(request);
      };
      page.on("request", onRequest);
      const observed = page.waitForResponse(
        (response) =>
          requests.includes(response.request()) &&
          systemNativeCommand(response.request()) === command,
        { timeout: 15000 },
      );
      observed.catch(() => {});
      try {
        await page.getByRole("button", { name: label, exact: true }).click();
        const response = await observed;
        row.nativeRequestCount = requests.length;
        row.nativeResponse = await response.headerValue("Tauri-Response");
        assert.equal(row.nativeRequestCount, 1);
        assert.equal(row.nativeResponse, "ok");
        const deadline = Date.now() + 15000;
        do {
          row.hidden = await windowState();
          if (
            action === "minimize" ? row.hidden.minimized : !row.hidden.visible
          )
            break;
          assert.ok(
            Date.now() < deadline,
            "Real native window action did not settle",
          );
          await new Promise((resolve) => setTimeout(resolve, 100));
        } while (true);
        assert.equal(row.before.hwnd, row.hidden.hwnd);
        row.bridgeHealthyWhileHidden = (
          await readonlyNative("agent_hub_overview")
        ).bridgeHealthy;
        assert.equal(row.bridgeHealthyWhileHidden, true);
        assert.equal(await page.locator(".window-operation-error").count(), 0);
      } finally {
        page.off("request", onRequest);
        row.restoration = await windowState(true);
        assertOwnedWindowState(row.restoration, setup, launch, {
          visible: true,
          minimized: false,
        });
        assert.equal(row.before.hwnd, row.restoration.hwnd);
        row.finishedAt = new Date().toISOString();
        write();
      }
      row.passed = true;
      write();
    }
    const after = await protectedState();
    report.nativeStateBeforeSha256 = sha(JSON.stringify(baseline));
    report.nativeStateAfterSha256 = sha(JSON.stringify(after));
    report.nativeStoreUnchanged =
      report.nativeStateBeforeSha256 === report.nativeStateAfterSha256;
    assert.equal(report.nativeStoreUnchanged, true);
    assert.equal(report.pageErrors.length, 0);
  } catch (error) {
    failure = error;
    report.failure = { name: error.name, message: String(error.message) };
  } finally {
    try {
      if (page && initialWindow) {
        report.finalWindow = await windowState(true);
        assertOwnedWindowState(report.finalWindow, setup, launch, {
          visible: true,
          minimized: false,
        });
        assert.equal(report.finalWindow.hwnd, initialWindow.hwnd);
        if (await page.locator(".hub-help").count())
          await page
            .getByRole("button", { name: "关闭快速上手", exact: true })
            .click();
        report.pageRestored = true;
      }
      validateOwner();
      report.productionIdentityUnchanged = true;
      report.helperBindingsUnchanged = true;
      assert.equal(sha(sourceHashes()), setup.sourceDigest);
      report.sourceInputsUnchanged = true;
      for (const entry of sharedBefore)
        assert.equal(
          sha(fs.readFileSync(ownedPath(entry.path, workspace))),
          entry.sha256,
        );
      report.sharedRuntimeInputsUnchanged = true;
    } catch (error) {
      failure ??= error;
      report.restorationFailure = error.message;
    }
    await browser?.close().catch(() => {});
    report.finishedAt = new Date().toISOString();
    if (!failure) {
      try {
        assertSystemReceipt(report);
        report.passed = true;
      } catch (error) {
        failure = error;
        report.evidenceFailure = error.message;
      }
    }
    write();
  }
  if (failure) {
    failure.systemReceipt = report;
    throw failure;
  }
  return report;
}

if (process.argv[1] && same(process.argv[1], fileURLToPath(import.meta.url))) {
  runProductionSystemUi(
    path.resolve(process.argv[2]),
    path.resolve(process.argv[3]),
  )
    .then((report) =>
      console.log(
        JSON.stringify({
          ownerId: report.ownerId,
          passed: report.passed,
          scope: report.scope,
        }),
      ),
    )
    .catch((error) => {
      console.error(error.stack);
      process.exitCode = 1;
    });
}
