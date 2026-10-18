import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSurfaceOwnedRoot } from "./native-surface-extra.mjs";

const repository = "ae-switch-native-qa/repo";
const latestVersion = "99.0.0";
const notes = "本地隔离更新验收：此说明由真实 Rust 更新检测读取。";
const releaseUrl = (version) =>
  `https://github.com/${repository}/releases/tag/v${version}`;

// The wrapper fixes these values before it launches Rust. This fixture supplies
// release bytes to the existing Rust HTTP client; it never replaces Tauri IPC.
export function createNativeUpdateFixture({
  version,
  nativeRoot,
  env = process.env,
}) {
  const suppliedPort = env.AE_NATIVE_QA_LOCAL_FIXTURE_PORT;
  if (suppliedPort === undefined || suppliedPort === "") return null;
  assert.match(suppliedPort, /^[1-9][0-9]{3,4}$/u);
  const port = Number(suppliedPort);
  assert.ok(port >= 1024 && port <= 65535 && ![9018, 9223].includes(port));
  assert.match(version, /^[0-9]+\.[0-9]+\.[0-9]+$/u);
  assert.ok(Number(version.split(".")[0]) < 99);
  assert.ok(nativeRoot && path.isAbsolute(nativeRoot));
  assert.match(nativeRoot, /^G:[\\/]/iu);
  assert.equal(path.basename(nativeRoot), "portable");
  assert.match(path.basename(path.dirname(nativeRoot)), /^[a-f0-9]{32}$/u);
  assert.equal(
    path.dirname(path.dirname(nativeRoot)),
    path.resolve(
      fileURLToPath(
        new URL("../../.cache/native-e2e-sandbox", import.meta.url),
      ),
    ),
  );
  const endpoint = `http://127.0.0.1:${port}/latest`;
  const marker = path.join(nativeRoot, "data", "qa-update-open-marker");
  assert.equal(env.UNI_SWITCH_QA_UPDATE_REPOSITORY, repository);
  assert.equal(env.UNI_SWITCH_QA_UPDATE_ENDPOINT, endpoint);
  assert.equal(env.UNI_SWITCH_QA_UPDATE_OPEN_MARKER, marker);
  let mode = "http500";
  const counts = { http500: 0, latest: 0, current: 0 };
  let credentialHeaderRequests = 0;
  return {
    port,
    endpoint,
    marker,
    repository,
    latestVersion,
    notes,
    releaseUrl: releaseUrl(latestVersion),
    setMode(value) {
      assert.ok(Object.hasOwn(counts, value), "Unknown local update mode");
      mode = value;
    },
    snapshot: () => ({ ...counts, credentialHeaderRequests, mode }),
    handle(request, response) {
      if (request.method !== "GET" || request.url !== "/latest") return false;
      if (request.headers.authorization || request.headers.cookie) {
        credentialHeaderRequests++;
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: "Update fixture rejects credentials" }),
        );
        return true;
      }
      counts[mode]++;
      response.writeHead(mode === "http500" ? 500 : 200, {
        "content-type": "application/json",
      });
      const selectedVersion = mode === "current" ? version : latestVersion;
      response.end(
        JSON.stringify(
          mode === "http500"
            ? { error: "Controlled local update HTTP 500" }
            : {
                tag_name: `v${selectedVersion}`,
                html_url: releaseUrl(selectedVersion),
                draft: false,
                prerelease: false,
                body: notes,
                published_at: "2026-10-09T00:00:00Z",
                assets: [],
              },
        ),
      );
      return true;
    },
  };
}

