import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  assertOwnedReadbackPath,
  parseOwnedConfiguration,
  assertCodexConfiguration,
  assertOpenCodeConfiguration,
  assertHermesConfiguration,
  assertOmpConfiguration,
  assertWorkBuddyConfiguration,
  assertZcodeConfiguration,
  assertDshConfiguration,
  uniqueSelectedRow,
} from "./native-config-readback.mjs";

const workspaceRoot = path.resolve(process.cwd());
const installationsFile = process.env.AE_ACCEPTANCE_INSTALLATIONS_MANIFEST;
const installations = installationsFile
  ? JSON.parse(await fs.readFile(await assertOwnedReadbackPath(workspaceRoot, installationsFile), "utf8"))
  : null;
const pythonDirectory = installations ? path.dirname(installations.python) : path.join(
  workspaceRoot,
  ".tools/python/cpython-3.14.6-windows-x86_64-none",
);
const yamlLibraryDirectory = installations?.hermesSitePackages ?? path.join(
  workspaceRoot,
  ".tools/agents/hermes/.venv/Lib/site-packages",
);
const sandbox = path.join(
  workspaceRoot,
  ".cache",
  `native-readback-fixtures-${randomUUID()}`,
);
const owner = randomUUID();
const expected = {
  model: "selected-model",
  base: "http://127.0.0.1:34567/agents/fixture/v1",
  token: "offline-fixture-token",
};

test.before(async () => {
  await assertOwnedReadbackPath(workspaceRoot, path.dirname(sandbox));
  await fs.mkdir(sandbox);
  await fs.writeFile(
    path.join(sandbox, ".owner.json"),
    JSON.stringify({ owner, sandbox }),
  );
});

test.after(async () => {
  await assertOwnedReadbackPath(workspaceRoot, sandbox);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(sandbox, ".owner.json"), "utf8")),
    { owner, sandbox },
  );
  assert.ok(sandbox.startsWith(path.join(workspaceRoot, ".cache") + path.sep));
  await fs.rm(sandbox, { recursive: true });
});

async function readback(text, format = "yaml", options = {}) {
  const location = path.join(sandbox, `${randomUUID()}.${format}`);
  await fs.writeFile(location, text);
  return parseOwnedConfiguration({
    workspaceRoot,
    location,
    format,
    expectedSha256: createHash("sha256").update(text).digest("hex"),
    pythonDirectory,
    yamlLibraryDirectory,
    ...options,
  });
}

const hermes = () => ({
  model: {
    default: expected.model,
    provider: "custom",
    base_url: expected.base,
    key_env: "AE_SWITCH_API_KEY",
    api_mode: "chat_completions",
    unknown: { preferences: ["keep"] },
  },
  auxiliary: Object.fromEntries(
    ["compression", "title_generation", "background_review"].map((task) => [
      task,
      {
        provider: "custom",
        model: expected.model,
        base_url: expected.base,
        key_env: "AE_SWITCH_API_KEY",
        api_mode: "chat_completions",
      },
    ]),
  ),
  history: { keep: true },
});

test("official safe YAML parser accepts block syntax and preserves foreign metadata", async () => {
  const parsed = await readback(
    `model:\n  default: ${expected.model}\n  provider: custom\n  base_url: '${expected.base}'\n  key_env: AE_SWITCH_API_KEY\n  api_mode: chat_completions\nauxiliary: ${JSON.stringify(hermes().auxiliary)}\nhistory: {keep: true}\n`,
  );
  assertHermesConfiguration(parsed.document, expected);
  assert.equal(parsed.document.history.keep, true);
  assert.equal(parsed.proof.parser.name, "ruamel.yaml (safe, pure)");
  assert.equal(parsed.proof.unchangedBeforeAndAfter, true);
  assert.ok(
    parsed.proof.loadedModules.some((module) => module.name === "ruamel.yaml"),
  );
  assert.ok(
    parsed.proof.runtime.binaries.some(
      (file) => path.basename(file.path) === "python.exe",
    ),
  );
  assert.equal(
    (await fs.readdir(sandbox)).some((name) =>
      name.startsWith(".ae-parser-cache-"),
    ),
    false,
  );
});

test("official safe YAML parser accepts JSON flow output from native merge", async () => {
  const parsed = await readback(JSON.stringify(hermes()));
  assertHermesConfiguration(parsed.document, expected);
  assert.deepEqual(parsed.document, hermes());
});

test("official safe YAML parser rejects malformed and duplicate-key files", async () => {
  for (const text of [
    "model: [\n",
    "model: {default: first, default: second}\n",
  ]) {
    await assert.rejects(readback(text), /independent parser failed/u);
  }
});

test("official safe YAML parser rejects executable Python tags", async () => {
  await assert.rejects(
    readback("!!python/object/apply:os.system ['invalid-command']\n"),
    /independent parser failed/u,
  );
});

test("readback rejects configuration hash mismatch before invoking parser", async () => {
  await assert.rejects(
    readback(JSON.stringify(hermes()), "yaml", {
      expectedSha256: "0".repeat(64),
    }),
    /SHA changed before parsing/u,
  );
});

