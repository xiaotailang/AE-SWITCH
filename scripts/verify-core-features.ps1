[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('checks', 'build')][string]$Phase,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{32}$')][string]$Id,
    [Parameter(Mandatory)][string]$AuditDirectory,
    [switch]$RetryBuild,
    [switch]$RetryChecks
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
$verifyWorkspace = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if ($verifyWorkspace -notmatch '^[Gg]:[\\/]') { throw 'This workspace verification must stay on G:.' }
. (Join-Path $PSScriptRoot 'release-env.ps1')
$verifyAudit = [IO.Path]::GetFullPath($AuditDirectory)
$verifyPrefix = $verifyWorkspace.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
if (-not $verifyAudit.StartsWith($verifyPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Audit output must stay inside this workspace.' }
for ($verifyAncestor = $verifyAudit; $verifyAncestor; $verifyAncestor = Split-Path -Parent $verifyAncestor) {
    if ((Test-Path -LiteralPath $verifyAncestor) -and ((Get-Item -LiteralPath $verifyAncestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Audit ancestors cannot redirect storage.' }
}
$verifyTarget = Join-Path $verifyWorkspace '.cache/path-privacy-target-4cd78736f9ea495e992e1d6681985a11'
if (-not (Test-Path -LiteralPath $verifyTarget -PathType Container)) { $verifyTarget = Join-Path $verifyWorkspace '.cache/core-features-target' }
$env:CARGO_TARGET_DIR = $verifyTarget
for ($verifyAncestor = $verifyTarget; $verifyAncestor; $verifyAncestor = Split-Path -Parent $verifyAncestor) {
    if ((Test-Path -LiteralPath $verifyAncestor) -and ((Get-Item -LiteralPath $verifyAncestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Compiler target ancestors cannot redirect storage.' }
}
Set-Location -LiteralPath $verifyWorkspace
New-Item -ItemType Directory -Path $verifyAudit -Force | Out-Null
$verifyOwnerPath = Join-Path $verifyAudit '.ae-release-audit-owner.json'
$verifyUtf8 = [Text.UTF8Encoding]::new($false)
function Write-VerifyJson([string]$Name, $Value) {
    [IO.File]::WriteAllText((Join-Path $verifyAudit $Name), (($Value | ConvertTo-Json -Depth 40) + "`n"), $verifyUtf8)
}
if (Test-Path -LiteralPath $verifyOwnerPath) {
    $verifyOwner = Get-Content -LiteralPath $verifyOwnerPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($verifyOwner.id -cne $Id -or $verifyOwner.workspace -ine $verifyWorkspace) { throw 'Existing audit belongs to another run.' }
} else {
    Write-VerifyJson '.ae-release-audit-owner.json' @{ id = $Id; workspace = $verifyWorkspace; createdAt = [DateTimeOffset]::UtcNow.ToString('o'); purpose = 'Core features development and production acceptance' }
}
if (Test-Path -LiteralPath (Join-Path $verifyAudit ($Phase + '-receipt.json'))) {
    if ($Phase -eq 'checks' -and $RetryChecks) {
        $verifyPrevious = Join-Path $verifyAudit ('prior-checks-' + [DateTimeOffset]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
        New-Item -ItemType Directory -Path $verifyPrevious -ErrorAction Stop | Out-Null
        foreach ($verifyFile in Get-ChildItem -LiteralPath $verifyAudit -File) {
            if ($verifyFile.Name -like 'checks-*' -or $verifyFile.Name -in @('types.log', 'frontend.log', 'tutorial.log', 'rustfmt.log', 'rust.log', 'rust-desktop.log', 'clippy.log')) {
                $verifyDestination = [IO.Path]::GetFullPath((Join-Path $verifyPrevious $verifyFile.Name))
                if (-not $verifyDestination.StartsWith($verifyPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Prior check preservation escaped workspace.' }
                Move-Item -LiteralPath $verifyFile.FullName -Destination $verifyDestination -ErrorAction Stop
            }
        }
    } else {
    if (-not $RetryBuild -or $Phase -ne 'build') { throw 'This phase already has a receipt; use a fresh audit run or explicitly preserve and retry a build.' }
    $verifyPrevious = Join-Path $verifyAudit ('prior-build-' + [DateTimeOffset]::UtcNow.ToString('yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory -Path $verifyPrevious -ErrorAction Stop | Out-Null
    foreach ($verifyFile in Get-ChildItem -LiteralPath $verifyAudit -File) {
        if ($verifyFile.Name -like 'build-*' -or $verifyFile.Name -in @('AE-Switch.exe', 'AE-Switch-core.exe', 'WebView2Loader.dll')) {
            $verifyDestination = [IO.Path]::GetFullPath((Join-Path $verifyPrevious $verifyFile.Name))
            if (-not $verifyDestination.StartsWith($verifyPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Prior build preservation escaped workspace.' }
            Move-Item -LiteralPath $verifyFile.FullName -Destination $verifyDestination -ErrorAction Stop
        }
    }
    }
}

function Get-VerifySource {
    $verifyRelativeFiles = [Collections.Generic.List[string]]::new()
    foreach ($relative in @('app/src-tauri/src', 'app/src-tauri/resources', 'app/src-tauri/icons', 'app/src-tauri/capabilities', 'app/src', 'app/dist', 'app/public')) {
        $directory = Join-Path $verifyWorkspace $relative
        if (Test-Path -LiteralPath $directory) {
            foreach ($file in Get-ChildItem -LiteralPath $directory -File -Recurse) {
                if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Production inputs cannot be reparse files.' }
                $verifyRelativeFiles.Add([IO.Path]::GetRelativePath($verifyWorkspace, $file.FullName).Replace('\', '/'))
            }
        }
    }
    foreach ($relative in @('app/src-tauri/Cargo.toml', 'app/src-tauri/Cargo.lock', 'app/src-tauri/build.rs', 'app/package.json', 'app/pnpm-lock.yaml', 'app/tsconfig.json', 'app/vite.config.ts', 'app/index.html', 'app/postcss.config.js', 'app/tailwind.config.js', 'app/release-config.json', 'app/src-tauri/tauri.conf.json')) { $verifyRelativeFiles.Add($relative) }
    $files = @(foreach ($relative in $verifyRelativeFiles | Sort-Object -Unique) {
        @{ path = $relative; sha256 = (Get-FileHash -LiteralPath (Join-Path $verifyWorkspace $relative) -Algorithm SHA256).Hash.ToLowerInvariant() }
    })
    $lines = ($files | ForEach-Object { $_.path + [char]0 + $_.sha256 + "`n" }) -join ''
    @{ files = $files; fileCount = $files.Count; digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($verifyUtf8.GetBytes($lines))).ToLowerInvariant() }
}

$verifyRuns = [Collections.Generic.List[object]]::new()
function Invoke-Verify([string]$Name, [string]$Program, [string[]]$Arguments, [string]$Directory = $verifyWorkspace, [string]$SourceDigest = '') {
    $log = Join-Path $verifyAudit ($Name + '.log')
    $clock = [Diagnostics.Stopwatch]::StartNew()
    Push-Location -LiteralPath $Directory
    try { & $Program @Arguments *> $log; $code = $LASTEXITCODE } finally { Pop-Location }
    $verifyRuns.Add(@{ name = $Name; arguments = $Arguments; exitCode = $code; elapsedMs = $clock.ElapsedMilliseconds; sourceDigest = $SourceDigest; log = [IO.Path]::GetFileName($log) })
    Write-VerifyJson ($Phase + '-runs.json') $verifyRuns.ToArray()
    Write-Output ("{0}: exit {1}, {2}s" -f $Name, $code, [Math]::Round($clock.Elapsed.TotalSeconds, 1))
    if ($code -ne 0) { throw ('Verification failed: ' + $Name + '; see its private G: log.') }
}

$verifyReceipt = [ordered]@{ id = $Id; phase = $Phase; startedAt = [DateTimeOffset]::UtcNow.ToString('o'); passed = $false; sourceUnchanged = $false; targetLinkPassed = $false; runs = @() }
try {
    if ($Phase -eq 'checks') {
        Invoke-Verify 'types' 'node' @('node_modules/typescript/bin/tsc', '--noEmit') (Join-Path $verifyWorkspace 'app')
        Invoke-Verify 'frontend' 'node' @('node_modules/vitest/vitest.mjs', 'run', '--maxWorkers', '2', '--testTimeout', '20000') (Join-Path $verifyWorkspace 'app')
        Invoke-Verify 'tutorial' 'node' @('scripts/generate-tutorial.mjs', '--check') (Join-Path $verifyWorkspace 'app')
        Invoke-Verify 'rustfmt' 'cargo' @('fmt', '--manifest-path', 'app/src-tauri/Cargo.toml', '--check')
        Invoke-Verify 'rust' 'cargo' @('test', '--release', '--manifest-path', 'app/src-tauri/Cargo.toml', '--no-default-features', '-j', '2')
        Invoke-Verify 'rust-desktop' (Join-Path $verifyWorkspace '.tools/pwsh/pwsh.exe') @('-NoProfile', '-File', 'scripts/test-rust-desktop.ps1', '-Release', '-TargetDirectory', $verifyTarget)
        Invoke-Verify 'clippy' 'cargo' @('clippy', '--release', '--manifest-path', 'app/src-tauri/Cargo.toml', '--all-targets', '--all-features', '-j', '2', '--', '-D', 'warnings')
    } else {
        $verifyChecks = Get-Content -LiteralPath (Join-Path $verifyAudit 'checks-receipt.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($verifyChecks.id -cne $Id -or $verifyChecks.passed -ne $true) { throw 'Current owned checks must pass before the production build.' }
        Invoke-Verify 'build-ui' 'node' @('node_modules/vite/bin/vite.js', 'build') (Join-Path $verifyWorkspace 'app')
        $verifyBefore = Get-VerifySource
        Write-VerifyJson 'build-source-before.json' $verifyBefore
        Invoke-Verify 'build-release-audit-desktop' 'cargo' @('build', '--release', '--manifest-path', 'app/src-tauri/Cargo.toml', '--no-default-features', '--features', 'desktop,tauri/custom-protocol', '--bin', 'ae-switch', '-j', '2') $verifyWorkspace $verifyBefore.digest
        Invoke-Verify 'build-release-audit-core' 'cargo' @('build', '--release', '--manifest-path', 'app/src-tauri/Cargo.toml', '--no-default-features', '--bin', 'ae-switch-cli', '-j', '2') $verifyWorkspace $verifyBefore.digest
        $verifyAfter = Get-VerifySource
        Write-VerifyJson 'build-source-after.json' $verifyAfter
        if ($verifyBefore.digest -cne $verifyAfter.digest) { throw 'Source changed during production build.' }
        $verifyOutputs = @(foreach ($binding in @(@{ name = 'desktop'; source = 'ae-switch.exe'; filename = 'AE-Switch.exe' }, @{ name = 'core'; source = 'ae-switch-cli.exe'; filename = 'AE-Switch-core.exe' })) {
            $verifyInput = Join-Path $verifyTarget ('release/' + $binding.source)
            $destination = Join-Path $verifyAudit $binding.filename
            if ((Get-Item -LiteralPath $verifyInput -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Production executable cannot be a reparse file.' }
            Copy-Item -LiteralPath $verifyInput -Destination $destination
            @{ name = $binding.name; filename = $binding.filename; sha256 = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() }
        })
        Copy-Item -LiteralPath (Join-Path $verifyTarget 'release/WebView2Loader.dll') -Destination (Join-Path $verifyAudit 'WebView2Loader.dll')
        Write-VerifyJson 'build-release-audit-outputs.json' $verifyOutputs
        $verifyReceipt.sourceDigest = $verifyAfter.digest
        $verifyReceipt.sourceFiles = $verifyAfter.fileCount
        $verifyReceipt.sourceAfterSha256 = (Get-FileHash -LiteralPath (Join-Path $verifyAudit 'build-source-after.json') -Algorithm SHA256).Hash.ToLowerInvariant()
        $verifyReceipt.sourceUnchanged = $true
        $verifyReceipt.targetLinkPassed = $true
    }
    $verifyReceipt.passed = $true
} finally {
    $verifyReceipt.finishedAt = [DateTimeOffset]::UtcNow.ToString('o')
    $verifyReceipt.runs = $verifyRuns.ToArray()
    Write-VerifyJson ($Phase + '-receipt.json') $verifyReceipt
}
