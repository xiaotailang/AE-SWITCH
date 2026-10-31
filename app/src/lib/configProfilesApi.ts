import { invoke } from "@tauri-apps/api/core";
import { desktopRuntime } from "./api";
import type { AgentId } from "./agentApi";

export interface ConfigProfileEntry {
  agentId: AgentId;
  providerId: string;
  model: string;
  reasoningEffort: string | null;
}
export interface ConfigProfile {
  id: string;
  name: string;
  revision: number;
  entries: ConfigProfileEntry[];
  updatedAt: number;
}
export interface SaveConfigProfileInput {
  name: string;
  id?: string;
  revision?: number;
  agentIds?: AgentId[];
}
export interface ConfigProfilePreviewEntry extends ConfigProfileEntry {
  providerName: string;
  previousProviderName: string;
  previousModel: string;
  previousReasoningEffort: string | null;
  targetMode: "existing" | "private";
  changed: boolean;
}
export interface ConfigProfilePreview {
  id: string;
  name: string;
  revision: number;
  fingerprint: string;
  entries: ConfigProfilePreviewEntry[];
}
export interface ApplyConfigProfileInput {
  id: string;
  revision: number;
  fingerprint: string;
}
export interface ApplyConfigProfileResult {
  profileId: string;
  appliedAgentIds: AgentId[];
  needsRestart: boolean;
}
function requireDesktop() {
  if (!desktopRuntime)
    throw { code: "desktop_required", message: "请在桌面端管理配置方案" };
}
export const configProfilesApi = {
  list: (): Promise<ConfigProfile[]> =>
    desktopRuntime ? invoke("list_config_profiles") : Promise.resolve([]),
  save: (input: SaveConfigProfileInput): Promise<ConfigProfile> => {
    requireDesktop();
    return invoke("save_config_profile", { input });
  },
  preview: (id: string): Promise<ConfigProfilePreview> => {
    requireDesktop();
    return invoke("preview_config_profile", { id });
  },
  apply: (
    input: ApplyConfigProfileInput,
  ): Promise<ApplyConfigProfileResult> => {
    requireDesktop();
    return invoke("apply_config_profile", { input });
  },
  delete: (id: string, revision: number): Promise<void> => {
    requireDesktop();
    return invoke("delete_config_profile", { id, revision });
  },
};
