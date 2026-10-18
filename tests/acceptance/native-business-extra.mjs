import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { validateSurfaceOwnedRoot } from "./native-surface-extra.mjs";

export function assertCodexContextOverrides(
  config,
  { contextWindow, compactTokenLimit, perModelContext },
) {
  // Only the root TOML scope affects these global overrides. A similarly named
  // key in a provider or profile cannot satisfy preservation of the root key.
  const rootScope = config.split(/^\s*\[/mu, 1)[0];
  if (perModelContext)
    assert.doesNotMatch(rootScope, /^model_context_window\s*=/mu);
  else
    assert.match(
      rootScope,
      new RegExp(`^model_context_window = ${contextWindow}$`, "mu"),
    );
  assert.match(
    rootScope,
    new RegExp(`^model_auto_compact_token_limit = ${compactTokenLimit}$`, "mu"),
  );
}

// Real UI commits and native state only. Called after the owner has validated
// this QA instance; cleanup never targets an original provider or client tree.
export async function verifyBusinessExtras({
  page,
  native,
  record,
  expectedRoot,
  fixtureDirectory,
  fixtureKey,
}) {
  assert.match(fixtureKey, /^ae-switch-synthetic-/u);
  const { root, id: rootId } = await validateSurfaceOwnedRoot(expectedRoot);
  const fixture = path.resolve(fixtureDirectory);
  const samePath = (left, right) =>
    path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
  const contained = (location) => {
    const relative = path.relative(root, path.resolve(location));
    return (
      !path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`)
    );
  };
  assert.doesNotMatch(root, /^C:[\\/]/iu);
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

  async function plain(location, allowMissing = false) {
    assert.ok(
      contained(location),
      "Business paths must stay within the verified owned root",
    );
    assert.ok(samePath(await fs.realpath(root), root));
    const rootInfo = await fs.lstat(root);
    assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink());
    let current = root;
    for (const part of path
      .relative(root, path.resolve(location))
      .split(path.sep)
      .filter(Boolean)) {
      current = path.join(current, part);
      let info;
      try {
        info = await fs.lstat(current);
      } catch (error) {
        if (allowMissing && error.code === "ENOENT") return false;
        throw error;
      }
      assert.equal(
        info.isSymbolicLink(),
        false,
        "Business paths may not traverse links",
      );
      assert.ok(info.isFile() || info.isDirectory());
      if (info.isFile())
        assert.equal(info.nlink, 1, "Business files may not be hard linked");
      assert.ok(samePath(await fs.realpath(current), current));
    }
    return true;
  }
  async function read(location) {
    if (!(await plain(location, true))) return null;
    return fs.readFile(location);
  }
  await plain(path.join(root, ".ae-native-e2e-owner.json"));
  const rootOwner = JSON.parse(
    await fs.readFile(path.join(root, ".ae-native-e2e-owner.json"), "utf8"),
  );
  assert.equal(rootOwner.id, rootId);
  assert.equal(
    rootOwner.purpose,
    "AE Switch owned native UI and real tool acceptance",
  );
  await plain(path.join(fixture, ".ae-native-ui-owner.json"));
  const fixtureOwner = JSON.parse(
    await fs.readFile(path.join(fixture, ".ae-native-ui-owner.json"), "utf8"),
  );
  assert.equal(fixtureOwner.purpose, "synthetic native UI acceptance");
  const initial = await native("get_overview");
  assert.ok(samePath(initial.dataDirectory, path.join(root, "data")));
  for (const target of initial.targets) {
    assert.ok(samePath(target.directory, path.join(fixture, target.target)));
    assert.equal(target.activeProviderId, null);
    assert.equal(target.canRestore, false);
    assert.equal(target.state, "unmanaged");
  }
  assert.equal(
    await page
      .getByRole("tab", { name: /^Codex\b/u })
      .getAttribute("data-state"),
    "active",
  );
  const initialCodex = initial.targets.find(
    (value) => value.target === "codex",
  );
  assert.ok(initialCodex);
  const originals = new Map();
  for (const location of new Set([
    ...initial.targets.flatMap((value) => value.files),
    path.join(initialCodex.directory, "auth.json"),
  ]))
    originals.set(location, await read(location));
  const originalConfig = originals.get(
    path.join(initialCodex.directory, "config.toml"),
  );
  const baselineAuth = originals.get(
    path.join(initialCodex.directory, "auth.json"),
  );
  assert.ok(originalConfig && baselineAuth);
  // The independent business fixture starts with real client overrides. Normal
  // connection/model discovery must retain them; explicit context edits own
  // removal of only the context override and its eventual restoration.
  assert.doesNotMatch(
    originalConfig.toString("utf8"),
    /^(model_context_window|model_auto_compact_token_limit)\s*=/mu,
  );
  const baselineContext = 64000;
  const baselineCompact = 48000;
  const baselineConfig = Buffer.concat([
    Buffer.from(
      `model_context_window = ${baselineContext}\nmodel_auto_compact_token_limit = ${baselineCompact}\n`,
    ),
    originalConfig,
  ]);
  const baselineCatalog =
    originals.get(
      path.join(initialCodex.directory, "uni-switch-models.json"),
    ) ?? null;
  const token = randomUUID();
  const businessRoot = path.join(fixture, `business-${token}`);
  const businessCodex = path.join(businessRoot, "codex");
  const configFile = path.join(businessCodex, "config.toml");
  const authFile = path.join(businessCodex, "auth.json");
  const catalogFile = path.join(businessCodex, "uni-switch-models.json");
  const names = {
    saved: `Synthetic business saved ${token}`,
    duplicate: `Synthetic business duplicate ${token}`,
    applied: `Synthetic business applied ${token}`,
  };
  const models = {
    saved: "gpt-native-business-saved",
    applied: "gpt-native-business-applied",
  };
  const button = (name) => page.getByRole("button", { name, exact: true });
  const settings = page.getByRole("dialog", {
    name: "Codex 设置",
    exact: true,
  });
  const ownIds = new Set();
  const initialIds = new Set(initial.providers.map((value) => value.id));
  let server;
  let endpoints;
  let modelRequests = 0;
  let failure;
  let fallbackCleanup = false;

  async function poll(readValue, predicate, label, timeout = 45000) {
    const deadline = Date.now() + timeout;
    do {
      const value = await readValue();
      if (predicate(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.fail(`${label} was not observed`);
  }
  const codex = async () =>
    (await native("get_overview")).targets.find(
      (value) => value.target === "codex",
    );
  async function captureOwned() {
    const overview = await native("get_overview");
    if (endpoints)
      for (const value of overview.providers) {
        if (
          !initialIds.has(value.id) &&
          value.family === "codex" &&
          (([names.saved, names.duplicate].includes(value.name) &&
            value.baseUrl === endpoints.saved &&
            value.model === models.saved) ||
            (value.name === names.applied &&
              value.baseUrl === endpoints.applied &&
              // Either fixture model is owned even if default selection failed.
              [models.applied, models.saved].includes(value.model)))
        )
          ownIds.add(value.id);
      }
    return overview;
  }
  async function assertOriginalFiles() {
    for (const [location, bytes] of originals) {
      const current = await read(location);
      assert.ok(
        bytes === null ? current === null : current?.equals(bytes),
        "Business flow must not change an original client file",
      );
    }
  }
  async function assertBusinessBaseline(restored = false) {
    const config = await read(configFile);
    assert.ok(config);
    const configBytesExact = config.equals(baselineConfig);
    if (restored) {
      // Native TOML restore merges managed keys and can normalize blank lines.
      // Every original setting/comment remains required; auth/catalog stay exact.
      const lines = (value) =>
        value
          .toString("utf8")
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter(Boolean);
      assert.deepEqual(
        lines(config),
        lines(baselineConfig),
        "Native restore must preserve every original config setting and comment",
      );
    } else
      assert.equal(
        configBytesExact,
        true,
        "Save-only must not write the business config",
      );
    assert.ok(
      (await read(authFile))?.equals(baselineAuth),
      "Business auth must retain its exact baseline bytes",
    );
    const catalog = await read(catalogFile);
    assert.ok(
      baselineCatalog === null
        ? catalog === null
        : catalog?.equals(baselineCatalog),
      "Business model catalog must restore its original existence and bytes",
    );
    return configBytesExact;
  }
  async function refresh() {
    await poll(
      () => button("刷新配置状态").isEnabled(),
      Boolean,
      "Business refresh unlocked",
    );
    await button("刷新配置状态").click();
    await poll(
      () => button("刷新配置状态").isEnabled(),
      Boolean,
      "Business refresh completed",
    );
  }
  async function setDirectoryUi(directory) {
    await plain(directory);
    await button("设置").click();
    await settings
      .getByRole("button", { name: "修改目录", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "设置配置位置",
      exact: true,
    });
    await dialog
      .getByRole("textbox", { name: "配置目录", exact: true })
      .fill(directory);
    await dialog.getByRole("button", { name: "保存目录", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    const target = await poll(
      codex,
      (value) => samePath(value.directory, directory),
      "UI directory native commit",
    );
    assert.equal(target.state, "unmanaged");
    assert.equal(target.activeProviderId, null);
    await settings.waitFor();
    await poll(
      () => settings.locator(".settings-path").first().innerText(),
      (value) => samePath(value.trim(), directory),
      "UI displayed committed directory",
    );
    await settings
      .getByRole("button", { name: "关闭弹窗", exact: true })
      .click();
    await settings.waitFor({ state: "hidden" });
  }
  async function deferRestart() {
    const dialog = page.getByRole("dialog", {
      name: "重启 Codex 使配置生效",
      exact: true,
    });
    await dialog.waitFor({ timeout: 30000 });
    await dialog.getByRole("button", { name: "稍后重启", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
  }
  async function addUi(kind, onlySave, displayName = names[kind]) {
    const requestsBefore = modelRequests;
    await button("添加供应商").click();
    const dialog = page.getByRole("dialog", {
      name: "添加供应商",
      exact: true,
    });
    await dialog.locator("#baseUrl").fill(endpoints[kind]);
    await dialog.locator("#apiKey").fill(fixtureKey);
    await dialog.locator("#name").fill(displayName);
    await poll(
      () =>
        dialog
          .getByRole("checkbox", { name: `启用 ${models[kind]}`, exact: true })
          .count(),
      (value) => value === 1,
      "Business actual native model discovery",
    );
    await poll(
      () => dialog.locator(".model-selection").getAttribute("aria-busy"),
      (value) => value === "false",
      "Business model discovery settled",
    );
    assert.ok(modelRequests > requestsBefore);
    assert.equal(
      await dialog
        .getByRole("checkbox", { name: `启用 ${models[kind]}`, exact: true })
        .isChecked(),
      true,
    );
    const desiredModel = dialog.locator(".model-choice").filter({
      has: page.getByRole("checkbox", {
        name: `启用 ${models[kind]}`,
        exact: true,
      }),
    });
    assert.equal(await desiredModel.count(), 1);
    const selectDefault = desiredModel.getByRole("button", {
      name: `将 ${models[kind]} 设为默认模型`,
      exact: true,
    });
    if (await selectDefault.count()) await selectDefault.click();
    await poll(
      () => desiredModel.locator(".model-default").count(),
      (value) => value === 1,
      "Business requested default selected through UI",
    );
    assert.equal(await dialog.locator(".model-default").count(), 1);
    assert.equal(
      await dialog
        .locator(".connection-summary")
        .getByText(`默认使用 ${models[kind]}`, { exact: true })
        .count(),
      1,
    );
    const saveOnly = dialog.getByRole("checkbox", {
      name: "只保存供应商，暂不用于当前客户端",
      exact: true,
    });
    assert.equal(await saveOnly.isChecked(), false);
    if (onlySave) await saveOnly.click();
    assert.equal(await saveOnly.isChecked(), onlySave);
    await dialog
      .getByRole("button", {
        name: onlySave ? "保存供应商" : "添加并使用",
        exact: true,
      })
      .click();
    await dialog.waitFor({ state: "hidden", timeout: 60000 });
    return captureOwned();
  }
  async function restoreUi() {
    await button("设置").click();
    await settings
      .getByRole("button", { name: "恢复原配置", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "恢复原来的 API 配置？",
      exact: true,
    });
    await dialog
      .getByRole("button", { name: "恢复原配置", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden", timeout: 45000 });
    await poll(
      codex,
      (value) =>
        value.activeProviderId === null &&
        !value.canRestore &&
        value.state === "unmanaged",
      "Business UI exact restore",
    );
    await deferRestart();
    return assertBusinessBaseline(true);
  }

  try {
    await plain(fixture);
    await fs.mkdir(businessRoot);
    await plain(businessRoot);
    await fs.writeFile(
      path.join(businessRoot, ".ae-native-ui-business-owner.json"),
      JSON.stringify({
        purpose: "synthetic native business acceptance",
        token,
      }),
      { flag: "wx" },
    );
    await fs.mkdir(businessCodex);
    await plain(businessCodex);
    await fs.writeFile(configFile, baselineConfig, { flag: "wx" });
    await fs.writeFile(authFile, baselineAuth, { flag: "wx" });
    if (baselineCatalog)
      await fs.writeFile(catalogFile, baselineCatalog, { flag: "wx" });
    await assertBusinessBaseline();
    server = createServer((request, response) => {
      const kind =
        request.url === "/v1/models"
          ? "saved"
          : request.url === "/alternate/v1/models"
            ? "applied"
            : null;
      if (
        request.method === "GET" &&
        kind &&
        request.headers.authorization === `Bearer ${fixtureKey}`
      ) {
        modelRequests++;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            object: "list",
            data: (kind === "applied"
              ? [models.applied, models.saved]
              : [models.saved]
            ).map((id) => ({
              id,
              object: "model",
              owned_by: "synthetic-native-business",
            })),
          }),
        );
      } else {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: "Synthetic business fixture endpoint unavailable",
            },
          }),
        );
      }
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    endpoints = { saved: `${base}/v1`, applied: `${base}/alternate/v1` };

    await setDirectoryUi(businessCodex);
    await assertOriginalFiles();
    await assertBusinessBaseline();
    await record("native-business-directory-ui-committed", {
      target: "codex",
      ownedDirectory: businessCodex,
      savedThroughUi: true,
      nativeDirectoryMatches: true,
      baselineFilesUntouched: true,
    });
    const beforeSave = await native("get_overview");
    const savedOverview = await addUi("saved", true);
    const saved = savedOverview.providers.find(
      (value) =>
        value.name === names.saved && value.baseUrl === endpoints.saved,
    );
    assert.ok(saved && ownIds.has(saved.id));
    assert.equal(saved.model, models.saved);
    assert.equal(saved.hasKey, true);
    assert.equal(saved.authMode, "bearer");
    assert.equal(saved.codexOptions.upstreamProtocol, "openai");
    assert.ok(!JSON.stringify(saved).includes(fixtureKey));
    assert.equal(savedOverview.providers.length, initial.providers.length + 1);
    assert.deepEqual(savedOverview.targets, beforeSave.targets);
    await assertBusinessBaseline();
    await assertOriginalFiles();
    await record("native-business-add-save-only", {
      providerId: saved.id,
      actualRustHttpModels: true,
      providerSaved: true,
      targetUnchanged: true,
      noClientFilesWritten: true,
      publicSummaryCredentialFree: true,
      realSupplierInferenceVerified: false,
    });

    const duplicateOverview = await addUi("saved", true, names.duplicate);
    await page.getByText(/已复用已有供应商/u).waitFor();
    assert.deepEqual(
      duplicateOverview.providers,
      savedOverview.providers,
      "Identical connection and model settings must reuse the existing provider",
    );
    assert.deepEqual(duplicateOverview.targets, savedOverview.targets);
    await assertBusinessBaseline();
    await record("native-business-duplicate-reused", {
      originalProviderId: saved.id,
      sameIdAndProviderCount: true,
      existingNameAndModelRetained: true,
      matchingConnectionAuthProtocolModelAndOptions: true,
      savedThroughNewForm: true,
      noClientFilesWritten: true,
    });

    const appliedOverview = await addUi("applied", false);
    const applied = appliedOverview.providers.find(
      (value) =>
        value.name === names.applied && value.baseUrl === endpoints.applied,
    );
    assert.ok(applied && ownIds.has(applied.id));
    assert.equal(applied.family, "codex");
    assert.equal(applied.model, models.applied);
    assert.equal(applied.hasKey, true);
    assert.equal(applied.authMode, "bearer");
    assert.equal(applied.codexOptions.upstreamProtocol, "openai");
    assert.equal(applied.codexOptions.perModelContext, false);
    assert.equal(applied.codexOptions.repairReasoningLevels, false);
    assert.deepEqual(
      applied.codexOptions.models
        .map(({ id, enabled, contextWindow }) => ({
          id,
          enabled,
          contextWindow,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      [models.applied, models.saved].sort().map((id) => ({
        id,
        enabled: true,
        contextWindow: 256000,
      })),
    );
    assert.equal(
      appliedOverview.providers.length,
      initial.providers.length + 2,
    );
    const active = await poll(
      codex,
      (value) =>
        value.state === "applied" && value.activeProviderId === applied.id,
      "UI add and use native apply",
    );
    assert.equal(active.canRestore, true);
    assert.equal(active.appliedModel, models.applied);
    assert.ok(samePath(active.directory, businessCodex));
    const config = (await read(configFile)).toString("utf8");
    assert.match(config, /^model_provider = "uni_switch"$/mu);
    assert.ok(
      config.includes(`model = "${models.applied}"`) &&
        config.includes(endpoints.applied) &&
        config.includes(fixtureKey),
    );
    assert.match(config, /native-ui-keep/u);
    assertCodexContextOverrides(config, {
      contextWindow: baselineContext,
      compactTokenLimit: baselineCompact,
      perModelContext: false,
    });
    assert.ok((await read(authFile))?.equals(baselineAuth));
    const catalog = JSON.parse((await read(catalogFile)).toString("utf8"));
    assert.ok(
      catalog.models.some(
        (value) =>
          value.slug === models.applied && value.context_window === 256000,
      ),
    );
    assert.ok(!JSON.stringify(applied).includes(fixtureKey));
    await assertOriginalFiles();
    await deferRestart();
    await record("native-business-add-and-use", {
      providerId: applied.id,
      target: "codex",
      nativeState: active.state,
      appliedModel: models.applied,
      ownedConfigAndCatalogWritten: true,
      authAndOriginalClientFilesRetained: true,
      configSha256: createHash("sha256").update(config).digest("hex"),
      restartDeferred: true,
      clientRestarted: false,
      realSupplierInferenceVerified: false,
    });

    // Only the owned, currently applied Codex business target is changed. The
    // supplier/model list is synthetic; clicks, Rust persistence and files are real.
    const currentAppliedProvider = async () => {
      const value = (await native("get_overview")).providers.find(
        (provider) => provider.id === applied.id,
      );
      assert.ok(value && ownIds.has(value.id));
      return value;
    };
    const fast = page.getByRole("switch", {
      name: `Fast 模式 · ${applied.name}`,
      exact: true,
    });
    const modelTrigger = button(`配置 ${applied.name} 的模型`);
    const configWithoutEdits = (text, perModelContext) => {
      let section = "";
      return text
        .split(/\r?\n/u)
        .filter((line) => {
          const trimmed = line.trim();
          const header = trimmed.match(/^\[([^\]]+)\]$/u);
          if (header) section = header[1];
          if (
            (section === "" && /^(model|service_tier)\s*=/u.test(trimmed)) ||
            (section === "" &&
              perModelContext &&
              /^model_context_window\s*=/u.test(trimmed)) ||
            (section === "features" && /^fast_mode\s*=/u.test(trimmed))
          )
            return false;
          return Boolean(trimmed);
        })
        .map((line) => line.trim());
    };
    const stableCatalog = (value, allowModelEdits = false) => ({
      ...value,
      models: value.models
        .map(({ additional_speed_tiers, service_tiers, ...model }) => {
          if (!allowModelEdits) return model;
          const {
            priority,
            context_window,
            max_context_window,
            auto_compact_token_limit,
            ...metadata
          } = model;
          return metadata;
        })
        .sort((left, right) => left.slug.localeCompare(right.slug)),
    });
    const jsonHash = (value) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const connection = ({ id, name, family, baseUrl, authMode, hasKey }) => ({
      id,
      name,
      family,
      baseUrl,
      authMode,
      hasKey,
    });
    const enabledSet = (provider) =>
      provider.codexOptions.models
        .filter((model) => model.enabled)
        .map((model) => model.id)
        .sort();
    assert.deepEqual(
      enabledSet(applied),
      [models.applied, models.saved].sort(),
    );
    assert.notEqual(applied.codexOptions.fastMode, true);
    async function assertAppliedFiles(
      model,
      contextWindow,
      fastMode,
      perModelContext = false,
    ) {
      const target = await codex();
      assert.equal(target.state, "applied");
      assert.equal(target.activeProviderId, applied.id);
      assert.equal(target.appliedModel, model);
      assert.equal(target.canRestore, true);
      assert.ok(samePath(target.directory, businessCodex));
      const provider = await currentAppliedProvider();
      assert.deepEqual(connection(provider), connection(applied));
      assert.deepEqual(enabledSet(provider), enabledSet(applied));
      assert.equal(provider.model, model);
      assert.equal(provider.codexOptions.fastMode, fastMode);
      assert.equal(provider.codexOptions.upstreamProtocol, "openai");
      assert.equal(provider.codexOptions.contextWindow, null);
      assert.equal(provider.codexOptions.autoCompactTokenLimit, null);
      assert.equal(provider.codexOptions.perModelContext, perModelContext);
      assert.equal(provider.codexOptions.repairReasoningLevels, false);
      for (const value of provider.codexOptions.models)
        if (value.id !== model)
          assert.equal(
            value.contextWindow,
            applied.codexOptions.models.find(
              (original) => original.id === value.id,
            )?.contextWindow,
            "An edit must retain every other model's context",
          );
      assert.equal(
        provider.codexOptions.models.find((value) => value.id === model)
          ?.contextWindow,
        contextWindow,
      );
      assert.ok(!JSON.stringify(provider).includes(fixtureKey));
      const currentConfig = (await read(configFile)).toString("utf8");
      assert.ok(currentConfig.split(/\r?\n/u).includes(`model = "${model}"`));
      assert.match(currentConfig, /^model_provider = "uni_switch"$/mu);
      assert.ok(
        currentConfig
          .split(/\r?\n/u)
          .includes(`service_tier = "${fastMode ? "priority" : "default"}"`),
      );
      // fast_mode enables the client feature; service_tier chooses Fast on/off.
      assert.match(currentConfig, /^fast_mode = true$/mu);
      assertCodexContextOverrides(currentConfig, {
        contextWindow: baselineContext,
        compactTokenLimit: baselineCompact,
        perModelContext,
      });
      assert.ok(
        currentConfig.includes(endpoints.applied) &&
          currentConfig.includes(fixtureKey),
        "Model/Fast edits must retain the applied connection and key",
      );
      assert.equal(
        jsonHash(configWithoutEdits(currentConfig, perModelContext)),
        jsonHash(configWithoutEdits(config, perModelContext)),
        "Every other config setting, table and comment must remain",
      );
      assert.ok((await read(authFile))?.equals(baselineAuth));
      const currentCatalog = JSON.parse(
        (await read(catalogFile)).toString("utf8"),
      );
      assert.deepEqual(
        currentCatalog.models.map((value) => value.slug).sort(),
        enabledSet(provider),
      );
      const selected = currentCatalog.models.find(
        (value) => value.slug === model,
      );
      assert.ok(selected);
      assert.equal(selected.priority, 0);
      for (const field of [
        "context_window",
        "max_context_window",
        "auto_compact_token_limit",
      ])
        assert.equal(selected[field], contextWindow);
      for (const value of currentCatalog.models) {
        if (value.slug !== model) {
          const original = catalog.models.find(
            (item) => item.slug === value.slug,
          );
          assert.ok(original);
          for (const field of [
            "context_window",
            "max_context_window",
            "auto_compact_token_limit",
          ])
            assert.equal(value[field], original[field]);
        }
        assert.deepEqual(
          value.additional_speed_tiers,
          fastMode ? ["fast"] : [],
        );
        assert.deepEqual(
          value.service_tiers.map((tier) => tier.id),
          fastMode ? ["priority"] : [],
        );
      }
      await assertOriginalFiles();
      return { provider, currentConfig, currentCatalog };
    }
    const fastStates = [];
    for (const enabled of [true, false]) {
      await poll(
        async () => ({
          checked: await fast.isChecked(),
          unlocked: await fast.isEnabled(),
          provider: await currentAppliedProvider(),
        }),
        (value) =>
          value.unlocked &&
          value.checked === !enabled &&
          (enabled
            ? value.provider.codexOptions.fastMode !== true
            : value.provider.codexOptions.fastMode === true),
        "Applied Fast previous UI and Rust state settled",
      );
      await fast.click();
      await poll(
        currentAppliedProvider,
        (value) => value.codexOptions.fastMode === enabled,
        "Applied Fast Rust transaction persisted",
      );
      // Dismiss the real post-write restart prompt before querying card roles;
      // Radix hides background controls from accessibility while it is open.
      await deferRestart();
      await poll(
        async () => ({
          checked: await fast.isChecked(),
          unlocked: await fast.isEnabled(),
          provider: await currentAppliedProvider(),
        }),
        (value) =>
          value.checked === enabled &&
          value.unlocked &&
          value.provider.codexOptions.fastMode === enabled,
        "Applied Fast checked, persisted and unlocked",
      );
      const evidence = await assertAppliedFiles(
        models.applied,
        256000,
        enabled,
      );
      assert.equal(
        jsonHash(stableCatalog(evidence.currentCatalog)),
        jsonHash(stableCatalog(catalog)),
        "Fast edits must preserve all other model catalog metadata",
      );
      fastStates.push({
        enabled,
        serviceTier: enabled ? "priority" : "default",
        checkedAndRustPersistedBeforeNextAction: true,
        configSha256: createHash("sha256")
          .update(evidence.currentConfig)
          .digest("hex"),
      });
    }
    await record("native-business-applied-codex-fast", {
      providerId: applied.id,
      target: "codex",
      states: fastStates,
      actualUiClicksAndRustPersistence: true,
      ownedConfigAndCatalogVerified: true,
      modelContextCatalogMetadataAuthAndUnmanagedFieldsRetained: true,
      originalClientFilesRetained: true,
      syntheticSupplierAndCatalog: true,
      realSupplierInferenceVerified: false,
      restartDeferred: true,
      clientRestarted: false,
    });

    await poll(
      () => modelTrigger.isEnabled(),
      Boolean,
      "Applied model UI unlocked",
    );
    await modelTrigger.click();
    const modelDialog = page.getByRole("dialog", {
      name: `${applied.name} · 模型配置`,
      exact: true,
    });
    await modelDialog.waitFor();
    const requestsBeforeRefresh = modelRequests;
    await modelDialog
      .getByRole("button", { name: "刷新模型列表", exact: true })
      .click();
    await poll(
      () => modelDialog.locator(".model-selection").getAttribute("aria-busy"),
      (value) => value === "false" && modelRequests > requestsBeforeRefresh,
      "Applied dialog actual Rust fixture model discovery settled",
    );
    const saveAppliedModels = modelDialog.getByRole("button", {
      name: "保存并应用",
      exact: true,
    });
    await poll(
      () => saveAppliedModels.isEnabled(),
      Boolean,
      "Applied model save unlocked",
    );
    const beforeUneditedSave = await read(configFile);
    const beforeUneditedCatalog = await read(catalogFile);
    const revisionBeforeUneditedSave = (await codex()).configurationRevision;
    assert.ok(Number.isSafeInteger(revisionBeforeUneditedSave));
    await saveAppliedModels.click();
    await modelDialog.waitFor({ state: "hidden", timeout: 45000 });
    await poll(
      currentAppliedProvider,
      (value) =>
        value.codexOptions.modelsSyncedAt != null &&
        value.codexOptions.perModelContext === false,
      "Unedited discovery save persisted without context intent",
    );
    assert.ok((await read(configFile)).equals(beforeUneditedSave));
    assert.ok((await read(catalogFile)).equals(beforeUneditedCatalog));
    const revisionAfterUneditedSave = (await codex()).configurationRevision;
    assert.equal(revisionAfterUneditedSave, revisionBeforeUneditedSave);
    assertCodexContextOverrides((await read(configFile)).toString("utf8"), {
      contextWindow: baselineContext,
      compactTokenLimit: baselineCompact,
      perModelContext: false,
    });
    assert.equal(
      await page
        .getByRole("dialog", {
          name: "重启 Codex 使配置生效",
          exact: true,
        })
        .count(),
      0,
      "Saving unchanged model metadata must not request a client restart",
    );
    await record("native-business-model-refresh-preserves-overrides", {
      actualUiRefreshAndSave: true,
      configAndCatalogBytesExact: true,
      revisionBefore: revisionBeforeUneditedSave,
      revisionAfter: revisionAfterUneditedSave,
      globalContextWindow: baselineContext,
      globalCompactTokenLimit: baselineCompact,
      perModelContext: false,
      repairReasoningLevels: false,
      clientRestarted: false,
      syntheticSupplierAndCatalog: true,
    });
    await poll(() => modelTrigger.isEnabled(), Boolean, "Model UI settled");
    await modelTrigger.click();
    await modelDialog.waitFor();
    await modelDialog
      .getByRole("button", {
        name: `将 ${models.saved} 设为默认模型`,
        exact: true,
      })
      .click();
    await poll(
      () =>
        modelDialog
          .getByRole("checkbox", { name: `启用 ${models.saved}`, exact: true })
          .isChecked(),
      Boolean,
      "Actual discovered alternate default enabled",
    );
    const selectedContext = modelDialog.getByRole("textbox", {
      name: `上下文长度 ${models.saved}`,
      exact: true,
    });
    await selectedContext.fill("128");
    await saveAppliedModels.click();
    await modelDialog.waitFor({ state: "hidden", timeout: 45000 });
    await poll(
      currentAppliedProvider,
      (value) =>
        value.model === models.saved &&
        value.codexOptions.models.find((model) => model.id === models.saved)
          ?.contextWindow === 128000,
      "Applied alternate model and context persisted by Rust",
    );
    await poll(
      codex,
      (value) =>
        value.state === "applied" && value.appliedModel === models.saved,
      "Alternate model committed to current Codex target",
    );
    await deferRestart();
    const inlineContext = page.getByRole("textbox", {
      name: `上下文长度 · ${applied.name} · ${models.saved}`,
      exact: true,
    });
    await poll(
      async () => ({
        enabled: await inlineContext.isEnabled(),
        value: await inlineContext.inputValue(),
      }),
      (value) => value.enabled && value.value === "128",
      "Committed model context reflected in unlocked UI",
    );
    const modelEvidence = await assertAppliedFiles(
      models.saved,
      128000,
      false,
      true,
    );
    assert.equal(
      jsonHash(stableCatalog(modelEvidence.currentCatalog, true)),
      jsonHash(stableCatalog(catalog, true)),
      "Model/context edits must preserve unrelated catalog metadata",
    );
    await inlineContext.fill("96");
    await inlineContext.press("Enter");
    await poll(
      currentAppliedProvider,
      (value) =>
        value.model === models.saved &&
        value.codexOptions.models.find((model) => model.id === models.saved)
          ?.contextWindow === 96000,
      "Applied inline context Rust transaction persisted",
    );
    await deferRestart();
    await poll(
      async () => ({
        provider: await currentAppliedProvider(),
        enabled: await inlineContext.isEnabled(),
        value: await inlineContext.inputValue(),
      }),
      (value) =>
        value.enabled &&
        value.value === "96" &&
        value.provider.model === models.saved &&
        value.provider.codexOptions.models.find(
          (model) => model.id === models.saved,
        )?.contextWindow === 96000,
      "Applied inline context Enter persisted and unlocked",
    );
    const contextEvidence = await assertAppliedFiles(
      models.saved,
      96000,
      false,
      true,
    );
    assert.equal(
      jsonHash(stableCatalog(contextEvidence.currentCatalog, true)),
      jsonHash(stableCatalog(catalog, true)),
    );
    await record("native-business-applied-codex-model-context", {
      providerId: applied.id,
      target: "codex",
      previousModel: models.applied,
      selectedModel: models.saved,
      actualRustHttpModelDiscovery: true,
      dialogSavedAndApplied: true,
      dialogContextWindow: 128000,
      inlineEnterContextWindow: 96000,
      checkedOrValueAndRustPersistedBeforeNextAction: true,
      ownedConfigDefaultModelAndCatalogContextMaxCompactVerified: true,
      globalContextOverrideAbsent: true,
      globalCompactTokenLimitRetained: baselineCompact,
      perModelContextPersisted: true,
      automaticReasoningRepairDisabled: true,
      fastOffConnectionAuthAndUnmanagedFieldsRetained: true,
      originalClientFilesRetained: true,
      syntheticSupplierAndCatalog: true,
      realSupplierInferenceVerified: false,
      restartDeferred: true,
      clientRestarted: false,
    });

    const restoredConfigBytesExact = await restoreUi();
    await setDirectoryUi(initialCodex.directory);
    assert.deepEqual(await codex(), initialCodex);
    await assertOriginalFiles();
    await record("native-business-ui-restored", {
      preciseBaselineRestored: true,
      configSettingsAndCommentsRestored: true,
      configBytesExact: restoredConfigBytesExact,
      generatedCatalogRestored: true,
      originalDirectoryReturnedThroughUi: true,
      originalClientFilesRetained: true,
      clientRestarted: false,
    });
  } catch (error) {
    failure = error;
  } finally {
    const cleanupErrors = [];
    const attempt = async (task) => {
      try {
        await task();
      } catch (error) {
        cleanupErrors.push(String(error.message ?? error));
      }
    };
    await attempt(async () => {
      const overview = await captureOwned();
      const current = overview.targets.find(
        (value) => value.target === "codex",
      );
      if (samePath(current.directory, businessCodex)) {
        await plain(businessCodex);
        if (current.canRestore) {
          assert.ok(
            ownIds.has(current.activeProviderId),
            "Cleanup may only restore a target applied by this helper",
          );
          fallbackCleanup = true;
          await native("restore_original", { target: "codex" });
        }
        await assertBusinessBaseline(true);
        await native("set_directory", {
          target: "codex",
          directory: initialCodex.directory,
        });
        fallbackCleanup = true;
      } else assert.ok(samePath(current.directory, initialCodex.directory));
    });
    await attempt(async () => {
      const overview = await captureOwned();
      for (const id of ownIds) {
        assert.ok(!initialIds.has(id));
        assert.equal(
          overview.targets.some((value) => value.activeProviderId === id),
          false,
          "Cleanup must not delete an active provider",
        );
        await native("delete_provider", { providerId: id });
      }
    });
    if (server)
      await attempt(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      });
    await attempt(async () => {
      // Only close an available ordinary dialog; no forced interaction or restart.
      const close = page
        .getByRole("dialog")
        .getByRole("button", { name: "关闭弹窗", exact: true });
      if (await close.count()) {
        await poll(
          () => close.isEnabled(),
          Boolean,
          "Business cleanup dialog unlocked",
        );
        await close.click();
      }
      await refresh();
      const final = await native("get_overview");
      assert.deepEqual(final.providers, initial.providers);
      assert.deepEqual(final.targets, initial.targets);
      await assertOriginalFiles();
      if (await plain(configFile, true)) await assertBusinessBaseline(true);
    });
    await record("native-business-extras-cleanup", {
      passed: cleanupErrors.length === 0,
      ownProvidersRemoved: cleanupErrors.length === 0,
      originalTargetsAndClientFilesRestored: cleanupErrors.length === 0,
      fallbackCleanup,
      fixtureRetainedForOwnedWrapperCleanup: true,
      cleanupErrors,
      flowFailure: failure ? String(failure.message ?? failure) : null,
    });
    assert.equal(
      cleanupErrors.length,
      0,
      "Business helper cleanup must restore only its owned changes",
    );
  }
  if (failure) throw failure;
}
