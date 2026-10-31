//! Bounded, memory-only diagnostics for selected agents. Never retain content,
//! credentials, headers, upstream messages, URLs, or client paths.
use super::*;
use crate::agent_configs::AgentId;
use std::{collections::VecDeque, time::Instant};

pub const CAPACITY: usize = 200;
const FRAME_LIMIT: usize = 64 * 1024;
const MAX_NUMBER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Default)]
pub(super) struct ActivityLog(Arc<Mutex<VecDeque<RequestActivity>>>);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestActivity {
    pub id: String,
    pub agent_id: AgentId,
    pub started_at: u64,
    pub model: Option<String>,
    pub endpoint: String,
    pub upstream_protocol: String,
    pub streaming: bool,
    pub state: String,
    pub status: Option<u16>,
    pub elapsed_ms: Option<u64>,
    pub first_byte_ms: Option<u64>,
    pub response_bytes: u64,
    pub usage: TokenUsage,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cached_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySnapshot {
    pub capacity: usize,
    pub records: Vec<RequestActivity>,
}

impl ActivityLog {
    pub(super) fn begin(
        &self,
        id: &str,
        provider: &StoredProvider,
        body: &Value,
        endpoint: &str,
    ) -> Option<RequestTrace> {
        let agent = serde_json::from_value::<AgentId>(json!(id.strip_prefix("selected:")?)).ok()?;
        let ids = reverse::model_ids(provider);
        let model = body["model"]
            .as_str()
            .filter(|model| model.len() <= 256 && ids.iter().any(|id| id == model))
            .map(str::to_owned);
        let record = RequestActivity {
            id: uuid::Uuid::new_v4().simple().to_string(),
            agent_id: agent,
            started_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .min(MAX_NUMBER as u128) as u64,
            model,
            endpoint: endpoint.into(),
            upstream_protocol: match provider.summary.upstream_protocol() {
                crate::types::CodexProtocol::Openai => "openai",
                crate::types::CodexProtocol::Anthropic => "anthropic",
            }
            .into(),
            streaming: body["stream"] == true,
            state: "in_progress".into(),
            status: None,
            elapsed_ms: None,
            first_byte_ms: None,
            response_bytes: 0,
            usage: TokenUsage::default(),
        };
        let mut records = self.0.lock().unwrap_or_else(|error| error.into_inner());
        while records.len() >= CAPACITY {
            records.pop_front();
        }
        records.push_back(record.clone());
        Some(RequestTrace {
            log: self.clone(),
            record,
            started: Instant::now(),
            finished: false,
        })
    }

    fn snapshot(&self, agent: AgentId, clear: bool) -> ActivitySnapshot {
        let mut records = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if clear {
            records.retain(|record| record.agent_id != agent);
        }
        ActivitySnapshot {
            capacity: CAPACITY,
            records: records
                .iter()
                .rev()
                .filter(|record| record.agent_id == agent)
                .cloned()
                .collect(),
        }
    }
}

pub(super) struct RequestTrace {
    log: ActivityLog,
    record: RequestActivity,
    started: Instant,
    finished: bool,
}

impl RequestTrace {
    fn update(&self) {
        let mut records = self.log.0.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(record) = records
            .iter_mut()
            .find(|record| record.id == self.record.id)
        {
            *record = self.record.clone();
        }
        // A cleared or evicted request must never reappear when it finishes.
    }

