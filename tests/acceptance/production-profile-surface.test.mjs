import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import {
  PROFILE_CHECKS,
  PROFILE_SCOPE,
  assertProfileCommands,
  assertProfileDiscovery,
  assertProfileReceipt,
  hermesProfileConfig,
  ordinaryProfilePath,
  prepareProductionProfileFixture,
  startProfileCatalog,
  verifyProductionProfiles,
} from "./production-profile-surface.mjs";

const workspace = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const cases = new Map();
const links = new Set();
const json = (file, record) =>
  fs.writeFileSync(file, JSON.stringify(record) + "\n");

test("profile retry opens a collapsed location panel before strict two-profile discovery", async () => {
  const fixture = newFixture();
  const profile = fixture.setup.fixtures.payload.profiles.hermes;
  const panels = new Map([
    [".hub-profile-settings", false],
    [".hub-connection-panel > form > .hub-extra-settings", false],
  ]);
  const interactions = [];
  let responseReady;
  let responseWaits = 0;
  const response = {
    request: () => ({
      url: () => "http://ipc.localhost/agent_hub_discover",
      method: () => "POST",
    }),
    headerValue: async () => "ok",
    json: async () => ({
      limited: false,
      clients: [{
        agentId: "hermes",
        profiles: [profile, { ...profile, directory: fixture.named }],
      }],
    }),
  };
  const page = {
    on() {},
    off() {},
    async evaluate(read) {
      if (String(read).includes("typeof window.__TAURI_INTERNALS__")) return true;
      return {
        agent: "Hermes Agent", provider: "", endpoint: "", name: "",
        model: "", profile: "", keyEmpty: true, keyMasked: true, manual: false,
        panels: [...panels].map(([selector, open]) => ({
          className: selector.includes("hub-extra-settings")
            ? "hub-extra-settings" : "hub-profile-settings",
          open,
        })),
      };
    },
    locator(selector) {
      return {
        isEnabled: async () => true,
        inputValue: async () => "",
        selectOption: async () => {},
        fill: async () => {},
        count: async () => 0,
        innerText: async () => "有多个配置候选，请明确选择要使用的目录",
        getAttribute: async () => panels.get(selector) ? "" : null,
        locator(summary) {
          assert.equal(summary, ":scope > summary");
          return { click: async () => {
            panels.set(selector, !panels.get(selector));
            if (selector === ".hub-profile-settings") interactions.push("profile-summary");
          } };
        },
      };
    },
    getByLabel: () => ({ fill: async () => {} }),
    getByRole(role, options) {
      if (role === "navigation") return {
        getByRole: () => ({ filter: () => ({ click: async () => {} }) }),
      };
      return {
        waitFor: async () => {},
        count: async () => 0,
        isDisabled: async () => true,
        click: async () => {
          assert.equal(options.name, "重新探测工具");
          if (!panels.get(".hub-profile-settings")) throw Object.assign(
            new Error("Retry button is hidden inside collapsed details"),
            { name: "TimeoutError" },
          );
          interactions.push("retry");
          assert.equal(panels.get(".hub-profile-settings"), true);
          responseReady(response);
        },
      };
    },
    waitForResponse(predicate) {
      if (++responseWaits > 1) throw Object.assign(
        new Error("Stop after the strict discovery check; no catalog request is sent"),
        { name: "RegressionStop" },
      );
      assert.equal(predicate(response), true);
      return new Promise((resolve) => { responseReady = resolve; });
    },
  };
  await assert.rejects(
    verifyProductionProfiles({
      page, setup: fixture.setup, launch: fixture.launch,
      readonlyNative: async (command) => command === "get_overview"
        ? { providers: [] } : { agents: [] },
    }),
    (error) => {
      const receipt = error.profileReceipt;
      assert.deepEqual(receipt.checks.map((check) => check.name), PROFILE_CHECKS.slice(0, 2));
      assert.equal(receipt.profileCount, 2);
      assert.equal(receipt.discoveryRetries, 1);
      assert.equal(receipt.failure.errorName, "RegressionStop");
      assert.equal(receipt.pageRestored, true);
      assert.equal(receipt.fixtureOriginalsUnchanged, true);
      assert.equal(receipt.copiedFilesUnchanged, true);
      assert.equal(receipt.nativeStoreUnchanged, true);
      assert.equal(receipt.serverClosed, true);
      assert.deepEqual(interactions.slice(0, 2), ["profile-summary", "retry"]);
      return true;
    },
  );
});

