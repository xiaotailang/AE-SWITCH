# 当前验证记录

## 2026-10-11 当前 Windows canonical 绑定（22312f6761aa4615b14a09a3f2429606）

当前 canonical 是 `artifacts/AE-Switch-portable-win-x64`，为完整免安装便携目录，不是单个裸 EXE。源码摘要为 `5d3b27896895e0111525247c0f8ed860a3b14f64fa47658c8807ed25540ac8be`；desktop/core/QA SHA256 为 `b7c4e53e7986e72b34d685f6e9b8281dbee407048d9f0bb8e577fec9163a9bf5`、`898380d0e0ef0c4c17ebfa2d320b1cd62a7a32fb2605dcc2adf638eb78fae494`、`eada8c9cc09c94465fae4885b7d614c845e6df6ba1c97aaae25468c53520b866`。

Windows release audit 的 rustfmt、Clippy、跨目标检查和三条构建均通过；Rust 全特性为 362 通过、0 失败、3 ignored。当前包对应/边界/Win32 元数据审计通过：源码 530 个、UI 65 个、包文件 1536 个、0 个 reparse、凭据扫描无命中。生产桌面四门、canonical CLI smoke 和 AE-only G 盘目录迁移通过；迁移为合成 localhost 数据，未启动官方客户端或执行网络推理。

新 QA Native 轮次的实际 UI、8 个首次工具写读和 8 个独立复验通过，所属沙盒已清理；同轮托盘分支在 Windows Shell `MoveTrayCursor`/溢出恢复失败，所以整轮 Native 与 `fullAcceptance` 仍为 `false`，`publicReady` 仍为 `false`。WorkBuddy 真实账户未登录，官方桌面默认模型、连续两次 GUI 任务和历史恢复仍为账号前置阻塞；显式模型 CLI 证据不能替代这些 GUI 门。干净 Windows 异机、macOS/Linux 原生 GUI 与官方客户端也未验收。

证据入口：[统一状态](../artifacts/acceptance/validation-status.json)、[build receipt](../.cache/release-audit-current-22312f6761aa4615b14a09a3f2429606/build-receipt.json)、[production runtime](../artifacts/acceptance/desktop-runtime-5aec440a1e6c4cb493f893d895b4c6f1.json)、[目录迁移](../artifacts/acceptance/portable-directory-migration-d9051fcf64fe4141afceacade8688096.json)、[Native UI](../artifacts/acceptance/native-ui-retest/native-ui-results.json)、[Native wrapper](../artifacts/acceptance/native-e2e-wrapper.json)。
## 历史绑定（5f38df1248bb4e5c905c079f5990225b，已被 22312 新包取代）

本轮默认 canonical 包已提升为 `artifacts/AE-Switch-portable-win-x64`；旧包完整保留在 `artifacts/AE-Switch-portable-win-x64-superseded-20261011-f948`。当前源码 digest 为 `5d3b27896895e0111525247c0f8ed860a3b14f64fa47658c8807ed25540ac8be`，Windows desktop/core/QA SHA256 分别为 `7e94008291b503835ac70ec328ae3e76553ef2c534337cd050699a38c35f4c42`、`898380d0e0ef0c4c17ebfa2d320b1cd62a7a32fb2605dcc2adf638eb78fae494`、`9efab0f1237b065ac1674d6e41c6cc9cdfd09d0144707e638587b0a58333a9fe`。

当前包对应审计和边界检查均通过：源码 530 个、UI 65 个，包文件 1536 个，凭据扫描无命中，无运行时 `data`，canonical Win32 元数据检查无 reparse point。证据：[build receipt](../.cache/release-audit-current-5f38df1248bb4e5c905c079f5990225b/build-receipt.json)、[checks receipt](../.cache/release-audit-current-5f38df1248bb4e5c905c079f5990225b/checks-receipt.json)、[包对应](../artifacts/acceptance/final-package-correspondence.json)、[包边界](../artifacts/acceptance/final-package-boundaries.json)、[Win32 canonical](../artifacts/acceptance/final-package-win32-canonical-20261011.json)。

Native 当前轮次的 223 个 UI 步骤、8+8 工具验证和托盘门禁通过，但原始 wrapper 在共享文件锁清理窗口内失败；因此 `fullAcceptancePassed:false`、`publicReady:false` 继续保持。WorkBuddy 仍只有显式模型 headless/CLI 证据，官方桌面 GUI 默认模型、账户、推理、历史和重启尚未验收；Windows 干净异机、macOS/Linux 原生 GUI 也未完成。当前状态详见 [validation-status.json](../artifacts/acceptance/validation-status.json)。

