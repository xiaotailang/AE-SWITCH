import assert from "node:assert/strict";
import { createServer } from "node:http";

// Called only after native-ui.mjs has verified the owned root and executable.
// No invocation interception, DOM edits, process launch or external windows.
const syntheticKey = "ae-switch-synthetic-invalid-qa-key";
const invalidEndpoint = "http://127.0.0.1:9/v1";
const syntheticModel = "claude-sonnet-4-6";

async function native(invoke, command, args = {}) {
  const result = await invoke(command, args);
  assert.ok(result.ok, `${command} must succeed in the verified native store`);
  return result.result;
}
async function waitUntil(read, predicate, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.fail(`${label} was not observed`);
}

// Observe real Tauri transport without replacing invoke or reading request payloads.
export async function waitForHubDiscovery({
  page,
  record,
  agentId = null,
  phase,
  retryFailure = false,
  receipt = {},
}) {
  Object.assign(receipt, {
    agentId,
    phase,
    passed: false,
    retryAllowed: retryFailure,
    maxRetryClicks: retryFailure ? 1 : 0,
    retryClicked: false,
    actualRustRequestObserved: false,
    nativeRequestCount: 0,
    nativeResponseObserved: false,
    supplierConnectTimeoutMs: 8000,
    supplierTimeoutPolicyChanged: false,
    uiWaitTimeoutMs: 60000,
    fallbackModelUsed: false,
  });
  const waitTerminal = async () => {
    await page.waitForFunction(
      () => {
        const model = document.getElementById("hub-model");
        const status = document.querySelector(".hub-model-status");
        const loading =
          status?.textContent.includes("正在识别协议并获取模型列表");
        return (
          !loading &&
          (!!document.querySelector(".hub-model-status.failure") ||
            (!!model &&
              !model.disabled &&
              [...model.options].some((option) => option.value)))
        );
      },
      null,
      { timeout: 60000 },
    );
    return page.evaluate(() => ({
      failure:
        document
          .querySelector(".hub-model-status.failure")
          ?.textContent.trim() ?? "",
      models: [...(document.getElementById("hub-model")?.options ?? [])]
        .map((option) => option.value)
        .filter(Boolean),
    }));
  };
  const nativeRequests = [];
  const isDiscoveryRequest = (request) => {
    try {
      const url = new URL(request.url());
      return (
        request.method() === "POST" &&
        ((["http:", "https:"].includes(url.protocol) &&
          url.hostname === "ipc.localhost") ||
          (url.protocol === "ipc:" && url.hostname === "localhost")) &&
        url.pathname === "/discover_provider_connection"
      );
    } catch {
      return false;
    }
  };
  const onRequest = (request) => {
    if (isDiscoveryRequest(request)) {
      nativeRequests.push(request);
      receipt.nativeRequestCount = nativeRequests.length;
      receipt.actualRustRequestObserved = true;
    }
  };
  try {
    let state = await waitTerminal();
    if (state.failure && retryFailure) {
      receipt.failureBeforeRetry = state.failure;
      const refresh = page.getByRole("button", {
        name: "同步模型",
        exact: true,
      });
      assert.equal(
        await refresh.isEnabled(),
        true,
        "Never retry a loading discovery query",
      );
      page.on("request", onRequest);
      // Arm before clicking so even a fast native response belongs to this retry.
      const responsePromise = page
        .waitForResponse((response) => isDiscoveryRequest(response.request()), {
          timeout: 60000,
        })
        .then(
          (response) => ({ response }),
          (error) => ({ error }),
        );
      await refresh.click();
      receipt.retryClicked = true;
      await record("native-hub-discovery-retry-clicked", { ...receipt });
      const observed = await responsePromise;
      assert.ok(
        observed.response &&
          nativeRequests.includes(observed.response.request()),
        "The sync button retry must produce an actual native discovery request and response",
      );
      assert.equal(
        nativeRequests.length,
        1,
        "One sync click must start one native discovery request",
      );
      receipt.nativeResponseObserved = true;
      receipt.nativeResponse =
        await observed.response.headerValue("Tauri-Response");
      assert.ok(
        ["ok", "error"].includes(receipt.nativeResponse),
        "Only a Tauri Rust IPC response can prove discovery",
      );
      if (receipt.nativeResponse === "ok") {
        const result = await observed.response.json();
        receipt.nativeModels = result.models.map((model) => model.id);
        receipt.nativeSyncedAt = result.syncedAt;
      }
      state = await waitTerminal();
      if (!state.failure) {
        assert.equal(
          receipt.nativeResponse,
          "ok",
          "A failed Rust response must not become UI success",
        );
        assert.ok(
          state.models.every((model) => receipt.nativeModels.includes(model)),
          "UI options must come from this actual native discovery response",
        );
      }
    }
    assert.equal(
      state.failure,
      "",
      `Real supplier discovery failed: ${state.failure}`,
    );
    assert.ok(
      state.models.length > 0,
      "Real supplier discovery must return usable models",
    );
    receipt.models = state.models;
    receipt.passed = true;
    return state.models;
  } catch (error) {
    receipt.failure = String(error.message ?? error);
    throw error;
  } finally {
    page.off("request", onRequest);
    await record("native-hub-discovery-finished", { ...receipt });
  }
}
const viewport = (page) =>
  page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    outerWidth,
    outerHeight,
  }));

