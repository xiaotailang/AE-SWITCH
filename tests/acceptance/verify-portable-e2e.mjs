import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

// Only scripts/verify-portable-e2e.ps1 creates and removes the owned sandbox.
// This runner uses the same Rust discover/configure/probe commands as the app.
const workspace = path.resolve(process.env.AE_WORKSPACE ?? process.cwd());
const sandbox = path.resolve(process.env.AE_E2E_SANDBOX ?? "");
const reportFile = path.join(
  workspace,
  "artifacts/acceptance/portable-e2e.json",
);
const physicalWorkspace = await fs.realpath(workspace);
async function assertWorkspacePath(target) {
  const relative = path.relative(workspace, target);
  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    /^C:/iu.test(physicalWorkspace)
  ) {
    throw new Error(
      "Acceptance paths must remain inside the current workspace.",
    );
  }
  for (
    let current = target;
    current !== workspace;
    current = path.dirname(current)
  ) {
    try {
      const metadata = await fs.lstat(current);
      if (metadata.isSymbolicLink())
        throw new Error("Acceptance paths cannot use links or junctions.");
      const physical = await fs.realpath(current);
      const physicalRelative = path.relative(physicalWorkspace, physical);
      if (
        physicalRelative.startsWith("..") ||
        path.isAbsolute(physicalRelative)
      )
        throw new Error("Acceptance path escaped the physical workspace.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
await assertWorkspacePath(reportFile);
const expectedAgents = [
  "claude_code",
  "codex",
  "hermes",
  "oh_my_pi",
  "opencode",
  "zcode",
  "workbuddy",
  "deepseek_harness",
];
const relative = path.relative(
  path.join(workspace, ".cache/e2e-sandbox"),
  sandbox,
);
if (
  !relative ||
  relative.startsWith("..") ||
  path.isAbsolute(relative) ||
  /^C:/iu.test(sandbox)
) {
  throw new Error("An owned sandbox inside this workspace is required.");
}
await assertWorkspacePath(sandbox);
await fs.access(path.join(sandbox, ".ae-switch-e2e-owner.json"));
const executable = path.join(sandbox, "AE-Switch-core.exe");
const credentialFile = path.join(sandbox, "acceptance-credentials.txt");
const credentialText = await fs.readFile(credentialFile, "utf8");
const credentialKeys = [
  ...credentialText.matchAll(/api[-_ ]?key\s*[:：]\s*(.+)/giu),
].map((match) => match[1].trim());
// Mirror the Rust parser's last matching api-key line and redact every supplied
// key, including duplicate credential lines, before retaining diagnostics.
const key = credentialText
  .split(/\r?\n/u)
  .map((line) =>
    line
      .trim()
      .match(/^api-key[:：](.*)$/u)?.[1]
      ?.trim(),
  )
  .filter((value) => value !== undefined)
  .at(-1);
if (!key) throw new Error("The acceptance credentials file has no API key.");
const secrets = new Set([...credentialKeys, key]);
const sanitize = (value) => {
  let text = String(value);
  for (const secret of [...secrets].sort((a, b) => b.length - a.length))
    if (secret) text = text.split(secret).join("<redacted>");
  return text;
};
// Redact before JSON escaping so quotes, slashes and newlines in a supplied
// credential cannot survive serialization in report or console string values.
const safeJson = (value, indent) =>
  JSON.stringify(
    value,
    (_name, item) => (typeof item === "string" ? sanitize(item) : item),
    indent,
  );
const report = {
  recordedAt: new Date().toISOString(),
  scope:
    "Sandbox copy of the portable distribution; real Rust model discovery, generated tool configuration, real inference, official tool write/readback and assistant reply. No mocked endpoint or fallback model.",
  sandbox,
  cliSha256: createHash("sha256")
    .update(await fs.readFile(executable))
    .digest("hex"),
  expectedAgents,
  launcherVersionSmoke: null,
  modelDiscovery: null,
  agents: [],
  toolFlowPassed: false,
  passed: false,
  cleanup: { removed: false, owner: "scripts/verify-portable-e2e.ps1" },
};
await fs.mkdir(path.dirname(reportFile), { recursive: true });
const writeReport = async () => {
  await assertWorkspacePath(reportFile);
  await fs.writeFile(reportFile, safeJson(report, 2));
};

async function execute(args, timeout = 180000) {
  const started = performance.now();
  return await new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd: sandbox,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      timedOut = false,
      outputLimit = false;
    let settled = false,
      terminationRequested = false,
      killFallback,
      completionFallback;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killFallback);
      clearTimeout(completionFallback);
      resolve(outcome);
    };
    const kill = () => {
      if (terminationRequested) return;
      terminationRequested = true;
      if (child.pid && child.exitCode === null) {
        const killer = spawn(
          path.join(
            process.env.SystemRoot ?? "C:/Windows",
            "System32/taskkill.exe",
          ),
          ["/PID", String(child.pid), "/T", "/F"],
          {
            windowsHide: true,
            stdio: "ignore",
            env: process.env,
          },
        );
        killer.on("error", () => child.kill());
        killer.on("close", (code) => {
          if (code !== 0) child.kill();
        });
        killer.unref();
      }
      killFallback = setTimeout(() => child.kill(), 5000);
      completionFallback = setTimeout(() => {
        child.kill();
        child.stdout.destroy();
        child.stderr.destroy();
        finish({
          exitCode: null,
          timedOut,
          outputLimit,
          error:
            "Owned process termination did not complete within the bounded grace period.",
        });
      }, 10000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeout);
    const collect = (data, target) => {
      if (
        Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + data.length >
        2 * 1024 * 1024
      ) {
        outputLimit = true;
        kill();
        return;
      }
      if (target === "stdout") stdout += data.toString();
      else stderr += data.toString();
    };
    child.stdout.on("data", (data) => collect(data, "stdout"));
    child.stderr.on("data", (data) => collect(data, "stderr"));
    child.once("error", (error) => {
      finish({
        exitCode: null,
        timedOut,
        outputLimit,
        error: sanitize(error.message),
      });
    });
    child.once("close", (exitCode) => {
      let result;
      try {
        result = JSON.parse(stdout);
      } catch {}
      finish({
        exitCode,
        timedOut,
        outputLimit,
        milliseconds: Math.round(performance.now() - started),
        result,
        stderr: sanitize(stderr).slice(0, 4000),
      });
    });
  });
}

