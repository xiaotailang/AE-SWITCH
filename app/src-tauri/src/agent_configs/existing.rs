//! Explicit native-profile targets. Runtime state remains in AE's data root.
use super::*;
use std::collections::{BTreeMap, HashSet};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExistingProfile {
    pub directory: String,
    pub home_directory: String,
    pub executable_path: String,
    pub workspace_directory: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_directory: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub xdg_config_directory: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub xdg_data_directory: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub xdg_state_directory: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub xdg_cache_directory: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secondary_config_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub builtin_config_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_file: Option<String>,
}

fn invalid_profile(message: &str) -> AppError {
    AppError::new("invalid_agent_profile", message)
}

pub(super) fn absolute_path(value: &str) -> Result<PathBuf> {
    let path = PathBuf::from(value);
    if value.is_empty()
        || value.chars().any(char::is_control)
        || !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err(invalid_profile(
            "请选择工具实际使用的绝对路径，不接受空路径或父目录跳转",
        ));
    }
    #[cfg(windows)]
    for part in path.components() {
        if let Component::Normal(name) = part {
            let name = name.to_string_lossy();
            if name.ends_with(['.', ' ']) || name.contains(':') {
                return Err(invalid_profile("不接受 Windows 路径别名或备用数据流"));
            }
        }
    }
    Ok(path)
}

fn path_identity(path: &Path) -> Result<String> {
    let mut ancestor = path;
    let mut suffix = Vec::new();
    while !ancestor.exists() {
        let name = ancestor
            .file_name()
            .ok_or_else(|| invalid_profile("配置路径没有可验证的父目录"))?;
        suffix.push(name.to_owned());
        ancestor = ancestor
            .parent()
            .ok_or_else(|| invalid_profile("配置路径没有可验证的父目录"))?;
    }
    let mut physical = ancestor
        .canonicalize()
        .map_err(|error| AppError::io(ancestor, error))?;
    for name in suffix.into_iter().rev() {
        physical.push(name);
    }
    let identity = physical.to_string_lossy().into_owned();
    #[cfg(windows)]
    let identity = identity.to_lowercase();
    Ok(identity)
}

pub fn validate_profile(agent: AgentId, profile: &ExistingProfile) -> Result<()> {
    for value in [
        &profile.directory,
        &profile.home_directory,
        &profile.workspace_directory,
    ] {
        let path = absolute_path(value)?;
        check_existing_ancestors(&path)?;
        if path.exists() && !path.is_dir() {
            return Err(invalid_profile("工具配置、HOME 和工作目录必须是目录"));
        }
    }
    for value in [
        profile.data_directory.as_ref(),
        profile.xdg_config_directory.as_ref(),
        profile.xdg_data_directory.as_ref(),
        profile.xdg_state_directory.as_ref(),
        profile.xdg_cache_directory.as_ref(),
    ]
    .into_iter()
    .flatten()
    {
        let path = absolute_path(value)?;
        check_existing_ancestors(&path)?;
        if path.exists() && !path.is_dir() {
            return Err(invalid_profile("存储与 XDG 路径必须是目录"));
        }
    }
    let executable = absolute_path(&profile.executable_path)?;
    if !executable.is_file() {
        return Err(AppError::new(
            "missing_agent",
            "所选客户端入口不存在，请先安装客户端或重新选择入口",
        ));
    }
    if !Path::new(&profile.home_directory).is_dir()
        || !Path::new(&profile.workspace_directory).is_dir()
    {
        return Err(invalid_profile(
            "原 HOME 和工作目录必须已存在，AE 不会另建私有用户环境",
        ));
    }
    if agent == AgentId::DeepSeekHarness
        && profile.profile_name.as_ref().is_some_and(|name| {
            name.is_empty()
                || name.chars().any(char::is_control)
                || name.contains(['/', '\\'])
                || matches!(name.as_str(), "." | "..")
        })
    {
        return Err(invalid_profile("DeepSeek Harness profile 名称无效"));
    }
    if agent == AgentId::DeepSeekHarness {
        validate_dsh_composition(profile)?;
    }
    if agent == AgentId::OhMyPi {
        if let Some(name) = &profile.profile_name {
            if name.is_empty()
                || name.contains(['/', '\\'])
                || name.chars().any(char::is_control)
                || matches!(name.as_str(), "." | "..")
            {
                return Err(invalid_profile("OMP profile 名称无效"));
            }
            let expected = Path::new(&profile.home_directory)
                .join(omp_root_name(profile)?)
                .join("profiles")
                .join(name)
                .join("agent");
            if path_identity(Path::new(&profile.directory))? != path_identity(&expected)? {
                return Err(invalid_profile(
                    "所选 OMP 命名 profile 的目录与原 HOME 不匹配，请选择原生 profile 目录",
                ));
            }
        }
    }
    if agent == AgentId::Zcode && profile.builtin_config_file.is_none() {
        let home = Path::new(&profile.home_directory);
        let base = crate::agent_discovery::original_environment()
            .get("ZCODE_DATA_BASE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.to_owned());
        let default = base.join(".zcode/v2/provider_config.json");
        let personal = profile
            .config_file
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| Path::new(&profile.directory).join("provider_config.json"));
        if path_identity(&personal)? != path_identity(&default)? {
            return Err(AppError::new("agent_configuration_conflict", "ZCode 自定义个人 provider 路径需要与其实际 Built-in 配置文件成对选择，请补充只读 Built-in 路径"));
        }
    }
    configuration_paths(agent, profile)?;
    Ok(())
}

pub(super) fn omp_root_name(profile: &ExistingProfile) -> Result<String> {
    if let Some(name) = &profile.profile_name {
        let directory = Path::new(&profile.directory);
        let root = directory
            .parent()
            .filter(|parent| {
                parent
                    .file_name()
                    .is_some_and(|value| value == name.as_str())
            })
            .and_then(Path::parent)
            .filter(|parent| parent.file_name().is_some_and(|value| value == "profiles"))
            .and_then(Path::parent)
            .ok_or_else(|| {
                invalid_profile("OMP 命名 profile 目录应为 <HOME>/<配置根>/profiles/<名称>/agent")
            })?;
        let relative = root
            .strip_prefix(&profile.home_directory)
            .map_err(|_| invalid_profile("OMP 命名 profile 必须属于原 HOME"))?;
        if relative.components().count() != 1 {
            return Err(invalid_profile("OMP 配置根名称无效"));
        }
        return Ok(relative.to_string_lossy().into_owned());
    }
    Ok(crate::agent_discovery::original_environment()
        .get("PI_CONFIG_DIR")
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| ".omp".into()))
}

fn resolve_native_storage(value: &str, home: &Path, workspace: &Path) -> Result<PathBuf> {
    if value.trim().is_empty() || value.chars().any(char::is_control) {
        return Err(invalid_profile("ZCode storage.dir 无效"));
    }
    let path = if let Some(relative) = value.strip_prefix("~/") {
        home.join(relative)
    } else {
        let path = PathBuf::from(value);
        if path.is_absolute() {
            path
        } else {
            workspace.join(path)
        }
    };
    let mut normalized = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(invalid_profile("ZCode storage.dir 跳出了文件系统根"));
                }
            }
            _ => normalized.push(part.as_os_str()),
        }
    }
    absolute_path(&normalized.to_string_lossy())
}

fn zcode_state_path(profile: &ExistingProfile) -> Result<PathBuf> {
    zcode_state_path_with_environment(profile, crate::agent_discovery::original_environment())
}

