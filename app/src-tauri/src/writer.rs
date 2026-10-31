use crate::error::{AppError, Result};
use std::io::Write;
use std::path::Path;

pub fn private_directory(path: &Path) -> Result<()> {
    crate::portable::validate_owned_path(path)?;
    std::fs::create_dir_all(path).map_err(|err| AppError::io(path, err))?;
    crate::portable::validate_owned_path(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|err| AppError::io(path, err))?;
    }
    #[cfg(windows)]
    private_permissions(path)?;
    Ok(())
}

pub(crate) fn private_file_permissions(path: &Path) -> Result<()> {
    #[cfg(windows)]
    private_permissions(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| AppError::io(path, error))?;
    }
    Ok(())
}

#[cfg(windows)]
#[path = "writer/windows_private.rs"]
mod windows_private;
#[cfg(windows)]
fn private_permissions(path: &Path) -> Result<()> {
    windows_private::protect(path)
}

/// Existing private state can carry explicit ACL entries that are not removed
/// by tightening its parent. Harden known credential/recovery files before any
/// database or recovery reader opens them; never recurse into native profiles.
pub(crate) fn protect_existing_private_state(root: &Path) -> Result<()> {
    for entry in std::fs::read_dir(root).map_err(|error| AppError::io(root, error))? {
        let entry = entry.map_err(|error| AppError::io(root, error))?;
        let path = entry.path();
        // Windows resolves these names without regard to casing. A renamed
        // database or an interrupted ownership journal must not retain an
        // explicit public ACE merely because its on-disk spelling differs.
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        let private_json = name.ends_with(".json") || name.ends_with(".json.pending");
        let sensitive = name.starts_with("uni-switch.db")
            || name.starts_with("agent-") && private_json
            || name.starts_with("config-profiles") && private_json
            || matches!(
                name.as_str(),
                "runtime-integrity.key" | "protocol-bridge.json"
            );
        if sensitive {
            crate::portable::validate_owned_path(&path)?;
            crate::portable::validate_root(&path)?;
            if !entry
                .file_type()
                .map_err(|error| AppError::io(&path, error))?
                .is_file()
            {
                return Err(AppError::new(
                    "permissions",
                    "私有恢复数据不是普通文件，未读取或修改客户端",
                ));
            }
            private_file_permissions(&path)?;
        }
    }
    Ok(())
}

pub fn write(path: &Path, content: Option<&str>) -> Result<()> {
    write_with_validation(path, content, crate::portable::validate_owned_path)
}

/// Native client configuration requires an expected snapshot and a guard that
/// stays active through persistence. On Windows a non-sharing file handle
/// prevents writes, deletion and replacement by other processes. Native writes
/// use the caller's durable transaction journal rather than releasing that
/// handle for a rename (which would reopen the original race).
pub(crate) fn write_native_checked(
    path: &Path,
    expected: Option<&str>,
    content: Option<&str>,
    validate: impl Fn(&Path) -> Result<()>,
) -> Result<()> {
    #[cfg(windows)]
    return windows_native::write(path, expected, content, validate);
    #[cfg(not(windows))]
    {
        // Non-Windows native acceptance remains separately gated. Preserve the
        // snapshot precondition even when the OS sharing guard is unavailable.
        write_with_validation(path, content, |target| {
            validate(target)?;
            let current = match std::fs::read_to_string(target) {
                Ok(text) => Some(text),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(AppError::io(target, error)),
            };
            if current.as_deref() != expected {
                return Err(native_conflict());
            }
            Ok(())
        })
    }
}

fn native_conflict() -> AppError {
    AppError::new(
        "agent_configuration_changed",
        "客户端配置正在使用或已被修改，外部修改未覆盖，请关闭客户端后重新预览",
    )
}

#[cfg(windows)]
#[path = "writer/windows_native.rs"]
mod windows_native;

/// Reuse atomic persistence for an explicitly authorized native file. The
/// caller's validator must grant the exact file and reject unsafe ancestors;
/// ordinary AE writes keep `validate_owned_path` through `write` above.
pub(crate) fn write_with_validation(
    path: &Path,
    content: Option<&str>,
    validate: impl Fn(&Path) -> Result<()>,
) -> Result<()> {
    validate(path)?;
    if std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(AppError::new(
            "symlink",
            format!("{} 是符号链接，请直接选择实际配置目录", path.display()),
        ));
    }
    let Some(content) = content else {
        return match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(AppError::io(path, err)),
        };
    };
    let parent = path
        .parent()
        .ok_or_else(|| AppError::new("invalid_path", "配置文件缺少父目录"))?;
    std::fs::create_dir_all(parent).map_err(|err| AppError::io(parent, err))?;
    validate(path)?;
    let mut temp =
        tempfile::NamedTempFile::new_in(parent).map_err(|err| AppError::io(parent, err))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temp.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|err| AppError::io(path, err))?;
    }
    #[cfg(windows)]
    private_permissions(temp.path())?;
    temp.write_all(content.as_bytes())
        .map_err(|err| AppError::io(path, err))?;
    temp.as_file()
        .sync_all()
        .map_err(|err| AppError::io(path, err))?;
    validate(path)?;
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let source: Vec<u16> = temp
            .path()
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        let destination: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(AppError::io(path, std::io::Error::last_os_error()));
        }
    }
    #[cfg(not(windows))]
    {
        temp.persist(path)
            .map_err(|err| AppError::io(path, err.error))?;
        std::fs::File::open(parent)
            .and_then(|file| file.sync_all())
            .map_err(|err| AppError::io(parent, err))?;
    }
    Ok(())
}
