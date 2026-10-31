# 核心功能验收方案与证据边界

初轮验收使用 `gpt-6.1-sol / ultra`，保留端点不支持及官方客户端失败的原始记录。用户随后明确授权把 **AE 接入的隔离测试客户端** 设为 `xhigh`，并明确要求不修改本机 Codex 配置；后续新 owner 的真实接入验收采用该授权值。本机 Codex 的配置、认证文件和当前会话选择均不由测试改动，原文件持续只读与哈希核对。供应商缺少所选模型、查询超时、鉴权失败或官方客户端失败均照实记录，不自动换模型或强度。所有主动生成的构建、缓存、浏览器 profile、子进程临时数据和证据都使用当前 G: 项目路径。该存储检查不能证明 Windows、输入法、杀毒软件、驱动和外部服务没有自身的系统盘写入。

## 可执行顺序

所有命令从项目根目录通过项目已有 `.tools/pwsh/pwsh.exe -NoProfile` 运行，先加载 `scripts/workspace-env.ps1`。如果外层还使用 RTK，须在调用 RTK 之前就将 `RTK_DB_PATH`、`RTK_TEE_DIR`、`RTK_AUDIT_DIR` 指向当前项目的 `.cache/rtk`，不能等其子 shell 才配置。

| 阶段 | 检查 | 通过标准 |
| --- | --- | --- |
| 存储隔离 | `tests/acceptance/verify-g-only-environment.ps1` | 32 项环境路径位于当前 G: 项目，祖先无 reparse；真实 Node/Python/PowerShell 子进程逐值继承，实际 sentinel 写入 G: TEMP |
| 前端 | TypeScript、Vitest 全量、Vite 生产构建 | 本轮源码对应的检查通过；模型收藏/搜索、具名配置、漂移状态/恢复入口和请求活动的状态与错误路径都覆盖 |
| 后端 | Rust 全量、desktop 三测试 harness、rustfmt、Clippy | 使用本轮最终源码；忽略项逐项保留，不升级为已通过 |
| 原生核心 | `isolated-core-agents.mjs` | 生产 core 与构建/源码指纹相同，真实发现模型后以显式模型/强度保存，八客户端 `configure-profile` / `probe-profile` 的 tool 写读与清理证据全部通过 |
| 生产桌面 | 既有 `verify-production-ui-eight.ps1` 与 UI/system/tray 模块 | 生产 EXE、真实 IPC/发现/保存/配置/启动/工具写读、新功能 GUI 操作均由当前构建证明 |
| 包与隐私 | `final-package-audit.mjs`、`audit-private-artifacts.py` | 源码与二进制对应，排除私有输入/数据库/profile/研究目录；已知 key/端点/开发路径与编码变体在目录、EXE/DLL 和 ZIP 解压成员中零命中 |

## 最终构建的规范收据

本轮收据生成器为 `scripts/verify-core-features.ps1`。指定全新 32 位 owner ID 和 `.cache/release-audit-ui-<32hex>/`，依次执行 `-Phase checks` 和 `-Phase build`，不能复用旧版检查结果。脚本加载 `scripts/release-env.ps1` 保留源码路径映射，构建前后比较完整生产输入清单及字节哈希，分别构建正式 desktop/core；生产包不含 QA 程序。最终通过的审计 ID 为 `64ccdd27024145f1af6c9b745bb0f97c`。

`prepare-production-ui-eight.ps1` 要求同一个新目录里的 `build-receipt.json`、`build-source-after.json`、`build-release-audit-outputs.json` 和 `.ae-release-audit-owner.json`，并重新核对完整当前源码清单、哈希、构建命令和包内生产程序。测试日志与收据不等于外部真实服务或官方 GUI 验收。

可复用的官方客户端只读程序清单是 `.cache/tmp/review-official-installations-20261017.json`。本轮只读检查其 16 个输入全部存在；准备工具仍会验证实际普通路径、全部客户端程序、解释器、入口和 parser 字节。客户端版本来自该清单，不能把程序存在升级为当前版本兼容通过。

## 无需停止旧 AE 的原生核心验收

使用全新 owner id 调用现有准备器，它只复制本轮生产包并创建 G: 内的新 profile，不启动桌面。示例中的审核目录和包目录必须替换为本轮最终路径。

```powershell
. .\scripts\workspace-env.ps1
$coreOwnerId = [Guid]::NewGuid().ToString('N')
& .\.tools\pwsh\pwsh.exe -NoProfile -File .\tests\acceptance\prepare-production-ui-eight.ps1 `
  -OwnerId $coreOwnerId -AuditDirectory $currentBuildAudit -PackageDirectory $currentPackage `
  -CredentialsFile (Join-Path $env:AE_WORKSPACE '端点测试用.txt') `
  -InstallationsManifest (Join-Path $env:AE_WORKSPACE '.cache/tmp/review-official-installations-20261017.json') `
  -UseNativeCodexEntry
& .\.tools\node\node.exe .\tests\acceptance\isolated-core-agents.mjs `
  --setup (Join-Path $env:AE_WORKSPACE ".cache/native-e2e-sandbox/$coreOwnerId/setup.json") `
  --model gpt-6.1-sol --reasoning-effort xhigh
```

该 runner 不启动桌面、不接入旧 AE、不删除数据、不用产品 QA/discovery hook。真实上游错误保留到先脱敏后落盘的收据。保留的 sandbox 包含实际私有输入和新 profile，只能按同一 owner id、进程退出与普通路径证明单独清理；不能打包或上传。超时时只终止自己持有的 core 进程对象，保留 sandbox 供独立检查客户端后代，不使用全树终止或按进程名停止。