2026-10-11。**全部发布验收尚未通过，`fullAcceptancePassed:false`、`publicReady:false`。** 当前 audit `c921…`、源码 `a5c5…`：Rust 三个测试入口合计 362 通过、0 失败、3 ignored，rustfmt、Clippy、跨目标检查及 Windows desktop/core/QA 构建通过。原前端 246 项仅按 99 source/63 dist 未变 hash 投影，本轮未重新执行。正式生产程序的八工具确认配置、真实推理、文件写读与同轮清理已全部通过；生产运行四门、AE-only 同机目录迁移和驱动回归 135 项也通过。官方 CLI 会话恢复已全部 8/8 通过并清理；全 Native UI/八工具复验和 Windows/Linux 来宾系统验收仍在完成，不能将历史 Linux 313/11 或旧二进制结果计入当前修订。 原失败与后续清理分开保留。

本文 `../artifacts/acceptance/` 相对链接用于仓库证据溯源，便携包中的源码副本及 `verification/current-validation.md` 保留同一正文，这些链接在包内不可直接打开。包内请从包根的 `source/ae-switch/app/docs/portable-verification.md` 打开验收导航，或查看 `verification/` 中的十份脱敏 JSON 收据；原始报告和历史文件只在仓库保留。

产品只分发 AE Switch 自身与必要运行依赖。八客户端由用户自行安装，AE 自动发现已安装入口和原 profile，合并必要端点、认证、模型路由字段；历史、会话、数据库、插件和其他偏好不进入接入写集。WorkBuddy 既有通过证据为 CLI；桌面默认模型选择的适配与隔离实测仍在进行，尚无通过收据。

## 当前源码与检查

当前修订保持产品盘符边界：AE 可在 exe 所在的任意可写本地目录运行，包括 C 盘；既有客户端和 profile 可在不同盘。本机测试限定 G 盘。当前 audit `c9210f8ea42447e8a5d5a948704eb30f` 绑定 Windows 应用源码摘要 `a5c5eb2f65dfa451386b8d0d3513dbe5961d434ca6885e2cbfbb7ebc8cd69249`，checks/cross/build 通过且各阶段前后输入未变。新 Native 整轮尚待最终收据；当前首次接入、复验、wrapper、托盘和清理必须来自同一 UUID，不能与先前失败轮次拼接。旧自启测试期待拒绝 C 盘的失败及后续核心/观察修订的失败报告继续保留。

| 当前修订范围 | 结果与证据边界 |
| --- | --- |
| Windows Rust 全 features | 当前 362 通过、0 失败、3 ignored；rustfmt 与 Clippy all features/all targets `-D warnings` 通过，绑定 `c921…`/`a5c5…`。辅助入口和旧独立重启 fixture 的 ignored 不证明官方客户端重启。见[原始 Rust 收据](../artifacts/acceptance/installed-client-checks-c9210f8ea42447e8a5d5a948704eb30f/rust-desktop-tests-release-audit.json)。 |
| 当前构建的前端投影 | 保留原 run `4b210d24e9d148e288a3b553cb923c01` 的 26 文件、246 测试、0 失败及 TypeScript/Vite 原始日志；99 个 source 和 63 个 dist 文件 hash 与当前构建一致。**本轮执行测试数为 0，没有重跑 246 项**。见[投影收据](../artifacts/acceptance/installed-client-checks-c9210f8ea42447e8a5d5a948704eb30f/frontend-current-build-projection.json)。 |
| 跨目标检查 | 当前 Linux/macOS core all targets、macOS production desktop 全 features cargo check 通过；原生 GUI/官方客户端未验。Linux core 实际 OS 运行单独列下，不将跨目标检查当作目标系统运行。见[跨目标收据](../artifacts/acceptance/installed-client-checks-c9210f8ea42447e8a5d5a948704eb30f/cross-receipt.json)。 |
| 历史公开打包与发布准备脚本 | `b350…` 批次分别 52/52、39/39；真实文件在 G，C 路径只用 Test-Path mock。保留四个脚本 hash 与[精确收据](../artifacts/acceptance/portable-build-path-qa-b350dca7b147490db92fcdb8f203d6c4/receipt.json)，本轮未重新执行；不证明真实 C 盘、GUI/客户端或公开发布。 |
| Windows 三程序构建 | 当前 desktop/CLI/QA 三条构建命令 exitCode 均为 0，264 项 Windows 应用输入稳定，程序 hash 见下表。完整发布程序运行、干净异机与全功能验收仍分别待对应收据。 |
| 历史 core 两目录 smoke | `b350…` 的两处中文/空格 G 目录 `help`、`overview` 共 4 次运行通过并清理，仅绑定当时 core。保留[旧收据](../artifacts/acceptance/portable-location-smoke-b350dca7b147490db92fcdb8f203d6c4.json)，当前 core 搬移看下行 `f365…`；不替代桌面、官方客户端、真实 C 盘或异机。 |
| 当前整包目录迁移 | UUID `f36572f0faca46e8a4cc829f3a357c50` 的 AE-only `-ApplicationOnly` 通过：7 次 core 命令 exit 0，12 项 data 搬移即时 0 差异，原 provider ID/已存 Key 状态重开且不重新保存。264 个当前构建输入匹配 `c921…`/`a5c5…`；所属根独立确认不存在、0 进程引用。SQLite 两个 header counter 3→4，保留的排除 counter payload hash 一致；独立复核核对这些保留元数据，没有从已清理原始 DB 重新计算。见[运行收据](../artifacts/acceptance/portable-directory-migration-f36572f0faca46e8a4cc829f3a357c50.json)和[独立复核](../artifacts/acceptance/portable-directory-migration-application-review-f36572f0faca46e8a4cc829f3a357c50.json)。仅同机 G 盘合成 localhost provider 存储/重开，未发现、配置或启动客户端、未进行网络推理。 |

