use crate::error::{AppError, Result};
use serde::Serialize;

const ISOLATION_ENV: &str = "AE_SWITCH_SYSTEM_INTEGRATION_ISOLATED";
#[cfg(any(windows, test))]
const STARTUP_VALUE_NAME: &str = "AE Switch";

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundSettings {
    pub supported: bool,
    pub enabled: bool,
}

fn isolated_with(qa_build: bool, has_variable: impl FnOnce(&str) -> bool) -> bool {
    qa_build || has_variable(ISOLATION_ENV)
}

fn isolated() -> bool {
    isolated_with(cfg!(feature = "qa-webview"), |name| {
        std::env::var_os(name).is_some()
    })
}

fn disabled_settings() -> BackgroundSettings {
    BackgroundSettings {
        supported: false,
        enabled: false,
    }
}

fn isolation_error() -> AppError {
    AppError::new("qa_isolation", "隔离测试不会修改系统启动项")
}

pub fn settings() -> Result<BackgroundSettings> {
    if isolated() {
        return Ok(disabled_settings());
    }
    #[cfg(windows)]
    {
        settings_with(&mut windows::StartupRegistry, &command()?, false)
    }
    #[cfg(not(windows))]
    {
        Ok(disabled_settings())
    }
}

pub fn set(enabled: bool) -> Result<BackgroundSettings> {
    if isolated() {
        return Err(isolation_error());
    }
    #[cfg(windows)]
    {
        set_with(&mut windows::StartupRegistry, &command()?, enabled, false)
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Err(AppError::new(
            "unsupported_platform",
            "当前平台暂不支持系统后台启动",
        ))
    }
}

#[cfg(any(windows, test))]
#[derive(Clone, Debug, PartialEq)]
enum StartupValue {
    Command(String),
    Other,
}

#[cfg(any(windows, test))]
trait StartupStore {
    fn read(&mut self) -> Result<Option<StartupValue>>;
    fn write(&mut self, command: &str) -> Result<()>;
    fn remove(&mut self) -> Result<()>;
}

#[cfg(any(windows, test))]
fn settings_with(
    store: &mut impl StartupStore,
    command: &str,
    isolated: bool,
) -> Result<BackgroundSettings> {
    if isolated {
        return Ok(disabled_settings());
    }
    Ok(BackgroundSettings {
        supported: true,
        enabled: store.read()? == Some(StartupValue::Command(command.to_owned())),
    })
}

#[cfg(any(windows, test))]
fn set_with(
    store: &mut impl StartupStore,
    command: &str,
    enabled: bool,
    isolated: bool,
) -> Result<BackgroundSettings> {
    if isolated {
        return Err(isolation_error());
    }
    let current = store.read()?;
    if current
        .as_ref()
        .is_some_and(|value| value != &StartupValue::Command(command.to_owned()))
    {
        return Err(AppError::new(
            "startup_conflict",
            "同名启动项属于其他程序或程序位置已改变，未覆盖或删除",
        ));
    }
    if enabled && current.is_none() {
        store.write(command)?;
    } else if !enabled && current.is_some() {
        store.remove()?;
    }
    let settings = settings_with(store, command, false)?;
    if settings.enabled != enabled {
        return Err(AppError::new(
            "startup_readback",
            "后台启动设置写入后的核对失败，请重新读取设置",
        ));
    }
    Ok(settings)
}

#[cfg(windows)]
fn command_for(exe: &std::path::Path) -> Result<String> {
    crate::portable::validate_root(exe)?;
    let path = exe
        .to_str()
        .filter(|path| !path.contains(['"', '\r', '\n', '\0']))
        .ok_or_else(|| AppError::new("startup_path", "应用路径无法作为启动项使用"))?;
    Ok(format!("\"{path}\" --background"))
}

#[cfg(windows)]
fn command() -> Result<String> {
    let exe =
        std::env::current_exe().map_err(|_| AppError::new("startup_path", "无法确定应用位置"))?;
    if !exe.is_file() {
        return Err(AppError::new("startup_path", "应用启动程序不存在"));
    }
    command_for(&exe)
}