test("readback rejects outside-workspace, C-drive, relative and linked paths", async () => {
  await assert.rejects(
    assertOwnedReadbackPath(
      workspaceRoot,
      path.resolve(workspaceRoot, "..", "outside.yml"),
    ),
    /escaped workspace/u,
  );
  await assert.rejects(
    assertOwnedReadbackPath(workspaceRoot, "C:\\forbidden\\python.exe"),
    /stay on G/u,
  );
  await assert.rejects(
    assertOwnedReadbackPath(workspaceRoot, "relative.yml"),
    /must be absolute/u,
  );
  const target = path.join(sandbox, "actual-directory");
  const link = path.join(sandbox, "linked-directory");
  await fs.mkdir(target);
  await fs.symlink(target, link, "junction");
  await assert.rejects(
    assertOwnedReadbackPath(workspaceRoot, link),
    /links or junctions/u,
  );
  await fs.unlink(link);
});

const codex = () => ({
  model: expected.model,
  model_provider: "ae_switch",
  model_providers: {
    ae_switch: {
      base_url: expected.base,
      env_key: "AE_SWITCH_API_KEY",
      wire_api: "responses",
    },
    foreign: { base_url: "https://foreign.invalid", custom: "keep" },
  },
});

test("stdlib TOML parser verifies active profile and retains context/reasoning values", async () => {
  const parsed = await readback(
    `model = "${expected.model}"\nmodel_provider = "ae_switch"\nprofile = "active"\nmodel_context_window = 64000\nmodel_auto_compact_token_limit = 48000\n[model_providers.ae_switch]\nbase_url = "${expected.base}"\nenv_key = "AE_SWITCH_API_KEY"\nwire_api = "responses"\n[profiles.active]\nmodel = "${expected.model}"\nmodel_provider = "ae_switch"\nmodel_context_window = 128000\nmodel_reasoning_effort = "high"\n[profiles.inactive]\nmodel = "foreign-model"\n`,
    "toml",
  );
  assertCodexConfiguration(parsed.document, expected);
  assert.equal(parsed.document.profiles.active.model_context_window, 128000);
  assert.equal(parsed.document.profiles.active.model_reasoning_effort, "high");
  assert.equal(parsed.document.model_auto_compact_token_limit, 48000);
  assert.equal(parsed.document.proof, undefined);
  assert.equal(parsed.proof.parser.name, "stdlib tomllib");
  assert.ok(
    parsed.proof.loadedModules.some((module) => module.name === "tomllib"),
  );
});

test("stdlib TOML parser rejects invalid syntax and duplicate fields", async () => {
  await assert.rejects(
    readback('model = "first"\nmodel = "second"\n', "toml"),
    /independent parser failed/u,
  );
});

test("TOML dates cannot masquerade as an active profile table", async () => {
  const parsed = await readback(
    `model = "${expected.model}"\nmodel_provider = "ae_switch"\nprofile = "active"\n[model_providers.ae_switch]\nbase_url = "${expected.base}"\nenv_key = "AE_SWITCH_API_KEY"\nwire_api = "responses"\n[profiles]\nactive = 2026-10-09\n`,
    "toml",
  );
  assert.throws(
    () => assertCodexConfiguration(parsed.document, expected),
    /active profile must be an object/u,
  );
});

test("Codex root and profile inheritance pass without mutating preferences", () => {
  const document = {
    ...codex(),
    profile: "active",
    profiles: {
      active: {
        model_reasoning_effort: "minimal",
        model_auto_compact_token_limit: 48000,
      },
    },
  };
  const before = structuredClone(document);
  assertCodexConfiguration(document, expected);
  assert.deepEqual(document, before);
  assertCodexConfiguration(codex(), expected);
});

test("Codex stale active model or provider fails despite correct root", () => {
  for (const override of [
    { model: "stale" },
    { model_provider: "foreign" },
    { model: null },
  ]) {
    assert.throws(
      () =>
        assertCodexConfiguration(
          { ...codex(), profile: "active", profiles: { active: override } },
          expected,
        ),
      /effective/u,
    );
  }
});

test("Codex missing, invalid or unnamed active profile fails closed", () => {
  for (const extra of [
    { profile: "missing", profiles: {} },
    { profile: "__proto__", profiles: {} },
    { profile: "bad", profiles: { bad: [] } },
    { profile: "", profiles: {} },
    { profile: false },
  ]) {
    assert.throws(
      () => assertCodexConfiguration({ ...codex(), ...extra }, expected),
      /profile/u,
    );
  }
});

test("Hermes rejects stale routing and key-env fields regardless of formatting", () => {
  for (const [key, value] of [
    ["default", "stale"],
    ["provider", "foreign"],
    ["key_env", "STALE_KEY"],
    ["base_url", "https://foreign.invalid"],
    ["api_mode", "responses"],
  ]) {
    const document = hermes();
    document.model[key] = value;
    assert.throws(
      () => assertHermesConfiguration(document, expected),
      /mismatch/u,
    );
  }
});

test("Hermes inline key precedence cannot override the gateway environment key", () => {
  for (const key of ["api_key", "api"]) {
    const stale = hermes();
    stale.model[key] = "stale-fixture-key";
    assert.throws(
      () => assertHermesConfiguration(stale, expected),
      /inline key/u,
    );
    stale.model[key] = ` ${expected.token} `;
    assertHermesConfiguration(stale, expected);
  }
});

