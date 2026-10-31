//! Integrity for private recovery state. This is a local tamper check, not encryption.
use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{io::Write, path::Path};

pub(crate) const KEY_FILE: &str = "runtime-integrity.key";
const MAX_RECORD: usize = 64 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    version: u8,
    purpose: String,
    payload: String,
    mac: String,
}

fn invalid() -> AppError {
    AppError::new(
        "invalid_private_state",
        "本地恢复记录完整性校验失败，未修改客户端；请保留数据目录后修复",
    )
}
fn validate(root: &Path) -> Result<()> {
    crate::portable::validate_owned_path(root)?;
    crate::portable::validate_root(root)
}

fn existing_records(root: &Path) -> Result<bool> {
    for entry in std::fs::read_dir(root).map_err(|error| AppError::io(root, error))? {
        let entry = entry.map_err(|error| AppError::io(root, error))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if (name.starts_with("agent-ownership-") && name.ends_with(".json"))
            || name == "agent-disconnect.pending.json"
            || name == "config-profiles.pending.json"
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn key(root: &Path, create: bool) -> Result<Vec<u8>> {
    validate(root)?;
    let path = root.join(KEY_FILE);
    validate(&path)?;
    let text = match std::fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() && metadata.len() == 64 => {
            std::fs::read_to_string(&path).map_err(|error| AppError::io(&path, error))?
        }
        Ok(_) => return Err(invalid()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if !create || existing_records(root)? {
                return Err(invalid());
            }
            // Three OS-random UUIDs provide more than 256 random bits even
            // after their fixed version bits; hash them to a 32-byte key.
            let mut entropy = Sha256::new();
            for _ in 0..3 {
                entropy.update(uuid::Uuid::new_v4().as_bytes());
            }
            let text = format!("{:x}", entropy.finalize());
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|error| AppError::io(&path, error))?;
            validate(&path)?;
            crate::writer::private_file_permissions(&path)?;
            file.write_all(text.as_bytes())
                .and_then(|_| file.sync_all())
                .map_err(|error| AppError::io(&path, error))?;
            #[cfg(unix)]
            std::fs::File::open(root)
                .and_then(|directory| directory.sync_all())
                .map_err(|error| AppError::io(root, error))?;
            text
        }
        Err(error) => return Err(AppError::io(&path, error)),
    };
    if text.len() != 64 || !text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(invalid());
    }
    (0..64)
        .step_by(2)
        .map(|index| u8::from_str_radix(&text[index..index + 2], 16).map_err(|_| invalid()))
        .collect()
}

fn mac(key: &[u8], purpose: &str, payload: &str) -> Result<String> {
    if key.len() != 32
        || purpose.is_empty()
        || purpose.len() > 128
        || purpose.chars().any(char::is_control)
        || payload.len() > MAX_RECORD
    {
        return Err(invalid());
    }
    let mut inner_pad = [0x36; 64];
    let mut outer_pad = [0x5c; 64];
    for (index, byte) in key.iter().enumerate() {
        inner_pad[index] ^= byte;
        outer_pad[index] ^= byte;
    }
    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(b"ae-switch-private-state-v1\0");
    inner.update(purpose.as_bytes());
    inner.update([0]);
    inner.update(payload.as_bytes());
    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner.finalize());
    Ok(format!("{:x}", outer.finalize()))
}

pub(crate) fn seal(root: &Path, purpose: &str, payload: &str) -> Result<String> {
    let mac = mac(&key(root, true)?, purpose, payload)?;
    serde_json::to_string(&Envelope {
        version: 1,
        purpose: purpose.into(),
        payload: payload.into(),
        mac,
    })
    .map_err(|_| invalid())
}

pub(crate) fn open(root: &Path, purpose: &str, text: &str) -> Result<String> {
    if text.len() > MAX_RECORD {
        return Err(invalid());
    }
    let envelope: Envelope = serde_json::from_str(text).map_err(|_| invalid())?;
    let expected = mac(&key(root, false)?, purpose, &envelope.payload)?;
    let matches = expected.len() == envelope.mac.len()
        && expected
            .bytes()
            .zip(envelope.mac.bytes())
            .fold(0u8, |different, (a, b)| different | (a ^ b))
            == 0;
    if envelope.version != 1 || envelope.purpose != purpose || !matches {
        return Err(invalid());
    }
    Ok(envelope.payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signature_matches_standard_hmac_sha256_vector() {
        let key: Vec<_> = (0u8..32).collect();
        assert_eq!(
            mac(&key, "test", "payload").unwrap(),
            "fb680abf7d8bf74ff2b0f0b7181af30cdd4f64aaa53f3a57dde41acb9848a5dd"
        );
    }
    #[test]
    fn tampered_cross_domain_or_missing_key_records_fail_closed() {
        let temporary = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
        let root = temporary.path();
        let text = seal(root, "one", "private-payload").unwrap();
        assert_eq!(open(root, "one", &text).unwrap(), "private-payload");
        assert!(open(root, "two", &text).is_err());
        assert!(open(
            root,
            "one",
            &text.replace("private-payload", "forged-payload")
        )
        .is_err());
        std::fs::write(root.join("agent-ownership-codex.json"), &text).unwrap();
        std::fs::remove_file(root.join(KEY_FILE)).unwrap();
        assert!(open(root, "one", &text).is_err());
        assert!(seal(root, "one", "new").is_err());
        assert!(!root.join(KEY_FILE).exists());
    }
}
