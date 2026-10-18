#![cfg_attr(fixture_desktop, windows_subsystem = "windows")]

use std::{ffi::c_void, path::PathBuf, sync::OnceLock, time::Duration};

type Window = *mut c_void;
#[repr(C)]
struct WindowClass {
    style: u32,
    procedure: Option<unsafe extern "system" fn(Window, u32, usize, isize) -> isize>,
    class_extra: i32,
    window_extra: i32,
    instance: *mut c_void,
    icon: *mut c_void,
    cursor: *mut c_void,
    background: *mut c_void,
    menu: *const u16,
    name: *const u16,
}
#[repr(C)]
struct Message {
    window: Window,
    message: u32,
    wparam: usize,
    lparam: isize,
    time: u32,
    point: [i32; 2],
    private: u32,
}
#[link(name = "user32")]
extern "system" {
    fn RegisterClassW(class: *const WindowClass) -> u16;
    fn CreateWindowExW(
        extended_style: u32,
        class: *const u16,
        title: *const u16,
        style: u32,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        parent: Window,
        menu: *mut c_void,
        instance: *mut c_void,
        parameter: *mut c_void,
    ) -> Window;
    fn DefWindowProcW(window: Window, message: u32, wparam: usize, lparam: isize) -> isize;
    fn GetMessageW(message: *mut Message, window: Window, first: u32, last: u32) -> i32;
    fn TranslateMessage(message: *const Message) -> i32;
    fn DispatchMessageW(message: *const Message) -> isize;
    fn PostQuitMessage(code: i32);
    fn DestroyWindow(window: Window) -> i32;
    fn SetTimer(window: Window, id: usize, interval: u32, callback: *const c_void) -> usize;
}
#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(name: *const u16) -> *mut c_void;
}