    fn finish(&mut self, state: &str) {
        self.record.state = state.into();
        self.record.elapsed_ms =
            Some(self.started.elapsed().as_millis().min(MAX_NUMBER as u128) as u64);
        self.finished = true;
        self.update();
    }
}

impl Drop for RequestTrace {
    fn drop(&mut self) {
        if !self.finished {
            self.finish("cancelled");
        }
    }
}

pub(super) fn observe(
    trace: Option<RequestTrace>,
    result: std::result::Result<Response, HttpError>,
) -> std::result::Result<Response, HttpError> {
    let Some(mut trace) = trace else {
        return result;
    };
    let response = match result {
        Ok(response) => response,
        Err(error) => {
            trace.record.status = Some(error.0.as_u16());
            trace.finish("failed");
            return Err(error);
        }
    };
    trace.record.status = Some(response.status().as_u16());
    trace.update();
    let sse = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("text/event-stream"));
    let (parts, body) = response.into_parts();
    let output = async_stream::stream! {
        let mut metadata = ResponseMetadata::new(sse);
        let mut stream = body.into_data_stream();
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(bytes) => {
                    if !bytes.is_empty() && trace.record.first_byte_ms.is_none() {
                        trace.record.first_byte_ms = Some(trace.started.elapsed().as_millis().min(MAX_NUMBER as u128) as u64);
                        trace.update();
                    }
                    trace.record.response_bytes = trace.record.response_bytes.saturating_add(bytes.len() as u64).min(MAX_NUMBER);
                    metadata.push(&bytes);
                    // Forward the original bytes immediately, including tools and errors.
                    yield Ok::<_, axum::Error>(bytes);
                }
                Err(error) => {
                    trace.record.usage = metadata.usage;
                    trace.finish("interrupted");
                    yield Err(error);
                    return;
                }
            }
        }
        metadata.end();
        let state = if trace.record.status.is_some_and(|status| status >= 400) || metadata.failed {
            "failed"
        } else if metadata.incomplete {
            "incomplete"
        } else if sse && !metadata.terminal {
            "interrupted"
        } else {
            "completed"
        };
        trace.record.usage = metadata.usage;
        trace.finish(state);
    };
    Ok(Response::from_parts(parts, Body::from_stream(output)))
}

/// This parser observes metadata only. Buffers are transient and bounded even
/// for an unbroken tool argument, oversized line, or malicious SSE event.
struct ResponseMetadata {
    sse: bool,
    buffer: Vec<u8>,
    oversized: bool,
    line: Vec<u8>,
    line_oversized: bool,
    usage: TokenUsage,
    terminal: bool,
    failed: bool,
    incomplete: bool,
}

