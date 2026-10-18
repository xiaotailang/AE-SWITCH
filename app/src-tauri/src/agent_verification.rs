//! Controlled, real official-CLI file-tool verification. Fixtures prove the
//! acceptance rules only; they are not evidence of a successful live tool run.
#![forbid(unsafe_code)]

use crate::agent_configs::{self, AgentId, ExistingProfile};
use crate::error::Result;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{self, File, Metadata};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};
use uuid::Uuid;

const OUTPUT_LIMIT: usize = 2 * 1024 * 1024;
const RUN_TIMEOUT: Duration = Duration::from_secs(180);
const TERMINATION_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(windows)]
const OUTPUT_DRAIN_GRACE: Duration = Duration::from_secs(2);
const TOOL_EVENT_SHAPE_LIMIT: usize = 32;
const TOOL_INPUT_KEY_LIMIT: usize = 16;
const TOOL_METADATA_LABEL_LIMIT: usize = 96;

#[derive(Default)]
struct Capture {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    exit_code: Option<i32>,
    process_succeeded: bool,
    timed_out: bool,
    output_limit_exceeded: bool,
    launch_failed: bool,
    output_failed: bool,
    inherited_pipes_open: bool,
    terminal_completion_required: bool,
    terminal_completed_observed: bool,
}

#[derive(Debug)]
enum CaptureError {
    OutputLimit,
    Io,
}

#[derive(Default, Debug)]
struct Evidence {
    event_count: usize,
    related_event_count: usize,
    tool_event_shapes: Vec<ToolEventShape>,
    write_observed: bool,
    read_observed: bool,
    readback_marker_observed: bool,
    assistant_marker_observed: bool,
    file_matches_marker: bool,
}

#[derive(Debug)]
struct ToolEventShape {
    kind: String,
    name: String,
    input_keys: Vec<String>,
    has_id: bool,
    related_to_filename: bool,
    write_operation: bool,
    read_operation: bool,
    returned_marker: bool,
}

impl Evidence {
    fn verified(&self, process_succeeded: bool) -> bool {
        process_succeeded
            && self.write_observed
            && self.read_observed
            && self.readback_marker_observed
            && self.assistant_marker_observed
            && self.file_matches_marker
    }
}

/// Runs only this agent's validated, generated launcher. The launcher retains
/// responsibility for the private HOME, cwd, cache, temporary files and PATH.
pub async fn verify(
    root: PathBuf,
    agent: AgentId,
    model: String,
    secrets: Vec<String>,
) -> Result<Value> {
    verify_selected(root, agent, model, secrets, None).await
}

pub async fn verify_selected(
    root: PathBuf,
    agent: AgentId,
    model: String,
    secrets: Vec<String>,
    profile: Option<ExistingProfile>,
) -> Result<Value> {
    let started = Instant::now();
    let launcher = match profile
        .as_ref()
        .map(|profile| {
            agent_configs::validate_existing_profile(agent, profile)
                .map(|_| PathBuf::from(&profile.executable_path))
        })
        .unwrap_or_else(|| agent_configs::validate_launch(&root, agent))
    {
        Ok(launcher) => launcher,
        Err(_) => {
            return Ok(report(
                &model,
                &secrets,
                started,
                &Capture::default(),
                &Evidence::default(),
                false,
                "configuration",
                "请先保存并应用此工具的配置，再验证真实文件工具。",
            ));
        }
    };
    if profile.is_some() && agent == AgentId::WorkBuddy && workbuddy_desktop_entry(&launcher) {
        let mut result=report(&model,&secrets,started,&Capture::default(),&Evidence::default(),true,
            "unsupported","所选 WorkBuddy 桌面入口不提供无界面文件工具验证；模型配置已经保存，请在桌面客户端选择模型并验证。可另选官方 CLI 入口执行写入和读回验证。");
        result["profileMode"] = json!("existing");
        result["clientSurface"] = json!("desktop-gui");
        result["verificationScope"] = json!("unsupported_desktop_gui");
        result["desktopGuiVerified"] = json!(false);
        result["desktopDefaultSelectionVerified"] = json!(false);
        result["nativeDefaultModelVerified"] = json!(false);
        result["explicitModelArgument"] = json!(false);
        return Ok(result);
    }
    let Some(directory) = launcher.parent() else {
        return Ok(report(
            &model,
            &secrets,
            started,
            &Capture::default(),
            &Evidence::default(),
            false,
            "configuration",
            "生成的启动脚本缺少工具目录。",
        ));
    };
    let workspace = if profile.is_some() {
        let path = root.join("agent-verification").join(agent.as_str());
        crate::writer::private_directory(&path)?;
        path
    } else {
        directory.join("workspace")
    };
    let nonce = Uuid::new_v4();
    let owned_directory_name = format!(".ae-tool-verification-{nonce}");
    let owned_workspace = workspace.join(&owned_directory_name);
    let filename = if agent == AgentId::OhMyPi {
        "probe.txt".to_owned()
    } else {
        format!(".ae-tool-verification-{nonce}.txt")
    };
    let marker = format!("AE_TOOL_VERIFIED_{}", nonce.simple());
    let artifact = owned_workspace.join(&filename);
    // Never reserve this file by writing the marker ourselves: the official
    // agent must perform the actual write, and an existing file is never owned.
    if create_owned_workspace(&workspace, &owned_workspace, nonce).is_err() {
        return Ok(report(
            &model,
            &secrets,
            started,
            &Capture::default(),
            &Evidence::default(),
            false,
            "workspace",
            "无法安全创建本次独立验证目录，请检查工作目录权限。",
        ));
    }
    // A Windows Codex background helper can outlive the completed CLI and keep
    // its inherited cwd open. Keep those helpers in the stable AE-owned parent;
    // the exact UUID file remains the only requested verification target.
    let stable_codex_workspace = cfg!(windows) && agent == AgentId::Codex && profile.is_some();
    let relative_artifact = if matches!(
        agent,
        AgentId::DeepSeekHarness | AgentId::OhMyPi | AgentId::OpenCode
    ) || stable_codex_workspace
    {
        artifact.to_string_lossy().into_owned()
    } else if profile.is_some() || agent == AgentId::Codex {
        filename.clone()
    } else {
        format!("{owned_directory_name}/{filename}")
    };
    let prompt = verification_prompt(agent, &relative_artifact, &marker);
    let mut capture = if let Some(profile) = &profile {
        let execution_workspace = if stable_codex_workspace {
            &workspace
        } else {
            &owned_workspace
        };
        let mut arguments = arguments_for(agent, &prompt, execution_workspace);
        // Existing clients must read their native profile during this validation.
        arguments.retain(|argument| !matches!(argument.as_str(), "--bare" | "--pure"));
        if agent == AgentId::WorkBuddy {
            arguments.extend(["--model".into(), model.clone()]);
        }
        let command = crate::agent_runner::existing_command(
            agent,
            profile,
            &arguments,
            Some(execution_workspace),
        );
        match command {
            Ok(command) => {
                let mut command = Command::from(command);
                command
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .kill_on_drop(true);
                hidden(&mut command);
                #[cfg(unix)]
                command.process_group(0);
                execute_command(command, agent == AgentId::Codex).await
            }
            Err(_) => Capture {
                launch_failed: true,
                ..Capture::default()
            },
        }
    } else {
        execute(
            agent,
            &launcher,
            &workspace,
            arguments_for(agent, &prompt, &owned_workspace),
        )
        .await
    };
    let events = parse_events(&capture.stdout);
    if agent == AgentId::DeepSeekHarness {
        capture.terminal_completion_required = true;
        capture.terminal_completed_observed = deepseek_terminal_completed(&events);
    } else if agent == AgentId::Codex && capture.inherited_pipes_open {
        capture.terminal_completion_required = true;
        capture.terminal_completed_observed = codex_terminal_completed(&events);
    }
    let evidence_path = if agent == AgentId::DeepSeekHarness {
        &relative_artifact
    } else {
        &filename
    };
    let mut evidence = tool_evidence(agent, &events, evidence_path, &marker);
    evidence.assistant_marker_observed = assistant_marker(agent, &events, &marker);
    let expected_contents = verification_contents(agent, &marker);
    evidence.file_matches_marker = validate_owned_workspace(&workspace, &owned_workspace, nonce)
        && exact_owned_contents(&owned_workspace, &artifact, &expected_contents);
    let cleanup_succeeded =
        cleanup_owned_workspace(agent, &workspace, &owned_workspace, nonce, &filename);
    let (stage, message) = outcome(&capture, &evidence, cleanup_succeeded);
    let mut result = report(
        &model,
        &secrets,
        started,
        &capture,
        &evidence,
        cleanup_succeeded,
        stage,
        message,
    );
    result["profileMode"] = json!(if profile.is_some() {
        "existing"
    } else {
        "private"
    });
    result["desktopGuiVerified"] = json!(false);
    result["desktopDefaultSelectionVerified"] = json!(false);
    result["clientSurface"] = json!("headless-cli");
    result["verificationScope"] = json!("headless_tool_write_read");
    result["explicitModelArgument"] = json!(profile.is_some() && agent == AgentId::WorkBuddy);
    result["nativeDefaultModelVerified"] =
        json!(profile.is_some() && agent != AgentId::WorkBuddy && result["ok"] == true);
    Ok(result)
}

fn workbuddy_desktop_entry(entry: &Path) -> bool {
    entry
        .extension()
        .is_some_and(|extension| extension.to_string_lossy().eq_ignore_ascii_case("exe"))
        || entry
            .file_name()
            .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("WorkBuddy"))
        || entry.components().any(|component| {
            component
                .as_os_str()
                .to_string_lossy()
                .to_ascii_lowercase()
                .ends_with(".app")
        })
}

fn verification_contents(agent: AgentId, marker: &str) -> String {
    if matches!(agent, AgentId::Codex | AgentId::OpenCode) {
        // Both clients create patch-based verification files with a terminal LF.
        // Requiring no LF would add an unnecessary normalization tool call.
        format!("{marker}\n")
    } else {
        marker.to_owned()
    }
}

fn verification_prompt(agent: AgentId, relative_artifact: &str, marker: &str) -> String {
    let creation = if matches!(agent, AgentId::Codex | AgentId::OpenCode) {
        format!("Use your available file creation tool (apply_patch for GPT models, or write when available) to create that file with the exact UTF-8 contents {marker} followed by exactly one LF byte (0x0a), with no CR byte, BOM, additional newline or other text.")
    } else {
        format!("Use your file write/edit tool to create that file with the exact UTF-8 contents {marker} and no other text or newline.")
    };
    let mut prompt = format!(
        "Only operate on the verification file {relative_artifact} inside the already-created owned verification directory. Do not read or change any other files. {creation} Then use your file read tool to read that same file back. Your final answer must be exactly the content returned by the read tool. Do not use network tools or delegate work."
    );
    if agent == AgentId::OhMyPi {
        prompt.push_str(
            " For oh-my-pi, the path above is the exact absolute target path. Use that path unchanged as the path argument for both write and read. Do not abbreviate it, guess an 8.3 short name, change any directory component, or change directories. Its parent directory already exists. Create only that exact file, then read the same exact absolute path.",
        );
    }
    if agent == AgentId::OpenCode {
        prompt.push_str(
            " For OpenCode, the path above is the exact absolute target path: use it as the Add File path for apply_patch or filePath for write and read. Its parent directory already exists; the file does not exist yet and must be created. Do not discover or locate the directory, list files, use glob, or use bash/shell to search for the path. Create only that file, then call your read tool with the same absolute filePath. Return only the content actually returned by that read, without tool-added line numbering.",
        );
    }
    if agent == AgentId::Zcode {
        // ZCode Write seeds the full-read cache. A default Read can succeed
        // with only a file_unchanged stub; an explicit range uses another key.
        prompt.push_str(
            " For ZCode, perform an independent Read after the write with explicit offset: 0 and limit: 10 on that same file, so the tool returns actual file contents rather than the full-read cache. A cached file_unchanged or Wasted call response is not readback evidence: retry with the explicit range or an independent shell read of only that same file. The successful read result itself must contain the exact verification marker. Use only that successful read as the source of your final answer, returning the exact file contents without tool-added line numbering. Never substitute the write input or remembered marker for a successful read result.",
        );
    }
    prompt
}

fn outcome(
    capture: &Capture,
    evidence: &Evidence,
    cleanup_succeeded: bool,
) -> (&'static str, &'static str) {
    if capture.timed_out {
        ("timeout", "官方工具未在 180 秒内完成验证。")
    } else if capture.output_limit_exceeded {
        ("output_limit", "官方工具输出超过本次验证的大小限制。")
    } else if capture.launch_failed {
        ("launch", "无法启动生成的官方工具启动脚本。")
    } else if capture.output_failed {
        ("process", "无法完整读取官方工具的验证输出。")
    } else if capture.exit_code == Some(127) {
        (
            "not_installed",
            "未找到此工具的官方命令或运行时，请先准备便携工具文件。",
        )
    } else if !capture.process_succeeded {
        ("process", "官方工具执行失败，真实文件工具尚未验证通过。")
    } else if capture.terminal_completion_required && !capture.terminal_completed_observed {
        ("tool", "官方工具没有报告未截断的 completed 回合终结事件。")
    } else if !evidence.verified(true) {
        (
            "tool",
            "未同时确认助手回复、精确文件内容及关联的写入和读取工具事件。",
        )
    } else if !cleanup_succeeded {
        (
            "cleanup",
            "工具操作已完成，但无法安全清理本次独立验证文件。",
        )
    } else {
        ("verified", "官方工具已成功写入并读回本次精确验证文件。")
    }
}

