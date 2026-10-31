# Magpie 源码评估与 AE Switch 后续开发

评估日期：2026-10-30。上游：<https://github.com/yetone/magpie>。本次读取的完整源码固定在 `cdf8151a2e0c3c48191481272dbaee0c210e989a`，不是只按 README 列功能；未运行 Magpie，也未验证其供应商、订阅或跨平台行为。本文的“已有”指检查到实现，不代表本机实测通过。

结论：Magpie 最值得借鉴的是接入后的可观察性、配置所有权管理和模型切换体验。AE 已有本地鉴权网关、OpenAI/Anthropic 转换、八客户端接入、原配置合并、安装发现与便携化，无需重新实现这些基础。最先补齐请求活动，再做配置漂移检测与安全恢复，收益大于立即扩充大量客户端或引入插件平台。

本轮已实施请求活动；其余项目是经过源码核对的建议，不是已交付功能。具体契约见 [请求活动](../app/docs/request-activity.md)。验证结果见 [本轮开发记录](development-2026-10-30.md)。

## 1. 与 AE 的定位和架构关系

| 维度 | Magpie | AE Switch 的取舍 |
| --- | --- | --- |
| 内核 | Go，`internal/agent`、`provider`、`gateway` 按职责拆分 | 继续 Rust + Tauri + React + SQLite，共享桌面与 CLI 内核 |
| 接入 | 每客户端描述字段、读取/写入/检测钩子，网关集中转换 | 八个核心客户端已有适配，先完善当前版本行为 |
| 协议 | Chat、Responses、Messages、Gemini；流式、工具与思考转换 | 现有 OpenAI/Anthropic 转换优先保真；Gemini 是新增需求时的独立适配 |
| 数据 | 配置、用量账本、会话、插件、备份各有来源 | 继续程序旁便携数据；本次诊断仅内存保留，避免日志不断累积 |
| 入口 | 托盘、原生窗口、TUI、Web、CLI | 保持四步单页和桌面/CLI，先提高核心流程完成率 |
| 许可证 | MIT，`LICENSE` 为实际来源 | 与 AE 的 AGPL-3.0-only 组合可行；复制实质代码仍须保留 MIT 版权与许可。本轮为独立 Rust/React 实现，未复制 Go 实现 |

Magpie 的可借鉴点在边界处理：字段是谁写的、流何时真正完成、哪里失败、未知能力如何表达。Go 源码不能直接作为 Rust 依赖使用；引入整个 Magpie 进程还会增加端口、账户、数据目录和更新责任，不适合本轮。

## 2. 功能价值、现状与优先级

