import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  assertExistingAgentConfiguration,
  parseExistingJson,
  verifyExistingAgentFiles,
} from "./native-existing-readback.mjs";
import { assertOwnedReadbackPath } from "./native-config-readback.mjs";

const workspaceRoot = path.resolve(process.cwd());
const ts = createRequire(import.meta.url)(
  path.join(workspaceRoot, "app/node_modules/typescript/lib/typescript.js"),
);
const expected = {
  model: "selected-existing-model",
  base: "http://127.0.0.1:19872/agents/selected:test/v1",
  token: "synthetic-native-test-token",
};
const route = `ae_switch/${expected.model}`;
const dshRef = "AE_SWITCH_0011223344556677_API_KEY";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fixtures = () => ({
  claude_code: {
    config: {
      apiKeyHelper: "original-user-helper",
      permissions: { defaultMode: "ask" },
      env: {
        ANTHROPIC_API_KEY: expected.token,
        ANTHROPIC_BASE_URL: expected.base,
        ANTHROPIC_MODEL: expected.model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: expected.model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: expected.model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: expected.model,
        ANTHROPIC_SMALL_FAST_MODEL: expected.model,
        ANTHROPIC_CUSTOM_HEADERS: `X-User: keep\r\nAuthorization: Bearer ${expected.token}\r\nx-api-key: ${expected.token}`,
        USER_FLAG: "keep",
      },
    },
  },
  codex: {
    config: {
      model: expected.model,
      model_provider: "ae_switch",
      profile: "existing",
      profiles: {
        existing: {
          model: expected.model,
          review_model: expected.model,
          model_provider: "ae_switch",
          permission: "keep",
        },
        other: { model: "user-model" },
      },
      model_providers: {
        ae_switch: {
          base_url: expected.base,
          wire_api: "responses",
          requires_openai_auth: false,
          experimental_bearer_token: expected.token,
        },
      },
    },
  },
  oh_my_pi: {
    config: {
      providers: {
        ae_switch: {
          baseUrl: expected.base,
          api: "openai-completions",
          apiKey: expected.token,
          models: [{ id: expected.model, baseUrl: expected.base }],
          headers: {
            Authorization: `Bearer ${expected.token}`,
            "User-Header": "keep",
          },
        },
      },
    },
    secondary: {
      modelRoles: Object.fromEntries(
        [
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
        ].map((role) => [role, route]),
      ),
    },
  },
  opencode: {
    config: {
      model: route,
      small_model: route,
      provider: {
        ae_switch: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: expected.base, apiKey: expected.token },
          models: { [expected.model]: { id: expected.model } },
        },
      },
      agent: { compaction: { model: route }, user: { model: "user/model" } },
    },
  },
  hermes: {
    config: {
      model: {
        default: expected.model,
        provider: "custom",
        base_url: expected.base,
        api_mode: "chat_completions",
        api_key: expected.token,
      },
      auxiliary: Object.fromEntries(
        ["compression", "title_generation", "background_review"].map((name) => [
          name,
          {
            model: expected.model,
            provider: "custom",
            base_url: expected.base,
            api_mode: "chat_completions",
            api_key: expected.token,
            enabled: false,
            timeout: 42,
          },
        ]),
      ),
    },
  },
  workbuddy: {
    config: {
      models: [
        { id: "user-model", apiKey: "user-key" },
        {
          id: expected.model,
          apiKey: expected.token,
          url: expected.base,
        },
      ],
      preferences: { theme: "user" },
    },
  },
  zcode: {
    config: {
      schemaVersion: 1,
      config: {
        defaultModelSelection: {
          providerId: "ae_switch",
          modelId: expected.model,
          options: { reasoningLevel: "user-value" },
        },
        providerConfigRules: {
          providerRules: [
            {
              providerId: "ae_switch",
              enabled: true,
              config: {
                api: {
                  type: "openai-chat-completions",
                  baseUrl: expected.base,
                },
                access: { type: "api-key", apiKey: expected.token },
                personalModelIds: [expected.model],
              },
            },
          ],
        },
      },
    },
    state: {
      disabledAgentIds: ["user-disabled"],
      builtInModelSelectionOverrides: {
        Explore: {
          providerId: "ae_switch",
          modelId: expected.model,
          options: { reasoningLevel: "user-value" },
        },
      },
    },
  },
  deepseek_harness: {
    config: [
      {
        id: "llm-pi-ai",
        config: {
          providers: {
            "ae-switch": {
              api: "openai-completions",
              baseURL: expected.base,
              apiKeyEnv: dshRef,
              models: [{ id: expected.model }],
            },
          },
        },
      },
      {
        id: "agent-default-model",
        config: { provider: "ae-switch", model: expected.model },
      },
      { id: "session-telemetry-otel", disabled: false },
      {
        id: "compaction-basic",
        config: {
          summarizationProvider: "ae-switch",
          summarizationModel: expected.model,
        },
      },
    ],
    secondary: {
      version: 1,
      refs: { [dshRef]: expected.token, USER_KEY: "preserved" },
      records: { "user/provider": { kind: "grant", payload: { keep: true } } },
    },
  },
});

