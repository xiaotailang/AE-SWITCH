pub use uni_switch_lib::{error, portable};

#[path = "../src/background.rs"]
mod background;

#[cfg(windows)]
mod verification {
    use super::*;
    use std::ptr;
    use windows_sys::Win32::System::Registry::*;

    const RUN_PATH: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    const VALUE_NAME: &str = "AE Switch";
    const OWNER_NAME: &str = "AE Switch QA Owner";

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }

    fn check(status: u32, operation: &str) -> Result<(), String> {
        if status == 0 {
            Ok(())
        } else {
            Err(format!("{operation}: Windows status {status}"))
        }
    }

    fn write(key: HKEY, name: &str, kind: u32, data: &[u8]) -> Result<(), String> {
        let name = wide(name);
        check(
            unsafe {
                RegSetValueExW(
                    key,
                    name.as_ptr(),
                    0,
                    kind,
                    data.as_ptr(),
                    data.len() as u32,
                )
            },
            "write owned fixture",
        )
    }

    fn write_text(key: HKEY, name: &str, value: &str) -> Result<(), String> {
        let data: Vec<u8> = wide(value).into_iter().flat_map(u16::to_le_bytes).collect();
        write(key, name, REG_SZ, &data)
    }

    fn read(key: HKEY, name: &str) -> Result<Option<(u32, Vec<u8>)>, String> {
        let name = wide(name);
        let mut bytes = 0;
        let mut kind = 0;
        let status = unsafe {
            RegQueryValueExW(
                key,
                name.as_ptr(),
                ptr::null(),
                &mut kind,
                ptr::null_mut(),
                &mut bytes,
            )
        };
        if status == 2 {
            return Ok(None);
        }
        check(status, "query owned fixture length")?;
        if bytes > 32768 {
            return Err("owned fixture unexpectedly large".to_owned());
        }
        let mut data = vec![0u8; bytes as usize];
        check(
            unsafe {
                RegQueryValueExW(
                    key,
                    name.as_ptr(),
                    ptr::null(),
                    &mut kind,
                    data.as_mut_ptr(),
                    &mut bytes,
                )
            },
            "query owned fixture value",
        )?;
        data.truncate(bytes as usize);
        Ok(Some((kind, data)))
    }

    fn text_data(value: &str) -> (u32, Vec<u8>) {
        (
            REG_SZ,
            wide(value).into_iter().flat_map(u16::to_le_bytes).collect(),
        )
    }

    fn require(condition: bool, description: &str) -> Result<(), String> {
        if condition {
            Ok(())
        } else {
            Err(description.to_owned())
        }
    }

    struct OwnedRegistry {
        original_root: HKEY,
        root: HKEY,
        run: HKEY,
        name: String,
        owner: String,
        marker_written: bool,
        overridden: bool,
        cleaned: bool,
    }

    impl OwnedRegistry {
        fn create() -> Result<Self, String> {
            let owner = uuid::Uuid::new_v4().simple().to_string();
            let name = format!("AE-Switch-owned-autostart-{owner}");
            let mut original_root = ptr::null_mut();
            check(
                unsafe {
                    RegOpenKeyExW(
                        HKEY_CURRENT_USER,
                        wide("").as_ptr(),
                        0,
                        KEY_ALL_ACCESS,
                        &mut original_root,
                    )
                },
                "retain original current-user handle",
            )?;
            let mut root = ptr::null_mut();
            let mut disposition = 0;
            let status = unsafe {
                RegCreateKeyExW(
                    original_root,
                    wide(&name).as_ptr(),
                    0,
                    ptr::null(),
                    REG_OPTION_VOLATILE,
                    KEY_ALL_ACCESS,
                    ptr::null(),
                    &mut root,
                    &mut disposition,
                )
            };
            if status != 0 || disposition != REG_CREATED_NEW_KEY {
                unsafe {
                    if !root.is_null() {
                        RegCloseKey(root);
                    }
                    RegCloseKey(original_root);
                }
                return Err(format!("new unique volatile key was not created: {status}"));
            }
            let mut owned = Self {
                original_root,
                root,
                run: ptr::null_mut(),
                name,
                owner,
                marker_written: false,
                overridden: false,
                cleaned: false,
            };
            write_text(owned.root, OWNER_NAME, &owned.owner)?;
            owned.marker_written = true;
            check(
                unsafe {
                    RegCreateKeyExW(
                        owned.root,
                        wide(RUN_PATH).as_ptr(),
                        0,
                        ptr::null(),
                        REG_OPTION_VOLATILE,
                        KEY_ALL_ACCESS,
                        ptr::null(),
                        &mut owned.run,
                        ptr::null_mut(),
                    )
                },
                "create volatile replacement Run tree",
            )?;
            check(
                unsafe { RegOverridePredefKey(HKEY_CURRENT_USER, owned.root) },
                "override current-user handle in this helper process",
            )?;
            owned.overridden = true;
            Ok(owned)
        }

        fn cleanup(&mut self) -> Result<(), String> {
            if self.cleaned {
                return Ok(());
            }
            if self.overridden {
                check(
                    unsafe { RegOverridePredefKey(HKEY_CURRENT_USER, ptr::null_mut()) },
                    "restore current-user mapping",
                )?;
                self.overridden = false;
            }
            if self.marker_written {
                require(
                    read(self.root, OWNER_NAME)? == Some(text_data(&self.owner)),
                    "owned registry marker did not match; deletion refused",
                )?;
            }
            if !self.run.is_null() {
                unsafe { RegCloseKey(self.run) };
                self.run = ptr::null_mut();
            }
            check(
                unsafe { RegDeleteTreeW(self.original_root, wide(&self.name).as_ptr()) },
                "delete only newly created owned volatile key",
            )?;
            unsafe { RegCloseKey(self.root) };
            self.root = ptr::null_mut();
            let mut reopened = ptr::null_mut();
            let status = unsafe {
                RegOpenKeyExW(
                    self.original_root,
                    wide(&self.name).as_ptr(),
                    0,
                    KEY_QUERY_VALUE,
                    &mut reopened,
                )
            };
            if !reopened.is_null() {
                unsafe { RegCloseKey(reopened) };
            }
            require(status == 2, "owned registry tree was not removed")?;
            unsafe { RegCloseKey(self.original_root) };
            self.original_root = ptr::null_mut();
            self.cleaned = true;
            Ok(())
        }
    }

    impl Drop for OwnedRegistry {
        fn drop(&mut self) {
            if let Err(error) = self.cleanup() {
                eprintln!("Owned startup verifier cleanup failed: {error}");
            }
        }
    }

    fn exercise(owned: &OwnedRegistry) -> Result<usize, String> {
        let exe = std::env::current_exe().map_err(|_| "current helper path unavailable")?;
        portable::validate_root(&exe).map_err(|e| e.code)?;
        let command = format!("\"{}\" --background", exe.display());
        let mut assertions = 0;
        std::env::set_var("UNI_SWITCH_DATA_DIR", exe.parent().unwrap().join("data"));
        std::env::remove_var("AE_SWITCH_SYSTEM_INTEGRATION_ISOLATED");
        let initial = background::settings().map_err(|e| e.code)?;
        require(
            initial.supported && !initial.enabled,
            "production startup was disabled",
        )?;
        assertions += 1;

        std::env::set_var("AE_SWITCH_SYSTEM_INTEGRATION_ISOLATED", "1");
        let isolated = background::settings().map_err(|e| e.code)?;
        require(
            !isolated.supported && !isolated.enabled,
            "explicit QA was supported",
        )?;
        assertions += 1;
        for enabled in [true, false] {
            let error = background::set(enabled).err();
            require(
                error.is_some_and(|error| error.code == "qa_isolation"),
                "explicit QA setter was not rejected",
            )?;
            assertions += 1;
        }
        require(
            read(owned.run, VALUE_NAME)?.is_none(),
            "QA wrote a startup value",
        )?;
        assertions += 1;
        std::env::remove_var("AE_SWITCH_SYSTEM_INTEGRATION_ISOLATED");

        let legacy = "owned legacy sentinel";
        write_text(owned.run, "uni-switch", legacy)?;
        require(
            background::set(true).map_err(|e| e.code)?.enabled,
            "startup enable failed",
        )?;
        assertions += 1;
        require(
            read(owned.run, VALUE_NAME)? == Some(text_data(&command)),
            "startup command did not target the exact G helper executable",
        )?;
        assertions += 1;
        require(
            background::settings().map_err(|e| e.code)?.enabled,
            "startup readback failed",
        )?;
        assertions += 1;
        require(
            background::set(true).map_err(|e| e.code)?.enabled,
            "repeated enable failed",
        )?;
        assertions += 1;
        require(
            !background::set(false).map_err(|e| e.code)?.enabled,
            "startup disable failed",
        )?;
        assertions += 1;
        require(
            read(owned.run, VALUE_NAME)?.is_none(),
            "owned startup value was not removed",
        )?;
        assertions += 1;
        require(
            !background::set(false).map_err(|e| e.code)?.enabled,
            "repeated disable failed",
        )?;
        assertions += 1;

        for (kind, data) in [
            text_data("\"G:\\owned foreign fixture.exe\" --background"),
            (REG_BINARY, vec![1, 2, 3, 4]),
        ] {
            write(owned.run, VALUE_NAME, kind, &data)?;
            require(
                !background::settings().map_err(|e| e.code)?.enabled,
                "foreign value looked owned",
            )?;
            assertions += 1;
            for enabled in [true, false] {
                let error = background::set(enabled).err();
                require(
                    error.is_some_and(|error| error.code == "startup_conflict"),
                    "foreign startup value was not protected",
                )?;
                assertions += 1;
                require(
                    read(owned.run, VALUE_NAME)? == Some((kind, data.clone())),
                    "foreign startup fixture changed",
                )?;
                assertions += 1;
            }
        }
        require(
            read(owned.run, "uni-switch")? == Some(text_data(legacy)),
            "legacy startup fixture changed",
        )?;
        assertions += 1;
        Ok(assertions)
    }

    pub fn run() -> Result<serde_json::Value, String> {
        if cfg!(feature = "qa-webview") {
            return Err("verifier must be compiled without qa-webview".to_owned());
        }
        let exe = std::env::current_exe().map_err(|_| "current helper path unavailable")?;
        portable::validate_root(&exe).map_err(|e| e.code)?;
        require(
            matches!(exe.components().next(), Some(std::path::Component::Prefix(prefix)) if matches!(prefix.kind(), std::path::Prefix::Disk(drive) | std::path::Prefix::VerbatimDisk(drive) if drive.eq_ignore_ascii_case(&b'G'))),
            "verifier executable must remain on G drive",
        )?;
        let mut owned = OwnedRegistry::create()?;
        let result = exercise(&owned);
        let cleanup = owned.cleanup();
        cleanup?;
        let assertions = result?;
        Ok(serde_json::json!({
            "passed": true,
            "scope": "real Win32 startup APIs in an owned volatile registry tree with process-local HKCU override",
            "uuid": owned.owner,
            "assertions": assertions,
            "productionPortableEnvironmentSupported": true,
            "explicitQaBlocked": true,
            "realApiEnableReadbackDisablePassed": true,
            "foreignValuePreserved": true,
            "legacyValuePreserved": true,
            "startupCommandUsesActualGExecutable": true,
            "hostRunAccessed": false,
            "registryFixtureVolatile": true,
            "currentUserMappingRestored": true,
            "ownedRegistryTreeRemoved": true,
            "actualWindowsLoginTriggered": false
        }))
    }
}

fn main() {
    #[cfg(windows)]
    match verification::run() {
        Ok(result) => println!("{result}"),
        Err(error) => {
            eprintln!("Owned startup verifier failed: {error}");
            std::process::exit(1);
        }
    }
    #[cfg(not(windows))]
    {
        eprintln!("Owned startup verifier requires Windows");
        std::process::exit(1);
    }
}
