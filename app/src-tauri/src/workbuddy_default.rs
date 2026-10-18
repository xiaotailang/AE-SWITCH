//! WorkBuddy stores the new-task choice in its account-scoped renderer state.
//! Use the native Home selector; never edit Chromium storage or an old session.
use crate::{agent_configs::ExistingProfile, error::Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultSelection {
    pub selected: bool,
    pub status: String,
    pub model: String,
    pub message: String,
}

impl DefaultSelection {
    pub(crate) fn pending(model: &str, status: &str, message: &str) -> Self {
        Self {
            selected: false,
            status: status.into(),
            model: model.into(),
            message: message.into(),
        }
    }
}

pub(crate) fn desktop_entry(profile: &ExistingProfile) -> bool {
    Path::new(&profile.executable_path)
        .file_name()
        .is_some_and(|name| {
            let name = name.to_string_lossy();
            name.eq_ignore_ascii_case("WorkBuddy.exe") || name == "WorkBuddy"
        })
}

/// Only GUI launches receive this flag. CLI probes retain their own arguments.
pub(crate) fn prepare_launch(profile: &ExistingProfile, command: &mut std::process::Command) {
    #[cfg(windows)]
    if desktop_entry(profile) {
        command.arg("--force-renderer-accessibility");
    }
    #[cfg(not(windows))]
    let _ = (profile, command);
}

pub(crate) fn apply(
    context: &crate::restart::ExistingRestartContext,
    model: &str,
) -> Result<DefaultSelection> {
    let Some(_guard) = operation_guard() else {
        return Ok(DefaultSelection::pending(
            model,
            "selection_busy",
            "正在应用 WorkBuddy 默认模型，请稍后重试。",
        ));
    };
    if !desktop_entry(&context.profile) {
        return Ok(DefaultSelection::pending(
            model,
            "not_desktop",
            "所选入口不是 WorkBuddy 桌面客户端。",
        ));
    }
    #[cfg(windows)]
    {
        Ok(windows::apply(context, model).unwrap_or_else(|_| {
            DefaultSelection::pending(
                model,
                "selection_unverified",
                "模型配置已保存，桌面默认选择尚未确认，请在空白新建任务页面重试。",
            )
        }))
    }
    #[cfg(not(windows))]
    {
        Ok(DefaultSelection::pending(
            model,
            "unsupported_platform",
            "当前平台尚不支持自动选择 WorkBuddy 桌面默认模型，请在新建任务中选择。",
        ))
    }
}

/// Restart and native selection must not act on the same desktop concurrently.
pub(crate) fn operation_guard() -> Option<std::sync::MutexGuard<'static, ()>> {
    static OPERATIONS: std::sync::Mutex<()> = std::sync::Mutex::new(());
    OPERATIONS.try_lock().ok()
}

pub fn apply_saved(
    context: crate::restart::ExistingRestartContext,
    model: String,
) -> Result<DefaultSelection> {
    apply(&context, &model)
}

#[cfg(windows)]
mod windows {
    use super::*;
    use base64::Engine;
    use std::{
        io::Write,
        os::windows::process::CommandExt,
        process::{Command, Stdio},
        time::{Duration, Instant},
    };

