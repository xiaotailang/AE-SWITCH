import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENTS, FLAGS } from "./production-ui-eight-contract.mjs";
import {
  assertArtifactPrivacy,
  assertProductionEvidence,
  observeToolWorkspace,
  preparedWorkspaceInput,
  assertPreparedProfilePaths,
} from "./verify-production-ui-eight-evidence.mjs";
import { registerPrivateValue } from "./acceptance-private-values.mjs";
import { SURFACE_CHECKS } from "./production-ui-surface.mjs";

const ownerId = "a".repeat(32);
const productionSha256 = "b".repeat(64);
const buildAuditId = "c".repeat(32);
const supervisorSha256 = "d".repeat(64);
const sandbox = "G:\\owned\\.cache\\native-e2e-sandbox\\" + ownerId;
const options = { sandboxAbsent: true, supervisorSha256 };

test("ordinary-discovered native Codex profile uses the actual manifest executable while its writable paths remain owned", () => {
  const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const installations = JSON.parse(fs.readFileSync(path.join(workspace, ".cache/tmp/official-installations-20261017.json"), "utf8"));
  const entry = installations.runtimes.codex;
  const hash = createHash("sha256").update(fs.readFileSync(entry)).digest("hex");
  const root = fs.mkdtempSync(path.join(workspace, ".cache/tmp/native-profile-"));
  const guard = (file) => {
    assert.ok(path.resolve(file).startsWith(root + path.sep));
    return file;
  };
  try {
    const profile = { directory:path.join(root,".codex"), homeDirectory:path.join(root,"home"), workspaceDirectory:path.join(root,"workspace"), executablePath:entry };
    const setup = { fixtures:{ payload:{ nativeCodexEntry:true }, sharedRuntimeFiles:{ [entry]:hash } } };
    assertPreparedProfilePaths({workspace,setup,id:"codex",profile,guard});
    assert.throws(() => assertPreparedProfilePaths({workspace,setup,id:"claude_code",profile,guard}));
    for (const key of ["directory","homeDirectory","workspaceDirectory"])
      assert.throws(() => assertPreparedProfilePaths({workspace,setup,id:"codex",profile:{...profile,[key]:path.join(workspace,"foreign")},guard}));
    const bad = structuredClone(setup); bad.fixtures.sharedRuntimeFiles[entry]="0".repeat(64);
    assert.throws(() => assertPreparedProfilePaths({workspace,setup:bad,id:"codex",profile,guard}));
  } finally { fs.rmdirSync(root); assert.equal(fs.existsSync(root),false); }
});

test("native Codex observations require exact official bytes and a retained owner parent", () => {
  const value = records();
  const entry = "G:\\owned\\official\\codex.exe";
  const hash = "9".repeat(64);
  value.setup.fixtures = {
    payload: {
      nativeCodexEntry: true,
      profiles: { codex: { executablePath: entry } },
    },
    sharedRuntimeFiles: { [entry]: hash },
  };
  const observation = value.supervisor.launcherObservations.find(
    (row) => row.agentId === "codex",
  );
  Object.assign(observation, {
    nativeOfficialEntry: true,
    launcher: entry,
    pids: [77],
  });
  value.supervisor.retainedProcesses = [
    { pid: 42, exited: true },
    {
      pid: 77,
      parentPid: 42,
      image: entry,
      sha256: hash,
      kind: "shared-official-runtime",
      exited: true,
    },
  ];
  assert.equal(assertProductionEvidence(value, options).productionUiEightPassed, true);
  for (const mutate of [
    (v) => { v.supervisor.retainedProcesses[1].sha256 = "8".repeat(64); },
    (v) => { v.supervisor.retainedProcesses[1].parentPid = 99; },
    (v) => { v.supervisor.retainedProcesses[1].image = "G:\\foreign\\codex.exe"; },
    (v) => { v.supervisor.retainedProcesses[1].kind = "unproved"; },
    (v) => { v.supervisor.launcherObservations.find((row) => row.agentId === "codex").nativeOfficialEntry = false; },
  ]) {
    const changed = structuredClone(value);
    mutate(changed);
    assert.throws(() => assertProductionEvidence(changed, options));
  }
});