function newFixture() {
  const id = randomUUID().replaceAll("-", "");
  const root = path.join(workspace, ".cache/native-e2e-sandbox", id);
  ordinaryProfilePath(root, workspace, true);
  assert.equal(fs.existsSync(root), false);
  const original = path.join(root, "installed-clients/home/.hermes");
  const bin = path.join(root, "installed-clients/bin");
  const cwd = path.join(root, "installed-clients/workspace");
  const portableRoot = path.join(root, "portable");
  for (const directory of [original, bin, cwd, portableRoot])
    fs.mkdirSync(directory, { recursive: true });
  const productionProgram = path.join(portableRoot, "AE-Switch.exe");
  fs.writeFileSync(
    productionProgram,
    "Synthetic byte fixture only; never execute.",
  );
  const productionSha256 = sha(fs.readFileSync(productionProgram));
  const executablePath = path.join(bin, "hermes.ps1");
  fs.writeFileSync(
    executablePath,
    "# Synthetic entry fixture; never execute.\n",
  );
  for (const [name, content] of Object.entries({
    "config.yaml": hermesProfileConfig(id),
    "user-history.keep": "Owned synthetic history " + id,
    "user-preferences.keep": "Owned synthetic preference " + id,
  }))
    fs.writeFileSync(path.join(original, name), content);
  const profile = {
    directory: original,
    homeDirectory: path.dirname(original),
    executablePath,
    workspaceDirectory: cwd,
  };
  const setup = {
    schemaVersion: 2,
    ownerId: id,
    workspace,
    root,
    portableRoot,
    productionProgram,
    productionSha256,
    sourceDigest: "a".repeat(64),
    buildAuditId: "b".repeat(32),
    qaHooksUsed: false,
    discoveryContextInjected: false,
    fixtures: {
      environment: { HERMES_HOME: original },
      payload: {
        profiles: { hermes: profile },
        preservedFiles: [
          "config.yaml",
          "user-history.keep",
          "user-preferences.keep",
        ].map((name) => ({
          path: path.join(original, name),
          sha256: sha(fs.readFileSync(path.join(original, name))),
        })),
      },
    },
  };
  const launch = {
    ownerId: id,
    productionSha256,
    productionProgram,
    ordinaryDiscoveryCwd: cwd,
    pid: 123,
    startedAt: "2026-10-11T16:00:00.000Z",
    retainedHandleValidated: true,
    cdpListener: { retainedDescendantValidated: true },
    qaHooksUsed: false,
    discoveryContextInjected: false,
  };
  const marker = path.join(root, ".ae-production-ui-eight-owner.json");
  json(marker, {
    schemaVersion: 2,
    ownerId: id,
    workspace,
    productionSha256,
    sourceDigest: setup.sourceDigest,
    buildAuditId: setup.buildAuditId,
  });
  json(path.join(root, "setup.json"), setup);
  json(path.join(root, "production-launch-receipt.json"), launch);
  const record = {
    root,
    marker,
    ownerHash: sha(fs.readFileSync(marker)),
    setup,
    launch,
    original,
    named: path.join(original, "profiles/work"),
  };
  cases.set(root, record);
  return record;
}

function removeFixture(record) {
  assert.equal(cases.get(record.root), record);
  ordinaryProfilePath(record.root, workspace);
  assert.equal(sha(fs.readFileSync(record.marker)), record.ownerHash);
  const files = [],
    dirs = [],
    ownedLinks = [],
    pending = [record.root];
  while (pending.length) {
    const current = pending.pop();
    ordinaryProfilePath(current, record.root);
    dirs.push(current);
    for (const entry of fs.readdirSync(current)) {
      const full = path.join(current, entry),
        stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        assert.ok(links.has(full), "Unowned test link retained");
        ownedLinks.push(full);
      } else if (stat.isDirectory()) {
        ordinaryProfilePath(full, record.root);
        pending.push(full);
      } else {
        ordinaryProfilePath(full, record.root);
        files.push(full);
      }
    }
  }
  for (const file of ownedLinks) {
    fs.unlinkSync(file);
    links.delete(file);
  }
  for (const file of files)
    if (file !== record.marker)
      fs.unlinkSync(ordinaryProfilePath(file, record.root));
  for (const directory of dirs.reverse())
    if (directory !== record.root)
      fs.rmdirSync(ordinaryProfilePath(directory, record.root));
  fs.unlinkSync(record.marker);
  fs.rmdirSync(record.root);
  cases.delete(record.root);
}

