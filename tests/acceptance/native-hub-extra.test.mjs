import assert from "node:assert/strict";
import { test } from "node:test";
import { assertExistingRevalidationScope } from "./native-hub-extra.mjs";

const defaultScope =
  "原配置的默认模型已用于本次命令行验证；桌面界面与已有会话尚未验证。";
const explicitScope =
  "本次通过命令行入口并显式指定模型；桌面界面与默认模型选择尚未验证。";
function proof(id = "codex") {
  const profile = {
    directory: `G:\\owned\\installed-clients\\home\\.${id}`,
    homeDirectory: "G:\\owned\\installed-clients\\home",
    executablePath: `G:\\owned\\installed-clients\\bin\\${id}.ps1`,
  };
  const agent = { id, mode: "existing", profile, directory: profile.directory };
  return {
    agent,
    probe: {
      profileMode: "existing",
      clientSurface: "headless-cli",
      verificationScope: "headless_tool_write_read",
      desktopGuiVerified: false,
      desktopDefaultSelectionVerified: false,
      explicitModelArgument: id === "workbuddy",
      nativeDefaultModelVerified: id !== "workbuddy",
    },
    current: structuredClone(agent),
    scopeText: id === "workbuddy" ? explicitScope : defaultScope,
  };
}
const verify = ({ agent, probe, current, scopeText }) =>
  assertExistingRevalidationScope(agent, probe, current, scopeText);

for (const id of [
  "claude_code",
  "codex",
  "hermes",
  "oh_my_pi",
  "opencode",
  "zcode",
  "workbuddy",
  "deepseek_harness",
])
  test(`${id} retry proves the correct model source, profile and visible scope`, () => {
    assert.equal(verify(proof(id)), true);
  });

for (const [field, value] of [
  ["profileMode", "private"],
  ["clientSurface", "desktop-gui"],
  ["verificationScope", "connection"],
  ["desktopGuiVerified", true],
  ["desktopDefaultSelectionVerified", true],
  ["explicitModelArgument", true],
  ["nativeDefaultModelVerified", false],
]) {
  test(`retry rejects incorrect ${field}`, () => {
    const item = proof();
    item.probe[field] = value;
    assert.throws(() => verify(item));
    delete item.probe[field];
    assert.throws(() => verify(item));
  });
}
test("WorkBuddy retry cannot claim a default model or omit its explicit argument", () => {
  for (const field of ["nativeDefaultModelVerified", "explicitModelArgument"]) {
    const item = proof("workbuddy");
    item.probe[field] = !item.probe[field];
    assert.throws(() => verify(item));
  }
});
test("retry rejects changed original profile or configuration directory", () => {
  const profileChanged = proof();
  profileChanged.current.profile.executablePath = "G:\\other\\codex.ps1";
  assert.throws(() => verify(profileChanged));
  const directoryChanged = proof();
  directoryChanged.current.directory =
    "G:\\owned\\portable\\data\\agents\\codex";
  assert.throws(() => verify(directoryChanged));
});
test("success text must disclose the exact actual scope", () => {
  for (const id of ["codex", "workbuddy"])
    for (const scopeText of [
      "",
      "全部功能验证通过",
      id === "workbuddy" ? defaultScope : explicitScope,
    ])
      assert.throws(() => verify({ ...proof(id), scopeText }));
});
test("profile presence and explicit existing mode both enforce the gate", () => {
  const byProfile = proof();
  delete byProfile.agent.mode;
  byProfile.probe.profileMode = "private";
  assert.throws(() => verify(byProfile));
  const byMode = proof();
  delete byMode.agent.profile;
  assert.throws(() => verify(byMode));
  const byProfileMode = proof();
  delete byProfileMode.agent.profile;
  delete byProfileMode.agent.mode;
  byProfileMode.agent.profileMode = "existing";
  assert.throws(() => verify(byProfileMode));
  assert.equal(
    verify({
      agent: { mode: "private" },
      probe: {},
      current: {},
      scopeText: "",
    }),
    false,
  );
});
