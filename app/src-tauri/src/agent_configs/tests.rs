use super::*;

fn root() -> tempfile::TempDir {
    let directory = std::env::temp_dir();
    #[cfg(unix)]
    let directory = directory.canonicalize().expect("workspace TEMP must exist");
    tempfile::tempdir_in(directory).expect("workspace TEMP must be writable")
}

fn seed_native(root: &Path, agent: AgentId, relative: &str, contents: &str) -> PathBuf {
    let path = root.join("agents").join(agent.as_str()).join(relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, contents).unwrap();
    path
}

fn reconfigure_twice(root: &Path, agent: AgentId) {
    for (port, model) in [(18763, "first-model"), (18764, "second-model")] {
        configure(
            root,
            agent,
            &format!("http://127.0.0.1:{port}/v1"),
            "new-token",
            model,
        )
        .unwrap();
    }
}

fn native_json(path: &Path) -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[cfg(windows)]
#[test]
fn generated_launcher_process_pwd_matches_owned_workspace() {
    use std::os::windows::process::CommandExt;
    let temp = root();
    let directory = temp.path().join("agents").join("opencode");
    let workspace = directory.join("workspace");
    let bin = temp.path().join("bin");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(directory.join("configuration")).unwrap();
    std::fs::create_dir(&bin).unwrap();
    std::fs::write(
        bin.join("opencode.ps1"),
        r#"[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[pscustomobject]@{pwd=$env:PWD;cwd=(Get-Location).ProviderPath} | ConvertTo-Json -Compress"#,
    )
    .unwrap();
    std::fs::write(
        directory.join("configuration/environment.json"),
        serde_json::to_vec(&serde_json::json!({
            "AE_AGENT_ROOT":directory,"AE_SWITCH_PORTABLE_ROOT":temp.path(),
            "AE_AGENT_ALLOWED_ROOT":temp.path(),"AE_AGENT_BIN_PATH":bin
        }))
        .unwrap(),
    )
    .unwrap();
    let launcher = directory.join("launch.ps1");
    std::fs::write(&launcher, powershell_launcher(AgentId::OpenCode)).unwrap();
    let system = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let output = std::process::Command::new(
        PathBuf::from(system).join("System32/WindowsPowerShell/v1.0/powershell.exe"),
    )
    .args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
    ])
    .arg(launcher)
    .env("PWD", temp.path().join("inherited wrong workspace"))
    .creation_flags(0x0800_0000)
    .output()
    .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["cwd"], workspace.to_string_lossy().as_ref());
    assert_eq!(value["pwd"], workspace.to_string_lossy().as_ref());
}

#[test]
fn release_routing_claude_all_default_model_roles_use_the_selected_model() {
    let temp = root();
    let before = serde_json::json!({
        "permissions":{"allow":["Read(*)"],"deny":["Bash(rm *)"]},
        "enabledPlugins":{"custom":true},"contextWindow":456789,
        "env":{"USER_FLAG":"keep","DISABLE_AUTOUPDATER":"0",
            "ANTHROPIC_DEFAULT_OPUS_MODEL":"foreign-opus",
            "ANTHROPIC_DEFAULT_SONNET_MODEL":"foreign-sonnet",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL":"foreign-haiku",
            "CLAUDE_CODE_SUBAGENT_MODEL":"foreign-subagent",
            "ANTHROPIC_SMALL_FAST_MODEL":"foreign-small",
            "ANTHROPIC_CUSTOM_HEADERS":"X-User: keep\n aUtHoRiZaTiOn: Basic stale\r\n\nX-API-Key: stale\nX-Other: y:z\n",
            "CLAUDE_CODE_USE_ANTHROPIC_AWS":"1", "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD":"1",
            "CLAUDE_CODE_USE_MANTLE":"1", "CLAUDE_CODE_USE_GATEWAY":"1",
            "ANTHROPIC_UNIX_SOCKET":"/foreign/gateway.sock"}
    });
    let path = seed_native(
        temp.path(),
        AgentId::ClaudeCode,
        "home/.claude/settings.json",
        &serde_json::to_string(&before).unwrap(),
    );
    let history = seed_native(
        temp.path(),
        AgentId::ClaudeCode,
        "home/.claude/projects/keep.jsonl",
        "private historical session\n",
    );
    reconfigure_twice(temp.path(), AgentId::ClaudeCode);
    let after = native_json(&path);
    let environment = native_json(
        &temp
            .path()
            .join("agents/claude_code/configuration/environment.json"),
    );
    for role in [
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL",
        "ANTHROPIC_SMALL_FAST_MODEL",
    ] {
        assert_eq!(after["env"][role], "second-model", "native {role}");
        assert_eq!(environment[role], "second-model", "launcher {role}");
    }
    let headers =
        "X-User: keep\n aUtHoRiZaTiOn: Bearer new-token\r\n\nX-API-Key: new-token\nX-Other: y:z\n";
    assert_eq!(after["env"]["ANTHROPIC_CUSTOM_HEADERS"], headers);
    assert_eq!(environment["ANTHROPIC_CUSTOM_HEADERS"], headers);
    for route in [
        "CLAUDE_CODE_USE_ANTHROPIC_AWS",
        "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
        "CLAUDE_CODE_USE_MANTLE",
        "CLAUDE_CODE_USE_GATEWAY",
        "ANTHROPIC_UNIX_SOCKET",
    ] {
        assert!(after["env"].get(route).is_none());
        assert!(environment.get(route).is_none());
    }
    for key in ["permissions", "enabledPlugins", "contextWindow"] {
        assert_eq!(after[key], before[key]);
    }
    for key in ["USER_FLAG", "DISABLE_AUTOUPDATER"] {
        assert_eq!(after["env"][key], before["env"][key]);
    }
    assert_eq!(
        std::fs::read_to_string(history).unwrap(),
        "private historical session\n"
    );
}

#[test]
fn release_routing_omp_all_official_chat_workflow_roles_use_the_selected_model() {
    let temp = root();
    let chat_roles = [
        "default", "smol", "slow", "vision", "plan", "commit", "tiny", "memory", "task", "advisor",
    ];
    let mut before = serde_json::json!({
        "modelRoles":{"image":"images/picture","web":"search/provider","speech":"voice/provider","dictation":"voice/transcriber","judge":"judge/scorer","planner":"custom/model"},
        "context":{"compactionThreshold":0.8},"mcp":{"enabled":true},"history":{"keep":true}
    });
    for role in chat_roles {
        before["modelRoles"][role] = format!("foreign/{role}").into();
    }
    let settings = seed_native(
        temp.path(),
        AgentId::OhMyPi,
        "home/.omp/agent/config.yml",
        &serde_json::to_string(&before).unwrap(),
    );
    let provider_before = serde_json::json!({"providers":{"foreign":{"baseUrl":"https://foreign.invalid","models":[{"id":"untouched","contextWindow":456789}]} }});
    let models = seed_native(
        temp.path(),
        AgentId::OhMyPi,
        "home/.omp/agent/models.yml",
        &serde_json::to_string(&provider_before).unwrap(),
    );
    let history = seed_native(
        temp.path(),
        AgentId::OhMyPi,
        "home/.omp/agent/sessions/keep.jsonl",
        "historical session\n",
    );
    reconfigure_twice(temp.path(), AgentId::OhMyPi);
    let after = native_json(&settings);
    for role in chat_roles {
        assert_eq!(
            after["modelRoles"][role], "ae_switch/second-model",
            "{role}"
        );
    }
    for role in ["image", "web", "speech", "dictation", "judge", "planner"] {
        assert_eq!(after["modelRoles"][role], before["modelRoles"][role]);
    }
    for key in ["context", "mcp", "history"] {
        assert_eq!(after[key], before[key]);
    }
    assert_eq!(
        native_json(&models)["providers"]["foreign"],
        provider_before["providers"]["foreign"]
    );
    assert_eq!(
        std::fs::read_to_string(history).unwrap(),
        "historical session\n"
    );
}

#[test]
fn release_routing_claude_unpinned_subagents_inherit_the_selected_model() {
    let temp = root();
    reconfigure_twice(temp.path(), AgentId::ClaudeCode);
    let directory = temp.path().join("agents/claude_code");
    let settings = native_json(&directory.join("home/.claude/settings.json"));
    let environment = native_json(&directory.join("configuration/environment.json"));
    for name in [
        "CLAUDE_CODE_SUBAGENT_MODEL",
        "ANTHROPIC_SMALL_FAST_MODEL",
        "ANTHROPIC_CUSTOM_HEADERS",
    ] {
        assert!(settings["env"].get(name).is_none());
        assert!(environment.get(name).is_none());
    }
    assert_eq!(settings["env"]["ANTHROPIC_MODEL"], "second-model");
    assert_eq!(environment["ANTHROPIC_MODEL"], "second-model");
}

#[test]
fn release_routing_opencode_auxiliary_small_model_uses_selected_gateway() {
    let temp = root();
    let before = serde_json::json!({
        "model":"foreign/primary","small_model":"foreign/title-model",
        "permission":{"edit":"ask"},"mcp":{"custom":{"command":["user-server"]}},
        "compaction":{"auto":false},"provider":{"foreign":{"options":{"baseURL":"https://foreign.invalid"},"models":{"title-model":{"limit":{"context":777000}}}}}
    });
    let path = seed_native(
        temp.path(),
        AgentId::OpenCode,
        "configuration/opencode.json",
        &serde_json::to_string(&before).unwrap(),
    );
    let history = seed_native(
        temp.path(),
        AgentId::OpenCode,
        "home/.local/share/opencode/keep.db",
        "historical session",
    );
    reconfigure_twice(temp.path(), AgentId::OpenCode);
    let after = native_json(&path);
    assert_eq!(after["model"], "ae_switch/second-model");
    assert_eq!(after["small_model"], "ae_switch/second-model");
    for key in ["permission", "mcp", "compaction"] {
        assert_eq!(after[key], before[key]);
    }
    assert_eq!(after["provider"]["foreign"], before["provider"]["foreign"]);
    assert_eq!(
        std::fs::read_to_string(history).unwrap(),
        "historical session"
    );
}

#[test]
fn release_routing_opencode_builtin_and_selected_default_agent_models_follow_gateway() {
    let temp = root();
    let mut before = serde_json::json!({
        "model":"foreign/main","small_model":"foreign/title","default_agent":"custom_default",
        "agent":{"custom_default":{"name":"display-only-name","model":"foreign/default","permission":{"edit":"ask"}},"other_custom":{"model":"untouched/model","mode":"subagent"}},
        "mcp":{"custom":{"command":["keep-server"]}},"compaction":{"reserved":5432}
    });
    for agent in [
        "build",
        "plan",
        "general",
        "explore",
        "compaction",
        "title",
        "summary",
    ] {
        before["agent"][agent] = serde_json::json!({"model":"foreign/agent-model", "temperature":0.2, "permission":{"edit":"ask"}});
    }
    let path = seed_native(
        temp.path(),
        AgentId::OpenCode,
        "configuration/opencode.json",
        &serde_json::to_string(&before).unwrap(),
    );
    reconfigure_twice(temp.path(), AgentId::OpenCode);
    let after = native_json(&path);
    for agent in [
        "build",
        "plan",
        "general",
        "explore",
        "compaction",
        "title",
        "summary",
        "custom_default",
    ] {
        assert_eq!(
            after["agent"][agent]["model"], "ae_switch/second-model",
            "{agent}"
        );
        let mut expected = before["agent"][agent].clone();
        expected["model"] = "ae_switch/second-model".into();
        assert_eq!(after["agent"][agent], expected);
    }
    assert_eq!(
        after["agent"]["other_custom"],
        before["agent"]["other_custom"]
    );
    for key in ["default_agent", "mcp", "compaction"] {
        assert_eq!(after[key], before[key]);
    }
}

#[test]
fn release_routing_malformed_omp_auxiliary_role_refuses_all_configuration_writes() {
    let temp = root();
    let path = seed_native(
        temp.path(),
        AgentId::OhMyPi,
        "home/.omp/agent/config.yml",
        "modelRoles:\n  default: foreign/main\n  smol: [invalid, role]\n",
    );
    let models = seed_native(
        temp.path(),
        AgentId::OhMyPi,
        "home/.omp/agent/models.yml",
        "providers: {}\n",
    );
    let original = std::fs::read(&path).unwrap();
    let original_models = std::fs::read(&models).unwrap();
    assert!(configure(
        temp.path(),
        AgentId::OhMyPi,
        "http://127.0.0.1:18763/v1",
        "token",
        "selected"
    )
    .is_err());
    assert_eq!(std::fs::read(path).unwrap(), original);
    assert_eq!(std::fs::read(models).unwrap(), original_models);
    assert!(!temp
        .path()
        .join("agents/oh_my_pi/configuration/environment.json")
        .exists());
}

#[test]
fn release_routing_codex_review_model_follows_selected_model_in_active_profile() {
    let temp = root();
    let path = seed_native(temp.path(), AgentId::Codex, "home/.codex/config.toml", "review_model = 'foreign-review'\nprofile = 'work'\n[profiles.work]\nmodel = 'foreign-main'\nreview_model = 'profile-review'\n[profiles.other]\nreview_model = 'keep-other'\n[history]\npersistence = 'save-all'\n[mcp_servers.custom]\ncommand = 'keep-server'\n");
    reconfigure_twice(temp.path(), AgentId::Codex);
    let document = std::fs::read_to_string(path)
        .unwrap()
        .parse::<toml_edit::DocumentMut>()
        .unwrap();
    assert_eq!(document["review_model"].as_str(), Some("second-model"));
    assert_eq!(
        document["profiles"]["work"]["review_model"].as_str(),
        Some("second-model")
    );
    assert_eq!(
        document["profiles"]["other"]["review_model"].as_str(),
        Some("keep-other")
    );
    assert_eq!(
        document["history"]["persistence"].as_str(),
        Some("save-all")
    );
    assert_eq!(
        document["mcp_servers"]["custom"]["command"].as_str(),
        Some("keep-server")
    );
}

#[test]
fn release_routing_hermes_default_auxiliary_workflows_share_selected_connection() {
    let temp = root();
    let mut before = serde_json::json!({
        "model":{"default":"foreign-main","provider":"custom","context_length":444000},
        "auxiliary":{"custom_task":{"provider":"untouched","model":"custom-model"}},
        "compression":{"threshold":0.8},"mcp":{"custom":{"command":"keep"}},"history":{"keep":true}
    });
    for task in ["compression", "title_generation", "background_review"] {
        before["auxiliary"][task] = serde_json::json!({"provider":"foreign","model":"foreign-task","base_url":"https://foreign.invalid","api_key":"foreign-token","api_key_env":"FOREIGN_KEY","api_mode":"anthropic_messages","enabled":false,"timeout":543,"extra_body":{"keep":true}});
    }
    let path = seed_native(
        temp.path(),
        AgentId::Hermes,
        "home/.hermes/config.yaml",
        &serde_json::to_string(&before).unwrap(),
    );
    let history = seed_native(
        temp.path(),
        AgentId::Hermes,
        "home/.hermes/state.db",
        "historical session",
    );
    reconfigure_twice(temp.path(), AgentId::Hermes);
    let after = native_json(&path);
    for task in ["compression", "title_generation", "background_review"] {
        let route = &after["auxiliary"][task];
        assert_eq!(route["provider"], "custom", "{task}");
        assert_eq!(route["model"], "second-model", "{task}");
        assert_eq!(route["base_url"], "http://127.0.0.1:18764/v1", "{task}");
        assert_eq!(route["api_key"], "new-token", "{task}");
        assert_eq!(route["key_env"], "AE_SWITCH_API_KEY", "{task}");
        assert_eq!(route["api_key_env"], "AE_SWITCH_API_KEY", "{task}");
        assert_eq!(route["api_mode"], "chat_completions", "{task}");
        for key in ["enabled", "timeout", "extra_body"] {
            assert_eq!(route[key], before["auxiliary"][task][key]);
        }
    }
    assert_eq!(
        after["auxiliary"]["custom_task"],
        before["auxiliary"]["custom_task"]
    );
    for key in ["compression", "mcp", "history"] {
        assert_eq!(after[key], before[key]);
    }
    assert_eq!(after["model"]["context_length"], 444000);
    assert_eq!(
        std::fs::read_to_string(history).unwrap(),
        "historical session"
    );
}

#[test]
fn release_routing_deepseek_existing_auxiliary_overrides_follow_selected_model() {
    let temp = root();
    let before = serde_json::json!([
        {"id":"compaction-basic","disabled":false,"config":{"summarizationProvider":"foreign","summarizationModel":"foreign-summary","thresholdRatio":0.7,"retainTokens":123,"maxTokens":456,"modelPolicies":[{"provider":"foreign","model":"match-target","summarizationProvider":"other","summarizationModel":"other-summary","maxTokens":789},{"provider":"custom","model":"keep-target","summarizationProvider":"","summarizationModel":""}]}},
        {"id":"session-title-llm","disabled":false,"config":{"provider":"foreign","model":"foreign-title","timeoutMs":12345}},
        {"id":"tool-subagent","disabled":false,"config":{"provider":"spawn","agentOptions":{"provider":"foreign","model":"foreign-subagent","reasoningEffort":"high","maxTokens":987},"modelSelectionSettings":true,"toolFilter":{"deny":["shell"]}}},
        {"id":"tool-subagent-fork","disabled":true,"config":{"provider":"fork","agentOptions":{"provider":"foreign","model":"foreign-fork","reasoningEffort":"low"}}},
        {"id":"custom-plugin","config":{"provider":"keep","model":"keep"}}
    ]);
    let patch = seed_native(
        temp.path(),
        AgentId::DeepSeekHarness,
        "home/.dsh/profiles/headless/cordis.patch.yml",
        &serde_json::to_string(&before).unwrap(),
    );
    let history = seed_native(
        temp.path(),
        AgentId::DeepSeekHarness,
        "home/.dsh/sessions/historical.jsonl",
        "historical session",
    );
    reconfigure_twice(temp.path(), AgentId::DeepSeekHarness);
    let after = native_json(&patch);
    assert_eq!(after[0]["config"]["summarizationProvider"], "ae-switch");
    assert_eq!(after[0]["config"]["summarizationModel"], "second-model");
    assert_eq!(
        after[0]["config"]["modelPolicies"][0]["summarizationProvider"],
        "ae-switch"
    );
    assert_eq!(
        after[0]["config"]["modelPolicies"][0]["summarizationModel"],
        "second-model"
    );
    assert_eq!(
        after[0]["config"]["modelPolicies"][0]["provider"],
        "foreign"
    );
    assert_eq!(
        after[0]["config"]["modelPolicies"][0]["model"],
        "match-target"
    );
    assert_eq!(
        after[0]["config"]["modelPolicies"][1],
        before[0]["config"]["modelPolicies"][1]
    );
    for key in ["thresholdRatio", "retainTokens", "maxTokens"] {
        assert_eq!(after[0]["config"][key], before[0]["config"][key]);
    }
    assert_eq!(after[1]["config"]["provider"], "ae-switch");
    assert_eq!(after[1]["config"]["model"], "second-model");
    assert_eq!(after[1]["config"]["timeoutMs"], 12345);
    for index in [2, 3] {
        assert_eq!(
            after[index]["config"]["agentOptions"]["provider"],
            "ae-switch"
        );
        assert_eq!(
            after[index]["config"]["agentOptions"]["model"],
            "second-model"
        );
        assert_eq!(
            after[index]["config"]["provider"],
            before[index]["config"]["provider"]
        );
        assert_eq!(after[index]["disabled"], before[index]["disabled"]);
        assert_eq!(
            after[index]["config"]["agentOptions"]["reasoningEffort"],
            before[index]["config"]["agentOptions"]["reasoningEffort"]
        );
    }
    assert_eq!(after[2]["config"]["agentOptions"]["maxTokens"], 987);
    assert_eq!(after[2]["config"]["modelSelectionSettings"], true);
    assert_eq!(
        after[2]["config"]["toolFilter"],
        before[2]["config"]["toolFilter"]
    );
    assert_eq!(after[4], before[4]);
    assert_eq!(
        std::fs::read_to_string(history).unwrap(),
        "historical session"
    );
}

