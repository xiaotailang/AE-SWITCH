import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import AgentHub from "./AgentHub";
import { api } from "./lib/api";
import { agentApi } from "./lib/agentApi";

vi.mock("./components/WindowChrome", () => ({ WindowChrome: () => null }));
vi.mock("./lib/api", async (original) => ({
  ...(await original<typeof import("./lib/api")>()),
  desktopRuntime: false,
}));

afterEach(() => vi.restoreAllMocks());

it("浏览器预览明确缺少 Rust 内核，不生成模型或伪造配置与验证", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  vi.spyOn(api, "overview").mockResolvedValue({
    providers: [],
    targets: [],
    dataDirectory: "",
  });
  const discover = vi.spyOn(api, "discoverConnection");
  const save = vi.spyOn(api, "save");
  const configure = vi.spyOn(agentApi, "configure");
  const probe = vi.spyOn(agentApi, "probe");
  render(
    <QueryClientProvider client={client}>
      <AgentHub />
    </QueryClientProvider>,
  );
  expect(screen.getByRole("note")).toHaveTextContent(
    "浏览器界面预览，未连接 Rust 内核",
  );
  expect(screen.getByLabelText(/API 端点/)).toHaveValue(
    "https://aiease-yun.com",
  );
  await userEvent.clear(screen.getByLabelText(/API 端点/));
  await userEvent.type(
    screen.getByLabelText(/API 端点/),
    "https://gateway.example/v1",
  );
  await userEvent.type(
    screen.getByLabelText("API Key", { exact: true }),
    "sk-preview-key",
  );
  expect(screen.getByRole("button", { name: "确认连接" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "重新验证工具" }),
  ).not.toBeVisible();
  await userEvent.click(
    screen.getByText("客户端操作", { selector: "summary" }),
  );
  expect(screen.getByRole("button", { name: "重新验证工具" })).toBeDisabled();
  expect(screen.getByRole("combobox", { name: "默认模型" })).toBeDisabled();
  expect(screen.queryByText("工具写读验证通过")).toBeNull();
  expect(discover).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  expect(configure).not.toHaveBeenCalled();
  expect(probe).not.toHaveBeenCalled();
  client.clear();
});