export function assertQuickStartConfigurationContract(steps, notes) {
  const normalize = (text) => {
    assert.equal(typeof text, "string");
    return text.replace(/\s+/gu, "");
  };
  assert.equal(steps.length, 3);
  const normalizedSteps = steps.map(normalize);
  const normalizedNotes = notes.map(normalize).join("\n");
  for (const phrase of [
    "自动探测已安装的客户端",
    "API地址和密钥",
    "获取实际模型",
  ])
    assert.ok(
      normalizedSteps[0].includes(phrase),
      `Quickstart must explain ${phrase}`,
    );
  for (const phrase of [
    "客户端与原配置目录",
    "选择模型",
    "确认并验证",
    "存在多个目录时需要选择",
  ])
    assert.ok(
      normalizedSteps[1].includes(phrase),
      `Quickstart must explain ${phrase}`,
    );
  for (const phrase of [
    "写入必要连接字段",
    "验证真实工具",
    "已运行的客户端需要重启加载",
    "原会话与历史继续保留",
  ])
    assert.ok(
      normalizedSteps[2].includes(phrase),
      `Quickstart must explain ${phrase}`,
    );
  for (const phrase of [
    "客户端由你安装",
    "不附带客户端本体",
    "配置使用本地兼容服务时",
    "保持AESwitch后台运行",
  ])
    assert.ok(
      normalizedNotes.includes(phrase),
      `Quickstart must explain ${phrase}`,
    );
  return true;
}

async function quickStart(page, trigger, mode, record) {
  await trigger.focus();
  assert.ok(
    await trigger.evaluate((element) => element === document.activeElement),
  );
  await trigger.press("Enter");
  const help = page.locator(".hub-help");
  await help.waitFor();
  assert.equal(await trigger.getAttribute("aria-expanded"), "true");
  assert.equal(await help.locator("li").count(), 3);
  assertQuickStartConfigurationContract(
    await help.locator("li").allTextContents(),
    await help.locator("p").allTextContents(),
  );
  const heading = help.getByRole("heading", {
    name: "三步接入你的 Agent",
    exact: true,
  });
  assert.ok(
    await heading.evaluate((element) => element === document.activeElement),
    "Opening Quickstart must focus its heading",
  );
  await page.keyboard.press("Escape");
  await help.waitFor({ state: "hidden" });
  const escapeFocusReturned = await trigger.evaluate(
    (element) => element === document.activeElement,
  );
  assert.equal(escapeFocusReturned, true);
  await trigger.press("Enter");
  await help.waitFor();
  await help.getByRole("button", { name: "关闭快速上手", exact: true }).click();
  await help.waitFor({ state: "hidden" });
  const closeFocusReturned = await trigger.evaluate(
    (element) => element === document.activeElement,
  );
  assert.equal(closeFocusReturned, true);
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  await record("native-hub-quickstart-extra", {
    mode,
    keyboardActivation: true,
    guideHeadingFocused: true,
    threeStepsVisible: true,
    existingClientConfigurationExplained: true,
    realModelDiscoveryExplained: true,
    restartAndHistoryPreservationExplained: true,
    clientsNotBundledExplained: true,
    localBridgeBackgroundRequirementExplained: true,
    explicitClosePassed: true,
    escapeDismissSupported: true,
    escapeFocusReturned,
    closeFocusReturned,
  });
}