const omp = () => ({
  providers: {
    ae_switch: {
      baseUrl: expected.base,
      api: "openai-completions",
      apiKey: "AE_SWITCH_API_KEY",
      models: [
        { id: "foreign-model", unknown: true },
        { id: expected.model, contextWindow: 128000 },
      ],
    },
    foreign: { baseUrl: "https://foreign.invalid" },
  },
});

const chatRoles = [
  "default",
  "smol",
  "slow",
  "vision",
  "plan",
  "commit",
  "tiny",
  "memory",
  "task",
  "advisor",
];
const ompSettings = () => ({
  modelRoles: Object.fromEntries(
    chatRoles.map((role) => [role, `ae_switch/${expected.model}`]),
  ),
});

test("OMP flow YAML allows preserved rows and verifies selected model role", async () => {
  const models = await readback(JSON.stringify(omp()));
  const settings = await readback(
    JSON.stringify({
      modelRoles: {
        ...ompSettings().modelRoles,
        planning: "foreign/keep",
        image: "foreign/image",
      },
    }),
  );
  const before = structuredClone(models.document);
  assertOmpConfiguration(models.document, settings.document, expected);
  assert.deepEqual(models.document, before);
});

test("OMP rejects duplicate selected rows, stale roles and key references", () => {
  const settings = ompSettings();
  const duplicate = omp();
  duplicate.providers.ae_switch.models.push({ id: expected.model });
  assert.throws(
    () => assertOmpConfiguration(duplicate, settings, expected),
    /exactly one/u,
  );
  assert.throws(
    () =>
      assertOmpConfiguration(
        omp(),
        { modelRoles: { default: "foreign/stale" } },
        expected,
      ),
    /default model/u,
  );
  const wrongKey = omp();
  wrongKey.providers.ae_switch.apiKey = "stale";
  assert.throws(
    () => assertOmpConfiguration(wrongKey, settings, expected),
    /apiKey/u,
  );
});

test("OMP readback rejects every missing or stale default chat workflow role", () => {
  for (const role of chatRoles) {
    for (const missing of [false, true]) {
      const settings = ompSettings();
      if (missing) delete settings.modelRoles[role];
      else settings.modelRoles[role] = "foreign/stale";
      assert.throws(
        () => assertOmpConfiguration(omp(), settings, expected),
        new RegExp(`OMP ${role} model mismatch`, "u"),
      );
    }
  }
});

test("OMP selected model endpoint and API override cannot escape the gateway", () => {
  const settings = ompSettings();
  for (const override of [
    { baseUrl: "https://foreign.invalid" },
    { api: "anthropic-messages" },
  ]) {
    const document = omp();
    Object.assign(document.providers.ae_switch.models[1], override);
    assert.throws(
      () => assertOmpConfiguration(document, settings, expected),
      /effective model/u,
    );
  }
  const compatible = omp();
  Object.assign(compatible.providers.ae_switch.models[1], {
    baseUrl: expected.base,
    api: "openai-completions",
  });
  assertOmpConfiguration(compatible, settings, expected);
});

test("OMP final modelOverrides API and all selected auth header sources are checked", () => {
  const settings = ompSettings();
  const staleApi = omp();
  staleApi.providers.ae_switch.modelOverrides = {
    [expected.model]: { api: "anthropic-messages" },
    foreign: { api: "anthropic-messages" },
  };
  assert.throws(
    () => assertOmpConfiguration(staleApi, settings, expected),
    /effective model API/u,
  );
  for (const source of ["provider", "model", "override"]) {
    const document = omp();
    const provider = document.providers.ae_switch;
    provider.modelOverrides = { [expected.model]: { unknown: "preserve" } };
    const selected =
      source === "provider"
        ? provider
        : source === "model"
          ? provider.models[1]
          : provider.modelOverrides[expected.model];
    selected.headers = { aUtHoRiZaTiOn: "Bearer stale", "X-Preserved": "keep" };
    assert.throws(
      () => assertOmpConfiguration(document, settings, expected),
      /authorization mismatch/u,
    );
    selected.headers.aUtHoRiZaTiOn = `Bearer ${expected.token}`;
    assertOmpConfiguration(document, settings, expected);
  }
});

const workbuddy = () => [
  { id: "foreign-model", apiKey: "foreign-fixture-key", unknown: true },
  {
    id: expected.model,
    url: expected.base,
    apiKey: expected.token,
    supportsToolCall: true,
    useCustomProtocol: false,
  },
];

test("WorkBuddy validates selected row and preserves unrelated models", () => {
  const document = workbuddy();
  const before = structuredClone(document);
  assertWorkBuddyConfiguration(document, expected);
  assert.deepEqual(document, before);
});