    pub(super) fn apply(
        context: &crate::restart::ExistingRestartContext,
        model: &str,
    ) -> Result<DefaultSelection> {
        let current = crate::agent_hub::saved_restart_context(&context.root, context.agent_id)?;
        if current.configuration_revision != context.configuration_revision
            || current.profile != context.profile
        {
            return Ok(DefaultSelection::pending(
                model,
                "configuration_changed",
                "所选配置已改变，请刷新后重试。",
            ));
        }
        // Discovery verifies installation, original HOME/config and process birth time.
        let runtime = crate::restart::existing_runtime(context);
        let candidates: Vec<_> = runtime
            .candidates
            .iter()
            .filter(|p| p.client_surface == "desktop-gui")
            .collect();
        // The official desktop also owns a daemon process using the same EXE.
        // Only the uniquely identified GUI exposes a new-task model selector.
        if candidates.len() != 1 || runtime.restart_in_progress {
            return Ok(DefaultSelection::pending(
                model,
                "client_pending",
                "请打开所选 WorkBuddy 的空白新建任务页面，再应用默认模型；已有任务保持原选择。",
            ));
        }
        let candidate = candidates[0];
        if candidate.reason.is_some() {
            return Ok(DefaultSelection::pending(
                model,
                "profile_pending",
                "无法唯一核实桌面客户端的启动参数或原配置，请从原入口正常退出后由 AE 启动。",
            ));
        }
        let config = context
            .profile
            .config_file
            .as_ref()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| Path::new(&context.profile.directory).join("models.json"));
        let text = crate::agent_configs::read_workbuddy_models(&config)?;
        use sha2::Digest;
        let model_hash = format!("{:x}", sha2::Sha256::digest(text.as_bytes()));
        let selection_path = context.root.join("agent-selection.json");
        let selection = std::fs::read(&selection_path)
            .map_err(|error| crate::error::AppError::io(&selection_path, error))?;
        if !crate::agent_hub::workbuddy_default_snapshot_matches(context, model, &selection) {
            return Ok(DefaultSelection::pending(
                model,
                "configuration_changed",
                "所选配置已改变，请刷新后重试。",
            ));
        }
        let selection_hash = format!("{:x}", sha2::Sha256::digest(&selection));
        let Some(name) = selected_display_name(&text, model) else {
            return Ok(DefaultSelection::pending(
                model,
                "model_pending",
                "所选模型在 WorkBuddy 原生列表中不唯一，请重新配置后重试。",
            ));
        };
        let Some(shell) = std::env::var_os("SystemRoot")
            .map(std::path::PathBuf::from)
            .filter(|p| p.is_absolute())
            .map(|p| p.join("System32/WindowsPowerShell/v1.0/powershell.exe"))
            .filter(|p| p.is_file())
        else {
            return Ok(DefaultSelection::pending(
                model,
                "accessibility_pending",
                "原生桌面自动选择服务不可用，请在新建任务中选择模型。",
            ));
        };
        let encoded = base64::engine::general_purpose::STANDARD.encode(
            "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); & ([scriptblock]::Create([Console]::In.ReadToEnd()))"
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        );
        let mut child = Command::new(shell)
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                &encoded,
            ])
            .env("AE_WB_PROCESS_ID", candidate.process_id.to_string())
            .env(
                "AE_WB_PROCESS_STARTED_MS",
                candidate.start_time_ms.to_string(),
            )
            .env("AE_WB_PROCESS_IMAGE", &candidate.image_path)
            .env("AE_WB_MODEL_ID", model)
            .env("AE_WB_MODEL_NAME", name)
            .env("AE_WB_MODELS_FILE", &config)
            .env("AE_WB_MODELS_SHA256", model_hash)
            .env("AE_WB_SELECTION_FILE", &selection_path)
            .env("AE_WB_SELECTION_SHA256", selection_hash)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(|_| {
                crate::error::AppError::new(
                    "workbuddy_default_failed",
                    "无法启动原生默认模型选择服务",
                )
            })?;
        let wrote_script = child.stdin.take().is_some_and(|mut stdin| {
            stdin
                .write_all(include_bytes!("workbuddy_default/native-select.ps1"))
                .is_ok()
        });
        if !wrote_script {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(DefaultSelection::pending(
                model,
                "selection_unverified",
                "原生默认模型选择服务未完成，请重试。",
            ));
        }
        let deadline = Instant::now() + Duration::from_secs(12);
        while child.try_wait().ok().flatten().is_none() {
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Ok(DefaultSelection::pending(
                    model,
                    "selection_timeout",
                    "WorkBuddy 原生控件未及时响应，默认选择尚未确认；请在空白新建任务页面重试。",
                ));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let output = child.wait_with_output().map_err(|_| {
            crate::error::AppError::new("workbuddy_default_failed", "无法读取原生默认模型选择结果")
        })?;
        let value = if output.stdout.len() <= 4096 {
            serde_json::from_slice::<DefaultSelection>(&output.stdout).ok()
        } else {
            None
        };
        Ok(value
            .filter(|value| value.model == model)
            .unwrap_or_else(|| {
                DefaultSelection::pending(
                    model,
                    "selection_unverified",
                    "默认模型选择尚未确认，请打开空白新建任务页面重试。",
                )
            }))
    }
}

