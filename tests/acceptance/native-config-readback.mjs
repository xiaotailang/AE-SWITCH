import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const samePath = (left, right) =>
  path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
const within = (directory, location) => {
  const relative = path.relative(directory, location);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
};

// This subprocess only parses bytes. It never imports AE Switch's native merger
// or launches an Agent. -I/-S isolate imports; pure=True excludes ruamel's C loader.
const parserProgram = String.raw`
import hashlib, json, math, os, sys
try:
    location, kind, library = sys.argv[1:4]
    with open(location, "rb") as source:
        content = source.read()
    if kind == "yaml":
        sys.path.insert(0, library)
        from ruamel.yaml import YAML
        parser = YAML(typ="safe", pure=True)
        parser.allow_duplicate_keys = False
        document = parser.load(content.decode("utf-8"))
    elif kind == "toml":
        import tomllib
        document = tomllib.loads(content.decode("utf-8"))
    else:
        raise ValueError("unsupported format")
    def portable(value, parents=(), depth=0):
        if depth > 64 or id(value) in parents:
            raise ValueError("recursive document")
        if isinstance(value, dict):
            if not all(isinstance(key, str) for key in value):
                raise ValueError("non-string mapping key")
            return {key: portable(item, parents + (id(value),), depth + 1) for key, item in value.items()}
        if isinstance(value, list):
            return [portable(item, parents + (id(value),), depth + 1) for item in value]
        if value is None or isinstance(value, (str, bool, int)):
            return value
        if isinstance(value, float) and math.isfinite(value):
            return value
        return ["__ae_parser_scalar_type", type(value).__name__, str(value)]
    modules = []
    for name, module in sorted(sys.modules.items()):
        filename = getattr(module, "__file__", None)
        if filename:
            filename = os.path.realpath(filename)
            with open(filename, "rb") as source:
                module_sha = hashlib.sha256(source.read()).hexdigest()
            modules.append({"name": name, "path": filename, "sha256": module_sha})
    result = {
        "document": portable(document),
        "sha256": hashlib.sha256(content).hexdigest(),
        "executable": os.path.realpath(sys.executable),
        "basePrefix": os.path.realpath(sys.base_prefix),
        "modules": modules,
    }
    print(json.dumps(result, ensure_ascii=True, allow_nan=False))
except Exception:
    print("Owned configuration could not be parsed independently.", file=sys.stderr)
    sys.exit(1)
`;

export async function assertOwnedReadbackPath(workspaceRoot, location) {
  assert.ok(path.isAbsolute(workspaceRoot), "Workspace root must be absolute");
  assert.ok(path.isAbsolute(location), "Readback path must be absolute");
  assert.doesNotMatch(location, /^C:[\\/]/iu, "Readback tools must stay on G");
  assert.ok(within(workspaceRoot, location), "Readback path escaped workspace");
  let current = path.resolve(location);
  while (true) {
    const stat = await fs.lstat(current);
    assert.ok(
      !stat.isSymbolicLink(),
      "Readback paths cannot use links or junctions",
    );
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const physicalRoot = await fs.realpath(workspaceRoot);
  const physical = await fs.realpath(location);
  assert.ok(
    within(physicalRoot, physical),
    "Physical readback path escaped workspace",
  );
  assert.doesNotMatch(physical, /^C:[\\/]/iu);
  return physical;
}

async function manifest(workspaceRoot, directory, include) {
  const physical = await assertOwnedReadbackPath(workspaceRoot, directory);
  assert.ok(
    (await fs.lstat(physical)).isDirectory(),
    "Parser directory is required",
  );
  const files = [];
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const location = path.join(current, entry.name);
      const stat = await fs.lstat(location);
      assert.ok(
        !stat.isSymbolicLink(),
        "Parser manifests cannot contain links",
      );
      if (stat.isDirectory()) {
        if (entry.name !== "__pycache__") await visit(location);
      } else if (include(location)) {
        assert.ok(stat.isFile(), "Parser inputs must be regular files");
        files.push({
          path: location,
          sha256: digest(await fs.readFile(location)),
        });
      }
    }
  }
  await visit(physical);
  files.sort((left, right) => left.path.localeCompare(right.path));
  assert.ok(files.length > 0, "Parser manifest cannot be empty");
  return {
    directory: physical,
    sha256: digest(JSON.stringify(files)),
    fileCount: files.length,
    files,
  };
}

