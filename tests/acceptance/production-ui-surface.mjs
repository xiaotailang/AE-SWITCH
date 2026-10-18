import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { AGENTS, isNativeRequest } from "./production-ui-eight-contract.mjs";

const sha = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const tutorial = JSON.parse(
  fs.readFileSync(
    new URL("../../app/src/content/tutorial.json", import.meta.url),
    "utf8",
  ),
);
const surfaceCommands = new Set([
  "get_overview",
  "agent_hub_overview",
  "agent_hub_discover",
  "get_background_settings",
  "agent_hub_runtime",
  "discover_provider_connection",
  "plugin:window|is_maximized",
  "plugin:window|toggle_maximize",
  "plugin:event|listen",
  "plugin:event|unlisten",
]);
const savedDetails = ".hub-connection-panel > form > .hub-extra-settings";
export const SURFACE_CHECKS = Object.freeze({
  common: [
    "current single-page native surface and four steps",
    "quickstart opens with heading focus and closes with Escape",
    "quickstart close control restores trigger focus",
    "system startup setting is read without changing the OS",
    "offline tutorial all topics render from production content",
    "tutorial button close preserves quickstart and restores focus",
    "theme toggles in production DOM and local storage then restores",
    "credential visibility toggle restores password masking",
    "production native maximize and restore window controls",
  ],
  before: [
    "all eight navigation choices retain their exact installed profile",
    "unconfigured launch stays disabled",
  ],
  after: [
    "saved connection selection uses retained key and saved default",
    "saved connection and client actions folds retain an unsaved name draft",
    "manual profile required fields prevent confirmation and restore automatic selection",
    "client discovery retry observes a real read-only Rust response",
    "new supplier draft isolates saved fields without saving",
    "closed-port supplier failure and one real sync retry stay blocked",
    "runtime candidate availability is observed without launching or restarting",
  ],
});

export function nativeSurfaceCommand(request) {
  try {
    const url = new URL(request.url());
    if (
      request.method() !== "POST" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !(
        (["http:", "https:"].includes(url.protocol) &&
          url.hostname === "ipc.localhost") ||
        (url.protocol === "ipc:" && url.hostname === "localhost")
      )
    )
      return null;
    const command = decodeURIComponent(url.pathname.slice(1));
    return command && !command.includes("/") ? command : null;
  } catch {
    return null;
  }
}

export function assertSurfaceCommands(commands) {
  assert.ok(Array.isArray(commands));
  for (const command of commands)
    assert.ok(
      surfaceCommands.has(command),
      "Unexpected mutating or external native command during surface checks",
    );
}

export function assertFailedDiscovery({ ui, native, observedRequests }) {
  assert.equal(
    observedRequests,
    1,
    "One retry must issue exactly one native discovery request",
  );
  assert.equal(native.command, "discover_provider_connection");
  assert.equal(native.tauriResponse, "error");
  assert.equal(native.errorCode, "network");
  assert.ok(ui.failure.length > 0, "Rust failure must remain visible");
  assert.deepEqual(ui.models, []);
  assert.equal(ui.confirmDisabled, true);
  assert.equal(ui.modelDisabled, true);
  assert.equal(ui.retryEnabled, true);
}

