// Synthetic safety contracts only; no OS setting, GUI, network or process is changed.
import assert from "node:assert/strict";
import test from "node:test";
import {
  assertOwnedWindowState,
  assertSystemCommands,
  assertSystemReceipt,
  systemNativeCommand,
} from "./production-system-ui.mjs";
const setup = { ownerId: "a".repeat(32), productionSha256: "b".repeat(64) };
const launch = { pid: 1234, startedAt: "2026-10-11T12:00:00.0000000Z" };
const state = (restored = false) => ({
  schemaVersion: 1,
  ownerId: setup.ownerId,
  pid: launch.pid,
  startedAt: launch.startedAt,
  productionSha256: setup.productionSha256,
  retainedHandleValidated: true,
  exactHwndValidated: true,
  hwnd: "5678",
  windowClass: "SyntheticWindowClass",
  visible: true,
  minimized: false,
  maximized: false,
  setupRestoreUsed: restored,
  restoreMethod: restored ? "owned Win32 ShowWindow(SW_RESTORE) setup" : null,
  trayInteraction: false,
  trayRestoreClaimed: false,
  processStopped: false,
});
function receipt() {
  const initial = state();
  return {
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
    observedNativeCommands: [
      "get_background_settings",
      "set_background_start",
      "plugin:window|minimize",
      "plugin:window|close",
      "agent_hub_overview",
    ],
    background: {
      passed: true,
      otherEntriesUnchanged: true,
      baseline: {
        target: { present: false },
        otherValuesSha256: "c".repeat(64),
      },
      restoration: {
        baselineRestored: true,
        emergencyUsed: false,
        finalRegistry: {
          target: { present: false },
          otherValuesSha256: "c".repeat(64),
        },
      },
    },
    windowChecks: [
      {
        action: "minimize",
        command: "plugin:window|minimize",
        passed: true,
        nativeRequestCount: 1,
        nativeResponse: "ok",
        bridgeHealthyWhileHidden: true,
        before: initial,
        hidden: { ...initial, minimized: true },
        restoration: state(true),
      },
      {
        action: "close-to-background",
        command: "plugin:window|close",
        passed: true,
        nativeRequestCount: 1,
        nativeResponse: "ok",
        bridgeHealthyWhileHidden: true,
        before: initial,
        hidden: { ...initial, visible: false },
        restoration: state(true),
      },
    ],
    pageRestored: true,
    productionIdentityUnchanged: true,
    helperBindingsUnchanged: true,
    nativeStoreUnchanged: true,
    nativeStateBeforeSha256: "d".repeat(64),
    nativeStateAfterSha256: "d".repeat(64),
    sourceInputsUnchanged: true,
    sharedRuntimeInputsUnchanged: true,
    unvalidated: [
      {
        name: "actual tray icon restore/exit",
        reason: "Not exercised by synthetic contract.",
      },
      {
        name: "actual Windows login startup",
        reason: "Not exercised by synthetic contract.",
      },
    ],
  };
}
test("owned window observation accepts retained exact identity", () =>
  assertOwnedWindowState(state(), setup, launch, {
    visible: true,
    minimized: false,
  }));
test("setup restoration is labelled explicitly without a tray claim", () =>
  assertOwnedWindowState(state(true), setup, launch, {
    setupRestoreUsed: true,
  }));
for (const [field, value] of [
  ["ownerId", "e".repeat(32)],
  ["pid", 5678],
  ["startedAt", "2026-10-11T12:00:01Z"],
  ["productionSha256", "e".repeat(64)],
  ["retainedHandleValidated", false],
  ["exactHwndValidated", false],
  ["hwnd", "0"],
  ["windowClass", ""],
  ["trayInteraction", true],
  ["trayRestoreClaimed", true],
  ["processStopped", true],
  ["restoreMethod", "tray restore"],
]) {
  test("reject forged or unsafe window state: " + field, () =>
    assert.throws(() =>
      assertOwnedWindowState({ ...state(), [field]: value }, setup, launch),
    ),
  );
}
test("expected independent minimized state cannot be substituted with DOM state", () =>
  assert.throws(() =>
    assertOwnedWindowState(state(), setup, launch, { minimized: true }),
  ));
