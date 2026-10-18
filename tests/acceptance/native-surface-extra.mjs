import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// These slices use ordinary controls in the already verified Tauri page.
// They do not save providers, launch tools, or open external windows.
const targetIds = ["codex", "claude_desktop", "claude_cli"];
const agentIds = [
  "claude_code",
  "codex",
  "hermes",
  "oh_my_pi",
  "opencode",
  "zcode",
  "workbuddy",
  "deepseek_harness",
];

async function poll(read, predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.fail(`${label} was not observed`);
}

export async function validateSurfaceOwnedRoot(
  input = process.env.AE_NATIVE_EXPECTED_ROOT,
) {
  const workspace = path.resolve(
    fileURLToPath(new URL("../../", import.meta.url)),
  );
  const samePath = (left, right) =>
    path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
  assert.equal(typeof input, "string");
  assert.match(input, /^G:[\\/]/iu);
  const root = path.resolve(input);
  assert.equal(
    input.replaceAll("/", path.sep).toLowerCase(),
    root.toLowerCase(),
  );
  assert.equal(path.basename(root), "portable");
  const uuidRoot = path.dirname(root);
  const id = path.basename(uuidRoot);
  assert.match(id, /^[a-f0-9]{32}$/u);
  assert.ok(
    samePath(
      path.dirname(uuidRoot),
      path.join(workspace, ".cache/native-e2e-sandbox"),
    ),
  );
  for (let current = root; ; current = path.dirname(current)) {
    const info = await fs.lstat(current);
    assert.ok(info.isDirectory() && !info.isSymbolicLink());
    assert.ok(samePath(await fs.realpath(current), current));
    if (path.dirname(current) === current) break;
  }
  const markers = [];
  for (const directory of [uuidRoot, root]) {
    const location = path.join(directory, ".ae-native-e2e-owner.json");
    const info = await fs.lstat(location);
    assert.ok(info.isFile() && !info.isSymbolicLink());
    assert.equal(info.nlink, 1);
    assert.ok(info.size > 0 && info.size <= 8192);
    assert.ok(samePath(await fs.realpath(location), location));
    const bytes = await fs.readFile(location);
    const owner = JSON.parse(bytes.toString("utf8"));
    assert.equal(owner.id, id);
    assert.equal(owner.workspace, workspace);
    assert.equal(
      owner.purpose,
      "AE Switch owned native UI and real tool acceptance",
    );
    markers.push(bytes);
  }
  assert.deepEqual(
    markers[0],
    markers[1],
    "The portable owner marker must be an exact copy of its UUID owner",
  );
  return { root, uuidRoot, id, workspace };
}

