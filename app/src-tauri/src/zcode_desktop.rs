//! Resolve the official desktop's bundled CLI without executing Electron.
#![forbid(unsafe_code)]

use crate::error::{AppError, Result};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const FUSE_MAGIC: &[u8; 32] = b"dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
const SCAN_CHUNK: usize = 64 * 1024;
const MAX_FUSE_COUNT: usize = 64;
const MAX_METADATA_BYTES: u64 = 4096;
const MAX_EXECUTABLE_BYTES: u64 = 512 * 1024 * 1024;

fn unsupported() -> AppError {
    AppError::new(
        "unsupported_agent_entry",
        "此 ZCode 桌面安装未提供可确认的官方 CLI 入口，请修复安装后重试",
    )
}

/// A standalone `zcode.exe` is a CLI, even when its name differs only by case.
pub(crate) fn is_desktop_entry(entry: &Path) -> bool {
    entry
        .file_name()
        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("ZCode.exe"))
        && entry
            .parent()
            .is_some_and(|parent| parent.join("resources/app.asar").is_file())
}

fn regular_file(path: &Path) -> Result<()> {
    crate::portable::validate_root(path).map_err(|_| unsupported())?;
    if !path.is_file() {
        return Err(unsupported());
    }
    Ok(())
}

fn run_as_node_enabled(input: &mut (impl Read + Seek)) -> Result<()> {
    let mut block = [0u8; SCAN_CHUNK];
    let mut tail = Vec::new();
    let mut scanned = 0u64;
    let mut found = None;
    loop {
        let count = input.read(&mut block).map_err(|_| unsupported())?;
        if count == 0 {
            break;
        }
        if scanned + count as u64 > MAX_EXECUTABLE_BYTES {
            return Err(unsupported());
        }
        let mut window = Vec::with_capacity(tail.len() + count);
        window.extend_from_slice(&tail);
        window.extend_from_slice(&block[..count]);
        for (index, value) in window.windows(FUSE_MAGIC.len()).enumerate() {
            if value == FUSE_MAGIC {
                if found.is_some() {
                    return Err(unsupported());
                }
                found = Some(scanned - tail.len() as u64 + index as u64);
            }
        }
        let keep = (FUSE_MAGIC.len() - 1).min(window.len());
        tail.clear();
        tail.extend_from_slice(&window[window.len() - keep..]);
        scanned += count as u64;
    }
    let offset = found.ok_or_else(unsupported)?;
    input
        .seek(SeekFrom::Start(offset + FUSE_MAGIC.len() as u64))
        .map_err(|_| unsupported())?;
    let mut header = [0u8; 2];
    input.read_exact(&mut header).map_err(|_| unsupported())?;
    let count = usize::from(header[1]);
    if header[0] != 1 || !(1..=MAX_FUSE_COUNT).contains(&count) {
        return Err(unsupported());
    }
    let mut states = [0u8; MAX_FUSE_COUNT];
    input
        .read_exact(&mut states[..count])
        .map_err(|_| unsupported())?;
    if states[0] != b'1' {
        return Err(unsupported());
    }
    Ok(())
}

pub(crate) fn bundle(entry: &Path) -> Result<(PathBuf, PathBuf)> {
    if !is_desktop_entry(entry) {
        return Err(unsupported());
    }
    let resources = entry.parent().ok_or_else(unsupported)?.join("resources");
    let metadata = resources.join("glm/.node-bundle-meta.json");
    let cli = resources.join("glm/zcode.cjs");
    let builtin = resources.join("config/provider/zcode-builtin.json");
    for path in [
        entry,
        resources.join("app.asar").as_path(),
        metadata.as_path(),
        cli.as_path(),
        builtin.as_path(),
    ] {
        regular_file(path)?;
    }
    let mut input = File::open(&metadata).map_err(|_| unsupported())?;
    if input.metadata().map_err(|_| unsupported())?.len() > MAX_METADATA_BYTES {
        return Err(unsupported());
    }
    let mut bytes = Vec::new();
    input
        .by_ref()
        .take(MAX_METADATA_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| unsupported())?;
    if bytes.len() as u64 > MAX_METADATA_BYTES {
        return Err(unsupported());
    }
    let metadata: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| unsupported())?;
    if metadata["runtime"] != "electron-node" || metadata["entry"] != "zcode.cjs" {
        return Err(unsupported());
    }
    run_as_node_enabled(&mut File::open(entry).map_err(|_| unsupported())?)?;
    Ok((cli, builtin))
}

