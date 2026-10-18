import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { validateSurfaceOwnedRoot } from "./native-surface-extra.mjs";

const execute = promisify(execFile);
const helper = fileURLToPath(
  new URL("./native-window-owned.ps1", import.meta.url),
);
const trayHelper = fileURLToPath(
  new URL("./native-tray-owned.ps1", import.meta.url),
);

export async function verifyOwnedWindow({
  page,
  invoke,
  record,
  verifySidebarLayout,
}) {
  const { id: rootId } = await validateSurfaceOwnedRoot();
  const pid = process.env.AE_NATIVE_QA_PID;
  assert.match(pid ?? "", /^[1-9]\d*$/u);
  assert.ok(process.env.AE_NATIVE_QA_STARTED_AT);
  const powershell = path.join(
    process.env.SystemRoot,
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  );
  async function windowState(
    action = "state",
    width = 1120,
    height = 780,
    dragPoint,
  ) {
    const { stdout } = await execute(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        helper,
        "-OwnedProcessId",
        pid,
        "-OwnedRoot",
        process.env.AE_NATIVE_EXPECTED_ROOT,
        "-ExpectedSha256",
        process.env.AE_NATIVE_QA_SHA256,
        "-ExpectedStartedAt",
        process.env.AE_NATIVE_QA_STARTED_AT,
        "-Action",
        action,
        "-ClientWidth",
        String(width),
        "-ClientHeight",
        String(height),
        "-OuterWidth",
        String(width),
        "-OuterHeight",
        String(height),
        ...(dragPoint
          ? [
              "-CssX",
              String(dragPoint.x),
              "-CssY",
              String(dragPoint.y),
              "-CssViewportWidth",
              String(dragPoint.viewport.width),
              "-CssViewportHeight",
              String(dragPoint.viewport.height),
            ]
          : []),
      ],
      { env: process.env, windowsHide: true, timeout: 20000, maxBuffer: 65536 },
    );
    const result = JSON.parse(stdout.trim());
    assert.equal(result.pid, Number(pid));
    assert.equal(result.verifiedOwnedIdentity, true);
    return result;
  }
  async function restoreOwnedWindow(reason) {
    const nativePowerShell = process.env.AE_NATIVE_PWSH_EXE;
    assert.ok(nativePowerShell && path.isAbsolute(nativePowerShell));
    assert.equal(path.basename(nativePowerShell).toLowerCase(), "pwsh.exe");
    const receiptPath = path.join(
      process.env.AE_NATIVE_EXPECTED_ROOT,
      "window-tray-restore.json",
    );
    const { stdout } = await execute(
      nativePowerShell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        trayHelper,
        "-OwnedProcessId",
        pid,
        "-OwnedRoot",
        process.env.AE_NATIVE_EXPECTED_ROOT,
        "-ExpectedSha256",
        process.env.AE_NATIVE_QA_SHA256,
        "-ExpectedStartedAt",
        process.env.AE_NATIVE_QA_STARTED_AT,
        "-ReportPath",
        receiptPath,
        "-RestoreOwnedOnly",
      ],
      {
        env: process.env,
        windowsHide: true,
        timeout: 45000,
        maxBuffer: 262144,
      },
    );
    const result = JSON.parse(stdout.trim());
    await record("native-owned-window-tray-restore-setup", {
      reason,
      nativeReceipt: result,
      setupOnly: true,
      traySuitePassed: false,
    });
    assert.equal(result.mode, "RestoreOwnedOnly");
    assert.equal(result.setupOnly, true);
    assert.equal(result.passed, false);
    assert.equal(result.traySuitePassed, false);
    assert.equal(result.restored, true);
    assert.equal(result.pid, Number(pid));
    assert.equal(result.root, process.env.AE_NATIVE_EXPECTED_ROOT);
    assert.equal(result.id, rootId);
    assert.equal(result.sha256, process.env.AE_NATIVE_QA_SHA256);
    assert.equal(result.startedAt, process.env.AE_NATIVE_QA_STARTED_AT);
    assert.equal(result.receiptPath, receiptPath);
    assert.equal(result.verifiedOwnedIdentity, true);
    assert.equal(result.actualInputSource, "owned-tray-SendInput-double-click");
    assert.equal(result.actualDoubleClickSent, true);
    assert.equal(result.win32ShowWindowUsed, false);
    assert.equal(result.cursorRestored, true);
    assert.equal(result.overflowRestored, true);
    assert.equal(result.dpiContextRestored, true);
    assert.equal(result.nativeStateAfter.visible, true);
    assert.equal(result.nativeStateAfter.minimized, false);
    assert.equal(result.nativeStateAfter.hwnd, result.nativeStateBefore.hwnd);
    assert.equal(result.healthBefore.healthStatus, 204);
    assert.equal(result.healthAfter.healthStatus, 204);
    assert.ok(
      result.doubleClickEntryCountAfter > result.doubleClickEntryCountBefore,
    );
    assert.equal(result.iconInputs.length, 1);
    assert.equal(result.iconInputs[0].doubleClick, true);
    assert.equal(result.iconInputs[0].exactUuidHitTest, true);
    assert.equal(result.gates.length, 0);
    assert.equal(result.menuInputs.length, 0);
    assert.equal(result.ownedCloseRequestSetups.length, 0);
    return result;
  }
  const original = await windowState();
  const originalViewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
  await record("native-owned-window-original-state", {
    nativeState: original,
    viewport: await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    })),
  });
  assert.equal(original.visible, true);
  assert.equal(original.minimized, false);
  assert.equal(original.maximized, false);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  try {
    const fixtureViewport = { width: 980, height: 620 };
    const fixtureRequest = await windowState(
      "resize",
      fixtureViewport.width,
      fixtureViewport.height,
    );
    // Bring only this UUID's window forward through the real product tray path
    // before sampling bounds and DOM; this is setup, never drag pass evidence.
    await restoreOwnedWindow("before-product-titlebar-drag");
    await page.waitForFunction(
      ({ width, height }) =>
        Math.abs(innerWidth - width) <= 1 &&
        Math.abs(innerHeight - height) <= 1,
      fixtureViewport,
    );
    const dragBaseline = await windowState();
    const measuredFixtureViewport = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }));
    assert.equal(dragBaseline.visible, true);
    assert.equal(dragBaseline.minimized, false);
    assert.equal(dragBaseline.maximized, false);
    assert.ok(Math.abs(dragBaseline.clientWidth - fixtureViewport.width) <= 1);
    assert.ok(
      Math.abs(dragBaseline.clientHeight - fixtureViewport.height) <= 1,
    );
    await record("native-owned-window-drag-fixture-setup", {
      setupOnly: true,
      dragPassed: false,
      prepareSource: "owned-SetWindowPos-resize",
      originalNativeState: original,
      resizeRequest: fixtureRequest,
      baselineNativeState: dragBaseline,
      targetViewport: fixtureViewport,
      actualViewport: measuredFixtureViewport,
      cssEmulation: false,
      preparationUsedAsDragPassEvidence: false,
    });
    try {
      const dragPoint = await page.evaluate(() => {
        const selector =
          ".window-chrome .window-drag-region[data-tauri-drag-region]";
        const regions = document.querySelectorAll(selector);
        if (regions.length !== 1)
          throw new Error("Exactly one real product drag region is required");
        const region = regions[0];
        const rect = region.getBoundingClientRect();
        const style = getComputedStyle(region);
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        if (
          style.display === "none" ||
          style.visibility !== "visible" ||
          Number(style.opacity) === 0 ||
          style.pointerEvents === "none" ||
          rect.width < 64 ||
          rect.height < 12 ||
          rect.left < 0 ||
          rect.top < 0 ||
          rect.right > innerWidth ||
          rect.bottom > innerHeight ||
          document.elementFromPoint(x, y) !== region ||
          region.closest("button, a, input, select, textarea, [role=dialog]") ||
          document.querySelector("dialog[open], [role=dialog][aria-modal=true]")
        )
          throw new Error(
            "The actual product drag region is obscured or unsafe",
          );
        return {
          selector,
          x,
          y,
          rect: {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
          },
          viewport: { width: innerWidth, height: innerHeight },
          devicePixelRatio,
          hitVerified: true,
        };
      });
      const dragState = await windowState("drag", 1120, 780, dragPoint);
      const activationState = dragState;
      const activation = activationState.activation;
      await record("native-owned-window-activation-setup", {
        nativeState: activationState,
        domRegion: dragPoint,
        setupOnly: true,
        dragPassed: false,
        activationUsedAsDragPassEvidence: false,
      });
      assert.equal(activationState.ownedId, rootId);
      assert.equal(
        activationState.startedAt,
        process.env.AE_NATIVE_QA_STARTED_AT,
      );
      assert.equal(activationState.sha256, process.env.AE_NATIVE_QA_SHA256);
      assert.equal(activation.ActualSource, "owned-SendInput-click");
      assert.equal(activation.CoordinateSpace, "physical");
      assert.equal(activation.SetupOnly, true);
      assert.equal(activation.DragPassed, false);
      assert.equal(activation.InputCount, 3);
      assert.equal(activation.Failure, null);
      assert.equal(activation.CleanupFailure, null);
      assert.equal(activation.ClickSent, true);
      assert.equal(activation.MouseReleased, true);
      assert.equal(activation.PerInputOwnershipVerified, true);
      assert.equal(activation.DpiContextRestored, true);
      assert.equal(activation.OwnershipVerified, true);
      assert.equal(activation.ObservedForeground, true);
      assert.match(activation.MainHwnd, /^[1-9a-f][0-9a-f]*$/u);
      assert.equal(activation.ForegroundAfter, activation.MainHwnd);
      assert.deepEqual(activation.AfterClick, activation.Before);
      const drag = dragState.drag;
      await record("native-owned-window-drag-attempt", {
        nativeState: dragState,
        domRegion: dragPoint,
        actualInputSource: "SendInput",
        cssEmulation: false,
        restorationUsedAsPassEvidence: false,
      });
      assert.equal(dragState.ownedId, rootId);
      assert.equal(dragState.startedAt, process.env.AE_NATIVE_QA_STARTED_AT);
      assert.equal(dragState.sha256, process.env.AE_NATIVE_QA_SHA256);
      assert.equal(drag.InputSource, "SendInput");
      assert.equal(drag.CoordinateSpace, "physical");
      assert.match(drag.MainHwnd, /^[1-9a-f][0-9a-f]*$/u);
      assert.equal(drag.MainHwnd, activation.MainHwnd);
      assert.equal(drag.Failure, null);
      assert.equal(drag.CleanupFailure, null);
      assert.equal(drag.ForegroundVerified, true);
      assert.equal(drag.PerInputOwnershipVerified, true);
      assert.equal(drag.MovedByInput, true);
      assert.equal(drag.MouseReleased, true);
      assert.equal(drag.Restored, true);
      assert.deepEqual(drag.Before, activation.AfterClick);
      assert.equal(drag.InputCount, 11);
      assert.equal(Math.abs(drag.RequestedDeltaX), 48);
      assert.equal(Math.abs(drag.RequestedDeltaY), 36);
      assert.ok(Math.abs(drag.ActualDeltaX - drag.RequestedDeltaX) <= 2);
      assert.ok(Math.abs(drag.ActualDeltaY - drag.RequestedDeltaY) <= 2);
      assert.equal(drag.AfterInput.Left - drag.Before.Left, drag.ActualDeltaX);
      assert.equal(drag.AfterInput.Top - drag.Before.Top, drag.ActualDeltaY);
      assert.equal(
        drag.AfterInput.Right - drag.AfterInput.Left,
        drag.Before.Right - drag.Before.Left,
      );
      assert.equal(
        drag.AfterInput.Bottom - drag.AfterInput.Top,
        drag.Before.Bottom - drag.Before.Top,
      );
      assert.deepEqual(drag.RestoredBounds, drag.Before);
      const afterDrag = await windowState();
      assert.equal(afterDrag.left, dragBaseline.left);
      assert.equal(afterDrag.top, dragBaseline.top);
      assert.equal(afterDrag.width, dragBaseline.width);
      assert.equal(afterDrag.height, dragBaseline.height);
      assert.equal(await page.locator(".window-operation-error").count(), 0);
      await record("native-owned-window-drag", {
        passed: true,
        domRegion: dragPoint,
        nativeState: dragState,
        baselineNativeState: dragBaseline,
        baselineViewport: measuredFixtureViewport,
        restoredLogicalBounds: afterDrag,
        actualInputSource: "SendInput",
        cssEmulation: false,
        restorationUsedAsPassEvidence: false,
      });
    } finally {
      await windowState("restore");
      const fixtureRestored = await windowState(
        "bounds",
        original.width,
        original.height,
      );
      assert.equal(fixtureRestored.left, original.left);
      assert.equal(fixtureRestored.top, original.top);
      assert.equal(fixtureRestored.width, original.width);
      assert.equal(fixtureRestored.height, original.height);
      await page.waitForFunction(
        ({ width, height }) =>
          Math.abs(innerWidth - width) <= 1 &&
          Math.abs(innerHeight - height) <= 1,
        originalViewport,
      );
      await record("native-owned-window-drag-fixture-restored", {
        nativeState: fixtureRestored,
        expectedOriginalNativeState: original,
        expectedOriginalViewport: originalViewport,
        actualViewport: await page.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
        })),
        restorationUsedAsDragPassEvidence: false,
      });
    }
    const controls = page.getByRole("group", { name: "窗口操作", exact: true });
    await controls
      .getByRole("button", { name: "最大化窗口", exact: true })
      .click();
    const restore = controls.getByRole("button", {
      name: "还原窗口",
      exact: true,
    });
    await restore.waitFor({ state: "visible", timeout: 10000 });
    assert.equal(await restore.locator("svg.lucide-copy").count(), 1);
    const maximized = await windowState();
    assert.equal(maximized.visible, true);
    assert.equal(maximized.minimized, false);
    assert.equal(maximized.maximized, true);
    assert.ok(
      maximized.width !== original.width ||
        maximized.height !== original.height,
      "The owned maximized Win32 bounds must differ from the original bounds",
    );
    await restore.click();
    const maximize = controls.getByRole("button", {
      name: "最大化窗口",
      exact: true,
    });
    await maximize.waitFor({ state: "visible", timeout: 10000 });
    assert.equal(await maximize.locator("svg.lucide-square").count(), 1);
    const restored = await windowState();
    assert.equal(restored.visible, true);
    assert.equal(restored.minimized, false);
    assert.equal(restored.maximized, false);
    assert.ok(
      Math.abs(restored.width - original.width) <= 2 &&
        Math.abs(restored.height - original.height) <= 2,
      "The owned restored Win32 bounds must match the original bounds",
    );
    assert.equal(await page.locator(".window-operation-error").count(), 0);
    await record("native-hub-window-maximize-restore", {
      passed: true,
      actualNativeButtons: true,
      normal: original,
      maximized,
      restored,
      iconStateMatches: true,
      ownedWin32IdentityVerified: true,
      cssEmulation: false,
      minimizeOrCloseUsed: false,
    });
    for (const [width, height] of [
      [760, 600],
      [800, 650],
      [801, 650],
    ]) {
      const state = await windowState("resize", width, height);
      await record("native-owned-window-resize-request", {
        targetCssSize: { width, height },
        nativeState: state,
        viewport: await page.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
        })),
      });
      await page.waitForFunction(
        ({ width, height }) =>
          Math.abs(innerWidth - width) <= 1 &&
          Math.abs(innerHeight - height) <= 1,
        { width, height },
      );
      const measured = await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        bodyWidth: document.body.scrollWidth,
      }));
      assert.ok(measured.scrollWidth <= measured.width + 1);
      assert.ok(measured.bodyWidth <= measured.width + 1);
      await verifySidebarLayout(`actual-native-${width}x${height}`);
      await record("native-owned-window-resize", {
        targetCssSize: { width, height },
        measured,
        nativeState: state,
        osWindowResized: true,
        cssEmulation: false,
      });
    }
  } finally {
    const { width, height } = originalViewport;
    await windowState("restore");
    const restoredBounds = await windowState(
      "bounds",
      original.width,
      original.height,
    );
    await record("native-owned-window-bounds-restored", {
      nativeState: restoredBounds,
      viewport: await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
      })),
      expectedViewport: originalViewport,
    });
    await page.waitForFunction(
      ({ width, height }) =>
        Math.abs(innerWidth - width) <= 1 &&
        Math.abs(innerHeight - height) <= 1,
      { width, height },
    );
    await cdp.detach();
  }
  const before = await invoke("agent_hub_overview");
  assert.equal(before.ok, true);
  assert.equal(before.result.bridgeHealthy, true);
  try {
    await page.getByRole("button", { name: "最小化窗口", exact: true }).click();
    const minimized = await windowState();
    assert.equal(minimized.minimized, true);
    const whileMinimized = await invoke("agent_hub_overview");
    assert.equal(whileMinimized.ok, true);
    assert.equal(whileMinimized.result.bridgeHealthy, true);
    assert.equal(
      whileMinimized.result.dataDirectory,
      before.result.dataDirectory,
    );
    await restoreOwnedWindow("after-product-minimize-button");
    await page
      .getByRole("button", { name: "关闭窗口并留在托盘", exact: true })
      .waitFor({ state: "visible" });
    await page
      .getByRole("button", { name: "关闭窗口并留在托盘", exact: true })
      .click();
    const hidden = await windowState();
    assert.equal(hidden.visible, false);
    assert.equal(hidden.minimized, false);
    const whileHidden = await invoke("agent_hub_overview");
    assert.equal(whileHidden.ok, true);
    assert.equal(whileHidden.result.bridgeHealthy, true);
    assert.deepEqual(whileHidden.result.agents, before.result.agents);
    assert.equal(whileHidden.result.dataDirectory, before.result.dataDirectory);
    await record("native-owned-window-minimize-close", {
      actualUiButtons: true,
      minimized,
      hidden,
      rustGatewayHealthyWhileMinimizedAndHidden: true,
      processAlive: true,
      restorationUsesActualOwnedTrayDoubleClick: true,
      traySuiteMeasured: false,
    });
  } finally {
    await restoreOwnedWindow("after-product-close-to-tray-button");
    const restored = await windowState();
    assert.equal(restored.visible, true);
    assert.equal(restored.minimized, false);
    await record("native-owned-window-restored", { nativeState: restored });
  }
}
