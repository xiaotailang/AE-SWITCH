//! Bounded discovery of user-installed clients. Never launches an executable,
//! reads a native configuration body, or creates a client profile directory.
#![forbid(unsafe_code)]

use crate::{
    agent_configs::{AgentId, ExistingProfile},
    error::{AppError, Result},
};
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashSet},
    ffi::OsString,
    path::{Component, Path, PathBuf},
    sync::OnceLock,
    time::{SystemTime, UNIX_EPOCH},
};

pub(crate) const ORIGINAL_ENVIRONMENT_VARIABLES: &[&str] = &[
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PATH",
    "PATHEXT",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "TEMP",
    "TMP",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "HERMES_HOME",
    "HERMES_DATA_DIR_SUFFIX",
    "PI_CODING_AGENT_DIR",
    "PI_CONFIG_DIR",
    "OMP_PROFILE",
    "PI_PROFILE",
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_DIR",
    "ZCODE_DATA_BASE_DIR",
    "ZCODE_STORAGE_DIR",
    "ZCODE_SESSION_DB_PATH",
    "ZCODE_SESSION_DB",
    "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
    "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
    "ZCODE_BETA",
    "ZCODE_ENV",
    "WORKBUDDY_CONFIG_DIR",
    "CODEBUDDY_CONFIG_DIR",
    "DSH_HOME",
    "npm_config_prefix",
    "npm_config_cache",
    "PNPM_HOME",
    "PIP_CACHE_DIR",
    "UV_CACHE_DIR",
    "PYTHONPYCACHEPREFIX",
    "GIT_CONFIG_GLOBAL",
    "CLAUDE_CODE_GIT_BASH_PATH",
];

const AGENTS: &[AgentId] = &[
    AgentId::ClaudeCode,
    AgentId::Codex,
    AgentId::Hermes,
    AgentId::OhMyPi,
    AgentId::OpenCode,
    AgentId::Zcode,
    AgentId::WorkBuddy,
    AgentId::DeepSeekHarness,
];
const MAX_PATH_DIRECTORIES: usize = 96;
const MAX_NAMED_PROFILES: usize = 64;
const MAX_CLIENTS: usize = 128;

#[derive(Clone)]
struct Context {
    environment: BTreeMap<String, OsString>,
    home: Option<PathBuf>,
    workspace: Option<PathBuf>,
    windows: bool,
    installation_hints: Vec<(AgentId, PathBuf, &'static str)>,
    installations_limited: bool,
}

static ORIGINAL_CONTEXT: OnceLock<Context> = OnceLock::new();
static ORIGINAL_ENVIRONMENT_NAMES: OnceLock<HashSet<OsString>> = OnceLock::new();

impl Context {
    fn capture() -> Self {
        let environment: BTreeMap<String, OsString> = ORIGINAL_ENVIRONMENT_VARIABLES
            .iter()
            .filter_map(|name| std::env::var_os(name).map(|value| ((*name).into(), value)))
            .collect();
        let home_variable = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        let home = environment
            .get(home_variable)
            .map(PathBuf::from)
            .filter(|path| valid_absolute(path))
            .or_else(dirs::home_dir);
        Self {
            environment,
            home,
            workspace: std::env::current_dir().ok(),
            windows: cfg!(windows),
            installation_hints: Vec::new(),
            installations_limited: false,
        }
    }

    fn path(&self, variable: &str) -> Option<PathBuf> {
        self.environment
            .get(variable)
            .map(PathBuf::from)
            .filter(|path| valid_absolute(path))
    }

    fn name(&self, variable: &str) -> Option<String> {
        self.environment
            .get(variable)
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty() && !value.chars().any(char::is_control))
            .map(str::to_owned)
    }
}

/// Called before portable bootstrap rewrites HOME, XDG, profile variables or PATH.
pub fn capture_original_environment() {
    ORIGINAL_ENVIRONMENT_NAMES.get_or_init(|| std::env::vars_os().map(|(name, _)| name).collect());
    ORIGINAL_CONTEXT.get_or_init(Context::capture);
}

/// Presence only: never capture authentication, header, or inline-config values.
pub(crate) fn original_environment_has(name: &str) -> bool {
    let names = ORIGINAL_ENVIRONMENT_NAMES
        .get_or_init(|| std::env::vars_os().map(|(name, _)| name).collect());
    if cfg!(windows) {
        names
            .iter()
            .any(|present| present.to_string_lossy().eq_ignore_ascii_case(name))
    } else {
        names.contains(std::ffi::OsStr::new(name))
    }
}

/// Paths only: credentials and arbitrary inherited environment are never captured.
pub(crate) fn original_environment() -> &'static BTreeMap<String, OsString> {
    &ORIGINAL_CONTEXT.get_or_init(Context::capture).environment
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledAgentClient {
    pub agent_id: AgentId,
    pub executable_path: String,
    pub profiles: Vec<ExistingProfile>,
    pub source: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledAgentDiscovery {
    pub clients: Vec<InstalledAgentClient>,
    /// Milliseconds since Unix epoch, represented as text without a clock dependency.
    pub scanned_at: String,
    pub limited: bool,
    pub notes: Vec<String>,
}

fn valid_absolute(path: &Path) -> bool {
    path.is_absolute()
        && !path
            .as_os_str()
            .to_string_lossy()
            .chars()
            .any(char::is_control)
        && !path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
        && !path.as_os_str().to_string_lossy().starts_with("\\\\")
}

fn profile_path(path: &Path) -> bool {
    if !valid_absolute(path) {
        return false;
    }
    let mut ancestor = PathBuf::new();
    for part in path.components() {
        ancestor.push(part);
        match std::fs::symlink_metadata(&ancestor) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return false;
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if metadata.file_attributes() & 0x400 != 0 {
                        return false;
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return false,
        }
    }
    !path.exists() || path.is_dir()
}

fn command_names(agent: AgentId, windows: bool) -> Vec<String> {
    let names: &[&str] = if agent == AgentId::WorkBuddy {
        &["WorkBuddy", "workbuddy"]
    } else {
        &[agent.command()]
    };
    names
        .iter()
        .flat_map(|name| {
            if windows {
                vec![
                    format!("{name}.exe"),
                    format!("{name}.cmd"),
                    format!("{name}.bat"),
                    format!("{name}.ps1"),
                ]
            } else {
                vec![(*name).into()]
            }
        })
        .collect()
}

fn path_directories(context: &Context, limited: &mut bool) -> Vec<(PathBuf, &'static str)> {
    let inherited: Vec<PathBuf> = context
        .environment
        .get("PATH")
        .map(|value| std::env::split_paths(value).collect())
        .unwrap_or_default();
    if inherited.len() > MAX_PATH_DIRECTORIES || inherited.iter().any(|path| !valid_absolute(path))
    {
        *limited = true;
    }
    let mut directories: Vec<_> = inherited
        .into_iter()
        .take(MAX_PATH_DIRECTORIES)
        .filter(|path| valid_absolute(path))
        .map(|path| (path, "PATH"))
        .collect();
    if let Some(home) = &context.home {
        for relative in [".local/bin", ".cargo/bin", ".bun/bin", ".npm-global/bin"] {
            directories.push((home.join(relative), "known-user-installation"));
        }
    }
    if let Some(prefix) = context.path("npm_config_prefix") {
        directories.push((prefix.clone(), "npm-prefix"));
        directories.push((prefix.join("bin"), "npm-prefix"));
    }
    if let Some(pnpm) = context.path("PNPM_HOME") {
        directories.push((pnpm, "PNPM_HOME"));
    }
    if context.windows {
        if let Some(roaming) = context.path("APPDATA") {
            directories.push((roaming.join("npm"), "known-user-installation"));
        }
        if let Some(local) = context.path("LOCALAPPDATA") {
            for relative in [
                "Programs/WorkBuddy",
                "Programs/workbuddy",
                "WorkBuddy",
                "hermes/bin",
                "Programs/Claude",
                "Programs/opencode",
            ] {
                directories.push((local.join(relative), "known-windows-installation"));
            }
        }
        for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(root) = context.path(variable) {
                for relative in ["WorkBuddy", "Tencent/WorkBuddy", "Claude", "OpenCode"] {
                    directories.push((root.join(relative), "known-windows-installation"));
                }
            }
        }
    }
    let mut seen = HashSet::new();
    directories.retain(|(path, _)| seen.insert(path.clone()));
    directories
}

