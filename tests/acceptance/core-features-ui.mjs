/**
 * Production-dist browser regression with synthetic Tauri IPC.
 * This does not execute Rust IPC, official clients, or upstream inference.
 * Run from the workspace after building app/dist:
 *   node tests/acceptance/core-features-ui.mjs
 * Optional: --output <workspace G: directory>, --browser <Edge/Chromium exe>.
 */
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const workspace = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
assert.match(
  workspace,
  /^G:[\\/]/i,
  "This machine's acceptance output must stay on G:",
);
const options = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, item, index, args) => {
    if (item.startsWith("--")) pairs.push([item.slice(2), args[index + 1]]);
    return pairs;
  }, []),
);
const output = path.resolve(
  options.output ||
    path.join(workspace, "artifacts/acceptance/core-features-ui"),
);
assert(
  output.startsWith(workspace + path.sep),
  "Acceptance output must be inside this G: workspace",
);
const runId = randomUUID().replaceAll("-", "");
const ownedTemporary = path.join(workspace, ".cache/core-features-ui", runId);
await fs.mkdir(ownedTemporary, { recursive: true });
await fs.mkdir(output, { recursive: true });

// Invoke the actual workspace environment script, selecting only known storage
// variables. Do not serialize the inherited environment or its private values.
const selectedEnvironment = [
  "AE_WORKSPACE",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "PLAYWRIGHT_BROWSERS_PATH",
  "NODE_COMPILE_CACHE",
  "RTK_DB_PATH",
  "RTK_TEE_DIR",
  "PSModuleAnalysisCachePath",
];
const bootstrapEnv = { ...process.env };
for (const name of [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "TMPDIR",
])
  bootstrapEnv[name] = ownedTemporary;
const environmentScript = path
  .join(workspace, "scripts/workspace-env.ps1")
  .replaceAll("'", "''");
