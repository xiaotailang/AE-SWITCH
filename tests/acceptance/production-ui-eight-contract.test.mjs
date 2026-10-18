import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENTS,
  FLAGS,
  isNativeRequest,
  assertInput,
  assertProbe,
  assertConfiguration,
} from "./production-ui-eight-contract.mjs";
import {
  registerPrivateValue,
  privateFreePlaintext,
} from "./acceptance-private-values.mjs";
function check(name, fn) {
  test(name, fn);
}
const request = (url, method = "POST") => ({
  url: () => url,
  method: () => method,
});
check("Exact native HTTP route accepted", () =>
  assert.equal(
    isNativeRequest(request("http://ipc.localhost/probe_agent"), "probe_agent"),
    true,
  ),
);
check("Exact native ipc route accepted", () =>
  assert.equal(
    isNativeRequest(request("ipc://localhost/probe_agent"), "probe_agent"),
    true,
  ),
);
for (const [url, method] of [
  ["http://localhost/probe_agent", "POST"],
  ["http://ipc.localhost.evil/probe_agent", "POST"],
  ["http://ipc.localhost/configure_agent", "POST"],
  ["http://ipc.localhost/probe_agent", "GET"],
  ["https://example.org/probe_agent", "POST"],
])
  check("Foreign or mismatched route rejected " + url + " " + method, () =>
    assert.equal(isNativeRequest(request(url, method), "probe_agent"), false),
  );
const expected = {
  agentId: "codex",
  providerId: "p1",
  model: "real-model",
  profile: { directory: "G:\\owned", executablePath: "G:\\owned\\codex.ps1" },
};
check("Exact selected click input accepted", () =>
  assertInput({ ...expected }, expected),
);
for (const [field, value] of [
  ["agentId", "workbuddy"],
  ["providerId", "p2"],
  ["model", "other"],
  ["profile", { directory: "G:\\foreign" }],
])
  check("Mismatch click input rejected " + field, () =>
    assert.throws(() => assertInput({ ...expected, [field]: value }, expected)),
  );
for (const id of AGENTS) {
  const probe = {
    ok: true,
    toolVerified: true,
    validationScope: "tool",
    stage: "verified",
    model: "real-model",
    profileMode: "existing",
    clientSurface: "headless-cli",
    verificationScope: "headless_tool_write_read",
    desktopGuiVerified: false,
    desktopDefaultSelectionVerified: false,
    explicitModelArgument: id === "workbuddy",
    nativeDefaultModelVerified: id !== "workbuddy",
    evidence: Object.fromEntries(FLAGS.map((flag) => [flag, true])),
    cleanup: {
      succeeded: true,
      removed: true,
      scope: "owned-uuid-verification-directory",
    },
  };
  if (id === "deepseek_harness")
    Object.assign(probe.evidence, {
      terminalCompletionRequired: true,
      terminalCompletedObserved: true,
    });
  check(id + " complete proof accepted", () =>
    assertProbe(probe, id, "real-model"),
  );
  for (const flag of FLAGS)
    check(id + " false " + flag + " rejected", () =>
      assert.throws(() =>
        assertProbe(
          { ...probe, evidence: { ...probe.evidence, [flag]: false } },
          id,
          "real-model",
        ),
      ),
    );
  for (const [field, value] of [
    ["desktopGuiVerified", true],
    ["desktopDefaultSelectionVerified", true],
    ["model", "other"],
    ["toolVerified", false],
  ])
    check(id + " invalid " + field + " rejected", () =>
      assert.throws(() =>
        assertProbe({ ...probe, [field]: value }, id, "real-model"),
      ),
    );
  check(id + " cleanup false rejected", () =>
    assert.throws(() =>
      assertProbe(
        { ...probe, cleanup: { ...probe.cleanup, removed: false } },
        id,
        "real-model",
      ),
    ),
  );
}
const configured = {
  id: "codex",
  configured: true,
  mode: "existing",
  providerId: "p1",
  model: "real-model",
  configurationRevision: 1,
  profile: expected.profile,
};
check("Fresh config revision binding accepted", () =>
  assertConfiguration(configured, { ...configured }, expected),
);
check("Stale revision rejected", () =>
  assert.throws(() =>
    assertConfiguration(
      configured,
      { ...configured, configurationRevision: 2 },
      expected,
    ),
  ),
);
const values = new Set();
registerPrivateValue(values, "SYNTHETIC-KEY");
registerPrivateValue(values, "https://synthetic.invalid/private/v1", true);
for (const payload of [
  "SYNTHETIC-KEY",
  "https://synthetic.invalid/private/v1",
  "https:\\/\\/synthetic.invalid\\/private\\/v1",
  "https%3A%2F%2Fsynthetic.invalid%2Fprivate%2Fv1",
  "synthetic.invalid",
])
  check("Private plaintext rejected " + JSON.stringify(payload), () =>
    assert.equal(privateFreePlaintext(Buffer.from(payload), values), false),
  );
check("UTF16 private payload rejected", () =>
  assert.equal(
    privateFreePlaintext(Buffer.from("SYNTHETIC-KEY", "utf16le"), values),
    false,
  ),
);
check("Unicode escaped private payload rejected", () =>
  assert.equal(
    privateFreePlaintext(
      Buffer.from(
        [..."SYNTHETIC-KEY"]
          .map((c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"))
          .join(""),
      ),
      values,
    ),
    false,
  ),
);
check("Binary payload rejected", () =>
  assert.equal(privateFreePlaintext(Buffer.from([0, 1, 2]), values), false),
);
check("Clean plaintext may archive", () =>
  assert.equal(
    privateFreePlaintext(
      Buffer.from('{"role":"assistant","text":"AE_HISTORY_123"}\n'),
      values,
    ),
    true,
  ),
);
