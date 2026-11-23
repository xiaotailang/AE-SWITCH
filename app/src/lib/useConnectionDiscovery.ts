import { useEffect, useRef, useState } from "react";
import { api, desktopRuntime, errorMessage } from "./api";
import { contextTokens, DEFAULT_MODEL_CONTEXT } from "./modelContext";
import { desktopModelAllowed } from "./useModelDiscovery";
import { providerProtocol } from "./protocolConversion";
import type {
  ConnectionInput,
  Provider,
  ProviderModel,
  Target,
} from "../types";
type Protocol = "openai" | "anthropic";
export type ProtocolPreference = Protocol | "auto";
export type AuthPreference = Provider["authMode"] | "auto";
export { providerProtocol } from "./protocolConversion";
export function codingModel(id: string) {
  return !/(embedding|dall-e|whisper|tts|moderation|rerank|(?:^|[-/])(image|audio|video|sora)(?:[-/]|$))/i.test(
    id,
  );
}
export function modelAllowed(id: string, target: Target, protocol: Protocol) {
  return (
    codingModel(id) &&
    (target !== "claude_desktop" ||
      protocol === "openai" ||
      desktopModelAllowed(id))
  );
}
const modelOrder = new Intl.Collator("en", { numeric: true });

export function recommendedModel(models: ProviderModel[], protocol: Protocol) {
  const familyScore = (id: string) => {
    const name = id.split("/").at(-1)?.toLowerCase() ?? id;
    const family =
      protocol === "anthropic"
        ? name.startsWith("claude-sonnet-")
          ? 100
          : name.startsWith("claude-opus-")
            ? 90
            : name.startsWith("claude-haiku-")
              ? 80
              : 0
        : name.startsWith("gpt-")
          ? 100
          : /^o[134](?:-|$)/.test(name)
            ? 90
            : 0;
    return (
      family +
      (/codex/.test(name) ? 10 : 0) -
      (family && /(?:^|-)(?:mini|nano)(?:-|$)/.test(name) ? 3 : 0)
    );
  };
  return (
    [...models].sort((a, b) => {
      const aFamily = familyScore(a.id);
      const bFamily = familyScore(b.id);
      return (
        Number(b.reasoningEfforts.length > 0) -
          Number(a.reasoningEfforts.length > 0) ||
        bFamily - aFamily ||
        Number(b.contextWindow !== null) - Number(a.contextWindow !== null) ||
        (aFamily
          ? modelOrder.compare(b.id, a.id)
          : modelOrder.compare(a.id, b.id)) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      );
    })[0]?.id || ""
  );
}

function validEndpoint(value: string): URL | null {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
      ? url
      : null;
  } catch {
    return null;
  }
}

