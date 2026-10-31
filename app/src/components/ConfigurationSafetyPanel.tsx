import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentId } from "../lib/agentApi";
import { desktopRuntime, errorMessage } from "../lib/api";
import {
  configurationSafetyApi,
  type ConfigurationSafety,
} from "../lib/configurationSafetyApi";
import "./configuration-safety.css";

const fileLabels: Record<string, string> = {
  config: "主配置",
  secondary: "辅助配置",
  builtin: "内置供应商配置",
  state: "内置代理选择",
  environment: "便携启动环境",
};

export function ConfigurationSafetyPanel({
  agentId,
  configured,
  disabled = false,
  onChanged,
  onBusyChange,
}: {
  agentId: AgentId;
  configured: boolean;
  disabled?: boolean;
  onChanged?: () => void | Promise<void>;
  onBusyChange?: (busy: boolean) => void;
}) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<ConfigurationSafety | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [restored, setRestored] = useState(false);
  const queryKey = ["agent-configuration-safety", agentId];
  const safety = useQuery({
    queryKey,
    queryFn: () => configurationSafetyApi.inspect(agentId),
    enabled: open && configured && desktopRuntime && !busy && !disabled,
    refetchInterval:
      open && configured && desktopRuntime && !busy && !disabled
        ? 15000
        : false,
    retry: false,
    staleTime: 5000,
  });

  useEffect(() => {
    setPreview(null);
    setError(null);
    setRestored(false);
  }, [agentId, configured]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    try {
      await action();
    } catch (error) {
      setError(error);
      setPreview(null);
      void client.invalidateQueries({ queryKey });
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  }

  function previewDisconnect() {
    void run(async () => {
      await client.cancelQueries({ queryKey });
      const report = await configurationSafetyApi.inspect(agentId);
      client.setQueryData(queryKey, report);
      setPreview(report.canDisconnect && report.previewToken ? report : null);
    });
  }

  function disconnect() {
    const token = preview?.previewToken;
    if (!token) return;
    void run(async () => {
      await configurationSafetyApi.disconnect(agentId, token);
      setPreview(null);
      setRestored(true);
      await client.invalidateQueries({ queryKey: ["agent-hub"] });
      await client.invalidateQueries({ queryKey: ["agent-overview"] });
      await client.invalidateQueries({ queryKey });
      await onChanged?.();
    });
  }

  const report = safety.isError ? undefined : safety.data;
  const locked = disabled || busy || safety.isFetching;
  return (
    <details
      className="hub-configuration-safety"
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
        if (!event.currentTarget.open) setPreview(null);
      }}
    >
      <summary>配置保护与安全断开</summary>
      {open && (
        <section aria-label="配置保护">
          <p className="hub-profile-note">
            检测 AE
            管理的连接字段。断开时恢复这些字段的原值，并保留之后添加的其他设置。
          </p>
          {!desktopRuntime ? (
            <p className="hub-profile-note">
              请在 AE Switch 桌面应用中检查真实配置。
            </p>
          ) : !configured ? (
            <p className="hub-profile-note">当前客户端尚未连接 AE。</p>
          ) : (
            <>
              <div className="hub-configuration-safety-actions">
                <button
                  type="button"
                  className="hub-button secondary"
                  disabled={locked}
                  onClick={() => {
                    setPreview(null);
                    setError(null);
                    void safety.refetch();
                  }}
                >
                  检查配置
                </button>
                <button
                  type="button"
                  className="hub-button secondary"
                  disabled={locked || !report?.canDisconnect}
                  onClick={previewDisconnect}
                >
                  预览断开
                </button>
              </div>
              {safety.isPending && (
                <p role="status" className="hub-profile-note">
                  正在检查配置…
                </p>
              )}
              {report?.status === "healthy" && (
                <p role="status" className="hub-profile-note">
                  AE 管理的连接字段与最近写入一致。
                </p>
              )}
              {report?.status === "drifted" && (
                <p role="alert" className="hub-configuration-safety-warning">
                  检测到连接配置已被其他程序或手动修改。安全恢复已停止，请先核对客户端中的连接设置。
                </p>
              )}
              {report?.status === "untracked" && (
                <p className="hub-profile-note">
                  此配置尚无恢复记录。下次确认连接时开始保存字段所有权；已有连接无法追溯更早的原值。
                </p>
              )}
              {preview && (
                <div
                  className="hub-configuration-safety-preview"
                  aria-label="断开预览"
                >
                  <p>
                    将恢复以下文件中 AE 改过的字段，并从 AE
                    移除当前客户端的连接选择：
                  </p>
                  <ul>
                    {preview.files.map((file) => (
                      <li key={file.slot}>
                        {fileLabels[file.slot] ?? "连接配置"}：
                        {file.managedFields} 个字段
                      </li>
                    ))}
                  </ul>
                  <p className="hub-profile-note">
                    客户端历史与其他设置会保留。已打开的客户端需要重新加载配置；预览后文件有变化会停止恢复。
                  </p>
                  <div className="hub-configuration-safety-actions">
                    <button
                      type="button"
                      className="hub-button secondary"
                      disabled={disabled || busy}
                      onClick={() => setPreview(null)}
                    >
                      取消断开
                    </button>
                    <button
                      type="button"
                      className="hub-button primary"
                      disabled={disabled || busy}
                      onClick={disconnect}
                    >
                      {busy ? "正在恢复…" : "恢复原配置并断开"}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
          {restored && (
            <p role="status" className="hub-profile-note">
              已恢复 AE 管理的原配置并断开。
            </p>
          )}
          {(error || safety.isError) && (
            <p role="alert" className="hub-configuration-safety-warning">
              {errorMessage(error || safety.error)}
            </p>
          )}
        </section>
      )}
    </details>
  );
}
