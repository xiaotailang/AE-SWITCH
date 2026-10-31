# 原生代理配置合并

正式包只分发 AE；八客户端由用户自行安装，默认接入目标是其既有 profile，自动发现提供候选、手填路径作为后备。新模式尚需最终端到端验收，旧私有 profile 测试不能代入。

一键配置只更新所选模型、供应商以及本地网关所需的地址、凭据和协议字段。历史记录、会话、MCP、插件、权限、上下文和其他未受管设置保留。没有显式上下文输入时，不重设已有上下文或输出长度；OMP/OpenCode 的默认长度仅补充缺失字段。

JSON 文件保留未受管字段的语义，格式可能重新排版。Codex TOML 使用原有文档编辑器，保留未修改的表、值和注释。已有 Z Code builtin 和 DeepSeek workspace 文件通过校验后保持原始字节。已有模型定义保留；新模型可以继承原所选模型的上下文和能力。WorkBuddy 新模型追加独立条目，已有条目的标志和 vendor 不被清除；所选条目如果强制使用与网关不兼容的传输，会拒绝配置。

每个 Agent 使用自己的 `selected:<agent>` 网关路由和已保存模型。多个 Agent 共用供应商时，供应商默认模型随后变化不会替换各 Agent 的选择；被停用的模型在配置和请求入口使用同一规则拒绝。Claude Code 路由可以将格式受限的官方角色别名映射到该 Agent 所选模型，不把普通 Agent 请求的任意模型名改写为默认模型。

## 默认与辅助模型范围

| 工具             | 受管路由                                                                                  | 保留范围                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Codex            | 主模型；当前活动 profile 中已有的模型/供应商；根及活动 profile 中已有的 `review_model`    | 其他 profile、权限、MCP、上下文和非路由字段                                                                       |
| Claude Code      | 主模型及 Opus/Sonnet/Haiku；已有 subagent 和 SMALL_FAST 角色；认证自定义 header           | 非路由偏好、apiKeyHelper、登录/审批历史及普通 headers；仅清理生效的供应商/传输选择覆盖                            |
| OMP              | 十个官方聊天角色：default、smol、slow、vision、plan、commit、tiny、memory、task、advisor  | image/web/speech/dictation/judge 等独立 runner kind、未知角色、能力与上下文                                       |
| OpenCode         | 主模型、`small_model`；七个内置 agent 及当前自定义 `default_agent` 已有的模型 pin         | 其他自定义 agent、提示词、工具、权限及普通选项                                                                    |
| Hermes           | 主模型、compression/title_generation/background_review，以及已有的 review                 | enabled、timeout、推理及普通偏好；vision/tts/voice 等专用任务                                                     |
| DeepSeek Harness | 主模型；标题、压缩及压缩 policy 已有的非空路由对；spawn/fork 已有的 agentOptions 模型路由 | 缺失路由继续继承；压缩空路由对、上下文 policy、插件、enabled 与其他字段。没有显式标题配置时不关闭官方默认标题功能 |
| Z Code           | 默认选择及 `v2/agents-state.json` 中已有的 general-purpose、Explore 模型选择              | reasoning 选项、其他代理、disabledAgentIds 和历史；没有状态文件时不创建，没有路由变化时保持原字节                 |
| WorkBuddy        | 所选 models.json 条目及官方 headless host 的主模型；默认标题、子代理与压缩沿用主选择      | 其他模型、偏好和历史。该范围不等于原厂桌面 GUI 已验收                                                             |

此范围依据当前绑定版本的官方默认工作流。其他自定义代理、独立多模态任务、插件和用户主动选择的其他模型不由主任务成功推定已验证。

DeepSeek 的所选 `ae-switch` 供应商使用 `apiKeyEnv` 引用网关凭据。既有模式写入原生 `.credentials.yaml` 的 profile 唯一 refs（`AE_SWITCH_<profile摘要>_API_KEY`），保留其他 refs/records；须确认有效 composition 加载默认本地凭据插件以及实际凭据路径，停用、替换或无法解析的覆盖会拒绝。旧私有模式仍使用 `AE_GATEWAY_TOKEN` 启动环境。官方请求链会让 `headers.Authorization` 覆盖 SDK 自动生成的 Bearer 认证，且请求头名称不区分大小写。因此，一键配置会把该供应商已有的每个 Authorization 字符串值更新为 `Bearer <当前网关令牌>`，包括旧令牌或空值，同时保留原请求头名称和大小写；没有该请求头时不创建。其他供应商的请求头和所选供应商的普通请求头（包括 `Proxy-Authorization`）保留。`headers` 必须是字符串值的对象，错误结构会在写入任何配置文件、环境文件或启动器之前拒绝配置；未知的直接 `apiKey` 字段保留，不推测其认证作用。

