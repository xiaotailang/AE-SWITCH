# 2026-10-30 后续开发与验证

本轮从[原始会话复核](session-01a12a0a-review-2026-10-30.md)恢复需求，读取 Magpie 固定提交 `cdf8151a2e0c3c48191481272dbaee0c210e989a` 的源码，完成[18 类功能评估](magpie-review-2026-10-30.md)，并实施请求活动与用量观察。研究副本有 6,718 个受版本控制的文件、4,193 个 Go 文件，其中 2,907 个为 Go 测试文件；这些是源码清点，不是 Magpie 测试通过声明。

## 实际变更

- Rust：新增 `bridge/activity.rs` 和回归测试；五个 agent gateway 入口共用观察层，覆盖直通与现有转换路径；本地鉴权查询/清空；桌面 IPC 与只读 CLI 命令。
- 前端：连接页下方默认折叠“请求活动”，按客户端隔离查询；展示请求模型、HTTP 与响应生命周期、耗时、首包及已报告的 token；支持键盘进入滚动列表。
- 隐私：最近 200 条记录仅在网关内存保留，不新建用量数据库；不保存正文、工具参数、密钥、原始错误、URL 和用户目录；清空不取消任务，进行中的旧记录不会重新出现。
- 文档：修正 README 中“尚未公开发布”和把旧构建称为当前构建的过时表述；在线确认旧 reasoning 预发布存在，新功能交付与旧 tag 分开。
- 工具兼容：Rust 1.99 Clippy 对既有代码新增的两处提示已作等价修正，仅移除不必要借用并将测试中的 vec 改为数组。
- 发布审计：修复旧对应审计器将已排除的 RTK 数据库误列为应发布源码、遗漏根 `.gitignore` 的两处范围错误；同步打包器的数据库排除规则。增加独立收据目录与真实审计器的合成 RTK 数据库拒绝回归，不放宽包内开发历史禁入要求。

没有增加推理调用或独立模型任务，没有更换所选模型，没有新增 npm/Cargo 依赖。功能用法及数据口径见[请求活动说明](../app/docs/request-activity.md)。

## 已执行验证与证据范围

| 检查 | 结果 | 证明范围 |
| --- | --- | --- |
| Rust 全量、release、无桌面默认特性 | 库 403 通过，CLI 4 通过，0 失败；3 忽略 | 包括本地 HTTP、转换与新增活动逻辑；忽略项目仍未验收 |
| 前端全量 | 27 文件、293 项通过 | 连接流程与新组件回归 |
| 键盘修正后相关复验 | 2 文件、9 项通过 | 活动组件、键盘焦点及浏览器 IPC 禁用边界；不是再次全量运行 |
| TypeScript / 生产 UI | 通过 | 当前前端类型及正式构建 |
| Rustfmt / 全目标全特性 Clippy | 通过，`-D warnings` | 当前 Rust 格式与静态检查，不替代桌面运行 |
| desktop/core release 构建 | 通过 | Windows x64 的两个新程序，不含 QA 特性 |
| 浏览器界面 | 1200/390 宽度、深浅主题四状态均无横向溢出；活动区域 axe 0 违规 | 正式 dist + 模拟 IPC；已人工查看截图，不是原生 GUI 或真实上游验收 |
| 原生 CLI 本地 HTTP | 查询、认证、缺失服务失败、保持路由原文、不创建配置数据库通过 | 编译后的原生程序与本机合成 HTTP 服务，没有请求上游模型 |

Rust 首轮新增四项测试因测试夹具使用 `apiKey` 而不是内部 `api_key` 失败，修正后进行了上述全量复验。界面检查发现滚动列表缺少键盘焦点，修正后复验通过。原始失败与最终通过保持区分，没有把失败升级为成功。

生产输入清单：`artifacts/acceptance/development-20261030/source-inputs.json`，210 项，摘要 `6f679a6b2aace4af348f32ed09ebd07014038f12ebc752308b7f9e3feb392777`。这是本轮列出的源码、图标、公开资源和构建配置输入摘要，不声称涵盖编译器、操作系统或所有外部依赖。

## 本地交付和复核资料

- 便携目录：`artifacts/AE-Switch-portable-win-x64-20261030-request-activity/`。
- 便携 ZIP：`artifacts/AE-Switch-portable-win-x64-20261030-request-activity.zip`。
- 源码 ZIP：`artifacts/AE-Switch-source-20261030-request-activity.zip`。
- 源码/UI/二进制对应审计：`artifacts/acceptance/development-20261030/final-package-correspondence.json`。
- 包边界审计：同目录 `final-package-boundaries.json`；补充所有文件字节扫描：`privacy-audit.json`。
- 构建、Rust、Clippy、针对性前端复验日志与 JSON，四种截图、`visual-review.json` 和 `native-cli-smoke.json` 均在该验证目录。
- 最终 ZIP 的条目与字节复核见 `archive-verification.json`；最终文件哈希见 `SHA256SUMS.txt`。

以上打包与审计结果以实际 JSON 的 `passed` 字段为准，不由本文宣告代替。扫描针对指定输入中的已知密钥、私有端点和实际开发路径及编码变体，包含 EXE/DLL 原始字节；没有证明未知凭据、任意编码、图片文字或二进制压缩资源全部不存在。发布目录不包含原凭据文本、已使用的 data、开发数据库或 Magpie 研究 checkout。

## 当前边界

检测到原 AE Switch 正在运行，本轮没有停止、替换或附着该进程。没有重新执行官方八客户端的真实上游推理、文件写读及桌面默认模型/原历史闭环；本轮本地服务与模拟 IPC 不证明这些项目通过。`fullAcceptancePassed`、`realInferenceVerified`、`publicReady` 保持 `false`。

旧 `12eec71` reasoning 预发布仍是在线 main；本轮新功能为本地交付，没有自动上传 GitHub。试用新版前，应从托盘正常退出旧 AE，再完整解压新版启动。已有客户端仍由用户安装并完成登录。

测试临时目录、研究副本和解析中间文件仅按本轮明确归属清理；保留源码、构建工具/复用缓存、最终交付和必要验证资料，不触碰历史被拒绝清理的目录与原始会话。