#[test]
fn release_routing_zcode_existing_builtin_subagent_overrides_follow_selected_model() {
    let temp = root();
    let before = serde_json::json!({
        "builtInModelSelectionOverrides":{
            "general-purpose":{"providerId":"foreign","modelId":"foreign-main","options":{"reasoningLevel":"disabled"}},
            "Explore":{"providerId":"foreign","modelId":"foreign-explore","options":{"reasoningLevel":"disabled"}},
            "custom":{"providerId":"keep","modelId":"keep"}
        },
        "pluginAgentModelSelectionOverrides":{"custom":{"providerId":"keep","modelId":"keep"}},
        "disabledAgentIds":["custom:user:agent"],"customState":{"keep":true}
    });
    let path = seed_native(
        temp.path(),
        AgentId::Zcode,
        "home/.zcode/v2/agents-state.json",
        &serde_json::to_string(&before).unwrap(),
    );
    let history = seed_native(
        temp.path(),
        AgentId::Zcode,
        "home/.zcode/v2/sessions/historical.json",
        "historical session",
    );
    reconfigure_twice(temp.path(), AgentId::Zcode);
    let after = native_json(&path);
    for name in ["general-purpose", "Explore"] {
        assert_eq!(
            after["builtInModelSelectionOverrides"][name]["providerId"],
            "ae_switch"
        );
        assert_eq!(
            after["builtInModelSelectionOverrides"][name]["modelId"],
            "second-model"
        );
        assert_eq!(
            after["builtInModelSelectionOverrides"][name]["options"],
            before["builtInModelSelectionOverrides"][name]["options"]
        );
    }
    assert_eq!(
        after["builtInModelSelectionOverrides"]["custom"],
        before["builtInModelSelectionOverrides"]["custom"]
    );
    for key in [
        "pluginAgentModelSelectionOverrides",
        "disabledAgentIds",
        "customState",
    ] {
        assert_eq!(after[key], before[key]);
    }
    assert_eq!(
        std::fs::read_to_string(history).unwrap(),
        "historical session"
    );
}

#[test]
fn release_routing_opencode_selected_model_transport_and_authentication_follow_gateway() {
    let temp = root();
    let before = serde_json::json!({
        "model":"ae_switch/old-model",
        "provider":{"ae_switch":{"options":{"headers":{"Authorization":"Bearer stale-provider","X-Custom":"keep"},"timeout":987},
            "models":{"old-model":{"id":"old-api-id","provider":{"npm":"@ai-sdk/anthropic","api":"https://metadata.invalid"},
                "headers":{"authorization":"Bearer stale-model","X-Model":"keep"},
                "limit":{"context":222000,"output":3333},"options":{"temperature":0.7},"custom":true}}}}
    });
    let path = seed_native(
        temp.path(),
        AgentId::OpenCode,
        "configuration/opencode.json",
        &serde_json::to_string(&before).unwrap(),
    );
    reconfigure_twice(temp.path(), AgentId::OpenCode);
    let after = native_json(&path);
    let provider = &after["provider"]["ae_switch"];
    assert_eq!(
        provider["options"]["headers"]["Authorization"],
        "Bearer new-token"
    );
    assert_eq!(provider["options"]["headers"]["X-Custom"], "keep");
    assert_eq!(provider["options"]["timeout"], 987);
    let selected = &provider["models"]["second-model"];
    assert_eq!(selected["id"], "second-model");
    assert_eq!(selected["provider"]["npm"], "@ai-sdk/openai-compatible");
    assert_eq!(selected["provider"]["api"], "https://metadata.invalid");
    assert_eq!(selected["headers"]["authorization"], "Bearer new-token");
    assert_eq!(selected["headers"]["X-Model"], "keep");
    for key in ["limit", "options", "custom"] {
        assert_eq!(
            selected[key],
            before["provider"]["ae_switch"]["models"]["old-model"][key]
        );
    }
    assert_eq!(
        provider["models"]["old-model"],
        before["provider"]["ae_switch"]["models"]["old-model"]
    );
}

#[test]
fn release_routing_deepseek_inherited_auxiliary_routes_remain_unpinned() {
    let temp = root();
    let before = serde_json::json!([
        {"id":"compaction-basic","config":{"summarizationProvider":"","summarizationModel":"","thresholdRatio":0.7}},
        {"id":"session-title-llm","disabled":true,"config":{"timeoutMs":12345}},
        {"id":"tool-subagent","config":{"provider":"spawn","agentOptions":{"reasoningEffort":"high","maxTokens":456}}},
        {"id":"tool-subagent-fork","config":{"provider":"fork"}}
    ]);
    let path = seed_native(
        temp.path(),
        AgentId::DeepSeekHarness,
        "home/.dsh/profiles/headless/cordis.patch.yml",
        &serde_json::to_string(&before).unwrap(),
    );
    reconfigure_twice(temp.path(), AgentId::DeepSeekHarness);
    let after = native_json(&path);
    for index in 0..4 {
        assert_eq!(after[index], before[index]);
    }
}

#[test]
fn release_routing_zcode_unpinned_state_bytes_and_missing_state_are_preserved() {
    let temp = root();
    let path = seed_native(
        temp.path(),
        AgentId::Zcode,
        "home/.zcode/v2/agents-state.json",
        "{ \"disabledAgentIds\": [\"custom:user\"], \"builtInModelSelectionOverrides\": {} }\n",
    );
    let before = std::fs::read(&path).unwrap();
    reconfigure_twice(temp.path(), AgentId::Zcode);
    assert_eq!(std::fs::read(path).unwrap(), before);
    let fresh = root();
    reconfigure_twice(fresh.path(), AgentId::Zcode);
    assert!(!fresh
        .path()
        .join("agents/zcode/home/.zcode/v2/agents-state.json")
        .exists());
}

#[test]
fn release_routing_invalid_deepseek_pair_or_zcode_state_refuses_all_writes() {
    for (agent, relative, source) in [
        (
            AgentId::DeepSeekHarness,
            "home/.dsh/profiles/headless/cordis.patch.yml",
            r#"[{"id":"compaction-basic","config":{"summarizationProvider":"foreign"}}]"#,
        ),
        (
            AgentId::Zcode,
            "home/.zcode/v2/agents-state.json",
            r#"{"builtInModelSelectionOverrides":{"Explore":{"providerId":[],"modelId":"foreign"}}}"#,
        ),
    ] {
        let temp = root();
        let path = seed_native(temp.path(), agent, relative, source);
        let before = std::fs::read(&path).unwrap();
        assert!(configure(
            temp.path(),
            agent,
            "http://127.0.0.1:18763/v1",
            "token",
            "selected"
        )
        .is_err());
        assert_eq!(std::fs::read(path).unwrap(), before);
        assert!(!temp
            .path()
            .join("agents")
            .join(agent.as_str())
            .join("configuration/environment.json")
            .exists());
        assert!(!temp.path().join(CONFIGURATION_JOURNAL).exists());
    }
}

#[test]
fn release_routing_codex_conflicting_selected_provider_auth_refuses_all_writes() {
    for authentication in [
        "[model_providers.ae_switch.auth]\ncommand = 'G:/owned-fixture/helper.exe'\nargs = ['--audience', 'codex']\ntimeout_ms = 5000\nrefresh_interval_ms = 300000\n",
        "[model_providers.ae_switch.gateway_oauth]\nauthorization_url = 'https://gateway.invalid/authorize'\ntoken_url = 'https://gateway.invalid/token'\nclient_id = 'fixture'\n[model_providers.ae_switch.gateway_oauth.delivery]\nkind = 'header'\nname = 'X-Gateway-Token'\n",
        "[model_providers.ae_switch.aws]\nprofile = 'fixture'\n",
    ] {
        let temp = root();
        let source = format!("model = 'old-model'\nmodel_provider = 'foreign'\n[model_providers.foreign.auth]\ncommand = 'keep-helper'\n{authentication}");
        let path = seed_native(temp.path(), AgentId::Codex, "home/.codex/config.toml", &source);
        let before = std::fs::read(&path).unwrap();
        let error = configure(temp.path(), AgentId::Codex, "http://127.0.0.1:18763/v1", "token", "selected").unwrap_err();
        assert_eq!(error.code, "agent_configuration_conflict");
        assert_eq!(std::fs::read(path).unwrap(), before);
        assert!(!temp.path().join("agents/codex/configuration/environment.json").exists());
        assert!(!temp.path().join(CONFIGURATION_JOURNAL).exists());
    }
}

#[test]
fn release_routing_zcode_fresh_fallback_refuses_incompatible_preserved_reasoning() {
    for slot in ["default", "general-purpose", "Explore"] {
        let temp = root();
        let (relative, before) = if slot == "default" {
            (
                "configuration/zcode-providers.json",
                serde_json::json!({"schemaVersion":1,"config":{"defaultModelSelection":{"providerId":"foreign","modelId":"old-model","options":{"reasoningLevel":"high"}}}}),
            )
        } else {
            (
                "home/.zcode/v2/agents-state.json",
                serde_json::json!({"builtInModelSelectionOverrides":{slot:{"providerId":"foreign","modelId":"old-model","options":{"reasoningLevel":"high"}}}}),
            )
        };
        let path = seed_native(
            temp.path(),
            AgentId::Zcode,
            relative,
            &serde_json::to_string(&before).unwrap(),
        );
        let original = std::fs::read(&path).unwrap();
        let error = configure(
            temp.path(),
            AgentId::Zcode,
            "http://127.0.0.1:18763/v1",
            "token",
            "selected",
        )
        .unwrap_err();
        assert_eq!(error.code, "agent_configuration_conflict", "{slot}");
        assert_eq!(std::fs::read(path).unwrap(), original);
        assert!(!temp
            .path()
            .join("agents/zcode/configuration/environment.json")
            .exists());
        assert!(!temp
            .path()
            .join("agents/zcode/configuration/zcode-builtin.json")
            .exists());
        assert!(!temp.path().join(CONFIGURATION_JOURNAL).exists());
    }
}

#[test]
fn release_routing_deepseek_default_title_workflow_is_not_disabled() {
    for existing in [false, true] {
        let temp = root();
        if existing {
            seed_native(
                temp.path(),
                AgentId::DeepSeekHarness,
                "home/.dsh/profiles/headless/cordis.patch.yml",
                "[{\"id\":\"custom-plugin\",\"config\":{\"keep\":true}}]",
            );
        }
        reconfigure_twice(temp.path(), AgentId::DeepSeekHarness);
        let patch = native_json(
            &temp
                .path()
                .join("agents/deepseek_harness/home/.dsh/profiles/headless/cordis.patch.yml"),
        );
        assert!(patch
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["id"] != "session-title-llm"));
    }
}

#[test]
fn release_routing_zcode_existing_generated_fallback_refuses_incompatible_reasoning() {
    let temp = root();
    configure(
        temp.path(),
        AgentId::Zcode,
        "http://127.0.0.1:18763/v1",
        "token",
        "first-model",
    )
    .unwrap();
    let directory = temp.path().join("agents/zcode");
    let providers = directory.join("configuration/zcode-providers.json");
    let mut before = native_json(&providers);
    before["config"]["defaultModelSelection"]["options"]["reasoningLevel"] = "high".into();
    std::fs::write(&providers, serde_json::to_string(&before).unwrap()).unwrap();
    let files = [
        "configuration/zcode-providers.json",
        "configuration/zcode-builtin.json",
        "configuration/environment.json",
        launcher_file_name(),
    ];
    let snapshots: Vec<_> = files
        .iter()
        .map(|file| std::fs::read(directory.join(file)).unwrap())
        .collect();
    let error = configure(
        temp.path(),
        AgentId::Zcode,
        "http://127.0.0.1:18764/v1",
        "new-token",
        "second-model",
    )
    .unwrap_err();
    assert_eq!(error.code, "agent_configuration_conflict");
    for (file, before) in files.iter().zip(snapshots) {
        assert_eq!(std::fs::read(directory.join(file)).unwrap(), before);
    }
    assert!(!temp.path().join(CONFIGURATION_JOURNAL).exists());
}

#[cfg(windows)]
fn lock_against_atomic_replacement(path: &Path) -> std::fs::File {
    use std::os::windows::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .read(true)
        .share_mode(3)
        .open(path)
        .unwrap()
}

#[test]
#[cfg(windows)]
fn release_core_failed_secondary_native_write_restores_prior_model_files() {
    let temp = root();
    configure(
        temp.path(),
        AgentId::OhMyPi,
        "http://127.0.0.1:18763/v1",
        "old-token",
        "old-model",
    )
    .unwrap();
    let directory = temp.path().join("agents/oh_my_pi");
    let paths = [
        "home/.omp/agent/models.yml",
        "home/.omp/agent/config.yml",
        "configuration/environment.json",
        "launch.ps1",
        "launch.cmd",
    ];
    let before: Vec<_> = paths
        .iter()
        .map(|path| std::fs::read(directory.join(path)).unwrap())
        .collect();
    let _lock = lock_against_atomic_replacement(&directory.join(paths[1]));
    assert!(configure(
        temp.path(),
        AgentId::OhMyPi,
        "http://127.0.0.1:18764/v1",
        "new-token",
        "new-model"
    )
    .is_err());
    for (relative, original) in paths.iter().zip(before) {
        assert_eq!(
            std::fs::read(directory.join(relative)).unwrap(),
            original,
            "partial update: {relative}"
        );
    }
}

#[test]
#[cfg(windows)]
fn release_core_failed_environment_write_restores_native_configuration() {
    let temp = root();
    configure(
        temp.path(),
        AgentId::Codex,
        "http://127.0.0.1:18763/v1",
        "old-token",
        "old-model",
    )
    .unwrap();
    let directory = temp.path().join("agents/codex");
    let config = directory.join("home/.codex/config.toml");
    let before = std::fs::read(&config).unwrap();
    let _lock = lock_against_atomic_replacement(&directory.join("configuration/environment.json"));
    assert!(configure(
        temp.path(),
        AgentId::Codex,
        "http://127.0.0.1:18764/v1",
        "new-token",
        "new-model"
    )
    .is_err());
    assert_eq!(std::fs::read(config).unwrap(), before);
}

#[test]
fn release_core_claude_replaces_only_conflicting_authentication_and_transport() {
    let temp = root();
    let path = seed_native(
        temp.path(),
        AgentId::ClaudeCode,
        "home/.claude/settings.json",
        r#"{
      "apiKeyHelper":"old-helper", "permissions":{"allow":["Read(*)"]}, "contextWindow":76543,
      "env":{"ANTHROPIC_AUTH_TOKEN":"old-token","CLAUDE_CODE_USE_BEDROCK":"1","CLAUDE_CODE_USE_VERTEX":"1","CLAUDE_CODE_USE_FOUNDRY":"1","USER_FLAG":"keep"}
    }"#,
    );
    configure(
        temp.path(),
        AgentId::ClaudeCode,
        "http://127.0.0.1:18763",
        "new-token",
        "new-model",
    )
    .unwrap();
    let after = native_json(&path);
    assert!(after.get("apiKeyHelper").is_none());
    for key in [
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
    ] {
        assert!(
            after["env"].get(key).is_none(),
            "conflicting transport: {key}"
        );
    }
    assert_eq!(after["env"]["ANTHROPIC_API_KEY"], "new-token");
    assert_eq!(after["env"]["USER_FLAG"], "keep");
    assert_eq!(
        after["permissions"],
        serde_json::json!({"allow":["Read(*)"]})
    );
    assert_eq!(after["contextWindow"], 76543);
    let launcher = powershell_launcher(AgentId::ClaudeCode);
    for key in [
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
    ] {
        assert!(
            launcher.contains(key),
            "inherited transport is not cleared: {key}"
        );
    }
}

#[test]
#[cfg(windows)]
fn release_core_selection_write_failure_rolls_back_entire_agent_configuration() {
    for existing in [false, true] {
        let temp = root();
        let selection = temp.path().join("agent-selection.json");
        if existing {
            configure_with_selection(
                temp.path(),
                AgentId::Codex,
                "http://127.0.0.1:18763/v1",
                "old-token",
                "old-model",
                Some((&selection, "{\"old\":true}", None)),
            )
            .unwrap();
        } else {
            std::fs::write(&selection, "{}").unwrap();
        }
        let directory = temp.path().join("agents/codex");
        let paths = [
            "home/.codex/config.toml",
            "configuration/environment.json",
            "launch.ps1",
            "launch.cmd",
        ];
        let before: Vec<_> = paths
            .iter()
            .map(|path| std::fs::read(directory.join(path)).ok())
            .collect();
        let selection_before = std::fs::read(&selection).unwrap();
        let _lock = lock_against_atomic_replacement(&selection);
        assert!(configure_with_selection(
            temp.path(),
            AgentId::Codex,
            "http://127.0.0.1:18764/v1",
            "new-token",
            "new-model",
            Some((
                &selection,
                "{\"new\":true}",
                std::str::from_utf8(&selection_before).ok()
            ))
        )
        .is_err());
        for (relative, original) in paths.iter().zip(before) {
            assert_eq!(
                std::fs::read(directory.join(relative)).ok(),
                original,
                "incomplete transaction: {relative}"
            );
        }
        assert_eq!(std::fs::read(selection).unwrap(), selection_before);
        assert!(!temp.path().join(CONFIGURATION_JOURNAL).exists());
    }
}

