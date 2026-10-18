// Synthetic contracts only. No GUI, registry, credentials, network or real process is touched.
import assert from "node:assert/strict";
import test from "node:test";
import {
  assertTrayHelperReceipt,
  trayLookupFailureEvidence,
  trayNativeCommand,
  verifyTrayRoundTrip,
} from "./production-tray-surface.mjs";

const setup = {
  ownerId: "a".repeat(32),
  productionSha256: "b".repeat(64),
  sourceDigest: "c".repeat(64),
  buildAuditId: "d".repeat(32),
};
const launch = { pid: 42, startedAt: "2026-10-11T12:00:00.000Z" };
function receipt(action, visible = true) {
  const state = { hwnd: "100", visible, minimized: false, enabled: true };
  return {
    schemaVersion: 1,
    ...setup,
    pid: launch.pid,
    startedAt: launch.startedAt,
    action,
    passed: true,
    retainedHandleValidated: true,
    sourceInputsValidated: true,
    processStopped: false,
    actualExitConfirmed: false,
    win32ShowWindowUsed: false,
    callbackInjectionUsed: false,
    qaHooksUsed: false,
    helperSha256: "e".repeat(64),
    notificationIdentity: { pid: launch.pid, hwnd: 200, uid: 2 },
    before: {
      ...state,
      visible:
        action === "DoubleClick" || action === "OpenMenu" ? false : visible,
    },
    after: state,
    cursorRestored: true,
    overflowRestored: true,
    dpiContextRestored: true,
    lastIconLookup: {
      ownerPid: launch.pid,
      callbackHwnd: "200",
      internalUid: 2,
      guidNull: true,
      identityMethod: "retained-PID-callback-HWND-uID-Shell_NotifyIconGetRect",
      exactVisibleMatches: 1,
    },
    iconInputs: [
      {
        exactOwnerHitTest: true,
        actualInputCompleted: true,
        buttonPairsCompleted: action === "DoubleClick" ? 2 : 1,
        doubleClick: action === "DoubleClick",
        icon: { notificationOwnerHwnd: 200, notificationUid: 2 },
        stableSamples: 2,
      },
    ],
    menuInputs: [
      {
        nativeProcessId: 42,
        requestedName: action === "CancelExit" ? "退出应用…" : "打开 AE Switch",
        exactOwnedMenuHit: true,
        input: "actual-left-mouse",
        hoverHighlighted: true,
        menuDismissed: true,
      },
    ],
    exitDialogObserved: true,
    exitCancelled: true,
    exitDialogHwnd: "300",
    dialogButtonDiagnostics: [
      {
        requestedName: "取消",
        selectedName: "取消",
        actualInputCompleted: true,
      },
    ],
    cancelReadiness: { ready: true },
  };
}
for (const action of ["Observe", "DoubleClick", "OpenMenu", "CancelExit"])
  test("accepts exact synthetic " + action + " receipt", () =>
    assertTrayHelperReceipt(receipt(action), setup, launch, action),
  );
for (const [name, mutate] of [
  [
    "foreign PID",
    (r) => {
      r.pid++;
    },
  ],
  [
    "different process generation",
    (r) => {
      r.startedAt = "2026-10-11T12:00:01Z";
    },
  ],
  [
    "other owner",
    (r) => {
      r.ownerId = "f".repeat(32);
    },
  ],
  [
    "wrong production bytes",
    (r) => {
      r.productionSha256 = "f".repeat(64);
    },
  ],
  [
    "callback PID differs",
    (r) => {
      r.notificationIdentity.pid++;
    },
  ],
  [
    "unknown icon ID",
    (r) => {
      r.notificationIdentity.uid = 1;
    },
  ],
  [
    "mismatched callback HWND",
    (r) => {
      r.lastIconLookup.callbackHwnd = "201";
    },
  ],
  [
    "ambiguous API/UIA match",
    (r) => {
      r.lastIconLookup.exactVisibleMatches = 2;
    },
  ],
  [
    "text-only identity",
    (r) => {
      r.lastIconLookup.identityMethod = "tooltip-only";
    },
  ],
  [
    "ShowWindow substituted",
    (r) => {
      r.win32ShowWindowUsed = true;
    },
  ],
  [
    "callback injection substituted",
    (r) => {
      r.callbackInjectionUsed = true;
    },
  ],
  [
    "unstable layout",
    (r) => {
      r.iconInputs[0].stableSamples = 1;
    },
  ],
  [
    "incomplete double click",
    (r) => {
      r.iconInputs[0].buttonPairsCompleted = 1;
    },
  ],
  [
    "restored different main HWND",
    (r) => {
      r.after.hwnd = "101";
    },
  ],
  [
    "main was never hidden",
    (r) => {
      r.before.visible = true;
    },
  ],
  [
    "cursor not restored",
    (r) => {
      r.cursorRestored = false;
    },
  ],
  [
    "overflow not restored",
    (r) => {
      r.overflowRestored = false;
    },
  ],
])
  test("rejects " + name, () => {
    const r = receipt("DoubleClick");
    mutate(r);
    assert.throws(() =>
      assertTrayHelperReceipt(r, setup, launch, "DoubleClick"),
    );
  });
