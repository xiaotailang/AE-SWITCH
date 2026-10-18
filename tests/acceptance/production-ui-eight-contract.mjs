import assert from "node:assert/strict";
export const AGENTS = [
  "claude_code",
  "codex",
  "hermes",
  "oh_my_pi",
  "opencode",
  "zcode",
  "workbuddy",
  "deepseek_harness",
];
export const FLAGS = [
  "writeObserved",
  "readObserved",
  "readbackMarkerObserved",
  "assistantMarkerObserved",
  "fileMatchesMarker",
  "processSucceeded",
];
export function isNativeRequest(request, command) {
  try {
    const url = new URL(request.url());
    return (
      request.method() === "POST" &&
      ((["http:", "https:"].includes(url.protocol) &&
        url.hostname === "ipc.localhost") ||
        (url.protocol === "ipc:" && url.hostname === "localhost")) &&
      url.pathname === "/" + command
    );
  } catch {
    return false;
  }
}
export function assertInput(input, expected) {
  assert.equal(input.agentId, expected.agentId);
  assert.equal(input.providerId, expected.providerId);
  assert.equal(input.model, expected.model);
  assert.deepEqual(input.profile, expected.profile);
}
export function assertProbe(probe, id, model) {
  for (const [name, value] of Object.entries({
    ok: true,
    toolVerified: true,
    validationScope: "tool",
    stage: "verified",
    model,
    profileMode: "existing",
    clientSurface: "headless-cli",
    verificationScope: "headless_tool_write_read",
    desktopGuiVerified: false,
    desktopDefaultSelectionVerified: false,
    explicitModelArgument: id === "workbuddy",
    nativeDefaultModelVerified: id !== "workbuddy",
  }))
    assert.equal(probe[name], value, id + ": " + name);
  for (const flag of FLAGS)
    assert.equal(probe.evidence?.[flag], true, id + ": " + flag);
  if (id === "deepseek_harness") {
    assert.equal(probe.evidence?.terminalCompletionRequired, true);
    assert.equal(probe.evidence?.terminalCompletedObserved, true);
  }
  assert.equal(probe.cleanup?.succeeded, true);
  assert.equal(probe.cleanup?.removed, true);
  assert.equal(probe.cleanup?.scope, "owned-uuid-verification-directory");
}
export function assertConfiguration(configured, current, expected) {
  for (const value of [configured, current]) {
    assert.equal(value.id, expected.agentId);
    assert.equal(value.configured, true);
    assert.equal(value.mode, "existing");
    assert.equal(value.providerId, expected.providerId);
    assert.equal(value.model, expected.model);
    assert.ok(
      Number.isSafeInteger(value.configurationRevision) &&
        value.configurationRevision > 0,
    );
  }
  assert.equal(current.configurationRevision, configured.configurationRevision);
  assert.deepEqual(current.profile, configured.profile);
}