fn profile(context: &Context, executable: &Path, directory: PathBuf) -> Option<ExistingProfile> {
    let home = context.home.as_ref()?;
    let workspace = context
        .workspace
        .as_ref()
        .filter(|path| valid_absolute(path) && path.is_dir())?;
    if !profile_path(&directory) || !profile_path(home) || !home.is_dir() {
        return None;
    }
    Some(ExistingProfile {
        directory: directory.to_string_lossy().into_owned(),
        home_directory: home.to_string_lossy().into_owned(),
        executable_path: executable.to_string_lossy().into_owned(),
        workspace_directory: workspace.to_string_lossy().into_owned(),
        xdg_config_directory: context
            .path("XDG_CONFIG_HOME")
            .map(|path| path.to_string_lossy().into_owned()),
        xdg_data_directory: context
            .path("XDG_DATA_HOME")
            .map(|path| path.to_string_lossy().into_owned()),
        xdg_state_directory: context
            .path("XDG_STATE_HOME")
            .map(|path| path.to_string_lossy().into_owned()),
        xdg_cache_directory: context
            .path("XDG_CACHE_HOME")
            .map(|path| path.to_string_lossy().into_owned()),
        ..ExistingProfile::default()
    })
}

fn named_directories(root: &Path, limited: &mut bool) -> Vec<PathBuf> {
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(_) => {
            *limited = true;
            return Vec::new();
        }
    };
    let mut result = Vec::new();
    // List one documented profiles directory, never descend into histories.
    for (index, entry) in entries.enumerate() {
        if index >= MAX_NAMED_PROFILES {
            *limited = true;
            break;
        }
        if let Ok(entry) = entry {
            let path = entry.path();
            if path.is_dir() && profile_path(&path) {
                result.push(path);
            }
        }
    }
    result.sort();
    result
}