test("mapped read-only inputs retain the exact real G workspace boundary", () => {
  const workspace = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  assert.match(workspace, /^G:\\/iu);
  const root = fs.mkdtempSync(path.join(workspace, ".cache/tmp/mapped-input-"));
  const file = path.join(root, "installation.json");
  const target = path.join(root, "ordinary");
  const link = path.join(root, "redirected");
  try {
    fs.writeFileSync(file, "{}", { flag: "wx" });
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "input.json"), "{}", { flag: "wx" });
    assert.equal(preparedWorkspaceInput(workspace, file), file);
    assert.throws(() => preparedWorkspaceInput(workspace, "C:\\outside.json"));
    assert.throws(() =>
      preparedWorkspaceInput(workspace, path.resolve(workspace, "../outside.json")),
    );
    assert.throws(() => preparedWorkspaceInput(workspace, "relative.json"));
    assert.throws(() =>
      preparedWorkspaceInput(workspace, path.join(root, "missing.json")),
    );
    assert.equal(
      preparedWorkspaceInput(workspace, path.join(root, "missing.json"), {
        missing: true,
      }),
      path.join(root, "missing.json"),
    );
    fs.symlinkSync(target, link, "junction");
    assert.throws(() =>
      preparedWorkspaceInput(workspace, path.join(link, "input.json")),
    );
    fs.unlinkSync(link);
  } finally {
    if (fs.existsSync(link)) fs.unlinkSync(link);
    assert.ok(root.startsWith(path.join(workspace, ".cache/tmp/mapped-input-")));
    for (const candidate of [file, path.join(target, "input.json")])
      if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
    if (fs.existsSync(target)) fs.rmdirSync(target);
    fs.rmdirSync(root);
    assert.equal(fs.existsSync(root), false);
  }
});