export async function parseOwnedConfiguration({
  workspaceRoot,
  location,
  format,
  expectedSha256,
  pythonDirectory,
  yamlLibraryDirectory,
}) {
  assert.ok(["yaml", "toml"].includes(format), "Unsupported readback format");
  assert.match(
    expectedSha256,
    /^[a-f0-9]{64}$/u,
    "Configuration SHA is required",
  );
  const physical = await assertOwnedReadbackPath(workspaceRoot, location);
  assert.ok(
    (await fs.lstat(physical)).isFile(),
    "Configuration must be a regular file",
  );
  assert.ok(
    digest(await fs.readFile(physical)) === expectedSha256,
    "Configuration SHA changed before parsing",
  );
  const runtime = await manifest(workspaceRoot, pythonDirectory, (file) =>
    /\.(?:py|pyd|dll|exe|zip)$/iu.test(file),
  );
  const executable = await assertOwnedReadbackPath(
    workspaceRoot,
    path.join(runtime.directory, "python.exe"),
  );
  for (const required of ["python.exe", "python3.dll", "python314.dll"]) {
    assert.ok(
      runtime.files.some((file) =>
        samePath(file.path, path.join(runtime.directory, required)),
      ),
      "Packaged Python runtime is incomplete",
    );
  }
  let parser = {
    directory: path.join(runtime.directory, "Lib", "tomllib"),
    files: runtime.files.filter((file) =>
      within(path.join(runtime.directory, "Lib", "tomllib"), file.path),
    ),
  };
  let library = "";
  if (format === "yaml") {
    library = await assertOwnedReadbackPath(
      workspaceRoot,
      yamlLibraryDirectory,
    );
    parser = await manifest(
      workspaceRoot,
      path.join(library, "ruamel"),
      (file) => file.endsWith(".py"),
    );
    assert.ok(
      parser.files.some((file) =>
        samePath(
          file.path,
          path.join(library, "ruamel", "yaml", "__init__.py"),
        ),
      ),
      "Official ruamel parser is required",
    );
  }
  assert.ok(parser.files.length > 0, "Independent parser source is required");
  const recorded = new Map(
    [...runtime.files, ...parser.files].map((file) => [
      path.resolve(file.path).toLowerCase(),
      file.sha256,
    ]),
  );
  // -B prevents writes, and a fresh nonexistent prefix prevents using stale pyc.
  const cachePrefix = path.join(
    path.dirname(physical),
    `.ae-parser-cache-${randomUUID()}`,
  );
  assert.ok(
    !(await fs.stat(cachePrefix).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    )),
    "Parser cache prefix must be fresh",
  );
  let parsed;
  try {
    const { stdout } = await runFile(
      executable,
      [
        "-I",
        "-B",
        "-S",
        "-X",
        `pycache_prefix=${cachePrefix}`,
        "-c",
        parserProgram,
        physical,
        format,
        library,
      ],
      {
        cwd: workspaceRoot,
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("Owned configuration independent parser failed");
  }
  assert.ok(
    parsed.sha256 === expectedSha256,
    "Parser read different configuration bytes",
  );
  assert.ok(
    samePath(parsed.executable, executable),
    "Parser executable changed",
  );
  assert.ok(
    samePath(parsed.basePrefix, runtime.directory),
    "Parser runtime escaped owned directory",
  );
  assert.ok(
    Array.isArray(parsed.modules) && parsed.modules.length > 0,
    "Parser module origins are required",
  );
  for (const module of parsed.modules) {
    await assertOwnedReadbackPath(workspaceRoot, module.path);
    assert.ok(
      recorded.get(path.resolve(module.path).toLowerCase()) === module.sha256,
      "Parser loaded an unrecorded or changed module",
    );
  }
  const afterRuntime = await manifest(
    workspaceRoot,
    runtime.directory,
    (file) => /\.(?:py|pyd|dll|exe|zip)$/iu.test(file),
  );
  assert.ok(
    afterRuntime.sha256 === runtime.sha256,
    "Parser runtime changed during readback",
  );
  if (format === "yaml") {
    const afterParser = await manifest(
      workspaceRoot,
      parser.directory,
      (file) => file.endsWith(".py"),
    );
    assert.ok(
      afterParser.sha256 === parser.sha256,
      "YAML parser changed during readback",
    );
  }
  await assertOwnedReadbackPath(workspaceRoot, physical);
  assert.ok(
    digest(await fs.readFile(physical)) === expectedSha256,
    "Configuration SHA changed after parsing",
  );
  assert.ok(
    !(await fs.stat(cachePrefix).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    )),
    "Parser must not create a cache directory",
  );
  return {
    document: parsed.document,
    proof: {
      configuration: { path: physical, sha256: expectedSha256, format },
      runtime: {
        directory: runtime.directory,
        manifestSha256: runtime.sha256,
        fileCount: runtime.fileCount,
        binaries: runtime.files.filter((file) =>
          /\.(?:exe|dll|pyd)$/iu.test(file.path),
        ),
      },
      parser: {
        name: format === "yaml" ? "ruamel.yaml (safe, pure)" : "stdlib tomllib",
        directory: parser.directory,
        manifestSha256: digest(JSON.stringify(parser.files)),
        fileCount: parser.files.length,
      },
      loadedModules: parsed.modules,
      unchangedBeforeAndAfter: true,
    },
  };
}

