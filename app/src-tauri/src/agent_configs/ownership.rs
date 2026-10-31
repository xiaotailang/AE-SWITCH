//! Field ownership and conservative disconnect. Snapshots never cross the IPC boundary.
use super::{existing, jsonc, native_merge, AgentId, ExistingProfile};
use crate::{
    error::{AppError, Result},
    writer,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileState {
    slot: String,
    before: Option<String>,
    after: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ownership {
    agent: AgentId,
    profile: Option<ExistingProfile>,
    files: Vec<FileState>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationFileStatus {
    pub slot: String,
    pub managed_fields: usize,
    pub changed_fields: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationSafety {
    pub status: &'static str,
    pub can_disconnect: bool,
    pub preview_token: Option<String>,
    pub files: Vec<ConfigurationFileStatus>,
}

#[derive(Clone)]
struct Field {
    path: Vec<String>,
    before: Option<Value>,
    after: Option<Value>,
}

fn conflict() -> AppError {
    AppError::new(
        "agent_configuration_changed",
        "AE 管理的配置已被修改；未覆盖客户端修改，请重新检查配置",
    )
}

fn record_path(root: &Path, agent: AgentId, pending: bool) -> PathBuf {
    root.join(format!(
        "agent-ownership-{}{}.json",
        agent.as_str(),
        if pending { ".pending" } else { "" }
    ))
}

fn paths(
    root: &Path,
    agent: AgentId,
    profile: Option<&ExistingProfile>,
) -> Result<BTreeMap<String, PathBuf>> {
    if let Some(profile) = profile {
        existing::validate_profile(agent, profile)?;
        return Ok(existing::configuration_paths(agent, profile)?
            .into_iter()
            .map(|(key, path)| (key.into(), path))
            .collect());
    }
    let directory = root.join("agents").join(agent.as_str());
    let rows: &[(&str, &str)] = match agent {
        AgentId::ClaudeCode => &[("config", "home/.claude/settings.json")],
        AgentId::Codex => &[("config", "home/.codex/config.toml")],
        AgentId::Hermes => &[("config", "home/.hermes/config.yaml")],
        AgentId::OhMyPi => &[
            ("config", "home/.omp/agent/models.yml"),
            ("secondary", "home/.omp/agent/config.yml"),
        ],
        AgentId::OpenCode => &[("config", "configuration/opencode.json")],
        AgentId::WorkBuddy => &[("config", "home/.workbuddy/models.json")],
        AgentId::Zcode => &[
            ("config", "configuration/zcode-providers.json"),
            ("builtin", "configuration/zcode-builtin.json"),
            ("state", "home/.zcode/v2/agents-state.json"),
        ],
        // The private harness gets its credentials from the portable environment.
        AgentId::DeepSeekHarness => &[("config", "home/.dsh/profiles/headless/cordis.patch.yml")],
    };
    let mut known: BTreeMap<String, PathBuf> = rows
        .iter()
        .map(|(slot, path)| ((*slot).into(), directory.join(path)))
        .collect();
    known.insert(
        "environment".into(),
        directory.join("configuration/environment.json"),
    );
    Ok(known)
}

fn read_file(
    root: &Path,
    path: &Path,
    known: &BTreeMap<String, PathBuf>,
    native: bool,
) -> Result<Option<String>> {
    if native {
        native_merge::read_authorized(path, known.values())
    } else {
        native_merge::read(root, path)
    }
}

fn load(root: &Path, agent: AgentId, pending: bool) -> Result<Option<Ownership>> {
    native_merge::read_limit(root, &record_path(root, agent, pending), 32 * 1024 * 1024)?
        .map(|text| {
            let payload =
                crate::local_integrity::open(root, &record_purpose(agent, pending), &text)?;
            serde_json::from_str(&payload)
                .map_err(|_| AppError::new("invalid_state", "配置所有权记录损坏，未修改客户端配置"))
        })
        .transpose()
}

fn record_purpose(agent: AgentId, pending: bool) -> String {
    format!(
        "agent-ownership:{}:{}",
        agent.as_str(),
        if pending { "pending" } else { "baseline" }
    )
}

fn save(root: &Path, ownership: &Ownership, pending: bool) -> Result<()> {
    let payload = serde_json::to_string(ownership)
        .map_err(|_| AppError::new("serialization", "无法保存配置所有权记录"))?;
    let serialized =
        crate::local_integrity::seal(root, &record_purpose(ownership.agent, pending), &payload)?;
    if serialized.len() > 32 * 1024 * 1024 {
        return Err(AppError::new("response_limit", "配置所有权记录超过限制"));
    }
    super::write_checked(
        root,
        &record_path(root, ownership.agent, pending),
        &serialized,
    )
}

fn validate(
    ownership: &Ownership,
    agent: AgentId,
    profile: Option<&ExistingProfile>,
    known: &BTreeMap<String, PathBuf>,
) -> Result<()> {
    if ownership.agent != agent
        || ownership.profile.as_ref() != profile
        || ownership.files.len() > known.len()
    {
        return Err(AppError::new(
            "configuration_profile_changed",
            "请先断开原配置目录，再切换到另一个目录",
        ));
    }
    let mut slots = std::collections::HashSet::new();
    if ownership.files.iter().any(|file| {
        !known.contains_key(&file.slot)
            || !slots.insert(&file.slot)
            || file.after.len() > 4 * 1024 * 1024
            || file
                .before
                .as_ref()
                .is_some_and(|text| text.len() > 4 * 1024 * 1024)
    }) {
        return Err(AppError::new("invalid_state", "配置所有权记录包含未知文件"));
    }
    Ok(())
}

fn toml_value(item: &toml_edit::Item) -> Value {
    if let Some(table) = item.as_table_like() {
        return Value::Object(
            table
                .iter()
                .map(|(key, item)| (key.into(), toml_value(item)))
                .collect(),
        );
    }
    if let Some(array) = item.as_array_of_tables() {
        return Value::Array(
            array
                .iter()
                .map(|table| toml_value(&toml_edit::Item::Table(table.clone())))
                .collect(),
        );
    }
    fn scalar(value: &toml_edit::Value) -> Value {
        match value {
            toml_edit::Value::String(value) => json!(value.value()),
            toml_edit::Value::Integer(value) => json!(value.value()),
            toml_edit::Value::Float(value) => json!(["toml_float", value.value().to_string()]),
            toml_edit::Value::Boolean(value) => json!(value.value()),
            toml_edit::Value::Datetime(value) => {
                json!(["toml_datetime", value.value().to_string()])
            }
            toml_edit::Value::Array(array) => Value::Array(array.iter().map(scalar).collect()),
            toml_edit::Value::InlineTable(table) => Value::Object(
                table
                    .iter()
                    .map(|(key, value)| (key.into(), scalar(value)))
                    .collect(),
            ),
        }
    }
    item.as_value().map(scalar).unwrap_or(Value::Null)
}

fn document(path: &Path, text: Option<&str>) -> Result<Value> {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("toml") => {
            let doc = text
                .unwrap_or("")
                .parse::<toml_edit::DocumentMut>()
                .map_err(|_| native_merge::invalid(path))?;
            Ok(toml_value(doc.as_item()))
        }
        Some("yaml" | "yml") => Ok(native_merge::Yaml::parse(text, path, json!({}))?.value()),
        _ => {
            if let Some(text) = text {
                if let Ok(value) = native_merge::decode_json(text) {
                    if value.is_array() {
                        return Ok(value);
                    }
                }
            }
            Ok(jsonc::Document::parse(text, path)?.value())
        }
    }
}

fn diff(
    before: Option<&Value>,
    after: Option<&Value>,
    path: &mut Vec<String>,
    fields: &mut Vec<Field>,
) {
    if before == after {
        return;
    }
    if before.is_some_and(Value::is_array) && after.is_some_and(Value::is_array) {
        let before = before.and_then(Value::as_array).expect("array");
        let after = after.and_then(Value::as_array).expect("array");
        for index in 0..before.len().max(after.len()) {
            path.push(index.to_string());
            if before.get(index).is_none() || after.get(index).is_none() {
                // A new row is an ownership unit: do not remove its identifier
                // and leave behind a user-edited, structurally invalid row.
                fields.push(Field {
                    path: path.clone(),
                    before: before.get(index).cloned(),
                    after: after.get(index).cloned(),
                });
            } else {
                diff(before.get(index), after.get(index), path, fields);
            }
            path.pop();
        }
        return;
    }
    // Recurse into added objects, so later unrelated keys remain independently owned.
    if before.is_none_or(Value::is_object) && after.is_none_or(Value::is_object) {
        let mut keys = std::collections::BTreeSet::new();
        if let Some(map) = before.and_then(Value::as_object) {
            keys.extend(map.keys());
        }
        if let Some(map) = after.and_then(Value::as_object) {
            keys.extend(map.keys());
        }
        if !keys.is_empty() {
            for key in keys {
                path.push(key.clone());
                diff(
                    before.and_then(|value| value.get(key)),
                    after.and_then(|value| value.get(key)),
                    path,
                    fields,
                );
                path.pop();
            }
            return;
        }
    }
    fields.push(Field {
        path: path.clone(),
        before: before.cloned(),
        after: after.cloned(),
    });
}

fn fields(file: &FileState, path: &Path) -> Result<Vec<Field>> {
    let after = document(path, Some(&file.after))?;
    let before = if file.before.is_none() && after.is_array() {
        json!([])
    } else {
        document(path, file.before.as_deref())?
    };
    let mut result = vec![];
    diff(Some(&before), Some(&after), &mut vec![], &mut result);
    Ok(result)
}

fn at<'a>(value: &'a Value, path: &[String]) -> Option<&'a Value> {
    path.iter().try_fold(value, |value, key| {
        if let Some(array) = value.as_array() {
            array.get(key.parse::<usize>().ok()?)
        } else {
            value.get(key)
        }
    })
}

fn set(value: &mut Value, path: &[String], replacement: Option<&Value>) -> Result<()> {
    let Some((key, remaining)) = path.split_first() else {
        *value = replacement.cloned().unwrap_or_else(|| json!({}));
        return Ok(());
    };
    if let Some(array) = value.as_array_mut() {
        let index = key.parse::<usize>().map_err(|_| conflict())?;
        if remaining.is_empty() {
            if let Some(replacement) = replacement {
                if index == array.len() {
                    array.push(replacement.clone());
                } else {
                    *array.get_mut(index).ok_or_else(conflict)? = replacement.clone();
                }
            } else if index < array.len() {
                array.remove(index);
            }
        } else {
            if index == array.len() {
                array.push(json!({}));
            }
            let child = array.get_mut(index).ok_or_else(conflict)?;
            set(child, remaining, replacement)?;
        }
        return Ok(());
    }
    let map = value.as_object_mut().ok_or_else(conflict)?;
    if remaining.is_empty() {
        if let Some(replacement) = replacement {
            map.insert(key.clone(), replacement.clone());
        } else {
            map.remove(key);
        }
    } else {
        if !map.contains_key(key) {
            map.insert(key.clone(), json!({}));
        }
        let child = map.get_mut(key).expect("inserted");
        set(child, remaining, replacement)?;
    }
    Ok(())
}

fn prune_created(
    value: &mut Value,
    original: &Value,
    applied: &Value,
    changes: &[Field],
) -> Result<()> {
    // Only an ancestor of an actual managed field can have been introduced by
    // AE. Walking the whole current document also erases later user-created
    // empty objects/tables and empty array members, which are outside our grant.
    let mut ancestors = std::collections::BTreeSet::new();
    for field in changes {
        for length in 1..field.path.len() {
            let path = field.path[..length].to_vec();
            if at(original, &path).is_none() && at(applied, &path).is_some_and(Value::is_object) {
                ancestors.insert(path);
            }
        }
    }
    let mut ancestors: Vec<_> = ancestors.into_iter().collect();
    ancestors.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| b.cmp(a)));
    for path in ancestors {
        if at(value, &path)
            .is_some_and(|value| value.as_object().is_some_and(|object| object.is_empty()))
        {
            set(value, &path, None)?;
        }
    }
    Ok(())
}

