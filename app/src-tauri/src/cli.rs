//! Reproducible CLI for the exact same Rust kernel used by the desktop app.
#![forbid(unsafe_code)]
use serde_json::{json, Value};
use std::{
    io::Read,
    path::Path,
    sync::{Arc, Mutex},
};
use uni_switch_lib::{
    agent_configs::{self, AgentId, ExistingProfile},
    agent_discovery::{self, InstalledAgentDiscovery},
    agent_hub::{self, AgentInput},
    bridge::{self, Route},
    error::{AppError, Result},
    portable,
    store::Store,
    supplier,
    types::*,
};

fn main() {
    let result = portable::initialize().and_then(|directory| {
        let arguments: Vec<String> = std::env::args().skip(1).collect();
        if arguments
            .first()
            .is_some_and(|command| command == "run-agent")
        {
            let id = agent(&argument(&arguments, 1, "agent-id")?)?;
            let exit = uni_switch_lib::agent_runner::run(&directory, id, &arguments[2..])?;
            std::process::exit(exit);
        }
        let runtime = tokio::runtime::Runtime::new()
            .map_err(|_| AppError::new("runtime", "无法启动 Rust 运行时"))?;
        runtime.block_on(run(directory))
    });
    if let Err(error) = result {
        eprintln!(
            "{}",
            serde_json::to_string(&error).unwrap_or_else(|_| "{\"code\":\"unknown_error\"}".into())
        );
        std::process::exit(1);
    }
}

fn argument(arguments: &[String], index: usize, name: &str) -> Result<String> {
    arguments
        .get(index)
        .cloned()
        .ok_or_else(|| AppError::new("arguments", format!("缺少参数：{name}")))
}
fn agent(value: &str) -> Result<AgentId> {
    serde_json::from_value(json!(value)).map_err(|_| AppError::new("arguments", "未知 Agent ID"))
}
fn print(value: Value) -> Result<()> {
    println!(
        "{}",
        serde_json::to_string_pretty(&value)
            .map_err(|_| AppError::new("serialization", "无法序列化输出"))?
    );
    Ok(())
}

const MAX_JSON_INPUT_BYTES: usize = 1024 * 1024;

