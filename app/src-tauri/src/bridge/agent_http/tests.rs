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
        resource_url("https://example.test", "responses"),
        "https://example.test/v1/responses"
    );
    assert_eq!(
        resource_url("https://example.test/v1/", "chat/completions"),
        "https://example.test/v1/chat/completions"
    );
    assert_eq!(
        resource_url("https://example.test/v1/messages", "responses"),
        "https://example.test/v1/responses"
    );
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
