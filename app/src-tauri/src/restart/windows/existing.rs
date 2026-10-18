//! Restart only one identified installation/profile. CLI processes exit under
//! their own control; this module never sends a console signal or replays a task.
use super::*;
use crate::agent_configs::{self, AgentId, ExistingProfile};
use crate::restart::{
    ExistingProcess, ExistingRestartContext, ExistingRestartInput, ExistingRuntime,
};

const PENDING_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const WAIT_INTERVAL: Duration = Duration::from_millis(250);
const REOPEN_TIMEOUT: Duration = Duration::from_secs(15);
type PendingKey = (PathBuf, &'static str, u64, String, u32, u64);

struct Pending {
    running: bool,
    message: String,
    requested_at: Instant,
}
fn pending() -> &'static Mutex<BTreeMap<PendingKey, Pending>> {
    static PENDING: OnceLock<Mutex<BTreeMap<PendingKey, Pending>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(BTreeMap::new()))
}

struct SelectedProcess {
    candidate: Candidate,
    surface: &'static str,
    reason: Option<String>,
}

fn same_path(left: &Path, right: &Path) -> bool {
    crate::discovery::same_directory(left, right)
}
fn environment_path(environment: &BTreeMap<String, String>, name: &str) -> Option<PathBuf> {
    environment
        .get(name)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}
fn selected_home(
    environment: &BTreeMap<String, String>,
    profile: &ExistingProfile,
) -> Option<PathBuf> {
    let home = environment_path(environment, "HOME")
        .or_else(|| environment_path(environment, "USERPROFILE"))?;
    same_path(&home, Path::new(&profile.home_directory)).then_some(home)
}

fn profile_matches(
    agent: AgentId,
    profile: &ExistingProfile,
    environment: &BTreeMap<String, String>,
) -> bool {
    let Some(home) = selected_home(environment, profile) else {
        return false;
    };
    if environment_path(environment, "USERPROFILE")
        .is_some_and(|user| !same_path(&user, Path::new(&profile.home_directory)))
    {
        return false;
    }
    for (name, selected) in [
        ("XDG_CONFIG_HOME", &profile.xdg_config_directory),
        ("XDG_DATA_HOME", &profile.xdg_data_directory),
        ("XDG_STATE_HOME", &profile.xdg_state_directory),
        ("XDG_CACHE_HOME", &profile.xdg_cache_directory),
    ] {
        if let Some(selected) = selected {
            if !environment_path(environment, name)
                .is_some_and(|actual| same_path(&actual, Path::new(selected)))
            {
                return false;
            }
        }
    }
    let directory = Path::new(&profile.directory);
    let expected_file = |name: &str| {
        profile
            .config_file
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| directory.join(name))
    };
    let actual = match agent {
        AgentId::Codex => {
            environment_path(environment, "CODEX_HOME").unwrap_or_else(|| home.join(".codex"))
        }
        AgentId::ClaudeCode => environment_path(environment, "CLAUDE_CONFIG_DIR")
            .unwrap_or_else(|| home.join(".claude")),
        AgentId::Hermes => environment_path(environment, "HERMES_HOME")
            .or_else(|| {
                environment_path(environment, "LOCALAPPDATA").map(|path| path.join("hermes"))
            })
            .unwrap_or_else(|| home.join(".hermes")),
        AgentId::OhMyPi => {
            let root = environment
                .get("PI_CONFIG_DIR")
                .map_or_else(|| home.join(".omp"), |name| home.join(name));
            if let Some(name) = environment
                .get("OMP_PROFILE")
                .or_else(|| environment.get("PI_PROFILE"))
            {
                if profile.profile_name.as_deref() != Some(name.as_str()) {
                    return false;
                }
                root.join("profiles").join(name).join("agent")
            } else {
                if profile.profile_name.is_some() {
                    return false;
                }
                environment_path(environment, "PI_CODING_AGENT_DIR")
                    .unwrap_or_else(|| root.join("agent"))
            }
        }
        AgentId::OpenCode => {
            if let Some(file) = environment_path(environment, "OPENCODE_CONFIG") {
                return same_path(&file, &expected_file("opencode.json"));
            }
            environment_path(environment, "OPENCODE_CONFIG_DIR").unwrap_or_else(|| {
                environment_path(environment, "XDG_CONFIG_HOME")
                    .unwrap_or_else(|| home.join(".config"))
                    .join("opencode")
            })
        }
        AgentId::Zcode => {
            let file = environment_path(environment, "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE")
                .unwrap_or_else(|| {
                    environment_path(environment, "ZCODE_DATA_BASE_DIR")
                        .unwrap_or(home)
                        .join(".zcode/v2/provider_config.json")
                });
            return same_path(&file, &expected_file("provider_config.json"));
        }
        AgentId::WorkBuddy => environment_path(environment, "WORKBUDDY_CONFIG_DIR")
            .or_else(|| environment_path(environment, "CODEBUDDY_CONFIG_DIR"))
            .unwrap_or_else(|| home.join(".workbuddy")),
        AgentId::DeepSeekHarness => return false,
    };
    same_path(&actual, directory)
}

