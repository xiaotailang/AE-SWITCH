# AE Switch

## 当前 Windows 构建（2026-10-11）

当前 canonical 包为 `artifacts/AE-Switch-portable-win-x64`，是完整的免安装便携目录：包含 `AE-Switch.exe`、CLI、UI、固定 WebView2、启动脚本、许可证、源码和脱敏验收证据；不要求安装 AE Switch，也不是单个可脱离目录运行的裸 EXE。八个官方客户端由用户自行安装，包内不携带客户端本体。

本轮构建绑定 audit `22312f6761aa4615b14a09a3f2429606`、源码 `5d3b27896895e0111525247c0f8ed860a3b14f64fa47658c8807ed25540ac8be`，desktop/core/QA SHA256 为 `b7c4e53e7986e72b34d685f6e9b8281dbee407048d9f0bb8e577fec9163a9bf5`、`898380d0e0ef0c4c17ebfa2d320b1cd62a7a32fb2605dcc2adf638eb78fae494`、`eada8c9cc09c94465fae4885b7d614c845e6df6ba1c97aaae25468c53520b866`。Rust 362 项通过、0 失败、3 ignored；包对应/边界/Win32、生产运行、CLI smoke 和 AE-only G 盘迁移通过。

新 QA Native 轮次的实际 UI 和 8+8 工具写读通过，但同轮托盘驱动在 Windows Shell `MoveTrayCursor`/溢出恢复处失败，因此 `fullAcceptance:false`、`publicReady:false`。WorkBuddy 官方桌面 GUI 仍需真实账户登录后验证默认模型、两次任务和历史恢复；显式模型 CLI 通过不替代这些 GUI 门。详见 [`docs/current-validation.md`](docs/current-validation.md) 与 `artifacts/acceptance/validation-status.json`。
基于 **Rust + Tauri 2 + React + TypeScript + Vite + SQLite** 的端点配置工作台。Rust 内核负责密钥存储、模型查询、协议转换和原生配置事务；现代 Agent Hub 提供深浅主题与统一接入操作。

正式产品只分发 AE Switch 自身与其运行依赖。**Claude Code、Codex、Hermes Agent、oh-my-pi、OpenCode、Z Code、WorkBuddy、DeepSeek Harness 由用户自行安装**，不会随 AE 包发布，也不会修改这些客户端的程序文件。应用以发现并配置已有客户端和 profile 为目标，手动选择路径作为后备方式。

当前构建目标为 Windows x64。Windows、macOS、Linux 共用 Rust 内核与前端，仍需分别构建和在各目标系统验收，不能将 Windows 证据视为跨平台通过。详情见[平台支持](docs/platform-support.md)。

版本：**0.1.0**。原项目及修改版遵循 [AGPL-3.0-only](app/LICENSE)。原署名、依赖许可及官方图标来源保留在 [NOTICE](app/NOTICE) 和 [第三方说明](app/THIRD_PARTY_NOTICES.md)。

## 接入流程

1. 将完整 AE 便携目录放在任意可写的本地目录，包括 C 盘，先安装需要使用的官方客户端。AE 数据保存在程序目录下，不要求特定盘符；既有客户端和 profile 可以位于其他盘。
2. 打开 `Start-AE-Switch.cmd`，在 Agent Hub 选择工具；核对自动发现的客户端和既有 profile。发现多个目录或无法确认时，选择客户端实际读取的目录和入口。
3. 输入供应商的 **API 端点** 和 **API Key**，等待实际模型查询，选择有权限使用的模型。
4. 确认配置。应用只合并所选连接、默认及受管辅助模型所需的端点、认证和协议字段；不能安全合并时保留原文件并报错。
5. 按界面结果核对 API 推理与实际工具验证，再让客户端重新加载配置。配置写入、API 可用、原工具可用和重启完成是独立结果。

正式程序的八工具确认配置、真实推理、文件写读，以及官方 CLI 会话恢复均已通过。最终 Native 整轮和来宾系统验收仍在完成，全部发布验收尚未通过；具体数字与证据见下方验收状态及[验证记录](docs/current-validation.md)。

WorkBuddy 当前适配面向命令行入口，验证时显式指定模型；官方桌面 GUI 的默认模型选择尚未适配，不能宣称已完成桌面版一键接入。

历史、会话、数据库、MCP、插件、权限及其他偏好不属于接入写集，也不会复制或迁移到 AE 的私有 profile。只有在软件中明确编辑上下文等偏好时，才按对应功能修改。具体受管字段和冲突边界见[原生配置合并](docs/native-agent-config-merges.md)。

原工具读取自定义端点不代表其任意插件、项目配置或命令行覆盖也会使用同一连接。活动 profile 与有效配置需要核对。Claude Code 首次交互使用新 API Key 时可能有官方确认提示；AE 不修改其审批或登录历史。

Agent Hub 使用受认证的本地 Rust 网关。供应商 Key 保存在 AE 的本地数据中，客户端持久配置使用网关令牌；使用这些配置时须保持 AE 在后台运行。窗口关闭后驻留托盘，彻底退出后网关暂停。模型列表查询成功不能代替实际推理验证。

## 便携目录与数据边界

```text
AE-Switch-portable-win-x64/
  AE-Switch.exe              Rust 桌面应用
  AE-Switch-core.exe         Rust CLI（指定 CLI 构建时包含）
  Start-AE-Switch.cmd         启动入口
  ui/                        前端与离线教程
  tools/webview2/            AE 界面使用的固定 WebView2（已准备时包含）
  data/                      AE 本身的数据、缓存、临时文件和 WebView 数据
  source/ae-switch/           对应修改版源码与构建资料
  licenses/                  应用与依赖许可
  verification/              脱敏验证证据
  使用说明.txt
  package-manifest.json
```