async function surfaceContext({ page, invoke }) {
  const { root } = await validateSurfaceOwnedRoot();
  const dataDirectory = path.resolve(root, "data").toLowerCase();
  const button = (name) => page.getByRole("button", { name, exact: true });
  const hubHeading = () =>
    page.getByRole("heading", { name: /你的 Agent，随时就绪/u });

  async function native(command) {
    const result = await invoke(command);
    assert.equal(result.ok, true, `Actual native ${command} must succeed`);
    assert.equal(
      path.resolve(result.result.dataDirectory).toLowerCase(),
      dataDirectory,
      "The surface must belong to this exact owned Rust instance",
    );
    return result.result;
  }
  async function snapshot() {
    assert.equal(
      await page.evaluate(
        () => typeof window.__TAURI_INTERNALS__?.invoke === "function",
      ),
      true,
    );
    const overview = await native("get_overview");
    const hub = await native("agent_hub_overview");
    assert.deepEqual(
      overview.targets.map((target) => target.target).sort(),
      [...targetIds].sort(),
    );
    assert.deepEqual(
      hub.agents.map((agent) => agent.id).sort(),
      [...agentIds].sort(),
    );
    for (const agent of hub.agents)
      assert.equal(
        path.resolve(agent.directory).toLowerCase(),
        path
          .resolve(
            agent.profile?.directory ??
              path.join(root, "data", "agents", agent.id),
          )
          .toLowerCase(),
      );
    return { overview, hub };
  }
  async function hubVisible() {
    await hubHeading().waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0);
  }
  async function returnHub() {
    const back = button("返回 Agent Hub");
    if (await back.isVisible()) await back.click();
    await hubVisible();
  }
  async function openAdvanced() {
    await hubVisible();
    const advanced = page.getByRole("button", {
      name: "高级供应商管理",
      exact: true,
    });
    assert.equal(await advanced.count(), 1);
    await advanced.click();
    await page.getByRole("tab", { name: /^Codex\b/u }).waitFor();
  }
  async function targetCounts(expected) {
    const rows = [];
    const expectedIds = expected.overview.providers
      .map((provider) => provider.id)
      .sort();
    for (const target of targetIds) {
      if (target === "codex") {
        const tab = page.getByRole("tab", { name: /^Codex\b/u });
        await tab.click();
        assert.equal(await tab.getAttribute("aria-selected"), "true");
      } else {
        const tab = page.getByRole("tab", { name: /^Claude Code\b/u });
        await tab.click();
        assert.equal(await tab.getAttribute("aria-selected"), "true");
        const group = page.getByRole("group", {
          name: "Claude 配置目标",
          exact: true,
        });
        const destination = group.getByRole("button", {
          name: target === "claude_desktop" ? "桌面端" : "CLI",
          exact: true,
        });
        await destination.click();
        assert.equal(await destination.getAttribute("aria-pressed"), "true");
      }
      const total = page.locator(".supplier-total");
      await poll(
        () => total.locator(".count").innerText(),
        (value) => Number(value) === expectedIds.length,
        `Actual visible ${target} supplier count`,
      );
      assert.equal(
        await total.getAttribute("aria-label"),
        `已保存 ${expectedIds.length} 个 API 供应商`,
      );
      const renderedIds = await poll(
        () =>
          page
            .locator("li.provider-card [data-provider-name]")
            .evaluateAll((elements) =>
              elements
                .map((element) => element.getAttribute("data-provider-name"))
                .sort(),
            ),
        (value) => JSON.stringify(value) === JSON.stringify(expectedIds),
        `Actual ${target} provider rows match Rust`,
      );
      if (!expectedIds.length)
        await page
          .getByRole("heading", { name: "还没有 API 供应商", exact: true })
          .waitFor();
      rows.push({
        target,
        count: renderedIds.length,
        providerIds: renderedIds,
      });
    }
    assert.deepEqual(
      await snapshot(),
      expected,
      "Navigation must not write Rust state",
    );
    return rows;
  }
  return { snapshot, hubVisible, returnHub, openAdvanced, targetCounts };
}

