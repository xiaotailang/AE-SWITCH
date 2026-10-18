[CmdletBinding()]
param([Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{32}$')][string]$ExpectedId)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../scripts/workspace-env.ps1')
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 is required for long-path auditing.' }
$cleanupReportPath = Join-Path $env:AE_WORKSPACE 'artifacts/acceptance/workbuddy-retest-events.json'
$cleanupReport = Get-Content -LiteralPath $cleanupReportPath -Raw | ConvertFrom-Json
$cleanupBase = [IO.Path]::GetFullPath((Join-Path $env:AE_WORKSPACE '.cache/workbuddy-retest'))
$cleanupRoot = [IO.Path]::GetFullPath($cleanupReport.sandboxRoot)
if ((Split-Path -Parent $cleanupRoot) -cne $cleanupBase -or (Split-Path -Leaf $cleanupRoot) -cne $ExpectedId) { throw 'Only the explicitly named current diagnostic UUID may be removed.' }
$cleanupAncestor = $cleanupRoot
while ($cleanupAncestor) {
    if ([IO.File]::GetAttributes($cleanupAncestor) -band [IO.FileAttributes]::ReparsePoint) { throw 'Cleanup cannot traverse a redirected ancestor.' }
    $cleanupAncestor = [IO.Path]::GetDirectoryName($cleanupAncestor)
}
$cleanupOwnerPath = Join-Path $cleanupRoot '.ae-workbuddy-retest-owner.json'
function Assert-CurrentDiagnosticOwner {
    param([switch]$ExecutableAlreadyRemoved)
    if ([IO.File]::GetAttributes($cleanupOwnerPath) -band [IO.FileAttributes]::ReparsePoint) { throw 'Owner marker was redirected.' }
    $cleanupOwner = Get-Content -LiteralPath $cleanupOwnerPath -Raw | ConvertFrom-Json
    if ($cleanupOwner.id -ne $cleanupReport.ownerId -or $cleanupOwner.root -cne $cleanupRoot -or $cleanupOwner.workspace -cne $env:AE_WORKSPACE -or $cleanupOwner.purpose -cne 'Independent WorkBuddy official event-schema diagnostics' -or $cleanupOwner.cliSha256 -cne $cleanupReport.cliSha256) { throw 'Current diagnostic ownership does not match.' }
    if (-not $ExecutableAlreadyRemoved) {
        $cleanupExe = Join-Path $cleanupRoot 'AE-Switch-core.exe'
        if ([IO.File]::GetAttributes($cleanupExe) -band [IO.FileAttributes]::ReparsePoint) { throw 'Diagnostic executable was redirected.' }
        if ((Get-FileHash -LiteralPath $cleanupExe -Algorithm SHA256).Hash.ToLowerInvariant() -cne $cleanupReport.cliSha256) { throw 'Diagnostic executable hash does not match.' }
    }
}
function Assert-NoDiagnosticProcesses {
    $cleanupRemaining = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
        ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($cleanupRoot + '\', [StringComparison]::OrdinalIgnoreCase)) -or
        ($_.CommandLine -and $_.CommandLine.Contains($cleanupRoot, [StringComparison]::OrdinalIgnoreCase))
    })
    if ($cleanupRemaining.Count) { throw 'A live process references this new UUID; no termination or deletion is authorized by this cleanup script.' }
}
Assert-CurrentDiagnosticOwner
Assert-NoDiagnosticProcesses
$cleanupPending = [Collections.Generic.Stack[string]]::new()
$cleanupDirectories = [Collections.Generic.List[string]]::new()
$cleanupFiles = [Collections.Generic.List[string]]::new()
$cleanupPending.Push($cleanupRoot)
while ($cleanupPending.Count) {
    $cleanupCurrent = $cleanupPending.Pop()
    if ([IO.File]::GetAttributes($cleanupCurrent) -band [IO.FileAttributes]::ReparsePoint) { throw 'The complete tree must contain no reparse points.' }
    $cleanupDirectories.Add($cleanupCurrent)
    foreach ($cleanupEntry in [IO.Directory]::EnumerateFileSystemEntries($cleanupCurrent)) {
        $cleanupAbsolute = [IO.Path]::GetFullPath($cleanupEntry)
        if (-not $cleanupAbsolute.StartsWith($cleanupRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Cleanup escaped the named new UUID.' }
        $cleanupAttributes = [IO.File]::GetAttributes($cleanupAbsolute)
        if ($cleanupAttributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The complete tree must contain no reparse points.' }
        if ($cleanupAttributes -band [IO.FileAttributes]::Directory) { $cleanupPending.Push($cleanupAbsolute) }
        elseif ($cleanupAbsolute -cne $cleanupOwnerPath) { $cleanupFiles.Add($cleanupAbsolute) }
    }
}
$cleanupHistory = Join-Path $env:AE_WORKSPACE 'artifacts/acceptance/retest-history'
Copy-Item -LiteralPath $cleanupReportPath -Destination (Join-Path $cleanupHistory ("workbuddy-$ExpectedId-failed.json"))
Assert-NoDiagnosticProcesses
Assert-CurrentDiagnosticOwner
foreach ($cleanupFile in $cleanupFiles) {
    if ([IO.File]::GetAttributes($cleanupFile) -band [IO.FileAttributes]::ReparsePoint) { throw 'An audited file changed before removal.' }
    [IO.File]::Delete($cleanupFile)
}
for ($cleanupIndex = $cleanupDirectories.Count - 1; $cleanupIndex -gt 0; $cleanupIndex--) {
    if ([IO.File]::GetAttributes($cleanupDirectories[$cleanupIndex]) -band [IO.FileAttributes]::ReparsePoint) { throw 'An audited directory changed before removal.' }
    [IO.Directory]::Delete($cleanupDirectories[$cleanupIndex], $false)
}
Assert-CurrentDiagnosticOwner -ExecutableAlreadyRemoved
[IO.File]::Delete($cleanupOwnerPath)
[IO.Directory]::Delete($cleanupRoot, $false)
if (Test-Path -LiteralPath $cleanupRoot) { throw 'The named new UUID was not fully removed.' }
$cleanupReport.cleanup = @{
    removed = $true; ownerValidated = $true; processesStopped = $true
    wholeTreeReparseAuditPassed = $true; finalUuidProcessAuditPassed = $true
    nonRecursiveDirectoryRemoval = $true; originalSupervisorCleanupPassed = [bool]$cleanupReport.supervisor.processesStopped
    scope = "Only the explicitly named current WorkBuddy diagnostic UUID $ExpectedId"
    recoveryReason = 'Fresh read-only audits proved all UUID processes exited; this script never terminates a process.'
    filesRemoved = $cleanupFiles.Count + 1; directoriesRemoved = $cleanupDirectories.Count
}
[IO.File]::WriteAllText($cleanupReportPath, ($cleanupReport | ConvertTo-Json -Depth 60), [Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath $cleanupReportPath -Destination (Join-Path $cleanupHistory ("workbuddy-$ExpectedId-cleaned.json"))
$cleanupReport.cleanup | ConvertTo-Json