async function poll(read, predicate, label) {
  const deadline = Date.now() + 15000;
  do {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.fail(`${label} was not observed`);
}

export async function verifyUpdateExtras({
  page,
  invoke,
  record,
  fixture,
  updateSource,
  expectedVersion,
  nativeRoot,
  assertPhysicalWorkspacePath,
}) {
  const { id: rootId, workspace } = await validateSurfaceOwnedRoot(nativeRoot);
  assert.ok(fixture, "The update branch requires the wrapper-owned fixture");
  assert.equal(updateSource.repository, repository);
  assert.equal(updateSource.currentVersion, expectedVersion);
  const marker = fixture.marker;
  const ownerFile = path.join(nativeRoot, ".ae-native-e2e-owner.json");
  async function ownership() {
    await validateSurfaceOwnedRoot(nativeRoot);
    await assertPhysicalWorkspacePath(nativeRoot);
    await assertPhysicalWorkspacePath(ownerFile);
    const info = await fs.lstat(ownerFile);
    assert.ok(info.isFile() && info.nlink === 1 && info.size < 4096);
    const owner = JSON.parse(await fs.readFile(ownerFile, "utf8"));
    assert.equal(owner.id, rootId);
    assert.equal(
      owner.purpose,
      "AE Switch owned native UI and real tool acceptance",
    );
    assert.equal(path.resolve(owner.workspace), workspace);
    assert.equal(process.env.UNI_SWITCH_QA_UPDATE_OPEN_MARKER, marker);
  }
  async function markerInfo() {
    await assertPhysicalWorkspacePath(marker, { allowMissing: true });
    try {
      const info = await fs.lstat(marker);
      assert.equal(info.isSymbolicLink(), false);
      if (info.isFile()) assert.equal(info.nlink, 1);
      return info;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  async function markerText() {
    const info = await markerInfo();
    if (!info) return null;
    assert.ok(info.isFile() && info.size < 512);
    return fs.readFile(marker, "utf8");
  }
  async function removeObstacle() {
    await ownership();
    const info = await markerInfo();
    assert.ok(info?.isDirectory(), "Owned update obstacle changed type");
    assert.deepEqual(await fs.readdir(marker), []);
    await fs.rmdir(marker);
  }
  await ownership();
  assert.equal(
    await markerInfo(),
    null,
    "Dedicated update marker must start absent",
  );
  const entry = page.locator(".app-update-entry");
  assert.equal(await entry.count(), 1);
  assert.equal(
    await entry.getAttribute("aria-label"),
    `检查更新，当前版本 v${expectedVersion}`,
  );
  assert.equal(
    (await entry.locator(".app-version-label").innerText()).trim(),
    `v${expectedVersion}`,
  );
  const dialog = page.getByRole("dialog", { name: "软件更新", exact: true });
  const detection = dialog.getByRole("button", {
    name: "检测更新",
    exact: true,
  });
  let obstacleCreated = false;
  let markerTouched = false;
  let flowFailed = false;
  try {
    fixture.setMode("http500");
    await entry.click();
    await dialog.waitFor();
    await poll(
      () => detection.isEnabled(),
      Boolean,
      "Update detection enabled",
    );
    const beforeError = fixture.snapshot().http500;
    await detection.click();
    await poll(
      () => fixture.snapshot().http500,
      (count) => count > beforeError,
      "Actual local HTTP 500 request",
    );
    await dialog
      .getByText("GitHub 暂时不可用，请稍后重试", { exact: true })
      .waitFor();
    await poll(
      () => detection.isEnabled(),
      Boolean,
      "Failed update controls unlocked",
    );
    assert.equal(
      await dialog.getByText("已是最新版本", { exact: true }).count(),
      0,
    );
    await record("native-update-local-http500-error", {
      passed: true,
      actualDetectionButtonClicked: true,
      actualLocalHttp500Requests: fixture.snapshot().http500 - beforeError,
      startupConnectionRefusalCountedAsHttp500: false,
      noFabricatedLatestStatus: true,
      actualRustHttpClient: true,
      syntheticReleaseDataOnly: true,
      publicNetworkUpdateTested: false,
    });

    fixture.setMode("latest");
    const beforeLatest = fixture.snapshot().latest;
    await detection.click();
    await poll(
      () => fixture.snapshot().latest,
      (count) => count > beforeLatest,
      "Actual local latest request",
    );
    await dialog
      .getByText(`新版本 v${latestVersion}`, { exact: true })
      .waitFor();
    await dialog.getByText(notes, { exact: true }).waitFor();
    await poll(
      () => detection.isEnabled(),
      Boolean,
      "Successful update controls unlocked",
    );
    assert.equal(await dialog.locator(".app-update-error").count(), 0);
    assert.equal(
      (await dialog.locator(".app-update-status strong").innerText()).trim(),
      `v${expectedVersion}`,
    );
    assert.equal(
      await entry.getAttribute("aria-label"),
      `发现新版本 v${latestVersion}，当前版本 v${expectedVersion}，立即更新`,
    );
    await record("native-update-local-latest-retry", {
      passed: true,
      actualDetectionRetryClicked: true,
      latestVersion,
      notesRenderedFromActualRustResponse: true,
      errorCleared: true,
      actualLocalLatestRequests: fixture.snapshot().latest - beforeLatest,
      syntheticReleaseDataOnly: true,
      publicNetworkUpdateTested: false,
    });

    await ownership();
    assert.equal(await markerInfo(), null);
    await fs.mkdir(marker);
    obstacleCreated = true;
    markerTouched = true;
    const openFailure = await invoke("open_app_release", {
      url: fixture.releaseUrl,
    });
    assert.equal(openFailure.ok, false);
    assert.equal(openFailure.error?.code, "update_open");
    const opener = dialog.getByRole("button", {
      name: "前往下载",
      exact: true,
    });
    await opener.click();
    const openError = dialog.locator(".app-update-open-error");
    await openError
      .getByText("隔离测试的发布页记录未完成", { exact: true })
      .waitFor();
    assert.equal(
      await openError
        .getByRole("textbox", { name: "发布页地址", exact: true })
        .inputValue(),
      fixture.releaseUrl,
    );
    await poll(
      () => opener.isEnabled(),
      Boolean,
      "Failed release opener unlocked",
    );
    assert.deepEqual(await fs.readdir(marker), []);
    await record("native-update-owned-open-failure", {
      passed: true,
      actualRustFailureCode: openFailure.error.code,
      directRustFailureCheckedOnlyWithOwnedObstacle: true,
      actualFailedUiButtonClicked: true,
      actualUiErrorAndCopyableUrlObserved: true,
      ordinaryEmptyMarkerObstacle: true,
      qaMarkerOnly: true,
      osBrowserVerification: false,
    });
    await removeObstacle();
    obstacleCreated = false;
    await opener.click();
    await poll(
      markerText,
      (text) => text === fixture.releaseUrl,
      "Actual release retry marker",
    );
    await poll(
      () => opener.isEnabled(),
      Boolean,
      "Successful release opener unlocked",
    );
    assert.equal(await dialog.locator(".app-update-open-error").count(), 0);
    await record("native-update-owned-open-retry", {
      passed: true,
      exactObstacleRemovedNonrecursively: true,
      actualUiRetryClicked: true,
      actualRustMarkerUrl: fixture.releaseUrl,
      actualErrorClearedAfterRetry: true,
      qaMarkerOnly: true,
      osBrowserVerification: false,
    });

    fixture.setMode("current");
    const beforeCurrent = fixture.snapshot().current;
    await detection.click();
    await poll(
      () => fixture.snapshot().current,
      (count) => count > beforeCurrent,
      "Actual local current request",
    );
    await dialog.getByText("已是最新版本", { exact: true }).waitFor();
    assert.equal(
      await dialog
        .getByText(`新版本 v${latestVersion}`, { exact: true })
        .count(),
      0,
    );
    assert.equal(await dialog.locator(".app-update-notes").count(), 0);
    assert.equal(
      await entry.getAttribute("aria-label"),
      `检查更新，当前版本 v${expectedVersion}`,
    );
    assert.equal(fixture.snapshot().credentialHeaderRequests, 0);
    await record("native-update-local-current", {
      passed: true,
      actualDetectionButtonClicked: true,
      currentVersion: expectedVersion,
      actualLatestStatusRendered: true,
      staleLatestReminderRemoved: true,
      actualLocalCurrentRequests: fixture.snapshot().current - beforeCurrent,
      supplierCredentialsUsed: false,
      syntheticReleaseDataOnly: true,
      publicNetworkUpdateTested: false,
    });
  } catch (error) {
    flowFailed = true;
    throw error;
  } finally {
    const cleanupErrors = [];
    const attempt = async (run) => {
      try {
        await run();
      } catch {
        cleanupErrors.push("owned_update_restore_failed");
      }
    };
    if (obstacleCreated)
      await attempt(async () => {
        await removeObstacle();
        obstacleCreated = false;
      });
    if (markerTouched && !obstacleCreated)
      await attempt(async () => {
        await ownership();
        const text = await markerText();
        assert.ok(
          text === null || text === fixture.releaseUrl,
          "Unexpected update marker bytes must be retained",
        );
        if (text !== null) await fs.unlink(marker);
        assert.equal(await markerInfo(), null);
      });
    await attempt(async () => {
      if (await dialog.isVisible()) {
        await dialog
          .getByRole("button", { name: "关闭弹窗", exact: true })
          .click();
        await dialog.waitFor({ state: "hidden" });
      }
    });
    fixture.setMode("http500");
    await record("native-update-local-fixture-restored", {
      passed: cleanupErrors.length === 0,
      originalMarkerAbsenceRestored: cleanupErrors.length === 0,
      ordinaryObstacleRemovedNonrecursively: !obstacleCreated,
      dialogClosed: cleanupErrors.length === 0,
      fixtureModeRestored: true,
      qaMarkerOnly: true,
      osBrowserVerification: false,
      cleanupErrors,
      flowFailed,
    });
    if (cleanupErrors.length && !flowFailed)
      throw new Error("Owned local update fixture restoration failed");
  }
}