fn render(
    path: &Path,
    current: Option<&str>,
    restored: &Value,
    original: Option<&str>,
    changes: &[Field],
) -> Result<String> {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("toml") => {
            let mut current = current
                .unwrap_or("")
                .parse::<toml_edit::DocumentMut>()
                .map_err(|_| native_merge::invalid(path))?;
            let original = original
                .unwrap_or("")
                .parse::<toml_edit::DocumentMut>()
                .map_err(|_| native_merge::invalid(path))?;
            fn source<'a>(
                item: &'a toml_edit::Item,
                path: &[String],
            ) -> Option<&'a toml_edit::Item> {
                path.iter()
                    .try_fold(item, |item, key| item.as_table_like()?.get(key))
            }
            fn edit(
                table: &mut dyn toml_edit::TableLike,
                keys: &[String],
                item: Option<&toml_edit::Item>,
                path: &Path,
                expected: &Value,
            ) -> Result<()> {
                let (key, remaining) = keys.split_first().ok_or_else(conflict)?;
                if remaining.is_empty() {
                    if let Some(item) = item {
                        table.insert(key, item.clone());
                    } else {
                        table.remove(key);
                    }
                } else {
                    if !table.contains_key(key) {
                        table.insert(key, toml_edit::Item::Table(toml_edit::Table::new()));
                    }
                    let child = table
                        .get_mut(key)
                        .and_then(toml_edit::Item::as_table_like_mut)
                        .ok_or_else(|| native_merge::invalid(path))?;
                    edit(
                        child,
                        remaining,
                        item,
                        path,
                        expected.get(key).unwrap_or(&Value::Null),
                    )?;
                    if item.is_none() && child.is_empty() && expected.get(key).is_none() {
                        table.remove(key);
                    }
                }
                Ok(())
            }
            for field in changes {
                edit(
                    current.as_table_mut(),
                    &field.path,
                    source(original.as_item(), &field.path),
                    path,
                    restored,
                )?;
            }
            Ok(current.to_string())
        }
        Some("yaml" | "yml") => {
            native_merge::Yaml::parse(current, path, json!({}))?.render(restored, path)
        }
        _ if restored.is_array() => native_merge::text(restored),
        _ => jsonc::Document::parse(current, path)?.render(restored, path),
    }
}