function object(value, label) {
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value;
}

export function uniqueSelectedRow(rows, key, id, label) {
  assert.ok(Array.isArray(rows), `${label} must be an array`);
  const selected = rows.filter((row) => object(row, label)[key] === id);
  assert.ok(
    selected.length === 1,
    `${label} must have exactly one selected row`,
  );
  return selected[0];
}

export function assertCodexConfiguration(document, { model, base }) {
  object(document, "Codex configuration");
  let active = {};
  if (Object.hasOwn(document, "profile")) {
    assert.ok(
      typeof document.profile === "string" && document.profile.length > 0,
      "Codex active profile must be named",
    );
    const profiles = object(document.profiles, "Codex profiles");
    assert.ok(
      Object.hasOwn(profiles, document.profile),
      "Codex active profile is missing",
    );
    active = object(profiles[document.profile], "Codex active profile");
  }
  for (const [key, expected] of [
    ["model", model],
    ["model_provider", "ae_switch"],
  ]) {
    assert.ok(document[key] === expected, `Codex root ${key} mismatch`);
    assert.ok(
      (Object.hasOwn(active, key) ? active[key] : document[key]) === expected,
      `Codex effective ${key} mismatch`,
    );
  }
  for (const scope of [document, active]) {
    if (Object.hasOwn(scope, "review_model"))
      assert.equal(scope.review_model, model, "Codex review_model mismatch");
  }
  const provider = object(
    object(document.model_providers, "Codex providers").ae_switch,
    "Codex selected provider",
  );
  for (const key of ["auth", "gateway_oauth", "aws"])
    assert.ok(
      !Object.hasOwn(provider, key),
      `Codex incompatible selected ${key} block`,
    );
  for (const [key, expected] of [
    ["base_url", base],
    ["env_key", "AE_SWITCH_API_KEY"],
    ["wire_api", "responses"],
  ]) {
    assert.ok(
      provider[key] === expected,
      `Codex selected provider ${key} mismatch`,
    );
  }
}

