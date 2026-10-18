import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSurfaceOwnedRoot } from "./native-surface-extra.mjs";

const targetIds = ["codex", "claude_desktop", "claude_cli"];
const agentIds = [
  "claude_code",
  "codex",
  "hermes",
  "oh_my_pi",
  "opencode",
  "zcode",
  "workbuddy",
  "deepseek_harness",
];
const storageKeys = ["uni-switch-list-v1", "uni-switch-ui-target-v1"];
const samePath = (left, right) =>
  typeof left === "string" &&
  typeof right === "string" &&
  path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
const within = (parent, location) => {
  const relative = path.relative(parent, path.resolve(location));
  return (
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
};
const identity = (stat) => ({ dev: stat.dev, ino: stat.ino });
const sameIdentity = (stat, expected) =>
  stat.dev === expected.dev && stat.ino === expected.ino;

async function validateRoot(nativeRoot, workspace, expectedRoot) {
  assert.ok(typeof nativeRoot === "string" && path.isAbsolute(nativeRoot));
  assert.match(workspace, /^G:[\\/]/iu);
  assert.match(nativeRoot, /^G:[\\/]/iu);
  const { root, workspace: ownedWorkspace } =
    await validateSurfaceOwnedRoot(nativeRoot);
  assert.ok(samePath(workspace, ownedWorkspace));
  assert.ok(samePath(root, expectedRoot));
  return root;
}

export function createPathGuards(root, physical, io = fs) {
  async function ordinary(location, allowMissing = false) {
    assert.ok(path.isAbsolute(location) && within(root, location));
    const ancestors = [];
    let current = path.resolve(location);
    while (true) {
      ancestors.push(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    for (const ancestor of ancestors.reverse()) {
      let info;
      try {
        info = await io.lstat(ancestor);
      } catch (error) {
        if (allowMissing && error.code === "ENOENT") {
          await physical(location, { allowMissing: true });
          return null;
        }
        throw error;
      }
      assert.ok(!info.isSymbolicLink());
      assert.ok(info.isFile() || info.isDirectory());
      assert.ok(samePath(ancestor, location) || info.isDirectory());
      if (info.isFile()) assert.equal(info.nlink, 1);
      assert.ok(samePath(await io.realpath(ancestor), ancestor));
    }
    await physical(location);
    return io.lstat(location);
  }
  async function read(location, allowMissing = false) {
    const info = await ordinary(location, allowMissing);
    if (!info) return null;
    assert.ok(info.isFile() && info.size <= 4 * 1024 * 1024);
    return io.readFile(location);
  }
  return { ordinary, read };
}

export async function snapshotConfigurationTrees({
  root,
  value,
  agents,
  ordinary,
  read,
  io = fs,
}) {
  const files = new Map();
  const directories = new Map();
  let entries = 0;
  async function ancestors(directory) {
    assert.ok(path.isAbsolute(directory) && within(root, directory));
    let current = root;
    for (const part of path.relative(root, directory).split(path.sep)) {
      if (!part) continue;
      current = path.join(current, part);
      const info = await ordinary(current, true);
      if (info) assert.ok(info.isDirectory());
      directories.set(current, info ? identity(info) : null);
    }
  }
  async function walk(directory) {
    if (directories.has(directory) && directories.get(directory) === null)
      return;
    const info = await ordinary(directory, true);
    directories.set(directory, info ? identity(info) : null);
    if (!info) return;
    assert.ok(info.isDirectory());
    for (const entry of (await io.readdir(directory)).sort()) {
      assert.ok(++entries <= 240, "Protected trees must be bounded");
      const location = path.join(directory, entry);
      const child = await ordinary(location);
      if (child.isDirectory()) await walk(location);
      else files.set(location, await read(location));
    }
  }
  const trees = new Set(agents.agents.map((item) => item.directory));
  for (const current of value.targets) {
    await ancestors(current.directory);
    if (current.target !== "claude_desktop") trees.add(current.directory);
    else {
      // The desktop target may be the entire LOCALAPPDATA directory.
      // Protect its actual client subtrees, never AE WebView/Windows caches.
      for (const file of current.files) {
        assert.ok(path.isAbsolute(file) && within(current.directory, file));
        const parts = path.relative(current.directory, file).split(path.sep);
        if (parts.length > 1) trees.add(path.join(current.directory, parts[0]));
        else trees.add(current.directory);
      }
    }
  }
  for (const directory of trees) {
    await ancestors(directory);
    await walk(directory);
  }
  const codex = value.targets.find((item) => item.target === "codex");
  assert.ok(codex);
  for (const file of new Set([
    ...value.targets.flatMap((item) => item.files),
    path.join(codex.directory, "auth.json"),
    ...agents.agents.flatMap((item) => (item.launcher ? [item.launcher] : [])),
  ]))
    if (!files.has(file)) files.set(file, await read(file, true));
  return { files, directories };
}

async function poll(read, predicate, timeout = 45000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 75));
  } while (Date.now() < deadline);
  throw new Error("configuration_extra_timeout");
}

function failureCategory(error) {
  if (error?.code === "ERR_ASSERTION") return "assertion";
  if (error?.message === "configuration_extra_timeout") return "timeout";
  if (error?.message === "configuration_extra_native") return "native";
  if (["ENOENT", "EEXIST", "EACCES", "EPERM"].includes(error?.code))
    return "filesystem";
  return "ui_or_guard";
}

