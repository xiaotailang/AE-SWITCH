use super::*;

const COMMAND: &str = "\"G:\\应用工作区\\AE Switch\\AE-Switch.exe\" --background";

#[derive(Default)]
struct MemoryStore {
    value: Option<StartupValue>,
    reads: usize,
    writes: usize,
    removals: usize,
    ignore_write: bool,
    deny_write: bool,
    legacy_value: Option<String>,
}

impl StartupStore for MemoryStore {
    fn read(&mut self) -> Result<Option<StartupValue>> {
        self.reads += 1;
        Ok(self.value.clone())
    }

    fn write(&mut self, command: &str) -> Result<()> {
        self.writes += 1;
        if self.deny_write {
            return Err(AppError::new("startup_write", "test write denied"));
        }
        if !self.ignore_write {
            self.value = Some(StartupValue::Command(command.to_owned()));
        }
        Ok(())
    }

    fn remove(&mut self) -> Result<()> {
        self.removals += 1;
        self.value = None;
        Ok(())
    }
}

#[test]
fn production_portable_data_environment_does_not_disable_startup() {
    let isolated = isolated_with(false, |name| name == "UNI_SWITCH_DATA_DIR");
    assert!(!isolated);
    let mut store = MemoryStore::default();
    assert_eq!(
        settings_with(&mut store, COMMAND, isolated).unwrap(),
        BackgroundSettings {
            supported: true,
            enabled: false,
        }
    );
    assert!(
        set_with(&mut store, COMMAND, true, isolated)
            .unwrap()
            .enabled
    );
    assert_eq!(store.value, Some(StartupValue::Command(COMMAND.to_owned())));
}

#[test]
fn explicit_qa_marker_prevents_registry_reads_and_writes() {
    let isolated = isolated_with(false, |name| name == ISOLATION_ENV);
    assert!(isolated);
    let mut store = MemoryStore::default();
    assert_eq!(
        settings_with(&mut store, COMMAND, isolated).unwrap(),
        disabled_settings()
    );
    for enabled in [true, false] {
        assert_eq!(
            set_with(&mut store, COMMAND, enabled, isolated)
                .unwrap_err()
                .code,
            "qa_isolation"
        );
    }
    assert_eq!((store.reads, store.writes, store.removals), (0, 0, 0));
}

#[test]
fn qa_webview_build_is_isolated_without_any_environment_marker() {
    assert!(isolated_with(true, |_| false));
}

#[test]
fn own_startup_entry_round_trips_and_disable_removes_only_that_entry() {
    let mut store = MemoryStore {
        legacy_value: Some("other legacy program".to_owned()),
        ..MemoryStore::default()
    };
    assert_eq!(STARTUP_VALUE_NAME, "AE Switch");
    assert!(set_with(&mut store, COMMAND, true, false).unwrap().enabled);
    assert!(settings_with(&mut store, COMMAND, false).unwrap().enabled);
    assert!(!set_with(&mut store, COMMAND, false, false).unwrap().enabled);
    assert_eq!(store.value, None);
    assert_eq!((store.writes, store.removals), (1, 1));
    assert_eq!(store.legacy_value.as_deref(), Some("other legacy program"));
}

#[test]
fn absent_or_already_enabled_entry_is_idempotent() {
    let mut store = MemoryStore::default();
    assert!(!set_with(&mut store, COMMAND, false, false).unwrap().enabled);
    assert_eq!((store.writes, store.removals), (0, 0));
    store.value = Some(StartupValue::Command(COMMAND.to_owned()));
    assert!(set_with(&mut store, COMMAND, true, false).unwrap().enabled);
    assert_eq!((store.writes, store.removals), (0, 0));
}

#[test]
fn foreign_or_unknown_typed_entry_is_never_overwritten_or_deleted() {
    for value in [
        StartupValue::Command("\"C:\\other.exe\" --background".to_owned()),
        StartupValue::Command("\"G:\\old-version.exe\" --background".to_owned()),
        StartupValue::Other,
    ] {
        let mut store = MemoryStore {
            value: Some(value.clone()),
            ..MemoryStore::default()
        };
        assert!(!settings_with(&mut store, COMMAND, false).unwrap().enabled);
        for enabled in [true, false] {
            assert_eq!(
                set_with(&mut store, COMMAND, enabled, false)
                    .unwrap_err()
                    .code,
                "startup_conflict"
            );
            assert_eq!(store.value, Some(value.clone()));
        }
        assert_eq!((store.writes, store.removals), (0, 0));
    }
}

#[test]
fn failed_write_does_not_report_success() {
    let mut store = MemoryStore {
        deny_write: true,
        ..MemoryStore::default()
    };
    assert_eq!(
        set_with(&mut store, COMMAND, true, false).unwrap_err().code,
        "startup_write"
    );
    assert_eq!(store.value, None);
    assert_eq!(store.removals, 0);
}

#[test]
fn missing_readback_does_not_report_success() {
    let mut store = MemoryStore {
        ignore_write: true,
        ..MemoryStore::default()
    };
    assert_eq!(
        set_with(&mut store, COMMAND, true, false).unwrap_err().code,
        "startup_readback"
    );
}

#[cfg(windows)]
#[test]
fn unicode_and_spaces_are_quoted_in_background_command() {
    assert_eq!(
        command_for(std::path::Path::new(
            r"G:\应用工作区\AE Switch\AE-Switch.exe"
        ))
        .unwrap(),
        COMMAND
    );
}

#[cfg(windows)]
#[test]
fn startup_command_rejects_unc_and_path_traversal() {
    for path in [
        r"\\host\share\AE-Switch.exe",
        r"G:\workspace\..\AE-Switch.exe",
        "G:\\workspace\\bad\"program.exe",
    ] {
        assert!(command_for(std::path::Path::new(path)).is_err(), "{path}");
    }
}

#[cfg(windows)]
#[test]
fn startup_command_accepts_local_c_drive() {
    // Construct the command only; no executable or startup entry is created.
    let path = r"C:\AE Switch\AE-Switch.exe";
    assert_eq!(
        command_for(std::path::Path::new(path)).unwrap(),
        format!("\"{path}\" --background")
    );
}