async function sampleDiscoveryBusy(page) {
  return page.evaluate(async () => {
    const samples = [];
    const sample = () => {
      const status = document.querySelector(".hub-model-status");
      if (!status?.textContent.includes("正在识别协议并获取模型列表")) return;
      samples.push({
        confirmDisabled:
          document.querySelector(".hub-form-actions .primary")?.disabled ===
          true,
        saveDisabled:
          document.querySelector(".hub-form-actions .secondary")?.disabled ===
          true,
        modelDisabled: document.getElementById("hub-model")?.disabled === true,
        refreshDisabled:
          document.querySelector(".hub-model-label button")?.disabled === true,
        endpointDisabled:
          document.getElementById("hub-endpoint")?.disabled === true,
        keyDisabled: document.getElementById("hub-api-key")?.disabled === true,
      });
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.getElementById("root"), {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
    });
    try {
      sample();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      sample();
    } finally {
      observer.disconnect();
    }
    return samples;
  });
}

export async function verifyHubExtras({ page, invoke, record }) {
  const original = await viewport(page);
  const overview = await native(invoke, "get_overview");
  assert.deepEqual(
    overview.providers,
    [],
    "Hub extras require the already verified fresh native store",
  );
  const endpoint = page.locator("#hub-endpoint");
  const key = page.locator("#hub-api-key");
  const providerSelect = page.locator("#hub-provider");
  const extraSettings = page.locator(".hub-extra-settings");
  const name = extraSettings.locator("input");
  const initial = {
    endpoint: await endpoint.inputValue(),
    provider: await providerSelect.inputValue(),
    name: await name.inputValue(),
    detailsOpen: await extraSettings.evaluate((element) => element.open),
  };
  assert.equal(
    await key.inputValue(),
    "",
    "Real or stored credentials must not enter this synthetic helper",
  );
  assert.equal(initial.provider, "");
  let server;
  let ownedProvider;
  let modelRequests = 0;
  try {
    await quickStart(
      page,
      page
        .locator(".hub-sidebar-bottom")
        .getByRole("button", { name: "快速上手", exact: true }),
      "native-sidebar",
      record,
    );
    let mobileApplied = false;
    try {
      try {
        await page.setViewportSize({ width: 680, height: 600 });
        const measured = await viewport(page);
        mobileApplied = measured.width === 680 && measured.height === 600;
      } catch {
        /* Native CDP may reject emulation; record that branch. */
      }
      if (mobileApplied)
        await quickStart(
          page,
          page
            .locator(".hub-topbar")
            .getByRole("button", { name: "快速上手", exact: true }),
          "cdp-emulated-mobile-680x600",
          record,
        );
      else
        await record("native-hub-quickstart-mobile", {
          measured: false,
          supported: false,
          osWindowResized: false,
        });
    } finally {
      const measured = await viewport(page);
      if (
        measured.width !== original.width ||
        measured.height !== original.height
      )
        await page.setViewportSize({
          width: original.width,
          height: original.height,
        });
    }
    await key.fill(syntheticKey);
    const show = page.getByRole("button", {
      name: "显示 API Key",
      exact: true,
    });
    await show.click();
    assert.equal(await key.getAttribute("type"), "text");
    assert.ok(
      await key.evaluate(
        (element, expected) => element.value === expected,
        syntheticKey,
      ),
    );
    await page
      .getByRole("button", { name: "隐藏 API Key", exact: true })
      .click();
    assert.equal(await key.getAttribute("type"), "password");
    await key.fill("");
    await record("native-hub-synthetic-key-toggle", {
      shownThenHidden: true,
      finalPasswordType: true,
      syntheticOnly: true,
      screenshotsTaken: false,
    });
    if (!(await extraSettings.evaluate((element) => element.open)))
      await extraSettings.locator("summary").click();
    await name.fill("Synthetic cancelled Hub draft");
    assert.equal(
      await page
        .getByRole("button", { name: "仅保存", exact: true })
        .isEnabled(),
      false,
    );
    await name.fill("");
    await extraSettings.locator("summary").click();
    assert.deepEqual((await native(invoke, "get_overview")).providers, []);
    await record("native-hub-name-draft", {
      expansionAndInputPassed: true,
      clearedAndCollapsedWithoutWrite: true,
      explicitCancelAvailable: false,
      gap: "Hub's optional name field has no dedicated cancel control; the draft was explicitly cleared.",
    });
    server = createServer((request, response) => {
      if (
        request.method === "GET" &&
        request.url === "/v1/models" &&
        request.headers.authorization === `Bearer ${syntheticKey}`
      ) {
        modelRequests++;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            object: "list",
            data: [
              {
                id: syntheticModel,
                object: "model",
                owned_by: "native-hub-extra-synthetic",
              },
            ],
          }),
        );
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const fixtureEndpoint = `http://127.0.0.1:${server.address().port}/v1`;
    await endpoint.fill(fixtureEndpoint);
    await key.fill(syntheticKey);
    await waitUntil(
      () => page.locator("#hub-model").isEnabled(),
      (value) => value,
      "Synthetic native UI model discovery",
      45000,
    );
    await page.locator("#hub-model").selectOption(syntheticModel);
    if (!(await extraSettings.evaluate((element) => element.open)))
      await extraSettings.locator("summary").click();
    await name.fill("Synthetic Hub extras receipt");
    await page.getByRole("button", { name: "仅保存", exact: true }).click();
    await page
      .getByText("供应商已保存。选择已安装的 Agent，可继续配置端点。", {
        exact: true,
      })
      .waitFor({ timeout: 45000 });
    const saved = await native(invoke, "get_overview");
    ownedProvider = saved.providers.find(
      (item) =>
        item.name === "Synthetic Hub extras receipt" &&
        item.baseUrl === fixtureEndpoint,
    )?.id;
    assert.equal(saved.providers.length, 1);
    assert.equal(saved.providers[0].name, "Synthetic Hub extras receipt");
    assert.equal(saved.providers[0].baseUrl, fixtureEndpoint);
    assert.ok(ownedProvider);
    assert.ok(modelRequests > 0);
    await page
      .locator(".hub-notice")
      .getByRole("button", { name: "关闭提示", exact: true })
      .click();
    await page.locator(".hub-notice").waitFor({ state: "hidden" });
    await record("native-hub-notice-close", {
      actualNativeSaveNotice: true,
      ordinaryClosePassed: true,
      syntheticProviderOnly: true,
      actualRustModelRequests: modelRequests,
    });
    await endpoint.fill(invalidEndpoint);
    await key.fill(syntheticKey);
    await page.locator(".hub-model-status.failure").waitFor({ timeout: 45000 });
    const sampling = sampleDiscoveryBusy(page);
    await page.locator(".hub-model-label button").click();
    // Ordinary keyboard attempts cannot bypass the disabled submit control.
    await endpoint.press("Enter");
    await endpoint.press("Enter");
    const busySamples = await sampling;
    await page.locator(".hub-model-status.failure").waitFor({ timeout: 45000 });
    for (const sample of busySamples) {
      assert.equal(sample.confirmDisabled, true);
      assert.equal(sample.saveDisabled, true);
      assert.equal(sample.modelDisabled, true);
      assert.equal(sample.refreshDisabled, true);
    }
    assert.equal(await page.locator("#hub-model").inputValue(), "");
    assert.equal(
      await page
        .locator("#hub-model option")
        .evaluateAll(
          (options) => options.filter((option) => option.value).length,
        ),
      0,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "确认并验证", exact: true })
        .isEnabled(),
      false,
    );
    assert.equal(await page.locator(".hub-probe-status.passed").count(), 0);
    const afterFailure = await native(invoke, "get_overview");
    assert.deepEqual(
      afterFailure.providers,
      saved.providers,
      "Invalid refresh and repeated Enter must not commit the draft or duplicate providers",
    );
    await record("native-hub-manual-invalid-refresh", {
      realRustClosedPortFailure: true,
      cachedModelDiscarded: true,
      confirmDisabled: true,
      repeatedKeyboardSubmitNoWrites: true,
      busyObserved: busySamples.length > 0,
      busySamples,
      gap: busySamples.length
        ? "During model discovery endpoint/key remain editable so changing inputs can supersede the request."
        : "The closed-port request finished before the sampling window observed a busy DOM state.",
    });
  } finally {
    await providerSelect.selectOption("").catch(() => {});
    if (
      await page
        .getByRole("button", { name: "隐藏 API Key", exact: true })
        .count()
    )
      await page
        .getByRole("button", { name: "隐藏 API Key", exact: true })
        .click();
    await key.fill("");
    await endpoint.fill(initial.endpoint);
    if (!(await extraSettings.evaluate((element) => element.open)))
      await extraSettings.locator("summary").click();
    await name.fill(initial.name);
    if (
      (await extraSettings.evaluate((element) => element.open)) !==
      initial.detailsOpen
    )
      await extraSettings.locator("summary").click();
    if (ownedProvider)
      await native(invoke, "delete_provider", { providerId: ownedProvider });
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await page.getByRole("button", { name: "刷新工作台", exact: true }).click();
    assert.deepEqual(
      (await native(invoke, "get_overview")).providers,
      overview.providers,
    );
    assert.equal(await key.inputValue(), "");
    assert.equal(await key.getAttribute("type"), "password");
    await record("native-hub-extras-restored", {
      providerStoreRestored: true,
      syntheticProviderRemoved: true,
      keyClearedAndPassword: true,
      originalDraftRestored: true,
    });
  }
}

