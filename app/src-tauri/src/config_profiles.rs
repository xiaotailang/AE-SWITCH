//! Named client/model combinations. Saved profiles contain references, never
//! credentials or native user paths. Batch journals remain private local data.
#![forbid(unsafe_code)]

use crate::{
    agent_configs::{self, AgentId},
    agent_hub::{self, Selection},
    error::{AppError, Result},
    store::Store,
    writer,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const FILE: &str = "config-profiles.json";
const JOURNAL: &str = "config-profiles.pending.json";
const MAX_SIZE: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileEntry {
    pub agent_id: AgentId,
    pub provider_id: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigProfile {
    pub id: String,
    pub name: String,
    pub revision: u64,
    pub entries: Vec<ProfileEntry>,
    pub updated_at: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveProfileInput {
    pub name: String,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub revision: Option<u64>,
    #[serde(default)]
    pub agent_ids: Vec<AgentId>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyProfileInput {
    pub id: String,
    pub revision: u64,
    pub fingerprint: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewEntry {
    pub agent_id: AgentId,
    pub provider_id: String,
    pub provider_name: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
    pub previous_provider_name: String,
    pub previous_model: String,
    pub previous_reasoning_effort: Option<String>,
    pub target_mode: &'static str,
    pub changed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilePreview {
    pub id: String,
    pub name: String,
    pub revision: u64,
    pub fingerprint: String,
    pub entries: Vec<PreviewEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyProfileResult {
    pub profile_id: String,
    pub applied_agent_ids: Vec<AgentId>,
    pub needs_restart: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Change {
    agent_id: AgentId,
    slot: usize,
    before: Option<String>,
    after: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    selection_before: String,
    selection_after: String,
    changes: Vec<Change>,
}

fn signed_journal(root: &Path, journal: &Journal) -> Result<String> {
    let payload = serde_json::to_string(journal).map_err(|_| invalid())?;
    crate::local_integrity::seal(root, "config-profiles-batch", &payload)
}

fn verified_journal(root: &Path, text: &str) -> Result<Journal> {
    let payload = crate::local_integrity::open(root, "config-profiles-batch", text)?;
    serde_json::from_str(&payload).map_err(|_| invalid())
}

struct Plan {
    preview: ProfilePreview,
    journal: Journal,
}

fn invalid() -> AppError {
    AppError::new("invalid_profile", "配置方案格式无效，未修改任何客户端")
}
fn changed() -> AppError {
    AppError::new(
        "configuration_profile_changed",
        "方案、连接或客户端配置已发生变化，请重新预览后再应用",
    )
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(9_007_199_254_740_991) as u64
}
fn valid_text(text: &str, max: usize) -> bool {
    !text.is_empty() && text.len() <= max && !text.chars().any(char::is_control)
}
fn read_owned(root: &Path, name: &str, limit: usize) -> Result<Option<String>> {
    let path = root.join(name);
    crate::portable::validate_owned_path(&path)?;
    crate::portable::validate_root(&path)?;
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() && metadata.len() <= limit as u64 => {}
        Ok(_) => return Err(invalid()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(AppError::io(&path, error)),
    }
    match std::fs::read(&path) {
        Ok(bytes) if bytes.len() <= limit => {
            String::from_utf8(bytes).map(Some).map_err(|_| invalid())
        }
        Ok(_) => Err(invalid()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(AppError::io(&path, error)),
    }
}

fn write_owned(root: &Path, name: &str, text: Option<&str>) -> Result<()> {
    let path = root.join(name);
    writer::write_with_validation(&path, text, |path| {
        crate::portable::validate_owned_path(path)?;
        crate::portable::validate_root(path)
    })
}

fn validate_profiles(profiles: &[ConfigProfile]) -> Result<()> {
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    if profiles.len() > 50 {
        return Err(invalid());
    }
    for profile in profiles {
        if !valid_text(&profile.id, 80)
            || !valid_text(&profile.name, 240)
            || profile.name.trim() != profile.name
            || profile.revision == 0
            || profile.revision > 9_007_199_254_740_991
            || !ids.insert(&profile.id)
            || !names.insert(profile.name.to_lowercase())
            || profile.entries.is_empty()
            || profile.entries.len() > 8
        {
            return Err(invalid());
        }
        let mut agents = HashSet::new();
        for entry in &profile.entries {
            if !agents.insert(entry.agent_id.as_str())
                || !valid_text(&entry.provider_id, 512)
                || !valid_text(&entry.model, 512)
                || entry
                    .reasoning_effort
                    .as_deref()
                    .is_some_and(|effort| !crate::types::valid_effort(effort))
            {
                return Err(invalid());
            }
        }
    }
    Ok(())
}

pub fn list(root: &Path) -> Result<Vec<ConfigProfile>> {
    let Some(text) = read_owned(root, FILE, 1024 * 1024)? else {
        return Ok(vec![]);
    };
    let profiles: Vec<ConfigProfile> = serde_json::from_str(&text).map_err(|_| invalid())?;
    validate_profiles(&profiles)?;
    Ok(profiles)
}

fn save_list(root: &Path, profiles: &[ConfigProfile]) -> Result<()> {
    validate_profiles(profiles)?;
    let text = serde_json::to_string_pretty(profiles).map_err(|_| invalid())?;
    write_owned(root, FILE, Some(&text))
}

pub fn provider_in_use(root: &Path, provider: &str) -> Result<bool> {
    Ok(list(root)?.iter().any(|profile| {
        profile
            .entries
            .iter()
            .any(|entry| entry.provider_id == provider)
    }))
}

pub fn save(store: &Store, input: SaveProfileInput) -> Result<ConfigProfile> {
    recover(&store.data_directory)?;
    agent_configs::recover_configuration(&store.data_directory)?;
    let name = input.name.trim();
    if !valid_text(name, 240) {
        return Err(AppError::new(
            "invalid_profile_name",
            "请输入 1 至 60 个字符的方案名称",
        ));
    }
    if name.chars().count() > 60 {
        return Err(AppError::new(
            "invalid_profile_name",
            "方案名称最多 60 个字符",
        ));
    }
    let (saved, _) = agent_hub::read_selections(&store.data_directory)?;
    let mut requested = HashSet::new();
    for agent in &input.agent_ids {
        if !requested.insert(agent.as_str()) {
            return Err(invalid());
        }
    }
    let mut entries = vec![];
    for definition in agent_configs::definitions() {
        if !requested.is_empty() && !requested.contains(definition.id.as_str()) {
            continue;
        }
        let Some(selection) = saved.get(definition.id.as_str()) else {
            if requested.is_empty() {
                continue;
            } else {
                return Err(AppError::new(
                    "not_configured",
                    "请先配置方案中选择的客户端",
                ));
            }
        };
        agent_hub::validate_profile_choice(
            store,
            &selection.provider_id,
            &selection.model,
            selection.reasoning_effort.as_deref(),
        )?;
        entries.push(ProfileEntry {
            agent_id: definition.id,
            provider_id: selection.provider_id.clone(),
            model: selection.model.clone(),
            reasoning_effort: selection.reasoning_effort.clone(),
        });
    }
    if entries.is_empty() {
        return Err(AppError::new(
            "not_configured",
            "请至少先确认一个客户端的连接，再保存方案",
        ));
    }
    let mut profiles = list(&store.data_directory)?;
    let position = input
        .id
        .as_ref()
        .and_then(|id| profiles.iter().position(|profile| &profile.id == id));
    let (id, revision) = if let Some(position) = position {
        let old = &profiles[position];
        if input.revision != Some(old.revision) {
            return Err(changed());
        }
        (
            old.id.clone(),
            old.revision
                .checked_add(1)
                .filter(|value| *value <= 9_007_199_254_740_991)
                .ok_or_else(invalid)?,
        )
    } else {
        if input.id.is_some() || input.revision.is_some() {
            return Err(changed());
        }
        (uuid::Uuid::new_v4().simple().to_string(), 1)
    };
    if profiles
        .iter()
        .any(|profile| profile.id != id && profile.name.to_lowercase() == name.to_lowercase())
    {
        return Err(AppError::new(
            "profile_name_exists",
            "此方案名称已存在，请使用新名称或更新已有方案",
        ));
    }
    let profile = ConfigProfile {
        id,
        name: name.into(),
        revision,
        entries,
        updated_at: now(),
    };
    if let Some(position) = position {
        profiles[position] = profile.clone();
    } else {
        profiles.push(profile.clone());
    }
    save_list(&store.data_directory, &profiles)?;
    Ok(profile)
}

pub fn delete(root: &Path, id: &str, revision: u64) -> Result<()> {
    recover(root)?;
    agent_configs::recover_configuration(root)?;
    let mut profiles = list(root)?;
    let position = profiles
        .iter()
        .position(|profile| profile.id == id && profile.revision == revision)
        .ok_or_else(changed)?;
    profiles.remove(position);
    save_list(root, &profiles)
}

fn profile(store: &Store, id: &str) -> Result<ConfigProfile> {
    list(&store.data_directory)?
        .into_iter()
        .find(|profile| profile.id == id)
        .ok_or_else(|| AppError::new("profile_not_found", "配置方案不存在，请刷新列表"))
}

fn identity(path: &Path) -> String {
    let text = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_owned())
        .to_string_lossy()
        .into_owned();
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}

fn plan(store: &Store, profile: ConfigProfile) -> Result<Plan> {
    let root = &store.data_directory;
    let (mut saved, selection_before) = agent_hub::read_selections(root)?;
    let selection_before = selection_before
        .ok_or_else(|| AppError::new("not_configured", "请先配置方案中引用的客户端"))?;
    let route = store.agent_route()?;
    let mut digest = Sha256::new();
    digest.update(serde_json::to_vec(&profile).map_err(|_| invalid())?);
    digest.update(selection_before.as_bytes());
    digest.update(route.port.to_be_bytes());
    digest.update(route.token.as_bytes());
    let mut entries = vec![];
    let mut changes = vec![];
    let mut unique_paths = HashSet::new();
    for entry in &profile.entries {
        let previous = saved.get(entry.agent_id.as_str()).cloned().ok_or_else(|| {
            AppError::new(
                "not_configured",
                "方案引用的客户端已断开，请先重新配置并预览",
            )
        })?;
        agent_hub::validate_profile_choice(
            store,
            &entry.provider_id,
            &entry.model,
            entry.reasoning_effort.as_deref(),
        )?;
        let provider = store.agent_provider(&entry.provider_id)?;
        digest.update(serde_json::to_vec(&provider).map_err(|_| invalid())?);
        let old_provider = store.agent_provider(&previous.provider_id)?;
        let base = format!(
            "http://127.0.0.1:{}/agents/selected:{}{}",
            route.port,
            entry.agent_id.as_str(),
            if entry.agent_id == AgentId::ClaudeCode {
                ""
            } else {
                "/v1"
            }
        );
        let snapshots = agent_configs::configuration_snapshots(
            root,
            entry.agent_id,
            previous.profile.as_ref(),
        )?;
        let writes = agent_configs::plan_profile_configuration(
            root,
            entry.agent_id,
            &base,
            &route.token,
            &entry.model,
            previous.profile.as_ref(),
        )?;
        let checked_snapshots = agent_configs::configuration_snapshots(
            root,
            entry.agent_id,
            previous.profile.as_ref(),
        )?;
        if snapshots != checked_snapshots {
            return Err(changed());
        }
        let mut writes: Vec<(PathBuf, Option<String>)> = writes
            .into_iter()
            .map(|(path, text)| (path, Some(text)))
            .collect();
        let native_writes: Vec<_> = writes
            .iter()
            .filter_map(|(path, text)| text.clone().map(|text| (path.clone(), text)))
            .collect();
        writes.extend(agent_configs::plan_configuration_ownership(
            root,
            entry.agent_id,
            previous.profile.as_ref(),
            &snapshots,
            &native_writes,
        )?);
        for (slot, (path, before)) in snapshots.iter().enumerate() {
            if !unique_paths.insert(identity(path)) {
                return Err(AppError::new(
                    "profile_target_overlap",
                    "多个客户端指向了同一配置文件，请分别选择原生配置目标后重试",
                ));
            }
            digest.update(
                serde_json::to_vec(&(entry.agent_id, slot, before)).map_err(|_| invalid())?,
            );
        }
        for (path, after) in writes {
            let (slot, (_, before)) = snapshots
                .iter()
                .enumerate()
                .find(|(_, (candidate, _))| *candidate == path)
                .ok_or_else(invalid)?;
            if changes
                .iter()
                .any(|change: &Change| change.agent_id == entry.agent_id && change.slot == slot)
            {
                return Err(invalid());
            }
            changes.push(Change {
                agent_id: entry.agent_id,
                slot,
                before: before.clone(),
                after,
            });
        }
        let changed = previous.provider_id != entry.provider_id
            || previous.model != entry.model
            || previous.reasoning_effort != entry.reasoning_effort;
        entries.push(PreviewEntry {
            agent_id: entry.agent_id,
            provider_id: entry.provider_id.clone(),
            provider_name: provider.summary.name,
            model: entry.model.clone(),
            reasoning_effort: entry.reasoning_effort.clone(),
            previous_provider_name: old_provider.summary.name,
            previous_model: previous.model.clone(),
            previous_reasoning_effort: previous.reasoning_effort.clone(),
            target_mode: if previous.profile.is_some() {
                "existing"
            } else {
                "private"
            },
            changed,
        });
        saved.insert(
            entry.agent_id.as_str().into(),
            Selection {
                provider_id: entry.provider_id.clone(),
                model: entry.model.clone(),
                reasoning_effort: entry.reasoning_effort.clone(),
                configuration_revision: previous
                    .configuration_revision
                    .checked_add(1)
                    .filter(|value| *value <= 9_007_199_254_740_991)
                    .ok_or_else(invalid)?,
                applied_at_ms: now(),
                profile: previous.profile,
            },
        );
    }
    if changes.len() > 128 {
        return Err(invalid());
    }
    let selection_after = serde_json::to_string_pretty(&saved).map_err(|_| invalid())?;
    Ok(Plan {
        preview: ProfilePreview {
            id: profile.id,
            name: profile.name,
            revision: profile.revision,
            fingerprint: format!("{:x}", digest.finalize()),
            entries,
        },
        journal: Journal {
            selection_before,
            selection_after,
            changes,
        },
    })
}

pub fn preview(store: &Store, id: &str) -> Result<ProfilePreview> {
    recover(&store.data_directory)?;
    agent_configs::recover_configuration(&store.data_directory)?;
    Ok(plan(store, profile(store, id)?)?.preview)
}

fn resolve(root: &Path, journal: &Journal) -> Result<Vec<(PathBuf, Option<String>)>> {
    let (saved, current) = agent_hub::read_selections(root)?;
    if current.as_deref() != Some(journal.selection_before.as_str())
        && current.as_deref() != Some(journal.selection_after.as_str())
    {
        return Err(changed());
    }
    let before: BTreeMap<String, Selection> =
        serde_json::from_str(&journal.selection_before).map_err(|_| invalid())?;
    let after: BTreeMap<String, Selection> =
        serde_json::from_str(&journal.selection_after).map_err(|_| invalid())?;
    let changed_agents: HashSet<_> = journal
        .changes
        .iter()
        .map(|change| change.agent_id.as_str())
        .collect();
    let known_agents: HashSet<_> = agent_configs::definitions()
        .into_iter()
        .map(|definition| definition.id.as_str())
        .collect();
    let valid_selection = |selection: &Selection| {
        valid_text(&selection.provider_id, 512)
            && valid_text(&selection.model, 512)
            && selection
                .reasoning_effort
                .as_deref()
                .is_none_or(crate::types::valid_effort)
            && selection.configuration_revision <= 9_007_199_254_740_991
            && selection.applied_at_ms <= 9_007_199_254_740_991
    };
    if before.len() != after.len()
        || before.iter().any(|(agent, previous)| {
            !known_agents.contains(agent.as_str())
                || !valid_selection(previous)
                || after.get(agent).is_none_or(|next| {
                    !valid_selection(next)
                        || previous.profile != next.profile
                        || if changed_agents.contains(agent.as_str()) {
                            previous.configuration_revision.checked_add(1)
                                != Some(next.configuration_revision)
                        } else {
                            previous != next
                        }
                })
        })
    {
        return Err(invalid());
    }
    let mut unique = HashSet::new();
    let mut paths = HashSet::new();
    if journal.changes.is_empty() || journal.changes.len() > 128 {
        return Err(invalid());
    }
    let mut resolved = vec![];
    for change in &journal.changes {
        if !unique.insert((change.agent_id.as_str(), change.slot))
            || change
                .before
                .as_ref()
                .is_some_and(|text| text.len() > 32 * 1024 * 1024)
            || change
                .after
                .as_ref()
                .is_some_and(|text| text.len() > 32 * 1024 * 1024)
        {
            return Err(invalid());
        }
        let selection = saved.get(change.agent_id.as_str()).ok_or_else(invalid)?;
        let snapshots = agent_configs::configuration_snapshots(
            root,
            change.agent_id,
            selection.profile.as_ref(),
        )?;
        let (path, text) = snapshots.get(change.slot).ok_or_else(invalid)?;
        if !paths.insert(identity(path)) {
            return Err(invalid());
        }
        resolved.push((path.clone(), text.clone()));
    }
    Ok(resolved)
}

fn rollback(root: &Path, journal: &Journal) -> Result<()> {
    let resolved = resolve(root, journal)?;
    // Check every target before restoring any file. External edits always win.
    for (change, (_, current)) in journal.changes.iter().zip(&resolved) {
        if *current != change.before && *current != change.after {
            return Err(changed());
        }
    }
    let (saved, _) = agent_hub::read_selections(root)?;
    for (change, (path, _)) in journal.changes.iter().zip(&resolved).rev() {
        let selection = &saved[change.agent_id.as_str()];
        let current = agent_configs::configuration_snapshots(
            root,
            change.agent_id,
            selection.profile.as_ref(),
        )?
        .get(change.slot)
        .ok_or_else(invalid)?
        .1
        .clone();
        if current == change.before {
            continue;
        }
        if current != change.after {
            return Err(changed());
        }
        agent_configs::write_configuration_snapshot_checked(
            root,
            change.agent_id,
            selection.profile.as_ref(),
            path,
            change.after.as_deref(),
            change.before.as_deref(),
        )?;
    }
    let (saved_now, current) = agent_hub::read_selections(root)?;
    if saved_now != saved
        || (current.as_deref() != Some(journal.selection_before.as_str())
            && current.as_deref() != Some(journal.selection_after.as_str()))
    {
        return Err(changed());
    }
    write_owned(
        root,
        "agent-selection.json",
        Some(&journal.selection_before),
    )?;
    let restored = resolve(root, journal)?;
    if restored
        .iter()
        .zip(&journal.changes)
        .any(|((_, current), change)| *current != change.before)
    {
        return Err(AppError::new(
            "verify_failed",
            "配置方案恢复后回读校验失败，备份已保留",
        ));
    }
    write_owned(root, JOURNAL, None)
}

fn commit(
    root: &Path,
    journal: &Journal,
    mut after_write: impl FnMut(usize) -> Result<()>,
) -> Result<()> {
    let resolved = resolve(root, journal)?;
    if resolved
        .iter()
        .zip(&journal.changes)
        .any(|((_, current), change)| *current != change.before)
    {
        return Err(changed());
    }
    let (_, current) = agent_hub::read_selections(root)?;
    if current.as_deref() != Some(journal.selection_before.as_str()) {
        return Err(changed());
    }
    let text = signed_journal(root, journal)?;
    if text.len() > MAX_SIZE {
        return Err(AppError::new(
            "response_limit",
            "批量配置备份超过限制，未修改客户端",
        ));
    }
    write_owned(root, JOURNAL, Some(&text))?;
    let result = (|| {
        for (index, (change, (path, _))) in journal.changes.iter().zip(&resolved).enumerate() {
            let (_, selection_current) = agent_hub::read_selections(root)?;
            if selection_current.as_deref() != Some(journal.selection_before.as_str()) {
                return Err(changed());
            }
            let (saved, _) = agent_hub::read_selections(root)?;
            let selection = &saved[change.agent_id.as_str()];
            let current = agent_configs::configuration_snapshots(
                root,
                change.agent_id,
                selection.profile.as_ref(),
            )?
            .get(change.slot)
            .ok_or_else(invalid)?
            .1
            .clone();
            if current != change.before {
                return Err(changed());
            }
            agent_configs::write_configuration_snapshot_checked(
                root,
                change.agent_id,
                selection.profile.as_ref(),
                path,
                change.before.as_deref(),
                change.after.as_deref(),
            )?;
            let checked = agent_configs::configuration_snapshots(
                root,
                change.agent_id,
                selection.profile.as_ref(),
            )?
            .get(change.slot)
            .ok_or_else(invalid)?
            .1
            .clone();
            if checked != change.after {
                return Err(AppError::new("verify_failed", "配置方案写入后回读校验失败"));
            }
            after_write(index)?;
        }
        let (_, current) = agent_hub::read_selections(root)?;
        if current.as_deref() != Some(journal.selection_before.as_str()) {
            return Err(changed());
        }
        write_owned(root, "agent-selection.json", Some(&journal.selection_after))?;
        let (_, selected) = agent_hub::read_selections(root)?;
        if selected.as_deref() != Some(journal.selection_after.as_str()) {
            return Err(changed());
        }
        let checked = resolve(root, journal)?;
        if checked
            .iter()
            .zip(&journal.changes)
            .any(|((_, current), change)| *current != change.after)
        {
            return Err(changed());
        }
        Ok(())
    })();
    if let Err(error) = result {
        if rollback(root, journal).is_err() {
            return Err(AppError::new("recovery_required", "批量应用未完成，发现外部修改或文件锁；原备份已保留，未覆盖外部修改，请关闭客户端后重新打开 AE"));
        }
        return Err(error);
    }
    write_owned(root, JOURNAL, None)
}

pub fn apply(store: &Store, input: ApplyProfileInput) -> Result<ApplyProfileResult> {
    recover(&store.data_directory)?;
    agent_configs::recover_configuration(&store.data_directory)?;
    let profile = profile(store, &input.id)?;
    if profile.revision != input.revision {
        return Err(changed());
    }
    let plan = plan(store, profile)?;
    if plan.preview.fingerprint != input.fingerprint {
        return Err(changed());
    }
    commit(&store.data_directory, &plan.journal, |_| Ok(()))?;
    Ok(ApplyProfileResult {
        profile_id: input.id,
        applied_agent_ids: plan
            .preview
            .entries
            .into_iter()
            .map(|entry| entry.agent_id)
            .collect(),
        needs_restart: true,
    })
}

pub fn recover(root: &Path) -> Result<()> {
    let Some(text) = read_owned(root, JOURNAL, MAX_SIZE)? else {
        return Ok(());
    };
    let journal = verified_journal(root, &text)?;
    let resolved = resolve(root, &journal)?;
    let (_, current) = agent_hub::read_selections(root)?;
    if current.as_deref() == Some(journal.selection_after.as_str())
        && resolved
            .iter()
            .zip(&journal.changes)
            .all(|((_, current), change)| *current == change.after)
    {
        return write_owned(root, JOURNAL, None);
    }
    rollback(root, &journal).map_err(|_| {
        AppError::new(
            "recovery_required",
            "配置方案备份尚未完整恢复；外部修改保持不变，请保留数据目录并关闭客户端后重试",
        )
    })
}

#[cfg(test)]
#[path = "config_profiles_tests.rs"]
mod tests;
