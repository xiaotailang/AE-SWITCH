import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Cpu,
  Eye,
  EyeOff,
  FolderOpen,
  Globe2,
  KeyRound,
  LoaderCircle,
  Moon,
  Radio,
  RefreshCw,
  ShieldCheck,
  Sun,
  Terminal,
  X,
  Zap,
} from "lucide-react";
import { api, desktopRuntime, errorMessage } from "./lib/api";
import {
  agentApi,
  agentCatalog,
  type AgentId,
  type AgentProbe,
  type ExistingProfile,
  type InstalledAgentDiscovery,
  type WorkBuddyDefaultSelection,
} from "./lib/agentApi";
import { useConnectionDiscovery } from "./lib/useConnectionDiscovery";
import { WindowChrome } from "./components/WindowChrome";
import { TutorialDialog } from "./components/TutorialDialog";
import { APP_VERSION } from "./lib/appVersion";
import { projectUrl } from "./lib/projectLinks";
import type { Provider, ProviderInput } from "./types";
import claudeCodeLogo from "./assets/agents/claude-code.png";
import codexLogo from "./assets/agents/codex.png";
import codexLightLogo from "./assets/brands/codex.png";
import hermesLogo from "./assets/agents/hermes.svg";
import ohMyPiLogo from "./assets/agents/oh-my-pi.svg";
import openCodeDarkLogo from "./assets/agents/opencode-dark.svg";
import openCodeLightLogo from "./assets/agents/opencode-light.svg";
import zcodeLogo from "./assets/agents/zcode.png";
import workBuddyLogo from "./assets/agents/workbuddy.svg";
import deepSeekHarnessLogo from "./assets/agents/deepseek-harness.svg";
import "./agent-hub.css";

const DEFAULT_ENDPOINT = "https://aiease-yun.com";
const reasoningLabels: Record<string, string> = {
  none: "不思考（none）",
  minimal: "最低（minimal）",
  low: "低（low）",
  medium: "中（medium）",
  high: "高（high）",
  xhigh: "更高（xhigh）",
  max: "最高（max）",
  ultra: "极高（ultra）",
};

const agentLogos: Record<AgentId, { dark: string; light: string }> = {
  claude_code: { dark: claudeCodeLogo, light: claudeCodeLogo },
  codex: { dark: codexLogo, light: codexLightLogo },
  hermes: { dark: hermesLogo, light: hermesLogo },
  oh_my_pi: { dark: ohMyPiLogo, light: ohMyPiLogo },
  opencode: { dark: openCodeDarkLogo, light: openCodeLightLogo },
  zcode: { dark: zcodeLogo, light: zcodeLogo },
  workbuddy: { dark: workBuddyLogo, light: workBuddyLogo },
  deepseek_harness: { dark: deepSeekHarnessLogo, light: deepSeekHarnessLogo },
};
type Notice = { tone: "success" | "error" | "info"; message: string };
type ConnectionStage = "save" | "configure" | "probe";
const verificationStages: Record<string, string> = {
  connection: "供应商连接",
  not_installed: "检查工具安装",
  not_configured: "核对当前工具配置",
  launch: "启动工具",
  configuration: "核对验证配置",
  process: "运行自动验证命令",
  timeout: "工具响应超时",
  tool_execution: "执行真实工具",
  write: "工具写入文件",
  read: "工具读取文件",
  readback: "读取内容核对",
  cleanup: "清理验证文件",
  verified: "工具写读已验证",
  unsupported: "检查工具验证支持",
};
function verificationOutcome(result: AgentProbe): {
  tone: Notice["tone"];
  status: string;
  failure?: string;
} {
  if (result.ok && result.validationScope === "tool" && result.toolVerified)
    return { tone: "success", status: "工具写读验证通过" };
  if (result.stage === "verification_error")
    return { tone: "error", status: "验证请求未完成", failure: "验证请求失败" };
  if (result.validationScope === "connection")
    return result.ok
      ? { tone: "info", status: "连接可用，工具未验证" }
      : { tone: "error", status: "连接检测未通过", failure: "连接检测失败" };
  if (result.stage === "not_installed")
    return { tone: "error", status: "工具未安装", failure: "工具未安装" };
  if (result.stage === "not_configured")
    return {
      tone: "error",
      status: "当前选择尚未配置",
      failure: "工具配置不匹配",
    };
  if (result.clientSurface === "desktop-bundled-cli")
    return {
      tone: "error",
      status: "自动文件验证未通过",
      failure: "自动文件验证未通过",
    };
  return {
    tone: "error",
    status: "真实工具验证未通过",
    failure: "真实工具验证失败",
  };
}

