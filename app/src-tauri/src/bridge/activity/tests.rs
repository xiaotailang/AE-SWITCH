use super::*;

fn provider() -> StoredProvider {
    serde_json::from_value(json!({
        "summary": {"id":"test-provider", "family":"codex", "name":"private-name",
            "baseUrl":"https://private-endpoint.invalid", "model":"test-model", "authMode":"bearer",
            "reasoningEffort":null, "hasKey":true, "keySuffix":"secret", "updatedAt":0},
        "api_key":"never-record-upstream-key", "balance_access_token":null
    }))
    .unwrap()
}

fn begin(log: &ActivityLog, agent: AgentId) -> RequestTrace {
    log.begin(
        &format!("selected:{}", agent.as_str()),
        &provider(),
        &json!({"model":"test-model","stream":true,"input":"never-record-prompt"}),
        "responses",
    )
    .unwrap()
}

fn feed(wire: &[u8]) -> ResponseMetadata {
    let mut metadata = ResponseMetadata::new(true);
    for chunk in wire.chunks(1) {
        metadata.push(chunk);
    }
    metadata.end();
    metadata
}

#[test]
fn fragmented_multiline_sse_and_utf8_keep_reported_usage() {
    let wire = "event: response.completed\r\ndata: {\"type\":\"response.completed\",\r\ndata: \"response\":{\"text\":\"中文\",\"usage\":{\"input_tokens\":17,\"output_tokens\":5,\"input_tokens_details\":{\"cached_tokens\":3},\"output_tokens_details\":{\"reasoning_tokens\":2}}}}\r\n\r\n";
    let metadata = feed(wire.as_bytes());
    assert!(metadata.terminal);
    assert!(!metadata.failed);
    assert_eq!(metadata.usage.input_tokens, Some(17));
    assert_eq!(metadata.usage.output_tokens, Some(5));
    assert_eq!(metadata.usage.cached_tokens, Some(3));
    assert_eq!(metadata.usage.reasoning_tokens, Some(2));
}

#[test]
fn anthropic_partial_usage_merges_without_erasing_input_or_double_counting_output() {
    let metadata = feed(b"data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":7,\"cache_read_input_tokens\":10,\"cache_creation_input_tokens\":3,\"output_tokens\":0}}}\n\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":5}}\n\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":8}}\n\ndata: {\"type\":\"message_stop\"}\n\n");
    assert!(metadata.terminal);
    assert_eq!(metadata.usage.input_tokens, Some(20));
    assert_eq!(metadata.usage.output_tokens, Some(8));
    assert_eq!(metadata.usage.cached_tokens, Some(10));
    assert_eq!(metadata.usage.reasoning_tokens, None);
}

#[test]
fn oversized_event_is_skipped_and_the_next_usage_and_terminator_still_parse() {
    let mut metadata = ResponseMetadata::new(true);
    metadata.push(b"data: ");
    metadata.push(&vec![b'x'; FRAME_LIMIT * 3]);
    assert!(metadata.buffer.len() <= FRAME_LIMIT);
    assert!(metadata.line.len() <= FRAME_LIMIT);
    metadata.push(
        b"\n\ndata: {\"usage\":{\"prompt_tokens\":0,\"completion_tokens\":12}}\n\ndata: [DONE]\n\n",
    );
    assert!(metadata.terminal);
    assert_eq!(metadata.usage.input_tokens, Some(0));
    assert_eq!(metadata.usage.output_tokens, Some(12));
}

#[test]
fn missing_invalid_and_unfinished_usage_are_never_invented() {
    let metadata = feed(b"data: {\"usage\":{\"prompt_tokens\":-1,\"completion_tokens\":\"3\",\"output_tokens_details\":{\"reasoning_tokens\":9007199254740992}}}\n\ndata: {\"type\":\"response.completed\"}");
    assert!(!metadata.terminal);
    assert_eq!(metadata.usage.input_tokens, None);
    assert_eq!(metadata.usage.output_tokens, None);
    assert_eq!(metadata.usage.reasoning_tokens, None);
    let metadata = feed(
        b"data: {\"usage\":{\"input_tokens\":9007199254740991,\"cache_read_input_tokens\":10}}\n\n",
    );
    assert_eq!(metadata.usage.input_tokens, None);
}

#[tokio::test]
async fn broken_response_body_is_forwarded_as_error_and_recorded_as_interrupted() {
    let log = ActivityLog::default();
    let chunks = vec![
        Ok(Bytes::from_static(
            b"data: {\"usage\":{\"output_tokens\":2}}\n\n",
        )),
        Err(std::io::Error::other("never-record-stream-secret")),
    ];
    let response = (
        [(header::CONTENT_TYPE, "text/event-stream")],
        Body::from_stream(futures_util::stream::iter(chunks)),
    )
        .into_response();
    let response = observe(Some(begin(&log, AgentId::Codex)), Ok(response)).unwrap();
    assert!(axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .is_err());
    let snapshot = log.snapshot(AgentId::Codex, false);
    assert_eq!(snapshot.records[0].state, "interrupted");
    assert_eq!(snapshot.records[0].usage.output_tokens, Some(2));
    assert!(!serde_json::to_string(&snapshot)
        .unwrap()
        .contains("stream-secret"));
}