| 功能 | 上游实现依据 | 对 AE 的具体价值 | 引入结论 |
| --- | --- | --- | --- |
| 请求活动、失败状态、延迟 | `internal/usage/usage.go` 的 `Record`；`internal/gateway/trace.go` | 判断请求是否经过 AE，区分 HTTP 拒绝、响应内错误、截断和取消，减少 ZCode 类排障歧义 | **本轮落地**；保存最小元数据 |
| token、缓存、思考用量 | `usage.Record`、`internal/usage`、`internal/stats` | 看见真实响应报告的消耗，识别只有思考但没有文字等现象 | **本轮落地基本用量**；缺失不是零，尚未做费用账单 |
| 配置漂移检测 | `internal/agent/applied.go` 的 `Apply`、`Drift`、`Reapply`、`Keep` | 客户端升级或别的切换器改掉端点后，AE 不应继续显示旧选择为有效 | **下一优先级**；只比较 AE 管理的连接字段，不能对整个文件哈希后自动覆盖 |
| 断开、恢复与预览 | `internal/agent/stash.go`、`preview.go`、`internal/uninstall` | 停用 AE 后避免客户端仍连接已退出的本地网关；允许用户审查将恢复什么 | **下一优先级**；恢复自有字段、保留后续人工修改，发现冲突停止写入 |
| 模型搜索、常用列表 | `internal/agent/route.go`、`internal/gui/assets/app.js` | 模型多时无需逐个滚动；只展示该客户端能使用的候选 | **高价值的小步增强**；保留真实模型查询门禁，当前已保存连接也应复用 |
| 具名配置方案 Profiles | `internal/profile/profile.go` 的 `Snapshot`、`Save`、`Apply` | 保存“工作”“低成本”等多客户端模型组合 | **中期**；仅引用连接 ID、模型和等级，不复制账户、密钥、原用户目录；批量失败要可回滚 |
| 供应商能力目录 | `internal/catalog/catalog.go` 的 `Efforts`、窗口与价格字段 | 给模型名、上下文、思考等级增加可追溯提示 | **可引入补充信息**；端点明确声明优先，目录只能建议，不能覆盖用户选择或把未知说成不支持 |
| JSONC/TOML 无损编辑 | `internal/edit`、`agent` 各适配；`stash.go` | 保留注释、排序及无关字段，降低对用户原配置的影响 | **继续强化现有实现**；AE 已有 `agent_configs/jsonc.rs`、`native_merge.rs` 和事务恢复，不另建写入器 |
| 文件损坏后的最后有效配置 | `internal/lastgood/lastgood.go` 的 `Read`、`KeepBad` | 配置写到一半或损坏后有可解释的恢复路径 | **适度借鉴**；保留坏文件并明确报错，不能偷偷换成空配置继续写 |
| 重试、限速与并发管理 | `internal/gateway/fallback.go`、`concurrency.go`、`rpm.go` | 改善短时 429/503；明确等待时间和并发占用 | **可做同端点、同模型的有界策略**；输出已发送后不重试，避免重复工具调用；不能默认自动换模型 |
| 多账户与路由组 | `fallback.go`、`internal/provider`、`internal/routes` | 用户主动管理多个 API 账户时可提升可用性 | **暂缓**；会改变计费、上下文缓存和实际模型，必须显式选择才能启用 |
| 意图路由 | `internal/gateway/ir.go` 等；路由组设置 | 用额外模型决定请求发给哪个模型 | **不引入当前流程**；与“全部推理跟随本会话所选模型”冲突，还增加额外推理调用 |
| 请求隐私脱敏与还原 | `internal/masking/masking.go`、`internal/redact`、`internal/gateway/masked.go` | 用户 opt-in 后可隐藏发往供应商的已知密钥等内容 | **先考虑确定规则与预览**；签名块、工具参数及分片还原需要专门验证，不能直接全局启用 |
| 本地 PII 模型识别 | `internal/pii`、`masking.optionsCtx`/`ModelWanted` | 规则之外识别人名、地址等 | **不引入**；会增加独立模型推理、下载、CPU 与便携依赖，超出现有会话模型约束 |
| API/订阅复用 | `internal/provider`、`internal/plugin`，`docs/subsystems/provider-plugins.md` | 将已登录订阅提供给其他工具 | **暂缓**；账户发现、授权、刷新、插件 ownership 均非普通端点接入，不能因支持某工具就自动读取其登录态 |
| MCP、技能、指令统一分发 | `internal/library`、`internal/mcpauth`，`docs/subsystems/mcp-hub.md` | 多工具复用配置 | **暂缓**；用户原 MCP、插件与权限需要独立所有权和冲突策略，不纳入本轮端点切换 |
| 加密备份与同步 | `internal/backup/backup.go` 的 `Collect`、`Seal`、`Restore`；`internal/davsync` | 跨电脑迁移连接和方案 | **先做本地、默认不含密钥的导出**；加密/同步作为后续独立功能，不把便携数据目录直接上传 GitHub |
| 会话汇总和跨工具历史 | `internal/sessions`、`docs/subsystems/gateway-sessions.md` | 查找历史任务与用量 | **先保持原生历史**；不推断会话归属、不复制或清理原会话，不把网关记录说成原生恢复成功 |

这里的优先级以用户的实际接入目标为依据，不按 Magpie 的功能数量排序。已存在的功能优先做兼容修正和验证，避免在四步页面上重复增加入口。

## 3. 两个与历史问题直接相关的发现

### WorkBuddy 不能由列表写入证明桌面默认模型成功

`internal/agent/workbuddy.go:16-23` 明确说明：WorkBuddy 把模型展示为 `custom-local:<id>`，发送 Chat Completions 请求；模型按任务在窗口里选。其 `workbuddyBuild` 的 `ListsModels: true` 表示管理候选列表。它没有证明“写 models.json 就能设置桌面新任务默认模型”。源码还说明部分版本仅在启动时文件已经存在才建立 watcher，且原子替换文件可能要重启后才能读到。

因此 AE 的 `models.json`、显式 CLI 参数和 UI 选择是三个不同证据。保留原生手选/受控 UI 选择路径，不杜撰额外 preferences 字段；桌面连续任务、默认选择和旧历史需要当前版本单独验证。

### ZCode 格式正在演进

`internal/agent/zcode.go` 同时处理个人 provider/model 配置和较新的规则格式，包含 `providerModelRules`、`personalModelIds`、`modelOrder`、`modelConfigRules` 等。值得提炼为版本/结构识别与兼容测试；不能把别的版本的样例直接写进当前安装。AE 现有“桌面可用但内置 CLI 自动验证失败”的范围说明继续保留，网关活动用于补充排障，不能替代实际文件写读。

