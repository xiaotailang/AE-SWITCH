import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  AGENTS,
  assertConfiguration,
  assertInput,
  assertProbe,
  isNativeRequest,
} from "./production-ui-eight-contract.mjs";
import {
  registerPrivateValue,
  privateFreePlaintext,
} from "./acceptance-private-values.mjs";
import { assertSurfaceReceipt } from "./production-ui-surface.mjs";
import { assertExistingProfileEquivalent } from "./native-existing-readback.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const samePath = (left, right) =>
  path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();

export function preparedWorkspaceInput(workspace, file, { missing = false } = {}) {
  assert.ok(path.isAbsolute(workspace) && path.isAbsolute(file));
  const root = path.resolve(workspace);
  const full = path.resolve(file);
  assert.match(root, /^G:\\/iu);
  assert.ok(
    full.toLowerCase().startsWith(root.toLowerCase() + path.sep),
    "Prepared read-only input escaped this exact workspace",
  );
  for (let cursor = full; ; cursor = path.dirname(cursor)) {
    if (fs.existsSync(cursor)) {
      assert.equal(fs.lstatSync(cursor).isSymbolicLink(), false);
    } else assert.equal(missing, true, "Prepared read-only input is missing");
    if (path.dirname(cursor) === cursor) break;
  }
  return full;
}

export function assertPreparedProfilePaths({ workspace, setup, id, profile, guard }) {
  guard(profile.directory);
  if (id === "codex" && setup.fixtures.payload.nativeCodexEntry === true) {
    preparedWorkspaceInput(workspace, profile.executablePath);
    assert.equal(
      sha(fs.readFileSync(profile.executablePath)),
      setup.fixtures.sharedRuntimeFiles[profile.executablePath],
      "The native Codex profile must select the prepared official executable",
    );
  } else guard(profile.executablePath);
  guard(profile.homeDirectory);
  guard(profile.workspaceDirectory);
}

function invocationProfile(client, setup) {
  const requested = client.uiClickIpc.find(
    (row) => row.command === "configure_agent",
  ).input.input.profile;
  const canonical = client.configuration.profile;
  if (
    client.id === "zcode" &&
    !Object.hasOwn(requested, "stateFile") &&
    Object.hasOwn(canonical, "stateFile")
  ) {
    // Discovery does not read ZCode storage settings. Rust resolves this one
    // field while configuring; the UI and independent probe retain the request.
    const { stateFile, ...unchanged } = canonical;
    assert.deepEqual(unchanged, requested);
    assert.equal(typeof stateFile, "string");
    const fixture = setup.fixtures?.payload;
    assert.deepEqual(requested, fixture?.discoveredProfiles?.zcode);
    assertExistingProfileEquivalent(canonical, fixture?.profiles?.zcode);
    for (const readback of [
      client.readback,
      ...(client.independentRetestPassed
        ? [client.independentRetest.readback]
        : []),
    ]) {
      const state = readback.files?.filter((file) => file.slot === "state");
      assert.equal(state?.length, 1);
      assert.equal(state[0].path, stateFile);
      assert.match(state[0].sha256, /^[a-f0-9]{64}$/u);
    }
  } else assert.deepEqual(requested, canonical);
  return requested;
}

export function assertArtifactPrivacy(filename, bytes, privateValues) {
  if (/\.png$/iu.test(filename)) {
    assert.ok(
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      "Unexpected PNG artifact bytes",
    );
    return false; // Image privacy requires separate visual review.
  }
  assert.equal(
    privateFreePlaintext(bytes, privateValues),
    true,
    "Private or non-text output in " + filename,
  );
  return true;
}

export function assertToolWorkspaceObservation(observation, agentId) {
  assert.match(
    observation?.directoryName ?? "",
    /^\.ae-tool-verification-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u,
  );
  assert.equal(
    observation.relativeDirectory,
    "agent-verification/" + agentId + "/" + observation.directoryName,
  );
  assert.equal(observation.createdDuringInvocation, true);
  assert.equal(observation.absentAfterProbe, true);
  // The nonce comes from the observed Rust directory, not exposed marker contents.
  assert.equal(observation.markerContentsObserved, false);
}