fn profiles(
    context: &Context,
    agent: AgentId,
    executable: &Path,
    limited: &mut bool,
) -> (Vec<ExistingProfile>, Option<String>) {
    let Some(home) = context.home.as_ref() else {
        return (
            Vec::new(),
            Some("无法确定原用户 HOME，请手动选择实际配置目录".into()),
        );
    };
    let path_variables: &[&str] = match agent {
        AgentId::ClaudeCode => &["CLAUDE_CONFIG_DIR"],
        AgentId::Codex => &["CODEX_HOME"],
        AgentId::Hermes => &["HERMES_HOME"],
        AgentId::OhMyPi => &["PI_CODING_AGENT_DIR"],
        AgentId::OpenCode => &["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR"],
        AgentId::Zcode => &[
            "ZCODE_DATA_BASE_DIR",
            "ZCODE_STORAGE_DIR",
            "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
            "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
        ],
        AgentId::WorkBuddy => &["WORKBUDDY_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR"],
        AgentId::DeepSeekHarness => &["DSH_HOME"],
    };
    for &variable in path_variables {
        if context.environment.contains_key(variable) && context.path(variable).is_none() {
            return (
                Vec::new(),
                Some(format!(
                    "原环境中的 {variable} 路径无法安全确认，请手动选择实际配置目录"
                )),
            );
        }
    }
    let mut candidates = Vec::new();
    let mut reason = None;
    let mut push = |directory: PathBuf| {
        if let Some(candidate) = profile(context, executable, directory) {
            candidates.push(candidate);
        }
    };
    match agent {
        AgentId::ClaudeCode => push(
            context
                .path("CLAUDE_CONFIG_DIR")
                .unwrap_or_else(|| home.join(".claude")),
        ),
        AgentId::Codex => push(
            context
                .path("CODEX_HOME")
                .unwrap_or_else(|| home.join(".codex")),
        ),
        AgentId::Hermes => {
            let suffix = context.name("HERMES_DATA_DIR_SUFFIX").unwrap_or_default();
            if suffix.contains(['/', '\\']) {
                return (
                    Vec::new(),
                    Some("Hermes 数据目录后缀无法安全确认，请手动选择实际配置目录".into()),
                );
            }
            let root = context.path("HERMES_HOME").unwrap_or_else(|| {
                if context.windows {
                    context
                        .path("LOCALAPPDATA")
                        .unwrap_or_else(|| home.join("AppData/Local"))
                        .join(format!("hermes{suffix}"))
                } else {
                    home.join(format!(".hermes{suffix}"))
                }
            });
            push(root.clone());
            for directory in named_directories(&root.join("profiles"), limited) {
                push(directory);
            }
            if root.join("active_profile").is_file() {
                reason = Some(
                    "发现 Hermes 活动 profile 标记；为保护原会话，请选择客户端实际使用的配置目录"
                        .into(),
                );
            }
        }
        AgentId::OhMyPi => {
            let config_name = context
                .name("PI_CONFIG_DIR")
                .unwrap_or_else(|| ".omp".into());
            let config_name = Path::new(&config_name);
            if config_name.is_absolute()
                || config_name
                    .components()
                    .any(|part| matches!(part, Component::ParentDir | Component::Prefix(_)))
            {
                return (
                    Vec::new(),
                    Some("OMP 配置目录名无法安全确认，请手动选择实际配置目录".into()),
                );
            }
            let root = home.join(config_name);
            let named = context
                .name("OMP_PROFILE")
                .or_else(|| context.name("PI_PROFILE"));
            if named.as_ref().is_some_and(|name| {
                name.contains(['/', '\\']) || matches!(name.as_str(), "." | "..")
            }) {
                return (
                    Vec::new(),
                    Some(
                        "OMP 命名 profile 无效，未回退到其他配置目录；请手动选择实际 profile"
                            .into(),
                    ),
                );
            }
            if let Some(name) = named {
                push(root.join("profiles").join(&name).join("agent"));
                if let Some(candidate) = candidates.last_mut() {
                    candidate.profile_name = Some(name);
                }
            } else {
                push(
                    context
                        .path("PI_CODING_AGENT_DIR")
                        .unwrap_or_else(|| root.join("agent")),
                );
                for directory in named_directories(&root.join("profiles"), limited) {
                    if let Some(mut candidate) =
                        profile(context, executable, directory.join("agent"))
                    {
                        candidate.profile_name = directory
                            .file_name()
                            .map(|name| name.to_string_lossy().into_owned());
                        candidates.push(candidate);
                    }
                }
            }
        }
        AgentId::OpenCode => {
            let root = context.path("OPENCODE_CONFIG_DIR").unwrap_or_else(|| {
                context
                    .path("XDG_CONFIG_HOME")
                    .unwrap_or_else(|| home.join(".config"))
                    .join("opencode")
            });
            let explicit = context.path("OPENCODE_CONFIG");
            if let Some(file) = explicit {
                if let Some(parent) = file.parent() {
                    push(parent.to_path_buf());
                }
                if let Some(candidate) = candidates.last_mut() {
                    candidate.config_file = Some(file.to_string_lossy().into_owned());
                }
            } else {
                push(root.clone());
                if root.join("opencode.jsonc").is_file() && !root.join("opencode.json").is_file() {
                    if let Some(candidate) = candidates.last_mut() {
                        candidate.config_file =
                            Some(root.join("opencode.jsonc").to_string_lossy().into_owned());
                    }
                }
            }
            reason = Some(
                "OpenCode 还可能使用项目配置、命令行参数或内联配置；请核对当前客户端实际配置"
                    .into(),
            );
        }
        AgentId::Zcode => {
            let client_home = context.path("HOME").unwrap_or_else(|| home.clone());
            let base = context
                .path("ZCODE_DATA_BASE_DIR")
                .unwrap_or_else(|| client_home.clone());
            let storage = context
                .path("ZCODE_STORAGE_DIR")
                .unwrap_or_else(|| client_home.join(".zcode"));
            let personal = context
                .path("ZCODE_PERSONAL_PROVIDER_CONFIG_FILE")
                .unwrap_or_else(|| base.join(".zcode/v2/provider_config.json"));
            if let Some(directory) = personal.parent() {
                push(directory.to_path_buf());
            }
            if let Some(candidate) = candidates.last_mut() {
                candidate.home_directory = client_home.to_string_lossy().into_owned();
                candidate.config_file = Some(personal.to_string_lossy().into_owned());
                candidate.data_directory = Some(storage.to_string_lossy().into_owned());
                candidate.builtin_config_file = context
                    .path("ZCODE_BUILTIN_PROVIDER_CONFIG_FILE")
                    .map(|path| path.to_string_lossy().into_owned());
            }
            reason = Some("ZCode 会话状态还可能由原配置中的 storage.dir 指定；未读取该配置内容，请核对实际存储目录".into());
            if context
                .path("ZCODE_PERSONAL_PROVIDER_CONFIG_FILE")
                .is_some()
                != context.path("ZCODE_BUILTIN_PROVIDER_CONFIG_FILE").is_some()
            {
                reason = Some("ZCode 显式 provider 路径未成对，实际运行时还可能补齐另一份路径；请核对 provider 路径和原 storage.dir，未读取配置内容".into());
            }
        }
        AgentId::WorkBuddy => push(
            context
                .path("WORKBUDDY_CONFIG_DIR")
                .or_else(|| context.path("CODEBUDDY_CONFIG_DIR"))
                .unwrap_or_else(|| home.join(".workbuddy")),
        ),
        AgentId::DeepSeekHarness => {
            let root = context
                .path("DSH_HOME")
                .unwrap_or_else(|| home.join(".dsh"));
            for directory in named_directories(&root.join("profiles"), limited) {
                if let Some(mut candidate) = profile(context, executable, directory.clone()) {
                    candidate.profile_name = directory
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned());
                    candidate.data_directory = Some(root.to_string_lossy().into_owned());
                    candidates.push(candidate);
                }
            }
            if candidates.is_empty() {
                reason = Some("未发现 DeepSeek Harness 已有 profile；请先选择客户端实际使用的命名 profile，AE 不会默认新建 headless profile".into());
            }
        }
    }
    let mut seen = HashSet::new();
    candidates.retain(|candidate| {
        seen.insert((
            candidate.directory.clone(),
            candidate.config_file.clone(),
            candidate.profile_name.clone(),
        ))
    });
    if candidates.len() > 1 && reason.is_none() {
        reason =
            Some("发现多个配置目录；请选择客户端实际使用的目录，自动发现不会改写任何配置".into());
    }
    if candidates.is_empty() && reason.is_none() {
        reason = Some("原用户目录或配置路径无法安全确认，请手动选择实际配置目录".into());
    }
    (candidates, reason)
}

