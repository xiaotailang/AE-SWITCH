import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RequestActivityPanel } from "./RequestActivityPanel";
import { agentApi, type ActivitySnapshot } from "../lib/agentApi";

const runtime = vi.hoisted(() => ({ desktop: true }));
vi.mock("../lib/api", () => ({
  get desktopRuntime() {
    return runtime.desktop;
  },
  errorMessage: (error: unknown) =>
    error instanceof Error ? error.message : "读取失败",
}));
vi.mock("../lib/agentApi", () => ({
  agentApi: { activity: vi.fn(), clearActivity: vi.fn() },
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  runtime.desktop = true;
});
const snapshot: ActivitySnapshot = {
  capacity: 200,
  records: [
    {
      id: "request",
      agentId: "codex",
      startedAt: 1_800_000_000_000,
      model: "selected-model",
      endpoint: "responses",
      upstreamProtocol: "openai",
      streaming: true,
      state: "failed",
      status: 200,
      elapsedMs: 135,
      firstByteMs: 32,
      responseBytes: 250,
      usage: {
        inputTokens: 0,
        outputTokens: 7,
        cachedTokens: null,
        reasoningTokens: null,
      },
    },
  ],
};
function setup(agentId: "codex" | "zcode" = "codex") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <RequestActivityPanel
        agentId={agentId}
        agentName={agentId === "codex" ? "Codex" : "Z Code"}
      />
    </QueryClientProvider>,
  );
}
describe("请求活动", () => {
  it("折叠时不读取，展开后区分 HTTP 成功和实际响应失败并保留零用量", async () => {
    vi.mocked(agentApi.activity).mockResolvedValue(snapshot);
    setup();
    expect(agentApi.activity).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText("请求活动"));
    expect(await screen.findByText("selected-model")).toBeInTheDocument();
    expect(screen.getByText("失败 · HTTP 200")).toBeInTheDocument();
    expect(
      screen.getByText("输入 0 / 输出 7 token · 缓存读取 — · 思考 —"),
    ).toBeInTheDocument();
    expect(agentApi.activity).toHaveBeenCalledWith("codex");
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    expect(screen.getByRole("list", { name: "最近请求记录" })).toHaveFocus();
  });
  it("只清空当前客户端，完成后显示服务端返回的空状态", async () => {
    vi.mocked(agentApi.activity)
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValue({ capacity: 200, records: [] });
    vi.mocked(agentApi.clearActivity).mockResolvedValue({
      capacity: 200,
      records: [],
    });
    setup();
    await userEvent.click(screen.getByText("请求活动"));
    await screen.findByText("selected-model");
    await userEvent.click(
      screen.getByRole("button", { name: "清空当前客户端记录" }),
    );
    await waitFor(() =>
      expect(agentApi.clearActivity).toHaveBeenCalledWith("codex"),
    );
    expect(await screen.findByText(/暂无请求/)).toBeInTheDocument();
    expect(screen.queryByText("selected-model")).not.toBeInTheDocument();
  });
  it("读取失败明确报错，不伪造空活动或成功", async () => {
    vi.mocked(agentApi.activity).mockRejectedValue(new Error("本地网关未运行"));
    setup("zcode");
    await userEvent.click(screen.getByText("请求活动"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "本地网关未运行",
    );
    expect(screen.queryByText(/暂无请求/)).not.toBeInTheDocument();
  });
  it("浏览器预览不请求本地网关", async () => {
    runtime.desktop = false;
    setup();
    await userEvent.click(screen.getByText("请求活动"));
    expect(
      await screen.findByText("请在 AE Switch 桌面应用中查看真实请求。"),
    ).toBeInTheDocument();
    expect(agentApi.activity).not.toHaveBeenCalled();
  });
});
