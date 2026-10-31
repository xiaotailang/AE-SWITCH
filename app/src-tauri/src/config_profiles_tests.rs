use super::*;
use crate::{
    agent_hub::AgentInput,
    bridge::Route,
    types::{CodexOptions, Family, ProviderInput, ProviderModel},
};

fn fixture() -> (tempfile::TempDir, Store, String, String) {
    fixture_mode(false)
}

fn fixture_mode(native: bool) -> (tempfile::TempDir, Store, String, String) {
    let temporary = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
    let mut store = Store::open(temporary.path().join("data")).unwrap();
    store.set_bridge_route(Route {
        port: 18762,
        token: "synthetic-local-token".into(),
    });
    let mut ids = vec![];
    for (name, model, effort) in [("first", "model-a", "high"), ("second", "model-b", "low")] {
        let provider = store
            .save(ProviderInput {
                id: None,
                edited_context_model_ids: vec![],
                family: Family::Codex,
                name: name.into(),
                base_url: "https://invalid.example/v1".into(),
                api_key: Some(format!("synthetic-private-key-{name}")),
                balance_access_token: None,
                model: model.into(),
                auth_mode: "bearer".into(),
                reasoning_effort: Some(effort.into()),
                codex_options: CodexOptions {
                    models: vec![ProviderModel {
                        id: model.into(),
                        context_window: Some(256000),
                        reasoning_efforts: vec![],
                        enabled: true,
                    }],
                    ..Default::default()
                },
            })
            .unwrap();
        ids.push(provider.id);
    }
    for agent in [AgentId::Codex, AgentId::Hermes] {
        let profile = native.then(|| {
            let directory = temporary
                .path()
                .join(format!("original-{}", agent.as_str()));
            let home = temporary.path().join("native-home");
            let workspace = temporary.path().join("native-workspace");
            for path in [&directory, &home, &workspace] {
                std::fs::create_dir_all(path).unwrap();
            }
            let executable = temporary.path().join(if cfg!(windows) {
                "official-fixture.exe"
            } else {
                "official-fixture"
            });
            std::fs::write(&executable, "fixture, never executed").unwrap();
            agent_configs::ExistingProfile {
                directory: directory.to_string_lossy().into(),
                home_directory: home.to_string_lossy().into(),
                executable_path: executable.to_string_lossy().into(),
                workspace_directory: workspace.to_string_lossy().into(),
                ..Default::default()
            }
        });
        agent_hub::configure(
            &store,
            AgentInput {
                agent_id: agent,
                provider_id: ids[0].clone(),
                model: None,
                profile,
            },
        )
        .unwrap();
    }
    (temporary, store, ids[0].clone(), ids[1].clone())
}

fn capture(store: &Store, name: &str) -> ConfigProfile {
    save(
        store,
        SaveProfileInput {
            name: name.into(),
            id: None,
            revision: None,
            agent_ids: vec![],
        },
    )
    .unwrap()
}

fn switch(store: &Store, provider: &str) {
    let (saved, _) = agent_hub::read_selections(&store.data_directory).unwrap();
    for agent in [AgentId::Codex, AgentId::Hermes] {
        agent_hub::configure(
            store,
            AgentInput {
                agent_id: agent,
                provider_id: provider.into(),
                model: None,
                profile: saved[agent.as_str()].profile.clone(),
            },
        )
        .unwrap();
    }
}

fn snapshot(store: &Store) -> Vec<(PathBuf, Option<String>)> {
    let mut snapshots = vec![(
        store.data_directory.join("agent-selection.json"),
        read_owned(&store.data_directory, "agent-selection.json", MAX_SIZE).unwrap(),
    )];
    let (saved, _) = agent_hub::read_selections(&store.data_directory).unwrap();
    for agent in [AgentId::Codex, AgentId::Hermes] {
        snapshots.extend(
            agent_configs::configuration_snapshots(
                &store.data_directory,
                agent,
                saved[agent.as_str()].profile.as_ref(),
            )
            .unwrap(),
        );
    }
    snapshots
}

