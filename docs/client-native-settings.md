# 客户端原生上下文与推理设置

核对日期：2026-10-11。AE Switch 的四步连接流程负责端点、认证和模型选择。**上下文预算、推理强度及压缩策略由客户端自己的设置和模型能力决定，AE 不增加一套设置界面，也不覆盖已有的原生值。**

客户端的上下文设置不能扩大服务端模型的真实容量；模型切换后仍需由客户端根据实际模型能力校验。下面区分“保留已有设置”和“创建自定义模型时补充的缺省元数据”。这些静态资料不代表八客户端真实推理验收完成。

## 八个客户端的实际行为

| 客户端 | 原生设置或能力 | 当前四步流程的行为 |
| --- | --- | --- |
| Claude Code，安装版 2.1.293 | 官方文档提供 `effortLevel`、模型单独设置、`--effort`、`CLAUDE_CODE_EFFORT_LEVEL`；上下文由所选模型及客户端窗口／压缩策略管理 | 更新端点、认证和模型路由；保留既有推理及上下文相关设置 |
| Codex，安装版 0.161.0 | 安装的官方程序包含 `model_reasoning_effort`、`model_context_window`、`model_auto_compact_token_limit` 配置字段 | 原生配置合并路径不写这些字段；已有值保留，未填写的值交给客户端。旧高级配置适配器仍有显式覆盖能力，不属于当前四步连接的写入路径 |
| Hermes，安装的官方源码 | `model.context_length` 留空时由客户端自动探测；`agent.reasoning_effort`、按模型覆盖和辅助任务的 `reasoning_effort` 由原生配置控制 | 只更新默认及必要辅助任务的模型、供应商与认证路由；保留上下文、推理强度和原有压缩设置 |
| oh-my-pi，安装的官方程序 | 客户端具备 `thinkingLevel`、模型的 `contextWindow`、`maxTokens`、`reasoning` 能力字段 | 保留已有模型元数据；缺失时当前实现补 `contextWindow=128000`、`maxTokens=8192`。这是 AE 的既有兜底，并非查询得到的真实能力或客户端默认值 |
| OpenCode，安装版 1.18.35 | 模型元数据可包含 `limit.context`／`limit.output`，推理可用 `options`／`variants`；官方配置 schema 的整个 `limit` 对象可选，但提供该对象时 `context`、`output` 必填 | 保留已有字段；缺失时当前实现补 `context=128000`、`output=8192`。这两个数字是 AE 的既有兜底，不是官方强制值。安装程序的 `context=0` 路径会关闭自动压缩，不能把直接删除元数据视为行为等价 |
| Z Code，安装的官方 `zcode.cjs` | 完整模型属性要求正数 `contextWindow`；推理档位来自该模型的 `optionSpecs.reasoningLevel.values`。原生新选择使用该列表最后一项；运行时选择验证要求有有效推理档位 | 已有 `reasoningLevel` 保留；缺失时 AE 目前补 `disabled`。新便携 fallback 元数据固定 128000 上下文、8192 最大输出、仅支持 `disabled`；不兼容的既有推理档位会拒绝配置，原值不覆盖。这不是对所有上游模型能力的声明 |
| WorkBuddy，安装版 5.7.6 | 官方模型设置表单包含输入／输出上限、`supportsReasoning`、`defaultEffort`、`supportedEfforts`、`canDisableThinking`；会话代码也接收 `thoughtLevel`／`contextWindow` | 保留已有上下文和推理对象；新自定义模型缺字段时补 `supportsReasoning=false`，与该版官方新建表单的初值一致。官方桌面默认模型、账户与历史恢复仍需真实验收 |
| DeepSeek Harness，安装的官方插件 | `agent-default-model.reasoningEffort` 可选；`llm-pi-ai` 可以使用原生模型目录、`reasoningEfforts` 与上下文／输出回退值 | 更新供应商、模型、端点及认证；不写推理强度或上下文字段，保留原值并使用客户端插件自己的回退逻辑 |

## 当前实现的边界

[`AgentHub.tsx`](../app/src/AgentHub.tsx) 的 `ProviderInput`（核对时第 345–360 行）没有新增推理或上下文选择：保存时保留已有供应商的 `reasoningEffort` 和 `codexOptions`。客户端配置由 [`agent_configs.rs`](../app/src-tauri/src/agent_configs.rs) 合并；[`native_merge.rs`](../app/src-tauri/src/agent_configs/native_merge.rs) 的 `default`（第 272 行）在字段存在时保留原值，只在缺失时填入兜底。

