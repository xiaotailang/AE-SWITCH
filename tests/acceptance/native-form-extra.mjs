import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { validateSurfaceOwnedRoot } from "./native-surface-extra.mjs";

// Run in the verified owned native instance, with Codex advanced management
// open and inactive legacy targets. All saves below are provider-only saves.
const syntheticKey = "ae-switch-synthetic-native-management-key";
const replacementKey = "ae-switch-synthetic-invalid-qa-key";
const preferenceKey = "uni-switch-list-v1";

async function poll(read, predicate, label, timeout = 45000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.fail(`${label} was not observed`);
}

async function prepareBalanceObserver(
  page,
  providerId,
  endpoint,
  revision,
  query,
) {
  // Resolve the saved-provider cache before holding a native HTTP response.
  // Scope traversal never calls or replaces a product handler.
  const session = await page.context().newCDPSession(page);
  const group = `native-form-balance-${randomUUID()}`;
  let disposed = false;
  let disposalCompleted = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try {
      await session.send("Runtime.releaseObjectGroup", { objectGroup: group });
    } finally {
      await session.detach();
    }
    disposalCompleted = true;
  };
  try {
    const handler = await session.send("Runtime.evaluate", {
      expression: `(() => {
        const button = document.querySelector('[role="dialog"] .auto-balance .balance-refresh');
        const key = button && Object.keys(button).find(key => key.startsWith('__reactProps$'));
        return key && button[key].onClick;
      })()`,
      objectGroup: group,
    });
    assert.ok(handler.result?.objectId && !handler.exceptionDetails);
    const functions = [handler.result.objectId];
    const seenFunctions = new Set();
    const seenScopes = new Set();
    const seenMaps = new Set();
    let cacheId;
    while (functions.length && seenFunctions.size < 32 && !cacheId) {
      const functionId = functions.shift();
      if (seenFunctions.has(functionId)) continue;
      seenFunctions.add(functionId);
      const details = await session.send("Runtime.getProperties", {
        objectId: functionId,
        ownProperties: true,
      });
      const scopesId = details.internalProperties?.find(
        (property) => property.name === "[[Scopes]]",
      )?.value?.objectId;
      if (!scopesId) continue;
      const scopes = await session.send("Runtime.getProperties", {
        objectId: scopesId,
        ownProperties: true,
      });
      for (const scope of scopes.result || []) {
        const value = scope.value;
        if (
          !value?.objectId ||
          value.description?.startsWith("Global") ||
          seenScopes.has(value.objectId)
        )
          continue;
        seenScopes.add(value.objectId);
        const bindings = await session.send("Runtime.getProperties", {
          objectId: value.objectId,
          ownProperties: true,
        });
        for (const binding of bindings.result || []) {
          const candidate = binding.value;
          if (
            candidate?.className !== "Map" ||
            seenMaps.has(candidate.objectId)
          )
            continue;
          seenMaps.add(candidate.objectId);
          const match = await session.send("Runtime.callFunctionOn", {
            objectId: candidate.objectId,
            functionDeclaration: `function(providerId, endpoint, revision, query) {
              for (const [key, entry] of this) {
                if (entry?.providerId !== providerId ||
                    typeof entry.promise?.then !== 'function' || typeof key !== 'string') continue;
                try {
                  const signature = JSON.parse(key);
                  if (signature[0] === providerId && signature[1] === endpoint &&
                      signature[3] === revision && JSON.stringify(signature[2]) === JSON.stringify(query))
                    return this;
                } catch {}
              }
              return null;
            }`,
            arguments: [
              { value: providerId },
              { value: endpoint },
              { value: revision },
              { value: query },
            ],
            objectGroup: group,
          });
          assert.ok(!match.exceptionDetails);
          if (match.result?.className === "Map") {
            cacheId = match.result.objectId;
            break;
          }
        }
        if (cacheId) break;
        // The onClick closure retains balance.refresh; its closure retains
        // useBalance's async refresh and the module's cache/request function.
        for (const binding of bindings.result || []) {
          const candidate = binding.value;
          if (candidate?.type === "function")
            functions.push(candidate.objectId);
          else if (
            value.description?.startsWith("Closure") &&
            candidate?.className === "Object"
          ) {
            const properties = await session.send("Runtime.getProperties", {
              objectId: candidate.objectId,
              ownProperties: true,
            });
            const refresh = properties.result?.find(
              (property) =>
                property.name === "refresh" &&
                property.value?.type === "function",
            );
            if (refresh) functions.unshift(refresh.value.objectId);
          }
        }
      }
    }
    assert.ok(cacheId, "The real saved-provider balance cache must be found");
    const observer = {
      promise: null,
      dispose,
      get disposed() {
        return disposalCompleted;
      },
      async capture() {
        assert.ok(!disposed && !observer.promise);
        // One call captures the pending request after its HTTP response is held.
        const pending = await session.send("Runtime.callFunctionOn", {
          objectId: cacheId,
          functionDeclaration: `function(providerId, endpoint, revision, query) {
            for (const [key, entry] of this) {
              if (!entry?.pending || entry.providerId !== providerId ||
                  typeof entry.promise?.then !== 'function' || typeof key !== 'string') continue;
              try {
                const signature = JSON.parse(key);
                if (signature[0] === providerId && signature[1] === endpoint &&
                    signature[3] === revision && JSON.stringify(signature[2]) === JSON.stringify(query))
                  return entry.promise;
              } catch {}
            }
            return null;
          }`,
          arguments: [
            { value: providerId },
            { value: endpoint },
            { value: revision },
            { value: query },
          ],
          objectGroup: group,
        });
        assert.ok(
          !pending.exceptionDetails &&
            pending.result?.className === "Promise" &&
            pending.result.objectId,
          "The held balance request's own promise must be found",
        );
        observer.promise = session
          .send("Runtime.awaitPromise", {
            promiseObjectId: pending.result.objectId,
            returnByValue: true,
          })
          .then(
            (outcome) => ({
              settled: true,
              rejected: !!outcome.exceptionDetails,
              amount: outcome.exceptionDetails
                ? null
                : outcome.result.value.amount,
            }),
            () => ({ settled: false, observationFailed: true }),
          );
      },
    };
    return observer;
  } catch (error) {
    await dispose();
    throw error;
  }
}

