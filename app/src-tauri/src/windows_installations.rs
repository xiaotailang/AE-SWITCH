//! Bounded, read-only Windows installation metadata. No client or uninstaller is run.

use crate::agent_configs::AgentId;
use std::{
    collections::{BTreeMap, HashSet},
    ffi::OsString,
    path::{Component, Path, PathBuf},
};
#[cfg(not(test))]
use windows_sys::Win32::{
    Foundation::{ERROR_FILE_NOT_FOUND, ERROR_NO_MORE_ITEMS, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS},
    System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER,
        HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY, REG_EXPAND_SZ, REG_SZ,
    },
};

#[cfg(not(test))]
const MAX_UNINSTALL_KEYS: u32 = 1024;
const MAX_HINTS: usize = 128;
const MAX_VALUE_UNITS: usize = 4096;
#[cfg(not(test))]
const UNINSTALL: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
#[cfg(not(test))]
const APP_PATHS: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths";

pub(crate) type InstallationHint = (AgentId, PathBuf, &'static str);

#[cfg(not(test))]
struct Key(HKEY);
#[cfg(not(test))]
impl Drop for Key {
    fn drop(&mut self) {
        // SAFETY: this handle was returned by a successful RegOpenKeyExW and is owned here.
        unsafe { RegCloseKey(self.0) };
    }
}

#[cfg(not(test))]
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

#[cfg(not(test))]
fn open(parent: HKEY, name: &str, view: u32, limited: &mut bool) -> Option<Key> {
    let mut handle = std::ptr::null_mut();
    // SAFETY: the name is NUL terminated; the output handle has valid writable storage.
    let status =
        unsafe { RegOpenKeyExW(parent, wide(name).as_ptr(), 0, KEY_READ | view, &mut handle) };
    if status == ERROR_SUCCESS {
        Some(Key(handle))
    } else {
        if ![ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND].contains(&status) {
            *limited = true;
        }
        None
    }
}

#[cfg(not(test))]
fn value(key: &Key, name: &str, limited: &mut bool) -> Option<String> {
    let mut data = [0u16; MAX_VALUE_UNITS];
    let mut bytes = (data.len() * 2) as u32;
    let mut kind = 0;
    // SAFETY: data is an aligned writable UTF-16 buffer, with its byte capacity supplied.
    let status = unsafe {
        RegQueryValueExW(
            key.0,
            wide(name).as_ptr(),
            std::ptr::null(),
            &mut kind,
            data.as_mut_ptr().cast(),
            &mut bytes,
        )
    };
    if status == ERROR_FILE_NOT_FOUND {
        return None;
    }
    if status != ERROR_SUCCESS
        || bytes < 2
        || bytes as usize > data.len() * 2
        || !bytes.is_multiple_of(2)
    {
        *limited = true;
        return None;
    }
    if kind != REG_SZ && kind != REG_EXPAND_SZ {
        return None;
    }
    let units = bytes as usize / 2;
    if data[units - 1] != 0 || data[..units - 1].contains(&0) {
        *limited = true;
        return None;
    }
    let text = String::from_utf16(&data[..units - 1]).ok()?;
    if kind == REG_EXPAND_SZ {
        // Portable bootstrap may already have rewritten LOCALAPPDATA/HOME.
        // Expand installation paths only against the captured original path variables.
        let expanded = expand_environment(&text, crate::agent_discovery::original_environment());
        if expanded.is_none() {
            *limited = true;
        }
        expanded
    } else {
        Some(text)
    }
}

fn expand_environment(text: &str, environment: &BTreeMap<String, OsString>) -> Option<String> {
    let mut remaining = text;
    let mut expanded = String::new();
    while let Some(start) = remaining.find('%') {
        expanded.push_str(&remaining[..start]);
        remaining = &remaining[start + 1..];
        let end = remaining.find('%')?;
        let name = &remaining[..end];
        let value = environment
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))?
            .1
            .to_str()?;
        if value.chars().any(char::is_control) {
            return None;
        }
        expanded.push_str(value);
        remaining = &remaining[end + 1..];
        if expanded.encode_utf16().count() >= MAX_VALUE_UNITS {
            return None;
        }
    }
    expanded.push_str(remaining);
    (expanded.encode_utf16().count() < MAX_VALUE_UNITS).then_some(expanded)
}

