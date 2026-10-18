[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'Static runtime ownership regressions require PowerShell 7.' }
. (Join-Path $PSScriptRoot '../../scripts/workspace-env.ps1')
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$sourcePath = Join-Path $workspace 'scripts/verify-owned-desktop-runtime.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Runtime source has PowerShell parser errors.' }
$baseline = @'
{"invariantHashes":{"Assert-RuntimePath":"0ba0b8a47b71e6e1242983ad44485b77f4f2ff462ab60dc09b46847d6f5a7bda","Get-RuntimeTree":"b94130882bce060f1c324d081c9edf1a83cde5d46c553c63e2fe3ac83d4a6c06","Assert-RuntimeOwner":"80556d5117f3972dbf0adb81f8f20f354aca0c7fb38c339b0e94ef2ff8f3b138","Retain-RuntimeProcess":"cb2f030c4c6105b89ee35e4ab198944f522c3eb20bbc1cc23421d4f27d1e8fe4","Assert-RuntimeProcess":"6a8e6a34d9518896d8c79cdd0a238acf7e8ce616c0ec5325ec83245bce1f17f4","Get-RuntimeDatabase":"ab1d46cbc5a7d34c0536ddf65b35088336329ac7a73d50bb65418c40140e0e77","Get-RuntimeStableFiles":"89bd9ade93489623e28e50f69b25490c7d2ee57c0dfd36f3e479bfdbf27376b8","Get-RuntimeWebviewDataCheck":"40848104bc04d7d271e400191464d3080527ac9f54904bfdcad5fcbcdb07e22b","Get-OwnedWebviewEvidence":"53fcc71bad5d3e7d24a07a5448725be9a09f77d4ff2801e569574663dee32966","Assert-RuntimeHealth":"77b70f8baa3e841cbfe50cdf49068444a5a991d26523fe3a1288595a5a35ca56","Assert-OwnedReceiver":"59cfaee9bdd4310729d5c43bba66ba962c3094bda66314a08f4c8ed6d5dbc728"},"gateCalls":["Add-RuntimeGate 'release-no-existing-instance-preflight' @{ cimReadOnly = $true; namedMutexAbsent = $true; receiverAbsent = $true }","Add-RuntimeGate 'release-background-hidden-healthy-empty' @{ actualOsVisible = $false; backgroundArgument = $true; health = $health; database = $initialDatabase; webview = $webviewEvidence }","Add-RuntimeGate 'release-secondary-shows-owned-primary' @{ primaryPidUnchanged = $true; secondaryExitCode = $secondary.process.ExitCode; actualOsVisible = $true; actualOsMinimized = $false; ownedReceiverStillBound = $true }","Add-RuntimeGate 'release-secondary-preserves-root-state' @{ stableFilesUnchanged = $true; stableFileCount = $afterFiles.Count; databaseUnchanged = $true; providers = 0; operations = 0; unmanagedTargets = 3 }"],"markerLastDeletion":"    $tree = Get-RuntimeTree $runtimeRoot\n    foreach ($file in $tree.files) { if ($file -cne $runtimeMarker) { $null = Assert-RuntimePath $file; [IO.File]::Delete($file) } }\n    for ($index = $tree.directories.Count - 1; $index -gt 0; $index--) { $null = Assert-RuntimePath $tree.directories[$index]; [IO.Directory]::Delete($tree.directories[$index], $false) }\n    Assert-RuntimeOwner\n    [IO.File]::Delete($runtimeMarker)\n    $null = Assert-RuntimePath $runtimeRoot; [IO.Directory]::Delete($runtimeRoot, $false)\n}"}
'@ | ConvertFrom-Json -AsHashtable
foreach ($entry in $baseline.invariantHashes.GetEnumerator()) {
    $function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $entry.Key }, $true)
    $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($function.Extent.Text))).ToLowerInvariant()
    if ($hash -cne $entry.Value) { throw "Existing runtime invariant changed: $($entry.Key)." }
}
$gates = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Add-RuntimeGate' }, $true) | ForEach-Object { $_.Extent.Text })
if ($gates.Count -ne 4 -or ($gates | ConvertTo-Json -Compress) -cne ($baseline.gateCalls | ConvertTo-Json -Compress)) { throw 'The four original product gates changed.' }
$removeText = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Remove-RuntimeTree' }, $true).Extent.Text
$deletion = $removeText.Substring($removeText.IndexOf('    foreach ($file in $tree.files)'))
$baselineDeletion = $baseline.markerLastDeletion.Substring($baseline.markerLastDeletion.IndexOf('    foreach ($file in $tree.files)'))
if ($deletion -cne $baselineDeletion) { throw 'Ordinary file/directory checks or marker-last deletion changed.' }
$aliasRemoval = @'
    foreach ($alias in $tree.aliases) {
        $null = Assert-RuntimeCacheAlias $alias.path
        [IO.Directory]::Delete($alias.path, $false)
    }
