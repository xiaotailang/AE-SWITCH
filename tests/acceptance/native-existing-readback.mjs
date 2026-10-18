import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import {
  assertOwnedReadbackPath,
  assertWorkBuddyConfiguration,
  parseOwnedConfiguration,
  uniqueSelectedRow,
} from "./native-config-readback.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const object = (value, label) => {
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value;
};
const field = (document, key, expected, label) => {
  assert.ok(document[key] === expected, `${label} ${key} mismatch`);
};

const profilePathFields = new Set([
  "directory",
  "homeDirectory",
  "executablePath",
  "workspaceDirectory",
  "configFile",
  "secondaryConfigFile",
  "dataDirectory",
  "builtinConfigFile",
  "stateFile",
]);

export function assertExistingProfileEquivalent(actual, expected) {
  object(actual, "Persisted existing profile");
  expected = JSON.parse(
    JSON.stringify(object(expected, "Existing profile fixture")),
  );
  assert.deepEqual(
    Object.keys(actual).sort(),
    Object.keys(expected).sort(),
    "Persisted profile fields changed",
  );
  for (const name of Object.keys(expected)) {
    let left = actual[name];
    let right = expected[name];
    if (profilePathFields.has(name) && right !== null) {
      assert.ok(typeof left === "string" && path.isAbsolute(left));
      assert.ok(typeof right === "string" && path.isAbsolute(right));
      left = path.resolve(left);
      right = path.resolve(right);
      if (process.platform === "win32") {
        left = left.toLowerCase();
        right = right.toLowerCase();
      }
    }
    assert.ok(isDeepStrictEqual(left, right), "Persisted profile changed");
  }
}
const headers = (value, token, label) => {
  if (value === undefined) return;
  for (const [name, content] of Object.entries(object(value, label))) {
    assert.ok(typeof content === "string", `${label} values must be strings`);
    if (name.toLowerCase() === "authorization") {
      assert.ok(
        content === `Bearer ${token}`,
        `${label} authorization mismatch`,
      );
    }
  }
};
const pair = (value, providerKey, modelKey, model, allowEmpty = false) => {
  object(value, "Auxiliary route");
  if (!Object.hasOwn(value, providerKey) && !Object.hasOwn(value, modelKey))
    return;
  if (allowEmpty && value[providerKey] === "" && value[modelKey] === "") return;
  field(value, providerKey, "ae-switch", "DSH auxiliary");
  field(value, modelKey, model, "DSH auxiliary");
};

