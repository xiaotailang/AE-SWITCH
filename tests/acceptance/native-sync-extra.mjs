import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSurfaceOwnedRoot } from "./native-surface-extra.mjs";

const fixtureKey = "ae-switch-synthetic-native-management-key";
const rotatedKey = "ae-switch-synthetic-native-management-rotated-key";
const targetIds = ["codex", "claude_desktop", "claude_cli"];
const failureMessage =
  "其他软件修改了 API 配置，本次没有覆盖。请撤回相应修改后重试，处理方法见使用说明。";
const profileFile =
  "claude_desktop/Claude-3p/configLibrary/e82de475-47fa-4c54-9000-13571c000001.json";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
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

// The owner calls this while all three UUID-fixture targets use the same
// synthetic provider. Actual UI sync/retry writes go through the native store.
export async function verifySyncRetry({
  page,
  invoke,
  record,
  providerId,
  fixtureDirectory,
}) {
  const workspace = path.resolve(
    fileURLToPath(new URL("../../", import.meta.url)),
  );
  const fixture = path.resolve(fixtureDirectory);
  const { root, id: rootId } = await validateSurfaceOwnedRoot(
    path.resolve(fixture, "../../.."),
  );
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
  assert.match(workspace, /^G:[\\/]/iu, "Sync retry must use the G workspace");
  assert.ok(path.isAbsolute(fixtureDirectory));
  assert.ok(
    samePath(
      path.dirname(fixture),
      path.join(root, "data", "native-ui-fixtures"),
    ),
  );
  assert.match(
    path.basename(fixture),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  );
  assert.match(
    providerId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu,
  );

  async function ordinary(location, allowMissing = false) {
    assert.ok(
      within(root, location),
      "Sync retry paths must stay inside the owned root",
    );
    const ancestors = [];
    let current = path.resolve(location);
    while (true) {
      ancestors.push(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    let info;
    for (const ancestor of ancestors.reverse()) {
      try {
        info = await fs.lstat(ancestor);
      } catch (error) {
        if (allowMissing && error.code === "ENOENT") return null;
        throw error;
      }
      assert.ok(
        !info.isSymbolicLink(),
        "Sync retry may not traverse links or junctions",
      );
      assert.ok(
        info.isDirectory() || info.isFile(),
        "Sync retry requires ordinary files and directories",
      );
      if (info.isFile())
        assert.equal(info.nlink, 1, "Sync retry may not use hard-linked files");
      assert.ok(
        samePath(await fs.realpath(ancestor), ancestor),
        "Sync retry paths must be canonical",
      );
    }
    return info;
  }
  async function read(location, allowMissing = false) {
    const info = await ordinary(location, allowMissing);
    if (!info) return null;
    assert.ok(info.isFile(), "Sync retry must read an ordinary file");
    return fs.readFile(location);
  }
  async function ownership() {
    await validateSurfaceOwnedRoot(root);
    const rootOwner = JSON.parse(
      (await read(path.join(root, ".ae-native-e2e-owner.json"))).toString(
        "utf8",
      ),
    );
    assert.equal(rootOwner.id, rootId);
    assert.equal(
      rootOwner.purpose,
      "AE Switch owned native UI and real tool acceptance",
    );
    assert.ok(
      samePath(rootOwner.workspace, workspace),
      "Sync retry owner must name this workspace",
    );
    const owner = JSON.parse(
      (await read(path.join(fixture, ".ae-native-ui-owner.json"))).toString(
        "utf8",
      ),
    );
    assert.equal(owner.purpose, "synthetic native UI acceptance");
    assert.ok(Number.isFinite(Date.parse(owner.createdAt)));
  }
  const native = async (command, args = {}) => {
    const receipt = await invoke(command, args);
    assert.ok(
      receipt.ok,
      `${command} failed (${receipt.error?.code ?? "native_error"})`,
    );
    return receipt.result;
  };
  const overview = () => native("get_overview");
  const target = (value, id) => {
    const found = value.targets.find((item) => item.target === id);
    assert.ok(found, "Every synthetic target must remain present");
    return found;
  };
  function ownedTargets(value) {
    assert.ok(samePath(value.dataDirectory, path.join(root, "data")));
    assert.deepEqual(
      value.targets.map((item) => item.target).sort(),
      [...targetIds].sort(),
    );
    for (const id of targetIds) {
      const status = target(value, id);
      assert.ok(samePath(status.directory, path.join(fixture, id)));
      assert.equal(status.activeProviderId, providerId);
      assert.equal(status.canRestore, true);
      for (const location of status.files)
        assert.ok(
          within(status.directory, location),
          "Native target files must stay inside the fixture target",
        );
    }
  }
  async function snapshot(value) {
    ownedTargets(value);
    const files = new Map();
    async function walk(directory) {
      assert.ok((await ordinary(directory)).isDirectory());
      const entries = await fs.readdir(directory);
      for (const name of entries.sort()) {
        const location = path.join(directory, name);
        const info = await ordinary(location);
        if (info.isDirectory()) await walk(location);
        else {
          assert.ok(
            files.size < 200 && info.size < 4 * 1024 * 1024,
            "Synthetic snapshot must stay bounded",
          );
          files.set(
            path.relative(fixture, location).split(path.sep).join("/"),
            await read(location),
          );
        }
      }
    }
    for (const id of targetIds) await walk(target(value, id).directory);
    for (const location of value.targets.flatMap((item) => item.files)) {
      const relative = path
        .relative(fixture, location)
        .split(path.sep)
        .join("/");
      if (!files.has(relative)) files.set(relative, await read(location, true));
    }
    return files;
  }
  async function guard() {
    await ownership();
    const value = await overview();
    await snapshot(value);
    return value;
  }
  const poll = async (readValue, predicate, label) => {
    const deadline = Date.now() + 45000;
    do {
      const value = await readValue();
      if (predicate(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.fail(`${label} was not observed`);
  };
  const allApplied = (value) =>
    targetIds.every((id) => target(value, id).state === "applied");
  const button = (name) => page.getByRole("button", { name, exact: true });
  const card = () =>
    page
      .locator("li.provider-card")
      .filter({ has: page.locator(`[data-provider-name="${providerId}"]`) });
  const editor = page.getByRole("dialog", { name: "编辑供应商", exact: true });
  const refresh = button("刷新配置状态");
  async function refreshUi() {
    await poll(
      () => refresh.isEnabled(),
      Boolean,
      "Sync retry refresh unlocked",
    );
    await refresh.click();
    await poll(
      () => refresh.isEnabled(),
      Boolean,
      "Sync retry refresh completed",
    );
  }
  async function deferRestarts(phase, requireCodex = false) {
    if (requireCodex)
      await page
        .getByRole("dialog", { name: "重启 Codex 使配置生效", exact: true })
        .waitFor({ timeout: 45000 });
    const later = button("稍后重启");
    let quietUntil = Date.now() + 800;
    let count = 0;
    do {
      if (await later.isVisible()) {
        assert.ok(count < 6, "Restart prompts must be bounded");
        await later.click();
        count += 1;
        quietUntil = Date.now() + 800;
        await record("native-sync-retry-restart-deferred", {
          phase,
          processRestarted: false,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < quietUntil);
    if (requireCodex)
      assert.ok(count > 0, "The real Codex write prompt must be deferred");
  }

  await ownership();
  const initial = await overview();
  ownedTargets(initial);
  assert.ok(
    allApplied(initial),
    "Sync retry requires all three targets applied",
  );
  const original = structuredClone(
    initial.providers.find((item) => item.id === providerId),
  );
  assert.ok(original?.hasKey);
  assert.equal(original.family, "codex");
  assert.match(original.name, /^Synthetic native QA\b/u);
  const supplier = new URL(original.baseUrl);
  assert.equal(supplier.protocol, "http:");
  assert.equal(supplier.hostname, "127.0.0.1");
  assert.ok(Number(supplier.port) > 0 && supplier.pathname === "/v1");
  assert.ok(
    supplier.username + supplier.password + supplier.search + supplier.hash ===
      "",
    "Synthetic supplier URL must not include credentials or query parameters",
  );
  assert.equal(
    await page
      .getByRole("tab", { name: /^Codex\b/u })
      .getAttribute("data-state"),
    "active",
  );
  const before = await snapshot(initial);
  for (const relative of [
    "codex/config.toml",
    "codex/auth.json",
    "codex/uni-switch-models.json",
    "claude_cli/settings.json",
    "claude_desktop/Claude/claude_desktop_config.json",
    "claude_desktop/Claude-3p/claude_desktop_config.json",
    profileFile,
    "claude_desktop/Claude-3p/configLibrary/_meta.json",
  ])
    assert.ok(
      before.get(relative),
      "The owned fixture must include every protected client file",
    );
  const configFile = path.join(fixture, "codex", "config.toml");
  const configBefore = before.get("codex/config.toml");
  const configText = configBefore.toString("utf8");
  assert.ok(
    Buffer.from(configText, "utf8").equals(configBefore),
    "The config must round-trip UTF-8 without changes",
  );
  assert.equal(
    configText.split(fixtureKey).length - 1,
    1,
    "The fixture key must already be applied exactly once",
  );
  assert.equal(configText.includes(rotatedKey), false);
  const section = configText.search(/^[ \t]*\[/mu);
  const rootFields = section < 0 ? configText : configText.slice(0, section);
  const modelPattern =
    /^([ \t]*model[ \t]*=[ \t]*)"([^"\r\n]*)"([ \t]*(?:#.*)?\r?)$/gmu;
  const modelLines = [...rootFields.matchAll(modelPattern)];
  assert.equal(
    modelLines.length,
    1,
    "Exactly one managed root model is required",
  );
  assert.equal(modelLines[0][2], target(initial, "codex").appliedModel);
  const externalModel = `ae-switch-synthetic-sync-external-${path.basename(fixture)}`;
  const externalConfig = Buffer.from(
    rootFields.replace(
      modelPattern,
      (_, prefix, model, suffix) =>
        `${prefix}${JSON.stringify(externalModel)}${suffix}`,
    ) + configText.slice(rootFields.length),
    "utf8",
  );
  assert.equal(externalConfig.equals(configBefore), false);
  const secrets = new Set([fixtureKey, rotatedKey]);
  for (const relative of [
    "codex/auth.json",
    "claude_cli/settings.json",
    profileFile,
  ]) {
    const value = JSON.parse(before.get(relative).toString("utf8"));
    for (const token of [
      value.OPENAI_API_KEY,
      value.env?.ANTHROPIC_AUTH_TOKEN,
      value.env?.ANTHROPIC_API_KEY,
      value.inferenceGatewayApiKey,
    ])
      if (typeof token === "string" && token) secrets.add(token);
  }
  const safeError = (error) => {
    let text = error?.message ?? String(error);
    for (const secret of secrets) text = text.split(secret).join("[REDACTED]");
    return text.slice(0, 1500);
  };
  const stableProvider = (value) => {
    const { updatedAt, keySuffix, ...stable } = value;
    return stable;
  };
  const providerInput = (apiKey) => ({
    id: original.id,
    family: original.family,
    name: original.name,
    baseUrl: original.baseUrl,
    apiKey,
    model: original.model,
    authMode: original.authMode,
    reasoningEffort: original.reasoningEffort,
    codexOptions: structuredClone(original.codexOptions),
    balanceAccessToken: null,
  });
  function providerPreserved(value) {
    const current = value.providers.find((item) => item.id === providerId);
    assert.ok(
      current &&
        canonical(stableProvider(current)) ===
          canonical(stableProvider(original)),
      "Key synchronization must preserve provider options and models",
    );
    assert.ok(
      canonical(value.providers.filter((item) => item.id !== providerId)) ===
        canonical(initial.providers.filter((item) => item.id !== providerId)),
      "Synchronization must not change any other provider",
    );
    for (const id of targetIds)
      assert.equal(
        target(value, id).appliedModel,
        target(initial, id).appliedModel,
        "Synchronization must retain each applied client model",
      );
  }
  function exactFiles(expected, actual, label, ids = targetIds) {
    const selected = (files) =>
      [...files.keys()]
        .filter((relative) => ids.some((id) => relative.startsWith(`${id}/`)))
        .sort();
    assert.deepEqual(
      selected(actual),
      selected(expected),
      `${label} must preserve file existence`,
    );
    for (const relative of selected(expected)) {
      const bytes = expected.get(relative);
      const current = actual.get(relative);
      assert.ok(
        bytes === null ? current === null : current?.equals(bytes),
        `${label}: ${relative} bytes must stay unchanged`,
      );
    }
  }
  function projectJson(relative, bytes) {
    const value = JSON.parse(bytes.toString("utf8"));
    const owner = relative === "claude_cli/settings.json" ? value.env : value;
    const fields =
      relative === "claude_cli/settings.json"
        ? ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]
        : ["inferenceGatewayBaseUrl", "inferenceGatewayApiKey"];
    for (const [index, key] of fields.entries()) {
      assert.ok(
        typeof owner?.[key] === "string" && owner[key],
        "Real bridge projection must retain its URL and token",
      );
      if (index === 0) {
        const url = new URL(owner[key]);
        assert.equal(url.protocol, "http:");
        assert.equal(url.hostname, "127.0.0.1");
        assert.ok(Number(url.port) > 0);
        assert.ok(
          url.username + url.password + url.search + url.hash === "",
          "Bridge projection URL must not include credentials or query parameters",
        );
        owner[key] =
          `${url.protocol}//${url.hostname}:<native-port>${url.pathname}`;
      } else {
        secrets.add(owner[key]);
        owner[key] = "<native-bridge-token>";
      }
    }
    return canonical(value);
  }
  function protectedFiles(actual, key) {
    assert.deepEqual(
      [...actual.keys()].sort(),
      [...before.keys()].sort(),
      "Key synchronization must preserve all fixture files",
    );
    for (const [relative, originalBytes] of before) {
      const current = actual.get(relative);
      assert.equal(
        current === null,
        originalBytes === null,
        "Key synchronization must retain file existence",
      );
      if (!current) continue;
      if (relative === "codex/config.toml") {
        const text = current.toString("utf8");
        assert.equal(
          text.split(key).length - 1,
          1,
          "The actual Codex config must contain the requested synthetic key",
        );
        const lines = (value) =>
          value
            .split(/\r?\n/u)
            .filter((line) => line.trim())
            .join("\n");
        assert.ok(
          lines(text.split(key).join(fixtureKey)) === lines(configText),
          "Synchronization must retain model, context, Fast, unmanaged config, and comments",
        );
      } else if (
        relative === "claude_cli/settings.json" ||
        relative === profileFile
      ) {
        assert.ok(
          projectJson(relative, current) ===
            projectJson(relative, originalBytes),
          "Synchronization must retain every client model, MCP, and unmanaged JSON setting",
        );
      } else if (relative === "codex/uni-switch-models.json") {
        assert.ok(
          canonical(JSON.parse(current.toString("utf8"))) ===
            canonical(JSON.parse(originalBytes.toString("utf8"))),
          "Synchronization must retain all model catalog metadata",
        );
      } else {
        assert.ok(
          current.equals(originalBytes),
          `Synchronization must retain exact protected bytes: ${relative}`,
        );
      }
    }
  }
  async function writeConfig(expected, replacement) {
    await guard();
    await ordinary(configFile);
    const handle = await fs.open(configFile, "r+");
    try {
      const info = await handle.stat();
      const pathInfo = await ordinary(configFile);
      assert.ok(
        info.isFile() &&
          info.nlink === 1 &&
          info.ino === pathInfo.ino &&
          info.dev === pathInfo.dev,
        "Only the verified ordinary config handle may be written",
      );
      assert.ok(
        (await handle.readFile()).equals(expected),
        "Do not overwrite an unexpected config change",
      );
      let offset = 0;
      while (offset < replacement.length) {
        const { bytesWritten } = await handle.write(
          replacement,
          offset,
          replacement.length - offset,
          offset,
        );
        assert.ok(bytesWritten > 0);
        offset += bytesWritten;
      }
      await handle.truncate(replacement.length);
      await handle.sync();
    } finally {
      await handle.close();
    }
    assert.ok(
      (await read(configFile)).equals(replacement),
      "The controlled config write must be exact",
    );
  }
  let externalOutstanding = false;
  let providerDirty = false;
  let notificationReached = false;
  let retryCompleted = false;
  let flowFailure;
  const cleanupFailures = [];
  try {
    await button("设置").click();
    const settings = page.getByRole("dialog", {
      name: "Codex 设置",
      exact: true,
    });
    assert.equal(
      await settings
        .getByRole("checkbox", {
          name: "保存供应商后，自动更新所有已使用它的客户端",
          exact: true,
        })
        .isChecked(),
      false,
    );
    await settings
      .getByRole("button", { name: "关闭弹窗", exact: true })
      .click();
    await settings.waitFor({ state: "hidden" });
    externalOutstanding = true;
    await writeConfig(configBefore, externalConfig);
    await poll(
      overview,
      (value) => target(value, "codex").state === "external_change",
      "Real managed-root external edit detection",
    );
    await record("native-sync-retry-owned-external-edit", {
      target: "codex",
      field: "model",
      configBeforeSha256: hash(configBefore),
      editedSha256: hash(externalConfig),
      onlyManagedRootModelChanged: true,
      syntheticOwnedTargetsOnly: true,
    });

    // The active UI commit must demonstrate its real external-change rejection
    // before save_provider is used solely to set up the pending connection.
    await guard();
    await card()
      .getByRole("button", { name: `编辑 ${original.name}`, exact: true })
      .click();
    assert.equal(
      await editor.locator("#apiKey").inputValue(),
      "",
      "Saved secrets must not be echoed into the editor",
    );
    await editor.locator("#apiKey").fill(rotatedKey);
    providerDirty = true;
    await editor
      .getByRole("button", { name: "保存并使用", exact: true })
      .click();
    const feedback = editor.locator(".error-feedback");
    await feedback
      .getByText(failureMessage, { exact: true })
      .waitFor({ timeout: 45000 });
    assert.ok(
      (await feedback.locator("pre").textContent()).includes(
        "错误类型：external_change",
      ),
      "The rejected UI save must report the native external_change code",
    );
    const rejected = await overview();
    assert.ok(
      canonical(rejected.providers) === canonical(initial.providers),
      "Rejected active save must leave the provider unchanged",
    );
    providerDirty = false;
    for (const id of targetIds)
      assert.equal(
        target(rejected, id).configurationRevision,
        target(initial, id).configurationRevision,
      );
    const editedSnapshot = new Map(before);
    editedSnapshot.set("codex/config.toml", externalConfig);
    exactFiles(editedSnapshot, await snapshot(rejected), "Rejected UI save");
    await editor.getByRole("button", { name: "取消", exact: true }).click();
    await editor.waitFor({ state: "hidden" });
    await record("native-sync-retry-active-edit-rejected", {
      actualUiSaveAttempted: true,
      errorCode: "external_change",
      providerAndClientFilesUnchanged: true,
    });

    await guard();
    providerDirty = true;
    await native("save_provider", { input: providerInput(rotatedKey) });
    const pending = await poll(
      overview,
      (value) =>
        target(value, "codex").state === "external_change" &&
        ["claude_desktop", "claude_cli"].every(
          (id) => target(value, id).state === "saved_changes",
        ),
      "Native provider-only key setup",
    );
    providerPreserved(pending);
    exactFiles(editedSnapshot, await snapshot(pending), "Provider-only setup");
    await record("native-sync-retry-provider-setup", {
      command: "save_provider",
      purpose: "setup only after real active UI commit rejection",
      syntheticRotatedKey: true,
      clientFilesWrittenBySetup: false,
      providerOptionsAndModelsPreserved: true,
    });
    await refreshUi();
    await guard();
    await card().locator(".provider-sync-button").click();
    const partial = await poll(
      overview,
      (value) =>
        target(value, "codex").state === "external_change" &&
        ["claude_desktop", "claude_cli"].every(
          (id) => target(value, id).state === "applied",
        ),
      "Real partial UI synchronization",
    );
    await deferRestarts("partial-sync");
    const notice = page.locator(".notice.error");
    await notice.waitFor({ timeout: 45000 });
    const retry = notice.getByRole("button", {
      name: "同步其他客户端",
      exact: true,
    });
    await poll(
      () => retry.isEnabled(),
      Boolean,
      "Failure notification retry action",
    );
    const noticeText = await notice.innerText();
    assert.ok(
      noticeText.includes(failureMessage) &&
        noticeText.includes("Codex 桌面端 / CLI："),
      "The actual error notification must identify the failed Codex target",
    );
    assert.ok(
      noticeText.includes("已更新：") &&
        noticeText.includes("Claude Code 桌面端") &&
        noticeText.includes("Claude CLI"),
      "The actual notification must identify both successful targets",
    );
    for (const secret of secrets)
      assert.equal(
        noticeText.includes(secret),
        false,
        "Failure notification must not expose credentials",
      );
    notificationReached = true;
    const partialFiles = await snapshot(partial);
    exactFiles(editedSnapshot, partialFiles, "Failed Codex synchronization", [
      "codex",
    ]);
    for (const id of ["claude_desktop", "claude_cli"])
      assert.ok(
        target(partial, id).configurationRevision >
          target(initial, id).configurationRevision,
        "Successful targets must record a real synchronization revision",
      );
    assert.equal(
      target(partial, "codex").configurationRevision,
      target(initial, "codex").configurationRevision,
    );
    await record("native-sync-retry-partial-failure", {
      manualSyncClicked: true,
      failedTarget: "codex",
      errorCode: "external_change",
      successfulTargets: ["claude_desktop", "claude_cli"],
      failedConfigSha256: hash(partialFiles.get("codex/config.toml")),
      failedFileBytesUnchanged: true,
      configurationRevisionsBefore: Object.fromEntries(
        targetIds.map((id) => [id, target(initial, id).configurationRevision]),
      ),
      configurationRevisionsAfterPartialSync: Object.fromEntries(
        targetIds.map((id) => [id, target(partial, id).configurationRevision]),
      ),
      actualNotificationRetryLabel: "同步其他客户端",
      retryScopedToFailureNotification: true,
    });

    await writeConfig(externalConfig, configBefore);
    externalOutstanding = false;
    const retryPending = await poll(
      overview,
      (value) => target(value, "codex").state === "saved_changes",
      "External edit reverted to exact original bytes",
    );
    exactFiles(
      partialFiles,
      await snapshot(retryPending),
      "Successful targets before retry",
      ["claude_desktop", "claude_cli"],
    );
    await guard();
    // Do not refresh here: the original failure notification is the retry UI.
    assert.equal(await notice.isVisible(), true);
    await retry.click();
    const retried = await poll(
      overview,
      allApplied,
      "Notification retry applied only the failed target",
    );
    await deferRestarts("notification-retry", true);
    await poll(
      () => page.locator(".notice.error").count(),
      (count) => count === 0,
      "Failed notification cleared after successful retry",
    );
    const retriedFiles = await snapshot(retried);
    exactFiles(
      partialFiles,
      retriedFiles,
      "Successful targets during notification retry",
      ["claude_desktop", "claude_cli"],
    );
    for (const id of ["claude_desktop", "claude_cli"])
      assert.equal(
        target(retried, id).configurationRevision,
        target(partial, id).configurationRevision,
        "Retry must skip targets already applied",
      );
    assert.ok(
      target(retried, "codex").configurationRevision >
        target(partial, "codex").configurationRevision,
      "Retry must record the real Codex write",
    );
    providerPreserved(retried);
    protectedFiles(retriedFiles, rotatedKey);
    retryCompleted = true;
    await record("native-sync-retry-notification-success", {
      actualFailureNotificationActionClicked: true,
      synchronizedTargets: ["codex"],
      successfulTargetBytesAndRevisionsUnchanged: true,
      configurationRevisionsAfterRetry: Object.fromEntries(
        targetIds.map((id) => [id, target(retried, id).configurationRevision]),
      ),
      allTargetsApplied: true,
      providerModelsContextAuthMcpAndUnmanagedFieldsPreserved: true,
      globalClientRestarted: false,
    });

    await guard();
    await native("save_provider", { input: providerInput(fixtureKey) });
    const restoredPending = await poll(
      overview,
      (value) =>
        targetIds.every((id) => target(value, id).state === "saved_changes"),
      "Original synthetic key restored in the provider",
    );
    providerPreserved(restoredPending);
    exactFiles(
      retriedFiles,
      await snapshot(restoredPending),
      "Provider key restoration before final synchronization",
    );
    await record("native-sync-retry-provider-key-restore", {
      command: "save_provider",
      purpose: "restore original synthetic provider key",
      clientFilesWrittenBySave: false,
    });
    await refreshUi();
    await guard();
    await card().locator(".provider-sync-button").click();
    const restored = await poll(
      overview,
      allApplied,
      "Final UI synchronization with original fixture key",
    );
    await deferRestarts("fixture-key-restore", true);
    const restoredFiles = await snapshot(restored);
    providerPreserved(restored);
    protectedFiles(restoredFiles, fixtureKey);
    providerDirty = false;
    await record("native-sync-retry-restored", {
      originalSyntheticKeyRestored: true,
      restoredCodexConfigSha256: hash(restoredFiles.get("codex/config.toml")),
      finalManualUiSync: true,
      allTargetsApplied: true,
      actualNotificationRetryCompleted: true,
      authCatalogMcpAndUnmanagedFieldsPreserved: true,
      globalClientRestarted: false,
    });
  } catch (error) {
    flowFailure = error;
  } finally {
    const cleanup = async (label, task) => {
      try {
        await task();
      } catch (error) {
        cleanupFailures.push({ action: label, error: safeError(error) });
      }
    };
    if (externalOutstanding)
      await cleanup("restore owned external model edit", async () => {
        const current = await read(configFile);
        if (current.equals(externalConfig))
          await writeConfig(externalConfig, configBefore);
        else
          assert.ok(
            current.equals(configBefore),
            "Cleanup may only revert the helper's exact external edit",
          );
        externalOutstanding = false;
      });
    if (providerDirty)
      await cleanup(
        "restore synthetic provider and native synchronization",
        async () => {
          await guard();
          await native("save_provider", { input: providerInput(fixtureKey) });
          const results = await native("sync_provider_targets", { providerId });
          assert.ok(
            results.every((result) => result.success),
            "Native cleanup must report every failed target",
          );
          const restored = await poll(
            overview,
            allApplied,
            "Native cleanup restored owned applications",
          );
          providerPreserved(restored);
          protectedFiles(await snapshot(restored), fixtureKey);
          providerDirty = false;
        },
      );
    if (flowFailure)
      await cleanup("defer remaining real restart prompts", async () => {
        if (await editor.isVisible()) {
          const cancel = editor.getByRole("button", {
            name: "取消",
            exact: true,
          });
          if (await cancel.isEnabled()) await cancel.click();
        }
        await deferRestarts("failure-cleanup");
      });
    if (flowFailure || cleanupFailures.length)
      await cleanup("record sync retry cleanup", () =>
        record("native-sync-retry-cleanup", {
          notificationBranchReached: notificationReached,
          notificationRetryCompleted: retryCompleted,
          originalFlowFailed: Boolean(flowFailure),
          originalFlowError: flowFailure ? safeError(flowFailure) : null,
          externalEditRestored: !externalOutstanding,
          originalProviderRestored: !providerDirty,
          cleanupErrors: [...cleanupFailures],
          cleanupUsedAsAcceptanceEvidence: false,
          globalClientRestarted: false,
        }),
      );
  }
  if (flowFailure) throw flowFailure;
  assert.equal(
    cleanupFailures.length,
    0,
    "Sync retry cleanup must complete without errors",
  );
  assert.equal(
    notificationReached && retryCompleted,
    true,
    "The real failure notification retry branch is mandatory",
  );
}