fn restore_file(
    file: &FileState,
    path: &Path,
    current: Option<&str>,
) -> Result<(Option<String>, usize, usize)> {
    let changes = fields(file, path)?;
    let mut value = document(path, current)?;
    let conflicts = changes
        .iter()
        .filter(|field| at(&value, &field.path) != field.after.as_ref())
        .count();
    if conflicts > 0 {
        return Ok((None, changes.len(), conflicts));
    }
    if current == Some(file.after.as_str()) {
        return Ok((file.before.clone(), changes.len(), 0));
    }
    for field in changes.iter().rev() {
        set(&mut value, &field.path, field.before.as_ref())?;
    }
    let original = if file.before.is_none() && value.is_array() {
        json!([])
    } else {
        document(path, file.before.as_deref())?
    };
    prune_created(
        &mut value,
        &original,
        &document(path, Some(&file.after))?,
        &changes,
    )?;
    let restored = render(path, current, &value, file.before.as_deref(), &changes)?;
    if document(path, Some(&restored))? != value {
        return Err(native_merge::invalid(path));
    }
    Ok((Some(restored), changes.len(), 0))
}

/// Called before the existing native transaction. The pending record is finalized
/// only after all files have their expected contents, including after a restart.
pub(super) fn prepare(
    root: &Path,
    agent: AgentId,
    profile: Option<&ExistingProfile>,
    snapshots: &[native_merge::Snapshot],
    writes: &[(PathBuf, String)],
) -> Result<()> {
    save(root, &plan(root, agent, profile, snapshots, writes)?, true)
}