function records() {
  const files = [{ path: "app/src/App.tsx", sha256: "e".repeat(64) }];
  const sourceDigest = createHash("sha256")
    .update(files.map((file) => file.path + "\0" + file.sha256 + "\n").join(""))
    .digest("hex");
  const common = {
    ownerId,
    productionSha256,
    sourceDigest,
    buildAuditId,
    qaHooksUsed: false,
    discoveryContextInjected: false,
  };
  const setup = { ...common, sourceFiles: files.length };
  const launch = {
    ...common,
    pid: 42,
    retainedHandleValidated: true,
    cdpListener: { retainedDescendantValidated: true },
  };
  const result = {
    ...common,
    schemaVersion: 2,
    productionPid: 42,
    ordinaryDiscoveryUsed: true,
    full218QaSuiteClaimed: false,
    officialDesktopLoginOrDefaultClaimed: false,
    foreignMachineClaimed: false,
    sourceBeforeAfterUnchanged: true,
    helperInputsUnchanged: true,
    sharedOfficialRuntimeBytesUnchanged: true,
    dispatchOnlyEntryBytesUnchanged: true,
    preservedFilesUnchanged: true,
    sourceFilesCompared: files.length,
    singlePageConnectionFlow: true,
    passed: true,
    passedCount: 8,
    failedCount: 0,
    firstPassedCount: 8,
    independentRetestPassedCount: 8,
    clients: [],
    pageErrors: [],
  };
  const supervisor = {
    ...common,
    productionPid: 42,
    sandbox,
    helperBindingsUnchangedThroughCleanup: true,
    sourceInputsUnchangedThroughCleanup: true,
    wrapperBeforeAfterUnchanged: true,
    supervisorBeforeAfterUnchanged: true,
    identityFailure: false,
    unprovedExternalProcessStopped: false,
    externalObservation: { ownershipClaimed: false, processesStopped: 0 },
    cleanup: { removed: true, processesExited: true },
    retainedProcesses: [{ exited: true }],
    passed: true,
    passedCount: 8,
    failedCount: 0,
    uiPassed: true,
    firstPassedCount: 8,
    independentRetestPassedCount: 8,
    wholeRunTimeoutSeconds: 3600,
    wholeRunDeadlineNeverReset: true,
    wholeRunTimedOut: false,
    runnerExitCode: 0,
    allEightLauncherObserved: true,
    launcherObservations: AGENTS.map((agentId) => ({
      agentId,
      retainedProcessObserved: true,
    })),
  };
  const ipc = [];
  for (const id of AGENTS) {
    const profile = { directory: sandbox + "\\" + id };
    const expected = {
      agentId: id,
      providerId: "provider",
      model: "real-model",
      profile,
    };
    const configuration = {
      id,
      configured: true,
      mode: "existing",
      providerId: "provider",
      model: expected.model,
      configurationRevision: 1,
      profile,
    };
    const probe = {
      ok: true,
      toolVerified: true,
      validationScope: "tool",
      stage: "verified",
      model: expected.model,
      profileMode: "existing",
      clientSurface: "headless-cli",
      verificationScope: "headless_tool_write_read",
      desktopGuiVerified: false,
      desktopDefaultSelectionVerified: false,
      explicitModelArgument: id === "workbuddy",
      nativeDefaultModelVerified: id !== "workbuddy",
      evidence: Object.fromEntries(FLAGS.map((flag) => [flag, true])),
      cleanup: {
        succeeded: true,
        removed: true,
        scope: "owned-uuid-verification-directory",
      },
    };
    if (id === "deepseek_harness")
      Object.assign(probe.evidence, {
        terminalCompletionRequired: true,
        terminalCompletedObserved: true,
      });
    const discovery = {
      models: [expected.model],
      receipt: {
        sequence: ipc.length + 1,
        command: "discover_provider_connection",
        actualUiRequestObserved: true,
        method: "POST",
        url: "http://ipc.localhost/discover_provider_connection",
        tauriResponse: "ok",
        result: { models: [{ id: expected.model }] },
      },
    };
    ipc.push(discovery.receipt);
    const uiClickIpc = ["save_provider", "configure_agent", "probe_agent"].map(
      (command) => {
        const row = {
          sequence: ipc.length + 1,
          command,
          actualUiRequestObserved: true,
          method: "POST",
          url: "http://ipc.localhost/" + command,
          tauriResponse: "ok",
          input: { input: { ...expected } },
          result: command === "probe_agent" ? probe : configuration,
        };
        ipc.push(row);
        return row;
      },
    );
    const readback = {
      agent: id,
      nativeAuthentication: true,
      modelRoutesVerified: true,
      originalProfileMatched: true,
      noPrivateWrapper: true,
      transactionSettled: true,
    };
    const observation = (round) => {
      const nonce =
        String(AGENTS.indexOf(id) + 1).padStart(8, "0") +
        "-0000-4000-8000-" +
        String(round).padStart(12, "0");
      const directoryName = ".ae-tool-verification-" + nonce;
      return {
        directoryName,
        relativeDirectory: "agent-verification/" + id + "/" + directoryName,
        createdDuringInvocation: true,
        absentAfterProbe: true,
        markerContentsObserved: false,
      };
    };
    const retestProbe = structuredClone(probe);
    const retestReceipt = {
      sequence: ipc.length + 1,
      command: "probe_agent",
      actualUiRequestObserved: false,
      actualNativeRequestObserved: true,
      invocationSurface: "native-ipc",
      independentRetest: true,
      method: "POST",
      url: "http://ipc.localhost/probe_agent",
      tauriResponse: "ok",
      input: { input: { ...expected } },
      result: retestProbe,
    };
    ipc.push(retestReceipt);
    result.clients.push({
      id,
      providerId: expected.providerId,
      model: expected.model,
      passed: true,
      firstPassed: true,
      independentRetestPassed: true,
      firstVerificationSurface: "ui-confirmation",
      desktopLoginOrDefaultClaimed: false,
      discovery,
      configuration,
      probe,
      uiClickIpc,
      readback,
      toolWorkspaceObservation: observation(1),
      independentRetest: {
        passed: true,
        surface: "native-ipc",
        configuration: structuredClone(configuration),
        probe: retestProbe,
        receipt: retestReceipt,
        readback: structuredClone(readback),
        toolWorkspaceObservation: observation(2),
      },
      screenshot: { privateInputAndErrorRegionsMasked: true },
    });
  }
  const sourceBefore = { files, digest: sourceDigest, fileCount: files.length };
  return {
    result,
    supervisor,
    setup,
    launch,
    ipc,
    sourceBefore,
    sourceAfter: structuredClone(sourceBefore),
  };
}

