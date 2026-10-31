use super::*;
use std::{
    fs::OpenOptions,
    io::{Read, Seek, SeekFrom},
    os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
};
use windows_sys::Win32::Storage::FileSystem::{
    FileDispositionInfo, SetFileInformationByHandle, FILE_DISPOSITION_INFO,
    FILE_FLAG_OPEN_REPARSE_POINT,
};

#[cfg(test)]
type LockHook = Option<Box<dyn FnOnce(&Path)>>;
#[cfg(test)]
thread_local! {
    static AFTER_LOCK: std::cell::RefCell<LockHook> = const { std::cell::RefCell::new(None) };
}

pub(super) fn write(
    path: &Path,
    expected: Option<&str>,
    content: Option<&str>,
    validate: impl Fn(&Path) -> Result<()>,
) -> Result<()> {
    validate(path)?;
    if expected.is_none() && content.is_none() {
        return if path
            .try_exists()
            .map_err(|error| AppError::io(path, error))?
        {
            Err(native_conflict())
        } else {
            Ok(())
        };
    }
    let parent = path.parent().ok_or_else(native_conflict)?;
    std::fs::create_dir_all(parent).map_err(|error| AppError::io(parent, error))?;
    validate(path)?;
    let mut options = OpenOptions::new();
    // DELETE access is required for handle-bound deletion. No sharing means
    // even an editor's atomic replace cannot remove our authorized target.
    options
        .read(true)
        .write(true)
        .access_mode(0x8000_0000 | 0x4000_0000 | 0x0001_0000)
        .share_mode(0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    if expected.is_none() {
        options.create_new(true);
    }
    let mut file = options.open(path).map_err(|error| {
        if matches!(
            error.kind(),
            std::io::ErrorKind::PermissionDenied
                | std::io::ErrorKind::AlreadyExists
                | std::io::ErrorKind::NotFound
        ) || matches!(error.raw_os_error(), Some(32 | 33))
        {
            native_conflict()
        } else {
            AppError::io(path, error)
        }
    })?;
    let metadata = file.metadata().map_err(|error| AppError::io(path, error))?;
    use std::os::windows::fs::MetadataExt;
    if !metadata.is_file()
        || metadata.file_attributes() & 0x400 != 0
        || metadata.len() > 32 * 1024 * 1024
    {
        return Err(native_conflict());
    }
    let mut before = Vec::new();
    file.read_to_end(&mut before)
        .map_err(|error| AppError::io(path, error))?;
    if expected.is_some_and(|expected| before != expected.as_bytes()) {
        return Err(native_conflict());
    }
    crate::portable::validate_root(path)?;
    #[cfg(test)]
    AFTER_LOCK.with(|hook| {
        if let Some(hook) = hook.borrow_mut().take() {
            hook(path);
        }
    });
    if let Some(content) = content {
        let result = (|| {
            file.seek(SeekFrom::Start(0))?;
            file.write_all(content.as_bytes())?;
            file.set_len(content.len() as u64)?;
            file.sync_all()?;
            file.seek(SeekFrom::Start(0))?;
            let mut checked = Vec::new();
            file.read_to_end(&mut checked)?;
            if checked != content.as_bytes() {
                return Err(std::io::Error::other("native readback mismatch"));
            }
            Ok(())
        })();
        if let Err(error) = result {
            // The same exclusive handle still owns the exact checked object.
            // Restore before releasing it; the durable journal remains the
            // fallback if the filesystem cannot complete this recovery.
            if file
                .seek(SeekFrom::Start(0))
                .and_then(|_| file.write_all(&before))
                .and_then(|_| file.set_len(before.len() as u64))
                .and_then(|_| file.sync_all())
                .is_err()
            {
                return Err(AppError::new(
                    "recovery_required",
                    "客户端写入未能完成，原配置事务备份已保留，请关闭客户端后恢复",
                ));
            }
            return Err(AppError::io(path, error));
        }
    } else {
        let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
        if unsafe {
            SetFileInformationByHandle(
                file.as_raw_handle(),
                FileDispositionInfo,
                (&disposition as *const FILE_DISPOSITION_INFO).cast(),
                std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        } == 0
        {
            return Err(AppError::io(path, std::io::Error::last_os_error()));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exclusive_snapshot_guard_rejects_writes_replacement_and_stale_contents() {
        let directory = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
        let path = directory.path().join("native.json");
        std::fs::write(&path, "before").unwrap();
        AFTER_LOCK.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(|target| {
                assert!(std::fs::write(target, "external").is_err());
                let alternative = target.with_extension("replacement");
                std::fs::write(&alternative, "external replacement").unwrap();
                assert!(std::fs::rename(&alternative, target).is_err());
                assert!(std::fs::remove_file(target).is_err());
            }))
        });
        write(&path, Some("before"), Some("after"), |_| Ok(())).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "after");
        assert_eq!(
            write(&path, Some("before"), Some("bad"), |_| Ok(()))
                .unwrap_err()
                .code,
            "agent_configuration_changed"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "after");
        write(&path, Some("after"), None, |_| Ok(())).unwrap();
        assert!(!path.exists());
        write(&path, None, Some("new"), |_| Ok(())).unwrap();
        assert_eq!(
            write(&path, None, Some("overwrite"), |_| Ok(()))
                .unwrap_err()
                .code,
            "agent_configuration_changed"
        );
    }
}