| 当前 Linux 实际 OS | 当前源码 `a5c5…` 的 Debian 13 core/library/生产桌面验收正在 G 盘独立 QEMU 沙盒准备与执行，尚无最终收据。旧 `5e128…` 的 313 library tests/11 gates、正常关机与清理仅属于旧 `6317…` 修订，不能作为当前源码通过。 |
| 当前验收驱动回归 | `19540…` 新运行：9 文件、135 通过、0 失败，生产输入及所选 driver 前后快照未变，绑定 `c921…`/`a5c5…`。见[本轮原始收据](../.cache/acceptance/native-driver-regression-19540a9b08ca4483b29ee00700ac149d/receipt.json)；不计为 UI 或实际官方推理。 |
| 当前正式生产界面八工具 | UUID `7062fb5c9adb44b4ae3863b24aa67ef9`，普通生产 EXE `4501…`，自动发现，无 QA hooks/发现上下文注入；实际确认配置、官方工具推理及六项文件写读证据全部 8/8，原偏好和输入字节保持，同轮 cleanup 通过、所属根不存在。见[独立复核](../artifacts/acceptance/production-ui-eight-current-independent-review-3d9f7f2d7c6c45468e0da8b2d3a995b6.json)。这是八条目标流程，不能替代生产程序完整 UI、厂商 GUI 默认模型/登录/历史。 |
| 当前官方 CLI 会话恢复 | 官方 CLI 会话恢复 UUID `ca25b82009db4a1bafb9e097a1cb9fcb` 全部 8/8：同一原生 profile/cwd/环境/配置、两个不同官方进程正常退出、精确 session ID 复用、首轮持久消息保留，第二提示不含首轮标识而新助手消息成功回忆。原读取器失败与修正后的新 UUID 分开保留；同轮进程退出和所属根清理通过。 见[官方会话恢复独立复核](../artifacts/acceptance/official-cli-history-current-independent-review-4ae67ce0a8f54f0facf8ca7e4e091cc4.json)。厂商 GUI 历史、活动交互会话和 AE 自动重启功能不由这项 CLI 测试证明。 |
| 当前生产运行四门 | UUID `693c49dbab1542579bf5aa5b6304c93e`，当前生产 EXE 的启动、二次唤醒和状态四门及原同轮清理通过。见[原运行收据](../artifacts/acceptance/desktop-runtime-693c49dbab1542579bf5aa5b6304c93e.json)和[独立复核](../artifacts/acceptance/production-runtime-current-independent-review-9899f148d3a741418b9a9492d7d0619e.json)。原 `5613…` 四门成功但清理失败保持，后续清理不升级原整轮结果。 |
| 当前进程观察 Record 回归 | 真实 Windows 父子进程执行原 wrapper recorder，63 检查通过、所属根已清理。见[独立收据](../artifacts/acceptance/native-process-observation-943bc8f4baf8471ababf3e3aac138da4.json)，绑定当前 wrapper hash；未启动官方客户端或 GUI，不代替八启动器的同轮实际观察。 |

