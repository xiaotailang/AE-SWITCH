use super::*;

fn fixture(agent: AgentId) -> (tempfile::TempDir, PathBuf, ExistingProfile) {
    let temporary = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
    let data = temporary.path().join("ae-data");
    let native = temporary.path().join("client-config");
    let home = temporary.path().join("client-home");
    let workspace = temporary.path().join("workspace");
    for directory in [&data, &native, &home, &workspace] {
        std::fs::create_dir_all(directory).unwrap();
    }
    let executable = temporary.path().join("client.exe");
    std::fs::write(&executable, "fixture, never executed").unwrap();
    let mut profile = ExistingProfile {
        directory: native.to_string_lossy().into(),
        home_directory: home.to_string_lossy().into(),
        executable_path: executable.to_string_lossy().into(),
        workspace_directory: workspace.to_string_lossy().into(),
        ..Default::default()
    };
    if agent == AgentId::DeepSeekHarness {
        profile.data_directory = Some(home.join(".dsh").to_string_lossy().into());
        profile.profile_name = Some("headless".into());
        std::fs::write(native.join("package.json"), r#"{"private":true,"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-headless"]}}}"#).unwrap();
    }
    if agent == AgentId::Zcode {
        profile.state_file = Some(
            home.join(".zcode/v2/agents-state.json")
                .to_string_lossy()
                .into(),
        );
        profile.config_file = Some(
            home.join(".zcode/v2/provider_config.json")
                .to_string_lossy()
                .into(),
        );
    }
    (temporary, data, profile)
}

fn apply(root: &Path, agent: AgentId, profile: &ExistingProfile, model: &str) {
    let path = root.join("agent-selection.json");
    let before = std::fs::read_to_string(&path).ok();
    let after = serde_json::to_string(
        &json!({agent.as_str(): {"providerId":"fixture","model":model,"profile":profile}}),
    )
    .unwrap();
    super::super::configure_existing_with_selection(
        root,
        agent,
        "http://127.0.0.1:18762/v1",
        "secret-fixture-never-report",
        model,
        profile,
        (&path, &after, before.as_deref()),
    )
    .unwrap();
}

fn add_unrelated(path: &Path) {
    let text = std::fs::read_to_string(path).unwrap();
    let result = if path
        .extension()
        .is_some_and(|extension| extension == "toml")
    {
        let mut doc = text.parse::<toml_edit::DocumentMut>().unwrap();
        doc["userLater"] = toml_edit::value("preserve-me");
        doc.to_string()
    } else {
        let mut value = document(path, Some(&text)).unwrap();
        if let Some(array) = value.as_array_mut() {
            array.push(json!({"userLater":"preserve-me"}));
        } else {
            value
                .as_object_mut()
                .unwrap()
                .insert("userLater".into(), json!("preserve-me"));
        }
        render(path, Some(&text), &value, None, &[]).unwrap()
    };
    std::fs::write(path, result).unwrap();
}

#[test]
fn later_empty_user_objects_tables_and_array_members_are_not_owned() {
    for (extension, before, after, current) in [
        ("json", r#"{"original":true}"#, r#"{"original":true,"managed":{"model":"ae"}}"#,
         r#"{"original":true,"managed":{"model":"ae","userEmpty":{}},"empty":{},"nested":{"empty":{},"kept":true},"rows":[{},{}]}"#),
        ("yaml", "original: true\n", "original: true\nmanaged:\n  model: ae\n",
         "original: true\nmanaged:\n  model: ae\n  userEmpty: {}\nempty: {}\nnested:\n  empty: {}\n  kept: true\nrows: [{}, {}]\n"),
        ("toml", "original = true\n", "original = true\n[managed]\nmodel = 'ae'\n",
         "original = true\n[managed]\nmodel = 'ae'\nuserEmpty = {}\n[empty]\n[nested]\nempty = {}\nkept = true\nrows = [{}, {}]\n"),
    ] {
        let path = PathBuf::from(format!("owned.{extension}"));
        let state = FileState { slot: "config".into(), before: Some(before.into()), after: after.into() };
        let (restored, _, conflicts) = restore_file(&state, &path, Some(current)).unwrap();
        assert_eq!(conflicts, 0);
        let value = document(&path, restored.as_deref()).unwrap();
        assert_eq!(value["empty"], json!({}), "{extension}");
        assert_eq!(value["nested"]["empty"], json!({}), "{extension}");
        assert_eq!(value["managed"]["userEmpty"], json!({}), "{extension}");
        assert!(value["managed"].get("model").is_none());
        let rows = value.get("rows").unwrap_or(&value["nested"]["rows"]).clone();
        assert_eq!(rows, json!([{}, {}]), "{extension}");
    }
}

#[test]
fn only_empty_managed_ancestors_are_pruned_on_restore() {
    let path = Path::new("owned.json");
    let file = FileState {
        slot: "config".into(),
        before: Some("{}".into()),
        after: r#"{"managed":{"child":{"model":"ae"}}}"#.into(),
    };
    let (restored, _, conflicts) = restore_file(
        &file,
        path,
        Some(r#"{"managed":{"child":{"model":"ae"}},"user":{}}"#),
    )
    .unwrap();
    assert_eq!(conflicts, 0);
    assert_eq!(
        document(path, restored.as_deref()).unwrap(),
        json!({"user":{}})
    );
}

#[test]
fn all_eight_existing_clients_restore_original_fields_and_keep_later_settings() {
    for definition in super::super::definitions() {
        let agent = definition.id;
        let (_temporary, data, profile) = fixture(agent);
        apply(&data, agent, &profile, "first-model");
        apply(&data, agent, &profile, "second-model");
        let known = paths(&data, agent, Some(&profile)).unwrap();
        let array_root = document(
            &known["config"],
            Some(&std::fs::read_to_string(&known["config"]).unwrap()),
        )
        .unwrap()
        .is_array();
        add_unrelated(&known["config"]);
        let report = inspect(&data, agent, Some(&profile)).unwrap();
        assert_eq!(report.status, "healthy", "{}", agent.as_str());
        assert!(report.can_disconnect);
        let public = serde_json::to_string(&report).unwrap();
        assert!(!public.contains("secret-fixture"));
        assert!(!public.contains(&profile.directory));
        let selection = std::fs::read_to_string(data.join("agent-selection.json")).unwrap();
        disconnect(
            &data,
            agent,
            Some(&profile),
            report.preview_token.as_deref().unwrap(),
            &selection,
            "{}",
        )
        .unwrap();
        let text = std::fs::read_to_string(&known["config"]).unwrap();
        let expected = if array_root {
            json!([{"userLater":"preserve-me"}])
        } else {
            json!({"userLater":"preserve-me"})
        };
        assert_eq!(
            document(&known["config"], Some(&text)).unwrap(),
            expected,
            "{}",
            agent.as_str()
        );
        assert_eq!(
            std::fs::read_to_string(data.join("agent-selection.json")).unwrap(),
            "{}"
        );
        assert_eq!(
            inspect(&data, agent, Some(&profile)).unwrap().status,
            "untracked"
        );
    }
}

#[test]
fn repeated_configuration_preserves_first_original_native_contents() {
    let (_temporary, data, profile) = fixture(AgentId::Codex);
    let path = paths(&data, AgentId::Codex, Some(&profile)).unwrap()["config"].clone();
    let original = "# original comment\nmodel = 'original'\nmodel_provider = 'original-provider'\n[features]\nmemory_tool = true\n";
    std::fs::write(&path, original).unwrap();
    apply(&data, AgentId::Codex, &profile, "first");
    apply(&data, AgentId::Codex, &profile, "second");
    let report = inspect(&data, AgentId::Codex, Some(&profile)).unwrap();
    let selection = std::fs::read_to_string(data.join("agent-selection.json")).unwrap();
    disconnect(
        &data,
        AgentId::Codex,
        Some(&profile),
        report.preview_token.as_deref().unwrap(),
        &selection,
        "{}",
    )
    .unwrap();
    assert_eq!(std::fs::read_to_string(path).unwrap(), original);
}

#[test]
fn managed_field_changes_block_restore_and_reapply_without_touching_files() {
    let (_temporary, data, profile) = fixture(AgentId::ClaudeCode);
    apply(&data, AgentId::ClaudeCode, &profile, "first");
    let path = paths(&data, AgentId::ClaudeCode, Some(&profile)).unwrap()["config"].clone();
    let changed = std::fs::read_to_string(&path)
        .unwrap()
        .replace("first", "manual-model");
    std::fs::write(&path, &changed).unwrap();
    let report = inspect(&data, AgentId::ClaudeCode, Some(&profile)).unwrap();
    assert_eq!(report.status, "drifted");
    assert!(!report.can_disconnect);
    assert!(report.preview_token.is_none());
    let selection = std::fs::read_to_string(data.join("agent-selection.json")).unwrap();
    assert!(disconnect(
        &data,
        AgentId::ClaudeCode,
        Some(&profile),
        "invalid",
        &selection,
        "{}"
    )
    .is_err());
    assert_eq!(std::fs::read_to_string(path).unwrap(), changed);
}

#[test]
fn preview_is_invalidated_by_later_unrelated_file_changes() {
    let (_temporary, data, profile) = fixture(AgentId::OpenCode);
    apply(&data, AgentId::OpenCode, &profile, "first");
    let report = inspect(&data, AgentId::OpenCode, Some(&profile)).unwrap();
    let path = paths(&data, AgentId::OpenCode, Some(&profile)).unwrap()["config"].clone();
    add_unrelated(&path);
    let changed = std::fs::read_to_string(&path).unwrap();
    let selection = std::fs::read_to_string(data.join("agent-selection.json")).unwrap();
    assert!(disconnect(
        &data,
        AgentId::OpenCode,
        Some(&profile),
        report.preview_token.as_deref().unwrap(),
        &selection,
        "{}"
    )
    .is_err());
    assert_eq!(std::fs::read_to_string(path).unwrap(), changed);
}

#[test]
fn edited_managed_array_row_refuses_restore_without_losing_new_client_rows() {
    let file = FileState {
        slot: "config".into(),
        before: Some(r#"{"rows":[{"id":"original"}]}"#.into()),
        after: r#"{"rows":[{"id":"original"},{"id":"ae"}]}"#.into(),
    };
    let current =
        r#"{"rows":[{"id":"original"},{"id":"ae-manually-edited"},{"id":"new-user-row"}]}"#;
    let (_, _, conflicts) = restore_file(&file, Path::new("models.json"), Some(current)).unwrap();
    assert_eq!(conflicts, 1);
}

#[test]
fn jsonc_restore_preserves_unowned_comments_and_fields() {
    let file = FileState {
        slot: "config".into(),
        before: Some("{\n // original setting\n \"model\": \"old\",\n}\n".into()),
        after: "{\n // original setting\n \"model\": \"new\",\n \"apiKey\": \"owned\",\n}\n".into(),
    };
    let current = "{\n // original setting\n \"model\": \"new\",\n \"apiKey\": \"owned\",\n // user later\n \"extra\": true\n}\n";
    let (restored, _, conflicts) =
        restore_file(&file, Path::new("opencode.json"), Some(current)).unwrap();
    assert_eq!(conflicts, 0);
    let restored = restored.unwrap();
    assert!(restored.contains("// original setting"));
    assert!(restored.contains("// user later"));
    assert_eq!(
        document(Path::new("opencode.json"), Some(&restored)).unwrap(),
        json!({"model":"old","extra":true})
    );
}

#[test]
fn toml_restore_keeps_user_comments_memory_and_later_settings() {
    let file = FileState { slot: "config".into(), before: Some("# original\nmodel = 'old'\n[features]\nmemory_tool = true\n".into()), after: "# original\nmodel = 'new'\n[features]\nmemory_tool = true\n[model_providers.ae_switch]\nbase_url = 'http://127.0.0.1:7'\n".into() };
    let current = "# original\nmodel = 'new'\n# later comment\nuserLater = true\n[features]\nmemory_tool = true\n[model_providers.ae_switch]\nbase_url = 'http://127.0.0.1:7'\n";
    let (restored, _, conflicts) =
        restore_file(&file, Path::new("config.toml"), Some(current)).unwrap();
    assert_eq!(conflicts, 0);
    let restored = restored.unwrap();
    assert!(restored.contains("# later comment"));
    assert!(restored.contains("memory_tool = true"));
    assert!(restored.contains("model = 'old'"));
    assert!(!restored.contains("ae_switch"));
}

#[test]
fn yaml_restore_keeps_unowned_comments_and_opaque_block() {
    let file = FileState {
        slot: "config".into(),
        before: Some("# original\nmodel: old\nprompt: |\n  preserve text\n".into()),
        after: "# original\nmodel: new\nprompt: |\n  preserve text\napi_key: owned\n".into(),
    };
    let current = "# original\nmodel: new\nprompt: |\n  preserve text\napi_key: owned\n# later\nextra: true\n";
    let (restored, _, conflicts) =
        restore_file(&file, Path::new("config.yaml"), Some(current)).unwrap();
    assert_eq!(conflicts, 0);
    let restored = restored.unwrap();
    assert!(restored.contains("# later"));
    assert!(restored.contains("prompt: |\n  preserve text"));
    assert_eq!(
        document(Path::new("config.yaml"), Some(&restored)).unwrap()["model"],
        "old"
    );
}

#[test]
fn missing_or_damaged_owned_file_is_never_silently_recreated() {
    let (_temporary, data, profile) = fixture(AgentId::ClaudeCode);
    apply(&data, AgentId::ClaudeCode, &profile, "first");
    let path = paths(&data, AgentId::ClaudeCode, Some(&profile)).unwrap()["config"].clone();
    std::fs::remove_file(&path).unwrap();
    assert_eq!(
        inspect(&data, AgentId::ClaudeCode, Some(&profile))
            .unwrap()
            .status,
        "drifted"
    );
    std::fs::write(&path, "not JSON").unwrap();
    assert!(inspect(&data, AgentId::ClaudeCode, Some(&profile)).is_err());
    assert_eq!(std::fs::read_to_string(path).unwrap(), "not JSON");
}

#[test]
fn arbitrary_restore_path_and_profile_switch_are_rejected() {
    let (_temporary, data, profile) = fixture(AgentId::ClaudeCode);
    apply(&data, AgentId::ClaudeCode, &profile, "first");
    let outside = data.parent().unwrap().join("unselected.json");
    assert!(write_configuration_snapshot(
        &data,
        AgentId::ClaudeCode,
        Some(&profile),
        &outside,
        Some("{}")
    )
    .is_err());
    let mut changed = profile.clone();
    changed.directory = data
        .parent()
        .unwrap()
        .join("other-profile")
        .to_string_lossy()
        .into();
    std::fs::create_dir(&changed.directory).unwrap();
    assert!(inspect(&data, AgentId::ClaudeCode, Some(&changed)).is_err());
}

#[test]
fn ownership_record_is_included_in_batch_rollback_snapshot() {
    let (_temporary, data, profile) = fixture(AgentId::ClaudeCode);
    apply(&data, AgentId::ClaudeCode, &profile, "first");
    let snapshot = configuration_snapshots(&data, AgentId::ClaudeCode, Some(&profile)).unwrap();
    assert!(snapshot
        .iter()
        .any(|(path, _)| path == &record_path(&data, AgentId::ClaudeCode, false)));
    apply(&data, AgentId::ClaudeCode, &profile, "second");
    for (path, before) in snapshot {
        write_configuration_snapshot(
            &data,
            AgentId::ClaudeCode,
            Some(&profile),
            &path,
            before.as_deref(),
        )
        .unwrap();
    }
    assert_eq!(
        inspect(&data, AgentId::ClaudeCode, Some(&profile))
            .unwrap()
            .status,
        "healthy"
    );
}

#[test]
fn private_disconnect_removes_start_environment_and_rejects_launch() {
    let temporary = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
    let data = temporary.path();
    let agent = AgentId::ClaudeCode;
    let before =
        serde_json::to_string(&json!({"claude_code":{"providerId":"fixture","model":"chosen"}}))
            .unwrap();
    let selection_path = data.join("agent-selection.json");
    super::super::configure_with_selection(
        data,
        agent,
        "http://127.0.0.1:18762",
        "local-secret",
        "chosen",
        Some((&selection_path, &before, None)),
    )
    .unwrap();
    assert!(super::super::validate_launch(data, agent).is_ok());
    let report = inspect(data, agent, None).unwrap();
    assert!(report.files.iter().any(|file| file.slot == "environment"));
    disconnect(
        data,
        agent,
        None,
        report.preview_token.as_deref().unwrap(),
        &before,
        "{}",
    )
    .unwrap();
    assert!(!data
        .join("agents/claude_code/configuration/environment.json")
        .exists());
    assert!(super::super::validate_launch(data, agent).is_err());
    assert!(data.join("agents/claude_code/workspace").is_dir());
}

fn disconnect_journal(
    data: &Path,
    agent: AgentId,
    profile: &ExistingProfile,
) -> (DisconnectJournal, BTreeMap<String, PathBuf>) {
    let record = load(data, agent, false).unwrap().unwrap();
    let known = paths(data, agent, Some(profile)).unwrap();
    let files = record
        .files
        .iter()
        .map(|file| {
            let current = read_file(data, &known[&file.slot], &known, true).unwrap();
            let (restored, _, conflicts) =
                restore_file(file, &known[&file.slot], current.as_deref()).unwrap();
            assert_eq!(conflicts, 0);
            RestoreFile {
                slot: file.slot.clone(),
                current,
                restored,
            }
        })
        .collect();
    (
        DisconnectJournal {
            agent,
            selection_before: std::fs::read_to_string(data.join("agent-selection.json")).unwrap(),
            selection_after: "{}".into(),
            files,
        },
        known,
    )
}

#[test]
fn partially_restored_transaction_can_rollback_only_its_own_writes() {
    let (_temporary, data, profile) = fixture(AgentId::OhMyPi);
    apply(&data, AgentId::OhMyPi, &profile, "first");
    let (journal, known) = disconnect_journal(&data, AgentId::OhMyPi, &profile);
    assert!(journal.files.len() > 1);
    let first = &journal.files[0];
    write_file(
        &data,
        &known[&first.slot],
        &known,
        true,
        first.current.as_deref(),
        first.restored.as_deref(),
    )
    .unwrap();
    rollback_disconnect(&data, &journal, &known, true).unwrap();
    for file in &journal.files {
        assert_eq!(
            read_file(&data, &known[&file.slot], &known, true).unwrap(),
            file.current
        );
    }
    assert_eq!(
        inspect(&data, AgentId::OhMyPi, Some(&profile))
            .unwrap()
            .status,
        "healthy"
    );
}

#[test]
fn interrupted_disconnect_resumes_from_original_independent_selection() {
    let (_temporary, data, profile) = fixture(AgentId::OhMyPi);
    apply(&data, AgentId::OhMyPi, &profile, "first");
    let (journal, known) = disconnect_journal(&data, AgentId::OhMyPi, &profile);
    let first = &journal.files[0];
    write_file(
        &data,
        &known[&first.slot],
        &known,
        true,
        first.current.as_deref(),
        first.restored.as_deref(),
    )
    .unwrap();
    std::fs::write(
        data.join(DISCONNECT_JOURNAL),
        signed_disconnect(&data, &journal).unwrap(),
    )
    .unwrap();
    recover_disconnect(&data).unwrap();
    assert_eq!(
        std::fs::read_to_string(data.join("agent-selection.json")).unwrap(),
        "{}"
    );
    for file in &journal.files {
        assert_eq!(
            read_file(&data, &known[&file.slot], &known, true).unwrap(),
            file.restored
        );
    }
    assert!(!data.join(DISCONNECT_JOURNAL).exists());
}

#[test]
fn forged_restore_content_or_changed_selection_cannot_overwrite_native_file() {
    let (_temporary, data, profile) = fixture(AgentId::ClaudeCode);
    apply(&data, AgentId::ClaudeCode, &profile, "first");
    let (mut journal, known) = disconnect_journal(&data, AgentId::ClaudeCode, &profile);
    let before = std::fs::read_to_string(&known["config"]).unwrap();
    journal.files[0].restored = Some("{\"forged\":true}".into());
    std::fs::write(
        data.join(DISCONNECT_JOURNAL),
        signed_disconnect(&data, &journal).unwrap(),
    )
    .unwrap();
    assert!(recover_disconnect(&data).is_err());
    assert_eq!(std::fs::read_to_string(&known["config"]).unwrap(), before);
    let (journal, _) = disconnect_journal(&data, AgentId::ClaudeCode, &profile);
    std::fs::write(
        data.join(DISCONNECT_JOURNAL),
        signed_disconnect(&data, &journal).unwrap(),
    )
    .unwrap();
    std::fs::write(data.join("agent-selection.json"), "{\"external\":true}").unwrap();
    assert!(recover_disconnect(&data).is_err());
    assert_eq!(std::fs::read_to_string(&known["config"]).unwrap(), before);
}

#[test]
fn a_new_owned_array_row_with_manual_extra_fields_is_a_conflict() {
    let file = FileState {
        slot: "config".into(),
        before: Some("[]".into()),
        after: "[{\"id\":\"ae\"}]".into(),
    };
    let (_, _, conflicts) = restore_file(
        &file,
        Path::new("models.json"),
        Some("[{\"id\":\"ae\",\"manual\":true}]"),
    )
    .unwrap();
    assert_eq!(conflicts, 1);
}

#[test]
fn synchronous_second_file_failure_rolls_back_and_remains_recoverable() {
    let (_temporary, data, profile) = fixture(AgentId::OhMyPi);
    apply(&data, AgentId::OhMyPi, &profile, "first");
    let (journal, known) = disconnect_journal(&data, AgentId::OhMyPi, &profile);
    let report = inspect(&data, AgentId::OhMyPi, Some(&profile)).unwrap();
    FAIL_AFTER_FIRST_RESTORE.with(|value| value.set(true));
    let error = disconnect(
        &data,
        AgentId::OhMyPi,
        Some(&profile),
        report.preview_token.as_deref().unwrap(),
        &journal.selection_before,
        "{}",
    )
    .unwrap_err();
    assert_eq!(error.code, "fixture_write_failure");
    assert_eq!(
        std::fs::read_to_string(data.join("agent-selection.json")).unwrap(),
        journal.selection_before
    );
    for file in &journal.files {
        assert_eq!(
            read_file(&data, &known[&file.slot], &known, true).unwrap(),
            file.current
        );
    }
    assert!(!data.join(DISCONNECT_JOURNAL).exists());
    let report = inspect(&data, AgentId::OhMyPi, Some(&profile)).unwrap();
    disconnect(
        &data,
        AgentId::OhMyPi,
        Some(&profile),
        report.preview_token.as_deref().unwrap(),
        &journal.selection_before,
        "{}",
    )
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(data.join("agent-selection.json")).unwrap(),
        "{}"
    );
}

#[test]
fn restoring_removed_original_keys_while_removing_final_owned_key_keeps_valid_json() {
    let file = FileState {
        slot: "config".into(),
        before: Some("{\"original\":\"restore\"}".into()),
        after: "{\"owned\":true}".into(),
    };
    let current = "{\n // later user setting\n \"later\":42,\n \"owned\":true\n}";
    let (restored, _, conflicts) =
        restore_file(&file, Path::new("settings.json"), Some(current)).unwrap();
    assert_eq!(conflicts, 0);
    let restored = restored.unwrap();
    assert_eq!(
        document(Path::new("settings.json"), Some(&restored)).unwrap(),
        json!({"original":"restore","later":42})
    );
    assert!(restored.contains("// later user setting"));
}

fn tamper_payload(path: &Path, change: impl FnOnce(&mut Value)) {
    let text = std::fs::read_to_string(path).unwrap();
    let mut envelope: Value = serde_json::from_str(&text).unwrap();
    let mut payload: Value = serde_json::from_str(envelope["payload"].as_str().unwrap()).unwrap();
    change(&mut payload);
    envelope["payload"] = json!(serde_json::to_string(&payload).unwrap());
    std::fs::write(path, serde_json::to_string(&envelope).unwrap()).unwrap();
}

#[test]
fn tampered_baseline_and_pending_original_values_fail_authentication_without_native_writes() {
    let (_temporary, data, profile) = fixture(AgentId::ClaudeCode);
    apply(&data, AgentId::ClaudeCode, &profile, "first");
    let agent = AgentId::ClaudeCode;
    let known = paths(&data, agent, Some(&profile)).unwrap();
    let native_before = std::fs::read_to_string(&known["config"]).unwrap();
    let record = load(&data, agent, false).unwrap().unwrap();
    save(&data, &record, true).unwrap();
    tamper_payload(&record_path(&data, agent, true), |payload| {
        payload["files"][0]["before"] = json!("{\"forged\":true}")
    });
    assert!(finish(&data, agent).is_err());
    assert_eq!(
        std::fs::read_to_string(&known["config"]).unwrap(),
        native_before
    );
    assert_eq!(
        load(&data, agent, false).unwrap().unwrap().files[0].before,
        record.files[0].before
    );
    writer::write(&record_path(&data, agent, true), None).unwrap();
    tamper_payload(&record_path(&data, agent, false), |payload| {
        payload["files"][0]["before"] = json!("{\"forged\":true}")
    });
    assert!(inspect(&data, agent, Some(&profile)).is_err());
    assert_eq!(
        std::fs::read_to_string(&known["config"]).unwrap(),
        native_before
    );
}

#[test]
fn ownership_signature_binds_agent_and_pending_role_and_rejects_unsigned_records() {
    let (_temporary, data, profile) = fixture(AgentId::ClaudeCode);
    apply(&data, AgentId::ClaudeCode, &profile, "first");
    let baseline = std::fs::read_to_string(record_path(&data, AgentId::ClaudeCode, false)).unwrap();
    std::fs::write(record_path(&data, AgentId::ClaudeCode, true), &baseline).unwrap();
    assert!(finish(&data, AgentId::ClaudeCode).is_err());
    std::fs::write(record_path(&data, AgentId::Codex, false), &baseline).unwrap();
    assert!(load(&data, AgentId::Codex, false).is_err());
    let record = load(&data, AgentId::ClaudeCode, false).unwrap().unwrap();
    std::fs::write(
        record_path(&data, AgentId::ClaudeCode, false),
        serde_json::to_string(&record).unwrap(),
    )
    .unwrap();
    assert!(load(&data, AgentId::ClaudeCode, false).is_err());
}

#[test]
fn tampered_disconnect_journal_fails_before_any_recovery_write() {
    let (_temporary, data, profile) = fixture(AgentId::OhMyPi);
    apply(&data, AgentId::OhMyPi, &profile, "first");
    let (journal, known) = disconnect_journal(&data, AgentId::OhMyPi, &profile);
    std::fs::write(
        data.join(DISCONNECT_JOURNAL),
        signed_disconnect(&data, &journal).unwrap(),
    )
    .unwrap();
    tamper_payload(&data.join(DISCONNECT_JOURNAL), |payload| {
        payload["files"][0]["restored"] = json!("{\"forged\":true}")
    });
    assert!(recover_disconnect(&data).is_err());
    assert_eq!(
        std::fs::read_to_string(data.join("agent-selection.json")).unwrap(),
        journal.selection_before
    );
    for file in &journal.files {
        assert_eq!(
            read_file(&data, &known[&file.slot], &known, true).unwrap(),
            file.current
        );
    }
}