fn product(name: &str) -> Option<AgentId> {
    let name = name.trim().to_ascii_lowercase();
    for (label, agent) in [
        ("zcode", AgentId::Zcode),
        ("z code", AgentId::Zcode),
        ("workbuddy", AgentId::WorkBuddy),
    ] {
        if name == label {
            return Some(agent);
        }
        if let Some(version) = name
            .strip_prefix(label)
            .and_then(|suffix| suffix.strip_prefix(' '))
        {
            let version = version.strip_prefix('v').unwrap_or(version);
            if version.starts_with(|c: char| c.is_ascii_digit())
                && version
                    .chars()
                    .all(|c| c.is_ascii_digit() || matches!(c, '.' | '-' | '+'))
            {
                return Some(agent);
            }
        }
    }
    None
}

fn ordinary_local(path: &Path, directory: bool) -> bool {
    use std::os::windows::fs::MetadataExt;
    if !path.is_absolute()
        || path.to_string_lossy().chars().any(char::is_control)
        || path
            .components()
            .any(|p| matches!(p, Component::ParentDir | Component::CurDir))
        || path.components().any(|p| {
            matches!(p, Component::Normal(name) if name.to_string_lossy().ends_with(['.', ' ']) || name.to_string_lossy().contains(':'))
        })
        || !matches!(path.components().next(), Some(Component::Prefix(p)) if matches!(p.kind(), std::path::Prefix::Disk(_)))
    {
        return false;
    }
    let mut current = PathBuf::new();
    for part in path.components() {
        current.push(part);
        let Ok(metadata) = std::fs::symlink_metadata(&current) else {
            return false;
        };
        if metadata.file_attributes() & 0x400 != 0 || metadata.file_type().is_symlink() {
            return false;
        }
    }
    std::fs::metadata(path).is_ok_and(|m| if directory { m.is_dir() } else { m.is_file() })
}

fn command_path(text: &str, icon: bool) -> Option<PathBuf> {
    let text = text.trim();
    let path = if let Some(quoted) = text.strip_prefix('"') {
        &quoted[..quoted.find('"')?]
    } else if icon {
        text.rsplit_once(',')
            .filter(|(_, index)| index.trim().parse::<i32>().is_ok())
            .map_or(text, |(path, _)| path)
    } else {
        let end = text.to_ascii_lowercase().find(".exe")? + 4;
        &text[..end]
    };
    let path = PathBuf::from(path);
    ordinary_local(&path, false).then_some(path)
}

