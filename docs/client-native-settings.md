# 客户端原生上下文与推理设置

更新日期：2026-10-18。AE Switch 的四步连接流程负责端点、认证和模型选择。**上下文预算和压缩策略继续由客户端管理；模型列表明确返回可选思考等级且上游为 OpenAI 协议时，可在模型下方选择思考程度。默认保留客户端或供应商设置，显式选择后由 AE 本地网关应用，不改客户端原有推理字段。**

选项只来自当前模型的 `supported_reasoning_levels`、`supported_reasoning_efforts` 或 `reasoning_efforts` 元数据；不按模型名称猜测全部等级。供应商未返回能力时显示默认及说明。Anthropic 原生上游暂不提供该覆盖，不将 OpenAI 档位随意转换为 token 预算。

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

[`AgentHub.tsx`](../app/src/AgentHub.tsx) 将当前选中的思考等级存入 `ProviderInput.reasoningEffort`，默认存为 null；切换模型或模型能力变化后不沿用失效选项。确认连接时，各客户端的选定模型和等级分别保存，之后修改共享供应商不会改变其他客户端已确认的等级。

网关只覆盖该客户端当前选定模型的上游请求：Responses 使用 `reasoning.effort`，Chat Completions 使用 `reasoning_effort`。默认不删除或修改客户端自己的参数；其他模型及旧路由不被这个选项覆盖。客户端配置仍由 [`agent_configs.rs`](../app/src-tauri/src/agent_configs.rs) 合并，原有推理和上下文字段保留。协议桥接与兼容回退也须保持选定等级，有本地模拟上游回归检查实际收到的字段。

已有配置会保留；客户端发起的请求仍受原有桥接转换规则约束，明确选中的 AE 等级在 OpenAI 上游发送前应用。没有重跑真实供应商推理时，只能据本地请求回归确认传递逻辑，不能声称供应商物理执行了相应强度。

需要明确保留的差异：

- **已有原生设置**：不擅自改写；冲突时给出错误并保留原配置。
- **缺失模型元数据**：OMP／OpenCode 的 128000／8192，以及 Z Code 的 `disabled`，属于当前实现的缺省值，不可描述为上游真实查询结果或客户端原生默认。
- **能力来源**：优先供应商实际返回的等级；客户端目录只说明客户端认识的选项，不能证明任意自定义端点接受相同等级。不盲目删除客户端运行所需字段。

上述缺省上下文及原生模型目录兜底没有改成动态能力查询；思考选择是本轮新增能力，已有发布包不会自动包含源码里的改动。

## ZCode 自动验证与桌面使用

ZCode 桌面入口与自动文件验证入口不同。现有桌面程序由 AE 调其自带 CLI，在隔离验证目录执行真实文件写入、独立读取和内容核对。`clientSurface=desktop-bundled-cli` 表示该入口；它的非零退出只说明自动验证失败，不能据此判定桌面配置不可用，也不能将桌面能聊天视为文件工具验证已通过。

验证会提取 `turn.failed.payload.error` 中的错误码与消息，省略请求、堆栈和 URL，并脱敏已知凭据。当前运行窗口没有保留的旧 stderr 无法事后恢复，因此仅凭旧截图不能确定当时的具体退出原因。

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
