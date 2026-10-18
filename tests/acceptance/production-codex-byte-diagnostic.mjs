import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { verifyExistingAgentFiles } from "./native-existing-readback.mjs";
import {
  isNativeRequest,
  assertInput,
  assertProbe,
  assertConfiguration,
} from "./production-ui-eight-contract.mjs";
import { registerPrivateValue } from "./acceptance-private-values.mjs";
import { waitExistingTauriPage } from "./wait-existing-tauri-page.mjs";
import { verifyProductionSurface } from "./production-ui-surface.mjs";
import { observeToolWorkspace as observeDirectoryOnly } from "./verify-production-ui-eight-evidence.mjs";

const AGENTS = ["codex"];
function observeToolWorkspace(nativeRoot, agentId) {
  assert.equal(agentId, "codex");
  const directoryOnly = observeDirectoryOnly(nativeRoot, agentId);
  const observations = new Map();
  let observerFailure;
  const directory = path.join(nativeRoot, "agent-verification", agentId);
  function inspect() {
    if (!fs.existsSync(directory)) return;
    try {
      guard(directory);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const match = entry.name.match(
          /^\.ae-tool-verification-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/,
        );
        if (!match) continue;
        assert.ok(entry.isDirectory() && !entry.isSymbolicLink());
        const target = guard(
          path.join(directory, entry.name, entry.name + ".txt"),
          setup.root,
          true,
        );
        if (!fs.existsSync(target)) continue;
        const stat = fs.lstatSync(target);
        assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size < 4096);
        const marker = Buffer.from(
          "AE_TOOL_VERIFIED_" + match[1].replaceAll("-", ""),
        );
        const contents = fs.readFileSync(target);
        const sample = {
          nonce: match[1],
          recordedAt: new Date().toISOString(),
          fileBytes: contents.length,
          expectedMarkerBytes: marker.length,
          fileSha256: sha(contents),
          exactMarker: contents.equals(marker),
          exactMarkerSingleLf: contents.equals(
            Buffer.concat([marker, Buffer.from("\n")]),
          ),
          exactMarkerCrLf: contents.equals(
            Buffer.concat([marker, Buffer.from("\r\n")]),
          ),
          regularFile: true,
          pathWithinOwnedRoot: true,
          observerWroteFile: false,
        };
        observations.set(sample.nonce + sample.fileSha256, sample);
      }
    } catch (error) {
      if (error.code !== "ENOENT") observerFailure = error;
    }
  }
  const watcher = fs.watch(nativeRoot, { recursive: true }, inspect);
  const timer = setInterval(inspect, 20);
  return {
    close() {
      clearInterval(timer);
      watcher.close();
      directoryOnly.close();
    },
    finish() {
      inspect();
      clearInterval(timer);
      watcher.close();
      const observation = directoryOnly.finish();
      if (observerFailure) throw observerFailure;
      return {
        ...observation,
        markerContentsObserved: observations.size > 0,
        byteObservations: [...observations.values()],
        scope:
          "Diagnostic read-only byte observation; not eight-client acceptance",
      };
    },
  };
}
const setupFile = path.resolve(process.argv[2]);
const launchFile = path.resolve(process.argv[3]);
const setup = JSON.parse(fs.readFileSync(setupFile, "utf8"));
const launch = JSON.parse(fs.readFileSync(launchFile, "utf8"));
const workspace = path.resolve(setup.workspace);
const output = path.join(
  workspace,
  "artifacts/acceptance",
  "production-codex-byte-diagnostic-" + setup.ownerId,
);
const secrets = new Set();
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) =>
  path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