fn plan(
    root: &Path,
    agent: AgentId,
    profile: Option<&ExistingProfile>,
    snapshots: &[native_merge::Snapshot],
    writes: &[(PathBuf, String)],
) -> Result<Ownership> {
    let known = paths(root, agent, profile)?;
    let previous = load(root, agent, false)?;
    if let Some(previous) = &previous {
        validate(previous, agent, profile, &known)?;
    }
    let mut files = vec![];
    for (slot, path) in &known {
        let Some((_, after)) = writes.iter().find(|(candidate, _)| candidate == path) else {
            continue;
        };
        let before = snapshots
            .iter()
            .find(|(candidate, _)| candidate == path)
            .ok_or_else(|| AppError::new("invalid_state", "配置缺少所有权快照"))?
            .1
            .clone();
        let original = if let Some(old) = previous
            .as_ref()
            .and_then(|record| record.files.iter().find(|file| file.slot == *slot))
        {
            let (restored, _, conflicts) = restore_file(old, path, before.as_deref())?;
            if conflicts > 0 {
                return Err(conflict());
            }
            restored
        } else {
            before
        };
        files.push(FileState {
            slot: slot.clone(),
            before: original,
            after: after.clone(),
        });
    }
    // Keep previously owned optional files that the current plan does not rewrite.
    if let Some(previous) = previous {
        for mut file in previous.files {
            if !files.iter().any(|new| new.slot == file.slot) {
                let current = read_file(root, &known[&file.slot], &known, profile.is_some())?;
                let (original, _, conflicts) =
                    restore_file(&file, &known[&file.slot], current.as_deref())?;
                if conflicts > 0 {
                    return Err(conflict());
                }
                file.before = original;
                file.after = current.ok_or_else(conflict)?;
                files.push(file);
            }
        }
    }
    Ok(Ownership {
        agent,
        profile: profile.cloned(),
        files,
    })
}

