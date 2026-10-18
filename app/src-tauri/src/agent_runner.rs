//! POSIX launchers delegate environment loading to Rust, never to shell eval.
#![forbid(unsafe_code)]

#[cfg(unix)]
use crate::agent_configs;
#[cfg(any(unix, test))]
use crate::portable;
use crate::{
    agent_configs::AgentId,
    error::{AppError, Result},
};
#[cfg(any(unix, test))]
use serde_json::{Map, Value};
#[cfg(any(unix, test))]
use std::collections::BTreeMap;
use std::path::Path;
#[cfg(unix)]
use std::process::Command;

/// Launch a user-selected installation with its original native profile.
/// AE's portable HOME/cache/tool installation environment never becomes its HOME.
pub fn existing_command(
    agent: AgentId,
    profile: &crate::agent_configs::ExistingProfile,
    arguments: &[String],
    workspace: Option<&Path>,
) -> Result<std::process::Command> {
    crate::agent_configs::validate_existing_profile(agent, profile)?;
    let entry = std::path::PathBuf::from(&profile.executable_path);
    #[cfg(windows)]
    let mut command = {
        let extension = entry
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        if extension.eq_ignore_ascii_case("ps1")
            || extension.eq_ignore_ascii_case("cmd")
            || extension.eq_ignore_ascii_case("bat")
        {
            let script = if extension.eq_ignore_ascii_case("ps1") {
                entry.clone()
            } else {
                entry.with_extension("ps1")
            };
            if !script.is_file() {
                return Err(AppError::new(
                    "unsupported_agent_entry",
                    "此客户端仅有批处理入口；请选择其官方 exe 或 PowerShell 入口后启动",
                ));
            }
            let system = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
            let mut command = std::process::Command::new(
                std::path::PathBuf::from(system)
                    .join("System32/WindowsPowerShell/v1.0/powershell.exe"),
            );
            command
                .args([
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                ])
                .arg(script);
            command
        } else {
            std::process::Command::new(&entry)
        }
    };
    #[cfg(not(windows))]
    let mut command = std::process::Command::new(&entry);
    let original = crate::agent_discovery::original_environment();
    for name in crate::agent_discovery::ORIGINAL_ENVIRONMENT_VARIABLES {
        command.env_remove(name);
    }
    command.envs(original);
    for name in [
        "AE_AGENT_ROOT",
        "AE_AGENT_ALLOWED_ROOT",
        "AE_AGENT_BIN_PATH",
        "AE_AGENT_PORTABLE_RELATIVE_ROOT",
        "AE_WORKBUDDY_RUNTIME",
        "AE_WORKBUDDY_ENTRY",
        "AE_DSH_RUNTIME",
        "AE_DSH_ENTRY",
        "AE_DSH_PWSH",
        "AE_GATEWAY_TOKEN",
        "AE_SWITCH_API_KEY",
        "AE_WORKBUDDY_MODEL",
        "DOTNET_CLI_HOME",
        "NUGET_PACKAGES",
        "CARGO_HOME",
        "RUSTUP_HOME",
        "UV_PYTHON_INSTALL_DIR",
        "BUN_INSTALL_CACHE_DIR",
        "PSModuleAnalysisCachePath",
    ] {
        command.env_remove(name);
    }
    command
        .env("HOME", &profile.home_directory)
        .env("USERPROFILE", &profile.home_directory);
    for (name, value) in [
        ("XDG_CONFIG_HOME", &profile.xdg_config_directory),
        ("XDG_DATA_HOME", &profile.xdg_data_directory),
        ("XDG_STATE_HOME", &profile.xdg_state_directory),
        ("XDG_CACHE_HOME", &profile.xdg_cache_directory),
    ] {
        if let Some(value) = value {
            command.env(name, value);
        }
    }
    match agent {
        AgentId::ClaudeCode => {
            for name in [
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_AUTH_TOKEN",
                "ANTHROPIC_BASE_URL",
                "ANTHROPIC_MODEL",
                "ANTHROPIC_DEFAULT_OPUS_MODEL",
                "ANTHROPIC_DEFAULT_SONNET_MODEL",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL",
                "ANTHROPIC_SMALL_FAST_MODEL",
                "CLAUDE_CODE_SUBAGENT_MODEL",
                "ANTHROPIC_CUSTOM_HEADERS",
                "CLAUDE_CODE_USE_BEDROCK",
                "CLAUDE_CODE_USE_VERTEX",
                "CLAUDE_CODE_USE_FOUNDRY",
                "CLAUDE_CODE_USE_ANTHROPIC_AWS",
                "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
                "CLAUDE_CODE_USE_MANTLE",
                "CLAUDE_CODE_USE_GATEWAY",
                "ANTHROPIC_UNIX_SOCKET",
            ] {
                command.env_remove(name);
            }
            command.env("CLAUDE_CONFIG_DIR", &profile.directory);
        }
        AgentId::Codex => {
            command.env("CODEX_HOME", &profile.directory);
        }
        AgentId::Hermes => {
            command.env("HERMES_HOME", &profile.directory);
        }
        AgentId::OhMyPi => {
            command.env_remove("OMP_PROFILE").env_remove("PI_PROFILE");
            if let Some(name) = &profile.profile_name {
                command
                    .env("OMP_PROFILE", name)
                    .env("PI_PROFILE", name)
                    .env(
                        "PI_CONFIG_DIR",
                        crate::agent_configs::existing_omp_root_name(profile)?,
                    );
            }
            command.env("PI_CODING_AGENT_DIR", &profile.directory);
        }
        AgentId::OpenCode => {
            command.env_remove("OPENCODE_CONFIG_CONTENT");
            command.env(
                "OPENCODE_CONFIG",
                profile
                    .config_file
                    .as_deref()
                    .map(std::path::PathBuf::from)
                    .unwrap_or_else(|| Path::new(&profile.directory).join("opencode.json")),
            );
        }
        AgentId::Zcode => {
            if let Some(state) = &profile.state_file {
                let state = Path::new(state);
                let storage = state.parent().and_then(Path::parent).ok_or_else(|| {
                    AppError::new(
                        "invalid_agent_profile",
                        "ZCode state 路径没有实际 storage 根",
                    )
                })?;
                command.env("ZCODE_STORAGE_DIR", storage);
            }
            if let Some(path) = &profile.builtin_config_file {
                command.env("ZCODE_BUILTIN_PROVIDER_CONFIG_FILE", path).env(
                    "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
                    profile
                        .config_file
                        .as_deref()
                        .map(std::path::PathBuf::from)
                        .unwrap_or_else(|| {
                            Path::new(&profile.directory).join("provider_config.json")
                        }),
                );
            }
        }
        AgentId::WorkBuddy => {
            command
                .env("WORKBUDDY_CONFIG_DIR", &profile.directory)
                .env("CODEBUDDY_CONFIG_DIR", &profile.directory)
                .env_remove("WORKBUDDY_USER_DATA_DIR");
        }
        AgentId::DeepSeekHarness => {
            command.env_remove(crate::agent_configs::existing_dsh_credential_ref(profile));
            let dsh_home = profile
                .data_directory
                .as_deref()
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| Path::new(&profile.home_directory).join(".dsh"));
            command.env("DSH_HOME", dsh_home);
            let name = profile
                .profile_name
                .as_deref()
                .or_else(|| {
                    Path::new(&profile.directory)
                        .file_name()
                        .and_then(|name| name.to_str())
                })
                .ok_or_else(|| {
                    AppError::new(
                        "invalid_agent_profile",
                        "请选择 DeepSeek Harness 的实际 profile",
                    )
                })?;
            command.args(["--profile", name]);
        }
    }
    let workspace = workspace.unwrap_or_else(|| Path::new(&profile.workspace_directory));
    command.current_dir(workspace).env("PWD", workspace);
    if agent == AgentId::DeepSeekHarness && arguments.len() == 2 && arguments[0] == "--json" {
        command.arg("--json").args(["--", "--"]).arg(&arguments[1]);
    } else {
        command.args(arguments);
    }
    Ok(command)
}

