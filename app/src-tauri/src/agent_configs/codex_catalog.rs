use super::{native_merge, AppError, Path, Result};
use crate::codex_switching::Catalog;
use crate::types::{CodexOptions, ProviderModel};
use serde_json::{json, Value};
use toml_edit::{DocumentMut, Item, TableLike};

pub(super) const FILE_NAME: &str = "ae-switch-approved-models.json";
pub(super) const SLOT: &str = "model_catalog";
const NATIVE_OVERRIDES: [&str; 3] = [
    "model_context_window",
    "model_auto_compact_token_limit",
    "model_reasoning_effort",
];
const SUBAGENT_OVERRIDES: [&str; 2] = [
    "default_subagent_model",
    "default_subagent_reasoning_effort",
];
const POINTER_KEY: &str = "model_catalog_json";

pub(super) fn from_selection(text: Option<&str>) -> Result<Option<Catalog>> {
    let Some(text) = text else {
        return Ok(None);
    };
    let selection: Value = serde_json::from_str(text).map_err(|_| invalid_catalog())?;
    selection["codex"]
        .get("nativeModelCatalog")
        .filter(|catalog| !catalog.is_null())
        .map(|catalog| serde_json::from_value(catalog.clone()).map_err(|_| invalid_catalog()))
        .transpose()
}

fn invalid_catalog() -> AppError {
    AppError::new(
        "invalid_model_catalog",
        "Codex 已批准模型目录无效，配置未修改",
    )
}

pub(super) fn json(model: &str, catalog: &Catalog) -> Result<String> {
    let mut ids = std::collections::BTreeSet::new();
    if catalog.models.len() < 2
        || catalog.models.len() > 500
        || !catalog.models.iter().any(|row| row.id == model)
        || catalog.models.iter().any(|row| {
            row.id.is_empty()
                || !ids.insert(&row.id)
                || row.id.len() > 256
                || row.id.chars().any(char::is_control)
                || row
                    .context_window
                    .is_some_and(|n| !(1..=100_000_000).contains(&n))
                || row
                    .reasoning_efforts
                    .iter()
                    .any(|effort| !crate::types::valid_effort(effort))
                || row
                    .reasoning_effort
                    .as_deref()
                    .is_some_and(|effort| !crate::types::valid_effort(effort))
                || row.reasoning_effort.as_ref().is_some_and(|effort| {
                    !row.reasoning_efforts.is_empty() && !row.reasoning_efforts.contains(effort)
                })
                || row.policy.as_ref().is_some_and(|policy| {
                    policy.model != row.id || Some(policy.context_window) != row.context_window
                })
        })
    {
        return Err(invalid_catalog());
    }
    let models: Vec<_> = catalog
        .models
        .iter()
        .map(|row| ProviderModel {
            id: row.id.clone(),
            context_window: row.context_window,
            reasoning_efforts: row.reasoning_efforts.clone(),
            context_capabilities: None,
            enabled: true,
        })
        .collect();
    let mut result = crate::adapters::catalog_document(model, &CodexOptions::default(), &models);
    let rows = result["models"]
        .as_array_mut()
        .ok_or_else(invalid_catalog)?;
    for (row, approved) in rows.iter_mut().zip(&catalog.models) {
        if approved.context_window.is_none() {
            // An unknown window is not automatically a known legacy default.
            let row = row.as_object_mut().ok_or_else(invalid_catalog)?;
            for key in [
                "context_window",
                "max_context_window",
                "auto_compact_token_limit",
            ] {
                row.remove(key);
            }
        } else {
            let cap = approved.context_window.ok_or_else(invalid_catalog)?;
            let threshold = approved
                .policy
                .as_ref()
                .map_or(cap.saturating_mul(80) / 100, |p| p.auto_compact_token_limit);
            if threshold <= 0 || threshold > cap {
                return Err(invalid_catalog());
            }
            row["auto_compact_token_limit"] = json!(threshold);
        }
        if let Some(effort) = &approved.reasoning_effort {
            row["default_reasoning_level"] = json!(effort);
            // A user-approved compatibility effort can be selected even if the
            // server gave no effort catalogue. Do not synthesize other choices.
            if approved.reasoning_efforts.is_empty() {
                row["supported_reasoning_levels"] = json!([{"effort":effort,"description":effort}]);
            }
        } else if approved
            .reasoning_efforts
            .iter()
            .any(|effort| effort == "medium")
        {
            row["default_reasoning_level"] = json!("medium");
        }
    }
    native_merge::text(&result)
}