export default function AgentHub() {
  const client = useQueryClient();
  const [selectedAgent, setSelectedAgent] = useState<AgentId>("claude_code");
  const [providerId, setProviderId] = useState("");
  const [baseUrl, setBaseUrl] = useState(DEFAULT_ENDPOINT);
  const [apiKey, setApiKey] = useState("");
  const [name, setName] = useState("");
  const [reasoningChoice, setReasoningChoice] = useState<{
    context: string;
    value: string | null;
  } | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState<
    | "save"
    | "confirm"
    | "probe"
    | "launch"
    | "workbuddy-default"
    | "restart"
    | "directory"
    | "background"
    | null
  >(null);
  const [connectionStage, setConnectionStage] =
    useState<ConnectionStage | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [probe, setProbe] = useState<AgentProbe | null>(null);
  const [workBuddyDefault, setWorkBuddyDefault] =
    useState<WorkBuddyDefaultSelection | null>(null);
  const [help, setHelp] = useState(false);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [helpError, setHelpError] = useState("");
  const [profileChoices, setProfileChoices] = useState<
    Partial<Record<AgentId, string>>
  >({});
  const [manualProfiles, setManualProfiles] = useState<
    Partial<Record<AgentId, ExistingProfile>>
  >({});
  const [manualModes, setManualModes] = useState<
    Partial<Record<AgentId, boolean>>
  >({});
  const [directoryModes, setDirectoryModes] = useState<
    Partial<Record<AgentId, boolean>>
  >({});
  const [installationDirectories, setInstallationDirectories] = useState<
    Partial<Record<AgentId, string>>
  >({});
  const [directoryDiscoveries, setDirectoryDiscoveries] = useState<
    Partial<
      Record<AgentId, { directory: string; data: InstalledAgentDiscovery }>
    >
  >({});
  const [directoryErrors, setDirectoryErrors] = useState<
    Partial<Record<AgentId, string>>
  >({});
  const [directoryOperation, setDirectoryOperation] = useState<{
    agent: AgentId;
    kind: "identify" | "pick";
    token: number;
  } | null>(null);
  const directoryRequest = useRef(0);
  const directoryContext = useRef("");
  const [processChoices, setProcessChoices] = useState<
    Partial<Record<AgentId, string>>
  >({});
  const helpHeading = useRef<HTMLHeadingElement>(null);
  const helpTrigger = useRef<HTMLButtonElement | null>(null);
  const workBuddyAttempt = useRef<AbortController | null>(null);
  useEffect(() => {
    if (help) helpHeading.current?.focus();
  }, [help]);

  function toggleHelp(trigger: HTMLButtonElement) {
    if (!help) helpTrigger.current = trigger;
    setHelp(!help);
  }
  function closeHelp() {
    setHelp(false);
    helpTrigger.current?.focus();
  }
  const probeOutcome = probe ? verificationOutcome(probe) : null;
  const cleanupFailed =
    probe?.cleanup?.succeeded === false ||
    probe?.cleanup?.removed === false ||
    probe?.cleanup?.ok === false;
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try {
      return localStorage.getItem("ae-switch-theme") === "light"
        ? "light"
        : "dark";
    } catch {
      return "dark";
    }
  });
  useEffect(() => {
    document.documentElement.dataset.aeTheme = theme;
    try {
      localStorage.setItem("ae-switch-theme", theme);
    } catch {
      /* Theme remains usable without browser storage. */
    }
    return () => {
      delete document.documentElement.dataset.aeTheme;
    };
  }, [theme]);
  const overview = useQuery({ queryKey: ["overview"], queryFn: api.overview });
  const background = useQuery({
    queryKey: ["background"],
    queryFn: api.background,
    enabled: help && desktopRuntime,
  });
  const hub = useQuery({
    queryKey: ["agent-hub"],
    queryFn: agentApi.overview,
    refetchInterval: desktopRuntime ? 15000 : false,
  });
  const installed = useQuery({
    queryKey: ["installed-agents"],
    queryFn: agentApi.discover,
    enabled: desktopRuntime,
    staleTime: 30000,
  });
  const agents = hub.data?.agents ?? agentCatalog;
  const agent =
    agents.find((item) => item.id === selectedAgent) ?? agentCatalog[0];
  const runtimeEnabled =
    desktopRuntime &&
    agent.configured &&
    agent.mode === "existing" &&
    !!agent.configurationRevision;
  const runtime = useQuery({
    queryKey: ["agent-runtime", selectedAgent, agent.configurationRevision],
    queryFn: () => agentApi.runtime(selectedAgent),
    enabled: runtimeEnabled,
    refetchInterval: runtimeEnabled ? 5000 : false,
  });
  const runtimeCandidates = runtime.data?.candidates ?? [];
  const selectedProcess = runtimeCandidates.find(
    (candidate) =>
      `${candidate.processId}:${candidate.startTimeMs}` ===
      (processChoices[selectedAgent] ??
        (runtimeCandidates.length === 1
          ? `${runtimeCandidates[0].processId}:${runtimeCandidates[0].startTimeMs}`
          : "")),
  );
  const canRestart =
    runtimeEnabled &&
    !runtime.isFetching &&
    !runtime.isError &&
    runtime.data?.configurationRevision === agent.configurationRevision &&
    runtime.data?.platformSupported &&
    !runtime.data?.restartInProgress &&
    selectedProcess?.canRestart;
  const directoryMode = directoryModes[selectedAgent] === true;
  const installationDirectory = installationDirectories[selectedAgent] ?? "";
  directoryContext.current = JSON.stringify([
    selectedAgent,
    directoryMode,
    installationDirectory,
  ]);
  const directoryResult = directoryDiscoveries[selectedAgent];
  const detected = directoryMode
    ? directoryResult?.directory === installationDirectory.trim()
      ? directoryResult.data
      : undefined
    : installed.data;
  const directoryBusy = directoryOperation?.agent === selectedAgent;
  const detectionFetching = directoryMode
    ? directoryBusy
    : installed.isFetching;
  const detectionPending = directoryMode ? !detected : installed.isPending;
  const detectionError = directoryMode
    ? directoryErrors[selectedAgent]
    : installed.isError
      ? errorMessage(installed.error)
      : undefined;
  const installedClients =
    detected?.clients.filter((item) => item.agentId === selectedAgent) ?? [];
  const detectedProfiles = [
    ...new Map(
      installedClients
        .flatMap((item) => item.profiles)
        .map((profile) => [JSON.stringify(profile), profile]),
    ).values(),
  ];
  const manualMode = manualModes[selectedAgent] === true;
  const selectedProfile = manualMode
    ? manualProfiles[selectedAgent]
    : (detectedProfiles.find(
        (profile) => JSON.stringify(profile) === profileChoices[selectedAgent],
      ) ??
      (!directoryMode && agent.mode === "existing" && agent.profile
        ? detectedProfiles.find((profile) =>
            Object.keys({ ...profile, ...agent.profile }).every(
              (key) =>
                profile[key as keyof ExistingProfile] ===
                agent.profile?.[key as keyof ExistingProfile],
            ),
          )
        : undefined) ??
      (!detected?.limited &&
      detectedProfiles.length === 1 &&
      !profileChoices[selectedAgent]
        ? detectedProfiles[0]
        : undefined));
  const profileReady =
    !!selectedProfile &&
    [
      selectedProfile.directory,
      selectedProfile.homeDirectory,
      selectedProfile.executablePath,
      selectedProfile.workspaceDirectory,
    ].every((value) => value.trim().length > 0);
  const providers = overview.data?.providers ?? [];
  const provider = providers.find((item) => item.id === providerId);
  const target = selectedAgent === "claude_code" ? "claude_cli" : "codex";
  const discovery = useConnectionDiscovery(
    {
      providerId: provider?.id ?? null,
      baseUrl,
      apiKey: apiKey.trim() || null,
    },
    "auto",
    target,
    provider,
    "auto",
  );
  const models =
    discovery.verified && !discovery.failure
      ? discovery.models.filter(
          (model) => model.enabled && discovery.allowed(model.id),
        )
      : [];
  const selectedModel = models.find((model) => model.id === discovery.model);
  const declaredReasoningLevels = [
    ...new Set(selectedModel?.reasoningEfforts ?? []),
  ].filter((effort) => Object.hasOwn(reasoningLabels, effort));
  const reasoningLevels =
    discovery.protocol === "openai" && selectedModel
      ? declaredReasoningLevels.length
        ? declaredReasoningLevels
        : Object.keys(reasoningLabels)
      : [];
  const reasoningContext = JSON.stringify([
    selectedAgent,
    providerId,
    baseUrl,
    apiKey,
    discovery.model,
    discovery.protocol,
    declaredReasoningLevels.length > 0,
    reasoningLevels,
  ]);
  const savedReasoning =
    provider?.model === discovery.model &&
    provider.baseUrl.replace(/\/+$/, "") === baseUrl.replace(/\/+$/, "") &&
    !apiKey.trim() &&
    provider.reasoningEffort &&
    reasoningLevels.includes(provider.reasoningEffort)
      ? provider.reasoningEffort
      : null;
  const reasoningEffort =
    reasoningChoice?.context === reasoningContext
      ? reasoningChoice.value
      : savedReasoning;
  const enabled =
    desktopRuntime &&
    discovery.ready &&
    !busy &&
    !overview.isError &&
    !hub.isError;
  const canSave =
    enabled &&
    !discovery.busy &&
    discovery.syncedAt !== null &&
    models.some((model) => model.id === discovery.model);
  const canConfirm =
    canSave &&
    profileReady &&
    (manualMode ||
      (!detectionError && !detectionPending && !detectionFetching));
  const selectedProfileKey = JSON.stringify(selectedProfile);
  const workBuddyDesktop =
    selectedAgent === "workbuddy" &&
    agent.configured &&
    agent.mode === "existing" &&
    /^(WorkBuddy\.exe|WorkBuddy)$/i.test(
      agent.profile?.executablePath.split(/[\\/]/).pop() ?? "",
    );
  const canApplyWorkBuddyDefault =
    desktopRuntime &&
    workBuddyDesktop &&
    !busy &&
    selectedProfileKey === JSON.stringify(agent.profile) &&
    (!providerId || providerId === agent.providerId) &&
    (!discovery.model || discovery.model === agent.model);
  const workBuddyDefaultBusy =
    busy === "workbuddy-default" || (busy === "launch" && workBuddyDesktop);
  const workBuddyContextKey = JSON.stringify([
    selectedAgent,
    selectedProfileKey,
    providerId || agent.providerId,
    baseUrl,
    apiKey,
    discovery.model || agent.model,
    agent.configurationRevision,
    agent.profile,
    agent.providerId,
    agent.model,
  ]);
  useEffect(
    () => () => {
      if (workBuddyAttempt.current) {
        workBuddyAttempt.current.abort();
        setWorkBuddyDefault(null);
      }
      workBuddyAttempt.current = null;
    },
    [workBuddyContextKey],
  );
  useEffect(() => {
    directoryRequest.current += 1;
    setDirectoryOperation(null);
    setManualModes({});
  }, [selectedAgent]);
  useEffect(() => {
    setProbe(null);
    setNotice(null);
    setWorkBuddyDefault(null);
  }, [selectedAgent, selectedProfileKey]);
  useEffect(() => {
    if (probe && discovery.model && probe.model !== discovery.model) {
      setProbe(null);
      setNotice(null);
    }
  }, [discovery.model, probe]);
  useEffect(() => {
    if (
      workBuddyDefault &&
      discovery.model &&
      workBuddyDefault.model !== discovery.model
    )
      setWorkBuddyDefault(null);
  }, [discovery.model, workBuddyDefault]);

  function invalidateDirectorySelection() {
    directoryRequest.current += 1;
    setDirectoryOperation(null);
    setDirectoryDiscoveries((current) => ({
      ...current,
      [selectedAgent]: undefined,
    }));
    setDirectoryErrors((current) => ({
      ...current,
      [selectedAgent]: undefined,
    }));
    setProfileChoices((current) => ({ ...current, [selectedAgent]: "" }));
    setManualModes((current) => ({ ...current, [selectedAgent]: false }));
    setManualProfiles((current) => ({
      ...current,
      [selectedAgent]: undefined,
    }));
    setProbe(null);
    setNotice(null);
    setWorkBuddyDefault(null);
  }

  function updateInstallationDirectory(value: string) {
    invalidateDirectorySelection();
    directoryContext.current = JSON.stringify([
      selectedAgent,
      directoryMode,
      value,
    ]);
    setInstallationDirectories((current) => ({
      ...current,
      [selectedAgent]: value,
    }));
  }

  async function identifyInstallation(directoryOverride?: string) {
    if (busy || !desktopRuntime) return;
    invalidateDirectorySelection();
    const input = directoryOverride ?? installationDirectory;
    const directory = input.trim();
    const agentId = selectedAgent;
    if (!directory) {
      setDirectoryErrors((current) => ({
        ...current,
        [agentId]: "请先输入或选择安装目录。",
      }));
      return;
    }
    const token = ++directoryRequest.current;
    const context = JSON.stringify([agentId, directoryMode, input]);
    directoryContext.current = context;
    setDirectoryOperation({ agent: agentId, kind: "identify", token });
    try {
      const data = await agentApi.discoverDirectory(agentId, directory);
      if (
        directoryRequest.current !== token ||
        directoryContext.current !== context
      )
        return;
      setDirectoryDiscoveries((current) => ({
        ...current,
        [agentId]: { directory, data },
      }));
    } catch (error) {
      if (
        directoryRequest.current !== token ||
        directoryContext.current !== context
      )
        return;
      setDirectoryErrors((current) => ({
        ...current,
        [agentId]: errorMessage(error),
      }));
    } finally {
      if (directoryRequest.current === token) setDirectoryOperation(null);
    }
  }

  async function pickInstallationDirectory() {
    if (busy || !desktopRuntime) return;
    const agentId = selectedAgent;
    const token = ++directoryRequest.current;
    const context = directoryContext.current;
    setDirectoryOperation({ agent: agentId, kind: "pick", token });
    try {
      const directory = await agentApi.pickDirectory();
      if (
        directoryRequest.current !== token ||
        directoryContext.current !== context
      )
        return;
      if (directory !== null) {
        updateInstallationDirectory(directory);
        void identifyInstallation(directory);
      }
    } catch (error) {
      if (
        directoryRequest.current !== token ||
        directoryContext.current !== context
      )
        return;
      invalidateDirectorySelection();
      setDirectoryErrors((current) => ({
        ...current,
        [agentId]: errorMessage(error),
      }));
    } finally {
      if (directoryRequest.current === token) setDirectoryOperation(null);
    }
  }

  function chooseProvider(next?: Provider) {
    setReasoningChoice(null);
    setProviderId(next?.id ?? "");
    setBaseUrl(next?.baseUrl ?? DEFAULT_ENDPOINT);
    setApiKey("");
    setName(next?.name ?? "");
    setNotice(null);
    setProbe(null);
    setWorkBuddyDefault(null);
  }

  async function saveConnection(): Promise<Provider> {
    const ready = await discovery.ensureReady();
    if (
      !ready?.model ||
      ready.failure ||
      !ready.models.some(
        (model) =>
          model.id === ready.model &&
          model.enabled &&
          discovery.allowed(model.id),
      )
    )
      throw new Error(discovery.failure || "请先同步并选择一个可用模型。");
    const readyReasoningLevels = (
      ready.models.find((model) => model.id === ready.model)
        ?.reasoningEfforts ?? []
    ).filter((effort) => Object.hasOwn(reasoningLabels, effort));
    if (
      reasoningEffort !== null &&
      (ready.model !== discovery.model ||
        ready.protocol !== "openai" ||
        !Object.hasOwn(reasoningLabels, reasoningEffort) ||
        (readyReasoningLevels.length > 0 &&
          !readyReasoningLevels.includes(reasoningEffort)))
    )
      throw new Error("模型的思考等级信息已变化，请重新同步并选择。");
    let host = "API 供应商";
    try {
      host = new URL(baseUrl).hostname;
    } catch {
      /* Rust validates the final input as well. */
    }
    const input: ProviderInput = {
      id: provider?.id ?? null,
      family: ready.protocol === "anthropic" ? "claude" : "codex",
      name: name.trim() || host,
      baseUrl: ready.baseUrl,
      apiKey: apiKey.trim() || null,
      model: ready.model,
      authMode: ready.authMode,
      reasoningEffort,
      codexOptions: {
        fastMode: null,
        contextWindow: null,
        autoCompactTokenLimit: null,
        balanceQuery: null,
        ...provider?.codexOptions,
        upstreamProtocol: ready.protocol,
        protocolDetectedAt: ready.syncedAt,
        models: ready.models,
        modelsSyncedAt: ready.syncedAt,
      },
    };
    const saved = await api.save(input);
    setProviderId(saved.id);
    setName(saved.name);
    setBaseUrl(saved.baseUrl);
    setApiKey("");
    await client.invalidateQueries({ queryKey: ["overview"] });
    return saved;
  }

  async function run(action: "save" | "confirm" | "probe") {
    if (action === "save" ? !canSave : !canConfirm) return;
    setBusy(action);
    setNotice(null);
    if (action !== "save") setProbe(null);
    if (action === "confirm") setWorkBuddyDefault(null);
    let stage: ConnectionStage = "save";
    setConnectionStage(stage);
    try {
      const saved = await saveConnection();
      const input = {
        agentId: selectedAgent,
        providerId: saved.id,
        model: saved.model,
        ...(selectedProfile ? { profile: selectedProfile } : {}),
      };
      if (action === "confirm") {
        stage = "configure";
        setConnectionStage(stage);
        const configured = await agentApi.configure(input);
        setWorkBuddyDefault(configured.workBuddyDefaultSelection ?? null);
        await client.invalidateQueries({ queryKey: ["agent-hub"] });
        await client.invalidateQueries({ queryKey: ["agent-runtime"] });
      }
      if (action === "confirm" || action === "probe") {
        stage = "probe";
        setConnectionStage(stage);
        const result = await agentApi.probe(input);
        setProbe(result);
        const outcome = verificationOutcome(result);
        const evidence =
          result.message ||
          (outcome.tone === "success"
            ? "实际工具已完成文件写入与读取核对。"
            : "请检查连接和工具验证记录。");
        setNotice({
          tone: outcome.tone,
          message:
            outcome.tone === "success"
              ? action === "confirm"
                ? `${agent.name} 已完成配置，${outcome.status}。${evidence}`
                : `${outcome.status}。${evidence}`
              : `${action === "confirm" ? "配置已写入，" : ""}${outcome.failure ? `${outcome.failure}：` : `${outcome.status}。`}${evidence}`,
        });
      } else {
        setNotice({
          tone: "success",
          message: "供应商已保存。选择已安装的 Agent，可继续配置端点。",
        });
      }
    } catch (error) {
      const reason = errorMessage(error);
      const stageName =
        stage === "save"
          ? "保存连接"
          : stage === "configure"
            ? "配置工具"
            : `${action === "confirm" ? "配置已写入，" : ""}验证请求`;
      setNotice({ tone: "error", message: `${stageName}失败：${reason}` });
      if (stage === "probe")
        setProbe({
          ok: false,
          model: discovery.model,
          latencyMs: 0,
          message: reason,
          validationScope: "tool",
          toolVerified: false,
          stage:
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "not_configured"
              ? "not_configured"
              : "verification_error",
        });
    } finally {
      setBusy(null);
      setConnectionStage(null);
    }
  }

  async function applyWorkBuddyDefault(
    signal: AbortSignal,
    waitForStartup = false,
  ) {
    // A native call has its own 12-second bound. Reserve that time before
    // retrying, so slow controls cannot extend startup retries indefinitely.
    const deadline = Date.now() + 20000;
    const retryable = new Set([
      "client_pending",
      "accessibility_pending",
      "selection_unverified",
    ]);
    try {
      for (let attempt = 0; attempt < 8 && !signal.aborted; attempt++) {
        const result = await agentApi.applyWorkBuddyDefault();
        if (signal.aborted) return;
        setWorkBuddyDefault(result);
        if (
          result.selected ||
          !waitForStartup ||
          !retryable.has(result.status) ||
          attempt === 7 ||
          Date.now() + 1000 + 12000 > deadline
        )
          return;
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", finish);
            resolve();
          };
          const timer = setTimeout(finish, 1000);
          signal.addEventListener("abort", finish, { once: true });
        });
      }
    } catch (error) {
      if (signal.aborted) return;
      setWorkBuddyDefault({
        selected: false,
        status: "error",
        model: agent.model ?? "",
        message: errorMessage(error),
      });
    }
  }

  async function localAction(
    action: "launch" | "restart" | "directory" | "workbuddy-default",
  ) {
    if (busy) return;
    if (action === "restart" && (!canRestart || !selectedProcess)) return;
    if (action === "workbuddy-default" && !canApplyWorkBuddyDefault) return;
    setBusy(action);
    if (action !== "workbuddy-default") setNotice(null);
    if (
      action === "workbuddy-default" ||
      (action === "launch" && workBuddyDesktop)
    )
      setWorkBuddyDefault(null);
    const operation =
      action === "workbuddy-default" ||
      ((action === "launch" || action === "restart") && workBuddyDesktop)
        ? new AbortController()
        : null;
    if (operation) {
      workBuddyAttempt.current?.abort();
      workBuddyAttempt.current = operation;
    }
    try {
      if (action === "launch") {
        await agentApi.launch(selectedAgent);
        if (operation?.signal.aborted) return;
        setNotice({
          tone: "info",
          message: workBuddyDesktop
            ? "已请求打开 WorkBuddy。"
            : `已请求启动 ${agent.name}。请在打开的终端中查看运行结果。`,
        });
        if (operation) await applyWorkBuddyDefault(operation.signal, true);
      } else if (action === "workbuddy-default" && operation) {
        await applyWorkBuddyDefault(operation.signal);
      } else if (action === "restart" && selectedProcess && runtime.data) {
        const result = await agentApi.restart({
          agentId: selectedAgent,
          configurationRevision: runtime.data.configurationRevision,
          processId: selectedProcess.processId,
          startTimeMs: selectedProcess.startTimeMs,
        });
        if (operation?.signal.aborted) return;
        setNotice({
          tone: result.restarted && !result.pending ? "success" : "info",
          message: result.message,
        });
        if (result.restarted && !result.pending && operation) {
          setWorkBuddyDefault(null);
          await applyWorkBuddyDefault(operation.signal, true);
        }
        await client.invalidateQueries({ queryKey: ["agent-runtime"] });
      } else await agentApi.openDirectory();
    } catch (error) {
      if (!operation?.signal.aborted)
        setNotice({ tone: "error", message: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  async function changeBackground(enabled: boolean) {
    if (busy || !desktopRuntime || !background.data?.supported) return;
    setBusy("background");
    setHelpError("");
    try {
      client.setQueryData(["background"], await api.setBackground(enabled));
    } catch (error) {
      setHelpError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className={`agent-hub theme-${theme}${desktopRuntime ? " is-desktop" : ""}`}
    >
      <WindowChrome />
      <div className="hub-shell">
        <header className="hub-topbar" data-tauri-drag-region>
          <div className="hub-brand">
            <strong>AE Switch</strong>
            <h1>端点配置</h1>
          </div>
          <div className="hub-top-actions">
            <button
              className="hub-icon-button"
              aria-label="快速上手"
              aria-expanded={help}
              aria-controls="hub-quickstart"
              onClick={(event) => toggleHelp(event.currentTarget)}
            >
              <CircleHelp size={18} aria-hidden />
            </button>
            <button
              className="hub-icon-button"
              aria-label={theme === "dark" ? "切换浅色主题" : "切换深色主题"}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? (
                <Sun size={18} aria-hidden />
              ) : (
                <Moon size={18} aria-hidden />
              )}
            </button>
          </div>
        </header>
        <main className="hub-main">
          <nav className="hub-agent-nav" aria-label="选择 Agent">
            {agents.map((item) => (
              <button
                key={item.id}
                className={`hub-agent-item ${selectedAgent === item.id ? "selected" : ""}`}
                aria-current={selectedAgent === item.id ? "page" : undefined}
                disabled={!!busy}
                onClick={() => {
                  setSelectedAgent(item.id);
                  setNotice(null);
                }}
              >
                <span className={`hub-agent-icon brand-${item.id}`}>
                  <img
                    className="hub-agent-logo"
                    src={agentLogos[item.id][theme]}
                    alt={`${item.name} 官方图标`}
                    draggable={false}
                  />
                </span>
                <span>{item.name}</span>
                {item.configured && (
                  <span className="hub-configured-dot" title="已配置" />
                )}
              </button>
            ))}
          </nav>
          {!desktopRuntime && (
            <div className="hub-preview-note" role="note">
              当前为浏览器界面预览，未连接 Rust
              内核。真实模型查询、配置写入和验证需要打开 AE Switch 便携应用。
            </div>
          )}
          {(hub.isError || overview.isError) && (
            <div className="hub-notice error" role="alert">
              <span>
                无法读取本地配置：{errorMessage(hub.error || overview.error)}
              </span>
              <button
                onClick={() => {
                  void hub.refetch();
                  void overview.refetch();
                }}
              >
                重试
              </button>
            </div>
          )}
          {help && (
            <section
              className="hub-help"
              id="hub-quickstart"
              aria-labelledby="hub-quickstart-title"
              onKeyDown={(event) => {
                if (event.key === "Escape" && !tutorialOpen) {
                  event.preventDefault();
                  event.stopPropagation();
                  closeHelp();
                }
              }}
            >
              <div>
                <h2 id="hub-quickstart-title" ref={helpHeading} tabIndex={-1}>
                  四步连接软件
                </h2>
                <button
                  className="hub-icon-button"
                  aria-label="关闭快速上手"
                  onClick={closeHelp}
                >
                  <X size={17} aria-hidden />
                </button>
              </div>
              <ol>
                <li>输入供应商的 API 端点。</li>
                <li>输入 API Key，自动查询可用模型。</li>
                <li>选择要使用的模型。</li>
                <li>点击“确认连接”，自动配置所选软件并验证。</li>
              </ol>
              <p>
                软件需已安装。发现多个配置目录时，请选择要使用的目录。只更新连接字段，保留历史和其他设置；已打开的软件需要重新加载配置。
              </p>
              <label className="hub-background-toggle">
                <input
                  type="checkbox"
                  checked={background.data?.enabled ?? false}
                  disabled={
                    !!busy ||
                    !desktopRuntime ||
                    background.isFetching ||
                    background.isError ||
                    !background.data?.supported
                  }
                  onChange={(event) =>
                    void changeBackground(event.target.checked)
                  }
                />
                随 Windows 启动，在后台运行
              </label>
              <p>关闭窗口后继续驻留托盘；从托盘退出会停止连接。</p>
              {!desktopRuntime || background.data?.supported === false ? (
                <p>当前环境不支持修改系统启动项。</p>
              ) : null}
              {background.isError && (
                <p role="alert">
                  {errorMessage(background.error)}{" "}
                  <button
                    className="hub-profile-toggle"
                    onClick={() => void background.refetch()}
                  >
                    重新读取启动设置
                  </button>
                </p>
              )}
              {helpError && <p role="alert">{helpError}</p>}
              <div className="hub-help-links">
                <button
                  className="hub-button secondary"
                  data-dialog-return
                  onClick={() => setTutorialOpen(true)}
                >
                  完整使用说明
                </button>
                {(["source", "license"] as const).map((page) => {
                  const url = projectUrl(page);
                  return url ? (
                    <a
                      key={page}
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(event) => {
                        if (!desktopRuntime) return;
                        event.preventDefault();
                        setHelpError("");
                        void api
                          .openProjectPage(page)
                          .catch((error) => setHelpError(errorMessage(error)));
                      }}
                    >
                      {page === "source" ? "查看源码" : "完整许可"}
                    </a>
                  ) : null;
                })}
              </div>
              {!projectUrl("source") && <p>源码和完整许可随便携包提供。</p>}
            </section>
          )}
          <section
            className="hub-panel hub-connection-panel"
            aria-labelledby="connection-title"
          >
            <div className={`hub-panel-heading brand-${selectedAgent}`}>
              <img
                className="hub-agent-logo"
                src={agentLogos[selectedAgent][theme]}
                alt={`${agent.name} 官方图标`}
                draggable={false}
              />
              <h2 id="connection-title">{agent.name}</h2>
              <span
                className={`hub-state-tag ${agent.configured ? "configured" : ""}`}
              >
                {agent.configured ? "已配置" : "待配置"}
              </span>
            </div>
            <ol className="hub-step-list" aria-label="连接步骤">
              <li className={baseUrl ? "complete" : "active"}>
                <span>1</span>输入端点
              </li>
              <li
                className={
                  apiKey || provider?.hasKey
                    ? "complete"
                    : baseUrl
                      ? "active"
                      : ""
                }
              >
                <span>2</span>输入 API Key
              </li>
              <li
                className={
                  canSave ? "complete" : discovery.ready ? "active" : ""
                }
              >
                <span>3</span>选择模型
              </li>
              <li className={canConfirm ? "active" : ""}>
                <span>4</span>确认连接
              </li>
            </ol>
            <form
              className="hub-connection-form"
              onSubmit={(event) => {
                event.preventDefault();
                void run("confirm");
              }}
            >
              <div className="hub-connection-inputs">
                <div className="hub-field">
                  <label htmlFor="hub-endpoint">API 端点</label>
                  <div className="hub-input-wrap">
                    <Globe2 size={17} aria-hidden />
                    <input
                      id="hub-endpoint"
                      type="url"
                      required
                      placeholder="https://api.example.com/v1"
                      value={baseUrl}
                      disabled={!!busy}
                      spellCheck={false}
                      onChange={(event) => {
                        setReasoningChoice(null);
                        setBaseUrl(event.target.value);
                        setNotice(null);
                        setProbe(null);
                        setWorkBuddyDefault(null);
                      }}
                    />
                  </div>
                </div>
                <div className="hub-field">
                  <label htmlFor="hub-api-key">API Key</label>
                  <div className="hub-input-wrap">
                    <KeyRound size={17} aria-hidden />
                    <input
                      id="hub-api-key"
                      type={showKey ? "text" : "password"}
                      required={!provider}
                      autoComplete="off"
                      placeholder={
                        provider?.hasKey
                          ? `已保存密钥 ····${provider.keySuffix}，留空保留`
                          : "输入你的 API Key"
                      }
                      value={apiKey}
                      disabled={!!busy}
                      spellCheck={false}
                      onChange={(event) => {
                        setReasoningChoice(null);
                        setApiKey(event.target.value);
                        setNotice(null);
                        setProbe(null);
                        setWorkBuddyDefault(null);
                      }}
                    />
                    <button
                      type="button"
                      className="hub-key-toggle"
                      aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
                      aria-pressed={showKey}
                      onClick={() => setShowKey(!showKey)}
                    >
                      {showKey ? (
                        <EyeOff size={17} aria-hidden />
                      ) : (
                        <Eye size={17} aria-hidden />
                      )}
                    </button>
                  </div>
                  <p>
                    <ShieldCheck size={12} aria-hidden />
                    密钥不会显示在工作台列表中。
                  </p>
                </div>
              </div>
              <div className="hub-model-field">
                <div className="hub-model-label">
                  <label htmlFor="hub-model">默认模型</label>
                  <button
                    type="button"
                    disabled={!enabled || discovery.busy}
                    onClick={() => {
                      setProbe(null);
                      setNotice(null);
                      void discovery.refresh();
                    }}
                  >
                    <RefreshCw
                      size={13}
                      className={discovery.busy ? "hub-spinning" : ""}
                      aria-hidden
                    />
                    {discovery.busy ? "同步中" : "同步模型"}
                  </button>
                </div>
                <div className="hub-select-wrap hub-model-select">
                  <Cpu size={17} aria-hidden />
                  <select
                    id="hub-model"
                    value={models.length ? discovery.model : ""}
                    disabled={!models.length || !!busy || discovery.busy}
                    onChange={(event) => {
                      setReasoningChoice(null);
                      discovery.selectDefault(event.target.value);
                      setNotice(null);
                      setProbe(null);
                      setWorkBuddyDefault(null);
                    }}
                  >
                    {!models.length && (
                      <option value="">
                        {discovery.busy
                          ? "正在从供应商获取模型…"
                          : discovery.failure
                            ? "未能获取可用模型，请重新同步"
                            : "填写端点与密钥后自动获取"}
                      </option>
                    )}
                    {models.map((model) => (
                      <option value={model.id} key={model.id}>
                        {model.id}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={15} aria-hidden />
                </div>
                <div
                  className={`hub-model-status ${discovery.failure ? "failure" : ""}`}
                  aria-live="polite"
                >
                  {discovery.busy ? (
                    <>
                      <LoaderCircle
                        size={13}
                        className="hub-spinning"
                        aria-hidden
                      />
                      正在识别协议并获取模型列表
                    </>
                  ) : discovery.failure ? (
                    <>
                      <X size={13} aria-hidden />
                      {discovery.failure}
                    </>
                  ) : models.length ? (
                    <>
                      <Check size={13} aria-hidden />
                      {models.length} 个可用模型
                    </>
                  ) : (
                    <>
                      <Radio size={13} aria-hidden />
                      {desktopRuntime
                        ? "等待端点和 API Key"
                        : "打开便携应用后自动同步"}
                    </>
                  )}
                </div>
              </div>

              <fieldset className="hub-reasoning-settings">
                <legend>思考程度</legend>
                <div className="hub-reasoning-options">
                  {[null, ...reasoningLevels].map((effort) => (
                    <label
                      key={effort ?? "default"}
                      className={`hub-reasoning-option ${reasoningEffort === effort ? "selected" : ""}`}
                    >
                      <input
                        type="radio"
                        name="hub-reasoning"
                        value={effort ?? ""}
                        checked={reasoningEffort === effort}
                        disabled={!!busy || discovery.busy || !models.length}
                        onChange={() => {
                          setReasoningChoice({
                            context: reasoningContext,
                            value: effort,
                          });
                          setProbe(null);
                          setNotice(null);
                        }}
                      />
                      <span>
                        {effort === null ? "默认" : reasoningLabels[effort]}
                      </span>
                    </label>
                  ))}
                </div>
                <p className="hub-profile-note">
                  {declaredReasoningLevels.length && reasoningLevels.length
                    ? "仅显示供应商返回的模型等级。选择默认时保留客户端或供应商的设置；指定等级在确认连接后通过 AE 网关应用。"
                    : discovery.protocol === "anthropic"
                      ? "此连接暂不支持在 AE Switch 中设置思考等级，使用客户端或供应商的默认设置。"
                      : selectedModel
                        ? "端点未提供等级清单，以下为兼容选项，不代表已确认全部支持。可选择你已验证的等级，确认后通过 AE 网关传递，以端点响应为准；默认保留客户端设置。"
                        : "选择模型后可设置思考程度。"}
                </p>
              </fieldset>

              <details className="hub-extra-settings">
                <summary>已保存连接</summary>
                <div className="hub-provider-switch">
                  <label htmlFor="hub-provider">供应商配置</label>
                  <div className="hub-select-wrap">
                    <select
                      id="hub-provider"
                      value={providerId}
                      disabled={!!busy}
                      onChange={(event) =>
                        chooseProvider(
                          providers.find(
                            (item) => item.id === event.target.value,
                          ),
                        )
                      }
                    >
                      <option value="">＋ 添加新供应商</option>
                      {providers.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={15} aria-hidden />
                  </div>
                </div>

                <label className="hub-field">
                  供应商名称
                  <input
                    aria-label="供应商名称"
                    value={name}
                    disabled={!!busy}
                    placeholder="默认使用端点域名"
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
              </details>
              <details
                className="hub-profile-settings"
                open={
                  desktopRuntime &&
                  (!profileReady ||
                    manualMode ||
                    directoryMode ||
                    detectedProfiles.length > 1 ||
                    detected?.limited ||
                    !!detectionError)
                }
              >
                <summary>
                  {profileReady ? "客户端位置" : "选择客户端位置"}
                </summary>
                <div className="hub-field hub-installed-client">
                  <div className="hub-installed-heading">
                    <label htmlFor="hub-installed-profile">
                      已安装客户端与配置
                    </label>
                    <button
                      type="button"
                      className="hub-icon-button"
                      aria-label="重新探测工具"
                      disabled={!!busy || detectionFetching || !desktopRuntime}
                      onClick={() => {
                        setProbe(null);
                        setNotice(null);
                        if (directoryMode) void identifyInstallation();
                        else void installed.refetch();
                      }}
                    >
                      <RefreshCw
                        size={15}
                        className={detectionFetching ? "hub-spinning" : ""}
                        aria-hidden
                      />
                    </button>
                  </div>
                  {directoryMode && (
                    <div className="hub-install-directory">
                      <label htmlFor="hub-installation-directory">
                        安装目录
                      </label>
                      <div className="hub-install-directory-controls">
                        <input
                          id="hub-installation-directory"
                          value={installationDirectory}
                          placeholder="选择客户端所在的安装文件夹"
                          disabled={!!busy}
                          onChange={(event) =>
                            updateInstallationDirectory(event.target.value)
                          }
                        />
                        <button
                          type="button"
                          className="hub-button secondary"
                          disabled={!!busy || directoryBusy}
                          onClick={() => void pickInstallationDirectory()}
                        >
                          <FolderOpen size={15} aria-hidden />
                          选择目录
                        </button>
                        <button
                          type="button"
                          className="hub-button secondary"
                          disabled={
                            !!busy ||
                            directoryBusy ||
                            !installationDirectory.trim()
                          }
                          onClick={() => void identifyInstallation()}
                        >
                          {directoryBusy &&
                          directoryOperation?.kind === "identify"
                            ? "识别中…"
                            : "识别"}
                        </button>
                      </div>
                    </div>
                  )}
                  {!manualMode && (
                    <div className="hub-select-wrap">
                      <select
                        id="hub-installed-profile"
                        value={
                          selectedProfile ? JSON.stringify(selectedProfile) : ""
                        }
                        disabled={
                          !!busy || !desktopRuntime || detectionFetching
                        }
                        onChange={(event) => {
                          setProfileChoices((current) => ({
                            ...current,
                            [selectedAgent]: event.target.value,
                          }));
                          setProbe(null);
                          setNotice(null);
                        }}
                      >
                        <option value="">
                          {detectionFetching && desktopRuntime
                            ? "正在识别客户端…"
                            : detectedProfiles.length
                              ? "请选择要配置的原目录"
                              : directoryMode
                                ? "请先识别安装目录"
                                : "未发现客户端，可指定安装目录"}
                        </option>
                        {detectedProfiles.map((profile) => (
                          <option
                            key={JSON.stringify(profile)}
                            value={JSON.stringify(profile)}
                          >
                            {profile.directory} · {profile.executablePath}
                          </option>
                        ))}
                      </select>
                      <ChevronDown size={15} aria-hidden />
                    </div>
                  )}
                  <p className="hub-profile-note" aria-live="polite">
                    {detectionError
                      ? `${directoryMode ? "安装目录识别失败" : "工具探测失败"}：${detectionError}`
                      : !desktopRuntime
                        ? "在桌面应用中探测本机工具。"
                        : detectionFetching
                          ? "只读取安装位置与配置线索。"
                          : selectedProfile
                            ? `原配置：${selectedProfile.directory}`
                            : detected?.limited
                              ? `探测未完成：${detected.notes.join("；") || "未能完整扫描安装位置"}。请明确选择已有目录，或使用高级路径设置。`
                              : detectedProfiles.length
                                ? "有多个配置候选，请明确选择要使用的目录。"
                                : directoryMode
                                  ? detected
                                    ? `所选安装目录中未识别到 ${agent.name}。${installedClients.find((item) => item.reason)?.reason || "请核对目录后重新识别。"}`
                                    : "输入或选择安装目录后点击识别，原配置目录将自动确定。"
                                  : `未探测到已安装的 ${agent.name}。${installedClients.find((item) => item.reason)?.reason || "安装后重新探测，或指定安装目录。"}`}
                  </p>
                  <button
                    type="button"
                    className="hub-profile-toggle"
                    disabled={!!busy || !desktopRuntime}
                    onClick={() => {
                      invalidateDirectorySelection();
                      setDirectoryModes((current) => ({
                        ...current,
                        [selectedAgent]: !directoryMode,
                      }));
                    }}
                  >
                    {directoryMode ? "使用自动探测结果" : "指定安装目录"}
                  </button>
                  <details
                    key={selectedAgent}
                    className="hub-advanced-paths"
                    onToggle={(event) => {
                      if (!event.currentTarget.open && manualMode) {
                        setManualModes((current) => ({
                          ...current,
                          [selectedAgent]: false,
                        }));
                        setProbe(null);
                        setNotice(null);
                        setWorkBuddyDefault(null);
                      }
                    }}
                  >
                    <summary>高级路径设置</summary>
                    <p className="hub-profile-note">
                      仅在工具使用特殊原配置或环境时设置完整路径。
                    </p>
                    <button
                      type="button"
                      className="hub-profile-toggle"
                      disabled={!!busy || !desktopRuntime}
                      onClick={() => {
                        directoryRequest.current += 1;
                        setDirectoryOperation(null);
                        setManualModes((current) => ({
                          ...current,
                          [selectedAgent]: !manualMode,
                        }));
                        if (!manualMode)
                          setManualProfiles((current) => ({
                            ...current,
                            [selectedAgent]: selectedProfile ?? {
                              directory: "",
                              homeDirectory: "",
                              executablePath: "",
                              workspaceDirectory: "",
                            },
                          }));
                        setProbe(null);
                        setNotice(null);
                      }}
                    >
                      {manualMode ? "使用识别结果" : "手动设置完整路径"}
                    </button>
                    {manualMode && (
                      <div className="hub-manual-profile">
                        {(
                          [
                            ["directory", "原配置目录"],
                            ["homeDirectory", "原用户目录"],
                            ["executablePath", "客户端启动文件"],
                            ["workspaceDirectory", "工作目录"],
                          ] as const
                        ).map(([field, label]) => (
                          <label key={field}>
                            {label}
                            <input
                              value={
                                manualProfiles[selectedAgent]?.[field] ?? ""
                              }
                              disabled={!!busy}
                              onChange={(event) => {
                                setProbe(null);
                                setNotice(null);
                                setManualProfiles((current) => ({
                                  ...current,
                                  [selectedAgent]: {
                                    ...current[selectedAgent]!,
                                    [field]: event.target.value,
                                  },
                                }));
                              }}
                            />
                          </label>
                        ))}
                        <details className="hub-extra-settings">
                          <summary>
                            其它配置路径 <span>可选</span>
                          </summary>
                          {(
                            [
                              ["configFile", "主配置文件"],
                              ["secondaryConfigFile", "附加配置文件"],
                              ["builtinConfigFile", "内置模型配置文件"],
                              ["stateFile", "原状态文件"],
                              ["dataDirectory", "原数据目录"],
                              ["profileName", "Profile 名称"],
                              ["xdgConfigDirectory", "XDG 配置目录"],
                              ["xdgDataDirectory", "XDG 数据目录"],
                              ["xdgStateDirectory", "XDG 状态目录"],
                              ["xdgCacheDirectory", "XDG 缓存目录"],
                            ] as const
                          ).map(([field, label]) => (
                            <label key={field}>
                              {label}
                              <input
                                value={
                                  manualProfiles[selectedAgent]?.[field] ?? ""
                                }
                                disabled={!!busy}
                                onChange={(event) => {
                                  setProbe(null);
                                  setNotice(null);
                                  setManualProfiles((current) => {
                                    const next = { ...current[selectedAgent]! };
                                    if (event.target.value)
                                      next[field] = event.target.value;
                                    else delete next[field];
                                    return {
                                      ...current,
                                      [selectedAgent]: next,
                                    };
                                  });
                                }}
                              />
                            </label>
                          ))}
                        </details>
                      </div>
                    )}
                  </details>
                  <p className="hub-profile-note">
                    配置端点、认证、模型路由及明确选择的思考程度，保留原历史及其他设置。
                  </p>
                </div>
              </details>
              <div className="hub-form-actions">
                {!profileReady && (
                  <button
                    type="button"
                    className="hub-button secondary"
                    disabled={!canSave}
                    onClick={() => void run("save")}
                  >
                    <ArrowDownToLine size={16} aria-hidden />
                    仅保存
                  </button>
                )}
                <button
                  type="submit"
                  className="hub-button primary"
                  disabled={!canConfirm}
                  aria-live="polite"
                >
                  {busy === "confirm" ? (
                    <LoaderCircle
                      className="hub-spinning"
                      size={16}
                      aria-hidden
                    />
                  ) : (
                    <Zap size={16} aria-hidden />
                  )}
                  {busy === "confirm"
                    ? connectionStage === "save"
                      ? "正在保存连接…"
                      : connectionStage === "configure"
                        ? "正在配置工具…"
                        : "正在验证工具…"
                    : "确认连接"}
                  <ArrowRight size={15} aria-hidden />
                </button>
              </div>

              <p className="hub-apply-note">
                连接后请保持 AE Switch 在后台运行。
              </p>
            </form>
            {notice && (
              <div
                className={`hub-notice ${notice.tone}`}
                role={notice.tone === "error" ? "alert" : "status"}
              >
                {notice.tone === "success" ? (
                  <CheckCircle2 size={18} aria-hidden />
                ) : notice.tone === "error" ? (
                  <X size={18} aria-hidden />
                ) : (
                  <Activity size={18} aria-hidden />
                )}
                <span>{notice.message}</span>
                <button
                  className="hub-icon-button"
                  aria-label="关闭提示"
                  onClick={() => setNotice(null)}
                >
                  <X size={15} aria-hidden />
                </button>
              </div>
            )}

            {probe && (
              <div className="hub-connection-result">
                <div
                  className={`hub-probe-status ${probeOutcome?.tone === "success" ? "passed" : probeOutcome?.tone === "error" ? "failed" : ""}`}
                  aria-live="polite"
                >
                  <span className="hub-probe-dot" />
                  <span>{probeOutcome?.status}</span>
                </div>
                <div className="hub-verification-result">
                  {verificationStages[probe.stage] && (
                    <p className="hub-verification-stage">
                      验证阶段：{verificationStages[probe.stage]}
                    </p>
                  )}
                  <p className="hub-verification-message">{probe.message}</p>
                  {!probe.toolVerified && probe.diagnostic && (
                    <details className="hub-verification-diagnostic">
                      <summary>查看验证原因</summary>
                      <pre>{probe.diagnostic}</pre>
                    </details>
                  )}
                  {probe.clientSurface === "desktop-bundled-cli" && (
                    <p className="hub-verification-scope hub-profile-note">
                      自动验证使用 ZCode 内置命令行，与桌面会话分开运行。
                      {probe.toolVerified
                        ? "本次文件写读已通过，桌面会话尚未自动验证。"
                        : "此结果仅表示自动文件验证未通过，不代表桌面客户端不可用。"}
                    </p>
                  )}
                  {probe.toolVerified &&
                    probe.clientSurface === "headless-cli" && (
                      <p className="hub-verification-scope hub-profile-note">
                        {probe.explicitModelArgument
                          ? "本次通过命令行入口并显式指定模型；桌面界面与默认模型选择尚未验证。"
                          : probe.nativeDefaultModelVerified
                            ? "原配置的默认模型已用于本次命令行验证；桌面界面与已有会话尚未验证。"
                            : "本次已验证命令行工具；原入口的默认模型与桌面界面尚未验证。"}
                      </p>
                    )}
                  {cleanupFailed ? (
                    <p className="hub-verification-cleanup failure">
                      验证临时文件清理未完成
                    </p>
                  ) : probe.cleanup?.removed === true ||
                    probe.cleanup?.succeeded === true ? (
                    <p className="hub-verification-cleanup">
                      验证临时文件已清理
                    </p>
                  ) : probe.cleanup?.ok === true ? (
                    <p className="hub-verification-cleanup">验证清理已完成</p>
                  ) : null}
                </div>
              </div>
            )}
            {agent.needsRestart && (
              <p className="hub-profile-note">
                新配置需要客户端重新加载；既有进程尚未验证已重启。
              </p>
            )}
            {workBuddyDesktop && (workBuddyDefault || workBuddyDefaultBusy) && (
              <div
                className={`hub-notice ${workBuddyDefault?.selected ? "success" : "info"}`}
                role="status"
                aria-label="WorkBuddy 默认模型状态"
              >
                {workBuddyDefault?.selected ? (
                  <CheckCircle2 size={18} aria-hidden />
                ) : (
                  <Activity size={18} aria-hidden />
                )}
                <span>
                  {workBuddyDefaultBusy ? (
                    busy === "launch" ? (
                      "正在等待 WorkBuddy 启动并应用默认模型…"
                    ) : (
                      "正在应用 WorkBuddy 默认模型…"
                    )
                  ) : (
                    <>
                      {workBuddyDefault?.selected
                        ? `WorkBuddy 默认模型已应用：${workBuddyDefault.model}`
                        : "WorkBuddy 默认模型尚未应用"}
                      {workBuddyDefault?.message && (
                        <p className="hub-profile-note">
                          {workBuddyDefault.message}
                        </p>
                      )}
                    </>
                  )}
                </span>
              </div>
            )}
            <details className="hub-client-actions">
              <summary>客户端操作</summary>
              <section aria-label={agent.name}>
                <dl className="hub-agent-properties">
                  <div>
                    <dt>当前模型</dt>
                    <dd>{agent.model || "尚未配置"}</dd>
                  </div>
                  {agent.reasoningEffort && (
                    <div>
                      <dt>思考程度</dt>
                      <dd>
                        {reasoningLabels[agent.reasoningEffort] ??
                          agent.reasoningEffort}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>配置范围</dt>
                    <dd>
                      {!agent.configured
                        ? "待配置已有客户端"
                        : agent.mode === "private"
                          ? "旧版私有配置"
                          : "既有客户端原配置"}
                    </dd>
                  </div>
                </dl>
                <button
                  className="hub-button hub-launch-button"
                  disabled={
                    !desktopRuntime ||
                    !agent.configured ||
                    !(agent.canLaunch ?? !!agent.launcher) ||
                    !!busy
                  }
                  onClick={() => void localAction("launch")}
                >
                  {busy === "launch" ? (
                    <LoaderCircle
                      size={16}
                      className="hub-spinning"
                      aria-hidden
                    />
                  ) : (
                    <Terminal size={16} aria-hidden />
                  )}
                  启动 {agent.name}
                  <ArrowRight size={15} aria-hidden />
                </button>
                <p className="hub-launch-note">
                  {agent.launchReason ||
                    (selectedAgent === "deepseek_harness"
                      ? "需要在终端提供任务后执行；空任务不会启动。"
                      : agent.mode === "existing"
                        ? "使用原客户端与原配置目录启动，继续沿用原历史。"
                        : agent.launcher
                          ? "启动脚本已生成，运行结果将在终端显示。"
                          : "探测并确认既有客户端，配置后验证实际工具。")}
                </p>

                {workBuddyDesktop && (
                  <button
                    className="hub-button secondary"
                    disabled={!canApplyWorkBuddyDefault}
                    onClick={() => void localAction("workbuddy-default")}
                  >
                    {busy === "workbuddy-default" ? (
                      <LoaderCircle
                        size={16}
                        className="hub-spinning"
                        aria-hidden
                      />
                    ) : (
                      <Cpu size={16} aria-hidden />
                    )}
                    应用 WorkBuddy 默认模型
                  </button>
                )}

                {runtimeEnabled && (
                  <div className="hub-client-runtime">
                    <label htmlFor="hub-running-client">运行中的客户端</label>
                    <select
                      id="hub-running-client"
                      value={
                        selectedProcess
                          ? `${selectedProcess.processId}:${selectedProcess.startTimeMs}`
                          : ""
                      }
                      disabled={!!busy || runtime.isFetching}
                      onChange={(event) =>
                        setProcessChoices((current) => ({
                          ...current,
                          [selectedAgent]: event.target.value,
                        }))
                      }
                    >
                      <option value="">
                        {runtimeCandidates.length > 1
                          ? "请选择要重新打开的实例"
                          : "未检测到可确认的实例"}
                      </option>
                      {runtimeCandidates.map((candidate) => (
                        <option
                          key={`${candidate.processId}:${candidate.startTimeMs}`}
                          value={`${candidate.processId}:${candidate.startTimeMs}`}
                        >
                          PID {candidate.processId} ·{" "}
                          {candidate.workspaceDirectory}
                        </option>
                      ))}
                    </select>
                    <button
                      className="hub-button hub-launch-button"
                      disabled={!!busy || !canRestart}
                      onClick={() => void localAction("restart")}
                    >
                      <RefreshCw
                        size={16}
                        className={busy === "restart" ? "hub-spinning" : ""}
                        aria-hidden
                      />
                      安全重启 {agent.name}
                    </button>
                    <p className="hub-profile-note" aria-live="polite">
                      {runtime.isError
                        ? errorMessage(runtime.error)
                        : runtime.data?.pendingMessage ||
                          selectedProcess?.reason ||
                          runtime.data?.reason ||
                          (runtime.isPending
                            ? "正在确认原客户端进程…"
                            : "桌面程序请求正常退出后重开；终端客户端等待你正常退出后重开，历史保留，新会话加载最新配置。")}
                    </p>
                  </div>
                )}
                <button
                  className="hub-button secondary hub-test-button"
                  disabled={!canConfirm}
                  onClick={() => void run("probe")}
                >
                  重新验证工具
                </button>
                <button
                  className="hub-button secondary"
                  disabled={!desktopRuntime || !!busy}
                  onClick={() => void localAction("directory")}
                >
                  <FolderOpen size={15} aria-hidden />
                  打开便携目录
                </button>
              </section>
            </details>
            {agent.warnings?.map((warning) => (
              <p className="hub-profile-note hub-client-warning" key={warning}>
                {warning}
              </p>
            ))}
          </section>
          <footer className="hub-footer">
            <span>AE Switch v{APP_VERSION}</span>
          </footer>
        </main>
      </div>
      {tutorialOpen && (
        <TutorialDialog onClose={() => setTutorialOpen(false)} />
      )}
    </div>
  );
}
