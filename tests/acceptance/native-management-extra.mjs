import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { validateSurfaceOwnedRoot } from "./native-surface-extra.mjs";

// Called only after the owner has validated the native instance and its sandbox.
// Every interaction below uses the actual WebView; IPC only observes saved state.
export async function verifyManagementExtras({
  page,
  native,
  record,
  providerId,
  fixtureKey,
  unavailableModelId,
  expectedRoot,
  fixtureDirectory,
  modelFixture,
}) {
  const ownedRoot = await validateSurfaceOwnedRoot(expectedRoot);
  assert.match(fixtureKey, /^ae-switch-synthetic-/u);
  const initial = await native("get_overview");
  const original = initial.providers.find((value) => value.id === providerId);
  assert.ok(original?.hasKey, "The synthetic provider must already exist");
  assert.equal(unavailableModelId, "text-embedding-native-qa");
  assert.equal(
    original.codexOptions.models.find(
      (model) => model.id === unavailableModelId,
    )?.enabled,
    false,
    "The actual synthetic catalog must retain a disabled incompatible model",
  );
  assert.equal(
    initial.targets.some((value) => value.activeProviderId === providerId),
    false,
    "Extras require an inactive synthetic provider",
  );
  assert.equal(
    await page
      .getByRole("tab", { name: /^Codex\b/u })
      .getAttribute("data-state"),
    "active",
  );
  const provider = async () => {
    const value = (await native("get_overview")).providers.find(
      (item) => item.id === providerId,
    );
    assert.ok(value, "The existing provider must not disappear");
    return value;
  };
  const poll = async (read, predicate, label) => {
    const deadline = Date.now() + 30000;
    do {
      const value = await read();
      if (predicate(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.fail(`${label} did not reach the expected state`);
  };
  const unchanged = async (before, label) =>
    assert.deepEqual(
      await provider(),
      before,
      `${label} must not write the provider`,
    );
  const focused = async (locator, label) =>
    poll(
      () => locator.evaluate((element) => element === document.activeElement),
      Boolean,
      label,
    );
  const button = (name) => page.getByRole("button", { name, exact: true });
  const nameButton = () => button(`修改名称 ${original.name}`);
  const context = () =>
    page.getByRole("textbox", {
      name: `上下文长度 · ${original.name} · ${original.model}`,
      exact: true,
    });

  const helpTrigger = button("使用说明");
  await helpTrigger.click();
  const help = page.getByRole("dialog", { name: "使用说明", exact: true });
  const topics = [
    "首次配置",
    "高级管理日常切换",
    "模型与上下文",
    "Fast 与思考强度",
    "协议转换",
    "余额查询",
    "设置与更新",
    "常见问题",
  ];
  const navigation = help.getByRole("navigation", {
    name: "教程目录",
    exact: true,
  });
  assert.equal(await navigation.getByRole("button").count(), topics.length);
  for (const topic of topics) {
    const choice = navigation.getByRole("button", { name: topic, exact: true });
    await choice.click();
    await help
      .getByRole("heading", { name: topic, exact: true, level: 3 })
      .waitFor();
    assert.equal(await choice.getAttribute("aria-current"), "page");
    assert.equal(await navigation.locator('[aria-current="page"]').count(), 1);
    assert.ok((await help.locator(".tutorial-summary").innerText()).trim());
    assert.ok((await help.locator("article section").count()) > 0);
  }
  // Tab must remain inside the modal, including its last and first controls.
  await help.getByRole("button", { name: "开始使用", exact: true }).focus();
  await page.keyboard.press("Tab");
  assert.equal(
    await help.evaluate((element) => element.contains(document.activeElement)),
    true,
  );
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await help.evaluate((element) => element.contains(document.activeElement)),
    true,
  );
  await help.getByRole("button", { name: "关闭弹窗", exact: true }).click();
  await help.waitFor({ state: "hidden" });
  await focused(helpTrigger, "Tutorial close focus return");
  await helpTrigger.click();
  await help.waitFor();
  await page.keyboard.press("Escape");
  await help.waitFor({ state: "hidden" });
  await focused(helpTrigger, "Tutorial Escape focus return");
  await record("native-management-tutorial-extras", {
    topics,
    closeAndEscape: true,
    tabFocusContained: true,
    triggerFocusRestored: true,
    externalTutorialLinkOpened: false,
  });

  const beforeCreate = await native("get_overview");
  const add = button("添加供应商");
  await add.click();
  const create = page.getByRole("dialog", { name: "添加供应商", exact: true });
  const address = create.getByRole("textbox", {
    name: "API 地址",
    exact: true,
  });
  const key = create.locator("#apiKey");
  await create.getByRole("button", { name: "添加并使用", exact: true }).click();
  await create.getByText("请填写 API 地址", { exact: true }).waitFor();
  assert.equal(await address.getAttribute("aria-invalid"), "true");
  await address.fill(original.baseUrl);
  await create.getByRole("button", { name: "添加并使用", exact: true }).click();
  await create.getByText("请填写 API Key", { exact: true }).waitFor();
  assert.equal(await key.getAttribute("aria-invalid"), "true");
  await key.fill(fixtureKey);
  assert.equal(await key.getAttribute("type"), "password");
  await create
    .getByRole("button", { name: "显示 API Key", exact: true })
    .click();
  assert.equal(await key.getAttribute("type"), "text");
  assert.equal(await key.inputValue(), fixtureKey);
  await create
    .getByRole("button", { name: "隐藏 API Key", exact: true })
    .click();
  assert.equal(await key.getAttribute("type"), "password");
  await create.getByRole("button", { name: "取消", exact: true }).click();
  await create.waitFor({ state: "hidden" });
  await focused(add, "Create cancel focus return");
  const afterCreate = await native("get_overview");
  assert.deepEqual(afterCreate.providers, beforeCreate.providers);
  assert.deepEqual(afterCreate.targets, beforeCreate.targets);
  await record("native-management-required-key-cancel", {
    missingAddressRejected: true,
    missingKeyRejected: true,
    syntheticKeyShowHide: true,
    cancelledWithoutProviderOrTargetWrite: true,
    keyIncludedInEvidence: false,
  });

  const beforeRename = await provider();
  const renameInput = () =>
    page.getByRole("textbox", {
      name: `供应商名称 · ${original.name}`,
      exact: true,
    });
  await nameButton().click();
  await renameInput().fill("Synthetic cancelled rename");
  await button("取消名称修改").click();
  await nameButton().waitFor();
  await unchanged(beforeRename, "Rename cancel");
  await nameButton().click();
  await renameInput().fill("Synthetic escaped rename");
  await renameInput().press("Escape");
  await nameButton().waitFor();
  await unchanged(beforeRename, "Rename Escape");
  for (const invalid of ["   ", "x".repeat(161)]) {
    await nameButton().click();
    await renameInput().fill(invalid);
    await button("保存供应商名称").click();
    await page
      .getByText("名称为空或过长，请调整后保存。", { exact: true })
      .waitFor();
    assert.equal(await renameInput().getAttribute("aria-invalid"), "true");
    assert.equal(await renameInput().inputValue(), invalid);
    await unchanged(beforeRename, "Invalid rename");
    await renameInput().press("Escape");
    await nameButton().waitFor();
  }
  await record("native-management-rename-cancel-invalid", {
    cancelAndEscapeWithoutWrite: true,
    emptyAndOverlongRejected: true,
    invalidDraftRetained: true,
  });

  const originalContext =
    original.codexOptions.models.find((value) => value.id === original.model)
      ?.contextWindow ?? original.codexOptions.contextWindow;
  assert.ok(Number.isSafeInteger(originalContext) && originalContext > 0);
  const changedContext = originalContext === 64000 ? 96000 : 64000;
  await context().fill(String(changedContext / 1000));
  await context().press("Enter");
  await poll(
    provider,
    (value) =>
      value.codexOptions.models.find((model) => model.id === original.model)
        ?.contextWindow === changedContext,
    "Inline context Enter save",
  );
  await poll(() => context().isEnabled(), Boolean, "Context write unlocked");
  await context().fill(String(originalContext / 1000));
  await context().press("Tab"); // A real focus change exercises onBlur saving.
  await poll(
    provider,
    (value) =>
      value.codexOptions.models.find((model) => model.id === original.model)
        ?.contextWindow === originalContext,
    "Inline context blur save and restore",
  );
  await poll(() => context().isEnabled(), Boolean, "Restored context unlocked");
  const beforeInvalidContext = await provider();
  await context().fill("0");
  await context().press("Enter");
  await page
    .getByText("请输入 0.001–100000 之间的 k 值，最多三位小数。", {
      exact: true,
    })
    .waitFor();
  assert.equal(await context().getAttribute("aria-invalid"), "true");
  assert.equal(await context().inputValue(), "0");
  await unchanged(beforeInvalidContext, "Invalid inline context");
  await context().press("Escape");
  assert.equal(await context().inputValue(), String(originalContext / 1000));
  assert.equal(await context().getAttribute("aria-invalid"), "false");
  await context().fill("999");
  await context().press("Escape");
  assert.equal(await context().inputValue(), String(originalContext / 1000));
  await unchanged(beforeInvalidContext, "Context Escape");
  const restored = await provider();
  const withoutRevision = ({ updatedAt, ...value }) => value;
  assert.deepEqual(withoutRevision(restored), withoutRevision(original));
  assert.deepEqual((await native("get_overview")).targets, initial.targets);
  await record("native-management-inline-context-extras", {
    enterSaved: true,
    blurSavedAndRestored: true,
    invalidRetainedWithoutWrite: true,
    escapeRestoredWithoutWrite: true,
    modelEnabledSetFastKeyAndOtherOptionsRetained: true,
    originalContextWindow: originalContext,
  });

  const modelTrigger = button(`配置 ${original.name} 的模型`);
  const models = page.getByRole("dialog", {
    name: `${original.name} · 模型配置`,
    exact: true,
  });
  const saveModels = models.getByRole("button", {
    name: "保存模型配置",
    exact: true,
  });
  const openModels = async () => {
    await modelTrigger.click();
    await models.waitFor();
    await models
      .getByRole("button", { name: "刷新模型列表", exact: true })
      .click();
    await poll(
      () => models.locator(".model-selection").getAttribute("aria-busy"),
      (value) => value === "false",
      "Explicit native model refresh completed",
    );
    await poll(() => saveModels.isEnabled(), Boolean, "Model dialog ready");
  };
  try {
    await openModels();
    const unavailable = [];
    const modelSearch = models.getByRole("textbox", {
      name: "搜索模型",
      exact: true,
    });
    let searchCovered = false;
    if (await modelSearch.count()) {
      await modelSearch.fill(original.model);
      assert.ok((await models.locator(".model-choice").count()) > 0);
      await modelSearch.fill("synthetic-no-matching-model");
      await models.getByText("没有匹配的模型", { exact: true }).waitFor();
      assert.equal(await models.locator(".model-choice").count(), 0);
      await models
        .getByRole("button", { name: "清空模型搜索", exact: true })
        .click();
      assert.equal(
        await models.isVisible(),
        true,
        "Clearing model search must keep its dialog open",
      );
      assert.equal(await modelSearch.inputValue(), "");
      await modelSearch.fill(original.model);
      await modelSearch.press("Escape");
      assert.equal(
        await models.isVisible(),
        true,
        "Escape in a nonempty model search must keep its dialog open",
      );
      assert.equal(await modelSearch.inputValue(), "");
      await focused(modelSearch, "Model search Escape retains focus");
      await unchanged(restored, "Model search Escape");
      await modelSearch.press("Escape");
      await models.waitFor({ state: "hidden" });
      await focused(modelTrigger, "Empty model search Escape focus return");
      await unchanged(restored, "Empty model search Escape");
      await openModels();
      searchCovered = true;
    } else
      unavailable.push("model-search: fewer than nine actual catalog models");
    const more = models.getByRole("button", {
      name: "显示更多模型",
      exact: true,
    });
    let loadMoreCovered = false;
    if (await more.count()) {
      const before = await models.locator(".model-choice").count();
      await more.click();
      assert.ok((await models.locator(".model-choice").count()) > before);
      loadMoreCovered = true;
    } else
      unavailable.push("load-more: no actual catalog page beyond forty models");
    const inappropriate = models.getByRole("button", {
      name: "查看不适用模型",
      exact: true,
    });
    let unavailableToggleCovered = false;
    assert.equal(
      await inappropriate.count(),
      1,
      "The actual model dialog must expose its incompatible-model toggle",
    );
    if (await inappropriate.count()) {
      await inappropriate.click();
      const hide = models.getByRole("button", {
        name: "隐藏不适用模型",
        exact: true,
      });
      assert.equal(await hide.getAttribute("aria-pressed"), "true");
      // Changing this filter resets pagination to forty rows. Search through the
      // actual UI so the final incompatible catalog row is rendered before checks.
      await modelSearch.fill(unavailableModelId);
      const incompatible = models.getByRole("checkbox", {
        name: `启用 ${unavailableModelId}`,
        exact: true,
      });
      await incompatible.waitFor({ state: "visible" });
      assert.equal(await incompatible.isEnabled(), false);
      assert.equal(await incompatible.isChecked(), false);
      const incompatibleRow = models.locator(".model-choice").filter({
        has: page.getByRole("checkbox", {
          name: `启用 ${unavailableModelId}`,
          exact: true,
        }),
      });
      assert.equal(await incompatibleRow.count(), 1);
      assert.equal(
        await incompatibleRow.getByText("不适用", { exact: true }).count(),
        1,
      );
      assert.equal(await incompatibleRow.getByRole("button").count(), 0);
      assert.equal(await incompatibleRow.locator(".model-default").count(), 0);
      assert.equal(
        await incompatibleRow.getByRole("textbox").isEnabled(),
        false,
      );
      await hide.click();
      assert.equal(await inappropriate.getAttribute("aria-pressed"), "false");
      assert.equal(await incompatible.count(), 0);
      await models
        .getByRole("button", { name: "清空模型搜索", exact: true })
        .click();
      assert.equal(await modelSearch.inputValue(), "");
      await unchanged(
        restored,
        "Incompatible model visibility and disabled controls",
      );
      unavailableToggleCovered = true;
    } else
      unavailable.push("unavailable-toggle: no incompatible catalog models");
    unavailable.push(
      "batch-selection: product exposes individual checkboxes only",
    );
    const selectedOnly = models.getByRole("button", { name: /^只看已选择/u });
    await selectedOnly.click();
    const all = models.getByRole("button", {
      name: "查看全部模型",
      exact: true,
    });
    assert.equal(await all.getAttribute("aria-pressed"), "true");
    await all.click();
    const modelContext = models.getByRole("textbox", {
      name: `上下文长度 ${original.model}`,
      exact: true,
    });
    await modelContext.fill("0");
    await saveModels.click();
    await models
      .getByText("请修正模型的上下文长度。", { exact: true })
      .waitFor();
    assert.equal(await modelContext.getAttribute("aria-invalid"), "true");
    assert.equal(await modelContext.inputValue(), "0");
    await unchanged(restored, "Invalid model context");
    await modelContext.fill(String(originalContext / 1000));
    // No batch control exists. Iterate every real rendered checkbox, loading pages.
    while (await more.count()) await more.click();
    const choices = models.getByRole("checkbox", { name: /^启用 /u });
    assert.ok((await choices.count()) > 0);
    // Toggling reorders default and enabled rows, so use each stable accessible
    // name instead of nth locators captured before that reorder.
    const choiceNames = await choices.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("aria-label")),
    );
    let changed = 0;
    for (const choiceName of choiceNames) {
      assert.ok(choiceName);
      const choice = models.getByRole("checkbox", {
        name: choiceName,
        exact: true,
      });
      if ((await choice.isEnabled()) && (await choice.isChecked())) {
        await choice.uncheck();
        changed++;
      }
    }
    assert.ok(changed > 0, "At least one real model must have been deselected");
    for (const choice of await choices.all()) {
      if (await choice.isEnabled())
        assert.equal(await choice.isChecked(), false);
    }
    await saveModels.click();
    await models
      .getByText("请至少启用一个适用模型，并设置默认模型。", { exact: true })
      .waitFor();
    assert.equal(await models.isVisible(), true);
    await unchanged(restored, "All models deselected rejection");
    const originalChoice = models.getByRole("checkbox", {
      name: `启用 ${original.model}`,
      exact: true,
    });
    await originalChoice.check();
    assert.equal(await originalChoice.isChecked(), true);
    await models.getByRole("button", { name: "取消", exact: true }).click();
    await models.waitFor({ state: "hidden" });
    await unchanged(restored, "Model dialog cancel");
    await record("native-management-model-draft-extras", {
      selectedOnlyAndAllFilter: true,
      individualCheckboxes: true,
      invalidContextRejectedWithoutWrite: true,
      allDeselectedRejectedWithoutWrite: true,
      cancelRetainedSavedConfiguration: true,
      catalogModelsObserved: choiceNames.length,
      syntheticCatalog: true,
      searchCovered,
      searchEscapeClearedWithoutClosing: searchCovered,
      emptySearchEscapeClosedAndFocusReturned: searchCovered,
      loadMoreCovered,
      unavailableToggleCovered,
      incompatibleModelCannotBeEnabledOrDefault: unavailableToggleCovered,
      unavailableBranches: unavailable,
      realSupplierInferenceVerified: false,
    });
  } finally {
    // A failed draft assertion must not leave a modal for the wrapper's tray run.
    if (await models.isVisible()) {
      await models.getByRole("button", { name: "取消", exact: true }).click();
      await models.waitFor({ state: "hidden" });
      await unchanged(restored, "Model draft failure finally cancel");
    }
  }

  const { root, id: rootId } = ownedRoot;
  const fixture = path.resolve(fixtureDirectory);
  const samePath = (left, right) =>
    path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
  assert.doesNotMatch(root, /^C:[\\/]/iu);
  assert.match(
    path.basename(fixture),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  );
  assert.ok(
    samePath(
      path.dirname(fixture),
      path.join(root, "data", "native-ui-fixtures"),
    ),
  );
  async function readOwnedModelFile(location) {
    const relative = path.relative(root, path.resolve(location));
    assert.ok(
      relative && !relative.startsWith("..") && !path.isAbsolute(relative),
      "Model recovery reads must stay within the verified owned root",
    );
    assert.ok(samePath(await fs.realpath(root), root));
    const rootInfo = await fs.lstat(root);
    assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink());
    const parts = relative.split(path.sep);
    let current = root;
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      let info;
      try {
        info = await fs.lstat(current);
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
      assert.equal(
        info.isSymbolicLink(),
        false,
        "Model recovery paths may not contain links",
      );
      assert.ok(samePath(await fs.realpath(current), current));
      if (index === parts.length - 1) {
        assert.ok(info.isFile(), "Model recovery reads require ordinary files");
        assert.equal(
          info.nlink,
          1,
          "Model recovery files may not be hard linked",
        );
      } else assert.ok(info.isDirectory());
    }
    return fs.readFile(location);
  }
  const rootOwnerBytes = await readOwnedModelFile(
    path.join(root, ".ae-native-e2e-owner.json"),
  );
  assert.ok(rootOwnerBytes);
  const rootOwner = JSON.parse(rootOwnerBytes.toString("utf8"));
  assert.equal(rootOwner.id, rootId);
  assert.equal(
    rootOwner.purpose,
    "AE Switch owned native UI and real tool acceptance",
  );
  const fixtureOwnerBytes = await readOwnedModelFile(
    path.join(fixture, ".ae-native-ui-owner.json"),
  );
  assert.ok(fixtureOwnerBytes);
  assert.equal(
    JSON.parse(fixtureOwnerBytes.toString("utf8")).purpose,
    "synthetic native UI acceptance",
  );
  const modelRecoveryOverview = await native("get_overview");
  assert.ok(
    samePath(modelRecoveryOverview.dataDirectory, path.join(root, "data")),
  );
  for (const target of modelRecoveryOverview.targets) {
    assert.ok(samePath(target.directory, path.join(fixture, target.target)));
    assert.equal(target.activeProviderId, null);
    assert.equal(target.canRestore, false);
  }
  assert.ok(modelFixture.ids.includes(original.model));
  const modelRecoveryFiles = new Set([
    path.join(root, "data", "uni-switch.db"),
    path.join(root, "data", "uni-switch.db-wal"),
    ...modelRecoveryOverview.targets.flatMap((target) => target.files),
    path.join(fixture, "codex", "auth.json"),
    path.join(fixture, "codex", "uni-switch-models.json"),
    path.join(
      fixture,
      "claude_desktop",
      "Claude-3p",
      "configLibrary",
      "_meta.json",
    ),
  ]);
  async function recoverySnapshot() {
    const overview = await native("get_overview");
    const files = new Map();
    for (const location of modelRecoveryFiles)
      files.set(location, await readOwnedModelFile(location));
    return { overview, files };
  }
  async function assertRecoveryUnchanged(before) {
    const after = await recoverySnapshot();
    assert.deepEqual(
      after.overview,
      before.overview,
      "Model refresh and cancel must retain actual Store summaries",
    );
    for (const [location, bytes] of before.files) {
      const next = after.files.get(location);
      assert.ok(
        bytes === null ? next === null : next !== null && bytes.equals(next),
        "Model refresh and cancel must retain Store and client bytes or absence",
      );
    }
  }
  async function exposeModelDraft() {
    const unavailableToggle = models.getByRole("button", {
      name: "查看不适用模型",
      exact: true,
    });
    if (await unavailableToggle.isVisible()) await unavailableToggle.click();
    const more = models.getByRole("button", {
      name: "显示更多模型",
      exact: true,
    });
    for (let count = 0; count < 2 && (await more.isVisible()); count++)
      await more.click();
    assert.equal(
      await more.isVisible(),
      false,
      "The bounded synthetic catalog must be fully visible",
    );
    return models.locator(".model-choice").evaluateAll((rows) =>
      rows.map((row) => ({
        id: row.querySelector("code")?.textContent,
        enabled: row.querySelector('input[type="checkbox"]')?.checked,
        disabled: row.querySelector('input[type="checkbox"]')?.disabled,
        context: row.querySelector('input[inputmode="decimal"]')?.value,
        default: !!row.querySelector(".model-default"),
      })),
    );
  }
  async function explicitRecoveryRefresh() {
    const beforeRequests = modelFixture.requests();
    await models
      .getByRole("button", { name: "刷新模型列表", exact: true })
      .click();
    await poll(
      () => modelFixture.requests(),
      (value) => value > beforeRequests,
      "Actual Rust HTTP model request",
    );
    await poll(
      () => models.locator(".model-selection").getAttribute("aria-busy"),
      (value) => value === "false",
      "Native recovery model refresh completed",
    );
    return modelFixture.requests() - beforeRequests;
  }
  for (const mode of ["http500", "empty", "retired"]) {
    const observations = {
      failureShown: false,
      draftRetained: false,
      savedModelsRemainUsable: false,
      retiredDefaultRemoved: false,
      replacementDefaultFromUsableCatalog: false,
      normalRefreshRecovered: false,
      storeAndClientBytesRetained: false,
      dialogCancelled: false,
      actualHttpRequests: 0,
    };
    let phase = "snapshot";
    let failure;
    const before = await recoverySnapshot();
    try {
      modelFixture.setMode("normal");
      phase = "open_normal_dialog";
      await openModels();
      await models
        .getByRole("textbox", {
          name: `上下文长度 ${original.model}`,
          exact: true,
        })
        .fill("137");
      const draft = await exposeModelDraft();
      assert.equal(draft.length, modelFixture.ids.length);
      assert.equal(draft.find((model) => model.default)?.id, original.model);
      phase = "controlled_refresh";
      modelFixture.setMode(mode, mode === "retired" ? original.model : null);
      observations.actualHttpRequests += await explicitRecoveryRefresh();
      if (mode === "retired") {
        const retiredDraft = await exposeModelDraft();
        const returnedIds = modelFixture.ids.filter(
          (id) => id !== original.model,
        );
        assert.deepEqual(
          retiredDraft.map((model) => model.id).sort(),
          [...returnedIds].sort(),
        );
        assert.equal(
          retiredDraft.some((model) => model.id === original.model),
          false,
        );
        observations.retiredDefaultRemoved = true;
        const defaults = retiredDraft.filter((model) => model.default);
        assert.equal(defaults.length, 1);
        assert.ok(
          defaults[0].enabled &&
            !defaults[0].disabled &&
            returnedIds.includes(defaults[0].id),
        );
        observations.replacementDefaultFromUsableCatalog = true;
        assert.equal(await models.locator(".balance-failure").count(), 0);
      } else {
        await models.locator(".balance-failure").waitFor();
        observations.failureShown = true;
        assert.match(
          await models.locator(".balance-failure").innerText(),
          /可继续使用已保存的模型/u,
        );
        assert.ok(
          JSON.stringify(await exposeModelDraft()) === JSON.stringify(draft),
          "Failed or empty refresh must preserve the actual model draft and cached catalog",
        );
        observations.draftRetained = true;
        assert.equal(await saveModels.isEnabled(), true);
        observations.savedModelsRemainUsable = true;
      }
      await assertRecoveryUnchanged(before);
      phase = "normal_refresh_recovery";
      modelFixture.setMode("normal");
      observations.actualHttpRequests += await explicitRecoveryRefresh();
      assert.equal(await models.locator(".balance-failure").count(), 0);
      const recoveredDraft = await exposeModelDraft();
      assert.deepEqual(
        recoveredDraft.map((model) => model.id).sort(),
        [...modelFixture.ids].sort(),
      );
      const defaults = recoveredDraft.filter((model) => model.default);
      assert.equal(defaults.length, 1);
      assert.ok(
        defaults[0].enabled &&
          !defaults[0].disabled &&
          modelFixture.ids.includes(defaults[0].id),
      );
      observations.normalRefreshRecovered = true;
    } catch (error) {
      failure = error;
    } finally {
      modelFixture.setMode("normal");
      try {
        if (await models.isVisible())
          await models
            .getByRole("button", { name: "取消", exact: true })
            .click();
        await models.waitFor({ state: "hidden" });
        observations.dialogCancelled = true;
        await assertRecoveryUnchanged(before);
        observations.storeAndClientBytesRetained = true;
      } catch (error) {
        if (!failure) {
          phase = "cancel_and_verify";
          failure = error;
        }
      }
    }
    await record(`native-management-model-${mode}-refresh-recovery`, {
      ...observations,
      controlledResponse: mode,
      syntheticLoopbackCatalog: true,
      failureCategory: failure ? "model_refresh_recovery_assertion" : null,
      failurePhase: failure ? phase : null,
    });
    if (failure) throw failure;
  }

  const deleteTrigger = button(`删除 ${original.name}`);
  await deleteTrigger.click();
  const deletion = page.getByRole("dialog", {
    name: "删除这组配置？",
    exact: true,
  });
  assert.equal(
    await deletion
      .getByRole("button", { name: "删除配置", exact: true })
      .isEnabled(),
    true,
  );
  await deletion.getByRole("button", { name: "取消", exact: true }).click();
  await deletion.waitFor({ state: "hidden" });
  await focused(deleteTrigger, "Delete cancel focus return");
  await unchanged(restored, "Delete cancel");
  await record("native-management-delete-cancel", {
    realDeleteConfirmationReached: true,
    cancelWithoutWrite: true,
    focusReturned: true,
    providerDeleted: false,
  });

  await button("设置").click();
  const settings = page.getByRole("dialog", {
    name: "Codex 设置",
    exact: true,
  });
  const targetBeforeDirectory = (await native("get_overview")).targets.find(
    (value) => value.target === "codex",
  );
  const changeDirectory = settings.getByRole("button", {
    name: "修改目录",
    exact: true,
  });
  assert.equal(
    await changeDirectory.isEnabled(),
    !targetBeforeDirectory.canRestore,
  );
  let directoryCancelCovered = false;
  let unsafeDirectoryRejected = false;
  if (!targetBeforeDirectory.canRestore) {
    await changeDirectory.click();
    const directory = page.getByRole("dialog", {
      name: "设置配置位置",
      exact: true,
    });
    const input = directory.getByRole("textbox", {
      name: "配置目录",
      exact: true,
    });
    assert.equal(await input.inputValue(), targetBeforeDirectory.directory);
    // Portable Rust validates local drive and owned root before target writes.
    for (const rejected of [
      "relative-native-ui-rejected",
      "C:\\AE-Switch-native-ui-rejected",
    ]) {
      await input.fill(rejected);
      await directory
        .getByRole("button", { name: "保存目录", exact: true })
        .click();
      await directory.getByRole("alert").waitFor();
      assert.equal(await directory.isVisible(), true);
      const current = (await native("get_overview")).targets.find(
        (value) => value.target === "codex",
      );
      assert.deepEqual(current, targetBeforeDirectory);
      await poll(
        () => input.isEnabled(),
        Boolean,
        "Rejected directory unlocked",
      );
    }
    unsafeDirectoryRejected = true;
    await input.fill(`${targetBeforeDirectory.directory}\\cancelled-draft`);
    await directory.getByRole("button", { name: "取消", exact: true }).click();
    await directory.waitFor({ state: "hidden" });
    await settings.waitFor();
    directoryCancelCovered = true;
  } else {
    await settings
      .getByText("当前目录已接管，更换前请先恢复原配置。", { exact: true })
      .waitFor();
  }
  await settings.getByRole("button", { name: "关闭弹窗", exact: true }).click();
  await settings.waitFor({ state: "hidden" });
  assert.deepEqual(
    (await native("get_overview")).targets.find(
      (value) => value.target === "codex",
    ),
    targetBeforeDirectory,
  );
  await record("native-management-directory-extras", {
    directoryCancelCovered,
    relativeAndCDriveRejectedWithoutTargetWrite: unsafeDirectoryRejected,
    managedDirectoryProtectionCovered: targetBeforeDirectory.canRestore,
    managedDirectoryProtectionGap: targetBeforeDirectory.canRestore
      ? null
      : "Call point is inactive; managed target disable branch not reached",
    directoryChanged: false,
    systemFilesCreated: false,
  });

  const refresh = button("刷新配置状态");
  await poll(() => refresh.isEnabled(), Boolean, "Refresh unlocked");
  await refresh.click();
  const dismiss = button("关闭提示");
  await dismiss.waitFor();
  await dismiss.click();
  await dismiss.waitFor({ state: "hidden" });
  await page.keyboard.press("Control+f");
  const search = page.getByRole("textbox", {
    name: "搜索 API 配置",
    exact: true,
  });
  await search.waitFor();
  await focused(search, "Ctrl+F supplier search");
  for (const query of [original.name, original.baseUrl, original.model]) {
    await search.fill(query);
    await nameButton().waitFor();
    await button("清空供应商搜索").click();
    assert.equal(await search.inputValue(), "");
    await focused(search, "Clear supplier search focus");
  }
  await unchanged(restored, "Search and notice close");
  assert.deepEqual((await native("get_overview")).targets, initial.targets);
  await record("native-management-notice-search-extras", {
    actualRefreshNoticeClosed: true,
    ctrlFFocusedSearch: true,
    nameAddressModelSearch: true,
    clearButtonRestoredFocus: true,
    providerAndTargetsRetained: true,
  });
}