fn zcode_state_path_with_environment(
    profile: &ExistingProfile,
    original: &BTreeMap<String, std::ffi::OsString>,
) -> Result<PathBuf> {
    let home = Path::new(&profile.home_directory);
    let workspace = Path::new(&profile.workspace_directory);
    let beta = original.get("ZCODE_BETA").is_some_and(|value| value == "1")
        || original
            .get("ZCODE_ENV")
            .is_some_and(|value| value == "beta")
        || Path::new(&profile.executable_path)
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with("zcode-beta"));
    let mut storage = home.join(if beta { ".zcode-beta" } else { ".zcode" });
    let user_config = home.join(".zcode/cli/config.json");
    let mut configs = vec![user_config];
    let mut project_directories = vec![];
    let mut worktree_found = false;
    for directory in workspace.ancestors() {
        project_directories.push(directory);
        let marker = directory.join(".git");
        if marker.is_file() || marker.is_dir() {
            worktree_found = true;
            break;
        }
    }
    if worktree_found {
        project_directories.reverse();
    } else {
        project_directories = vec![workspace];
    }
    for directory in project_directories {
        configs.push(directory.join("zcode.json"));
        configs.push(directory.join(".zcode/config.json"));
    }
    for config in configs {
        let Some(text) = native_merge::read_authorized(&config, [&config])? else {
            continue;
        };
        let value = native_merge::json(Some(&text), &config, serde_json::json!({}))?;
        let object = value
            .as_object()
            .ok_or_else(|| native_merge::invalid(&config))?;
        if let Some(value) = object.get("storage") {
            let value = value
                .as_object()
                .ok_or_else(|| native_merge::invalid(&config))?;
            if let Some(value) = value.get("dir") {
                let value = value
                    .as_str()
                    .ok_or_else(|| native_merge::invalid(&config))?;
                storage = resolve_native_storage(value, home, workspace)?;
            }
        }
    }
    if let Some(value) = original
        .get("ZCODE_STORAGE_DIR")
        .filter(|value| !value.is_empty())
    {
        storage = resolve_native_storage(&value.to_string_lossy(), home, workspace)?;
    } else if beta {
        storage = home.join(".zcode-beta");
    }
    Ok(storage.join("v2/agents-state.json"))
}

fn validate_dsh_composition(profile: &ExistingProfile) -> Result<()> {
    let package_path = Path::new(&profile.directory).join("package.json");
    let package_text =
        native_merge::read_authorized(&package_path, [&package_path])?.ok_or_else(|| {
            AppError::new(
                "agent_configuration_conflict",
                "DeepSeek Harness 所选 profile 缺少原生 package.json，请先由官方客户端建立 profile",
            )
        })?;
    let package = native_merge::json(Some(&package_text), &package_path, serde_json::json!({}))?;
    let bundles = package
        .get("dsh")
        .and_then(|value| value.get("profile"))
        .and_then(|value| value.get("bundles"))
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| native_merge::invalid(&package_path))?;
    if bundles.first().and_then(serde_json::Value::as_str) != Some("@deepseek-ai/dsh-base")
        || bundles.iter().any(|value| {
            !matches!(
                value.as_str(),
                Some(
                    "@deepseek-ai/dsh-base"
                        | "@deepseek-ai/dsh-headless"
                        | "@deepseek-ai/dsh-acp-app"
                        | "@deepseek-ai/dsh-sdk-app"
                        | "@deepseek-ai/dsh-web-app"
                )
            )
        })
    {
        return Err(AppError::new("agent_configuration_conflict", "此 DeepSeek Harness profile 使用未经验证的自定义组合；请先选择官方以 dsh-base 开头的 profile"));
    }
    let paths = configuration_paths(AgentId::DeepSeekHarness, profile)?;
    let home = profile
        .data_directory
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(&profile.home_directory).join(".dsh"));
    let home_patch = home.join("cordis.patch.yml");
    if home_patch == paths["config"] {
        return Ok(());
    }
    if let Some(text) = native_merge::read_authorized(&home_patch, [&home_patch])? {
        let source = native_merge::Yaml::parse(Some(&text), &home_patch, serde_json::json!([]))?;
        let mut rows = source.value();
        native_merge::rows(&mut rows, &home_patch, "id")?;
        for row in rows.as_array().expect("validated array") {
            if row["id"] == "credentials" {
                check_dsh_credentials_override(profile, row, &paths)?;
            }
            if matches!(
                row["id"].as_str(),
                Some(
                    "agent-default-model"
                        | "llm-pi-ai"
                        | "compaction-basic"
                        | "session-title-llm"
                        | "tool-subagent"
                        | "tool-subagent-fork"
                )
            ) {
                return Err(AppError::new("agent_configuration_conflict", "DeepSeek Harness HOME 全局补丁替换所选 profile 的路由插件；请在主配置路径选择该 cordis.patch.yml，或先在原工具解决冲突"));
            }
        }
    }
    Ok(())
}

pub(super) fn configuration_paths(
    agent: AgentId,
    profile: &ExistingProfile,
) -> Result<BTreeMap<&'static str, PathBuf>> {
    let directory = absolute_path(&profile.directory)?;
    let home = absolute_path(&profile.home_directory)?;
    let data = profile
        .data_directory
        .as_deref()
        .map(absolute_path)
        .transpose()?;
    let config = |name: &str| -> Result<PathBuf> {
        profile
            .config_file
            .as_deref()
            .map(absolute_path)
            .unwrap_or_else(|| Ok(directory.join(name)))
    };
    let secondary = |default: PathBuf| -> Result<PathBuf> {
        profile
            .secondary_config_file
            .as_deref()
            .map(absolute_path)
            .unwrap_or(Ok(default))
    };
    let mut paths = BTreeMap::new();
    let main = match agent {
        AgentId::ClaudeCode => config("settings.json")?,
        AgentId::Codex => config("config.toml")?,
        AgentId::Hermes => config("config.yaml")?,
        AgentId::OhMyPi => {
            paths.insert("secondary", secondary(directory.join("config.yml"))?);
            config("models.yml")?
        }
        AgentId::OpenCode => config("opencode.json")?,
        AgentId::WorkBuddy => config("models.json")?,
        AgentId::Zcode => {
            paths.insert(
                "builtin",
                profile
                    .builtin_config_file
                    .as_deref()
                    .map(absolute_path)
                    .unwrap_or_else(|| Ok(directory.join("builtin-providers.json")))?,
            );
            let state = profile
                .state_file
                .as_deref()
                .map(absolute_path)
                .unwrap_or_else(|| zcode_state_path(profile))?;
            if !state.ends_with(Path::new("v2").join("agents-state.json")) {
                return Err(invalid_profile("ZCode 状态文件必须是实际存储目录下的 v2/agents-state.json，不能选择会话数据库或其它配置"));
            }
            paths.insert("state", state);
            config("provider_config.json")?
        }
        AgentId::DeepSeekHarness => {
            paths.insert(
                "secondary",
                secondary(
                    data.unwrap_or_else(|| home.join(".dsh"))
                        .join(".credentials.yaml"),
                )?,
            );
            config("cordis.patch.yml")?
        }
    };
    paths.insert("config", main);
    let mut unique = HashSet::new();
    for path in paths.values() {
        check_existing_ancestors(path)?;
        if !unique.insert(path_identity(path)?) {
            return Err(invalid_profile("配置文件路径不能互相重叠"));
        }
    }
    Ok(paths)
}

pub(super) fn dsh_credential_ref(profile: &ExistingProfile) -> String {
    use sha2::Digest;
    let path = profile
        .config_file
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(&profile.directory).join("cordis.patch.yml"));
    let digest = sha2::Sha256::digest(path.to_string_lossy().as_bytes());
    let suffix = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<String>();
    format!("AE_SWITCH_{suffix}_API_KEY")
}