test("WorkBuddy missing/duplicate IDs, endpoint, key or transport conflicts fail", () => {
  assert.throws(
    () => assertWorkBuddyConfiguration([], expected),
    /exactly one/u,
  );
  assert.throws(
    () =>
      assertWorkBuddyConfiguration([...workbuddy(), workbuddy()[1]], expected),
    /exactly one/u,
  );
  for (const extra of [
    { url: "https://foreign.invalid" },
    { apiKey: "stale" },
    { vendor: "foreign" },
    { useCustomProtocol: true },
  ]) {
    assert.throws(() =>
      assertWorkBuddyConfiguration(
        [workbuddy()[0], { ...workbuddy()[1], ...extra }],
        expected,
      ),
    );
  }
});

const zcode = () => ({
  config: {
    defaultModelSelection: {
      providerId: "ae_switch",
      modelId: expected.model,
      options: { reasoningLevel: "disabled" },
    },
    providerConfigRules: {
      providerRules: [
        { providerId: "foreign", custom: "keep" },
        {
          providerId: "ae_switch",
          enabled: true,
          config: {
            api: { type: "openai-chat-completions", baseUrl: expected.base },
            access: { type: "api-key", apiKey: expected.token },
            personalModelIds: ["foreign-model", expected.model],
          },
        },
      ],
    },
  },
});
const builtin = () => ({
  config: {
    providerConfigRules: {
      providerRules: [{ providerId: "foreign-builtin", custom: "keep" }],
    },
  },
});

test("Zcode accepts foreign builtin and personal providers without changing rows", () => {
  const documents = [zcode(), builtin()];
  const before = structuredClone(documents);
  assertZcodeConfiguration(...documents, expected);
  assert.deepEqual(documents, before);
});

test("Zcode selected duplicate, disabled, missing model and stale endpoint fail", () => {
  for (const change of [
    (doc) =>
      doc.config.providerConfigRules.providerRules.push(
        doc.config.providerConfigRules.providerRules[1],
      ),
    (doc) => {
      doc.config.providerConfigRules.providerRules[1].enabled = false;
    },
    (doc) => {
      doc.config.providerConfigRules.providerRules[1].config.personalModelIds =
        ["foreign-model"];
    },
    (doc) => {
      doc.config.providerConfigRules.providerRules[1].config.api.baseUrl =
        "https://foreign.invalid";
    },
  ]) {
    const document = zcode();
    change(document);
    assert.throws(() =>
      assertZcodeConfiguration(document, builtin(), expected),
    );
  }
});

const dsh = () => [
  { id: "foreign-plugin", config: { keep: true } },
  {
    id: "llm-pi-ai",
    config: {
      providers: {
        "ae-switch": {
          api: "openai-completions",
          baseURL: expected.base,
          apiKeyEnv: "AE_GATEWAY_TOKEN",
          headers: {
            aUtHoRiZaTiOn: `Bearer ${expected.token}`,
            "X-Preserved": "keep",
          },
          models: [
            { id: "foreign-model", unknown: true },
            { id: expected.model },
          ],
        },
        foreign: { keep: true },
      },
    },
  },
  {
    id: "agent-default-model",
    config: { provider: "ae-switch", model: expected.model, unknown: "keep" },
  },
  ...[
    "session-log-deepseek",
    "session-title-llm",
    "session-telemetry-otel",
  ].map((id) => ({ id, disabled: true })),
];

test("DSH YAML accepts preserved models/plugins and validates auth precedence", async () => {
  const parsed = await readback(
    dsh()
      .map(
        (plugin) =>
          `- id: ${plugin.id}\n  ${plugin.disabled === true ? "disabled: true" : `config: ${JSON.stringify(plugin.config)}`}\n`,
      )
      .join(""),
  );
  const before = structuredClone(parsed.document);
  assertDshConfiguration(parsed.document, expected);
  assert.deepEqual(parsed.document, before);
});

test("DSH duplicate selection, stale authorization, disabled LLM and enabled telemetry fail", () => {
  for (const change of [
    (doc) => doc.push(doc[1]),
    (doc) =>
      doc[1].config.providers["ae-switch"].models.push({ id: expected.model }),
    (doc) => {
      doc[1].config.providers["ae-switch"].headers.aUtHoRiZaTiOn =
        "Bearer stale";
    },
    (doc) => {
      doc[1].disabled = true;
    },
    (doc) => {
      doc[3].disabled = false;
    },
  ]) {
    const document = dsh();
    change(document);
    assert.throws(() => assertDshConfiguration(document, expected));
  }
});

// Exercise the actual driver function without importing its native entrypoint,
// attaching a WebView, replacing IPC, or launching any Agent. Only packaged tool
// locations are mapped to the existing physical G-owned parser for these fixtures.
const driverSource = await fs.readFile(
  new URL("./native-ui.mjs", import.meta.url),
  "utf8",
);
const driverFunction = driverSource.slice(
  driverSource.indexOf("async function verifyAgentFiles("),
  driverSource.indexOf("async function verifyAllHubRevalidations("),
);
assert.ok(driverFunction.startsWith("async function verifyAgentFiles("));
const nativeRoot = path.join(sandbox, "native");
const samePath = (left, right) =>
  path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