test.after(() => {
  for (const record of [...cases.values()]) removeFixture(record);
  assert.equal(cases.size, 0);
});

test("canonical fixture is secret-free and owner-specific", () => {
  assert.equal(
    hermesProfileConfig("a".repeat(32)),
    "# AE owned Hermes profile fixture " +
      "a".repeat(32) +
      "\nmodel: fixture-original\nuser_preference: keep-" +
      "a".repeat(32) +
      "\n",
  );
  assert.throws(() => hermesProfileConfig("../outside"));
});

test("copies exactly the three bound files into fresh B and preserves A", () => {
  const fixture = newFixture();
  const before = fixture.setup.fixtures.payload.preservedFiles.map((row) => ({
    path: row.path,
    bytes: fs.readFileSync(row.path),
  }));
  const result = prepareProductionProfileFixture(fixture);
  assert.equal(result.receipt.originalFilesUnchanged, true);
  assert.equal(result.receipt.copiedFiles.length, 4);
  for (const row of before) {
    assert.deepEqual(fs.readFileSync(row.path), row.bytes);
    assert.deepEqual(
      fs.readFileSync(path.join(fixture.named, path.basename(row.path))),
      row.bytes,
    );
  }
  result.assertUnchanged();
  assert.equal(result.receipt.namedProfileRetainedForSupervisorCleanup, true);
  assert.throws(() => prepareProductionProfileFixture(fixture), /newly owned/);
});

const setupFailures = [
  [
    "wrong owner root",
    (f) => {
      f.setup.root = path.join(f.root, "other");
    },
  ],
  [
    "wrong marker owner",
    (f) => {
      const value = JSON.parse(fs.readFileSync(f.marker));
      value.ownerId = "c".repeat(32);
      json(f.marker, value);
      f.ownerHash = sha(fs.readFileSync(f.marker));
    },
  ],
  [
    "QA setup hook",
    (f) => {
      f.setup.qaHooksUsed = true;
    },
  ],
  [
    "injected launch context",
    (f) => {
      f.launch.discoveryContextInjected = true;
    },
  ],
  [
    "unproved production handle",
    (f) => {
      f.launch.retainedHandleValidated = false;
    },
  ],
  [
    "unproved CDP descendant",
    (f) => {
      f.launch.cdpListener.retainedDescendantValidated = false;
    },
  ],
  [
    "mismatched production bytes",
    (f) => {
      fs.appendFileSync(f.setup.productionProgram, "changed");
    },
  ],
  [
    "wrong original environment",
    (f) => {
      f.setup.fixtures.environment.HERMES_HOME = f.root;
    },
  ],
  [
    "missing config fixture",
    (f) => {
      fs.unlinkSync(path.join(f.original, "config.yaml"));
    },
  ],
  [
    "missing preserved binding",
    (f) => {
      f.setup.fixtures.payload.preservedFiles.pop();
    },
  ],
  [
    "duplicate preserved binding",
    (f) => {
      f.setup.fixtures.payload.preservedFiles.push(
        f.setup.fixtures.payload.preservedFiles[0],
      );
    },
  ],
  [
    "changed source bytes",
    (f) => {
      fs.appendFileSync(path.join(f.original, "user-history.keep"), "changed");
    },
  ],
  [
    "noncanonical config despite matching binding",
    (f) => {
      const file = path.join(f.original, "config.yaml");
      fs.writeFileSync(file, "api_key: private-like-fixture\n");
      f.setup.fixtures.payload.preservedFiles[0].sha256 = sha(
        fs.readFileSync(file),
      );
    },
  ],
  [
    "unexpected original file",
    (f) => {
      fs.writeFileSync(
        path.join(f.original, "unbound-original.keep"),
        "must remain",
      );
    },
  ],
  [
    "unexpected original directory",
    (f) => {
      fs.mkdirSync(path.join(f.original, "unknown"));
    },
  ],
  [
    "existing B",
    (f) => {
      fs.mkdirSync(f.named, { recursive: true });
    },
  ],
];
for (const [name, mutate] of setupFailures)
  test("fails closed before copying: " + name, () => {
    const fixture = newFixture();
    mutate(fixture);
    const before = fs.existsSync(fixture.named);
    assert.throws(() => prepareProductionProfileFixture(fixture));
    assert.equal(fs.existsSync(fixture.named), before);
  });

