// Importing the live diagnostic would read its designated credentials. Extract
// only its exact isolated observer for synthetic owned-file contract tests.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
const code = fs.readFileSync(
  new URL("./production-codex-byte-diagnostic.mjs", import.meta.url),
  "utf8",
);
const supervisor = fs.readFileSync(
  new URL("./verify-production-codex-byte-diagnostic.ps1", import.meta.url),
  "utf8",
);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const functionBody = code.slice(
  code.indexOf("function observeToolWorkspace("),
  code.indexOf("const setupFile ="),
);
assert.ok(functionBody.startsWith("function observeToolWorkspace("));

for (const [name, suffix, exact, lf, crlf] of [
  ["no newline", "", true, false, false],
  ["one LF", "\n", false, true, false],
  ["CRLF", "\r\n", false, false, true],
  ["two LF", "\n\n", false, false, false],
  ["extra text", "extra", false, false, false],
]) {
  test(`read-only observer distinguishes exact byte shape: ${name}`, () => {
    const root = path.resolve(
      ".cache/tmp/codex-byte-observer-test-" + randomUUID(),
    );
    const nonce = randomUUID();
    const name = ".ae-tool-verification-" + nonce;
    const directory = path.join(root, "agent-verification/codex", name);
    fs.mkdirSync(directory, { recursive: true });
    const target = path.join(directory, name + ".txt");
    const marker = "AE_TOOL_VERIFIED_" + nonce.replaceAll("-", "");
    fs.writeFileSync(target, marker + suffix, { flag: "wx" });
    const before = sha(fs.readFileSync(target));
    let observer;
    try {
      const guard = (file) => {
        assert.ok(path.resolve(file).startsWith(root + path.sep));
        assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
        return file;
      };
      const factory = new Function(
        "fs",
        "path",
        "assert",
        "guard",
        "setup",
        "sha",
        "observeDirectoryOnly",
        functionBody + "\nreturn observeToolWorkspace;",
      );
      const observe = factory(fs, path, assert, guard, { root }, sha, () => ({
        close() {},
        finish: () => ({ directoryName: name }),
      }));
      observer = observe(root, "codex");
      const result = observer.finish();
      assert.equal(result.markerContentsObserved, true);
      assert.equal(result.byteObservations.length, 1);
      const sample = result.byteObservations[0];
      assert.equal(sample.exactMarker, exact);
      assert.equal(sample.exactMarkerSingleLf, lf);
      assert.equal(sample.exactMarkerCrLf, crlf);
      assert.equal(sample.fileBytes, Buffer.byteLength(marker + suffix));
      assert.equal(sample.fileSha256, before);
      assert.equal(sample.observerWroteFile, false);
      assert.equal(sha(fs.readFileSync(target)), before);
      assert.equal(JSON.stringify(sample).includes(marker), false);
    } finally {
      observer?.close();
      assert.ok(root.startsWith(path.resolve(".cache/tmp") + path.sep));
      fs.rmSync(root, { recursive: true });
    }
  });
}

test("diagnostic and supervisor require exactly one Codex first/retest", () => {
  assert.match(code, /const AGENTS = \["codex"\]/u);
  assert.match(code, /assert\.equal\(agentId, "codex"\)/u);
  assert.match(code, /report\.clients\.length === 1/u);
  assert.ok(supervisor.includes("@('codex')|ForEach-Object"));
  assert.ok(supervisor.includes("@($results.clients).Count -eq 1"));
  assert.ok(supervisor.includes("$results.clients[0].id -ceq 'codex'"));
  assert.ok(supervisor.includes("$results.firstPassedCount -eq 1"));
  assert.ok(supervisor.includes("$results.independentRetestPassedCount -eq 1"));
  assert.doesNotMatch(
    supervisor,
    /allEightLauncherObserved|PassedCount -eq 8/u,
  );
});
test("clone keeps current source, real supplier UI and helper/process binding", () => {
  for (const required of [
    "Real supplier endpoint required",
    "AE_PRODUCTION_UI_MODEL",
    "sourceBefore.digest === sourceAfter.digest",
    "production-codex-byte-diagnostic",
    "verify-production-codex-byte-diagnostic.ps1",
    "new Rust verification UUID",
  ])
    assert.ok(code.includes(required));
  for (const required of [
    "Assert-ProductionBuildBinding",
    "Assert-E2eNativeProcessIdentity",
    "helperBindingsUnchangedThroughCleanup",
    "Remove-E2eOwnedTree $e2eSandbox",
  ])
    assert.ok(supervisor.includes(required));
  assert.doesNotMatch(code, /Single OpenCode|const AGENTS = \["opencode"\]/u);
  assert.doesNotMatch(
    functionBody,
    /writeFile|appendFile|copyFile|renameSync|unlink/u,
  );
});