fn check_dsh_credentials_override(
    profile: &ExistingProfile,
    row: &serde_json::Value,
    paths: &BTreeMap<&str, PathBuf>,
) -> Result<()> {
    let path = &paths["secondary"];
    if row.get("disabled") == Some(&serde_json::Value::Bool(true))
        || row
            .get("name")
            .is_some_and(|name| name != "@deepseek-ai/dsh-credentials-local")
    {
        return Err(AppError::new(
            "agent_configuration_conflict",
            "DeepSeek Harness 原生凭据插件已停用或被替换；请在原工具启用默认本地凭据插件后重试",
        ));
    }
    if let Some(config) = row.get("config") {
        let config = config
            .as_object()
            .ok_or_else(|| native_merge::invalid(&paths["config"]))?;
        let storage = if let Some(value) = config.get("path") {
            let value = value
                .as_str()
                .ok_or_else(|| native_merge::invalid(&paths["config"]))?;
            let value = PathBuf::from(value);
            if value.is_absolute() {
                value
            } else {
                Path::new(&profile.workspace_directory).join(value)
            }
        } else if let Some(value) = config.get("dshHome") {
            let value = value
                .as_str()
                .ok_or_else(|| native_merge::invalid(&paths["config"]))?;
            let value = PathBuf::from(value);
            let value = if value.is_absolute() {
                value
            } else {
                Path::new(&profile.workspace_directory).join(value)
            };
            value.join(".credentials.yaml")
        } else {
            path.clone()
        };
        if storage != *path {
            return Err(AppError::new(
                "agent_configuration_conflict",
                "DeepSeek Harness 凭据插件使用其它路径；请在手动路径中选择该插件实际使用的凭据文件",
            ));
        }
    }
    Ok(())
}

pub(super) fn plan_dsh_credentials(
    profile: &ExistingProfile,
    rows: &[serde_json::Value],
    snapshots: &mut Vec<native_merge::Snapshot>,
    writes: &mut Vec<(PathBuf, String)>,
    token: &str,
) -> Result<()> {
    let paths = configuration_paths(AgentId::DeepSeekHarness, profile)?;
    let path = &paths["secondary"];
    for row in rows {
        if row["id"] == "credentials" {
            check_dsh_credentials_override(profile, row, &paths)?;
        }
    }
    let text = native_merge::snapshot_authorized(path, paths.values(), snapshots)?;
    let source =
        native_merge::Yaml::parse(text.as_deref(), path, serde_json::json!({"version":1}))?;
    let mut value = source.value();
    let fields = native_merge::object(&mut value, path)?;
    if fields.get("version").and_then(serde_json::Value::as_u64) != Some(1)
        || fields
            .keys()
            .any(|key| !matches!(key.as_str(), "version" | "refs" | "records"))
    {
        return Err(native_merge::invalid(path));
    }
    let valid_ref = |name: &str| {
        let mut bytes = name.bytes();
        bytes
            .next()
            .is_some_and(|b| b == b'_' || b.is_ascii_alphabetic())
            && bytes.all(|b| b == b'_' || b.is_ascii_alphanumeric())
    };
    if let Some(refs) = fields.get("refs").filter(|value| !value.is_null()) {
        let refs = refs
            .as_object()
            .ok_or_else(|| native_merge::invalid(path))?;
        if refs
            .iter()
            .any(|(name, value)| !valid_ref(name) || value.as_str().is_none_or(str::is_empty))
        {
            return Err(native_merge::invalid(path));
        }
    }
    if let Some(records) = fields.get("records").filter(|value| !value.is_null()) {
        let records = records
            .as_object()
            .ok_or_else(|| native_merge::invalid(path))?;
        for (key, record) in records {
            let segments: Vec<_> = key.split('/').collect();
            if segments.len() != 2
                || segments.iter().any(|segment| {
                    let mut bytes = segment.bytes();
                    !bytes.next().is_some_and(|b| b.is_ascii_lowercase())
                        || !bytes.all(|b| b == b'-' || b.is_ascii_lowercase() || b.is_ascii_digit())
                })
            {
                return Err(native_merge::invalid(path));
            }
            let record = record
                .as_object()
                .ok_or_else(|| native_merge::invalid(path))?;
            match record.get("kind").and_then(serde_json::Value::as_str) {
                Some("api-key") => {
                    if record
                        .keys()
                        .any(|key| !matches!(key.as_str(), "kind" | "key" | "env"))
                        || record
                            .get("key")
                            .is_some_and(|value| value.as_str().is_none_or(str::is_empty))
                    {
                        return Err(native_merge::invalid(path));
                    }
                    if let Some(env) = record.get("env") {
                        let env = env.as_object().ok_or_else(|| native_merge::invalid(path))?;
                        if env.iter().any(|(name, value)| {
                            !valid_ref(name) || value.as_str().is_none_or(str::is_empty)
                        }) {
                            return Err(native_merge::invalid(path));
                        }
                    }
                }
                Some("grant")
                    if record.contains_key("payload")
                        && record
                            .keys()
                            .all(|key| matches!(key.as_str(), "kind" | "payload")) => {}
                _ => return Err(native_merge::invalid(path)),
            }
        }
    }
    if value.get("refs").is_some_and(serde_json::Value::is_null) {
        value["refs"] = serde_json::json!({});
    }
    native_merge::set(
        native_merge::child(&mut value, "refs", path)?,
        &dsh_credential_ref(profile),
        token.into(),
        path,
    )?;
    writes.push((path.clone(), source.render(&value, path)?));
    Ok(())
}

const JOURNAL: &str = "agent-native-configuration.pending.json";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Change {
    slot: String,
    before: Option<String>,
    after: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    agent: AgentId,
    selection_before: Option<String>,
    selection_after: String,
    changes: Vec<Change>,
}

fn read_native(path: &Path, paths: &BTreeMap<&str, PathBuf>) -> Result<Option<String>> {
    native_merge::read_authorized(path, paths.values())
}

fn check_changes(journal: &Journal, paths: &BTreeMap<&str, PathBuf>) -> Result<()> {
    if journal.changes.is_empty() || journal.changes.len() > paths.len() {
        return Err(AppError::new("invalid_state", "既有工具配置备份结构无效"));
    }
    let mut unique = HashSet::new();
    for change in &journal.changes {
        if !paths.contains_key(change.slot.as_str())
            || !unique.insert(&change.slot)
            || change.after.len() > 4 * 1024 * 1024
            || change
                .before
                .as_ref()
                .is_some_and(|text| text.len() > 4 * 1024 * 1024)
        {
            return Err(AppError::new(
                "invalid_state",
                "既有工具配置备份包含未经选择的文件",
            ));
        }
    }
    Ok(())
}

fn restore(root: &Path, journal: &Journal, paths: &BTreeMap<&str, PathBuf>) -> Result<()> {
    // Every native file is checked before any rollback. Client edits are never overwritten.
    for change in &journal.changes {
        let current = read_native(&paths[change.slot.as_str()], paths)?;
        if current != change.before && current.as_deref() != Some(change.after.as_str()) {
            return Err(AppError::new(
                "agent_configuration_changed",
                "客户端在配置期间修改了文件；原文件备份已保留，未覆盖客户端修改",
            ));
        }
    }
    for change in journal.changes.iter().rev() {
        let path = &paths[change.slot.as_str()];
        let current = read_native(path, paths)?;
        if current == change.before {
            continue;
        }
        if current.as_deref() != Some(change.after.as_str()) {
            return Err(AppError::new(
                "agent_configuration_changed",
                "恢复前客户端配置发生变化，备份已保留",
            ));
        }
        native_merge::write_authorized(path, paths.values(), change.before.as_deref())?;
        if read_native(path, paths)? != change.before {
            return Err(AppError::new(
                "verify_failed",
                "原客户端配置恢复后核对失败，备份已保留",
            ));
        }
    }
    // Keep the selected profile as recovery authority until every native file is restored.
    writer::write(
        &root.join("agent-selection.json"),
        journal.selection_before.as_deref(),
    )
}

