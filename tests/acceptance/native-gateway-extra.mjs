import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { validateSurfaceOwnedRoot } from "./native-surface-extra.mjs";

const runFile = promisify(execFile);
const samePath = (left, right) =>
  path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

// These checks inspect retained process handles and the real TCP owner. They
// never send window input, terminate a process, or manipulate a listener.
const ownershipScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Read-GatewayOwnedProcess([int]$processId, [string]$image, [string]$startedAt) {
    $process = [Diagnostics.Process]::GetProcessById($processId)
    try {
        $retainedHandle = $process.Handle
        $expectedTicks = ([DateTimeOffset]::Parse($startedAt)).UtcDateTime.Ticks
        if ($process.HasExited -or $process.StartTime.ToUniversalTime().Ticks -ne $expectedTicks) { throw 'Gateway fixture process generation changed.' }
        $actualImage = $process.MainModule.FileName
        if ([IO.Path]::GetFullPath($actualImage) -ine [IO.Path]::GetFullPath($image)) { throw 'Gateway fixture process image changed.' }
        $process.Refresh()
        if ($process.HasExited -or $process.Handle -ne $retainedHandle -or $process.StartTime.ToUniversalTime().Ticks -ne $expectedTicks) { throw 'Gateway fixture retained process changed.' }
        return @{ pid = $process.Id; image = $actualImage; startedAt = $process.StartTime.ToUniversalTime().ToString('o'); retainedHandleVerified = $true }
    } finally { $process.Dispose() }
}
$qaImage = Join-Path $env:AE_NATIVE_EXPECTED_ROOT 'AE-Switch-QA.exe'
$qa = Read-GatewayOwnedProcess ([int]$env:AE_NATIVE_QA_PID) $qaImage $env:AE_NATIVE_QA_STARTED_AT
$parent = Read-GatewayOwnedProcess ([int]$env:AE_NATIVE_GATEWAY_FIXTURE_OWNER_PID) $env:AE_NATIVE_PWSH_EXE $env:AE_NATIVE_GATEWAY_FIXTURE_OWNER_STARTED_AT
$qaHash = (Get-FileHash -LiteralPath $qaImage -Algorithm SHA256).Hash.ToLowerInvariant()
if ($qaHash -cne $env:AE_NATIVE_QA_SHA256.ToLowerInvariant()) { throw 'Gateway QA executable hash changed.' }
$ports = @(Get-NetTCPConnection -LocalPort ([int]$env:AE_NATIVE_GATEWAY_FIXTURE_PORT) -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
    @{ address = $_.LocalAddress; ownerPid = [int]$_.OwningProcess }
})
# Re-read both generations after the TCP snapshot, still without side effects.
$null = Read-GatewayOwnedProcess ([int]$env:AE_NATIVE_QA_PID) $qaImage $env:AE_NATIVE_QA_STARTED_AT
$null = Read-GatewayOwnedProcess ([int]$env:AE_NATIVE_GATEWAY_FIXTURE_OWNER_PID) $env:AE_NATIVE_PWSH_EXE $env:AE_NATIVE_GATEWAY_FIXTURE_OWNER_STARTED_AT
@{ qa = $qa; parent = $parent; qaSha256 = $qaHash; listeners = $ports } | ConvertTo-Json -Depth 5 -Compress
`;

export async function verifyGatewayRecovery({
  page,
  invoke,
  record,
  addSecret,
  nativeRoot,
  assertPhysicalWorkspacePath,
}) {
  const env = process.env;
  assert.equal(process.platform, "win32");
  assert.equal(typeof addSecret, "function");
  assert.equal(typeof assertPhysicalWorkspacePath, "function");
  assert.ok(nativeRoot && path.isAbsolute(nativeRoot));
  assert.ok(samePath(nativeRoot, env.AE_NATIVE_EXPECTED_ROOT));
  assert.match(nativeRoot, /^G:[\\/]/iu);
  const { id: fixtureId, workspace } =
    await validateSurfaceOwnedRoot(nativeRoot);
  const portText = env.AE_NATIVE_GATEWAY_FIXTURE_PORT ?? "";
  assert.match(portText, /^[1-9][0-9]{3,4}$/u);
  const port = Number(portText);
  assert.ok(port >= 1024 && port <= 65535 && ![9018, 9223].includes(port));
  const ownerPid = Number(env.AE_NATIVE_GATEWAY_FIXTURE_OWNER_PID);
  const qaPid = Number(env.AE_NATIVE_QA_PID);
  assert.ok(Number.isSafeInteger(ownerPid) && ownerPid > 0);
  assert.ok(Number.isSafeInteger(qaPid) && qaPid > 0 && qaPid !== ownerPid);
  for (const value of [
    env.AE_NATIVE_GATEWAY_FIXTURE_OWNER_STARTED_AT,
    env.AE_NATIVE_QA_STARTED_AT,
  ]) {
    assert.match(value ?? "", /^\d{4}-\d{2}-\d{2}T.*Z$/u);
    assert.ok(Number.isFinite(Date.parse(value)));
  }
  const qaHash = env.AE_NATIVE_QA_SHA256 ?? "";
  assert.match(qaHash, /^[a-f0-9]{64}$/iu);
  const powershell = env.AE_NATIVE_PWSH_EXE;
  assert.ok(powershell && path.isAbsolute(powershell));
  assert.match(powershell, /^G:[\\/]/iu);
  assert.equal(path.basename(powershell).toLowerCase(), "pwsh.exe");
  const controlToken = env.AE_NATIVE_GATEWAY_FIXTURE_CONTROL_TOKEN ?? "";
  addSecret(controlToken);
  assert.ok(
    /^[a-f0-9]{64}$/u.test(controlToken),
    "Invalid fixture control token",
  );
  const releasePath = `/__ae_native_gateway_fixture/${fixtureId}/release`;
  assert.equal(env.AE_NATIVE_GATEWAY_FIXTURE_RELEASE_PATH, releasePath);
  assert.ok(
    !env.AE_NATIVE_QA_LOCAL_FIXTURE_PORT,
    "Update and gateway modes conflict",
  );

  const ownerFile = path.join(nativeRoot, ".ae-native-e2e-owner.json");
  const metadataFile = path.join(nativeRoot, "data", "protocol-bridge.json");
  let originalOwnerHash;
  let metadataHash;
  let route;
  let providerId;
  let before;
  let fileBaseline;
  let targetFiles;
  let failure;
  let verificationComplete = false;
  const receipt = {
    scope: "gateway-startup-recovery",
    root: nativeRoot,
    fixtureId,
    qaPid,
    qaSha256: qaHash.toLowerCase(),
    qaStartedAt: env.AE_NATIVE_QA_STARTED_AT,
    fixtureOwnerPid: ownerPid,
    fixtureOwnerStartedAt: env.AE_NATIVE_GATEWAY_FIXTURE_OWNER_STARTED_AT,
    port,
    passed: false,
    fullAcceptancePassed: false,
    realToolFlowPassed: false,
    syntheticUpstreamOnly: true,
    actualUiUse: false,
    actualUiRetry: false,
    fixtureListenerReleased: false,
    gatewayProcessKilled: false,
    providerSetupViaRealIpc: false,
    cleanup: {
      succeeded: false,
      originalFilesRestored: false,
      providerDeleted: false,
    },
  };

  async function readOwnedFile(
    location,
    { allowMissing = false, maxBytes = 1048576 } = {},
  ) {
    const relative = path.relative(nativeRoot, location);
    assert.ok(
      relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    );
    await assertPhysicalWorkspacePath(location, { allowMissing });
    let current = nativeRoot;
    const parts = relative.split(path.sep);
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      let info;
      try {
        info = await fs.lstat(current);
      } catch (error) {
        if (allowMissing && error.code === "ENOENT") return null;
        throw error;
      }
      assert.equal(
        info.isSymbolicLink(),
        false,
        "Gateway paths must be ordinary owned paths",
      );
      if (index < parts.length - 1) assert.ok(info.isDirectory());
      else {
        assert.ok(info.isFile() && info.nlink === 1 && info.size <= maxBytes);
        const file = await fs.open(current, "r");
        try {
          const descriptor = await file.stat();
          assert.ok(
            descriptor.isFile() &&
              descriptor.nlink === 1 &&
              descriptor.size <= maxBytes,
          );
          assert.ok(descriptor.dev === info.dev && descriptor.ino === info.ino);
          const bytes = await file.readFile();
          assert.ok(bytes.length <= maxBytes);
          const after = await fs.lstat(current);
          assert.ok(
            after.dev === descriptor.dev && after.ino === descriptor.ino,
          );
          return bytes;
        } finally {
          await file.close();
        }
      }
    }
    assert.fail("No owned file was read");
  }

  // The known parent image may be installed elsewhere on G:. This is a
  // read-only executable check; all fixture data still uses workspace guards.
  async function assertReadOnlyPowerShell() {
    const executable = path.resolve(powershell);
    let current = executable;
    while (true) {
      const info = await fs.lstat(current);
      assert.equal(
        info.isSymbolicLink(),
        false,
        "PowerShell must use ordinary executable ancestors",
      );
      if (current === executable) assert.ok(info.isFile() && info.nlink === 1);
      else assert.ok(info.isDirectory());
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    assert.ok(
      samePath(await fs.realpath(executable), executable),
      "The known parent PowerShell image must keep its physical path",
    );
  }

  async function ownership({ expectedListenerPid, allowUnbound = false } = {}) {
    await validateSurfaceOwnedRoot(nativeRoot);
    await assertPhysicalWorkspacePath(nativeRoot);
    assert.ok(samePath(await fs.realpath(nativeRoot), nativeRoot));
    await assertReadOnlyPowerShell();
    const ownerBytes = await readOwnedFile(ownerFile, { maxBytes: 4096 });
    const owner = JSON.parse(ownerBytes.toString("utf8"));
    assert.equal(owner.id, fixtureId);
    assert.equal(
      owner.purpose,
      "AE Switch owned native UI and real tool acceptance",
    );
    assert.ok(samePath(owner.workspace, workspace));
    if (originalOwnerHash) assert.equal(hash(ownerBytes), originalOwnerHash);
    else originalOwnerHash = hash(ownerBytes);
    const metadataBytes = await readOwnedFile(metadataFile, { maxBytes: 1024 });
    const currentRoute = JSON.parse(metadataBytes.toString("utf8"));
    addSecret(currentRoute.token);
    assert.deepEqual(Object.keys(currentRoute).sort(), ["port", "token"]);
    assert.equal(currentRoute.port, port);
    assert.ok(
      /^[a-f0-9]{64}$/iu.test(currentRoute.token),
      "Invalid persisted gateway token",
    );
    if (route) {
      assert.ok(
        currentRoute.token === route.token,
        "Persisted gateway token changed",
      );
      assert.equal(hash(metadataBytes), metadataHash);
    } else {
      route = currentRoute;
      metadataHash = hash(metadataBytes);
      assert.ok(
        route.token !== controlToken,
        "Gateway and fixture control tokens must differ",
      );
      const executable = await readOwnedFile(
        path.join(nativeRoot, "AE-Switch-QA.exe"),
        { maxBytes: 536870912 },
      );
      assert.equal(hash(executable), qaHash.toLowerCase());
    }
    const { stdout } = await runFile(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(ownershipScript, "utf16le").toString("base64"),
      ],
      { windowsHide: true, timeout: 20000, maxBuffer: 65536 },
    );
    const identity = JSON.parse(stdout.trim());
    assert.equal(identity.qa.pid, qaPid);
    assert.equal(identity.parent.pid, ownerPid);
    assert.ok(
      samePath(identity.qa.image, path.join(nativeRoot, "AE-Switch-QA.exe")),
    );
    assert.ok(samePath(identity.parent.image, powershell));
    assert.equal(identity.qa.startedAt, env.AE_NATIVE_QA_STARTED_AT);
    assert.equal(
      identity.parent.startedAt,
      env.AE_NATIVE_GATEWAY_FIXTURE_OWNER_STARTED_AT,
    );
    assert.equal(identity.qa.retainedHandleVerified, true);
    assert.equal(identity.parent.retainedHandleVerified, true);
    assert.equal(identity.qaSha256, qaHash.toLowerCase());
    assert.ok(
      Array.isArray(identity.listeners) && identity.listeners.length <= 1,
    );
    for (const listener of identity.listeners) {
      assert.equal(listener.address, "127.0.0.1");
      assert.ok(
        [ownerPid, qaPid].includes(listener.ownerPid),
        "A foreign process owns the fixture port",
      );
    }
    if (expectedListenerPid !== undefined) {
      assert.equal(identity.listeners.length, 1);
      assert.equal(identity.listeners[0].ownerPid, expectedListenerPid);
    } else if (!allowUnbound) assert.equal(identity.listeners.length, 1);
    return identity;
  }

  async function native(command, args = {}) {
    const result = await invoke(command, args);
    assert.equal(
      result.ok,
      true,
      `${command} failed in the owned gateway fixture`,
    );
    return result.result;
  }

  function request(method, requestPath, headers = {}) {
    assert.ok(requestPath === "/health" || requestPath === releasePath);
    return new Promise((resolve, reject) => {
      const client = http.request(
        {
          hostname: "127.0.0.1",
          port,
          method,
          path: requestPath,
          headers,
          agent: false,
        },
        (response) => {
          const chunks = [];
          let size = 0;
          response.on("data", (chunk) => {
            size += chunk.length;
            if (size > 4096)
              response.destroy(
                new Error("Fixture response exceeded its bound"),
              );
            else chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () =>
            resolve({
              status: response.statusCode,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      client.setTimeout(1500, () =>
        client.destroy(new Error("Owned fixture request timed out")),
      );
      client.on("error", reject);
      client.end();
    });
  }

  async function snapshotFiles() {
    const result = [];
    for (const location of targetFiles) {
      const bytes = await readOwnedFile(location, { allowMissing: true });
      result.push({
        path: location,
        present: bytes !== null,
        sha256: bytes === null ? null : hash(bytes),
      });
    }
    return result;
  }

  async function unchanged() {
    const overview = await native("get_overview");
    assert.ok(
      hash(JSON.stringify(overview.providers)) ===
        hash(JSON.stringify(before.providers)),
      "Provider records changed during gateway failure/recovery",
    );
    assert.ok(
      hash(JSON.stringify(overview.targets)) ===
        hash(JSON.stringify(before.targets)),
      "Target state changed during gateway failure/recovery",
    );
    assert.deepEqual(await snapshotFiles(), fileBaseline);
    await ownership({
      expectedListenerPid: receipt.fixtureListenerReleased ? qaPid : ownerPid,
    });
  }

  try {
    receipt.startupIdentity = await ownership({
      expectedListenerPid: ownerPid,
    });
    assert.equal(
      (
        await request("GET", "/health", {
          Authorization: `Bearer ${route.token}`,
        })
      ).status,
      503,
    );
    const initial = await native("get_overview");
    assert.ok(samePath(initial.dataDirectory, path.join(nativeRoot, "data")));
    assert.deepEqual(
      initial.providers,
      [],
      "Gateway acceptance requires a fresh owned provider store",
    );
    for (const target of initial.targets) {
      assert.equal(target.state, "unmanaged");
      assert.equal(target.activeProviderId, null);
      assert.equal(target.canRestore, false);
      await assertPhysicalWorkspacePath(target.directory, {
        allowMissing: true,
      });
      const relative = path.relative(nativeRoot, target.directory);
      assert.ok(
        relative && !relative.startsWith("..") && !path.isAbsolute(relative),
      );
    }
    const hub = await native("agent_hub_overview");
    assert.equal(hub.bridgeHealthy, false);
    const fixtureKey = randomBytes(32).toString("hex");
    addSecret(fixtureKey);
    const name = `Gateway recovery ${fixtureId}`;
    const provider = await native("save_provider", {
      input: {
        id: null,
        family: "codex",
        name,
        baseUrl: `http://127.0.0.1:${port}/fixture-upstream`,
        apiKey: fixtureKey,
        model: "fixture-model",
        authMode: "x-api-key",
        reasoningEffort: null,
        codexOptions: {
          upstreamProtocol: "anthropic",
          protocolPreference: "anthropic",
          protocol: "anthropic",
          conversionDisabledTargets: [],
          fastMode: false,
        },
      },
    });
    providerId = provider.id;
    assert.match(providerId, /^[a-f0-9-]{36}$/iu);
    assert.equal(provider.hasKey, true);
    assert.ok(
      !JSON.stringify(provider).includes(fixtureKey),
      "Provider summary leaked the fixture key",
    );
    receipt.providerSetupViaRealIpc = true;
    receipt.providerId = providerId;
    before = await native("get_overview");
    const target = before.targets.find((value) => value.target === "codex");
    assert.ok(target);
    assert.deepEqual(
      before.providers.map((value) => value.id),
      [providerId],
    );
    targetFiles = [
      ...new Set([...target.files, path.join(target.directory, "auth.json")]),
    ].sort();
    fileBaseline = await snapshotFiles();
    receipt.baseline = {
      providerSha256: hash(JSON.stringify(before.providers)),
      targetStateSha256: hash(JSON.stringify(before.targets)),
      configurationRevision: target.configurationRevision,
      files: fileBaseline,
      metadataSha256: metadataHash,
    };
    await page.getByRole("button", { name: "刷新工作台", exact: true }).click();
    await page
      .getByRole("button", { name: "高级供应商管理", exact: true })
      .first()
      .click();
    await page.getByRole("tab", { name: /Codex/u }).click();
    await page.getByRole("heading", { name: "Codex", exact: true }).waitFor();
    const card = page
      .getByRole("list", { name: "已保存的 API 配置", exact: true })
      .getByRole("listitem")
      .filter({ has: page.getByText(name, { exact: true }) });
    assert.equal(await card.count(), 1);
    await ownership({ expectedListenerPid: ownerPid });
    await card.getByRole("button", { name: "使用", exact: true }).click();
    const notice = page.locator(".notice.error");
    const unavailableMessage = notice.locator(":scope > span");
    await unavailableMessage.waitFor();
    assert.equal(
      await unavailableMessage.textContent(),
      "后台兼容服务正在恢复，原配置已保留。恢复后可重试。",
    );
    await notice.getByText("处理问题", { exact: true }).click();
    const feedback = notice.locator(".error-feedback");
    await feedback.getByText("详细信息", { exact: true }).click();
    const diagnostic = await feedback.locator("pre").textContent();
    assert.ok(
      diagnostic.includes("bridge_unavailable"),
      "The UI did not report the actual Rust bridge error",
    );
    const retry = feedback.getByRole("button", { name: "重试", exact: true });
    await retry.waitFor();
    receipt.actualUiUse = true;
    receipt.unavailableErrorCode = "bridge_unavailable";
    await unchanged();
    receipt.failedApplyPreservedProviderAndTargets = true;

    await ownership({ expectedListenerPid: ownerPid });
    const rejectedRelease = await request("POST", releasePath);
    assert.equal(rejectedRelease.status, 401);
    await ownership({ expectedListenerPid: ownerPid });
    const release = await request("POST", releasePath, {
      "X-AE-Native-Fixture-Control": controlToken,
    });
    assert.equal(release.status, 200);
    const released = JSON.parse(release.body);
    assert.equal(released.fixtureId, fixtureId);
    assert.equal(released.ownerPid, ownerPid);
    assert.equal(released.released, true);
    assert.equal(released.controlTokenValidated, true);
    receipt.fixtureListenerReleased = true;
    receipt.unauthorizedReleaseRejected = true;
    receipt.controlTokenValidated = true;
    const deadline = Date.now() + 15000;
    let healthy = false;
    do {
      try {
        healthy =
          (
            await request("GET", "/health", {
              Authorization: `Bearer ${route.token}`,
            })
          ).status === 204;
      } catch (error) {
        if (!["ECONNREFUSED", "ECONNRESET"].includes(error.code)) throw error;
      }
      if (!healthy) await new Promise((resolve) => setTimeout(resolve, 100));
    } while (!healthy && Date.now() < deadline);
    assert.equal(
      healthy,
      true,
      "The real Rust gateway did not rebind after fixture release",
    );
    receipt.recoveredIdentity = await ownership({ expectedListenerPid: qaPid });
    assert.equal((await request("GET", "/health")).status, 401);
    assert.equal(
      (
        await request("GET", "/health", {
          Authorization: `Bearer ${route.token}`,
          Origin: "http://gateway-fixture.invalid",
        })
      ).status,
      401,
    );
    assert.equal((await native("agent_hub_overview")).bridgeHealthy, true);
    await unchanged();
    receipt.automaticRecoveryPreservedProviderAndTargets = true;
    receipt.sameQaProcessReboundSamePort = true;
    receipt.gatewayHealth = {
      authenticated: 204,
      unauthenticated: 401,
      browserOrigin: 401,
    };

    await retry.click();
    const applyDeadline = Date.now() + 15000;
    let applied;
    do {
      applied = (await native("get_overview")).targets.find(
        (value) => value.target === "codex",
      );
      if (
        applied?.state === "applied" &&
        applied.activeProviderId === providerId
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < applyDeadline);
    assert.equal(applied.state, "applied");
    assert.equal(applied.activeProviderId, providerId);
    assert.equal(applied.appliedModel, provider.model);
    assert.ok(applied.configurationRevision > target.configurationRevision);
    await page
      .locator(".notice:not(.error)")
      .getByText(/^配置已写入 Codex/u)
      .waitFor();
    const config = await readOwnedFile(
      path.join(target.directory, "config.toml"),
    );
    assert.ok(
      config.includes(Buffer.from(`127.0.0.1:${port}`)),
      "Applied configuration did not keep the original gateway port",
    );
    assert.ok(
      !config.includes(Buffer.from(fixtureKey)),
      "Applied configuration exposed the fixture upstream key",
    );
    const after = await native("get_overview");
    assert.ok(
      hash(JSON.stringify(after.providers)) ===
        hash(JSON.stringify(before.providers)),
      "UI retry changed the pre-saved provider",
    );
    assert.ok(
      hash(
        JSON.stringify(
          after.targets.filter((value) => value.target !== "codex"),
        ),
      ) ===
        hash(
          JSON.stringify(
            before.targets.filter((value) => value.target !== "codex"),
          ),
        ),
      "UI retry changed another target",
    );
    await ownership({ expectedListenerPid: qaPid });
    receipt.actualUiRetry = true;
    receipt.retryApplied = {
      configurationRevision: applied.configurationRevision,
      model: applied.appliedModel,
      files: await snapshotFiles(),
    };
    receipt.metadataUnchanged = true;
    receipt.addressAndTokenUnchanged = true;
    verificationComplete = true;
  } catch (error) {
    failure = error;
  } finally {
    if (providerId) {
      try {
        await ownership({ allowUnbound: true });
        const current = await native("get_overview");
        const target = current.targets.find(
          (value) => value.target === "codex",
        );
        assert.ok(target);
        if (target.activeProviderId === providerId) {
          assert.equal(target.canRestore, true);
          await native("restore_original", { target: "codex" });
        } else {
          assert.equal(target.state, "unmanaged");
          assert.equal(target.activeProviderId, null);
        }
        if (fileBaseline) assert.deepEqual(await snapshotFiles(), fileBaseline);
        receipt.cleanup.originalFilesRestored = true;
        const restored = (await native("get_overview")).targets.find(
          (value) => value.target === "codex",
        );
        assert.equal(restored.state, "unmanaged");
        assert.equal(restored.activeProviderId, null);
        assert.equal(restored.canRestore, false);
        await ownership({ allowUnbound: true });
        await native("delete_provider", { providerId });
        const final = await native("get_overview");
        assert.deepEqual(final.providers, []);
        receipt.cleanup.providerDeleted = true;
        receipt.cleanup.succeeded = true;
      } catch (error) {
        receipt.cleanup.succeeded = false;
        if (!failure) failure = error;
      }
    }
    receipt.passed =
      verificationComplete && receipt.cleanup.succeeded && !failure;
    await record("native-gateway-startup-recovery", receipt);
  }
  if (failure) throw failure;
  assert.equal(receipt.passed, true);
  return receipt;
}
