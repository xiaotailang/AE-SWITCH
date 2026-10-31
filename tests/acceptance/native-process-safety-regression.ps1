[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7 -or -not $IsWindows) { throw 'This regression requires Windows PowerShell 7.' }
$testWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if ($testWorkspace -notmatch '^[Gg]:[\\/]') { throw 'Regression fixtures must stay in the G workspace.' }
$testId = [Guid]::NewGuid().ToString('N')
$testRoot = Join-Path $testWorkspace ('.cache/native-process-safety-regression/' + $testId)
$testMarker = Join-Path $testRoot '.ae-native-process-regression-owner.json'
$testReportPath = Join-Path $testWorkspace 'artifacts/acceptance/native-process-safety-regression.json'
$testResults = [Collections.Generic.List[object]]::new()
$testUtf8 = [Text.UTF8Encoding]::new($false)
$testReport = @{ recordedAt = [DateTime]::UtcNow.ToString('o'); passed = $false; ownerId = $testId;
    scope = 'Wrapper functions extracted from AST; actual Windows argv parser and ordinary UUID files, simulated retained handles and process snapshots.';
    wrapperMainExecuted = $false; guiLaunched = $false; officialCliLaunched = $false; childProcessesLaunched = $false;
    processHandlesSimulated = $true; windowsArgvParserExercised = $true; cleanup = @{ removed = $false } }

class E2eSafetyProcessFixture {
    [int]$Id
    [datetime]$StartTime
    [string]$ActualPath
    [IntPtr]$Handle = [IntPtr]1
    [bool]$HasExited = $false
    [bool]$ExitOnKill = $true
    [int]$KillCount = 0
    [int]$RecursiveKillCount = 0
    [int]$DisposeCount = 0
    [int]$RefreshCount = 0
    [int]$ExitOnRefreshCount = 0
    [string]$AppendOwnerOnExitPath = ''
    E2eSafetyProcessFixture([int]$id, [datetime]$started, [string]$path) { $this.Id = $id; $this.StartTime = $started; $this.ActualPath = $path }
    [void] Refresh() {
        $this.RefreshCount++
        if (-not $this.HasExited -and $this.ExitOnRefreshCount -gt 0 -and $this.RefreshCount -ge $this.ExitOnRefreshCount) {
            $this.HasExited = $true
            if ($this.AppendOwnerOnExitPath) { [IO.File]::AppendAllText($this.AppendOwnerOnExitPath, ' ') }
        }
    }
    [void] Kill() { $this.KillCount++; if ($this.ExitOnKill) { $this.HasExited = $true } }
    [void] Kill([bool]$recursive) { $this.RecursiveKillCount++; throw 'Recursive termination must never be called.' }
    [bool] WaitForExit([int]$milliseconds) { return $this.HasExited }
    [void] Dispose() { $this.DisposeCount++ }
}