function endpointIdentity(url: URL | null): string | null {
  return url?.href.replace(/\/+$/, "") ?? null;
}
export function useConnectionDiscovery(
  input: ConnectionInput,
  authMode: AuthPreference,
  target: Target,
  provider?: Provider,
  protocol: ProtocolPreference = "auto",
  contextMode: "legacy" | "endpoint" = "legacy",
) {
  const endpoint = validEndpoint(input.baseUrl);
  const savedEndpoint = validEndpoint(provider?.baseUrl ?? "");
  const inputEndpoint = endpointIdentity(endpoint);
  const selectedProvider =
    provider?.id === input.providerId ? provider : undefined;
  const needsEndpointKey = !(
    selectedProvider?.hasKey &&
    endpoint &&
    endpoint.origin === savedEndpoint?.origin
  );
  const explicitKey = input.apiKey?.trim() || null;
  const ready =
    !!endpoint &&
    !!(explicitKey || !needsEndpointKey) &&
    !/[\u0000-\u001f\u007f]/.test(input.apiKey || "");
  const endpointProvider =
    selectedProvider &&
    inputEndpoint &&
    inputEndpoint === endpointIdentity(savedEndpoint)
      ? selectedProvider
      : undefined;
  const fallbackProtocol =
    protocol !== "auto"
      ? protocol
      : endpointProvider
        ? providerProtocol(endpointProvider)
        : "openai";
  const savedConnectionMatches =
    !!endpointProvider &&
    !explicitKey &&
    !needsEndpointKey &&
    (authMode === "auto" || authMode === endpointProvider.authMode) &&
    (protocol === "auto" || protocol === providerProtocol(endpointProvider));
  const savedCatalog =
    contextMode === "legacy" || savedConnectionMatches
      ? endpointProvider
      : undefined;
  const signature = JSON.stringify([
    inputEndpoint ?? input.baseUrl,
    input.providerId,
    explicitKey,
    contextMode === "endpoint" && !explicitKey && selectedProvider
      ? [
          selectedProvider.updatedAt,
          selectedProvider.authMode,
          selectedProvider.hasKey,
          selectedProvider.keySuffix,
        ]
      : null,
    authMode,
    target,
    protocol,
    contextMode,
  ]);
  const legacy = contextMode === "legacy";
  const initialModel = legacy ? savedCatalog?.model || "" : "";
  const initialModels = legacy
    ? [...(savedCatalog?.codexOptions?.models ?? [])]
    : [];
  if (initialModel && !initialModels.some((m) => m.id === initialModel))
    initialModels.unshift({
      id: initialModel,
      enabled: true,
      contextWindow: target === "codex" ? DEFAULT_MODEL_CONTEXT : null,
      reasoningEfforts: [],
    });
  const [state, setState] = useState({
    signature,
    providerId: input.providerId,
    inputEndpoint,
    baseUrl: input.baseUrl,
    models: initialModels,
    contexts: Object.fromEntries(
      initialModels.map((m) => [
        m.id,
        String((m.contextWindow ?? DEFAULT_MODEL_CONTEXT) / 1000),
      ]),
    ),
    originalContexts: Object.fromEntries(
      initialModels.map((m) => [m.id, m.contextWindow]),
    ) as Record<string, number | null>,
    editedContextModelIds: [] as string[],
    model: initialModel,
    syncedAt: legacy
      ? (savedCatalog?.codexOptions?.modelsSyncedAt ?? null)
      : null,
    protocol: fallbackProtocol as Protocol,
    authMode: (authMode === "auto"
      ? endpointProvider?.authMode || "bearer"
      : authMode) as Provider["authMode"],
    busy: false,
    failure: "",
    failureError: null as unknown,
    verified: legacy && savedConnectionMatches,
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connection = {
    input,
    inputEndpoint,
    authMode,
    ready,
    signature,
    protocol,
    target,
    savedCatalog,
    fallbackProtocol,
    contextMode,
  };
  const current = useRef(connection);
  current.current = connection;
  const inFlight = useRef<{
    signature: string;
    request: number;
    promise: Promise<typeof state | null>;
  } | null>(null);
  const allows = (id: string, resolved: Protocol) =>
    modelAllowed(id, target, resolved);
  function refresh(force = true): Promise<typeof state | null> {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const params = current.current;
    if (!params.ready || !desktopRuntime) return Promise.resolve(null);
    if (
      inFlight.current?.signature === params.signature &&
      inFlight.current.request === generation.current
    )
      return inFlight.current.promise;
    if (
      !force &&
      stateRef.current.signature === params.signature &&
      stateRef.current.model &&
      stateRef.current.verified &&
      (params.contextMode === "legacy" || stateRef.current.syncedAt !== null) &&
      !stateRef.current.failure
    )
      return Promise.resolve(stateRef.current);
    const request = ++generation.current;
    setState((s) => ({ ...s, busy: true, failure: "" }));
    const promise = (async () => {
      try {
        const result = await api.discoverConnection(
          params.input,
          params.protocol === "auto" ? null : params.protocol,
          params.authMode === "auto" ? null : params.authMode,
        );
        if (
          request !== generation.current ||
          current.current.signature !== params.signature
        )
          return null;
        if (!result.models.length)
          throw new Error("此密钥没有返回可用模型，请检查模型访问权限");
        const resolved = result.protocol || params.fallbackProtocol;
        const resolvedAuth =
          result.authMode ||
          (params.authMode === "auto"
            ? params.savedCatalog?.authMode || "bearer"
            : params.authMode);
        const resolvedEndpoint = result.baseUrl || params.input.baseUrl;
        const sameModelSource = (
          baseUrl: string,
          auth: Provider["authMode"],
          protocol: Protocol,
        ) =>
          endpointIdentity(validEndpoint(baseUrl)) ===
            endpointIdentity(validEndpoint(resolvedEndpoint)) &&
          auth === resolvedAuth &&
          protocol === resolved;
        const sourceProvider = params.savedCatalog;
        const catalogOwner =
          sourceProvider &&
          (params.contextMode === "legacy" ||
            sameModelSource(
              sourceProvider.baseUrl,
              sourceProvider.authMode,
              providerProtocol(sourceProvider),
            ))
            ? sourceProvider
            : undefined;
        const latest = stateRef.current;
        const prior =
          latest.signature === params.signature &&
          (params.contextMode === "legacy" ||
            (latest.syncedAt !== null
              ? sameModelSource(
                  latest.baseUrl,
                  latest.authMode,
                  latest.protocol,
                )
              : !!catalogOwner))
            ? latest
            : null;
        const previous = new Map(prior?.models.map((m) => [m.id, m]));
        const savedModels = new Map(
          catalogOwner?.codexOptions?.models.map((m) => [m.id, m]),
        );
        const usable = result.models.filter((m) =>
          modelAllowed(m.id, params.target, resolved),
        );
        const usableIds = new Set(usable.map((m) => m.id));
        // Keep existing choices only for models still offered by the current endpoint.
        const models = result.models.map((m) => ({
          ...m,
          contextWindow:
            params.contextMode === "endpoint"
              ? m.contextWindow
              : previous.has(m.id)
                ? previous.get(m.id)!.contextWindow
                : savedModels.has(m.id)
                  ? savedModels.get(m.id)!.contextWindow
                  : params.target === "codex"
                    ? DEFAULT_MODEL_CONTEXT
                    : m.contextWindow,
          enabled:
            usableIds.has(m.id) &&
            (previous.get(m.id)?.enabled ??
              savedModels.get(m.id)?.enabled ??
              true),
        }));
        const selected = models.filter((m) => m.enabled);
        const model =
          selected.find((m) => m.id === prior?.model)?.id ||
          selected.find((m) => m.id === catalogOwner?.model)?.id ||
          recommendedModel(
            selected.filter((m) => previous.get(m.id)?.enabled),
            resolved,
          ) ||
          recommendedModel(selected, resolved);
        const previousContexts = params.contextMode === "legacy" ? prior : null;
        const next = {
          signature: params.signature,
          providerId: params.input.providerId,
          inputEndpoint: params.inputEndpoint,
          baseUrl: resolvedEndpoint,
          model,
          syncedAt: result.syncedAt,
          protocol: resolved,
          authMode: resolvedAuth,
          busy: false,
          verified: true,
          failureError: null,
          failure: usable.length
            ? ""
            : "未找到可用于此客户端的编码模型，请检查模型访问权限",
          contexts: Object.fromEntries(
            models.map((m) => [
              m.id,
              previousContexts && Object.hasOwn(previousContexts.contexts, m.id)
                ? previousContexts.contexts[m.id]
                : String((m.contextWindow ?? DEFAULT_MODEL_CONTEXT) / 1000),
            ]),
          ),
          originalContexts: Object.fromEntries(
            models.map((m) => [
              m.id,
              previousContexts &&
              Object.hasOwn(previousContexts.originalContexts, m.id)
                ? previousContexts.originalContexts[m.id]
                : m.contextWindow,
            ]),
          ),
          editedContextModelIds:
            previousContexts?.editedContextModelIds.filter((id) =>
              models.some((m) => m.id === id && m.enabled),
            ) ?? [],
          models,
        };
        stateRef.current = next;
        setState(next);
        return next;
      } catch (error) {
        if (
          request === generation.current &&
          current.current.signature === params.signature
        ) {
          const next = {
            ...stateRef.current,
            busy: false,
            failure: errorMessage(error),
            failureError: error,
            verified:
              params.contextMode === "legacy" && stateRef.current.verified,
          };
          stateRef.current = next;
          setState(next);
          if (
            params.contextMode === "legacy" &&
            next.model &&
            next.models.some((m) => m.enabled) &&
            params.savedCatalog &&
            !params.input.apiKey
          )
            return next;
        }
        return null;
      } finally {
        if (inFlight.current?.request === request) inFlight.current = null;
      }
    })();
    inFlight.current = { signature: params.signature, request, promise };
    return promise;
  }
  useEffect(() => {
    generation.current++;
    if (stateRef.current.signature !== signature) {
      const keepChoices =
        contextMode === "legacy" &&
        stateRef.current.providerId === input.providerId &&
        stateRef.current.inputEndpoint === inputEndpoint;
      const models = keepChoices
        ? stateRef.current.models.map((m) => ({
            ...m,
            contextWindow: stateRef.current.originalContexts[m.id],
          }))
        : [];
      const next = {
        ...stateRef.current,
        signature,
        providerId: input.providerId,
        inputEndpoint,
        baseUrl: input.baseUrl,
        models,
        contexts: Object.fromEntries(
          models.map((m) => [
            m.id,
            String((m.contextWindow ?? DEFAULT_MODEL_CONTEXT) / 1000),
          ]),
        ),
        originalContexts: Object.fromEntries(
          models.map((m) => [m.id, m.contextWindow]),
        ),
        editedContextModelIds: [],
        model: keepChoices ? stateRef.current.model : "",
        syncedAt: null,
        protocol: fallbackProtocol,
        authMode:
          authMode === "auto"
            ? endpointProvider?.authMode || "bearer"
            : authMode,
        busy: false,
        failure: "",
        failureError: null,
        verified: false,
      };
      stateRef.current = next;
      setState(next);
    }
    if (ready && desktopRuntime)
      timer.current = setTimeout(() => void refresh(), 650);
    return () => {
      generation.current++;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [signature, ready]);
  const visible =
    state.signature === signature
      ? state
      : {
          ...state,
          models: [],
          contexts: {},
          editedContextModelIds: [],
          model: "",
          syncedAt: null,
          protocol: fallbackProtocol,
          authMode:
            authMode === "auto"
              ? endpointProvider?.authMode || "bearer"
              : authMode,
          busy: false,
          failure: "",
          failureError: null,
          verified: false,
        };
  const allowed = (id: string) => allows(id, visible.protocol);
  const toggle = (id: string, enabled: boolean) =>
    setState((s) => {
      if (s.signature !== current.current.signature || !allows(id, s.protocol))
        return s;
      const models = s.models.map((m) =>
        m.id === id
          ? {
              ...m,
              enabled,
              contextWindow: enabled
                ? m.contextWindow
                : s.originalContexts[m.id],
            }
          : m,
      );
      return {
        ...s,
        models,
        contexts: enabled
          ? s.contexts
          : {
              ...s.contexts,
              [id]: String(
                (s.originalContexts[id] ?? DEFAULT_MODEL_CONTEXT) / 1000,
              ),
            },
        editedContextModelIds: enabled
          ? s.editedContextModelIds
          : s.editedContextModelIds.filter((modelId) => modelId !== id),
        model: models.some((m) => m.id === s.model && m.enabled)
          ? s.model
          : recommendedModel(
              models.filter((m) => m.enabled),
              s.protocol,
            ),
      };
    });
  const selectDefault = (id: string) =>
    setState((s) =>
      s.signature === current.current.signature &&
      s.models.some((m) => m.id === id) &&
      allows(id, s.protocol)
        ? {
            ...s,
            model: id,
            models: s.models.map((m) =>
              m.id === id ? { ...m, enabled: true } : m,
            ),
          }
        : s,
    );
  const setContext = (id: string, value: string) =>
    setState((s) => {
      if (
        s.signature !== current.current.signature ||
        target !== "codex" ||
        !s.models.some((m) => m.id === id && m.enabled) ||
        !allows(id, s.protocol)
      )
        return s;
      const tokens = contextTokens(value);
      const changed =
        tokens !== null &&
        tokens !== (s.originalContexts[id] ?? DEFAULT_MODEL_CONTEXT);
      const editedContextModelIds = s.editedContextModelIds.filter(
        (modelId) => modelId !== id,
      );
      if (changed) editedContextModelIds.push(id);
      return {
        ...s,
        contexts: { ...s.contexts, [id]: value },
        editedContextModelIds,
        models: s.models.map((m) =>
          m.id === id
            ? {
                ...m,
                contextWindow:
                  changed || tokens === null ? tokens : s.originalContexts[id],
              }
            : m,
        ),
      };
    });
  const invalidContexts =
    target === "codex"
      ? visible.models
          .filter(
            (m) =>
              m.enabled &&
              contextTokens(visible.contexts[m.id] ?? "256") === null,
          )
          .map((m) => m.id)
      : [];
  return {
    ...visible,
    ready,
    needsEndpointKey,
    refresh,
    ensureReady: () => refresh(false),
    getFailure: () => stateRef.current.failureError,
    toggle,
    selectDefault,
    setContext,
    invalidContexts,
    allowed,
    preview: !desktopRuntime,
    globalContextWindow:
      savedCatalog && !savedCatalog.codexOptions?.perModelContext
        ? (savedCatalog.codexOptions?.contextWindow ?? null)
        : null,
  };
}
