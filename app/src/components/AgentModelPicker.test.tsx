import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { AgentModelPicker } from "./AgentModelPicker";
import {
  loadModelPreferences,
  rememberModelUse,
} from "../lib/modelPreferences";
const models = ["gpt-small", "gpt-large", "constructor", "__proto__"].map(
  (id) => ({ id, enabled: true, contextWindow: null, reasoningEfforts: [] }),
);
function Harness({ agentId = "codex", providerId = "saved" } = {}) {
  const [model, setModel] = useState("gpt-small");
  return (
    <AgentModelPicker
      agentId={agentId}
      providerId={providerId}
      models={models}
      model={model}
      onChange={setModel}
    />
  );
}
beforeEach(() => localStorage.clear());
it("searches without changing the current draft and Escape clears locally", async () => {
  render(<Harness />);
  const user = userEvent.setup();
  const search = screen.getByRole("textbox", { name: "搜索模型" });
  await user.type(search, "gpt large");
  expect(screen.getByRole("combobox", { name: "默认模型" })).toHaveValue(
    "gpt-small",
  );
  expect(screen.getByRole("option", { name: "gpt-large" })).toBeInTheDocument();
  await user.type(search, " absent");
  expect(screen.getByText("没有匹配的模型")).toBeInTheDocument();
  expect(screen.getByRole("combobox")).toBeEnabled();
  await user.keyboard("{Escape}");
  expect(search).toHaveValue("");
  expect(loadModelPreferences("codex", "saved").recent).toEqual({});
});
it("persists favorites and shows recent models only after successful-use recording", async () => {
  rememberModelUse("codex", "saved", "gpt-large", 100);
  render(<Harness />);
  const user = userEvent.setup();
  expect(screen.queryByRole("button", { name: "收藏 gpt-small" })).toBeNull();
  await user.click(screen.getByText("常用模型", { selector: "summary" }));
  await user.click(screen.getByRole("button", { name: "收藏 gpt-small" }));
  await user.click(screen.getByRole("button", { name: "收藏 1" }));
  expect(
    screen.queryByRole("option", { name: "gpt-large" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "最近使用 1" }));
  expect(screen.getByRole("option", { name: "gpt-large" })).toBeInTheDocument();
  expect(
    screen.queryByRole("option", { name: "constructor" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("option", { name: "__proto__" }),
  ).not.toBeInTheDocument();
  expect(loadModelPreferences("codex", "saved").favorites).toEqual([
    "gpt-small",
  ]);
});
it("keeps search and model selection available while common preferences are folded", async () => {
  render(<Harness />);
  const user = userEvent.setup();
  expect(screen.getByRole("textbox", { name: "搜索模型" })).toBeVisible();
  expect(screen.getByRole("combobox", { name: "默认模型" })).toBeVisible();
  expect(screen.queryByRole("group", { name: "模型列表筛选" })).toBeNull();
  await user.selectOptions(screen.getByRole("combobox"), "gpt-large");
  expect(screen.getByRole("combobox")).toHaveValue("gpt-large");
});
it("closing common preferences shows all models and keeps the chosen filter for reopening", async () => {
  render(<Harness />);
  const user = userEvent.setup();
  const summary = screen.getByText("常用模型", { selector: "summary" });
  await user.click(summary);
  await user.click(screen.getByRole("button", { name: "收藏 gpt-small" }));
  await user.click(screen.getByRole("button", { name: "收藏 1" }));
  expect(screen.queryByRole("option", { name: "gpt-large" })).toBeNull();
  await user.click(summary);
  expect(screen.getByRole("option", { name: "gpt-large" })).toBeInTheDocument();
  expect(screen.getByRole("combobox")).toHaveValue("gpt-small");
  await user.click(summary);
  expect(screen.getByRole("button", { name: "收藏 1" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.queryByRole("option", { name: "gpt-large" })).toBeNull();
  expect(loadModelPreferences("codex", "saved").favorites).toEqual([
    "gpt-small",
  ]);
});
it("disables preference and selection changes during work and rejects unsaved favorites", async () => {
  const change = vi.fn();
  const view = render(
    <AgentModelPicker
      agentId="codex"
      providerId="saved"
      models={models}
      model="gpt-small"
      disabled
      onChange={change}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByText("常用模型", { selector: "summary" }));
  expect(screen.getByRole("combobox")).toBeDisabled();
  expect(screen.getByRole("textbox", { name: "搜索模型" })).toBeDisabled();
  for (const button of screen.getAllByRole("button"))
    expect(button).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "收藏 gpt-small" }));
  expect(change).not.toHaveBeenCalled();
  expect(loadModelPreferences("codex", "saved").favorites).toEqual([]);
  view.rerender(
    <AgentModelPicker
      agentId="codex"
      providerId=""
      models={models}
      model="gpt-small"
      onChange={change}
    />,
  );
  await user.click(screen.getByText("常用模型", { selector: "summary" }));
  expect(screen.getByRole("button", { name: "收藏 gpt-small" })).toBeDisabled();
});
