//! HTTP regressions use local mocks; these are not real endpoint acceptance.
use crate::bridge::{self, Route};
use crate::store::Store;
use crate::types::{CodexOptions, CodexProtocol, Family, ProviderInput, ProviderModel, Target};
use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
    Json, Router,
};
use serde_json::{json, Value};
use std::{
    convert::Infallible,
    sync::{Arc, Mutex},
    time::Duration,
};

const MODEL: &str = "portable-model";
const UPSTREAM_KEY: &str = "regression-upstream-private-key";
const TOOL_ARGUMENTS: &str = "{\"path\":\"目录/数据.txt\"}";

#[derive(Clone, Copy)]
enum UpstreamKind {
    Openai,
    ChatOnly,
    Anthropic,
    AuthenticationFailure,
    InBandError,
    Interrupted,
}

#[derive(Clone)]
struct Recorded {
    path: String,
    headers: HeaderMap,
    body: Value,
}

#[derive(Clone)]
struct Mock {
    kind: UpstreamKind,
    requests: Arc<Mutex<Vec<Recorded>>>,
}

async fn upstream(
    State(state): State<Mock>,
    uri: Uri,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    state.requests.lock().unwrap().push(Recorded {
        path: uri.path().into(),
        headers,
        body: body.clone(),
    });
    if matches!(state.kind, UpstreamKind::AuthenticationFailure) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":{"message":format!("Invalid API key: {UPSTREAM_KEY}")}})),
        )
            .into_response();
    }
    if matches!(state.kind, UpstreamKind::InBandError) {
        return fragmented_sse(vec![
            json!({"type":"error","error":{"message":UPSTREAM_KEY}}),
        ]);
    }
    if matches!(state.kind, UpstreamKind::Interrupted) {
        return fragmented_sse(vec![
            json!({"type":"response.output_text.delta","delta":"partial"}),
        ]);
    }
    if uri.path() == "/v1/messages/count_tokens" {
        return Json(json!({"input_tokens":42})).into_response();
    }
    if uri.path() == "/v1/responses" {
        if matches!(state.kind, UpstreamKind::ChatOnly) {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({"error":{"message":"This endpoint only implements chat completions"}})),
            )
                .into_response();
        }
        return Json(json!({"id":"resp-native","object":"response","status":"completed","model":MODEL,"output":[{"type":"message","id":"msg-native","role":"assistant","status":"completed","content":[{"type":"output_text","text":"NATIVE_OK","annotations":[]}]}],"usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10}})).into_response();
    }
    if uri.path() == "/v1/chat/completions" {
        if body["stream"] == true {
            return fragmented_sse(chat_events());
        }
        return Json(json!({"id":"chat-native","object":"chat.completion","model":MODEL,"choices":[{"index":0,"message":{"role":"assistant","content":"读取中国","tool_calls":[{"id":"call-read","type":"function","function":{"name":"read_file","arguments":TOOL_ARGUMENTS}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}})).into_response();
    }
    if uri.path() == "/v1/messages" {
        if body["stream"] == true {
            return fragmented_sse(anthropic_events());
        }
        return Json(json!({"id":"msg-native","type":"message","role":"assistant","model":MODEL,"content":[{"type":"text","text":"读取中国"},{"type":"tool_use","id":"call-read","name":"read_file","input":{"path":"目录/数据.txt"}}],"stop_reason":"tool_use","usage":{"input_tokens":7,"output_tokens":3}})).into_response();
    }
    (
        StatusCode::NOT_FOUND,
        Json(json!({"error":{"message":"Unexpected upstream path"}})),
    )
        .into_response()
}

fn chat_events() -> Vec<Value> {
    vec![
        json!({"id":"chat-stream","object":"chat.completion.chunk","model":MODEL,"choices":[{"index":0,"delta":{"role":"assistant","content":"读取中国"},"finish_reason":null}]}),
        json!({"id":"chat-stream","object":"chat.completion.chunk","model":MODEL,"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-read","type":"function","function":{"name":"read_file","arguments":"{\"path\":"}}]},"finish_reason":null}]}),
        json!({"id":"chat-stream","object":"chat.completion.chunk","model":MODEL,"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"目录/数据.txt\"}"}}]},"finish_reason":null}]}),
        json!({"id":"chat-stream","object":"chat.completion.chunk","model":MODEL,"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}),
        json!({"id":"chat-stream","object":"chat.completion.chunk","model":MODEL,"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}),
    ]
}

fn anthropic_events() -> Vec<Value> {
    vec![
        json!({"type":"message_start","message":{"id":"msg-stream","type":"message","role":"assistant","model":MODEL,"content":[],"usage":{"input_tokens":7,"output_tokens":0}}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":"读"}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"取中国"}}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call-read","name":"read_file","input":{"path":"目录/数据.txt"}}}),
        json!({"type":"content_block_stop","index":1}),
        json!({"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"call-list","name":"list_files","input":{}}}),
        json!({"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"directory\":"}}),
        json!({"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\"目录\"}"}}),
        json!({"type":"content_block_stop","index":2}),
        json!({"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":3}}),
        json!({"type":"message_stop"}),
    ]
}

