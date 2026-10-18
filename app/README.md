# AE Switch

以下命令从本 app 目录的上一级工作区根目录执行。

基于 **Rust + Tauri 2 + React + TypeScript + Vite + SQLite** 的端点配置工作台。Rust 内核负责密钥存储、模型查询、协议转换和原生配置事务；现代 Agent Hub 提供深浅主题与统一接入操作。

正式产品只分发 AE Switch 自身与其运行依赖。**Claude Code、Codex、Hermes Agent、oh-my-pi、OpenCode、Z Code、WorkBuddy、DeepSeek Harness 由用户自行安装**，不会随 AE 包发布，也不会修改这些客户端的程序文件。应用以发现并配置已有客户端和 profile 为目标，手动选择路径作为后备方式。

当前构建目标为 Windows x64。Windows、macOS、Linux 共用 Rust 内核与前端，仍需分别构建和在各目标系统验收，不能将 Windows 证据视为跨平台通过。详情见[平台支持](../docs/platform-support.md)。

版本：**0.1.0**。原项目及修改版遵循 [AGPL-3.0-only](LICENSE)。原署名、依赖许可及官方图标来源保留在 [NOTICE](NOTICE) 和 [第三方说明](THIRD_PARTY_NOTICES.md)。

## 接入流程

1. 下载便携 ZIP 并完整解压到任意可写的本地目录，双击 `Start-AE-Switch.cmd` 启动 AE；运行便携包不需要 Node.js、pnpm 或 Rust。需要使用的官方客户端由用户自行安装。AE 数据保存在程序目录下；既有客户端和 profile 可以位于其他盘。
2. 打开 `Start-AE-Switch.cmd`，在 Agent Hub 选择工具；核对自动发现的客户端和既有 profile。发现多个目录或无法确认时，选择客户端实际读取的目录和入口。
3. 输入供应商的 **API 端点** 和 **API Key**，等待实际模型查询，选择有权限使用的模型。
4. 确认配置。应用只合并所选连接、默认及受管辅助模型所需的端点、认证和协议字段；不能安全合并时保留原文件并报错。
5. 按界面结果核对 API 推理与实际工具验证，再让客户端重新加载配置。配置写入、API 可用、原工具可用和重启完成是独立结果。

当前构建 `1d89fd33…`（219 个生产输入）Rust 380 通过、0 失败、3 忽略，前端 271 项通过。七工具首次 7/7、独立复验 7/7，官方 CLI 同会话恢复 7/7，均绑定同一当前程序。WorkBuddy 当前修订桌面闭环按用户安排延期，托盘恢复因测试环境鼠标输入未执行而未验，完整验收和公开发布状态保持 `false`。

WorkBuddy 的 Windows 官方桌面入口现支持在已登录的空白新建任务页面，通过原生模型选择器自动应用所选默认模型。确认连接时会尝试应用；从「客户端操作」启动 WorkBuddy 后，会等待启动就绪并有界重试。正在查看已有任务、存在草稿、尚未登录或无法确认页面时保留待应用状态；准备好空白新建任务页面后，可点击「应用 WorkBuddy 默认模型」重试。已有会话保持原模型选择。首页默认选择、真实推理、文件工具和 CLI 验证分别报告，CLI 显式指定模型通过不能替代桌面证明。

历史、会话、数据库、MCP、插件、权限及其他偏好不属于接入写集，也不会复制或迁移到 AE 的私有 profile。只有在软件中明确编辑上下文等偏好时，才按对应功能修改。具体受管字段和冲突边界见[原生配置合并](../docs/native-agent-config-merges.md)。

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

**全部发布验收尚未通过，`fullAcceptancePassed:false`、`publicReady:false`。** 当前构建 `1d89fd33720f411d954203dab46de630`，源码摘要 `807949b45fa7c6299ce2dfe22ad9a4f06dc9b94e4b86d46074d7b756f9489ea2`，219 个生产输入。正式 desktop/core/QA 已实际构建，QA 不进入发行包；OMP 短目标名修复使用原 UUID 所属目录内的 `probe.txt`，原有精确内容、工具事件、进程退出和清理要求保持。