OMP 的模型级 `api` / `baseUrl` 优先于供应商默认值，匹配模型的 `modelOverrides.api` 随后再次覆盖协议。一键配置仅同步所选模型已有的这些路由字段；新模型继承的路由同样同步，缺失的模型级字段不创建。网关供应商、所选模型及同名模型 override 中已有的 Authorization 更新为当前网关 Bearer 令牌，保留请求头名称和其他请求头；其他模型和 override 不修改，上下文及能力保留。既有模式中 OMP provider `apiKey` 保存 literal 网关令牌。Hermes 主 `model.api_key` 和默认辅助任务 `api_key` 保存原生令牌；已有旧式 `model.api` 同步。私有模式仅同步已有 inline 字段。Hermes 同 endpoint 的自定义认证池可能另有更高覆盖；不删除用户认证池来猜测有效认证。上述受管字段结构错误时均在任何文件写入前拒绝配置。

OpenCode 只同步所选模型已有的上游 `id` 和 `provider.npm`，避免旧别名或旧 SDK 覆盖新路由。所选供应商 `options.headers` 与所选模型 `headers` 中已有的 Authorization 同步为当前令牌；其他请求头和模型选项保留。普通 `model.options.baseURL` / `apiKey` 在当前通用 compatible SDK 路径中不重建传输，因此不推测它们是认证覆盖字段。

Codex 既有模式将所选 provider 的 `experimental_bearer_token` 写为网关令牌，移除该 provider 的 `env_key`，并设 `requires_openai_auth=false`，使原入口可读取持久认证；私有模式继续引用启动环境。Bearer 认证在普通请求头之后应用。所选 `ae_switch` 供应商若存在 `auth`、`gateway_oauth` 或 `aws`，会在写入前报认证冲突并保留原文件，不执行旧认证 helper。其他供应商的认证配置保留。

Z Code 新建或与本工具生成内容完全一致的 builtin fallback 仅支持 `reasoningLevel: disabled`。个人模型规则为空且无未知规则时，已有默认选择或两个内置代理的其他推理档位会使配置失败，原配置不覆盖。第三方 builtin 或自定义模型规则不由本工具猜测能力；实际兼容性仍需原工具验证。

