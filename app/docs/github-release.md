# AE Switch 发布准备

AE Switch 当前版本为 **0.1.0**，交付对象是 Windows x64 的完整便携目录。原项目 uni-switch v0.5.17 / v0.5.18 的发布、标签、安装器和更新测试属于上游历史，不是 AE Switch 的发行证据。当前 Tauri 关闭安装器打包；macOS/Linux 只有所记录的编译检查，尚无原生发行包和八工具运行验收。

本次候选 `4cd78736f9ea495e992e1d6681985a11` 为开发路径隐私重编。新构建、源码/二进制敏感信息审计、归档和解压启动检查按新收据分别报告；历史 `1d89` 七工具及同会话恢复证据保留为旧构建结果，不作为本次二进制 E2E 通过证明。本轮不重新请求上游模型。

## 当前可执行的本地流程

在工作区根目录运行：

```powershell
. .\scripts\workspace-env.ps1
.\app\scripts\prepare-github-release.ps1 `
  -PackageDirectory (Join-Path $PWD 'artifacts/AE-Switch-portable-win-x64-20261018-path-privacy-4cd78736') `
  -CheckOnly
.\app\scripts\qa-github-release.ps1
```

准备脚本核对 AE Switch 版本、Windows x64 平台、包内 WebView2 运行时入口、完整许可与源码入口、没有运行用 `data`，以及实际 GUI/core SHA256 与清单一致。它同时要求包中客户端清单为空，`tools/` 仅包含 AE 界面使用的 `webview2/`；八个官方客户端由用户自行安装。它不会运行客户端、安装依赖、读取测试密钥或访问 GitHub；既有全包凭据和源码审计仍以各自独立收据为准。不指定 `-PackageDirectory` 时，默认读取 `artifacts/AE-Switch-portable-win-x64`，不自动选择最新候选包。

不加 `-CheckOnly` 时，只在本工作区新建 `artifacts/release-preparation/<uuid>/`，保存 `preparation.json` 和四个根入口文件的 `SHA256SUMS.txt`。该校验文件覆盖 GUI、core、CMD 入口及包清单，不是完整便携目录的逐文件校验清单。不会覆盖已有目录，也不会创建完整便携 ZIP、源码 ZIP、发布标签或 Release。

指定另一个包可使用 `-PackageDirectory <工作区内的完整便携目录>`。路径必须位于工作区，不含目录跳转或已用 data；程序 hash、源码和许可入口须一致。本例指本次路径隐私候选，目录须实际生成后才能检查。包内 `source/ae-switch/` 是含 app、scripts、docs、tests、README 的完整工作区源码。

## 公共发行门

`localPackageChecksPassed:true` 仅说明上述具体检查通过。`publicReady` 由未完成项是否为空计算：仓库和源码摘要已绑定、完整系统及真实工具接入验证为布尔值 `true`、包审计通过，且 `remainingSystemScopes` 已明确记录为空数组，才能通过本地门。第三方来源与许可说明保留，不以额外的品牌批准字段代替功能验收。

旧包本地文件检查及七工具记录属于 `1d89`。本次候选的新包检查状态在实际完成前保持未验证，完整验收仍未完成。最终外部包审计绑定文档同步后的不可变 manifest SHA，不在 manifest 中自引用审计文件 hash。GitHub 已有源码和预发布资产，本次按用户要求更新前须重新生成并核对两份 ZIP 及其校验和。

1. 目标仓库为 `xiaotailang/AE-SWITCH`。更新时须核对实际远程提交、现有标签和 Release 资产，保留历史提交；不能直接重跑只支持首次空仓库发布的旧助手。
2. 七工具、CLI 历史、系统/extra 和 WorkBuddy 桌面按各自实际范围报告；旧轮成功不替代当前修订。本轮不增加 C 盘、虚拟机、其他平台或独立机器要求。
3. 当前 AE 包不分发 Claude Code、WorkBuddy 或其他官方客户端，也不包含客户端账户和认证材料；本地测试安装不属于公开交付。AE 使用的依赖许可、客户端标识来源和品牌归属保留在 `app/THIRD_PARTY_NOTICES.md`；这些标识不表示厂商背书。
4. 对外上传前须从最终已审核源码和二进制准备完整便携归档、对应源码归档、说明和精确校验文件，并绑定当前源码提交与公开仓库。本文的 `prepare-github-release.ps1` / `publish-github-release.ps1` 入口仍只提供本地检查，实际远程更新应使用已核对新资产和远程基线的发布流程；本地检查通过不代表上传完成。

原有发布脚本曾硬编码 `uni-switch.exe`、NSIS 安装器和只含旧程序的便携 ZIP，无法代表当前只包含 AE、本身运行依赖和对应源码的包。当前入口只检查实际文件，不会把旧上游发布或模拟上传当作本修改版已发布。

## 本地回归

`qa-github-release.ps1` 使用 G 盘工作区中的小型 owned fixture，验证实际 hash 绑定、运行数据拒绝、缺失源码、错误版本/平台、工作区逃逸和目录跳转。完整且已绑定的合成元数据可通过本地门；未完成范围、缺失或无效验证状态、运行依赖不完整仍会阻断。fixture 在结束后按精确所有权标记清理；它不进行网络请求，不停止外部进程，合成正例也不证明真实客户端验收或公开发布成功。
