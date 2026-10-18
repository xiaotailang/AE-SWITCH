import assert from "node:assert/strict";
import { createServer } from "node:http";

// The caller verifies the executable and owned native root before this helper.
// Only real HTTP discovery and ordinary UI edits run here; nothing is saved.
const keyA = "ae-switch-synthetic-invalid-qa-key";
const keyB = "ae-switch-synthetic-native-management-key";
const busyText = "正在识别协议并获取模型列表";

async function native(invoke, command) {
  const response = await invoke(command, {});
  assert.ok(
    response.ok,
    `${command} must succeed in the verified native store`,
  );
  return response.result;
}

async function waitUntil(read, predicate, label, timeout = 45000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.fail(`${label} was not observed`);
}

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not settle`)),
          45000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const agentConfiguration = (hub) =>
  hub.agents.map(
    ({ id, configured, providerId, model, directory, launcher }) => ({
      id,
      configured,
      providerId: providerId ?? null,
      model: model ?? null,
      directory: directory ?? null,
      launcher: launcher ?? null,
    }),
  );

async function modelState(page) {
  return page.evaluate(() => {
    const model = document.getElementById("hub-model");
    return {
      value: model.value,
      options: Array.from(model.options, (option) => option.value).filter(
        Boolean,
      ),
      disabled: model.disabled,
      refreshDisabled: document.querySelector(".hub-model-label button")
        .disabled,
      confirmDisabled: document.querySelector(".hub-form-actions .primary")
        .disabled,
      saveDisabled: document.querySelector(".hub-form-actions .secondary")
        .disabled,
      status: document.querySelector(".hub-model-status").textContent,
      failure: !!document.querySelector(".hub-model-status.failure"),
    };
  });
}

async function waitForModels(page, expected) {
  const state = await waitUntil(
    () => modelState(page),
    (value) =>
      !value.disabled &&
      !value.refreshDisabled &&
      !value.failure &&
      value.options.length === expected.length &&
      expected.every((id) => value.options.includes(id)),
    "The actual Rust-discovered model catalog",
  );
  assert.equal(state.confirmDisabled, false);
  assert.equal(state.saveDisabled, false);
  return state;
}

async function observePendingDiscovery(page, endpoint, key) {
  // Capture only an existing promise from the committed React tree. Keeping a
  // handle to it proves the old native request settles after its response is
  // released, without a timer-based assertion or another discovery invocation.
  const handle = await page.evaluateHandle(
    ({ endpoint, key }) => {
      const container = document.getElementById("root");
      const property = Object.keys(container).find((name) =>
        name.startsWith("__reactContainer$"),
      );
      const current = property && container[property]?.stateNode?.current;
      const pending = current ? [current] : [];
      while (pending.length) {
        const fiber = pending.pop();
        if (fiber.child) pending.push(fiber.child);
        if (fiber.sibling) pending.push(fiber.sibling);
        if (typeof fiber.type !== "function") continue;
        for (let hook = fiber.memoizedState; hook; hook = hook.next) {
          const request = hook.memoizedState?.current;
          if (
            typeof request?.signature !== "string" ||
            typeof request.request !== "number" ||
            typeof request.promise?.then !== "function"
          )
            continue;
          const signature = JSON.parse(request.signature);
          if (
            Array.isArray(signature) &&
            signature.length === 6 &&
            signature[0] === endpoint &&
            signature[1] === null &&
            signature[2] === key
          )
            return { promise: request.promise };
        }
      }
      throw new Error(
        "The held native discovery request must already be in flight",
      );
    },
    { endpoint, key },
  );
  const promise = handle
    .evaluate(async ({ promise }) => ({
      settled: true,
      staleIgnored: (await promise) === null,
    }))
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  return { handle, promise };
}

export async function verifyDiscoveryEdges({ page, invoke, record }) {
  const overview = await native(invoke, "get_overview");
  const hub = await native(invoke, "agent_hub_overview");
  assert.deepEqual(
    overview.providers,
    [],
    "Discovery edges require an empty provider store",
  );
  assert.ok(hub.agents.length > 0);
  const originalAgents = agentConfiguration(hub);
  for (const agent of originalAgents) {
    assert.equal(agent.configured, false);
    assert.equal(agent.providerId, null);
    assert.equal(agent.model, null);
  }

  const endpoint = page.locator("#hub-endpoint");
  const key = page.locator("#hub-api-key");
  const provider = page.locator("#hub-provider");
  const details = page.locator(".hub-extra-settings");
  const name = details.locator("input");
  const original = {
    endpoint: await endpoint.inputValue(),
    provider: await provider.inputValue(),
    name: await name.inputValue(),
    detailsOpen: await details.evaluate((element) => element.open),
    model: await page.locator("#hub-model").inputValue(),
  };
  assert.equal(original.provider, "");
  assert.ok(
    (await key.inputValue()) === "",
    "Only an empty credential draft is allowed",
  );
  assert.equal(await key.getAttribute("type"), "password");
  assert.equal(original.model, "");

  const counts = {
    empty: 0,
    catalog: 0,
    oldEndpoint: 0,
    newEndpoint: 0,
    oldKey: 0,
    newKey: 0,
  };
  const completed = { oldEndpoint: 0, oldKey: 0 };
  const held = [];
  const observations = [];
  let catalog = ["gpt-catalog-a", "gpt-catalog-b"];
  const sendModels = (response, models) => {
    assert.ok(
      !response.destroyed,
      "A controlled discovery response must still be connected",
    );
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        object: "list",
        data: models.map((id) => ({ id, object: "model" })),
      }),
    );
  };
  const release = (kind, models) => {
    for (const pending of held.filter(
      (item) => item.kind === kind && !item.released,
    )) {
      pending.released = true;
      sendModels(pending.response, models);
    }
  };
  const server = createServer((request, response) => {
    const authorization = request.headers.authorization;
    if (
      request.method !== "GET" ||
      ![keyA, keyB].some((key) => authorization === `Bearer ${key}`)
    ) {
      response.writeHead(404);
      response.end();
      return;
    }
    let kind;
    let models;
    switch (request.url) {
      case "/empty/v1/models":
        kind = "empty";
        models = [];
        break;
      case "/catalog/v1/models":
        kind = "catalog";
        models = catalog;
        break;
      case "/stale-endpoint/v1/models":
        kind = "oldEndpoint";
        break;
      case "/fresh-endpoint/v1/models":
        kind = "newEndpoint";
        models = ["gpt-endpoint-new"];
        break;
      case "/key-race/v1/models":
        kind = authorization === `Bearer ${keyA}` ? "oldKey" : "newKey";
        if (kind === "newKey") models = ["gpt-key-new"];
        break;
      default:
        response.writeHead(404);
        response.end();
        return;
    }
    counts[kind]++;
    if (models) sendModels(response, models);
    else {
      response.once("finish", () => completed[kind]++);
      held.push({ kind, response, released: false });
    }
  });

  let failure;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    await endpoint.fill(`${origin}/empty/v1`);
    await key.fill(keyA);
    await waitUntil(
      () => counts.empty,
      (value) => value > 0,
      "A real empty-list model request",
    );
    const empty = await waitUntil(
      () => modelState(page),
      (value) =>
        value.failure &&
        !value.refreshDisabled &&
        !value.status.includes(busyText),
      "The real Rust empty-list failure",
    );
    assert.match(empty.status, /没有返回可用模型/u);
    assert.deepEqual(empty.options, []);
    assert.equal(empty.value, "");
    assert.equal(empty.disabled, true);
    assert.equal(empty.confirmDisabled, true);
    assert.equal(empty.saveDisabled, true);
    assert.equal(await page.locator(".hub-probe-status.passed").count(), 0);
    await record("native-discovery-empty-model-list", {
      passed: true,
      actualRustRequests: counts.empty,
      noFabricatedModel: true,
      saveAndConfirmDisabled: true,
    });

    await endpoint.fill(`${origin}/catalog/v1`);
    await waitForModels(page, catalog);
    await page.locator("#hub-model").selectOption("gpt-catalog-b");
    assert.equal(
      await page.locator("#hub-model").inputValue(),
      "gpt-catalog-b",
    );
    const catalogRequests = counts.catalog;
    catalog = ["gpt-catalog-new"];
    await page.locator(".hub-model-label button").click();
    await waitUntil(
      () => counts.catalog,
      (value) => value > catalogRequests,
      "An explicit Rust catalog refresh",
    );
    const refreshed = await waitForModels(page, catalog);
    assert.equal(refreshed.value, "gpt-catalog-new");
    await record("native-discovery-retired-default", {
      passed: true,
      explicitRefresh: true,
      actualRustRequests: counts.catalog,
      previousDefaultRetired: true,
      replacementWasActuallyReturned: true,
      models: refreshed.options,
    });

    const runRace = async ({
      kind,
      oldEndpoint,
      newEndpoint,
      oldModel,
      newModel,
      newKey,
    }) => {
      await key.fill("");
      await endpoint.fill(oldEndpoint);
      await key.fill(keyA);
      await waitUntil(
        () => counts[kind],
        (value) => value > 0,
        "The actual held old discovery request",
      );
      await waitUntil(
        () => modelState(page),
        (value) => value.status.includes(busyText),
        "The old discovery busy state",
      );
      assert.equal(await endpoint.isEnabled(), true);
      assert.equal(await key.isEnabled(), true);
      const observation = await observePendingDiscovery(
        page,
        oldEndpoint,
        keyA,
      );
      observations.push(observation);
      if (newEndpoint !== oldEndpoint) await endpoint.fill(newEndpoint);
      else await key.fill(newKey);
      const newKind = kind === "oldEndpoint" ? "newEndpoint" : "newKey";
      await waitUntil(
        () => counts[newKind],
        (value) => value > 0,
        "The actual newer discovery request",
      );
      const current = await waitForModels(page, [newModel]);
      assert.equal(current.value, newModel);
      release(kind, [oldModel]);
      const outcome = await bounded(
        observation.promise,
        "The released old native discovery request",
      );
      assert.ifError(outcome.error);
      assert.deepEqual(outcome.value, { settled: true, staleIgnored: true });
      await waitUntil(
        () => completed[kind],
        (value) => value > 0,
        "The delayed HTTP response completion",
      );
      const after = await modelState(page);
      assert.deepEqual(after.options, [newModel]);
      assert.equal(after.value, newModel);
      assert.equal(after.disabled, false);
      assert.equal(after.failure, false);
      assert.equal(after.refreshDisabled, false);
      assert.equal(await endpoint.inputValue(), newEndpoint);
      assert.ok(
        await key.evaluate(
          (element, expected) => element.value === expected,
          newKey,
        ),
      );
      assert.equal(await page.locator(".hub-probe-status.passed").count(), 0);
      await record(
        `native-discovery-stale-${kind === "oldEndpoint" ? "endpoint" : "key"}`,
        {
          passed: true,
          delayedResponseActuallyCompleted: true,
          oldNativePromiseSettled: true,
          staleResultIgnored: true,
          newModelRetained: true,
          endpointAndKeyEditableWhileDiscovering: true,
          actualOldRustRequests: counts[kind],
          actualNewRustRequests: counts[newKind],
          models: after.options,
        },
      );
    };
    await runRace({
      kind: "oldEndpoint",
      oldEndpoint: `${origin}/stale-endpoint/v1`,
      newEndpoint: `${origin}/fresh-endpoint/v1`,
      oldModel: "gpt-endpoint-retired",
      newModel: "gpt-endpoint-new",
      newKey: keyA,
    });
    await runRace({
      kind: "oldKey",
      oldEndpoint: `${origin}/key-race/v1`,
      newEndpoint: `${origin}/key-race/v1`,
      oldModel: "gpt-key-retired",
      newModel: "gpt-key-new",
      newKey: keyB,
    });
  } catch (error) {
    failure = error;
  } finally {
    // Clearing the key first invalidates all generations before responses are
    // released or the server closes. Only this helper's loopback server closes.
    const cleanupErrors = [];
    const attempt = async (action) => {
      try {
        await action();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    await attempt(() => key.fill(""));
    await attempt(async () => {
      if ((await provider.inputValue()) !== original.provider)
        await provider.selectOption(original.provider);
    });
    await attempt(() => endpoint.fill(original.endpoint));
    for (const pending of held.filter((item) => !item.released)) {
      pending.released = true;
      await attempt(() => {
        if (!pending.response.destroyed)
          sendModels(pending.response, ["gpt-cleanup-retired"]);
      });
    }
    server.closeAllConnections();
    await attempt(() => new Promise((resolve) => server.close(resolve)));
    for (const observation of observations) {
      await attempt(async () => {
        const outcome = await bounded(observation.promise, "Discovery cleanup");
        assert.ifError(outcome.error);
      });
      await attempt(() => observation.handle.dispose());
    }
    let draftRestored = false;
    let storeUnchanged = false;
    await attempt(async () => {
      const restored = await waitUntil(
        () => modelState(page),
        (value) =>
          value.value === original.model &&
          !value.options.length &&
          !value.status.includes(busyText),
        "The original empty model draft",
      );
      assert.equal(await endpoint.inputValue(), original.endpoint);
      assert.equal(await provider.inputValue(), original.provider);
      assert.ok((await key.inputValue()) === "");
      assert.equal(await key.getAttribute("type"), "password");
      assert.equal(await name.inputValue(), original.name);
      assert.equal(
        await details.evaluate((element) => element.open),
        original.detailsOpen,
      );
      assert.equal(restored.confirmDisabled, true);
      assert.equal(restored.saveDisabled, true);
      draftRestored = true;
    });
    await attempt(async () => {
      assert.deepEqual(
        (await native(invoke, "get_overview")).providers,
        overview.providers,
      );
      assert.deepEqual(
        agentConfiguration(await native(invoke, "agent_hub_overview")),
        originalAgents,
      );
      storeUnchanged = true;
    });
    await record("native-discovery-edges-restored", {
      passed: cleanupErrors.length === 0,
      originalDraftRestored: draftRestored,
      keyClearedAndPassword: draftRestored,
      providerStoreUnchanged: storeUnchanged,
      agentConfigurationsUnchanged: storeUnchanged,
      saveOrConfirmUsed: false,
      actualRustRequests: counts,
      screenshotsTaken: false,
    });
    failure ??= cleanupErrors[0];
  }
  if (failure) throw failure;
}
