import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { ConfigProfilesPanel } from "./ConfigProfilesPanel";
import {
  configProfilesApi,
  type ConfigProfile,
  type ConfigProfilePreview,
} from "../lib/configProfilesApi";
vi.mock("../lib/api", () => ({ desktopRuntime: true }));
vi.mock("../lib/configProfilesApi", () => ({
  configProfilesApi: {
    list: vi.fn(),
    save: vi.fn(),
    preview: vi.fn(),
    apply: vi.fn(),
    delete: vi.fn(),
  },
}));
const profile: ConfigProfile = {
  id: "p",
  name: "工作",
  revision: 1,
  updatedAt: 100,
  entries: [
    {
      agentId: "codex",
      providerId: "a",
      model: "model-a",
      reasoningEffort: "high",
    },
    {
      agentId: "workbuddy",
      providerId: "b",
      model: "model-b",
      reasoningEffort: null,
    },
  ],
};
const preview: ConfigProfilePreview = {
  ...profile,
  fingerprint: "fingerprint",
  entries: profile.entries.map((entry) => ({
    ...entry,
    providerName: "连接",
    previousProviderName: "旧连接",
    previousModel: "old-model",
    previousReasoningEffort: null,
    targetMode: "existing",
    changed: true,
  })),
};
const agents = [
  {
    id: "codex" as const,
    name: "Codex",
    configured: true,
    configurationRevision: 1,
  },
  {
    id: "workbuddy" as const,
    name: "WorkBuddy",
    configured: true,
    configurationRevision: 1,
  },
];
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(configProfilesApi.list).mockResolvedValue([profile]);
  vi.mocked(configProfilesApi.preview).mockResolvedValue(preview);
  vi.mocked(configProfilesApi.apply).mockResolvedValue({
    profileId: "p",
    appliedAgentIds: ["codex", "workbuddy"],
    needsRestart: true,
  });
});
it("saves only explicitly chosen configured client references", async () => {
  vi.mocked(configProfilesApi.save).mockResolvedValue(profile);
  render(<ConfigProfilesPanel agents={agents} />);
  const user = userEvent.setup();
  await screen.findByText("工作");
  await user.click(
    screen.getByRole("checkbox", { name: "方案包含 WorkBuddy" }),
  );
  await user.type(
    screen.getByRole("textbox", { name: "方案名称" }),
    " 新方案 ",
  );
  await user.click(screen.getByRole("button", { name: "保存当前组合" }));
  await waitFor(() =>
    expect(configProfilesApi.save).toHaveBeenCalledWith({
      name: "新方案",
      agentIds: ["codex"],
    }),
  );
});
it("applies the exact preview under the global busy lock and keeps preview across identical polls", async () => {
  const busy = vi.fn();
  const applied = vi.fn();
  const view = render(
    <ConfigProfilesPanel
      agents={agents}
      onBusyChange={busy}
      onApplied={applied}
    />,
  );
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "预览方案 工作" }),
  );
  expect(await screen.findByLabelText("方案预览 工作")).toBeInTheDocument();
  view.rerender(
    <ConfigProfilesPanel
      agents={agents.map((agent) => ({ ...agent }))}
      onBusyChange={busy}
      onApplied={applied}
    />,
  );
  expect(screen.getByLabelText("方案预览 工作")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "应用此方案" }));
  await waitFor(() =>
    expect(configProfilesApi.apply).toHaveBeenCalledWith({
      id: "p",
      revision: 1,
      fingerprint: "fingerprint",
    }),
  );
  expect(busy).toHaveBeenCalledWith(true);
  await waitFor(() => expect(busy).toHaveBeenLastCalledWith(false));
  expect(applied).toHaveBeenCalled();
});
it("clears stale previews on actual revision changes and hides raw private errors", async () => {
  const view = render(<ConfigProfilesPanel agents={agents} />);
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "预览方案 工作" }),
  );
  await screen.findByLabelText("方案预览 工作");
  view.rerender(
    <ConfigProfilesPanel
      agents={[{ ...agents[0], configurationRevision: 2 }, agents[1]]}
    />,
  );
  expect(screen.queryByLabelText("方案预览 工作")).not.toBeInTheDocument();
  vi.mocked(configProfilesApi.preview).mockRejectedValue({
    code: "network",
    message: "private-secret https://private.test G:/private",
  });
  await user.click(screen.getByRole("button", { name: "预览方案 工作" }));
  expect(await screen.findByRole("alert")).not.toHaveTextContent(
    "private-secret",
  );
  expect(document.body.textContent).not.toContain("private.test");
});