function safeAssertionDiagnostic(error, secrets) {
  if (error?.code !== "ERR_ASSERTION") return null;
  const redact = (value) => {
    let result = String(value ?? "");
    for (const secret of secrets)
      if (secret) result = result.split(secret).join("[redacted]");
    return result
      .replace(/<Buffer[\s\S]*?>/gu, "[buffer redacted]")
      .replace(
        /(?:apiKey|accessToken|authorization)\s*[:=][^\n]+/giu,
        "credential field redacted",
      )
      .slice(0, 2048);
  };
  return {
    name: "AssertionError",
    message: redact(String(error.message ?? "").split(/\r?\n/u)[0]),
    // Frame lines identify the failing assertion without printing assertion
    // actual/expected payloads, input values or a Playwright fill trace.
    stack: String(error.stack ?? "")
      .split(/\r?\n/u)
      .filter((line) => /^\s+at\s/u.test(line))
      .slice(0, 8)
      .map(redact),
  };
}

// Call after verifyHubExtras, before any advanced-management or Agent writes.
// Importing this module has no filesystem, socket, IPC or browser side effects.
export async function verifyConfigurationExtras({
  page,
  invoke,
  record,
  addSecret,
  nativeRoot = process.env.AE_NATIVE_EXPECTED_ROOT,
  assertPhysicalWorkspacePath,
}) {
  const workspace = path.resolve(
    fileURLToPath(new URL("../../", import.meta.url)),
  );
  // Reject a foreign root before accessing the page, store, socket or filesystem.
  const root = await validateRoot(
    nativeRoot,
    workspace,
    process.env.AE_NATIVE_EXPECTED_ROOT,
  );
  assert.equal(typeof assertPhysicalWorkspacePath, "function");
  assert.equal(typeof addSecret, "function");
  assert.equal(typeof invoke, "function");
  assert.equal(typeof record, "function");
  const { ordinary, read } = createPathGuards(
    root,
    assertPhysicalWorkspacePath,
  );
  const data = path.join(root, "data");
  const token = randomUUID();
  const fixture = path.join(data, `native-configuration-${token}`);
  const markerFile = path.join(fixture, ".ae-native-configuration-owner.json");
  const junctionTarget = path.join(fixture, "junction-target");
  const junction = path.join(fixture, "rejected-config");
  const probeFile = path.join(junctionTarget, "immutable-probe.txt");
  const probeBytes = Buffer.from(
    `owned configuration junction probe ${token}\n`,
  );
  const keys = {
    a: `ae-switch-synthetic-configuration-a-${randomUUID()}`,
    b: `ae-switch-synthetic-configuration-b-${randomUUID()}`,
  };
  const names = {
    a: `Synthetic configuration A ${token}`,
    b: `Synthetic configuration B ${token}`,
  };
  const models = {
    a: ["gpt-native-configuration-a1", "gpt-native-configuration-a2"],
    b: ["gpt-native-configuration-b1"],
  };
  const requests = { a: 0, b: 0, unsupported: 0 };
  const ownIds = new Map();
  const passedPhases = [];
  const cleanupErrors = [];
  let phase = "ownership";
  let subphase = "validate-owned-data";
  let diagnosticContext = null;
  let failure;
  let baseline;
  let baselineAgents;
  let baselineFiles;
  let originalUi;
  let dataIdentity;
  let fixtureIdentity;
  let markerIdentity;
  let markerBytes;
  let junctionIdentity;
  let junctionTargetIdentity;
  let probeIdentity;
  let appliedFiles;
  let endpoints;
  let server;
  let fallbackCleanup = false;

  const native = async (command, args = {}) => {
    const response = await invoke(command, args);
    if (!response?.ok) throw new Error("configuration_extra_native");
    return response.result;
  };
  const overview = () => native("get_overview");
  const hubOverview = () => native("agent_hub_overview");
  const button = (name) => page.getByRole("button", { name, exact: true });
  const settings = () =>
    page.getByRole("dialog", { name: "Codex 设置", exact: true });
  const target = (value, id = "codex") => {
    const selected = value.targets.find((item) => item.target === id);
    assert.ok(selected);
    return selected;
  };
  const card = (id) =>
    page.locator("li.provider-card").filter({
      has: page.locator(`[data-provider-name="${id}"]`),
    });
  const agentButton = (agent) =>
    page
      .getByRole("navigation", { name: "选择 Agent", exact: true })
      .getByRole("button")
      .filter({
        has: page.getByRole("img", {
          name: `${agent.name} 官方图标`,
          exact: true,
        }),
      });
  const hub = () => ({
    provider: page.locator("#hub-provider"),
    endpoint: page.locator("#hub-endpoint"),
    key: page.locator("#hub-api-key"),
    model: page.locator("#hub-model"),
    details: page.locator(".hub-extra-settings"),
    name: page.locator(".hub-extra-settings input"),
  });

  async function assertRootIdentity() {
    const { id: rootId } = await validateSurfaceOwnedRoot(root);
    assert.ok(sameIdentity(await ordinary(data), dataIdentity));
    const owner = JSON.parse(
      (await read(path.join(root, ".ae-native-e2e-owner.json"))).toString(
        "utf8",
      ),
    );
    assert.equal(owner.id, rootId);
    assert.equal(
      owner.purpose,
      "AE Switch owned native UI and real tool acceptance",
    );
    assert.ok(samePath(owner.workspace, workspace));
  }
  function validateNative(value, agents) {
    assert.ok(samePath(value.dataDirectory, data));
    assert.ok(samePath(agents.dataDirectory, data));
    assert.deepEqual(
      value.targets.map((item) => item.target).sort(),
      [...targetIds].sort(),
    );
    assert.deepEqual(
      agents.agents.map((item) => item.id).sort(),
      [...agentIds].sort(),
    );
    for (const current of value.targets) {
      assert.ok(within(root, current.directory));
      assert.ok(Array.isArray(current.files));
      for (const file of current.files)
        assert.ok(path.isAbsolute(file) && within(current.directory, file));
    }
    for (const agent of agents.agents) {
      assert.ok(samePath(agent.directory, path.join(data, "agents", agent.id)));
      if (agent.launcher) assert.ok(within(agent.directory, agent.launcher));
    }
  }
  async function snapshot(value, agents) {
    validateNative(value, agents);
    await assertRootIdentity();
    return snapshotConfigurationTrees({ root, value, agents, ordinary, read });
  }
  function exactFiles(expected, actual) {
    const nonempty = (files) =>
      [...files]
        .filter(([, bytes]) => bytes !== null)
        .map(([file]) => file)
        .sort();
    assert.deepEqual(nonempty(actual.files), nonempty(expected.files));
    for (const file of new Set([
      ...expected.files.keys(),
      ...actual.files.keys(),
    ])) {
      const before = expected.files.get(file) ?? null;
      const after = actual.files.get(file) ?? null;
      assert.ok(before === null ? after === null : after?.equals(before));
    }
  }
  function exactDirectories(expected, actual) {
    const existing = (directories) =>
      [...directories]
        .filter(([, info]) => info !== null)
        .map(([location]) => location)
        .sort();
    assert.deepEqual(
      existing(actual.directories),
      existing(expected.directories),
    );
    for (const [location, info] of expected.directories)
      if (info) assert.deepEqual(actual.directories.get(location), info);
  }
  async function assertProtected(expected = baselineFiles) {
    const value = await overview();
    const agents = await hubOverview();
    const currentFiles = await snapshot(value, agents);
    exactFiles(expected, currentFiles);
    exactDirectories(expected, currentFiles);
    assert.deepEqual(agents.agents, baselineAgents.agents);
    return value;
  }
  async function noFullKey(value) {
    const publicState = JSON.stringify(value);
    assert.ok(Object.values(keys).every((key) => !publicState.includes(key)));
    const leaked = await page.evaluate((secrets) => {
      const text = document.body.innerText;
      const attributes = [...document.querySelectorAll("*")]
        .flatMap((element) =>
          [...element.attributes].map((attribute) => attribute.value),
        )
        .join("\n");
      return secrets.some(
        (secret) => text.includes(secret) || attributes.includes(secret),
      );
    }, Object.values(keys));
    assert.equal(leaked, false);
  }
  function assertOwnProvider(provider, kind) {
    assert.ok(provider && /^[a-f0-9-]{36}$/iu.test(provider.id));
    assert.equal(provider.family, "codex");
    assert.equal(provider.name, names[kind]);
    assert.equal(provider.baseUrl, endpoints[kind]);
    assert.ok(provider.hasKey);
    assert.ok(models[kind].includes(provider.model));
    assert.deepEqual(
      provider.codexOptions.models
        .filter((model) => model.enabled)
        .map((model) => model.id)
        .sort(),
      [...models[kind]].sort(),
    );
    const known = ownIds.get(kind);
    if (known) assert.equal(provider.id, known);
    return provider;
  }
  async function captureOwned() {
    const value = await overview();
    if (endpoints)
      for (const kind of ["a", "b"])
        for (const provider of value.providers)
          if (
            provider.name === names[kind] &&
            provider.baseUrl === endpoints[kind]
          )
            ownIds.set(kind, assertOwnProvider(provider, kind).id);
    return value;
  }
  async function newDraft(label = "new-provider") {
    subphase = `${label}:select-empty-provider`;
    await hub().provider.selectOption("");
    subphase = `${label}:await-empty-catalog`;
    await poll(
      () =>
        hub()
          .model.locator("option")
          .evaluateAll((options) =>
            options
              .filter((option) => option.value)
              .map((option) => option.value),
          ),
      (values) => values.length === 0,
    );
    subphase = `${label}:assert-empty-masked-draft`;
    assert.ok(
      (await hub().endpoint.inputValue()) === "",
      "New provider endpoint must be blank",
    );
    assert.ok(
      (await hub().key.inputValue()) === "",
      "New provider Key must be blank",
    );
    assert.equal(await hub().key.getAttribute("type"), "password");
    assert.ok(
      (await hub().name.inputValue()) === "",
      "New provider name must be blank",
    );
    assert.ok(
      (await hub().model.inputValue()) === "",
      "New provider model must be blank",
    );
    assert.equal(await button("仅保存").isEnabled(), false);
    assert.equal(await button("确认并验证").isEnabled(), false);
  }
  async function saveHub(kind) {
    await newDraft(`save-${kind}`);
    const previous = requests[kind];
    subphase = `save-${kind}:fill-synthetic-connection`;
    await hub().endpoint.fill(endpoints[kind]);
    await hub().key.fill(keys[kind]);
    subphase = `save-${kind}:await-real-model-discovery`;
    await poll(() => hub().model.isEnabled(), Boolean);
    assert.ok(requests[kind] > previous);
    subphase = `save-${kind}:select-saved-default`;
    await hub().model.selectOption(models[kind][0]);
    if (!(await hub().details.evaluate((element) => element.open)))
      await hub().details.locator("summary").click();
    await hub().name.fill(names[kind]);
    subphase = `save-${kind}:click-save-only`;
    await button("仅保存").click();
    await page
      .getByText("供应商已保存。选择已安装的 Agent，可继续配置端点。", {
        exact: true,
      })
      .waitFor({ timeout: 45000 });
    subphase = `save-${kind}:assert-native-saved-provider`;
    const saved = await captureOwned();
    assert.ok(ownIds.has(kind));
    subphase = `save-${kind}:assert-key-cleared-and-masked`;
    assert.ok(
      (await hub().key.inputValue()) === "",
      "Saved synthetic Key must be cleared from the input",
    );
    assert.equal(await hub().key.getAttribute("type"), "password");
    subphase = `save-${kind}:assert-no-full-key-exposure`;
    await noFullKey(saved);
    subphase = `save-${kind}:dismiss-save-notice`;
    await button("关闭提示").click();
  }
  async function selectHub(kind, savedState, label) {
    subphase = `${label}:select-saved-provider`;
    await hub().provider.selectOption(ownIds.get(kind));
    subphase = `${label}:await-selected-catalog`;
    await poll(() => hub().model.isEnabled(), Boolean);
    const values = await hub()
      .model.locator("option")
      .evaluateAll((options) =>
        options.filter((option) => option.value).map((option) => option.value),
      );
    subphase = `${label}:assert-catalog-and-saved-default`;
    const selectedModel = await hub().model.inputValue();
    diagnosticContext = {
      providerFixture: kind.toUpperCase(),
      expectedSavedDefaultFixture: `${kind.toUpperCase()}1`,
      selectedDefaultFixture: models[kind].includes(selectedModel)
        ? `${kind.toUpperCase()}${models[kind].indexOf(selectedModel) + 1}`
        : "outside-owned-catalog",
      selectedCatalogCount: values.length,
      selectedCatalogIsExactOwnedSet:
        JSON.stringify([...values].sort()) ===
        JSON.stringify([...models[kind]].sort()),
      savedProviderCount: savedState.providers.length,
    };
    assert.deepEqual(
      values.sort(),
      [...models[kind]].sort(),
      "Selected provider catalog must contain exactly its own models",
    );
    assert.ok(
      selectedModel === models[kind][0],
      "Selecting a saved provider must restore its saved available default model",
    );
    subphase = `${label}:assert-provider-draft-and-key-masking`;
    assert.ok(
      (await hub().endpoint.inputValue()) === endpoints[kind],
      "Selected endpoint must match its saved provider",
    );
    assert.ok(
      (await hub().name.inputValue()) === names[kind],
      "Selecting a provider must discard its previous unsaved name draft",
    );
    assert.ok(
      (await hub().key.inputValue()) === "",
      "Selecting a saved provider must clear the Key draft",
    );
    assert.equal(await hub().key.getAttribute("type"), "password");
    // An explicit real UI refresh proves stored-key rediscovery even if the
    // initial selection can use the saved catalog instead of issuing HTTP.
    const previous = requests[kind];
    subphase = `${label}:click-real-stored-key-sync`;
    await button("同步模型").click();
    subphase = `${label}:await-real-stored-key-model-request`;
    await poll(
      async () => requests[kind] > previous && (await hub().model.isEnabled()),
      Boolean,
    );
    assert.deepEqual(
      (
        await hub()
          .model.locator("option")
          .evaluateAll((options) =>
            options
              .filter((option) => option.value)
              .map((option) => option.value),
          )
      ).sort(),
      [...models[kind]].sort(),
    );
    subphase = `${label}:assert-stored-key-and-state-separation`;
    assert.ok(
      (await hub().key.inputValue()) === "",
      "Stored-key rediscovery must keep the Key input blank",
    );
    assert.deepEqual(await assertProtected(), savedState);
    await noFullKey(savedState);
  }
  async function deferRestart() {
    const dialog = page.getByRole("dialog", {
      name: "重启 Codex 使配置生效",
      exact: true,
    });
    await dialog.waitFor({ timeout: 30000 });
    await dialog.getByRole("button", { name: "稍后重启", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
  }
  async function restoreUi() {
    await button("设置").click();
    await settings()
      .getByRole("button", { name: "恢复原配置", exact: true })
      .click();
    const confirm = page.getByRole("dialog", {
      name: "恢复原来的 API 配置？",
      exact: true,
    });
    await confirm
      .getByRole("button", { name: "恢复原配置", exact: true })
      .click();
    await confirm.waitFor({ state: "hidden" });
    await poll(
      async () => target(await overview()),
      (value) =>
        value.state === "unmanaged" &&
        value.activeProviderId === null &&
        !value.canRestore,
    );
    await deferRestart();
    if (await settings().isVisible())
      await settings()
        .getByRole("button", { name: "关闭弹窗", exact: true })
        .click();
    exactFiles(
      baselineFiles,
      await snapshot(await overview(), await hubOverview()),
    );
  }
  async function pruneCreatedDirectories() {
    if (!appliedFiles) return;
    const newDirectories = [...appliedFiles.directories]
      .filter(
        ([location, info]) =>
          info &&
          (!baselineFiles.directories.has(location) ||
            baselineFiles.directories.get(location) === null),
      )
      .sort(([left], [right]) => right.length - left.length);
    for (const [location, expected] of newDirectories) {
      const info = await ordinary(location, true);
      if (!info) continue;
      assert.ok(info.isDirectory() && sameIdentity(info, expected));
      assert.deepEqual(await fs.readdir(location), []);
      await fs.rmdir(location);
    }
  }
  async function assertFixture() {
    await assertRootIdentity();
    assert.ok(sameIdentity(await ordinary(fixture), fixtureIdentity));
    assert.ok(sameIdentity(await ordinary(markerFile), markerIdentity));
    assert.ok((await read(markerFile)).equals(markerBytes));
  }
  async function assertJunction() {
    await assertFixture();
    assert.ok(
      sameIdentity(await ordinary(junctionTarget), junctionTargetIdentity),
    );
    assert.ok(sameIdentity(await ordinary(probeFile), probeIdentity));
    assert.ok((await read(probeFile)).equals(probeBytes));
    // The deliberate link is checked separately and never passed to ordinary.
    const info = await fs.lstat(junction);
    assert.ok(info.isSymbolicLink() && sameIdentity(info, junctionIdentity));
    assert.ok(samePath(await fs.realpath(junction), junctionTarget));
    const linkTarget = await fs.readlink(junction);
    assert.ok(samePath(linkTarget.replace(/^\\\\\?\\/u, ""), junctionTarget));
  }

  try {
    assert.ok((await ordinary(data)).isDirectory());
    dataIdentity = identity(await ordinary(data));
    await assertRootIdentity();
    subphase = "capture-native-empty-baseline";
    baseline = await overview();
    baselineAgents = await hubOverview();
    validateNative(baseline, baselineAgents);
    assert.deepEqual(baseline.providers, []);
    for (const current of baseline.targets) {
      assert.equal(current.activeProviderId, null);
      assert.equal(current.canRestore, false);
      assert.equal(current.state, "unmanaged");
    }
    for (const agent of baselineAgents.agents) {
      assert.equal(agent.configured, false);
      assert.equal(agent.providerId, null);
    }
    subphase = "snapshot-existing-and-missing-client-paths";
    baselineFiles = await snapshot(baseline, baselineAgents);
    await hub().provider.waitFor();
    originalUi = {
      agentName: await page
        .locator('.hub-agent-nav button[aria-current="page"] img')
        .getAttribute("alt"),
      detailsOpen: await hub().details.evaluate((element) => element.open),
      storage: await page.evaluate(
        (selected) =>
          Object.fromEntries(
            selected.map((key) => [key, localStorage.getItem(key)]),
          ),
        storageKeys,
      ),
      theme: await page.evaluate(() => localStorage.getItem("ae-switch-theme")),
    };
    subphase = "assert-initial-empty-hub-draft";
    assert.ok(
      (await hub().provider.inputValue()) === "",
      "Initial Hub provider draft must be empty",
    );
    assert.ok(
      (await hub().endpoint.inputValue()) === "",
      "Initial Hub endpoint draft must be empty",
    );
    assert.ok(
      (await hub().key.inputValue()) === "",
      "Initial Hub Key draft must be empty",
    );
    assert.ok(
      (await hub().name.inputValue()) === "",
      "Initial Hub name draft must be empty",
    );
    await newDraft("initial-draft");
    const codexAgent = baselineAgents.agents.find(
      (agent) => agent.id === "codex",
    );
    await agentButton(codexAgent).click();
    assert.equal(
      await agentButton(codexAgent).getAttribute("aria-current"),
      "page",
    );
    for (const secret of Object.values(keys)) addSecret(secret);

    phase = "synthetic-fixture";
    subphase = "create-exclusive-owned-marker";
    await fs.mkdir(fixture);
    fixtureIdentity = identity(await ordinary(fixture));
    markerBytes = Buffer.from(
      JSON.stringify({
        purpose: "synthetic native configuration acceptance",
        token,
        rootId: (await validateSurfaceOwnedRoot(root)).id,
        createdAt: new Date().toISOString(),
      }) + "\n",
    );
    await fs.writeFile(markerFile, markerBytes, { flag: "wx" });
    markerIdentity = identity(await ordinary(markerFile));
    subphase = "create-loopback-catalog-server";
    server = createServer((request, response) => {
      const kind = ["a", "b"].find(
        (item) =>
          request.method === "GET" &&
          request.url === `/${item}/v1/models` &&
          request.headers.authorization === `Bearer ${keys[item]}`,
      );
      if (!kind) {
        requests.unsupported++;
        response.writeHead(404);
        response.end();
        return;
      }
      requests[kind]++;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          object: "list",
          data: models[kind].map((id) => ({
            id,
            object: "model",
            owned_by: "native-configuration-synthetic",
          })),
        }),
      );
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    assert.equal(server.address().address, "127.0.0.1");
    endpoints = Object.fromEntries(
      ["a", "b"].map((kind) => [
        kind,
        `http://127.0.0.1:${server.address().port}/${kind}/v1`,
      ]),
    );

    phase = "hub-provider-separation";
    await saveHub("a");
    await saveHub("b");
    subphase = "assert-two-native-providers-and-baseline";
    const savedState = await captureOwned();
    assert.equal(savedState.providers.length, 2);
    assert.equal(new Set(ownIds.values()).size, 2);
    assert.deepEqual(savedState.targets, baseline.targets);
    await assertProtected();
    await selectHub("a", savedState, "first-A");
    subphase = "first-A:enter-unsaved-name-key-and-model-drafts";
    await hub().model.selectOption(models.a[1]);
    await hub().name.fill(`${names.a} unsaved draft`);
    await hub().key.fill(keys.a);
    await selectHub("b", savedState, "select-B");
    subphase = "select-B:enter-unsaved-name-and-key-drafts";
    await hub().name.fill(`${names.b} unsaved draft`);
    await hub().key.fill(keys.b);
    await newDraft("select-new-after-B");
    subphase = "select-new-after-B:assert-no-native-write";
    assert.deepEqual(await assertProtected(), savedState);
    await selectHub("a", savedState, "return-A");
    subphase = "record-provider-separation-success";
    passedPhases.push(phase);
    await record("native-configuration-hub-provider-separation", {
      passed: true,
      sequence: ["A", "B", "new", "A"],
      actualUiSavesAndSelections: true,
      actualRustStoredKeyModelRequests: { a: requests.a, b: requests.b },
      distinctCatalogsAndDrafts: true,
      unsavedNameKeyAndModelDraftsDiscardedOnSelection: true,
      selectionDidNotWriteProviderTargetOrAgentState: true,
      newDraftEmptyAndActionsDisabled: true,
      storedKeyInputsBlankAndPassword: true,
      fullKeysAbsentFromPublicStateTextAndAttributes: true,
      syntheticSupplierOnly: true,
      realSupplierInferenceVerified: false,
      fullAcceptanceClaimed: false,
      screenshotsTaken: false,
    });

    phase = "active-provider-save-only";
    subphase = "navigate-advanced-and-select-codex";
    await page
      .locator(".hub-sidebar-bottom")
      .getByRole("button", {
        name: "高级供应商管理",
        exact: true,
      })
      .click();
    await page.getByRole("tab", { name: /^Codex\b/u }).click();
    subphase = "apply-owned-A-through-ui";
    await card(ownIds.get("a"))
      .getByRole("button", {
        name: "使用",
        exact: true,
      })
      .click();
    subphase = "await-native-applied-state-and-snapshot";
    const applied = await poll(
      overview,
      (value) =>
        target(value).activeProviderId === ownIds.get("a") &&
        target(value).state === "applied" &&
        target(value).canRestore,
    );
    appliedFiles = await snapshot(applied, await hubOverview());
    subphase = "defer-actual-codex-apply-restart-prompt";
    await deferRestart();
    assert.ok(Number.isSafeInteger(target(applied).configurationRevision));
    assert.equal(target(applied).appliedModel, models.a[0]);
    subphase = "enable-auto-sync-through-settings-ui";
    await button("设置").click();
    const autoSync = settings().getByRole("checkbox", {
      name: "保存供应商后，自动更新所有已使用它的客户端",
      exact: true,
    });
    if (!(await autoSync.isChecked())) await autoSync.click();
    assert.equal(await autoSync.isChecked(), true);
    await settings()
      .getByRole("button", { name: "关闭弹窗", exact: true })
      .click();
    await card(ownIds.get("a"))
      .getByRole("button", {
        name: `编辑 ${names.a}`,
        exact: true,
      })
      .click();
    subphase = "edit-active-A-and-change-default-model";
    const editor = page.getByRole("dialog", {
      name: "编辑供应商",
      exact: true,
    });
    assert.ok(
      (await editor.locator("#apiKey").inputValue()) === "",
      "Active editor must not echo the saved Key",
    );
    assert.equal(
      await editor.locator("#apiKey").getAttribute("type"),
      "password",
    );
    await poll(
      () => editor.locator(".model-selection").getAttribute("aria-busy"),
      (value) => value === "false",
    );
    const row = editor.locator(".model-choice").filter({
      has: page.getByRole("checkbox", {
        name: `启用 ${models.a[1]}`,
        exact: true,
      }),
    });
    await row
      .getByRole("button", {
        name: `将 ${models.a[1]} 设为默认模型`,
        exact: true,
      })
      .click();
    assert.equal(await row.locator(".model-default").count(), 1);
    const saveOnly = editor.getByRole("checkbox", {
      name: "只保存供应商，暂不用于当前客户端",
      exact: true,
    });
    assert.equal(await saveOnly.isChecked(), false);
    subphase = "check-explicit-save-only-and-submit-edit";
    await saveOnly.click();
    assert.equal(await saveOnly.isChecked(), true);
    await editor.getByRole("button", { name: "保存修改", exact: true }).click();
    await editor.waitFor({ state: "hidden", timeout: 45000 });
    subphase = "assert-provider-updated-without-client-write-or-revision";
    const savedOnly = await poll(
      overview,
      (value) =>
        value.providers.find((provider) => provider.id === ownIds.get("a"))
          ?.model === models.a[1],
    );
    const updated = assertOwnProvider(
      savedOnly.providers.find((provider) => provider.id === ownIds.get("a")),
      "a",
    );
    assert.equal(updated.model, models.a[1]);
    assert.deepEqual(
      savedOnly.providers.filter((provider) => provider.id !== updated.id),
      applied.providers.filter((provider) => provider.id !== updated.id),
    );
    const currentTarget = target(savedOnly);
    const beforeTarget = target(applied);
    for (const field of [
      "directory",
      "activeProviderId",
      "canRestore",
      "appliedModel",
      "configurationRevision",
    ])
      assert.deepEqual(currentTarget[field], beforeTarget[field]);
    assert.ok(["applied", "saved_changes"].includes(currentTarget.state));
    assert.deepEqual(
      savedOnly.targets.filter((item) => item.target !== "codex"),
      applied.targets.filter((item) => item.target !== "codex"),
    );
    await assertProtected(appliedFiles);
    await noFullKey(savedOnly);
    assert.equal(
      await page
        .getByRole("dialog", {
          name: "重启 Codex 使配置生效",
          exact: true,
        })
        .count(),
      0,
    );
    passedPhases.push(phase);
    await record("native-configuration-active-provider-save-only", {
      passed: true,
      actualUiAppliedThenEdited: true,
      activeProviderDefaultModelChanged: true,
      explicitSaveOnlyCheckboxChecked: true,
      autoSyncEnabledThroughUi: true,
      clientBytesAndConfigurationRevisionUnchanged: true,
      activeProviderDirectoryAndAppliedModelRetained: true,
      targetState: currentTarget.state,
      agentConfigurationsUnchanged: true,
      newRestartPromptAbsent: true,
      syntheticSupplierOnly: true,
      realSupplierInferenceVerified: false,
      fullAcceptanceClaimed: false,
    });
    subphase = "restore-owned-application-through-ui";
    await restoreUi();
    await pruneCreatedDirectories();
    await assertProtected();

    phase = "junction-directory-rejection";
    subphase = "create-identity-bound-owned-junction-and-probe";
    await assertFixture();
    await fs.mkdir(junctionTarget);
    junctionTargetIdentity = identity(await ordinary(junctionTarget));
    await fs.writeFile(probeFile, probeBytes, { flag: "wx" });
    probeIdentity = identity(await ordinary(probeFile));
    await fs.symlink(junctionTarget, junction, "junction");
    junctionIdentity = identity(await fs.lstat(junction));
    await assertJunction();
    subphase = "snapshot-before-junction-ui-submit";
    const beforeDirectory = await overview();
    const beforeAgents = await hubOverview();
    const beforeFiles = await snapshot(beforeDirectory, beforeAgents);
    await button("设置").click();
    await settings()
      .getByRole("button", { name: "修改目录", exact: true })
      .click();
    const directory = page.getByRole("dialog", {
      name: "设置配置位置",
      exact: true,
    });
    const input = directory.getByRole("textbox", {
      name: "配置目录",
      exact: true,
    });
    assert.ok(
      samePath(await input.inputValue(), target(beforeDirectory).directory),
    );
    subphase = "submit-owned-junction-through-settings-ui";
    await input.fill(junction);
    await directory
      .getByRole("button", { name: "保存目录", exact: true })
      .click();
    await directory.getByRole("alert").waitFor({ timeout: 30000 });
    await poll(() => input.isEnabled(), Boolean);
    assert.equal(await directory.isVisible(), true);
    subphase = "assert-ui-rejection-preserved-state-and-probe";
    assert.deepEqual(await overview(), beforeDirectory);
    assert.deepEqual((await hubOverview()).agents, beforeAgents.agents);
    exactFiles(
      beforeFiles,
      await snapshot(await overview(), await hubOverview()),
    );
    await assertJunction();
    await directory.getByRole("button", { name: "取消", exact: true }).click();
    await directory.waitFor({ state: "hidden" });
    await settings()
      .getByRole("button", { name: "关闭弹窗", exact: true })
      .click();
    // Independent Rust confirmation is reported separately from the UI alert.
    subphase = "independent-rust-portable-path-confirmation";
    const rejected = await invoke("set_directory", {
      target: "codex",
      directory: junction,
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error?.code, "portable_path");
    assert.deepEqual(await overview(), beforeDirectory);
    await assertProtected(beforeFiles);
    await assertJunction();
    await noFullKey(beforeDirectory);
    passedPhases.push(phase);
    await record("native-configuration-owned-junction-rejection", {
      passed: true,
      actualUiDirectorySubmitRejectedAndCancelled: true,
      uiAlertObserved: true,
      independentRustErrorCode: "portable_path",
      junctionAndTargetOwnedByCurrentGRoot: true,
      directoryProvidersTargetsAndAgentsUnchanged: true,
      clientAndJunctionProbeBytesUnchanged: true,
      hardlinkCaseIncluded: false,
      hardlinkRejectionClaimed: false,
      fullAcceptanceClaimed: false,
    });
  } catch (error) {
    failure = {
      phase,
      subphase,
      category: failureCategory(error),
      assertion: safeAssertionDiagnostic(error, Object.values(keys)),
      context: diagnosticContext,
      actualModelRequests: { a: requests.a, b: requests.b },
    };
  } finally {
    const attempt = async (category, task) => {
      try {
        await task();
      } catch (error) {
        cleanupErrors.push({
          category,
          failureCategory: failureCategory(error),
        });
      }
    };
    if (baseline)
      await attempt("native-owned-state", async () => {
        await assertRootIdentity();
        const current = await captureOwned();
        const codex = target(current);
        assert.ok(samePath(codex.directory, target(baseline).directory));
        if (codex.canRestore) {
          assert.equal(codex.activeProviderId, ownIds.get("a"));
          assert.ok(ownIds.has("a"));
          fallbackCleanup = true;
          await native("restore_original", { target: "codex" });
        }
        await pruneCreatedDirectories();
        await assertProtected();
        for (const [kind, id] of ownIds) {
          const latest = await overview();
          const provider = latest.providers.find((item) => item.id === id);
          if (!provider) continue;
          assertOwnProvider(provider, kind);
          assert.equal(
            latest.targets.some((item) => item.activeProviderId === id),
            false,
          );
          assert.equal(
            (await hubOverview()).agents.some(
              (agent) => agent.providerId === id,
            ),
            false,
          );
          await native("delete_provider", { providerId: id });
        }
      });
    if (server)
      await attempt("synthetic-server", async () => {
        server.closeAllConnections();
        await new Promise((resolve, reject) =>
          server.close((error) =>
            error && error.code !== "ERR_SERVER_NOT_RUNNING"
              ? reject(error)
              : resolve(),
          ),
        );
      });
    if (fixtureIdentity)
      await attempt("owned-fixture", async () => {
        await assertFixture();
        if (junctionIdentity) {
          await assertJunction();
          await fs.unlink(junction);
          assert.equal(await ordinary(junction, true), null);
        }
        if (probeIdentity) {
          assert.ok(sameIdentity(await ordinary(probeFile), probeIdentity));
          assert.ok((await read(probeFile)).equals(probeBytes));
          await fs.unlink(probeFile);
        }
        if (junctionTargetIdentity) {
          assert.ok(
            sameIdentity(
              await ordinary(junctionTarget),
              junctionTargetIdentity,
            ),
          );
          assert.deepEqual(await fs.readdir(junctionTarget), []);
          await fs.rmdir(junctionTarget);
        }
        assert.deepEqual((await fs.readdir(fixture)).sort(), [
          path.basename(markerFile),
        ]);
        await assertFixture();
        await fs.unlink(markerFile);
        assert.ok(sameIdentity(await ordinary(fixture), fixtureIdentity));
        assert.deepEqual(await fs.readdir(fixture), []);
        await fs.rmdir(fixture);
      });
    if (originalUi)
      await attempt("ui-and-preferences", async () => {
        for (const [name, close] of [
          ["重启 Codex 使配置生效", "稍后重启"],
          ["编辑供应商", "取消"],
          ["恢复原来的 API 配置？", "取消"],
          ["设置配置位置", "取消"],
          ["Codex 设置", "关闭弹窗"],
        ]) {
          const dialog = page.getByRole("dialog", { name, exact: true });
          if (await dialog.isVisible())
            await dialog
              .getByRole("button", { name: close, exact: true })
              .click();
        }
        const back = button("返回 Agent Hub");
        if (await back.isVisible()) await back.click();
        await hub().provider.waitFor();
        await button("刷新工作台").click();
        await poll(
          () => hub().provider.locator("option").count(),
          (count) => count === 1,
        );
        await newDraft();
        const originalAgent = baselineAgents.agents.find(
          (agent) => `${agent.name} 官方图标` === originalUi.agentName,
        );
        assert.ok(originalAgent);
        await agentButton(originalAgent).click();
        if (
          (await hub().details.evaluate((element) => element.open)) !==
          originalUi.detailsOpen
        )
          await hub().details.locator("summary").click();
        // Cleanup-only browser preference restoration; no acceptance evidence
        // is manufactured by this exact storage restoration.
        await page.evaluate((entries) => {
          for (const [key, value] of Object.entries(entries)) {
            if (value === null) localStorage.removeItem(key);
            else localStorage.setItem(key, value);
          }
        }, originalUi.storage);
        assert.deepEqual(
          await page.evaluate(
            (selected) =>
              Object.fromEntries(
                selected.map((key) => [key, localStorage.getItem(key)]),
              ),
            storageKeys,
          ),
          originalUi.storage,
        );
        assert.equal(
          await page.evaluate(() => localStorage.getItem("ae-switch-theme")),
          originalUi.theme,
        );
      });
    if (baselineFiles)
      await attempt("final-baseline", async () => {
        const final = await assertProtected();
        assert.deepEqual(final.providers, baseline.providers);
        for (const initial of baseline.targets) {
          const current = target(final, initial.target);
          for (const field of [
            "directory",
            "files",
            "activeProviderId",
            "state",
            "canRestore",
            "appliedModel",
          ])
            assert.deepEqual(current[field], initial[field]);
        }
        const finalFiles = await snapshot(final, await hubOverview());
        for (const [location, expected] of baselineFiles.directories)
          if (expected === null)
            assert.equal(finalFiles.directories.get(location), null);
          else assert.ok(sameIdentity(await ordinary(location), expected));
      });
    await record("native-configuration-extras-cleanup", {
      passed: cleanupErrors.length === 0,
      nativeCleanupOnly: true,
      uiAcceptanceClaimed: false,
      fallbackCleanup,
      taskOwnedProvidersAndFixtureRemoved: cleanupErrors.length === 0,
      originalClientBytesDirectoriesAndAgentConfigurationsRetained:
        cleanupErrors.length === 0,
      originalUiAndPreferencesReturned: cleanupErrors.length === 0,
      flowPassed: !failure && passedPhases.length === 3,
      passedPhases,
      failure: failure ?? null,
      cleanupErrors,
      syntheticSupplierOnly: true,
      realSupplierInferenceVerified: false,
      fullAcceptanceClaimed: false,
      hardlinkRejectionClaimed: false,
    });
  }
  if (failure || cleanupErrors.length)
    throw new Error(
      `Native configuration extras failed (${failure?.phase ?? "cleanup"}/${failure?.subphase ?? "owned-cleanup"}; ${failure?.category ?? "cleanup"})`,
    );
}
