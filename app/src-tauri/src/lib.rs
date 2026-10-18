#![deny(unsafe_op_in_unsafe_fn)]
pub mod adapters;
pub mod agent_configs;
pub mod agent_discovery;
pub mod agent_hub;
pub mod agent_runner;
pub mod agent_verification;
#[cfg(feature = "desktop")]
pub mod background;
pub mod bridge;
pub mod desktop_platform;
pub mod discovery;
pub mod error;
pub mod portable;
pub mod project_links;
pub mod restart;
pub mod service_website;
pub mod store;
pub mod supplier;
pub mod types;
pub mod updates;
#[cfg(windows)]
mod windows_installations;
pub mod workbuddy_default;
pub mod writer;
#[cfg(windows)]
mod zcode_desktop;

#[cfg(feature = "desktop")]
mod desktop {
    use crate::{
        error::{AppError, Result},
        store::Store,
        types::*,
    };
    use std::sync::{Arc, Mutex};
    use tauri::{Manager, State};
    type AppState = Arc<Mutex<Store>>;

    #[cfg(feature = "qa-webview")]
    mod qa_tray_trace {
        use std::path::Path;
        use std::sync::atomic::{AtomicU32, Ordering};
        use tauri::Manager;

        const LIMIT: u32 = 64;
        static SEQUENCE: AtomicU32 = AtomicU32::new(0);
        static MENU_ENTRIES: AtomicU32 = AtomicU32::new(0);
        static DOUBLE_CLICK_ENTRIES: AtomicU32 = AtomicU32::new(0);

        pub(super) fn tooltip(root: &Path) -> crate::error::Result<String> {
            crate::portable::validate_root(root)?;
            let owner = if root.file_name().is_some_and(|name| name == "portable") {
                root.parent()
            } else {
                Some(root)
            };
            let owner = owner.filter(|owner| {
                owner.parent().is_some_and(|base| {
                    base.file_name()
                        .is_some_and(|name| name == "native-e2e-sandbox")
                        && base.parent().is_some_and(|cache| {
                            cache.file_name().is_some_and(|name| name == ".cache")
                        })
                })
            });
            let id = owner
                .and_then(Path::file_name)
                .and_then(|name| name.to_str())
                .filter(|id| {
                    id.len() == 32
                        && id
                            .bytes()
                            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                })
                .ok_or_else(|| {
                    crate::error::AppError::new("qa_tray", "QA 托盘需要明确的隔离 UUID 目录")
                })?;
            Ok(format!("AE Switch QA · {id}"))
        }

        pub(super) struct Entry {
            sequence: u32,
            source: &'static str,
            source_entry: u32,
            id: &'static str,
            thread: String,
            before: serde_json::Value,
        }

        fn state(window: Option<&tauri::WebviewWindow>) -> serde_json::Value {
            match window {
                Some(window) => serde_json::json!({
                    "mainFound": true,
                    "visible": match window.is_visible() {
                        Ok(true) => "visible",
                        Ok(false) => "hidden",
                        Err(_) => "error",
                    },
                    "minimized": match window.is_minimized() {
                        Ok(true) => "minimized",
                        Ok(false) => "restored",
                        Err(_) => "error",
                    },
                }),
                None => serde_json::json!({
                    "mainFound": false,
                    "visible": "missing",
                    "minimized": "missing",
                }),
            }
        }

        impl Entry {
            fn emit(
                &self,
                phase: &'static str,
                after: Option<serde_json::Value>,
                results: [&str; 3],
            ) {
                eprintln!(
                    "AE_SWITCH_QA_TRAY_TRACE {}",
                    serde_json::json!({
                        "version": 1,
                        "processId": std::process::id(),
                        "sequence": self.sequence,
                        "source": self.source,
                        "sourceEntry": self.source_entry,
                        "id": self.id,
                        "thread": self.thread,
                        "phase": phase,
                        "before": self.before,
                        "after": after,
                        "results": {
                            "show": results[0],
                            "unminimize": results[1],
                            "focus": results[2],
                        },
                    })
                );
            }
        }