#[cfg(any(windows, test))]
fn selected_display_name(text: &str, model: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let rows = value
        .as_array()
        .or_else(|| value.get("models")?.as_array())?;
    let selected: Vec<_> = rows.iter().filter(|row| row["id"] == model).collect();
    if selected.len() != 1 {
        return None;
    }
    let name = selected[0]["name"]
        .as_str()
        .filter(|name| !name.is_empty())
        .unwrap_or(model);
    if name.chars().any(char::is_control)
        || name.len() > 256
        || matches!(
            name,
            "快速"
                | "主力"
                | "均衡"
                | "深度"
                | "极致"
                | "智能"
                | "自动"
                | "Fast"
                | "Auto"
                | "Deep"
                | "Balanced"
                | "Smart"
                | "Automatic"
                | "Ultimate"
        )
        || rows
            .iter()
            .filter(|row| {
                row["name"]
                    .as_str()
                    .unwrap_or_else(|| row["id"].as_str().unwrap_or(""))
                    == name
            })
            .count()
            != 1
    {
        return None;
    }
    Some(name.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_snapshot_rejects_stale_model_revision_profile_and_apply_time() {
        let context = crate::restart::ExistingRestartContext {
            root: "G:/ae-data".into(),
            agent_id: crate::agent_configs::AgentId::WorkBuddy,
            profile: ExistingProfile {
                directory: "G:/native/workbuddy".into(),
                executable_path: "G:/vendor/WorkBuddy.exe".into(),
                ..Default::default()
            },
            configuration_revision: 7,
            applied_at_ms: 42,
        };
        let snapshot = serde_json::json!({
            "workbuddy": {
                "providerId": "synthetic-provider",
                "model": "selected-model",
                "profile": context.profile,
                "configurationRevision": 7,
                "appliedAtMs": 42,
            }
        });
        let matches = |snapshot: &serde_json::Value| {
            crate::agent_hub::workbuddy_default_snapshot_matches(
                &context,
                "selected-model",
                &serde_json::to_vec(snapshot).unwrap(),
            )
        };
        assert!(matches(&snapshot));

        for (field, value) in [
            ("model", serde_json::json!("other-model")),
            ("configurationRevision", serde_json::json!(8)),
            ("appliedAtMs", serde_json::json!(43)),
            ("profile", serde_json::Value::Null),
        ] {
            let mut stale = snapshot.clone();
            stale["workbuddy"][field] = value;
            assert!(!matches(&stale), "{field}");
        }
        let mut other_profile = snapshot.clone();
        other_profile["workbuddy"]["profile"]["directory"] =
            serde_json::json!("G:/native/other-account");
        assert!(!matches(&other_profile));

        let mut other_agent = context.clone();
        other_agent.agent_id = crate::agent_configs::AgentId::Codex;
        assert!(!crate::agent_hub::workbuddy_default_snapshot_matches(
            &other_agent,
            "selected-model",
            &serde_json::to_vec(&snapshot).unwrap(),
        ));
    }

    #[test]
    fn default_snapshot_rejects_missing_selection_and_malformed_bytes() {
        let context = crate::restart::ExistingRestartContext {
            root: "G:/ae-data".into(),
            agent_id: crate::agent_configs::AgentId::WorkBuddy,
            profile: ExistingProfile::default(),
            configuration_revision: 7,
            applied_at_ms: 42,
        };
        for bytes in [
            b"".as_slice(),
            b"{".as_slice(),
            b"null".as_slice(),
            b"{}".as_slice(),
            br#"{"workbuddy":{"providerId":"synthetic","model":42}}"#.as_slice(),
        ] {
            assert!(!crate::agent_hub::workbuddy_default_snapshot_matches(
                &context,
                "selected-model",
                bytes,
            ));
        }
    }

    #[test]
    fn visible_name_must_identify_exact_native_model() {
        assert_eq!(
            selected_display_name(r#"[{"id":"one","name":"Display"},{"id":"two"}]"#, "one"),
            Some("Display".into())
        );
        assert_eq!(
            selected_display_name(r#"{"models":[{"id":"one"}]}"#, "one"),
            Some("one".into())
        );
        assert_eq!(
            selected_display_name(
                r#"[{"id":"one","name":"Display"},{"id":"two","name":"Display"}]"#,
                "one"
            ),
            None
        );
        assert_eq!(
            selected_display_name(r#"[{"id":"one"},{"id":"one"}]"#, "one"),
            None
        );
        assert_eq!(selected_display_name(r#"[{"id":"one"}]"#, "other"), None);
    }
    #[test]
    fn accessibility_flag_is_only_for_official_desktop_entry() {
        let mut profile = ExistingProfile {
            executable_path: "WorkBuddy.exe".into(),
            ..Default::default()
        };
        let mut desktop = std::process::Command::new("WorkBuddy.exe");
        prepare_launch(&profile, &mut desktop);
        #[cfg(windows)]
        assert_eq!(
            desktop.get_args().collect::<Vec<_>>(),
            vec!["--force-renderer-accessibility"]
        );
        profile.executable_path = "workbuddy-cli.exe".into();
        let mut cli = std::process::Command::new("workbuddy-cli.exe");
        prepare_launch(&profile, &mut cli);
        assert_eq!(cli.get_args().count(), 0);
    }
}
