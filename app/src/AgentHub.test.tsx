import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentHub from "./AgentHub";
import { api } from "./lib/api";
import * as projectLinks from "./lib/projectLinks";
import {
  agentApi,
  agentCatalog,
  type AgentId,
  type ExistingProfile,
  type InstalledAgentDiscovery,
  type ExistingRuntime,
  type WorkBuddyDefaultSelection,
} from "./lib/agentApi";
import type { Provider } from "./types";
import { configurationSafetyApi } from "./lib/configurationSafetyApi";
import { configProfilesApi } from "./lib/configProfilesApi";
import { loadModelPreferences } from "./lib/modelPreferences";

vi.mock("./components/WindowChrome", () => ({ WindowChrome: () => null }));
vi.mock("./lib/api", async (original) => ({
  ...(await original<typeof import("./lib/api")>()),
  desktopRuntime: true,
}));

const provider: Provider = {
  id: "provider-one",
  family: "codex",
  name: "Local test provider",
  baseUrl: "https://gateway.example/v1",
  model: "gpt-test",
  authMode: "bearer",
  hasKey: true,
  keySuffix: "1234",
  updatedAt: 1,
  reasoningEffort: null,
  codexOptions: {
    fastMode: null,
    contextWindow: null,
    autoCompactTokenLimit: null,
    balanceQuery: null,
    modelsSyncedAt: 1,
    upstreamProtocol: "openai",
    models: [
      {
        id: "gpt-test",
        enabled: true,
        contextWindow: 128000,
        reasoningEfforts: [],
      },
    ],
  },
};
let client: QueryClient;
let configured = false;
let configuredAgent: AgentId = "claude_code";
function installedProfile(id: AgentId, suffix = ""): ExistingProfile {
  return {
    directory: `G:/test-installed/${id}${suffix}/profile`,
    homeDirectory: `G:/test-installed/${id}${suffix}/home`,
    executablePath: `G:/test-installed/${id}${suffix}/client.exe`,
    workspaceDirectory: `G:/test-installed/${id}${suffix}/workspace`,
  };
}
beforeEach(() => {
  localStorage.clear();
  configured = false;
  configuredAgent = "claude_code";
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  vi.spyOn(agentApi, "discover").mockResolvedValue({
    clients: agentCatalog.map(({ id }) => ({
      agentId: id,
      executablePath: installedProfile(id).executablePath,
      profiles: [installedProfile(id)],
      source: "PATH",
      reason: null,
    })),
    scannedAt: "2026-10-10T03:00:00Z",
    limited: false,
    notes: [],
  });
  vi.spyOn(agentApi, "discoverDirectory").mockResolvedValue({
    clients: [],
    scannedAt: "now",
    limited: false,
    notes: [],
  });
  vi.spyOn(agentApi, "pickDirectory").mockResolvedValue(null);
  vi.spyOn(api, "overview").mockResolvedValue({
    providers: [provider],
    targets: [],
    dataDirectory: "./data",
  });
  vi.spyOn(agentApi, "overview").mockImplementation(async () => ({
    agents: agentCatalog.map((item) =>
      item.id === configuredAgent
        ? {
            ...item,
            configured,
            launcher: configured ? "./launch.cmd" : null,
            providerId: configured ? provider.id : null,
            model: configured ? provider.model : null,
          }
        : item,
    ),
    dataDirectory: "./data",
    bridgeHealthy: false,
  }));
  vi.spyOn(api, "discoverConnection").mockResolvedValue({
    models: provider.codexOptions!.models,
    protocol: "openai",
    authMode: "bearer",
    syncedAt: 2,
    baseUrl: provider.baseUrl,
  });
  vi.spyOn(api, "save").mockResolvedValue(provider);
  vi.spyOn(agentApi, "configure").mockImplementation(async () => {
    configured = true;
    return {
      ...agentCatalog.find((item) => item.id === configuredAgent)!,
      configured: true,
      launcher: "./launch.cmd",
      providerId: provider.id,
      model: provider.model,
    };
  });
  vi.spyOn(agentApi, "probe").mockResolvedValue({
    ok: true,
    model: "gpt-test",
    latencyMs: 321,
    message: "real tool wrote and read back the verification file",
    validationScope: "tool",
    toolVerified: true,
    stage: "verified",
    evidence: { written: "test-token", readback: "test-token" },
    cleanup: { scope: "owned-uuid-verification-directory", succeeded: true },
  });
  vi.spyOn(agentApi, "launch").mockResolvedValue();
  vi.spyOn(agentApi, "applyWorkBuddyDefault").mockResolvedValue({
    selected: true,
    status: "selected",
    model: provider.model!,
    message: "已确认 WorkBuddy 新任务首页的模型选择。",
  });
  vi.spyOn(api, "background").mockResolvedValue({
    supported: true,
    enabled: false,
  });
  vi.spyOn(api, "setBackground").mockResolvedValue({
    supported: true,
    enabled: true,
  });
  vi.spyOn(api, "openProjectPage").mockResolvedValue();
  vi.spyOn(agentApi, "runtime").mockResolvedValue({
    agentId: "claude_code",
    configurationRevision: 7,
    appliedAtMs: 100,
    platformSupported: true,
    running: true,
    restartRequired: true,
    canRestart: true,
    restartInProgress: false,
    candidates: [],
  });
  vi.spyOn(agentApi, "restart").mockResolvedValue({
    restarted: false,
    pending: true,
    message: "请在原终端正常退出，随后自动重新打开；历史文件保持原样。",
  });
});
afterEach(() => {
  vi.useRealTimers();
  client.clear();
  vi.restoreAllMocks();
});
async function mount(expandDetails = true) {
  render(
    <QueryClientProvider client={client}>
      <AgentHub />
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(client.getQueryState(["installed-agents"])?.fetchStatus).toBe(
      "idle",
    ),
  );
  if (expandDetails) {
    for (const selector of [
      ".hub-extra-settings",
      ".hub-profile-settings",
      ".hub-client-actions",
    ]) {
      const details = document.querySelector<HTMLDetailsElement>(selector)!;
      if (!details.open)
        await userEvent.click(details.querySelector("summary")!);
    }
  }
}
async function enterConnection() {
  await userEvent.clear(screen.getByLabelText(/API 端点/));
  await userEvent.type(screen.getByLabelText(/API 端点/), provider.baseUrl);
  await userEvent.type(
    screen.getByLabelText("API Key", { exact: true }),
    "sk-test-1234",
  );
  await waitFor(
    () =>
      expect(screen.getByRole("combobox", { name: "默认模型" })).toHaveValue(
        "gpt-test",
      ),
    { timeout: 3000 },
  );
}
async function enterAdvancedPaths() {
  await userEvent.click(
    screen.getByText("高级路径设置", { selector: "summary" }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "手动设置完整路径" }),
  );
}
function installationResult(
  profiles: ExistingProfile[],
  agentId: AgentId = "claude_code",
): InstalledAgentDiscovery {
  return {
    clients: profiles.length
      ? [
          {
            agentId,
            executablePath: profiles[0].executablePath,
            profiles,
            source: "selected-directory",
            reason: null,
          },
        ]
      : [],
    scannedAt: "now",
    limited: false,
    notes: [],
  };
}
async function specifyInstallation(directory: string) {
  await userEvent.click(screen.getByRole("button", { name: "指定安装目录" }));
  fireEvent.change(screen.getByLabelText("安装目录", { exact: true }), {
    target: { value: directory },
  });
}
describe("Agent Hub 真实状态与配置流程", () => {
  it("保存新连接及延迟同步模型后保留选定等级和验证结果", async () => {
    const models = [
      {
        ...provider.codexOptions!.models[0],
        reasoningEfforts: ["low", "high"],
      },
    ];
    let savedProvider = {
      ...provider,
      codexOptions: { ...provider.codexOptions!, models },
    };
    vi.mocked(api.overview).mockImplementation(async () => ({
      providers: [savedProvider],
      targets: [],
      dataDirectory: "./data",
    }));
    vi.mocked(api.save).mockImplementation(async (input) => {
      savedProvider = {
        ...savedProvider,
        reasoningEffort: input.reasoningEffort,
      };
      return savedProvider;
    });
    vi.mocked(api.discoverConnection).mockResolvedValue({
      models,
      protocol: "openai",
      authMode: "bearer",
      syncedAt: 2,
      baseUrl: provider.baseUrl,
    });
    await mount();
    await enterConnection();
    await userEvent.click(screen.getByRole("radio", { name: "高（high）" }));
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    await screen.findByText("工具写读验证通过");
    await waitFor(
      () => expect(api.discoverConnection).toHaveBeenCalledTimes(2),
      { timeout: 3000 },
    );
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "高（high）" })).toBeChecked(),
    );
    expect(screen.getByText("工具写读验证通过")).toBeVisible();
    expect(api.save).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: "high" }),
    );
  });

  it("ZCode内置命令行验证失败与桌面接入状态明确区分", async () => {
    vi.mocked(agentApi.probe).mockResolvedValue({
      ok: false,
      model: "gpt-test",
      latencyMs: 3,
      message: "ZCode 自动验证进程退出，尚未完成文件写读。",
      validationScope: "tool",
      toolVerified: false,
      stage: "process",
      clientSurface: "desktop-bundled-cli",
      diagnostic: "provider_rejected\n命令行进程退出码：1",
      desktopGuiVerified: false,
      cleanup: { succeeded: true },
    });
    await mount();
    await enterConnection();
    await userEvent.click(
      screen.getByRole("button", { name: /Z Code 官方图标/ }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "确认连接" })).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    await screen.findByText("自动文件验证未通过");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "配置已写入，自动文件验证未通过",
    );
    expect(
      screen.getByText(
        /此结果仅表示自动文件验证未通过，不代表桌面客户端不可用/,
      ),
    ).toBeVisible();
    expect(screen.getByText("验证阶段：运行自动验证命令")).toBeVisible();
    expect(screen.queryByText("工具写读验证通过")).toBeNull();
    await userEvent.click(
      screen.getByText("查看验证原因", { selector: "summary" }),
    );
    expect(screen.getByText(/provider_rejected/)).toBeVisible();
  });

  it("根据真实模型能力显示思考选项并将选择保存到连接", async () => {
    vi.mocked(api.discoverConnection).mockResolvedValue({
      models: [
        {
          ...provider.codexOptions!.models[0],
          reasoningEfforts: ["low", "high", "xhigh", "unsupported"],
        },
      ],
      protocol: "openai",
      authMode: "bearer",
      syncedAt: 2,
      baseUrl: provider.baseUrl,
    });
    await mount();
    await enterConnection();
    const options = screen.getByRole("group", { name: "思考程度" });
    expect(within(options).getAllByRole("radio")).toHaveLength(4);
    expect(within(options).getByRole("radio", { name: "默认" })).toBeChecked();
    await userEvent.click(
      within(options).getByRole("radio", { name: "更高（xhigh）" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith(
        expect.objectContaining({ reasoningEffort: "xhigh" }),
      ),
    );
    expect(agentApi.configure).toHaveBeenCalledOnce();
  });

  it("未返回思考等级清单时允许兼容选项且不伪造模型能力", async () => {
    await mount();
    await enterConnection();
    expect(screen.getAllByRole("radio")).toHaveLength(9);
    expect(
      screen.getByText(
        /端点未提供等级清单，以下为兼容选项，不代表已确认全部支持/,
      ),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("radio", { name: "高（high）" }));
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith(
        expect.objectContaining({
          reasoningEffort: "high",
          codexOptions: expect.objectContaining({
            models: [expect.objectContaining({ reasoningEfforts: [] })],
          }),
        }),
      ),
    );
    expect(agentApi.configure).toHaveBeenCalledOnce();
    expect(agentApi.probe).toHaveBeenCalledOnce();
  });

  it("原生Anthropic连接保持默认且不提供OpenAI兼容档位", async () => {
    await mount();
    await enterConnection();
    vi.mocked(api.discoverConnection).mockResolvedValue({
      models: [
        {
          ...provider.codexOptions!.models[0],
          reasoningEfforts: ["low", "high"],
        },
      ],
      protocol: "anthropic",
      authMode: "x-api-key",
      syncedAt: 3,
      baseUrl: provider.baseUrl,
    });
    await userEvent.click(screen.getByRole("button", { name: "同步模型" }));
    await screen.findByText(
      "此连接暂不支持在 AE Switch 中设置思考等级，使用客户端或供应商的默认设置。",
    );
    expect(screen.getAllByRole("radio")).toHaveLength(1);
  });

  it("未知能力后收到明确等级清单时移除未声明的兼容选项", async () => {
    await mount();
    await enterConnection();
    await userEvent.click(screen.getByRole("radio", { name: "更高（xhigh）" }));
    vi.mocked(api.discoverConnection).mockResolvedValue({
      models: [
        {
          ...provider.codexOptions!.models[0],
          reasoningEfforts: ["low", "high"],
        },
      ],
      protocol: "openai",
      authMode: "bearer",
      syncedAt: 3,
      baseUrl: provider.baseUrl,
    });
    await userEvent.click(screen.getByRole("button", { name: "同步模型" }));
    await waitFor(() =>
      expect(screen.queryByRole("radio", { name: "更高（xhigh）" })).toBeNull(),
    );
    expect(screen.getByRole("radio", { name: "默认" })).toBeChecked();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith(
        expect.objectContaining({ reasoningEffort: null }),
      ),
    );
  });

  it("切换模型后清除思考档位和上一次验证结果", async () => {
    const models = [
      {
        ...provider.codexOptions!.models[0],
        reasoningEfforts: ["low", "high"],
      },
      {
        id: "other-model",
        enabled: true,
        contextWindow: null,
        reasoningEfforts: ["medium"],
      },
    ];
    const savedProvider = {
      ...provider,
      codexOptions: { ...provider.codexOptions!, models },
    };
    vi.mocked(api.overview).mockResolvedValue({
      providers: [savedProvider],
      targets: [],
      dataDirectory: "./data",
    });
    vi.mocked(api.save).mockResolvedValue(savedProvider);
    vi.mocked(api.discoverConnection).mockResolvedValue({
      models,
      protocol: "openai",
      authMode: "bearer",
      syncedAt: 2,
      baseUrl: provider.baseUrl,
    });
    await mount();
    await enterConnection();
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    await screen.findByText("工具写读验证通过");
    await userEvent.click(
      await screen.findByRole("radio", { name: "高（high）" }),
    );
    expect(screen.queryByText("工具写读验证通过")).toBeNull();
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "默认模型" }),
      "other-model",
    );
    expect(screen.getByRole("radio", { name: "默认" })).toBeChecked();
    expect(screen.queryByRole("radio", { name: "高（high）" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    await waitFor(() =>
      expect(api.save).toHaveBeenLastCalledWith(
        expect.objectContaining({
          model: "other-model",
          reasoningEffort: null,
        }),
      ),
    );
  });

  it("已保存档位可恢复，选择默认会明确移除AE覆盖", async () => {
    const savedProvider: Provider = {
      ...provider,
      reasoningEffort: "high",
      codexOptions: {
        ...provider.codexOptions!,
        models: [
          {
            ...provider.codexOptions!.models[0],
            reasoningEfforts: ["low", "high"],
          },
        ],
      },
    };
    vi.mocked(api.overview).mockResolvedValue({
      providers: [savedProvider],
      targets: [],
      dataDirectory: "./data",
    });
    vi.mocked(api.discoverConnection).mockResolvedValue({
      models: savedProvider.codexOptions!.models,
      protocol: "openai",
      authMode: "bearer",
      syncedAt: 2,
      baseUrl: provider.baseUrl,
    });
    await mount();
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "供应商配置" }),
      savedProvider.id,
    );
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "高（high）" })).toBeChecked(),
    );
    await userEvent.click(screen.getByRole("radio", { name: "默认" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "确认连接" })).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith(
        expect.objectContaining({ reasoningEffort: null }),
      ),
    );
  });

  it("同步后模型移除等级时清除旧选择", async () => {
    vi.mocked(api.discoverConnection).mockResolvedValue({
      models: [
        {
          ...provider.codexOptions!.models[0],
          reasoningEfforts: ["low", "high"],
        },
      ],
      protocol: "openai",
      authMode: "bearer",
      syncedAt: 2,
      baseUrl: provider.baseUrl,
    });
    await mount();
    await enterConnection();
    await userEvent.click(screen.getByRole("radio", { name: "高（high）" }));
    vi.mocked(api.discoverConnection).mockResolvedValue({
      models: [
        { ...provider.codexOptions!.models[0], reasoningEfforts: ["low"] },
      ],
      protocol: "openai",
      authMode: "bearer",
      syncedAt: 3,
      baseUrl: provider.baseUrl,
    });
    await userEvent.click(screen.getByRole("button", { name: "同步模型" }));
    await waitFor(() =>
      expect(screen.queryByRole("radio", { name: "高（high）" })).toBeNull(),
    );
    expect(screen.getByRole("radio", { name: "默认" })).toBeChecked();
  });

  function workBuddyFixture(defaultSelection?: WorkBuddyDefaultSelection) {
    configuredAgent = "workbuddy";
    const profile = {
      ...installedProfile("workbuddy"),
      executablePath: "G:/test-installed/workbuddy/application/WorkBuddy.exe",
    };
    const existingAgent = () => ({
      ...agentCatalog.find((item) => item.id === "workbuddy")!,
      configured,
      mode: "existing" as const,
      profile,
      directory: profile.directory,
      launcher: configured ? profile.executablePath : null,
      providerId: configured ? provider.id : null,
      model: configured ? provider.model : null,
      canLaunch: configured,
    });
    vi.mocked(agentApi.discover).mockResolvedValue({
      clients: [
        {
          agentId: "workbuddy",
          executablePath: profile.executablePath,
          profiles: [profile],
          source: "PATH",
          reason: null,
        },
      ],
      scannedAt: "2026-10-12T03:00:00Z",
      limited: false,
      notes: [],
    });
    vi.mocked(agentApi.overview).mockImplementation(async () => ({
      agents: agentCatalog.map((item) =>
        item.id === "workbuddy" ? existingAgent() : item,
      ),
      dataDirectory: "G:/portable/data",
      bridgeHealthy: true,
    }));
    vi.mocked(agentApi.configure).mockImplementation(async () => {
      configured = true;
      return {
        ...existingAgent(),
        workBuddyDefaultSelection: defaultSelection,
      };
    });
    vi.mocked(agentApi.probe).mockResolvedValue({
      ok: true,
      model: provider.model!,
      latencyMs: 40,
      message: "供应商连接可用；桌面文件工具需独立验证。",
      validationScope: "connection",
      toolVerified: false,
      stage: "connection",
    });
  }
  async function selectWorkBuddy() {
    await userEvent.click(
      within(screen.getByRole("navigation", { name: "选择 Agent" })).getByRole(
        "button",
        { name: /WorkBuddy/ },
      ),
    );
  }
  it("WorkBuddy 配置返回首页选择证明后，在折叠操作区外显示结果且保留连接验证边界", async () => {
    workBuddyFixture({
      selected: true,
      status: "selected",
      model: provider.model!,
      message: "已确认 WorkBuddy 新任务首页的模型选择。",
    });
    await mount(false);
    await selectWorkBuddy();
    await enterConnection();
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    expect(
      await screen.findByRole("status", { name: "WorkBuddy 默认模型状态" }),
    ).toHaveTextContent("WorkBuddy 默认模型已应用：gpt-test");
    expect(screen.getByText("连接可用，工具未验证")).toBeVisible();
    expect(screen.queryByText("工具写读验证通过")).toBeNull();
    expect(document.querySelector(".hub-client-actions")).not.toHaveAttribute(
      "open",
    );
    expect(agentApi.applyWorkBuddyDefault).not.toHaveBeenCalled();
  });
  it("原生首页有草稿时保持待应用状态，重试期间禁用操作并保留连接提示", async () => {
    const pending = {
      selected: false,
      status: "pending_draft",
      model: provider.model!,
      message: "WorkBuddy 首页有草稿，处理后可以重试。",
    };
    workBuddyFixture(pending);
    await mount();
    await selectWorkBuddy();
    await enterConnection();
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    const status = await screen.findByRole("status", {
      name: "WorkBuddy 默认模型状态",
    });
    expect(status).toHaveTextContent(pending.message);
    expect(status).not.toHaveTextContent("已应用：");
    expect(screen.getByText("连接可用，工具未验证")).toBeVisible();
    let resolve!: (value: WorkBuddyDefaultSelection) => void;
    vi.mocked(agentApi.applyWorkBuddyDefault).mockReturnValueOnce(
      new Promise((complete) => {
        resolve = complete;
      }),
    );
    const apply = screen.getByRole("button", {
      name: "应用 WorkBuddy 默认模型",
    });
    await userEvent.click(apply);
    expect(apply).toBeDisabled();
    expect(status).toHaveTextContent("正在应用 WorkBuddy 默认模型…");
    expect(screen.getByText("连接可用，工具未验证")).toBeVisible();
    resolve({
      selected: true,
      status: "selected",
      model: provider.model!,
      message: "已确认首页模型选择。",
    });
    await waitFor(() => expect(status).toHaveTextContent("已应用：gpt-test"));
    expect(apply).toBeEnabled();
    expect(agentApi.applyWorkBuddyDefault).toHaveBeenCalledExactlyOnceWith();
  });
  it("WorkBuddy 原配置和 models 默认标记不会自行变成首页选择已验证，启动后单独应用", async () => {
    workBuddyFixture();
    configured = true;
    await mount();
    await selectWorkBuddy();
    expect(
      screen.queryByRole("status", { name: "WorkBuddy 默认模型状态" }),
    ).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "启动 WorkBuddy" }),
    );
    expect(
      await screen.findByRole("status", { name: "WorkBuddy 默认模型状态" }),
    ).toHaveTextContent("已应用：gpt-test");
    expect(agentApi.launch).toHaveBeenCalledExactlyOnceWith("workbuddy");
    expect(agentApi.applyWorkBuddyDefault).toHaveBeenCalledExactlyOnceWith();
    expect(agentApi.probe).not.toHaveBeenCalled();
  });
  it.each(["restarted", "pending", "failed"] as const)(
    "WorkBuddy 安全重启 %s 时仅成功回执自动应用默认模型",
    async (outcome) => {
      workBuddyFixture();
      configured = true;
      const overview = await agentApi.overview();
      vi.mocked(agentApi.overview).mockResolvedValue({
        ...overview,
        agents: overview.agents.map((item) =>
          item.id === "workbuddy"
            ? { ...item, configurationRevision: 7 }
            : item,
        ),
      });
      const profile = overview.agents.find(
        (item) => item.id === "workbuddy",
      )!.profile!;
      vi.mocked(agentApi.runtime).mockResolvedValue({
        agentId: "workbuddy",
        configurationRevision: 7,
        appliedAtMs: 100,
        platformSupported: true,
        running: true,
        restartRequired: true,
        canRestart: true,
        restartInProgress: false,
        candidates: [
          {
            processId: 101,
            startTimeMs: 9001,
            imagePath: profile.executablePath,
            workspaceDirectory: profile.workspaceDirectory,
            clientSurface: "desktop-gui",
            canRestart: true,
          },
        ],
      });
      if (outcome === "failed")
        vi.mocked(agentApi.restart).mockRejectedValue(
          new Error("restart_close"),
        );
      else
        vi.mocked(agentApi.restart).mockResolvedValue({
          restarted: outcome === "restarted",
          pending: outcome === "pending",
          message: outcome,
        });
      vi.mocked(agentApi.applyWorkBuddyDefault).mockResolvedValueOnce({
        selected: false,
        status: "client_pending",
        model: provider.model!,
        message: "客户端正在打开。",
      });
      await mount();
      await selectWorkBuddy();
      const restart = screen.getByRole("button", {
        name: "安全重启 WorkBuddy",
      });
      await waitFor(() => expect(restart).toBeEnabled());
      vi.useFakeTimers();
      await act(async () => {
        fireEvent.click(restart);
      });
      await act(() => vi.advanceTimersByTimeAsync(1000));
      expect(agentApi.restart).toHaveBeenCalledExactlyOnceWith({
        agentId: "workbuddy",
        configurationRevision: 7,
        processId: 101,
        startTimeMs: 9001,
      });
      expect(agentApi.applyWorkBuddyDefault).toHaveBeenCalledTimes(
        outcome === "restarted" ? 2 : 0,
      );
      if (outcome === "restarted")
        expect(
          screen.getByRole("status", { name: "WorkBuddy 默认模型状态" }),
        ).toHaveTextContent("已应用：gpt-test");
      else
        expect(
          screen.queryByRole("status", { name: "WorkBuddy 默认模型状态" }),
        ).toBeNull();
    },
  );
  it("启动期间仅对原生就绪状态有界重试，恢复后自动确认首页默认模型", async () => {
    workBuddyFixture();
    configured = true;
    for (const status of [
      "client_pending",
      "accessibility_pending",
      "selection_unverified",
    ])
      vi.mocked(agentApi.applyWorkBuddyDefault).mockResolvedValueOnce({
        selected: false,
        status,
        model: provider.model!,
        message: "客户端尚未就绪。",
      });
    await mount();
    await selectWorkBuddy();
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "启动 WorkBuddy" }));
    });
    expect(agentApi.applyWorkBuddyDefault).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("status", { name: "WorkBuddy 默认模型状态" }),
    ).toHaveTextContent("正在等待 WorkBuddy 启动并应用默认模型…");
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(agentApi.applyWorkBuddyDefault).toHaveBeenCalledTimes(4);
    expect(
      screen.getByRole("status", { name: "WorkBuddy 默认模型状态" }),
    ).toHaveTextContent("已应用：gpt-test");
    await act(() => vi.advanceTimersByTimeAsync(20000));
    expect(agentApi.applyWorkBuddyDefault).toHaveBeenCalledTimes(4);
  });
  it("原生就绪状态持续待处理时会结束启动重试并保留待应用原因", async () => {
    workBuddyFixture();
    configured = true;
    vi.mocked(agentApi.applyWorkBuddyDefault).mockResolvedValue({
      selected: false,
      status: "client_pending",
      model: provider.model!,
      message: "客户端尚未就绪。",
    });
    await mount();
    await selectWorkBuddy();
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "启动 WorkBuddy" }));
    });
    await act(() => vi.advanceTimersByTimeAsync(20000));
    const attempts = vi.mocked(agentApi.applyWorkBuddyDefault).mock.calls
      .length;
    expect(attempts).toBeGreaterThan(1);
    expect(attempts).toBeLessThanOrEqual(8);
    expect(
      screen.getByRole("status", { name: "WorkBuddy 默认模型状态" }),
    ).toHaveTextContent("客户端尚未就绪。");
    expect(
      screen.getByRole("button", { name: "启动 WorkBuddy" }),
    ).toBeEnabled();
    await act(() => vi.advanceTimersByTimeAsync(20000));
    expect(agentApi.applyWorkBuddyDefault).toHaveBeenCalledTimes(attempts);
  });
  it.each(["home_pending", "pending_draft", "unsupported"])(
    "启动遇到 %s 时保持原页面并停止自动重试",
    async (status) => {
      workBuddyFixture();
      configured = true;
      vi.mocked(agentApi.applyWorkBuddyDefault).mockResolvedValue({
        selected: false,
        status,
        model: provider.model!,
        message: "请处理当前页面后重试。",
      });
      await mount();
      await selectWorkBuddy();
      vi.useFakeTimers();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "启动 WorkBuddy" }));
      });
      await act(() => vi.advanceTimersByTimeAsync(20000));
      expect(agentApi.applyWorkBuddyDefault).toHaveBeenCalledExactlyOnceWith();
      expect(
        screen.getByRole("status", { name: "WorkBuddy 默认模型状态" }),
      ).toHaveTextContent("请处理当前页面后重试。");
    },
  );
  it.each(["launch", "workbuddy-default"] as const)(
    "%s 执行期间原配置改变后停止并丢弃旧原生回执",
    async (action) => {
      workBuddyFixture();
      configured = true;
      let resolve!: (value: WorkBuddyDefaultSelection) => void;
      vi.mocked(agentApi.applyWorkBuddyDefault).mockReturnValueOnce(
        new Promise((complete) => {
          resolve = complete;
        }),
      );
      await mount();
      await selectWorkBuddy();
      await userEvent.click(
        screen.getByRole("button", {
          name:
            action === "launch" ? "启动 WorkBuddy" : "应用 WorkBuddy 默认模型",
        }),
      );
      expect(agentApi.applyWorkBuddyDefault).toHaveBeenCalledTimes(1);
      const overview = await agentApi.overview();
      vi.mocked(agentApi.overview).mockResolvedValue({
        ...overview,
        agents: overview.agents.map((item) =>
          item.id === "workbuddy"
            ? {
                ...item,
                model: "gpt-new-config",
                configurationRevision: 2,
                profile: {
                  ...item.profile!,
                  workspaceDirectory: "G:/different-workspace",
                },
              }
            : item,
        ),
      });
      await act(() => client.invalidateQueries({ queryKey: ["agent-hub"] }));
      await act(async () => {
        resolve({
          selected: true,
          status: "selected",
          model: provider.model!,
          message: "这是旧配置回执。",
        });
      });
      expect(
        screen.queryByRole("status", { name: "WorkBuddy 默认模型状态" }),
      ).toBeNull();
      expect(agentApi.applyWorkBuddyDefault).toHaveBeenCalledTimes(1);
    },
  );
  it("更改连接、模型、客户端路径或 Agent 后清除 WorkBuddy 默认模型结果", async () => {
    workBuddyFixture();
    configured = true;
    vi.mocked(api.discoverConnection).mockResolvedValue({
      models: [
        ...provider.codexOptions!.models,
        {
          id: "gpt-second",
          enabled: true,
          contextWindow: null,
          reasoningEfforts: [],
        },
      ],
      protocol: "openai",
      authMode: "bearer",
      syncedAt: 2,
      baseUrl: provider.baseUrl,
    });
    await mount();
    await selectWorkBuddy();
    await enterConnection();
    const apply = screen.getByRole("button", {
      name: "应用 WorkBuddy 默认模型",
    });
    const status = () =>
      screen.queryByRole("status", { name: "WorkBuddy 默认模型状态" });
    await userEvent.click(apply);
    expect(
      await screen.findByRole("status", { name: "WorkBuddy 默认模型状态" }),
    ).toHaveTextContent("已应用：gpt-test");
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "默认模型" }),
      "gpt-second",
    );
    expect(status()).toBeNull();
    expect(apply).toBeDisabled();
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "默认模型" }),
      "gpt-test",
    );
    await userEvent.click(apply);
    await screen.findByRole("status", { name: "WorkBuddy 默认模型状态" });
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "供应商配置" }),
      provider.id,
    );
    expect(status()).toBeNull();
    await userEvent.click(apply);
    await screen.findByRole("status", { name: "WorkBuddy 默认模型状态" });
    await enterAdvancedPaths();
    await userEvent.type(
      screen.getByLabelText("工作目录", { exact: true }),
      "/changed",
    );
    expect(status()).toBeNull();
    expect(apply).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "使用识别结果" }));
    await userEvent.click(apply);
    await screen.findByRole("status", { name: "WorkBuddy 默认模型状态" });
    await userEvent.click(
      within(screen.getByRole("navigation", { name: "选择 Agent" })).getByRole(
        "button",
        { name: /Codex/ },
      ),
    );
    expect(status()).toBeNull();
    expect(
      screen.queryByRole("button", { name: "应用 WorkBuddy 默认模型" }),
    ).toBeNull();
  });
  it("新连接预填可编辑的 aiease 端点，不预置密钥或模型，也不提前查询", async () => {
    await mount();
    const endpoint = screen.getByLabelText(/API 端点/);
    const key = screen.getByLabelText("API Key", { exact: true });
    const model = screen.getByRole("combobox", { name: "默认模型" });
    expect(endpoint).toHaveValue("https://aiease-yun.com");
    expect(key).toHaveValue("");
    expect(model).toHaveValue("");
    expect(screen.getByRole("button", { name: "确认连接" })).toBeDisabled();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    expect(api.discoverConnection).not.toHaveBeenCalled();
    expect(api.save).not.toHaveBeenCalled();
    expect(agentApi.configure).not.toHaveBeenCalled();
    expect(agentApi.probe).not.toHaveBeenCalled();

    await userEvent.type(key, "sk-test-1234");
    await waitFor(() =>
      expect(api.discoverConnection).toHaveBeenCalledWith(
        {
          providerId: null,
          baseUrl: "https://aiease-yun.com",
          apiKey: "sk-test-1234",
        },
        null,
        null,
      ),
    );
    await userEvent.clear(endpoint);
    await userEvent.type(endpoint, provider.baseUrl);
    await waitFor(() =>
      expect(api.discoverConnection).toHaveBeenCalledWith(
        { providerId: null, baseUrl: provider.baseUrl, apiKey: "sk-test-1234" },
        null,
        null,
      ),
    );
    expect(endpoint).toHaveValue(provider.baseUrl);
  });
  it("已保存供应商保持自己的端点，新建连接恢复默认且不沿用密钥和模型", async () => {
    await mount();
    const selector = screen.getByRole("combobox", { name: "供应商配置" });
    await within(selector).findByRole("option", { name: provider.name });
    await userEvent.selectOptions(selector, provider.id);
    expect(screen.getByLabelText(/API 端点/)).toHaveValue(provider.baseUrl);
    await waitFor(
      () =>
        expect(screen.getByRole("combobox", { name: "默认模型" })).toHaveValue(
          provider.model,
        ),
      { timeout: 3000 },
    );
    await userEvent.type(
      screen.getByLabelText("API Key", { exact: true }),
      "sk-new-draft",
    );
    await userEvent.selectOptions(selector, "");
    expect(screen.getByLabelText(/API 端点/)).toHaveValue(
      "https://aiease-yun.com",
    );
    expect(screen.getByLabelText("API Key", { exact: true })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "默认模型" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "确认连接" })).toBeDisabled();
    expect(api.save).not.toHaveBeenCalled();
    expect(agentApi.configure).not.toHaveBeenCalled();
  });
  it("帮助保留自启设置和源码入口且不干扰连接草稿", async () => {
    const projectUrl = projectLinks.projectUrl;
    vi.spyOn(projectLinks, "projectUrl").mockImplementation((page) =>
      projectUrl(page, "example/ae-switch"),
    );
    await mount(false);
    await userEvent.clear(screen.getByLabelText(/API 端点/));
    await userEvent.type(screen.getByLabelText(/API 端点/), provider.baseUrl);
    expect(api.background).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "快速上手" }));
    const startup = await screen.findByRole("checkbox", {
      name: "随 Windows 启动，在后台运行",
    });
    await waitFor(() => expect(startup).toBeEnabled());
    expect(startup).not.toBeChecked();
    await userEvent.click(startup);
    await waitFor(() => expect(startup).toBeChecked());
    expect(api.setBackground).toHaveBeenCalledExactlyOnceWith(true);
    await userEvent.click(screen.getByRole("link", { name: "查看源码" }));
    expect(api.openProjectPage).toHaveBeenCalledExactlyOnceWith("source");
    await userEvent.click(screen.getByRole("button", { name: "完整使用说明" }));
    expect(
      await screen.findByRole("dialog", { name: "使用说明" }),
    ).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "完整使用说明" })).toHaveFocus();
    expect(screen.getByLabelText(/API 端点/)).toHaveValue(provider.baseUrl);
    expect(api.save).not.toHaveBeenCalled();
  });
  it("后台设置失败保持原开关并能重试，受限环境禁止修改", async () => {
    vi.mocked(api.setBackground).mockRejectedValueOnce(
      new Error("access denied"),
    );
    await mount(false);
    await userEvent.click(screen.getByRole("button", { name: "快速上手" }));
    const startup = await screen.findByRole("checkbox", {
      name: "随 Windows 启动，在后台运行",
    });
    await waitFor(() => expect(startup).toBeEnabled());
    await userEvent.click(startup);
    expect(await screen.findByRole("alert")).toHaveTextContent("access denied");
    expect(startup).not.toBeChecked();
    await userEvent.click(startup);
    await waitFor(() => expect(startup).toBeChecked());
    expect(screen.queryByRole("alert")).toBeNull();
    vi.mocked(api.background).mockResolvedValue({
      supported: false,
      enabled: false,
    });
    await client.invalidateQueries({ queryKey: ["background"] });
    await waitFor(() => expect(startup).toBeDisabled());
    expect(api.setBackground).toHaveBeenCalledTimes(2);
  });
  it("单页默认只展示四步连接，唯一客户端自动沿用且额外信息折叠", async () => {
    await mount(false);
    expect(screen.getByRole("heading", { name: "端点配置" })).toBeVisible();
    expect(
      within(screen.getByRole("list", { name: "连接步骤" })).getAllByRole(
        "listitem",
      ),
    ).toHaveLength(4);
    expect(
      screen.queryByRole("button", { name: /高级供应商管理|返回 Agent Hub/ }),
    ).toBeNull();
    expect(document.querySelector(".hub-overview-strip")).toBeNull();
    expect(document.querySelector(".hub-agent-detail")).toBeNull();
    expect(document.querySelector(".hub-test-panel")).toBeNull();
    expect(document.querySelector(".hub-directory-card")).toBeNull();
    await waitFor(() =>
      expect(
        document.querySelector(".hub-profile-settings"),
      ).not.toHaveAttribute("open"),
    );
    expect(document.querySelector(".hub-extra-settings")).not.toHaveAttribute(
      "open",
    );
    expect(document.querySelector(".hub-client-actions")).not.toHaveAttribute(
      "open",
    );
    expect(
      screen.getByRole("combobox", { name: "供应商配置" }),
    ).not.toBeVisible();
    expect(
      screen.getByRole("combobox", { name: "已安装客户端与配置" }),
    ).not.toBeVisible();
    expect(
      screen.getByRole("button", { name: "启动 Claude Code" }),
    ).not.toBeVisible();
    expect(
      screen.getByRole("button", { name: "重新验证工具" }),
    ).not.toBeVisible();
    await enterConnection();
    expect(screen.getByRole("button", { name: "确认连接" })).toBeEnabled();
    expect(agentApi.configure).not.toHaveBeenCalled();
  });
  it("折叠已保存连接和客户端操作保留端点密钥模型草稿且不执行写入", async () => {
    await mount(false);
    const saved = screen.getByText("已保存连接", { selector: "summary" });
    await userEvent.click(saved);
    const providerSelect = screen.getByRole("combobox", { name: "供应商配置" });
    await userEvent.selectOptions(providerSelect, provider.id);
    const key = screen.getByLabelText("API Key", { exact: true });
    await userEvent.type(key, "sk-kept-draft");
    await waitFor(
      () =>
        expect(screen.getByRole("combobox", { name: "默认模型" })).toHaveValue(
          provider.model,
        ),
      { timeout: 3000 },
    );
    for (const summary of [
      saved,
      screen.getByText("客户端操作", { selector: "summary" }),
      screen.getByText("客户端位置", { selector: "summary" }),
    ]) {
      await userEvent.click(summary);
      await userEvent.click(summary);
      expect(screen.getByLabelText(/API 端点/)).toHaveValue(provider.baseUrl);
      expect(key).toHaveValue("sk-kept-draft");
      expect(screen.getByRole("combobox", { name: "默认模型" })).toHaveValue(
        provider.model,
      );
      expect(providerSelect).toHaveValue(provider.id);
    }
    expect(api.save).not.toHaveBeenCalled();
    expect(agentApi.configure).not.toHaveBeenCalled();
    expect(agentApi.probe).not.toHaveBeenCalled();
  });
  it.each(agentCatalog.map(({ id, name }) => [id, name] as const))(
    "%s 配置范围随原配置从待配置转为已有客户端",
    async (id, name) => {
      configuredAgent = id;
      const profile = installedProfile(id);
      const taskReason = "DeepSeek Harness 需要提供任务；不会空任务启动。";
      const existingAgent = () => ({
        ...agentCatalog.find((item) => item.id === id)!,
        configured: true,
        mode: "existing" as const,
        directory: profile.directory,
        profile,
        launcher: profile.executablePath,
        providerId: provider.id,
        model: provider.model,
        canLaunch: id !== "deepseek_harness",
        launchReason: id === "deepseek_harness" ? taskReason : null,
      });
      vi.mocked(agentApi.overview).mockImplementation(async () => ({
        agents: agentCatalog.map((item) =>
          item.id === id && configured
            ? existingAgent()
            : {
                ...item,
                configured: false,
                mode: "private" as const,
                directory: `G:/portable/data/agents/${item.id}`,
                launcher: null,
                canLaunch: false,
              },
        ),
        dataDirectory: "G:/portable/data",
        bridgeHealthy: true,
      }));
      vi.mocked(agentApi.configure).mockImplementation(async () => {
        configured = true;
        return existingAgent();
      });
      await mount();
      const navigation = within(
        screen.getByRole("navigation", { name: "选择 Agent" }),
      );
      await userEvent.click(
        navigation.getByRole("button", { name: new RegExp(name) }),
      );
      expect(await screen.findByText("待配置已有客户端")).toBeVisible();
      expect(screen.queryByText("旧版私有配置")).toBeNull();
      await waitFor(() =>
        expect(
          screen.getByRole("combobox", { name: "已安装客户端与配置" }),
        ).toHaveValue(JSON.stringify(profile)),
      );
      expect(agentApi.configure).not.toHaveBeenCalled();
      if (id === "deepseek_harness") {
        expect(
          screen.getByText("需要在终端提供任务后执行；空任务不会启动。"),
        ).toBeVisible();
        expect(
          screen.getByRole("button", { name: `启动 ${name}` }),
        ).toBeDisabled();
      }
      await enterConnection();
      await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
      expect(await screen.findByText("既有客户端原配置")).toBeVisible();
      expect(screen.queryByText("待配置已有客户端")).toBeNull();
      expect(screen.queryByText("旧版私有配置")).toBeNull();
      const input = {
        agentId: id,
        providerId: provider.id,
        model: provider.model,
        profile,
      };
      expect(agentApi.configure).toHaveBeenCalledWith(input);
      expect(agentApi.probe).toHaveBeenCalledWith(input);
      if (id === "deepseek_harness") {
        expect(screen.getByText(taskReason)).toBeVisible();
        expect(
          screen.getByRole("button", { name: `启动 ${name}` }),
        ).toBeDisabled();
        expect(agentApi.launch).not.toHaveBeenCalled();
      }
    },
  );
  it("已经配置的旧版私有配置标识仍准确保留", async () => {
    vi.mocked(agentApi.overview).mockResolvedValue({
      agents: agentCatalog.map((item) =>
        item.id === "claude_code"
          ? {
              ...item,
              configured: true,
              mode: "private" as const,
              directory: "G:/portable/data/agents/claude_code",
              launcher: "G:/portable/data/agents/claude_code/launch.cmd",
              providerId: provider.id,
              model: provider.model,
            }
          : item,
      ),
      dataDirectory: "G:/portable/data",
      bridgeHealthy: true,
    });
    await mount();
    expect(await screen.findByText("旧版私有配置")).toBeVisible();
    expect(screen.queryByText("待配置已有客户端")).toBeNull();
  });
  function restartFixture(overrides: Partial<ExistingRuntime> = {}) {
    vi.mocked(agentApi.overview).mockResolvedValue({
      agents: agentCatalog.map((item) =>
        item.id === "claude_code"
          ? {
              ...item,
              configured: true,
              mode: "existing" as const,
              profile: installedProfile(item.id),
              launcher: installedProfile(item.id).executablePath,
              providerId: provider.id,
              model: provider.model,
              configurationRevision: 7,
            }
          : item,
      ),
      dataDirectory: "./data",
      bridgeHealthy: true,
    });
    vi.mocked(agentApi.runtime).mockResolvedValue({
      agentId: "claude_code",
      configurationRevision: 7,
      appliedAtMs: 100,
      platformSupported: true,
      running: true,
      restartRequired: true,
      canRestart: true,
      restartInProgress: false,
      candidates: [101, 202].map((processId) => ({
        processId,
        startTimeMs: processId === 101 ? 9001 : 9002,
        imagePath: installedProfile("claude_code").executablePath,
        workspaceDirectory: installedProfile("claude_code").workspaceDirectory,
        clientSurface: "interactive-cli" as const,
        canRestart: true,
      })),
      ...overrides,
    });
  }
  it("需要重新加载配置时，折叠客户端操作也能看见提示", async () => {
    restartFixture();
    const overview = await agentApi.overview();
    vi.mocked(agentApi.overview).mockResolvedValue({
      ...overview,
      agents: overview.agents.map((item) =>
        item.id === "claude_code" ? { ...item, needsRestart: true } : item,
      ),
    });
    await mount(false);
    expect(document.querySelector(".hub-client-actions")).not.toHaveAttribute(
      "open",
    );
    expect(
      await screen.findByText(
        "新配置需要客户端重新加载；既有进程尚未验证已重启。",
      ),
    ).toBeVisible();
  });
  it("多个既有进程必须明确选择，安全重开只提交PID、创建时间和配置版本", async () => {
    restartFixture();
    await mount();
    const process = await screen.findByRole("combobox", {
      name: "运行中的客户端",
    });
    const restart = screen.getByRole("button", {
      name: "安全重启 Claude Code",
    });
    expect(process).toHaveValue("");
    expect(restart).toBeDisabled();
    await userEvent.selectOptions(process, "202:9002");
    expect(restart).toBeEnabled();
    await userEvent.click(restart);
    expect(agentApi.restart).toHaveBeenCalledExactlyOnceWith({
      agentId: "claude_code",
      configurationRevision: 7,
      processId: 202,
      startTimeMs: 9002,
    });
    expect(await screen.findByRole("status")).toHaveTextContent("正常退出");
    expect(screen.getByRole("status")).toHaveClass("info");
    expect(agentApi.launch).not.toHaveBeenCalled();
    expect(agentApi.configure).not.toHaveBeenCalled();
  });
  it("过时配置的进程结果不能重启，自动化任务拒绝原因保持可见", async () => {
    restartFixture({
      configurationRevision: 6,
      canRestart: false,
      candidates: [
        {
          processId: 303,
          startTimeMs: 9003,
          imagePath: installedProfile("claude_code").executablePath,
          workspaceDirectory:
            installedProfile("claude_code").workspaceDirectory,
          clientSurface: "automation",
          canRestart: false,
          reason: "正在执行自动化任务，不会重放任务。",
        },
      ],
    });
    await mount();
    expect(
      await screen.findByText("正在执行自动化任务，不会重放任务。"),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "安全重启 Claude Code" }),
    ).toBeDisabled();
    expect(agentApi.restart).not.toHaveBeenCalled();
  });
  it("命令行显式模型验证通过仍明确桌面和默认模型选择未验证", async () => {
    vi.mocked(agentApi.probe).mockResolvedValue({
      ok: true,
      model: "gpt-test",
      latencyMs: 12,
      message: "CLI verification passed",
      validationScope: "tool",
      toolVerified: true,
      stage: "verified",
      profileMode: "existing",
      clientSurface: "headless-cli",
      verificationScope: "headless_tool_write_read",
      explicitModelArgument: true,
      nativeDefaultModelVerified: false,
      desktopGuiVerified: false,
      desktopDefaultSelectionVerified: false,
    });
    await mount();
    await enterConnection();
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    expect(await screen.findByText("工具写读验证通过")).toBeVisible();
    expect(
      screen.getByText(
        "本次通过命令行入口并显式指定模型；桌面界面与默认模型选择尚未验证。",
      ),
    ).toBeVisible();
  });
  it("工具验证成功后仍保留原入口环境覆盖与首次认证提示", async () => {
    const warning =
      "原入口的 ANTHROPIC_BASE_URL 可能覆盖原生配置，请在原工具核对。";
    vi.mocked(agentApi.overview).mockResolvedValue({
      agents: agentCatalog.map((item) => ({
        ...item,
        warnings: item.id === "claude_code" ? [warning] : [],
      })),
      dataDirectory: "./data",
      bridgeHealthy: true,
    });
    await mount();
    await enterConnection();
    expect(screen.getByText(warning)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    expect(await screen.findByText("工具写读验证通过")).toBeVisible();
    expect(screen.getByText(warning)).toBeVisible();
  });
  it("未发现既有客户端时不能偷偷生成私有配置，仍可只保存供应商", async () => {
    vi.mocked(agentApi.discover).mockResolvedValue({
      clients: [],
      scannedAt: "now",
      limited: false,
      notes: [],
    });
    await mount();
    await enterConnection();
    expect(screen.getByRole("button", { name: "确认连接" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "重新验证工具" })).toBeDisabled();
    expect(screen.getByText(/未探测到已安装的 Claude Code/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "仅保存" }));
    await waitFor(() => expect(api.save).toHaveBeenCalledOnce());
    expect(agentApi.configure).not.toHaveBeenCalled();
  });
  it("发现多个原配置目录必须明确选择，配置和验证沿用同一profile", async () => {
    const first = installedProfile("claude_code");
    const second = {
      ...installedProfile("claude_code", "-second"),
      configFile: "G:/test-installed/claude_code-second/profile/settings.json",
    };
    vi.mocked(agentApi.discover).mockResolvedValue({
      clients: [
        {
          agentId: "claude_code",
          executablePath: first.executablePath,
          profiles: [first, second],
          source: "PATH",
          reason: null,
        },
      ],
      scannedAt: "now",
      limited: false,
      notes: [],
    });
    await mount(false);
    await enterConnection();
    expect(document.querySelector(".hub-profile-settings")).toHaveAttribute(
      "open",
    );
    expect(screen.getByRole("button", { name: "确认连接" })).toBeDisabled();
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "已安装客户端与配置" }),
      JSON.stringify(second),
    );
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    await waitFor(() =>
      expect(agentApi.configure).toHaveBeenCalledWith(
        expect.objectContaining({ profile: second }),
      ),
    );
    expect(agentApi.probe).toHaveBeenCalledWith(
      expect.objectContaining({ profile: second }),
    );
  });
  it("指定安装目录只输入一个字段，识别后沿用原生配置而不拿安装目录当 HOME", async () => {
    const profile = installedProfile("claude_code", "-custom");
    const directory = "G:/custom tools/claude-install";
    vi.mocked(agentApi.discoverDirectory).mockResolvedValue(
      installationResult([profile]),
    );
    await mount();
    await enterConnection();
    await specifyInstallation(directory);
    expect(document.querySelector(".hub-advanced-paths")).not.toHaveAttribute(
      "open",
    );
    expect(screen.queryByLabelText("原配置目录", { exact: true })).toBeNull();
    expect(screen.getByRole("button", { name: "确认连接" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /^识别$/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "确认连接" })).toBeEnabled(),
    );
    expect(agentApi.discoverDirectory).toHaveBeenCalledExactlyOnceWith(
      "claude_code",
      directory,
    );
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    await waitFor(() =>
      expect(agentApi.configure).toHaveBeenCalledWith(
        expect.objectContaining({ profile }),
      ),
    );
    expect(agentApi.probe).toHaveBeenCalledWith(
      expect.objectContaining({ profile }),
    );
    expect(profile.homeDirectory).not.toBe(directory);
    expect(profile.directory).not.toBe(directory);
  });
  it("原生选择目录后自动识别，取消选择保留有效的原配置和验证结果", async () => {
    const directory = "G:/picked/install";
    const profile = installedProfile("claude_code", "-picked");
    vi.mocked(agentApi.pickDirectory)
      .mockResolvedValueOnce(directory)
      .mockResolvedValueOnce(null);
    vi.mocked(agentApi.discoverDirectory).mockResolvedValue(
      installationResult([profile]),
    );
    await mount();
    await enterConnection();
    await userEvent.click(screen.getByRole("button", { name: "指定安装目录" }));
    await userEvent.click(screen.getByRole("button", { name: "选择目录" }));
    await waitFor(() =>
      expect(agentApi.discoverDirectory).toHaveBeenCalledExactlyOnceWith(
        "claude_code",
        directory,
      ),
    );
    expect(screen.getByLabelText("安装目录", { exact: true })).toHaveValue(
      directory,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "确认连接" })).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    await screen.findByText("工具写读验证通过");
    await userEvent.click(screen.getByRole("button", { name: "选择目录" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "确认连接" })).toBeEnabled(),
    );
    expect(screen.getByText("工具写读验证通过")).toBeVisible();
    expect(screen.getByLabelText("安装目录", { exact: true })).toHaveValue(
      directory,
    );
    expect(agentApi.discoverDirectory).toHaveBeenCalledOnce();
  });
  it("改安装目录、识别失败和空结果都使旧通过状态及已保存 profile 失效", async () => {
    const profile = installedProfile("claude_code");
    vi.mocked(agentApi.overview).mockResolvedValue({
      agents: agentCatalog.map((item) =>
        item.id === "claude_code"
          ? {
              ...item,
              configured: true,
              mode: "existing" as const,
              profile,
              providerId: provider.id,
              model: provider.model,
            }
          : item,
      ),
      dataDirectory: "./data",
      bridgeHealthy: true,
    });
    vi.mocked(agentApi.discoverDirectory)
      .mockResolvedValueOnce(installationResult([profile]))
      .mockRejectedValueOnce(new Error("目录不可访问"))
      .mockResolvedValueOnce(installationResult([]));
    await mount();
    await enterConnection();
    await specifyInstallation("G:/valid/install");
    await userEvent.click(screen.getByRole("button", { name: /^识别$/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "确认连接" })).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    await screen.findByText("工具写读验证通过");
    fireEvent.change(screen.getByLabelText("安装目录", { exact: true }), {
      target: { value: "G:/other/install" },
    });
    expect(screen.queryByText("工具写读验证通过")).toBeNull();
    expect(screen.getByRole("button", { name: "确认连接" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /^识别$/ }));
    expect(
      await screen.findByText(/安装目录识别失败：目录不可访问/),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "确认连接" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /^识别$/ }));
    expect(
      await screen.findByText(/所选安装目录中未识别到 Claude Code/),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "确认连接" })).toBeDisabled();
    expect(agentApi.configure).toHaveBeenCalledOnce();
  });
  it("安装目录返回多个 profile 时不回落已保存 profile，必须明确选择", async () => {
    const first = installedProfile("claude_code");
    const second = installedProfile("claude_code", "-other");
    vi.mocked(agentApi.overview).mockResolvedValue({
      agents: agentCatalog.map((item) =>
        item.id === "claude_code"
          ? {
              ...item,
              configured: true,
              mode: "existing" as const,
              profile: first,
            }
          : item,
      ),
      dataDirectory: "./data",
      bridgeHealthy: true,
    });
    vi.mocked(agentApi.discoverDirectory).mockResolvedValue(
      installationResult([first, second]),
    );
    await mount();
    await enterConnection();
    await specifyInstallation("G:/many/install");
    await userEvent.click(screen.getByRole("button", { name: /^识别$/ }));
    const select = screen.getByRole("combobox", { name: "已安装客户端与配置" });
    await within(select).findByRole("option", {
      name: `${second.directory} · ${second.executablePath}`,
    });
    expect(select).toHaveValue("");
    expect(screen.getByRole("button", { name: "确认连接" })).toBeDisabled();
    await userEvent.selectOptions(select, JSON.stringify(second));
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    await waitFor(() =>
      expect(agentApi.configure).toHaveBeenCalledWith(
        expect.objectContaining({ profile: second }),
      ),
    );
  });
  it("旧安装目录请求晚于新目录返回时不能替换当前候选", async () => {
    let resolveOld!: (value: InstalledAgentDiscovery) => void;
    vi.mocked(agentApi.discoverDirectory)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce(
        installationResult([installedProfile("claude_code", "-new")]),
      );
    await mount();
    await enterConnection();
    await specifyInstallation("G:/old/install");
    await userEvent.click(screen.getByRole("button", { name: /^识别$/ }));
    expect(screen.getByRole("button", { name: "确认连接" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("安装目录", { exact: true }), {
      target: { value: "G:/new/install" },
    });
    await userEvent.click(screen.getByRole("button", { name: /^识别$/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "确认连接" })).toBeEnabled(),
    );
    await act(async () =>
      resolveOld(
        installationResult([installedProfile("claude_code", "-stale")]),
      ),
    );
    expect(
      screen.getByRole("combobox", { name: "已安装客户端与配置" }),
    ).toHaveValue(JSON.stringify(installedProfile("claude_code", "-new")));
    expect(screen.queryByRole("option", { name: /-stale/ })).toBeNull();
  });
  it("切换工具后丢弃旧识别请求，返回原工具仍需重新识别", async () => {
    let resolveOld!: (value: InstalledAgentDiscovery) => void;
    vi.mocked(agentApi.discoverDirectory).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    await mount();
    await enterConnection();
    await specifyInstallation("G:/pending/install");
    await userEvent.click(screen.getByRole("button", { name: /^识别$/ }));
    const nav = within(screen.getByRole("navigation", { name: "选择 Agent" }));
    await userEvent.click(nav.getByRole("button", { name: /Codex 官方图标/ }));
    await act(async () =>
      resolveOld(
        installationResult([installedProfile("claude_code", "-stale")]),
      ),
    );
    await userEvent.click(
      nav.getByRole("button", { name: /Claude Code 官方图标/ }),
    );
    expect(screen.getByLabelText("安装目录", { exact: true })).toHaveValue(
      "G:/pending/install",
    );
    expect(screen.getByRole("button", { name: "确认连接" })).toBeDisabled();
    expect(screen.queryByRole("option", { name: /-stale/ })).toBeNull();
  });
  it("高级路径显式启用才生效，关闭高级面板后清除验证并恢复识别选择", async () => {
    let resolveOld!: (value: InstalledAgentDiscovery) => void;
    vi.mocked(agentApi.discoverDirectory).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    await mount();
    await enterConnection();
    await specifyInstallation("G:/pending/install");
    await userEvent.click(screen.getByRole("button", { name: /^识别$/ }));
    await enterAdvancedPaths();
    await act(async () =>
      resolveOld(
        installationResult([installedProfile("claude_code", "-stale")]),
      ),
    );
    expect(screen.getByLabelText("原配置目录", { exact: true })).toHaveValue(
      "",
    );
    expect(screen.getByRole("button", { name: "确认连接" })).toBeDisabled();
    const manual = installedProfile("claude_code", "-advanced");
    for (const [field, label] of [
      ["directory", "原配置目录"],
      ["homeDirectory", "原用户目录"],
      ["executablePath", "客户端启动文件"],
      ["workspaceDirectory", "工作目录"],
    ] as const) {
      fireEvent.change(screen.getByLabelText(label, { exact: true }), {
        target: { value: manual[field] },
      });
    }
    expect(screen.getByRole("button", { name: "确认连接" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    await screen.findByText("工具写读验证通过");
    await userEvent.click(
      screen.getByText("高级路径设置", { selector: "summary" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "确认连接" })).toBeDisabled(),
    );
    expect(screen.queryByText("工具写读验证通过")).toBeNull();
    expect(screen.queryByLabelText("原配置目录", { exact: true })).toBeNull();
  });
  it("探测达到上限显示真实原因，即使只有一个候选也需要明确选择", async () => {
    const profile = installedProfile("claude_code");
    vi.mocked(agentApi.discover).mockResolvedValue({
      clients: [
        {
          agentId: "claude_code",
          executablePath: profile.executablePath,
          profiles: [profile],
          source: "PATH",
          reason: null,
        },
      ],
      scannedAt: "now",
      limited: true,
      notes: ["已达到有界扫描上限"],
    });
    await mount();
    await enterConnection();
    expect(screen.getByRole("button", { name: "确认连接" })).toBeDisabled();
    expect(screen.getByText(/探测未完成：已达到有界扫描上限/)).toBeVisible();
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "已安装客户端与配置" }),
      JSON.stringify(profile),
    );
    expect(screen.getByRole("button", { name: "确认连接" })).toBeEnabled();
    expect(agentApi.configure).not.toHaveBeenCalled();
  });
  it("自动探测失败明确报错，不使用私有配置作为成功fallback", async () => {
    vi.mocked(agentApi.discover).mockRejectedValue(
      new Error("无法读取安装位置"),
    );
    await mount(false);
    await enterConnection();
    expect(document.querySelector(".hub-profile-settings")).toHaveAttribute(
      "open",
    );
    expect(screen.getByRole("button", { name: "确认连接" })).toBeDisabled();
    expect(screen.getByText(/工具探测失败：无法读取安装位置/)).toBeVisible();
    expect(agentApi.configure).not.toHaveBeenCalled();
  });
  it("未自动发现时手动指定原目录，字段不完整禁止配置，修改目录清除旧通过状态", async () => {
    const user = userEvent.setup();
    vi.mocked(agentApi.discover).mockResolvedValue({
      clients: [],
      scannedAt: "now",
      limited: false,
      notes: [],
    });
    await mount();
    await enterConnection();
    await enterAdvancedPaths();
    const chosen = installedProfile("claude_code", "-manual");
    for (const [field, label] of [
      ["directory", "原配置目录"],
      ["homeDirectory", "原用户目录"],
      ["executablePath", "客户端启动文件"],
    ] as const) {
      await user.click(screen.getByLabelText(label));
      await user.paste(chosen[field]);
    }
    expect(screen.getByRole("button", { name: "确认连接" })).toBeDisabled();
    await user.click(screen.getByLabelText("工作目录"));
    await user.paste(chosen.workspaceDirectory);
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    await waitFor(() =>
      expect(agentApi.configure).toHaveBeenCalledWith(
        expect.objectContaining({ profile: chosen }),
      ),
    );
    expect(await screen.findByText("工具写读验证通过")).toBeVisible();
    await userEvent.type(screen.getByLabelText("原配置目录"), "-changed");
    expect(screen.queryByText("工具写读验证通过")).toBeNull();
    expect(agentApi.configure).toHaveBeenCalledOnce();
  });
  it("切换工具只使用对应已安装profile，保留其它工具的明确选择", async () => {
    await mount();
    await enterConnection();
    await userEvent.click(
      screen.getByRole("button", { name: /Codex 官方图标/ }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "确认连接" })).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    await waitFor(() =>
      expect(agentApi.configure).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "codex",
          profile: installedProfile("codex"),
        }),
      ),
    );
    expect(agentApi.probe).toHaveBeenCalledWith(
      expect.objectContaining({ profile: installedProfile("codex") }),
    );
  });
  it("快速上手支持键盘聚焦、局部 Escape 和关闭后返回入口，保留配置草稿", async () => {
    configured = true;
    await mount();
    const providerSelect = screen.getByRole("combobox", { name: "供应商配置" });
    await within(providerSelect).findByRole("option", { name: provider.name });
    await userEvent.selectOptions(providerSelect, provider.id);
    const endpoint = screen.getByLabelText(/API 端点/);
    const key = screen.getByLabelText("API Key", { exact: true });
    const model = screen.getByRole("combobox", { name: "默认模型" });
    await waitFor(() => expect(model).toHaveValue(provider.model));
    await userEvent.type(key, "sk-kept-draft");
    await waitFor(() => expect(model).toHaveValue(provider.model));
    const expectDraft = () => {
      expect(providerSelect).toHaveValue(provider.id);
      expect(endpoint).toHaveValue(provider.baseUrl);
      expect(key).toHaveValue("sk-kept-draft");
      expect(model).toHaveValue(provider.model);
    };
    for (const trigger of screen.getAllByRole("button", { name: "快速上手" })) {
      trigger.focus();
      await userEvent.keyboard("{Enter}");
      const guide = screen.getByRole("region", { name: "四步连接软件" });
      expect(within(guide).getByRole("heading")).toHaveFocus();
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("region", { name: "四步连接软件" })).toBeNull();
      expect(trigger).toHaveFocus();
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      expectDraft();
      await userEvent.keyboard("{Enter}");
      key.focus();
      await userEvent.keyboard("{Escape}");
      expect(
        screen.getByRole("region", { name: "四步连接软件" }),
      ).toBeVisible();
      expectDraft();
      await userEvent.click(
        screen.getByRole("button", { name: "关闭快速上手" }),
      );
      expect(screen.queryByRole("region", { name: "四步连接软件" })).toBeNull();
      expect(trigger).toHaveFocus();
      expectDraft();
    }
    expect(api.save).not.toHaveBeenCalled();
    expect(agentApi.configure).not.toHaveBeenCalled();
    expect(agentApi.probe).not.toHaveBeenCalled();
  });
  it("支持全部八种 Agent 的官方标志，切换主题，并将配置与工具验证状态分开", async () => {
    configured = true;
    await mount();
    const nav = within(screen.getByRole("navigation", { name: "选择 Agent" }));
    for (const agent of agentCatalog) {
      const button = await nav.findByRole("button", {
        name: new RegExp(agent.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      });
      expect(button).toBeVisible();
      expect(
        within(button).getByRole("img", { name: `${agent.name} 官方图标` }),
      ).toBeVisible();
    }
    expect(nav.getAllByRole("img")).toHaveLength(8);
    expect(screen.getAllByRole("img")).toHaveLength(9);
    const openCodeLogo = nav.getByRole("img", { name: "OpenCode 官方图标" });
    const darkLogo = openCodeLogo.getAttribute("src");
    expect(document.querySelector(".hub-probe-status")).toBeNull();
    expect(screen.queryByText("工具写读验证通过")).toBeNull();
    expect(
      screen.getByRole("button", { name: /启动 Claude Code/ }),
    ).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "切换浅色主题" }));
    expect(document.documentElement).toHaveAttribute("data-ae-theme", "light");
    expect(openCodeLogo.getAttribute("src")).not.toBe(darkLogo);
    expect(screen.getByRole("button", { name: "切换深色主题" })).toBeVisible();
    expect(document.body).not.toHaveTextContent("蝶祈");
  });
  it("自动获取真实模型后，一次确认按顺序保存、配置并验证", async () => {
    await mount();
    expect(screen.getByRole("button", { name: "确认连接" })).toBeDisabled();
    await enterConnection();
    expect(api.discoverConnection).toHaveBeenCalledWith(
      { providerId: null, baseUrl: provider.baseUrl, apiKey: "sk-test-1234" },
      null,
      null,
    );
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    await waitFor(() =>
      expect(agentApi.configure).toHaveBeenCalledWith({
        agentId: "claude_code",
        providerId: provider.id,
        model: provider.model,
        profile: installedProfile("claude_code"),
      }),
    );
    expect(api.save).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: provider.baseUrl,
        apiKey: "sk-test-1234",
        model: "gpt-test",
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "已完成配置，工具写读验证通过",
    );
    expect(agentApi.probe).toHaveBeenCalledWith({
      agentId: "claude_code",
      providerId: provider.id,
      model: provider.model,
      profile: installedProfile("claude_code"),
    });
    expect(vi.mocked(api.save).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(agentApi.configure).mock.invocationCallOrder[0],
    );
    expect(
      vi.mocked(agentApi.configure).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(agentApi.probe).mock.invocationCallOrder[0]);
    expect(screen.getByLabelText("API Key", { exact: true })).toHaveValue("");
    expect(screen.getByText("工具写读验证通过")).toBeVisible();
    expect(screen.getByText("验证临时文件已清理")).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: /启动 Claude Code/ }),
    );
    expect(agentApi.launch).toHaveBeenCalledWith("claude_code");
  });
  it("供应商连接失败保留失败证据，绝不显示工具验证通过", async () => {
    vi.mocked(agentApi.probe).mockResolvedValue({
      ok: false,
      model: "gpt-test",
      latencyMs: 42,
      message: "upstream returned 401",
      validationScope: "connection",
      toolVerified: false,
      stage: "connection",
    });
    await mount();
    await enterConnection();
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "配置已写入，连接检测失败：upstream returned 401",
    );
    expect(screen.getByText("连接检测未通过")).toBeVisible();
    expect(screen.queryByText("工具写读验证通过")).toBeNull();
    expect(agentApi.configure).toHaveBeenCalledOnce();
  });
  it("只有实际工具写读成功能点亮验证状态，修改端点清除旧结果", async () => {
    vi.mocked(agentApi.probe).mockResolvedValue({
      ok: true,
      model: "gpt-test",
      latencyMs: 321,
      message: "real tool wrote and read back the verification file",
      validationScope: "tool",
      toolVerified: true,
      stage: "verified",
    });
    await mount();
    await enterConnection();
    await userEvent.click(screen.getByRole("button", { name: "重新验证工具" }));
    expect(await screen.findByText("工具写读验证通过")).toBeVisible();
    expect(
      screen.getByText("real tool wrote and read back the verification file"),
    ).toBeVisible();
    expect(agentApi.configure).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText(/API 端点/), "/other");
    expect(document.querySelector(".hub-probe-status")).toBeNull();
    expect(screen.queryByText("工具写读验证通过")).toBeNull();
  });
  it("配置失败时可重试，不宣称已经应用", async () => {
    vi.mocked(agentApi.configure).mockRejectedValueOnce(
      new Error("cannot write portable configuration"),
    );
    await mount();
    await enterConnection();
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "配置工具失败：cannot write portable configuration",
    );
    expect(agentApi.probe).not.toHaveBeenCalled();
    expect(screen.queryByText("工具写读验证通过")).toBeNull();
    expect(
      screen.getByRole("button", { name: /启动 Claude Code/ }),
    ).toBeDisabled();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "确认连接" })).toBeEnabled(),
    );
  });
  it("保存失败时停止流程并标明失败阶段", async () => {
    vi.mocked(api.save).mockRejectedValueOnce(
      new Error("key store unavailable"),
    );
    await mount();
    await enterConnection();
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "保存连接失败：key store unavailable",
    );
    expect(agentApi.configure).not.toHaveBeenCalled();
    expect(agentApi.probe).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "确认连接" })).toBeEnabled();
  });
  it("探针异常明确报告验证失败，不沿用之前的通过状态", async () => {
    await mount();
    await enterConnection();
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    expect(await screen.findByText("工具写读验证通过")).toBeVisible();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "重新验证工具" }),
      ).toBeEnabled(),
    );
    vi.mocked(agentApi.probe).mockRejectedValueOnce(
      new Error("request timed out"),
    );
    await userEvent.click(screen.getByRole("button", { name: "重新验证工具" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "验证请求失败：request timed out",
    );
    expect(screen.getByText("验证请求未完成")).toBeVisible();
    expect(screen.queryByText("工具写读验证通过")).toBeNull();
  });
  it("真实模型发现失败时没有可选模型，也不能确认", async () => {
    vi.mocked(api.discoverConnection).mockRejectedValue(
      new Error("model discovery returned 401"),
    );
    await mount();
    await userEvent.clear(screen.getByLabelText(/API 端点/));
    await userEvent.type(screen.getByLabelText(/API 端点/), provider.baseUrl);
    await userEvent.type(
      screen.getByLabelText("API Key", { exact: true }),
      "wrong-key",
    );
    expect(
      await screen.findByText("model discovery returned 401"),
    ).toBeVisible();
    expect(screen.getByRole("combobox", { name: "默认模型" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "确认连接" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "同步模型" })).toBeEnabled();
    expect(api.save).not.toHaveBeenCalled();
    expect(agentApi.configure).not.toHaveBeenCalled();
    expect(agentApi.probe).not.toHaveBeenCalled();
  });
  it("刷新失败后不把上次发现的模型当成当前可用模型", async () => {
    await mount();
    await enterConnection();
    vi.mocked(api.discoverConnection).mockRejectedValueOnce(
      new Error("model discovery is unavailable"),
    );
    await userEvent.click(screen.getByRole("button", { name: "同步模型" }));
    expect(
      await screen.findByText("model discovery is unavailable"),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "确认连接" })).toBeDisabled();
    expect(screen.queryByRole("option", { name: "gpt-test" })).toBeNull();
  });
  it("保存后重新发现同一模型不清除快速返回的验证失败", async () => {
    vi.mocked(agentApi.probe).mockResolvedValueOnce({
      ok: false,
      model: provider.model,
      latencyMs: 0,
      message: "工具未安装，请安装后重新验证。",
      validationScope: "tool",
      toolVerified: false,
      stage: "not_installed",
    });
    await mount(false);
    await enterConnection();
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    expect(await screen.findByText("工具未安装")).toBeVisible();
    await waitFor(
      () => expect(api.discoverConnection).toHaveBeenCalledTimes(2),
      {
        timeout: 3000,
      },
    );
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "默认模型" })).toHaveValue(
        provider.model,
      ),
    );
    expect(screen.getByText("工具未安装")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "配置已写入，工具未安装",
    );
  });
  it("同步自动改选模型后清除原模型的验证结果", async () => {
    await mount(false);
    await enterConnection();
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    expect(await screen.findByText("工具写读验证通过")).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "同步模型" })).toBeEnabled(),
    );
    vi.mocked(api.discoverConnection).mockResolvedValueOnce({
      models: [
        {
          id: "new-code-model",
          enabled: true,
          contextWindow: null,
          reasoningEfforts: [],
        },
      ],
      protocol: "openai",
      authMode: "bearer",
      syncedAt: 3,
      baseUrl: provider.baseUrl,
    });
    await userEvent.click(screen.getByRole("button", { name: "同步模型" }));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "默认模型" })).toHaveValue(
        "new-code-model",
      ),
    );
    expect(screen.queryByText("工具写读验证通过")).toBeNull();
    expect(screen.queryByText(/已完成配置，工具写读验证通过/)).toBeNull();
    expect(agentApi.probe).toHaveBeenCalledTimes(1);
  });
  it("重新探测自动改选目录后清除原目录的验证结果", async () => {
    await mount();
    await enterConnection();
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    expect(await screen.findByText("工具写读验证通过")).toBeVisible();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "重新探测工具" }),
      ).toBeEnabled(),
    );
    const nextProfile = installedProfile("claude_code", "-moved");
    vi.mocked(agentApi.discover).mockResolvedValueOnce({
      clients: [
        {
          agentId: "claude_code",
          executablePath: nextProfile.executablePath,
          profiles: [nextProfile],
          source: "PATH",
          reason: null,
        },
      ],
      scannedAt: "2026-10-11T07:00:00Z",
      limited: false,
      notes: [],
    });
    await userEvent.click(screen.getByRole("button", { name: "重新探测工具" }));
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "已安装客户端与配置" }),
      ).toHaveValue(JSON.stringify(nextProfile)),
    );
    expect(screen.queryByText("工具写读验证通过")).toBeNull();
    expect(screen.queryByText(/已完成配置，工具写读验证通过/)).toBeNull();
    expect(agentApi.probe).toHaveBeenCalledTimes(1);
  });
  it("编码模型为空时禁用确认，不使用占位模型补齐", async () => {
    vi.mocked(api.discoverConnection).mockResolvedValue({
      models: [
        {
          id: "text-embedding-test",
          enabled: true,
          contextWindow: null,
          reasoningEfforts: [],
        },
      ],
      protocol: "openai",
      authMode: "bearer",
      syncedAt: 2,
      baseUrl: provider.baseUrl,
    });
    await mount();
    await userEvent.type(screen.getByLabelText(/API 端点/), provider.baseUrl);
    await userEvent.type(
      screen.getByLabelText("API Key", { exact: true }),
      "sk-test",
    );
    expect(
      await screen.findByText(
        "未找到可用于此客户端的编码模型，请检查模型访问权限",
      ),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "确认连接" })).toBeDisabled();
    expect(screen.queryByRole("option", { name: "gpt-test" })).toBeNull();
  });
  it("将列表中用户选中的真实模型用于保存、配置和自动检测", async () => {
    vi.mocked(api.discoverConnection).mockResolvedValue({
      models: [
        ...provider.codexOptions!.models,
        {
          id: "other-code-model",
          enabled: true,
          contextWindow: null,
          reasoningEfforts: [],
        },
      ],
      protocol: "openai",
      authMode: "bearer",
      syncedAt: 2,
      baseUrl: provider.baseUrl,
    });
    vi.mocked(api.save).mockImplementation(async (input) => ({
      ...provider,
      model: input.model,
    }));
    await mount(false);
    await enterConnection();
    expect(document.querySelector(".hub-profile-settings")).not.toHaveAttribute(
      "open",
    );
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "默认模型" }),
      "other-code-model",
    );
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    await waitFor(() =>
      expect(agentApi.probe).toHaveBeenCalledWith({
        agentId: "claude_code",
        providerId: provider.id,
        model: "other-code-model",
        profile: installedProfile("claude_code"),
      }),
    );
    expect(api.save).toHaveBeenCalledWith(
      expect.objectContaining({ model: "other-code-model" }),
    );
    expect(agentApi.configure).toHaveBeenCalledWith({
      agentId: "claude_code",
      providerId: provider.id,
      model: "other-code-model",
      profile: installedProfile("claude_code"),
    });
    expect(vi.mocked(api.save).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(agentApi.configure).mock.invocationCallOrder[0],
    );
    expect(
      vi.mocked(agentApi.configure).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(agentApi.probe).mock.invocationCallOrder[0]);
  });
  it("连接可用但工具未安装时保留已配置状态并明确缺少工具", async () => {
    vi.mocked(agentApi.probe).mockResolvedValue({
      ok: false,
      model: "gpt-test",
      latencyMs: 12,
      validationScope: "tool",
      toolVerified: false,
      stage: "not_installed",
      message: "Claude Code executable was not found",
    });
    await mount();
    await enterConnection();
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "配置已写入，工具未安装：Claude Code executable was not found",
    );
    expect(screen.getByText("工具未安装")).toBeVisible();
    expect(document.querySelector(".hub-state-tag")).toHaveTextContent(
      "已配置",
    );
    expect(screen.queryByText("工具写读验证通过")).toBeNull();
  });
  it("真实工具写读失败显示具体阶段和错误，不把API连通当成工具正常", async () => {
    vi.mocked(agentApi.probe).mockResolvedValue({
      ok: false,
      model: "gpt-test",
      latencyMs: 55,
      validationScope: "tool",
      toolVerified: false,
      stage: "readback",
      message: "read content did not match the written token",
      evidence: { written: "expected-token", readback: "other-token" },
      cleanup: { ok: true, removed: true },
    });
    await mount();
    await enterConnection();
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "配置已写入，真实工具验证失败：read content did not match the written token",
    );
    expect(screen.getByText("真实工具验证未通过")).toBeVisible();
    expect(screen.getByText("验证阶段：读取内容核对")).toBeVisible();
    expect(screen.queryByText("工具写读验证通过")).toBeNull();
  });
  it("缺少真实工具验证证明时，接口ok也不能宣称工具写读通过", async () => {
    vi.mocked(agentApi.probe).mockResolvedValue({
      ok: true,
      model: "gpt-test",
      latencyMs: 40,
      validationScope: "connection",
      toolVerified: false,
      stage: "connection",
      message: "only the provider responded",
    });
    await mount();
    await enterConnection();
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    expect(await screen.findByText("连接可用，工具未验证")).toBeVisible();
    expect(screen.queryByText("工具写读验证通过")).toBeNull();
    expect(screen.getByRole("status")).not.toHaveTextContent(
      "已完成配置，工具写读验证通过",
    );
  });
  it("清理失败明确显示清理结果，并保留真实工具失败状态", async () => {
    vi.mocked(agentApi.probe).mockResolvedValue({
      ok: false,
      model: "gpt-test",
      latencyMs: 50,
      validationScope: "tool",
      toolVerified: false,
      stage: "cleanup",
      message: "verification temporary file could not be removed",
      cleanup: { scope: "owned-uuid-verification-directory", succeeded: false },
    });
    await mount();
    await enterConnection();
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "verification temporary file could not be removed",
    );
    expect(screen.getByText("验证临时文件清理未完成")).toBeVisible();
    expect(screen.queryByText("工具写读验证通过")).toBeNull();
  });
  it.each([
    ["workbuddy", "WorkBuddy", "启动脚本已生成，运行结果将在终端显示。"],
    [
      "deepseek_harness",
      "DeepSeek Harness",
      "需要在终端提供任务后执行；空任务不会启动。",
    ],
  ] as const)(
    "%s 使用官方图标，选中后按同一合同配置并真实验证",
    async (agentId, name, launchNote) => {
      configuredAgent = agentId;
      await mount();
      const nav = within(
        screen.getByRole("navigation", { name: "选择 Agent" }),
      );
      await userEvent.click(
        nav.getByRole("button", { name: new RegExp(name) }),
      );
      expect(
        screen.getAllByRole("img", { name: `${name} 官方图标` }),
      ).toHaveLength(2);
      await enterConnection();
      await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
      expect(await screen.findByRole("status")).toHaveTextContent(
        `${name} 已完成配置，工具写读验证通过`,
      );
      expect(agentApi.configure).toHaveBeenCalledWith({
        agentId,
        providerId: provider.id,
        model: provider.model,
        profile: installedProfile(agentId),
      });
      expect(agentApi.probe).toHaveBeenCalledWith({
        agentId,
        providerId: provider.id,
        model: provider.model,
        profile: installedProfile(agentId),
      });
      expect(screen.getByText(launchNote)).toBeVisible();
    },
  );
  it("所选模型与工具配置不一致时明确需要确认配置，不能误报工具通过", async () => {
    vi.mocked(agentApi.probe).mockResolvedValue({
      ok: false,
      model: "gpt-test",
      latencyMs: 10,
      validationScope: "tool",
      toolVerified: false,
      stage: "not_configured",
      message: "selected model does not match the saved tool configuration",
    });
    await mount();
    await enterConnection();
    await userEvent.click(screen.getByRole("button", { name: "重新验证工具" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "工具配置不匹配：selected model does not match the saved tool configuration",
    );
    expect(screen.getByText("当前选择尚未配置")).toBeVisible();
    expect(screen.queryByText("工具写读验证通过")).toBeNull();
  });
  it("Tauri拒绝配置不匹配对象时保留配置阶段和错误信息", async () => {
    const message = "请先确认所选连接和模型，完成此工具的配置后再验证";
    vi.mocked(agentApi.probe).mockRejectedValueOnce({
      code: "not_configured",
      message,
    });
    await mount();
    await enterConnection();
    await userEvent.click(screen.getByRole("button", { name: "重新验证工具" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByText("当前选择尚未配置")).toBeVisible();
    expect(screen.getByText("验证阶段：核对当前工具配置")).toBeVisible();
    expect(screen.queryByText("工具写读验证通过")).toBeNull();
  });

  it("核心功能折叠时不读取配置方案或保护信息，只有配置成功才记最近使用", async () => {
    const list = vi.spyOn(configProfilesApi, "list").mockResolvedValue([]);
    const inspect = vi.spyOn(configurationSafetyApi, "inspect");
    await mount(false);
    expect(list).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    expect(
      screen.getByText("高级功能", { selector: "summary" }).closest("details"),
    ).not.toHaveAttribute("open");
    expect(
      screen.getByText("请求活动", { selector: "summary" }).closest("details"),
    ).not.toHaveAttribute("open");
    expect(
      screen.getByText("配置保护与安全断开", { selector: "summary" }),
    ).toBeVisible();
    await enterConnection();
    expect(loadModelPreferences("claude_code", provider.id).recent).toEqual({});
    vi.mocked(agentApi.configure).mockRejectedValueOnce(
      new Error("controlled configuration failure"),
    );
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    await screen.findByText(/controlled configuration failure/);
    expect(loadModelPreferences("claude_code", provider.id).recent).toEqual({});
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "确认连接" })).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    await waitFor(() =>
      expect(
        loadModelPreferences("claude_code", provider.id).recent[provider.model],
      ).toBeGreaterThan(0),
    );
    await userEvent.click(
      screen.getByText("高级功能", { selector: "summary" }),
    );
    expect(list).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByText("配置方案", { selector: "summary" }),
    );
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    expect(inspect).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByText("高级功能", { selector: "summary" }),
    );
    expect(screen.queryByRole("heading", { name: "具名配置方案" })).toBeNull();
    await userEvent.click(
      screen.getByText("高级功能", { selector: "summary" }),
    );
    expect(
      screen.getByText("配置方案", { selector: "summary" }).closest("details"),
    ).not.toHaveAttribute("open");
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("正式配置保护操作锁住全页，恢复成功清除旧工具通过状态", async () => {
    const report = {
      status: "healthy" as const,
      canDisconnect: true,
      previewToken: "preview-fingerprint",
      files: [{ slot: "config", managedFields: 3, changedFields: 0 }],
    };
    vi.spyOn(configurationSafetyApi, "inspect").mockResolvedValue(report);
    let finish: (() => void) | undefined;
    const disconnect = vi
      .spyOn(configurationSafetyApi, "disconnect")
      .mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finish = () => {
              configured = false;
              resolve();
            };
          }),
      );
    await mount(false);
    await enterConnection();
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    await screen.findByText("工具写读验证通过");
    await userEvent.click(
      screen.getByText("配置保护与安全断开", { selector: "summary" }),
    );
    await screen.findByText("AE 管理的连接字段与最近写入一致。");
    await userEvent.click(screen.getByRole("button", { name: "预览断开" }));
    await screen.findByRole("button", { name: "恢复原配置并断开" });
    await userEvent.click(
      screen.getByRole("button", { name: "恢复原配置并断开" }),
    );
    await waitFor(() =>
      expect(disconnect).toHaveBeenCalledWith(
        "claude_code",
        "preview-fingerprint",
      ),
    );
    expect(screen.getByRole("button", { name: "确认连接" })).toBeDisabled();
    for (const button of within(
      screen.getByRole("navigation", { name: "选择 Agent" }),
    ).getAllByRole("button"))
      expect(button).toBeDisabled();
    await act(async () => {
      finish?.();
    });
    await screen.findByText(
      "已断开 AE 连接并恢复受管字段，请让客户端重新加载配置。",
    );
    expect(screen.queryByText("工具写读验证通过")).toBeNull();
  });
});
