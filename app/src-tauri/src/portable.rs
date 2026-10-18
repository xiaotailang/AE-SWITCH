//! Process bootstrap: called before any Rust/Tauri worker threads are started.
#![forbid(unsafe_code)]

use crate::error::{AppError, Result};
use std::path::{Component, Path, PathBuf};

pub fn root() -> Result<PathBuf> {
    let root = if let Some(root) = std::env::var_os("AE_SWITCH_PORTABLE_ROOT") {
        PathBuf::from(root)
    } else {
        let executable = std::env::current_exe()
            .map_err(|_| AppError::new("portable_path", "无法确定便携程序目录"))?;
        executable_root(&executable, cfg!(target_os = "macos"))?
    };
    validate_root(&root)?;
    Ok(root)
}

fn executable_root(executable: &Path, macos: bool) -> Result<PathBuf> {
    let parent = executable
        .parent()
        .ok_or_else(|| AppError::new("portable_path", "便携程序缺少父目录"))?;
    if macos && parent.file_name().is_some_and(|name| name == "MacOS") {
        if let Some(contents) = parent
            .parent()
            .filter(|path| path.file_name().is_some_and(|name| name == "Contents"))
        {
            if let Some(bundle) = contents.parent().filter(|path| {
                path.extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
            }) {
                return bundle.parent().map(Path::to_path_buf).ok_or_else(|| {
                    AppError::new("portable_path", "应用包缺少可存放便携数据的外层目录")
                });
            }
        }
    }
    Ok(parent.to_path_buf())
}

fn bundled_tool_paths(root: &Path, windows: bool) -> Vec<PathBuf> {
    let relative: &[&str] = if windows {
        &["tools/node", "tools/git/cmd", "tools/git/bin"]
    } else {
        &[
            "tools/node/bin",
            "tools/node",
            "tools/python/bin",
            "tools/git/bin",
        ]
    };
    relative
        .iter()
        .map(|relative| root.join(relative))
        .collect()
}

pub fn validate_root(root: &Path) -> Result<()> {
    if !root.is_absolute() || root.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(AppError::new(
            "portable_path",
            "便携目录必须是没有上级跳转的绝对路径",
        ));
    }
    #[cfg(windows)]
    validate_local_drive(root)?;
    let mut ancestor = PathBuf::new();
    let mut existing = None;
    for component in root.components() {
        ancestor.push(component);
        match std::fs::symlink_metadata(&ancestor) {
            Ok(metadata) => {
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if metadata.file_attributes() & 0x400 != 0 {
                        return Err(AppError::new(
                            "portable_path",
                            "便携数据路径不可经过符号链接或目录联接",
                        ));
                    }
                }
                if metadata.file_type().is_symlink() {
                    return Err(AppError::new(
                        "portable_path",
                        "便携数据路径不可经过符号链接",
                    ));
                }
                existing = Some(ancestor.clone());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(AppError::io(&ancestor, error)),
        }
    }
    if let Some(existing) = existing {
        let physical = existing
            .canonicalize()
            .map_err(|error| AppError::io(&existing, error))?;
        #[cfg(windows)]
        validate_local_drive(&physical)?;
        #[cfg(not(windows))]
        let _ = physical;
    }
    Ok(())
}

/// Recheck each actual file access, including paths restored from the database.
/// A directory that was safe at selection time can later become a junction.
pub(crate) fn validate_owned_path(path: &Path) -> Result<()> {
    if let Some(root) = std::env::var_os("AE_SWITCH_PORTABLE_ROOT") {
        let root = PathBuf::from(root);
        validate_root(&root)?;
        validate_root(path)?;
        if !path.starts_with(&root) {
            return Err(AppError::new(
                "portable_path",
                "配置文件必须位于当前便携目录内，旧目录或外部目录未被读取或修改",
            ));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn validate_local_drive(root: &Path) -> Result<()> {
    match root.components().next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_) => Ok(()),
            _ => Err(AppError::new(
                "portable_path",
                "便携数据必须位于本地磁盘的工作目录",
            )),
        },
        _ => Err(AppError::new(
            "portable_path",
            "便携数据必须位于本地磁盘的工作目录",
        )),
    }
}