#[cfg(windows)]
mod windows {
    use super::*;
    use windows_sys::Win32::System::Registry::*;
    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }
    struct Key(HKEY);
    impl Drop for Key {
        fn drop(&mut self) {
            unsafe {
                RegCloseKey(self.0);
            }
        }
    }
    fn open(write: bool) -> Result<Option<Key>> {
        let mut key = std::ptr::null_mut();
        let path = wide("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
        let status = if write {
            unsafe {
                RegCreateKeyExW(
                    HKEY_CURRENT_USER,
                    path.as_ptr(),
                    0,
                    std::ptr::null(),
                    REG_OPTION_NON_VOLATILE,
                    KEY_QUERY_VALUE | KEY_SET_VALUE,
                    std::ptr::null(),
                    &mut key,
                    std::ptr::null_mut(),
                )
            }
        } else {
            unsafe {
                RegOpenKeyExW(
                    HKEY_CURRENT_USER,
                    path.as_ptr(),
                    0,
                    KEY_QUERY_VALUE,
                    &mut key,
                )
            }
        };
        if !write && status == 2 {
            return Ok(None);
        }
        if status != 0 {
            return Err(AppError::new(
                "startup_permission",
                "无法访问当前用户的启动项，请检查系统权限",
            ));
        }
        Ok(Some(Key(key)))
    }

    pub(super) struct StartupRegistry;

    impl StartupStore for StartupRegistry {
        fn read(&mut self) -> Result<Option<StartupValue>> {
            let Some(key) = open(false)? else {
                return Ok(None);
            };
            let mut bytes = 0;
            let mut kind = 0;
            let name = wide(STARTUP_VALUE_NAME);
            let status = unsafe {
                RegQueryValueExW(
                    key.0,
                    name.as_ptr(),
                    std::ptr::null(),
                    &mut kind,
                    std::ptr::null_mut(),
                    &mut bytes,
                )
            };
            if status == 2 {
                return Ok(None);
            }
            if status != 0 || bytes > 32768 {
                return Err(AppError::new("startup_read", "系统启动项无法读取"));
            }
            if kind != REG_SZ || bytes == 0 || bytes % 2 != 0 {
                return Ok(Some(StartupValue::Other));
            }
            let mut data = vec![0u16; (bytes as usize).div_ceil(2)];
            let status = unsafe {
                RegQueryValueExW(
                    key.0,
                    name.as_ptr(),
                    std::ptr::null(),
                    &mut kind,
                    data.as_mut_ptr().cast(),
                    &mut bytes,
                )
            };
            if status != 0 {
                return Err(AppError::new("startup_read", "系统启动项无法读取"));
            }
            if kind != REG_SZ || bytes % 2 != 0 {
                return Ok(Some(StartupValue::Other));
            }
            data.truncate(bytes as usize / 2);
            let value = String::from_utf16(&data)
                .map_err(|_| AppError::new("startup_read", "系统启动项包含无效路径"))?
                .trim_end_matches('\0')
                .to_owned();
            Ok(Some(StartupValue::Command(value)))
        }

        fn write(&mut self, command: &str) -> Result<()> {
            let key =
                open(true)?.ok_or_else(|| AppError::new("startup_write", "系统启动项无法访问"))?;
            let name = wide(STARTUP_VALUE_NAME);
            let value = wide(command);
            let status = unsafe {
                RegSetValueExW(
                    key.0,
                    name.as_ptr(),
                    0,
                    REG_SZ,
                    value.as_ptr().cast(),
                    (value.len() * 2) as u32,
                )
            };
            if status != 0 {
                return Err(AppError::new(
                    "startup_write",
                    "后台启动设置未保存，请检查系统权限",
                ));
            }
            Ok(())
        }

        fn remove(&mut self) -> Result<()> {
            let key =
                open(true)?.ok_or_else(|| AppError::new("startup_write", "系统启动项无法访问"))?;
            let name = wide(STARTUP_VALUE_NAME);
            let status = unsafe { RegDeleteValueW(key.0, name.as_ptr()) };
            if status != 0 && status != 2 {
                return Err(AppError::new(
                    "startup_write",
                    "后台启动设置未保存，请检查系统权限",
                ));
            }
            Ok(())
        }
    }
}

#[cfg(test)]
#[path = "background/tests.rs"]
mod tests;