'@
if (-not $removeText.Contains('    $tree = Get-RuntimeTree $runtimeRoot $true',[StringComparison]::Ordinal) -or -not $removeText.Contains($aliasRemoval,[StringComparison]::Ordinal) -or $removeText.IndexOf($aliasRemoval) -gt $removeText.IndexOf('    foreach ($file in $tree.files)')) { throw 'Owned alias revalidation and nonrecursive removal must precede ordinary tree deletion.' }
$copyFunction = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Copy-RuntimeTree' }, $true)
$copyTreeCalls = @($copyFunction.FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Get-RuntimeTree' }, $true))
if ($copyTreeCalls.Count -ne 1 -or $copyTreeCalls[0].Extent.Text -cne 'Get-RuntimeTree $source') { throw 'Source package copying must reject every reparse point.' }
$typeCommand = $ast.Find({ param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Add-Type' }, $true)
$nativeCode = $typeCommand.CommandElements[2].Value.Replace('public static class AEReleaseRuntime {', 'public static class AEReleaseRuntimeStaticNative {')
if ($nativeCode -notmatch 'OpenProcess\(0x00101000,false,pid\)' -or $nativeCode -notmatch 'finally\{CloseHandle\(handle\);\}' -or $nativeCode -notmatch 'WaitForSingleObject\(handle,\(uint\)remaining\)' -or $nativeCode -notmatch 'catch\(ArgumentException\)\{return "pid-absent";\}' -or $nativeCode -notmatch 'ticks<earliestCreationTicks' -or $nativeCode -notmatch 'Math.Abs\(ticks-expectedCreationTicks\)>TimeSpan.TicksPerMillisecond' -or $nativeCode -match 'TerminateProcess') { throw 'Transient-child native exit proof lost its read-only handle, generation, absence or bounded-wait safeguards.' }
$mockCode = @'
public static class AEReleaseRuntime {
    public static readonly Dictionary<long,string> Paths = new Dictionary<long,string>();
    public static readonly HashSet<long> Unavailable = new HashSet<long>();
    public static readonly Dictionary<int,string> ExitResults = new Dictionary<int,string>();
    public static readonly Dictionary<int,int> ExitDelays = new Dictionary<int,int>();
    public static readonly HashSet<int> ExitFailures = new HashSet<int>();
    public static readonly List<int> ExitPids = new List<int>();
    public static readonly List<int> ExitTimeouts = new List<int>();
    public static readonly List<long> ExitExpectedTicks = new List<long>();
    public static readonly List<long> ExitEarliestTicks = new List<long>();
    public static readonly Dictionary<string,int> DeleteErrors = new Dictionary<string,int>(StringComparer.OrdinalIgnoreCase);
    public static readonly List<string> DeleteProbePaths = new List<string>();
    public static string ProcessPath(IntPtr handle) {
        if(Unavailable.Contains(handle.ToInt64())) throw new Win32Exception(5);
        string path;
        if(!Paths.TryGetValue(handle.ToInt64(),out path)) throw new InvalidOperationException("Synthetic identity is unavailable.");
        return path;
    }
    public static string ObserveProcessExit(int pid,long expectedCreationTicks,long earliestCreationTicks,int timeoutMs) {
        ExitPids.Add(pid);ExitTimeouts.Add(timeoutMs);ExitExpectedTicks.Add(expectedCreationTicks);ExitEarliestTicks.Add(earliestCreationTicks);
        if(timeoutMs<0 || timeoutMs>750) throw new ArgumentException("Synthetic bounded-wait violation.");
        if(ExitFailures.Contains(pid)) throw new InvalidOperationException("Synthetic exit proof unavailable.");
        int delay;if(ExitDelays.TryGetValue(pid,out delay)) System.Threading.Thread.Sleep(Math.Min(delay,timeoutMs));
        string result;return ExitResults.TryGetValue(pid,out result)?result:"live-or-unavailable";
    }
    public static string[] CommandLineArguments(string commandLine) { return AEReleaseRuntimeStaticNative.CommandLineArguments(commandLine); }
    public static int DeleteAccess(string path){DeleteProbePaths.Add(path);int error;return DeleteErrors.TryGetValue(path,out error)?error:AEReleaseRuntimeStaticNative.DeleteAccess(path);}
}
public static class AEStaticFixtureDeleteProbe {
    [DllImport("kernel32.dll",EntryPoint="CreateFileW",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] static extern IntPtr Open(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll",ExactSpelling=true)] static extern bool CloseHandle(IntPtr handle);
    public static bool Allowed(string path){var handle=Open(path,0x00010000,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero);if(handle==new IntPtr(-1))return false;try{return true;}finally{CloseHandle(handle);}}
}
public sealed class AEStaticFixtureTimedLock : IDisposable {
    readonly object guard = new object();
    System.IO.FileStream stream;
    System.Threading.Timer release;
    public AEStaticFixtureTimedLock(string path){stream=System.IO.File.Open(path,System.IO.FileMode.Open,System.IO.FileAccess.ReadWrite,System.IO.FileShare.ReadWrite);}
    public void ReleaseAfter(int milliseconds){if(milliseconds<1 || milliseconds>5000)throw new ArgumentException("A short fixture-only release deadline is required.");release=new System.Threading.Timer(_=>DisposeStream(),null,milliseconds,System.Threading.Timeout.Infinite);}
    void DisposeStream(){lock(guard){if(stream!=null){stream.Dispose();stream=null;}}}
    public void Dispose(){if(release!=null){release.Dispose();release=null;}DisposeStream();}
}
'@
Add-Type -TypeDefinition ($nativeCode + "`n" + $mockCode)
foreach ($name in @('Get-RuntimeDiagnosticPath','Get-RuntimeChildDiagnostic','Add-RuntimeChildDiagnostic','Add-RuntimeUnownedObservation','Test-RuntimeObservedProcessExited','Update-ExitedRuntimeEntries','Capture-RuntimeChildren','Retain-RuntimeProcess','Assert-RuntimeProcess','Get-RuntimeLiveRootReferences','Get-RuntimeCleanupDeleteTree','Wait-RuntimeDeleteAccess','Remove-RuntimeTree','Get-RuntimeWebviewDataCheck','Get-RuntimeAppLockMetadata','Get-RuntimeStableFiles','Assert-RuntimeCacheAlias','Copy-RuntimeTree')) {
    $function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    Invoke-Expression $function.Extent.Text
}
$realPathFunction = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-RuntimePath' }, $true).Extent.Text
Invoke-Expression ($realPathFunction.Replace('function Assert-RuntimePath(', 'function Assert-StaticRealRuntimePath('))
$realTreeFunction = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-RuntimeTree' }, $true).Extent.Text
Invoke-Expression ($realTreeFunction.Replace('function Get-RuntimeTree(', 'function Get-StaticRealRuntimeTree('))
$reportAssignment = $ast.Find({ param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left -is [Management.Automation.Language.VariableExpressionAst] -and $node.Left.VariablePath.UserPath -eq 'runtimeReport' }, $true).Extent.Text
$runtimeWorkspace = $workspace
$runtimeId = '0123456789abcdef0123456789abcdef'
$runtimeRoot = Join-Path $workspace ".cache/desktop-runtime-sandbox/$runtimeId"
$runtimeToken = '1' * 64
$parentStarted = [DateTime]::Parse('2026-10-08T15:00:00Z').ToUniversalTime()
$childStarted = $parentStarted.AddSeconds(1)
$ownedImage = Join-Path $runtimeRoot 'AE-Switch.exe'
$ownedChildImage = Join-Path $runtimeRoot 'tools/webview2/msedgewebview2.exe'
$externalImage = 'C:\Users\PRIVATE_PROFILE\App\SogouCloud.exe'
$apiKeySentinel = 'DO_NOT_RECORD_API_KEY_OR_ARGUMENT_51f4e6'
$results = [Collections.Generic.List[object]]::new()
$deleteAccessRegressionEvidence = [Collections.Generic.List[object]]::new()
$fixtureRunId = [Guid]::NewGuid().ToString('N')
$fixturePurpose = 'AE Switch owned static desktop-runtime fixture'
$fixtureHarnessHash = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
$fixtureOwnedRoots = [Collections.Generic.List[object]]::new()
$fixtureOwnedLinks = [Collections.Generic.List[object]]::new()
$fixtureManifestPath = Join-Path $workspace ".cache/desktop-runtime-lock-static-manifests/$fixtureRunId.json"
$fixtureManifestHash = ''
$fixtureCleanup = [ordered]@{ attempted = $false; passed = $false; removedRoots = 0; retainedRoots = 0; linksTraversed = 0; recursiveDeletion = $false }
trap {
    if ($fixtureOwnedRoots.Count) {
        try { Invoke-StaticFixtureCleanup } catch { $fixtureCleanup.error = 'Owned fixture cleanup failed closed; marker and manifest retained.' }
        $fixtureCleanup.retainedRoots = @($fixtureOwnedRoots | Where-Object { -not $_.removed }).Count
        try { Save-StaticFixtureManifest } catch { }
    }
    throw $_
}
function Assert-Static([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function New-FakeProcess([int]$Id, [DateTime]$Started, [bool]$Exited = $false) {
    $process = [pscustomobject]@{ Id=$Id; Handle=[IntPtr]$Id; StartTime=$Started; HasExited=$Exited; DisposeCalls=0; KillCalls=0 }
    $process | Add-Member -MemberType ScriptMethod -Name Refresh -Value {}
    $process | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $this.DisposeCalls++ }
    $process | Add-Member -MemberType ScriptMethod -Name Kill -Value { $this.KillCalls++; throw 'A static regression attempted process input or stopping.' }
    return $process
}
function New-ChildInfo([int]$Id, [int]$ParentId, [string]$Image, [DateTime]$Started = $childStarted, [string]$Command = '') {
    return [pscustomobject]@{ ProcessId=$Id; ParentProcessId=$ParentId; Name=if($Image){[IO.Path]::GetFileName($Image)}else{'SogouCloud.exe'}; ExecutablePath=$Image; CreationDate=$Started; CommandLine=$Command }
}
function Reset-Case {
    Invoke-Expression ($script:reportAssignment.Replace('$runtimeReport =', '$script:runtimeReport ='))
    $script:runtimeOwned = @{}
    $script:runtimeExited = [Collections.Generic.List[object]]::new()
    $script:runtimeContainmentRejected = $false
    $script:mockProcesses = @{}
    $script:mockSnapshot = @()
    $script:observedIds = [Collections.Generic.List[int]]::new()
    $script:rejectPath = $false
    $script:rejectHash = $false
    $script:hashValue = 'a' * 64
    $script:useActualMetadataPaths = $false; $script:useActualMetadataHashes = $false
    $script:useActualRuntimeTree = $false; $script:mockCleanupTree = $null; $script:mockAliasMetadata = @{}
    $script:cleanupFixtureOwner = $null
    $script:afterDeleteProbe = $null
    $script:hashedPaths = [Collections.Generic.List[string]]::new()
    [AEReleaseRuntime]::Paths.Clear(); [AEReleaseRuntime]::Unavailable.Clear()
    [AEReleaseRuntime]::ExitResults.Clear(); [AEReleaseRuntime]::ExitDelays.Clear(); [AEReleaseRuntime]::ExitFailures.Clear()
    [AEReleaseRuntime]::ExitPids.Clear(); [AEReleaseRuntime]::ExitTimeouts.Clear(); [AEReleaseRuntime]::ExitExpectedTicks.Clear(); [AEReleaseRuntime]::ExitEarliestTicks.Clear()
    [AEReleaseRuntime]::DeleteErrors.Clear(); [AEReleaseRuntime]::DeleteProbePaths.Clear()
    $script:parentProcess = New-FakeProcess 10 $parentStarted
    [AEReleaseRuntime]::Paths[10] = $ownedImage
    $script:runtimeOwned[10] = [pscustomobject]@{ process=$parentProcess; path=$ownedImage; started=$parentStarted; hash=$hashValue }
}
function Get-CimInstance {
    param($ClassName, $ErrorAction)
    if ($null -ne $script:afterDeleteProbe -and [AEReleaseRuntime]::DeleteProbePaths.Count) { $hook = $script:afterDeleteProbe; $script:afterDeleteProbe = $null; & $hook }
    return $script:mockSnapshot
}
function Get-RuntimeObservedProcess([int]$ProcessId) {
    $script:observedIds.Add($ProcessId)
    if (-not $script:mockProcesses.ContainsKey($ProcessId)) { throw [ArgumentException]::new('Synthetic exited process.') }
    $value = $script:mockProcesses[$ProcessId]
    if ($value -is [Exception]) { throw $value }
    return $value
}
function Assert-RuntimeOwner { if ($null -ne $script:cleanupFixtureOwner) { Assert-StaticFixtureOwner $script:cleanupFixtureOwner } }
function Assert-RuntimePath([string]$Location, [bool]$AllowMissing = $false) {
    if ($script:useActualMetadataPaths) { return Assert-StaticRealRuntimePath $Location $AllowMissing }
    if ($script:rejectPath) { throw 'Synthetic ordinary-ancestor rejection.' }
    return $Location
}
function Get-RuntimeHash([string]$Location) {
    $script:hashedPaths.Add($Location)
    if ($script:useActualMetadataHashes) { $null = Assert-RuntimePath $Location; return (Get-FileHash -LiteralPath $Location -Algorithm SHA256).Hash.ToLowerInvariant() }
    if ($script:rejectHash) { throw 'Synthetic owned hash unavailable.' }
    return $script:hashValue
}
function Get-RuntimeTree {
    param([string]$Directory, [bool]$AllowRuntimeCacheAlias = $false)
    if ($null -ne $script:mockCleanupTree) { return $script:mockCleanupTree }
    if ($script:useActualRuntimeTree) { return Get-StaticRealRuntimeTree $Directory $AllowRuntimeCacheAlias }
    throw 'NO_DELETE_STATIC_TEST_BARRIER'
}
function Get-Item {
    param([string]$LiteralPath, [switch]$Force, $ErrorAction)
    if ($script:mockAliasMetadata.ContainsKey($LiteralPath)) { return $script:mockAliasMetadata[$LiteralPath] }
    return Microsoft.PowerShell.Management\Get-Item -LiteralPath $LiteralPath -Force:$Force -ErrorAction Stop
}
function Invoke-StaticCase([string]$Name, [scriptblock]$Body) {
    Reset-Case
    & $Body
    foreach ($process in $script:mockProcesses.Values) {
        if ($process -isnot [Exception]) { Assert-Static ($process.KillCalls -eq 0) 'An observation was stopped.' }
    }
    Assert-Static ($script:parentProcess.KillCalls -eq 0) 'A static regression stopped the primary.'
    $diagnostics = $script:runtimeReport | ConvertTo-Json -Depth 16 -Compress
    foreach ($secret in @($script:apiKeySentinel,$script:runtimeToken,'PRIVATE_PROFILE')) {
        Assert-Static (-not $diagnostics.Contains($secret,[StringComparison]::Ordinal)) 'Diagnostic metadata leaked a secret, argument or profile.'
    }
    $script:results.Add([ordered]@{ name=$Name; passed=$true })
}
function Assert-CaptureRejected {
    $failed=$false
    try { Capture-RuntimeChildren } catch { $failed=$true }
    Assert-Static ($failed -and $script:runtimeContainmentRejected) 'A live or owned identity was accepted without proof.'
    Assert-Static ($script:runtimeOwned.Count -eq 1) 'A rejected child was retained.'
}
Invoke-StaticCase 'live-external-is-observed-without-retain-recurse-or-stop' {
    $foreign=New-FakeProcess 20 $childStarted
    $script:mockProcesses[20]=$foreign
    [AEReleaseRuntime]::Paths[20]=$externalImage
    $script:mockSnapshot=@((New-ChildInfo 20 10 $externalImage $childStarted "--api-key=$apiKeySentinel"),(New-ChildInfo 21 20 $ownedChildImage))
    Capture-RuntimeChildren
    Assert-Static ($runtimeOwned.Count -eq 1 -and -not $runtimeContainmentRejected) 'External observation was retained or rejected.'
    Assert-Static ($runtimeReport.unownedObservations.Count -eq 1 -and -not $runtimeReport.allDescendantsProvenOwned) 'Explicit external scope was missing.'
    Assert-Static ($observedIds.Count -eq 1 -and $observedIds[0] -eq 20 -and $foreign.DisposeCalls -eq 1) 'External descendants were recursed or their provisional handle was retained.'
    Assert-Static (-not $runtimeReport.unownedObservations[0].retained -and -not $runtimeReport.unownedObservations[0].stopped -and -not $runtimeReport.unownedObservations[0].dataWritesAttributedToProduct) 'External observation implied ownership, stopping or data-write attribution.'
    Capture-RuntimeChildren
    Assert-Static ($runtimeReport.unownedObservations.Count -eq 1) 'Repeated foreign observation was not bounded/deduplicated.'
}
Invoke-StaticCase 'already-exited-without-image-is-an-unproved-observation' {
    $script:mockSnapshot=@(New-ChildInfo 20 10 '' $childStarted "--api-key=$apiKeySentinel")
    Capture-RuntimeChildren
    Assert-Static (-not $runtimeContainmentRejected -and $runtimeReport.unownedObservations[0].disposition -eq 'exited-unproved-descendant-observed') 'Proven-exited unknown descendant was not observed safely.'
}
Invoke-StaticCase 'already-exited-root-cim-is-never-retained-from-cim-alone' {
    $script:mockSnapshot=@(New-ChildInfo 20 10 $ownedChildImage)
    Capture-RuntimeChildren
    Assert-Static ($runtimeOwned.Count -eq 1 -and $runtimeReport.unownedObservations.Count -eq 1) 'CIM alone granted owned identity.'
}
Invoke-StaticCase 'exit-during-image-capture-is-an-observation' {
    $script:mockProcesses[20]=New-FakeProcess 20 $childStarted $true
    [AEReleaseRuntime]::Unavailable.Add(20) | Out-Null
    $script:mockSnapshot=@(New-ChildInfo 20 10 '')
    Capture-RuntimeChildren
    Assert-Static (-not $runtimeContainmentRejected -and $runtimeReport.unownedObservations.Count -eq 1) 'An exited handle with missing image was mismanaged.'
}
Invoke-StaticCase 'transient-unavailable-image-native-signaled-exit-is-observed' {
    $script:mockProcesses[20]=New-FakeProcess 20 $childStarted
    [AEReleaseRuntime]::Unavailable.Add(20) | Out-Null
    [AEReleaseRuntime]::ExitResults[20]='native-limited-handle-signaled'
    $script:mockSnapshot=@((New-ChildInfo 20 10 '' $childStarted "--api-key=$apiKeySentinel"),(New-ChildInfo 21 20 $ownedChildImage))
    Capture-RuntimeChildren
    Assert-Static ($runtimeOwned.Count -eq 1 -and -not $runtimeContainmentRejected -and $runtimeReport.unownedObservations.Count -eq 1) 'A signaled unproved child was retained, rejected or omitted.'
    Assert-Static ($runtimeReport.unownedObservations[0].exitProof -eq 'native-limited-handle-signaled' -and $observedIds.Count -eq 1 -and $mockProcesses[20].DisposeCalls -eq 1) 'Native exit evidence was lost, recursed or retained.'
    Assert-Static ([AEReleaseRuntime]::ExitExpectedTicks[0] -eq $childStarted.Ticks -and [AEReleaseRuntime]::ExitEarliestTicks[0] -eq $parentStarted.Ticks) 'Native exit observation lost actual/parent creation evidence.'
}
Invoke-StaticCase 'transient-unavailable-handle-later-pid-absence-is-observed' {
    $script:mockProcesses[20]=[InvalidOperationException]::new('Synthetic initial handle unavailable.')
    [AEReleaseRuntime]::ExitResults[20]='pid-absent'
    $script:mockSnapshot=@(New-ChildInfo 20 10 '' $childStarted)
    Capture-RuntimeChildren
    Assert-Static ($runtimeOwned.Count -eq 1 -and -not $runtimeContainmentRejected -and $runtimeReport.unownedObservations[0].exitProof -eq 'pid-absent') 'Explicit later PID absence was not a safe unowned observation.'
    Assert-Static ([AEReleaseRuntime]::ExitExpectedTicks[0] -eq $childStarted.Ticks) 'Original CIM generation evidence was not passed to the limited query.'
}
foreach ($status in @('live-or-unavailable','generation-mismatch','creation-unavailable','exit-status-unavailable')) {
    Invoke-StaticCase "transient-native-$status-rejects" {
        $script:mockProcesses[20]=[InvalidOperationException]::new('Synthetic initial handle unavailable.')
        [AEReleaseRuntime]::ExitResults[20]=$status
        $script:mockSnapshot=@(New-ChildInfo 20 10 '')
        Assert-CaptureRejected
        Assert-Static ($runtimeReport.unownedObservations.Count -eq 0 -and [AEReleaseRuntime]::ExitPids.Count -eq 1) 'An unproved live, generation or native status became an exit observation.'
    }
}
Invoke-StaticCase 'transient-native-query-exception-rejects-with-sanitized-evidence' {
    $script:mockProcesses[20]=[InvalidOperationException]::new('Synthetic initial handle unavailable.')
    [AEReleaseRuntime]::ExitFailures.Add(20) | Out-Null
    $script:mockSnapshot=@(New-ChildInfo 20 10 '')
    Assert-CaptureRejected
    Assert-Static ($runtimeReport.childDiagnostics.Count -eq 1 -and $runtimeReport.unownedObservations.Count -eq 0) 'An exit-query failure bypassed containment rejection evidence.'
}
Invoke-StaticCase 'transient-image-failure-known-generation-mismatch-never-downgrades' {
    $script:mockProcesses[20]=New-FakeProcess 20 $childStarted $true
    [AEReleaseRuntime]::Unavailable.Add(20) | Out-Null
    [AEReleaseRuntime]::ExitResults[20]='native-limited-handle-signaled'
    $script:mockSnapshot=@(New-ChildInfo 20 10 '' $childStarted.AddSeconds(-2))
    Assert-CaptureRejected
    Assert-Static ([AEReleaseRuntime]::ExitPids.Count -eq 0 -and $runtimeReport.unownedObservations.Count -eq 0) 'Exit downgraded an already established generation mismatch.'
}
Invoke-StaticCase 'transient-original-cim-generation-predating-parent-never-downgrades' {
    $script:mockProcesses[20]=[InvalidOperationException]::new('Synthetic initial handle unavailable.')
    [AEReleaseRuntime]::ExitResults[20]='pid-absent'
    $script:mockSnapshot=@(New-ChildInfo 20 10 $ownedChildImage $parentStarted.AddSeconds(-1))
    Assert-CaptureRejected
    Assert-Static ([AEReleaseRuntime]::ExitPids.Count -eq 0) 'A known original generation error was weakened by a later absence.'
}
Invoke-StaticCase 'transient-unproved-children-share-one-exit-deadline' {
    $script:mockProcesses[20]=[InvalidOperationException]::new('Synthetic initial handle unavailable.')
    $script:mockProcesses[21]=[InvalidOperationException]::new('Synthetic initial handle unavailable.')
    [AEReleaseRuntime]::ExitResults[20]='native-limited-handle-signaled';[AEReleaseRuntime]::ExitDelays[20]=1000
    [AEReleaseRuntime]::ExitResults[21]='pid-absent'
    $script:mockSnapshot=@((New-ChildInfo 20 10 ''),(New-ChildInfo 21 10 ''))
    Capture-RuntimeChildren
    Assert-Static ([AEReleaseRuntime]::ExitTimeouts.Count -eq 2 -and [AEReleaseRuntime]::ExitTimeouts[0] -le 750 -and [AEReleaseRuntime]::ExitTimeouts[1] -le 2) 'Each transient child received a renewed deadline.'
    Assert-Static ($runtimeOwned.Count -eq 1 -and $runtimeReport.unownedObservations.Count -eq 2) 'Shared-deadline observations acquired ownership.'
}
foreach ($kind in @('root-cim','outside-cim','missing-cim')) {
    Invoke-StaticCase "live-unavailable-actual-image-rejects-$kind" {
        $script:mockProcesses[20]=New-FakeProcess 20 $childStarted
        [AEReleaseRuntime]::Unavailable.Add(20) | Out-Null
        $image=switch($kind){'root-cim'{$ownedChildImage};'outside-cim'{$externalImage};default{''}}
        $script:mockSnapshot=@(New-ChildInfo 20 10 $image)
        Assert-CaptureRejected
        Assert-Static ($runtimeReport.unownedObservations.Count -eq 0) 'A live unknown image masqueraded as an external observation.'
    }
}
Invoke-StaticCase 'root-pid-generation-mismatch-rejects' {
    $script:mockProcesses[20]=New-FakeProcess 20 $childStarted
    [AEReleaseRuntime]::Paths[20]=$ownedChildImage
    $script:mockSnapshot=@(New-ChildInfo 20 10 $ownedChildImage $childStarted.AddSeconds(-2))
    Assert-CaptureRejected
    Assert-Static ([AEReleaseRuntime]::ExitPids.Count -eq 0) 'A root generation rejection entered the transient exit branch.'
}
Invoke-StaticCase 'root-cim-pid-reuse-cannot-masquerade-as-outside' {
    $script:mockProcesses[20]=New-FakeProcess 20 $childStarted
    [AEReleaseRuntime]::Paths[20]=$externalImage
    $script:mockSnapshot=@(New-ChildInfo 20 10 $ownedChildImage $childStarted.AddSeconds(-2))
    Assert-CaptureRejected
}
Invoke-StaticCase 'actual-root-child-predating-retained-parent-rejects' {
    $script:mockProcesses[20]=New-FakeProcess 20 $parentStarted.AddSeconds(-1)
    [AEReleaseRuntime]::Paths[20]=$ownedChildImage
    $script:mockSnapshot=@(New-ChildInfo 20 10 $ownedChildImage $parentStarted.AddSeconds(-1))
    Assert-CaptureRejected
}
Invoke-StaticCase 'owned-root-hash-unavailable-rejects' {
    $script:mockProcesses[20]=New-FakeProcess 20 $childStarted
    [AEReleaseRuntime]::Paths[20]=$ownedChildImage
    $script:mockSnapshot=@(New-ChildInfo 20 10 $ownedChildImage)
    $script:rejectHash=$true
    [AEReleaseRuntime]::ExitResults[20]='native-limited-handle-signaled'
    Assert-CaptureRejected
    Assert-Static ([AEReleaseRuntime]::ExitPids.Count -eq 0) 'A root hash rejection was downgraded by an exit proof.'
}
Invoke-StaticCase 'owned-root-reparse-or-ancestor-rejection-stays-closed' {
    $script:mockProcesses[20]=New-FakeProcess 20 $childStarted
    [AEReleaseRuntime]::Paths[20]=$ownedChildImage
    $script:mockSnapshot=@(New-ChildInfo 20 10 $ownedChildImage)
    $script:rejectPath=$true
    [AEReleaseRuntime]::ExitResults[20]='native-limited-handle-signaled'
    Assert-CaptureRejected
    Assert-Static ([AEReleaseRuntime]::ExitPids.Count -eq 0) 'A root path rejection was downgraded by an exit proof.'
}
Invoke-StaticCase 'actual-root-child-retains-handle-time-path-and-hash' {
    $script:mockProcesses[20]=New-FakeProcess 20 $childStarted
    [AEReleaseRuntime]::Paths[20]=$ownedChildImage
    $script:mockSnapshot=@(New-ChildInfo 20 10 '')
    Capture-RuntimeChildren
    Assert-Static ($runtimeOwned.ContainsKey(20) -and $runtimeOwned[20].started -eq $childStarted -and $runtimeOwned[20].path -eq $ownedChildImage -and $runtimeOwned[20].hash -eq $hashValue) 'Owned actual identity was lost.'
    Assert-Static ($mockProcesses[20].DisposeCalls -eq 0) 'The actual owned handle was disposed before cleanup.'
}
Invoke-StaticCase 'retained-start-time-change-rejects' {
    $parentProcess.StartTime=$parentStarted.AddSeconds(1)
    $failed=$false;try{Assert-RuntimeProcess $runtimeOwned[10] $true}catch{$failed=$true}
    Assert-Static $failed 'A retained PID-generation change was accepted.'
}
Invoke-StaticCase 'retained-image-change-rejects' {
    [AEReleaseRuntime]::Paths[10]=$ownedChildImage
    $failed=$false;try{Assert-RuntimeProcess $runtimeOwned[10] $true}catch{$failed=$true}
    Assert-Static $failed 'A retained actual image change was accepted.'
}
Invoke-StaticCase 'retained-hash-change-rejects' {
    $script:hashValue='b' * 64
    $failed=$false;try{Assert-RuntimeProcess $runtimeOwned[10] $true}catch{$failed=$true}
    Assert-Static $failed 'A retained hash change was accepted.'
}
Invoke-StaticCase 'live-foreign-root-argument-blocks-cleanup-without-stop' {
    $script:mockProcesses[20]=New-FakeProcess 20 $childStarted
    [AEReleaseRuntime]::Paths[20]=$externalImage
    $script:mockSnapshot=@(New-ChildInfo 20 10 $externalImage $childStarted ("--data="+$runtimeRoot.Replace('\','/')+" --api-key=$apiKeySentinel"))
    $references=@(Get-RuntimeLiveRootReferences)
    Assert-Static ($references.Count -eq 1 -and $mockProcesses[20].KillCalls -eq 0) 'A foreign live UUID reference was ignored or stopped.'
}
Invoke-StaticCase 'unknown-live-root-reference-query-failure-rejects-cleanup' {
    $script:mockProcesses[20]=[InvalidOperationException]::new('Synthetic live status unavailable.')
    $script:mockSnapshot=@(New-ChildInfo 20 10 $ownedChildImage)
    $failed=$false;try{$null=Get-RuntimeLiveRootReferences}catch{$failed=$true}
    Assert-Static $failed 'An unproved live UUID reference was silently ignored.'
}
Invoke-StaticCase 'stale-exited-root-reference-is-not-live' {
    $script:mockSnapshot=@(New-ChildInfo 20 10 $ownedChildImage)
    Assert-Static (@(Get-RuntimeLiveRootReferences).Count -eq 0) 'A proven-exited snapshot remained a live reference.'
}
foreach ($proof in @('pid-absent','native-limited-handle-signaled')) {
    Invoke-StaticCase "wrapped-root-reference-exit-$proof-is-proved-with-read-only-query" {
        $script:mockProcesses[20] = [Management.Automation.MethodInvocationException]::new('Synthetic wrapped absent PID.', [ArgumentException]::new('Synthetic absent PID.'))
        [AEReleaseRuntime]::ExitResults[20] = $proof
        $script:mockSnapshot = @(New-ChildInfo 20 10 $ownedChildImage $childStarted)
        Assert-Static (@(Get-RuntimeLiveRootReferences).Count -eq 0) 'A natively proved exited wrapped reference remained live.'
        Assert-Static ([AEReleaseRuntime]::ExitPids.Count -eq 1 -and [AEReleaseRuntime]::ExitExpectedTicks[0] -eq $childStarted.Ticks -and [AEReleaseRuntime]::ExitEarliestTicks[0] -eq 0 -and [AEReleaseRuntime]::ExitTimeouts[0] -eq 0) 'Cleanup exit proof lost the snapshot PID generation or zero-time bounded read-only query.'
    }
}
foreach ($proof in @('live-or-unavailable','generation-mismatch','creation-unavailable','exit-status-unavailable')) {
    Invoke-StaticCase "wrapped-root-reference-$proof-remains-fail-closed" {
        $script:mockProcesses[20] = [Management.Automation.MethodInvocationException]::new('Synthetic wrapper.', [ArgumentException]::new('Synthetic unproved PID.'))
        [AEReleaseRuntime]::ExitResults[20] = $proof
        $script:mockSnapshot = @(New-ChildInfo 20 10 $ownedChildImage $childStarted)
        $failed = $false; try { $null = Get-RuntimeLiveRootReferences } catch { $failed = $true }
        Assert-Static $failed 'An unavailable, live or mismatched wrapped PID bypassed cleanup refusal.'
    }
}
Invoke-StaticCase 'root-reference-native-exit-query-exception-remains-fail-closed' {
    $script:mockProcesses[20] = [Management.Automation.MethodInvocationException]::new('Synthetic wrapper.', [ArgumentException]::new('Synthetic unproved PID.'))
    [AEReleaseRuntime]::ExitFailures.Add(20) | Out-Null
    $script:mockSnapshot = @(New-ChildInfo 20 10 $ownedChildImage $childStarted)
    $failed = $false; try { $null = Get-RuntimeLiveRootReferences } catch { $failed = $true }
    Assert-Static $failed 'An exit-proof exception bypassed cleanup refusal.'
}
Invoke-StaticCase 'retained-owned-process-must-exit-before-tree-cleanup' {
    $failed=$false;try{Remove-RuntimeTree}catch{$failed=$true}
    Assert-Static ($failed -and -not $runtimeReport.cleanup.Contains('retainedOwnedProcessesAllExited')) 'Cleanup reached the tree with an owned process still alive.'
}
Invoke-StaticCase 'foreign-observation-does-not-bypass-or-block-owned-exit-and-reference-proofs' {
    $foreign=New-FakeProcess 20 $childStarted
    $script:mockProcesses[20]=$foreign;[AEReleaseRuntime]::Paths[20]=$externalImage
    $script:mockSnapshot=@(New-ChildInfo 20 10 $externalImage)
    Capture-RuntimeChildren
    $parentProcess.HasExited=$true
    $barrier=$false
    try{Remove-RuntimeTree}catch{$barrier=$_.Exception.Message -eq 'NO_DELETE_STATIC_TEST_BARRIER'}
    Assert-Static ($barrier -and $runtimeReport.cleanup.retainedOwnedProcessesAllExited -and $runtimeReport.cleanup.liveReferenceCount -eq 0) 'A foreign observation changed the required cleanup proofs.'
}
$udf=Join-Path $runtimeRoot 'data/webview'
$childUdf=Join-Path $udf 'EBWebView'
$command='"G:\Static Test\msedgewebview2.exe"'
foreach($path in @($udf,$childUdf)){
    Invoke-StaticCase 'native-argv-quoted-current-exact-data-path' {
        $check=Get-RuntimeWebviewDataCheck 20 ($command+' "--user-data-dir='+$path+'" --api-key='+$apiKeySentinel)
        Assert-Static $check.matched 'A valid exact UUID WebView data path was rejected.'
        Assert-Static (-not ($check | ConvertTo-Json -Depth 8 -Compress).Contains($apiKeySentinel)) 'The argv parser logged an unrelated secret.'
    }
}
foreach($path in @(($udf+'\Other'),($childUdf+'\Default'),($udf+'-sibling'),'C:\Outside')){
    Invoke-StaticCase 'native-argv-outside-or-descendant-data-path-rejected' {
        $check=Get-RuntimeWebviewDataCheck 20 ($command+' "--user-data-dir='+$path+'"')
        Assert-Static (-not $check.matched) 'An arbitrary WebView data path was accepted.'
    }
}
function Save-StaticFixtureManifest {
    $null = Assert-StaticRealRuntimePath $fixtureManifestPath $true
    $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($fixtureManifestPath))
    $manifest = [ordered]@{ runId = $fixtureRunId; purpose = $fixturePurpose; workspace = $workspace; harnessSha256 = $fixtureHarnessHash; roots = $fixtureOwnedRoots.ToArray(); createdLinks = $fixtureOwnedLinks.ToArray(); cleanup = $fixtureCleanup }
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($manifest | ConvertTo-Json -Depth 10))
    if ($fixtureManifestHash) {
        if ((Get-FileHash -LiteralPath $fixtureManifestPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $fixtureManifestHash) { throw 'The current fixture manifest changed outside its owned run.' }
        [IO.File]::WriteAllBytes($fixtureManifestPath,$bytes)
    } else {
        $stream = [IO.File]::Open($fixtureManifestPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    }
    $script:fixtureManifestHash = (Get-FileHash -LiteralPath $fixtureManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
}
function New-StaticFixtureRoot {
    $id = [Guid]::NewGuid().ToString('N')
    $fixtureBase = Assert-StaticRealRuntimePath (Join-Path $workspace '.cache/desktop-runtime-lock-static') $true
    $null = [IO.Directory]::CreateDirectory($fixtureBase)
    $null = Assert-StaticRealRuntimePath $fixtureBase
    $root = Assert-StaticRealRuntimePath (Join-Path $fixtureBase $id) $true
    [AEReleaseRuntimeStaticNative]::CreateFreshDirectory($root)
    $marker = Join-Path $root '.ae-desktop-runtime-static-owner.json'
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(([ordered]@{ id = $id; runId = $fixtureRunId; purpose = $fixturePurpose; workspace = $workspace; harnessSha256 = $fixtureHarnessHash; createdAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress))
    $stream = [IO.File]::Open($marker,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    $fixtureOwnedRoots.Add([pscustomobject]@{ id = $id; root = $root; marker = $marker; markerSha256 = (Get-FileHash -LiteralPath $marker -Algorithm SHA256).Hash.ToLowerInvariant(); removed = $false })
    Save-StaticFixtureManifest
    return $root
}
function New-StaticFixtureJunction([string]$Path,[string]$Target) {
    $absolute = Assert-StaticRealRuntimePath $Path $true
    $actualTarget = Assert-StaticRealRuntimePath $Target
    $owners = @($fixtureOwnedRoots | Where-Object { -not $_.removed -and $absolute.StartsWith($_.root+'\',[StringComparison]::OrdinalIgnoreCase) })
    if ($owners.Count -ne 1 -or -not $actualTarget.StartsWith($owners[0].root+'\',[StringComparison]::OrdinalIgnoreCase) -or -not ([IO.File]::GetAttributes($actualTarget) -band [IO.FileAttributes]::Directory)) { throw 'A fixture junction requires one fresh owned UUID and its ordinary internal target.' }
    if ([IO.File]::Exists($absolute) -or [IO.Directory]::Exists($absolute)) { throw 'Fixture junction paths must be fresh.' }
    $record = [pscustomobject]@{ ownerId = $owners[0].id; path = $absolute; target = $actualTarget; created = $false; removed = $false }
    $fixtureOwnedLinks.Add($record); Save-StaticFixtureManifest
    $null = New-Item -ItemType Junction -Path $absolute -Target $actualTarget -ErrorAction Stop
    $record.created = $true; Save-StaticFixtureManifest
}
function Assert-StaticFixtureOwner($owner) {
    $expected = [IO.Path]::GetFullPath((Join-Path $workspace ".cache/desktop-runtime-lock-static/$($owner.id)"))
    if ($owner.id -cnotmatch '^[a-f0-9]{32}$' -or $owner.root -cne $expected -or $owner.marker -cne (Join-Path $expected '.ae-desktop-runtime-static-owner.json')) { throw 'An exact generated fixture UUID is required.' }
    $null = Assert-StaticRealRuntimePath $owner.root; $null = Assert-StaticRealRuntimePath $owner.marker
    if ((Get-FileHash -LiteralPath $owner.marker -Algorithm SHA256).Hash.ToLowerInvariant() -cne $owner.markerSha256) { throw 'Fixture ownership marker bytes changed.' }
    $marker = [IO.File]::ReadAllText($owner.marker,[Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($marker.id -cne $owner.id -or $marker.runId -cne $fixtureRunId -or $marker.purpose -cne $fixturePurpose -or $marker.workspace -cne $workspace -or $marker.harnessSha256 -cne $fixtureHarnessHash) { throw 'Fixture ownership marker identity changed.' }
}
function Assert-StaticFixtureLink($owner,[string]$path) {
    $records = @($fixtureOwnedLinks | Where-Object { $_.ownerId -ceq $owner.id -and $_.path -ceq $path -and $_.created -and -not $_.removed })
    if ($records.Count -ne 1) { throw 'Cleanup refuses a junction without this run exact creation record.' }
    $record = $records[0]
    $null = Assert-StaticRealRuntimePath ([IO.Path]::GetDirectoryName($path))
    $metadata = Microsoft.PowerShell.Management\Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if (-not $metadata.PSIsContainer -or -not ($metadata.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $metadata.LinkType -cne 'Junction' -or @($metadata.Target).Count -ne 1 -or [IO.Path]::GetFullPath(@($metadata.Target)[0]) -cne $record.target -or -not $record.target.StartsWith($owner.root+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'A recorded fixture junction changed before cleanup.' }
    $null = Assert-StaticRealRuntimePath $record.target
    if (-not ([IO.File]::GetAttributes($record.target) -band [IO.FileAttributes]::Directory)) { throw 'A fixture junction target is no longer ordinary.' }
    return $record
}
function Invoke-StaticFixtureCleanup {
    $fixtureCleanup.attempted = $true
    $null = Assert-StaticRealRuntimePath $fixtureManifestPath
    if (-not $fixtureManifestHash -or (Get-FileHash -LiteralPath $fixtureManifestPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $fixtureManifestHash) { throw 'The exact current-run fixture manifest is unavailable or changed.' }
    $plans = [Collections.Generic.List[object]]::new()
    $visited = 0
    foreach ($owner in $fixtureOwnedRoots | Where-Object { -not $_.removed }) {
        Assert-StaticFixtureOwner $owner
        $pending = [Collections.Generic.Stack[string]]::new(); $pending.Push($owner.root)
        $directories = [Collections.Generic.List[string]]::new(); $files = [Collections.Generic.List[string]]::new(); $links = [Collections.Generic.List[object]]::new()
        while ($pending.Count) {
            $current = Assert-StaticRealRuntimePath $pending.Pop(); $directories.Add($current)
            foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($current)) {
                if (++$visited -gt 40000) { throw 'The full current-run fixture cleanup exceeds its total bounded entry limit.' }
                $path = [IO.Path]::GetFullPath($entry)
                if (-not $path.StartsWith($owner.root+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'A fixture tree entry escaped its UUID.' }
                $attributes = [IO.File]::GetAttributes($path)
                if ($attributes -band [IO.FileAttributes]::ReparsePoint) { $links.Add((Assert-StaticFixtureLink $owner $path)) }
                else { $null = Assert-StaticRealRuntimePath $path; if ($attributes -band [IO.FileAttributes]::Directory) { $pending.Push($path) } else { $files.Add($path) } }
                if ($directories.Count+$files.Count+$links.Count+$pending.Count -gt 40000) { throw 'The fixture tree exceeds its bounded audit limit.' }
            }
        }
        foreach ($path in @($directories)+@($files)+@($links | ForEach-Object { $_.path })) { if (-not [AEStaticFixtureDeleteProbe]::Allowed($path)) { throw 'A fixture path is locked; the owned roots are retained.' } }
        $plans.Add([pscustomobject]@{ owner = $owner; directories = $directories.ToArray(); files = $files.ToArray(); links = $links.ToArray() })
    }
    # Invoke the actual cmdlet, bypassing this suite's synthetic CIM function.
    $snapshot = @(CimCmdlets\Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
    foreach ($plan in $plans) {
        foreach ($process in $snapshot) {
            if (($process.ExecutablePath -and $process.ExecutablePath.StartsWith($plan.owner.root+'\',[StringComparison]::OrdinalIgnoreCase)) -or ($process.CommandLine -and $process.CommandLine.Replace('/','\').Contains($plan.owner.root,[StringComparison]::OrdinalIgnoreCase))) { throw 'A fixture UUID still has a process reference; cleanup refused.' }
        }
        Assert-StaticFixtureOwner $plan.owner
    }
    foreach ($plan in $plans) {
        foreach ($link in $plan.links) { $null = Assert-StaticFixtureLink $plan.owner $link.path; [IO.Directory]::Delete($link.path,$false); $link.removed = $true }
        foreach ($file in $plan.files) { if ($file -cne $plan.owner.marker) { $null = Assert-StaticRealRuntimePath $file; [IO.File]::Delete($file) } }
        for ($index=$plan.directories.Count-1;$index -gt 0;$index--) { $null = Assert-StaticRealRuntimePath $plan.directories[$index]; [IO.Directory]::Delete($plan.directories[$index],$false) }
        Assert-StaticFixtureOwner $plan.owner; [IO.File]::Delete($plan.owner.marker)
        $null = Assert-StaticRealRuntimePath $plan.owner.root; [IO.Directory]::Delete($plan.owner.root,$false)
        $plan.owner.removed = $true; $fixtureCleanup.removedRoots++
    }
    $fixtureCleanup.retainedRoots = @($fixtureOwnedRoots | Where-Object { -not $_.removed }).Count
    $fixtureCleanup.passed = $fixtureCleanup.retainedRoots -eq 0
    Save-StaticFixtureManifest
}
function New-MetadataFixture {
    $fixtureRoot = New-StaticFixtureRoot
    $null = [IO.Directory]::CreateDirectory((Join-Path $fixtureRoot 'data'))
    $script:runtimeRoot = Assert-StaticRealRuntimePath $fixtureRoot
    $script:useActualMetadataPaths = $true; $script:useActualMetadataHashes = $true
}
function New-CleanupDeleteFixture {
    New-MetadataFixture
    $script:useActualRuntimeTree = $true
    $script:cleanupFixtureOwner = $fixtureOwnedRoots[$fixtureOwnedRoots.Count-1]
    $script:runtimeMarker = $cleanupFixtureOwner.marker
    $script:runtimeId = $cleanupFixtureOwner.id
    $script:cleanupSentinel = Join-Path $runtimeRoot 'data/a-preserved-before-locked.txt'
    $script:cleanupLockedPath = Join-Path $runtimeRoot 'data/z-transient-sharing-lock.txt'
    [IO.File]::WriteAllText($cleanupSentinel,'synthetic-preserved-before-delete',[Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($cleanupLockedPath,'synthetic-sharing-lock',[Text.UTF8Encoding]::new($false))
    $parentProcess.HasExited = $true
}
Invoke-StaticCase 'cleanup-sharing-lock-natural-release-succeeds-before-deadline' {
    New-CleanupDeleteFixture
    $lock = [AEStaticFixtureTimedLock]::new($cleanupLockedPath)
    try {
        Assert-Static (-not [AEStaticFixtureDeleteProbe]::Allowed($cleanupLockedPath)) 'The fixture did not deny DELETE access before natural release.'
        $lock.ReleaseAfter(1000)
        $failure = ''; try { Remove-RuntimeTree -DeleteAccessTimeoutMilliseconds 3000 } catch { $failure = $_.Exception.Message }
        Assert-Static (-not $failure -and -not [IO.Directory]::Exists($runtimeRoot)) 'A transient sharing lock was not allowed to release naturally before marker-last cleanup.'
        $cleanupFixtureOwner.removed = $true; $fixtureCleanup.removedRoots++; Save-StaticFixtureManifest
        Assert-Static ($runtimeReport.cleanup.deleteAccess.completed -and $runtimeReport.cleanup.deleteAccess.waitedForSharingOrLock -and $runtimeReport.cleanup.deleteAccess.attempts -gt 1) 'Successful cleanup omitted its read-only sharing-lock wait evidence.'
        $deleteAccessRegressionEvidence.Add([ordered]@{ name = 'real-sharing-lock-natural-release'; ownedRootRemoved = $true; timedFixtureReleaseOnly = $true; diagnostics = $runtimeReport.cleanup.deleteAccess })
    } finally { $lock.Dispose() }
}
Invoke-StaticCase 'cleanup-sharing-lock-timeout-preserves-entire-owned-tree' {
    New-CleanupDeleteFixture
    $lock = [AEStaticFixtureTimedLock]::new($cleanupLockedPath)
    try {
        $failure = ''; try { Remove-RuntimeTree -DeleteAccessTimeoutMilliseconds 180 } catch { $failure = $_.Exception.Message }
        Assert-Static ($failure -and [IO.File]::Exists($runtimeMarker) -and [IO.File]::Exists($cleanupSentinel) -and [IO.File]::Exists($cleanupLockedPath)) 'A persistent sharing lock did not fail before every deletion, preserving marker and ordinary files.'
        Assert-Static (-not $runtimeReport.cleanup.deleteAccess.completed -and $runtimeReport.cleanup.deleteAccess.waitedForSharingOrLock -and $runtimeReport.cleanup.deleteAccess.timeoutMilliseconds -eq 180 -and $runtimeReport.cleanup.deleteAccess.lastBlockedPaths[0].win32Error -eq 32) 'Persistent sharing-lock refusal omitted bounded Win32 evidence.'
        Assert-Static ([IO.File]::ReadAllText($cleanupSentinel) -ceq 'synthetic-preserved-before-delete') 'A persistent lock changed an ordinary sentinel.'
        Assert-StaticFixtureOwner $cleanupFixtureOwner
        $deleteAccessRegressionEvidence.Add([ordered]@{ name = 'real-sharing-lock-persistent'; markerAndOrdinaryFilesPreserved = $true; diagnostics = $runtimeReport.cleanup.deleteAccess })
    } finally { $lock.Dispose() }
}
Invoke-StaticCase 'cleanup-delete-probe-grants-access-without-deleting-files-or-directories' {
    New-CleanupDeleteFixture
    foreach ($path in @($runtimeMarker, $cleanupSentinel, $cleanupLockedPath, $runtimeRoot)) {
        Assert-Static ([AEReleaseRuntimeStaticNative]::DeleteAccess($path) -eq 0) 'DELETE-access permission on an ordinary fixture path was rejected.'
        Assert-Static ([IO.File]::Exists($path) -or [IO.Directory]::Exists($path)) 'A read-only DELETE-access probe deleted a fixture path.'
    }
    Assert-Static ([AEReleaseRuntimeStaticNative]::DeleteAccess((Join-Path $runtimeRoot 'missing-file')) -eq 2) 'The native probe did not preserve the exact missing-file Win32 error.'
    Assert-StaticFixtureOwner $cleanupFixtureOwner
}
foreach ($errorCode in @(2, 5)) {
    Invoke-StaticCase "cleanup-nonsharing-win32-error-$errorCode-fails-before-deletion" {
        New-CleanupDeleteFixture
        [AEReleaseRuntime]::DeleteErrors[$cleanupLockedPath] = $errorCode
        $failure = ''; try { Remove-RuntimeTree -DeleteAccessTimeoutMilliseconds 500 } catch { $failure = $_.Exception.Message }
        Assert-Static ($failure -like '*nonretryable Win32 error*' -and $runtimeReport.cleanup.deleteAccess.attempts -eq 1 -and -not $runtimeReport.cleanup.deleteAccess.waitedForSharingOrLock -and $runtimeReport.cleanup.deleteAccess.failure.win32Error -eq $errorCode) 'A nonsharing error was retried or omitted from the exact refusal evidence.'
        Assert-Static ([IO.File]::Exists($cleanupSentinel) -and [IO.File]::Exists($cleanupLockedPath)) 'A nonsharing error reached ordinary deletion.'
        Assert-StaticFixtureOwner $cleanupFixtureOwner
    }
}
Invoke-StaticCase 'cleanup-win32-lock-violation-33-is-the-only-other-retryable-error' {
    New-CleanupDeleteFixture
    [AEReleaseRuntime]::DeleteErrors[$cleanupLockedPath] = 33
    $script:afterDeleteProbe = { $null = [AEReleaseRuntime]::DeleteErrors.Remove($cleanupLockedPath) }
    Remove-RuntimeTree -DeleteAccessTimeoutMilliseconds 1000
    Assert-Static (-not [IO.Directory]::Exists($runtimeRoot) -and $runtimeReport.cleanup.deleteAccess.completed -and $runtimeReport.cleanup.deleteAccess.waitedForSharingOrLock -and $runtimeReport.cleanup.deleteAccess.attempts -eq 2) 'Win32 lock violation 33 did not retry through full guards before cleanup.'
    $cleanupFixtureOwner.removed = $true; $fixtureCleanup.removedRoots++; Save-StaticFixtureManifest
}
Invoke-StaticCase 'cleanup-marker-byte-change-after-probe-fails-before-any-deletion' {
    New-CleanupDeleteFixture
    $markerBytes = [IO.File]::ReadAllBytes($runtimeMarker)
    [AEReleaseRuntime]::DeleteErrors[$cleanupLockedPath] = 32
    $script:afterDeleteProbe = { [IO.File]::WriteAllText($runtimeMarker,'synthetic-marker-change',[Text.UTF8Encoding]::new($false)) }
    try {
        $failure = ''; try { Remove-RuntimeTree -DeleteAccessTimeoutMilliseconds 1000 } catch { $failure = $_.Exception.Message }
        Assert-Static ($failure -eq 'Fixture ownership marker bytes changed.' -and $runtimeReport.cleanup.deleteAccess.attempts -eq 2 -and [IO.File]::Exists($cleanupSentinel) -and [IO.File]::Exists($cleanupLockedPath)) 'A marker change during sharing-lock wait bypassed repeated ownership validation.'
    } finally { [IO.File]::WriteAllBytes($runtimeMarker,$markerBytes); Assert-StaticFixtureOwner $cleanupFixtureOwner }
}
Invoke-StaticCase 'cleanup-retained-live-process-after-probe-fails-before-any-deletion' {
    New-CleanupDeleteFixture
    [AEReleaseRuntime]::DeleteErrors[$cleanupLockedPath] = 32
    $parentProcess | Add-Member -MemberType ScriptMethod -Name Refresh -Force -Value { if ([AEReleaseRuntime]::DeleteProbePaths.Count) { $this.HasExited = $false } }
    $failure = ''; try { Remove-RuntimeTree -DeleteAccessTimeoutMilliseconds 1000 } catch { $failure = $_.Exception.Message }
    Assert-Static ($failure -like '*retained owned process is still alive*' -and $runtimeReport.cleanup.deleteAccess.attempts -eq 2 -and [IO.File]::Exists($cleanupSentinel) -and [IO.File]::Exists($cleanupLockedPath)) 'An owned process becoming live bypassed repeated exit validation.'
    Assert-StaticFixtureOwner $cleanupFixtureOwner
}
Invoke-StaticCase 'cleanup-live-uuid-reference-after-probe-fails-before-any-deletion' {
    New-CleanupDeleteFixture
    [AEReleaseRuntime]::DeleteErrors[$cleanupLockedPath] = 32
    $script:mockProcesses[20] = New-FakeProcess 20 $childStarted
    $script:afterDeleteProbe = { $script:mockSnapshot = @(New-ChildInfo 20 10 $externalImage $childStarted ('synthetic-reference '+$runtimeRoot)) }
    $failure = ''; try { Remove-RuntimeTree -DeleteAccessTimeoutMilliseconds 1000 } catch { $failure = $_.Exception.Message }
    Assert-Static ($failure -like '*live runtime process references appeared*' -and $runtimeReport.cleanup.liveReferenceCount -eq 1 -and $runtimeReport.cleanup.deleteAccess.attempts -eq 2 -and [IO.File]::Exists($cleanupSentinel)) 'A newly observed live UUID reference bypassed the repeated reference guard.'
    Assert-StaticFixtureOwner $cleanupFixtureOwner
}
Invoke-StaticCase 'cleanup-new-reparse-point-after-probe-rejects-without-traversal-or-deletion' {
    New-CleanupDeleteFixture
    [AEReleaseRuntime]::DeleteErrors[$cleanupLockedPath] = 32
    $script:afterDeleteProbe = { New-StaticFixtureJunction (Join-Path $runtimeRoot 'data/new-unapproved-link') (Join-Path $runtimeRoot 'data') }
    $failure = ''; try { Remove-RuntimeTree -DeleteAccessTimeoutMilliseconds 1000 } catch { $failure = $_.Exception.Message }
    Assert-Static ($failure -eq 'Only this exact UUID native INetCache alias is permitted.' -and $runtimeReport.cleanup.deleteAccess.attempts -eq 2 -and [IO.File]::Exists($cleanupSentinel) -and [IO.File]::Exists($cleanupLockedPath)) 'A new unapproved reparse point bypassed the full ordinary-tree audit during wait.'
    Assert-StaticFixtureOwner $cleanupFixtureOwner
}
Invoke-StaticCase 'cleanup-unprobed-new-ordinary-file-rejects-before-marker-last-deletion' {
    New-CleanupDeleteFixture
    $script:afterDeleteProbe = { [IO.File]::WriteAllText((Join-Path $runtimeRoot 'data/new-unprobed-file'),'synthetic-new-file',[Text.UTF8Encoding]::new($false)) }
    $failure = ''; try { Remove-RuntimeTree -DeleteAccessTimeoutMilliseconds 1000 } catch { $failure = $_.Exception.Message }
    Assert-Static ($failure -eq 'The ordinary runtime tree changed during DELETE-access validation; tree cleanup refused.' -and $runtimeReport.cleanup.deleteAccess.attempts -eq 1 -and [IO.File]::Exists($cleanupSentinel) -and [IO.File]::Exists((Join-Path $runtimeRoot 'data/new-unprobed-file'))) 'A newly introduced unprobed ordinary file reached the deletion tail.'
    Assert-StaticFixtureOwner $cleanupFixtureOwner
}
Invoke-StaticCase 'cleanup-default-and-injected-deadlines-remain-bounded' {
    New-CleanupDeleteFixture
    Assert-Static ($removeText.Contains('$deleteAccessTimeoutMilliseconds = 180000',[StringComparison]::Ordinal)) 'The production sharing-lock deadline changed from 180 seconds.'
    foreach ($invalid in @(-1, 180001)) {
        $failed = $false; try { Remove-RuntimeTree -DeleteAccessTimeoutMilliseconds $invalid } catch { $failed = $true }
        Assert-Static ($failed -and [AEReleaseRuntime]::DeleteProbePaths.Count -eq 0 -and [IO.File]::Exists($cleanupSentinel)) 'An unbounded injected deadline was accepted or reached deletion.'
    }
    [AEReleaseRuntime]::DeleteErrors[$cleanupLockedPath] = 32
    $failure = ''; try { Remove-RuntimeTree -DeleteAccessTimeoutMilliseconds 0 } catch { $failure = $_.Exception.Message }
    Assert-Static ($failure -like '*bounded natural-release wait*' -and $runtimeReport.cleanup.deleteAccess.attempts -eq 1 -and $runtimeReport.cleanup.deleteAccess.timeoutMilliseconds -eq 0 -and [IO.File]::Exists($cleanupSentinel)) 'A zero injected deadline waited or reached deletion.'
    Assert-StaticFixtureOwner $cleanupFixtureOwner
}
Invoke-StaticCase 'canonical-exclusive-app-lock-is-protected-without-opening-bytes' {
    New-MetadataFixture
    $lockPath=Join-Path $runtimeRoot 'data/app.lock'
    [IO.File]::WriteAllText($lockPath,'synthetic-lock',[Text.UTF8Encoding]::new($false))
    $stream=[IO.File]::Open($lockPath,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    try {
        $before=Get-RuntimeStableFiles; $after=Get-RuntimeStableFiles
        Assert-Static ($before.Contains('data/app.lock') -and $before['data/app.lock'].kind -eq 'ordinary-file-metadata' -and -not $before['data/app.lock'].contentHashRecorded -and $before['data/app.lock'].length -eq $stream.Length) 'The exclusively locked canonical path was not protected by its metadata.'
        Assert-Static (-not $hashedPaths.Contains($lockPath)) 'The canonical lock bytes were opened for hashing.'
        Assert-Static (($before | ConvertTo-Json -Depth 8 -Compress) -ceq ($after | ConvertTo-Json -Depth 8 -Compress)) 'Unchanged locked-file metadata was unstable.'
        $stream.SetLength($stream.Length+1);$stream.Flush($true)
        $changed=Get-RuntimeStableFiles
        Assert-Static (($before | ConvertTo-Json -Depth 8 -Compress) -cne ($changed | ConvertTo-Json -Depth 8 -Compress)) 'A canonical lock length change was ignored.'
    } finally { $stream.Dispose() }
}
Invoke-StaticCase 'canonical-lock-last-write-change-is-detected' {
    New-MetadataFixture
    $lockPath=Join-Path $runtimeRoot 'data/app.lock'
    [IO.File]::WriteAllText($lockPath,'synthetic-lock',[Text.UTF8Encoding]::new($false))
    $before=Get-RuntimeStableFiles
    [IO.File]::SetLastWriteTimeUtc($lockPath,[IO.File]::GetLastWriteTimeUtc($lockPath).AddMinutes(1))
    $after=Get-RuntimeStableFiles
    Assert-Static (($before | ConvertTo-Json -Depth 8 -Compress) -cne ($after | ConvertTo-Json -Depth 8 -Compress)) 'A canonical lock timestamp change was ignored.'
}
Invoke-StaticCase 'canonical-lock-path-membership-change-is-detected' {
    New-MetadataFixture
    $lockPath=Join-Path $runtimeRoot 'data/app.lock';$movedPath=Join-Path $runtimeRoot 'data/app.lock.moved'
    [IO.File]::WriteAllText($lockPath,'synthetic-lock',[Text.UTF8Encoding]::new($false))
    $before=Get-RuntimeStableFiles
    $null=Assert-StaticRealRuntimePath $lockPath;$null=Assert-StaticRealRuntimePath $movedPath $true
    [IO.File]::Move($lockPath,$movedPath)
    try {
        $after=Get-RuntimeStableFiles
        Assert-Static (-not $after.Contains('data/app.lock') -and $after.Contains('data/app.lock.moved') -and ($before | ConvertTo-Json -Depth 8 -Compress) -cne ($after | ConvertTo-Json -Depth 8 -Compress)) 'The protected lock path collection changed without detection.'
    } finally { [IO.File]::Move($movedPath,$lockPath) }
}
foreach($relative in @('app.lock','data/nested/app.lock','data/app.lock.sibling')) {
    Invoke-StaticCase "noncanonical-lock-still-requires-content-hash-$relative" {
        New-MetadataFixture
        $path=Join-Path $runtimeRoot $relative
        $null=[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path))
        [IO.File]::WriteAllText($path,'synthetic-other-lock',[Text.UTF8Encoding]::new($false))
        $stream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
        try {
            $failed=$false;try{$null=Get-RuntimeStableFiles}catch{$failed=$true}
            Assert-Static ($failed -and $hashedPaths.Contains($path)) 'A noncanonical app lock bypassed content hashing.'
        } finally { $stream.Dispose() }
    }
}
Invoke-StaticCase 'metadata-helper-refuses-another-lock-or-uuid' {
    New-MetadataFixture
    $path=Join-Path $runtimeRoot 'data/app.lock.sibling'
    [IO.File]::WriteAllText($path,'synthetic-other-lock',[Text.UTF8Encoding]::new($false))
    $failed=$false;try{$null=Get-RuntimeAppLockMetadata $path}catch{$failed=$true}
    Assert-Static $failed 'The metadata helper accepted another app lock.'
    $otherRoot=New-StaticFixtureRoot
    $null=[IO.Directory]::CreateDirectory((Join-Path $otherRoot 'data'))
    $otherPath=Join-Path $otherRoot 'data/app.lock'
    [IO.File]::WriteAllText($otherPath,'synthetic-other-uuid',[Text.UTF8Encoding]::new($false))
    $failed=$false;try{$null=Get-RuntimeAppLockMetadata $otherPath}catch{$failed=$true}
    Assert-Static $failed 'The metadata helper accepted another UUID.'
}
Invoke-StaticCase 'other-data-files-retain-content-hash-and-change-detection' {
    New-MetadataFixture
    $path=Join-Path $runtimeRoot 'data/protected.json'
    [IO.File]::WriteAllText($path,'{"synthetic":1}',[Text.UTF8Encoding]::new($false))
    $before=Get-RuntimeStableFiles
    [IO.File]::WriteAllText($path,'{"synthetic":2}',[Text.UTF8Encoding]::new($false))
    $after=Get-RuntimeStableFiles
    Assert-Static ($hashedPaths.Contains($path) -and $before['data/protected.json'] -cne $after['data/protected.json']) 'A different protected data file was excluded or lost its byte hash.'
}
Invoke-StaticCase 'exact-external-volatile-sogou-cache-skips-exclusive-bytes-and-path-churn' {
    New-MetadataFixture
    $cacheRoot=Join-Path $runtimeRoot 'data/home/AppData/LocalLow/SogouPY'
    $cachePath=Join-Path $cacheRoot 'mmkv/engine_0'
    $null=[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($cachePath))
    [IO.File]::WriteAllText($cachePath,'synthetic-external-cache',[Text.UTF8Encoding]::new($false))
    $clientPath=Join-Path $runtimeRoot 'data/clients/provider.json'
    $null=[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($clientPath))
    [IO.File]::WriteAllText($clientPath,'{"protected":1}',[Text.UTF8Encoding]::new($false))
    $stream=[IO.File]::Open($cachePath,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    try {
        $before=Get-RuntimeStableFiles
        $stream.SetLength($stream.Length+1);$stream.Flush($true)
        [IO.File]::WriteAllText((Join-Path $cacheRoot 'volatile-new-file'),'synthetic-cache-churn',[Text.UTF8Encoding]::new($false))
        $after=Get-RuntimeStableFiles
        Assert-Static (($before | ConvertTo-Json -Depth 8 -Compress) -ceq ($after | ConvertTo-Json -Depth 8 -Compress) -and -not $hashedPaths.Contains($cachePath)) 'Exact external volatile cache bytes or paths entered the protected inventory.'
        Assert-Static ($before.Contains('data/clients/provider.json') -and $hashedPaths.Contains($clientPath)) 'Product client files were excluded with the external cache.'
        [IO.File]::WriteAllText($clientPath,'{"protected":2}',[Text.UTF8Encoding]::new($false))
        $changed=Get-RuntimeStableFiles
        Assert-Static ($before['data/clients/provider.json'] -cne $changed['data/clients/provider.json']) 'A product client byte change was weakened by the external cache scope.'
    } finally { $stream.Dispose() }
    Assert-Static ($runtimeReport.externalVolatileProfileCaches.Count -eq 1 -and $runtimeReport.externalVolatileProfileCaches[0] -ceq 'data/home/AppData/LocalLow/SogouPY/**' -and $runtimeReport.sourcePackageReparsePointsAccepted -eq 0) 'The report omitted the exact external cache or source zero-reparse scope.'
}
foreach ($relative in @('data/home/AppData/LocalLow/SogouPY-sibling/mmkv/engine_0','data/home/AppData/Local/SogouPY/mmkv/engine_0','data/SogouPY/mmkv/engine_0')) {
    Invoke-StaticCase "other-sogou-named-paths-remain-protected-$relative" {
        New-MetadataFixture
        $path=Join-Path $runtimeRoot $relative
        $null=[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path))
        [IO.File]::WriteAllText($path,'synthetic-protected-sibling',[Text.UTF8Encoding]::new($false))
        $stream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
        try {
            $failed=$false;try{$null=Get-RuntimeStableFiles}catch{$failed=$true}
            Assert-Static ($failed -and $hashedPaths.Contains($path)) 'A similarly named path bypassed strict byte protection.'
        } finally { $stream.Dispose() }
    }
}
Invoke-StaticCase 'volatile-cache-name-as-file-remains-byte-protected' {
    New-MetadataFixture
    $path=Join-Path $runtimeRoot 'data/home/AppData/LocalLow/SogouPY'
    $null=[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path))
    [IO.File]::WriteAllText($path,'synthetic-ordinary-file',[Text.UTF8Encoding]::new($false))
    $files=Get-RuntimeStableFiles
    Assert-Static ($files.Contains('data/home/AppData/LocalLow/SogouPY') -and $hashedPaths.Contains($path)) 'Only an ordinary external cache directory may be excluded.'
}
function New-CacheAliasFixture {
    New-MetadataFixture
    $script:useActualRuntimeTree=$true
    $script:cacheTarget=Join-Path $runtimeRoot 'data/home/AppData/Local/Microsoft/Windows/INetCache/IE'
    $script:cacheAlias=Join-Path ([IO.Path]::GetDirectoryName($cacheTarget)) 'Content.IE5'
    $null=Assert-StaticRealRuntimePath $cacheTarget $true
    $null=[IO.Directory]::CreateDirectory($cacheTarget)
    $script:cacheSentinel=Join-Path $cacheTarget 'synthetic-target-sentinel.txt'
    [IO.File]::WriteAllText($cacheSentinel,'synthetic-owned-target',[Text.UTF8Encoding]::new($false))
    $null=Assert-StaticRealRuntimePath $cacheAlias $true
    New-StaticFixtureJunction $cacheAlias $cacheTarget
}
function Get-CacheAliasMockMetadata {
    return [pscustomobject]@{ PSIsContainer=$true; Attributes=([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint); LinkType='Junction'; Target=@($script:cacheTarget) }
}
Invoke-StaticCase 'exact-internal-cache-junction-is-audited-without-alias-traversal' {
    New-CacheAliasFixture
    $tree=Get-RuntimeTree $runtimeRoot $true
    Assert-Static ($tree.aliases.Count -eq 1 -and $tree.aliases[0].path -eq $cacheAlias -and $tree.aliases[0].target -eq $cacheTarget -and -not $tree.aliases[0].traversed -and -not $tree.aliases[0].recursiveDeletion) 'The exact ordinary-target native alias was not audited safely.'
    Assert-Static (@($tree.files | Where-Object { $_ -eq $cacheSentinel }).Count -eq 1 -and @($tree.files | Where-Object { $_.StartsWith($cacheAlias+'\',[StringComparison]::OrdinalIgnoreCase) }).Count -eq 0 -and $cacheAlias -notin $tree.directories) 'Tree enumeration traversed the junction or duplicated its ordinary target.'
}
Invoke-StaticCase 'source-copy-still-refuses-even-the-exact-runtime-cache-junction' {
    New-CacheAliasFixture
    $destination=Join-Path $runtimeRoot 'synthetic-copy-must-not-exist'
    $failed=$false;try{Copy-RuntimeTree $runtimeRoot $destination}catch{$failed=$true}
    Assert-Static ($failed -and -not [IO.Directory]::Exists($destination) -and [IO.File]::Exists($cacheSentinel)) 'Source copy accepted a reparse point or mutated its target.'
}
Invoke-StaticCase 'runtime-alias-mode-refuses-another-tree-root' {
    New-CacheAliasFixture
    $failed=$false;try{$null=Get-RuntimeTree $cacheTarget $true}catch{$failed=$true}
    Assert-Static $failed 'Alias acceptance escaped its current exact UUID tree root.'
}
foreach ($kind in @('symbolic-link','not-directory','not-reparse','outside-c-drive','other-uuid','sibling-target','multiple-targets','relative-target')) {
    Invoke-StaticCase "native-cache-alias-rejects-$kind" {
        New-CacheAliasFixture
        $metadata=Get-CacheAliasMockMetadata
        switch($kind) {
            'symbolic-link' {$metadata.LinkType='SymbolicLink'}
            'not-directory' {$metadata.PSIsContainer=$false}
            'not-reparse' {$metadata.Attributes=[IO.FileAttributes]::Directory}
            'outside-c-drive' {$metadata.Target=@('C:\SyntheticOutside\IE')}
            'other-uuid' {$metadata.Target=@(Join-Path ([IO.Path]::GetDirectoryName($runtimeRoot)) 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/data/home/AppData/Local/Microsoft/Windows/INetCache/IE')}
            'sibling-target' {$metadata.Target=@($cacheTarget+'-sibling')}
            'multiple-targets' {$metadata.Target=@($cacheTarget,$cacheTarget)}
            'relative-target' {$metadata.Target=@('IE')}
        }
        $script:mockAliasMetadata[$cacheAlias]=$metadata
        $failed=$false;try{$null=Get-RuntimeTree $runtimeRoot $true}catch{$failed=$true}
        Assert-Static ($failed -and [IO.File]::Exists($cacheSentinel)) 'An invalid alias type/target was accepted or its target mutated.'
    }
}
Invoke-StaticCase 'unexpected-cache-junction-location-rejects-whole-tree' {
    New-CacheAliasFixture
    $otherAlias=Join-Path ([IO.Path]::GetDirectoryName($cacheAlias)) 'Content.IE5-sibling'
    $null=Assert-StaticRealRuntimePath $otherAlias $true
    New-StaticFixtureJunction $otherAlias $cacheTarget
    $failed=$false;try{$null=Get-RuntimeTree $runtimeRoot $true}catch{$failed=$true}
    Assert-Static ($failed -and [IO.File]::Exists($cacheSentinel)) 'Another internal junction was silently accepted.'
}
Invoke-StaticCase 'ordinary-cache-target-with-an-inner-reparse-still-rejects' {
    New-CacheAliasFixture
    $otherAlias=Join-Path $cacheTarget 'unexpected-inner-link'
    $otherTarget=Join-Path $runtimeRoot 'data/synthetic-other-ordinary-target'
    $null=[IO.Directory]::CreateDirectory($otherTarget)
    $null=Assert-StaticRealRuntimePath $otherAlias $true
    New-StaticFixtureJunction $otherAlias $otherTarget
    $failed=$false;try{$null=Get-RuntimeTree $runtimeRoot $true}catch{$failed=$true}
    Assert-Static $failed 'The alias target subtree bypassed the full ordinary-tree audit.'
}
Invoke-StaticCase 'external-volatile-cache-root-reparse-is-not-an-inventory-exclusion' {
    New-CacheAliasFixture
    $volatileAlias=Join-Path $runtimeRoot 'data/home/AppData/LocalLow/SogouPY'
    $null=[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($volatileAlias))
    $null=Assert-StaticRealRuntimePath $volatileAlias $true
    New-StaticFixtureJunction $volatileAlias $cacheTarget
    $failed=$false;try{$null=Get-RuntimeStableFiles}catch{$failed=$true}
    Assert-Static $failed 'A volatile cache reparse point bypassed ordinary ancestor checks.'
}
Invoke-StaticCase 'external-volatile-cache-inner-reparse-remains-cleanup-rejected' {
    New-CacheAliasFixture
    $volatileRoot=Join-Path $runtimeRoot 'data/home/AppData/LocalLow/SogouPY'
    $null=[IO.Directory]::CreateDirectory($volatileRoot)
    $volatileAlias=Join-Path $volatileRoot 'unexpected-inner-link'
    $null=Assert-StaticRealRuntimePath $volatileAlias $true
    New-StaticFixtureJunction $volatileAlias $cacheTarget
    $null=Get-RuntimeStableFiles
    $failed=$false;try{$null=Get-RuntimeTree $runtimeRoot $true}catch{$failed=$true}
    Assert-Static $failed 'The external cache byte exclusion bypassed cleanup reparse auditing.'
}
Invoke-StaticCase 'cache-alias-target-must-exist-as-an-ordinary-directory' {
    New-MetadataFixture
    $cacheParent=Join-Path $runtimeRoot 'data/home/AppData/Local/Microsoft/Windows/INetCache'
    $null=[IO.Directory]::CreateDirectory($cacheParent)
    $script:cacheAlias=Join-Path $cacheParent 'Content.IE5';$script:cacheTarget=Join-Path $cacheParent 'IE'
    [IO.File]::WriteAllText($cacheTarget,'synthetic-file-not-directory',[Text.UTF8Encoding]::new($false))
    $script:mockAliasMetadata[$cacheAlias]=Get-CacheAliasMockMetadata
    $failed=$false;try{$null=Assert-RuntimeCacheAlias $cacheAlias}catch{$failed=$true}
    Assert-Static $failed 'An ordinary file target was accepted as the native directory junction target.'
}
Invoke-StaticCase 'cache-alias-target-missing-rejects' {
    New-MetadataFixture
    $cacheParent=Join-Path $runtimeRoot 'data/home/AppData/Local/Microsoft/Windows/INetCache'
    $null=[IO.Directory]::CreateDirectory($cacheParent)
    $script:cacheAlias=Join-Path $cacheParent 'Content.IE5';$script:cacheTarget=Join-Path $cacheParent 'IE'
    $script:mockAliasMetadata[$cacheAlias]=Get-CacheAliasMockMetadata
    $failed=$false;try{$null=Assert-RuntimeCacheAlias $cacheAlias}catch{$failed=$true}
    Assert-Static $failed 'A nonexistent native junction target was accepted.'
}
Invoke-StaticCase 'cache-alias-target-itself-reparse-rejects' {
    New-MetadataFixture
    $cacheParent=Join-Path $runtimeRoot 'data/home/AppData/Local/Microsoft/Windows/INetCache'
    $null=[IO.Directory]::CreateDirectory($cacheParent)
    $script:cacheAlias=Join-Path $cacheParent 'Content.IE5';$script:cacheTarget=Join-Path $cacheParent 'IE'
    $ordinaryTarget=Join-Path $runtimeRoot 'data/synthetic-other-target'
    $null=[IO.Directory]::CreateDirectory($ordinaryTarget)
    $null=Assert-StaticRealRuntimePath $cacheTarget $true
    New-StaticFixtureJunction $cacheTarget $ordinaryTarget
    $script:mockAliasMetadata[$cacheAlias]=Get-CacheAliasMockMetadata
    $failed=$false;try{$null=Assert-RuntimeCacheAlias $cacheAlias}catch{$failed=$true}
    Assert-Static $failed 'The canonical cache target itself was allowed to be another reparse point.'
}
Invoke-StaticCase 'cache-alias-ancestor-reparse-rejects' {
    New-MetadataFixture
    $cacheParent=Join-Path $runtimeRoot 'data/home/AppData/Local/Microsoft/Windows/INetCache'
    $null=[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($cacheParent))
    $ordinaryTarget=Join-Path $runtimeRoot 'data/synthetic-other-cache-parent'
    $null=[IO.Directory]::CreateDirectory($ordinaryTarget)
    $null=Assert-StaticRealRuntimePath $cacheParent $true
    New-StaticFixtureJunction $cacheParent $ordinaryTarget
    $script:cacheAlias=Join-Path $cacheParent 'Content.IE5';$script:cacheTarget=Join-Path $cacheParent 'IE'
    $script:mockAliasMetadata[$cacheAlias]=Get-CacheAliasMockMetadata
    $failed=$false;try{$null=Assert-RuntimeCacheAlias $cacheAlias}catch{$failed=$true}
    Assert-Static $failed 'A native alias ancestor was allowed to redirect outside its ordinary owned ancestry.'
}
Invoke-StaticCase 'cache-alias-is-revalidated-before-any-cleanup-delete' {
    New-CacheAliasFixture
    $tree=Get-RuntimeTree $runtimeRoot $true
    $script:mockCleanupTree=$tree
    $metadata=Get-CacheAliasMockMetadata;$metadata.Target=@($cacheTarget+'-changed')
    $script:mockAliasMetadata[$cacheAlias]=$metadata
    $parentProcess.HasExited=$true
    $failed=$false;try{Remove-RuntimeTree}catch{$failed=$true}
    Assert-Static ($failed -and [IO.File]::Exists($cacheSentinel) -and (([IO.File]::GetAttributes($cacheAlias) -band [IO.FileAttributes]::ReparsePoint) -ne 0)) 'Changed alias metadata was not rejected before cleanup deletion.'
    Assert-Static ($runtimeReport.cleanup.reparsePointsAccepted -eq 1 -and $runtimeReport.cleanup.acceptedInternalCacheAliases.Count -eq 1 -and -not $runtimeReport.cleanup.acceptedInternalCacheAliases[0].traversed -and -not $runtimeReport.cleanup.acceptedInternalCacheAliases[0].recursiveDeletion) 'The report hid its accepted alias behind a zero-reparse claim.'
}
Invoke-StaticFixtureCleanup
$receipt=[ordered]@{
    passed=$true; recordedAt=[DateTime]::UtcNow.ToString('o')
    sourceSha256=(Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
    scope='Static PowerShell AST invariants, full native C# compilation, real Windows argv parsing, mocked process identities and fresh marked G-cache fixtures cleaned only through their exact current-run creation manifest; no GUI/product launch, input, process stop, recursive deletion, IME, registry or Windows policy changes.'
    caseCount=$results.Count; cases=$results.ToArray()
    unchangedProductGateCount=4; unchangedInvariantFunctionCount=$baseline.invariantHashes.Count-2
    approvedInvariantChanges=@('Get-RuntimeStableFiles protects canonical data/app.lock by metadata and excludes only the exact ordinary external volatile SogouPY cache directory.','Get-RuntimeTree permits only an explicitly enabled current-UUID Content.IE5 junction to the existing ordinary IE target; no alias traversal.','Remove-RuntimeTree revalidates the approved alias then removes only the link nonrecursively before the unchanged ordinary-file/directory/marker-last deletion tail.','Before any deletion, bounded read-only DELETE-access validation waits only for Win32 32/33, rechecks ownership/exited processes/live references/full ordinary tree, rejects every other error and preserves marker-last deletion.')
    deleteAccessRegressions=$deleteAccessRegressionEvidence.ToArray()
    ordinaryTreeAuditPreservedWithExactAliasException=$true; markerLastDeletionUnchanged=$true
    sourcePackageReparsePointsAccepted=0
    approvedAliasPath='data/home/AppData/Local/Microsoft/Windows/INetCache/Content.IE5'
    approvedAliasTarget='data/home/AppData/Local/Microsoft/Windows/INetCache/IE'
    externalVolatileProfileCaches=@('data/home/AppData/LocalLow/SogouPY/**')
    fixtureRunId=$fixtureRunId; fixtureRoots=$fixtureOwnedRoots.ToArray()
    fixtureManifest=$fixtureManifestPath; fixtureManifestSha256=$fixtureManifestHash; fixtureCleanup=$fixtureCleanup
    allDescendantsProvenOwned=$false; rawArgumentsAndApiKeysRecorded=$false
}
$receiptPath=Join-Path $workspace 'artifacts/acceptance/desktop-runtime-owned-static.json'
[IO.File]::WriteAllText($receiptPath,($receipt | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
[ordered]@{passed=$true;caseCount=$results.Count;sourceSha256=$receipt.sourceSha256;receipt=$receiptPath} | ConvertTo-Json -Compress
