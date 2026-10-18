[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../scripts/workspace-env.ps1')
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
$workspace = [IO.Path]::GetFullPath($env:AE_WORKSPACE)
$base = Join-Path $workspace '.cache/native-e2e-sandbox'
$id = [Guid]::NewGuid().ToString('N')
$sandbox = Join-Path $base $id
$portable = Join-Path $sandbox 'portable'
$marker = Join-Path $sandbox '.ae-native-e2e-owner.json'
$copy = Join-Path $portable '.ae-native-e2e-owner.json'
$encoding = [Text.UTF8Encoding]::new($false)
$owner = @{ id = $id; workspace = $workspace; purpose = 'AE Switch owned native UI and real tool acceptance' }
$ownerText = $owner | ConvertTo-Json -Compress
$checks = [Collections.Generic.List[string]]::new()
function Check([bool]$condition, [string]$label) { if (-not $condition) { throw $label }; $checks.Add($label) }
function Reject([scriptblock]$operation, [string]$label) {
    $failed = $false
    try { & $operation | Out-Null } catch { $failed = $true }
    Check $failed $label
}
foreach ($driver in @('native-tray-owned.ps1', 'native-window-owned.ps1')) {
    $tokens = $null; $errors = $null
    $driverSource = [IO.File]::ReadAllText((Join-Path $PSScriptRoot $driver), [Text.Encoding]::UTF8)
    $tree = [Management.Automation.Language.Parser]::ParseInput($driverSource, [ref]$tokens, [ref]$errors)
    Check ($errors.Count -eq 0) "$driver syntax"
    $names = if ($driver -ceq 'native-tray-owned.ps1') { @('Assert-TrayOrdinary', 'Assert-TrayAncestors', 'Assert-TrayOwner', 'Get-TrayDispatchDiagnostics') } else { @('Assert-WindowOwner') }
    foreach ($name in $names) {
        $definitions = @($tree.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name }, $true))
        Check ($definitions.Count -eq 1) "exact helper $name"
        Invoke-Expression $definitions[0].Extent.Text
    }
}
function Set-Root([string]$inputRoot) {
    $script:OwnedRoot = $inputRoot
    $script:trayWorkspace = $workspace
    $script:trayBase = $base
    $script:trayRoot = [IO.Path]::GetFullPath($inputRoot)
    $script:traySandbox = [IO.Path]::GetDirectoryName($script:trayRoot)
    $script:trayId = [IO.Path]::GetFileName($script:traySandbox)
    $script:windowRoot = $script:trayRoot
    $script:windowBase = $base
    $script:windowSandbox = $script:traySandbox
    $script:windowId = $script:trayId
}
# Metadata and bounded log read only: never retain or launch a native process.
function Assert-TrayProcess { Assert-TrayOwner }
Check ($workspace.StartsWith('G:\', [StringComparison]::Ordinal)) 'fixture only G'
New-Item -ItemType Directory -Path $portable -ErrorAction Stop | Out-Null
[IO.File]::WriteAllText($marker, $ownerText, $encoding)
[IO.File]::WriteAllText($copy, $ownerText, $encoding)
$completed = $false
try {
    Set-Root $portable
    Assert-TrayOwner
    Check ((Assert-WindowOwner) -ceq $ownerText) 'exact portable UUID two-marker accepted by both helpers'
    foreach ($inputRoot in @($sandbox, (Join-Path $portable 'portable'), (Join-Path $sandbox 'nested/portable'), ($portable + '\..\portable'), 'C:\portable')) {
        Set-Root $inputRoot
        Reject { Assert-TrayOwner } 'tray rejects nonexact root'
        Reject { Assert-WindowOwner } 'window rejects nonexact root'
    }
    Set-Root $portable
    foreach ($location in @($marker, $copy)) {
        Remove-Item -LiteralPath $location
        try {
            Reject { Assert-TrayOwner } 'tray requires both markers'
            Reject { Assert-WindowOwner } 'window requires both markers'
        } finally { [IO.File]::WriteAllText($location, $ownerText, $encoding) }
        foreach ($field in @('id', 'workspace', 'purpose')) {
            $bad = $owner.Clone(); $bad[$field] = 'incorrect'
            [IO.File]::WriteAllText($location, ($bad | ConvertTo-Json -Compress), $encoding)
            try {
                Reject { Assert-TrayOwner } "tray rejects marker $field"
                Reject { Assert-WindowOwner } "window rejects marker $field"
            } finally { [IO.File]::WriteAllText($location, $ownerText, $encoding) }
        }
        $link = Join-Path $sandbox ('hardlink-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType HardLink -Path $link -Target $location | Out-Null
        try {
            Reject { Assert-TrayOwner } 'tray rejects marker hardlink'
            Reject { Assert-WindowOwner } 'window rejects marker hardlink'
        } finally { Remove-Item -LiteralPath $link }
    }
    [IO.File]::WriteAllText($copy, ($owner | ConvertTo-Json), $encoding)
    try {
        Reject { Assert-TrayOwner } 'tray requires exact copied marker'
        Reject { Assert-WindowOwner } 'window requires exact copied marker'
    } finally { [IO.File]::WriteAllText($copy, $ownerText, $encoding) }
    [IO.File]::WriteAllText($copy, (' ' * 8193), $encoding)
    try {
        Reject { Assert-TrayOwner } 'tray rejects oversize marker'
        Reject { Assert-WindowOwner } 'window rejects oversize marker'
    } finally { [IO.File]::WriteAllText($copy, $ownerText, $encoding) }
    $retained = Join-Path $sandbox 'retained-portable'
    Move-Item -LiteralPath $portable -Destination $retained
    New-Item -ItemType Junction -Path $portable -Target $retained | Out-Null
    try {
        Reject { Assert-TrayOwner } 'tray rejects portable junction'
        Reject { Assert-WindowOwner } 'window rejects portable junction'
    } finally {
        [IO.Directory]::Delete($portable)
        Move-Item -LiteralPath $retained -Destination $portable
    }
    Assert-TrayOwner
    Check ((Assert-WindowOwner) -ceq $ownerText) 'ordinary root restored'
    $OwnedProcessId = 42
    $logPath = Join-Path $sandbox 'qa-stderr.log'
    $oldLogPath = Join-Path $portable 'qa-stderr.log'
    $traceState = @{ mainFound = $true; visible = 'visible'; minimized = 'restored' }
    $traceResults = @{ show = 'notCalled'; unminimize = 'notCalled'; focus = 'notCalled' }
    $ready = @{ version = 1; processId = 42; sequence = 0; source = 'setup'; sourceEntry = 0; id = 'other'; thread = 'ThreadId(1)'; phase = 'ready'; before = $traceState; after = $null; results = $traceResults }
    $prefix = 'AE_SWITCH_QA_TRAY_TRACE '
    $readyLine = $prefix + ($ready | ConvertTo-Json -Compress -Depth 5)
    [IO.File]::WriteAllText($oldLogPath, $readyLine, $encoding)
    $diagnostic = Get-TrayDispatchDiagnostics
    Check ($diagnostic.reason -ceq 'logMissing') 'portable child log cannot substitute for exact UUID stderr log'
    $entry = $ready.Clone(); $entry.sequence = 1; $entry.source = 'menu'; $entry.sourceEntry = 1; $entry.id = 'show'; $entry.phase = 'entry'
    $result = $entry.Clone(); $result.phase = 'result'; $result.after = $traceState; $result.results = @{ show = 'success'; unminimize = 'success'; focus = 'success' }
    $lines = @($readyLine, ($prefix + ($entry | ConvertTo-Json -Compress -Depth 5)), ($prefix + ($result | ConvertTo-Json -Compress -Depth 5))) -join "`n"
    [IO.File]::WriteAllText($logPath, $lines, $encoding)
    $diagnostic = Get-TrayDispatchDiagnostics
    Check ($diagnostic.status -ceq 'available' -and $diagnostic.reason -ceq 'fixedTrace' -and $diagnostic.menuEntryCount -eq 1 -and $diagnostic.doubleClickEntryCount -eq 0 -and $diagnostic.records.Count -eq 3) 'exact top-level UUID trace readiness and menu dispatch read back'
    $logAlias = Join-Path $sandbox 'stderr-hardlink'
    New-Item -ItemType HardLink -Path $logAlias -Target $logPath | Out-Null
    try {
        $diagnostic = Get-TrayDispatchDiagnostics
        Check ($diagnostic.status -ceq 'diagnosticUnavailable' -and $diagnostic.reason -ceq 'ownedLogCheckOrReadFailed') 'diagnostic log hardlink refused'
    } finally { Remove-Item -LiteralPath $logAlias }
    [IO.File]::WriteAllText($logPath, ('x' * 1048577), $encoding)
    $diagnostic = Get-TrayDispatchDiagnostics
    Check ($diagnostic.status -ceq 'diagnosticUnavailable' -and $diagnostic.reason -ceq 'logBoundExceeded' -and $diagnostic.records.Count -eq 0) 'UUID log read remains bounded'
    [IO.File]::WriteAllText($copy, '{}', $encoding)
    try {
        $diagnostic = Get-TrayDispatchDiagnostics
        Check ($diagnostic.status -ceq 'diagnosticUnavailable' -and $diagnostic.reason -ceq 'ownedLogCheckOrReadFailed') 'dispatch diagnostic still requires both matching owner markers'
    } finally { [IO.File]::WriteAllText($copy, $ownerText, $encoding) }
    $completed = $true
} finally {
    if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($sandbox)) -cne $base -or [IO.Path]::GetFileName($sandbox) -cne $id -or [IO.File]::ReadAllText($marker) -cne $ownerText) { throw 'Fixture cleanup identity mismatch.' }
    foreach ($entry in Get-ChildItem -LiteralPath $sandbox -Force -Recurse) { if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Fixture cleanup must not traverse a remaining reparse point.' } }
    Remove-Item -LiteralPath $sandbox -Force -Recurse
    Check (-not (Test-Path -LiteralPath $sandbox)) 'owned fixture removed'
}
[ordered]@{ passed = $completed; checks = $checks.Count; gates = $checks; fixtureRemoved = $true; physicalInput = $false; gui = $false; processStarted = $false; drivers = @('native-tray-owned.ps1', 'native-window-owned.ps1') } | ConvertTo-Json -Depth 5
