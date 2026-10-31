/**
 * Attach-only production WebView acceptance extension. Never creates an AE
 * process, installs mock IPC, or changes endpoints/keys. An optional temporary
 * disconnect/restore is restricted to independently prepared owned sandboxes.
 * The caller must first validate the CDP listener/process/window ownership.
 * node tests/acceptance/core-features-native.mjs --cdp http://127.0.0.1:PORT --output G:/owned/output
 * Optional: --screenshots (four masked viewport/theme images).
 * --setup <owned setup.json> --disconnect-roundtrip permits one sandbox-only
 * native UI disconnect followed by configure restoration, without inference.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { waitExistingTauriPage } from "./wait-existing-tauri-page.mjs";
import {
  assertExistingProfileEquivalent,
  verifyExistingAgentFiles,
} from "./native-existing-readback.mjs";

const workspace = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const argumentsList = process.argv.slice(2);
const options = {};
for (let index = 0; index < argumentsList.length; index++) {
  const name = argumentsList[index];
  if (name === "--screenshots") options.screenshots = true;
  else if (name === "--configuration-only") options.configurationOnly = true;
  else if (name === "--disconnect-roundtrip")
    options.disconnectRoundtrip = true;
  else {
    assert(
      name === "--cdp" || name === "--output" || name === "--setup",
      "Unknown native acceptance argument",
    );
    options[name.slice(2)] = argumentsList[++index];
  }
}
assert.match(workspace, /^G:[\\/]/i, "Acceptance workspace must stay on G:");
assert(options.cdp && options.output, "--cdp and --output are required");
assert(
  !options.disconnectRoundtrip || options.setup,
  "--disconnect-roundtrip requires a prepared owned --setup",
);
assert(
  !options.configurationOnly || options.setup,
  "--configuration-only requires an owned --setup",
);
const cdp = new URL(options.cdp);
assert(
  cdp.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(cdp.hostname) &&
    cdp.port &&
    !cdp.username &&
    !cdp.password &&
    !cdp.search &&
    !cdp.hash,
  "CDP must be an explicit loopback HTTP listener",
);
const output = path.resolve(options.output);
assert.match(output, /^G:[\\/]/i, "Native acceptance output must stay on G:");
assert(
  output.toLowerCase().startsWith(workspace.toLowerCase() + path.sep),
  "Output must remain within this workspace",
);
for (let ancestor = output; ; ancestor = path.dirname(ancestor)) {
  try {
    assert.equal(
      (await fs.lstat(ancestor)).isSymbolicLink(),
      false,
      "Reparse output ancestor rejected",
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (path.dirname(ancestor) === ancestor) break;
}
await fs.mkdir(output, { recursive: true });
for (const variable of [
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "NODE_COMPILE_CACHE",
]) {
  const directory = path.join(
    workspace,
    ".cache/native-core-features",
    variable.toLowerCase(),
  );
  await fs.mkdir(directory, { recursive: true });
  process.env[variable] = directory;
}
const require = createRequire(path.join(workspace, "app/package.json"));
const { chromium } = require("playwright");
const runId = randomUUID().replaceAll("-", "");
const profileName = `AE acceptance ${runId.slice(0, 10)}`;
const report = {
  runId,
  scope:
    "attach-only production Tauri UI using existing real IPC and configured native clients",
  syntheticIpc: false,
  mockInstalled: false,
  nativeIpcExecuted: false,
  callerOwnedWindowGuardRequired: true,
  aeProcessStartedOrStopped: false,
  clientDisconnected: false,
  temporaryDisconnectRequested: !!options.disconnectRoundtrip,
  temporaryDisconnectRestored: options.disconnectRoundtrip ? false : null,
  configurationOnly: !!options.configurationOnly,
  upstreamInferenceRequestedByThisExtension: false,
  realInferenceOrToolAcceptanceClaimedByThisExtension: false,
  startedAt: new Date().toISOString(),
  checks: [],
  screenshots: [],
};
let browser;
let page;
let originalViewport;
let originalTheme;
let originalModel;
let originalFavorite;
let savedProfileId;
let profileDeleted = false;
let observationInstalled = false;
let roundtripRestoration;
let roundtripOriginalSelections;
let roundtripHistory;
let roundtripPending = false;
let roundtripSetup;
let roundtripAgent;
let roundtripFileBaseline;
let stageLabel = "native-attach";
const check = (name, details = {}) =>
  report.checks.push({ name, passed: true, ...details });
const sameSelections = (left, right) =>
  JSON.stringify(left) === JSON.stringify(right);
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const samePath = (left, right) =>
  path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
async function guardOwned(file, root, missing = false) {
  const full = path.resolve(file);
  const base = path.resolve(root);
  assert.match(full, /^G:[\\/]/i, "Owned acceptance target must stay on G:");
  assert(
    samePath(full, base) ||
      full.toLowerCase().startsWith(base.toLowerCase() + path.sep),
    "Acceptance target escaped its exact owner root",
  );
  for (let ancestor = full; ; ancestor = path.dirname(ancestor)) {
    try {
      assert.equal(
        (await fs.lstat(ancestor)).isSymbolicLink(),
        false,
        "Reparse owned target rejected",
      );
    } catch (error) {
      if (error.code !== "ENOENT" || !missing) throw error;
    }
    if (path.dirname(ancestor) === ancestor) break;
  }
  return full;
}
async function setupOwnership() {
  if (!options.setup) return null;
  stageLabel = "setup-path-scope";
  const setupFile = await guardOwned(
    path.resolve(options.setup),
    path.join(workspace, ".cache/native-e2e-sandbox"),
  );
  const setup = JSON.parse(await fs.readFile(setupFile, "utf8"));
  stageLabel = "setup-schema-and-owner-id";
  assert.equal(
    setup.schemaVersion,
    2,
    "Independent production setup schema required",
  );
  assert.match(setup.ownerId, /^[a-f0-9]{32}$/);
  stageLabel = "setup-workspace-and-owner-root";
  assert(samePath(setup.workspace, workspace), "Setup workspace mismatch");
  const ownerRoot = path.join(
    workspace,
    ".cache/native-e2e-sandbox",
    setup.ownerId,
  );
  assert(
    samePath(setup.root, ownerRoot),
    "Setup root must be the exact owned UUID sandbox",
  );
  assert(
    samePath(setupFile, path.join(ownerRoot, "setup.json")),
    "Setup file must be the owner's setup.json",
  );
  await guardOwned(ownerRoot, ownerRoot);
  stageLabel = "setup-portable-root";
  assert(
    samePath(setup.portableRoot, path.join(ownerRoot, "portable")),
    "Unexpected owned portable root",
  );
  await guardOwned(setup.portableRoot, ownerRoot);
  assert(
    samePath(setup.fixtures?.payload?.portableRoot, setup.portableRoot),
    "Fixture and setup portable roots must match",
  );
  const owner = JSON.parse(
    await fs.readFile(
      await guardOwned(
        path.join(ownerRoot, ".ae-production-ui-eight-owner.json"),
        ownerRoot,
      ),
      "utf8",
    ),
  );
  stageLabel = "setup-marker-schema-and-bindings";
  assert.equal(owner.schemaVersion, 2);
  assert.equal(owner.ownerId, setup.ownerId);
  assert(
    samePath(owner.workspace, workspace),
    "Owner marker workspace mismatch",
  );
  for (const field of ["sourceDigest", "buildAuditId", "productionSha256"])
    assert.equal(owner[field], setup[field], "Owner/build binding mismatch");
  assert.equal(setup.officialClientCodeModified, false);
  assert.equal(setup.qaHooksUsed, false);
  assert.equal(setup.discoveryContextInjected, false);
  return setup;
}
async function assertSetupProfile(setup, agent) {
  assert(
    agent.profile && agent.configured,
    "Owned configured native profile required",
  );
  const discovered = setup.fixtures?.payload?.discoveredProfiles?.[agent.id];
  const prepared = setup.fixtures?.payload?.profiles?.[agent.id];
  assert(discovered && prepared, "Prepared discovered profile must exist");
  if (
    agent.id === "zcode" &&
    !Object.hasOwn(discovered, "stateFile") &&
    Object.hasOwn(agent.profile, "stateFile")
  ) {
    const { stateFile, ...unchanged } = agent.profile;
    assertExistingProfileEquivalent(unchanged, discovered);
    assertExistingProfileEquivalent(agent.profile, prepared);
    await guardOwned(stateFile, setup.root);
  } else assertExistingProfileEquivalent(agent.profile, discovered);
  for (const [name, value] of Object.entries(agent.profile)) {
    if (name === "profileName" || value == null) continue;
    assert.equal(
      typeof value,
      "string",
      "Native profile values must match expected types",
    );
    if (
      name === "executablePath" &&
      agent.id === "codex" &&
      setup.fixtures.payload.nativeCodexEntry === true
    ) {
      const file = await guardOwned(value, workspace);
      const expected = setup.fixtures.sharedRuntimeFiles?.[value];
      assert.match(expected || "", /^[a-f0-9]{64}$/);
      assert.equal(
        createHash("sha256")
          .update(await fs.readFile(file))
          .digest("hex"),
        expected,
        "Prepared official executable bytes changed",
      );
    } else
      await guardOwned(
        value,
        setup.root,
        ![
          "directory",
          "homeDirectory",
          "executablePath",
          "workspaceDirectory",
        ].includes(name),
      );
  }
}
async function preservedHistory(setup) {
  const bindings = setup.fixtures?.payload?.preservedFiles;
  assert(
    Array.isArray(bindings) && bindings.length > 0,
    "Prepared preserved history bindings required",
  );
  const files = [];
  for (const binding of bindings) {
    // Some preserved bindings are shared read-only fixture manifests. They
    // remain workspace-bound; only the profile mutation target grants writes.
    const file = await guardOwned(binding.path, workspace);
    assert.match(binding.sha256, /^[a-f0-9]{64}$/);
    const sha256 = createHash("sha256")
      .update(await fs.readFile(file))
      .digest("hex");
    assert.equal(
      sha256,
      binding.sha256,
      "Prepared preserved history bytes changed",
    );
    files.push({ file, sha256 });
  }
  return files;
}
async function assertHistoryUnchanged(files) {
  for (const binding of files)
    assert.equal(
      createHash("sha256")
        .update(await fs.readFile(binding.file))
        .digest("hex"),
      binding.sha256,
      "Disconnect roundtrip changed preserved history bytes",
    );
}
async function loadCodexOriginalBaseline(setup, target) {
  assert.equal(
    target.id,
    "codex",
    "Original-file roundtrip evidence is restricted to owned Codex",
  );
  const file = await guardOwned(
    path.join(setup.root, "core-features-codex-original.json"),
    setup.root,
  );
  const baseline = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(baseline.schemaVersion, 1);
  assert.equal(baseline.ownerId, setup.ownerId);
  assert.equal(baseline.agentId, "codex");
  assert.equal(
    baseline.setupSha256,
    createHash("sha256")
      .update(await fs.readFile(await guardOwned(options.setup, setup.root)))
      .digest("hex"),
  );
  assert.equal(
    baseline.directoryIdentitySha256,
    createHash("sha256")
      .update(path.resolve(target.profile.directory).toLowerCase())
      .digest("hex"),
  );
  assert.deepEqual(
    baseline.files.map((entry) => entry.name),
    ["config.toml", "auth.json"],
  );
  for (const entry of baseline.files) {
    assert.equal(typeof entry.existed, "boolean");
    if (entry.existed) assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    else assert.equal(entry.sha256, null);
  }
  return baseline;
}
async function assertCodexOriginalFiles(setup, target, baseline) {
  for (const expected of baseline.files) {
    const file = await guardOwned(
      path.join(target.profile.directory, expected.name),
      setup.root,
      true,
    );
    let bytes;
    try {
      bytes = await fs.readFile(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    assert.equal(
      bytes !== undefined,
      expected.existed,
      "Disconnect did not restore original native file presence",
    );
    assert.equal(
      bytes === undefined
        ? null
        : createHash("sha256").update(bytes).digest("hex"),
      expected.sha256,
      "Disconnect did not restore original native file bytes",
    );
  }
}
async function verifyRoundtripConfiguration(setup, target) {
  const nativeRoot = await guardOwned(
    path.join(setup.portableRoot, "data"),
    setup.root,
  );
  const gateway = JSON.parse(
    await fs.readFile(
      await guardOwned(
        path.join(nativeRoot, "protocol-bridge.json"),
        setup.root,
      ),
      "utf8",
    ),
  );
  const baseUrl = `http://127.0.0.1:${gateway.port}/agents/selected:${target.id}${target.id === "claude_code" ? "" : "/v1"}`;
  const readback = await verifyExistingAgentFiles({
    workspaceRoot: workspace,
    nativeRoot,
    agent: target.id,
    providerId: target.providerId,
    model: target.model,
    gateway: { baseUrl, token: gateway.token },
    fixture: {
      ...setup.fixtures.payload,
      profiles: {
        ...setup.fixtures.payload.profiles,
        [target.id]: target.profile,
      },
    },
    assertPhysicalWorkspacePath: (file) => guardOwned(file, workspace),
  });
  assert(
    readback.nativeAuthentication &&
      readback.modelRoutesVerified &&
      readback.originalProfileMatched &&
      readback.transactionSettled,
  );
  report.roundtripIndependentNativeReadback = true;
}
async function restoreRoundtrip() {
  if (!roundtripPending || !roundtripRestoration) return;
  const beforeRestore = await nativeState();
  const current = beforeRestore.find((agent) => agent.id === roundtripAgent.id);
  const others = selectionProjection(
    beforeRestore.filter((agent) => agent.id !== roundtripAgent.id),
  );
  assert(
    sameSelections(
      others,
      roundtripOriginalSelections.filter(
        (agent) => agent.id !== roundtripAgent.id,
      ),
    ),
    "Another native selection changed during the temporary disconnect",
  );
  if (current.configured) {
    assert(
      sameSelections(
        selectionProjection([current]),
        selectionProjection([roundtripAgent]),
      ),
      "Refusing to replace a concurrently configured native selection",
    );
  } else {
    await assertSetupProfile(roundtripSetup, roundtripAgent);
    const provider = await page.evaluate(async (providerId) => {
      const provider = (
        await window.__TAURI_INTERNALS__.invoke("get_overview")
      ).providers.find((provider) => provider.id === providerId);
      return provider
        ? {
            model: provider.model,
            reasoningEffort: provider.reasoningEffort || null,
          }
        : null;
    }, roundtripAgent.providerId);
    assert(provider, "Original native provider is no longer available");
    assert.equal(
      provider.model === roundtripAgent.model ? provider.reasoningEffort : null,
      roundtripAgent.reasoningEffort,
      "Original reasoning selection changed; refusing an inexact restoration",
    );
    // This sole mutating direct IPC is authorized only by setupOwnership plus
    // exact discovered-profile validation performed before the UI disconnect.
    await page.evaluate(async (input) => {
      if (
        window.isTauri !== true ||
        typeof window.__TAURI_INTERNALS__?.invoke !== "function" ||
        window.__coreFeaturesFixture
      )
        throw new Error("Native IPC required");
      await window.__TAURI_INTERNALS__.invoke("configure_agent", { input });
    }, roundtripRestoration);
  }
  const restored = await nativeState();
  assert(
    sameSelections(selectionProjection(restored), roundtripOriginalSelections),
    "Temporary disconnect did not restore the exact native choices",
  );
  await assertHistoryUnchanged(roundtripHistory);
  await verifyRoundtripConfiguration(roundtripSetup, roundtripAgent);
  roundtripPending = false;
  report.temporaryDisconnectRestored = true;
  report.clientDisconnected = false;
}
async function disclosure(label) {
  const heading = page
    .locator("summary")
    .filter({ hasText: new RegExp(`^${label}$`) })
    .first();
  const parents = await heading.evaluate((node) => {
    const labels = [];
    for (
      let container = node.parentElement?.parentElement?.closest("details");
      container;
      container = container.parentElement?.closest("details")
    ) {
      const label = container
        .querySelector(":scope > summary")
        ?.textContent?.trim();
      if (label) labels.unshift(label);
    }
    return labels;
  });
  for (const parent of parents) await disclosure(parent);
  const details = heading.locator("..");
  if ((await details.getAttribute("open")) === null)
    await details.locator("summary").first().click();
  return details;
}
async function nativeState() {
  return page.evaluate(async () => {
    if (
      window.isTauri !== true ||
      typeof window.__TAURI_INTERNALS__?.invoke !== "function" ||
      window.__coreFeaturesFixture
    )
      throw new Error("Native Tauri identity verification failed");
    const overview =
      await window.__TAURI_INTERNALS__.invoke("agent_hub_overview");
    return overview.agents.map((agent) => ({
      id: agent.id,
      configured: agent.configured,
      providerId: agent.providerId,
      model: agent.model,
      reasoningEffort: agent.reasoningEffort || null,
      profile: agent.profile || null,
      configurationRevision: agent.configurationRevision || 0,
    }));
  });
}
const selectionProjection = (agents) =>
  agents.map(
    ({ id, configured, providerId, model, reasoningEffort, profile }) => ({
      id,
      configured,
      providerId,
      model,
      reasoningEffort,
      profile,
    }),
  );
async function closeTransientNotice() {
  const close = page.getByRole("button", { name: "关闭提示", exact: true });
  if (await close.count()) await close.click();
}
async function observeBusy() {
  observationInstalled = true;
  await page.evaluate(() => {
    window.__aeCoreNativeBusyObservation?.observer?.disconnect();
    const state = { observed: false, observer: null };
    const sample = () => {
      const nav = [
        ...document.querySelectorAll("nav[aria-label='选择 Agent'] button"),
      ];
      state.observed ||=
        nav.length > 0 &&
        nav.every((button) => button.disabled) &&
        document.querySelector("#hub-endpoint")?.disabled === true &&
        document.querySelector("#hub-api-key")?.disabled === true;
    };
    state.observer = new MutationObserver(sample);
    state.observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["disabled"],
    });
    window.__aeCoreNativeBusyObservation = state;
    sample();
  });
}
async function getBusyObserved() {
  return page.evaluate(() => !!window.__aeCoreNativeBusyObservation?.observed);
}
async function waitUnlocked() {
  await page.waitForFunction(() =>
    [...document.querySelectorAll("nav[aria-label='选择 Agent'] button")].every(
      (button) => !button.disabled,
    ),
  );
}
async function captureViews() {
  for (const [name, width, theme] of [
    ["desktop-dark", 1200, "dark"],
    ["narrow-dark", 390, "dark"],
    ["desktop-light", 1200, "light"],
    ["narrow-light", 390, "light"],
  ]) {
    await page.setViewportSize({ width, height: 1000 });
    if ((await page.locator("html").getAttribute("data-ae-theme")) !== theme)
      await page
        .getByRole("button", {
          name: theme === "light" ? "切换浅色主题" : "切换深色主题",
        })
        .click();
    const file = `core-features-native-${name}.png`;
    // Never screenshot native endpoints, credential suffixes, model/provider
    // identifiers, user directories, client failure messages, or activity IDs.
    const masks = [
      "#hub-endpoint",
      "#hub-api-key",
      ".hub-field p",
      ".hub-extra-settings",
      ".hub-profile-settings",
      ".hub-model-select",
      ".hub-config-profile-list",
      ".hub-config-profile-preview li",
      ".hub-activity-list",
      ".hub-notice",
      ".hub-client-warning",
      ".hub-connection-result",
      ".hub-client-actions",
    ].map((selector) => page.locator(selector));
    await page.screenshot({
      path: path.join(output, file),
      fullPage: true,
      animations: "disabled",
      mask: masks,
      maskColor: "#687486",
    });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    );
    assert.equal(
      overflow,
      false,
      "New native UI must not overflow horizontally",
    );
    report.screenshots.push({
      file,
      width,
      theme,
      maskedPrivateFields: true,
      horizontalOverflow: false,
    });
  }
}

try {
  browser = await chromium.connectOverCDP(cdp.href);
  page = await waitExistingTauriPage(browser);
  page.setDefaultTimeout(30000);
  const identity = await page.evaluate(() => ({
    isTauri: window.isTauri === true,
    invoke: typeof window.__TAURI_INTERNALS__?.invoke === "function",
    syntheticMarker: !!window.__coreFeaturesFixture,
    origin: location.origin,
  }));
  assert.equal(identity.isTauri, true, "Real Tauri flag is required");
  assert.equal(
    identity.invoke,
    true,
    "Existing native Tauri invoke is required",
  );
  assert.equal(
    identity.syntheticMarker,
    false,
    "Synthetic IPC fixture rejected",
  );
  assert(
    /^(?:https?:\/\/tauri\.localhost|tauri:\/\/localhost)(?::\d+)?$/.test(
      identity.origin,
    ),
    "Production Tauri origin required",
  );
  originalViewport = page.viewportSize();
  originalTheme = await page.locator("html").getAttribute("data-ae-theme");
  const initial = await nativeState();
  report.nativeIpcExecuted = true;
  const configured = initial.filter((agent) => agent.configured);
  stageLabel = "native-configured-client-readback";
  report.initialConfiguredClientCount = configured.length;
  report.initialClientConfiguration = initial.map(({ id, configured }) => ({
    id,
    configured: configured === true,
  }));
  assert(
    configured.length > 0,
    "At least one real configured native client is required",
  );
  const baseline = selectionProjection(initial);
  const ownedSetup = await setupOwnership();
  stageLabel = "owned-setup-profile-validation";
  if (ownedSetup) {
    const storeDirectory = await page.evaluate(
      async () =>
        (await window.__TAURI_INTERNALS__.invoke("get_overview")).dataDirectory,
    );
    assert(
      samePath(storeDirectory, path.join(ownedSetup.portableRoot, "data")),
      "Native data directory must match the prepared owned portable root",
    );
    await guardOwned(storeDirectory, ownedSetup.root);
    for (const agent of configured) await assertSetupProfile(ownedSetup, agent);
    report.ownedSetupValidated = true;
    report.ownerId = ownedSetup.ownerId;
  }
  report.configuredClientCount = configured.length;
  report.selectionDigestBefore = digest(baseline);
  const selected =
    configured.find((agent) => agent.id === "codex") || configured[0];
  const navigation = page.getByRole("navigation", { name: "选择 Agent" });
  const selectedButton = navigation
    .locator("button")
    .filter({ has: page.locator(`.brand-${selected.id}`) });
  assert.equal(
    await selectedButton.count(),
    1,
    "Configured client navigation target must be unique",
  );
  await selectedButton.click();
  await waitUnlocked();
  check(
    "attached to existing production Tauri WebView and read real configured selections",
    { configuredClients: configured.length },
  );

  const profiles = await disclosure("配置方案");
  stageLabel = "profile-save-preview";
  await profiles
    .getByRole("heading", { name: "具名配置方案" })
    .waitFor({ state: "visible" });
  await profiles.getByRole("textbox", { name: "方案名称" }).fill(profileName);
  await profiles
    .getByRole("button", { name: "保存当前组合", exact: true })
    .click();
  const previewTrigger = profiles.getByRole("button", {
    name: `预览方案 ${profileName}`,
    exact: true,
  });
  await previewTrigger.waitFor({ state: "visible" });
  const nativeProfile = await page.evaluate(async (name) => {
    const profiles = await window.__TAURI_INTERNALS__.invoke(
      "list_config_profiles",
    );
    const saved = profiles.filter((profile) => profile.name === name);
    if (saved.length !== 1)
      throw new Error("Native saved profile is not unique");
    return saved[0];
  }, profileName);
  savedProfileId = nativeProfile.id;
  assert.equal(
    nativeProfile.entries.length,
    configured.length,
    "Native profile must include each currently configured client",
  );
  assert(
    nativeProfile.entries.every(
      (entry) =>
        Object.keys(entry).sort().join(",") ===
        "agentId,model,providerId,reasoningEffort",
    ),
    "Saved profile must contain only reference metadata",
  );
  for (const entry of nativeProfile.entries) {
    const old = configured.find((agent) => agent.id === entry.agentId);
    assert(
      old &&
        old.providerId === entry.providerId &&
        old.model === entry.model &&
        old.reasoningEffort === entry.reasoningEffort,
      "Profile choice must equal the real preexisting selection",
    );
  }
  await previewTrigger.click();
  await profiles
    .getByLabel(`方案预览 ${profileName}`)
    .waitFor({ state: "visible" });
  await profiles.getByRole("button", { name: "取消预览", exact: true }).click();
  assert(
    sameSelections(selectionProjection(await nativeState()), baseline),
    "Cancelling native profile preview must not change selections",
  );
  check(
    "saved real multi-client profile references and cancelled native preview without changes",
    { entries: nativeProfile.entries.length },
  );

  await previewTrigger.click();
  await profiles
    .getByLabel(`方案预览 ${profileName}`)
    .waitFor({ state: "visible" });
  await observeBusy();
  stageLabel = "profile-apply";
  await profiles
    .getByRole("button", { name: "应用此方案", exact: true })
    .click();
  await page
    .getByText("配置方案已应用，请让相关客户端重新加载配置并重新验证。", {
      exact: true,
    })
    .waitFor({ state: "visible" });
  await waitUnlocked();
  assert.equal(
    await getBusyObserved(),
    true,
    "Real profile apply must lock client navigation and connection inputs",
  );
  assert.equal(
    await page.locator(".hub-connection-result").count(),
    0,
    "Native profile apply must clear stale verification results",
  );
  const applied = await nativeState();
  assert(
    sameSelections(selectionProjection(applied), baseline),
    "Applying the captured native combination must preserve exact model, reasoning and profile targets",
  );
  for (const old of configured)
    assert(
      applied.find((agent) => agent.id === old.id).configurationRevision >
        old.configurationRevision,
      "Every included client must receive a new native configuration revision",
    );
  check(
    "applied the same combination through real IPC with a global UI lock and verified unchanged choice targets",
    { entries: configured.length, busyObserved: true },
  );

  const safety = await disclosure("配置保护与安全断开");
  stageLabel = "safe-disconnect-preview-cancel";
  await safety.getByRole("button", { name: "检查配置", exact: true }).click();
  await safety
    .getByText("AE 管理的连接字段与最近写入一致。", { exact: true })
    .waitFor({ state: "visible" });
  await safety.getByRole("button", { name: "预览断开", exact: true }).click();
  await safety.getByLabel("断开预览").waitFor({ state: "visible" });
  assert.equal(
    (await safety.getByLabel("断开预览").locator("li").count()) > 0,
    true,
    "Native disconnect preview must describe managed files",
  );
  await safety.getByRole("button", { name: "取消断开", exact: true }).click();
  assert(
    sameSelections(selectionProjection(await nativeState()), baseline),
    "Cancelled native disconnect preview must preserve all clients",
  );
  check(
    "inspected healthy real managed configuration and cancelled disconnect preview",
    { clientDisconnected: false },
  );

  if (options.disconnectRoundtrip) {
    stageLabel = "owned-disconnect-roundtrip-prepare";
    assert(ownedSetup, "Owned setup is mandatory for temporary disconnect");
    const current = await nativeState();
    const target = options.configurationOnly
      ? current.find((agent) => agent.id === "codex" && agent.configured)
      : current.find(
          (agent) =>
            agent.id === selected.id &&
            ["claude_code", "codex"].includes(agent.id) &&
            agent.configured,
        ) ||
        current.find(
          (agent) =>
            ["claude_code", "codex"].includes(agent.id) && agent.configured,
        );
    assert(target, "Owned Claude Code or Codex profile required");
    await assertSetupProfile(ownedSetup, target);
    if (options.configurationOnly)
      roundtripFileBaseline = await loadCodexOriginalBaseline(
        ownedSetup,
        target,
      );
    const providerDefault = await page.evaluate(async (providerId) => {
      const provider = (
        await window.__TAURI_INTERNALS__.invoke("get_overview")
      ).providers.find((provider) => provider.id === providerId);
      return provider
        ? {
            model: provider.model,
            reasoningEffort: provider.reasoningEffort || null,
          }
        : null;
    }, target.providerId);
    assert(
      providerDefault,
      "Saved native provider required for exact restoration",
    );
    assert.equal(
      providerDefault.model === target.model
        ? providerDefault.reasoningEffort
        : null,
      target.reasoningEffort,
      "Current reasoning selection must be exactly reproducible by configure",
    );
    roundtripHistory = await preservedHistory(ownedSetup);
    roundtripSetup = ownedSetup;
    roundtripAgent = target;
    roundtripOriginalSelections = selectionProjection(current);
    roundtripRestoration = {
      agentId: target.id,
      providerId: target.providerId,
      model: target.model,
      profile: target.profile,
    };
    const targetButton = navigation
      .locator("button")
      .filter({ has: page.locator(`.brand-${target.id}`) });
    await targetButton.click();
    const targetSafety = await disclosure("配置保护与安全断开");
    await targetSafety
      .getByRole("button", { name: "检查配置", exact: true })
      .click();
    await targetSafety
      .getByText("AE 管理的连接字段与最近写入一致。", { exact: true })
      .waitFor({ state: "visible" });
    await targetSafety
      .getByRole("button", { name: "预览断开", exact: true })
      .click();
    await targetSafety.getByLabel("断开预览").waitFor({ state: "visible" });
    roundtripPending = true;
    stageLabel = "owned-native-disconnect";
    await observeBusy();
    await targetSafety
      .getByRole("button", { name: "恢复原配置并断开", exact: true })
      .click();
    await page
      .getByText("已断开 AE 连接并恢复受管字段，请让客户端重新加载配置。", {
        exact: true,
      })
      .waitFor({ state: "visible" });
    await waitUnlocked();
    assert.equal(
      await getBusyObserved(),
      true,
      "Native disconnect must lock the page",
    );
    const disconnected = await nativeState();
    const disconnectedTarget = disconnected.find(
      (agent) => agent.id === target.id,
    );
    assert.equal(
      disconnectedTarget.configured,
      false,
      "Native UI disconnect must remove the target selection",
    );
    assert.equal(disconnectedTarget.providerId, null);
    assert.equal(disconnectedTarget.model, null);
    assert(
      sameSelections(
        selectionProjection(
          disconnected.filter((agent) => agent.id !== target.id),
        ),
        roundtripOriginalSelections.filter((agent) => agent.id !== target.id),
      ),
      "Disconnect must preserve other native client selections",
    );
    await assertHistoryUnchanged(roundtripHistory);
    if (roundtripFileBaseline) {
      stageLabel = "disconnected-original-file-bytes";
      await assertCodexOriginalFiles(ownedSetup, target, roundtripFileBaseline);
      report.roundtripOriginalFilesRestored = true;
      report.roundtripOriginalFileBaseline = roundtripFileBaseline.files;
    }
    report.clientDisconnected = true;
    stageLabel = "owned-native-configure-restore-readback";
    await restoreRoundtrip();
    assert.equal(report.temporaryDisconnectRestored, true);
    // Refresh the public UI from its existing poll. Direct restoration does
    // not probe a model or inject React/query state into the production page.
    await page.waitForFunction(
      (id) =>
        document
          .querySelector(`nav[aria-label='选择 Agent'] .brand-${id}`)
          ?.closest("button")
          ?.querySelector(".hub-configured-dot"),
      target.id,
      { timeout: 30000 },
    );
    await selectedButton.click();
    check(
      "owned native UI disconnect and exact configure restoration preserve every selection and history binding",
      {
        temporaryDisconnectRestored: true,
        preservedFiles: roundtripHistory.length,
        busyObserved: true,
      },
    );
  }

  originalModel = await page.locator("#hub-model").inputValue();
  stageLabel = "model-search-favorite-recent";
  assert(originalModel, "A saved native model must be selected");
  const search = page.getByRole("textbox", { name: "搜索模型", exact: true });
  await search.fill(`nonexistent-${runId}`);
  await page
    .getByText("没有匹配的模型", { exact: true })
    .waitFor({ state: "visible" });
  assert.equal(
    await page.locator("#hub-model").inputValue(),
    originalModel,
    "Native model search must preserve selected model",
  );
  await search.press("Escape");
  assert.equal(
    await search.inputValue(),
    "",
    "Escape must clear model search locally",
  );
  await disclosure("常用模型");
  const favorite = page.locator(".hub-model-favorite");
  originalFavorite = (await favorite.getAttribute("aria-pressed")) === "true";
  await favorite.click();
  assert.equal(
    (await favorite.getAttribute("aria-pressed")) === "true",
    !originalFavorite,
    "Native model favorite toggle must update",
  );
  await favorite.click();
  assert.equal(
    (await favorite.getAttribute("aria-pressed")) === "true",
    originalFavorite,
    "Original favorite state must be restored",
  );
  await page.getByRole("button", { name: /^最近使用 \d+$/ }).click();
  const recentCount = await page
    .getByRole("button", { name: /^最近使用 \d+$/ })
    .innerText();
  assert(
    Number(recentCount.match(/\d+/)?.[0]) > 0,
    "Successful real apply must populate recent models",
  );
  assert.equal(
    await page.locator("#hub-model").inputValue(),
    originalModel,
    "Recent filter must preserve selected model",
  );
  await page.getByRole("button", { name: /^全部 \d+$/ }).click();
  check(
    "native UI search preserves selection, favorite toggles restore prior state, and real apply records recent use",
  );

  const activities = await page.evaluate(
    async (ids) => {
      const results = [];
      for (const agentId of ids) {
        const data = await window.__TAURI_INTERNALS__.invoke(
          "agent_hub_activity",
          { agentId },
        );
        results.push({
          agentId,
          count: data.records.length,
          states: [...new Set(data.records.map((record) => record.state))],
          streams: data.records.filter((record) => record.streaming).length,
        });
      }
      return results;
    },
    configured.map((agent) => agent.id),
  );
  if (!options.configurationOnly)
    assert(
      activities.some((activity) => activity.count > 0),
      "At least one real gateway activity record is required after upstream tool acceptance",
    );
  else
    assert(
      activities.every((activity) => activity.count === 0),
      "Configuration-only extension must not generate inference activity",
    );
  const activity = await disclosure("请求活动");
  await activity.getByRole("button", { name: "刷新活动", exact: true }).click();
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll(".hub-activity-actions button")].some(
        (button) => button.disabled && button.textContent.includes("刷新活动"),
      ),
  );
  report.activity = activities;
  stageLabel = "native-activity";
  check("read real in-memory gateway activity through existing native IPC", {
    clientsWithRecords: activities.filter((activity) => activity.count > 0)
      .length,
    totalRecords: activities.reduce((sum, activity) => sum + activity.count, 0),
  });
  if (options.screenshots) await captureViews();

  await profiles
    .getByRole("button", { name: `删除方案 ${profileName}`, exact: true })
    .click();
  await profiles
    .getByRole("button", { name: `确认删除方案 ${profileName}`, exact: true })
    .click();
  await page.waitForFunction(
    async (id) =>
      !(await window.__TAURI_INTERNALS__.invoke("list_config_profiles")).some(
        (profile) => profile.id === id,
      ),
    savedProfileId,
  );
  profileDeleted = true;
  stageLabel = "acceptance-profile-cleanup";
  assert(
    sameSelections(selectionProjection(await nativeState()), baseline),
    "Deleting the acceptance profile must not modify client choices",
  );
  report.selectionDigestAfter = digest(baseline);
  check(
    "deleted only the acceptance-created profile and preserved all configured native client targets",
  );
  report.passed = true;
} catch (error) {
  report.passed = false;
  // Never persist exception messages, locator logs, DOM, model IDs, endpoints,
  // or native file paths: any may contain values from the user's real profile.
  report.failure = {
    type: error.name || "Error",
    stage: report.checks.length,
    stageLabel,
    reason:
      [
        [
          "At least one real configured native client is required",
          "no-configured-native-client",
        ],
        [
          "Acceptance target escaped its exact owner root",
          "owned-path-scope-mismatch",
        ],
        ["Reparse owned target rejected", "owned-reparse-target"],
        ["Setup workspace mismatch", "setup-workspace-mismatch"],
        [
          "Setup root must be the exact owned UUID sandbox",
          "setup-owner-root-mismatch",
        ],
        [
          "Setup file must be the owner's setup.json",
          "setup-file-owner-mismatch",
        ],
        ["Unexpected owned portable root", "setup-portable-root-mismatch"],
        [
          "Fixture and setup portable roots must match",
          "setup-fixture-portable-mismatch",
        ],
        ["Owner marker workspace mismatch", "setup-marker-workspace-mismatch"],
        ["Owner/build binding mismatch", "setup-marker-build-mismatch"],
      ].find(
        ([message]) =>
          typeof error.message === "string" &&
          error.message.startsWith(message),
      )?.[1] || null,
    code:
      typeof error.code === "string" && /^[A-Z0-9_]{1,40}$/.test(error.code)
        ? error.code
        : null,
  };
  process.exitCode = 1;
} finally {
  if (page) {
    if (roundtripPending)
      await restoreRoundtrip().catch(() => {
        report.temporaryDisconnectRestored = false;
        report.roundtripRecoveryRequired = true;
        report.clientDisconnected = true;
        report.passed = false;
        process.exitCode = 1;
      });
    if (originalFavorite !== undefined)
      await page
        .locator(".hub-model-favorite")
        .getAttribute("aria-pressed")
        .then(async (value) => {
          if ((value === "true") !== originalFavorite)
            await page.locator(".hub-model-favorite").click();
        })
        .catch(() => {});
    if (observationInstalled)
      await page
        .evaluate(() => {
          window.__aeCoreNativeBusyObservation?.observer?.disconnect();
          delete window.__aeCoreNativeBusyObservation;
        })
        .catch(() => {});
    if (savedProfileId && !profileDeleted) {
      // Cleanup only our UUID-named artifact via real IPC; never touch a user
      // profile, client connection, or native configuration.
      profileDeleted = await page
        .evaluate(
          async ({ id, name }) => {
            const saved = (
              await window.__TAURI_INTERNALS__.invoke("list_config_profiles")
            ).find((profile) => profile.id === id && profile.name === name);
            if (!saved) return true;
            await window.__TAURI_INTERNALS__.invoke("delete_config_profile", {
              id,
              revision: saved.revision,
            });
            return true;
          },
          { id: savedProfileId, name: profileName },
        )
        .catch(() => false);
    }
    if (
      originalTheme &&
      (await page
        .locator("html")
        .getAttribute("data-ae-theme")
        .catch(() => null)) !== originalTheme
    )
      await page
        .getByRole("button", {
          name: originalTheme === "light" ? "切换浅色主题" : "切换深色主题",
        })
        .click()
        .catch(() => {});
    if (originalViewport)
      await page.setViewportSize(originalViewport).catch(() => {});
    await closeTransientNotice().catch(() => {});
  }
  report.acceptanceProfileRemoved = !savedProfileId || profileDeleted;
  report.finishedAt = new Date().toISOString();
  // Playwright's close on a connectOverCDP browser detaches the connection; it
  // does not call Browser.close on the externally launched WebView process.
  await browser?.close();
  await fs.writeFile(
    path.join(output, "core-features-native.json"),
    JSON.stringify(report, null, 2),
  );
  process.stdout.write(
    JSON.stringify({
      passed: report.passed,
      checks: report.checks.length,
      screenshots: report.screenshots.length,
      nativeIpcExecuted: report.nativeIpcExecuted,
      acceptanceProfileRemoved: report.acceptanceProfileRemoved,
      failure: report.failure || null,
    }) + "\n",
  );
}
