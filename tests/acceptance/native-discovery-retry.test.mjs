import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import {
  waitForHubDiscovery,
  assertQuickStartConfigurationContract,
} from "./native-hub-extra.mjs";

const success = { loading: false, failure: "", models: ["actual-model"] };
const failure = {
  loading: false,
  failure: "Supplier request exceeded 8000ms",
  models: [],
};

test("native quickstart enforces the current installed-client configuration contract", async () => {
  const source = await fs.readFile(
    new URL("../../app/src/AgentHub.tsx", import.meta.url),
    "utf8",
  );
  const section = source.slice(
    source.indexOf('<h2 id="hub-quickstart-title"'),
    source.indexOf(
      "</section>",
      source.indexOf('<h2 id="hub-quickstart-title"'),
    ),
  );
  const steps = [...section.matchAll(/<li>([\s\S]*?)<\/li>/gu)].map(
    (match) => match[1],
  );
  const notes = [...section.matchAll(/<p>([\s\S]*?)<\/p>/gu)].map(
    (match) => match[1],
  );
  assert.equal(assertQuickStartConfigurationContract(steps, notes), true);
  for (const [index, phrase] of [
    [0, "自动探测已安装的客户端"],
    [0, "获取实际模型"],
    [1, "原配置目录"],
    [1, "存在多个目录时需要选择"],
    [2, "必要连接字段"],
    [2, "验证真实工具"],
    [2, "需要重启加载"],
    [2, "原会话与历史继续保留"],
  ]) {
    const staleSteps = steps.slice();
    staleSteps[index] = staleSteps[index].replace(phrase, "");
    assert.throws(() =>
      assertQuickStartConfigurationContract(staleSteps, notes),
    );
  }
  for (const phrase of [
    "客户端由你安装",
    "不附带客户端本体",
    "本地兼容服务",
    "后台运行",
  ]) {
    const staleNotes = notes.map((note) => note.replace(phrase, ""));
    assert.throws(() =>
      assertQuickStartConfigurationContract(steps, staleNotes),
    );
  }
});

class DiscoveryPage extends EventEmitter {
  constructor(
    state,
    {
      afterLoading,
      afterClick = success,
      nativeReply = "ok",
      ipc = true,
      requestUrl = "http://ipc.localhost/discover_provider_connection",
    } = {},
  ) {
    super();
    this.state = structuredClone(state);
    this.afterLoading = afterLoading;
    this.afterClick = afterClick;
    this.nativeReply = nativeReply;
    this.ipc = ipc;
    this.requestUrl = requestUrl;
    this.clicks = 0;
    this.waitTimeouts = [];
  }
  document() {
    const state = this.state;
    const model = {
      disabled: state.loading || !!state.failure || !state.models.length,
      options: state.models.map((value) => ({ value })),
    };
    const status = {
      textContent: state.loading
        ? "正在识别协议并获取模型列表"
        : state.failure || "1 个可用模型",
    };
    return {
      getElementById: (id) =>
        id === "hub-model"
          ? model
          : id === "hub-provider"
            ? { value: "actual-provider" }
            : null,
      querySelector: (selector) =>
        selector === ".hub-model-status.failure"
          ? state.failure
            ? status
            : null
          : selector === ".hub-model-status"
            ? status
            : selector === ".hub-model-label button"
              ? {
                  disabled: state.loading,
                  textContent: state.loading ? "同步中" : "同步模型",
                }
              : null,
    };
  }
  async evaluate(callback) {
    return structuredClone(
      vm.runInNewContext(`(${callback.toString()})()`, {
        document: this.document(),
      }),
    );
  }
  async waitForFunction(callback, _argument, options) {
    this.waitTimeouts.push(options.timeout);
    assert.equal(
      options.timeout,
      60000,
      "Keep the existing UI wait budget; never alter Rust's 8s connection timeout",
    );
    if (this.state.loading && this.afterLoading)
      this.state = structuredClone(this.afterLoading);
    if (!(await this.evaluate(callback)))
      throw new Error("UI discovery wait timed out");
  }
  waitForResponse(predicate, options) {
    assert.equal(options.timeout, 60000);
    if (
      !this.ipc ||
      this.requestUrl !== "http://ipc.localhost/discover_provider_connection"
    ) {
      return Promise.reject(new Error("No matching native response"));
    }
    return new Promise((resolve) => {
      const listener = (response) => {
        if (predicate(response)) {
          this.off("response", listener);
          resolve(response);
        }
      };
      this.on("response", listener);
    });
  }
  getByRole(role, options) {
    assert.equal(role, "button");
    assert.deepEqual(options, { name: "同步模型", exact: true });
    return {
      isEnabled: async () => !this.state.loading,
      click: async () => {
        assert.equal(
          this.state.loading,
          false,
          "A loading query must never be clicked again",
        );
        this.clicks++;
        this.state = { loading: true, failure: "", models: [] };
        const request = { url: () => this.requestUrl, method: () => "POST" };
        if (this.ipc) this.emit("request", request);
        this.state = structuredClone(this.afterClick);
        if (this.ipc)
          this.emit("response", {
            request: () => request,
            headerValue: async () => this.nativeReply,
            json: async () => ({
              models: [{ id: "actual-model" }],
              syncedAt: 123456,
              protocol: "openai",
            }),
          });
      },
    };
  }
}

