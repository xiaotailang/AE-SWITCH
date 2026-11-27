//! Authenticated agent gateway; native APIs stream without copying whole replies.
#![forbid(unsafe_code)]
use super::*;
use crate::{agent_hub::CodexGatewaySelection, types::CodexProtocol};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    time::Instant,
};
use uuid::Uuid;

mod input_tokens;

const MAX_CODEX_TURNS: usize = 4096;
const CODEX_TURN_IDLE: Duration = Duration::from_secs(60 * 60);
const MAX_SUBAGENTS_PER_TURN: usize = 64;

#[derive(Default)]
pub(super) struct CodexTurns {
    bindings: HashMap<Uuid, CodexTurn>,
}

struct CodexTurn {
    selection: CodexGatewaySelection,
    thread: Uuid,
    model: String,
    effort: Option<String>,
    children: HashSet<Uuid>,
    touched: Instant,
}

struct CodexRequestScope {
    root_turn: Uuid,
    thread: Uuid,
    parent: Option<Uuid>,
}

enum CodexMetadata {
    Identified(CodexRequestScope),
    Malformed(Option<Uuid>),
}

fn request_scope(body: &Value) -> Option<CodexMetadata> {
    let metadata = body.get("client_metadata").and_then(Value::as_object)?;
    let uuid = |key: &str| {
        metadata
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| value.len() == 36)
            .and_then(|value| Uuid::parse_str(value).ok())
            .filter(|id| !id.is_nil())
    };
    let root = uuid("root_turn_id");
    let thread = uuid("thread_id");
    let linked = metadata.contains_key("x-openai-subagent")
        || metadata.contains_key("x-codex-parent-thread-id")
        || metadata.contains_key("parent_turn_id");
    let parent = uuid("x-codex-parent-thread-id");
    if linked && (root.is_none() || thread.is_none() || parent.is_none() || parent == thread)
        || root.is_some() && thread.is_none()
    {
        return Some(CodexMetadata::Malformed(root));
    }
    root.zip(thread).map(|(root_turn, thread)| {
        CodexMetadata::Identified(CodexRequestScope {
            root_turn,
            thread,
            parent,
        })
    })
}

impl CodexTurns {
    fn authorize(
        &mut self,
        selection: CodexGatewaySelection,
        metadata: CodexMetadata,
        model: &str,
        effort: &mut Option<String>,
        generation: bool,
    ) -> std::result::Result<(), HttpError> {
        let scope = match metadata {
            CodexMetadata::Identified(scope) => scope,
            CodexMetadata::Malformed(root) => {
                let known = root.is_some_and(|id| {
                    self.bindings
                        .get(&id)
                        .is_some_and(|turn| turn.touched.elapsed() < CODEX_TURN_IDLE)
                });
                if selection.allow_native_model_switching || known {
                    return Err(error(
                        StatusCode::BAD_REQUEST,
                        "Codex 请求的父任务或子代理关联信息不完整",
                    ));
                }
                return Ok(());
            }
        };
        let key = scope.root_turn;
        let now = Instant::now();
        if self
            .bindings
            .get(&key)
            .is_some_and(|turn| now.duration_since(turn.touched) >= CODEX_TURN_IDLE)
        {
            self.bindings.remove(&key);
        }
        let Some(turn) = self.bindings.get_mut(&key) else {
            if scope.parent.is_some() {
                return if selection.allow_native_model_switching {
                    Err(error(
                        StatusCode::CONFLICT,
                        "Codex 子代理的父任务配置未能核对，请从父任务重新开始",
                    ))
                } else {
                    Ok(())
                };
            }
            if !generation {
                return Ok(());
            }
            if self.bindings.len() >= MAX_CODEX_TURNS {
                self.bindings
                    .retain(|_, turn| now.duration_since(turn.touched) < CODEX_TURN_IDLE);
                if self.bindings.len() >= MAX_CODEX_TURNS {
                    return Err(error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Codex 路由跟踪容量已满，请稍后重试",
                    ));
                }
            }
            self.bindings.insert(
                key,
                CodexTurn {
                    selection,
                    thread: scope.thread,
                    model: model.to_owned(),
                    effort: effort.clone(),
                    children: HashSet::new(),
                    touched: now,
                },
            );
            return Ok(());
        };
        if turn.selection != selection {
            return Err(error(
                StatusCode::CONFLICT,
                "Codex 连接已重新配置，请开启新任务后继续",
            ));
        }
        let thread_matches = scope.parent.map_or(scope.thread == turn.thread, |parent| {
            scope.thread != turn.thread
                && (parent == turn.thread || turn.children.contains(&parent))
        });
        if !(thread_matches && model == turn.model)
            || effort.is_some() && effort.as_deref() != turn.effort.as_deref()
        {
            return Err(error(
                StatusCode::CONFLICT,
                "Codex 当前任务与父任务的模型或思考程度不同，请为新配置开启新任务",
            ));
        }
        if scope.parent.is_some() && !turn.children.contains(&scope.thread) {
            if turn.children.len() >= MAX_SUBAGENTS_PER_TURN {
                return Err(error(
                    StatusCode::CONFLICT,
                    "Codex 当前任务的子代理数量超出路由记录上限",
                ));
            }
            turn.children.insert(scope.thread);
        }
        if effort.is_none() {
            *effort = turn.effort.clone();
        }
        turn.touched = now;
        Ok(())
    }
}