// ASCII Base64 transports the UTF-8 JSON independently of Windows PowerShell's
// redirected-stdout code page, including workspaces with Chinese path segments.
const environmentCommand = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; . '${environmentScript}'; $result = @{}; foreach ($name in @(${selectedEnvironment.map((name) => `'${name}'`).join(",")})) { $result[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }; $json = $result | ConvertTo-Json -Compress; [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))`;
const initialized = spawnSync(
  "powershell.exe",
  ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", environmentCommand],
  { cwd: workspace, env: bootstrapEnv, encoding: "utf8", windowsHide: true },
);
assert.equal(
  initialized.status,
  0,
  "workspace-env.ps1 must initialize successfully",
);
const encodedEnvironment = initialized.stdout.trim();
assert.match(
  encodedEnvironment,
  /^[A-Za-z0-9+/]+={0,2}$/,
  "Environment transport must be ASCII Base64",
);
const storageEnvironment = JSON.parse(
  Buffer.from(encodedEnvironment, "base64").toString("utf8"),
);
for (const [name, value] of Object.entries(storageEnvironment)) {
  assert.match(value, /^G:[\\/]/i, `${name} must be redirected to G:`);
  process.env[name] = value;
}
const require = createRequire(path.join(workspace, "app/package.json"));
const { chromium } = require("playwright");
const AxeBuilder = require("@axe-core/playwright").default;
const dist = path.join(workspace, "app/dist");
const html = await fs.readFile(path.join(dist, "index.html"), "utf8");
const sourceBindings = [];
for (const relative of [
  "index.html",
  ...[...html.matchAll(/(?:src|href)="((?:\.\/|\/)assets\/[^"?]+)"/g)].map(
    (match) => match[1].replace(/^\.\//, "").replace(/^\//, ""),
  ),
]) {
  const bytes = await fs.readFile(path.join(dist, relative));
  sourceBindings.push({
    file: relative.replaceAll("\\", "/"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  });
}
const server = http.createServer(async (request, response) => {
  try {
    let relative = decodeURIComponent(
      new URL(request.url, "http://localhost").pathname,
    );
    if (relative === "/") relative = "/index.html";
    const file = path.resolve(dist, "." + relative);
    if (!file.startsWith(dist + path.sep)) throw new Error("outside-dist");
    const body = await fs.readFile(file);
    const type =
      {
        ".html": "text/html; charset=utf-8",
        ".js": "application/javascript",
        ".css": "text/css",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".json": "application/json",
      }[path.extname(file)] || "application/octet-stream";
    response.writeHead(200, {
      "content-type": type,
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const report = {
  runId,
  scope: "production app/dist browser UI with synthetic Tauri IPC only",
  syntheticIpc: true,
  nativeIpcExecuted: false,
  officialClientsExecuted: false,
  upstreamInferenceExecuted: false,
  realClientAcceptancePassed: false,
  startedAt: new Date().toISOString(),
  dist: sourceBindings,
  checks: [],
  views: [],
  defaultViews: [],
  pageErrors: [],
  externalPageRequests: [],
};
let context;
let page;
const check = (name, details = {}) =>
  report.checks.push({ name, passed: true, ...details });
const state = () =>
  page.evaluate(() => window.__coreFeaturesFixture.snapshot());
const count = async (command) =>
  (await state()).calls.filter((call) => call.command === command).length;
const hold = (command) =>
  page.evaluate(
    (command) => window.__coreFeaturesFixture.hold(command),
    command,
  );
const release = (command) =>
  page.evaluate(
    (command) => window.__coreFeaturesFixture.release(command),
    command,
  );
async function pending(command) {
  await page.waitForFunction(
    (command) =>
      window.__coreFeaturesFixture.snapshot().pending.includes(command),
    command,
  );
}
async function visible(locator) {
  await locator.waitFor({ state: "visible" });
}
async function disabled(locator) {
  assert.equal(
    await locator.isDisabled(),
    true,
    `Expected disabled: ${(await locator.getAttribute("aria-label")) || (await locator.innerText())}`,
  );
}
async function expectValue(locator, value) {
  await page.waitForFunction(
    ({ selector, value }) => document.querySelector(selector)?.value === value,
    {
      selector: await locator.evaluate((node) =>
        node.id ? `#${node.id}` : "input[aria-label='搜索模型']",
      ),
      value,
    },
  );
}
async function disclosure(summary) {
  const heading = page
    .locator("summary")
    .filter({ hasText: new RegExp(`^${summary}$`) })
    .first();
  const parents = await heading.evaluate((node) => {
    const labels = [];
    for (
      let container = node.parentElement?.parentElement?.closest("details");
      container;
      container = container.parentElement?.closest("details")
    ) {
      const label = container
        .querySelector(":scope > summary")
        ?.textContent?.trim();
      if (label) labels.unshift(label);
    }
    return labels;
  });
  for (const parent of parents) await disclosure(parent);
  const details = heading.locator("..");
  if ((await details.getAttribute("open")) === null)
    await details.locator("summary").first().click();
  return details;
}
async function client(name) {
  await page
    .getByRole("navigation", { name: "选择 Agent" })
    .getByRole("button", { name: new RegExp(name) })
    .click();
}
async function verified() {
  await visible(
    page.locator(".hub-probe-status").filter({ hasText: "工具写读验证通过" }),
  );
}
async function globalLock() {
  for (const button of await page
    .getByRole("navigation", { name: "选择 Agent" })
    .getByRole("button")
    .all())
    await disabled(button);
  await disabled(page.locator("#hub-endpoint"));
  await disabled(page.locator("#hub-api-key"));
  await disabled(page.locator("#hub-model"));
  await disabled(page.getByRole("button", { name: "确认连接", exact: true }));
}

