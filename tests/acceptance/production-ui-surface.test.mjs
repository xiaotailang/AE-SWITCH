// Synthetic contracts only. These tests do not launch or accept a production GUI.
import assert from "node:assert/strict";
import test from "node:test";
import {
  SURFACE_CHECKS,
  nativeSurfaceCommand,
  assertSurfaceCommands,
  assertFailedDiscovery,
  assertSurfaceReceipt,
  verifyProductionSurface,
  exactPreparedProfileOption,
} from "./production-ui-surface.mjs";

test("select the exact prepared native profile among other real discovered profiles", () => {
  const expected = { directory: "G:/owned/zcode", executablePath: "G:/owned/zcode.ps1", workspaceDirectory: "G:/owned/workspace" };
  const foreign = { ...expected, directory: "G:/another-real/zcode" };
  const selected = JSON.stringify(expected);
  assert.deepEqual(exactPreparedProfileOption(["", "manual", JSON.stringify(foreign), selected], expected), { value: selected, candidateCount: 2 });
  assert.deepEqual(exactPreparedProfileOption([selected], expected), { value: selected, candidateCount: 1 });
});

test("reject missing or duplicate exact prepared profiles without falling back", () => {
  const expected = { directory: "G:/owned/zcode", executablePath: "G:/owned/zcode.ps1" };
  const selected = JSON.stringify(expected);
  assert.throws(() => exactPreparedProfileOption(["", JSON.stringify({ ...expected, directory: "G:/other" })], expected));
  assert.throws(() => exactPreparedProfileOption([selected, selected], expected));
  assert.throws(() => exactPreparedProfileOption(["null", "[]", "42", "broken"], expected));
});

const request = (url, method = "POST") => ({
  url: () => url,
  method: () => method,
});
const failedDiscovery = () => ({
  observedRequests: 1,
  native: {
    command: "discover_provider_connection",
    tauriResponse: "error",
    errorCode: "network",
  },
  ui: {
    failure: "Visible network failure",
    models: [],
    confirmDisabled: true,
    modelDisabled: true,
    retryEnabled: true,
  },
});
function receipt(phase = "before", providerAvailable = false) {
  return {
    schemaVersion: 1,
    ownerId: "a".repeat(32),
    phase,
    providerAvailable,
    complete: false,
    productionNativeIpc: true,
    qaHooksUsed: false,
    applicationInvokeReplaced: false,
    systemStartupMutated: false,
    externalProgramOpened: false,
    clientLaunchedOrRestarted: false,
    nativeStoreUnchanged: true,
    pageRestored: true,
    nativeStateBeforeSha256: "b".repeat(64),
    nativeStateAfterSha256: "b".repeat(64),
    observedNativeCommands: [
      "get_overview",
      "agent_hub_overview",
      "get_background_settings",
      "plugin:window|is_maximized",
      "plugin:window|toggle_maximize",
      ...(phase === "after" && providerAvailable
        ? [
            "agent_hub_discover",
            "discover_provider_connection",
            "agent_hub_runtime",
          ]
        : []),
    ],
    window: {
      initialNativeMaximized: false,
      toggledNativeMaximized: true,
      restoredNativeMaximized: false,
    },
    background: { supported: true, enabled: false, nativeResponse: "ok" },
    failedDiscovery: { initial: failedDiscovery(), retry: failedDiscovery() },
    checks: [
      ...SURFACE_CHECKS.common,
      ...(phase === "before"
        ? SURFACE_CHECKS.before
        : providerAvailable
          ? SURFACE_CHECKS.after
          : []),
    ].map((name) => ({ name, status: "passed" })),
    unvalidated: [
      {
        name: "actual Windows login autostart enable/disable",
        status: "unvalidated",
        reason: "Synthetic contract does not mutate the OS.",
      },
      ...(phase === "after" && !providerAvailable
        ? [
            {
              name: "saved supplier, manual profile gate and discovery retry",
              status: "unvalidated",
              reason: "No saved provider.",
            },
          ]
        : []),
    ],
  };
}

