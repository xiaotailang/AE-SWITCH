# 平台支持与便携包

AE Switch 共用 Rust 内核和现代前端，各操作系统与 CPU 架构分别构建。Windows EXE 不在 macOS/Linux 直接运行；Windows 系统功能使用 Win32 API，其他平台需要对应实现。

正式发行只含 AE Switch、必要界面运行库、对应源码和许可，八客户端由用户自行安装。客户端、Node、Python、PowerShell、Git 及其依赖不随 AE 分发。Windows 包携带固定 WebView2，供 AE 自己的界面使用。

| 平台 | 已有证据 | 尚缺范围 |
| --- | --- | --- |
| Windows x64 | 当前 `c921…`/`a5c5…` Rust 362/0失败/3 ignored、Windows desktop/CLI/QA 构建通过；原前端 246/26 经99 source/63 dist hash投影，未重跑；当前 `f365…` ApplicationOnly搬移、Record63、新driver135/9通过 | 新 Native同轮UI/八工具/wrapper/托盘/清理仍待最终收据；WorkBuddy桌面、真实登录自启、活动历史GUI、系统外开、干净异机与全发布尚无通过收据 |
| Linux x64 | 当前 core 跨目标检查通过；旧 `5e128…` 的 Debian 13 core 313/11 与其旧修订、正常关机和清理单独保留 | 当前源码 core/library/生产 GUI 实际 OS 验收仍在执行；官方八客户端、真实推理和系统功能仍需独立证据 |
| macOS ARM64 | 当前 `c921…` core all targets与production desktop全features跨目标检查通过 | 链接、原生包、GUI、八工具、系统功能和迁移；Intel未验 |

当前 audit `c921…`、源码 `a5c5…`：Rust 三个测试入口合计 362 通过、0 失败、3 ignored，rustfmt、Clippy、跨目标检查及 Windows desktop/core/QA 构建通过。原前端 246 项仅按 99 source/63 dist 未变 hash 投影，本轮未重新执行。正式生产程序的八工具确认配置、真实推理、文件写读与同轮清理已全部通过；生产运行四门、AE-only 同机目录迁移和驱动回归 135 项也通过。官方 CLI 会话恢复已全部 8/8 通过并清理；全 Native UI/八工具复验和 Windows/Linux 来宾系统验收仍在完成，不能将历史 Linux 313/11 或旧二进制结果计入当前修订。 当前 checks/cross/build 绑定 audit `c9210f8ea42447e8a5d5a948704eb30f`、264 项 Windows 应用输入摘要 `a5c5eb2f65dfa451386b8d0d3513dbe5961d434ca6885e2cbfbb7ebc8cd69249`。来宾系统镜像及配置均由宿主 G 盘承载，未用 C 盘 WSL 或用户现有虚拟机作为可删除沙盒。

AE 本身的数据、缓存和临时文件保存在程序所在目录，不要求 G 盘或其他固定盘符；Windows 可使用任意可写的本地盘目录，包括 C 盘，既有客户端和 profile 可以在其他盘。G 盘仅是本工作区的测试沙盒限制，验收数据仍只写本机 G 盘。接入使用客户端原配置与历史环境：自动探测候选，多候选明确选择，也可手动指定。历史不复制、不迁移、不进入写集；只合并必要端点、认证和模型路由。测试没有修改用户 C 盘客户端配置。

既有profile配置事务、包外写入和八工具实际推理曾在历史Native44受控UI中通过；新 Native 整轮仍在验收；官方 CLI 精确同会话恢复和原始持久化历史读回已全部 8/8 通过并清理。厂商GUI历史、活动会话与任意终端覆盖值仍需各自证据，历史未进入AE写集不证明这些范围通过。需要协议兼容网关时保持AE后台运行。

Windows 自启证据来自进程本地 HKCU override，真实登录未验。既有客户端安全重开代码与隔离回归通过，官方活动进程仍未验；旧 Target 重启和 fake-client scopes 不代替该证据。GUI 请求正常退出，CLI 等待正常退出后以原 profile/cwd 新开会话；绑定 executable、PID、创建时间与配置修订，不泛杀 Node 或用户终端。macOS/Linux 当前提示手动重开，未宣称自动重启。

WorkBuddy 既有通过证据面向CLI且使用显式 `--model`；新桌面适配与guest内隔离实测正在进行，当前没有桌面默认选择、账户/GUI推理、历史或重启通过收据，CLI结果不替代这些范围。5.7.6 官方离线复核发现 legacy `main-content-core` 创建任务有清除选择的调用，新 `home` 则启用 `persistNewTaskModel=true`，未发现同样的清除调用。原厂 UI 点击可能保存选择，仍需安全隔离实测；`switch-model` 协议可能改变当前活动旧会话，不能据此声称已安全适配默认值。[原离线路径研究摘要](../artifacts/acceptance/workbuddy-default-model-offline-path-summary-20261010.json)保留原范围，[本次选择路径复核](../artifacts/acceptance/workbuddy-followup-research-2dbf900aafec4e42a427b476bca4a878/desktop-selection-followup.json)独立记录新发现。未修改原客户端或 LevelDB。

Native44原wrapper整轮失败保留，后续守卫清理只确认其UUID根已删。历史安装清理对应旧代；恢复后的 `.tools/agents` 与 `.tools/workbuddy` 新代当前实际存在，最后清理待本轮验收结束。旧 `5e128…` Linux owned VM 已正常关机并守卫清理；新 current-source VM 按新 owner 收据登记。历史拒绝残留、被拒的 5 个微型文件（10,155,075 逻辑字节）、前缀 `7b0…` 的 HTML 测试根（2 文件、122,839 逻辑字节）及 `743…` 限制令牌测试根（7 文件、67,188 逻辑字节）仍在，不能声称全部沙盒已清理。限制令牌测试未通过 GUI 隔离，未启动 WorkBuddy。微型观察没有证明清理锁因，app/wrapper 未因此修改。自动审批拒绝不重试、不删父目录绕过；当前源码仓库未绑定，公共发行尚未就绪。

Tauri 官方环境要求：https://v2.tauri.app/start/prerequisites/