function failedRecords(count = 0) {
  const value = records();
  value.result.clients.slice(count).forEach((client) => {
    client.passed = false;
    client.firstPassed = false;
    client.independentRetestPassed = false;
    client.failure = "upstream timeout";
    delete client.probe;
    delete client.uiClickIpc;
    delete client.configuration;
  });
  value.result.passed = false;
  value.result.passedCount = count;
  value.result.failedCount = 8 - count;
  value.result.firstPassedCount = count;
  value.result.independentRetestPassedCount = count;
  value.supervisor.passed = false;
  value.supervisor.uiPassed = false;
  value.supervisor.passedCount = count;
  value.supervisor.failedCount = 8 - count;
  value.supervisor.firstPassedCount = count;
  value.supervisor.independentRetestPassedCount = count;
  value.supervisor.runnerExitCode = 1;
  value.ipc = value.ipc.filter(
    (row) =>
      count > 0 &&
      value.result.clients
        .slice(0, count)
        .some(
          (client) =>
            client.uiClickIpc.includes(row) ||
            client.discovery.receipt === row ||
            client.independentRetest.receipt === row,
        ),
  );
  return value;
}

test("complete native tool proof and cleanup yield an eight-client pass", () => {
  const summary = assertProductionEvidence(records(), options);
  assert.equal(summary.productionUiEightPassed, true);
  assert.equal(summary.firstPassedCount, 8);
  assert.equal(summary.independentRetestPassedCount, 8);
  assert.equal(summary.independentRetestSurface, "native-ipc");
  assert.equal(summary.screenshotVisualReviewPerformed, false);
  assert.equal(summary.officialDesktopLoginOrDefaultClaimed, false);
});

function zcodeCanonicalRecords() {
  const value = records();
  const client = value.result.clients.find((row) => row.id === "zcode");
  const requested = {
    directory: sandbox + "\\installed-clients\\home\\.zcode\\v2",
    homeDirectory: sandbox + "\\installed-clients\\home",
    executablePath: sandbox + "\\installed-clients\\bin\\zcode.ps1",
    workspaceDirectory: sandbox + "\\installed-clients\\workspace",
    dataDirectory: sandbox + "\\installed-clients\\home\\.zcode",
    configFile:
      sandbox + "\\installed-clients\\home\\.zcode\\v2\\provider_config.json",
    builtinConfigFile:
      sandbox + "\\installed-clients\\home\\.zcode\\v2\\builtin-providers.json",
    xdgConfigDirectory: sandbox + "\\installed-clients\\home\\.config",
  };
  const stateFile =
    sandbox +
    "\\installed-clients\\home\\.zcode\\native-storage\\v2/agents-state.json";
  const canonical = { ...requested, stateFile };
  value.setup.fixtures = {
    payload: {
      discoveredProfiles: { zcode: structuredClone(requested) },
      profiles: {
        zcode: { ...canonical, stateFile: stateFile.replaceAll("/", "\\") },
      },
    },
  };
  client.configuration.profile = structuredClone(canonical);
  client.independentRetest.configuration.profile = structuredClone(canonical);
  for (const row of client.uiClickIpc) {
    row.input.input.profile = structuredClone(requested);
    if (row.command === "configure_agent")
      row.result = structuredClone(client.configuration);
  }
  client.independentRetest.receipt.input.input.profile =
    structuredClone(requested);
  for (const readback of [client.readback, client.independentRetest.readback])
    readback.files = [
      { slot: "state", path: stateFile, sha256: "f".repeat(64) },
    ];
  return value;
}

