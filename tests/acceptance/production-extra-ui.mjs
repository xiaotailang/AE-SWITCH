import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { waitExistingTauriPage } from "./wait-existing-tauri-page.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) =>
  path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
export const extraUiScope =
  "Production profile ambiguity/original protection and exact owned tray restoration; no startup setting or official client mutation";

export function extraNativeCommand(request) {
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

const allowedCommands = new Set([
  "get_overview",
  "agent_hub_overview",
  "agent_hub_discover",
  "discover_provider_connection",
  "get_background_settings",
  "plugin:window|is_maximized",
  "plugin:window|close",
  "plugin:event|listen",
  "plugin:event|unlisten",
]);
export function assertExtraCommands(commands) {
  assert.ok(Array.isArray(commands));
  assert.ok(
    commands.every((c) => allowedCommands.has(c)),
    "Extra UI command boundary violated",
  );
}

export function assertExtraReceipt(report) {
  assert.equal(report.schemaVersion, 1);
  assert.match(report.ownerId, /^[a-f0-9]{32}$/u);
  assert.equal(report.scope, extraUiScope);
  for (const field of [
    "complete",
    "fullAcceptancePassed",
    "officialClientsLaunched",
    "credentialsRead",
    "qaHooksUsed",
    "applicationInvokeReplaced",
    "windowsLoginExecuted",
    "backgroundSettingsMutated",
    "actualExitConfirmed",
  ])
    assert.equal(report[field], false, "Unexpected broader acceptance claim");
  assertExtraCommands(report.observedNativeCommands);
  assert.equal(report.profile.passed, true);
  assert.equal(report.profile.pageRestored, true);
  assert.equal(report.profile.nativeStoreUnchanged, true);
  assert.equal(report.profile.fixtureOriginalsUnchanged, true);
  assert.equal(report.profile.copiedFilesUnchanged, true);
  assert.equal(report.profile.serverClosed, true);
  assert.equal(report.tray.passed, true);
  assert.equal(report.tray.pageRestored, true);
  assert.equal(report.tray.win32ShowWindowUsed, false);
  assert.equal(report.tray.processStopped, false);
  assert.equal(report.tray.actualExitConfirmed, false);
  assert.equal(report.tray.fullAcceptancePassed, false);
  assert.equal(report.tray.uiCloseRequests.length, 2);
  assert.equal(report.tray.restorations.length, 2);
  assert.deepEqual(
    report.tray.restorations.map((r) => r.action),
    ["DoubleClick", "OpenMenu"],
  );
  for (const request of report.tray.uiCloseRequests) {
    assert.equal(request.command, "plugin:window|close");
    assert.equal(request.nativeRequestCount, 1);
    assert.equal(request.nativeResponse, "ok");
    assert.equal(request.actualUiRequestObserved, true);
  }
  for (const row of report.tray.restorations) {
    assert.equal(row.hidden.after.visible, false);
    assert.equal(row.restoration.after.visible, true);
    assert.equal(row.restoration.after.minimized, false);
    assert.equal(row.hidden.after.hwnd, row.restoration.after.hwnd);
    assert.equal(row.bridgeHealthyAfterRestore, true);
  }
  assert.ok(["passed", "unvalidated"].includes(report.tray.exitCancel.status));
  if (report.tray.exitCancel.status === "unvalidated")
    assert.ok(report.tray.exitCancel.reason);
  for (const field of [
    "pageRestored",
    "productionIdentityUnchanged",
    "helperBindingsUnchanged",
    "nativeStoreUnchanged",
    "backgroundSettingsUnchanged",
    "fixtureOriginalsUnchanged",
    "sourceInputsUnchanged",
    "sharedRuntimeInputsUnchanged",
  ])
    assert.equal(
      report[field],
      true,
      "Extra UI restoration/binding incomplete",
    );
  assert.equal(report.nativeStateBeforeSha256, report.nativeStateAfterSha256);
  assert.equal(report.backgroundBeforeSha256, report.backgroundAfterSha256);
  assert.equal(report.pageErrors.length, 0);
}

function guarded(file, root, missing = false) {
  const full = path.resolve(file);
  assert.match(full, /^G:\\/iu);
  assert.ok(
    same(full, root) ||
      full
        .toLowerCase()
        .startsWith(path.resolve(root).toLowerCase() + path.sep),
    "Extra UI path escaped owner scope",
  );
  for (let cursor = full; ; cursor = path.dirname(cursor)) {
    if (fs.existsSync(cursor))
      assert.equal(
        fs.lstatSync(cursor).isSymbolicLink(),
        false,
        "Extra UI reparse ancestor refused",
      );
    else assert.ok(missing, "Required extra UI path absent");
    if (path.dirname(cursor) === cursor) break;
  }
  return full;
}

export async function runProductionExtraUi(setupFile, launchFile) {
  assert.equal(process.platform, "win32");
  const workspace = path.resolve(
    fileURLToPath(new URL("../../", import.meta.url)),
  );
  const setup = JSON.parse(
    fs.readFileSync(
      guarded(setupFile, path.join(workspace, ".cache/native-e2e-sandbox")),
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
  const launch = JSON.parse(fs.readFileSync(guarded(launchFile, root), "utf8"));
  const output = path.join(
    workspace,
    "artifacts/acceptance",
    `production-extra-ui-${setup.ownerId}`,
  );
  const report = {
    schemaVersion: 1,
    ownerId: setup.ownerId,
    scope: extraUiScope,
    complete: false,
    fullAcceptancePassed: false,
    officialClientsLaunched: false,
    credentialsRead: false,
    qaHooksUsed: false,
    applicationInvokeReplaced: false,
    windowsLoginExecuted: false,
    backgroundSettingsMutated: false,
    actualExitConfirmed: false,
    startedAt: new Date().toISOString(),
    passed: false,
    productionSha256: setup.productionSha256,
    sourceDigest: setup.sourceDigest,
    buildAuditId: setup.buildAuditId,
    productionPid: launch.pid,
    productionStartedAt: launch.startedAt,
    setupReceiptSha256: sha(fs.readFileSync(setupFile)),
    launchReceiptSha256: sha(fs.readFileSync(launchFile)),
    pageErrors: [],
    observedNativeCommands: [],
    unvalidated: [
      {
        name: "actual Windows login startup",
        reason:
          "This run does not alter startup settings or execute a new Windows login.",
      },
      {
        name: "official clients, account/default/history and inference",
        reason:
          "Separate bounded GUI run reads no credentials and launches no official clients.",
      },
      {
        name: "actual application exit",
        reason:
          "The owned application remains alive for supervisor cleanup; no confirmed exit acceptance.",
      },
    ],
  };
  const write = () => {
    guarded(output, workspace, true);
    fs.mkdirSync(output, { recursive: true });
    const destination = guarded(
      path.join(output, "production-extra-ui-results.json"),
      output,
      true,
    );
    fs.writeFileSync(destination, JSON.stringify(report, null, 2) + "\n");
  };
  const markerFile = guarded(
    path.join(root, ".ae-production-ui-eight-owner.json"),
    root,
  );
  const markerHash = sha(fs.readFileSync(markerFile));
  const helperNames = [
    "production-extra-ui.mjs",
    "verify-production-extra-ui.ps1",
    "production-profile-surface.mjs",
    "production-ui-surface.mjs",
    "production-tray-surface.mjs",
    "production-owned-tray.ps1",
    "prepare-production-ui-eight.ps1",
    "production-ui-eight-contract.mjs",
    "wait-existing-tauri-page.mjs",
  ];
  report.helperBindings = helperNames.map((name) => {
    const file = guarded(
      path.join(workspace, "tests/acceptance", name),
      workspace,
    );
    return { path: file, sha256: sha(fs.readFileSync(file)) };
  });
  const sourceManifest = JSON.parse(
    fs.readFileSync(guarded(setup.sourceManifest, workspace), "utf8"),
  );
  assert.equal(sourceManifest.digest, setup.sourceDigest);
  assert.equal(sourceManifest.files.length, setup.sourceFiles);
  const sourceHashes = () =>
    sourceManifest.files
      .map((file) => {
        const hash = sha(
          fs.readFileSync(guarded(path.join(workspace, file.path), workspace)),
        );
        assert.equal(
          hash,
          file.sha256,
          "Current production source input changed",
        );
        return file.path + "\0" + hash + "\n";
      })
      .join("");
  const shared = Object.entries(setup.fixtures.sharedRuntimeFiles).map(
    ([file, hash]) => ({ path: file, sha256: hash }),
  );
  const preserved = setup.fixtures.payload.preservedFiles;
  assert.ok(Array.isArray(preserved) && preserved.length > 0);
  report.sharedRuntimeBindings = shared;
  report.preservedFileBindings = preserved;
  const entries = Object.values(setup.fixtures.payload.profiles).map(
    (profile) => {
      const filename = guarded(profile.executablePath, root);
      return { path: filename, sha256: sha(fs.readFileSync(filename)) };
    },
  );
  report.dispatchOnlyEntryBindings = entries;
  const validateFiles = () => {
    for (const entry of shared)
      assert.equal(
        sha(fs.readFileSync(guarded(entry.path, workspace))),
        entry.sha256,
        "Shared runtime input changed",
      );
    for (const entry of preserved)
      assert.equal(
        sha(fs.readFileSync(guarded(entry.path, root))),
        entry.sha256,
        "Original fixture input changed",
      );
    for (const entry of entries)
      assert.equal(
        sha(fs.readFileSync(guarded(entry.path, root))),
        entry.sha256,
        "Dispatch-only fixture entry changed",
      );
    assert.equal(sha(sourceHashes()), setup.sourceDigest);
  };
  function validateOwner() {
    assert.equal(sha(fs.readFileSync(guarded(markerFile, root))), markerHash);
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
      sha(fs.readFileSync(guarded(setup.productionProgram, root))),
      setup.productionSha256,
    );
    assert.equal(sha(fs.readFileSync(setupFile)), report.setupReceiptSha256);
    assert.equal(sha(fs.readFileSync(launchFile)), report.launchReceiptSha256);
    for (const binding of report.helperBindings)
      assert.equal(
        sha(fs.readFileSync(guarded(binding.path, workspace))),
        binding.sha256,
        "Extra UI helper changed",
      );
  }
  let browser, page, baseline, readonlyNative, backgroundBefore, failure;
  let stage = "initial-binding";
  const protectedState = async () => {
    const overview = await readonlyNative("get_overview");
    const hub = await readonlyNative("agent_hub_overview");
    assert.ok(Array.isArray(overview.providers));
    assert.ok(Array.isArray(hub.agents));
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
  try {
    validateOwner();
    validateFiles();
    assert.equal(
      Object.keys(process.env).some((name) =>
        /^UNI_SWITCH_QA_|^AE_NATIVE_/iu.test(name),
      ),
      false,
    );
    write();
    stage = "owned-webview-attach";
    const require = createRequire(path.join(workspace, "app/package.json"));
    const { chromium } = require("playwright");
    browser = await chromium.connectOverCDP("http://127.0.0.1:9223", {
      timeout: 30000,
    });
    page = await waitExistingTauriPage(browser);
    page.setDefaultTimeout(15000);
    page.on("request", (request) => {
      const command = extraNativeCommand(request);
      if (command) report.observedNativeCommands.push(command);
    });
    page.on("pageerror", (error) =>
      report.pageErrors.push({
        name: error.name,
        message: "Production page error observed; raw input omitted.",
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
    readonlyNative = async (command) => {
      assert.ok(
        [
          "get_overview",
          "agent_hub_overview",
          "get_background_settings",
        ].includes(command),
        "Only approved read-only direct invocation is allowed",
      );
      return page.evaluate(
        (name) => window.__TAURI_INTERNALS__.invoke(name),
        command,
      );
    };
    stage = "native-baseline";
    baseline = await protectedState();
    assert.equal(
      baseline.providers.length,
      0,
      "Fresh empty provider store required",
    );
    assert.equal(
      baseline.selections.every((agent) => !agent.configured),
      true,
      "Fresh unconfigured agents required",
    );
    backgroundBefore = await readonlyNative("get_background_settings");
    report.nativeStateBeforeSha256 = sha(JSON.stringify(baseline));
    report.backgroundBeforeSha256 = sha(JSON.stringify(backgroundBefore));
    stage = "profile-surface";
    const { verifyProductionProfiles } = await import(
      "./production-profile-surface.mjs"
    );
    report.profile = await verifyProductionProfiles({
      page,
      setup,
      launch,
      readonlyNative,
    });
    assert.equal(report.profile.passed, true);
    validateOwner();
    validateFiles();
    assertExtraCommands(report.observedNativeCommands);
    write();
    stage = "tray-surface";
    const { verifyProductionTray } = await import(
      "./production-tray-surface.mjs"
    );
    report.tray = await verifyProductionTray({
      page,
      setup,
      launch,
      readonlyNative,
    });
    assert.equal(report.tray.passed, true);
    if (report.tray.exitCancel.status === "unvalidated")
      report.unvalidated.push({
        name: "tray exit cancellation",
        reason: report.tray.exitCancel.reason,
      });
    stage = "final-native-readback";
    const after = await protectedState();
    const backgroundAfter = await readonlyNative("get_background_settings");
    report.nativeStateAfterSha256 = sha(JSON.stringify(after));
    report.backgroundAfterSha256 = sha(JSON.stringify(backgroundAfter));
    report.nativeStoreUnchanged =
      report.nativeStateBeforeSha256 === report.nativeStateAfterSha256;
    report.backgroundSettingsUnchanged =
      report.backgroundBeforeSha256 === report.backgroundAfterSha256;
    assert.equal(report.nativeStoreUnchanged, true);
    assert.equal(report.backgroundSettingsUnchanged, true);
    assert.equal(report.pageErrors.length, 0);
    report.pageRestored =
      report.profile.pageRestored === true && report.tray.pageRestored === true;
  } catch (error) {
    failure = error;
    report.profile ??= error.profileReceipt;
    report.tray ??= error.trayReceipt;
    report.failure = {
      name: error.name,
      stage,
      message:
        "Production extra UI verification failed; raw exception/input omitted.",
    };
  } finally {
    try {
      validateOwner();
      validateFiles();
      report.productionIdentityUnchanged = true;
      report.helperBindingsUnchanged = true;
      report.sourceInputsUnchanged = true;
      report.sharedRuntimeInputsUnchanged = true;
      report.fixtureOriginalsUnchanged = true;
      if (page && baseline && readonlyNative) {
        const after = await protectedState();
        const backgroundAfter = await readonlyNative("get_background_settings");
        report.nativeStateAfterSha256 = sha(JSON.stringify(after));
        report.backgroundAfterSha256 = sha(JSON.stringify(backgroundAfter));
        report.nativeStoreUnchanged =
          report.nativeStateBeforeSha256 === report.nativeStateAfterSha256;
        report.backgroundSettingsUnchanged =
          report.backgroundBeforeSha256 === report.backgroundAfterSha256;
        assert.equal(report.nativeStoreUnchanged, true);
        assert.equal(report.backgroundSettingsUnchanged, true);
      }
      assertExtraCommands(report.observedNativeCommands);
    } catch (error) {
      failure ??= error;
      report.restorationFailure = {
        name: error.name,
        message:
          "Final original/state/helper binding check failed; raw input omitted.",
      };
    }
    await browser?.close().catch(() => {});
    report.finishedAt = new Date().toISOString();
    if (!failure) {
      try {
        assertExtraReceipt(report);
        report.passed = true;
      } catch (error) {
        failure = error;
        report.evidenceFailure = "Extra UI evidence is incomplete.";
      }
    }
    write();
  }
  if (failure) {
    const error = new Error(
      `Production extra UI check failed at ${stage}; inspect structured receipt.`,
    );
    error.extraReceipt = report;
    throw error;
  }
  return report;
}

if (process.argv[1] && same(process.argv[1], fileURLToPath(import.meta.url))) {
  runProductionExtraUi(
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
    .catch(() => {
      console.error(
        "Production extra UI runner failed; inspect structured receipt.",
      );
      process.exitCode = 1;
    });
}
