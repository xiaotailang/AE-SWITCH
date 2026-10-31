import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { configurationSafetyApi } from "./configurationSafetyApi";
const runtime = vi.hoisted(() => ({ desktop: true }));
vi.mock("./api", () => ({
  get desktopRuntime() {
    return runtime.desktop;
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => {
  runtime.desktop = true;
  vi.resetAllMocks();
});

it("passes only the chosen client and server-issued preview token", async () => {
  vi.mocked(invoke).mockResolvedValue({ status: "healthy" });
  await configurationSafetyApi.inspect("codex");
  expect(invoke).toHaveBeenLastCalledWith("agent_configuration_safety", {
    agentId: "codex",
  });
  await configurationSafetyApi.disconnect("codex", "server-preview");
  expect(invoke).toHaveBeenLastCalledWith("disconnect_agent", {
    agentId: "codex",
    previewToken: "server-preview",
  });
});

it("never simulates a successful check or restore in browser preview", async () => {
  runtime.desktop = false;
  await expect(configurationSafetyApi.inspect("codex")).rejects.toThrow(
    "桌面应用",
  );
  await expect(
    configurationSafetyApi.disconnect("codex", "preview"),
  ).rejects.toThrow("桌面应用");
  expect(invoke).not.toHaveBeenCalled();
});