// Observe existing filesystem state only; the native Rust probe creates/removes it.
export function observeToolWorkspace(nativeRoot, agentId) {
  assert.ok(AGENTS.includes(agentId));
  const root = path.resolve(nativeRoot);
  const directory = path.join(root, "agent-verification", agentId);
  const pattern =
    /^\.ae-tool-verification-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
  const observed = new Set();
  let failure;
  function scan() {
    if (!fs.existsSync(directory)) return [];
    assert.equal(fs.lstatSync(directory).isSymbolicLink(), false);
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => {
        if (!pattern.test(entry.name)) return false;
        assert.equal(entry.isSymbolicLink(), false);
        assert.equal(entry.isDirectory(), true);
        return true;
      })
      .map((entry) => entry.name);
  }
  assert.deepEqual(
    scan(),
    [],
    "A probe must start without retained verification directories",
  );
  function inspect() {
    try {
      for (const name of scan()) observed.add(name);
    } catch (error) {
      if (error.code !== "ENOENT") failure = error;
    }
  }
  const watcher = fs.watch(root, { recursive: true }, inspect);
  watcher.on("error", (error) => {
    failure = error;
  });
  return {
    observedDirectories: () => [...observed],
    close: () => watcher.close(),
    finish() {
      inspect();
      watcher.close();
      if (failure) throw failure;
      assert.equal(
        observed.size,
        1,
        "Exactly one fresh Rust verification directory must be observed",
      );
      const [directoryName] = observed;
      const observation = {
        directoryName,
        relativeDirectory:
          "agent-verification/" + agentId + "/" + directoryName,
        createdDuringInvocation: true,
        absentAfterProbe: !fs.existsSync(path.join(directory, directoryName)),
        markerContentsObserved: false,
      };
      assertToolWorkspaceObservation(observation, agentId);
      return observation;
    },
  };
}

