import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

const launchIds = new Set([
  "claude_code", "codex", "hermes", "oh_my_pi", "opencode", "zcode", "workbuddy",
]);
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

export function validateNativeLaunchAcknowledgment(request, value, stage) {
  assert.ok(launchIds.has(request.id));
  assert.ok(stage === "ready" || stage === "proof");
  for (const key of ["id", "requestId", "ownerId", "qaPid", "qaStartedAt", "qaSha256"])
    assert.equal(value[key], request[key], `Native launch ${key} must match this request`);
  assert.equal(same(value.launcher, request.launcher), true);
  assert.equal(value.stage, stage);
  assert.equal(value.ownedQaIdentityVerified, true);
  assert.ok(Date.parse(value.recordedAt) >= Date.parse(request.requestedAt));
  if (stage === "proof") {
    assert.equal(value.retainedIdentityProofPassed, true);
    assert.equal(value.nativeLaunch, true);
    assert.equal(value.kind, "official-powershell-launcher");
    assert.equal(value.parentPid, request.qaPid);
    assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0);
    assert.ok(Number.isFinite(Date.parse(value.startedAt)));
    assert.ok(Date.parse(value.startedAt) >= Date.parse(request.requestedAt), "An old probe or reused PID is not this launch");
    assert.match(value.imageSha256 ?? "", /^[a-f0-9]{64}$/u);
  }
  return value;
}

export async function armNativeLaunchProof(context) {
  assert.ok(launchIds.has(context.id), "DSH empty launch must remain rejected");
  assert.match(context.ownerId ?? "", /^[a-f0-9]{32}$/u);
  assert.ok(Number.isSafeInteger(context.qaPid) && context.qaPid > 0);
  assert.ok(Number.isFinite(Date.parse(context.qaStartedAt)));
  assert.match(context.qaSha256 ?? "", /^[a-f0-9]{64}$/u);
  await context.assertPhysicalPath(context.directory);
  const request = {
    id: context.id, ownerId: context.ownerId, requestId: randomUUID().replaceAll("-", ""),
    qaPid: context.qaPid, qaStartedAt: context.qaStartedAt, qaSha256: context.qaSha256,
    launcher: context.launcher, requestedAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + 20000).toISOString(),
  };
  const temporary = path.join(context.directory, `${request.requestId}.tmp`);
  const active = path.join(context.directory, "active-request.json");
  await context.assertPhysicalPath(temporary, { allowMissing: true });
  await context.assertPhysicalPath(active, { allowMissing: true });
  await fs.writeFile(temporary, JSON.stringify(request) + "\n", { flag: "wx" });
  await fs.rename(temporary, active);
  return request;
}

export async function waitForNativeLaunchAcknowledgment(context, request, stage, timeoutMs = 20000) {
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 20000);
  const filename = path.join(context.directory, `${stage}-${request.id}-${request.requestId}.json`);
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    try {
      await context.assertPhysicalPath(filename, { allowMissing: true });
      return validateNativeLaunchAcknowledgment(request, JSON.parse(await fs.readFile(filename, "utf8")), stage);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Native ${request.id} ${stage} acknowledgment timed out; no launch proof was accepted`);
}