#[cfg(test)]
mod existing_tests {
    use super::*;
    use crate::agent_configs::ExistingProfile;

    fn fixture() -> (tempfile::TempDir, ExistingProfile) {
        let root = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
        let home = root.path().join("original-home");
        let directory = home.join(".codex");
        let workspace = root.path().join("original-workspace");
        for path in [&home, &directory, &workspace] {
            std::fs::create_dir_all(path).unwrap();
        }
        let entry = root.path().join(if cfg!(windows) {
            "official-entry.ps1"
        } else {
            "official-entry"
        });
        std::fs::write(&entry, "fixture").unwrap();
        let profile = ExistingProfile {
            directory: directory.to_string_lossy().into(),
            home_directory: home.to_string_lossy().into(),
            executable_path: entry.to_string_lossy().into(),
            workspace_directory: workspace.to_string_lossy().into(),
            ..Default::default()
        };
        (root, profile)
    }

    fn command_environment(command: &std::process::Command) -> BTreeMap<String, Option<String>> {
        command
            .get_envs()
            .map(|(name, value)| {
                (
                    name.to_string_lossy().into_owned(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect()
    }

    #[test]
    fn existing_runner_keeps_selected_native_home_and_original_path_without_gateway_environment_keys(
    ) {
        let (_root, profile) = fixture();
        let command = existing_command(AgentId::Codex, &profile, &[], None).unwrap();
        let environment = command_environment(&command);
        assert_eq!(
            environment["HOME"].as_deref(),
            Some(profile.home_directory.as_str())
        );
        assert_eq!(
            environment["USERPROFILE"].as_deref(),
            Some(profile.home_directory.as_str())
        );
        assert_eq!(
            environment["CODEX_HOME"].as_deref(),
            Some(profile.directory.as_str())
        );
        assert_eq!(environment["AE_SWITCH_API_KEY"], None);
        assert_eq!(environment["AE_GATEWAY_TOKEN"], None);
        let original = crate::agent_discovery::original_environment()
            .get("PATH")
            .map(|value| value.to_string_lossy().into_owned());
        assert_eq!(environment["PATH"], original);
        assert_eq!(
            command.get_current_dir(),
            Some(Path::new(&profile.workspace_directory))
        );
    }

    #[test]
    #[cfg(windows)]
    fn existing_runner_process_pwd_matches_effective_workspace() {
        use std::os::windows::process::CommandExt;
        let (root, profile) = fixture();
        std::fs::write(&profile.executable_path, r#"[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[pscustomobject]@{pwd=$env:PWD;cwd=[IO.Directory]::GetCurrentDirectory()} | ConvertTo-Json -Compress"#).unwrap();
        let verification_workspace = root.path().join("verification workspace");
        std::fs::create_dir(&verification_workspace).unwrap();
        for selected in [None, Some(verification_workspace.as_path())] {
            let expected = selected.unwrap_or_else(|| Path::new(&profile.workspace_directory));
            let output = existing_command(AgentId::OpenCode, &profile, &[], selected)
                .unwrap()
                .creation_flags(0x0800_0000)
                .output()
                .unwrap();
            assert!(output.status.success());
            let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(value["cwd"], expected.to_string_lossy().as_ref());
            assert_eq!(value["pwd"], expected.to_string_lossy().as_ref());
        }
    }

    #[test]
    fn existing_runner_default_and_named_omp_profiles_override_only_selected_process_scope() {
        let (_root, mut profile) = fixture();
        profile.directory = Path::new(&profile.home_directory)
            .join(".omp/agent")
            .to_string_lossy()
            .into();
        let command = existing_command(AgentId::OhMyPi, &profile, &[], None).unwrap();
        let environment = command_environment(&command);
        assert_eq!(environment["OMP_PROFILE"], None);
        assert_eq!(environment["PI_PROFILE"], None);
        profile.directory = Path::new(&profile.home_directory)
            .join(".custom-omp/profiles/work/agent")
            .to_string_lossy()
            .into();
        profile.profile_name = Some("work".into());
        let command = existing_command(AgentId::OhMyPi, &profile, &[], None).unwrap();
        let environment = command_environment(&command);
        assert_eq!(environment["OMP_PROFILE"].as_deref(), Some("work"));
        assert_eq!(environment["PI_PROFILE"].as_deref(), Some("work"));
        assert_eq!(environment["PI_CONFIG_DIR"].as_deref(), Some(".custom-omp"));
    }

    #[test]
    fn existing_runner_zcode_default_does_not_create_unpaired_provider_environment() {
        let (_root, mut profile) = fixture();
        profile.directory = Path::new(&profile.home_directory)
            .join(".zcode/v2")
            .to_string_lossy()
            .into();
        let command = existing_command(AgentId::Zcode, &profile, &[], None).unwrap();
        let environment = command_environment(&command);
        let original = crate::agent_discovery::original_environment();
        for name in [
            "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
            "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
            "ZCODE_SESSION_DB_PATH",
            "ZCODE_SESSION_DB",
        ] {
            assert_eq!(
                environment[name],
                original
                    .get(name)
                    .map(|value| value.to_string_lossy().into_owned())
            );
        }
    }

    #[test]
    fn existing_runner_dsh_preserves_native_credentials_over_inherited_dynamic_reference() {
        let (_root, mut profile) = fixture();
        std::fs::write(Path::new(&profile.directory).join("package.json"),r#"{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-headless"]}}}"#).unwrap();
        profile.profile_name = Some("headless".into());
        let command = existing_command(AgentId::DeepSeekHarness, &profile, &[], None).unwrap();
        let environment = command_environment(&command);
        assert_eq!(
            environment[&crate::agent_configs::existing_dsh_credential_ref(&profile)],
            None
        );
        assert!(command.get_args().any(|argument| argument == "headless"));
    }

    #[test]
    #[cfg(windows)]
    fn existing_runner_windows_native_script_preserves_literal_arguments_and_selected_home() {
        use std::os::windows::process::CommandExt;
        let (root, profile) = fixture();
        std::fs::write(&profile.executable_path, r#"[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[pscustomobject]@{home=$env:HOME;codexHome=$env:CODEX_HOME;arguments=@($args);hasGatewayKey=(-not [string]::IsNullOrEmpty($env:AE_SWITCH_API_KEY))} | ConvertTo-Json -Compress"#).unwrap();
        let literal = format!(
            "$(Set-Content '{}'/unexpected.txt broken); & literal",
            root.path().display()
        );
        let arguments = vec![
            "one argument with spaces".into(),
            literal.clone(),
            "a&b|c>file".into(),
        ];
        let output = existing_command(AgentId::Codex, &profile, &arguments, None)
            .unwrap()
            .creation_flags(0x0800_0000)
            .output()
            .unwrap();
        assert!(output.status.success());
        let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(value["home"], profile.home_directory);
        assert_eq!(value["codexHome"], profile.directory);
        assert_eq!(value["arguments"], serde_json::json!(arguments));
        assert_eq!(value["hasGatewayKey"], false);
        assert!(!root.path().join("unexpected.txt").exists());
    }
}

#[cfg(any(unix, test))]
const PATH_VARIABLES: &[&str] = &[
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "npm_config_cache",
    "npm_config_prefix",
    "UV_CACHE_DIR",
    "PIP_CACHE_DIR",
    "PYTHONPYCACHEPREFIX",
    "DOTNET_CLI_HOME",
    "NUGET_PACKAGES",
    "GIT_CONFIG_GLOBAL",
    "CARGO_HOME",
    "RUSTUP_HOME",
    "UV_PYTHON_INSTALL_DIR",
    "BUN_INSTALL_CACHE_DIR",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "HERMES_HOME",
    "PI_CODING_AGENT_DIR",
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_DIR",
    "ZCODE_DATA_BASE_DIR",
    "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
    "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
    "WORKBUDDY_CONFIG_DIR",
    "CODEBUDDY_CONFIG_DIR",
    "AE_WORKBUDDY_RUNTIME",
    "AE_WORKBUDDY_ENTRY",
    "CLAUDE_CODE_GIT_BASH_PATH",
    "CODEBUDDY_CODE_GIT_BASH_PATH",
    "DSH_HOME",
    "AE_DSH_RUNTIME",
    "AE_DSH_ENTRY",
    "AE_DSH_PWSH",
    "PSModuleAnalysisCachePath",
];

#[cfg(any(unix, test))]
const VALUE_VARIABLES: &[&str] = &[
    "NO_PROXY",
    "AE_GATEWAY_TOKEN",
    "AE_SWITCH_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    "DISABLE_AUTOUPDATER",
    "OPENCODE_DISABLE_AUTOUPDATE",
    "ELECTRON_RUN_AS_NODE",
    "CODEBUDDY_FORCE_LITE_WB_BUNDLE",
    "CODEBUDDY_FORCE_HEADLESS_BUNDLE",
    "CODEBUDDY_HOST",
    "CODEBUDDY_SKIP_GIT_BASH_CHECK",
    "DISABLE_TELEMETRY",
    "AE_WORKBUDDY_MODEL",
    "DSH_TELEMETRY_MODE",
    "POWERSHELL_TELEMETRY_OPTOUT",
];

#[cfg(any(unix, test))]
fn invalid_environment() -> AppError {
    AppError::new("invalid_environment", "工具环境配置无效，请重新应用配置")
}

#[cfg(any(unix, test))]
fn rebase(
    value: &str,
    old_agent: &Path,
    agent: &Path,
    old_root: &Path,
    root: &Path,
) -> Result<String> {
    let path = Path::new(value);
    let current = if let Ok(relative) = path.strip_prefix(old_agent) {
        agent.join(relative)
    } else if let Ok(relative) = path.strip_prefix(old_root) {
        root.join(relative)
    } else {
        return Err(invalid_environment());
    };
    portable::validate_root(&current)?;
    if !current.starts_with(root) {
        return Err(invalid_environment());
    }
    Ok(current.to_string_lossy().into_owned())
}

#[cfg(any(unix, test))]
fn environment(
    values: &Map<String, Value>,
    agent: &Path,
    root: &Path,
) -> Result<BTreeMap<String, String>> {
    let old_agent = Path::new(
        values
            .get("AE_AGENT_ROOT")
            .and_then(Value::as_str)
            .ok_or_else(invalid_environment)?,
    );
    let old_root = Path::new(
        values
            .get("AE_SWITCH_PORTABLE_ROOT")
            .and_then(Value::as_str)
            .ok_or_else(invalid_environment)?,
    );
    if !old_agent.is_absolute() || !old_root.is_absolute() || !old_agent.starts_with(old_root) {
        return Err(invalid_environment());
    }
    let mut result = BTreeMap::new();
    for (name, value) in values {
        let value = value.as_str().ok_or_else(invalid_environment)?;
        if value.contains('\0') {
            return Err(invalid_environment());
        }
        if PATH_VARIABLES.contains(&name.as_str()) {
            result.insert(
                name.clone(),
                rebase(value, old_agent, agent, old_root, root)?,
            );
        } else if VALUE_VARIABLES.contains(&name.as_str()) {
            result.insert(name.clone(), value.to_owned());
        } else if name == "AE_AGENT_BIN_PATH" {
            let rebased = std::env::split_paths(value)
                .map(|path| {
                    rebase(&path.to_string_lossy(), old_agent, agent, old_root, root)
                        .map(std::path::PathBuf::from)
                })
                .collect::<Result<Vec<_>>>()?;
            if rebased.is_empty() || rebased.iter().any(|path| !path.is_dir()) {
                return Err(invalid_environment());
            }
            let joined = std::env::join_paths(rebased).map_err(|_| invalid_environment())?;
            result.insert(name.clone(), joined.to_string_lossy().into_owned());
        } else if !matches!(
            name.as_str(),
            "AE_AGENT_ROOT"
                | "AE_AGENT_ALLOWED_ROOT"
                | "AE_SWITCH_PORTABLE_ROOT"
                | "AE_AGENT_PORTABLE_RELATIVE_ROOT"
        ) {
            return Err(invalid_environment());
        }
    }
    for (name, path) in [
        ("AE_AGENT_ROOT", agent),
        ("AE_AGENT_ALLOWED_ROOT", root),
        ("AE_SWITCH_PORTABLE_ROOT", root),
    ] {
        result.insert(name.into(), path.to_string_lossy().into_owned());
    }
    // These cannot fall back to a user's existing home or temporary directory.
    for name in [
        "HOME",
        "TMPDIR",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
    ] {
        if !result.contains_key(name) {
            return Err(invalid_environment());
        }
    }
    Ok(result)
}

#[cfg(any(unix, test))]
fn owned_file(path: &Path, root: &Path, executable: bool) -> Result<std::path::PathBuf> {
    if !path.is_absolute()
        || !path.starts_with(root)
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(AppError::new(
            "unsafe_path",
            "工具入口必须位于当前便携目录内",
        ));
    }
    // npm .bin links are permitted only when their final file stays in this package.
    let physical = path
        .canonicalize()
        .map_err(|_| AppError::new("missing_agent", "当前平台的工具入口尚未打包"))?;
    let physical_root = root.canonicalize().map_err(|_| invalid_environment())?;
    if !physical.starts_with(physical_root) || !physical.is_file() {
        return Err(AppError::new(
            "unsafe_path",
            "工具入口链接逃出了当前便携目录",
        ));
    }
    #[cfg(unix)]
    if executable {
        use std::os::unix::fs::PermissionsExt;
        if std::fs::metadata(&physical)
            .map_err(|e| AppError::io(&physical, e))?
            .permissions()
            .mode()
            & 0o111
            == 0
        {
            return Err(AppError::new(
                "missing_agent",
                "当前平台的工具入口没有执行权限",
            ));
        }
    }
    #[cfg(not(unix))]
    let _ = executable;
    Ok(physical)
}

#[cfg(unix)]
fn prepare(data_root: &Path, agent: AgentId, arguments: &[String]) -> Result<Command> {
    let launcher = agent_configs::validate_launch(data_root, agent)?;
    let directory = launcher.parent().ok_or_else(invalid_environment)?;
    let root = data_root.parent().ok_or_else(invalid_environment)?;
    portable::validate_root(root)?;
    let file = directory.join("configuration/environment.json");
    let bytes = std::fs::read(&file).map_err(|e| AppError::io(&file, e))?;
    if bytes.len() > 1024 * 1024 {
        return Err(invalid_environment());
    }
    let values: Map<String, Value> =
        serde_json::from_slice(&bytes).map_err(|_| invalid_environment())?;
    let environment = environment(&values, directory, root)?;
    let bins: Vec<_> = std::env::split_paths(
        environment
            .get("AE_AGENT_BIN_PATH")
            .ok_or_else(|| AppError::new("missing_agent", "当前平台的工具尚未打包"))?,
    )
    .collect();
    let (program, prefix) = if agent == AgentId::WorkBuddy {
        let runtime = owned_file(
            Path::new(environment.get("AE_WORKBUDDY_RUNTIME").ok_or_else(|| {
                AppError::new("missing_agent", "当前平台的 WorkBuddy 官方运行库尚未打包")
            })?),
            root,
            true,
        )?;
        let entry = owned_file(
            Path::new(
                environment
                    .get("AE_WORKBUDDY_ENTRY")
                    .ok_or_else(invalid_environment)?,
            ),
            root,
            false,
        )?;
        (
            runtime,
            vec![
                entry.to_string_lossy().into_owned(),
                "--model".into(),
                environment
                    .get("AE_WORKBUDDY_MODEL")
                    .ok_or_else(invalid_environment)?
                    .clone(),
            ],
        )
    } else if agent == AgentId::DeepSeekHarness {
        let runtime = owned_file(
            Path::new(
                environment
                    .get("AE_DSH_RUNTIME")
                    .ok_or_else(invalid_environment)?,
            ),
            root,
            true,
        )?;
        let entry = owned_file(
            Path::new(
                environment
                    .get("AE_DSH_ENTRY")
                    .ok_or_else(invalid_environment)?,
            ),
            root,
            false,
        )?;
        (
            runtime,
            vec![
                entry.to_string_lossy().into_owned(),
                "--profile".into(),
                "headless".into(),
            ],
        )
    } else {
        let program = bins
            .iter()
            .map(|bin| bin.join(agent.command()))
            .find(|path| path.exists())
            .ok_or_else(|| AppError::new("missing_agent", "当前平台的工具入口尚未打包"))?;
        (owned_file(&program, root, true)?, Vec::new())
    };
    let mut command = Command::new(program);
    // Retain network proxy settings, but remove inherited client credentials,
    // loader overrides and runtime hooks that can select a host installation.
    for (name, _) in std::env::vars_os() {
        let name_text = name.to_string_lossy().to_ascii_uppercase();
        if name_text.contains("TOKEN")
            || name_text.contains("KEY")
            || name_text.contains("SECRET")
            || name_text.contains("PASSWORD")
            || name_text.contains("AUTHORIZATION")
            || name_text.starts_with("LD_")
            || name_text.starts_with("DYLD_")
            || (agent == AgentId::DeepSeekHarness && name_text == "PSMODULEPATH")
            || PATH_VARIABLES
                .iter()
                .any(|known| known.eq_ignore_ascii_case(&name_text))
            || VALUE_VARIABLES
                .iter()
                .any(|known| known.eq_ignore_ascii_case(&name_text))
            || matches!(
                name_text.as_str(),
                "NODE_OPTIONS"
                    | "NODE_PATH"
                    | "PYTHONPATH"
                    | "PYTHONHOME"
                    | "VIRTUAL_ENV"
                    | "OPENAI_BASE_URL"
                    | "ANTHROPIC_AUTH_TOKEN"
                    | "CLAUDE_CODE_USE_BEDROCK"
                    | "CLAUDE_CODE_USE_VERTEX"
                    | "CLAUDE_CODE_USE_FOUNDRY"
                    | "ZCODE_STORAGE_DIR"
                    | "ZCODE_SESSION_DB_PATH"
                    | "ZCODE_SESSION_DB"
                    | "CODEBUDDY_CODE_SUBAGENT_MODEL"
                    | "OPENCODE_CONFIG_CONTENT"
                    | "CLAUDE_CODE_USE_ANTHROPIC_AWS"
                    | "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD"
                    | "CLAUDE_CODE_USE_MANTLE"
                    | "CLAUDE_CODE_USE_GATEWAY"
                    | "ANTHROPIC_UNIX_SOCKET"
            )
        {
            command.env_remove(name);
        }
    }
    let mut path_entries = bins;
    #[cfg(unix)]
    path_entries.extend(["/usr/bin", "/bin", "/usr/sbin", "/sbin"].map(std::path::PathBuf::from));
    command.env(
        "PATH",
        std::env::join_paths(path_entries).map_err(|_| invalid_environment())?,
    );
    if let Some(bypass) = environment.get("NO_PROXY") {
        command.env("no_proxy", bypass);
    }
    command.envs(environment).args(prefix);
    if agent == AgentId::WorkBuddy && arguments.is_empty() {
        command.arg("--serve");
    } else {
        command.args(arguments);
    }
    let workspace = directory.join("workspace");
    command.current_dir(&workspace).env("PWD", &workspace);
    Ok(command)
}

#[cfg(any(unix, test))]
fn deepseek_prompt_arguments(task: &str) -> Result<[String; 3]> {
    let task = task.trim_end_matches(['\r', '\n']);
    if task.trim().is_empty() {
        return Err(AppError::new(
            "invalid_argument",
            "DeepSeek Harness requires one task per invocation",
        ));
    }
    // The official outer CLI and headless profile each consume one delimiter.
    Ok(["--".into(), "--".into(), task.into()])
}

/// Runs before the CLI creates worker threads or a gateway listener.
pub fn run(data_root: &Path, agent: AgentId, arguments: &[String]) -> Result<i32> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::process::CommandExt;
        let mut command = prepare(data_root, agent, arguments)?;
        if agent == AgentId::DeepSeekHarness && arguments.is_empty() {
            eprint!("DeepSeek Harness task: ");
            std::io::stderr().flush().map_err(|_| {
                AppError::new(
                    "launch_failed",
                    "Cannot display the DeepSeek Harness task prompt",
                )
            })?;
            let mut task = String::new();
            std::io::stdin().read_line(&mut task).map_err(|_| {
                AppError::new("invalid_argument", "Cannot read the DeepSeek Harness task")
            })?;
            command.args(deepseek_prompt_arguments(&task)?);
        }
        let error = command.exec();
        Err(AppError::new(
            "launch_failed",
            format!("无法启动便携工具：{}", error.kind()),
        ))
    }
    #[cfg(not(unix))]
    {
        let _ = (data_root, agent, arguments);
        Err(AppError::new(
            "unsupported_platform",
            "Windows 请使用生成的 launch.cmd 启动工具",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values(agent: &Path, root: &Path) -> Map<String, Value> {
        serde_json::json!({
            "AE_AGENT_ROOT":agent, "AE_SWITCH_PORTABLE_ROOT":root,
            "HOME":agent.join("home"), "TMPDIR":agent.join("tmp"),
            "XDG_CONFIG_HOME":agent.join("configuration"),
            "XDG_DATA_HOME":agent.join("home/data"), "XDG_CACHE_HOME":agent.join("cache"),
            "AE_SWITCH_API_KEY":"synthetic-$('never execute')-key",
        })
        .as_object()
        .unwrap()
        .clone()
    }

    #[test]
    fn moved_environment_rebases_paths_without_changing_literal_tokens() {
        let temp = tempfile::tempdir().unwrap();
        let old_root = temp.path().join("old");
        let old_agent = old_root.join("data/agents/codex");
        let root = temp.path().join("中文 空格 迁移");
        let agent = root.join("data/agents/codex");
        let result = environment(&values(&old_agent, &old_root), &agent, &root).unwrap();
        assert_eq!(result["HOME"], agent.join("home").to_string_lossy());
        assert_eq!(
            result["AE_SWITCH_API_KEY"],
            "synthetic-$('never execute')-key"
        );
        assert_eq!(result["AE_AGENT_ALLOWED_ROOT"], root.to_string_lossy());
    }

    #[test]
    fn deepseek_prompt_arguments_keep_leading_dashes_and_metacharacters_literal() {
        for task in [
            "--version",
            "-task",
            "embedded\"quote $(); 中文\\",
            "  preserve spaces  ",
        ] {
            assert_eq!(
                deepseek_prompt_arguments(&format!("{task}\r\n")).unwrap(),
                ["--".to_string(), "--".to_string(), task.to_string()]
            );
        }
        for task in ["", "\r\n", " \t\n"] {
            assert!(deepseek_prompt_arguments(task).is_err());
        }
    }

    #[test]
    fn deepseek_environment_rebases_private_paths_and_rejects_external_runtime() {
        let temp = tempfile::tempdir().unwrap();
        let old_root = temp.path().join("old package");
        let old_agent = old_root.join("data/agents/deepseek_harness");
        let root = temp.path().join("中文 moved package");
        let agent = root.join("data/agents/deepseek_harness");
        let mut source = values(&old_agent, &old_root);
        for (name, path) in [
            ("DSH_HOME", old_agent.join("home/.dsh")),
            ("AE_DSH_RUNTIME", old_root.join("tools/node/node")),
            (
                "AE_DSH_ENTRY",
                old_root
                    .join("tools/agents/deepseek_harness/node_modules/@deepseek-ai/dsh/lib/bin.js"),
            ),
            ("AE_DSH_PWSH", old_root.join("tools/pwsh/pwsh.exe")),
            (
                "PSModuleAnalysisCachePath",
                old_agent.join("cache/pwsh/ModuleAnalysisCache"),
            ),
        ] {
            source.insert(name.into(), path.to_string_lossy().into_owned().into());
        }
        source.insert("DSH_TELEMETRY_MODE".into(), "DISABLED".into());
        source.insert("POWERSHELL_TELEMETRY_OPTOUT".into(), "1".into());
        source.insert(
            "AE_GATEWAY_TOKEN".into(),
            "literal$(); 'gateway token'".into(),
        );
        let actual = environment(&source, &agent, &root).unwrap();
        assert_eq!(
            actual["DSH_HOME"],
            agent.join("home/.dsh").to_string_lossy()
        );
        assert_eq!(
            actual["AE_DSH_RUNTIME"],
            root.join("tools/node/node").to_string_lossy()
        );
        assert_eq!(
            actual["AE_DSH_ENTRY"],
            root.join("tools/agents/deepseek_harness/node_modules/@deepseek-ai/dsh/lib/bin.js")
                .to_string_lossy()
        );
        assert_eq!(
            actual["AE_DSH_PWSH"],
            root.join("tools/pwsh/pwsh.exe").to_string_lossy()
        );
        assert_eq!(
            actual["PSModuleAnalysisCachePath"],
            agent
                .join("cache/pwsh/ModuleAnalysisCache")
                .to_string_lossy()
        );
        assert_eq!(actual["AE_GATEWAY_TOKEN"], "literal$(); 'gateway token'");
        assert_eq!(actual["DSH_TELEMETRY_MODE"], "DISABLED");
        assert_eq!(actual["POWERSHELL_TELEMETRY_OPTOUT"], "1");
        for name in [
            "DSH_HOME",
            "AE_DSH_RUNTIME",
            "AE_DSH_ENTRY",
            "AE_DSH_PWSH",
            "PSModuleAnalysisCachePath",
        ] {
            let mut changed = source.clone();
            changed.insert(
                name.into(),
                temp.path()
                    .join("outside")
                    .to_string_lossy()
                    .into_owned()
                    .into(),
            );
            assert!(environment(&changed, &agent, &root).is_err(), "{name}");
        }
    }

    #[test]
    fn environment_rejects_external_paths_traversal_and_loader_injection() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("portable");
        let agent = root.join("data/agents/codex");
        let base = values(&agent, &root);
        for (name, value) in [
            (
                "HOME",
                temp.path().join("outside").to_string_lossy().into_owned(),
            ),
            (
                "TMPDIR",
                agent
                    .join("../../../../outside")
                    .to_string_lossy()
                    .into_owned(),
            ),
            ("LD_PRELOAD", "malicious.so".into()),
            ("NODE_OPTIONS", "--require hook.js".into()),
        ] {
            let mut changed = base.clone();
            changed.insert(name.into(), value.into());
            assert!(environment(&changed, &agent, &root).is_err(), "{name}");
        }
        let mut missing = base;
        missing.remove("HOME");
        assert!(environment(&missing, &agent, &root).is_err());
    }

    #[test]
    fn entry_must_be_an_existing_package_file() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("portable");
        std::fs::create_dir(&root).unwrap();
        let outside = temp.path().join("outside");
        std::fs::write(&outside, "fixture").unwrap();
        assert!(owned_file(&outside, &root, false).is_err());
        assert!(owned_file(&root.join("missing"), &root, false).is_err());
        let entry = root.join("agent");
        std::fs::write(&entry, "fixture").unwrap();
        assert_eq!(
            owned_file(&entry, &root, false).unwrap(),
            entry.canonicalize().unwrap()
        );
    }

    #[cfg(unix)]
    #[test]
    fn npm_link_is_allowed_inside_package_and_refused_outside() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("portable");
        std::fs::create_dir(&root).unwrap();
        let entry = root.join("cli");
        std::fs::write(&entry, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&entry, std::fs::Permissions::from_mode(0o700)).unwrap();
        let link = root.join("codex");
        symlink("cli", &link).unwrap();
        assert!(owned_file(&link, &root, true).is_ok());
        std::fs::remove_file(&link).unwrap();
        let outside = temp.path().join("outside");
        std::fs::write(&outside, "fixture").unwrap();
        symlink(&outside, &link).unwrap();
        assert!(owned_file(&link, &root, true).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn prepared_posix_agent_uses_private_home_and_literal_arguments() {
        use std::os::unix::fs::PermissionsExt;
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("中文 空格 portable");
        let data = root.join("data");
        let directory = data.join("agents/codex");
        for relative in [
            "home",
            "tmp",
            "cache",
            "configuration",
            "workspace",
            "home/data",
        ] {
            std::fs::create_dir_all(directory.join(relative)).unwrap();
        }
        let bin = root.join("tools/agents/codex/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let program = bin.join("codex");
        std::fs::write(&program, "#!/bin/sh\nprintf '%s\\n' \"$HOME\" \"$@\" \"${ZCODE_STORAGE_DIR-unset}\" \"${ZCODE_SESSION_DB_PATH-unset}\" \"${ZCODE_SESSION_DB-unset}\" \"${CODEBUDDY_CODE_SUBAGENT_MODEL-unset}\" \"${OPENCODE_CONFIG_CONTENT-unset}\" \"${CLAUDE_CODE_SUBAGENT_MODEL-unset}\" \"${ANTHROPIC_SMALL_FAST_MODEL-unset}\" \"${ANTHROPIC_CUSTOM_HEADERS-unset}\" \"${CLAUDE_CODE_USE_ANTHROPIC_AWS-unset}\" \"${CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD-unset}\" \"${CLAUDE_CODE_USE_MANTLE-unset}\" \"${CLAUDE_CODE_USE_GATEWAY-unset}\" \"${ANTHROPIC_UNIX_SOCKET-unset}\"\n").unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(directory.join("launch.sh"), "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(
            directory.join("launch.sh"),
            std::fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        let mut environment = values(&directory, &root);
        environment.insert(
            "AE_AGENT_BIN_PATH".into(),
            bin.to_string_lossy().into_owned().into(),
        );
        std::fs::write(
            directory.join("configuration/environment.json"),
            serde_json::to_vec(&environment).unwrap(),
        )
        .unwrap();
        let literal = "$(touch outside); 'literal'".to_string();
        let mut command = prepare(&data, AgentId::Codex, std::slice::from_ref(&literal)).unwrap();
        assert!(command.get_envs().any(|(name, value)| {
            name == "PWD" && value == Some(directory.join("workspace").as_os_str())
        }));
        let output = command.output().unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            format!(
                "{}\n{literal}\nunset\nunset\nunset\nunset\nunset\nunset\nunset\nunset\nunset\nunset\nunset\nunset\nunset\n",
                directory.join("home").display()
            )
        );
        assert!(!directory.join("workspace/outside").exists());
    }

    #[cfg(unix)]
    #[test]
    fn posix_launcher_removes_inherited_storage_and_subagent_overrides() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "agent_runner::tests::prepared_posix_agent_uses_private_home_and_literal_arguments",
                "--test-threads=1",
            ])
            .env("ZCODE_STORAGE_DIR", "/owned-fixture-host-storage")
            .env("ZCODE_SESSION_DB_PATH", "/owned-fixture-host-session.db")
            .env("ZCODE_SESSION_DB", "sqlite:/owned-fixture-host-session.db")
            .env("CODEBUDDY_CODE_SUBAGENT_MODEL", "owned-old-subagent-model")
            .env(
                "OPENCODE_CONFIG_CONTENT",
                "{\"model\":\"owned-host/old-model\"}",
            )
            .env("CLAUDE_CODE_SUBAGENT_MODEL", "owned-host-subagent-model")
            .env("ANTHROPIC_SMALL_FAST_MODEL", "owned-host-small-fast-model")
            .env(
                "ANTHROPIC_CUSTOM_HEADERS",
                "Authorization: Bearer owned-host-auth",
            )
            .env("CLAUDE_CODE_USE_ANTHROPIC_AWS", "1")
            .env("CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD", "1")
            .env("CLAUDE_CODE_USE_MANTLE", "1")
            .env("CLAUDE_CODE_USE_GATEWAY", "1")
            .env("ANTHROPIC_UNIX_SOCKET", "/owned-fixture-host.sock")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
    }

    #[cfg(unix)]
    #[test]
    fn prepared_deepseek_posix_uses_validated_runtime_headless_and_literal_arguments() {
        use std::os::unix::fs::PermissionsExt;
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("中文 portable package");
        let data = root.join("data");
        let directory = data.join("agents/deepseek_harness");
        for relative in [
            "home",
            "tmp",
            "cache",
            "configuration",
            "workspace",
            "home/data",
        ] {
            std::fs::create_dir_all(directory.join(relative)).unwrap();
        }
        let bin = root.join("tools/agents/deepseek_harness/node_modules/.bin");
        std::fs::create_dir_all(&bin).unwrap();
        let runtime = root.join("tools/node/bin/node");
        let entry =
            root.join("tools/agents/deepseek_harness/node_modules/@deepseek-ai/dsh/lib/bin.js");
        std::fs::create_dir_all(runtime.parent().unwrap()).unwrap();
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::fs::write(
            &runtime,
            "#!/bin/sh\nprintf '%s\\n' \"$PWD\" \"$DSH_HOME\" \"$@\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&runtime, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(&entry, "ordinary JavaScript-entry fixture").unwrap();
        let launcher = directory.join("launch.sh");
        std::fs::write(&launcher, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut source = values(&directory, &root);
        for (name, path) in [
            ("AE_AGENT_BIN_PATH", &bin),
            ("AE_DSH_RUNTIME", &runtime),
            ("AE_DSH_ENTRY", &entry),
        ] {
            source.insert(name.into(), path.to_string_lossy().into_owned().into());
        }
        source.insert(
            "DSH_HOME".into(),
            directory
                .join("home/.dsh")
                .to_string_lossy()
                .into_owned()
                .into(),
        );
        let environment_file = directory.join("configuration/environment.json");
        std::fs::write(&environment_file, serde_json::to_vec(&source).unwrap()).unwrap();
        let literal = "$(touch outside); 'literal' 中文".to_string();
        let output = prepare(
            &data,
            AgentId::DeepSeekHarness,
            &["--json".into(), literal.clone()],
        )
        .unwrap()
        .output()
        .unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            format!(
                "{}\n{}\n{}\n--profile\nheadless\n--json\n{literal}\n",
                directory.join("workspace").display(),
                directory.join("home/.dsh").display(),
                entry.canonicalize().unwrap().display()
            )
        );
        assert!(!directory.join("workspace/outside").exists());
        let no_arguments = prepare(&data, AgentId::DeepSeekHarness, &[]).unwrap();
        assert_eq!(
            no_arguments.get_args().collect::<Vec<_>>(),
            vec![
                entry.as_os_str(),
                std::ffi::OsStr::new("--profile"),
                std::ffi::OsStr::new("headless")
            ]
        );
        std::fs::remove_file(&entry).unwrap();
        assert!(prepare(&data, AgentId::DeepSeekHarness, &[]).is_err());
    }
}