#[allow(clippy::too_many_arguments)]
fn report(
    model: &str,
    secrets: &[String],
    started: Instant,
    capture: &Capture,
    evidence: &Evidence,
    cleanup_succeeded: bool,
    stage: &str,
    message: &str,
) -> Value {
    let verified = evidence.verified(capture.process_succeeded)
        && cleanup_succeeded
        && (!capture.terminal_completion_required || capture.terminal_completed_observed);
    json!({
        "validationScope": "tool", "toolVerified": verified, "ok": verified,
        "stage": stage, "message": redact(message, secrets), "model": redact(model, secrets),
        "diagnostic": if verified { String::new() } else { diagnostic(capture, secrets) },
        "latencyMs": started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        "evidence": {
            "writeObserved": evidence.write_observed, "readObserved": evidence.read_observed,
            "readbackMarkerObserved": evidence.readback_marker_observed,
            "assistantMarkerObserved": evidence.assistant_marker_observed,
            "fileMatchesMarker": evidence.file_matches_marker,
            "processSucceeded": capture.process_succeeded,
            "inheritedPipesOpen": capture.inherited_pipes_open,
            "terminalCompletionRequired": capture.terminal_completion_required,
            "terminalCompletedObserved": capture.terminal_completed_observed,
        },
        "cleanup": { "scope": "owned-uuid-verification-directory", "succeeded": cleanup_succeeded, "removed": cleanup_succeeded },
        "toolEvidence": {
            "eventCount": evidence.event_count, "relatedEventCount": evidence.related_event_count,
            "toolEventShapes": evidence.tool_event_shapes.iter().map(|shape| json!({
                "type": metadata_label(&shape.kind, secrets),
                "name": metadata_label(&shape.name, secrets),
                "inputKeys": shape.input_keys.iter().map(|key| metadata_label(key, secrets)).collect::<Vec<_>>(),
                "hasId": shape.has_id, "relatedToFilename": shape.related_to_filename,
                "writeOperation": shape.write_operation, "readOperation": shape.read_operation,
                "returnedMarker": shape.returned_marker,
            })).collect::<Vec<_>>(),
            "toolEventShapesTruncated": evidence.event_count > evidence.tool_event_shapes.len(),
            "writeObserved": evidence.write_observed, "readObserved": evidence.read_observed,
            "readbackMarkerObserved": evidence.readback_marker_observed,
            "assistantMarkerObserved": evidence.assistant_marker_observed,
            "fileMatchesMarker": evidence.file_matches_marker,
            "processSucceeded": capture.process_succeeded, "exitCode": capture.exit_code,
            "timedOut": capture.timed_out, "outputLimitExceeded": capture.output_limit_exceeded,
            "inheritedPipesOpen": capture.inherited_pipes_open,
            "capturedStdoutBytes": capture.stdout.len(), "capturedStderrBytes": capture.stderr.len(),
            "cleanupSucceeded": cleanup_succeeded,
            "terminalCompletionRequired": capture.terminal_completion_required,
            "terminalCompletedObserved": capture.terminal_completed_observed,
            "osSandboxEnabled": false,
            "isolationScope": "Application-owned UUID verification directory; no OS sandbox setup is performed.",
        }
    })
}

fn redact(value: &str, secrets: &[String]) -> String {
    let mut result = value.to_owned();
    // Longest first also removes overlapping credentials without exposing a suffix.
    let mut ordered: Vec<_> = secrets.iter().filter(|secret| !secret.is_empty()).collect();
    ordered.sort_unstable_by_key(|secret| std::cmp::Reverse(secret.len()));
    for secret in ordered {
        result = result.replace(secret, "<redacted>");
    }
    result
}

fn metadata_label(value: &str, secrets: &[String]) -> String {
    // Redact before truncating: a credential spanning the limit must not leak
    // its prefix. Only identifier labels are eligible, never paths or text.
    let sanitized = redact(value, secrets);
    if sanitized.contains(".ae-tool-verification-")
        || sanitized.contains("AE_TOOL_VERIFIED_")
        || !sanitized.chars().all(|character| {
            character.is_alphanumeric() || matches!(character, '_' | '-' | '.' | '<' | '>')
        })
    {
        return "<omitted>".to_owned();
    }
    sanitized.chars().take(TOOL_METADATA_LABEL_LIMIT).collect()
}

fn diagnostic(capture: &Capture, secrets: &[String]) -> String {
    let mut messages = vec![String::from_utf8_lossy(&capture.stderr).into_owned()];
    // Only explicit error fields from stdout are eligible. User/assistant
    // messages and full JSON events (which can contain the prompt) are omitted.
    for event in parse_events(&capture.stdout) {
        if event["type"] == "user" || event["role"] == "user" || event["message"]["role"] == "user"
        {
            continue;
        }
        if event["type"] == "error" || event["is_error"] == true || !event["error"].is_null() {
            for field in [
                &event["message"],
                &event["error"],
                &event["error"]["message"],
                &event["error"]["data"]["message"],
            ] {
                if let Some(text) = field.as_str() {
                    messages.push(text.to_owned());
                }
            }
            if event["is_error"] == true {
                if let Some(text) = event["result"].as_str() {
                    messages.push(text.to_owned());
                }
            }
        }
    }
    let sanitized = redact(&messages.join("\n"), secrets);
    let filtered = sanitized
        .lines()
        .filter(|line| {
            !line.contains("Only operate on the verification file")
                && !line.contains("AE_TOOL_VERIFIED_")
                && !line.contains(".ae-tool-verification-")
        })
        .collect::<Vec<_>>()
        .join("\n");
    filtered
        .chars()
        .rev()
        .take(2000)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

fn arguments_for(agent: AgentId, prompt: &str, workspace: &Path) -> Vec<String> {
    let workspace_argument = workspace.to_string_lossy();
    let arguments: Vec<&str> = match agent {
        AgentId::ClaudeCode => vec![
            "--bare",
            "-p",
            prompt,
            "--output-format",
            "stream-json",
            "--verbose",
            "--max-turns",
            "8",
            "--tools",
            "Read,Write,Edit",
            "--allowedTools",
            "Read,Write,Edit",
            "--permission-mode",
            "acceptEdits",
        ],
        AgentId::Codex => vec![
            "exec",
            "--skip-git-repo-check",
            "--ephemeral",
            "--json",
            "--dangerously-bypass-approvals-and-sandbox",
            "-C",
            &workspace_argument,
            prompt,
        ],
        AgentId::Hermes => vec![
            "chat",
            "--query",
            prompt,
            "--oneshot",
            "-Q",
            "--ignore-rules",
            "--max-turns",
            "8",
            "--run-budget",
            "90",
            "--format",
            "stream-json",
        ],
        AgentId::OhMyPi => vec![
            "-p",
            prompt,
            "--mode",
            "json",
            "--no-lsp",
            "--no-title",
            "--no-session",
            "--thinking",
            "off",
            "--max-time",
            "90",
            "--tools",
            "read,write,edit",
            "--auto-approve",
        ],
        AgentId::OpenCode => vec!["run", prompt, "--format", "json", "--pure", "--auto"],
        AgentId::Zcode => vec![
            "-p",
            prompt,
            "--output-format",
            "stream-json",
            "--mode",
            "yolo",
        ],
        AgentId::WorkBuddy => vec![
            "-p",
            prompt,
            "--no-session-persistence",
            "--output-format",
            "stream-json",
            "--verbose",
            "--max-turns",
            "5",
            "--tools",
            "Read,Write,Edit",
            "--permission-mode",
            "acceptEdits",
        ],
        AgentId::DeepSeekHarness => vec!["--json", prompt],
    };
    arguments.into_iter().map(str::to_owned).collect()
}

#[cfg(windows)]
fn system_command(name: &str) -> PathBuf {
    let system_root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    PathBuf::from(system_root).join("System32").join(name)
}

fn hidden(command: &mut Command) {
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW, with safe std/Tokio API.
    #[cfg(not(windows))]
    let _ = command;
}

fn execution_command(launcher: &Path, workspace: &Path, arguments: Vec<String>) -> Command {
    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new(system_command("WindowsPowerShell/v1.0/powershell.exe"));
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ]);
        command
    };
    #[cfg(not(windows))]
    let mut command = Command::new("/bin/sh");
    command
        .arg(launcher)
        .args(arguments)
        .current_dir(workspace)
        .env("PWD", workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    hidden(&mut command);
    #[cfg(unix)]
    command.process_group(0);
    command
}

async fn execute(
    agent: AgentId,
    launcher: &Path,
    workspace: &Path,
    arguments: Vec<String>,
) -> Capture {
    execute_command(
        execution_command(launcher, workspace, arguments),
        agent == AgentId::Codex,
    )
    .await
}

async fn execute_command(mut command: Command, codex_windows_exit_first: bool) -> Capture {
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            return Capture {
                launch_failed: true,
                ..Capture::default()
            }
        }
    };
    let owned_group = child.id();
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        terminate(&mut child, owned_group).await;
        return Capture {
            output_failed: true,
            ..Capture::default()
        };
    };
    let capture = capture_output_policy(
        stdout,
        stderr,
        child.wait(),
        RUN_TIMEOUT,
        codex_windows_exit_first,
    )
    .await;
    if capture.timed_out || capture.output_limit_exceeded || capture.output_failed {
        terminate(&mut child, owned_group).await;
    }
    capture
}

#[cfg(test)]
async fn capture_output(
    stdout: impl AsyncRead + Unpin,
    stderr: impl AsyncRead + Unpin,
    exit: impl std::future::Future<Output = io::Result<std::process::ExitStatus>>,
    timeout: Duration,
) -> Capture {
    capture_output_policy(stdout, stderr, exit, timeout, true).await
}

async fn capture_output_policy(
    stdout: impl AsyncRead + Unpin,
    stderr: impl AsyncRead + Unpin,
    exit: impl std::future::Future<Output = io::Result<std::process::ExitStatus>>,
    timeout: Duration,
    codex_windows_exit_first: bool,
) -> Capture {
    let mut stdout_output = Vec::new();
    let mut stderr_output = Vec::new();
    #[cfg(not(windows))]
    let _ = codex_windows_exit_first;
    let completed = tokio::time::timeout(timeout, async {
        #[cfg(windows)]
        if codex_windows_exit_first {
            let reads = async {
                tokio::try_join!(
                    read_bounded(stdout, &mut stdout_output),
                    read_bounded(stderr, &mut stderr_output),
                )?;
                Ok::<(), CaptureError>(())
            };
            tokio::pin!(reads);
            tokio::pin!(exit);
            return tokio::select! {
                // A ready read error must win over a simultaneously ready exit.
                biased;
                read_result = &mut reads => {
                    read_result?;
                    exit.await.map(|status| (status, false)).map_err(|_| CaptureError::Io)
                }
                status = &mut exit => {
                    let status = status.map_err(|_| CaptureError::Io)?;
                    // Descendants may inherit a pipe after the actual child exits.
                    // Drain briefly inside the original overall deadline, then drop
                    // only our readers; no external descendant is stopped.
                    match tokio::time::timeout(OUTPUT_DRAIN_GRACE, &mut reads).await {
                        Ok(result) => result.map(|()| (status, false)),
                        Err(_) => Ok((status, true)),
                    }
                }
            };
        }
        tokio::try_join!(
            read_bounded(stdout, &mut stdout_output),
            read_bounded(stderr, &mut stderr_output),
        )?;
        // Launchers other than Codex can exit before their daemon emits its
        // output. Keep their original EOF-before-wait policy; on Unix the
        // unreaped leader also anchors the owned group until timeout cleanup.
        exit.await
            .map(|status| (status, false))
            .map_err(|_| CaptureError::Io)
    })
    .await;
    match completed {
        Ok(Ok((status, inherited_pipes_open))) => Capture {
            stdout: stdout_output,
            stderr: stderr_output,
            exit_code: status.code(),
            process_succeeded: status.success(),
            inherited_pipes_open,
            ..Capture::default()
        },
        failed => Capture {
            stdout: stdout_output,
            stderr: stderr_output,
            timed_out: failed.is_err(),
            output_limit_exceeded: matches!(failed, Ok(Err(CaptureError::OutputLimit))),
            output_failed: matches!(failed, Ok(Err(CaptureError::Io))),
            ..Capture::default()
        },
    }
}

async fn read_bounded(
    mut reader: impl AsyncRead + Unpin,
    output: &mut Vec<u8>,
) -> std::result::Result<(), CaptureError> {
    let mut buffer = [0_u8; 8192];
    loop {
        let length = reader
            .read(&mut buffer)
            .await
            .map_err(|_| CaptureError::Io)?;
        if length == 0 {
            return Ok(());
        }
        if output.len() + length > OUTPUT_LIMIT {
            return Err(CaptureError::OutputLimit);
        }
        output.extend_from_slice(&buffer[..length]);
    }
}

