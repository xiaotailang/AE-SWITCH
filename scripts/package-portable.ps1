[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ExecutablePath,
    [string]$CliExecutablePath,
    [string]$OutputDirectory,
    [switch]$CreateZip
)

$ErrorActionPreference = 'Stop'
$packageWorkspace = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$packageUtf8 = [Text.UTF8Encoding]::new($false)

function Assert-PackagePath([string]$Location) {
    $absolute = [IO.Path]::GetFullPath($Location)
    if (-not ($absolute.Equals($packageWorkspace, [StringComparison]::OrdinalIgnoreCase) -or $absolute.StartsWith($packageWorkspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase))) {
        throw "Package output must remain within the current workspace: $absolute"
    }
    $packageAncestor = $absolute
    while ($packageAncestor) {
        if (Test-Path -LiteralPath $packageAncestor) {
            $packageAttributes = [IO.File]::GetAttributes($packageAncestor)
            if ($packageAttributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'Package output must not pass through a junction or symbolic link.'
            }
            if ($packageAncestor -ne $absolute -and -not ($packageAttributes -band [IO.FileAttributes]::Directory)) {
                throw 'Package output parent is not a directory.'
            }
        }
        $packageAncestor = [IO.Path]::GetDirectoryName($packageAncestor)
    }
    $absolute
}

# Validate the workspace before bootstrapping caches or creating package files.
$null = Assert-PackagePath $packageWorkspace
. (Join-Path $PSScriptRoot 'workspace-env.ps1')

function Require-File([string]$Location, [string]$Description) {
    if (-not (Test-Path -LiteralPath $Location -PathType Leaf)) { throw "Missing $Description`: $Location" }
    [IO.Path]::GetFullPath($Location)
}

function Require-Directory([string]$Location, [string]$Description) {
    if (-not (Test-Path -LiteralPath $Location -PathType Container)) { throw "Missing $Description`: $Location" }
    [IO.Path]::GetFullPath($Location)
}

function Require-WindowsExecutable([string]$Location, [string]$Description) {
    $absolute = Require-File $Location $Description
    $stream = [IO.File]::OpenRead($absolute)
    try {
        if ($stream.ReadByte() -ne 77 -or $stream.ReadByte() -ne 90) { throw "$Description is not a built Windows executable: $absolute" }
    } finally { $stream.Dispose() }
    $absolute
}

function Get-PackageSha256([string]$Location) {
    $hasher = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Location)
    try { ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $hasher.Dispose() }
}