// These assertions describe the original clients' persisted native format.
// They deliberately do not accept a launcher's environment as authentication.
export function assertExistingAgentConfiguration(
  agent,
  documents,
  { model, base, token },
) {
  assert.ok(
    typeof token === "string" && token.length > 0,
    "Gateway token is required",
  );
  const configuration = documents.config;
  switch (agent) {
    case "claude_code": {
      const env = object(
        object(configuration, "Claude settings").env,
        "Claude native env",
      );
      for (const [key, expected] of Object.entries({
        ANTHROPIC_BASE_URL: base,
        ANTHROPIC_API_KEY: token,
        ANTHROPIC_MODEL: model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      }))
        field(env, key, expected, "Claude native env");
      for (const key of [
        "CLAUDE_CODE_SUBAGENT_MODEL",
        "ANTHROPIC_SMALL_FAST_MODEL",
      ])
        if (Object.hasOwn(env, key))
          field(env, key, model, "Claude existing role");
      for (const key of [
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
        "CLAUDE_CODE_USE_ANTHROPIC_AWS",
        "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
        "CLAUDE_CODE_USE_MANTLE",
        "CLAUDE_CODE_USE_GATEWAY",
        "ANTHROPIC_UNIX_SOCKET",
      ])
        assert.ok(
          !Object.hasOwn(env, key),
          "Claude native transport override remains",
        );
      if (Object.hasOwn(env, "ANTHROPIC_CUSTOM_HEADERS")) {
        assert.ok(
          typeof env.ANTHROPIC_CUSTOM_HEADERS === "string",
          "Claude custom headers must be text",
        );
        for (const line of env.ANTHROPIC_CUSTOM_HEADERS.split(/\r?\n/u)) {
          const match = /^\s*([^:]+):\s*(.*)$/u.exec(line);
          if (!match) continue;
          const name = match[1].trim().toLowerCase();
          if (name === "authorization")
            assert.ok(
              match[2] === `Bearer ${token}`,
              "Claude custom authorization mismatch",
            );
          if (name === "x-api-key")
            assert.ok(match[2] === token, "Claude custom API key mismatch");
        }
      }
      break;
    }
    case "codex": {
      object(configuration, "Codex config");
      field(configuration, "model", model, "Codex root");
      field(configuration, "model_provider", "ae_switch", "Codex root");
      const active =
        configuration.profile === undefined
          ? {}
          : object(
              object(configuration.profiles, "Codex profiles")[
                configuration.profile
              ],
              "Codex active profile",
            );
      for (const scope of [configuration, active]) {
        for (const [key, expected] of [
          ["model", model],
          ["model_provider", "ae_switch"],
          ["review_model", model],
        ])
          if (Object.hasOwn(scope, key))
            field(scope, key, expected, "Codex effective route");
      }
      const provider = object(
        object(configuration.model_providers, "Codex providers").ae_switch,
        "Codex native provider",
      );
      for (const [key, expected] of [
        ["base_url", base],
        ["wire_api", "responses"],
        ["requires_openai_auth", false],
        ["experimental_bearer_token", token],
      ])
        field(provider, key, expected, "Codex native provider");
      for (const key of ["env_key", "auth", "gateway_oauth", "aws"])
        assert.ok(
          !Object.hasOwn(provider, key),
          "Codex selected provider has competing authentication",
        );
      break;
    }
    case "oh_my_pi": {
      const provider = object(
        object(object(configuration, "OMP models").providers, "OMP providers")
          .ae_switch,
        "OMP native provider",
      );
      for (const [key, expected] of [
        ["baseUrl", base],
        ["api", "openai-completions"],
        ["apiKey", token],
      ])
        field(provider, key, expected, "OMP native provider");
      const selected = uniqueSelectedRow(
        provider.models,
        "id",
        model,
        "OMP models",
      );
      const override = provider.modelOverrides?.[model] ?? {};
      assert.ok(
        (selected.baseUrl ?? provider.baseUrl) === base,
        "OMP model overrides endpoint",
      );
      assert.ok(
        (override.api ?? selected.api ?? provider.api) === "openai-completions",
        "OMP model overrides API",
      );
      for (const value of [
        provider.headers,
        selected.headers,
        override.headers,
      ])
        headers(value, token, "OMP headers");
      const roles = object(
        object(documents.secondary, "OMP settings").modelRoles,
        "OMP roles",
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
      ])
        field(roles, role, `ae_switch/${model}`, "OMP role");
      break;
    }
    case "opencode": {
      object(configuration, "OpenCode config");
      for (const key of ["model", "small_model"])
        field(configuration, key, `ae_switch/${model}`, "OpenCode route");
      assert.ok(
        !configuration.disabled_providers?.includes("ae_switch"),
        "OpenCode selected provider disabled",
      );
      if (configuration.enabled_providers !== undefined)
        assert.ok(
          configuration.enabled_providers.includes("ae_switch"),
          "OpenCode selected provider not allowed",
        );
      const provider = object(
        object(configuration.provider, "OpenCode providers").ae_switch,
        "OpenCode native provider",
      );
      field(provider, "npm", "@ai-sdk/openai-compatible", "OpenCode provider");
      const options = object(provider.options, "OpenCode options");
      field(options, "baseURL", base, "OpenCode options");
      field(options, "apiKey", token, "OpenCode native authentication");
      const selected = object(
        object(provider.models, "OpenCode models")[model],
        "OpenCode selected model",
      );
      if (Object.hasOwn(selected, "id"))
        field(selected, "id", model, "OpenCode model");
      if (selected.provider?.npm !== undefined)
        field(
          selected.provider,
          "npm",
          "@ai-sdk/openai-compatible",
          "OpenCode model provider",
        );
      for (const value of [options.headers, selected.headers])
        headers(value, token, "OpenCode headers");
      for (const [name, value] of Object.entries(configuration.agent ?? {})) {
        if (
          [
            "build",
            "plan",
            "general",
            "explore",
            "compaction",
            "title",
            "summary",
            configuration.default_agent,
          ].includes(name) &&
          Object.hasOwn(value, "model")
        )
          field(
            value,
            "model",
            `ae_switch/${model}`,
            "OpenCode auxiliary route",
          );
      }
      break;
    }
    case "hermes": {
      const selected = object(
        object(configuration, "Hermes config").model,
        "Hermes model",
      );
      for (const [key, expected] of [
        ["default", model],
        ["provider", "custom"],
        ["base_url", base],
        ["api_mode", "chat_completions"],
        ["api_key", token],
      ])
        field(selected, key, expected, "Hermes native model");
      if (Object.hasOwn(selected, "api"))
        field(selected, "api", token, "Hermes legacy key");
      const auxiliary = object(configuration.auxiliary, "Hermes auxiliary");
      for (const name of [
        "compression",
        "title_generation",
        "background_review",
        "review",
      ]) {
        if (name === "review" && !Object.hasOwn(auxiliary, name)) continue;
        const value = object(auxiliary[name], "Hermes auxiliary task");
        for (const [key, expected] of [
          ["model", model],
          ["provider", "custom"],
          ["base_url", base],
          ["api_mode", "chat_completions"],
          ["api_key", token],
        ])
          field(value, key, expected, "Hermes native auxiliary");
      }
      break;
    }
    case "workbuddy": {
      assertWorkBuddyConfiguration(
        Array.isArray(configuration)
          ? configuration
          : object(configuration, "WorkBuddy config").models,
        { model, base, token },
      );
      break;
    }
    case "zcode": {
      const config = object(
        object(configuration, "ZCode document").config,
        "ZCode config",
      );
      const selection = object(config.defaultModelSelection, "ZCode selection");
      field(selection, "providerId", "ae_switch", "ZCode default route");
      field(selection, "modelId", model, "ZCode default route");
      const row = uniqueSelectedRow(
        object(config.providerConfigRules, "ZCode providers").providerRules,
        "providerId",
        "ae_switch",
        "ZCode native providers",
      );
      assert.ok(row.enabled !== false, "ZCode selected provider disabled");
      const selected = object(row.config, "ZCode selected provider");
      const api = object(selected.api, "ZCode API");
      field(api, "type", "openai-chat-completions", "ZCode API");
      field(api, "baseUrl", base, "ZCode API");
      const access = object(selected.access, "ZCode access");
      field(access, "type", "api-key", "ZCode native authentication");
      field(access, "apiKey", token, "ZCode native authentication");
      assert.ok(
        selected.personalModelIds?.includes(model),
        "ZCode selected model missing",
      );
      for (const [name, route] of Object.entries(
        documents.state?.builtInModelSelectionOverrides ?? {},
      )) {
        if (!["general-purpose", "Explore"].includes(name)) continue;
        field(
          object(route, "ZCode auxiliary route"),
          "providerId",
          "ae_switch",
          "ZCode auxiliary route",
        );
        field(route, "modelId", model, "ZCode auxiliary route");
      }
      break;
    }
    case "deepseek_harness": {
      const llm = uniqueSelectedRow(
        configuration,
        "id",
        "llm-pi-ai",
        "DSH plugins",
      );
      const defaultModel = uniqueSelectedRow(
        configuration,
        "id",
        "agent-default-model",
        "DSH plugins",
      );
      assert.ok(
        llm.disabled !== true && defaultModel.disabled !== true,
        "DSH selected plugins disabled",
      );
      const provider = object(
        object(object(llm.config, "DSH LLM").providers, "DSH providers")[
          "ae-switch"
        ],
        "DSH native provider",
      );
      field(provider, "api", "openai-completions", "DSH provider");
      field(provider, "baseURL", base, "DSH provider");
      assert.ok(
        typeof provider.apiKeyEnv === "string" &&
          /^AE_SWITCH_[A-F0-9]{16}_API_KEY$/u.test(provider.apiKeyEnv),
        "DSH must use a native profile credential reference",
      );
      const credentials = object(documents.secondary, "DSH native credentials");
      field(credentials, "version", 1, "DSH credential schema");
      field(
        object(credentials.refs, "DSH credential refs"),
        provider.apiKeyEnv,
        token,
        "DSH persistent credential",
      );
      uniqueSelectedRow(provider.models, "id", model, "DSH models");
      const defaultRoute = object(defaultModel.config, "DSH default model");
      field(defaultRoute, "provider", "ae-switch", "DSH default route");
      field(defaultRoute, "model", model, "DSH default route");
      headers(provider.headers, token, "DSH headers");
      for (const row of configuration) {
        if (row.id === "credentials")
          assert.ok(
            row.disabled !== true &&
              (row.name === undefined ||
                row.name === "@deepseek-ai/dsh-credentials-local"),
            "DSH credential plugin disabled or replaced",
          );
        if (!row.config) continue;
        if (row.id === "compaction-basic") {
          pair(
            row.config,
            "summarizationProvider",
            "summarizationModel",
            model,
            true,
          );
          for (const policy of row.config.modelPolicies ?? [])
            pair(
              policy,
              "summarizationProvider",
              "summarizationModel",
              model,
              true,
            );
        } else if (row.id === "session-title-llm")
          pair(row.config, "provider", "model", model);
        else if (
          ["tool-subagent", "tool-subagent-fork"].includes(row.id) &&
          row.config.agentOptions
        )
          pair(row.config.agentOptions, "provider", "model", model);
      }
      break;
    }
    default:
      throw new Error("Unsupported existing agent");
  }
  return true;
}