#[test]
fn named_profiles_capture_no_secrets_or_paths_and_prevent_referenced_provider_deletion() {
    let (_temporary, mut store, first, second) = fixture();
    let profile = capture(&store, "工作");
    let text = read_owned(&store.data_directory, FILE, MAX_SIZE)
        .unwrap()
        .unwrap();
    for forbidden in [
        "synthetic-private-key",
        "synthetic-local-token",
        "https://",
        "directory",
        "profileName",
        "apiKey",
        "homeDirectory",
    ] {
        assert!(
            !text.contains(forbidden),
            "saved profile contains {forbidden}"
        );
    }
    assert!(!text.contains(&store.data_directory.to_string_lossy().to_string()));
    assert_eq!(profile.entries.len(), 2);
    switch(&store, &second);
    assert_eq!(store.delete(&first).unwrap_err().code, "in_use");
    delete(&store.data_directory, &profile.id, profile.revision).unwrap();
    store.delete(&first).unwrap();
}

#[test]
fn batch_preview_and_apply_restore_each_client_model_and_reasoning_snapshot() {
    let (_temporary, store, first, second) = fixture();
    let profile = capture(&store, "工作");
    switch(&store, &second);
    let preview = preview(&store, &profile.id).unwrap();
    assert!(preview.entries.iter().all(|entry| entry.changed
        && entry.previous_model == "model-b"
        && entry.model == "model-a"
        && entry.reasoning_effort.as_deref() == Some("high")));
    let safe = serde_json::to_string(&preview).unwrap();
    assert!(!safe.contains("synthetic-private-key"));
    assert!(!safe.contains("directory"));
    let result = apply(
        &store,
        ApplyProfileInput {
            id: profile.id,
            revision: profile.revision,
            fingerprint: preview.fingerprint,
        },
    )
    .unwrap();
    assert_eq!(
        result.applied_agent_ids,
        vec![AgentId::Codex, AgentId::Hermes]
    );
    let (saved, _) = agent_hub::read_selections(&store.data_directory).unwrap();
    for agent in [AgentId::Codex, AgentId::Hermes] {
        let selected = &saved[agent.as_str()];
        assert_eq!(selected.provider_id, first);
        assert_eq!(selected.model, "model-a");
        assert_eq!(selected.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(
            agent_configs::configuration_safety(&store.data_directory, agent, None)
                .unwrap()
                .status,
            "healthy"
        );
    }
    assert!(!store.data_directory.join(JOURNAL).exists());
}

#[test]
fn stale_preview_refuses_external_changes_before_any_write() {
    let (_temporary, store, _first, second) = fixture();
    let profile = capture(&store, "工作");
    switch(&store, &second);
    let preview = preview(&store, &profile.id).unwrap();
    let path = store
        .data_directory
        .join("agents/codex/home/.codex/config.toml");
    let original = std::fs::read_to_string(&path).unwrap();
    std::fs::write(&path, format!("{original}\n# external client comment\n")).unwrap();
    let before = snapshot(&store);
    assert_eq!(
        apply(
            &store,
            ApplyProfileInput {
                id: profile.id,
                revision: profile.revision,
                fingerprint: preview.fingerprint
            }
        )
        .unwrap_err()
        .code,
        "configuration_profile_changed"
    );
    assert_eq!(snapshot(&store), before);
}

#[test]
fn any_partial_write_failure_rolls_back_all_clients_and_ownership_byte_for_byte() {
    let (_temporary, store, _first, second) = fixture();
    let profile = capture(&store, "工作");
    switch(&store, &second);
    let plan = plan(&store, profile).unwrap();
    let before = snapshot(&store);
    let error = commit(&store.data_directory, &plan.journal, |index| {
        if index == 3 {
            Err(AppError::new("synthetic_failure", "fixture"))
        } else {
            Ok(())
        }
    })
    .unwrap_err();
    assert_eq!(error.code, "synthetic_failure");
    assert_eq!(snapshot(&store), before);
    assert!(!store.data_directory.join(JOURNAL).exists());
}

#[test]
fn interrupted_batch_recovers_before_lower_level_ownership_recovery() {
    let (_temporary, store, _first, second) = fixture();
    let profile = capture(&store, "工作");
    switch(&store, &second);
    let plan = plan(&store, profile).unwrap();
    let before = snapshot(&store);
    write_owned(
        &store.data_directory,
        JOURNAL,
        Some(&signed_journal(&store.data_directory, &plan.journal).unwrap()),
    )
    .unwrap();
    let resolved = resolve(&store.data_directory, &plan.journal).unwrap();
    let (saved, _) = agent_hub::read_selections(&store.data_directory).unwrap();
    for (change, (path, _)) in plan.journal.changes.iter().zip(&resolved).take(4) {
        agent_configs::write_configuration_snapshot(
            &store.data_directory,
            change.agent_id,
            saved[change.agent_id.as_str()].profile.as_ref(),
            path,
            change.after.as_deref(),
        )
        .unwrap();
    }
    recover(&store.data_directory).unwrap();
    assert_eq!(snapshot(&store), before);
    assert!(!store.data_directory.join(JOURNAL).exists());
}

#[test]
fn rollback_and_recovery_never_overwrite_a_concurrent_client_edit() {
    let (_temporary, store, _first, second) = fixture();
    let profile = capture(&store, "工作");
    switch(&store, &second);
    let plan = plan(&store, profile).unwrap();
    let resolved = resolve(&store.data_directory, &plan.journal).unwrap();
    let external_path = resolved[0].0.clone();
    let error = commit(&store.data_directory, &plan.journal, |index| {
        if index == 0 {
            std::fs::write(&external_path, "external-client-edit").unwrap();
            Err(AppError::new("synthetic_failure", "fixture"))
        } else {
            Ok(())
        }
    })
    .unwrap_err();
    assert_eq!(error.code, "recovery_required");
    assert_eq!(
        std::fs::read_to_string(&external_path).unwrap(),
        "external-client-edit"
    );
    assert!(store.data_directory.join(JOURNAL).exists());
    assert!(recover(&store.data_directory).is_err());
    assert_eq!(
        std::fs::read_to_string(&external_path).unwrap(),
        "external-client-edit"
    );
}

#[test]
fn malformed_or_unknown_slot_journals_cannot_authorize_any_write() {
    let (_temporary, store, _first, second) = fixture();
    let profile = capture(&store, "工作");
    switch(&store, &second);
    let mut plan = plan(&store, profile).unwrap();
    let before = snapshot(&store);
    plan.journal.changes[0].slot = usize::MAX;
    write_owned(
        &store.data_directory,
        JOURNAL,
        Some(&signed_journal(&store.data_directory, &plan.journal).unwrap()),
    )
    .unwrap();
    assert!(recover(&store.data_directory).is_err());
    assert_eq!(snapshot(&store), before);
    write_owned(&store.data_directory, JOURNAL, Some("{malformed")).unwrap();
    assert!(recover(&store.data_directory).is_err());
    assert_eq!(snapshot(&store), before);
}

#[test]
fn save_and_delete_require_matching_revisions_and_unique_names() {
    let (_temporary, store, _first, _second) = fixture();
    let profile = capture(&store, "工作");
    assert_eq!(
        save(
            &store,
            SaveProfileInput {
                name: "工作".into(),
                id: None,
                revision: None,
                agent_ids: vec![]
            }
        )
        .unwrap_err()
        .code,
        "profile_name_exists"
    );
    assert!(delete(&store.data_directory, &profile.id, 0).is_err());
    let updated = save(
        &store,
        SaveProfileInput {
            name: "工作".into(),
            id: Some(profile.id),
            revision: Some(profile.revision),
            agent_ids: vec![AgentId::Codex],
        },
    )
    .unwrap();
    assert_eq!(updated.revision, 2);
    assert_eq!(updated.entries.len(), 1);
}

#[test]
fn forged_journal_cannot_change_unlisted_agents_or_regress_selection_revisions() {
    let (_temporary, store, first, second) = fixture();
    agent_hub::configure(
        &store,
        AgentInput {
            agent_id: AgentId::ClaudeCode,
            provider_id: first,
            model: None,
            profile: None,
        },
    )
    .unwrap();
    let profile = save(
        &store,
        SaveProfileInput {
            name: "codex only".into(),
            id: None,
            revision: None,
            agent_ids: vec![AgentId::Codex],
        },
    )
    .unwrap();
    switch(&store, &second);
    let mut plan = plan(&store, profile).unwrap();
    let before = snapshot(&store);
    let mut selections: BTreeMap<String, Selection> =
        serde_json::from_str(&plan.journal.selection_after).unwrap();
    selections.get_mut("claude_code").unwrap().model = "forged-model".into();
    plan.journal.selection_after = serde_json::to_string_pretty(&selections).unwrap();
    assert!(resolve(&store.data_directory, &plan.journal).is_err());
    selections.get_mut("claude_code").unwrap().model = "model-a".into();
    selections.get_mut("codex").unwrap().configuration_revision = 0;
    plan.journal.selection_after = serde_json::to_string_pretty(&selections).unwrap();
    assert!(resolve(&store.data_directory, &plan.journal).is_err());
    assert_eq!(snapshot(&store), before);
}

#[test]
fn native_multi_client_targets_apply_and_rollback_without_copying_paths_into_profiles() {
    let (_temporary, store, first, second) = fixture_mode(true);
    let profile = capture(&store, "native work");
    switch(&store, &second);
    let plan = plan(&store, profile.clone()).unwrap();
    let before = snapshot(&store);
    assert!(plan
        .preview
        .entries
        .iter()
        .all(|entry| entry.target_mode == "existing"));
    assert_eq!(
        commit(
            &store.data_directory,
            &plan.journal,
            |index| if index == 2 {
                Err(AppError::new("synthetic_failure", "fixture"))
            } else {
                Ok(())
            }
        )
        .unwrap_err()
        .code,
        "synthetic_failure"
    );
    assert_eq!(snapshot(&store), before);
    let preview = preview(&store, &profile.id).unwrap();
    apply(
        &store,
        ApplyProfileInput {
            id: profile.id,
            revision: profile.revision,
            fingerprint: preview.fingerprint,
        },
    )
    .unwrap();
    let (saved, _) = agent_hub::read_selections(&store.data_directory).unwrap();
    assert!(saved
        .values()
        .all(|selection| selection.provider_id == first && selection.profile.is_some()));
    assert!(!read_owned(&store.data_directory, FILE, MAX_SIZE)
        .unwrap()
        .unwrap()
        .contains("original-"));
}

#[test]
fn authenticated_journal_rejects_tampered_before_and_after_without_any_native_write() {
    let (_temporary, store, _first, second) = fixture();
    let profile = capture(&store, "工作");
    switch(&store, &second);
    let plan = plan(&store, profile).unwrap();
    let before = snapshot(&store);
    let text = signed_journal(&store.data_directory, &plan.journal).unwrap();
    let envelope: serde_json::Value = serde_json::from_str(&text).unwrap();
    for field in ["before", "after"] {
        let mut tampered = envelope.clone();
        let mut payload: serde_json::Value =
            serde_json::from_str(tampered["payload"].as_str().unwrap()).unwrap();
        payload["changes"][0][field] = serde_json::json!("forged-native-config");
        tampered["payload"] = serde_json::json!(serde_json::to_string(&payload).unwrap());
        write_owned(
            &store.data_directory,
            JOURNAL,
            Some(&serde_json::to_string(&tampered).unwrap()),
        )
        .unwrap();
        assert_eq!(
            recover(&store.data_directory).unwrap_err().code,
            "invalid_private_state"
        );
        assert_eq!(snapshot(&store), before);
    }
    assert!(!read_owned(&store.data_directory, FILE, MAX_SIZE)
        .unwrap()
        .unwrap()
        .contains(crate::local_integrity::KEY_FILE));
}

#[test]
fn unresolved_batch_blocks_configure_safety_and_disconnect_without_changes() {
    let (_temporary, store, first, _second) = fixture();
    let before = snapshot(&store);
    write_owned(&store.data_directory, JOURNAL, Some("{malformed")).unwrap();
    assert!(agent_hub::configure(
        &store,
        AgentInput {
            agent_id: AgentId::Codex,
            provider_id: first,
            model: None,
            profile: None
        }
    )
    .is_err());
    assert!(agent_hub::configuration_safety(&store, AgentId::Codex).is_err());
    assert!(agent_hub::disconnect(&store, AgentId::Codex, "untrusted-preview").is_err());
    assert_eq!(snapshot(&store), before);
}