fn entry_matches(image: &Path, parts: &[String], expected: &std::process::Command) -> bool {
    if !same_path(image, Path::new(expected.get_program())) {
        return false;
    }
    let arguments: Vec<_> = expected
        .get_args()
        .map(|value| value.to_string_lossy().into_owned())
        .collect();
    let script = arguments.iter().enumerate().find_map(|(index, value)| {
        value
            .eq_ignore_ascii_case("-File")
            .then(|| arguments.get(index + 1))
            .flatten()
    });
    if let Some(script) = script {
        let actual = parts.iter().enumerate().find_map(|(index, value)| {
            value
                .eq_ignore_ascii_case("-File")
                .then(|| parts.get(index + 1))
                .flatten()
        });
        return actual.is_some_and(|actual| same_path(Path::new(actual), Path::new(script)));
    }
    true
}

fn automation_arguments(parts: &[String]) -> bool {
    parts.iter().any(|part| {
        [
            "-p",
            "--print",
            "--query",
            "--oneshot",
            "--sdk-url",
            "--input-format",
            "--output-format",
            "--json",
            "--format",
            "exec",
            "run",
            "serve",
            "server",
            "acp",
            "mcp",
        ]
        .iter()
        .any(|flag| part == flag || part.starts_with(&format!("{flag}=")))
    })
}

fn arguments_supported(parts: &[String], expected: &std::process::Command, desktop: bool) -> bool {
    let prefix: Vec<_> = expected
        .get_args()
        .map(|part| part.to_string_lossy().into_owned())
        .collect();
    let Some(actual) = parts.get(1..) else {
        return false;
    };
    if actual.len() < prefix.len()
        || !actual
            .iter()
            .zip(&prefix)
            .all(|(actual, expected)| actual.eq_ignore_ascii_case(expected))
    {
        return false;
    }
    let remaining = &actual[prefix.len()..];
    let remaining: Vec<_> = remaining
        .iter()
        .filter(|part| !(desktop && part.as_str() == "--force-renderer-accessibility"))
        .cloned()
        .collect();
    let remaining = remaining.as_slice();
    if remaining.is_empty() {
        return true;
    }
    // An unparsed routing, permission, project, session or task argument makes
    // the profile ambiguous. Preserve only Electron's explicit data directory.
    desktop
        && (matches!(remaining,[flag,value] if flag=="--user-data-dir"&&Path::new(value).is_absolute())
            || matches!(remaining,[flag] if flag.strip_prefix("--user-data-dir=").is_some_and(|value|Path::new(value).is_absolute())))
}

fn validate_candidate(candidate: &Candidate) -> Result<()> {
    for name in ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"] {
        if !candidate.profile.contains_key(name) {
            return Err(AppError::new(
                "restart_profile",
                "无法确认原客户端用户环境，未关闭客户端",
            ));
        }
    }
    for name in PROFILE_DIRECTORY_VARIABLES {
        if let Some(path) = candidate.profile.get(*name) {
            agent_configs::validate_existing_runtime_directory(Path::new(path))?;
        }
    }
    agent_configs::validate_existing_runtime_directory(
        candidate
            .current_directory
            .as_deref()
            .ok_or_else(|| AppError::new("restart_profile", "无法确认原工作目录，未关闭客户端"))?,
    )?;
    if let Some(path) = &candidate.user_data {
        agent_configs::validate_existing_runtime_directory(path)?;
    }
    Ok(())
}

