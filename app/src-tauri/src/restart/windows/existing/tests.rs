use super::*;
use std::fs;

// These owned PowerShell fixtures prove lifecycle and refusal boundaries.
// They are not official client or activity/session restoration acceptance.
struct Fixture {
    _owner: tempfile::TempDir,
    context: ExistingRestartContext,
    child: Option<Child>,
}

impl Fixture {
    fn new() -> Self {
        let owner = tempfile::tempdir().unwrap();
        assert!(!owner
            .path()
            .to_string_lossy()
            .to_ascii_lowercase()
            .starts_with("c:"));
        let root = owner.path();
        for name in [
            "ae",
            "native",
            "home",
            "workspace",
            "appdata",
            "localappdata",
            "tmp",
        ] {
            fs::create_dir(root.join(name)).unwrap();
        }
        let entry = root.join("owned-entry.ps1");
        fs::write(&entry, r#"$ErrorActionPreference='Stop'
$counter=Join-Path $PSScriptRoot 'counter.txt'
$count=if(Test-Path -LiteralPath $counter){[int](Get-Content -LiteralPath $counter)}else{0}
[IO.File]::WriteAllText($counter,($count+1).ToString())
$exitFile=Join-Path $PSScriptRoot $(if($count -eq 0){'exit-old'}else{'stop'})
while(-not (Test-Path -LiteralPath $exitFile) -and -not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'stop'))){Start-Sleep -Milliseconds 50}
"#).unwrap();
        let profile = ExistingProfile {
            directory: root.join("native").to_string_lossy().into(),
            home_directory: root.join("home").to_string_lossy().into(),
            executable_path: entry.to_string_lossy().into(),
            workspace_directory: root.join("workspace").to_string_lossy().into(),
            ..Default::default()
        };
        fs::write(root.join("home/history.jsonl"), "original history\r\n").unwrap();
        let context = ExistingRestartContext {
            root: root.join("ae"),
            agent_id: AgentId::Codex,
            profile,
            configuration_revision: 7,
            applied_at_ms: 1,
        };
        let fixture = Self {
            _owner: owner,
            context,
            child: None,
        };
        fixture.save_selection(7);
        fixture
    }

    fn save_selection(&self, revision: u64) {
        fs::write(self.context.root.join("agent-selection.json"), serde_json::to_vec(&serde_json::json!({
            "codex": { "providerId": "owned-synthetic", "model": "fixture-model", "profile": self.context.profile,
                "configurationRevision": revision, "appliedAtMs": 1 }
        })).unwrap()).unwrap();
    }

    fn start(&mut self) -> ExistingRestartInput {
        let mut command =
            crate::agent_runner::existing_command(AgentId::Codex, &self.context.profile, &[], None)
                .unwrap();
        let base = self._owner.path();
        for (name, directory) in [
            ("APPDATA", "appdata"),
            ("LOCALAPPDATA", "localappdata"),
            ("TEMP", "tmp"),
            ("TMP", "tmp"),
        ] {
            command.env(name, base.join(directory));
        }
        command.env("HOMEDRIVE", "G:").env(
            "HOMEPATH",
            self.context
                .profile
                .home_directory
                .strip_prefix("G:")
                .unwrap_or(&self.context.profile.home_directory),
        );
        for name in [
            "XDG_CONFIG_HOME",
            "XDG_DATA_HOME",
            "XDG_STATE_HOME",
            "XDG_CACHE_HOME",
            "TMPDIR",
            "WEBVIEW2_USER_DATA_FOLDER",
        ] {
            command.env_remove(name);
        }
        command.creation_flags(0x0800_0000);
        self.child = Some(command.spawn().unwrap());
        let pid = self.child.as_ref().unwrap().id();
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Some(candidate) = runtime(&self.context)
                .candidates
                .iter()
                .find(|candidate| candidate.process_id == pid)
                .filter(|_| {
                    fs::read_to_string(base.join("counter.txt")).is_ok_and(|count| count == "1")
                })
            {
                assert!(candidate.can_restart, "{:?}", candidate.reason);
                return ExistingRestartInput {
                    agent_id: AgentId::Codex,
                    configuration_revision: 7,
                    process_id: pid,
                    start_time_ms: candidate.start_time_ms,
                };
            }
            assert!(
                Instant::now() < deadline,
                "owned process metadata was not identified"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    fn wait_completed(&self) -> ExistingRuntime {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let current = runtime(&self.context);
            if !current.restart_in_progress {
                return current;
            }
            assert!(
                Instant::now() < deadline,
                "owned pending operation did not complete"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let running = candidates(&self.context);
        fs::write(self._owner.path().join("stop"), "owned cleanup").unwrap();
        for selected in running {
            if let Ok(handle) = open_identified(&selected.candidate) {
                assert_eq!(
                    unsafe { WaitForSingleObject(handle.0, 15_000) },
                    0,
                    "owned fixture did not exit normally"
                );
            }
        }
        if let Some(child) = &mut self.child {
            child.wait().unwrap();
        }
        pending()
            .lock()
            .unwrap()
            .retain(|key, _| key.0 != self.context.root);
    }
}

#[test]
fn existing_restart_all_client_selectors_require_selected_home_and_native_profile() {
    let fixture = Fixture::new();
    let profile = &fixture.context.profile;
    for (agent, selector, file) in [
        (AgentId::Codex, "CODEX_HOME", None),
        (AgentId::ClaudeCode, "CLAUDE_CONFIG_DIR", None),
        (AgentId::Hermes, "HERMES_HOME", None),
        (AgentId::OhMyPi, "PI_CODING_AGENT_DIR", None),
        (AgentId::OpenCode, "OPENCODE_CONFIG", Some("opencode.json")),
        (
            AgentId::Zcode,
            "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
            Some("provider_config.json"),
        ),
        (AgentId::WorkBuddy, "WORKBUDDY_CONFIG_DIR", None),
    ] {
        let mut environment = BTreeMap::from([
            ("HOME".into(), profile.home_directory.clone()),
            ("USERPROFILE".into(), profile.home_directory.clone()),
            (
                selector.into(),
                file.map_or_else(
                    || profile.directory.clone(),
                    |file| {
                        Path::new(&profile.directory)
                            .join(file)
                            .to_string_lossy()
                            .into()
                    },
                ),
            ),
        ]);
        assert!(
            profile_matches(agent, profile, &environment),
            "{}",
            agent.as_str()
        );
        environment.insert("USERPROFILE".into(), profile.workspace_directory.clone());
        assert!(!profile_matches(agent, profile, &environment));
    }
    let mut context = fixture.context.clone();
    context.agent_id = AgentId::DeepSeekHarness;
    assert!(!runtime(&context).can_restart);
    let input = ExistingRestartInput {
        agent_id: context.agent_id,
        configuration_revision: context.configuration_revision,
        process_id: 1,
        start_time_ms: 1,
    };
    assert_eq!(
        crate::restart::restart_existing(context, input)
            .unwrap_err()
            .code,
        "task_required"
    );
}

#[test]
fn existing_restart_arguments_refuse_unparsed_routes_sessions_and_automation() {
    let mut command = Command::new("G:/vendor/client.exe");
    command.arg("--known-prefix");
    let plain = vec!["client.exe".into(), "--known-prefix".into()];
    assert!(arguments_supported(&plain, &command, false));
    for arguments in [
        vec!["--model", "other"],
        vec!["--config", "other"],
        vec!["--continue"],
        vec!["--api-key", "synthetic"],
    ] {
        let mut parts = plain.clone();
        parts.extend(arguments.into_iter().map(String::from));
        assert!(!arguments_supported(&parts, &command, false));
    }
    let mut desktop = plain.clone();
    desktop.push("--user-data-dir=G:/native/data".into());
    assert!(arguments_supported(&desktop, &command, true));
    assert!(!arguments_supported(&desktop, &command, false));
    assert!(automation_arguments(&["client.exe".into(), "exec".into()]));
    assert!(automation_arguments(&[
        "client.exe".into(),
        "--print=x".into()
    ]));
}

#[test]
fn existing_restart_accessibility_argument_is_exact_and_desktop_only() {
    let command = Command::new("G:/vendor/WorkBuddy.exe");
    let accessibility = vec![
        "WorkBuddy.exe".into(),
        "--force-renderer-accessibility".into(),
    ];
    assert!(arguments_supported(&accessibility, &command, true));
    assert!(!arguments_supported(&accessibility, &command, false));

    for flag in [
        "--force-renderer-accessibility=1",
        "--force-renderer-accessibility=complete",
        "--Force-renderer-accessibility",
        "--force-renderer-accessibilit",
    ] {
        let parts = vec!["WorkBuddy.exe".into(), flag.into()];
        assert!(!arguments_supported(&parts, &command, true), "{flag}");
    }

    let mut with_profile = accessibility.clone();
    with_profile.extend(["--user-data-dir".into(), "G:/native/data".into()]);
    assert!(arguments_supported(&with_profile, &command, true));
    assert!(!arguments_supported(&with_profile, &command, false));
    with_profile.push("--continue".into());
    assert!(!arguments_supported(&with_profile, &command, true));
}

#[test]
fn existing_restart_preserves_workbuddy_user_data_override_and_its_absence() {
    let source = BTreeMap::from([(
        "workbuddy_user_data_dir".into(),
        "G:/native/workbuddy-account".into(),
    )]);
    let profile = profile_environment(&source);
    assert_eq!(profile.len(), 1);
    assert_eq!(
        profile["WORKBUDDY_USER_DATA_DIR"],
        "G:/native/workbuddy-account"
    );
    let key = std::ffi::OsStr::new("WORKBUDDY_USER_DATA_DIR");

    let mut launch = Command::new("WorkBuddy.exe");
    launch.env(key, "G:/unrelated/inherited-data");
    preserve_profile(&mut launch, &profile);
    let values: BTreeMap<_, _> = launch.get_envs().collect();
    assert_eq!(
        values[key],
        Some(std::ffi::OsStr::new("G:/native/workbuddy-account"))
    );

    let mut without_override = Command::new("WorkBuddy.exe");
    without_override.env(key, "G:/unrelated/inherited-data");
    preserve_profile(&mut without_override, &BTreeMap::new());
    let values: BTreeMap<_, _> = without_override.get_envs().collect();
    assert_eq!(values[key], None);
}

#[test]
fn existing_restart_profile_identity_and_pending_do_not_cross_revisions_or_profiles() {
    let fixture = Fixture::new();
    let context = &fixture.context;
    let key = (
        context.root.clone(),
        context.agent_id.as_str(),
        context.configuration_revision,
        profile_identity(context),
        777,
        1,
    );
    set_pending(&key, true, "owned pending".into());
    assert!(runtime(context).restart_in_progress);
    let mut changed = context.clone();
    changed.configuration_revision += 1;
    assert!(!runtime(&changed).restart_in_progress);
    assert!(runtime(&changed).pending_message.is_none());
    changed = context.clone();
    changed.profile.workspace_directory =
        fixture._owner.path().join("home").to_string_lossy().into();
    assert!(!runtime(&changed).restart_in_progress);
    assert!(runtime(&changed).pending_message.is_none());
}

#[test]
fn existing_restart_waits_for_normal_exit_and_reopens_same_owned_profile_without_history_changes() {
    let mut fixture = Fixture::new();
    let input = fixture.start();
    let mut wrong = input.clone();
    wrong.start_time_ms += 1;
    assert_eq!(
        crate::restart::restart_existing(fixture.context.clone(), wrong)
            .unwrap_err()
            .code,
        "restart_changed"
    );
    let mut wrong = input.clone();
    wrong.configuration_revision -= 1;
    assert_eq!(
        crate::restart::restart_existing(fixture.context.clone(), wrong)
            .unwrap_err()
            .code,
        "restart_configuration_changed"
    );
    let requested =
        crate::restart::restart_existing(fixture.context.clone(), input.clone()).unwrap();
    assert!(requested.pending && !requested.restarted);
    assert!(fixture
        .child
        .as_mut()
        .unwrap()
        .try_wait()
        .unwrap()
        .is_none());
    assert_eq!(
        fs::read_to_string(fixture._owner.path().join("counter.txt")).unwrap(),
        "1"
    );
    let duplicate = crate::restart::restart_existing(fixture.context.clone(), input).unwrap();
    assert!(duplicate.pending && !duplicate.restarted);
    fs::write(fixture._owner.path().join("exit-old"), "normal exit").unwrap();
    let completed = fixture.wait_completed();
    assert!(completed.pending_message.unwrap().contains("新进程"));
    assert!(completed
        .candidates
        .iter()
        .any(|candidate| candidate.can_restart));
    assert_eq!(
        fs::read_to_string(fixture._owner.path().join("counter.txt")).unwrap(),
        "2"
    );
    assert_eq!(
        fs::read_to_string(fixture._owner.path().join("home/history.jsonl")).unwrap(),
        "original history\r\n"
    );
}

#[test]
fn existing_restart_configuration_change_cancels_pending_without_stopping_original_process() {
    let mut fixture = Fixture::new();
    let input = fixture.start();
    crate::restart::restart_existing(fixture.context.clone(), input).unwrap();
    fixture.save_selection(8);
    let completed = fixture.wait_completed();
    assert!(completed.pending_message.unwrap().contains("已改变"));
    assert!(fixture
        .child
        .as_mut()
        .unwrap()
        .try_wait()
        .unwrap()
        .is_none());
    assert_eq!(
        fs::read_to_string(fixture._owner.path().join("counter.txt")).unwrap(),
        "1"
    );
}

#[test]
fn existing_restart_changed_installation_entry_cancels_reopen_after_normal_exit() {
    let mut fixture = Fixture::new();
    let input = fixture.start();
    crate::restart::restart_existing(fixture.context.clone(), input).unwrap();
    fs::write(
        &fixture.context.profile.executable_path,
        "# changed fixture entry; never executed",
    )
    .unwrap();
    fs::write(fixture._owner.path().join("exit-old"), "normal exit").unwrap();
    let completed = fixture.wait_completed();
    assert!(completed
        .pending_message
        .unwrap()
        .contains("安装入口已改变"));
    assert_eq!(
        fs::read_to_string(fixture._owner.path().join("counter.txt")).unwrap(),
        "1"
    );
}
