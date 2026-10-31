import { useEffect, useState } from "react";

const storageKey = "ae-switch-model-preferences-v1";
const changedEvent = "ae-switch-model-preferences-changed";
const maximumEntries = 200;
export interface ModelPreferences {
  favorites: string[];
  recent: Record<string, number>;
}
type ModelScope = { favorites?: unknown; recent?: unknown };
const empty = (): ModelPreferences => ({ favorites: [], recent: {} });
const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  !/[\u0000-\u001f\u007f]/.test(value);
const scopeKey = (agentId: string, providerId: string) =>
  JSON.stringify([agentId, providerId]);

function readAll(): Record<string, ModelScope> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) || "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, ModelScope>)
      : {};
  } catch {
    return {};
  }
}

export function loadModelPreferences(
  agentId: string,
  providerId: string,
): ModelPreferences {
  const value = readAll()[scopeKey(agentId, providerId)];
  if (!value || typeof value !== "object") return empty();
  const favorites = Array.isArray(value.favorites)
    ? [...new Set(value.favorites.filter(validId))].slice(0, maximumEntries)
    : [];
  const recent =
    value.recent &&
    typeof value.recent === "object" &&
    !Array.isArray(value.recent)
      ? (Object.fromEntries(
          Object.entries(value.recent)
            .filter(
              ([id, timestamp]) =>
                validId(id) &&
                typeof timestamp === "number" &&
                Number.isFinite(timestamp) &&
                timestamp > 0,
            )
            .sort((a, b) => Number(b[1]) - Number(a[1]))
            .slice(0, maximumEntries),
        ) as Record<string, number>)
      : {};
  return { favorites, recent };
}

function saveModelPreferences(
  agentId: string,
  providerId: string,
  value: ModelPreferences,
) {
  try {
    // Only opaque connection IDs, client IDs, model IDs and timestamps belong here.
    const all = readAll();
    all[scopeKey(agentId, providerId)] = value;
    const entries = Object.entries(all).slice(-100);
    localStorage.setItem(
      storageKey,
      JSON.stringify(Object.fromEntries(entries)),
    );
    window.dispatchEvent(new Event(changedEvent));
  } catch {
    /* Preferences cannot block configuration. */
  }
}

export function toggleFavoriteModel(
  agentId: string,
  providerId: string,
  model: string,
) {
  if (!validId(model) || !providerId) return;
  const preferences = loadModelPreferences(agentId, providerId);
  preferences.favorites = preferences.favorites.includes(model)
    ? preferences.favorites.filter((id) => id !== model)
    : [model, ...preferences.favorites].slice(0, maximumEntries);
  saveModelPreferences(agentId, providerId, preferences);
}

/** Call after a successful configuration, so a cancelled draft is never "used". */
export function rememberModelUse(
  agentId: string,
  providerId: string,
  model: string,
  now = Date.now(),
) {
  if (!validId(model) || !providerId || !Number.isFinite(now) || now <= 0)
    return;
  const preferences = loadModelPreferences(agentId, providerId);
  preferences.recent = Object.fromEntries(
    Object.entries({ ...preferences.recent, [model]: now })
      .sort((a, b) => b[1] - a[1])
      .slice(0, maximumEntries),
  );
  saveModelPreferences(agentId, providerId, preferences);
}

export function useModelPreferences(agentId: string, providerId: string) {
  const [preferences, setPreferences] = useState(() =>
    loadModelPreferences(agentId, providerId),
  );
  useEffect(() => {
    const refresh = () =>
      setPreferences(loadModelPreferences(agentId, providerId));
    refresh();
    window.addEventListener(changedEvent, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(changedEvent, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [agentId, providerId]);
  return preferences;
}