export function assertExistingRevalidationScope(
  agent,
  probe,
  current,
  scopeText,
) {
  if (
    !agent.profile &&
    agent.profileMode !== "existing" &&
    agent.mode !== "existing"
  )
    return false;
  assert.ok(agent.profile && typeof agent.profile === "object");
  assert.equal(probe.profileMode, "existing");
  assert.equal(probe.clientSurface, "headless-cli");
  assert.equal(probe.verificationScope, "headless_tool_write_read");
  assert.equal(probe.desktopGuiVerified, false);
  assert.equal(probe.desktopDefaultSelectionVerified, false);
  const explicitModel = agent.id === "workbuddy";
  assert.equal(probe.explicitModelArgument, explicitModel);
  assert.equal(probe.nativeDefaultModelVerified, !explicitModel);
  assert.deepEqual(
    current.profile,
    agent.profile,
    "Revalidation must retain the original selected profile",
  );
  assert.equal(
    current.directory,
    agent.directory,
    "Revalidation must retain the original configuration directory",
  );
  assert.equal(
    scopeText,
    explicitModel
      ? "本次通过命令行入口并显式指定模型；桌面界面与默认模型选择尚未验证。"
      : "原配置的默认模型已用于本次命令行验证；桌面界面与已有会话尚未验证。",
    "The actual success card must show the verified scope and its remaining limits",
  );
  return true;
}