fn candidates(context: &ExistingRestartContext) -> Vec<SelectedProcess> {
    if context.agent_id == AgentId::DeepSeekHarness {
        return vec![];
    }
    let Ok(expected) =
        crate::agent_runner::existing_command(context.agent_id, &context.profile, &[], None)
    else {
        return vec![];
    };
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return vec![];
    }
    let snapshot = Handle(snapshot);
    let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    let mut found = unsafe { Process32FirstW(snapshot.0, &mut entry) } != 0;
    let mut selected = vec![];
    while found {
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
                0,
                entry.th32ProcessID,
            )
        };
        if !handle.is_null() {
            let handle = Handle(handle);
            if let (Some(image), Some(process), Some(start)) = (
                image_path(handle.0),
                crate::discovery::windows::process_context(handle.0),
                started(handle.0),
            ) {
                let parts = command_parts(&process.command);
                let renderer = parts.iter().any(|part| part.starts_with("--type="));
                if !renderer
                    && entry_matches(&image, &parts, &expected)
                    && profile_matches(context.agent_id, &context.profile, &process.env)
                {
                    let windows = windows(entry.th32ProcessID);
                    let automation = automation_arguments(&parts);
                    let surface = if automation {
                        "automation"
                    } else if !windows.is_empty() {
                        "desktop-gui"
                    } else {
                        "interactive-cli"
                    };
                    let mut profile = profile_environment(&process.env);
                    if let Some(path) = process.env.get("PATH") {
                        profile.insert("PATH".into(), path.clone());
                    }
                    let candidate = Candidate {
                        pid: entry.th32ProcessID,
                        started: start,
                        image,
                        directory: PathBuf::from(&context.profile.directory),
                        user_data: user_data(&process.command),
                        windows,
                        profile,
                        current_directory: process.current_directory,
                        cli_arguments: None,
                    };
                    let reason = if automation {
                        Some("此进程是自动化或无界面任务，请等待其自行结束；AE 不会重放任务".into())
                    } else if !arguments_supported(&parts, &expected, surface == "desktop-gui") {
                        Some("原进程包含无法确认的配置或会话参数，请从原入口正常退出后重新打开；AE 不会回放命令行".into())
                    } else if context.configuration_revision == 0 {
                        Some("请重新保存一次此 profile 配置以生成可校验的配置版本".into())
                    } else {
                        validate_candidate(&candidate)
                            .err()
                            .map(|error| error.message)
                    };
                    selected.push(SelectedProcess {
                        candidate,
                        surface,
                        reason,
                    });
                }
            }
        }
        found = unsafe { Process32NextW(snapshot.0, &mut entry) } != 0;
    }
    selected
}

fn same_selection(expected: &ExistingRestartContext) -> Result<()> {
    let current = crate::agent_hub::saved_restart_context(&expected.root, expected.agent_id)?;
    if current.configuration_revision != expected.configuration_revision
        || current.profile != expected.profile
    {
        return Err(AppError::new(
            "restart_configuration_changed",
            "配置或所选 profile 已改变，本次重启已取消",
        ));
    }
    Ok(())
}