try {
  const smokeFile = path.join(workspace, "artifacts/acceptance/portable-launcher-smoke.json");
  await assertWorkspacePath(smokeFile);
  const smoke = JSON.parse(await fs.readFile(smokeFile, "utf8"));
  if (
    path.resolve(smoke.packageDirectory ?? "") !== sandbox ||
    smoke.cliSha256 !== report.cliSha256 ||
    smoke.passed !== true ||
    smoke.localLauncherPassedCount !== expectedAgents.length ||
    JSON.stringify(smoke.results?.map((agent) => agent.id).sort()) !==
      JSON.stringify([...expectedAgents].sort()) ||
    !smoke.results.every((agent) => agent.passed === true)
  ) {
    throw new Error("No successful eight-launcher version smoke matched this owned sandbox and final CLI hash.");
  }
  report.launcherVersionSmoke = smoke;
  const discovery = await execute(["discover", credentialFile], 120000);
  report.modelDiscovery = discovery;
  await writeReport();
  if (
    discovery.exitCode !== 0 ||
    discovery.timedOut ||
    discovery.outputLimit ||
    !discovery.result?.id
  ) {
    throw new Error(
      "Real model discovery failed; no model availability or tool E2E success has been established.",
    );
  }
  const provider = discovery.result;
  const models =
    provider.codexOptions?.models
      ?.filter((model) => model.enabled)
      .map((model) => model.id) ?? [];
  const selectedModel = process.env.AE_TEST_MODEL ?? provider.model;
  if (!models.includes(selectedModel))
    throw new Error(
      "The selected model is absent from the actual discovered list.",
    );
  report.selectedModel = selectedModel;
  report.actualModels = models;
  const configured = await execute(
    ["configure-all", provider.id, selectedModel],
    30000,
  );
  report.configuration = configured;
  if (
    configured.exitCode !== 0 ||
    configured.timedOut ||
    configured.outputLimit
  )
    throw new Error("Rust automatic configuration failed.");
  const ids = configured.result?.agents?.map((agent) => agent.id).sort();
  if (JSON.stringify(ids) !== JSON.stringify([...expectedAgents].sort()))
    throw new Error("The complete supported tool set was not configured.");
  const gateway = JSON.parse(
    await fs.readFile(path.join(sandbox, "data/protocol-bridge.json"), "utf8"),
  );
  if (gateway.token) secrets.add(gateway.token);
  for (const id of expectedAgents) {
    const outcome = await execute(["probe", id, provider.id, selectedModel]);
    const result = outcome.result;
    report.agents.push({
      id,
      ...outcome,
      passed:
        outcome.exitCode === 0 &&
        !outcome.timedOut &&
        !outcome.outputLimit &&
        result?.ok === true &&
        result?.toolVerified === true &&
        result?.validationScope === "tool" &&
        result?.stage === "verified" &&
        result?.cleanup?.succeeded === true &&
        result?.cleanup?.removed === true &&
        ["writeObserved", "readObserved", "readbackMarkerObserved", "assistantMarkerObserved", "fileMatchesMarker", "processSucceeded"].every((flag) => result?.evidence?.[flag] === true) &&
        (id !== "deepseek_harness" || (result?.evidence?.terminalCompletionRequired === true && result?.evidence?.terminalCompletedObserved === true)),
    });
    await writeReport();
    console.log(
      safeJson({
        id,
        passed: report.agents.at(-1).passed,
        stage: result?.stage ?? "command_failed",
      }),
    );
  }
  report.toolFlowPassed =
    report.agents.length === expectedAgents.length &&
    report.agents.every((agent) => agent.passed);
} catch (error) {
  report.error = sanitize(error.message);
} finally {
  report.passedAgents = report.agents.filter((agent) => agent.passed).length;
  await writeReport();
}
console.log(
  safeJson({
    launcherVersionSmokePassed: report.launcherVersionSmoke?.passed === true,
    toolFlowPassed: report.toolFlowPassed,
    passedAgents: report.passedAgents,
    expectedAgents: expectedAgents.length,
    error: report.error,
  }),
);
if (!report.toolFlowPassed) process.exitCode = 1;