#[test]
fn release_core_pending_agent_transaction_recovers_partial_and_completed_commits() {
    for completed in [false, true] {
        let temp = root();
        let native = seed_native(
            temp.path(),
            AgentId::Codex,
            "home/.codex/config.toml",
            "model='new'\n",
        );
        let selection = temp.path().join("agent-selection.json");
        let old_selection = "{\"old\":true}";
        let new_selection = "{\"new\":true}";
        std::fs::write(
            &selection,
            if completed {
                new_selection
            } else {
                old_selection
            },
        )
        .unwrap();
        let journal = ConfigurationJournal {
            changes: vec![
                ConfigurationChange {
                    path: native.clone(),
                    before: Some("model='old'\n".into()),
                    after: "model='new'\n".into(),
                },
                ConfigurationChange {
                    path: selection.clone(),
                    before: Some(old_selection.into()),
                    after: new_selection.into(),
                },
            ],
        };
        let journal_path = temp.path().join(CONFIGURATION_JOURNAL);
        std::fs::write(&journal_path, serde_json::to_string(&journal).unwrap()).unwrap();
        recover_configuration(temp.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(native).unwrap(),
            if completed {
                "model='new'\n"
            } else {
                "model='old'\n"
            }
        );
        assert_eq!(
            std::fs::read_to_string(selection).unwrap(),
            if completed {
                new_selection
            } else {
                old_selection
            }
        );
        assert!(!journal_path.exists());
    }
}

fn recover_moved_production_journal(completed: bool) {
    let temp = root();
    let source = temp.path().join("原便携 目录");
    let moved = temp.path().join("搬移便携 目录");
    let native = seed_native(
        &source,
        AgentId::Codex,
        "home/.codex/config.toml",
        "model='old'\n",
    );
    let selection = source.join("agent-selection.json");
    std::fs::write(&selection, "{\"old\":true}").unwrap();
    let snapshots = vec![
        (native.clone(), Some("model='old'\n".into())),
        (selection.clone(), Some("{\"old\":true}".into())),
    ];
    let journal = configuration_journal(
        &source,
        &snapshots,
        vec![
            (native.clone(), "model='new'\n".into()),
            (selection.clone(), "{\"new\":true}".into()),
        ],
    )
    .unwrap();
    std::fs::write(&native, "model='new'\n").unwrap();
    if completed {
        std::fs::write(&selection, "{\"new\":true}").unwrap();
    }
    std::fs::write(
        source.join(CONFIGURATION_JOURNAL),
        serde_json::to_string(&journal).unwrap(),
    )
    .unwrap();
    std::fs::rename(&source, &moved).unwrap();
    recover_configuration(&moved).unwrap();
    assert_eq!(
        std::fs::read_to_string(moved.join("agents/codex/home/.codex/config.toml")).unwrap(),
        if completed {
            "model='new'\n"
        } else {
            "model='old'\n"
        }
    );
    assert_eq!(
        std::fs::read_to_string(moved.join("agent-selection.json")).unwrap(),
        if completed {
            "{\"new\":true}"
        } else {
            "{\"old\":true}"
        }
    );
    assert!(
        !source.exists(),
        "recovery must not recreate or touch the old root"
    );
    assert!(!moved.join(CONFIGURATION_JOURNAL).exists());
    assert!(journal
        .changes
        .iter()
        .all(|change| !change.path.is_absolute()));
}

#[test]
fn release_core_completed_pending_journal_survives_portable_directory_move() {
    recover_moved_production_journal(true);
}

#[test]
fn release_core_partial_pending_journal_rolls_back_after_portable_directory_move() {
    recover_moved_production_journal(false);
}

#[test]
fn release_core_pending_journal_rejects_traversal_and_foreign_legacy_roots() {
    let temp = root();
    let current = temp.path().join("current");
    let foreign = temp.path().join("previous");
    std::fs::create_dir_all(current.join("agents")).unwrap();
    std::fs::create_dir_all(&foreign).unwrap();
    let local = current.join("target.cfg");
    let outside = foreign.join("target.cfg");
    std::fs::write(&local, "new").unwrap();
    std::fs::write(&outside, "new").unwrap();
    for path in [
        PathBuf::new(),
        PathBuf::from("."),
        current.clone(),
        PathBuf::from("../previous/target.cfg"),
        current.join("agents/../target.cfg"),
        outside.clone(),
    ] {
        let journal = ConfigurationJournal {
            changes: vec![ConfigurationChange {
                path,
                before: Some("old".into()),
                after: "new".into(),
            }],
        };
        let journal_path = current.join(CONFIGURATION_JOURNAL);
        let original = serde_json::to_string(&journal).unwrap();
        std::fs::write(&journal_path, &original).unwrap();
        assert!(recover_configuration(&current).is_err());
        assert_eq!(std::fs::read_to_string(&local).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(&journal_path).unwrap(), original);
    }
}

#[test]
fn release_core_pending_journal_rejects_relative_legacy_path_aliases() {
    let temp = root();
    let target = temp.path().join("target.cfg");
    std::fs::write(&target, "new").unwrap();
    let journal = ConfigurationJournal {
        changes: [PathBuf::from("target.cfg"), target.clone()]
            .into_iter()
            .map(|path| ConfigurationChange {
                path,
                before: Some("old".into()),
                after: "new".into(),
            })
            .collect(),
    };
    let journal_path = temp.path().join(CONFIGURATION_JOURNAL);
    let original = serde_json::to_string(&journal).unwrap();
    std::fs::write(&journal_path, &original).unwrap();
    assert!(recover_configuration(temp.path()).is_err());
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "new");
    assert_eq!(std::fs::read_to_string(&journal_path).unwrap(), original);
}

#[test]
#[cfg(unix)]
fn release_core_complete_recovery_repairs_interrupted_launcher_chmod() {
    use std::os::unix::fs::PermissionsExt;
    let temp = root();
    let launcher = seed_native(
        temp.path(),
        AgentId::Codex,
        "launch.sh",
        "#!/bin/sh\nexit 0\n",
    );
    std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o600)).unwrap();
    let journal = configuration_journal(
        temp.path(),
        &[(launcher.clone(), None)],
        vec![(launcher.clone(), "#!/bin/sh\nexit 0\n".into())],
    )
    .unwrap();
    std::fs::write(
        temp.path().join(CONFIGURATION_JOURNAL),
        serde_json::to_string(&journal).unwrap(),
    )
    .unwrap();
    recover_configuration(temp.path()).unwrap();
    assert_eq!(
        std::fs::metadata(launcher).unwrap().permissions().mode() & 0o7777,
        0o700
    );
    assert!(!temp.path().join(CONFIGURATION_JOURNAL).exists());
}

#[test]
fn release_core_selection_concurrent_change_is_rejected_before_native_updates() {
    let temp = root();
    configure(
        temp.path(),
        AgentId::Codex,
        "http://127.0.0.1:18763/v1",
        "old-token",
        "old-model",
    )
    .unwrap();
    let native = temp.path().join("agents/codex/home/.codex/config.toml");
    let before = std::fs::read(&native).unwrap();
    let selection = temp.path().join("agent-selection.json");
    std::fs::write(&selection, "{\"external\":true}").unwrap();
    let error = configure_with_selection(
        temp.path(),
        AgentId::Codex,
        "http://127.0.0.1:18764/v1",
        "new-token",
        "new-model",
        Some((&selection, "{\"new\":true}", Some("{}"))),
    )
    .unwrap_err();
    assert_eq!(error.code, "agent_configuration_changed");
    assert_eq!(std::fs::read(native).unwrap(), before);
    assert_eq!(
        std::fs::read_to_string(selection).unwrap(),
        "{\"external\":true}"
    );
}

#[test]
fn release_core_pending_agent_recovery_preserves_external_changes_and_original_backup() {
    let temp = root();
    let native = seed_native(
        temp.path(),
        AgentId::Codex,
        "home/.codex/config.toml",
        "model='user-edit'\n",
    );
    let selection = temp.path().join("agent-selection.json");
    std::fs::write(&selection, "{\"new\":true}").unwrap();
    let journal = ConfigurationJournal {
        changes: vec![
            ConfigurationChange {
                path: native.clone(),
                before: Some("model='old'\n".into()),
                after: "model='new'\n".into(),
            },
            ConfigurationChange {
                path: selection.clone(),
                before: Some("{}".into()),
                after: "{\"new\":true}".into(),
            },
        ],
    };
    let journal_path = temp.path().join(CONFIGURATION_JOURNAL);
    let before = serde_json::to_string(&journal).unwrap();
    std::fs::write(&journal_path, &before).unwrap();
    assert!(recover_configuration(temp.path()).is_err());
    assert_eq!(
        std::fs::read_to_string(native).unwrap(),
        "model='user-edit'\n"
    );
    assert_eq!(
        std::fs::read_to_string(selection).unwrap(),
        "{\"new\":true}"
    );
    assert_eq!(std::fs::read_to_string(journal_path).unwrap(), before);
}

#[test]
fn native_merge_preserves_claude_permissions_plugins_and_environment_preferences() {
    let temp = root();
    let path = seed_native(
        temp.path(),
        AgentId::ClaudeCode,
        "home/.claude/settings.json",
        r#"{
      "permissions":{"allow":["Read(*)"],"deny":["Bash(rm *)"]},
      "enabledPlugins":{"user-plugin":true},"contextWindow":456789,
      "env":{"USER_FLAG":"keep","DISABLE_AUTOUPDATER":"0","CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC":"0","ANTHROPIC_DEFAULT_OPUS_MODEL":"user-opus","ANTHROPIC_DEFAULT_SONNET_MODEL":"user-sonnet","ANTHROPIC_DEFAULT_HAIKU_MODEL":"user-haiku"}
    }"#,
    );
    let before = native_json(&path);
    reconfigure_twice(temp.path(), AgentId::ClaudeCode);
    let after = native_json(&path);
    for key in ["permissions", "enabledPlugins", "contextWindow"] {
        assert_eq!(after[key], before[key]);
    }
    for key in [
        "USER_FLAG",
        "DISABLE_AUTOUPDATER",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    ] {
        assert_eq!(after["env"][key], before["env"][key]);
    }
    assert_eq!(after["env"]["ANTHROPIC_MODEL"], "second-model");
    assert_eq!(
        after["env"]["ANTHROPIC_BASE_URL"],
        "http://127.0.0.1:18764/v1"
    );
    let env = native_json(
        &path
            .ancestors()
            .nth(3)
            .unwrap()
            .join("configuration/environment.json"),
    );
    assert_eq!(env["DISABLE_AUTOUPDATER"], "0");
    for key in [
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    ] {
        assert_eq!(env[key], "second-model", "launcher model route {key}");
        assert_eq!(
            after["env"][key], "second-model",
            "native model route {key}"
        );
    }
    assert_eq!(
        env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"],
        before["env"]["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]
    );
    assert_eq!(env["ANTHROPIC_MODEL"], "second-model");
}

#[test]
fn native_merge_preserves_codex_tables_comments_and_context() {
    let temp = root();
    let path = seed_native(temp.path(), AgentId::Codex, "home/.codex/config.toml", "# user configuration\nmodel_context_window = 765432\nmodel_max_output_tokens = 12345\napproval_policy = \"never\"\n[history]\npersistence = \"save-all\"\n[mcp_servers.custom]\ncommand = \"custom-server\"\n[model_providers.other]\nbase_url = \"https://example.test\"\n[model_providers.ae_switch]\ncustom_flag = true\n");
    reconfigure_twice(temp.path(), AgentId::Codex);
    let text = std::fs::read_to_string(path).unwrap();
    let doc = text.parse::<toml_edit::DocumentMut>().unwrap();
    assert!(text.starts_with("# user configuration\n"));
    assert_eq!(doc["model_context_window"].as_integer(), Some(765432));
    assert_eq!(doc["model_max_output_tokens"].as_integer(), Some(12345));
    assert_eq!(
        doc["mcp_servers"]["custom"]["command"].as_str(),
        Some("custom-server")
    );
    assert_eq!(
        doc["model_providers"]["other"]["base_url"].as_str(),
        Some("https://example.test")
    );
    assert_eq!(
        doc["model_providers"]["ae_switch"]["custom_flag"].as_bool(),
        Some(true)
    );
    assert_eq!(doc["model"].as_str(), Some("second-model"));
}

#[test]
fn native_merge_preserves_opencode_models_capabilities_and_auxiliary_selection() {
    let temp = root();
    let path = seed_native(
        temp.path(),
        AgentId::OpenCode,
        "configuration/opencode.json",
        r#"{
      "model":"ae_switch/old-model","small_model":"other/small","mcp":{"local":{"enabled":true}},
      "permission":{"bash":"ask"},"plugin":["custom"],
      "provider":{"other":{"models":{"foreign":{"limit":{"context":999}}}},
        "ae_switch":{"options":{"timeout":987},"models":{"old-model":{"name":"My model","limit":{"context":321000,"output":17000},"modalities":{"input":["text","image"]}},"extra":{"limit":{"context":654000}}}}}
    }"#,
    );
    let before = native_json(&path);
    reconfigure_twice(temp.path(), AgentId::OpenCode);
    let after = native_json(&path);
    for key in ["mcp", "permission", "plugin"] {
        assert_eq!(after[key], before[key]);
    }
    assert_eq!(after["small_model"], "ae_switch/second-model");
    assert_eq!(after["provider"]["other"], before["provider"]["other"]);
    assert_eq!(
        after["provider"]["ae_switch"]["models"]["extra"],
        before["provider"]["ae_switch"]["models"]["extra"]
    );
    let selected = &after["provider"]["ae_switch"]["models"]["second-model"];
    assert_eq!(selected["limit"]["context"], 321000);
    assert_eq!(selected["limit"]["output"], 17000);
    assert_eq!(
        selected["modalities"],
        before["provider"]["ae_switch"]["models"]["old-model"]["modalities"]
    );
    assert_eq!(after["provider"]["ae_switch"]["options"]["timeout"], 987);
}

#[test]
fn native_merge_preserves_hermes_yaml_and_omp_provider_models_and_roles() {
    let temp = root();
    let hermes = seed_native(temp.path(), AgentId::Hermes, "home/.hermes/config.yaml", "# user settings\nmodel:\n  default: old-model\n  context_length: 444000\n  extra: true\nmcp:\n  server:\n    command: user-server\npermissions:\n  mode: ask\nprompt: |\n  Keep this multiline text.\n  And this line.\n");
    reconfigure_twice(temp.path(), AgentId::Hermes);
    let text = std::fs::read_to_string(hermes).unwrap();
    assert!(text.contains("context_length: 444000"));
    assert!(text.contains("command: user-server"));
    assert!(text.contains("prompt: |\n  Keep this multiline text.\n  And this line."));
    assert!(text.contains("\"second-model\""));
    let models = seed_native(temp.path(), AgentId::OhMyPi, "home/.omp/agent/models.yml", "providers:\n  other:\n    baseUrl: https://example.test\n    models:\n      - id: foreign\n        contextWindow: 777000\n  ae_switch:\n    custom: preserve\n    models:\n      - id: old-model\n        name: Custom display\n        contextWindow: 456000\n        maxTokens: 23000\n        reasoning: true\n      - id: extra-model\n        contextWindow: 888000\n");
    let config = seed_native(temp.path(), AgentId::OhMyPi, "home/.omp/agent/config.yml", "modelRoles:\n  default: ae_switch/old-model\n  planner: other/foreign\ncontext:\n  compactionThreshold: 0.8\nmcp:\n  enabled: true\n");
    reconfigure_twice(temp.path(), AgentId::OhMyPi);
    let text = std::fs::read_to_string(models).unwrap();
    for value in [
        "https://example.test",
        "contextWindow: 777000",
        "custom: preserve",
        "contextWindow: 456000",
        "maxTokens: 23000",
        "reasoning: true",
        "id: extra-model",
    ] {
        assert!(text.contains(value), "{value}");
    }
    assert!(text.contains("\"second-model\""));
    let text = std::fs::read_to_string(config).unwrap();
    assert!(text.contains("planner: other/foreign"));
    assert!(text.contains("compactionThreshold: 0.8"));
}