// This validates existing receipts; it never starts a product or removes a path.
export function assertProductionEvidence(
  {
    result,
    supervisor,
    setup,
    launch,
    ipc,
    sourceBefore,
    sourceAfter,
    postexitCleanup,
  },
  { sandboxAbsent, supervisorSha256 },
) {
  assert.match(result.ownerId, /^[a-f0-9]{32}$/u);
  for (const record of [supervisor, setup, launch])
    assert.equal(record.ownerId, result.ownerId);
  for (const field of ["productionSha256", "sourceDigest", "buildAuditId"]) {
    assert.match(
      result[field],
      field === "buildAuditId" ? /^[a-f0-9]{32}$/u : /^[a-f0-9]{64}$/u,
    );
    assert.equal(supervisor[field], result[field]);
    assert.equal(setup[field], result[field]);
  }
  assert.equal(launch.productionSha256, result.productionSha256);
  assert.equal(launch.pid, result.productionPid);
  assert.equal(supervisor.productionPid, result.productionPid);
  assert.equal(launch.retainedHandleValidated, true);
  assert.equal(launch.cdpListener?.retainedDescendantValidated, true);
  for (const record of [result, supervisor, setup, launch]) {
    assert.equal(record.qaHooksUsed, false);
    assert.equal(record.discoveryContextInjected, false);
  }
  assert.equal(result.ordinaryDiscoveryUsed, true);
  let surfaceChecksPassed = false;
  if (result.schemaVersion >= 3) {
    assert.equal(result.surfaceVerificationIncluded, true);
    for (const phase of ["before", "after"]) {
      const receipt = result.surface?.[phase];
      if (receipt) {
        assert.equal(receipt.ownerId, result.ownerId);
        assert.equal(receipt.phase, phase);
        if (receipt.passed) assertSurfaceReceipt(receipt);
      }
      if (result.passed)
        assert.equal(
          receipt?.passed,
          true,
          "Both production surface phases must pass",
        );
    }
    if (result.passed) {
      assert.equal(result.surface.before.providerAvailable, false);
      assert.equal(result.surface.after.providerAvailable, true);
    }
    surfaceChecksPassed =
      result.surface?.before?.passed === true &&
      result.surface?.after?.passed === true;
    const moduleBinding = result.helperFiles?.filter((file) =>
      /[\\/]production-ui-surface\.mjs$/u.test(file.path),
    );
    assert.equal(
      moduleBinding?.length,
      1,
      "Production surface module must be hash-bound",
    );
    assert.match(moduleBinding[0].sha256, /^[a-f0-9]{64}$/u);
    const supervisorBinding = supervisor.helperBindings?.filter((file) =>
      samePath(file.path, moduleBinding[0].path),
    );
    assert.equal(supervisorBinding?.length, 1);
    assert.equal(supervisorBinding[0].sha256, moduleBinding[0].sha256);
    assert.equal(supervisorBinding[0].unchangedThroughCleanup, true);
  }
  for (const field of [
    "full218QaSuiteClaimed",
    "officialDesktopLoginOrDefaultClaimed",
    "foreignMachineClaimed",
  ])
    assert.equal(result[field], false);
  for (const field of [
    "sourceBeforeAfterUnchanged",
    "helperInputsUnchanged",
    "sharedOfficialRuntimeBytesUnchanged",
    "dispatchOnlyEntryBytesUnchanged",
    "preservedFilesUnchanged",
  ])
    assert.equal(result[field], true, field);
  for (const field of [
    "helperBindingsUnchangedThroughCleanup",
    "sourceInputsUnchangedThroughCleanup",
    "wrapperBeforeAfterUnchanged",
    "supervisorBeforeAfterUnchanged",
  ])
    assert.equal(supervisor[field], true, field);
  assert.equal(supervisor.identityFailure, false);
  assert.equal(supervisor.unprovedExternalProcessStopped, false);
  assert.equal(supervisor.externalObservation?.processesStopped, 0);
  assert.equal(supervisor.externalObservation?.ownershipClaimed, false);
  assert.deepEqual(sourceAfter.files, sourceBefore.files);
  for (const record of [sourceBefore, sourceAfter]) {
    assert.equal(record.digest, result.sourceDigest);
    assert.equal(record.fileCount, setup.sourceFiles);
    assert.equal(record.files.length, setup.sourceFiles);
    assert.equal(
      sha(
        record.files
          .map((file) => file.path + "\0" + file.sha256 + "\n")
          .join(""),
      ),
      record.digest,
    );
  }
  assert.equal(result.sourceFilesCompared, setup.sourceFiles);
  assert.equal(
    sandboxAbsent,
    true,
    "Owned sandbox still exists; cleanup is unproved",
  );
  if (
    supervisor.cleanup?.removed !== true ||
    supervisor.cleanup?.processesExited !== true
  ) {
    assert.equal(supervisor.passed, false);
    assert.equal(postexitCleanup?.ownerId, result.ownerId);
    assert.ok(samePath(postexitCleanup.sandbox, supervisor.sandbox));
    assert.equal(postexitCleanup.originalReportSha256, supervisorSha256);
    assert.equal(postexitCleanup.sourceDigest, result.sourceDigest);
    assert.equal(postexitCleanup.productionSha256, result.productionSha256);
    assert.equal(postexitCleanup.originalFailedReportUnchanged, true);
    assert.equal(postexitCleanup.passed, true);
    assert.equal(postexitCleanup.processesStopped, 0);
    assert.equal(postexitCleanup.cleanup?.removed, true);
    assert.equal(postexitCleanup.cleanup?.ownerMarkerVerified, true);
    assert.equal(postexitCleanup.cleanup?.nativeProcessesExited, true);
    assert.equal(postexitCleanup.cleanup?.liveRootReferences, 0);
  } else {
    assert.ok(supervisor.retainedProcesses?.length > 0);
    assert.ok(
      supervisor.retainedProcesses.every((process) => process.exited === true),
    );
  }
  assert.ok(
    Array.isArray(result.clients) && result.clients.length <= AGENTS.length,
  );
  const ids = result.clients.map((client) => client.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => AGENTS.includes(id)));
  assert.equal(
    result.passedCount,
    result.clients.filter((client) => client.passed === true).length,
  );
  assert.equal(
    result.failedCount,
    result.clients.filter((client) => client.passed !== true).length,
  );
  assert.equal(supervisor.passedCount, result.passedCount);
  assert.equal(supervisor.failedCount, result.failedCount);
  assert.equal(supervisor.uiPassed, result.passed);
  const firstPassedCount = result.clients.filter(
    (client) => client.firstPassed === true,
  ).length;
  const independentRetestPassedCount = result.clients.filter(
    (client) => client.independentRetestPassed === true,
  ).length;
  if (result.schemaVersion >= 2) {
    assert.equal(result.firstPassedCount, firstPassedCount);
    assert.equal(
      result.independentRetestPassedCount,
      independentRetestPassedCount,
    );
    assert.equal(supervisor.firstPassedCount, firstPassedCount);
    assert.equal(
      supervisor.independentRetestPassedCount,
      independentRetestPassedCount,
    );
    for (const client of result.clients)
      assert.equal(
        client.passed,
        client.firstPassed === true && client.independentRetestPassed === true,
      );
  }
  const sequences = ipc.map((row) => row.sequence);
  assert.equal(
    new Set(sequences).size,
    sequences.length,
    "Duplicate IPC receipt sequence",
  );
  for (const row of ipc.filter((row) =>
    [
      "save_provider",
      "configure_agent",
      "probe_agent",
      "discover_provider_connection",
    ].includes(row.command),
  )) {
    if (row.independentRetest === true) {
      assert.equal(row.command, "probe_agent");
      assert.equal(row.invocationSurface, "native-ipc");
      assert.equal(row.actualUiRequestObserved, false);
      assert.equal(row.actualNativeRequestObserved, true);
    } else assert.equal(row.actualUiRequestObserved, true);
    assert.equal(
      isNativeRequest(
        { url: () => row.url, method: () => row.method },
        row.command,
      ),
      true,
    );
  }
  const passed = result.clients.filter((client) => client.passed);
  assert.ok(new Set(passed.map((client) => client.providerId)).size <= 1);
  assert.ok(new Set(passed.map((client) => client.model)).size <= 1);
  for (const client of result.clients.filter(
    (client) => client.firstPassed === true || client.passed,
  )) {
    assert.equal(client.firstVerificationSurface, "ui-confirmation");
    assert.equal(client.desktopLoginOrDefaultClaimed, false);
    const discovery = client.discovery?.receipt;
    assert.equal(discovery?.command, "discover_provider_connection");
    assert.equal(discovery.tauriResponse, "ok");
    assert.deepEqual(
      ipc.find((row) => row.sequence === discovery.sequence),
      discovery,
    );
    assert.ok(client.discovery.models.length > 0);
    const nativeModels = discovery.result.models.map((model) => model.id);
    assert.ok(
      client.discovery.models.every((model) => nativeModels.includes(model)),
    );
    assert.ok(client.discovery.models.includes(client.model));
    assertProbe(client.probe, client.id, client.model);
    const expected = {
      agentId: client.id,
      providerId: client.providerId,
      model: client.model,
      profile: invocationProfile(client, setup),
    };
    assert.deepEqual(client.uiClickIpc.map((row) => row.command).sort(), [
      "configure_agent",
      "probe_agent",
      "save_provider",
    ]);
    for (const row of client.uiClickIpc) {
      assert.deepEqual(
        ipc.find((item) => item.sequence === row.sequence),
        row,
      );
      assert.equal(row.tauriResponse, "ok");
      if (row.command !== "save_provider")
        assertInput(row.input.input, expected);
    }
    assertConfiguration(
      client.uiClickIpc.find((row) => row.command === "configure_agent").result,
      client.configuration,
      expected,
    );
    assert.deepEqual(
      client.uiClickIpc.find((row) => row.command === "probe_agent").result,
      client.probe,
    );
    assert.equal(client.readback?.agent, client.id);
    for (const field of [
      "nativeAuthentication",
      "modelRoutesVerified",
      "originalProfileMatched",
      "noPrivateWrapper",
      "transactionSettled",
    ])
      assert.equal(client.readback[field], true);
    assertToolWorkspaceObservation(client.toolWorkspaceObservation, client.id);
    if (client.passed || client.independentRetestPassed) {
      assert.equal(client.independentRetestPassed, true);
      const retest = client.independentRetest;
      assert.equal(retest?.passed, true);
      assert.equal(retest.surface, "native-ipc");
      assertConfiguration(client.configuration, retest.configuration, expected);
      const row = retest.receipt;
      assert.equal(row?.command, "probe_agent");
      assert.equal(row.independentRetest, true);
      assert.equal(row.invocationSurface, "native-ipc");
      assert.equal(row.actualUiRequestObserved, false);
      assert.equal(row.actualNativeRequestObserved, true);
      assert.equal(row.tauriResponse, "ok");
      assert.ok(
        row.sequence >
          client.uiClickIpc.find((item) => item.command === "probe_agent")
            .sequence,
      );
      assert.deepEqual(
        ipc.find((item) => item.sequence === row.sequence),
        row,
      );
      assertInput(row.input.input, expected);
      assert.deepEqual(row.result, retest.probe);
      assertProbe(retest.probe, client.id, client.model);
      assert.equal(retest.readback?.agent, client.id);
      for (const field of [
        "nativeAuthentication",
        "modelRoutesVerified",
        "originalProfileMatched",
        "noPrivateWrapper",
        "transactionSettled",
      ])
        assert.equal(retest.readback[field], true);
      assertToolWorkspaceObservation(
        retest.toolWorkspaceObservation,
        client.id,
      );
      assert.notEqual(
        retest.toolWorkspaceObservation.directoryName,
        client.toolWorkspaceObservation.directoryName,
      );
    }
    assert.equal(client.screenshot?.privateInputAndErrorRegionsMasked, true);
  }
  if (result.passed) {
    assert.equal(firstPassedCount, AGENTS.length);
    assert.equal(independentRetestPassedCount, AGENTS.length);
    assert.equal(result.singlePageConnectionFlow, true);
    assert.deepEqual([...ids].sort(), [...AGENTS].sort());
    assert.equal(result.passedCount, AGENTS.length);
    assert.deepEqual(result.pageErrors, []);
  }
  if (supervisor.passed) {
    assert.ok(
      Number.isInteger(supervisor.wholeRunTimeoutSeconds) &&
        supervisor.wholeRunTimeoutSeconds >= 60 &&
        supervisor.wholeRunTimeoutSeconds <= 7200,
    );
    if (setup.fixtures?.payload?.nativeCodexEntry === true) {
      const entry = setup.fixtures.payload.profiles.codex.executablePath;
      const expected = setup.fixtures.sharedRuntimeFiles[entry];
      assert.match(expected, /^[a-f0-9]{64}$/u);
      const observation = supervisor.launcherObservations.find(
        (row) => row.agentId === "codex",
      );
      assert.equal(observation.nativeOfficialEntry, true);
      assert.ok(samePath(observation.launcher, entry));
      assert.ok(observation.pids.length > 0);
      for (const pid of observation.pids) {
        const process = supervisor.retainedProcesses.find(
          (row) => row.pid === pid,
        );
        assert.equal(process.kind, "shared-official-runtime");
        assert.ok(samePath(process.image, entry));
        assert.equal(process.sha256, expected);
        assert.equal(process.exited, true);
        assert.ok(
          supervisor.retainedProcesses.some(
            (parent) => parent.pid === process.parentPid,
          ),
          "The native official Codex parent must be retained in this owner ledger",
        );
      }
    }
    assert.equal(supervisor.wholeRunDeadlineNeverReset, true);
    assert.equal(supervisor.wholeRunTimedOut, false);
    assert.equal(result.passed, true);
    assert.equal(supervisor.runnerExitCode, 0);
    assert.equal(supervisor.allEightLauncherObserved, true);
    assert.deepEqual(
      supervisor.launcherObservations.map((row) => row.agentId).sort(),
      [...AGENTS].sort(),
    );
    assert.ok(
      supervisor.launcherObservations.every(
        (row) => row.retainedProcessObserved === true,
      ),
    );
    assert.equal(supervisor.cleanup.removed, true);
    assert.equal(supervisor.cleanup.processesExited, true);
  }
  return {
    evidenceIntegrityPassed: true,
    productionUiEightPassed: supervisor.passed === true,
    passedCount: result.passedCount,
    failedCount: result.failedCount,
    firstPassedCount,
    independentRetestPassedCount,
    independentRetestSurface: "native-ipc",
    independentRetestUiClickClaimed: false,
    surfaceVerificationIncluded: result.schemaVersion >= 3,
    surfaceChecksPassed,
    originalFailurePreserved: supervisor.passed !== true,
    independentSandboxAbsenceConfirmed: true,
    officialDesktopLoginOrDefaultClaimed: false,
    screenshotVisualReviewPerformed: false,
  };
}

