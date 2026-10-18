[CmdletBinding()]
param(
    [string]$PackageDirectory,
    [string]$OutputDirectory,
    [switch]$CheckOnly,
    [switch]$RequirePublicReady
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$releaseWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$releaseApp = Join-Path $releaseWorkspace 'app'

function Assert-ReleaseOwnedPath([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($releaseWorkspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw '发布准备只能读取或写入当前工作区内的路径。'
    }
    $ancestor = $full
    while ($ancestor) {
        if (Test-Path -LiteralPath $ancestor) {
            if (([IO.File]::GetAttributes($ancestor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw '发布准备路径包含目录跳转，已拒绝。'
            }
        }
        if ($ancestor -eq $releaseWorkspace) { break }
        $ancestor = [IO.Path]::GetDirectoryName($ancestor)
    }
    return $full
}

function Get-ReleasePackageReport([string]$Directory) {
    $directory = Assert-ReleaseOwnedPath $Directory
    $manifestPath = Assert-ReleaseOwnedPath (Join-Path $directory 'package-manifest.json')
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw '缺少 AE Switch 便携包清单。' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $application = Get-Content -LiteralPath (Join-Path $releaseApp 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $config = Get-Content -LiteralPath (Join-Path $releaseApp 'release-config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.product -ne 'AE Switch' -or $manifest.platform -ne 'windows-x64' -or $manifest.version -ne $application.version) {
        throw '程序、平台或版本与当前 AE Switch 源码不一致。'
    }
    if ($application.license -ne 'AGPL-3.0-only') { throw '当前源码许可声明不一致。' }
    $required = @(
        'AE-Switch.exe', 'AE-Switch-core.exe', 'Start-AE-Switch.cmd', 'WebView2Loader.dll', 'LICENSE', 'NOTICE',
        'THIRD_PARTY_NOTICES.md', 'licenses/dependency-licenses.txt', 'licenses/codex-LICENSE',
        'source/ae-switch/README.md', 'source/ae-switch/app/package.json',
        'source/ae-switch/app/pnpm-lock.yaml', 'source/ae-switch/app/src-tauri/Cargo.toml',
        'source/ae-switch/app/src-tauri/Cargo.lock', 'source/ae-switch/app/src-tauri/src/lib.rs',
        'source/ae-switch/scripts/package-portable.ps1',
        'tools/webview2/msedgewebview2.exe', 'tools/webview2/msedge.dll',
        'tools/webview2/icudtl.dat', 'tools/webview2/resources.pak'
    )
    $missing = @($required | Where-Object { -not (Test-Path -LiteralPath (Assert-ReleaseOwnedPath (Join-Path $directory $_)) -PathType Leaf) })
    if ($missing.Count) { throw ('便携包缺少发布所需文件：' + ($missing -join ', ')) }
    if (-not $manifest.PSObject.Properties['agentProgramsBundled'] -or $manifest.agentProgramsBundled -ne $false -or
        -not $manifest.PSObject.Properties['installedApplicationRequired'] -or $manifest.installedApplicationRequired -ne $true -or
        @($manifest.tools).Count -ne 0) {
        throw 'AE Switch 正式包不得内置客户端及其测试运行库。'
    }
    foreach ($toolDirectory in Get-ChildItem -LiteralPath (Join-Path $directory 'tools') -Force -Directory) {
        if ($toolDirectory.Name -cne 'webview2') { throw 'AE Switch 正式包不得内置客户端及其测试运行库。' }
    }
    if (-not $manifest.portableRuntimesComplete) { throw '便携运行依赖尚未完整准备。' }
    if (Test-Path -LiteralPath (Assert-ReleaseOwnedPath (Join-Path $directory 'data'))) { throw '便携包含运行数据，禁止作为发布包准备。' }
    $assets = @('AE-Switch.exe', 'AE-Switch-core.exe', 'Start-AE-Switch.cmd', 'package-manifest.json') | ForEach-Object {
        $path = Assert-ReleaseOwnedPath (Join-Path $directory $_)
        [PSCustomObject]@{ name = $_; sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant(); size = (Get-Item -LiteralPath $path).Length }
    }
    if ($assets[0].sha256 -cne $manifest.desktopSha256 -or $assets[1].sha256 -cne $manifest.cliSha256) { throw '程序 SHA256 与便携包清单不一致。' }
    $repo = $config.githubRepository
    $blockers = [Collections.Generic.List[string]]::new()
    if (-not $repo) { $blockers.Add('修改版 GitHub 仓库尚未绑定；不会把上游仓库当作本修改版源码。') }
    elseif ($repo -notmatch '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$') { throw '修改版 GitHub 仓库格式不正确。' }
    $allSystemFunctionsVerified = $manifest.PSObject.Properties['allSystemFunctionsVerified'] -and
        $manifest.allSystemFunctionsVerified -is [bool] -and $manifest.allSystemFunctionsVerified
    $realInferenceVerified = $manifest.PSObject.Properties['realInferenceVerified'] -and
        $manifest.realInferenceVerified -is [bool] -and $manifest.realInferenceVerified
    $packageAuditPassed = $false
    if ($manifest.PSObject.Properties['finalValidation'] -and $null -ne $manifest.finalValidation -and
        $manifest.finalValidation.PSObject.Properties['packageAuditPassed']) {
        $packageAuditPassed = $manifest.finalValidation.packageAuditPassed -is [bool] -and
            $manifest.finalValidation.packageAuditPassed
    }
    $sourceDigest = if ($manifest.PSObject.Properties['sourceDigest'] -and
        $manifest.sourceDigest -is [string] -and $manifest.sourceDigest -cmatch '\A[a-f0-9]{64}\z') { $manifest.sourceDigest } else { $null }
    $remainingScopesRecorded = $manifest.PSObject.Properties['remainingSystemScopes'] -and
        $null -ne $manifest.remainingSystemScopes -and $manifest.remainingSystemScopes -is [array]
    $remainingSystemScopes = @(if ($remainingScopesRecorded) { $manifest.remainingSystemScopes } else {
        '便携包清单尚未记录完整系统验收范围。'
    })
    if (-not $sourceDigest) { $blockers.Add('便携包清单尚未绑定有效的当前源码 SHA256。') }
    if (-not $remainingScopesRecorded) { $blockers.Add('便携包清单缺少有效的 remainingSystemScopes 数组，完整系统验收范围未知。') }
    elseif ($remainingSystemScopes.Count -gt 0) { $blockers.Add('仍有未完成的系统验收范围：' + ($remainingSystemScopes -join '；')) }
    if (-not $allSystemFunctionsVerified) { $blockers.Add('完整需求验收尚未完成或未记录；remainingSystemScopes 保留未验证项。') }
    # Clients are installed by users and are absent from the AE distribution.
    # Third-party ownership and source notices remain in THIRD_PARTY_NOTICES.md.
    # This metadata check does not establish a separate trademark permission.
    if (-not $realInferenceVerified) { $blockers.Add('当前程序真实工具接入验收尚未通过或未记录。') }
    if (-not $packageAuditPassed) { $blockers.Add('当前源码、凭据和包目录审计尚未通过或未记录。') }
    return [PSCustomObject]@{
        product = 'AE Switch'; version = $application.version; platform = 'windows-x64'
        packageDirectory = $directory; recordedAt = [DateTimeOffset]::UtcNow.ToString('o')
        localPackageChecksPassed = $true; publicReady = ($blockers.Count -eq 0)
        allRequestedRequirementsVerified = [bool]($allSystemFunctionsVerified -and $remainingScopesRecorded -and $remainingSystemScopes.Count -eq 0)
        sourceDigest = $sourceDigest; repository = $repo; assets = @($assets)
        remainingSystemScopes = @($remainingSystemScopes); publicReleaseBlockers = @($blockers)
        agentProgramsBundled = $false; installedApplicationRequired = $true; brandPermissionConfirmed = $null
        sourceArchivePrepared = $false; fullPackageArchivePrepared = $false; externalActionsPerformed = $false
        scope = 'Required-file and current executable/hash checks; reuses earlier package audits. No new full secret scan, client launch, clean-machine test, archive, or redistribution grant.'
    }
}

if (-not $PackageDirectory) { $PackageDirectory = Join-Path $releaseWorkspace 'artifacts/AE-Switch-portable-win-x64' }
$releaseReport = Get-ReleasePackageReport $PackageDirectory
if ($RequirePublicReady -and -not $releaseReport.publicReady) { throw ('公共发布门未通过：' + ($releaseReport.publicReleaseBlockers -join '；')) }
if (-not $CheckOnly) {
    if (-not $OutputDirectory) { $OutputDirectory = Join-Path $releaseWorkspace ('artifacts/release-preparation/' + [Guid]::NewGuid().ToString('N')) }
    $OutputDirectory = Assert-ReleaseOwnedPath $OutputDirectory
    if (Test-Path -LiteralPath $OutputDirectory) { throw '输出目录已存在；发布准备不会覆盖已有资料。' }
    New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
    $encoding = [Text.UTF8Encoding]::new($false)
    [IO.File]::WriteAllText((Join-Path $OutputDirectory 'preparation.json'), (($releaseReport | ConvertTo-Json -Depth 8) + "`n"), $encoding)
    $sums = ($releaseReport.assets | ForEach-Object { "$($_.sha256)  $($_.name)" }) -join "`n"
    [IO.File]::WriteAllText((Join-Path $OutputDirectory 'SHA256SUMS.txt'), ($sums + "`n"), $encoding)
    Write-Output ('本地准备资料：' + $OutputDirectory)
}
$releaseReport | ConvertTo-Json -Depth 8
