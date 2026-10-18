[CmdletBinding()]
param()
. (Join-Path $PSScriptRoot '../../scripts/workspace-env.ps1')
$ErrorActionPreference='Stop'
if(-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7){throw 'Windows PowerShell 7 required.'}
$fixtureWorkspace=[IO.Path]::GetFullPath($env:AE_WORKSPACE)
$fixtureId=[Guid]::NewGuid().ToString('N')
$fixtureRoot=Join-Path $fixtureWorkspace ('.cache/native-launch-handshake/'+$fixtureId)
$fixtureMarker=Join-Path $fixtureRoot '.owner.json'
$fixtureChecks=[Collections.Generic.List[object]]::new()
$fixtureParent=$null;$fixtureChild=$null;$fixtureChildStart=$null
$e2eOwnedNativeProcesses=@{}
$fixtureReport=@{ownerId=$fixtureId;recordedAt=[datetime]::UtcNow.ToString('o');passed=$false;officialCliExecuted=$false;guiLaunched=$false;externalProcessesStopped=$false;strictLiveProofUsed=$true;cleanup=@{removed=$false}}
function Check-Fixture([bool]$value,[string]$name){if(-not $value){throw $name};$fixtureChecks.Add(@{name=$name;passed=$true})}
function Assert-FixturePath([string]$value){$full=[IO.Path]::GetFullPath($value);if($full-ne $fixtureRoot-and -not $full.StartsWith($fixtureRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Fixture path escaped its exact owner.'};for($cursor=$full;$cursor;$cursor=[IO.Path]::GetDirectoryName($cursor)){if([IO.File]::GetAttributes($cursor)-band [IO.FileAttributes]::ReparsePoint){throw 'Fixture reparse refused.'}}}
$null=[IO.Directory]::CreateDirectory($fixtureRoot)
Assert-FixturePath $fixtureRoot
$fixtureUtf8=[Text.UTF8Encoding]::new($false)
try{
 $wrapper=Join-Path $fixtureWorkspace 'scripts/verify-portable-e2e.ps1';$fixtureReport.wrapperSha256=(Get-FileHash -LiteralPath $wrapper).Hash.ToLowerInvariant()
 $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($wrapper,[ref]$tokens,[ref]$errors)
 Check-Fixture ($errors.Count-eq 0) 'Current wrapper AST parses'
 $functions=@($ast.FindAll({param($n)$n-is [Management.Automation.Language.FunctionDefinitionAst]},$true))
 foreach($name in @('Assert-E2eLocalPath','Initialize-E2eNativeProcessInterop','Assert-E2eNativeOwner','Assert-E2eNativeOrdinaryFile','Get-E2eNativeProcessById','Get-E2eNativeProcessPath','Get-E2eNativeProcessSnapshot','Get-E2eNativeProcessDetails','Get-E2eNativeProcessScope','New-E2eNativeProcessIdentity','Assert-E2eNativeProcessIdentity','New-E2eNativeLaunchWaitScript','Get-E2eNativeLaunchRequest','Write-E2eNativeLaunchAcknowledgment','Publish-E2eNativeLaunchProof','Add-E2eNativeChildDiagnostic','Record-E2eNativeChildren')){
  $selected=@($functions|Where-Object Name -ceq $name);if($selected.Count-ne 1){throw 'Exact current wrapper function missing.'};. ([scriptblock]::Create($selected[0].Extent.Text))
 }
 Initialize-E2eNativeProcessInterop
 $e2eWorkspace=$fixtureWorkspace;$e2eBase=[IO.Path]::GetDirectoryName($fixtureRoot);$e2eSandbox=$fixtureRoot;$e2eIdentifier=$fixtureId;$e2eMarker=$fixtureMarker;$e2ePurpose='AE Switch owned native UI and real tool acceptance'
 [IO.File]::WriteAllText($fixtureMarker,(@{id=$fixtureId;workspace=$fixtureWorkspace;purpose=$e2ePurpose}|ConvertTo-Json),$fixtureUtf8);$e2eNativeMarkerHash=(Get-FileHash -LiteralPath $fixtureMarker).Hash.ToLowerInvariant()
 $e2eSharedRuntimeFiles=@{};$e2eNativeIdentityFailure=$false;$e2eNativeChildDiagnostics=[Collections.Generic.List[object]]::new()
 $proofDirectory=Join-Path $fixtureRoot 'installed-clients/ui-launch-proof';$bin=Join-Path $fixtureRoot 'installed-clients/bin'
 $null=[IO.Directory]::CreateDirectory($proofDirectory);$null=[IO.Directory]::CreateDirectory($bin)
 $entry=Join-Path $bin 'codex.ps1';$dispatch=Join-Path $fixtureRoot 'dispatch-observed.txt'
 $preamble=New-E2eNativeLaunchWaitScript 'codex' $proofDirectory $fixtureId
 $childScript=$preamble+"`n[IO.File]::WriteAllText('"+$dispatch.Replace("'","''")+"','dispatched-after-proof')`nStart-Sleep -Milliseconds 150`nexit 0`n"
 [IO.File]::WriteAllText($entry,$childScript,[Text.UTF8Encoding]::new($true))
 $fixtureReport.fixtureEntrySha256=(Get-FileHash -LiteralPath $entry).Hash.ToLowerInvariant()
 $e2eInstalledClientFixtures=@{payload=@{launchProofDirectory=$proofDirectory;profiles=@{codex=@{executablePath=$entry}}}}
 $fixtureParent=[Diagnostics.Process]::GetCurrentProcess();$e2eQaProcess=$fixtureParent
 $qa=New-E2eNativeProcessIdentity $fixtureParent @{kind='fixture-observer-parent';launcher=''};$e2eOwnedNativeProcesses[$PID]=$qa
 $requestId=[Guid]::NewGuid().ToString('N');$requested=[datetime]::UtcNow
 $request=@{id='codex';ownerId=$fixtureId;requestId=$requestId;qaPid=$PID;qaStartedAt=$qa.started.ToString('o');qaSha256=$qa.sha256;launcher=$entry;requestedAt=$requested.ToString('o');deadlineAt=$requested.AddSeconds(20).ToString('o')}
 [IO.File]::WriteAllText((Join-Path $proofDirectory 'active-request.json'),($request|ConvertTo-Json),$fixtureUtf8)
 Record-E2eNativeChildren
 $readyFile=Join-Path $proofDirectory ('ready-codex-'+$requestId+'.json');Check-Fixture ([IO.File]::Exists($readyFile)) 'Observer acknowledges current owned QA before click'
 $ready=[IO.File]::ReadAllText($readyFile)|ConvertFrom-Json -DateKind String
 Check-Fixture ($ready.requestId-ceq $requestId-and $ready.qaPid-eq $PID-and $ready.ownedQaIdentityVerified) 'Ready acknowledgment binds this request and actual QA handle'
 $start=[Diagnostics.ProcessStartInfo]::new((Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell/v1.0/powershell.exe'))
 $start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.WorkingDirectory=$fixtureRoot
 foreach($arg in @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$entry)){$start.ArgumentList.Add($arg)}
 $fixtureChild=[Diagnostics.Process]::Start($start);$null=$fixtureChild.Handle;$fixtureChildStart=$fixtureChild.StartTime.ToUniversalTime()
 Start-Sleep -Milliseconds 4500
 $fixtureChild.Refresh()
 Check-Fixture (-not $fixtureChild.HasExited-and -not [IO.File]::Exists($dispatch)) 'Short dispatch stays alive across a 4.5 second observation gap until strict proof'
 Record-E2eNativeChildren
 Check-Fixture ($e2eOwnedNativeProcesses.ContainsKey($fixtureChild.Id)) 'Real wrapper snapshot discovers the held exact-entry child'
 $identity=$e2eOwnedNativeProcesses[$fixtureChild.Id]
 $proofFile=Join-Path $proofDirectory ('proof-codex-'+$requestId+'.json');Check-Fixture ([IO.File]::Exists($proofFile)) 'Unchanged live parent image scope and handle gates publish proof'
 $proof=[IO.File]::ReadAllText($proofFile)|ConvertFrom-Json -DateKind String
 Check-Fixture ($proof.pid-eq $fixtureChild.Id-and $proof.parentPid-eq $PID-and $proof.nativeLaunch-and $proof.retainedIdentityProofPassed-and ([datetime]$proof.startedAt).ToUniversalTime().Ticks-eq $fixtureChildStart.Ticks) 'Proof binds this exact process creation and zero argument launch'
 Check-Fixture (@([IO.Directory]::EnumerateFiles($proofDirectory,'*.tmp')).Count-eq 0) 'Ready and proof publish closed JSON atomically without leftover temporary files'
 $reportAssignment=@($ast.FindAll({param($n)$n-is [Management.Automation.Language.AssignmentStatementAst]-and $n.Left-is [Management.Automation.Language.VariableExpressionAst]-and $n.Left.VariablePath.UserPath-ceq 'e2eNativeResult'},$true))
 if($reportAssignment.Count-ne 1){throw 'Exact current Native report parser missing.'}
 $e2eNativeReport=$proofFile
 . ([scriptblock]::Create($reportAssignment[0].Extent.Text))
 Check-Fixture ($e2eNativeResult.startedAt-is [string]-and $identity.started.ToString('o')-ceq $e2eNativeResult.startedAt) 'Actual Native report parser preserves the exact retained creation timestamp text'
 Check-Fixture ($fixtureChild.WaitForExit(5000)-and $fixtureChild.ExitCode-eq 0-and $identity.process.WaitForExit(5000)-and $identity.process.ExitCode-eq 0) 'Held fixture dispatch and both retained handles exit normally'
 Check-Fixture ([IO.File]::Exists($dispatch)) 'Original dispatch runs only after proof acknowledgment'
 $proofBeforeHash=(Get-FileHash -LiteralPath $proofFile).Hash
 Write-E2eNativeLaunchAcknowledgment (Get-E2eNativeLaunchRequest) 'proof' $identity
 Check-Fixture ((Get-FileHash -LiteralPath $proofFile).Hash-eq $proofBeforeHash) 'Duplicate acknowledgment leaves the existing owned proof bytes unchanged'
 $old=$identity.Clone();$old.nativeLaunch=$false
 Publish-E2eNativeLaunchProof $old
 Check-Fixture ((Get-FileHash -LiteralPath $proofFile).Hash-eq $proofBeforeHash) 'Task probe does not replace existing proof'
 $fixtureReport.actualRetainedProcess=@{pid=$proof.pid;parentPid=$proof.parentPid;startedAt=$proof.startedAt;requestId=$requestId;nativeLaunch=$true;exitCode=0;observationGapMilliseconds=4500}
 $fixtureReport.passed=$true
}catch{$fixtureReport.errorType=$_.Exception.GetType().FullName;$fixtureReport.error=$_.Exception.Message}
finally{
 try{
  if($fixtureChild){$fixtureChild.Refresh();if(-not $fixtureChild.HasExited-and -not $fixtureChild.WaitForExit(22000)){throw 'Owned fixture child remains live; no external termination.'}}
  Assert-FixturePath $fixtureMarker
  if((Get-FileHash -LiteralPath $fixtureMarker).Hash.ToLowerInvariant()-cne $e2eNativeMarkerHash){throw 'Fixture owner changed.'}
  $pending=[Collections.Generic.Stack[string]]::new();$pending.Push($fixtureRoot);$directories=[Collections.Generic.List[string]]::new();$files=[Collections.Generic.List[string]]::new()
  while($pending.Count){$item=$pending.Pop();Assert-FixturePath $item;if([IO.File]::GetAttributes($item)-band [IO.FileAttributes]::Directory){$directories.Add($item);foreach($child in [IO.Directory]::EnumerateFileSystemEntries($item)){$pending.Push($child)}}else{$files.Add($item)}}
  foreach($file in $files){if($file-ne $fixtureMarker){[IO.File]::Delete($file)}}
  [IO.File]::Delete($fixtureMarker);foreach($dir in @($directories|Sort-Object Length -Descending)){[IO.Directory]::Delete($dir,$false)}
  $fixtureReport.cleanup=@{removed=(-not [IO.Directory]::Exists($fixtureRoot));recursiveDeletionUsed=$false;ownerVerified=$true;allActualProcessesExited=$true}
 }catch{$fixtureReport.cleanup.error=$_.Exception.Message;$fixtureReport.passed=$false}
 foreach($identity in $e2eOwnedNativeProcesses.Values){if($identity.process-ne $fixtureParent){$identity.process.Dispose()}}
 if($fixtureChild){$fixtureChild.Dispose()};if($fixtureParent){$fixtureParent.Dispose()}
 $fixtureReport.checks=$fixtureChecks.ToArray();$reportPath=Join-Path $fixtureWorkspace ('artifacts/acceptance/native-launch-handshake-'+$fixtureId+'.json')
 [IO.File]::WriteAllText($reportPath,($fixtureReport|ConvertTo-Json -Depth 10)+"`n",$fixtureUtf8)
}
@{passed=$fixtureReport.passed;checks=$fixtureChecks.Count;report=$reportPath;cleanupRemoved=$fixtureReport.cleanup.removed}|ConvertTo-Json -Compress
if(-not $fixtureReport.passed-or -not $fixtureReport.cleanup.removed){exit 1}
