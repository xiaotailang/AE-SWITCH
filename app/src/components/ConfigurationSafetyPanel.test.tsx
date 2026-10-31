import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConfigurationSafetyPanel } from "./ConfigurationSafetyPanel";
import {
  configurationSafetyApi,
  type ConfigurationSafety,
} from "../lib/configurationSafetyApi";
const runtime = vi.hoisted(() => ({ desktop: true }));
vi.mock("../lib/api", () => ({
  get desktopRuntime() {
    return runtime.desktop;
  },
  errorMessage: (error: unknown) =>
    error instanceof Error ? error.message : "检查失败",
}));
vi.mock("../lib/configurationSafetyApi", () => ({
  configurationSafetyApi: { inspect: vi.fn(), disconnect: vi.fn() },
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  runtime.desktop = true;
});
const healthy: ConfigurationSafety = {
  status: "healthy",
  canDisconnect: true,
  previewToken: "fresh-preview",
  files: [{ slot: "config", managedFields: 4, changedFields: 0 }],
};
function setup(
  props: Partial<Parameters<typeof ConfigurationSafetyPanel>[0]> = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <ConfigurationSafetyPanel agentId="codex" configured {...props} />
    </QueryClientProvider>,
  );
}

it("checks only on opening and requires a fresh preview before restoring", async () => {
  vi.mocked(configurationSafetyApi.inspect).mockResolvedValue(healthy);
  vi.mocked(configurationSafetyApi.disconnect).mockResolvedValue();
  const onChanged = vi.fn();
  const onBusyChange = vi.fn();
  setup({ onChanged, onBusyChange });
  expect(configurationSafetyApi.inspect).not.toHaveBeenCalled();
  await userEvent.click(screen.getByText("配置保护与安全断开"));
  await screen.findByText("AE 管理的连接字段与最近写入一致。");
  expect(
    screen.queryByRole("button", { name: "恢复原配置并断开" }),
  ).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "预览断开" }));
  expect(await screen.findByText("主配置：4 个字段")).toBeInTheDocument();
  expect(configurationSafetyApi.inspect).toHaveBeenCalledTimes(2);
  expect(configurationSafetyApi.disconnect).not.toHaveBeenCalled();
  await userEvent.click(
    screen.getByRole("button", { name: "恢复原配置并断开" }),
  );
  await waitFor(() =>
    expect(configurationSafetyApi.disconnect).toHaveBeenCalledExactlyOnceWith(
      "codex",
      "fresh-preview",
    ),
  );
  await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  expect(onBusyChange.mock.calls).toEqual([[true], [false], [true], [false]]);
  expect(
    await screen.findByText("已恢复 AE 管理的原配置并断开。"),
  ).toBeInTheDocument();
});

it("blocks restoring a drifted configuration and displays no raw values", async () => {
  vi.mocked(configurationSafetyApi.inspect).mockResolvedValue({
    ...healthy,
    status: "drifted",
    canDisconnect: false,
    previewToken: null,
    files: [{ slot: "config", managedFields: 4, changedFields: 1 }],
  });
  setup();
  await userEvent.click(screen.getByText("配置保护与安全断开"));
  expect(await screen.findByText(/检测到连接配置已被/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "预览断开" })).toBeDisabled();
  expect(configurationSafetyApi.disconnect).not.toHaveBeenCalled();
});

it("drops the preview after a concurrent-change rejection", async () => {
  vi.mocked(configurationSafetyApi.inspect).mockResolvedValue(healthy);
  vi.mocked(configurationSafetyApi.disconnect).mockRejectedValue(
    new Error("配置发生变化，未覆盖修改"),
  );
  setup();
  await userEvent.click(screen.getByText("配置保护与安全断开"));
  await screen.findByText("AE 管理的连接字段与最近写入一致。");
  await userEvent.click(screen.getByRole("button", { name: "预览断开" }));
  await userEvent.click(
    await screen.findByRole("button", { name: "恢复原配置并断开" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("配置发生变化");
  expect(screen.queryByLabelText("断开预览")).not.toBeInTheDocument();
});

it("cannot start a write while the parent holds the configuration lock", async () => {
  setup({ disabled: true });
  await userEvent.click(screen.getByText("配置保护与安全断开"));
  expect(screen.getByRole("button", { name: "检查配置" })).toBeDisabled();
  expect(configurationSafetyApi.inspect).not.toHaveBeenCalled();
});

it("explains the legacy boundary without inventing a restore baseline", async () => {
  vi.mocked(configurationSafetyApi.inspect).mockResolvedValue({
    status: "untracked",
    canDisconnect: false,
    previewToken: null,
    files: [],
  });
  setup();
  await userEvent.click(screen.getByText("配置保护与安全断开"));
  expect(
    await screen.findByText(/已有连接无法追溯更早的原值/),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "预览断开" })).toBeDisabled();
});

it("does not query real files in the browser preview", async () => {
  runtime.desktop = false;
  setup();
  await userEvent.click(screen.getByText("配置保护与安全断开"));
  expect(
    screen.getByText(/请在 AE Switch 桌面应用中检查真实配置/),
  ).toBeInTheDocument();
  expect(configurationSafetyApi.inspect).not.toHaveBeenCalled();
});
