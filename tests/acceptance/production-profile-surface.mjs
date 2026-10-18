import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { nativeSurfaceCommand } from "./production-ui-surface.mjs";
import { isNativeRequest } from "./production-ui-eight-contract.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) =>
  path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const sourceNames = [
  "config.yaml",
  "user-history.keep",
  "user-preferences.keep",
];
const manualFields = ["原配置目录", "原用户目录", "客户端启动文件", "工作目录"];
const savedDetails = ".hub-connection-panel > form > .hub-extra-settings";
export const PROFILE_SCOPE =
  "Production Hermes multi-directory selection and manual required fields with an owned localhost synthetic model catalog; no supplier, configuration or inference acceptance";
export const PROFILE_CHECKS = Object.freeze([
  "fresh owned Hermes fixture is copied without changing original files",
  "ordinary Rust discovery returns two owned directories without automatic selection",
  "real Rust localhost model discovery preserves the missing-profile gate",
  "explicit original and named directory selections enable confirmation",
  "each manual required field independently blocks confirmation",
  "automatic directory selection survives discovery retry",
]);

export function hermesProfileConfig(ownerId) {
  assert.match(ownerId, /^[a-f0-9]{32}$/u);
  return `# AE owned Hermes profile fixture ${ownerId}\nmodel: fixture-original\nuser_preference: keep-${ownerId}\n`;
}

