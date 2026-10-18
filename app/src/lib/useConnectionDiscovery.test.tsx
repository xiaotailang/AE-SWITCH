import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConnectionDiscovery } from "./useConnectionDiscovery";
import { api } from "./api";
import type { ModelSyncResult, Provider } from "../types";

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  desktopRuntime: true,
}));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const input = {
  providerId: null,
  baseUrl: "https://supplier.test/v1",
  apiKey: "test-key",
};
const response = (
  ids: string[],
  protocol: "openai" | "anthropic" = "openai",
): ModelSyncResult => ({
  protocol,
  authMode: protocol === "openai" ? "bearer" : "x-api-key",
  syncedAt: 123,
  models: ids.map((id) => ({
    id,
    enabled: true,
    contextWindow: null,
    reasoningEfforts: [],
  })),
});
const tick = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(650);
  });
const savedProvider = (id: string, model: string, ids: string[]): Provider => ({
  id,
  family: "codex",
  name: id,
  baseUrl: `https://${id}.test/v1`,
  model,
  authMode: "bearer",
  hasKey: true,
  keySuffix: "test",
  updatedAt: 123,
  reasoningEffort: null,
  codexOptions: {
    models: response(ids).models,
    fastMode: null,
    contextWindow: null,
    autoCompactTokenLimit: null,
    modelsSyncedAt: 123,
    balanceQuery: null,
  },
});

describe("connection source identity", () => {
  it.each([null, "same-explicit-key"])(
    "restores each provider's default across a shared URL with key %s",
    async (apiKey) => {
      vi.useFakeTimers();
      const ids = ["gpt-a1", "gpt-a2"];
      const providerA = savedProvider("a", "gpt-a1", ids);
      const providerB = {
        ...savedProvider("b", "gpt-a2", ids),
        baseUrl: providerA.baseUrl,
      };
      const probe = vi
        .spyOn(api, "discoverConnection")
        .mockResolvedValue(response(ids));
      const hook = renderHook(
        ({ provider }) =>
          useConnectionDiscovery(
            { providerId: provider.id, baseUrl: provider.baseUrl, apiKey },
            "auto",
            "codex",
            provider,
          ),
        { initialProps: { provider: providerA } },
      );
      await tick();
      expect(hook.result.current.model).toBe("gpt-a1");
      act(() => {
        hook.result.current.toggle("gpt-a2", false);
        hook.result.current.setContext("gpt-a1", "512");
      });
      hook.rerender({ provider: providerB });
      await tick();
      expect(hook.result.current.model).toBe("gpt-a2");
      expect(hook.result.current.models.every((m) => m.enabled)).toBe(true);
      expect(hook.result.current.contexts["gpt-a1"]).toBe("256");
      act(() => {
        hook.result.current.toggle("gpt-a1", false);
        hook.result.current.setContext("gpt-a2", "1024");
      });
      hook.rerender({ provider: providerA });
      await tick();
      expect(hook.result.current.model).toBe("gpt-a1");
      expect(hook.result.current.models.every((m) => m.enabled)).toBe(true);
      expect(hook.result.current.contexts["gpt-a2"]).toBe("256");
      expect(
        probe.mock.calls.map(([connection]) => connection.providerId),
      ).toEqual(["a", "b", "a"]);
    },
  );

  it("rejects a late response after changing provider with the same URL and explicit key", async () => {
    vi.useFakeTimers();
    const ids = ["gpt-a1", "gpt-a2"];
    const providerA = savedProvider("a", "gpt-a1", ids);
    const providerB = {
      ...savedProvider("b", "gpt-a2", ids),
      baseUrl: providerA.baseUrl,
    };
    let finishA!: (value: ModelSyncResult) => void;
    const probe = vi
      .spyOn(api, "discoverConnection")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishA = resolve;
          }),
      )
      .mockResolvedValueOnce(response(ids))
      .mockResolvedValueOnce(response(ids));
    const hook = renderHook(
      ({ provider }) =>
        useConnectionDiscovery(
          {
            providerId: provider.id,
            baseUrl: provider.baseUrl,
            apiKey: "same-explicit-key",
          },
          "auto",
          "codex",
          provider,
        ),
      { initialProps: { provider: providerA } },
    );
    await tick();
    hook.rerender({ provider: providerB });
    await tick();
    expect(hook.result.current.model).toBe("gpt-a2");
    const currentModels = hook.result.current.models;
    await act(async () => {
      finishA(response(["gpt-a1", "gpt-a2", "gpt-old-source"]));
    });
    expect(hook.result.current.model).toBe("gpt-a2");
    expect(hook.result.current.models).toEqual(currentModels);
    hook.rerender({ provider: providerA });
    await tick();
    expect(hook.result.current.model).toBe("gpt-a1");
    expect(
      probe.mock.calls.map(([connection]) => connection.providerId),
    ).toEqual(["a", "b", "a"]);
  });
});