function nativePaths(agent, profile) {
  const config = (name) =>
    profile.configFile ?? path.join(profile.directory, name);
  switch (agent) {
    case "claude_code":
      return { config: config("settings.json") };
    case "codex":
      return { config: config("config.toml") };
    case "hermes":
      return { config: config("config.yaml") };
    case "oh_my_pi":
      return {
        config: config("models.yml"),
        secondary:
          profile.secondaryConfigFile ??
          path.join(profile.directory, "config.yml"),
      };
    case "opencode":
      return { config: config("opencode.json") };
    case "workbuddy":
      return { config: config("models.json") };
    case "zcode":
      return {
        config: config("provider_config.json"),
        ...(profile.builtinConfigFile
          ? { builtin: profile.builtinConfigFile }
          : {}),
        ...(profile.stateFile ? { state: profile.stateFile } : {}),
      };
    case "deepseek_harness":
      return {
        config: config("cordis.patch.yml"),
        secondary:
          profile.secondaryConfigFile ??
          path.join(
            profile.dataDirectory ?? path.join(profile.homeDirectory, ".dsh"),
            ".credentials.yaml",
          ),
      };
    default:
      throw new Error("Unsupported existing agent");
  }
}

// Use the already-installed TypeScript parser as an independent JSONC reader.
// AST checks reject duplicate keys and non-JSON expressions without evaluating them.
export function parseExistingJson(text, ts) {
  const tree = ts.parseJsonText("native.jsonc", text);
  assert.ok(tree.parseDiagnostics.length === 0, "Native JSONC syntax invalid");
  const jsonString = (value) => {
    assert.doesNotThrow(
      () => JSON.parse(value.getText(tree)),
      "Native JSONC string syntax invalid",
    );
  };
  const jsonNumber = (value) => {
    assert.match(
      value.getText(tree),
      /^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u,
      "Native JSONC number syntax invalid",
    );
  };
  const visit = (value) => {
    if (ts.isObjectLiteralExpression(value)) {
      const names = new Set();
      for (const entry of value.properties) {
        assert.ok(
          ts.isPropertyAssignment(entry) && ts.isStringLiteral(entry.name),
          "Native JSONC properties must be quoted",
        );
        assert.ok(!names.has(entry.name.text), "Native JSONC duplicate key");
        jsonString(entry.name);
        names.add(entry.name.text);
        visit(entry.initializer);
      }
    } else if (ts.isArrayLiteralExpression(value))
      value.elements.forEach(visit);
    else if (ts.isStringLiteral(value)) jsonString(value);
    else if (ts.isNumericLiteral(value)) jsonNumber(value);
    else if (
      [
        ts.SyntaxKind.TrueKeyword,
        ts.SyntaxKind.FalseKeyword,
        ts.SyntaxKind.NullKeyword,
      ].includes(value.kind)
    )
      return;
    else if (
      ts.isPrefixUnaryExpression(value) &&
      value.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(value.operand)
    )
      jsonNumber(value.operand);
    else assert.fail("Native JSONC contains a non-JSON expression");
  };
  assert.ok(
    tree.statements.length === 1 &&
      ts.isExpressionStatement(tree.statements[0]),
    "Native JSONC must contain one document",
  );
  visit(tree.statements[0].expression);
  const arrayRoot = ts.isArrayLiteralExpression(tree.statements[0].expression);
  const parsed = ts.parseConfigFileTextToJson(
    "native.jsonc",
    arrayRoot ? `{"ae_switch_native_document": ${text}\n}` : text,
  );
  assert.ok(!parsed.error, "Native JSONC parse failed");
  return arrayRoot ? parsed.config.ae_switch_native_document : parsed.config;
}