pub(crate) fn runtime(context: &ExistingRestartContext) -> ExistingRuntime {
    let candidates = candidates(context);
    let processes: Vec<_> = candidates
        .iter()
        .map(|selected| ExistingProcess {
            process_id: selected.candidate.pid,
            start_time_ms: selected.candidate.started,
            image_path: selected.candidate.image.to_string_lossy().into(),
            workspace_directory: selected
                .candidate
                .current_directory
                .as_ref()
                .map(|path| path.to_string_lossy().into())
                .unwrap_or_default(),
            client_surface: selected.surface.into(),
            can_restart: selected.reason.is_none(),
            reason: selected.reason.clone(),
        })
        .collect();
    let (in_progress, message) = pending()
        .lock()
        .map(|mut pending| {
            // Completed state is retained only for the active profile's latest request.
            let identity = profile_identity(context);
            let relevant: Vec<_> = pending
                .iter()
                .filter(|(key, _)| {
                    key.0 == context.root
                        && key.1 == context.agent_id.as_str()
                        && key.2 == context.configuration_revision
                        && key.3 == identity
                })
                .collect();
            let progress = relevant.iter().any(|(_, value)| value.running);
            let message = relevant
                .iter()
                .max_by_key(|(_, value)| value.requested_at)
                .map(|(_, value)| value.message.clone());
            if pending.len() > 64 {
                pending.retain(|_, value| value.running);
            }
            (progress, message)
        })
        .unwrap_or((false, Some("重启状态暂时不可用".into())));
    ExistingRuntime {
        agent_id: context.agent_id,
        configuration_revision: context.configuration_revision,
        applied_at_ms: context.applied_at_ms,
        platform_supported: true,
        running: !processes.is_empty(),
        restart_required: context.applied_at_ms > 0
            && candidates
                .iter()
                .any(|selected| selected.candidate.started < context.applied_at_ms),
        can_restart: processes.iter().any(|process| process.can_restart) && !in_progress,
        restart_in_progress: in_progress,
        pending_message: message,
        reason: if context.agent_id == AgentId::DeepSeekHarness {
            Some("DeepSeek Harness headless 每次任务自行退出；请提供新任务后在原终端运行，AE 不重放任务".into())
        } else if processes.is_empty() {
            Some(
                "未找到能同时核实所选安装与原生 profile 的运行进程，请从原终端正常退出后重新打开"
                    .into(),
            )
        } else if processes.len() > 1 {
            Some("发现多个使用此 profile 的进程，请选择要重新打开的具体实例".into())
        } else {
            None
        },
        candidates: processes,
    }
}

fn open_identified(candidate: &Candidate) -> Result<Handle> {
    let handle = unsafe {
        OpenProcess(
            PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | PROCESS_SYNCHRONIZE,
            0,
            candidate.pid,
        )
    };
    if handle.is_null() {
        return Err(AppError::new(
            "restart_changed",
            "所选进程已退出或无法核实，请刷新状态",
        ));
    }
    let handle = Handle(handle);
    if started(handle.0) != Some(candidate.started)
        || image_path(handle.0).as_ref() != Some(&candidate.image)
    {
        return Err(AppError::new(
            "restart_changed",
            "PID 或启动时间已经改变，未关闭其它进程",
        ));
    }
    Ok(handle)
}

fn entry_fingerprint(context: &ExistingRestartContext) -> Result<Vec<u8>> {
    use sha2::Digest;
    agent_configs::validate_existing_profile(context.agent_id, &context.profile)?;
    let path = Path::new(&context.profile.executable_path);
    let mut input = std::fs::File::open(path).map_err(|error| AppError::io(path, error))?;
    let mut digest = sha2::Sha256::new();
    std::io::copy(&mut input, &mut digest).map_err(|error| AppError::io(path, error))?;
    Ok(digest.finalize().to_vec())
}