async function run(page, options = {}) {
  const events = [];
  const receipt = {};
  const request = waitForHubDiscovery({
    page,
    record: async (step, details) =>
      events.push({ step, ...structuredClone(details) }),
    agentId: "hermes",
    phase: "initial-tool-verification",
    retryFailure: true,
    receipt,
    ...options,
  });
  return { request, receipt, events };
}

test("stale failure starts exactly one actual sync-button query and accepts only its native models", async () => {
  const page = new DiscoveryPage(failure);
  const { request, receipt, events } = await run(page);
  assert.deepEqual(await request, ["actual-model"]);
  assert.equal(page.clicks, 1);
  assert.equal(receipt.retryClicked, true);
  assert.equal(receipt.actualRustRequestObserved, true);
  assert.equal(receipt.nativeRequestCount, 1);
  assert.equal(receipt.nativeResponseObserved, true);
  assert.equal(receipt.fallbackModelUsed, false);
  assert.equal(receipt.passed, true);
  assert.equal(receipt.supplierConnectTimeoutMs, 8000);
  assert.equal(receipt.supplierTimeoutPolicyChanged, false);
  assert.ok(
    events.some((event) => event.step === "native-hub-discovery-retry-clicked"),
  );
  assert.equal(events.at(-1).passed, true);
  assert.equal(page.listenerCount("request"), 0);
  assert.equal(page.listenerCount("response"), 0);
});

test("a second native discovery failure remains failed and is never clicked again", async () => {
  const page = new DiscoveryPage(failure, {
    afterClick: failure,
    nativeReply: "error",
  });
  const { request, receipt, events } = await run(page);
  await assert.rejects(request, /Real supplier discovery failed/u);
  assert.equal(page.clicks, 1);
  assert.equal(receipt.actualRustRequestObserved, true);
  assert.equal(receipt.passed, false);
  assert.equal(events.at(-1).passed, false);
  assert.equal(page.listenerCount("request"), 0);
});

test("each later Agent receives its own retry while the previous failure stays failed", async () => {
  const page = new DiscoveryPage(failure, {
    afterClick: failure,
    nativeReply: "error",
  });
  const first = await run(page, { agentId: "codex" });
  await assert.rejects(first.request, /Real supplier discovery failed/u);
  page.afterClick = success;
  page.nativeReply = "ok";
  const second = await run(page, { agentId: "hermes" });
  assert.deepEqual(await second.request, ["actual-model"]);
  assert.equal(page.clicks, 2);
  assert.equal(first.receipt.passed, false);
  assert.equal(first.receipt.nativeRequestCount, 1);
  assert.equal(second.receipt.passed, true);
  assert.equal(second.receipt.nativeRequestCount, 1);
  assert.notEqual(first.receipt, second.receipt);
});