static ROOT: OnceLock<PathBuf> = OnceLock::new();
static OWNER: OnceLock<String> = OnceLock::new();
fn event(name: &str) {
    std::fs::write(
        ROOT.get()
            .unwrap()
            .join(format!("{}-{name}.txt", std::process::id())),
        OWNER.get().unwrap(),
    )
    .unwrap();
}
fn exit_requested() -> bool {
    std::fs::read_to_string(
        ROOT.get()
            .unwrap()
            .join(format!("{}.exit", std::process::id())),
    )
    .is_ok_and(|value| value == *OWNER.get().unwrap())
}
unsafe extern "system" fn procedure(
    window: Window,
    message: u32,
    wparam: usize,
    lparam: isize,
) -> isize {
    match message {
        0x0011 => {
            event("query-end-session");
            1
        }
        0x0016 if wparam != 0 => {
            event("end-session");
            unsafe { PostQuitMessage(0) };
            0
        }
        0x0113 if exit_requested() => {
            event("owned-exit");
            unsafe { PostQuitMessage(0) };
            0
        }
        _ => unsafe { DefWindowProcW(window, message, wparam, lparam) },
    }
}
fn quoted(value: &str) -> String {
    let mut result = String::from("\"");
    for c in value.chars() {
        match c {
            '\\' => result.push_str("\\\\"),
            '"' => result.push_str("\\\""),
            c if c <= '\u{1f}' => result.push_str(&format!("\\u{:04x}", c as u32)),
            c => result.push(c),
        }
    }
    result.push('"');
    result
}
fn record() {
    let root = ROOT.get().unwrap();
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let user_data = arguments
        .iter()
        .find_map(|arg| arg.strip_prefix("--user-data-dir="));
    let executable = std::env::current_exe().unwrap();
    let desktop = executable
        .parent()
        .unwrap()
        .join("resources/app.asar")
        .is_file();
    let config = if executable
        .file_name()
        .unwrap()
        .to_string_lossy()
        .eq_ignore_ascii_case("Codex.exe")
    {
        PathBuf::from(std::env::var_os("CODEX_HOME").unwrap())
    } else if desktop {
        user_data.map(PathBuf::from).unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap()).join("Claude")
        })
    } else {
        PathBuf::from(std::env::var_os("CLAUDE_CONFIG_DIR").unwrap())
    };
    assert!(config.canonicalize().unwrap().starts_with(root));
    let revision = std::fs::read_to_string(config.join("restart-fixture-revision.txt")).unwrap();
    let expected_resume = std::env::var("AE_SWITCH_RESTART_FIXTURE_RESUME").unwrap_or_default();
    let resumed = arguments
        .windows(2)
        .any(|pair| pair[0] == "--resume" && pair[1] == expected_resume);
    let cleared_environment = [
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_MODEL",
    ]
    .iter()
    .all(|name| std::env::var_os(name).is_none());
    let profile = [
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
        "HOMEDRIVE",
        "HOMEPATH",
    ]
    .into_iter()
    .map(|name| {
        format!(
            "{}:{}",
            quoted(name),
            std::env::var(name)
                .map(|value| quoted(&value))
                .unwrap_or_else(|_| "null".into())
        )
    })
    .collect::<Vec<_>>()
    .join(",");
    let record = format!(
        "{{\"owner\":{},\"pid\":{},\"configDirectory\":{},\"userData\":{},\"workingDirectory\":{},\"revision\":{},\"ignoredArgumentPresent\":{},\"resumeMatched\":{},\"continuePresent\":{},\"providerEnvironmentCleared\":{},\"profile\":{{{}}}}}",
        quoted(OWNER.get().unwrap()), std::process::id(), quoted(&config.to_string_lossy()),
        user_data.map(quoted).unwrap_or_else(|| "null".into()), quoted(&std::env::current_dir().unwrap().to_string_lossy()), quoted(&revision),
        arguments.iter().any(|arg| arg == "--fixture-unused-option"), resumed,
        arguments.iter().any(|arg| arg == "--continue"), cleared_environment, profile,
    );
    std::fs::write(
        root.join(format!("{}-started.json", std::process::id())),
        record,
    )
    .unwrap();
}
fn main() {
    let root = PathBuf::from(std::env::var_os("AE_SWITCH_RESTART_FIXTURE_ROOT").unwrap())
        .canonicalize()
        .unwrap();
    let owner = std::env::var("AE_SWITCH_RESTART_FIXTURE_OWNER").unwrap();
    assert!(root
        .to_string_lossy()
        .trim_start_matches("\\\\?\\")
        .to_ascii_uppercase()
        .starts_with("G:\\"));
    assert_eq!(
        std::fs::read_to_string(root.join("owner.txt")).unwrap(),
        owner
    );
    ROOT.set(root).unwrap();
    OWNER.set(owner).unwrap();
    let executable = std::env::current_exe().unwrap();
    if !executable
        .parent()
        .unwrap()
        .join("resources/app.asar")
        .is_file()
    {
        record();
        while !exit_requested() {
            std::thread::sleep(Duration::from_millis(50));
        }
        event("owned-exit");
        return;
    }
    let class: Vec<u16> = "Chrome_WidgetWin_1\0".encode_utf16().collect();
    let instance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let descriptor = WindowClass {
        style: 0,
        procedure: Some(procedure),
        class_extra: 0,
        window_extra: 0,
        instance,
        icon: std::ptr::null_mut(),
        cursor: std::ptr::null_mut(),
        background: std::ptr::null_mut(),
        menu: std::ptr::null(),
        name: class.as_ptr(),
    };
    assert_ne!(unsafe { RegisterClassW(&descriptor) }, 0);
    let window = unsafe {
        CreateWindowExW(
            0,
            class.as_ptr(),
            class.as_ptr(),
            0x00cf0000,
            0,
            0,
            320,
            240,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            instance,
            std::ptr::null_mut(),
        )
    };
    assert!(!window.is_null());
    assert_ne!(unsafe { SetTimer(window, 1, 50, std::ptr::null()) }, 0);
    record();
    let mut message: Message = unsafe { std::mem::zeroed() };
    while unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) } > 0 {
        unsafe {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
    unsafe {
        DestroyWindow(window);
    }
}
