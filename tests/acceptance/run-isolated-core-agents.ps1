[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{32}$')][string]$OwnerId,
    [Parameter(Mandatory)][string]$Model,
    [Parameter(Mandatory)][ValidateSet('none','minimal','low','medium','high','xhigh','max','ultra')][string]$ReasoningEffort,
    [string]$Agents,
    [ValidateSet('1','2')][string]$Repeat = '1',
    [ValidateRange(60,7200)][int]$DeadlineSeconds = 4200
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7) { throw 'Windows PowerShell 7 is required.' }
$e2eWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
. (Join-Path $PSScriptRoot 'production-core-lifecycle.ps1')
foreach ($definition in Import-ProductionCoreCleanup) { . ([ScriptBlock]::Create($definition)) }
if ($e2eWorkspace -notmatch '^[Gg]:[\\/]') { throw 'The production fixture must stay on G:.' }

$e2eIdentifier = $OwnerId
$e2eSandbox = Assert-E2eLocalPath (Join-Path $e2eWorkspace ('.cache/native-e2e-sandbox/' + $e2eIdentifier))
$setupPath = Assert-E2eLocalPath (Join-Path $e2eSandbox 'setup.json')
$setup = [IO.File]::ReadAllText($setupPath) | ConvertFrom-Json -AsHashtable
$e2eCleanupMode = 'isolated-core-job'
$e2eCleanupNonce = $setup.autoCleanup.nonce
if ($setup.schemaVersion -ne 2 -or $setup.ownerId -cne $e2eIdentifier -or
    $setup.autoCleanup.schemaVersion -ne 1 -or $setup.autoCleanup.mode -cne $e2eCleanupMode) {
    throw 'A fresh prepared isolated-core cleanup capability is required.'
}
if ($setup.workspace -ine $e2eWorkspace -or $setup.root -ine $e2eSandbox) {
    throw 'The setup does not belong to this exact UUID root.'
}
$e2eMarker = Assert-E2eLocalPath (Join-Path $e2eSandbox '.ae-production-ui-eight-owner.json')
$e2eNativeMarkerHash = (Get-FileHash -LiteralPath $e2eMarker -Algorithm SHA256).Hash
$e2eOwnedNativeProcesses = @{}
$NativeUi = $true
$e2eUtf8 = [Text.UTF8Encoding]::new($false)
Assert-E2eNativeOwner
$marker = [IO.File]::ReadAllText($e2eMarker) | ConvertFrom-Json -AsHashtable
if ($setup.sourceDigest -cne $marker.sourceDigest -or $setup.buildAuditId -cne $marker.buildAuditId -or
    $setup.productionSha256 -cne $marker.productionSha256) { throw 'The setup and production marker disagree.' }

$reportParent = Assert-E2eLocalPath (Join-Path $e2eWorkspace 'artifacts/acceptance')
$null = [IO.Directory]::CreateDirectory($reportParent)
$runnerReport = Assert-E2eLocalPath (Join-Path $reportParent ('isolated-core-agents-' + $e2eIdentifier + '.json'))
$e2eReport = Assert-E2eLocalPath (Join-Path $reportParent ('isolated-core-cleanup-' + $e2eIdentifier + '.json'))
$gate = Assert-E2eLocalPath (Join-Path $e2eSandbox '.ae-isolated-core-start')
$record = [ordered]@{ schemaVersion=1; ownerId=$e2eIdentifier; sandbox=$e2eSandbox; startedAt=[DateTimeOffset]::UtcNow.ToString('o');
    runnerExitCode=$null; runnerReportPresent=$false; attachedBeforeLaunch=$false; jobDrained=$false;
    activeDescendantsAfterWait=$null; phase='prepare';
    unprovedExternalProcessStopped=$false; cleanup=@{removed=$false}; passed=$false }
$reserve = [IO.File]::Open($e2eReport, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
$reserve.Dispose()

$job = $null
$runner = $null
try {
    if ((Test-Path -LiteralPath $gate) -or (Test-Path -LiteralPath $runnerReport)) { throw 'The prepared isolated core run is not fresh.' }
    . (Join-Path $e2eWorkspace 'scripts/workspace-env.ps1')
    Initialize-ProductionCoreJob
    $job = [AEProductionCoreJob]::new()
    $launch = [Diagnostics.ProcessStartInfo]::new()
    $launch.FileName = Assert-E2eLocalPath (Join-Path $e2eWorkspace '.tools/node/node.exe')
    $launch.WorkingDirectory = $e2eWorkspace
    $launch.UseShellExecute = $false
    $launch.CreateNoWindow = $true
    $launch.Environment['AE_ISOLATED_CORE_JOB_NONCE'] = $e2eCleanupNonce
    foreach ($argument in @((Join-Path $PSScriptRoot 'isolated-core-agents.mjs'), '--setup', $setupPath,
            '--model', $Model, '--reasoning-effort', $ReasoningEffort, '--repeat', $Repeat, '--report', $runnerReport)) {
        $launch.ArgumentList.Add($argument)
    }
    if ($Agents) { $launch.ArgumentList.Add('--agents'); $launch.ArgumentList.Add($Agents) }
    $record.phase = 'assign-job'
    $runner = [Diagnostics.Process]::Start($launch)
    $job.Attach($runner.Handle)
    Assert-E2eNativeOwner
    $record.attachedBeforeLaunch = $true
    $gateStream = [IO.File]::Open($gate, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
    try { $gateStream.Write($e2eUtf8.GetBytes($e2eCleanupNonce)) } finally { $gateStream.Dispose() }
    $record.phase = 'wait-runner'
    if (-not $runner.WaitForExit($DeadlineSeconds * 1000)) { throw 'The supervised runner is still live; the fixture remains closed to cleanup.' }
    $record.runnerExitCode = $runner.ExitCode
    $record.runnerReportPresent = Test-Path -LiteralPath $runnerReport -PathType Leaf
    $record.phase = 'wait-descendants'
    $drain = [Diagnostics.Stopwatch]::StartNew()
    while ($job.ActiveProcesses -ne 0 -and $drain.ElapsedMilliseconds -lt 10000) { Start-Sleep -Milliseconds 100 }
    $record.activeDescendantsAfterWait = $job.ActiveProcesses
    if ($record.activeDescendantsAfterWait -ne 0) { throw 'An owned descendant remains live, so the fixture is retained.' }
    $record.jobDrained = $true
    $record.passed = $record.runnerExitCode -eq 0 -and $record.runnerReportPresent
} catch { $record.failure = 'Production core runner or descendant exit could not be verified.' }
finally {
    try {
        [IO.File]::WriteAllText($e2eReport, ($record | ConvertTo-Json -Depth 10), $e2eUtf8)
        if ($record.jobDrained) {
            $record.phase = 'cleanup'
            Remove-ProductionCoreFixture
            $record.cleanup.removed = $true
            $record.phase = 'finished'
        }
    } catch {
        $record.cleanup.failure = 'Fresh owned data was retained when cleanup could not finish safely.'
        $record.passed = $false
    } finally {
        if ($runner) { $runner.Dispose() }
        if ($job) { $job.Dispose() }
        $record.finishedAt = [DateTimeOffset]::UtcNow.ToString('o')
        [IO.File]::WriteAllText($e2eReport, ($record | ConvertTo-Json -Depth 10), $e2eUtf8)
    }
}
@{ ownerId=$e2eIdentifier; passed=$record.passed; sandboxRemoved=$record.cleanup.removed; cleanupReceipt=$e2eReport } | ConvertTo-Json -Compress
if (-not $record.passed -or -not $record.cleanup.removed) { exit 1 }