const dependencies = {
  assert,
  fs,
  path,
  createHash,
  nativeRoot,
  // This slice exercises the legacy per-tool readback below. Existing native
  // profiles use the independent native-existing-readback fixture suite.
  existingFixture: null,
  root: workspaceRoot,
  assertPhysicalWorkspacePath: (location) =>
    assertOwnedReadbackPath(workspaceRoot, location),
  samePath,
  parseOwnedConfiguration: (options) => {
    assert.equal(
      options.pythonDirectory,
      path.join(nativeRoot, "tools/python"),
    );
    assert.equal(
      options.yamlLibraryDirectory,
      path.join(nativeRoot, "tools/agents/hermes/site-packages"),
    );
    return parseOwnedConfiguration({
      ...options,
      pythonDirectory,
      yamlLibraryDirectory,
    });
  },
  assertCodexConfiguration,
  assertOpenCodeConfiguration,
  assertHermesConfiguration,
  assertOmpConfiguration,
  assertWorkBuddyConfiguration,
  assertZcodeConfiguration,
  assertDshConfiguration,
  uniqueSelectedRow,
};
const verifyAgentFiles = new Function(
  ...Object.keys(dependencies),
  `${driverFunction}\nreturn verifyAgentFiles;`,
)(...Object.values(dependencies));
const gateway = { port: 34567, token: expected.token };
const fixtureSelections = {};

async function agentFixture(id, files, additionalEnvironment = {}) {
  const directory = path.join(nativeRoot, "data", "agents", id);
  const environment = {
    AE_AGENT_ROOT: directory,
    AE_AGENT_ALLOWED_ROOT: path.join(nativeRoot, "data"),
    AE_SWITCH_API_KEY: expected.token,
    AE_GATEWAY_TOKEN: expected.token,
    ...additionalEnvironment,
  };
  for (const [variable, relative] of [
    ["HOME", "home"],
    ["USERPROFILE", "home"],
    ["APPDATA", "home/AppData/Roaming"],
    ["LOCALAPPDATA", "home/AppData/Local"],
    ["TEMP", "tmp"],
    ["TMP", "tmp"],
    ["TMPDIR", "tmp"],
    ["XDG_CONFIG_HOME", "configuration/xdg"],
    ["XDG_CACHE_HOME", "cache"],
    ["XDG_DATA_HOME", "home/data"],
    ["XDG_STATE_HOME", "home/state"],
  ]) {
    environment[variable] = path.join(directory, relative);
    await fs.mkdir(environment[variable], { recursive: true });
  }
  await fs.mkdir(path.join(directory, "workspace"), { recursive: true });
  for (const [relative, value] of Object.entries({
    ...files,
    "configuration/environment.json": JSON.stringify(environment),
    "launch.cmd": "@echo off\n",
    "launch.ps1": "# Offline configuration fixture\n",
  })) {
    const location = path.join(directory, relative);
    await fs.mkdir(path.dirname(location), { recursive: true });
    await fs.writeFile(
      location,
      value.replaceAll(
        expected.base,
        `http://127.0.0.1:${gateway.port}/agents/selected:${id}/v1`,
      ),
    );
  }
  fixtureSelections[id] = { providerId: "fixture", model: expected.model };
  await fs.writeFile(
    path.join(nativeRoot, "data", "agent-selection.json"),
    JSON.stringify(fixtureSelections),
  );
  return { id, directory, launcher: path.join(directory, "launch.cmd") };
}

test("native driver reads Hermes JSON-flow YAML with independent parser proof", async () => {
  const agent = await agentFixture("hermes", {
    "home/.hermes/config.yaml": JSON.stringify(hermes()),
  });
  const receipt = await verifyAgentFiles(
    agent,
    "fixture",
    expected.model,
    gateway,
  );
  assert.equal(receipt.selectedProviderAndModelMatch, true);
  assert.equal(receipt.parserReadbacks.length, 1);
  assert.equal(
    receipt.parserReadbacks[0].configuration.sha256,
    receipt.files[0].sha256,
  );
  assert.equal(receipt.parserReadbacks[0].unchangedBeforeAndAfter, true);
});

test("native driver parses both OMP YAML files and accepts foreign model rows", async () => {
  const agent = await agentFixture("oh_my_pi", {
    "home/.omp/agent/models.yml": JSON.stringify(omp()),
    "home/.omp/agent/config.yml": JSON.stringify({
      modelRoles: { ...ompSettings().modelRoles, foreign: "preserve" },
    }),
  });
  const receipt = await verifyAgentFiles(
    agent,
    "fixture",
    expected.model,
    gateway,
  );
  assert.equal(receipt.parserReadbacks.length, 2);
});

test("native driver validates effective Codex profile and rejects stale active routing", async () => {
  const text = `model = "${expected.model}"\nmodel_provider = "ae_switch"\nprofile = "active"\n[model_providers.ae_switch]\nbase_url = "${expected.base}"\nenv_key = "AE_SWITCH_API_KEY"\nwire_api = "responses"\n[profiles.active]\nmodel_reasoning_effort = "minimal"\nmodel_context_window = 64000\n`;
  const agent = await agentFixture("codex", {
    "home/.codex/config.toml": text,
  });
  const receipt = await verifyAgentFiles(
    agent,
    "fixture",
    expected.model,
    gateway,
  );
  assert.equal(receipt.parserReadbacks[0].parser.name, "stdlib tomllib");
  await fs.writeFile(
    path.join(agent.directory, "home/.codex/config.toml"),
    (text + 'model = "stale-active-model"\n').replaceAll(
      expected.base,
      `http://127.0.0.1:${gateway.port}/agents/selected:codex/v1`,
    ),
  );
  await assert.rejects(
    verifyAgentFiles(agent, "fixture", expected.model, gateway),
    /effective model mismatch/u,
  );
});