fn reopen(
    context: &ExistingRestartContext,
    previous: &Candidate,
    fingerprint: &[u8],
) -> Result<()> {
    same_selection(context)?;
    if entry_fingerprint(context)? != fingerprint {
        return Err(AppError::new(
            "restart_changed",
            "客户端安装入口已改变，本次重新打开已取消",
        ));
    }
    validate_candidate(previous)?;
    let workspace = previous
        .current_directory
        .as_deref()
        .ok_or_else(|| AppError::new("restart_profile", "原工作目录不可用"))?;
    let mut launch = crate::agent_runner::existing_command(
        context.agent_id,
        &context.profile,
        &[],
        Some(workspace),
    )?;
    if context.agent_id == AgentId::WorkBuddy {
        crate::workbuddy_default::prepare_launch(&context.profile, &mut launch);
    }
    preserve_profile(&mut launch, &previous.profile);
    if let Some(path) = previous.profile.get("PATH") {
        launch.env("PATH", path);
    }
    if let Some(path) = &previous.user_data {
        launch.arg(format!("--user-data-dir={}", path.display()));
    }
    launch.creation_flags(0x0000_0010);
    let mut child = launch.spawn().map_err(|_| {
        AppError::new(
            "restart_launch",
            "原进程已退出，但重新打开失败；配置与历史仍保留",
        )
    })?;
    let deadline = Instant::now() + REOPEN_TIMEOUT;
    while Instant::now() < deadline {
        for selected in candidates(context) {
            let current = &selected.candidate;
            if current.pid == child.id()
                && current.started != previous.started
                && same_path(&current.image, &previous.image)
                && current.profile == previous.profile
                && current.current_directory == previous.current_directory
                && (previous.windows.is_empty() || !current.windows.is_empty())
            {
                return Ok(());
            }
        }
        if child.try_wait().is_ok_and(|status| status.is_some()) {
            break;
        }
        std::thread::sleep(WAIT_INTERVAL);
    }
    Err(AppError::new("restart_launch","已请求打开，但尚未证明新的同 profile 进程运行；请检查原客户端。AE 不会把单实例 IPC 或瞬间退出当作重启成功"))
}

fn request_gui_exit(candidate: &Candidate, handle: &Handle) -> Result<()> {
    let mut session = 0;
    let mut session_key = [0u16; CCH_RM_SESSION_KEY as usize + 1];
    if unsafe { RmStartSession(&mut session, 0, session_key.as_mut_ptr()) } != 0 {
        return Err(AppError::new(
            "restart_close",
            "无法请求 Windows 正常退出所选客户端",
        ));
    }
    let session = RestartSession(session);
    let (mut creation, mut exit, mut kernel, mut user) =
        unsafe { (zeroed(), zeroed(), zeroed(), zeroed()) };
    if unsafe { GetProcessTimes(handle.0, &mut creation, &mut exit, &mut kernel, &mut user) } == 0 {
        return Err(AppError::new("restart_changed", "所选进程身份已改变"));
    }
    let process = RM_UNIQUE_PROCESS {
        dwProcessId: candidate.pid,
        ProcessStartTime: creation,
    };
    if unsafe {
        RmRegisterResources(
            session.0,
            0,
            std::ptr::null(),
            1,
            &process,
            0,
            std::ptr::null(),
        )
    } != 0
    {
        return Err(AppError::new(
            "restart_close",
            "无法注册所选精确进程，未请求退出",
        ));
    }
    let _ = unsafe { RmShutdown(session.0, 0, None) };
    if unsafe { WaitForSingleObject(handle.0, 1000) } != 0 {
        return Err(AppError::new(
            "restart_close",
            "客户端尚未正常退出，请先在客户端处理任务或确认窗口；AE 不会强行结束进程",
        ));
    }
    Ok(())
}

fn profile_identity(context: &ExistingRestartContext) -> String {
    serde_json::to_string(&context.profile).unwrap_or_default()
}
fn pending_key(context: &ExistingRestartContext, candidate: &Candidate) -> PendingKey {
    (
        context.root.clone(),
        context.agent_id.as_str(),
        context.configuration_revision,
        profile_identity(context),
        candidate.pid,
        candidate.started,
    )
}
fn set_pending(key: &PendingKey, running: bool, message: String) {
    if let Ok(mut pending) = pending().lock() {
        pending.insert(
            key.clone(),
            Pending {
                running,
                message,
                requested_at: Instant::now(),
            },
        );
    }
}

fn wait_for_exit(
    context: &ExistingRestartContext,
    candidate: &Candidate,
    fingerprint: &[u8],
    timeout: Duration,
) -> Result<()> {
    let handle = open_identified(candidate)?;
    let deadline = Instant::now() + timeout;
    loop {
        same_selection(context)?;
        validate_candidate(candidate)?;
        if unsafe { WaitForSingleObject(handle.0, WAIT_INTERVAL.as_millis() as u32) } == 0 {
            return reopen(context, candidate, fingerprint);
        }
        if Instant::now() >= deadline {
            return Err(AppError::new(
                "restart_timeout",
                "等待超过 30 分钟，本次重新打开已取消；原进程和历史保持不变",
            ));
        }
    }
}