fn profile_name(doc: &DocumentMut, path: &Path) -> Result<Option<String>> {
    doc.get("profile")
        .map(|profile| {
            profile
                .as_str()
                .filter(|name| !name.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| native_merge::invalid(path))
        })
        .transpose()
}

fn profile<'a>(doc: &'a DocumentMut, name: &str) -> Option<&'a dyn TableLike> {
    doc.get("profiles")?
        .as_table_like()?
        .get(name)?
        .as_table_like()
}

fn profile_mut<'a>(
    doc: &'a mut DocumentMut,
    name: &str,
    path: &Path,
) -> Result<&'a mut dyn TableLike> {
    doc.get_mut("profiles")
        .and_then(Item::as_table_like_mut)
        .and_then(|profiles| profiles.get_mut(name))
        .and_then(Item::as_table_like_mut)
        .ok_or_else(|| native_merge::invalid(path))
}

fn clear_overrides(scope: &mut dyn TableLike, path: &Path) -> Result<()> {
    for name in NATIVE_OVERRIDES {
        scope.remove(name);
    }
    if let Some(agents) = scope.get_mut("agents") {
        let agents = agents
            .as_table_like_mut()
            .ok_or_else(|| native_merge::invalid(path))?;
        for name in SUBAGENT_OVERRIDES {
            agents.remove(name);
        }
    }
    Ok(())
}

pub(super) fn configure(doc: &mut DocumentMut, config: &Path, catalog: &Path) -> Result<()> {
    let catalog = catalog
        .to_str()
        .ok_or_else(|| native_merge::invalid(config))?;
    let active = profile_name(doc, config)?;
    native_merge::toml_set(
        doc.as_table_mut(),
        POINTER_KEY,
        toml_edit::value(catalog),
        config,
    )?;
    clear_overrides(doc.as_table_mut(), config)?;
    if let Some(active) = active {
        let scope = profile_mut(doc, &active, config)?;
        native_merge::toml_set(scope, POINTER_KEY, toml_edit::value(catalog), config)?;
        clear_overrides(scope, config)?;
    }
    Ok(())
}

fn has_pointer(scope: &dyn TableLike, catalog: &Path) -> bool {
    scope
        .get(POINTER_KEY)
        .and_then(Item::as_str)
        .is_some_and(|path| Path::new(path) == catalog)
}

pub(super) fn points_to(doc: &DocumentMut, config: &Path, catalog: &Path) -> Result<bool> {
    Ok(has_pointer(doc.as_table(), catalog)
        || profile_name(doc, config)?
            .as_deref()
            .and_then(|active| profile(doc, active))
            .is_some_and(|scope| has_pointer(scope, catalog)))
}

fn restore_scope(
    scope: &mut dyn TableLike,
    before: Option<&dyn TableLike>,
    catalog: &Path,
    config: &Path,
) -> Result<()> {
    if !has_pointer(scope, catalog) {
        return Ok(());
    }
    scope.remove(POINTER_KEY);
    clear_overrides(scope, config)?;
    if let Some(before) = before {
        for name in [POINTER_KEY].into_iter().chain(NATIVE_OVERRIDES) {
            if let Some(original) = before.get(name) {
                scope.insert(name, original.clone());
            }
        }
        if let Some(agents) = before.get("agents").and_then(Item::as_table_like) {
            for name in SUBAGENT_OVERRIDES {
                if let Some(original) = agents.get(name) {
                    native_merge::toml_child(scope, "agents", config)?
                        .insert(name, original.clone());
                }
            }
        }
    }
    Ok(())
}

pub(super) fn revert(
    doc: &mut DocumentMut,
    original: Option<&str>,
    config: &Path,
    catalog: &Path,
) -> Result<()> {
    let before = original
        .unwrap_or("")
        .parse::<DocumentMut>()
        .map_err(|_| native_merge::invalid(config))?;
    let active = profile_name(doc, config)?;
    restore_scope(doc.as_table_mut(), Some(before.as_table()), catalog, config)?;
    if let Some(active) = active {
        let scope = profile_mut(doc, &active, config)?;
        restore_scope(scope, profile(&before, &active), catalog, config)?;
    }
    Ok(())
}
