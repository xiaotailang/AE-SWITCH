import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSurfaceOwnedRoot } from "./native-surface-extra.mjs";
import { assertExistingProfileEquivalent } from "./native-existing-readback.mjs";

const releaseConfig = JSON.parse(
  await fs.readFile(
    new URL("../../app/release-config.json", import.meta.url),
    "utf8",
  ),
);
const repository = releaseConfig.githubRepository;
const validRepository =
  typeof repository === "string" &&
  repository.split("/").length === 2 &&
  repository
    .split("/")
    .every(
      (part) =>
        /^[a-zA-Z0-9_.-]{1,100}$/.test(part) && part !== "." && part !== "..",
    );
const projectUrls = validRepository
  ? {
      source: `https://github.com/${repository}`,
      license: `https://github.com/${repository}/blob/main/app/LICENSE`,
      tutorial: `https://github.com/${repository}/blob/main/app/docs/tutorial.md`,
    }
  : {};
const canonical = (value) =>
  JSON.stringify(value, (_, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );

async function poll(read, predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.fail(`${label} was not observed`);
}

// Call from the already identity-verified qa-webview native driver with Hub visible.
// The wrapper MUST set UNI_SWITCH_QA_PROJECT_OPEN_MARKER before starting Rust,
// and retain it for this Node child. Setting it after Rust starts cannot isolate
// ShellExecuteW. The current portable-directory route has no QA interception,
// so this helper never clicks that button or invokes that native command.
export function assertExternalAgentProfile(
  agent,
  root,
  existingFixture = null,
) {
  const samePath = (left, right) =>
    typeof left === "string" &&
    typeof right === "string" &&
    path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
  if (existingFixture && agent.configured) {
    const expected = existingFixture.profiles?.[agent.id];
    assert.ok(
      expected,
      "Configured agents require a parent-validated original profile",
    );
    assertExistingProfileEquivalent(agent.profile, expected);
    assert.ok(
      samePath(agent.directory, expected.directory),
      "Configured agents must retain the exact original configuration directory",
    );
    return "existing";
  }
  assert.ok(
    samePath(agent.directory, path.join(root, "data/agents", agent.id)),
    "Unconfigured or legacy agents must retain their private directory identity",
  );
  return "legacy-or-unconfigured";
}

export async function verifyExternalRoutes({
  page,
  invoke,
  record,
  existingFixture = null,
}) {
  let protectedFlowStarted = false;
  try {
    const workspace = path.resolve(
      fileURLToPath(new URL("../../", import.meta.url)),
    );
    const { root, id: rootId } = await validateSurfaceOwnedRoot();
    const samePath = (left, right) =>
      typeof left === "string" &&
      typeof right === "string" &&
      path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
    const within = (parent, location) => {
      const relative = path.relative(parent, path.resolve(location));
      return (
        !path.isAbsolute(relative) &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`)
      );
    };
    assert.match(workspace, /^G:[\\/]/iu);
    assert.match(root, /^G:[\\/]/iu);
    assert.match(process.env.AE_NATIVE_QA_SHA256 || "", /^[a-f0-9]{64}$/iu);
    assert.match(process.env.AE_NATIVE_QA_PID || "", /^[1-9][0-9]*$/u);
    assert.ok(
      Number.isFinite(Date.parse(process.env.AE_NATIVE_QA_STARTED_AT || "")),
    );
    assert.equal(
      await page.evaluate(
        () => typeof window.__TAURI_INTERNALS__?.invoke === "function",
      ),
      true,
    );

    async function ordinary(location, missing = false) {
      assert.ok(
        within(root, location),
        "External-route files must stay inside the owned root",
      );
      const ancestors = [];
      let current = path.resolve(location);
      while (true) {
        ancestors.push(current);
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
      for (const ancestor of ancestors.reverse()) {
        let info;
        try {
          info = await fs.lstat(ancestor);
        } catch (error) {
          if (missing && error.code === "ENOENT") return null;
          throw error;
        }
        assert.ok(
          !info.isSymbolicLink() && (info.isFile() || info.isDirectory()),
        );
        if (info.isFile()) assert.equal(info.nlink, 1);
        assert.ok(samePath(await fs.realpath(ancestor), ancestor));
      }
      return fs.lstat(location);
    }
    async function read(location, missing = false) {
      const info = await ordinary(location, missing);
      if (!info) return null;
      assert.ok(info.isFile() && info.size < 4096);
      return fs.readFile(location);
    }
    async function ownership() {
      await validateSurfaceOwnedRoot(root);
      let owner;
      try {
        owner = JSON.parse(
          (await read(path.join(root, ".ae-native-e2e-owner.json"))).toString(
            "utf8",
          ),
        );
      } catch {
        throw new Error(
          "External routes require the valid native sandbox owner marker",
        );
      }
      assert.equal(owner.id, rootId);
      assert.equal(
        owner.purpose,
        "AE Switch owned native UI and real tool acceptance",
      );
      assert.ok(samePath(owner.workspace, workspace));
    }
    const native = async (command) => {
      const response = await invoke(command);
      assert.ok(
        response.ok,
        `External routes ${command} failed (${response.error?.code || "native_error"})`,
      );
      assert.ok(
        samePath(response.result.dataDirectory, path.join(root, "data")),
      );
      return response.result;
    };
    async function snapshot() {
      const overview = await native("get_overview");
      const hub = await native("agent_hub_overview");
      assert.deepEqual(overview.targets.map((target) => target.target).sort(), [
        "claude_cli",
        "claude_desktop",
        "codex",
      ]);
      for (const target of overview.targets) {
        assert.ok(within(root, target.directory));
        for (const location of target.files)
          assert.ok(within(target.directory, location));
      }
      for (const agent of hub.agents)
        assertExternalAgentProfile(agent, root, existingFixture);
      return {
        providers: overview.providers,
        targets: overview.targets,
        agents: hub.agents,
      };
    }
    const button = (name) => page.getByRole("button", { name, exact: true });
    const hubHeading = page.getByRole("heading", {
      name: /你的 Agent，随时就绪/u,
    });
    async function hubVisible() {
      await hubHeading.waitFor();
      assert.equal(await page.getByRole("dialog").count(), 0);
    }
    await ownership();
    await hubVisible();
    const initialPageUrl = page.url();
    const initial = await snapshot();
    const initialPreferences = await page.evaluate(() => ({
      list: localStorage.getItem("uni-switch-list-v1"),
      target: localStorage.getItem("uni-switch-ui-target-v1"),
    }));
    const marker = path.join(root, "data/qa-project-open.txt");
    const markerEnabled = samePath(
      process.env.UNI_SWITCH_QA_PROJECT_OPEN_MARKER,
      marker,
    );
    let originalMarker;
    let markerTouched = false;
    let routesFinished = false;
    let activeStep;
    let ownDialog;
    let flowFailure;
    let markerObstacle = null;
    const clickedPages = [];
    const knownMarker = (bytes) =>
      bytes === null ||
      bytes.length === 0 ||
      Object.values(projectUrls).some((url) =>
        bytes.equals(Buffer.from(url, "utf8")),
      );
    async function prepareMarker() {
      await ownership();
      assert.ok(
        samePath(process.env.UNI_SWITCH_QA_PROJECT_OPEN_MARKER, marker),
        "A missing or changed marker must prevent external-link clicks",
      );
      assert.ok((await ordinary(path.dirname(marker))).isDirectory());
      const before = await read(marker, true);
      assert.ok(
        knownMarker(before),
        "External helper must not overwrite an unknown marker value",
      );
      markerTouched = true;
      if (before !== null) await fs.unlink(marker);
      assert.ok(
        (await read(marker, true)) === null,
        "Each actual UI click must begin with an absent marker",
      );
    }
    async function markerRecorded(pageId) {
      const bytes = await poll(
        () => read(marker, true),
        (value) => value?.equals(Buffer.from(projectUrls[pageId], "utf8")),
        `Actual Rust ${pageId} route wrote its exact fixed URL`,
      );
      assert.ok(bytes.equals(Buffer.from(projectUrls[pageId], "utf8")));
      clickedPages.push(pageId);
    }
    const unchanged = async () => {
      assert.equal(
        page.url(),
        initialPageUrl,
        "External routes must retain the owned Tauri page URL",
      );
      assert.ok(
        canonical(await snapshot()) === canonical(initial),
        "External-link routes must retain original providers, targets, revisions and Agent configurations",
      );
      const preferences = await page.evaluate(() => ({
        list: localStorage.getItem("uni-switch-list-v1"),
        target: localStorage.getItem("uni-switch-ui-target-v1"),
      }));
      assert.ok(
        canonical(preferences) === canonical(initialPreferences),
        "External-link routes must retain target and list preferences",
      );
    };
    const receipt = (pageId) => ({
      passed: true,
      page: pageId,
      expectedUrl: projectUrls[pageId],
      actualUiAnchorClicked: true,
      actualRustMarkerRecorded: true,
      freshMarkerBeforeEachClick: true,
      markerPath: marker,
      qaMarkerOnly: true,
      osBrowserLaunched: false,
      osExplorerLaunched: false,
      externalProgramVerification: false,
      noDirectNativeOpenSetup: true,
    });

    async function removeMarkerObstacle() {
      if (!markerObstacle) return;
      await ownership();
      assert.ok(
        samePath(process.env.UNI_SWITCH_QA_PROJECT_OPEN_MARKER, marker),
      );
      assert.ok(samePath(path.dirname(marker), path.join(root, "data")));
      const current = await ordinary(marker);
      assert.ok(
        current.isDirectory(),
        "Only the dedicated ordinary marker obstacle may be removed",
      );
      if (markerObstacle.identity)
        assert.ok(
          current.dev === markerObstacle.identity.dev &&
            current.ino === markerObstacle.identity.ino,
          "The exact created marker directory identity must remain unchanged",
        );
      assert.equal(
        (await fs.readdir(marker)).length,
        0,
        "The owned marker obstacle must remain empty",
      );
      await fs.rmdir(marker);
      markerObstacle = null;
      assert.equal(await read(marker, true), null);
    }

    async function verifyMarkerFailureRecovery(pageId, opener, dialog) {
      const step = `native-external-${pageId}-link-failure-retry`;
      activeStep = step;
      let phase = "prepare";
      let failedPhase = null;
      let failure;
      let obstacleCreated = false;
      let obstacleRemoved = false;
      let nativeFailureObserved = false;
      let failedUiClicked = false;
      let uiErrorObserved = false;
      let noSuccessObserved = false;
      let controlsUnlocked = false;
      let retryClicked = false;
      let recovered = false;
      const errors = dialog.locator(".error-notice");
      const close = dialog.getByRole("button", {
        name: "关闭弹窗",
        exact: true,
      });
      const unlocked = async () => ({
        opener: await opener.isEnabled(),
        ariaDisabled: await opener.getAttribute("aria-disabled"),
        close: await close.isEnabled(),
      });
      try {
        await prepareMarker();
        await fs.mkdir(marker);
        markerObstacle = { identity: null };
        obstacleCreated = true;
        markerObstacle.identity = await ordinary(marker);
        assert.ok(markerObstacle.identity.isDirectory());
        assert.equal((await fs.readdir(marker)).length, 0);
        phase = "native-failure";
        // This diagnostic rejection is checked only with the verified obstacle
        // present; successful routes are exercised exclusively by UI clicks.
        const rejected = await invoke("open_project_page", { page: pageId });
        assert.equal(
          rejected.ok,
          false,
          "The real Rust marker write must fail against the owned directory",
        );
        assert.equal(rejected.error?.code, "project_open");
        nativeFailureObserved = true;
        phase = "ui-failure";
        await opener.click();
        failedUiClicked = true;
        await errors.filter({ hasText: "项目链接记录未完成" }).waitFor();
        assert.equal(await errors.count(), 1);
        uiErrorObserved = true;
        assert.equal(await dialog.locator(".settings-result").count(), 0);
        noSuccessObserved = true;
        await poll(
          unlocked,
          (state) =>
            state.opener && state.close && state.ariaDisabled !== "true",
          `Actual ${pageId} failure settled and unlocked`,
        );
        controlsUnlocked = true;
        assert.equal(await dialog.isVisible(), true);
        await unchanged();
      } catch (error) {
        failure = error;
        failedPhase = phase;
      } finally {
        if (obstacleCreated) {
          try {
            await removeMarkerObstacle();
            obstacleRemoved = true;
          } catch (error) {
            failure ||= error;
            failedPhase ||= "obstacle-cleanup";
          }
        }
      }
      if (!failure) {
        try {
          phase = "ui-retry";
          await prepareMarker();
          await opener.click();
          retryClicked = true;
          await markerRecorded(pageId);
          await poll(
            unlocked,
            (state) =>
              state.opener && state.close && state.ariaDisabled !== "true",
            `Actual ${pageId} retry settled and unlocked`,
          );
          if (pageId !== "tutorial") {
            await poll(
              () => dialog.locator(".settings-result").textContent(),
              (text) => text === "已打开项目页面。",
              `Actual ${pageId} retry success feedback`,
            );
          }
          assert.equal(await errors.count(), 0);
          assert.equal(await dialog.isVisible(), true);
          await unchanged();
          recovered = true;
        } catch (error) {
          failure = error;
          failedPhase = phase;
        }
      }
      await record(step, {
        passed: !failure && recovered,
        page: pageId,
        actualRustFailureCode: nativeFailureObserved ? "project_open" : null,
        nativeFailureCheckedOnlyWithOwnedObstacle: nativeFailureObserved,
        actualFailedUiAnchorClicked: failedUiClicked,
        actualUiErrorObserved: uiErrorObserved,
        noSuccessNoticeDuringFailure: noSuccessObserved,
        failureControlsUnlocked: controlsUnlocked,
        ordinaryEmptyMarkerObstacleCreated: obstacleCreated,
        exactObstacleRemovedNonrecursively: obstacleRemoved,
        actualUiRetryClicked: retryClicked,
        actualRetryMarkerRecorded: recovered,
        actualErrorClearedAfterRetry: recovered,
        providerTargetAgentAndPreferenceStateUnchanged: recovered,
        qaMarkerOnly: true,
        osBrowserLaunched: false,
        osExplorerLaunched: false,
        externalProgramVerification: false,
        noMockedInvoke: true,
        failedPhase,
        errorCategory: failure ? "owned_marker_failure_recovery_failed" : null,
      });
      if (failure)
        throw new Error(
          "Owned external-link marker failure and UI retry acceptance failed",
        );
    }

    protectedFlowStarted = true;
    try {
      activeStep = "native-external-portable-directory-unprotected";
      assert.equal(await button("打开便携目录").isVisible(), true);
      await record(activeStep, {
        passed: false,
        status: "skipped",
        actualButtonClicked: false,
        osExplorerLaunched: false,
        externalProgramVerification: false,
        reason:
          "The existing Windows open_portable_directory route directly spawns explorer.exe and has no QA marker or qa_isolation branch",
      });

      if (!validRepository) {
        activeStep = "native-external-unconfigured-repository";
        const beforeMarker = await read(marker, true);
        await button("高级供应商管理").click();
        await button("设置").click();
        ownDialog = page.getByRole("dialog", {
          name: /^(Codex|Claude Code) 设置$/u,
        });
        await ownDialog.waitFor();
        for (const name of ["查看源码 ↗", "完整许可 ↗"]) {
          assert.equal(
            await ownDialog.getByRole("link", { name, exact: true }).count(),
            0,
          );
          assert.equal(
            await ownDialog
              .getByRole("button", { name, exact: true })
              .isDisabled(),
            true,
          );
        }
        assert.equal(
          await ownDialog.getByText(/项目仓库尚未设置/u).isVisible(),
          true,
        );
        await ownDialog
          .getByRole("button", { name: "关闭弹窗", exact: true })
          .click();
        await ownDialog.waitFor({ state: "hidden" });
        await button("使用说明").click();
        ownDialog = page.getByRole("dialog", { name: "使用说明", exact: true });
        await ownDialog.waitFor();
        assert.equal(
          await ownDialog
            .getByRole("navigation", { name: "教程目录" })
            .isVisible(),
          true,
        );
        assert.equal(
          await ownDialog
            .getByRole("link", { name: "GitHub 完整教程" })
            .count(),
          0,
        );
        assert.equal(
          await ownDialog
            .getByRole("button", { name: "GitHub 完整教程" })
            .isDisabled(),
          true,
        );
        for (const pageId of ["source", "license", "tutorial"]) {
          const rejected = await invoke("open_project_page", { page: pageId });
          assert.equal(rejected.ok, false);
          assert.equal(rejected.error.code, "project_repository_unconfigured");
        }
        const afterMarker = await read(marker, true);
        assert.equal(
          beforeMarker === null
            ? afterMarker === null
            : beforeMarker.equals(afterMarker),
          true,
        );
        await unchanged();
        await record(activeStep, {
          passed: true,
          repositoryConfigured: false,
          offlineTutorialVisible: true,
          incorrectUpstreamLinksAbsent: true,
          disabledUiActions: 3,
          nativeOpenRejections: 3,
          markerUnchanged: true,
          osBrowserLaunched: false,
          externalProgramVerification: false,
        });
        await ownDialog
          .getByRole("button", { name: "开始使用", exact: true })
          .click();
        await ownDialog.waitFor({ state: "hidden" });
        routesFinished = true;
      } else if (!markerEnabled) {
        activeStep = "native-external-project-routes-skipped";
        await record(activeStep, {
          passed: false,
          status: "skipped",
          pages: ["source", "license", "tutorial"],
          actualUiAnchorsClicked: false,
          requiredMarker: "UNI_SWITCH_QA_PROJECT_OPEN_MARKER",
          requiredMarkerPath: marker,
          reason:
            "The exact owned project marker must be inherited from the wrapper that started the QA Rust process",
          osBrowserLaunched: false,
          externalProgramVerification: false,
        });
      } else {
        activeStep = "native-external-source-link-route";
        assert.ok((await ordinary(path.dirname(marker))).isDirectory());
        originalMarker = await read(marker, true);
        assert.ok(
          knownMarker(originalMarker),
          "External helper requires its dedicated owned marker",
        );
        await button("高级供应商管理").click();
        await page
          .getByRole("tab", { name: /^(Codex|Claude Code)\b/u })
          .first()
          .waitFor();
        await button("设置").click();
        ownDialog = page.getByRole("dialog", {
          name: /^(Codex|Claude Code) 设置$/u,
        });
        await ownDialog.waitFor();
        for (const [pageId, name, step] of [
          ["source", "查看源码 ↗", "native-external-source-link-route"],
          ["license", "完整许可 ↗", "native-external-license-link-route"],
        ]) {
          activeStep = step;
          const opener = ownDialog.getByRole("link", { name, exact: true });
          assert.equal(await opener.getAttribute("href"), projectUrls[pageId]);
          assert.equal(await opener.getAttribute("target"), "_blank");
          assert.ok(
            (await opener.getAttribute("rel"))
              .split(/\s/u)
              .includes("noopener"),
          );
          await verifyMarkerFailureRecovery(pageId, opener, ownDialog);
          activeStep = step;
          const success = ownDialog.locator(".settings-result");
          await poll(
            () => success.textContent(),
            (text) => text === "已打开项目页面。",
            `Actual ${pageId} route success feedback`,
          );
          assert.equal(await success.isVisible(), true);
          assert.equal(await ownDialog.locator(".error-notice").count(), 0);
          await unchanged();
          await record(activeStep, {
            ...receipt(pageId),
            actualSuccessNotice: "已打开项目页面。",
          });
        }
        await ownDialog
          .getByRole("button", { name: "关闭弹窗", exact: true })
          .click();
        await ownDialog.waitFor({ state: "hidden" });
        activeStep = "native-external-tutorial-link-route";
        await button("使用说明").click();
        ownDialog = page.getByRole("dialog", { name: "使用说明", exact: true });
        await ownDialog.waitFor();
        const tutorial = ownDialog.getByRole("link", {
          name: "GitHub 完整教程",
          exact: true,
        });
        assert.equal(await tutorial.getAttribute("href"), projectUrls.tutorial);
        await verifyMarkerFailureRecovery("tutorial", tutorial, ownDialog);
        activeStep = "native-external-tutorial-link-route";
        await poll(
          () => tutorial.getAttribute("aria-disabled"),
          (value) => value !== "true",
          "Actual tutorial opener settled and unlocked",
        );
        assert.equal(await tutorial.isVisible(), true);
        assert.equal(await ownDialog.locator(".error-notice").count(), 0);
        await unchanged();
        await record(activeStep, {
          ...receipt("tutorial"),
          actualTutorialStayedOpen: true,
          actualOpenerSettledWithoutError: true,
          tutorialHasNoSeparateSuccessNotice: true,
        });
        await ownDialog
          .getByRole("button", { name: "开始使用", exact: true })
          .click();
        await ownDialog.waitFor({ state: "hidden" });
        routesFinished = true;
      }
      activeStep = null;
    } catch (error) {
      flowFailure = error;
      if (activeStep)
        await record(activeStep, {
          passed: false,
          failure: String(error?.message || error).slice(0, 1500),
          successfullyRecordedPages: clickedPages,
          qaMarkerOnly: true,
          osBrowserLaunched: false,
          osExplorerLaunched: false,
          externalProgramVerification: false,
        });
    } finally {
      const cleanupErrors = [];
      const attempt = async (action) => {
        try {
          await action();
        } catch (error) {
          cleanupErrors.push(String(error?.message || error).slice(0, 1500));
        }
      };
      await attempt(removeMarkerObstacle);
      await attempt(async () => {
        if (ownDialog && (await ownDialog.isVisible())) {
          const close = ownDialog.getByRole("button", {
            name: "关闭弹窗",
            exact: true,
          });
          await poll(
            () => close.isEnabled(),
            Boolean,
            "External helper cleanup modal unlocked",
          );
          await close.click();
          await ownDialog.waitFor({ state: "hidden" });
        }
        const back = button("返回 Agent Hub");
        if (await back.isVisible()) await back.click();
        await hubVisible();
      });
      await attempt(async () => {
        if (markerTouched) {
          await ownership();
          assert.ok(
            samePath(process.env.UNI_SWITCH_QA_PROJECT_OPEN_MARKER, marker),
          );
          const current = await read(marker, true);
          assert.ok(
            knownMarker(current),
            "External cleanup must retain an unexpected marker change",
          );
          if (originalMarker === null) {
            if (current !== null) await fs.unlink(marker);
          } else await fs.writeFile(marker, originalMarker);
          const restored = await read(marker, true);
          assert.ok(
            originalMarker === null
              ? restored === null
              : restored?.equals(originalMarker),
            "External helper must restore the original marker bytes or absence",
          );
        }
      });
      await attempt(unchanged);
      await record("native-external-routes-restored", {
        passed: cleanupErrors.length === 0,
        hubRestored: cleanupErrors.length === 0,
        originalProvidersTargetsAgentsAndPreferencesPreserved:
          cleanupErrors.length === 0,
        projectMarkerEnabled: markerEnabled,
        projectRoutesFinished: routesFinished,
        successfullyRecordedPages: clickedPages,
        originalMarkerBytesOrAbsenceRestored: cleanupErrors.length === 0,
        portableDirectorySkippedBecauseRouteIsUnprotected: true,
        qaMarkerOnly: true,
        osBrowserLaunched: false,
        osExplorerLaunched: false,
        externalProgramVerification: false,
        screenshotsTaken: false,
        cleanupErrors,
        flowFailure: flowFailure
          ? String(flowFailure.message).slice(0, 1500)
          : null,
      });
      if (!flowFailure && cleanupErrors.length)
        flowFailure = new Error("External-route helper cleanup failed");
    }
    if (flowFailure) throw flowFailure;
  } catch (error) {
    if (!protectedFlowStarted) {
      await record("native-external-entry-failed", {
        passed: false,
        phase: "owned-preconditions",
        failure:
          "External-route entry validation failed before any external-link click",
        actualUiAnchorsClicked: false,
        osBrowserLaunched: false,
        osExplorerLaunched: false,
        externalProgramVerification: false,
      });
      throw new Error(
        "External-route entry validation failed before any external-link click",
      );
    }
    throw error;
  }
}
