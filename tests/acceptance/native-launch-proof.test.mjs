import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  armNativeLaunchProof,
  validateNativeLaunchAcknowledgment,
  waitForNativeLaunchAcknowledgment,
} from "./native-launch-proof.mjs";

const request = {
  id: "codex", requestId: "a".repeat(32), ownerId: "b".repeat(32),
  qaPid: 123, qaStartedAt: "2026-10-11T00:00:00.000Z", qaSha256: "c".repeat(64),
  launcher: path.resolve(".cache/test-codex.ps1"), requestedAt: "2026-10-11T00:00:01.000Z",
};
const proof = {
  ...request, stage: "proof", ownedQaIdentityVerified: true,
  recordedAt: "2026-10-11T00:00:01.200Z", pid: 456, parentPid: 123,
  startedAt: "2026-10-11T00:00:01.100Z", imageSha256: "d".repeat(64),
  kind: "official-powershell-launcher", nativeLaunch: true, retainedIdentityProofPassed: true,
};
test("current request matches exact retained UI creation identity", () => {
  assert.equal(validateNativeLaunchAcknowledgment(request, proof, "proof"), proof);
});
for (const [name, change] of [
  ["old probe with the same PID", (v) => { v.startedAt = "2026-10-11T00:00:00.500Z"; }],
  ["retained task probe", (v) => { v.nativeLaunch = false; }],
  ["reused PID with old creation identity", (v) => { v.pid = proof.pid; v.startedAt = request.qaStartedAt; }],
  ["wrong request nonce", (v) => { v.requestId = "e".repeat(32); }],
  ["foreign owner", (v) => { v.ownerId = "f".repeat(32); }],
  ["foreign parent", (v) => { v.parentPid++; }],
  ["wrong QA creation", (v) => { v.qaStartedAt = proof.startedAt; }],
  ["wrong launcher", (v) => { v.launcher = path.resolve(".cache/foreign.ps1"); }],
  ["forged unproved confirmation", (v) => { v.retainedIdentityProofPassed = false; }],
  ["ready mistaken for process proof", (v) => { v.stage = "ready"; }],
]) test(`reject ${name}`, () => {
  const value = structuredClone(proof); change(value);
  assert.throws(() => validateNativeLaunchAcknowledgment(request, value, "proof"));
});
test("DSH cannot arm an empty UI launch", async () => {
  await assert.rejects(armNativeLaunchProof({ ...request, id: "deepseek_harness" }));
});
test("missing proof times out without accepting a launch", async () => {
  const context = { directory: path.resolve(".cache/absent-native-launch-proof"), assertPhysicalPath: async () => {} };
  await assert.rejects(waitForNativeLaunchAcknowledgment(context, request, "proof", 50), /timed out/u);
});
test("a delayed acknowledgment is awaited within the fixed deadline", async () => {
  const directory = path.resolve(".cache/tmp", `native-launch-proof-test-${randomUUID()}`);
  await fs.mkdir(directory);
  const filename = path.join(directory, `proof-${request.id}-${request.requestId}.json`);
  const context = { directory, assertPhysicalPath: async (file) => {
    assert.ok(file.startsWith(directory + path.sep));
    try { assert.equal((await fs.lstat(file)).isSymbolicLink(), false); } catch (error) { if (error.code !== "ENOENT") throw error; }
  } };
  let writer;
  try {
    const waiting = waitForNativeLaunchAcknowledgment(context, request, "proof", 1000);
    writer = new Promise((resolve, reject) => setTimeout(() => fs.writeFile(filename, JSON.stringify(proof), { flag: "wx" }).then(resolve, reject), 75));
    assert.deepEqual(await waiting, proof);
    await writer;
  } finally {
    if (writer) await writer;
    if (await fs.stat(filename).catch(() => null)) await fs.unlink(filename);
    await fs.rmdir(directory);
  }
});
