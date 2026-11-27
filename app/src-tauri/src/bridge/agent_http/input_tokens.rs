use super::*;
use serde_json::Map;

const COUNT_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_COUNT_BODY: usize = 512 * 1024;
const MAX_COUNT_RESPONSE: usize = 16 * 1024;
const DEFAULT_OUTPUT_RESERVE: u64 = 8192;
const INPUT_KEYS: &[&str] = &[
    "model",
    "input",
    "instructions",
    "parallel_tool_calls",
    "personality",
    "reasoning",
    "text",
    "tool_choice",
    "tools",
    "truncation",
];
const GENERATION_ONLY_KEYS: &[&str] = &[
    "client_metadata",
    "include",
    "max_output_tokens",
    "metadata",
    "prompt_cache_key",
    "prompt_cache_retention",
    "safety_identifier",
    "service_tier",
    "store",
    "stream",
    "stream_options",
    "temperature",
    "top_logprobs",
    "top_p",
    "user",
];

fn text_content(value: &Value) -> bool {
    value.is_string()
        || value.as_array().is_some_and(|items| {
            items.iter().all(|item| match item["type"].as_str() {
                Some("input_text" | "output_text") => item["text"].is_string(),
                Some("refusal") => item["refusal"].is_string(),
                _ => false,
            })
        })
}

fn explicit_input(value: &Value) -> bool {
    value.is_string()
        || value.as_array().is_some_and(|items| {
            items.iter().all(|item| {
                if item
                    .get("encrypted_content")
                    .is_some_and(|value| !value.is_null())
                {
                    return false;
                }
                match item["type"].as_str() {
                    Some("message") | None => {
                        item["role"].is_string() && text_content(&item["content"])
                    }
                    Some("function_call") => {
                        item["call_id"].is_string()
                            && item["name"].is_string()
                            && item["arguments"].is_string()
                    }
                    Some("function_call_output") => {
                        item["call_id"].is_string() && text_content(&item["output"])
                    }
                    Some("custom_tool_call") => {
                        item["call_id"].is_string()
                            && item["name"].is_string()
                            && item["input"].is_string()
                    }
                    Some("custom_tool_call_output") => {
                        item["call_id"].is_string() && text_content(&item["output"])
                    }
                    _ => false,
                }
            })
        })
}

fn static_tool(tool: &Value) -> bool {
    let Some(kind @ ("function" | "custom")) = tool["type"].as_str() else {
        return false;
    };
    tool["name"].as_str().is_some_and(|name| !name.is_empty())
        && tool
            .get("defer_loading")
            .is_none_or(|value| value.is_null() || value == false)
        && tool.as_object().is_some_and(|object| {
            object.keys().all(|key| {
                matches!(
                    key.as_str(),
                    "type" | "name" | "description" | "allowed_callers" | "async" | "defer_loading"
                ) || match kind {
                    "function" => matches!(key.as_str(), "parameters" | "strict" | "output_schema"),
                    _ => key == "format",
                }
            })
        })
}

fn countable_tool(tool: &Value) -> bool {
    if static_tool(tool) {
        return true;
    }
    // The Responses input counter uses the same Tool union as generation.
    // A namespace contributes its explicit descriptions and local tool
    // schemas. Hosted and dynamically loaded tools remain refused.
    tool["type"] == "namespace"
        && tool["name"].as_str().is_some_and(|name| !name.is_empty())
        && tool["description"].is_string()
        && tool.as_object().is_some_and(|object| {
            object
                .keys()
                .all(|key| matches!(key.as_str(), "type" | "name" | "description" | "tools"))
        })
        && tool["tools"]
            .as_array()
            .is_some_and(|tools| !tools.is_empty() && tools.iter().all(static_tool))
}

