use super::*;
use base64::Engine;
use std::{
    collections::BTreeMap,
    ffi::c_void,
    mem::{size_of, zeroed},
    os::windows::process::CommandExt,
    path::PathBuf,
    process::{Child, Command},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, HWND, INVALID_HANDLE_VALUE},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
        RestartManager::{
            RmEndSession, RmRegisterResources, RmShutdown, RmStartSession, CCH_RM_SESSION_KEY,
            RM_UNIQUE_PROCESS,
        },
        Threading::{
            GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, WaitForSingleObject,
            PROCESS_QUERY_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_VM_READ,
        },
    },
    UI::WindowsAndMessaging::{EnumWindows, GetClassNameW, GetWindowThreadProcessId},
};

pub(super) mod existing;

struct Handle(HANDLE);
struct RestartSession(u32);
impl Drop for RestartSession {
    fn drop(&mut self) {
        unsafe {
            RmEndSession(self.0);
        }
    }
}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
struct Candidate {
    pid: u32,
    started: u64,
    image: PathBuf,
    directory: PathBuf,
    user_data: Option<PathBuf>,
    windows: Vec<isize>,
    profile: BTreeMap<String, String>,
    current_directory: Option<PathBuf>,
    cli_arguments: Option<Vec<String>>,
}
const PROFILE_DIRECTORY_VARIABLES: &[&str] = &[
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "WEBVIEW2_USER_DATA_FOLDER",
    "WORKBUDDY_USER_DATA_DIR",
];
const PROFILE_DRIVE_VARIABLES: &[&str] = &["HOMEDRIVE", "HOMEPATH"];
fn profile_environment(environment: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    PROFILE_DIRECTORY_VARIABLES
        .iter()
        .chain(PROFILE_DRIVE_VARIABLES)
        .filter_map(|name| {
            environment
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| ((*name).into(), value.clone()))
        })
        .collect()
}
fn profile_error() -> AppError {
    AppError::new(
        "restart_profile",
        "无法确认原客户端的用户数据与工作目录，未关闭客户端。请在原环境中自行退出并重新打开；新配置已保存。",
    )
}
fn validate_profile_directory(path: &Path) -> Result<()> {
    crate::portable::validate_root(path).map_err(|_| profile_error())?;
    if !path.is_dir() {
        return Err(profile_error());
    }
    Ok(())
}
fn validate_profile_environment(profile: &BTreeMap<String, String>) -> Result<()> {
    // Missing required Windows profile paths can fall back to the real account.
    for name in ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"] {
        if !profile.contains_key(name) {
            return Err(profile_error());
        }
    }
    for name in PROFILE_DIRECTORY_VARIABLES {
        if let Some(value) = profile.get(*name) {
            validate_profile_directory(Path::new(value))?;
        }
    }
    match (profile.get("HOMEDRIVE"), profile.get("HOMEPATH")) {
        (None, None) => {}
        (Some(drive), Some(path))
            if drive.len() == 2
                && drive.as_bytes()[0].is_ascii_alphabetic()
                && drive.ends_with(':')
                && path.starts_with('\\')
                && !path.starts_with("\\\\") =>
        {
            validate_profile_directory(Path::new(&format!("{drive}{path}")))?;
        }
        _ => return Err(profile_error()),
    }
    Ok(())
}
fn validate_restart_paths(candidate: &Candidate) -> Result<()> {
    validate_profile_environment(&candidate.profile)?;
    validate_profile_directory(&candidate.directory)?;
    if let Some(directory) = &candidate.user_data {
        validate_profile_directory(directory)?;
    }
    validate_profile_directory(
        candidate
            .current_directory
            .as_deref()
            .ok_or_else(profile_error)?,
    )
}
fn preserve_profile(command: &mut Command, profile: &BTreeMap<String, String>) {
    // Do not inherit AE Switch's private profile into an existing client.
    // Restore absence too, and never copy arbitrary provider credentials.
    for name in PROFILE_DIRECTORY_VARIABLES
        .iter()
        .chain(PROFILE_DRIVE_VARIABLES)
    {
        match profile.get(*name) {
            Some(value) => {
                command.env(name, value);
            }
            None => {
                command.env_remove(name);
            }
        }
    }
}
fn client_name(target: Target) -> &'static str {
    match target {
        Target::Codex => "Codex",
        Target::ClaudeDesktop => "Claude Code 桌面端",
        Target::ClaudeCli => "Claude CLI",
    }
}
fn started(handle: HANDLE) -> Option<u64> {
    let (mut creation, mut exit, mut kernel, mut user) =
        unsafe { (zeroed(), zeroed(), zeroed(), zeroed()) };
    if unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) } == 0 {
        return None;
    }
    Some(
        (((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64)
            .saturating_sub(116_444_736_000_000_000)
            / 10_000,
    )
}
fn image_path(handle: HANDLE) -> Option<PathBuf> {
    let mut path = vec![0u16; 32768];
    let mut len = path.len() as u32;
    (unsafe { QueryFullProcessImageNameW(handle, 0, path.as_mut_ptr(), &mut len) } != 0)
        .then(|| PathBuf::from(String::from_utf16_lossy(&path[..len as usize])))
}
fn desktop_image(image: &Path, target: Target) -> bool {
    let text = image.to_string_lossy().replace('/', "\\").to_lowercase();
    let file = image
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("")
        .to_lowercase();
    if target == Target::ClaudeDesktop {
        return file == "claude.exe"
            && (text.contains("\\windowsapps\\claude_")
                || text.contains("\\windowsapps\\anthropic.claude_")
                || image
                    .parent()
                    .is_some_and(|p| p.join("resources/app.asar").is_file()));
    }
    if target != Target::Codex {
        return false;
    }
    if text.contains("\\windowsapps\\openai.codex_") {
        return matches!(file.as_str(), "chatgpt.exe" | "codex.exe");
    }
    file == "codex.exe"
        && image
            .parent()
            .is_some_and(|p| p.join("resources/app.asar").is_file())
}
fn config_directory(env: &BTreeMap<String, String>, target: Target) -> Option<PathBuf> {
    let variable = if target == Target::ClaudeCli {
        "CLAUDE_CONFIG_DIR"
    } else {
        "CODEX_HOME"
    };
    match env.get(variable) {
        Some(path) => {
            let path = PathBuf::from(path);
            path.is_absolute().then_some(path)
        }
        None => env
            .get("USERPROFILE")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .map(|p| {
                p.join(if target == Target::ClaudeCli {
                    ".claude"
                } else {
                    ".codex"
                })
            }),
    }
}
fn command_parts(command: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut part = String::new();
    let mut quoted = false;
    for c in command.chars() {
        if c == '"' {
            quoted = !quoted;
        } else if c.is_whitespace() && !quoted {
            if !part.is_empty() {
                parts.push(std::mem::take(&mut part));
            }
        } else {
            part.push(c);
        }
    }
    if !part.is_empty() {
        parts.push(part);
    }
    parts
}
fn user_data(command: &str) -> Option<PathBuf> {
    // Only preserve Electron's directory override, never a full command line.
    let parts = command_parts(command);
    parts.iter().enumerate().find_map(|(i, p)| {
        let value = p.strip_prefix("--user-data-dir=").or_else(|| {
            (p == "--user-data-dir")
                .then(|| parts.get(i + 1).map(String::as_str))
                .flatten()
        })?;
        let path = PathBuf::from(value);
        path.is_absolute().then_some(path)
    })
}
fn claude_desktop_home(
    command: &str,
    env: &BTreeMap<String, String>,
    directory: &Path,
) -> Option<PathBuf> {
    let home = user_data(command).or_else(|| {
        env.get("LOCALAPPDATA")
            .map(|p| PathBuf::from(p).join("Claude"))
    })?;
    if !home.is_absolute() {
        return None;
    }
    crate::adapters::specifications(Target::ClaudeDesktop, directory)
        .iter()
        .any(|(path, _, _)| {
            path.file_name().and_then(|p| p.to_str()) == Some("claude_desktop_config.json")
                && path
                    .parent()
                    .is_some_and(|p| crate::discovery::same_directory(p, &home))
        })
        .then_some(home)
}
fn cli_identity(image: &Path, command: &str) -> Option<Vec<String>> {
    if desktop_image(image, Target::ClaudeDesktop) {
        return None;
    }
    let name = image.file_name()?.to_str()?.to_ascii_lowercase();
    if name == "claude.exe" {
        return Some(vec![]);
    }
    if name == "node.exe" {
        let parts = command_parts(command);
        let script = parts.get(1)?;
        let normalized = script.replace('/', "\\").to_lowercase();
        if Path::new(script).is_absolute()
            && normalized.ends_with("\\@anthropic-ai\\claude-code\\cli.js")
        {
            return Some(vec![script.clone()]);
        }
    }
    None
}
fn cli_arguments(image: &Path, command: &str) -> Option<Vec<String>> {
    let mut launch = cli_identity(image, command)?;
    let parts = command_parts(command);
    // SDK, print and piped automation are not interactive sessions to reopen.
    if parts.iter().any(|p| {
        [
            "-p",
            "--print",
            "--output-format",
            "--input-format",
            "--sdk-url",
        ]
        .iter()
        .any(|flag| p == flag || p.starts_with(&format!("{flag}=")))
    }) {
        return None;
    }
    let session = parts.iter().enumerate().find_map(|(i, p)| {
        p.strip_prefix("--resume=")
            .or_else(|| {
                (p == "--resume" || p == "-r")
                    .then(|| parts.get(i + 1).map(String::as_str))
                    .flatten()
            })
            .and_then(|value| uuid::Uuid::parse_str(value).ok())
    });
    if let Some(session) = session {
        launch.extend(["--resume".into(), session.to_string()]);
    } else {
        launch.push("--continue".into());
    }
    Some(launch)
}
struct WindowQuery {
    pid: u32,
    windows: Vec<isize>,
}
unsafe extern "system" fn collect_windows(window: HWND, data: isize) -> i32 {
    let query = unsafe { &mut *(data as *mut WindowQuery) };
    let mut pid = 0;
    unsafe {
        GetWindowThreadProcessId(window, &mut pid);
    }
    if pid == query.pid {
        let mut class = [0u16; 128];
        let len = unsafe { GetClassNameW(window, class.as_mut_ptr(), class.len() as i32) };
        if len > 0 && String::from_utf16_lossy(&class[..len as usize]) == "Chrome_WidgetWin_1" {
            query.windows.push(window as isize);
        }
    }
    1
}
fn windows(pid: u32) -> Vec<isize> {
    let mut query = WindowQuery {
        pid,
        windows: vec![],
    };
    unsafe {
        EnumWindows(
            Some(collect_windows),
            (&mut query as *mut WindowQuery).cast::<c_void>() as isize,
        );
    }
    query.windows
}
fn restarted_desktop(previous: &Candidate, current: &Candidate) -> bool {
    !current.windows.is_empty()
        && current.image == previous.image
        && (current.pid != previous.pid || current.started != previous.started)
        && current.started >= previous.started
        && crate::discovery::same_directory(&current.directory, &previous.directory)
        && current.profile == previous.profile
        && match (&current.user_data, &previous.user_data) {
            (Some(current), Some(previous)) => crate::discovery::same_directory(current, previous),
            (None, None) => true,
            _ => false,
        }
}
fn candidates(target: Target, directory: &Path) -> Vec<Candidate> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return vec![];
    }
    let snapshot = Handle(snapshot);
    let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    let mut found = unsafe { Process32FirstW(snapshot.0, &mut entry) } != 0;
    let mut matches = Vec::new();
    while found {
        let name = String::from_utf16_lossy(
            &entry.szExeFile[..entry
                .szExeFile
                .iter()
                .position(|c| *c == 0)
                .unwrap_or(entry.szExeFile.len())],
        )
        .to_lowercase();
        if matches!(
            name.as_str(),
            "codex.exe" | "chatgpt.exe" | "claude.exe" | "node.exe"
        ) {
            let handle = unsafe {
                OpenProcess(
                    PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
                    0,
                    entry.th32ProcessID,
                )
            };
            if !handle.is_null() {
                let handle = Handle(handle);
                if let Some(image) = image_path(handle.0) {
                    if let Some(context) = crate::discovery::windows::process_context(handle.0) {
                        let command = context.command;
                        let env = context.env;
                        let identity = if target == Target::ClaudeCli {
                            cli_identity(&image, &command).is_some()
                        } else {
                            desktop_image(&image, target)
                        };
                        if identity && !command.contains("--type=") {
                            let home = if target == Target::ClaudeDesktop {
                                claude_desktop_home(&command, &env, directory)
                            } else {
                                config_directory(&env, target)
                                    .filter(|p| crate::discovery::same_directory(p, directory))
                            };
                            if let Some(home) = home {
                                if let Some(started) = started(handle.0) {
                                    let cli_arguments = if target == Target::ClaudeCli {
                                        cli_arguments(&image, &command)
                                    } else {
                                        None
                                    };
                                    matches.push(Candidate {
                                        pid: entry.th32ProcessID,
                                        started,
                                        image,
                                        directory: home,
                                        user_data: user_data(&command),
                                        windows: windows(entry.th32ProcessID),
                                        profile: profile_environment(&env),
                                        current_directory: context.current_directory,
                                        cli_arguments,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
        found = unsafe { Process32NextW(snapshot.0, &mut entry) } != 0;
    }
    matches
}
pub(super) fn client_runtime(target: Target, directory: &Path, revision: u64) -> DesktopRuntime {
    let candidates = candidates(target, directory);
    let name = client_name(target);
    let cli = target == Target::ClaudeCli;
    let profile_safe = candidates.len() == 1 && validate_restart_paths(&candidates[0]).is_ok();
    let can_restart = profile_safe
        && if cli {
            candidates[0].cli_arguments.is_some()
                && candidates[0]
                    .current_directory
                    .as_ref()
                    .is_some_and(|p| p.is_dir())
        } else {
            !candidates[0].windows.is_empty()
        };
    let restart_in_progress = cli && candidates.iter().any(helper_running);
    DesktopRuntime {
        running: !candidates.is_empty(),
        restart_required: revision > 0 && candidates.iter().any(|p| p.started < revision),
        can_restart,
        reason: if candidates.len() > 1 {
            Some(format!("检测到多个使用此配置的 {name} 实例，请先手动退出多余实例，再重启需要使用新配置的会话。"))
        } else if !candidates.is_empty() && !profile_safe {
            Some(profile_error().message)
        } else if !candidates.is_empty() && !can_restart && cli {
            Some("此 CLI 为自动化任务，或无法确认原工作目录。请等待任务结束，在原终端重新运行 Claude；新配置已保存。".into())
        } else if !candidates.is_empty() && !can_restart {
            Some(format!(
                "未找到可关闭的 {name} 窗口，请从客户端菜单退出后重新打开。"
            ))
        } else {
            None
        },
        restart_in_progress,
    }
}
pub(super) fn restart_client(target: Target, directory: &Path) -> Result<RestartResult> {
    validate_profile_directory(directory)?;
    let name = client_name(target);
    let mut matches = candidates(target, directory);
    if matches.is_empty() {
        return Ok(RestartResult {
            restarted: false,
            message: format!("{name} 已退出，下次打开会加载最新配置。"),
            pending: false,
        });
    }
    if matches.len() != 1 {
        return Err(AppError::new(
            "restart_ambiguous",
            format!("检测到多个 {name} 实例，请先退出多余实例后重试"),
        ));
    }
    let candidate = matches.remove(0);
    // Refuse unsafe or unknown data paths before requesting any shutdown.
    validate_restart_paths(&candidate)?;
    let handle = unsafe {
        OpenProcess(
            PROCESS_QUERY_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            candidate.pid,
        )
    };
    if handle.is_null() {
        return Err(AppError::new(
            "restart_changed",
            format!("{name} 进程已发生变化，请稍后重试"),
        ));
    }
    let handle = Handle(handle);
    if started(handle.0) != Some(candidate.started)
        || image_path(handle.0).as_ref() != Some(&candidate.image)
    {
        return Err(AppError::new(
            "restart_changed",
            format!("{name} 进程已发生变化，请稍后重试"),
        ));
    }
    if !candidate.image.is_file() {
        return Err(AppError::new(
            "restart_launch",
            format!("{name} 启动文件已不可用，请重新打开客户端"),
        ));
    }
    if target == Target::ClaudeCli {
        return restart_cli(&candidate, directory);
    }
    if candidate.windows.is_empty() {
        return Err(AppError::new(
            "restart_no_window",
            format!("未找到可关闭的 {name} 窗口，请从客户端菜单退出后重新打开"),
        ));
    }
    // Electron applications may retain a background process when the last
    // window closes. Restart Manager requests an application shutdown rather
    // than a window close. Register only this exact process, with its native
    // creation time, and never use RmForceShutdown.
    let mut session = 0;
    let mut session_key = [0u16; CCH_RM_SESSION_KEY as usize + 1];
    if unsafe { RmStartSession(&mut session, 0, session_key.as_mut_ptr()) } != 0 {
        return Err(AppError::new(
            "restart_close",
            format!("无法请求 Windows 正常退出 {name}，请手动退出后重新打开"),
        ));
    }
    let session = RestartSession(session);
    let (mut creation, mut exit, mut kernel, mut user) =
        unsafe { (zeroed(), zeroed(), zeroed(), zeroed()) };
    if unsafe { GetProcessTimes(handle.0, &mut creation, &mut exit, &mut kernel, &mut user) } == 0 {
        return Err(AppError::new(
            "restart_changed",
            format!("{name} 进程已发生变化，请稍后重试"),
        ));
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
            format!("无法确认要退出的 {name} 实例，请手动退出后重新打开"),
        ));
    }
    let _shutdown = unsafe { RmShutdown(session.0, 0, None) };
    if unsafe { WaitForSingleObject(handle.0, 1000) } != 0 {
        return Err(AppError::new(
            "restart_close",
            format!(
                "{name} 尚未退出，可能仍有任务或确认窗口。请在客户端中处理后重试；新配置已保存"
            ),
        ));
    }
    // Reopen the exact installed desktop executable with the same config and
    // user-data directory. This never executes shell text or restarts a CLI.
    let mut launch = Command::new(&candidate.image);
    validate_restart_paths(&candidate)?;
    preserve_profile(&mut launch, &candidate.profile);
    launch.current_dir(
        candidate
            .current_directory
            .as_ref()
            .ok_or_else(profile_error)?,
    );
    launch.creation_flags(0x08000000);
    if target == Target::Codex {
        launch.env("CODEX_HOME", &candidate.directory);
    }
    if let Some(user_data) = &candidate.user_data {
        launch.arg(format!("--user-data-dir={}", user_data.display()));
    }
    launch.spawn().map_err(|_| {
        AppError::new(
            "restart_launch",
            format!("{name} 已退出，但未能重新打开。请从开始菜单启动；新配置已保存"),
        )
    })?;
    let end = Instant::now() + Duration::from_secs(15);
    while Instant::now() < end {
        if candidates(target, directory)
            .iter()
            .any(|c| restarted_desktop(&candidate, c))
        {
            return Ok(RestartResult {
                restarted: true,
                message: format!("{name} 已重启并打开，最新配置将用于新会话。"),
                pending: false,
            });
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err(AppError::new(
        "restart_launch",
        format!("已请求打开 {name}，但尚未检测到新窗口。请从开始菜单检查；新配置已保存"),
    ))
}
type Helpers = BTreeMap<(u32, u64), Child>;
fn helpers() -> &'static Mutex<Helpers> {
    static HELPERS: OnceLock<Mutex<Helpers>> = OnceLock::new();
    HELPERS.get_or_init(|| Mutex::new(BTreeMap::new()))
}
fn helper_running(candidate: &Candidate) -> bool {
    let Ok(mut helpers) = helpers().lock() else {
        return false;
    };
    helpers.retain(|_, child| child.try_wait().is_ok_and(|status| status.is_none()));
    helpers.contains_key(&(candidate.pid, candidate.started))
}
fn restart_cli(candidate: &Candidate, directory: &Path) -> Result<RestartResult> {
    let arguments = candidate.cli_arguments.as_ref().ok_or_else(|| {
        AppError::new(
            "restart_cli_automation",
            "此 Claude CLI 为自动化任务，请等待任务结束后重新运行；新配置已保存",
        )
    })?;
    let working = candidate
        .current_directory
        .as_ref()
        .filter(|p| p.is_dir())
        .ok_or_else(|| {
            AppError::new(
                "restart_cli_directory",
                "无法确认 CLI 的工作目录，请在原终端退出后重新启动；新配置已保存",
            )
        })?;
    let shell = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .map(|p| p.join("System32/WindowsPowerShell/v1.0/powershell.exe"))
        .filter(|p| p.is_file())
        .ok_or_else(|| {
            AppError::new(
                "restart_cli_shell",
                "未找到 Windows PowerShell，请在原终端输入 /exit 后重新运行 claude --continue",
            )
        })?;
    let mut helpers = helpers()
        .lock()
        .map_err(|_| AppError::new("restart_busy", "重启服务繁忙，请稍后重试"))?;
    helpers.retain(|_, child| child.try_wait().is_ok_and(|status| status.is_none()));
    let key = (candidate.pid, candidate.started);
    if helpers.contains_key(&key) {
        return Ok(RestartResult {
            restarted: false,
            pending: true,
            message:
                "重启终端已打开。请在原 Claude CLI 输入 /exit；退出后将自动恢复会话并加载新配置。"
                    .into(),
        });
    }
    // The helper waits for the exact old process to exit; it never sends a
    // console signal to a shared terminal or forcefully stops any process.
    let encoded = base64::engine::general_purpose::STANDARD.encode(
        include_str!("cli-restart.ps1")
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    let mut launch = Command::new(shell);
    preserve_profile(&mut launch, &candidate.profile);
    launch
        .args(["-NoLogo", "-NoProfile", "-EncodedCommand", &encoded])
        .creation_flags(0x00000010)
        .current_dir(working)
        .env("CLAUDE_CONFIG_DIR", directory)
        .env("UNI_SWITCH_CLI_PID", candidate.pid.to_string())
        .env("UNI_SWITCH_CLI_STARTED", candidate.started.to_string())
        .env("UNI_SWITCH_CLI_IMAGE", &candidate.image)
        .env("UNI_SWITCH_CLI_WORKING", working)
        .env(
            "UNI_SWITCH_CLI_ARGUMENTS",
            serde_json::to_string(arguments).unwrap(),
        );
    for variable in [
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
    ] {
        launch.env_remove(variable);
    }
    let child = launch.spawn().map_err(|_| {
        AppError::new(
            "restart_cli_launch",
            "无法打开重启终端，请在原终端输入 /exit 后重新运行 claude --continue；新配置已保存",
        )
    })?;
    helpers.insert(key, child);
    Ok(RestartResult {
        restarted: false,
        pending: true,
        message: "已打开重启终端。请在原 Claude CLI 输入 /exit；退出后将自动恢复会话并加载新配置。"
            .into(),
    })
}

#[cfg(test)]
mod owned_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn profile_capture_and_restore_preserve_absence_without_provider_credentials() {
        let original = BTreeMap::from([
            ("appdata".into(), r"G:\original-profile\roaming".into()),
            ("USERPROFILE".into(), r"G:\original-profile".into()),
            ("ANTHROPIC_API_KEY".into(), "private-key".into()),
        ]);
        let profile = profile_environment(&original);
        assert_eq!(profile.len(), 2);
        assert_eq!(profile["APPDATA"], original["appdata"]);
        let mut launch = Command::new("owned-fixture.exe");
        preserve_profile(&mut launch, &profile);
        let values: BTreeMap<_, _> = launch.get_envs().collect();
        assert_eq!(
            values[std::ffi::OsStr::new("APPDATA")],
            Some(std::ffi::OsStr::new(r"G:\original-profile\roaming"))
        );
        assert_eq!(values[std::ffi::OsStr::new("HOME")], None);
        assert_eq!(values[std::ffi::OsStr::new("XDG_DATA_HOME")], None);
        assert!(!values.contains_key(std::ffi::OsStr::new("ANTHROPIC_API_KEY")));
    }
    #[test]
    fn restart_profile_validation_refuses_missing_paths_and_unknown_profile() {
        let temporary = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
        let path = temporary.path().to_string_lossy().into_owned();
        let profile: BTreeMap<String, String> =
            ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]
                .into_iter()
                .map(|name| (name.into(), path.clone()))
                .collect();
        assert!(validate_profile_environment(&profile).is_ok());
        for unsafe_path in [
            r"C:\Users\profile",
            r"\\host\share\profile",
            r"G:\profile\..\other",
            "relative",
        ] {
            let mut modified = profile.clone();
            modified.insert("APPDATA".into(), unsafe_path.into());
            assert_eq!(
                validate_profile_environment(&modified).unwrap_err().code,
                "restart_profile"
            );
        }
        let mut missing = profile.clone();
        missing.remove("TMP");
        assert!(validate_profile_environment(&missing).is_err());
        let mut other_drive = profile;
        other_drive.insert("HOMEDRIVE".into(), "C:".into());
        other_drive.insert("HOMEPATH".into(), "\\Users\\profile".into());
        assert!(validate_profile_environment(&other_drive).is_err());
    }
    #[test]
    fn desktop_restart_rejects_old_or_unrelated_instances() {
        let fixture = |pid, started, image: &str, directory: &str, user_data: &str| Candidate {
            pid,
            started,
            image: PathBuf::from(image),
            directory: PathBuf::from(directory),
            user_data: Some(PathBuf::from(user_data)),
            windows: vec![1],
            profile: BTreeMap::new(),
            current_directory: None,
            cli_arguments: None,
        };
        let old = fixture(
            10,
            100,
            r"G:\fixture\Codex.exe",
            r"G:\config",
            r"G:\user-data",
        );
        let new = fixture(
            11,
            200,
            r"G:\fixture\Codex.exe",
            r"G:\config",
            r"G:\user-data",
        );
        assert!(restarted_desktop(&old, &new));
        assert!(
            !restarted_desktop(&old, &old),
            "old instance cannot prove a restart"
        );
        for unrelated in [
            fixture(
                11,
                200,
                r"G:\other\Codex.exe",
                r"G:\config",
                r"G:\user-data",
            ),
            fixture(
                11,
                200,
                r"G:\fixture\Codex.exe",
                r"G:\other-config",
                r"G:\user-data",
            ),
            fixture(
                11,
                200,
                r"G:\fixture\Codex.exe",
                r"G:\config",
                r"G:\other-data",
            ),
            fixture(
                11,
                50,
                r"G:\fixture\Codex.exe",
                r"G:\config",
                r"G:\user-data",
            ),
        ] {
            assert!(
                !restarted_desktop(&old, &unrelated),
                "unrelated instance cannot prove a restart"
            );
        }
        let mut no_window = new;
        no_window.windows.clear();
        assert!(!restarted_desktop(&old, &no_window));
    }
    #[test]
    fn claude_desktop_and_native_cli_are_distinct() {
        let desktop = Path::new(r"C:\Program Files\WindowsApps\Claude_1_x64__id\app\Claude.exe");
        let cli = Path::new(r"C:\Users\user\.local\bin\claude.exe");
        assert!(desktop_image(desktop, Target::ClaudeDesktop));
        assert!(!desktop_image(cli, Target::ClaudeDesktop));
        assert!(cli_identity(desktop, "Claude.exe").is_none());
        assert_eq!(
            cli_arguments(cli, "claude.exe --model old-model"),
            Some(vec!["--continue".into()])
        );
        assert_eq!(
            cli_arguments(cli, "claude.exe --print private-prompt"),
            None
        );
        assert_eq!(
            cli_arguments(cli, "claude.exe --input-format=stream-json"),
            None
        );
    }
    #[test]
    fn npm_cli_restart_only_preserves_script_and_valid_session_id() {
        let node = Path::new(r"C:\Apps\node.exe");
        let command = r#"node.exe "D:\项目 目录\node_modules\@anthropic-ai\claude-code\cli.js" --resume 749b4741-cbc0-4a22-bcbd-bc4717e3bcdc --model old --secret private"#;
        assert_eq!(
            cli_arguments(node, command),
            Some(vec![
                r"D:\项目 目录\node_modules\@anthropic-ai\claude-code\cli.js".into(),
                "--resume".into(),
                "749b4741-cbc0-4a22-bcbd-bc4717e3bcdc".into()
            ])
        );
        assert_eq!(cli_identity(node, "node.exe unrelated.js"), None);
        assert_eq!(
            cli_identity(node, r"node.exe @anthropic-ai/claude-code/cli.js"),
            None
        );
    }
    #[test]
    fn claude_processes_only_match_bound_configuration_directories() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("用户 中文");
        let env = BTreeMap::from([
            ("LOCALAPPDATA".into(), root.to_string_lossy().into()),
            ("USERPROFILE".into(), root.to_string_lossy().into()),
        ]);
        assert_eq!(
            claude_desktop_home("Claude.exe", &env, &root),
            Some(root.join("Claude"))
        );
        assert!(claude_desktop_home("Claude.exe", &env, &root.join("Other")).is_none());
        let custom = root.join("Claude-Custom");
        std::fs::create_dir_all(&custom).unwrap();
        std::fs::write(custom.join("claude_desktop_config.json"), "{}").unwrap();
        assert_eq!(
            claude_desktop_home(
                &format!("Claude.exe --user-data-dir=\"{}\"", custom.display()),
                &env,
                &custom
            ),
            Some(custom)
        );
        assert_eq!(
            config_directory(&env, Target::ClaudeCli),
            Some(root.join(".claude"))
        );
        let mut overridden = env;
        overridden.insert("CLAUDE_CONFIG_DIR".into(), "relative".into());
        assert!(config_directory(&overridden, Target::ClaudeCli).is_none());
    }
    #[test]
    fn desktop_identity_excludes_cli_and_chatgpt_app() {
        assert!(desktop_image(
            Path::new(r"C:\Program Files\WindowsApps\OpenAI.Codex_1_x64__id\app\ChatGPT.exe"),
            Target::Codex
        ));
        assert!(!desktop_image(
            Path::new(r"C:\Program Files\WindowsApps\OpenAI.ChatGPT_1_x64__id\app\ChatGPT.exe"),
            Target::Codex
        ));
        assert!(!desktop_image(
            Path::new(r"C:\Users\user\OpenAI\Codex\bin\hash\codex.exe"),
            Target::Codex
        ));
        let mut env = BTreeMap::from([("USERPROFILE".into(), r"C:\Users\user".into())]);
        assert_eq!(
            config_directory(&env, Target::Codex),
            Some(PathBuf::from(r"C:\Users\user\.codex"))
        );
        env.insert("CODEX_HOME".into(), "relative".into());
        assert_eq!(config_directory(&env, Target::Codex), None);
    }
    #[test]
    fn restart_preserves_only_absolute_user_data_override() {
        assert_eq!(
            user_data(
                r#""C:\Program Files\Codex\Codex.exe" --user-data-dir="D:\用户 目录" --secret=private"#
            ),
            Some(PathBuf::from(r"D:\用户 目录"))
        );
        assert_eq!(user_data("Codex.exe --user-data-dir=relative"), None);
    }
}
