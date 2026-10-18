import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

// Read-only native discovery is controlled by its owned QA metadata fixture.
// Tauri IPC, model queries, profile selection and submit gates remain real.
export async function verifyInstalledProfileUi({
  page,
  invoke,
  fixture,
  record,
  assertPhysicalWorkspacePath,
}) {
  const contextPath = fixture.discoveryContextFile;
  await assertPhysicalWorkspacePath(contextPath);
  const originalBytes = await fs.readFile(contextPath);
  const original = JSON.parse(originalBytes);
  const profiles = fixture.discoveredProfiles ?? fixture.profiles;
  const profile = profiles.codex;
  const native = async (command) => {
    const result = await invoke(command);
    assert.equal(result.ok, true);
    return result.result;
  };
  const before = await native("agent_hub_overview");
  const providerBefore = await native("get_overview");
  const navigation = page.getByRole("navigation", {
    name: "选择 Agent",
    exact: true,
  });
  await navigation
    .getByRole("button")
    .filter({
      has: page.getByRole("img", { name: "Codex 官方图标", exact: true }),
    })
    .click();
  const selector = page.locator("#hub-installed-profile");
  const confirm = page.getByRole("button", { name: "确认并验证", exact: true });
  const refresh = page.getByRole("button", {
    name: "重新探测工具",
    exact: true,
  });
  const persistentHub = ({ dataDirectory, agents }) => ({
    dataDirectory,
    agents,
  });
  const protectedPaths = [
    profile.configFile ?? path.join(profile.directory, "config.toml"),
    ...["agent-selection.json", "agent-native-configuration.pending.json"].map(
      (name) => path.join(process.env.AE_NATIVE_EXPECTED_ROOT, "data", name),
    ),
  ];
  const protectedSnapshot = async () =>
    Promise.all(
      protectedPaths.map(async (location) => {
        await assertPhysicalWorkspacePath(location, { allowMissing: true });
        try {
          return createHash("sha256")
            .update(await fs.readFile(location))
            .digest("hex");
        } catch (error) {
          if (error.code === "ENOENT") return null;
          throw error;
        }
      }),
    );
  const originalProtectedFiles = await protectedSnapshot();
  const assertNoConfigurationWrites = async () => {
    assert.deepEqual(
      persistentHub(await native("agent_hub_overview")),
      persistentHub(before),
    );
    assert.deepEqual(await protectedSnapshot(), originalProtectedFiles);
  };
  const waitProfile = async (value) => {
    await page.waitForFunction(
      (expected) => {
        const field = document.getElementById("hub-installed-profile");
        if (!field || field.disabled) return false;
        if (expected === "") return field.value === "";
        if (!field.value) return false;
        const actual = JSON.parse(field.value);
        return (
          Object.keys(actual).length === Object.keys(expected).length &&
          Object.entries(expected).every(([key, item]) => actual[key] === item)
        );
      },
      value === "" ? "" : JSON.parse(value),
      { timeout: 15000 },
    );
  };
  const extraDirectory = path.join(
    path.dirname(profile.executablePath),
    `extra-${randomUUID()}`,
  );
  const extraExecutable = path.join(
    extraDirectory,
    path.basename(profile.executablePath),
  );
  let extraCreated = false;
  const emptyDirectory = path.join(
    path.dirname(profile.executablePath),
    `empty-${randomUUID()}`,
  );
  let emptyCreated = false;
  let manualActive = false;
  try {
    await waitProfile(JSON.stringify(profile));
    await page.waitForFunction(
      () => !document.querySelector(".hub-form-actions .primary")?.disabled,
      null,
      { timeout: 60000 },
    );
    assert.equal(
      await confirm.isEnabled(),
      true,
      "The valid discovered model and original profile must enable confirmation before testing an incomplete directory",
    );
    await page
      .getByRole("button", { name: "手动指定已有客户端", exact: true })
      .click();
    manualActive = true;
    const manual = page.locator(".hub-manual-profile");
    const directory = manual.getByLabel("原配置目录", { exact: true });
    await directory.fill("");
    assert.equal(await confirm.isEnabled(), false);
    await page.locator("#hub-endpoint").press("Enter");
    await assertNoConfigurationWrites();
    await directory.fill(profile.directory);
    assert.equal(
      await confirm.isEnabled(),
      true,
      "Restoring the actual profile must enable confirmation",
    );
    for (const [field, label] of [
      ["directory", "原配置目录"],
      ["homeDirectory", "原用户目录"],
      ["executablePath", "客户端启动文件"],
      ["workspaceDirectory", "工作目录"],
    ])
      assert.equal(
        await manual.getByLabel(label, { exact: true }).inputValue(),
        profile[field],
      );
    await manual.locator("summary").click();
    const optional = manual.getByLabel("XDG 缓存目录", { exact: true });
    await optional.fill(profile.xdgCacheDirectory ?? "");
    await manual.locator("summary").click();
    await page
      .getByRole("button", { name: "使用自动探测结果", exact: true })
      .click();
    manualActive = false;
    await waitProfile(JSON.stringify(profile));
    await record("native-installed-manual-profile-ui", {
      populatedFromOriginalProfile: true,
      incompleteProfileBlocked: true,
      enterDidNotWriteConfiguration: true,
      optionalPathsEditable: true,
      returnedToAutomaticDiscovery: true,
    });

    await assertPhysicalWorkspacePath(path.dirname(emptyDirectory));
    await fs.mkdir(emptyDirectory);
    emptyCreated = true;
    await fs.writeFile(
      contextPath,
      JSON.stringify({ ...original, environment: { PATH: emptyDirectory } }),
    );
    await refresh.click();
    await waitProfile("");
    assert.equal(await confirm.isEnabled(), false);
    await page.getByText(/未探测到已安装的 Codex/u).waitFor();
    await record("native-installed-missing-client-ui", {
      noPrivateFallback: true,
      configurationBlocked: true,
    });

    await fs.writeFile(contextPath, "{");
    await refresh.click();
    await waitProfile("");
    await page.getByText(/探测未完成：测试专用发现上下文无效/u).waitFor();
    assert.equal(await confirm.isEnabled(), false);
    await record("native-installed-invalid-discovery-ui", {
      originalEnvironmentNotScanned: true,
      limitedDiscoveryReasonVisible: true,
      noStaleProfileUsed: true,
    });

    await assertPhysicalWorkspacePath(path.dirname(extraDirectory));
    await fs.mkdir(extraDirectory);
    extraCreated = true;
    await fs.copyFile(profile.executablePath, extraExecutable);
    await assertPhysicalWorkspacePath(extraExecutable);
    await fs.writeFile(
      contextPath,
      JSON.stringify({
        ...original,
        environment: {
          ...original.environment,
          PATH: `${original.environment.PATH};${extraDirectory}`,
        },
      }),
    );
    await refresh.click();
    await page.waitForFunction(
      () => {
        const field = document.getElementById("hub-installed-profile");
        return field && !field.disabled && field.options.length === 3;
      },
      null,
      { timeout: 15000 },
    );
    assert.equal(await selector.inputValue(), "");
    assert.equal(await confirm.isEnabled(), false);
    const originalValue = (
      await selector
        .locator("option")
        .evaluateAll((options) => options.map((option) => option.value))
    ).find((value) => value && isDeepStrictEqual(JSON.parse(value), profile));
    assert.ok(originalValue, "The actual original profile option must exist");
    await selector.selectOption(originalValue);
    await waitProfile(JSON.stringify(profile));
    await assertNoConfigurationWrites();
    assert.deepEqual(await native("get_overview"), providerBefore);
    await record("native-installed-multiple-client-ui", {
      explicitSelectionRequired: true,
      originalClientSelected: true,
      noClientExecuted: true,
      configurationAndProviderStateUnchanged: true,
    });
  } finally {
    await assertPhysicalWorkspacePath(contextPath);
    await fs.writeFile(contextPath, originalBytes);
    assert.equal(
      createHash("sha256")
        .update(await fs.readFile(contextPath))
        .digest("hex"),
      createHash("sha256").update(originalBytes).digest("hex"),
    );
    if (extraCreated) {
      await assertPhysicalWorkspacePath(extraExecutable);
      assert.equal(
        createHash("sha256")
          .update(await fs.readFile(extraExecutable))
          .digest("hex"),
        createHash("sha256")
          .update(await fs.readFile(profile.executablePath))
          .digest("hex"),
      );
      await fs.unlink(extraExecutable);
      await fs.rmdir(extraDirectory);
    }
    if (emptyCreated) {
      await assertPhysicalWorkspacePath(emptyDirectory);
      await fs.rmdir(emptyDirectory);
    }
    if (manualActive)
      await page
        .getByRole("button", { name: "使用自动探测结果", exact: true })
        .click();
    await refresh.click();
    await waitProfile(JSON.stringify(profile));
  }
  return {
    passed: true,
    contextRestoredByteForByte: true,
    extraCandidateRemoved: true,
    realRustDiscoveryAndOrdinaryUi: true,
  };
}
