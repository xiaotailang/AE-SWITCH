/** Real native configuration-only preparation; never starts a client or probes inference. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { AGENTS, isNativeRequest } from "./production-ui-eight-contract.mjs";
import { waitExistingTauriPage } from "./wait-existing-tauri-page.mjs";
import {
  assertExistingProfileEquivalent,
  verifyExistingAgentFiles,
} from "./native-existing-readback.mjs";

const workspace = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  assert(
    ["--setup", "--launch", "--model", "--effort"].includes(name),
    "Unsupported configuration-only argument",
  );
  options[name.slice(2)] = process.argv[index + 1];
}
const model = options.model || process.env.AE_PRODUCTION_UI_MODEL;
const effort = options.effort || process.env.AE_PRODUCTION_UI_EFFORT;
assert(
  options.setup && options.launch,
  "Owned --setup and --launch are required",
);
assert(
  typeof model === "string" &&
    model.length > 0 &&
    model.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(model),
  "Explicit current-session model required",
);
assert(
  [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ].includes(effort),
  "Explicit current-session reasoning effort required",
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) =>
  path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
async function guard(file, root = workspace, missing = false) {
  const full = path.resolve(file);
  const base = path.resolve(root);
  assert.match(
    full,
    /^G:[\\/]/i,
    "Configuration-only acceptance must stay on G:",
  );
  assert(
    same(full, base) ||
      full.toLowerCase().startsWith(base.toLowerCase() + path.sep),
    "Input escaped its exact owned root",
  );
  for (let cursor = full; ; cursor = path.dirname(cursor)) {
    try {
      assert.equal(
        (await fs.lstat(cursor)).isSymbolicLink(),
        false,
        "Reparse input rejected",
      );
    } catch (error) {
      if (error.code !== "ENOENT" || !missing) throw error;
    }
    if (path.dirname(cursor) === cursor) break;
  }
  return full;
}
const setupFile = await guard(options.setup);
const setup = JSON.parse(await fs.readFile(setupFile, "utf8"));
assert.match(setup.ownerId, /^[a-f0-9]{32}$/);
const output = path.join(
  workspace,
  "artifacts/acceptance",
  `production-ui-eight-${setup.ownerId}`,
);
await fs.mkdir(output, { recursive: true });
const report = {
  schemaVersion: 1,
  ownerId: setup.ownerId,
  scope:
    "configuration-only real native model discovery, provider save, and eight owned native profile configurations; no official-client inference or tool execution",
  syntheticIpc: false,
  mockInstalled: false,
  nativeIpcExecuted: false,
  inferenceExecuted: false,
  officialClientsExecuted: false,
  probeAgentInvoked: false,
  fullAcceptancePassed: false,
  configuredCount: 0,
  modelIdentitySha256: hash(model),
  reasoningEffort: effort,
  startedAt: new Date().toISOString(),
  checks: [],
  clients: [],
};
let browser;
let page;
let stageLabel = "owner-binding";
let stageAgent = null;
let stageField = null;
const observed = new Map();
const forbidden = new Set([
  "probe_agent",
  "launch_agent",
  "restart_agent",
  "apply_workbuddy_default_model",
]);
const check = (name) => report.checks.push({ name, passed: true });
const invoke = (command, args = {}) =>
  page.evaluate(
    async ({ command, args }) => {
      if (
        window.isTauri !== true ||
        typeof window.__TAURI_INTERNALS__?.invoke !== "function" ||
        window.__coreFeaturesFixture
      )
        throw new Error("Existing production native IPC required");
      return window.__TAURI_INTERNALS__.invoke(command, args);
    },
    { command, args },
  );
try {
  assert.equal(setup.schemaVersion, 2);
  assert(same(setup.workspace, workspace));
  assert(
    same(
      setup.root,
      path.join(workspace, ".cache/native-e2e-sandbox", setup.ownerId),
    ),
  );
  assert(same(setupFile, path.join(setup.root, "setup.json")));
  assert(same(setup.portableRoot, path.join(setup.root, "portable")));
  assert(same(setup.fixtures.payload.portableRoot, setup.portableRoot));
  const marker = JSON.parse(
    await fs.readFile(
      await guard(
        path.join(setup.root, ".ae-production-ui-eight-owner.json"),
        setup.root,
      ),
      "utf8",
    ),
  );
  for (const field of [
    "ownerId",
    "sourceDigest",
    "buildAuditId",
    "productionSha256",
  ])
    assert.equal(marker[field], setup[field], "Owner/build identity mismatch");
  assert(same(marker.workspace, workspace));
  assert.equal(setup.qaHooksUsed, false);
  assert.equal(setup.discoveryContextInjected, false);
  assert.equal(setup.officialClientCodeModified, false);
  const launchFile = await guard(options.launch, setup.root);
  assert(
    same(launchFile, path.join(setup.root, "production-launch-receipt.json")),
  );
  const launch = JSON.parse(await fs.readFile(launchFile, "utf8"));
  assert.equal(launch.ownerId, setup.ownerId);
  assert.equal(launch.retainedHandleValidated, true);
  assert.equal(launch.cdpListener?.retainedDescendantValidated, true);
  assert.equal(launch.qaHooksUsed, false);
  assert.equal(launch.discoveryContextInjected, false);
  assert(same(launch.productionProgram, setup.productionProgram));
  assert.equal(launch.productionSha256, setup.productionSha256);
  assert.equal(
    hash(await fs.readFile(await guard(setup.productionProgram, setup.root))),
    setup.productionSha256,
  );
  for (const binding of setup.buildBindings)
    assert.equal(
      hash(await fs.readFile(await guard(binding.path))),
      binding.sha256,
    );
  report.setupSha256 = hash(await fs.readFile(setupFile));
  report.launchReceiptSha256 = hash(await fs.readFile(launchFile));
  report.sourceDigest = setup.sourceDigest;
  report.productionSha256 = setup.productionSha256;
  const privateCredentialFile = await guard(
    path.join(setup.portableRoot, "acceptance-credentials.txt"),
    setup.root,
  );
  stageLabel = "private-credentials";
  const lines = (await fs.readFile(privateCredentialFile, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim());
  const apiKey = lines
    .map((line) => line.match(/^api-key[:：](.*)$/u)?.[1]?.trim())
    .filter((value) => value !== undefined)
    .at(-1);
  const baseUrl = lines
    .map((line) => line.match(/^(?:端点|endpoint)[:：](.*)$/u)?.[1]?.trim())
    .filter((value) => value !== undefined)
    .at(-1);
  assert(apiKey && baseUrl, "Owned credential input required");
  assert(
    !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseUrl).hostname),
    "Real remote model discovery required",
  );
  const require = createRequire(path.join(workspace, "app/package.json"));
  const { chromium } = require("playwright");
  browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
  stageLabel = "native-identity";
  page = await waitExistingTauriPage(browser);
  page.setDefaultTimeout(30000);
  assert(
    await page.evaluate(
      () =>
        window.isTauri === true &&
        typeof window.__TAURI_INTERNALS__?.invoke === "function" &&
        !window.__coreFeaturesFixture &&
        /^(?:https?:\/\/tauri\.localhost|tauri:\/\/localhost)(?::\d+)?$/.test(
          location.origin,
        ),
    ),
    "Production native WebView required",
  );
  page.on("request", (request) => {
    for (const command of [
      "discover_provider_connection",
      "save_provider",
      "configure_agent",
      ...forbidden,
    ])
      if (isNativeRequest(request, command))
        observed.set(command, (observed.get(command) || 0) + 1);
  });
  const overview = await invoke("get_overview");
  report.nativeIpcExecuted = true;
  assert(same(overview.dataDirectory, path.join(setup.portableRoot, "data")));
  assert.deepEqual(
    overview.providers,
    [],
    "Fresh native provider store required",
  );
  const initial = await invoke("agent_hub_overview");
  assert(
    initial.agents.every((agent) => !agent.configured),
    "Fresh native client selection store required",
  );
  stageLabel = "ordinary-discovery";
  const discovery = await invoke("agent_hub_discover");
  assert.equal(discovery.limited, false);
  const selectedProfiles = {};
  for (const id of AGENTS) {
    stageLabel = "owned-profile-match";
    stageAgent = id;
    stageField = null;
    const expected = setup.fixtures.payload.discoveredProfiles[id];
    const matches = discovery.clients
      .filter((client) => client.agentId === id)
      .flatMap((client) => client.profiles)
      .filter((profile) => {
        try {
          assertExistingProfileEquivalent(profile, expected);
          return true;
        } catch {
          return false;
        }
      });
    assert.equal(
      matches.length,
      1,
      "Exactly one ordinary-discovered owned native profile must match",
    );
    assertExistingProfileEquivalent(matches[0], expected);
    for (const [field, value] of Object.entries(matches[0])) {
      if (field === "profileName" || value == null) continue;
      stageLabel = "owned-profile-path";
      stageField = field;
      if (
        field === "executablePath" &&
        id === "codex" &&
        setup.fixtures.payload.nativeCodexEntry === true
      ) {
        await guard(value);
        assert.equal(
          hash(await fs.readFile(value)),
          setup.fixtures.sharedRuntimeFiles[value],
          "Prepared native executable binding mismatch",
        );
      } else
        await guard(
          value,
          setup.root,
          ![
            "directory",
            "homeDirectory",
            "executablePath",
            "workspaceDirectory",
          ].includes(field),
        );
    }
    selectedProfiles[id] = matches[0];
  }
  stageAgent = null;
  stageField = null;
  check(
    "fresh owner, retained production listener and exact ordinary-discovered eight profiles verified",
  );
  stageLabel = "codex-original-baseline";
  const codexDirectory = selectedProfiles.codex.directory;
  assert(
    !selectedProfiles.codex.configFile ||
      same(
        selectedProfiles.codex.configFile,
        path.join(codexDirectory, "config.toml"),
      ),
    "Owned Codex baseline requires its exact standard native config target",
  );
  const originalFiles = [];
  for (const name of ["config.toml", "auth.json"]) {
    const file = await guard(path.join(codexDirectory, name), setup.root, true);
    let bytes;
    try {
      bytes = await fs.readFile(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    originalFiles.push({
      name,
      existed: bytes !== undefined,
      sha256: bytes === undefined ? null : hash(bytes),
    });
  }
  const originalBaseline = {
    schemaVersion: 1,
    ownerId: setup.ownerId,
    setupSha256: report.setupSha256,
    agentId: "codex",
    directoryIdentitySha256: hash(path.resolve(codexDirectory).toLowerCase()),
    files: originalFiles,
  };
  const baselineFile = path.join(
    setup.root,
    "core-features-codex-original.json",
  );
  await guard(baselineFile, setup.root, true);
  await fs.writeFile(baselineFile, JSON.stringify(originalBaseline, null, 2), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  report.codexOriginalFileBaselineCaptured = true;
  report.codexOriginalFileBaseline = originalFiles;
  stageLabel = "real-model-discovery";
  const connection = await invoke("discover_provider_connection", {
    input: { providerId: null, baseUrl, apiKey },
    protocol: null,
    authMode: null,
  });
  const selectedModel = connection.models.find(
    (entry) => entry.id === model && entry.enabled,
  );
  assert(
    selectedModel,
    "The current-session model must be returned and enabled by real model discovery",
  );
  assert.equal(
    connection.protocol,
    "openai",
    "Explicit reasoning effort requires an OpenAI-compatible endpoint",
  );
  assert(
    !selectedModel.reasoningEfforts?.length ||
      selectedModel.reasoningEfforts.includes(effort),
    "Requested current-session effort is outside the declared model list",
  );
  stageLabel = "save-provider";
  const saved = await invoke("save_provider", {
    input: {
      id: null,
      family: "codex",
      name: "Native configuration acceptance",
      baseUrl: connection.baseUrl || baseUrl,
      apiKey,
      model,
      authMode: connection.authMode || "bearer",
      reasoningEffort: effort,
      codexOptions: {
        upstreamProtocol: connection.protocol,
        protocolDetectedAt: connection.syncedAt,
        models: connection.models,
        modelsSyncedAt: connection.syncedAt,
        fastMode: null,
        contextWindow: null,
        autoCompactTokenLimit: null,
        balanceQuery: null,
      },
    },
  });
  assert.equal(saved.model, model);
  assert.equal(saved.reasoningEffort, effort);
  check(
    "real model discovery and native provider save preserve the explicitly selected model and reasoning effort",
  );
  const nativeRoot = await guard(
    path.join(setup.portableRoot, "data"),
    setup.root,
  );
  const gateway = JSON.parse(
    await fs.readFile(
      await guard(path.join(nativeRoot, "protocol-bridge.json"), setup.root),
      "utf8",
    ),
  );
  for (const id of AGENTS) {
    stageLabel = "configure-owned-client";
    stageAgent = id;
    const result = await invoke("configure_agent", {
      input: {
        agentId: id,
        providerId: saved.id,
        model,
        profile: selectedProfiles[id],
      },
    });
    assert.equal(result.configured, true);
    assert.equal(result.providerId, saved.id);
    assert.equal(result.model, model);
    assert.equal(result.reasoningEffort, effort);
    if (id === "zcode")
      assertExistingProfileEquivalent(
        result.profile,
        setup.fixtures.payload.profiles[id],
      );
    else assertExistingProfileEquivalent(result.profile, selectedProfiles[id]);
    const base = `http://127.0.0.1:${gateway.port}/agents/selected:${id}${id === "claude_code" ? "" : "/v1"}`;
    stageLabel = "independent-native-readback";
    const readback = await verifyExistingAgentFiles({
      workspaceRoot: workspace,
      nativeRoot,
      agent: id,
      providerId: saved.id,
      model,
      gateway: { baseUrl: base, token: gateway.token },
      fixture: {
        ...setup.fixtures.payload,
        profiles: { ...selectedProfiles, [id]: result.profile },
      },
      assertPhysicalWorkspacePath: (file) => guard(file),
    });
    report.clients.push({
      id,
      configured: true,
      modelAndReasoningMatch: true,
      originalProfileMatched: readback.originalProfileMatched,
      nativeAuthenticationReadback: readback.nativeAuthentication,
      modelRoutesReadback: readback.modelRoutesVerified,
      preservedFileCount: readback.preservedFileCount,
      noPrivateWrapper: readback.noPrivateWrapper,
      transactionSettled: readback.transactionSettled,
      clientStarted: false,
      inferenceExecuted: false,
    });
    report.configuredCount++;
  }
  stageAgent = null;
  stageLabel = "configured-overview-and-zero-activity";
  const final = await invoke("agent_hub_overview");
  assert(
    AGENTS.every((id) =>
      final.agents.some(
        (agent) =>
          agent.id === id &&
          agent.configured &&
          agent.providerId === saved.id &&
          agent.model === model &&
          agent.reasoningEffort === effort,
      ),
    ),
  );
  for (const agentId of AGENTS)
    assert.equal(
      (await invoke("agent_hub_activity", { agentId })).records.length,
      0,
      "Configuration-only preparation must not generate inference activity",
    );
  check(
    "eight actual native profile writes independently read back with preserved history; no client started",
  );
  // Direct native configuration does not mutate React's caches. Reload the
  // actual production page and select its saved connection through the UI.
  await page.reload({ waitUntil: "networkidle" });
  stageLabel = "refresh-production-ui";
  const details = page
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: /^已保存连接$/ }) })
    .first();
  if ((await details.getAttribute("open")) === null)
    await details.locator("summary").click();
  await page.locator("#hub-provider").selectOption(saved.id);
  await page
    .locator("#hub-model option")
    .filter({ hasText: model })
    .first()
    .waitFor({ state: "attached" });
  await page.waitForFunction(
    (model) =>
      document.querySelector("#hub-model")?.value === model &&
      !document.querySelector("#hub-model")?.disabled,
    model,
  );
  await details.locator("summary").click();
  assert(
    [...forbidden].every((command) => !observed.get(command)),
    "No inference/client execution IPC may be called by this preparation",
  );
  assert.equal(observed.get("save_provider"), 1);
  assert.equal(observed.get("configure_agent"), 8);
  report.observedMutationCounts = {
    saveProvider: observed.get("save_provider"),
    configureAgent: observed.get("configure_agent"),
    forbiddenExecutionCommands: 0,
  };
  report.realActivityRecordCount = 0;
  stageLabel = "final-ui-and-native-configured-state";
  const finalReady = await invoke("agent_hub_overview");
  report.configuredClientCountBeforeDetach = finalReady.agents.filter(
    (agent) => agent.configured,
  ).length;
  report.reloadedConfiguredCount = report.configuredClientCountBeforeDetach;
  assert.equal(
    report.configuredClientCountBeforeDetach,
    8,
    "All eight native selections must remain configured after production UI reload",
  );
  check(
    "production UI refreshed and selected the saved native connection without confirming or probing",
  );
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = {
    type: error.name || "Error",
    stage: report.checks.length,
    stageLabel,
    agentId: AGENTS.includes(stageAgent) ? stageAgent : null,
    field:
      typeof stageField === "string" && /^[A-Za-z]{1,40}$/.test(stageField)
        ? stageField
        : null,
    code:
      typeof error.code === "string" && /^[A-Z0-9_]{1,40}$/.test(error.code)
        ? error.code
        : null,
    configuredCount: report.configuredCount,
  };
  process.exitCode = 1;
} finally {
  await browser?.close();
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(
    path.join(output, "prepare-core-features-native.json"),
    JSON.stringify(report, null, 2),
  );
  process.stdout.write(
    JSON.stringify({
      passed: report.passed,
      configuredCount: report.configuredCount,
      inferenceExecuted: false,
      officialClientsExecuted: false,
      fullAcceptancePassed: false,
      failure: report.failure || null,
    }) + "\n",
  );
}