#[test]
fn native_merge_updates_only_selected_omp_routing_and_authorization_overrides() {
    let temp = root();
    let before = serde_json::json!({"providers": {
        "foreign":{"baseUrl":"https://foreign.invalid","headers":{"Authorization":"foreign-token"}},
        "ae_switch":{
            "custom":"keep", "headers":{"Authorization":"", "aUtHoRiZaTiOn":"Bearer old-token", "X-Provider":"keep", "Proxy-Authorization":"Basic proxy-token"},
            "models":[
                {"id":"old-model","api":"anthropic-messages","baseUrl":"https://old.invalid","contextWindow":456000,"maxTokens":23000,"reasoning":true,"apiKey":"unknown-field","headers":{"authorization":"Bearer old-token","X-Model":"keep"}},
                {"id":"inherited-model","contextWindow":321000,"maxTokens":17000},
                {"id":"extra-model","api":"anthropic-messages","baseUrl":"https://extra.invalid","headers":{"Authorization":"extra-token"},"contextWindow":888000}
            ],
            "modelOverrides":{
                "old-model":{"api":"openai-responses","contextWindow":765000,"headers":{"AUTHORIZATION":"old-override-token","X-Override":"keep"}},
                "new-model":{"api":"anthropic-messages","maxTokens":34000,"headers":{"Authorization":"new-override-token","X-Override":"keep"}},
                "extra-model":{"api":"anthropic-messages","contextWindow":999000,"headers":{"Authorization":"extra-override-token"}}
            }
        }
    }});
    let path = seed_native(
        temp.path(),
        AgentId::OhMyPi,
        "home/.omp/agent/models.yml",
        &serde_json::to_string_pretty(&before).unwrap(),
    );
    let settings = seed_native(
        temp.path(),
        AgentId::OhMyPi,
        "home/.omp/agent/config.yml",
        "modelRoles:\n  default: ae_switch/old-model\n  planner: foreign/keep\ncontext:\n  compactionThreshold: 0.8\n",
    );
    let mut previous_selection = None;
    for (port, token, model) in [
        (18763, "first-token", "old-model"),
        (18764, "rotated-token", "new-model"),
        (18765, "third-token", "inherited-model"),
    ] {
        configure(
            temp.path(),
            AgentId::OhMyPi,
            &format!("http://127.0.0.1:{port}/v1"),
            token,
            model,
        )
        .unwrap();
        let after = native_json(&path);
        let provider = &after["providers"]["ae_switch"];
        assert_eq!(
            after["providers"]["foreign"],
            before["providers"]["foreign"]
        );
        assert_eq!(provider["custom"], "keep");
        let mut provider_headers = before["providers"]["ae_switch"]["headers"].clone();
        for name in ["Authorization", "aUtHoRiZaTiOn"] {
            provider_headers[name] = format!("Bearer {token}").into();
        }
        assert_eq!(provider["headers"], provider_headers);
        assert_eq!(
            provider["models"][2],
            before["providers"]["ae_switch"]["models"][2]
        );
        assert_eq!(
            provider["modelOverrides"]["extra-model"],
            before["providers"]["ae_switch"]["modelOverrides"]["extra-model"]
        );
        let rows = provider["models"].as_array().unwrap();
        if let Some((previous, expected)) = &previous_selection {
            assert_eq!(
                rows.iter().find(|row| &row["id"] == previous).unwrap(),
                expected
            );
        }
        let selected = rows.iter().find(|row| row["id"] == model).unwrap();
        if model == "inherited-model" {
            for key in ["api", "baseUrl", "headers", "apiKey"] {
                assert!(
                    selected.get(key).is_none(),
                    "missing {key} must stay missing"
                );
            }
            assert!(provider["modelOverrides"].get(model).is_none());
            assert_eq!(selected["contextWindow"], 321000);
            assert_eq!(selected["maxTokens"], 17000);
        } else {
            assert_eq!(selected["api"], "openai-completions");
            assert_eq!(selected["baseUrl"], format!("http://127.0.0.1:{port}/v1"));
            assert_eq!(selected["apiKey"], "unknown-field");
            assert_eq!(selected["contextWindow"], 456000);
            assert_eq!(selected["maxTokens"], 23000);
            assert_eq!(selected["reasoning"], true);
            assert_eq!(
                selected["headers"]["authorization"],
                format!("Bearer {token}")
            );
            assert_eq!(selected["headers"]["X-Model"], "keep");
            let mut expected_override =
                before["providers"]["ae_switch"]["modelOverrides"][model].clone();
            expected_override["api"] = "openai-completions".into();
            let name = if model == "old-model" {
                "AUTHORIZATION"
            } else {
                "Authorization"
            };
            expected_override["headers"][name] = format!("Bearer {token}").into();
            assert_eq!(provider["modelOverrides"][model], expected_override);
        }
        let text = std::fs::read_to_string(&settings).unwrap();
        assert!(text.contains("planner: foreign/keep"));
        assert!(text.contains("compactionThreshold: 0.8"));
        previous_selection = Some((serde_json::Value::String(model.into()), selected.clone()));
    }
}

#[test]
fn native_merge_updates_existing_hermes_inline_credentials_and_preserves_missing_fields() {
    for credentials in [
        serde_json::json!({"api_key":"", "api":"legacy-token"}),
        serde_json::json!({"api_key":"old-token"}),
        serde_json::json!({"api":"legacy-token"}),
        serde_json::json!({}),
    ] {
        let temp = root();
        let mut before = serde_json::json!({
            "model":{"default":"old-model","provider":"custom","base_url":"https://old.invalid","key_env":"OLD_KEY","context_length":444000,"extra":true},
            "history":{"keep":true}, "mcp":{"custom":{"command":"user-server"}}
        });
        for (key, value) in credentials.as_object().unwrap() {
            before["model"][key] = value.clone();
        }
        let path = seed_native(
            temp.path(),
            AgentId::Hermes,
            "home/.hermes/config.yaml",
            &serde_json::to_string_pretty(&before).unwrap(),
        );
        for (port, token, model) in [
            (18763, "first-token", "first-model"),
            (18764, "rotated-token", "second-model"),
        ] {
            configure(
                temp.path(),
                AgentId::Hermes,
                &format!("http://127.0.0.1:{port}/v1"),
                token,
                model,
            )
            .unwrap();
            let mut expected = before.clone();
            expected["model"]["default"] = model.into();
            expected["model"]["base_url"] = format!("http://127.0.0.1:{port}/v1").into();
            expected["model"]["key_env"] = "AE_SWITCH_API_KEY".into();
            expected["model"]["api_mode"] = "chat_completions".into();
            for key in ["api_key", "api"] {
                if credentials.get(key).is_some() {
                    expected["model"][key] = token.into();
                }
            }
            expected["auxiliary"] = serde_json::json!({});
            for task in ["compression", "title_generation", "background_review"] {
                expected["auxiliary"][task] = serde_json::json!({
                    "provider":"custom", "model":model,
                    "base_url":format!("http://127.0.0.1:{port}/v1"),
                    "key_env":"AE_SWITCH_API_KEY", "api_mode":"chat_completions"
                });
            }
            assert_eq!(native_json(&path), expected);
        }
    }
}

#[test]
fn native_merge_rejects_invalid_omp_and_hermes_overrides_before_any_file_write() {
    for (agent, relative, source) in [
        (
            AgentId::OhMyPi,
            "home/.omp/agent/models.yml",
            r#"{"providers":{"ae_switch":{"headers":[]}}}"#,
        ),
        (
            AgentId::OhMyPi,
            "home/.omp/agent/models.yml",
            r#"{"providers":{"ae_switch":{"models":[{"id":"second-model","api":42}]}}}"#,
        ),
        (
            AgentId::OhMyPi,
            "home/.omp/agent/models.yml",
            r#"{"providers":{"ae_switch":{"models":[{"id":"second-model","baseUrl":[]}]}}}"#,
        ),
        (
            AgentId::OhMyPi,
            "home/.omp/agent/models.yml",
            r#"{"providers":{"ae_switch":{"models":[{"id":"second-model","headers":{"authorization":42}}]}}}"#,
        ),
        (
            AgentId::OhMyPi,
            "home/.omp/agent/models.yml",
            r#"{"providers":{"ae_switch":{"modelOverrides":{"second-model":{"api":42}}}}}"#,
        ),
        (
            AgentId::OhMyPi,
            "home/.omp/agent/models.yml",
            r#"{"providers":{"ae_switch":{"modelOverrides":{"second-model":{"headers":{"Authorization":[]}}}}}}"#,
        ),
        (
            AgentId::Hermes,
            "home/.hermes/config.yaml",
            r#"{"model":{"api_key":[]}}"#,
        ),
        (
            AgentId::Hermes,
            "home/.hermes/config.yaml",
            r#"{"model":{"api":42}}"#,
        ),
    ] {
        let temp = root();
        let mut originals = vec![(
            seed_native(temp.path(), agent, relative, source),
            source.as_bytes().to_vec(),
        )];
        if agent == AgentId::OhMyPi {
            let text = "modelRoles:\n  default: ae_switch/old-model\n  planner: foreign/keep\n";
            originals.push((
                seed_native(temp.path(), agent, "home/.omp/agent/config.yml", text),
                text.as_bytes().to_vec(),
            ));
        }
        for (relative, text) in [
            (
                "configuration/environment.json",
                r#"{"AE_GATEWAY_TOKEN":"existing-token","USER_FLAG":"keep"}"#,
            ),
            ("launch.ps1", "# existing PowerShell launcher\n"),
            ("launch.cmd", "@rem existing cmd launcher\r\n"),
            ("launch.sh", "# existing shell launcher\n"),
        ] {
            originals.push((
                seed_native(temp.path(), agent, relative, text),
                text.as_bytes().to_vec(),
            ));
        }
        let error = configure(
            temp.path(),
            agent,
            "http://127.0.0.1:18764/v1",
            "new-token",
            "second-model",
        )
        .unwrap_err();
        assert_eq!(error.code, "invalid_agent_configuration");
        assert!(!error.message.contains("existing-token"));
        assert!(!error.message.contains("new-token"));
        for (path, before) in originals {
            assert_eq!(std::fs::read(&path).unwrap(), before, "{}", path.display());
        }
    }
}

#[test]
fn native_merge_preserves_workbuddy_rows_and_selected_capability_flags() {
    let temp = root();
    let path = seed_native(
        temp.path(),
        AgentId::WorkBuddy,
        "home/.workbuddy/models.json",
        r#"[
      {"id":"old-model","name":"Custom display","url":"http://127.0.0.1:18760/v1","apiKey":"old","supportsToolCall":false,"supportsImages":true,"supportsReasoning":true,"useCustomProtocol":false,"customFlag":42},
      {"id":"foreign","name":"Foreign","url":"https://example.test","vendor":"anthropic","supportsImages":true}
    ]"#,
    );
    seed_native(
        temp.path(),
        AgentId::WorkBuddy,
        "configuration/environment.json",
        r#"{"AE_WORKBUDDY_MODEL":"old-model"}"#,
    );
    let before = native_json(&path);
    reconfigure_twice(temp.path(), AgentId::WorkBuddy);
    let after = native_json(&path);
    assert_eq!(after.as_array().unwrap().len(), 4);
    assert_eq!(after[0], before[0]);
    assert_eq!(after[1], before[1]);
    assert_eq!(after[3]["id"], "second-model");
    assert_eq!(after[3]["apiKey"], "new-token");
    configure(
        temp.path(),
        AgentId::WorkBuddy,
        "http://127.0.0.1:18765/v1",
        "third-token",
        "old-model",
    )
    .unwrap();
    let selected = native_json(&path);
    for key in [
        "name",
        "supportsToolCall",
        "supportsImages",
        "supportsReasoning",
        "useCustomProtocol",
        "customFlag",
    ] {
        assert_eq!(selected[0][key], before[0][key]);
    }
    assert_eq!(selected[0]["apiKey"], "third-token");
}

#[test]
fn native_merge_preserves_zcode_rule_options_and_builtin_bytes() {
    let temp = root();
    let path = seed_native(
        temp.path(),
        AgentId::Zcode,
        "configuration/zcode-providers.json",
        r#"{
      "schemaVersion":1,"customRoot":true,"config":{
        "providerConfigRules":{"providerRules":[{"providerId":"foreign","enabled":false,"config":{"custom":1}},{"providerId":"ae_switch","enabled":true,"config":{"personalModelIds":["old-model","extra-model"],"custom":2}}]},
        "modelConfigRules":{"providerModelRules":[{"custom":3}],"manualProviderModelRules":[{"custom":4}]},
        "defaultModelSelection":{"providerId":"ae_switch","modelId":"old-model","options":{"reasoningLevel":"high","maxOutputTokens":45000}}
      }}"#,
    );
    let builtin_text = "{\"schemaVersion\":1,\"revision\":99,\"config\":{\"providerConfigRules\":{},\"modelConfigRules\":{\"modelRules\":[{\"custom\":true}]}}}\n";
    let builtin = seed_native(
        temp.path(),
        AgentId::Zcode,
        "configuration/zcode-builtin.json",
        builtin_text,
    );
    let before = native_json(&path);
    reconfigure_twice(temp.path(), AgentId::Zcode);
    let after = native_json(&path);
    assert_eq!(std::fs::read_to_string(builtin).unwrap(), builtin_text);
    assert_eq!(
        after["config"]["modelConfigRules"],
        before["config"]["modelConfigRules"]
    );
    assert_eq!(
        after["config"]["defaultModelSelection"]["options"],
        before["config"]["defaultModelSelection"]["options"]
    );
    assert_eq!(
        after["config"]["providerConfigRules"]["providerRules"][0],
        before["config"]["providerConfigRules"]["providerRules"][0]
    );
    assert_eq!(
        after["config"]["providerConfigRules"]["providerRules"][1]["enabled"],
        true
    );
    assert!(
        after["config"]["providerConfigRules"]["providerRules"][1]["config"]["personalModelIds"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("extra-model"))
    );
    assert_eq!(
        after["config"]["defaultModelSelection"]["modelId"],
        "second-model"
    );
}

#[test]
fn native_merge_preserves_deepseek_profile_patch_rows_and_workspace_bytes() {
    let temp = root();
    let agent = AgentId::DeepSeekHarness;
    let manifest = seed_native(
        temp.path(),
        agent,
        "home/.dsh/profiles/headless/package.json",
        r#"{"name":"user-profile","private":false,"dependencies":{"custom-plugin":"1.0"},"dsh":{"profile":{"bundles":["custom-bundle"],"custom":true}}}"#,
    );
    let workspace_text = "packages:\n  - .\n  - plugins/*\nnodeLinker: isolated\nautoInstallPeers: true\ncustomSetting: preserve\n";
    let workspace = seed_native(
        temp.path(),
        agent,
        "home/.dsh/profiles/headless/pnpm-workspace.yaml",
        workspace_text,
    );
    let patch = seed_native(
        temp.path(),
        agent,
        "home/.dsh/profiles/headless/cordis.patch.yml",
        r#"[
      {"id":"custom-plugin","disabled":false,"config":{"contextWindow":555000}},
      {"id":"llm-pi-ai","config":{"providers":{"foreign":{"models":[{"id":"foreign"}]},"ae-switch":{"models":[{"id":"old-model","contextWindow":222000,"maxTokens":16000,"reasoning":true},{"id":"extra"}],"custom":9}}}},
      {"id":"agent-default-model","config":{"provider":"ae-switch","model":"old-model","custom":8}},
      {"id":"session-log-deepseek","disabled":false,"config":{"retain":true}},
      {"id":"session-title-llm","disabled":false},
      {"id":"session-telemetry-otel","disabled":false},
      {"id":"pwsh-sandbox","disabled":false,"config":{"pwshPath":"old","custom":7}}
    ]"#,
    );
    let before = native_json(&patch);
    reconfigure_twice(temp.path(), agent);
    assert_eq!(std::fs::read_to_string(workspace).unwrap(), workspace_text);
    let package = native_json(&manifest);
    assert_eq!(package["name"], "user-profile");
    assert_eq!(package["private"], false);
    assert_eq!(package["dependencies"]["custom-plugin"], "1.0");
    assert!(package["dsh"]["profile"]["bundles"]
        .as_array()
        .unwrap()
        .contains(&serde_json::json!("custom-bundle")));
    let after = native_json(&patch);
    assert_eq!(after[0], before[0]);
    assert_eq!(
        after[1]["config"]["providers"]["foreign"],
        before[1]["config"]["providers"]["foreign"]
    );
    assert_eq!(
        after[1]["config"]["providers"]["ae-switch"]["models"][0],
        before[1]["config"]["providers"]["ae-switch"]["models"][0]
    );
    let selected = after[1]["config"]["providers"]["ae-switch"]["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == "second-model")
        .unwrap();
    assert_eq!(selected["id"], "second-model");
    assert_eq!(selected["contextWindow"], 222000);
    assert_eq!(selected["maxTokens"], 16000);
    assert_eq!(selected["reasoning"], true);
    for index in 3..7 {
        assert_eq!(after[index]["disabled"], before[index]["disabled"]);
    }
    assert_eq!(after[6]["config"]["custom"], 7);
}

fn reject_deepseek_patch_without_writes(patch: &str, expected_code: &str) {
    let temp = root();
    let agent = AgentId::DeepSeekHarness;
    let originals: Vec<_> = [
        (
            "home/.dsh/profiles/headless/package.json",
            r#"{"name":"user-profile","private":false,"dependencies":{"custom-plugin":"1.0"},"dsh":{"profile":{"bundles":["custom-bundle"],"custom":true}}}"#,
        ),
        (
            "home/.dsh/profiles/headless/pnpm-workspace.yaml",
            "packages:\n  - .\n  - plugins/*\nnodeLinker: isolated\nautoInstallPeers: true\n",
        ),
        ("home/.dsh/profiles/headless/cordis.patch.yml", patch),
        (
            "configuration/environment.json",
            r#"{"AE_GATEWAY_TOKEN":"existing-token","USER_FLAG":"keep"}"#,
        ),
        ("launch.ps1", "# existing PowerShell launcher\n"),
        ("launch.cmd", "@rem existing cmd launcher\r\n"),
        ("launch.sh", "# existing shell launcher\n"),
    ]
    .into_iter()
    .map(|(relative, text)| {
        (
            seed_native(temp.path(), agent, relative, text),
            text.as_bytes().to_vec(),
        )
    })
    .collect();
    let error = configure(
        temp.path(),
        agent,
        "http://127.0.0.1:18764/v1",
        "new-token",
        "second-model",
    )
    .unwrap_err();
    assert_eq!(error.code, expected_code);
    assert!(!error.message.contains("existing-token"));
    assert!(!error.message.contains("new-token"));
    for (path, before) in originals {
        assert_eq!(std::fs::read(&path).unwrap(), before, "{}", path.display());
    }
}

