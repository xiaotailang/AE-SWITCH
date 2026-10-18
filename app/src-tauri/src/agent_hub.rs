//! Portable agent coordination. Credentials stay inside the Rust store.
#![forbid(unsafe_code)]

use crate::{
    agent_configs::{self, AgentId, ExistingProfile},
    bridge::Route,
    error::{AppError, Result},
    store::Store,
    types::StoredProvider,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

// Leave room for reasoning models to emit the marker in their visible answer.
const CONNECTION_PROBE_MAX_OUTPUT_TOKENS: u32 = 512;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Selection {
    provider_id: String,
    model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    profile: Option<ExistingProfile>,
    #[serde(default)]
    configuration_revision: u64,
    #[serde(default)]
    applied_at_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentInput {
    pub agent_id: AgentId,
    pub provider_id: String,
    pub model: Option<String>,
    pub profile: Option<ExistingProfile>,
}

pub(crate) fn existing_profile(root: &Path, agent: AgentId) -> Result<Option<ExistingProfile>> {
    Ok(selections(root)?
        .remove(agent.as_str())
        .and_then(|selection| selection.profile))
}

pub fn workbuddy_default_context(
    store: &Store,
) -> Result<(crate::restart::ExistingRestartContext, String)> {
    let selection = selections(&store.data_directory)?
        .remove(AgentId::WorkBuddy.as_str())
        .ok_or_else(|| AppError::new("not_configured", "请先配置 WorkBuddy"))?;
    store.agent_provider(&selection.provider_id)?;
    let context = selection_restart_context(&store.data_directory, AgentId::WorkBuddy, &selection)?;
    Ok((context, selection.model))
}

pub(crate) fn workbuddy_default_snapshot_matches(
    context: &crate::restart::ExistingRestartContext,
    model: &str,
    bytes: &[u8],
) -> bool {
    let Ok(mut saved) = serde_json::from_slice::<BTreeMap<String, Selection>>(bytes) else {
        return false;
    };
    saved
        .remove(AgentId::WorkBuddy.as_str())
        .is_some_and(|selection| {
            context.agent_id == AgentId::WorkBuddy
                && selection.model == model
                && selection.profile.as_ref() == Some(&context.profile)
                && selection.configuration_revision == context.configuration_revision
                && selection.applied_at_ms == context.applied_at_ms
        })
}

pub(crate) fn saved_restart_context(
    root: &Path,
    agent: AgentId,
) -> Result<crate::restart::ExistingRestartContext> {
    let selection = selections(root)?
        .remove(agent.as_str())
        .ok_or_else(|| AppError::new("not_configured", "请先保存所选既有客户端的配置"))?;
    selection_restart_context(root, agent, &selection)
}

fn selection_restart_context(
    root: &Path,
    agent: AgentId,
    selection: &Selection,
) -> Result<crate::restart::ExistingRestartContext> {
    let profile = selection.profile.clone().ok_or_else(|| {
        AppError::new(
            "restart_profile",
            "此重启入口仅支持已选择的既有客户端 profile",
        )
    })?;
    agent_configs::validate_existing_profile(agent, &profile)?;
    Ok(crate::restart::ExistingRestartContext {
        root: root.to_owned(),
        agent_id: agent,
        profile,
        configuration_revision: selection.configuration_revision,
        applied_at_ms: selection.applied_at_ms,
    })
}

pub fn restart_context(
    store: &Store,
    agent: AgentId,
) -> Result<crate::restart::ExistingRestartContext> {
    let context = saved_restart_context(&store.data_directory, agent)?;
    let selection = selections(&store.data_directory)?
        .remove(agent.as_str())
        .ok_or_else(|| AppError::new("not_configured", "请先保存配置"))?;
    store.agent_provider(&selection.provider_id)?;
    Ok(context)
}

fn selections(root: &Path) -> Result<BTreeMap<String, Selection>> {
    Ok(read_selections(root)?.0)
}

fn read_selections(root: &Path) -> Result<(BTreeMap<String, Selection>, Option<String>)> {
    let path = root.join("agent-selection.json");
    crate::portable::validate_owned_path(&path)?;
    match std::fs::read(&path) {
        Ok(bytes) => {
            let saved = serde_json::from_slice(&bytes).map_err(|_| {
                AppError::new("invalid_state", "Agent 配置状态损坏，请保留数据目录后修复")
            })?;
            let text = String::from_utf8(bytes)
                .map_err(|_| AppError::new("invalid_state", "Agent 配置状态编码损坏"))?;
            Ok((saved, Some(text)))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok((BTreeMap::new(), None)),
        Err(error) => Err(AppError::io(&path, error)),
    }
}

pub(crate) fn provider_in_use(root: &Path, provider_id: &str) -> Result<bool> {
    Ok(selections(root)?
        .values()
        .any(|selection| selection.provider_id == provider_id))
}

fn override_environment_variables(
    agent: AgentId,
    profile: &ExistingProfile,
    present: impl Fn(&str) -> bool,
) -> Vec<String> {
    // These are selectors confirmed in official clients. Values are never read here.
    let names: &[&str] = match agent {
        AgentId::ClaudeCode => &[
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
            "CLAUDE_CODE_USE_FOUNDRY",
            "CLAUDE_CODE_USE_ANTHROPIC_AWS",
            "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
            "CLAUDE_CODE_USE_MANTLE",
            "CLAUDE_CODE_USE_GATEWAY",
            "ANTHROPIC_UNIX_SOCKET",
            "CLAUDE_CODE_SUBAGENT_MODEL",
            "ANTHROPIC_SMALL_FAST_MODEL",
            "ANTHROPIC_CUSTOM_HEADERS",
        ],
        AgentId::OpenCode => &[
            "OPENCODE_CONFIG_CONTENT",
            "OPENCODE_CONFIG",
            "OPENCODE_CONFIG_DIR",
        ],
        AgentId::OhMyPi => &["OMP_PROFILE", "PI_PROFILE", "PI_CONFIG_DIR"],
        AgentId::Zcode => &[
            "ZCODE_STORAGE_DIR",
            "ZCODE_BETA",
            "ZCODE_ENV",
            "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
            "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
        ],
        AgentId::DeepSeekHarness => &["DSH_HOME"],
        AgentId::Codex | AgentId::Hermes | AgentId::WorkBuddy => &[],
    };
    let mut variables: Vec<String> = names
        .iter()
        .filter(|name| present(name))
        .map(|name| (*name).into())
        .collect();
    if agent == AgentId::DeepSeekHarness {
        let reference = agent_configs::existing_dsh_credential_ref(profile);
        if present(&reference) {
            variables.push(reference);
        }
    }
    variables
}

fn profile_warnings(
    agent: AgentId,
    profile: Option<&ExistingProfile>,
) -> (Vec<String>, Vec<String>) {
    let Some(profile) = profile else {
        return (vec![], vec![]);
    };
    let variables = override_environment_variables(
        agent,
        profile,
        crate::agent_discovery::original_environment_has,
    );
    let mut warnings = vec![];
    if !variables.is_empty() {
        warnings.push(format!("原启动环境包含可能影响模型、认证或配置路径的变量：{}。这里只检查变量名，未读取其内容；原终端中的有效值及项目/策略配置可能覆盖本次配置，请同时从原入口核对。AE 验证仅调整所启动子进程，不修改系统环境。",variables.join("、")));
    }
    if agent == AgentId::ClaudeCode {
        warnings.push("Claude Code 交互入口首次使用新的 API Key 时可能要求确认；原认证、apiKeyHelper、项目和策略设置保持不变。无界面验证成功不代表所有原入口认证弹窗已经完成。".into());
    }
    if agent == AgentId::WorkBuddy {
        warnings.push("WorkBuddy 自定义模型已写入原生模型列表；AE 仅在空白新建任务页面自动选择默认模型，已有会话保持原模型。默认选择状态与真实推理验证分别显示；CLI 验证会显式指定模型。".into());
    }
    (warnings, variables)
}

fn existing_launch_reason(agent: AgentId, profile: &ExistingProfile) -> Option<String> {
    if agent == AgentId::DeepSeekHarness {
        return Some("DeepSeek Harness headless 每次需要明确任务，请在原终端提供 task 后运行；AE 不会代写或重放任务".into());
    }
    if let Err(error) = crate::agent_runner::existing_command(agent, profile, &[], None) {
        return Some(error.message);
    }
    #[cfg(target_os = "macos")]
    return Some("请从原客户端入口或原终端启动，当前尚不支持在 macOS 打开既有客户端终端".into());
    #[cfg(target_os = "linux")]
    {
        let path = crate::agent_discovery::original_environment()
            .get("PATH")
            .cloned()
            .unwrap_or_default();
        let found = std::env::split_paths(&path).any(|directory| {
            ["gnome-terminal", "konsole", "xterm", "xfce4-terminal"]
                .iter()
                .any(|terminal| directory.join(terminal).is_file())
        });
        if !found {
            return Some("当前桌面没有可用终端程序，请从原终端启动已安装客户端".into());
        }
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    return Some("当前平台请从原客户端入口启动".into());
    #[cfg(any(windows, target_os = "linux"))]
    None
}

pub fn overview(store: &Store) -> Result<Value> {
    let saved = selections(&store.data_directory)?;
    let agents: Vec<Value> = agent_configs::definitions().into_iter().map(|definition| {
        let id = definition.id.as_str();
        let private_directory = store.data_directory.join("agents").join(id);
        let selection = saved.get(id);
        let profile = selection.and_then(|selection| selection.profile.as_ref());
        let validation = if let Some(profile) = profile { agent_configs::validate_existing_profile(definition.id, profile) } else { agent_configs::validate_launch(&store.data_directory, definition.id).map(|_| ()) };
        let configured = selection.is_some_and(|selection| store.agent_provider(&selection.provider_id).is_ok()) && validation.is_ok();
        let launch_reason=profile.and_then(|profile|existing_launch_reason(definition.id,profile));
        let (warnings,variables)=profile_warnings(definition.id,profile);
        let directory = profile.map(|profile| PathBuf::from(&profile.directory)).unwrap_or(private_directory.clone());
        let launcher = if configured { Some(profile.map(|profile| PathBuf::from(&profile.executable_path)).unwrap_or_else(|| private_directory.join(agent_configs::launcher_file_name()))) } else { None };
        json!({"id":definition.id,"name":definition.name,"description":definition.description,"protocol":definition.protocol,"configured":configured,"directory":directory,"launcher":launcher,"model":selection.map(|s| &s.model),"reasoningEffort":selection.and_then(|s| s.reasoning_effort.as_ref()),"providerId":selection.map(|s| &s.provider_id),"profile":profile,"mode":if profile.is_some(){"existing"}else{"private"},"needsRestart":configured,"configurationRevision":selection.map_or(0,|selection|selection.configuration_revision),"appliedAtMs":selection.map_or(0,|selection|selection.applied_at_ms),"canLaunch":configured&&launch_reason.is_none(),"reason":validation.err().map(|error|error.message),"launchReason":launch_reason,"warnings":warnings,"overrideEnvironmentVariables":variables})
    }).collect();
    Ok(json!({"agents":agents,"dataDirectory":store.data_directory,"bridgeHealthy":false}))
}

fn model_is_available(provider: &StoredProvider, model: &str) -> bool {
    let models = &provider.summary.codex_options.models;
    !models
        .iter()
        .any(|entry| entry.id == model && !entry.enabled)
        && (model == provider.summary.model
            || models
                .iter()
                .any(|entry| entry.id == model && entry.enabled))
}

fn selected_model(store: &Store, input: &AgentInput) -> Result<String> {
    let provider = store.agent_provider(&input.provider_id)?;
    let model = input.model.as_deref().unwrap_or(&provider.summary.model);
    if !model_is_available(&provider, model) {
        return Err(AppError::new("invalid_model", "请选择已同步并启用的模型"));
    }
    Ok(model.to_owned())
}

fn validate_reasoning_effort(
    provider: &StoredProvider,
    model: &str,
    effort: Option<&str>,
) -> Result<()> {
    let Some(effort) = effort else {
        return Ok(());
    };
    if provider.summary.upstream_protocol() != crate::types::CodexProtocol::Openai {
        return Err(AppError::new(
            "unsupported_reasoning_effort",
            "此协议尚未支持指定思考等级，请使用客户端或供应商默认设置",
        ));
    }
    if !crate::types::valid_effort(effort)
        || !provider.summary.codex_options.models.iter().any(|entry| {
            entry.enabled
                && entry.id == model
                && entry.reasoning_efforts.iter().any(|value| value == effort)
        })
    {
        return Err(AppError::new(
            "unsupported_reasoning_effort",
            "所选思考等级未在此模型的供应商能力中确认，请重新查询模型后选择",
        ));
    }
    Ok(())
}

fn selected_reasoning_effort(provider: &StoredProvider, model: &str) -> Result<Option<String>> {
    // A provider's preference belongs to its preferred model, not to every
    // enabled model selected by a different client.
    let effort = (provider.summary.model == model)
        .then(|| provider.summary.reasoning_effort.clone())
        .flatten();
    validate_reasoning_effort(provider, model, effort.as_deref())?;
    Ok(effort)
}

fn gateway_id(agent: AgentId) -> String {
    format!("selected:{}", agent.as_str())
}

pub(crate) fn gateway_provider(store: &Store, id: &str) -> Result<StoredProvider> {
    let Some(agent) = id.strip_prefix("selected:") else {
        return store.agent_provider(id);
    };
    let agent: AgentId = serde_json::from_value(Value::String(agent.into()))
        .map_err(|_| AppError::new("invalid_agent", "此 Agent 不受支持"))?;
    let saved = selections(&store.data_directory)?
        .remove(agent.as_str())
        .ok_or_else(|| AppError::new("not_configured", "请先配置此 Agent"))?;
    let mut provider = store.agent_provider(&saved.provider_id)?;
    if !model_is_available(&provider, &saved.model) {
        return Err(AppError::new(
            "invalid_model",
            "此 Agent 的所选模型已停用，请重新同步并选择模型",
        ));
    }
    // The shared provider's preferred model must not replace another Agent's selection.
    validate_reasoning_effort(&provider, &saved.model, saved.reasoning_effort.as_deref())?;
    provider.summary.model = saved.model;
    provider.summary.reasoning_effort = saved.reasoning_effort;
    Ok(provider)
}

pub fn configure(store: &Store, input: AgentInput) -> Result<Value> {
    let model = selected_model(store, &input)?;
    let reasoning_effort =
        selected_reasoning_effort(&store.agent_provider(&input.provider_id)?, &model)?;
    let profile = input
        .profile
        .as_ref()
        .map(|profile| agent_configs::prepare_existing_profile(input.agent_id, profile))
        .transpose()?;
    agent_configs::recover_configuration(&store.data_directory)?;
    let route = store.agent_route()?;
    let (mut saved, selection_before) = read_selections(&store.data_directory)?;
    let configuration_revision = saved
        .get(input.agent_id.as_str())
        .map_or(0, |selection| selection.configuration_revision)
        .checked_add(1)
        .filter(|revision| *revision <= 9_007_199_254_740_991)
        .ok_or_else(|| AppError::new("invalid_state", "配置版本计数已超出范围"))?;
    let applied_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64;
    let root_url = format!(
        "http://127.0.0.1:{}/agents/{}",
        route.port,
        gateway_id(input.agent_id)
    );
    let base = if input.agent_id == AgentId::ClaudeCode {
        root_url
    } else {
        format!("{root_url}/v1")
    };
    saved.insert(
        input.agent_id.as_str().into(),
        Selection {
            provider_id: input.provider_id.clone(),
            model: model.clone(),
            reasoning_effort: reasoning_effort.clone(),
            profile: profile.clone(),
            configuration_revision,
            applied_at_ms,
        },
    );
    let serialized = serde_json::to_string_pretty(&saved)
        .map_err(|_| AppError::new("serialization", "无法保存 Agent 配置"))?;
    let selection_path = store.data_directory.join("agent-selection.json");
    let configured = if let Some(profile) = &profile {
        agent_configs::configure_existing_with_selection(
            &store.data_directory,
            input.agent_id,
            &base,
            &route.token,
            &model,
            profile,
            (&selection_path, &serialized, selection_before.as_deref()),
        )?
    } else {
        agent_configs::configure_with_selection(
            &store.data_directory,
            input.agent_id,
            &base,
            &route.token,
            &model,
            Some((&selection_path, &serialized, selection_before.as_deref())),
        )?
    };
    let mut result = serde_json::to_value(configured)
        .map_err(|_| AppError::new("serialization", "无法读取 Agent 配置"))?;
    result["providerId"] = json!(input.provider_id);
    result["reasoningEffort"] = json!(reasoning_effort);
    result["profile"] = json!(profile);
    result["mode"] = json!(if result["profile"].is_null() {
        "private"
    } else {
        "existing"
    });
    result["needsRestart"] = json!(true);
    result["configurationRevision"] = json!(configuration_revision);
    result["appliedAtMs"] = json!(applied_at_ms);
    let launch_reason = profile
        .as_ref()
        .and_then(|profile| existing_launch_reason(input.agent_id, profile));
    let (warnings, variables) = profile_warnings(input.agent_id, profile.as_ref());
    result["canLaunch"] = json!(launch_reason.is_none());
    result["launchReason"] = json!(launch_reason);
    result["warnings"] = json!(warnings);
    result["overrideEnvironmentVariables"] = json!(variables);
    Ok(result)
}

pub struct ProbeContext {
    route: Route,
    root: PathBuf,
    model: String,
    secrets: Vec<String>,
    profile: Option<ExistingProfile>,
}

pub fn probe_context(store: &Store, input: &AgentInput) -> Result<ProbeContext> {
    let route = store.agent_route()?;
    let provider = store.agent_provider(&input.provider_id)?;
    let model = selected_model(store, input)?;
    let reasoning_effort = selected_reasoning_effort(&provider, &model)?;
    let profile = input
        .profile
        .as_ref()
        .map(|profile| agent_configs::prepare_existing_profile(input.agent_id, profile))
        .transpose()?;
    let saved = selections(&store.data_directory)?;
    if !saved.get(input.agent_id.as_str()).is_some_and(|selection| {
        selection.provider_id == input.provider_id
            && selection.model == model
            && selection.reasoning_effort == reasoning_effort
            && selection.profile == profile
    }) {
        return Err(AppError::new(
            "not_configured",
            "请先确认所选连接和模型，完成此工具的配置后再验证",
        ));
    }
    Ok(ProbeContext {
        secrets: vec![provider.api_key, route.token.clone()],
        route,
        root: store.data_directory.clone(),
        model,
        profile,
    })
}

fn sanitized(message: &str, secrets: &[String]) -> String {
    let mut message = message.to_owned();
    let mut ordered: Vec<_> = secrets.iter().filter(|secret| !secret.is_empty()).collect();
    ordered.sort_unstable_by_key(|secret| std::cmp::Reverse(secret.len()));
    for secret in ordered {
        message = message.replace(secret, "<redacted>");
    }
    message.chars().take(2000).collect()
}

pub async fn probe(context: ProbeContext, input: AgentInput) -> Result<Value> {
    let start = Instant::now();
    let mut connection = match probe_connection(
        &context.route,
        &input,
        &context.model,
        &context.secrets,
    )
    .await
    {
        Ok(result) => result,
        Err(error) => {
            json!({"ok":false,"message":sanitized(&error.message, &context.secrets),"code":error.code})
        }
    };
    connection["validationScope"] = json!("connection");
    connection["toolVerified"] = json!(false);
    connection["stage"] = json!("connection");
    connection["model"] = json!(context.model);
    connection["latencyMs"] = json!(start.elapsed().as_millis());
    if let Some(message) = connection["message"].as_str() {
        connection["message"] = json!(sanitized(message, &context.secrets));
    }
    if connection["ok"] != true {
        return Ok(connection);
    }
    let mut result = match crate::agent_verification::verify_selected(
        context.root,
        input.agent_id,
        context.model.clone(),
        context.secrets.clone(),
        context.profile,
    )
    .await
    {
        Ok(result) => result,
        Err(error) => {
            json!({"ok":false,"toolVerified":false,"stage":"tool_execution","code":error.code,"message":sanitized(&error.message, &context.secrets)})
        }
    };
    result["validationScope"] = json!("tool");
    result["ok"] = json!(result["ok"] == true && result["toolVerified"] == true);
    result["model"] = json!(context.model);
    result["latencyMs"] = json!(start.elapsed().as_millis());
    result["connectionVerified"] = json!(true);
    result["connectionEvidence"] = connection["connectionEvidence"].clone();
    Ok(result)
}

fn connection_send_error(error: reqwest::Error) -> AppError {
    if error.is_timeout() {
        AppError::new(
            "connection_timeout",
            "模型连接检测超时，请检查供应商、网络和代理后重试",
        )
    } else if error.is_connect() {
        AppError::new(
            "network",
            "无法连接本地 Rust 接入服务，请确认应用正在运行后重试",
        )
    } else {
        AppError::new("network", "检测连接失败，请检查本地服务和网络后重试")
    }
}

async fn probe_connection(
    route: &Route,
    input: &AgentInput,
    model: &str,
    secrets: &[String],
) -> Result<Value> {
    let base = format!(
        "http://127.0.0.1:{}/agents/{}/v1",
        route.port,
        gateway_id(input.agent_id)
    );
    let (resource, body) = match input.agent_id {
        AgentId::ClaudeCode => (
            "messages",
            json!({"model":model,"max_tokens":CONNECTION_PROBE_MAX_OUTPUT_TOKENS,"messages":[{"role":"user","content":"Reply with AE_SWITCH_OK only."}]}),
        ),
        AgentId::Codex => (
            "responses",
            json!({"model":model,"input":"Reply with AE_SWITCH_OK only.","max_output_tokens":CONNECTION_PROBE_MAX_OUTPUT_TOKENS,"store":false}),
        ),
        _ => (
            "chat/completions",
            json!({"model":model,"messages":[{"role":"user","content":"Reply with AE_SWITCH_OK only."}],"max_tokens":CONNECTION_PROBE_MAX_OUTPUT_TOKENS}),
        ),
    };
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|_| AppError::new("network", "无法建立检测连接"))?;
    let response = client
        .post(format!("{base}/{resource}"))
        .bearer_auth(&route.token)
        .json(&body)
        .send()
        .await
        .map_err(connection_send_error)?;
    let status = response.status();
    let mut bytes = Vec::new();
    let mut response = response;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| AppError::new("network", "检测连接中断"))?
    {
        if bytes.len() + chunk.len() > 1024 * 1024 {
            return Err(AppError::new("response_limit", "检测响应超过大小限制"));
        }
        bytes.extend_from_slice(&chunk);
    }
    let parsed = serde_json::from_slice::<Value>(&bytes);
    let json_parsed = parsed.is_ok();
    let body = parsed.unwrap_or(Value::Null);
    let text = match input.agent_id {
        AgentId::ClaudeCode => body["content"].as_array().map(|items| {
            items
                .iter()
                .filter_map(|i| i["text"].as_str())
                .collect::<Vec<_>>()
                .join(" ")
        }),
        AgentId::Codex => body["output"].as_array().map(|items| {
            items
                .iter()
                .filter_map(|i| i["content"].as_array())
                .flatten()
                .filter_map(|i| i["text"].as_str())
                .collect::<Vec<_>>()
                .join(" ")
        }),
        _ => body
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .map(str::to_owned),
    }
    .unwrap_or_default();
    let ok = status.is_success() && text.contains("AE_SWITCH_OK");
    let message = if ok {
        "已收到上游模型的真实响应".to_owned()
    } else if !status.is_success() {
        format!(
            "HTTP {}：{}",
            status.as_u16(),
            body.pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("上游拒绝请求")
        )
    } else {
        "响应未通过检测，请确认模型和协议支持".into()
    };
    Ok(json!({
        "ok":ok,"message":message,
        "connectionEvidence": connection_response_evidence(
            input.agent_id, status.as_u16(), bytes.len(), json_parsed, &body, &text, secrets,
        ),
    }))
}

fn response_value_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn response_reason(value: &Value, secrets: &[String]) -> Value {
    let Some(reason) = value.as_str() else {
        return Value::Null;
    };
    // Only known protocol labels are returned. An unexpected provider value
    // can contain private model text; neither it nor arbitrary JSON keys leave
    // the native probe. Redaction precedes the existing length bound.
    let reason = sanitized(reason, secrets);
    match reason.as_str() {
        "stop"
        | "length"
        | "tool_calls"
        | "function_call"
        | "content_filter"
        | "end_turn"
        | "max_tokens"
        | "stop_sequence"
        | "tool_use"
        | "pause_turn"
        | "refusal"
        | "model_context_window_exceeded"
        | "max_output_tokens"
        | "completed"
        | "incomplete"
        | "failed"
        | "in_progress"
        | "queued"
        | "cancelled"
        | "canceled" => json!(reason),
        _ if reason.contains("<redacted>") => json!("<redacted>"),
        _ => json!("other"),
    }
}

fn connection_response_evidence(
    agent: AgentId,
    status: u16,
    response_bytes: usize,
    json_parsed: bool,
    body: &Value,
    text: &str,
    secrets: &[String],
) -> Value {
    let (finish_reason, finish_field) = match agent {
        AgentId::ClaudeCode => (&body["stop_reason"], "stop_reason"),
        AgentId::Codex => (
            &body["incomplete_details"]["reason"],
            "incomplete_details.reason",
        ),
        _ => (
            &body["choices"][0]["finish_reason"],
            "choices[0].finish_reason",
        ),
    };
    let reasoning = if !body["choices"][0]["message"]["reasoning_content"].is_null() {
        &body["choices"][0]["message"]["reasoning_content"]
    } else {
        &body["choices"][0]["message"]["reasoning"]
    };
    json!({
        "httpStatus": status, "responseBytes": response_bytes, "jsonParsed": json_parsed,
        "responseShape": {
            "bodyType": response_value_type(body),
            "contentType": response_value_type(&body["content"]),
            "contentItems": body["content"].as_array().map(Vec::len),
            "outputType": response_value_type(&body["output"]),
            "outputItems": body["output"].as_array().map(Vec::len),
            "choicesType": response_value_type(&body["choices"]),
            "choicesCount": body["choices"].as_array().map(Vec::len),
            "firstMessageType": response_value_type(&body["choices"][0]["message"]),
            "firstContentType": response_value_type(&body["choices"][0]["message"]["content"]),
            "reasoningContentType": response_value_type(reasoning),
            "finishReasonType": response_value_type(finish_reason),
            "statusType": response_value_type(&body["status"]),
            "errorType": response_value_type(&body["error"]),
        },
        "finishReasonField": finish_field,
        "finishReason": response_reason(finish_reason, secrets),
        "responseStatus": response_reason(&body["status"], secrets),
        "textLength": text.chars().count(), "textBytes": text.len(),
        "reasoningTextLength": reasoning.as_str().map(|text| text.chars().count()),
        "markerPresent": text.contains("AE_SWITCH_OK"),
    })
}

pub fn launch(store: &Store, agent: AgentId) -> Result<()> {
    let root = &store.data_directory;
    let saved = selections(root)?
        .remove(agent.as_str())
        .ok_or_else(|| AppError::new("not_configured", "请先配置此 Agent"))?;
    if let Some(profile) = saved.profile {
        // Reopening must not mutate selection/revision or cancel pending restarts.
        return launch_existing(agent, &profile);
    }
    configure(
        store,
        AgentInput {
            agent_id: agent,
            provider_id: saved.provider_id,
            model: Some(saved.model),
            profile: None,
        },
    )?;
    let script = agent_configs::validate_launch(root, agent)?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NoExit",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(script)
            .creation_flags(0x00000010)
            .spawn()
            .map_err(|_| AppError::new("launch_failed", "无法启动 Agent 终端"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/open")
            .args(["-a", "Terminal"])
            .arg(script)
            .spawn()
            .map_err(|_| AppError::new("launch_failed", "无法启动 Agent 终端"))?;
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        // Arguments stay separate so spaces and shell metacharacters in a
        // portable directory cannot turn into terminal commands.
        for terminal in ["gnome-terminal", "konsole", "xterm", "xfce4-terminal"] {
            let separator = match terminal {
                "gnome-terminal" => "--",
                "xfce4-terminal" => "-x",
                _ => "-e",
            };
            match std::process::Command::new(terminal)
                .arg(separator)
                .arg(&script)
                .spawn()
            {
                Ok(_) => return Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err(AppError::new("launch_failed", "无法启动 Agent 终端")),
            }
        }
        Err(AppError::new(
            "terminal_missing",
            "当前桌面未提供终端程序，请执行生成的 launch.sh",
        ))
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = script;
        return Err(AppError::new(
            "unsupported_platform",
            "请手动执行便携目录中的启动脚本",
        ));
    }
    #[cfg(windows)]
    Ok(())
}

fn launch_existing(agent: AgentId, profile: &ExistingProfile) -> Result<()> {
    if agent == AgentId::DeepSeekHarness {
        return Err(AppError::new("task_required","DeepSeek Harness headless 需要明确任务，请在原终端提供 task 后运行；AE 不会代写或重放任务"));
    }
    let command = crate::agent_runner::existing_command(agent, profile, &[], None)?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut command = command;
        if agent == AgentId::WorkBuddy {
            crate::workbuddy_default::prepare_launch(profile, &mut command);
        }
        command.creation_flags(0x0000_0010);
        command
            .spawn()
            .map_err(|_| AppError::new("launch_failed", "无法启动所选已安装客户端"))?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        // CLI clients need a terminal; shell content is never built from profile fields.
        let _ = command;
        Err(AppError::new(
            "terminal_required",
            "请从原客户端入口或原终端启动，原生端点配置已生效",
        ))
    }
    #[cfg(target_os = "linux")]
    {
        for terminal in ["gnome-terminal", "konsole", "xterm", "xfce4-terminal"] {
            let mut terminal_command = std::process::Command::new(terminal);
            let separator = match terminal {
                "gnome-terminal" => "--",
                "xfce4-terminal" => "-x",
                _ => "-e",
            };
            terminal_command
                .arg(separator)
                .arg(command.get_program())
                .args(command.get_args())
                .current_dir(&profile.workspace_directory);
            for (name, value) in command.get_envs() {
                if let Some(value) = value {
                    terminal_command.env(name, value);
                } else {
                    terminal_command.env_remove(name);
                }
            }
            match terminal_command.spawn() {
                Ok(_) => return Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err(AppError::new("launch_failed", "无法启动所选已安装客户端")),
            }
        }
        Err(AppError::new(
            "terminal_missing",
            "请从原终端启动已安装客户端，当前桌面没有可用终端程序",
        ))
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        let _ = command;
        Err(AppError::new(
            "unsupported_platform",
            "请从原客户端入口启动，原生端点配置已生效",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{CodexOptions, Family, ProviderInput, Target};
    use axum::{http::StatusCode, routing::post, Json, Router};

    #[test]
    fn existing_profile_override_warning_names_follow_official_selector_precedence() {
        let profile = ExistingProfile::default();
        let claude = override_environment_variables(AgentId::ClaudeCode, &profile, |_| true);
        assert!(claude.iter().any(|name| name == "ANTHROPIC_AUTH_TOKEN"));
        assert!(claude.iter().any(|name| name == "ANTHROPIC_CUSTOM_HEADERS"));
        for overwritten in [
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
        ] {
            assert!(!claude.iter().any(|name| name == overwritten));
        }
        for agent in [AgentId::Codex, AgentId::Hermes, AgentId::WorkBuddy] {
            assert!(override_environment_variables(agent, &profile, |_| true).is_empty());
        }
        let reference = agent_configs::existing_dsh_credential_ref(&profile);
        let dsh = override_environment_variables(AgentId::DeepSeekHarness, &profile, |name| {
            name == reference
        });
        assert_eq!(dsh, vec![reference]);
        assert_eq!(
            override_environment_variables(AgentId::OpenCode, &profile, |name| name
                == "OPENCODE_CONFIG_CONTENT"),
            vec!["OPENCODE_CONFIG_CONTENT"]
        );
        assert!(
            override_environment_variables(AgentId::Zcode, &profile, |name| name == "ZCODE_MODEL"
                || name == "ZCODE_API_KEY")
            .is_empty()
        );
    }

    #[test]
    fn release_routing_disabled_current_provider_model_refuses_agent_configuration() {
        let temporary = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
        let mut store = Store::open(temporary.path().join("data")).unwrap();
        for target in [Target::Codex, Target::ClaudeDesktop, Target::ClaudeCli] {
            store
                .set_directory(
                    target,
                    temporary.path().join(target.id()).to_string_lossy().into(),
                )
                .unwrap();
        }
        store.set_bridge_route(Route {
            port: 18762,
            token: "fixture-token".into(),
        });
        let provider = store
            .save(ProviderInput {
                id: None,
                edited_context_model_ids: vec![],
                family: Family::Codex,
                name: "Disabled fixture".into(),
                base_url: "https://invalid.example/v1".into(),
                api_key: Some("fixture-key".into()),
                balance_access_token: None,
                model: "disabled-selected".into(),
                auth_mode: "bearer".into(),
                reasoning_effort: None,
                codex_options: CodexOptions {
                    models: vec![crate::types::ProviderModel {
                        id: "disabled-selected".into(),
                        context_window: None,
                        reasoning_efforts: vec![],
                        enabled: false,
                    }],
                    ..Default::default()
                },
            })
            .unwrap();
        for model in [None, Some("disabled-selected".into())] {
            let error = configure(
                &store,
                AgentInput {
                    agent_id: AgentId::Codex,
                    provider_id: provider.id.clone(),
                    model,
                    profile: None,
                },
            )
            .unwrap_err();
            assert_eq!(error.code, "invalid_model");
            assert!(!store.data_directory.join("agent-selection.json").exists());
            assert!(!store
                .data_directory
                .join("agents/codex/configuration/environment.json")
                .exists());
        }
    }

    #[test]
    fn damaged_selection_never_creates_or_changes_agent_configuration() {
        for configured_before in [false, true] {
            let temporary = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
            let mut store = Store::open(temporary.path().join("data")).unwrap();
            for target in [Target::Codex, Target::ClaudeDesktop, Target::ClaudeCli] {
                store
                    .set_directory(
                        target,
                        temporary.path().join(target.id()).to_string_lossy().into(),
                    )
                    .unwrap();
            }
            store.set_bridge_route(Route {
                port: 18762,
                token: "synthetic-local-token".into(),
            });
            let provider = store
                .save(ProviderInput {
                    id: None,
                    edited_context_model_ids: vec![],
                    family: Family::Codex,
                    name: "Synthetic configuration regression".into(),
                    base_url: "https://invalid.example/v1".into(),
                    api_key: Some("synthetic-api-key".into()),
                    balance_access_token: None,
                    model: "new-model".into(),
                    auth_mode: "bearer".into(),
                    reasoning_effort: None,
                    codex_options: CodexOptions::default(),
                })
                .unwrap();
            let agent_directory = store.data_directory.join("agents/codex");
            let files = [
                "home/.codex/config.toml",
                "configuration/environment.json",
                agent_configs::launcher_file_name(),
            ];
            let previous = configured_before.then(|| {
                agent_configs::configure(
                    &store.data_directory,
                    AgentId::Codex,
                    "http://127.0.0.1:18762/agents/previous/v1",
                    "previous-local-token",
                    "previous-model",
                )
                .unwrap();
                files
                    .iter()
                    .map(|file| std::fs::read(agent_directory.join(file)).unwrap())
                    .collect::<Vec<_>>()
            });
            let selection = store.data_directory.join("agent-selection.json");
            std::fs::write(&selection, "{damaged-selection").unwrap();

            let error = configure(
                &store,
                AgentInput {
                    agent_id: AgentId::Codex,
                    provider_id: provider.id,
                    model: None,
                    profile: None,
                },
            )
            .unwrap_err();

            assert_eq!(error.code, "invalid_state");
            assert_eq!(
                std::fs::read_to_string(selection).unwrap(),
                "{damaged-selection"
            );
            if let Some(previous) = previous {
                for (file, before) in files.iter().zip(previous) {
                    assert_eq!(std::fs::read(agent_directory.join(file)).unwrap(), before);
                }
            } else {
                assert!(!agent_directory.exists());
            }
        }
    }

    #[test]
    fn diagnostic_messages_redact_credentials_before_limiting_length() {
        let message = sanitized(
            "gateway-token api-key denied",
            &["gateway-token".into(), "api-key".into()],
        );
        assert_eq!(message, "<redacted> <redacted> denied");
        assert_eq!(sanitized(&"文".repeat(2100), &[]).chars().count(), 2000);
    }

    #[tokio::test]
    async fn upstream_rejection_never_runs_a_tool_or_reports_tool_success() {
        let app = Router::new().route(
            "/agents/selected:codex/v1/responses",
            post(|| async {
                (
                    StatusCode::UNAUTHORIZED,
                    Json(json!({"error":{"message":"rejected api-secret"}})),
                )
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let directory = tempfile::tempdir().unwrap();
        let result = probe(
            ProbeContext {
                route: Route {
                    port,
                    token: "local-secret".into(),
                },
                root: directory.path().to_owned(),
                model: "unit-test-model".into(),
                secrets: vec!["api-secret".into(), "local-secret".into()],
                profile: None,
            },
            AgentInput {
                agent_id: AgentId::Codex,
                provider_id: "provider".into(),
                model: None,
                profile: None,
            },
        )
        .await
        .unwrap();
        server.abort();
        assert_eq!(result["ok"], false);
        assert_eq!(result["toolVerified"], false);
        assert_eq!(result["validationScope"], "connection");
        assert_eq!(result["stage"], "connection");
        assert!(!result.to_string().contains("api-secret"));
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn connection_metadata_keeps_existing_protocol_text_and_http_gates() {
        let cases = [
            (
                AgentId::Zcode,
                StatusCode::OK,
                json!({"choices":[{"message":{"content":"prefix AE_SWITCH_OK suffix"},"finish_reason":"stop"}]}),
                true,
                true,
                json!("stop"),
            ),
            (
                AgentId::Zcode,
                StatusCode::OK,
                json!({"choices":[{"message":{"content":null,"reasoning_content":"AE_SWITCH_OK"},"finish_reason":"length"}]}),
                false,
                false,
                json!("length"),
            ),
            (
                AgentId::Zcode,
                StatusCode::OK,
                json!({"choices":[{"message":{"content":[{"type":"text","text":"AE_SWITCH_OK"}]},"finish_reason":"stop"}]}),
                false,
                false,
                json!("stop"),
            ),
            (
                AgentId::ClaudeCode,
                StatusCode::OK,
                json!({"content":[{"type":"text","text":"AE_SWITCH_OK"}],"stop_reason":"end_turn"}),
                true,
                true,
                json!("end_turn"),
            ),
            (
                AgentId::Codex,
                StatusCode::OK,
                json!({"output":[{"content":[{"type":"output_text","text":"AE_SWITCH_OK"}]}],"status":"completed"}),
                true,
                true,
                Value::Null,
            ),
            (
                AgentId::Zcode,
                StatusCode::UNAUTHORIZED,
                json!({"choices":[{"message":{"content":"AE_SWITCH_OK"},"finish_reason":"stop"}],"error":{"message":"denied"}}),
                false,
                true,
                json!("stop"),
            ),
        ];
        for (agent, status, body, expected_ok, expected_marker, expected_reason) in cases {
            let resource = match agent {
                AgentId::ClaudeCode => "messages",
                AgentId::Codex => "responses",
                _ => "chat/completions",
            };
            let fixture = body.clone();
            let app = Router::new().route(
                &format!("/agents/selected:{}/v1/{resource}", agent.as_str()),
                post(move |Json(request): Json<Value>| {
                    let fixture = fixture.clone();
                    async move {
                        let expected_request = match agent {
                            AgentId::ClaudeCode => json!({"model":"unit-test-model","max_tokens":512,"messages":[{"role":"user","content":"Reply with AE_SWITCH_OK only."}]}),
                            AgentId::Codex => json!({"model":"unit-test-model","input":"Reply with AE_SWITCH_OK only.","max_output_tokens":512,"store":false}),
                            _ => json!({"model":"unit-test-model","messages":[{"role":"user","content":"Reply with AE_SWITCH_OK only."}],"max_tokens":512}),
                        };
                        assert_eq!(request, expected_request);
                        (status, Json(fixture))
                    }
                }),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let result = probe_connection(
                &Route {
                    port,
                    token: "synthetic-local-token".into(),
                },
                &AgentInput {
                    agent_id: agent,
                    provider_id: "provider".into(),
                    model: None,
                    profile: None,
                },
                "unit-test-model",
                &[],
            )
            .await
            .unwrap();
            server.abort();
            let _ = server.await;
            assert_eq!(result["ok"], expected_ok);
            let evidence = &result["connectionEvidence"];
            assert_eq!(evidence["httpStatus"], status.as_u16());
            assert_eq!(evidence["jsonParsed"], true);
            assert_eq!(evidence["responseShape"]["bodyType"], "object");
            assert_eq!(evidence["markerPresent"], expected_marker);
            assert_eq!(evidence["finishReason"], expected_reason);
            if !expected_marker {
                assert_eq!(evidence["textLength"], 0);
            }
            if body
                .pointer("/choices/0/message/reasoning_content")
                .is_some()
            {
                assert_eq!(evidence["reasoningTextLength"], 12);
                assert_eq!(evidence["responseShape"]["firstContentType"], "null");
            }
            if agent == AgentId::Codex {
                assert_eq!(evidence["responseStatus"], "completed");
            }
            assert!(!evidence.to_string().contains("AE_SWITCH_OK"));
        }
    }

    #[tokio::test]
    async fn workbuddy_partial_marker_is_rejected_while_complete_marker_passes() {
        for (text, finish_reason, expected_ok) in
            [("AE_SW", "length", false), ("AE_SWITCH_OK", "stop", true)]
        {
            let body = json!({
                "choices":[{
                    "message":{"content":text,"reasoning_content":"r".repeat(263)},
                    "finish_reason":finish_reason,
                }],
            });
            let app = Router::new().route(
                "/agents/selected:workbuddy/v1/chat/completions",
                post(move |Json(request): Json<Value>| {
                    let body = body.clone();
                    async move {
                        assert_eq!(request["max_tokens"], 512);
                        Json(body)
                    }
                }),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let result = probe_connection(
                &Route {
                    port,
                    token: "synthetic-local-token".into(),
                },
                &AgentInput {
                    agent_id: AgentId::WorkBuddy,
                    provider_id: "provider".into(),
                    model: None,
                    profile: None,
                },
                "unit-test-model",
                &[],
            )
            .await
            .unwrap();
            server.abort();
            let _ = server.await;
            assert_eq!(result["ok"], expected_ok);
            let evidence = &result["connectionEvidence"];
            assert_eq!(evidence["httpStatus"], 200);
            assert_eq!(evidence["finishReason"], finish_reason);
            assert_eq!(evidence["textLength"], text.chars().count());
            assert_eq!(evidence["reasoningTextLength"], 263);
            assert_eq!(evidence["markerPresent"], expected_ok);
        }
    }

    #[tokio::test]
    async fn http_success_without_marker_returns_safe_shape_and_never_runs_tools() {
        let private_text = "CONFIDENTIAL_MODEL_REPLY synthetic-api-secret synthetic-local-secret";
        let body = json!({
            "choices":[{"message":{"content":private_text,"reasoning_content":"PRIVATE_REASONING synthetic-api-secret"},"finish_reason":"length synthetic-api-secret"}],
            "status":"synthetic-local-secret PRIVATE_STATUS_TEXT",
            "synthetic-api-secret":"PRIVATE_UNKNOWN_FIELD",
        });
        let app = Router::new().route(
            "/agents/selected:zcode/v1/chat/completions",
            post(move || {
                let body = body.clone();
                async move { Json(body) }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let directory = tempfile::tempdir().unwrap();
        let result = probe(
            ProbeContext {
                route: Route {
                    port,
                    token: "synthetic-local-secret".into(),
                },
                root: directory.path().to_owned(),
                model: "unit-test-model".into(),
                secrets: vec![
                    "synthetic-api".into(),
                    "synthetic-api-secret".into(),
                    "synthetic-local-secret".into(),
                ],
                profile: None,
            },
            AgentInput {
                agent_id: AgentId::Zcode,
                provider_id: "provider".into(),
                model: None,
                profile: None,
            },
        )
        .await
        .unwrap();
        server.abort();
        let _ = server.await;
        assert_eq!(result["ok"], false);
        assert_eq!(result["toolVerified"], false);
        assert_eq!(result["validationScope"], "connection");
        assert_eq!(result["stage"], "connection");
        let evidence = &result["connectionEvidence"];
        assert_eq!(evidence["httpStatus"], 200);
        assert_eq!(evidence["textLength"], private_text.chars().count());
        assert_eq!(evidence["textBytes"], private_text.len());
        assert_eq!(evidence["markerPresent"], false);
        assert_eq!(evidence["finishReason"], "<redacted>");
        assert_eq!(evidence["responseStatus"], "<redacted>");
        assert_eq!(evidence["responseShape"]["firstContentType"], "string");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
        let serialized = result.to_string();
        for omitted in [
            "synthetic-api",
            "synthetic-local-secret",
            "CONFIDENTIAL_MODEL_REPLY",
            "PRIVATE_REASONING",
            "PRIVATE_STATUS_TEXT",
            "PRIVATE_UNKNOWN_FIELD",
        ] {
            assert!(!serialized.contains(omitted));
        }
        assert!(serialized.len() < 2000);
    }

    #[test]
    fn response_shape_metadata_never_reflects_unknown_values_or_json_keys() {
        let secrets = vec!["api-secret".into(), "local-secret".into()];
        assert_eq!(response_reason(&json!("length"), &secrets), "length");
        assert_eq!(
            response_reason(&json!("PRIVATE_MODEL_BODY_IN_REASON"), &secrets),
            "other"
        );
        assert_eq!(
            response_reason(&json!("api-secret"), &secrets),
            "<redacted>"
        );
        assert_eq!(
            response_reason(&json!({"private":"api-secret"}), &secrets),
            Value::Null
        );
        let body = json!({
            "choices":[{"message":{"content":"文"},"finish_reason":"PRIVATE_MODEL_BODY_IN_REASON"}],
            "status":"PRIVATE_MODEL_BODY_IN_STATUS",
            "PRIVATE_UNKNOWN_JSON_KEY":"api-secret local-secret",
        });
        let evidence =
            connection_response_evidence(AgentId::Zcode, 200, 123, true, &body, "文", &secrets);
        assert_eq!(evidence["textLength"], 1);
        assert_eq!(evidence["textBytes"], 3);
        assert_eq!(evidence["finishReason"], "other");
        assert_eq!(evidence["responseStatus"], "other");
        assert!(
            !evidence.to_string().contains("PRIVATE") && !evidence.to_string().contains("secret")
        );
        let malformed = connection_response_evidence(
            AgentId::Zcode,
            200,
            20,
            false,
            &Value::Null,
            "",
            &secrets,
        );
        assert_eq!(malformed["jsonParsed"], false);
        assert_eq!(malformed["responseShape"]["bodyType"], "null");
        assert_eq!(malformed["markerPresent"], false);
        assert_eq!(malformed["finishReason"], Value::Null);
    }
}

#[cfg(test)]
mod connection_send_error_tests {
    use super::*;

    fn assert_safe(result: &AppError) {
        assert!(!result.message.contains("synthetic-local-secret"));
        assert!(!result.message.contains("127.0.0.1"));
        assert!(!result.message.contains("重启"));
    }

    #[tokio::test]
    async fn loopback_response_timeout_is_detection_timeout() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let _owned_stream = stream;
            tokio::time::sleep(Duration::from_secs(1)).await;
        });
        let error = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_millis(30))
            .build()
            .unwrap()
            .get(format!(
                "http://127.0.0.1:{port}/schema-only?token=synthetic-local-secret"
            ))
            .send()
            .await
            .unwrap_err();
        assert!(error.is_timeout());
        server.abort();
        let _ = server.await;
        let result = connection_send_error(error);
        assert_eq!(result.code, "connection_timeout");
        assert_eq!(
            result.message,
            "模型连接检测超时，请检查供应商、网络和代理后重试"
        );
        assert_safe(&result);
    }

    #[tokio::test]
    async fn loopback_connection_refusal_is_local_service_unreachable() {
        // Port zero is reserved for binding and cannot be a listening service.
        let error = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(1))
            .build()
            .unwrap()
            .get("http://127.0.0.1:0/schema-only?token=synthetic-local-secret")
            .send()
            .await
            .unwrap_err();
        assert!(error.is_connect());
        assert!(!error.is_timeout());
        let result = connection_send_error(error);
        assert_eq!(result.code, "network");
        assert_eq!(
            result.message,
            "无法连接本地 Rust 接入服务，请确认应用正在运行后重试"
        );
        assert_safe(&result);
    }

    #[tokio::test]
    async fn other_request_failure_is_neutral_and_does_not_echo_error_details() {
        let error = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get("synthetic-local-secret malformed URL")
            .send()
            .await
            .unwrap_err();
        assert!(!error.is_timeout());
        assert!(!error.is_connect());
        let result = connection_send_error(error);
        assert_eq!(result.code, "network");
        assert_eq!(result.message, "检测连接失败，请检查本地服务和网络后重试");
        assert_safe(&result);
    }
}