test("native driver accepts WorkBuddy foreign rows and rejects duplicate selected IDs", async () => {
  const agent = await agentFixture(
    "workbuddy",
    { "home/.workbuddy/models.json": JSON.stringify(workbuddy()) },
    { AE_WORKBUDDY_MODEL: expected.model },
  );
  await verifyAgentFiles(agent, "fixture", expected.model, gateway);
  await fs.writeFile(
    path.join(agent.directory, "home/.workbuddy/models.json"),
    JSON.stringify([...workbuddy(), workbuddy()[1]]).replaceAll(
      expected.base,
      `http://127.0.0.1:${gateway.port}/agents/selected:workbuddy/v1`,
    ),
  );
  await assert.rejects(
    verifyAgentFiles(agent, "fixture", expected.model, gateway),
    /exactly one selected row/u,
  );
});

test("native driver accepts Zcode foreign builtin providers and rejects stale selected key", async () => {
  const agent = await agentFixture("zcode", {
    "configuration/zcode-providers.json": JSON.stringify(zcode()),
    "configuration/zcode-builtin.json": JSON.stringify(builtin()),
  });
  await verifyAgentFiles(agent, "fixture", expected.model, gateway);
  const stale = zcode();
  stale.config.providerConfigRules.providerRules[1].config.access.apiKey =
    "stale-fixture-key";
  await fs.writeFile(
    path.join(agent.directory, "configuration/zcode-providers.json"),
    JSON.stringify(stale).replaceAll(
      expected.base,
      `http://127.0.0.1:${gateway.port}/agents/selected:zcode/v1`,
    ),
  );
  await assert.rejects(
    verifyAgentFiles(agent, "fixture", expected.model, gateway),
    /selected key mismatch/u,
  );
});

test("native driver reads DSH block YAML, extra bundles and preserves cleanup gates", async () => {
  const directory = path.join(nativeRoot, "data", "agents", "deepseek_harness");
  const plugins = [
    ...dsh(),
    {
      id: "pwsh-sandbox",
      config: {
        pwshPath: path.relative(
          path.join(directory, "workspace"),
          path.join(nativeRoot, "tools/pwsh/pwsh.exe"),
        ),
      },
    },
  ];
  const agent = await agentFixture(
    "deepseek_harness",
    {
      "home/.dsh/profiles/headless/cordis.patch.yml": plugins
        .map(
          (plugin) =>
            `- id: ${plugin.id}\n  ${plugin.disabled === true ? "disabled: true" : `config: ${JSON.stringify(plugin.config)}`}\n`,
        )
        .join(""),
      "home/.dsh/profiles/headless/package.json": JSON.stringify({
        dsh: {
          profile: {
            bundles: [
              "foreign-bundle",
              "@deepseek-ai/dsh-base",
              "@deepseek-ai/dsh-headless",
            ],
          },
        },
      }),
    },
    {
      DSH_HOME: path.join(directory, "home/.dsh"),
      DSH_TELEMETRY_MODE: "DISABLED",
      AE_DSH_PWSH: path.join(nativeRoot, "tools/pwsh/pwsh.exe"),
      AE_DSH_RUNTIME: path.join(nativeRoot, "tools/node/node.exe"),
      AE_DSH_ENTRY: path.join(
        nativeRoot,
        "tools/agents/deepseek_harness/node_modules/@deepseek-ai/dsh/lib/bin.js",
      ),
    },
  );
  const receipt = await verifyAgentFiles(
    agent,
    "fixture",
    expected.model,
    gateway,
  );
  assert.equal(receipt.parserReadbacks[0].configuration.format, "yaml");
  const leftover = path.join(
    directory,
    "workspace",
    ".ae-tool-verification-fixture",
  );
  await fs.mkdir(leftover);
  await assert.rejects(
    verifyAgentFiles(agent, "fixture", expected.model, gateway),
    /remove every owned verification directory/u,
  );
  await fs.rmdir(leftover);
});

test("routing readback rejects Codex stale review model at root or active profile", () => {
  for (const profile of [false, true]) {
    const document = codex();
    if (profile) {
      document.profile = "active";
      document.profiles = { active: { review_model: "foreign-review" } };
    } else document.review_model = "foreign-review";
    assert.throws(
      () => assertCodexConfiguration(document, expected),
      /review_model/u,
    );
  }
});

test("routing readback rejects Hermes stale auxiliary tasks", () => {
  for (const task of [
    "compression",
    "title_generation",
    "background_review",
    "review",
  ]) {
    const document = hermes();
    document.auxiliary = Object.fromEntries(
      ["compression", "title_generation", "background_review", "review"].map(
        (name) => [
          name,
          {
            provider: "custom",
            model: expected.model,
            base_url: expected.base,
            key_env: "AE_SWITCH_API_KEY",
            api_mode: "chat_completions",
          },
        ],
      ),
    );
    document.auxiliary[task].model = "foreign-auxiliary";
    assert.throws(
      () => assertHermesConfiguration(document, expected),
      /auxiliary/u,
    );
  }
});

