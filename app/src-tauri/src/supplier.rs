use crate::error::{AppError, Result};
use crate::types::{
    valid_effort, validate_balance, validate_url, BalanceQuery, CodexProtocol, ModelSyncResult,
    ProviderModel,
};
use serde_json::Value;
use std::collections::HashSet;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

// Redirects are rejected so credentials never follow a supplier to a different host.
async fn get_json_with_user(url: url::Url, key: &str, user_id: Option<&str>) -> Result<Value> {
    read_json(
        &supplier_client()?,
        url,
        Some(key),
        user_id,
        Duration::from_secs(15),
    )
    .await
}
fn supplier_client() -> Result<reqwest::Client> {
    supplier_client_headers(false)
}
fn supplier_client_headers(anthropic: bool) -> Result<reqwest::Client> {
    let mut headers = reqwest::header::HeaderMap::new();
    if anthropic {
        headers.insert(
            "anthropic-version",
            reqwest::header::HeaderValue::from_static("2023-06-01"),
        );
    }
    reqwest::Client::builder()
        .default_headers(headers)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .connect_timeout(Duration::from_secs(8))
        .build()
        .map_err(|_| AppError::new("network", "无法建立供应商连接"))
}
async fn read_json(
    client: &reqwest::Client,
    url: url::Url,
    key: Option<&str>,
    user_id: Option<&str>,
    timeout: Duration,
) -> Result<Value> {
    read_json_with_auth(client, url, key, user_id, timeout, false).await
}
async fn read_json_with_auth(
    client: &reqwest::Client,
    url: url::Url,
    key: Option<&str>,
    user_id: Option<&str>,
    timeout: Duration,
    anthropic_auth: bool,
) -> Result<Value> {
    let mut request = client
        .get(url)
        .timeout(timeout)
        .header("Accept", "application/json")
        .header("User-Agent", "uni-switch/0.3.2");
    if let Some(key) = key {
        request = if anthropic_auth {
            request
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01")
        } else {
            request.bearer_auth(key)
        };
    }
    if let Some(id) = user_id {
        request = request.header("New-Api-User", id);
    }
    let mut response = request.send().await.map_err(|error| {
        AppError::new(
            "network",
            if error.is_timeout() {
                "供应商查询超时，请稍后重试"
            } else {
                "无法连接供应商，请检查地址、网络和证书"
            },
        )
    })?;
    let status = response.status();
    if !status.is_success() {
        let hint = match status.as_u16() {
            401 | 403 => "密钥无效或没有此查询接口的权限",
            404 | 405 => "供应商不支持此接口，请检查查询路径",
            429 => "供应商限制了查询频率，请稍后重试",
            300..=399 => "接口要求重定向，请填写最终地址后重试",
            _ => "供应商接口暂时无法查询",
        };
        return Err(AppError::new(
            "supplier_http",
            format!("{hint}（HTTP {}）", status.as_u16()),
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| AppError::new("network", "读取供应商响应失败"))?
    {
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
            return Err(AppError::new(
                "response_limit",
                "供应商响应超过 2 MB，无法读取",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| AppError::new("supplier_json", "供应商返回了无效 JSON，请检查接口路径"))
}

fn model_items(value: &Value) -> Option<&[Value]> {
    // Keep the accepted envelopes deliberately small.  In particular, a bare
    // JSON array is not a model catalogue because accepting arbitrary arrays
    // makes an unrelated successful endpoint look like a model query.
    let object = value.as_object()?;
    if object.get("success").and_then(Value::as_bool) == Some(false)
        || object.get("error").is_some_and(|value| !value.is_null())
    {
        return None;
    }
    object
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| object.get("models").and_then(Value::as_array))
        .or_else(|| {
            object
                .get("data")
                .and_then(|data| data.get("models")?.as_array())
        })
        .or_else(|| {
            object
                .get("result")
                .and_then(|result| result.get("models")?.as_array())
        })
        .map(Vec::as_slice)
}

fn model_metadata<'a>(
    item: &'a Value,
    keys: &'static [&'static str],
) -> impl Iterator<Item = &'a Value> + 'a {
    [Some(item), item.get("capabilities"), item.get("metadata")]
        .into_iter()
        .flatten()
        .flat_map(|object| keys.iter().filter_map(move |key| object.get(key)))
}

fn reported_window(item: &Value) -> Option<i64> {
    model_metadata(
        item,
        &[
            "context_window",
            "contextWindow",
            "context_length",
            "contextLength",
            "max_context_length",
            "maxContextLength",
            "max_model_len",
            "maxModelLen",
            "max_context_tokens",
            "input_token_limit",
            "inputTokenLimit",
        ],
    )
    .filter_map(|value| {
        value
            .as_i64()
            .or_else(|| value.as_str().and_then(|value| value.trim().parse().ok()))
    })
    .filter(|value| (1..=100_000_000).contains(value))
    .min()
}

fn reasoning_efforts(item: &Value) -> Vec<String> {
    model_metadata(
        item,
        &[
            "supported_reasoning_levels",
            "supported_reasoning_efforts",
            "reasoning_efforts",
            "reasoningEfforts",
        ],
    )
    .find_map(Value::as_array)
    .map(|values| {
        let mut seen = HashSet::new();
        values
            .iter()
            .filter_map(|value| {
                value
                    .as_str()
                    .or_else(|| value.get("effort").and_then(Value::as_str))
            })
            .filter(|effort| valid_effort(effort) && seen.insert(*effort))
            .map(str::to_owned)
            .collect()
    })
    .unwrap_or_default()
}

fn collect_model(models: &mut Vec<ProviderModel>, model: ProviderModel) -> Result<()> {
    let Some(existing) = models.iter_mut().find(|existing| existing.id == model.id) else {
        models.push(model);
        return Ok(());
    };
    if let Some(capabilities) = model.context_capabilities {
        if existing
            .context_capabilities
            .as_ref()
            .is_some_and(|current| *current != capabilities)
        {
            return Err(AppError::new(
                "model_response",
                "供应商为同一模型返回了不一致的上下文和计费声明",
            ));
        }
        existing.context_capabilities = Some(capabilities);
    }
    existing.context_window = [existing.context_window, model.context_window]
        .into_iter()
        .flatten()
        .min();
    if existing.reasoning_efforts.is_empty() {
        existing.reasoning_efforts = model.reasoning_efforts;
    }
    Ok(())
}

pub fn parse_models(value: &Value) -> Result<Vec<ProviderModel>> {
    let items = model_items(value)
        .ok_or_else(|| AppError::new("model_response", "模型接口需返回 data 或 models 数组"))?;
    if items.len() > 500 {
        return Err(AppError::new(
            "model_limit",
            "供应商返回了超过 500 个模型，请缩小模型列表",
        ));
    }
    let mut models = Vec::new();
    for item in items {
        let id = item
            .as_str()
            .or_else(|| item.get("id").and_then(Value::as_str))
            .or_else(|| item.get("slug").and_then(Value::as_str))
            .or_else(|| item.get("model_id").and_then(Value::as_str))
            .unwrap_or_default();
        let trimmed = id.trim();
        if trimmed.is_empty() || trimmed.len() > 256 || id.chars().any(char::is_control) {
            return Err(AppError::new(
                "model_response",
                "模型接口返回了无效的模型 ID",
            ));
        }
        collect_model(
            &mut models,
            ProviderModel {
                id: trimmed.to_owned(),
                context_window: reported_window(item),
                context_capabilities: crate::context_policy::endpoint_capabilities(item)?,
                reasoning_efforts: reasoning_efforts(item),
                enabled: true,
            },
        )?;
    }
    if models.is_empty() {
        return Err(AppError::new(
            "no_models",
            "此密钥没有返回可用模型，原模型列表已保留",
        ));
    }
    models.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(models)
}

pub async fn sync_models(base_url: &str, key: &str, auth_mode: &str) -> Result<ModelSyncResult> {
    sync_models_protocol(base_url, key, auth_mode, false).await
}
pub async fn sync_models_protocol(
    base_url: &str,
    key: &str,
    auth_mode: &str,
    anthropic: bool,
) -> Result<ModelSyncResult> {
    let endpoint = ModelEndpoint::parse(base_url)?;
    sync_models_detect(
        &endpoint,
        key,
        auth_mode,
        Some(if anthropic {
            CodexProtocol::Anthropic
        } else {
            CodexProtocol::Openai
        }),
        Instant::now() + Duration::from_secs(25),
    )
    .await
}

pub async fn discover_connection(
    base_url: &str,
    key: &str,
    protocol: Option<CodexProtocol>,
    auth: Option<&str>,
) -> Result<ModelSyncResult> {
    let endpoint = ModelEndpoint::parse(base_url)?;
    let modes = if let Some(auth) = auth {
        vec![auth]
    } else if endpoint.native_host {
        vec!["x-api-key", "bearer"]
    } else {
        vec!["bearer", "x-api-key"]
    };
    let deadline = Instant::now() + Duration::from_secs(25);
    let mut last = AppError::new("no_models", "未能自动匹配，请检查地址与密钥");
    for auth in modes {
        match sync_models_detect(&endpoint, key, auth, protocol, deadline).await {
            Ok(result) => return Ok(result),
            Err(e) if e.message.contains("HTTP 401") || e.message.contains("HTTP 403") => {
                last = e;
            }
            Err(e) => return Err(e),
        }
    }
    Err(last)
}

struct ModelEndpoint {
    base: url::Url,
    model_urls: Vec<url::Url>,
    protocol_hint: Option<CodexProtocol>,
    native_host: bool,
}

impl ModelEndpoint {
    fn parse(value: &str) -> Result<Self> {
        let mut base = validate_url(value.trim())?;
        let path = base.path().trim_end_matches('/');
        let (prefix, protocol_hint, explicit_route) =
            if let Some(prefix) = path.strip_suffix("/models") {
                (prefix, None, true)
            } else if let Some(prefix) = path.strip_suffix("/messages") {
                (prefix, Some(CodexProtocol::Anthropic), true)
            } else if let Some(prefix) = path
                .strip_suffix("/responses")
                .or_else(|| path.strip_suffix("/chat/completions"))
            {
                (prefix, Some(CodexProtocol::Openai), true)
            } else {
                (path, None, false)
            };
        let mut models = base.clone();
        models.set_path(&format!("{prefix}/models"));
        let mut model_urls = vec![models];
        let versioned = prefix.rsplit('/').next().is_some_and(|segment| {
            segment.strip_prefix('v').is_some_and(|version| {
                !version.is_empty() && version.bytes().all(|byte| byte.is_ascii_digit())
            })
        });
        if !explicit_route && !versioned && !prefix.ends_with("/backend-api/codex") {
            let mut models = base.clone();
            models.set_path(&format!("{prefix}/v1/models"));
            model_urls.push(models);
        }
        let prefix = prefix.to_owned();
        base.set_path(&prefix);
        let native_host = base.scheme() == "https"
            && base.host_str() == Some("api.anthropic.com")
            && base.port_or_known_default() == Some(443);
        Ok(Self {
            base,
            model_urls,
            protocol_hint,
            native_host,
        })
    }
}

fn contains_key(value: &str, key: &str) -> bool {
    value == key || (key.len() >= 8 && value.contains(key))
}

async fn sync_models_detect(
    endpoint: &ModelEndpoint,
    key: &str,
    auth_mode: &str,
    forced: Option<CodexProtocol>,
    deadline: Instant,
) -> Result<ModelSyncResult> {
    if !matches!(auth_mode, "bearer" | "x-api-key") {
        return Err(AppError::new("invalid_auth", "模型查询认证方式无效"));
    }
    if key.trim().is_empty() || key.chars().any(char::is_control) {
        return Err(AppError::new("invalid_key", "请填写有效的 API Key"));
    }
    let client = supplier_client_headers(
        forced.or(endpoint.protocol_hint) == Some(CodexProtocol::Anthropic)
            || forced.is_none() && endpoint.native_host,
    )?;
    let mut last_error = AppError::new("no_models", "未找到可用的模型接口");
    for mut url in endpoint.model_urls.iter().cloned() {
        let mut collected = Vec::new();
        let mut cursors = HashSet::new();
        let mut detected = None;
        for _ in 0..10 {
            let timeout = deadline.saturating_duration_since(Instant::now());
            if timeout.is_zero() {
                return Err(AppError::new("network", "模型同步超时，请稍后重试"));
            }
            let value = match read_json_with_auth(
                &client,
                url.clone(),
                Some(key),
                None,
                timeout.min(Duration::from_secs(10)),
                auth_mode == "x-api-key",
            )
            .await
            {
                Ok(v) => v,
                Err(e)
                    if e.message.contains("HTTP 404")
                        || e.message.contains("HTTP 405")
                        || e.code == "supplier_json" =>
                {
                    last_error = e;
                    break;
                }
                Err(e) => return Err(e),
            };
            let models = match parse_models(&value) {
                Ok(v) => v,
                Err(e) if e.code == "model_response" => {
                    last_error = e;
                    break;
                }
                Err(e) => return Err(e),
            };
            for model in models {
                if contains_key(&model.id, key) {
                    return Err(AppError::new("model_response", "供应商返回了无效的模型 ID"));
                }
                collect_model(&mut collected, model)?;
            }
            if collected.len() > 500 {
                return Err(AppError::new(
                    "model_limit",
                    "供应商返回了超过 500 个模型，请缩小模型列表",
                ));
            }
            if forced.is_none() {
                if let Some(protocol) = model_protocol(&value) {
                    if detected.is_some_and(|previous| previous != protocol) {
                        return Err(AppError::new(
                            "model_response",
                            "供应商分页返回了不一致的接口协议",
                        ));
                    }
                    detected = Some(protocol);
                }
            }
            if value.get("has_more").and_then(Value::as_bool) != Some(true) {
                collected.sort_by(|a, b| a.id.cmp(&b.id));
                let protocol = forced.or(detected).or(endpoint.protocol_hint).unwrap_or(
                    if endpoint.native_host {
                        CodexProtocol::Anthropic
                    } else {
                        CodexProtocol::Openai
                    },
                );
                let mut resolved = url.clone();
                resolved.set_query(None);
                let path = resolved
                    .path()
                    .strip_suffix("/models")
                    .unwrap_or_default()
                    .to_owned();
                resolved.set_path(&path);
                let resolved_base = if protocol == CodexProtocol::Openai {
                    resolved.as_str()
                } else {
                    endpoint.base.as_str()
                }
                .trim_end_matches('/')
                .to_owned();
                for model in &mut collected {
                    crate::context_policy::bind_discovered(model, &resolved_base, key, auth_mode)?;
                }
                return Ok(ModelSyncResult {
                    models: collected,
                    synced_at: now(),
                    protocol,
                    auth_mode: auth_mode.into(),
                    base_url: resolved_base,
                });
            }
            let last = value
                .get("last_id")
                .and_then(Value::as_str)
                .filter(|s| {
                    !s.is_empty()
                        && s.len() <= 512
                        && !s.chars().any(char::is_control)
                        && !contains_key(s, key)
                })
                .filter(|s| cursors.insert((*s).to_owned()))
                .ok_or_else(|| AppError::new("model_response", "模型分页返回了无效的下一页标识"))?;
            url.set_query(None);
            url.query_pairs_mut().append_pair("after_id", last);
        }
        if !collected.is_empty() {
            return Err(AppError::new(
                "model_limit",
                "模型分页未完成，未保存不完整列表",
            ));
        }
    }
    Err(last_error)
}

fn model_protocol(value: &Value) -> Option<CodexProtocol> {
    let items = model_items(value);
    // OpenAI gateways also paginate. Explicit schema markers take precedence.
    if value.get("object").and_then(Value::as_str) == Some("list")
        || items.is_some_and(|items| {
            items
                .iter()
                .any(|m| m.get("object").and_then(Value::as_str) == Some("model"))
        })
    {
        Some(CodexProtocol::Openai)
    } else if items.is_some_and(|items| {
        items
            .iter()
            .any(|m| m.get("type").and_then(Value::as_str) == Some("model"))
    }) {
        Some(CodexProtocol::Anthropic)
    } else {
        None
    }
}

pub fn parse_balance(value: &Value, query: &BalanceQuery) -> Result<f64> {
    validate_balance(query)?;
    if value.get("success").and_then(Value::as_bool) == Some(false)
        || value.get("error").is_some_and(|v| !v.is_null())
    {
        return Err(AppError::new(
            "balance_response",
            "供应商返回查询失败，请检查密钥和余额接口权限",
        ));
    }
    let amount = query
        .json_path
        .split('.')
        .try_fold(value, |current, key| {
            current
                .get(key)
                .or_else(|| key.parse::<usize>().ok().and_then(|i| current.get(i)))
        })
        .and_then(|v| {
            v.as_f64()
                .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
        })
        .ok_or_else(|| {
            AppError::new(
                "balance_field",
                "响应中没有有效的余额数值，请检查余额字段路径",
            )
        })?
        / query.divisor;
    if !amount.is_finite() {
        return Err(AppError::new("balance_field", "余额换算结果无效"));
    }
    Ok(amount)
}

mod balance;
pub use balance::{balance_site_url, query_balance};
mod auto_balance;
pub use auto_balance::query_auto_balance;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{Read, Write};
    #[test]
    fn schema_markers_take_precedence_over_generic_pagination() {
        use crate::types::CodexProtocol::*;
        assert_eq!(
            model_protocol(
                &json!({"object":"list","has_more":false,"data":[{"id":"claude-sonnet-4-6","object":"model"}]})
            ),
            Some(Openai)
        );
        assert_eq!(
            model_protocol(&json!({"has_more":false,"data":[{"id":"gpt-5.4"}]})),
            None
        );
        assert_eq!(
            model_protocol(
                &json!({"has_more":false,"data":[{"id":"claude-sonnet-4-6","type":"model"}]})
            ),
            Some(Anthropic)
        );
        assert_eq!(
            model_protocol(&json!({"has_more":true,"data":[{"id":"claude-sonnet-4-6"}]})),
            None
        );
    }
    #[tokio::test]
    async fn automatic_discovery_falls_back_only_on_auth_failures_and_honors_override() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for status in ["401 Unauthorized", "200 OK"] {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut buf = [0; 8192];
                let n = stream.read(&mut buf).unwrap();
                requests.push(String::from_utf8_lossy(&buf[..n]).to_lowercase());
                let body =
                    r#"{"data":[{"id":"claude-sonnet-4-6","type":"model"}],"has_more":false}"#;
                write!(stream,"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
            requests
        });
        let result = discover_connection(&url, "private-probe-key", None, None)
            .await
            .unwrap();
        assert_eq!(result.protocol, crate::types::CodexProtocol::Anthropic);
        assert_eq!(result.auth_mode, "x-api-key");
        let requests = worker.join().unwrap();
        assert!(requests[0].contains("authorization: bearer private-probe-key"));
        assert!(requests[1].contains("x-api-key: private-probe-key"));
        assert!(requests.iter().all(|r| r.starts_with("get /v1/models ")));
        let (url, worker) = server(
            r#"{"data":[{"id":"claude-sonnet-4-6","type":"model"}]}"#,
            "200 OK",
        );
        let result = discover_connection(
            &url,
            "private-probe-key",
            Some(crate::types::CodexProtocol::Openai),
            Some("x-api-key"),
        )
        .await
        .unwrap();
        assert_eq!(result.protocol, crate::types::CodexProtocol::Openai);
        assert!(worker
            .join()
            .unwrap()
            .to_lowercase()
            .contains("x-api-key: private-probe-key"));
        let (url, worker) = server(r#"{"error":"private-probe-key"}"#, "429 Too Many Requests");
        let error = discover_connection(&url, "private-probe-key", None, None)
            .await
            .unwrap_err();
        worker.join().unwrap();
        assert!(error.message.contains("429"));
        assert!(!error.message.contains("private-probe-key"));
    }
    fn query() -> BalanceQuery {
        BalanceQuery {
            path: "/balance".into(),
            json_path: "data.balance".into(),
            unit: "USD".into(),
            divisor: 1.0,
            ..BalanceQuery::default()
        }
    }
    fn adapter_query(adapter: crate::types::BalanceAdapter) -> BalanceQuery {
        BalanceQuery {
            adapter,
            user_id: Some("42".into()),
            divisor: 500_000.0,
            ..BalanceQuery::default()
        }
    }
    #[test]
    fn adapters_parse_real_newapi_units_unlimited_and_account_balance() {
        use crate::types::BalanceAdapter::*;
        use balance::parse_adapter_balance;
        let account = parse_adapter_balance(&json!({"success":true,"data":{"quota":6250000,"used_quota":1000000,"group":"default"}}), &adapter_query(NewapiAccount)).unwrap();
        assert_eq!(account.amount, Some(12.5));
        assert_eq!(account.used, Some(2.0));
        assert_eq!(account.total, Some(14.5));
        let token = json!({"code":true,"message":"ok","data":{"object":"token_usage","total_available":0,"total_granted":500000,"total_used":500000,"unlimited_quota":false,"expires_at":0}});
        let result = parse_adapter_balance(&token, &adapter_query(NewapiToken)).unwrap();
        assert_eq!(result.amount, Some(0.0));
        assert_eq!(result.used, Some(1.0));
        assert!(result.expires_at.is_none());
        let unlimited = parse_adapter_balance(&json!({"code":true,"data":{"total_available":0,"total_used":0,"unlimited_quota":true}}), &adapter_query(NewapiToken)).unwrap();
        assert!(unlimited.unlimited);
        assert_eq!(unlimited.amount, None);
        assert!(parse_adapter_balance(
            &json!({"success":false,"message":"secret"}),
            &adapter_query(NewapiAccount)
        )
        .is_err());
        assert!(parse_adapter_balance(
            &json!({"code":false,"data":{}}),
            &adapter_query(NewapiToken)
        )
        .is_err());
    }
    #[test]
    fn sub2api_distinguishes_wallet_key_subscription_and_rate_windows() {
        use crate::types::BalanceAdapter::Sub2api;
        use balance::parse_adapter_balance;
        let q = adapter_query(Sub2api);
        let wallet = parse_adapter_balance(&json!({"mode":"unrestricted","isValid":true,"planName":"钱包余额","remaining":12.5,"balance":12.5,"unit":"USD"}), &q).unwrap();
        assert_eq!(wallet.scope, "账户余额");
        assert_eq!(wallet.amount, Some(12.5));
        let quota = parse_adapter_balance(&json!({"mode":"quota_limited","isValid":true,"quota":{"limit":100,"used":10,"remaining":90,"unit":"USD"},"remaining":90,"rate_limits":[{"window":"5h","limit":5,"used":2,"remaining":3,"reset_at":"2026-10-06T22:00:00Z"}]}), &q).unwrap();
        assert_eq!(quota.scope, "密钥额度");
        assert_eq!(quota.amount, Some(90.0));
        assert_eq!(quota.windows[0].remaining, 3.0);
        let subscription = parse_adapter_balance(&json!({"mode":"unrestricted","isValid":true,"planName":"月套餐","remaining":8,"subscription":{"daily_limit_usd":10,"daily_usage_usd":2,"weekly_limit_usd":50,"weekly_usage_usd":45,"monthly_limit_usd":null,"monthly_usage_usd":0,"expires_at":"2026-11-01T00:00:00Z"}}), &q).unwrap();
        assert_eq!(subscription.scope, "订阅额度");
        assert_eq!(subscription.amount, Some(5.0));
        assert_eq!(subscription.windows.len(), 2);
        let unlimited = parse_adapter_balance(&json!({"mode":"unrestricted","isValid":true,"remaining":-1,"subscription":{"daily_limit_usd":null,"weekly_limit_usd":null,"monthly_limit_usd":null}}), &q).unwrap();
        assert!(unlimited.unlimited);
        let rates = parse_adapter_balance(&json!({"mode":"quota_limited","isValid":true,"rate_limits":[{"window":"1d","limit":10,"used":12,"remaining":0}]}), &q).unwrap();
        assert_eq!(rates.amount, Some(0.0));
        assert!(parse_adapter_balance(&json!({"isValid":false,"remaining":100}), &q).is_err());
        assert!(parse_adapter_balance(&json!({"is_active":false,"remaining":100}), &q).is_err());
        assert!(parse_adapter_balance(&json!({"mode":"quota_limited"}), &q).is_err());
    }
    #[tokio::test]
    async fn adapters_use_upstream_paths_credentials_and_proxy_prefixes() {
        use crate::types::BalanceAdapter::*;
        let (url, s) = server(
            r#"{"success":true,"data":{"quota":500000,"used_quota":0}}"#,
            "200 OK",
        );
        query_balance(
            &format!("{url}/gateway/v1"),
            "console-access-token",
            adapter_query(NewapiAccount),
        )
        .await
        .unwrap();
        let request = s.join().unwrap().to_lowercase();
        assert!(request.starts_with("get /gateway/api/user/self "));
        assert!(request.contains("new-api-user: 42"));
        assert!(request.contains("authorization: bearer console-access-token"));
        let (url, s) = server(
            r#"{"code":true,"data":{"total_available":500000,"total_used":0,"total_granted":500000,"unlimited_quota":false}}"#,
            "200 OK",
        );
        query_balance(
            &format!("{url}/v1/"),
            "sk-inference-key",
            adapter_query(NewapiToken),
        )
        .await
        .unwrap();
        let request = s.join().unwrap().to_lowercase();
        assert!(request.starts_with("get /api/usage/token/ "));
        assert!(!request.contains("new-api-user"));
        let (url, s) = server(
            r#"{"isValid":true,"mode":"unrestricted","balance":0}"#,
            "200 OK",
        );
        query_balance(
            &format!("{url}/gateway/v1"),
            "sub2api-key",
            adapter_query(Sub2api),
        )
        .await
        .unwrap();
        assert!(s.join().unwrap().starts_with("GET /gateway/v1/usage "));
        let (url, s) = server(r#"{"isValid":true,"balance":2}"#, "200 OK");
        let mut q = adapter_query(Sub2api);
        q.site_url = Some(format!("{url}/console"));
        query_balance("https://unused.example.test/v1", "sub2api-key", q)
            .await
            .unwrap();
        assert!(s.join().unwrap().starts_with("GET /console/v1/usage "));
    }
    #[test]
    fn discovery_deduplicates_and_preserves_capabilities_without_inventing_them() {
        let models = parse_models(&json!({"data":[{"id":"b"},{"id":"a","context_window":128000,"reasoning_efforts":["high","invalid"]},{"id":"b"}]})).unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].context_window, Some(128000));
        assert_eq!(models[0].reasoning_efforts, vec!["high"]);
        assert!(models[1].reasoning_efforts.is_empty());
        assert!(parse_models(&json!({"data":[]})).is_err());
        assert!(parse_models(&json!({"data":[{"id":"bad\nmodel"}]})).is_err());
    }
    #[test]
    fn discovery_accepts_explicit_reasoning_capability_formats_without_guessing() {
        let models = parse_models(&json!({"data":[
            {"id":"a","supported_reasoning_levels":[{"effort":"high"},{"effort":"high"},{"effort":"ultra"},{"effort":"invalid"}]},
            {"id":"b","supported_reasoning_efforts":["none","low","xhigh"]},
            {"id":"gpt-6.1-sol"}
        ]})).unwrap();
        assert_eq!(models[0].reasoning_efforts, ["high", "ultra"]);
        assert_eq!(models[1].reasoning_efforts, ["none", "low", "xhigh"]);
        assert!(models[2].reasoning_efforts.is_empty());
    }

    #[test]
    fn discovery_reads_reported_windows_without_inventing_a_tariff() {
        let models = parse_models(&json!({"success":true,"data":{"models":[
            {"id":"existing"},
            {"id":"existing","max_model_len": 8192},
            {"slug":"gateway/alias","context_length":"1000000","capabilities":{"contextWindow":272000,"reasoningEfforts":["high"]}},
            {"model_id":"invalid-window","contextWindow":"-10","max_context_length":100000001},
            {"id":"unpriced","metadata":{"inputTokenLimit":"1000000","max_output_tokens":100000}},
            {"id":"generic-pricing","pricing":{"prompt":"0.005"},"context_length":1000000}
        ]}})).unwrap();
        assert_eq!(models[0].context_window, Some(8192));
        assert_eq!(models[1].context_window, Some(272000));
        assert_eq!(models[1].reasoning_efforts, ["high"]);
        assert_eq!(models[2].context_window, Some(1000000));
        assert_eq!(models[3].context_window, None);
        assert_eq!(models[4].context_window, Some(1000000));
        assert!(models
            .iter()
            .all(|model| model.context_capabilities.is_none()));
        for rejected in [
            json!([{"id":"unrelated"}]),
            json!({"success":false,"data":[{"id":"unauthorized"}]}),
            json!({"error":{"message":"unauthorized"},"data":[{"id":"unrelated"}]}),
            json!({"models":[{"name":"display only"}]}),
            json!({"models":["bad\n"]}),
            json!({"models":[{"id":"conflict","context_policy":{"standard_context_window":272000,"long_context_window":1000000,"surcharge":true}},{"id":"conflict","context_policy":{"standard_context_window":272000,"long_context_window":1000000,"surcharge":false}}]}),
        ] {
            assert!(parse_models(&rejected).is_err());
        }
    }
    #[test]
    fn balance_supports_numeric_strings_zero_and_explicit_conversion() {
        let mut q = query();
        q.divisor = 500000.0;
        assert_eq!(
            parse_balance(&json!({"data":{"balance":"1250000"}}), &q).unwrap(),
            2.5
        );
        assert_eq!(
            parse_balance(&json!({"data":{"balance":0}}), &q).unwrap(),
            0.0
        );
        assert!(parse_balance(&json!({"data":{}}), &q).is_err());
        assert!(parse_balance(&json!({"success":false,"data":{"balance":100}}), &q).is_err());
        q.path = "//other.example.test/balance".into();
        assert!(validate_balance(&q).is_err());
    }
    fn server(
        body: &'static str,
        status: &'static str,
    ) -> (String, std::thread::JoinHandle<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let thread = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = vec![0; 8192];
            let n = stream.read(&mut request).unwrap();
            let response = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            stream.write_all(response.as_bytes()).unwrap();
            String::from_utf8(request[..n].to_vec()).unwrap()
        });
        (url, thread)
    }
    #[tokio::test]
    async fn discovery_normalizes_openai_fallback_path_without_changing_native_claude_base() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/gateway", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            let mut paths = vec![];
            for status in ["404 Not Found", "200 OK"] {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut buf = [0; 8192];
                let n = stream.read(&mut buf).unwrap();
                paths.push(String::from_utf8_lossy(&buf[..n]).to_string());
                let body = r#"{"object":"list","data":[{"id":"gpt-5.4"}]}"#;
                write!(stream,"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
            paths
        });
        let result = discover_connection(&base, "fake-key", None, None)
            .await
            .unwrap();
        assert_eq!(result.base_url, format!("{base}/v1"));
        let paths = worker.join().unwrap();
        assert!(paths[0].starts_with("GET /gateway/models "));
        assert!(paths[1].starts_with("GET /gateway/v1/models "));
        let (native, worker) = server(
            r#"{"data":[{"id":"claude-sonnet-4-6","type":"model"}]}"#,
            "200 OK",
        );
        let result = discover_connection(&native, "fake-key", None, None)
            .await
            .unwrap();
        assert_eq!(result.base_url, native);
        worker.join().unwrap();
    }
    #[tokio::test]
    async fn model_query_uses_supplied_key_and_exact_base_path() {
        let (url, server) = server(r#"{"data":[{"id":"test-model"}]}"#, "200 OK");
        let result = sync_models(&format!("{url}/v1"), "isolated-test-key", "bearer")
            .await
            .unwrap();
        let request = server.join().unwrap();
        assert!(request.starts_with("GET /v1/models "));
        assert!(request
            .to_lowercase()
            .contains("authorization: bearer isolated-test-key"));
        assert_eq!(result.models[0].id, "test-model");
    }

    #[tokio::test]
    async fn complete_endpoint_paths_use_the_same_origin_and_preserve_the_prefix() {
        for suffix in ["models", "responses", "chat/completions"] {
            let (url, worker) = server(
                r#"{"object":"list","data":[{"id":"test-model"}]}"#,
                "200 OK",
            );
            let input = format!("{url}/gateway%20path/v1/{suffix}/");
            let result = discover_connection(&input, "isolated-test-key", None, None)
                .await
                .unwrap();
            assert_eq!(result.base_url, format!("{url}/gateway%20path/v1"));
            assert_eq!(result.protocol, CodexProtocol::Openai);
            assert!(worker
                .join()
                .unwrap()
                .starts_with("GET /gateway%20path/v1/models "));
        }
        let (url, worker) = server(r#"{"models":[{"slug":"native-model"}]}"#, "200 OK");
        let result = discover_connection(
            &format!("{url}/gateway/v1/messages"),
            "isolated-test-key",
            None,
            Some("x-api-key"),
        )
        .await
        .unwrap();
        assert_eq!(result.base_url, format!("{url}/gateway/v1"));
        assert_eq!(result.protocol, CodexProtocol::Anthropic);
        assert!(worker
            .join()
            .unwrap()
            .starts_with("GET /gateway/v1/models "));
        assert!(
            !ModelEndpoint::parse("https://api.anthropic.com.other.test/v1")
                .unwrap()
                .native_host
        );
        assert!(
            ModelEndpoint::parse("https://api.anthropic.com/v1/models")
                .unwrap()
                .native_host
        );
    }

    #[tokio::test]
    async fn discovery_retains_explicit_protocol_and_capabilities_across_pages() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/gateway/v1", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for body in [
                r#"{"data":[{"type":"model","id":"native-model"}],"has_more":true,"last_id":"p/2"}"#,
                r#"{"data":[{"id":"native-model","contextWindow":1000000,"context_policy":{"standard_context_window":272000,"long_context_window":1000000,"surcharge":true}}],"has_more":false}"#,
            ] {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut buf = [0; 8192];
                let n = stream.read(&mut buf).unwrap();
                requests.push(String::from_utf8_lossy(&buf[..n]).into_owned());
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
            requests
        });
        let result = discover_connection(&base, "native-test-key", None, None)
            .await
            .unwrap();
        let requests = worker.join().unwrap();
        assert!(requests[0].starts_with("GET /gateway/v1/models "));
        assert!(requests[1].starts_with("GET /gateway/v1/models?after_id=p%2F2 "));
        assert_eq!(result.protocol, CodexProtocol::Anthropic);
        let model = &result.models[0];
        assert_eq!(model.context_window, Some(1000000));
        let capability = model.context_capabilities.as_ref().unwrap();
        assert_eq!(capability.endpoint.as_deref(), Some(base.as_str()));
        assert_eq!(capability.surcharge, Some(true));
        assert!(capability.credential_scope.is_some());
    }

    #[tokio::test]
    async fn discovery_does_not_echo_a_reflected_key() {
        for body in [
            r#"{"data":[{"id":"id:isolated-test-key"}]}"#,
            r#"{"data":[{"id":"test-model"}],"has_more":true,"last_id":"isolated-test-key"}"#,
        ] {
            let (url, worker) = server(body, "200 OK");
            let error = discover_connection(&format!("{url}/v1"), "isolated-test-key", None, None)
                .await
                .unwrap_err();
            worker.join().unwrap();
            assert_eq!(error.code, "model_response");
            assert!(!error.message.contains("isolated-test-key"));
        }
    }
    #[tokio::test]
    async fn model_query_supports_anthropic_key_authentication() {
        let (url, server) = server(
            r#"{"data":[{"id":"claude-sonnet-4-6"}],"has_more":false}"#,
            "200 OK",
        );
        sync_models(&format!("{url}/v1"), "isolated-native-key", "x-api-key")
            .await
            .unwrap();
        let request = server.join().unwrap().to_lowercase();
        assert!(request.contains("x-api-key: isolated-native-key"));
        assert!(request.contains("anthropic-version: 2023-06-01"));
        assert!(!request.contains("authorization:"));
    }
    #[tokio::test]
    async fn queries_reject_http_errors_without_echoing_supplier_secrets() {
        let (url, response_thread) = server(r#"{"error":"isolated-test-key"}"#, "401 Unauthorized");
        let error = sync_models(&url, "isolated-test-key", "bearer")
            .await
            .unwrap_err();
        response_thread.join().unwrap();
        assert!(error.message.contains("401"));
        assert!(!error.message.contains("isolated-test-key"));
        let (url, server) = server(r#"{"data":{"balance":12.5}}"#, "200 OK");
        let result = query_balance(&format!("{url}/v1"), "test-key", query())
            .await
            .unwrap();
        assert!(server.join().unwrap().starts_with("GET /balance "));
        assert_eq!(result.amount, Some(12.5));
    }
}
