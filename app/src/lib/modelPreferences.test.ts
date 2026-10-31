import { beforeEach, describe, expect, it } from "vitest";
import {
  loadModelPreferences,
  rememberModelUse,
  toggleFavoriteModel,
} from "./modelPreferences";

beforeEach(() => localStorage.clear());
describe("model preferences", () => {
  it("isolates clients and saved connections without storing endpoint or credentials", () => {
    toggleFavoriteModel("codex", "provider-a", "model-a");
    rememberModelUse("codex", "provider-a", "model-a", 100);
    expect(loadModelPreferences("codex", "provider-a")).toEqual({
      favorites: ["model-a"],
      recent: { "model-a": 100 },
    });
    expect(loadModelPreferences("workbuddy", "provider-a")).toEqual({
      favorites: [],
      recent: {},
    });
    expect(loadModelPreferences("codex", "provider-b")).toEqual({
      favorites: [],
      recent: {},
    });
    expect(JSON.stringify(localStorage)).not.toContain("https:");
  });
  it("ignores unsaved connections and invalid storage while preserving prototype-like IDs", () => {
    rememberModelUse("codex", "", "model", 100);
    toggleFavoriteModel("codex", "", "model");
    expect(localStorage.length).toBe(0);
    localStorage.setItem("ae-switch-model-preferences-v1", "bad-json");
    expect(loadModelPreferences("codex", "a")).toEqual({
      favorites: [],
      recent: {},
    });
    rememberModelUse("codex", "a", "__proto__", 100);
    rememberModelUse("codex", "a", "constructor", 200);
    const recent = loadModelPreferences("codex", "a").recent;
    expect(Object.hasOwn(recent, "__proto__")).toBe(true);
    expect(recent.__proto__).toBe(100);
    expect(recent.constructor).toBe(200);
  });
  it("bounds retained favorites and recent selections", () => {
    for (let i = 0; i < 205; i++) {
      toggleFavoriteModel("codex", "a", `model-${i}`);
      rememberModelUse("codex", "a", `model-${i}`, i + 1);
    }
    const preferences = loadModelPreferences("codex", "a");
    expect(preferences.favorites).toHaveLength(200);
    expect(Object.keys(preferences.recent)).toHaveLength(200);
    expect(preferences.recent["model-0"]).toBeUndefined();
  });
});