pub(super) fn plan_configuration_ownership(
    root: &Path,
    agent: AgentId,
    profile: Option<&ExistingProfile>,
    snapshots: &[native_merge::Snapshot],
    writes: &[(PathBuf, String)],
) -> Result<Vec<(PathBuf, Option<String>)>> {
    let record = plan(root, agent, profile, snapshots, writes)?;
    let payload = serde_json::to_string(&record)
        .map_err(|_| AppError::new("serialization", "无法生成配置所有权计划"))?;
    let serialized = crate::local_integrity::seal(root, &record_purpose(agent, false), &payload)?;
    if serialized.len() > 32 * 1024 * 1024 {
        return Err(AppError::new("response_limit", "配置所有权记录超过限制"));
    }
    Ok(vec![
        (record_path(root, agent, false), Some(serialized)),
        (record_path(root, agent, true), None),
    ])
}

pub(super) fn finish(root: &Path, agent: AgentId) -> Result<()> {
    let Some(record) = load(root, agent, true)? else {
        return Ok(());
    };
    if record.profile.is_some()
        && crate::agent_hub::existing_profile(root, agent)? != record.profile
    {
        // An abandoned or substituted pending record is never its own grant to
        // read an external profile. Successful native commits persist selection first.
        return writer::write(&record_path(root, agent, true), None);
    }
    let known = paths(root, agent, record.profile.as_ref())?;
    validate(&record, agent, record.profile.as_ref(), &known)?;
    let mut matches = true;
    for file in &record.files {
        matches &= read_file(root, &known[&file.slot], &known, record.profile.is_some())?
            .as_deref()
            == Some(&file.after);
    }
    if matches {
        save(root, &record, false)?;
    }
    // Native transaction recovery has already either completed or rolled back.
    writer::write(&record_path(root, agent, true), None)
}

pub(super) fn recover(root: &Path) -> Result<()> {
    for definition in super::definitions() {
        finish(root, definition.id)?;
    }
    recover_disconnect(root)
}

fn rollback_disconnect(
    root: &Path,
    journal: &DisconnectJournal,
    known: &BTreeMap<String, PathBuf>,
    native: bool,
) -> Result<()> {
    // Check the entire write set before undoing anything; manual modifications
    // never become rollback targets.
    for file in &journal.files {
        let current = read_file(root, &known[&file.slot], known, native)?;
        if current != file.current && current != file.restored {
            return Err(conflict());
        }
    }
    for file in journal.files.iter().rev() {
        let path = &known[&file.slot];
        let current = read_file(root, path, known, native)?;
        if current == file.current {
            continue;
        }
        if current != file.restored {
            return Err(conflict());
        }
        write_file(
            root,
            path,
            known,
            native,
            file.restored.as_deref(),
            file.current.as_deref(),
        )?;
        if read_file(root, path, known, native)? != file.current {
            return Err(AppError::new(
                "verify_failed",
                "断开回滚后回读失败，恢复记录已保留",
            ));
        }
    }
    Ok(())
}