export function verifyProductionEvidence(ownerId, credentialsFile) {
  assert.match(ownerId, /^[a-f0-9]{32}$/u);
  const workspace = fileURLToPath(new URL("../../", import.meta.url));
  assert.match(workspace, /^G:\\/iu);
  const root = path.join(
    workspace,
    "artifacts/acceptance",
    "production-ui-eight-" + ownerId,
  );
  function guard(file) {
    const full = path.resolve(file);
    assert.ok(
      full
        .toLowerCase()
        .startsWith(path.resolve(workspace).toLowerCase() + path.sep),
    );
    for (let ancestor = full; ; ancestor = path.dirname(ancestor)) {
      if (fs.existsSync(ancestor))
        assert.equal(
          fs.lstatSync(ancestor).isSymbolicLink(),
          false,
          "Reparse ancestor rejected",
        );
      if (path.dirname(ancestor) === ancestor) break;
    }
    return full;
  }
  const output = guard(path.join(root, "evidence-validation.json"));
  assert.equal(
    fs.existsSync(output),
    false,
    "Evidence validation output must be fresh",
  );
  const privateValues = new Set();
  const lines = fs
    .readFileSync(
      guard(credentialsFile || path.join(workspace, "端点测试用.txt")),
      "utf8",
    )
    .split(/\r?\n/u)
    .map((line) => line.trim());
  const value = (pattern) =>
    lines
      .map((line) => line.match(pattern)?.[1]?.trim())
      .filter(Boolean)
      .at(-1);
  registerPrivateValue(privateValues, value(/^api-key[:：](.*)$/u));
  registerPrivateValue(privateValues, value(/^端点[:：](.*)$/u), true);
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(guard(directory), {
      withFileTypes: true,
    })) {
      const file = guard(path.join(directory, entry.name));
      if (entry.isDirectory()) visit(file);
      else {
        const bytes = fs.readFileSync(file);
        const textArtifact = assertArtifactPrivacy(
          path.relative(root, file),
          bytes,
          privateValues,
        );
        files.push({
          path: path.relative(root, file).replaceAll("\\", "/"),
          sha256: sha(bytes),
          textArtifact,
        });
      }
    }
  }
  visit(root);
  const read = (name) =>
    JSON.parse(fs.readFileSync(guard(path.join(root, name)), "utf8"));
  const records = {
    result: read("production-ui-results.json"),
    supervisor: read("supervisor-receipt.json"),
    setup: read("setup.json"),
    launch: read("production-launch-receipt.json"),
    ipc: read("ui-ipc.json"),
    sourceBefore: read("source-before.json"),
    sourceAfter: read("source-after.json"),
  };
  for (const binding of records.result.sharedOfficialRuntimes ?? [])
    assert.equal(
      sha(fs.readFileSync(preparedWorkspaceInput(workspace, binding.path))),
      binding.sha256,
      "Shared official runtime changed after the production run",
    );
  for (const binding of records.setup.fixtures?.payload?.preservedFiles ?? []) {
    const file = preparedWorkspaceInput(workspace, binding.path, {
      missing: true,
    });
    if (
      !file.toLowerCase().startsWith(
        path.resolve(records.setup.root).toLowerCase() + path.sep,
      )
    )
      assert.equal(
        sha(fs.readFileSync(preparedWorkspaceInput(workspace, file))),
        binding.sha256,
        "Preserved external fixture input changed after the production run",
      );
  }
  assert.equal(
    sha(fs.readFileSync(guard(path.join(root, "setup.json")))),
    records.result.setupSha256,
  );
  assert.equal(
    sha(
      fs.readFileSync(guard(path.join(root, "production-launch-receipt.json"))),
    ),
    records.result.launchReceiptSha256,
  );
  assert.ok(
    samePath(
      records.supervisor.sandbox,
      path.join(workspace, ".cache/native-e2e-sandbox", ownerId),
    ),
  );
  if (fs.existsSync(guard(path.join(root, "postexit-cleanup.json"))))
    records.postexitCleanup = read("postexit-cleanup.json");
  for (const client of records.result.clients)
    if (client.screenshot) {
      const screenshot = guard(client.screenshot.path);
      assert.ok(
        screenshot
          .toLowerCase()
          .startsWith(path.resolve(root).toLowerCase() + path.sep),
        "Screenshot escaped the run evidence directory",
      );
      assert.equal(sha(fs.readFileSync(screenshot)), client.screenshot.sha256);
    }
  const summary = assertProductionEvidence(records, {
    sandboxAbsent: !fs.existsSync(guard(records.supervisor.sandbox)),
    supervisorSha256: sha(
      fs.readFileSync(guard(path.join(root, "supervisor-receipt.json"))),
    ),
  });
  const report = {
    schemaVersion: 1,
    ownerId,
    recordedAt: new Date().toISOString(),
    ...summary,
    textArtifactsCredentialAndEndpointFree: true,
    textArtifactCount: files.filter((file) => file.textArtifact).length,
    files,
  };
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", {
    flag: "wx",
  });
  return { ...summary, ownerId, receipt: output };
}

if (
  process.argv[1] &&
  samePath(process.argv[1], fileURLToPath(import.meta.url))
) {
  console.log(
    JSON.stringify(verifyProductionEvidence(process.argv[2], process.argv[3])),
  );
}
