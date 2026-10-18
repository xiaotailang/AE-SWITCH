import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  createPathGuards,
  snapshotConfigurationTrees,
} from "./native-configuration-extra.mjs";
import {
  assertExistingProfileEquivalent,
  parseExistingJson,
  verifyExistingAgentFiles,
} from "./native-existing-readback.mjs";
import { assertOwnedReadbackPath } from "./native-config-readback.mjs";

const stage = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(process.cwd());
const fixtureParent = path.join(workspace, ".cache", "tmp");
const ts = createRequire(import.meta.url)(
  path.join(workspace, "app/node_modules/typescript/lib/typescript.js"),
);

test("official WorkBuddy root arrays parse independently, retaining JSONC and strict JSON syntax", () => {
  assert.deepEqual(
    parseExistingJson(
      '[ // official model registry\n{"id":"synthetic-model","url":"http://127.0.0.1:1/v1","apiKey":"synthetic-key",}, {"enabled":true,"value":-2.5e+3},] // tail',
      ts,
    ),
    [
      {
        id: "synthetic-model",
        url: "http://127.0.0.1:1/v1",
        apiKey: "synthetic-key",
      },
      { enabled: true, value: -2500 },
    ],
  );
  assert.deepEqual(parseExistingJson("[]", ts), []);
  assert.deepEqual(parseExistingJson('{"array":[1,2,],"keep":true,}', ts), {
    array: [1, 2],
    keep: true,
  });
  for (const text of [
    '[{"id":"a","id":"b"}]',
    '[{"a":{"x":1,"x":2}}]',
    "[undefined]",
    "[NaN]",
    "[Infinity]",
    "[process.exit()]",
    "[...[]]",
    "[1,,2]",
    "[0x10]",
    "[-0x10]",
    "[.5]",
    "[1.]",
    "[01]",
    "[1_000]",
    '["\\v"]',
    '["\\x41"]',
    "['single']",
    '[{"unquoted": true}, {a:1}]',
    '["line\nline"]',
    "[1] [2]",
    "[1",
    "[1] ; process.exit()",
  ])
    assert.throws(() => parseExistingJson(text, ts), text);
});

test("persisted original profiles accept native Windows separators and case only", () => {
  const profile = {
    directory: path.join(stage, "profile"),
    homeDirectory: path.join(stage, "home"),
    executablePath: path.join(stage, "official.exe"),
    workspaceDirectory: path.join(stage, "workspace"),
    stateFile: path.join(stage, "configuration", "v2", "agents-state.json"),
    auxiliaryMode: { keep: "strict" },
    optionalFlag: null,
  };
  const native = structuredClone(profile);
  if (process.platform === "win32") {
    native.stateFile = native.stateFile.replaceAll("\\", "/").toUpperCase();
    native.directory = native.directory.replaceAll("\\", "/");
  }
  assert.doesNotThrow(() => assertExistingProfileEquivalent(native, profile));
  for (const actual of [
    { ...native, stateFile: path.join(stage, "different-state.json") },
    { ...native, directory: path.resolve(stage, "..", "foreign-profile") },
    { ...native, stateFile: "relative-state.json" },
    { ...native, injectedField: true },
    { ...native, auxiliaryMode: { keep: "changed" } },
    { ...native, optionalFlag: false },
    Object.fromEntries(
      Object.entries(native).filter(([key]) => key !== "stateFile"),
    ),
  ])
    assert.throws(() => assertExistingProfileEquivalent(actual, profile));
});

