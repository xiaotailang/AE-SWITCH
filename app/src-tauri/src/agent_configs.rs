//! Official agent configurations isolated inside the portable Rust data root.
#![forbid(unsafe_code)]

use crate::error::{AppError, Result};
use crate::writer;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

mod existing;
mod jsonc;
mod launchers;
mod native_merge;
pub use existing::ExistingProfile;

// Official OMP CHAT_MODEL_ROLE_IDS; independent runner-kind roles stay unchanged.
const OMP_CHAT_MODEL_ROLES: &[&str] = &[
    "default", "smol", "slow", "vision", "plan", "commit", "tiny", "memory", "task", "advisor",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentId {
    ClaudeCode,
    Codex,
    Hermes,
    OhMyPi,
    #[serde(rename = "opencode")]
    OpenCode,
    Zcode,
    #[serde(rename = "workbuddy")]
    WorkBuddy,
    #[serde(rename = "deepseek_harness")]
    DeepSeekHarness,
}

impl AgentId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude_code",
            Self::Codex => "codex",
            Self::Hermes => "hermes",
            Self::OhMyPi => "oh_my_pi",
            Self::OpenCode => "opencode",
            Self::Zcode => "zcode",
            Self::WorkBuddy => "workbuddy",
            Self::DeepSeekHarness => "deepseek_harness",
        }
    }

    pub fn command(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude",
            Self::Codex => "codex",
            Self::Hermes => "hermes",
            Self::OhMyPi => "omp",
            Self::OpenCode => "opencode",
            Self::Zcode => "zcode",
            Self::WorkBuddy => "workbuddy",
            Self::DeepSeekHarness => "dsh",
        }
    }

    #[cfg(test)]
    fn config_files(self) -> Vec<(&'static str, ConfigKind)> {
        match self {
            Self::ClaudeCode => vec![("home/.claude/settings.json", ConfigKind::Json)],
            Self::Codex => vec![("home/.codex/config.toml", ConfigKind::Toml)],
            Self::Hermes => vec![("home/.hermes/config.yaml", ConfigKind::Yaml)],
            Self::OhMyPi => vec![
                ("home/.omp/agent/models.yml", ConfigKind::Yaml),
                ("home/.omp/agent/config.yml", ConfigKind::Yaml),
            ],
            Self::OpenCode => vec![("configuration/opencode.json", ConfigKind::Json)],
            Self::Zcode => vec![
                ("configuration/zcode-providers.json", ConfigKind::Json),
                ("configuration/zcode-builtin.json", ConfigKind::Json),
            ],
            Self::WorkBuddy => vec![("home/.workbuddy/models.json", ConfigKind::Json)],
            Self::DeepSeekHarness => vec![(
                "home/.dsh/profiles/headless/cordis.patch.yml",
                ConfigKind::Json,
            )],
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinition {
    pub id: AgentId,
    pub name: &'static str,
    pub description: &'static str,
    pub protocol: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfiguredAgent {
    pub id: AgentId,
    pub name: &'static str,
    pub description: &'static str,
    pub protocol: &'static str,
    pub configured: bool,
    pub directory: String,
    pub launcher: String,
    pub model: String,
}

/// The launcher exposed to users; verification uses `validate_launch` instead.
pub fn launcher_file_name() -> &'static str {
    if cfg!(windows) {
        "launch.cmd"
    } else {
        "launch.sh"
    }
}

fn execution_launcher_file_name() -> &'static str {
    if cfg!(windows) {
        "launch.ps1"
    } else {
        "launch.sh"
    }
}

pub fn definitions() -> Vec<AgentDefinition> {
    vec![
        AgentDefinition {
            id: AgentId::ClaudeCode,
            name: "Claude Code",
            description: "Anthropic 编程代理与工具调用",
            protocol: "anthropic",
        },
        AgentDefinition {
            id: AgentId::Codex,
            name: "Codex",
            description: "OpenAI Responses 编程代理",
            protocol: "responses",
        },
        AgentDefinition {
            id: AgentId::Hermes,
            name: "Hermes Agent",
            description: "可扩展的个人编程与自动化代理",
            protocol: "openai",
        },
        AgentDefinition {
            id: AgentId::OhMyPi,
            name: "oh-my-pi",
            description: "现代终端编程代理与工作流",
            protocol: "openai",
        },
        AgentDefinition {
            id: AgentId::OpenCode,
            name: "OpenCode",
            description: "开放的多模型编程代理",
            protocol: "openai",
        },
        AgentDefinition {
            id: AgentId::Zcode,
            name: "Z Code",
            description: "智谱开源编程代理",
            protocol: "openai",
        },
        AgentDefinition {
            id: AgentId::WorkBuddy,
            name: "WorkBuddy",
            description: "腾讯 WorkBuddy 官方桌面包内置推理与工具运行器",
            protocol: "openai",
        },
        AgentDefinition {
            id: AgentId::DeepSeekHarness,
            name: "DeepSeek Harness",
            description: "DeepSeek 官方编程代理与文件工具运行器",
            protocol: "openai",
        },
    ]
}

pub fn configure(
    root: &Path,
    agent: AgentId,
    base_url: &str,
    local_token: &str,
    model: &str,
) -> Result<ConfiguredAgent> {
    configure_with_selection(root, agent, base_url, local_token, model, None)
}

// Keep the transaction's native target and selection snapshot together at this boundary.
#[allow(clippy::too_many_arguments)]
pub(crate) fn configure_existing_with_selection(
    root: &Path,
    agent: AgentId,
    base_url: &str,
    local_token: &str,
    model: &str,
    profile: &ExistingProfile,
    selection: (&Path, &str, Option<&str>),
) -> Result<ConfiguredAgent> {
    validate_inputs(root, base_url, local_token, model)?;
    recover_configuration(root)?;
    existing::validate_profile(agent, profile)?;
    let mut environment = serde_json::Map::new();
    let (snapshots, writes) = plan_agent_configuration(
        root,
        Path::new(&profile.directory),
        agent,
        base_url,
        local_token,
        model,
        &mut environment,
        Some(profile),
    )?;
    existing::commit(root, agent, profile, &snapshots, writes, selection)?;
    let definition = definitions()
        .into_iter()
        .find(|item| item.id == agent)
        .expect("defined agent");
    Ok(ConfiguredAgent {
        id: agent,
        name: definition.name,
        description: definition.description,
        protocol: definition.protocol,
        configured: true,
        directory: profile.directory.clone(),
        launcher: profile.executable_path.clone(),
        model: model.into(),
    })
}

pub fn validate_existing_profile(agent: AgentId, profile: &ExistingProfile) -> Result<()> {
    existing::validate_profile(agent, profile)
}

#[cfg(windows)]
pub(crate) fn validate_existing_runtime_directory(path: &Path) -> Result<()> {
    existing::absolute_path(&path.to_string_lossy())?;
    check_existing_ancestors(path)?;
    if !path.is_dir() {
        return Err(AppError::new(
            "restart_profile",
            "原客户端的用户数据或工作目录不存在，未关闭或重新打开客户端",
        ));
    }
    Ok(())
}

pub(crate) fn prepare_existing_profile(
    agent: AgentId,
    profile: &ExistingProfile,
) -> Result<ExistingProfile> {
    existing::validate_profile(agent, profile)?;
    let mut selected = profile.clone();
    if agent == AgentId::Zcode && selected.state_file.is_none() {
        let paths = existing::configuration_paths(agent, profile)?;
        selected.state_file = Some(paths["state"].to_string_lossy().into_owned());
    }
    Ok(selected)
}

pub(crate) fn read_workbuddy_models(path: &Path) -> Result<String> {
    native_merge::read_authorized(path, [path.to_owned()].iter())?.ok_or_else(|| {
        AppError::new(
            "invalid_agent_configuration",
            "WorkBuddy 原生模型配置不存在",
        )
    })
}

pub(crate) fn existing_omp_root_name(profile: &ExistingProfile) -> Result<String> {
    existing::omp_root_name(profile)
}

pub(crate) fn existing_dsh_credential_ref(profile: &ExistingProfile) -> String {
    existing::dsh_credential_ref(profile)
}

pub(crate) fn configure_with_selection(
    root: &Path,
    agent: AgentId,
    base_url: &str,
    local_token: &str,
    model: &str,
    selection: Option<(&Path, &str, Option<&str>)>,
) -> Result<ConfiguredAgent> {
    validate_inputs(root, base_url, local_token, model)?;
    recover_configuration(root)?;
    let directory = root.join("agents").join(agent.as_str());
    ensure_directory(root, &directory)?;
    for relative in [
        "home",
        "tmp",
        "cache",
        "configuration",
        "workspace",
        "home/AppData/Roaming",
        "home/AppData/Local",
        "configuration/xdg",
        "home/data",
        "home/state",
        "cache/npm",
        "cache/pip",
        "cache/uv",
        "cache/pycache",
        "cache/nuget",
        "cache/bun",
        "home/npm",
        "home/dotnet",
        "home/cargo",
        "home/rustup",
        "home/uv-python",
    ] {
        ensure_directory(root, &directory.join(relative))?;
    }
    let mut environment = portable_environment(&directory);
    environment.insert(
        "AE_AGENT_ROOT".into(),
        directory.to_string_lossy().into_owned().into(),
    );
    environment.insert("AE_GATEWAY_TOKEN".into(), local_token.into());
    environment.insert("AE_SWITCH_API_KEY".into(), local_token.into());
    environment.insert(
        "AE_AGENT_ALLOWED_ROOT".into(),
        root.to_string_lossy().into_owned().into(),
    );
    add_bundled_tools(&directory, agent, &mut environment)?;
    let (mut snapshots, mut writes) = plan_agent_configuration(
        root,
        &directory,
        agent,
        base_url,
        local_token,
        model,
        &mut environment,
        None,
    )?;
    writes.push((
        directory.join("configuration/environment.json"),
        native_merge::text(&serde_json::Value::Object(environment.clone()))?,
    ));
    #[cfg(windows)]
    {
        writes.push((directory.join("launch.ps1"), powershell_launcher(agent)));
        writes.push((directory.join("launch.cmd"), CMD_LAUNCHER.into()));
    }
    #[cfg(unix)]
    {
        let launcher = directory.join("launch.sh");
        let relative_root = environment
            .get("AE_AGENT_PORTABLE_RELATIVE_ROOT")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("../../..");
        writes.push((launcher, launchers::posix_launcher(agent, relative_root)));
    }
    if let Some((path, contents, expected)) = selection {
        let before = native_merge::snapshot(root, path, &mut snapshots)?;
        if before.as_deref() != expected {
            return Err(AppError::new(
                "agent_configuration_changed",
                "Agent 选择状态在配置期间被修改，原配置未覆盖，请刷新后重试",
            ));
        }
        writes.push((path.to_owned(), contents.to_owned()));
    }
    for (path, _) in &writes {
        if !snapshots.iter().any(|(before_path, _)| before_path == path) {
            native_merge::snapshot(root, path, &mut snapshots)?;
        }
    }
    commit_native_configuration(root, &snapshots, writes)?;
    let definition = definitions()
        .into_iter()
        .find(|item| item.id == agent)
        .expect("all AgentId variants have a definition");
    Ok(ConfiguredAgent {
        id: agent,
        name: definition.name,
        description: definition.description,
        protocol: definition.protocol,
        configured: true,
        directory: directory.to_string_lossy().into_owned(),
        launcher: directory
            .join(launcher_file_name())
            .to_string_lossy()
            .into_owned(),
        model: model.to_owned(),
    })
}

/// Revalidate paths immediately before the host starts a configured agent.
pub fn validate_launch(root: &Path, agent: AgentId) -> Result<PathBuf> {
    validate_root(root)?;
    let directory = root.join("agents").join(agent.as_str());
    for relative in ["home", "tmp", "cache", "configuration", "workspace"] {
        let path = directory.join(relative);
        check_existing_ancestors(&path)?;
        if !path.is_dir() {
            return Err(AppError::new(
                "missing_configuration",
                "Portable agent directories are missing; apply its configuration again",
            ));
        }
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|error| AppError::io(root, error))?;
    for relative in [
        execution_launcher_file_name(),
        "configuration/environment.json",
    ] {
        let path = directory.join(relative);
        check_existing_ancestors(&path)?;
        let metadata =
            std::fs::symlink_metadata(&path).map_err(|error| AppError::io(&path, error))?;
        if !metadata.is_file()
            || !path
                .canonicalize()
                .map_err(|error| AppError::io(&path, error))?
                .starts_with(&canonical_root)
        {
            return Err(AppError::new(
                "unsafe_path",
                "Portable agent launch files must remain inside the data root",
            ));
        }
        #[cfg(unix)]
        if relative == execution_launcher_file_name() {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o7777 != 0o700 {
                return Err(AppError::new(
                    "unsafe_permissions",
                    "Portable agent launchers must be executable only by their owner",
                ));
            }
        }
    }
    Ok(directory.join(execution_launcher_file_name()))
}

fn validate_inputs(root: &Path, base_url: &str, token: &str, model: &str) -> Result<()> {
    validate_root(root)?;
    let url = url::Url::parse(base_url).map_err(|_| {
        AppError::new(
            "invalid_endpoint",
            "Agent endpoint must be the local Rust gateway",
        )
    })?;
    let loopback = match url.host() {
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        Some(url::Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        None => false,
    };
    if !matches!(url.scheme(), "http" | "https")
        || !loopback
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(AppError::new(
            "invalid_endpoint",
            "Agent endpoint must be the local Rust gateway without embedded credentials",
        ));
    }
    if token.is_empty()
        || token.chars().any(char::is_whitespace)
        || token.chars().any(char::is_control)
    {
        return Err(AppError::new(
            "invalid_token",
            "Local gateway authentication token is invalid",
        ));
    }
    if model.trim().is_empty() || model.len() > 512 || model.chars().any(char::is_control) {
        return Err(AppError::new("invalid_model", "Choose a valid model name"));
    }
    Ok(())
}

fn validate_root(root: &Path) -> Result<()> {
    crate::portable::validate_root(root)?;
    check_existing_ancestors(root)
}

fn check_existing_ancestors(path: &Path) -> Result<()> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        let metadata = match std::fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(AppError::io(&current, error)),
        };
        let linked = metadata.file_type().is_symlink();
        #[cfg(windows)]
        let linked = {
            use std::os::windows::fs::MetadataExt;
            linked || metadata.file_attributes() & 0x400 != 0
        };
        if linked {
            return Err(AppError::new(
                "unsafe_path",
                "Portable agent paths cannot contain symbolic links or junctions",
            ));
        }
    }
    Ok(())
}