test("ZCode native state path is bound to the original fixture while all three requests retain the discovered profile", () => {
  const summary = assertProductionEvidence(zcodeCanonicalRecords(), options);
  assert.equal(summary.productionUiEightPassed, true);
  assert.equal(summary.firstPassedCount, 8);
  assert.equal(summary.independentRetestPassedCount, 8);
});

for (const field of [
  "directory",
  "homeDirectory",
  "executablePath",
  "workspaceDirectory",
  "dataDirectory",
  "configFile",
  "builtinConfigFile",
  "xdgConfigDirectory",
  "providerId",
  "model",
]) {
  test(`ZCode canonicalization cannot conceal changed ${field} in the original UI request`, () => {
    const value = zcodeCanonicalRecords();
    const client = value.result.clients.find((row) => row.id === "zcode");
    const input = client.uiClickIpc.find(
      (row) => row.command === "configure_agent",
    ).input.input;
    if (["providerId", "model"].includes(field)) input[field] += "-changed";
    else input.profile[field] += "-changed";
    assert.throws(() => assertProductionEvidence(value, options));
  });
}

for (const mutate of [
  (client) => {
    client.configuration.profile.stateFile += ".changed";
  },
  (client) => {
    client.configuration.profile.unexpectedNativePath = "G:\\elsewhere";
  },
  (client) => {
    client.uiClickIpc.find(
      (row) => row.command === "probe_agent",
    ).input.input.profile.stateFile = client.configuration.profile.stateFile;
  },
  (client) => {
    client.independentRetest.receipt.input.input.profile.stateFile =
      client.configuration.profile.stateFile;
  },
  (client) => {
    client.independentRetest.configuration.configurationRevision++;
  },
  (client) => {
    client.readback.files[0].path += ".changed";
  },
  (client) => {
    client.independentRetest.readback.files[0].path += ".changed";
  },
  (client) => {
    client.independentRetest.readback.files = [];
  },
]) {
  test("ZCode canonicalization preserves native output, request identity and both physical state readbacks", () => {
    const value = zcodeCanonicalRecords();
    mutate(value.result.clients.find((row) => row.id === "zcode"));
    assert.throws(() => assertProductionEvidence(value, options));
  });
}

test("adding a native stateFile for another client is rejected", () => {
  const value = records();
  const client = value.result.clients.find((row) => row.id === "codex");
  client.configuration = structuredClone(client.configuration);
  client.configuration.profile.stateFile = "G:\\unexpected\\state.json";
  client.uiClickIpc.find((row) => row.command === "configure_agent").result =
    structuredClone(client.configuration);
  client.independentRetest.configuration = structuredClone(
    client.configuration,
  );
  assert.throws(() => assertProductionEvidence(value, options));
});

test("current surface-integrated receipts cannot omit either native surface phase", () => {
  for (const surface of [undefined, { before: { passed: true } }]) {
    const value = records();
    value.result.schemaVersion = 3;
    value.result.surfaceVerificationIncluded = true;
    value.result.surface = surface;
    assert.throws(() => assertProductionEvidence(value, options));
  }
});

test("a failed surface cannot be repaired by eight successful client probes", () => {
  const value = records();
  value.result.schemaVersion = 3;
  value.result.surfaceVerificationIncluded = true;
  value.result.surface = {
    before: { ownerId, phase: "before", passed: false },
    after: { ownerId, phase: "after", passed: false },
  };
  assert.throws(() => assertProductionEvidence(value, options));
});