已有配置会保留；跨协议请求会按桥接能力转换推理档位，可能降档，实际发送的 effort 仍需通过请求证据确认。

需要明确保留的差异：

- **已有原生设置**：不擅自改写；冲突时给出错误并保留原配置。
- **缺失模型元数据**：OMP／OpenCode 的 128000／8192，以及 Z Code 的 `disabled`，属于当前实现的缺省值，不可描述为上游真实查询结果或客户端原生默认。
- **后续改进**：优先沿用客户端有效模型目录、原生默认选择与供应商实际返回的能力；不能盲目删除客户端运行所需字段，也不应为此增加主流程设置项。

当前冻结生产版本保持这些行为。本文不宣称上述兜底已经改成动态能力查询。

## 核对来源

以下本地来源来自 G 盘隔离安装，不是用户的个人配置。行号对应核对时文件；便携交付不包含这些客户端源码或程序。

| 来源 | 核对位置 |
| --- | --- |
| AE 的客户端配置合并 | `app/src-tauri/src/agent_configs.rs`：Codex 1228–1334；OMP 1413–1428；OpenCode 1547–1577；Hermes 1594–1641；WorkBuddy 1694–1701；Z Code 1728–1738、1836–1858；DeepSeek Harness 942–984 |
| AE 已有值保留 | `app/src-tauri/src/agent_configs/native_merge.rs:272`；`app/src-tauri/src/agent_configs/existing.rs:1187` 保留 Codex 上下文回归、1192 保留 Hermes 上下文回归 |
| Claude Code 官方资料 | 已实际读取 [Model configuration](https://code.claude.com/docs/en/model-config.md)，HTTP 200；安装版本来自 `.tools/agents/claude/node_modules/@anthropic-ai/claude-code/package.json` |
| Codex 安装的官方程序 | 版本来自 `.tools/agents/codex/node_modules/@openai/codex/package.json`；原生字段在该安装的 `@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe` 中确认。官方 OpenAI [config reference](https://developers.openai.com/codex/config-reference/) 页面及 Markdown 路径本次均返回 HTTP 403，未据此宣称当前线上默认强度或容量已核实 |
| Hermes 官方配置示例 | `.tools/agents/hermes/source/cli-config.yaml.example:135`：上下文自动探测；907–910：辅助任务空值使用供应商默认；1294–1315：原生推理设置和按模型覆盖。该源码 `pyproject.toml` 声明版本 0.0.0，不能用它标识稳定发布版本 |
| OMP 安装的官方程序 | `.tools/agents/oh_my_pi/omp.exe` 中确认 `thinkingLevel`、`contextWindow`、`maxTokens`、`reasoning` 字段；源码网络读取超时，没有据此断言自定义模型 schema 的每个必填字段 |
| OpenCode 官方配置 schema | 已实际读取 [config.json](https://opencode.ai/config.json)，HTTP 200，`$defs.ProviderConfig.properties.models.additionalProperties.properties.limit`；安装版本来自 `.tools/agents/opencode/node_modules/opencode-ai/package.json`，自动压缩的零窗口分支在同安装的官方程序中确认 |
| Z Code 安装的官方源码 | `.tools/agents/zcode/source/apps/zcode-cli/packages/cli/dist/zcode.cjs:25653`：推理档位验证；25793–25800：新选择使用支持列表最后一项；`completeModelPropertiesDataSchema` 定义完整上下文字段 |
| WorkBuddy 官方程序包 | `.tools/workbuddy/resources/app.asar` 内 `package.json` 为 5.7.6；`renderer/assets/ModelsSettingsPanel-BhSrZkff.js` 的 `ot`／`He` 初始化能力和元数据；`main/conversations.js` 接收会话思考／上下文设置。只读取包内源码，没有改动客户端 |
| DeepSeek Harness 官方插件说明 | `.tools/agents/deepseek_harness/node_modules/@deepseek-ai/dsh-agent-default-model/README.zh.md:46`：可选推理设置；`@deepseek-ai/dsh-llm-pi-ai/README.zh.md:103`：原生目录和缺失元数据回退 |