既有模式只写选中的原生配置，不创建 AE 私有 HOME 或客户端启动器。原 HOME/profile/数据根保持原位置，本地 Rust 网关须持续后台运行。OpenCode 使用原生 `options.apiKey`，ZCode/WorkBuddy 使用原生模型凭据；能从普通入口读取仍需实际所装版本验证。WorkBuddy 桌面源码读取 models.json 不证明默认模型已经选中，不能猜写 GUI 状态。ZCode 实际辅助状态可能由 CLI 项目/环境或桌面 storage.dir 指定，未解析时不能省略原状态后声称辅助模型已同步。实现与验收边界见[发布审核](release-readiness.md#八工具既有-profile-的实现契约)。

WorkBuddy 5.7.6 的桌面 `main/index.js` 与随程序提供的 `cli/dist/codebuddy-lite-wb.mjs` 是不同入口。测试用 `ELECTRON_RUN_AS_NODE=1` 让官方 `WorkBuddy.exe` 执行后者；后者支持 `-p/--print`，桌面入口未确认支持这些参数。CLI 成功不能标记为桌面 GUI 验证成功；仅发现桌面可执行文件时，不能直接按 headless 参数启动并宣称工具已验证。

Claude Code 既有模式保留 `apiKeyHelper` 和厂商审批/登录历史。已有 `CLAUDE_CODE_SUBAGENT_MODEL`、`ANTHROPIC_SMALL_FAST_MODEL` 同步；已有字符串 `ANTHROPIC_CUSTOM_HEADERS` 中 Authorization 和 x-api-key 认证行更新，普通行、顺序和换行保留。官方云/网关供应商选择标记与 `ANTHROPIC_UNIX_SOCKET` 是传输覆盖，按接入范围清理；OAuth/WIF/token FD、云区域与密钥等不因名字删除。首次交互使用新 API Key 可能仍需官方确认，不能以 headless 推理证明零确认弹窗。

## YAML 支持范围

当前没有引入新的 YAML 解析依赖。编辑器支持一个保守子集，并不支持任意 YAML：

- 使用空格缩进的对象和数组，包括 `- id: model` 形式的对象条目。
- 普通字符串、JSON 双引号字符串和 YAML 单引号字符串。
- 无歧义的 `true`、`false`、`null`、`~` 与常规十进制整数/小数。
- JSON 格式的流式集合，例如 `{"enabled":true}`、`["text","image"]`；集合中的科学计数数字不支持。
- 未修改的 `|`、`|-`、`|+`、`>`、`>-`、`>+` 多行文本原块。需要移动或复制这种原块时会拒绝合并，避免改变折叠、缩进和换行语义。

别名、锚点、标签、指令、多文档、复杂键、非 JSON 的流式集合、制表符缩进以及重复键不支持。Hermes、OMP 和 DeepSeek 使用的 YAML 方言可能不同，因此不猜测 `yes/no/on/off`、时间戳、十六进制/八进制/二进制数、下划线数字、非有限值、科学计数和其他特殊数值的类型。此类普通标量会使配置失败；如果它们确实是字符串，可以加引号后重试。实际数值应在原工具中修改，或采用明确的常规十进制表示。

未修改的 YAML 子树、注释和多行文本保留原始源码。修改已有标量时只替换对应值；新增条目使用合法 JSON 流式值。编辑后的源码会再次解析并核对合并结果。已有且不受支持的 YAML 会保留原文件，并返回可操作错误，不会被模板替换。

合并键 `<<` 和带 UTF-8 BOM 的 YAML 同样会拒绝合并，避免把方言特殊键或文件头误当普通字段。

## 既有客户端安全重启

安全重启只处理能核实官方入口、选中 profile、工作目录、PID 与进程启动时间的实例。多个候选需由用户明确选择；配置版本或进程身份变化时取消操作并重新查询。无法确认原生 profile 或原入口覆盖时不能关闭客户端。

Windows 桌面程序先请求正常退出，确认旧进程已退出后才重新打开。终端客户端先返回等待状态，由用户在原终端正常退出；AE 不结束终端、不强制停止客户端、不重放自动化任务。等待期间 AE 须保持运行；配置改变、等待失败或超时要明确显示原因，不能显示为重启完成。

重新打开使用原 profile 与工作目录，新会话读取最新配置。历史文件继续保留，旧活动会话是否恢复由客户端决定，不能把新进程出现当成原会话恢复成功。DeepSeek Harness 的 headless 入口需要新任务；不执行空任务，也不自动重放上次任务。其他平台当前提示从原终端正常退出后重新打开。以上是当前实现与验收边界，官方客户端全流程通过情况仍以绑定最终程序的收据为准。

## 写入边界

既有模式对本次选择的精确原生文件与模型选择先读取、校验并合并，使用独立 `agent-native-configuration.pending.json`，journal 保存固定配置槽位，由另存的所选 profile 提供恢复授权，不接受 journal 任意绝对路径。模型选择先写，原文件恢复后再还原选择；相同 selection 的重复配置也需检查文件实际提交状态。默认/辅助模型、凭据和配置合并失败须在首个客户端写入前拒绝。

私有模式的原生文件、环境文件、启动器和模型选择先读取、校验并合并，再统一提交。提交前重新核对所有快照，包括原来不存在的文件，并将原内容及计划内容保存到数据目录的 `agent-configuration.pending.json`；备份上限为 32 MB。每个文件写入前再次核对原内容，使用原有原子写入器、根目录约束和链接/目录联接检查，写入后立即读回确认。

中途失败时先检查全部文件，再按相反顺序恢复原内容。恢复只接受文件仍为原内容或本次计划内容的状态；发现外部修改或恢复失败时保留备份并报错，不覆盖无法确认的用户修改。打开 Store 或再次配置时自动检查待恢复备份：本次提交已完整落盘时保留提交结果并清理备份，部分提交则恢复原内容。成功提交后若备份暂时无法删除，也由后续恢复流程处理。

新备份保存相对于当前数据根的路径，完整便携目录搬移后可在新根恢复。旧绝对路径备份只接受当前同一根内的文件，不推测旧根。空路径、`..`、重复路径、相对路径与同根旧绝对路径指向同一条目的备份、其他根的绝对路径及目录跳转会拒绝恢复；Unix 启动器恢复时重新设置 `launch.sh` 的 `0700` 权限。

Windows 既有模式对每个已授权原生文件取得排他句柄，在同一句柄内核对快照、写入、刷新和回读；写入、删除或原子替换占用会被拒绝。新文件使用只创建新文件的语义，删除也绑定该句柄。原生更新依靠先持久保存的事务备份恢复，不在释放句柄后重新打开路径替换。其他平台尚无同等共享访问保证；私有模式沿用原子写入器。逐文件保护不构成整个目录或多个客户端的原子事务，外部编辑仍可使恢复停止。原厂历史列表和会话恢复界面的保留须在对应客户端另行验证。
