//! Bounded, content-free failure diagnostics for the one owned probe file.
use super::{is_reparse, File, Path, Read};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Observation {
    pub status: &'static str,
    pub actual_bytes: Option<u64>,
    pub expected_bytes: usize,
}

pub(super) fn inspect(workspace: &Path, artifact: &Path, expected: &str) -> Observation {
    let mut observation = Observation {
        status: "missing",
        actual_bytes: None,
        expected_bytes: expected.len(),
    };
    let metadata = match std::fs::symlink_metadata(artifact) {
        Ok(metadata) => metadata,
        Err(error) => {
            if error.kind() != std::io::ErrorKind::NotFound {
                observation.status = "unreadable";
            }
            return observation;
        }
    };
    observation.status = "unsafe_path";
    if !metadata.is_file() || is_reparse(&metadata) {
        return observation;
    }
    let (Ok(root), Ok(target)) = (workspace.canonicalize(), artifact.canonicalize()) else {
        return observation;
    };
    if target.parent() != Some(root.as_path()) {
        return observation;
    }
    observation.actual_bytes = Some(metadata.len());
    // A valid marker is small. Do not inspect arbitrary tool output or retain
    // file bytes, paths, marker text, command arguments, hashes or credentials.
    observation.status = "different_content";
    let bound = expected.len().saturating_add(8);
    if metadata.len() > bound as u64 {
        return observation;
    }
    observation.status = "unreadable";
    let Ok(file) = File::open(artifact) else {
        return observation;
    };
    let mut bytes = Vec::new();
    if file.take(bound as u64 + 1).read_to_end(&mut bytes).is_err()
        || bytes.len() as u64 != metadata.len()
    {
        return observation;
    }
    observation.status = if bytes == expected.as_bytes() {
        "exact"
    } else if bytes.strip_prefix(b"\xef\xbb\xbf") == Some(expected.as_bytes()) {
        "unexpected_utf8_bom"
    } else {
        let payload = expected.trim_end_matches(['\r', '\n']).as_bytes();
        if bytes.strip_suffix(b"\r\n") == Some(payload)
            || bytes.strip_suffix(b"\n") == Some(payload)
            || bytes.as_slice() == payload
        {
            "line_ending_mismatch"
        } else {
            "different_content"
        }
    };
    observation
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinguishes_exact_content_line_endings_and_bom_without_exposing_bytes() {
        let temporary = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
        let file = temporary.path().join("owned.txt");
        let marker = "synthetic-private-marker";
        for (bytes, status) in [
            (marker.as_bytes().to_vec(), "exact"),
            (format!("{marker}\n").into_bytes(), "line_ending_mismatch"),
            (format!("{marker}\r\n").into_bytes(), "line_ending_mismatch"),
            (
                [b"\xef\xbb\xbf".as_slice(), marker.as_bytes()].concat(),
                "unexpected_utf8_bom",
            ),
            (format!("{marker}other").into_bytes(), "different_content"),
        ] {
            std::fs::write(&file, &bytes).unwrap();
            let observation = inspect(temporary.path(), &file, marker);
            assert_eq!(observation.status, status);
            assert_eq!(observation.actual_bytes, Some(bytes.len() as u64));
            let serialized = serde_json::to_string(&observation).unwrap();
            assert!(!serialized.contains(marker));
            assert!(!serialized.contains("owned.txt"));
            assert_eq!(
                super::super::exact_owned_contents(temporary.path(), &file, marker),
                status == "exact"
            );
        }
        std::fs::write(&file, marker).unwrap();
        assert_eq!(
            inspect(temporary.path(), &file, &format!("{marker}\n")).status,
            "line_ending_mismatch"
        );
    }

    #[test]
    fn missing_foreign_and_oversized_targets_are_rejected_and_never_modified() {
        let temporary = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
        let owned = temporary.path().join("owned");
        std::fs::create_dir(&owned).unwrap();
        let missing = owned.join("missing.txt");
        assert_eq!(inspect(&owned, &missing, "marker").status, "missing");
        assert!(!missing.exists());
        let foreign = temporary.path().join("foreign.txt");
        std::fs::write(&foreign, "private foreign fixture").unwrap();
        let observation = inspect(&owned, &foreign, "marker");
        assert_eq!(observation.status, "unsafe_path");
        assert!(observation.actual_bytes.is_none());
        assert_eq!(
            std::fs::read_to_string(&foreign).unwrap(),
            "private foreign fixture"
        );
        let oversized = owned.join("large.txt");
        std::fs::write(&oversized, vec![b'x'; 65536]).unwrap();
        assert_eq!(
            inspect(&owned, &oversized, "marker").status,
            "different_content"
        );
        assert_eq!(std::fs::metadata(&oversized).unwrap().len(), 65536);
    }
}