for (const origin of [
  "http://ipc.localhost",
  "https://ipc.localhost",
  "ipc://localhost",
]) {
  test("accept exact native POST origin: " + origin, () => {
    assert.equal(
      nativeSurfaceCommand(request(origin + "/agent_hub_runtime")),
      "agent_hub_runtime",
    );
    assert.equal(
      nativeSurfaceCommand(request(origin + "/plugin%3Awindow%7Cis_maximized")),
      "plugin:window|is_maximized",
    );
  });
}
for (const url of [
  "https://ipc.localhost.attacker.invalid/get_overview",
  "http://localhost/get_overview",
  "https://attacker.invalid/ipc.localhost/get_overview",
  "file:///get_overview",
  "http://ipc.localhost:8080/get_overview",
  "http://user:pass@ipc.localhost/get_overview",
  "http://ipc.localhost/get_overview?fake=1",
  "http://ipc.localhost/get_overview#fake",
  "http://ipc.localhost/",
  "http://ipc.localhost/agent_hub_runtime/extra",
  "http://ipc.localhost/%ZZ",
]) {
  test("reject non-native or malformed route: " + url, () =>
    assert.equal(nativeSurfaceCommand(request(url)), null),
  );
}
test("reject non-POST and broken request metadata", () => {
  assert.equal(
    nativeSurfaceCommand(request("http://ipc.localhost/get_overview", "GET")),
    null,
  );
  assert.equal(
    nativeSurfaceCommand({
      url() {
        throw Error("broken");
      },
    }),
    null,
  );
});
test("accept read commands and bounded window controls", () => {
  assertSurfaceCommands([
    "get_overview",
    "agent_hub_overview",
    "agent_hub_discover",
    "get_background_settings",
    "agent_hub_runtime",
    "discover_provider_connection",
    "plugin:window|is_maximized",
    "plugin:window|toggle_maximize",
    "plugin:event|listen",
    "plugin:event|unlisten",
  ]);
});
for (const command of [
  "save_provider",
  "delete_provider",
  "agent_hub_configure",
  "agent_hub_probe",
  "agent_hub_launch",
  "agent_hub_restart",
  "set_background_start",
  "open_project_page",
  "agent_hub_open_directory",
  "plugin:window|minimize",
  "plugin:window|close",
  "get_agent_runtime",
]) {
  test("reject mutating, external or nonexistent command: " + command, () =>
    assert.throws(() => assertSurfaceCommands([command])),
  );
}
test("one real failed discovery retains blocked controls and an enabled retry", () =>
  assertFailedDiscovery(failedDiscovery()));