function surfaceRecords() {
  const value = records();
  value.result.schemaVersion = 3;
  value.result.surfaceVerificationIncluded = true;
  const binding = {
    path: sandbox + "\\production-ui-surface.mjs",
    sha256: "9".repeat(64),
  };
  value.result.helperFiles = [binding];
  value.supervisor.helperBindings = [
    { ...binding, unchangedThroughCleanup: true },
  ];
  const failedDiscovery = {
    ui: {
      failure: "network failure",
      models: [],
      confirmDisabled: true,
      modelDisabled: true,
      retryEnabled: true,
    },
    native: {
      command: "discover_provider_connection",
      tauriResponse: "error",
      errorCode: "network",
    },
    observedRequests: 1,
  };
  value.result.surface = Object.fromEntries(
    ["before", "after"].map((phase) => [
      phase,
      {
        schemaVersion: 1,
        ownerId,
        phase,
        passed: true,
        complete: false,
        productionNativeIpc: true,
        qaHooksUsed: false,
        applicationInvokeReplaced: false,
        systemStartupMutated: false,
        externalProgramOpened: false,
        clientLaunchedOrRestarted: false,
        nativeStoreUnchanged: true,
        pageRestored: true,
        providerAvailable: phase === "after",
        nativeStateBeforeSha256: "7".repeat(64),
        nativeStateAfterSha256: "7".repeat(64),
        window: {
          initialNativeMaximized: false,
          toggledNativeMaximized: true,
          restoredNativeMaximized: false,
        },
        background: { supported: true, enabled: false, nativeResponse: "ok" },
        observedNativeCommands: [
          "get_overview",
          "agent_hub_overview",
          "get_background_settings",
          "plugin:window|is_maximized",
          "plugin:window|toggle_maximize",
          ...(phase === "after"
            ? [
                "agent_hub_discover",
                "discover_provider_connection",
                "agent_hub_runtime",
              ]
            : []),
        ],
        checks: [...SURFACE_CHECKS.common, ...SURFACE_CHECKS[phase]].map(
          (name) => ({ name, status: "passed" }),
        ),
        failedDiscovery: {
          initial: failedDiscovery,
          retry: structuredClone(failedDiscovery),
        },
        unvalidated: [
          {
            name: "actual Windows logon",
            status: "unvalidated",
            reason: "Synthetic evidence does not execute logon",
          },
        ],
      },
    ]),
  );
  return value;
}

test("bound complete production surface phases retain the eight plus eight pass", () => {
  const summary = assertProductionEvidence(surfaceRecords(), options);
  assert.equal(summary.surfaceChecksPassed, true);
  assert.equal(summary.productionUiEightPassed, true);
});

test("native surface restoration and helper binding are required independently", () => {
  for (const mutate of [
    (value) => {
      value.result.surface.after.pageRestored = false;
    },
    (value) => {
      value.supervisor.helperBindings[0].sha256 = "8".repeat(64);
    },
    (value) => {
      value.result.surface.after.checks.pop();
    },
  ]) {
    const value = surfaceRecords();
    mutate(value);
    assert.throws(() => assertProductionEvidence(value, options));
  }
});

test("zero or partial upstream failures remain failures after evidence validation", () => {
  for (const count of [0, 3]) {
    const summary = assertProductionEvidence(failedRecords(count), options);
    assert.equal(summary.evidenceIntegrityPassed, true);
    assert.equal(summary.productionUiEightPassed, false);
    assert.equal(summary.originalFailurePreserved, true);
    assert.equal(summary.passedCount, count);
  }
});

test("post-exit cleanup binds the original failed receipt and does not repair acceptance", () => {
  const value = failedRecords();
  value.supervisor.cleanup = { removed: false, processesExited: false };
  value.postexitCleanup = {
    ownerId,
    sandbox,
    sourceDigest: value.result.sourceDigest,
    productionSha256,
    originalReportSha256: supervisorSha256,
    originalFailedReportUnchanged: true,
    passed: true,
    processesStopped: 0,
    cleanup: {
      removed: true,
      ownerMarkerVerified: true,
      nativeProcessesExited: true,
      liveRootReferences: 0,
    },
  };
  assert.equal(
    assertProductionEvidence(value, options).productionUiEightPassed,
    false,
  );
  value.postexitCleanup.originalReportSha256 = "f".repeat(64);
  assert.throws(() => assertProductionEvidence(value, options));
});

