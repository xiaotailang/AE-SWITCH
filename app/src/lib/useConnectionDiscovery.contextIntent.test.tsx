import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { useConnectionDiscovery } from "./useConnectionDiscovery";
import type { ModelSyncResult, Provider } from "../types";

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  desktopRuntime: true,
}));

const provider: Provider = {
  id: "context-owner",
  family: "codex",
  name: "Context owner",
  baseUrl: "https://context.test/v1",
  model: "gpt-a",
  authMode: "bearer",
  reasoningEffort: null,
  hasKey: true,
  keySuffix: "test",
  updatedAt: 1,
  codexOptions: {
    fastMode: null,
    contextWindow: 64000,
    autoCompactTokenLimit: 50000,
    models: [
      {
        id: "gpt-a",
        contextWindow: 256000,
        enabled: true,
        reasoningEfforts: [],
      },
      {
        id: "gpt-b",
        contextWindow: 512000,
        enabled: true,
        reasoningEfforts: [],
      },
    ],
    modelsSyncedAt: 1,
    balanceQuery: null,
  },
};
const connection = {
  providerId: provider.id,
  baseUrl: provider.baseUrl,
  apiKey: null,
};
const response: ModelSyncResult = {
  models: provider.codexOptions!.models.map((model) => ({
    ...model,
    contextWindow: null,
  })),
  protocol: "openai",
  authMode: "bearer",
  syncedAt: 2,
};
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const tick = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(650);
  });

describe("explicit context intent", () => {
  it("changing credentials resets context drafts on the same endpoint", async () => {
    vi.useFakeTimers();
    vi.spyOn(api, "discoverConnection").mockResolvedValue(response);
    const hook = renderHook(
      ({ apiKey }) =>
        useConnectionDiscovery(
          { ...connection, apiKey },
          "auto",
          "codex",
          provider,
        ),
      { initialProps: { apiKey: null as string | null } },
    );
    await tick();
    act(() => hook.result.current.setContext("gpt-a", "128"));
    expect(hook.result.current.editedContextModelIds).toEqual(["gpt-a"]);
    hook.rerender({ apiKey: "another-synthetic-key" });
    await tick();
    expect(hook.result.current.editedContextModelIds).toEqual([]);
    expect(
      hook.result.current.models.map((model) => model.contextWindow),
    ).toEqual([256000, 512000]);
  });
  it("refresh and ordinary model choices preserve per-model metadata without opting in", async () => {
    vi.useFakeTimers();
    vi.spyOn(api, "discoverConnection").mockResolvedValue(response);
    const hook = renderHook(() =>
      useConnectionDiscovery(connection, "auto", "codex", provider),
    );
    expect(
      hook.result.current.models.map((model) => model.contextWindow),
    ).toEqual([256000, 512000]);
    await tick();
    act(() => hook.result.current.selectDefault("gpt-b"));
    await act(async () => {
      await hook.result.current.refresh();
    });
    expect(
      hook.result.current.models.map((model) => model.contextWindow),
    ).toEqual([256000, 512000]);
    expect(hook.result.current.editedContextModelIds).toEqual([]);
  });

  it("tracks only changed enabled model inputs and clears reverted or invalid intent", async () => {
    vi.useFakeTimers();
    vi.spyOn(api, "discoverConnection").mockResolvedValue(response);
    const hook = renderHook(() =>
      useConnectionDiscovery(connection, "auto", "codex", provider),
    );
    await tick();
    act(() => hook.result.current.setContext("gpt-a", "128"));
    expect(hook.result.current.editedContextModelIds).toEqual(["gpt-a"]);
    expect(hook.result.current.models[1].contextWindow).toBe(512000);
    act(() => hook.result.current.setContext("gpt-a", "256.000"));
    expect(hook.result.current.editedContextModelIds).toEqual([]);
    act(() => hook.result.current.setContext("gpt-a", "invalid"));
    expect(hook.result.current.editedContextModelIds).toEqual([]);
    expect(hook.result.current.invalidContexts).toEqual(["gpt-a"]);
    act(() => hook.result.current.setContext("gpt-a", "128"));
    act(() => hook.result.current.toggle("gpt-a", false));
    expect(hook.result.current.editedContextModelIds).toEqual([]);
    expect(hook.result.current.models[0].contextWindow).toBe(256000);
    act(() => hook.result.current.setContext("gpt-a", "1024"));
    expect(hook.result.current.models[0].contextWindow).toBe(256000);
  });

  it("keeps edits during a same-connection refresh and discards them on connection changes", async () => {
    vi.useFakeTimers();
    let finish!: (value: ModelSyncResult) => void;
    vi.spyOn(api, "discoverConnection")
      .mockResolvedValueOnce(response)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(response);
    const hook = renderHook(
      ({ baseUrl }) =>
        useConnectionDiscovery(
          { ...connection, baseUrl },
          "auto",
          "codex",
          provider,
        ),
      { initialProps: { baseUrl: provider.baseUrl } },
    );
    await tick();
    let refresh!: ReturnType<typeof hook.result.current.refresh>;
    act(() => {
      refresh = hook.result.current.refresh();
    });
    act(() => hook.result.current.setContext("gpt-a", "128"));
    await act(async () => {
      finish(response);
      await refresh;
    });
    expect(hook.result.current.editedContextModelIds).toEqual(["gpt-a"]);
    expect(hook.result.current.models[0].contextWindow).toBe(128000);
    hook.rerender({ baseUrl: "https://other-context.test/v1" });
    expect(hook.result.current.editedContextModelIds).toEqual([]);
    await tick();
    expect(hook.result.current.editedContextModelIds).toEqual([]);
    expect(hook.result.current.models[0].contextWindow).toBe(256000);
  });
});
