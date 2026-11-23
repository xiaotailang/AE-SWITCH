import catalog from "../content/model-context-policies.json";
import type {
  ContextCapabilities,
  ContextPolicy,
  ProviderModel,
} from "../types";

const valid = (n: number) =>
  Number.isSafeInteger(n) && n > 0 && n <= 100_000_000;
const defaultContextWindow = 128_000;

function normalizedEndpoint(endpoint?: string): string | null {
  try {
    const url = new URL(endpoint || "");
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    return url.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function officialEndpoint(endpoint?: string): boolean {
  return normalizedEndpoint(endpoint) === "https://api.openai.com/v1";
}

export function contextSurcharge(limits: ContextCapabilities): boolean | null {
  if (limits.surcharge != null) return limits.surcharge;
  if (
    [limits.inputMultiplier, limits.outputMultiplier].some(
      (n) => n != null && n > 1,
    )
  )
    return true;
  return limits.inputMultiplier === 1 && limits.outputMultiplier === 1
    ? false
    : null;
}

export function longContextAvailable(limits: ContextCapabilities): boolean {
  return (
    contextSurcharge(limits) === true &&
    limits.longWindow > limits.standardWindow
  );
}

export function contextCapabilities(
  model?: ProviderModel,
  endpoint?: string,
): ContextCapabilities | null {
  if (!model) return null;
  const normalized = normalizedEndpoint(endpoint);
  let limits = model.contextCapabilities;
  if (
    !normalized ||
    (limits?.source !== "endpoint" &&
      !(limits?.source === "official_model" && officialEndpoint(endpoint))) ||
    !limits.endpoint ||
    normalizedEndpoint(limits.endpoint) !== normalized ||
    !/^[a-f\d]{64}$/iu.test(limits.credentialScope || "")
  )
    limits = null;
  if (!limits) {
    if (model.contextWindow == null && !/^(gpt-|o1|o3|o4)/u.test(model.id))
      return null;
    const official =
      officialEndpoint(endpoint) &&
      catalog.models.find((entry) => entry.ids.includes(model.id));
    limits = official
      ? { ...official, source: "official_model", surcharge: true }
      : {
          standardWindow: defaultContextWindow,
          longWindow: defaultContextWindow,
          source: "conservative",
          inputMultiplier: null,
          outputMultiplier: null,
          surcharge: null,
        };
  }
  if (
    !valid(limits.standardWindow) ||
    !valid(limits.longWindow) ||
    limits.longWindow < limits.standardWindow ||
    (limits.surcharge != null && typeof limits.surcharge !== "boolean") ||
    [limits.inputMultiplier, limits.outputMultiplier].some(
      (n) => n != null && (!Number.isFinite(n) || n < 1 || n > 1000),
    ) ||
    (limits.surcharge === false &&
      [limits.inputMultiplier, limits.outputMultiplier].some(
        (n) => n != null && n > 1,
      ))
  )
    return null;
  const maximum = model.contextWindow;
  if (maximum != null && !valid(maximum)) return null;
  const longWindow =
    maximum != null && valid(maximum)
      ? Math.min(maximum, limits.longWindow)
      : limits.longWindow;
  return {
    ...limits,
    surcharge: contextSurcharge(limits),
    standardWindow:
      contextSurcharge(limits) === false
        ? longWindow
        : Math.min(limits.standardWindow, longWindow),
    longWindow,
  };
}

export function contextChoice(
  model: ProviderModel,
  saved?:
    | (ContextPolicy & {
        capabilityScope?: string | null;
        contextWindow?: number;
      })
    | null,
  endpoint?: string,
): ContextPolicy {
  const limits = contextCapabilities(model, endpoint);
  return {
    model: model.id,
    longContextEnabled:
      saved?.model === model.id &&
      saved.longContextEnabled === true &&
      !!limits &&
      (saved.contextWindow === undefined ||
        (saved.contextWindow === limits.longWindow &&
          (limits.source === "conservative" ||
            (limits.source === "official_model" && !limits.credentialScope) ||
            saved.capabilityScope === limits.credentialScope))) &&
      longContextAvailable(limits),
    compactPercent:
      saved?.model === model.id &&
      Number.isInteger(saved.compactPercent) &&
      saved.compactPercent >= 1 &&
      saved.compactPercent <= 95
        ? saved.compactPercent
        : 80,
  };
}

export function effectiveContext(
  model: ProviderModel,
  choice: ContextPolicy,
  endpoint?: string,
) {
  const limits = contextCapabilities(model, endpoint);
  if (!limits) return null;
  const long = choice.model === model.id && choice.longContextEnabled;
  if (long && !longContextAvailable(limits))
    throw new Error(
      "当前端点与模型未确认可用的长上下文加价档位，请重新查询模型。",
    );
  if (
    !Number.isInteger(choice.compactPercent) ||
    choice.compactPercent < 1 ||
    choice.compactPercent > 95
  )
    throw new Error("压缩阈值必须是 1–95% 的整数。");
  const contextWindow = long ? limits.longWindow : limits.standardWindow;
  return {
    contextWindow,
    autoCompactTokenLimit: Math.floor(
      (contextWindow * choice.compactPercent) / 100,
    ),
  };
}