export function assertOpenCodeConfiguration(document, { model, base, token }) {
  object(document, "OpenCode configuration");
  for (const key of ["model", "small_model"])
    assert.equal(
      document[key],
      `ae_switch/${model}`,
      `OpenCode ${key} mismatch`,
    );
  const provider = object(
    object(document.provider, "OpenCode providers").ae_switch,
    "OpenCode selected provider",
  );
  assert.equal(
    provider.npm,
    "@ai-sdk/openai-compatible",
    "OpenCode provider SDK mismatch",
  );
  const options = object(provider.options, "OpenCode provider options");
  assert.equal(options.baseURL, base, "OpenCode selected endpoint mismatch");
  assert.equal(
    options.apiKey,
    "{env:AE_SWITCH_API_KEY}",
    "OpenCode selected key mismatch",
  );
  const selected = object(
    object(provider.models, "OpenCode models")[model],
    "OpenCode selected model",
  );
  if (Object.hasOwn(selected, "id"))
    assert.equal(selected.id, model, "OpenCode effective model id mismatch");
  if (Object.hasOwn(selected, "provider")) {
    const transport = object(selected.provider, "OpenCode model provider");
    if (Object.hasOwn(transport, "npm"))
      assert.equal(
        transport.npm,
        "@ai-sdk/openai-compatible",
        "OpenCode effective SDK mismatch",
      );
  }
  for (const headers of [options.headers, selected.headers]) {
    if (headers === undefined) continue;
    for (const [name, value] of Object.entries(
      object(headers, "OpenCode headers"),
    )) {
      assert.equal(typeof value, "string", "OpenCode headers must be strings");
      if (name.toLowerCase() === "authorization")
        assert.equal(
          value,
          `Bearer ${token}`,
          "OpenCode selected authorization mismatch",
        );
    }
  }
  if (Object.hasOwn(document, "agent")) {
    const agents = object(document.agent, "OpenCode agents");
    for (const [name, configuration] of Object.entries(agents)) {
      if (
        ![
          "build",
          "plan",
          "general",
          "explore",
          "compaction",
          "title",
          "summary",
        ].includes(name) &&
        document.default_agent !== name
      )
        continue;
      object(configuration, "OpenCode active agent");
      if (Object.hasOwn(configuration, "model"))
        assert.equal(
          configuration.model,
          `ae_switch/${model}`,
          `OpenCode ${name} model mismatch`,
        );
    }
  }
}

export function assertHermesConfiguration(document, { model, base, token }) {
  const selected = object(
    object(document, "Hermes configuration").model,
    "Hermes model",
  );
  for (const [key, expected] of [
    ["default", model],
    ["base_url", base],
    ["provider", "custom"],
    ["key_env", "AE_SWITCH_API_KEY"],
    ["api_mode", "chat_completions"],
  ]) {
    assert.ok(selected[key] === expected, `Hermes selected ${key} mismatch`);
  }
  // Official Hermes tries nonempty inline api_key/api before model.key_env.
  for (const key of ["api_key", "api"]) {
    if (typeof selected[key] === "string" && selected[key].trim()) {
      assert.ok(
        selected[key].trim() === token,
        "Hermes inline key overrides gateway",
      );
    }
  }
  const auxiliary = object(document.auxiliary, "Hermes auxiliary");
  for (const task of [
    "compression",
    "title_generation",
    "background_review",
    "review",
  ]) {
    if (task === "review" && !Object.hasOwn(auxiliary, task)) continue;
    const route = object(auxiliary[task], `Hermes auxiliary ${task}`);
    for (const [key, expected] of [
      ["provider", "custom"],
      ["model", model],
      ["base_url", base],
      ["key_env", "AE_SWITCH_API_KEY"],
      ["api_mode", "chat_completions"],
    ])
      assert.equal(
        route[key],
        expected,
        `Hermes auxiliary ${task} ${key} mismatch`,
      );
    if (Object.hasOwn(route, "api_key"))
      assert.equal(
        route.api_key,
        token,
        `Hermes auxiliary ${task} inline key mismatch`,
      );
    if (Object.hasOwn(route, "api_key_env"))
      assert.equal(
        route.api_key_env,
        "AE_SWITCH_API_KEY",
        `Hermes auxiliary ${task} key env mismatch`,
      );
  }
}