fn fragmented_sse(events: Vec<Value>) -> Response {
    let mut wire = events
        .iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect::<String>();
    if events
        .first()
        .is_some_and(|event| event["object"] == "chat.completion.chunk")
    {
        wire.push_str("data: [DONE]\n\n");
    }
    let chunks = wire
        .as_bytes()
        .chunks(11)
        .map(|chunk| Ok::<_, Infallible>(chunk.to_vec()))
        .collect::<Vec<_>>();
    (
        [("content-type", "text/event-stream")],
        Body::from_stream(futures_util::stream::iter(chunks)),
    )
        .into_response()
}

#[tokio::test]
async fn activity_http_auth_filters_and_clear_do_not_expose_content_or_change_routes() {
    use crate::agent_configs::AgentId;
    let fixture = Fixture::new(UpstreamKind::Openai, CodexProtocol::Openai, "bearer", "").await;
    configure_selected_agent(&fixture, AgentId::Codex, MODEL);
    let body = json!({"model":MODEL,"input":"diagnostic-private-prompt","stream":false});
    let response = selected_post(&fixture, "codex", "responses", body.clone()).await;
    let data: Value = response.json().await.unwrap();
    assert_eq!(data["output"][0]["content"][0]["text"], "NATIVE_OK");
    let snapshot = bridge::activity::read_activity(&fixture.route, AgentId::Codex, false)
        .await
        .unwrap();
    assert_eq!(snapshot.records.len(), 1);
    assert_eq!(snapshot.records[0].state, "completed");
    assert_eq!(snapshot.records[0].model.as_deref(), Some(MODEL));
    assert_eq!(snapshot.records[0].usage.input_tokens, Some(7));
    assert_eq!(snapshot.records[0].usage.output_tokens, Some(3));
    let directory = fixture.store.lock().unwrap().data_directory.clone();
    let route_before = std::fs::read(directory.join("protocol-bridge.json")).unwrap();
    let from_saved = bridge::activity::read_saved_activity(&directory, AgentId::Codex)
        .await
        .unwrap();
    assert_eq!(from_saved.records[0].id, snapshot.records[0].id);
    assert_eq!(
        std::fs::read(directory.join("protocol-bridge.json")).unwrap(),
        route_before
    );
    assert_eq!(fixture.recorded()[0].body, body);
    let serialized = serde_json::to_string(&snapshot).unwrap();
    for forbidden in [
        UPSTREAM_KEY,
        &fixture.route.token,
        "diagnostic-private-prompt",
        "NATIVE_OK",
        TOOL_ARGUMENTS,
        "127.0.0.1",
        "api_key",
    ] {
        assert!(!serialized.contains(forbidden));
    }
    let url = format!("http://127.0.0.1:{}/activity/codex", fixture.route.port);
    assert_eq!(
        fixture.client.get(&url).send().await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        fixture
            .client
            .delete(&url)
            .bearer_auth(&fixture.route.token)
            .header("Origin", "http://browser.invalid")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        bridge::activity::read_activity(&fixture.route, AgentId::Hermes, false)
            .await
            .unwrap()
            .records
            .len(),
        0
    );
    assert!(
        bridge::activity::read_activity(&fixture.route, AgentId::Codex, true)
            .await
            .unwrap()
            .records
            .is_empty()
    );
    assert!(
        bridge::activity::read_activity(&fixture.route, AgentId::Codex, false)
            .await
            .unwrap()
            .records
            .is_empty()
    );
    fixture.shutdown().await;
}

#[tokio::test]
async fn activity_counts_stream_usage_across_native_and_converted_protocols() {
    use crate::agent_configs::AgentId;
    for (kind, protocol, resource, agent) in [
        (
            UpstreamKind::ChatOnly,
            CodexProtocol::Openai,
            "responses",
            AgentId::Codex,
        ),
        (
            UpstreamKind::Anthropic,
            CodexProtocol::Anthropic,
            "chat/completions",
            AgentId::Hermes,
        ),
        (
            UpstreamKind::Anthropic,
            CodexProtocol::Anthropic,
            "messages",
            AgentId::ClaudeCode,
        ),
    ] {
        let fixture = Fixture::new(kind, protocol, "bearer", "").await;
        configure_selected_agent(&fixture, agent, MODEL);
        let response = selected_post(
            &fixture,
            agent.as_str(),
            resource,
            request_body(resource, true),
        )
        .await;
        assert!(response.status().is_success());
        let wire = response.text().await.unwrap();
        assert!(wire.contains("data:"));
        let snapshot = bridge::activity::read_activity(&fixture.route, agent, false)
            .await
            .unwrap();
        assert_eq!(snapshot.records.len(), 1);
        let record = &snapshot.records[0];
        assert_eq!(record.state, "completed", "{resource}: {wire}");
        assert_eq!(record.endpoint, resource);
        assert_eq!(record.usage.input_tokens, Some(7));
        assert_eq!(record.usage.output_tokens, Some(3));
        assert_eq!(record.response_bytes as usize, wire.len());
        fixture.shutdown().await;
    }
}

#[tokio::test]
async fn activity_retains_failed_and_interrupted_http_results_without_error_text() {
    use crate::agent_configs::AgentId;
    for (kind, expected_status, expected_state) in [
        (UpstreamKind::AuthenticationFailure, 401, "failed"),
        (UpstreamKind::InBandError, 200, "failed"),
        (UpstreamKind::Interrupted, 200, "interrupted"),
    ] {
        let fixture = Fixture::new(kind, CodexProtocol::Openai, "bearer", "").await;
        configure_selected_agent(&fixture, AgentId::Codex, MODEL);
        let response = selected_post(
            &fixture,
            "codex",
            "responses",
            request_body("responses", true),
        )
        .await;
        assert_eq!(response.status().as_u16(), expected_status);
        response.bytes().await.unwrap();
        let snapshot = bridge::activity::read_activity(&fixture.route, AgentId::Codex, false)
            .await
            .unwrap();
        assert_eq!(snapshot.records[0].status, Some(expected_status));
        assert_eq!(snapshot.records[0].state, expected_state);
        assert!(!serde_json::to_string(&snapshot)
            .unwrap()
            .contains(UPSTREAM_KEY));
        fixture.shutdown().await;
    }
}

