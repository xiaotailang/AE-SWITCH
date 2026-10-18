# Agent 兼容配置与真实验收

核对日期：2026-10-10。正式发行只包含 AE Switch，八客户端由用户自行安装并使用原有 profile。本机测试安装、配置、缓存和验收输出限定在 G 盘工作区，没有全局安装或修改用户 C 盘配置。以下兼容配置依据官方文档或工作区中的官方源码，**配置文件可解析不代表端到端成功**。八工具当前验证结果以[当前验证记录](current-validation.md)及其绑定的源码、可执行文件、UUID 和收据为准；Native31、Native32 等旧轮次只覆盖各自的历史范围。

本地回归、构建、跨平台检查、版本 / 迁移检查、原生 UI 和真实端点接入分别读取[当前验证记录](current-validation.md)引用的独立收据，不把旧测试数量或构建哈希代入新修订。macOS/Linux 的原生发行包、界面和八工具运行尚未验收，范围见[平台支持](platform-support.md)。

## 官方来源与本地工具

下表的本地入口属于开发用临时测试安装，清理后可能不存在，不是正式发行内容或用户必须采用的安装目录。产品发现用户已经安装的入口和原 profile；测试 Node、Python、Git、PowerShell 也不会随 AE 包发行。

| 工具             | 官方来源                                                                                                                                                                                                                           | 本地入口                                                                                    | 核对版本                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Claude Code      | [官方仓库](https://github.com/anthropics/claude-code)、[环境变量](https://code.claude.com/docs/en/env-vars)、[非交互运行](https://code.claude.com/docs/en/headless)                                                                | `.tools/agents/claude/node_modules/.bin/claude.cmd`                                         | 2.1.293                                             |
| Codex            | [配置参考](https://developers.openai.com/codex/config-reference)、[非交互运行](https://developers.openai.com/codex/noninteractive)                                                                                                 | `.tools/agents/codex/node_modules/.bin/codex.cmd`                                           | 0.161.0                                             |
| Hermes Agent     | [官方仓库](https://github.com/NousResearch/hermes-agent)、[自定义端点](https://hermes-agent.nousresearch.com/docs/integrations/providers)、[配置](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)             | `.tools/agents/hermes/.venv/Scripts/hermes.exe`                                             | 官方 main 源码；本地 Python 3.14.6                  |
| oh-my-pi         | [官方仓库](https://github.com/can1357/oh-my-pi)、[Provider 文档](https://github.com/can1357/oh-my-pi/blob/main/docs/providers.md)                                                                                                  | `.tools/agents/oh_my_pi/omp.exe`                                                            | 18.8.3                                              |
| OpenCode         | [官方仓库](https://github.com/anomalyco/opencode)、[Provider 文档](https://opencode.ai/docs/providers/)、[配置](https://opencode.ai/docs/config/)                                                                                  | `.tools/agents/opencode/node_modules/.bin/opencode.cmd`                                     | 1.18.35                                             |
| ZCode            | [智谱官方仓库](https://github.com/zai-org/ZCode)、[CLI 源码](https://github.com/zai-org/ZCode/tree/main/apps/zcode-cli)                                                                                                            | `.tools/agents/zcode/zcode.cmd`，由当前目录源码构建产物启动                                 | CLI 0.16.9（桌面仓库 3.14.3）                       |
| WorkBuddy        | [官方模型配置](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model)、[Windows 安装说明](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Installation-Win-Guide) | 官方发行包 `.tools/workbuddy/WorkBuddy.exe` 的内置 headless host 与本地 Web 界面            | 5.7.6（40409493）                                   |
| DeepSeek Harness | [官方产品](https://www.deepseek.com/harness/)、[官方仓库](https://github.com/deepseek-ai/deepseek-harness)、[官方 npm](https://www.npmjs.com/package/@deepseek-ai/dsh)                                                             | `.tools/agents/deepseek_harness/node_modules/@deepseek-ai/dsh/lib/bin.js`，由包内 Node 启动 | 0.2.0-rc.2；Windows shell 配套官方 PowerShell 7.6.6 |

`zcode` 已确认指智谱的 ZCode；官方仓库包括桌面、Web、TUI 和可单次执行的 CLI。本机 `G:\soft_install\Z Code` 仅用于只读确认产品身份，现有安装没有被修改。

### WorkBuddy 官方发行包运行方式

Windows 官方安装器只作静态解包，没有运行安装程序。验证使用发行包内 `resources/app.asar.unpacked/cli/bin/codebuddy`，由同包的 `WorkBuddy.exe` 以 `ELECTRON_RUN_AS_NODE=1` 执行，设置 `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1` 与 `CODEBUDDY_HOST=workbuddy-desktop`。这会载入 WorkBuddy 专属 bundle；它并非另行安装的 CodeBuddy CLI。

测试中的 `WORKBUDDY_CONFIG_DIR` 和 `CODEBUDDY_CONFIG_DIR` 指向 G 盘 UUID 内的既有 profile fixture；正式接入使用所选原 profile。`models.json` 使用官方模型数组格式，每项包含 `id`、`name`、`url`、`apiKey`、`supportsToolCall`、`supportsImages`、`supportsReasoning` 和 `useCustomProtocol`。本地 schema 探针已观察到官方 host 使用该文件的 URL、模型 ID 与 Bearer Key；探针返回的故意错误只证明配置消费，不能证明真实推理成功。

实际工具验收使用官方 host 的非交互模式及显式 `--model`，限定 Read/Write 工具并核对写入、读回、回复。旧私有 profile 启动器的本地 Web 界面属于历史范围。官方桌面 GUI 默认模型选择尚未适配、未验收，`desktopGuiVerified:false`；没有运行安装器或桌面 GUI 注册流程，CLI / 本地页面的证据不证明原厂桌面 GUI 可用。

## 当前目录完整沙盒验收

当前既有客户端验收使用 `scripts/verify-portable-e2e.ps1 -PackageDirectory <G盘工作区内的AE-only包> -NativeUi -QaExecutablePath <本轮QA程序>`。脚本只把 AE 发行目录复制到新 UUID，复用 G 盘临时安装的官方客户端作为只读测试运行时，在同 UUID 的发行目录外建立既有 profile fixture；读取 `端点测试用.txt`，由 Rust 实际发现模型，再通过原生 UI 配置、首次工具验证和独立复验。发现失败时不使用猜测模型继续声称成功。QA 程序及测试客户端不属于正式发行内容。

脚本在 `finally` 校验 ownership marker、精确进程身份与目录边界后清理本轮 UUID；临时客户端安装另有独立所有权与清理收据。原包装流程失败和后续清理事实分别保留，不把后续清理升级为原轮成功。原始报告位于 `artifacts/acceptance/native-e2e-wrapper.json`、`native-ui-retest/native-ui-results.json` 与 `native-tray.json`，各轮归档以统一状态为准。无 `-NativeUi` 的旧 bundled 模式不代表正式发行或本轮验收。

工具验证要求退出成功、真实 assistant 回复、关联写入和读取事件、读取结果中的随机标记、磁盘文件内容精确一致及验证文件清理成功。Codex 使用当前目录专属工作区，未运行会创建系统账户的 Windows sandbox setup；报告明确注明未启用 OS sandbox。

## 配置要求

占位符 `PROXY_ROOT` 表示本地 Rust 网关根地址，`MODEL` 表示自动探测或用户选择的模型。`AE_SWITCH_API_KEY` 应为本地网关令牌，真实上游密钥留在网关的当前目录存储中。

一键接入仅合并所选供应商、默认模型及网关所需的端点、认证和协议字段，保留已有历史、会话、MCP、插件、权限、上下文和其他未受管设置。以下示例说明接入字段和新配置的默认结构，已有配置不会被示例整份替换。无法安全解析或发现冲突时保留原文件并报错；具体字段、保守 YAML 子集和写入边界见[原生代理配置合并](native-agent-config-merges.md)。

Codex 的普通保存、模型同步和一键接入不自动启用按模型上下文长度。只有实际编辑模型上下文值才启用该模式并移除已有全局 `model_context_window` 覆盖，压缩阈值 `model_auto_compact_token_limit` 独立保留；活动 profile 的上下文冲突会报错，不覆盖其权限或上下文偏好。

### Claude Code

启动进程设置 `CLAUDE_CONFIG_DIR` 为隔离目录，`settings.json` 的 `env` 或启动进程环境设置：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "PROXY_ROOT",
    "ANTHROPIC_API_KEY": "LOCAL_GATEWAY_TOKEN",
    "ANTHROPIC_MODEL": "MODEL",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL": "1"
  }
}
```

`ANTHROPIC_BASE_URL` 不加 `/v1`；SDK 追加 `/v1/messages`。`ANTHROPIC_API_KEY` 发送 `x-api-key`，`ANTHROPIC_AUTH_TOKEN` 则发送 Bearer，两种方式不要混用旧凭据。`CLAUDE_CONFIG_DIR` 必须作为启动进程环境设置，不能依赖项目级 `env` 去重定向它。

真实验收命令：`claude -p "PROMPT" --model MODEL --output-format json --max-turns 1 --tools ""`。更完整的工具调用验收应在单独工作区内允许文件工具，要求工具创建文件后读取校验结果。

### Codex

启动进程设置 `CODEX_HOME` 为隔离目录，并在其 `config.toml` 写入：

```toml
model = "MODEL"
model_provider = "ae_switch"
approval_policy = "never"
sandbox_mode = "read-only"
check_for_update_on_startup = false

[model_providers.ae_switch]
name = "AE Switch"
base_url = "PROXY_ROOT/v1"
env_key = "AE_SWITCH_API_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
```

当前官方参考明确 `wire_api` 唯一支持值是 `responses`。只支持 Chat Completions 的端点需要 Rust 网关进行真实的 Responses 转换，并覆盖工具调用、SSE 流、用量和错误传播。新版 Codex 会忽略项目 `.codex/config.toml` 的 provider 配置，因此必须设置隔离的 `CODEX_HOME`。`env_key` 可避免把上游密钥写入 Codex 文件。

真实验收命令：`codex exec --skip-git-repo-check --ephemeral --json "PROMPT"`。

### Hermes Agent

启动进程设置 `HERMES_HOME` 为隔离目录，`config.yaml`：

```yaml
model:
  default: "MODEL"
  provider: custom
  base_url: "PROXY_ROOT/v1"
  key_env: AE_SWITCH_API_KEY
  api_mode: chat_completions
  context_length: 128000
```

官方源码也支持 `api_mode: codex_responses` 或 `anthropic_messages`。`OPENAI_BASE_URL` 仅用于 `openai-api` provider，不能替代 `custom` provider 的 `model.base_url`。模型名称的旧 `LLM_MODEL` 环境变量已删除。最新官方版本支持原生 Windows；本地使用官方源码和隔离 venv，未运行会改系统 PATH 的安装脚本。

真实验收命令：`hermes chat -q "PROMPT" --oneshot -Q --ignore-rules --max-turns 1 --run-budget 45 --format stream-json`。

### oh-my-pi

启动进程设置 `PI_CODING_AGENT_DIR` 为隔离目录。注意它是 **`models.yml`**，不是其他 pi 工具的 `models.json`。

```yaml
providers:
  ae_switch:
    baseUrl: "PROXY_ROOT/v1"
    api: openai-completions
    apiKey: AE_SWITCH_API_KEY
    models:
      - id: "MODEL"
        name: "MODEL"
        contextWindow: 128000
        maxTokens: 4096
```

同目录 `config.yml`：

```yaml
modelRoles:
  default: "ae_switch/MODEL"
```

可选 `api` 包括 `openai-completions`、`openai-responses`、`anthropic-messages` 等。`apiKey` 支持环境变量名。使用官方独立 Windows 二进制无需安装 Bun。

真实验收命令：`omp -p "PROMPT" --model ae_switch/MODEL --no-tools --no-lsp --no-title --no-session --thinking off --max-time 45`。

### OpenCode

启动进程设置 `OPENCODE_CONFIG` 为隔离配置的绝对路径，并重定向 XDG 数据、配置、状态、缓存目录。

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "ae_switch/MODEL",
  "small_model": "ae_switch/MODEL",
  "share": "disabled",
  "autoupdate": false,
  "provider": {
    "ae_switch": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "AE Switch",
      "options": {
        "baseURL": "PROXY_ROOT/v1",
        "apiKey": "{env:AE_SWITCH_API_KEY}"
      },
      "models": {
        "MODEL": {
          "name": "MODEL",
          "limit": { "context": 128000, "output": 4096 }
        }
      }
    }
  }
}
```

这里 `npm` 选择 OpenAI Chat Completions 适配器；`@ai-sdk/openai` 的新版行为不能直接假定相同。配置加载可能检查插件依赖，缓存必须仍在当前目录。

真实验收命令：`opencode run "PROMPT" --model ae_switch/MODEL --format json --pure`。

### ZCode

官方 [runtime-paths.ts](https://github.com/zai-org/ZCode/blob/main/packages/provider-node/src/runtime-paths.ts) 要求 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 与 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` 同时存在。`ZCODE_DATA_BASE_DIR` 指向隔离根目录，运行数据写入其 `.zcode/` 下。

个人端点应写 **Personal Provider Config**；内置配置的 provider group 不允许 `standard-personal`，不能把个人端点塞入内置模板。个人配置依据官方 [provider-config-file-codec.ts](https://github.com/zai-org/ZCode/blob/main/packages/provider-node/src/provider-config-file-codec.ts)、[rule-data-schema.ts](https://github.com/zai-org/ZCode/blob/main/packages/provider/src/config/rule-data-schema.ts)：

```json
{
  "schemaVersion": 1,
  "config": {
    "providerConfigRules": {
      "providerRules": [
        {
          "providerId": "ae_switch",
          "providerName": "AE Switch",
          "enabled": true,
          "config": {
            "group": "standard-personal",
            "access": { "type": "api-key", "apiKey": "LOCAL_GATEWAY_TOKEN" },
            "api": {
              "type": "openai-chat-completions",
              "baseUrl": "PROXY_ROOT/v1"
            },
            "personalModelIds": ["MODEL"]
          }
        }
      ]
    },
    "modelConfigRules": {
      "providerModelRules": [],
      "manualProviderModelRules": []
    },
    "defaultModelSelection": { "providerId": "ae_switch", "modelId": "MODEL" }
  }
}
```

内置配置应提供合法、版本化的官方配置或覆盖必要模型能力的合法规则。最小内置配置的官方解码器与真实 CLI 历史验证范围见[当前验证记录](current-validation.md)中的对应收据；新配置在缺少推理选项时初始化 `options.reasoningLevel: "disabled"`，已有选项和合法 builtin 保留。验证脚本 `validate-zcode-config.mjs` 直接提取 Rust 的 JSON 声明或接收实际配置路径，使用官方源码的 tsx 入口执行。个人配置没有已核实的环境变量密钥插值；这里只保存网关本地令牌。

真实验收命令：`node zcode.cjs -p "PROMPT" --output-format json`。官方 CLI 目前为 workspace 私有包，需要由官方源码构建，不能把 npm 上其他同名包当作智谱 ZCode。

### DeepSeek Harness

使用 DeepSeek 官方 `@deepseek-ai/dsh@0.2.0-rc.2` npm 发行版和完整安装的 Windows x64 生产依赖，入口为 `lib/bin.js`，许可证为 MIT。官方要求 Node `^22.19.0 || >=24.0.0`；包内 Node 24.13.0 满足要求。Windows PowerShell 使用 Microsoft 官方 7.6.6 ZIP 发行版及完整运行时，保留其 MIT 许可证和第三方说明。

`DSH_HOME` 指向独立 Agent 的 `home/.dsh`。Headless profile 的 `package.json` 使用官方 `dsh.profile.bundles` 数组 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-headless`，配置覆盖写入 `profiles/headless/cordis.patch.yml`。以下是官方版本已核实的 row / config 结构；`PROXY_AGENT_URL` 和 `MODEL` 来自当前 Rust 配置：

```yaml
- id: llm-pi-ai
  config:
    providers:
      ae-switch:
        apiKeyEnv: AE_GATEWAY_TOKEN
        api: openai-completions
        baseURL: PROXY_AGENT_URL
        models:
          - id: MODEL
- id: agent-default-model
  config:
    provider: ae-switch
    model: MODEL
- id: approval
  config:
    policy: ask
```

保留 `sandbox-policy.mode: workspace-write` 和 `fs-sandbox`，Windows shell 使用官方 `pwsh-sandbox` 与 ACL 受限令牌运行器。显式 `pwshPath` 为从固定 Agent workspace 指向包内 `tools/pwsh/pwsh.exe` 的相对路径，包含目录分隔符，避免宿主 PowerShell 搜索和搬移后的旧绝对路径。启动器检查包内文件并固定 cwd，所有 HOME、缓存与临时目录留在便携根目录；`DSH_TELEMETRY_MODE=DISABLED`、`POWERSHELL_TELEMETRY_OPTOUT=1`，官方 session 日志外发与 telemetry rows 禁用。

官方 Windows ACL 授权要求当前用户拥有 workspace / private temp 目录，且目录授予 `WRITE_OWNER`，用于设置 Low mandatory label；当前用户对自有新建目录的 FullControl 满足此前提。应用只初始化自己创建且通过普通路径 / owner 校验的 Agent workspace 与私有临时目录，保留父级和其他用户权限；缺少权限时失败关闭。该前提已在独立 G fixture 实测，初始权限错误和补足后成功分别保留于[当前验证记录](current-validation.md)。

官方 `fs-sandbox` 提供可信路径写入边界，不是 kernel sandbox；读权限、网络和进程可见性不因该边界隔离。Windows shell 的官方 ACL 能力写入范围、受限令牌与 job object 需要实际 shell 证据才能计为已执行，普通 `read` / `write` 验收不能代入。官方审批 `ask` 保留；headless 无可用答复者时敏感请求失败关闭，不改客户端源码或改为全盘写入模式。

版本命令为 `node <entry> --version`；真实 headless 命令为 `node <entry> --profile headless --json "PROMPT"`，launcher flags 在 app flags 之前。官方事件使用 `tool_call.callId/tool/input` 和 `tool_result.callId/status/result`，默认文件工具名是 `write`、`read`、`edit`。验证仅接受同 callId 的 completed 结果、独立读回标记、最终助手标记、精确磁盘内容和 exit 0，并要求 completed 的 `turn_end` 与本次清理；顶层 `truncated:true`、error / aborted 均不能通过。

## 历史六工具端点实测与验收边界

以下 401 与 0/6 是加入 WorkBuddy 前的历史记录。后续直连诊断仍为 403，原代理已不可用。当前验收使用 `scripts/verify-portable-e2e.ps1`，完整工具集合为八种；最终结果以 `artifacts/acceptance/portable-e2e.json` 为准。

`tests/acceptance/probe-endpoint.mjs` 从 `端点测试用.txt` 读取端点与密钥，不输出或记录密钥，实际请求模型目录及三种协议，并记录状态、模型与响应。`tests/acceptance/run-real-agents.mjs` 启动真实官方 CLI，在各自隔离配置下发送验收提示，要求退出码 0 且回复包含指定标记。

本机 Windows 系统 HTTP 代理为 `http://127.0.0.1:7897`。Node 默认直连会收到上游 HTTP 403 `region_restricted`。采用系统代理后，四个实际请求均返回 HTTP 401 `INVALID_API_KEY`：

| 请求                        | 直连         | 系统代理     |
| --------------------------- | ------------ | ------------ |
| `GET /v1/models`            | 403 地区限制 | 401 密钥无效 |
| `POST /v1/chat/completions` | 403 地区限制 | 401 密钥无效 |
| `POST /v1/responses`        | 403 地区限制 | 401 密钥无效 |
| `POST /v1/messages`         | 403 地区限制 | 401 密钥无效 |

该历史轮次的证据在 `artifacts/acceptance/endpoint-protocols-direct.json` 与 `artifacts/acceptance/endpoint-protocols-system-proxy.json`。当轮上游鉴权没有通过，**该轮可用模型与协议支持没有成功证据，六工具端到端成功未成立**。真实 CLI 的详细结果保存在 `artifacts/acceptance/real-agent-results.json`，不能把 HTTP 401、模拟响应或配置加载成功计为通过；当前状态以[当前验证记录](current-validation.md)中的独立收据为准。

六种官方工具已实际请求用户提供的端点：Claude、Codex、Hermes、oh-my-pi、OpenCode、ZCode 均退出失败并报告上游 HTTP 401 `Invalid API key`，通过数 **0/6**。每个工具的脱敏结果另存于 `real-agent-<工具>.json`。Claude 的默认重试会让无效密钥测试等待很久；验收进程设置 `CLAUDE_CODE_MAX_RETRIES=0` 后约一秒返回明确 401，之前的观察超时不能替代最终失败证据。

当前通过目标至少包括：八种实际工具各自产生真实模型回复、工具写文件后再读取验证、流式响应完整结束、多轮工具调用维持 ID 与内容、无上游密钥出现在日志、所有运行文件位于便携目录。最终验收应经 Rust 网关和应用生成的启动器执行，再检查网关记录的真实上游状态。

## 历史六工具应用生成配置与 Rust 网关验收

`tests/acceptance/run-generated-agents.mjs` 使用 `AE_SWITCH_CLI` 指定当前目录内的真实 Rust 可执行文件；默认路径是 `.cache/cargo-target/debug/ae-switch-cli.exe`。它从凭据文本读取密钥，仅通过 stdin 传给 `save-provider`，再调用 `configure-all`。六种工具的配置完全由应用生成，脚本不手写或覆盖它们。

随后启动 `serve`，带本地令牌请求 `127.0.0.1` 的 `/health`，再逐个执行应用生成的 `launch.ps1`。连接阶段只读取真实 assistant/result 输出，提示词回显不计为成功。连接通过后才运行受控文件工具回合：新建唯一文件，要求文件内容精确匹配标记、观察到读写工具事件与读回结果，并收到相同的最终回复。所有条件同时成立才计为该工具端到端通过。

运行数据在 `.cache/acceptance/generated-app`，脱敏证据在 `artifacts/acceptance/generated-app`。六个已安装 CLI 的 bin 目录通过子进程 PATH 提供；此处没有放宽应用对便携目录外配置或符号链接的路径校验。`NO_PROXY` 包含 localhost，Rust 使用本机已经配置的系统代理访问上游。

2026-10-08 已实跑该应用链：Rust `save-provider`、`configure-all`（六份配置）、`serve` 与带本地令牌的 `/health` 均成功。六个实际生成的 `launch.ps1` 分别启动官方 Claude Code、Codex、Hermes、oh-my-pi、OpenCode 与 ZCode；每个 CLI 均退出码 1、没有超时，并报告上游 HTTP 401。连接通过 **0/6**，受控文件读写回合因连接失败未执行，端到端通过 **0/6**。配置与网关就绪不能证明上游推理可用。

完整脱敏结果在 `artifacts/acceptance/generated-app/results.json`，每个工具另有同名 JSON；`setup.json` 记录配置生成和健康检查，`gateway.json` 记录 Rust 服务输出。本次模型 `claude-opus-4-6` 仅用作认证诊断，没有成功的模型目录或可用性证据。创建新供应商时 `ProviderInput.id` 必须为 `null`，验收脚本使用 Rust 返回的 ID 配置工具。

在尚未成功发现可用模型时，`AE_TEST_MODEL` 仅作为明确的鉴权诊断模型，不表示上游支持该模型。测试记录区分配置生成、连接推理与完整文件工具回合，不能将其中任何前置阶段冒充最终端到端通过。