for (const agent of Object.keys(fixtures())) {
  test(`${agent} accepts native persisted auth and auxiliary routes without altering unrelated values`, () => {
    const documents = fixtures()[agent];
    const before = structuredClone(documents);
    assert.equal(
      assertExistingAgentConfiguration(agent, documents, expected),
      true,
    );
    assert.deepEqual(documents, before);
  });
}

for (const [label, flag] of [
  ["absent", undefined],
  ["true", true],
  ["false", false],
]) {
  test(`WorkBuddy accepts the official compatible route with useChatCompletions ${label} and preserves user capabilities`, () => {
    const documents = fixtures().workbuddy;
    const selected = documents.config.models[1];
    if (flag !== undefined) selected.useChatCompletions = flag;
    Object.assign(selected, {
      supportsToolCall: false,
      supportsImages: true,
      supportsReasoning: true,
      useCustomProtocol: false,
      customUserPreference: { keep: true },
    });
    for (const config of [documents.config, documents.config.models]) {
      const input = { config };
      const before = structuredClone(input);
      assert.equal(
        assertExistingAgentConfiguration("workbuddy", input, expected),
        true,
      );
      assert.deepEqual(input, before);
    }
  });
}

for (const [label, override] of [
  ["vendor", { vendor: "anthropic" }],
  ["custom protocol", { useCustomProtocol: true }],
]) {
  test(`WorkBuddy rejects a selected ${label} that overrides the compatible gateway route`, () => {
    const documents = fixtures().workbuddy;
    Object.assign(documents.config.models[1], {
      useChatCompletions: true,
      ...override,
    });
    assert.throws(
      () => assertExistingAgentConfiguration("workbuddy", documents, expected),
      /vendor overrides gateway|protocol overrides gateway/u,
    );
  });
}

test("existing authentication rejects legacy env-only credentials in every applicable native format", () => {
  const cases = [
    [
      "codex",
      (d) => {
        delete d.config.model_providers.ae_switch.experimental_bearer_token;
        d.config.model_providers.ae_switch.env_key = "AE_SWITCH_API_KEY";
      },
    ],
    [
      "oh_my_pi",
      (d) => {
        d.config.providers.ae_switch.apiKey = "AE_SWITCH_API_KEY";
      },
    ],
    [
      "opencode",
      (d) => {
        d.config.provider.ae_switch.options.apiKey = "{env:AE_SWITCH_API_KEY}";
      },
    ],
    [
      "hermes",
      (d) => {
        delete d.config.model.api_key;
        d.config.model.key_env = "AE_SWITCH_API_KEY";
      },
    ],
    [
      "deepseek_harness",
      (d) => {
        d.config[0].config.providers["ae-switch"].apiKeyEnv =
          "AE_GATEWAY_TOKEN";
      },
    ],
  ];
  for (const [agent, mutate] of cases) {
    const document = fixtures()[agent];
    mutate(document);
    assert.throws(() =>
      assertExistingAgentConfiguration(agent, document, expected),
    );
  }
});

test("stale model, endpoint and duplicate route rows fail independently", () => {
  for (const [agent, mutate] of [
    [
      "codex",
      (d) => {
        d.config.profiles.existing.model = "old";
      },
    ],
    [
      "claude_code",
      (d) => {
        d.config.env.CLAUDE_CODE_SUBAGENT_MODEL = "old";
      },
    ],
    [
      "claude_code",
      (d) => {
        d.config.env.ANTHROPIC_UNIX_SOCKET = "old";
      },
    ],
    [
      "oh_my_pi",
      (d) => {
        d.config.providers.ae_switch.models[0].baseUrl = "https://old.invalid";
      },
    ],
    [
      "opencode",
      (d) => {
        d.config.agent.compaction.model = "old/model";
      },
    ],
    [
      "hermes",
      (d) => {
        d.config.auxiliary.title_generation.api_key = "stale";
      },
    ],
    [
      "workbuddy",
      (d) => {
        d.config.models.push({ ...d.config.models[1] });
      },
    ],
    [
      "zcode",
      (d) => {
        d.state.builtInModelSelectionOverrides.Explore.modelId = "old";
      },
    ],
    [
      "deepseek_harness",
      (d) => {
        d.config[3].config.summarizationModel = "old";
      },
    ],
  ]) {
    const documents = fixtures()[agent];
    mutate(documents);
    assert.throws(() =>
      assertExistingAgentConfiguration(agent, documents, expected),
    );
  }
});

