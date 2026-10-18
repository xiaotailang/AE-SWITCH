# Third-party notices

AE Switch's modified application code and the original uni-switch application code are licensed under **AGPL-3.0-only**. The original copyright is retained in `NOTICE`. Third-party components retain their original licenses; no third-party component is relicensed by this notice.

The bundled `source/ae-switch/` directory contains this modification's source and build materials. The upstream uni-switch repository in its retained notice identifies the original project; it is not this modification's repository. The current source leaves the target GitHub repository unset in `release-config.json` pending the actual repository for this AE Switch modification. This does not establish an AE Switch public release.

## OpenAI Codex base instructions

uni-switch includes the unchanged generic Codex base instructions from OpenAI Codex, tag `rust-v0.160.0`, file `codex-rs/models-manager/prompt.md`.

Source: https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/models-manager/prompt.md

OpenAI Codex · Copyright 2025 OpenAI. Licensed under the Apache License, Version 2.0. The complete license is included in `third-party/codex/LICENSE` in the source repository and `licenses/codex-LICENSE` in the installed application. The original text is embedded in the executable, used in generated model catalogs, and is not downloaded at runtime. No changes have been made to it.

## Dependency licenses

JavaScript and Rust dependencies retain their own licenses and copyright notices. Their exact versions are recorded in `pnpm-lock.yaml` and `src-tauri/Cargo.lock`. The bundled license texts and dependency source references are in `third-party/dependency-licenses.txt` in the source repository and `licenses/dependency-licenses.txt` in binary distributions.

The inventory includes development and build dependencies as well as runtime dependencies so that notices remain available for source builds. It is generated from locally installed package metadata and license files using `scripts/collect-dependency-licenses.py`; none of these files contains user credentials.

## Brand images

OpenAI and Anthropic client marks belong to their respective owners, are used to identify supported clients, and are not covered by uni-switch's AGPL license. Sources are documented in `src/assets/brands/README.md`.

The purple 蝶祈云 logo belongs to 蝶祈云 and identifies the service website. It is not covered by the application's AGPL license. The application's own black-and-white uni-switch switching mark is part of this project.

No endorsement by any tool vendor is implied. The eight Agent Hub marks and their exact official sources are recorded in `src/assets/agents/sources.json`; notices are also bundled in `ui/agent-brand-notices.txt`. The DeepSeek Harness favicon is copied unchanged from <https://www.deepseek.com/harness/favicon.svg>; its site's mark is not automatically licensed by the Harness CLI's MIT code license.

## AE-only distribution

The AE Switch package contains this application, its UI runtime, corresponding source, licenses, and redacted verification receipts. It does not redistribute Claude Code, Codex, Hermes Agent, oh-my-pi, OpenCode, Z Code, WorkBuddy, or DeepSeek Harness, or their Node.js, Python, PowerShell, and Git runtimes. Users install those clients separately under their vendors' applicable terms. Local G-drive test installations are temporary acceptance fixtures and are not release payloads.

The fixed WebView2 runtime and application runtime libraries retain their own licenses and notices. The included Codex generic prompt text described above remains an application asset; it is not a bundled Codex executable.

Official client logos remain third-party marks. Their provenance and hashes are retained in `src/assets/agents/sources.json` and the packaged brand notices. An exact source match does not establish trademark permission; removing client binaries from the package does not change the ownership or applicable conditions of those marks.