function safe(value) {
  if (typeof value === "string") {
    for (const key of secrets)
      value = value.split(key).join("<credential redacted>");
    return value;
  }
  if (Array.isArray(value)) return value.map(safe);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, safe(item)]),
    );
  return value;
}
function guard(file, root = setup.root, missing = false) {
  const full = path.resolve(file);
  assert.match(full, /^G:\\/i);
  assert.ok(
    same(full, root) ||
      full
        .toLowerCase()
        .startsWith(path.resolve(root).toLowerCase() + path.sep),
    "Path escaped approved root",
  );
  for (let ancestor = full; ; ancestor = path.dirname(ancestor)) {
    if (fs.existsSync(ancestor))
      assert.equal(
        fs.lstatSync(ancestor).isSymbolicLink(),
        false,
        "Reparse ancestor rejected",
      );
    else assert.ok(missing, "Required owned path absent");
    if (path.dirname(ancestor) === ancestor) break;
  }
  return full;
}
function write(name, value) {
  const destination = guard(path.join(output, name), output, true);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify(safe(value), null, 2) + "\n");
}
function progress(event) {
  console.log(JSON.stringify(safe({ at: new Date().toISOString(), ...event })));
}
assert.match(setup.ownerId, /^[a-f0-9]{32}$/);
assert.ok(
  same(
    setup.root,
    path.join(workspace, ".cache/native-e2e-sandbox", setup.ownerId),
  ),
);
guard(setupFile);
guard(launchFile);
guard(setup.productionProgram);
const owner = JSON.parse(
  fs.readFileSync(
    guard(path.join(setup.root, ".ae-production-ui-eight-owner.json")),
    "utf8",
  ),
);
assert.equal(owner.ownerId, setup.ownerId);
assert.equal(launch.ownerId, setup.ownerId);
assert.equal(launch.retainedHandleValidated, true);
assert.equal(launch.cdpListener?.retainedDescendantValidated, true);
assert.equal(launch.qaHooksUsed, false);
assert.equal(launch.discoveryContextInjected, false);
assert.equal(launch.productionSha256, setup.productionSha256);
assert.ok(same(launch.productionProgram, setup.productionProgram));
assert.ok(
  same(
    launch.ordinaryDiscoveryCwd,
    path.join(setup.root, "installed-clients/workspace"),
  ),
);
assert.equal(setup.schemaVersion, 2);
assert.match(setup.buildAuditId, /^[a-f0-9]{32}$/);
assert.match(setup.sourceDigest, /^[a-f0-9]{64}$/);
assert.match(setup.productionSha256, /^[a-f0-9]{64}$/);
assert.ok(Number.isSafeInteger(setup.sourceFiles) && setup.sourceFiles > 0);
for (const binding of setup.buildBindings)
  assert.equal(
    sha(fs.readFileSync(guard(binding.path, workspace))),
    binding.sha256,
  );
assert.equal(
  sha(fs.readFileSync(setup.productionProgram)),
  setup.productionSha256,
);
assert.equal(
  Object.keys(process.env).some((name) =>
    /^UNI_SWITCH_QA_|^AE_NATIVE_/i.test(name),
  ),
  false,
);
const credentials = fs.readFileSync(
  guard(path.join(setup.portableRoot, "acceptance-credentials.txt")),
  "utf8",
);
const credentialLines = credentials.split(/\r?\n/).map((line) => line.trim());
const key = credentialLines
  .map((line) => line.match(/^api-key[:：](.*)$/u)?.[1]?.trim())
  .filter((value) => value !== undefined)
  .at(-1);
const endpoint = credentialLines
  .map((line) => line.match(/^端点[:：](.*)$/u)?.[1]?.trim())
  .filter((value) => value !== undefined)
  .at(-1);