for (const [name, mutate] of [
  [
    "missing native request",
    (value) => {
      value.observedRequests = 0;
    },
  ],
  [
    "duplicate native retry",
    (value) => {
      value.observedRequests = 2;
    },
  ],
  [
    "native success posed as failure",
    (value) => {
      value.native.tauriResponse = "ok";
    },
  ],
  [
    "wrong Rust error",
    (value) => {
      value.native.errorCode = "invalid_key";
    },
  ],
  [
    "hidden error",
    (value) => {
      value.ui.failure = "";
    },
  ],
  [
    "stale models retained",
    (value) => {
      value.ui.models = ["synthetic-old"];
    },
  ],
  [
    "confirmation enabled",
    (value) => {
      value.ui.confirmDisabled = false;
    },
  ],
  [
    "model dropdown enabled",
    (value) => {
      value.ui.modelDisabled = false;
    },
  ],
  [
    "retry unavailable",
    (value) => {
      value.ui.retryEnabled = false;
    },
  ],
]) {
  test("reject failure receipt with " + name, () => {
    const value = failedDiscovery();
    mutate(value);
    assert.throws(() => assertFailedDiscovery(value));
  });
}
for (const [phase, available] of [
  ["before", false],
  ["after", false],
  ["after", true],
]) {
  test(
    "accept honest bounded synthetic receipt: " + phase + "/" + available,
    () => assertSurfaceReceipt(receipt(phase, available)),
  );
}
for (const [name, mutate] of [
  [
    "full acceptance claim",
    (value) => {
      value.complete = true;
    },
  ],
  [
    "QA hook",
    (value) => {
      value.qaHooksUsed = true;
    },
  ],
  [
    "invoke replacement",
    (value) => {
      value.applicationInvokeReplaced = true;
    },
  ],
  [
    "OS startup mutation",
    (value) => {
      value.systemStartupMutated = true;
    },
  ],
  [
    "external opener",
    (value) => {
      value.externalProgramOpened = true;
    },
  ],
  [
    "official client action",
    (value) => {
      value.clientLaunchedOrRestarted = true;
    },
  ],
  [
    "store mutation",
    (value) => {
      value.nativeStateAfterSha256 = "c".repeat(64);
    },
  ],
  [
    "incomplete restoration",
    (value) => {
      value.pageRestored = false;
    },
  ],
  [
    "omitted GUI check",
    (value) => {
      value.checks.pop();
    },
  ],
  [
    "invented GUI check",
    (value) => {
      value.checks.push({ name: "imagined feature", status: "passed" });
    },
  ],
  [
    "duplicate GUI check",
    (value) => {
      value.checks.push(value.checks[0]);
    },
  ],
  [
    "unpassed GUI check",
    (value) => {
      value.checks[0].status = "failed";
    },
  ],
  [
    "missing native observation",
    (value) => {
      value.observedNativeCommands = [];
    },
  ],
  [
    "maximized DOM without native change",
    (value) => {
      value.window.toggledNativeMaximized = false;
    },
  ],
  [
    "window not restored",
    (value) => {
      value.window.restoredNativeMaximized = true;
    },
  ],
  [
    "no documented gaps",
    (value) => {
      value.unvalidated = [];
    },
  ],
  [
    "gap without reason",
    (value) => {
      value.unvalidated[0].reason = "";
    },
  ],
  [
    "unvalidated reported passed",
    (value) => {
      value.unvalidated[0].status = "passed";
    },
  ],
]) {
  test("reject synthetic evidence with " + name, () => {
    const value = receipt();
    mutate(value);
    assert.throws(() => assertSurfaceReceipt(value));
  });
}
test("missing provider requires explicit saved-connection gap", () => {
  const value = receipt("after");
  value.unvalidated.pop();
  assert.throws(() => assertSurfaceReceipt(value));
});
test("post-run evidence must bind both automatic failure and explicit retry", () => {
  const value = receipt("after", true);
  value.failedDiscovery.retry.observedRequests = 0;
  assert.throws(() => assertSurfaceReceipt(value));
});
test("early GUI prerequisite failure retains receipt and avoids changing an existing credential draft", async () => {
  const listeners = new Map();
  let unexpectedActions = 0;
  const page = {
    on(name, handler) {
      listeners.set(name, handler);
    },
    off(name, handler) {
      assert.equal(listeners.get(name), handler);
      listeners.delete(name);
    },
    async evaluate() {
      return { keyEmpty: false };
    },
    getByRole() {
      unexpectedActions++;
      throw Error("No GUI mutation is permitted");
    },
    locator() {
      unexpectedActions++;
      throw Error("No GUI mutation is permitted");
    },
  };
  const readonlyNative = async (command) =>
    command === "get_overview" ? { providers: [] } : { agents: [] };
  await assert.rejects(
    () =>
      verifyProductionSurface({
        page,
        setup: { ownerId: "a".repeat(32) },
        readonlyNative,
      }),
    (error) => {
      assert.equal(error.surfaceReceipt.passed, false);
      assert.equal(error.surfaceReceipt.pageRestored, true);
      assert.equal(error.surfaceReceipt.nativeStoreUnchanged, true);
      assert.equal(
        error.surfaceReceipt.failure.check,
        "initial production surface prerequisites",
      );
      return true;
    },
  );
  assert.equal(listeners.size, 0);
  assert.equal(unexpectedActions, 0);
});
