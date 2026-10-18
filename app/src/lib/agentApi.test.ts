import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { agentApi } from "./agentApi";
const runtime = vi.hoisted(() => ({ desktop: false }));
vi.mock("./api", () => ({
  get desktopRuntime() {
    return runtime.desktop;
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => {
  runtime.desktop = false;
  vi.mocked(invoke).mockReset();
});
describe("浏览器预览边界", () => {
  it("没有虚假的已配置 Agent 或运行中的桥接服务", async () => {
    const overview = await agentApi.overview();
    expect(overview.agents).toHaveLength(8);
    expect(overview.agents.some((agent) => agent.id === "workbuddy")).toBe(
      true,
    );
    expect(
      overview.agents.find((agent) => agent.id === "deepseek_harness"),
    ).toMatchObject({
      name: "DeepSeek Harness",
      protocol: "openai",
    });
    expect(
      overview.agents.every((agent) => !agent.configured && !agent.launcher),
    ).toBe(true);
    expect(overview.bridgeHealthy).toBe(false);
    expect(overview.dataDirectory).toContain("未连接 Rust 内核");
  });
  it("浏览器不能伪造配置、推理验收或启动成功", async () => {
    const input = { agentId: "codex" as const, providerId: "preview" };
    for (const action of [
      () => agentApi.configure(input),
      () => agentApi.probe(input),
      () => agentApi.launch("codex"),
      () => agentApi.applyWorkBuddyDefault(),
      () => agentApi.openDirectory(),
      () => agentApi.discover(),
      () => agentApi.discoverDirectory("zcode", "G:/tools/ZCode"),
      () => agentApi.pickDirectory(),
      () => agentApi.runtime("codex"),
      () =>
        agentApi.restart({
          agentId: "codex",
          configurationRevision: 1,
          processId: 7,
          startTimeMs: 123,
        }),
    ]) {
      await expect(action()).rejects.toThrow("浏览器仅用于界面预览");
    }
  });
});
describe("安装目录识别", () => {
  it("只传工具和安装目录，不把安装目录当成用户配置", async () => {
    runtime.desktop = true;
    const result = { clients: [], scannedAt: "now", limited: false, notes: [] };
    vi.mocked(invoke).mockResolvedValue(result);
    await expect(
      agentApi.discoverDirectory("zcode", "G:/tools/ZCode"),
    ).resolves.toEqual(result);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      "agent_hub_discover_directory",
      {
        agentId: "zcode",
        directory: "G:/tools/ZCode",
      },
    );
  });
  it("原生选择目录取消时保留 null", async () => {
    runtime.desktop = true;
    vi.mocked(invoke).mockResolvedValue(null);
    await expect(agentApi.pickDirectory()).resolves.toBeNull();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("agent_hub_pick_directory");
  });
});
describe("WorkBuddy 默认模型原生操作", () => {
  it("只向后端请求应用已保存的原配置，并保留待应用结果", async () => {
    runtime.desktop = true;
    const result = {
      selected: false,
      status: "pending_draft",
      model: "gpt-test",
      message: "首页存在草稿，请处理草稿后重试。",
    };
    vi.mocked(invoke).mockResolvedValue(result);
    await expect(agentApi.applyWorkBuddyDefault()).resolves.toEqual(result);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      "apply_workbuddy_default_model",
    );
  });
});