export function ordinaryProfilePath(file, boundary, allowMissing = false) {
  assert.equal(typeof file, "string");
  assert.equal(typeof boundary, "string");
  const full = path.resolve(file),
    root = path.resolve(boundary);
  assert.match(root, /^[Gg]:\\/u, "Profile fixtures require the G workspace");
  assert.ok(
    same(full, root) ||
      full.toLowerCase().startsWith(root.toLowerCase() + path.sep),
    "Profile path escaped its exact boundary",
  );
  let missing = false;
  for (let cursor = full; ; cursor = path.dirname(cursor)) {
    try {
      const stat = fs.lstatSync(cursor);
      assert.equal(
        stat.isSymbolicLink(),
        false,
        "Profile path or ancestor is redirected",
      );
      assert.ok(
        stat.isDirectory() || (same(cursor, full) && stat.isFile()),
        "Profile path is not ordinary",
      );
      if (!same(cursor, full))
        assert.ok(stat.isDirectory(), "Profile ancestor is not a directory");
      assert.ok(
        same(fs.realpathSync.native(cursor), cursor),
        "Profile path real identity differs",
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      assert.ok(allowMissing, "Existing profile proof path is missing");
      missing = true;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
  }
  if (missing) assert.ok(allowMissing);
  return full;
}

function regularFile(file, boundary) {
  const full = ordinaryProfilePath(file, boundary);
  const stat = fs.lstatSync(full);
  assert.ok(stat.isFile(), "A regular owned profile file is required");
  assert.equal(stat.nlink, 1, "Shared hard-linked profile files are refused");
  assert.ok(stat.size <= 65536, "Synthetic profile file exceeds its bound");
  return full;
}

function treeSnapshot(
  root,
  exclude,
  ignoreEmptyProfiles = false,
  copied = false,
) {
  const result = [],
    pending = [ordinaryProfilePath(root, root)];
  let count = 0;
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(ordinaryProfilePath(directory, root))) {
      assert.ok(++count <= 128, "Synthetic profile tree exceeds its bound");
      const file = path.join(directory, entry);
      if (exclude && same(file, exclude)) continue;
      ordinaryProfilePath(file, root);
      const stat = fs.lstatSync(file);
      const relative = path.relative(root, file).replaceAll("\\", "/");
      if (stat.isDirectory()) {
        assert.ok(
          !copied && relative === "profiles",
          "Synthetic profile contains an unexpected directory",
        );
        if (!(ignoreEmptyProfiles && relative === "profiles"))
          result.push({ path: relative, kind: "directory" });
        pending.push(file);
      } else {
        assert.ok(
          sourceNames.includes(relative) ||
            (copied && relative === ".ae-production-profile-copy.json"),
          "Unknown profile files are refused before reading their contents",
        );
        regularFile(file, root);
        result.push({
          path: relative,
          kind: "file",
          bytes: stat.size,
          sha256: sha(fs.readFileSync(file)),
        });
      }
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

// Only the prelaunch known synthetic A fixture may be read and copied. The caller
// owns preparation/build receipts, retained process handles and final tree removal.
export function prepareProductionProfileFixture({ setup, launch }) {
  assert.equal(setup.schemaVersion, 2);
  assert.match(setup.ownerId, /^[a-f0-9]{32}$/u);
  for (const field of ["sourceDigest", "productionSha256"])
    assert.match(setup[field], /^[a-f0-9]{64}$/u);
  assert.match(setup.buildAuditId, /^[a-f0-9]{32}$/u);
  const workspace = path.resolve(setup.workspace);
  const root = path.resolve(setup.root);
  assert.ok(
    same(
      root,
      path.join(workspace, ".cache/native-e2e-sandbox", setup.ownerId),
    ),
    "Exact production owner root required",
  );
  ordinaryProfilePath(root, workspace);
  const marker = regularFile(
    path.join(root, ".ae-production-ui-eight-owner.json"),
    root,
  );
  const markerSha256 = sha(fs.readFileSync(marker));
  const owner = JSON.parse(fs.readFileSync(marker, "utf8"));
  assert.equal(owner.schemaVersion, 2);
  assert.ok(same(owner.workspace, workspace));
  for (const field of [
    "ownerId",
    "sourceDigest",
    "buildAuditId",
    "productionSha256",
  ])
    assert.equal(owner[field], setup[field]);
  for (const record of [setup, launch]) {
    assert.equal(record.qaHooksUsed, false);
    assert.equal(record.discoveryContextInjected, false);
  }
  assert.equal(launch.ownerId, setup.ownerId);
  assert.equal(launch.productionSha256, setup.productionSha256);
  assert.equal(launch.retainedHandleValidated, true);
  assert.equal(launch.cdpListener?.retainedDescendantValidated, true);
  assert.ok(Number.isSafeInteger(launch.pid) && launch.pid > 0);
  assert.ok(Number.isFinite(Date.parse(launch.startedAt)));
  assert.ok(same(launch.productionProgram, setup.productionProgram));
  assert.ok(
    same(
      launch.ordinaryDiscoveryCwd,
      path.join(root, "installed-clients/workspace"),
    ),
  );
  assert.ok(same(setup.portableRoot, path.join(root, "portable")));
  const program = ordinaryProfilePath(setup.productionProgram, root);
  assert.ok(same(program, path.join(setup.portableRoot, "AE-Switch.exe")));
  assert.equal(sha(fs.readFileSync(program)), setup.productionSha256);
  const bindings = ["setup.json", "production-launch-receipt.json"].map(
    (name) => {
      const file = regularFile(path.join(root, name), root);
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(record.ownerId, setup.ownerId);
      assert.equal(record.productionSha256, setup.productionSha256);
      if (name === "setup.json") assert.ok(same(record.root, root));
      else assert.equal(record.pid, launch.pid);
      return { file, sha256: sha(fs.readFileSync(file)) };
    },
  );
  const profile = setup.fixtures.payload.profiles.hermes;
  const original = ordinaryProfilePath(profile.directory, root);
  assert.ok(
    same(original, path.join(root, "installed-clients/home/.hermes")),
    "Known original Hermes fixture required",
  );
  assert.ok(same(setup.fixtures.environment.HERMES_HOME, original));
  assert.ok(
    same(profile.homeDirectory, path.join(root, "installed-clients/home")),
  );
  assert.ok(same(profile.workspaceDirectory, launch.ordinaryDiscoveryCwd));
  regularFile(profile.executablePath, root);
  assert.ok(
    same(
      profile.executablePath,
      path.join(root, "installed-clients/bin/hermes.ps1"),
    ),
  );
  const named = ordinaryProfilePath(
    path.join(original, "profiles/work"),
    root,
    true,
  );
  assert.equal(
    fs.existsSync(named),
    false,
    "Named profile must be newly owned, never overwritten",
  );
  const parent = path.dirname(named),
    parentExisted = fs.existsSync(parent);
  if (parentExisted)
    assert.deepEqual(
      fs.readdirSync(ordinaryProfilePath(parent, root)),
      [],
      "No other Hermes named profiles may exist",
    );
  const before = treeSnapshot(original);
  assert.deepEqual(
    before
      .filter((row) => row.kind === "file")
      .map((row) => row.path)
      .sort(),
    [...sourceNames].sort(),
    "Original fixture may contain only the three bound synthetic files",
  );
  assert.ok(
    before
      .filter((row) => row.kind === "directory")
      .every((row) => row.path === "profiles"),
    "Original fixture contains an unexpected directory",
  );
  for (const name of sourceNames) {
    const file = regularFile(path.join(original, name), root);
    const expected = setup.fixtures.payload.preservedFiles.filter((row) =>
      same(row.path, file),
    );
    assert.equal(
      expected.length,
      1,
      "Every copied source file requires a unique prelaunch SHA binding",
    );
    assert.equal(
      sha(fs.readFileSync(file)),
      expected[0].sha256,
      "Original fixture bytes differ from preparation",
    );
  }
  assert.equal(
    fs.readFileSync(path.join(original, "config.yaml"), "utf8"),
    hermesProfileConfig(setup.ownerId),
    "Only the canonical secret-free Hermes config fixture is allowed",
  );
  const assertOwner = () => {
    ordinaryProfilePath(root, workspace);
    assert.equal(sha(fs.readFileSync(regularFile(marker, root))), markerSha256);
    for (const binding of bindings)
      assert.equal(
        sha(fs.readFileSync(regularFile(binding.file, root))),
        binding.sha256,
      );
    assert.equal(
      sha(fs.readFileSync(ordinaryProfilePath(program, root))),
      setup.productionSha256,
    );
  };
  assertOwner();
  if (!parentExisted) fs.mkdirSync(ordinaryProfilePath(parent, root, true));
  assertOwner();
  assert.equal(fs.existsSync(named), false);
  fs.mkdirSync(ordinaryProfilePath(named, root, true));
  const copyMarker = path.join(named, ".ae-production-profile-copy.json");
  fs.writeFileSync(
    copyMarker,
    JSON.stringify({
      schemaVersion: 1,
      ownerId: setup.ownerId,
      workspace,
      originalDirectory: original,
      namedDirectory: named,
      purpose: "Synthetic Hermes profile selection only",
    }) + "\n",
    { flag: "wx" },
  );
  for (const name of sourceNames) {
    assertOwner();
    const source = regularFile(path.join(original, name), root);
    const destination = ordinaryProfilePath(
      path.join(named, name),
      named,
      true,
    );
    const expected = before.find((row) => row.path === name).sha256;
    assert.equal(sha(fs.readFileSync(source)), expected);
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    assert.equal(
      sha(fs.readFileSync(regularFile(destination, named))),
      expected,
    );
  }
  const copied = treeSnapshot(named, null, false, true);
  const assertUnchanged = () => {
    assertOwner();
    assert.deepEqual(
      treeSnapshot(original, named, !parentExisted),
      before,
      "Original Hermes config/history/preferences changed",
    );
    assert.deepEqual(
      treeSnapshot(named, null, false, true),
      copied,
      "Owned named profile copy changed",
    );
  };
  assertUnchanged();
  return {
    original,
    named,
    profile,
    assertUnchanged,
    receipt: {
      originalDirectory: original,
      namedDirectory: named,
      originalFiles: before,
      copiedFiles: copied,
      markerSha256,
      setupSha256: bindings[0].sha256,
      launchSha256: bindings[1].sha256,
      originalFilesUnchanged: true,
      copiedFilesUnchanged: true,
      namedProfileRetainedForSupervisorCleanup: true,
    },
  };
}

export async function startProfileCatalog(ownerId) {
  assert.match(ownerId, /^[a-f0-9]{32}$/u);
  const key = "ae-profile-synthetic-" + randomBytes(16).toString("hex");
  const sockets = new Set();
  const record = {
    scope:
      "Owned localhost synthetic catalog; no upstream supplier or inference",
    boundHost: "127.0.0.1",
    model: "gpt-5.4",
    requests: 0,
    rejectedRequests: 0,
    authenticatedRequests: 0,
    closed: false,
  };
  const server = http.createServer((request, response) => {
    record.requests++;
    const authorized =
      request.headers.authorization === "Bearer " + key ||
      request.headers["x-api-key"] === key;
    if (
      request.method !== "GET" ||
      request.url !== "/v1/models" ||
      !authorized
    ) {
      record.rejectedRequests++;
      response.writeHead(authorized ? 404 : 401, {
        "Content-Type": "application/json",
        Connection: "close",
      });
      response.end('{"error":"synthetic_fixture_request_rejected"}');
      return;
    }
    record.authenticatedRequests++;
    response.writeHead(200, {
      "Content-Type": "application/json",
      Connection: "close",
    });
    response.end(
      JSON.stringify({
        object: "list",
        data: [{ object: "model", id: record.model, context_window: 128000 }],
      }),
    );
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  const close = async () => {
    if (record.closed) return;
    const stopped = new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    for (const socket of sockets) socket.destroy();
    await stopped;
    record.closed = true;
  };
  return { endpoint: `http://127.0.0.1:${port}/v1`, key, record, close };
}

const allowedCommands = new Set([
  "get_overview",
  "agent_hub_overview",
  "agent_hub_discover",
  "discover_provider_connection",
  "plugin:event|listen",
  "plugin:event|unlisten",
]);
export function assertProfileCommands(commands) {
  assert.ok(Array.isArray(commands));
  for (const command of commands)
    assert.ok(
      allowedCommands.has(command),
      "Profile surface observed a mutating or external command",
    );
}

export function assertProfileDiscovery(discovery, fixture) {
  assert.equal(discovery.limited, false);
  const clients = discovery.clients.filter((row) => row.agentId === "hermes");
  assert.ok(clients.length > 0);
  const profiles = [
    ...new Map(
      clients
        .flatMap((row) => row.profiles)
        .map((profile) => [JSON.stringify(profile), profile]),
    ).values(),
  ];
  assert.equal(
    profiles.length,
    2,
    "Exactly the two owned Hermes profiles must be discovered",
  );
  for (const directory of [fixture.original, fixture.named]) {
    const matching = profiles.filter((profile) =>
      same(profile.directory, directory),
    );
    assert.equal(matching.length, 1);
    for (const key of ["homeDirectory", "executablePath", "workspaceDirectory"])
      assert.ok(same(matching[0][key], fixture.profile[key]));
  }
  return profiles;
}

export function assertProfileReceipt(receipt) {
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.scope, PROFILE_SCOPE);
  assert.match(receipt.ownerId, /^[a-f0-9]{32}$/u);
  for (const field of [
    "complete",
    "fullAcceptancePassed",
    "credentialsRead",
    "upstreamSupplierVerified",
    "inferenceExecuted",
    "configurationApplied",
    "officialClientsLaunched",
    "qaHooksUsed",
    "applicationInvokeReplaced",
  ])
    assert.equal(receipt[field], false);
  for (const field of [
    "passed",
    "productionNativeIpc",
    "nativeStateUnchanged",
    "nativeStoreUnchanged",
    "pageRestored",
    "originalFilesUnchanged",
    "fixtureOriginalsUnchanged",
    "copiedFilesUnchanged",
    "serverClosed",
  ])
    assert.equal(receipt[field], true);
  assert.deepEqual(
    receipt.checks.map((row) => row.name).sort(),
    [...PROFILE_CHECKS].sort(),
  );
  assert.ok(receipt.checks.every((row) => row.status === "passed"));
  assertProfileCommands(receipt.observedNativeCommands);
  for (const command of ["agent_hub_discover", "discover_provider_connection"])
    assert.ok(receipt.observedNativeCommands.includes(command));
  assert.equal(receipt.catalog.boundHost, "127.0.0.1");
  assert.equal(receipt.catalog.closed, true);
  assert.ok(receipt.catalog.authenticatedRequests >= 1);
  assert.equal(receipt.catalog.rejectedRequests, 0);
  assert.equal(receipt.profileCount, 2);
  assert.equal(receipt.discoveryRetries, 2);
  assert.equal(receipt.modelDiscoveryNativeResponses, 1);
  assert.deepEqual(receipt.manualRequiredFields, manualFields);
  assert.equal(receipt.nativeStateBeforeSha256, receipt.nativeStateAfterSha256);
  assert.match(receipt.nativeStateBeforeSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(receipt.pageErrors, []);
}

async function poll(read, matches, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (matches(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Profile surface timed out: " + label);
}

async function publicPageState(page) {
  return page.evaluate(() => ({
    agent: document
      .querySelector('.hub-agent-item[aria-current="page"] img')
      ?.alt?.replace(/ 官方图标$/, ""),
    provider: document.getElementById("hub-provider")?.value || "",
    endpoint: document.getElementById("hub-endpoint")?.value || "",
    name: document.querySelector('input[aria-label="供应商名称"]')?.value || "",
    model: document.getElementById("hub-model")?.value || "",
    profile: document.getElementById("hub-installed-profile")?.value || "",
    keyEmpty: document.getElementById("hub-api-key")?.value === "",
    keyMasked: document.getElementById("hub-api-key")?.type === "password",
    manual: !!document.querySelector(".hub-manual-profile"),
    panels: [
      ...document.querySelectorAll(
        ".hub-connection-panel > form > .hub-extra-settings, .hub-profile-settings, .hub-client-actions",
      ),
    ].map((element) => ({ className: element.className, open: element.open })),
  }));
}

export async function verifyProductionProfiles({
  page,
  setup,
  launch,
  readonlyNative,
}) {
  assert.equal(typeof readonlyNative, "function");
  const receipt = {
    schemaVersion: 1,
    ownerId: setup.ownerId,
    scope: PROFILE_SCOPE,
    startedAt: new Date().toISOString(),
    passed: false,
    complete: false,
    fullAcceptancePassed: false,
    credentialsRead: false,
    upstreamSupplierVerified: false,
    inferenceExecuted: false,
    configurationApplied: false,
    officialClientsLaunched: false,
    qaHooksUsed: false,
    applicationInvokeReplaced: false,
    productionNativeIpc: false,
    checks: [],
    observedNativeCommands: [],
    pageErrors: [],
    manualRequiredFields: [],
    discoveryRetries: 0,
    modelDiscoveryNativeResponses: 0,
    unvalidated: [
      {
        name: "Configuration, official-client write/read and upstream inference",
        reason:
          "This lane changes only an unsaved GUI draft and a fresh owned profile copy.",
      },
    ],
  };
  let initial,
    fixture,
    catalog,
    baseline,
    failure,
    actions = false,
    hermesOriginalSelection = "",
    manualValues;
  let active = "fresh profile prerequisites",
    requestFailure = false;
  const onRequest = (request) => {
    const command = nativeSurfaceCommand(request);
    if (command) {
      receipt.observedNativeCommands.push(command);
      if (!allowedCommands.has(command)) requestFailure = true;
    }
  };
  const onError = (error) =>
    receipt.pageErrors.push({
      name: error.name || "Error",
      message: "Production page error; raw values omitted",
    });
  page.on("request", onRequest);
  page.on("pageerror", onError);
  const button = (name) => page.getByRole("button", { name, exact: true });
  const selectAgent = async (name) => {
    await page
      .getByRole("navigation", { name: "选择 Agent", exact: true })
      .getByRole("button")
      .filter({
        has: page.getByRole("img", { name: name + " 官方图标", exact: true }),
      })
      .click();
    await page.getByRole("heading", { name, exact: true }).waitFor();
  };
  const details = async (selector, open) => {
    const locator = page.locator(selector);
    if (((await locator.getAttribute("open")) !== null) !== open)
      await locator.locator(":scope > summary").click();
  };
  const check = async (name, action) => {
    active = name;
    await action();
    assert.equal(requestFailure, false);
    receipt.checks.push({ name, status: "passed" });
  };
  const state = async () => {
    const overview = await readonlyNative("get_overview"),
      hub = await readonlyNative("agent_hub_overview");
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
  const retryDiscovery = async () => {
    await details(".hub-profile-settings", true);
    const responsePromise = page.waitForResponse(
      (response) => isNativeRequest(response.request(), "agent_hub_discover"),
      { timeout: 30000 },
    );
    responsePromise.catch(() => {});
    await button("重新探测工具").click();
    const response = await responsePromise;
    assert.equal(await response.headerValue("Tauri-Response"), "ok");
    receipt.discoveryRetries++;
    const result = await response.json();
    return assertProfileDiscovery(result, fixture);
  };
  try {
    baseline = await state();
    assert.deepEqual(
      baseline.providers,
      [],
      "Profile lane requires a fresh provider store",
    );
    assert.ok(
      baseline.selections.every((row) => !row.configured),
      "Profile lane requires unconfigured agents",
    );
    await poll(
      () => page.locator("#hub-installed-profile").isEnabled(),
      Boolean,
      "initial ordinary discovery readiness",
    );
    initial = await publicPageState(page);
    for (const key of ["provider", "endpoint", "name", "model"])
      assert.equal(
        initial[key],
        "",
        "Profile lane requires an empty connection draft",
      );
    assert.equal(initial.keyEmpty, true);
    assert.equal(initial.keyMasked, true);
    assert.equal(initial.manual, false);
    assert.ok(initial.agent);
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(await page.locator(".hub-help").count(), 0);
    assert.equal(
      await page.evaluate(
        () => typeof window.__TAURI_INTERNALS__?.invoke === "function",
      ),
      true,
    );
    receipt.productionNativeIpc = true;
    await check(PROFILE_CHECKS[0], async () => {
      fixture = prepareProductionProfileFixture({ setup, launch });
      receipt.fixture = fixture.receipt;
    });
    actions = true;
    await selectAgent("Hermes Agent");
    await check(PROFILE_CHECKS[1], async () => {
      const profiles = await retryDiscovery();
      receipt.profileCount = profiles.length;
      await poll(
        () => page.locator("#hub-installed-profile").inputValue(),
        (value) => value === "",
        "ambiguous selection",
      );
      hermesOriginalSelection = "";
      assert.notEqual(
        await page.locator(".hub-profile-settings").getAttribute("open"),
        null,
      );
      assert.ok(
        (await page.locator(".hub-profile-settings").innerText()).includes(
          "有多个配置候选，请明确选择要使用的目录",
        ),
      );
      assert.equal(await button("确认连接").isDisabled(), true);
    });
    await check(PROFILE_CHECKS[2], async () => {
      catalog = await startProfileCatalog(setup.ownerId);
      const responsePromise = page.waitForResponse(
        (response) =>
          isNativeRequest(response.request(), "discover_provider_connection"),
        { timeout: 30000 },
      );
      responsePromise.catch(() => {});
      await page.locator("#hub-endpoint").fill(catalog.endpoint);
      await page.locator("#hub-api-key").fill(catalog.key);
      const response = await responsePromise;
      assert.equal(await response.headerValue("Tauri-Response"), "ok");
      const result = await response.json();
      assert.ok(result.models.some((row) => row.id === catalog.record.model));
      assert.ok(result.syncedAt > 0);
      receipt.modelDiscoveryNativeResponses++;
      await poll(
        () => page.locator("#hub-model").inputValue(),
        (model) => model === catalog.record.model,
        "local model selected",
      );
      assert.equal(
        await page.locator("#hub-installed-profile").inputValue(),
        "",
      );
      assert.equal(await button("仅保存").isEnabled(), true);
      assert.equal(await button("确认连接").isDisabled(), true);
    });
    const choose = async (directory) => {
      const choices = await page
        .locator("#hub-installed-profile option")
        .evaluateAll((options) =>
          options.map((option) => option.value).filter(Boolean),
        );
      const matching = choices.filter((value) =>
        same(JSON.parse(value).directory, directory),
      );
      assert.equal(matching.length, 1);
      await page.locator("#hub-installed-profile").selectOption(matching[0]);
      assert.ok(
        same(
          JSON.parse(await page.locator("#hub-installed-profile").inputValue())
            .directory,
          directory,
        ),
      );
      await poll(
        () => button("确认连接").isEnabled(),
        Boolean,
        "explicit profile confirmation",
      );
    };
    await check(PROFILE_CHECKS[3], async () => {
      await choose(fixture.original);
      await choose(fixture.named);
    });
    await check(PROFILE_CHECKS[4], async () => {
      await button("手动指定已有客户端").click();
      manualValues = await Promise.all(
        manualFields.map((label) =>
          page.getByLabel(label, { exact: true }).inputValue(),
        ),
      );
      assert.ok(same(manualValues[0], fixture.named));
      assert.ok(manualValues.every((value) => value.trim()));
      for (let index = 0; index < manualFields.length; index++) {
        const input = page.getByLabel(manualFields[index], { exact: true });
        await input.fill("");
        assert.equal(await button("确认连接").isDisabled(), true);
        assert.equal(await button("仅保存").isEnabled(), true);
        await input.fill("   ");
        assert.equal(await button("确认连接").isDisabled(), true);
        await input.fill(manualValues[index]);
        await poll(
          () => button("确认连接").isEnabled(),
          Boolean,
          "required field restored",
        );
        receipt.manualRequiredFields.push(manualFields[index]);
      }
      await button("使用自动探测结果").click();
      assert.ok(
        same(
          JSON.parse(await page.locator("#hub-installed-profile").inputValue())
            .directory,
          fixture.named,
        ),
      );
    });
    await check(PROFILE_CHECKS[5], async () => {
      await retryDiscovery();
      await poll(
        () => button("确认连接").isEnabled(),
        Boolean,
        "profile retained after rediscovery",
      );
      assert.ok(
        same(
          JSON.parse(await page.locator("#hub-installed-profile").inputValue())
            .directory,
          fixture.named,
        ),
      );
      fixture.assertUnchanged();
    });
  } catch (error) {
    failure = error;
    receipt.failure = {
      check: active,
      errorName: error?.name || "Error",
      message:
        "Production profile check failed; raw inputs and private values omitted",
    };
  } finally {
    try {
      if (actions && initial) {
        await page.locator("#hub-api-key").fill("");
        await page.locator("#hub-endpoint").fill("");
        await selectAgent("Hermes Agent");
        if (await button("使用自动探测结果").count()) {
          if (manualValues)
            for (let index = 0; index < manualFields.length; index++)
              await page
                .getByLabel(manualFields[index], { exact: true })
                .fill(manualValues[index]);
          await button("使用自动探测结果").click();
        }
        await page
          .locator("#hub-installed-profile")
          .selectOption(hermesOriginalSelection);
        await selectAgent(initial.agent);
        if (initial.agent === "Hermes Agent" && initial.profile)
          await page
            .locator("#hub-installed-profile")
            .selectOption(initial.profile);
        await details(savedDetails, true);
        await page.locator("#hub-provider").selectOption(initial.provider);
        await page.getByLabel("供应商名称", { exact: true }).fill(initial.name);
        for (const panel of initial.panels)
          await details(
            panel.className === "hub-extra-settings"
              ? savedDetails
              : "." + panel.className,
            panel.open,
          );
        await poll(
          () => publicPageState(page),
          (value) => JSON.stringify(value) === JSON.stringify(initial),
          "public page restoration",
        );
      }
      receipt.pageRestored = true;
    } catch (error) {
      receipt.pageRestored = false;
      receipt.restorationFailure =
        "Public page restoration failed; raw values omitted";
      failure ??= error;
    }
    try {
      if (catalog) {
        await catalog.close();
        receipt.catalog = { ...catalog.record };
      }
      receipt.serverClosed = !catalog || catalog.record.closed;
    } catch (error) {
      receipt.serverClosed = false;
      failure ??= error;
    }
    try {
      if (fixture) {
        fixture.assertUnchanged();
        receipt.originalFilesUnchanged = true;
        receipt.fixtureOriginalsUnchanged = true;
        receipt.copiedFilesUnchanged = true;
      }
      if (baseline) {
        const after = await state();
        receipt.nativeStateBeforeSha256 = sha(JSON.stringify(baseline));
        receipt.nativeStateAfterSha256 = sha(JSON.stringify(after));
        assert.deepEqual(
          after,
          baseline,
          "Native provider or agent configuration changed",
        );
        receipt.nativeStateUnchanged = true;
        receipt.nativeStoreUnchanged = true;
      }
      assertProfileCommands(receipt.observedNativeCommands);
      assert.deepEqual(receipt.pageErrors, []);
    } catch (error) {
      receipt.preservationFailure =
        "Original fixture or native state preservation failed";
      failure ??= error;
    }
    page.off("request", onRequest);
    page.off("pageerror", onError);
    receipt.finishedAt = new Date().toISOString();
  }
  receipt.passed = !failure;
  if (!failure) {
    try {
      assertProfileReceipt(receipt);
    } catch (error) {
      failure = error;
      receipt.passed = false;
      receipt.failure = {
        check: "final profile receipt contract",
        errorName: error.name,
        message: "Profile receipt contract failed",
      };
    }
  }
  if (failure) {
    const error = new Error(
      "Production profile surface failed; inspect its structured receipt",
    );
    error.profileReceipt = receipt;
    throw error;
  }
  return receipt;
}
