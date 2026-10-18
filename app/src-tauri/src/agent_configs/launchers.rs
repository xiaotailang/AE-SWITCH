#[cfg(any(unix, test))]
use super::AgentId;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy)]
pub(super) enum BundlePlatform {
    Windows,
    Macos,
    Linux,
}

impl BundlePlatform {
    pub(super) fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Macos
        } else {
            Self::Linux
        }
    }
}

pub(super) fn hermes_wrapper(platform: BundlePlatform) -> &'static str {
    match platform {
        BundlePlatform::Windows => "hermes/hermes.cmd",
        BundlePlatform::Macos | BundlePlatform::Linux => "hermes/hermes",
    }
}

pub(super) fn hermes_bin(platform: BundlePlatform, packaged_wrapper: bool) -> &'static str {
    match platform {
        BundlePlatform::Windows if !packaged_wrapper => "hermes/.venv/Scripts",
        BundlePlatform::Windows => "hermes",
        // POSIX venv console scripts retain absolute interpreter shebangs after a move.
        // Require the packaged relative wrapper; the runner reports a missing command.
        BundlePlatform::Macos | BundlePlatform::Linux => "hermes",
    }
}

pub(super) fn runtime_bins(platform: BundlePlatform) -> &'static [&'static str] {
    match platform {
        BundlePlatform::Windows => &[
            "tools/node",
            ".tools/node",
            "tools/git/cmd",
            "tools/git/bin",
            ".tools/git/cmd",
            ".tools/git/bin",
            "tools/python",
            ".tools/python",
        ],
        BundlePlatform::Macos | BundlePlatform::Linux => &[
            "tools/node/bin",
            "tools/node",
            ".tools/node/bin",
            ".tools/node",
            "tools/git/bin",
            ".tools/git/bin",
            "tools/python/bin",
            "tools/python",
            ".tools/python/bin",
            ".tools/python",
        ],
    }
}

pub(super) fn bundled_bash(platform: BundlePlatform) -> &'static [&'static str] {
    match platform {
        BundlePlatform::Windows => &["tools/git/bin/bash.exe", ".tools/git/bin/bash.exe"],
        BundlePlatform::Macos | BundlePlatform::Linux => {
            &["tools/git/bin/bash", ".tools/git/bin/bash"]
        }
    }
}

pub(super) fn workbuddy_entries(
    directory: &Path,
    platform: BundlePlatform,
) -> Vec<(PathBuf, PathBuf)> {
    let entry = "resources/app.asar.unpacked/cli/bin/codebuddy";
    match platform {
        BundlePlatform::Windows => vec![(directory.join("WorkBuddy.exe"), directory.join(entry))],
        BundlePlatform::Macos => {
            let application = directory.join("WorkBuddy.app/Contents");
            vec![(
                application.join("MacOS/WorkBuddy"),
                application.join("Resources/app.asar.unpacked/cli/bin/codebuddy"),
            )]
        }
        BundlePlatform::Linux => ["workbuddy", "WorkBuddy"]
            .into_iter()
            .map(|name| (directory.join(name), directory.join(entry)))
            .collect(),
    }
}

#[cfg(any(unix, test))]
pub(super) fn posix_launcher(agent: AgentId, relative_root: &str) -> String {
    // The root is generated from ancestor counts, never from credentials or user text.
    debug_assert!(relative_root.split('/').all(|component| component == ".."));
    format!(
        r#"#!/bin/sh
set -eu
case "$0" in
    /*) launcher_path=$0 ;;
    *) launcher_path=$PWD/$0 ;;
esac
agent_directory=$(CDPATH= cd -P "$(dirname "$launcher_path")" && pwd -P)
portable_root=$(CDPATH= cd -P "$agent_directory/{relative_root}" && pwd -P)
export AE_SWITCH_PORTABLE_ROOT="$portable_root"
for core in "$portable_root/AE-Switch-core" "$portable_root/ae-switch-cli" "$portable_root"/*.app/Contents/MacOS/AE-Switch-core "$portable_root"/*.app/Contents/MacOS/ae-switch-cli; do
    if [ -f "$core" ] && [ -x "$core" ] && [ ! -L "$core" ]; then
        core_directory=$(CDPATH= cd -P "$(dirname "$core")" && pwd -P)
        case "$core_directory/" in
            "$portable_root/"*) exec "$core" run-agent '{agent}' "$@" ;;
        esac
    fi
done
printf '%s\n' 'The portable AE Switch core is missing or is not executable.' >&2
exit 127
"#,
        agent = agent.as_str(),
    )
}