#[test]
fn native_merge_updates_deepseek_authorization_preserving_header_keys_and_other_fields() {
    for headers in [
        serde_json::json!({"Authorization":"Bearer stale-token"}),
        serde_json::json!({"authorization":"Bearer stale-token"}),
        serde_json::json!({"aUtHoRiZaTiOn":""}),
        serde_json::json!({"AUTHORIZATION":"Basic stale-token"}),
        serde_json::json!({"Authorization":"new-token"}),
        serde_json::json!({"Authorization":"Bearer new-token","authorization":"Bearer new-token"}),
        serde_json::json!({"Authorization":"Bearer new-token","AUTHORIZATION":"Bearer stale-token"}),
    ] {
        let mut headers = headers;
        headers["X-Custom"] = "keep".into();
        headers["pRoXy-AuThOrIzAtIoN"] = "Basic proxy-token".into();
        let patch = serde_json::json!([
            {"id":"custom-plugin","disabled":false,"config":{"contextWindow":555000}},
            {"id":"llm-pi-ai","config":{"providers":{
                "foreign":{"headers":{"Authorization":"Bearer foreign-token"}},
                "ae-switch":{"apiKey":"unrecognized-field","headers":headers,"models":[{"id":"old-model","contextWindow":222000}]}
            }}},
            {"id":"agent-default-model","config":{"provider":"ae-switch","model":"old-model","custom":8}}
        ]);
        let block_headers = patch[1]["config"]["providers"]["ae-switch"]["headers"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(name, value)| format!("          {name}: {value}\n"))
            .collect::<String>();
        let block_patch = format!(
            "# user patch\n- id: custom-plugin\n  config:\n    retain: true\n- id: llm-pi-ai\n  config:\n    providers:\n      foreign:\n        headers:\n          Authorization: Bearer foreign-token\n      ae-switch:\n        apiKey: unrecognized-field\n        headers:\n{block_headers}        models:\n          - id: old-model\n            contextWindow: 222000\n- id: agent-default-model\n  config:\n    provider: ae-switch\n    model: old-model\n    custom: 8\n"
        );
        for source in [serde_json::to_string_pretty(&patch).unwrap(), block_patch] {
            let temp = root();
            let path = seed_native(
                temp.path(),
                AgentId::DeepSeekHarness,
                "home/.dsh/profiles/headless/cordis.patch.yml",
                &source,
            );
            let before = native_merge::Yaml::parse(Some(&source), &path, serde_json::json!([]))
                .unwrap()
                .value();
            for (port, token, model) in [
                (18763, "new-token", "first-model"),
                (18764, "rotated-token", "second-model"),
            ] {
                configure(
                    temp.path(),
                    AgentId::DeepSeekHarness,
                    &format!("http://127.0.0.1:{port}/v1"),
                    token,
                    model,
                )
                .unwrap();
                let after = native_merge::Yaml::parse(
                    Some(&std::fs::read_to_string(&path).unwrap()),
                    &path,
                    serde_json::json!([]),
                )
                .unwrap()
                .value();
                let provider = &after[1]["config"]["providers"]["ae-switch"];
                let mut expected_headers = headers.clone();
                for (name, value) in expected_headers.as_object_mut().unwrap() {
                    if name.eq_ignore_ascii_case("authorization") {
                        *value = format!("Bearer {token}").into();
                    }
                }
                assert_eq!(provider["headers"], expected_headers);
                assert_eq!(provider["apiKey"], "unrecognized-field");
                assert_eq!(provider["apiKeyEnv"], "AE_GATEWAY_TOKEN");
                assert_eq!(provider["baseURL"], format!("http://127.0.0.1:{port}/v1"));
                assert_eq!(
                    provider["models"][0],
                    before[1]["config"]["providers"]["ae-switch"]["models"][0]
                );
                assert_eq!(after[0], before[0]);
                assert_eq!(
                    after[1]["config"]["providers"]["foreign"],
                    before[1]["config"]["providers"]["foreign"]
                );
                assert_eq!(after[2]["config"]["model"], model);
                assert_eq!(after[2]["config"]["custom"], 8);
            }
        }
    }
}

#[test]
fn native_merge_rejects_invalid_deepseek_headers_before_any_file_write() {
    for headers in [
        serde_json::json!(null),
        serde_json::json!([]),
        serde_json::json!("Authorization: Bearer stale-token"),
        serde_json::json!(42),
        serde_json::json!({"X-Custom":true}),
        serde_json::json!({"authorization":42}),
        serde_json::json!({"Authorization":"Bearer new-token","X-Custom":null}),
    ] {
        let patch = serde_json::json!([
            {"id":"llm-pi-ai","config":{"providers":{"ae-switch":{"headers":headers}}}}
        ]);
        reject_deepseek_patch_without_writes(
            &serde_json::to_string(&patch).unwrap(),
            "invalid_agent_configuration",
        );
    }
}

#[test]
fn native_merge_preserves_deepseek_compatible_headers_and_unknown_credentials() {
    for authorization_count in 0..=2 {
        let temp = root();
        let mut headers = serde_json::json!({
            "X-Custom":"keep", "User-Agent":"custom-agent",
            "OpenAI-Organization":"custom-org", "OpenAI-Project":"custom-project",
            "pRoXy-AuThOrIzAtIoN":"Basic proxy-token"
        });
        if authorization_count > 0 {
            headers["aUtHoRiZaTiOn"] = "Bearer new-token".into();
        }
        if authorization_count > 1 {
            headers["Authorization"] = "Bearer new-token".into();
        }
        let before = serde_json::json!([
            {"id":"llm-pi-ai","config":{"providers":{
                "foreign":{"apiKey":"foreign-key","headers":{"Authorization":"Bearer foreign-token"}},
                "ae-switch":{"apiKey":"unrecognized-field","apiKeyEnv":"OLD_KEY","headers":headers,"models":[{"id":"old-model","contextWindow":222000}]}
            }}},
            {"id":"agent-default-model","config":{"provider":"ae-switch","model":"old-model"}}
        ]);
        let path = seed_native(
            temp.path(),
            AgentId::DeepSeekHarness,
            "home/.dsh/profiles/headless/cordis.patch.yml",
            &serde_json::to_string_pretty(&before).unwrap(),
        );
        reconfigure_twice(temp.path(), AgentId::DeepSeekHarness);
        let after = native_json(&path);
        let provider = &after[0]["config"]["providers"]["ae-switch"];
        assert_eq!(provider["headers"], headers);
        assert_eq!(provider["apiKey"], "unrecognized-field");
        assert_eq!(provider["apiKeyEnv"], "AE_GATEWAY_TOKEN");
        assert_eq!(provider["baseURL"], "http://127.0.0.1:18764/v1");
        assert_eq!(after[1]["config"]["model"], "second-model");
        assert_eq!(
            after[0]["config"]["providers"]["foreign"],
            before[0]["config"]["providers"]["foreign"]
        );
        configure(
            temp.path(),
            AgentId::DeepSeekHarness,
            "http://127.0.0.1:18765/v1",
            "rotated-token",
            "third-model",
        )
        .unwrap();
        let rotated = native_json(&path);
        let mut expected_headers = headers;
        for name in ["aUtHoRiZaTiOn", "Authorization"] {
            if let Some(value) = expected_headers.get_mut(name) {
                *value = "Bearer rotated-token".into();
            }
        }
        assert_eq!(
            rotated[0]["config"]["providers"]["ae-switch"]["headers"],
            expected_headers
        );
        assert_eq!(
            rotated[0]["config"]["providers"]["foreign"],
            before[0]["config"]["providers"]["foreign"]
        );
    }
}

#[test]
fn native_merge_rejects_malformed_or_wrong_shape_without_partial_native_writes() {
    for (agent, paths) in [
        (
            AgentId::ClaudeCode,
            vec![("home/.claude/settings.json", "{\"env\":[]}")],
        ),
        (
            AgentId::Codex,
            vec![("home/.codex/config.toml", "model_providers = 1\n")],
        ),
        (
            AgentId::Hermes,
            vec![("home/.hermes/config.yaml", "model: [broken\n")],
        ),
        (
            AgentId::OhMyPi,
            vec![
                (
                    "home/.omp/agent/models.yml",
                    "providers:\n  other:\n    custom: keep\n",
                ),
                ("home/.omp/agent/config.yml", "modelRoles: []\n"),
            ],
        ),
        (
            AgentId::OpenCode,
            vec![("configuration/opencode.json", "{\"provider\":[]}")],
        ),
        (
            AgentId::WorkBuddy,
            vec![("home/.workbuddy/models.json", "{}")],
        ),
        (
            AgentId::Zcode,
            vec![
                (
                    "configuration/zcode-providers.json",
                    "{\"schemaVersion\":1,\"config\":{}}",
                ),
                ("configuration/zcode-builtin.json", "[broken"),
            ],
        ),
        (
            AgentId::DeepSeekHarness,
            vec![
                (
                    "home/.dsh/profiles/headless/package.json",
                    "{\"name\":\"keep\"}",
                ),
                (
                    "home/.dsh/profiles/headless/pnpm-workspace.yaml",
                    "packages:\n  - .\n",
                ),
                (
                    "home/.dsh/profiles/headless/cordis.patch.yml",
                    "{\"not\":\"array\"}",
                ),
            ],
        ),
    ] {
        let temp = root();
        let originals: Vec<_> = paths
            .into_iter()
            .map(|(relative, text)| {
                (
                    seed_native(temp.path(), agent, relative, text),
                    text.to_owned(),
                )
            })
            .collect();
        assert!(
            configure(
                temp.path(),
                agent,
                "http://127.0.0.1:18764/v1",
                "token",
                "second-model"
            )
            .is_err(),
            "{agent:?}"
        );
        for (path, text) in originals {
            assert_eq!(std::fs::read_to_string(path).unwrap(), text, "{agent:?}");
        }
        assert!(!temp
            .path()
            .join("agents")
            .join(agent.as_str())
            .join("configuration/environment.json")
            .exists());
    }
}

#[test]
fn native_merge_preserves_real_deepseek_block_yaml_and_opaque_unowned_text() {
    let temp = root();
    let patch = seed_native(temp.path(), AgentId::DeepSeekHarness, "home/.dsh/profiles/headless/cordis.patch.yml", "# user patch\n- id: custom-plugin\n  config:\n    prompt: |\n      Preserve literal instructions.\n      Including the second line.\n- id: llm-pi-ai\n  config:\n    providers:\n      ae-switch:\n        models:\n          - id: old-model\n            contextWindow: 999000\n            maxTokens: 42000\n- id: agent-default-model\n  config:\n    provider: ae-switch\n    model: old-model\n- id: session-log-deepseek\n  disabled: false\n");
    reconfigure_twice(temp.path(), AgentId::DeepSeekHarness);
    let text = std::fs::read_to_string(&patch).unwrap();
    assert!(text.starts_with("# user patch\n"));
    assert!(text.contains(
        "prompt: |\n      Preserve literal instructions.\n      Including the second line."
    ));
    assert!(text.contains("contextWindow: 999000"));
    assert!(text.contains("maxTokens: 42000"));
    assert!(text.contains("disabled: false"));
    let parsed = native_merge::Yaml::parse(Some(&text), &patch, serde_json::json!([]))
        .unwrap()
        .value();
    let provider = parsed
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == "llm-pi-ai")
        .unwrap();
    let selected = provider["config"]["providers"]["ae-switch"]["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == "second-model")
        .unwrap();
    assert_eq!(selected["contextWindow"], 999000);
    assert_eq!(selected["maxTokens"], 42000);
}

#[test]
fn native_merge_rejects_ambiguous_rows_unsupported_yaml_and_workbuddy_transport_conflicts() {
    for (agent, relative, text, model) in [
        (
            AgentId::ClaudeCode,
            "home/.claude/settings.json",
            r#"{"env":{"USER_FLAG":"keep"},"env":{}}"#,
            "selected",
        ),
        (
            AgentId::WorkBuddy,
            "home/.workbuddy/models.json",
            r#"[{"id":"selected","vendor":"anthropic","supportsImages":true}]"#,
            "selected",
        ),
        (
            AgentId::WorkBuddy,
            "home/.workbuddy/models.json",
            r#"[{"id":"selected","useCustomProtocol":true}]"#,
            "selected",
        ),
        (
            AgentId::WorkBuddy,
            "home/.workbuddy/models.json",
            r#"[{"id":"selected"},{"id":"selected"}]"#,
            "selected",
        ),
        (
            AgentId::Hermes,
            "home/.hermes/config.yaml",
            "model: &shared\n  default: old\nother: *shared\n",
            "selected",
        ),
        (
            AgentId::Hermes,
            "home/.hermes/config.yaml",
            "model:\n  default: old\n  default: duplicate\n",
            "selected",
        ),
        (
            AgentId::Hermes,
            "home/.hermes/config.yaml",
            "model: {\"default\":\"old\",\"default\":\"duplicate\"}\n",
            "selected",
        ),
        (
            AgentId::Hermes,
            "home/.hermes/config.yaml",
            "\u{feff}model:\n  default: old\n",
            "selected",
        ),
        (
            AgentId::Hermes,
            "home/.hermes/config.yaml",
            "model:\n  <<: {\"default\":\"old\",\"context\":999000}\n",
            "selected",
        ),
        (
            AgentId::OhMyPi,
            "home/.omp/agent/models.yml",
            "providers:\n  ae_switch:\n    models:\n      - id: selected\n      - id: selected\n",
            "selected",
        ),
        (
            AgentId::DeepSeekHarness,
            "home/.dsh/profiles/headless/cordis.patch.yml",
            "- id: duplicated\n- id: duplicated\n",
            "selected",
        ),
    ] {
        let temp = root();
        let path = seed_native(temp.path(), agent, relative, text);
        assert!(
            configure(
                temp.path(),
                agent,
                "http://127.0.0.1:18764/v1",
                "token",
                model
            )
            .is_err(),
            "{agent:?}"
        );
        assert_eq!(std::fs::read_to_string(path).unwrap(), text);
    }
}

#[test]
fn native_merge_rejects_dialect_dependent_yaml_scalars_without_writing_any_native_file() {
    for scalar in [
        "yes",
        "ON",
        "off",
        "2026-10-09",
        "0xFF",
        "0123",
        "0o123",
        "0b101",
        "1_000",
        ".inf",
        ".NaN",
        "1:20",
        "+1",
        ".5",
        "1e3",
    ] {
        for agent in [AgentId::Hermes, AgentId::OhMyPi, AgentId::DeepSeekHarness] {
            let temp = root();
            let (relative, text) = match agent {
                AgentId::Hermes => (
                    "home/.hermes/config.yaml",
                    format!("model:\n  default: old\nuserSetting: {scalar}\n"),
                ),
                AgentId::OhMyPi => (
                    "home/.omp/agent/config.yml",
                    format!("modelRoles:\n  default: other/old\nuserSetting: {scalar}\n"),
                ),
                _ => (
                    "home/.dsh/profiles/headless/cordis.patch.yml",
                    format!("- id: user-plugin\n  config:\n    userSetting: {scalar}\n"),
                ),
            };
            let path = seed_native(temp.path(), agent, relative, &text);
            let package = if agent == AgentId::DeepSeekHarness {
                Some(seed_native(
                    temp.path(),
                    agent,
                    "home/.dsh/profiles/headless/package.json",
                    "{\"name\":\"user-package\"}\n",
                ))
            } else {
                None
            };
            let result = configure(
                temp.path(),
                agent,
                "http://127.0.0.1:18764/v1",
                "token",
                "selected",
            );
            assert!(result.is_err(), "{agent:?}: {scalar}");
            assert_eq!(std::fs::read_to_string(path).unwrap(), text);
            if let Some(package) = package {
                assert_eq!(
                    std::fs::read_to_string(package).unwrap(),
                    "{\"name\":\"user-package\"}\n"
                );
            }
            if agent == AgentId::OhMyPi {
                assert!(!temp
                    .path()
                    .join("agents/oh_my_pi/home/.omp/agent/models.yml")
                    .exists());
            }
        }
    }
    let temp = root();
    let path = seed_native(
        temp.path(),
        AgentId::Hermes,
        "home/.hermes/config.yaml",
        "model:\n  default: old\nuserSetting: \"yes\"\nuserDate: '2026-10-09'\n",
    );
    reconfigure_twice(temp.path(), AgentId::Hermes);
    let text = std::fs::read_to_string(path).unwrap();
    assert!(text.contains("userSetting: \"yes\""));
    assert!(text.contains("userDate: '2026-10-09'"));
}

#[test]
fn native_merge_precommit_detects_external_changes_before_writing_other_files() {
    for initially_exists in [false, true] {
        let temp = root();
        let first = seed_native(
            temp.path(),
            AgentId::OhMyPi,
            "home/.omp/agent/models.yml",
            "providers: {}\n",
        );
        let second = temp
            .path()
            .join("agents/oh_my_pi/home/.omp/agent/config.yml");
        if initially_exists {
            std::fs::write(&second, "modelRoles: {}\n").unwrap();
        }
        let mut snapshots = vec![];
        native_merge::snapshot(temp.path(), &first, &mut snapshots).unwrap();
        native_merge::snapshot(temp.path(), &second, &mut snapshots).unwrap();
        std::fs::write(&second, "modelRoles: {}\nuserSaved: true\n").unwrap();
        let error = commit_native_configuration(
            temp.path(),
            &snapshots,
            vec![
                (first.clone(), "replacement".into()),
                (second.clone(), "replacement".into()),
            ],
        )
        .unwrap_err();
        assert_eq!(error.code, "agent_configuration_changed");
        assert_eq!(std::fs::read_to_string(first).unwrap(), "providers: {}\n");
        assert_eq!(
            std::fs::read_to_string(second).unwrap(),
            "modelRoles: {}\nuserSaved: true\n"
        );
    }
}

#[test]
fn native_merge_updates_active_codex_profile_selection_and_preserves_its_user_settings() {
    let temp = root();
    let path = seed_native(temp.path(), AgentId::Codex, "home/.codex/config.toml", "profile = \"daily\"\nmodel = \"old-root\"\n[profiles.daily]\nmodel = \"old-profile\" # active selection\nmodel_provider = \"other\"\nmodel_context_window = 888000\nmodel_reasoning_effort = \"high\"\napproval_policy = \"never\"\n[profiles.other]\nmodel = \"unrelated\"\nmodel_provider = \"unrelated\"\n");
    reconfigure_twice(temp.path(), AgentId::Codex);
    let text = std::fs::read_to_string(path).unwrap();
    let doc = text.parse::<toml_edit::DocumentMut>().unwrap();
    assert_eq!(doc["profile"].as_str(), Some("daily"));
    assert_eq!(
        doc["profiles"]["daily"]["model"].as_str(),
        Some("second-model")
    );
    assert_eq!(
        doc["profiles"]["daily"]["model_provider"].as_str(),
        Some("ae_switch")
    );
    assert_eq!(
        doc["profiles"]["daily"]["model_context_window"].as_integer(),
        Some(888000)
    );
    assert_eq!(
        doc["profiles"]["daily"]["model_reasoning_effort"].as_str(),
        Some("high")
    );
    assert_eq!(
        doc["profiles"]["daily"]["approval_policy"].as_str(),
        Some("never")
    );
    assert_eq!(
        doc["profiles"]["other"]["model"].as_str(),
        Some("unrelated")
    );
    assert!(text.contains("# active selection"));
}