fn discover_context(context: &Context) -> InstalledAgentDiscovery {
    let mut result = InstalledAgentDiscovery {
        clients: Vec::new(), scanned_at: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().to_string(),
        limited: context.installations_limited, notes: vec!["仅只读检查原用户环境、PATH、已知安装位置和 Windows 安装记录；未运行客户端或读取密钥、配置内容、历史。未注册的自定义安装和运行中客户端的参数仍需核对。".into()],
    };
    let directories = path_directories(context, &mut result.limited);
    let mut seen = HashSet::new();
    for &agent in AGENTS {
        for (directory, source) in &directories {
            for name in command_names(agent, context.windows) {
                let executable = directory.join(name);
                if !executable.is_file() {
                    continue;
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if std::fs::metadata(&executable)
                        .is_ok_and(|metadata| metadata.permissions().mode() & 0o111 == 0)
                    {
                        continue;
                    }
                }
                let key = (
                    agent.as_str(),
                    executable
                        .canonicalize()
                        .unwrap_or_else(|_| executable.clone()),
                );
                if !seen.insert(key) {
                    continue;
                }
                if result.clients.len() >= MAX_CLIENTS {
                    result.limited = true;
                    return result;
                }
                let (profiles, reason) = profiles(context, agent, &executable, &mut result.limited);
                result.clients.push(InstalledAgentClient {
                    agent_id: agent,
                    executable_path: executable.to_string_lossy().into_owned(),
                    profiles,
                    source: (*source).into(),
                    reason,
                });
            }
        }
    }
    for (agent, executable, source) in context.installation_hints.iter().take(MAX_CLIENTS) {
        if !valid_absolute(executable)
            || !executable.is_file()
            || !executable.parent().is_some_and(profile_path)
            || std::fs::symlink_metadata(executable)
                .map_or(true, |metadata| metadata.file_type().is_symlink())
        {
            continue;
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if std::fs::symlink_metadata(executable)
                .map_or(true, |metadata| metadata.file_attributes() & 0x400 != 0)
            {
                continue;
            }
        }
        let key = (
            agent.as_str(),
            executable
                .canonicalize()
                .unwrap_or_else(|_| executable.clone()),
        );
        if !seen.insert(key) {
            continue;
        }
        if result.clients.len() >= MAX_CLIENTS {
            result.limited = true;
            break;
        }
        let (profiles, reason) = profiles(context, *agent, executable, &mut result.limited);
        result.clients.push(InstalledAgentClient {
            agent_id: *agent,
            executable_path: executable.to_string_lossy().into_owned(),
            profiles,
            source: (*source).into(),
            reason,
        });
    }
    if context.installation_hints.len() > MAX_CLIENTS {
        result.limited = true;
    }
    if result.limited {
        result
            .notes
            .push("已达到有界扫描上限；未发现的自定义安装可手动选择。".into());
    }
    result
}

#[cfg(feature = "qa-webview")]
fn fixture_context(path: &Path) -> Result<Context> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Fixture {
        environment: BTreeMap<String, String>,
        home_directory: String,
        workspace_directory: String,
    }
    let fixture = crate::portable::validate_root(path)
        .ok()
        .filter(|_| std::fs::metadata(path).is_ok_and(|metadata| metadata.len() <= 64 * 1024))
        .and_then(|_| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice::<Fixture>(&bytes).ok());
    if let Some(fixture) = fixture {
        let environment = fixture
            .environment
            .into_iter()
            .filter(|(name, _)| ORIGINAL_ENVIRONMENT_VARIABLES.contains(&name.as_str()))
            .map(|(name, value)| (name, value.into()))
            .collect();
        let context = Context {
            environment,
            home: Some(fixture.home_directory.into()),
            workspace: Some(fixture.workspace_directory.into()),
            windows: cfg!(windows),
            installation_hints: Vec::new(),
            installations_limited: false,
        };
        let safe_paths = context
            .home
            .as_ref()
            .is_some_and(|path| crate::portable::validate_root(path).is_ok())
            && context
                .workspace
                .as_ref()
                .is_some_and(|path| crate::portable::validate_root(path).is_ok())
            && context.environment.iter().all(|(name, value)| {
                if [
                    "PATHEXT",
                    "HERMES_DATA_DIR_SUFFIX",
                    "PI_CONFIG_DIR",
                    "OMP_PROFILE",
                    "PI_PROFILE",
                    "ZCODE_BETA",
                    "ZCODE_ENV",
                ]
                .contains(&name.as_str())
                {
                    return true;
                }
                if name == "PATH" {
                    return std::env::split_paths(value)
                        .all(|path| crate::portable::validate_root(&path).is_ok());
                }
                crate::portable::validate_root(Path::new(value)).is_ok()
            });
        if safe_paths {
            return Ok(context);
        }
    }
    Err(AppError::new(
        "invalid_discovery_context",
        "测试专用发现上下文无效；未扫描真实用户环境。",
    ))
}

fn context_for_discovery() -> Result<Context> {
    #[cfg(feature = "qa-webview")]
    if let Some(path) = std::env::var_os("UNI_SWITCH_QA_AGENT_DISCOVERY_CONTEXT") {
        return fixture_context(Path::new(&path));
    }
    Ok(ORIGINAL_CONTEXT.get_or_init(Context::capture).clone())
}

pub fn discover() -> InstalledAgentDiscovery {
    let context = match context_for_discovery() {
        Ok(context) => context,
        Err(error) => {
            return InstalledAgentDiscovery {
                clients: Vec::new(),
                scanned_at: String::new(),
                limited: true,
                notes: vec![error.message],
            };
        }
    };
    #[cfg(all(windows, not(test)))]
    let context = {
        // A QA context must never mix with the real user's registry. Capture
        // installation metadata only for the normal production discovery path.
        #[cfg(feature = "qa-webview")]
        let fixture_active = std::env::var_os("UNI_SWITCH_QA_AGENT_DISCOVERY_CONTEXT").is_some();
        #[cfg(not(feature = "qa-webview"))]
        let fixture_active = false;
        let mut context = context;
        if !fixture_active {
            (context.installation_hints, context.installations_limited) =
                crate::windows_installations::discover();
        }
        context
    };
    discover_context(&context)
}