for (const [name, mutate] of [
  [
    "missing independent retest cannot satisfy eight plus eight acceptance",
    (value) => {
      delete value.result.clients[0].independentRetest;
    },
  ],
  [
    "independent retest must preserve the original configuration revision",
    (value) => {
      value.result.clients[0].independentRetest.configuration
        .configurationRevision++;
    },
  ],
  [
    "independent retest cannot reuse the first verification directory",
    (value) => {
      value.result.clients[0].independentRetest.toolWorkspaceObservation =
        structuredClone(value.result.clients[0].toolWorkspaceObservation);
    },
  ],
  [
    "independent retest false tool proof is rejected",
    (value) => {
      value.result.clients[0].independentRetest.probe.evidence.readObserved = false;
    },
  ],
  [
    "independent retest must have a separately observed native request",
    (value) => {
      value.result.clients[0].independentRetest.receipt.actualNativeRequestObserved = false;
    },
  ],
  [
    "independent retest must bind the observed IPC sequence",
    (value) => {
      value.result.clients[0].independentRetest.receipt = {
        ...value.result.clients[0].independentRetest.receipt,
        sequence: 9000,
      };
    },
  ],
  [
    "independent retest needs fresh physical configuration readback",
    (value) => {
      value.result.clients[0].independentRetest.readback.transactionSettled = false;
    },
  ],
  [
    "independent retest owned directory must be removed",
    (value) => {
      value.result.clients[0].independentRetest.toolWorkspaceObservation.absentAfterProbe = false;
    },
  ],
  [
    "independent retest count cannot inherit first-run success",
    (value) => {
      value.result.independentRetestPassedCount = 7;
      value.supervisor.independentRetestPassedCount = 7;
    },
  ],
  [
    "whole-run timeout cannot become a passing supervisor",
    (value) => {
      value.supervisor.wholeRunTimedOut = true;
    },
  ],
  [
    "missing client cannot become an eight-client pass",
    (value) => {
      value.result.clients.pop();
      value.result.passedCount = 7;
      value.supervisor.passedCount = 7;
    },
  ],
  [
    "foreign IPC host is rejected",
    (value) => {
      value.ipc[0].url = "https://ipc.localhost.evil/save_provider";
    },
  ],
  [
    "model mismatch in an observed click is rejected",
    (value) => {
      value.ipc.find(
        (row) => row.command === "configure_agent",
      ).input.input.model = "other";
    },
  ],
  [
    "missing physical readback is rejected",
    (value) => {
      value.result.clients[0].readback.transactionSettled = false;
    },
  ],
  [
    "missing real model discovery is rejected",
    (value) => {
      delete value.result.clients[0].discovery;
    },
  ],
  [
    "model absent from native discovery is rejected",
    (value) => {
      value.result.clients[0].discovery.receipt.result.models = [
        { id: "other" },
      ];
    },
  ],
  [
    "discovery not bound to observed IPC is rejected",
    (value) => {
      value.result.clients[0].discovery.receipt = {
        ...value.result.clients[0].discovery.receipt,
        sequence: 9000,
      };
    },
  ],
  [
    "false official tool evidence is rejected",
    (value) => {
      value.result.clients[0].probe.evidence.readObserved = false;
    },
  ],
  [
    "retained process still running blocks cleanup",
    (value) => {
      value.supervisor.retainedProcesses[0].exited = false;
    },
  ],
  [
    "source manifest drift is rejected",
    (value) => {
      value.sourceAfter.files[0].sha256 = "f".repeat(64);
    },
  ],
  [
    "helper drift is rejected",
    (value) => {
      value.supervisor.helperBindingsUnchangedThroughCleanup = false;
    },
  ],
  [
    "QA hooks are rejected",
    (value) => {
      value.launch.qaHooksUsed = true;
    },
  ],
  [
    "missing owned WebView proof is rejected",
    (value) => {
      value.launch.cdpListener.retainedDescendantValidated = false;
    },
  ],
])
  test(name, () => {
    const value = records();
    mutate(value);
    assert.throws(() => assertProductionEvidence(value, options));
  });

