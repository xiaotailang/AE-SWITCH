# AE Switch implementation and acceptance plan

## Current acceptance contract (2026-10-10)

- Query the actual model list from the entered endpoint and API key. Failed discovery or cached-only results cannot enable confirmation.
- Confirmation saves the selected model, merges the selected existing native profile, verifies real inference, and starts the configured official tool to write a unique file, read it back, and return the correct assistant reply. Configuration, API inference, actual tool verification and restart are independent results.
- Users install all eight clients themselves. The product discovers their installations and existing profiles read-only, with explicit selection for ambiguity and manual paths as fallback. AE distributes only itself and necessary UI dependencies; it does not bundle or modify client programs.
- Preserve original client HOME/profile, histories, sessions, databases, MCP, plugins and unrelated preferences. Merge only endpoint, authentication, selected model and settings the user explicitly edits. Do not copy histories into a new private profile or change official authentication/approval state.
- During this workspace's tests, extract WorkBuddy's official desktop distribution into G and use its unmodified host for the bundled CLI. Do not run its registry-changing GUI installer. CLI inference does not prove official desktop default selection.
- Install a copy of the portable distribution in `.cache/e2e-sandbox/<uuid>` with an ownership marker. Run `scripts/verify-portable-e2e.ps1`; it removes the complete owned installation and runtime sandbox in `finally` and retains only sanitized evidence.
- No global installation, user-profile modification, Windows sandbox account setup, or C-drive configuration. Codex verification uses the owned working directory without the Windows OS sandbox; this distinction must appear in the evidence.
- Model discovery and all eight actual tool checks must pass against `端点测试用.txt` before declaring E2E completion. Verify first connection, independent revalidation, native UI flows and exact owned cleanup against the current source/binary. Invalid credentials, access restrictions, missing tools or untested desktop behavior are failed or missing acceptance, never simulated success.
- G is this machine's test boundary: all installations, configuration, caches, temporary files and test writes remain in owned G sandboxes. The product supports any writable local directory, including a C-only computer, and keeps AE data beside the executable; original client profiles may be on other drives. Do not modify this machine's original C client configuration or stop unrelated processes.

## Required outcome

Portable application based on the retrieved Tauri 2 / Rust / React / TypeScript / SQLite codebase. Rust owns credentials, HTTP, protocol translation, file generation, path enforcement and connection checks. The modern interface configures Claude Code, Codex, Hermes Agent, oh-my-pi, OpenCode, Z Code, WorkBuddy and DeepSeek Harness from an endpoint and key. Product screens and assets carry AE Switch branding and preserve official tool icons and legal notices. Windows, macOS and Linux require their own builds and native acceptance; cross-target checks alone do not prove them.

## Implementation

1. Preserve upstream configuration/translation regression tests. Add tests for local agent configuration, path containment, shell escaping and gateway authentication before extending these boundaries.
2. Keep AE runtime data, WebView storage, caches and temporary directories beside the program. Preserve selected clients' original homes and storage. Build downloads and this machine's complete test lifecycle stay in this G workspace.
3. Add a safe Rust agent configuration module and authenticated local HTTP gateway. Reuse existing protocol translation and atomic writes. Do not return upstream credentials to the interface or agent launchers.
4. Add a Rust command-line surface for reproducible setup, probing and acceptance, using the same kernel as the desktop UI.
5. Build a new modern agent hub and preserve advanced provider management. Report real probe states and actual generated file paths.
6. Produce a portable desktop artifact, local build/run scripts, corresponding modified source, licenses and concise usage instructions; verify directory migration and an independent clean machine.
7. Verify original client history interfaces and safe reopening after configuration, without forcing active terminal tasks to stop or replaying a previous task. Verify Windows login autostart and system browser/directory opening separately from isolated fixtures.
8. Finish WorkBuddy official desktop default selection through its actual home selector and verify consecutive tasks, normal restart and preserved old conversations. Do not invent unused preferences, modify builtin model capabilities, edit Chromium storage or send a model-switch event into an old active conversation.
9. Bind the modified project's actual repository and update source before enabling public source/update links. Local release preparation does not authorize uploading or publishing.

## Evidence and stop condition

- Existing and new Rust tests; Rust format/clippy/check; frontend typecheck, tests and production build.
- Render and inspect the new interface at desktop and narrow widths, including accessibility and error states.
- Launch the portable Rust binary and verify authenticated gateway behavior against isolated fixtures.
- Run actual agent tools through generated configurations against `端点测试用.txt`, requiring real output and a real file/tool interaction. Keep evidence scrubbed of credentials.
- Audit final source/UI correspondence, binary hashes, runtime dependencies and absence of credentials or used profiles. Keep original failures and subsequent cleanup facts separate; independently confirm exact owned test roots are absent.
- Keep full-acceptance and public-ready flags false until all applicable required functions, platform environments and release gates have current evidence. Remaining gaps are recorded in [current validation](current-validation.md) and [release readiness](release-readiness.md).
- Real upstream rejection is a failed acceptance result. Mock responses and local tests do not prove real endpoint acceptance. The goal remains incomplete until every required agent has actually passed.