## 4. 本轮已实现的范围

- 四步连接流程下新增折叠的“请求活动”，按当前客户端查看，并提供刷新和仅清空该客户端记录。
- Rust 网关记录认证后进入已选客户端处理路径的请求：请求模型、接口、上游协议类别、流式标记、HTTP 状态、完成/失败/中断/未完成/取消、总耗时和首包耗时。
- 观察 Chat、Responses、Messages 返回的用量；输入、输出、缓存读取和思考 token 分别保留“未知”和明确的零。未知用量不参与估算费用。
- 诊断只保留最近 200 条元数据；进程内保存，重启清空；无对话、工具参数、密钥、原始错误、端点 URL、客户端路径落盘。
- 对 SSE 做有界旁路观察，原始分片继续发送；HTTP 200 内错误不会显示成完成，缺少终止事件的流记为中断。
- 不增加推理调用、不更换模型、不启用自动路由、不引入 Magpie 进程或插件运行时。

注意：接口显示“请求模型”，不能证明中转商实际运行了哪种物理模型；耗时是 AE 观察区间；首包可能只是协议事件。记录完成也不是客户端文件写读或桌面默认模型验收通过。

## 5. 后续开发的顺序和完成条件

1. **本轮：请求活动与隐私边界。** 本地 HTTP/流式集成、数据分片、错误、取消、用量和 UI 回归通过，并形成当前构建记录。
2. **配置漂移 + 断开预览。** 对八个客户端分别定义“自有连接字段”，对外部变更只提示；预览与真正恢复复用同一计划；冲突不会覆盖人工修改。
3. **更快的选择体验。** 已查询模型的搜索/常用列表、已保存连接的快速切换；每个客户端独立保留选择，明确等级优先，未知等级仍可选择兼容选项。
4. **具名组合方案。** 逐客户端预览、明确目标 profile、批量应用可回滚；不能悄悄改当前 Codex 会话模型或后台模型任务。
5. **按真实反馈增加兼容。** 新版 ZCode/WorkBuddy 结构、新客户端或 Gemini 协议以实际需求和可运行版本为前提。

新源码通过测试、构建与静态审查之后，仍需对当前构建开展官方客户端真实端点与桌面验收；不能拼接历史版本的成功收据。本轮未以 Magpie 的测试、README 截图或在线发布成功替代 AE 的真实验收。

## 6. 可复核的固定版本来源

以下链接均固定本次分析提交，避免后续主分支变化影响结论：

- [整体说明与功能](https://github.com/yetone/magpie/blob/cdf8151a2e0c3c48191481272dbaee0c210e989a/README.md)
- [请求与用量记录](https://github.com/yetone/magpie/blob/cdf8151a2e0c3c48191481272dbaee0c210e989a/internal/usage/usage.go)
- [流开始前的 fallback 约束](https://github.com/yetone/magpie/blob/cdf8151a2e0c3c48191481272dbaee0c210e989a/internal/gateway/fallback.go)
- [配置所有权与漂移](https://github.com/yetone/magpie/blob/cdf8151a2e0c3c48191481272dbaee0c210e989a/internal/agent/applied.go)
- [恢复预览](https://github.com/yetone/magpie/blob/cdf8151a2e0c3c48191481272dbaee0c210e989a/internal/agent/preview.go)
- [Profiles](https://github.com/yetone/magpie/blob/cdf8151a2e0c3c48191481272dbaee0c210e989a/internal/profile/profile.go)
- [模型能力目录](https://github.com/yetone/magpie/blob/cdf8151a2e0c3c48191481272dbaee0c210e989a/internal/catalog/catalog.go)
- [隐私脱敏](https://github.com/yetone/magpie/blob/cdf8151a2e0c3c48191481272dbaee0c210e989a/internal/masking/masking.go)
- [加密备份](https://github.com/yetone/magpie/blob/cdf8151a2e0c3c48191481272dbaee0c210e989a/internal/backup/backup.go)
- [WorkBuddy](https://github.com/yetone/magpie/blob/cdf8151a2e0c3c48191481272dbaee0c210e989a/internal/agent/workbuddy.go)
- [ZCode](https://github.com/yetone/magpie/blob/cdf8151a2e0c3c48191481272dbaee0c210e989a/internal/agent/zcode.go)
- [MIT 许可](https://github.com/yetone/magpie/blob/cdf8151a2e0c3c48191481272dbaee0c210e989a/LICENSE)