#[test]
fn ring_is_bounded_and_clear_does_not_resurrect_inflight_or_other_agents() {
    let log = ActivityLog::default();
    let mut inflight = Vec::new();
    for _ in 0..CAPACITY + 5 {
        inflight.push(begin(&log, AgentId::Codex));
    }
    assert_eq!(log.snapshot(AgentId::Codex, false).records.len(), CAPACITY);
    let other = begin(&log, AgentId::Hermes);
    assert!(log.snapshot(AgentId::Codex, true).records.is_empty());
    drop(inflight);
    assert!(log.snapshot(AgentId::Codex, false).records.is_empty());
    drop(other);
    assert_eq!(
        log.snapshot(AgentId::Hermes, false).records[0].state,
        "cancelled"
    );
}

#[tokio::test]
async fn observation_preserves_bytes_and_reports_sse_errors_inside_http_200() {
    let log = ActivityLog::default();
    let trace = begin(&log, AgentId::Codex);
    let wire = "data: {\"type\":\"error\",\"error\":{\"message\":\"never-record-upstream-key 中文\"}}\n\ndata: [DONE]\n\n";
    let chunks = wire
        .as_bytes()
        .chunks(3)
        .map(|chunk| Ok::<_, Infallible>(chunk.to_vec()))
        .collect::<Vec<_>>();
    let response = (
        [(header::CONTENT_TYPE, "text/event-stream")],
        Body::from_stream(futures_util::stream::iter(chunks)),
    )
        .into_response();
    let response = observe(Some(trace), Ok(response)).unwrap();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(bytes.as_ref(), wire.as_bytes());
    let snapshot = log.snapshot(AgentId::Codex, false);
    let record = &snapshot.records[0];
    assert_eq!(record.status, Some(200));
    assert_eq!(record.state, "failed");
    assert!(record.first_byte_ms.is_some());
    assert_eq!(record.response_bytes, wire.len() as u64);
    let serialized = serde_json::to_string(&snapshot).unwrap();
    for forbidden in [
        "never-record",
        "private-name",
        "private-endpoint",
        "apiKey",
        "prompt",
        "headers",
        "中文",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "metadata included {forbidden}"
        );
    }
}

#[tokio::test]
async fn closed_stream_incomplete_reply_and_dropped_body_are_distinct() {
    for (wire, expected) in [
        (
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n",
            "interrupted",
        ),
        ("data: {\"type\":\"response.incomplete\"}\n\n", "incomplete"),
        ("data: {\"type\":\"response.completed\"}\n\n", "completed"),
    ] {
        let log = ActivityLog::default();
        let response = ([(header::CONTENT_TYPE, "text/event-stream")], wire).into_response();
        let response = observe(Some(begin(&log, AgentId::Codex)), Ok(response)).unwrap();
        axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(
            log.snapshot(AgentId::Codex, false).records[0].state,
            expected
        );
    }
    let log = ActivityLog::default();
    let response = observe(
        Some(begin(&log, AgentId::Codex)),
        Ok(Json(json!({"usage":{"input_tokens":1}})).into_response()),
    )
    .unwrap();
    drop(response);
    assert_eq!(
        log.snapshot(AgentId::Codex, false).records[0].state,
        "cancelled"
    );
}

#[tokio::test]
async fn http_error_is_recorded_without_its_message_and_json_usage_is_retained() {
    let log = ActivityLog::default();
    let error = error(StatusCode::TOO_MANY_REQUESTS, "never-record-credential");
    assert!(observe(Some(begin(&log, AgentId::Codex)), Err(error)).is_err());
    let response = Json(json!({"usage":{"input_tokens":13,"output_tokens":2}})).into_response();
    let response = observe(Some(begin(&log, AgentId::Codex)), Ok(response)).unwrap();
    axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let records = log.snapshot(AgentId::Codex, false).records;
    assert_eq!(records[0].usage.input_tokens, Some(13));
    assert_eq!(records[1].status, Some(429));
    assert_eq!(records[1].state, "failed");
    assert!(!serde_json::to_string(&records)
        .unwrap()
        .contains("credential"));
}

#[tokio::test]
async fn token_limits_and_nested_response_status_are_not_reported_as_completed() {
    for body in [
        json!({"choices":[{"finish_reason":"length"}],"usage":{"prompt_tokens":4,"completion_tokens":3}}),
        json!({"stop_reason":"max_tokens","usage":{"input_tokens":4,"output_tokens":3}}),
        json!({"response":{"status":"incomplete","usage":{"input_tokens":4,"output_tokens":3}}}),
    ] {
        let log = ActivityLog::default();
        let response = observe(
            Some(begin(&log, AgentId::Codex)),
            Ok(Json(body).into_response()),
        )
        .unwrap();
        axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let snapshot = log.snapshot(AgentId::Codex, false);
        assert_eq!(snapshot.records[0].state, "incomplete");
        assert_eq!(snapshot.records[0].usage.output_tokens, Some(3));
    }
    for body in [
        json!({"error":"private-error"}),
        json!({"response":{"status":"failed"}}),
    ] {
        let log = ActivityLog::default();
        let response = observe(
            Some(begin(&log, AgentId::Codex)),
            Ok(Json(body).into_response()),
        )
        .unwrap();
        axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(
            log.snapshot(AgentId::Codex, false).records[0].state,
            "failed"
        );
        assert!(!serde_json::to_string(&log.snapshot(AgentId::Codex, false))
            .unwrap()
            .contains("private-error"));
    }
}