async fn terminate(child: &mut Child, owned_group: Option<u32>) {
    // Only a still-owned child PID is handed to taskkill; no name-based or
    // global process termination is used. The official launcher waits for its CLI.
    #[cfg(windows)]
    if let Some(pid) = child.id() {
        let mut command = Command::new(system_command("taskkill.exe"));
        command
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        hidden(&mut command);
        let _ = tokio::time::timeout(TERMINATION_TIMEOUT, command.status()).await;
    }
    #[cfg(unix)]
    if let Some(group) = owned_group.filter(|group| *group > 1) {
        // execution_command creates a new group and launch.sh/core use exec,
        // so only this verification's descendants receive the signal.
        let mut command = Command::new("/bin/kill");
        command
            .args(["-KILL", "--", &format!("-{group}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let _ = tokio::time::timeout(TERMINATION_TIMEOUT, command.status()).await;
    }
    #[cfg(not(unix))]
    let _ = owned_group;
    let _ = child.start_kill();
    let _ = tokio::time::timeout(TERMINATION_TIMEOUT, child.wait()).await;
}

fn is_reparse(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    metadata.file_type().is_symlink()
}

fn create_owned_workspace(parent: &Path, directory: &Path, nonce: Uuid) -> io::Result<()> {
    let parent_metadata = fs::symlink_metadata(parent)?;
    if !parent_metadata.is_dir()
        || is_reparse(&parent_metadata)
        || directory != parent.join(format!(".ae-tool-verification-{nonce}"))
    {
        return Err(io::Error::other(
            "Unsafe verification parent or UUID directory",
        ));
    }
    fs::create_dir(directory)?;
    let marker = directory.join(".ae-verification-owner");
    let created = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&marker);
    match created {
        Ok(mut file) => {
            use std::io::Write;
            if let Err(error) = file.write_all(nonce.to_string().as_bytes()) {
                let _ = fs::remove_file(&marker);
                let _ = fs::remove_dir(directory);
                return Err(error);
            }
        }
        Err(error) => {
            let _ = fs::remove_dir(directory);
            return Err(error);
        }
    }
    if validate_owned_workspace(parent, directory, nonce) {
        Ok(())
    } else {
        Err(io::Error::other(
            "Owned verification directory validation failed",
        ))
    }
}

fn validate_owned_workspace(parent: &Path, directory: &Path, nonce: Uuid) -> bool {
    if directory != parent.join(format!(".ae-tool-verification-{nonce}")) {
        return false;
    }
    let Ok(metadata) = fs::symlink_metadata(directory) else {
        return false;
    };
    let Ok(parent_metadata) = fs::symlink_metadata(parent) else {
        return false;
    };
    if !metadata.is_dir() || is_reparse(&metadata) || is_reparse(&parent_metadata) {
        return false;
    }
    let (Ok(canonical_parent), Ok(canonical_directory)) =
        (parent.canonicalize(), directory.canonicalize())
    else {
        return false;
    };
    canonical_directory.parent() == Some(canonical_parent.as_path())
        && exact_owned_contents(
            directory,
            &directory.join(".ae-verification-owner"),
            &nonce.to_string(),
        )
}

fn cleanup_owned_workspace(
    agent: AgentId,
    parent: &Path,
    directory: &Path,
    nonce: Uuid,
    filename: &str,
) -> bool {
    let expected_filename = if agent == AgentId::OhMyPi {
        "probe.txt".to_owned()
    } else {
        format!(".ae-tool-verification-{nonce}.txt")
    };
    if filename != expected_filename
        || !validate_owned_workspace(parent, directory, nonce)
        || !cleanup_owned_artifact(agent, directory, &directory.join(filename), filename)
    {
        return false;
    }
    let Ok(mut entries) = fs::read_dir(directory) else {
        return false;
    };
    if entries
        .any(|entry| entry.map_or(true, |entry| entry.file_name() != ".ae-verification-owner"))
    {
        // Never recursively delete unexpected files, even inside an owned directory.
        return false;
    }
    fs::remove_file(directory.join(".ae-verification-owner")).is_ok()
        && fs::remove_dir(directory).is_ok()
}

fn exact_owned_contents(workspace: &Path, artifact: &Path, marker: &str) -> bool {
    let Ok(metadata) = fs::symlink_metadata(artifact) else {
        return false;
    };
    if !metadata.is_file() || is_reparse(&metadata) || metadata.len() != marker.len() as u64 {
        return false;
    }
    let (Ok(canonical_workspace), Ok(canonical_artifact)) =
        (workspace.canonicalize(), artifact.canonicalize())
    else {
        return false;
    };
    if canonical_artifact.parent() != Some(canonical_workspace.as_path()) {
        return false;
    }
    let Ok(file) = File::open(artifact) else {
        return false;
    };
    let mut contents = Vec::new();
    file.take(marker.len() as u64 + 1)
        .read_to_end(&mut contents)
        .is_ok()
        && contents == marker.as_bytes()
}

fn cleanup_owned_artifact(
    agent: AgentId,
    workspace: &Path,
    artifact: &Path,
    filename: &str,
) -> bool {
    if artifact != workspace.join(filename)
        || if agent == AgentId::OhMyPi {
            filename != "probe.txt"
        } else {
            !filename.starts_with(".ae-tool-verification-")
                || !filename.ends_with(".txt")
                || Uuid::parse_str(&filename[22..filename.len() - 4]).is_err()
        }
    {
        return false;
    }
    let metadata = match fs::symlink_metadata(artifact) {
        Ok(metadata) => metadata,
        Err(error) => return error.kind() == io::ErrorKind::NotFound,
    };
    if !metadata.is_file() || is_reparse(&metadata) {
        return false;
    }
    let (Ok(canonical_workspace), Ok(canonical_artifact)) =
        (workspace.canonicalize(), artifact.canonicalize())
    else {
        return false;
    };
    if canonical_artifact.parent() != Some(canonical_workspace.as_path()) {
        return false;
    }
    fs::remove_file(artifact).is_ok()
}

fn parse_events(stdout: &[u8]) -> Vec<Value> {
    if let Ok(event) = serde_json::from_slice(stdout) {
        return vec![event];
    }
    stdout
        .split(|byte| *byte == b'\n')
        .filter_map(|line| serde_json::from_slice(line).ok())
        .collect()
}

fn text_content(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_owned();
    }
    content
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter(|part| part["type"] == "text")
                .filter_map(|part| part["text"].as_str())
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

fn assistant_marker(agent: AgentId, events: &[Value], marker: &str) -> bool {
    if agent == AgentId::DeepSeekHarness {
        if events
            .iter()
            .any(|event| !deepseek_user_event(event) && event["truncated"] == true)
        {
            return false;
        }
        if let Some(event) = events
            .iter()
            .rev()
            .find(|event| event["type"] == "final" && !deepseek_user_event(event))
        {
            return event["text"]
                .as_str()
                .is_some_and(|text| text.trim() == marker);
        }
        let text: String = events
            .iter()
            .filter(|event| event["type"] == "text" && !deepseek_user_event(event))
            .filter_map(|event| event["text"].as_str())
            .collect();
        return text.trim() == marker;
    }
    let mut texts = Vec::new();
    for event in events {
        let text = match agent {
            AgentId::ClaudeCode | AgentId::WorkBuddy
                if event["type"] == "result" && event["is_error"] != true =>
            {
                event["result"].as_str().map(str::to_owned)
            }
            AgentId::Codex
                if event["type"] == "item.completed"
                    && event["item"]["type"] == "agent_message" =>
            {
                event["item"]["text"].as_str().map(str::to_owned)
            }
            AgentId::Hermes
                if event["type"] == "result"
                    && event["error"].is_null()
                    && event["exit_code"] == 0 =>
            {
                event["text"].as_str().map(str::to_owned)
            }
            AgentId::OhMyPi
                if event["type"] == "message_end" && event["message"]["role"] == "assistant" =>
            {
                Some(text_content(&event["message"]["content"]))
            }
            AgentId::OpenCode
                if event["type"] == "text"
                    && event["part"]["type"] == "text"
                    && event["part"]["role"] != "user" =>
            {
                event["part"]["text"].as_str().map(str::to_owned)
            }
            AgentId::Zcode
                if event["type"] == "result"
                    && event["is_error"] != true
                    && event["error"].is_null() =>
            {
                event["response"].as_str().map(str::to_owned)
            }
            _ => None,
        };
        if let Some(text) = text {
            texts.push(text);
        }
    }
    texts.iter().any(|text| text.trim() == marker)
        || (agent == AgentId::OpenCode && texts.join("").trim() == marker)
}

fn observed_tools<'a>(value: &'a Value, observed: &mut Vec<&'a Value>) {
    match value {
        Value::Array(items) => items.iter().for_each(|item| observed_tools(item, observed)),
        Value::Object(object) => {
            let kind = value["type"]
                .as_str()
                .or_else(|| value["kind"].as_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if kind.contains("tool") || kind == "command_execution" || kind == "file_change" {
                observed.push(value);
            }
            object
                .values()
                .for_each(|item| observed_tools(item, observed));
        }
        _ => {}
    }
}

fn tool_id(value: &Value) -> Option<&str> {
    ["toolCallId", "tool_call_id", "tool_use_id", "call_id", "id"]
        .into_iter()
        .find_map(|key| value[key].as_str())
}

fn tool_name(value: &Value) -> &str {
    ["name", "tool", "toolName", "tool_name"]
        .into_iter()
        .find_map(|key| value[key].as_str())
        .unwrap_or("")
}

fn operations(value: &Value) -> (bool, bool) {
    let name = tool_name(value).to_ascii_lowercase();
    let kind = value["type"]
        .as_str()
        .or_else(|| value["kind"].as_str())
        .unwrap_or("");
    let shell_tool = kind == "command_execution"
        || matches!(
            name.as_str(),
            "bash"
                | "shell"
                | "terminal"
                | "execute"
                | "execute_command"
                | "shell_command"
                | "terminal_tool"
        );
    let text = if shell_tool {
        ["command", "cmd"]
            .into_iter()
            .find_map(|key| {
                value[key]
                    .as_str()
                    .or_else(|| value["input"][key].as_str())
                    .or_else(|| value["arguments"][key].as_str())
                    .or_else(|| value["args"][key].as_str())
            })
            .unwrap_or("")
            .to_ascii_lowercase()
    } else {
        String::new()
    };
    let write = matches!(
        name.as_str(),
        "write" | "edit" | "write_file" | "patch" | "apply_patch"
    ) || kind == "file_change"
        || [
            "set-content",
            "writealltext",
            "out-file",
            "write_text",
            "writefile",
        ]
        .iter()
        .any(|operation| text.contains(operation))
        || ((text.contains("cat ") || text.contains("printf ")) && text.contains('>'));
    let read = matches!(name.as_str(), "read" | "read_file")
        || [
            "get-content",
            "readalltext",
            "read_text",
            "readfile",
            "cat ",
            "type ",
        ]
        .iter()
        .any(|operation| text.contains(operation));
    (write, read)
}

fn returned_marker(value: &Value, marker: &str) -> bool {
    if value["is_error"] == true
        || value["isError"] == true
        || value["success"] == false
        || value["result"]["success"] == false
        || !value["error"].is_null()
        || !value["state"]["error"].is_null()
        || [
            &value["status"],
            &value["state"]["status"],
            &value["result"]["status"],
        ]
        .into_iter()
        .filter_map(Value::as_str)
        .any(|status| {
            matches!(
                status,
                "failed"
                    | "error"
                    | "cancelled"
                    | "canceled"
                    | "timed_out"
                    | "incomplete"
                    | "aborted"
                    | "denied"
            )
        })
    {
        return false;
    }
    let kind = value["type"]
        .as_str()
        .or_else(|| value["kind"].as_str())
        .unwrap_or("");
    if !(kind.contains("result")
        || kind.contains("end")
        || kind.contains("completed")
        || value["status"] == "completed"
        || value["state"]["status"] == "completed")
    {
        return false;
    }
    let mut returned = vec![
        &value["output"],
        &value["result"],
        &value["aggregated_output"],
        &value["state"]["output"],
    ];
    if kind.contains("result") || kind.contains("end") || kind.contains("completed") {
        returned.push(&value["content"]);
    }
    returned
        .into_iter()
        .any(|item| !item.is_null() && item.to_string().contains(marker))
}

fn hermes_named_readback(observed: &[&Value], filename: &str, marker: &str) -> bool {
    // The official Hermes normal progress callback lacks IDs. Pair only
    // one outstanding same-name call; overlapping calls invalidate that
    // whole ambiguous batch until all its completions have drained.
    let mut pending: HashMap<&str, Vec<(Option<&str>, bool)>> = HashMap::new();
    for value in observed {
        let name = tool_name(value);
        if name.is_empty() {
            continue;
        }
        if value["type"] == "tool_use" {
            pending.entry(name).or_default().push((
                tool_id(value),
                value["input"].is_object()
                    && value["input"].to_string().contains(filename)
                    && operations(value).1,
            ));
        } else if value["type"] == "tool_result" {
            let Some(calls) = pending.get_mut(name) else {
                continue;
            };
            if let Some(id) = tool_id(value) {
                if let Some(index) = calls.iter().position(|(call_id, _)| *call_id == Some(id)) {
                    calls.remove(index);
                }
            } else if calls.len() == 1 {
                if calls.pop().is_some_and(|(_, related_read)| related_read)
                    && returned_marker(value, marker)
                {
                    return true;
                }
            } else if calls.len() > 1 {
                calls
                    .iter_mut()
                    .for_each(|(_, related_read)| *related_read = false);
                calls.pop();
            }
        }
    }
    false
}

fn deepseek_user_event(event: &Value) -> bool {
    event["type"] == "user" || event["role"] == "user" || event["message"]["role"] == "user"
}

fn codex_terminal_completed(events: &[Value]) -> bool {
    events
        .iter()
        .rev()
        .find(|event| {
            matches!(
                event["type"].as_str(),
                Some("turn.completed" | "turn.failed" | "error")
            )
        })
        .is_some_and(|event| event["type"] == "turn.completed")
}

fn deepseek_terminal_completed(events: &[Value]) -> bool {
    !events
        .iter()
        .any(|event| !deepseek_user_event(event) && event["truncated"] == true)
        && events
            .iter()
            .rev()
            .find(|event| event["type"] == "status" && !deepseek_user_event(event))
            .is_some_and(|event| {
                // Bundled dsh-headless projects the durable TurnEndReason
                // object unchanged; successful completion is its kind field.
                event["phase"] == "turn_end" && event["reason"]["kind"] == "completed"
            })
}

fn deepseek_tool_evidence(events: &[Value], expected_file: &str, marker: &str) -> Evidence {
    let mut evidence = Evidence::default();
    let mut id_counts = HashMap::new();
    let mut result_counts = HashMap::new();
    for event in events.iter().filter(|event| !deepseek_user_event(event)) {
        if let Some(id) = event["callId"].as_str().filter(|id| !id.is_empty()) {
            if event["type"] == "tool_call" {
                *id_counts.entry(id).or_insert(0) += 1;
            }
            if event["type"] == "tool_result" {
                *result_counts.entry(id).or_insert(0) += 1;
            }
        }
    }
    if events
        .iter()
        .any(|event| !deepseek_user_event(event) && event["truncated"] == true)
    {
        return evidence;
    }
    let mut calls: HashMap<&str, &Value> = HashMap::new();
    for event in events {
        if deepseek_user_event(event) {
            continue;
        }
        let kind = event["type"].as_str().unwrap_or("");
        if !matches!(kind, "tool_call" | "tool_result") {
            continue;
        }
        evidence.event_count += 1;
        let id = event["callId"].as_str().filter(|id| !id.is_empty());
        if kind == "tool_call" {
            if let Some(id) = id {
                calls.insert(id, event);
            }
        }
        let call = if kind == "tool_call" {
            Some(event)
        } else {
            id.and_then(|id| calls.get(id).copied())
        };
        let name = call.and_then(|call| call["tool"].as_str()).unwrap_or("");
        let related = call
            .and_then(|call| call["input"]["file_path"].as_str())
            .is_some_and(|file| Path::new(file) == Path::new(expected_file));
        let write = matches!(name, "write" | "edit");
        let read = name == "read";
        let completed = kind == "tool_result"
            && event["status"] == "completed"
            && id.is_some_and(|id| {
                id_counts.get(id) == Some(&1) && result_counts.get(id) == Some(&1)
            });
        let returned = related
            && read
            && completed
            && event["result"]
                .as_str()
                .is_some_and(|text| text.contains(marker));
        if related {
            evidence.related_event_count += 1;
            evidence.write_observed |= write && completed;
            evidence.read_observed |= read && completed;
            evidence.readback_marker_observed |= returned;
        }
        if evidence.tool_event_shapes.len() < TOOL_EVENT_SHAPE_LIMIT {
            let mut input_keys: Vec<_> = event["input"]
                .as_object()
                .into_iter()
                .flat_map(|input| input.keys())
                .take(TOOL_INPUT_KEY_LIMIT)
                .cloned()
                .collect();
            input_keys.sort_unstable();
            evidence.tool_event_shapes.push(ToolEventShape {
                kind: kind.into(),
                name: name.into(),
                input_keys,
                has_id: id.is_some(),
                related_to_filename: related,
                write_operation: write,
                read_operation: read,
                returned_marker: returned,
            });
        }
    }
    evidence
}

fn tool_evidence(agent: AgentId, events: &[Value], filename: &str, marker: &str) -> Evidence {
    if agent == AgentId::DeepSeekHarness {
        return deepseek_tool_evidence(events, filename, marker);
    }
    let mut observed = Vec::new();
    for event in events {
        if event["type"] == "user" || event["role"] == "user" || event["message"]["role"] == "user"
        {
            // Official Claude/WorkBuddy results arrive inside user-role
            // envelopes. Only correlated tool_result blocks are eligible;
            // ordinary user text and other nested objects remain excluded.
            if let Some(content) = event["message"]["content"]
                .as_array()
                .or_else(|| event["content"].as_array())
            {
                observed.extend(
                    content
                        .iter()
                        .filter(|block| block["type"] == "tool_result" && tool_id(block).is_some()),
                );
            }
        } else if agent == AgentId::Zcode && event["type"] == "tool.updated" {
            // Official Zcode emits the lifecycle fields inside payload.
            // Scheduled input identifies the filename; result carries the ID.
            let payload = &event["payload"];
            if matches!(
                payload["kind"].as_str(),
                Some("scheduled" | "started" | "progress" | "result" | "error" | "batch")
            ) {
                observed.push(payload);
            }
        } else {
            observed_tools(event, &mut observed);
        }
    }
    let related: Vec<_> = observed
        .iter()
        .copied()
        .filter(|item| item.to_string().contains(filename))
        .collect();
    let read_ids: Vec<_> = related
        .iter()
        .filter(|item| operations(item).1)
        .filter_map(|item| tool_id(item))
        .collect();
    Evidence {
        event_count: observed.len(),
        related_event_count: related.len(),
        // Diagnostic projection only; acceptance still considers every event.
        tool_event_shapes: observed
            .iter()
            .take(TOOL_EVENT_SHAPE_LIMIT)
            .map(|item| {
                let (write_operation, read_operation) = operations(item);
                let mut input_keys: Vec<_> = ["input", "arguments", "args"]
                    .into_iter()
                    .filter_map(|key| item[key].as_object())
                    .flat_map(|input| input.keys())
                    .take(TOOL_INPUT_KEY_LIMIT)
                    .cloned()
                    .collect();
                input_keys.sort_unstable();
                input_keys.dedup();
                ToolEventShape {
                    kind: item["type"]
                        .as_str()
                        .or_else(|| item["kind"].as_str())
                        .unwrap_or("")
                        .to_owned(),
                    name: tool_name(item).to_owned(),
                    input_keys,
                    has_id: tool_id(item).is_some(),
                    related_to_filename: item.to_string().contains(filename),
                    write_operation,
                    read_operation,
                    returned_marker: returned_marker(item, marker),
                }
            })
            .collect(),
        write_observed: related.iter().any(|item| operations(item).0),
        read_observed: related.iter().any(|item| operations(item).1),
        readback_marker_observed: observed.iter().any(|item| {
            if agent == AgentId::Hermes && item["type"] == "tool_result" && tool_id(item).is_none()
            {
                // Name-only Hermes results must go through the unique-pending
                // check even when output happens to repeat the filename.
                return false;
            }
            let related_read = (item.to_string().contains(filename) && operations(item).1)
                || tool_id(item).is_some_and(|id| read_ids.contains(&id));
            related_read && returned_marker(item, marker)
        }) || (agent == AgentId::Hermes
            && hermes_named_readback(&observed, filename, marker)),
        ..Evidence::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::process::ExitStatusExt;
    #[cfg(windows)]
    use std::os::windows::process::ExitStatusExt;

    #[cfg(windows)]
    #[tokio::test]
    async fn verification_launcher_process_pwd_matches_workspace() {
        let temporary = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
        let workspace = temporary.path().join("verification workspace");
        fs::create_dir(&workspace).unwrap();
        let launcher = temporary.path().join("launcher.ps1");
        fs::write(&launcher, r#"[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[pscustomobject]@{pwd=$env:PWD;cwd=[IO.Directory]::GetCurrentDirectory()} | ConvertTo-Json -Compress"#).unwrap();
        let output = execution_command(&launcher, &workspace, vec![])
            .output()
            .await
            .unwrap();
        assert!(output.status.success());
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(value["cwd"], workspace.to_string_lossy().as_ref());
        assert_eq!(value["pwd"], workspace.to_string_lossy().as_ref());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn existing_codex_uses_stable_parent_and_cleans_exact_absolute_uuid_file() {
        let temporary = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
        let root = temporary.path().join("中文 空格 $literal owned");
        let home = root.join("native-home");
        let profile_directory = home.join(".codex");
        let workspace = root.join("original-workspace");
        fs::create_dir_all(&profile_directory).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        let config = profile_directory.join("config.toml");
        let history = profile_directory.join("user-history.keep");
        let notes = workspace.join("notes.txt");
        fs::write(&config, "model = \"original-native-model\"\n").unwrap();
        fs::write(&history, "original profile bytes").unwrap();
        fs::write(&notes, "original workspace bytes").unwrap();
        let entry = root.join("codex.ps1");
        // This process fixture checks the actual CLI cwd, -C, native profile,
        // absolute target and strict cleanup. It is not official-client proof.
        fs::write(
            &entry,
            r#"$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$arguments = @($args)
if ($arguments[0] -ne 'exec' -or $arguments -contains '--model') { exit 10 }
$changeDirectoryIndex = [Array]::IndexOf($arguments, '-C')
if ($changeDirectoryIndex -lt 0) { exit 11 }
$executionWorkspace = $arguments[$changeDirectoryIndex + 1]
if ($executionWorkspace -ne [IO.Directory]::GetCurrentDirectory() -or $env:PWD -ne $executionWorkspace) { exit 12 }
if ([IO.Path]::GetFileName($executionWorkspace) -ne 'codex') { exit 13 }
if ($env:CODEX_HOME -ne (Join-Path $env:HOME '.codex')) { exit 14 }
$prompt = $arguments[-1]
$target = [regex]::Match($prompt, '^Only operate on the verification file (.+?) inside the already-created owned verification directory\.').Groups[1].Value
if (-not [IO.Path]::IsPathRooted($target)) { exit 15 }
$ownedDirectory = [IO.Path]::GetDirectoryName($target)
if ([IO.Path]::GetDirectoryName($ownedDirectory) -ne $executionWorkspace) { exit 16 }
if ([IO.Path]::GetFileName($ownedDirectory) -notmatch '^\.ae-tool-verification-[0-9a-f-]{36}$') { exit 17 }
if (-not [IO.File]::Exists((Join-Path $ownedDirectory '.ae-verification-owner')) -or [IO.File]::Exists($target)) { exit 18 }
$marker = [regex]::Match($prompt, 'AE_TOOL_VERIFIED_[0-9a-f]{32}').Value
if (-not $marker) { exit 19 }
[IO.File]::WriteAllText($target, $marker + [char]10, [Text.UTF8Encoding]::new($false))
$readback = [IO.File]::ReadAllText($target)
@{ type = 'item.completed'; item = @{ id = 'write-1'; type = 'command_execution'; command = "[IO.File]::WriteAllText('$target', '$marker')"; aggregated_output = ''; exit_code = 0; status = 'completed' } } | ConvertTo-Json -Depth 8 -Compress
@{ type = 'item.completed'; item = @{ id = 'read-1'; type = 'command_execution'; command = "[IO.File]::ReadAllText('$target')"; aggregated_output = $readback; exit_code = 0; status = 'completed' } } | ConvertTo-Json -Depth 8 -Compress
@{ type = 'item.completed'; item = @{ id = 'reply-1'; type = 'agent_message'; text = $readback } } | ConvertTo-Json -Depth 8 -Compress
@{ type = 'turn.completed' } | ConvertTo-Json -Compress
exit 0
"#,
        )
        .unwrap();
        let profile = ExistingProfile {
            directory: profile_directory.to_string_lossy().into(),
            home_directory: home.to_string_lossy().into(),
            workspace_directory: workspace.to_string_lossy().into(),
            executable_path: entry.to_string_lossy().into(),
            ..Default::default()
        };
        let result = verify_selected(
            root.clone(),
            AgentId::Codex,
            "selected".into(),
            vec![],
            Some(profile),
        )
        .await
        .unwrap();
        assert_eq!(result["stage"], "verified", "{result}");
        assert_eq!(result["ok"], true);
        for flag in [
            "writeObserved",
            "readObserved",
            "readbackMarkerObserved",
            "assistantMarkerObserved",
            "fileMatchesMarker",
            "processSucceeded",
        ] {
            assert_eq!(result["evidence"][flag], true, "{flag}");
        }
        assert_eq!(result["cleanup"]["removed"], true);
        assert_eq!(result["explicitModelArgument"], false);
        assert_eq!(result["profileMode"], "existing");
        assert_eq!(
            fs::read(&config).unwrap(),
            b"model = \"original-native-model\"\n"
        );
        assert_eq!(fs::read(&history).unwrap(), b"original profile bytes");
        assert_eq!(fs::read(&notes).unwrap(), b"original workspace bytes");
        assert_eq!(
            fs::read_dir(root.join("agent-verification/codex"))
                .unwrap()
                .count(),
            0
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn existing_opencode_patch_uses_exact_single_lf_and_retains_profile() {
        let temporary = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
        let root = temporary.path().join("中文 空格 owned");
        let home = root.join("native-home");
        let profile_directory = home.join(".config/opencode");
        let workspace = root.join("original-workspace");
        fs::create_dir_all(&profile_directory).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        let history = profile_directory.join("user-history.keep");
        let notes = workspace.join("notes.txt");
        fs::write(&history, "original profile bytes").unwrap();
        fs::write(&notes, "original workspace bytes").unwrap();
        let entry = root.join("opencode.ps1");
        // A process fixture checks the actual arguments and performs a real
        // write/read. It is not an official-client acceptance receipt.
        fs::write(
            &entry,
            r#"$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$arguments = @($args)
if ($arguments[0] -ne 'run' -or $arguments -contains '--pure') { exit 10 }
$prompt = $arguments[1]
$target = [regex]::Match($prompt, '^Only operate on the verification file (.+?) inside the already-created owned verification directory\.').Groups[1].Value
if (-not [IO.Path]::IsPathRooted($target)) { exit 11 }
$parent = [IO.Path]::GetDirectoryName($target)
if ($parent -ne [IO.Directory]::GetCurrentDirectory()) { exit 12 }
if (-not [IO.Directory]::Exists($parent) -or [IO.File]::Exists($target)) { exit 13 }
$marker = [regex]::Match($prompt, 'AE_TOOL_VERIFIED_[0-9a-f]{32}').Value
if (-not $marker) { exit 14 }
if ($prompt -notmatch 'exactly one LF byte') { exit 15 }
[IO.File]::WriteAllText($target, $marker + [char]10, [Text.UTF8Encoding]::new($false))
$readback = [IO.File]::ReadAllText($target)
@{ type = 'tool_use'; part = @{ type = 'tool'; id = 'write-1'; tool = 'apply_patch'; state = @{ status = 'completed'; input = @{ patchText = "*** Begin Patch`n*** Add File: $target`n+$marker`n*** End Patch" }; output = 'Patch successful' } } } | ConvertTo-Json -Depth 8 -Compress
@{ type = 'tool_use'; part = @{ type = 'tool'; id = 'read-1'; tool = 'read'; state = @{ status = 'completed'; input = @{ filePath = $target }; output = $readback } } } | ConvertTo-Json -Depth 8 -Compress
@{ type = 'text'; part = @{ type = 'text'; text = $readback } } | ConvertTo-Json -Depth 8 -Compress
exit 0
"#,
        )
        .unwrap();
        let profile = ExistingProfile {
            directory: profile_directory.to_string_lossy().into(),
            home_directory: home.to_string_lossy().into(),
            workspace_directory: workspace.to_string_lossy().into(),
            executable_path: entry.to_string_lossy().into(),
            ..Default::default()
        };
        let result = verify_selected(
            root.clone(),
            AgentId::OpenCode,
            "selected".into(),
            vec![],
            Some(profile),
        )
        .await
        .unwrap();
        assert_eq!(result["stage"], "verified", "{result}");
        assert_eq!(result["ok"], true);
        for flag in [
            "writeObserved",
            "readObserved",
            "readbackMarkerObserved",
            "assistantMarkerObserved",
            "fileMatchesMarker",
            "processSucceeded",
        ] {
            assert_eq!(result["evidence"][flag], true, "{flag}");
        }
        assert_eq!(result["cleanup"]["removed"], true);
        assert_eq!(result["profileMode"], "existing");
        assert_eq!(fs::read(&history).unwrap(), b"original profile bytes");
        assert_eq!(fs::read(&notes).unwrap(), b"original workspace bytes");
        assert_eq!(
            fs::read_dir(root.join("agent-verification/opencode"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn opencode_absolute_tool_paths_still_require_an_independent_readback() {
        let filename = ".ae-tool-verification-00000000-0000-0000-0000-000000000000.txt";
        let absolute = format!(r"G:\owned 中文 空格\{filename}");
        let write = json!({"type":"tool_use","part":{"type":"tool","id":"write-1","tool":"write","state":{"status":"completed","input":{"filePath":absolute,"content":"MARKER"},"output":"Write successful"}}});
        let read = json!({"type":"tool_use","part":{"type":"tool","id":"read-1","tool":"read","state":{"status":"completed","input":{"filePath":absolute},"output":"MARKER"}}});
        let reply = json!({"type":"text","part":{"type":"text","text":"MARKER"}});
        for (events, should_pass) in [
            (vec![write.clone(), read.clone(), reply.clone()], true),
            (vec![write.clone(), reply.clone()], false),
            (
                vec![
                    write.clone(),
                    json!({"type":"tool_use","part":{"type":"tool","id":"unrelated-read","tool":"read","state":{"status":"completed","input":{"filePath":"different.txt"},"output":"MARKER"}}}),
                    reply.clone(),
                ],
                false,
            ),
            (
                vec![
                    write,
                    json!({"type":"tool_use","part":{"type":"tool","id":"read-1","tool":"read","state":{"status":"error","input":{"filePath":absolute},"output":"MARKER"}}}),
                    reply,
                ],
                false,
            ),
        ] {
            let mut evidence = tool_evidence(AgentId::OpenCode, &events, filename, "MARKER");
            evidence.assistant_marker_observed =
                assistant_marker(AgentId::OpenCode, &events, "MARKER");
            evidence.file_matches_marker = true;
            assert_eq!(evidence.verified(true), should_pass);
            assert!(!evidence.verified(false));
        }
    }

    #[tokio::test]
    async fn existing_workbuddy_desktop_entry_is_not_launched_for_headless_verification() {
        let temporary = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
        let home = temporary.path().join("native-home");
        let workspace = temporary.path().join("original-workspace");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        let entry = temporary.path().join("WorkBuddy.exe");
        fs::write(&entry, "desktop fixture, never executed").unwrap();
        let profile = ExistingProfile {
            directory: home.to_string_lossy().into(),
            home_directory: home.to_string_lossy().into(),
            workspace_directory: workspace.to_string_lossy().into(),
            executable_path: entry.to_string_lossy().into(),
            ..Default::default()
        };
        let result = verify_selected(
            temporary.path().to_owned(),
            AgentId::WorkBuddy,
            "selected".into(),
            vec![],
            Some(profile),
        )
        .await
        .unwrap();
        assert_eq!(result["ok"], false);
        assert_eq!(result["toolVerified"], false);
        assert_eq!(result["stage"], "unsupported");
        assert_eq!(result["clientSurface"], "desktop-gui");
        assert_eq!(result["desktopGuiVerified"], false);
        assert_eq!(result["desktopDefaultSelectionVerified"], false);
        assert_eq!(result["explicitModelArgument"], false);
        assert!(!temporary.path().join("agent-verification").exists());
        assert_eq!(fs::read_dir(&workspace).unwrap().count(), 0);
    }

    #[test]
    fn launcher_command_preserves_paths_and_arguments_without_shell_interpolation() {
        let temporary = tempfile::tempdir().unwrap();
        let launcher = temporary.path().join("中文 空格 $literal/launch.sh");
        let workspace = temporary.path().join("workspace");
        let arguments = vec!["--prompt".into(), "$(touch outside); 'literal'".into()];
        let command = execution_command(&launcher, &workspace, arguments.clone());
        let command = command.as_std();
        let actual: Vec<_> = command.get_args().map(|value| value.to_owned()).collect();
        assert!(actual.ends_with(
            &arguments
                .iter()
                .map(std::ffi::OsString::from)
                .collect::<Vec<_>>()
        ));
        assert_eq!(actual[actual.len() - 3], launcher.as_os_str());
        assert_eq!(command.get_current_dir(), Some(workspace.as_path()));
        #[cfg(unix)]
        assert_eq!(command.get_program(), "/bin/sh");
        #[cfg(windows)]
        assert_eq!(
            command.get_program(),
            system_command("WindowsPowerShell/v1.0/powershell.exe")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn process_is_not_reaped_while_a_descendant_can_hold_an_output_pipe() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let exit_polled = AtomicBool::new(false);
        let (_writer, reader) = tokio::io::duplex(32);
        let exit = async {
            exit_polled.store(true, Ordering::SeqCst);
            Ok(std::process::ExitStatus::from_raw(0))
        };
        let capture =
            capture_output(reader, tokio::io::empty(), exit, Duration::from_millis(20)).await;
        assert!(capture.timed_out);
        assert!(!exit_polled.load(Ordering::SeqCst));
    }

    fn fixture() -> Vec<Value> {
        vec![
            json!({"type":"tool_use","id":"write-1","name":"Write","input":{"file_path":"owned.txt","content":"MARKER"}}),
            json!({"type":"tool_use","id":"read-1","name":"Read","input":{"file_path":"owned.txt"}}),
            json!({"type":"tool_result","tool_use_id":"read-1","content":"MARKER"}),
            json!({"type":"result","is_error":false,"result":"MARKER"}),
        ]
    }

    #[test]
    fn controlled_fixture_requires_every_independent_condition() {
        let events = fixture();
        let mut evidence = tool_evidence(AgentId::ClaudeCode, &events, "owned.txt", "MARKER");
        evidence.assistant_marker_observed =
            assistant_marker(AgentId::ClaudeCode, &events, "MARKER");
        evidence.file_matches_marker = true;
        assert!(evidence.verified(true));
        assert!(!evidence.verified(false));
        evidence.file_matches_marker = false;
        assert!(!evidence.verified(true));
    }

    fn deepseek_fixture() -> (String, Vec<Value>) {
        let file = std::env::temp_dir()
            .join("ae-owned/.ae-tool-verification-00000000-0000-0000-0000-000000000000.txt")
            .to_string_lossy()
            .into_owned();
        let events = vec![
            json!({"type":"session","sessionId":"fixture"}),
            json!({"type":"tool_call","callId":"write-1","tool":"write","input":{"file_path":file,"content":"MARKER"}}),
            json!({"type":"tool_result","callId":"write-1","status":"completed","result":"written"}),
            json!({"type":"tool_call","callId":"read-1","tool":"read","input":{"file_path":file}}),
            json!({"type":"tool_result","callId":"read-1","status":"completed","result":"1: MARKER"}),
            json!({"type":"text","text":"MARKER"}),
            json!({"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}),
            json!({"type":"final","text":"MARKER"}),
        ];
        (file, events)
    }

    #[test]
    fn deepseek_official_json_requires_every_gate_and_terminal_completion() {
        let (file, events) = deepseek_fixture();
        let mut evidence = tool_evidence(AgentId::DeepSeekHarness, &events, &file, "MARKER");
        evidence.assistant_marker_observed =
            assistant_marker(AgentId::DeepSeekHarness, &events, "MARKER");
        assert!(
            evidence.write_observed && evidence.read_observed && evidence.readback_marker_observed
        );
        assert!(
            !evidence.verified(true),
            "event evidence cannot replace exact file contents"
        );
        evidence.file_matches_marker = true;
        let mut capture = Capture {
            process_succeeded: true,
            exit_code: Some(0),
            terminal_completion_required: true,
            terminal_completed_observed: deepseek_terminal_completed(&events),
            ..Capture::default()
        };
        assert_eq!(outcome(&capture, &evidence, true).0, "verified");
        assert_eq!(outcome(&capture, &evidence, false).0, "cleanup");
        let result = report(
            "model",
            &[],
            Instant::now(),
            &capture,
            &evidence,
            true,
            "verified",
            "verified",
        );
        assert_eq!(result["toolVerified"], true);
        assert_eq!(result["evidence"]["terminalCompletionRequired"], true);
        assert_eq!(result["toolEvidence"]["terminalCompletedObserved"], true);
        assert_eq!(result["toolEvidence"]["osSandboxEnabled"], false);
        capture.terminal_completed_observed = false;
        assert_eq!(outcome(&capture, &evidence, true).0, "tool");
        assert_eq!(
            report(
                "model",
                &[],
                Instant::now(),
                &capture,
                &evidence,
                true,
                "tool",
                "missing terminal"
            )["toolVerified"],
            false
        );
        capture.terminal_completed_observed = true;
        capture.process_succeeded = false;
        capture.exit_code = Some(1);
        assert_eq!(outcome(&capture, &evidence, true).0, "process");
        assert!(!evidence.verified(false));
        capture.process_succeeded = true;
        evidence.file_matches_marker = false;
        assert_eq!(outcome(&capture, &evidence, true).0, "tool");
    }

    #[test]
    fn deepseek_readback_rejects_failed_unpaired_wrong_path_and_write_echo_results() {
        let (file, events) = deepseek_fixture();
        let mut mutations = Vec::new();
        for status in ["error", "failed", "in_progress"] {
            let mut changed = events.clone();
            changed[4]["status"] = json!(status);
            mutations.push(changed);
        }
        let mut changed = events.clone();
        changed.remove(4);
        mutations.push(changed);
        let mut changed = events.clone();
        changed[4]["callId"] = json!("unrelated-read");
        mutations.push(changed);
        let mut changed = events.clone();
        changed[3]["input"]["file_path"] = json!(Path::new(&file).with_file_name("other.txt"));
        mutations.push(changed);
        let mut changed = events.clone();
        changed[4]["result"] = json!("no returned content");
        mutations.push(changed);
        let mut changed = events.clone();
        changed[4]["result"] = json!({"content":"MARKER"});
        mutations.push(changed);
        let mut changed = events.clone();
        changed[3]["tool"] = json!("write");
        mutations.push(changed);
        let mut changed = events.clone();
        changed.swap(3, 4);
        mutations.push(changed);
        for changed in mutations {
            assert!(
                !tool_evidence(AgentId::DeepSeekHarness, &changed, &file, "MARKER")
                    .readback_marker_observed
            );
        }
        let calls_only = vec![events[1].clone(), events[3].clone()];
        let evidence = tool_evidence(AgentId::DeepSeekHarness, &calls_only, &file, "MARKER");
        assert!(!evidence.write_observed && !evidence.read_observed);
    }

    #[test]
    fn deepseek_duplicate_call_or_result_ids_cannot_retain_success() {
        let (file, events) = deepseek_fixture();
        for duplicate in [
            events[3].clone(),
            events[4].clone(),
            json!({"type":"tool_result","callId":"read-1","status":"error","result":"MARKER"}),
        ] {
            let mut changed = events.clone();
            changed.push(duplicate);
            let evidence = tool_evidence(AgentId::DeepSeekHarness, &changed, &file, "MARKER");
            assert!(!evidence.read_observed && !evidence.readback_marker_observed);
        }
        for duplicate in [events[1].clone(), events[2].clone()] {
            let mut changed = events.clone();
            changed.push(duplicate);
            assert!(
                !tool_evidence(AgentId::DeepSeekHarness, &changed, &file, "MARKER").write_observed
            );
        }
    }

    #[test]
    fn deepseek_user_events_and_truncation_never_establish_evidence() {
        let (file, events) = deepseek_fixture();
        for nested in [false, true] {
            let changed: Vec<_> = events
                .iter()
                .cloned()
                .map(|mut event| {
                    if nested {
                        event["message"] = json!({"role":"user"});
                    } else {
                        event["role"] = json!("user");
                    }
                    event
                })
                .collect();
            let evidence = tool_evidence(AgentId::DeepSeekHarness, &changed, &file, "MARKER");
            assert!(
                !evidence.write_observed
                    && !evidence.read_observed
                    && !evidence.readback_marker_observed
            );
            assert!(!assistant_marker(
                AgentId::DeepSeekHarness,
                &changed,
                "MARKER"
            ));
            assert!(!deepseek_terminal_completed(&changed));
        }
        for index in 0..events.len() {
            let mut changed = events.clone();
            changed[index]["truncated"] = json!(true);
            assert!(
                !tool_evidence(AgentId::DeepSeekHarness, &changed, &file, "MARKER")
                    .readback_marker_observed
            );
            assert!(!assistant_marker(
                AgentId::DeepSeekHarness,
                &changed,
                "MARKER"
            ));
            assert!(!deepseek_terminal_completed(&changed));
        }
        let mut ignored = events.clone();
        ignored.push(json!({"type":"user","truncated":true,"text":"untrusted prompt"}));
        assert!(deepseek_terminal_completed(&ignored));
        assert!(assistant_marker(
            AgentId::DeepSeekHarness,
            &ignored,
            "MARKER"
        ));
    }

    #[test]
    fn deepseek_terminal_and_last_final_are_authoritative() {
        let (_, events) = deepseek_fixture();
        for reason in [
            "error",
            "aborted",
            "blocked",
            "max-tokens",
            "interrupted",
            "forked",
            "failed",
            "",
        ] {
            let mut changed = events.clone();
            changed[6]["reason"] = json!({"kind":reason});
            assert!(!deepseek_terminal_completed(&changed));
        }
        let mut changed = events.clone();
        changed.remove(6);
        assert!(!deepseek_terminal_completed(&changed));
        for status in [
            json!({"type":"status","phase":"turn_start","reason":{"kind":"completed"}}),
            json!({"type":"status","phase":"step_end","reason":{"kind":"completed"}}),
            json!({"type":"status","phase":"turn_end","reason":{"kind":"error"}}),
        ] {
            let mut changed = events.clone();
            changed.push(status);
            assert!(!deepseek_terminal_completed(&changed));
        }
        let mut changed = events.clone();
        changed[7]["text"] = json!("different final reply");
        assert!(!assistant_marker(
            AgentId::DeepSeekHarness,
            &changed,
            "MARKER"
        ));
        let mut changed = events.clone();
        changed.push(json!({"type":"final","text":"later reply"}));
        assert!(!assistant_marker(
            AgentId::DeepSeekHarness,
            &changed,
            "MARKER"
        ));
        assert!(assistant_marker(
            AgentId::DeepSeekHarness,
            &[
                json!({"type":"text","text":"MAR"}),
                json!({"type":"text","text":"KER"})
            ],
            "MARKER"
        ));
        assert!(!assistant_marker(
            AgentId::DeepSeekHarness,
            &[json!({"type":"tool_result","result":"MARKER"})],
            "MARKER"
        ));
    }

    #[test]
    fn deepseek_terminal_requires_the_official_reason_object() {
        let (_, events) = deepseek_fixture();
        assert!(deepseek_terminal_completed(&events));
        for invalid_reason in [
            Value::Null,
            json!("completed"),
            json!(true),
            json!(1),
            json!([{"kind":"completed"}]),
            json!({}),
            json!({"kind":null}),
            json!({"kind":true}),
            json!({"kind":1}),
            json!({"kind":["completed"]}),
            json!({"kind":{"kind":"completed"}}),
        ] {
            let mut changed = events.clone();
            changed[6]["reason"] = invalid_reason;
            assert!(!deepseek_terminal_completed(&changed));
        }
        let mut changed = events.clone();
        changed[6].as_object_mut().unwrap().remove("reason");
        assert!(!deepseek_terminal_completed(&changed));
    }

    #[test]
    fn deepseek_json_arguments_preserve_the_absolute_artifact_prompt_literally() {
        let (file, _) = deepseek_fixture();
        assert!(Path::new(&file).is_absolute());
        let prompt = verification_prompt(AgentId::DeepSeekHarness, &file, "MARKER");
        assert!(prompt.contains(&file));
        assert_eq!(
            arguments_for(
                AgentId::DeepSeekHarness,
                &prompt,
                Path::new("ignored workspace")
            ),
            vec!["--json".to_string(), prompt]
        );
    }

    #[test]
    fn prompt_echo_and_user_messages_never_prove_an_assistant_reply() {
        let events = vec![
            json!({"type":"user","content":"MARKER"}),
            json!({"type":"result","result":"Write MARKER then read it back"}),
        ];
        assert!(!assistant_marker(AgentId::ClaudeCode, &events, "MARKER"));
        assert!(!assistant_marker(AgentId::Codex, &events, "MARKER"));
        assert!(!assistant_marker(
            AgentId::OhMyPi,
            &[json!({"type":"message_end","message":{"role":"user","content":"MARKER"}})],
            "MARKER"
        ));
    }

    #[test]
    fn missing_tool_events_and_write_echo_cannot_prove_readback() {
        let events = vec![json!({"type":"result","result":"MARKER"})];
        let evidence = tool_evidence(AgentId::ClaudeCode, &events, "owned.txt", "MARKER");
        assert!(
            !evidence.write_observed
                && !evidence.read_observed
                && !evidence.readback_marker_observed
        );
        let mut events = fixture();
        events[2] = json!({"type":"tool_result","tool_use_id":"write-1","content":"MARKER"});
        assert!(
            !tool_evidence(AgentId::ClaudeCode, &events, "owned.txt", "MARKER")
                .readback_marker_observed
        );
        let echo = vec![
            json!({"type":"tool_result","name":"unrelated","content":"Set-Content owned.txt MARKER; Get-Content owned.txt","output":"MARKER"}),
        ];
        let echo_evidence = tool_evidence(AgentId::ClaudeCode, &echo, "owned.txt", "MARKER");
        assert!(
            !echo_evidence.write_observed
                && !echo_evidence.read_observed
                && !echo_evidence.readback_marker_observed
        );
    }

    fn codex_readalltext_fixture() -> Vec<Value> {
        // The real Codex retest emitted separate command_execution items for
        // WriteAllText and ReadAllText, with the marker in aggregated_output.
        let write = "powershell.exe -Command \"[System.IO.File]::WriteAllText('owned.txt', 'MARKER', (New-Object System.Text.UTF8Encoding($false)))\"";
        let read = "powershell.exe -Command \"$path = 'owned.txt'; [System.IO.File]::ReadAllText($path, (New-Object System.Text.UTF8Encoding($false)))\"";
        vec![
            json!({"type":"item.started","item":{"id":"item_14","type":"command_execution","command":write,"aggregated_output":"","exit_code":null,"status":"in_progress"}}),
            json!({"type":"item.completed","item":{"id":"item_14","type":"command_execution","command":write,"aggregated_output":"","exit_code":0,"status":"completed"}}),
            json!({"type":"item.started","item":{"id":"item_16","type":"command_execution","command":read,"aggregated_output":"","exit_code":null,"status":"in_progress"}}),
            json!({"type":"item.completed","item":{"id":"item_16","type":"command_execution","command":read,"aggregated_output":"MARKER\r\n","exit_code":0,"status":"completed"}}),
            json!({"type":"item.completed","item":{"id":"item_17","type":"agent_message","text":"MARKER"}}),
        ]
    }

    #[test]
    fn real_codex_readalltext_commands_establish_qualified_readback() {
        let events = codex_readalltext_fixture();
        let mut evidence = tool_evidence(AgentId::Codex, &events, "owned.txt", "MARKER");
        assert!(
            evidence.write_observed && evidence.read_observed && evidence.readback_marker_observed
        );
        evidence.assistant_marker_observed = assistant_marker(AgentId::Codex, &events, "MARKER");
        evidence.file_matches_marker = true;
        assert!(evidence.verified(true));

        // A completion may omit its command only when the read ID still pairs.
        let mut correlated = events;
        correlated[3]["item"]["command"] = Value::Null;
        assert!(
            tool_evidence(AgentId::Codex, &correlated, "owned.txt", "MARKER")
                .readback_marker_observed
        );
        correlated[3]["item"]["id"] = json!("unrelated-item");
        assert!(
            !tool_evidence(AgentId::Codex, &correlated, "owned.txt", "MARKER")
                .readback_marker_observed
        );
    }

    #[test]
    fn codex_readalltext_still_requires_successful_related_output() {
        for status in ["failed", "in_progress"] {
            let mut events = codex_readalltext_fixture();
            events[3]["item"]["status"] = json!(status);
            assert!(
                !tool_evidence(AgentId::Codex, &events, "owned.txt", "MARKER")
                    .readback_marker_observed
            );
        }
        let mut events = codex_readalltext_fixture();
        events[3]["item"]["aggregated_output"] = json!("");
        assert!(
            !tool_evidence(AgentId::Codex, &events, "owned.txt", "MARKER").readback_marker_observed
        );
        for index in [2, 3] {
            events[index]["item"]["command"] = json!("[IO.File]::ReadAllText('other.txt')");
        }
        events[3]["item"]["aggregated_output"] = json!("MARKER\r\n");
        let evidence = tool_evidence(AgentId::Codex, &events, "owned.txt", "MARKER");
        assert!(!evidence.read_observed && !evidence.readback_marker_observed);

        let echo = vec![json!({"type":"item.completed","item":{
            "id":"write-only","type":"command_execution","status":"completed","exit_code":0,
            "command":"[IO.File]::WriteAllText('owned.txt', 'MARKER'); Write-Output 'MARKER'",
            "aggregated_output":"MARKER\r\n"
        }})];
        let evidence = tool_evidence(AgentId::Codex, &echo, "owned.txt", "MARKER");
        assert!(evidence.write_observed);
        assert!(!evidence.read_observed && !evidence.readback_marker_observed);
    }

    #[test]
    fn official_user_wrapped_tool_results_are_correlated_without_accepting_user_text() {
        // Official WorkBuddy/Claude stream JSON wraps a function result as a
        // user message containing a tool_result block, not a top-level event.
        let mut events = fixture();
        events[2] = json!({"type":"user","message":{"role":"user","content":[
            {"type":"text","text":"This user text MARKER is not evidence"},
            {"type":"tool_result","tool_use_id":"read-1","content":[{"type":"text","text":"MARKER"}],"is_error":false}
        ]}});
        assert!(
            tool_evidence(AgentId::ClaudeCode, &events, "owned.txt", "MARKER")
                .readback_marker_observed
        );
        events[2]["message"]["content"][1]["tool_use_id"] = json!("unrelated-read");
        assert!(
            !tool_evidence(AgentId::ClaudeCode, &events, "owned.txt", "MARKER")
                .readback_marker_observed
        );
        events[2]["message"]["content"] = json!([{"type":"text","text":"MARKER"}]);
        assert!(
            !tool_evidence(AgentId::ClaudeCode, &events, "owned.txt", "MARKER")
                .readback_marker_observed
        );
    }

    #[test]
    fn officially_failed_tool_results_cannot_establish_successful_readback() {
        let mut events = fixture();
        events[2]["is_error"] = json!(true);
        assert!(
            !tool_evidence(AgentId::ClaudeCode, &events, "owned.txt", "MARKER")
                .readback_marker_observed
        );
    }

    #[test]
    fn official_hermes_results_without_ids_require_unique_pending_named_reads() {
        // Hermes tool_executor.py supplies no call ID to the normal progress
        // callback. stream_json.py emits the read output without its filename.
        let events = vec![
            json!({"type":"tool_use","name":"write_file","input":{"path":"owned.txt","content":"MARKER"}}),
            json!({"type":"tool_result","name":"write_file","output":"{\"success\":true}","duration_ms":1,"is_error":false}),
            json!({"type":"tool_use","name":"read_file","input":{"path":"owned.txt"}}),
            json!({"type":"tool_result","name":"read_file","output":"{\"content\":\"1: MARKER\",\"total_lines\":1}","duration_ms":1,"is_error":false}),
        ];
        let evidence = tool_evidence(AgentId::Hermes, &events, "owned.txt", "MARKER");
        assert!(
            evidence.write_observed && evidence.read_observed && evidence.readback_marker_observed
        );
        assert!(
            !tool_evidence(AgentId::ClaudeCode, &events, "owned.txt", "MARKER")
                .readback_marker_observed
        );

        let mut failed = events.clone();
        failed[3]["is_error"] = json!(true);
        assert!(
            !tool_evidence(AgentId::Hermes, &failed, "owned.txt", "MARKER")
                .readback_marker_observed
        );
        let mut unrelated = events.clone();
        unrelated[2]["input"]["path"] = json!("other.txt");
        assert!(
            !tool_evidence(AgentId::Hermes, &unrelated, "owned.txt", "MARKER")
                .readback_marker_observed
        );
    }

    #[test]
    fn hermes_overlapping_idless_reads_cannot_be_guessed_from_completion_order() {
        let events = vec![
            json!({"type":"tool_use","name":"read_file","input":{"path":"owned.txt"}}),
            json!({"type":"tool_use","name":"read_file","input":{"path":"other.txt"}}),
            json!({"type":"tool_result","name":"read_file","output":"MARKER","duration_ms":1,"is_error":false}),
            json!({"type":"tool_result","name":"read_file","output":"MARKER","duration_ms":1,"is_error":false}),
        ];
        assert!(
            !tool_evidence(AgentId::Hermes, &events, "owned.txt", "MARKER")
                .readback_marker_observed
        );
        let mut filename_echo = events.clone();
        filename_echo[2]["output"] = json!("owned.txt MARKER");
        filename_echo[3]["output"] = json!("owned.txt MARKER");
        assert!(
            !tool_evidence(AgentId::Hermes, &filename_echo, "owned.txt", "MARKER")
                .readback_marker_observed
        );
        let mut unpaired = events[2..].to_vec();
        unpaired.push(events[0].clone());
        assert!(
            !tool_evidence(AgentId::Hermes, &unpaired, "owned.txt", "MARKER")
                .readback_marker_observed
        );
    }

    #[test]
    fn official_zcode_lifecycle_payloads_correlate_scheduled_input_and_result() {
        // Official session-mapper.ts wraps these payloads as tool.updated.
        // The scheduled event owns input; result owns the same toolCallId.
        let mut events = vec![
            json!({"type":"tool.updated","payload":{"kind":"scheduled","toolCallId":"write-1","toolName":"Write","input":{"file_path":"owned.txt","content":"MARKER"}}}),
            json!({"type":"tool.updated","payload":{"kind":"started","toolCallId":"write-1","toolName":"Write","startedAt":1}}),
            json!({"type":"tool.updated","payload":{"kind":"result","toolCallId":"write-1","result":{"success":true,"content":"MARKER"},"duration":1}}),
            json!({"type":"tool.updated","payload":{"kind":"scheduled","toolCallId":"read-1","toolName":"Read","input":{"file_path":"owned.txt"}}}),
            json!({"type":"tool.updated","payload":{"kind":"started","toolCallId":"read-1","toolName":"Read","startedAt":2}}),
            json!({"type":"tool.updated","payload":{"kind":"result","toolCallId":"read-1","result":{"success":true,"content":"MARKER"},"duration":1}}),
        ];
        let evidence = tool_evidence(AgentId::Zcode, &events, "owned.txt", "MARKER");
        assert!(
            evidence.write_observed && evidence.read_observed && evidence.readback_marker_observed
        );
        events[5]["payload"]["result"]["success"] = json!(false);
        assert!(
            !tool_evidence(AgentId::Zcode, &events, "owned.txt", "MARKER").readback_marker_observed
        );
        events[5]["payload"]["result"]["success"] = json!(true);
        events[5]["payload"]["toolCallId"] = json!("unrelated-read");
        assert!(
            !tool_evidence(AgentId::Zcode, &events, "owned.txt", "MARKER").readback_marker_observed
        );
        events[5]["payload"]["toolCallId"] = json!("read-1");
        events[5]["payload"]["kind"] = json!("error");
        assert!(
            !tool_evidence(AgentId::Zcode, &events, "owned.txt", "MARKER").readback_marker_observed
        );
    }

    fn zcode_cached_read_fixture() -> Vec<Value> {
        // Captured official Write seeds the default read state, so Read can
        // return success:true without returning any file content at all.
        vec![
            json!({"type":"tool.updated","payload":{"kind":"scheduled","toolCallId":"write-1","toolName":"Write","input":{"file_path":"owned.txt","content":"MARKER"}}}),
            json!({"type":"tool.updated","payload":{"kind":"result","toolCallId":"write-1","result":{"success":true,"content":"File created successfully at: owned.txt (file state is current in your context — no need to Read it back)"}}}),
            json!({"type":"tool.updated","payload":{"kind":"scheduled","toolCallId":"cached-read","toolName":"Read","input":{"file_path":"owned.txt"}}}),
            json!({"type":"tool.updated","payload":{"kind":"result","toolCallId":"cached-read","result":{"success":true,"content":"Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.","truncated":false}}}),
            json!({"type":"result","response":"MARKER"}),
        ]
    }

    #[test]
    fn actual_zcode_cached_read_cannot_pass_even_with_exact_file_and_reply() {
        let events = zcode_cached_read_fixture();
        let mut evidence = tool_evidence(AgentId::Zcode, &events, "owned.txt", "MARKER");
        evidence.assistant_marker_observed = assistant_marker(AgentId::Zcode, &events, "MARKER");
        evidence.file_matches_marker = true;
        assert!(evidence.write_observed && evidence.read_observed);
        assert!(evidence.assistant_marker_observed && evidence.file_matches_marker);
        assert!(!evidence.readback_marker_observed && !evidence.verified(true));
    }

    #[test]
    fn actual_zcode_explicit_range_retry_requires_correlated_successful_output() {
        let mut events = zcode_cached_read_fixture();
        let final_reply = events.pop().unwrap();
        events.extend([
            json!({"type":"tool.updated","payload":{"kind":"scheduled","toolCallId":"range-read","toolName":"Read","input":{"file_path":"owned.txt","offset":0,"limit":10}}}),
            json!({"type":"tool.updated","payload":{"kind":"result","toolCallId":"range-read","result":{"success":true,"content":"0\tMARKER","truncated":false,"originalBytes":8,"returnedBytes":8}}}),
            final_reply,
        ]);
        let mut evidence = tool_evidence(AgentId::Zcode, &events, "owned.txt", "MARKER");
        evidence.assistant_marker_observed = assistant_marker(AgentId::Zcode, &events, "MARKER");
        evidence.file_matches_marker = true;
        assert!(evidence.verified(true));
        events[5]["payload"]["result"]["success"] = json!(false);
        assert!(
            !tool_evidence(AgentId::Zcode, &events, "owned.txt", "MARKER").readback_marker_observed
        );
        events[5]["payload"]["result"]["success"] = json!(true);
        events[5]["payload"]["toolCallId"] = json!("unrelated-read");
        assert!(
            !tool_evidence(AgentId::Zcode, &events, "owned.txt", "MARKER").readback_marker_observed
        );
    }

    #[test]
    fn explicit_read_range_guidance_is_only_added_for_zcode() {
        let prompt = verification_prompt(AgentId::Zcode, "owned.txt", "MARKER");
        assert!(prompt.contains("offset: 0 and limit: 10"));
        assert!(prompt.contains("cached file_unchanged or Wasted call response is not readback"));
        for agent in [
            AgentId::ClaudeCode,
            AgentId::Codex,
            AgentId::Hermes,
            AgentId::OhMyPi,
            AgentId::OpenCode,
            AgentId::WorkBuddy,
        ] {
            assert!(!verification_prompt(agent, "owned.txt", "MARKER").contains("offset: 0"));
        }
    }

    #[test]
    fn codex_verification_uses_single_lf_without_a_normalization_step() {
        let marker = "MARKER";
        let expected = verification_contents(AgentId::Codex, marker);
        assert_eq!(expected, "MARKER\n");
        let prompt = verification_prompt(AgentId::Codex, "owned.txt", marker);
        assert!(prompt.contains("exactly one LF byte (0x0a)"));
        assert!(prompt.contains("apply_patch"));
        assert!(!prompt.contains("no other text or newline"));
        assert!(prompt.contains("read that same file back"));
        let directory = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
        let artifact = directory.path().join("owned.txt");
        for contents in [
            b"MARKER".as_slice(),
            b"MARKER\n",
            b"MARKER\r\n",
            b"MARKER\n\n",
            b"MARKER \n",
            b"\xef\xbb\xbfMARKER\n",
        ] {
            fs::write(&artifact, contents).unwrap();
            assert_eq!(
                exact_owned_contents(directory.path(), &artifact, &expected),
                contents == b"MARKER\n",
                "{contents:?}"
            );
        }
    }

    #[test]
    fn opencode_prompt_requires_single_lf_without_unavailable_write_tool() {
        let prompt = verification_prompt(AgentId::OpenCode, "owned.txt", "MARKER");
        assert!(prompt.contains("exactly one LF byte (0x0a)"));
        assert!(prompt.contains("apply_patch"));
        assert!(!prompt.contains("no other text or newline"));
        assert!(!prompt.contains("Directly call your write tool"));
        for agent in [
            AgentId::ClaudeCode,
            AgentId::Hermes,
            AgentId::OhMyPi,
            AgentId::Zcode,
            AgentId::WorkBuddy,
            AgentId::DeepSeekHarness,
        ] {
            let prompt = verification_prompt(agent, "owned.txt", "MARKER");
            assert!(prompt.contains("no other text or newline"));
            assert!(!prompt.contains("exactly one LF byte"));
        }
    }

    #[test]
    fn patch_client_single_lf_payload_is_exact_and_other_agents_stay_unchanged() {
        let directory = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
        let artifact = directory.path().join("owned.txt");
        let marker = "MARKER";
        for agent in [
            AgentId::ClaudeCode,
            AgentId::Codex,
            AgentId::Hermes,
            AgentId::OhMyPi,
            AgentId::OpenCode,
            AgentId::Zcode,
            AgentId::WorkBuddy,
            AgentId::DeepSeekHarness,
        ] {
            let expected = verification_contents(agent, marker);
            assert_eq!(
                expected,
                if matches!(agent, AgentId::Codex | AgentId::OpenCode) {
                    "MARKER\n"
                } else {
                    "MARKER"
                }
            );
            for contents in [
                b"MARKER".as_slice(),
                b"MARKER\n",
                b"MARKER\r\n",
                b"MARKER\n\n",
                b"MARKER \n",
                b"\xef\xbb\xbfMARKER\n",
            ] {
                fs::write(&artifact, contents).unwrap();
                assert_eq!(
                    exact_owned_contents(directory.path(), &artifact, &expected),
                    contents == expected.as_bytes(),
                    "{agent:?}: {contents:?}"
                );
            }
        }
    }

    #[test]
    fn opencode_payload_does_not_allow_newline_in_owned_workspace_marker() {
        let parent = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
        let nonce = Uuid::new_v4();
        let directory = parent.path().join(format!(".ae-tool-verification-{nonce}"));
        let filename = format!(".ae-tool-verification-{nonce}.txt");
        let business = parent.path().join("notes.txt");
        fs::write(&business, "Keep").unwrap();
        create_owned_workspace(parent.path(), &directory, nonce).unwrap();
        let expected = verification_contents(AgentId::OpenCode, "MARKER");
        fs::write(directory.join(&filename), &expected).unwrap();
        fs::write(
            directory.join(".ae-verification-owner"),
            format!("{nonce}\n"),
        )
        .unwrap();
        assert!(exact_owned_contents(
            &directory,
            &directory.join(&filename),
            &expected
        ));
        assert!(!validate_owned_workspace(parent.path(), &directory, nonce));
        assert!(!cleanup_owned_workspace(
            AgentId::OpenCode,
            parent.path(),
            &directory,
            nonce,
            &filename
        ));
        assert_eq!(fs::read(directory.join(&filename)).unwrap(), b"MARKER\n");
        fs::write(directory.join(".ae-verification-owner"), nonce.to_string()).unwrap();
        assert!(validate_owned_workspace(parent.path(), &directory, nonce));
        assert!(cleanup_owned_workspace(
            AgentId::OpenCode,
            parent.path(),
            &directory,
            nonce,
            &filename
        ));
        assert_eq!(fs::read(business).unwrap(), b"Keep");
    }

    #[test]
    fn failed_completion_statuses_cannot_establish_readback() {
        for status in ["failed", "error", "cancelled", "canceled", "timed_out"] {
            let events = vec![
                json!({"type":"tool_use","id":"read-1","name":"Read","input":{"file_path":"owned.txt"}}),
                json!({"type":"tool_execution_end","toolCallId":"read-1","result":"MARKER","status":status}),
            ];
            assert!(
                !tool_evidence(AgentId::OhMyPi, &events, "owned.txt", "MARKER")
                    .readback_marker_observed
            );
        }
    }

    #[test]
    fn unrelated_tool_results_and_failed_assistant_results_do_not_pass() {
        let mut events = fixture();
        events[2]["tool_use_id"] = json!("unrelated-read");
        events[3]["is_error"] = json!(true);
        assert!(
            !tool_evidence(AgentId::ClaudeCode, &events, "owned.txt", "MARKER")
                .readback_marker_observed
        );
        assert!(!assistant_marker(AgentId::ClaudeCode, &events, "MARKER"));
    }

    #[test]
    fn file_contents_are_exact_and_cleanup_touches_only_its_uuid_file() {
        let directory = tempfile::tempdir().unwrap();
        let filename = format!(".ae-tool-verification-{}.txt", Uuid::new_v4());
        let artifact = directory.path().join(&filename);
        let user_file = directory.path().join("user-notes.txt");
        fs::write(&artifact, "MARKER\n").unwrap();
        fs::write(&user_file, "Keep my notes").unwrap();
        assert!(!exact_owned_contents(directory.path(), &artifact, "MARKER"));
        fs::write(&artifact, "MARKER").unwrap();
        assert!(exact_owned_contents(directory.path(), &artifact, "MARKER"));
        assert!(!cleanup_owned_artifact(
            AgentId::ClaudeCode,
            directory.path(),
            &user_file,
            "user-notes.txt"
        ));
        assert!(cleanup_owned_artifact(
            AgentId::ClaudeCode,
            directory.path(),
            &artifact,
            &filename
        ));
        assert_eq!(fs::read_to_string(user_file).unwrap(), "Keep my notes");
    }

    #[test]
    fn omp_short_filename_cleanup_requires_exact_target_and_owned_nonce() {
        let parent = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
        let nonce = Uuid::new_v4();
        let directory = parent.path().join(format!(".ae-tool-verification-{nonce}"));
        create_owned_workspace(parent.path(), &directory, nonce).unwrap();
        let artifact = directory.join("probe.txt");
        fs::write(&artifact, "MARKER").unwrap();
        let wrong_name = format!(".ae-tool-verification-{nonce}.txt");
        let wrong_file = directory.join(&wrong_name);
        fs::write(&wrong_file, "Keep").unwrap();
        assert!(!cleanup_owned_workspace(
            AgentId::OhMyPi,
            parent.path(),
            &directory,
            nonce,
            &wrong_name
        ));
        assert_eq!(fs::read(&artifact).unwrap(), b"MARKER");
        assert_eq!(fs::read(&wrong_file).unwrap(), b"Keep");
        assert!(!cleanup_owned_workspace(
            AgentId::ClaudeCode,
            parent.path(),
            &directory,
            nonce,
            "probe.txt"
        ));
        assert!(artifact.exists());
        fs::remove_file(&wrong_file).unwrap();
        fs::write(directory.join(".ae-verification-owner"), "wrong nonce").unwrap();
        assert!(!cleanup_owned_workspace(
            AgentId::OhMyPi,
            parent.path(),
            &directory,
            nonce,
            "probe.txt"
        ));
        assert!(artifact.exists());
        fs::write(directory.join(".ae-verification-owner"), nonce.to_string()).unwrap();
        assert!(exact_owned_contents(&directory, &artifact, "MARKER"));
        assert!(cleanup_owned_workspace(
            AgentId::OhMyPi,
            parent.path(),
            &directory,
            nonce,
            "probe.txt"
        ));
        assert!(!directory.exists());
    }

    #[test]
    fn owned_workspace_requires_its_marker_and_preserves_parent_business_files() {
        let parent = tempfile::tempdir().unwrap();
        let nonce = Uuid::new_v4();
        let directory = parent.path().join(format!(".ae-tool-verification-{nonce}"));
        let filename = format!(".ae-tool-verification-{nonce}.txt");
        fs::write(parent.path().join("notes.txt"), "Keep").unwrap();
        create_owned_workspace(parent.path(), &directory, nonce).unwrap();
        fs::write(directory.join(&filename), "MARKER").unwrap();
        fs::remove_file(directory.join(".ae-verification-owner")).unwrap();
        assert!(!cleanup_owned_workspace(
            AgentId::ClaudeCode,
            parent.path(),
            &directory,
            nonce,
            &filename
        ));
        assert!(directory.join(&filename).exists());
        fs::write(directory.join(".ae-verification-owner"), nonce.to_string()).unwrap();
        assert!(cleanup_owned_workspace(
            AgentId::ClaudeCode,
            parent.path(),
            &directory,
            nonce,
            &filename
        ));
        assert!(!directory.exists());
        assert_eq!(
            fs::read_to_string(parent.path().join("notes.txt")).unwrap(),
            "Keep"
        );
    }

    #[test]
    fn supported_assistant_event_schemas_accept_only_qualified_marker_replies() {
        for (agent, event) in [
            (
                AgentId::ClaudeCode,
                json!({"type":"result","is_error":false,"result":"MARKER"}),
            ),
            (
                AgentId::Codex,
                json!({"type":"item.completed","item":{"type":"agent_message","text":"MARKER"}}),
            ),
            (
                AgentId::Hermes,
                json!({"type":"result","exit_code":0,"text":"MARKER"}),
            ),
            (
                AgentId::OhMyPi,
                json!({"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"MARKER"}]}}),
            ),
            (
                AgentId::OpenCode,
                json!({"type":"text","part":{"type":"text","text":"MARKER"}}),
            ),
            (AgentId::Zcode, json!({"type":"result","response":"MARKER"})),
            (
                AgentId::WorkBuddy,
                json!({"type":"result","is_error":false,"result":"MARKER"}),
            ),
        ] {
            assert!(assistant_marker(agent, &[event], "MARKER"));
            assert!(!assistant_marker(
                agent,
                &[json!({"type":"user","text":"MARKER"})],
                "MARKER"
            ));
        }
    }

    #[test]
    fn codex_verification_does_not_request_windows_sandbox_setup() {
        let arguments = arguments_for(
            AgentId::Codex,
            "Read/write only owned test",
            Path::new("G:/owned-verification"),
        );
        assert!(arguments
            .iter()
            .any(|argument| argument == "--dangerously-bypass-approvals-and-sandbox"));
        assert!(!arguments
            .iter()
            .any(|argument| argument == "workspace-write"));
        assert!(arguments
            .windows(2)
            .any(|arguments| arguments == ["-C", "G:/owned-verification"]));
    }

    #[tokio::test]
    async fn partial_output_before_timeout_is_retained_without_verification() {
        let stdout = fixture()
            .into_iter()
            .map(|event| event.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        let stderr = "upstream retry pending: private-key\n";
        let (_stdout_writer, stdout_pending) = tokio::io::duplex(64);
        let (_stderr_writer, stderr_pending) = tokio::io::duplex(64);
        let capture = capture_output(
            AsyncReadExt::chain(stdout.as_bytes(), stdout_pending),
            AsyncReadExt::chain(stderr.as_bytes(), stderr_pending),
            std::future::pending(),
            Duration::from_millis(25),
        )
        .await;
        assert!(capture.timed_out);
        assert!(!capture.process_succeeded);
        assert_eq!(capture.exit_code, None);
        assert_eq!(capture.stdout, stdout.as_bytes());
        assert_eq!(capture.stderr, stderr.as_bytes());
        let events = parse_events(&capture.stdout);
        let mut evidence = tool_evidence(AgentId::ClaudeCode, &events, "owned.txt", "MARKER");
        evidence.assistant_marker_observed =
            assistant_marker(AgentId::ClaudeCode, &events, "MARKER");
        evidence.file_matches_marker = true;
        assert!(evidence.verified(true));
        assert!(!evidence.verified(capture.process_succeeded));
        let (stage, message) = outcome(&capture, &evidence, true);
        let result = report(
            "model",
            &["private-key".to_owned()],
            Instant::now(),
            &capture,
            &evidence,
            true,
            stage,
            message,
        );
        assert_eq!(result["stage"], "timeout");
        assert_eq!(result["toolVerified"], false);
        assert_eq!(result["ok"], false);
        assert!(result["diagnostic"]
            .as_str()
            .unwrap()
            .contains("upstream retry pending: <redacted>"));
    }

    #[tokio::test]
    async fn completed_capture_preserves_both_streams_and_exit_status() {
        let capture = capture_output(
            b"complete output\n".as_slice(),
            b"complete diagnostic\n".as_slice(),
            std::future::ready(Ok(std::process::ExitStatus::from_raw(0))),
            Duration::from_secs(1),
        )
        .await;
        assert_eq!(capture.stdout, b"complete output\n");
        assert_eq!(capture.stderr, b"complete diagnostic\n");
        assert_eq!(capture.exit_code, Some(0));
        assert!(capture.process_succeeded);
        assert!(!capture.timed_out && !capture.output_failed && !capture.output_limit_exceeded);
        assert!(!capture.inherited_pipes_open);
    }

    #[cfg(windows)]
    async fn actual_windows_exit(code: i32) -> io::Result<std::process::ExitStatus> {
        let mut command = Command::new(system_command("cmd.exe"));
        command
            .args(["/D", "/C", &format!("exit {code}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        hidden(&mut command);
        command.status().await
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_actual_exit_with_inherited_pipe_preserves_output_after_bounded_drain() {
        let (_writer, pending) = tokio::io::duplex(32);
        let started = Instant::now();
        let capture = capture_output(
            AsyncReadExt::chain(b"actual completed output\n".as_slice(), pending),
            b"diagnostic\n".as_slice(),
            actual_windows_exit(0),
            Duration::from_secs(10),
        )
        .await;
        assert!(started.elapsed() < Duration::from_secs(6));
        assert!(capture.process_succeeded && capture.inherited_pipes_open);
        assert_eq!(capture.exit_code, Some(0));
        assert_eq!(capture.stdout, b"actual completed output\n");
        assert_eq!(capture.stderr, b"diagnostic\n");
        assert!(!capture.timed_out && !capture.output_failed && !capture.output_limit_exceeded);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_actual_failed_exit_is_not_overridden_by_inherited_pipe() {
        let (_writer, pending) = tokio::io::duplex(32);
        let capture = capture_output(
            AsyncReadExt::chain(b"partial output\n".as_slice(), pending),
            tokio::io::empty(),
            actual_windows_exit(7),
            Duration::from_secs(10),
        )
        .await;
        assert_eq!(capture.exit_code, Some(7));
        assert!(capture.inherited_pipes_open);
        assert!(!capture.process_succeeded && !capture.timed_out);
        assert_eq!(outcome(&capture, &Evidence::default(), true).0, "process");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_other_agents_wait_for_delayed_output_after_launcher_exit() {
        use tokio::io::AsyncWriteExt;
        let mut command = Command::new(system_command("cmd.exe"));
        command
            .args(["/D", "/C", "exit 0"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        hidden(&mut command);
        let mut child = command.spawn().unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(child
            .try_wait()
            .unwrap()
            .is_some_and(|status| status.success()));
        let (mut writer, reader) = tokio::io::duplex(128);
        let delayed = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(3)).await;
            writer.write_all(b"late daemon result\n").await.unwrap();
            writer.shutdown().await.unwrap();
        });
        let started = Instant::now();
        let capture = capture_output_policy(
            reader,
            tokio::io::empty(),
            child.wait(),
            Duration::from_secs(10),
            false,
        )
        .await;
        delayed.await.unwrap();
        assert!(started.elapsed() >= Duration::from_secs(3));
        assert!(capture.process_succeeded);
        assert_eq!(capture.exit_code, Some(0));
        assert_eq!(capture.stdout, b"late daemon result\n");
        assert!(!capture.inherited_pipes_open && !capture.timed_out && !capture.output_failed);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_exit_drain_stays_within_original_overall_timeout() {
        let (_writer, pending) = tokio::io::duplex(32);
        let capture = capture_output(
            pending,
            tokio::io::empty(),
            actual_windows_exit(0),
            Duration::from_millis(50),
        )
        .await;
        assert!(capture.timed_out);
        assert!(!capture.process_succeeded);
        assert_eq!(capture.exit_code, None);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_output_limit_error_wins_over_successful_exit() {
        let capture = capture_output(
            tokio::io::repeat(b'x').take(OUTPUT_LIMIT as u64 + 1),
            tokio::io::empty(),
            actual_windows_exit(0),
            Duration::from_secs(10),
        )
        .await;
        assert!(capture.output_limit_exceeded);
        assert!(!capture.process_succeeded && !capture.timed_out);
        assert_eq!(
            outcome(&capture, &Evidence::default(), true).0,
            "output_limit"
        );
    }

    #[test]
    fn inherited_codex_pipes_require_completed_turn_and_all_existing_tool_evidence() {
        let mut events = codex_readalltext_fixture();
        assert!(!codex_terminal_completed(&events));
        events.push(json!({"type":"turn.completed","usage":{}}));
        assert!(codex_terminal_completed(&events));
        events.push(json!({"type":"turn.failed","error":{"message":"failure"}}));
        assert!(!codex_terminal_completed(&events));
        events.pop();
        let mut capture = Capture {
            process_succeeded: true,
            exit_code: Some(0),
            inherited_pipes_open: true,
            terminal_completion_required: true,
            ..Capture::default()
        };
        let mut evidence = tool_evidence(AgentId::Codex, &events, "owned.txt", "MARKER");
        evidence.assistant_marker_observed = assistant_marker(AgentId::Codex, &events, "MARKER");
        evidence.file_matches_marker = true;
        assert!(evidence.verified(true));
        assert_eq!(outcome(&capture, &evidence, true).0, "tool");
        capture.terminal_completed_observed = codex_terminal_completed(&events);
        assert_eq!(outcome(&capture, &evidence, true).0, "verified");
        let result = report(
            "model",
            &[],
            Instant::now(),
            &capture,
            &evidence,
            true,
            "verified",
            "verified",
        );
        assert_eq!(result["ok"], true);
        assert_eq!(result["toolEvidence"]["inheritedPipesOpen"], true);
        evidence.read_observed = false;
        assert_eq!(outcome(&capture, &evidence, true).0, "tool");
        let result = report(
            "model",
            &[],
            Instant::now(),
            &capture,
            &evidence,
            true,
            "tool",
            "incomplete",
        );
        assert_eq!(result["ok"], false);
    }

    #[tokio::test]
    async fn output_limit_retains_bounded_partial_streams_without_success() {
        let capture = capture_output(
            b"earlier status\n".as_slice(),
            tokio::io::repeat(b'x').take(OUTPUT_LIMIT as u64 + 1),
            std::future::pending(),
            Duration::from_secs(1),
        )
        .await;
        assert_eq!(capture.stdout, b"earlier status\n");
        assert!(!capture.stderr.is_empty());
        assert!(capture.stderr.len() <= OUTPUT_LIMIT);
        assert!(capture.output_limit_exceeded);
        assert!(!capture.process_succeeded && !capture.timed_out);
        assert_eq!(capture.exit_code, None);
    }

    #[tokio::test]
    async fn io_failure_retains_partial_streams_without_success() {
        struct FailedRead;
        impl AsyncRead for FailedRead {
            fn poll_read(
                self: std::pin::Pin<&mut Self>,
                _: &mut std::task::Context<'_>,
                _: &mut tokio::io::ReadBuf<'_>,
            ) -> std::task::Poll<io::Result<()>> {
                std::task::Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()))
            }
        }
        let capture = capture_output(
            b"earlier output\n".as_slice(),
            AsyncReadExt::chain(b"earlier diagnostic\n".as_slice(), FailedRead),
            std::future::pending(),
            Duration::from_secs(1),
        )
        .await;
        assert_eq!(capture.stdout, b"earlier output\n");
        assert_eq!(capture.stderr, b"earlier diagnostic\n");
        assert!(capture.output_failed);
        assert!(!capture.process_succeeded && !capture.timed_out);
        assert_eq!(capture.exit_code, None);
    }

    #[tokio::test]
    async fn output_is_bounded_before_capture_can_grow_past_two_mebibytes() {
        let input = tokio::io::repeat(b'x').take(OUTPUT_LIMIT as u64 + 1);
        let mut output = Vec::new();
        assert!(matches!(
            read_bounded(input, &mut output).await,
            Err(CaptureError::OutputLimit)
        ));
        assert!(output.len() <= OUTPUT_LIMIT);
    }

    #[test]
    fn missing_official_runtime_has_an_explicit_not_installed_stage() {
        let capture = Capture {
            exit_code: Some(127),
            ..Capture::default()
        };
        let (stage, _) = outcome(&capture, &Evidence::default(), true);
        assert_eq!(stage, "not_installed");
        assert!(!Evidence::default().verified(capture.process_succeeded));
    }

    #[test]
    fn failure_diagnostics_are_bounded_redacted_and_omit_prompt_events() {
        let capture = Capture {
            stdout: format!("{}\n{}", json!({"type":"user","text":"PRIVATE_USER_PROMPT","error":"PRIVATE_USER_PROMPT"}), json!({"type":"error","message":"401 private-long"})).into_bytes(),
            stderr: format!("{}\nOnly operate on the verification file .ae-tool-verification-owned.txt with AE_TOOL_VERIFIED_RANDOM\nprivate-long", "x".repeat(3000)).into_bytes(),
            ..Capture::default()
        };
        let text = diagnostic(&capture, &["private".to_owned(), "private-long".to_owned()]);
        assert!(text.chars().count() <= 2000);
        assert!(!text.contains("private") && !text.contains("PRIVATE_USER_PROMPT"));
        assert!(!text.contains("Only operate") && !text.contains("AE_TOOL_VERIFIED_"));
        assert!(text.contains("401 <redacted>"));
    }

    #[test]
    fn metadata_never_returns_output_or_overlapping_credentials() {
        let secrets = vec!["private".to_owned(), "private-long".to_owned()];
        let value = report(
            "private-long",
            &secrets,
            Instant::now(),
            &Capture::default(),
            &Evidence::default(),
            false,
            "tool",
            "private-long",
        );
        let serialized = value.to_string();
        assert!(!serialized.contains("private"));
        assert!(value.get("stdout").is_none() && value.get("stderr").is_none());
        assert_eq!(value["toolVerified"], false);
    }

    #[test]
    fn workbuddy_shapes_describe_only_the_existing_observed_tool_events() {
        let mut events = fixture();
        events[2] = json!({"type":"user","message":{"role":"user","content":[
            {"type":"text","text":"PRIVATE_USER_PROMPT"},
            {"type":"tool_result","tool_use_id":"read-1","content":[{"type":"text","text":"MARKER"}],"is_error":false}
        ]}});
        events.push(json!({"type":"user","message":{"role":"user","content":[
            {"type":"text","text":"PRIVATE_USER_PROMPT","nested":{"type":"tool_use","name":"Untrusted","input":{"file_path":"owned.txt"}}}
        ]}}));
        let mut evidence = tool_evidence(AgentId::WorkBuddy, &events, "owned.txt", "MARKER");
        evidence.assistant_marker_observed =
            assistant_marker(AgentId::WorkBuddy, &events, "MARKER");
        evidence.file_matches_marker = true;
        let value = report(
            "model",
            &[],
            Instant::now(),
            &Capture {
                stdout: serde_json::to_vec(&events).unwrap(),
                process_succeeded: true,
                ..Capture::default()
            },
            &evidence,
            true,
            "verified",
            "completed",
        );
        assert_eq!(value["toolVerified"], true);
        assert_eq!(value["toolEvidence"]["eventCount"], 3);
        assert_eq!(value["toolEvidence"]["relatedEventCount"], 2);
        assert_eq!(value["toolEvidence"]["toolEventShapesTruncated"], false);
        assert_eq!(
            value["toolEvidence"]["toolEventShapes"],
            json!([
                {"type":"tool_use","name":"Write","inputKeys":["content","file_path"],"hasId":true,"relatedToFilename":true,"writeOperation":true,"readOperation":false,"returnedMarker":false},
                {"type":"tool_use","name":"Read","inputKeys":["file_path"],"hasId":true,"relatedToFilename":true,"writeOperation":false,"readOperation":true,"returnedMarker":false},
                {"type":"tool_result","name":"","inputKeys":[],"hasId":true,"relatedToFilename":false,"writeOperation":false,"readOperation":false,"returnedMarker":true}
            ])
        );
        let serialized = value.to_string();
        for omitted in [
            "owned.txt",
            "MARKER",
            "write-1",
            "read-1",
            "PRIVATE_USER_PROMPT",
            "Untrusted",
        ] {
            assert!(!serialized.contains(omitted));
        }
    }

    #[test]
    fn tool_shapes_are_bounded_and_redact_before_truncating_without_limiting_gates() {
        let boundary_name = format!("{}private-long", "x".repeat(TOOL_METADATA_LABEL_LIMIT - 3));
        let mut input = serde_json::Map::new();
        input.insert("file_path".to_owned(), json!("G:\\owned\\owned.txt"));
        input.insert(boundary_name.clone(), json!("PRIVATE_INPUT_VALUE"));
        input.insert(
            "G:\\private\\file.txt".to_owned(),
            json!("PRIVATE_INPUT_VALUE"),
        );
        for index in 0..TOOL_INPUT_KEY_LIMIT {
            input.insert(format!("key-{index:02}"), json!("PRIVATE_INPUT_VALUE"));
        }
        let mut events: Vec<_> = (0..=TOOL_EVENT_SHAPE_LIMIT)
            .map(|_| json!({"type":"tool_use","name":boundary_name,"id":"PRIVATE_CALL_ID","input":input}))
            .collect();
        events[1]["type"] = json!("tool_use-private-long");
        events[1]["name"] = json!("G:\\private\\file.txt");
        events[2]["name"] = json!(".ae-tool-verification-private-file.txt");
        events[3]["name"] = json!("AE_TOOL_VERIFIED_PRIVATE_OUTPUT");
        events[4]["name"] = json!("PRIVATE_USER_PROMPT with spaces");
        events.extend(fixture());
        let mut evidence = tool_evidence(AgentId::WorkBuddy, &events, "owned.txt", "MARKER");
        evidence.assistant_marker_observed =
            assistant_marker(AgentId::WorkBuddy, &events, "MARKER");
        evidence.file_matches_marker = true;
        assert!(evidence.verified(true));
        let value = report(
            "model",
            &["private".to_owned(), "private-long".to_owned()],
            Instant::now(),
            &Capture {
                stdout: serde_json::to_vec(&events).unwrap(),
                process_succeeded: true,
                ..Capture::default()
            },
            &evidence,
            true,
            "verified",
            "completed",
        );
        assert_eq!(value["toolVerified"], true);
        assert_eq!(
            value["toolEvidence"]["eventCount"],
            TOOL_EVENT_SHAPE_LIMIT + 4
        );
        assert_eq!(value["toolEvidence"]["toolEventShapesTruncated"], true);
        let shapes = value["toolEvidence"]["toolEventShapes"].as_array().unwrap();
        assert_eq!(shapes.len(), TOOL_EVENT_SHAPE_LIMIT);
        let redacted_boundary = format!("{}<re", "x".repeat(TOOL_METADATA_LABEL_LIMIT - 3));
        assert_eq!(shapes[0]["name"], redacted_boundary);
        assert!(shapes[0]["inputKeys"]
            .as_array()
            .unwrap()
            .contains(&json!(redacted_boundary)));
        assert_eq!(shapes[1]["type"], "tool_use-<redacted>");
        for shape in &shapes[1..5] {
            assert_eq!(shape["name"], "<omitted>");
        }
        for shape in shapes {
            let keys = shape["inputKeys"].as_array().unwrap();
            assert!(keys.len() <= TOOL_INPUT_KEY_LIMIT);
            for label in [&shape["type"], &shape["name"]].into_iter().chain(keys) {
                assert!(label.as_str().unwrap().chars().count() <= TOOL_METADATA_LABEL_LIMIT);
            }
        }
        let serialized = value.to_string();
        for omitted in [
            "private",
            "owned.txt",
            "G:",
            "MARKER",
            "PRIVATE_INPUT_VALUE",
            "PRIVATE_CALL_ID",
            "PRIVATE_USER_PROMPT",
            "AE_TOOL_VERIFIED_",
        ] {
            assert!(!serialized.contains(omitted));
        }
        assert!(value.get("stdout").is_none() && value.get("stderr").is_none());
    }
}
