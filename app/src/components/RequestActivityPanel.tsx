import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentApi, type AgentId, type RequestActivity } from "../lib/agentApi";
import { desktopRuntime, errorMessage } from "../lib/api";
import "./request-activity.css";

const stateNames: Record<RequestActivity["state"], string> = {
  in_progress: "进行中",
  completed: "完成",
  failed: "失败",
  interrupted: "响应中断",
  incomplete: "输出未完成",
  cancelled: "已取消",
};
const number = (value: number | null) =>
  value === null ? "—" : value.toLocaleString();

function summarize(records: RequestActivity[]) {
  let input = 0,
    output = 0,
    cacheReads = 0,
    pairedInput = 0,
    pairedCache = 0;
  let inputReported = 0,
    outputReported = 0,
    cacheReported = 0,
    cachePairs = 0;
  for (const { usage } of records) {
    if (usage.inputTokens !== null) {
      input += usage.inputTokens;
      inputReported++;
    }
    if (usage.outputTokens !== null) {
      output += usage.outputTokens;
      outputReported++;
    }
    if (usage.cachedTokens !== null) {
      cacheReads += usage.cachedTokens;
      cacheReported++;
    }
    if (
      usage.inputTokens !== null &&
      usage.cachedTokens !== null &&
      usage.inputTokens > 0 &&
      usage.cachedTokens <= usage.inputTokens
    ) {
      pairedInput += usage.inputTokens;
      pairedCache += usage.cachedTokens;
      cachePairs++;
    }
  }
  return {
    input,
    output,
    cacheReads,
    pairedInput,
    pairedCache,
    inputReported,
    outputReported,
    cacheReported,
    cachePairs,
  };
}

export function RequestActivityPanel({
  agentId,
  agentName,
}: {
  agentId: AgentId;
  agentName: string;
}) {
  const [open, setOpen] = useState(false);
  const client = useQueryClient();
  const queryKey = ["agent-activity", agentId];
  const clear = useMutation({
    mutationFn: () => agentApi.clearActivity(agentId),
    onMutate: () => client.cancelQueries({ queryKey }),
    onSuccess: (data) => client.setQueryData(queryKey, data),
  });
  const activity = useQuery({
    queryKey,
    queryFn: () => agentApi.activity(agentId),
    enabled: desktopRuntime && open && !clear.isPending,
    refetchInterval: desktopRuntime && open && !clear.isPending ? 3000 : false,
    retry: false,
  });
  const records = activity.isError ? [] : (activity.data?.records ?? []);
  const totals = summarize(records);
  return (
    <details
      className="hub-activity"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>请求活动</summary>
      {open && (
        <section aria-label={`${agentName} 请求活动`}>
          <p className="hub-profile-note">
            查看 {agentName} 通过 AE 发出的请求。所有客户端合计保留最近{" "}
            {activity.data?.capacity ?? 200} 条，重启 AE 后清空。
          </p>
          {!desktopRuntime ? (
            <p className="hub-profile-note">
              请在 AE Switch 桌面应用中查看真实请求。
            </p>
          ) : (
            <>
              <div className="hub-activity-actions">
                <button
                  type="button"
                  className="hub-button secondary"
                  disabled={activity.isFetching || clear.isPending}
                  onClick={() => void activity.refetch()}
                >
                  刷新活动
                </button>
                <button
                  type="button"
                  className="hub-button secondary"
                  disabled={!records.length || clear.isPending}
                  onClick={() => clear.mutate()}
                >
                  清空当前客户端记录
                </button>
                <span className="hub-profile-note" role="status">
                  {clear.isPending
                    ? "正在清空…"
                    : activity.isFetching
                      ? "正在更新…"
                      : `${records.length} 条记录`}
                </span>
              </div>
              {(activity.isError || clear.isError) && (
                <p role="alert" className="hub-activity-error">
                  {errorMessage(activity.error ?? clear.error)}
                </p>
              )}
              {!activity.isPending && !activity.isError && !records.length && (
                <p className="hub-profile-note">
                  暂无请求。连接客户端并发送任务后，经过 AE 的请求会显示在这里。
                </p>
              )}
              {!!records.length && (
                <>
                  <p className="hub-profile-note" aria-label="最近记录用量合计">
                    已报告 Token 合计 · 输入{" "}
                    {number(totals.inputReported ? totals.input : null)} · 输出{" "}
                    {number(totals.outputReported ? totals.output : null)} ·
                    缓存读取{" "}
                    {number(totals.cacheReported ? totals.cacheReads : null)}
                    {totals.cachePairs > 0 &&
                      ` · 缓存命中 ${((totals.pairedCache / totals.pairedInput) * 100).toFixed(1)}%（${totals.cachePairs} 条同时报告输入和缓存的记录）`}
                  </p>
                  <ol
                    className="hub-activity-list"
                    tabIndex={0}
                    aria-label="最近请求记录"
                  >
                    {records.map((record) => (
                      <li key={record.id}>
                        <div className="hub-activity-title">
                          <strong>
                            {record.configuredModel ??
                              record.model ??
                              "模型未确认"}
                          </strong>
                          <span
                            className={`hub-activity-state ${record.state}`}
                          >
                            {stateNames[record.state] ?? "未知状态"}
                            {record.status !== null
                              ? ` · HTTP ${record.status}`
                              : ""}
                          </span>
                        </div>
                        <div className="hub-activity-facts">
                          <time
                            dateTime={new Date(record.startedAt).toISOString()}
                          >
                            {new Date(record.startedAt).toLocaleTimeString()}
                          </time>
                          <span>
                            {record.endpoint} ·{" "}
                            {record.streaming ? "流式" : "非流式"}
                          </span>
                          <span>
                            耗时{" "}
                            {record.elapsedMs === null
                              ? "等待结束"
                              : `${number(record.elapsedMs)} ms`}
                          </span>
                          <span>
                            首包{" "}
                            {record.firstByteMs === null
                              ? "—"
                              : `${number(record.firstByteMs)} ms`}
                          </span>
                        </div>
                        {record.configuredModel && (
                          <p className="hub-activity-usage">
                            网关选定模型 {record.model ?? "随连接设置"} ·
                            配置思考 {record.configuredEffort ?? "默认"} ·
                            上游报告模型 {record.reportedModel ?? "—"} ·
                            上游报告思考 {record.reportedEffort ?? "—"}
                          </p>
                        )}
                        <p className="hub-activity-usage">
                          输入 {number(record.usage.inputTokens)} / 输出{" "}
                          {number(record.usage.outputTokens)} token · 缓存读取{" "}
                          {number(record.usage.cachedTokens)} · 思考{" "}
                          {number(record.usage.reasoningTokens)}
                          {record.usage.cacheWriteTokens != null &&
                            ` · 缓存写入 ${number(record.usage.cacheWriteTokens)}`}
                        </p>
                      </li>
                    ))}
                  </ol>
                </>
              )}
              <p className="hub-profile-note">
                用量仅采用响应中报告的数值，缺失显示“—”；输入包含缓存
                token。上游报告的模型和思考程度来自直接响应。首包时间包括协议事件。
              </p>
              <p className="hub-profile-note">
                记录仅在内存中保存，不保存对话、工具参数、密钥或原始错误内容。清空记录不会终止请求。
              </p>
            </>
          )}
        </section>
      )}
    </details>
  );
}