export async function verifyFormExtras({
  page,
  invoke,
  record,
  fixtureDirectory,
  providers,
}) {
  const native = async (command, args = {}) => {
    const response = await invoke(command, args);
    assert.ok(response.ok, `${command} must succeed in the owned form fixture`);
    return response.result;
  };
  assert.ok(process.env.AE_NATIVE_EXPECTED_ROOT);
  const { root, id: rootId } = await validateSurfaceOwnedRoot();
  const samePath = (left, right) =>
    path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
  assert.doesNotMatch(root, /^C:[\\/]/iu);
  const contained = (location) => {
    const relative = path.relative(root, path.resolve(location));
    return (
      !path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`)
    );
  };
  async function plain(location, missing = false) {
    assert.ok(
      contained(location),
      "Form fixture paths must stay in the owned root",
    );
    assert.ok(samePath(await fs.realpath(root), root));
    const rootInfo = await fs.lstat(root);
    assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink());
    let current = root;
    for (const part of path
      .relative(root, path.resolve(location))
      .split(path.sep)
      .filter(Boolean)) {
      current = path.join(current, part);
      let info;
      try {
        info = await fs.lstat(current);
      } catch (error) {
        if (missing && error.code === "ENOENT") return false;
        throw error;
      }
      assert.ok(
        !info.isSymbolicLink() && (info.isFile() || info.isDirectory()),
      );
      if (info.isFile()) assert.equal(info.nlink, 1);
      assert.ok(samePath(await fs.realpath(current), current));
    }
    return true;
  }
  const read = async (location) =>
    (await plain(location, true)) ? fs.readFile(location) : null;
  const ownerFile = path.join(root, ".ae-native-e2e-owner.json");
  await plain(ownerFile);
  const owner = JSON.parse(await fs.readFile(ownerFile, "utf8"));
  assert.equal(owner.id, rootId);
  assert.equal(
    owner.purpose,
    "AE Switch owned native UI and real tool acceptance",
  );
  if (fixtureDirectory) {
    const fixtureMarker = path.join(
      path.resolve(fixtureDirectory),
      ".ae-native-ui-owner.json",
    );
    await plain(fixtureMarker);
    assert.equal(
      JSON.parse(await fs.readFile(fixtureMarker, "utf8")).purpose,
      "synthetic native UI acceptance",
    );
  }
  const initial = await native("get_overview");
  assert.ok(samePath(initial.dataDirectory, path.join(root, "data")));
  if (providers) assert.deepEqual(initial.providers, providers);
  const initialAgents = (await native("agent_hub_overview")).agents;
  for (const target of initial.targets) {
    await plain(target.directory, true);
    assert.equal(target.activeProviderId, null);
    assert.equal(target.canRestore, false);
    assert.equal(target.state, "unmanaged");
  }
  const codexTab = () => page.getByRole("tab", { name: /^Codex\b/u });
  assert.equal(await codexTab().getAttribute("data-state"), "active");
  assert.equal(await page.getByRole("dialog").count(), 0);
  const clientFiles = new Map();
  for (const location of new Set([
    ...initial.targets.flatMap((target) => target.files),
    ...initial.targets
      .filter((target) => target.target === "codex")
      .flatMap((target) => [
        path.join(target.directory, "auth.json"),
        path.join(target.directory, "uni-switch-models.json"),
      ]),
  ]))
    clientFiles.set(location, await read(location));
  const originalPreferences = await page.evaluate(
    (key) => localStorage.getItem(key),
    preferenceKey,
  );
  const originalSearchVisible = await page
    .getByRole("textbox", { name: "搜索 API 配置", exact: true })
    .isVisible();
  if (originalSearchVisible)
    assert.equal(
      await page
        .getByRole("textbox", { name: "搜索 API 配置", exact: true })
        .inputValue(),
      "",
    );

  const token = randomUUID();
  const names = {
    bearer: `Synthetic form bearer ${token}`,
    key: `Synthetic form key ${token}`,
  };
  const models = {
    bearer: "gpt-native-form-bearer",
    anthropic: "claude-sonnet-native-form-key",
    automatic: "gpt-native-form-auto-key",
    recovery: "gpt-native-form-balance-recovery",
  };
  const requests = {
    bearer: { accepted: 0, rejected: 0, failed: 0 },
    anthropic: { accepted: 0, rejected: 0, failed: 0 },
    automatic: { accepted: 0, rejected: 0, failed: 0 },
    recovery: { accepted: 0, rejected: 0, failed: 0 },
  };
  const balanceRequests = Object.fromEntries(
    Object.keys(models).map((kind) => [
      kind,
      { accepted: 0, denied: 0, held: 0, released: 0 },
    ]),
  );
  const heldBalances = [];
  const balanceObservers = [];
  let balanceAmount = 42.5;
  let balanceDenied = false;
  let holdBalance = false;
  let balanceStep = null;
  let settledBalanceObservers = 0;
  let detectionFailure = false;
  let endpoints;
  let server;
  let failure;
  const ownIds = new Set();
  const initialIds = new Set(initial.providers.map((provider) => provider.id));
  const button = (name) => page.getByRole("button", { name, exact: true });
  const card = (id) =>
    page
      .locator("li.provider-card")
      .filter({ has: page.locator(`[data-provider-name="${id}"]`) });
  const preference = () =>
    page.evaluate((key) => localStorage.getItem(key), preferenceKey);
  async function captureOwned() {
    const overview = await native("get_overview");
    for (const provider of overview.providers) {
      if (
        !initialIds.has(provider.id) &&
        Object.values(names).includes(provider.name) &&
        endpoints &&
        Object.values(endpoints).includes(provider.baseUrl)
      ) {
        assert.match(provider.id, /^[0-9a-f-]{36}$/iu);
        ownIds.add(provider.id);
      }
    }
    assert.deepEqual(
      overview.providers.filter((provider) => initialIds.has(provider.id)),
      initial.providers,
    );
    return overview;
  }
  async function assertNoClientWrites() {
    assert.deepEqual((await native("get_overview")).targets, initial.targets);
    for (const [location, before] of clientFiles) {
      const after = await read(location);
      assert.ok(
        before === null ? after === null : after?.equals(before),
        "Provider-only form work must retain original client bytes",
      );
    }
    assert.deepEqual(
      (await native("agent_hub_overview")).agents,
      initialAgents,
    );
  }
  async function refresh() {
    await poll(
      () => button("刷新配置状态").isEnabled(),
      Boolean,
      "Form refresh unlocked",
    );
    await button("刷新配置状态").click();
    await poll(
      () => button("刷新配置状态").isEnabled(),
      Boolean,
      "Form refresh completed",
    );
  }
  async function enterAdvanced() {
    if (!(await codexTab().isVisible())) {
      await button("高级供应商管理").click();
      await codexTab().waitFor();
    }
    await codexTab().click();
    await poll(
      () => codexTab().getAttribute("data-state"),
      (value) => value === "active",
      "Codex advanced view",
    );
  }
  const rowIds = () =>
    page
      .locator("li.provider-card [data-provider-name]")
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-provider-name")),
      );
  async function countsUi(expectedCount) {
    await poll(
      () => page.locator(".supplier-total .count").innerText(),
      (value) => Number(value) === expectedCount,
      "Visible supplier count",
    );
    assert.equal(
      await page.locator(".supplier-total").getAttribute("aria-label"),
      `已保存 ${expectedCount} 个 API 供应商`,
    );
  }
  async function ready(dialog, model) {
    const selected = dialog.getByRole("checkbox", {
      name: `启用 ${model}`,
      exact: true,
    });
    await selected.waitFor();
    await poll(
      () => dialog.locator(".model-selection").getAttribute("aria-busy"),
      (value) => value === "false",
      "Real form model discovery settled",
    );
    await poll(
      () => dialog.locator(".connection-summary").getAttribute("aria-busy"),
      (value) => value === "false",
      "Real form connection settled",
    );
    assert.equal(
      await dialog.locator(".connection-summary.has-error").count(),
      0,
    );
    assert.equal(await selected.isChecked(), true);
    assert.equal(await dialog.locator(".model-default").count(), 1);
    assert.ok(
      (await dialog.locator(".connection-summary").innerText()).includes(model),
    );
  }
  async function radio(dialog, field, value) {
    const control = dialog.locator(
      `input[type="radio"][name="${field}"][value="${value}"]`,
    );
    await control.click();
    assert.equal(await control.isChecked(), true);
  }
  async function createProvider(kind, route, protocol, auth, model) {
    await button("添加供应商").click();
    const dialog = page.getByRole("dialog", {
      name: "添加供应商",
      exact: true,
    });
    await dialog.locator("#baseUrl").fill(endpoints[route]);
    await dialog.locator("#apiKey").fill(syntheticKey);
    await dialog.locator("#name").fill(names[kind]);
    await radio(dialog, "protocol", protocol);
    await radio(dialog, "authMode", auth);
    await ready(dialog, model);
    if (kind === "bearer") {
      const providersBeforeBalance = (await native("get_overview")).providers;
      const balance = dialog.locator(".auto-balance");
      const value = balance.locator(".balance-main");
      const waitNewBalance = (amount) =>
        poll(
          async () => ({
            busy: await balance.getAttribute("aria-busy"),
            text: (await value.count()) ? await value.innerText() : "",
          }),
          (state) =>
            state.busy === "false" && state.text.includes(`${amount} USD`),
          "The actual new-provider form balance rendered",
        );
      await waitNewBalance(42.5);
      assert.ok(balanceRequests[route].accepted > 0);
      const acceptedBeforeRefresh = balanceRequests[route].accepted;
      balanceAmount = 58.125;
      try {
        await balance
          .getByRole("button", { name: "刷新余额", exact: true })
          .click();
        await waitNewBalance(58.125);
        assert.ok(balanceRequests[route].accepted > acceptedBeforeRefresh);
        assert.equal(await balance.locator(".balance-failure").count(), 0);
        assert.match(
          await balance.locator(".balance-meta").innerText(),
          /Synthetic form balance plan/u,
        );
        assert.match(
          await balance.locator(".balance-windows").innerText(),
          /5 小时额度/u,
        );
        assert.deepEqual(
          (await native("get_overview")).providers,
          providersBeforeBalance,
          "New-form balance queries must not save an unsaved provider",
        );
        await assertNoClientWrites();
        await record("native-form-create-balance-success-refresh", {
          passed: true,
          actualNewFormAutomaticQuery: true,
          actualNewFormRefreshClicked: true,
          previousAmount: 42.5,
          refreshedAmount: 58.125,
          actualRustBalanceRequests: { ...balanceRequests[route] },
          planAndQuotaWindowRendered: true,
          unsavedProviderAndTargetsAndClientBytesUnchanged: true,
          syntheticSupplierInferenceVerified: false,
        });
      } finally {
        balanceAmount = 42.5;
      }
    }
    if (protocol === "anthropic") {
      const fast = dialog.locator('fieldset[aria-describedby="fastMode-hint"]');
      assert.equal(await fast.evaluate((element) => element.disabled), true);
      for (const choice of await fast.getByRole("radio").all())
        assert.equal(await choice.isEnabled(), false);
    }
    await dialog
      .getByRole("checkbox", {
        name: "只保存供应商，暂不用于当前客户端",
        exact: true,
      })
      .click();
    await dialog
      .getByRole("button", { name: "保存供应商", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden", timeout: 60000 });
    const overview = await captureOwned();
    const provider = overview.providers.find(
      (item) => item.name === names[kind] && item.baseUrl === endpoints[route],
    );
    assert.ok(provider && ownIds.has(provider.id));
    assert.equal(provider.model, model);
    assert.equal(provider.authMode, auth);
    assert.equal(provider.codexOptions.upstreamProtocol, protocol);
    assert.equal(provider.codexOptions.protocolPreference, protocol);
    assert.equal(provider.codexOptions.authPreference, auth);
    assert.ok(provider.codexOptions.protocolDetectedAt && provider.hasKey);
    assert.ok(requests[route].accepted > 0);
    assert.equal(
      overview.providers.length,
      initial.providers.length + ownIds.size,
    );
    await assertNoClientWrites();
    await countsUi(initial.providers.length + ownIds.size);
    await record("native-form-explicit-protocol-auth", {
      passed: true,
      providerId: provider.id,
      protocol,
      authMode: auth,
      actualRustModelRequests: requests[route].accepted,
      selectedModelActuallyReturned: true,
      providerOnlySave: true,
      anthropicFastDisabled: protocol === "anthropic" ? true : null,
    });
    return provider;
  }
  function replyBalance(response, amount) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        mode: "quota_limited",
        isValid: true,
        quota: { remaining: amount, used: 7.5, limit: amount + 7.5 },
        planName: "Synthetic form balance plan",
        expires_at: "2030-01-01T00:00:00Z",
        rate_limits: [
          {
            window: "5h",
            used: 1,
            limit: 10,
            reset_at: "2030-01-01T00:00:00Z",
          },
        ],
      }),
    );
  }

  try {
    server = createServer((request, response) => {
      const balanceRoute =
        request.method === "GET" &&
        Object.keys(models).find(
          (kind) =>
            request.url?.startsWith(`/${token}/${kind}/`) &&
            request.url !== `/${token}/${kind}/v1/models`,
        );
      if (balanceRoute) {
        const key = balanceRoute === "recovery" ? replacementKey : syntheticKey;
        const authorized = request.headers.authorization === `Bearer ${key}`;
        if (!authorized || (balanceRoute === "automatic" && balanceDenied)) {
          balanceRequests[balanceRoute].denied++;
          response.writeHead(401, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: { message: "Synthetic form balance authorization denied" },
            }),
          );
        } else if (request.url === `/${token}/${balanceRoute}/v1/usage`) {
          balanceRequests[balanceRoute].accepted++;
          if (balanceRoute === "automatic" && holdBalance) {
            holdBalance = false;
            balanceRequests[balanceRoute].held++;
            const held = {
              released: false,
              release(requireLive = false) {
                const live = !response.destroyed && !response.writableEnded;
                if (requireLive)
                  assert.ok(
                    live,
                    "The old Rust balance response is still held",
                  );
                if (live) {
                  held.released = true;
                  balanceRequests[balanceRoute].released++;
                  replyBalance(response, 1.25);
                }
              },
            };
            heldBalances.push(held);
          } else replyBalance(response, balanceAmount);
        } else {
          response.writeHead(404);
          response.end();
        }
        return;
      }
      const route =
        request.method === "GET" &&
        Object.keys(models).find(
          (kind) => request.url === `/${token}/${kind}/v1/models`,
        );
      if (!route) {
        response.writeHead(404);
        response.end();
        return;
      }
      const key = route === "recovery" ? replacementKey : syntheticKey;
      const authorized =
        route === "bearer"
          ? request.headers.authorization === `Bearer ${key}`
          : request.headers["x-api-key"] === key;
      if (!authorized) {
        requests[route].rejected++;
        response.writeHead(401, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: "Synthetic form authentication mode rejected" },
          }),
        );
        return;
      }
      if (route === "automatic" && detectionFailure) {
        requests[route].failed++;
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: "Synthetic protocol detection temporarily unavailable",
            },
          }),
        );
        return;
      }
      requests[route].accepted++;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          route === "anthropic"
            ? { data: [{ id: models[route], type: "model" }], has_more: false }
            : {
                object: "list",
                data: [{ id: models[route], object: "model" }],
              },
        ),
      );
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    endpoints = Object.fromEntries(
      Object.keys(models).map((kind) => [
        kind,
        `${origin}/${token}/${kind}/v1`,
      ]),
    );
    const bearer = await createProvider(
      "bearer",
      "bearer",
      "openai",
      "bearer",
      models.bearer,
    );
    let keyed = await createProvider(
      "key",
      "anthropic",
      "anthropic",
      "x-api-key",
      models.anthropic,
    );

    await card(keyed.id)
      .getByRole("button", { name: `编辑 ${keyed.name}`, exact: true })
      .click();
    const edit = page.getByRole("dialog", { name: "编辑供应商", exact: true });
    assert.ok((await edit.locator("#apiKey").inputValue()) === "");
    await edit.locator("#baseUrl").fill(endpoints.automatic);
    await radio(edit, "protocol", "auto");
    await radio(edit, "authMode", "auto");
    await ready(edit, models.automatic);
    await edit.getByRole("button", { name: "保存修改", exact: true }).click();
    await edit.waitFor({ state: "hidden", timeout: 60000 });
    keyed = (await captureOwned()).providers.find(
      (item) => item.id === keyed.id,
    );
    assert.equal(keyed.baseUrl, endpoints.automatic);
    assert.equal(keyed.model, models.automatic);
    assert.equal(keyed.authMode, "x-api-key");
    assert.equal(keyed.codexOptions.upstreamProtocol, "openai");
    assert.equal(keyed.codexOptions.protocolPreference ?? null, null);
    assert.equal(keyed.codexOptions.authPreference ?? null, null);
    assert.ok(
      requests.automatic.rejected > 0 && requests.automatic.accepted > 0,
    );
    await assertNoClientWrites();
    await record("native-form-auto-auth-fallback", {
      passed: true,
      providerId: keyed.id,
      automaticRadiosActuallyClicked: true,
      bearerRejectedByXApiKeyOnlyFixture: true,
      xApiKeyAccepted: true,
      savedProtocol: "openai",
      savedAuthMode: "x-api-key",
      blankKeyRetained: true,
      actualRustRequests: requests.automatic,
    });

    // Form saves always confirm discovery. A real native update of only our
    // own inactive row prepares the separate card's unconfirmed/retry branch.
    detectionFailure = true;
    const seeded = await native("save_provider", {
      input: {
        id: keyed.id,
        family: keyed.family,
        name: keyed.name,
        baseUrl: keyed.baseUrl,
        apiKey: null,
        model: keyed.model,
        authMode: keyed.authMode,
        reasoningEffort: keyed.reasoningEffort,
        codexOptions: {
          ...keyed.codexOptions,
          upstreamProtocol: null,
          protocolPreference: null,
          authPreference: null,
          protocolDetectedAt: null,
          modelsSyncedAt: null,
        },
      },
    });
    assert.equal(seeded.id, keyed.id);
    await refresh();
    const protocolRow = card(keyed.id).locator(".provider-protocol-row");
    await protocolRow.getByText("协议检测失败", { exact: true }).waitFor();
    assert.ok(requests.automatic.failed > 0);
    assert.deepEqual(
      (await native("get_overview")).providers.find(
        (item) => item.id === keyed.id,
      ),
      seeded,
    );
    const beforeRetry = requests.automatic.accepted;
    detectionFailure = false;
    await protocolRow
      .getByRole("button", { name: "重新检测", exact: true })
      .click();
    keyed = await poll(
      async () =>
        (await native("get_overview")).providers.find(
          (item) => item.id === keyed.id,
        ),
      (value) =>
        !!value?.codexOptions.upstreamProtocol &&
        !!value.codexOptions.protocolDetectedAt,
      "The actual card protocol retry native commit",
    );
    await poll(
      () => protocolRow.locator(".provider-protocol-error").count(),
      (value) => value === 0,
      "The card protocol error clears",
    );
    assert.equal(keyed.authMode, "x-api-key");
    assert.equal(keyed.codexOptions.upstreamProtocol, "openai");
    assert.equal(keyed.model, seeded.model);
    assert.deepEqual(keyed.codexOptions.models, seeded.codexOptions.models);
    assert.ok(requests.automatic.accepted > beforeRetry);
    assert.match(
      await protocolRow.locator(".provider-protocol-value").innerText(),
      /OpenAI/u,
    );
    assert.match(
      await protocolRow.locator(".provider-protocol-source").innerText(),
      /自动检测/u,
    );
    await assertNoClientWrites();
    await record("native-form-inline-protocol-retry", {
      passed: true,
      providerId: keyed.id,
      setupUsedRealNativeOwnRowOnly: true,
      realHttpFailureShown: true,
      actualRetryButtonClicked: true,
      errorClearedAndProtocolPersisted: true,
      savedModelsRetained: true,
      targetsAndClientBytesUnchanged: true,
      actualRustRequests: requests.automatic,
    });

    balanceStep = "native-form-balance-success-refresh";
    const savedBeforeBalance = keyed;
    await card(keyed.id)
      .getByRole("button", { name: `编辑 ${keyed.name}`, exact: true })
      .click();
    const balanceEdit = page.getByRole("dialog", {
      name: "编辑供应商",
      exact: true,
    });
    const balance = balanceEdit.locator(".auto-balance");
    const balanceRefresh = balance.getByRole("button", {
      name: "刷新余额",
      exact: true,
    });
    const balanceValue = balance.locator(".balance-main");
    const balanceFailure = balance.locator(".balance-failure");
    const balanceState = async () => ({
      busy: await balance.getAttribute("aria-busy"),
      value: (await balanceValue.count()) ? await balanceValue.innerText() : "",
    });
    const waitBalance = (amount) =>
      poll(
        balanceState,
        (state) =>
          state.busy === "false" && state.value.includes(`${amount} USD`),
        "The real Rust balance rendered in the edit form",
      );
    assert.equal(await balanceEdit.locator("#apiKey").inputValue(), "");
    await waitBalance(42.5);
    const beforeBalanceRefresh = balanceRequests.automatic.accepted;
    balanceAmount = 64.25;
    await balanceRefresh.click();
    await waitBalance(64.25);
    assert.ok(balanceRequests.automatic.accepted > beforeBalanceRefresh);
    assert.equal(await balanceFailure.count(), 0);
    assert.match(
      await balance.locator(".balance-meta").innerText(),
      /Synthetic form balance plan/u,
    );
    assert.match(
      await balance.locator(".balance-windows").innerText(),
      /5 小时额度/u,
    );
    await record(balanceStep, {
      passed: true,
      providerId: keyed.id,
      actualEditFormRefreshClicked: true,
      previousAmount: 42.5,
      refreshedAmount: 64.25,
      actualRustBalanceRequests: balanceRequests.automatic,
      planAndQuotaWindowRendered: true,
    });

    balanceStep = "native-form-balance-http401-preserved";
    const beforeDeniedBalance = balanceRequests.automatic.denied;
    balanceDenied = true;
    await balanceRefresh.click();
    await balanceFailure.waitFor();
    await poll(
      () => balance.getAttribute("aria-busy"),
      (value) => value === "false",
      "The actual balance authorization failure settled",
    );
    assert.ok(balanceRequests.automatic.denied > beforeDeniedBalance);
    assert.match(await balanceFailure.innerText(), /拒绝访问.*API Key/u);
    assert.match(await balanceValue.innerText(), /64\.25 USD.*上次结果/u);
    assert.match(
      await balance.locator(".balance-checked").innerText(),
      /上次成功查询/u,
    );
    assert.equal(await balanceRefresh.isEnabled(), true);
    await record(balanceStep, {
      passed: true,
      providerId: keyed.id,
      actualEditFormRefreshClicked: true,
      realHttp401Displayed: true,
      previousSuccessfulAmount: 64.25,
      staleResultAndSuccessTimePreserved: true,
      actualRustBalanceRequests: balanceRequests.automatic,
    });

    balanceStep = "native-form-balance-key-endpoint-recovery";
    const observed = await prepareBalanceObserver(
      page,
      keyed.id,
      endpoints.automatic,
      keyed.updatedAt,
      keyed.codexOptions.balanceQuery,
    );
    balanceObservers.push(observed);
    balanceDenied = false;
    holdBalance = true;
    const beforeHeldBalance = heldBalances.length;
    await balanceRefresh.click();
    await poll(
      () => heldBalances.length,
      (count) => count === beforeHeldBalance + 1,
      "The old saved-key Rust balance HTTP response is held",
      10000,
    );
    const held = heldBalances.at(-1);
    await observed.capture();
    const heldUi = await Promise.all([
      balance.getAttribute("aria-busy"),
      balanceRefresh.isEnabled(),
      balanceRefresh.locator("svg.spinning").count(),
      balanceEdit.locator("#baseUrl").isEnabled(),
      balanceEdit.locator("#apiKey").isEnabled(),
    ]);
    assert.deepEqual(heldUi, ["true", false, 1, true, true]);
    balanceAmount = 91.75;
    await balanceEdit.locator("#apiKey").fill(replacementKey);
    await balanceEdit.locator("#baseUrl").fill(endpoints.recovery);
    await poll(
      () => balanceRefresh.isEnabled(),
      Boolean,
      "The new edit-form connection can refresh its own balance",
    );
    await balanceRefresh.click();
    await waitBalance(91.75);
    const [recoveryFailures, recoveredValue, recoveredTime] = await Promise.all(
      [
        balanceFailure.count(),
        balanceValue.innerText(),
        balance.locator(".balance-checked").innerText(),
      ],
    );
    assert.equal(recoveryFailures, 0);
    assert.doesNotMatch(recoveredValue, /上次结果/u);
    assert.ok(balanceRequests.recovery.accepted > 0);
    assert.equal(held.released, false);
    const recoveryStep = balanceStep;
    const recoveryEvidence = {
      passed: true,
      providerId: keyed.id,
      actualKeyAndEndpointInputsChanged: true,
      actualEditFormRefreshClicked: true,
      recoveredAmount: 91.75,
      oldResponseStillHeldWhenNewResultRendered: true,
      heldBusyAriaDisabledRefreshAndSpinnerObserved: true,
      endpointAndKeyStayedEditableWhileHeld: true,
      actualRustBalanceRequests: structuredClone(balanceRequests),
    };

    balanceStep = "native-form-balance-stale-response";
    held.release(true);
    const oldOutcome = await observed.promise;
    assert.deepEqual(oldOutcome, {
      settled: true,
      rejected: false,
      amount: 1.25,
    });
    // The native promise and useBalance's earlier continuation have settled.
    // Allow React's pending commit to render before comparing the visible UI.
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    assert.equal(await balance.getAttribute("aria-busy"), "false");
    assert.equal(await balanceValue.innerText(), recoveredValue);
    assert.equal(
      await balance.locator(".balance-checked").innerText(),
      recoveredTime,
    );
    assert.equal(await balanceFailure.count(), 0);
    assert.equal(await balanceRefresh.isEnabled(), true);
    await observed.dispose();
    await record(recoveryStep, recoveryEvidence);
    assert.deepEqual(
      (await captureOwned()).providers.find((item) => item.id === keyed.id),
      savedBeforeBalance,
    );
    await balanceEdit
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await balanceEdit.waitFor({ state: "hidden" });
    await assertNoClientWrites();
    await record(balanceStep, {
      passed: true,
      providerId: keyed.id,
      oldActualNativePromiseSettled: true,
      oldSuccessfulAmount: oldOutcome.amount,
      newerVisibleAmount: 91.75,
      newerResultAndQueryTimeSurvivedOldSettlement: true,
      fixedSleepUsedAsRaceProof: false,
      originalSavedProviderAndClientStateRetained: true,
      actualRustBalanceRequests: balanceRequests,
    });
    balanceStep = null;

    const own = [bearer.id, keyed.id];
    const baseOrder = (await rowIds()).filter((id) => own.includes(id));
    assert.equal(baseOrder.length, 2);
    const nameFor = (id) => (id === bearer.id ? bearer.name : keyed.name);
    const pin = (id, enabled) =>
      card(id).getByRole("button", {
        name: `${enabled ? "取消置顶" : "置顶"} ${nameFor(id)}`,
        exact: true,
      });
    const [first, second] = baseOrder;
    await pin(second, false).click();
    await pin(second, true).waitFor();
    assert.equal(await pin(second, true).getAttribute("aria-pressed"), "true");
    assert.deepEqual(
      (await rowIds()).filter((id) => own.includes(id)),
      [second, first],
    );
    await pin(first, false).click();
    await pin(first, true).waitFor();
    assert.equal(await pin(first, true).getAttribute("aria-pressed"), "true");
    const bothPinnedOrder = (await rowIds()).filter((id) => own.includes(id));
    assert.deepEqual(bothPinnedOrder, baseOrder);
    const persistedPreferences = await poll(
      preference,
      (value) =>
        own.every((id) => JSON.parse(value || "{}").pinned?.includes(id)),
      "Both UI pins persisted",
    );
    await page.reload();
    await page
      .getByRole("heading", { name: /你的 Agent，随时就绪/u })
      .waitFor();
    const currentHub = await native("agent_hub_overview");
    const configuredCount = currentHub.agents.filter(
      (agent) => agent.configured,
    ).length;
    const expectedCounts = [
      String(currentHub.agents.length),
      String(initial.providers.length + 2),
      String(configuredCount),
    ];
    await poll(
      () => page.locator(".hub-overview-strip strong").allTextContents(),
      (value) => JSON.stringify(value) === JSON.stringify(expectedCounts),
      "Actual Hub agent/provider/configured statistics",
    );
    const navigation = page.getByRole("navigation", {
      name: "选择 Agent",
      exact: true,
    });
    assert.equal(
      await navigation.locator(".hub-configured-dot").count(),
      configuredCount,
    );
    const originalSelectedLogo = await navigation
      .locator('[aria-current="page"]')
      .getByRole("img")
      .getAttribute("alt");
    assert.ok(originalSelectedLogo);
    const scopeObservations = [];
    for (const agent of currentHub.agents) {
      const entry = navigation.getByRole("button").filter({
        has: page.getByRole("img", {
          name: `${agent.name} 官方图标`,
          exact: true,
        }),
      });
      assert.equal(
        await entry.locator(".hub-configured-dot").count(),
        agent.configured ? 1 : 0,
      );
      assert.equal(
        await entry.locator(".hub-agent-copy small").innerText(),
        agent.configured ? "已配置端点" : agent.description,
      );
      await entry.click();
      await poll(
        () => entry.getAttribute("aria-current"),
        (value) => value === "page",
        `${agent.id} selected for actual configuration scope`,
      );
      const expectedScope = !agent.configured
        ? "待配置已有客户端"
        : agent.mode === "private"
          ? "旧版私有配置"
          : "既有客户端原配置";
      const actualScope = await page
        .locator(".hub-agent-properties div")
        .filter({
          has: page.getByText("配置范围", { exact: true }),
        })
        .locator("dd")
        .innerText();
      assert.equal(actualScope, expectedScope);
      scopeObservations.push({
        agentId: agent.id,
        configured: agent.configured,
        mode: agent.mode,
        actualScope,
      });
    }
    const originalEntry = navigation.getByRole("button").filter({
      has: page.getByRole("img", {
        name: originalSelectedLogo,
        exact: true,
      }),
    });
    await originalEntry.click();
    assert.equal(await originalEntry.getAttribute("aria-current"), "page");
    assert.deepEqual(
      (await native("agent_hub_overview")).agents,
      currentHub.agents,
    );
    await record("native-form-ui-statistics-badges", {
      passed: true,
      providerCount: initial.providers.length + 2,
      agentCount: currentHub.agents.length,
      configuredCount,
      exactBadgesMatchNativeAgents: true,
      exactDescriptionsMatchNativeAgents: true,
      configurationScopes: scopeObservations,
      originalAgentSelectionRestored: true,
      nativeAgentConfigurationsRetained: true,
      positiveConfiguredBadgesObserved: configuredCount > 0,
      gap: configuredCount
        ? null
        : "Call after real Agent configuration to cover positive configured badges.",
    });
    await enterAdvanced();
    await countsUi(initial.providers.length + 2);
    assert.equal(await preference(), persistedPreferences);
    for (const id of own)
      assert.equal(await pin(id, true).getAttribute("aria-pressed"), "true");
    assert.deepEqual(
      (await rowIds()).filter((id) => own.includes(id)),
      bothPinnedOrder,
    );
    await pin(first, true).click();
    await pin(first, false).waitFor();
    assert.deepEqual(
      (await rowIds()).filter((id) => own.includes(id)),
      [second, first],
    );
    await pin(second, true).click();
    await pin(second, false).waitFor();
    await poll(
      preference,
      (value) => value === originalPreferences,
      "Original list preferences restored through ordinary unpin buttons",
    );
    await record("native-form-two-provider-pin-reload", {
      passed: true,
      providerIds: own,
      onePinReorderedActualRows: true,
      bothPinsAndRelativeOrderSurvivedReload: true,
      unpinRestoredOriginalPreferences: true,
    });

    const beforeSearch = (await native("get_overview")).providers;
    const search = page.getByRole("textbox", {
      name: "搜索 API 配置",
      exact: true,
    });
    if (!(await search.isVisible())) await button("搜索供应商").click();
    await search.fill(`synthetic-no-results-${token}`);
    const noResults = page.locator(".no-results");
    await noResults.getByText("没有找到匹配的配置", { exact: true }).waitFor();
    assert.equal(await page.locator("li.provider-card").count(), 0);
    await noResults
      .getByRole("button", { name: "清空搜索", exact: true })
      .click();
    assert.equal(await search.inputValue(), "");
    await poll(
      () => page.locator("li.provider-card").count(),
      (value) => value === initial.providers.length + 2,
      "No-results clear restored all supplier rows",
    );
    assert.deepEqual((await native("get_overview")).providers, beforeSearch);
    await record("native-form-no-results-clear", {
      passed: true,
      actualNoResultsClearButton: true,
      allOriginalAndOwnRowsReturned: true,
      savedProviderStateUnchanged: true,
    });
    const tutorial = page.getByRole("dialog", {
      name: "使用说明",
      exact: true,
    });
    const helpTrigger = button("使用说明");
    await helpTrigger.click();
    await tutorial
      .getByRole("button", { name: "开始使用", exact: true })
      .click();
    await tutorial.waitFor({ state: "hidden" });
    await poll(
      () =>
        helpTrigger.evaluate((element) => element === document.activeElement),
      Boolean,
      "Tutorial start button returns focus",
    );
    assert.deepEqual((await native("get_overview")).providers, beforeSearch);
    await assertNoClientWrites();
    await record("native-form-tutorial-start", {
      passed: true,
      actualStartButtonClicked: true,
      dialogDismissed: true,
      triggerFocusReturned: true,
      providerAndClientFilesUnchanged: true,
    });
  } catch (error) {
    failure = error;
    if (balanceStep)
      await record(balanceStep, {
        passed: false,
        providerIds: [...ownIds],
        failure: String(error.message ?? error),
        heldResponseCount: heldBalances.length,
        actualRustBalanceRequests: balanceRequests,
      });
  } finally {
    const cleanupErrors = [];
    const attempt = async (action) => {
      try {
        await action();
      } catch (error) {
        cleanupErrors.push(String(error.message ?? error));
      }
    };
    for (const held of heldBalances) await attempt(() => held.release());
    for (const observed of balanceObservers) {
      if (observed.promise)
        await attempt(async () => {
          const outcome = await observed.promise;
          assert.equal(outcome.settled, true);
          settledBalanceObservers++;
        });
      await attempt(observed.dispose);
    }
    await attempt(async () => {
      const dialog = page.getByRole("dialog");
      if (await dialog.count()) {
        const cancel = dialog.getByRole("button", {
          name: "取消",
          exact: true,
        });
        const close = (await cancel.count())
          ? cancel
          : dialog.getByRole("button", { name: "关闭弹窗", exact: true });
        await poll(
          () => close.isEnabled(),
          Boolean,
          "Form cleanup dialog unlocked",
        );
        await close.click();
        await dialog.waitFor({ state: "hidden" });
      }
      await enterAdvanced();
      const search = page.getByRole("textbox", {
        name: "搜索 API 配置",
        exact: true,
      });
      if (await search.isVisible()) await search.fill("");
      const current = await captureOwned();
      for (const provider of current.providers.filter((provider) =>
        ownIds.has(provider.id),
      )) {
        const unpin = card(provider.id).getByRole("button", {
          name: `取消置顶 ${provider.name}`,
          exact: true,
        });
        if (await unpin.count()) await unpin.click();
      }
      await poll(
        preference,
        (value) => value === originalPreferences,
        "Form cleanup original list preferences",
      );
    });
    await attempt(async () => {
      const current = await captureOwned();
      for (const target of current.targets.filter((target) =>
        ownIds.has(target.activeProviderId),
      )) {
        await native("restore_original", { target: target.target });
      }
      for (const provider of current.providers.filter((provider) =>
        ownIds.has(provider.id),
      )) {
        assert.ok(
          !initialIds.has(provider.id) &&
            Object.values(names).includes(provider.name) &&
            Object.values(endpoints).includes(provider.baseUrl),
        );
        await native("delete_provider", { providerId: provider.id });
      }
    });
    if (server)
      await attempt(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      });
    await attempt(async () => {
      await enterAdvanced();
      await refresh();
      // Search expansion has no close control. Ordinary route navigation
      // recreates its initial state without writing React state or storage.
      await button("返回 Agent Hub").click();
      await page
        .getByRole("heading", { name: /你的 Agent，随时就绪/u })
        .waitFor();
      await enterAdvanced();
      const search = page.getByRole("textbox", {
        name: "搜索 API 配置",
        exact: true,
      });
      if (originalSearchVisible && !(await search.isVisible()))
        await button("搜索供应商").click();
      assert.equal(await search.isVisible(), originalSearchVisible);
      assert.equal(await preference(), originalPreferences);
      const final = await native("get_overview");
      assert.deepEqual(final.providers, initial.providers);
      assert.deepEqual(final.targets, initial.targets);
      await countsUi(initial.providers.length);
      await assertNoClientWrites();
    });
    await record("native-form-extras-restored", {
      passed: cleanupErrors.length === 0,
      ownProviderCount: ownIds.size,
      onlyCapturedOwnProvidersRemoved: cleanupErrors.length === 0,
      originalProvidersTargetsAgentConfigClientBytesAndPreferencesRestored:
        cleanupErrors.length === 0,
      actualRustRequests: requests,
      actualRustBalanceRequests: balanceRequests,
      heldBalanceResponsesReleased: heldBalances.every((held) => held.released),
      capturedBalancePromisesSettled:
        settledBalanceObservers ===
        balanceObservers.filter((observed) => observed.promise).length,
      balanceObserverHandlesReleased: balanceObservers.every(
        (observed) => observed.disposed,
      ),
      screenshotsTaken: false,
      cleanupErrors,
      flowFailure: failure ? String(failure.message ?? failure) : null,
    });
    if (!failure && cleanupErrors.length)
      failure = new Error(
        "Form helper cleanup did not restore its owned changes",
      );
  }
  if (failure) throw failure;
}