当前构建 `1d89fd33…`（219 个生产输入）Rust 380 通过、0 失败、3 忽略，前端 271 项通过。七工具首次 7/7、独立复验 7/7，官方 CLI 同会话恢复 7/7，均绑定同一当前程序。WorkBuddy 当前修订桌面闭环按用户安排延期，托盘恢复因测试环境鼠标输入未执行而未验，完整验收和公开发布状态保持 `false`。 OMP 单项首次和独立 probe 实际通过，两个 UUID 目标文件均为精确 49 字节标记，无换行、CR 或 BOM。受控长路径 I/O 对照复现 Bun 的 ENAMETOOLONG；在 UUID 目录内改用短文件名后，真实 OMP 双轮通过。原校验器误检查未选 Codex 的失败及原 aggregate=false 保留；专属作用域的离线校验通过，绑定同一不可变原始收据，没有再次请求模型。当前七工具 7/7 首次及 7/7 独立结果来自其后同包整轮实测，不由单项补测拼接。

清理按独立逐文件计量收据报告。当前单代测试运行时和构建缓存保留到验收结束后统一处理，登录、历史和用户工作区保留。被自动审批拒绝的旧候选包和初始 C 盘 RTK 日志保持保留，未重试或绕过。

WorkBuddy 按用户安排延期，当前 1d89 桌面任务与恢复不计通过。稳定手动安装的首次程序复制缺少完整的前后保护证明，保留为“该区间证据未证”。后来的只读程序核对期间，data/LocalLow 与配置哈希稳定，证明的是后一个观察区间；不倒推首次复制保护通过，也不据此断言数据曾被修改。

## 构建与打包

GitHub clone 或源码 ZIP 提供源码，须先准备 Node.js、pnpm 10.12.3、Rust 1.89 或更新版本及 Windows 对应的链接环境。本项目未提供源码一键安装或构建脚本。以下命令使用自己已安装的开发工具，从源码根目录运行：

```powershell
pnpm -C app install --frozen-lockfile
pnpm -C app run typecheck
pnpm -C app run build
cargo build --manifest-path app/src-tauri/Cargo.toml --release --no-default-features --features desktop,tauri/custom-protocol --bin ae-switch -j 1
cargo build --manifest-path app/src-tauri/Cargo.toml --release --no-default-features --bin ae-switch-cli -j 1
```

`scripts/workspace-env.ps1` 用于本工作区隔离构建，会将 `CARGO_HOME`、`RUSTUP_HOME` 等指向本地 `.tools/`，并把缓存和输出放入 `.cache/`。这些工具链未随源码分发；该脚本不是干净 clone 的工具链安装入口。Windows 桌面测试入口是 `scripts/test-rust-desktop.ps1`，它依赖已准备的隔离构建环境；`qa-webview` 仅用于验收。

制作完整便携包前，还需自行准备固定 WebView2 x64 运行时到 `.tools/webview2/`，保留其许可；确认 `WebView2Loader.dll` 位于已构建的桌面 EXE 旁。然后向打包脚本传入实际 EXE 路径：

```powershell
.\scripts\package-portable.ps1 `
  -ExecutablePath '<工作区内已构建的 ae-switch.exe>' `
  -CliExecutablePath '<工作区内已构建的 ae-switch-cli.exe>'
```

打包只收集 AE 程序、前端、必要运行依赖、对应源码、许可及脱敏证据。已有输出不合并用户数据；可加 `-CreateZip`。源码发布只取已审计源码 ZIP 的完整工作区结构，不上传本机整个工作目录。构建、打包不代替实际客户端验收。

## 本地发布准备

```powershell
. .\scripts\workspace-env.ps1
.\app\scripts\prepare-github-release.ps1 -CheckOnly
```

本地检查不上传 GitHub。目标按用户安排延期，不作为功能失败；当前源码仓库配置保持空值，完整验收及公开发布状态见[发布准备说明](docs/github-release.md)。

八客户端由用户自行安装，其本体分发不属于当前 AE 包范围。官方图标的来源和品牌归属仍保留；来源与字节一致不等于公开使用授权。包内证据入口见[验收导航](docs/portable-verification.md)。
