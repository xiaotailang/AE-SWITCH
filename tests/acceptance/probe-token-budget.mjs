import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Live, credential-safe diagnostics; no tool configuration or installation.
const workspace = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const credentials = await fs.readFile(
  path.join(workspace, "端点测试用.txt"),
  "utf8",
);
const readField = (name) =>
  credentials
    .split(/\r?\n/u)
    .map((line) =>
      line
        .trim()
        .match(new RegExp(`^${name}[:：](.*)$`, "u"))?.[1]
        ?.trim(),
    )
    .filter((value) => value !== undefined)
    .at(-1);
const endpoint = readField("端点") ?? readField("endpoint");
const key = readField("api-key");
if (!endpoint || !key)
  throw new Error("Designated endpoint credentials are incomplete.");
const discovery = JSON.parse(
  await fs.readFile(
    path.join(workspace, "artifacts/acceptance/endpoint-retest-20261008.json"),
    "utf8",
  ),
);
const model = discovery.selectedModel;
if (!model || !discovery.models.includes(model))
  throw new Error("A model from the actual live discovery is required.");
const base = endpoint.replace(/\/+$/u, "");
const url = `${base}${base.endsWith("/v1") ? "" : "/v1"}/chat/completions`;
const report = {
  recordedAt: new Date().toISOString(),
  model,
  scope:
    "Actual upstream chat probe token budgets; only response shape/counts retained. No tool inference acceptance.",
  samples: [],
};
for (const maxTokens of [64, 64, 64, 512, 512, 512]) {
  const sample = { maxTokens };
  const started = performance.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(30000),
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with AE_SWITCH_OK only." }],
        max_tokens: maxTokens,
      }),
    });
    const body = await response.json();
    const choice = body.choices?.[0];
    sample.status = response.status;
    sample.finishReason = choice?.finish_reason ?? null;
    sample.contentCharacters =
      typeof choice?.message?.content === "string"
        ? choice.message.content.length
        : 0;
    sample.reasoningCharacters =
      typeof choice?.message?.reasoning_content === "string"
        ? choice.message.reasoning_content.length
        : 0;
    sample.markerObserved =
      response.ok &&
      typeof choice?.message?.content === "string" &&
      choice.message.content.includes("AE_SWITCH_OK");
    sample.completionTokens = body.usage?.completion_tokens ?? null;
    sample.promptTokens = body.usage?.prompt_tokens ?? null;
  } catch {
    sample.transportOrParseFailure = true;
    sample.markerObserved = false;
  }
  sample.milliseconds = Math.round(performance.now() - started);
  report.samples.push(sample);
  await fs.writeFile(
    path.join(workspace, "artifacts/acceptance/probe-token-budget.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(sample));
}