// Only the applied Codex fixture may be changed. This does not restart a client
// or manufacture a native status: Rust must detect and reject the real change.
export async function verifyOwnedConflict({
  page,
  native,
  invoke,
  record,
  target,
  fixtureDirectory,
  expectedRoot,
}) {
  assert.equal(target, "codex");
  assert.ok(path.isAbsolute(expectedRoot));
  assert.ok(path.isAbsolute(fixtureDirectory));
  const { root: resolvedRoot } = await validateSurfaceOwnedRoot(expectedRoot);
  const dataDirectory = path.join(resolvedRoot, "data");
  const resolvedFixture = path.resolve(fixtureDirectory);
  const samePath = (left, right) =>
    path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
  assert.doesNotMatch(resolvedRoot, /^C:[\\/]/iu);
  assert.match(
    path.basename(resolvedFixture),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  );
  assert.ok(
    samePath(
      path.dirname(resolvedFixture),
      path.join(dataDirectory, "native-ui-fixtures"),
    ),
    "Conflict fixture must be this owned data directory's UUID fixture",
  );
  const configDirectory = path.join(resolvedFixture, "codex");
  const configFile = path.join(configDirectory, "config.toml");
  async function assertOwnedPlain(location, file = false) {
    const relative = path.relative(resolvedRoot, path.resolve(location));
    assert.ok(
      relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    );
    assert.ok(samePath(await fs.realpath(resolvedRoot), resolvedRoot));
    let current = resolvedRoot;
    const rootStat = await fs.lstat(current);
    assert.ok(rootStat.isDirectory() && !rootStat.isSymbolicLink());
    const parts = relative.split(path.sep);
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      const info = await fs.lstat(current);
      assert.equal(
        info.isSymbolicLink(),
        false,
        "Owned conflict paths may not contain links",
      );
      if (file && index === parts.length - 1) {
        assert.ok(
          info.isFile(),
          "Only an existing ordinary file may be written",
        );
        assert.equal(
          info.nlink,
          1,
          "A hard-linked file is outside this write boundary",
        );
      } else assert.ok(info.isDirectory());
    }
    assert.ok(samePath(await fs.realpath(location), location));
  }
  await assertOwnedPlain(resolvedFixture);
  const ownerFile = path.join(resolvedFixture, ".ae-native-ui-owner.json");
  await assertOwnedPlain(ownerFile, true);
  const ownership = JSON.parse(await fs.readFile(ownerFile, "utf8"));
  assert.equal(ownership.purpose, "synthetic native UI acceptance");
  await assertOwnedPlain(configFile, true);
  const initial = await native("get_overview");
  assert.ok(samePath(initial.dataDirectory, dataDirectory));
  const before = initial.targets.find((value) => value.target === target);
  assert.ok(before && samePath(before.directory, configDirectory));
  assert.equal(before.state, "applied");
  assert.equal(before.canRestore, true);
  assert.ok(
    Number.isSafeInteger(before.configurationRevision) &&
      before.configurationRevision > 0,
  );
  const activeProvider = initial.providers.find(
    (value) => value.id === before.activeProviderId,
  );
  assert.ok(activeProvider);
  const originalBytes = await fs.readFile(configFile);
  const originalText = originalBytes.toString("utf8");
  assert.ok(Buffer.from(originalText, "utf8").equals(originalBytes));
  const managedModels = [
    ...originalText.matchAll(/^(model\s*=\s*)"([^"\r\n]*)"([^\r\n]*)$/gmu),
  ];
  assert.equal(
    managedModels.length,
    1,
    "A unique managed model line is required",
  );
  assert.equal(managedModels[0][2], activeProvider.model);
  const conflictModel = "ae-switch-synthetic-owned-conflict-model";
  assert.equal(
    activeProvider.codexOptions.models.some(
      (value) => value.id === conflictModel,
    ),
    false,
  );
  const conflictBytes = Buffer.from(
    originalText.replace(
      managedModels[0][0],
      `${managedModels[0][1]}"${conflictModel}"${managedModels[0][3]}`,
    ),
    "utf8",
  );
  assert.equal(conflictBytes.equals(originalBytes), false);
  async function writeOwned(bytes) {
    await assertOwnedPlain(configFile, true);
    const file = await fs.open(configFile, "r+");
    try {
      const descriptor = await file.stat();
      const current = await fs.lstat(configFile);
      assert.equal(descriptor.dev, current.dev);
      assert.equal(descriptor.ino, current.ino);
      assert.ok(
        current.isFile() && !current.isSymbolicLink() && current.nlink === 1,
      );
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await file.write(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        assert.ok(bytesWritten > 0);
        offset += bytesWritten;
      }
      await file.truncate(bytes.length);
      await file.sync();
    } finally {
      await file.close();
    }
  }
  const poll = async (read, predicate, label) => {
    const deadline = Date.now() + 30000;
    do {
      const value = await read();
      if (predicate(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.fail(`${label} did not reach the expected state`);
  };
  const status = async () =>
    (await native("get_overview")).targets.find(
      (value) => value.target === target,
    );
  const refresh = async () => {
    const control = page.getByRole("button", {
      name: "刷新配置状态",
      exact: true,
    });
    await poll(() => control.isEnabled(), Boolean, "Conflict refresh unlocked");
    await control.click();
    await poll(
      () => control.isEnabled(),
      Boolean,
      "Conflict refresh completed",
    );
  };
  const assertConflictRetained = async () => {
    await assertOwnedPlain(configFile, true);
    assert.ok(
      (await fs.readFile(configFile)).equals(conflictBytes),
      "The UI must not overwrite the external change",
    );
    const current = await status();
    assert.equal(current.state, "external_change");
    assert.equal(current.activeProviderId, before.activeProviderId);
    assert.equal(current.canRestore, true);
    assert.equal(current.configurationRevision, before.configurationRevision);
    assert.deepEqual(
      (await native("get_overview")).providers,
      initial.providers,
    );
  };
  const settings = page.getByRole("dialog", {
    name: "Codex 设置",
    exact: true,
  });
  const restoration = page.getByRole("dialog", {
    name: "恢复原来的 API 配置？",
    exact: true,
  });
  const conflict = page.getByRole("dialog", {
    name: "处理现有配置",
    exact: true,
  });
  const help = page.getByRole("dialog", { name: "使用说明", exact: true });
  let mutationStarted = false;
  let completed = false;
  try {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    assert.equal(
      await settings
        .getByRole("button", { name: "修改目录", exact: true })
        .isEnabled(),
      false,
    );
    await settings
      .getByText("当前目录已接管，更换前请先恢复原配置。", { exact: true })
      .waitFor();
    await settings
      .getByRole("button", { name: "恢复原配置", exact: true })
      .click();
    await restoration
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await restoration.waitFor({ state: "hidden" });
    assert.ok((await fs.readFile(configFile)).equals(originalBytes));
    assert.deepEqual(await status(), before);

    // lib.rs checks this mismatch before it schedules restart::restart_client.
    // Zero cannot equal the positive applied revision checked above.
    const staleRestart = await invoke("restart_client", {
      target,
      configurationRevision: 0,
    });
    assert.equal(staleRestart.ok, false);
    assert.equal(staleRestart.error.code, "restart_configuration_changed");
    assert.deepEqual(await status(), before);
    await record("native-management-managed-directory-stale-restart", {
      target,
      managedDirectoryChangeDisabled: true,
      restoreCancelWithoutWrite: true,
      staleRevisionRejected: true,
      errorCode: staleRestart.error.code,
      correctRevisionSubmitted: false,
      clientRestarted: false,
    });

    mutationStarted = true;
    await writeOwned(conflictBytes);
    await refresh();
    await poll(
      status,
      (value) => value?.state === "external_change",
      "Actual external configuration conflict",
    );
    await assertConflictRetained();
    const card = page.locator("li.provider-card").filter({
      has: page.locator(`[data-provider-name="${activeProvider.id}"]`),
    });
    assert.equal(await card.locator(".apply-button").isEnabled(), false);
    const viewConflict = card.getByRole("button", {
      name: "查看配置",
      exact: true,
    });
    await viewConflict.click();
    await conflict.waitFor();
    assert.ok(
      (await conflict.locator(".scope-hint").innerText()).includes(
        "现有文件未被覆盖",
      ),
    );
    await conflict
      .getByRole("button", { name: "查看处理教程", exact: true })
      .click();
    await help
      .getByRole("heading", { name: "常见问题", exact: true, level: 3 })
      .waitFor();
    assert.equal(
      await help
        .getByRole("navigation", { name: "教程目录", exact: true })
        .getByRole("button", { name: "常见问题", exact: true })
        .getAttribute("aria-current"),
      "page",
    );
    await help.getByRole("button", { name: "关闭弹窗", exact: true }).click();
    await help.waitFor({ state: "hidden" });
    await assertConflictRetained();
    await viewConflict.click();
    await conflict.getByRole("button", { name: "知道了", exact: true }).click();
    await conflict.waitFor({ state: "hidden" });
    await assertConflictRetained();

    await page.getByRole("button", { name: "设置", exact: true }).click();
    assert.equal(
      await settings
        .getByRole("button", { name: "修改目录", exact: true })
        .isEnabled(),
      false,
    );
    await settings
      .getByRole("button", { name: "恢复原配置", exact: true })
      .click();
    await restoration
      .getByRole("button", { name: "恢复原配置", exact: true })
      .click();
    await restoration.getByRole("alert").waitFor();
    assert.match(
      await restoration.getByRole("alert").innerText(),
      /已被其他工具修改|撤回相应修改/u,
    );
    await assertConflictRetained();
    await restoration
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await restoration.waitFor({ state: "hidden" });
    completed = true;
  } finally {
    if (mutationStarted) {
      // Restore the one validated owned file even when an assertion fails.
      await writeOwned(originalBytes);
      await assertOwnedPlain(configFile, true);
      assert.ok((await fs.readFile(configFile)).equals(originalBytes));
    }
    for (const dialog of [help, conflict, restoration, settings]) {
      if (await dialog.isVisible()) {
        await dialog
          .getByRole("button", { name: "关闭弹窗", exact: true })
          .click();
        await dialog.waitFor({ state: "hidden" });
      }
    }
    await refresh();
    await poll(
      status,
      (value) => value?.state === "applied",
      "Owned conflict byte restoration",
    );
    assert.deepEqual(await status(), before);
    assert.deepEqual(
      (await native("get_overview")).providers,
      initial.providers,
    );
    assert.ok((await fs.readFile(configFile)).equals(originalBytes));
  }
  assert.equal(completed, true);
  await record("native-management-owned-conflict", {
    target,
    nativeState: "external_change",
    realManagedModelFieldChange: true,
    conflictModalAndTroubleshootingReached: true,
    acknowledgeWithoutOverwrite: true,
    applyDisabled: true,
    restoreRejectedWithoutOverwrite: true,
    baselineActiveProviderAndRevisionRetained: true,
    originalBytesRestored: true,
    recoveredNativeState: "applied",
    configSha256: createHash("sha256").update(originalBytes).digest("hex"),
    onlyOwnedConfigWritten: true,
    clientRestarted: false,
  });
}