pub fn inspect(
    root: &Path,
    agent: AgentId,
    profile: Option<&ExistingProfile>,
) -> Result<ConfigurationSafety> {
    let Some(record) = load(root, agent, false)? else {
        return Ok(ConfigurationSafety {
            status: "untracked",
            can_disconnect: false,
            preview_token: None,
            files: vec![],
        });
    };
    let known = paths(root, agent, profile)?;
    validate(&record, agent, profile, &known)?;
    let mut files = vec![];
    let mut digest = Sha256::new();
    digest.update(serde_json::to_vec(&record).map_err(|_| conflict())?);
    digest
        .update(native_merge::read(root, &root.join("agent-selection.json"))?.unwrap_or_default());
    for file in &record.files {
        let current = read_file(root, &known[&file.slot], &known, profile.is_some())?;
        digest.update(serde_json::to_vec(&current).map_err(|_| conflict())?);
        let (_, managed_fields, changed_fields) =
            restore_file(file, &known[&file.slot], current.as_deref())?;
        files.push(ConfigurationFileStatus {
            slot: file.slot.clone(),
            managed_fields,
            changed_fields,
        });
    }
    let drifted = files.iter().any(|file| file.changed_fields > 0);
    Ok(ConfigurationSafety {
        status: if drifted { "drifted" } else { "healthy" },
        can_disconnect: !drifted,
        preview_token: (!drifted).then(|| format!("{:x}", digest.finalize())),
        files,
    })
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RestoreFile {
    slot: String,
    current: Option<String>,
    restored: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DisconnectJournal {
    agent: AgentId,
    selection_before: String,
    selection_after: String,
    files: Vec<RestoreFile>,
}
const DISCONNECT_JOURNAL: &str = "agent-disconnect.pending.json";
#[cfg(test)]
thread_local! {
    static FAIL_AFTER_FIRST_RESTORE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn write_file(
    root: &Path,
    path: &Path,
    known: &BTreeMap<String, PathBuf>,
    native: bool,
    expected: Option<&str>,
    text: Option<&str>,
) -> Result<()> {
    if native {
        native_merge::write_authorized_checked(path, known.values(), expected, text)
    } else {
        writer::write_with_validation(path, text, |target| {
            native_merge::read(root, target).map(|_| ())
        })
    }
}

pub(super) fn configuration_snapshots(
    root: &Path,
    agent: AgentId,
    profile: Option<&ExistingProfile>,
) -> Result<Vec<(PathBuf, Option<String>)>> {
    let known = snapshot_paths(root, agent, profile)?;
    let mut result = vec![];
    for path in known.values() {
        result.push((
            path.clone(),
            read_file(root, path, &known, profile.is_some())?,
        ));
    }
    for pending in [false, true] {
        let path = record_path(root, agent, pending);
        result.push((
            path.clone(),
            native_merge::read_limit(root, &path, 32 * 1024 * 1024)?,
        ));
    }
    Ok(result)
}

#[cfg(test)]
pub(super) fn write_configuration_snapshot(
    root: &Path,
    agent: AgentId,
    profile: Option<&ExistingProfile>,
    path: &Path,
    contents: Option<&str>,
) -> Result<()> {
    let known = snapshot_paths(root, agent, profile)?;
    let expected = if [
        record_path(root, agent, false),
        record_path(root, agent, true),
    ]
    .contains(&path.to_owned())
    {
        native_merge::read_limit(root, path, 32 * 1024 * 1024)?
    } else {
        read_file(root, path, &known, profile.is_some())?
    };
    write_configuration_snapshot_checked(root, agent, profile, path, expected.as_deref(), contents)
}

pub(super) fn write_configuration_snapshot_checked(
    root: &Path,
    agent: AgentId,
    profile: Option<&ExistingProfile>,
    path: &Path,
    expected: Option<&str>,
    contents: Option<&str>,
) -> Result<()> {
    let known = snapshot_paths(root, agent, profile)?;
    if [
        record_path(root, agent, false),
        record_path(root, agent, true),
    ]
    .contains(&path.to_owned())
    {
        return writer::write_with_validation(path, contents, |target| {
            native_merge::read_limit(root, target, 32 * 1024 * 1024).map(|_| ())
        });
    }
    if !known.values().any(|candidate| candidate == path) {
        return Err(AppError::new("unsafe_path", "拒绝恢复未选择的配置文件"));
    }
    write_file(root, path, &known, profile.is_some(), expected, contents)
}

fn snapshot_paths(
    root: &Path,
    agent: AgentId,
    profile: Option<&ExistingProfile>,
) -> Result<BTreeMap<String, PathBuf>> {
    let mut known = paths(root, agent, profile)?;
    if profile.is_none() {
        let directory = root.join("agents").join(agent.as_str());
        if agent == AgentId::DeepSeekHarness {
            let harness = directory.join("home/.dsh/profiles/headless");
            known.insert("profile-package".into(), harness.join("package.json"));
            known.insert(
                "profile-workspace".into(),
                harness.join("pnpm-workspace.yaml"),
            );
        }
        known.insert(
            "environment".into(),
            directory.join("configuration/environment.json"),
        );
        if cfg!(windows) {
            known.insert("launcher".into(), directory.join("launch.ps1"));
            known.insert("launcher-command".into(), directory.join("launch.cmd"));
        } else {
            known.insert("launcher".into(), directory.join("launch.sh"));
        }
    }
    Ok(known)
}

/// The caller supplies a selection with this agent removed, while retaining the
/// original selection as an independent, exact file snapshot.
pub fn disconnect(
    root: &Path,
    agent: AgentId,
    profile: Option<&ExistingProfile>,
    preview_token: &str,
    selection_before: &str,
    selection_after: &str,
) -> Result<()> {
    let report = inspect(root, agent, profile)?;
    if !report.can_disconnect || report.preview_token.as_deref() != Some(preview_token) {
        return Err(conflict());
    }
    let record = load(root, agent, false)?.ok_or_else(conflict)?;
    let known = paths(root, agent, profile)?;
    let before: Value = serde_json::from_str(selection_before).map_err(|_| conflict())?;
    let after: Value = serde_json::from_str(selection_after).map_err(|_| conflict())?;
    let mut expected = before.clone();
    expected
        .as_object_mut()
        .ok_or_else(conflict)?
        .remove(agent.as_str());
    if expected != after
        || before
            .get(agent.as_str())
            .and_then(|selection| selection.get("profile"))
            .filter(|value| !value.is_null())
            .cloned()
            != profile.map(|profile| serde_json::to_value(profile).expect("profile serialization"))
    {
        return Err(conflict());
    }
    if native_merge::read(root, &root.join("agent-selection.json"))?.as_deref()
        != Some(selection_before)
    {
        return Err(conflict());
    }
    let mut files = vec![];
    for file in &record.files {
        let current = read_file(root, &known[&file.slot], &known, profile.is_some())?;
        let (restored, _, conflicts) = restore_file(file, &known[&file.slot], current.as_deref())?;
        if conflicts > 0 {
            return Err(conflict());
        }
        files.push(RestoreFile {
            slot: file.slot.clone(),
            current,
            restored,
        });
    }
    let journal = DisconnectJournal {
        agent,
        selection_before: selection_before.into(),
        selection_after: selection_after.into(),
        files,
    };
    if inspect(root, agent, profile)?.preview_token.as_deref() != Some(preview_token) {
        return Err(conflict());
    }
    let serialized = signed_disconnect(root, &journal)?;
    if serialized.len() > 32 * 1024 * 1024 {
        return Err(AppError::new("response_limit", "断开恢复事务超过限制"));
    }
    super::write_checked(root, &root.join(DISCONNECT_JOURNAL), &serialized)?;
    if let Err(error) = recover_disconnect(root) {
        // A synchronous failure can undo only writes that still match this
        // transaction. A process crash keeps the journal for restart recovery.
        if native_merge::read(root, &root.join("agent-selection.json"))?.as_deref()
            != Some(selection_after)
        {
            if rollback_disconnect(root, &journal, &known, profile.is_some()).is_err() {
                return Err(AppError::new(
                    "recovery_required",
                    "断开期间配置发生变化，恢复记录已保留；请核对原客户端配置后重试",
                ));
            }
            writer::write(&root.join(DISCONNECT_JOURNAL), None)?;
        }
        return Err(error);
    }
    Ok(())
}

fn recover_disconnect(root: &Path) -> Result<()> {
    let journal_path = root.join(DISCONNECT_JOURNAL);
    let Some(text) = native_merge::read_limit(root, &journal_path, 32 * 1024 * 1024)? else {
        return Ok(());
    };
    let payload = crate::local_integrity::open(root, "agent-disconnect", &text)?;
    let journal: DisconnectJournal = serde_json::from_str(&payload)
        .map_err(|_| AppError::new("invalid_state", "断开恢复记录损坏，未修改客户端配置"))?;
    let mut expected: Value =
        serde_json::from_str(&journal.selection_before).map_err(|_| conflict())?;
    if expected
        .as_object_mut()
        .ok_or_else(conflict)?
        .remove(journal.agent.as_str())
        .is_none()
        || serde_json::from_str::<Value>(&journal.selection_after).map_err(|_| conflict())?
            != expected
    {
        return Err(conflict());
    }
    let selection = native_merge::read(root, &root.join("agent-selection.json"))?;
    if selection.as_deref() == Some(&journal.selection_after) {
        writer::write(&record_path(root, journal.agent, false), None)?;
        return writer::write(&journal_path, None);
    }
    if selection.as_deref() != Some(&journal.selection_before) {
        return Err(conflict());
    }
    let profile = crate::agent_hub::existing_profile(root, journal.agent)?;
    let record = load(root, journal.agent, false)?.ok_or_else(conflict)?;
    let known = paths(root, journal.agent, profile.as_ref())?;
    validate(&record, journal.agent, profile.as_ref(), &known)?;
    if journal.files.len() != record.files.len() {
        return Err(conflict());
    }
    let mut unique = std::collections::HashSet::new();
    for file in &journal.files {
        let path = known.get(&file.slot).ok_or_else(conflict)?;
        let original = record
            .files
            .iter()
            .find(|old| old.slot == file.slot)
            .ok_or_else(conflict)?;
        if !unique.insert(&file.slot)
            || file
                .current
                .as_ref()
                .is_some_and(|text| text.len() > 4 * 1024 * 1024)
            || file
                .restored
                .as_ref()
                .is_some_and(|text| text.len() > 4 * 1024 * 1024)
        {
            return Err(conflict());
        }
        let (restored, _, conflicts) = restore_file(original, path, file.current.as_deref())?;
        if conflicts > 0 || restored != file.restored {
            return Err(conflict());
        }
        let current = read_file(root, path, &known, profile.is_some())?;
        if current != file.current && current != file.restored {
            return Err(conflict());
        }
    }
    for (index, file) in journal.files.iter().enumerate() {
        #[cfg(test)]
        if index == 1 && FAIL_AFTER_FIRST_RESTORE.with(|value| value.replace(false)) {
            return Err(AppError::new(
                "fixture_write_failure",
                "模拟第二个文件写入失败",
            ));
        }
        #[cfg(not(test))]
        let _ = index;
        let path = &known[&file.slot];
        let current = read_file(root, path, &known, profile.is_some())?;
        if current == file.restored {
            continue;
        }
        if current != file.current {
            return Err(conflict());
        }
        write_file(
            root,
            path,
            &known,
            profile.is_some(),
            file.current.as_deref(),
            file.restored.as_deref(),
        )?;
        if read_file(root, path, &known, profile.is_some())? != file.restored {
            return Err(AppError::new(
                "verify_failed",
                "恢复客户端配置后回读失败，恢复记录已保留",
            ));
        }
    }
    if native_merge::read(root, &root.join("agent-selection.json"))?.as_deref()
        != Some(&journal.selection_before)
    {
        return Err(conflict());
    }
    super::write_checked(
        root,
        &root.join("agent-selection.json"),
        &journal.selection_after,
    )?;
    writer::write(&record_path(root, journal.agent, false), None)?;
    writer::write(&journal_path, None)
}

fn signed_disconnect(root: &Path, journal: &DisconnectJournal) -> Result<String> {
    let payload = serde_json::to_string(journal).map_err(|_| conflict())?;
    crate::local_integrity::seal(root, "agent-disconnect", &payload)
}

#[cfg(test)]
mod tests;
