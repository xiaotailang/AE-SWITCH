import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSurfaceOwnedRoot } from "./native-surface-extra.mjs";

const fixtureKey = "ae-switch-synthetic-native-management-key";
const targetIds = ["codex", "claude_desktop", "claude_cli"];
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
const hash = (value) => createHash("sha256").update(value).digest("hex");

async function poll(read, predicate, label, timeout = 45000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.fail(`${label} was not observed`);
}

// Call after verifySyncRetry, before releasing the three simultaneous owned
// applications. Saves of the independent options provider are provider-only.
export async function verifyOptionsExtras({
  page,
  invoke,
  record,
  providerId,
  fixtureDirectory,
}) {
  let protectedFlowStarted = false;
  try {
    const workspace = path.resolve(
      fileURLToPath(new URL("../../", import.meta.url)),
    );
    assert.ok(path.isAbsolute(fixtureDirectory));
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
    assert.match(workspace, /^G:[\\/]/iu);
    assert.ok(
      samePath(
        path.dirname(fixture),
        path.join(root, "data/native-ui-fixtures"),
      ),
    );
    assert.match(path.basename(fixture), /^[a-f0-9-]{36}$/iu);
    assert.match(providerId, /^[a-f0-9-]{36}$/iu);
    assert.ok(samePath(process.env.AE_NATIVE_EXPECTED_ROOT, root));

    async function ordinary(location, missing = false) {
      assert.ok(
        within(root, location),
        "Options paths must stay inside the owned root",
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
    const read = async (location, missing = false) => {
      const info = await ordinary(location, missing);
      if (!info) return null;
      assert.ok(info.isFile());
      assert.ok(info.size < 4 * 1024 * 1024);
      return fs.readFile(location);
    };
    async function ownership() {
      await validateSurfaceOwnedRoot(root);
      const owner = JSON.parse(
        (await read(path.join(root, ".ae-native-e2e-owner.json"))).toString(
          "utf8",
        ),
      );
      assert.equal(owner.id, rootId);
      assert.equal(
        owner.purpose,
        "AE Switch owned native UI and real tool acceptance",
      );
      assert.ok(samePath(owner.workspace, workspace));
      const marker = JSON.parse(
        (await read(path.join(fixture, ".ae-native-ui-owner.json"))).toString(
          "utf8",
        ),
      );
      assert.equal(marker.purpose, "synthetic native UI acceptance");
      assert.ok(Number.isFinite(Date.parse(marker.createdAt)));
    }
    const native = async (command, args = {}) => {
      const response = await invoke(command, args);
      assert.ok(
        response.ok,
        `${command} failed (${response.error?.code || "native_error"})`,
      );
      return response.result;
    };
    const overview = () => native("get_overview");
    const target = (value, id) => {
      const result = value.targets.find((item) => item.target === id);
      assert.ok(result);
      return result;
    };
    function validateTargets(value) {
      assert.ok(samePath(value.dataDirectory, path.join(root, "data")));
      assert.deepEqual(
        value.targets.map((item) => item.target).sort(),
        [...targetIds].sort(),
      );
      for (const id of targetIds) {
        const current = target(value, id);
        assert.ok(samePath(current.directory, path.join(fixture, id)));
        for (const file of current.files)
          assert.ok(within(current.directory, file));
      }
    }
    async function snapshot(value) {
      validateTargets(value);
      const files = new Map();
      let directories = 0;
      async function walk(directory) {
        assert.ok(
          ++directories <= 200,
          "Options fixture trees must be bounded",
        );
        assert.ok((await ordinary(directory)).isDirectory());
        for (const name of (await fs.readdir(directory)).sort()) {
          const location = path.join(directory, name);
          const info = await ordinary(location);
          if (info.isDirectory()) await walk(location);
          else {
            assert.ok(files.size < 200);
            files.set(
              path.relative(fixture, location).split(path.sep).join("/"),
              await read(location),
            );
          }
        }
      }
      for (const id of targetIds) await walk(target(value, id).directory);
      for (const file of value.targets.flatMap((item) => item.files)) {
        const relative = path.relative(fixture, file).split(path.sep).join("/");
        if (!files.has(relative)) files.set(relative, await read(file, true));
      }
      return files;
    }
    function exactFiles(expected, actual, ids = targetIds) {
      const selected = (files) =>
        [...files.keys()]
          .filter((key) => ids.some((id) => key.startsWith(`${id}/`)))
          .sort();
      assert.deepEqual(selected(actual), selected(expected));
      for (const relative of selected(expected)) {
        const before = expected.get(relative);
        const after = actual.get(relative);
        assert.ok(
          before === null ? after === null : after?.equals(before),
          `Options must retain bytes: ${relative}`,
        );
      }
    }
    await ownership();
    const initial = await overview();
    validateTargets(initial);
    for (const id of targetIds) {
      const current = target(initial, id);
      assert.equal(current.activeProviderId, providerId);
      assert.equal(current.state, "applied");
      assert.equal(current.canRestore, true);
    }
    const original = initial.providers.find((item) => item.id === providerId);
    assert.ok(original?.hasKey && original.family === "codex");
    assert.match(original.name, /^Synthetic native QA\b/u);
    const supplier = new URL(original.baseUrl);
    assert.equal(supplier.protocol, "http:");
    assert.equal(supplier.hostname, "127.0.0.1");
    assert.ok(Number(supplier.port) > 0 && supplier.pathname === "/v1");
    assert.ok(
      supplier.username +
        supplier.password +
        supplier.search +
        supplier.hash ===
        "",
      "Options must use the owned synthetic supplier without URL credentials",
    );
    assert.equal(original.codexOptions.upstreamProtocol, "openai");
    assert.ok(
      !(original.codexOptions.conversionDisabledTargets ?? []).includes(
        "claude_desktop",
      ),
    );
    const initialFiles = await snapshot(initial);
    const initialAgents = (await native("agent_hub_overview")).agents;
    const initialIds = new Set(initial.providers.map((item) => item.id));
    const secrets = new Set([
      fixtureKey,
      "ae-switch-synthetic-native-baseline-key",
      "ae-switch-synthetic-native-management-rotated-key",
    ]);
    function rememberSecrets(value) {
      if (!value || typeof value !== "object") return;
      for (const [key, item] of Object.entries(value)) {
        if (
          typeof item === "string" &&
          /key|token|authorization/i.test(key) &&
          item
        )
          secrets.add(item);
        else if (item && typeof item === "object") rememberSecrets(item);
      }
    }
    for (const [relative, bytes] of initialFiles) {
      if (bytes && relative.endsWith(".json")) jsonValue(bytes);
    }
    const safeError = (error) => {
      let text = String(error?.message ?? error);
      for (const secret of secrets)
        text = text.split(secret).join("[REDACTED]");
      return text.slice(0, 1500);
    };
    function jsonValue(value) {
      let parsed;
      try {
        parsed = JSON.parse(value.toString().replace(/^\uFEFF/u, ""));
      } catch {
        throw new Error("Options owned configuration must contain valid JSON");
      }
      rememberSecrets(parsed);
      return parsed;
    }
    const listPreferences = () =>
      page.evaluate(() => {
        const value = JSON.parse(
          localStorage.getItem("uni-switch-list-v1") || "null",
        );
        return {
          pinned: Array.isArray(value?.pinned) ? value.pinned : [],
          recent:
            value?.recent && typeof value.recent === "object"
              ? value.recent
              : {},
          autoSync: value?.autoSync === true,
        };
      });
    const initialPreferences = await listPreferences();
    const initialClaudeTarget = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("uni-switch-ui-target-v1") || "null")
        ?.claudeTarget === "claude_cli"
        ? "claude_cli"
        : "claude_desktop",
    );
    const button = (name) => page.getByRole("button", { name, exact: true });
    const card = (id) =>
      page
        .locator("li.provider-card")
        .filter({ has: page.locator(`[data-provider-name="${id}"]`) });
    const codexTab = page.getByRole("tab", { name: /^Codex\b/u });
    const editor = page.getByRole("dialog", {
      name: "编辑供应商",
      exact: true,
    });
    assert.equal(await codexTab.getAttribute("data-state"), "active");
    assert.equal(await page.getByRole("dialog").count(), 0);
    const search = page.getByRole("textbox", {
      name: "搜索 API 配置",
      exact: true,
    });
    if (await search.isVisible()) assert.equal(await search.inputValue(), "");
    async function selectTarget(id) {
      const tab =
        id === "codex"
          ? codexTab
          : page.getByRole("tab", { name: /^Claude Code\b/u });
      await poll(
        () => tab.isEnabled(),
        Boolean,
        "Options target navigation unlocked",
      );
      await tab.click();
      await poll(
        () => tab.getAttribute("data-state"),
        (value) => value === "active",
        "Options target selected",
      );
      if (id !== "codex") {
        const control = button(id === "claude_cli" ? "CLI" : "桌面端");
        await control.click();
        await poll(
          () => control.getAttribute("aria-pressed"),
          (value) => value === "true",
          "Options Claude target selected",
        );
      }
    }
    async function refreshUi() {
      const refresh = button("刷新配置状态");
      await poll(
        () => refresh.isEnabled(),
        Boolean,
        "Options refresh unlocked",
      );
      await refresh.click();
      await poll(
        () => refresh.isEnabled(),
        Boolean,
        "Options refresh completed",
      );
    }
    async function unchanged() {
      const current = await overview();
      assert.ok(
        canonical(
          current.providers.filter((item) => initialIds.has(item.id)),
        ) === canonical(initial.providers),
        "Options provider-only work must retain original providers",
      );
      assert.ok(
        canonical(current.targets) === canonical(initial.targets),
        "Options provider-only work must retain target data and revisions",
      );
      exactFiles(initialFiles, await snapshot(current));
      assert.ok(
        canonical((await native("agent_hub_overview")).agents) ===
          canonical(initialAgents),
      );
      assert.ok(
        canonical(await listPreferences()) === canonical(initialPreferences),
        "Options provider-only saves must retain list preferences",
      );
    }
    async function ready(dialog, model) {
      const selected = dialog.getByRole("checkbox", {
        name: `启用 ${model}`,
        exact: true,
      });
      await selected.waitFor();
      await poll(
        () => dialog.locator(".model-selection").getAttribute("aria-busy"),
        (value) => value === "false",
        "Options real model discovery settled",
      );
      await poll(
        () => dialog.locator(".connection-summary").getAttribute("aria-busy"),
        (value) => value === "false",
        "Options connection settled",
      );
      assert.equal(await selected.isChecked(), true);
      assert.equal(
        await dialog.locator(".connection-summary.has-error").count(),
        0,
      );
    }

    const token = randomUUID();
    const ownName = `Synthetic options ${token}`;
    const ownModel = "gpt-native-options-fixture";
    const ownIds = new Set();
    let endpoint;
    let server;
    let modelRequests = 0;
    let flowFailure;
    let activeStep;
    let conversionTouched = false;
    let conversionFinished = false;
    let desktopBaseline;
    let profileRelative;
    let runtimeMetadataChanges = null;
    const restartReceipts = [];
    async function captureOwned() {
      const current = await overview();
      for (const item of current.providers)
        if (
          !initialIds.has(item.id) &&
          item.name === ownName &&
          item.baseUrl === endpoint
        ) {
          assert.match(item.id, /^[a-f0-9-]{36}$/iu);
          ownIds.add(item.id);
        }
      return current;
    }

    async function matchingDesktopBaseline() {
      const desktop = target(initial, "claude_desktop");
      assert.equal(desktop.files.length, 4);
      const directory = path.join(root, "data/backups");
      assert.ok((await ordinary(directory)).isDirectory());
      const names = await fs.readdir(directory);
      assert.ok(names.length <= 750, "Options backup lookup must be bounded");
      const candidates = [];
      for (const name of names.sort()) {
        if (
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/iu.test(
            name,
          )
        )
          continue;
        const journal = jsonValue(await read(path.join(directory, name)));
        if (
          journal.target !== "claude_desktop" ||
          journal.active !== providerId ||
          !Array.isArray(journal.baseline)
        )
          continue;
        const managed = journal.baseline.filter(
          (file) =>
            typeof file.path === "string" &&
            path.isAbsolute(file.path) &&
            within(desktop.directory, file.path),
        );
        if (
          managed.length !== desktop.files.length ||
          !desktop.files.every(
            (location) =>
              managed.filter((file) => samePath(file.path, location)).length ===
              1,
          )
        )
          continue;
        const originals = new Map();
        let matching = true;
        let profile;
        for (const location of desktop.files) {
          const file = managed.find((item) => samePath(item.path, location));
          const relative = path
            .relative(fixture, location)
            .split(path.sep)
            .join("/");
          const captured = initialFiles.get(relative);
          if (
            !["json", "meta"].includes(file.format) ||
            typeof file.original !== "string" ||
            typeof file.expected !== "string" ||
            !captured ||
            captured.toString("utf8").replace(/^\uFEFF/u, "") !== file.expected
          ) {
            matching = false;
            break;
          }
          const originalDocument = jsonValue(file.original);
          assert.ok(
            originalDocument &&
              typeof originalDocument === "object" &&
              !Array.isArray(originalDocument),
            "Options require four existing JSON object baselines",
          );
          originals.set(relative, originalDocument);
          if (
            Array.isArray(file.keys) &&
            file.keys.includes("inferenceGatewayBaseUrl") &&
            file.keys.includes("inferenceGatewayApiKey")
          ) {
            assert.ok(!profile, "Options require one managed desktop profile");
            profile = relative;
          }
        }
        if (matching && profile) candidates.push({ originals, profile });
      }
      assert.ok(
        candidates.length > 0,
        "Options require an existing Rust journal baseline matching every current Desktop byte",
      );
      const selected = candidates[0];
      for (const candidate of candidates)
        assert.ok(
          candidate.profile === selected.profile &&
            canonical([...candidate.originals]) ===
              canonical([...selected.originals]),
          "Options must not choose an ambiguous stale Desktop baseline",
        );
      return selected;
    }

    function originalProviders(current, desktopDisabled) {
      const retained = current.providers.filter((item) =>
        initialIds.has(item.id),
      );
      assert.equal(retained.length, initial.providers.length);
      for (const expected of initial.providers) {
        const actual = retained.find((item) => item.id === expected.id);
        assert.ok(actual, "Options must retain every original provider");
        if (expected.id !== providerId) {
          assert.ok(
            canonical(actual) === canonical(expected),
            "Options conversion must retain unrelated provider summaries",
          );
          continue;
        }
        const disabled = actual.codexOptions.conversionDisabledTargets ?? [];
        assert.equal(
          disabled.filter((id) => id === "claude_desktop").length,
          desktopDisabled ? 1 : 0,
        );
        assert.ok(
          Number.isFinite(actual.updatedAt) &&
            actual.updatedAt >= expected.updatedAt,
        );
        const normalized = structuredClone(actual);
        normalized.updatedAt = expected.updatedAt;
        const retainedDisabledTargets = disabled.filter(
          (id) => id !== "claude_desktop",
        );
        if (retainedDisabledTargets.length)
          normalized.codexOptions.conversionDisabledTargets =
            retainedDisabledTargets;
        else delete normalized.codexOptions.conversionDisabledTargets;
        assert.ok(
          canonical(normalized) === canonical(expected),
          "Options conversion may change only Desktop conversion membership and updatedAt",
        );
      }
      return retained.find((item) => item.id === providerId);
    }

    async function unrelatedConfiguration(current, files) {
      validateTargets(current);
      const ids = ["codex", "claude_cli"];
      const messages = new Map([
        [
          "配置已写入。请完全退出客户端，再重新打开以使用新配置。",
          "applied-restart-required",
        ],
        ["添加一组 API 配置，然后应用到此客户端。", "unmanaged"],
        [
          "API 字段已被其他工具修改。请先撤回其他工具的修改，再重试；现有文件未被覆盖。",
          "external-change",
        ],
        [
          "此配置已编辑。点击重新应用，让客户端使用保存后的内容。",
          "saved-changes",
        ],
      ]);
      const models = new Set(
        initial.providers.flatMap((item) => [
          item.model,
          ...(item.codexOptions.models ?? []).map((model) => model.id),
        ]),
      );
      const statusProjection = (value) => ({
        target: value.target,
        state: [
          "applied",
          "unmanaged",
          "external_change",
          "saved_changes",
          "error",
        ].includes(value.state)
          ? value.state
          : "other",
        message: messages.get(value.message) ?? "other",
        activeProviderId:
          value.activeProviderId === null ||
          initialIds.has(value.activeProviderId) ||
          ownIds.has(value.activeProviderId)
            ? value.activeProviderId
            : "other-provider",
        appliedModel:
          value.appliedModel === null || models.has(value.appliedModel)
            ? value.appliedModel
            : "other-model",
        configurationRevision: Number.isFinite(value.configurationRevision)
          ? value.configurationRevision
          : "other",
        canRestore:
          typeof value.canRestore === "boolean" ? value.canRestore : "other",
        files: value.files.map((file) =>
          path.relative(fixture, file).split(path.sep).join("/"),
        ),
      });
      const fileMetadata = (snapshot, relative) => {
        const bytes = snapshot.get(relative);
        return {
          listed: snapshot.has(relative),
          present: bytes != null,
          sha256: bytes == null ? null : hash(bytes),
        };
      };
      const fileHashDifferences = [
        ...new Set([...initialFiles.keys(), ...files.keys()]),
      ]
        .filter((relative) => ids.some((id) => relative.startsWith(`${id}/`)))
        .sort()
        .map((relative) => ({
          relative,
          before: fileMetadata(initialFiles, relative),
          after: fileMetadata(files, relative),
        }))
        .filter((item) => canonical(item.before) !== canonical(item.after));
      await record("native-options-unrelated-target-diagnostics", {
        diagnosticOnly: true,
        observedFor: activeStep,
        targetStatusSnapshots: ids.map((id) => {
          const before = target(initial, id);
          const after = target(current, id);
          return {
            target: id,
            before: statusProjection(before),
            after: statusProjection(after),
            changedFields: [
              "directory",
              "files",
              "activeProviderId",
              "state",
              "canRestore",
              "message",
              "appliedModel",
              "configurationRevision",
            ].filter(
              (field) => canonical(before[field]) !== canonical(after[field]),
            ),
          };
        }),
        fileHashDifferences,
      });
      for (const id of ["codex", "claude_cli"])
        assert.ok(
          canonical(target(current, id)) === canonical(target(initial, id)),
          "Options Desktop conversion must retain other target status and revisions",
        );
      exactFiles(initialFiles, files, ["codex", "claude_cli"]);
      assert.ok(
        canonical((await native("agent_hub_overview")).agents) ===
          canonical(initialAgents),
        "Options must retain independent Agent Hub configurations",
      );
      const preferences = await listPreferences();
      const normalized = structuredClone(preferences);
      if (Object.hasOwn(initialPreferences.recent, providerId))
        normalized.recent[providerId] = initialPreferences.recent[providerId];
      else delete normalized.recent[providerId];
      assert.ok(
        canonical(normalized) === canonical(initialPreferences),
        "Options must retain pinned, autoSync and unrelated recent preferences",
      );
      if (Object.hasOwn(preferences.recent, providerId))
        assert.ok(
          Number.isFinite(preferences.recent[providerId]) &&
            preferences.recent[providerId] >=
              (initialPreferences.recent[providerId] || 0),
        );
      return preferences;
    }

    function restoredDesktopFiles(files) {
      const names = (items) =>
        [...items.keys()]
          .filter((name) => name.startsWith("claude_desktop/"))
          .sort();
      assert.deepEqual(names(files), names(initialFiles));
      for (const [relative, expected] of desktopBaseline) {
        const bytes = files.get(relative);
        assert.ok(
          bytes,
          "Options Desktop restore must retain each existing baseline file",
        );
        assert.ok(
          canonical(jsonValue(bytes)) === canonical(expected),
          `Options conversion off must restore the actual journal baseline: ${relative}`,
        );
      }
      const unrelated = (items) =>
        new Map([...items].filter(([name]) => !desktopBaseline.has(name)));
      exactFiles(unrelated(initialFiles), unrelated(files), ["claude_desktop"]);
    }

    function normalizeBridge(document) {
      const normalized = structuredClone(document);
      assert.ok(
        typeof normalized.inferenceGatewayApiKey === "string" &&
          normalized.inferenceGatewayApiKey.length > 0,
        "Options Desktop reapply must contain its native bridge credential",
      );
      secrets.add(normalized.inferenceGatewayApiKey);
      let url;
      try {
        url = new URL(normalized.inferenceGatewayBaseUrl);
      } catch {
        throw new Error("Options native bridge URL must be valid");
      }
      assert.ok(
        url.protocol === "http:" &&
          url.hostname === "127.0.0.1" &&
          Number(url.port) > 0 &&
          Number(url.port) <= 65535 &&
          url.username + url.password + url.search + url.hash === "",
        "Options native bridge must remain a credential-free loopback HTTP endpoint",
      );
      // Only the native listener port and generated credential may rotate.
      // The protocol, hostname, pathname and every other profile value remain compared.
      url.port = "1";
      normalized.inferenceGatewayBaseUrl = url.href;
      normalized.inferenceGatewayApiKey = "[native bridge credential]";
      return normalized;
    }

    async function preserved(requireAdvanced = false) {
      const current = await overview();
      const retained = originalProviders(current, false);
      const files = await snapshot(current);
      const preferences = await unrelatedConfiguration(current, files);
      const desktop = target(current, "claude_desktop");
      const initialDesktop = target(initial, "claude_desktop");
      const normalized = {
        ...desktop,
        configurationRevision: initialDesktop.configurationRevision,
      };
      assert.ok(
        canonical(normalized) === canonical(initialDesktop),
        "Options reapply must retain Desktop status, model, directory and restore capability",
      );
      assert.ok(
        Number.isFinite(desktop.configurationRevision) &&
          desktop.configurationRevision >= initialDesktop.configurationRevision,
      );
      if (requireAdvanced)
        assert.ok(
          desktop.configurationRevision > initialDesktop.configurationRevision,
        );
      const desktopNames = (items) =>
        [...items.keys()]
          .filter((name) => name.startsWith("claude_desktop/"))
          .sort();
      assert.deepEqual(desktopNames(files), desktopNames(initialFiles));
      for (const relative of desktopNames(initialFiles)) {
        const before = initialFiles.get(relative);
        const after = files.get(relative);
        if (before === null) {
          assert.ok(after === null, "Options must retain Desktop file absence");
        } else if (desktopBaseline?.has(relative)) {
          assert.ok(after, "Options must retain every managed Desktop file");
          let expected = jsonValue(before);
          let actual = jsonValue(after);
          if (relative === profileRelative) {
            expected = normalizeBridge(expected);
            actual = normalizeBridge(actual);
          }
          assert.ok(
            canonical(actual) === canonical(expected),
            `Options reapply must preserve configuration semantics: ${relative}`,
          );
        } else {
          assert.ok(
            after?.equals(before),
            `Options must retain unrelated Desktop bytes: ${relative}`,
          );
        }
      }
      const beforeProfile = jsonValue(initialFiles.get(profileRelative));
      const afterProfile = jsonValue(files.get(profileRelative));
      runtimeMetadataChanges = {
        providerUpdatedAtMayChange: true,
        providerUpdatedAtChanged: retained.updatedAt !== original.updatedAt,
        desktopConfigurationRevisionAdvanced:
          desktop.configurationRevision > initialDesktop.configurationRevision,
        configurationRevisionBefore: initialDesktop.configurationRevision,
        configurationRevisionAfter: desktop.configurationRevision,
        nativeBridgePortOrTokenMayChange: true,
        nativeBridgePortChanged:
          new URL(beforeProfile.inferenceGatewayBaseUrl).port !==
          new URL(afterProfile.inferenceGatewayBaseUrl).port,
        nativeBridgeTokenChanged:
          beforeProfile.inferenceGatewayApiKey !==
          afterProfile.inferenceGatewayApiKey,
        recentActivityTimestampMayChange: true,
        recentActivityTimestampChanged:
          preferences.recent[providerId] !==
          initialPreferences.recent[providerId],
      };
      return current;
    }

    async function deferDesktopRestart(phase) {
      const runtime = await native("get_runtime_status", {
        target: "claude_desktop",
      });
      assert.equal(runtime.target, "claude_desktop");
      const required =
        runtime.desktopRunning === true &&
        runtime.desktopRestartRequired === true;
      const dialog = page.getByRole("dialog", {
        name: "重启 Claude Code 桌面端 使配置生效",
        exact: true,
      });
      if (required) await dialog.waitFor({ state: "visible", timeout: 45000 });
      // Let the completed action's React effects render before classifying an absent prompt.
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      const shown = await dialog.isVisible();
      if (shown) {
        await dialog
          .getByRole("button", { name: "稍后重启", exact: true })
          .click();
        await dialog.waitFor({ state: "hidden" });
      }
      assert.ok(
        !required || shown,
        "The native Desktop restart condition requires a real dialog",
      );
      assert.equal(await page.getByRole("dialog").count(), 0);
      const receipt = {
        passed: true,
        phase,
        target: "claude_desktop",
        nativeDesktopRunning: runtime.desktopRunning === true,
        nativeDesktopRestartRequired: runtime.desktopRestartRequired === true,
        nativeConditionRequiresPrompt: required,
        actualPromptShown: shown,
        actualLaterClicked: shown,
        configurationRevision: runtime.configurationRevision,
        processRestarted: false,
        absentPromptNotCountedAsLaterClick: !shown,
      };
      restartReceipts.push(receipt);
      await record("native-options-restart-deferred", receipt);
      return receipt;
    }

    protectedFlowStarted = true;
    try {
      activeStep = "native-options-edit-key-toggle-cancel";
      await card(providerId)
        .getByRole("button", { name: `编辑 ${original.name}`, exact: true })
        .click();
      const keyInput = editor.locator("#apiKey");
      assert.equal(await keyInput.inputValue(), "");
      assert.equal(await keyInput.getAttribute("type"), "password");
      await keyInput.fill(fixtureKey);
      await editor
        .getByRole("button", { name: "显示 API Key", exact: true })
        .click();
      assert.equal(await keyInput.getAttribute("type"), "text");
      assert.ok(
        (await keyInput.inputValue()) === fixtureKey,
        "Only the known synthetic edit key may be revealed",
      );
      const hide = editor.getByRole("button", {
        name: "隐藏 API Key",
        exact: true,
      });
      assert.equal(await hide.getAttribute("aria-pressed"), "true");
      await hide.click();
      assert.equal(await keyInput.getAttribute("type"), "password");
      assert.equal(
        await editor
          .getByRole("button", { name: "显示 API Key", exact: true })
          .getAttribute("aria-pressed"),
        "false",
      );
      await editor.getByRole("button", { name: "取消", exact: true }).click();
      await editor.waitFor({ state: "hidden" });
      await unchanged();
      await record(activeStep, {
        passed: true,
        providerId,
        savedKeyNotEchoed: true,
        actualSyntheticShowAndHideClicked: true,
        cancelledEditWroteNothing: true,
        screenshotsTaken: false,
      });

      activeStep = "native-options-provider-only-setup";
      server = createServer((request, response) => {
        if (request.method === "GET" && request.url === `/${token}/v1/models`) {
          if (request.headers.authorization !== `Bearer ${fixtureKey}`) {
            response.writeHead(401, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                error: { message: "Synthetic options authentication denied" },
              }),
            );
            return;
          }
          modelRequests++;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              object: "list",
              data: [{ id: ownModel, object: "model" }],
            }),
          );
        } else {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: { message: "No synthetic options balance route" },
            }),
          );
        }
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      endpoint = `http://127.0.0.1:${server.address().port}/${token}/v1`;
      await button("添加供应商").click();
      const create = page.getByRole("dialog", {
        name: "添加供应商",
        exact: true,
      });
      await create.locator("#baseUrl").fill(endpoint);
      await create.locator("#apiKey").fill(fixtureKey);
      await create.locator("#name").fill(ownName);
      await create
        .locator('input[type="radio"][name="protocol"][value="openai"]')
        .click();
      await create
        .locator('input[type="radio"][name="authMode"][value="bearer"]')
        .click();
      await ready(create, ownModel);
      await create
        .getByRole("checkbox", {
          name: "只保存供应商，暂不用于当前客户端",
          exact: true,
        })
        .click();
      await create
        .getByRole("button", { name: "保存供应商", exact: true })
        .click();
      await create.waitFor({ state: "hidden", timeout: 60000 });
      const created = (await captureOwned()).providers.find((item) =>
        ownIds.has(item.id),
      );
      assert.ok(created && ownIds.size === 1 && modelRequests > 0);
      assert.equal(created.model, ownModel);
      assert.equal(created.codexOptions.fastMode, null);
      await unchanged();
      await record(activeStep, {
        passed: true,
        providerId: created.id,
        purpose: "independent inactive fixture for Fast form saves",
        setupUsedOrdinaryUiSaveOnly: true,
        nativeSetupUsed: false,
        targetConfigurationUnchanged: true,
        actualRustModelRequests: modelRequests,
        syntheticSupplierInferenceVerified: false,
      });

      activeStep = "native-options-form-fast-three-states";
      const fastStates = [];
      for (const [label, expected] of [
        ["开启", true],
        ["关闭", false],
        ["跟随客户端", null],
      ]) {
        await card(created.id)
          .getByRole("button", { name: `编辑 ${created.name}`, exact: true })
          .click();
        await ready(editor, ownModel);
        const options = editor.locator(
          'fieldset[aria-describedby="fastMode-hint"]',
        );
        assert.equal(
          await options.evaluate((element) => element.disabled),
          false,
        );
        const choice = options.getByRole("radio", { name: label, exact: true });
        await choice.click();
        assert.equal(await choice.isChecked(), true);
        assert.equal(
          await editor
            .getByRole("button", { name: "保存并使用", exact: true })
            .count(),
          0,
        );
        await editor
          .getByRole("button", { name: "保存修改", exact: true })
          .click();
        await editor.waitFor({ state: "hidden", timeout: 60000 });
        const saved = await poll(
          async () =>
            (await overview()).providers.find((item) => item.id === created.id),
          (item) => item?.codexOptions.fastMode === expected,
          "The actual Fast radio save persisted through Rust",
        );
        assert.equal(saved.model, created.model);
        assert.equal(saved.baseUrl, created.baseUrl);
        assert.equal(saved.authMode, created.authMode);
        assert.equal(saved.hasKey, true);
        assert.equal(saved.codexOptions.upstreamProtocol, "openai");
        await unchanged();
        // Reopening proves the committed value initializes the actual form,
        // rather than only observing the same unsaved radio element.
        await card(created.id)
          .getByRole("button", { name: `编辑 ${created.name}`, exact: true })
          .click();
        assert.equal(
          await editor
            .locator('fieldset[aria-describedby="fastMode-hint"]')
            .getByRole("radio", { name: label, exact: true })
            .isChecked(),
          true,
        );
        await editor.getByRole("button", { name: "取消", exact: true }).click();
        await editor.waitFor({ state: "hidden" });
        fastStates.push({
          label,
          savedFastMode: expected,
          actualRadioClickAndProviderOnlySave: true,
          reopenedRadioMatchedRust: true,
        });
      }
      assert.equal(
        (await overview()).providers.find((item) => item.id === created.id)
          .codexOptions.fastMode,
        created.codexOptions.fastMode,
      );
      await record(activeStep, {
        passed: true,
        providerId: created.id,
        states: fastStates,
        originalFollowValueRestored: true,
        allOriginalProvidersTargetBytesAndRevisionsUnchanged: true,
        syntheticSupplierInferenceVerified: false,
      });

      activeStep = "native-options-active-claude-conversion-off";
      const baseline = await matchingDesktopBaseline();
      desktopBaseline = baseline.originals;
      profileRelative = baseline.profile;
      await selectTarget("claude_desktop");
      const conversion = card(providerId).getByRole("switch", {
        name: `转换为 Claude · ${original.name}`,
        exact: true,
      });
      await poll(
        async () => ({
          checked: await conversion.isChecked(),
          enabled: await conversion.isEnabled(),
        }),
        (value) => value.checked && value.enabled,
        "Options active Desktop conversion initially enabled",
      );
      assert.equal(
        await card(providerId).locator(".provider-protocol-hint").textContent(),
        "已启用；关闭会停用并恢复原配置",
      );
      conversionTouched = true;
      await conversion.click();
      const disabled = await poll(
        overview,
        (value) => {
          const desktop = target(value, "claude_desktop");
          return (
            (
              value.providers.find((item) => item.id === providerId)
                ?.codexOptions.conversionDisabledTargets ?? []
            ).includes("claude_desktop") &&
            desktop.activeProviderId === null &&
            desktop.state === "unmanaged" &&
            desktop.canRestore === false
          );
        },
        "Options actual active conversion off restored Desktop through Rust",
      );
      const restoreNotice =
        "协议转换已关闭，已停用此供应商并恢复 Claude Code 桌面端 原来的 API 配置。请按提示重启客户端。";
      await poll(
        () => page.locator(".notice").textContent(),
        (text) => text?.includes(restoreNotice),
        "Options actual conversion restore notice",
      );
      const offRestart = await deferDesktopRestart("active-conversion-off");
      await poll(
        async () => ({
          checked: await conversion.isChecked(),
          enabled: await conversion.isEnabled(),
        }),
        (value) => !value.checked && value.enabled,
        "Options conversion off reflected in unlocked UI",
      );
      assert.equal(
        await card(providerId).locator(".apply-button").isEnabled(),
        false,
      );
      assert.ok(
        target(disabled, "claude_desktop").configurationRevision >
          target(initial, "claude_desktop").configurationRevision,
      );
      originalProviders(disabled, true);
      const restoredFiles = await snapshot(disabled);
      restoredDesktopFiles(restoredFiles);
      await unrelatedConfiguration(disabled, restoredFiles);
      await record(activeStep, {
        passed: true,
        target: "claude_desktop",
        providerId,
        actualActiveSwitchClick: true,
        baselineReadFromExistingRustJournal: true,
        baselineMatchedAllCurrentTargetBytes: true,
        restoredBaselineFileSemanticHashes: Object.fromEntries(
          [...desktopBaseline].map(([relative, value]) => [
            relative,
            hash(canonical(value)),
          ]),
        ),
        actualRestoreNoticeObserved: true,
        activeProviderCleared: true,
        targetUnmanagedAndCannotRestoreAgain: true,
        applyButtonDisabled: true,
        otherTargetBytesAndRevisionsUnchanged: true,
        providerChangedOnlyConversionMembershipAndUpdatedAt: true,
        restart: offRestart,
        syntheticSupplierInferenceVerified: false,
      });

      activeStep = "native-options-active-claude-conversion-reapply";
      await conversion.click();
      const enabled = await poll(
        overview,
        (value) => {
          const provider = value.providers.find(
            (item) => item.id === providerId,
          );
          return (
            provider &&
            !(provider.codexOptions.conversionDisabledTargets ?? []).includes(
              "claude_desktop",
            )
          );
        },
        "Options conversion setting re-enabled through Rust",
      );
      await poll(
        async () => ({
          checked: await conversion.isChecked(),
          enabled: await conversion.isEnabled(),
        }),
        (value) => value.checked && value.enabled,
        "Options conversion on reflected in unlocked UI",
      );
      originalProviders(enabled, false);
      assert.ok(
        canonical(target(enabled, "claude_desktop")) ===
          canonical(target(disabled, "claude_desktop")),
        "Options enabling conversion must not automatically reapply Desktop",
      );
      exactFiles(restoredFiles, await snapshot(enabled));
      await unrelatedConfiguration(enabled, restoredFiles);
      const use = card(providerId).getByRole("button", {
        name: "使用",
        exact: true,
      });
      await poll(
        () => use.isEnabled(),
        Boolean,
        "Options actual Desktop use button unlocked",
      );
      await use.click();
      const reapplied = await poll(
        overview,
        (value) => {
          const desktop = target(value, "claude_desktop");
          return (
            desktop.activeProviderId === providerId &&
            desktop.state === "applied" &&
            desktop.canRestore === true &&
            desktop.appliedModel ===
              target(initial, "claude_desktop").appliedModel &&
            desktop.configurationRevision >
              target(disabled, "claude_desktop").configurationRevision
          );
        },
        "Options actual use reapplied the original Desktop provider and model",
      );
      await poll(
        () => page.locator(".notice").textContent(),
        (text) => text?.includes("配置已写入 Claude Code 桌面端。"),
        "Options actual Desktop reapply notice",
      );
      const onRestart = await deferDesktopRestart("active-conversion-reapply");
      await poll(
        () => conversion.isEnabled(),
        Boolean,
        "Options Desktop reapply UI unlocked",
      );
      await preserved(true);
      conversionFinished = true;
      await record(activeStep, {
        passed: true,
        target: "claude_desktop",
        providerId,
        actualSwitchEnabledAndUseButtonClicked: true,
        enablingAloneDidNotWriteTarget: true,
        originalProviderAndModelReapplied: true,
        originalConfigurationSemanticsPreserved: true,
        managedDesktopFilesPreserved: desktopBaseline.size,
        desktopRestoreCapabilityPreserved: true,
        otherTargetBytesAndRevisionsUnchanged: true,
        configurationRevisionAfter: target(reapplied, "claude_desktop")
          .configurationRevision,
        runtimeMetadataChanges,
        restart: onRestart,
        nativeSetupUsedAsConversionEvidence: false,
        syntheticSupplierInferenceVerified: false,
      });
      activeStep = null;
    } catch (error) {
      flowFailure = error;
      if (activeStep)
        await record(activeStep, {
          passed: false,
          failure: safeError(error),
          ownProviderIds: [...ownIds],
          actualRustModelRequests: modelRequests,
        });
    } finally {
      const cleanupErrors = [];
      const attempt = async (action) => {
        try {
          await action();
        } catch (error) {
          cleanupErrors.push(safeError(error));
        }
      };
      await attempt(async () => {
        const modal = page.getByRole("dialog");
        if (await modal.count()) {
          const later = modal.getByRole("button", {
            name: "稍后重启",
            exact: true,
          });
          const cancel = modal.getByRole("button", {
            name: "取消",
            exact: true,
          });
          const close = (await later.count())
            ? later
            : (await cancel.count())
              ? cancel
              : modal.getByRole("button", { name: "关闭弹窗", exact: true });
          await poll(
            () => close.isEnabled(),
            Boolean,
            "Options cleanup modal unlocked",
          );
          await close.click();
          await modal.waitFor({ state: "hidden" });
        }
      });
      if (conversionTouched)
        await attempt(async () => {
          const operations = [];
          try {
            await ownership();
            let current = await overview();
            validateTargets(current);
            const provider = current.providers.find(
              (item) => item.id === providerId,
            );
            assert.ok(
              provider,
              "Options conversion cleanup requires its original provider",
            );
            const disabled = (
              provider.codexOptions.conversionDisabledTargets ?? []
            ).includes("claude_desktop");
            originalProviders(current, disabled);
            const files = await snapshot(current);
            await unrelatedConfiguration(current, files);
            const desktop = target(current, "claude_desktop");
            assert.ok(
              (desktop.state === "unmanaged" &&
                desktop.activeProviderId === null &&
                !desktop.canRestore) ||
                (desktop.state === "applied" &&
                  desktop.activeProviderId === providerId &&
                  desktop.canRestore),
              "Options cleanup must not bypass external-change or pending-change protection",
            );
            if (desktop.state === "unmanaged") restoredDesktopFiles(files);
            if (disabled) {
              await native("set_protocol_conversion", {
                expected: provider,
                target: "claude_desktop",
                enabled: true,
              });
              operations.push("set_protocol_conversion");
              current = await overview();
              originalProviders(current, false);
            }
            if (target(current, "claude_desktop").state === "unmanaged") {
              await native("apply_provider", {
                target: "claude_desktop",
                providerId,
              });
              operations.push("apply_provider");
            }
            if (operations.length || !conversionFinished) {
              await preserved();
              await record("native-options-conversion-cleanup", {
                passed: true,
                target: "claude_desktop",
                providerId,
                operations,
                purpose:
                  "restore owned original state after an incomplete UI branch",
                nativeCleanupOnly: true,
                uiAcceptanceClaimed: false,
                conversionUiFinished: conversionFinished,
              });
            }
          } catch (error) {
            await record("native-options-conversion-cleanup", {
              passed: false,
              operations,
              nativeCleanupOnly: true,
              uiAcceptanceClaimed: false,
              failure: safeError(error),
            });
            throw error;
          }
        });
      await attempt(async () => {
        const current = await captureOwned();
        for (const item of current.providers.filter((item) =>
          ownIds.has(item.id),
        )) {
          assert.ok(
            !initialIds.has(item.id) &&
              item.name === ownName &&
              item.baseUrl === endpoint,
          );
          assert.ok(
            current.targets.every(
              (entry) => entry.activeProviderId !== item.id,
            ),
          );
          await native("delete_provider", { providerId: item.id });
        }
      });
      if (server)
        await attempt(async () => {
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
        });
      await attempt(async () => {
        if (conversionTouched) await selectTarget(initialClaudeTarget);
        await selectTarget("codex");
        await refreshUi();
        if (conversionTouched) {
          await preserved();
          const prompt = page.getByRole("dialog", {
            name: "重启 Claude Code 桌面端 使配置生效",
            exact: true,
          });
          if (await prompt.isVisible()) {
            await prompt
              .getByRole("button", { name: "稍后重启", exact: true })
              .click();
            await prompt.waitFor({ state: "hidden" });
          }
        } else await unchanged();
        const final = await overview();
        assert.deepEqual(
          final.providers.map((item) => item.id).sort(),
          [...initialIds].sort(),
        );
        assert.equal(await page.getByRole("dialog").count(), 0);
      });
      await record("native-options-extras-restored", {
        passed: cleanupErrors.length === 0,
        ownProviderCount: ownIds.size,
        onlyOwnInactiveProvidersRemoved: cleanupErrors.length === 0,
        originalProviderAndTargetConfigurationPreserved:
          cleanupErrors.length === 0,
        conversionTouched,
        conversionFinished,
        runtimeMetadataChanges,
        restartReceipts,
        actualRustModelRequests: modelRequests,
        nativeCleanupNotUsedAsUiAcceptance: true,
        screenshotsTaken: false,
        cleanupErrors,
        flowFailure: flowFailure ? safeError(flowFailure) : null,
      });
      if (!flowFailure && cleanupErrors.length)
        flowFailure = new Error(
          "Options helper cleanup did not restore its owned state",
        );
    }
    if (flowFailure) throw flowFailure;
  } catch (error) {
    if (!protectedFlowStarted) {
      await record("native-options-extras-entry-failed", {
        passed: false,
        phase: "owned-preconditions",
        failure: "Options entry validation failed before any UI writes",
        noUiWritesStarted: true,
        nativeCleanupUsed: false,
        screenshotsTaken: false,
      });
      throw new Error("Options entry validation failed before any UI writes");
    }
    throw error;
  }
}