test("DSH requires native credentials and matching refs without requiring telemetry preference changes", () => {
  for (const mutation of [
    (d) => {
      delete d.secondary;
    },
    (d) => {
      delete d.secondary.refs[dshRef];
    },
    (d) => {
      d.secondary.refs[dshRef] = "old";
    },
    (d) => {
      d.config.push({ id: "credentials", disabled: true });
    },
  ]) {
    const documents = fixtures().deepseek_harness;
    mutation(documents);
    assert.throws(() =>
      assertExistingAgentConfiguration("deepseek_harness", documents, expected),
    );
  }
});

test("independent JSONC parser accepts comments and trailing commas but rejects duplicates and code", () => {
  assert.deepEqual(
    parseExistingJson(
      '{ // user comment\n"a": [1, -2,], "b": {"keep": true,},}',
      ts,
    ),
    { a: [1, -2], b: { keep: true } },
  );
  for (const content of [
    '{"a":1,"a":2}',
    '{"a":{"b":1,"b":2}}',
    "{a:1}",
    '{"a":process.exit()}',
    '{"a":undefined}',
    '{"a":1} {"b":2}',
  ])
    assert.throws(() => parseExistingJson(content, ts));
});

test("file readback binds original profile, native auth and history hash; rejects private wrapper and wrong profile", async (context) => {
  const owned = path.join(
    workspaceRoot,
    ".cache",
    `native-existing-readback-${randomUUID()}`,
  );
  const marker = { owner: randomUUID(), path: owned };
  await assertOwnedReadbackPath(workspaceRoot, path.dirname(owned));
  await fs.mkdir(owned);
  await fs.writeFile(path.join(owned, ".owner.json"), JSON.stringify(marker));
  try {
    const nativeRoot = path.join(owned, "ae-data");
    const directory = path.join(owned, "original-profile");
    await fs.mkdir(nativeRoot);
    await fs.mkdir(directory);
    const profile = {
      directory,
      homeDirectory: owned,
      executablePath: path.join(owned, "never-executed.exe"),
      workspaceDirectory: owned,
    };
    const history = path.join(owned, "history.jsonl");
    const content = "original history\r\n";
    await fs.writeFile(history, content);
    const documents = fixtures().workbuddy;
    await fs.writeFile(
      path.join(directory, "models.json"),
      JSON.stringify(documents.config),
    );
    const selection = {
      workbuddy: {
        profile: structuredClone(profile),
        model: expected.model,
        providerId: "fixture",
      },
    };
    await fs.writeFile(
      path.join(nativeRoot, "agent-selection.json"),
      JSON.stringify(selection),
    );
    const input = {
      workspaceRoot,
      nativeRoot,
      agent: "workbuddy",
      providerId: "fixture",
      model: expected.model,
      gateway: { baseUrl: expected.base, token: expected.token },
      fixture: {
        profiles: { workbuddy: profile },
        preservedFiles: [{ path: history, sha256: hash(content) }],
      },
    };
    const receipt = await verifyExistingAgentFiles(input);
    assert.equal(receipt.nativeAuthentication, true);
    assert.equal(receipt.desktopDefaultSelectionVerified, false);
    assert.equal(JSON.stringify(receipt).includes(expected.token), false);
    await fs.writeFile(history, "changed");
    await assert.rejects(
      verifyExistingAgentFiles(input),
      /history or unrelated/u,
    );
    await fs.writeFile(history, content);
    await fs.mkdir(path.join(nativeRoot, "agents", "workbuddy"), {
      recursive: true,
    });
    await assert.rejects(
      verifyExistingAgentFiles(input),
      /private client profile/u,
    );
    selection.workbuddy.profile.homeDirectory = path.join(
      owned,
      "wrong-profile",
    );
    await fs.writeFile(
      path.join(nativeRoot, "agent-selection.json"),
      JSON.stringify(selection),
    );
    await assert.rejects(verifyExistingAgentFiles(input), /profile changed/u);
  } finally {
    await assertOwnedReadbackPath(workspaceRoot, owned);
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(owned, ".owner.json"), "utf8")),
      marker,
    );
    assert.ok(path.dirname(owned) === path.join(workspaceRoot, ".cache"));
    await fs.rm(owned, { recursive: true });
    assert.equal(
      await fs.stat(owned).then(
        () => true,
        (error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      ),
      false,
    );
    context.diagnostic(
      JSON.stringify({
        ownedRoot: owned,
        owner: marker.owner,
        cleanupRemoved: true,
        clientStarted: false,
      }),
    );
  }
});