function Assert-Test([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Add-TestResult([string]$Name) { $testResults.Add(@{ name = $Name; passed = $true }) }
function Assert-TestPath([string]$Location, [switch]$AllowMissing) {
    $absolute = [IO.Path]::GetFullPath($Location)
    if ($absolute -ne $testRoot -and -not $absolute.StartsWith($testRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Regression path escaped its new UUID root.' }
    $cursor = $absolute
    while ($cursor) {
        try { if ([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) { throw 'Regression path has a reparse ancestor.' } }
        catch [IO.FileNotFoundException] { if (-not $AllowMissing) { throw } }
        catch [IO.DirectoryNotFoundException] { if (-not $AllowMissing) { throw } }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
    return $absolute
}

$null = Assert-TestPath $testRoot -AllowMissing
if ([IO.Directory]::Exists($testRoot)) { throw 'The regression UUID must be fresh.' }
$null = [IO.Directory]::CreateDirectory($testRoot)
[IO.File]::WriteAllText($testMarker, (@{ id = $testId; root = $testRoot; workspace = $testWorkspace; purpose = 'Native wrapper process ownership regression' } | ConvertTo-Json), $testUtf8)
$testMarkerHash = (Get-FileHash -LiteralPath $testMarker -Algorithm SHA256).Hash

try {
    $wrapper = Join-Path $testWorkspace 'scripts/verify-portable-e2e.ps1'
    $testReport.wrapperSha256 = (Get-FileHash -LiteralPath $wrapper -Algorithm SHA256).Hash.ToLowerInvariant()
    $tokens = $null
    $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($wrapper, [ref]$tokens, [ref]$parseErrors)
    Assert-Test ($parseErrors.Count -eq 0) 'Wrapper AST must parse without errors.'
    $functions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true))
    $names = @('Assert-E2eLocalPath','Remove-E2eOwnedTree','Initialize-E2eNativeProcessInterop','Assert-E2eNativeOwner','Assert-E2eNativeOrdinaryFile','Get-E2eNativeProcessById','Get-E2eNativeProcessPath','Get-E2eNativeProcessSnapshot','Get-E2eNativeProcessDetails','Test-E2eNativeCreationTime','Get-E2eNativeProcessScope','New-E2eNativeProcessIdentity','Assert-E2eNativeProcessIdentity','Get-E2eNativeLaunchRequest','Write-E2eNativeLaunchAcknowledgment','Publish-E2eNativeLaunchProof','Add-E2eNativeChildDiagnostic','Record-E2eNativeChildren','Assert-E2eNativeProcessesExited','Test-E2eNativeExternalRootReference','Get-E2eNativeExternalGitImages','Assert-E2eNativeExternalObservationContext','Write-E2eNativeExternalObservation','Wait-E2eNativeExternalGitNaturalExit','Stop-E2eNativeProcesses')
    foreach ($name in $names) {
        $selected = @($functions | Where-Object Name -ceq $name)
        Assert-Test ($selected.Count -eq 1) ('Exactly one wrapper function is required: ' + $name)
        . ([scriptblock]::Create($selected[0].Extent.Text))
    }
    Initialize-E2eNativeProcessInterop
    # This fixture deliberately uses roots outside the production sandbox
    # layout. Its strict process assertion remains real; the exact-layout
    # natural-exit observer is covered in native-root-reference-regression.ps1.
    function Wait-E2eNativeRootReferenceNaturalExit { Assert-E2eNativeProcessesExited }
    # Only identity acquisition and process observations are simulated; the production ownership,
    # queue, argv, stop and exit-check functions above run unchanged.
    function Get-E2eNativeProcessById([int]$ProcessId) {
        if ($script:testUnavailablePids.Contains($ProcessId)) { throw [ComponentModel.Win32Exception]::new(5) }
        if (-not $script:testProcesses.ContainsKey($ProcessId)) { throw [ArgumentException]::new('Fixture process already exited.') }
        return $script:testProcesses[$ProcessId]
    }
    function Get-E2eNativeProcessPath($Process) { return $Process.ActualPath }
    function Get-E2eNativeProcessSnapshot { return $script:testCim }
    function Get-E2eNativeProcessDetails($Process) {
        $row=@($script:testCim | Where-Object ProcessId -eq $Process.Id)
        if($row.Count -ne 1){throw 'Actual fixture identity unavailable.'}
        # A stale candidate can never establish the current handle's parent.
        $actualParent=if(Test-E2eNativeCreationTime $Process.StartTime $row[0].CreationDate){$row[0].ParentProcessId}else{0}
        return @{ParentProcessId=$actualParent;CommandLine=$row[0].CommandLine}
    }
    function Get-CimInstance([string]$ClassName, [string]$Filter, $ErrorAction) {
        Assert-Test ($ClassName -eq 'Win32_Process') 'Only process snapshots may be requested.'
        if (-not $Filter) { return $script:testCim }
        if ($Filter -match '^ParentProcessId = (\d+)$') { return @($script:testCim | Where-Object ParentProcessId -eq ([int]$Matches[1])) }
        if ($Filter -match '^ProcessId = (\d+)$') { return @($script:testCim | Where-Object ProcessId -eq ([int]$Matches[1])) }
        throw 'Unexpected process snapshot filter.'
    }
    function New-TestCase {
        $script:NativeUi = $true
        $script:e2eWorkspace = $testWorkspace
        $script:e2eBase = Join-Path $testRoot 'cases'
        $script:e2eIdentifier = [Guid]::NewGuid().ToString('N')
        $script:e2eSandbox = Join-Path $e2eBase $e2eIdentifier
        $script:e2eMarker = Join-Path $e2eSandbox '.ae-native-e2e-owner.json'
        $script:e2ePurpose = 'AE Switch owned native UI and real tool acceptance'
        $null = Assert-TestPath $e2eSandbox -AllowMissing
        $null = [IO.Directory]::CreateDirectory($e2eSandbox)
        [IO.File]::WriteAllText($e2eMarker, (@{ id = $e2eIdentifier; workspace = $e2eWorkspace; purpose = $e2ePurpose } | ConvertTo-Json), $testUtf8)
        $script:e2eNativeMarkerHash = (Get-FileHash -LiteralPath $e2eMarker -Algorithm SHA256).Hash.ToLowerInvariant()
        $script:e2eNativeIdentityFailure = $false
        $script:e2eNativeExternalGitObservation = $null
        $script:e2eNativeChildDiagnostics = [Collections.Generic.List[object]]::new()
        $script:e2eOwnedNativeProcesses = @{}
        $script:e2eSharedRuntimeFiles = @{}
        $script:e2eInstalledClientFixtures = @{ payload=@{ profiles=@{} } }
        foreach ($agent in @('claude_code','codex','hermes','oh_my_pi','opencode','zcode','workbuddy','deepseek_harness')) {
            $launcher = New-TestFile (Join-Path $e2eSandbox ('installed-clients/bin/' + $agent + '.ps1'))
            $script:e2eInstalledClientFixtures.payload.profiles[$agent] = @{ executablePath=$launcher; profileName='owned-fixture-profile' }
        }
        $script:testProcesses = @{}
        $script:testUnavailablePids = [Collections.Generic.HashSet[int]]::new()
        $script:testCim = @()
        $parentFile = Join-Path $e2eSandbox 'parent.exe'
        [IO.File]::WriteAllText($parentFile, 'Never executed fixture image', $testUtf8)
        $script:testParent = [E2eSafetyProcessFixture]::new(60001, [DateTime]::UtcNow.AddSeconds(-5), $parentFile)
        $script:testProcesses[$testParent.Id] = $testParent
        $script:testParentIdentity = New-E2eNativeProcessIdentity $testParent @{ kind = 'owned-executable'; launcher = '' }
        $script:e2eOwnedNativeProcesses[$testParent.Id] = $testParentIdentity
    }
    function New-TestChild([int]$Id, [int]$ParentId, [string]$Path, [string]$CommandLine = '') {
        $process = [E2eSafetyProcessFixture]::new($Id, [DateTime]::UtcNow.AddSeconds(-1), $Path)
        $script:testProcesses[$Id] = $process
        $script:testCim += [pscustomobject]@{ ProcessId = $Id; ParentProcessId = $ParentId; Name = [IO.Path]::GetFileName($Path); ExecutablePath = $Path; CreationDate = $process.StartTime; CommandLine = $CommandLine }
        return $process
    }
    function New-TestFile([string]$Location) {
        $null = Assert-TestPath $Location -AllowMissing
        $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Location))
        [IO.File]::WriteAllText($Location, 'Never executed fixture file', $testUtf8)
        return $Location
    }
    $system = [Environment]::GetFolderPath('System')
    $powershell = Join-Path $system 'WindowsPowerShell/v1.0/powershell.exe'
    $cmd = Join-Path $system 'cmd.exe'
    $conhost = Join-Path $system 'conhost.exe'

    New-TestCase
    $canonicalPowerShell = [IO.Path]::GetFullPath($powershell)
    $mixedLauncher = $e2eInstalledClientFixtures.payload.profiles.oh_my_pi.executablePath
    foreach ($argvImage in @($powershell, $canonicalPowerShell.Replace('\','/'))) {
        $mixedLine = '"' + $argvImage + '" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $mixedLauncher + '"'
        $scope = Get-E2eNativeProcessScope $canonicalPowerShell $mixedLine $testParentIdentity
        Assert-Test ($scope.kind -eq 'official-powershell-launcher' -and $scope.nativeLaunch -eq $true -and $scope.launcher -eq $mixedLauncher) 'Canonical System32 image and mixed-separator argv must prove the same exact owned launcher.'
    }
    $mixedChild = New-TestChild 60002 $testParent.Id $canonicalPowerShell $mixedLine
    Record-E2eNativeChildren
    Assert-Test ($e2eOwnedNativeProcesses.ContainsKey($mixedChild.Id)) 'An actual canonical System32 image must be retained before its QA parent exits.'
    Stop-E2eNativeProcesses
    Assert-Test ($mixedChild.KillCount -eq 1 -and $mixedChild.RecursiveKillCount -eq 0) 'The proved mixed-separator shell must stop individually.'
    Add-TestResult 'canonical-system-image-with-mixed-separator-argv-retained-and-stopped'

    New-TestCase
    $foreignFile = New-TestFile (Join-Path $testRoot 'foreign/SogouCloud.exe')
    $foreign = New-TestChild 60002 $testParent.Id $foreignFile 'SECRET_COMMAND_LINE_MUST_NOT_BE_RECORDED'
    $grandchild = New-TestChild 60003 $foreign.Id (New-TestFile (Join-Path $e2eSandbox 'unproved-grandchild.exe'))
    Record-E2eNativeChildren
    Assert-Test ($e2eOwnedNativeProcesses.Count -eq 1 -and -not $e2eOwnedNativeProcesses.ContainsKey($foreign.Id) -and -not $e2eOwnedNativeProcesses.ContainsKey($grandchild.Id)) 'Foreign children and their descendants must not be owned or recursively discovered.'
    $rejected = $false
    try { Stop-E2eNativeProcesses } catch { $rejected = $true }
    Assert-Test ($rejected -and $testParent.KillCount -eq 1 -and $foreign.KillCount -eq 0 -and $grandchild.KillCount -eq 0) 'Cleanup must stop only the retained parent and refuse a live unproved UUID executable.'
    Assert-Test (([IO.Directory]::Exists($e2eSandbox)) -and $foreign.DisposeCount -gt 0) 'A rejected cleanup must retain the UUID and release unowned handles.'
    Assert-Test (($e2eNativeChildDiagnostics | ConvertTo-Json -Depth 6) -notmatch 'SECRET_COMMAND_LINE|foreign\\SogouCloud') 'Unowned diagnostics must not expose private command lines or paths.'
    Add-TestResult 'foreign-child-not-owned-not-stopped-no-recursion-and-live-unproved-root-blocks-cleanup'

    New-TestCase
    $unproved = New-TestChild 60002 $testParent.Id (New-TestFile (Join-Path $e2eSandbox 'unproved-handle.exe'))
    $null = $testUnavailablePids.Add($unproved.Id)
    Record-E2eNativeChildren
    $rejected = $false
    try { Stop-E2eNativeProcesses } catch { $rejected = $true }
    Assert-Test ($rejected -and -not $e2eOwnedNativeProcesses.ContainsKey($unproved.Id) -and $unproved.KillCount -eq 0 -and [IO.Directory]::Exists($e2eSandbox)) 'An unavailable actual handle must stay unowned and a live UUID reference must block cleanup.'
    Assert-Test ($e2eNativeChildDiagnostics.Count -gt 0) 'Unproved children require sanitized diagnostic evidence.'
    Add-TestResult 'unavailable-actual-handle-is-not-owned-or-stopped-and-blocks-root-cleanup'

    New-TestCase
    $ownedChild = New-TestChild 60002 $testParent.Id (New-TestFile (Join-Path $e2eSandbox 'child.exe'))
    Record-E2eNativeChildren
    Assert-Test ($e2eOwnedNativeProcesses.Count -eq 2) 'An ordinary UUID executable with a proven retained parent must be owned.'
    Stop-E2eNativeProcesses
    Assert-Test ($ownedChild.KillCount -eq 1 -and $testParent.KillCount -eq 1 -and $ownedChild.HasExited -and $testParent.HasExited) 'Each retained handle must be stopped individually and confirmed exited.'
    Assert-Test ($ownedChild.RecursiveKillCount -eq 0 -and $testParent.RecursiveKillCount -eq 0) 'No recursive kill overload may be called.'
    Add-TestResult 'owned-handles-stop-individually-and-stale-cim-rows-do-not-shadow-exited-handles'

    New-TestCase
    $reused = New-TestChild 60002 $testParent.Id (New-TestFile (Join-Path $e2eSandbox 'reused.exe'))
    $reused.StartTime = $reused.StartTime.AddSeconds(1)
    Record-E2eNativeChildren
    Assert-Test (-not $e2eOwnedNativeProcesses.ContainsKey($reused.Id) -and $reused.KillCount -eq 0) 'Candidate/actual handle parent disagreement must reject a reused child PID.'
    Add-TestResult 'child-pid-reuse-rejected'

    New-TestCase
    $child = New-TestChild 60002 $testParent.Id (New-TestFile (Join-Path $e2eSandbox 'child.exe'))
    $testParent.StartTime = $testParent.StartTime.AddSeconds(1)
    Record-E2eNativeChildren
    $rejected = $false
    try { Stop-E2eNativeProcesses } catch { $rejected = $true }
    Assert-Test ($rejected -and $e2eOwnedNativeProcesses.Count -eq 1 -and $testParent.KillCount -eq 0 -and $child.KillCount -eq 0) 'Changed retained parent identity must neither discover nor terminate children.'
    Add-TestResult 'retained-parent-pid-reuse-refuses-discovery-and-stop'

    New-TestCase
    $launchers = @()
    foreach ($agent in @('claude_code','codex','hermes','oh_my_pi','opencode','zcode','workbuddy','deepseek_harness')) {
        $launcher = $e2eInstalledClientFixtures.payload.profiles[$agent].executablePath
        $launchers += $launcher
        $line = '"' + $powershell + '" -NoLogo -NoProfile -NoExit -ExecutionPolicy Bypass -File "' + $launcher + '"'
        $scope = Get-E2eNativeProcessScope $powershell $line $testParentIdentity
        Assert-Test ($scope.kind -eq 'official-powershell-launcher' -and $scope.launcher -eq $launcher) 'Every canonical UI launcher must be accepted.'
    }
    $obsoleteLauncher = New-TestFile (Join-Path $e2eSandbox 'data/agents/codex/launch.ps1')
    Assert-Test ($null -eq (Get-E2eNativeProcessScope $powershell ('powershell.exe -File "' + $obsoleteLauncher + '"') $testParentIdentity)) 'A former AE private launcher cannot replace the selected installed client entry.'
    $line = 'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $launchers[7] + '" -p "fixture prompt" --output-format stream-json'
    $shell = New-TestChild 60002 $testParent.Id $powershell $line
    $console = New-TestChild 60003 $shell.Id $conhost ('"' + $conhost + '" 0xffffffff -ForceV1')
    Record-E2eNativeChildren
    Assert-Test ($e2eOwnedNativeProcesses.ContainsKey($shell.Id) -and $e2eOwnedNativeProcesses.ContainsKey($console.Id)) 'Exact canonical WinPS and its proven console host must be tracked.'
    Stop-E2eNativeProcesses
    Assert-Test ($shell.KillCount -eq 1 -and $console.KillCount -eq 1 -and $shell.RecursiveKillCount -eq 0) 'Exact owned system shells must stop individually.'
    Add-TestResult 'eight-canonical-ui-launchers-verifier-arguments-and-owned-console-chain'

    New-TestCase
    $launcher = $e2eInstalledClientFixtures.payload.profiles.workbuddy.executablePath
    $badLines = @(
        ('powershell.exe -File "' + $launcher + '.extra"'),
        ('powershell.exe -File "' + ($launcher.Replace($e2eSandbox, $e2eSandbox + '-prefix')) + '"'),
        ('powershell.exe -Command "echo private" -File "' + $launcher + '"'),
        ('powershell.exe -EncodedCommand ZmFrZQ== -File "' + $launcher + '"'),
        ('powershell.exe -File "' + $launcher + '" -File "' + $launcher + '"'),
        ('powershell.exe -NoProfile -File "' + $launcher + ' extra"'),
        ('fake-powershell.exe -File "' + $launcher + '"'),
        ('powershell.exe -ExecutionPolicy RemoteSigned -File "' + $launcher + '"')
    )
    foreach ($line in $badLines) { Assert-Test ($null -eq (Get-E2eNativeProcessScope $powershell $line $testParentIdentity)) 'Forged or ambiguous shell argv must be rejected.' }
    $fakeSystem = New-TestFile (Join-Path $testRoot 'foreign/powershell.exe')
    Assert-Test ($null -eq (Get-E2eNativeProcessScope $fakeSystem ('powershell.exe -File "' + $launcher + '"') $testParentIdentity)) 'A copied external powershell image is not the official System32 executable.'
    $prefixImage = New-TestFile (Join-Path ($e2eSandbox + '-prefix') 'outside.exe')
    Assert-Test ($null -eq (Get-E2eNativeProcessScope $prefixImage '' $testParentIdentity)) 'A UUID prefix sibling executable is outside the exact owned tree.'
    Add-TestResult 'prefix-path-duplicate-file-command-encoded-command-forged-argv-and-system-image-rejected'

    New-TestCase
    $commandScript = New-TestFile (Join-Path $e2eSandbox 'tools/fixture/run.cmd')
    $line = '"' + $cmd + '" /d /s /c "' + $commandScript + '" --fixture'
    $commandChild = New-TestChild 60002 $testParent.Id $cmd $line
    Record-E2eNativeChildren
    Assert-Test ($e2eOwnedNativeProcesses.ContainsKey($commandChild.Id)) 'A single ordinary UUID command script in a verified parent chain must be accepted.'
    $spacedScript = New-TestFile (Join-Path $e2eSandbox 'tools/fixture with spaces/run.cmd')
    foreach ($nestedLine in @(('cmd.exe /d /s /c ""' + $spacedScript + '" --fixture"'), ('cmd.exe /c ""' + $commandScript + '""'))) {
        Assert-Test ((Get-E2eNativeProcessScope $cmd $nestedLine $testParentIdentity).launcher -eq [IO.Path]::GetFullPath($nestedLine.Contains($spacedScript) ? $spacedScript : $commandScript)) 'Canonical cmd outer quoting and spaces must retain the exact owned script path.'
    }
    foreach ($badLine in @($line + ' & echo forged', $line + ' | echo forged', $line + ' %PRIVATE%', ('cmd.exe /k "' + $commandScript + '"'), ('cmd.exe /c "' + $e2eSandbox + '\..\foreign.cmd"'))) {
        Assert-Test ($null -eq (Get-E2eNativeProcessScope $cmd $badLine $testParentIdentity)) 'Command operators, expansion, persistent commands and path traversal must be rejected.'
    }
    Assert-Test ($null -eq (Get-E2eNativeProcessScope $conhost ('conhost.exe 0xffffffff -ForceV1') $testParentIdentity)) 'A console host without a verified shell parent must be rejected.'
    Assert-Test ($null -eq (Get-E2eNativeProcessScope $conhost 'conhost.exe 0xffffffff -Command fake' $e2eOwnedNativeProcesses[$commandChild.Id])) 'Forged console-host argv must be rejected.'
    Assert-Test ((Get-E2eNativeProcessScope $conhost ('"\??\' + $conhost + '" 0xffffffff -ForceV1') $e2eOwnedNativeProcesses[$commandChild.Id]).kind -eq 'owned-console-host') 'The exact official conhost image in native NT argv form must preserve its proved owned shell chain.'
    Add-TestResult 'single-owned-command-script-accepted-operators-traversal-and-unproved-conhost-rejected'

    New-TestCase
    $child = New-TestChild 60002 $testParent.Id (New-TestFile (Join-Path $e2eSandbox 'hash-probe.exe'))
    Record-E2eNativeChildren
    [IO.File]::WriteAllText($child.ActualPath, 'changed fixture executable bytes', $testUtf8)
    $rejected = $false
    try { Stop-E2eNativeProcesses } catch { $rejected = $true }
    Assert-Test ($rejected -and $child.KillCount -eq 0 -and [IO.Directory]::Exists($e2eSandbox)) 'Changed executable hash must refuse termination and directory cleanup.'
    Add-TestResult 'retained-executable-hash-change-refuses-stop'

    New-TestCase
    $child = New-TestChild 60002 $testParent.Id (New-TestFile (Join-Path $e2eSandbox 'live-handle.exe'))
    $child.ExitOnKill = $false
    Record-E2eNativeChildren
    $rejected = $false
    try { Stop-E2eNativeProcesses } catch { $rejected = $true }
    Assert-Test ($rejected -and -not $child.HasExited -and [IO.Directory]::Exists($e2eSandbox)) 'A handle that fails to exit must block directory cleanup.'
    Add-TestResult 'live-retained-handle-blocks-cleanup'

    New-TestCase
    [IO.File]::AppendAllText($e2eMarker, ' ', $testUtf8)
    $rejected = $false
    try { Stop-E2eNativeProcesses } catch { $rejected = $true }
    Assert-Test ($rejected -and $testParent.KillCount -eq 0) 'Changed UUID marker bytes must refuse stop.'
    Add-TestResult 'uuid-marker-byte-change-refuses-stop'

    # Exit precisely between the caller's live check and the identity assertion's
    # refresh. Both cases run so an old wrapper preserves both failing gates.
    $naturalExitFailures = [Collections.Generic.List[string]]::new()
    $raceName = 'retained-parent-natural-exit-during-discovery-does-not-poison-identity-or-retain-child'
    try {
        New-TestCase
        $child = New-TestChild 60002 $testParent.Id (New-TestFile (Join-Path $e2eSandbox 'natural-exit-child.exe'))
        $testParent.RefreshCount = 0
        $testParent.ExitOnRefreshCount = 2
        Record-E2eNativeChildren
        Assert-Test ($testParent.HasExited -and $testParent.RefreshCount -ge 2) 'The retained parent must exit during the identity assertion refresh.'
        Assert-Test (-not $e2eNativeIdentityFailure -and $e2eOwnedNativeProcesses.Count -eq 1 -and -not $e2eOwnedNativeProcesses.ContainsKey($child.Id)) 'A naturally exited retained parent must not permanently fail identity or establish new child ownership.'
        Assert-Test ($testParent.KillCount -eq 0 -and $child.KillCount -eq 0 -and $testParent.RecursiveKillCount -eq 0 -and $child.RecursiveKillCount -eq 0) 'Natural parent exit must not terminate either process.'
        Add-TestResult $raceName
    } catch {
        $naturalExitFailures.Add($raceName)
        $testResults.Add(@{ name = $raceName; passed = $false; error = $_.Exception.Message; parentHasExited = $testParent.HasExited; parentRefreshCount = $testParent.RefreshCount; identityFailure = $e2eNativeIdentityFailure; parentKillCount = $testParent.KillCount; childRetained = $e2eOwnedNativeProcesses.ContainsKey($child.Id); childKillCount = $child.KillCount })
    }

    $raceName = 'retained-handle-natural-exit-during-stop-does-not-fail-cleanup-or-kill'
    try {
        New-TestCase
        $testParent.RefreshCount = 0
        $testParent.ExitOnRefreshCount = 2
        Stop-E2eNativeProcesses
        Assert-Test ($testParent.HasExited -and $testParent.RefreshCount -ge 2 -and -not $e2eNativeIdentityFailure) 'The retained handle must exit naturally during stop identity proof without permanent failure.'
        Assert-Test ($testParent.KillCount -eq 0 -and $testParent.RecursiveKillCount -eq 0) 'A naturally exited retained handle must never be killed.'
        Add-TestResult $raceName
    } catch {
        $naturalExitFailures.Add($raceName)
        $testResults.Add(@{ name = $raceName; passed = $false; error = $_.Exception.Message; parentHasExited = $testParent.HasExited; parentRefreshCount = $testParent.RefreshCount; identityFailure = $e2eNativeIdentityFailure; parentKillCount = $testParent.KillCount })
    }

    New-TestCase
    $child = New-TestChild 60002 $testParent.Id (New-TestFile (Join-Path $e2eSandbox 'changed-owner-natural-exit-child.exe'))
    $testParent.RefreshCount = 0
    $testParent.ExitOnRefreshCount = 2
    $testParent.AppendOwnerOnExitPath = $e2eMarker
    Record-E2eNativeChildren
    Assert-Test ($testParent.HasExited -and $e2eNativeIdentityFailure -and -not $e2eOwnedNativeProcesses.ContainsKey($child.Id) -and $testParent.KillCount -eq 0 -and $child.KillCount -eq 0) 'Owner mutation during natural parent exit must remain a fatal discovery failure without ownership or kill.'
    Add-TestResult 'changed-owner-during-natural-parent-exit-refuses-discovery'

    New-TestCase
    $testParent.RefreshCount = 0
    $testParent.ExitOnRefreshCount = 2
    $testParent.AppendOwnerOnExitPath = $e2eMarker
    $rejected = $false
    try { Stop-E2eNativeProcesses } catch { $rejected = $true }
    Assert-Test ($rejected -and $testParent.HasExited -and $testParent.KillCount -eq 0 -and [IO.Directory]::Exists($e2eSandbox)) 'Owner mutation during natural retained-handle exit must still block cleanup without kill.'
    Add-TestResult 'changed-owner-during-natural-retained-handle-exit-refuses-stop'

    Assert-Test ($naturalExitFailures.Count -eq 0) 'Retained-handle natural-exit regression failed.'
    $testReport.wrapperBeforeAfterUnchanged = (Get-FileHash -LiteralPath $wrapper -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $testReport.wrapperSha256
    Assert-Test $testReport.wrapperBeforeAfterUnchanged 'The wrapper changed during regression execution.'
    $testReport.passed = $true
} catch { $testReport.error = $_.Exception.Message }
finally {
    try {
        $null = Assert-TestPath $testRoot
        $null = Assert-TestPath $testMarker
        $owner = [IO.File]::ReadAllText($testMarker) | ConvertFrom-Json
        if ($owner.id -ne $testId -or $owner.root -ne $testRoot -or $owner.workspace -ne $testWorkspace -or $owner.purpose -ne 'Native wrapper process ownership regression' -or (Get-FileHash -LiteralPath $testMarker -Algorithm SHA256).Hash -ne $testMarkerHash) { throw 'Fresh regression fixture marker changed.' }
        $script:e2eWorkspace = $testWorkspace
        $script:e2eMarker = $testMarker
        $script:NativeUi = $false
        Remove-E2eOwnedTree $testRoot
        $testReport.cleanup = @{ removed = -not [IO.Directory]::Exists($testRoot); ownerMarkerVerified = $true; recursiveDeletionUsed = $false }
    } catch { $testReport.cleanup.error = $_.Exception.Message; $testReport.passed = $false }
    $testReport.results = @($testResults.ToArray())
    $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($testReportPath))
    [IO.File]::WriteAllText($testReportPath, ($testReport | ConvertTo-Json -Depth 10), $testUtf8)
}
$testReport | ConvertTo-Json -Depth 10
if (-not $testReport.passed -or -not $testReport.cleanup.removed) { exit 1 }