fn count_body(body: &Value, model: &str, window: u64) -> Option<(Value, u64)> {
    let object = body.as_object()?;
    if object.get("model")?.as_str()? != model || !explicit_input(object.get("input")?) {
        return None;
    }
    if object.keys().any(|key| {
        !INPUT_KEYS.contains(&key.as_str())
            && !GENERATION_ONLY_KEYS.contains(&key.as_str())
            && !(matches!(key.as_str(), "previous_response_id" | "conversation")
                && object[key].is_null())
    }) {
        return None;
    }
    if object
        .get("truncation")
        .is_some_and(|value| !value.is_null() && value != "disabled")
    {
        return None;
    }
    if object.get("tools").is_some_and(|value| {
        !value.is_null()
            && !value
                .as_array()
                .is_some_and(|tools| tools.iter().all(countable_tool))
    }) {
        return None;
    }
    let output = match object.get("max_output_tokens") {
        None | Some(Value::Null) => DEFAULT_OUTPUT_RESERVE,
        Some(value) => value.as_u64()?,
    };
    if !(16..window).contains(&output) {
        return None;
    }
    let mut count: Map<_, _> = INPUT_KEYS
        .iter()
        .filter_map(|key| {
            object
                .get(*key)
                .map(|value| ((*key).to_owned(), value.clone()))
        })
        .collect();
    count.insert("truncation".into(), json!("disabled"));
    let count = Value::Object(count);
    let bound = serde_json::to_vec(&count).ok()?.len();
    if bound > MAX_COUNT_BODY || bound as u64 > window.saturating_mul(8) {
        return None;
    }
    Some((count, output))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CountResponse {
    object: String,
    input_tokens: u64,
}

async fn count_upstream(
    runtime: &Runtime,
    provider: &StoredProvider,
    count: &Value,
) -> Option<u64> {
    let generation = provider_resource_url(provider, "responses").ok()?;
    let mut target = generation.clone();
    target.path_segments_mut().ok()?.push("input_tokens");
    if target.origin() != generation.origin() {
        return None;
    }
    let mut request = runtime
        .client
        .post(target)
        .header("user-agent", "AE-Switch/0.1.0")
        .header(header::ACCEPT, "application/json")
        .json(count);
    request = if provider.summary.auth_mode == "x-api-key" {
        request.header("x-api-key", &provider.api_key)
    } else {
        request.bearer_auth(&provider.api_key)
    };
    // The shared client's redirect policy is disabled. Keep a total deadline
    // covering both header receipt and the bounded JSON response body.
    tokio::time::timeout(COUNT_TIMEOUT, async {
        let mut response = request.send().await.ok()?;
        if response.status() != StatusCode::OK
            || !response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| {
                    value
                        .split(';')
                        .next()
                        .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
                })
        {
            return None;
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.ok()? {
            if bytes.len().saturating_add(chunk.len()) > MAX_COUNT_RESPONSE {
                return None;
            }
            bytes.extend_from_slice(&chunk);
        }
        let result: CountResponse = serde_json::from_slice(&bytes).ok()?;
        (result.object == "response.input_tokens" && result.input_tokens > 0)
            .then_some(result.input_tokens)
    })
    .await
    .ok()
    .flatten()
}

pub(super) async fn authorize(
    runtime: &Runtime,
    provider: &StoredProvider,
    body: &mut Value,
) -> bool {
    let Some(policy) = provider
        .summary
        .codex_options
        .applied_context_policy
        .as_ref()
    else {
        return false;
    };
    if policy.long_context_enabled
        || provider.summary.upstream_protocol() != CodexProtocol::Openai
        || crate::context_policy::validate_applied(&provider.summary, policy).is_err()
    {
        return false;
    }
    let Ok(window) = u64::try_from(policy.context_window) else {
        return false;
    };
    let Some((count, reserve)) = count_body(body, &provider.summary.model, window) else {
        return false;
    };
    let Some(tokens) = count_upstream(runtime, provider, &count).await else {
        return false;
    };
    if tokens
        .checked_add(reserve)
        .is_none_or(|total| total > window)
    {
        return false;
    }
    // Carry exactly the framing fields used by the counter (including the
    // disabled truncation policy) into the one authorized Responses call.
    body["truncation"] = count["truncation"].clone();
    body["max_output_tokens"] = json!(reserve);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forwards_only_recognized_count_framing_and_enforces_a_reserve() {
        let original = json!({
            "model":"m",
            "input":[{"role":"user","content":[{"type":"input_text","text":"test"}]}],
            "instructions":"system",
            "stream":true,
            "store":false,
            "client_metadata":{"example":"ignored"},
            "reasoning":{"effort":"high"},
            "tools":[{"type":"function","name":"local","parameters":{"type":"object"}}]
        });
        let (count, output) = count_body(&original, "m", 80_000).unwrap();
        assert_eq!(output, 8192);
        for key in ["model", "input", "instructions", "reasoning", "tools"] {
            assert_eq!(count[key], original[key]);
        }
        assert_eq!(count["truncation"], "disabled");
        assert_eq!(count.as_object().unwrap().len(), 6);
        let mut bounded = original.clone();
        bounded["max_output_tokens"] = json!(2048);
        assert_eq!(count_body(&bounded, "m", 80_000).unwrap().1, 2048);
        for (key, value) in [
            ("input", json!([{"type":"item_reference","id":"item_x"}])),
            (
                "input",
                json!([{"type":"reasoning","encrypted_content":"opaque"}]),
            ),
            ("tools", json!([{"type":"file_search"}])),
            (
                "input",
                json!([{"role":"user","content":[{"type":"input_image","image_url":"URL"}]}]),
            ),
            ("truncation", json!("auto")),
            ("max_output_tokens", json!(80_000)),
            ("max_output_tokens", json!("2048")),
            ("prompt", json!({"id":"prompt_remote"})),
            ("previous_response_id", json!("resp_remote")),
            ("conversation", json!("conv_remote")),
            ("unknown_frame", json!({"data":"injection"})),
        ] {
            let mut rejected = original.clone();
            rejected[key] = value;
            assert!(count_body(&rejected, "m", 80_000).is_none(), "{key}");
        }
    }

    #[test]
    fn counts_documented_codex_namespaces_only_with_explicit_local_tools() {
        let namespace = json!({
            "type":"namespace",
            "name":"multi_agent_v1",
            "description":"Local Codex collaboration",
            "tools":[{"type":"function","name":"spawn_agent","description":"Local dispatch",
                    "parameters":{"type":"object"},"strict":true},
                {"type":"custom","name":"local_tool","description":"Local input","format":{"type":"text"}}]
        });
        let generation = json!({
            "model":"m","input":"prompt","tools":[namespace.clone()]
        });
        assert_eq!(
            count_body(&generation, "m", 80_000).unwrap().0["tools"],
            generation["tools"]
        );
        for tool in [
            json!({"type":"web_search"}),
            json!({"type":"function","name":"deferred","defer_loading":true}),
            json!({"type":"function","name":"foreign","server_url":"https://example.invalid"}),
            namespace,
        ] {
            let mut rejected = generation.clone();
            rejected["tools"][0]["tools"][0] = tool;
            assert!(count_body(&rejected, "m", 80_000).is_none());
        }
    }
}
