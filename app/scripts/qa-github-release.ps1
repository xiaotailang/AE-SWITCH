[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$qaWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$qaParent = Join-Path $qaWorkspace '.cache/release-preparation-qa'
$qaId = [Guid]::NewGuid().ToString('N')
$qaRoot = [IO.Path]::GetFullPath((Join-Path $qaParent $qaId))
if ($qaRoot -notlike 'G:\*' -or -not $qaRoot.StartsWith($qaWorkspace + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '发布回归 fixture 必须位于本轮 G 盘工作区。' }
if (Test-Path -LiteralPath $qaRoot) { throw '回归 fixture 已存在。' }
$qaPackage = Join-Path $qaRoot 'package'
$qaUtf8 = [Text.UTF8Encoding]::new($false)
$qaAssertions = 0
$qaRedirect = Join-Path $qaRoot 'redirect'
function Write-QaFile([string]$Relative, [string]$Text) {
    $path = Join-Path $qaPackage $Relative
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($path)) -Force | Out-Null
    [IO.File]::WriteAllText($path, $Text, $qaUtf8)
}
function Assert-Qa([bool]$Value, [string]$Claim) {
    if (-not $Value) { throw ('发布回归失败：' + $Claim) }
    $script:qaAssertions++
}
function Assert-QaRejected([scriptblock]$Action, [string]$Expected) {
    $rejected = $false
    try { & $Action | Out-Null } catch { $rejected = $_.Exception.Message -like ('*' + $Expected + '*') }
    Assert-Qa $rejected $Expected
}
$qaTokens=$null; $qaErrors=$null
$qaAst=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'prepare-github-release.ps1'),[ref]$qaTokens,[ref]$qaErrors)
Assert-Qa ($qaErrors.Count -eq 0) 'prepare script parser'
foreach ($name in @('Assert-ReleaseOwnedPath','Get-ReleasePackageReport')) {
    $definition=$qaAst.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name},$false)
    if (-not $definition) { throw '缺少发布检查函数。' }
    . ([scriptblock]::Create($definition.Extent.Text))
}
# Evaluate the production path guard with virtual C strings only; no C IO.
& {
    $releaseWorkspace = 'C:\AE-Switch-virtual-workspace'
    function Test-Path { param([string]$LiteralPath) return $false }
    Assert-Qa ((Assert-ReleaseOwnedPath 'C:\AE-Switch-virtual-workspace\artifacts\package') -ceq 'C:\AE-Switch-virtual-workspace\artifacts\package') 'C workspace release preparation accepted without C filesystem access'
    Assert-QaRejected { Assert-ReleaseOwnedPath $releaseWorkspace } '当前工作区'
    foreach ($outside in @('C:\AE-Switch-virtual-workspace-sibling\package', 'C:\AE-Switch-virtual-workspace\..\escape')) {
        Assert-QaRejected { Assert-ReleaseOwnedPath $outside } '当前工作区'
    }
}