#[test]
fn native_merge_rejects_disabled_required_runtime_providers_and_plugins() {
    let mut cases = vec![
        (
            AgentId::Zcode,
            "configuration/zcode-providers.json",
            r#"{"schemaVersion":1,"config":{"providerConfigRules":{"providerRules":[{"providerId":"ae_switch","enabled":false}]}}}"#,
        ),
        (
            AgentId::OpenCode,
            "configuration/opencode.json",
            r#"{"disabled_providers":["ae_switch"]}"#,
        ),
        (
            AgentId::OpenCode,
            "configuration/opencode.json",
            r#"{"enabled_providers":["foreign"]}"#,
        ),
        (
            AgentId::DeepSeekHarness,
            "home/.dsh/profiles/headless/cordis.patch.yml",
            r#"[{"id":"llm-pi-ai","disabled":true}]"#,
        ),
        (
            AgentId::DeepSeekHarness,
            "home/.dsh/profiles/headless/cordis.patch.yml",
            r#"[{"id":"agent-default-model","disabled":true}]"#,
        ),
    ];
    if cfg!(windows) {
        cases.push((
            AgentId::DeepSeekHarness,
            "home/.dsh/profiles/headless/cordis.patch.yml",
            r#"[{"id":"pwsh-sandbox","disabled":true}]"#,
        ));
    }
    for (agent, relative, text) in cases {
        let temp = root();
        let path = seed_native(temp.path(), agent, relative, text);
        let error = configure(
            temp.path(),
            agent,
            "http://127.0.0.1:18764/v1",
            "token",
            "selected",
        )
        .unwrap_err();
        assert_eq!(error.code, "agent_configuration_conflict");
        assert_eq!(std::fs::read_to_string(path).unwrap(), text);
        assert!(!temp
            .path()
            .join("agents")
            .join(agent.as_str())
            .join("configuration/environment.json")
            .exists());
    }
}

#[test]
fn eight_official_agents_have_stable_ui_identifiers() {
    let agents = definitions();
    assert_eq!(agents.len(), 8);
    let ids: Vec<_> = agents.iter().map(|agent| agent.id.as_str()).collect();
    assert_eq!(
        ids,
        [
            "claude_code",
            "codex",
            "hermes",
            "oh_my_pi",
            "opencode",
            "zcode",
            "workbuddy",
            "deepseek_harness"
        ]
    );
    for agent in agents {
        assert_eq!(serde_json::to_value(agent.id).unwrap(), agent.id.as_str());
        assert!(!agent.name.is_empty());
        assert!(!agent.description.is_empty());
    }
}

#[test]
fn portable_configuration_never_returns_the_local_secret() {
    let temp = root();
    for definition in definitions() {
        let result = configure(
            temp.path(),
            definition.id,
            "http://127.0.0.1:18762/agents/demo/v1",
            "local-secret-for-regression",
            "model-\"quote",
        )
        .unwrap();
        let serialized = serde_json::to_string(&result).unwrap();
        assert!(!serialized.contains("local-secret-for-regression"));
        assert_eq!(result.id, definition.id);
        assert!(result.configured);
        assert!(Path::new(&result.launcher).starts_with(temp.path()));
        for relative in ["home", "tmp", "cache", "configuration", "workspace"] {
            assert!(Path::new(&result.directory).join(relative).is_dir());
        }
        let environment: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(
                Path::new(&result.directory).join("configuration/environment.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert!(environment["NO_PROXY"]
            .as_str()
            .unwrap()
            .contains("127.0.0.1"));
        assert!(environment["NO_PROXY"]
            .as_str()
            .unwrap()
            .contains("localhost"));
        assert!(environment["NO_PROXY"].as_str().unwrap().contains("::1"));
        assert!(environment.get("no_proxy").is_none());
        let case_insensitive_names = environment
            .as_object()
            .unwrap()
            .keys()
            .map(|name| name.to_ascii_lowercase())
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(
            case_insensitive_names.len(),
            environment.as_object().unwrap().len(),
            "PowerShell ConvertFrom-Json requires unique case-insensitive environment names"
        );
        for variable in [
            "HOME",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "TEMP",
            "TMP",
            "XDG_CONFIG_HOME",
            "XDG_DATA_HOME",
            "XDG_CACHE_HOME",
            "XDG_STATE_HOME",
            "npm_config_cache",
            "UV_CACHE_DIR",
            "PIP_CACHE_DIR",
        ] {
            assert!(
                Path::new(environment[variable].as_str().unwrap()).starts_with(temp.path()),
                "{variable} must remain portable"
            );
        }
    }
}

#[test]
fn config_files_parse_and_preserve_values_without_shell_interpolation() {
    let temp = root();
    let model = "model-quote\"-dollar$()-semicolon;";
    let token = "secret-quote\"-dollar$()-semicolon;";
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
        let configured = configure(
            temp.path(),
            agent,
            "http://127.0.0.1:18762/agents/demo/v1",
            token,
            model,
        )
        .unwrap();
        let directory = Path::new(&configured.directory);
        let env: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(directory.join("configuration/environment.json")).unwrap(),
        )
        .unwrap();
        assert!(env
            .as_object()
            .unwrap()
            .values()
            .any(|value| value == token));
        let launcher =
            std::fs::read_to_string(directory.join(execution_launcher_file_name())).unwrap();
        assert!(!launcher.contains(token));
        assert!(!launcher.contains(model));
        #[cfg(windows)]
        {
            if agent == AgentId::WorkBuddy {
                assert!(launcher.contains("@runtimeArguments"));
                assert!(launcher.contains("$runtimeArguments += $agentArguments"));
            } else if agent == AgentId::DeepSeekHarness {
                assert!(launcher.contains("[Diagnostics.Process]::Start($startInfo)"));
            } else {
                assert!(launcher.contains("@agentArguments"));
            }
        }
        assert!(!launcher.contains("Invoke-Expression"));
        for (relative, kind) in agent.config_files() {
            let contents = std::fs::read_to_string(directory.join(relative)).unwrap();
            match kind {
                ConfigKind::Json => {
                    serde_json::from_str::<serde_json::Value>(&contents).unwrap();
                }
                ConfigKind::Toml => {
                    contents.parse::<toml_edit::DocumentMut>().unwrap();
                }
                ConfigKind::Yaml => {
                    assert!(
                        contents.contains(&yaml_string(model).unwrap())
                            || contents
                                .contains(&yaml_string(&format!("ae_switch/{model}")).unwrap())
                    );
                }
            }
        }
    }
}

#[test]
fn deepseek_headless_profile_uses_official_bundles_and_gateway_environment() {
    let temp = root();
    let model = "deepseek-quote\"-$()-semicolon;";
    let token = "private-token-quote\"-$()-semicolon;";
    let base_url = "http://127.0.0.1:18762/agents/deepseek/v1";
    let configured = configure(
        temp.path(),
        AgentId::DeepSeekHarness,
        base_url,
        token,
        model,
    )
    .unwrap();
    let directory = Path::new(&configured.directory);
    let profile = directory.join("home/.dsh/profiles/headless");
    let manifest: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(profile.join("package.json")).unwrap())
            .unwrap();
    assert_eq!(
        manifest,
        serde_json::json!({
            "name":"dsh-profile-headless", "private":true, "dependencies":{},
            "dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-headless"]}}
        })
    );
    assert_eq!(
        std::fs::read_to_string(profile.join("pnpm-workspace.yaml")).unwrap(),
        "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n"
    );
    let patch_text = std::fs::read_to_string(profile.join("cordis.patch.yml")).unwrap();
    assert!(!patch_text.contains(token));
    let patch: serde_json::Value = serde_json::from_str(&patch_text).unwrap();
    assert_eq!(
        patch[0],
        serde_json::json!({"id":"llm-pi-ai","config":{"providers":{"ae-switch":{
            "api":"openai-completions","baseURL":base_url,"apiKeyEnv":"AE_GATEWAY_TOKEN","models":[{"id":model}]
        }}}})
    );
    assert_eq!(
        patch[1],
        serde_json::json!({"id":"agent-default-model","config":{"provider":"ae-switch","model":model}})
    );
    for (index, id) in ["session-log-deepseek", "session-telemetry-otel"]
        .iter()
        .enumerate()
    {
        assert_eq!(
            patch[index + 2],
            serde_json::json!({"id":id,"disabled":true})
        );
    }
    assert_eq!(
        patch.as_array().unwrap().len(),
        if cfg!(windows) { 5 } else { 4 }
    );
    let environment: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(directory.join("configuration/environment.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(environment["AE_GATEWAY_TOKEN"], token);
    assert_eq!(
        environment["DSH_HOME"],
        serde_json::json!(directory.join("home/.dsh"))
    );
    assert_eq!(environment["DSH_TELEMETRY_MODE"], "DISABLED");
    assert!(environment.get("DSH_PERMISSION_MODE").is_none());
    #[cfg(windows)]
    {
        assert_eq!(environment["POWERSHELL_TELEMETRY_OPTOUT"], "1");
        assert_eq!(
            environment["PSModuleAnalysisCachePath"],
            serde_json::json!(directory.join("cache/pwsh/ModuleAnalysisCache"))
        );
    }
    let definition = definitions()
        .into_iter()
        .find(|item| item.id == AgentId::DeepSeekHarness)
        .unwrap();
    assert_eq!(definition.protocol, "openai");
}

#[test]
fn deepseek_powershell_launcher_selects_headless_and_cleans_inherited_hooks() {
    let launcher = powershell_launcher(AgentId::DeepSeekHarness);
    assert!(launcher.contains("@($env:AE_DSH_ENTRY, '--profile', 'headless') + $agentArguments"));
    assert!(launcher.contains("$nativeProcess = [Diagnostics.Process]::Start($startInfo)"));
    assert!(launcher.contains("$startInfo.UseShellExecute = $false"));
    assert!(launcher.contains("$startInfo.WorkingDirectory = $privateWorkspace"));
    assert!(launcher.contains("$global:LASTEXITCODE = $nativeProcess.ExitCode"));
    assert!(launcher.contains("Test-AgentExecutableSource $env:AE_DSH_PWSH"));
    assert!(launcher.contains("GetEnvironmentVariables('Process').Keys"));
    assert!(launcher
        .contains("Remove-Item -LiteralPath ('Env:' + [string]$variable) -ErrorAction Stop"));
    assert!(launcher.contains("KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION"));
    for variable in [
        "NODE_OPTIONS",
        "NODE_PATH",
        "PSModulePath",
        "DSH_HOME",
        "AE_DSH_RUNTIME",
    ] {
        assert!(launcher.contains(variable));
    }
    assert!(launcher.contains("Set-Location -LiteralPath (Join-Path $agentDirectory 'workspace')"));
    assert!(launcher.contains("if ($agentArguments.Count -eq 0)"));
    assert!(launcher.contains("Read-Host 'DeepSeek Harness task'"));
    assert!(launcher.contains("$agentArguments = @('--', '--', $task)"));
    assert!(launcher.contains("Initialize-DeepSeekOwnedDirectory $privateWorkspace"));
    assert!(launcher.contains("Initialize-DeepSeekOwnedDirectory $privateTemp"));
    assert!(launcher.contains(
        "GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $currentUser.Value"
    ));
    assert!(!launcher.contains("Invoke-Expression"));
    assert!(!launcher.contains("danger-full"));
    for agent in definitions()
        .into_iter()
        .filter(|item| item.id != AgentId::DeepSeekHarness)
    {
        let previous = powershell_launcher(agent.id);
        assert!(!previous.contains("AE_DSH_"));
        assert!(!previous.contains("GetEnvironmentVariables('Process').Keys"));
    }
}

#[cfg(windows)]
#[test]
fn deepseek_windows_pwsh_patch_is_relative_to_workspace_and_survives_move() {
    let temp = root();
    for tools in ["tools", ".tools"] {
        let package = temp.path().join(tools.trim_start_matches('.'));
        let data = package.join("data");
        let directory = data.join("agents/deepseek_harness");
        let pwsh = package.join(tools).join("pwsh/pwsh.exe");
        std::fs::create_dir_all(pwsh.parent().unwrap()).unwrap();
        std::fs::write(&pwsh, "synthetic executable path fixture").unwrap();
        let mut environment = serde_json::json!({
            "AE_AGENT_PORTABLE_RELATIVE_ROOT":"../../..", "AE_SWITCH_PORTABLE_ROOT":package,
            "AE_DSH_PWSH":pwsh
        })
        .as_object()
        .unwrap()
        .clone();
        let (snapshots, writes) = plan_agent_configuration(
            &package,
            &directory,
            AgentId::DeepSeekHarness,
            "http://127.0.0.1:18762/agents/deepseek/v1",
            "token",
            "model",
            &mut environment,
            None,
        )
        .unwrap();
        commit_native_configuration(&package, &snapshots, writes).unwrap();
        let patch_path = directory.join("home/.dsh/profiles/headless/cordis.patch.yml");
        let contents = std::fs::read_to_string(&patch_path).unwrap();
        let patch: serde_json::Value = serde_json::from_str(&contents).unwrap();
        let configured = patch
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == "pwsh-sandbox")
            .unwrap()["config"]["pwshPath"]
            .as_str()
            .unwrap();
        assert_eq!(
            configured,
            format!("..\\..\\..\\..\\{tools}\\pwsh\\pwsh.exe")
        );
        assert!(!Path::new(configured).is_absolute());
        std::fs::create_dir_all(directory.join("workspace")).unwrap();
        assert_eq!(
            directory
                .join("workspace")
                .join(configured)
                .canonicalize()
                .unwrap(),
            pwsh.canonicalize().unwrap()
        );
        let moved = temp.path().join(format!("moved-{tools}"));
        std::fs::rename(&package, &moved).unwrap();
        assert_eq!(
            std::fs::read_to_string(
                moved.join(
                    "data/agents/deepseek_harness/home/.dsh/profiles/headless/cordis.patch.yml"
                )
            )
            .unwrap(),
            contents
        );
        assert_eq!(
            moved
                .join("data/agents/deepseek_harness/workspace")
                .join(configured)
                .canonicalize()
                .unwrap(),
            moved
                .join(tools)
                .join("pwsh/pwsh.exe")
                .canonicalize()
                .unwrap()
        );
    }
}

#[cfg(windows)]
#[test]
fn deepseek_windows_launcher_rebases_runtime_preserves_arguments_and_scopes_acl() {
    use std::io::Write;
    let temp = root();
    let package = temp.path().join("original package");
    let data = package.join("data");
    let configured = configure(
        &data,
        AgentId::DeepSeekHarness,
        "http://127.0.0.1:18762/agents/deepseek/v1",
        "deepseek-fixture-token",
        "model",
    )
    .unwrap();
    let directory = Path::new(&configured.directory);
    let runtime = package.join("tools/node/node.exe");
    let entry = package.join("tools/agents/deepseek_harness/fixture.mjs");
    let pwsh = package.join("tools/pwsh/pwsh.exe");
    std::fs::create_dir_all(runtime.parent().unwrap()).unwrap();
    std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
    std::fs::create_dir_all(pwsh.parent().unwrap()).unwrap();
    let node = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join(".tools/node/node.exe");
    std::fs::copy(node, &runtime).unwrap();
    std::fs::write(&pwsh, "ordinary bundled-path fixture; never executed").unwrap();
    std::fs::write(
        &entry,
        r#"import fs from 'node:fs';
fs.writeFileSync(process.env.AE_ARGUMENT_CAPTURE, JSON.stringify({
    arguments:process.argv.slice(2), cwd:process.cwd(), dsh:process.env.DSH_HOME,
    temp:process.env.TEMP, cache:process.env.PSModuleAnalysisCachePath,
    token:process.env.AE_GATEWAY_TOKEN, secret:process.env.AE_DSH_TEST_SECRET ?? null,
    nodeOptions:process.env.NODE_OPTIONS ?? null, modules:process.env.PSModulePath ?? null
}));
process.stdout.write('中文 fixture output\n');
process.exit(23);
"#,
    )
    .unwrap();
    let environment_path = directory.join("configuration/environment.json");
    let mut environment: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&environment_path).unwrap()).unwrap();
    environment["AE_SWITCH_PORTABLE_ROOT"] = serde_json::json!(package);
    environment["AE_AGENT_PORTABLE_RELATIVE_ROOT"] = "../../..".into();
    environment["AE_DSH_RUNTIME"] = serde_json::json!(runtime);
    environment["AE_DSH_ENTRY"] = serde_json::json!(entry);
    environment["AE_DSH_PWSH"] = serde_json::json!(pwsh);
    environment
        .as_object_mut()
        .unwrap()
        .remove("AE_AGENT_BIN_PATH");
    std::fs::write(
        &environment_path,
        serde_json::to_vec_pretty(&environment).unwrap(),
    )
    .unwrap();
    let moved = temp.path().join("中文 moved package");
    std::fs::rename(&package, &moved).unwrap();
    let agent = moved.join("data/agents/deepseek_harness");
    let captured = temp.path().join("deepseek-fixture-capture.json");
    let parent_acl = temp.path().join("parent-acl.json");
    let probe = temp.path().join("deepseek-launch-probe.ps1");
    std::fs::write(&probe, r#"$ErrorActionPreference = 'Stop'
$parent = [IO.DirectoryInfo]::new($env:AE_ACL_PARENT)
function Get-FixtureAcl([IO.DirectoryInfo]$Directory) {
    if ($PSVersionTable.PSEdition -eq 'Core') { [IO.FileSystemAclExtensions]::GetAccessControl($Directory) }
    else { $Directory.GetAccessControl() }
}
$before = (Get-FixtureAcl $parent).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)
& $env:AE_FIXTURE_LAUNCHER @args
$nativeExitCode = $LASTEXITCODE
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$scoped = @('workspace','tmp') | ForEach-Object {
    $acl = Get-FixtureAcl ([IO.DirectoryInfo]::new((Join-Path $env:AE_FIXTURE_AGENT $_)))
    @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]) | Where-Object {
        $_.IdentityReference.Value -eq $sid.Value -and $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl
    }).Count -gt 0
}
@{ parentUnchanged = ((Get-FixtureAcl $parent).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All) -eq $before); scopedFullControl = @($scoped) } | ConvertTo-Json | Set-Content -LiteralPath $env:AE_ACL_CAPTURE -Encoding UTF8
exit $nativeExitCode
"#).unwrap();
    for host in ["pwsh.exe", "powershell.exe"] {
        for (arguments, prompted_task) in [
            (
                vec![],
                "literal$(); 'prompted task' embedded\"quote slash\\",
            ),
            (vec![], "--version"),
            (
                vec![
                    "--json",
                    "literal$(); 'quote' 中文",
                    "embedded\"quote",
                    "trailing\\",
                    "space trailing\\",
                    "slashes\\\\\"quote",
                    "",
                    "&|<>",
                ],
                "",
            ),
        ] {
            let mut child = std::process::Command::new(host)
                .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
                .arg(&probe)
                .args(&arguments)
                .env("AE_ARGUMENT_CAPTURE", &captured)
                .env("AE_FIXTURE_LAUNCHER", agent.join("launch.ps1"))
                .env("AE_FIXTURE_AGENT", &agent)
                .env("AE_ACL_PARENT", &moved)
                .env("AE_ACL_CAPTURE", &parent_acl)
                .env("AE_DSH_TEST_SECRET", "inherited-sensitive-fixture")
                .env("NODE_OPTIONS", "--require missing-host-hook.js")
                .env("PSModulePath", "outside-host-modules")
                .env("DSH_HOME", "outside-host-home")
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            if arguments.is_empty() {
                child
                    .stdin
                    .take()
                    .unwrap()
                    .write_all(format!("{prompted_task}\n").as_bytes())
                    .unwrap();
            } else {
                drop(child.stdin.take());
            }
            let output = child.wait_with_output().unwrap();
            assert_eq!(
                output.status.code(),
                Some(23),
                "{host}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(String::from_utf8(output.stdout)
                .unwrap()
                .contains("中文 fixture output"));
            let captured: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&captured).unwrap()).unwrap();
            let task = if arguments.is_empty() {
                vec!["--", "--", prompted_task]
            } else {
                arguments.clone()
            };
            let expected: Vec<_> = ["--profile", "headless"]
                .into_iter()
                .chain(task.iter().copied())
                .collect();
            assert_eq!(captured["arguments"], serde_json::json!(expected));
            assert_eq!(
                Path::new(captured["cwd"].as_str().unwrap()),
                agent.join("workspace")
            );
            assert_eq!(
                Path::new(captured["dsh"].as_str().unwrap()),
                agent.join("home/.dsh")
            );
            assert_eq!(
                Path::new(captured["temp"].as_str().unwrap()),
                agent.join("tmp")
            );
            assert_eq!(
                Path::new(captured["cache"].as_str().unwrap()),
                agent.join("cache/pwsh/ModuleAnalysisCache")
            );
            assert_eq!(captured["token"], "deepseek-fixture-token");
            for key in ["secret", "nodeOptions", "modules"] {
                assert!(captured[key].is_null(), "{key}");
            }
            let acl: serde_json::Value = serde_json::from_str(
                std::fs::read_to_string(&parent_acl)
                    .unwrap()
                    .trim_start_matches('\u{feff}'),
            )
            .unwrap();
            assert_eq!(acl["parentUnchanged"], true);
            assert_eq!(acl["scopedFullControl"], serde_json::json!([true, true]));
        }
    }
}