function Assert-NoBuildWorkspacePath([string]$Location, [string]$Description) {
    if (-not ('AEReleaseWorkspacePathScan' -as [type])) {
        Add-Type -TypeDefinition @'
public static class AEReleaseWorkspacePathScan {
    public static bool Contains(byte[] data, byte[] needle) {
        for (int start = 0; start <= data.Length - needle.Length; start++) {
            if (data[start] != needle[0]) continue;
            int offset = 1;
            while (offset < needle.Length && data[start + offset] == needle[offset]) offset++;
            if (offset == needle.Length) return true;
        }
        return false;
    }
}
'@
    }
    $workspace = $packageWorkspace
    if ($workspace.StartsWith('\\?\', [StringComparison]::Ordinal)) { $workspace = $workspace.Substring(4) }
    $prefixes = @($workspace, $workspace.Replace('\', '/'), $workspace.Replace('\', '\\'))
    if ($workspace -match '^[A-Za-z]:[\\/]') {
        $prefixes += @(('\\?\' + $workspace.Replace('/', '\')), ('//?/' + $workspace.Replace('\', '/')))
    }
    $bytes = [IO.File]::ReadAllBytes($Location)
    foreach ($prefix in $prefixes | Select-Object -Unique) {
        foreach ($encoding in @([Text.Encoding]::UTF8, [Text.Encoding]::Unicode, [Text.Encoding]::BigEndianUnicode)) {
            if ([AEReleaseWorkspacePathScan]::Contains($bytes, $encoding.GetBytes($prefix))) {
                throw "$Description contains this machine's build workspace path. Rebuild after loading scripts/release-env.ps1 before packaging."
            }
        }
    }
}

# Validate the actual inputs before creating a distributable directory. There
# are no placeholder executables, environment-file copies, or deletion steps.
$packageDesktop = Require-WindowsExecutable $ExecutablePath 'Rust desktop executable'
if ($CliExecutablePath) { $packageCli = Require-WindowsExecutable $CliExecutablePath 'Rust CLI executable' }
else { $packageCli = $null }
Assert-NoBuildWorkspacePath $packageDesktop 'Rust desktop executable'
if ($packageCli) { Assert-NoBuildWorkspacePath $packageCli 'Rust CLI executable' }
$packageUi = Require-Directory (Join-Path $packageWorkspace 'app/dist') 'production React UI'
$null = Require-File (Join-Path $packageUi 'index.html') 'production React UI entry'
$packageLicense = Require-File (Join-Path $packageWorkspace 'app/LICENSE') 'AE Switch/upstream license'
$packageNotice = Require-File (Join-Path $packageWorkspace 'app/NOTICE') 'upstream copyright notice'
$packageWebViewLoader = Require-File (Join-Path (Split-Path -Parent $packageDesktop) 'WebView2Loader.dll') 'AE WebView2 loader'
$packageWebView = Require-Directory (Join-Path $packageWorkspace '.tools/webview2') 'fixed WebView2 UI runtime'
$null = Require-WindowsExecutable (Join-Path $packageWebView 'msedgewebview2.exe') 'fixed WebView2 executable'
foreach ($relative in @('msedge.dll', 'icudtl.dat', 'resources.pak', 'v8_context_snapshot.bin', 'show_third_party_software_licenses.bat')) {
    $null = Require-File (Join-Path $packageWebView $relative) "WebView2 runtime $relative"
}

$packageBase = if ($OutputDirectory) { Assert-PackagePath $OutputDirectory } else { Assert-PackagePath (Join-Path $packageWorkspace 'artifacts/AE-Switch-portable-win-x64') }
# Preserve any existing package and choose a fresh sibling; never recursively
# remove or merge an old package containing a user's portable data directory.
$packageDestination = if (Test-Path -LiteralPath $packageBase) { "$packageBase-$([DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff'))" } else { $packageBase }
$packageDestination = Assert-PackagePath $packageDestination
New-Item -ItemType Directory -Path $packageDestination -ErrorAction Stop | Out-Null
$packageLog = Assert-PackagePath (Join-Path $packageWorkspace ('.cache/tmp/package-portable-' + [Guid]::NewGuid().ToString('N') + '.log'))
$packageManifest = [ordered]@{
    product = 'AE Switch'; version = '0.1.0'; platform = 'windows-x64'
    createdAt = [DateTime]::UtcNow.ToString('o'); status = 'packaging'
    installedApplicationRequired = $true; agentProgramsBundled = $false
    releaseAcceptanceVerified = $false; realInferenceVerified = $false
    realInferencePassedAgents = 0; realInferenceAgentCount = 8
    realInferenceNote = 'Packaging does not imply inference or tool execution acceptance. Use the independent portable end-to-end report for the actual endpoint and per-agent results.'
    scope = 'AE Switch application, Rust core, UI runtime and public source only. Users select their existing client installations; packaging does not certify their configuration, restart or inference.'
    includesCli = [bool]$packageCli; warnings = @(); tools = @()
    runtimes = @(@{ id = 'webview2'; executable = 'tools/webview2/msedgewebview2.exe'; scope = 'AE Switch desktop UI only' })
}

function Package-Log([string]$Message) {
    $line = "[$([DateTime]::UtcNow.ToString('o'))] $Message"
    [IO.File]::AppendAllText($packageLog, $line + [Environment]::NewLine, $packageUtf8)
    Write-Host $Message
}

function Write-PackageText([string]$Relative, [string]$Text) {
    $target = Assert-PackagePath (Join-Path $packageDestination $Relative)
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    [IO.File]::WriteAllText($target, $Text, $packageUtf8)
}

function Copy-PackageFile([string]$Source, [string]$Relative) {
    $target = Assert-PackagePath (Join-Path $packageDestination $Relative)
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath $Source -Destination $target -Force
}

function Copy-PackageTree([string]$Source, [string]$Relative, [string[]]$ExcludedDirectories = @(), [string[]]$ExcludedFiles = @()) {
    $target = Assert-PackagePath (Join-Path $packageDestination $Relative)
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    $arguments = @($Source, $target, '/E', '/XJ', '/R:1', '/W:1', '/COPY:DAT', '/DCOPY:DAT', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
    $arguments += @('/XD', '.git', '.cache', 'rtk', '.rtk', '__pycache__', '.pytest_cache', '.ruff_cache', '.mypy_cache', '.turbo', 'coverage') + $ExcludedDirectories
    $arguments += @('/XF', '.env', '.env.local', '.env.production', '.env.development', '.env.vault', '*.pyc', '*.pyo', '*.log', '*.db', '*.db-shm', '*.db-wal', '*.db-journal', '*.sqlite', '*.sqlite-shm', '*.sqlite-wal', '*.sqlite-journal', '*.sqlite3', '*.sqlite3-shm', '*.sqlite3-wal', '*.sqlite3-journal', '端点测试用.txt', 'direct_url.json') + $ExcludedFiles
    & robocopy.exe @arguments | Out-File -LiteralPath $packageLog -Append -Encoding utf8
    if ($LASTEXITCODE -ge 8) { throw "Failed to copy $Source (robocopy exit $LASTEXITCODE)" }
    Package-Log "Copied $Relative"
}

try {
    Package-Log "Building a fresh package at $packageDestination"
    Copy-PackageFile $packageDesktop 'AE-Switch.exe'
    if ($packageCli) { Copy-PackageFile $packageCli 'AE-Switch-core.exe' }
    Copy-PackageFile $packageWebViewLoader 'WebView2Loader.dll'
    Copy-PackageTree $packageUi 'ui'
    Copy-PackageFile $packageLicense 'LICENSE'
    Copy-PackageFile (Require-File (Join-Path $packageWorkspace 'app/third-party/dependency-licenses.txt') 'application dependency license inventory') 'licenses/dependency-licenses.txt'
    Copy-PackageFile (Require-File (Join-Path $packageWorkspace 'app/third-party/codex/LICENSE') 'OpenAI Codex base-instructions license') 'licenses/codex-LICENSE'
    $originalNotice = [IO.File]::ReadAllText($packageNotice)
    Write-PackageText 'NOTICE' ("AE Switch 0.1.0 - modified version with a Rust portable Agent Hub and redesigned user interface.`r`nOriginal attribution and license notices follow and are retained for legal compliance.`r`n`r`n" + $originalNotice)
    foreach ($name in @('THIRD_PARTY_NOTICES.md', 'THIRD-PARTY-NOTICES.md')) {
        $location = Join-Path $packageWorkspace "app/$name"
        if (Test-Path -LiteralPath $location -PathType Leaf) { Copy-PackageFile $location $name }
    }
    Copy-PackageTree (Join-Path $packageWorkspace 'app') 'source/ae-switch/app' @('node_modules', 'dist', 'target', '.omx', 'data') @('*.pdb')
    Copy-PackageTree (Join-Path $packageWorkspace 'scripts') 'source/ae-switch/scripts'
    Copy-PackageTree (Join-Path $packageWorkspace 'docs') 'source/ae-switch/docs'
    if (Test-Path -LiteralPath (Join-Path $packageWorkspace 'README.md') -PathType Leaf) { Copy-PackageFile (Join-Path $packageWorkspace 'README.md') 'source/ae-switch/README.md' }
    Copy-PackageFile (Require-File (Join-Path $packageWorkspace '.gitignore') 'public workspace ignore rules') 'source/ae-switch/.gitignore'
    if (Test-Path -LiteralPath (Join-Path $packageWorkspace 'tests')) { Copy-PackageTree (Join-Path $packageWorkspace 'tests') 'source/ae-switch/tests' }

    Copy-PackageTree $packageWebView 'tools/webview2'
    $packageManifest.portableRuntimesComplete = $true

    Write-PackageText 'Start-AE-Switch.cmd' @'
@echo off
setlocal
cd /d "%~dp0"
set "AE_SWITCH_PORTABLE_ROOT=%~dp0"
start "AE Switch" "%~dp0AE-Switch.exe"
'@
    Write-PackageText '使用说明.txt' @'
AE Switch 0.1.0 便携端点配置工具（Windows x64）

1. 将整个文件夹放到任意可写的本地目录，无需特定盘符；保留 tools/webview2 和所有子目录。
2. 双击 Start-AE-Switch.cmd 或 AE-Switch.exe，无需安装 AE Switch。
3. 客户端由用户自行安装；本包不携带、安装或修改客户端程序及其 Node、Python、PowerShell 或 Git 依赖。
4. 选择已安装客户端及其配置目录，填写供应商 API 端点与 API Key，查询真实模型列表，再选择模型并确认配置。
5. AE Switch 只更新端点、认证、模型及用户明确选择的相关设置；客户端对话、历史和其他配置应予保留。
6. 配置、重启和真实推理的结果以界面提示及独立验收报告为准。打包完成本身不代表这些验收已经通过。

AE Switch 的 data 目录在程序旁创建；工作台自己的配置、密钥、缓存和 WebView 数据保留在当前目录。
所选客户端保留其原有数据目录；请勿把其他用户或其他计算机的客户端路径直接当成当前安装路径。
不要公开分享使用后的 data 目录，其中可能含有密钥。
Windows 自带系统组件以及对应客户端自身的依赖仍须可用；WebView2 固定运行时随 AE Switch 打包。

LICENSE、NOTICE、licenses 和 WebView2 内的许可证保留应用及其依赖的许可与署名。
source/ae-switch 包含此修改版公开源码和构建资料，不包含用户凭据或客户端安装树。
包内验收资料以独立报告为准，须核对 scope、UUID、源码与二进制 hash，以及实际验收状态。
'@
    $packageManifest.status = 'packaged-not-release-verified'
    $packageManifest.desktopSha256 = Get-PackageSha256 (Join-Path $packageDestination 'AE-Switch.exe')
    if ($packageCli) { $packageManifest.cliSha256 = Get-PackageSha256 (Join-Path $packageDestination 'AE-Switch-core.exe') }
    Write-PackageText 'package-manifest.json' ($packageManifest | ConvertTo-Json -Depth 12)
    if ($CreateZip) {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $archive = Assert-PackagePath ($packageDestination + '.zip')
        if (Test-Path -LiteralPath $archive) { throw "Archive already exists; refusing to replace it: $archive" }
        [IO.Compression.ZipFile]::CreateFromDirectory($packageDestination, $archive, [IO.Compression.CompressionLevel]::Optimal, $true)
        Package-Log "Archive created: $archive"
    }
    Package-Log "Portable package assembled. Real inference remains unverified: $packageDestination"
    Write-Output $packageDestination
} catch {
    $packageManifest.status = 'packaging-failed'
    $packageManifest.error = $_.Exception.Message
    Write-PackageText 'package-manifest.json' ($packageManifest | ConvertTo-Json -Depth 12)
    Package-Log "Packaging failed: $($_.Exception.Message)"
    throw
}
