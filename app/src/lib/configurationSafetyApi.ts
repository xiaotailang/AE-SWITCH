import { invoke } from "@tauri-apps/api/core";
import { desktopRuntime } from "./api";
import type { AgentId } from "./agentApi";

export interface ConfigurationSafety {
  status: "healthy" | "drifted" | "untracked";
  canDisconnect: boolean;
  previewToken: string | null;
  files: Array<{
    slot: string;
    managedFields: number;
    changedFields: number;
  }>;
}

function requireDesktop() {
  if (!desktopRuntime)
    throw new Error("请在 AE Switch 桌面应用中检查和恢复配置。");
}

export const configurationSafetyApi = {
  inspect: async (agentId: AgentId): Promise<ConfigurationSafety> => {
    requireDesktop();
    return invoke("agent_configuration_safety", { agentId });
  },
  disconnect: async (agentId: AgentId, previewToken: string): Promise<void> => {
    requireDesktop();
    return invoke("disconnect_agent", { agentId, previewToken });
  },
};