test("failed independent retest preserves first-run proof without repairing acceptance", () => {
  const value = records();
  const client = value.result.clients[0];
  client.independentRetestPassed = false;
  client.independentRetest.passed = false;
  client.independentRetest.probe.evidence.readObserved = false;
  client.passed = false;
  value.result.passed = false;
  value.result.passedCount = 7;
  value.result.failedCount = 1;
  value.result.independentRetestPassedCount = 7;
  Object.assign(value.supervisor, {
    passed: false,
    uiPassed: false,
    passedCount: 7,
    failedCount: 1,
    independentRetestPassedCount: 7,
    runnerExitCode: 1,
  });
  const summary = assertProductionEvidence(value, options);
  assert.equal(summary.productionUiEightPassed, false);
  assert.equal(summary.firstPassedCount, 8);
  assert.equal(summary.independentRetestPassedCount, 7);
});

test("sandbox absence is checked independently of recorded cleanup success", () => {
  assert.throws(() =>
    assertProductionEvidence(records(), { ...options, sandboxAbsent: false }),
  );
});

test("workspace observer proves a fresh native directory and fails closed on absent or retained proof", async () => {
  const workspace = fileURLToPath(new URL("../../", import.meta.url));
  const root = fs.mkdtempSync(
    path.join(workspace, ".cache", "production-observer-test-"),
  );
  assert.ok(root.startsWith(path.join(workspace, ".cache") + path.sep));
  const observer = observeToolWorkspace(root, "codex");
  try {
    const empty = observeToolWorkspace(root, "hermes");
    assert.throws(() => empty.finish());
    const directory = path.join(
      root,
      "agent-verification/codex/.ae-tool-verification-11111111-1111-4111-8111-111111111111",
    );
    fs.mkdirSync(directory, { recursive: true });
    const deadline = Date.now() + 3000;
    while (!observer.observedDirectories().length && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(observer.observedDirectories().length, 1);
    assert.throws(() => observer.finish());
    fs.rmdirSync(directory);
    const next = observeToolWorkspace(root, "codex");
    fs.mkdirSync(directory);
    const nextDeadline = Date.now() + 3000;
    while (!next.observedDirectories().length && Date.now() < nextDeadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(next.observedDirectories().length, 1);
    fs.rmdirSync(directory);
    const proof = next.finish();
    assert.equal(proof.absentAfterProbe, true);
    assert.equal(proof.markerContentsObserved, false);
  } finally {
    observer.close();
    fs.rmSync(root, { recursive: true });
  }
});

test("privacy validation covers arbitrary text artifact extensions", () => {
  const values = new Set();
  registerPrivateValue(values, "SYNTHETIC-PRIVATE-KEY");
  for (const filename of [
    "acceptance-credentials.txt",
    "note.md",
    "helper.ps1",
    "helper.mjs",
    "unknown.data",
  ]) {
    assert.throws(() =>
      assertArtifactPrivacy(
        filename,
        Buffer.from("SYNTHETIC-PRIVATE-KEY"),
        values,
      ),
    );
    assert.equal(
      assertArtifactPrivacy(
        filename,
        Buffer.from("clean synthetic evidence"),
        values,
      ),
      true,
    );
  }
});

test("unexpected binaries and text disguised as screenshots cannot evade privacy checks", () => {
  assert.throws(() =>
    assertArtifactPrivacy("unknown.bin", Buffer.from([0, 1, 2]), new Set()),
  );
  assert.throws(() =>
    assertArtifactPrivacy(
      "fake.png",
      Buffer.from("SYNTHETIC-PRIVATE-KEY"),
      new Set(),
    ),
  );
  assert.equal(
    assertArtifactPrivacy(
      "masked.png",
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      new Set(),
    ),
    false,
  );
});
