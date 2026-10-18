import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const workspace = path.resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
);
const require = createRequire(path.join(workspace, "app/package.json"));
const { chromium } = require("playwright");
const { default: AxeBuilder } = require("@axe-core/playwright");
const agentNames = [
  "Claude Code",
  "Codex",
  "Hermes Agent",
  "oh-my-pi",
  "OpenCode",
  "Z Code",
  "WorkBuddy",
  "DeepSeek Harness",
];
const edge =
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const identifier = randomUUID().replaceAll("-", "");
const base = path.join(workspace, ".cache/browser-preview-e2e");
const root = path.join(base, identifier);
const marker = path.join(root, ".ae-preview-owner.json");
const build = path.join(workspace, "app/dist");
const output = path.join(workspace, "artifacts/acceptance");
const screenshots = path.join(output, `browser-preview-${identifier}`);
const reportPath = path.join(output, `browser-preview-e2e-${identifier}.json`);
const report = {
  recordedAt: new Date().toISOString(),
  scope:
    "Production Vite browser preview: responsive layout, themes, icons, keyboard help and automated accessibility. No Tauri IPC or real client execution.",
  id: identifier,
  root,
  passed: false,
  eightRealToolAcceptanceClaimed: false,
  tauriIpcConnected: false,
  officialClientsLaunched: false,
  realModelQueriesRun: false,
  systemSettingsMutated: false,
  existingBrowserReadOnly: edge,
  browserInstalledByTest: false,
  profileAndTemporaryDataWithinWorkspace: false,
  checkpoints: [],
  screenshots: [],
  pageErrors: [],
  unexpectedRequests: [],
  accessibility: [],
  cleanup: { removed: false },
};
const under = (parent, filename) => {
  const relative = path.relative(parent, filename);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};