async function ownedFixture(body) {
  const root = path.join(
    fixtureParent,
    `native42-driver-fix-fixture-${randomUUID()}`,
  );
  const marker = path.join(root, ".owner.json");
  const owner = randomUUID();
  assert.match(root, /^G:[\\/]/iu);
  assert.ok(root.startsWith(fixtureParent + path.sep));
  await fs.mkdir(root);
  await fs.writeFile(marker, JSON.stringify({ owner, root }));
  try {
    await body(root);
  } finally {
    assert.ok(root.startsWith(fixtureParent + path.sep));
    assert.equal(await fs.realpath(root), root);
    assert.deepEqual(JSON.parse(await fs.readFile(marker, "utf8")), {
      owner,
      root,
    });
    await fs.rm(root, { recursive: true });
    assert.equal(
      await fs.stat(root).then(
        () => true,
        (e) => e.code !== "ENOENT",
      ),
      false,
    );
  }
}

async function configurationFixture(root) {
  const data = path.join(root, "data");
  const desktop = path.join(data, "home", "AppData", "Local");
  const codex = path.join(data, "home", ".codex");
  const claude = path.join(data, "home", ".claude");
  const normal = path.join(desktop, "Claude");
  const third = path.join(desktop, "Claude-3p");
  for (const dir of [
    codex,
    claude,
    path.join(normal, "sessions"),
    path.join(third, "configLibrary"),
  ])
    await fs.mkdir(dir, { recursive: true });
  const codexFile = path.join(codex, "config.toml");
  const normalFile = path.join(normal, "claude_desktop_config.json");
  const thirdFile = path.join(third, "configLibrary", "_meta.json");
  const historyFile = path.join(normal, "sessions", "history.jsonl");
  for (const [file, text] of [
    [codexFile, 'model="synthetic"'],
    [normalFile, '{"keep":true}'],
    [thirdFile, '{"entries":[]}'],
    [historyFile, '{"history":"keep"}\n'],
  ])
    await fs.writeFile(file, text);
  const value = {
    targets: [
      { target: "codex", directory: codex, files: [codexFile] },
      {
        target: "claude_cli",
        directory: claude,
        files: [path.join(claude, "settings.json")],
      },
      {
        target: "claude_desktop",
        directory: desktop,
        files: [normalFile, thirdFile],
      },
    ],
  };
  const agents = {
    agents: [
      {
        id: "hermes",
        directory: path.join(data, "agents", "hermes"),
        launcher: null,
      },
    ],
  };
  const touched = [];
  const guards = createPathGuards(
    root,
    async (location, { allowMissing = false } = {}) => {
      touched.push(location);
      if (!allowMissing) await assertOwnedReadbackPath(workspace, location);
    },
  );
  const snapshot = () =>
    snapshotConfigurationTrees({ root, value, agents, ...guards });
  return {
    desktop,
    normal,
    historyFile,
    value,
    agents,
    touched,
    guards,
    snapshot,
  };
}

test("configuration snapshots protect actual desktop configuration and history without traversing Windows cache links", async () =>
  ownedFixture(async (root) => {
    const f = await configurationFixture(root);
    const cache = path.join(f.desktop, "Microsoft", "Windows", "INetCache");
    const cacheTarget = path.join(root, "cache-target");
    const link = path.join(cache, "Content.IE5");
    await fs.mkdir(cache, { recursive: true });
    await fs.mkdir(cacheTarget);
    await fs.symlink(cacheTarget, link, "junction");
    try {
      const result = await f.snapshot();
      assert.equal(
        result.files.get(f.historyFile).toString("utf8"),
        '{"history":"keep"}\n',
      );
      assert.ok(result.directories.has(f.normal));
      assert.equal(
        result.files.get(
          path.join(root, "data", "home", ".codex", "auth.json"),
        ),
        null,
      );
      assert.equal(result.directories.get(f.agents.agents[0].directory), null);
      assert.ok(
        !f.touched.some((location) =>
          location.includes(`${path.sep}Microsoft${path.sep}`),
        ),
      );
      assert.ok((await fs.lstat(link)).isSymbolicLink());
      await assert.rejects(f.guards.ordinary(link));
    } finally {
      await fs.unlink(link);
    }
  }));