export function assertSurfaceReceipt(receipt) {
  assert.equal(receipt.productionNativeIpc, true);
  assert.equal(receipt.qaHooksUsed, false);
  assert.equal(receipt.applicationInvokeReplaced, false);
  assert.equal(receipt.systemStartupMutated, false);
  assert.equal(receipt.externalProgramOpened, false);
  assert.equal(receipt.clientLaunchedOrRestarted, false);
  assert.equal(receipt.nativeStoreUnchanged, true);
  assert.equal(receipt.schemaVersion, 1);
  assert.match(receipt.ownerId, /^[a-f0-9]{32}$/u);
  assert.ok(["before", "after"].includes(receipt.phase));
  assert.equal(
    receipt.complete,
    false,
    "Bounded surface checks cannot establish all-function acceptance",
  );
  assert.equal(receipt.pageRestored, true);
  assert.match(receipt.nativeStateBeforeSha256, /^[a-f0-9]{64}$/u);
  assert.equal(receipt.nativeStateAfterSha256, receipt.nativeStateBeforeSha256);
  assertSurfaceCommands(receipt.observedNativeCommands);
  for (const command of [
    "get_overview",
    "agent_hub_overview",
    "get_background_settings",
    "plugin:window|is_maximized",
    "plugin:window|toggle_maximize",
  ])
    assert.ok(
      receipt.observedNativeCommands.includes(command),
      "Required native command was not observed",
    );
  for (const field of [
    "initialNativeMaximized",
    "toggledNativeMaximized",
    "restoredNativeMaximized",
  ])
    assert.equal(typeof receipt.window[field], "boolean");
  assert.equal(
    receipt.window.toggledNativeMaximized,
    !receipt.window.initialNativeMaximized,
  );
  assert.equal(
    receipt.window.restoredNativeMaximized,
    receipt.window.initialNativeMaximized,
  );
  assert.equal(typeof receipt.background.supported, "boolean");
  assert.equal(typeof receipt.background.enabled, "boolean");
  assert.equal(receipt.background.nativeResponse, "ok");
  assert.equal(typeof receipt.providerAvailable, "boolean");
  assert.equal(
    new Set(receipt.checks.map((check) => check.name)).size,
    receipt.checks.length,
  );
  assert.ok(receipt.checks.every((check) => check.status === "passed"));
  const required = [
    ...SURFACE_CHECKS.common,
    ...(receipt.phase === "before"
      ? SURFACE_CHECKS.before
      : receipt.providerAvailable
        ? SURFACE_CHECKS.after
        : []),
  ];
  assert.deepEqual(
    receipt.checks.map((check) => check.name).sort(),
    required.sort(),
    "Surface receipt omitted or invented a required GUI check",
  );
  if (receipt.phase === "after" && receipt.providerAvailable) {
    for (const command of [
      "agent_hub_discover",
      "discover_provider_connection",
      "agent_hub_runtime",
    ])
      assert.ok(receipt.observedNativeCommands.includes(command));
    assertFailedDiscovery(receipt.failedDiscovery.initial);
    assertFailedDiscovery(receipt.failedDiscovery.retry);
  }
  assert.ok(receipt.unvalidated.length > 0);
  assert.ok(
    receipt.unvalidated.every(
      (check) => check.status === "unvalidated" && check.reason,
    ),
  );
  assert.equal(
    new Set(receipt.unvalidated.map((check) => check.name)).size,
    receipt.unvalidated.length,
  );
  assert.equal(
    receipt.checks.some((check) =>
      receipt.unvalidated.some((item) => item.name === check.name),
    ),
    false,
  );
  if (receipt.phase === "after" && !receipt.providerAvailable)
    assert.ok(
      receipt.unvalidated.some(
        (check) =>
          check.name ===
          "saved supplier, manual profile gate and discovery retry",
      ),
    );
}

async function poll(read, predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(label + " did not settle within the surface deadline");
}

async function protectedState(readonlyNative) {
  const overview = await readonlyNative("get_overview");
  const hub = await readonlyNative("agent_hub_overview");
  return {
    providers: overview.providers,
    selections: hub.agents.map((agent) =>
      Object.fromEntries(
        [
          "id",
          "configured",
          "mode",
          "providerId",
          "model",
          "profile",
          "configurationRevision",
          "appliedAtMs",
          "directory",
          "launcher",
        ].map((field) => [field, agent[field] ?? null]),
      ),
    ),
  };
}

async function nativeWindowMaximized(page) {
  const value = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("plugin:window|is_maximized", {
      label: "main",
    }),
  );
  assert.equal(typeof value, "boolean");
  return value;
}

async function pageState(page) {
  return page.evaluate(() => ({
    selectedAgent: document.querySelector(
      '.hub-agent-item[aria-current="page"] img',
    )?.alt,
    theme: document.documentElement.dataset.aeTheme,
    storedTheme: localStorage.getItem("ae-switch-theme"),
    endpoint: document.getElementById("hub-endpoint")?.value || "",
    providerId: document.getElementById("hub-provider")?.value || "",
    name: document.querySelector('input[aria-label="供应商名称"]')?.value || "",
    model: document.getElementById("hub-model")?.value || "",
    profile: document.getElementById("hub-installed-profile")?.value || "",
    keyType: document.getElementById("hub-api-key")?.type,
    keyEmpty: document.getElementById("hub-api-key")?.value === "",
    manualMode: !!document.querySelector(".hub-manual-profile"),
    panels: [
      ...document.querySelectorAll(
        ".hub-connection-panel > form > .hub-extra-settings, .hub-profile-settings, .hub-client-actions",
      ),
    ].map((element) => ({ className: element.className, open: element.open })),
  }));
}