test("successful discovery is reused without an unnecessary retry", async () => {
  const page = new DiscoveryPage(success);
  const { request, receipt } = await run(page);
  assert.deepEqual(await request, ["actual-model"]);
  assert.equal(page.clicks, 0);
  assert.equal(receipt.retryClicked, false);
  assert.equal(receipt.actualRustRequestObserved, false);
  assert.equal(receipt.passed, true);
});

test("loading discovery is allowed to finish successfully without a retry", async () => {
  const page = new DiscoveryPage(
    { loading: true, failure: "", models: [] },
    { afterLoading: success },
  );
  const { request } = await run(page);
  assert.deepEqual(await request, ["actual-model"]);
  assert.equal(page.clicks, 0);
});

test("a query that remains loading fails its wait without clicking the disabled refresh", async () => {
  const page = new DiscoveryPage({ loading: true, failure: "", models: [] });
  const { request, receipt } = await run(page);
  await assert.rejects(request, /timed out/u);
  assert.equal(page.clicks, 0);
  assert.equal(receipt.passed, false);
});

test("ordinary initial discovery can fail without enabling the per-agent retry policy", async () => {
  const page = new DiscoveryPage(failure);
  const { request, receipt } = await run(page, { retryFailure: false });
  await assert.rejects(request, /Real supplier discovery failed/u);
  assert.equal(page.clicks, 0);
  assert.equal(receipt.passed, false);
});

test("UI success cannot replace missing native IPC request evidence", async () => {
  const page = new DiscoveryPage(failure, { ipc: false });
  const { request, receipt } = await run(page);
  await assert.rejects(request, /actual native discovery request/u);
  assert.equal(receipt.actualRustRequestObserved, false);
  assert.equal(receipt.passed, false);
});

test("unrelated POST traffic cannot prove a native Rust discovery request", async () => {
  const page = new DiscoveryPage(failure, {
    requestUrl: "https://supplier.invalid/discover_provider_connection",
  });
  const { request, receipt } = await run(page);
  await assert.rejects(request, /actual native discovery request/u);
  assert.equal(receipt.nativeRequestCount, 0);
  assert.equal(receipt.passed, false);
});

test("models absent from the successful native response remain rejected", async () => {
  const page = new DiscoveryPage(failure, {
    afterClick: { ...success, models: ["fallback-model"] },
  });
  const { request, receipt } = await run(page);
  await assert.rejects(request, /actual native discovery response/u);
  assert.equal(receipt.passed, false);
  assert.equal(receipt.fallbackModelUsed, false);
});

test("a response lacking the Tauri Rust header cannot establish retry success", async () => {
  const page = new DiscoveryPage(failure, { nativeReply: null });
  const { request, receipt } = await run(page);
  await assert.rejects(request, /Tauri Rust IPC response/u);
  assert.equal(receipt.passed, false);
  assert.equal(page.clicks, 1);
});

test("both eight-agent passes use the same bounded discovery guard without reducing terminal gates", async () => {
  const main = await fs.readFile(
    new URL("./native-ui.mjs", import.meta.url),
    "utf8",
  );
  const extras = await fs.readFile(
    new URL("./native-hub-extra.mjs", import.meta.url),
    "utf8",
  );
  assert.match(main, /waitForHubDiscovery/u);
  assert.match(main, /retryFailure: true/u);
  assert.match(extras, /phase: "separate-tool-revalidation"/u);
  assert.match(main, /real\.agents\.every\(\(item\) => item\.passed\)/u);
  assert.match(main, /summary\.agents\.length, expectedAgents\.length/u);
  assert.match(main, /terminalCompletedObserved, true/u);
  assert.match(extras, /probe\.evidence\?\.terminalCompletedObserved, true/u);
  assert.match(main, /"deepseek_harness"/u);
  assert.match(main, /native-discovery-driver-hashes-bound/u);
});