struct Fixture {
    store: Arc<Mutex<Store>>,
    route: Route,
    id: String,
    client: reqwest::Client,
    requests: Arc<Mutex<Vec<Recorded>>>,
    gateway: tokio::task::JoinHandle<()>,
    mock: tokio::task::JoinHandle<()>,
    temporary: tempfile::TempDir,
}

impl Fixture {
    async fn new(
        kind: UpstreamKind,
        protocol: CodexProtocol,
        auth: &str,
        base_resource: &str,
    ) -> Self {
        let temporary = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_port = listener.local_addr().unwrap().port();
        let app = Router::new().fallback(upstream).with_state(Mock {
            kind,
            requests: requests.clone(),
        });
        let mock = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let mut store = Store::open(temporary.path().join("data")).unwrap();
        for target in [Target::Codex, Target::ClaudeDesktop, Target::ClaudeCli] {
            store
                .set_directory(
                    target,
                    temporary
                        .path()
                        .join(target.id())
                        .to_string_lossy()
                        .into_owned(),
                )
                .unwrap();
        }
        let provider = store
            .save(ProviderInput {
                id: None,
                edited_context_model_ids: vec![],
                family: if protocol == CodexProtocol::Anthropic {
                    Family::Claude
                } else {
                    Family::Codex
                },
                name: "Inactive regression provider".into(),
                base_url: format!("http://127.0.0.1:{upstream_port}{base_resource}"),
                api_key: Some(UPSTREAM_KEY.into()),
                balance_access_token: None,
                model: MODEL.into(),
                auth_mode: auth.into(),
                reasoning_effort: None,
                codex_options: CodexOptions {
                    upstream_protocol: Some(protocol),
                    protocol,
                    models: vec![
                        ProviderModel {
                            id: MODEL.into(),
                            context_window: Some(128000),
                            reasoning_efforts: vec![],
                            enabled: true,
                        },
                        ProviderModel {
                            id: "disabled-model".into(),
                            context_window: None,
                            reasoning_efforts: vec![],
                            enabled: false,
                        },
                    ],
                    ..Default::default()
                },
            })
            .unwrap();
        let (route, listener) = Route::bind(&store.data_directory).unwrap();
        store.set_bridge_route(route.clone());
        let store = Arc::new(Mutex::new(store));
        let gateway_store = store.clone();
        let gateway_route = route.clone();
        let gateway = tokio::spawn(async move {
            bridge::serve(listener, gateway_route, gateway_store)
                .await
                .unwrap();
        });
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        Self {
            store,
            route,
            id: provider.id,
            client,
            requests,
            gateway,
            mock,
            temporary,
        }
    }

    fn url(&self, resource: &str) -> String {
        format!(
            "http://127.0.0.1:{}/agents/{}/v1/{resource}",
            self.route.port, self.id
        )
    }

    async fn post(&self, resource: &str, body: Value) -> reqwest::Response {
        self.client
            .post(self.url(resource))
            .bearer_auth(&self.route.token)
            .json(&body)
            .send()
            .await
            .unwrap()
    }

    fn recorded(&self) -> Vec<Recorded> {
        self.requests.lock().unwrap().clone()
    }

    fn assert_unactivated(&self) {
        let store = self.store.lock().unwrap();
        for target in [Target::Codex, Target::ClaudeDesktop, Target::ClaudeCli] {
            assert!(store.status(target).unwrap().active_provider_id.is_none());
            for name in ["config.toml", "settings.json", "auth.json"] {
                assert!(!self.temporary.path().join(target.id()).join(name).exists());
            }
        }
    }

    async fn shutdown(mut self) {
        self.gateway.abort();
        self.mock.abort();
        let _ = (&mut self.gateway).await;
        let _ = (&mut self.mock).await;
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.gateway.abort();
        self.mock.abort();
    }
}

fn request_body(resource: &str, stream: bool) -> Value {
    if resource == "responses" {
        json!({"model":MODEL,"input":"Read a file","tools":[{"type":"function","name":"read_file","parameters":{"type":"object","properties":{"path":{"type":"string"}}}}],"stream":stream,"max_output_tokens":256})
    } else if resource == "messages" {
        json!({"model":MODEL,"messages":[{"role":"user","content":"Read a file"}],"tools":[{"name":"read_file","input_schema":{"type":"object"}}],"stream":stream,"max_tokens":256})
    } else {
        json!({"model":MODEL,"messages":[{"role":"user","content":"Read a file"}],"tools":[{"type":"function","function":{"name":"read_file","parameters":{"type":"object"}}},{"type":"function","function":{"name":"list_files","parameters":{"type":"object"}}}],"stream":stream,"stream_options":{"include_usage":true},"max_tokens":256})
    }
}

