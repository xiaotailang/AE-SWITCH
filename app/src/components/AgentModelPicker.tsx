import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Search, Star } from "lucide-react";
import type { ProviderModel } from "../types";
import {
  toggleFavoriteModel,
  useModelPreferences,
} from "../lib/modelPreferences";

export function AgentModelPicker({
  agentId,
  providerId,
  models,
  model,
  disabled = false,
  onChange,
  id = "hub-model",
  emptyLabel = "请选择模型",
}: {
  agentId: string;
  providerId: string;
  models: ProviderModel[];
  model: string;
  disabled?: boolean;
  onChange: (id: string) => void;
  id?: string;
  emptyLabel?: string;
}) {
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"all" | "favorites" | "recent">("all");
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const activeView = preferencesOpen ? view : "all";
  const preferences = useModelPreferences(agentId, providerId);
  const recentUse = (id: string) =>
    Object.hasOwn(preferences.recent, id) ? preferences.recent[id] : 0;
  useEffect(() => {
    setSearch("");
    setView("all");
    setPreferencesOpen(false);
  }, [agentId, providerId]);
  const available = models.filter((entry) => entry.enabled);
  const matching = useMemo(() => {
    const words = search
      .trim()
      .toLocaleLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    return available
      .filter(
        (entry) =>
          words.every((word) => entry.id.toLocaleLowerCase().includes(word)) &&
          (activeView === "all" ||
            (activeView === "favorites"
              ? preferences.favorites.includes(entry.id)
              : !!recentUse(entry.id))),
      )
      .sort(
        (a, b) =>
          Number(b.id === model) - Number(a.id === model) ||
          Number(preferences.favorites.includes(b.id)) -
            Number(preferences.favorites.includes(a.id)) ||
          recentUse(b.id) - recentUse(a.id) ||
          a.id.localeCompare(b.id),
      );
  }, [models, search, activeView, model, preferences]);
  const selected = available.some((entry) => entry.id === model);
  const favorite = preferences.favorites.includes(model);
  const counts = {
    favorites: available.filter((entry) =>
      preferences.favorites.includes(entry.id),
    ).length,
    recent: available.filter((entry) => !!recentUse(entry.id)).length,
  };
  return (
    <div className="hub-model-picker">
      <div className="hub-model-search">
        <Search size={15} aria-hidden />
        <input
          aria-label="搜索模型"
          placeholder="搜索模型名称"
          value={search}
          disabled={disabled}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && search) {
              event.preventDefault();
              event.stopPropagation();
              setSearch("");
            }
          }}
        />
      </div>
      <div className="hub-select-wrap hub-model-select">
        <select
          id={id}
          aria-label="默认模型"
          value={model}
          disabled={disabled || !available.length}
          onChange={(event) => onChange(event.target.value)}
        >
          {!selected && <option value="">{emptyLabel}</option>}
          {selected && !matching.some((entry) => entry.id === model) && (
            <option value={model}>{model}</option>
          )}
          {matching.map((entry) => (
            <option value={entry.id} key={entry.id}>
              {entry.id}
            </option>
          ))}
        </select>
        <ChevronDown size={16} aria-hidden />
      </div>
      {!matching.length && (
        <p className="hub-profile-note" aria-live="polite">
          {search.trim()
            ? "没有匹配的模型"
            : activeView === "favorites"
              ? "尚未收藏可用模型。选择模型后点击星标收藏。"
              : activeView === "recent"
                ? "确认连接后，成功使用的模型会显示在这里。"
                : "请先查询可用模型。"}
        </p>
      )}
      {matching.length > 0 && (search.trim() || activeView !== "all") && (
        <p className="hub-profile-note" aria-live="polite">
          显示 {matching.length} / {available.length} 个可用模型
        </p>
      )}
      <details
        className="hub-model-preferences"
        open={preferencesOpen}
        onToggle={(event) => setPreferencesOpen(event.currentTarget.open)}
      >
        <summary>常用模型</summary>
        {preferencesOpen && (
          <div className="hub-model-preference-controls">
            <div
              className="hub-model-filters"
              role="group"
              aria-label="模型列表筛选"
            >
              {(
                [
                  ["all", `全部 ${available.length}`],
                  ["favorites", `收藏 ${counts.favorites}`],
                  ["recent", `最近使用 ${counts.recent}`],
                ] as const
              ).map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={view === value}
                  disabled={disabled}
                  onClick={() => setView(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className={`hub-model-favorite ${favorite ? "is-favorite" : ""}`}
              aria-label={`${favorite ? "取消收藏" : "收藏"} ${model || "当前模型"}`}
              aria-pressed={favorite}
              disabled={disabled || !providerId || !selected}
              onClick={() => toggleFavoriteModel(agentId, providerId, model)}
            >
              <Star
                size={14}
                aria-hidden
                fill={favorite ? "currentColor" : "none"}
              />
              {favorite ? "已收藏当前模型" : "收藏当前模型"}
            </button>
          </div>
        )}
      </details>
    </div>
  );
}
