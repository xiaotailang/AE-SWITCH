import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  configProfilesApi,
  type ConfigProfile,
  type ConfigProfilePreview,
  type ApplyConfigProfileResult,
} from "../lib/configProfilesApi";
import type { AgentId } from "../lib/agentApi";
import { desktopRuntime } from "../lib/api";

function failure(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  if (
    code === "configuration_profile_changed" ||
    code === "agent_configuration_changed"
  )
    return "方案、连接或客户端配置已经变化。请重新预览后再应用，外部修改未被覆盖。";
  if (code === "recovery_required")
    return "批量操作未能完整恢复，原备份已保留。请关闭客户端后重新打开 AE，外部修改保持不变。";
  if (code === "not_configured")
    return "请先确认所选客户端的连接，再保存或应用方案。";
  if (code === "profile_name_exists")
    return "此方案名称已存在，请使用新名称，或更新已有方案。";
  if (code === "invalid_model" || code === "unsupported_reasoning_effort")
    return "方案引用的模型或思考等级已不可用。请重新查询、确认连接并更新方案。";
  if (code === "profile_target_overlap")
    return "多个客户端指向了同一配置文件，请先分别选择正确的客户端位置。";
  return "配置方案操作失败，原配置和恢复备份已保留。请检查客户端状态后重试。";
}