/// Runs synchronously before the runtime exists; do not call after spawning threads.
pub fn initialize() -> Result<PathBuf> {
    crate::agent_discovery::capture_original_environment();
    let root = root()?;
    let data = root.join("data");
    validate_root(&data)?;
    create_data_directories(&root)?;
    for (variable, relative) in [
        ("HOME", "data/home"),
        ("USERPROFILE", "data/home"),
        ("APPDATA", "data/home/AppData/Roaming"),
        ("LOCALAPPDATA", "data/home/AppData/Local"),
        ("TEMP", "data/tmp"),
        ("TMP", "data/tmp"),
        ("XDG_CONFIG_HOME", "data/config"),
        ("XDG_CACHE_HOME", "data/cache"),
        ("XDG_DATA_HOME", "data/home"),
        ("XDG_STATE_HOME", "data/state"),
        ("CODEX_HOME", "data/home/.codex"),
        ("CLAUDE_CONFIG_DIR", "data/home/.claude"),
        ("TMPDIR", "data/tmp"),
        ("WEBVIEW2_USER_DATA_FOLDER", "data/webview"),
        ("npm_config_cache", "data/cache/npm"),
        ("npm_config_prefix", "data/home/npm"),
        ("PIP_CACHE_DIR", "data/cache/pip"),
        ("UV_CACHE_DIR", "data/cache/uv"),
        ("PYTHONPYCACHEPREFIX", "data/cache/pycache"),
        ("GIT_CONFIG_GLOBAL", "data/config/gitconfig"),
    ] {
        let variable_path = root.join(relative);
        validate_root(&variable_path)?;
        std::env::set_var(variable, variable_path);
    }
    std::env::set_var("AE_SWITCH_PORTABLE_ROOT", &root);
    std::env::set_var("UNI_SWITCH_DATA_DIR", &data);
    let tools = [root.join("tools/agents"), root.join(".tools/agents")]
        .into_iter()
        .find(|path| path.is_dir())
        .unwrap_or_else(|| root.join("tools/agents"));
    std::env::set_var("AE_SWITCH_TOOLS_DIR", tools);
    let mut paths = bundled_tool_paths(&root, cfg!(windows));
    if let Some(inherited) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&inherited));
    }
    if let Ok(paths) = std::env::join_paths(paths) {
        std::env::set_var("PATH", paths);
    }
    if root.join("tools/git/bin/bash.exe").is_file() {
        std::env::set_var(
            "CLAUDE_CODE_GIT_BASH_PATH",
            root.join("tools/git/bin/bash.exe"),
        );
    }
    if root.join("tools/webview2/msedgewebview2.exe").is_file() {
        std::env::set_var(
            "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER",
            root.join("tools/webview2"),
        );
    }
    let loopback = loopback_no_proxy(
        std::env::var("NO_PROXY")
            .or_else(|_| std::env::var("no_proxy"))
            .ok()
            .as_deref(),
    );
    std::env::set_var("NO_PROXY", &loopback);
    std::env::set_var("no_proxy", &loopback);
    initialize_system_proxy();
    Ok(data)
}

fn create_data_directories(root: &Path) -> Result<()> {
    for relative in [
        "data",
        "data/home",
        "data/tmp",
        "data/cache",
        "data/config",
        "data/state",
        "data/webview",
        "data/home/AppData/Local",
        "data/home/AppData/Roaming",
    ] {
        let directory = root.join(relative);
        validate_root(&directory)?;
        std::fs::create_dir_all(&directory).map_err(|e| AppError::io(&directory, e))?;
        validate_root(&directory)?;
    }
    Ok(())
}

fn loopback_no_proxy(existing: Option<&str>) -> String {
    let mut hosts: Vec<&str> = existing
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .collect();
    for host in ["localhost", "127.0.0.1", "::1"] {
        if !hosts.iter().any(|entry| entry.eq_ignore_ascii_case(host)) {
            hosts.push(host);
        }
    }
    hosts.join(",")
}