        pub(super) fn ready(app: &tauri::AppHandle) {
            Entry {
                sequence: 0,
                source: "setup",
                source_entry: 0,
                id: "other",
                thread: format!("{:?}", std::thread::current().id()),
                before: state(app.get_webview_window("main").as_ref()),
            }
            .emit("ready", None, ["notCalled"; 3]);
        }

        pub(super) fn enter(
            app: &tauri::AppHandle,
            source: &'static str,
            id: &str,
        ) -> Option<Entry> {
            let mut previous = SEQUENCE.load(Ordering::Relaxed);
            let sequence = loop {
                if previous >= LIMIT {
                    return None;
                }
                match SEQUENCE.compare_exchange_weak(
                    previous,
                    previous + 1,
                    Ordering::Relaxed,
                    Ordering::Relaxed,
                ) {
                    Ok(_) => break previous + 1,
                    Err(current) => previous = current,
                }
            };
            let count = if source == "menu" {
                &MENU_ENTRIES
            } else {
                &DOUBLE_CLICK_ENTRIES
            };
            let entry = Entry {
                sequence,
                source,
                source_entry: count.fetch_add(1, Ordering::Relaxed) + 1,
                id: match id {
                    "show" => "show",
                    "exit" => "exit",
                    _ => "other",
                },
                thread: format!("{:?}", std::thread::current().id()),
                before: state(app.get_webview_window("main").as_ref()),
            };
            entry.emit("entry", None, ["notCalled"; 3]);
            Some(entry)
        }

        pub(super) fn classify<T, E>(result: std::result::Result<T, E>) -> &'static str {
            if result.is_ok() {
                "success"
            } else {
                "error"
            }
        }

        pub(super) fn finish(
            entry: Option<Entry>,
            window: Option<&tauri::WebviewWindow>,
            results: [&str; 3],
        ) {
            if let Some(entry) = entry {
                entry.emit("result", Some(state(window)), results);
            }
        }

        #[cfg(test)]
        mod tests {
            use super::tooltip;

            #[test]
            fn tooltip_uses_owned_uuid_for_portable_child_and_direct_qa_root() {
                let directory = tempfile::tempdir().unwrap();
                let id = "0123456789abcdef0123456789abcdef";
                let owner = directory.path().join(".cache/native-e2e-sandbox").join(id);
                let expected = format!("AE Switch QA · {id}");
                assert_eq!(tooltip(&owner.join("portable")).unwrap(), expected);
                assert_eq!(tooltip(&owner).unwrap(), expected);
            }