test("rejects a menu owned by another PID", () => {
  const r = receipt("OpenMenu");
  r.menuInputs[0].nativeProcessId++;
  assert.throws(() => assertTrayHelperReceipt(r, setup, launch, "OpenMenu"));
});
test("rejects exit confirmation where only cancel is allowed", () => {
  const r = receipt("CancelExit");
  r.dialogButtonDiagnostics[0].selectedName = "确定";
  assert.throws(() => assertTrayHelperReceipt(r, setup, launch, "CancelExit"));
});

const request = (url, method = "POST") => ({
  url: () => url,
  method: () => method,
});
test("recognizes encoded real native close request", () =>
  assert.equal(
    trayNativeCommand(request("http://ipc.localhost/plugin%3Awindow%7Cclose")),
    "plugin:window|close",
  ));
for (const url of [
  "http://other.localhost/plugin:window|close",
  "http://ipc.localhost:123/plugin:window|close",
  "https://ipc.localhost/plugin:window|close?x=1",
  "http://user@ipc.localhost/plugin:window|close",
])
  test("rejects non-native close URL " + url, () =>
    assert.equal(trayNativeCommand(request(url)), null),
  );

function fixture({
  eligible = false,
  failAction,
  duplicateRequest = false,
  bridgeHealthy = true,
} = {}) {
  let visible = true,
    listener,
    pending;
  const actions = [];
  const page = {
    on: (event, fn) => {
      assert.equal(event, "request");
      listener = fn;
    },
    off: (event, fn) => {
      assert.equal(listener, fn);
      listener = null;
    },
    waitForResponse: (predicate) =>
      new Promise((resolve) => {
        pending = { predicate, resolve };
      }),
    getByRole: (role, options) => {
      assert.equal(role, "button");
      assert.equal(options.name, "关闭窗口并留在托盘");
      assert.equal(options.exact, true);
      return {
        click: async () => {
          const req = request("http://ipc.localhost/plugin%3Awindow%7Cclose");
          listener(req);
          if (duplicateRequest) listener(req);
          visible = false;
          const res = { request: () => req, headerValue: async () => "ok" };
          assert.equal(pending.predicate(res), true);
          pending.resolve(res);
        },
      };
    },
  };
  const runHelper = async (action) => {
    actions.push(action);
    if (action === failAction)
      throw new Error("synthetic rejected identity before input");
    if (action !== "Observe") visible = true;
    return receipt(action, visible);
  };
  return {
    page,
    setup,
    launch,
    readonlyNative: async (command) => {
      assert.equal(command, "agent_hub_overview");
      return { bridgeHealthy };
    },
    runHelper,
    cancelEligible: async () => eligible,
    actions,
  };
}
test("fresh store restores via both real-input seams and never enters exit menu", async () => {
  const f = fixture(),
    result = await verifyTrayRoundTrip(f);
  assert.equal(result.passed, true);
  assert.deepEqual(
    result.restorations.map((row) => row.action),
    ["DoubleClick", "OpenMenu"],
  );
  assert.equal(result.uiCloseRequests.length, 2);
  assert.equal(result.exitCancel.status, "unvalidated");
  assert.equal(f.actions.includes("CancelExit"), false);
  assert.equal(result.actualExitConfirmed, false);
  assert.equal(result.fullAcceptancePassed, false);
});
test("configured seam tests exact exit dialog cancellation and leaves process running", async () => {
  const f = fixture({ eligible: true }),
    result = await verifyTrayRoundTrip(f);
  assert.equal(result.passed, true);
  assert.equal(result.exitCancel.status, "passed");
  assert.equal(f.actions.filter((a) => a === "CancelExit").length, 1);
  assert.equal(result.processStopped, false);
});
test("rejected icon identity remains failure even if safe recovery works", async () => {
  const f = fixture({ failAction: "OpenMenu" }),
    result = await verifyTrayRoundTrip(f);
  assert.equal(result.passed, false);
  assert.match(result.failure, /rejected identity/);
  assert.equal(result.pageRestored, true);
  assert.equal(result.recovery.action, "DoubleClick");
});
test("failed helper geometry survives rejection without retaining raw tooltip or private input fields", async () => {
  const failed = {
    ...receipt("OpenMenu"),
    passed: false,
    iconInputs: [],
    lastIconLookup: {
      ...receipt("OpenMenu").lastIconLookup,
      bounds: [100, 100, 120, 120],
      uiaBounds: [90, 100, 60, 20],
      tooltipMatches: false,
      uiaCenterInsideNotification: false,
      tooltip: "synthetic-private-tooltip",
      endpoint: "synthetic-private-endpoint",
      apiKey: "synthetic-private-key",
    },
  };
  const evidence = trayLookupFailureEvidence(failed, "OpenMenu");
  const f = fixture();
  const helper = f.runHelper;
  f.runHelper = async (action) => {
    if (action === "OpenMenu") {
      const error = new Error("synthetic rejected icon before input");
      error.trayLookupFailure = evidence;
      throw error;
    }
    return helper(action);
  };
  const result = await verifyTrayRoundTrip(f);
  assert.equal(result.passed, false);
  assert.equal(result.pageRestored, true);
  assert.deepEqual(result.lookupFailure.notificationBounds, [100, 100, 120, 120]);
  assert.deepEqual(result.lookupFailure.uiaBounds, [90, 100, 60, 20]);
  assert.equal(result.lookupFailure.tooltipMatches, false);
  assert.equal(result.lookupFailure.uiaCenterInsideNotification, false);
  assert.equal(result.lookupFailure.iconInputCount, 0);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private-/u);
});
test("failed helper preserves only numeric counts and timing plus completion booleans", () => {
  const diagnostics = {
    samples: 6, stableSamples: 2, moves: 1, buttonPairsCompleted: 1,
    doubleClickLimitMs: 500, pairIntervalMs: 501, validationDurationMs: 541,
    inputElapsedMs: 601, doubleClickDeadlineExceeded: true, actualInputCompleted: false,
    phase: "synthetic-private-phase", failure: "synthetic-private-error",
    beforeMove: { icon: { name: "synthetic-private-name", helpText: "synthetic-private-help" } },
  };
  const evidence = trayLookupFailureEvidence({
    iconPreparationDiagnostics: [diagnostics],
    iconInputs: [{ ...diagnostics, icon: { apiKey: "synthetic-private-key" } }],
  }, "DoubleClick");
  for (const row of [...evidence.iconPreparationDiagnostics, ...evidence.iconInputs]) {
    assert.equal(row.buttonPairsCompleted, 1);
    assert.equal(row.doubleClickLimitMs, 500);
    assert.equal(row.pairIntervalMs, 501);
    assert.equal(row.validationDurationMs, 541);
    assert.equal(row.inputElapsedMs, 601);
    assert.equal(row.actualInputCompleted, false);
    assert.equal(row.doubleClickDeadlineExceeded, true);
    assert.ok(Object.values(row).every((value) => value === null || typeof value === "number" || typeof value === "boolean"));
  }
  assert.equal(evidence.iconPreparationDiagnostics[0].samples, 6);
  assert.equal(evidence.iconPreparationDiagnostics[0].stableSamples, 2);
  assert.equal(evidence.iconPreparationDiagnostics[0].moves, 1);
  assert.doesNotMatch(JSON.stringify(evidence), /synthetic-private-/u);
});
test("failed helper counts and timing reject textual values without coercion", () => {
  const evidence = trayLookupFailureEvidence({
    iconPreparationDiagnostics: [{ samples: "6", moves: -1, stableSamples: Number.NaN }],
    iconInputs: [{ buttonPairsCompleted: "1", doubleClickLimitMs: "500", pairIntervalMs: -1,
      validationDurationMs: Number.POSITIVE_INFINITY, inputElapsedMs: "synthetic-private-time",
      actualInputCompleted: "false", doubleClickDeadlineExceeded: "true" }],
  }, "DoubleClick");
  assert.deepEqual(evidence.iconPreparationDiagnostics[0], {
    samples: null, stableSamples: null, moves: null, buttonPairsCompleted: null,
    doubleClickLimitMs: null, pairIntervalMs: null, validationDurationMs: null, inputElapsedMs: null,
    actualInputCompleted: null, doubleClickDeadlineExceeded: null,
  });
  assert.deepEqual(evidence.iconInputs[0], {
    samples: null, stableSamples: null, moves: null, buttonPairsCompleted: null,
    doubleClickLimitMs: null, pairIntervalMs: -1, validationDurationMs: null, inputElapsedMs: null,
    actualInputCompleted: null, doubleClickDeadlineExceeded: null,
  });
  assert.doesNotMatch(JSON.stringify(evidence), /synthetic-private-/u);
});
test("failure geometry rejects string coordinates and textual identity substitutions", () => {
  const evidence = trayLookupFailureEvidence({
    lastIconLookup: {
      ownerPid: "42",
      callbackHwnd: "synthetic-private-hwnd",
      internalUid: "2",
      exactVisibleMatches: "1",
      bounds: [100, 100, "synthetic-private-coordinate", 120],
      uiaBounds: [100, 100, Number.POSITIVE_INFINITY, 20],
      tooltipMatches: "false",
      uiaCenterInsideNotification: "true",
    },
  }, "DoubleClick");
  for (const field of ["ownerPid", "callbackHwnd", "internalUid", "exactVisibleMatches",
    "notificationBounds", "uiaBounds", "tooltipMatches", "uiaCenterInsideNotification", "iconInputCount"])
    assert.equal(evidence[field], null);
  assert.doesNotMatch(JSON.stringify(evidence), /synthetic-private-/u);
});
test("duplicate close request fails acceptance", async () => {
  const result = await verifyTrayRoundTrip(fixture({ duplicateRequest: true }));
  assert.equal(result.passed, false);
  assert.equal(result.pageRestored, true);
});
test("unhealthy bridge while hidden fails acceptance", async () => {
  const result = await verifyTrayRoundTrip(fixture({ bridgeHealthy: false }));
  assert.equal(result.passed, false);
  assert.equal(result.pageRestored, true);
});
