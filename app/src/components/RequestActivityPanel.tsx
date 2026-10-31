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
                <ol
                  className="hub-activity-list"
                  tabIndex={0}
                  aria-label="最近请求记录"
                >
                  {records.map((record) => (
                    <li key={record.id}>
                      <div className="hub-activity-title">
                        <strong>{record.model ?? "模型未确认"}</strong>
                        <span className={`hub-activity-state ${record.state}`}>
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
                      <p className="hub-activity-usage">
                        输入 {number(record.usage.inputTokens)} / 输出{" "}
                        {number(record.usage.outputTokens)} token · 缓存读取{" "}
                        {number(record.usage.cachedTokens)} · 思考{" "}
                        {number(record.usage.reasoningTokens)}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
              <p className="hub-profile-note">
                用量仅采用响应中报告的数值，缺失显示“—”；输入包含缓存
                token。请求模型名称不代表上游实际运行的模型。首包包含协议事件，未等同于首个文字。
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
