//! Restart identified desktop clients and assist CLI restarts without killing
//! an interactive terminal or replaying its original command line.
use crate::agent_configs::{AgentId, ExistingProfile};
use crate::error::{AppError, Result};
use crate::types::Target;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[cfg(windows)]
mod windows;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRuntime {
    pub running: bool,
    pub restart_required: bool,
    pub can_restart: bool,
    pub reason: Option<String>,
    pub restart_in_progress: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartResult {
    pub restarted: bool,
    pub message: String,
    pub pending: bool,
}

#[derive(Debug, Clone)]
pub struct ExistingRestartContext {
    pub root: PathBuf,
    pub agent_id: AgentId,
    pub profile: ExistingProfile,
    pub configuration_revision: u64,
    pub applied_at_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExistingRestartInput {
    pub agent_id: AgentId,
    pub configuration_revision: u64,
    pub process_id: u32,
    pub start_time_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingProcess {
    pub process_id: u32,
    pub start_time_ms: u64,
    pub image_path: String,
    pub workspace_directory: String,
    pub client_surface: String,
    pub can_restart: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingRuntime {
    pub agent_id: AgentId,
    pub configuration_revision: u64,
    pub applied_at_ms: u64,
    pub platform_supported: bool,
    pub running: bool,
    pub restart_required: bool,
    pub can_restart: bool,
    pub restart_in_progress: bool,
    pub pending_message: Option<String>,
    pub reason: Option<String>,
    pub candidates: Vec<ExistingProcess>,
}

pub fn existing_runtime(context: &ExistingRestartContext) -> ExistingRuntime {
    #[cfg(windows)]
    {
        windows::existing::runtime(context)
    }
    #[cfg(not(windows))]
    {
        ExistingRuntime {
            agent_id: context.agent_id,
            configuration_revision: context.configuration_revision,
            applied_at_ms: context.applied_at_ms,
            platform_supported: false,
            running: false,
            restart_required: false,
            can_restart: false,
            restart_in_progress: false,
            pending_message: None,
            reason: Some("当前平台请从原终端正常退出并重新打开客户端；原历史保留".into()),
            candidates: vec![],
        }
    }
}

pub fn restart_existing(
    context: ExistingRestartContext,
    input: ExistingRestartInput,
) -> Result<RestartResult> {
    if input.agent_id != context.agent_id
        || input.configuration_revision != context.configuration_revision
        || context.configuration_revision == 0
    {
        return Err(AppError::new(
            "restart_configuration_changed",
            "配置版本已改变或尚未保存，请刷新工具状态后重试",
        ));
    }
    #[cfg(windows)]
    {
        windows::existing::restart(context, input)
    }
    #[cfg(not(windows))]
    {
        let _ = context;
        Err(AppError::new(
            "restart_unsupported",
            "此平台暂不支持既有客户端重启，请从原终端正常退出并重新打开",
        ))
    }
}

pub fn desktop_runtime(directory: &Path, revision: u64) -> DesktopRuntime {
    client_runtime(Target::Codex, directory, revision)
}

pub fn client_runtime(target: Target, directory: &Path, revision: u64) -> DesktopRuntime {
    #[cfg(windows)]
    {
        windows::client_runtime(target, directory, revision)
    }
    #[cfg(not(windows))]
    {
        let _ = (target, directory, revision);
        DesktopRuntime::default()
    }
}

pub fn restart_codex(directory: &Path) -> Result<RestartResult> {
    restart_client(Target::Codex, directory)
}

pub fn restart_client(target: Target, directory: &Path) -> Result<RestartResult> {
    #[cfg(windows)]
    {
        windows::restart_client(target, directory)
    }
    #[cfg(not(windows))]
    {
        let _ = (target, directory);
        Err(AppError::new(
            "restart_unsupported",
            "此平台暂不支持自动重启，请退出对应客户端后重新打开",
        ))
    }
}