export function assertOmpConfiguration(
  document,
  settings,
  { model, base, token },
) {
  const provider = object(
    object(object(document, "OMP models").providers, "OMP providers").ae_switch,
    "OMP selected provider",
  );
  for (const [key, expected] of [
    ["baseUrl", base],
    ["api", "openai-completions"],
    ["apiKey", "AE_SWITCH_API_KEY"],
  ]) {
    assert.ok(
      provider[key] === expected,
      `OMP selected provider ${key} mismatch`,
    );
  }
  const selected = uniqueSelectedRow(
    provider.models,
    "id",
    model,
    "OMP models",
  );
  let override = {};
  if (provider.modelOverrides !== undefined) {
    const overrides = object(provider.modelOverrides, "OMP model overrides");
    if (Object.hasOwn(overrides, model))
      override = object(overrides[model], "OMP selected model override");
  }
  assert.ok(
    (selected.baseUrl ?? provider.baseUrl) === base,
    "OMP effective model endpoint mismatch",
  );
  assert.ok(
    (override.api ?? selected.api ?? provider.api) === "openai-completions",
    "OMP effective model API mismatch",
  );
  for (const headers of [
    provider.headers,
    selected.headers,
    override.headers,
  ]) {
    if (headers === undefined) continue;
    for (const [name, value] of Object.entries(
      object(headers, "OMP selected headers"),
    )) {
      assert.ok(typeof value === "string", "OMP headers must be strings");
      if (name.toLowerCase() === "authorization")
        assert.ok(
          value === `Bearer ${token}`,
          "OMP selected authorization mismatch",
        );
    }
  }
  const roles = object(
    object(settings, "OMP settings").modelRoles,
    "OMP model roles",
  );
  for (const role of [
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
  ]) {
    assert.ok(
      roles[role] === `ae_switch/${model}`,
      `OMP ${role} model mismatch`,
    );
  }
}

export function assertWorkBuddyConfiguration(document, { model, base, token }) {
  const selected = uniqueSelectedRow(document, "id", model, "WorkBuddy models");
  assert.ok(selected.url === base, "WorkBuddy selected endpoint mismatch");
  assert.ok(selected.apiKey === token, "WorkBuddy selected key mismatch");
  assert.ok(
    selected.vendor === undefined || selected.vendor === "",
    "WorkBuddy selected vendor overrides gateway",
  );
  assert.ok(
    selected.useCustomProtocol === undefined ||
      selected.useCustomProtocol === false,
    "WorkBuddy selected protocol overrides gateway",
  );
}

export function assertZcodeConfiguration(
  document,
  builtin,
  { model, base, token },
  state,
) {
  const options = (route) => {
    if (!Object.hasOwn(route, "options")) return;
    const values = object(route.options, "Zcode selection options");
    assert.ok(
      Object.keys(values).every((key) => key === "reasoningLevel"),
      "Zcode unsupported selection options",
    );
    if (Object.hasOwn(values, "reasoningLevel"))
      assert.equal(
        typeof values.reasoningLevel,
        "string",
        "Zcode invalid reasoningLevel",
      );
  };
  const configuration = object(
    object(document, "Zcode configuration").config,
    "Zcode config",
  );
  const selection = object(
    configuration.defaultModelSelection,
    "Zcode model selection",
  );
  assert.ok(
    selection.providerId === "ae_switch" && selection.modelId === model,
    "Zcode selected model mismatch",
  );
  options(selection);
  const provider = uniqueSelectedRow(
    object(configuration.providerConfigRules, "Zcode provider rules")
      .providerRules,
    "providerId",
    "ae_switch",
    "Zcode personal providers",
  );
  assert.ok(provider.enabled !== false, "Zcode selected provider is disabled");
  const selected = object(provider.config, "Zcode selected configuration");
  const api = object(selected.api, "Zcode selected API");
  const access = object(selected.access, "Zcode selected access");
  assert.ok(
    api.baseUrl === base && api.type === "openai-chat-completions",
    "Zcode selected endpoint mismatch",
  );
  assert.ok(
    access.apiKey === token && access.type === "api-key",
    "Zcode selected key mismatch",
  );
  assert.ok(
    Array.isArray(selected.personalModelIds) &&
      selected.personalModelIds.includes(model),
    "Zcode selected model is missing",
  );
  const rules = object(
    object(object(builtin, "Zcode builtin").config, "Zcode builtin config")
      .providerConfigRules,
    "Zcode builtin providers",
  ).providerRules;
  assert.ok(Array.isArray(rules), "Zcode builtin providers must be an array");
  for (const row of rules) object(row, "Zcode builtin provider");
  if (state !== undefined) {
    object(state, "Zcode subagent state");
    if (Object.hasOwn(state, "builtInModelSelectionOverrides")) {
      const overrides = object(
        state.builtInModelSelectionOverrides,
        "Zcode subagent overrides",
      );
      for (const name of ["general-purpose", "Explore"]) {
        if (!Object.hasOwn(overrides, name)) continue;
        const route = object(overrides[name], `Zcode subagent ${name}`);
        options(route);
        assert.ok(
          route.providerId === "ae_switch" && route.modelId === model,
          `Zcode subagent ${name} model mismatch`,
        );
      }
    }
  }
}

