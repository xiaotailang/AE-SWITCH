import { invoke } from "@tauri-apps/api/core";
import { desktopRuntime } from "./api";

export type AgentId =
  | "claude_code"
  | "codex"
  | "hermes"
  | "oh_my_pi"
  | "opencode"
  | "zcode"
  | "workbuddy"
  | "deepseek_harness";
export interface ExistingProfile {
  directory: string;
  homeDirectory: string;
  executablePath: string;
  workspaceDirectory: string;
  configFile?: string;
  secondaryConfigFile?: string;
  builtinConfigFile?: string;
  stateFile?: string;
  dataDirectory?: string;
  xdgConfigDirectory?: string;
  xdgDataDirectory?: string;
  xdgStateDirectory?: string;
  xdgCacheDirectory?: string;
  profileName?: string;
}
export interface InstalledAgent {
  agentId: AgentId;
  executablePath: string;
  profiles: ExistingProfile[];
  source: string;
  reason: string | null;
}
export interface InstalledAgentDiscovery {
  clients: InstalledAgent[];
  scannedAt: string;
  limited: boolean;
  notes: string[];
}
export interface WorkBuddyDefaultSelection {
  selected: boolean;
  status: string;
  model: string;
  message: string;
}
export interface AgentInfo {
  id: AgentId;
  name: string;
  description: string;
  protocol: string;
  configured: boolean;
  directory: string;
  launcher: string | null;
  model: string | null;
  providerId: string | null;
  mode?: "existing" | "private";
  profile?: ExistingProfile | null;
  canLaunch?: boolean;
  launchReason?: string | null;
  needsRestart?: boolean;
  warnings?: string[];
  overrideEnvironmentVariables?: string[];
  configurationRevision?: number;
  workBuddyDefaultSelection?: WorkBuddyDefaultSelection;
}
export interface AgentOverview {
  agents: AgentInfo[];
  dataDirectory: string;
  bridgeHealthy: boolean;
}
export interface AgentConfiguration {
  agentId: AgentId;
  providerId: string;
  model?: string;
  profile?: ExistingProfile;
}
export interface AgentProbe {
  ok: boolean;
  model: string;
  latencyMs: number;
  message: string;
  validationScope: "connection" | "tool";
  toolVerified: boolean;
  stage: string;
  evidence?: Record<string, unknown>;
  cleanup?: Record<string, unknown>;
  profileMode?: "existing" | "private";
  clientSurface?: "headless-cli" | "desktop-gui";
  verificationScope?: string;
  explicitModelArgument?: boolean;
  nativeDefaultModelVerified?: boolean;
  desktopGuiVerified?: boolean;
  desktopDefaultSelectionVerified?: boolean;
}
export interface ExistingRuntimeCandidate {
  processId: number;
  startTimeMs: number;
  imagePath: string;
  workspaceDirectory: string;
  clientSurface: "desktop-gui" | "interactive-cli" | "automation";
  canRestart: boolean;
  reason?: string | null;
}
export interface ExistingRuntime {
  agentId: AgentId;
  configurationRevision: number;
  appliedAtMs: number;
  platformSupported: boolean;
  running: boolean;
  restartRequired: boolean;
  canRestart: boolean;
  restartInProgress: boolean;
  pendingMessage?: string | null;
  reason?: string | null;
  candidates: ExistingRuntimeCandidate[];
}
export interface ExistingRestartInput {
  agentId: AgentId;
  configurationRevision: number;
  processId: number;
  startTimeMs: number;
}
export interface AgentRestartResult {
  restarted: boolean;
  pending: boolean;
  message: string;
}
export const agentCatalog: AgentInfo[] = [
  {
    id: "claude_code",
    name: "Claude Code",
    description: "Anthropic 编程助手",
    protocol: "anthropic",
  },
  {
    id: "codex",
    name: "Codex",
    description: "OpenAI 编程助手",
    protocol: "openai",
  },
  {
    id: "hermes",
    name: "Hermes Agent",
    description: "自主任务与工具执行",
    protocol: "openai",
  },
  {
    id: "oh_my_pi",
    name: "oh-my-pi",
    description: "可扩展的终端工作流",
    protocol: "openai",
  },
  {
    id: "opencode",
    name: "OpenCode",
    description: "开源编程工作台",
    protocol: "openai",
  },
  {
    id: "zcode",
    name: "Z Code",
    description: "多模型终端助手",
    protocol: "openai",
  },
  {
    id: "workbuddy",
    name: "WorkBuddy",
    description: "腾讯 AI 工作助手",
    protocol: "openai",
  },
  {
    id: "deepseek_harness",
    name: "DeepSeek Harness",
    description: "DeepSeek 官方编程助手",
    protocol: "openai",
  },
].map((agent) => ({
  ...agent,
  id: agent.id as AgentId,
  configured: false,
  directory: "",
  launcher: null,
  model: null,
  providerId: null,
}));

function requireDesktop() {
  if (!desktopRuntime)
    throw new Error(
      "浏览器仅用于界面预览。请打开 AE Switch 便携应用，连接 Rust 内核后执行此操作。",
    );
}
export const agentApi = {
  discover: async (): Promise<InstalledAgentDiscovery> => {
    requireDesktop();
    return invoke("agent_hub_discover");
  },
  overview: async (): Promise<AgentOverview> =>
    desktopRuntime
      ? invoke("agent_hub_overview")
      : {
          agents: agentCatalog,
          dataDirectory: "浏览器预览 · 未连接 Rust 内核",
          bridgeHealthy: false,
        },
  configure: async (input: AgentConfiguration): Promise<AgentInfo> => {
    requireDesktop();
    return invoke("configure_agent", { input });
  },
  probe: async (input: AgentConfiguration): Promise<AgentProbe> => {
    requireDesktop();
    return invoke("probe_agent", { input });
  },
  openDirectory: async (): Promise<void> => {
    requireDesktop();
    return invoke("open_portable_directory");
  },
  launch: async (agentId: AgentId): Promise<void> => {
    requireDesktop();
    return invoke("launch_agent", { agentId });
  },
  applyWorkBuddyDefault: async (): Promise<WorkBuddyDefaultSelection> => {
    requireDesktop();
    return invoke("apply_workbuddy_default_model");
  },
  runtime: async (agentId: AgentId): Promise<ExistingRuntime> => {
    requireDesktop();
    return invoke("agent_hub_runtime", { agentId });
  },
  restart: async (input: ExistingRestartInput): Promise<AgentRestartResult> => {
    requireDesktop();
    return invoke("restart_agent", { input });
  },
};