fn equal_token(left: &str, right: &str) -> bool {
    let left = Sha256::digest(left.as_bytes());
    let right = Sha256::digest(right.as_bytes());
    left.iter()
        .zip(right.iter())
        .fold(0u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

pub(super) fn authenticated(headers: &HeaderMap, token: &str) -> bool {
    if headers.contains_key(header::ORIGIN) {
        return false;
    }
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    let api_key = headers.get("x-api-key").and_then(|h| h.to_str().ok());
    bearer
        .or(api_key)
        .is_some_and(|value| equal_token(value, token))
}

fn provider(
    runtime: &Runtime,
    headers: &HeaderMap,
    id: &str,
) -> std::result::Result<(StoredProvider, Option<CodexGatewaySelection>), HttpError> {
    if !authenticated(headers, &runtime.token) {
        return Err(error(StatusCode::UNAUTHORIZED, "Rust 接入服务认证失败"));
    }
    let store = runtime
        .store
        .lock()
        .map_err(|_| error(StatusCode::SERVICE_UNAVAILABLE, "配置服务繁忙"))?;
    crate::agent_hub::gateway_provider_with_policy(&store, id)
        .map_err(|e| error(StatusCode::NOT_FOUND, e.message))
}

fn claude_internal_alias(model: &str) -> bool {
    if matches!(model, "sonnet" | "opus" | "haiku") {
        return true;
    }
    let Some(versioned) = model.strip_prefix("claude-") else {
        return false;
    };
    let parts: Vec<_> = versioned.split('-').collect();
    parts
        .iter()
        .filter(|part| matches!(**part, "sonnet" | "opus" | "haiku"))
        .count()
        == 1
        && parts
            .iter()
            .any(|part| part.chars().any(|value| value.is_ascii_digit()))
        && parts.iter().all(|part| {
            matches!(*part, "sonnet" | "opus" | "haiku" | "latest")
                || !part.is_empty()
                    && part
                        .chars()
                        .all(|value| value.is_ascii_digit() || value == '.')
        })
}

fn enforce_selected_model(
    id: &str,
    provider: &StoredProvider,
    body: &mut Value,
    messages: bool,
) -> std::result::Result<(), HttpError> {
    if !id.starts_with("selected:") {
        return Ok(());
    }
    let requested = body["model"]
        .as_str()
        .ok_or_else(|| error(StatusCode::BAD_REQUEST, "请求缺少 model"))?;
    let selected = &provider.summary.model;
    if requested == selected {
        return Ok(());
    }
    if messages && id == "selected:claude_code" {
        let resolved = reverse::model_ids(provider)
            .into_iter()
            .find(|model| model == requested || reverse::model_alias(model) == requested);
        if resolved.as_ref() == Some(selected)
            || resolved.is_none()
                && claude_internal_alias(requested)
                && !provider
                    .summary
                    .codex_options
                    .models
                    .iter()
                    .any(|model| model.id == requested)
        {
            body["model"] = selected.clone().into();
            return Ok(());
        }
    }
    Err(error(
        StatusCode::BAD_REQUEST,
        "请求模型与该客户端已确认的模型不同，请在 AE Switch 重新选择并确认连接",
    ))
}

fn requested_codex_effort(body: &Value) -> std::result::Result<Option<String>, HttpError> {
    if body
        .get("reasoning")
        .is_some_and(|value| !value.is_null() && !value.is_object())
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Codex 请求的 reasoning 必须是对象",
        ));
    }
    let inputs = [
        body.get("reasoning_effort"),
        body.pointer("/reasoning/effort"),
    ];
    let mut result = None;
    for value in inputs
        .into_iter()
        .flatten()
        .filter(|value| !value.is_null())
    {
        let effort = value
            .as_str()
            .filter(|value| crate::types::valid_effort(value))
            .ok_or_else(|| error(StatusCode::BAD_REQUEST, "Codex 请求的思考程度无效"))?;
        if result.is_some_and(|previous| previous != effort) {
            return Err(error(
                StatusCode::BAD_REQUEST,
                "Codex 请求包含不同的思考程度",
            ));
        }
        result = Some(effort);
    }
    Ok(result.map(str::to_owned))
}

