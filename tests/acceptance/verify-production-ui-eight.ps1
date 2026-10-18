[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$SetupFile,
  [ValidateRange(60,7200)][int]$WholeRunTimeoutSeconds=3600
)
$ErrorActionPreference='Stop'
$e2eWorkspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
. (Join-Path $e2eWorkspace 'scripts/workspace-env.ps1')
if($PSVersionTable.PSVersion.Major -lt 7){throw 'Workspace PowerShell 7 required'}
$setup=Get-Content -LiteralPath $SetupFile -Raw -Encoding UTF8|ConvertFrom-Json -AsHashtable
$e2eIdentifier=$setup.ownerId
$e2eSandbox=[IO.Path]::GetFullPath($setup.root)
$e2eMarker=Join-Path $e2eSandbox '.ae-production-ui-eight-owner.json'
$e2ePortableRoot=$setup.portableRoot
$e2eInstalledClientFixtures=$setup.fixtures
$e2eSharedRuntimeFiles=$setup.fixtures.sharedRuntimeFiles
$e2eQaProcess=$null
$e2eOwnedNativeProcesses=@{}
$e2eNativeChildDiagnostics=[Collections.Generic.List[object]]::new()
$e2eNativeIdentityFailure=$false
$e2eNativeExternalGitObservation=$null
$e2eNativeRootReferenceObservation=$null
$e2eNativeDiagnosticKeys=[Collections.Generic.HashSet[string]]::new()
$e2eNativeObservationCalls=0
$e2eNativeObservationTotalMs=0L
$e2eNativeObservationMaxMs=0L
$NativeUi=$true
$e2eUtf8=[Text.UTF8Encoding]::new($false)
$productionOutput=Join-Path $e2eWorkspace ('artifacts/acceptance/production-ui-eight-'+$e2eIdentifier)
$e2eReport=Join-Path $productionOutput 'supervisor-receipt.json'
$e2eNativeMarkerHash=(Get-FileHash -LiteralPath $e2eMarker -Algorithm SHA256).Hash.ToLowerInvariant()
$wrapper=Join-Path $e2eWorkspace 'scripts/verify-portable-e2e.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($wrapper,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Current process wrapper parser error'}
$fixtureFunctionsCurrent=[Collections.Generic.List[object]]::new()
foreach($expected in $setup.importedFixtureFunctions){
  $matches=@($ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst]},$true)|Where-Object Name -CEQ $expected.name)
  if($matches.Count -ne 1){throw 'Prepared fixture function absent'}
  $hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($matches[0].Extent.Text))).ToLowerInvariant()
  if($hash -cne $expected.sha256){throw ('Fixture body changed after preparation: '+$expected.name)}
  $fixtureFunctionsCurrent.Add(@{name=$expected.name;sha256=$hash;unchangedAfterPrepare=$true})
}
$imports=[Collections.Generic.List[object]]::new()
foreach($name in @('Assert-E2eLocalPath','Initialize-E2eNativeProcessInterop','Assert-E2eNativeOrdinaryFile','Get-E2eNativeProcessById','Get-E2eNativeProcessPath','Get-E2eNativeProcessSnapshot','Get-E2eNativeProcessDetails','Test-E2eNativeCreationTime','Get-E2eNativeProcessScope','New-E2eNativeProcessIdentity','Assert-E2eNativeProcessIdentity','Add-E2eNativeChildDiagnostic','Get-E2eNativeLaunchRequest','Write-E2eNativeLaunchAcknowledgment','Publish-E2eNativeLaunchProof','Record-E2eNativeChildren','Assert-E2eNativeProcessesExited','Test-E2eNativeExternalRootReference','Get-E2eNativeExternalGitImages','Assert-E2eNativeExternalObservationContext','Write-E2eNativeExternalObservation','Wait-E2eNativeExternalGitNaturalExit','Wait-E2eNativeRootReferenceNaturalExit','Stop-E2eNativeProcesses','Test-E2eCleanupSharingViolation','Assert-E2eNativeCleanupRetryScope','Remove-E2eOwnedLockedFile','Test-E2eCleanupDirectoryNotEmpty','Wait-E2eOwnedDirectoryRetry','Remove-E2eOwnedTree')){
  $definitions=@($ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst]},$true)|Where-Object Name -CEQ $name)
  if($definitions.Count -ne 1){throw ('Missing exact imported function '+$name)}
  $body=$definitions[0].Extent.Text
  $imports.Add(@{name=$name;sha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($body))).ToLowerInvariant()})
  . ([ScriptBlock]::Create($body))
}
function Assert-E2eNativeOwner {
  $null=Assert-E2eLocalPath $e2eSandbox
  if($e2eIdentifier -cnotmatch '^[a-f0-9]{32}$' -or $e2eSandbox -ine (Join-Path $e2eWorkspace ('.cache/native-e2e-sandbox/'+$e2eIdentifier))){throw 'Exact independent production root required'}
  $null=Assert-E2eLocalPath $e2eMarker
  if((Get-FileHash -LiteralPath $e2eMarker -Algorithm SHA256).Hash.ToLowerInvariant() -cne $e2eNativeMarkerHash){throw 'Production marker bytes changed'}
  $owner=Get-Content -LiteralPath $e2eMarker -Raw -Encoding UTF8|ConvertFrom-Json
  if($owner.ownerId -cne $e2eIdentifier -or $owner.workspace -ine $e2eWorkspace -or $owner.productionSha256 -cne $setup.productionSha256 -or $owner.sourceDigest -cne $setup.sourceDigest){throw 'Production owner binding changed'}
}
function Assert-ProductionBuildBinding {
  if($setup.schemaVersion -ne 2 -or $setup.buildAuditId -cnotmatch '^[a-f0-9]{32}$' -or $setup.sourceDigest -cnotmatch '^[a-f0-9]{64}$' -or $setup.productionSha256 -cnotmatch '^[a-f0-9]{64}$' -or $setup.sourceFiles -lt 1){throw 'Explicit current-build binding required'}
  $audit=Assert-E2eLocalPath $setup.auditDirectory
  if($setup.sourceManifest -ine (Join-Path $audit 'build-source-after.json')){throw 'Source manifest escaped the selected audit'}
  $expectedBindings=@('build-receipt.json','build-source-after.json','build-release-audit-outputs.json','.ae-release-audit-owner.json')
  if(@($setup.buildBindings).Count -ne $expectedBindings.Count){throw 'Incomplete build receipt bindings'}
  foreach($name in $expectedBindings){
    $file=Assert-E2eLocalPath (Join-Path $audit $name)
    $binding=@($setup.buildBindings|Where-Object path -IEQ $file)
    if($binding.Count -ne 1 -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $binding[0].sha256){throw ('Build receipt bytes changed: '+$name)}
  }
  $build=Get-Content -LiteralPath (Join-Path $audit 'build-receipt.json') -Raw -Encoding UTF8|ConvertFrom-Json
  $sourceBinding=Get-Content -LiteralPath $setup.sourceManifest -Raw -Encoding UTF8|ConvertFrom-Json
  if($build.id -cne $setup.buildAuditId -or $build.passed -ne $true -or $build.sourceUnchanged -ne $true -or $build.sourceDigest -cne $setup.sourceDigest -or $sourceBinding.digest -cne $setup.sourceDigest -or @($sourceBinding.files).Count -ne $setup.sourceFiles){throw 'Selected build/source identity mismatch'}
  $currentInputs=@()
  foreach($relative in @('app/src-tauri/src','app/src-tauri/resources','app/src-tauri/icons','app/src-tauri/capabilities','app/src','app/dist','app/public')){
    $directory=Assert-E2eLocalPath (Join-Path $e2eWorkspace $relative)
    if(Test-Path -LiteralPath $directory){$currentInputs+=@(Get-ChildItem -LiteralPath $directory -File -Recurse|ForEach-Object{[IO.Path]::GetRelativePath($e2eWorkspace,$_.FullName).Replace('\','/')})}
  }
  $currentInputs+=@('app/src-tauri/Cargo.toml','app/src-tauri/Cargo.lock','app/src-tauri/build.rs','app/package.json','app/pnpm-lock.yaml','app/tsconfig.json','app/vite.config.ts','app/index.html','app/postcss.config.js','app/tailwind.config.js','app/release-config.json','app/src-tauri/tauri.conf.json')
  $expectedInputs=@($sourceBinding.files|ForEach-Object path)
  if(@(Compare-Object @($currentInputs|Sort-Object -Unique) @($expectedInputs|Sort-Object -Unique)).Count){throw 'Current source input set changed'}
  $sourceLines=foreach($file in $sourceBinding.files){
    $hash=(Get-FileHash -LiteralPath (Assert-E2eLocalPath (Join-Path $e2eWorkspace $file.path)) -Algorithm SHA256).Hash.ToLowerInvariant()
    if($hash -cne $file.sha256){throw ('Current production source changed: '+$file.path)}
    $file.path+[char]0+$hash+"`n"
  }
  $digest=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes(($sourceLines -join '')))).ToLowerInvariant()
  if($digest -cne $setup.sourceDigest){throw 'Current production source digest changed'}
}
Assert-E2eNativeOwner
Assert-ProductionBuildBinding
$null=Assert-E2eLocalPath ([IO.Path]::GetFullPath($SetupFile))
if([IO.Path]::GetFullPath($SetupFile) -ine (Join-Path $e2eSandbox 'setup.json')){throw 'Exact owned setup required'}
if(Test-Path -LiteralPath $productionOutput){throw 'Production output must be fresh'}
$null=New-Item -ItemType Directory -Path $productionOutput
$receipt=[ordered]@{schemaVersion=2;ownerId=$e2eIdentifier;sandbox=$e2eSandbox;sourceDigest=$setup.sourceDigest;buildAuditId=$setup.buildAuditId;productionSha256=$setup.productionSha256;scope='Eight production UI confirmations plus eight independent native IPC probes on the same saved configuration; official tool write/read, no second UI click';startedAt=[DateTimeOffset]::UtcNow.ToString('o');wrapperSha256=(Get-FileHash -LiteralPath $wrapper -Algorithm SHA256).Hash.ToLowerInvariant();importedFunctions=$imports.ToArray();qaHooksUsed=$false;discoveryContextInjected=$false;passed=$false;cleanup=@{removed=$false;processesExited=$false};unprovedExternalProcessStopped=$false}
$receipt.buildBindings=$setup.buildBindings
$receipt.sourceFiles=$setup.sourceFiles
$receipt.supervisorSha256=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
$helperNames=@('production-ui-eight.mjs','prepare-production-ui-eight.ps1','production-ui-eight-contract.mjs','acceptance-private-values.mjs','wait-existing-tauri-page.mjs','verify-production-ui-eight-evidence.mjs','production-ui-surface.mjs')
$receipt.helperBindings=@(@($PSCommandPath,$wrapper,(Join-Path $e2eWorkspace 'tests/acceptance/native-existing-readback.mjs'))+@($helperNames|ForEach-Object{Join-Path $PSScriptRoot $_})|ForEach-Object{@{path=$_;sha256=(Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant()}})
if($setup.wrapperSha256 -cne $receipt.wrapperSha256 -or [IO.Path]::GetFullPath($setup.prepareHelper) -ine (Join-Path $PSScriptRoot 'prepare-production-ui-eight.ps1') -or (Get-FileHash -LiteralPath $setup.prepareHelper -Algorithm SHA256).Hash.ToLowerInvariant() -cne $setup.prepareHelperSha256){throw 'Prepared production source helpers changed before supervision'}
$receipt.preparedFixtureFunctions=$fixtureFunctionsCurrent.ToArray()
$wholeRunClock=[Diagnostics.Stopwatch]::StartNew()
$receipt.wholeRunTimeoutSeconds=$WholeRunTimeoutSeconds
$receipt.wholeRunDeadlineUtc=[DateTimeOffset]::UtcNow.AddSeconds($WholeRunTimeoutSeconds).ToString('o')
$receipt.wholeRunDeadlineNeverReset=$true
$receipt.wholeRunTimedOut=$false
function Assert-ProductionRunDeadline {
  if($wholeRunClock.Elapsed.TotalSeconds -ge $WholeRunTimeoutSeconds){
    $receipt.wholeRunTimedOut=$true
    throw 'Production UI whole-run deadline exceeded; retained ownership cleanup follows.'
  }
}
function Write-ProductionSupervisor { [IO.File]::WriteAllText($e2eReport,($receipt|ConvertTo-Json -Depth 45)+"`n",$e2eUtf8) }
Write-ProductionSupervisor
try {
  if(@([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()|Where-Object Port -EQ 9223).Count){throw 'CDP port occupied; external attach refused'}
  Assert-ProductionBuildBinding
  foreach($name in $setup.binaries.Keys){if((Get-FileHash -LiteralPath (Assert-E2eLocalPath (Join-Path $setup.portableRoot $name)) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $setup.binaries[$name]){throw ('Production package hash mismatch '+$name)}}
  foreach($name in @([Environment]::GetEnvironmentVariables('Process').Keys)){
    if($name -match '^UNI_SWITCH_QA_|^AE_NATIVE_|^AE_SWITCH_|KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION|^WEBVIEW2_|^PYTHONPATH$|^PYTHONHOME$|^VIRTUAL_ENV$|^NODE_PATH$|^NODE_OPTIONS$|^(?:OPENAI|ANTHROPIC|CLAUDE|CODEX|HERMES|PI_|OMP_|OPENCODE|ZCODE|WORKBUDDY|CODEBUDDY|DSH_)'){Remove-Item -LiteralPath ('Env:'+$name) -ErrorAction SilentlyContinue}
  }
  foreach($name in @('HOME','USERPROFILE','APPDATA','LOCALAPPDATA','PATH','PATHEXT','ProgramFiles','ProgramFiles(x86)','TEMP','TMP','TMPDIR','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME')){Remove-Item -LiteralPath ('Env:'+$name) -ErrorAction SilentlyContinue}
  foreach($name in $setup.fixtures.environment.Keys){
    if($name -match '^UNI_SWITCH_QA_|^AE_NATIVE_'){throw 'Fixture contains forbidden product test hook'}
    [Environment]::SetEnvironmentVariable($name,$setup.fixtures.environment[$name],'Process')
  }
  $env:AE_SWITCH_PORTABLE_ROOT=$setup.portableRoot
  $env:WEBVIEW2_BROWSER_EXECUTABLE_FOLDER=Join-Path $setup.portableRoot 'tools/webview2'
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9223'
  if(@([Environment]::GetEnvironmentVariables('Process').Keys|Where-Object {$_ -match '^UNI_SWITCH_QA_|^AE_NATIVE_'}).Count){throw 'Forbidden QA/native hook inherited'}
  $productCwd=Assert-E2eLocalPath (Join-Path $e2eSandbox 'installed-clients/workspace')
  $receipt.ordinaryDiscoveryLaunchCwd=$productCwd
  $productProcess=Start-Process -FilePath $setup.productionProgram -WorkingDirectory $productCwd -WindowStyle Hidden -RedirectStandardOutput (Join-Path $e2eSandbox 'production-stdout.log') -RedirectStandardError (Join-Path $e2eSandbox 'production-stderr.log') -PassThru
  $e2eQaProcess=$productProcess # Shared process-proof helpers retain their historical variable name.
  Initialize-E2eNativeProcessInterop
  $productIdentity=New-E2eNativeProcessIdentity $productProcess @{kind='owned-executable';launcher=''}
  Assert-E2eNativeProcessIdentity $productIdentity -VerifyHash
  if($productIdentity.path -ine $setup.productionProgram -or $productIdentity.sha256 -cne $setup.productionSha256){throw 'Retained production image mismatched'}
  $e2eOwnedNativeProcesses[$productProcess.Id]=$productIdentity
  $ready=$false
  for($attempt=0;$attempt -lt 120;$attempt++){
    Assert-ProductionRunDeadline
    Assert-E2eNativeProcessIdentity $productIdentity
    Record-E2eNativeChildren
    try {$targets=(Invoke-WebRequest -Uri 'http://127.0.0.1:9223/json/list' -TimeoutSec 1).Content|ConvertFrom-Json;if(@($targets|Where-Object type -EQ 'page').Count){$ready=$true;break}}catch{}
    Start-Sleep -Milliseconds 250
  }
  if(-not $ready){throw 'Owned production WebView startup failed'}
  Record-E2eNativeChildren
  $listeners=@(Get-NetTCPConnection -LocalPort 9223 -State Listen -ErrorAction Stop|Select-Object -ExpandProperty OwningProcess -Unique)
  if($listeners.Count -ne 1 -or -not $e2eOwnedNativeProcesses.ContainsKey([int]$listeners[0])){throw 'CDP listener is not a retained production descendant'}
  $webviewIdentity=$e2eOwnedNativeProcesses[[int]$listeners[0]]
  Assert-E2eNativeProcessIdentity $webviewIdentity -VerifyHash
  $expectedWebview=Assert-E2eLocalPath (Join-Path $setup.portableRoot 'tools/webview2/msedgewebview2.exe')
  if($webviewIdentity.path -ine $expectedWebview -or $webviewIdentity.sha256 -cne (Get-FileHash -LiteralPath $expectedWebview -Algorithm SHA256).Hash.ToLowerInvariant()){throw 'CDP owner is not the exact fixed owned WebView2 runtime'}
  $launch=Join-Path $e2eSandbox 'production-launch-receipt.json'
  $launchProof=@{ownerId=$e2eIdentifier;pid=$productProcess.Id;startedAt=$productIdentity.started.ToString('o');productionProgram=$productIdentity.path;productionSha256=$productIdentity.sha256;retainedHandleValidated=$true;ordinaryDiscoveryCwd=$productCwd;qaHooksUsed=$false;discoveryContextInjected=$false;cdpListener=@{pid=$webviewIdentity.process.Id;parentPid=$webviewIdentity.parentId;startedAt=$webviewIdentity.started.ToString('o');image=$webviewIdentity.path;sha256=$webviewIdentity.sha256;retainedDescendantValidated=$true}}
  [IO.File]::WriteAllText($launch,($launchProof|ConvertTo-Json -Depth 10)+"`n",$e2eUtf8)
  $receipt.productionPid=$productProcess.Id
  $runner=Join-Path $e2eWorkspace 'tests/acceptance/production-ui-eight.mjs'
  $node=Join-Path $e2eWorkspace '.tools/node/node.exe'
  Assert-ProductionRunDeadline
  $nodeProcess=Start-Process -FilePath $node -ArgumentList @('"'+$runner+'"','"'+[IO.Path]::GetFullPath($SetupFile)+'"','"'+$launch+'"') -WorkingDirectory $e2eWorkspace -WindowStyle Hidden -RedirectStandardOutput (Join-Path $productionOutput 'runner-stdout.log') -RedirectStandardError (Join-Path $productionOutput 'runner-stderr.log') -PassThru
  $nodeIdentity=New-E2eNativeProcessIdentity $nodeProcess @{kind='shared-official-runtime';launcher=''}
  Assert-E2eNativeProcessIdentity $nodeIdentity -VerifyHash
  $e2eOwnedNativeProcesses[$nodeProcess.Id]=$nodeIdentity
  while(-not $nodeProcess.WaitForExit(20)){Assert-ProductionRunDeadline;Record-E2eNativeChildren;Assert-E2eNativeProcessIdentity $productIdentity}
  Assert-ProductionRunDeadline
  $receipt.runnerExitCode=$nodeProcess.ExitCode
  $results=Get-Content -LiteralPath (Join-Path $productionOutput 'production-ui-results.json') -Raw -Encoding UTF8|ConvertFrom-Json
  $receipt.uiPassed=$results.passed -eq $true
  $receipt.passedCount=$results.passedCount
  $receipt.failedCount=$results.failedCount
  $receipt.firstPassedCount=$results.firstPassedCount
  $receipt.independentRetestPassedCount=$results.independentRetestPassedCount
  $receipt.launcherObservations=@($setup.fixtures.payload.profiles.Keys|ForEach-Object {
    $agentId=$_;$entry=$setup.fixtures.payload.profiles[$agentId].executablePath
    $nativeCodex=$agentId -ceq 'codex' -and $setup.fixtures.payload.ContainsKey('nativeCodexEntry') -and $setup.fixtures.payload.nativeCodexEntry -eq $true
    if($nativeCodex){
      $null=Assert-E2eLocalPath $entry
      if(-not $e2eSharedRuntimeFiles.ContainsKey($entry)){throw 'The native Codex entry is not a hash-bound official runtime.'}
      $observed=@($e2eOwnedNativeProcesses.Values|Where-Object {$_.kind -ceq 'shared-official-runtime' -and $_.path -ieq $entry -and $_.sha256 -ceq $e2eSharedRuntimeFiles[$entry] -and $e2eOwnedNativeProcesses.ContainsKey($_.parentId)})
    }else{
      $observed=@($e2eOwnedNativeProcesses.Values|Where-Object {$_.kind -ceq 'official-powershell-launcher' -and $_.launcher -ieq $entry})
    }
    @{agentId=$agentId;launcher=$entry;retainedProcessObserved=$observed.Count -gt 0;pids=@($observed|ForEach-Object {$_.process.Id});nativeOfficialEntry=$nativeCodex}
  })
  $receipt.allEightLauncherObserved=@($receipt.launcherObservations|Where-Object retainedProcessObserved -NE $true).Count -eq 0
  $receipt.passed=$results.passed -eq $true -and $results.firstPassedCount -eq 8 -and $results.independentRetestPassedCount -eq 8 -and $nodeProcess.ExitCode -eq 0 -and $receipt.allEightLauncherObserved -and -not $e2eNativeIdentityFailure
} catch {$receipt.failure=$_.Exception.Message;$receipt.passed=$false}
finally {
  try {
    try { Stop-E2eNativeProcesses } finally {
    $receipt.cleanup.rootReferenceObservation=if($script:e2eNativeRootReferenceObservation) { @{invoked=$true;receipt=$script:e2eNativeRootReferenceObservation.receipt} } else { @{invoked=$false;passed=$false;strictAssertionPassed=$false;processesStopped=0;ownershipClaimed=$false;rawCommandLinesArchived=$false} }
  }
    $receipt.cleanup.processesExited=$true
    $receipt.retainedProcesses=@($e2eOwnedNativeProcesses.Values|ForEach-Object {@{pid=$_.process.Id;parentPid=$_.parentId;startedAt=$_.started.ToString('o');image=$_.path;sha256=$_.sha256;kind=$_.kind;launcher=$_.launcher;exited=$_.process.HasExited}})
    Assert-E2eNativeOwner
    Copy-Item -LiteralPath $SetupFile -Destination (Join-Path $productionOutput 'setup.json')
    if(Test-Path -LiteralPath (Join-Path $e2eSandbox 'production-launch-receipt.json')){Copy-Item -LiteralPath (Join-Path $e2eSandbox 'production-launch-receipt.json') -Destination (Join-Path $productionOutput 'production-launch-receipt.json')}
    $receipt.privateProductLogHashes=@(foreach($name in @('production-stdout.log','production-stderr.log')){if(Test-Path -LiteralPath (Join-Path $e2eSandbox $name)){$log=Get-Item -LiteralPath (Join-Path $e2eSandbox $name);@{name=$name;bytes=$log.Length;sha256=(Get-FileHash -LiteralPath $log.FullName -Algorithm SHA256).Hash.ToLowerInvariant();exactLogBytesRetained=$false;reason='Potential private endpoint or credential; structured redacted UI receipt is retained'}}})
    Write-ProductionSupervisor
    Remove-E2eOwnedTree $e2eSandbox
    $receipt.cleanup.removed=-not (Test-Path -LiteralPath $e2eSandbox)
  } catch {$receipt.cleanup.failure=$_.Exception.Message;$receipt.passed=$false}
  foreach($identity in $e2eOwnedNativeProcesses.Values){$identity.process.Dispose()}
  $receipt.externalObservation=$(if($e2eNativeExternalGitObservation){@{invoked=$true;report=$e2eNativeExternalGitObservation.reportPath;sha256=$e2eNativeExternalGitObservation.reportSha256;passed=$e2eNativeExternalGitObservation.receipt.passed;budgetSeconds=$e2eNativeExternalGitObservation.receipt.budgetSeconds;deadlineNeverReset=$true;ownershipClaimed=$false;processesStopped=0}}else{@{invoked=$false;ownershipClaimed=$false;processesStopped=0}})
  $receipt.helperBindingsUnchangedThroughCleanup=$true
  foreach($binding in $receipt.helperBindings){try{$binding.unchangedThroughCleanup=(Get-FileHash -LiteralPath $binding.path -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $binding.sha256}catch{$binding.unchangedThroughCleanup=$false};if(-not $binding.unchangedThroughCleanup){$receipt.helperBindingsUnchangedThroughCleanup=$false;$receipt.passed=$false}}
  $receipt.sourceInputsUnchangedThroughCleanup=$false
  try{Assert-ProductionBuildBinding;$receipt.sourceInputsUnchangedThroughCleanup=$true}catch{$receipt.sourceBindingFailure=$_.Exception.Message;$receipt.passed=$false}
  $receipt.identityFailure=$e2eNativeIdentityFailure
  $receipt.wrapperBeforeAfterUnchanged=(Get-FileHash -LiteralPath $wrapper -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $receipt.wrapperSha256
  $receipt.supervisorBeforeAfterUnchanged=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $receipt.supervisorSha256
  if(-not $receipt.wrapperBeforeAfterUnchanged -or -not $receipt.supervisorBeforeAfterUnchanged){$receipt.passed=$false}
  $receipt.childDiagnostics=@($e2eNativeChildDiagnostics.ToArray())
  $receipt.finishedAt=[DateTimeOffset]::UtcNow.ToString('o')
  Write-ProductionSupervisor
  Write-Output ($receipt|ConvertTo-Json -Depth 4 -Compress)
}
if(-not $receipt.passed -or -not $receipt.cleanup.removed){exit 1}