fn sse_events(wire: &str) -> Vec<Value> {
    wire.lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter(|line| *line != "[DONE]")
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn selected_provider_models(fixture: &Fixture, default: &str, enable_a: bool) {
    let mut store = fixture.store.lock().unwrap();
    let summary = store.agent_provider(&fixture.id).unwrap().summary;
    let mut input: ProviderInput =
        serde_json::from_value(serde_json::to_value(summary).unwrap()).unwrap();
    input.model = default.into();
    input.codex_options.models = [
        (MODEL, true),
        ("selected-a", enable_a),
        ("selected-b", true),
    ]
    .into_iter()
    .map(|(id, enabled)| ProviderModel {
        id: id.into(),
        context_window: None,
        reasoning_efforts: vec![],
        enabled,
    })
    .collect();
    store.save(input).unwrap();
}

fn configure_selected_agent(fixture: &Fixture, agent: crate::agent_configs::AgentId, model: &str) {
    crate::agent_hub::configure(
        &fixture.store.lock().unwrap(),
        crate::agent_hub::AgentInput {
            agent_id: agent,
            provider_id: fixture.id.clone(),
            model: Some(model.into()),
            profile: None,
        },
    )
    .unwrap();
}

async fn selected_post(
    fixture: &Fixture,
    agent: &str,
    resource: &str,
    body: Value,
) -> reqwest::Response {
    fixture
        .client
        .post(format!(
            "http://127.0.0.1:{}/agents/selected:{agent}/v1/{resource}",
            fixture.route.port
        ))
        .bearer_auth(&fixture.route.token)
        .json(&body)
        .send()
        .await
        .unwrap()
}

fn set_provider_effort(fixture: &Fixture, model: &str, effort: Option<&str>, known: bool) {
    let mut store = fixture.store.lock().unwrap();
    let summary = store.agent_provider(&fixture.id).unwrap().summary;
    let mut input: ProviderInput =
        serde_json::from_value(serde_json::to_value(summary).unwrap()).unwrap();
    input.model = model.into();
    input.reasoning_effort = effort.map(str::to_owned);
    input.codex_options.models = [MODEL, "selected-b"]
        .into_iter()
        .map(|id| ProviderModel {
            id: id.into(),
            context_window: None,
            reasoning_efforts: if known {
                ["none", "low", "high", "ultra"].map(str::to_owned).into()
            } else {
                vec![]
            },
            enabled: true,
        })
        .collect();
    store.save(input).unwrap();
}

#[tokio::test]
async fn selected_reasoning_is_snapshotted_and_reaches_all_openai_request_paths() {
    use crate::agent_configs::AgentId;
    for kind in [UpstreamKind::Openai, UpstreamKind::ChatOnly] {
        let fixture = Fixture::new(kind, CodexProtocol::Openai, "bearer", "/v1").await;
        set_provider_effort(&fixture, MODEL, Some("ultra"), true);
        for agent in [AgentId::Codex, AgentId::Zcode, AgentId::ClaudeCode] {
            configure_selected_agent(&fixture, agent, MODEL);
        }
        // Saving a different preference on the shared endpoint must not alter
        // already configured clients, even when they use the same model.
        set_provider_effort(&fixture, MODEL, Some("low"), true);
        configure_selected_agent(&fixture, AgentId::WorkBuddy, MODEL);
        for (agent, resource, effort) in [
            ("codex", "responses", "ultra"),
            ("zcode", "chat/completions", "ultra"),
            ("claude_code", "messages", "ultra"),
            ("workbuddy", "chat/completions", "low"),
        ] {
            let mut body = request_body(resource, false);
            if resource == "responses" {
                body["reasoning"] = json!({"effort":"low", "summary":"auto"});
            } else if resource == "chat/completions" {
                body["reasoning_effort"] = "high".into();
            }
            let response = selected_post(&fixture, agent, resource, body).await;
            assert!(response.status().is_success(), "{agent}");
            let recorded = fixture.recorded().pop().unwrap();
            if recorded.path == "/v1/responses" {
                assert_eq!(recorded.body["reasoning"]["effort"], effort, "{agent}");
                if agent == "codex" {
                    assert_eq!(recorded.body["reasoning"]["summary"], "auto");
                }
            } else {
                assert_eq!(recorded.body["reasoning_effort"], effort, "{agent}");
            }
        }
        fixture.assert_unactivated();
        fixture.shutdown().await;
    }
}

#[tokio::test]
async fn selected_reasoning_defaults_preserve_clients_and_do_not_apply_to_other_models() {
    use crate::agent_configs::AgentId;
    let fixture = Fixture::new(UpstreamKind::Openai, CodexProtocol::Openai, "bearer", "/v1").await;
    set_provider_effort(&fixture, MODEL, Some("high"), true);
    configure_selected_agent(&fixture, AgentId::Zcode, MODEL);
    configure_selected_agent(&fixture, AgentId::Codex, "selected-b");
    set_provider_effort(&fixture, MODEL, None, true);
    configure_selected_agent(&fixture, AgentId::WorkBuddy, MODEL);
    for (agent, model) in [
        ("zcode", "selected-b"),
        ("codex", "selected-b"),
        ("workbuddy", MODEL),
    ] {
        let mut body = request_body("chat/completions", false);
        body["model"] = model.into();
        body["reasoning_effort"] = "low".into();
        assert!(selected_post(&fixture, agent, "chat/completions", body)
            .await
            .status()
            .is_success());
        assert_eq!(
            fixture.recorded().pop().unwrap().body["reasoning_effort"],
            "low"
        );
    }
    // Legacy provider routes continue following the request even if the provider
    // has an explicit preference for the new single-page agent workflow.
    set_provider_effort(&fixture, MODEL, Some("high"), true);
    let mut body = request_body("chat/completions", false);
    body["reasoning_effort"] = "low".into();
    assert!(fixture
        .post("chat/completions", body)
        .await
        .status()
        .is_success());
    assert_eq!(
        fixture.recorded().pop().unwrap().body["reasoning_effort"],
        "low"
    );
    fixture.shutdown().await;
}

#[tokio::test]
async fn selected_reasoning_unknown_metadata_forwards_explicit_values_without_inventing_capabilities(
) {
    use crate::agent_configs::AgentId;
    for kind in [UpstreamKind::Openai, UpstreamKind::ChatOnly] {
        let fixture = Fixture::new(kind, CodexProtocol::Openai, "bearer", "/v1").await;
        set_provider_effort(&fixture, MODEL, Some("high"), false);
        let models_before = fixture
            .store
            .lock()
            .unwrap()
            .agent_provider(&fixture.id)
            .unwrap()
            .summary
            .codex_options
            .models;
        for (agent, resource) in [
            (AgentId::Codex, "responses"),
            (AgentId::Zcode, "chat/completions"),
            (AgentId::ClaudeCode, "messages"),
        ] {
            configure_selected_agent(&fixture, agent, MODEL);
            let response = selected_post(
                &fixture,
                agent.as_str(),
                resource,
                request_body(resource, false),
            )
            .await;
            assert!(response.status().is_success(), "{}", agent.as_str());
            let recorded = fixture.recorded().pop().unwrap();
            let effort = if recorded.path == "/v1/responses" {
                &recorded.body["reasoning"]["effort"]
            } else {
                &recorded.body["reasoning_effort"]
            };
            assert_eq!(effort, "high", "{}", agent.as_str());
        }
        let models_after = fixture
            .store
            .lock()
            .unwrap()
            .agent_provider(&fixture.id)
            .unwrap()
            .summary
            .codex_options
            .models;
        assert_eq!(
            serde_json::to_value(models_after).unwrap(),
            serde_json::to_value(models_before).unwrap()
        );
        // Unknown capability metadata does not turn the default into an
        // override: omitted fields remain omitted and client values survive.
        set_provider_effort(&fixture, MODEL, None, false);
        configure_selected_agent(&fixture, AgentId::WorkBuddy, MODEL);
        for requested_effort in [None, Some("low")] {
            let mut body = request_body("chat/completions", false);
            if let Some(effort) = requested_effort {
                body["reasoning_effort"] = effort.into();
            }
            assert!(
                selected_post(&fixture, "workbuddy", "chat/completions", body)
                    .await
                    .status()
                    .is_success()
            );
            let recorded = fixture.recorded().pop().unwrap();
            assert_eq!(
                recorded
                    .body
                    .get("reasoning_effort")
                    .and_then(Value::as_str),
                requested_effort
            );
        }
        // The shared default edit cannot erase already configured selections.
        assert!(selected_post(
            &fixture,
            "zcode",
            "chat/completions",
            request_body("chat/completions", false)
        )
        .await
        .status()
        .is_success());
        assert_eq!(
            fixture.recorded().pop().unwrap().body["reasoning_effort"],
            "high"
        );
        fixture.assert_unactivated();
        fixture.shutdown().await;
    }
}

#[tokio::test]
async fn selected_reasoning_rejects_unsupported_protocol_or_declared_capabilities_before_forwarding(
) {
    use crate::agent_configs::AgentId;
    for (protocol, effort) in [
        (CodexProtocol::Openai, "medium"),
        (CodexProtocol::Anthropic, "high"),
    ] {
        let fixture = Fixture::new(UpstreamKind::Openai, protocol, "bearer", "/v1").await;
        set_provider_effort(&fixture, MODEL, Some(effort), true);
        let error = crate::agent_hub::configure(
            &fixture.store.lock().unwrap(),
            crate::agent_hub::AgentInput {
                agent_id: AgentId::Zcode,
                provider_id: fixture.id.clone(),
                model: None,
                profile: None,
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "unsupported_reasoning_effort");
        assert!(!fixture
            .temporary
            .path()
            .join("data/agent-selection.json")
            .exists());
        assert!(!fixture.temporary.path().join("data/agents/zcode").exists());
        assert!(fixture.recorded().is_empty());
        fixture.shutdown().await;
    }
    let fixture = Fixture::new(UpstreamKind::Openai, CodexProtocol::Openai, "bearer", "/v1").await;
    set_provider_effort(&fixture, MODEL, Some("high"), true);
    configure_selected_agent(&fixture, AgentId::Zcode, MODEL);
    set_provider_effort(&fixture, MODEL, None, true);
    {
        let mut store = fixture.store.lock().unwrap();
        let summary = store.agent_provider(&fixture.id).unwrap().summary;
        let mut input: ProviderInput =
            serde_json::from_value(serde_json::to_value(summary).unwrap()).unwrap();
        for model in &mut input.codex_options.models {
            model.reasoning_efforts = vec!["low".into()];
        }
        store.save(input).unwrap();
    }
    assert_eq!(
        selected_post(
            &fixture,
            "zcode",
            "chat/completions",
            request_body("chat/completions", false)
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert!(fixture.recorded().is_empty());
    fixture.shutdown().await;
}

#[tokio::test]
async fn release_routing_selected_agent_models_are_isolated_from_shared_provider_default() {
    use crate::agent_configs::AgentId;
    for (kind, protocol) in [
        (UpstreamKind::ChatOnly, CodexProtocol::Openai),
        (UpstreamKind::Anthropic, CodexProtocol::Anthropic),
    ] {
        let fixture = Fixture::new(kind, protocol, "bearer", "/v1").await;
        selected_provider_models(&fixture, MODEL, true);
        for (agent, model) in [
            (AgentId::ClaudeCode, "selected-a"),
            (AgentId::Codex, "selected-b"),
            (AgentId::OhMyPi, "selected-b"),
            (AgentId::OpenCode, "selected-b"),
        ] {
            configure_selected_agent(&fixture, agent, model);
        }
        selected_provider_models(&fixture, "selected-b", true);
        let environment: Value = serde_json::from_slice(
            &std::fs::read(
                fixture
                    .temporary
                    .path()
                    .join("data/agents/claude_code/configuration/environment.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            environment["ANTHROPIC_BASE_URL"],
            format!(
                "http://127.0.0.1:{}/agents/selected:claude_code",
                fixture.route.port
            )
        );
        for alias in [
            "selected-a",
            "sonnet",
            "opus",
            "haiku",
            "claude-haiku-4-5-20251001",
        ] {
            let mut body = request_body("messages", false);
            body["model"] = alias.into();
            assert!(
                selected_post(&fixture, "claude_code", "messages", body)
                    .await
                    .status()
                    .is_success(),
                "{alias}"
            );
            let recorded = fixture.recorded().pop().unwrap();
            assert_eq!(recorded.body["model"], "selected-a", "{alias}");
            assert_eq!(
                recorded.path,
                if protocol == CodexProtocol::Openai {
                    "/v1/chat/completions"
                } else {
                    "/v1/messages"
                }
            );
            assert_eq!(
                recorded.headers["authorization"],
                format!("Bearer {UPSTREAM_KEY}")
            );
        }
        for (agent, resource) in [
            ("codex", "responses"),
            ("oh_my_pi", "chat/completions"),
            ("opencode", "chat/completions"),
        ] {
            let mut body = request_body(resource, false);
            body["model"] = "selected-b".into();
            assert!(
                selected_post(&fixture, agent, resource, body)
                    .await
                    .status()
                    .is_success(),
                "{agent}"
            );
            assert_eq!(
                fixture.recorded().pop().unwrap().body["model"],
                "selected-b"
            );
        }
        let mut body = request_body("messages", false);
        body["model"] = "haiku".into();
        assert!(
            selected_post(&fixture, "claude_code", "messages/count_tokens", body)
                .await
                .status()
                .is_success()
        );
        if protocol == CodexProtocol::Anthropic {
            assert_eq!(
                fixture.recorded().pop().unwrap().body["model"],
                "selected-a"
            );
        }
        assert_eq!(
            fixture
                .store
                .lock()
                .unwrap()
                .agent_provider(&fixture.id)
                .unwrap()
                .summary
                .model,
            "selected-b"
        );
        fixture.assert_unactivated();
        fixture.shutdown().await;
    }
}

#[tokio::test]
async fn release_routing_selected_routes_reject_invalid_choices_and_keep_legacy_routes() {
    use crate::agent_configs::AgentId;
    let fixture = Fixture::new(
        UpstreamKind::ChatOnly,
        CodexProtocol::Openai,
        "bearer",
        "/v1",
    )
    .await;
    selected_provider_models(&fixture, "selected-b", true);
    configure_selected_agent(&fixture, AgentId::ClaudeCode, "selected-a");
    let mut legacy = request_body("messages", false);
    legacy["model"] = "haiku".into();
    assert!(fixture.post("messages", legacy).await.status().is_success());
    assert_eq!(
        fixture.recorded().pop().unwrap().body["model"],
        "selected-b"
    );
    let original_requests = fixture.recorded().len();
    for agent in ["unknown", "workbuddy"] {
        assert_eq!(
            selected_post(&fixture, agent, "messages", request_body("messages", false))
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
    }
    for model in [
        "not-enabled",
        "claude-unrecognized",
        "claude-haiku-invalid",
        "claude-sonnet-4-6-uni-unrecognized",
        "",
    ] {
        let mut body = request_body("messages", false);
        body["model"] = model.into();
        assert_eq!(
            selected_post(&fixture, "claude_code", "messages", body)
                .await
                .status(),
            StatusCode::BAD_REQUEST,
            "{model}"
        );
    }
    assert_eq!(fixture.recorded().len(), original_requests);
    selected_provider_models(&fixture, "selected-b", false);
    let mut body = request_body("messages", false);
    body["model"] = "selected-a".into();
    assert_eq!(
        selected_post(&fixture, "claude_code", "messages", body.clone())
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    let selection_path = fixture.temporary.path().join("data/agent-selection.json");
    for selection in [
        json!({"claude_code":{"providerId":"foreign-missing","model":"selected-a"}}),
        json!({"claude_code":{"providerId":fixture.id,"model":"selected-b","extra":"unsafe"}}),
    ] {
        std::fs::write(&selection_path, serde_json::to_vec(&selection).unwrap()).unwrap();
        assert_eq!(
            selected_post(&fixture, "claude_code", "messages", body.clone())
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(fixture.recorded().len(), original_requests);
    fixture.assert_unactivated();
    fixture.shutdown().await;
}

#[tokio::test]
async fn inactive_agent_routes_require_local_auth_and_enabled_models() {
    let fixture = Fixture::new(UpstreamKind::Openai, CodexProtocol::Openai, "bearer", "/v1").await;
    for resource in ["chat/completions", "responses", "messages"] {
        let body = request_body(resource, false);
        assert_eq!(
            fixture
                .client
                .post(fixture.url(resource))
                .json(&body)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            fixture
                .client
                .post(fixture.url(resource))
                .bearer_auth(&fixture.route.token)
                .header("origin", "https://untrusted.example")
                .json(&body)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        for invalid_model in ["disabled-model", "unknown-model"] {
            let mut invalid = body.clone();
            invalid["model"] = json!(invalid_model);
            assert_eq!(
                fixture.post(resource, invalid).await.status(),
                StatusCode::BAD_REQUEST
            );
        }
    }
    assert_eq!(
        fixture
            .client
            .get(fixture.url("models"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        fixture
            .client
            .get(fixture.url("models"))
            .bearer_auth("wrong-local-token")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let models = fixture
        .client
        .get(fixture.url("models"))
        .bearer_auth(&fixture.route.token)
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(models["data"].as_array().unwrap().len(), 1);
    assert_eq!(models["data"][0]["id"], MODEL);
    let unknown = fixture
        .url("models")
        .replace(&fixture.id, "missing-provider");
    assert_eq!(
        fixture
            .client
            .get(unknown)
            .bearer_auth(&fixture.route.token)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert!(fixture.recorded().is_empty());
    fixture.assert_unactivated();
    fixture.shutdown().await;
}

#[tokio::test]
async fn native_requests_preserve_path_body_and_private_upstream_auth() {
    for (kind, protocol, auth, base, resources) in [
        (
            UpstreamKind::Openai,
            CodexProtocol::Openai,
            "bearer",
            "/v1/chat/completions",
            vec!["chat/completions", "responses"],
        ),
        (
            UpstreamKind::Anthropic,
            CodexProtocol::Anthropic,
            "x-api-key",
            "/v1/messages",
            vec!["messages"],
        ),
    ] {
        let fixture = Fixture::new(kind, protocol, auth, base).await;
        for resource in resources {
            let body = request_body(resource, false);
            let response = fixture
                .client
                .post(fixture.url(resource))
                .header("x-api-key", &fixture.route.token)
                .header("anthropic-beta", "test-beta")
                .json(&body)
                .send()
                .await
                .unwrap();
            assert!(response.status().is_success());
            let text = response.text().await.unwrap();
            assert!(!text.contains(UPSTREAM_KEY));
            assert!(!text.contains(&fixture.route.token));
            let recorded = fixture.recorded().pop().unwrap();
            assert_eq!(recorded.path, format!("/v1/{resource}"));
            assert_eq!(recorded.body, body);
            if auth == "bearer" {
                assert_eq!(
                    recorded.headers["authorization"],
                    format!("Bearer {UPSTREAM_KEY}")
                );
                assert!(!recorded.headers.contains_key("x-api-key"));
            } else {
                assert_eq!(recorded.headers["x-api-key"], UPSTREAM_KEY);
                assert!(!recorded.headers.contains_key("authorization"));
                assert_eq!(recorded.headers["anthropic-version"], "2023-06-01");
                assert_eq!(recorded.headers["anthropic-beta"], "test-beta");
            }
        }
        fixture.assert_unactivated();
        fixture.shutdown().await;
    }
}

#[tokio::test]
async fn upstream_authentication_errors_never_expose_keys() {
    let fixture = Fixture::new(
        UpstreamKind::AuthenticationFailure,
        CodexProtocol::Openai,
        "bearer",
        "/v1",
    )
    .await;
    let response = fixture
        .post("responses", request_body("responses", false))
        .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let body = response.text().await.unwrap();
    assert!(!body.contains(UPSTREAM_KEY));
    assert!(!body.contains(&fixture.route.token));
    fixture.shutdown().await;
}

#[tokio::test]
async fn chat_only_fallback_preserves_responses_history_text_tools_and_usage() {
    let fixture = Fixture::new(
        UpstreamKind::ChatOnly,
        CodexProtocol::Openai,
        "bearer",
        "/v1",
    )
    .await;
    let mut body = request_body("responses", false);
    body["input"] = json!([{"role":"user","content":"Read a file"},{"type":"function_call","call_id":"history-call","name":"read_file","arguments":TOOL_ARGUMENTS},{"type":"function_call_output","call_id":"history-call","output":"old file contents"},{"role":"user","content":"Read another file"}]);
    body["instructions"] = json!("Use the coding tools");
    let response = fixture.post("responses", body).await;
    assert!(response.status().is_success());
    let value = response.json::<Value>().await.unwrap();
    let output = value["output"].as_array().unwrap();
    assert!(output
        .iter()
        .any(|item| item["type"] == "message" && item["content"][0]["text"] == "读取中国"));
    let call = output
        .iter()
        .find(|item| item["type"] == "function_call")
        .unwrap();
    assert_eq!(call["call_id"], "call-read");
    assert_eq!(call["name"], "read_file");
    assert_eq!(
        serde_json::from_str::<Value>(call["arguments"].as_str().unwrap()).unwrap(),
        json!({"path":"目录/数据.txt"})
    );
    assert_eq!(value["usage"]["input_tokens"], 7);
    assert_eq!(value["usage"]["output_tokens"], 3);
    let recorded = fixture.recorded();
    assert_eq!(
        recorded
            .iter()
            .map(|request| request.path.as_str())
            .collect::<Vec<_>>(),
        ["/v1/responses", "/v1/chat/completions"]
    );
    let messages = recorded[1].body["messages"].as_array().unwrap();
    assert!(messages.iter().any(|message| message["role"] == "tool"
        && message["tool_call_id"] == "history-call"
        && (message["content"] == "old file contents"
            || message["content"] == json!([{"type":"text","text":"old file contents"}]))));
    assert!(messages.iter().any(|message| message["role"] == "assistant"
        && message["tool_calls"][0]["id"] == "history-call"));
    fixture.assert_unactivated();
    fixture.shutdown().await;
}

#[tokio::test]
async fn chat_only_fallback_stream_preserves_unicode_tool_arguments_and_completion() {
    let fixture = Fixture::new(
        UpstreamKind::ChatOnly,
        CodexProtocol::Openai,
        "bearer",
        "/v1",
    )
    .await;
    let response = fixture
        .post("responses", request_body("responses", true))
        .await;
    assert!(response.status().is_success());
    assert!(response.headers()["content-type"]
        .to_str()
        .unwrap()
        .starts_with("text/event-stream"));
    let wire = response.text().await.unwrap();
    assert!(!wire.contains(UPSTREAM_KEY));
    let events = sse_events(&wire);
    assert!(
        !events.iter().any(|event| event["type"] == "error"),
        "{events:?}"
    );
    let text = events
        .iter()
        .filter(|event| event["type"] == "response.output_text.delta")
        .filter_map(|event| event["delta"].as_str())
        .collect::<String>();
    assert_eq!(text, "读取中国");
    let arguments = events
        .iter()
        .filter(|event| event["type"] == "response.function_call_arguments.delta")
        .filter_map(|event| event["delta"].as_str())
        .collect::<String>();
    assert_eq!(
        serde_json::from_str::<Value>(&arguments).unwrap(),
        json!({"path":"目录/数据.txt"})
    );
    let completed = events
        .iter()
        .find(|event| event["type"] == "response.completed")
        .unwrap();
    assert_eq!(completed["response"]["status"], "completed");
    assert_eq!(completed["response"]["usage"]["input_tokens"], 7);
    assert_eq!(completed["response"]["usage"]["output_tokens"], 3);
    assert!(completed["response"]["output"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["type"] == "function_call" && item["call_id"] == "call-read"));
    fixture.shutdown().await;
}

#[tokio::test]
async fn anthropic_chat_stream_keeps_initial_blocks_multiple_tools_and_usage() {
    let fixture = Fixture::new(
        UpstreamKind::Anthropic,
        CodexProtocol::Anthropic,
        "x-api-key",
        "/v1",
    )
    .await;
    let response = fixture
        .post("chat/completions", request_body("chat/completions", true))
        .await;
    assert!(response.status().is_success());
    let wire = response.text().await.unwrap();
    assert!(wire.ends_with("data: [DONE]\n\n"));
    let events = sse_events(&wire);
    let text = events
        .iter()
        .filter_map(|event| {
            event
                .pointer("/choices/0/delta/content")
                .and_then(Value::as_str)
        })
        .collect::<String>();
    assert_eq!(text, "读取中国");
    let mut tools = std::collections::BTreeMap::<u64, (String, String, String)>::new();
    for event in &events {
        for call in event
            .pointer("/choices/0/delta/tool_calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let tool = tools.entry(call["index"].as_u64().unwrap()).or_default();
            if let Some(id) = call["id"].as_str() {
                tool.0.push_str(id);
            }
            if let Some(name) = call["function"]["name"].as_str() {
                tool.1.push_str(name);
            }
            if let Some(arguments) = call["function"]["arguments"].as_str() {
                tool.2.push_str(arguments);
            }
        }
    }
    assert_eq!(tools.len(), 2);
    assert_eq!(
        (tools[&0].0.as_str(), tools[&0].1.as_str()),
        ("call-read", "read_file")
    );
    assert_eq!(
        serde_json::from_str::<Value>(&tools[&0].2).unwrap(),
        json!({"path":"目录/数据.txt"})
    );
    assert_eq!(
        serde_json::from_str::<Value>(&tools[&1].2).unwrap(),
        json!({"directory":"目录"})
    );
    let usage = events
        .iter()
        .find_map(|event| event.get("usage"))
        .expect("include_usage requires a final usage chunk");
    assert_eq!(usage["prompt_tokens"], 7);
    assert_eq!(usage["completion_tokens"], 3);
    assert_eq!(usage["total_tokens"], 10);
    assert!(events
        .iter()
        .any(|event| event.pointer("/choices/0/finish_reason") == Some(&json!("tool_calls"))));
    fixture.shutdown().await;
}

#[tokio::test]
async fn malformed_function_tools_return_bad_request_without_upstream_traffic() {
    let fixture = Fixture::new(
        UpstreamKind::Anthropic,
        CodexProtocol::Anthropic,
        "x-api-key",
        "/v1",
    )
    .await;
    let mut body = request_body("chat/completions", false);
    body["tools"] = json!([{"type":"function","function":"not an object"}]);
    assert_eq!(
        fixture.post("chat/completions", body).await.status(),
        StatusCode::BAD_REQUEST
    );
    assert!(fixture.recorded().is_empty());
    assert!(bridge::healthy(&fixture.route).await);
    fixture.shutdown().await;
}