| 当前程序 | SHA256 |
| --- | --- |
| Windows desktop | `4501ce519ea3a1781adf7251c47731f41ce750fd0c92c77c0080ac48c6b1902d` |
| Windows core CLI | `a2dc56463aa42c3b0ec50e037c27f72c99eb3e6be98c5f1c2a2516147f94a9ce` |
| Windows QA | `2f4b6977d1608ed54c74745a1b2d567bad585dc50d1280693afe47e93d9f217c` |

下表为前一修订历史证据。检查与三个程序构建绑定 audit `1af35a5f588d466da8c34377cc4eb5f3`，源码摘要 `d0450c47ba7e4b968a6bb593bbf72a27326e1b13b0d662cfcb738bacb58dfae3`。当次 checks/cross/build 均通过且前后源码摘要不变；Native44 使用该批次的 QA 程序。这些结果不覆盖后续盘符修复。

| 范围 | 结果与证据边界 |
| --- | --- |
| 前一修订 Windows Rust 全 features | 355 通过、0 失败、3 ignored；rustfmt、Clippy all features/all targets 警告视为错误通过。ignored 为两个被外层测试调用的辅助入口及一个旧独立重启 fixture，不证明官方客户端重启。 |
| 前一修订前端投影 | 原运行 26 文件、246 测试通过，原 TypeScript 与 Vite build 证据保留；154 个源码、配置、dist 文件逐一匹配当次构建。保留原 run `c106804bfb714512aba631c4fa284c08` 和原 audit `3d044fba620945de99a87d37d296ab25`，没有声称重新运行 246 项。 |
| 前一修订验收驱动回归 | 9 个文件、135 通过、0 失败；绑定精确选择、Node runner、TAP 和两个修正后的 live 文件 hash。没有完整九文件 run-start/run-end 快照；旧 130 项只保留历史。 |
| 原配置独立读回 | 历史 14/14 通过，含真实 Python parser；原日志没有当前修订的运行前后快照，不代替当前真实工具或 GUI 验收。 |
| 前一修订跨目标检查 | Linux/macOS core all targets、macOS production desktop 全 features cargo check 通过；未完成目标系统链接、原生 GUI 或官方客户端运行。 |
| Linux 实际 OS | 历史 Debian 13 的 304 library tests、11 核心 gates 通过；使用模拟供应商和 profile，不能证明当前修订、官方八客户端或 GUI。 |
| 前一修订 Windows 构建 | 当次 desktop/CLI/QA 三程序构建完成，不代替当前修订的程序或包审计。AE-only 包的同步、依赖和内容审计以其精确修订包收据为准。固定 WebView2 供 AE 界面使用；八客户端及其 Node、Python、PowerShell、Git 不随包发布。干净异机未验。 |

最新源码、程序 hash、前端运行和保留的小收据见[统一验证状态](../artifacts/acceptance/validation-status.json)和[当前发布摘要](../artifacts/acceptance/installed-client-release-summary-cb77bcd193cb4de89cb6295454597b74.json)。最终安装版目录名称复用原 `cb77…` 名称，刷新后的程序以当前 audit、源码摘要和 hash 为准，目录名称不证明仍为旧二进制。当前修订与历史修订 Native44 历史来源分别记录。

## 历史修订 Native44 历史结果

UUID `f49d3b282ba14e5780678544d17c7bd0`、QA PID `8528`，绑定前述 `d045…` 源码和 `1af35…` audit；19 个运行驱动 hash 与当次文件一致，wrapper 启动 hash 单独绑定。[独立审核](../artifacts/acceptance/installed-client-checks-1af35a5f588d466da8c34377cc4eb5f3/native44-independent-review.json)保留原三份报告 hash，原始报告不进入便携证据包。

