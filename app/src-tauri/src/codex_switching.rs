//! The models approved for one Codex connection. A refresh cannot grant new models.
use crate::{
    context_policy::{self, AppliedContextPolicy},
    error::{AppError, Result},
    types::{Provider, ProviderModel, StoredProvider},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Catalog {
    scope: String,
    pub(crate) models: Vec<CatalogModel>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CatalogModel {
    pub(crate) id: String,
    pub(crate) context_window: Option<i64>,
    pub(crate) reasoning_efforts: Vec<String>,
    pub(crate) reasoning_effort: Option<String>,
    pub(crate) policy: Option<AppliedContextPolicy>,
}

fn changed() -> AppError {
    AppError::new(
        "codex_catalog_changed",
        "此连接或模型能力已变化，请在 AE 中同步模型并确认连接",
    )
}

fn connection_scope(provider: &StoredProvider) -> String {
    let mut digest = Sha256::new();
    for field in [
        "ae-codex-catalog-v1",
        provider.summary.id.as_str(),
        provider.summary.base_url.trim_end_matches('/'),
        provider.summary.auth_mode.as_str(),
        match provider.summary.upstream_protocol() {
            crate::types::CodexProtocol::Openai => "openai",
            crate::types::CodexProtocol::Anthropic => "anthropic",
        },
        provider.api_key.as_str(),
    ] {
        digest.update((field.len() as u64).to_be_bytes());
        digest.update(field.as_bytes());
    }
    format!("{:x}", digest.finalize())
}

fn coding_model(model: &ProviderModel) -> bool {
    let id = model.id.to_ascii_lowercase();
    model.enabled
        && ![
            "embedding",
            "dall-e",
            "whisper",
            "tts",
            "moderation",
            "rerank",
        ]
        .iter()
        .any(|part| id.contains(part))
        && !id
            .split(['-', '/'])
            .any(|part| matches!(part, "image" | "audio" | "video" | "sora"))
}

// Only the request-local provider is normalized. Discovered and stored metadata
// remains as the supplier provided it, including absent capacity declarations.
fn apply_unknown_window_budget(provider: &mut Provider) -> Result<()> {
    for model in &mut provider.codex_options.models {
        if model.context_window.is_none()
            && context_policy::capabilities(model, &provider.base_url)?.is_none()
        {
            model.context_window = Some(context_policy::CONSERVATIVE_CONTEXT_WINDOW);
        }
    }
    Ok(())
}

pub(crate) fn policy_for_model(
    provider: &Provider,
    model: &str,
) -> Result<Option<AppliedContextPolicy>> {
    context_policy::resolve(provider, model, None)
}

impl Catalog {
    pub(crate) fn approve(
        provider: &mut StoredProvider,
        default_model: &str,
        effort: Option<&str>,
        default_policy: Option<&AppliedContextPolicy>,
    ) -> Result<Self> {
        if provider.summary.codex_options.models_synced_at.is_none()
            || provider.summary.upstream_protocol() != crate::types::CodexProtocol::Openai
        {
            return Err(changed());
        }
        apply_unknown_window_budget(&mut provider.summary)?;
        let mut models = Vec::new();
        for entry in provider
            .summary
            .codex_options
            .models
            .iter()
            .filter(|row| coding_model(row))
        {
            let policy = if entry.id == default_model && default_policy.is_some() {
                default_policy.cloned()
            } else {
                policy_for_model(&provider.summary, &entry.id)?
            };
            models.push(CatalogModel {
                id: entry.id.clone(),
                context_window: policy.as_ref().map(|p| p.context_window),
                reasoning_efforts: entry.reasoning_efforts.clone(),
                reasoning_effort: if entry.id == default_model {
                    effort.map(str::to_owned)
                } else {
                    None
                },
                policy,
            });
        }
        if models.len() < 2 || !models.iter().any(|model| model.id == default_model) {
            return Err(AppError::new(
                "codex_model_switch_unavailable",
                "工具内切换需要至少两个已同步并启用的编码模型",
            ));
        }
        Ok(Self {
            scope: connection_scope(provider),
            models,
        })
    }

    pub(crate) fn restrict(&self, provider: &mut StoredProvider) -> Result<()> {
        if self.scope != connection_scope(provider) {
            return Err(changed());
        }
        let approved: HashSet<_> = self.models.iter().map(|row| row.id.as_str()).collect();
        provider
            .summary
            .codex_options
            .models
            .retain(|row| coding_model(row) && approved.contains(row.id.as_str()));
        apply_unknown_window_budget(&mut provider.summary)
    }
}
