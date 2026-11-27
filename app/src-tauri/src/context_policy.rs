//! Explicit opt-in to long context. Limits never select an inference model.
use crate::{
    error::{AppError, Result},
    types::{Provider, ProviderModel},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const MAX: i64 = 100_000_000;
pub(crate) const CONSERVATIVE_CONTEXT_WINDOW: i64 = 128_000;
pub const DEFAULT_COMPACT_PERCENT: u8 = 80;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextCapabilities {
    pub standard_window: i64,
    pub long_window: i64,
    pub source: String,
    pub input_multiplier: Option<f64>,
    pub output_multiplier: Option<f64>,
    /// None means pricing is unknown, not that long context is free.
    #[serde(default)]
    pub surcharge: Option<bool>,
    /// Attached locally after querying this exact connection, never trusted from upstream JSON.
    #[serde(default)]
    pub endpoint: Option<String>,
    #[serde(default)]
    pub credential_scope: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextPolicy {
    pub model: String,
    #[serde(default)]
    pub long_context_enabled: bool,
    #[serde(default = "default_percent")]
    pub compact_percent: u8,
}
fn default_percent() -> u8 {
    DEFAULT_COMPACT_PERCENT
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppliedContextPolicy {
    pub model: String,
    pub long_context_enabled: bool,
    pub context_window: i64,
    pub auto_compact_token_limit: i64,
    pub compact_percent: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability_scope: Option<String>,
}

fn invalid() -> AppError {
    AppError::new(
        "invalid_context_policy",
        "上下文能力或选择已变化，请重新查询模型并确认长上下文开关；此次没有写入",
    )
}
pub fn is_gpt(model: &str) -> bool {
    model.starts_with("gpt-")
        || model.starts_with("o1")
        || model.starts_with("o3")
        || model.starts_with("o4")
}

pub fn validate_capabilities(value: &ContextCapabilities) -> Result<()> {
    if !(1..=MAX).contains(&value.standard_window)
        || !(value.standard_window..=MAX).contains(&value.long_window)
        || !matches!(
            value.source.as_str(),
            "endpoint" | "official_model" | "conservative"
        )
        || [value.input_multiplier, value.output_multiplier]
            .into_iter()
            .flatten()
            .any(|n| !n.is_finite() || !(1.0..=1000.0).contains(&n))
        || value.surcharge == Some(false)
            && [value.input_multiplier, value.output_multiplier]
                .into_iter()
                .flatten()
                .any(|n| n > 1.0)
        || value.credential_scope.as_ref().is_some_and(|scope| {
            scope.len() != 64 || !scope.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
    {
        return Err(invalid());
    }
    Ok(())
}

fn normalized_endpoint(endpoint: &str) -> Option<String> {
    crate::types::validate_url(endpoint.trim())
        .ok()
        .map(|url| url.as_str().trim_end_matches('/').to_owned())
}

fn official_endpoint(endpoint: &str) -> bool {
    url::Url::parse(endpoint).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str() == Some("api.openai.com")
            && url.port_or_known_default() == Some(443)
            && url.path().trim_end_matches('/') == "/v1"
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
    })
}

fn official_capabilities(model: &str, endpoint: &str) -> Result<Option<ContextCapabilities>> {
    if !official_endpoint(endpoint) {
        return Ok(None);
    }
    let data: Value = serde_json::from_str(include_str!(
        "../../src/content/model-context-policies.json"
    ))
    .map_err(|_| invalid())?;
    let Some(rule) = data["models"].as_array().and_then(|rules| {
        rules.iter().find(|rule| {
            rule["ids"]
                .as_array()
                .is_some_and(|ids| ids.iter().any(|id| id == model))
        })
    }) else {
        return Ok(None);
    };
    Ok(Some(ContextCapabilities {
        standard_window: rule["standardWindow"].as_i64().ok_or_else(invalid)?,
        long_window: rule["longWindow"].as_i64().ok_or_else(invalid)?,
        source: "official_model".into(),
        input_multiplier: rule["inputMultiplier"].as_f64(),
        output_multiplier: rule["outputMultiplier"].as_f64(),
        surcharge: Some(true),
        endpoint: None,
        credential_scope: None,
    }))
}

fn credential_scope(
    endpoint: &str,
    model: &str,
    key: &str,
    auth: &str,
    value: &ContextCapabilities,
) -> String {
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    for part in ["ae-context-capability-v1", endpoint, model, key, auth] {
        digest.update((part.len() as u64).to_be_bytes());
        digest.update(part.as_bytes());
    }
    // Bind the actual declared tariff too: a price change cannot reuse paid consent.
    if value.source == "official_model" {
        digest.update(b"official_model");
    }
    digest.update(value.standard_window.to_be_bytes());
    digest.update(value.long_window.to_be_bytes());
    for multiplier in [value.input_multiplier, value.output_multiplier] {
        digest.update(multiplier.map_or(u64::MAX, f64::to_bits).to_be_bytes());
    }
    digest.update([match value.surcharge {
        None => 0,
        Some(false) => 1,
        Some(true) => 2,
    }]);
    format!("{:x}", digest.finalize())
}

pub fn bind_endpoint(model: &mut ProviderModel, endpoint: &str, key: &str, auth: &str) {
    if let Some(value) = &mut model.context_capabilities {
        value.endpoint = normalized_endpoint(endpoint);
        value.credential_scope = value
            .endpoint
            .as_ref()
            .map(|endpoint| credential_scope(endpoint, &model.id, key, auth, value));
    }
}

pub fn bind_discovered(
    model: &mut ProviderModel,
    endpoint: &str,
    key: &str,
    auth: &str,
) -> Result<()> {
    if model.context_capabilities.is_none() {
        model.context_capabilities = official_capabilities(&model.id, endpoint)?;
    }
    bind_endpoint(model, endpoint, key, auth);
    Ok(())
}

pub fn validate_endpoint_bindings(
    models: &[ProviderModel],
    endpoint: &str,
    key: &str,
    auth: &str,
) -> Result<()> {
    let endpoint = normalized_endpoint(endpoint).ok_or_else(invalid)?;
    for model in models {
        if let Some(value) = &model.context_capabilities {
            if matches!(value.source.as_str(), "endpoint" | "official_model")
                && (value.endpoint.as_ref() != Some(&endpoint)
                    || value.credential_scope.as_ref()
                        != Some(&credential_scope(&endpoint, &model.id, key, auth, value)))
            {
                return Err(invalid());
            }
            if value.source == "official_model" {
                let mut expected =
                    official_capabilities(&model.id, &endpoint)?.ok_or_else(invalid)?;
                expected.endpoint = value.endpoint.clone();
                expected.credential_scope = value.credential_scope.clone();
                if *value != expected {
                    return Err(invalid());
                }
            }
        }
    }
    Ok(())
}

pub fn surcharge(value: &ContextCapabilities) -> Option<bool> {
    value.surcharge.or_else(|| {
        if [value.input_multiplier, value.output_multiplier]
            .into_iter()
            .flatten()
            .any(|n| n > 1.0)
        {
            Some(true)
        } else if value.input_multiplier == Some(1.0) && value.output_multiplier == Some(1.0) {
            Some(false)
        } else {
            None
        }
    })
}

pub fn long_context_available(value: &ContextCapabilities) -> bool {
    surcharge(value) == Some(true) && value.long_window > value.standard_window
}

/// Endpoint declarations take priority; a maximum alone does not establish its pricing tier.
pub fn endpoint_capabilities(item: &Value) -> Result<Option<ContextCapabilities>> {
    fn field<T: PartialEq>(
        policy: &Value,
        names: &[&str],
        parse: impl Fn(&Value) -> Option<T>,
    ) -> Result<Option<T>> {
        let mut result = None;
        for value in names
            .iter()
            .filter_map(|name| policy.get(name).filter(|value| !value.is_null()))
        {
            let value = parse(value).ok_or_else(invalid)?;
            if result.as_ref().is_some_and(|previous| *previous != value) {
                return Err(invalid());
            }
            result = Some(value);
        }
        Ok(result)
    }
    let snake = item.get("context_policy").filter(|value| !value.is_null());
    let camel = item.get("contextPolicy").filter(|value| !value.is_null());
    if snake.zip(camel).is_some_and(|(left, right)| left != right) {
        return Err(invalid());
    }
    let Some(policy) = snake.or(camel) else {
        return Ok(None);
    };
    let window = |value: &Value| {
        value
            .as_i64()
            .or_else(|| value.as_str()?.trim().parse().ok())
    };
    let multiplier = |value: &Value| {
        value
            .as_f64()
            .or_else(|| value.as_str()?.trim().parse().ok())
    };
    let value = ContextCapabilities {
        standard_window: field(
            policy,
            &[
                "standard_context_window",
                "standardContextWindow",
                "standardWindow",
            ],
            window,
        )?
        .ok_or_else(invalid)?,
        long_window: field(
            policy,
            &["long_context_window", "longContextWindow", "longWindow"],
            window,
        )?
        .ok_or_else(invalid)?,
        source: "endpoint".into(),
        input_multiplier: field(policy, &["input_multiplier", "inputMultiplier"], multiplier)?,
        output_multiplier: field(
            policy,
            &["output_multiplier", "outputMultiplier"],
            multiplier,
        )?,
        surcharge: field(policy, &["surcharge"], Value::as_bool)?,
        endpoint: None,
        credential_scope: None,
    };
    validate_capabilities(&value)?;
    Ok(Some(value))
}

pub fn capabilities(model: &ProviderModel, endpoint: &str) -> Result<Option<ContextCapabilities>> {
    let declared = model.context_capabilities.as_ref().filter(|value| {
        (value.source == "endpoint"
            || value.source == "official_model" && official_endpoint(endpoint))
            && value.endpoint.is_some()
            && value.endpoint == normalized_endpoint(endpoint)
            && value.credential_scope.is_some()
    });
    let mut value = if let Some(value) = declared {
        validate_capabilities(value)?;
        value.clone()
    } else if let Some(value) = official_capabilities(&model.id, endpoint)? {
        value
    } else {
        if model.context_window.is_none() && !is_gpt(&model.id) {
            return Ok(None);
        }
        // An advertised maximum gives an upper bound, without establishing its pricing.
        ContextCapabilities {
            standard_window: CONSERVATIVE_CONTEXT_WINDOW,
            long_window: CONSERVATIVE_CONTEXT_WINDOW,
            source: "conservative".into(),
            input_multiplier: None,
            output_multiplier: None,
            surcharge: None,
            endpoint: None,
            credential_scope: None,
        }
    };
    value.surcharge = surcharge(&value);
    if value.surcharge == Some(false) {
        // A confirmed flat-rate endpoint has no paid tier to opt in to.
        value.standard_window = value.long_window;
    }
    if let Some(maximum) = model.context_window {
        if !(1..=MAX).contains(&maximum) {
            return Err(invalid());
        }
        value.long_window = value.long_window.min(maximum);
        value.standard_window = value.standard_window.min(value.long_window);
    }
    validate_capabilities(&value)?;
    Ok(Some(value))
}

pub fn resolve(
    provider: &Provider,
    model: &str,
    choice: Option<&ContextPolicy>,
) -> Result<Option<AppliedContextPolicy>> {
    let selected = provider
        .codex_options
        .models
        .iter()
        .find(|entry| entry.id == model && entry.enabled);
    let Some(selected) = selected else {
        if choice.is_some_and(|choice| choice.long_context_enabled) {
            return Err(invalid());
        }
        return Ok(None);
    };
    let Some(limits) = capabilities(selected, &provider.base_url)? else {
        if choice.is_some_and(|choice| choice.long_context_enabled) {
            return Err(invalid());
        }
        return Ok(None);
    };
    let choice = choice.filter(|choice| choice.model == model);
    let long = choice.is_some_and(|choice| choice.long_context_enabled);
    let percent = choice.map_or(DEFAULT_COMPACT_PERCENT, |choice| choice.compact_percent);
    if !(1..=95).contains(&percent) || long && !long_context_available(&limits) {
        return Err(invalid());
    }
    let window = if long {
        limits.long_window
    } else {
        limits.standard_window
    };
    Ok(Some(AppliedContextPolicy {
        model: model.into(),
        long_context_enabled: long,
        context_window: window,
        auto_compact_token_limit: window * i64::from(percent) / 100,
        compact_percent: percent,
        capability_scope: long.then(|| limits.credential_scope.clone()).flatten(),
    }))
}

pub fn selected(provider: &Provider, model: &str) -> Result<Option<AppliedContextPolicy>> {
    resolve(
        provider,
        model,
        provider.codex_options.context_policy.as_ref(),
    )
}

pub fn validate_applied(provider: &Provider, value: &AppliedContextPolicy) -> Result<()> {
    let choice = ContextPolicy {
        model: value.model.clone(),
        long_context_enabled: value.long_context_enabled,
        compact_percent: value.compact_percent,
    };
    if resolve(provider, &value.model, Some(&choice))?.as_ref() != Some(value) {
        return Err(invalid());
    }
    Ok(())
}

/// Conservative byte-based bound for text prompts; no hidden server histories or remote images.
/// This is a local refusal gate, never a provider token count or a billing API.
pub fn guard_request(provider: &Provider, body: &Value) -> Result<()> {
    let policy = provider.codex_options.applied_context_policy.as_ref();
    let Some(policy) = policy else {
        return Ok(());
    };
    validate_applied(provider, policy)?;
    if body
        .get("model")
        .and_then(Value::as_str)
        .is_some_and(|model| model != policy.model)
    {
        return Err(AppError::new(
            "context_model_mismatch",
            "请求模型与已确认的上下文设置不同，请重新选择模型并确认连接",
        ));
    }
    // Opt-in authorizes the endpoint's long-input tier. Let the native client
    // tokenizer and upstream enforce that actual window; a byte bound would
    // otherwise turn a 1M-token budget into roughly 250K English tokens.
    if policy.long_context_enabled {
        return Ok(());
    }
    if body
        .get("previous_response_id")
        .is_some_and(|v| !v.is_null())
        || body.get("conversation").is_some_and(|v| !v.is_null())
    {
        return Err(AppError::new(
            "context_history_unbounded",
            "当前上下文限额无法计算上游保存的历史，请发送完整上下文或开启独立新会话",
        ));
    }
    fn unbounded(value: &Value) -> bool {
        match value {
            Value::Object(map) => {
                map.get("type").and_then(Value::as_str).is_some_and(|kind| {
                    matches!(
                        kind,
                        "input_image"
                            | "image_url"
                            | "image"
                            | "input_file"
                            | "file"
                            | "input_audio"
                            | "video"
                    )
                }) || map.contains_key("file_id")
                    || map.values().any(unbounded)
            }
            Value::Array(values) => values.iter().any(unbounded),
            _ => false,
        }
    }
    if unbounded(body) {
        return Err(AppError::new("context_input_unbounded", "附件或多媒体的 Token 数无法由当前端点可靠计算，尚未发送上游。请使用端点的计数工具或改为文本后重试"));
    }
    let serialized = serde_json::to_vec(body).map_err(|_| invalid())?;
    // JSON framing and tool wrappers reserve additional headroom. Client-side
    // compaction operates on tokens; this bound only rejects uncertain large requests.
    let output = ["max_output_tokens", "max_completion_tokens", "max_tokens"]
        .into_iter()
        .filter_map(|key| body.get(key).and_then(Value::as_u64))
        .max()
        .unwrap_or(8192);
    if (serialized.len() as u64)
        .saturating_add(8192)
        .saturating_add(output)
        > policy.context_window as u64
    {
        return Err(AppError::new("context_policy_limit", "请求超过所选上下文的保守限额，尚未发送上游。请先压缩会话；需要长上下文时由用户主动开启并重新确认连接"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn provider(model: &str) -> Provider {
        serde_json::from_value(serde_json::json!({"id":"p","family":"codex","name":"test","baseUrl":"https://api.openai.com/v1","model":model,"authMode":"bearer","reasoningEffort":null,"hasKey":true,"keySuffix":"","updatedAt":0,"codexOptions":{"models":[{"id":model,"enabled":true}]}})).unwrap()
    }
    #[test]
    fn documented_defaults_are_short_and_eighty_percent() {
        let p = provider("gpt-6.1-sol");
        let value = selected(&p, &p.model).unwrap().unwrap();
        assert_eq!(
            (
                value.context_window,
                value.auto_compact_token_limit,
                value.long_context_enabled
            ),
            (272000, 217600, false)
        );
    }
    #[test]
    fn opt_in_is_exact_model_scoped_and_capped_by_endpoint() {
        let mut p = provider("gpt-6.1-sol");
        p.codex_options.context_policy = Some(ContextPolicy {
            model: p.model.clone(),
            long_context_enabled: true,
            compact_percent: 80,
        });
        let v = selected(&p, &p.model).unwrap().unwrap();
        assert_eq!(
            (v.context_window, v.auto_compact_token_limit),
            (1050000, 840000)
        );
        p.codex_options.models[0].context_window = Some(300000);
        assert_eq!(
            selected(&p, &p.model).unwrap().unwrap().context_window,
            300000
        );
        p.codex_options.context_policy.as_mut().unwrap().model = "gpt-other".into();
        assert!(
            !selected(&p, &p.model)
                .unwrap()
                .unwrap()
                .long_context_enabled
        );
    }
    #[test]
    fn unknown_alias_cannot_inherit_long_context_or_pricing() {
        let mut p = provider("gpt-6.1-sol-custom");
        assert_eq!(
            selected(&p, &p.model).unwrap().unwrap().context_window,
            128000
        );
        p.codex_options.context_policy = Some(ContextPolicy {
            model: p.model.clone(),
            long_context_enabled: true,
            compact_percent: 80,
        });
        assert!(selected(&p, &p.model).is_err());
    }

    #[test]
    fn non_gpt_models_use_discovered_maximum_conservatively() {
        let mut p = provider("vendor/coding-alias");
        p.base_url = "https://gateway.invalid/v1".into();
        assert!(selected(&p, &p.model).unwrap().is_none());
        for (maximum, window, compact) in [(64000, 64000, 51200), (1000000, 128000, 102400)] {
            p.codex_options.models[0].context_window = Some(maximum);
            let policy = selected(&p, &p.model).unwrap().unwrap();
            assert!(!policy.long_context_enabled);
            assert_eq!(policy.compact_percent, 80);
            assert_eq!(policy.context_window, window);
            assert_eq!(policy.auto_compact_token_limit, compact);
        }
    }

    #[test]
    fn official_query_binds_paid_consent_to_the_key() {
        let mut p = provider("gpt-6.1-sol");
        p.codex_options.context_policy = Some(ContextPolicy {
            model: p.model.clone(),
            long_context_enabled: true,
            compact_percent: 80,
        });
        bind_discovered(
            &mut p.codex_options.models[0],
            &p.base_url,
            "old-key",
            &p.auth_mode,
        )
        .unwrap();
        let applied = selected(&p, &p.model).unwrap().unwrap();
        assert!(applied.capability_scope.is_some());
        assert!(validate_endpoint_bindings(
            &p.codex_options.models,
            &p.base_url,
            "old-key",
            &p.auth_mode
        )
        .is_ok());
        assert!(validate_endpoint_bindings(
            &p.codex_options.models,
            &p.base_url,
            "new-key",
            &p.auth_mode
        )
        .is_err());
        bind_discovered(
            &mut p.codex_options.models[0],
            &p.base_url,
            "new-key",
            &p.auth_mode,
        )
        .unwrap();
        assert!(validate_applied(&p, &applied).is_err());
    }

    #[test]
    fn tariff_fields_accept_explicit_variants_and_reject_conflicts() {
        let item = serde_json::json!({"contextPolicy": {
            "standardContextWindow": "64000", "longContextWindow": "400000",
            "inputMultiplier": "2.5", "outputMultiplier": null
        }});
        let capabilities = endpoint_capabilities(&item).unwrap().unwrap();
        assert_eq!(capabilities.standard_window, 64000);
        assert_eq!(capabilities.long_window, 400000);
        assert_eq!(surcharge(&capabilities), Some(true));
        for (field, value) in [
            ("standardWindow", serde_json::json!(32000)),
            ("output_multiplier", serde_json::json!("unknown")),
            ("surcharge", serde_json::json!(false)),
        ] {
            let mut corrupt = item.clone();
            corrupt["contextPolicy"][field] = value;
            assert!(endpoint_capabilities(&corrupt).is_err(), "{field}");
        }
    }
    #[test]
    fn endpoint_tiers_override_official_and_invalid_tiers_fail_closed() {
        let mut p = provider("gpt-6.1-sol");
        p.codex_options.models[0].context_capabilities=endpoint_capabilities(&serde_json::json!({"context_policy":{"standard_context_window":64000,"long_context_window":400000,"input_multiplier":3}})).unwrap();
        bind_endpoint(
            &mut p.codex_options.models[0],
            &p.base_url,
            "synthetic-key",
            &p.auth_mode,
        );
        assert_eq!(
            selected(&p, &p.model).unwrap().unwrap().context_window,
            64000
        );
        assert!(endpoint_capabilities(&serde_json::json!({"context_policy":{"standard_context_window":400000,"long_context_window":64000}})).is_err());
    }
    fn declared_provider(policy: Value) -> Provider {
        let mut p = provider("gpt-internal-alias");
        p.base_url = "https://gateway.invalid/v1".into();
        p.codex_options.models[0].context_capabilities =
            endpoint_capabilities(&serde_json::json!({"context_policy":policy})).unwrap();
        bind_endpoint(
            &mut p.codex_options.models[0],
            &p.base_url,
            "synthetic-key",
            &p.auth_mode,
        );
        p.codex_options.context_policy = Some(ContextPolicy {
            model: p.model.clone(),
            long_context_enabled: true,
            compact_percent: 80,
        });
        p
    }

    #[test]
    fn official_model_name_never_confirms_a_custom_endpoints_tariff() {
        for endpoint in [
            "https://gateway.invalid/v1",
            "https://api.openai.com.gateway.invalid/v1",
            "http://api.openai.com/v1",
            "https://api.openai.com/proxy/v1",
            "https://api.openai.com:8443/v1",
            "https://api.openai.com/v1?route=other",
        ] {
            let mut p = provider("gpt-6.1-sol");
            p.base_url = endpoint.into();
            let value = capabilities(&p.codex_options.models[0], endpoint)
                .unwrap()
                .unwrap();
            assert_eq!(value.source, "conservative");
            assert_eq!(value.surcharge, None);
            assert!(!long_context_available(&value));
            p.codex_options.context_policy = Some(ContextPolicy {
                model: p.model.clone(),
                long_context_enabled: true,
                compact_percent: 80,
            });
            assert!(selected(&p, &p.model).is_err());
        }
    }

    #[test]
    fn only_confirmed_surcharges_allow_opt_in_and_flat_rates_use_real_capacity() {
        let unknown = declared_provider(serde_json::json!({
            "standard_context_window":64000,"long_context_window":400000
        }));
        assert!(selected(&unknown, &unknown.model).is_err());
        let tier = declared_provider(serde_json::json!({
            "standard_context_window":64000,"long_context_window":400000,"input_multiplier":3
        }));
        assert_eq!(
            selected(&tier, &tier.model)
                .unwrap()
                .unwrap()
                .context_window,
            400000
        );
        let explicit = declared_provider(serde_json::json!({
            "standard_context_window":96000,"long_context_window":300000,"surcharge":true
        }));
        assert_eq!(
            selected(&explicit, &explicit.model)
                .unwrap()
                .unwrap()
                .context_window,
            300000
        );
        for flat in [
            serde_json::json!({"standard_context_window":64000,"long_context_window":400000,"surcharge":false}),
            serde_json::json!({"standard_context_window":64000,"long_context_window":400000,"input_multiplier":1,"output_multiplier":1}),
        ] {
            let mut p = declared_provider(flat);
            assert!(selected(&p, &p.model).is_err());
            p.codex_options
                .context_policy
                .as_mut()
                .unwrap()
                .long_context_enabled = false;
            let value = selected(&p, &p.model).unwrap().unwrap();
            assert_eq!(
                (value.context_window, value.auto_compact_token_limit),
                (400000, 320000)
            );
        }
        assert!(endpoint_capabilities(&serde_json::json!({"context_policy":{
            "standard_context_window":64000,"long_context_window":400000,"surcharge":false,"input_multiplier":2
        }})).is_err());
    }

    #[test]
    fn queried_capabilities_are_bound_to_endpoint_model_auth_and_key() {
        let p = declared_provider(serde_json::json!({
            "standard_context_window":64000,"long_context_window":400000,"input_multiplier":2
        }));
        let models = &p.codex_options.models;
        assert!(
            validate_endpoint_bindings(models, &p.base_url, "synthetic-key", &p.auth_mode).is_ok()
        );
        assert!(
            validate_endpoint_bindings(models, &p.base_url, "rotated-key", &p.auth_mode).is_err()
        );
        assert!(validate_endpoint_bindings(
            models,
            "https://other.invalid/v1",
            "synthetic-key",
            &p.auth_mode
        )
        .is_err());
        assert!(
            validate_endpoint_bindings(models, &p.base_url, "synthetic-key", "x-api-key").is_err()
        );
        let mut renamed = models.clone();
        renamed[0].id = "gpt-other".into();
        assert!(
            validate_endpoint_bindings(&renamed, &p.base_url, "synthetic-key", &p.auth_mode)
                .is_err()
        );
        let mut changed = p.clone();
        changed.base_url = "https://other.invalid/v1".into();
        assert!(selected(&changed, &changed.model).is_err());
        changed = p.clone();
        changed.codex_options.models[0]
            .context_capabilities
            .as_mut()
            .unwrap()
            .credential_scope = None;
        assert!(selected(&changed, &changed.model).is_err());
    }

    #[test]
    fn changed_tariff_cannot_reuse_a_previously_applied_paid_snapshot() {
        let mut p = declared_provider(serde_json::json!({
            "standard_context_window":64000,"long_context_window":400000,"input_multiplier":2
        }));
        let applied = selected(&p, &p.model).unwrap().unwrap();
        p.codex_options.models[0]
            .context_capabilities
            .as_mut()
            .unwrap()
            .input_multiplier = Some(3.0);
        assert!(validate_endpoint_bindings(
            &p.codex_options.models,
            &p.base_url,
            "synthetic-key",
            &p.auth_mode
        )
        .is_err());
        bind_endpoint(
            &mut p.codex_options.models[0],
            &p.base_url,
            "synthetic-key",
            &p.auth_mode,
        );
        assert!(validate_applied(&p, &applied).is_err());
    }
    #[test]
    fn short_gate_blocks_oversized_and_hidden_history_before_forwarding() {
        let mut p = provider("gpt-6.1-sol");
        p.codex_options.applied_context_policy = selected(&p, &p.model).unwrap();
        assert!(guard_request(&p, &serde_json::json!({"model":p.model,"input":"short"})).is_ok());
        assert!(guard_request(&p, &serde_json::json!({"input":"x".repeat(272000)})).is_err());
        assert!(guard_request(&p, &serde_json::json!({"previous_response_id":"any"})).is_err());
        assert!(guard_request(
            &p,
            &serde_json::json!({"input":"short","max_tokens":u64::MAX})
        )
        .is_err());
    }
}