try {
  context = await chromium.launchPersistentContext(
    path.join(ownedTemporary, "browser-profile"),
    {
      executablePath:
        options.browser ||
        "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      headless: true,
      viewport: { width: 1200, height: 1000 },
      downloadsPath: path.join(ownedTemporary, "downloads"),
      tracesDir: path.join(ownedTemporary, "traces"),
      env: { ...process.env },
      args: [
        "--disable-background-networking",
        "--disable-component-update",
        "--no-first-run",
        `--crash-dumps-dir=${path.join(ownedTemporary, "crashes")}`,
      ],
    },
  );
  page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin || url.protocol === "data:")
      return route.continue();
    report.externalPageRequests.push(url.origin);
    await route.abort("blockedbyclient");
  });
  await page.addInitScript(() => {
    window.isTauri = true;
    const clone = (value) => structuredClone(value);
    const ids = [
      "claude_code",
      "codex",
      "hermes",
      "oh_my_pi",
      "opencode",
      "zcode",
      "workbuddy",
      "deepseek_harness",
    ];
    const names = [
      "Claude Code",
      "Codex",
      "Hermes Agent",
      "oh-my-pi",
      "OpenCode",
      "Z Code",
      "WorkBuddy",
      "DeepSeek Harness",
    ];
    const profile = (id) => ({
      directory: `G:/synthetic-ui/${id}/profile`,
      homeDirectory: `G:/synthetic-ui/${id}/home`,
      executablePath: `G:/synthetic-ui/${id}/client.exe`,
      workspaceDirectory: `G:/synthetic-ui/${id}/workspace`,
    });
    const agents = ids.map((id, index) => ({
      id,
      name: names[index],
      description: "Synthetic IPC UI fixture",
      protocol: id === "claude_code" ? "anthropic" : "openai",
      configured: false,
      directory: profile(id).directory,
      launcher: null,
      providerId: null,
      model: null,
      reasoningEffort: null,
      mode: "existing",
      profile: profile(id),
      configurationRevision: 0,
      canLaunch: false,
    }));
    const models = ["fixture-small", "fixture-large"].map((id) => ({
      id,
      enabled: true,
      contextWindow: 256000,
      reasoningEfforts: ["low", "high"],
    }));
    const calls = [];
    let providers = [];
    let profiles = [];
    let serial = 0;
    let drifted = false;
    const holds = new Set();
    const waiters = new Map();
    const gate = (command) =>
      !holds.has(command)
        ? Promise.resolve()
        : new Promise((resolve) => {
            const pending = waiters.get(command) || [];
            pending.push(resolve);
            waiters.set(command, pending);
          });
    const record = (command, args) =>
      calls.push({
        command,
        agentId: args?.agentId || args?.input?.agentId || null,
      });
    const safeSnapshot = () => ({
      calls: clone(calls),
      pending: [...waiters.keys()],
      agents: agents.map(
        ({ id, configured, model, providerId, configurationRevision }) => ({
          id,
          configured,
          model,
          providerId,
          configurationRevision,
        }),
      ),
      profiles: clone(profiles),
      drifted,
    });
    window.__coreFeaturesFixture = {
      snapshot: safeSnapshot,
      hold: (command) => holds.add(command),
      release: (command) => {
        holds.delete(command);
        const pending = waiters.get(command) || [];
        waiters.delete(command);
        for (const resolve of pending) resolve();
      },
      setDrifted: (value) => {
        drifted = value;
      },
    };
    const safety = () => ({
      status: drifted ? "drifted" : "healthy",
      canDisconnect: !drifted,
      previewToken: drifted ? null : "synthetic-preview-token",
      files: [
        { slot: "config", managedFields: 4, changedFields: drifted ? 1 : 0 },
      ],
    });
    window.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { label: "main" },
      },
      transformCallback: () => 1,
      invoke: async (command, args = {}) => {
        record(command, args);
        await gate(command);
        if (command === "get_overview")
          return clone({
            providers,
            targets: [],
            dataDirectory: "G:/synthetic-ui/data",
          });
        if (command === "agent_hub_overview")
          return clone({
            agents,
            dataDirectory: "G:/synthetic-ui/data",
            bridgeHealthy: true,
          });
        if (command === "agent_hub_discover")
          return {
            clients: ids.map((agentId) => ({
              agentId,
              executablePath: profile(agentId).executablePath,
              profiles: [profile(agentId)],
              source: "synthetic-fixture",
              reason: null,
            })),
            notes: [],
            limited: false,
            scannedAt: "synthetic",
          };
        if (command === "discover_provider_connection")
          return clone({
            models,
            protocol: "openai",
            authMode: "bearer",
            baseUrl: args.input.baseUrl,
            syncedAt: 1800000000000,
          });
        if (command === "save_provider") {
          const input = args.input;
          const saved = {
            id: input.id || "synthetic-provider",
            family: input.family,
            name: input.name,
            baseUrl: input.baseUrl,
            model: input.model,
            authMode: input.authMode,
            reasoningEffort: input.reasoningEffort,
            codexOptions: clone(input.codexOptions),
            hasKey: true,
            keySuffix: "demo",
            updatedAt: ++serial,
          };
          providers = [
            saved,
            ...providers.filter((provider) => provider.id !== saved.id),
          ];
          return clone(saved);
        }
        if (command === "configure_agent") {
          const input = args.input;
          const agent = agents.find((agent) => agent.id === input.agentId);
          const provider = providers.find(
            (provider) => provider.id === input.providerId,
          );
          Object.assign(agent, {
            configured: true,
            providerId: input.providerId,
            model: input.model,
            reasoningEffort: provider.reasoningEffort,
            profile: input.profile || profile(agent.id),
            launcher: profile(agent.id).executablePath,
            needsRestart: true,
            configurationRevision: agent.configurationRevision + 1,
          });
          return clone(agent);
        }
        if (command === "probe_agent")
          return {
            ok: true,
            model: args.input.model,
            latencyMs: 25,
            message: "Synthetic IPC fixture: simulated file write/read result.",
            validationScope: "tool",
            toolVerified: true,
            stage: "verified",
            cleanup: { succeeded: true },
            clientSurface: "headless-cli",
          };
        if (command === "agent_hub_runtime") {
          const agent = agents.find((agent) => agent.id === args.agentId);
          return {
            agentId: args.agentId,
            configurationRevision: agent.configurationRevision,
            appliedAtMs: 1800000000000,
            platformSupported: true,
            running: false,
            restartRequired: true,
            canRestart: false,
            restartInProgress: false,
            candidates: [],
            reason: "Synthetic IPC fixture; no real client process.",
          };
        }
        if (command === "list_config_profiles") return clone(profiles);
        if (command === "save_config_profile") {
          const input = args.input;
          const old = profiles.find((profile) => profile.id === input.id);
          const saved = {
            id: input.id || `synthetic-profile-${profiles.length + 1}`,
            name: input.name,
            revision: old ? old.revision + 1 : 1,
            updatedAt: 1800000000000,
            entries: agents
              .filter(
                (agent) =>
                  agent.configured &&
                  (!input.agentIds?.length ||
                    input.agentIds.includes(agent.id)),
              )
              .map((agent) => ({
                agentId: agent.id,
                providerId: agent.providerId,
                model: agent.model,
                reasoningEffort: agent.reasoningEffort,
              })),
          };
          profiles = [
            ...profiles.filter((profile) => profile.id !== saved.id),
            saved,
          ];
          return clone(saved);
        }
        if (command === "preview_config_profile") {
          const saved = profiles.find((profile) => profile.id === args.id);
          return clone({
            ...saved,
            fingerprint: `synthetic-fingerprint-${saved.revision}`,
            entries: saved.entries.map((entry) => {
              const old = agents.find((agent) => agent.id === entry.agentId);
              return {
                ...entry,
                providerName: "Synthetic provider",
                previousProviderName: "Synthetic provider",
                previousModel: old.model,
                previousReasoningEffort: old.reasoningEffort,
                targetMode: "existing",
                changed: old.model !== entry.model,
              };
            }),
          });
        }
        if (command === "apply_config_profile") {
          const saved = profiles.find(
            (profile) => profile.id === args.input.id,
          );
          if (
            saved.revision !== args.input.revision ||
            args.input.fingerprint !== `synthetic-fingerprint-${saved.revision}`
          )
            throw {
              code: "configuration_profile_changed",
              message: "synthetic-stale-preview",
            };
          for (const entry of saved.entries)
            Object.assign(
              agents.find((agent) => agent.id === entry.agentId),
              {
                providerId: entry.providerId,
                model: entry.model,
                reasoningEffort: entry.reasoningEffort,
                configurationRevision: ++serial,
              },
            );
          return {
            profileId: saved.id,
            appliedAgentIds: saved.entries.map((entry) => entry.agentId),
            needsRestart: true,
          };
        }
        if (command === "delete_config_profile") {
          profiles = profiles.filter((profile) => profile.id !== args.id);
          return null;
        }
        if (command === "agent_configuration_safety") return safety();
        if (command === "disconnect_agent") {
          if (drifted || args.previewToken !== "synthetic-preview-token")
            throw {
              code: "agent_configuration_changed",
              message: "synthetic-drift",
            };
          Object.assign(
            agents.find((agent) => agent.id === args.agentId),
            {
              configured: false,
              providerId: null,
              model: null,
              reasoningEffort: null,
              launcher: null,
            },
          );
          return {
            agentId: args.agentId,
            disconnected: true,
            needsRestart: true,
          };
        }
        if (command === "agent_hub_activity")
          return {
            capacity: 200,
            records:
              args.agentId !== "codex"
                ? []
                : [
                    {
                      id: "synthetic-incomplete",
                      agentId: "codex",
                      startedAt: 1800000000000,
                      model: "fixture-long-model-name-".repeat(8),
                      endpoint: "responses",
                      upstreamProtocol: "openai",
                      streaming: true,
                      state: "incomplete",
                      status: 200,
                      elapsedMs: 1420,
                      firstByteMs: 75,
                      responseBytes: 4096,
                      usage: {
                        inputTokens: 1200,
                        outputTokens: 350,
                        cachedTokens: 0,
                        reasoningTokens: null,
                      },
                    },
                    {
                      id: "synthetic-completed",
                      agentId: "codex",
                      startedAt: 1800000001000,
                      model: "fixture-small",
                      endpoint: "responses",
                      upstreamProtocol: "openai",
                      streaming: true,
                      state: "completed",
                      status: 200,
                      elapsedMs: 850,
                      firstByteMs: 50,
                      responseBytes: 2048,
                      usage: {
                        inputTokens: 100,
                        outputTokens: 20,
                        cachedTokens: 0,
                        reasoningTokens: 0,
                      },
                    },
                  ],
          };
        if (command === "get_background_settings")
          return { supported: false, enabled: false };
        if (command.startsWith("plugin:"))
          return command.includes("is_maximized") ? false : 1;
        throw new Error(`Unexpected synthetic IPC command: ${command}`);
      },
    };
  });
  await page.goto(origin, { waitUntil: "networkidle" });
  await client("Codex");
  assert.equal(
    await count("list_config_profiles"),
    0,
    "Collapsed profiles must not invoke IPC",
  );
  assert.equal(
    await count("agent_configuration_safety"),
    0,
    "Collapsed protection must not invoke IPC",
  );
  check("collapsed new sections make no IPC calls");

  await hold("discover_provider_connection");
  await page
    .locator("#hub-endpoint")
    .fill("https://synthetic-provider.invalid/v1");
  await disabled(page.getByRole("button", { name: "确认连接", exact: true }));
  await page
    .locator("#hub-api-key")
    .fill("synthetic-ui-key-no-real-credential");
  await pending("discover_provider_connection");
  await disabled(page.getByRole("button", { name: "确认连接", exact: true }));
  assert.equal(await count("save_provider"), 0);
  await release("discover_provider_connection");
  await page
    .locator("#hub-model option[value='fixture-small']")
    .waitFor({ state: "attached" });
  await page.locator("#hub-model").selectOption("fixture-small");
  const search = page.getByRole("textbox", { name: "搜索模型" });
  await search.fill("fixture large");
  await expectValue(page.locator("#hub-model"), "fixture-small");
  assert.equal(
    await page.locator("#hub-model option[value='fixture-large']").count(),
    1,
  );
  await search.fill("no-matching-fixture");
  await visible(page.getByText("没有匹配的模型", { exact: true }));
  await expectValue(page.locator("#hub-model"), "fixture-small");
  await search.press("Escape");
  assert.equal(await search.inputValue(), "");
  assert.equal(
    await page.locator(".hub-model-preferences").getAttribute("open"),
    null,
  );
  assert.equal(
    await page.locator(".hub-advanced-features").getAttribute("open"),
    null,
  );
  for (const [name, width, theme] of [
    ["desktop-dark", 1200, "dark"],
    ["narrow-light", 390, "light"],
  ]) {
    await page.setViewportSize({ width, height: 1000 });
    if ((await page.locator("html").getAttribute("data-ae-theme")) !== theme)
      await page
        .getByRole("button", {
          name: theme === "light" ? "切换浅色主题" : "切换深色主题",
        })
        .click();
    assert.equal(
      await page
        .getByRole("button", { name: "最近使用 0", exact: true })
        .count(),
      0,
    );
    assert.equal(
      await page.getByRole("textbox", { name: "方案名称" }).count(),
      0,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    const screenshot = `core-features-default-${name}.png`;
    await page.screenshot({
      path: path.join(output, screenshot),
      fullPage: true,
      animations: "disabled",
    });
    report.defaultViews.push({
      name,
      screenshot,
      preferencesCollapsed: true,
      advancedCollapsed: true,
      horizontalOverflow: false,
    });
  }
  await page.setViewportSize({ width: 1200, height: 1000 });
  if ((await page.locator("html").getAttribute("data-ae-theme")) !== "dark")
    await page.getByRole("button", { name: "切换深色主题" }).click();
  await disclosure("常用模型");
  await visible(page.getByRole("button", { name: "最近使用 0", exact: true }));
  assert.equal(
    await page.getByRole("button", { name: "最近使用 0", exact: true }).count(),
    1,
  );
  check("four-step model query gate and search preserve the model draft");

  await hold("configure_agent");
  await page.getByRole("button", { name: "确认连接", exact: true }).click();
  await pending("configure_agent");
  assert.equal(await count("save_provider"), 1);
  assert.equal(await count("probe_agent"), 0);
  await release("configure_agent");
  await verified();
  await disclosure("常用模型");
  await page
    .getByRole("button", { name: "收藏 fixture-small", exact: true })
    .click();
  await page.getByRole("button", { name: "收藏 1", exact: true }).click();
  assert.equal(
    await page.locator("#hub-model option[value='fixture-large']").count(),
    0,
  );
  await page.getByRole("button", { name: "最近使用 1", exact: true }).click();
  await expectValue(page.locator("#hub-model"), "fixture-small");
  const preference = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("ae-switch-model-preferences-v1")),
  );
  assert.equal(
    preference['["codex","synthetic-provider"]'].favorites[0],
    "fixture-small",
  );
  assert.equal(
    Object.keys(preference['["codex","synthetic-provider"]'].recent).length,
    1,
  );
  const commands = (await state()).calls.map((call) => call.command);
  assert(
    commands.indexOf("discover_provider_connection") <
      commands.indexOf("save_provider"),
  );
  assert(
    commands.indexOf("save_provider") < commands.indexOf("configure_agent"),
  );
  assert(commands.indexOf("configure_agent") < commands.indexOf("probe_agent"));
  check(
    "query then save then configure then probe; favorites and successful-use recent persist",
  );

  await client("Hermes Agent");
  await disclosure("常用模型");
  await visible(page.getByRole("button", { name: "收藏 0", exact: true }));
  await page
    .locator("#hub-model option[value='fixture-large']")
    .waitFor({ state: "attached" });
  assert.equal(
    await page.getByRole("button", { name: "收藏 0", exact: true }).count(),
    1,
  );
  assert.equal(
    await page.getByRole("button", { name: "最近使用 0", exact: true }).count(),
    1,
  );
  await page.locator("#hub-model").selectOption("fixture-large");
  await page.getByRole("button", { name: "确认连接", exact: true }).click();
  await verified();
  await client("Codex");
  await disclosure("常用模型");
  await page.getByRole("button", { name: /^全部 / }).click();
  await page.locator("#hub-model").selectOption("fixture-small");
  await page.getByRole("button", { name: "确认连接", exact: true }).click();
  await verified();
  check("favorites and recent are isolated between Codex and Hermes");

  const profilesSection = await disclosure("配置方案");
  await visible(profilesSection.getByRole("heading", { name: "具名配置方案" }));
  await profilesSection
    .getByRole("textbox", { name: "方案名称" })
    .fill("工作组合");
  await profilesSection
    .getByRole("button", { name: "保存当前组合", exact: true })
    .click();
  await visible(
    profilesSection.getByRole("button", { name: "预览方案 工作组合" }),
  );
  assert.equal((await state()).profiles[0].entries.length, 2);
  await profilesSection
    .getByRole("button", { name: "预览方案 工作组合" })
    .click();
  await visible(profilesSection.getByLabel("方案预览 工作组合"));
  await profilesSection.getByRole("button", { name: "取消预览" }).click();
  assert.equal(await count("apply_config_profile"), 0);
  assert.equal(
    await profilesSection.getByLabel("方案预览 工作组合").count(),
    0,
  );
  await profilesSection
    .getByRole("button", { name: "预览方案 工作组合" })
    .click();
  await visible(profilesSection.getByLabel("方案预览 工作组合"));
  await hold("apply_config_profile");
  await profilesSection.getByRole("button", { name: "应用此方案" }).click();
  await pending("apply_config_profile");
  await globalLock();
  await release("apply_config_profile");
  await visible(
    page.getByText("配置方案已应用，请让相关客户端重新加载配置并重新验证。", {
      exact: true,
    }),
  );
  assert.equal(
    await page.locator(".hub-connection-result").count(),
    0,
    "Applying a profile must clear the old verification result",
  );
  check(
    "two-client profile save, preview cancel, exact preview apply, global lock and stale-verification reset",
  );

  await profilesSection
    .getByRole("button", { name: "更新方案 工作组合" })
    .click();
  await page.waitForFunction(
    () => window.__coreFeaturesFixture.snapshot().profiles[0].revision === 2,
  );
  await profilesSection
    .getByRole("textbox", { name: "方案名称" })
    .fill("临时组合");
  await profilesSection
    .getByRole("button", { name: "保存当前组合", exact: true })
    .click();
  await visible(
    profilesSection.getByRole("button", {
      name: "删除方案 临时组合",
      exact: true,
    }),
  );
  await profilesSection
    .getByRole("button", { name: "删除方案 临时组合", exact: true })
    .click();
  assert.equal(await count("delete_config_profile"), 0);
  await profilesSection.getByRole("button", { name: "取消删除" }).click();
  await profilesSection
    .getByRole("button", { name: "删除方案 临时组合", exact: true })
    .click();
  await profilesSection
    .getByRole("button", { name: "确认删除方案 临时组合", exact: true })
    .click();
  await page.waitForFunction(
    () => window.__coreFeaturesFixture.snapshot().profiles.length === 1,
  );
  check("profile update and two-step delete with cancellation");

  const safetySection = await disclosure("配置保护与安全断开");
  await visible(
    safetySection.getByText("AE 管理的连接字段与最近写入一致。", {
      exact: true,
    }),
  );
  await safetySection
    .getByRole("button", { name: "预览断开", exact: true })
    .click();
  await visible(safetySection.getByLabel("断开预览"));
  await safetySection.getByRole("button", { name: "取消断开" }).click();
  assert.equal(await count("disconnect_agent"), 0);
  await safetySection
    .getByRole("button", { name: "预览断开", exact: true })
    .click();
  await visible(safetySection.getByLabel("断开预览"));
  const activitySection = await disclosure("请求活动");
  await visible(
    activitySection.getByText("输出未完成 · HTTP 200", { exact: true }),
  );
  await profilesSection
    .getByRole("button", { name: "预览方案 工作组合" })
    .click();
  await visible(profilesSection.getByLabel("方案预览 工作组合"));
  check(
    "disconnect preview cancel is read-only; incomplete activity is distinguished from completion",
  );

  async function captureViews(stateName) {
    for (const [name, width, theme] of [
      ["desktop-dark", 1200, "dark"],
      ["narrow-dark", 390, "dark"],
      ["desktop-light", 1200, "light"],
      ["narrow-light", 390, "light"],
    ]) {
      await page.setViewportSize({ width, height: 1000 });
      if ((await page.locator("html").getAttribute("data-ae-theme")) !== theme)
        await page
          .getByRole("button", {
            name: theme === "light" ? "切换浅色主题" : "切换深色主题",
          })
          .click();
      const file = `core-features-${stateName}-${name}.png`;
      await page.screenshot({
        path: path.join(output, file),
        fullPage: true,
        animations: "disabled",
      });
      const metrics = await page.evaluate(() => ({
        viewport: innerWidth,
        content: document.documentElement.scrollWidth,
      }));
      assert(
        metrics.content <= metrics.viewport,
        `Horizontal overflow in ${stateName}/${name}: ${metrics.content} > ${metrics.viewport}`,
      );
      const field = await page.locator("#hub-model").boundingBox();
      const picker = await page.locator(".hub-model-picker").boundingBox();
      assert(
        field &&
          picker &&
          field.width >= picker.width - 2 &&
          field.height >= 44,
        "The primary model field must retain its full-width styled control",
      );
      const axe = await new AxeBuilder({ page })
        .include(".hub-model-picker")
        .include(".hub-config-profiles")
        .include(".hub-configuration-safety")
        .include(".hub-activity")
        .analyze();
      const violations = axe.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        nodes: violation.nodes.map((node) => ({
          target: node.target,
          failureSummary: node.failureSummary,
        })),
      }));
      report.views.push({
        name: `${stateName}/${name}`,
        screenshot: file,
        horizontalOverflow: false,
        accessibilityViolations: violations,
      });
      // Retain every viewport's evidence before failing the run, so a first
      // contrast defect does not hide narrow-layout or later-flow failures.
    }
  }
  await captureViews("preview");
  await safetySection.getByRole("button", { name: "取消断开" }).click();
  await page.evaluate(() => window.__coreFeaturesFixture.setDrifted(true));
  await safetySection.getByRole("button", { name: "检查配置" }).click();
  await visible(
    safetySection
      .getByRole("alert")
      .filter({ hasText: "检测到连接配置已被其他程序或手动修改" }),
  );
  await disabled(
    safetySection.getByRole("button", { name: "预览断开", exact: true }),
  );
  await captureViews("drift");
  check("four viewport/theme combinations have no horizontal overflow", {
    screenshots: report.views.length,
  });

  await page.evaluate(() => window.__coreFeaturesFixture.setDrifted(false));
  await safetySection.getByRole("button", { name: "检查配置" }).click();
  await visible(
    safetySection.getByText("AE 管理的连接字段与最近写入一致。", {
      exact: true,
    }),
  );
  await safetySection
    .getByRole("button", { name: "预览断开", exact: true })
    .click();
  await visible(safetySection.getByLabel("断开预览"));
  await hold("disconnect_agent");
  await safetySection.getByRole("button", { name: "恢复原配置并断开" }).click();
  await pending("disconnect_agent");
  await globalLock();
  await disabled(profilesSection.getByRole("button", { name: "应用此方案" }));
  await release("disconnect_agent");
  await visible(
    page.getByText("已断开 AE 连接并恢复受管字段，请让客户端重新加载配置。", {
      exact: true,
    }),
  );
  assert.equal(
    (await state()).agents.find((agent) => agent.id === "codex").configured,
    false,
  );
  assert.equal(await page.locator(".hub-connection-result").count(), 0);
  check(
    "drift blocks unsafe preview; disconnect confirmation locks the page and clears old verification",
  );
  assert.equal(report.pageErrors.length, 0, "No page errors are allowed");
  assert.equal(
    report.externalPageRequests.length,
    0,
    "The fixture may not contact external page resources",
  );
  assert.equal(
    report.views.flatMap((view) => view.accessibilityViolations).length,
    0,
    "New regions must have zero axe accessibility violations in every captured view",
  );
  check("every captured new region has zero axe accessibility violations");
  report.ipcCalls = (await state()).calls;
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = { name: error.name, message: error.message };
  if (page) {
    await page
      .screenshot({
        path: path.join(output, "core-features-failure.png"),
        fullPage: true,
      })
      .catch(() => {});
    report.pageText = await page
      .locator("body")
      .innerText()
      .catch(() => "unavailable");
    report.ipcCalls = await state()
      .then((value) => value.calls)
      .catch(() => []);
  }
  process.exitCode = 1;
} finally {
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  report.finishedAt = new Date().toISOString();
  report.browserTemporaryDataRetained = false;
  // Only remove this exact run's generated browser profile, after closing Edge.
  const resolved = path.resolve(ownedTemporary);
  assert(
    resolved.startsWith(
      path.join(workspace, ".cache/core-features-ui") + path.sep,
    ),
  );
  await fs.rm(resolved, { recursive: true, force: true }).catch((error) => {
    report.browserTemporaryDataRetained = true;
    report.cleanupError = error.code || "cleanup-failed";
  });
  await fs.writeFile(
    path.join(output, "core-features-ui.json"),
    JSON.stringify(report, null, 2),
  );
  process.stdout.write(
    JSON.stringify(
      {
        passed: report.passed,
        scope: report.scope,
        checks: report.checks.length,
        views: report.views.length,
        receipt: path
          .relative(workspace, path.join(output, "core-features-ui.json"))
          .replaceAll("\\", "/"),
        failure: report.failure || null,
      },
      null,
      2,
    ) + "\n",
  );
}