#[test]
fn invalid_inputs_fail_before_creating_directories() {
    let temp = root();
    let destination = temp.path().join("not-created");
    for (base, token, model) in [
        ("https://external.example/v1", "local", "model"),
        ("http://user:password@127.0.0.1:8000/v1", "local", "model"),
        ("http://127.0.0.1:8000/v1?secret=value", "local", "model"),
        ("http://127.0.0.1:8000/v1", "\r\nsecret", "model"),
        ("http://127.0.0.1:8000/v1", "local", ""),
    ] {
        assert!(configure(&destination, AgentId::Codex, base, token, model).is_err());
        assert!(!destination.exists());
    }
    assert!(configure(
        Path::new("relative-data"),
        AgentId::Codex,
        "http://127.0.0.1:8000/v1",
        "local",
        "model"
    )
    .is_err());
    assert!(configure(
        &temp.path().join(".."),
        AgentId::Codex,
        "http://127.0.0.1:8000/v1",
        "local",
        "model"
    )
    .is_err());
}

#[test]
fn existing_non_directory_paths_are_rejected() {
    let temp = root();
    std::fs::write(temp.path().join("agents"), "do not replace").unwrap();
    assert!(configure(
        temp.path(),
        AgentId::Codex,
        "http://127.0.0.1:8000/v1",
        "local",
        "model"
    )
    .is_err());
    assert_eq!(
        std::fs::read_to_string(temp.path().join("agents")).unwrap(),
        "do not replace"
    );
}

#[test]
fn launcher_validation_requires_real_private_files_inside_the_root() {
    let temp = root();
    assert!(validate_launch(temp.path(), AgentId::Codex).is_err());
    let configured = configure(
        temp.path(),
        AgentId::Codex,
        "http://127.0.0.1:8000/v1",
        "local-token",
        "model",
    )
    .unwrap();
    let script = validate_launch(temp.path(), AgentId::Codex).unwrap();
    assert_eq!(
        script,
        Path::new(&configured.directory).join(execution_launcher_file_name())
    );
    assert_eq!(
        Path::new(&configured.launcher),
        Path::new(&configured.directory).join(launcher_file_name())
    );
    std::fs::remove_file(Path::new(&configured.directory).join("configuration/environment.json"))
        .unwrap();
    assert!(validate_launch(temp.path(), AgentId::Codex).is_err());
}

#[test]
fn official_configurations_select_the_local_provider_and_model() {
    let temp = root();
    let base = "http://127.0.0.1:18762/agents/demo/v1";
    let model = "quoted-model\"value";
    let claude = configure(temp.path(), AgentId::ClaudeCode, base, "local-token", model).unwrap();
    let settings: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(Path::new(&claude.directory).join("home/.claude/settings.json"))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(settings["env"]["ANTHROPIC_BASE_URL"], base);
    assert_eq!(settings["env"]["ANTHROPIC_MODEL"], model);
    let codex = configure(temp.path(), AgentId::Codex, base, "local-token", model).unwrap();
    let document =
        std::fs::read_to_string(Path::new(&codex.directory).join("home/.codex/config.toml"))
            .unwrap()
            .parse::<toml_edit::DocumentMut>()
            .unwrap();
    assert_eq!(document["model"].as_str(), Some(model));
    assert_eq!(document["model_provider"].as_str(), Some("ae_switch"));
    assert_eq!(
        document["model_providers"]["ae_switch"]["wire_api"].as_str(),
        Some("responses")
    );
    assert_eq!(
        document["model_providers"]["ae_switch"]["env_key"].as_str(),
        Some("AE_SWITCH_API_KEY")
    );
    let opencode = configure(temp.path(), AgentId::OpenCode, base, "local-token", model).unwrap();
    let settings: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(
            Path::new(&opencode.directory).join("configuration/opencode.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(settings["model"], format!("ae_switch/{model}"));
    assert!(settings["provider"]["ae_switch"]["models"]
        .get(model)
        .is_some());
    assert_eq!(
        settings["provider"]["ae_switch"]["options"]["baseURL"],
        base
    );
    let workbuddy = configure(temp.path(), AgentId::WorkBuddy, base, "local-token", model).unwrap();
    let directory = Path::new(&workbuddy.directory);
    let models: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(directory.join("home/.workbuddy/models.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(models.as_array().unwrap().len(), 1);
    assert_eq!(models[0]["id"], model);
    assert_eq!(models[0]["url"], base);
    assert_eq!(models[0]["apiKey"], "local-token");
    assert_eq!(models[0]["supportsToolCall"], true);
    assert_eq!(models[0]["useCustomProtocol"], false);
    let environment: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(directory.join("configuration/environment.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(environment["ELECTRON_RUN_AS_NODE"], "1");
    assert_eq!(environment["CODEBUDDY_HOST"], "workbuddy-desktop");
    assert_eq!(environment["CODEBUDDY_FORCE_LITE_WB_BUNDLE"], "1");
    assert_eq!(environment["AE_WORKBUDDY_MODEL"], model);
    assert_eq!(
        environment["WORKBUDDY_CONFIG_DIR"],
        environment["CODEBUDDY_CONFIG_DIR"]
    );
    assert!(
        Path::new(environment["WORKBUDDY_CONFIG_DIR"].as_str().unwrap()).starts_with(directory)
    );
}

#[cfg(unix)]
#[test]
fn symbolic_link_ancestors_cannot_escape_the_portable_root() {
    let temp = root();
    let external = root();
    std::os::unix::fs::symlink(external.path(), temp.path().join("agents")).unwrap();
    assert!(configure(
        temp.path(),
        AgentId::Codex,
        "http://127.0.0.1:8000/v1",
        "local",
        "model"
    )
    .is_err());
    assert_eq!(std::fs::read_dir(external.path()).unwrap().count(), 0);
}

#[cfg(windows)]
#[test]
fn replacing_a_configured_agent_with_a_junction_blocks_launch() {
    let temp = root();
    let configured = configure(
        temp.path(),
        AgentId::Codex,
        "http://127.0.0.1:8000/v1",
        "local-token",
        "model",
    )
    .unwrap();
    let original = Path::new(&configured.directory);
    let replaced = temp.path().join("replaced");
    std::fs::rename(original, &replaced).unwrap();
    let output = std::process::Command::new("cmd.exe")
        .args(["/D", "/C", "mklink", "/J"])
        .arg(original)
        .arg(&replaced)
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(validate_launch(temp.path(), AgentId::Codex).is_err());
}

#[cfg(windows)]
#[test]
fn junction_ancestors_cannot_escape_the_portable_root() {
    let temp = root();
    let external = root();
    let status = std::process::Command::new("cmd.exe")
        .args(["/D", "/C", "mklink", "/J"])
        .arg(temp.path().join("agents"))
        .arg(external.path())
        .output()
        .unwrap();
    assert!(
        status.status.success(),
        "junction creation failed in workspace TEMP"
    );
    assert!(configure(
        temp.path(),
        AgentId::Codex,
        "http://127.0.0.1:8000/v1",
        "local",
        "model"
    )
    .is_err());
    assert_eq!(std::fs::read_dir(external.path()).unwrap().count(), 0);
}

#[cfg(windows)]
#[test]
fn powershell_launcher_rejects_tools_from_outside_the_portable_root() {
    let temp = root();
    let outside = root();
    let configured = configure(
        temp.path(),
        AgentId::Codex,
        "http://127.0.0.1:18762/agents/demo/v1",
        "local-token",
        "model",
    )
    .unwrap();
    let environment_path = Path::new(&configured.directory).join("configuration/environment.json");
    let mut environment: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&environment_path).unwrap()).unwrap();
    for variable in ["AE_AGENT_BIN_PATH", "AE_SWITCH_PORTABLE_ROOT"] {
        environment.as_object_mut().unwrap().remove(variable);
    }
    std::fs::write(
        &environment_path,
        serde_json::to_string_pretty(&environment).unwrap(),
    )
    .unwrap();
    let marker = outside.path().join("should-not-execute.txt");
    std::fs::write(
        outside.path().join("codex.ps1"),
        "Set-Content -LiteralPath $env:AE_REJECTED_TOOL_MARKER -Value 'executed'; exit 0",
    )
    .unwrap();
    let output = std::process::Command::new("pwsh.exe")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(Path::new(&configured.directory).join("launch.ps1"))
        .env(
            "PATH",
            format!(
                "{};{}",
                outside.path().display(),
                std::env::var("PATH").unwrap_or_default()
            ),
        )
        .env("AE_REJECTED_TOOL_MARKER", &marker)
        .env_remove("AE_SWITCH_PORTABLE_ROOT")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(127));
    assert!(!marker.exists(), "an external PATH tool must never execute");
}

#[cfg(windows)]
#[test]
fn powershell_launcher_preserves_arguments_and_uses_portable_environment() {
    let temp = root();
    let configured = configure(
        temp.path(),
        AgentId::Codex,
        "http://127.0.0.1:18762/agents/demo/v1",
        "launcher-secret",
        "model",
    )
    .unwrap();
    let environment_path = Path::new(&configured.directory).join("configuration/environment.json");
    let mut environment: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&environment_path).unwrap()).unwrap();
    environment
        .as_object_mut()
        .unwrap()
        .remove("AE_AGENT_BIN_PATH");
    std::fs::write(
        &environment_path,
        serde_json::to_string_pretty(&environment).unwrap(),
    )
    .unwrap();
    let tools = temp.path().join("stub-tools");
    std::fs::create_dir(&tools).unwrap();
    let captured = temp.path().join("captured.json");
    let stub = "$capture = @{ arguments = @($args); home = $env:HOME; userprofile = $env:USERPROFILE; temp = $env:TEMP; token = $env:AE_GATEWAY_TOKEN; cwd = (Get-Location).Path; leaked = @{} }; foreach ($name in @('ZCODE_STORAGE_DIR','ZCODE_SESSION_DB_PATH','ZCODE_SESSION_DB','CODEBUDDY_CODE_SUBAGENT_MODEL','OPENCODE_CONFIG_CONTENT','CLAUDE_CODE_SUBAGENT_MODEL','ANTHROPIC_SMALL_FAST_MODEL','ANTHROPIC_CUSTOM_HEADERS','CLAUDE_CODE_USE_ANTHROPIC_AWS','CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD','CLAUDE_CODE_USE_MANTLE','CLAUDE_CODE_USE_GATEWAY','ANTHROPIC_UNIX_SOCKET')) { $capture.leaked[$name] = Test-Path -LiteralPath ('Env:' + $name) }; $capture | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $env:AE_ARGUMENT_CAPTURE -Encoding utf8; exit 17";
    std::fs::write(tools.join("codex.ps1"), stub).unwrap();
    let mut command = std::process::Command::new("pwsh.exe");
    command
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(Path::new(&configured.directory).join("launch.ps1"));
    let arguments = [
        "exec",
        "contains spaces",
        "embedded\"quote",
        "literal$()",
        "semi;colon",
        "--json",
    ];
    command
        .args(arguments)
        .env(
            "PATH",
            format!(
                "{};{}",
                tools.display(),
                std::env::var("PATH").unwrap_or_default()
            ),
        )
        .env("AE_ARGUMENT_CAPTURE", &captured)
        .envs([
            ("ZCODE_STORAGE_DIR", "outside-storage"),
            ("ZCODE_SESSION_DB_PATH", "outside-db-path"),
            ("ZCODE_SESSION_DB", "outside-db"),
            ("CODEBUDDY_CODE_SUBAGENT_MODEL", "foreign-subagent"),
            ("OPENCODE_CONFIG_CONTENT", "{\"model\":\"foreign/model\"}"),
            ("CLAUDE_CODE_SUBAGENT_MODEL", "foreign-subagent"),
            ("ANTHROPIC_SMALL_FAST_MODEL", "foreign-small"),
            ("ANTHROPIC_CUSTOM_HEADERS", "Authorization: Bearer foreign"),
            ("CLAUDE_CODE_USE_ANTHROPIC_AWS", "1"),
            ("CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD", "1"),
            ("CLAUDE_CODE_USE_MANTLE", "1"),
            ("CLAUDE_CODE_USE_GATEWAY", "1"),
            ("ANTHROPIC_UNIX_SOCKET", "/foreign/socket"),
        ]);
    let output = command.output().unwrap();
    assert_eq!(
        output.status.code(),
        Some(17),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let captured: serde_json::Value = serde_json::from_str(
        std::fs::read_to_string(captured)
            .unwrap()
            .trim_start_matches('\u{feff}'),
    )
    .unwrap();
    assert_eq!(captured["arguments"], serde_json::json!(arguments));
    assert_eq!(captured["token"], "launcher-secret");
    for name in [
        "ZCODE_STORAGE_DIR",
        "ZCODE_SESSION_DB_PATH",
        "ZCODE_SESSION_DB",
        "CODEBUDDY_CODE_SUBAGENT_MODEL",
        "OPENCODE_CONFIG_CONTENT",
        "CLAUDE_CODE_SUBAGENT_MODEL",
        "ANTHROPIC_SMALL_FAST_MODEL",
        "ANTHROPIC_CUSTOM_HEADERS",
        "CLAUDE_CODE_USE_ANTHROPIC_AWS",
        "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
        "CLAUDE_CODE_USE_MANTLE",
        "CLAUDE_CODE_USE_GATEWAY",
        "ANTHROPIC_UNIX_SOCKET",
    ] {
        assert_eq!(captured["leaked"][name], false, "{name} must be removed");
    }
    for field in ["home", "userprofile", "temp", "cwd"] {
        assert!(Path::new(captured[field].as_str().unwrap()).starts_with(temp.path()));
    }
}

#[cfg(windows)]
#[test]
fn moving_the_agent_directory_rebases_all_private_paths_at_launch() {
    let temp = root();
    let configured = configure(
        temp.path(),
        AgentId::Codex,
        "http://127.0.0.1:18762/agents/demo/v1",
        "move-secret",
        "model",
    )
    .unwrap();
    let original = Path::new(&configured.directory);
    let environment_path = original.join("configuration/environment.json");
    let mut environment: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&environment_path).unwrap()).unwrap();
    let first_bin = original.join("bin-one");
    let second_bin = original.join("bin two");
    std::fs::create_dir(&first_bin).unwrap();
    std::fs::create_dir(&second_bin).unwrap();
    environment["AE_AGENT_BIN_PATH"] =
        serde_json::json!(format!("{};{}", first_bin.display(), second_bin.display()));
    std::fs::write(first_bin.join("codex.ps1"), "@{ home = $env:HOME; config = $env:CODEX_HOME; temp = $env:TEMP; agent = $env:AE_AGENT_ROOT; bins = $env:AE_AGENT_BIN_PATH } | ConvertTo-Json | Set-Content -LiteralPath $env:AE_ARGUMENT_CAPTURE -Encoding utf8; exit 0").unwrap();
    std::fs::write(
        &environment_path,
        serde_json::to_string_pretty(&environment).unwrap(),
    )
    .unwrap();
    let moved = temp.path().join("moved agent with spaces");
    std::fs::rename(original, &moved).unwrap();
    let captured = temp.path().join("moved-capture.json");
    let output = std::process::Command::new("pwsh.exe")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(moved.join("launch.ps1"))
        .env("AE_ARGUMENT_CAPTURE", &captured)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let captured: serde_json::Value = serde_json::from_str(
        std::fs::read_to_string(captured)
            .unwrap()
            .trim_start_matches('\u{feff}'),
    )
    .unwrap();
    for field in ["home", "config", "temp", "agent"] {
        assert!(
            Path::new(captured[field].as_str().unwrap()).starts_with(&moved),
            "{field} retained the old location"
        );
    }
    let bins = captured["bins"]
        .as_str()
        .unwrap()
        .split(';')
        .collect::<Vec<_>>();
    assert_eq!(bins.len(), 2);
    assert!(bins.iter().all(|bin| Path::new(bin).starts_with(&moved)));
}

