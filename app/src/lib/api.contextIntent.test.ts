import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import type { ProviderInput } from "../types";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));
afterEach(() => localStorage.clear());

const input: ProviderInput = {
  id: null,
  family: "codex",
  name: "Context preview",
  baseUrl: "https://context.test/v1",
  apiKey: "synthetic-preview-key",
  model: "gpt-a",
  authMode: "bearer",
  reasoningEffort: null,
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
    ],
    modelsSyncedAt: 1,
    balanceQuery: null,
  },
};

describe("preview context intent matches desktop contract", () => {
  it("model metadata changes alone retain global values until a user edit is declared", async () => {
    const saved = await api.save(input);
    const models = [
      { ...saved.codexOptions!.models[0], contextWindow: 128000 },
    ];
    const ordinary = await api.quickModels({
      expected: saved,
      target: "codex",
      model: saved.model,
      models,
    });
    expect(ordinary.provider.codexOptions).toMatchObject({
      contextWindow: 64000,
      autoCompactTokenLimit: 50000,
    });
    expect(ordinary.provider.codexOptions!.perModelContext).not.toBe(true);
    const edited = await api.quickModels({
      expected: ordinary.provider,
      target: "codex",
      model: saved.model,
      models,
      editedContextModelIds: ["gpt-a"],
    });
    expect(edited.provider.codexOptions).toMatchObject({
      perModelContext: true,
      contextWindow: null,
      autoCompactTokenLimit: 50000,
    });
    expect((await api.overview()).providers[0].codexOptions).toMatchObject({
      perModelContext: true,
      autoCompactTokenLimit: 50000,
    });
  });

  it("save-only persists an explicit choice and ordinary later saves retain it", async () => {
    const saved = await api.save({
      ...input,
      editedContextModelIds: ["gpt-a"],
      codexOptions: {
        ...input.codexOptions!,
        models: [{ ...input.codexOptions!.models[0], contextWindow: 128000 }],
      },
    });
    expect(saved.codexOptions).toMatchObject({
      perModelContext: true,
      contextWindow: null,
      autoCompactTokenLimit: 50000,
    });
    expect(
      (await api.overview()).targets.every(
        (target) => target.activeProviderId === null,
      ),
    ).toBe(true);
    const again = await api.save({
      ...input,
      id: saved.id,
      apiKey: null,
      codexOptions: saved.codexOptions,
    });
    expect(again.codexOptions).toEqual(saved.codexOptions);
  });
});
