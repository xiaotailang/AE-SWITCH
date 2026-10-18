[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../../scripts/workspace-env.ps1')
if(-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7){throw 'Windows PowerShell 7 required.'}
$observationWorkspace=[IO.Path]::GetFullPath($env:AE_WORKSPACE)
if($observationWorkspace -notmatch '^[Gg]:\\'){throw 'G workspace required.'}
$observationId=[Guid]::NewGuid().ToString('N')
$observationRoot=Join-Path $observationWorkspace ('.cache/native-process-observation/'+$observationId)
$observationReport=Join-Path $observationWorkspace ('artifacts/acceptance/native-process-observation-'+$observationId+'.json')
$observationUtf8=[Text.UTF8Encoding]::new($false)
$observationProcesses=[Collections.Generic.List[object]]::new()
$observationParent=$null
$e2eOwnedNativeProcesses=@{}
$observationChecks=[Collections.Generic.List[object]]::new()
$observationMarker=Join-Path $observationRoot '.ae-process-observation-owner.json'
function Assert-ObservationOrdinary([string]$value){
    $resolved=[IO.Path]::GetFullPath($value)
    if($resolved -ne $observationRoot -and -not $resolved.StartsWith($observationRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Exact fixture child required.'}
    for($cursor=$resolved;$cursor;$cursor=[IO.Path]::GetDirectoryName($cursor)){if([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint){throw 'Redirected fixture refused.'}}
}
function Assert-Observation([bool]$value,[string]$name){if(-not $value){throw $name};$observationChecks.Add(@{name=$name;passed=$true})}
[IO.Directory]::CreateDirectory($observationRoot)|Out-Null
Assert-ObservationOrdinary $observationRoot
[IO.File]::WriteAllText($observationMarker,(@{id=$observationId;workspace=$observationWorkspace;purpose='Actual Windows short-lived process observation'}|ConvertTo-Json),$observationUtf8)
$observationMarkerHash=(Get-FileHash -LiteralPath $observationMarker).Hash
$observationReceipt=@{id=$observationId;recordedAt=[DateTime]::UtcNow.ToString('o');passed=$false;actualWindowsProcesses=$true;officialClientsExecuted=$false;guiLaunched=$false;externalProcessesStopped=$false;cleanup=@{removed=$false}}
try{
    $observationWrapper=Join-Path $observationWorkspace 'scripts/verify-portable-e2e.ps1'
    $observationReceipt.wrapperSha256=(Get-FileHash -LiteralPath $observationWrapper).Hash.ToLowerInvariant()
    $tokens=$null;$parseErrors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile($observationWrapper,[ref]$tokens,[ref]$parseErrors)
    if($parseErrors.Count){throw 'Wrapper AST invalid.'}
    $functions=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$true))
    foreach($name in @('Assert-E2eLocalPath','Initialize-E2eNativeProcessInterop','Assert-E2eNativeOwner','Assert-E2eNativeOrdinaryFile','Get-E2eNativeProcessById','Get-E2eNativeProcessPath','Get-E2eNativeProcessSnapshot','Get-E2eNativeProcessDetails','Get-E2eNativeProcessScope','New-E2eNativeProcessIdentity','Assert-E2eNativeProcessIdentity','Get-E2eNativeLaunchRequest','Write-E2eNativeLaunchAcknowledgment','Publish-E2eNativeLaunchProof','Add-E2eNativeChildDiagnostic','Record-E2eNativeChildren')){
        $selected=@($functions|Where-Object Name -ceq $name)
        if($selected.Count -ne 1){throw ('Exact wrapper function required: '+$name)}
        . ([scriptblock]::Create($selected[0].Extent.Text))
    }
    Initialize-E2eNativeProcessInterop
    Assert-Observation ($null -ne [AEE2eNativeProcess].GetMethod('Snapshot')) 'Native snapshot observation is required for short-lived launchers'
    Assert-Observation ($null -ne [AEE2eNativeProcess].GetMethod('Details')) 'Command line and parent identity must be read from the retained process handle'
    $systemPowerShell=Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell/v1.0/powershell.exe'
    $fixtureScript=Join-Path $observationRoot 'short-lived 中文.ps1'
    [IO.File]::WriteAllText($fixtureScript,"Start-Sleep -Milliseconds 150`r`nexit 0`r`n",$observationUtf8)
    $e2eWorkspace=$observationWorkspace
    $e2eBase=[IO.Path]::GetDirectoryName($observationRoot)
    $e2eIdentifier=$observationId
    $e2eSandbox=$observationRoot
    $e2eMarker=$observationMarker
    $e2ePurpose='Actual Windows short-lived process observation'
    [IO.File]::WriteAllText($observationMarker,(@{id=$observationId;workspace=$observationWorkspace;purpose=$e2ePurpose}|ConvertTo-Json),$observationUtf8)
    $observationMarkerHash=(Get-FileHash -LiteralPath $observationMarker).Hash
    $e2eNativeMarkerHash=$observationMarkerHash.ToLowerInvariant()
    $e2eSharedRuntimeFiles=@{}
    $e2eInstalledClientFixtures=@{payload=@{profiles=@{codex=@{executablePath=$fixtureScript}}}}
    $e2eNativeIdentityFailure=$false
    $e2eNativeChildDiagnostics=[Collections.Generic.List[object]]::new()
    $observationParent=[Diagnostics.Process]::GetCurrentProcess()
    $e2eOwnedNativeProcesses[$PID]=New-E2eNativeProcessIdentity $observationParent @{kind='fixture-observer-parent';launcher=''}
    $observed=[Collections.Generic.List[object]]::new()
    for($iteration=0;$iteration -lt 8;$iteration++){
        $start=[Diagnostics.ProcessStartInfo]::new($systemPowerShell)
        $start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.WorkingDirectory=$observationRoot
        foreach($argument in @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$fixtureScript)){$start.ArgumentList.Add($argument)}
        $process=[Diagnostics.Process]::Start($start);$null=$process.Handle
        $observationProcesses.Add(@{process=$process;created=$process.StartTime.ToUniversalTime();image=[AEE2eNativeProcess]::ProcessPath($process.Handle)})
        $clock=[Diagnostics.Stopwatch]::StartNew();$seen=$false
        while(-not $process.HasExited -and $clock.ElapsedMilliseconds -lt 2000){
            $candidate=@([AEE2eNativeProcess]::Snapshot()|Where-Object ProcessId -eq $process.Id)
            if($candidate.Count -eq 1){
                $details=[AEE2eNativeProcess]::Details($process.Handle)
                $arguments=[AEE2eNativeProcess]::Arguments($details.CommandLine)
                Assert-Observation ($candidate[0].ParentProcessId -eq $PID -and $details.ParentProcessId -eq $PID) ('Snapshot and live handle parent match '+$iteration)
                Assert-Observation ($arguments.Length -eq 8 -and $arguments[7] -ceq $fixtureScript) ('Exact Unicode entry arguments preserved '+$iteration)
                Record-E2eNativeChildren
                Assert-Observation ($e2eOwnedNativeProcesses.ContainsKey($process.Id)) ('Unmodified wrapper records actual short-lived child '+$iteration)
                $identity=$e2eOwnedNativeProcesses[$process.Id]
                Assert-Observation ($identity.nativeLaunch -and $identity.launcher -ceq $fixtureScript -and $identity.parentId -eq $PID -and $identity.started.Ticks -eq $process.StartTime.ToUniversalTime().Ticks) ('Wrapper retains exact entry, parent and creation identity '+$iteration)
                $seen=$true;$seenWithinMilliseconds=$clock.ElapsedMilliseconds;break
            }
            Start-Sleep -Milliseconds 10
        }
        Assert-Observation $seen ('Short-lived actual child observed '+$iteration)
        Assert-Observation ($process.WaitForExit(5000) -and $process.ExitCode -eq 0) ('Retained actual child exited normally '+$iteration)
        Assert-Observation ($identity.process.WaitForExit(5000) -and $identity.process.ExitCode -eq 0) ('Wrapper retained handle confirms normal exit '+$iteration)
        $observed.Add(@{pid=$process.Id;parentId=$PID;exitCode=$process.ExitCode;observedWithinMilliseconds=$seenWithinMilliseconds;retainedHandle=$true;ordinaryImageVerified=($observationProcesses[$iteration].image -ieq $systemPowerShell)})
    }
    $observationReceipt.observedProcesses=$observed.ToArray()
    Assert-Observation (@([AEE2eNativeProcess]::Snapshot()|Where-Object ProcessId -in @($observed.pid)).Count -eq 0) 'Exited children absent from actual process snapshot'
    Assert-Observation (@([AEE2eNativeProcess]::Snapshot()|Where-Object ProcessId -eq $PID).Count -eq 1) 'Observer actual parent exists exactly once'
    $observationReceipt.retainedIdentityCount=$e2eOwnedNativeProcesses.Count
    $observationReceipt.nativeIdentityFailure=$e2eNativeIdentityFailure
    $observationReceipt.retainedIdentities=@($e2eOwnedNativeProcesses.Values|ForEach-Object {@{pid=$_.process.Id;parentId=$_.parentId;kind=$_.kind;normalExit=if($_.process.Id -ne $PID){$_.process.WaitForExit(5000) -and $_.process.ExitCode -eq 0}else{$false}}})
    $launchers=@($e2eOwnedNativeProcesses.Values|Where-Object kind -eq 'official-powershell-launcher')
    $consoles=@($e2eOwnedNativeProcesses.Values|Where-Object kind -eq 'owned-console-host')
    $conhost=Join-Path ([Environment]::GetFolderPath('System')) 'conhost.exe'
    Assert-Observation (-not $e2eNativeIdentityFailure -and $launchers.Count -eq 8 -and $e2eOwnedNativeProcesses.Count -eq (9+$consoles.Count)) 'Only eight launchers, their proved console children and the retained parent are owned'
    Assert-Observation ($consoles.Count -le 8 -and @($consoles|Where-Object {$_.parentId -notin @($observed.pid) -or $_.path -ine $conhost -or $_.nativeLaunch}).Count -eq 0) 'Every auxiliary console belongs to an exact observed launcher'
    Assert-Observation (@($observationReceipt.retainedIdentities|Where-Object {$_.pid -ne $PID -and -not $_.normalExit}).Count -eq 0) 'All recorded launcher and console handles exit normally'
    $observationReceipt.unmodifiedWrapperRecorderExercised=$true
    $observationReceipt.passed=$true
}catch{$observationReceipt.error=$_.Exception.Message}
finally{
    try{
        foreach($retained in $observationProcesses){$retained.process.Refresh();if(-not $retained.process.HasExited){if($retained.process.StartTime.ToUniversalTime().Ticks -ne $retained.created.Ticks -or [AEE2eNativeProcess]::ProcessPath($retained.process.Handle) -ine $retained.image){throw 'Retained process identity changed; cleanup refused.'};if(-not $retained.process.WaitForExit(5000)){throw 'Actual fixture remains live; no external stop.'}}}
        Assert-ObservationOrdinary $observationMarker
        if((Get-FileHash -LiteralPath $observationMarker).Hash -cne $observationMarkerHash){throw 'Fixture owner changed.'}
        $owner=[IO.File]::ReadAllText($observationMarker)|ConvertFrom-Json
        if($owner.id -cne $observationId -or $owner.workspace -ine $observationWorkspace){throw 'Fixture owner mismatch.'}
        $entries=@([IO.Directory]::EnumerateFileSystemEntries($observationRoot))
        foreach($entry in $entries){Assert-ObservationOrdinary $entry;if([IO.File]::GetAttributes($entry) -band [IO.FileAttributes]::Directory){throw 'Unexpected fixture directory.'}}
        foreach($entry in $entries){if($entry -ne $observationMarker){[IO.File]::Delete($entry)}}
        [IO.File]::Delete($observationMarker);[IO.Directory]::Delete($observationRoot,$false)
        $observationReceipt.cleanup=@{removed=(-not [IO.Directory]::Exists($observationRoot));recursiveDeletionUsed=$false;ownerVerified=$true;allActualProcessesExited=$true}
    }catch{$observationReceipt.cleanup.error=$_.Exception.Message;$observationReceipt.passed=$false}
    foreach($retained in $observationProcesses){$retained.process.Dispose()}
    foreach($identity in $e2eOwnedNativeProcesses.Values){if($identity.process -ne $observationParent){$identity.process.Dispose()}}
    if($observationParent){$observationParent.Dispose()}
    $observationReceipt.checks=$observationChecks.ToArray()
    [IO.File]::WriteAllText($observationReport,($observationReceipt|ConvertTo-Json -Depth 12)+"`n",$observationUtf8)
}
@{report=$observationReport;passed=$observationReceipt.passed;checks=$observationChecks.Count;cleanupRemoved=$observationReceipt.cleanup.removed}|ConvertTo-Json -Compress
if(-not $observationReceipt.passed -or -not $observationReceipt.cleanup.removed){exit 1}