fn request_provider(
    runtime: &Runtime,
    headers: &HeaderMap,
    id: &str,
    body: &mut Value,
    resource: &str,
) -> std::result::Result<StoredProvider, HttpError> {
    let (mut provider, codex) = provider(runtime, headers, id)?;
    if codex.is_some_and(|selection| selection.allow_native_model_switching) {
        select_codex_request_model(&mut provider, body, resource == "messages")?;
    } else {
        enforce_selected_model(id, &provider, body, resource.starts_with("messages"))?;
    }
    if !matches!(resource, "messages/count_tokens" | "responses") {
        crate::context_policy::guard_request(&provider.summary, body)
            .map_err(|e| error(StatusCode::PAYLOAD_TOO_LARGE, e.message))?;
    }
    if let Some((selection, metadata)) = codex.zip(request_scope(body)) {
        runtime
            .codex_turns
            .lock()
            .map_err(|_| error(StatusCode::SERVICE_UNAVAILABLE, "Codex 路由记录暂时不可用"))?
            .authorize(
                selection,
                metadata,
                &provider.summary.model,
                &mut provider.summary.reasoning_effort,
                matches!(resource, "responses" | "chat/completions" | "messages"),
            )?;
    }
    Ok(provider)
}

fn select_codex_request_model(
    provider: &mut StoredProvider,
    body: &Value,
    translated_messages: bool,
) -> std::result::Result<(), HttpError> {
    let requested = body["model"]
        .as_str()
        .ok_or_else(|| error(StatusCode::BAD_REQUEST, "Codex 请求缺少 model"))?;
    let default = requested == provider.summary.model;
    let model = provider
        .summary
        .codex_options
        .models
        .iter()
        .find(|model| model.enabled && model.id == requested)
        .ok_or_else(|| {
            error(
                StatusCode::BAD_REQUEST,
                "请在 AE Switch 同步并启用这个 Codex 模型",
            )
        })?;
    if !default || provider.summary.reasoning_effort.is_none() {
        let explicit = requested_codex_effort(body)?;
        let converted = translated_messages
            .then(|| reverse::translated_reasoning_effort(body, requested))
            .flatten();
        if matches!((&explicit, converted), (Some(requested), Some(projected)) if requested != projected)
        {
            return Err(error(
                StatusCode::BAD_REQUEST,
                "Codex 请求包含不同的思考程度",
            ));
        }
        let effort = explicit.or_else(|| converted.map(str::to_owned));
        if effort.as_ref().is_some_and(|value| {
            !model.reasoning_efforts.is_empty() && !model.reasoning_efforts.contains(value)
        }) {
            return Err(error(
                StatusCode::BAD_REQUEST,
                "此模型不支持 Codex 请求的思考程度",
            ));
        }
        provider.summary.reasoning_effort = effort;
    }
    if !default {
        provider.summary.codex_options.applied_context_policy =
            crate::codex_switching::policy_for_model(&provider.summary, requested)
                .map_err(|e| error(StatusCode::BAD_REQUEST, e.message))?;
        provider.summary.model = requested.to_owned();
    }
    Ok(())
}

pub(super) fn apply_selected_reasoning_effort(
    provider: &StoredProvider,
    body: &mut Value,
    chat: bool,
) {
    if body["model"].as_str() != Some(provider.summary.model.as_str()) {
        return;
    }
    let Some(effort) = provider.summary.reasoning_effort.as_deref() else {
        // Default means following the client/upstream. Do not erase a client's
        // own reasoning settings or invent a default on its behalf.
        return;
    };
    if chat {
        body.as_object_mut().unwrap().remove("reasoning");
        body["reasoning_effort"] = effort.into();
    } else {
        body.as_object_mut().unwrap().remove("reasoning_effort");
        if !body["reasoning"].is_object() {
            body["reasoning"] = json!({});
        }
        body["reasoning"]["effort"] = effort.into();
    }
}

fn suppress_paid_context_beta(provider: &StoredProvider) -> bool {
    let Some(policy) = provider
        .summary
        .codex_options
        .applied_context_policy
        .as_ref()
    else {
        return false;
    };
    if policy.long_context_enabled {
        return false;
    }
    provider
        .summary
        .codex_options
        .models
        .iter()
        .find(|model| model.id == policy.model)
        .and_then(|model| {
            crate::context_policy::capabilities(model, &provider.summary.base_url)
                .ok()
                .flatten()
        })
        .is_some_and(|limits| crate::context_policy::long_context_available(&limits))
}