test("routing readback rejects DSH stale inherited workflow overrides", () => {
  const overrides = [
    {
      id: "compaction-basic",
      config: {
        summarizationProvider: "foreign",
        summarizationModel: "foreign",
      },
    },
    {
      id: "compaction-basic",
      config: {
        modelPolicies: [
          {
            provider: "match-parent",
            model: "match-parent",
            summarizationProvider: "foreign",
            summarizationModel: "foreign",
          },
        ],
      },
    },
    {
      id: "tool-subagent",
      config: {
        provider: "spawn",
        agentOptions: { provider: "foreign", model: "foreign" },
      },
    },
    {
      id: "tool-subagent-fork",
      config: {
        provider: "fork",
        agentOptions: { provider: "foreign", model: "foreign" },
      },
    },
  ];
  for (const override of overrides) {
    assert.throws(
      () => assertDshConfiguration([...dsh(), override], expected),
      /auxiliary/u,
    );
  }
});

test("routing readback rejects Zcode stale builtin subagent state", () => {
  for (const name of ["general-purpose", "Explore"]) {
    const state = {
      builtInModelSelectionOverrides: {
        [name]: { providerId: "foreign", modelId: "foreign" },
      },
    };
    assert.throws(
      () => assertZcodeConfiguration(zcode(), builtin(), expected, state),
      /subagent/u,
    );
  }
});

const opencode = () => ({
  model: `ae_switch/${expected.model}`,
  small_model: `ae_switch/${expected.model}`,
  provider: {
    ae_switch: {
      npm: "@ai-sdk/openai-compatible",
      options: {
        baseURL: expected.base,
        apiKey: "{env:AE_SWITCH_API_KEY}",
        headers: {
          Authorization: `Bearer ${expected.token}`,
          "X-Keep": "preserve",
        },
      },
      models: {
        [expected.model]: {
          id: expected.model,
          provider: { npm: "@ai-sdk/openai-compatible" },
          headers: { authorization: `Bearer ${expected.token}` },
          options: { baseURL: "metadata-not-effective", keep: true },
        },
      },
    },
  },
  default_agent: "my-default",
  agent: {
    build: { model: `ae_switch/${expected.model}`, permission: { keep: true } },
    "my-default": { model: `ae_switch/${expected.model}` },
    custom: { model: "foreign/keep" },
  },
});

test("OpenCode readback checks actual default routes, SDK and auth priority", () => {
  const document = opencode();
  const before = structuredClone(document);
  assertOpenCodeConfiguration(document, expected);
  assert.deepEqual(document, before);
  for (const mutate of [
    (doc) => {
      doc.small_model = "foreign/small";
    },
    (doc) => {
      doc.agent.build.model = "foreign/build";
    },
    (doc) => {
      doc.agent["my-default"].model = "foreign/active";
    },
    (doc) => {
      doc.provider.ae_switch.options.headers.Authorization = "Bearer stale";
    },
    (doc) => {
      doc.provider.ae_switch.models[expected.model].headers.authorization =
        "Bearer stale";
    },
    (doc) => {
      doc.provider.ae_switch.models[expected.model].provider.npm =
        "@ai-sdk/anthropic";
    },
    (doc) => {
      doc.provider.ae_switch.models[expected.model].id = "old-model-id";
    },
  ]) {
    const stale = opencode();
    mutate(stale);
    assert.throws(
      () => assertOpenCodeConfiguration(stale, expected),
      /OpenCode/u,
    );
  }
});

test("auxiliary readback preserves disabled tasks, foreign roles and inheritance", () => {
  const hermesDocument = hermes();
  hermesDocument.auxiliary.compression.enabled = false;
  hermesDocument.auxiliary.compression.timeout = 22;
  hermesDocument.auxiliary.compression.extra_body = { keep: true };
  hermesDocument.auxiliary.compression.api_key_env = "AE_SWITCH_API_KEY";
  hermesDocument.auxiliary.compression.api_key = expected.token;
  const codexDocument = {
    ...codex(),
    review_model: expected.model,
    profile: "active",
    profiles: {
      active: { review_model: expected.model },
      inactive: { review_model: "foreign/keep" },
    },
  };
  const state = {
    builtInModelSelectionOverrides: {
      Explore: {
        providerId: "ae_switch",
        modelId: expected.model,
        options: { reasoningLevel: "disabled" },
      },
      custom: { providerId: "foreign", modelId: "keep" },
    },
    permission: { keep: true },
  };
  const plugins = [
    ...dsh(),
    {
      id: "compaction-basic",
      config: {
        summarizationProvider: "",
        summarizationModel: "",
        modelPolicies: [
          {
            provider: "match-parent",
            model: "match-parent",
            summarizationProvider: "ae-switch",
            summarizationModel: expected.model,
          },
        ],
      },
    },
    {
      id: "tool-subagent",
      config: {
        provider: "spawn",
        agentOptions: {
          provider: "ae-switch",
          model: expected.model,
          keep: true,
        },
      },
    },
    {
      id: "tool-subagent-fork",
      config: { provider: "fork", agentOptions: { keep: true } },
    },
  ];
  const before = structuredClone([
    hermesDocument,
    codexDocument,
    state,
    plugins,
  ]);
  assertHermesConfiguration(hermesDocument, expected);
  assertCodexConfiguration(codexDocument, expected);
  assertZcodeConfiguration(zcode(), builtin(), expected, state);
  assertDshConfiguration(plugins, expected);
  assert.deepEqual([hermesDocument, codexDocument, state, plugins], before);
});