for (const origin of [
  "http://ipc.localhost",
  "https://ipc.localhost",
  "ipc://localhost",
]) {
  test("exact production native command origin: " + origin, () =>
    assert.equal(
      systemNativeCommand({
        method: () => "POST",
        url: () => origin + "/plugin%3Awindow%7Cclose",
      }),
      "plugin:window|close",
    ),
  );
}
for (const url of [
  "https://ipc.localhost.attacker.invalid/set_background_start",
  "http://localhost/set_background_start",
  "http://ipc.localhost:9223/set_background_start",
  "http://ipc.localhost/set_background_start?fake=1",
]) {
  test("reject forged native route: " + url, () =>
    assert.equal(
      systemNativeCommand({ method: () => "POST", url: () => url }),
      null,
    ),
  );
}
test("system-only command allowlist permits startup and window UI actions", () =>
  assertSystemCommands(receipt().observedNativeCommands));
for (const command of [
  "save_provider",
  "agent_hub_configure",
  "agent_hub_launch",
  "agent_hub_restart",
  "agent_hub_probe",
  "open_project_page",
  "agent_hub_open_directory",
  "plugin:window|toggle_maximize",
]) {
  test("system run rejects unrelated native command: " + command, () =>
    assert.throws(() => assertSystemCommands([command])),
  );
}
test("honest bounded system receipt passes without any eight-client claim", () =>
  assertSystemReceipt(receipt()));
for (const [name, mutate] of [
  [
    "full acceptance claim",
    (report) => {
      report.fullAcceptancePassed = true;
    },
  ],
  [
    "tray restoration claim",
    (report) => {
      report.trayRestoreClaimed = true;
    },
  ],
  [
    "real Windows login claim",
    (report) => {
      report.windowsLoginExecuted = true;
    },
  ],
  [
    "credential read",
    (report) => {
      report.credentialsRead = true;
    },
  ],
  [
    "official client action",
    (report) => {
      report.officialClientsLaunched = true;
    },
  ],
  [
    "emergency removal counted as pass",
    (report) => {
      report.background.restoration.emergencyUsed = true;
    },
  ],
  [
    "lost original other registry entry",
    (report) => {
      report.background.restoration.finalRegistry.otherValuesSha256 = "changed";
    },
  ],
  [
    "retained startup value",
    (report) => {
      report.background.restoration.finalRegistry.target.present = true;
    },
  ],
  [
    "wrong owned HWND restored",
    (report) => {
      report.windowChecks[0].restoration.hwnd = "9999";
    },
  ],
  [
    "DOM close with visible native window",
    (report) => {
      report.windowChecks[1].hidden.visible = true;
    },
  ],
  [
    "minimize without native iconic state",
    (report) => {
      report.windowChecks[0].hidden.minimized = false;
    },
  ],
  [
    "bridge stopped while hidden",
    (report) => {
      report.windowChecks[0].bridgeHealthyWhileHidden = false;
    },
  ],
  [
    "duplicate native click",
    (report) => {
      report.windowChecks[0].nativeRequestCount = 2;
    },
  ],
  [
    "native UI error",
    (report) => {
      report.windowChecks[0].nativeResponse = "error";
    },
  ],
  [
    "missing window check",
    (report) => {
      report.windowChecks.pop();
    },
  ],
  [
    "changed source inputs",
    (report) => {
      report.sourceInputsUnchanged = false;
    },
  ],
  [
    "changed native config",
    (report) => {
      report.nativeStateAfterSha256 = "changed";
    },
  ],
  [
    "changed helpers",
    (report) => {
      report.helperBindingsUnchanged = false;
    },
  ],
  [
    "omitted remaining scopes",
    (report) => {
      report.unvalidated = [];
    },
  ],
]) {
  test("reject system receipt with " + name, () => {
    const report = receipt();
    mutate(report);
    assert.throws(() => assertSystemReceipt(report));
  });
}