            #[test]
            fn tooltip_rejects_ambiguous_layouts_and_parent_aliases() {
                let directory = tempfile::tempdir().unwrap();
                let base = directory.path().join(".cache/native-e2e-sandbox");
                let owner = base.join("0123456789abcdef0123456789abcdef");
                for root in [
                    base.join("portable"),
                    owner.join("nested/portable"),
                    owner.join("portable/../portable"),
                    base.join("0123456789ABCDEF0123456789ABCDEF/portable"),
                    base.join("0123456789abcdef/portable"),
                    directory
                        .path()
                        .join("native-e2e-sandbox/0123456789abcdef0123456789abcdef/portable"),
                ] {
                    assert!(tooltip(&root).is_err(), "ambiguous QA root: {root:?}");
                }
            }
        }
    }

    fn locked<'a>(state: &'a State<'_, AppState>) -> Result<std::sync::MutexGuard<'a, Store>> {
        state
            .lock()
            .map_err(|_| AppError::new("busy", "配置服务异常，请重新打开应用"))
    }

    #[tauri::command]
    fn get_overview(state: State<AppState>) -> Result<Overview> {
        locked(&state)?.overview()
    }

    #[tauri::command]
    fn agent_hub_discover() -> crate::agent_discovery::InstalledAgentDiscovery {
        crate::agent_discovery::discover()
    }

    #[tauri::command]
    async fn agent_hub_discover_directory(
        agent_id: crate::agent_configs::AgentId,
        directory: String,
    ) -> Result<crate::agent_discovery::InstalledAgentDiscovery> {
        tauri::async_runtime::spawn_blocking(move || {
            crate::agent_discovery::discover_in_directory(
                agent_id,
                std::path::Path::new(&directory),
            )
        })
        .await
        .map_err(|_| AppError::new("agent_discovery", "安装目录识别未完成，请重试"))?
    }

    #[tauri::command]
    async fn agent_hub_pick_directory(app: tauri::AppHandle) -> Result<Option<String>> {
        use tauri_plugin_dialog::DialogExt;
        tauri::async_runtime::spawn_blocking(move || {
            let Some(selected) = app
                .dialog()
                .file()
                .set_title("选择客户端安装目录")
                .blocking_pick_folder()
            else {
                return Ok(None);
            };
            let path = selected
                .into_path()
                .map_err(|_| AppError::new("agent_directory", "请选择可访问的本地安装目录"))?;
            crate::portable::validate_root(&path)?;
            crate::agent_configs::validate_existing_runtime_directory(&path)?;
            Ok(Some(path.to_string_lossy().into_owned()))
        })
        .await
        .map_err(|_| AppError::new("agent_directory", "目录选择未完成，请重试"))?
    }

    #[tauri::command]
    async fn agent_hub_overview(state: State<'_, AppState>) -> Result<serde_json::Value> {
        let (mut overview, route) = {
            let store = locked(&state)?;
            (crate::agent_hub::overview(&store)?, store.agent_route()?)
        };
        overview["bridgeHealthy"] = serde_json::json!(crate::bridge::healthy(&route).await);
        Ok(overview)
    }

    #[tauri::command]
    async fn configure_agent(
        state: State<'_, AppState>,
        input: crate::agent_hub::AgentInput,
    ) -> Result<serde_json::Value> {
        let route = locked(&state)?.agent_route()?;
        if !crate::bridge::healthy(&route).await {
            return Err(AppError::new(
                "bridge_unavailable",
                "Rust 接入服务正在恢复，请稍后重试",
            ));
        }
        let (mut result, default_context) = {
            let store = locked(&state)?;
            let workbuddy = input.agent_id == crate::agent_configs::AgentId::WorkBuddy;
            let result = crate::agent_hub::configure(&store, input)?;
            let context = if workbuddy {
                crate::agent_hub::workbuddy_default_context(&store).ok()
            } else {
                None
            };
            (result, context)
        };
        if let Some((context, model)) = default_context {
            let pending_model = model.clone();
            let selected = tauri::async_runtime::spawn_blocking(move || {
                crate::workbuddy_default::apply(&context, &model)
            })
            .await
            .ok()
            .and_then(std::result::Result::ok)
            .unwrap_or_else(|| {
                crate::workbuddy_default::DefaultSelection::pending(
                    &pending_model,
                    "selection_unverified",
                    "模型配置已保存，桌面默认选择尚未确认；请在空白新建任务页面重试。",
                )
            });
            result["workBuddyDefaultSelection"] = serde_json::to_value(selected)
                .map_err(|_| AppError::new("serialization", "无法读取默认模型选择状态"))?;
        }
        Ok(result)
    }

    #[tauri::command]
    async fn apply_workbuddy_default_model(
        state: State<'_, AppState>,
    ) -> Result<crate::workbuddy_default::DefaultSelection> {
        let (context, model) = crate::agent_hub::workbuddy_default_context(&*locked(&state)?)?;
        tauri::async_runtime::spawn_blocking(move || {
            crate::workbuddy_default::apply(&context, &model)
        })
        .await
        .map_err(|_| AppError::new("workbuddy_default_failed", "原生默认模型服务未完成"))?
    }

    #[tauri::command]
    async fn probe_agent(
        state: State<'_, AppState>,
        input: crate::agent_hub::AgentInput,
    ) -> Result<serde_json::Value> {
        let context = crate::agent_hub::probe_context(&*locked(&state)?, &input)?;
        crate::agent_hub::probe(context, input).await
    }

    #[tauri::command]
    fn open_portable_directory(state: State<AppState>) -> Result<()> {
        let directory = locked(&state)?.data_directory.clone();
        crate::desktop_platform::open_directory(&directory)
    }

    #[tauri::command]
    fn launch_agent(state: State<AppState>, agent_id: crate::agent_configs::AgentId) -> Result<()> {
        crate::agent_hub::launch(&*locked(&state)?, agent_id)
    }
    #[tauri::command]
    async fn agent_hub_runtime(
        state: State<'_, AppState>,
        agent_id: crate::agent_configs::AgentId,
    ) -> Result<crate::restart::ExistingRuntime> {
        let context = crate::agent_hub::restart_context(&*locked(&state)?, agent_id)?;
        tauri::async_runtime::spawn_blocking(move || crate::restart::existing_runtime(&context))
            .await
            .map_err(|_| AppError::new("restart_failed", "无法检查所选客户端进程"))
    }
    #[tauri::command]
    async fn restart_agent(
        state: State<'_, AppState>,
        input: crate::restart::ExistingRestartInput,
    ) -> Result<crate::restart::RestartResult> {
        let context = crate::agent_hub::restart_context(&*locked(&state)?, input.agent_id)?;
        tauri::async_runtime::spawn_blocking(move || {
            crate::restart::restart_existing(context, input)
        })
        .await
        .map_err(|_| AppError::new("restart_failed", "所选客户端重启服务未完成"))?
    }
    #[tauri::command]
    fn get_background_settings() -> Result<crate::background::BackgroundSettings> {
        crate::background::settings()
    }
    #[tauri::command]
    fn get_update_source() -> crate::updates::UpdateSource {
        crate::updates::source()
    }
    #[tauri::command]
    async fn check_app_update() -> Result<crate::updates::UpdateCheck> {
        crate::updates::check().await
    }
    #[tauri::command]
    fn open_app_release(url: String) -> Result<()> {
        crate::updates::open_release(&url)
    }
    #[tauri::command]
    fn open_project_page(page: crate::project_links::ProjectPage) -> Result<()> {
        crate::project_links::open(page)
    }
    #[tauri::command]
    fn open_service_website() -> Result<()> {
        crate::service_website::open()
    }
    #[tauri::command]
    fn set_background_start(enabled: bool) -> Result<crate::background::BackgroundSettings> {
        crate::background::set(enabled)
    }
    #[tauri::command]
    async fn get_runtime_status(
        state: State<'_, AppState>,
        target: Target,
    ) -> Result<serde_json::Value> {
        let (directory, applied_at, required, route) = locked(&state)?.runtime_context(target)?;
        let (client_running, restart_required, desktop) =
            tauri::async_runtime::spawn_blocking(move || {
                let desktop = crate::restart::client_runtime(target, &directory, applied_at);
                if target != Target::Codex {
                    return (desktop.running, desktop.restart_required, desktop);
                }
                let (running, restart) =
                    crate::discovery::client_runtime(target, &directory, applied_at);
                (
                    running || desktop.running,
                    restart || desktop.restart_required,
                    desktop,
                )
            })
            .await
            .map_err(|_| AppError::new("runtime", "客户端状态检查未完成"))?;
        let healthy = match route {
            Some(route) => crate::bridge::healthy(&route).await,
            None => false,
        };
        Ok(
            serde_json::json!({"target":target,"clientRunning":client_running,"restartRequired":restart_required,"bridgeRequired":required,"bridgeHealthy":healthy,"configurationRevision":applied_at,"desktopRunning":target != Target::ClaudeCli && desktop.running,"desktopRestartRequired":target != Target::ClaudeCli && desktop.restart_required,"canRestartDesktop":target != Target::ClaudeCli && desktop.can_restart,"canRestartClient":desktop.can_restart,"restartInProgress":desktop.restart_in_progress,"restartReason":desktop.reason}),
        )
    }
    #[tauri::command]
    async fn restart_codex_desktop(
        state: State<'_, AppState>,
        configuration_revision: u64,
    ) -> Result<crate::restart::RestartResult> {
        restart_client(state, Target::Codex, configuration_revision).await
    }
    #[tauri::command]
    async fn restart_client(
        state: State<'_, AppState>,
        target: Target,
        configuration_revision: u64,
    ) -> Result<crate::restart::RestartResult> {
        let (directory, revision, _, _) = locked(&state)?.runtime_context(target)?;
        if revision != configuration_revision {
            return Err(AppError::new(
                "restart_configuration_changed",
                "配置刚刚发生变化，请稍后重试以加载最新配置",
            ));
        }
        tauri::async_runtime::spawn_blocking(move || {
            crate::restart::restart_client(target, &directory)
        })
        .await
        .map_err(|_| {
            AppError::new(
                "restart_failed",
                "重启操作未完成，请手动退出对应客户端后重新打开；新配置已保存",
            )
        })?
    }
    #[tauri::command]
    fn save_provider(state: State<AppState>, input: ProviderInput) -> Result<Provider> {
        locked(&state)?.save(input)
    }
    #[tauri::command]
    async fn commit_provider(
        state: State<'_, AppState>,
        input: ProviderInput,
        target: Target,
        apply: bool,
    ) -> Result<serde_json::Value> {
        let upstream =
            input
                .codex_options
                .upstream_protocol
                .unwrap_or(if input.family == Family::Codex {
                    input.codex_options.protocol
                } else if input.codex_options.claude_protocol == ClaudeProtocol::Openai {
                    CodexProtocol::Openai
                } else {
                    CodexProtocol::Anthropic
                });
        if apply && ((target == Target::Codex) != (upstream == CodexProtocol::Openai)) {
            let route = locked(&state)?
                .runtime_context(target)?
                .3
                .ok_or_else(|| AppError::new("bridge_unavailable", "兼容服务尚未启动"))?;
            if !crate::bridge::healthy(&route).await {
                return Err(AppError::new(
                    "bridge_unavailable",
                    "兼容服务正在自动恢复，请稍后再使用；原供应商与配置未改变",
                ));
            }
        }
        let (provider, reused) = locked(&state)?.commit_unique_provider(input, target, apply)?;
        let mut result = serde_json::to_value(provider)
            .map_err(|_| AppError::new("serialization", "供应商结果无法读取"))?;
        result["reusedExisting"] = serde_json::json!(reused);
        Ok(result)
    }
    #[tauri::command]
    async fn discover_provider_connection(
        state: State<'_, AppState>,
        input: ConnectionInput,
        protocol: Option<CodexProtocol>,
        auth_mode: Option<String>,
    ) -> Result<ModelSyncResult> {
        let (base_url, key) = locked(&state)?.connection(input)?;
        crate::supplier::discover_connection(&base_url, &key, protocol, auth_mode.as_deref()).await
    }
    #[tauri::command]
    fn delete_provider(state: State<AppState>, provider_id: String) -> Result<()> {
        locked(&state)?.delete(&provider_id)
    }
    #[tauri::command]
    async fn apply_provider(
        state: State<'_, AppState>,
        target: Target,
        provider_id: String,
    ) -> Result<TargetStatus> {
        let (required, route) = {
            let store = locked(&state)?;
            (
                store.provider_requires_bridge(target, &provider_id)?,
                store.runtime_context(target)?.3,
            )
        };
        if required
            && !crate::bridge::healthy(
                &route.ok_or_else(|| AppError::new("bridge_unavailable", "兼容服务尚未启动"))?,
            )
            .await
        {
            return Err(AppError::new(
                "bridge_unavailable",
                "兼容服务正在自动恢复，请稍后重试",
            ));
        }
        locked(&state)?.apply(target, &provider_id)
    }
    #[tauri::command]
    async fn sync_provider_targets(
        state: State<'_, AppState>,
        provider_id: String,
    ) -> Result<serde_json::Value> {
        let targets = locked(&state)?.overview()?.targets;
        let mut results = Vec::new();
        for status in targets
            .into_iter()
            .filter(|s| s.active_provider_id.as_deref() == Some(&provider_id))
        {
            if status.state == "applied" {
                continue;
            }
            let result =
                {
                    let (required, route) = {
                        let store = locked(&state)?;
                        (
                            store.provider_requires_bridge(status.target, &provider_id)?,
                            store.runtime_context(status.target)?.3,
                        )
                    };
                    if required
                        && !crate::bridge::healthy(&route.ok_or_else(|| {
                            AppError::new("bridge_unavailable", "兼容服务尚未启动")
                        })?)
                        .await
                    {
                        Err(AppError::new(
                            "bridge_unavailable",
                            "后台兼容服务正在恢复，请稍后重试",
                        ))
                    } else {
                        locked(&state)?.sync_connection(status.target, &provider_id)
                    }
                };
            match result {
                Ok(_) => results.push(serde_json::json!({"target":status.target,"success":true})),
                Err(error) => results.push(
                    serde_json::json!({"target":status.target,"success":false,"error":error}),
                ),
            }
        }
        Ok(serde_json::json!(results))
    }
    #[tauri::command]
    fn set_provider_fast_mode(
        state: State<AppState>,
        provider_id: String,
        enabled: bool,
    ) -> Result<FastModeResult> {
        locked(&state)?.set_provider_fast_mode(&provider_id, enabled)
    }
    #[tauri::command]
    async fn detect_provider_protocol(
        state: State<'_, AppState>,
        expected: Provider,
    ) -> Result<Provider> {
        let (base, key, protocol, auth) = locked(&state)?.protocol_probe_connection(&expected)?;
        let result =
            crate::supplier::discover_connection(&base, &key, protocol, auth.as_deref()).await?;
        locked(&state)?.accept_protocol_detection(expected, result)
    }
    #[tauri::command]
    fn set_protocol_conversion(
        state: State<AppState>,
        expected: Provider,
        target: Target,
        enabled: bool,
    ) -> Result<ProtocolConversionResult> {
        locked(&state)?.set_protocol_conversion(expected, target, enabled)
    }
    #[tauri::command]
    fn repair_reasoning_levels(
        state: State<AppState>,
        provider_id: String,
    ) -> Result<ReasoningRepairResult> {
        locked(&state)?.repair_reasoning_levels(&provider_id)
    }
    #[tauri::command]
    fn rename_provider(
        state: State<AppState>,
        expected: Provider,
        name: String,
    ) -> Result<Provider> {
        locked(&state)?.rename_provider(expected, name)
    }
    #[tauri::command]
    async fn quick_model_settings(
        state: State<'_, AppState>,
        input: QuickModelInput,
    ) -> Result<ModelWriteResult> {
        let route = {
            let store = locked(&state)?;
            if store.status(input.target)?.active_provider_id.as_deref() == Some(&input.expected.id)
                && store.provider_requires_bridge(input.target, &input.expected.id)?
            {
                store.runtime_context(input.target)?.3
            } else {
                None
            }
        };
        if let Some(route) = route {
            if !crate::bridge::healthy(&route).await {
                return Err(AppError::new(
                    "bridge_unavailable",
                    "兼容服务正在恢复，请稍后重试；此次没有写入",
                ));
            }
        }
        locked(&state)?.quick_model_settings(input)
    }
    #[tauri::command]
    fn update_provider_models(
        state: State<AppState>,
        input: ModelWriteInput,
    ) -> Result<ModelWriteResult> {
        locked(&state)?.update_provider_models(input)
    }
    #[tauri::command]
    fn restore_original(state: State<AppState>, target: Target) -> Result<TargetStatus> {
        locked(&state)?.restore(target)
    }
    #[tauri::command]
    fn set_directory(state: State<AppState>, target: Target, directory: String) -> Result<()> {
        locked(&state)?.set_directory(target, directory)
    }

    #[tauri::command]
    async fn sync_provider_models(
        state: State<'_, AppState>,
        input: ConnectionInput,
        auth_mode: Option<String>,
        protocol: Option<CodexProtocol>,
    ) -> Result<ModelSyncResult> {
        let (base_url, key) = locked(&state)?.connection(input)?;
        crate::supplier::sync_models_protocol(
            &base_url,
            &key,
            auth_mode.as_deref().unwrap_or("bearer"),
            protocol == Some(CodexProtocol::Anthropic),
        )
        .await
    }

    #[tauri::command]
    async fn query_provider_balance(
        state: State<'_, AppState>,
        input: ConnectionInput,
        query: Option<BalanceQuery>,
    ) -> Result<BalanceResult> {
        let (base_url, key, fallback, token) =
            locked(&state)?.auto_balance_connection(input, query)?;
        crate::supplier::query_auto_balance(&base_url, &key, fallback, token.as_deref()).await
    }

    pub fn run() {
        let directory = match crate::portable::initialize() {
            Ok(directory) => directory,
            Err(error) => {
                eprintln!("AE Switch 无法启动：{error}");
                return;
            }
        };
        let mut context = tauri::generate_context!();
        context.config_mut().app.windows[0].data_directory = Some(directory.join("webview"));
        if std::env::args().any(|a| a == "--background") {
            context.config_mut().app.windows[0].visible = false;
        }
        #[cfg(feature = "qa-webview")]
        let context = {
            let mut context = context;
            context.config_mut().app.windows[0].additional_browser_args = Some(
                "--remote-debugging-port=9223 --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection".into(),
            );
            context
        };
        let mut builder = tauri::Builder::default();
        if !cfg!(feature = "qa-webview") {
            builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _| {
                if !args.iter().any(|a| a == "--background") {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                }
            }));
        }
        let result = builder
            .plugin(tauri_plugin_dialog::init())
            .setup(|app| {
                let directory = crate::portable::root()?.join("data");
                let mut store = Store::open(directory.clone())?;
                let (route, listener) = crate::bridge::Route::start(&directory)?;
                store.set_bridge_route(route.clone());
                let state = Arc::new(Mutex::new(store));
                app.manage(state.clone());
                tauri::async_runtime::spawn(async move {
                    crate::bridge::maintain(listener, route, state).await;
                });
                let show = tauri::menu::MenuItem::with_id(
                    app,
                    "show",
                    "打开 AE Switch",
                    true,
                    None::<&str>,
                )?;
                let exit = tauri::menu::MenuItem::with_id(
                    app,
                    "exit",
                    "退出应用…",
                    true,
                    None::<&str>,
                )?;
                let menu = tauri::menu::Menu::with_items(app, &[&show, &exit])?;
                #[cfg(feature = "qa-webview")]
                let tooltip = qa_tray_trace::tooltip(&crate::portable::root()?)?;
                #[cfg(not(feature = "qa-webview"))]
                let tooltip = "AE Switch · Rust 接入服务";
                let mut tray = tauri::tray::TrayIconBuilder::new()
                    .tooltip(tooltip)
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| {
                        #[cfg(feature = "qa-webview")]
                        let trace = qa_tray_trace::enter(app, "menu", event.id.as_ref());
                        match event.id.as_ref() {
                            "show" => {
                                if let Some(window) = app.get_webview_window("main") {
                                    #[cfg(not(feature = "qa-webview"))]
                                    {
                                        let _ = window.show();
                                        let _ = window.unminimize();
                                        let _ = window.set_focus();
                                    }
                                    #[cfg(feature = "qa-webview")]
                                    {
                                        let show = qa_tray_trace::classify(window.show());
                                        let unminimize = qa_tray_trace::classify(window.unminimize());
                                        let focus = qa_tray_trace::classify(window.set_focus());
                                        qa_tray_trace::finish(
                                            trace,
                                            Some(&window),
                                            [show, unminimize, focus],
                                        );
                                    }
                                } else {
                                    #[cfg(feature = "qa-webview")]
                                    qa_tray_trace::finish(trace, None, ["notCalled"; 3]);
                                }
                            }
                            "exit" => {
                                let required = app.state::<AppState>().lock().is_ok_and(|store| store.bridge_required());
                                if required {
                                    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
                                    let handle = app.clone();
                                    app.dialog().message("退出后，使用此 Rust 网关的 Agent 将暂时无法连接。重新打开 AE Switch 即可恢复。").title("退出 AE Switch？").buttons(MessageDialogButtons::OkCancel).show(move |confirmed| { if confirmed { handle.exit(0); } });
                                } else { app.exit(0); }
                            },
                            _ => {}
                        }
                    })
                    .on_tray_icon_event(|tray, event| {
                        if matches!(event, tauri::tray::TrayIconEvent::DoubleClick { .. }) {
                            #[cfg(feature = "qa-webview")]
                            let trace = qa_tray_trace::enter(tray.app_handle(), "doubleClick", "show");
                            if let Some(window) = tray.app_handle().get_webview_window("main") {
                                #[cfg(not(feature = "qa-webview"))]
                                {
                                    let _ = window.show();
                                    let _ = window.unminimize();
                                    let _ = window.set_focus();
                                }
                                #[cfg(feature = "qa-webview")]
                                {
                                    let show = qa_tray_trace::classify(window.show());
                                    let unminimize = qa_tray_trace::classify(window.unminimize());
                                    let focus = qa_tray_trace::classify(window.set_focus());
                                    qa_tray_trace::finish(
                                        trace,
                                        Some(&window),
                                        [show, unminimize, focus],
                                    );
                                }
                            } else {
                                #[cfg(feature = "qa-webview")]
                                qa_tray_trace::finish(trace, None, ["notCalled"; 3]);
                            }
                        }
                    });
                if let Some(icon) = app.default_window_icon() {
                    tray = tray.icon(icon.clone());
                }
                tray.build(app)?;
                #[cfg(feature = "qa-webview")]
                qa_tray_trace::ready(app.handle());
                Ok(())
            })
            .on_window_event(|window, event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            })
            .invoke_handler(tauri::generate_handler![
                agent_hub_discover,
                agent_hub_discover_directory,
                agent_hub_pick_directory,
                agent_hub_overview,
                configure_agent,
                apply_workbuddy_default_model,
                probe_agent,
                open_portable_directory,
                launch_agent,
                agent_hub_runtime,
                restart_agent,
                get_overview,
                get_update_source,
                check_app_update,
                open_app_release,
                open_service_website,
                open_project_page,
                get_background_settings,
                set_background_start,
                sync_provider_targets,
                get_runtime_status,
                restart_codex_desktop,
                restart_client,
                save_provider,
                commit_provider,
                discover_provider_connection,
                delete_provider,
                apply_provider,
                set_provider_fast_mode,
                repair_reasoning_levels,
                update_provider_models,
                quick_model_settings,
                detect_provider_protocol,
                set_protocol_conversion,
                rename_provider,
                restore_original,
                set_directory,
                sync_provider_models,
                query_provider_balance
            ])
            .run(context);
        if let Err(error) = result {
            eprintln!("AE Switch 无法启动：{error}");
        }
    }
}

#[cfg(feature = "desktop")]
pub use desktop::run;
