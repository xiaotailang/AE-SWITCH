[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$SetupFile,
  [ValidateRange(600,600)][int]$WholeRunTimeoutSeconds=600
)
$ErrorActionPreference='Stop'
$e2eWorkspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
. (Join-Path $e2eWorkspace 'scripts/workspace-env.ps1')
if($PSVersionTable.PSVersion.Major -lt 7){throw 'Workspace PowerShell 7 required'}
$extraSetupPath=[IO.Path]::GetFullPath($SetupFile)
$extraSandboxPrefix=[IO.Path]::GetFullPath((Join-Path $e2eWorkspace '.cache/native-e2e-sandbox'))+'\'
if(-not $extraSetupPath.StartsWith($extraSandboxPrefix,[StringComparison]::OrdinalIgnoreCase) -or $extraSetupPath.Substring($extraSandboxPrefix.Length) -cnotmatch '^[a-f0-9]{32}\\setup\.json$'){throw 'Exact owned extra UI setup path required'}
for($extraAncestor=$extraSetupPath; $extraAncestor; $extraAncestor=[IO.Path]::GetDirectoryName($extraAncestor)){
  $extraItem=Get-Item -LiteralPath $extraAncestor -Force -ErrorAction Stop
  if(($extraItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Extra UI setup reparse ancestor refused'}
}
$extraSetupSha256=(Get-FileHash -LiteralPath $extraSetupPath -Algorithm SHA256).Hash.ToLowerInvariant()
$extraSetupProofPath=$extraSetupPath
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
$productionOutput=Join-Path $e2eWorkspace ('artifacts/acceptance/production-extra-ui-'+$e2eIdentifier)
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
  $rootSetup=Join-Path $e2eSandbox 'setup.json'
  $archiveSetup=Join-Path $e2eWorkspace ('artifacts/acceptance/production-extra-ui-'+$e2eIdentifier+'/setup.json')
  if($extraSetupPath -ine $rootSetup -or [IO.Path]::GetFullPath($SetupFile) -ine $rootSetup -or $extraSetupSha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'Original extra UI setup binding required'}
  if($extraSetupProofPath -ine $rootSetup){
    if($extraSetupProofPath -ine $archiveSetup -or $productionOutput -ine [IO.Path]::GetDirectoryName($archiveSetup) -or $receipt.cleanup.setupProofArchived -isnot [bool] -or -not $receipt.cleanup.setupProofArchived){throw 'Verified fixed extra UI setup archive required'}
    foreach($field in @('processesExited','sharedRuntimeBindingsUnchangedBeforeRemoval','originalFixturesUnchangedBeforeRemoval','dispatchOnlyEntriesUnchangedBeforeRemoval','helpersUnchangedBeforeRemoval')){
      if($receipt.cleanup[$field] -isnot [bool] -or -not $receipt.cleanup[$field]){throw 'Verified extra UI cleanup boundary required'}
    }
  }
  $proof=Assert-E2eNativeOrdinaryFile $extraSetupProofPath
  if((Get-FileHash -LiteralPath $proof -Algorithm SHA256).Hash.ToLowerInvariant() -cne $extraSetupSha256){throw 'Prepared extra UI setup bytes changed'}
  $null=Assert-E2eLocalPath $e2eMarker
  if((Get-FileHash -LiteralPath $e2eMarker -Algorithm SHA256).Hash.ToLowerInvariant() -cne $e2eNativeMarkerHash){throw 'Production marker bytes changed'}
  $owner=Get-Content -LiteralPath $e2eMarker -Raw -Encoding UTF8|ConvertFrom-Json
  if($owner.schemaVersion -ne 2 -or $owner.ownerId -cne $e2eIdentifier -or $owner.workspace -ine $e2eWorkspace -or $setup.workspace -ine $e2eWorkspace -or $owner.productionSha256 -cne $setup.productionSha256 -or $owner.sourceDigest -cne $setup.sourceDigest -or $owner.buildAuditId -cne $setup.buildAuditId -or $setup.qaHooksUsed -ne $false -or $setup.discoveryContextInjected -ne $false){throw 'Production owner binding changed'}
}
function Use-ExtraArchivedSetupProof {
  # The root proof remains mandatory until exited processes and every original
  # input guard have passed. Cleanup may then delete setup.json as ordinary data.
  if($extraSetupProofPath -ine $extraSetupPath){throw 'Extra UI setup proof can transition only once'}
  foreach($field in @('processesExited','sharedRuntimeBindingsUnchangedBeforeRemoval','originalFixturesUnchangedBeforeRemoval','dispatchOnlyEntriesUnchangedBeforeRemoval','helpersUnchangedBeforeRemoval')){
    if($receipt.cleanup[$field] -isnot [bool] -or -not $receipt.cleanup[$field]){throw 'Verified extra UI cleanup boundary required'}
  }
  Assert-E2eNativeOwner
  Assert-E2eNativeProcessesExited
  $archiveSetup=Join-Path $e2eWorkspace ('artifacts/acceptance/production-extra-ui-'+$e2eIdentifier+'/setup.json')
  if($productionOutput -ine [IO.Path]::GetDirectoryName($archiveSetup)){throw 'Fixed external extra UI setup archive required'}
  $null=Assert-E2eNativeOrdinaryFile $archiveSetup
  if((Get-FileHash -LiteralPath $archiveSetup -Algorithm SHA256).Hash.ToLowerInvariant() -cne $extraSetupSha256){throw 'Archived extra UI setup bytes changed'}
  $script:extraSetupProofPath=$archiveSetup
  $receipt.cleanup.setupProofArchived=$true
  Assert-E2eNativeOwner
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
function Assert-ExtraRuntimeBindings {
  if($setup.fixtures.sharedRuntimeFiles.Count -lt 1){throw 'Shared runtime bindings required'}
  foreach($file in $setup.fixtures.sharedRuntimeFiles.Keys){
    if((Get-FileHash -LiteralPath (Assert-E2eLocalPath $file) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $setup.fixtures.sharedRuntimeFiles[$file]){throw 'Shared runtime input changed'}
  }
}
function Assert-ExtraPreservedFiles {
  if(@($setup.fixtures.payload.preservedFiles).Count -lt 1){throw 'Original fixture bindings required'}
  foreach($file in $setup.fixtures.payload.preservedFiles){
    $full=Assert-E2eLocalPath $file.path
    if(-not $full.StartsWith($e2eSandbox+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Original fixture escaped exact owner'}
    if((Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant() -cne $file.sha256){throw 'Original fixture input changed'}
  }
}
function Assert-ExtraDispatchEntries {
  foreach($file in $extraDispatchEntries){
    if((Get-FileHash -LiteralPath (Assert-E2eLocalPath $file.path) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $file.sha256){throw 'Dispatch-only fixture entry changed'}
  }
}
function Assert-ExtraHelpers {
  foreach($file in $receipt.helperBindings){
    if((Get-FileHash -LiteralPath (Assert-E2eLocalPath $file.path) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $file.sha256){throw 'Bound extra UI helper changed'}
  }
}
Assert-E2eNativeOwner
Assert-ProductionBuildBinding
Assert-ExtraRuntimeBindings
Assert-ExtraPreservedFiles
$null=Assert-E2eLocalPath ([IO.Path]::GetFullPath($SetupFile))
if([IO.Path]::GetFullPath($SetupFile) -ine (Join-Path $e2eSandbox 'setup.json')){throw 'Exact owned setup required'}
if(Test-Path -LiteralPath $productionOutput){throw 'Production output must be fresh'}
$null=New-Item -ItemType Directory -Path $productionOutput
Assert-E2eNativeOwner
$receipt=[ordered]@{schemaVersion=2;ownerId=$e2eIdentifier;sandbox=$e2eSandbox;sourceDigest=$setup.sourceDigest;buildAuditId=$setup.buildAuditId;productionSha256=$setup.productionSha256;scope='Production profile ambiguity/original protection and exact owned tray restoration; no startup setting or official client mutation';complete=$false;fullAcceptancePassed=$false;officialClientsLaunched=$false;credentialsRead=$false;windowsLoginExecuted=$false;backgroundSettingsMutated=$false;actualExitConfirmed=$false;startedAt=[DateTimeOffset]::UtcNow.ToString('o');wrapperSha256=(Get-FileHash -LiteralPath $wrapper -Algorithm SHA256).Hash.ToLowerInvariant();importedFunctions=$imports.ToArray();qaHooksUsed=$false;discoveryContextInjected=$false;passed=$false;cleanup=@{removed=$false;processesExited=$false};unprovedExternalProcessStopped=$false}
$receipt.setupReceiptSha256=$extraSetupSha256
$receipt.credentialsInputRead=$false
$receipt.sharedRuntimeBindings=@(foreach($name in $setup.fixtures.sharedRuntimeFiles.Keys){@{path=$name;sha256=$setup.fixtures.sharedRuntimeFiles[$name]}})
$receipt.preservedFileBindings=$setup.fixtures.payload.preservedFiles
$extraDispatchEntries=@(foreach($profile in $setup.fixtures.payload.profiles.Values){$file=Assert-E2eLocalPath $profile.executablePath;if(-not $file.StartsWith($e2eSandbox+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Dispatch entry escaped owner'};@{path=$file;sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}})
$receipt.dispatchOnlyEntryBindings=$extraDispatchEntries
$receipt.buildBindings=$setup.buildBindings
$receipt.sourceFiles=$setup.sourceFiles
$receipt.supervisorSha256=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
$helperNames=@('production-extra-ui.mjs','production-profile-surface.mjs','production-ui-surface.mjs','production-tray-surface.mjs','production-owned-tray.ps1','prepare-production-ui-eight.ps1','production-ui-eight-contract.mjs','wait-existing-tauri-page.mjs')
$receipt.helperBindings=@(@($PSCommandPath,$wrapper)+@($helperNames|ForEach-Object{Join-Path $PSScriptRoot $_})|ForEach-Object{@{path=$_;sha256=(Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant()}})
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
    throw 'Production extra UI fixed ten-minute deadline exceeded; retained ownership cleanup follows.'
  }
}
function Write-ProductionSupervisor { [IO.File]::WriteAllText($e2eReport,($receipt|ConvertTo-Json -Depth 45)+"`n",$e2eUtf8) }
Write-ProductionSupervisor
try {
  if(@([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()|Where-Object Port -EQ 9223).Count){throw 'CDP port occupied; external attach refused'}
  Assert-ProductionBuildBinding
  Assert-ExtraRuntimeBindings
  Assert-ExtraPreservedFiles
  Assert-ExtraDispatchEntries
  Assert-ExtraHelpers
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
  $runner=Join-Path $e2eWorkspace 'tests/acceptance/production-extra-ui.mjs'
  $node=Join-Path $e2eWorkspace '.tools/node/node.exe'
  Assert-ProductionRunDeadline
  $nodeProcess=Start-Process -FilePath $node -ArgumentList @('"'+$runner+'"','"'+[IO.Path]::GetFullPath($SetupFile)+'"','"'+$launch+'"') -WorkingDirectory $e2eWorkspace -WindowStyle Hidden -RedirectStandardOutput (Join-Path $productionOutput 'runner-stdout.log') -RedirectStandardError (Join-Path $productionOutput 'runner-stderr.log') -PassThru
  $nodeIdentity=New-E2eNativeProcessIdentity $nodeProcess @{kind='shared-official-runtime';launcher=''}
  Assert-E2eNativeProcessIdentity $nodeIdentity -VerifyHash
  $e2eOwnedNativeProcesses[$nodeProcess.Id]=$nodeIdentity
  while(-not $nodeProcess.WaitForExit(20)){Assert-ProductionRunDeadline;Record-E2eNativeChildren;Assert-E2eNativeProcessIdentity $productIdentity}
  Assert-ProductionRunDeadline
  $receipt.runnerExitCode=$nodeProcess.ExitCode
  $results=Get-Content -LiteralPath (Join-Path $productionOutput 'production-extra-ui-results.json') -Raw -Encoding UTF8|ConvertFrom-Json
  $receipt.uiPassed=$results.passed -eq $true
  $receipt.profileUiPassed=$results.profile.passed -eq $true
  $receipt.trayUiPassed=$results.tray.passed -eq $true
  $receipt.exitCancel=$results.tray.exitCancel
  $receipt.nativeStoreUnchanged=$results.nativeStoreUnchanged -eq $true
  $receipt.backgroundSettingsUnchanged=$results.backgroundSettingsUnchanged -eq $true
  $receipt.officialLauncherObservationCount=@($e2eOwnedNativeProcesses.Values|Where-Object kind -CEQ 'official-powershell-launcher').Count
  if($receipt.officialLauncherObservationCount -ne 0){throw 'Extra UI run unexpectedly launched an official client'}
  $receipt.passed=$results.passed -eq $true -and $receipt.profileUiPassed -and $receipt.trayUiPassed -and $receipt.nativeStoreUnchanged -and $receipt.backgroundSettingsUnchanged -and $nodeProcess.ExitCode -eq 0 -and -not $e2eNativeIdentityFailure

} catch {$receipt.failure='Production extra UI supervisor failed; raw exception/input omitted';$receipt.failureType=$_.Exception.GetType().Name;$receipt.passed=$false}
finally {
  # Quiesce the retained driver before process cleanup. No registry mutation or recovery is used.
  try {
    if($nodeProcess -and -not $nodeProcess.HasExited){
      Assert-E2eNativeProcessIdentity $nodeIdentity -VerifyHash
      if($nodeIdentity.path -ine (Join-Path $e2eWorkspace '.tools/node/node.exe')){throw 'Exact owned Node driver required'}
      $nodeIdentity.process.Kill()
      if(-not $nodeIdentity.process.WaitForExit(10000)){throw 'Owned Node driver did not quiesce'}
      $receipt.cleanup.driverStoppedBeforeProcessCleanup=$true
      $receipt.passed=$false
    }
  } catch {$receipt.cleanup.driverQuiescenceFailure='Retained driver quiescence failed';$receipt.passed=$false}
  try {
    try { Stop-E2eNativeProcesses } finally {
    $receipt.cleanup.rootReferenceObservation=if($script:e2eNativeRootReferenceObservation) { @{invoked=$true;receipt=$script:e2eNativeRootReferenceObservation.receipt} } else { @{invoked=$false;passed=$false;strictAssertionPassed=$false;processesStopped=0;ownershipClaimed=$false;rawCommandLinesArchived=$false} }
  }
    $receipt.cleanup.processesExited=$true
    Assert-ExtraRuntimeBindings
    $receipt.cleanup.sharedRuntimeBindingsUnchangedBeforeRemoval=$true
    Assert-ExtraPreservedFiles
    $receipt.cleanup.originalFixturesUnchangedBeforeRemoval=$true
    Assert-ExtraDispatchEntries
    $receipt.cleanup.dispatchOnlyEntriesUnchangedBeforeRemoval=$true
    Assert-ExtraHelpers
    $receipt.cleanup.helpersUnchangedBeforeRemoval=$true
    $receipt.retainedProcesses=@($e2eOwnedNativeProcesses.Values|ForEach-Object {@{pid=$_.process.Id;parentPid=$_.parentId;startedAt=$_.started.ToString('o');image=$_.path;sha256=$_.sha256;kind=$_.kind;launcher=$_.launcher;exited=$_.process.HasExited}})
    Assert-E2eNativeOwner
    Copy-Item -LiteralPath $SetupFile -Destination (Join-Path $productionOutput 'setup.json')
    Use-ExtraArchivedSetupProof
    if(Test-Path -LiteralPath (Join-Path $e2eSandbox 'production-launch-receipt.json')){Copy-Item -LiteralPath (Join-Path $e2eSandbox 'production-launch-receipt.json') -Destination (Join-Path $productionOutput 'production-launch-receipt.json')}
    $receipt.privateProductLogHashes=@(foreach($name in @('production-stdout.log','production-stderr.log')){if(Test-Path -LiteralPath (Join-Path $e2eSandbox $name)){$log=Get-Item -LiteralPath (Join-Path $e2eSandbox $name);@{name=$name;bytes=$log.Length;sha256=(Get-FileHash -LiteralPath $log.FullName -Algorithm SHA256).Hash.ToLowerInvariant();exactLogBytesRetained=$false;reason='Potential private endpoint or credential; structured redacted UI receipt is retained'}}})
    Write-ProductionSupervisor
    Remove-E2eOwnedTree $e2eSandbox
    $receipt.cleanup.removed=-not (Test-Path -LiteralPath $e2eSandbox)
  } catch {
    $cleanupCause=$_.Exception
    while($cleanupCause.InnerException){$cleanupCause=$cleanupCause.InnerException}
    $receipt.cleanup.failure='Exact owned process/tree cleanup or original binding check failed'
    $receipt.cleanup.failureType=$cleanupCause.GetType().Name
    $receipt.cleanup.failureHResult=$cleanupCause.HResult
    $receipt.cleanup.failureWin32=($cleanupCause.HResult -band 65535)
    # Remove-E2eOwnedTree may have written its failure before this catch. Keep
    # only bounded numeric retry evidence and the boolean owner result.
    try {
      $cleanupDisk=[IO.File]::ReadAllText($e2eReport)|ConvertFrom-Json -AsHashtable
      if($cleanupDisk.ownerId -ceq $e2eIdentifier -and $cleanupDisk.sandbox -ieq $e2eSandbox -and $cleanupDisk.cleanup -is [Collections.IDictionary]){
        $diagnostics=@{}
        foreach($field in @('sharingViolationRetryTimeoutMs','sharingViolationRetryCount','directoryNotEmptyRetryCount')){
          $value=$cleanupDisk.cleanup[$field]
          if(($value -is [int] -or $value -is [long]) -and $value -ge 0 -and $value -le [int]::MaxValue){$diagnostics[$field]=$value}
        }
        if($cleanupDisk.cleanup.ownerMarkerVerified -is [bool]){$diagnostics.ownerMarkerVerified=$cleanupDisk.cleanup.ownerMarkerVerified}
        $receipt.cleanup.removalDiagnostics=$diagnostics
      }
    } catch {$receipt.cleanup.removalDiagnosticsReadFailed=$true}
    $receipt.passed=$false
  }
  foreach($identity in $e2eOwnedNativeProcesses.Values){$identity.process.Dispose()}
  $receipt.externalObservation=$(if($e2eNativeExternalGitObservation){@{invoked=$true;report=$e2eNativeExternalGitObservation.reportPath;sha256=$e2eNativeExternalGitObservation.reportSha256;passed=$e2eNativeExternalGitObservation.receipt.passed;budgetSeconds=$e2eNativeExternalGitObservation.receipt.budgetSeconds;deadlineNeverReset=$true;ownershipClaimed=$false;processesStopped=0}}else{@{invoked=$false;ownershipClaimed=$false;processesStopped=0}})
  $receipt.helperBindingsUnchangedThroughCleanup=$true
  foreach($binding in $receipt.helperBindings){try{$binding.unchangedThroughCleanup=(Get-FileHash -LiteralPath $binding.path -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $binding.sha256}catch{$binding.unchangedThroughCleanup=$false};if(-not $binding.unchangedThroughCleanup){$receipt.helperBindingsUnchangedThroughCleanup=$false;$receipt.passed=$false}}
  $receipt.sourceInputsUnchangedThroughCleanup=$false
  try{Assert-ProductionBuildBinding;$receipt.sourceInputsUnchangedThroughCleanup=$true}catch{$receipt.sourceBindingFailure=$_.Exception.Message;$receipt.passed=$false}
  $receipt.sharedRuntimeInputsUnchangedThroughCleanup=$false
  try{Assert-ExtraRuntimeBindings;$receipt.sharedRuntimeInputsUnchangedThroughCleanup=$true}catch{$receipt.runtimeBindingFailure='Shared runtime input changed through cleanup';$receipt.passed=$false}
  if(-not $receipt.cleanup.removed -or -not $receipt.cleanup.processesExited){$receipt.passed=$false}
  $receipt.identityFailure=$e2eNativeIdentityFailure
  $receipt.wrapperBeforeAfterUnchanged=(Get-FileHash -LiteralPath $wrapper -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $receipt.wrapperSha256
  $receipt.supervisorBeforeAfterUnchanged=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $receipt.supervisorSha256
  if(-not $receipt.wrapperBeforeAfterUnchanged -or -not $receipt.supervisorBeforeAfterUnchanged){$receipt.passed=$false}
  $receipt.childDiagnostics=@($e2eNativeChildDiagnostics.ToArray())
  $receipt.finishedAt=[DateTimeOffset]::UtcNow.ToString('o')
  Write-ProductionSupervisor
  Write-Output ($receipt|ConvertTo-Json -Depth 4 -Compress)
}
if(-not $receipt.passed -or -not $receipt.cleanup.removed -or -not $receipt.cleanup.processesExited){exit 1}