assert.ok(key && endpoint);
registerPrivateValue(secrets, key);
registerPrivateValue(secrets, endpoint, true);
assert.ok(
  !["localhost", "127.0.0.1", "[::1]"].includes(new URL(endpoint).hostname),
  "Real supplier endpoint required",
);
assert.ok(
  same(
    setup.sourceManifest,
    path.join(setup.auditDirectory, "build-source-after.json"),
  ),
);
const sourceBaseline = JSON.parse(
  fs.readFileSync(guard(setup.sourceManifest, workspace), "utf8"),
);
assert.equal(sourceBaseline.digest, setup.sourceDigest);
function sourceSnapshot() {
  const files = sourceBaseline.files.map((file) => ({
    path: file.path,
    sha256: sha(
      fs.readFileSync(guard(path.join(workspace, file.path), workspace)),
    ),
  }));
  return {
    recordedAt: new Date().toISOString(),
    fileCount: files.length,
    files,
    digest: sha(
      files.map((file) => file.path + "\0" + file.sha256 + "\n").join(""),
    ),
  };
}
const sourceBefore = sourceSnapshot();
assert.equal(sourceBefore.fileCount, setup.sourceFiles);
assert.equal(sourceBefore.digest, setup.sourceDigest);
const helperFiles = [
  fileURLToPath(import.meta.url),
  fileURLToPath(new URL("./production-ui-eight-contract.mjs", import.meta.url)),
  fileURLToPath(new URL("./acceptance-private-values.mjs", import.meta.url)),
  fileURLToPath(new URL("./wait-existing-tauri-page.mjs", import.meta.url)),
  fileURLToPath(new URL("./production-ui-surface.mjs", import.meta.url)),
  fileURLToPath(
    new URL("./verify-production-codex-byte-diagnostic.ps1", import.meta.url),
  ),
  fileURLToPath(new URL("./prepare-production-ui-eight.ps1", import.meta.url)),
  fileURLToPath(
    new URL("./verify-production-ui-eight-evidence.mjs", import.meta.url),
  ),
  path.join(workspace, "tests/acceptance/native-existing-readback.mjs"),
  path.join(workspace, "scripts/verify-portable-e2e.ps1"),
].map((file) => ({ path: file, sha256: sha(fs.readFileSync(file)) }));
const sharedBefore = Object.entries(setup.fixtures.sharedRuntimeFiles).map(
  ([file, hash]) => {
    assert.equal(sha(fs.readFileSync(file)), hash);
    return { path: file, sha256: hash };
  },
);
const entriesBefore = AGENTS.map((id) => ({
  id,
  path: setup.fixtures.payload.profiles[id].executablePath,
  sha256: sha(
    fs.readFileSync(guard(setup.fixtures.payload.profiles[id].executablePath)),
  ),
}));
const report = {
  schemaVersion: 3,
  ownerId: setup.ownerId,
  startedAt: new Date().toISOString(),
  scope:
    "Single Codex production UI diagnostic with read-only nonce file byte observation; eight-client acceptance not claimed",
  productionSha256: setup.productionSha256,
  productionPid: launch.pid,
  productionStartedAt: launch.startedAt,
  buildAuditId: setup.buildAuditId,
  sourceDigest: setup.sourceDigest,
  setupSha256: sha(fs.readFileSync(setupFile)),
  launchReceiptSha256: sha(fs.readFileSync(launchFile)),
  qaHooksUsed: false,
  discoveryContextInjected: false,
  ordinaryDiscoveryUsed: true,
  full218QaSuiteClaimed: false,
  officialDesktopLoginOrDefaultClaimed: false,
  foreignMachineClaimed: false,
  clients: [],
  pageErrors: [],
  passed: false,
  firstPassedCount: 0,
  independentRetestPassedCount: 0,
  surfaceVerificationIncluded: true,
  surface: {},
};
write("source-before.json", sourceBefore);
write("production-ui-results.json", report);
const require = createRequire(path.join(workspace, "app/package.json"));
const { chromium } = require("playwright");
let browser, page;
const journal = [];
const pending = new Set();
let sequence = 0;
async function readonlyNative(command) {
  assert.ok(
    ["get_overview", "agent_hub_overview", "agent_hub_discover"].includes(
      command,
    ),
    "Independent driver only permits read-only direct IPC",
  );
  const response = await page.evaluate(async (command) => {
    if (typeof window.__TAURI_INTERNALS__?.invoke !== "function")
      throw Error("Real Tauri IPC absent");
    try {
      return {
        ok: true,
        result: await window.__TAURI_INTERNALS__.invoke(command),
      };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }, command);
  assert.equal(response.ok, true, safe(command + ": " + response.error));
  return response.result;
}
function armClick(commands, expected, independentRetest = false) {
  const startedAt = new Date().toISOString();
  const requests = new Map(commands.map((command) => [command, []]));
  const onRequest = (request) => {
    for (const command of commands)
      if (isNativeRequest(request, command))
        requests.get(command).push(request);
  };
  page.on("request", onRequest);
  const promises = commands.map(async (command) => {
    const response = await page.waitForResponse(
      (response) =>
        isNativeRequest(response.request(), command) &&
        requests.get(command).includes(response.request()),
      { timeout: 210000 },
    );
    const request = response.request();
    const input = request.postDataJSON();
    const status = await response.headerValue("Tauri-Response");
    const result = await response.json();
    const receipt = {
      sequence: ++sequence,
      command,
      startedAt,
      finishedAt: new Date().toISOString(),
      actualUiRequestObserved: !independentRetest,
      actualNativeRequestObserved: true,
      ...(independentRetest
        ? {
            independentRetest: true,
            invocationSurface: "native-ipc",
          }
        : {}),
      method: request.method(),
      url: request.url(),
      tauriResponse: status,
      input,
      result,
    };
    journal.push(receipt);
    write("ui-ipc.json", journal);
    assert.equal(
      requests.get(command).length,
      1,
      "One click must emit exactly one " + command + " request",
    );
    assert.equal(
      status,
      "ok",
      safe(command + " rejected: " + JSON.stringify(result)),
    );
    if (expected && ["configure_agent", "probe_agent"].includes(command))
      assertInput(input.input, expected);
    return receipt;
  });
  const result = Promise.all(promises).finally(() =>
    page.off("request", onRequest),
  );
  result.catch(() => {});
  return result;
}
async function clickNative(button, commands, expected) {
  const promise = armClick(commands, expected);
  await button.click();
  return promise;
}
async function independentNativeProbe(input) {
  // Explicit acceptance-only invocation; it does not stand in for a UI click.
  const observed = armClick(["probe_agent"], input, true);
  await page.evaluate(async (input) => {
    await window.__TAURI_INTERNALS__.invoke("probe_agent", { input });
  }, input);
  const [receipt] = await observed;
  return receipt;
}
async function modelState() {
  await page.waitForFunction(
    () => {
      const model = document.getElementById("hub-model");
      const status = document.querySelector(".hub-model-status");
      return (
        !status?.textContent.includes("正在识别协议并获取模型列表") &&
        (!!document.querySelector(".hub-model-status.failure") ||
          (model &&
            !model.disabled &&
            [...model.options].some((option) => option.value)))
      );
    },
    null,
    { timeout: 60000 },
  );
  const state = await page.evaluate(() => ({
    failure:
      document.querySelector(".hub-model-status.failure")?.textContent.trim() ??
      "",
    models: [...(document.getElementById("hub-model")?.options ?? [])]
      .map((option) => option.value)
      .filter(Boolean),
  }));
  return state;
}
async function freshUiDiscovery() {
  await modelState();
  const sync = page.getByRole("button", { name: "同步模型", exact: true });
  assert.equal(await sync.isEnabled(), true);
  const [observed] = await clickNative(sync, ["discover_provider_connection"]);
  const state = await modelState();
  assert.equal(state.failure, "", "Real supplier UI discovery failed");
  assert.ok(state.models.length > 0);
  const nativeModels = observed.result.models.map((model) => model.id);
  assert.ok(
    state.models.every((model) => nativeModels.includes(model)),
    "UI model options must originate in observed Rust discovery",
  );
  return { models: state.models, receipt: observed };
}
async function screenshot(name) {
  const destination = guard(path.join(output, name), output, true);
  const privateSelectors = [
    "#hub-api-key",
    "#hub-endpoint",
    "#hub-provider",
    ".hub-notice",
    ".hub-model-status",
    ".hub-verification-message",
  ];
  await page.screenshot({
    path: destination,
    fullPage: true,
    mask: privateSelectors.map((selector) => page.locator(selector)),
  });
  return {
    path: destination,
    sha256: sha(fs.readFileSync(destination)),
    privateInputAndErrorRegionsMasked: true,
    privateSelectors,
  };
}
async function text(selector) {
  return (await page.locator(selector).count())
    ? (await page.locator(selector).innerText()).trim()
    : "";
}
try {
  browser = await chromium.connectOverCDP("http://127.0.0.1:9223", {
    timeout: 10000,
  });
  page = await waitExistingTauriPage(browser);
  page.on("pageerror", (error) => report.pageErrors.push(safe(error.message)));
  page.on("response", (response) => {
    if (!isNativeRequest(response.request(), "agent_hub_discover")) return;
    const task = (async () => {
      const result = await response.json();
      const status = await response.headerValue("Tauri-Response");
      journal.push({
        sequence: ++sequence,
        command: "agent_hub_discover",
        tauriResponse: status,
        result,
        readonly: true,
      });
    })();
    pending.add(task);
    task.finally(() => pending.delete(task)).catch(() => {});
  });
  const overview = await readonlyNative("get_overview");
  assert.ok(
    same(overview.dataDirectory, path.join(setup.portableRoot, "data")),
  );
  assert.deepEqual(
    overview.providers,
    [],
    "Fresh production native provider store required",
  );
  const nativeRoot = guard(path.join(setup.portableRoot, "data"));
  const discovered = await readonlyNative("agent_hub_discover");
  assert.equal(
    discovered.limited,
    false,
    "Ordinary discovery must remain within bounds",
  );
  report.discovery = discovered;
  const profiles = {};
  for (const id of AGENTS) {
    const clients = discovered.clients.filter(
      (client) => client.agentId === id,
    );
    assert.equal(
      clients.length,
      1,
      id + ": exact ordinary-discovered official installation required",
    );
    assert.equal(
      clients[0].profiles.length,
      1,
      id + ": unique ordinary-discovered existing profile required",
    );
    const profile = clients[0].profiles[0];
    guard(profile.directory);
    guard(profile.executablePath);
    guard(profile.homeDirectory);
    guard(profile.workspaceDirectory);
    assert.deepEqual(
      profile,
      setup.fixtures.payload.discoveredProfiles[id],
      id + ": ordinary discovery must match actual installed profile",
    );
    assert.ok(same(clients[0].executablePath, profile.executablePath));
    profiles[id] = profile;
  }
  const hub = await readonlyNative("agent_hub_overview");
  assert.equal(hub.bridgeHealthy, true);
  const gateway = JSON.parse(
    fs.readFileSync(
      guard(path.join(nativeRoot, "protocol-bridge.json")),
      "utf8",
    ),
  );
  secrets.add(gateway.token);
  await page
    .getByRole("navigation", { name: "选择 Agent", exact: true })
    .waitFor();
  assert.equal(
    await page.locator("#hub-api-key").getAttribute("type"),
    "password",
  );
  assert.equal(
    await page.locator("#hub-provider").inputValue(),
    "",
    "Fresh connection is selected without opening saved connections",
  );
  let provider = null;
  let model = null;
  const navigation = page.getByRole("navigation", {
    name: "选择 Agent",
    exact: true,
  });
  async function verifySurface(phase, savedProvider = null) {
    progress({ event: "production-surface-started", phase });
    try {
      report.surface[phase] = await verifyProductionSurface({
        page,
        setup,
        readonlyNative,
        phase,
        provider: savedProvider,
      });
    } catch (error) {
      report.surface[phase] = error.surfaceReceipt ?? {
        ownerId: setup.ownerId,
        phase,
        passed: false,
        failure: "Surface failed before a complete receipt was available",
      };
      if (
        !report.surface[phase].pageRestored ||
        !report.surface[phase].nativeStoreUnchanged
      ) {
        write("surface-" + phase + ".json", report.surface[phase]);
        throw error;
      }
    }
    write("surface-" + phase + ".json", report.surface[phase]);
    write("production-ui-results.json", report);
    progress({
      event: "production-surface-finished",
      phase,
      passed: report.surface[phase].passed,
    });
  }
  await verifySurface("before");
  for (const id of AGENTS) {
    const outcome = {
      id,
      providerId: provider?.id ?? null,
      model,
      passed: false,
      firstPassed: false,
      independentRetestPassed: false,
      firstVerificationSurface: "ui-confirmation",
      desktopLoginOrDefaultClaimed: false,
    };
    report.clients.push(outcome);
    const started = Date.now();
    try {
      const definition = hub.agents.find((agent) => agent.id === id);
      assert.ok(definition);
      await navigation
        .getByRole("button")
        .filter({
          has: page.getByRole("img", {
            name: definition.name + " 官方图标",
            exact: true,
          }),
        })
        .click();
      await page
        .getByRole("heading", { name: definition.name, exact: true })
        .waitFor();
      await page.waitForFunction(
        () => {
          const field = document.getElementById("hub-installed-profile");
          return field && !field.disabled && !!field.value;
        },
        null,
        { timeout: 30000 },
      );
      assert.deepEqual(
        JSON.parse(await page.locator("#hub-installed-profile").inputValue()),
        profiles[id],
      );
      assert.equal(
        await page.locator(".hub-profile-settings").getAttribute("open"),
        null,
        "A unique ready profile must remain collapsed and auto-selected",
      );
      assert.equal(
        await page.getByRole("button", { name: "仅保存", exact: true }).count(),
        0,
        "Ready clients use a single confirmation action",
      );
      if (!provider) {
        await page.locator("#hub-endpoint").fill(endpoint);
        await page.locator("#hub-api-key").fill(key);
      }
      outcome.discovery = await freshUiDiscovery();
      model ??=
        process.env.AE_PRODUCTION_UI_MODEL ??
        (outcome.discovery.models.includes("claude-opus-4-6")
          ? "claude-opus-4-6"
          : outcome.discovery.models[0]);
      assert.ok(
        outcome.discovery.models.includes(model),
        "Selected model must appear in the real supplier UI response",
      );
      await page.locator("#hub-model").selectOption(model);
      assert.equal(
        await page.locator(".hub-probe-status.passed").count(),
        0,
        "No prior tool success may appear for current selection",
      );
      progress({ event: "production-tool-ui-confirm-started", id, model });
      const firstWorkspace = observeToolWorkspace(guard(nativeRoot), id);
      let receipts;
      try {
        receipts = await clickNative(
          page.getByRole("button", { name: "确认连接", exact: true }),
          ["save_provider", "configure_agent", "probe_agent"],
        );
        outcome.toolWorkspaceObservation = firstWorkspace.finish();
      } finally {
        firstWorkspace.close();
      }
      const savedIpc = receipts.find(
        (item) => item.command === "save_provider",
      );
      const saved = await readonlyNative("get_overview");
      assert.equal(saved.providers.length, 1);
      const currentProvider = saved.providers[0];
      assert.equal(currentProvider.id, savedIpc.result.id);
      assert.equal(currentProvider.model, model);
      assert.equal(currentProvider.hasKey, true);
      if (provider)
        assert.equal(
          currentProvider.id,
          provider.id,
          "The diagnostic must reuse its UI-confirmed connection",
        );
      provider = currentProvider;
      assert.ok(provider.codexOptions.modelsSyncedAt);
      assert.ok(
        provider.codexOptions.models.some(
          (value) => value.id === model && value.enabled,
        ),
      );
      assert.ok(!JSON.stringify(provider).includes(key));
      const expected = {
        agentId: id,
        providerId: provider.id,
        model,
        profile: profiles[id],
      };
      for (const receipt of receipts.filter((item) =>
        ["configure_agent", "probe_agent"].includes(item.command),
      ))
        assertInput(receipt.input.input, expected);
      outcome.providerId = provider.id;
      outcome.model = model;
      report.provider = {
        id: provider.id,
        model,
        uiSaveObserved: true,
        savedByConfirmConnection: true,
        inputCleared: (await page.locator("#hub-api-key").inputValue()) === "",
        publicSummaryCredentialFree: true,
      };
      const configured = receipts.find(
        (item) => item.command === "configure_agent",
      ).result;
      outcome.probe = receipts.find(
        (item) => item.command === "probe_agent",
      ).result;
      outcome.uiClickIpc = receipts;
      await page.waitForFunction(
        () => {
          const primary = document.querySelector(".hub-form-actions .primary");
          const select = document.getElementById("hub-provider");
          return (
            select &&
            !select.disabled &&
            primary?.textContent.includes("确认连接") &&
            !!document.querySelector(
              ".hub-verification-result,.hub-notice.error",
            )
          );
        },
        null,
        { timeout: 210000 },
      );
      outcome.ui = {
        status: await text(".hub-probe-status"),
        stage: await text(".hub-verification-stage"),
        message: await text(".hub-verification-message"),
        notice: await text(".hub-notice"),
        cleanup: await text(".hub-verification-cleanup"),
      };
      assertProbe(outcome.probe, id, model);
      assert.match(outcome.ui.status, /工具写读验证通过/u);
      assert.match(outcome.ui.cleanup, /验证临时文件已清理/u);
      assert.equal(await page.locator(".hub-probe-status.passed").count(), 1);
      assert.equal(await page.locator("#hub-api-key").inputValue(), "");
      const current = (await readonlyNative("agent_hub_overview")).agents.find(
        (agent) => agent.id === id,
      );
      assertConfiguration(configured, current, expected);
      outcome.configuration = current;
      const selections = JSON.parse(
        fs.readFileSync(
          guard(path.join(nativeRoot, "agent-selection.json")),
          "utf8",
        ),
      );
      const actualProfile = selections[id].profile;
      assert.deepEqual(actualProfile, current.profile);
      const route =
        "http://127.0.0.1:" + gateway.port + "/agents/selected:" + id;
      const readbackOptions = {
        workspaceRoot: workspace,
        nativeRoot,
        agent: id,
        providerId: provider.id,
        model,
        gateway: {
          baseUrl: id === "claude_code" ? route : route + "/v1",
          token: gateway.token,
        },
        fixture: {
          ...setup.fixtures.payload,
          profiles: { ...profiles, [id]: actualProfile },
        },
        assertPhysicalWorkspacePath: (file) => guard(file, workspace),
      };
      outcome.readback = await verifyExistingAgentFiles(readbackOptions);
      outcome.screenshot = await screenshot(
        "production-" + id + "-verified.png",
      );
      outcome.firstPassed = true;
      write(id + "/first-result.json", {
        ...outcome,
        passed: true,
        scope:
          "First UI confirmation only; independent retest is not inherited",
      });
      progress({ event: "production-tool-first-verified", id, model });
      const retest = (outcome.independentRetest = {
        surface: "native-ipc",
        passed: false,
        startedAt: new Date().toISOString(),
      });
      const retestWorkspace = observeToolWorkspace(guard(nativeRoot), id);
      try {
        retest.receipt = await independentNativeProbe(expected);
        retest.probe = retest.receipt.result;
        retest.toolWorkspaceObservation = retestWorkspace.finish();
      } finally {
        retestWorkspace.close();
      }
      assert.notEqual(
        retest.toolWorkspaceObservation.directoryName,
        outcome.toolWorkspaceObservation.directoryName,
        "Independent retest must use a new Rust verification UUID",
      );
      assertProbe(retest.probe, id, model);
      retest.configuration = (
        await readonlyNative("agent_hub_overview")
      ).agents.find((agent) => agent.id === id);
      assertConfiguration(
        outcome.configuration,
        retest.configuration,
        expected,
      );
      retest.readback = await verifyExistingAgentFiles(readbackOptions);
      retest.finishedAt = new Date().toISOString();
      retest.passed = true;
      outcome.independentRetestPassed = true;
      outcome.passed = true;
      write(id + "/independent-retest.json", retest);
      progress({
        event: "production-tool-independent-retest-verified",
        id,
        model,
        surface: "native-ipc",
      });
    } catch (error) {
      outcome.failure = safe(error.stack ?? error.message);
      if (outcome.independentRetest) {
        outcome.independentRetest.failure = outcome.failure;
        outcome.independentRetest.finishedAt = new Date().toISOString();
        write(id + "/independent-retest.json", outcome.independentRetest);
      }
      outcome.ui ??= {
        status: await text(".hub-probe-status").catch(() => ""),
        notice: await text(".hub-notice").catch(() => ""),
      };
      outcome.screenshot = await screenshot(
        "production-" + id + "-failure.png",
      ).catch(() => null);
    }
    outcome.durationMs = Date.now() - started;
    report.firstPassedCount = report.clients.filter(
      (client) => client.firstPassed,
    ).length;
    report.independentRetestPassedCount = report.clients.filter(
      (client) => client.independentRetestPassed,
    ).length;
    write("production-ui-results.json", report);
    write(id + "/result.json", outcome);
    progress({
      event: "production-tool-ui-confirm-finished",
      id,
      passed: outcome.passed,
      failure: outcome.failure,
    });
  }
  if (await page.locator("#hub-api-key").inputValue())
    await page.locator("#hub-api-key").fill("");
  await verifySurface("after", provider);
  const refreshed = await readonlyNative("agent_hub_overview");
  for (const outcome of report.clients)
    if (outcome.passed) {
      const agent = refreshed.agents.find((agent) => agent.id === outcome.id);
      assertConfiguration(outcome.configuration, agent, {
        agentId: outcome.id,
        providerId: provider.id,
        model,
      });
    }
  report.singlePageConnectionFlow = true;
  report.passed =
    report.clients.length === 1 &&
    report.clients.every((client) => client.passed) &&
    report.surface.before?.passed === true &&
    report.surface.after?.passed === true &&
    report.pageErrors.length === 0;
} catch (error) {
  report.failure = safe(error.stack ?? error.message);
} finally {
  await Promise.allSettled([...pending]);
  if (browser) await browser.close().catch(() => {});
  report.finishedAt = new Date().toISOString();
  report.passedCount = report.clients.filter((client) => client.passed).length;
  report.failedCount = report.clients.filter((client) => !client.passed).length;
  report.firstPassedCount = report.clients.filter(
    (client) => client.firstPassed,
  ).length;
  report.independentRetestPassedCount = report.clients.filter(
    (client) => client.independentRetestPassed,
  ).length;
  const sourceAfter = sourceSnapshot();
  write("source-after.json", sourceAfter);
  report.sourceFilesCompared = sourceBefore.fileCount;
  report.sourceBeforeAfterUnchanged =
    sourceBefore.digest === sourceAfter.digest;
  report.helperFiles = helperFiles;
  report.helperInputsUnchanged = helperFiles.every(
    (file) => sha(fs.readFileSync(file.path)) === file.sha256,
  );
  report.sharedOfficialRuntimes = sharedBefore;
  report.sharedOfficialRuntimeBytesUnchanged = sharedBefore.every(
    (file) => sha(fs.readFileSync(file.path)) === file.sha256,
  );
  report.dispatchOnlyEntries = entriesBefore;
  report.dispatchOnlyEntryBytesUnchanged = entriesBefore.every(
    (file) => sha(fs.readFileSync(file.path)) === file.sha256,
  );
  report.preservedFilesUnchanged = setup.fixtures.payload.preservedFiles.every(
    (file) => sha(fs.readFileSync(guard(file.path))) === file.sha256,
  );
  if (
    !report.sourceBeforeAfterUnchanged ||
    !report.helperInputsUnchanged ||
    !report.sharedOfficialRuntimeBytesUnchanged ||
    !report.dispatchOnlyEntryBytesUnchanged ||
    !report.preservedFilesUnchanged
  )
    report.passed = false;
  write("ui-ipc.json", journal);
  write("production-ui-results.json", report);
  progress({
    event: "production-codex-byte-diagnostic-finished",
    passed: report.passed,
    passedCount: report.passedCount,
    failedCount: report.failedCount,
    failure: report.failure,
  });
  process.exitCode = report.passed ? 0 : 1;
}