describe("自动接入的模型默认选择", () => {
  it("A/B 切换恢复已保存的 A1 默认，而不改为推荐的 A2", async () => {
    vi.useFakeTimers();
    const providerA = savedProvider("a", "gpt-a1", ["gpt-a1", "gpt-a2"]);
    const providerB = savedProvider("b", "gpt-b2", ["gpt-b1", "gpt-b2"]);
    const probe = vi
      .spyOn(api, "discoverConnection")
      .mockImplementation(async ({ providerId }) =>
        response(
          providerId === providerA.id
            ? ["gpt-a1", "gpt-a2"]
            : ["gpt-b1", "gpt-b2"],
        ),
      );
    const hook = renderHook(
      ({ provider }) =>
        useConnectionDiscovery(
          {
            providerId: provider.id,
            baseUrl: provider.baseUrl,
            apiKey: null,
          },
          "auto",
          "codex",
          provider,
        ),
      { initialProps: { provider: providerA } },
    );
    await tick();
    expect(hook.result.current.model).toBe("gpt-a1");
    hook.rerender({ provider: providerB });
    await tick();
    expect(hook.result.current.model).toBe("gpt-b2");
    hook.rerender({ provider: providerA });
    await tick();
    expect(hook.result.current.model).toBe("gpt-a1");
    expect(
      probe.mock.calls.map(([connection]) => connection.providerId),
    ).toEqual(["a", "b", "a"]);
  });

  it.each([
    ["下架", "gpt-a1", ["gpt-a2", "gpt-a3"], "codex", "openai", "gpt-a3", true],
    [
      "不兼容",
      "qwen3-coder",
      ["qwen3-coder", "claude-sonnet-4-6"],
      "claude_desktop",
      "anthropic",
      "claude-sonnet-4-6",
      true,
    ],
    [
      "已取消",
      "gpt-a1",
      ["gpt-a1", "gpt-a2"],
      "codex",
      "openai",
      "gpt-a2",
      false,
    ],
  ] as const)(
    "%s 的保存默认回落到真实目录推荐，不追加模型",
    async (_reason, model, catalog, target, protocol, expected, enabled) => {
      vi.useFakeTimers();
      const firstModel = protocol === "openai" ? "gpt-b2" : "claude-opus-4-6";
      const providerB = savedProvider("b", firstModel, [firstModel]);
      const providerA = savedProvider("a", model, [...catalog]);
      if (!enabled)
        providerA.codexOptions!.models.find((m) => m.id === model)!.enabled =
          false;
      vi.spyOn(api, "discoverConnection")
        .mockResolvedValueOnce(response([firstModel], protocol))
        .mockResolvedValueOnce(response([...catalog], protocol));
      const hook = renderHook(
        ({ provider }) =>
          useConnectionDiscovery(
            {
              providerId: provider.id,
              baseUrl: provider.baseUrl,
              apiKey: null,
            },
            "auto",
            target,
            provider,
          ),
        { initialProps: { provider: providerB } },
      );
      await tick();
      hook.rerender({ provider: providerA });
      await tick();
      expect(hook.result.current.model).toBe(expected);
      expect(hook.result.current.models.map((m) => m.id)).toEqual([...catalog]);
      expect(
        hook.result.current.models.find((m) => m.id === expected)?.enabled,
      ).toBe(true);
    },
  );

  it("刷新期间的有效本地默认选择优先于保存默认和新推荐", async () => {
    vi.useFakeTimers();
    const provider = savedProvider("a", "gpt-a1", ["gpt-a1", "gpt-a2"]);
    let finish!: (value: ModelSyncResult) => void;
    vi.spyOn(api, "discoverConnection")
      .mockResolvedValueOnce(response(["gpt-a1", "gpt-a2"]))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    const hook = renderHook(() =>
      useConnectionDiscovery(
        { providerId: provider.id, baseUrl: provider.baseUrl, apiKey: null },
        "auto",
        "codex",
        provider,
      ),
    );
    await tick();
    let refresh!: ReturnType<typeof hook.result.current.refresh>;
    act(() => {
      refresh = hook.result.current.refresh();
    });
    act(() => {
      hook.result.current.selectDefault("gpt-a2");
    });
    await act(async () => {
      finish(response(["gpt-a1", "gpt-a2", "gpt-a3"]));
      expect((await refresh)?.model).toBe("gpt-a2");
    });
    expect(hook.result.current.model).toBe("gpt-a2");
  });

  it("手动输入其他站点，即使仍传旧供应商也不继承其默认", async () => {
    vi.useFakeTimers();
    const provider = savedProvider("a", "gpt-a1", ["gpt-a1", "gpt-a2"]);
    const probe = vi
      .spyOn(api, "discoverConnection")
      .mockResolvedValue(response(["gpt-a1", "gpt-a2"]));
    const hook = renderHook(
      ({ baseUrl }) =>
        useConnectionDiscovery(
          { providerId: provider.id, baseUrl, apiKey: "manual-key" },
          "auto",
          "codex",
          provider,
        ),
      { initialProps: { baseUrl: provider.baseUrl } },
    );
    await tick();
    expect(hook.result.current.model).toBe("gpt-a1");
    const manualEndpoint = "https://other-source.test/v1";
    hook.rerender({ baseUrl: manualEndpoint });
    await tick();
    expect(hook.result.current.model).toBe("gpt-a2");
    expect(probe).toHaveBeenLastCalledWith(
      {
        providerId: provider.id,
        baseUrl: manualEndpoint,
        apiKey: "manual-key",
      },
      null,
      null,
    );
  });

  it("供应商 ID 不匹配时不从相同端点的旧供应商恢复默认", async () => {
    vi.useFakeTimers();
    const provider = savedProvider("a", "gpt-a1", ["gpt-a1", "gpt-a2"]);
    vi.spyOn(api, "discoverConnection")
      .mockResolvedValueOnce(response(["gpt-old-catalog"]))
      .mockResolvedValueOnce(response(["gpt-a1", "gpt-a2"]));
    const hook = renderHook(
      ({ providerId }) =>
        useConnectionDiscovery(
          { providerId, baseUrl: provider.baseUrl, apiKey: null },
          "auto",
          "codex",
          provider,
        ),
      { initialProps: { providerId: provider.id } },
    );
    await tick();
    expect(hook.result.current.model).toBe("gpt-old-catalog");
    hook.rerender({ providerId: "other-provider" });
    await tick();
    expect(hook.result.current.model).toBe("gpt-a2");
  });

  it("A 的迟到响应不覆盖 B 的保存默认，再回 A 仍恢复 A1", async () => {
    vi.useFakeTimers();
    const providerA = savedProvider("a", "gpt-a1", ["gpt-a1", "gpt-a2"]);
    const providerB = savedProvider("b", "gpt-b1", ["gpt-b1", "gpt-b2"]);
    let finishA!: (value: ModelSyncResult) => void;
    const probe = vi
      .spyOn(api, "discoverConnection")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishA = resolve;
          }),
      )
      .mockResolvedValueOnce(response(["gpt-b1", "gpt-b2"]))
      .mockResolvedValueOnce(response(["gpt-a1", "gpt-a2"]));
    const hook = renderHook(
      ({ provider }) =>
        useConnectionDiscovery(
          { providerId: provider.id, baseUrl: provider.baseUrl, apiKey: null },
          "auto",
          "codex",
          provider,
        ),
      { initialProps: { provider: providerA } },
    );
    await tick();
    hook.rerender({ provider: providerB });
    await tick();
    expect(hook.result.current.model).toBe("gpt-b1");
    await act(async () => {
      finishA(response(["gpt-a1", "gpt-a2"]));
    });
    expect(hook.result.current.model).toBe("gpt-b1");
    expect(hook.result.current.models.map((m) => m.id)).toEqual([
      "gpt-b1",
      "gpt-b2",
    ]);
    hook.rerender({ provider: providerA });
    await tick();
    expect(hook.result.current.model).toBe("gpt-a1");
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["codex", "openai"],
    ["codex", "anthropic"],
    ["claude_desktop", "openai"],
    ["claude_desktop", "anthropic"],
    ["claude_cli", "openai"],
    ["claude_cli", "anthropic"],
  ] as const)(
    "%s 的 %s 模型首次同步全部启用，默认模型单独推荐",
    async (target, protocol) => {
      vi.useFakeTimers();
      const ids =
        protocol === "openai"
          ? ["gpt-5.4", "gpt-4.1", "qwen3-coder"]
          : ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"];
      vi.spyOn(api, "discoverConnection").mockResolvedValue(
        response(ids, protocol),
      );
      const hook = renderHook(() =>
        useConnectionDiscovery(input, "auto", target),
      );
      await tick();
      expect(
        hook.result.current.models.filter((m) => m.enabled).map((m) => m.id),
      ).toEqual(ids);
      expect(hook.result.current.model).toBe(
        protocol === "openai" ? "gpt-5.4" : "claude-sonnet-4-6",
      );
      if (target === "codex")
        expect(
          hook.result.current.models.every((m) => m.contextWindow === 256000),
        ).toBe(true);
    },
  );

  it("刷新期间的取消和上下文保留，新增模型默认启用，失败保留列表", async () => {
    vi.useFakeTimers();
    let finish!: (value: ModelSyncResult) => void;
    const probe = vi
      .spyOn(api, "discoverConnection")
      .mockResolvedValueOnce(response(["gpt-5.4", "gpt-4.1"]))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockRejectedValue(new Error("无权限"));
    const hook = renderHook(() =>
      useConnectionDiscovery(input, "auto", "codex"),
    );
    await tick();
    let refresh!: ReturnType<typeof hook.result.current.refresh>;
    act(() => {
      refresh = hook.result.current.refresh();
    });
    act(() => {
      hook.result.current.toggle("gpt-5.4", false);
      hook.result.current.setContext("gpt-4.1", "512");
    });
    await act(async () => {
      finish(response(["gpt-5.4", "gpt-4.1", "glm-5"]));
      await refresh;
    });
    expect(hook.result.current.models.map((m) => m.enabled)).toEqual([
      false,
      true,
      true,
    ]);
    expect(hook.result.current.model).toBe("gpt-4.1");
    expect(hook.result.current.contexts["gpt-4.1"]).toBe("512");
    expect(hook.result.current.models[1].contextWindow).toBe(512000);
    const before = hook.result.current.models;
    await act(async () => {
      await hook.result.current.refresh();
    });
    expect(hook.result.current.models).toEqual(before);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("已保存取消项不被覆盖，全取消后刷新不偷偷启用默认模型", async () => {
    vi.useFakeTimers();
    const provider: Provider = {
      id: "saved",
      family: "codex",
      name: "Saved",
      baseUrl: input.baseUrl,
      authMode: "bearer",
      model: "gpt-5.4",
      hasKey: true,
      keySuffix: "test",
      updatedAt: 123,
      reasoningEffort: null,
      codexOptions: {
        models: response(["gpt-5.4", "gpt-4.1"]).models.map((m) => ({
          ...m,
          enabled: m.id === "gpt-5.4",
        })),
        fastMode: null,
        contextWindow: null,
        autoCompactTokenLimit: null,
        modelsSyncedAt: 123,
        balanceQuery: null,
      },
    };
    vi.spyOn(api, "discoverConnection").mockResolvedValue(
      response(["gpt-5.4", "gpt-4.1", "glm-5"]),
    );
    const hook = renderHook(() =>
      useConnectionDiscovery(
        { ...input, providerId: provider.id, apiKey: null },
        "auto",
        "codex",
        provider,
      ),
    );
    await tick();
    expect(hook.result.current.models.map((m) => m.enabled)).toEqual([
      true,
      false,
      true,
    ]);
    act(() => {
      hook.result.current.toggle("gpt-5.4", false);
      hook.result.current.toggle("glm-5", false);
    });
    await act(async () => {
      await hook.result.current.refresh();
    });
    expect(hook.result.current.models.every((m) => !m.enabled)).toBe(true);
    expect(hook.result.current.model).toBe("");
  });

  it.each(["codex", "claude_cli"] as const)(
    "%s 同步移除下架模型及其上下文，自动选择可用默认值，仍保留勾选与长度；失败不删除",
    async (target) => {
      vi.useFakeTimers();
      vi.spyOn(api, "discoverConnection")
        .mockResolvedValueOnce(
          response(["gpt-old", "gpt-kept", "gpt-off", "gpt-retired-off"]),
        )
        .mockResolvedValueOnce(response(["gpt-off", "gpt-kept", "gpt-new"]))
        .mockRejectedValue(new Error("同步失败"));
      const hook = renderHook(() =>
        useConnectionDiscovery(input, "auto", target),
      );
      await tick();
      act(() => {
        hook.result.current.selectDefault("gpt-old");
        hook.result.current.setContext("gpt-old", "1024");
        hook.result.current.setContext("gpt-kept", "512");
        hook.result.current.toggle("gpt-off", false);
        hook.result.current.toggle("gpt-retired-off", false);
      });
      await act(async () => {
        await hook.result.current.refresh();
      });
      expect(hook.result.current.models.map((m) => [m.id, m.enabled])).toEqual([
        ["gpt-off", false],
        ["gpt-kept", true],
        ["gpt-new", true],
      ]);
      expect(hook.result.current.model).toBe("gpt-kept");
      expect(Object.keys(hook.result.current.contexts).sort()).toEqual([
        "gpt-kept",
        "gpt-new",
        "gpt-off",
      ]);
      if (target === "codex") {
        expect(hook.result.current.contexts["gpt-kept"]).toBe("512");
        expect(hook.result.current.models[1].contextWindow).toBe(512000);
      }
      act(() => hook.result.current.selectDefault("gpt-old"));
      expect(hook.result.current.model).toBe("gpt-kept");
      const before = hook.result.current.models;
      await act(async () => {
        await hook.result.current.refresh();
      });
      expect(hook.result.current.models).toEqual(before);
      expect(hook.result.current.failure).toBe("同步失败");
    },
  );

  it("换站点后新的上游列表重新全选，迟到旧响应不串入模型", async () => {
    vi.useFakeTimers();
    let finish!: (value: ModelSyncResult) => void;
    vi.spyOn(api, "discoverConnection")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(response(["new-model-a", "new-model-b"]));
    const hook = renderHook(
      ({ baseUrl }) =>
        useConnectionDiscovery({ ...input, baseUrl }, "auto", "codex"),
      { initialProps: { baseUrl: input.baseUrl } },
    );
    await tick();
    hook.rerender({ baseUrl: "https://new.test/v1" });
    await tick();
    await act(async () => {
      finish(response(["old-model"]));
    });
    expect(
      hook.result.current.models.filter((m) => m.enabled).map((m) => m.id),
    ).toEqual(["new-model-a", "new-model-b"]);
  });
});
