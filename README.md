# AE Switch

基于 Rust、Tauri 2、React、TypeScript 和 SQLite 的免安装端点配置工具。在同一页选择客户端，填写端点与 API Key，从实际查询的模型中选择，然后确认连接。

支持配置 Claude Code、Codex、Hermes Agent、oh-my-pi、OpenCode、Z Code、WorkBuddy 和 DeepSeek Harness。八个官方客户端由用户自行安装；AE 包只包含自身和必要运行依赖，不修改客户端程序文件。

已公开发布 [reasoning-compatibility 预发布](https://github.com/xiaotailang/AE-SWITCH/releases/tag/v0.1.0-reasoning-compatibility.1)，完整正式验收仍未完成。2026-10-30 本地开发新增“请求活动”：查看当前客户端经过 AE 的请求状态、耗时和响应报告的 token 用量，记录仅在内存中保留。见[本轮开发记录](docs/development-2026-10-30.md)与[当前验证记录](docs/current-validation.md)；旧构建的七工具及历史恢复成功不自动继承到新程序。

当前续作进一步提供模型搜索、收藏与最近使用、具名多客户端配置方案，以及字段级配置漂移检测和安全断开。详见[核心功能与本轮验证](docs/core-features-development-2026-10-30.md)。方案仅引用已保存连接；恢复记录属于私有数据，不能公开分享使用后的 `data/`。

日常界面以四步连接为主：搜索直接可用，收藏和最近使用收进“常用模型”，具名方案收进“高级功能”，请求活动默认收起。底层配置保护和方案恢复保留；新构建与真实接入复验单独记录在[常用流程精简与接入验证](docs/practical-core-development-2026-10-30.md)。

## 开始使用

使用程序时，下载便携 ZIP 并完整解压到任意可写的本地目录，双击 `Start-AE-Switch.cmd` 即可启动 AE，无需安装 Node.js、pnpm 或 Rust。对应官方客户端仍需用户自行安装。在页面上方选择客户端，完成四步：

1. **输入端点**：填写供应商提供的 API 地址。
2. **输入 API Key**：填写密钥，等待自动识别协议并查询模型。
3. **选择模型**：从端点实际返回的可用模型中选择。查询失败或列表为空时，修正输入后点击“同步模型”。
4. **确认连接**：依次保存连接、更新所选客户端的受管配置并验证。查看各阶段结果，让已打开的客户端重新加载配置。

客户端位置唯一且完整时自动沿用。发现多个目录、探测失败或没有安装时，页面会展开需要处理的位置；核对原配置目录和启动入口，必要时选择“手动指定已有客户端”。“已保存连接”可复用供应商；“仅保存”只保存连接，不配置客户端。

模型查询成功、配置写入成功、API 推理成功和实际工具写读成功分别报告。WorkBuddy 使用显式模型的 CLI 验证不能证明官方桌面默认选择，需在桌面客户端核对模型和实际任务。

## 后台、帮助与原有数据

客户端通过本地 Rust 网关连接上游时，需要保持 AE 在后台运行。关闭主窗口后驻留托盘，彻底退出后网关暂停。“快速上手”提供离线教程、自启设置、源码和许可入口；“客户端操作”提供重新验证、启动和符合条件时的安全重启。

AE 只合并接入所需的端点、认证和模型字段。历史、会话、数据库、MCP、插件、权限和其他偏好留在客户端原位置；无法安全合并时保留原文件并报错。上下文长度使用客户端自身的设置入口。OpenAI 兼容连接可在 AE 中选择思考程度：有明确等级清单时按清单显示，未提供清单时允许手动选择兼容档位，以端点响应为准；默认保留客户端原设置。详见[思考程度说明](docs/client-native-settings.md)；活动 profile、项目配置和命令行覆盖仍需核对，详见[配置合并边界](docs/native-agent-config-merges.md)。

安全重启须核实客户端入口、profile、工作目录、配置版本及进程身份；界面会区分配置已更新和客户端已重启。CLI 等待正常退出后重开，不强杀或重放上次任务。实际活动客户端及厂商 GUI 历史恢复的验收范围见验证记录。

## 便携目录

AE 使用完整目录运行，保留 EXE、启动脚本、UI、固定 WebView2、许可证、对应源码和验证资料。首次运行后，AE 的数据、缓存和临时文件位于程序旁的 `data/`；发布包不携带已使用的数据。

```text
AE-Switch-portable-win-x64/
  AE-Switch.exe
  AE-Switch-core.exe
  Start-AE-Switch.cmd
  ui/
  tools/webview2/
  data/                     首次运行后创建
  source/ae-switch/
  licenses/
  verification/
  package-manifest.json
```

产品不绑定盘符，可放在包括 C 盘在内的任意可写本地目录。既有客户端和 profile 可以位于其他盘；移动 AE 不会迁移客户端安装及历史。分享时使用新打包目录，不要分享已使用的 `data/`。包内不含八客户端及其 Node、Python、PowerShell 或 Git 环境。

Windows 优先自动发现原用户 `PATH`、已知安装位置，以及 ZCode、WorkBuddy 的系统安装记录；找不到时可只选择或输入一个安装目录，再由 AE 识别程序入口和原生配置，无需分别填写用户目录、配置目录和工作目录。指定目录只检查本目录及固定浅层位置，不全盘搜索；它不会被当作用户目录或配置目录。存在多个安装或 profile 时仍需选择目标。ZCode 桌面版的文件工具验证使用它随包提供的官方 CLI，打开客户端仍使用桌面入口。

本工作区的测试写入限定在 G 盘的隔离目录。Windows 同机测试不能证明干净异机或 macOS/Linux 原生运行，详见[平台支持](docs/platform-support.md)。

## 构建与发布资料

GitHub clone 和源码 ZIP 提供完整源码，不能直接当成已编译程序双击运行。源码构建需要 Node.js、pnpm 10.12.3、Rust 1.89 或更新版本，以及 Windows 对应的链接环境。先在源码根目录安装依赖并构建前端：

```powershell
. ./scripts/release-env.ps1
pnpm -C app install --frozen-lockfile
pnpm -C app run build
cargo build --manifest-path app/src-tauri/Cargo.toml --release --no-default-features --features desktop,tauri/custom-protocol --bin ae-switch -j 1
cargo build --manifest-path app/src-tauri/Cargo.toml --release --no-default-features --bin ae-switch-cli -j 1
```

本项目未提供源码一键安装或构建脚本。发布构建先加载 `scripts/release-env.ps1`：它复用 `scripts/workspace-env.ps1` 的 `.tools/`、`.cache/` 隔离目录和原有链接参数，并把编译产物中的本机源码路径映射为相对路径。每次重新加载 `workspace-env.ps1` 后，应在发布构建前再次加载 `release-env.ps1`。这些脚本不安装工具链；需先准备相应目录下可用的开发工具和依赖。

便携打包入口为 [package-portable.ps1](scripts/package-portable.ps1)，需先构建 desktop/core，并自行把固定 WebView2 x64 运行时放到 `.tools/webview2/`；`WebView2Loader.dll` 必须位于桌面 EXE 旁。打包会拒绝仍包含当前构建目录路径的 desktop/core 输入。完整步骤见 [app/README](app/README.md)。源码发布只取已审计的源码 ZIP 内容，不上传含本机缓存、安装树或私密输入的整个工作目录。

版本 **0.1.0**，许可 [AGPL-3.0-only](app/LICENSE)。原署名、依赖许可及标识来源保留在 [NOTICE](app/NOTICE) 与[第三方说明](app/THIRD_PARTY_NOTICES.md)。开发路径隐私重编及 Windows 安装自动发现分别按其构建记录核对，历史构建 `1d89fd33…` 的客户端验收不自动算作新二进制的验收结果；GitHub 继续按预发布提供。见[发布准备说明](app/docs/github-release.md)和[包内验收导航](app/docs/portable-verification.md)。