pub(super) fn commit(
    root: &Path,
    agent: AgentId,
    profile: &ExistingProfile,
    snapshots: &[native_merge::Snapshot],
    writes: Vec<(PathBuf, String)>,
    selection: (&Path, &str, Option<&str>),
) -> Result<()> {
    if agent == AgentId::Zcode && profile.state_file.is_none() {
        return Err(invalid_profile(
            "ZCode 原生 state 路径必须在准备阶段解析并保存，拒绝动态恢复目标",
        ));
    }
    let paths = configuration_paths(agent, profile)?;
    if paths.values().any(|path| {
        path_identity(path).ok().is_some_and(|identity| {
            let portable = root
                .canonicalize()
                .unwrap_or_else(|_| root.to_owned())
                .to_string_lossy()
                .into_owned();
            #[cfg(windows)]
            let portable = portable.to_lowercase();
            Path::new(&identity).starts_with(Path::new(&portable))
        })
    }) {
        return Err(AppError::new(
            "unsafe_path",
            "既有客户端配置不能覆盖 AE 自身数据目录；请选择原客户端的实际 profile",
        ));
    }
    let (selection_path, selection_after, selection_before) = selection;
    if selection_path != root.join("agent-selection.json")
        || native_merge::read(root, selection_path)?.as_deref() != selection_before
    {
        return Err(AppError::new(
            "agent_configuration_changed",
            "工具选择状态已修改，请刷新后重试",
        ));
    }
    for (path, before) in snapshots {
        if read_native(path, &paths)? != *before {
            return Err(AppError::new(
                "agent_configuration_changed",
                "客户端配置在准备期间修改，原配置未覆盖",
            ));
        }
    }
    let changes = writes
        .into_iter()
        .map(|(path, after)| {
            let slot = paths
                .iter()
                .find_map(|(slot, known)| (known == &path).then_some(*slot))
                .ok_or_else(|| AppError::new("unsafe_path", "拒绝写入未选择的客户端配置文件"))?;
            let before = snapshots
                .iter()
                .find(|(known, _)| known == &path)
                .ok_or_else(|| AppError::new("invalid_state", "配置缺少原文件快照"))?
                .1
                .clone();
            Ok(Change {
                slot: slot.into(),
                before,
                after,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let journal = Journal {
        agent,
        selection_before: selection_before.map(str::to_owned),
        selection_after: selection_after.into(),
        changes,
    };
    check_changes(&journal, &paths)?;
    let serialized = serde_json::to_string(&journal)
        .map_err(|_| AppError::new("serialization", "无法保存原客户端配置备份"))?;
    if serialized.len() > 32 * 1024 * 1024 {
        return Err(AppError::new(
            "response_limit",
            "配置事务超过 32 MB，原配置未修改",
        ));
    }
    let journal_path = root.join(JOURNAL);
    write_checked(root, &journal_path, &serialized)?;
    // Persist exact user-selected targets before touching external native files.
    let result = (|| {
        write_checked(root, selection_path, selection_after)?;
        if native_merge::read(root, selection_path)?.as_deref() != Some(selection_after) {
            return Err(AppError::new("verify_failed", "工具选择状态回读失败"));
        }
        for change in &journal.changes {
            let path = &paths[change.slot.as_str()];
            if read_native(path, &paths)? != change.before {
                return Err(AppError::new(
                    "agent_configuration_changed",
                    "写入前客户端配置发生变化",
                ));
            }
            check_existing_ancestors(path)?;
            native_merge::write_authorized(path, paths.values(), Some(&change.after))?;
            if read_native(path, &paths)?.as_deref() != Some(change.after.as_str()) {
                return Err(AppError::new("verify_failed", "原生客户端配置回读校验失败"));
            }
        }
        Ok(())
    })();
    if let Err(error) = result {
        if restore(root, &journal, &paths).is_err() {
            return Err(AppError::new(
                "recovery_required",
                "原客户端配置无法完整恢复；备份保留于 AE 数据目录，请关闭客户端后重启 AE",
            ));
        }
        let _ = writer::write(&journal_path, None);
        return Err(error);
    }
    let _ = writer::write(&journal_path, None);
    Ok(())
}

pub(super) fn recover(root: &Path) -> Result<()> {
    let journal_path = root.join(JOURNAL);
    let Some(contents) = native_merge::read_limit(root, &journal_path, 32 * 1024 * 1024)? else {
        return Ok(());
    };
    let journal: Journal = serde_json::from_str(&contents)
        .map_err(|_| AppError::new("invalid_state", "既有客户端配置备份损坏，未执行恢复"))?;
    let current = native_merge::read(root, &root.join("agent-selection.json"))?;
    if current == journal.selection_before
        && current.as_deref() != Some(journal.selection_after.as_str())
    {
        // Selection is written first and restored last: no external write remains.
        return writer::write(&journal_path, None);
    }
    if current.as_deref() != Some(journal.selection_after.as_str()) {
        return Err(AppError::new(
            "agent_configuration_changed",
            "工具选择状态与备份不一致，未修改任何客户端配置",
        ));
    }
    // Authority comes from independently persisted selection, never an arbitrary journal path.
    let profile = crate::agent_hub::existing_profile(root, journal.agent)?
        .ok_or_else(|| AppError::new("invalid_state", "备份没有对应的既有客户端选择"))?;
    if journal.agent == AgentId::Zcode && profile.state_file.is_none() {
        return Err(AppError::new(
            "invalid_state",
            "ZCode 备份缺少已确认的 state 路径，未执行恢复",
        ));
    }
    let paths = configuration_paths(journal.agent, &profile)?;
    check_changes(&journal, &paths)?;
    let complete = journal
        .changes
        .iter()
        .map(|change| {
            read_native(&paths[change.slot.as_str()], &paths)
                .map(|current| current.as_deref() == Some(change.after.as_str()))
        })
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .all(|done| done);
    if !complete {
        restore(root, &journal, &paths)?;
    }
    writer::write(&journal_path, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn fixture(agent: AgentId) -> (tempfile::TempDir, PathBuf, ExistingProfile) {
        let temporary = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
        let data = temporary.path().join("ae-data");
        let native = temporary.path().join("original-profile");
        let home = temporary.path().join("original-home");
        let workspace = temporary.path().join("original-project");
        for directory in [&data, &native, &home, &workspace] {
            std::fs::create_dir_all(directory).unwrap();
        }
        let executable = temporary.path().join(if cfg!(windows) {
            "official-entry.exe"
        } else {
            "official-entry"
        });
        std::fs::write(&executable, "fixture entry, never executed").unwrap();
        let mut profile = ExistingProfile {
            directory: native.to_string_lossy().into(),
            home_directory: home.to_string_lossy().into(),
            executable_path: executable.to_string_lossy().into(),
            workspace_directory: workspace.to_string_lossy().into(),
            ..Default::default()
        };
        if agent == AgentId::DeepSeekHarness {
            profile.data_directory = Some(
                temporary
                    .path()
                    .join("original-dsh-home")
                    .to_string_lossy()
                    .into(),
            );
            profile.profile_name = Some("headless".into());
            std::fs::write(native.join("package.json"), r#"{"private":true,"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-headless"]}},"user":"keep"}"#).unwrap();
        }
        if agent == AgentId::Zcode {
            profile.state_file = Some(
                home.join("actual-storage/v2/agents-state.json")
                    .to_string_lossy()
                    .into(),
            );
            profile.config_file = Some(
                home.join(".zcode/v2/provider_config.json")
                    .to_string_lossy()
                    .into(),
            );
        }
        (temporary, data, profile)
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn selection(agent: AgentId, profile: &ExistingProfile, model: &str) -> String {
        serde_json::to_string_pretty(&json!({agent.as_str(): {"providerId":"fixture-provider","model":model,"profile":profile}})).unwrap()
    }

    fn apply(
        data: &Path,
        agent: AgentId,
        profile: &ExistingProfile,
        model: &str,
        token: &str,
    ) -> Result<ConfiguredAgent> {
        let path = data.join("agent-selection.json");
        let before = std::fs::read_to_string(&path).ok();
        configure_existing_with_selection(
            data,
            agent,
            "http://127.0.0.1:18762/agents/selected:test/v1",
            token,
            model,
            profile,
            (&path, &selection(agent, profile, model), before.as_deref()),
        )
    }

    #[test]
    fn existing_profile_external_native_transaction_works_with_initialized_portable_root() {
        const CHILD_ROOT: &str = "AE_SWITCH_NATIVE_TRANSACTION_REGRESSION_ROOT";
        if let Some(case) = std::env::var_os(CHILD_ROOT) {
            // This branch runs alone in a subprocess. Bootstrap can safely set
            // its process environment without changing parallel tests or C HOME.
            let case = PathBuf::from(case);
            crate::portable::validate_root(&case).unwrap();
            let data = crate::portable::initialize().unwrap();
            let native = case.join("original-profile");
            let home = case.join("original-home");
            let workspace = case.join("original-workspace");
            for directory in [&native, &home, &workspace] {
                std::fs::create_dir_all(directory).unwrap();
            }
            let executable = case.join(if cfg!(windows) {
                "official-entry.exe"
            } else {
                "official-entry"
            });
            std::fs::write(&executable, "selected fixture entry, never executed").unwrap();
            let profile = ExistingProfile {
                directory: native.to_string_lossy().into(),
                home_directory: home.to_string_lossy().into(),
                executable_path: executable.to_string_lossy().into(),
                workspace_directory: workspace.to_string_lossy().into(),
                ..Default::default()
            };
            let paths = configuration_paths(AgentId::OhMyPi, &profile).unwrap();
            let portable = PathBuf::from(std::env::var_os("AE_SWITCH_PORTABLE_ROOT").unwrap());
            assert!(!paths["config"].starts_with(&portable));
            write(
                &paths["config"],
                "# original native preferences\nproviders: {}\n",
            );
            let history = home.join("history.jsonl");
            write(&history, "preserve original history bytes\r\n");
            assert_eq!(
                writer::write(&paths["config"], Some("forbidden private write"))
                    .unwrap_err()
                    .code,
                "portable_path"
            );
            apply(&data, AgentId::OhMyPi, &profile, "selected", "native-token").unwrap();
            let configured = std::fs::read_to_string(&paths["config"]).unwrap();
            assert_eq!(
                yaml(&paths["config"])["providers"]["ae_switch"]["apiKey"],
                "native-token"
            );
            assert!(!data.join(JOURNAL).exists());
            assert_eq!(
                native_merge::write_authorized(
                    &history,
                    paths.values(),
                    Some("forbidden native write")
                )
                .unwrap_err()
                .code,
                "unsafe_path"
            );
            assert_eq!(
                writer::write(&paths["config"], None).unwrap_err().code,
                "portable_path"
            );
            let selected = std::fs::read_to_string(data.join("agent-selection.json")).unwrap();
            let journal = Journal {
                agent: AgentId::OhMyPi,
                selection_before: Some(selected.clone()),
                selection_after: selected.clone(),
                changes: vec![
                    Change {
                        slot: "config".into(),
                        before: Some(configured.clone()),
                        after: "interrupted native main".into(),
                    },
                    Change {
                        slot: "secondary".into(),
                        before: None,
                        after: "interrupted native secondary".into(),
                    },
                ],
            };
            write(&paths["config"], &journal.changes[0].after);
            write(&paths["secondary"], &journal.changes[1].after);
            restore(&data, &journal, &paths).unwrap();
            assert_eq!(
                std::fs::read_to_string(&paths["config"]).unwrap(),
                configured
            );
            assert!(
                !paths["secondary"].exists(),
                "rollback removes only its authorized new file"
            );
            write(&paths["config"], &journal.changes[0].after);
            write(
                &data.join(JOURNAL),
                &serde_json::to_string(&journal).unwrap(),
            );
            recover(&data).unwrap();
            assert_eq!(
                std::fs::read_to_string(&paths["config"]).unwrap(),
                configured
            );
            assert_eq!(
                std::fs::read_to_string(data.join("agent-selection.json")).unwrap(),
                selected
            );
            assert!(!data.join(JOURNAL).exists());
            assert_eq!(
                std::fs::read_to_string(&history).unwrap(),
                "preserve original history bytes\r\n"
            );
            assert!(!data.join("agents").exists());
            return;
        }
        let temporary = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
        let portable = temporary.path().join("ae-package");
        std::fs::create_dir_all(&portable).unwrap();
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command.args(["agent_configs::existing::tests::existing_profile_external_native_transaction_works_with_initialized_portable_root","--exact","--nocapture","--test-threads=1"])
            .env(CHILD_ROOT,temporary.path()).env("AE_SWITCH_PORTABLE_ROOT",&portable);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "isolated initialized portable native transaction failed:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn yaml(path: &Path) -> Value {
        native_merge::Yaml::parse(
            Some(&std::fs::read_to_string(path).unwrap()),
            path,
            json!({}),
        )
        .unwrap()
        .value()
    }

    fn json_file(path: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn existing_profiles_all_eight_persist_native_keys_and_preserve_history_preferences() {
        for agent in definitions().into_iter().map(|definition| definition.id) {
            let (_temporary, data, profile) = fixture(agent);
            let paths = configuration_paths(agent, &profile).unwrap();
            let main = &paths["config"];
            let native = match agent {
                AgentId::ClaudeCode => r#"{"apiKeyHelper":"user-helper","permissions":{"deny":["Bash(rm *)"]},"mcpServers":{"keep":{"command":"user"}},"env":{"USER_FLAG":"keep","DISABLE_AUTOUPDATER":"0"}}"#,
                AgentId::Codex => "# user comment\nmodel = 'old'\nmodel_context_window = 765432\n[mcp_servers.keep]\ncommand = 'user'\n",
                AgentId::Hermes => "# native comment\nmodel:\n  default: old\n  context_length: 765432\nauxiliary:\n  compression:\n    enabled: false\n    timeout: 73\n",
                AgentId::OhMyPi => "# native comment\nproviders:\n  user:\n    baseUrl: https://user.invalid\n",
                AgentId::OpenCode => r#"{"permission":{"bash":"deny"},"mcp":{"keep":{"command":["user"]}},"agent":{"custom":{"model":"other/custom"}}}"#,
                AgentId::Zcode => r#"{"schemaVersion":1,"config":{"providerConfigRules":{"providerRules":[]},"modelConfigRules":{"providerModelRules":[],"manualProviderModelRules":[]},"defaultModelSelection":{"providerId":"old","modelId":"old","options":{"reasoningLevel":"disabled"}}}}"#,
                AgentId::WorkBuddy => r#"{"models":[{"id":"user-model","url":"https://user.invalid","apiKey":"user-key"}],"preferences":{"theme":"user"}}"#,
                AgentId::DeepSeekHarness => "# native comment\n- id: session-telemetry-otel\n  disabled: false\n  config:\n    user: keep\n- id: user-plugin\n  config:\n    context: 765432\n",
            };
            write(main, native);
            if agent == AgentId::OhMyPi {
                write(&paths["secondary"], "# preserve\nmodelRoles:\n  custom: user/custom\n  fast: user/kind\ntheme: user\n");
            }
            if agent == AgentId::DeepSeekHarness {
                write(&paths["secondary"], "# keep credentials comment\nversion: 1\nrefs:\n  USER_KEY: unchanged\nrecords:\n  user/provider:\n    kind: grant\n    payload:\n      access: user-oauth\n");
            }
            if agent == AgentId::Zcode {
                write(
                    &paths["state"],
                    r#"{"disabledAgentIds":["user"],"builtInModelSelectionOverrides":{"Explore":{"providerId":"old","modelId":"old","options":{"reasoningLevel":"disabled"}}},"customState":"keep"}"#,
                );
            }
            let sentinels = [
                Path::new(&profile.home_directory).join("history.jsonl"),
                Path::new(&profile.workspace_directory).join("user-work.txt"),
                Path::new(&profile.directory).join("auth-session.db"),
            ];
            for path in &sentinels {
                write(path, "preserve exact user bytes\r\n");
            }
            apply(&data, agent, &profile, "selected-first", "token-one").unwrap();
            apply(&data, agent, &profile, "selected-second", "token-two").unwrap();
            for path in &sentinels {
                assert_eq!(
                    std::fs::read(path).unwrap(),
                    b"preserve exact user bytes\r\n",
                    "{agent:?}"
                );
            }
            assert!(
                !data.join("agents").exists(),
                "{agent:?} created private HOME"
            );
            assert!(!data.join(JOURNAL).exists());
            match agent {
                AgentId::ClaudeCode => {
                    let value = json_file(main);
                    assert_eq!(value["env"]["ANTHROPIC_API_KEY"], "token-two");
                    assert_eq!(value["apiKeyHelper"], "user-helper");
                    assert_eq!(value["env"]["DISABLE_AUTOUPDATER"], "0");
                    assert!(value["env"]
                        .get("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC")
                        .is_none());
                    assert_eq!(value["permissions"]["deny"], json!(["Bash(rm *)"]));
                }
                AgentId::Codex => {
                    let value: toml_edit::DocumentMut =
                        std::fs::read_to_string(main).unwrap().parse().unwrap();
                    assert_eq!(value["model"].as_str(), Some("selected-second"));
                    assert_eq!(
                        value["model_providers"]["ae_switch"]["experimental_bearer_token"].as_str(),
                        Some("token-two")
                    );
                    assert!(value["model_providers"]["ae_switch"]
                        .get("env_key")
                        .is_none());
                    assert_eq!(value["model_context_window"].as_integer(), Some(765432));
                }
                AgentId::Hermes => {
                    let value = yaml(main);
                    assert_eq!(value["model"]["api_key"], "token-two");
                    assert_eq!(value["model"]["context_length"], 765432);
                    assert_eq!(value["auxiliary"]["compression"]["enabled"], false);
                    assert_eq!(value["auxiliary"]["compression"]["api_key"], "token-two");
                }
                AgentId::OhMyPi => {
                    let value = yaml(main);
                    assert_eq!(value["providers"]["ae_switch"]["apiKey"], "token-two");
                    let settings = yaml(&paths["secondary"]);
                    assert_eq!(
                        settings["modelRoles"]["default"],
                        "ae_switch/selected-second"
                    );
                    assert_eq!(settings["modelRoles"]["custom"], "user/custom");
                }
                AgentId::OpenCode => {
                    let value = json_file(main);
                    assert_eq!(
                        value["provider"]["ae_switch"]["options"]["apiKey"],
                        "token-two"
                    );
                    assert_eq!(value["permission"]["bash"], "deny");
                    assert_eq!(value["agent"]["custom"]["model"], "other/custom");
                }
                AgentId::Zcode => {
                    let value = json_file(main);
                    assert_eq!(
                        value["config"]["defaultModelSelection"]["modelId"],
                        "selected-second"
                    );
                    assert_eq!(
                        value["config"]["providerConfigRules"]["providerRules"][0]["config"]
                            ["access"]["apiKey"],
                        "token-two"
                    );
                    assert!(!paths["builtin"].exists());
                    assert_eq!(
                        json_file(&paths["state"])["builtInModelSelectionOverrides"]["Explore"]
                            ["modelId"],
                        "selected-second"
                    );
                }
                AgentId::WorkBuddy => {
                    let value = json_file(main);
                    assert_eq!(value["preferences"]["theme"], "user");
                    assert!(value["models"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|entry| entry["id"] == "selected-second"
                            && entry["apiKey"] == "token-two"));
                    assert_eq!(value["models"][0]["apiKey"], "user-key");
                }
                AgentId::DeepSeekHarness => {
                    let value = yaml(main);
                    assert_eq!(value[0]["disabled"], false);
                    assert_eq!(value[1]["config"]["context"], 765432);
                    let credentials = yaml(&paths["secondary"]);
                    assert_eq!(
                        credentials["refs"][dsh_credential_ref(&profile)],
                        "token-two"
                    );
                    assert_eq!(credentials["refs"]["USER_KEY"], "unchanged");
                    assert_eq!(
                        credentials["records"]["user/provider"]["payload"]["access"],
                        "user-oauth"
                    );
                    assert_eq!(
                        json_file(&Path::new(&profile.directory).join("package.json"))["user"],
                        "keep"
                    );
                    assert!(!Path::new(&profile.directory)
                        .join("pnpm-workspace.yaml")
                        .exists());
                }
            }
        }
    }

    #[test]
    fn existing_profile_bad_secondary_is_atomic_and_does_not_change_main_or_selection() {
        let (_temporary, data, profile) = fixture(AgentId::OhMyPi);
        let paths = configuration_paths(AgentId::OhMyPi, &profile).unwrap();
        write(&paths["config"], "providers: {}\n");
        write(&paths["secondary"], "modelRoles: [broken\n");
        let before = std::fs::read(&paths["config"]).unwrap();
        assert!(matches!(
            apply(&data, AgentId::OhMyPi, &profile, "selected", "token")
                .unwrap_err()
                .code
                .as_str(),
            "invalid_agent_configuration" | "unsupported_agent_yaml"
        ));
        assert_eq!(std::fs::read(&paths["config"]).unwrap(), before);
        assert!(!data.join("agent-selection.json").exists());
        assert!(!data.join(JOURNAL).exists());
    }

    #[test]
    fn existing_profile_interrupted_native_transaction_restores_external_files_before_selection() {
        let (_temporary, data, profile) = fixture(AgentId::OhMyPi);
        let paths = configuration_paths(AgentId::OhMyPi, &profile).unwrap();
        let after_selection = selection(AgentId::OhMyPi, &profile, "selected");
        write(&data.join("agent-selection.json"), &after_selection);
        write(&paths["config"], "after-main");
        write(&paths["secondary"], "before-secondary");
        let journal = Journal {
            agent: AgentId::OhMyPi,
            selection_before: None,
            selection_after: after_selection,
            changes: vec![
                Change {
                    slot: "config".into(),
                    before: Some("before-main".into()),
                    after: "after-main".into(),
                },
                Change {
                    slot: "secondary".into(),
                    before: Some("before-secondary".into()),
                    after: "after-secondary".into(),
                },
            ],
        };
        write(
            &data.join(JOURNAL),
            &serde_json::to_string(&journal).unwrap(),
        );
        recover(&data).unwrap();
        assert_eq!(
            std::fs::read_to_string(&paths["config"]).unwrap(),
            "before-main"
        );
        assert_eq!(
            std::fs::read_to_string(&paths["secondary"]).unwrap(),
            "before-secondary"
        );
        assert!(!data.join("agent-selection.json").exists());
        assert!(!data.join(JOURNAL).exists());
    }

    #[test]
    fn existing_profile_same_selection_partial_commit_still_restores_native_files() {
        let (_temporary, data, profile) = fixture(AgentId::OhMyPi);
        let paths = configuration_paths(AgentId::OhMyPi, &profile).unwrap();
        let same_selection = selection(AgentId::OhMyPi, &profile, "selected");
        write(&data.join("agent-selection.json"), &same_selection);
        write(&paths["config"], "after-main");
        write(&paths["secondary"], "before-secondary");
        let journal = Journal {
            agent: AgentId::OhMyPi,
            selection_before: Some(same_selection.clone()),
            selection_after: same_selection.clone(),
            changes: vec![
                Change {
                    slot: "config".into(),
                    before: Some("before-main".into()),
                    after: "after-main".into(),
                },
                Change {
                    slot: "secondary".into(),
                    before: Some("before-secondary".into()),
                    after: "after-secondary".into(),
                },
            ],
        };
        write(
            &data.join(JOURNAL),
            &serde_json::to_string(&journal).unwrap(),
        );
        recover(&data).unwrap();
        assert_eq!(
            std::fs::read_to_string(&paths["config"]).unwrap(),
            "before-main"
        );
        assert_eq!(
            std::fs::read_to_string(data.join("agent-selection.json")).unwrap(),
            same_selection
        );
        assert!(!data.join(JOURNAL).exists());
    }

    #[test]
    #[cfg(windows)]
    fn existing_profile_case_alias_targets_are_rejected_before_native_writes() {
        let (_temporary, data, mut profile) = fixture(AgentId::OhMyPi);
        let path = Path::new(&profile.directory).join("same.yml");
        write(&path, "preserve original\n");
        profile.config_file = Some(path.to_string_lossy().into());
        profile.secondary_config_file = Some(path.to_string_lossy().to_uppercase());
        assert!(apply(&data, AgentId::OhMyPi, &profile, "selected", "token").is_err());
        assert_eq!(
            std::fs::read_to_string(path).unwrap(),
            "preserve original\n"
        );
        assert!(!data.join("agent-selection.json").exists());
    }

    #[test]
    fn existing_profile_recovery_refuses_unknown_journal_slots_and_preserves_client_edits() {
        let (_temporary, data, profile) = fixture(AgentId::OhMyPi);
        let paths = configuration_paths(AgentId::OhMyPi, &profile).unwrap();
        let after_selection = selection(AgentId::OhMyPi, &profile, "selected");
        write(&data.join("agent-selection.json"), &after_selection);
        write(&paths["config"], "client-edit");
        for slot in ["../history", "config"] {
            let journal = Journal {
                agent: AgentId::OhMyPi,
                selection_before: None,
                selection_after: after_selection.clone(),
                changes: vec![Change {
                    slot: slot.into(),
                    before: Some("before".into()),
                    after: "after".into(),
                }],
            };
            write(
                &data.join(JOURNAL),
                &serde_json::to_string(&journal).unwrap(),
            );
            assert!(recover(&data).is_err());
            assert_eq!(
                std::fs::read_to_string(&paths["config"]).unwrap(),
                "client-edit"
            );
            assert_eq!(
                std::fs::read_to_string(data.join("agent-selection.json")).unwrap(),
                after_selection
            );
        }
    }

    #[test]
    fn existing_profile_dsh_rejects_invalid_credentials_without_overwriting_native_patch() {
        for credentials in [
            "version: 1\nrefs:\n  USER: ''\n",
            "USER: old-flat-schema\n",
            "version: 1\nunknown: no\n",
            "version: 1\nrecords:\n  user/provider:\n    kind: api-key\n    unknown: field\n",
        ] {
            let (_temporary, data, profile) = fixture(AgentId::DeepSeekHarness);
            let paths = configuration_paths(AgentId::DeepSeekHarness, &profile).unwrap();
            write(&paths["config"], "[]\n");
            write(&paths["secondary"], credentials);
            assert!(apply(
                &data,
                AgentId::DeepSeekHarness,
                &profile,
                "selected",
                "token"
            )
            .is_err());
            assert_eq!(std::fs::read_to_string(&paths["config"]).unwrap(), "[]\n");
            assert_eq!(
                std::fs::read_to_string(&paths["secondary"]).unwrap(),
                credentials
            );
            assert!(!data.join("agent-selection.json").exists());
        }
    }

    #[test]
    fn existing_profile_path_escape_and_duplicate_targets_are_rejected() {
        let (_temporary, data, mut profile) = fixture(AgentId::OhMyPi);
        profile.config_file = Some(
            Path::new(&profile.directory)
                .join("../history.jsonl")
                .to_string_lossy()
                .into(),
        );
        assert!(apply(&data, AgentId::OhMyPi, &profile, "selected", "token").is_err());
        profile.config_file = Some(
            Path::new(&profile.directory)
                .join("same.yml")
                .to_string_lossy()
                .into(),
        );
        profile.secondary_config_file = profile.config_file.clone();
        assert!(apply(&data, AgentId::OhMyPi, &profile, "selected", "token").is_err());
        assert!(!data.join("agent-selection.json").exists());
        profile.config_file = Some(data.join("agent-selection.json").to_string_lossy().into());
        profile.secondary_config_file = None;
        assert!(apply(&data, AgentId::OhMyPi, &profile, "selected", "token").is_err());
        assert!(!data.join("agent-selection.json").exists());
    }

    #[test]
    #[cfg(windows)]
    fn existing_profile_junction_target_is_rejected_without_touching_external_history() {
        let (temporary, data, mut profile) = fixture(AgentId::Codex);
        let external = temporary.path().join("external-history");
        let linked = Path::new(&profile.directory).join("junction");
        write(
            &external.join("config.toml"),
            "history = 'preserve exact bytes'\n",
        );
        let output = std::process::Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(&linked)
            .arg(&external)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "junction creation failed in G workspace TEMP"
        );
        profile.config_file = Some(linked.join("config.toml").to_string_lossy().into());
        assert!(apply(&data, AgentId::Codex, &profile, "selected", "token").is_err());
        assert_eq!(
            std::fs::read_to_string(external.join("config.toml")).unwrap(),
            "history = 'preserve exact bytes'\n"
        );
        assert!(!data.join("agent-selection.json").exists());
        // Remove the link itself before TempDir cleanup; never recurse through a junction.
        std::fs::remove_dir(linked).unwrap();
    }

    #[test]
    fn existing_profile_zcode_rejects_a_history_database_as_state_file() {
        let (_temporary, data, mut profile) = fixture(AgentId::Zcode);
        let history = Path::new(&profile.home_directory).join("sessions.sqlite");
        write(&history, r#"{"customState":"preserve exact user history"}"#);
        profile.state_file = Some(history.to_string_lossy().into());
        assert!(apply(&data, AgentId::Zcode, &profile, "selected", "token").is_err());
        assert_eq!(
            std::fs::read_to_string(history).unwrap(),
            r#"{"customState":"preserve exact user history"}"#
        );
        assert!(!data.join("agent-selection.json").exists());
    }

    #[test]
    fn existing_profile_opencode_jsonc_preserves_comments_and_rejects_duplicate_keys() {
        let (_temporary, data, mut profile) = fixture(AgentId::OpenCode);
        profile.config_file = Some(
            Path::new(&profile.directory)
                .join("opencode.jsonc")
                .to_string_lossy()
                .into(),
        );
        let path = Path::new(profile.config_file.as_deref().unwrap());
        let source="// 用户首行\r\n{\r\n  // 保留权限\r\n  \"permission\": {\"bash\": \"deny\",},\r\n  \"model\": \"old/model\", /* model note */\r\n  \"provider\": {\r\n    \"user\": {\"options\": {\"baseURL\": \"https://user.invalid/a//b\"}},\r\n  },\r\n}\r\n// 用户末行\r\n";
        write(path, source);
        apply(&data, AgentId::OpenCode, &profile, "selected", "token").unwrap();
        apply(&data, AgentId::OpenCode, &profile, "second", "token-two").unwrap();
        let rendered = std::fs::read_to_string(path).unwrap();
        for unchanged in [
            "// 用户首行\r\n",
            "// 保留权限\r\n",
            "/* model note */",
            "https://user.invalid/a//b",
            "// 用户末行\r\n",
        ] {
            assert!(rendered.contains(unchanged), "{unchanged}");
        }
        let value = jsonc::Document::parse(Some(&rendered), path)
            .unwrap()
            .value();
        assert_eq!(value["permission"]["bash"], "deny");
        assert_eq!(value["model"], "ae_switch/second");
        assert_eq!(
            value["provider"]["ae_switch"]["options"]["apiKey"],
            "token-two"
        );
        let selected_before = std::fs::read(data.join("agent-selection.json")).unwrap();
        let duplicated = "{/* preserve */\"model\":\"first\",\"model\":\"duplicate\",}";
        write(path, duplicated);
        assert!(apply(&data, AgentId::OpenCode, &profile, "third", "token").is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), duplicated);
        assert_eq!(
            std::fs::read(data.join("agent-selection.json")).unwrap(),
            selected_before
        );
    }

    #[test]
    fn existing_profile_opencode_inline_nested_jsonc_insertions_are_valid_and_preserve_comments() {
        for source in [
            r#"{"theme":"keep"}"#,
            r#"{/* top */"provider":{"ae_switch":{"options":{"user":"keep"}}},"theme":"keep"/* last */}"#,
            "\u{feff}{\"theme\":\"keep\", // keep trailing\r\n}\r\n",
        ] {
            let (_temporary, data, profile) = fixture(AgentId::OpenCode);
            let path = configuration_paths(AgentId::OpenCode, &profile)
                .unwrap()
                .remove("config")
                .unwrap();
            write(&path, source);
            apply(&data, AgentId::OpenCode, &profile, "selected", "token").unwrap();
            let rendered = std::fs::read_to_string(&path).unwrap();
            let value = jsonc::Document::parse(Some(&rendered), &path)
                .unwrap()
                .value();
            assert_eq!(value["theme"], "keep");
            assert_eq!(value["model"], "ae_switch/selected");
            assert_eq!(value["provider"]["ae_switch"]["options"]["apiKey"], "token");
            for comment in ["/* top */", "/* last */", "// keep trailing"] {
                if source.contains(comment) {
                    assert!(rendered.contains(comment));
                }
            }
            if source.starts_with('\u{feff}') {
                assert!(rendered.starts_with('\u{feff}'));
            }
        }
    }

    #[test]
    fn existing_profile_zcode_resolves_actual_user_project_and_env_state_without_editing_preferences(
    ) {
        let (_temporary, _data, mut profile) = fixture(AgentId::Zcode);
        profile.state_file = None;
        let home = Path::new(&profile.home_directory);
        let workspace = Path::new(&profile.workspace_directory);
        let user = home.join(".zcode/cli/config.json");
        let project = workspace.join("zcode.json");
        let project_second = workspace.join(".zcode/config.json");
        write(
            &user,
            r#"{"storage":{"dir":"~/user-storage"},"mcp":{"keep":true}}"#,
        );
        assert_eq!(
            zcode_state_path_with_environment(&profile, &BTreeMap::new()).unwrap(),
            home.join("user-storage/v2/agents-state.json")
        );
        write(&project, r#"{"storage":{"dir":"project-storage"}}"#);
        assert_eq!(
            zcode_state_path_with_environment(&profile, &BTreeMap::new()).unwrap(),
            workspace.join("project-storage/v2/agents-state.json")
        );
        write(
            &project_second,
            r#"{"storage":{"dir":"project-storage-second"}}"#,
        );
        assert_eq!(
            zcode_state_path_with_environment(&profile, &BTreeMap::new()).unwrap(),
            workspace.join("project-storage-second/v2/agents-state.json")
        );
        let environment = BTreeMap::from([("ZCODE_STORAGE_DIR".into(), "~/env-storage".into())]);
        assert_eq!(
            zcode_state_path_with_environment(&profile, &environment).unwrap(),
            home.join("env-storage/v2/agents-state.json")
        );
        let beta = BTreeMap::from([("ZCODE_BETA".into(), "1".into())]);
        assert_eq!(
            zcode_state_path_with_environment(&profile, &beta).unwrap(),
            home.join(".zcode-beta/v2/agents-state.json")
        );
        assert_eq!(
            std::fs::read_to_string(&user).unwrap(),
            r#"{"storage":{"dir":"~/user-storage"},"mcp":{"keep":true}}"#
        );
    }

    #[test]
    fn existing_profile_dsh_rejects_custom_composition_and_global_override_without_modifying_it() {
        let (_temporary, data, profile) = fixture(AgentId::DeepSeekHarness);
        let package = Path::new(&profile.directory).join("package.json");
        let custom = r#"{"dsh":{"profile":{"bundles":["user/custom"]}},"user":"keep"}"#;
        write(&package, custom);
        assert_eq!(
            apply(
                &data,
                AgentId::DeepSeekHarness,
                &profile,
                "selected",
                "token"
            )
            .unwrap_err()
            .code,
            "agent_configuration_conflict"
        );
        assert_eq!(std::fs::read_to_string(&package).unwrap(), custom);
        write(
            &package,
            r#"{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-headless"]}}}"#,
        );
        let home_patch =
            Path::new(profile.data_directory.as_deref().unwrap()).join("cordis.patch.yml");
        let overlay =
            "- id: agent-default-model\n  config:\n    provider: user\n    model: pinned\n";
        write(&home_patch, overlay);
        assert_eq!(
            apply(
                &data,
                AgentId::DeepSeekHarness,
                &profile,
                "selected",
                "token"
            )
            .unwrap_err()
            .code,
            "agent_configuration_conflict"
        );
        assert_eq!(std::fs::read_to_string(&home_patch).unwrap(), overlay);
        assert!(!data.join("agent-selection.json").exists());
        for overlay in [
            "- id: llm-pi-ai\n  config: {}\n",
            "- id: agent-default-model\n  disabled: true\n",
            "- id: credentials\n  disabled: true\n",
            "- id: credentials\n  name: user/custom-credential-plugin\n",
        ] {
            write(&home_patch, overlay);
            assert_eq!(
                apply(
                    &data,
                    AgentId::DeepSeekHarness,
                    &profile,
                    "selected",
                    "token"
                )
                .unwrap_err()
                .code,
                "agent_configuration_conflict"
            );
            assert_eq!(std::fs::read_to_string(&home_patch).unwrap(), overlay);
            assert!(!data.join("agent-selection.json").exists());
        }
    }
}