export async function verifyExistingAgentFiles({
  workspaceRoot,
  nativeRoot,
  agent,
  providerId,
  model,
  gateway,
  fixture,
  assertPhysicalWorkspacePath = (location) =>
    assertOwnedReadbackPath(workspaceRoot, location),
}) {
  const profile = object(fixture.profiles?.[agent], "Existing profile fixture");
  const check = async (location) => {
    await assertOwnedReadbackPath(workspaceRoot, location);
    await assertPhysicalWorkspacePath(location);
    return location;
  };
  const selectedPath = await check(
    path.join(nativeRoot, "agent-selection.json"),
  );
  const selected = JSON.parse(await fs.readFile(selectedPath, "utf8"))[agent];
  assert.ok(
    selected?.providerId === providerId && selected.model === model,
    "Persisted existing selection mismatch",
  );
  assertExistingProfileEquivalent(selected.profile, profile);
  if (agent === "zcode")
    assert.ok(
      typeof profile.stateFile === "string",
      "ZCode actual auxiliary state path must be resolved",
    );
  // pnpm's known dependency link is resolved before checking the physical
  // parser. User configuration paths continue to reject every linked ancestor.
  const parserPath = await check(
    await fs.realpath(
      path.join(workspaceRoot, "app/node_modules/typescript/lib/typescript.js"),
    ),
  );
  const ts = createRequire(import.meta.url)(parserPath);
  const documents = {};
  const files = [];
  for (const [slot, location] of Object.entries(nativePaths(agent, profile))) {
    try {
      await fs.lstat(location);
    } catch (error) {
      if (error.code === "ENOENT" && slot === "state") continue;
      throw new Error(`Native ${slot} file is missing`);
    }
    await check(location);
    const bytes = await fs.readFile(location);
    const digest = sha256(bytes);
    let proof;
    const format =
      agent === "codex"
        ? "toml"
        : ["hermes", "oh_my_pi", "deepseek_harness"].includes(agent)
          ? "yaml"
          : "json";
    if (format === "json") {
      documents[slot] = parseExistingJson(bytes.toString("utf8"), ts);
      proof = {
        parser: "TypeScript JSONC AST",
        parserPath,
        parserSha256: sha256(await fs.readFile(parserPath)),
      };
    } else {
      const parsed = await parseOwnedConfiguration({
        workspaceRoot,
        location,
        format,
        expectedSha256: digest,
        pythonDirectory: fixture.pythonDirectory,
        yamlLibraryDirectory: fixture.yamlLibraryDirectory,
      });
      documents[slot] = parsed.document;
      proof = parsed.proof;
    }
    assert.ok(
      sha256(await fs.readFile(location)) === digest,
      "Native config changed during readback",
    );
    files.push({ slot, path: location, sha256: digest, proof });
  }
  assertExistingAgentConfiguration(agent, documents, {
    model,
    base: gateway.baseUrl,
    token: gateway.token,
  });
  for (const file of fixture.preservedFiles ?? []) {
    await check(file.path);
    assert.ok(
      sha256(await fs.readFile(file.path)) === file.sha256,
      "Original history or unrelated file changed",
    );
  }
  const privateDirectory = path.join(nativeRoot, "agents", agent);
  assert.ok(
    !(await fs.stat(privateDirectory).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    )),
    "Existing mode created a private client profile or wrapper",
  );
  for (const filename of [
    "agent-native-configuration.pending.json",
    "agent-configuration.pending.json",
  ])
    assert.ok(
      !(await fs.stat(path.join(nativeRoot, filename)).then(
        () => true,
        (error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      )),
      "Configuration transaction not settled",
    );
  return {
    agent,
    nativeAuthentication: true,
    modelRoutesVerified: true,
    originalProfileMatched: true,
    preservedFileCount: fixture.preservedFiles?.length ?? 0,
    noPrivateWrapper: true,
    transactionSettled: true,
    files,
    desktopDefaultSelectionVerified: agent === "workbuddy" ? false : undefined,
    clientStarted: false,
  };
}
