[CmdletBinding()]
param([string]$ReportFile)
$ErrorActionPreference='Stop'
if($PSVersionTable.PSVersion.Major -lt 7 -or -not $IsWindows){throw 'Windows PowerShell 7 required'}
$testWorkspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if($testWorkspace -notmatch '^[Gg]:[\\/]'){throw 'G: test workspace required'}
. (Join-Path $testWorkspace 'scripts/workspace-env.ps1')
$wrapper=Join-Path $testWorkspace 'scripts/verify-portable-e2e.ps1'
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($wrapper,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw 'Wrapper AST parse failed'}
foreach($name in @('Wait-E2eNativeRootReferenceNaturalExit','Test-E2eNativeExternalRootReference','Test-E2eNativeCreationTime')){
    $definitions=@($ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst]},$true)|Where-Object Name -CEQ $name)
    if($definitions.Count -ne 1){throw 'One exact wrapper function required'}
    . ([ScriptBlock]::Create($definitions[0].Extent.Text))
}
class ReferenceExitedProcessFixture {
    [bool]$HasExited=$true
    [IntPtr]$Handle=[IntPtr]1
    [datetime]$StartTime
    [int]$RefreshCount=0
    [int]$ExitOnRefresh=0
    [int]$DisposeCount=0
    [void] Refresh(){$this.RefreshCount++;if($this.ExitOnRefresh -gt 0 -and $this.RefreshCount -ge $this.ExitOnRefresh){$this.HasExited=$true}}
    [void] Dispose(){$this.DisposeCount++}
}
function Assert-E2eNativeOwner{}
function Assert-E2eNativeOrdinaryFile([string]$File){return $File}
function Assert-E2eNativeProcessesExited{$script:strictCalled=$true}
function Get-CimInstance{
    param([string]$ClassName,$ErrorAction)
    $script:queries++
    if($script:queries -eq 1){return $script:candidate}
    return @()
}
function Get-E2eNativeProcessById([int]$ProcessId){return $script:readonlyProcess}
function Get-E2eNativeProcessPath($Process){return (Join-Path $script:e2eSandbox 'synthetic-unretained-webview.exe')}
function Get-E2eNativeProcessDetails($Process){return @{ParentProcessId=4242;CommandLine='synthetic webview without an explicit root argument'}}
$NativeUi=$true
$e2eWorkspace=$testWorkspace
$e2eIdentifier=[Guid]::NewGuid().ToString('N')
$e2eSandbox=Join-Path $e2eWorkspace ('.cache/native-e2e-sandbox/'+$e2eIdentifier)
$e2eNativeMarkerHash='synthetic-owner-marker'
$started=[DateTime]::UtcNow.AddMinutes(-1)
$fakeProcess=[ReferenceExitedProcessFixture]::new()
$e2eOwnedNativeProcesses=@{4242=@{process=$fakeProcess;started=$started}}
$checks=[Collections.Generic.List[object]]::new()
$passed=$false
try{
    foreach($mode in @('stale-exited-owned-row','reused-pid','missing-creation','live-retained-process')){
        $script:e2eNativeRootReferenceObservation=$null
        $script:strictCalled=$false;$script:queries=0
        $fakeProcess.HasExited=$mode -ne 'live-retained-process'
        $script:candidate=[pscustomobject]@{ProcessId=4242;CreationDate=$started;ExecutablePath=(Join-Path $e2eSandbox 'synthetic.exe');CommandLine='synthetic'}
        if($mode -eq 'reused-pid'){$script:candidate.CreationDate=$started.AddSeconds(1)}
        if($mode -eq 'missing-creation'){$script:candidate.CreationDate=$null}
        $accepted=$false
        try{Wait-E2eNativeRootReferenceNaturalExit -BudgetSeconds 2 -PollMilliseconds 20;$accepted=$true}catch{}
        if($mode -eq 'stale-exited-owned-row'){
            if(-not $accepted -or -not $script:strictCalled -or $script:queries -lt 3){throw 'Exited retained identity must allow only a stale snapshot then require two empty scans and the original strict assertion'}
        }elseif($accepted -or $script:strictCalled){throw 'Live, reused or missing process identity must fail closed'}
        $checks.Add(@{name=$mode;passed=$true})
    }
    $script:e2eNativeRootReferenceObservation=$null
    $script:strictCalled=$false;$script:queries=0
    $fakeProcess.HasExited=$true
    $script:readonlyProcess=[ReferenceExitedProcessFixture]::new()
    $script:readonlyProcess.HasExited=$false
    $script:readonlyProcess.StartTime=$started
    $script:readonlyProcess.ExitOnRefresh=2
    $script:candidate=[pscustomobject]@{ProcessId=4343;CreationDate=$started;ExecutablePath=(Join-Path $e2eSandbox 'synthetic-unretained-webview.exe');CommandLine='synthetic'}
    Wait-E2eNativeRootReferenceNaturalExit -BudgetSeconds 2 -PollMilliseconds 20
    if(-not $script:strictCalled -or $script:queries -lt 3 -or $script:readonlyProcess.DisposeCount -ne 1 -or $script:e2eNativeRootReferenceObservation.receipt.processesStopped -ne 0){throw 'An unretained in-root process may only be observed to exit naturally before the strict assertion'}
    $checks.Add(@{name='late-unretained-webview-natural-exit-without-termination-authority';passed=$true})
    $passed=$true
}finally{
    $report=@{passed=$passed;checks=$checks.ToArray();wrapperSha256=(Get-FileHash -LiteralPath $wrapper -Algorithm SHA256).Hash.ToLowerInvariant();scope='Exact wrapper AST functions with synthetic retained handles and process snapshots';actualProcessesStarted=0;actualProcessesStopped=0;nativeRootCreated=$false;realCredentialsUsed=$false}
    if($ReportFile){
        $destination=[IO.Path]::GetFullPath($ReportFile)
        if(-not $destination.StartsWith($testWorkspace+'\',[StringComparison]::OrdinalIgnoreCase)-or(Test-Path -LiteralPath $destination)){throw 'Fresh in-workspace report required'}
        [IO.File]::WriteAllText($destination,($report|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
    }
    Write-Output ($report|ConvertTo-Json -Depth 8 -Compress)
}
if(-not $passed){exit 1}