async function ordinary(filename, missing = false) {
  for (
    let current = path.resolve(filename);
    ;
    current = path.dirname(current)
  ) {
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (missing && error.code === "ENOENT") continue;
      throw error;
    }
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(
      path.resolve(await fs.realpath(current)).toLowerCase(),
      current.toLowerCase(),
    );
    if (current !== filename) assert.ok(stat.isDirectory());
    if (path.dirname(current) === current) break;
  }
}
async function auditTree(directory) {
  await ordinary(directory);
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    assert.ok(under(root, filename));
    const stat = await fs.lstat(filename);
    if (stat.isSymbolicLink()) {
      const expectedLink = path.join(
        root,
        "home/AppData/Local/Microsoft/Windows/INetCache/Content.IE5",
      );
      const expectedTarget = path.join(
        root,
        "home/AppData/Local/Microsoft/Windows/INetCache/IE",
      );
      assert.equal(filename.toLowerCase(), expectedLink.toLowerCase());
      await ordinary(path.dirname(filename));
      assert.equal(
        (await fs.realpath(filename)).toLowerCase(),
        expectedTarget.toLowerCase(),
      );
      await ordinary(expectedTarget);
      await fs.unlink(filename);
      report.cleanup.internalCacheJunctionRemovedWithoutTraversal = true;
      continue;
    }
    await ordinary(filename);
    if (stat.isDirectory()) await auditTree(filename);
    else assert.ok(stat.isFile() && stat.nlink === 1);
  }
}
async function snapshotBuild() {
  const files = [];
  async function visit(directory) {
    await ordinary(directory);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      assert.ok(under(build, filename));
      await ordinary(filename);
      if (entry.isDirectory()) await visit(filename);
      else {
        assert.ok(entry.isFile());
        files.push({
          path: path.relative(build, filename).replaceAll("\\", "/"),
          sha256: createHash("sha256")
            .update(await fs.readFile(filename))
            .digest("hex"),
        });
      }
    }
  }
  await visit(build);
  files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return {
    fileCount: files.length,
    digest: createHash("sha256")
      .update(files.map((file) => `${file.path}\0${file.sha256}\n`).join(""))
      .digest("hex"),
    files,
  };
}
let context;
let server;
let created = false;
let failure;
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};
try {
  assert.match(workspace, /^G:[\\/]/iu);
  assert.equal(path.resolve(process.env.AE_WORKSPACE ?? ""), workspace);
  assert.ok(
    under(workspace, path.resolve(os.tmpdir())),
    "The Node/Playwright temporary directory must be within the G: workspace",
  );
  await ordinary(root, true);
  await ordinary(build);
  await ordinary(edge);
  report.buildBefore = await snapshotBuild();
  await fs.mkdir(base, { recursive: true });
  await fs.mkdir(root);
  created = true;
  await fs.writeFile(
    marker,
    JSON.stringify({
      id: identifier,
      workspace,
      purpose: "AE Switch owned browser preview acceptance",
    }),
    { flag: "wx" },
  );
  const previewEnvironment = { ...process.env };
  for (const [name, relative] of Object.entries({
    HOME: "home",
    USERPROFILE: "home",
    APPDATA: "appdata",
    LOCALAPPDATA: "localappdata",
    TEMP: "tmp",
    TMP: "tmp",
    TMPDIR: "tmp",
    XDG_CONFIG_HOME: "config",
    XDG_CACHE_HOME: "cache",
    XDG_DATA_HOME: "data",
    XDG_STATE_HOME: "state",
  })) {
    previewEnvironment[name] = path.join(root, relative);
    await fs.mkdir(previewEnvironment[name], { recursive: true });
  }
  report.profileAndTemporaryDataWithinWorkspace = true;
  report.buildIndexSha256 = createHash("sha256")
    .update(await fs.readFile(path.join(build, "index.html")))
    .digest("hex");
  server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "GET");
      const pathname = decodeURIComponent(
        new URL(request.url, "http://localhost").pathname,
      );
      const filename = path.resolve(
        build,
        `.${pathname === "/" ? "/index.html" : pathname}`,
      );
      assert.ok(under(build, filename));
      await ordinary(filename);
      const bytes = await fs.readFile(filename);
      response.writeHead(200, {
        "content-type":
          contentTypes[path.extname(filename)] ?? "application/octet-stream",
      });
      response.end(bytes);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  context = await chromium.launchPersistentContext(path.join(root, "profile"), {
    executablePath: edge,
    headless: true,
    env: previewEnvironment,
    viewport: { width: 1360, height: 960 },
    downloadsPath: path.join(root, "downloads"),
    tracesDir: path.join(root, "traces"),
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-crash-reporter",
      "--disable-component-update",
      `--disk-cache-dir=${path.join(root, "disk-cache")}`,
    ],
  });
  const page = context.pages()[0];
  page.on("pageerror", (error) => report.pageErrors.push(error.name));
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (!request.url().startsWith(`${origin}/`) || request.method() !== "GET") {
      report.unexpectedRequests.push({
        method: request.method(),
        origin: new URL(request.url()).origin,
      });
      await route.abort();
    } else await route.continue();
  });
  await page.goto(origin, { waitUntil: "networkidle" });
  await page
    .getByRole("heading", { name: "端点配置", level: 1, exact: true })
    .waitFor();
  assert.equal(await page.title(), "AE Switch · 端点配置");
  assert.equal(await page.locator(".hub-step-list > li").count(), 4);
  assert.equal(
    await page.getByRole("button", { name: "快速上手", exact: true }).count(),
    1,
  );
  for (const name of ["高级供应商管理", "返回 Agent Hub"])
    assert.equal(
      await page.getByRole("button", { name, exact: true }).count(),
      0,
      `${name} must not reintroduce a second configuration surface`,
    );
  for (const selector of [
    ".hub-overview-strip",
    ".hub-agent-detail",
    ".hub-page-badge",
    ".hub-directory-card",
  ])
    assert.equal(
      await page.locator(selector).count(),
      0,
      `${selector} must be absent from the simplified page`,
    );
  assert.equal(
    await page.getByRole("heading", { name: /你的 Agent，随时就绪/u }).count(),
    0,
  );
  assert.equal(
    await page.getByLabel(/^API\s*端点$/u).getAttribute("id"),
    "hub-endpoint",
  );
  assert.equal(
    await page.getByLabel("API Key", { exact: true }).getAttribute("id"),
    "hub-api-key",
  );
  assert.equal(
    await page.getByLabel("默认模型", { exact: true }).getAttribute("id"),
    "hub-model",
  );
  assert.equal(
    await page.getByRole("button", { name: "确认连接", exact: true }).count(),
    1,
  );
  assert.equal(
    await page.getByRole("button", { name: "确认并验证", exact: true }).count(),
    0,
  );
  report.checkpoints.push({
    name: "single-page-four-step-connection-without-legacy-entrypoints",
    passed: true,
  });
  assert.equal(
    await page.evaluate(() => typeof window.__TAURI_INTERNALS__),
    "undefined",
  );
  await page
    .getByRole("note")
    .filter({ hasText: "浏览器界面预览，未连接 Rust" })
    .waitFor();
  report.checkpoints.push({
    name: "actual-browser-without-rust",
    passed: true,
  });
  await page
    .locator("#hub-endpoint")
    .fill("https://preview.example.invalid/v1");
  await page.locator("#hub-api-key").fill("ae-preview-synthetic-key");
  // The production discovery debounce is 650 ms. Keep the filled draft alive
  // for more than two intervals so an accidental asynchronous query is seen.
  await page.waitForTimeout(1500);
  assert.equal(await page.locator("#hub-model").isEnabled(), false);
  for (const name of ["确认连接", "同步模型"])
    assert.equal(
      await page.getByRole("button", { name, exact: true }).isEnabled(),
      false,
    );
  assert.equal(
    await page.getByText("工具写读验证通过", { exact: true }).count(),
    0,
  );
  await page.locator("#hub-api-key").fill("");
  await page.locator("#hub-endpoint").fill("");
  report.checkpoints.push({
    name: "filled-credentials-cannot-query-configure-or-claim-tool-success",
    passed: true,
    syntheticCredentialsOnly: true,
    filledDraftObservationMilliseconds: 1500,
  });
  await ordinary(output);
  await ordinary(screenshots, true);
  await fs.mkdir(screenshots);
  async function scanAccessibility(state) {
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const summarize = (rules) =>
      rules.map((rule) => ({
        id: rule.id,
        impact: rule.impact,
        description: rule.description,
        helpUrl: rule.helpUrl,
        nodes: rule.nodes.map((node) => ({
          target: node.target,
          failureSummary: node.failureSummary,
        })),
      }));
    report.accessibility.push({
      state,
      axeVersion: result.testEngine.version,
      passedRules: result.passes.length,
      violations: summarize(result.violations),
      manualReview: summarize(result.incomplete),
      scope:
        "Automated WCAG A/AA checks on the browser preview; incomplete rules require manual review.",
    });
  }
  async function assertHelpKeyboard(state) {
    const help = page.getByRole("button", { name: "快速上手", exact: true });
    const close = page.getByRole("button", {
      name: "关闭快速上手",
      exact: true,
    });
    await help.focus();
    await help.press("Enter");
    await page.waitForFunction(
      () => document.activeElement?.id === "hub-quickstart-title",
    );
    assert.equal(await help.getAttribute("aria-expanded"), "true");
    assert.equal(await help.getAttribute("aria-controls"), "hub-quickstart");
    assert.equal(await page.locator("#hub-quickstart li").count(), 4);
    const background = page.getByRole("checkbox", {
      name: "随 Windows 启动，在后台运行",
      exact: true,
    });
    assert.equal(await background.isEnabled(), false);
    assert.equal(await background.isChecked(), false);
    await page
      .getByText("当前环境不支持修改系统启动项。", { exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "完整使用说明", exact: true })
        .isEnabled(),
      true,
    );
    for (const link of await page.locator(".hub-help-links a").all()) {
      assert.equal(new URL(await link.getAttribute("href")).protocol, "https:");
      assert.match(await link.getAttribute("rel"), /\bnoopener\b/u);
      assert.match(await link.getAttribute("rel"), /\bnoreferrer\b/u);
    }
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      "hub-quickstart-title",
    );
    await scanAccessibility(`${state}-help-open`);
    const helpScreenshot = path.join(screenshots, `help-${state}.png`);
    await page.screenshot({ path: helpScreenshot, fullPage: true });
    report.screenshots.push(helpScreenshot);
    await page.keyboard.press("Escape");
    await page.locator("#hub-quickstart").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#hub-quickstart").count(), 0);
    assert.equal(await help.getAttribute("aria-expanded"), "false");
    assert.equal(
      await help.evaluate((element) => element === document.activeElement),
      true,
    );
    await help.press("Space");
    await page.waitForFunction(
      () => document.activeElement?.id === "hub-quickstart-title",
    );
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      "hub-quickstart-title",
    );
    await page.keyboard.press("Tab");
    assert.equal(
      await close.evaluate((element) => element === document.activeElement),
      true,
    );
    const focus = await close.evaluate((element) => ({
      visible: element.matches(":focus-visible"),
      style: getComputedStyle(element).outlineStyle,
      width: parseFloat(getComputedStyle(element).outlineWidth),
    }));
    assert.ok(
      focus.visible && focus.style !== "none" && focus.width > 0,
      "Keyboard close control must show a focus indicator",
    );
    await close.press("Enter");
    await page.locator("#hub-quickstart").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#hub-quickstart").count(), 0);
    assert.equal(
      await help.evaluate((element) => element === document.activeElement),
      true,
    );
    report.checkpoints.push({
      name: `${state}-help-keyboard-focus-return`,
      passed: true,
      focus,
    });
  }
  const themeLogos = {};
  for (const viewport of [
    { width: 1360, height: 960 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);
    for (const themeName of ["dark", "light"]) {
      const state = `${themeName}-${viewport.width}x${viewport.height}`;
      if (
        (await page.locator("html").getAttribute("data-ae-theme")) !== themeName
      )
        await page.getByRole("button", { name: /切换[深浅]色主题/u }).click();
      await page.locator(`.agent-hub.theme-${themeName}`).waitFor();
      await page.waitForFunction(
        (expected) =>
          document.documentElement.dataset.aeTheme === expected &&
          localStorage.getItem("ae-switch-theme") === expected,
        themeName,
      );
      assert.equal(
        await page.locator("html").getAttribute("data-ae-theme"),
        themeName,
      );
      assert.equal(
        await page.evaluate(() => localStorage.getItem("ae-switch-theme")),
        themeName,
      );
      const logoSources = {};
      for (const name of agentNames) {
        const navigation = page.getByRole("navigation", {
          name: "选择 Agent",
          exact: true,
        });
        const navImage = navigation.getByRole("img", {
          name: `${name} 官方图标`,
          exact: true,
        });
        assert.equal(await navImage.count(), 1);
        const button = navigation.getByRole("button").filter({
          has: page.getByRole("img", { name: `${name} 官方图标`, exact: true }),
        });
        await button.click();
        await page
          .locator(".hub-connection-panel")
          .getByRole("heading", { name, exact: true })
          .waitFor();
        assert.equal(await button.getAttribute("aria-current"), "page");
        assert.equal(
          await navigation.locator('[aria-current="page"]').count(),
          1,
        );
        const panelImage = page
          .locator(".hub-connection-panel")
          .getByRole("img", { name: `${name} 官方图标`, exact: true });
        for (const image of [navImage, panelImage]) {
          await image.evaluate(async (element) => {
            if (!element.complete) await element.decode();
          });
          assert.equal(
            await image.evaluate(
              (element) =>
                element.complete &&
                element.naturalWidth > 0 &&
                element.naturalHeight > 0,
            ),
            true,
          );
          const bounds = await image.boundingBox();
          assert.ok(
            bounds &&
              bounds.width > 0 &&
              bounds.x >= 0 &&
              bounds.x + bounds.width <= viewport.width + 1,
          );
        }
        const source = await navImage.getAttribute("src");
        assert.equal(await panelImage.getAttribute("src"), source);
        logoSources[name] = createHash("sha256").update(source).digest("hex");
        const actions = page.locator("details.hub-client-actions");
        assert.equal(await actions.getAttribute("open"), null);
        await actions.locator("summary").click();
        assert.equal(
          await actions
            .getByRole("button", { name: `启动 ${name}`, exact: true })
            .isEnabled(),
          false,
        );
        await actions.locator("summary").click();
      }
      assert.equal(
        new Set(Object.values(logoSources)).size,
        8,
        "All eight agents must have distinct official icons",
      );
      if (themeLogos[themeName])
        assert.deepEqual(logoSources, themeLogos[themeName]);
      else themeLogos[themeName] = logoSources;
      report.checkpoints.push({
        name: `${state}-eight-agent-icons-navigation-launch-disabled`,
        passed: true,
        logoSources,
      });
      await page
        .getByRole("navigation", { name: "选择 Agent", exact: true })
        .getByRole("button")
        .filter({
          has: page.getByRole("img", {
            name: "Claude Code 官方图标",
            exact: true,
          }),
        })
        .click();
      await page
        .getByRole("heading", { name: "端点配置", exact: true })
        .waitFor();
      const dimensions = await page.evaluate(() => ({
        viewport: { width: innerWidth, height: innerHeight },
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        horizontalScroll: scrollX,
      }));
      assert.deepEqual(dimensions.viewport, viewport);
      assert.ok(
        dimensions.documentWidth <= viewport.width + 1 &&
          dimensions.bodyWidth <= viewport.width + 1,
        `The ${viewport.width}px page must not overflow horizontally: ${JSON.stringify(dimensions)}`,
      );
      assert.equal(dimensions.horizontalScroll, 0);
      for (const selector of ["#hub-endpoint", "#hub-api-key", "#hub-model"]) {
        const bounds = await page.locator(selector).boundingBox();
        assert.ok(bounds && bounds.width > 0);
        assert.ok(
          bounds.x >= 0 && bounds.x + bounds.width <= viewport.width + 1,
        );
      }
      const screenshot = path.join(screenshots, `four-step-${state}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      report.screenshots.push(screenshot);
      report.checkpoints.push({
        name: `four-step-responsive-${state}`,
        passed: true,
        ...dimensions,
        screenshot,
        credentialsVisible: false,
      });
      await scanAccessibility(state);
      await assertHelpKeyboard(state);
    }
  }
  for (const name of ["Codex", "OpenCode"])
    assert.notEqual(
      themeLogos.dark[name],
      themeLogos.light[name],
      `${name} must use its theme-specific icon`,
    );
  // This is only a geometry proxy for the default desktop viewport. The
  // browser remains disconnected from Tauri; no native runtime is injected.
  const desktopViewport = { width: 1120, height: 780 };
  await page.setViewportSize(desktopViewport);
  for (const themeName of ["dark", "light"]) {
    await page.reload({ waitUntil: "networkidle" });
    await page.locator("#hub-endpoint").waitFor();
    if (
      (await page.locator("html").getAttribute("data-ae-theme")) !== themeName
    )
      await page.getByRole("button", { name: /切换[深浅]色主题/u }).click();
    await page.locator(`.agent-hub.theme-${themeName}`).waitFor();
    assert.equal(await page.locator("#hub-endpoint").inputValue(), "");
    assert.equal(await page.locator("#hub-api-key").inputValue(), "");
    for (const selector of [
      ".hub-extra-settings",
      ".hub-profile-settings",
      ".hub-client-actions",
    ]) {
      assert.ok((await page.locator(selector).count()) > 0);
      for (const details of await page.locator(selector).all())
        assert.equal(await details.getAttribute("open"), null);
    }
    await page.evaluate(() => {
      document.querySelector(".agent-hub").classList.add("is-desktop");
      document.querySelector(".hub-preview-note").style.display = "none";
      window.scrollTo(0, 0);
    });
    assert.equal(
      await page.evaluate(() => typeof window.__TAURI_INTERNALS__),
      "undefined",
    );
    const bounds = {};
    for (const selector of [
      ".hub-topbar",
      ".hub-step-list",
      "#hub-endpoint",
      "#hub-api-key",
      "#hub-model",
      ".hub-profile-settings",
    ])
      bounds[selector] = await page.locator(selector).boundingBox();
    bounds.confirmConnection = await page
      .getByRole("button", { name: "确认连接", exact: true })
      .boundingBox();
    const screenshot = path.join(
      screenshots,
      `desktop-style-geometry-${themeName}-1120x780.png`,
    );
    await page.screenshot({ path: screenshot, fullPage: false });
    report.screenshots.push(screenshot);
    for (const [name, box] of Object.entries(bounds))
      assert.ok(
        box &&
          box.width > 0 &&
          box.height > 0 &&
          box.x >= 0 &&
          box.y >= 0 &&
          box.x + box.width <= desktopViewport.width + 1 &&
          box.y + box.height <= desktopViewport.height + 1,
        `${themeName} default desktop geometry: ${name} must be fully within the first viewport: ${JSON.stringify(box)}`,
      );
    const dimensions = await page.evaluate(() => ({
      viewport: { width: innerWidth, height: innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      verticalScroll: scrollY,
      horizontalScroll: scrollX,
    }));
    assert.deepEqual(dimensions.viewport, desktopViewport);
    assert.equal(dimensions.verticalScroll, 0);
    assert.equal(dimensions.horizontalScroll, 0);
    assert.ok(
      dimensions.documentWidth <= desktopViewport.width + 1 &&
        dimensions.bodyWidth <= desktopViewport.width + 1,
    );
    report.checkpoints.push({
      name: `default-desktop-geometry-${themeName}-1120x780`,
      passed: true,
      scope:
        "Browser-only geometry proxy: is-desktop CSS class applied and preview note hidden. No native window controls, Tauri IPC, client discovery or connection acceptance.",
      cleanDraft: true,
      profileSettingsCollapsed: true,
      confirmConnectionFullyInFirstViewport: true,
      bounds,
      ...dimensions,
      screenshot,
    });
  }
  report.buildAfter = await snapshotBuild();
  assert.deepEqual(
    report.buildAfter,
    report.buildBefore,
    "Production assets changed during browser acceptance",
  );
  assert.equal(report.accessibility.length, 8);
  assert.equal(
    report.accessibility.reduce(
      (count, state) => count + state.violations.length,
      0,
    ),
    0,
    "Automated accessibility violations were found; see the per-state report",
  );
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.unexpectedRequests, []);
  report.passed = true;
} catch (error) {
  failure = error;
  report.error = {
    name: error.name,
    message: String(error.message).slice(0, 1200),
  };
} finally {
  try {
    if (context) await context.close();
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (created) {
      assert.equal(path.dirname(root), base);
      assert.ok(under(workspace, root));
      await ordinary(root);
      const owner = JSON.parse(await fs.readFile(marker, "utf8"));
      assert.deepEqual(owner, {
        id: identifier,
        workspace,
        purpose: "AE Switch owned browser preview acceptance",
      });
      await auditTree(root);
      assert.deepEqual(JSON.parse(await fs.readFile(marker, "utf8")), owner);
      // Edge can release its final temporary file just after context.close().
      // Keep the verified owner marker until every other entry is removed.
      for (const entry of await fs.readdir(root)) {
        const filename = path.join(root, entry);
        if (filename === marker) continue;
        assert.ok(under(root, filename));
        await ordinary(filename);
        await fs.rm(filename, {
          recursive: true,
          maxRetries: 10,
          retryDelay: 250,
        });
      }
      assert.deepEqual(JSON.parse(await fs.readFile(marker, "utf8")), owner);
      assert.deepEqual(await fs.readdir(root), [path.basename(marker)]);
      await fs.unlink(marker);
      await fs.rmdir(root);
      assert.equal(
        await fs.stat(root).then(
          () => true,
          (error) => (error.code === "ENOENT" ? false : Promise.reject(error)),
        ),
        false,
      );
      report.cleanup = {
        ...report.cleanup,
        removed: true,
        ownerMarkerVerified: true,
        profileAndRuntimeDataRemoved: true,
      };
    }
  } catch (error) {
    report.passed = false;
    report.cleanup.error = {
      name: error.name,
      message: String(error.message).slice(0, 600),
    };
  }
  await ordinary(output);
  await ordinary(reportPath, true);
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
  });
  console.log(
    JSON.stringify({
      passed: report.passed,
      checkpoints: report.checkpoints.length,
      accessibilityStates: report.accessibility.length,
      accessibilityViolations: report.accessibility.reduce(
        (count, state) => count + state.violations.length,
        0,
      ),
      tauriIpcConnected: false,
      officialClientsLaunched: false,
      sandboxRemoved: report.cleanup.removed,
      report: reportPath,
    }),
  );
  process.exitCode = report.passed && !failure ? 0 : 1;
}