impl ResponseMetadata {
    fn new(sse: bool) -> Self {
        Self {
            sse,
            buffer: Vec::new(),
            oversized: false,
            line: Vec::new(),
            line_oversized: false,
            usage: TokenUsage::default(),
            terminal: false,
            failed: false,
            incomplete: false,
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        if !self.sse {
            if !self.oversized && self.buffer.len().saturating_add(bytes.len()) <= FRAME_LIMIT {
                self.buffer.extend_from_slice(bytes);
            } else {
                self.buffer.clear();
                self.oversized = true;
            }
            return;
        }
        for &byte in bytes {
            if byte == b'\n' {
                self.line();
            } else if !self.line_oversized {
                if self.line.len() < FRAME_LIMIT {
                    self.line.push(byte);
                } else {
                    self.line.clear();
                    self.line_oversized = true;
                    self.oversized = true;
                }
            }
        }
    }

    fn line(&mut self) {
        if self.line.last() == Some(&b'\r') {
            self.line.pop();
        }
        if self.line.is_empty() && !self.line_oversized {
            self.frame();
            self.buffer.clear();
            self.oversized = false;
        } else if !self.oversized {
            if let Some(data) = self.line.strip_prefix(b"data:") {
                let data = data.strip_prefix(b" ").unwrap_or(data);
                if self.buffer.len().saturating_add(data.len() + 1) <= FRAME_LIMIT {
                    if !self.buffer.is_empty() {
                        self.buffer.push(b'\n');
                    }
                    self.buffer.extend_from_slice(data);
                } else {
                    self.buffer.clear();
                    self.oversized = true;
                }
            }
        }
        self.line.clear();
        self.line_oversized = false;
    }

    fn end(&mut self) {
        if self.sse {
            // SSE dispatches only on a blank line. An unfinished final frame
            // cannot prove completion, even if its JSON happens to parse.
            return;
        }
        self.frame();
    }

    fn frame(&mut self) {
        if self.oversized {
            return;
        }
        if self.sse && self.buffer == b"[DONE]" {
            self.terminal = true;
            return;
        }
        let Ok(value) = serde_json::from_slice::<Value>(&self.buffer) else {
            return;
        };
        let kind = value["type"].as_str().unwrap_or_default();
        self.failed |= kind == "error"
            || kind == "response.failed"
            || value["error"].is_object()
            || value["error"].is_string()
            || value["status"] == "failed"
            || value["response"]["status"] == "failed";
        self.incomplete |= kind == "response.incomplete"
            || value["status"] == "incomplete"
            || value["response"]["status"] == "incomplete"
            || value["stop_reason"] == "max_tokens"
            || value["delta"]["stop_reason"] == "max_tokens"
            || value["choices"].as_array().is_some_and(|choices| {
                choices
                    .iter()
                    .any(|choice| choice["finish_reason"] == "length")
            });
        self.terminal |= matches!(kind, "message_stop" | "response.completed")
            || value["choices"].as_array().is_some_and(|choices| {
                choices
                    .iter()
                    .any(|choice| choice["finish_reason"].is_string())
            });
        for usage in [
            &value["usage"],
            &value["message"]["usage"],
            &value["response"]["usage"],
        ] {
            self.usage.read(usage);
        }
    }
}

impl TokenUsage {
    fn read(&mut self, usage: &Value) {
        fn number(value: &Value) -> Option<u64> {
            value.as_u64().filter(|value| *value <= MAX_NUMBER)
        }
        fn merge(target: &mut Option<u64>, incoming: Option<u64>) {
            if let Some(value) = incoming {
                *target = Some(target.unwrap_or(0).max(value));
            }
        }
        let input = number(&usage["input_tokens"]).or_else(|| number(&usage["prompt_tokens"]));
        // Anthropic input_tokens excludes cached/created tokens; OpenAI includes them.
        let input = input.and_then(|input| {
            input
                .checked_add(number(&usage["cache_read_input_tokens"]).unwrap_or(0))?
                .checked_add(number(&usage["cache_creation_input_tokens"]).unwrap_or(0))
                .filter(|total| *total <= MAX_NUMBER)
        });
        merge(&mut self.input_tokens, input);
        merge(
            &mut self.output_tokens,
            number(&usage["output_tokens"]).or_else(|| number(&usage["completion_tokens"])),
        );
        merge(
            &mut self.cached_tokens,
            number(&usage["cache_read_input_tokens"])
                .or_else(|| number(&usage["input_tokens_details"]["cached_tokens"]))
                .or_else(|| number(&usage["prompt_tokens_details"]["cached_tokens"])),
        );
        merge(
            &mut self.reasoning_tokens,
            number(&usage["output_tokens_details"]["reasoning_tokens"])
                .or_else(|| number(&usage["completion_tokens_details"]["reasoning_tokens"])),
        );
    }
}

async fn activity_endpoint(
    State(runtime): State<Runtime>,
    Path(agent): Path<String>,
    headers: HeaderMap,
    method: axum::http::Method,
) -> std::result::Result<Json<ActivitySnapshot>, HttpError> {
    if !agent_http::authenticated(&headers, &runtime.token) {
        return Err(error(StatusCode::UNAUTHORIZED, "Rust 接入服务认证失败"));
    }
    let agent = serde_json::from_value::<AgentId>(json!(agent))
        .map_err(|_| error(StatusCode::BAD_REQUEST, "此 Agent 不受支持"))?;
    Ok(Json(
        runtime
            .activity
            .snapshot(agent, method == axum::http::Method::DELETE),
    ))
}

pub(super) fn routes() -> Router<Runtime> {
    Router::new().route(
        "/activity/{agent}",
        get(activity_endpoint).delete(activity_endpoint),
    )
}

pub async fn read_activity(route: &Route, agent: AgentId, clear: bool) -> Result<ActivitySnapshot> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|_| AppError::new("activity_unavailable", "无法读取请求活动"))?;
    let url = format!(
        "http://127.0.0.1:{}/activity/{}",
        route.port,
        agent.as_str()
    );
    let request = if clear {
        client.delete(url)
    } else {
        client.get(url)
    };
    request
        .bearer_auth(&route.token)
        .send()
        .await
        .map_err(|_| {
            AppError::new(
                "activity_unavailable",
                "无法连接本地网关，请确认 AE 正在运行",
            )
        })?
        .error_for_status()
        .map_err(|_| {
            AppError::new(
                "activity_unavailable",
                "本地网关未能提供请求活动，请确认运行版本",
            )
        })?
        .json()
        .await
        .map_err(|_| AppError::new("activity_unavailable", "请求活动响应无效"))
}

/// Read the running gateway without opening/locking or changing its Store.
pub async fn read_saved_activity(
    directory: &std::path::Path,
    agent: AgentId,
) -> Result<ActivitySnapshot> {
    let saved = crate::adapters::read(&directory.join("protocol-bridge.json"))?
        .ok_or_else(|| AppError::new("activity_unavailable", "未找到正在运行的本地网关"))?;
    let route: Route = serde_json::from_str(&saved)
        .map_err(|_| AppError::new("activity_unavailable", "本地网关配置无效"))?;
    if route.port == 0
        || route.token.len() != 64
        || !route.token.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(AppError::new("activity_unavailable", "本地网关配置无效"));
    }
    read_activity(&route, agent, false).await
}

#[cfg(test)]
mod tests;
