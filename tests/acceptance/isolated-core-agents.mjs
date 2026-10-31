// Current production Rust core + unmodified official client programs. No GUI.
// Preparation is deliberately shared with production-ui-eight; this runner
// retains its owned sandbox for a separately guarded cleanup. It never deletes
// files or selects a fallback model/effort.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { registerPrivateValue } from "./acceptance-private-values.mjs";

process.on("uncaughtException", () => {
  console.error("Isolated core acceptance could not complete; raw diagnostic content was suppressed.");
  process.exitCode = 1;
});

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  assert.ok(/^--(?:setup|model|reasoning-effort|report|agents|repeat)$/u.test(process.argv[i]), "Unknown argument");
  assert.ok(process.argv[i + 1] && !options.has(process.argv[i]), "An explicit unique argument value is required");
  options.set(process.argv[i], process.argv[i + 1]);
}
assert.ok(options.get("--model") && options.get("--reasoning-effort"), "Explicit current-session model and reasoning effort are mandatory");
const model = options.get("--model");
const reasoningEffort = options.get("--reasoning-effort");
const allAgents = ["claude_code", "codex", "hermes", "oh_my_pi", "opencode", "zcode", "workbuddy", "deepseek_harness"];
const selectedAgents = options.has("--agents") ? options.get("--agents").split(",") : allAgents;
assert.ok(selectedAgents.length > 0 && new Set(selectedAgents).size === selectedAgents.length && selectedAgents.every((id) => allAgents.includes(id)), "Explicit supported unique agent IDs required");
const repetitions = options.get("--repeat") ?? "1";
assert.ok(["1", "2"].includes(repetitions), "Repeat must be 1 or 2");
const expectedAttempts = selectedAgents.length * Number(repetitions);
const privateValues = new Set();
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const within = (a, b) => {
  const relative = path.relative(a, b);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
async function guard(value, allowMissing = false) {
  const target = path.resolve(value);
  assert.ok(/^g:[\\/]/iu.test(target) && within(workspace, target), "Every input and output must remain in this G: workspace");
  for (let current = target; ; current = path.dirname(current)) {
    try {
      const metadata = await fs.lstat(current);
      assert.ok(!metadata.isSymbolicLink() && samePath(await fs.realpath(current), current), "Redirected paths are refused");
    } catch (error) {
      if (!(allowMissing && error.code === "ENOENT")) throw error;
    }
    if (path.dirname(current) === current) break;
  }
  return target;
}
const hash = async (filename) => crypto.createHash("sha256").update(await fs.readFile(await guard(filename))).digest("hex");
const safeString = (value) => [...privateValues].sort((a, b) => b.length - a.length).reduce((text, secret) => text.split(secret).join("<redacted>"), String(value));
const safeJson = (value) => JSON.stringify(value, (name, item) => name === "keySuffix" ? "<redacted>" : typeof item === "string" ? safeString(item) : item, 2) + "\n";
const setupFile = await guard(options.get("--setup") ?? "");
const setup = JSON.parse(await fs.readFile(setupFile, "utf8"));
assert.match(setup.ownerId, /^[a-f0-9]{32}$/u);
assert.equal(setup.schemaVersion, 2);
assert.ok(samePath(setup.workspace, workspace));
const ownedRoot = await guard(path.join(workspace, ".cache/native-e2e-sandbox", setup.ownerId));
assert.ok(samePath(setup.root, ownedRoot) && samePath(setupFile, path.join(ownedRoot, "setup.json")));
const owner = JSON.parse(await fs.readFile(await guard(path.join(ownedRoot, ".ae-production-ui-eight-owner.json")), "utf8"));
assert.equal(owner.ownerId, setup.ownerId);
assert.equal(owner.sourceDigest, setup.sourceDigest);
assert.equal(owner.buildAuditId, setup.buildAuditId);
const portableRoot = await guard(path.join(ownedRoot, "portable"));
assert.ok(samePath(portableRoot, setup.portableRoot));
const executable = await guard(path.join(portableRoot, "AE-Switch-core.exe"));
assert.equal(await hash(executable), setup.binaries["AE-Switch-core.exe"]);
for (const binding of setup.buildBindings) assert.equal(await hash(binding.path), binding.sha256, "Build receipt changed");
const sources = JSON.parse(await fs.readFile(await guard(setup.sourceManifest), "utf8"));
assert.equal(sources.digest, setup.sourceDigest);
for (const input of sources.files) assert.equal(await hash(path.join(workspace, input.path)), input.sha256, "Built source changed");
assert.equal(sources.files.length, setup.sourceFiles);
const currentInputPaths = [];
async function collectCurrentInputs(directory) {
  try {
    await guard(directory);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const filename = await guard(path.join(directory, entry.name));
      if (entry.isDirectory()) await collectCurrentInputs(filename);
      else if (entry.isFile()) currentInputPaths.push(path.relative(workspace, filename).split(path.sep).join("/"));
      else throw new Error("Nonordinary production source entry");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
for (const relative of ["app/src-tauri/src", "app/src-tauri/resources", "app/src-tauri/icons", "app/src-tauri/capabilities", "app/src", "app/dist", "app/public"]) await collectCurrentInputs(path.join(workspace, relative));
currentInputPaths.push("app/src-tauri/Cargo.toml", "app/src-tauri/Cargo.lock", "app/src-tauri/build.rs", "app/package.json", "app/pnpm-lock.yaml", "app/tsconfig.json", "app/vite.config.ts", "app/index.html", "app/postcss.config.js", "app/tailwind.config.js", "app/release-config.json", "app/src-tauri/tauri.conf.json");
assert.deepEqual([...new Set(currentInputPaths)].sort(), sources.files.map((item) => item.path).sort(), "Current production source inventory differs from the build");
assert.equal(crypto.createHash("sha256").update(sources.files.map((item) => `${item.path}\0${item.sha256}\n`).join("")).digest("hex"), setup.sourceDigest, "Source digest differs from the bound source manifest");
for (const [filename, expected] of Object.entries(setup.fixtures.sharedRuntimeFiles)) assert.equal(await hash(filename), expected, "Official client input changed");
for (const preserved of setup.fixtures.payload.preservedFiles) assert.equal(await hash(preserved.path), preserved.sha256, "Preserved original fixture input changed");

const credentialFile = await guard(path.join(portableRoot, "acceptance-credentials.txt"));
const credentials = await fs.readFile(credentialFile, "utf8");
for (const item of credentials.matchAll(/api[-_ ]?key\s*[:：]\s*(.+)/giu)) {
  registerPrivateValue(privateValues, item[1].trim());
  privateValues.add(Buffer.from(item[1].trim(), "utf8").toString("base64"));
}
for (const item of credentials.matchAll(/https?:\/\/[^\s"<>]+/gu)) registerPrivateValue(privateValues, item[0], true);
assert.ok(privateValues.size, "No private input was registered");
const reportFile = await guard(options.get("--report") ?? path.join(workspace, "artifacts/acceptance", `isolated-core-agents-${setup.ownerId}.json`), true);
assert.ok(within(path.join(workspace, "artifacts/acceptance"), reportFile) && !within(ownedRoot, reportFile), "Retained report must be outside the private owned sandbox");
await fs.mkdir(path.dirname(reportFile), { recursive: true });
await fs.writeFile(reportFile, "", { flag: "wx" });
const report = {
  schemaVersion: 1, ownerId: setup.ownerId, recordedAt: new Date().toISOString(),
  scope: "Current production Rust core discovery/configuration/probe-profile with existing official clients and fresh G: profiles; no desktop GUI acceptance",
  model, reasoningEffort, sourceDigest: setup.sourceDigest, buildAuditId: setup.buildAuditId,
  selectedAgents, repetitions: Number(repetitions), expectedAttempts,
  allEightClientsInScope: selectedAgents.length === allAgents.length,
  coreSha256: setup.binaries["AE-Switch-core.exe"], runnerSha256: await hash(fileURLToPath(import.meta.url)),
  desktopStarted: false, externalProcessStopped: false, fallbackModelUsed: false,
  qaHooksUsed: false, discoveryContextInjected: false, steps: [], agents: [],
  upstreamDiscoveryPassed: false, allOfficialToolsPassed: false, passed: false,
  cleanup: { performed: false, ownedRootRetained: true, ownerId: setup.ownerId, reason: "Separate exact-owner process and path guards are required before cleanup" },
  fullAcceptancePassed: false, realInferenceVerified: false, publicReady: false,
};
const writeReport = async () => fs.writeFile(reportFile, safeJson(report));
async function registerGatewayToken() {
  try {
    const route = JSON.parse(await fs.readFile(await guard(path.join(portableRoot, "data/protocol-bridge.json")), "utf8"));
    if (route.token) registerPrivateValue(privateValues, route.token);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
const childEnvironment = { ...process.env };
for (const name of Object.keys(childEnvironment)) {
  if (/^UNI_SWITCH_QA_|^AE_NATIVE_|^AE_SWITCH_|KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION|^WEBVIEW2_|^PYTHONPATH$|^PYTHONHOME$|^VIRTUAL_ENV$|^NODE_PATH$|^NODE_OPTIONS$|^(?:OPENAI|ANTHROPIC|CLAUDE|CODEX|HERMES|PI_|OMP_|OPENCODE|ZCODE|WORKBUDDY|CODEBUDDY|DSH_)/iu.test(name)) delete childEnvironment[name];
}
for (const [name, value] of Object.entries(setup.fixtures.environment)) {
  assert.ok(!/^UNI_SWITCH_QA_|^AE_NATIVE_/iu.test(name), "Product test hooks are refused");
  childEnvironment[name] = value;
}
childEnvironment.AE_SWITCH_PORTABLE_ROOT = portableRoot;
childEnvironment.PYTHONDONTWRITEBYTECODE = "1";
childEnvironment.RTK_DB_PATH = await guard(path.join(workspace, ".cache/rtk/history.db"), true);
childEnvironment.RTK_TEE_DIR = await guard(path.join(workspace, ".cache/rtk/tee"), true);
childEnvironment.RTK_AUDIT_DIR = await guard(path.join(workspace, ".cache/rtk/audit"), true);
childEnvironment.NODE_COMPILE_CACHE = await guard(path.join(ownedRoot, "node-compile-cache"), true);
for (const [name, relative] of Object.entries({
  npm_config_cache: "npm", npm_config_prefix: "npm-prefix", npm_config_store_dir: "pnpm-store",
  PNPM_HOME: "pnpm", COREPACK_HOME: "corepack", UV_CACHE_DIR: "uv", PIP_CACHE_DIR: "pip",
  PYTHONPYCACHEPREFIX: "pycache", DOTNET_CLI_HOME: "dotnet", NUGET_PACKAGES: "nuget",
})) childEnvironment[name] = await guard(path.join(ownedRoot, "cache", relative), true);
for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) await guard(childEnvironment[name]);

async function execute(command, args = [], input, timeout = 240000) {
  const started = performance.now();
  const outcome = await new Promise((resolve) => {
    const child = spawn(executable, [command, ...args], { cwd: setup.fixtures.payload.profiles.codex.workspaceDirectory, env: childEnvironment, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false, outputLimited = false;
    let settled = false, graceTimer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      resolve(value);
    };
    const stopOwnedCore = () => {
      child.kill();
      if (!graceTimer) graceTimer = setTimeout(() => {
        child.stdout.destroy(); child.stderr.destroy();
        finish({ command, exitCode: null, timedOut, outputLimited, error: "Owned core exceeded its exit grace period; its sandbox must be retained for separate descendant observation" });
      }, 10000);
    };
    const timer = setTimeout(() => { timedOut = true; stopOwnedCore(); }, timeout);
    const collect = (data, stream) => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + data.length > 2 * 1024 * 1024) { outputLimited = true; stopOwnedCore(); return; }
      if (stream === "stdout") stdout += data.toString(); else stderr += data.toString();
    };
    child.stdout.on("data", (data) => collect(data, "stdout"));
    child.stderr.on("data", (data) => collect(data, "stderr"));
    child.stdin.on("error", () => {});
    child.once("error", (error) => finish({ command, exitCode: null, error: error.message }));
    child.once("close", (exitCode) => {
      let result;
      try { result = JSON.parse(stdout); } catch { /* Keep unparsable output redacted for failure analysis. */ }
      finish({ command, exitCode, timedOut, outputLimited, milliseconds: Math.round(performance.now() - started), result, ...(result ? {} : { stdout }), stderr });
    });
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
  await registerGatewayToken();
  report.steps.push(outcome);
  await writeReport();
  console.log(JSON.stringify({ command, exitCode: outcome.exitCode, timedOut: outcome.timedOut ?? false, milliseconds: outcome.milliseconds }));
  return outcome;
}
const successful = (outcome) => outcome.exitCode === 0 && !outcome.timedOut && !outcome.outputLimited && outcome.result;
try {
  const discovery = await execute("discover", [credentialFile], undefined, 120000);
  assert.ok(successful(discovery), "Real upstream discovery failed; no model or effort was changed");
  const provider = discovery.result;
  assert.ok(provider.codexOptions?.models?.some((item) => item.id === model && item.enabled), "The explicitly selected current-session model is absent from the actual upstream model list");
  report.upstreamDiscoveryPassed = true;
  const save = await execute("save-provider", [], {
    id: provider.id, family: provider.family, name: "Current-session isolated acceptance",
    baseUrl: provider.baseUrl, model, apiKey: null, balanceAccessToken: null,
    authMode: provider.authMode, reasoningEffort,
    codexOptions: provider.codexOptions, editedContextModelIds: [],
  }, 30000);
  assert.ok(successful(save), "The explicitly selected reasoning effort was rejected; no fallback was used");
  assert.equal(save.result.model, model);
  assert.equal(save.result.reasoningEffort, reasoningEffort);
  for (let attempt = 1; attempt <= Number(repetitions); attempt++) {
  for (const agentId of selectedAgents) {
    const profile = setup.fixtures.payload.profiles[agentId];
    assert.ok(profile && within(ownedRoot, await guard(profile.directory)), "Only fresh owned profiles can be configured");
    const input = { agentId, providerId: provider.id, model, profile };
    const configured = await execute("configure-profile", [], input, 45000);
    if (!successful(configured)) {
      report.agents.push({ agentId, attempt, configured: false, passed: false });
      await writeReport();
      continue;
    }
    const probe = await execute("probe-profile", [], input);
    const result = probe.result;
    const passed = Boolean(successful(probe) && result.ok === true && result.toolVerified === true && result.validationScope === "tool" && result.stage === "verified" && result.cleanup?.succeeded === true && result.cleanup?.removed === true && ["writeObserved", "readObserved", "readbackMarkerObserved", "assistantMarkerObserved", "fileMatchesMarker", "processSucceeded"].every((flag) => result.evidence?.[flag] === true) && (agentId !== "deepseek_harness" || result.evidence?.terminalCompletionRequired === true && result.evidence?.terminalCompletedObserved === true));
    report.agents.push({ agentId, attempt, configured: true, passed });
    await writeReport();
    console.log(JSON.stringify({ agentId, attempt, passed }));
  }
  }
  for (const [filename, expected] of Object.entries(setup.fixtures.sharedRuntimeFiles)) assert.equal(await hash(filename), expected, "Official input changed during acceptance");
  for (const preserved of setup.fixtures.payload.preservedFiles) assert.equal(await hash(preserved.path), preserved.sha256, "Original history/preferences changed during acceptance");
  report.inputsPreserved = true;
  report.allOfficialToolsPassed = report.agents.length === expectedAttempts && report.agents.every((agent) => agent.passed);
  report.allEightOfficialToolsPassed = report.allEightClientsInScope && report.allOfficialToolsPassed;
  report.realInferenceVerified = report.allOfficialToolsPassed;
  report.passed = report.allOfficialToolsPassed;
} catch (error) {
  report.error = error.message;
} finally {
  await registerGatewayToken();
  await writeReport();
  console.log(JSON.stringify({ ownerId: setup.ownerId, passed: report.passed, upstreamDiscoveryPassed: report.upstreamDiscoveryPassed, officialPassed: report.agents.filter((agent) => agent.passed).length, expected: expectedAttempts, allEightClientsInScope: report.allEightClientsInScope, sandboxRetained: true }));
  process.exitCode = report.passed ? 0 : 1;
}
