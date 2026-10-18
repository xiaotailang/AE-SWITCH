# AE Switch 发布准备

AE Switch 当前版本为 **0.1.0**，交付对象是 Windows x64 的完整便携目录。原项目 uni-switch v0.5.17 / v0.5.18 的发布、标签、安装器和更新测试属于上游历史，不是 AE Switch 的发行证据。当前 Tauri 关闭安装器打包；macOS/Linux 只有所记录的编译检查，尚无原生发行包和八工具运行验收。

## 当前可执行的本地流程

在工作区根目录运行：

```powershell
. .\scripts\workspace-env.ps1
.\app\scripts\prepare-github-release.ps1 `
  -PackageDirectory (Join-Path $PWD 'artifacts/AE-Switch-portable-win-x64-20261017-reviewed-1d89fd33') `
  -CheckOnly
.\app\scripts\qa-github-release.ps1
```

准备脚本核对 AE Switch 版本、Windows x64 平台、包内 WebView2 运行时入口、完整许可与源码入口、没有运行用 `data`，以及实际 GUI/core SHA256 与清单一致。它同时要求包中客户端清单为空，`tools/` 仅包含 AE 界面使用的 `webview2/`；八个官方客户端由用户自行安装。它不会运行客户端、安装依赖、读取测试密钥或访问 GitHub；既有全包凭据和源码审计仍以各自独立收据为准。不指定 `-PackageDirectory` 时，默认读取 `artifacts/AE-Switch-portable-win-x64`，不自动选择最新候选包。

不加 `-CheckOnly` 时，只在本工作区新建 `artifacts/release-preparation/<uuid>/`，保存 `preparation.json` 和四个根入口文件的 `SHA256SUMS.txt`。该校验文件覆盖 GUI、core、CMD 入口及包清单，不是完整便携目录的逐文件校验清单。不会覆盖已有目录，也不会创建完整便携 ZIP、源码 ZIP、发布标签或 Release。

指定另一个包可使用 `-PackageDirectory <工作区内的完整便携目录>`。路径必须位于工作区，不含目录跳转或已用 data；程序 hash、源码和许可入口须一致。本例指当前 `1d89fd33…`。包内 `source/ae-switch/` 是含 app、scripts、docs、tests、README 的完整工作区源码。

## 公共发行门

`localPackageChecksPassed:true` 仅说明上述具体检查通过。`publicReady` 由未完成项是否为空计算：仓库和源码摘要已绑定、完整系统及真实工具接入验证为布尔值 `true`、包审计通过，且 `remainingSystemScopes` 已明确记录为空数组，才能通过本地门。第三方来源与许可说明保留，不以额外的品牌批准字段代替功能验收。

当前包本地文件检查通过；完整验收及公开发布保持 false，因为 WorkBuddy 当前修订的桌面闭环按用户安排延期。最终外部包审计绑定文档同步后的不可变 manifest SHA；不在 manifest 中自引用审计文件 hash。本轮测试不要求打 ZIP、提交或发布。

1. `release-config.json` 的目标仓库按用户安排延期；不因此判功能失败，也不访问或写入 GitHub。以后确定真实目标后，再单独校验公开链接和更新入口。
2. 七工具、CLI 历史、系统/extra 和 WorkBuddy 桌面按各自实际范围报告；旧轮成功不替代当前修订。本轮不增加 C 盘、虚拟机、其他平台或独立机器要求。
3. 当前 AE 包不分发 Claude Code、WorkBuddy 或其他官方客户端，也不包含客户端账户和认证材料；本地测试安装不属于公开交付。AE 使用的依赖许可、客户端标识来源和品牌归属保留在 `app/THIRD_PARTY_NOTICES.md`；这些标识不表示厂商背书。
4. 对外上传前还须从最终已审核源码和二进制准备完整便携归档、对应源码归档、说明和精确校验文件，并绑定当前源码提交与公开仓库。当前脚本只提供本地准备检查；对外上传实现和公开 Release 尚未完成。

原有发布脚本曾硬编码 `uni-switch.exe`、NSIS 安装器和只含旧程序的便携 ZIP，无法代表当前只包含 AE、本身运行依赖和对应源码的包。当前入口只检查实际文件，不会把旧上游发布或模拟上传当作本修改版已发布。

## 本地回归

`qa-github-release.ps1` 使用 G 盘工作区中的小型 owned fixture，验证实际 hash 绑定、运行数据拒绝、缺失源码、错误版本/平台、工作区逃逸和目录跳转。完整且已绑定的合成元数据可通过本地门；未完成范围、缺失或无效验证状态、运行依赖不完整仍会阻断。fixture 在结束后按精确所有权标记清理；它不进行网络请求，不停止外部进程，合成正例也不证明真实客户端验收或公开发布成功。