async fn forward(
    runtime: Runtime,
    provider: StoredProvider,
    headers: HeaderMap,
    resource: &str,
    mut body: Value,
    selected: bool,
    allow_chat_fallback: bool,
) -> std::result::Result<Response, HttpError> {
    validate_model(&provider, &body)?;
    if selected && matches!(resource, "responses" | "chat/completions") {
        apply_selected_reasoning_effort(&provider, &mut body, resource == "chat/completions");
    }
    let mut request = runtime
        .client
        .post(provider_resource_url(&provider, resource)?)
        .header("user-agent", "AE-Switch/0.1.0")
        .json(&body);
    request = if provider.summary.auth_mode == "x-api-key" {
        request.header("x-api-key", &provider.api_key)
    } else {
        request.bearer_auth(&provider.api_key)
    };
    if resource.starts_with("messages") {
        request = request.header("anthropic-version", "2023-06-01");
        let suppress = selected && suppress_paid_context_beta(&provider);
        for beta in headers.get_all("anthropic-beta").iter() {
            if !suppress {
                request = request.header("anthropic-beta", beta);
            } else if let Ok(beta) = beta.to_str() {
                let retained = beta
                    .split(',')
                    .map(str::trim)
                    .filter(|name| !name.is_empty() && !name.starts_with("context-1m-"))
                    .collect::<Vec<_>>()
                    .join(", ");
                if !retained.is_empty() {
                    request = request.header("anthropic-beta", retained);
                }
            }
        }
    }
    let response = tokio::time::timeout(UPSTREAM_HEADERS_WAIT, request.send())
        .await
        .map_err(|_| error(StatusCode::GATEWAY_TIMEOUT, "上游响应超时"))?
        .map_err(|_| {
            error(
                StatusCode::BAD_GATEWAY,
                "无法连接上游端点，请检查网络、代理和地址",
            )
        })?;
    let status =
        StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    if allow_chat_fallback && resource == "responses" && matches!(status.as_u16(), 404 | 405 | 501)
    {
        drop(response);
        return responses_via_chat(runtime, provider, body).await;
    }
    if !status.is_success() {
        let value = read_json(response).await.unwrap_or(Value::Null);
        let message = value
            .pointer("/error/message")
            .and_then(Value::as_str)
            .or_else(|| value["message"].as_str())
            .unwrap_or("上游拒绝请求");
        return Err(error(
            status,
            format!(
                "上游 HTTP {}：{}",
                status.as_u16(),
                redact(message, &provider.api_key)
            ),
        ));
    }
    if body["stream"] != true {
        let mut direct = (status, Json(read_json(response).await?)).into_response();
        direct
            .extensions_mut()
            .insert(activity::DirectUpstreamMetadata);
        return Ok(direct);
    }
    if !response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .is_some_and(|value| value.starts_with("text/event-stream"))
    {
        return Err(error(StatusCode::BAD_GATEWAY, "上游未返回所请求的 SSE 流"));
    }
    let output = async_stream::stream! {
        let mut upstream = response.bytes_stream();
        let mut total = 0usize;
        loop {
            match tokio::time::timeout(UPSTREAM_BODY_IDLE, upstream.next()).await {
                Ok(Some(Ok(chunk))) => {
                    total = total.saturating_add(chunk.len());
                    if total > 32 * 1024 * 1024 { yield Err(std::io::Error::other("Upstream stream size limit exceeded")); break; }
                    yield Ok(chunk);
                },
                Ok(None) => break,
                Ok(Some(Err(_))) => { yield Err(std::io::Error::other("Upstream stream interrupted")); break; },
                Err(_) => { yield Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "Upstream stream timed out")); break; },
            }
        }
    };
    let mut direct = (
        [
            (header::CONTENT_TYPE, "text/event-stream"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        Body::from_stream(output),
    )
        .into_response();
    direct
        .extensions_mut()
        .insert(activity::DirectUpstreamMetadata);
    Ok(direct)
}

pub(super) async fn responses(
    State(runtime): State<Runtime>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(mut body): Json<Value>,
) -> std::result::Result<Response, HttpError> {
    let provider = request_provider(&runtime, &headers, &id, &mut body, "responses")?;
    let selected = id.starts_with("selected:");
    let mut counted = false;
    if let Err(failure) = crate::context_policy::guard_request(&provider.summary, &body) {
        if id != "selected:codex" || failure.code != "context_policy_limit" {
            return Err(error(StatusCode::PAYLOAD_TOO_LARGE, failure.message));
        }
        apply_selected_reasoning_effort(&provider, &mut body, false);
        if !input_tokens::authorize(&runtime, &provider, &mut body).await {
            return Err((
                StatusCode::PAYLOAD_TOO_LARGE,
                Json(json!({"error":{
                    "type":"uni_switch_bridge_error",
                    "code":"context_policy_limit",
                    "message":"当前请求超出保守上下文上限，且同一端点未确认符合 Token 限额。请先压缩会话或使用具备 Responses 输入计数的端点"
                }})),
            ));
        }
        counted = true;
    }
    let trace = runtime.activity.begin(&id, &provider, &body, "responses");
    let result = if provider.summary.upstream_protocol() == CodexProtocol::Anthropic {
        super::responses_with_provider(runtime, provider, body).await
    } else {
        forward(
            runtime,
            provider,
            headers,
            "responses",
            body,
            selected,
            !counted,
        )
        .await
    };
    activity::observe(trace, result)
}

pub(super) async fn compact(
    State(runtime): State<Runtime>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(mut body): Json<Value>,
) -> std::result::Result<Response, HttpError> {
    let provider = request_provider(&runtime, &headers, &id, &mut body, "responses/compact")?;
    let trace = runtime
        .activity
        .begin(&id, &provider, &body, "responses/compact");
    let result = if provider.summary.upstream_protocol() == CodexProtocol::Anthropic {
        super::compact_with_provider(runtime, provider, body)
            .await
            .map(IntoResponse::into_response)
    } else {
        forward(
            runtime,
            provider,
            headers,
            "responses/compact",
            body,
            id.starts_with("selected:"),
            false,
        )
        .await
    };
    activity::observe(trace, result)
}

pub(super) async fn messages(
    State(runtime): State<Runtime>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(mut body): Json<Value>,
) -> std::result::Result<Response, HttpError> {
    let provider = request_provider(&runtime, &headers, &id, &mut body, "messages")?;
    let trace = runtime.activity.begin(&id, &provider, &body, "messages");
    let result = if provider.summary.upstream_protocol() == CodexProtocol::Openai {
        reverse_http::messages_with_provider(runtime, provider, body, id.starts_with("selected:"))
            .await
    } else {
        forward(
            runtime,
            provider,
            headers,
            "messages",
            body,
            id.starts_with("selected:"),
            false,
        )
        .await
    };
    activity::observe(trace, result)
}

pub(super) async fn count_tokens(
    State(runtime): State<Runtime>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(mut body): Json<Value>,
) -> std::result::Result<Response, HttpError> {
    let provider = request_provider(&runtime, &headers, &id, &mut body, "messages/count_tokens")?;
    let trace = runtime
        .activity
        .begin(&id, &provider, &body, "messages/count_tokens");
    let result = if provider.summary.upstream_protocol() == CodexProtocol::Openai {
        reverse_http::count_tokens_with_provider(provider, body)
    } else {
        forward(
            runtime,
            provider,
            headers,
            "messages/count_tokens",
            body,
            id.starts_with("selected:"),
            false,
        )
        .await
    };
    activity::observe(trace, result)
}

pub(super) async fn models(
    State(runtime): State<Runtime>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> std::result::Result<Json<Value>, HttpError> {
    let (provider, codex) = provider(&runtime, &headers, &id)?;
    let mut ids = vec![provider.summary.model.as_str()];
    if !id.starts_with("selected:")
        || codex.is_some_and(|selection| selection.allow_native_model_switching)
    {
        ids.extend(
            provider
                .summary
                .codex_options
                .models
                .iter()
                .filter(|m| m.enabled && m.id != provider.summary.model)
                .map(|m| m.id.as_str()),
        );
    }
    Ok(Json(
        json!({"object":"list","data":ids.iter().map(|id| json!({"id":id,"object":"model","owned_by":"configured-upstream"})).collect::<Vec<_>>()}),
    ))
}

fn chat_to_responses(body: &Value) -> std::result::Result<Value, String> {
    let messages = body["messages"]
        .as_array()
        .ok_or("messages must be an array")?;
    let mut input = Vec::new();
    for message in messages {
        let role = message["role"]
            .as_str()
            .ok_or("Each message must have a role")?;
        if role == "tool" {
            let id = message["tool_call_id"]
                .as_str()
                .ok_or("Tool result is missing tool_call_id")?;
            input.push(
                json!({"type":"function_call_output","call_id":id,"output":message["content"]}),
            );
            continue;
        }
        if !message["content"].is_null() {
            let content = if let Some(blocks) = message["content"].as_array() {
                let mut content = Vec::new();
                for block in blocks {
                    match block["type"].as_str() {
                        Some("text") => content.push(json!({"type":if role == "assistant" {"output_text"} else {"input_text"},"text":block["text"]})),
                        Some("image_url") => content.push(json!({"type":"input_image","image_url":block.pointer("/image_url/url").ok_or("Image is missing URL")?})),
                        _ => return Err("Unsupported chat content block".into()),
                    }
                }
                json!(content)
            } else {
                message["content"].clone()
            };
            input.push(
                json!({"role":if role == "system" {"developer"} else {role},"content":content}),
            );
        }
        if let Some(calls) = message["tool_calls"].as_array() {
            for call in calls {
                input.push(json!({"type":"function_call","call_id":call["id"],"name":call["function"]["name"],"arguments":call["function"]["arguments"]}));
            }
        }
    }
    let mut tools = Vec::new();
    if let Some(source) = body.get("tools") {
        for tool in source.as_array().ok_or("tools must be an array")? {
            if tool["type"] != "function"
                || !tool["function"].is_object()
                || !tool["function"]["name"].is_string()
            {
                return Err("Invalid function tool declaration".into());
            }
            let mut value = tool["function"].clone();
            value["type"] = json!("function");
            tools.push(value);
        }
    }
    let mut result =
        json!({"model":body["model"],"input":input,"tools":tools,"stream":body["stream"] == true});
    for name in ["temperature", "top_p", "parallel_tool_calls"] {
        if let Some(value) = body.get(name) {
            result[name] = value.clone();
        }
    }
    if let Some(max) = body
        .get("max_completion_tokens")
        .or_else(|| body.get("max_tokens"))
    {
        result["max_output_tokens"] = max.clone();
    }
    if let Some(choice) = body.get("tool_choice") {
        result["tool_choice"] = if choice.is_string() {
            choice.clone()
        } else {
            json!({"type":"function","name":choice["function"]["name"]})
        };
    }
    Ok(result)
}

fn stop_reason(value: &str) -> &'static str {
    match value {
        "tool_use" => "tool_calls",
        "max_tokens" => "length",
        _ => "stop",
    }
}

pub(super) async fn chat(
    State(runtime): State<Runtime>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(mut body): Json<Value>,
) -> std::result::Result<Response, HttpError> {
    let provider = request_provider(&runtime, &headers, &id, &mut body, "chat/completions")?;
    let trace = runtime
        .activity
        .begin(&id, &provider, &body, "chat/completions");
    let result = chat_response(runtime, provider, headers, id, body).await;
    activity::observe(trace, result)
}

fn chat_usage_from_messages(usage: &Value) -> Value {
    let input = usage["input_tokens"].as_u64();
    let output = usage["output_tokens"].as_u64();
    let cached = usage["cache_read_input_tokens"].as_u64();
    let written = usage["cache_creation_input_tokens"].as_u64();
    let mut result = json!({});
    if let Some(input) = input {
        let input = input
            .saturating_add(cached.unwrap_or(0))
            .saturating_add(written.unwrap_or(0));
        result["prompt_tokens"] = input.into();
        if let Some(output) = output {
            result["total_tokens"] = input.saturating_add(output).into();
        }
    }
    if let Some(output) = output {
        result["completion_tokens"] = output.into();
    }
    if let Some(cached) = cached {
        result["prompt_tokens_details"] = json!({"cached_tokens":cached});
    }
    if let Some(written) = written {
        result["cache_creation_input_tokens"] = written.into();
    }
    result
}

async fn chat_response(
    runtime: Runtime,
    provider: StoredProvider,
    headers: HeaderMap,
    id: String,
    body: Value,
) -> std::result::Result<Response, HttpError> {
    if provider.summary.upstream_protocol() == CodexProtocol::Openai {
        return forward(
            runtime,
            provider,
            headers,
            "chat/completions",
            body,
            id.starts_with("selected:"),
            false,
        )
        .await;
    }
    validate_model(&provider, &body)?;
    let responses = chat_to_responses(&body).map_err(|e| error(StatusCode::BAD_REQUEST, e))?;
    let streaming = body["stream"] == true;
    let mut converted =
        convert::request(&responses, streaming).map_err(|e| error(StatusCode::BAD_REQUEST, e))?;
    if let Some(stop) = body.get("stop") {
        converted.body["stop_sequences"] = if stop.is_string() {
            json!([stop])
        } else {
            stop.clone()
        };
    }
    let response = upstream(&runtime, &provider, &converted.body).await?;
    let model = body["model"].as_str().unwrap_or_default().to_owned();
    let id = format!("chatcmpl-{}", uuid::Uuid::new_v4().simple());
    let created = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    if !streaming {
        let data = read_json(response).await?;
        let blocks = data["content"]
            .as_array()
            .ok_or_else(|| error(StatusCode::BAD_GATEWAY, "Claude 响应缺少 content"))?;
        let text = blocks
            .iter()
            .filter_map(|block| block["text"].as_str())
            .collect::<Vec<_>>()
            .join("");
        let tools: Vec<Value> = blocks.iter().filter(|block| block["type"] == "tool_use").map(|block| json!({"id":block["id"],"type":"function","function":{"name":block["name"],"arguments":block["input"].to_string()}})).collect();
        let mut message = json!({"role":"assistant","content":text});
        if !tools.is_empty() {
            message["tool_calls"] = json!(tools);
        }
        return Ok(Json(json!({"id":id,"object":"chat.completion","created":created,"model":model,"choices":[{"index":0,"message":message,"finish_reason":stop_reason(data["stop_reason"].as_str().unwrap_or("end_turn"))}],"usage":chat_usage_from_messages(&data["usage"])})).into_response());
    }
    if !response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .is_some_and(|t| t.starts_with("text/event-stream"))
    {
        return Err(error(StatusCode::BAD_GATEWAY, "Claude 上游未返回 SSE 流"));
    }
    let include_usage = body.pointer("/stream_options/include_usage") == Some(&Value::Bool(true));
    let output = async_stream::stream! {
        let mut chunks = response.bytes_stream();
        let mut decoder = stream::SseDecoder::default();
        let mut tool_indices = std::collections::BTreeMap::new();
        let mut finished = false;
        let mut usage = json!({});
        yield Ok::<_, Infallible>(chat_event(&id, &model, created, json!({"role":"assistant"}), Value::Null));
        'read: loop {
            let chunk = match tokio::time::timeout(UPSTREAM_BODY_IDLE, chunks.next()).await {
                Ok(Some(Ok(chunk))) => chunk,
                Ok(None) => break,
                _ => { yield Ok(Bytes::from("data: {\"error\":{\"message\":\"Upstream stream interrupted\"}}\n\n")); break; },
            };
            let events = match decoder.feed(&chunk) { Ok(events) => events, Err(_) => break };
            for event in events {
                match event["type"].as_str() {
                    Some("message_start") => {
                        if event["message"]["usage"].is_object() {
                            usage = event["message"]["usage"].clone();
                        }
                    },
                    Some("content_block_start") if event["content_block"]["type"] == "text" => {
                        if let Some(text) = event["content_block"]["text"].as_str().filter(|text|!text.is_empty()) { yield Ok(chat_event(&id,&model,created,json!({"content":text}),Value::Null)); }
                    },
                    Some("content_block_start") if event["content_block"]["type"] == "tool_use" => {
                        let index = tool_indices.len();
                        tool_indices.insert(event["index"].as_u64().unwrap_or(0), index);
                        let input = &event["content_block"]["input"];
                        let arguments = if input.as_object().is_some_and(|o| !o.is_empty()) { input.to_string() } else { String::new() };
                        yield Ok(chat_event(&id, &model, created, json!({"tool_calls":[{"index":index,"id":event["content_block"]["id"],"type":"function","function":{"name":event["content_block"]["name"],"arguments":arguments}}]}), Value::Null));
                    },
                    Some("content_block_delta") => {
                        let delta = &event["delta"];
                        if delta["type"] == "text_delta" { yield Ok(chat_event(&id, &model, created, json!({"content":delta["text"]}), Value::Null)); }
                        if delta["type"] == "input_json_delta" {
                            if let Some(index) = tool_indices.get(&event["index"].as_u64().unwrap_or(0)) { yield Ok(chat_event(&id, &model, created, json!({"tool_calls":[{"index":index,"function":{"arguments":delta["partial_json"]}}]}), Value::Null)); }
                        }
                    },
                    Some("message_delta") => {
                        if let Some(reported) = event["usage"].as_object() {
                            for key in ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] {
                                if let Some(value) = reported.get(key).and_then(Value::as_u64) {
                                    usage[key] = value.into();
                                }
                            }
                        }
                        yield Ok(chat_event(&id, &model, created, json!({}), json!(stop_reason(event["delta"]["stop_reason"].as_str().unwrap_or("end_turn")))));
                    },
                    Some("message_stop") => { finished = true; break 'read; },
                    Some("error") => { yield Ok(Bytes::from(format!("data: {}\n\n", json!({"error":{"message":"Upstream reported a stream error"}})))); break 'read; },
                    _ => {},
                }
            }
        }
        if finished {
            if include_usage { yield Ok(Bytes::from(format!("data: {}\n\n", json!({"id":id,"object":"chat.completion.chunk","created":created,"model":model,"choices":[],"usage":chat_usage_from_messages(&usage)})))); }
            yield Ok(Bytes::from("data: [DONE]\n\n"));
        }
    };
    Ok((
        [
            (header::CONTENT_TYPE, "text/event-stream"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        Body::from_stream(output),
    )
        .into_response())
}

fn chat_event(id: &str, model: &str, created: u64, delta: Value, reason: Value) -> Bytes {
    Bytes::from(format!(
        "data: {}\n\n",
        json!({"id":id,"object":"chat.completion.chunk","created":created,"model":model,"choices":[{"index":0,"delta":delta,"finish_reason":reason}]})
    ))
}

async fn responses_via_chat(
    runtime: Runtime,
    provider: StoredProvider,
    body: Value,
) -> std::result::Result<Response, HttpError> {
    let streaming = body["stream"] == true;
    let model = body["model"]
        .as_str()
        .ok_or_else(|| error(StatusCode::BAD_REQUEST, "请求缺少 model"))?
        .to_owned();
    // Reuse the tested translators so namespaces and custom tool identities survive.
    let converted =
        convert::request(&body, streaming).map_err(|e| error(StatusCode::BAD_REQUEST, e))?;
    let responses = reverse::request(&converted.body, &model, streaming)
        .map_err(|e| error(StatusCode::BAD_REQUEST, e))?;
    let mut chat =
        reverse::chat_request(&responses).map_err(|e| error(StatusCode::BAD_REQUEST, e))?;
    // The compatibility translators pass through Anthropic's thinking format.
    // Restore the exact OpenAI effort rather than round-tripping via a budget.
    if let Some(effort) = body.pointer("/reasoning/effort") {
        chat["reasoning_effort"] = effort.clone();
    }
    let response = reverse_http::send(&runtime, &provider, &chat, true).await?;
    if !response.status().is_success() {
        let status =
            StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        let body = read_json(response).await.unwrap_or(Value::Null);
        return Err(error(
            status,
            redact(
                body.pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("Chat Completions 上游拒绝请求"),
                &provider.api_key,
            ),
        ));
    }
    if !streaming {
        let body = read_json(response).await?;
        let message = reverse::response(&body, &model, true)
            .map_err(|e| error(StatusCode::BAD_GATEWAY, e))?;
        let blocks = message["content"]
            .as_array()
            .ok_or_else(|| error(StatusCode::BAD_GATEWAY, "转换响应缺少 content"))?;
        let items = blocks
            .iter()
            .map(|block| {
                convert::item(
                    block,
                    &converted.tools,
                    &format!("item_{}", uuid::Uuid::new_v4().simple()),
                )
            })
            .collect::<convert::ConversionResult<Vec<_>>>()
            .map_err(|e| error(StatusCode::BAD_GATEWAY, e))?;
        return Ok(Json(convert::response(
            &model,
            items,
            &message["usage"],
            message["stop_reason"].as_str().unwrap_or("end_turn"),
        ))
        .into_response());
    }
    if !response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .is_some_and(|t| t.starts_with("text/event-stream"))
    {
        return Err(error(StatusCode::BAD_GATEWAY, "Chat 上游未返回 SSE 流"));
    }
    let output = async_stream::stream! {
        let mut reverse = reverse::Translator::new(&model);
        let mut forward = stream::Translator::new(&model, converted.tools);
        let mut decoder = stream::SseDecoder::default();
        for event in forward.started() { yield Ok::<_, Infallible>(sse(event)); }
        let mut chunks = response.bytes_stream();
        let mut failure = None;
        'read: loop {
            match tokio::time::timeout(UPSTREAM_BODY_IDLE, chunks.next()).await {
                Ok(Some(Ok(chunk))) => match decoder.feed(&chunk) {
                    Ok(events) => for event in events {
                        match reverse.accept_chat(event) {
                            Ok(events) => for event in events { match forward.accept(event) { Ok(events) => for event in events {yield Ok(sse(event));}, Err(e) => {failure=Some(e);break 'read;} } },
                            Err(e) => {failure=Some(e);break 'read;}
                        }
                        if forward.finished {break 'read;}
                    },
                    Err(e) => {failure=Some(e);break;}
                },
                Ok(None) => {
                    match reverse.finish_chat() { Ok(events) => for event in events { match forward.accept(event) { Ok(events) => for event in events {yield Ok(sse(event));},Err(e)=>{failure=Some(e);break;} } },Err(e)=>failure=Some(e) }
                    if !forward.finished && failure.is_none() {failure=Some("Chat SSE stream ended before completion".into());}
                    break;
                },
                _ => {failure=Some("Chat SSE stream interrupted".into());break;}
            }
        }
        if let Some(message)=failure {yield Ok(sse(json!({"type":"error","error":{"type":"api_error","message":redact(&message,&provider.api_key)}})));}
    };
    Ok((
        [
            (header::CONTENT_TYPE, "text/event-stream"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        Body::from_stream(output),
    )
        .into_response())
}

#[cfg(test)]
mod tests;
