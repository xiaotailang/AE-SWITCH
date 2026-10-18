import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  verifyManagementExtras,
  verifyOwnedConflict,
} from "./native-management-extra.mjs";
import {
  verifyHubExtras,
  verifyHubRevalidation,
  waitForHubDiscovery,
} from "./native-hub-extra.mjs";
import { verifyOwnedWindow } from "./native-window-extra.mjs";
import { verifyGatewayRecovery } from "./native-gateway-extra.mjs";
import { verifyBusinessExtras } from "./native-business-extra.mjs";
import { verifyDiscoveryEdges } from "./native-discovery-extra.mjs";
import { verifyFormExtras } from "./native-form-extra.mjs";
import { verifySyncRetry } from "./native-sync-extra.mjs";
import { verifyOptionsExtras } from "./native-options-extra.mjs";
import { verifyExternalRoutes } from "./native-external-extra.mjs";
import { verifyConfigurationExtras } from "./native-configuration-extra.mjs";
import {
  armNativeLaunchProof,
  waitForNativeLaunchAcknowledgment,
} from "./native-launch-proof.mjs";
import { verifyExistingAgentFiles } from "./native-existing-readback.mjs";
import { verifyInstalledProfileUi } from "./native-installed-ui-extra.mjs";
import {
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
import {
  createNativeUpdateFixture,
  verifyUpdateExtras,
} from "./native-update-extra.mjs";
import {
  surfaceEmptyBeforeSeed,
  surfaceHubAtEnd,
  validateSurfaceOwnedRoot,
} from "./native-surface-extra.mjs";

const runFile = promisify(execFile);

// Attach to the existing qa-webview process. This script never replaces Tauri
// IPC, starts a preview server, creates a browser page, or launches the application.
// Real credentials are read only from the externally owned acceptance sandbox.
const root = path.resolve(process.env.AE_WORKSPACE ?? process.cwd());
const nativeRoot = process.env.AE_NATIVE_EXPECTED_ROOT;
const gatewayFixtureMode = !!process.env.AE_NATIVE_GATEWAY_FIXTURE_PORT;
const output = path.resolve(
  process.env.AE_NATIVE_UI_OUT ??
    (gatewayFixtureMode
      ? path.join(
          root,
          "artifacts",
          "acceptance",
          "native-gateway",
          path.basename(path.dirname(nativeRoot)),
        )
      : path.join(root, "artifacts", "acceptance", "native-ui")),
);
if (gatewayFixtureMode) {
  assert.equal(
    output,
    path.join(
      root,
      "artifacts",
      "acceptance",
      "native-gateway",
      path.basename(path.dirname(nativeRoot)),
    ),
  );
  assert.ok(
    !process.env.AE_NATIVE_QA_LOCAL_FIXTURE_PORT,
    "Gateway and update fixtures are mutually exclusive",
  );
}
const resultName = gatewayFixtureMode
  ? "native-gateway-results.json"
  : "native-ui-results.json";
const cdp = process.env.AE_NATIVE_CDP_URL ?? "http://127.0.0.1:9223";
assert.equal(
  cdp,
  "http://127.0.0.1:9223",
  "CDP must use the owner-validated listener",
);
const require = createRequire(path.join(root, "app", "package.json"));
const { chromium } = require("playwright");
const expectedAppVersion = require("./package.json").version;
assert.equal(typeof expectedAppVersion, "string");
assert.ok(expectedAppVersion.length > 0, "The package version must be present");
const updateFixture = createNativeUpdateFixture({
  version: expectedAppVersion,
  nativeRoot,
});
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
const testEndpoint = "http://127.0.0.1:9/v1";
const testKey = "ae-switch-synthetic-invalid-qa-key";
const fixtureKey = "ae-switch-synthetic-native-management-key";
const rotatedFixtureKey = "ae-switch-synthetic-native-management-rotated-key";
const baselineKey = "ae-switch-synthetic-native-baseline-key";
const secrets = new Set([testKey, fixtureKey, rotatedFixtureKey, baselineKey]);
let existingFixture = null;
const evidence = {
  recordedAt: new Date().toISOString(),
  scope: gatewayFixtureMode
    ? "Scoped native gateway startup recovery through actual Rust IPC and Legacy UI apply/retry. Only the wrapper-owned loopback fixture is released; eight real tools are not attempted."
    : "Actual Tauri WebView and Rust IPC. Synthetic advanced-management coverage is separate from real supplier discovery and eight official tools' file write/readback verification through the native UI. No mocked invoke, preview browser, fallback model, or second probe.",
  cdp,
  passed: false,
  verifiedRoot: null,
  qaSha256: null,
  nativeIntegrationPassed: false,
  realToolFlowPassed: false,
  steps: [],
  screenshots: [],
  pageErrors: [],
  ...(gatewayFixtureMode
    ? {
        gatewayScopedPassed: false,
        fullAcceptancePassed: false,
        eightToolFlowNotAttempted: true,
      }
    : {}),
};

function isWithinRoot(location) {
  const relative = path.relative(root, path.resolve(location));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}
function checkWorkspacePath(location, label) {
  assert.equal(
    typeof location,
    "string",
    `${label} must be a native directory string`,
  );
  assert.ok(path.isAbsolute(location), `${label} must be absolute`);
  assert.ok(
    isWithinRoot(location),
    `${label} must remain in the current workspace: ${location}`,
  );
  assert.doesNotMatch(
    location,
    /^C:[\\/]/iu,
    `${label} must not be on C drive`,
  );
}
function safe(value) {
  let text = String(value);
  for (const secret of [...secrets].sort((a, b) => b.length - a.length))
    if (secret) text = text.split(secret).join("<credential redacted>");
  return text;
}
// Sanitize string values before JSON escaping, including quoted credentials.
function safeJson(value, indent) {
  return JSON.stringify(
    value,
    (_name, item) => (typeof item === "string" ? safe(item) : item),
    indent,
  );
}
async function writeEvidence() {
  await fs.writeFile(path.join(output, resultName), safeJson(evidence, 2));
}
async function record(step, details = {}) {
  evidence.steps.push({ step, ...details });
  await writeEvidence();
  console.log(safeJson({ step, ...details }));
}
function samePath(first, second) {
  return (
    path.resolve(first).toLowerCase() === path.resolve(second).toLowerCase()
  );
}
async function assertPhysicalWorkspacePath(
  location,
  { allowMissing = false } = {},
) {
  checkWorkspacePath(location, "Owned native acceptance path");
  const physicalWorkspace = await fs.realpath(root);
  let current = path.resolve(location);
  let nearestExisting;
  while (true) {
    try {
      const stat = await fs.lstat(current);
      assert.equal(
        stat.isSymbolicLink(),
        false,
        "Acceptance paths cannot use symlinks or junctions",
      );
      nearestExisting ??= current;
    } catch (error) {
      if (error.code !== "ENOENT" || !allowMissing) throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const physical = await fs.realpath(nearestExisting);
  const relative = path.relative(physicalWorkspace, physical);
  assert.ok(
    relative === "" ||
      (!relative.startsWith(`..${path.sep}`) &&
        relative !== ".." &&
        !path.isAbsolute(relative)),
    "Acceptance paths must physically remain in the workspace",
  );
  assert.doesNotMatch(physical, /^C:[\\/]/iu);
  return physical;
}
async function validateOwnedNativeSandbox() {
  const owned = await validateSurfaceOwnedRoot(nativeRoot);
  assert.ok(
    nativeRoot && path.isAbsolute(nativeRoot),
    "AE_NATIVE_EXPECTED_ROOT must name the owned native sandbox",
  );
  assert.equal(
    samePath(nativeRoot, root),
    false,
    "The owned sandbox must be a workspace descendant",
  );
  await assertPhysicalWorkspacePath(nativeRoot);
  assert.ok(
    samePath(await fs.realpath(nativeRoot), nativeRoot),
    "The native root must match its physical path",
  );
  const ownerFile = path.join(nativeRoot, ".ae-native-e2e-owner.json");
  await assertPhysicalWorkspacePath(ownerFile);
  const owner = JSON.parse(await fs.readFile(ownerFile, "utf8"));
  assert.equal(owner.id, owned.id);
  assert.match(owner.id ?? "", /^[a-f0-9]{32}$/u);
  assert.equal(
    owner.purpose,
    "AE Switch owned native UI and real tool acceptance",
  );
  assert.ok(
    samePath(owner.workspace, root),
    "The owner marker must name this workspace",
  );
  const executable = path.join(nativeRoot, "AE-Switch-QA.exe");
  await assertPhysicalWorkspacePath(executable);
  const expectedHash = process.env.AE_NATIVE_QA_SHA256;
  assert.match(
    expectedHash ?? "",
    /^[a-f0-9]{64}$/iu,
    "AE_NATIVE_QA_SHA256 must be supplied by the process owner",
  );
  const executableHash = createHash("sha256")
    .update(await fs.readFile(executable))
    .digest("hex");
  assert.equal(
    executableHash,
    expectedHash.toLowerCase(),
    "The QA executable must match the process owner's expected hash",
  );
  evidence.qaSha256 = executableHash;
  if (gatewayFixtureMode) {
    evidence.ownedNativeSandbox = {
      root: nativeRoot,
      ownerId: owner.id,
      executableHash,
      processOwnedBy: "scripts/verify-portable-e2e.ps1",
    };
    await record("native-owned-sandbox-validated", evidence.ownedNativeSandbox);
    return null;
  }
  const credentialFile = process.env.AE_NATIVE_CREDENTIAL_FILE;
  assert.ok(
    credentialFile &&
      path.isAbsolute(credentialFile) &&
      samePath(
        credentialFile,
        path.join(nativeRoot, "acceptance-credentials.txt"),
      ),
    "Credentials must be the owned sandbox's acceptance-credentials.txt",
  );
  await assertPhysicalWorkspacePath(credentialFile);
  const text = await fs.readFile(credentialFile, "utf8");
  for (const match of text.matchAll(/api[-_ ]?key\s*[:：]\s*(.+)/giu))
    secrets.add(match[1].trim());
  const lines = text.split(/\r?\n/u).map((line) => line.trim());
  // Match the Rust CLI parser exactly: the last matching line wins.
  const key = lines
    .map((line) => line.match(/^api-key[:：](.*)$/u)?.[1]?.trim())
    .filter((value) => value !== undefined)
    .at(-1);
  const endpoint = lines
    .map((line) => line.match(/^端点[:：](.*)$/u)?.[1]?.trim())
    .filter((value) => value !== undefined)
    .at(-1);
  if (key) secrets.add(key);
  assert.ok(key, "The owned credential file must contain an API key");
  assert.ok(endpoint, "The owned credential file must contain an endpoint");
  const parsed = new URL(endpoint);
  assert.ok(["http:", "https:"].includes(parsed.protocol));
  assert.ok(
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname),
    "Real supplier acceptance cannot use the synthetic loopback fixture",
  );
  evidence.ownedNativeSandbox = {
    root: nativeRoot,
    ownerId: owner.id,
    executableHash,
    credentialFile,
    processOwnedBy: "scripts/verify-portable-e2e.ps1",
  };
  await record("native-owned-sandbox-validated", {
    root: nativeRoot,
    ownerId: owner.id,
    executableHash,
  });
  return { key, endpoint };
}
assert.ok(
  isWithinRoot(output),
  "Native QA evidence must stay in the current workspace",
);
await assertPhysicalWorkspacePath(output, { allowMissing: true });
await fs.mkdir(output, { recursive: true });

let browser;
let page;
let instanceValidated = false;
let realCredentialEntered = false;
let fixtureServer;
let managementRecovery;

async function verifyAdvancedManagement(invoke, initialOverview) {
  assert.equal(
    initialOverview.providers.length,
    0,
    "Management acceptance requires a fresh isolated store, never existing providers",
  );
  const expectedTargets = ["codex", "claude_desktop", "claude_cli"];
  assert.deepEqual(
    initialOverview.targets.map((target) => target.target).sort(),
    [...expectedTargets].sort(),
  );
  for (const target of initialOverview.targets) {
    assert.equal(
      target.state,
      "unmanaged",
      "Existing managed target data must never enter this test",
    );
    assert.equal(target.activeProviderId, null);
    assert.equal(target.canRestore, false);
  }
  async function native(command, args = {}) {
    const result = await invoke(command, args);
    assert.ok(result.ok, `${command} failed: ${safeJson(result.error)}`);
    return result.result;
  }
  async function poll(read, predicate, label) {
    const deadline = Date.now() + 30000;
    let value;
    do {
      value = await read();
      if (predicate(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.fail(`${label} did not reach the expected native state`);
  }
  const physicalRoot = await fs.realpath(root);
  async function assertPhysicalPath(location) {
    checkWorkspacePath(location, "Synthetic fixture path");
    const resolved = await fs.realpath(location);
    const relative = path.relative(physicalRoot, resolved);
    assert.ok(
      relative === "" ||
        (!relative.startsWith(`..${path.sep}`) &&
          relative !== ".." &&
          !path.isAbsolute(relative)),
      "Synthetic fixture paths must physically remain in this workspace",
    );
    assert.doesNotMatch(resolved, /^C:[\\/]/iu);
  }
  await assertPhysicalPath(initialOverview.dataDirectory);
  const fixtureParent = path.join(
    initialOverview.dataDirectory,
    "native-ui-fixtures",
  );
  await fs.mkdir(fixtureParent, { recursive: true });
  await assertPhysicalPath(fixtureParent);
  const fixtureDirectory = path.join(fixtureParent, randomUUID());
  await fs.mkdir(fixtureDirectory);
  await assertPhysicalPath(fixtureDirectory);
  const managementMarker = JSON.stringify({
      purpose: "synthetic native UI acceptance",
      nativeOwnerId: evidence.ownedNativeSandbox.ownerId,
      createdAt: new Date().toISOString(),
    });
  await fs.writeFile(
    path.join(fixtureDirectory, ".ae-native-ui-owner.json"),
    managementMarker,
    { flag: "wx" },
  );
  managementRecovery = {
    directory: fixtureDirectory,
    markerSha256: createHash("sha256").update(managementMarker).digest("hex"),
    providerId: null,
    endpoint: null,
  };
  evidence.managementFixtureDirectory = fixtureDirectory;
  async function seed(relative, text) {
    const location = path.join(fixtureDirectory, relative);
    await fs.mkdir(path.dirname(location), { recursive: true });
    await assertPhysicalPath(path.dirname(location));
    await fs.writeFile(location, text, { flag: "wx" });
  }
  const profileId = "e82de475-47fa-4c54-9000-13571c000001";
  const baseline = {
    normal: {
      deploymentMode: "1p",
      mcpServers: { nativeQa: { command: "synthetic-never-run" } },
    },
    third: { deploymentMode: "1p", nativeQaKeep: true },
    profile: {
      inferenceProvider: "synthetic-baseline",
      inferenceGatewayApiKey: baselineKey,
      permissionMode: "default",
      nativeQaKeep: true,
    },
    meta: {
      entries: [{ id: "other-synthetic-profile", name: "Synthetic baseline" }],
      appliedId: "other-synthetic-profile",
      nativeQaKeep: true,
    },
    cli: {
      env: {
        ANTHROPIC_API_KEY: baselineKey,
        KEEP_NATIVE_UI: "yes",
        ENABLE_TOOL_SEARCH: "auto:10",
      },
      hooks: {},
      permissions: { allow: [] },
    },
  };
  const codexBaseline =
    '# AE native QA baseline\nmodel = "baseline-native-model"\nmodel_provider = "baseline_provider"\nmodel_reasoning_effort = "medium"\nservice_tier = "flex"\n[model_providers.baseline_provider]\nname = "Synthetic baseline"\nbase_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\n[projects."native-ui-keep"]\ntrust_level = "trusted"\n[features]\nfast_mode = false\nkeep = true\n';
  const codexAuth = JSON.stringify({ OPENAI_API_KEY: baselineKey });
  await seed("codex/config.toml", codexBaseline);
  await seed("codex/auth.json", codexAuth);
  await seed("claude_cli/settings.json", JSON.stringify(baseline.cli));
  await seed(
    "claude_desktop/Claude/claude_desktop_config.json",
    JSON.stringify(baseline.normal),
  );
  await seed(
    "claude_desktop/Claude-3p/claude_desktop_config.json",
    JSON.stringify(baseline.third),
  );
  await seed(
    `claude_desktop/Claude-3p/configLibrary/${profileId}.json`,
    JSON.stringify(baseline.profile),
  );
  await seed(
    "claude_desktop/Claude-3p/configLibrary/_meta.json",
    JSON.stringify(baseline.meta),
  );
  for (const target of expectedTargets)
    await native("set_directory", {
      target,
      directory: path.join(fixtureDirectory, target),
    });
  const unavailableModelId = "text-embedding-native-qa";
  const modelIds = [
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    ...Array.from(
      { length: 40 },
      (_, index) => `claude-sonnet-native-qa-${String(index).padStart(2, "0")}`,
    ),
    unavailableModelId,
  ];
  let modelRequests = 0;
  let modelMode = "normal";
  let retiredModelId = null;
  let balanceRequests = 0;
  let balanceMode = "unsupported";
  let balanceAmount = 42.5;
  fixtureServer = createServer((request, response) => {
    if (updateFixture?.handle(request, response)) return;
    const authenticated = [fixtureKey, rotatedFixtureKey].some(
      (key) => request.headers.authorization === `Bearer ${key}`,
    );
    if (
      request.method === "GET" &&
      request.url === "/v1/usage" &&
      authenticated
    ) {
      balanceRequests++;
      if (balanceMode === "success") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            mode: "quota_limited",
            isValid: true,
            quota: { remaining: balanceAmount, used: 7.5, limit: 50 },
            planName: "Synthetic QA plan",
            expires_at: "2030-01-01T00:00:00Z",
            rate_limits: [
              {
                window: "5h",
                used: 1,
                limit: 10,
                reset_at: "2030-01-01T00:00:00Z",
              },
            ],
          }),
        );
        return;
      }
      if (balanceMode === "auth") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: "Synthetic balance authorization denied" },
          }),
        );
        return;
      }
    }
    if (
      request.method === "GET" &&
      request.url === "/v1/models" &&
      authenticated
    ) {
      modelRequests++;
      if (modelMode === "http500") {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: "Synthetic model fetch failed" },
          }),
        );
        return;
      }
      const returnedModelIds =
        modelMode === "empty"
          ? []
          : modelIds.filter(
              (id) => modelMode !== "retired" || id !== retiredModelId,
            );
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          object: "list",
          data: returnedModelIds.map((id) => ({
            id,
            object: "model",
            owned_by: "synthetic-native-qa",
          })),
        }),
      );
    } else {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "Controlled QA fixture has no endpoint for this request",
          },
        }),
      );
    }
  });
  await new Promise((resolve, reject) => {
    fixtureServer.once("error", reject);
    fixtureServer.listen(updateFixture?.port ?? 0, "127.0.0.1", resolve);
  });
  const fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}/v1`;
  let provider = await native("save_provider", {
    input: {
      id: null,
      family: "codex",
      name: "Synthetic native QA",
      baseUrl: fixtureUrl,
      apiKey: fixtureKey,
      model: modelIds[0],
      authMode: "bearer",
      reasoningEffort: null,
      codexOptions: {
        upstreamProtocol: "openai",
        protocol: "openai",
        protocolDetectedAt: Date.now(),
        fastMode: false,
        contextWindow: null,
        autoCompactTokenLimit: null,
        balanceQuery: null,
        modelsSyncedAt: Date.now(),
        models: modelIds.map((id) => ({
          id,
          enabled: id !== unavailableModelId,
          contextWindow: 256000,
          reasoningEfforts: [],
        })),
      },
    },
  });
  assert.equal(provider.hasKey, true);
  assert.ok(
    !JSON.stringify(provider).includes(fixtureKey),
    "Native provider summaries must not contain the stored key",
  );
  await record("native-synthetic-provider-saved", {
    providerId: provider.id,
    secretReturned: false,
    supplierInferenceVerified: false,
  });
  const providerId = provider.id;
  managementRecovery.providerId = providerId;
  managementRecovery.endpoint = fixtureUrl;
  async function currentProvider() {
    const overview = await native("get_overview");
    return overview.providers.find((item) => item.id === providerId);
  }
  async function waitProvider(predicate, label) {
    provider = await poll(
      currentProvider,
      (value) => value && predicate(value),
      label,
    );
    return provider;
  }
  async function waitTarget(target, predicate) {
    return poll(
      async () =>
        (await native("get_overview")).targets.find(
          (item) => item.target === target,
        ),
      predicate,
      `${target} status`,
    );
  }
  async function refreshUi() {
    const refresh = page.getByRole("button", {
      name: "刷新配置状态",
      exact: true,
    });
    await refresh.waitFor();
    await poll(
      () => refresh.isEnabled(),
      (value) => value,
      "Native refresh button",
    );
    await refresh.click();
    await poll(
      () => refresh.isEnabled(),
      (value) => value,
      "Native UI refresh completed",
    );
  }
  async function laterRestart() {
    const later = page.getByRole("button", { name: "稍后重启", exact: true });
    if (await later.isVisible()) {
      await later.click();
      await later.waitFor({ state: "hidden" });
      await record("native-restart-deferred", { processRestarted: false });
    }
  }
  async function selectTarget(target) {
    await laterRestart();
    await page
      .getByRole("tab", {
        name: target === "codex" ? /^Codex\b/u : /^Claude Code\b/u,
      })
      .click();
    if (target !== "codex")
      await page
        .getByRole("group", { name: "Claude 配置目标", exact: true })
        .getByRole("button", {
          name: target === "claude_cli" ? "CLI" : "桌面端",
          exact: true,
        })
        .click();
    await page
      .getByRole("button", { name: `修改名称 ${provider.name}`, exact: true })
      .waitFor();
  }
  function providerCard() {
    return page
      .locator("li.provider-card")
      .filter({ has: page.locator(`[data-provider-name="${providerId}"]`) });
  }
  await page
    .getByRole("button", { name: "高级供应商管理", exact: true })
    .click();
  await page.getByRole("tab", { name: /^Codex\b/u }).waitFor();
  await page
    .getByRole("button", { name: "返回 Agent Hub", exact: true })
    .click();
  await page.getByRole("heading", { name: /你的 Agent，随时就绪/u }).waitFor();
  await page
    .getByRole("button", { name: "高级供应商管理", exact: true })
    .click();
  await page.getByRole("tab", { name: /^Codex\b/u }).waitFor();
  await selectTarget("codex");
  await refreshUi();
  await record("native-advanced-navigation", {
    routes: ["AgentHub", "advanced", "AgentHub", "advanced"],
    actualTauriRuntime: true,
  });
  const balance = providerCard().locator(".provider-balance");
  const summary = balance.locator(".balance-summary");
  await poll(
    () => summary.innerText(),
    (value) => value.includes("暂不支持余额查询"),
    "Unsupported native balance endpoint",
  );
  const details = balance.getByRole("button", {
    name: `查看 ${provider.name} 余额详情`,
    exact: true,
  });
  await details.click();
  assert.equal(await details.getAttribute("aria-expanded"), "true");
  await balance.getByText(/余额查询不影响配置接入/u).waitFor();
  const refreshBalance = balance.getByRole("button", {
    name: `刷新 ${provider.name} 余额`,
    exact: true,
  });
  balanceMode = "success";
  const beforeSuccess = balanceRequests;
  await refreshBalance.click();
  await poll(
    () => summary.innerText(),
    (value) => value.includes("42.5 USD") && !value.includes("上次结果"),
    "Actual native balance success",
  );
  assert.ok(balanceRequests > beforeSuccess);
  assert.match(
    await balance.locator(".balance-detail-content").innerText(),
    /Synthetic QA plan/u,
  );
  assert.match(
    await balance.locator(".balance-detail-content").innerText(),
    /已用 7.5 USD/u,
  );
  assert.match(
    await balance.locator(".balance-detail-content").innerText(),
    /5 小时额度剩余 9 USD/u,
  );
  assert.ok(await summary.getAttribute("title"));
  balanceAmount = 41.25;
  const beforeRefresh = balanceRequests;
  await refreshBalance.click();
  await poll(
    () => summary.innerText(),
    (value) => value.includes("41.25 USD"),
    "Manual balance refresh replaces result",
  );
  assert.ok(
    balanceRequests > beforeRefresh,
    "Manual refresh must reach the actual Rust HTTP client despite its cache",
  );
  balanceMode = "auth";
  await refreshBalance.click();
  await poll(
    () => summary.innerText(),
    (value) => value.includes("41.25 USD") && value.includes("上次结果"),
    "Balance authorization failure retains last success",
  );
  assert.match(
    await balance.locator(".balance-detail-content").innerText(),
    /上次成功查询/u,
  );
  assert.match(
    await balance.locator(".balance-detail-content").innerText(),
    /拒绝访问/u,
  );
  balanceMode = "unsupported";
  await refreshBalance.click();
  await poll(
    () => balance.locator(".balance-detail-content").innerText(),
    (value) => value.includes("未找到可用的余额接口"),
    "Unsupported refresh retains history",
  );
  assert.match(await summary.innerText(), /41.25 USD.*上次结果/u);
  balanceMode = "success";
  await refreshBalance.click();
  await poll(
    () => summary.innerText(),
    (value) => value.includes("41.25 USD") && !value.includes("上次结果"),
    "Balance recovery clears stale status",
  );
  await details.click();
  assert.equal(await details.getAttribute("aria-expanded"), "false");
  await record("native-balance-full-ui", {
    actualRustHttpRequests: balanceRequests,
    unsupported: true,
    successAndDetails: true,
    manualRefresh: true,
    authFailureRetainsHistory: true,
    unsupportedFailureRetainsHistory: true,
    recovered: true,
    syntheticFixtureOnly: true,
    realSupplierBalanceVerified: false,
  });
  const beforeCancelledForm = await currentProvider();
  await page.getByRole("button", { name: "添加供应商", exact: true }).click();
  const cancelledForm = page.getByRole("dialog", {
    name: "添加供应商",
    exact: true,
  });
  await cancelledForm.locator("#baseUrl").fill(fixtureUrl);
  await cancelledForm.locator("#apiKey").fill(fixtureKey);
  await cancelledForm.locator("#name").fill("Synthetic cancelled draft");
  await cancelledForm
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await cancelledForm.waitFor({ state: "hidden" });
  assert.equal((await native("get_overview")).providers.length, 1);
  assert.deepEqual(await currentProvider(), beforeCancelledForm);
  await page.getByRole("button", { name: "搜索供应商", exact: true }).click();
  const search = page.getByRole("textbox", {
    name: "搜索 API 配置",
    exact: true,
  });
  await search.fill(provider.name);
  await providerCard().waitFor();
  assert.equal(await providerCard().count(), 1);
  await search.fill("synthetic-no-matching-provider");
  await providerCard().waitFor({ state: "hidden" });
  assert.equal(await providerCard().count(), 0);
  await search.press("Escape");
  assert.equal(await search.inputValue(), "");
  await providerCard().waitFor();
  await page
    .getByRole("button", { name: `置顶 ${provider.name}`, exact: true })
    .click();
  assert.equal(
    await page
      .getByRole("button", { name: `取消置顶 ${provider.name}`, exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  await page
    .getByRole("button", { name: "返回 Agent Hub", exact: true })
    .click();
  await page
    .getByRole("button", { name: "高级供应商管理", exact: true })
    .click();
  await selectTarget("codex");
  await page
    .getByRole("button", { name: `取消置顶 ${provider.name}`, exact: true })
    .click();
  assert.equal(
    await page
      .getByRole("button", { name: `置顶 ${provider.name}`, exact: true })
      .getAttribute("aria-pressed"),
    "false",
  );
  await record("native-search-pin-form-cancel", {
    cancelledDraftDidNotWrite: true,
    searchMatchedAndFiltered: true,
    escapeClearedSearch: true,
    pinSurvivedNavigation: true,
    pinRestored: true,
    syntheticCredentialsOnly: true,
  });
  await page
    .getByRole("button", { name: `修改名称 ${provider.name}`, exact: true })
    .click();
  await page
    .getByRole("textbox", {
      name: `供应商名称 · ${provider.name}`,
      exact: true,
    })
    .fill("Synthetic native QA renamed");
  await page
    .getByRole("button", { name: "保存供应商名称", exact: true })
    .click();
  await waitProvider(
    (value) => value.name === "Synthetic native QA renamed",
    "Inline provider rename",
  );
  await page
    .getByRole("button", { name: `修改名称 ${provider.name}`, exact: true })
    .waitFor();
  await record("native-provider-renamed", {
    sameProviderId: provider.id === providerId,
    keyRetained: provider.hasKey,
  });
  const fast = page.getByRole("switch", {
    name: `Fast 模式 · ${provider.name}`,
    exact: true,
  });
  assert.equal(await fast.isChecked(), false);
  await fast.click();
  await waitProvider(
    (value) => value.codexOptions.fastMode === true,
    "Fast mode on",
  );
  await poll(
    () => fast.isChecked(),
    Boolean,
    "Fast checked after saved state refresh",
  );
  await poll(
    () => fast.isEnabled(),
    (value) => value,
    "Fast switch unlocked",
  );
  await fast.click();
  await waitProvider(
    (value) => value.codexOptions.fastMode === false,
    "Fast mode off",
  );
  await poll(
    () => fast.isChecked(),
    (value) => !value,
    "Fast unchecked after saved state refresh",
  );
  await record("native-fast-mode", {
    enabledThenDisabled: true,
    activeTargetChanged: false,
  });
  await page
    .getByRole("button", { name: `配置 ${provider.name} 的模型`, exact: true })
    .click();
  const modelDialog = page.getByRole("dialog", {
    name: `${provider.name} · 模型配置`,
    exact: true,
  });
  await modelDialog
    .getByRole("button", { name: "刷新模型列表", exact: true })
    .click();
  await poll(
    () => modelRequests,
    (value) => value > 0,
    "Actual native model discovery request",
  );
  await poll(
    () =>
      modelDialog
        .getByRole("button", { name: "保存模型配置", exact: true })
        .isEnabled(),
    (value) => value,
    "Native model discovery completed",
  );
  await modelDialog
    .getByRole("button", {
      name: `将 ${modelIds[1]} 设为默认模型`,
      exact: true,
    })
    .click();
  await modelDialog
    .getByRole("textbox", { name: `上下文长度 ${modelIds[1]}`, exact: true })
    .fill("128");
  await modelDialog
    .getByRole("button", { name: "保存模型配置", exact: true })
    .click();
  await modelDialog.waitFor({ state: "hidden" });
  await waitProvider(
    (value) =>
      value.model === modelIds[1] &&
      value.codexOptions.models.find((model) => model.id === modelIds[1])
        ?.contextWindow === 128000,
    "Native model draft commit",
  );
  assert.ok(
    modelRequests > 0,
    "Model management must query the actual Rust HTTP client and fixture",
  );
  await record("native-model-settings", {
    model: provider.model,
    contextWindow: 128000,
    actualRustHttpRequests: modelRequests,
    realSupplierInferenceVerified: false,
  });
  await page
    .getByRole("button", { name: `编辑 ${provider.name}`, exact: true })
    .click();
  const editor = page.getByRole("dialog", { name: "编辑供应商", exact: true });
  await editor
    .getByRole("textbox", { name: "供应商名称", exact: true })
    .fill("Synthetic native QA edited");
  await editor.getByRole("button", { name: "保存修改", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  await waitProvider(
    (value) => value.name === "Synthetic native QA edited",
    "Native edit provider commit",
  );
  assert.equal(provider.id, providerId);
  assert.equal(provider.hasKey, true);
  await record("native-provider-edit", {
    idRetained: true,
    blankKeyRetained: true,
    applied: false,
  });
  await verifyManagementExtras({
    page,
    native,
    record,
    providerId,
    fixtureKey,
    unavailableModelId,
    expectedRoot: nativeRoot,
    fixtureDirectory,
    modelFixture: {
      ids: [...modelIds],
      requests: () => modelRequests,
      setMode(mode, retiredId = null) {
        assert.ok(["normal", "http500", "empty", "retired"].includes(mode));
        if (mode === "retired") assert.ok(modelIds.includes(retiredId));
        modelMode = mode;
        retiredModelId = mode === "retired" ? retiredId : null;
      },
    },
  });
  await verifyBusinessExtras({
    page,
    native,
    record,
    expectedRoot: nativeRoot,
    fixtureDirectory,
    fixtureKey,
  });
  const background = await native("get_background_settings");
  assert.deepEqual(background, { supported: false, enabled: false });
  const backgroundDenied = await invoke("set_background_start", {
    enabled: true,
  });
  assert.equal(backgroundDenied.ok, false);
  assert.equal(backgroundDenied.error.code, "qa_isolation");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", {
    name: "Codex 设置",
    exact: true,
  });
  assert.equal(
    await settings
      .getByRole("checkbox", {
        name: "随 Windows 启动，在后台运行",
        exact: true,
      })
      .isEnabled(),
    false,
  );
  await settings.getByRole("button", { name: "关闭弹窗", exact: true }).click();
  await record("native-portable-background", {
    supported: false,
    enabled: false,
    mutationRejected: true,
    errorCode: backgroundDenied.error.code,
  });
  const updateSource = await native("get_update_source");
  if (updateFixture) {
    await verifyUpdateExtras({
      page,
      invoke,
      record,
      fixture: updateFixture,
      updateSource,
      expectedVersion: expectedAppVersion,
      nativeRoot,
      assertPhysicalWorkspacePath,
    });
  } else if (updateSource.repository) {
    assert.match(
      updateSource.repository,
      /^[^/]+\/[A-Za-z0-9_.-]+$/u,
      "A configured update source must be an owner/repository pair",
    );
    assert.equal(
      updateSource.currentVersion,
      expectedAppVersion,
      "The configured update source must report the exact app/package.json version",
    );
    const updateEntry = page.getByRole("button", {
      name: /^检查更新，当前版本 v/u,
    });
    assert.equal(
      await updateEntry.getAttribute("aria-label"),
      `检查更新，当前版本 v${expectedAppVersion}`,
      "The configured update entry must display the exact app/package.json version",
    );
    assert.equal(
      (await updateEntry.locator(".app-version-label").innerText()).trim(),
      `v${expectedAppVersion}`,
    );
    await updateEntry.click();
    const updateDialog = page.getByRole("dialog", {
      name: "软件更新",
      exact: true,
    });
    await updateDialog
      .getByText("启动时自动检查 GitHub 正式版本；更新后按发布页说明安装。", {
        exact: true,
      })
      .waitFor();
    assert.equal(
      (
        await updateDialog.locator(".app-update-status strong").innerText()
      ).trim(),
      `v${expectedAppVersion}`,
      "The configured update dialog must display the exact app/package.json version",
    );
    assert.equal(
      await updateDialog
        .getByRole("button", { name: "检测更新", exact: true })
        .isEnabled(),
      true,
      "A bound update repository must enable update detection",
    );
    assert.equal(
      await updateDialog
        .getByRole("button", { name: "查看发布页", exact: true })
        .count(),
      1,
      "A bound update repository must expose its release page action",
    );
    await updateDialog
      .getByRole("button", { name: "关闭弹窗", exact: true })
      .click();
    await record("native-update-configured-ui", {
      repository: updateSource.repository,
      currentVersion: expectedAppVersion,
      detectionEnabled: true,
      releaseLinkPresent: true,
      onlineUpdateTested: false,
    });
  } else {
    assert.equal(
      updateSource.repository,
      null,
      "This production build has no bound update repository",
    );
    const updateEntry = page.getByRole("button", {
      name: /^检查更新，当前版本 v/u,
    });
    assert.equal(
      await updateEntry.getAttribute("aria-label"),
      `检查更新，当前版本 v${expectedAppVersion}`,
      "The update entry must display the exact app/package.json version",
    );
    assert.equal(
      (await updateEntry.locator(".app-version-label").innerText()).trim(),
      `v${expectedAppVersion}`,
    );
    await updateEntry.click();
    const updateDialog = page.getByRole("dialog", {
      name: "软件更新",
      exact: true,
    });
    await updateDialog
      .getByText("此构建尚未绑定 GitHub 发布仓库，绑定后即可检测更新。", {
        exact: true,
      })
      .waitFor();
    assert.equal(
      (
        await updateDialog.locator(".app-update-status strong").innerText()
      ).trim(),
      `v${expectedAppVersion}`,
      "The update dialog must display the exact app/package.json version",
    );
    assert.equal(
      await updateDialog
        .getByRole("button", { name: "检测更新", exact: true })
        .isEnabled(),
      false,
    );
    assert.equal(
      await updateDialog
        .getByRole("button", { name: /查看发布页|前往下载/u })
        .count(),
      0,
    );
    assert.equal(
      await updateDialog.getByText("已是最新版本", { exact: true }).count(),
      0,
    );
    await updateDialog
      .getByRole("button", { name: "关闭弹窗", exact: true })
      .click();
    await record("native-update-unconfigured-ui", {
      repository: null,
      currentVersion: expectedAppVersion,
      detectionDisabled: true,
      releaseLinkAbsent: true,
      noFabricatedLatestStatus: true,
      onlineUpdateTested: false,
    });
  }
  await selectTarget("claude_desktop");
  const conversion = page.getByRole("switch", {
    name: `转换为 Claude · ${provider.name}`,
    exact: true,
  });
  assert.equal(await conversion.isChecked(), true);
  await conversion.click();
  await waitProvider(
    (value) =>
      (value.codexOptions.conversionDisabledTargets ?? []).includes(
        "claude_desktop",
      ),
    "Protocol conversion off",
  );
  await poll(
    async () => ({
      checked: await conversion.isChecked(),
      enabled: await conversion.isEnabled(),
    }),
    (value) => !value.checked && value.enabled,
    "Conversion off reflected in unlocked UI",
  );
  assert.equal(
    await providerCard().locator(".apply-button").isEnabled(),
    false,
  );
  const conversionDenied = await invoke("apply_provider", {
    target: "claude_desktop",
    providerId,
  });
  assert.equal(conversionDenied.ok, false);
  assert.equal(conversionDenied.error.code, "conversion_required");
  await poll(
    () => conversion.isEnabled(),
    (value) => value,
    "Conversion switch unlocked",
  );
  await poll(
    () => conversion.isChecked(),
    (value) => !value,
    "Conversion switch off after save",
  );
  await conversion.click();
  await waitProvider(
    (value) =>
      !(value.codexOptions.conversionDisabledTargets ?? []).includes(
        "claude_desktop",
      ),
    "Protocol conversion on",
  );
  await poll(
    async () => ({
      checked: await conversion.isChecked(),
      enabled: await conversion.isEnabled(),
    }),
    (value) => value.checked && value.enabled,
    "Conversion on reflected in unlocked UI",
  );
  await record("native-protocol-conversion", {
    target: "claude_desktop",
    toggled: true,
    incompatibleApplyRejected: true,
  });
  async function readFixture(relative) {
    const location = path.join(fixtureDirectory, relative);
    await assertPhysicalPath(location);
    return fs.readFile(location, "utf8");
  }
  async function readJson(relative) {
    return JSON.parse(await readFixture(relative));
  }
  // Keep all three owned synthetic targets active while exercising connection
  // synchronization. No launcher or client restart is requested.
  for (const target of expectedTargets) {
    await selectTarget(target);
    await providerCard().locator(".apply-button").click();
    await waitTarget(
      target,
      (value) =>
        value?.state === "applied" && value.activeProviderId === providerId,
    );
    if (target === "codex")
      await page
        .getByRole("dialog", { name: "重启 Codex 使配置生效", exact: true })
        .waitFor();
    await laterRestart();
  }
  const protectedFiles = [
    "codex/config.toml",
    "codex/auth.json",
    "codex/uni-switch-models.json",
    "claude_cli/settings.json",
    "claude_desktop/Claude/claude_desktop_config.json",
    `claude_desktop/Claude-3p/configLibrary/${profileId}.json`,
  ];
  const readProtected = async () =>
    Promise.all(protectedFiles.map((relative) => readFixture(relative)));
  const initialProtected = await readProtected();
  const initialCli = JSON.parse(initialProtected[3]);
  const initialDesktop = JSON.parse(initialProtected[4]);
  const initialProfile = JSON.parse(initialProtected[5]);
  for (const token of [
    initialCli.env.ANTHROPIC_AUTH_TOKEN,
    initialProfile.inferenceGatewayApiKey,
  ])
    if (token) secrets.add(token);
  const assertProtectedPreferences = async () => {
    const current = await readProtected();
    assert.equal(
      current[1],
      codexAuth,
      "Synchronization must retain original Codex auth.json",
    );
    assert.match(current[0], new RegExp(`^model = "${provider.model}"$`, "mu"));
    assert.match(current[0], /native-ui-keep/u);
    const catalog = JSON.parse(current[2]);
    assert.equal(
      catalog.models.find((model) => model.slug === provider.model)
        .context_window,
      128000,
    );
    const cli = JSON.parse(current[3]);
    assert.equal(cli.env.ANTHROPIC_MODEL, initialCli.env.ANTHROPIC_MODEL);
    assert.equal(cli.env.KEEP_NATIVE_UI, "yes");
    assert.deepEqual(cli.hooks, baseline.cli.hooks);
    assert.deepEqual(cli.permissions, baseline.cli.permissions);
    assert.deepEqual(
      JSON.parse(current[4]).mcpServers,
      initialDesktop.mcpServers,
    );
    const profile = JSON.parse(current[5]);
    assert.deepEqual(profile.inferenceModels, initialProfile.inferenceModels);
    assert.equal(profile.nativeQaKeep, true);
    assert.equal(profile.permissionMode, initialProfile.permissionMode);
  };
  const setAutoSync = async (enabled) => {
    await selectTarget("codex");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "Codex 设置",
      exact: true,
    });
    const control = dialog.getByRole("checkbox", {
      name: "保存供应商后，自动更新所有已使用它的客户端",
      exact: true,
    });
    await control.setChecked(enabled);
    await dialog.getByRole("button", { name: "关闭弹窗", exact: true }).click();
  };
  await setAutoSync(false);
  const beforeCancelledActive = await currentProvider();
  await page
    .getByRole("button", { name: `编辑 ${provider.name}`, exact: true })
    .click();
  let activeEditor = page.getByRole("dialog", {
    name: "编辑供应商",
    exact: true,
  });
  await activeEditor.locator("#name").fill("Synthetic cancelled active edit");
  await activeEditor.locator("#apiKey").fill(rotatedFixtureKey);
  await activeEditor.getByRole("button", { name: "取消", exact: true }).click();
  await activeEditor.waitFor({ state: "hidden" });
  assert.deepEqual(await currentProvider(), beforeCancelledActive);
  assert.deepEqual(
    await readProtected(),
    initialProtected,
    "Cancelling an active edit must not write any client configuration",
  );
  const editActiveKey = async (key) => {
    await page
      .getByRole("button", { name: `编辑 ${provider.name}`, exact: true })
      .click();
    activeEditor = page.getByRole("dialog", {
      name: "编辑供应商",
      exact: true,
    });
    assert.equal(
      await activeEditor.locator("#apiKey").inputValue(),
      "",
      "An active saved key must not be echoed into the form",
    );
    await activeEditor.locator("#apiKey").fill(key);
    await activeEditor
      .getByRole("button", { name: "保存并使用", exact: true })
      .click();
    await activeEditor.waitFor({ state: "hidden", timeout: 45000 });
    await waitTarget("codex", (value) => value?.state === "applied");
    await laterRestart();
    provider = await currentProvider();
    assert.ok(
      (await readFixture("codex/config.toml")).includes(key),
      "Active edit must write the selected connection's synthetic key",
    );
  };
  await editActiveKey(rotatedFixtureKey);
  for (const target of ["claude_desktop", "claude_cli"])
    await waitTarget(target, (value) => value?.state === "saved_changes");
  assert.deepEqual(
    (await readProtected()).slice(3),
    initialProtected.slice(3),
    "Manual mode must retain other clients' files until explicit synchronization",
  );
  await providerCard().locator(".provider-sync-button").click();
  for (const target of expectedTargets)
    await waitTarget(target, (value) => value?.state === "applied");
  await assertProtectedPreferences();
  await setAutoSync(true);
  await editActiveKey(fixtureKey);
  for (const target of expectedTargets)
    await waitTarget(target, (value) => value?.state === "applied");
  await assertProtectedPreferences();
  assert.equal(
    await providerCard().locator(".provider-sync-button").count(),
    0,
  );
  await setAutoSync(false);
  await record("native-active-provider-sync", {
    activeEditCancelNoWrites: true,
    manualModeRetainsOtherFiles: true,
    explicitManualSync: true,
    autoSyncAfterActiveSave: true,
    originalKeyRestored: true,
    modelContextMcpAuthAndUnmanagedSettingsRetained: true,
    globalClientRestarted: false,
    syntheticOwnedTargetsOnly: true,
  });
  await verifySyncRetry({ page, invoke, record, providerId, fixtureDirectory });
  await verifyOptionsExtras({
    page,
    invoke,
    record,
    providerId,
    fixtureDirectory,
  });
  // Release these extra simultaneous applications before the original
  // independent apply/restore checks below, preserving their baseline claims.
  for (const target of expectedTargets) {
    await selectTarget(target);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "恢复原配置", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "恢复原来的 API 配置？", exact: true })
      .getByRole("button", { name: "恢复原配置", exact: true })
      .click();
    await waitTarget(
      target,
      (value) =>
        value?.state === "unmanaged" &&
        value.activeProviderId === null &&
        !value.canRestore,
    );
    if (target === "codex")
      await page
        .getByRole("dialog", { name: "重启 Codex 使配置生效", exact: true })
        .waitFor();
    await laterRestart();
  }
  for (const target of expectedTargets) {
    await selectTarget(target);
    await poll(
      () => providerCard().locator(".apply-button").isEnabled(),
      (value) => value,
      `${target} apply enabled`,
    );
    await providerCard().locator(".apply-button").click();
    const applied = await waitTarget(
      target,
      (value) =>
        value?.state === "applied" &&
        value.activeProviderId === providerId &&
        value.canRestore,
    );
    for (const location of applied.files) await assertPhysicalPath(location);
    if (target === "codex")
      await page
        .getByRole("dialog", { name: "重启 Codex 使配置生效", exact: true })
        .waitFor();
    await laterRestart();
    assert.equal(
      await page
        .getByRole("button", { name: `删除 ${provider.name}`, exact: true })
        .isEnabled(),
      false,
    );
    const activeDelete = await invoke("delete_provider", { providerId });
    assert.equal(activeDelete.ok, false);
    assert.equal(activeDelete.error.code, "in_use");
    if (target === "codex") {
      const config = await readFixture("codex/config.toml");
      assert.match(config, new RegExp(`^model = "${provider.model}"$`, "mu"));
      assert.match(config, /^model_provider = "uni_switch"$/mu);
      assert.match(config, /^service_tier = "default"$/mu);
      assert.ok(config.includes(fixtureUrl));
      assert.ok(config.includes(fixtureKey));
      assert.match(config, /native-ui-keep/u);
      assert.equal(await readFixture("codex/auth.json"), codexAuth);
      const catalog = await readJson("codex/uni-switch-models.json");
      const selectedCatalogModel = catalog.models.find(
        (model) => model.slug === provider.model,
      );
      assert.ok(selectedCatalogModel);
      assert.equal(selectedCatalogModel.context_window, 128000);
    } else if (target === "claude_desktop") {
      const normal = await readJson(
        "claude_desktop/Claude/claude_desktop_config.json",
      );
      const profile = await readJson(
        `claude_desktop/Claude-3p/configLibrary/${profileId}.json`,
      );
      if (profile.inferenceGatewayApiKey)
        secrets.add(profile.inferenceGatewayApiKey);
      assert.equal(normal.deploymentMode, "3p");
      assert.deepEqual(normal.mcpServers, baseline.normal.mcpServers);
      assert.equal(profile.inferenceProvider, "gateway");
      assert.match(
        profile.inferenceGatewayBaseUrl,
        /^http:\/\/127\.0\.0\.1:\d+/u,
      );
      assert.equal(profile.nativeQaKeep, true);
      assert.ok(profile.inferenceModels.length > 0);
      assert.equal(
        (await readJson("claude_desktop/Claude-3p/configLibrary/_meta.json"))
          .appliedId,
        profileId,
      );
      assert.ok(!JSON.stringify(profile).includes(fixtureKey));
    } else {
      const cli = await readJson("claude_cli/settings.json");
      if (cli.env.ANTHROPIC_AUTH_TOKEN)
        secrets.add(cli.env.ANTHROPIC_AUTH_TOKEN);
      assert.equal(cli.env.KEEP_NATIVE_UI, "yes");
      assert.equal(cli.env.ANTHROPIC_MODEL, provider.model);
      assert.match(cli.env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+/u);
      assert.equal(cli.env.ENABLE_TOOL_SEARCH, "false");
      assert.ok(!Object.hasOwn(cli.env, "ANTHROPIC_API_KEY"));
      assert.deepEqual(cli.hooks, baseline.cli.hooks);
      assert.ok(!JSON.stringify(cli).includes(fixtureKey));
    }
    await record("native-legacy-apply", {
      target,
      state: applied.state,
      baselineAvailable: applied.canRestore,
      nativeFiles: applied.files.length,
      activeDeleteRejected: true,
    });
    await laterRestart();
    if (target === "codex")
      await verifyOwnedConflict({
        page,
        native,
        invoke,
        record,
        target,
        fixtureDirectory,
        expectedRoot: nativeRoot,
      });
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "恢复原配置", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "恢复原来的 API 配置？", exact: true })
      .getByRole("button", { name: "恢复原配置", exact: true })
      .click();
    const restored = await waitTarget(
      target,
      (value) =>
        value?.state === "unmanaged" &&
        value.activeProviderId === null &&
        !value.canRestore,
    );
    if (target === "codex")
      await page
        .getByRole("dialog", { name: "重启 Codex 使配置生效", exact: true })
        .waitFor();
    await laterRestart();
    if (target === "codex") {
      const config = await readFixture("codex/config.toml");
      for (const setting of [
        'model = "baseline-native-model"',
        'model_provider = "baseline_provider"',
        'model_reasoning_effort = "medium"',
        'service_tier = "flex"',
        "fast_mode = false",
        'trust_level = "trusted"',
        "keep = true",
      ])
        assert.ok(
          config.includes(setting),
          `Codex baseline setting was not restored: ${setting}`,
        );
      assert.match(config, /# AE native QA baseline/u);
      assert.ok(!config.includes(fixtureKey));
      assert.ok(!config.includes("uni_switch"));
      assert.equal(await readFixture("codex/auth.json"), codexAuth);
    } else if (target === "claude_desktop") {
      assert.deepEqual(
        await readJson("claude_desktop/Claude/claude_desktop_config.json"),
        baseline.normal,
      );
      assert.deepEqual(
        await readJson("claude_desktop/Claude-3p/claude_desktop_config.json"),
        baseline.third,
      );
      assert.deepEqual(
        await readJson(
          `claude_desktop/Claude-3p/configLibrary/${profileId}.json`,
        ),
        baseline.profile,
      );
      assert.deepEqual(
        await readJson("claude_desktop/Claude-3p/configLibrary/_meta.json"),
        baseline.meta,
      );
    } else
      assert.deepEqual(
        await readJson("claude_cli/settings.json"),
        baseline.cli,
      );
    await record("native-legacy-restore", {
      target,
      state: restored.state,
      baselineReleased: !restored.canRestore,
      originalSettingsAndUnmanagedFieldsRestored: true,
    });
  }
  await laterRestart();
  await page
    .getByRole("button", { name: `删除 ${provider.name}`, exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "删除这组配置？", exact: true })
    .getByRole("button", { name: "删除配置", exact: true })
    .click();
  await poll(
    () => native("get_overview"),
    (value) => value.providers.length === 0,
    "Synthetic provider deleted",
  );
  await record("native-provider-deleted", {
    syntheticProviderRemoved: true,
    existingProvidersTouched: false,
  });
  for (const target of initialOverview.targets)
    await native("set_directory", {
      target: target.target,
      directory: target.directory,
    });
  await page
    .getByRole("button", { name: "返回 Agent Hub", exact: true })
    .click();
  await page.getByRole("heading", { name: /你的 Agent，随时就绪/u }).waitFor();
  const finalOverview = await native("get_overview");
  assert.deepEqual(finalOverview.providers, initialOverview.providers);
  for (const original of initialOverview.targets) {
    const current = finalOverview.targets.find(
      (target) => target.target === original.target,
    );
    assert.equal(
      path.resolve(current.directory),
      path.resolve(original.directory),
    );
    assert.equal(current.activeProviderId, null);
    assert.equal(current.canRestore, false);
  }
  await record("native-management-acceptance-passed", {
    syntheticCredentialsOnly: true,
    originalTargetDirectoriesRestored: true,
    fixturesRetainedInIsolatedRoot: true,
    actualProcessRestartTested: false,
    actualSupplierInferenceTested: false,
  });
}

// Read only the current committed React state. Never intercept invoke, alter
// hooks/DOM, or issue another probe to reconstruct a result.
async function readCurrentProbe() {
  return page.evaluate(() => {
    const container = document.getElementById("root");
    const property =
      container &&
      Object.keys(container).find((key) => key.startsWith("__reactContainer$"));
    const current = property && container[property]?.stateNode?.current;
    if (!current) return null;
    const pending = [current];
    while (pending.length) {
      const fiber = pending.pop();
      if (fiber.child) pending.push(fiber.child);
      if (fiber.sibling) pending.push(fiber.sibling);
      if (typeof fiber.type !== "function") continue;
      for (let hook = fiber.memoizedState; hook; hook = hook.next) {
        const value = hook.memoizedState;
        if (
          value &&
          typeof value === "object" &&
          typeof value.ok === "boolean" &&
          typeof value.toolVerified === "boolean" &&
          typeof value.stage === "string" &&
          ["connection", "tool"].includes(value.validationScope)
        )
          return JSON.parse(JSON.stringify(value));
      }
    }
    return null;
  });
}

async function verifyAgentFiles(agent, providerId, model, gateway) {
  if (existingFixture) {
    const route = `http://127.0.0.1:${gateway.port}/agents/selected:${agent.id}`;
    return verifyExistingAgentFiles({
      workspaceRoot: root,
      nativeRoot: path.join(nativeRoot, "data"),
      agent: agent.id,
      providerId,
      model,
      gateway: {
        baseUrl: agent.id === "claude_code" ? route : `${route}/v1`,
        token: gateway.token,
      },
      fixture: existingFixture,
      assertPhysicalWorkspacePath,
    });
  }
  const dataDirectory = path.join(nativeRoot, "data");
  const directory = path.join(dataDirectory, "agents", agent.id);
  assert.ok(
    samePath(agent.directory, directory),
    "The selected Agent must use this sandbox's own configuration directory",
  );
  await assertPhysicalWorkspacePath(directory);
  const configurations = {
    claude_code: ["home/.claude/settings.json"],
    codex: ["home/.codex/config.toml"],
    hermes: ["home/.hermes/config.yaml"],
    oh_my_pi: ["home/.omp/agent/models.yml", "home/.omp/agent/config.yml"],
    opencode: ["configuration/opencode.json"],
    zcode: [
      "configuration/zcode-providers.json",
      "configuration/zcode-builtin.json",
    ],
    workbuddy: ["home/.workbuddy/models.json"],
    deepseek_harness: [
      "home/.dsh/profiles/headless/cordis.patch.yml",
      "home/.dsh/profiles/headless/package.json",
    ],
  };
  const files = [
    ...configurations[agent.id],
    "configuration/environment.json",
    "launch.ps1",
    "launch.cmd",
  ];
  const zcodeState = "home/.zcode/v2/agents-state.json";
  if (agent.id === "zcode") {
    try {
      await fs.lstat(path.join(directory, zcodeState));
      files.push(zcodeState);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const contents = new Map();
  const hashes = [];
  for (const relative of files) {
    const location = path.join(directory, relative);
    await assertPhysicalWorkspacePath(location);
    const bytes = await fs.readFile(location);
    contents.set(relative, bytes.toString("utf8"));
    hashes.push({
      path: location,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  assert.ok(
    agent.launcher &&
      samePath(agent.launcher, path.join(directory, "launch.cmd")),
  );
  const environment = JSON.parse(
    contents.get("configuration/environment.json"),
  );
  assert.ok(samePath(environment.AE_AGENT_ROOT, directory));
  assert.ok(samePath(environment.AE_AGENT_ALLOWED_ROOT, dataDirectory));
  assert.equal(environment.AE_SWITCH_API_KEY, gateway.token);
  assert.equal(environment.AE_GATEWAY_TOKEN, gateway.token);
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
    assert.ok(
      samePath(environment[variable], path.join(directory, relative)),
      `${agent.id} ${variable} must match its isolated directory`,
    );
    await assertPhysicalWorkspacePath(environment[variable]);
  }
  const route = `http://127.0.0.1:${gateway.port}/agents/selected:${agent.id}`;
  const base = agent.id === "claude_code" ? route : `${route}/v1`;
  const json = (relative) => JSON.parse(contents.get(relative));
  const parserReadbacks = [];
  const parse = async (relative, format) => {
    const location = path.join(directory, relative);
    const parsed = await parseOwnedConfiguration({
      workspaceRoot: root,
      location,
      format,
      expectedSha256: hashes.find((file) => samePath(file.path, location))
        .sha256,
      pythonDirectory: path.join(nativeRoot, "tools/python"),
      yamlLibraryDirectory: path.join(
        nativeRoot,
        "tools/agents/hermes/site-packages",
      ),
    });
    parserReadbacks.push(parsed.proof);
    return parsed.document;
  };
  const selected = { model, base, token: gateway.token };
  switch (agent.id) {
    case "claude_code": {
      const configuration = json(configurations[agent.id][0]);
      assert.equal(configuration.env.ANTHROPIC_MODEL, model);
      assert.equal(configuration.env.ANTHROPIC_BASE_URL, base);
      assert.equal(configuration.env.ANTHROPIC_API_KEY, gateway.token);
      assert.equal(environment.ANTHROPIC_MODEL, model);
      assert.equal(environment.ANTHROPIC_BASE_URL, base);
      assert.equal(environment.ANTHROPIC_API_KEY, gateway.token);
      for (const role of ["OPUS", "SONNET", "HAIKU"]) {
        const variable = `ANTHROPIC_DEFAULT_${role}_MODEL`;
        assert.equal(configuration.env[variable], model);
        assert.equal(environment[variable], model);
      }
      if (Object.hasOwn(configuration.env, "CLAUDE_CODE_SUBAGENT_MODEL")) {
        assert.equal(
          configuration.env.CLAUDE_CODE_SUBAGENT_MODEL,
          model,
          "Claude subagent model mismatch",
        );
        assert.equal(
          environment.CLAUDE_CODE_SUBAGENT_MODEL,
          model,
          "Claude subagent environment mismatch",
        );
      } else {
        assert.ok(
          !Object.hasOwn(environment, "CLAUDE_CODE_SUBAGENT_MODEL"),
          "Claude inherited subagent pin must not be introduced",
        );
      }
      break;
    }
    case "codex": {
      assertCodexConfiguration(
        await parse(configurations[agent.id][0], "toml"),
        selected,
      );
      break;
    }
    case "hermes": {
      assertHermesConfiguration(
        await parse(configurations[agent.id][0], "yaml"),
        selected,
      );
      break;
    }
    case "oh_my_pi": {
      assertOmpConfiguration(
        await parse(configurations[agent.id][0], "yaml"),
        await parse(configurations[agent.id][1], "yaml"),
        selected,
      );
      break;
    }
    case "opencode": {
      assertOpenCodeConfiguration(json(configurations[agent.id][0]), selected);
      break;
    }
    case "zcode": {
      assertZcodeConfiguration(
        json(configurations[agent.id][0]),
        json(configurations[agent.id][1]),
        selected,
        contents.has(zcodeState) ? json(zcodeState) : undefined,
      );
      break;
    }
    case "workbuddy": {
      assertWorkBuddyConfiguration(json(configurations[agent.id][0]), selected);
      assert.equal(environment.AE_WORKBUDDY_MODEL, model);
      break;
    }
    case "deepseek_harness": {
      assert.ok(
        samePath(environment.DSH_HOME, path.join(directory, "home/.dsh")),
      );
      assert.equal(environment.DSH_TELEMETRY_MODE, "DISABLED");
      const plugins = await parse(configurations[agent.id][0], "yaml");
      assertDshConfiguration(plugins, selected);
      const bundles = json(configurations[agent.id][1]).dsh.profile.bundles;
      assert.ok(
        Array.isArray(bundles) &&
          bundles.every((item) => typeof item === "string"),
      );
      for (const required of [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-headless",
      ]) {
        assert.equal(bundles.filter((item) => item === required).length, 1);
      }
      const powerShellPlugin = uniqueSelectedRow(
        plugins,
        "id",
        "pwsh-sandbox",
        "DSH plugins",
      );
      assert.notEqual(powerShellPlugin.disabled, true);
      const powerShell = powerShellPlugin.config.pwshPath;
      assert.equal(typeof powerShell, "string");
      assert.match(powerShell, /[\\/]/u);
      assert.equal(path.isAbsolute(powerShell), false);
      assert.ok(
        samePath(
          path.resolve(directory, "workspace", powerShell),
          path.join(nativeRoot, "tools/pwsh/pwsh.exe"),
        ),
      );
      assert.ok(
        samePath(
          environment.AE_DSH_PWSH,
          path.join(nativeRoot, "tools/pwsh/pwsh.exe"),
        ),
      );
      assert.ok(
        samePath(
          environment.AE_DSH_RUNTIME,
          path.join(nativeRoot, "tools/node/node.exe"),
        ),
      );
      assert.ok(
        samePath(
          environment.AE_DSH_ENTRY,
          path.join(
            nativeRoot,
            "tools/agents/deepseek_harness/node_modules/@deepseek-ai/dsh/lib/bin.js",
          ),
        ),
      );
      break;
    }
  }
  const selectionFile = path.join(dataDirectory, "agent-selection.json");
  await assertPhysicalWorkspacePath(selectionFile);
  const selections = JSON.parse(await fs.readFile(selectionFile, "utf8"));
  assert.deepEqual(selections[agent.id], { providerId, model });
  const workspace = path.join(directory, "workspace");
  await assertPhysicalWorkspacePath(workspace);
  const leftovers = (await fs.readdir(workspace)).filter((name) =>
    name.startsWith(".ae-tool-verification-"),
  );
  assert.deepEqual(
    leftovers,
    [],
    `${agent.id} must remove every owned verification directory`,
  );
  return {
    directory,
    selectedProviderAndModelMatch: true,
    portableEnvironmentMatches: true,
    verificationDirectoriesRemaining: 0,
    files: hashes,
    parserReadbacks,
  };
}

async function verifyAllHubRevalidations(invoke) {
  const summary = {
    passed: false,
    expectedAgents: [...expectedAgents],
    agents: [],
    failures: [],
  };
  evidence.realRevalidation = summary;
  for (const agentId of expectedAgents) {
    try {
      const receipt = await verifyHubRevalidation({
        page,
        invoke,
        record,
        agentId,
        readCurrentProbe,
      });
      assert.equal(receipt.id, agentId);
      assert.equal(receipt.passed, true);
      summary.agents.push(receipt);
    } catch (error) {
      summary.failures.push({
        id: agentId,
        error: safe(error.stack ?? error.message ?? error),
      });
    }
  }
  try {
    assert.deepEqual(
      summary.failures,
      [],
      "Every tool must independently pass native UI revalidation",
    );
    assert.equal(summary.agents.length, expectedAgents.length);
    assert.deepEqual(
      summary.agents.map((agent) => agent.id).sort(),
      [...expectedAgents].sort(),
      "Independent revalidation must return exactly the eight expected tool IDs",
    );
    assert.ok(summary.agents.every((agent) => agent.passed === true));
    summary.passed = true;
  } finally {
    await record("native-hub-eight-agent-revalidation", summary);
  }
  return summary;
}

async function verifyRealAgentHub(invoke, credentials, initialHub) {
  const real = {
    passed: false,
    discoveredModels: [],
    model: null,
    providerId: null,
    agents: [],
    screenshotsTaken: false,
  };
  evidence.realAgentHub = real;
  const native = async (command, args = {}) => {
    const result = await invoke(command, args);
    assert.ok(result.ok, `${command} failed: ${safeJson(result.error)}`);
    return result.result;
  };
  const navigation = page.getByRole("navigation", {
    name: "选择 Agent",
    exact: true,
  });
  const confirm = () =>
    page.getByRole("button", { name: "确认并验证", exact: true });
  const textIfPresent = async (selector) => {
    const locator = page.locator(selector);
    return (await locator.count()) ? (await locator.textContent())?.trim() : "";
  };
  const waitForDiscovery = (options = {}) =>
    waitForHubDiscovery({
      page,
      record,
      phase: "provider-discovery",
      ...options,
    });
  try {
    const fresh = await native("get_overview");
    assert.deepEqual(
      fresh.providers,
      [],
      "The synthetic management provider must be removed before real UI acceptance",
    );
    await page.locator("#hub-provider").selectOption("");
    assert.equal(
      await page.locator("#hub-api-key").getAttribute("type"),
      "password",
      "Real credentials must remain masked",
    );
    await page.locator("#hub-endpoint").fill(credentials.endpoint);
    realCredentialEntered = true;
    await page.locator("#hub-api-key").fill(credentials.key);
    real.discoveredModels = await waitForDiscovery();
    assert.ok(
      real.discoveredModels.length > 0,
      "This actual supplier must return usable models",
    );
    const requested = process.env.AE_TEST_MODEL?.trim();
    const model = requested || real.discoveredModels[0];
    assert.ok(
      real.discoveredModels.includes(model),
      "The selected model must occur in this run's actual discovered UI options",
    );
    real.model = model;
    await page.locator("#hub-model").selectOption(model);
    await record("native-real-models-discovered", {
      endpoint: credentials.endpoint,
      discoveredModels: real.discoveredModels,
      model,
      actualNativeUi: true,
      fallbackModelUsed: false,
    });
    await page.getByRole("button", { name: "仅保存", exact: true }).click();
    await page
      .getByText("供应商已保存。选择已安装的 Agent，可继续配置端点。", {
        exact: true,
      })
      .waitFor({ timeout: 60000 });
    assert.equal(
      await page.locator("#hub-api-key").inputValue(),
      "",
      "The saved credential must be cleared from the UI input",
    );
    const saved = await native("get_overview");
    assert.equal(saved.providers.length, 1);
    const provider = saved.providers[0];
    assert.equal(provider.model, model);
    assert.equal(provider.hasKey, true);
    assert.ok(
      provider.codexOptions.models.some(
        (item) => item.id === model && item.enabled,
      ),
    );
    assert.ok(
      provider.codexOptions.modelsSyncedAt,
      "The saved provider must contain this run's successful discovery timestamp",
    );
    for (const secret of secrets)
      assert.ok(
        !JSON.stringify(provider).includes(secret),
        "Public provider summaries must not return a complete credential",
      );
    real.providerId = provider.id;
    const gatewayFile = path.join(nativeRoot, "data", "protocol-bridge.json");
    await assertPhysicalWorkspacePath(gatewayFile);
    const gateway = JSON.parse(await fs.readFile(gatewayFile, "utf8"));
    assert.ok(gateway.token && Number.isInteger(gateway.port));
    secrets.add(gateway.token);
    await record("native-real-provider-saved", {
      id: provider.id,
      model,
      hasKey: true,
      inputCleared: true,
      publicSummaryCredentialFree: true,
    });
    if (existingFixture) {
      evidence.installedProfileUi = await verifyInstalledProfileUi({
        page,
        invoke,
        fixture: existingFixture,
        record,
        assertPhysicalWorkspacePath,
      });
    }
    for (const id of expectedAgents) {
      const definition = initialHub.agents.find((item) => item.id === id);
      const outcome = {
        id,
        model,
        providerId: provider.id,
        passed: false,
        probe: null,
        discovery: {},
      };
      real.agents.push(outcome);
      const started = Date.now();
      try {
        await navigation
          .getByRole("button")
          .filter({
            has: page.getByRole("img", {
              name: `${definition.name} 官方图标`,
              exact: true,
            }),
          })
          .click();
        await page
          .getByRole("heading", { name: definition.name, exact: true })
          .waitFor();
        if (existingFixture) {
          const selected = page.locator("#hub-installed-profile");
          await page.waitForFunction(
            () => {
              const field = document.getElementById("hub-installed-profile");
              return field && !field.disabled && !!field.value;
            },
            null,
            { timeout: 30000 },
          );
          assert.deepEqual(
            JSON.parse(await selected.inputValue()),
            (existingFixture.discoveredProfiles ?? existingFixture.profiles)[
              id
            ],
            "The unique original profile must be selected automatically",
          );
          outcome.existingProfileAutomaticallySelected = true;
        }
        await waitForDiscovery({
          agentId: id,
          phase: "initial-tool-verification",
          retryFailure: true,
          receipt: outcome.discovery,
        });
        await page.locator("#hub-model").selectOption(model);
        assert.equal(
          await page.locator(".hub-probe-status.passed").count(),
          0,
          "A selected tool must never inherit the previous tool's passing result",
        );
        assert.equal(
          await readCurrentProbe(),
          null,
          "Each tool must start with no stale probe",
        );
        assert.equal(await page.locator("#hub-model").inputValue(), model);
        await record("native-real-tool-verification-started", {
          id,
          model,
          providerId: provider.id,
        });
        await confirm().click();
        await page.waitForFunction(
          () => {
            const providerSelect = document.getElementById("hub-provider");
            const primary = document.querySelector(
              ".hub-form-actions .primary",
            );
            return (
              providerSelect &&
              !providerSelect.disabled &&
              primary?.textContent.includes("确认并验证") &&
              !!document.querySelector(
                ".hub-verification-result, .hub-notice.error",
              )
            );
          },
          null,
          { timeout: 210000 },
        );
        outcome.probe = await readCurrentProbe();
        outcome.ui = {
          status: (await page.locator(".hub-probe-status").innerText()).trim(),
          stage: await textIfPresent(".hub-verification-stage"),
          message: await textIfPresent(".hub-verification-message"),
          notice: await textIfPresent(".hub-notice"),
          cleanup: await textIfPresent(".hub-verification-cleanup"),
        };
        const current = await native("agent_hub_overview");
        const agent = current.agents.find((item) => item.id === id);
        outcome.agentConfiguration = agent;
        assert.equal(agent.configured, true);
        assert.equal(agent.providerId, provider.id);
        assert.equal(agent.model, model);
        outcome.physicalConfiguration = await verifyAgentFiles(
          agent,
          provider.id,
          model,
          gateway,
        );
        assert.ok(
          outcome.probe,
          "The actual current native probe result must be retrievable without a second probe",
        );
        assert.equal(outcome.probe.ok, true);
        assert.equal(outcome.probe.toolVerified, true);
        assert.equal(outcome.probe.validationScope, "tool");
        assert.equal(outcome.probe.stage, "verified");
        assert.equal(outcome.probe.model, model);
        if (existingFixture) {
          assert.equal(outcome.probe.profileMode, "existing");
          assert.equal(outcome.probe.clientSurface, "headless-cli");
          assert.equal(
            outcome.probe.verificationScope,
            "headless_tool_write_read",
          );
          assert.equal(outcome.probe.desktopGuiVerified, false);
          assert.equal(outcome.probe.desktopDefaultSelectionVerified, false);
          assert.equal(outcome.probe.explicitModelArgument, id === "workbuddy");
          assert.equal(
            outcome.probe.nativeDefaultModelVerified,
            id !== "workbuddy",
          );
          assert.equal(
            await page.locator(".hub-verification-scope").innerText(),
            id === "workbuddy"
              ? "本次通过命令行入口并显式指定模型；桌面界面与默认模型选择尚未验证。"
              : "原配置的默认模型已用于本次命令行验证；桌面界面与已有会话尚未验证。",
          );
          outcome.verifiedEntry = {
            scope: "controlled-existing-profile-command",
            modelFromPersistedNativeConfiguration: id !== "workbuddy",
            explicitModelArgument: id === "workbuddy",
            originalInheritedEnvironmentVerified: false,
            arbitraryOriginalEntryVerified: false,
            desktopGuiVerified: false,
            desktopDefaultSelectionVerified: false,
          };
        }
        for (const flag of [
          "writeObserved",
          "readObserved",
          "readbackMarkerObserved",
          "assistantMarkerObserved",
          "fileMatchesMarker",
          "processSucceeded",
        ])
          assert.equal(
            outcome.probe.evidence?.[flag],
            true,
            `${id} must prove ${flag}`,
          );
        if (id === "deepseek_harness") {
          assert.equal(
            outcome.probe.evidence?.terminalCompletionRequired,
            true,
          );
          assert.equal(outcome.probe.evidence?.terminalCompletedObserved, true);
        }
        assert.equal(outcome.probe.cleanup?.succeeded, true);
        assert.equal(outcome.probe.cleanup?.removed, true);
        assert.equal(
          outcome.probe.cleanup?.scope,
          "owned-uuid-verification-directory",
        );
        assert.match(outcome.ui.status, /工具写读验证通过/u);
        assert.match(outcome.ui.cleanup, /验证临时文件已清理/u);
        assert.equal(await page.locator(".hub-probe-status.passed").count(), 1);
        assert.equal(await page.locator("#hub-api-key").inputValue(), "");
        outcome.passed = true;
      } catch (error) {
        outcome.failure = safe(error.stack ?? error.message ?? error);
        outcome.probe ??= await readCurrentProbe().catch(() => null);
        outcome.ui ??= {
          status: safe(
            await page
              .locator(".hub-probe-status")
              .innerText()
              .catch(() => "UI unavailable"),
          ),
          notice: safe(await textIfPresent(".hub-notice").catch(() => "")),
        };
      }
      outcome.durationMs = Date.now() - started;
      await record("native-real-tool-verification-finished", outcome);
    }
    await page.getByRole("button", { name: "刷新工作台", exact: true }).click();
    const refreshed = await native("agent_hub_overview");
    for (const outcome of real.agents) {
      if (!outcome.passed) continue;
      const agent = refreshed.agents.find((item) => item.id === outcome.id);
      assert.equal(agent.model, model);
      assert.equal(agent.providerId, provider.id);
      assert.equal(agent.configured, true);
    }
    const theme = await page.evaluate(
      () => document.documentElement.dataset.aeTheme,
    );
    await page.reload();
    await page
      .getByRole("heading", { name: /你的 Agent，随时就绪/u })
      .waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.dataset.aeTheme),
      theme,
      "Theme selection must survive native page reload",
    );
    // The provider is explicitly reselected: transient form/probe state is not
    // a persisted success, while the saved credential/configuration is.
    await page.locator("#hub-provider").selectOption(provider.id);
    assert.equal(await page.locator("#hub-api-key").inputValue(), "");
    const reloadedModels = await waitForDiscovery();
    assert.ok(
      reloadedModels.includes(model),
      "A saved provider must discover the real model with its stored credential",
    );
    assert.equal(await page.locator(".hub-probe-status.passed").count(), 0);
    real.persistence = {
      providerSaved: true,
      storedCredentialRediscoveryPassed: true,
      themeRetained: true,
      transientProbeNotReused: true,
    };
    await record("native-real-provider-persistence", real.persistence);
    real.passed =
      real.agents.length === expectedAgents.length &&
      real.agents.every((item) => item.passed);
  } catch (error) {
    real.failure = safe(error.stack ?? error.message ?? error);
  }
  real.passedAgents = real.agents.filter((item) => item.passed).length;
  evidence.realToolFlowPassed = real.passed;
  await record("native-real-hub-acceptance-finished", {
    passed: real.passed,
    passedAgents: real.passedAgents,
    expectedAgents: expectedAgents.length,
    failure: real.failure,
  });
  assert.equal(
    real.passed,
    true,
    "All eight official tools must pass the native UI real write/readback workflow",
  );
}

async function verifyNativeAgentLaunches(invoke) {
  const overview = await invoke("agent_hub_overview");
  assert.ok(overview.ok);
  const launchReceipts = [];
  evidence.agentLaunches = launchReceipts;
  for (const id of expectedAgents) {
    const agent = overview.result.agents.find((item) => item.id === id);
    assert.ok(agent?.configured && agent.launcher);
    const navigation = page.getByRole("navigation", {
      name: "选择 Agent",
      exact: true,
    });
    const selection = navigation.getByRole("button").filter({
      has: page.getByRole("img", {
        name: `${agent.name} 官方图标`,
        exact: true,
      }),
    });
    await selection.scrollIntoViewIfNeeded();
    await selection.click();
    await page
      .getByRole("heading", { name: agent.name, exact: true })
      .waitFor();
    await page.locator("#hub-provider").selectOption(agent.providerId);
    await page.waitForFunction(
      () => !document.getElementById("hub-model")?.disabled,
      null,
      { timeout: 60000 },
    );
    await page.locator("#hub-model").selectOption(agent.model);
    if (existingFixture && id === "deepseek_harness") {
      assert.equal(agent.canLaunch, false);
      assert.match(agent.launchReason, /任务|task/iu);
      assert.equal(
        await page
          .getByRole("button", { name: `启动 ${agent.name}`, exact: true })
          .isEnabled(),
        false,
      );
      const launch = await invoke("launch_agent", { agentId: id });
      assert.equal(launch.ok, false);
      assert.equal(launch.error.code, "task_required");
      const receipt = {
        id,
        launcher: agent.launcher,
        uiLaunchSucceeded: false,
        launchUnsupported: true,
        taskRequired: true,
        processNotStarted: true,
        taskReplayed: false,
        actualTaskVerifiedBy: "preceding-real-tool-receipt",
      };
      launchReceipts.push(receipt);
      await record("native-headless-empty-launch-rejected", receipt);
      continue;
    }
    const launchProofContext = existingFixture
      ? {
          id,
          ownerId: evidence.ownedNativeSandbox.ownerId,
          directory: existingFixture.launchProofDirectory,
          launcher: agent.launcher,
          qaPid: Number(process.env.AE_NATIVE_QA_PID),
          qaStartedAt: process.env.AE_NATIVE_QA_STARTED_AT,
          qaSha256: evidence.qaSha256,
          assertPhysicalPath: assertPhysicalWorkspacePath,
        }
      : null;
    if (launchProofContext) {
      assert.equal(
        samePath(launchProofContext.directory, path.join(path.dirname(existingFixture.discoveryContextFile), "ui-launch-proof")),
        true,
      );
    }
    const launchRequest = launchProofContext
      ? await armNativeLaunchProof(launchProofContext)
      : null;
    if (launchRequest)
      await waitForNativeLaunchAcknowledgment(launchProofContext, launchRequest, "ready");
    const requestedAt = new Date().toISOString();
    await page
      .getByRole("button", { name: `启动 ${agent.name}`, exact: true })
      .click();
    await page
      .getByText(`已请求启动 ${agent.name}。请在打开的终端中查看运行结果。`, {
        exact: true,
      })
      .waitFor({ timeout: 30000 });
    const receipt = {
      id,
      launcher: agent.launcher,
      uiLaunchSucceeded: true,
      requestedAt,
      launchRequestId: launchRequest?.requestId ?? null,
      processProof: launchRequest
        ? await waitForNativeLaunchAcknowledgment(launchProofContext, launchRequest, "proof")
        : null,
      upstreamInferenceProvenBy: evidence.realAgentHub?.agents.find(
        (item) => item.id === id && item.passed,
      )
        ? "preceding-real-tool-receipt"
        : null,
      processVerificationOwner: "scripts/verify-portable-e2e.ps1",
    };
    launchReceipts.push(receipt);
    await record("native-agent-launch-requested", receipt);
  }
}

async function runNativeAcceptance() {
  const credentials = await validateOwnedNativeSandbox();
  if (process.env.AE_NATIVE_EXISTING_PROFILES) {
    const fixtureFile = path.resolve(process.env.AE_NATIVE_EXISTING_PROFILES);
    await assertPhysicalWorkspacePath(fixtureFile);
    existingFixture = JSON.parse(await fs.readFile(fixtureFile, "utf8"));
    assert.deepEqual(
      Object.keys(existingFixture.profiles).sort(),
      [...expectedAgents].sort(),
    );
    assert.ok(
      Array.isArray(existingFixture.preservedFiles) &&
        existingFixture.preservedFiles.length >= expectedAgents.length,
    );
    for (const profile of Object.values(existingFixture.profiles)) {
      for (const name of [
        "directory",
        "homeDirectory",
        "executablePath",
        "workspaceDirectory",
      ])
        await assertPhysicalWorkspacePath(profile[name]);
      const portableRelative = path.relative(nativeRoot, profile.directory);
      assert.ok(
        path.isAbsolute(portableRelative) ||
          portableRelative === ".." ||
          portableRelative.startsWith(`..${path.sep}`),
        "Existing native profiles must be outside the entire AE portable root",
      );
    }
    for (const entry of existingFixture.preservedFiles) {
      await assertPhysicalWorkspacePath(entry.path);
      assert.equal(
        createHash("sha256")
          .update(await fs.readFile(entry.path))
          .digest("hex"),
        entry.sha256,
      );
    }
    evidence.installedClientWorkflow = {
      enabled: true,
      nativeAuthenticationRequired: true,
      bundledClients: false,
    };
  }
  evidence.discoveryDriverHashes = Object.fromEntries(
    await Promise.all(
      [
        "native-ui.mjs",
        "native-hub-extra.mjs",
        "native-config-readback.mjs",
        "native-existing-readback.mjs",
        "native-installed-ui-extra.mjs",
        "native-business-extra.mjs",
        "native-management-extra.mjs",
        "native-configuration-extra.mjs",
        "native-form-extra.mjs",
        "native-options-extra.mjs",
        "native-external-extra.mjs",
        "native-update-extra.mjs",
        "native-sync-extra.mjs",
        "native-gateway-extra.mjs",
        "native-discovery-extra.mjs",
        "native-surface-extra.mjs",
        "native-window-extra.mjs",
        "native-window-owned.ps1",
        "native-tray-owned.ps1",
      ].map(async (name) => [
        name,
        createHash("sha256")
          .update(await fs.readFile(new URL(`./${name}`, import.meta.url)))
          .digest("hex"),
      ]),
    ),
  );
  await record("native-discovery-driver-hashes-bound", {
    driverHashes: evidence.discoveryDriverHashes,
  });
  const discovery = await fetch(`${cdp}/json/list`, {
    signal: AbortSignal.timeout(10000),
  });
  assert.ok(
    discovery.ok,
    "The existing native WebView CDP endpoint must be reachable",
  );
  const targets = await discovery.json();
  assert.ok(
    Array.isArray(targets) && targets.some((target) => target.type === "page"),
    "The native process must expose a WebView page",
  );
  browser = await chromium.connectOverCDP(cdp, { timeout: 10000 });
  for (const candidate of browser
    .contexts()
    .flatMap((context) => context.pages())) {
    await candidate
      .waitForFunction(
        () => typeof window.__TAURI_INTERNALS__?.invoke === "function",
        null,
        { timeout: 30000 },
      )
      .catch(() => {});
    const isNative = await candidate
      .evaluate(() => typeof window.__TAURI_INTERNALS__?.invoke === "function")
      .catch(() => false);
    if (isNative && /AE Switch/u.test(await candidate.title())) {
      page = candidate;
      break;
    }
  }
  assert.ok(
    page,
    "An existing AE Switch page with actual Tauri IPC must be present",
  );
  page.setDefaultTimeout(30000);
  page.on("pageerror", (error) =>
    evidence.pageErrors.push(safe(error.message)),
  );
  await page.getByRole("heading", { name: /你的 Agent，随时就绪/u }).waitFor();
  assert.equal(
    await page.getByText("浏览器预览", { exact: true }).count(),
    0,
    "The page must be running inside Tauri, not browser preview mode",
  );
  await record("native-cdp-connected", {
    url: page.url(),
    title: await page.title(),
    actualTauriRuntime: true,
  });

  async function invoke(command, args = {}) {
    return page.evaluate(
      async ({ command, args }) => {
        const native = window.__TAURI_INTERNALS__;
        if (!native || typeof native.invoke !== "function")
          throw new Error("Native Tauri IPC is unavailable");
        try {
          return { ok: true, result: await native.invoke(command, args) };
        } catch (error) {
          return {
            ok: false,
            error:
              typeof error === "object" && error !== null
                ? JSON.parse(
                    JSON.stringify(error, Object.getOwnPropertyNames(error)),
                  )
                : String(error),
          };
        }
      },
      { command, args },
    );
  }

  if (existingFixture) {
    const discovered = await invoke("agent_hub_discover");
    assert.equal(discovered.ok, true);
    assert.equal(discovered.result.limited, false);
    for (const id of expectedAgents) {
      const profiles = [
        ...new Map(
          discovered.result.clients
            .filter((client) => client.agentId === id)
            .flatMap((client) => client.profiles)
            .map((profile) => [JSON.stringify(profile), profile]),
        ).values(),
      ];
      assert.equal(
        profiles.length,
        1,
        `${id} must be detected without ambiguity`,
      );
      assert.deepEqual(
        profiles[0],
        (existingFixture.discoveredProfiles ?? existingFixture.profiles)[id],
        `${id} must detect the original HOME/configuration/runtime paths`,
      );
    }
    await record("native-installed-client-discovery", {
      agents: expectedAgents,
      allEightOriginalProfilesDetected: true,
      configBodiesReadByDiscovery: false,
    });
  }

  if (gatewayFixtureMode) {
    const gateway = await verifyGatewayRecovery({
      page,
      invoke,
      record,
      addSecret: (secret) => {
        if (typeof secret === "string" && secret) secrets.add(secret);
      },
      nativeRoot,
      assertPhysicalWorkspacePath,
    });
    assert.deepEqual(
      evidence.pageErrors,
      [],
      "Scoped gateway UI must not have runtime errors",
    );
    evidence.gatewayStartupRecovery = gateway;
    evidence.gatewayScopedPassed = gateway.passed === true;
    evidence.verifiedRoot = nativeRoot;
    await record("native-gateway-scoped-acceptance-finished", {
      gatewayScopedPassed: evidence.gatewayScopedPassed,
      fullAcceptancePassed: false,
      eightToolFlowNotAttempted: true,
    });
    return;
  }

  const savedOverview = await invoke("get_overview");
  assert.ok(
    savedOverview.ok,
    "get_overview must return from the actual Rust store",
  );
  let hubOverview = await invoke("agent_hub_overview");
  const healthDeadline = Date.now() + 10000;
  while (
    hubOverview.ok &&
    !hubOverview.result.bridgeHealthy &&
    Date.now() < healthDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    hubOverview = await invoke("agent_hub_overview");
  }
  assert.ok(
    hubOverview.ok,
    "agent_hub_overview must return from the actual Rust store",
  );
  assert.equal(
    hubOverview.result.bridgeHealthy,
    true,
    "The actual local Rust gateway health check must succeed",
  );
  assert.deepEqual(
    hubOverview.result.agents.map((agent) => agent.id).sort(),
    [...expectedAgents].sort(),
    "All eight requested Agent integrations must be present",
  );
  checkWorkspacePath(
    savedOverview.result.dataDirectory,
    "Provider data directory",
  );
  checkWorkspacePath(hubOverview.result.dataDirectory, "Agent data directory");
  assert.equal(
    path.resolve(savedOverview.result.dataDirectory),
    path.resolve(hubOverview.result.dataDirectory),
    "Both native overviews must use the same portable Rust store",
  );
  assert.ok(
    samePath(savedOverview.result.dataDirectory, path.join(nativeRoot, "data")),
    "The attached native process must use the exact owned sandbox's data directory",
  );
  await assertPhysicalWorkspacePath(savedOverview.result.dataDirectory);
  instanceValidated = true;
  evidence.verifiedRoot = path.dirname(savedOverview.result.dataDirectory);
  for (const agent of hubOverview.result.agents) {
    checkWorkspacePath(agent.directory, `${agent.id} configuration directory`);
    if (agent.launcher)
      checkWorkspacePath(agent.launcher, `${agent.id} launcher`);
    assert.ok(
      samePath(
        agent.directory,
        path.join(nativeRoot, "data", "agents", agent.id),
      ),
      "Every initial Agent directory must belong to the attached owned sandbox",
    );
    assert.equal(
      agent.configured,
      false,
      "Native acceptance must start from fresh Agent configuration",
    );
  }
  for (const target of savedOverview.result.targets)
    checkWorkspacePath(
      target.directory,
      `${target.target} legacy target directory`,
    );
  const webviewDirectory = path.join(
    hubOverview.result.dataDirectory,
    "webview",
  );
  await fs.access(webviewDirectory);
  evidence.nativeOverview = {
    dataDirectory: savedOverview.result.dataDirectory,
    providers: savedOverview.result.providers.map(
      ({ id, family, name, baseUrl, model, hasKey }) => ({
        id,
        family,
        name,
        baseUrl,
        model,
        hasKey,
      }),
    ),
    targets: savedOverview.result.targets,
  };
  evidence.agentHubOverview = hubOverview.result;
  await record("native-rust-overviews", {
    agentCount: hubOverview.result.agents.length,
    providerCount: savedOverview.result.providers.length,
    bridgeHealthy: true,
    dataDirectory: hubOverview.result.dataDirectory,
    webviewDirectory,
  });
  await surfaceEmptyBeforeSeed({ page, invoke, record });
  const agentNavigation = page.getByRole("navigation", {
    name: "选择 Agent",
    exact: true,
  });
  async function visibleCenter(locator, label) {
    const result = await locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      const chromeBottom =
        document.querySelector(".window-chrome")?.getBoundingClientRect()
          .bottom ?? 0;
      const hit = document.elementFromPoint(x, y);
      return {
        top: rect.top,
        bottom: rect.bottom,
        x,
        y,
        chromeBottom,
        width: innerWidth,
        height: innerHeight,
        inViewport:
          rect.top >= chromeBottom &&
          rect.bottom <= innerHeight &&
          x >= 0 &&
          x < innerWidth,
        centerHit: !!hit && (hit === element || element.contains(hit)),
      };
    });
    assert.equal(
      result.inViewport,
      true,
      `${label} must remain visible below window chrome`,
    );
    assert.equal(
      result.centerHit,
      true,
      `${label} must receive an ordinary center click`,
    );
    return result;
  }
  async function verifySidebarLayout(mode) {
    const selected = [];
    for (const definition of hubOverview.result.agents) {
      const button = agentNavigation.getByRole("button").filter({
        has: page.getByRole("img", {
          name: `${definition.name} 官方图标`,
          exact: true,
        }),
      });
      await button.scrollIntoViewIfNeeded();
      await visibleCenter(button, `${mode} ${definition.name}`);
      await button.click();
      await page
        .getByRole("heading", { name: definition.name, exact: true })
        .waitFor();
      assert.equal(
        await page.locator(".hub-agent-hero-icon img").getAttribute("alt"),
        `${definition.name} 官方图标`,
      );
      selected.push(definition.id);
      if (mode === "actual-native-default-window")
        await record("native-agent-selected", {
          id: definition.id,
          officialSelectedLogo: true,
          realToolExecuted: false,
        });
    }
    const navigation = await agentNavigation.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
      overflowY: getComputedStyle(element).overflowY,
    }));
    assert.equal(navigation.overflowY, "auto");
    assert.ok(
      navigation.clientHeight > 0,
      "All eight Agent choices need a usable scroll region",
    );
    const advanced = page.getByRole("button", {
      name: "高级供应商管理",
      exact: true,
    });
    const help = page.getByRole("button", { name: "快速上手", exact: true });
    const managementRect = await visibleCenter(
      advanced,
      `${mode} advanced management`,
    );
    const helpRect = await visibleCenter(help, `${mode} quick start`);
    await help.click();
    assert.equal(await help.getAttribute("aria-expanded"), "true");
    await page
      .getByRole("heading", { name: "三步接入你的 Agent", exact: true })
      .waitFor();
    await help.click();
    assert.equal(await help.getAttribute("aria-expanded"), "false");
    await advanced.click();
    await page.getByRole("tab", { name: /^Codex\b/u }).waitFor();
    await page
      .getByRole("button", { name: "返回 Agent Hub", exact: true })
      .click();
    await page
      .getByRole("heading", { name: /你的 Agent，随时就绪/u })
      .waitFor();
    await record("native-sidebar-layout", {
      mode,
      passed: true,
      selectedAgents: selected,
      navigation,
      managementRect,
      helpRect,
      ordinaryClicksOnly: true,
      advancedAndHelpReached: true,
      osWindowResized:
        mode.startsWith("actual-native-") &&
        mode !== "actual-native-default-window",
      realApiKeyEntered: false,
    });
  }
  const originalCssViewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
  const branchFailures = [];
  evidence.branchFailures = branchFailures;
  await verifySidebarLayout("actual-native-default-window");
  try {
    await verifyOwnedWindow({ page, invoke, record, verifySidebarLayout });
  } catch (error) {
    const failure = {
      branch: "owned-native-window",
      error: safe(error.stack ?? error.message ?? error),
    };
    branchFailures.push(failure);
    await record("native-independent-branch-failed", failure);
    // Continue only after the driver has restored the actual owned window.
    // The failed window assertions remain mandatory in the final verdict.
    const originalWindow = evidence.steps.find(
      (step) => step.step === "native-owned-window-original-state",
    )?.nativeState;
    const restoration = evidence.steps.findLast(
      (step) => step.step === "native-owned-window-bounds-restored",
    );
    assert.ok(originalWindow && restoration);
    for (const field of ["pid", "left", "top", "width", "height"])
      assert.equal(restoration.nativeState[field], originalWindow[field]);
    assert.equal(restoration.nativeState.visible, true);
    assert.equal(restoration.nativeState.minimized, false);
    assert.equal(restoration.nativeState.maximized, false);
    assert.deepEqual(restoration.viewport, originalCssViewport);
    assert.deepEqual(
      await page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
      originalCssViewport,
    );
  }
  let emulated = false;
  try {
    try {
      await page.setViewportSize({ width: 760, height: 600 });
      const measured = await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
      }));
      if (measured.width !== 760 || measured.height !== 600)
        throw new Error(
          "Native CDP did not apply the requested emulated CSS viewport",
        );
      emulated = true;
    } catch (error) {
      await record("native-sidebar-layout", {
        mode: "cdp-emulated-css-760x600",
        measured: false,
        passed: false,
        unsupported: true,
        reason: safe(error.message ?? error),
        osWindowResized: false,
      });
    }
    if (emulated) await verifySidebarLayout("cdp-emulated-css-760x600");
  } finally {
    const currentCssViewport = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }));
    if (
      currentCssViewport.width !== originalCssViewport.width ||
      currentCssViewport.height !== originalCssViewport.height
    )
      await page.setViewportSize(originalCssViewport);
    const restored = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }));
    assert.deepEqual(
      restored,
      originalCssViewport,
      "The original native CSS viewport must be restored before further acceptance",
    );
    await record("native-sidebar-viewport-restored", {
      cssViewport: restored,
      osWindowResized: false,
    });
  }

  // Select a blank configuration before screenshots, so a stored credential is
  // never selected or entered, including its suffix in the input placeholder.
  await page.locator("#hub-provider").selectOption("");
  await page.locator("#hub-api-key").fill("");
  const displayedVersion = (
    await page.locator(".hub-sidebar-meta small").innerText()
  ).trim();
  assert.equal(
    displayedVersion,
    `v${expectedAppVersion}`,
    "The Agent Hub footer must display the exact app/package.json version",
  );
  await record("native-app-version", {
    packageVersion: expectedAppVersion,
    displayedVersion,
  });

  async function readHubTheme() {
    return page.evaluate(() => {
      const hub = document.querySelector(".agent-hub");
      const sidebar = document.querySelector(".hub-sidebar");
      const panel = document.querySelector(".hub-panel");
      if (!hub || !sidebar || !panel)
        throw new Error("The actual Agent Hub theme surfaces must exist");
      const documentStyle = getComputedStyle(document.documentElement);
      const hubStyle = getComputedStyle(hub);
      return {
        theme: document.documentElement.dataset.aeTheme,
        containerThemes: [...hub.classList].filter((name) =>
          name.startsWith("theme-"),
        ),
        colorScheme: documentStyle.colorScheme,
        colors: {
          documentBackground: documentStyle.backgroundColor,
          hubBackground: hubStyle.backgroundColor,
          hubText: hubStyle.color,
          sidebarBackground: getComputedStyle(sidebar).backgroundColor,
          panelBackground: getComputedStyle(panel).backgroundColor,
        },
      };
    });
  }
  function assertHubTheme(state, theme) {
    assert.ok(["dark", "light"].includes(theme));
    assert.equal(state.theme, theme, "The document dataset must use the theme");
    assert.deepEqual(state.containerThemes, [`theme-${theme}`]);
    assert.equal(state.colorScheme, theme);
  }
  async function changeHubTheme(theme) {
    const before = await readHubTheme();
    assertHubTheme(before, before.theme);
    assert.notEqual(before.theme, theme, "The theme button must change theme");
    await page
      .getByRole("button", {
        name: theme === "dark" ? "切换深色主题" : "切换浅色主题",
        exact: true,
      })
      .click();
    await page.waitForFunction(
      (nextTheme) => document.documentElement.dataset.aeTheme === nextTheme,
      theme,
    );
    await page.waitForTimeout(250);
    const after = await readHubTheme();
    assertHubTheme(after, theme);
    for (const property of Object.keys(before.colors))
      assert.notEqual(
        after.colors[property],
        before.colors[property],
        `${property} must actually change after the theme button click`,
      );
    await record("native-theme-transition", { before, after });
  }
  const initialTheme = await readHubTheme();
  assertHubTheme(initialTheme, initialTheme.theme);
  if (initialTheme.theme === "dark") await changeHubTheme("light");
  await changeHubTheme("dark");

  // Pinned official artwork: docs/agent-brand-assets.md,
  // app/src/assets/brands/README.md and artifacts/brand-assets/sources.json.
  const officialLogoPaths = {
    claude_code: {
      dark: "agents/claude-code.png",
      light: "agents/claude-code.png",
    },
    codex: { dark: "agents/codex.png", light: "brands/codex.png" },
    hermes: { dark: "agents/hermes.svg", light: "agents/hermes.svg" },
    oh_my_pi: { dark: "agents/oh-my-pi.svg", light: "agents/oh-my-pi.svg" },
    opencode: {
      dark: "agents/opencode-dark.svg",
      light: "agents/opencode-light.svg",
    },
    zcode: { dark: "agents/zcode.png", light: "agents/zcode.png" },
    workbuddy: { dark: "agents/workbuddy.svg", light: "agents/workbuddy.svg" },
    deepseek_harness: {
      dark: "agents/deepseek-harness.svg",
      light: "agents/deepseek-harness.svg",
    },
  };
  const pinnedLogoHashes = {
    "agents/claude-code.png":
      "7241633e5a39b44a947c7b9a821637f30d6e86716e7a8c847136d91f9c3f6ba1",
    "agents/codex.png":
      "2ce1c57dd3b312417106a487815ab1235bddce17e1fa9b32a2f048bd71ee25d3",
    "brands/codex.png":
      "b45359d98553406d60c45e699cbe80de6fe733d51661a317ca37b41632b58823",
    "agents/hermes.svg":
      "6c4968c1a46f104559684826ed8061fad6052711ff0af9c6b36a6ce674536684",
    "agents/oh-my-pi.svg":
      "727019727006f26fe3d1f187d3fe9830f26213733a51721096a2044ab059cf61",
    "agents/opencode-dark.svg":
      "d6a0e3b8a295f413543f41cb73957e670351b5cb088c8d9dbd186b9e9d633cca",
    "agents/opencode-light.svg":
      "b1c48d82ebd304eab820658387642bcf4c9b8350d6860894d0fe21ddca25ef3f",
    "agents/zcode.png":
      "ad0e1d32febb23d42942ab6faa32254d5647ddce38b18c276523bc7baab0e7aa",
    "agents/workbuddy.svg":
      "10ccbc099e7bc3d5ff12c315c4edd7b21386aa7166c1ec19997b3d55010d5c7d",
    "agents/deepseek-harness.svg":
      "d19b62d73c8db53d5a241dfb4adbc7cad259557e5da8da6587a86d7dd4b06382",
  };
  const inlineSvgPaths = new Set([
    "agents/oh-my-pi.svg",
    "agents/opencode-dark.svg",
    "agents/opencode-light.svg",
    "agents/deepseek-harness.svg",
  ]);
  const officialLogoSources = {};
  for (const [asset, sourceSha256] of Object.entries(pinnedLogoHashes)) {
    const sourcePath = path.join(root, "app", "src", "assets", asset);
    await assertPhysicalWorkspacePath(sourcePath);
    const source = await fs.readFile(sourcePath);
    assert.equal(
      createHash("sha256").update(source).digest("hex"),
      sourceSha256,
      `${asset} must match the recorded unchanged official artwork`,
    );
    // Vite's percent-encoded small SVGs change only this exact serialization.
    // HTTP assets and base64 data URLs must still match the original bytes.
    const inlineSha256 = inlineSvgPaths.has(asset)
      ? createHash("sha256")
          .update(
            source
              .toString("utf8")
              .trim()
              .replaceAll(/>\s+</gu, "><")
              .replaceAll('"', "'")
              .replaceAll(/\s+/gu, " "),
          )
          .digest("hex")
      : null;
    officialLogoSources[asset] = {
      sourceSha256,
      sourceBytes: source.length,
      inlineSha256,
    };
  }
  await record("native-official-logo-sources", { assets: officialLogoSources });
  const logoDefinitions = hubOverview.result.agents.map(({ id, name }) => ({
    id,
    name,
  }));
  const logoResourceSession = await page.context().newCDPSession(page);
  await logoResourceSession.send("Page.enable");
  function decodeOfficialLogoDataUrl(sourceUrl) {
    const comma = sourceUrl.indexOf(",");
    assert.ok(comma > 0, "The displayed data URL must contain its image bytes");
    const media = sourceUrl.slice(0, comma);
    const content = decodeURIComponent(sourceUrl.slice(comma + 1));
    if (media === "data:image/svg+xml")
      return {
        bytes: Buffer.from(content, "utf8"),
        extractionSource: "displayed-data-url-percent-encoded-svg",
      };
    assert.ok(
      ["data:image/png;base64", "data:image/svg+xml;base64"].includes(media),
      "Official data URLs must use the original PNG or SVG bytes",
    );
    return {
      bytes: Buffer.from(content, "base64"),
      extractionSource: "displayed-data-url-base64",
    };
  }
  async function readOfficialLogos(selector) {
    const displayed = await page.evaluate(
      async ({ selector, definitions }) => {
        const images = [...document.querySelectorAll(selector)];
        const logos = await Promise.all(
          images.map(async (image) => {
            await image.decode();
            const definition = definitions.find(
              (agent) => image.alt === `${agent.name} 官方图标`,
            );
            const navigationButton = image.closest("button.hub-agent-item");
            const hero = image.closest(".hub-agent-hero-icon");
            const source = new URL(image.currentSrc);
            if (
              !["http:", "data:"].includes(source.protocol) ||
              (source.protocol === "http:" && source.origin !== location.origin)
            )
              throw new Error(
                "Official logo bytes must come from this application",
              );
            const style = getComputedStyle(image);
            return {
              sourceUrl: image.currentSrc,
              name: image.alt,
              agentId: definition?.id ?? null,
              slot: navigationButton
                ? "sidebar"
                : hero
                  ? "selected"
                  : "unknown",
              brandMatches:
                !!definition &&
                image.parentElement.classList.contains(
                  `brand-${definition.id}`,
                ),
              navigationName:
                navigationButton
                  ?.querySelector(".hub-agent-copy strong")
                  ?.textContent.trim() ?? null,
              current:
                navigationButton?.getAttribute("aria-current") === "page",
              decoded:
                image.complete &&
                image.naturalWidth > 0 &&
                image.naturalHeight > 0,
              naturalWidth: image.naturalWidth,
              naturalHeight: image.naturalHeight,
              filter: style.filter,
              objectFit: style.objectFit,
              sourceScheme: source.protocol,
              sourcePath: source.protocol === "http:" ? source.pathname : null,
              percentEncodedSvg: image.currentSrc.startsWith(
                "data:image/svg+xml,",
              ),
            };
          }),
        );
        return { documentUrl: location.href, logos };
      },
      { selector, definitions: logoDefinitions },
    );
    // The product CSP permits images but connects only to IPC. Read the exact
    // already-loaded main-frame resource; never fetch it or change that policy.
    const { frameTree } = await logoResourceSession.send(
      "Page.getResourceTree",
    );
    assert.equal(
      frameTree.frame.url,
      displayed.documentUrl,
      "The resource cache must belong to the displayed native document",
    );
    const logos = [];
    for (const displayedLogo of displayed.logos) {
      const { sourceUrl, ...logo } = displayedLogo;
      assert.ok(
        logo.decoded,
        "The exact displayed image must already be decoded",
      );
      let bytes;
      let extractionSource;
      let resourceMimeType;
      if (logo.sourceScheme === "data:") {
        ({ bytes, extractionSource } = decodeOfficialLogoDataUrl(sourceUrl));
      } else {
        const resource = frameTree.resources.find(
          (entry) => entry.url === sourceUrl && entry.type === "Image",
        );
        assert.ok(
          resource,
          "The exact currentSrc must be a loaded frame image",
        );
        assert.notEqual(resource.failed, true);
        assert.notEqual(resource.canceled, true);
        resourceMimeType = resource.mimeType;
        assert.ok(["image/png", "image/svg+xml"].includes(resourceMimeType));
        const content = await logoResourceSession.send(
          "Page.getResourceContent",
          {
            frameId: frameTree.frame.id,
            url: sourceUrl,
          },
        );
        if (resourceMimeType === "image/png")
          assert.equal(content.base64Encoded, true);
        bytes = Buffer.from(
          content.content,
          content.base64Encoded ? "base64" : "utf8",
        );
        extractionSource = content.base64Encoded
          ? "cdp-loaded-frame-resource-base64"
          : "cdp-loaded-frame-resource-text";
      }
      logos.push({
        ...logo,
        resourceFrameId: frameTree.frame.id,
        resourceMimeType,
        extractionSource,
        sourceUrlSha256: createHash("sha256").update(sourceUrl).digest("hex"),
        renderedBytes: bytes.length,
        renderedSha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    assert.equal(
      await page.evaluate(
        ({ selector, documentUrl, sources }) => {
          const images = [...document.querySelectorAll(selector)];
          return (
            location.href === documentUrl &&
            images.length === sources.length &&
            images.every(
              (image, index) =>
                image.currentSrc === sources[index] &&
                image.complete &&
                image.naturalWidth > 0 &&
                image.naturalHeight > 0,
            )
          );
        },
        {
          selector,
          documentUrl: displayed.documentUrl,
          sources: displayed.logos.map((logo) => logo.sourceUrl),
        },
      ),
      true,
      "The byte evidence must remain bound to the exact displayed image sources",
    );
    return logos;
  }
  function assertOfficialLogo(logo, theme) {
    assert.ok(logo.decoded, `${logo.name} must decode in the native WebView`);
    assert.equal(
      logo.filter,
      "none",
      "Official logo colors must not be changed with a filter",
    );
    assert.equal(
      logo.objectFit,
      "contain",
      "Official logo artwork must retain its proportions",
    );
    assert.ok(
      ["http:", "data:"].includes(logo.sourceScheme),
      "Official assets must load from this application",
    );
    assert.ok(expectedAgents.includes(logo.agentId));
    assert.equal(logo.brandMatches, true);
    const expectedAsset = officialLogoPaths[logo.agentId][theme];
    const source = officialLogoSources[expectedAsset];
    const expectedHash = logo.percentEncodedSvg
      ? source.inlineSha256
      : source.sourceSha256;
    assert.ok(
      expectedHash,
      `${expectedAsset} must support this exact encoding`,
    );
    assert.equal(
      logo.renderedSha256,
      expectedHash,
      `${theme} ${logo.agentId} must render the mapped official asset bytes`,
    );
    if (logo.slot === "sidebar")
      assert.equal(
        logo.navigationName,
        logoDefinitions.find((definition) => definition.id === logo.agentId)
          .name,
      );
    return { ...logo, expectedAsset, sourceSha256: source.sourceSha256 };
  }
  async function checkOfficialLogos(theme) {
    assertHubTheme(await readHubTheme(), theme);
    const logos = (await readOfficialLogos("img.hub-agent-logo")).map((logo) =>
      assertOfficialLogo(logo, theme),
    );
    assert.equal(
      logos.length,
      expectedAgents.length + 1,
      "Official sidebar logos and the selected Agent logo must render",
    );
    assert.equal(
      new Set(logos.map((logo) => logo.name)).size,
      expectedAgents.length,
    );
    const sidebarLogos = logos.filter((logo) => logo.slot === "sidebar");
    assert.deepEqual(
      sidebarLogos.map((logo) => logo.agentId),
      expectedAgents,
    );
    const current = sidebarLogos.filter((logo) => logo.current);
    const hero = logos.filter((logo) => logo.slot === "selected");
    assert.equal(current.length, 1);
    assert.equal(hero.length, 1);
    assert.equal(hero[0].agentId, current[0].agentId);
    const selectedLogos = [];
    for (const definition of logoDefinitions) {
      const button = agentNavigation.getByRole("button").filter({
        has: page.getByRole("img", {
          name: `${definition.name} 官方图标`,
          exact: true,
        }),
      });
      await button.click();
      await page
        .getByRole("heading", { name: definition.name, exact: true })
        .waitFor();
      assert.equal(await button.getAttribute("aria-current"), "page");
      const selected = await readOfficialLogos(
        ".hub-agent-hero-icon img.hub-agent-logo",
      );
      assert.equal(selected.length, 1);
      assert.equal(selected[0].agentId, definition.id);
      selectedLogos.push(assertOfficialLogo(selected[0], theme));
    }
    assert.deepEqual(
      selectedLogos.map((logo) => logo.agentId),
      expectedAgents,
    );
    await record("native-official-logos", { theme, logos, selectedLogos });
  }
  async function assertBlankScreenshotConfiguration() {
    assert.equal(await page.locator("#hub-provider").inputValue(), "");
    assert.ok(
      (await page.locator("#hub-api-key").inputValue()) === "",
      "Theme screenshots must retain the blank API key input",
    );
  }
  await checkOfficialLogos("dark");
  await assertBlankScreenshotConfiguration();
  const darkScreenshot = path.join(output, "native-agent-hub-dark.png");
  await page.screenshot({ path: darkScreenshot, fullPage: true });
  evidence.screenshots.push(darkScreenshot);
  await changeHubTheme("light");
  await checkOfficialLogos("light");
  await logoResourceSession.detach();
  await assertBlankScreenshotConfiguration();
  const lightScreenshot = path.join(output, "native-agent-hub-light.png");
  await page.screenshot({ path: lightScreenshot, fullPage: true });
  evidence.screenshots.push(lightScreenshot);
  await record("native-theme-screenshots", {
    themes: ["dark", "light"],
    realApiKeyEntered: false,
    viewport: await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
    })),
  });

  const directFailure = await invoke("discover_provider_connection", {
    input: { providerId: null, baseUrl: testEndpoint, apiKey: testKey },
    protocol: null,
    authMode: null,
  });
  assert.equal(
    directFailure.ok,
    false,
    "A closed-port endpoint must fail in actual Rust connection discovery",
  );
  evidence.invalidEndpointNativeError = directFailure.error;
  await record("native-invalid-endpoint-rejected", {
    error: directFailure.error,
    endpoint: testEndpoint,
    credentialKind: "synthetic invalid test key",
  });

  await page.locator("#hub-endpoint").fill(testEndpoint);
  await page.locator("#hub-api-key").fill(testKey);
  const failure = page.locator(".hub-model-status.failure");
  await failure.waitFor({ state: "visible", timeout: 45000 });
  const failureText = (await failure.innerText()).trim();
  assert.ok(
    failureText.length > 0,
    "The native Rust discovery error must be visible in the UI",
  );
  assert.equal(
    await page.getByText("工具写读验证通过", { exact: true }).count(),
    0,
    "A failed endpoint must never show a passing real-tool status",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "确认并验证", exact: true })
      .isEnabled(),
    false,
    "Failed discovery cannot enable automatic configuration and verification",
  );
  assert.equal(
    await page
      .getByRole("combobox", { name: "默认模型", exact: true })
      .inputValue(),
    "",
    "The failed endpoint must not produce a fabricated model selection",
  );
  const failureScreenshot = path.join(output, "native-invalid-endpoint.png");
  await page.screenshot({ path: failureScreenshot, fullPage: true });
  evidence.screenshots.push(failureScreenshot);
  evidence.invalidEndpointUiError = failureText;
  await record("native-invalid-endpoint-ui", {
    message: failureText,
    fabricatedModels: false,
    falseSuccess: false,
    realApiKeyEntered: false,
  });

  const after = await invoke("get_overview");
  assert.ok(
    after.ok,
    "The Rust store must remain readable after discovery fails",
  );
  assert.deepEqual(
    after.result.providers.map((provider) => provider.id),
    savedOverview.result.providers.map((provider) => provider.id),
    "Failed connection discovery must not create or remove saved providers",
  );
  await page.locator("#hub-api-key").fill("");
  await page.locator("#hub-endpoint").fill("");
  for (const [branch, run] of [
    ["discovery-edges", () => verifyDiscoveryEdges({ page, invoke, record })],
    ["hub-extras", () => verifyHubExtras({ page, invoke, record })],
  ]) {
    try {
      await run();
    } catch (error) {
      const failure = {
        branch,
        error: safe(error.stack ?? error.message ?? error),
      };
      branchFailures.push(failure);
      await record("native-independent-branch-failed", failure);
    }
  }
  try {
    await verifyConfigurationExtras({
      page,
      invoke,
      record,
      addSecret: (secret) => secrets.add(secret),
      nativeRoot,
      assertPhysicalWorkspacePath,
    });
  } catch (error) {
    const failure = {
      branch: "configuration-boundaries",
      error: safe(error.stack ?? error.message ?? error),
    };
    branchFailures.push(failure);
    await record("native-independent-branch-failed", failure);
  }
  try {
    await verifyAdvancedManagement(invoke, savedOverview.result);
  } catch (error) {
    const failure = {
      branch: "advanced-management",
      error: safe(error.stack ?? error.message ?? error),
    };
    branchFailures.push(failure);
    await record("native-independent-branch-failed", failure);
    // Recover only the synthetic profiles created by this run. A failed
    // recovery stops subsequent credential entry; it never clears this gate.
    const native = async (command, args = {}) => {
      const value = await invoke(command, args);
      assert.ok(value.ok, `Management recovery failed: ${command}`);
      return value.result;
    };
    assert.deepEqual(savedOverview.result.providers, []);
    const fixture = evidence.managementFixtureDirectory;
    assert.ok(fixture, "Recovery requires this run's synthetic fixture");
    assert.ok(managementRecovery);
    assert.ok(samePath(fixture, managementRecovery.directory));
    await assertPhysicalWorkspacePath(fixture);
    const physicalFixture = await fs.realpath(fixture);
    assert.ok(isWithinRoot(physicalFixture));
    assert.ok(samePath(path.dirname(physicalFixture),
      path.join(savedOverview.result.dataDirectory, "native-ui-fixtures")));
    const markerBytes = await fs.readFile(path.join(fixture, ".ae-native-ui-owner.json"));
    assert.equal(createHash("sha256").update(markerBytes).digest("hex"),
      managementRecovery.markerSha256);
    const marker = JSON.parse(markerBytes.toString("utf8"));
    assert.equal(marker.purpose, "synthetic native UI acceptance");
    assert.equal(marker.nativeOwnerId, evidence.ownedNativeSandbox.ownerId);
    const overview = await native("get_overview");
    assert.deepEqual(overview.targets.map((value) => value.target).sort(),
      savedOverview.result.targets.map((value) => value.target).sort());
    for (const provider of overview.providers) {
      assert.equal(provider.id, managementRecovery.providerId);
      assert.ok(["Synthetic native QA", "Synthetic native QA edited"].includes(provider.name));
      assert.equal(provider.baseUrl, managementRecovery.endpoint);
      const endpoint = new URL(provider.baseUrl);
      assert.equal(endpoint.hostname, "127.0.0.1");
      assert.equal(endpoint.protocol, "http:");
    }
    for (const target of overview.targets) {
      const original = savedOverview.result.targets.find(
        (value) => value.target === target.target);
      assert.ok(original);
      assert.ok(samePath(target.directory, original.directory) ||
        samePath(target.directory, path.join(fixture, target.target)));
      if (target.canRestore)
        assert.ok(samePath(target.directory, path.join(fixture, target.target)));
    }
    for (const target of overview.targets) {
      const original = savedOverview.result.targets.find(
        (value) => value.target === target.target);
      assert.ok(original);
      assert.ok(samePath(target.directory, original.directory) ||
        samePath(target.directory, path.join(fixture, target.target)));
      if (target.canRestore) {
        assert.ok(samePath(target.directory, path.join(fixture, target.target)));
        await native("restore_original", { target: target.target });
      }
      await native("set_directory", {
        target: target.target, directory: original.directory,
      });
    }
    for (const provider of overview.providers) {
      await native("delete_provider", { providerId: provider.id });
    }
    assert.deepEqual((await native("get_overview")).providers, []);
    for (let attempt = 0; attempt < 5; attempt++) {
      const dialogs = page.getByRole("dialog");
      if (!(await dialogs.count())) break;
      const close = dialogs.last().getByRole("button", {
        name: "关闭弹窗", exact: true,
      });
      if (await close.count()) await close.click();
      else await page.keyboard.press("Escape");
    }
    assert.equal(await page.getByRole("dialog").count(), 0);
    await page.getByRole("button", { name: "返回 Agent Hub", exact: true }).click();
    await page.getByRole("heading", { name: /你的 Agent，随时就绪/u }).waitFor();
    await record("native-management-failure-recovered", {
      syntheticProfilesOnly: true, originalTargetDirectoriesRestored: true,
      passingGateRetained: false,
    });
  }
  assert.deepEqual(
    evidence.pageErrors,
    [],
    "Synthetic native UI integration must have no runtime errors",
  );
  evidence.nativeIntegrationPassed = branchFailures.length === 0;
  // Collect independent UI branches even when an upstream tool fails. All
  // original branch assertions remain mandatory for the final acceptance.
  for (const [branch, run] of [
    [
      "real-agent-hub",
      () => verifyRealAgentHub(invoke, credentials, hubOverview.result),
    ],
    ["real-revalidation", () => verifyAllHubRevalidations(invoke)],
    [
      "advanced-form-branches",
      async () => {
        await page
          .getByRole("button", { name: "高级供应商管理", exact: true })
          .click();
        await page.getByRole("tab", { name: /^Codex\b/u }).click();
        try {
          await verifyFormExtras({ page, invoke, record });
        } finally {
          const back = page.getByRole("button", {
            name: "返回 Agent Hub",
            exact: true,
          });
          if (await back.count()) await back.click();
        }
        await page
          .getByRole("heading", { name: /你的 Agent，随时就绪/u })
          .waitFor();
      },
    ],
    ["additional-ui-surfaces", () => surfaceHubAtEnd({ page, invoke, record })],
    [
      "isolated-external-routes",
      () => verifyExternalRoutes({ page, invoke, record, existingFixture }),
    ],
    ["agent-launch-buttons", () => verifyNativeAgentLaunches(invoke)],
  ]) {
    try {
      await run();
    } catch (error) {
      const failure = {
        branch,
        error: safe(error.stack ?? error.message ?? error),
      };
      branchFailures.push(failure);
      await record("native-independent-branch-failed", failure);
    }
  }
  evidence.branchFailures = branchFailures;
  assert.deepEqual(
    evidence.pageErrors,
    [],
    "Native UI must not have JavaScript runtime errors",
  );
  assert.deepEqual(
    branchFailures,
    [],
    "All independent native UI branches must pass",
  );
  evidence.passed =
    evidence.nativeIntegrationPassed && evidence.realToolFlowPassed;
  await record("native-ui-acceptance-passed", {
    onlyOwnedSandboxProviderStoreModified: true,
    syntheticManagementPassed: true,
    realAgentHubPassed: evidence.realAgentHub.passed,
    realToolsVerified: evidence.realAgentHub.passedAgents,
    pageErrorCount: 0,
  });
}
try {
  await runNativeAcceptance();
} catch (error) {
  evidence.failure = safe(error.stack ?? error.message ?? error);
  if (instanceValidated && page) {
    evidence.uiFailureSnapshot = await page
      .evaluate(() => ({
        title: document.title,
        body: document.body.innerText.slice(0, 6000),
        tabs: [...document.querySelectorAll('[role="tab"]')].map(
          (tab) => tab.textContent,
        ),
      }))
      .catch(() => null);
    if (!realCredentialEntered) {
      const screenshot = path.join(
        output,
        gatewayFixtureMode
          ? "native-gateway-failure.png"
          : "native-ui-failure.png",
      );
      await page
        .screenshot({ path: screenshot })
        .then(() => evidence.screenshots.push(screenshot))
        .catch(() => {});
    }
  }
  await writeEvidence();
  console.error(safe(error.message ?? error));
  process.exitCode = 1;
} finally {
  if (fixtureServer) {
    fixtureServer.closeAllConnections();
    await new Promise((resolve) => fixtureServer.close(resolve));
  }
  if (instanceValidated && page && (await page.locator("#hub-api-key").count()))
    await page
      .locator("#hub-api-key")
      .fill("")
      .catch(() => {});
  // connectOverCDP closes this debugging connection; it does not own or stop
  // the externally launched desktop application.
  if (browser) await browser.close();
  await writeEvidence();
}