export function ConfigProfilesPanel({
  agents,
  disabled = false,
  onApplied,
  onBusyChange,
}: {
  agents: {
    id: AgentId;
    name: string;
    configured: boolean;
    configurationRevision?: number;
  }[];
  disabled?: boolean;
  onApplied?: (
    result: ApplyConfigProfileResult,
    preview: ConfigProfilePreview,
  ) => void | Promise<void>;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [profiles, setProfiles] = useState<ConfigProfile[]>([]);
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<AgentId[] | null>(null);
  const [preview, setPreview] = useState<ConfigProfilePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [deleteId, setDeleteId] = useState("");
  const configured = agents.filter((agent) => agent.configured);
  const agentsSignature = JSON.stringify(
    agents.map((agent) => [
      agent.id,
      agent.configured,
      agent.configurationRevision || 0,
    ]),
  );
  const selected =
    chosen === null
      ? configured.map((agent) => agent.id)
      : chosen.filter((id) => configured.some((agent) => agent.id === id));
  const locked = disabled || busy || !desktopRuntime;
  const agentName = (id: AgentId) =>
    agents.find((agent) => agent.id === id)?.name || id;
  async function refresh() {
    setProfiles(await configProfilesApi.list());
  }
  useEffect(() => {
    let active = true;
    configProfilesApi
      .list()
      .then((items) => {
        if (active) setProfiles(items);
      })
      .catch((error) => {
        if (active) setError(failure(error));
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    setPreview(null);
  }, [agentsSignature]);
  async function run(task: () => Promise<void>) {
    if (locked) return;
    setBusy(true);
    onBusyChange?.(true);
    setError("");
    setMessage("");
    try {
      await task();
    } catch (error) {
      setError(failure(error));
      setPreview(null);
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  }
  return (
    <section
      className="hub-config-profiles"
      aria-labelledby="hub-config-profiles-title"
      aria-busy={busy}
    >
      <h3 id="hub-config-profiles-title">具名配置方案</h3>
      <p className="hub-profile-note">
        保存多个客户端的连接、模型和思考等级组合。方案只引用已保存连接，不复制密钥或用户目录；应用前会重新预览当前客户端位置，任一写入失败将恢复整组配置。
      </p>
      <fieldset disabled={locked}>
        <legend>保存当前组合</legend>
        <div className="hub-config-profile-actions">
          {configured.map((agent) => (
            <label key={agent.id}>
              <input
                type="checkbox"
                aria-label={`方案包含 ${agent.name}`}
                checked={selected.includes(agent.id)}
                onChange={(event) =>
                  setChosen(
                    event.target.checked
                      ? [...selected, agent.id]
                      : selected.filter((id) => id !== agent.id),
                  )
                }
              />{" "}
              {agent.name}
            </label>
          ))}
          {!configured.length && (
            <span className="hub-profile-note">确认连接后即可保存方案。</span>
          )}
        </div>
        <form
          className="hub-config-profile-save"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim() || !selected.length) return;
            void run(async () => {
              const saved = await configProfilesApi.save({
                name: name.trim(),
                agentIds: selected,
              });
              setName("");
              setPreview(null);
              await refresh();
              setMessage(`已保存方案“${saved.name}”。`);
            });
          }}
        >
          <input
            aria-label="方案名称"
            placeholder="例如：工作、低成本"
            maxLength={60}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <button
            type="submit"
            className="hub-button secondary"
            disabled={!name.trim() || !selected.length}
          >
            保存当前组合
          </button>
        </form>
      </fieldset>
      <div className="hub-config-profile-actions">
        <button
          type="button"
          className="hub-button secondary"
          disabled={locked}
          onClick={() =>
            void run(async () => {
              await refresh();
              setPreview(null);
            })
          }
        >
          <RefreshCw size={13} aria-hidden /> 刷新方案
        </button>
      </div>
      {profiles.length > 0 ? (
        <ul className="hub-config-profile-list" aria-label="已保存配置方案">
          {profiles.map((profile) => (
            <li key={profile.id}>
              <strong>{profile.name}</strong>
              <p className="hub-profile-note">
                {profile.entries
                  .map(
                    (entry) =>
                      `${agentName(entry.agentId)}：${entry.model}${entry.reasoningEffort ? ` (${entry.reasoningEffort})` : ""}`,
                  )
                  .join("；")}
              </p>
              <div className="hub-config-profile-actions">
                <button
                  type="button"
                  className="hub-button secondary"
                  aria-label={`预览方案 ${profile.name}`}
                  disabled={locked}
                  onClick={() =>
                    void run(async () => {
                      setPreview(await configProfilesApi.preview(profile.id));
                      setDeleteId("");
                    })
                  }
                >
                  预览并应用
                </button>
                <button
                  type="button"
                  className="hub-button secondary"
                  aria-label={`更新方案 ${profile.name}`}
                  disabled={
                    locked ||
                    profile.entries.some(
                      (entry) =>
                        !configured.some((agent) => agent.id === entry.agentId),
                    )
                  }
                  onClick={() =>
                    void run(async () => {
                      await configProfilesApi.save({
                        id: profile.id,
                        revision: profile.revision,
                        name: profile.name,
                        agentIds: profile.entries.map((entry) => entry.agentId),
                      });
                      setPreview(null);
                      await refresh();
                      setMessage(`已用当前组合更新“${profile.name}”。`);
                    })
                  }
                >
                  用当前配置更新
                </button>
                <button
                  type="button"
                  className="hub-button secondary"
                  aria-label={`${deleteId === profile.id ? "确认删除方案" : "删除方案"} ${profile.name}`}
                  disabled={locked}
                  onClick={() => {
                    if (deleteId !== profile.id) {
                      setDeleteId(profile.id);
                      return;
                    }
                    void run(async () => {
                      await configProfilesApi.delete(
                        profile.id,
                        profile.revision,
                      );
                      setPreview(null);
                      setDeleteId("");
                      await refresh();
                      setMessage(`已删除方案“${profile.name}”。`);
                    });
                  }}
                >
                  {deleteId === profile.id ? "确认删除" : "删除"}
                </button>
                {deleteId === profile.id && (
                  <button
                    type="button"
                    className="hub-button secondary"
                    disabled={locked}
                    onClick={() => setDeleteId("")}
                  >
                    取消删除
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="hub-profile-note">尚未保存配置方案。</p>
      )}
      {preview && (
        <div
          className="hub-config-profile-preview"
          aria-label={`方案预览 ${preview.name}`}
        >
          <strong>应用“{preview.name}”</strong>
          <p className="hub-profile-note">
            目标为各客户端当前已确认的位置。方案不切换用户目录；应用后请按客户端提示重新加载，新任务使用所选模型。
          </p>
          <ul>
            {preview.entries.map((entry) => (
              <li key={entry.agentId}>
                <strong>{agentName(entry.agentId)}</strong> ·{" "}
                {entry.targetMode === "existing"
                  ? "当前原生配置"
                  : "当前便携配置"}
                <br />
                {entry.previousProviderName} / {entry.previousModel}
                {entry.previousReasoningEffort
                  ? ` / ${entry.previousReasoningEffort}`
                  : ""}{" "}
                → {entry.providerName} / {entry.model}
                {entry.reasoningEffort
                  ? ` / ${entry.reasoningEffort}`
                  : " / 客户端默认"}
              </li>
            ))}
          </ul>
          <div className="hub-config-profile-actions">
            <button
              type="button"
              className="hub-button primary"
              disabled={locked}
              onClick={() =>
                void run(async () => {
                  const result = await configProfilesApi.apply({
                    id: preview.id,
                    revision: preview.revision,
                    fingerprint: preview.fingerprint,
                  });
                  setPreview(null);
                  setMessage(
                    `方案“${preview.name}”已应用至 ${result.appliedAgentIds.length} 个客户端，请重新加载配置。`,
                  );
                  await onApplied?.(result, preview);
                })
              }
            >
              应用此方案
            </button>
            <button
              type="button"
              className="hub-button secondary"
              disabled={locked}
              onClick={() => setPreview(null)}
            >
              取消预览
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="hub-config-profile-error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="hub-profile-note">
          {message}
        </p>
      )}
    </section>
  );
}
