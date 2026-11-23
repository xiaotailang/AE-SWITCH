import type { ContextPolicy, ProviderModel } from "../types";
import {
  contextCapabilities,
  contextChoice,
  effectiveContext,
  longContextAvailable,
} from "../lib/contextPolicy";

export function ContextPolicySettings({
  model,
  value,
  disabled,
  agentId,
  baseUrl,
  onChange,
}: {
  model?: ProviderModel;
  value: ContextPolicy | null;
  disabled: boolean;
  agentId: string;
  baseUrl?: string;
  onChange: (value: ContextPolicy) => void;
}) {
  const limits = contextCapabilities(model, baseUrl);
  if (!model || !value || !limits) return null;
  const choice = contextChoice(model, value, baseUrl);
  const effective = effectiveContext(model, choice, baseUrl);
  const available = longContextAvailable(limits);
  const format = (n: number) => n.toLocaleString("en-US");
  const nativeCompact = [
    "codex",
    "hermes",
    "oh_my_pi",
    "claude_code",
    "opencode",
    "deepseek_harness",
    "workbuddy",
  ].includes(agentId);
  return (
    <fieldset className="hub-context-settings" disabled={disabled}>
      <legend>上下文与自动压缩</legend>
      <label className="hub-context-toggle">
        <input
          type="checkbox"
          role="switch"
          aria-label="长上下文"
          checked={choice.longContextEnabled}
          disabled={disabled || !available}
          onChange={(event) =>
            onChange({ ...choice, longContextEnabled: event.target.checked })
          }
        />
        <span>
          长上下文{choice.longContextEnabled ? "：已开启" : "：已关闭"}
        </span>
      </label>
      <p className="hub-profile-note">
        {available
          ? `默认关闭加价档位，上下文不超过 ${format(limits.standardWindow)} Token；主动开启后扩展到 ${format(limits.longWindow)} Token。`
          : limits.surcharge === false
            ? `当前端点与模型声明不按长上下文加价，使用其 ${format(limits.standardWindow)} Token 窗口，无需开启加价档位。`
            : limits.surcharge === true
              ? "当前端点与模型的最大窗口未超过加价阈值，无可开启的长上下文档位。"
              : "当前端点与模型的长上下文计费阈值未确认，开关不可用；不会仅凭模型名称或最大窗口推断加价规则。"}
        {available
          ? `输入费率 ${limits.inputMultiplier != null ? `${limits.inputMultiplier} 倍` : "未提供"}，输出费率 ${limits.outputMultiplier != null ? `${limits.outputMultiplier} 倍` : "未提供"}；实际按端点规则计费。`
          : ""}
        {limits.source === "official_model"
          ? "当前连接为 OpenAI 官方 API，按该精确模型的官方计费规则处理。"
          : limits.source === "conservative"
            ? "使用最多 128K 的保守预算，这不是已确认的免费或不加价额度。"
            : "能力来自当前端点的模型声明。"}
      </p>
      <label>
        自动压缩阈值（%）
        <input
          type="number"
          aria-label="自动压缩阈值（%）"
          min={1}
          max={95}
          step={1}
          value={choice.compactPercent}
          disabled={!nativeCompact}
          onChange={(event) => {
            const percent = Number(event.target.value);
            if (Number.isInteger(percent) && percent >= 1 && percent <= 95)
              onChange({ ...choice, compactPercent: percent });
          }}
        />
      </label>
      <p className="hub-profile-note" aria-live="polite">
        上下文上限 {format(effective!.contextWindow)} Token，确认连接后应用。
        {nativeCompact
          ? `压缩阈值 ${format(effective!.autoCompactTokenLimit)} Token（${choice.compactPercent}%）。客户端还会为输出和工具保留空间，可能提前压缩。`
          : "此客户端的压缩比例由原工具管理；AE 仅应用上下文限额，不宣称 80% 已生效。"}
        关闭长上下文时，网关会保守拒绝过大请求或无法可靠计数的附件/上游历史；主动开启后由客户端和上游执行长窗口限制。实际费用以端点规则为准。
        {agentId === "workbuddy"
          ? "WorkBuddy 的压缩比例仅在从 AE 启动或验证的进程中应用；桌面已有进程需要重新加载。"
          : ""}
      </p>
    </fieldset>
  );
}