pub(crate) fn restart(
    context: ExistingRestartContext,
    input: ExistingRestartInput,
) -> Result<RestartResult> {
    let _workbuddy_operation = if context.agent_id == AgentId::WorkBuddy {
        Some(crate::workbuddy_default::operation_guard().ok_or_else(|| {
            AppError::new(
                "restart_busy",
                "正在应用 WorkBuddy 默认模型，请稍后重试重启",
            )
        })?)
    } else {
        None
    };
    if context.agent_id == AgentId::DeepSeekHarness {
        return Err(AppError::new(
            "task_required",
            "DeepSeek Harness headless 不提供空任务重启；请提供新任务后从原终端运行",
        ));
    }
    same_selection(&context)?;
    let selected = candidates(&context)
        .into_iter()
        .find(|selected| {
            selected.candidate.pid == input.process_id
                && selected.candidate.started == input.start_time_ms
        })
        .ok_or_else(|| {
            AppError::new(
                "restart_changed",
                "所选 PID、启动时间、安装或 profile 无法同时确认，未关闭其它进程",
            )
        })?;
    if let Some(reason) = selected.reason {
        return Err(AppError::new("restart_unsupported", reason));
    }
    let candidate = selected.candidate;
    let handle = open_identified(&candidate)?;
    same_selection(&context)?;
    validate_candidate(&candidate)?;
    let fingerprint = entry_fingerprint(&context)?;
    let key = pending_key(&context, &candidate);
    let mut states = pending()
        .lock()
        .map_err(|_| AppError::new("restart_busy", "重启状态繁忙，请稍后重试"))?;
    if states.get(&key).is_some_and(|state| state.running) {
        return Ok(RestartResult {
            restarted: false,
            pending: true,
            message: "已在等待该进程正常退出；请在原终端退出客户端，AE 保持运行".into(),
        });
    }
    if states.values().filter(|state| state.running).count() >= 16 {
        return Err(AppError::new(
            "restart_busy",
            "已有多个等待任务，请先完成已有客户端的退出",
        ));
    }
    states.insert(key.clone(),Pending{running:true,message:if selected.surface=="desktop-gui"{"正在请求所选桌面客户端正常退出并重新打开".into()}else{"等待原客户端正常退出；请在原终端退出客户端并保持 AE 运行，最多等待 30 分钟。之后将在原 profile 与工作目录打开新会话，历史文件保留".into()},requested_at:Instant::now()});
    drop(states);
    if selected.surface == "desktop-gui" {
        let result = request_gui_exit(&candidate, &handle)
            .and_then(|()| reopen(&context, &candidate, &fingerprint));
        let message = match &result {
            Ok(()) => {
                "已正常退出并重新打开所选客户端，原 profile 与历史保留；活动会话恢复由客户端决定"
                    .into()
            }
            Err(error) => error.message.clone(),
        };
        set_pending(&key, false, message.clone());
        result?;
        return Ok(RestartResult {
            restarted: true,
            pending: false,
            message,
        });
    }
    let failed_key = key.clone();
    std::thread::Builder::new().name("ae-existing-client-reopen".into()).spawn(move||{
        match wait_for_exit(&context,&candidate,&fingerprint,PENDING_TIMEOUT){
            Ok(())=>set_pending(&key,false,"旧进程已正常退出，新进程已在原 profile 与工作目录打开；新会话保留原历史，不自动恢复旧会话".into()),
            Err(error)=>set_pending(&key,false,error.message),
        }
    }).map_err(|_|{set_pending(&failed_key,false,"无法创建等待任务".into());AppError::new("restart_busy","无法创建后台等待任务，原客户端未关闭")})?;
    Ok(RestartResult{restarted:false,pending:true,message:"已安排正常退出后重新打开。请在原终端退出客户端并保持 AE 运行；不会强行停止任务，会打开新会话并保留原历史".into()})
}

#[cfg(test)]
mod tests;
