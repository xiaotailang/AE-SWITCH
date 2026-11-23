//! Apply context fields inside the existing configuration transaction and ownership journal.
use super::*;
use crate::context_policy::AppliedContextPolicy;

pub(super) fn from_selection(
    text: Option<&str>,
    agent: AgentId,
) -> Result<Option<AppliedContextPolicy>> {
    let Some(text) = text else {
        return Ok(None);
    };
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|_| AppError::new("invalid_state", "客户端上下文选择损坏"))?;
    value
        .get(agent.as_str())
        .and_then(|entry| entry.get("contextPolicy"))
        .filter(|entry| !entry.is_null())
        .map(|entry| {
            serde_json::from_value(entry.clone())
                .map_err(|_| AppError::new("invalid_context_policy", "客户端上下文选择损坏"))
        })
        .transpose()
}

pub(super) fn apply(
    agent: AgentId,
    model: &str,
    writes: &mut [(PathBuf, String)],
    policy: &AppliedContextPolicy,
) -> Result<()> {
    if policy.model != model
        || policy.context_window <= 0
        || policy.auto_compact_token_limit <= 0
        || policy.auto_compact_token_limit
            != policy.context_window * i64::from(policy.compact_percent) / 100
    {
        return Err(AppError::new(
            "invalid_context_policy",
            "上下文与压缩阈值不匹配，未写入配置",
        ));
    }
    for (path, text) in writes {
        match agent {
            AgentId::Codex
                if path
                    .extension()
                    .is_some_and(|extension| extension == "toml") =>
            {
                let mut document = text
                    .parse::<toml_edit::DocumentMut>()
                    .map_err(|_| native_merge::invalid(path))?;
                for (key, number) in [
                    ("model_context_window", policy.context_window),
                    (
                        "model_auto_compact_token_limit",
                        policy.auto_compact_token_limit,
                    ),
                ] {
                    native_merge::toml_set(
                        document.as_table_mut(),
                        key,
                        toml_edit::value(number),
                        path,
                    )?;
                }
                if let Some(name) = document
                    .get("profile")
                    .and_then(toml_edit::Item::as_str)
                    .map(str::to_owned)
                {
                    let table = document
                        .get_mut("profiles")
                        .and_then(toml_edit::Item::as_table_like_mut)
                        .and_then(|profiles| profiles.get_mut(&name))
                        .and_then(toml_edit::Item::as_table_like_mut)
                        .ok_or_else(|| native_merge::invalid(path))?;
                    for (key, number) in [
                        ("model_context_window", policy.context_window),
                        (
                            "model_auto_compact_token_limit",
                            policy.auto_compact_token_limit,
                        ),
                    ] {
                        native_merge::toml_set(table, key, toml_edit::value(number), path)?;
                    }
                }
                *text = document.to_string();
            }
            AgentId::Hermes => {
                let source = native_merge::Yaml::parse(Some(text), path, serde_json::json!({}))?;
                let mut value = source.value();
                let selected = native_merge::child(&mut value, "model", path)?;
                native_merge::set(
                    selected,
                    "context_length",
                    policy.context_window.into(),
                    path,
                )?;
                let compression = native_merge::child(&mut value, "compression", path)?;
                for (key, field) in [
                    ("enabled", true.into()),
                    (
                        "threshold",
                        (f64::from(policy.compact_percent) / 100.0).into(),
                    ),
                    ("threshold_tokens", policy.auto_compact_token_limit.into()),
                    ("codex_gpt55_autoraise", false.into()),
                ] {
                    native_merge::set(compression, key, field, path)?;
                }
                *text = source.render(&value, path)?;
            }
            AgentId::OhMyPi => {
                let source = native_merge::Yaml::parse(Some(text), path, serde_json::json!({}))?;
                let mut value = source.value();
                if let Some(provider) = value.pointer_mut("/providers/ae_switch") {
                    let models = native_merge::array(provider, "models", path)?;
                    if let Some(selected) = models.iter_mut().find(|entry| entry["id"] == model) {
                        native_merge::set(
                            selected,
                            "contextWindow",
                            policy.context_window.into(),
                            path,
                        )?;
                    }
                    if let Some(selected) = provider
                        .get_mut("modelOverrides")
                        .and_then(|entries| entries.get_mut(model))
                    {
                        native_merge::set(
                            selected,
                            "contextWindow",
                            policy.context_window.into(),
                            path,
                        )?;
                    }
                } else {
                    let compaction = native_merge::child(&mut value, "compaction", path)?;
                    for (key, field) in [
                        ("enabled", true.into()),
                        ("thresholdPercent", policy.compact_percent.into()),
                        ("thresholdTokens", policy.auto_compact_token_limit.into()),
                    ] {
                        native_merge::set(compaction, key, field, path)?;
                    }
                }
                *text = source.render(&value, path)?;
            }
            AgentId::OpenCode => {
                let source = jsonc::Document::parse(Some(text), path)?;
                let mut value = source.value();
                if let Some(selected) = value
                    .get_mut("provider")
                    .and_then(|providers| providers.get_mut("ae_switch"))
                    .and_then(|provider| provider.get_mut("models"))
                    .and_then(|models| models.get_mut(model))
                {
                    let limits = native_merge::child(selected, "limit", path)?;
                    native_merge::set(limits, "context", policy.context_window.into(), path)?;
                    native_merge::set(limits, "input", policy.context_window.into(), path)?;
                }
                let compaction = native_merge::child(&mut value, "compaction", path)?;
                native_merge::set(compaction, "auto", true.into(), path)?;
                native_merge::set(
                    compaction,
                    "reserved",
                    (policy.context_window - policy.auto_compact_token_limit).into(),
                    path,
                )?;
                *text = source.render(&value, path)?;
            }
            AgentId::WorkBuddy => {
                let mut value = native_merge::json(Some(text), path, serde_json::json!([]))?;
                let models = if value.is_object() {
                    value
                        .get_mut("models")
                        .ok_or_else(|| native_merge::invalid(path))?
                } else {
                    &mut value
                };
                let rows = models
                    .as_array_mut()
                    .ok_or_else(|| native_merge::invalid(path))?;
                let selected = rows
                    .iter_mut()
                    .find(|entry| entry["id"] == model)
                    .ok_or_else(|| native_merge::invalid(path))?;
                native_merge::set(
                    selected,
                    "contextWindow",
                    policy.context_window.into(),
                    path,
                )?;
                native_merge::set(
                    selected,
                    "maxInputTokens",
                    policy.context_window.into(),
                    path,
                )?;
                *text = native_merge::text(&value)?;
            }
            AgentId::ClaudeCode => {
                let mut value = native_merge::json(Some(text), path, serde_json::json!({}))?;
                let environment = native_merge::child(&mut value, "env", path)?;
                native_merge::set(
                    environment,
                    "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
                    policy.context_window.to_string().into(),
                    path,
                )?;
                native_merge::set(
                    environment,
                    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE",
                    policy.compact_percent.to_string().into(),
                    path,
                )?;
                *text = native_merge::text(&value)?;
            }
            AgentId::DeepSeekHarness => {
                let source = native_merge::Yaml::parse(Some(text), path, serde_json::json!([]))?;
                let mut value = source.value();
                let Some(rows) = value.as_array_mut() else {
                    continue;
                };
                if !rows.iter().any(|row| row["id"] == "llm-pi-ai") {
                    continue;
                }
                if let Some(provider) = rows
                    .iter_mut()
                    .find(|row| row["id"] == "llm-pi-ai")
                    .and_then(|row| row.pointer_mut("/config/providers/ae-switch"))
                {
                    let models = native_merge::array(provider, "models", path)?;
                    if let Some(selected) = models.iter_mut().find(|entry| entry["id"] == model) {
                        native_merge::set(
                            selected,
                            "contextWindow",
                            policy.context_window.into(),
                            path,
                        )?;
                    }
                }
                let row = native_merge::row(rows, "id", "compaction-basic");
                let config = native_merge::child(row, "config", path)?;
                native_merge::set(config, "auto", true.into(), path)?;
                native_merge::set(
                    config,
                    "thresholdRatio",
                    (f64::from(policy.compact_percent) / 100.0).into(),
                    path,
                )?;
                if let Some(policies) = config
                    .get_mut("modelPolicies")
                    .and_then(serde_json::Value::as_array_mut)
                {
                    for selected in policies
                        .iter_mut()
                        .filter(|entry| entry["provider"] == "ae-switch" && entry["model"] == model)
                    {
                        native_merge::set(
                            selected,
                            "thresholdRatio",
                            (f64::from(policy.compact_percent) / 100.0).into(),
                            path,
                        )?;
                    }
                }
                *text = source.render(&value, path)?;
            }
            AgentId::Zcode => {
                let mut value = native_merge::json(Some(text), path, serde_json::json!({}))?;
                if value
                    .pointer("/config/providerConfigRules/providerRules")
                    .and_then(serde_json::Value::as_array)
                    .is_some_and(|rows| rows.iter().any(|row| row["providerId"] == "ae_switch"))
                {
                    let rules = value
                        .pointer_mut("/config/modelConfigRules")
                        .ok_or_else(|| native_merge::invalid(path))?;
                    let manual = native_merge::array(rules, "manualProviderModelRules", path)?;
                    if let Some(selected) = manual.iter_mut().find(|entry| {
                        entry["providerId"] == "ae_switch" && entry["modelId"] == model
                    }) {
                        let properties = native_merge::child(
                            native_merge::child(selected, "config", path)?,
                            "properties",
                            path,
                        )?;
                        native_merge::set(
                            properties,
                            "contextWindow",
                            policy.context_window.into(),
                            path,
                        )?;
                    } else {
                        let smart = native_merge::array(rules, "providerModelRules", path)?;
                        let index = smart.iter().position(|entry| {
                            entry["providerId"] == "ae_switch" && entry["modelId"] == model
                        });
                        let selected = if let Some(index) = index {
                            &mut smart[index]
                        } else {
                            smart.push(serde_json::json!({"providerId":"ae_switch","modelId":model,"config":{}}));
                            smart.last_mut().expect("inserted rule")
                        };
                        let properties = native_merge::child(
                            native_merge::child(selected, "config", path)?,
                            "properties",
                            path,
                        )?;
                        native_merge::set(
                            properties,
                            "contextWindow",
                            policy.context_window.into(),
                            path,
                        )?;
                    }
                    *text = native_merge::text(&value)?;
                }
            }
            AgentId::Codex => {}
        }
    }
    Ok(())
}