fn discover_directory_context(
    context: &Context,
    agent: AgentId,
    directory: &Path,
) -> Result<InstalledAgentDiscovery> {
    if !valid_absolute(directory)
        || !profile_path(directory)
        || !directory.is_dir()
        || crate::portable::validate_root(directory).is_err()
    {
        return Err(AppError::new(
            "invalid_installation_directory",
            "请选择已存在的本地安装目录，不接受相对路径、父目录跳转或目录链接。",
        ));
    }
    let mut result = InstalledAgentDiscovery {
        clients: Vec::new(),
        scanned_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .to_string(),
        limited: false,
        notes: vec!["仅读取所选安装目录及固定启动子目录；HOME、配置和工作目录从原用户环境推导，不读取密钥或历史，也不运行客户端。".into()],
    };
    let mut names = HashSet::new();
    let command_names: Vec<_> = command_names(agent, context.windows)
        .into_iter()
        .filter(|name| {
            names.insert(if context.windows {
                name.to_ascii_lowercase()
            } else {
                name.clone()
            })
        })
        .collect();
    let mut seen = HashSet::new();
    // Five fixed locations, at most four command spellings each on Windows.
    // No directory enumeration, recursive search, PATH or registry fallback.
    for relative in ["", "bin", "node_modules/.bin", "npm", "Scripts"] {
        let launch_directory = directory.join(relative);
        if !profile_path(&launch_directory) || !launch_directory.is_dir() {
            continue;
        }
        for name in &command_names {
            let executable = launch_directory.join(name);
            let Ok(metadata) = std::fs::symlink_metadata(&executable) else {
                continue;
            };
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                continue;
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 {
                    continue;
                }
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if metadata.permissions().mode() & 0o111 == 0 {
                    continue;
                }
            }
            let identity = executable
                .canonicalize()
                .unwrap_or_else(|_| executable.clone());
            let identity = if context.windows {
                PathBuf::from(identity.to_string_lossy().to_lowercase())
            } else {
                identity
            };
            if !seen.insert(identity) {
                continue;
            }
            let (profiles, reason) = profiles(context, agent, &executable, &mut result.limited);
            result.clients.push(InstalledAgentClient {
                agent_id: agent,
                executable_path: executable.to_string_lossy().into_owned(),
                profiles,
                source: "selected-installation-directory".into(),
                reason,
            });
        }
    }
    if result.clients.is_empty() {
        result
            .notes
            .push("所选目录中未找到此工具的受支持启动入口，请选择该工具的安装目录。".into());
    }
    Ok(result)
}