包内不包含八客户端及其 Node、Python、PowerShell 或 Git 运行环境。官方客户端应使用各自安装方式和原有依赖。AE 的数据留在程序旁，客户端的既有配置和历史保持原位置；应用目录与客户端目录可以分属不同盘。

本工作区的安装、配置和运行测试全部限定在 **G 盘 owned UUID 沙盒**。不写用户 C 盘配置，也不停止已有外部客户端。只删除本轮已核对所有权和目录边界的测试根；历史被拒绝的清理动作保留原记录，不重试或以删父目录绕过。包本身与原客户端的异机运行仍需单独验证。

分享程序应使用打包脚本生成的新目录，**不要分享已使用的 `data/`**。打包脚本不读取 `端点测试用.txt`，也不复制真实凭据、已使用 profile 或测试客户端。移动 AE 后应检查本地网关连接和原客户端配置；原客户端的安装及 profile 路径不会随 AE 自动迁移。

## 验收状态

**全部发布验收尚未通过，`fullAcceptancePassed:false`、`publicReady:false`。** 历史修订 Native44 查询到真实模型，原生 UI 218 个检查点、0错误/失败分支，八工具完整首次接入与独立复验均 8/8，托盘 6/6；全部绑定当次 UUID 和 QA 程序，不代替当前盘符修复后的接入验收。WorkBuddy 的结果是显式指定模型的 CLI 推理，不能替代桌面默认选择。

当前 audit `c921…`、源码 `a5c5…`：Rust 三个测试入口合计 362 通过、0 失败、3 ignored，rustfmt、Clippy、跨目标检查及 Windows desktop/core/QA 构建通过。原前端 246 项仅按 99 source/63 dist 未变 hash 投影，本轮未重新执行。正式生产程序的八工具确认配置、真实推理、文件写读与同轮清理已全部通过；生产运行四门、AE-only 同机目录迁移和驱动回归 135 项也通过。官方 CLI 会话恢复已全部 8/8 通过并清理；全 Native UI/八工具复验和 Windows/Linux 来宾系统验收仍在完成，不能将历史 Linux 313/11 或旧二进制结果计入当前修订。 历史 `b350…` 的打包路径和发布准备脚本 QA 52/52、39/39 保留为旧轮证据。

历史 Native44 wrapper 的清理超时失败与后续精确根清理分别保留。当前正式八工具测试、运行四门和同机迁移的所属根均已清理。`.tools/agents` 与 `.tools/workbuddy` 是恢复后的新测试安装代，最终清理待所有官方工具测试结束；Windows/Linux 来宾系统按各自 owner 收据登记。历史被拒根保持原状，旧安装清理不能证明新代已清理。

仍需完成原厂活动客户端重开/历史界面、WorkBuddy GUI 默认选择及账户/推理、真实 Windows 登录自启、系统浏览器/目录外开、干净异机、macOS/Linux 原生界面与客户端、项目 GitHub 仓库和公开更新入口。历史审批拒绝残留、5 文件且 10,155,075 逻辑字节的被拒微型 fixture、前缀 `7b0…` 的 HTML 测试根（2 文件、122,839 逻辑字节），以及 `743…` 限制令牌测试根（7 文件、67,188 逻辑字节）仍在，因此没有声称全部沙盒已清理；清理锁因未证明，app/wrapper 未因此修改。

## 构建与打包

先从工作区根目录加载环境，使依赖、缓存、临时文件和编译输出留在本目录：

```powershell
. .\scripts\workspace-env.ps1
node app/node_modules/typescript/bin/tsc --noEmit --project app/tsconfig.json
node app/node_modules/vitest/vitest.mjs run --root app
Push-Location app
node node_modules/vite/bin/vite.js build
Pop-Location
```

Rust 使用 `app/src-tauri/Cargo.toml`，要求 Rust 1.89 或更新版本及目标平台链接环境。Windows GNU 桌面测试入口是 `scripts/test-rust-desktop.ps1`；`qa-webview` 仅用于桌面调试验收。

```powershell
cargo build --manifest-path app/src-tauri/Cargo.toml --release --features tauri/custom-protocol --bin ae-switch -j 1
cargo build --manifest-path app/src-tauri/Cargo.toml --release --no-default-features --bin ae-switch-cli -j 1
.\scripts\package-portable.ps1 `
  -ExecutablePath '<本目录下已构建的 ae-switch.exe>' `
  -CliExecutablePath '<本目录下已构建的 ae-switch-cli.exe>'
```

打包只收集 AE 程序、前端、所需运行库、对应源码、许可及脱敏证据。已存在输出时创建新目录，不合并使用数据；可加 `-CreateZip`。缺失依赖、包内容检查和运行前提以 manifest 及本轮打包收据为准，打包不执行真实推理，也不能证明异机开箱即用。

## 本地发布准备

```powershell
. .\scripts\workspace-env.ps1
.\app\scripts\prepare-github-release.ps1 -CheckOnly
```

本地检查不上传 GitHub。公共门未满足时 `-RequirePublicReady` 拒绝；流程见[发布准备说明](app/docs/github-release.md)。本修改版仓库已在 `app/release-config.json` 绑定 `dieqiyun/uni-switch`；公开更新入口仍需实际验收。

八客户端由用户自行安装，其本体分发不属于当前 AE 包范围。官方图标的来源和品牌归属仍保留；来源与字节一致不等于公开使用授权。包内证据入口见[验收导航](app/docs/portable-verification.md)。
