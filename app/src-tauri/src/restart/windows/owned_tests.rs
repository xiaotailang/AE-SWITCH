//! Opt-in native OS fixtures. Ordinary regression runs never start windows.
use super::*;
use serde_json::{json, Value};
use std::{ffi::OsString, os::windows::fs::MetadataExt};

struct OwnedFixture {
    workspace: PathBuf,
    root: PathBuf,
    owner: String,
    environment: BTreeMap<String, Option<OsString>>,
    helper: Option<(u32, u64)>,
    removed: bool,
}
impl OwnedFixture {
    fn new() -> Self {
        let compiler_location = Command::new("rustc")
            .args(["--print", "sysroot"])
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(
            compiler_location.status.success(),
            "could not resolve the installed Rust compiler"
        );
        let compiler = PathBuf::from(String::from_utf8(compiler_location.stdout).unwrap().trim())
            .join("bin/rustc.exe");
        assert!(compiler.is_absolute() && compiler.is_file());
        let workspace =
            PathBuf::from(std::env::var_os("AE_WORKSPACE").expect("workspace-env required"));
        assert!(workspace.is_absolute() && workspace.to_string_lossy().starts_with("G:\\"));
        for ancestor in workspace.join(".cache").ancestors() {
            if ancestor.exists() {
                assert_eq!(
                    std::fs::symlink_metadata(ancestor)
                        .unwrap()
                        .file_attributes()
                        & 0x400,
                    0
                );
            }
        }
        let owner = uuid::Uuid::new_v4().simple().to_string();
        let root = workspace
            .join(".cache")
            .join(format!("restart-e2e-{owner}"));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("owner.txt"), &owner).unwrap();
        let mut fixture = Self {
            workspace,
            root,
            owner,
            environment: BTreeMap::new(),
            helper: None,
            removed: false,
        };
        for (name, relative) in [
            ("HOME", "home"),
            ("USERPROFILE", "home"),
            ("APPDATA", "home/AppData/Roaming"),
            ("LOCALAPPDATA", "home/AppData/Local"),
            ("TEMP", "tmp"),
            ("TMP", "tmp"),
            ("TMPDIR", "tmp"),
        ] {
            let path = fixture.root.join(relative);
            std::fs::create_dir_all(&path).unwrap();
            fixture.set(name, path);
        }
        fixture.set("AE_SWITCH_RESTART_FIXTURE_ROOT", fixture.root.clone());
        fixture.set("AE_SWITCH_RESTART_FIXTURE_OWNER", fixture.owner.clone());
        let source = fixture.root.join("fixture.rs");
        std::fs::write(&source, include_str!("owned_fixture.rs")).unwrap();
        for (name, desktop) in [("fixture.exe", false), ("fixture-desktop.exe", true)] {
            let mut compilation = Command::new(&compiler);
            compilation.args(["--edition=2021", "--crate-name", "ae_restart_fixture"]);
            if let Some(linker) = std::env::var_os("CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER") {
                let mut option = OsString::from("linker=");
                option.push(linker);
                compilation.arg("-C").arg(option);
            }
            if let Ok(flags) = std::env::var("CARGO_ENCODED_RUSTFLAGS") {
                compilation.args(flags.split('\u{1f}').filter(|flag| !flag.is_empty()));
            }
            if desktop {
                compilation.args(["--cfg", "fixture_desktop"]);
            }
            let output = compilation
                .arg(&source)
                .arg("-o")
                .arg(fixture.root.join(name))
                .current_dir(&fixture.root)
                .creation_flags(0x08000000)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "owned native fixture compilation failed: {}",
                String::from_utf8_lossy(&output.stderr)
                    .lines()
                    .filter(|line| line.starts_with("error:") || line.starts_with("error["))
                    .collect::<Vec<_>>()
                    .join("; ")
            );
        }
        fixture
    }
    fn set(&mut self, name: &str, value: impl AsRef<std::ffi::OsStr>) {
        self.environment
            .entry(name.into())
            .or_insert_with(|| std::env::var_os(name));
        std::env::set_var(name, value);
    }
    fn directory(&self, relative: &str) -> PathBuf {
        let directory = self.root.join(relative);
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }
    fn profile(&self, folder: &str) -> BTreeMap<String, PathBuf> {
        let mut profile: BTreeMap<String, PathBuf> = [
            ("HOME", "home"),
            ("USERPROFILE", "home"),
            ("APPDATA", "home/AppData/Roaming"),
            ("LOCALAPPDATA", "home/AppData/Local"),
            ("TEMP", "tmp"),
            ("TMP", "tmp"),
            ("TMPDIR", "tmp"),
            ("XDG_CONFIG_HOME", "config"),
            ("XDG_DATA_HOME", "data"),
            ("XDG_CACHE_HOME", "cache"),
            ("XDG_STATE_HOME", "state"),
            ("WEBVIEW2_USER_DATA_FOLDER", "webview"),
        ]
        .into_iter()
        .map(|(name, relative)| {
            (
                name.into(),
                self.directory(&format!("{folder}/profile/{relative}")),
            )
        })
        .collect();
        let home = profile["USERPROFILE"].to_string_lossy().replace('/', "\\");
        profile.insert("HOMEDRIVE".into(), PathBuf::from(&home[..2]));
        profile.insert("HOMEPATH".into(), PathBuf::from(&home[2..]));
        profile
    }
    fn executable(&self, name: &str, folder: &str, desktop: bool) -> PathBuf {
        let directory = self.directory(folder);
        if desktop {
            std::fs::create_dir(directory.join("resources")).unwrap();
            std::fs::write(
                directory.join("resources/app.asar"),
                b"owned-native-fixture",
            )
            .unwrap();
        }
        let executable = directory.join(name);
        std::fs::copy(
            self.root.join(if desktop {
                "fixture-desktop.exe"
            } else {
                "fixture.exe"
            }),
            &executable,
        )
        .unwrap();
        executable
    }
    fn receipt(&self, pid: u32) -> Value {
        wait_until(|| self.root.join(format!("{pid}-started.json")).is_file());
        let receipt: Value = serde_json::from_slice(
            &std::fs::read(self.root.join(format!("{pid}-started.json"))).unwrap(),
        )
        .unwrap();
        assert_eq!(receipt["owner"], self.owner);
        receipt
    }
    fn candidate(&self, target: Target, directory: &Path, pid: u32) -> Candidate {
        wait_until(|| {
            candidates(target, directory)
                .iter()
                .any(|candidate| candidate.pid == pid)
        });
        let candidate = candidates(target, directory)
            .into_iter()
            .find(|candidate| candidate.pid == pid)
            .unwrap();
        assert!(candidate.image.starts_with(&self.root));
        candidate
    }
    fn stop(&self, candidate: &Candidate) {
        assert_eq!(
            std::fs::read_to_string(self.root.join("owner.txt")).unwrap(),
            self.owner
        );
        assert!(candidate.image.starts_with(&self.root));
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                candidate.pid,
            )
        };
        if handle.is_null() {
            return;
        }
        let handle = Handle(handle);
        assert_eq!(started(handle.0), Some(candidate.started));
        assert_eq!(image_path(handle.0).as_ref(), Some(&candidate.image));
        std::fs::write(
            self.root.join(format!("{}.exit", candidate.pid)),
            &self.owner,
        )
        .unwrap();
        assert_eq!(
            unsafe { WaitForSingleObject(handle.0, 5000) },
            0,
            "owned fixture did not exit normally"
        );
    }
    fn cleanup(&self) {
        for entry in std::fs::read_dir(&self.root).unwrap().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(pid) = name
                .strip_suffix("-started.json")
                .and_then(|value| value.parse::<u32>().ok())
            else {
                continue;
            };
            let handle =
                unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_SYNCHRONIZE, 0, pid) };
            if handle.is_null() {
                continue;
            }
            let handle = Handle(handle);
            if image_path(handle.0).is_some_and(|image| image.starts_with(&self.root)) {
                std::fs::write(self.root.join(format!("{pid}.exit")), &self.owner).unwrap();
                assert_eq!(unsafe { WaitForSingleObject(handle.0, 5000) }, 0);
            }
        }
    }
    fn remove_owned_root(&mut self) {
        assert_eq!(
            std::fs::read_to_string(self.root.join("owner.txt")).unwrap(),
            self.owner
        );
        assert_eq!(
            self.root.file_name().unwrap().to_string_lossy(),
            format!("restart-e2e-{}", self.owner)
        );
        assert!(self
            .root
            .canonicalize()
            .unwrap()
            .starts_with(self.workspace.canonicalize().unwrap().join(".cache")));
        let mut remaining = vec![self.root.clone()];
        while let Some(path) = remaining.pop() {
            let metadata = std::fs::symlink_metadata(&path).unwrap();
            assert_eq!(
                metadata.file_attributes() & 0x400,
                0,
                "owned fixture contains a reparse point"
            );
            if metadata.is_dir() {
                remaining.extend(
                    std::fs::read_dir(&path)
                        .unwrap()
                        .map(|entry| entry.unwrap().path()),
                );
            }
        }
        std::fs::remove_dir_all(&self.root).unwrap();
        self.removed = true;
        assert!(!self.root.exists());
    }
}
impl Drop for OwnedFixture {
    fn drop(&mut self) {
        // Only the new UUID's fixture executables accept this normal-exit signal.
        // Every recursively removed entry belongs to this exact new G UUID.
        if !self.removed {
            let deadline = Instant::now() + Duration::from_secs(15);
            loop {
                self.cleanup();
                let waiting = self.helper.is_some_and(|key| {
                    helpers()
                        .lock()
                        .unwrap()
                        .get_mut(&key)
                        .is_some_and(|child| child.try_wait().unwrap().is_none())
                });
                if !waiting || Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            self.remove_owned_root();
        }
        for (name, original) in &self.environment {
            match original {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }
}
fn wait_until(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if condition() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(condition(), "owned native fixture timed out");
}

struct OwnedDirectoryReplacement {
    original: PathBuf,
    backup: PathBuf,
}
impl Drop for OwnedDirectoryReplacement {
    fn drop(&mut self) {
        // Remove only this exact junction, then return the original owned folder.
        std::fs::remove_dir(&self.original).unwrap();
        std::fs::rename(&self.backup, &self.original).unwrap();
    }
}

fn cli_wait_path_rechecks(fixture: &mut OwnedFixture, scopes: &mut Vec<Value>) {
    // Windows keeps the original cwd open for both clients, preventing replacement.
    for changed_scope in ["profile", "configuration"] {
        let folder = format!("cli-wait-recheck-{changed_scope}");
        let executable = fixture.executable("claude.exe", &folder, false);
        let configuration = fixture.directory(&format!("{folder}/configuration"));
        let working = fixture.directory(&format!("{folder}/project 中文"));
        let profile = fixture.profile(&folder);
        fixture.set("CLAUDE_CONFIG_DIR", &configuration);
        let resume = uuid::Uuid::new_v4().to_string();
        fixture.set("AE_SWITCH_RESTART_FIXTURE_RESUME", &resume);
        std::fs::write(configuration.join("restart-fixture-revision.txt"), b"after").unwrap();
        let mut old_child = Command::new(&executable)
            .args(["--resume", &resume])
            .envs(&profile)
            .current_dir(&working)
            .creation_flags(0x08000000)
            .spawn()
            .unwrap();
        fixture.receipt(old_child.id());
        let old = fixture.candidate(Target::ClaudeCli, &configuration, old_child.id());
        validate_restart_paths(&old).unwrap();
        let log = fixture.root.join(format!("{folder}-helper.log"));
        let stdout = std::fs::File::create(&log).unwrap();
        // Exercise the shipped script; only its final interactive pause is stubbed.
        let script = format!(
            "function Read-Host {{ param([string]$Prompt) }}\n{}",
            include_str!("../cli-restart.ps1")
        );
        let encoded = base64::engine::general_purpose::STANDARD.encode(
            script
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        );
        let shell = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let helper = Command::new(shell)
            .args(["-NoLogo", "-NoProfile", "-EncodedCommand", &encoded])
            .envs(&profile)
            .env("CLAUDE_CONFIG_DIR", &configuration)
            .env("UNI_SWITCH_CLI_PID", old.pid.to_string())
            .env("UNI_SWITCH_CLI_STARTED", old.started.to_string())
            .env("UNI_SWITCH_CLI_IMAGE", &old.image)
            .env("UNI_SWITCH_CLI_WORKING", &working)
            .env(
                "UNI_SWITCH_CLI_ARGUMENTS",
                serde_json::to_string(old.cli_arguments.as_ref().unwrap()).unwrap(),
            )
            .current_dir(&working)
            .stdin(std::process::Stdio::null())
            .stderr(stdout.try_clone().unwrap())
            .stdout(stdout)
            .creation_flags(0x08000000)
            .spawn()
            .unwrap();
        let key = (old.pid, old.started);
        helpers().lock().unwrap().insert(key, helper);
        fixture.helper = Some(key);
        wait_until(|| {
            std::fs::read_to_string(&log).is_ok_and(|text| text.contains("请回到原 Claude CLI"))
        });
        let changed = match changed_scope {
            "profile" => profile["XDG_CACHE_HOME"].clone(),
            "configuration" => configuration.clone(),
            _ => unreachable!("only mutable profile and configuration paths are tested"),
        };
        let backup = fixture.root.join(format!("{folder}-original"));
        let replacement = fixture.directory(&format!("{folder}-replacement"));
        std::fs::write(replacement.join("restart-fixture-revision.txt"), b"after").unwrap();
        assert!(changed.starts_with(&fixture.root) && backup.starts_with(&fixture.root));
        assert!(replacement.starts_with(&fixture.root));
        std::fs::rename(&changed, &backup).unwrap_or_else(|error| {
            panic!("could not replace owned {changed_scope} directory: {error}")
        });
        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", "New-Item -ItemType Junction -Path $env:AE_RESTART_LINK -Target $env:AE_RESTART_LINK_TARGET -ErrorAction Stop | Out-Null"])
            .env("AE_RESTART_LINK", &changed)
            .env("AE_RESTART_LINK_TARGET", &replacement)
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        if !output.status.success() {
            std::fs::rename(&backup, &changed).unwrap();
            panic!("owned G junction fixture could not be created");
        }
        let restore_directory = OwnedDirectoryReplacement {
            original: changed,
            backup,
        };
        fixture.stop(&old);
        assert!(old_child.wait().unwrap().success());
        wait_until(|| {
            helpers()
                .lock()
                .unwrap()
                .get_mut(&key)
                .unwrap()
                .try_wait()
                .unwrap()
                .is_some()
                || candidates(Target::ClaudeCli, &configuration)
                    .iter()
                    .any(|candidate| candidate.pid != old.pid)
        });
        let reopened: Vec<_> = candidates(Target::ClaudeCli, &configuration)
            .into_iter()
            .filter(|candidate| candidate.pid != old.pid)
            .collect();
        for candidate in &reopened {
            fixture.stop(candidate);
        }
        let mut helper = helpers().lock().unwrap().remove(&key).unwrap();
        helper.wait().unwrap();
        fixture.helper = None;
        drop(restore_directory);
        let text = std::fs::read_to_string(log).unwrap();
        assert!(
            reopened.is_empty(),
            "helper reopened after {changed_scope} became a junction"
        );
        assert!(
            text.contains("未再次启动客户端"),
            "helper did not report its path refusal"
        );
        scopes.push(json!({"target":"claude_cli","passed":true,"waitPathRecheck":changed_scope,"replacementWasOwnedGJunction":true,"shippedEmbeddedScript":true,"finalReadHostStubbed":true,"originalExitedNormally":true,"clientNotReopened":true,"externalProcessesStopped":0}));
    }
}

#[test]
#[ignore = "owned G native windows and CLI helper; run alone with --test-threads=1"]
fn owned_windows_restart_e2e() {
    let mut fixture = OwnedFixture::new();
    let mut scopes = Vec::new();
    for (target, name, folder, explicit_user_data) in [
        (Target::Codex, "Codex.exe", "codex", true),
        (Target::ClaudeDesktop, "Claude.exe", "claude-desktop", true),
        (Target::Codex, "Codex.exe", "codex-default-profile", false),
        (
            Target::ClaudeDesktop,
            "Claude.exe",
            "claude-default-profile",
            false,
        ),
    ] {
        let executable = fixture.executable(name, folder, true);
        let profile = fixture.profile(folder);
        let configuration = if target == Target::ClaudeDesktop && !explicit_user_data {
            let directory = profile["LOCALAPPDATA"].join("Claude");
            std::fs::create_dir_all(&directory).unwrap();
            directory
        } else {
            fixture.directory(&format!("{folder}/configuration"))
        };
        let user_data = if target == Target::ClaudeDesktop {
            configuration.clone()
        } else {
            fixture.directory(&format!("{folder}/user data 中文"))
        };
        if target == Target::Codex {
            fixture.set("CODEX_HOME", &configuration);
        }
        std::fs::write(configuration.join("claude_desktop_config.json"), b"{}").unwrap();
        std::fs::write(
            configuration.join("restart-fixture-revision.txt"),
            b"before",
        )
        .unwrap();
        let mut old_launch = Command::new(&executable);
        if explicit_user_data {
            old_launch.arg(format!("--user-data-dir={}", user_data.display()));
        }
        let mut old_child = old_launch
            .arg("--fixture-unused-option")
            .envs(&profile)
            .current_dir(&fixture.root)
            .creation_flags(0x08000000)
            .spawn()
            .unwrap();
        let old_receipt = fixture.receipt(old_child.id());
        let old = fixture.candidate(target, &configuration, old_child.id());
        assert!(!old.windows.is_empty());
        let mut duplicate_launch = Command::new(&executable);
        if explicit_user_data {
            duplicate_launch.arg(format!("--user-data-dir={}", user_data.display()));
        }
        let mut duplicate = duplicate_launch
            .envs(&profile)
            .current_dir(&fixture.root)
            .creation_flags(0x08000000)
            .spawn()
            .unwrap();
        fixture.receipt(duplicate.id());
        let duplicate_candidate = fixture.candidate(target, &configuration, duplicate.id());
        assert_eq!(
            restart_client(target, &configuration).unwrap_err().code,
            "restart_ambiguous"
        );
        assert!(old_child.try_wait().unwrap().is_none() && duplicate.try_wait().unwrap().is_none());
        fixture.stop(&duplicate_candidate);
        std::fs::write(configuration.join("restart-fixture-revision.txt"), b"after").unwrap();
        let result = restart_client(target, &configuration).unwrap();
        assert!(result.restarted && !result.pending);
        assert!(old_child.wait().unwrap().success());
        let new = candidates(target, &configuration)
            .into_iter()
            .find(|candidate| restarted_desktop(&old, candidate))
            .unwrap();
        let receipt = fixture.receipt(new.pid);
        assert_eq!(
            receipt["configDirectory"],
            configuration.to_string_lossy().as_ref()
        );
        if explicit_user_data {
            assert_eq!(receipt["userData"], user_data.to_string_lossy().as_ref());
        } else {
            assert!(receipt["userData"].is_null());
        }
        assert_ne!(
            old_receipt["profile"]["HOME"],
            fixture.root.join("home").to_string_lossy().as_ref()
        );
        assert_eq!(receipt["profile"], old_receipt["profile"], "restart must preserve the original client profile rather than inherit AE Switch's different profile");
        assert_eq!(receipt["revision"], "after");
        assert_eq!(receipt["ignoredArgumentPresent"], false);
        assert!(fixture
            .root
            .join(format!("{}-query-end-session.txt", old.pid))
            .is_file());
        assert!(fixture
            .root
            .join(format!("{}-end-session.txt", old.pid))
            .is_file());
        scopes.push(json!({"target":target,"passed":true,"fakeDesktop":true,"explicitUserData":explicit_user_data,"distinctHostAndClientProfiles":true,"sameProfileEnvironment":true,"nativeWindow":true,"actualRestartManagerShutdown":true,"oldProcessExited":true,"pidOrStartChanged":true,"sameImage":true,"sameConfiguration":true,"sameUserData":true,"newConfigurationRead":true,"arbitraryArgumentsReplayed":false,"ambiguousRefusedWithoutStopping":true}));
        fixture.stop(&new);
    }
    let executable = fixture.executable("Codex.exe", "unsafe-profile", true);
    let configuration = fixture.directory("unsafe-profile/configuration");
    let user_data = fixture.directory("unsafe-profile/user-data");
    let profile = fixture.profile("unsafe-profile");
    fixture.set("CODEX_HOME", &configuration);
    std::fs::write(
        configuration.join("restart-fixture-revision.txt"),
        b"unchanged",
    )
    .unwrap();
    for unsafe_profile in ["c-drive", "missing-temp"] {
        let mut launch = Command::new(&executable);
        launch
            .envs(&profile)
            .arg(format!("--user-data-dir={}", user_data.display()))
            .current_dir(&fixture.root)
            .creation_flags(0x08000000);
        if unsafe_profile == "c-drive" {
            // The fixture only records this synthetic value; it never uses it.
            launch.env("APPDATA", r"C:\AE-Switch-restart-refused");
        } else {
            launch.env_remove("TMP");
        }
        let mut child = launch.spawn().unwrap();
        fixture.receipt(child.id());
        let candidate = fixture.candidate(Target::Codex, &configuration, child.id());
        let runtime = client_runtime(Target::Codex, &configuration, u64::MAX);
        assert!(runtime.running && !runtime.can_restart);
        assert_eq!(
            restart_client(Target::Codex, &configuration)
                .unwrap_err()
                .code,
            "restart_profile"
        );
        assert!(
            child.try_wait().unwrap().is_none(),
            "unsafe profile refusal must leave the exact old process running"
        );
        assert!(!fixture
            .root
            .join(format!("{}-query-end-session.txt", child.id()))
            .exists());
        fixture.stop(&candidate);
        scopes.push(json!({"target":"codex","passed":true,"unsafeProfile":unsafe_profile,"syntheticProfileNotUsed":true,"refusedBeforeShutdown":true,"oldProcessPreserved":true,"externalProcessesStopped":0}));
    }
    let executable = fixture.executable("claude.exe", "claude-cli", false);
    let configuration = fixture.directory("claude-cli/configuration");
    let working = fixture.directory("claude-cli/project 中文");
    let profile = fixture.profile("claude-cli");
    fixture.set("CLAUDE_CONFIG_DIR", &configuration);
    let resume = uuid::Uuid::new_v4().to_string();
    fixture.set("AE_SWITCH_RESTART_FIXTURE_RESUME", &resume);
    for name in [
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_MODEL",
    ] {
        fixture.set(name, "owned-synthetic-override");
    }
    std::fs::write(
        configuration.join("restart-fixture-revision.txt"),
        b"before",
    )
    .unwrap();
    let mut old_child = Command::new(&executable)
        .args(["--resume", &resume, "--fixture-unused-option"])
        .envs(&profile)
        .current_dir(&working)
        .creation_flags(0x08000000)
        .spawn()
        .unwrap();
    let old_receipt = fixture.receipt(old_child.id());
    let old = fixture.candidate(Target::ClaudeCli, &configuration, old_child.id());
    std::fs::write(configuration.join("restart-fixture-revision.txt"), b"after").unwrap();
    let result = restart_client(Target::ClaudeCli, &configuration).unwrap();
    assert!(!result.restarted && result.pending && old_child.try_wait().unwrap().is_none());
    let helper_pid = helpers()
        .lock()
        .unwrap()
        .get(&(old.pid, old.started))
        .unwrap()
        .id();
    fixture.helper = Some((old.pid, old.started));
    let repeated = restart_client(Target::ClaudeCli, &configuration).unwrap();
    assert!(!repeated.restarted && repeated.pending);
    assert_eq!(
        helpers()
            .lock()
            .unwrap()
            .get(&(old.pid, old.started))
            .unwrap()
            .id(),
        helper_pid
    );
    std::thread::sleep(Duration::from_millis(1000));
    assert!(old_child.try_wait().unwrap().is_none());
    assert_eq!(candidates(Target::ClaudeCli, &configuration).len(), 1);
    assert!(helpers()
        .lock()
        .unwrap()
        .get_mut(&(old.pid, old.started))
        .unwrap()
        .try_wait()
        .unwrap()
        .is_none());
    fixture.stop(&old);
    wait_until(|| {
        candidates(Target::ClaudeCli, &configuration)
            .iter()
            .any(|candidate| candidate.pid != old.pid)
    });
    let new = candidates(Target::ClaudeCli, &configuration)
        .into_iter()
        .find(|candidate| candidate.pid != old.pid)
        .unwrap();
    let receipt = fixture.receipt(new.pid);
    assert_eq!(new.image, old.image);
    assert!(crate::discovery::same_directory(
        Path::new(receipt["workingDirectory"].as_str().unwrap()),
        &working,
    ));
    assert_eq!(receipt["revision"], "after");
    assert_eq!(receipt["resumeMatched"], true);
    assert_eq!(receipt["ignoredArgumentPresent"], false);
    assert_eq!(receipt["providerEnvironmentCleared"], true);
    assert_eq!(
        receipt["profile"], old_receipt["profile"],
        "CLI helper must preserve the original G profile"
    );
    fixture.stop(&new);
    wait_until(|| {
        helpers()
            .lock()
            .unwrap()
            .get_mut(&(old.pid, old.started))
            .unwrap()
            .try_wait()
            .unwrap()
            .is_some()
    });
    assert!(helpers()
        .lock()
        .unwrap()
        .remove(&(old.pid, old.started))
        .unwrap()
        .wait()
        .unwrap()
        .success());
    fixture.helper = None;
    scopes.push(json!({"target":"claude_cli","passed":true,"fakeCli":true,"distinctHostAndClientProfiles":true,"sameProfileEnvironment":true,"actualPowerShellHelper":true,"pendingUntilOwnedExit":true,"pendingObservationMs":1000,"helperDeduplicated":true,"sameImage":true,"sameWorkingDirectory":true,"validResumePreserved":true,"continueModeExercised":false,"newConfigurationRead":true,"providerEnvironmentCleared":true,"arbitraryArgumentsReplayed":false,"sharedTerminalStopped":false}));
    cli_wait_path_rechecks(&mut fixture, &mut scopes);
    fixture.cleanup();
    fixture.remove_owned_root();
    let report = fixture
        .workspace
        .join("artifacts/acceptance")
        .join(format!("owned-windows-restart-e2e-{}.json", fixture.owner));
    std::fs::write(&report, serde_json::to_vec_pretty(&json!({"owner":fixture.owner,"passed":true,"validationScope":"owned-g-native-fixtures-distinct-profiles","fakeClients":true,"actualVendorClientsVerified":false,"allEightAgentSessionsRestarted":false,"ipcRevisionGuardExercised":false,"ownedProcessesExited":true,"cleanup":{"succeeded":true,"removed":true,"externalProcessesStopped":0},"scopes":scopes})).unwrap()).unwrap();
    println!("Owned restart fixture receipt: {}", report.display());
}