#[cfg(windows)]
#[test]
fn workbuddy_launcher_preserves_utf8_native_output_and_restores_host_encodings() {
    let temp = root();
    let configured = configure(
        temp.path(),
        AgentId::WorkBuddy,
        "http://127.0.0.1:18762/agents/demo/v1",
        "encoding-fixture-secret",
        "encoding-fixture-model",
    )
    .unwrap();
    let directory = Path::new(&configured.directory);
    let runtime = directory.join("runtime/node.exe");
    let entry = directory.join("runtime/emit-json.mjs");
    std::fs::create_dir(runtime.parent().unwrap()).unwrap();
    // A plain Node fixture proves the generated launcher's byte encoding only.
    // The official WorkBuddy event stream requires a separate raw-byte retest.
    let node = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join(".tools/node/node.exe");
    std::fs::copy(node, &runtime).unwrap();
    std::fs::write(
        &entry,
        r#"process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'fixture-write',name:'Write',input:{file_path:process.env.AE_ENCODING_PATH}}]},arguments:process.argv.slice(2)})+'\n');
process.exit(Number(process.env.AE_ENCODING_EXIT_CODE));
"#,
    )
    .unwrap();
    let environment_path = directory.join("configuration/environment.json");
    let mut environment: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&environment_path).unwrap()).unwrap();
    environment["AE_WORKBUDDY_RUNTIME"] = serde_json::json!(runtime);
    environment["AE_WORKBUDDY_ENTRY"] = serde_json::json!(entry);
    std::fs::write(
        environment_path,
        serde_json::to_string_pretty(&environment).unwrap(),
    )
    .unwrap();
    let probe = temp.path().join("host-encoding-probe.ps1");
    std::fs::write(
        &probe,
        r#"$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(936)
$OutputEncoding = [Text.Encoding]::ASCII
$originalConsoleEncoding = [Console]::OutputEncoding
$originalPipelineEncoding = $OutputEncoding
& $env:AE_ENCODING_LAUNCHER '--probe'
$nativeExitCode = $LASTEXITCODE
@{
    consoleRestored = [Console]::OutputEncoding.Equals($originalConsoleEncoding)
    pipelineRestored = $OutputEncoding.Equals($originalPipelineEncoding)
    consoleCodePage = [Console]::OutputEncoding.CodePage
    pipelineCodePage = $OutputEncoding.CodePage
    nativeExitCode = $nativeExitCode
} | ConvertTo-Json | Set-Content -LiteralPath $env:AE_ENCODING_AUDIT -Encoding UTF8
exit $nativeExitCode
"#,
    )
    .unwrap();
    let audit = temp.path().join("host-encoding-audit.json");
    let chinese_path = directory.join("workspace/开源项目开发/中文文件.txt");
    let powershell = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    for exit_code in [0, 17] {
        let output = std::process::Command::new(&powershell)
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(&probe)
            .env("AE_ENCODING_LAUNCHER", directory.join("launch.ps1"))
            .env("AE_ENCODING_AUDIT", &audit)
            .env("AE_ENCODING_PATH", &chinese_path)
            .env("AE_ENCODING_EXIT_CODE", exit_code.to_string())
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(exit_code),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(output.stderr.is_empty());
        let event: serde_json::Value = serde_json::from_slice(&output.stdout)
            .expect("Windows PowerShell must retain strictly valid UTF-8 JSON bytes");
        assert_eq!(
            event["message"]["content"][0]["input"]["file_path"].as_str(),
            chinese_path.to_str()
        );
        assert_eq!(
            event["arguments"],
            serde_json::json!(["--model", "encoding-fixture-model", "--probe"])
        );
        let audit: serde_json::Value = serde_json::from_str(
            std::fs::read_to_string(&audit)
                .unwrap()
                .trim_start_matches('\u{feff}'),
        )
        .unwrap();
        assert_eq!(audit["consoleRestored"], true);
        assert_eq!(audit["pipelineRestored"], true);
        assert_eq!(audit["consoleCodePage"], 936);
        assert_eq!(audit["pipelineCodePage"], 20127);
        assert_eq!(audit["nativeExitCode"], exit_code);
    }
}

#[cfg(windows)]
#[test]
fn workbuddy_launcher_prefers_bundled_git_and_rebases_it_after_portable_move() {
    const FIXTURE_ROOT: &str = "AE_WORKBUDDY_GIT_FIXTURE_ROOT";
    const TEST_NAME: &str = "agent_configs::tests::workbuddy_launcher_prefers_bundled_git_and_rebases_it_after_portable_move";
    if let Some(portable_root) = std::env::var_os(FIXTURE_ROOT).map(PathBuf::from) {
        let configured = configure(
            &portable_root.join("data"),
            AgentId::WorkBuddy,
            "http://127.0.0.1:18762/agents/demo/v1",
            "workbuddy-bash-regression-secret",
            "workbuddy-bash-regression-model",
        )
        .unwrap();
        assert!(!serde_json::to_string(&configured)
            .unwrap()
            .contains("workbuddy-bash-regression-secret"));
        validate_launch(&portable_root.join("data"), AgentId::WorkBuddy).unwrap();
        return;
    }
    let temp = root();
    let prepare = |portable_root: &Path, with_git: bool| {
        let runtime = portable_root.join("tools/agents/workbuddy");
        let entry = runtime.join("resources/app.asar.unpacked/cli/bin/codebuddy");
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::fs::write(runtime.join("WorkBuddy.exe"), "fixture, never executed").unwrap();
        std::fs::write(entry, "fixture, never executed").unwrap();
        if with_git {
            for relative in ["tools/git/bin/bash.exe", "tools/git/cmd/git.exe"] {
                let file = portable_root.join(relative);
                std::fs::create_dir_all(file.parent().unwrap()).unwrap();
                std::fs::write(file, "fixture, never executed").unwrap();
            }
        }
        // Isolate process environment so this fixture cannot affect parallel
        // configuration tests or borrow the developer's installed Git.
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST_NAME, "--nocapture"])
            .env(FIXTURE_ROOT, portable_root)
            .env("AE_SWITCH_PORTABLE_ROOT", portable_root)
            .env("AE_SWITCH_TOOLS_DIR", portable_root.join("tools/agents"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        let directory = portable_root.join("data/agents/workbuddy");
        let environment: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(directory.join("configuration/environment.json")).unwrap(),
        )
        .unwrap();
        (directory, environment)
    };
    let original_root = temp.path().join("portable git before move");
    let (directory, environment) = prepare(&original_root, true);
    let original_bash = original_root.join("tools/git/bin/bash.exe");
    assert_eq!(
        environment["CODEBUDDY_CODE_GIT_BASH_PATH"].as_str(),
        original_bash.to_str(),
        "WorkBuddy's canonical Bash variable must select the existing bundled Git"
    );
    assert_eq!(
        environment["CODEBUDDY_CODE_GIT_BASH_PATH"],
        environment["CLAUDE_CODE_GIT_BASH_PATH"]
    );
    let launcher = std::fs::read_to_string(directory.join("launch.ps1")).unwrap();
    assert!(!launcher.contains("Program Files\\Git"));
    let invocation = "    & $env:AE_WORKBUDDY_RUNTIME @runtimeArguments | Out-Host";
    assert_eq!(launcher.matches(invocation).count(), 1);
    // Exercise the generated Windows PowerShell environment/rebasing code,
    // replacing only the final invocation; no fixture executable is run.
    let probe = launcher.replacen(
        invocation,
        "    @{ bash = $env:CODEBUDDY_CODE_GIT_BASH_PATH; claudeBash = $env:CLAUDE_CODE_GIT_BASH_PATH; git = (Get-Command git.exe -CommandType Application -All | Select-Object -First 1).Source; bashFromPath = (Get-Command bash.exe -CommandType Application -All | Select-Object -First 1).Source; portableRoot = $env:AE_SWITCH_PORTABLE_ROOT } | ConvertTo-Json | Set-Content -LiteralPath $env:AE_WORKBUDDY_GIT_CAPTURE -Encoding utf8\n    exit 0",
        1,
    );
    std::fs::write(directory.join("git-environment-probe.ps1"), probe).unwrap();
    let verify_launcher = |portable_root: &Path| {
        let captured = temp.path().join("git-capture.json");
        let output = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(portable_root.join("data/agents/workbuddy/git-environment-probe.ps1"))
            .env("AE_WORKBUDDY_GIT_CAPTURE", &captured)
            .env(
                "CODEBUDDY_CODE_GIT_BASH_PATH",
                "C:\\Program Files\\Git\\bin\\bash.exe",
            )
            .env(
                "CLAUDE_CODE_GIT_BASH_PATH",
                "C:\\Program Files\\Git\\bin\\bash.exe",
            )
            .env(
                "PATH",
                format!(
                    "C:\\Program Files\\Git\\cmd;C:\\Program Files\\Git\\bin;{}",
                    std::env::var("PATH").unwrap_or_default()
                ),
            )
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let captured: serde_json::Value = serde_json::from_str(
            std::fs::read_to_string(captured)
                .unwrap()
                .trim_start_matches('\u{feff}'),
        )
        .unwrap();
        let bash = portable_root.join("tools/git/bin/bash.exe");
        for field in ["bash", "claudeBash", "bashFromPath"] {
            assert_eq!(
                Path::new(captured[field].as_str().unwrap()),
                bash.as_path(),
                "{field}"
            );
        }
        assert_eq!(
            Path::new(captured["git"].as_str().unwrap()),
            portable_root.join("tools/git/cmd/git.exe")
        );
        assert_eq!(captured["portableRoot"].as_str(), portable_root.to_str());
    };
    verify_launcher(&original_root);
    let moved_root = temp.path().join("portable git after move");
    std::fs::rename(&original_root, &moved_root).unwrap();
    verify_launcher(&moved_root);

    let (_, without_git) = prepare(&temp.path().join("portable without bundled git"), false);
    for variable in ["CODEBUDDY_CODE_GIT_BASH_PATH", "CLAUDE_CODE_GIT_BASH_PATH"] {
        assert!(
            without_git.get(variable).is_none(),
            "A missing optional bundled Git must not create a fictional {variable} path"
        );
    }
}

#[test]
fn platform_entries_keep_native_workbuddy_layouts_separate() {
    use launchers::BundlePlatform;
    let directory = Path::new("portable/tools/agents/workbuddy");
    let windows = launchers::workbuddy_entries(directory, BundlePlatform::Windows);
    assert_eq!(windows.len(), 1);
    assert_eq!(windows[0].0, directory.join("WorkBuddy.exe"));
    assert_eq!(
        windows[0].1,
        directory.join("resources/app.asar.unpacked/cli/bin/codebuddy")
    );
    let macos = launchers::workbuddy_entries(directory, BundlePlatform::Macos);
    assert_eq!(
        macos[0].0,
        directory.join("WorkBuddy.app/Contents/MacOS/WorkBuddy")
    );
    assert_eq!(
        macos[0].1,
        directory.join("WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy")
    );
    for (runtime, entry) in launchers::workbuddy_entries(directory, BundlePlatform::Linux) {
        assert!(runtime.starts_with(directory));
        assert_ne!(runtime.extension(), Some(std::ffi::OsStr::new("exe")));
        assert_eq!(
            entry,
            directory.join("resources/app.asar.unpacked/cli/bin/codebuddy")
        );
    }
}

#[test]
fn platform_bins_preserve_windows_paths_and_support_unix_runtimes() {
    use launchers::BundlePlatform;
    assert_eq!(
        launchers::runtime_bins(BundlePlatform::Windows),
        [
            "tools/node",
            ".tools/node",
            "tools/git/cmd",
            "tools/git/bin",
            ".tools/git/cmd",
            ".tools/git/bin",
            "tools/python",
            ".tools/python",
        ]
    );
    assert_eq!(
        launchers::hermes_bin(BundlePlatform::Windows, false),
        "hermes/.venv/Scripts"
    );
    for platform in [BundlePlatform::Macos, BundlePlatform::Linux] {
        let bins = launchers::runtime_bins(platform);
        assert!(bins.contains(&"tools/node/bin"));
        assert!(bins.contains(&"tools/python/bin"));
        assert!(bins.contains(&"tools/git/bin"));
        assert!(!bins.iter().any(|path| path.ends_with("/cmd")));
        assert_eq!(
            launchers::hermes_bin(platform, false),
            "hermes",
            "Missing portable wrappers must not fall back to absolute venv shebangs"
        );
        assert_eq!(launchers::hermes_bin(platform, true), "hermes");
        assert!(!launchers::bundled_bash(platform)
            .iter()
            .any(|path| path.ends_with(".exe")));
    }
}

#[cfg(unix)]
#[test]
fn unix_configuration_creates_only_an_owner_executable_posix_launcher() {
    use std::os::unix::fs::PermissionsExt;
    let temp = root();
    let configured = configure(
        temp.path(),
        AgentId::Codex,
        "http://127.0.0.1:8000/v1",
        "private-launcher-token",
        "model",
    )
    .unwrap();
    let directory = Path::new(&configured.directory);
    let launcher = directory.join("launch.sh");
    assert_eq!(Path::new(&configured.launcher), launcher);
    assert_eq!(
        validate_launch(temp.path(), AgentId::Codex).unwrap(),
        launcher
    );
    assert!(!directory.join("launch.ps1").exists());
    assert!(!directory.join("launch.cmd").exists());
    assert_eq!(
        std::fs::metadata(&launcher).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        std::fs::metadata(directory.join("configuration/environment.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    for mode in [0o600, 0o740, 0o755] {
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(mode)).unwrap();
        assert!(validate_launch(temp.path(), AgentId::Codex).is_err());
    }
}

#[cfg(unix)]
#[test]
fn unix_launcher_validation_rejects_a_replaced_external_script() {
    let temp = root();
    let external = root();
    let configured = configure(
        temp.path(),
        AgentId::Codex,
        "http://127.0.0.1:8000/v1",
        "local-token",
        "model",
    )
    .unwrap();
    let launcher = Path::new(&configured.launcher);
    let outside_script = external.path().join("outside.sh");
    std::fs::write(&outside_script, "do not execute").unwrap();
    std::fs::remove_file(launcher).unwrap();
    std::os::unix::fs::symlink(&outside_script, launcher).unwrap();
    assert!(validate_launch(temp.path(), AgentId::Codex).is_err());
    assert_eq!(
        std::fs::read_to_string(outside_script).unwrap(),
        "do not execute"
    );
}

fn posix_test_path(path: &Path) -> String {
    #[cfg(windows)]
    {
        let path = path.to_str().unwrap().replace('\\', "/");
        assert_eq!(&path[1..3], ":/");
        format!("/{}/{}", path[..1].to_ascii_lowercase(), &path[3..])
    }
    #[cfg(unix)]
    path.to_str().unwrap().to_owned()
}

fn write_posix_fixture(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
}

fn execute_posix_fixture(launcher: &Path, arguments: &[&str]) -> std::process::Output {
    #[cfg(windows)]
    let shell = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.tools/git/bin/bash.exe");
    #[cfg(unix)]
    let shell = PathBuf::from("/bin/sh");
    let mut command = std::process::Command::new(shell);
    #[cfg(windows)]
    command.args(["--noprofile", "--norc"]);
    command.arg(posix_test_path(launcher)).args(arguments);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command.output().unwrap()
}

#[test]
fn posix_launcher_preserves_literal_arguments_and_rebases_after_a_package_move() {
    let temp = root();
    let original = temp.path().join("便携 包 before move");
    let launcher_relative = "data/agents/codex/launch.sh";
    write_posix_fixture(
        &original.join(launcher_relative),
        &launchers::posix_launcher(AgentId::Codex, "../../.."),
    );
    write_posix_fixture(
        &original.join("AE-Switch-core"),
        "#!/bin/sh\nprintf '%s\\0' \"$AE_SWITCH_PORTABLE_ROOT\" \"$@\"\nexit 23\n",
    );
    let arguments = ["--message", "literal '\" $() ; 中文", "two words", ""];
    let verify = |package: &Path| {
        let output = execute_posix_fixture(&package.join(launcher_relative), &arguments);
        assert_eq!(
            output.status.code(),
            Some(23),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let actual = std::str::from_utf8(&output.stdout)
            .unwrap()
            .split_terminator('\0')
            .collect::<Vec<_>>();
        let package_path = posix_test_path(package);
        assert_eq!(
            actual,
            [
                package_path.as_str(),
                "run-agent",
                "codex",
                arguments[0],
                arguments[1],
                arguments[2],
                arguments[3]
            ]
        );
    };
    verify(&original);
    let moved = temp.path().join("便携 包 after move");
    std::fs::rename(&original, &moved).unwrap();
    verify(&moved);
}

#[test]
fn posix_launcher_finds_a_core_inside_a_renamed_macos_application_bundle() {
    let temp = root();
    let package = temp.path().join("portable application");
    let launcher = package.join("data/agents/hermes/launch.sh");
    write_posix_fixture(
        &launcher,
        &launchers::posix_launcher(AgentId::Hermes, "../../.."),
    );
    write_posix_fixture(
        &package.join("Renamed app.app/Contents/MacOS/ae-switch-cli"),
        "#!/bin/sh\nprintf '%s\\0' \"$@\"\n",
    );
    let output = execute_posix_fixture(&launcher, &["--version"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"run-agent\0hermes\0--version\0");
}

#[test]
fn posix_launcher_reports_a_missing_portable_core_without_using_host_path() {
    let temp = root();
    let launcher = temp.path().join("portable/data/agents/opencode/launch.sh");
    write_posix_fixture(
        &launcher,
        &launchers::posix_launcher(AgentId::OpenCode, "../../.."),
    );
    let output = execute_posix_fixture(&launcher, &["--version"]);
    assert_eq!(output.status.code(), Some(127));
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("portable AE Switch core is missing"));
}

#[cfg(unix)]
#[test]
fn posix_launcher_does_not_execute_an_external_core_symlink() {
    let temp = root();
    let external = root();
    let package = temp.path().join("portable");
    let launcher = package.join("data/agents/codex/launch.sh");
    write_posix_fixture(
        &launcher,
        &launchers::posix_launcher(AgentId::Codex, "../../.."),
    );
    let core = external.path().join("outside-core");
    write_posix_fixture(&core, "#!/bin/sh\nprintf 'EXTERNAL CORE WAS EXECUTED'\n");
    std::os::unix::fs::symlink(core, package.join("AE-Switch-core")).unwrap();
    let output = execute_posix_fixture(&launcher, &[]);
    assert_eq!(output.status.code(), Some(127));
    assert!(output.stdout.is_empty());
}