test("existing empty profiles parent remains part of original snapshot", () => {
  const fixture = newFixture();
  fs.mkdirSync(path.dirname(fixture.named));
  const result = prepareProductionProfileFixture(fixture);
  result.assertUnchanged();
  assert.ok(
    result.receipt.originalFiles.some(
      (row) => row.path === "profiles" && row.kind === "directory",
    ),
  );
});

test("original profile junction and all ancestor redirections are refused", () => {
  const fixture = newFixture();
  const external = path.join(fixture.root, "owned-other-target");
  fs.mkdirSync(external);
  const link = path.join(fixture.original, "redirected");
  fs.symlinkSync(external, link, "junction");
  links.add(link);
  assert.throws(() => prepareProductionProfileFixture(fixture), /redirected/);
  assert.throws(
    () =>
      ordinaryProfilePath(path.join(link, "missing.txt"), fixture.root, true),
    /redirected/,
  );
  assert.equal(fs.existsSync(fixture.named), false);
});

test("hard-linked source files are refused without overwriting them", () => {
  const fixture = newFixture();
  const source = path.join(fixture.original, "config.yaml");
  const alias = path.join(fixture.root, "owned-config-hardlink");
  fs.linkSync(source, alias);
  assert.throws(() => prepareProductionProfileFixture(fixture), /hard-linked/);
  assert.equal(fs.existsSync(fixture.named), false);
});

test("an unbound auth file is rejected without reading its contents", () => {
  const fixture = newFixture();
  const file = path.join(fixture.original, "auth.json");
  fs.writeFileSync(file, "Synthetic unread auth sentinel.");
  const originalRead = fs.readFileSync;
  let unboundReads = 0;
  fs.readFileSync = function (target, ...args) {
    if (typeof target === "string" && path.resolve(target) === file)
      unboundReads++;
    return originalRead.call(fs, target, ...args);
  };
  try {
    assert.throws(
      () => prepareProductionProfileFixture(fixture),
      /before reading/,
    );
    assert.equal(unboundReads, 0);
    assert.equal(fs.existsSync(fixture.named), false);
  } finally {
    fs.readFileSync = originalRead;
  }
});

test("preservation detects changed A, B, marker and added files", () => {
  for (const kind of ["A", "B", "marker", "added"]) {
    const fixture = newFixture(),
      result = prepareProductionProfileFixture(fixture);
    const target =
      kind === "A"
        ? path.join(fixture.original, "user-history.keep")
        : kind === "B"
          ? path.join(fixture.named, "config.yaml")
          : kind === "marker"
            ? fixture.marker
            : path.join(fixture.original, "unbound-new.txt");
    const previous = fs.existsSync(target) ? fs.readFileSync(target) : null;
    fs.writeFileSync(target, "changed");
    assert.throws(() => result.assertUnchanged());
    if (previous) fs.writeFileSync(target, previous);
    else fs.unlinkSync(target);
    result.assertUnchanged();
  }
});

test("ordinary discovery requires two distinct exact owned directories", () => {
  const fixture = newFixture(),
    prepared = prepareProductionProfileFixture(fixture);
  const profiles = [prepared.original, prepared.named].map((directory) => ({
    ...prepared.profile,
    directory,
  }));
  const discovery = {
    limited: false,
    clients: [{ agentId: "hermes", profiles }],
  };
  assert.equal(assertProfileDiscovery(discovery, prepared).length, 2);
  for (const value of [
    { ...discovery, limited: true },
    { ...discovery, clients: [{ agentId: "hermes", profiles: [profiles[0]] }] },
    {
      ...discovery,
      clients: [
        {
          agentId: "hermes",
          profiles: [
            profiles[0],
            { ...profiles[1], directory: prepared.original },
          ],
        },
      ],
    },
    {
      ...discovery,
      clients: [
        {
          agentId: "hermes",
          profiles: [
            profiles[0],
            { ...profiles[1], homeDirectory: fixture.root },
          ],
        },
      ],
    },
  ])
    assert.throws(() => assertProfileDiscovery(value, prepared));
});