fn ensure_directory(root: &Path, path: &Path) -> Result<()> {
    if !path.starts_with(root) {
        return Err(AppError::new(
            "unsafe_path",
            "Agent directory is outside the portable root",
        ));
    }
    check_existing_ancestors(path)?;
    writer::private_directory(path)?;
    check_existing_ancestors(path)?;
    let canonical_root = root
        .canonicalize()
        .map_err(|error| AppError::io(root, error))?;
    let canonical_path = path
        .canonicalize()
        .map_err(|error| AppError::io(path, error))?;
    if !canonical_path.starts_with(canonical_root) {
        return Err(AppError::new(
            "unsafe_path",
            "Agent directory escaped the portable root",
        ));
    }
    Ok(())
}

fn write_checked(root: &Path, path: &Path, contents: &str) -> Result<()> {
    if !path.starts_with(root) {
        return Err(AppError::new(
            "unsafe_path",
            "Agent configuration is outside the portable root",
        ));
    }
    let parent = path.parent().ok_or_else(|| {
        AppError::new(
            "invalid_path",
            "Agent configuration has no parent directory",
        )
    })?;
    ensure_directory(root, parent)?;
    check_existing_ancestors(path)?;
    writer::write(path, Some(contents))
}

fn portable_environment(directory: &Path) -> serde_json::Map<String, serde_json::Value> {
    let mut environment = serde_json::Map::new();
    let inherited_bypass = std::env::var("NO_PROXY")
        .or_else(|_| std::env::var("no_proxy"))
        .unwrap_or_default();
    let bypass = if inherited_bypass.is_empty() {
        "localhost,127.0.0.1,::1".to_owned()
    } else {
        format!("{inherited_bypass},localhost,127.0.0.1,::1")
    };
    environment.insert("NO_PROXY".into(), bypass.into());
    for (name, relative) in [
        ("HOME", "home"),
        ("USERPROFILE", "home"),
        ("APPDATA", "home/AppData/Roaming"),
        ("LOCALAPPDATA", "home/AppData/Local"),
        ("TEMP", "tmp"),
        ("TMP", "tmp"),
        ("TMPDIR", "tmp"),
        ("XDG_CONFIG_HOME", "configuration/xdg"),
        ("XDG_DATA_HOME", "home/data"),
        ("XDG_CACHE_HOME", "cache"),
        ("XDG_STATE_HOME", "home/state"),
        ("npm_config_cache", "cache/npm"),
        ("npm_config_prefix", "home/npm"),
        ("UV_CACHE_DIR", "cache/uv"),
        ("PIP_CACHE_DIR", "cache/pip"),
        ("PYTHONPYCACHEPREFIX", "cache/pycache"),
        ("DOTNET_CLI_HOME", "home/dotnet"),
        ("NUGET_PACKAGES", "cache/nuget"),
        ("GIT_CONFIG_GLOBAL", "configuration/gitconfig"),
        ("CARGO_HOME", "home/cargo"),
        ("RUSTUP_HOME", "home/rustup"),
        ("UV_PYTHON_INSTALL_DIR", "home/uv-python"),
        ("BUN_INSTALL_CACHE_DIR", "cache/bun"),
    ] {
        environment.insert(
            name.to_owned(),
            directory
                .join(relative)
                .to_string_lossy()
                .into_owned()
                .into(),
        );
    }
    environment
}

fn add_bundled_tools(
    directory: &Path,
    agent: AgentId,
    environment: &mut serde_json::Map<String, serde_json::Value>,
) -> Result<()> {
    let platform = launchers::BundlePlatform::current();
    let Some(portable_root) = std::env::var_os("AE_SWITCH_PORTABLE_ROOT").map(PathBuf::from) else {
        return Ok(());
    };
    if !portable_root.is_absolute()
        || portable_root
            .components()
            .any(|component| matches!(component, Component::ParentDir))
        || !directory.starts_with(&portable_root)
    {
        return Err(AppError::new(
            "unsafe_path",
            "Agent root must be inside the declared portable workspace",
        ));
    }
    check_existing_ancestors(&portable_root)?;
    let levels = directory
        .strip_prefix(&portable_root)
        .map_err(|_| AppError::new("unsafe_path", "Invalid portable root"))?
        .components()
        .count();
    let relative_root = std::iter::repeat_n("..", levels)
        .collect::<Vec<_>>()
        .join("/");
    environment.insert(
        "AE_SWITCH_PORTABLE_ROOT".into(),
        portable_root.to_string_lossy().into_owned().into(),
    );
    environment.insert(
        "AE_AGENT_PORTABLE_RELATIVE_ROOT".into(),
        relative_root.into(),
    );
    if let Some(tools_root) = std::env::var_os("AE_SWITCH_TOOLS_DIR").map(PathBuf::from) {
        if !tools_root.is_absolute()
            || !tools_root.starts_with(&portable_root)
            || tools_root
                .components()
                .any(|component| matches!(component, Component::ParentDir))
        {
            return Err(AppError::new(
                "unsafe_path",
                "Bundled agents must be inside the portable workspace",
            ));
        }
        let hermes_wrapper = tools_root.join(launchers::hermes_wrapper(platform));
        if agent == AgentId::Hermes {
            check_existing_ancestors(&hermes_wrapper)?;
        }
        let relative = match agent {
            AgentId::ClaudeCode => "claude/node_modules/.bin",
            AgentId::Codex => "codex/node_modules/.bin",
            AgentId::Hermes => launchers::hermes_bin(platform, hermes_wrapper.is_file()),
            AgentId::OhMyPi => "oh_my_pi",
            AgentId::OpenCode => "opencode/node_modules/.bin",
            AgentId::Zcode => "zcode",
            AgentId::WorkBuddy => "workbuddy",
            AgentId::DeepSeekHarness => "deepseek_harness/node_modules/.bin",
        };
        let bin = tools_root.join(relative);
        check_existing_ancestors(&bin)?;
        let mut bin_paths = Vec::new();
        if bin.is_dir() {
            bin_paths.push(bin);
        }
        if agent == AgentId::WorkBuddy {
            for runtime_directory in [
                tools_root.join("workbuddy"),
                portable_root.join(".tools/workbuddy"),
            ] {
                let mut found = false;
                for (runtime, entry) in launchers::workbuddy_entries(&runtime_directory, platform) {
                    check_existing_ancestors(&runtime)?;
                    check_existing_ancestors(&entry)?;
                    if !runtime.is_file() || !entry.is_file() {
                        continue;
                    }
                    environment.insert(
                        "AE_WORKBUDDY_RUNTIME".into(),
                        runtime.to_string_lossy().into_owned().into(),
                    );
                    environment.insert(
                        "AE_WORKBUDDY_ENTRY".into(),
                        entry.to_string_lossy().into_owned().into(),
                    );
                    found = true;
                    break;
                }
                if found {
                    break;
                }
            }
        }
        if agent == AgentId::DeepSeekHarness {
            let entry =
                tools_root.join("deepseek_harness/node_modules/@deepseek-ai/dsh/lib/bin.js");
            check_existing_ancestors(&entry)?;
            let nodes: &[&str] = match platform {
                launchers::BundlePlatform::Windows => {
                    &["tools/node/node.exe", ".tools/node/node.exe"]
                }
                _ => &[
                    "tools/node/bin/node",
                    "tools/node/node",
                    ".tools/node/bin/node",
                    ".tools/node/node",
                ],
            };
            for relative in nodes {
                let runtime = portable_root.join(relative);
                check_existing_ancestors(&runtime)?;
                if runtime.is_file() && entry.is_file() {
                    environment.insert(
                        "AE_DSH_RUNTIME".into(),
                        runtime.to_string_lossy().into_owned().into(),
                    );
                    environment.insert(
                        "AE_DSH_ENTRY".into(),
                        entry.to_string_lossy().into_owned().into(),
                    );
                    break;
                }
            }
            if matches!(platform, launchers::BundlePlatform::Windows) {
                for relative in ["tools/pwsh", ".tools/pwsh"] {
                    let bin = portable_root.join(relative);
                    let executable = bin.join("pwsh.exe");
                    check_existing_ancestors(&executable)?;
                    if executable.is_file() {
                        environment.insert(
                            "AE_DSH_PWSH".into(),
                            executable.to_string_lossy().into_owned().into(),
                        );
                        bin_paths.push(bin);
                        break;
                    }
                }
            }
        }
        for relative in launchers::runtime_bins(platform) {
            let bin = portable_root.join(relative);
            check_existing_ancestors(&bin)?;
            if bin.is_dir() {
                bin_paths.push(bin);
            }
        }
        if !bin_paths.is_empty() {
            let paths = std::env::join_paths(bin_paths).map_err(|_| {
                AppError::new(
                    "invalid_path",
                    "Bundled tool directories cannot be represented in PATH",
                )
            })?;
            environment.insert(
                "AE_AGENT_BIN_PATH".into(),
                paths.to_string_lossy().into_owned().into(),
            );
        }
    }
    for relative in launchers::bundled_bash(platform) {
        let bash = portable_root.join(relative);
        check_existing_ancestors(&bash)?;
        if bash.is_file() {
            let bash = bash.to_string_lossy().into_owned();
            environment.insert("CLAUDE_CODE_GIT_BASH_PATH".into(), bash.clone().into());
            if agent == AgentId::WorkBuddy {
                environment.insert("CODEBUDDY_CODE_GIT_BASH_PATH".into(), bash.into());
            }
            break;
        }
    }
    for variable in ["CARGO_HOME", "RUSTUP_HOME", "UV_PYTHON_INSTALL_DIR"] {
        if let Some(path) = std::env::var_os(variable).map(PathBuf::from) {
            if path.is_absolute()
                && path.starts_with(&portable_root)
                && !path
                    .components()
                    .any(|component| matches!(component, Component::ParentDir))
            {
                check_existing_ancestors(&path)?;
                environment.insert(
                    variable.to_owned(),
                    path.to_string_lossy().into_owned().into(),
                );
            }
        }
    }
    Ok(())
}