export function assertDshConfiguration(plugins, { model, base, token }) {
  const providerPlugin = uniqueSelectedRow(
    plugins,
    "id",
    "llm-pi-ai",
    "DSH plugins",
  );
  const defaultPlugin = uniqueSelectedRow(
    plugins,
    "id",
    "agent-default-model",
    "DSH plugins",
  );
  assert.ok(
    providerPlugin.disabled !== true && defaultPlugin.disabled !== true,
    "DSH selected plugins are disabled",
  );
  const provider = object(
    object(
      object(providerPlugin.config, "DSH LLM config").providers,
      "DSH providers",
    )["ae-switch"],
    "DSH selected provider",
  );
  for (const [key, expected] of [
    ["api", "openai-completions"],
    ["baseURL", base],
    ["apiKeyEnv", "AE_GATEWAY_TOKEN"],
  ]) {
    assert.ok(
      provider[key] === expected,
      `DSH selected provider ${key} mismatch`,
    );
  }
  uniqueSelectedRow(provider.models, "id", model, "DSH provider models");
  const selection = object(defaultPlugin.config, "DSH selected model");
  assert.ok(
    selection.provider === "ae-switch" && selection.model === model,
    "DSH default model mismatch",
  );
  const pair = (value, providerKey, modelKey, allowEmpty = false) => {
    object(value, "DSH auxiliary route");
    if (!Object.hasOwn(value, providerKey) && !Object.hasOwn(value, modelKey))
      return;
    if (allowEmpty && value[providerKey] === "" && value[modelKey] === "")
      return;
    assert.ok(
      value[providerKey] === "ae-switch" && value[modelKey] === model,
      "DSH auxiliary model mismatch",
    );
  };
  for (const row of plugins) {
    if (!Object.hasOwn(row, "config")) continue;
    if (row.id === "compaction-basic") {
      pair(row.config, "summarizationProvider", "summarizationModel", true);
      if (Object.hasOwn(row.config, "modelPolicies")) {
        assert.ok(
          Array.isArray(row.config.modelPolicies),
          "DSH auxiliary policies must be an array",
        );
        for (const policy of row.config.modelPolicies)
          pair(policy, "summarizationProvider", "summarizationModel", true);
      }
    } else if (row.id === "session-title-llm") {
      pair(row.config, "provider", "model");
    } else if (["tool-subagent", "tool-subagent-fork"].includes(row.id)) {
      if (Object.hasOwn(row.config, "agentOptions"))
        pair(row.config.agentOptions, "provider", "model");
    }
  }
  if (provider.headers !== undefined) {
    for (const [name, value] of Object.entries(
      object(provider.headers, "DSH headers"),
    )) {
      assert.ok(typeof value === "string", "DSH headers must be strings");
      if (name.toLowerCase() === "authorization")
        assert.ok(
          value === `Bearer ${token}`,
          "DSH selected authorization mismatch",
        );
    }
  }
  for (const id of ["session-log-deepseek", "session-telemetry-otel"]) {
    assert.ok(
      uniqueSelectedRow(plugins, "id", id, "DSH plugins").disabled === true,
      "DSH remote logging and telemetry must remain disabled in the fresh private fixture",
    );
  }
}
