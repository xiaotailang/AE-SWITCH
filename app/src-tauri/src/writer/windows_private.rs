//! Replace, rather than merge, a private object's ACL using the process token SID.
use super::*;
use std::{ffi::c_void, os::windows::ffi::OsStrExt, ptr};
use windows_sys::Win32::{
    Foundation::{CloseHandle, LocalFree, HANDLE},
    Security::{
        Authorization::{
            GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W,
            SET_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_W,
        },
        EqualSid, GetAce, GetSecurityDescriptorControl, GetTokenInformation, TokenUser,
        ACCESS_ALLOWED_ACE, ACL, DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
        SE_DACL_PROTECTED, TOKEN_QUERY, TOKEN_USER,
    },
    Storage::FileSystem::FILE_ALL_ACCESS,
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

struct Token(HANDLE);
impl Drop for Token {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
struct Local(*mut c_void);
impl Drop for Local {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}
fn failure() -> AppError {
    AppError::new(
        "permissions",
        "无法确认当前用户的私有数据权限，已停止读取或写入",
    )
}

pub(super) fn protect(path: &Path) -> Result<()> {
    crate::portable::validate_root(path)?;
    let mut handle = ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut handle) } == 0 {
        return Err(failure());
    }
    let token = Token(handle);
    let mut length = 0;
    unsafe {
        GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut length);
    }
    if length == 0 || length > 65536 {
        return Err(failure());
    }
    // Machine-word storage meets TOKEN_USER's alignment requirement.
    let mut buffer = vec![0usize; (length as usize).div_ceil(std::mem::size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            length,
            &mut length,
        )
    } == 0
    {
        return Err(failure());
    }
    let sid = unsafe { (*(buffer.as_ptr().cast::<TOKEN_USER>())).User.Sid };
    let inheritance = if path.is_dir() { 3 } else { 0 };
    let entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: FILE_ALL_ACCESS,
        grfAccessMode: SET_ACCESS,
        grfInheritance: inheritance,
        Trustee: TRUSTEE_W {
            pMultipleTrustee: ptr::null_mut(),
            MultipleTrusteeOperation: 0,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_USER,
            ptstrName: sid.cast(),
        },
    };
    let mut acl: *mut ACL = ptr::null_mut();
    if unsafe { SetEntriesInAclW(1, &entry, ptr::null(), &mut acl) } != 0 {
        return Err(failure());
    }
    let _acl = Local(acl.cast());
    let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe {
        SetNamedSecurityInfoW(
            name.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            acl,
            ptr::null(),
        )
    } != 0
    {
        return Err(failure());
    }
    let mut checked: *mut ACL = ptr::null_mut();
    let mut descriptor = ptr::null_mut();
    if unsafe {
        GetNamedSecurityInfoW(
            name.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut checked,
            ptr::null_mut(),
            &mut descriptor,
        )
    } != 0
    {
        return Err(failure());
    }
    let _descriptor = Local(descriptor);
    let mut control = 0;
    let mut revision = 0;
    if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0
        || control & SE_DACL_PROTECTED == 0
    {
        return Err(failure());
    }
    if checked.is_null() || unsafe { (*checked).AceCount } != 1 {
        return Err(failure());
    }
    let mut ace = ptr::null_mut();
    if unsafe { GetAce(checked, 0, &mut ace) } == 0 || ace.is_null() {
        return Err(failure());
    }
    let allowed = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
    let actual_sid = ptr::addr_of!(allowed.SidStart).cast_mut().cast();
    if allowed.Header.AceType != 0 // ACCESS_ALLOWED_ACE_TYPE
        || allowed.Mask != FILE_ALL_ACCESS
        || unsafe { EqualSid(sid, actual_sid) } == 0
        || allowed.Header.AceFlags & 0x10 != 0
    {
        return Err(failure());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn existing_explicit_world_acl_is_replaced_on_directory_case_alias_and_pending_journal() {
        use windows_sys::Win32::Security::Authorization::ConvertStringSidToSidW;
        let temporary = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
        let directory = temporary.path().join("private");
        std::fs::create_dir(&directory).unwrap();
        let database = directory.join("UNI-SWITCH.DB");
        let pending = directory.join("agent-ownership-codex.json.pending");
        std::fs::write(&database, "synthetic-only").unwrap();
        std::fs::write(&pending, "synthetic-recovery-only").unwrap();
        let sid_text: Vec<u16> = "S-1-1-0\0".encode_utf16().collect();
        let mut world = ptr::null_mut();
        assert_ne!(
            unsafe { ConvertStringSidToSidW(sid_text.as_ptr(), &mut world) },
            0
        );
        let _world = Local(world);
        for path in [&directory, &database, &pending] {
            let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            let mut previous = ptr::null_mut();
            let mut descriptor = ptr::null_mut();
            assert_eq!(
                unsafe {
                    GetNamedSecurityInfoW(
                        name.as_ptr(),
                        SE_FILE_OBJECT,
                        DACL_SECURITY_INFORMATION,
                        ptr::null_mut(),
                        ptr::null_mut(),
                        &mut previous,
                        ptr::null_mut(),
                        &mut descriptor,
                    )
                },
                0
            );
            let _descriptor = Local(descriptor);
            let entry = EXPLICIT_ACCESS_W {
                grfAccessPermissions: 0x0012_0089,
                grfAccessMode: SET_ACCESS,
                grfInheritance: 0,
                Trustee: TRUSTEE_W {
                    pMultipleTrustee: ptr::null_mut(),
                    MultipleTrusteeOperation: 0,
                    TrusteeForm: TRUSTEE_IS_SID,
                    TrusteeType: TRUSTEE_IS_USER,
                    ptstrName: world.cast(),
                },
            };
            let mut acl = ptr::null_mut();
            assert_eq!(
                unsafe { SetEntriesInAclW(1, &entry, previous, &mut acl) },
                0
            );
            let _acl = Local(acl.cast());
            assert!(unsafe { (*acl).AceCount } > 1);
            assert_eq!(
                unsafe {
                    SetNamedSecurityInfoW(
                        name.as_ptr(),
                        SE_FILE_OBJECT,
                        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                        ptr::null_mut(),
                        ptr::null_mut(),
                        acl,
                        ptr::null(),
                    )
                },
                0
            );
        }
        protect(&directory).unwrap();
        super::super::protect_existing_private_state(&directory).unwrap();
        // Inspect the result without calling protect again, which would mask
        // an enumeration bug for either the case alias or pending journal.
        for path in [&database, &pending] {
            let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            let mut acl = ptr::null_mut();
            let mut descriptor = ptr::null_mut();
            assert_eq!(
                unsafe {
                    GetNamedSecurityInfoW(
                        name.as_ptr(),
                        SE_FILE_OBJECT,
                        DACL_SECURITY_INFORMATION,
                        ptr::null_mut(),
                        ptr::null_mut(),
                        &mut acl,
                        ptr::null_mut(),
                        &mut descriptor,
                    )
                },
                0
            );
            let _descriptor = Local(descriptor);
            assert!(!acl.is_null());
            assert_eq!(unsafe { (*acl).AceCount }, 1);
        }
        assert_eq!(
            std::fs::read_to_string(&database).unwrap(),
            "synthetic-only"
        );
        assert_eq!(
            std::fs::read_to_string(&pending).unwrap(),
            "synthetic-recovery-only"
        );
    }
}