| 范围 | 最终事实 |
| --- | --- |
| 实际模型查询 | 成功查询并选择 `deepseek-v4.1-flash`，获得 1 个实际模型条目。 |
| 原生 UI | 218 个检查点，0 pageErrors、0 branchFailures，原 UI `passed:true`。 |
| 完整首次接入 | Claude Code、Codex、Hermes Agent、oh-my-pi、OpenCode、Z Code、WorkBuddy CLI、DeepSeek Harness 全部 8/8，实际 probe 的 `ok`、`toolVerified` 和完整 UI flow 均为 true。 |
| 独立复验 | 同 UUID 下八工具 8/8，0 失败；没有用第二轮结果替换首次失败或混合历史运行。 |
| 托盘 | 同 QA PID/UUID 的 6/6 gates 通过。 |
| 原包装流程 | `passed:false`、`toolFlowPassed:false`；归属清理在 180 秒、8 次共享冲突重试后超时。原清理为 false，整轮结果没有升级为通过。 |
| 后续清理 | 条件变化后正常守卫清理成功；[新增清理事实](../artifacts/acceptance/installed-client-checks-1af35a5f588d466da8c34377cc4eb5f3/native44-cleanup-fact.json)和独立 `lstat` 确认精确 UUID 根已不存在。 |

受控接入成功证明当次所装版本、所选配置和测试入口能够实际推理。WorkBuddy CLI 使用显式 `--model`，不能证明官方桌面默认选择或不带该参数的默认行为。其他七工具的受控默认模型检查也不能证明任意终端、项目配置、插件或命令行覆盖值。

Native42 的初始 probe 7/8、完整 flow 5/8、复验 7/8；Native43 的初始 probe 6/8、完整 flow 5/8、复验 8/8 均保留为失败历史。其原三份报告和 wrapper 字节未改，后续清理事实独立记录。Native38 的私有 profile、223 个 UI 检查点仅为历史范围；Native39～44 均不能代替当前修订验收。

## 实现与尚缺范围

既有 profile 的发现、选择、配置事务、历史字节保护与真实工具接入曾在历史修订 Native44 通过；新整轮正在独立复验。官方 CLI 会话恢复 UUID `ca25b82009db4a1bafb9e097a1cb9fcb` 全部 8/8：同一原生 profile/cwd/环境/配置、两个不同官方进程正常退出、精确 session ID 复用、首轮持久消息保留，第二提示不含首轮标识而新助手消息成功回忆。原读取器失败与修正后的新 UUID 分开保留；同轮进程退出和所属根清理通过。 合成 parser fixtures 只验证读取器，真实恢复来自上述独立复核。历史未进入 AE 写集不等于厂商 GUI 历史可见或活动会话恢复。需要协议兼容网关时保持 AE 后台运行。DeepSeek Harness headless 需要任务，空启动明确拒绝，不重放上次任务。

WorkBuddy 桌面适配与干净 guest 内隔离实测正在进行，**尚无桌面默认选择、账号/GUI 推理、旧会话和重启的通过收据**。5.7.6 官方文件离线复核发现：legacy `main-content-core` 创建任务会清除下一任务选择；新 `home` 使用 `persistNewTaskModel=true` 并读取已保存选择，未发现同样的清除调用，不能概括为“每次新任务必清”。原厂 UI 实际点击可能触发选择持久化，仍需安全隔离 GUI 实测。候选 `switch-model` 协议可能修改当前活动旧会话的模型，不能直接用于安全默认选择。原生 `models.json` 的模型条目本身未证明能设定桌面默认值；未修改原客户端或 Chromium LevelDB。原研究见[研究安全摘要](../artifacts/acceptance/workbuddy-default-model-offline-path-summary-20261010.json)，本次[选择路径复核](../artifacts/acceptance/workbuddy-followup-research-2dbf900aafec4e42a427b476bca4a878/desktop-selection-followup.json)和[官方配置/API/存储复核](../artifacts/acceptance/workbuddy-followup-research-2dbf900aafec4e42a427b476bca4a878/official-default-api-storage-review.json)分别保留 SHA256 `8a6ce119…2473f` 和 `c84177b4…a58`。

本次复核搜索完整 renderer 的 1007 文件（其中 996 个 JavaScript 文件），与官方 archive 逐字核对 11 个关键文件。抽取原厂选择纯函数的 5/5 检查只证明离线选择优先级，不是 GUI 或推理验收。`preferences.defaultModelId` 可被原厂通用存储写入，但未找到新任务消费者，不能写入后宣称生效；未调用内部 API。原厂选择、连续任务及正常重启后的持久化仍待安全隔离实测。

Windows 安全重开已实现并通过隔离生命周期回归：精确绑定入口、profile、cwd、配置修订、PID 和创建时间；GUI 请求正常退出，CLI 等待正常退出后建立新会话，不强杀或重放命令。官方 CLI 正常退出后精确同会话恢复已验；AE 自动重开活动客户端及厂商 GUI 历史仍未验。Windows 自启使用进程本地 HKCU override 测试，真实登录未验；系统浏览器/Explorer 外开仍需真实系统验收。