fn json_input<T: serde::de::DeserializeOwned>(reader: impl Read) -> Result<T> {
    let mut bytes = Vec::new();
    reader
        .take((MAX_JSON_INPUT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| AppError::new("input", "无法读取 JSON 输入"))?;
    if bytes.len() > MAX_JSON_INPUT_BYTES {
        return Err(AppError::new("input_too_large", "JSON 输入超过 1 MiB"));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| AppError::new("input", "输入不是有效的 JSON，或包含不支持的字段"))
}

fn profile_input(reader: impl Read) -> Result<AgentInput> {
    let input: AgentInput = json_input(reader)?;
    if input.profile.is_none() {
        return Err(AppError::new(
            "agent_profile_required",
            "请提供已安装客户端的实际 profile；运行 detect-agents 查询候选目录",
        ));
    }
    Ok(input)
}

fn unique_profile(discovery: &InstalledAgentDiscovery, id: AgentId) -> Result<ExistingProfile> {
    if discovery.limited {
        return Err(AppError::new(
            "agent_discovery_limited",
            "客户端探测不完整，请通过 configure-profile 明确指定原目录",
        ));
    }
    let mut profiles = Vec::new();
    for profile in discovery
        .clients
        .iter()
        .filter(|client| client.agent_id == id)
        .flat_map(|client| &client.profiles)
    {
        if !profiles.contains(profile) {
            profiles.push(profile.clone());
        }
    }
    match profiles.as_slice() {
        [profile] => Ok(profile.clone()),
        [] => Err(AppError::new(
            "missing_agent",
            "未发现此客户端，请先安装或明确指定原目录",
        )),
        _ => Err(AppError::new(
            "ambiguous_agent_profile",
            "发现多个客户端目录，请通过 configure-profile 明确选择",
        )),
    }
}

async fn run(directory: std::path::PathBuf) -> Result<()> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let command = arguments.first().map(String::as_str).unwrap_or("help");
    if command == "help" || command == "--help" {
        println!("AE Switch Rust kernel\nserve\noverview\ndetect-agents\ndetect-agent-directory <agent-id> <installation-directory>\ndiscover <credentials-file>\nsave-provider (ProviderInput JSON on stdin)\nconfigure <agent-id> <provider-id> [model] (one detected existing profile required)\nconfigure-all <provider-id> [model] (detected clients only)\nconfigure-profile (AgentInput JSON with profile on stdin)\nprobe <agent-id> <provider-id> [model] (one detected existing profile required)\nprobe-profile (AgentInput JSON with profile on stdin)\nAE data remains in the portable directory. Client configuration is written only to the selected existing profile. Client programs are not bundled.");
        println!("activity <agent-id> (read the running gateway without changing configuration)");
        println!("configuration-safety <agent-id>\npreview-disconnect <agent-id>\ndisconnect-agent (agentId and previewToken JSON on stdin)");
        println!("list-config-profiles\nsave-config-profile (SaveProfileInput JSON on stdin)\npreview-config-profile <id>\napply-config-profile (id/revision/fingerprint JSON on stdin)\ndelete-config-profile <id> <revision>");
        return Ok(());
    }
    if command == "detect-agents" {
        return print(
            serde_json::to_value(agent_discovery::discover())
                .map_err(|_| AppError::new("serialization", "无法读取客户端探测结果"))?,
        );
    }
    if command == "detect-agent-directory" {
        let id = agent(&argument(&arguments, 1, "agent-id")?)?;
        let installation = argument(&arguments, 2, "installation-directory")?;
        return print(
            serde_json::to_value(agent_discovery::discover_in_directory(
                id,
                Path::new(&installation),
            )?)
            .map_err(|_| AppError::new("serialization", "无法读取安装目录识别结果"))?,
        );
    }
    if command == "activity" {
        let id = agent(&argument(&arguments, 1, "agent-id")?)?;
        return print(
            serde_json::to_value(bridge::activity::read_saved_activity(&directory, id).await?)
                .map_err(|_| AppError::new("serialization", "无法读取请求活动"))?,
        );
    }
    let mut store = Store::open(directory.clone())?;
    if command == "list-config-profiles" {
        return print(
            serde_json::to_value(uni_switch_lib::config_profiles::list(&directory)?)
                .map_err(|_| AppError::new("serialization", "无法读取配置方案"))?,
        );
    }
    if command == "save-config-profile" {
        let input: uni_switch_lib::config_profiles::SaveProfileInput =
            json_input(std::io::stdin().lock())?;
        return print(
            serde_json::to_value(uni_switch_lib::config_profiles::save(&store, input)?)
                .map_err(|_| AppError::new("serialization", "无法保存配置方案"))?,
        );
    }
    if command == "delete-config-profile" {
        let id = argument(&arguments, 1, "profile-id")?;
        let revision = argument(&arguments, 2, "revision")?
            .parse::<u64>()
            .map_err(|_| AppError::new("arguments", "方案版本必须是正整数"))?;
        uni_switch_lib::config_profiles::delete(&directory, &id, revision)?;
        return print(json!({"deleted":true}));
    }
    if matches!(command, "configuration-safety" | "preview-disconnect") {
        let id = agent(&argument(&arguments, 1, "agent-id")?)?;
        return print(
            serde_json::to_value(agent_hub::configuration_safety(&store, id)?)
                .map_err(|_| AppError::new("serialization", "无法读取配置保护状态"))?,
        );
    }
    if command == "disconnect-agent" {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct DisconnectInput {
            agent_id: AgentId,
            preview_token: String,
        }
        let input: DisconnectInput = json_input(std::io::stdin().lock())?;
        return print(agent_hub::disconnect(
            &store,
            input.agent_id,
            &input.preview_token,
        )?);
    }
    if command == "apply-workbuddy-default" {
        let (context, model) = agent_hub::workbuddy_default_context(&store)?;
        return print(
            serde_json::to_value(uni_switch_lib::workbuddy_default::apply_saved(
                context, model,
            )?)
            .map_err(|_| AppError::new("serialization", "无法读取默认模型状态"))?,
        );
    }
    let (route, listener) = Route::start(&directory)?;
    store.set_bridge_route(route.clone());
    match command {
        "preview-config-profile" => print(
            serde_json::to_value(uni_switch_lib::config_profiles::preview(
                &store,
                &argument(&arguments, 1, "profile-id")?,
            )?)
            .map_err(|_| AppError::new("serialization", "无法预览配置方案"))?,
        ),
        "apply-config-profile" => {
            let input: uni_switch_lib::config_profiles::ApplyProfileInput =
                json_input(std::io::stdin().lock())?;
            print(
                serde_json::to_value(uni_switch_lib::config_profiles::apply(&store, input)?)
                    .map_err(|_| AppError::new("serialization", "无法应用配置方案"))?,
            )
        }
        "overview" => print(
            json!({"hub":agent_hub::overview(&store)?,"providers":store.overview()?.providers}),
        ),
        "save-provider" => {
            let input: ProviderInput = json_input(std::io::stdin().lock())?;
            print(
                serde_json::to_value(store.save(input)?)
                    .map_err(|_| AppError::new("serialization", "无法读取供应商"))?,
            )
        }
        "discover" => {
            let file = std::path::PathBuf::from(argument(&arguments, 1, "credentials-file")?);
            let file = if file.is_absolute() {
                file
            } else {
                std::env::current_dir()
                    .map_err(|_| AppError::new("input", "无法读取当前目录"))?
                    .join(file)
            };
            let canonical = file
                .canonicalize()
                .map_err(|error| AppError::io(&file, error))?;
            let root = portable::root()?
                .canonicalize()
                .map_err(|_| AppError::new("input", "无法读取便携目录"))?;
            if !canonical.starts_with(root) {
                return Err(AppError::new("input", "测试凭据文件必须位于当前便携目录内"));
            }
            let (base_url, api_key) = credentials(&canonical)?;
            let result = supplier::discover_connection(&base_url, &api_key, None, None).await?;
            let model = result
                .models
                .first()
                .ok_or_else(|| AppError::new("no_models", "端点没有返回可用模型"))?
                .id
                .clone();
            let provider = store.save(ProviderInput {
                id: None,
                edited_context_model_ids: vec![],
                family: if result.protocol == CodexProtocol::Anthropic {
                    Family::Claude
                } else {
                    Family::Codex
                },
                name: "已检测端点".into(),
                base_url: result.base_url,
                api_key: Some(api_key),
                balance_access_token: None,
                model,
                auth_mode: result.auth_mode,
                reasoning_effort: None,
                codex_options: CodexOptions {
                    upstream_protocol: Some(result.protocol),
                    models: result.models,
                    models_synced_at: Some(result.synced_at),
                    ..Default::default()
                },
            })?;
            print(
                serde_json::to_value(provider)
                    .map_err(|_| AppError::new("serialization", "无法读取供应商"))?,
            )
        }
        "configure-profile" => print(agent_hub::configure(
            &store,
            profile_input(std::io::stdin().lock())?,
        )?),
        "configure" => {
            let id = agent(&argument(&arguments, 1, "agent-id")?)?;
            print(agent_hub::configure(
                &store,
                AgentInput {
                    agent_id: id,
                    provider_id: argument(&arguments, 2, "provider-id")?,
                    model: arguments.get(3).cloned(),
                    profile: Some(unique_profile(&agent_discovery::discover(), id)?),
                },
            )?)
        }
        "configure-all" => {
            let provider_id = argument(&arguments, 1, "provider-id")?;
            let discovery = agent_discovery::discover();
            // Resolve the complete target list before changing any client's files.
            let mut targets = Vec::new();
            let mut skipped = Vec::new();
            for definition in agent_configs::definitions() {
                if !discovery
                    .clients
                    .iter()
                    .any(|client| client.agent_id == definition.id)
                {
                    skipped.push(definition.id);
                    continue;
                }
                targets.push((definition.id, unique_profile(&discovery, definition.id)?));
            }
            if targets.is_empty() {
                return Err(AppError::new("missing_agent", "未发现可配置的已安装客户端"));
            }
            let mut results = Vec::new();
            for (id, profile) in targets {
                results.push(agent_hub::configure(
                    &store,
                    AgentInput {
                        agent_id: id,
                        provider_id: provider_id.clone(),
                        model: arguments.get(2).cloned(),
                        profile: Some(profile),
                    },
                )?);
            }
            print(json!({"agents":results,"notInstalled":skipped}))
        }
        "serve" => {
            print(
                json!({"status":"listening","host":"127.0.0.1","port":route.port,"dataDirectory":directory}),
            )?;
            let listener = listener
                .ok_or_else(|| AppError::new("already_running", "Rust 接入服务已在运行"))?;
            bridge::serve(listener, route, Arc::new(Mutex::new(store))).await
        }
        "probe" | "probe-profile" => {
            let input = if command == "probe-profile" {
                profile_input(std::io::stdin().lock())?
            } else {
                let id = agent(&argument(&arguments, 1, "agent-id")?)?;
                AgentInput {
                    agent_id: id,
                    provider_id: argument(&arguments, 2, "provider-id")?,
                    model: arguments.get(3).cloned(),
                    profile: Some(unique_profile(&agent_discovery::discover(), id)?),
                }
            };
            let context = agent_hub::probe_context(&store, &input)?;
            let listener = listener.ok_or_else(|| {
                AppError::new("already_running", "请在已运行的桌面应用中检测连接")
            })?;
            let task = tokio::spawn(bridge::serve(
                listener,
                route.clone(),
                Arc::new(Mutex::new(store)),
            ));
            let result = agent_hub::probe(context, input).await;
            task.abort();
            let result = result?;
            print(result.clone())?;
            if result["ok"] != true {
                return Err(AppError::new(
                    "probe_failed",
                    "真实工具验证失败；详见上方脱敏结果",
                ));
            }
            Ok(())
        }
        _ => Err(AppError::new(
            "arguments",
            "未知命令；运行 ae-switch-cli --help 查看用法",
        )),
    }
}

