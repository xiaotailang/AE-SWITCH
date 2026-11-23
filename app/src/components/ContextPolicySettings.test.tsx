import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ContextPolicySettings } from "./ContextPolicySettings";
describe("context settings", () => {
  it("shows an off switch and 80% by default, then emits an explicit opt-in", () => {
    const onChange = vi.fn();
    render(
      <ContextPolicySettings
        model={{
          id: "gpt-6.1-sol",
          enabled: true,
          contextWindow: null,
          reasoningEfforts: [],
          contextCapabilities: {
            standardWindow: 272000,
            longWindow: 1050000,
            source: "endpoint",
            inputMultiplier: 2,
            outputMultiplier: 1.5,
            endpoint: "https://gateway.example/v1",
            credentialScope: "a".repeat(64),
          },
        }}
        value={{
          model: "gpt-6.1-sol",
          longContextEnabled: false,
          compactPercent: 80,
        }}
        disabled={false}
        agentId="codex"
        baseUrl="https://gateway.example/v1"
        onChange={onChange}
      />,
    );
    expect(screen.getByRole("switch", { name: "长上下文" })).not.toBeChecked();
    expect(
      screen.getByRole("spinbutton", { name: "自动压缩阈值（%）" }),
    ).toHaveValue(80);
    fireEvent.click(screen.getByRole("switch", { name: "长上下文" }));
    expect(onChange).toHaveBeenCalledWith({
      model: "gpt-6.1-sol",
      longContextEnabled: true,
      compactPercent: 80,
    });
    expect(screen.getByText(/217,600 Token/)).toBeInTheDocument();
  });
  it("keeps a known official model disabled at a custom endpoint without pricing", () => {
    render(
      <ContextPolicySettings
        model={{
          id: "gpt-6.1-sol",
          enabled: true,
          contextWindow: 1050000,
          reasoningEfforts: [],
        }}
        value={{
          model: "gpt-6.1-sol",
          longContextEnabled: true,
          compactPercent: 80,
        }}
        disabled={false}
        agentId="codex"
        baseUrl="https://gateway.example/v1"
        onChange={vi.fn()}
      />,
    );
    const toggle = screen.getByRole("switch", { name: "长上下文" });
    expect(toggle).toBeDisabled();
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/计费阈值未确认/)).toBeInTheDocument();
  });
  it("disables paid opt-in for an explicitly flat-rate internal model", () => {
    render(
      <ContextPolicySettings
        model={{
          id: "gpt-internal",
          enabled: true,
          contextWindow: 400000,
          reasoningEfforts: [],
          contextCapabilities: {
            standardWindow: 64000,
            longWindow: 400000,
            source: "endpoint",
            surcharge: false,
            inputMultiplier: null,
            outputMultiplier: null,
            endpoint: "https://gateway.example/v1",
            credentialScope: "a".repeat(64),
          },
        }}
        value={{
          model: "gpt-internal",
          longContextEnabled: false,
          compactPercent: 80,
        }}
        disabled={false}
        agentId="codex"
        baseUrl="https://gateway.example/v1"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("switch", { name: "长上下文" })).toBeDisabled();
    expect(screen.getByText(/声明不按长上下文加价/)).toBeInTheDocument();
    expect(screen.getByText(/压缩阈值 320,000/)).toBeInTheDocument();
  });
  it("disables long context for an unknown model and identifies native compaction limits", () => {
    render(
      <ContextPolicySettings
        model={{
          id: "gpt-custom",
          enabled: true,
          contextWindow: null,
          reasoningEfforts: [],
        }}
        value={{
          model: "gpt-custom",
          longContextEnabled: false,
          compactPercent: 80,
        }}
        disabled={false}
        agentId="zcode"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("switch", { name: "长上下文" })).toBeDisabled();
    expect(screen.getByText(/原工具管理/)).toBeInTheDocument();
  });
});