type NativePlan = (Vec<native_merge::Snapshot>, Vec<(PathBuf, String)>);

#[allow(clippy::too_many_arguments)]
fn plan_agent_configuration(
    root: &Path,
    directory: &Path,
    agent: AgentId,
    base_url: &str,
    token: &str,
    model: &str,
    environment: &mut serde_json::Map<String, serde_json::Value>,
    profile: Option<&ExistingProfile>,
) -> Result<NativePlan> {
    // All native files are read, parsed and merged before the first native write.
    // A malformed secondary file therefore cannot clobber an earlier one.
    let mut writes: Vec<(PathBuf, String)> = Vec::new();
    let mut snapshots = Vec::new();
    let paths = profile
        .map(|profile| existing::configuration_paths(agent, profile))
        .transpose()?;
    let path_for = |slot: &str, relative: &str| -> PathBuf {
        paths
            .as_ref()
            .and_then(|paths| paths.get(slot))
            .cloned()
            .unwrap_or_else(|| directory.join(relative))
    };
    let snapshot = |path: &Path, snapshots: &mut Vec<native_merge::Snapshot>| {
        if let Some(paths) = &paths {
            native_merge::snapshot_authorized(path, paths.values(), snapshots)
        } else {
            native_merge::snapshot(root, path, snapshots)
        }
    };
    match agent {
        AgentId::DeepSeekHarness => {
            environment.insert(
                "DSH_HOME".into(),
                directory
                    .join("home/.dsh")
                    .to_string_lossy()
                    .into_owned()
                    .into(),
            );
            environment.insert("DSH_TELEMETRY_MODE".into(), "DISABLED".into());
            let private_profile = directory.join("home/.dsh/profiles/headless");
            let package_path = private_profile.join("package.json");
            let workspace_path = private_profile.join("pnpm-workspace.yaml");
            let patch_path = path_for("config", "home/.dsh/profiles/headless/cordis.patch.yml");
            let package_text = if profile.is_none() {
                snapshot(&package_path, &mut snapshots)?
            } else {
                None
            };
            let workspace_text = if profile.is_none() {
                snapshot(&workspace_path, &mut snapshots)?
            } else {
                None
            };
            let patch_text = snapshot(&patch_path, &mut snapshots)?;
            let mut package = native_merge::json(
                package_text.as_deref(),
                &package_path,
                serde_json::json!({}),
            )?;
            let workspace = native_merge::Yaml::parse(
                workspace_text.as_deref(),
                &workspace_path,
                serde_json::json!({}),
            )?;
            let patch_source = native_merge::Yaml::parse(
                patch_text.as_deref(),
                &patch_path,
                serde_json::json!([]),
            )?;
            let mut workspace_value = workspace.value();
            native_merge::object(&mut workspace_value, &workspace_path)?;
            if let Some(packages) = workspace_value.get("packages") {
                if !packages
                    .as_array()
                    .is_some_and(|values| values.iter().all(serde_json::Value::is_string))
                {
                    return Err(native_merge::invalid(&workspace_path));
                }
            }
            native_merge::default(
                &mut workspace_value,
                "nodeLinker",
                "hoisted".into(),
                &workspace_path,
            )?;
            native_merge::default(
                &mut workspace_value,
                "autoInstallPeers",
                false.into(),
                &workspace_path,
            )?;
            native_merge::default(
                &mut package,
                "name",
                "dsh-profile-headless".into(),
                &package_path,
            )?;
            native_merge::default(&mut package, "private", true.into(), &package_path)?;
            native_merge::child(&mut package, "dependencies", &package_path)?;
            let profile_config = native_merge::child(
                native_merge::child(&mut package, "dsh", &package_path)?,
                "profile",
                &package_path,
            )?;
            let bundles = native_merge::array(profile_config, "bundles", &package_path)?;
            if !bundles.iter().all(serde_json::Value::is_string) {
                return Err(native_merge::invalid(&package_path));
            }
            for bundle in ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] {
                if !bundles.iter().any(|value| value == bundle) {
                    bundles.push(bundle.into());
                }
            }
            let mut patch = patch_source.value();
            native_merge::rows(&mut patch, &patch_path, "id")?;
            let rows = patch.as_array_mut().expect("validated patch array");
            for row in rows.iter_mut() {
                let id = row
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                if profile.is_some() {
                    let expected = match id {
                        "llm-pi-ai" => Some("@deepseek-ai/dsh-llm-pi-ai"),
                        "agent-default-model" => Some("@deepseek-ai/dsh-agent-default-model"),
                        _ => None,
                    };
                    if expected.is_some_and(|expected| {
                        row.get("name").is_some_and(|name| name != expected)
                    }) {
                        return Err(AppError::new("agent_configuration_conflict", "DeepSeek Harness 关键模型插件已被替换，原 profile 未修改；请在原工具恢复官方插件后重试"));
                    }
                }
                if (matches!(id, "llm-pi-ai" | "agent-default-model")
                    || (profile.is_none() && cfg!(windows) && id == "pwsh-sandbox"))
                    && row.get("disabled") == Some(&serde_json::Value::Bool(true))
                {
                    return Err(AppError::new(
                        "agent_configuration_conflict",
                        "DeepSeek 必需的运行插件已被停用，原配置未覆盖。请在原工具中启用后重试",
                    ));
                }
                if row.get("disabled").is_some() {
                    native_merge::default(row, "disabled", false.into(), &patch_path)?;
                }
                if row.get("config").is_some() {
                    native_merge::child(row, "config", &patch_path)?;
                }
            }
            let default_row = native_merge::row(rows, "id", "agent-default-model");
            let default_config = native_merge::child(default_row, "config", &patch_path)?;
            let previous = if default_config
                .get("provider")
                .and_then(serde_json::Value::as_str)
                == Some("ae-switch")
            {
                default_config
                    .get("model")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            } else {
                None
            };
            native_merge::set(default_config, "provider", "ae-switch".into(), &patch_path)?;
            native_merge::set(default_config, "model", model.into(), &patch_path)?;
            let provider = native_merge::child(
                native_merge::child(
                    native_merge::child(
                        native_merge::row(rows, "id", "llm-pi-ai"),
                        "config",
                        &patch_path,
                    )?,
                    "providers",
                    &patch_path,
                )?,
                "ae-switch",
                &patch_path,
            )?;
            native_merge::update_authorization_headers(provider, token, &patch_path)?;
            native_merge::set(provider, "api", "openai-completions".into(), &patch_path)?;
            native_merge::set(provider, "baseURL", base_url.into(), &patch_path)?;
            native_merge::set(
                provider,
                "apiKeyEnv",
                profile
                    .map(existing::dsh_credential_ref)
                    .unwrap_or_else(|| "AE_GATEWAY_TOKEN".into())
                    .into(),
                &patch_path,
            )?;
            let models = native_merge::array(provider, "models", &patch_path)?;
            native_merge::selected_model(models, model, previous.as_deref(), &patch_path)?;
            // Official default workflows inherit the parent route unless a
            // deployment explicitly pinned their own provider/model pair.
            let sync_pair = |value: &mut serde_json::Value,
                             provider_key: &str,
                             model_key: &str,
                             allow_empty: bool,
                             allow_partial: bool|
             -> Result<()> {
                native_merge::object(value, &patch_path)?;
                let provider = value.get(provider_key);
                let chosen = value.get(model_key);
                if provider.is_none() && chosen.is_none() {
                    return Ok(());
                }
                if provider.is_some_and(|value| !value.is_string())
                    || chosen.is_some_and(|value| !value.is_string())
                {
                    return Err(native_merge::invalid(&patch_path));
                }
                let provider = provider.and_then(serde_json::Value::as_str);
                let chosen = chosen.and_then(serde_json::Value::as_str);
                if allow_empty && provider == Some("") && chosen == Some("") {
                    return Ok(());
                }
                if !allow_partial
                    && (provider.is_none_or(str::is_empty) || chosen.is_none_or(str::is_empty))
                {
                    return Err(native_merge::invalid(&patch_path));
                }
                native_merge::set(value, provider_key, "ae-switch".into(), &patch_path)?;
                native_merge::set(value, model_key, model.into(), &patch_path)
            };
            for row in rows.iter_mut() {
                let id = row["id"].as_str().unwrap_or("").to_owned();
                let Some(config) = row.get_mut("config") else {
                    continue;
                };
                match id.as_str() {
                    "compaction-basic" => {
                        sync_pair(
                            config,
                            "summarizationProvider",
                            "summarizationModel",
                            true,
                            false,
                        )?;
                        if let Some(policies) = config.get_mut("modelPolicies") {
                            let policies = policies
                                .as_array_mut()
                                .ok_or_else(|| native_merge::invalid(&patch_path))?;
                            for policy in policies {
                                sync_pair(
                                    policy,
                                    "summarizationProvider",
                                    "summarizationModel",
                                    true,
                                    false,
                                )?;
                            }
                        }
                    }
                    "session-title-llm" => sync_pair(config, "provider", "model", false, false)?,
                    "tool-subagent" | "tool-subagent-fork" => {
                        if let Some(options) = config.get_mut("agentOptions") {
                            // config.provider selects spawn/fork, not the LLM.
                            sync_pair(options, "provider", "model", false, true)?;
                        }
                    }
                    _ => {}
                }
            }
            if let Some(profile) = profile {
                existing::plan_dsh_credentials(profile, rows, &mut snapshots, &mut writes, token)?;
            }
            if profile.is_none() {
                for id in ["session-log-deepseek", "session-telemetry-otel"] {
                    native_merge::default(
                        native_merge::row(rows, "id", id),
                        "disabled",
                        true.into(),
                        &patch_path,
                    )?;
                }
            }
            if profile.is_none() && cfg!(windows) {
                ensure_directory(root, &directory.join("cache/pwsh"))?;
                environment.insert("POWERSHELL_TELEMETRY_OPTOUT".into(), "1".into());
                environment.insert(
                    "PSModuleAnalysisCachePath".into(),
                    directory
                        .join("cache/pwsh/ModuleAnalysisCache")
                        .to_string_lossy()
                        .into_owned()
                        .into(),
                );
                let relative_root = environment
                    .get("AE_AGENT_PORTABLE_RELATIVE_ROOT")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("../../..");
                let pwsh_relative = environment
                    .get("AE_DSH_PWSH")
                    .and_then(serde_json::Value::as_str)
                    .zip(
                        environment
                            .get("AE_SWITCH_PORTABLE_ROOT")
                            .and_then(serde_json::Value::as_str),
                    )
                    .and_then(|(pwsh, portable)| Path::new(pwsh).strip_prefix(portable).ok())
                    .map(|path| path.to_string_lossy().replace('/', "\\"))
                    .unwrap_or_else(|| "tools\\pwsh\\pwsh.exe".into());
                let pwsh_path = format!(
                    "..\\{}\\{}",
                    relative_root.replace('/', "\\"),
                    pwsh_relative
                );
                let sandbox = native_merge::child(
                    native_merge::row(rows, "id", "pwsh-sandbox"),
                    "config",
                    &patch_path,
                )?;
                native_merge::set(sandbox, "pwshPath", pwsh_path.into(), &patch_path)?;
            }
            if profile.is_none() {
                writes.push((package_path, native_merge::text(&package)?));
            }
            if profile.is_none() && workspace_text.is_none() {
                writes.push((
                    workspace_path,
                    "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n".into(),
                ));
            }
            // Preserve existing row order; a new profile uses the historical
            // provider-first scaffold required by its native codec.
            if patch_text.is_none() {
                rows.sort_by_key(|row| match row["id"].as_str().unwrap_or("") {
                    "llm-pi-ai" => 0,
                    "agent-default-model" => 1,
                    "session-log-deepseek" => 2,
                    "session-title-llm" => 3,
                    "session-telemetry-otel" => 4,
                    _ => 5,
                });
            }
            writes.push((
                patch_path.clone(),
                patch_source.render(&patch, &patch_path)?,
            ));
        }
        AgentId::ClaudeCode => {
            let path = path_for("config", "home/.claude/settings.json");
            let existing = snapshot(&path, &mut snapshots)?;
            let mut settings =
                native_merge::json(existing.as_deref(), &path, serde_json::json!({}))?;
            if profile.is_none() {
                native_merge::object(&mut settings, &path)?.remove("apiKeyHelper");
            }
            let native_env = native_merge::child(&mut settings, "env", &path)?;
            for key in [
                "ANTHROPIC_AUTH_TOKEN",
                "CLAUDE_CODE_USE_BEDROCK",
                "CLAUDE_CODE_USE_VERTEX",
                "CLAUDE_CODE_USE_FOUNDRY",
                "CLAUDE_CODE_USE_ANTHROPIC_AWS",
                "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
                "CLAUDE_CODE_USE_MANTLE",
                "CLAUDE_CODE_USE_GATEWAY",
                "ANTHROPIC_UNIX_SOCKET",
            ] {
                native_merge::object(native_env, &path)?.remove(key);
            }
            for (name, value) in [
                ("ANTHROPIC_BASE_URL", base_url),
                ("ANTHROPIC_API_KEY", token),
                ("ANTHROPIC_MODEL", model),
            ] {
                native_merge::set(native_env, name, value.into(), &path)?;
                environment.insert(name.to_owned(), value.into());
            }
            for name in [
                "ANTHROPIC_DEFAULT_OPUS_MODEL",
                "ANTHROPIC_DEFAULT_SONNET_MODEL",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            ] {
                native_merge::set(native_env, name, model.into(), &path)?;
                environment.insert(name.into(), model.into());
            }
            for name in ["CLAUDE_CODE_SUBAGENT_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"] {
                if native_env.get(name).is_some() {
                    native_merge::set(native_env, name, model.into(), &path)?;
                    environment.insert(name.into(), model.into());
                }
            }
            if let Some(headers) = native_env.get("ANTHROPIC_CUSTOM_HEADERS") {
                let headers = headers
                    .as_str()
                    .ok_or_else(|| native_merge::invalid(&path))?;
                let headers = headers
                    .split('\n')
                    .map(|line| {
                        let Some((name, _)) = line.split_once(':') else {
                            return line.to_owned();
                        };
                        let value = if name.trim().eq_ignore_ascii_case("authorization") {
                            format!("Bearer {token}")
                        } else if name.trim().eq_ignore_ascii_case("x-api-key") {
                            token.to_owned()
                        } else {
                            return line.to_owned();
                        };
                        format!(
                            "{name}: {value}{}",
                            if line.ends_with('\r') { "\r" } else { "" }
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                native_merge::set(
                    native_env,
                    "ANTHROPIC_CUSTOM_HEADERS",
                    headers.clone().into(),
                    &path,
                )?;
                environment.insert("ANTHROPIC_CUSTOM_HEADERS".into(), headers.into());
            }
            if profile.is_none() {
                for name in [
                    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
                    "DISABLE_AUTOUPDATER",
                ] {
                    native_merge::default(native_env, name, "1".into(), &path)?;
                    environment.insert(name.into(), native_env[name].clone());
                }
            }
            environment.insert(
                "CLAUDE_CONFIG_DIR".into(),
                directory
                    .join("home/.claude")
                    .to_string_lossy()
                    .into_owned()
                    .into(),
            );
            writes.push((path, native_merge::text(&settings)?));
        }
        AgentId::Codex => {
            environment.insert(
                "CODEX_HOME".into(),
                directory
                    .join("home/.codex")
                    .to_string_lossy()
                    .into_owned()
                    .into(),
            );
            let path = path_for("config", "home/.codex/config.toml");
            let existing = snapshot(&path, &mut snapshots)?;
            let mut document = existing
                .as_deref()
                .unwrap_or("")
                .parse::<toml_edit::DocumentMut>()
                .map_err(|_| native_merge::invalid(&path))?;
            native_merge::toml_set(
                document.as_table_mut(),
                "model",
                toml_edit::value(model),
                &path,
            )?;
            native_merge::toml_set(
                document.as_table_mut(),
                "model_provider",
                toml_edit::value("ae_switch"),
                &path,
            )?;
            if document.contains_key("review_model") {
                native_merge::toml_set(
                    document.as_table_mut(),
                    "review_model",
                    toml_edit::value(model),
                    &path,
                )?;
            }
            if let Some(profile) = document.get("profile") {
                let profile = profile
                    .as_str()
                    .filter(|name| !name.is_empty())
                    .ok_or_else(|| native_merge::invalid(&path))?
                    .to_owned();
                let active = document
                    .get_mut("profiles")
                    .and_then(toml_edit::Item::as_table_like_mut)
                    .and_then(|profiles| profiles.get_mut(&profile))
                    .and_then(toml_edit::Item::as_table_like_mut)
                    .ok_or_else(|| native_merge::invalid(&path))?;
                if active.contains_key("model") {
                    native_merge::toml_set(active, "model", toml_edit::value(model), &path)?;
                }
                if active.contains_key("review_model") {
                    native_merge::toml_set(active, "review_model", toml_edit::value(model), &path)?;
                }
                if active.contains_key("model_provider") {
                    native_merge::toml_set(
                        active,
                        "model_provider",
                        toml_edit::value("ae_switch"),
                        &path,
                    )?;
                }
            }
            let providers =
                native_merge::toml_child(document.as_table_mut(), "model_providers", &path)?;
            let provider = native_merge::toml_child(providers, "ae_switch", &path)?;
            if ["auth", "gateway_oauth", "aws"]
                .iter()
                .any(|key| provider.contains_key(key))
            {
                return Err(AppError::new(
                    "agent_configuration_conflict",
                    "Codex 的 ae_switch 供应商使用了其它认证方式，原配置未覆盖。请先在原工具中移除该供应商的 auth、gateway_oauth 或 aws 设置后重试",
                ));
            }
            for (name, value) in [("base_url", base_url), ("wire_api", "responses")] {
                native_merge::toml_set(provider, name, toml_edit::value(value), &path)?;
            }
            if profile.is_some() {
                provider.remove("env_key");
                native_merge::toml_set(
                    provider,
                    "experimental_bearer_token",
                    toml_edit::value(token),
                    &path,
                )?;
            } else {
                native_merge::toml_set(
                    provider,
                    "env_key",
                    toml_edit::value("AE_SWITCH_API_KEY"),
                    &path,
                )?;
            }
            if !provider.contains_key("name") {
                provider.insert("name", toml_edit::value("AE Switch Portable Gateway"));
            }
            native_merge::toml_set(
                provider,
                "requires_openai_auth",
                toml_edit::value(false),
                &path,
            )?;
            if !provider.contains_key("supports_websockets") {
                provider.insert("supports_websockets", toml_edit::value(false));
            }
            writes.push((path, document.to_string()));
        }
        AgentId::OhMyPi => {
            environment.insert(
                "PI_CODING_AGENT_DIR".into(),
                directory
                    .join("home/.omp/agent")
                    .to_string_lossy()
                    .into_owned()
                    .into(),
            );
            let models_path = path_for("config", "home/.omp/agent/models.yml");
            let settings_path = path_for("secondary", "home/.omp/agent/config.yml");
            let models_text = snapshot(&models_path, &mut snapshots)?;
            let settings_text = snapshot(&settings_path, &mut snapshots)?;
            let models_source = native_merge::Yaml::parse(
                models_text.as_deref(),
                &models_path,
                serde_json::json!({}),
            )?;
            let settings_source = native_merge::Yaml::parse(
                settings_text.as_deref(),
                &settings_path,
                serde_json::json!({}),
            )?;
            let mut models = models_source.value();
            let mut settings = settings_source.value();
            let roles = native_merge::child(&mut settings, "modelRoles", &settings_path)?;
            let previous = roles
                .get("default")
                .and_then(serde_json::Value::as_str)
                .and_then(|name| name.strip_prefix("ae_switch/"))
                .map(str::to_owned);
            for role in OMP_CHAT_MODEL_ROLES {
                native_merge::set(
                    roles,
                    role,
                    format!("ae_switch/{model}").into(),
                    &settings_path,
                )?;
            }
            let provider = native_merge::child(
                native_merge::child(&mut models, "providers", &models_path)?,
                "ae_switch",
                &models_path,
            )?;
            native_merge::set(provider, "baseUrl", base_url.into(), &models_path)?;
            native_merge::set(provider, "api", "openai-completions".into(), &models_path)?;
            native_merge::set(
                provider,
                "apiKey",
                if profile.is_some() {
                    token
                } else {
                    "AE_SWITCH_API_KEY"
                }
                .into(),
                &models_path,
            )?;
            native_merge::update_authorization_headers(provider, token, &models_path)?;
            if let Some(overrides) = provider.get_mut("modelOverrides") {
                let overrides = native_merge::object(overrides, &models_path)?;
                if let Some(selected_override) = overrides.get_mut(model) {
                    native_merge::object(selected_override, &models_path)?;
                    if selected_override.get("api").is_some() {
                        native_merge::set(
                            selected_override,
                            "api",
                            "openai-completions".into(),
                            &models_path,
                        )?;
                    }
                    native_merge::update_authorization_headers(
                        selected_override,
                        token,
                        &models_path,
                    )?;
                }
            }
            let selected = native_merge::selected_model(
                native_merge::array(provider, "models", &models_path)?,
                model,
                previous.as_deref(),
                &models_path,
            )?;
            // Native model transport overrides take precedence over provider defaults.
            for (key, value) in [("api", "openai-completions"), ("baseUrl", base_url)] {
                if selected.get(key).is_some() {
                    native_merge::set(selected, key, value.into(), &models_path)?;
                }
            }
            native_merge::update_authorization_headers(selected, token, &models_path)?;
            native_merge::default(selected, "name", model.into(), &models_path)?;
            native_merge::default(selected, "contextWindow", 128000.into(), &models_path)?;
            native_merge::default(selected, "maxTokens", 8192.into(), &models_path)?;
            writes.push((
                models_path.clone(),
                models_source.render(&models, &models_path)?,
            ));
            writes.push((
                settings_path.clone(),
                settings_source.render(&settings, &settings_path)?,
            ));
        }
        AgentId::OpenCode => {
            environment.insert(
                "OPENCODE_CONFIG".into(),
                directory
                    .join("configuration/opencode.json")
                    .to_string_lossy()
                    .into_owned()
                    .into(),
            );
            environment.insert("OPENCODE_DISABLE_AUTOUPDATE".into(), "true".into());
            let path = path_for("config", "configuration/opencode.json");
            let existing = snapshot(&path, &mut snapshots)?;
            let source = jsonc::Document::parse(existing.as_deref(), &path)?;
            let mut configuration = source.value();
            for key in ["enabled_providers", "disabled_providers"] {
                if let Some(value) = configuration.get(key) {
                    let values = value
                        .as_array()
                        .filter(|values| values.iter().all(serde_json::Value::is_string))
                        .ok_or_else(|| native_merge::invalid(&path))?;
                    let has_gateway = values.iter().any(|provider| provider == "ae_switch");
                    if (key == "disabled_providers" && has_gateway)
                        || (key == "enabled_providers" && !has_gateway)
                    {
                        return Err(AppError::new("agent_configuration_conflict", "OpenCode 的供应商列表禁用了本地网关，原配置未覆盖。请在原工具中允许 ae_switch 后重试"));
                    }
                }
            }
            let previous = configuration
                .get("model")
                .and_then(serde_json::Value::as_str)
                .and_then(|name| name.strip_prefix("ae_switch/"))
                .map(str::to_owned);
            native_merge::default(
                &mut configuration,
                "$schema",
                "https://opencode.ai/config.json".into(),
                &path,
            )?;
            native_merge::set(
                &mut configuration,
                "model",
                format!("ae_switch/{model}").into(),
                &path,
            )?;
            native_merge::set(
                &mut configuration,
                "small_model",
                format!("ae_switch/{model}").into(),
                &path,
            )?;
            let default_agent = configuration
                .get("default_agent")
                .map(|value| {
                    value
                        .as_str()
                        .filter(|name| !name.is_empty())
                        .map(str::to_owned)
                        .ok_or_else(|| native_merge::invalid(&path))
                })
                .transpose()?;
            if let Some(agents) = configuration.get_mut("agent") {
                let agents = native_merge::object(agents, &path)?;
                for (name, agent) in agents {
                    if [
                        "build",
                        "plan",
                        "general",
                        "explore",
                        "compaction",
                        "title",
                        "summary",
                    ]
                    .contains(&name.as_str())
                        || default_agent.as_deref() == Some(name.as_str())
                    {
                        native_merge::object(agent, &path)?;
                        if agent.get("model").is_some() {
                            native_merge::set(
                                agent,
                                "model",
                                format!("ae_switch/{model}").into(),
                                &path,
                            )?;
                        }
                    }
                }
            }
            let provider = native_merge::child(
                native_merge::child(&mut configuration, "provider", &path)?,
                "ae_switch",
                &path,
            )?;
            native_merge::set(provider, "npm", "@ai-sdk/openai-compatible".into(), &path)?;
            native_merge::default(provider, "name", "AE Switch Portable Gateway".into(), &path)?;
            let options = native_merge::child(provider, "options", &path)?;
            native_merge::update_authorization_headers(options, token, &path)?;
            native_merge::set(options, "baseURL", base_url.into(), &path)?;
            native_merge::set(
                options,
                "apiKey",
                if profile.is_some() {
                    token
                } else {
                    "{env:AE_SWITCH_API_KEY}"
                }
                .into(),
                &path,
            )?;
            let models = native_merge::child(provider, "models", &path)?;
            let model_map = native_merge::object(models, &path)?;
            for value in model_map.values_mut() {
                native_merge::object(value, &path)?;
                if value.get("limit").is_some() {
                    native_merge::child(value, "limit", &path)?;
                }
            }
            if !model_map.contains_key(model) {
                let next = previous
                    .as_deref()
                    .and_then(|previous| model_map.get(previous))
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({}));
                model_map.insert(model.into(), next);
            }
            let selected = model_map.get_mut(model).expect("selected model exists");
            native_merge::update_authorization_headers(selected, token, &path)?;
            if selected.get("id").is_some() {
                native_merge::set(selected, "id", model.into(), &path)?;
            }
            if let Some(transport) = selected.get_mut("provider") {
                native_merge::object(transport, &path)?;
                if transport.get("npm").is_some() {
                    native_merge::set(transport, "npm", "@ai-sdk/openai-compatible".into(), &path)?;
                }
            }
            native_merge::default(selected, "name", model.into(), &path)?;
            let limit = native_merge::child(selected, "limit", &path)?;
            native_merge::default(limit, "context", 128000.into(), &path)?;
            native_merge::default(limit, "output", 8192.into(), &path)?;
            writes.push((path.clone(), source.render(&configuration, &path)?));
        }
        AgentId::Hermes => {
            environment.insert(
                "HERMES_HOME".into(),
                directory
                    .join("home/.hermes")
                    .to_string_lossy()
                    .into_owned()
                    .into(),
            );
            let path = path_for("config", "home/.hermes/config.yaml");
            let existing = snapshot(&path, &mut snapshots)?;
            let source =
                native_merge::Yaml::parse(existing.as_deref(), &path, serde_json::json!({}))?;
            let mut settings = source.value();
            let selected = native_merge::child(&mut settings, "model", &path)?;
            for (key, value) in [
                ("default", model),
                ("provider", "custom"),
                ("base_url", base_url),
                ("key_env", "AE_SWITCH_API_KEY"),
                ("api_mode", "chat_completions"),
            ] {
                native_merge::set(selected, key, value.into(), &path)?;
            }
            // Hermes tries existing inline credentials before the configured key_env.
            if profile.is_some() {
                native_merge::set(selected, "api_key", token.into(), &path)?;
            }
            for key in ["api_key", "api"] {
                if selected.get(key).is_some() {
                    native_merge::set(selected, key, token.into(), &path)?;
                }
            }
            let auxiliary = native_merge::child(&mut settings, "auxiliary", &path)?;
            // These tasks run automatically in the official default workflow.
            for task in [
                "compression",
                "title_generation",
                "background_review",
                "review",
            ] {
                if task == "review" && auxiliary.get(task).is_none() {
                    continue;
                }
                let selected = native_merge::child(auxiliary, task, &path)?;
                for (key, value) in [
                    ("provider", "custom"),
                    ("model", model),
                    ("base_url", base_url),
                    ("key_env", "AE_SWITCH_API_KEY"),
                    ("api_mode", "chat_completions"),
                ] {
                    native_merge::set(selected, key, value.into(), &path)?;
                }
                // Task-local inline credentials and alternate env keys take precedence.
                if profile.is_some() || selected.get("api_key").is_some() {
                    native_merge::set(selected, "api_key", token.into(), &path)?;
                }
                if selected.get("api_key_env").is_some() {
                    native_merge::set(selected, "api_key_env", "AE_SWITCH_API_KEY".into(), &path)?;
                }
            }
            writes.push((path.clone(), source.render(&settings, &path)?));
        }
        AgentId::WorkBuddy => {
            let config_directory = directory.join("home/.workbuddy");
            for variable in ["WORKBUDDY_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR"] {
                environment.insert(
                    variable.into(),
                    config_directory.to_string_lossy().into_owned().into(),
                );
            }
            for (name, value) in [
                ("ELECTRON_RUN_AS_NODE", "1"),
                ("CODEBUDDY_FORCE_LITE_WB_BUNDLE", "1"),
                ("CODEBUDDY_FORCE_HEADLESS_BUNDLE", "1"),
                ("CODEBUDDY_HOST", "workbuddy-desktop"),
                ("CODEBUDDY_SKIP_GIT_BASH_CHECK", "1"),
                ("DISABLE_AUTOUPDATER", "1"),
                ("DISABLE_TELEMETRY", "1"),
            ] {
                environment.insert(name.into(), value.into());
            }
            environment.insert("AE_WORKBUDDY_MODEL".into(), model.into());
            let path = path_for("config", "home/.workbuddy/models.json");
            let existing = snapshot(&path, &mut snapshots)?;
            let mut document =
                native_merge::json(existing.as_deref(), &path, serde_json::json!([]))?;
            let models = if document.is_object() {
                native_merge::object(&mut document, &path)?
                    .get_mut("models")
                    .ok_or_else(|| native_merge::invalid(&path))?
            } else {
                &mut document
            };
            native_merge::rows(models, &path, "id")?;
            let selected = native_merge::row(
                models.as_array_mut().expect("validated model array"),
                "id",
                model,
            );
            // A vendor/custom protocol can override the compatible URL. Keep
            // user preferences and reject a conflict instead of deleting them.
            if selected
                .get("vendor")
                .is_some_and(|vendor| !vendor.as_str().is_some_and(str::is_empty))
                || selected
                    .get("useCustomProtocol")
                    .is_some_and(|flag| flag != false)
            {
                return Err(AppError::new("agent_transport_conflict", "WorkBuddy 所选模型的供应商或自定义协议与本地网关不兼容，原配置未覆盖。请在原工具中调整该模型后重试"));
            }
            native_merge::set(selected, "url", base_url.into(), &path)?;
            native_merge::set(selected, "apiKey", token.into(), &path)?;
            native_merge::default(selected, "name", model.into(), &path)?;
            for (key, flag) in [
                ("supportsToolCall", true),
                ("supportsImages", false),
                ("supportsReasoning", false),
                ("useCustomProtocol", false),
            ] {
                native_merge::default(selected, key, flag.into(), &path)?;
            }
            writes.push((path, native_merge::text(&document)?));
        }
        AgentId::Zcode => {
            environment.insert(
                "ZCODE_DATA_BASE_DIR".into(),
                directory.join("home").to_string_lossy().into_owned().into(),
            );
            environment.insert(
                "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE".into(),
                directory
                    .join("configuration/zcode-providers.json")
                    .to_string_lossy()
                    .into_owned()
                    .into(),
            );
            environment.insert(
                "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE".into(),
                directory
                    .join("configuration/zcode-builtin.json")
                    .to_string_lossy()
                    .into_owned()
                    .into(),
            );
            let providers_path = path_for("config", "configuration/zcode-providers.json");
            let builtin_path = path_for("builtin", "configuration/zcode-builtin.json");
            // The official release codec requires a complete fallback model.
            // Empty catalogs keep the user's local gateway as the only provider.
            let builtin = serde_json::json!({
                "schemaVersion": 1, "revision": 0,
                "config": {
                    "providerConfigRules": { "templateRules": [], "providerRules": [] },
                    "modelConfigRules": {
                        "modelRules": [{ "modelMatch": ".*", "config": {
                            "enabled": true,
                            "properties": { "requiresMfjsToolSchema": false, "contextWindow": 128000, "inputFormat": { "supportsText": true, "supportsImage": false, "supportsVideo": false, "supportsAudio": false, "supportsPdf": false }, "outputFormat": { "supportsText": true }, "supportsToolCall": true, "supportsJsonSchemaOutput": false, "supportsNativeWebSearch": false, "supportsMidConversationSystem": false },
                            "optionSpecs": { "reasoningLevel": { "values": ["disabled"], "map": "{}" }, "maxOutputTokens": { "max": 8192, "map": "{'max_tokens': maxOutputTokens}" } }
                        }}],
                        "modelApiRules": [], "providerSiteRules": [], "templateModelRules": [], "builtinProviderModelRules": []
                    }
                }
            });
            let providers_text = snapshot(&providers_path, &mut snapshots)?;
            let builtin_text =
                if profile.is_none() || profile.is_some_and(|p| p.builtin_config_file.is_some()) {
                    snapshot(&builtin_path, &mut snapshots)?
                } else {
                    None
                };
            let mut known_builtin = profile.is_none() && builtin_text.is_none();
            let mut providers = native_merge::json(
                providers_text.as_deref(),
                &providers_path,
                serde_json::json!({}),
            )?;
            if let Some(text) = &builtin_text {
                let mut saved_builtin =
                    native_merge::json(Some(text), &builtin_path, serde_json::json!({}))?;
                native_merge::object(&mut saved_builtin, &builtin_path)?;
                if saved_builtin
                    .get("schemaVersion")
                    .and_then(serde_json::Value::as_u64)
                    != Some(1)
                    || !saved_builtin
                        .get("config")
                        .is_some_and(serde_json::Value::is_object)
                {
                    return Err(native_merge::invalid(&builtin_path));
                }
                let config = native_merge::child(&mut saved_builtin, "config", &builtin_path)?;
                for key in ["providerConfigRules", "modelConfigRules"] {
                    if !config.get(key).is_some_and(serde_json::Value::is_object) {
                        return Err(native_merge::invalid(&builtin_path));
                    }
                }
                native_merge::child(config, "providerConfigRules", &builtin_path)?;
                native_merge::child(config, "modelConfigRules", &builtin_path)?;
                known_builtin = saved_builtin == builtin;
            }
            if providers
                .get("schemaVersion")
                .is_some_and(|version| version.as_u64() != Some(1))
            {
                return Err(native_merge::invalid(&providers_path));
            }
            native_merge::default(&mut providers, "schemaVersion", 1.into(), &providers_path)?;
            let config = native_merge::child(&mut providers, "config", &providers_path)?;
            let rules = native_merge::child(config, "providerConfigRules", &providers_path)?;
            let provider_rules = native_merge::array(rules, "providerRules", &providers_path)?;
            let mut rules_value = serde_json::Value::Array(std::mem::take(provider_rules));
            native_merge::rows(&mut rules_value, &providers_path, "providerId")?;
            *provider_rules = std::mem::take(rules_value.as_array_mut().expect("validated rules"));
            let provider = native_merge::row(provider_rules, "providerId", "ae_switch");
            native_merge::default(
                provider,
                "providerName",
                "AE Switch Portable Gateway".into(),
                &providers_path,
            )?;
            native_merge::default(provider, "enabled", true.into(), &providers_path)?;
            if provider["enabled"] == false {
                return Err(AppError::new(
                    "agent_configuration_conflict",
                    "Z Code 的本地网关供应商已被停用，原配置未覆盖。请在原工具中启用后重试",
                ));
            }
            let personal = native_merge::child(provider, "config", &providers_path)?;
            native_merge::default(
                personal,
                "group",
                "standard-personal".into(),
                &providers_path,
            )?;
            let access = native_merge::child(personal, "access", &providers_path)?;
            native_merge::set(access, "type", "api-key".into(), &providers_path)?;
            native_merge::set(access, "apiKey", token.into(), &providers_path)?;
            let api = native_merge::child(personal, "api", &providers_path)?;
            native_merge::set(
                api,
                "type",
                "openai-chat-completions".into(),
                &providers_path,
            )?;
            native_merge::set(api, "baseUrl", base_url.into(), &providers_path)?;
            let models = native_merge::array(personal, "personalModelIds", &providers_path)?;
            if !models.iter().all(serde_json::Value::is_string) {
                return Err(native_merge::invalid(&providers_path));
            }
            if !models.iter().any(|value| value == model) {
                models.push(model.into());
            }
            let model_rules = native_merge::child(config, "modelConfigRules", &providers_path)?;
            native_merge::array(model_rules, "providerModelRules", &providers_path)?;
            native_merge::array(model_rules, "manualProviderModelRules", &providers_path)?;
            // Only this generated fallback is proven to support disabled
            // reasoning exclusively. Do not interpret third-party rule engines.
            let disabled_only = known_builtin
                && native_merge::object(model_rules, &providers_path)?
                    .iter()
                    .all(|(key, value)| {
                        matches!(
                            key.as_str(),
                            "providerModelRules" | "manualProviderModelRules"
                        ) && value.as_array().is_some_and(Vec::is_empty)
                    });
            let selection = native_merge::child(config, "defaultModelSelection", &providers_path)?;
            native_merge::set(selection, "providerId", "ae_switch".into(), &providers_path)?;
            native_merge::set(selection, "modelId", model.into(), &providers_path)?;
            let options = native_merge::child(selection, "options", &providers_path)?;
            native_merge::default(
                options,
                "reasoningLevel",
                "disabled".into(),
                &providers_path,
            )?;
            if disabled_only && options["reasoningLevel"] != "disabled" {
                return Err(AppError::new("agent_configuration_conflict", "Z Code 的既有推理设置与便携模型配置不兼容，原配置未覆盖。请先在原工具中将该选择的 reasoningLevel 设为 disabled，或提供支持该推理档位的模型规则后重试"));
            }
            writes.push((providers_path, native_merge::text(&providers)?));
            if profile.is_none() && builtin_text.is_none() {
                writes.push((builtin_path, native_merge::text(&builtin)?));
            }
            // Built-in subagent overrides live beside the official session
            // database. Do not create state or rewrite it when no route changed.
            let state_path = path_for("state", "home/.zcode/v2/agents-state.json");
            let state_text = if profile.is_none()
                || paths
                    .as_ref()
                    .is_some_and(|paths| paths.contains_key("state"))
            {
                snapshot(&state_path, &mut snapshots)?
            } else {
                None
            };
            if let Some(text) = state_text {
                let mut state =
                    native_merge::json(Some(&text), &state_path, serde_json::json!({}))?;
                native_merge::object(&mut state, &state_path)?;
                let before = state.clone();
                if let Some(overrides) = state.get_mut("builtInModelSelectionOverrides") {
                    native_merge::object(overrides, &state_path)?;
                    for name in ["general-purpose", "Explore"] {
                        if let Some(selection) = overrides.get_mut(name) {
                            native_merge::set(
                                selection,
                                "providerId",
                                "ae_switch".into(),
                                &state_path,
                            )?;
                            native_merge::set(selection, "modelId", model.into(), &state_path)?;
                            if disabled_only
                                && selection
                                    .get("options")
                                    .and_then(|options| options.get("reasoningLevel"))
                                    .is_some_and(|reasoning| reasoning != "disabled")
                            {
                                return Err(AppError::new("agent_configuration_conflict", format!("Z Code 内置代理 {name} 的既有推理设置与便携模型配置不兼容，原配置未覆盖。请先在原工具中将该选择的 reasoningLevel 设为 disabled，或提供支持该推理档位的模型规则后重试")));
                            }
                        }
                    }
                }
                if before != state {
                    writes.push((state_path, native_merge::text(&state)?));
                }
            }
        }
    }
    Ok((snapshots, writes))
}

fn commit_native_configuration(
    root: &Path,
    snapshots: &[native_merge::Snapshot],
    writes: Vec<(PathBuf, String)>,
) -> Result<()> {
    native_merge::check_snapshots(root, snapshots)?;
    let journal = configuration_journal(root, snapshots, writes)?;
    let journal_path = root.join(CONFIGURATION_JOURNAL);
    let contents = serde_json::to_string(&journal)
        .map_err(|_| AppError::new("serialization", "无法保存 Agent 原配置备份"))?;
    if contents.len() > 32 * 1024 * 1024 {
        return Err(AppError::new(
            "response_limit",
            "Agent 配置备份超过 32 MB，原配置未修改",
        ));
    }
    let journal = resolve_configuration_journal(root, journal)?;
    write_checked(root, &journal_path, &contents)?;
    let result = (|| {
        for change in &journal.changes {
            if native_merge::read(root, &change.path)? != change.before {
                return Err(AppError::new(
                    "agent_configuration_changed",
                    "Agent 配置在写入前被修改，正在恢复此次操作",
                ));
            }
            write_checked(root, &change.path, &change.after)?;
            set_launcher_permissions(&change.path)?;
            if native_merge::read(root, &change.path)?.as_deref() != Some(change.after.as_str()) {
                return Err(AppError::new(
                    "verify_failed",
                    "Agent 配置回读校验失败，正在恢复此次操作",
                ));
            }
        }
        Ok(())
    })();
    if let Err(error) = result {
        if restore_configuration(root, &journal).is_err() {
            return Err(AppError::new("recovery_required", "Agent 配置无法完整恢复，原配置已保存在数据目录的 agent-configuration.pending.json；请关闭工具后重新打开应用"));
        }
        let _ = writer::write(&journal_path, None);
        return Err(error);
    }
    // A completed transaction remains recoverable if its cleanup is temporarily locked.
    let _ = writer::write(&journal_path, None);
    Ok(())
}

fn configuration_journal(
    root: &Path,
    snapshots: &[native_merge::Snapshot],
    writes: Vec<(PathBuf, String)>,
) -> Result<ConfigurationJournal> {
    let changes = writes
        .into_iter()
        .map(|(path, after)| {
            if after.len() > 4 * 1024 * 1024 {
                return Err(AppError::new(
                    "response_limit",
                    "Agent 配置超过 4 MB，原配置未修改",
                ));
            }
            let before = snapshots
                .iter()
                .find(|(before_path, _)| before_path == &path)
                .ok_or_else(|| AppError::new("invalid_state", "Agent 配置缺少原文件快照"))?
                .1
                .clone();
            let relative = path.strip_prefix(root).map_err(|_| {
                AppError::new(
                    "unsafe_path",
                    "Agent configuration is outside the portable root",
                )
            })?;
            let relative = relative_configuration_path(root, relative)?;
            Ok(ConfigurationChange {
                path: relative.to_owned(),
                before,
                after,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(ConfigurationJournal { changes })
}

const CONFIGURATION_JOURNAL: &str = "agent-configuration.pending.json";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfigurationChange {
    path: PathBuf,
    before: Option<String>,
    after: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfigurationJournal {
    changes: Vec<ConfigurationChange>,
}

fn relative_configuration_path<'a>(root: &Path, path: &'a Path) -> Result<&'a Path> {
    // Legacy journals are accepted only under the current root. Never infer an old root.
    let relative = if path.is_absolute() {
        path.strip_prefix(root).map_err(|_| {
            AppError::new(
                "unsafe_path",
                "Agent configuration is outside the portable root",
            )
        })?
    } else {
        path
    };
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(AppError::new(
            "unsafe_path",
            "Agent configuration backup contains an unsafe path",
        ));
    }
    Ok(relative)
}

fn resolve_configuration_journal(
    root: &Path,
    mut journal: ConfigurationJournal,
) -> Result<ConfigurationJournal> {
    if journal.changes.is_empty() || journal.changes.len() > 16 {
        return Err(AppError::new(
            "invalid_state",
            "Agent configuration backup structure is invalid",
        ));
    }
    let mut paths = std::collections::HashSet::new();
    for change in &mut journal.changes {
        let relative = relative_configuration_path(root, &change.path)?;
        let path = root.join(relative);
        if !paths.insert(path.clone())
            || change.after.len() > 4 * 1024 * 1024
            || change
                .before
                .as_ref()
                .is_some_and(|before| before.len() > 4 * 1024 * 1024)
        {
            return Err(AppError::new(
                "invalid_state",
                "Agent configuration backup structure is invalid",
            ));
        }
        check_existing_ancestors(&path)?;
        change.path = path;
    }
    Ok(journal)
}

fn restore_configuration(root: &Path, journal: &ConfigurationJournal) -> Result<()> {
    // Preflight every file before rollback so a client edit never gets overwritten.
    for change in &journal.changes {
        let current = native_merge::read(root, &change.path)?;
        if current != change.before && current.as_deref() != Some(change.after.as_str()) {
            return Err(AppError::new(
                "agent_configuration_changed",
                "恢复 Agent 配置时发现外部修改，原配置备份已保留",
            ));
        }
    }
    for change in journal.changes.iter().rev() {
        let current = native_merge::read(root, &change.path)?;
        if current == change.before {
            continue;
        }
        if current.as_deref() != Some(change.after.as_str()) {
            return Err(AppError::new(
                "agent_configuration_changed",
                "恢复前发现外部修改，原配置备份已保留",
            ));
        }
        check_existing_ancestors(&change.path)?;
        writer::write(&change.path, change.before.as_deref())?;
        if change.before.is_some() {
            set_launcher_permissions(&change.path)?;
        }
        if native_merge::read(root, &change.path)? != change.before {
            return Err(AppError::new(
                "verify_failed",
                "Agent 原配置恢复后的核对失败，备份已保留",
            ));
        }
    }
    Ok(())
}

pub(crate) fn recover_configuration(root: &Path) -> Result<()> {
    validate_root(root)?;
    existing::recover(root)?;
    let path = root.join(CONFIGURATION_JOURNAL);
    let Some(contents) = native_merge::read_limit(root, &path, 32 * 1024 * 1024)? else {
        return Ok(());
    };
    let journal: ConfigurationJournal = serde_json::from_str(&contents).map_err(|_| {
        AppError::new(
            "invalid_state",
            "Agent 原配置备份损坏，请保留数据目录后修复",
        )
    })?;
    let journal = resolve_configuration_journal(root, journal)?;
    let mut complete = true;
    for change in &journal.changes {
        complete &=
            native_merge::read(root, &change.path)?.as_deref() == Some(change.after.as_str());
    }
    if complete {
        for change in &journal.changes {
            set_launcher_permissions(&change.path)?;
        }
    } else {
        restore_configuration(root, &journal)?;
    }
    writer::write(&path, None)
}

fn set_launcher_permissions(path: &Path) -> Result<()> {
    #[cfg(unix)]
    if path.file_name().is_some_and(|name| name == "launch.sh") {
        use std::os::unix::fs::PermissionsExt;
        check_existing_ancestors(path)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| AppError::io(path, error))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
fn yaml_string(value: &str) -> Result<String> {
    serde_json::to_string(value).map_err(|_| {
        AppError::new(
            "serialization",
            "Could not encode an agent configuration value",
        )
    })
}

#[cfg(any(windows, test))]
fn powershell_launcher(agent: AgentId) -> String {
    let invocation = if agent == AgentId::WorkBuddy {
        r#"    if (-not (Test-AgentExecutableSource $env:AE_WORKBUDDY_RUNTIME) -or -not (Test-AgentExecutableSource $env:AE_WORKBUDDY_ENTRY)) {
        [Console]::Error.WriteLine('The official WorkBuddy desktop runtime is missing from the portable workspace.')
        exit 127
    }
    $runtimeArguments = @($env:AE_WORKBUDDY_ENTRY, '--model', $env:AE_WORKBUDDY_MODEL)
    if ($agentArguments.Count -eq 0) { $agentArguments = @('--serve') }
    $runtimeArguments += $agentArguments
    $previousConsoleOutputEncoding = [Console]::OutputEncoding
    $previousOutputEncoding = $OutputEncoding
    try {
        [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
        $OutputEncoding = [Text.UTF8Encoding]::new($false)
        & $env:AE_WORKBUDDY_RUNTIME @runtimeArguments | Out-Host
    } finally {
        [Console]::OutputEncoding = $previousConsoleOutputEncoding
        $OutputEncoding = $previousOutputEncoding
    }
"#
        .to_owned()
    } else if agent == AgentId::DeepSeekHarness {
        r#"    if (-not (Test-AgentExecutableSource $env:AE_DSH_RUNTIME) -or -not (Test-AgentExecutableSource $env:AE_DSH_ENTRY) -or -not (Test-AgentExecutableSource $env:AE_DSH_PWSH)) {
        [Console]::Error.WriteLine('The official DeepSeek Harness runtime or bundled PowerShell is missing from the portable workspace.')
        exit 127
    }
    function Initialize-DeepSeekOwnedDirectory([string]$Source) {
        $sourcePath = [IO.Path]::GetFullPath($Source)
        $agentPath = [IO.Path]::GetFullPath($agentDirectory)
        if ($sourcePath -match '^[Cc]:[\\/]' -or -not (Test-Path -LiteralPath $sourcePath -PathType Container) -or -not $sourcePath.StartsWith($agentPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'DeepSeek Harness requires an ordinary private agent directory.'
        }
        $ancestor = $sourcePath
        while ($ancestor) {
            $item = Get-Item -LiteralPath $ancestor -Force -ErrorAction Stop
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'DeepSeek Harness private directories cannot contain reparse points.'
            }
            $ancestor = [IO.Path]::GetDirectoryName($ancestor)
        }
        $directoryInfo = [IO.DirectoryInfo]::new($sourcePath)
        $acl = if ($PSVersionTable.PSEdition -eq 'Core') { [IO.FileSystemAclExtensions]::GetAccessControl($directoryInfo) } else { $directoryInfo.GetAccessControl() }
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        try { $currentUser = $identity.User } finally { $identity.Dispose() }
        if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $currentUser.Value) {
            throw 'DeepSeek Harness private directories must be owned by the current user.'
        }
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($currentUser, [Security.AccessControl.FileSystemRights]::FullControl, ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit), [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
        $acl.AddAccessRule($rule)
        if ($PSVersionTable.PSEdition -eq 'Core') { [IO.FileSystemAclExtensions]::SetAccessControl($directoryInfo, $acl) } else { $directoryInfo.SetAccessControl($acl) }
    }
    $privateWorkspace = Join-Path $agentDirectory 'workspace'
    $privateTemp = Join-Path $agentDirectory 'tmp'
    if (-not [IO.Path]::GetFullPath($env:TEMP).Equals([IO.Path]::GetFullPath($privateTemp), [StringComparison]::OrdinalIgnoreCase) -or -not [IO.Path]::GetFullPath($env:TMP).Equals([IO.Path]::GetFullPath($privateTemp), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'DeepSeek Harness requires its private temporary directory.'
    }
    Initialize-DeepSeekOwnedDirectory $privateWorkspace
    Initialize-DeepSeekOwnedDirectory $privateTemp
    if ($agentArguments.Count -eq 0) {
        $task = Read-Host 'DeepSeek Harness task'
        if ([string]::IsNullOrWhiteSpace($task)) { exit 0 }
        $agentArguments = @('--', '--', $task)
    }
    $runtimeArguments = @($env:AE_DSH_ENTRY, '--profile', 'headless') + $agentArguments
    function ConvertTo-DeepSeekNativeArgument([string]$Value) {
        if ($Value.IndexOf([char]0) -ge 0) { throw 'DeepSeek Harness arguments cannot contain null characters.' }
        $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
        $escaped = [regex]::Replace($escaped, '(\\+)\z', '$1$1')
        return '"' + $escaped + '"'
    }
    $nativeArguments = @($runtimeArguments | ForEach-Object { ConvertTo-DeepSeekNativeArgument ([string]$_) }) -join ' '
    $previousConsoleOutputEncoding = [Console]::OutputEncoding
    $previousOutputEncoding = $OutputEncoding
    $nativeProcess = $null
    try {
        [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
        $OutputEncoding = [Text.UTF8Encoding]::new($false)
        # Host module loading can restore PSModulePath after the initial cleanup.
        if (Test-Path -LiteralPath 'Env:PSModulePath') {
            Remove-Item -LiteralPath 'Env:PSModulePath' -ErrorAction Stop
        }
        # Bypass Windows PowerShell's native binder so quotes remain literal.
        $startInfo = [Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = $env:AE_DSH_RUNTIME
        $startInfo.Arguments = $nativeArguments
        $startInfo.WorkingDirectory = $privateWorkspace
        $startInfo.UseShellExecute = $false
        $nativeProcess = [Diagnostics.Process]::Start($startInfo)
        $nativeProcess.WaitForExit()
        $global:LASTEXITCODE = $nativeProcess.ExitCode
    } finally {
        if ($null -ne $nativeProcess) { $nativeProcess.Dispose() }
        [Console]::OutputEncoding = $previousConsoleOutputEncoding
        $OutputEncoding = $previousOutputEncoding
    }
"#
        .to_owned()
    } else {
        format!(
            r#"    $agentCommand = Get-Command '{command}' -CommandType Application,ExternalScript -All -ErrorAction SilentlyContinue | Where-Object {{ Test-AgentExecutableSource $_.Source }} | Select-Object -First 1
    if ($null -eq $agentCommand) {{
        [Console]::Error.WriteLine('{name} command is not available. Install its official CLI inside the portable workspace and add its bin directory to PATH.')
        exit 127
    }}
    & $agentCommand.Source @agentArguments
"#,
            command = agent.command(),
            name = definitions()
                .into_iter()
                .find(|item| item.id == agent)
                .expect("agent definition")
                .name
        )
    };
    let additional_environment_cleanup = if agent == AgentId::DeepSeekHarness {
        r#"    foreach ($variable in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
        if ([string]$variable -match 'KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION' -or [string]$variable -in @('DSH_HOME','DSH_TELEMETRY_MODE','AE_DSH_RUNTIME','AE_DSH_ENTRY','AE_DSH_PWSH','NODE_OPTIONS','NODE_PATH','PYTHONPATH','PYTHONHOME','VIRTUAL_ENV','PSModulePath','PSModuleAnalysisCachePath','POWERSHELL_TELEMETRY_OPTOUT')) {
            Remove-Item -LiteralPath ('Env:' + [string]$variable) -ErrorAction Stop
        }
    }
"#
    } else {
        ""
    };
    format!(
        r#"$ErrorActionPreference = 'Stop'
$agentArguments = @($args)
$agentDirectory = $PSScriptRoot
$environmentPath = Join-Path $agentDirectory 'configuration/environment.json'
try {{
{additional_environment_cleanup}    $portableEnvironment = Get-Content -LiteralPath $environmentPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $previousAgentRoot = [string]$portableEnvironment.AE_AGENT_ROOT
    $previousPortableRoot = [string]$portableEnvironment.AE_SWITCH_PORTABLE_ROOT
    $currentPortableRoot = $null
    if ($portableEnvironment.AE_AGENT_PORTABLE_RELATIVE_ROOT) {{
        $currentPortableRoot = [IO.Path]::GetFullPath((Join-Path $agentDirectory ([string]$portableEnvironment.AE_AGENT_PORTABLE_RELATIVE_ROOT)))
    }}
    foreach ($variable in @('OPENAI_API_KEY','OPENAI_BASE_URL','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','ANTHROPIC_MODEL','CLAUDE_CODE_SUBAGENT_MODEL','ANTHROPIC_SMALL_FAST_MODEL','ANTHROPIC_CUSTOM_HEADERS','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY','CLAUDE_CODE_USE_ANTHROPIC_AWS','CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD','CLAUDE_CODE_USE_MANTLE','CLAUDE_CODE_USE_GATEWAY','ANTHROPIC_UNIX_SOCKET','CLAUDE_CONFIG_DIR','CODEX_HOME','HERMES_HOME','PI_CODING_AGENT_DIR','OPENCODE_CONFIG','OPENCODE_CONFIG_DIR','OPENCODE_CONFIG_CONTENT','ZCODE_DATA_BASE_DIR','ZCODE_STORAGE_DIR','ZCODE_SESSION_DB_PATH','ZCODE_SESSION_DB','ZCODE_BUILTIN_PROVIDER_CONFIG_FILE','ZCODE_PERSONAL_PROVIDER_CONFIG_FILE','WORKBUDDY_CONFIG_DIR','CODEBUDDY_CONFIG_DIR','CODEBUDDY_HOST','CODEBUDDY_CODE_SUBAGENT_MODEL','CODEBUDDY_FORCE_LITE_WB_BUNDLE','CODEBUDDY_FORCE_HEADLESS_BUNDLE','ELECTRON_RUN_AS_NODE','AE_WORKBUDDY_RUNTIME','AE_WORKBUDDY_ENTRY','AE_WORKBUDDY_MODEL','AE_AGENT_BIN_PATH')) {{
        if (Test-Path -LiteralPath ('Env:' + $variable)) {{
            Remove-Item -LiteralPath ('Env:' + $variable) -ErrorAction Stop
        }}
    }}
    foreach ($property in $portableEnvironment.PSObject.Properties) {{
        $value = [string]$property.Value
        $segments = if ($property.Name -in @('PATH', 'AE_AGENT_BIN_PATH')) {{ $value.Split([IO.Path]::PathSeparator) }} else {{ @($value) }}
        $rebasedSegments = @(foreach ($segment in $segments) {{
            if ($previousAgentRoot -and ($segment -eq $previousAgentRoot -or $segment.StartsWith($previousAgentRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase))) {{
                $agentDirectory + $segment.Substring($previousAgentRoot.Length)
            }} elseif ($previousPortableRoot -and $currentPortableRoot -and ($segment -eq $previousPortableRoot -or $segment.StartsWith($previousPortableRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase))) {{
                $currentPortableRoot + $segment.Substring($previousPortableRoot.Length)
            }} else {{ $segment }}
        }})
        [Environment]::SetEnvironmentVariable($property.Name, ($rebasedSegments -join [IO.Path]::PathSeparator), 'Process')
    }}
    if ($env:NO_PROXY) {{ [Environment]::SetEnvironmentVariable('no_proxy', $env:NO_PROXY, 'Process') }}
    if ($env:AE_AGENT_BIN_PATH) {{ $env:PATH = $env:AE_AGENT_BIN_PATH + [IO.Path]::PathSeparator + $env:PATH }}
    Set-Location -LiteralPath (Join-Path $agentDirectory 'workspace')
    $env:PWD = (Get-Location).ProviderPath
    function Test-AgentExecutableSource([string]$Source) {{
        if (-not $Source) {{ return $false }}
        try {{
            $sourcePath = [IO.Path]::GetFullPath($Source)
            if ($sourcePath -match '^[Cc]:[\\/]' -or -not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {{ return $false }}
            $insideAllowedRoot = $false
            foreach ($allowedRoot in @($env:AE_AGENT_ALLOWED_ROOT, $env:AE_SWITCH_PORTABLE_ROOT)) {{
                if (-not $allowedRoot) {{ continue }}
                $allowedPath = [IO.Path]::GetFullPath($allowedRoot).TrimEnd([char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar))
                if ($sourcePath.StartsWith($allowedPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {{ $insideAllowedRoot = $true }}
            }}
            if (-not $insideAllowedRoot) {{ return $false }}
            $ancestor = $sourcePath
            while ($ancestor) {{
                $item = Get-Item -LiteralPath $ancestor -Force -ErrorAction Stop
                if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {{ return $false }}
                $ancestor = [IO.Path]::GetDirectoryName($ancestor)
            }}
            return $true
        }} catch {{ return $false }}
    }}
{invocation}
    if ($null -ne $LASTEXITCODE) {{ exit $LASTEXITCODE }}
    exit 0
}} catch {{
    [Console]::Error.WriteLine('Portable {name} could not start. Verify the local agent files and CLI installation.')
    exit 1
}}
"#,
        invocation = invocation,
        name = definitions()
            .into_iter()
            .find(|item| item.id == agent)
            .expect("agent definition")
            .name
    )
}

#[cfg(windows)]
const CMD_LAUNCHER: &str = "@echo off\r\nsetlocal\r\nwhere pwsh.exe >nul 2>nul\r\nif %errorlevel% equ 0 (\r\n  pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File \"%~dp0launch.ps1\" %*\r\n) else (\r\n  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File \"%~dp0launch.ps1\" %*\r\n)\r\nexit /b %errorlevel%\r\n";

#[cfg(test)]
enum ConfigKind {
    Json,
    Toml,
    Yaml,
}

#[cfg(test)]
#[path = "agent_configs/tests.rs"]
mod tests;