生产桌面有当前 Windows 会话共享的固定 single-instance 标识；不同 UUID 目录不会隔离该 mutex。旧 AE 正在运行时不能把新进程唤醒旧窗口算作新版通过，不能静默停止旧进程。完整桌面验收需要用户从托盘正常退出旧 AE 后，用另一个全新 owner id 重新准备并运行生产 GUI supervisor。

## 隐私与交付审计

`tests/acceptance/audit-private-artifacts.py` 接收一个或多个明确私有输入文件与扫描目录/ZIP。私有值仅留内存用于匹配，报告只输出类别、路径、哈希、字节数与统计。扫描包含 UTF-8、UTF-16LE/BE、JSON/Unicode/slash/URL/Base64 变体；ZIP 成员在内存流中解压扫描，不落地。图像文字、未知秘密、任意编码及 EXE 内部其它压缩格式仍需独立审查。只有 ZIP 成员扫描不能代表图像 OCR 已通过。

```powershell
. .\scripts\workspace-env.ps1
& .\.tools\python\cpython-3.14.6-windows-x86_64-none\python.exe -B `
  .\tests\acceptance\audit-private-artifacts.py `
  --private-input .\端点测试用.txt --scan $currentPackage --scan $currentPortableZip `
  --report $freshPrivacyReceipt
```

截图必须先遮罩 API Key、端点、密码、历史内容和任何私有标识，再逐张人工复核。禁止保留原始网络抓包、trace 或 HAR 到公开交付目录；私人调试日志仅 G: 私有 sandbox 可见，保留公开证据时先脱敏，再进行已知值扫描。源码包排除实际 `data`、`.cache`、`.tools`、端点输入、`.env`、数据库、日志和客户端原始 profile。

## 本轮已有独立证据

- `artifacts/acceptance/storage-boundaries-9587dcb75b2a481ab7a707f65ab46f0f.json`：最终审计脚本与 environment 脚本哈希绑定的 32 路径 / 3 子进程通过。
- `artifacts/acceptance/core-features-20261030/private-endpoint-preflight.json`：最后明确指定的供应商只查询一次，8.011 秒 DNS 超时；TCP/TLS/HTTP 未建立，模型是否列出未知，effort metadata 未知，推理请求 0。
- `artifacts/acceptance/core-features-20261030/private-core-discovery-preflight.json`：另一条产品网络观察路径使用已有生产 core 的真实供应商发现逻辑；8 个常见代理变量均未配置，6.349 秒以产品 `network` 错误退出。该旧编译产物只作网络观察，不作为本轮版本验收，也不替代最终 candidate 的实际查询。私有 stdout/stderr 只记字节数和哈希，不保留原文。
- `artifacts/acceptance/core-features-20261030/privacy-self-test.json`：纯合成输入的 clean pass 与 Base64 key / UTF16 endpoint / ZIP 成员 leak fail 均符合预期，不使用真实凭据。
- `artifacts/acceptance/core-features-20261030/rtk-c-residue-inventory.json`：只读记录本轮明确归属的 20 个新 RTK tee 日志名称、UTC 时间、字节数和 SHA256；没有删除。旧 `history.db` 保留，不能按时间推断整个数据库可删。历史被拒绝目录不在清理范围。
- `artifacts/acceptance/core-features-20261030/package-negative-runtime-names-anywhere/`：实际包审计器拒绝放在普通包根子目录中的 6 类 ownership/profile/journal 文件，以及源码中的合成 RTK 数据库；这种摆放刻意避开 `data` 和源码目录的排除规则，确认 basename 规则独立生效。首次对完整旧交付目录的相同负例运行在 120 秒预算内未完成，保留失败，不作为通过证据；随后使用明确合成的最小包完成规则检查。
- `artifacts/acceptance/core-features-20261030/new-acceptance-source-privacy.json`：新增五个验证脚本的已知私有值扫描零命中，覆盖 48,530 字节。
- `artifacts/acceptance/core-features-20261030/audit-owned-disposable-inventory.json`：列出本审计创建的 15 个确切 G: sentinel 文件与 3 个确切临时根目录，其中网络 preflight 根含真实私有输入，须在进程退出与路径证明后按 owner 清理。没有删除既有用户数据。

上面的收据不替代最终新增功能、当前包、真实官方客户端或生产桌面的最终验收。`fullAcceptancePassed`、`publicReady` 只有其完整验收范围通过才可更新。

## 当前候选的补充验收与归档

`verify-production-ui-eight.ps1 -CoreFeaturesOnly` 是单独的无推理验收路径：在全新、明确 owner 的生产程序沙盒中真实查询模型、保存供应商、配置八个准确的原生 profile 并独立回读，再通过生产 WebView 的真实 IPC 检查方案、配置保护、模型偏好和临时断开恢复。此路径不启动八客户端、不调用 `probe_agent`，要求所有网关活动为空；它与官方客户端真实工具验收分别记账，成功也不改变 `fullAcceptancePassed: false`。默认八客户端验收不启用这个开关，两个路径不能在同一 owner 上互相冒充。

最终归档使用 `scripts/archive-core-features.py`。先完成文档和验证摘要同步，用 `--freeze` 在全新报告目录冻结完整包文件集合、大小和 SHA256，再执行包对应关系、目录边界和已知私有值三项审计，最后不带 `--freeze` 执行归档。归档要求当前文件与冻结清单、隐私审计的完整原始文件清单完全一致；读取压缩时逐文件核对，ZIP 完成后逐成员复验，随后再次检查包与审计报告未变。六个合成正常/负例通过，包含审计后或压缩期间改动的拒绝。该机制依赖可信的本地审计报告，不替代真实客户端验收。
