// Exercise the actual auditor against a deliberately added, synthetic RTK DB.
// Only that exact file and its newly created empty directory are removed.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const workspace = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const packageDirectory = path.resolve(process.argv[2]);
const reportDirectory = path.resolve(process.argv[3]);
const within = (base, target) => {
  const relative = path.relative(base, target);
  return (
    relative &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};
assert.ok(within(path.join(workspace, "artifacts"), packageDirectory));
assert.ok(
  within(path.join(workspace, "artifacts/acceptance"), reportDirectory),
);
const parent = path.join(packageDirectory, "source/ae-switch/app");
assert.equal((await fs.realpath(parent)).toLowerCase(), parent.toLowerCase());
const directory = path.join(parent, "rtk");
const file = path.join(directory, "audit-regression.db");
const runtimeDirectory = path.join(
  packageDirectory,
  "runtime-audit-regression",
);
const runtimeFiles = [
  "runtime-integrity.key",
  "agent-ownership-codex.json",
  "agent-ownership-codex.pending.json",
  "agent-ownership-codex.json.pending",
  "agent-disconnect.pending.json",
  "agent-configuration.pending.json",
  "agent-native-configuration.pending.json",
  "agent-selection.json",
  "protocol-bridge.json",
  "config-profiles.json",
  "config-profiles.pending.json",
].map((name) => path.join(runtimeDirectory, name));
const createdFiles = [];
assert.ok(within(packageDirectory, file));
await fs.mkdir(directory); // Fail if an existing directory could be affected.
let runtimeDirectoryCreated = false;
try {
  await fs.mkdir(runtimeDirectory); // Outside data/source/docs to test basename gating.
  runtimeDirectoryCreated = true;
  await fs.writeFile(file, "synthetic developer database marker", {
    flag: "wx",
  });
  createdFiles.push(file);
  for (const runtimeFile of runtimeFiles) {
    await fs.writeFile(
      runtimeFile,
      '{"syntheticPrivateOriginalConfiguration":true}',
      { flag: "wx" },
    );
    createdFiles.push(runtimeFile);
  }
  const result = spawnSync(
    process.execPath,
    [
      path.join(workspace, "tests/acceptance/final-package-audit.mjs"),
      packageDirectory,
      reportDirectory,
    ],
    { encoding: "utf8", timeout: 120_000 },
  );
  assert.equal(result.status, 1);
  const correspondence = JSON.parse(
    await fs.readFile(
      path.join(reportDirectory, "final-package-correspondence.json"),
      "utf8",
    ),
  );
  const boundaries = JSON.parse(
    await fs.readFile(
      path.join(reportDirectory, "final-package-boundaries.json"),
      "utf8",
    ),
  );
  assert.equal(correspondence.passed, false);
  assert.equal(boundaries.passed, false);
  const relative = "source/ae-switch/app/rtk/audit-regression.db";
  assert.ok(correspondence.unexpectedSourcePaths.includes(relative));
  assert.ok(boundaries.privateConfigurationPaths.includes(relative));
  for (const runtimeFile of runtimeFiles) {
    const runtimeRelative = path
      .relative(packageDirectory, runtimeFile)
      .split(path.sep)
      .join("/");
    assert.ok(boundaries.privateConfigurationPaths.includes(runtimeRelative));
  }
  console.log(
    JSON.stringify({
      passed: true,
      rejectedSyntheticRtkDatabase: true,
      rejectedPrivateRuntimeNames: runtimeFiles.length,
      scope: "actual package auditor negative regression",
    }),
  );
} finally {
  for (const created of createdFiles.reverse()) await fs.unlink(created);
  if (runtimeDirectoryCreated) await fs.rmdir(runtimeDirectory);
  await fs.rmdir(directory);
}