/// User fallback selects only an installation directory; native HOME/profile
/// semantics stay identical to automatic discovery and are never moved there.
pub fn discover_in_directory(agent: AgentId, directory: &Path) -> Result<InstalledAgentDiscovery> {
    discover_directory_context(&context_for_discovery()?, agent, directory)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context(root: &Path) -> Context {
        let home = root.join("home");
        let bin = root.join("bin");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        let mut environment = BTreeMap::new();
        environment.insert("PATH".into(), std::env::join_paths([&bin]).unwrap());
        environment.insert(
            "LOCALAPPDATA".into(),
            home.join("AppData/Local").into_os_string(),
        );
        Context {
            environment,
            home: Some(home),
            workspace: Some(root.into()),
            windows: cfg!(windows),
            installation_hints: Vec::new(),
            installations_limited: false,
        }
    }

    fn executable(context: &Context, agent: AgentId) -> PathBuf {
        let directory = std::env::split_paths(&context.environment["PATH"])
            .next()
            .unwrap();
        let path = directory.join(&command_names(agent, context.windows)[0]);
        std::fs::write(&path, "Do not execute this discovery fixture").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        path
    }

    #[test]
    fn registered_custom_installation_is_found_without_changing_path_or_profile_home() {
        let sandbox = tempfile::Builder::new()
            .prefix("agent-discovery-installation-")
            .tempdir_in(std::env::temp_dir())
            .unwrap();
        let mut context = context(sandbox.path());
        let install = sandbox.path().join("custom tools 中文/zcode_install");
        std::fs::create_dir_all(&install).unwrap();
        let entry = install.join(if context.windows {
            "ZCode.exe"
        } else {
            "zcode"
        });
        std::fs::write(&entry, "Do not execute this installation discovery fixture").unwrap();
        let original_path = context.environment["PATH"].clone();
        context
            .installation_hints
            .push((AgentId::Zcode, entry.clone(), "windows-uninstall"));
        context
            .installation_hints
            .push((AgentId::Zcode, entry.clone(), "windows-app-paths"));
        let discovered = discover_context(&context);
        let clients: Vec<_> = discovered
            .clients
            .iter()
            .filter(|client| client.agent_id == AgentId::Zcode)
            .collect();
        assert_eq!(clients.len(), 1);
        assert_eq!(Path::new(&clients[0].executable_path), entry);
        assert_eq!(clients[0].source, "windows-uninstall");
        assert_eq!(clients[0].profiles.len(), 1);
        assert_eq!(
            Path::new(&clients[0].profiles[0].home_directory),
            context.home.as_ref().unwrap()
        );
        assert_eq!(
            Path::new(&clients[0].profiles[0].directory),
            context.home.as_ref().unwrap().join(".zcode/v2")
        );
        assert!(clients[0].profiles[0].builtin_config_file.is_none());
        assert_eq!(context.environment["PATH"], original_path);
        assert_eq!(std::fs::read_dir(&install).unwrap().count(), 1);
        assert!(std::fs::read_dir(context.home.as_ref().unwrap())
            .unwrap()
            .next()
            .is_none());
    }

    #[test]
    fn incomplete_installation_collection_keeps_discovery_limited() {
        let sandbox = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
        let mut context = context(sandbox.path());
        executable(&context, AgentId::Codex);
        context.installations_limited = true;
        let discovered = discover_context(&context);
        assert!(discovered.limited);
        assert_eq!(discovered.clients.len(), 1);
    }

    fn executable_in(context: &Context, directory: &Path, agent: AgentId) -> PathBuf {
        std::fs::create_dir_all(directory).unwrap();
        let mut entry_context = context.clone();
        entry_context
            .environment
            .insert("PATH".into(), std::env::join_paths([directory]).unwrap());
        executable(&entry_context, agent)
    }

    #[test]
    fn selected_installation_directory_derives_profile_without_using_it_as_home() {
        let sandbox = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
        let context = context(sandbox.path());
        let install = sandbox.path().join("custom tools 中文/zcode_install");
        let entry = executable_in(&context, &install, AgentId::Zcode);
        executable(&context, AgentId::Codex);
        let original_path = context.environment["PATH"].clone();
        let discovered = discover_directory_context(&context, AgentId::Zcode, &install).unwrap();
        assert_eq!(discovered.clients.len(), 1);
        assert!(!discovered.limited);
        let client = &discovered.clients[0];
        assert_eq!(client.agent_id, AgentId::Zcode);
        assert_eq!(Path::new(&client.executable_path), entry);
        assert_eq!(client.profiles.len(), 1);
        let profile = &client.profiles[0];
        assert_eq!(
            Path::new(&profile.home_directory),
            context.home.as_ref().unwrap()
        );
        assert_eq!(
            Path::new(&profile.workspace_directory),
            context.workspace.as_ref().unwrap()
        );
        assert_eq!(
            Path::new(&profile.directory),
            context.home.as_ref().unwrap().join(".zcode/v2")
        );
        assert_ne!(Path::new(&profile.home_directory), install);
        assert!(profile.builtin_config_file.is_none());
        assert_eq!(context.environment["PATH"], original_path);
        assert_eq!(std::fs::read_dir(&install).unwrap().count(), 1);
        assert!(std::fs::read_dir(context.home.as_ref().unwrap())
            .unwrap()
            .next()
            .is_none());
    }

    #[test]
    fn selected_directory_checks_only_supported_shallow_locations_and_agent() {
        let sandbox = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
        let context = context(sandbox.path());
        let install = sandbox.path().join("installed client");
        let entry = executable_in(&context, &install.join("bin"), AgentId::Codex);
        executable_in(&context, &install, AgentId::Zcode);
        executable_in(&context, &install.join("unrelated/deep"), AgentId::Codex);
        let discovered = discover_directory_context(&context, AgentId::Codex, &install).unwrap();
        assert_eq!(discovered.clients.len(), 1);
        assert_eq!(Path::new(&discovered.clients[0].executable_path), entry);
        assert_eq!(discovered.clients[0].agent_id, AgentId::Codex);
        assert!(context
            .home
            .as_ref()
            .unwrap()
            .read_dir()
            .unwrap()
            .next()
            .is_none());
    }

    #[test]
    fn wrong_selected_directory_returns_no_candidates_and_never_falls_back_to_path() {
        let sandbox = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
        let context = context(sandbox.path());
        executable(&context, AgentId::Zcode);
        let install = sandbox.path().join("empty install");
        std::fs::create_dir(&install).unwrap();
        executable_in(&context, &install, AgentId::Codex);
        let discovered = discover_directory_context(&context, AgentId::Zcode, &install).unwrap();
        assert!(discovered.clients.is_empty());
        assert!(discovered.notes.iter().any(|note| note.contains("未找到")));
        assert!(!discovered.limited);
        assert_eq!(std::fs::read_dir(&install).unwrap().count(), 1);
    }

    #[test]
    fn selected_directory_keeps_multiple_native_profiles_for_explicit_choice() {
        let sandbox = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
        let context = context(sandbox.path());
        let install = sandbox.path().join("installed hermes");
        executable_in(&context, &install, AgentId::Hermes);
        let home = context.home.as_ref().unwrap();
        let profiles_root = if context.windows {
            home.join("AppData/Local/hermes")
        } else {
            home.join(".hermes")
        };
        for name in ["first", "second"] {
            std::fs::create_dir_all(profiles_root.join("profiles").join(name)).unwrap();
        }
        let discovered = discover_directory_context(&context, AgentId::Hermes, &install).unwrap();
        assert_eq!(discovered.clients.len(), 1);
        assert_eq!(discovered.clients[0].profiles.len(), 3);
        assert!(discovered.clients[0]
            .reason
            .as_ref()
            .unwrap()
            .contains("多个"));
        assert_eq!(std::fs::read_dir(profiles_root).unwrap().count(), 1);
    }

    #[test]
    fn selected_directory_rejects_relative_parent_missing_and_file_roots() {
        let sandbox = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
        let context = context(sandbox.path());
        let file = sandbox.path().join("not-a-directory");
        std::fs::write(&file, b"keep").unwrap();
        for path in [
            PathBuf::from("relative"),
            sandbox.path().join("../escape"),
            sandbox.path().join("missing"),
            file.clone(),
        ] {
            assert_eq!(
                discover_directory_context(&context, AgentId::Zcode, &path)
                    .unwrap_err()
                    .code,
                "invalid_installation_directory"
            );
        }
        assert_eq!(std::fs::read(file).unwrap(), b"keep");
    }

    #[cfg(windows)]
    #[test]
    fn selected_directory_rejects_junction_roots_and_linked_known_subdirectories() {
        let sandbox = tempfile::tempdir_in(std::env::current_dir().unwrap()).unwrap();
        let context = context(sandbox.path());
        let actual = sandbox.path().join("actual install");
        executable_in(&context, &actual, AgentId::Zcode);
        let alias = sandbox.path().join("install junction");
        let make_link = |link: &Path| {
            assert!(link.starts_with(sandbox.path()) && actual.starts_with(sandbox.path()));
            assert!(!link.exists());
            assert!(std::process::Command::new("cmd.exe")
                .args(["/D", "/C", "mklink", "/J"])
                .arg(link)
                .arg(&actual)
                .output()
                .unwrap()
                .status
                .success());
        };
        make_link(&alias);
        let result = discover_directory_context(&context, AgentId::Zcode, &alias);
        std::fs::remove_dir(&alias).unwrap();
        assert!(result.is_err());
        let install = sandbox.path().join("ordinary install");
        std::fs::create_dir(&install).unwrap();
        let bin = install.join("bin");
        make_link(&bin);
        let result = discover_directory_context(&context, AgentId::Zcode, &install);
        std::fs::remove_dir(&bin).unwrap();
        assert!(result.unwrap().clients.is_empty());
        assert_eq!(std::fs::read_dir(actual).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn selected_directory_rejects_symlink_roots_and_executables() {
        let sandbox = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
        let context = context(sandbox.path());
        let actual = sandbox.path().join("actual install");
        let entry = executable_in(&context, &actual, AgentId::Zcode);
        let alias = sandbox.path().join("install link");
        std::os::unix::fs::symlink(&actual, &alias).unwrap();
        assert!(discover_directory_context(&context, AgentId::Zcode, &alias).is_err());
        let install = sandbox.path().join("ordinary install");
        std::fs::create_dir(&install).unwrap();
        std::os::unix::fs::symlink(entry, install.join("zcode")).unwrap();
        assert!(
            discover_directory_context(&context, AgentId::Zcode, &install)
                .unwrap()
                .clients
                .is_empty()
        );
    }

    #[cfg(feature = "qa-webview")]
    #[test]
    fn selected_directory_qa_context_stays_isolated_and_invalid_fixture_fails_closed() {
        let sandbox = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
        let context = context(sandbox.path());
        let install = sandbox.path().join("selected install");
        executable_in(&context, &install, AgentId::Zcode);
        let fixture = sandbox.path().join("discovery-context.json");
        let document = serde_json::json!({"homeDirectory":context.home,"workspaceDirectory":context.workspace,"environment":{"PATH":context.environment["PATH"].to_str().unwrap()}});
        std::fs::write(&fixture, serde_json::to_vec(&document).unwrap()).unwrap();
        let selected = discover_directory_context(
            &fixture_context(&fixture).unwrap(),
            AgentId::Zcode,
            &install,
        )
        .unwrap();
        assert_eq!(selected.clients.len(), 1);
        assert_eq!(
            Path::new(&selected.clients[0].profiles[0].home_directory),
            context.home.as_ref().unwrap()
        );
        std::fs::write(&fixture, b"{}").unwrap();
        assert_eq!(
            fixture_context(&fixture).err().unwrap().code,
            "invalid_discovery_context"
        );
        assert!(context
            .home
            .as_ref()
            .unwrap()
            .read_dir()
            .unwrap()
            .next()
            .is_none());
    }

    #[test]
    fn eight_clients_and_native_profiles_are_discovered_without_changes() {
        let sandbox = tempfile::Builder::new()
            .prefix("agent-discovery-")
            .tempdir_in(std::env::temp_dir())
            .unwrap();
        let context = context(sandbox.path());
        let home = context.home.as_ref().unwrap();
        let roots = [
            home.join(".claude"),
            home.join(".codex"),
            if context.windows {
                home.join("AppData/Local/hermes")
            } else {
                home.join(".hermes")
            },
            home.join(".omp/agent"),
            home.join(".config/opencode"),
            home.join(".zcode/v2"),
            home.join(".workbuddy"),
            home.join(".dsh/profiles/my-existing-profile"),
        ];
        for (&agent, directory) in AGENTS.iter().zip(&roots) {
            executable(&context, agent);
            std::fs::create_dir_all(directory).unwrap();
            std::fs::write(
                directory.join("history-sentinel"),
                "original-client-history",
            )
            .unwrap();
        }
        let result = discover_context(&context);
        assert_eq!(result.clients.len(), 8);
        assert!(!result.limited);
        for (client, directory) in result.clients.iter().zip(&roots) {
            assert_eq!(client.profiles.len(), 1);
            assert_eq!(Path::new(&client.profiles[0].directory), directory);
            assert_eq!(
                std::fs::read(directory.join("history-sentinel")).unwrap(),
                b"original-client-history"
            );
            assert_eq!(std::fs::read_dir(directory).unwrap().count(), 1);
        }
        let value = serde_json::to_value(result).unwrap();
        assert!(value["clients"][0]["agentId"].is_string());
        assert!(value["clients"][0]["profiles"][0]["executablePath"].is_string());
        assert!(value["scannedAt"].is_string());
        assert!(!value.to_string().contains("original-client-history"));
    }

    #[test]
    fn profiles_without_client_installations_do_not_become_installed_clients() {
        let sandbox = tempfile::Builder::new()
            .prefix("agent-discovery-")
            .tempdir_in(std::env::temp_dir())
            .unwrap();
        let context = context(sandbox.path());
        std::fs::create_dir_all(context.home.as_ref().unwrap().join(".codex")).unwrap();
        assert!(discover_context(&context).clients.is_empty());
    }

    #[test]
    fn explicit_native_paths_and_named_profiles_are_preserved() {
        let sandbox = tempfile::Builder::new()
            .prefix("agent-discovery-")
            .tempdir_in(std::env::temp_dir())
            .unwrap();
        let mut context = context(sandbox.path());
        for &agent in AGENTS {
            executable(&context, agent);
        }
        let custom = sandbox.path().join("custom-native");
        std::fs::create_dir_all(&custom).unwrap();
        context
            .environment
            .insert("CODEX_HOME".into(), custom.clone().into_os_string());
        context
            .environment
            .insert("PI_CONFIG_DIR".into(), "custom-omp".into());
        context
            .environment
            .insert("OMP_PROFILE".into(), "work".into());
        context.environment.insert(
            "PI_CODING_AGENT_DIR".into(),
            sandbox.path().join("ignored-omp").into_os_string(),
        );
        context.environment.insert(
            "OPENCODE_CONFIG".into(),
            custom.join("custom.jsonc").into_os_string(),
        );
        context.environment.insert(
            "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE".into(),
            custom.join("provider_config.json").into_os_string(),
        );
        let result = discover_context(&context);
        let found = |agent| {
            &result
                .clients
                .iter()
                .find(|client| client.agent_id == agent)
                .unwrap()
                .profiles[0]
        };
        assert_eq!(Path::new(&found(AgentId::Codex).directory), custom);
        assert_eq!(
            Path::new(&found(AgentId::OhMyPi).directory),
            context
                .home
                .as_ref()
                .unwrap()
                .join("custom-omp/profiles/work/agent")
        );
        assert_eq!(found(AgentId::OhMyPi).profile_name.as_deref(), Some("work"));
        assert_eq!(
            Path::new(found(AgentId::OpenCode).config_file.as_deref().unwrap()),
            custom.join("custom.jsonc")
        );
        assert_eq!(
            Path::new(found(AgentId::Zcode).config_file.as_deref().unwrap()),
            custom.join("provider_config.json")
        );
        assert!(!sandbox.path().join("ignored-omp").exists());
        assert!(result
            .clients
            .iter()
            .find(|client| client.agent_id == AgentId::DeepSeekHarness)
            .unwrap()
            .profiles
            .is_empty());
        assert!(!context
            .home
            .as_ref()
            .unwrap()
            .join(".dsh/profiles/headless")
            .exists());
    }

    #[test]
    fn duplicate_search_paths_and_profile_scan_limits_are_explicit() {
        let sandbox = tempfile::Builder::new()
            .prefix("agent-discovery-")
            .tempdir_in(std::env::temp_dir())
            .unwrap();
        let mut context = context(sandbox.path());
        let codex = executable(&context, AgentId::Codex);
        context.environment.insert(
            "PATH".into(),
            std::env::join_paths([codex.parent().unwrap(), codex.parent().unwrap()]).unwrap(),
        );
        assert_eq!(discover_context(&context).clients.len(), 1);
        executable(&context, AgentId::DeepSeekHarness);
        let profiles = context.home.as_ref().unwrap().join(".dsh/profiles");
        for index in 0..(MAX_NAMED_PROFILES + 1) {
            std::fs::create_dir_all(profiles.join(format!("profile-{index}"))).unwrap();
        }
        let result = discover_context(&context);
        assert!(result.limited);
        assert_eq!(
            result
                .clients
                .iter()
                .find(|client| client.agent_id == AgentId::DeepSeekHarness)
                .unwrap()
                .profiles
                .len(),
            MAX_NAMED_PROFILES
        );
    }

    #[test]
    fn malformed_explicit_paths_do_not_fall_back_to_another_profile() {
        let sandbox = tempfile::Builder::new()
            .prefix("agent-discovery-")
            .tempdir_in(std::env::temp_dir())
            .unwrap();
        let mut context = context(sandbox.path());
        executable(&context, AgentId::Codex);
        context
            .environment
            .insert("CODEX_HOME".into(), "relative-profile".into());
        let result = discover_context(&context);
        assert_eq!(result.clients.len(), 1);
        assert!(result.clients[0].profiles.is_empty());
        assert!(result.clients[0]
            .reason
            .as_deref()
            .unwrap()
            .contains("CODEX_HOME"));
        assert!(!context.home.as_ref().unwrap().join(".codex").exists());
    }

    #[test]
    fn hermes_suffix_and_profile_metadata_are_honored_without_reading_marker() {
        let sandbox = tempfile::Builder::new()
            .prefix("agent-discovery-")
            .tempdir_in(std::env::temp_dir())
            .unwrap();
        let mut context = context(sandbox.path());
        executable(&context, AgentId::Hermes);
        context
            .environment
            .insert("HERMES_DATA_DIR_SUFFIX".into(), "-existing".into());
        let home = context.home.as_ref().unwrap();
        let root = if context.windows {
            home.join("AppData/Local/hermes-existing")
        } else {
            home.join(".hermes-existing")
        };
        std::fs::create_dir_all(root.join("profiles/work")).unwrap();
        std::fs::write(
            root.join("active_profile"),
            "private-marker-content-must-not-be-read",
        )
        .unwrap();
        let result = discover_context(&context);
        assert_eq!(result.clients.len(), 1);
        assert_eq!(result.clients[0].profiles.len(), 2);
        assert_eq!(Path::new(&result.clients[0].profiles[0].directory), root);
        assert_eq!(
            Path::new(&result.clients[0].profiles[1].directory),
            root.join("profiles/work")
        );
        assert!(result.clients[0]
            .reason
            .as_deref()
            .unwrap()
            .contains("活动 profile"));
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains("private-marker-content"));
    }

    #[test]
    fn portable_bootstrap_preserves_original_discovery_environment() {
        let sandbox = tempfile::Builder::new()
            .prefix("agent-discovery-bootstrap-")
            .tempdir_in(std::env::temp_dir())
            .unwrap();
        let context = context(sandbox.path());
        let executable = executable(&context, AgentId::Codex);
        let home = context.home.as_ref().unwrap();
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::write(home.join(".codex/history-sentinel"), "original-history").unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "agent_discovery::tests::portable_bootstrap_original_environment_child",
                "--nocapture",
            ])
            .current_dir(sandbox.path())
            .env("AE_DISCOVERY_SNAPSHOT_CHILD", "1")
            .env("AE_SWITCH_PORTABLE_ROOT", sandbox.path().join("portable"))
            .env("HOME", home)
            .env("USERPROFILE", home)
            .env("APPDATA", home.join("AppData/Roaming"))
            .env("LOCALAPPDATA", home.join("AppData/Local"))
            .env("PATH", executable.parent().unwrap())
            .env("ZCODE_BETA", "1")
            .env("ZCODE_ENV", "beta")
            .env("ANTHROPIC_AUTH_TOKEN", "fixture-value-must-not-be-captured")
            .env(
                "OPENCODE_CONFIG_CONTENT",
                "fixture-value-must-not-be-captured",
            )
            .env(
                "AE_SWITCH_DYNAMIC_CREDENTIAL_TEST",
                "fixture-value-must-not-be-captured",
            )
            .env_remove("ProgramFiles")
            .env_remove("ProgramFiles(x86)")
            .env_remove("CODEX_HOME")
            .env_remove("CLAUDE_CONFIG_DIR")
            .env_remove("UNI_SWITCH_QA_AGENT_DISCOVERY_CONTEXT")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert_eq!(
            std::fs::read(home.join(".codex/history-sentinel")).unwrap(),
            b"original-history"
        );
        assert_eq!(std::fs::read_dir(home.join(".codex")).unwrap().count(), 1);
    }

    #[test]
    fn portable_bootstrap_original_environment_child() {
        if std::env::var("AE_DISCOVERY_SNAPSHOT_CHILD").ok().as_deref() != Some("1") {
            return;
        }
        let before = PathBuf::from(std::env::var_os("HOME").unwrap());
        crate::portable::initialize().unwrap();
        for name in [
            "ANTHROPIC_AUTH_TOKEN",
            "OPENCODE_CONFIG_CONTENT",
            "AE_SWITCH_DYNAMIC_CREDENTIAL_TEST",
        ] {
            std::env::remove_var(name);
            assert!(original_environment_has(name));
            assert!(!original_environment().contains_key(name));
            #[cfg(windows)]
            assert!(original_environment_has(&name.to_ascii_lowercase()));
        }
        assert!(!original_environment_has(
            "AE_SWITCH_MISSING_CREDENTIAL_TEST"
        ));
        assert_eq!(original_environment()["ZCODE_BETA"], "1");
        assert_eq!(original_environment()["ZCODE_ENV"], "beta");
        assert_ne!(std::env::var_os("HOME").unwrap(), before.as_os_str());
        assert_eq!(
            original_environment().get("HOME").unwrap(),
            before.as_os_str()
        );
        let result = discover();
        let codex = result
            .clients
            .iter()
            .find(|client| client.agent_id == AgentId::Codex)
            .unwrap();
        assert_eq!(codex.profiles.len(), 1);
        assert_eq!(Path::new(&codex.profiles[0].home_directory), before);
        assert_eq!(
            Path::new(&codex.profiles[0].directory),
            before.join(".codex")
        );
        assert!(codex.source == "PATH");
    }

    #[test]
    fn invalid_named_omp_profile_is_never_replaced_by_default() {
        let sandbox = tempfile::Builder::new()
            .prefix("agent-discovery-")
            .tempdir_in(std::env::temp_dir())
            .unwrap();
        let mut context = context(sandbox.path());
        executable(&context, AgentId::OhMyPi);
        context
            .environment
            .insert("OMP_PROFILE".into(), "../other-profile".into());
        let result = discover_context(&context);
        assert_eq!(result.clients.len(), 1);
        assert!(result.clients[0].profiles.is_empty());
        assert!(result.clients[0]
            .reason
            .as_deref()
            .unwrap()
            .contains("未回退"));
        assert!(!context.home.as_ref().unwrap().join(".omp/agent").exists());
    }

    #[cfg(unix)]
    #[test]
    fn linked_native_profile_is_not_proposed_for_configuration() {
        let sandbox = tempfile::Builder::new()
            .prefix("agent-discovery-")
            .tempdir_in(std::env::temp_dir())
            .unwrap();
        let context = context(sandbox.path());
        executable(&context, AgentId::Codex);
        let outside = sandbox.path().join("separate-history");
        std::fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, context.home.as_ref().unwrap().join(".codex"))
            .unwrap();
        let result = discover_context(&context);
        assert_eq!(result.clients.len(), 1);
        assert!(result.clients[0].profiles.is_empty());
        assert!(std::fs::read_dir(&outside).unwrap().next().is_none());
    }
}
