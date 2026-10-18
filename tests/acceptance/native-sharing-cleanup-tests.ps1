#requires -Version 7.0
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'Actual Win32 file sharing regression requires Windows.' }
$lockWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
. (Join-Path $lockWorkspace 'scripts/workspace-env.ps1')
$lockId = [Guid]::NewGuid().ToString('N')
$lockRoot = Join-Path $lockWorkspace ('.cache/native-lock-cleanup-regression-' + $lockId)
$lockOwner = Join-Path $lockRoot '.ae-lock-regression-owner'
$lockUtf8 = [Text.UTF8Encoding]::new($false)
$lockChecks = 0
function Check-Lock([bool]$Value, [string]$Label) {
    if (-not $Value) { throw ('Sharing cleanup regression failed: ' + $Label) }
    $script:lockChecks++
}
$lockTokens = $null; $lockErrors = $null
$lockAst = [Management.Automation.Language.Parser]::ParseFile((Join-Path $lockWorkspace 'scripts/verify-portable-e2e.ps1'), [ref]$lockTokens, [ref]$lockErrors)
Check-Lock ($lockErrors.Count -eq 0) 'wrapper parser'
foreach ($name in @('Assert-E2eLocalPath', 'Remove-E2eOwnedTree', 'Test-E2eCleanupSharingViolation',
    'Assert-E2eNativeCleanupRetryScope', 'Remove-E2eOwnedLockedFile',
    'Test-E2eCleanupDirectoryNotEmpty', 'Wait-E2eOwnedDirectoryRetry',
    'Initialize-E2eNativeProcessInterop', 'Assert-E2eNativeOwner', 'Assert-E2eNativeProcessesExited',
    'Get-E2eNativeProcessById', 'Get-E2eNativeProcessPath', 'Test-E2eNativeCreationTime')) {
    $definition = $lockAst.Find({ param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name
    }, $false)
    if (-not $definition) { throw ('Required sharing cleanup boundary is missing: ' + $name) }
    . ([scriptblock]::Create($definition.Extent.Text))
}
$script:e2eWorkspace = $lockWorkspace
$script:NativeUi = $true
$script:e2eUtf8 = $lockUtf8
if ($lockRoot -notlike 'G:\*' -or -not $lockRoot.StartsWith($lockWorkspace + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture must remain under this G workspace.' }
$null = Assert-E2eLocalPath $lockRoot
if (Test-Path -LiteralPath $lockRoot) { throw 'Sharing fixture root must be fresh.' }
[IO.Directory]::CreateDirectory($lockRoot) | Out-Null
[IO.File]::WriteAllText($lockOwner, $lockId, $lockUtf8)
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Threading;
public sealed class AEOwnedSharingFixture : IDisposable {
    private FileStream file;
    private Thread thread;
    public bool Released;
    public AEOwnedSharingFixture(string path, int releaseMs) {
        file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (releaseMs >= 0) {
            thread = new Thread(() => { Thread.Sleep(releaseMs); Release(); });
            thread.IsBackground = true; thread.Start();
        }
    }
    private void Release() { lock(this) { if (file != null) { file.Dispose(); file = null; } Released = true; } }
    public void Dispose() { Release(); if (thread != null && !thread.Join(5000)) throw new InvalidOperationException("Owned sharing fixture thread did not finish."); }
}
'@
function New-LockCase {
    $script:e2eBase = Join-Path $lockRoot 'cases'
    $script:e2eIdentifier = [Guid]::NewGuid().ToString('N')
    $script:e2eSandbox = Join-Path $e2eBase $e2eIdentifier
    $script:e2eMarker = Join-Path $e2eSandbox '.ae-native-e2e-owner.json'
    $script:e2ePurpose = 'AE Switch owned native UI and real tool acceptance'
    $script:e2eReport = Join-Path $lockRoot ($e2eIdentifier + '-report.json')
    $script:e2eOwnedNativeProcesses = @{}
    $null = Assert-E2eLocalPath $e2eSandbox
    [IO.Directory]::CreateDirectory((Join-Path $e2eSandbox 'portable/data')) | Out-Null
    [IO.File]::WriteAllText($e2eMarker, (@{ id=$e2eIdentifier; workspace=$e2eWorkspace; purpose=$e2ePurpose } | ConvertTo-Json), $lockUtf8)
    $script:e2eNativeMarkerHash = (Get-FileHash -LiteralPath $e2eMarker).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText($e2eReport, (@{ sandbox=$e2eSandbox; passed=$false; cleanup=@{removed=$false} } | ConvertTo-Json), $lockUtf8)
    $path = Join-Path $e2eSandbox 'portable/data/locked.txt'
    [IO.File]::WriteAllText($path, 'Owned sharing fixture only.', $lockUtf8)
    return $path
}
$holder = $null
try {
    Check-Lock (-not (Test-E2eCleanupSharingViolation ([IO.IOException]::new('Nonsharing fixture error.')))) 'ordinary IO errors are not retried'
    Check-Lock (-not (Test-E2eCleanupSharingViolation ([UnauthorizedAccessException]::new('Denied fixture error.')))) 'access denied is not retried'
    $path = New-LockCase
    $holder = [AEOwnedSharingFixture]::new($path, 450)
    $timer = [Diagnostics.Stopwatch]::StartNew()
    Remove-E2eOwnedTree $e2eSandbox -LockRetryTimeoutMs 4000
    Check-Lock ($holder.Released -and -not (Test-Path -LiteralPath $e2eSandbox) -and $timer.ElapsedMilliseconds -ge 350) 'real sharing lock releases naturally and exact sandbox cleanup succeeds'
    $holder.Dispose(); $holder = $null

    $path = New-LockCase
    $holder = [AEOwnedSharingFixture]::new($path, -1)
    $timer.Restart(); $rejected = $false
    try { Remove-E2eOwnedTree $e2eSandbox -LockRetryTimeoutMs 550 } catch { $rejected = $true }
    $evidence = [IO.File]::ReadAllText($e2eReport) | ConvertFrom-Json
    Check-Lock ($rejected -and $timer.ElapsedMilliseconds -lt 4000) 'held lock obeys aggregate deadline'
    Check-Lock ((Test-Path -LiteralPath $path) -and (Test-Path -LiteralPath $e2eMarker)) 'timeout retains held data and original marker'
    Check-Lock (-not $evidence.cleanup.removed -and -not $evidence.cleanup.installationAndRuntimeDataRemoved -and -not $evidence.cleanup.unprovedExternalProcessStopped) 'timeout records failed cleanup without an external stop'
    $holder.Dispose(); $holder = $null
    Remove-E2eOwnedTree $e2eSandbox -LockRetryTimeoutMs 550
    Check-Lock (-not (Test-Path -LiteralPath $e2eSandbox)) 'released timeout fixture can be precisely cleaned later'

    $path = New-LockCase
    $holder = [AEOwnedSharingFixture]::new($path, -1)
    [IO.File]::AppendAllText($e2eMarker, ' ', $lockUtf8)
    $rejected = $false
    try { Remove-E2eOwnedTree $e2eSandbox -LockRetryTimeoutMs 550 } catch { $rejected = $true }
    Check-Lock ($rejected -and (Test-Path -LiteralPath $path) -and (Test-Path -LiteralPath $e2eMarker)) 'retry rejects changed original owner bytes'
    $evidence = [IO.File]::ReadAllText($e2eReport) | ConvertFrom-Json
    Check-Lock (-not $evidence.cleanup.ownerMarkerVerified) 'changed marker is not recorded as currently verified'
    $holder.Dispose(); $holder = $null
    [IO.File]::WriteAllText($e2eMarker, (@{ id=$e2eIdentifier; workspace=$e2eWorkspace; purpose=$e2ePurpose } | ConvertTo-Json), $lockUtf8)
    Remove-E2eOwnedTree $e2eSandbox -LockRetryTimeoutMs 550

    $path = New-LockCase
    $holder = [AEOwnedSharingFixture]::new($path, -1)
    $ownedProcess = [Diagnostics.Process]::GetCurrentProcess()
    $script:e2eOwnedNativeProcesses = @{ current=@{process=$ownedProcess} }
    $rejected = $false
    try { Remove-E2eOwnedTree $e2eSandbox -LockRetryTimeoutMs 550 } catch { $rejected = $true }
    Check-Lock ($rejected -and -not $ownedProcess.HasExited -and (Test-Path -LiteralPath $e2eMarker)) 'retry refuses a retained live process and leaves it running'
    $script:e2eOwnedNativeProcesses = @{}; $ownedProcess.Dispose()
    $holder.Dispose(); $holder = $null
    Remove-E2eOwnedTree $e2eSandbox -LockRetryTimeoutMs 550
} finally {
    if ($holder) { $holder.Dispose() }
    $null = Assert-E2eLocalPath $lockRoot
    if ([IO.File]::ReadAllText($lockOwner) -cne $lockId) { throw 'Sharing fixture ownership changed; teardown refused.' }
    # Successful cases leave only flat receipt files, the owner and an empty cases directory.
    $cases = Join-Path $lockRoot 'cases'
    $null = Assert-E2eLocalPath $cases
    if (@([IO.Directory]::GetFileSystemEntries($cases)).Count) { throw 'An owned case remains; fixture evidence retained.' }
    [IO.Directory]::Delete($cases)
    foreach ($entry in [IO.Directory]::GetFileSystemEntries($lockRoot)) {
        $null = Assert-E2eLocalPath $entry
        if ((Get-Item -LiteralPath $entry -Force).PSIsContainer) { throw 'Unexpected sharing teardown directory.' }
        [IO.File]::Delete($entry)
    }
    [IO.Directory]::Delete($lockRoot)
}
[ordered]@{ passed=$true; testsPassed=$lockChecks; ownedFixtureRemoved=$true;
    realWin32SharingLockExercised=$true; externalProcessStopped=$false; guiLaunched=$false;
    wrapperMainExecuted=$false; officialClientStarted=$false } | ConvertTo-Json