export async function verifyHubRevalidation({
  page,
  invoke,
  record,
  agentId = "claude_code",
  readCurrentProbe,
}) {
  assert.equal(typeof readCurrentProbe, "function");
  const overview = await native(invoke, "agent_hub_overview");
  const agent = overview.agents.find((item) => item.id === agentId);
  assert.ok(agent?.configured && agent.providerId && agent.model);
  const button = page
    .getByRole("navigation", { name: "选择 Agent", exact: true })
    .getByRole("button")
    .filter({
      has: page.getByRole("img", {
        name: `${agent.name} 官方图标`,
        exact: true,
      }),
    });
  await button.scrollIntoViewIfNeeded();
  await button.click();
  await page.getByRole("heading", { name: agent.name, exact: true }).waitFor();
  if ((await page.locator("#hub-provider").inputValue()) !== agent.providerId)
    await page.locator("#hub-provider").selectOption(agent.providerId);
  const receipt = {
    id: agentId,
    model: agent.model,
    providerId: agent.providerId,
    validationKind: "separate-native-ui-revalidation",
    passed: false,
    probe: null,
    discovery: {},
  };
  try {
    await waitForHubDiscovery({
      page,
      record,
      agentId,
      phase: "separate-tool-revalidation",
      retryFailure: true,
      receipt: receipt.discovery,
    });
    await page.locator("#hub-model").selectOption(agent.model);
    assert.equal(await page.locator("#hub-api-key").inputValue(), "");
    assert.equal(
      await readCurrentProbe(),
      null,
      "A retry must not reuse a prior receipt",
    );
    await page
      .getByRole("button", { name: "重新验证工具", exact: true })
      .click();
    await page
      .getByText("正在调用工具验证写入与读取…", { exact: true })
      .waitFor({ timeout: 60000 });
    for (const selector of [
      "#hub-provider",
      "#hub-endpoint",
      "#hub-api-key",
      "#hub-model",
      ".hub-test-button",
      ".hub-form-actions .primary",
      ".hub-form-actions .secondary",
    ])
      assert.equal(
        await page.locator(selector).isEnabled(),
        false,
        "Native tool verification must lock form controls",
      );
    assert.equal(await page.locator(".hub-probe-status.passed").count(), 0);
    receipt.busyControlsLocked = true;
    await page.waitForFunction(
      () =>
        !document.getElementById("hub-provider")?.disabled &&
        !!document.querySelector(".hub-verification-result, .hub-notice.error"),
      null,
      { timeout: 210000 },
    );
    receipt.probe = await readCurrentProbe();
    const probe = receipt.probe;
    assert.ok(probe);
    assert.equal(probe.ok, true);
    assert.equal(probe.toolVerified, true);
    assert.equal(probe.validationScope, "tool");
    assert.equal(probe.stage, "verified");
    assert.equal(probe.model, agent.model);
    for (const flag of [
      "writeObserved",
      "readObserved",
      "readbackMarkerObserved",
      "assistantMarkerObserved",
      "fileMatchesMarker",
      "processSucceeded",
    ])
      assert.equal(
        probe.evidence?.[flag],
        true,
        `Retry must independently prove ${flag}`,
      );
    if (agentId === "deepseek_harness") {
      assert.equal(probe.evidence?.terminalCompletionRequired, true);
      assert.equal(probe.evidence?.terminalCompletedObserved, true);
    }
    assert.equal(probe.cleanup?.succeeded, true);
    assert.equal(probe.cleanup?.removed, true);
    assert.equal(probe.cleanup?.scope, "owned-uuid-verification-directory");
    assert.match(
      await page.locator(".hub-probe-status.passed").innerText(),
      /工具写读验证通过/u,
    );
    assert.match(
      await page.locator(".hub-verification-cleanup").innerText(),
      /验证临时文件已清理/u,
    );
    const current = (await native(invoke, "agent_hub_overview")).agents.find(
      (item) => item.id === agentId,
    );
    assert.equal(current.model, agent.model);
    assert.equal(current.providerId, agent.providerId);
    if (
      agent.profile ||
      agent.profileMode === "existing" ||
      agent.mode === "existing"
    ) {
      const scope = page.locator(".hub-verification-scope");
      assert.equal(await scope.count(), 1);
      assert.equal(await scope.isVisible(), true);
      receipt.visibleVerificationScope = (await scope.innerText()).trim();
      receipt.existingScopeVerified = assertExistingRevalidationScope(
        agent,
        probe,
        current,
        receipt.visibleVerificationScope,
      );
    }
    assert.equal(await page.locator("#hub-api-key").inputValue(), "");
    receipt.passed = true;
  } catch (error) {
    receipt.failure = String(error.message ?? error);
    receipt.probe ??= await readCurrentProbe().catch(() => null);
  }
  await record("native-hub-real-revalidation", receipt);
  assert.equal(
    receipt.passed,
    true,
    "The separate real native tool retry must independently pass",
  );
  return receipt;
}