async function modelTerminal(page) {
  return poll(
    async () =>
      page.evaluate(() => {
        const model = document.getElementById("hub-model");
        const status = document.querySelector(".hub-model-status");
        return {
          loading:
            status?.textContent.includes("正在识别协议并获取模型列表") ?? false,
          failure:
            document
              .querySelector(".hub-model-status.failure")
              ?.textContent.trim() || "",
          models: [...(model?.options || [])]
            .map((option) => option.value)
            .filter(Boolean),
          modelDisabled: model?.disabled === true,
          confirmDisabled:
            document.querySelector(".hub-form-actions .primary")?.disabled ===
            true,
          retryEnabled: [
            ...document.querySelectorAll(".hub-model-label button"),
          ].some((button) => !button.disabled),
        };
      }),
    (state) =>
      !state.loading &&
      (state.failure || (!state.modelDisabled && state.models.length)),
    "model discovery",
    60000,
  );
}

// The caller owns the production image, process handles, CDP listener and cleanup.
// No direct mutating invoke, request interception, supplier mock or OS opener.
export async function verifyProductionSurface({
  page,
  setup,
  readonlyNative,
  phase = "before",
  provider = null,
}) {
  assert.ok(["before", "after"].includes(phase));
  assert.match(setup.ownerId, /^[a-f0-9]{32}$/u);
  const receipt = {
    schemaVersion: 1,
    ownerId: setup.ownerId,
    phase,
    providerAvailable: !!provider,
    startedAt: new Date().toISOString(),
    passed: false,
    complete: false,
    productionNativeIpc: false,
    qaHooksUsed: false,
    applicationInvokeReplaced: false,
    systemStartupMutated: false,
    externalProgramOpened: false,
    clientLaunchedOrRestarted: false,
    nativeStoreUnchanged: false,
    checks: [],
    observedNativeCommands: [],
    unvalidated: [],
  };
  const onRequest = (request) => {
    const command = nativeSurfaceCommand(request);
    if (command) receipt.observedNativeCommands.push(command);
  };
  page.on("request", onRequest);
  let baseline,
    initial,
    initialMaximized,
    manualDraft,
    failure,
    startedActions = false,
    activeCheck = "initial production surface prerequisites";
  const checked = async (name, action) => {
    activeCheck = name;
    await action();
    receipt.checks.push({ name, status: "passed" });
  };
  const unavailable = (name, reason) =>
    receipt.unvalidated.push({ name, status: "unvalidated", reason });
  const button = (name) => page.getByRole("button", { name, exact: true });
  const selectAgent = async (name) => {
    await page
      .getByRole("navigation", { name: "选择 Agent", exact: true })
      .getByRole("button")
      .filter({
        has: page.getByRole("img", { name: name + " 官方图标", exact: true }),
      })
      .click();
    await page.getByRole("heading", { name, exact: true }).waitFor();
  };
  const setDetails = async (selector, open) => {
    const details = page.locator(selector);
    if (((await details.getAttribute("open")) !== null) !== open)
      await details.locator(":scope > summary").click();
    assert.equal((await details.getAttribute("open")) !== null, open);
  };
  const focused = async (locator) =>
    poll(
      () => locator.evaluate((element) => document.activeElement === element),
      (value) => value,
      "restored trigger focus",
    );
  try {
    baseline = await protectedState(readonlyNative);
    initial = await pageState(page);
    assert.equal(
      initial.keyEmpty,
      true,
      "Surface checks require cleared credential input",
    );
    assert.equal(initial.keyType, "password");
    assert.equal(
      initial.manualMode,
      false,
      "Surface checks require an automatic installed profile",
    );
    assert.equal(initial.theme, initial.storedTheme);
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(await page.locator(".hub-help").count(), 0);
    await poll(
      () => page.locator("#hub-installed-profile").inputValue(),
      (value) => !!value,
      "initial ordinary installed profile",
    );
    initial = await pageState(page);
    initialMaximized = await nativeWindowMaximized(page);
    startedActions = true;
    await checked(
      "current single-page native surface and four steps",
      async () => {
        assert.equal(
          await page.evaluate(
            () => typeof window.__TAURI_INTERNALS__?.invoke === "function",
          ),
          true,
        );
        receipt.productionNativeIpc = true;
        await page
          .getByRole("heading", { name: "端点配置", exact: true })
          .waitFor();
        assert.equal(await page.locator(".hub-preview-note").count(), 0);
        assert.equal(
          await page
            .getByRole("navigation", { name: "选择 Agent" })
            .getByRole("button")
            .count(),
          AGENTS.length,
        );
        assert.deepEqual(
          (
            await page
              .getByRole("list", { name: "连接步骤" })
              .getByRole("listitem")
              .allTextContents()
          ).map((text) => text.replace(/^\d\s*/u, "").trim()),
          ["输入端点", "输入 API Key", "选择模型", "确认连接"],
        );
        assert.equal(await button("高级供应商管理").count(), 0);
        assert.equal(await button("返回 Agent Hub").count(), 0);
      },
    );
    if (phase === "before") {
      await checked(
        "all eight navigation choices retain their exact installed profile",
        async () => {
          const hub = await readonlyNative("agent_hub_overview");
          for (const id of AGENTS) {
            const agent = hub.agents.find((item) => item.id === id);
            assert.ok(agent);
            await selectAgent(agent.name);
            await poll(
              () => page.locator("#hub-installed-profile").inputValue(),
              (value) => !!value,
              id + " ordinary profile",
            );
            assert.deepEqual(
              JSON.parse(
                await page.locator("#hub-installed-profile").inputValue(),
              ),
              setup.fixtures.payload.discoveredProfiles[id],
              "Ordinary installed profile does not match the owned fixture",
            );
            assert.equal(
              await page.locator(".hub-profile-settings").getAttribute("open"),
              null,
            );
            assert.equal(await button("确认连接").isDisabled(), true);
          }
        },
      );
      await checked("unconfigured launch stays disabled", async () => {
        await setDetails(".hub-client-actions", true);
        const hub = await readonlyNative("agent_hub_overview");
        const selected = hub.agents.find(
          (agent) => initial.selectedAgent === agent.name + " 官方图标",
        );
        await selectAgent(selected.name);
        assert.equal(await button("启动 " + selected.name).isDisabled(), true);
        await setDetails(".hub-client-actions", false);
      });
    }
    await checked(
      "quickstart opens with heading focus and closes with Escape",
      async () => {
        const backgroundResponse = page.waitForResponse(
          (response) =>
            isNativeRequest(response.request(), "get_background_settings"),
          { timeout: 15000 },
        );
        backgroundResponse.catch(() => {});
        await button("快速上手").click();
        const response = await backgroundResponse;
        assert.equal(await response.headerValue("Tauri-Response"), "ok");
        const settings = await response.json();
        assert.equal(typeof settings.supported, "boolean");
        assert.equal(typeof settings.enabled, "boolean");
        receipt.background = {
          supported: settings.supported,
          enabled: settings.enabled,
          nativeResponse: "ok",
        };
        await poll(
          () => page.evaluate(() => document.activeElement?.id),
          (id) => id === "hub-quickstart-title",
          "quickstart heading focus",
        );
        assert.deepEqual(
          (await page.locator(".hub-help > ol > li").allTextContents()).map(
            (text) => text.trim(),
          ),
          [
            "输入供应商的 API 端点。",
            "输入 API Key，自动查询可用模型。",
            "选择要使用的模型。",
            "点击“确认连接”，自动配置所选软件并验证。",
          ],
        );
        assert.match(
          await page.locator(".hub-help").innerText(),
          /保留历史和其他设置/u,
        );
        await page.keyboard.press("Escape");
        assert.equal(await page.locator(".hub-help").count(), 0);
        await focused(button("快速上手"));
      },
    );
    await checked(
      "quickstart close control restores trigger focus",
      async () => {
        await button("快速上手").click();
        await button("关闭快速上手").click();
        assert.equal(await page.locator(".hub-help").count(), 0);
        await focused(button("快速上手"));
      },
    );
    await checked(
      "system startup setting is read without changing the OS",
      async () => {
        await button("快速上手").click();
        const startup = page.getByRole("checkbox", {
          name: "随 Windows 启动，在后台运行",
          exact: true,
        });
        await startup.waitFor();
        await poll(
          () => startup.isDisabled(),
          (disabled) => disabled === !receipt.background.supported,
          "production system startup read",
        );
        assert.equal(await startup.isChecked(), receipt.background.enabled);
        if (!receipt.background.supported) {
          assert.match(
            await page.locator(".hub-help").innerText(),
            /当前环境不支持修改系统启动项/u,
          );
          unavailable(
            "supported production system startup UI",
            "The real production read returned supported=false in this run.",
          );
        }
        unavailable(
          "actual Windows login autostart enable/disable",
          "Only the production read route was exercised; HKCU mutation and a Windows login require an independently scoped system run.",
        );
      },
    );
    await checked(
      "offline tutorial all topics render from production content",
      async () => {
        await button("完整使用说明").click();
        const dialog = page.getByRole("dialog", {
          name: "使用说明",
          exact: true,
        });
        await dialog.waitFor();
        const nav = dialog.getByRole("navigation", {
          name: "教程目录",
          exact: true,
        });
        assert.equal(
          await nav.getByRole("button").count(),
          tutorial.topics.length,
        );
        for (const topic of tutorial.topics) {
          await nav
            .getByRole("button", { name: topic.title, exact: true })
            .click();
          await dialog
            .getByRole("heading", { name: topic.title, level: 3, exact: true })
            .waitFor();
          assert.equal(
            await nav
              .getByRole("button", { name: topic.title, exact: true })
              .getAttribute("aria-current"),
            "page",
          );
          assert.equal(
            (await dialog.locator(".tutorial-summary").innerText()).trim(),
            topic.summary,
          );
        }
        await dialog.locator(".tutorial-article").focus();
        await page.keyboard.press("Tab");
        assert.equal(
          await dialog.evaluate((element) =>
            element.contains(document.activeElement),
          ),
          true,
        );
        await page.keyboard.press("Escape");
        assert.equal(await page.getByRole("dialog").count(), 0);
        await focused(button("完整使用说明"));
      },
    );
    await checked(
      "tutorial button close preserves quickstart and restores focus",
      async () => {
        await button("完整使用说明").click();
        await button("关闭弹窗").click();
        assert.equal(await page.getByRole("dialog").count(), 0);
        await focused(button("完整使用说明"));
        await button("完整使用说明").click();
        await button("开始使用").click();
        assert.equal(await page.getByRole("dialog").count(), 0);
        await focused(button("完整使用说明"));
        await button("关闭快速上手").click();
      },
    );
    await checked(
      "theme toggles in production DOM and local storage then restores",
      async () => {
        const starting = await page.evaluate(
          () => document.documentElement.dataset.aeTheme,
        );
        await button(
          starting === "dark" ? "切换浅色主题" : "切换深色主题",
        ).click();
        const expected = starting === "dark" ? "light" : "dark";
        await poll(
          () =>
            page.evaluate(() => ({
              theme: document.documentElement.dataset.aeTheme,
              stored: localStorage.getItem("ae-switch-theme"),
            })),
          (value) => value.theme === expected && value.stored === expected,
          "theme preference",
        );
        await button(
          expected === "dark" ? "切换浅色主题" : "切换深色主题",
        ).click();
        await poll(
          () => page.evaluate(() => document.documentElement.dataset.aeTheme),
          (value) => value === starting,
          "restored theme",
        );
      },
    );
    await checked(
      "credential visibility toggle restores password masking",
      async () => {
        assert.equal(
          await page.locator("#hub-api-key").getAttribute("type"),
          "password",
        );
        await button("显示 API Key").click();
        assert.equal(
          await page.locator("#hub-api-key").getAttribute("type"),
          "text",
        );
        await button("隐藏 API Key").click();
        assert.equal(
          await page.locator("#hub-api-key").getAttribute("type"),
          "password",
        );
      },
    );
    await checked(
      "production native maximize and restore window controls",
      async () => {
        assert.equal(
          await button(initialMaximized ? "还原窗口" : "最大化窗口").count(),
          1,
        );
        await button(initialMaximized ? "还原窗口" : "最大化窗口").click();
        await button(initialMaximized ? "最大化窗口" : "还原窗口").waitFor();
        const toggledNativeMaximized = await nativeWindowMaximized(page);
        assert.equal(toggledNativeMaximized, !initialMaximized);
        await button(initialMaximized ? "最大化窗口" : "还原窗口").click();
        await button(initialMaximized ? "还原窗口" : "最大化窗口").waitFor();
        const restoredNativeMaximized = await nativeWindowMaximized(page);
        assert.equal(restoredNativeMaximized, initialMaximized);
        receipt.window = {
          initialNativeMaximized: initialMaximized,
          toggledNativeMaximized,
          restoredNativeMaximized,
        };
        assert.equal(await page.locator(".window-operation-error").count(), 0);
        assert.equal(await button("最小化窗口").isEnabled(), true);
        assert.equal(await button("关闭窗口并留在托盘").isEnabled(), true);
      },
    );
    if (phase === "after" && provider) {
      await checked(
        "saved connection selection uses retained key and saved default",
        async () => {
          await setDetails(savedDetails, true);
          await page.locator("#hub-provider").selectOption(provider.id);
          assert.equal(await page.locator("#hub-api-key").inputValue(), "");
          assert.equal(
            sha(await page.locator("#hub-endpoint").inputValue()),
            sha(provider.baseUrl),
            "Saved endpoint selection mismatch",
          );
          const state = await modelTerminal(page);
          assert.equal(state.failure, "");
          assert.ok(state.models.includes(provider.model));
          assert.equal(
            await page.locator("#hub-model").inputValue(),
            provider.model,
          );
        },
      );
      await checked(
        "saved connection and client actions folds retain an unsaved name draft",
        async () => {
          await page
            .getByLabel("供应商名称", { exact: true })
            .fill("Synthetic unsaved surface draft");
          const model = await page.locator("#hub-model").inputValue();
          for (const selector of [savedDetails, ".hub-client-actions"]) {
            await setDetails(selector, false);
            await setDetails(selector, true);
            assert.equal(
              sha(await page.locator("#hub-endpoint").inputValue()),
              sha(provider.baseUrl),
              "Folding changed the saved endpoint",
            );
            assert.equal(await page.locator("#hub-model").inputValue(), model);
            assert.equal(
              await page.getByLabel("供应商名称", { exact: true }).inputValue(),
              "Synthetic unsaved surface draft",
            );
          }
          await page
            .getByLabel("供应商名称", { exact: true })
            .fill(provider.name);
        },
      );
      await checked(
        "manual profile required fields prevent confirmation and restore automatic selection",
        async () => {
          await setDetails(".hub-profile-settings", true);
          const original = await page
            .locator("#hub-installed-profile")
            .inputValue();
          await button("手动指定已有客户端").click();
          const directory = page.getByLabel("原配置目录", { exact: true });
          const old = await directory.inputValue();
          manualDraft = {
            agent: await page.locator("#connection-title").innerText(),
            directory: old,
          };
          await directory.fill("");
          assert.equal(await button("确认连接").isDisabled(), true);
          assert.equal(await button("仅保存").isEnabled(), true);
          await directory.fill(old);
          assert.equal(await button("确认连接").isEnabled(), true);
          const optional = page.locator(
            ".hub-manual-profile .hub-extra-settings",
          );
          await optional.locator(":scope > summary").click();
          const optionalPath = page.getByLabel("Profile 名称", { exact: true });
          const originalOptional = await optionalPath.inputValue();
          manualDraft.optional = originalOptional;
          await optionalPath.fill("Synthetic unsaved optional profile");
          await optionalPath.fill(originalOptional);
          await button("使用自动探测结果").click();
          assert.equal(
            await page.locator("#hub-installed-profile").inputValue(),
            original,
          );
          assert.equal(await button("确认连接").isEnabled(), true);
          manualDraft = null;
        },
      );
      await checked(
        "client discovery retry observes a real read-only Rust response",
        async () => {
          await setDetails(".hub-profile-settings", true);
          const responsePromise = page.waitForResponse(
            (response) =>
              isNativeRequest(response.request(), "agent_hub_discover"),
            { timeout: 60000 },
          );
          responsePromise.catch(() => {});
          await button("重新探测工具").click();
          const response = await responsePromise;
          assert.equal(await response.headerValue("Tauri-Response"), "ok");
          const result = await response.json();
          assert.equal(result.limited, false);
          assert.deepEqual(
            [...new Set(result.clients.map((client) => client.agentId))].sort(),
            [...AGENTS].sort(),
          );
        },
      );
      await checked(
        "new supplier draft isolates saved fields without saving",
        async () => {
          await page.locator("#hub-provider").selectOption("");
          assert.equal(
            await page.locator("#hub-endpoint").inputValue(),
            "https://aiease-yun.com",
          );
          assert.equal(await page.locator("#hub-api-key").inputValue(), "");
          assert.equal(
            await page.getByLabel("供应商名称", { exact: true }).inputValue(),
            "",
          );
          assert.equal(await page.locator("#hub-model").inputValue(), "");
          assert.equal(await button("确认连接").isDisabled(), true);
        },
      );
      await checked(
        "closed-port supplier failure and one real sync retry stay blocked",
        async () => {
          await page.locator("#hub-endpoint").fill("http://127.0.0.1:9/v1");
          const failedRequest = async (action) => {
            const observed = [];
            const onDiscovery = (request) => {
              if (isNativeRequest(request, "discover_provider_connection"))
                observed.push(request);
            };
            page.on("request", onDiscovery);
            try {
              const responsePromise = page.waitForResponse(
                (response) =>
                  isNativeRequest(
                    response.request(),
                    "discover_provider_connection",
                  ) && observed.includes(response.request()),
                { timeout: 60000 },
              );
              responsePromise.catch(() => {});
              await action();
              const response = await responsePromise;
              const error = await response.json();
              const ui = await modelTerminal(page);
              const result = {
                ui: {
                  ...ui,
                  failure: ui.failure ? "Visible native network failure" : "",
                },
                native: {
                  command: "discover_provider_connection",
                  tauriResponse: await response.headerValue("Tauri-Response"),
                  errorCode: error.code,
                },
                observedRequests: observed.length,
              };
              assertFailedDiscovery(result);
              return result;
            } finally {
              page.off("request", onDiscovery);
            }
          };
          receipt.failedDiscovery = {
            initial: await failedRequest(() =>
              page
                .locator("#hub-api-key")
                .fill("ae-switch-synthetic-surface-invalid-key"),
            ),
          };
          receipt.failedDiscovery.retry = await failedRequest(() =>
            button("同步模型").click(),
          );
          await page.locator("#hub-api-key").fill("");
          await page.locator("#hub-provider").selectOption(provider.id);
          const restored = await modelTerminal(page);
          assert.equal(restored.failure, "");
          assert.equal(
            await page.locator("#hub-model").inputValue(),
            provider.model,
          );
        },
      );
      await checked(
        "runtime candidate availability is observed without launching or restarting",
        async () => {
          await setDetails(".hub-client-actions", true);
          const selectedName = await page
            .locator("#connection-title")
            .innerText();
          await poll(
            () => page.locator("#hub-running-client").count(),
            (count) => count === 1,
            "runtime instance selector",
          );
          await poll(
            () => page.locator("#hub-running-client").isDisabled(),
            (disabled) => !disabled,
            "native runtime read",
          );
          const candidates =
            (await page.locator("#hub-running-client option").count()) - 1;
          receipt.runtime = {
            candidateCount: candidates,
            restartDisabled: await button(
              "安全重启 " + selectedName,
            ).isDisabled(),
          };
          if (candidates === 0)
            assert.equal(receipt.runtime.restartDisabled, true);
          else
            unavailable(
              "safe restart disabled without a current instance",
              "The real runtime read found current candidates; no process was selected or restarted by this module.",
            );
          if (selectedName === "DeepSeek Harness")
            assert.equal(
              await button("启动 DeepSeek Harness").isDisabled(),
              true,
            );
        },
      );
    } else if (phase === "after")
      unavailable(
        "saved supplier, manual profile gate and discovery retry",
        "No current saved provider was produced by the preceding production acceptance.",
      );
    for (const [name, reason] of [
      [
        "multiple installed profile selection",
        "This run has one owned ordinary profile per client; ambiguous production discovery needs a separate multi-profile fixture.",
      ],
      [
        "system browser and portable-directory opener",
        "Production ShellExecute routes launch external processes; this module checks no external opener.",
      ],
      [
        "tray minimize, hide, restore and exit",
        "Requires independently retained HWND/tray icon identity and Win32/UIA observation; maximize/restore alone does not prove tray.",
      ],
      [
        "actual official client launch and safe restart",
        "Requires separately retained official process identity, normal exit and same-profile reopen; no instance is launched here.",
      ],
      [
        "WorkBuddy account, desktop default task model and GUI history",
        "Official account and disposable Windows GUI isolation are required; headless API credentials do not satisfy desktop account prerequisites.",
      ],
    ])
      unavailable(name, reason);
  } catch (error) {
    failure = error;
    receipt.failure = {
      check: activeCheck,
      errorName: error?.name || "Error",
      message:
        "Production surface check failed; private input values are omitted.",
    };
  } finally {
    try {
      if (startedActions && initial) {
        if (await page.getByRole("dialog").count())
          await button("关闭弹窗").click();
        if (await page.locator(".hub-help").count())
          await button("关闭快速上手").click();
        if (manualDraft) {
          await selectAgent(manualDraft.agent);
          if (await button("使用自动探测结果").count()) {
            await setDetails(".hub-profile-settings", true);
            await page
              .getByLabel("原配置目录", { exact: true })
              .fill(manualDraft.directory);
            if (manualDraft.optional !== undefined) {
              await setDetails(".hub-manual-profile .hub-extra-settings", true);
              await page
                .getByLabel("Profile 名称", { exact: true })
                .fill(manualDraft.optional);
            }
            await button("使用自动探测结果").click();
          }
        }
        if (await page.locator("#hub-api-key").inputValue())
          await page.locator("#hub-api-key").fill("");
        if (
          (await page.locator("#hub-api-key").getAttribute("type")) === "text"
        )
          await button("隐藏 API Key").click();
        if (initial.selectedAgent)
          await selectAgent(initial.selectedAgent.replace(/ 官方图标$/u, ""));
        await setDetails(savedDetails, true);
        await page.locator("#hub-provider").selectOption(initial.providerId);
        if (
          !initial.providerId &&
          (await page.locator("#hub-endpoint").inputValue()) !==
            initial.endpoint
        )
          await page.locator("#hub-endpoint").fill(initial.endpoint);
        await page.getByLabel("供应商名称", { exact: true }).fill(initial.name);
        if (initial.providerId && initial.model) {
          const state = await modelTerminal(page);
          assert.equal(state.failure, "");
          assert.ok(state.models.includes(initial.model));
          await page.locator("#hub-model").selectOption(initial.model);
        }
        const theme = await page.evaluate(
          () => document.documentElement.dataset.aeTheme,
        );
        if (theme !== initial.theme)
          await button(
            theme === "dark" ? "切换浅色主题" : "切换深色主题",
          ).click();
        if (
          initialMaximized !== undefined &&
          (await nativeWindowMaximized(page)) !== initialMaximized
        )
          await button(initialMaximized ? "最大化窗口" : "还原窗口").click();
        if (initialMaximized !== undefined)
          assert.equal(await nativeWindowMaximized(page), initialMaximized);
        for (const panel of initial.panels)
          await setDetails(
            panel.className === "hub-extra-settings"
              ? savedDetails
              : "." + panel.className,
            panel.open,
          );
        await poll(
          () => pageState(page),
          (state) => sha(state) === sha(initial),
          "restored public page state",
        );
        receipt.pageRestored = true;
      } else receipt.pageRestored = true;
    } catch (error) {
      receipt.pageRestored = false;
      receipt.restorationFailure =
        "Public page state restoration did not pass; private values are omitted.";
      failure ??= error;
    }
    try {
      if (baseline) {
        const after = await protectedState(readonlyNative);
        receipt.nativeStateBeforeSha256 = sha(baseline);
        receipt.nativeStateAfterSha256 = sha(after);
        assert.equal(
          receipt.nativeStateAfterSha256,
          receipt.nativeStateBeforeSha256,
          "Surface-only actions changed saved native configuration",
        );
        receipt.nativeStoreUnchanged = true;
      }
      assertSurfaceCommands(receipt.observedNativeCommands);
    } catch (error) {
      failure ??= error;
      receipt.preservationFailure =
        "Native command or configuration preservation check failed.";
    }
    page.off("request", onRequest);
    receipt.finishedAt = new Date().toISOString();
    receipt.passedChecks = receipt.checks.length;
  }
  if (!failure) {
    try {
      assertSurfaceReceipt(receipt);
      receipt.passed = true;
    } catch (error) {
      failure = error;
      receipt.failure = {
        check: "surface receipt contract",
        errorName: error?.name || "Error",
        message: "Production surface evidence contract failed.",
      };
    }
  }
  if (failure) {
    failure.surfaceReceipt = receipt;
    throw failure;
  }
  return receipt;
}