test("native driver checks OpenCode auxiliary routes and persisted Zcode state", async () => {
  const openAgent = await agentFixture("opencode", {
    "configuration/opencode.json": JSON.stringify(opencode()),
  });
  await verifyAgentFiles(openAgent, "fixture", expected.model, gateway);
  const zAgent = await agentFixture("zcode", {
    "configuration/zcode-providers.json": JSON.stringify(zcode()),
    "configuration/zcode-builtin.json": JSON.stringify(builtin()),
    "home/.zcode/v2/agents-state.json": JSON.stringify({
      builtInModelSelectionOverrides: {
        Explore: { providerId: "ae_switch", modelId: expected.model },
      },
    }),
  });
  const receipt = await verifyAgentFiles(
    zAgent,
    "fixture",
    expected.model,
    gateway,
  );
  assert.ok(
    receipt.files.some((file) => file.path.endsWith("agents-state.json")),
  );
  await fs.writeFile(
    path.join(zAgent.directory, "home/.zcode/v2/agents-state.json"),
    JSON.stringify({
      builtInModelSelectionOverrides: {
        Explore: { providerId: "foreign", modelId: "stale" },
      },
    }),
  );
  await assert.rejects(
    verifyAgentFiles(zAgent, "fixture", expected.model, gateway),
    /subagent/u,
  );
});

test("Codex auth conflicts fail while legacy bearer metadata is preserved", () => {
  const document = codex();
  Object.assign(document.model_providers.ae_switch, {
    experimental_bearer_token: "legacy-token",
    http_headers: { Authorization: "Bearer legacy" },
    env_http_headers: { Authorization: "LEGACY_ENV_KEY" },
  });
  const before = structuredClone(document);
  assertCodexConfiguration(document, expected);
  assert.deepEqual(document, before);
  for (const key of ["auth", "gateway_oauth", "aws"]) {
    const stale = structuredClone(document);
    stale.model_providers.ae_switch[key] = { type: "external" };
    assert.throws(() => assertCodexConfiguration(stale, expected), /block/u);
  }
});

test("DSH title inheritance stays enabled and explicit route pins are checked", () => {
  const inherited = dsh().filter((row) => row.id !== "session-title-llm");
  assertDshConfiguration(inherited, expected);
  inherited.push({
    id: "session-title-llm",
    disabled: false,
    config: { provider: "ae-switch", model: expected.model, maxTokens: 2000 },
  });
  const before = structuredClone(inherited);
  assertDshConfiguration(inherited, expected);
  assert.deepEqual(inherited, before);
  inherited.at(-1).config.model = "foreign-title";
  assert.throws(
    () => assertDshConfiguration(inherited, expected),
    /auxiliary/u,
  );
});

test("native driver verifies Claude aliases and optional subagent routing without a fresh pin", async () => {
  const base = `http://127.0.0.1:${gateway.port}/agents/selected:claude_code`;
  const environment = {
    ANTHROPIC_MODEL: expected.model,
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_API_KEY: expected.token,
    ...Object.fromEntries(
      ["OPUS", "SONNET", "HAIKU"].map((role) => [
        `ANTHROPIC_DEFAULT_${role}_MODEL`,
        expected.model,
      ]),
    ),
  };
  const configuration = {
    env: { ...environment },
    permissions: { keep: true },
  };
  const agent = await agentFixture(
    "claude_code",
    { "home/.claude/settings.json": JSON.stringify(configuration) },
    environment,
  );
  await verifyAgentFiles(agent, "fixture", expected.model, gateway);
  configuration.env.CLAUDE_CODE_SUBAGENT_MODEL = expected.model;
  const environmentPath = path.join(
    agent.directory,
    "configuration/environment.json",
  );
  const generated = JSON.parse(await fs.readFile(environmentPath, "utf8"));
  generated.CLAUDE_CODE_SUBAGENT_MODEL = expected.model;
  await fs.writeFile(environmentPath, JSON.stringify(generated));
  await fs.writeFile(
    path.join(agent.directory, "home/.claude/settings.json"),
    JSON.stringify(configuration),
  );
  await verifyAgentFiles(agent, "fixture", expected.model, gateway);
  configuration.env.CLAUDE_CODE_SUBAGENT_MODEL = "foreign-subagent";
  await fs.writeFile(
    path.join(agent.directory, "home/.claude/settings.json"),
    JSON.stringify(configuration),
  );
  await assert.rejects(
    verifyAgentFiles(agent, "fixture", expected.model, gateway),
    /subagent model mismatch/u,
  );
});