剩余发布门还包括：原厂历史/活动会话界面、WorkBuddy GUI 默认选择与账户/推理、真实 Windows 登录自启和系统外开、干净异机、macOS/Linux 原生 GUI/官方客户端/系统功能、实际项目 GitHub 仓库与公开更新入口。目前只有 Windows 实机；cargo check 和同机新目录不能替代缺失环境。

## 清理与数据边界

Native42、Native43、Native44 的历史 owned 根正常守卫清理，原失败报告与后续清理事实分别保留。旧 Linux `5e128…` 的 owned VM 正常关机后也已守卫清理并独立确认缺失；新 Native 与干净 guest 根仍按各自运行收据登记。测试未修改用户 C 盘客户端配置，未停止未经证明属于测试的外部进程。

`.tools/agents` 与 `.tools/workbuddy` 曾在[历史安装清理收据](../artifacts/acceptance/official-test-installations-cleanup-20261010.json)对应代被移除：230527 个文件名、非遍历 unlink 45 junction，10,513,559,881 逻辑字节，未测物理释放字节。**两根现已恢复为 owner `62ce918dd9434342945cba63f7edd133` 的新测试安装代，当前仍实际存在，最终清理待本轮验收结束；旧收据不能证明新代已清理。** 构建工具单独保留，不能声称所有测试根已不存在。

清理安全修复只 unlink 普通文件；共享 ReadOnly 文件在两棵树删除前预检并拒绝；独立 ReadOnly 文件通过精确物理 handle/单链接身份验证，仅清除 ReadOnly 位，失败时恢复当前文件属性。4 个行为案例通过，独立审核通过；不是整树事务，也不声称全 metadata 保真。

仍有历史自动审批拒绝残留。新增微型句柄观察的 `fixtures` 精确清理和专用清理审计收据写入也被自动审批拒绝，仅返回 `blocked by policy`，没有更具体理由；动作未执行、未重试、未以删除父目录绕过。现存 5 文件、10,155,075 逻辑字节。HTML 测试根 `.cache/workbuddy-official-default-research-7b0f0a53cdf4499c9bd75456bef3c548` 清理也被拒绝，另有 2 文件、122,839 逻辑字节残留。因此 `allSandboxesRemoved:false`，不能声称全部沙盒已清理。已有原微型观察为 `.cache/tmp/g-owned-handle-surrogate-678b52c2460d447381b06e4453071464/surrogate-result.json`，SHA256 `90f1fc412aae99e253d062076b2938e0d5b782b26e6bf1357aa340fb4691fbb2`；没有复制或重写被拒的专用收据。KEEP/DISPOSE 均未出现 DELETE-open 错误，未证明清理锁因；app 和 wrapper 字节未因此修改。

限制令牌隔离支线的 `.cache/tmp/write-restricted-probe-743c2867d07d4930a72821571e6d6a85` 清理同样被自动审批拒绝，仅返回 `blocked by policy`。精确[第二轮报告](../artifacts/acceptance/windows-write-restricted-surrogate-743c2867d07d4930a72821571e6d6a85-baseline-path-fix.json)记录 7 文件、67,188 逻辑字节残留，命令和删除均未执行、未重试。这条支线在 `CreateWindowStation` 失败后停止，未启动官方 WorkBuddy；没有完成私有桌面、子孙进程、Electron/RPC/COM 和拒写验收，不能当作安全 GUI 隔离通过证据。

本次离线研究根 `.cache/workbuddy-gui-adaptation-2dbf900aafec4e42a427b476bca4a878` 已单次正常清理；[独立清理收据](../artifacts/acceptance/workbuddy-followup-research-2dbf900aafec4e42a427b476bca4a878/owned-research-cleanup.json)记录移除 1015 文件、309,330,404 逻辑字节，并独立确认精确根不存在。保留小型脱敏研究证据；未测量实际释放磁盘字节，未触碰上述被拒根。

历史 b350 批次公开打包路径 QA 的 fixture 报告清理完成且已独立确认根不存在；发布准备 fixture 报告清理完成，尚未独立检查根是否缺失。这两条历史清理边界以[脚本 QA 收据](../artifacts/acceptance/portable-build-path-qa-b350dca7b147490db92fcdb8f203d6c4/receipt.json)为准，不影响上述被拒残留或新测试安装代的状态。