fn initialize_system_proxy() {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if std::env::var_os("HTTPS_PROXY").is_some() || std::env::var_os("https_proxy").is_some() {
            return;
        }
        let query = |name: &str| -> Option<String> {
            let output = std::process::Command::new("reg.exe")
                .args([
                    "query",
                    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
                    "/v",
                    name,
                ])
                .creation_flags(0x08000000)
                .output()
                .ok()?;
            if !output.status.success() {
                return None;
            }
            let output = String::from_utf8_lossy(&output.stdout);
            output.lines().find_map(|line| {
                let fields: Vec<&str> = line.split_whitespace().collect();
                if fields.first() == Some(&name) && fields.len() >= 3 {
                    Some(fields[2..].join(" "))
                } else {
                    None
                }
            })
        };
        if query("ProxyEnable").as_deref() == Some("0x1") {
            if let Some(server) = query("ProxyServer") {
                let proxy = if server.contains('=') {
                    server
                        .split(';')
                        .find_map(|entry| {
                            entry
                                .strip_prefix("https=")
                                .or_else(|| entry.strip_prefix("http="))
                        })
                        .map(str::to_owned)
                } else {
                    Some(server)
                };
                if let Some(proxy) = proxy {
                    let proxy = if proxy.contains("://") {
                        proxy
                    } else {
                        format!("http://{proxy}")
                    };
                    if url::Url::parse(&proxy).is_ok() {
                        std::env::set_var("HTTPS_PROXY", &proxy);
                        std::env::set_var("HTTP_PROXY", proxy);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mac_bundle_data_root_is_outside_the_signed_bundle() {
        let outer = PathBuf::from("portable folder 中文");
        let executable = outer.join("AE Switch.app/Contents/MacOS/ae-switch");
        assert_eq!(executable_root(&executable, true).unwrap(), outer);
        assert_eq!(
            executable_root(&executable, false).unwrap(),
            executable.parent().unwrap()
        );
    }
    #[test]
    fn ordinary_executables_and_non_bundle_layouts_keep_their_parent() {
        for executable in [
            "portable/ae-switch",
            "portable/Contents/MacOS/ae-switch",
            "portable/AE.app/Other/MacOS/ae-switch",
        ] {
            let executable = Path::new(executable);
            assert_eq!(
                executable_root(executable, true).unwrap(),
                executable.parent().unwrap()
            );
        }
    }
    #[test]
    fn bundled_paths_preserve_windows_and_include_unix_executable_directories() {
        let root = Path::new("portable folder 中文");
        assert_eq!(
            bundled_tool_paths(root, true),
            ["tools/node", "tools/git/cmd", "tools/git/bin"].map(|path| root.join(path))
        );
        assert_eq!(
            bundled_tool_paths(root, false),
            [
                "tools/node/bin",
                "tools/node",
                "tools/python/bin",
                "tools/git/bin"
            ]
            .map(|path| root.join(path))
        );
    }
    #[test]
    fn rejects_relative_and_traversal_roots() {
        assert!(validate_root(Path::new("data")).is_err());
        let directory = tempfile::tempdir().unwrap();
        assert!(validate_root(&directory.path().join("../escape")).is_err());
        assert!(validate_root(directory.path()).is_ok());
    }
    #[cfg(windows)]
    #[test]
    fn local_drive_validation_accepts_every_drive_without_accessing_it() {
        // Parsing alone proves portability; these cases never create or read data
        // on any listed drive, including the developer's existing C profile.
        for drive in 'A'..='Z' {
            for path in [
                format!(r"{drive}:\AE Switch\data"),
                format!(r"\\?\{drive}:\AE Switch\data"),
            ] {
                assert!(validate_local_drive(Path::new(&path)).is_ok(), "{path}");
            }
        }
        assert!(validate_local_drive(Path::new(r"c:\AE Switch\data")).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn rejects_nonlocal_and_ambiguous_windows_roots_before_file_access() {
        for path in [
            r"\\server\share\AE Switch\data",
            r"\\?\UNC\server\share\AE Switch\data",
            r"\\localhost\c$\AE Switch\data",
            r"\\?\Volume{00000000-0000-0000-0000-000000000000}\data",
            r"\\.\C:\AE Switch\data",
            r"data",
            r"C:data",
            r"C:\AE Switch\..\outside",
        ] {
            assert!(validate_root(Path::new(path)).is_err(), "{path}");
        }
    }

    #[test]
    fn keeps_existing_proxy_bypass_and_adds_loopback() {
        assert_eq!(
            loopback_no_proxy(Some("example.test, localhost")),
            "example.test,localhost,127.0.0.1,::1"
        );
        assert_eq!(loopback_no_proxy(None), "localhost,127.0.0.1,::1");
    }

    #[cfg(windows)]
    #[test]
    fn rejects_nested_junction_before_creating_runtime_directories() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("app");
        let outside = temporary.path().join("outside");
        std::fs::create_dir_all(root.join("data")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let output = std::process::Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(root.join("data").join("home"))
            .arg(&outside)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "junction creation failed in workspace TEMP: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(create_data_directories(&root).is_err());
        assert!(!outside.join("AppData").exists());
        assert!(!root.join("data/tmp").exists());
    }
}