test("owned catalog authenticates real localhost HTTP and closes its listener", async () => {
  const catalog = await startProfileCatalog("d".repeat(32));
  try {
    const response = await fetch(catalog.endpoint + "/models", {
      headers: { authorization: "Bearer " + catalog.key },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data[0].id, "gpt-5.4");
    assert.equal(catalog.record.authenticatedRequests, 1);
    assert.equal(catalog.record.rejectedRequests, 0);
  } finally {
    await catalog.close();
  }
  assert.equal(catalog.record.closed, true);
  await assert.rejects(
    fetch(catalog.endpoint + "/models", { signal: AbortSignal.timeout(1000) }),
  );
  await catalog.close();
});

test("catalog refuses missing auth and unexpected routes without reading files", async () => {
  const catalog = await startProfileCatalog("e".repeat(32));
  try {
    assert.equal((await fetch(catalog.endpoint + "/models")).status, 401);
    assert.equal(
      (
        await fetch(catalog.endpoint + "/other", {
          headers: { "x-api-key": catalog.key },
        })
      ).status,
      404,
    );
    assert.equal(catalog.record.rejectedRequests, 2);
  } finally {
    await catalog.close();
  }
});

const forbidden = [
  "save_provider",
  "delete_provider",
  "agent_hub_configure",
  "agent_hub_probe",
  "agent_hub_launch",
  "agent_hub_restart",
  "agent_hub_open_directory",
  "set_background_start",
  "plugin:window|close",
];
for (const command of forbidden)
  test("forbids native mutation/external command: " + command, () =>
    assert.throws(() => assertProfileCommands([command])),
  );

function successfulReceipt() {
  return {
    schemaVersion: 1,
    scope: PROFILE_SCOPE,
    ownerId: "f".repeat(32),
    complete: false,
    fullAcceptancePassed: false,
    credentialsRead: false,
    upstreamSupplierVerified: false,
    inferenceExecuted: false,
    configurationApplied: false,
    officialClientsLaunched: false,
    qaHooksUsed: false,
    applicationInvokeReplaced: false,
    passed: true,
    productionNativeIpc: true,
    nativeStateUnchanged: true,
    nativeStoreUnchanged: true,
    pageRestored: true,
    originalFilesUnchanged: true,
    fixtureOriginalsUnchanged: true,
    copiedFilesUnchanged: true,
    serverClosed: true,
    checks: PROFILE_CHECKS.map((name) => ({ name, status: "passed" })),
    observedNativeCommands: [
      "agent_hub_discover",
      "discover_provider_connection",
    ],
    catalog: {
      boundHost: "127.0.0.1",
      closed: true,
      authenticatedRequests: 1,
      rejectedRequests: 0,
    },
    profileCount: 2,
    discoveryRetries: 2,
    modelDiscoveryNativeResponses: 1,
    manualRequiredFields: [
      "原配置目录",
      "原用户目录",
      "客户端启动文件",
      "工作目录",
    ],
    nativeStateBeforeSha256: "a".repeat(64),
    nativeStateAfterSha256: "a".repeat(64),
    pageErrors: [],
  };
}
test("receipt describes only localhost profile scope", () =>
  assertProfileReceipt(successfulReceipt()));
for (const field of [
  "complete",
  "fullAcceptancePassed",
  "credentialsRead",
  "upstreamSupplierVerified",
  "inferenceExecuted",
  "configurationApplied",
  "officialClientsLaunched",
])
  test("receipt forbids unsupported acceptance claim: " + field, () => {
    const receipt = successfulReceipt();
    receipt[field] = true;
    assert.throws(() => assertProfileReceipt(receipt));
  });
for (const field of [
  "nativeStateUnchanged",
  "pageRestored",
  "originalFilesUnchanged",
  "copiedFilesUnchanged",
  "serverClosed",
])
  test("receipt requires verified preservation: " + field, () => {
    const receipt = successfulReceipt();
    receipt[field] = false;
    assert.throws(() => assertProfileReceipt(receipt));
  });
test("receipt rejects missing GUI checks, truncated manual coverage and localhost rejection", () => {
  const missing = successfulReceipt();
  missing.checks.pop();
  assert.throws(() => assertProfileReceipt(missing));
  const fields = successfulReceipt();
  fields.manualRequiredFields.pop();
  assert.throws(() => assertProfileReceipt(fields));
  const rejected = successfulReceipt();
  rejected.catalog.rejectedRequests++;
  assert.throws(() => assertProfileReceipt(rejected));
});