#[cfg(test)]
fn bundled_cli(entry: &Path) -> Result<PathBuf> {
    bundle(entry).map(|(cli, _)| cli)
}

#[cfg(test)]
fn builtin_config(entry: &Path) -> Result<PathBuf> {
    bundle(entry).map(|(_, builtin)| builtin)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn fused(state: u8) -> Vec<u8> {
        let mut bytes = b"MZfixture".to_vec();
        bytes.extend_from_slice(FUSE_MAGIC);
        bytes.extend_from_slice(&[1, 3, state, b'0', b'1']);
        bytes
    }

    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let base = std::env::current_dir().unwrap();
        let root = tempfile::Builder::new()
            .prefix(".ae-zcode-desktop-test-")
            .tempdir_in(base)
            .unwrap();
        let entry = root.path().join("ZCode.exe");
        std::fs::create_dir_all(root.path().join("resources/glm")).unwrap();
        std::fs::create_dir_all(root.path().join("resources/config/provider")).unwrap();
        std::fs::write(&entry, fused(b'1')).unwrap();
        for name in [
            "resources/app.asar",
            "resources/glm/zcode.cjs",
            "resources/config/provider/zcode-builtin.json",
        ] {
            std::fs::write(root.path().join(name), b"official-bundle-fixture").unwrap();
        }
        std::fs::write(
            root.path().join("resources/glm/.node-bundle-meta.json"),
            br#"{"runtime":"electron-node","entry":"zcode.cjs"}"#,
        )
        .unwrap();
        (root, entry)
    }

    #[test]
    fn accepts_only_the_official_bundled_paths() {
        let (root, entry) = fixture();
        assert!(is_desktop_entry(&entry));
        assert_eq!(
            bundled_cli(&entry).unwrap(),
            root.path().join("resources/glm/zcode.cjs")
        );
        assert_eq!(
            builtin_config(&entry).unwrap(),
            root.path()
                .join("resources/config/provider/zcode-builtin.json")
        );
    }

    #[test]
    fn rejects_disabled_run_as_node_without_executing() {
        let (_root, entry) = fixture();
        std::fs::write(&entry, fused(b'0')).unwrap();
        assert_eq!(
            bundled_cli(&entry).unwrap_err().code,
            "unsupported_agent_entry"
        );
    }

    #[test]
    fn rejects_missing_metadata_and_incompatible_metadata() {
        let (root, entry) = fixture();
        let metadata = root.path().join("resources/glm/.node-bundle-meta.json");
        std::fs::remove_file(&metadata).unwrap();
        assert!(bundled_cli(&entry).is_err());
        for bytes in [
            br#"{"runtime":"node","entry":"zcode.cjs"}"#.as_slice(),
            br#"{"runtime":"electron-node","entry":"other.cjs"}"#,
        ] {
            std::fs::write(&metadata, bytes).unwrap();
            assert!(bundled_cli(&entry).is_err());
        }
        std::fs::write(&metadata, vec![b' '; MAX_METADATA_BYTES as usize + 1]).unwrap();
        assert!(bundled_cli(&entry).is_err());
    }

    #[test]
    fn standalone_cli_is_not_mistaken_for_the_desktop() {
        let (root, entry) = fixture();
        std::fs::remove_file(root.path().join("resources/app.asar")).unwrap();
        assert!(!is_desktop_entry(&entry));
        assert!(bundled_cli(&entry).is_err());
    }

    #[test]
    fn scans_a_fuse_and_header_across_chunk_boundaries() {
        for split in [1, 17, 31, 32, 33, 34] {
            let mut bytes = vec![0; SCAN_CHUNK - split];
            bytes.extend_from_slice(FUSE_MAGIC);
            bytes.extend_from_slice(&[1, 1, b'1']);
            assert!(run_as_node_enabled(&mut Cursor::new(bytes)).is_ok());
        }
    }

    #[test]
    fn rejects_ambiguous_truncated_or_unknown_fuse_wires() {
        let mut duplicate = fused(b'1');
        duplicate.extend_from_slice(&fused(b'1'));
        assert!(run_as_node_enabled(&mut Cursor::new(duplicate)).is_err());
        for header in [
            vec![1, 0],
            vec![2, 1, b'1'],
            vec![1, 65, b'1'],
            vec![1, 2, b'1'],
            vec![1, 1, 1],
        ] {
            let mut bytes = FUSE_MAGIC.to_vec();
            bytes.extend_from_slice(&header);
            assert!(run_as_node_enabled(&mut Cursor::new(bytes)).is_err());
        }
    }
}