New-Item -ItemType Directory -Path $qaPackage -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $qaRoot '.ae-switch-owner'), $qaId, $qaUtf8)
try {
    $qaVersion = (Get-Content -LiteralPath (Join-Path $qaWorkspace 'app/package.json') -Raw | ConvertFrom-Json).version
    $qaRequired = @('AE-Switch.exe','AE-Switch-core.exe','Start-AE-Switch.cmd','WebView2Loader.dll','LICENSE','NOTICE','THIRD_PARTY_NOTICES.md','licenses/dependency-licenses.txt','licenses/codex-LICENSE','source/ae-switch/README.md','source/ae-switch/app/package.json','source/ae-switch/app/pnpm-lock.yaml','source/ae-switch/app/src-tauri/Cargo.toml','source/ae-switch/app/src-tauri/Cargo.lock','source/ae-switch/app/src-tauri/src/lib.rs','source/ae-switch/scripts/package-portable.ps1','tools/webview2/msedgewebview2.exe','tools/webview2/msedge.dll','tools/webview2/icudtl.dat','tools/webview2/resources.pak')
    foreach ($relative in $qaRequired) { Write-QaFile $relative 'Owned fixture only; never executable.' }
    $qaManifest = @{
        product='AE Switch'; platform='windows-x64'; version=$qaVersion
        desktopSha256=(Get-FileHash -LiteralPath (Join-Path $qaPackage 'AE-Switch.exe')).Hash.ToLowerInvariant()
        cliSha256=(Get-FileHash -LiteralPath (Join-Path $qaPackage 'AE-Switch-core.exe')).Hash.ToLowerInvariant()
        sourceDigest=('a' * 64); allSystemFunctionsVerified=$false; realInferenceVerified=$true
        remainingSystemScopes=@('Actual Windows sign-in autostart'); finalValidation=@{packageAuditPassed=$true}
        portableRuntimesComplete=$true; installedApplicationRequired=$true; agentProgramsBundled=$false; tools=@()
    }
    Write-QaFile 'package-manifest.json' ($qaManifest | ConvertTo-Json -Depth 5)
    $qaOriginalManifest = [IO.File]::ReadAllText((Join-Path $qaPackage 'package-manifest.json'))
    $releaseWorkspace=$qaWorkspace
    $releaseApp=Join-Path $qaWorkspace 'app'
    $report=Get-ReleasePackageReport $qaPackage
    Assert-Qa ($report.localPackageChecksPassed -and $report.assets.Count -eq 4) 'concrete package hash success'
    Assert-Qa (-not $report.publicReady -and $report.publicReleaseBlockers.Count -ge 2) 'inference does not promote public distribution'
    Assert-Qa (-not $report.agentProgramsBundled -and $null -eq $report.brandPermissionConfirmed) 'no vendor redistribution gate for absent clients; brand scope remains distinct'
    Assert-Qa (-not $report.externalActionsPerformed -and -not $report.sourceArchivePrepared -and -not $report.fullPackageArchivePrepared) 'no fake archive or external action'
    # Positive readiness uses only an owned metadata fixture, never the real
    # repository configuration or a claim of real-client acceptance.
    $qaApp = Join-Path $qaRoot 'release-app'
    New-Item -ItemType Directory -Path $qaApp | Out-Null
    [IO.File]::WriteAllText((Join-Path $qaApp 'package.json'), (@{version=$qaVersion; license='AGPL-3.0-only'} | ConvertTo-Json), $qaUtf8)
    [IO.File]::WriteAllText((Join-Path $qaApp 'release-config.json'), (@{githubRepository='example/ae-switch'} | ConvertTo-Json), $qaUtf8)
    $qaReadyManifest = $qaManifest.Clone()
    $qaReadyManifest.allSystemFunctionsVerified = $true
    $qaReadyManifest.remainingSystemScopes = @()
    Write-QaFile 'package-manifest.json' ($qaReadyManifest | ConvertTo-Json -Depth 5)
    $releaseApp = $qaApp
    try {
        $qaReadyReport = Get-ReleasePackageReport $qaPackage
        Assert-Qa ($qaReadyReport.publicReady -and $qaReadyReport.allRequestedRequirementsVerified -and $qaReadyReport.publicReleaseBlockers.Count -eq 0) 'complete bound metadata can pass the local release gate without fake brand approval'
        Assert-Qa (-not $qaReadyReport.externalActionsPerformed -and -not $qaReadyReport.sourceArchivePrepared -and -not $qaReadyReport.fullPackageArchivePrepared) 'positive readiness fixture still performs no publishing or archive action'
        $qaReadyManifest.remainingSystemScopes = @('Actual Windows sign-in autostart')
        Write-QaFile 'package-manifest.json' ($qaReadyManifest | ConvertTo-Json -Depth 5)
        $qaScopedReport = Get-ReleasePackageReport $qaPackage
        Assert-Qa (-not $qaScopedReport.publicReady -and -not $qaScopedReport.allRequestedRequirementsVerified -and ($qaScopedReport.publicReleaseBlockers -join ' ').Contains('仍有未完成的系统验收范围')) 'a nonempty scope list blocks even when all-system Boolean is true'
        $qaReadyManifest.remainingSystemScopes = $null
        Write-QaFile 'package-manifest.json' ($qaReadyManifest | ConvertTo-Json -Depth 5)
        Assert-Qa (-not (Get-ReleasePackageReport $qaPackage).publicReady) 'null scope metadata cannot mean complete acceptance'
        $qaReadyManifest.remainingSystemScopes = @()
        foreach ($qaRequiredFlag in @('allSystemFunctionsVerified','realInferenceVerified')) {
            $qaReadyManifest[$qaRequiredFlag] = $false
            Write-QaFile 'package-manifest.json' ($qaReadyManifest | ConvertTo-Json -Depth 5)
            Assert-Qa (-not (Get-ReleasePackageReport $qaPackage).publicReady) ($qaRequiredFlag + ' false independently blocks complete metadata')
            $qaReadyManifest[$qaRequiredFlag] = $true
        }
        $qaReadyManifest.finalValidation = @{packageAuditPassed=$false}
        Write-QaFile 'package-manifest.json' ($qaReadyManifest | ConvertTo-Json -Depth 5)
        Assert-Qa (-not (Get-ReleasePackageReport $qaPackage).publicReady) 'failed package audit independently blocks complete metadata'
        $qaReadyManifest.finalValidation = @{packageAuditPassed=$true}
        $qaReadyManifest.portableRuntimesComplete = $false
        Write-QaFile 'package-manifest.json' ($qaReadyManifest | ConvertTo-Json -Depth 5)
        Assert-QaRejected { Get-ReleasePackageReport $qaPackage } '便携运行依赖'
    } finally {
        $releaseApp = Join-Path $qaWorkspace 'app'
        Write-QaFile 'package-manifest.json' $qaOriginalManifest
    }
    $qaPendingManifest = $qaManifest.Clone()
    foreach ($qaPendingField in @('allSystemFunctionsVerified', 'finalValidation', 'sourceDigest', 'remainingSystemScopes', 'realInferenceVerified')) {
        $qaPendingManifest.Remove($qaPendingField)
    }
    Write-QaFile 'package-manifest.json' ($qaPendingManifest | ConvertTo-Json -Depth 5)
    $qaPendingReport = Get-ReleasePackageReport $qaPackage
    Assert-Qa ($qaPendingReport.localPackageChecksPassed -and -not $qaPendingReport.publicReady -and -not $qaPendingReport.allRequestedRequirementsVerified) 'fresh unverified manifest returns concrete false readiness instead of StrictMode exception'
    Assert-Qa ($null -eq $qaPendingReport.sourceDigest -and $qaPendingReport.remainingSystemScopes.Count -gt 0 -and $qaPendingReport.publicReleaseBlockers.Count -ge 5) 'missing validation facts remain explicit release blockers'
    $qaPendingManifest.allSystemFunctionsVerified = 'true'
    $qaPendingManifest.realInferenceVerified = 'true'
    $qaPendingManifest.finalValidation = @{ packageAuditPassed = 'true' }
    Write-QaFile 'package-manifest.json' ($qaPendingManifest | ConvertTo-Json -Depth 5)
    $qaPendingReport = Get-ReleasePackageReport $qaPackage
    Assert-Qa (-not $qaPendingReport.allRequestedRequirementsVerified -and $qaPendingReport.publicReleaseBlockers.Count -ge 5) 'strings cannot promote missing Boolean validation facts'
    Write-QaFile 'package-manifest.json' $qaOriginalManifest
    $qaBefore=@(Get-ChildItem -LiteralPath $qaPackage -File).Count
    $json=& (Join-Path $PSScriptRoot 'prepare-github-release.ps1') -PackageDirectory $qaPackage -CheckOnly
    $check=$json | ConvertFrom-Json
    Assert-Qa ($check.localPackageChecksPassed -and @((Get-ChildItem -LiteralPath $qaPackage -File)).Count -eq $qaBefore) 'CheckOnly creates no package files'
    Assert-QaRejected { & (Join-Path $PSScriptRoot 'prepare-github-release.ps1') -PackageDirectory $qaPackage -CheckOnly -RequirePublicReady } '公共发布门未通过'
    Assert-QaRejected { & (Join-Path $PSScriptRoot 'publish-github-release.ps1') -PackageDirectory $qaPackage -CheckOnly } '公共发布门未通过'
    $qaPrepared=Join-Path $qaRoot 'prepared'
    & (Join-Path $PSScriptRoot 'prepare-github-release.ps1') -PackageDirectory $qaPackage -OutputDirectory $qaPrepared | Out-Null
    $qaPreparedReport=Get-Content -LiteralPath (Join-Path $qaPrepared 'preparation.json') -Raw | ConvertFrom-Json
    $qaSums=@(Get-Content -LiteralPath (Join-Path $qaPrepared 'SHA256SUMS.txt'))
    Assert-Qa ($qaPreparedReport.localPackageChecksPassed -and -not $qaPreparedReport.publicReady -and $qaSums.Count -eq 4 -and $qaSums[0].StartsWith($qaManifest.desktopSha256)) 'written receipt/checksums describe real roots only'
    Assert-QaRejected { & (Join-Path $PSScriptRoot 'prepare-github-release.ps1') -PackageDirectory $qaPackage -OutputDirectory $qaPrepared } '输出目录已存在'
    Write-QaFile 'AE-Switch.exe' 'tampered owned fixture'
    Assert-QaRejected { Get-ReleasePackageReport $qaPackage } 'SHA256'
    Write-QaFile 'AE-Switch.exe' 'Owned fixture only; never executable.'
    $qaManifest.platform='darwin-arm64'; Write-QaFile 'package-manifest.json' ($qaManifest | ConvertTo-Json -Depth 5)
    Assert-QaRejected { Get-ReleasePackageReport $qaPackage } '平台或版本'
    $qaManifest.platform='windows-x64'; $qaManifest.version='999.0.0'; Write-QaFile 'package-manifest.json' ($qaManifest | ConvertTo-Json -Depth 5)
    Assert-QaRejected { Get-ReleasePackageReport $qaPackage } '平台或版本'
    Write-QaFile 'package-manifest.json' $qaOriginalManifest
    $qaManifest.version=$qaVersion
    $qaManifest.agentProgramsBundled=$true
    Write-QaFile 'package-manifest.json' ($qaManifest | ConvertTo-Json -Depth 5)
    Assert-QaRejected { Get-ReleasePackageReport $qaPackage } '不得内置客户端'
    $qaManifest.agentProgramsBundled=$false; $qaManifest.tools=@(@{id='codex'})
    Write-QaFile 'package-manifest.json' ($qaManifest | ConvertTo-Json -Depth 5)
    Assert-QaRejected { Get-ReleasePackageReport $qaPackage } '不得内置客户端'
    $qaManifest.tools=@(); $qaManifest.portableRuntimesComplete=$false
    Write-QaFile 'package-manifest.json' ($qaManifest | ConvertTo-Json -Depth 5)
    Assert-QaRejected { Get-ReleasePackageReport $qaPackage } '便携运行依赖'
    Write-QaFile 'package-manifest.json' $qaOriginalManifest
    foreach ($qaForbidden in @('agents','node','python','pwsh','git')) {
        Write-QaFile ("tools/$qaForbidden/vendor-sentinel") 'Unexpected client/test runtime'
        Assert-QaRejected { Get-ReleasePackageReport $qaPackage } '不得内置客户端'
        Remove-Item -LiteralPath (Join-Path $qaPackage "tools/$qaForbidden") -Recurse -Force
    }
    Remove-Item -LiteralPath (Join-Path $qaPackage 'WebView2Loader.dll')
    Assert-QaRejected { Get-ReleasePackageReport $qaPackage } '缺少发布所需文件'
    Write-QaFile 'WebView2Loader.dll' 'Owned fixture only; never executable.'
    Remove-Item -LiteralPath (Join-Path $qaPackage 'LICENSE')
    Assert-QaRejected { Get-ReleasePackageReport $qaPackage } '缺少发布所需文件'
    Write-QaFile 'LICENSE' 'Owned fixture only; never executable.'
    Remove-Item -LiteralPath (Join-Path $qaPackage 'source/ae-switch/app/src-tauri/src/lib.rs')
    Assert-QaRejected { Get-ReleasePackageReport $qaPackage } '缺少发布所需文件'
    Write-QaFile 'source/ae-switch/app/src-tauri/src/lib.rs' 'Owned fixture only; never executable.'
    New-Item -ItemType Directory -Path (Join-Path $qaPackage 'data') | Out-Null
    Assert-QaRejected { Get-ReleasePackageReport $qaPackage } '包含运行数据'
    [IO.Directory]::Delete((Join-Path $qaPackage 'data'))
    Assert-QaRejected { Assert-ReleaseOwnedPath 'C:\ae-switch-not-created' } '当前工作区'
    Assert-QaRejected { Assert-ReleaseOwnedPath $qaWorkspace } '当前工作区'
    Assert-QaRejected { Assert-ReleaseOwnedPath ([IO.Path]::GetFullPath((Join-Path $qaWorkspace '../escape-not-created'))) } '当前工作区'
    $qaTarget=Join-Path $qaRoot 'redirect-target'
    New-Item -ItemType Directory -Path $qaTarget | Out-Null
    New-Item -ItemType Junction -Path $qaRedirect -Target $qaTarget | Out-Null
    Assert-QaRejected { Assert-ReleaseOwnedPath (Join-Path $qaRedirect 'never-created') } '目录跳转'
    [IO.Directory]::Delete($qaRedirect)
    $qaTutorial=Join-Path $qaRoot 'tutorial-app'
    foreach ($relative in @('scripts','src/content','docs')) { New-Item -ItemType Directory -Path (Join-Path $qaTutorial $relative) -Force | Out-Null }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'generate-tutorial.mjs') -Destination (Join-Path $qaTutorial 'scripts/generate-tutorial.mjs')
    [IO.File]::WriteAllText((Join-Path $qaTutorial 'package.json'), '{"version":"0.1.0"}', $qaUtf8)
    [IO.File]::WriteAllText((Join-Path $qaTutorial 'src/content/tutorial.json'), '{"title":"Fixture","intro":"Fixture","topics":[]}', $qaUtf8)
    foreach ($qaRepository in @($null,'example/ae-switch','example/ae-switch?redirect=upstream')) {
        [IO.File]::WriteAllText((Join-Path $qaTutorial 'release-config.json'), (@{githubRepository=$qaRepository} | ConvertTo-Json), $qaUtf8)
        & node (Join-Path $qaTutorial 'scripts/generate-tutorial.mjs') | Out-Null
        if ($LASTEXITCODE -ne 0) { throw '教程 fixture 生成失败。' }
        $qaDoc=[IO.File]::ReadAllText((Join-Path $qaTutorial 'docs/tutorial.md'))
        if ($qaRepository -ceq 'example/ae-switch') {
            Assert-Qa ($qaDoc.Contains('https://github.com/example/ae-switch/releases/latest') -and -not $qaDoc.Contains('dieqiyun/uni-switch')) 'bound tutorial links use the modification repository'
        } else {
            Assert-Qa ($qaDoc.Contains('仓库尚未设置') -and -not $qaDoc.Contains('https://github.com/')) 'unset/unsafe tutorial repository never links upstream'
        }
    }
    Write-Output ('发布准备回归通过：' + $qaAssertions + ' 项；无网络、无客户端执行。')
} finally {
    if (Test-Path -LiteralPath $qaRedirect) {
        if (([IO.File]::GetAttributes($qaRedirect) -band [IO.FileAttributes]::ReparsePoint) -eq 0) { throw 'fixture junction ownership changed; cleanup refused' }
        [IO.Directory]::Delete($qaRedirect)
    }
    $resolved=[IO.Path]::GetFullPath($qaRoot)
    if ($resolved -ne $qaRoot -or -not $resolved.StartsWith($qaWorkspace + '\',[StringComparison]::OrdinalIgnoreCase) -or $resolved -notlike 'G:\*') { throw 'fixture cleanup boundary changed' }
    if (([IO.File]::GetAttributes($resolved) -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or [IO.File]::ReadAllText((Join-Path $resolved '.ae-switch-owner')) -cne $qaId) { throw 'fixture cleanup owner mismatch' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
    if (Test-Path -LiteralPath $resolved) { throw 'fixture cleanup incomplete' }
    Write-Output '本轮发布准备 fixture 已清理。'
}