fn credentials(file: &Path) -> Result<(String, String)> {
    let text = std::fs::read_to_string(file).map_err(|error| AppError::io(file, error))?;
    let mut base = None;
    let mut key = None;
    for line in text.lines() {
        if let Some(value) = line
            .trim()
            .strip_prefix("端点：")
            .or_else(|| line.trim().strip_prefix("端点:"))
        {
            base = Some(value.trim().to_owned());
        }
        if let Some(value) = line
            .trim()
            .strip_prefix("api-key:")
            .or_else(|| line.trim().strip_prefix("api-key："))
        {
            key = Some(value.trim().to_owned());
        }
    }
    Ok((
        base.ok_or_else(|| AppError::new("input", "凭据文件缺少端点地址"))?,
        key.ok_or_else(|| AppError::new("input", "凭据文件缺少 API key"))?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use uni_switch_lib::agent_discovery::InstalledAgentClient;

    fn input() -> Value {
        json!({"agentId":"codex","providerId":"test-provider","model":"test-model",
            "profile":{"directory":"/existing/.codex","homeDirectory":"/existing",
                "executablePath":"/existing/bin/codex","workspaceDirectory":"/existing/project"}})
    }

    #[test]
    fn profile_cli_keeps_the_exact_selected_existing_paths() {
        let value = input();
        let parsed = profile_input(serde_json::to_vec(&value).unwrap().as_slice()).unwrap();
        let profile = parsed.profile.unwrap();
        assert_eq!(profile.directory, "/existing/.codex");
        assert_eq!(profile.home_directory, "/existing");
        assert_eq!(profile.executable_path, "/existing/bin/codex");
        assert_eq!(parsed.model.as_deref(), Some("test-model"));
    }

    #[test]
    fn profile_cli_rejects_missing_profile_and_unknown_fields() {
        let mut value = input();
        value.as_object_mut().unwrap().remove("profile");
        assert_eq!(
            profile_input(serde_json::to_vec(&value).unwrap().as_slice())
                .unwrap_err()
                .code,
            "agent_profile_required"
        );
        let mut value = input();
        value["profile"]["unexpectedCredential"] = json!("secret-not-for-error-output");
        let error = profile_input(serde_json::to_vec(&value).unwrap().as_slice()).unwrap_err();
        assert_eq!(error.code, "input");
        assert!(!error.message.contains("secret-not-for-error-output"));
    }

    #[test]
    fn cli_rejects_oversized_json_even_with_a_valid_prefix() {
        let mut bytes = serde_json::to_vec(&input()).unwrap();
        bytes.resize(MAX_JSON_INPUT_BYTES + 1, b' ');
        assert_eq!(
            profile_input(bytes.as_slice()).unwrap_err().code,
            "input_too_large"
        );
        bytes.pop();
        assert!(profile_input(bytes.as_slice()).is_ok());
    }

    #[test]
    fn automatic_cli_requires_one_complete_unambiguous_installed_profile() {
        let profile: ExistingProfile = serde_json::from_value(input()["profile"].clone()).unwrap();
        let mut discovery = InstalledAgentDiscovery {
            clients: vec![],
            scanned_at: "0".into(),
            limited: false,
            notes: vec![],
        };
        assert_eq!(
            unique_profile(&discovery, AgentId::Codex).unwrap_err().code,
            "missing_agent"
        );
        let client = InstalledAgentClient {
            agent_id: AgentId::Codex,
            executable_path: profile.executable_path.clone(),
            profiles: vec![profile.clone()],
            source: "fixture".into(),
            reason: None,
        };
        discovery.clients.push(client.clone());
        discovery.clients.push(client);
        assert_eq!(unique_profile(&discovery, AgentId::Codex).unwrap(), profile);
        discovery.limited = true;
        assert_eq!(
            unique_profile(&discovery, AgentId::Codex).unwrap_err().code,
            "agent_discovery_limited"
        );
        discovery.limited = false;
        discovery.clients[1].profiles[0].directory = "/existing/another-profile".into();
        assert_eq!(
            unique_profile(&discovery, AgentId::Codex).unwrap_err().code,
            "ambiguous_agent_profile"
        );
    }
}
