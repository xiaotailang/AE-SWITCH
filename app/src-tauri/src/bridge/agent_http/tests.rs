use super::*;

#[path = "integration_tests.rs"]
mod integration_tests;

#[test]
fn only_accepts_local_token_and_rejects_browser_origins() {
    let mut headers = HeaderMap::new();
    assert!(!authenticated(&headers, "private-token"));
    headers.insert(
        header::AUTHORIZATION,
        "Bearer private-token".parse().unwrap(),
    );
    assert!(authenticated(&headers, "private-token"));
    headers.insert(header::ORIGIN, "https://untrusted.example".parse().unwrap());
    assert!(!authenticated(&headers, "private-token"));
    headers.remove(header::ORIGIN);
    headers.remove(header::AUTHORIZATION);
    headers.insert("x-api-key", "private-token".parse().unwrap());
    assert!(authenticated(&headers, "private-token"));
    assert!(!authenticated(&headers, "other-token"));
}

#[test]
fn canonicalizes_resource_without_duplicate_version_paths() {
    assert_eq!(
        resource_url("https://example.test", "responses", false)
            .unwrap()
            .as_str(),
        "https://example.test/v1/responses"
    );
    assert_eq!(
        resource_url("https://example.test/v1/", "chat/completions", false)
            .unwrap()
            .as_str(),
        "https://example.test/v1/chat/completions"
    );
    assert_eq!(
        resource_url("https://example.test/v1/messages", "responses", false)
            .unwrap()
            .as_str(),
        "https://example.test/v1/responses"
    );
}

#[test]
fn preserves_discovered_reverse_proxy_and_versioned_routes() {
    for (base, exact, expected) in [
        (
            "https://example.test/backend-api/codex",
            false,
            "https://example.test/backend-api/codex/responses",
        ),
        (
            "https://example.test/gateway/v2",
            false,
            "https://example.test/gateway/v2/responses",
        ),
        (
            "https://example.test/gateway%20path",
            true,
            "https://example.test/gateway%20path/responses",
        ),
        ("https://responses", false, "https://responses/v1/responses"),
    ] {
        assert_eq!(
            resource_url(base, "responses", exact).unwrap().as_str(),
            expected
        );
    }
}

#[test]
fn converts_chat_tool_history_without_losing_ids() {
    let body = json!({"model":"claude-test","messages":[{"role":"system","content":"Be precise"},{"role":"user","content":"read a file"},{"role":"assistant","content":null,"tool_calls":[{"id":"tool-1","type":"function","function":{"name":"read","arguments":"{\"path\":\"a.txt\"}"}}]},{"role":"tool","tool_call_id":"tool-1","content":"file content"}],"tools":[{"type":"function","function":{"name":"read","parameters":{"type":"object"}}}],"max_tokens":100});
    let converted = chat_to_responses(&body).unwrap();
    assert_eq!(converted["input"][0]["role"], "developer");
    assert_eq!(converted["input"][2]["call_id"], "tool-1");
    assert_eq!(converted["input"][3]["type"], "function_call_output");
    assert_eq!(converted["tools"][0]["name"], "read");
    assert_eq!(converted["max_output_tokens"], 100);
}

#[test]
fn malformed_tools_return_errors_without_panicking() {
    for tool in [
        json!({"type":"function","function":"oops"}),
        json!({"type":"function","function":[]}),
        json!({"type":"custom","name":"bad"}),
    ] {
        assert!(chat_to_responses(&json!({"model":"test","messages":[],"tools":[tool]})).is_err());
    }
}

#[test]
fn codex_turn_bindings_preserve_live_roots_under_capacity_pressure() {
    let mut turns = CodexTurns::default();
    let scope = |root_turn, thread, parent| {
        CodexMetadata::Identified(CodexRequestScope {
            root_turn,
            thread,
            parent,
        })
    };
    let identity = |revision| CodexGatewaySelection {
        configuration_revision: revision,
        applied_at_ms: 100 + revision,
        allow_native_model_switching: true,
    };
    let first_root = Uuid::new_v4();
    let first_thread = Uuid::new_v4();
    let mut configured = Some("high".to_owned());
    turns
        .authorize(
            identity(1),
            scope(first_root, first_thread, None),
            "model-a",
            &mut configured,
            true,
        )
        .unwrap();
    let second_root = Uuid::new_v4();
    turns
        .authorize(
            identity(1),
            scope(second_root, Uuid::new_v4(), None),
            "model-b",
            &mut None,
            true,
        )
        .unwrap();
    for _ in 2..MAX_CODEX_TURNS {
        turns
            .authorize(
                identity(1),
                scope(Uuid::new_v4(), Uuid::new_v4(), None),
                "model-b",
                &mut None,
                true,
            )
            .unwrap();
    }
    let overflow = turns
        .authorize(
            identity(1),
            scope(Uuid::new_v4(), Uuid::new_v4(), None),
            "model-b",
            &mut None,
            true,
        )
        .unwrap_err();
    assert_eq!(overflow.0, StatusCode::SERVICE_UNAVAILABLE);
    turns.bindings.get_mut(&second_root).unwrap().touched = Instant::now() - CODEX_TURN_IDLE;
    let new_root = Uuid::new_v4();
    turns
        .authorize(
            identity(2),
            scope(new_root, Uuid::new_v4(), None),
            "model-b",
            &mut None,
            true,
        )
        .unwrap();
    assert!(!turns.bindings.contains_key(&second_root));
    for (thread, parent) in [(Uuid::new_v4(), Some(first_thread)), (first_thread, None)] {
        assert_eq!(
            turns
                .authorize(
                    identity(2),
                    scope(first_root, thread, parent),
                    "model-a",
                    &mut None,
                    true
                )
                .unwrap_err()
                .0,
            StatusCode::CONFLICT
        );
    }
    let mut inherited = None;
    turns
        .authorize(
            identity(1),
            scope(first_root, Uuid::new_v4(), Some(first_thread)),
            "model-a",
            &mut inherited,
            true,
        )
        .unwrap();
    assert_eq!(inherited.as_deref(), Some("high"));
}