test("protected client paths still reject junctions, hardlinks and path escapes", async () =>
  ownedFixture(async (root) => {
    const f = await configurationFixture(root);
    const linked = path.join(f.normal, "linked-session");
    await fs.symlink(
      path.join(root, "data", "home", ".codex"),
      linked,
      "junction",
    );
    try {
      await assert.rejects(f.snapshot());
    } finally {
      await fs.unlink(linked);
    }
    const hardlink = path.join(f.normal, "hardlink.jsonl");
    await fs.link(f.historyFile, hardlink);
    try {
      await assert.rejects(f.snapshot());
    } finally {
      await fs.unlink(hardlink);
    }
    const outside = path.resolve(root, "..", "outside.txt");
    await assert.rejects(f.guards.ordinary(outside, true));
    f.value.targets
      .find((item) => item.target === "claude_desktop")
      .files.push(outside);
    await assert.rejects(f.snapshot());
  }));

test("an explicitly selected desktop client root retains its direct files and session history", async () =>
  ownedFixture(async (root) => {
    const f = await configurationFixture(root);
    const target = f.value.targets.find(
      (item) => item.target === "claude_desktop",
    );
    target.directory = f.normal;
    target.files = [path.join(f.normal, "claude_desktop_config.json")];
    const result = await f.snapshot();
    assert.equal(
      result.files.get(f.historyFile).toString("utf8"),
      '{"history":"keep"}\n',
    );
  }));

test("full independent WorkBuddy readback accepts an official root array and canonical original profile while rejecting changed provenance", async () =>
  ownedFixture(async (root) => {
    const nativeRoot = path.join(root, "ae-data");
    const directory = path.join(root, "original-profile");
    for (const dir of [nativeRoot, directory]) await fs.mkdir(dir);
    const history = path.join(directory, "history.jsonl");
    const historyBytes = Buffer.from('{"original":"keep"}\n');
    await fs.writeFile(history, historyBytes);
    const profile = {
      directory,
      homeDirectory: root,
      executablePath: path.join(root, "official.exe"),
      workspaceDirectory: root,
    };
    const nativeProfile = structuredClone(profile);
    if (process.platform === "win32")
      nativeProfile.directory = directory.replaceAll("\\", "/");
    const gateway = {
      baseUrl: "http://127.0.0.1:1/v1",
      token: "synthetic-readback-token",
    };
    const model = "synthetic-readback-model";
    await fs.writeFile(
      path.join(directory, "models.json"),
      JSON.stringify([
        {
          id: "original-model",
          apiKey: "synthetic-original-key",
          useChatCompletions: true,
        },
        {
          id: model,
          url: gateway.baseUrl,
          apiKey: gateway.token,
          useChatCompletions: true,
        },
      ]),
    );
    const selectedPath = path.join(nativeRoot, "agent-selection.json");
    const selected = {
      providerId: "synthetic-provider",
      model,
      profile: nativeProfile,
    };
    await fs.writeFile(selectedPath, JSON.stringify({ workbuddy: selected }));
    const fixture = {
      profiles: { workbuddy: profile },
      preservedFiles: [
        {
          path: history,
          sha256: createHash("sha256").update(historyBytes).digest("hex"),
        },
      ],
    };
    const verify = () =>
      verifyExistingAgentFiles({
        workspaceRoot: workspace,
        nativeRoot,
        agent: "workbuddy",
        providerId: selected.providerId,
        model,
        gateway,
        fixture,
      });
    const result = await verify();
    assert.equal(result.nativeAuthentication, true);
    assert.equal(result.originalProfileMatched, true);
    assert.equal(result.preservedFileCount, 1);
    assert.equal(result.noPrivateWrapper, true);
    assert.equal(result.clientStarted, false);
    assert.equal(result.desktopDefaultSelectionVerified, false);
    for (const changed of [
      { ...nativeProfile, directory: root },
      { ...nativeProfile, injectedPath: directory },
    ]) {
      await fs.writeFile(
        selectedPath,
        JSON.stringify({ workbuddy: { ...selected, profile: changed } }),
      );
      await assert.rejects(verify());
    }
  }));
