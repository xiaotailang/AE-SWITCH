import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  assertOwnedReadbackPath,
  parseOwnedConfiguration,
} from "./native-config-readback.mjs";
import { assertExistingAgentConfiguration } from "./native-existing-readback.mjs";
import { createHash } from "node:crypto";

const workspaceRoot = path.resolve(process.cwd());
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const expected = {
  model: "real-parser-fixture",
  base: "http://127.0.0.1:17432/agents/selected:fixture/v1",
  token: "synthetic-persisted-parser-token",
};

test("real Python tomllib and official safe YAML independently validate existing native authentication", async (context) => {
  const root = path.join(
    workspaceRoot,
    ".cache",
    `existing-independent-parser-${randomUUID()}`,
  );
  const owner = { owner: randomUUID(), root };
  await assertOwnedReadbackPath(workspaceRoot, path.dirname(root));
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, ".owner.json"), JSON.stringify(owner));
  try {
    const parse = async (name, format, text) => {
      const location = path.join(root, `${name}.${format}`);
      await fs.writeFile(location, text);
      const result = await parseOwnedConfiguration({
        workspaceRoot,
        location,
        format,
        expectedSha256: sha256(text),
        pythonDirectory: path.join(
          workspaceRoot,
          ".tools/python/cpython-3.14.6-windows-x86_64-none",
        ),
        yamlLibraryDirectory: path.join(
          workspaceRoot,
          ".tools/agents/hermes/.venv/Lib/site-packages",
        ),
      });
      assert.equal(result.proof.unchangedBeforeAndAfter, true);
      assert.ok(sha256(await fs.readFile(location)) === sha256(text));
      return result.document;
    };
    const config = await parse(
      "codex",
      "toml",
      `# user's native comment\nmodel = '${expected.model}'\nmodel_provider = 'ae_switch'\n[model_providers.ae_switch]\nbase_url = '${expected.base}'\nwire_api = 'responses'\nrequires_openai_auth = false\nexperimental_bearer_token = '${expected.token}'\n`,
    );
    assertExistingAgentConfiguration("codex", { config }, expected);
    const ref = "AE_SWITCH_AABBCCDDEEFF0011_API_KEY";
    const dsh = await parse(
      "dsh",
      "yaml",
      `# user's native YAML comment\n- id: llm-pi-ai\n  config:\n    providers:\n      ae-switch:\n        api: openai-completions\n        baseURL: '${expected.base}'\n        apiKeyEnv: ${ref}\n        models:\n          - id: ${expected.model}\n- id: agent-default-model\n  config:\n    provider: ae-switch\n    model: ${expected.model}\n- id: session-telemetry-otel\n  disabled: false\n`,
    );
    const credentials = await parse(
      "dsh-credentials",
      "yaml",
      `version: 1\nrefs:\n  ${ref}: '${expected.token}'\n  USER_REFERENCE: unchanged\nrecords:\n  user/provider:\n    kind: grant\n    payload: {keep: true}\n`,
    );
    assertExistingAgentConfiguration(
      "deepseek_harness",
      { config: dsh, secondary: credentials },
      expected,
    );
    assert.equal(credentials.refs.USER_REFERENCE, "unchanged");
    assert.equal(dsh[2].disabled, false);
    const auxiliary = Object.fromEntries(
      ["compression", "title_generation", "background_review"].map((name) => [
        name,
        {
          provider: "custom",
          model: expected.model,
          base_url: expected.base,
          api_mode: "chat_completions",
          api_key: expected.token,
          enabled: false,
        },
      ]),
    );
    const hermes = await parse(
      "hermes",
      "yaml",
      JSON.stringify({
        model: {
          default: expected.model,
          provider: "custom",
          base_url: expected.base,
          api_mode: "chat_completions",
          api_key: expected.token,
        },
        auxiliary,
      }),
    );
    assertExistingAgentConfiguration("hermes", { config: hermes }, expected);
    for (const task of Object.values(hermes.auxiliary))
      assert.equal(task.enabled, false);
    await assert.rejects(
      parse(
        "duplicate-native",
        "yaml",
        "model: {api_key: first, api_key: second}\n",
      ),
      /independent parser failed/u,
    );
  } finally {
    await assertOwnedReadbackPath(workspaceRoot, root);
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(root, ".owner.json"), "utf8")),
      owner,
    );
    assert.ok(path.dirname(root) === path.join(workspaceRoot, ".cache"));
    await fs.rm(root, { recursive: true });
    assert.equal(
      await fs.stat(root).then(
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
        ownedRoot: root,
        owner: owner.owner,
        cleanupRemoved: true,
        clientStarted: false,
      }),
    );
  }
});