async function verifyHubReadRecovery(
  { page, invoke, record },
  surface,
  before,
  { cold = false } = {},
) {
  const { root } = await validateSurfaceOwnedRoot();
  const samePath = (left, right) =>
    path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
  const selection = path.join(root, "data/agent-selection.json");
  async function ordinary(location, missing = false) {
    const relative = path.relative(root, location);
    assert.ok(
      !path.isAbsolute(relative) &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`),
    );
    const ancestors = [];
    for (
      let current = path.resolve(location);
      ;
      current = path.dirname(current)
    ) {
      ancestors.push(current);
      if (path.dirname(current) === current) break;
    }
    let entry;
    for (const current of ancestors.reverse()) {
      try {
        entry = await fs.lstat(current);
      } catch (error) {
        if (missing && error.code === "ENOENT") return null;
        throw error;
      }
      assert.ok(
        !entry.isSymbolicLink() && (entry.isFile() || entry.isDirectory()),
      );
      assert.ok(samePath(current, location) || entry.isDirectory());
      if (entry.isFile()) assert.equal(entry.nlink, 1);
      assert.ok(samePath(await fs.realpath(current), current));
    }
    return entry;
  }
  async function ownership() {
    await validateSurfaceOwnedRoot();
    assert.ok((await ordinary(path.dirname(selection))).isDirectory());
  }
  async function readFile(location) {
    const info = await ordinary(location, true);
    if (!info) return null;
    assert.ok(info.isFile() && info.size <= 2 * 1024 * 1024);
    return fs.readFile(location);
  }
  await ownership();
  assert.deepEqual(await surface.snapshot(), before);
  const clientFiles = new Map();
  const protectedPaths = new Set(
    before.overview.targets.flatMap((target) => target.files),
  );
  assert.ok(protectedPaths.size <= 32);
  for (const location of protectedPaths)
    clientFiles.set(location, await readFile(location));
  const original = await readFile(selection);
  assert.ok(original === null || original.length <= 65536);
  const invalid = Buffer.from("{ae-switch-owned-invalid-selection", "utf8");
  const refresh = page
    .locator(".hub-topbar")
    .getByRole("button", { name: "刷新工作台", exact: true });
  const errorPanel = page
    .locator(".hub-notice.error")
    .filter({ hasText: "无法读取本地配置：" });
  const retry = errorPanel.getByRole("button", { name: "重试", exact: true });
  let handle;
  let changed = false;
  let recovered = false;
  let phase = "prepare";
  let failedPhase = null;
  let failure;
  let restorationFailed = false;
  let nativeFailureObserved = false;
  let refreshClicked = false;
  let errorPanelObserved = false;
  let controlsDisabled = false;
  let retryClicked = false;
  let coldReloadPerformed = false;
  let coldFreshDocument = false;
  let coldHubCachedDataAbsent = false;
  let coldPrimaryOverviewSucceeded = false;
  let normalColdReloadPerformed = false;
  let normalColdFreshDocument = false;
  let normalColdOverviewAndHubMatched = false;
  let normalColdObservation;
  let coldSession;
  let coldObserverIdentifier;
  const originalPageUrl = page.url();
  // This document-start script only records bounded DOM observations. It never
  // reads, replaces, wraps, or delays Tauri IPC or React Query operations.
  const coldObservationSource = `(${(() => {
    const observation = {
      documentTimeOrigin: performance.timeOrigin,
      runtimeConnectingObserved: false,
      directoryLoadingObserved: false,
      refreshSpinnerObserved: false,
    };
    const sample = () => {
      const readError = [
        ...document.querySelectorAll(".hub-notice.error"),
      ].some((element) => element.textContent?.includes("无法读取本地配置："));
      if (readError) return;
      observation.runtimeConnectingObserved ||=
        document.querySelector(".hub-runtime")?.textContent?.trim() ===
        "连接内核中";
      observation.directoryLoadingObserved ||=
        document.querySelector(".hub-directory-card p")?.textContent?.trim() ===
        "正在读取便携数据目录…";
      observation.refreshSpinnerObserved ||=
        document.querySelector(".hub-topbar .hub-spinning") !== null;
    };
    const observer = new MutationObserver(sample);
    observer.observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    document.addEventListener("DOMContentLoaded", sample, { once: true });
    window.__aeNativeHubColdRead = {
      observation,
      disconnect: () => observer.disconnect(),
    };
    sample();
  }).toString()})();`;
  async function reloadFreshHub() {
    phase = "cold-reload-read-time-origin";
    const previousTimeOrigin = await page.evaluate(
      () => performance.timeOrigin,
    );
    phase = "cold-reload-navigation";
    await page.reload({ waitUntil: "domcontentloaded" });
    phase = "cold-reload-url";
    assert.equal(page.url(), originalPageUrl);
    phase = "cold-reload-hub-visible";
    await surface.hubVisible();
    phase = "cold-reload-observer-read";
    const observation = await page.evaluate(
      () => window.__aeNativeHubColdRead?.observation,
    );
    phase = "cold-reload-observer-present";
    assert.ok(observation);
    phase = "cold-reload-new-document";
    assert.notEqual(
      observation.documentTimeOrigin,
      previousTimeOrigin,
      "A real new document must recreate the application's QueryClient",
    );
  }
  async function handleIdentity() {
    await ownership();
    const current = await ordinary(selection);
    const retained = await handle.stat();
    assert.ok(
      current.isFile() &&
        retained.isFile() &&
        current.nlink === 1 &&
        retained.nlink === 1,
    );
    assert.ok(
      current.dev === retained.dev && current.ino === retained.ino,
      "Only the retained exact selection file may be changed",
    );
  }
  async function writeRetained(bytes) {
    await handleIdentity();
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.write(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      assert.ok(
        result.bytesWritten > 0,
        "The retained fixture write must advance",
      );
      offset += result.bytesWritten;
    }
    await handle.truncate(bytes.length);
    await handle.sync();
  }
  try {
    await poll(
      () => refresh.isEnabled(),
      Boolean,
      "Hub read fixture refresh is enabled",
    );
    if (cold) {
      phase = "cold-observer";
      coldSession = await page.context().newCDPSession(page);
      // Enable this session's Page lifecycle hooks for older CDP backends.
      await coldSession.send("Page.enable");
      const installed = await coldSession.send(
        "Page.addScriptToEvaluateOnNewDocument",
        { source: coldObservationSource },
      );
      coldObserverIdentifier = installed.identifier;
      assert.ok(coldObserverIdentifier);
    }
    await ownership();
    handle = await fs.open(selection, original === null ? "wx+" : "r+");
    changed = original === null;
    if (original !== null) {
      const current = await handle.readFile();
      assert.ok(
        current.equals(original),
        "The original selection bytes must still match before mutation",
      );
    }
    phase = "inject";
    changed = true;
    await writeRetained(invalid);
    if (cold) {
      phase = "cold-reload-failure";
      await reloadFreshHub();
      coldReloadPerformed = true;
      coldFreshDocument = true;
    }
    phase = "native-failure";
    const rejected = await invoke("agent_hub_overview");
    assert.equal(
      rejected.ok,
      false,
      "The actual Rust Hub read must reject the malformed selection",
    );
    assert.equal(rejected.error?.code, "invalid_state");
    nativeFailureObserved = true;
    phase = "ui-failure";
    if (!cold) {
      await refresh.click();
      refreshClicked = true;
    }
    await errorPanel
      .getByText("无法读取本地配置：Agent 配置状态损坏，请保留数据目录后修复", {
        exact: true,
      })
      .waitFor({ timeout: 15000 });
    await poll(
      () => refresh.isEnabled(),
      Boolean,
      "The failing actual Hub refresh settled",
    );
    assert.equal(await errorPanel.count(), 1);
    errorPanelObserved = true;
    if (cold) {
      assert.equal(
        (await page.locator(".hub-runtime").innerText()).trim(),
        "连接内核中",
      );
      assert.equal(
        (await page.locator(".hub-directory-card p").innerText()).trim(),
        "正在读取便携数据目录…",
      );
      const statistics = await page
        .locator(".hub-overview-strip strong")
        .allTextContents();
      assert.deepEqual(statistics, [
        String(before.hub.agents.length),
        String(before.overview.providers.length),
        "—",
      ]);
      coldHubCachedDataAbsent = true;
      const overview = await invoke("get_overview");
      assert.equal(overview.ok, true);
      assert.deepEqual(overview.result, before.overview);
      coldPrimaryOverviewSucceeded = true;
    }
    assert.equal(
      await page
        .getByRole("button", { name: "仅保存", exact: true })
        .isEnabled(),
      false,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "确认并验证", exact: true })
        .isEnabled(),
      false,
    );
    controlsDisabled = true;
    assert.equal(await retry.isEnabled(), true);
    phase = "restore";
  } catch (error) {
    failure = error;
    failedPhase = phase;
  } finally {
    if (changed) {
      try {
        if (original === null) {
          await handleIdentity();
          const created = await handle.stat();
          await handle.close();
          handle = null;
          const current = await ordinary(selection);
          assert.ok(
            current.dev === created.dev && current.ino === created.ino,
            "Only the exact newly created selection file may be removed",
          );
          await fs.unlink(selection);
        } else await writeRetained(original);
        const restored = await readFile(selection);
        assert.ok(
          original === null ? restored === null : restored?.equals(original),
          "The exact selection bytes or original absence must be restored",
        );
      } catch (error) {
        restorationFailed = true;
        failure ||= error;
        failedPhase ||= "restore";
      }
    }
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        restorationFailed = true;
        failure ||= error;
        failedPhase ||= "close";
      }
    }
  }
  if (changed && !restorationFailed && errorPanelObserved) {
    try {
      phase = "ui-retry";
      await retry.waitFor({ state: "visible", timeout: 15000 });
      await retry.click();
      retryClicked = true;
      const expected = [
        String(before.hub.agents.length),
        String(before.overview.providers.length),
        String(before.hub.agents.filter((agent) => agent.configured).length),
      ];
      await poll(
        async () => ({
          errors: await errorPanel.count(),
          enabled: await refresh.isEnabled(),
          statistics: await page
            .locator(".hub-overview-strip strong")
            .allTextContents(),
        }),
        (value) =>
          value.errors === 0 &&
          value.enabled &&
          JSON.stringify(value.statistics) === JSON.stringify(expected),
        "Actual error-panel retry restored Hub statistics",
      );
      assert.deepEqual(await surface.snapshot(), before);
      if (cold) {
        phase = "normal-cold-reload";
        await reloadFreshHub();
        normalColdReloadPerformed = true;
        normalColdFreshDocument = true;
        await poll(
          async () => ({
            errors: await errorPanel.count(),
            enabled: await refresh.isEnabled(),
            statistics: await page
              .locator(".hub-overview-strip strong")
              .allTextContents(),
          }),
          (value) =>
            value.errors === 0 &&
            value.enabled &&
            JSON.stringify(value.statistics) === JSON.stringify(expected),
          "Fresh normal Hub document read actual Rust counts",
        );
        assert.deepEqual(await surface.snapshot(), before);
        normalColdOverviewAndHubMatched = true;
        normalColdObservation = await page.evaluate(
          () => window.__aeNativeHubColdRead?.observation,
        );
        assert.ok(normalColdObservation);
      }
      for (const [location, bytes] of clientFiles) {
        const current = await readFile(location);
        assert.ok(
          bytes === null ? current === null : current?.equals(bytes),
          "Hub read failure and retry must retain every client configuration file",
        );
      }
      const restored = await readFile(selection);
      assert.ok(
        original === null ? restored === null : restored?.equals(original),
        "UI retry must retain restored selection bytes or absence",
      );
      recovered = true;
    } catch (error) {
      failure ||= error;
      failedPhase ||= phase;
    }
  }
  if (coldSession) {
    try {
      phase = "cold-observer-cleanup";
      if (coldObserverIdentifier)
        await coldSession.send("Page.removeScriptToEvaluateOnNewDocument", {
          identifier: coldObserverIdentifier,
        });
      await page.evaluate(() => {
        window.__aeNativeHubColdRead?.disconnect();
        delete window.__aeNativeHubColdRead;
      });
    } catch (error) {
      failure ||= error;
      failedPhase ||= phase;
    } finally {
      try {
        await coldSession.detach();
      } catch (error) {
        failure ||= error;
        failedPhase ||= "cold-observer-detach";
      }
    }
  }
  await record(
    cold
      ? "native-surface-hub-cold-read-failure-retry"
      : "native-surface-hub-read-failure-retry",
    {
      passed: !failure && recovered,
      actualRustFailureCode: nativeFailureObserved ? "invalid_state" : null,
      actualHubRefreshClicked: refreshClicked,
      actualReadErrorPanelObserved: errorPanelObserved,
      saveAndConfirmDisabled: controlsDisabled,
      actualErrorPanelRetryClicked: retryClicked,
      originalSelectionExisted: original !== null,
      selectionRestored: changed && !restorationFailed,
      providerAndTargetAndAgentConfigurationUnchanged: recovered,
      clientFilesUnchanged: recovered,
      visibleStatisticsRestored: recovered,
      ...(cold
        ? {
            actualColdFailurePageReload: coldReloadPerformed,
            coldFreshDocumentAndQueryCache: coldFreshDocument,
            coldHubCachedDataAbsent,
            coldPrimaryOverviewSucceeded,
            primaryOverviewFailureClaimed: false,
            actualNormalColdPageReload: normalColdReloadPerformed,
            normalColdFreshDocumentAndQueryCache: normalColdFreshDocument,
            normalColdOverviewAndHubMatched,
            normalColdLoadingObserved:
              normalColdObservation?.runtimeConnectingObserved === true ||
              normalColdObservation?.directoryLoadingObserved === true,
            normalColdSpinnerObserved:
              normalColdObservation?.refreshSpinnerObserved === true,
            loadingObservationRequiredForPass: false,
            documentStartObservationOnly: true,
          }
        : {}),
      failedPhase,
      failureDiagnostic: failure
        ? {
            name: String(failure.name ?? "Error").slice(0, 80),
            code: failure.code ?? null,
            message: String(failure.message ?? "").slice(0, 600),
          }
        : null,
      errorCategory: failure
        ? restorationFailed
          ? "selection_restore_failed"
          : "hub_read_recovery_failed"
        : null,
      noMockedInvoke: true,
    },
  );
  if (failure)
    throw new Error(
      restorationFailed
        ? "Owned Hub selection restoration failed"
        : "Owned Hub read failure and UI retry acceptance failed",
    );
}

export async function surfaceEmptyBeforeSeed(context) {
  const { page, record } = context;
  const surface = await surfaceContext(context);
  await surface.hubVisible();
  const before = await surface.snapshot();
  assert.equal(
    before.overview.providers.length,
    0,
    "Call this slice before any provider seed",
  );
  let ownDialog = null;
  try {
    await surface.openAdvanced();
    const counts = await surface.targetCounts(before);
    await page.getByRole("tab", { name: /^Codex\b/u }).click();
    const empty = page.locator(".empty-state").filter({
      has: page.getByRole("heading", {
        name: "还没有 API 供应商",
        exact: true,
      }),
    });
    const add = empty.getByRole("button", {
      name: "添加第一个供应商",
      exact: true,
    });
    assert.equal(await add.count(), 1);
    await add.click();
    ownDialog = page.getByRole("dialog", { name: "添加供应商", exact: true });
    await ownDialog.waitFor();
    assert.equal(await ownDialog.locator("#baseUrl").inputValue(), "");
    assert.equal(await ownDialog.locator("#apiKey").inputValue(), "");
    await ownDialog.getByRole("button", { name: "取消", exact: true }).click();
    await ownDialog.waitFor({ state: "hidden" });
    await poll(
      () => add.evaluate((element) => element === document.activeElement),
      Boolean,
      "Empty-list trigger regains focus",
    );
    assert.deepEqual(await surface.snapshot(), before);
    await record("native-surface-empty-add-cancel", {
      passed: true,
      actualEmptyListButtonClicked: true,
      blankDraftShown: true,
      cancellationAndFocusReturnVerified: true,
      providerAndClientAndAgentStateUnchanged: true,
      targetCounts: counts,
    });
  } finally {
    if (ownDialog && (await ownDialog.isVisible()))
      await ownDialog
        .getByRole("button", { name: "取消", exact: true })
        .click();
    await surface.returnHub();
  }
}

export async function surfaceHubAtEnd(context) {
  const { page, record } = context;
  const surface = await surfaceContext(context);
  await surface.hubVisible();
  const before = await surface.snapshot();
  const configured = before.hub.agents.filter(
    (agent) => agent.configured,
  ).length;
  const expectedStatistics = [
    String(before.hub.agents.length),
    String(before.overview.providers.length),
    String(configured),
  ];
  const statistics = () =>
    page.locator(".hub-overview-strip strong").allTextContents();
  const refresh = page
    .locator(".hub-topbar")
    .getByRole("button", { name: "刷新工作台", exact: true });
  await poll(() => refresh.isEnabled(), Boolean, "Hub refresh is enabled");
  await refresh.click();
  await poll(
    async () => ({
      enabled: await refresh.isEnabled(),
      statistics: await statistics(),
    }),
    (value) =>
      value.enabled &&
      JSON.stringify(value.statistics) === JSON.stringify(expectedStatistics),
    "Actual Hub refresh settled with Rust counts",
  );
  assert.deepEqual(await surface.snapshot(), before);
  await record("native-surface-hub-refresh-counts", {
    passed: true,
    actualHubRefreshClicked: true,
    agentCount: before.hub.agents.length,
    providerCount: before.overview.providers.length,
    configuredCount: configured,
    visibleStatisticsMatchRust: true,
    providerAndClientAndAgentStateUnchanged: true,
  });
  await verifyHubReadRecovery(context, surface, before);
  await verifyHubReadRecovery(context, surface, before, { cold: true });
  await surface.openAdvanced();
  try {
    const counts = await surface.targetCounts(before);
    await record("native-surface-target-counts", {
      passed: true,
      targets: counts,
      positiveProviderCountObserved: before.overview.providers.length > 0,
      countLabelsAndRenderedIdsMatchRust: true,
      providerAndClientAndAgentStateUnchanged: true,
    });
  } finally {
    await surface.returnHub();
  }

  const originalViewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    deviceScaleFactor: devicePixelRatio,
  }));
  const previousPlaywrightViewport = page.viewportSize();
  const session = await page.context().newCDPSession(page);
  let metricsAttempted = false;
  let narrowPassed = false;
  try {
    metricsAttempted = true;
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: 740,
      height: Math.max(600, originalViewport.height),
      deviceScaleFactor: originalViewport.deviceScaleFactor,
      mobile: false,
    });
    await poll(
      () => page.evaluate(() => innerWidth),
      (width) => width === 740,
      "Native WebView CDP CSS emulation support",
    );
    const topbarAdvanced = page
      .locator(".hub-topbar")
      .getByRole("button", { name: "高级供应商管理", exact: true });
    assert.equal(await topbarAdvanced.count(), 1);
    assert.match(
      await topbarAdvanced.getAttribute("class"),
      /hub-mobile-tools/u,
    );
    assert.equal(await topbarAdvanced.isVisible(), true);
    const hit = await topbarAdvanced.evaluate((element) => {
      const rectangle = element.getBoundingClientRect();
      const x = rectangle.x + rectangle.width / 2;
      const y = rectangle.y + rectangle.height / 2;
      const target = document.elementFromPoint(x, y);
      return {
        width: innerWidth,
        x,
        y,
        withinViewport: x >= 0 && x < innerWidth && y >= 0 && y < innerHeight,
        ownCenterHit:
          !!target && (target === element || element.contains(target)),
      };
    });
    assert.equal(
      hit.withinViewport,
      true,
      "The actual narrow topbar button must fit the CSS viewport",
    );
    assert.equal(hit.ownCenterHit, true);
    await topbarAdvanced.click();
    await page.getByRole("tab", { name: /^Codex\b/u }).waitFor();
    assert.deepEqual(await surface.snapshot(), before);
    await surface.returnHub();
    narrowPassed = true;
    await record("native-surface-narrow-topbar-advanced", {
      passed: true,
      actualTopbarButtonClicked: true,
      advancedAndHubNavigationVerified: true,
      cssEmulationSupported: true,
      cssEmulation: true,
      osWindowResized: false,
      physicalDesktopMinimumWidth: 760,
      cssViewportWidth: 740,
      hit,
      providerAndClientAndAgentStateUnchanged: true,
    });
  } catch (error) {
    await record("native-surface-narrow-topbar-advanced", {
      passed: false,
      cssEmulation: true,
      osWindowResized: false,
      cssViewportWidth: 740,
      error: String(error.message ?? error),
    });
    throw error;
  } finally {
    try {
      await surface.returnHub();
    } finally {
      try {
        if (metricsAttempted) {
          await session.send("Emulation.clearDeviceMetricsOverride");
          if (previousPlaywrightViewport)
            await page.setViewportSize(previousPlaywrightViewport);
          await poll(
            () =>
              page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
            (value) =>
              Math.abs(value.width - originalViewport.width) <= 1 &&
              Math.abs(value.height - originalViewport.height) <= 1,
            "Original CSS metrics restored",
          );
          await record("native-surface-css-metrics-restored", {
            passed: true,
            narrowPassed,
            originalViewport,
            cssEmulation: true,
            osWindowResized: false,
          });
        }
      } finally {
        await session.detach();
      }
    }
  }
}