fn add_directory(
    agent: AgentId,
    directory: &Path,
    source: &'static str,
    result: &mut Vec<InstallationHint>,
    seen: &mut HashSet<(&'static str, PathBuf)>,
    limited: &mut bool,
) {
    if !ordinary_local(directory, true) {
        return;
    }
    for suffix in ["exe", "ps1", "cmd", "bat"] {
        let entry = directory.join(format!("{}.{}", agent.command(), suffix));
        if ordinary_local(&entry, false) && seen.insert((agent.as_str(), entry.clone())) {
            if result.len() == MAX_HINTS {
                *limited = true;
                return;
            }
            result.push((agent, entry, source));
        }
    }
}

#[cfg(not(test))]
pub(crate) fn discover() -> (Vec<InstallationHint>, bool) {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    let mut limited = false;
    for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
            if let Some(root) = open(hive, UNINSTALL, view, &mut limited) {
                for index in 0..=MAX_UNINSTALL_KEYS {
                    let mut name = [0u16; 256];
                    let mut length = name.len() as u32;
                    // SAFETY: only one subkey name is read into the bounded writable buffer.
                    let status = unsafe {
                        RegEnumKeyExW(
                            root.0,
                            index,
                            name.as_mut_ptr(),
                            &mut length,
                            std::ptr::null(),
                            std::ptr::null_mut(),
                            std::ptr::null_mut(),
                            std::ptr::null_mut(),
                        )
                    };
                    if status == ERROR_NO_MORE_ITEMS {
                        break;
                    }
                    if index == MAX_UNINSTALL_KEYS || status != ERROR_SUCCESS {
                        limited = true;
                        break;
                    }
                    let Ok(name) = String::from_utf16(&name[..length as usize]) else {
                        limited = true;
                        continue;
                    };
                    let Some(key) = open(root.0, &name, view, &mut limited) else {
                        continue;
                    };
                    let Some(agent) =
                        value(&key, "DisplayName", &mut limited).and_then(|name| product(&name))
                    else {
                        continue;
                    };
                    if let Some(path) = value(&key, "InstallLocation", &mut limited) {
                        add_directory(
                            agent,
                            Path::new(path.trim().trim_matches('"')),
                            "windows-uninstall",
                            &mut result,
                            &mut seen,
                            &mut limited,
                        );
                    }
                    for (field, icon) in [("DisplayIcon", true), ("UninstallString", false)] {
                        if let Some(path) = value(&key, field, &mut limited)
                            .and_then(|text| command_path(&text, icon))
                        {
                            if let Some(directory) = path.parent() {
                                add_directory(
                                    agent,
                                    directory,
                                    "windows-uninstall",
                                    &mut result,
                                    &mut seen,
                                    &mut limited,
                                );
                            }
                        }
                    }
                }
            }
            for agent in [AgentId::Zcode, AgentId::WorkBuddy] {
                let subkey = format!("{APP_PATHS}\\{}.exe", agent.command());
                if let Some(key) = open(hive, &subkey, view, &mut limited) {
                    if let Some(path) =
                        value(&key, "", &mut limited).and_then(|text| command_path(&text, false))
                    {
                        if let Some(directory) = path.parent() {
                            add_directory(
                                agent,
                                directory,
                                "windows-app-paths",
                                &mut result,
                                &mut seen,
                                &mut limited,
                            );
                        }
                    }
                }
            }
        }
    }
    (result, limited)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn product_names_accept_versions_but_not_arbitrary_prefix_matches() {
        assert_eq!(product("ZCode 3.15.3"), Some(AgentId::Zcode));
        assert_eq!(product("zcode v3.15.3"), Some(AgentId::Zcode));
        assert_eq!(product("ZCode Fake"), None);
        assert_eq!(product("ZCode123"), None);
        assert_eq!(product("Uninstall ZCode"), None);
        assert_eq!(product("Claude"), None);
        assert_eq!(product("Codex"), None);
        assert_eq!(product("OpenCode"), None);
    }

    #[test]
    fn registry_paths_expand_original_user_environment_and_reject_unknown_variables() {
        let environment = BTreeMap::from([(
            "LOCALAPPDATA".into(),
            OsString::from("G:\\original-user\\Local"),
        )]);
        assert_eq!(
            expand_environment("%localappdata%\\Programs\\ZCode", &environment).as_deref(),
            Some("G:\\original-user\\Local\\Programs\\ZCode")
        );
        assert!(expand_environment("%UNKNOWN%\\ZCode", &environment).is_none());
        assert!(expand_environment("%LOCALAPPDATA\\ZCode", &environment).is_none());
    }

    #[test]
    fn icon_and_quoted_uninstaller_supply_only_the_expected_client_entry() {
        let root = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
        let install = root.path().join("custom install 中文");
        std::fs::create_dir(&install).unwrap();
        let icon = install.join("uninstallerIcon.ico");
        let uninstall = install.join("Uninstall ZCode.exe");
        let client = install.join("zcode.exe");
        for path in [&icon, &uninstall, &client] {
            std::fs::write(path, b"Never execute this discovery fixture").unwrap()
        }
        let mut result = Vec::new();
        let mut seen = HashSet::new();
        let mut limited = false;
        for (text, is_icon) in [
            (format!("{},0", icon.display()), true),
            (format!("\"{}\" /currentuser", uninstall.display()), false),
        ] {
            let hint = command_path(&text, is_icon).unwrap();
            add_directory(
                AgentId::Zcode,
                hint.parent().unwrap(),
                "windows-uninstall",
                &mut result,
                &mut seen,
                &mut limited,
            );
        }
        assert_eq!(result, vec![(AgentId::Zcode, client, "windows-uninstall")]);
        assert!(!limited);
        assert!(command_path("\\\\server\\share\\Uninstall.exe /x", false).is_none());
        assert_eq!(std::fs::read_dir(&install).unwrap().count(), 3);
    }
}
