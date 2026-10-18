[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][int]$OwnedProcessId,
    [Parameter(Mandatory = $true)][string]$OwnedRoot,
    [Parameter(Mandatory = $true)][string]$ExpectedSha256,
    [Parameter(Mandatory = $true)][string]$ExpectedStartedAt,
    [Parameter(Mandatory = $true)][string]$ReportPath,
    [switch]$RestoreOwnedOnly
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../scripts/workspace-env.ps1')
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'The owned tray driver requires PowerShell 7.' }
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$trayWorkspace = [IO.Path]::GetFullPath($env:AE_WORKSPACE)
$trayRoot = [IO.Path]::GetFullPath($OwnedRoot)
$trayBase = [IO.Path]::GetFullPath((Join-Path $trayWorkspace '.cache/native-e2e-sandbox'))
$traySandbox = [IO.Path]::GetDirectoryName($trayRoot)
$trayId = [IO.Path]::GetFileName($traySandbox)
$trayReportPath = if ($RestoreOwnedOnly) {
    [IO.Path]::GetFullPath((Join-Path $trayRoot 'window-tray-restore.json'))
} else {
    [IO.Path]::GetFullPath((Join-Path $trayWorkspace 'artifacts/acceptance/native-tray.json'))
}
$trayToken = ''
$trayProcess = $null
$trayCursorSaved = $false
$trayDpiSaved = $false
$trayOverflowOpened = $false
$trayOverflowStateSaved = $false
$trayOriginalOverflowVisible = $false
$trayReportEligible = $false
$trayReport = [ordered]@{
    recordedAt = [DateTime]::UtcNow.ToString('o')
    passed = $false
    pid = $OwnedProcessId
    root = $trayRoot
    scope = 'Actual own UUID tray icon, native menus and owned exit dialog; no product close-button assertion.'
    setup = 'Native WM_CLOSE request to the exact owned window is setup only; the product CloseRequested handler hides it. No product close-button assertion.'
    gates = @()
    dialogButtonDiagnostics = @()
}
if ($RestoreOwnedOnly) {
    $trayReport.mode = 'RestoreOwnedOnly'
    $trayReport.setupOnly = $true
    $trayReport.traySuitePassed = $false
    $trayReport.restored = $false
    $trayReport.id = $trayId
    $trayReport.sha256 = $ExpectedSha256
    $trayReport.startedAt = $ExpectedStartedAt
    $trayReport.receiptPath = $trayReportPath
    $trayReport.actualInputSource = 'owned-tray-SendInput-double-click'
    $trayReport.scope = 'Restore the exact owned main window through its actual UUID tray icon; setup only.'
    $trayReport.setup = 'Real own tray double-click invokes the product show/unminimize callback; no hide, menu or exit test.'
    $trayReport.win32ShowWindowUsed = $false
}

function Assert-TrayOrdinary([string]$location, [bool]$directory) {
    $attributes = [IO.File]::GetAttributes($location)
    if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Tray ownership paths must not contain any reparse point.' }
    if ([bool]($attributes -band [IO.FileAttributes]::Directory) -ne $directory) { throw 'Tray ownership entry type mismatch.' }
    if (-not $directory -and (Get-Item -LiteralPath $location -Force).LinkType) { throw 'Tray ownership files must not have aliases.' }
}
function Assert-TrayAncestors([string]$location) {
    $current = [IO.Path]::GetFullPath($location)
    while ($current) {
        Assert-TrayOrdinary $current $true
        $current = [IO.Path]::GetDirectoryName($current)
    }
}
function Assert-TrayOwner {
    if ($script:trayRoot -cne $OwnedRoot.Replace('/', '\') -or [IO.Path]::GetPathRoot($script:trayRoot) -cne 'G:\' -or [IO.Path]::GetFileName($script:trayRoot) -cne 'portable' -or $script:trayId -cnotmatch '^[a-f0-9]{32}$' -or [IO.Path]::GetDirectoryName($script:traySandbox) -cne $script:trayBase) { throw 'An exact owned native UUID/portable root is required.' }
    Assert-TrayAncestors $script:trayRoot
    $texts = @()
    foreach ($directory in @($script:traySandbox, $script:trayRoot)) {
        $markerPath = Join-Path $directory '.ae-native-e2e-owner.json'
        Assert-TrayOrdinary $markerPath $false
        $length = [IO.FileInfo]::new($markerPath).Length
        if ($length -le 0 -or $length -gt 8192) { throw 'Tray ownership marker exceeds its bound.' }
        $text = [IO.File]::ReadAllText($markerPath, [Text.Encoding]::UTF8)
        $marker = $text | ConvertFrom-Json
        if ($marker.id -cne $script:trayId -or $marker.workspace -cne $script:trayWorkspace -or $marker.purpose -cne 'AE Switch owned native UI and real tool acceptance') { throw 'Owned tray marker mismatch.' }
        $texts += $text
    }
    if ($texts[0] -cne $texts[1]) { throw 'The portable tray marker must copy its UUID owner exactly.' }
}
function Add-TrayGate([string]$name, [string]$status, $evidence) {
    $script:trayReport.gates += [ordered]@{ name = $name; status = $status; evidence = $evidence }
}
function Test-TrayRequiredGates([object[]]$gates) {
    $required = @('initial-owned-health', 'actual-own-icon-double-click', 'actual-own-menu-open', 'actual-owned-exit-cancel', 'actual-owned-exit-confirm-input', 'owned-exit-stops-process-and-ports')
    if ($gates.Count -ne $required.Count) { return $false }
    foreach ($name in $required) {
        $matching = @($gates | Where-Object { $_.name -ceq $name })
        if ($matching.Count -ne 1 -or $matching[0].status -cne 'passed') { return $false }
    }
    return $true
}
function Assert-TrayProcess {
    Assert-TrayOwner
    $script:trayProcess.Refresh()
    if ($script:trayProcess.HasExited -or $script:trayProcess.StartTime.ToUniversalTime().Ticks -ne $script:trayCreation.Ticks -or [AEOwnedTray]::ProcessPath($script:trayProcess.Handle) -cne $script:trayExe) { throw 'The retained owned process identity changed.' }
}
function Get-TrayDispatchDiagnostics {
    $diagnostic = [ordered]@{ status = 'instrumentationUnavailable'; reason = 'noTrace'; menuEntryCount = $null; doubleClickEntryCount = $null; limitReached = $false; rejectedRecords = 0; records = @() }
    $stream = $null
    try {
        Assert-TrayProcess
        Assert-TrayOwner
        $logPath = [IO.Path]::GetFullPath((Join-Path $script:traySandbox 'qa-stderr.log'))
        if ([IO.Path]::GetDirectoryName($logPath) -cne $script:traySandbox -or [IO.Path]::GetFileName($logPath) -cne 'qa-stderr.log') { throw 'Diagnostic log scope mismatch.' }
        if (-not [IO.File]::Exists($logPath) -and -not [IO.Directory]::Exists($logPath)) { $diagnostic.reason = 'logMissing'; return $diagnostic }
        Assert-TrayOrdinary $logPath $false
        $stream = [IO.File]::Open($logPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        if ([IO.Path]::GetFullPath($stream.Name) -cne $logPath) { throw 'Diagnostic log handle path mismatch.' }
        $length = $stream.Length
        if ($length -gt 1048576) { $diagnostic.status = 'diagnosticUnavailable'; $diagnostic.reason = 'logBoundExceeded'; return $diagnostic }
        $bytes = [byte[]]::new([int]$length)
        $offset = 0
        while ($offset -lt $bytes.Length) {
            $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
            if (-not $read) { throw 'Diagnostic log changed during its bounded read.' }
            $offset += $read
        }
        Assert-TrayAncestors $script:trayRoot
        Assert-TrayOrdinary $logPath $false
        Assert-TrayProcess
        $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
        $keysMatch = {
            param($value, [string[]]$keys)
            if ($value -isnot [Collections.IDictionary] -or $value.Count -ne $keys.Count) { return $false }
            foreach ($key in $value.Keys) { if ($keys -cnotcontains $key) { return $false } }
            return $true
        }
        $integer = { param($value, [long]$minimum, [long]$maximum) return ($value -is [long] -or $value -is [int]) -and $value -ge $minimum -and $value -le $maximum }
        $stateValid = {
            param($value)
            if (-not (& $keysMatch $value @('mainFound', 'visible', 'minimized')) -or $value.mainFound -isnot [bool]) { return $false }
            if (-not $value.mainFound) { return $value.visible -ceq 'missing' -and $value.minimized -ceq 'missing' }
            return @('visible', 'hidden', 'error') -ccontains $value.visible -and @('minimized', 'restored', 'error') -ccontains $value.minimized
        }
        $stateProjection = { param($value) return [ordered]@{ mainFound = [bool]$value.mainFound; visible = [string]$value.visible; minimized = [string]$value.minimized } }
        $ready = $false
        $traceCount = 0
        $menuCount = 0
        $doubleClickCount = 0
        $entries = @{}
        $results = [Collections.Generic.HashSet[int]]::new()
        $prefix = 'AE_SWITCH_QA_TRAY_TRACE '
        foreach ($line in [regex]::Split($text, '\r?\n')) {
            if (-not $line.StartsWith($prefix, [StringComparison]::Ordinal)) { continue }
            $traceCount++
            if ($traceCount -gt 129) { $diagnostic.status = 'diagnosticUnavailable'; $diagnostic.reason = 'recordBoundExceeded'; $diagnostic.records = @(); return $diagnostic }
            try {
                if ($line.Length -gt 4096) { throw 'Trace line exceeds its bound.' }
                $record = $line.Substring($prefix.Length) | ConvertFrom-Json -AsHashtable -Depth 8
                if (-not (& $keysMatch $record @('version', 'processId', 'sequence', 'source', 'sourceEntry', 'id', 'thread', 'phase', 'before', 'after', 'results'))) { throw 'Trace field mismatch.' }
                if (-not (& $integer $record.version 1 1) -or -not (& $integer $record.processId $OwnedProcessId $OwnedProcessId) -or -not (& $integer $record.sequence 0 64) -or -not (& $integer $record.sourceEntry 0 64)) { throw 'Trace integer mismatch.' }
                if (@('setup', 'menu', 'doubleClick') -cnotcontains $record.source -or @('show', 'exit', 'other') -cnotcontains $record.id -or @('ready', 'entry', 'result') -cnotcontains $record.phase -or $record.thread -isnot [string] -or $record.thread -cnotmatch '^ThreadId\([1-9][0-9]{0,19}\)$') { throw 'Trace enum mismatch.' }
                if (-not (& $stateValid $record.before) -or -not (& $keysMatch $record.results @('show', 'unminimize', 'focus'))) { throw 'Trace state mismatch.' }
                foreach ($value in $record.results.Values) { if (@('success', 'error', 'notCalled') -cnotcontains $value) { throw 'Trace result mismatch.' } }
                $signature = "$($record.source):$($record.sourceEntry):$($record.id):$($record.thread)"
                if ($record.phase -ceq 'ready') {
                    if ($ready -or $record.source -cne 'setup' -or $record.sequence -ne 0 -or $record.sourceEntry -ne 0 -or $record.id -cne 'other' -or $null -ne $record.after -or @($record.results.Values | Where-Object { $_ -cne 'notCalled' }).Count) { throw 'Trace readiness mismatch.' }
                    $ready = $true
                } else {
                    if ($record.sequence -lt 1 -or $record.sourceEntry -lt 1 -or $record.sourceEntry -gt $record.sequence -or $record.source -ceq 'setup' -or ($record.source -ceq 'doubleClick' -and $record.id -cne 'show')) { throw 'Trace entry identity mismatch.' }
                    if ($record.phase -ceq 'entry') {
                        if ($entries.ContainsKey([int]$record.sequence) -or $null -ne $record.after -or @($record.results.Values | Where-Object { $_ -cne 'notCalled' }).Count) { throw 'Trace entry mismatch.' }
                        $entries[[int]$record.sequence] = $signature
                        if ($record.source -ceq 'menu') { $menuCount++ } else { $doubleClickCount++ }
                    } else {
                        if ($entries[[int]$record.sequence] -cne $signature -or -not $results.Add([int]$record.sequence) -or $record.id -cne 'show' -or -not (& $stateValid $record.after)) { throw 'Trace completion mismatch.' }
                        if ($record.after.mainFound) {
                            if (@($record.results.Values | Where-Object { $_ -ceq 'notCalled' }).Count) { throw 'Trace completed calls mismatch.' }
                        } elseif (@($record.results.Values | Where-Object { $_ -cne 'notCalled' }).Count) { throw 'Trace missing-window calls mismatch.' }
                    }
                }
                $diagnostic.records += [ordered]@{
                    version = 1; processId = $OwnedProcessId; sequence = [int]$record.sequence; source = [string]$record.source; sourceEntry = [int]$record.sourceEntry; id = [string]$record.id; thread = [string]$record.thread; phase = [string]$record.phase
                    before = & $stateProjection $record.before
                    after = $(if ($null -ne $record.after) { & $stateProjection $record.after } else { $null })
                    results = [ordered]@{ show = [string]$record.results.show; unminimize = [string]$record.results.unminimize; focus = [string]$record.results.focus }
                }
            } catch { $diagnostic.rejectedRecords++ }
        }
        if ($diagnostic.rejectedRecords) { $diagnostic.status = 'diagnosticUnavailable'; $diagnostic.reason = 'traceRejected' }
        elseif ($ready) { $diagnostic.status = 'available'; $diagnostic.reason = 'fixedTrace'; $diagnostic.menuEntryCount = $menuCount; $diagnostic.doubleClickEntryCount = $doubleClickCount; $diagnostic.limitReached = $entries.Count -eq 64 }
        elseif ($traceCount) { $diagnostic.reason = 'readyNotObserved' }
    } catch { $diagnostic.status = 'diagnosticUnavailable'; $diagnostic.reason = 'ownedLogCheckOrReadFailed'; $diagnostic.records = @() }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
    return $diagnostic
}
function Get-TrayListeners([int]$port) {
    return @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq $port })
}
function Assert-TrayHealth {
    Assert-TrayProcess
    $listeners = @(Get-TrayListeners $script:trayPort | Where-Object { $_.OwningProcess -eq $OwnedProcessId })
    if ($listeners.Count -ne 1) { throw 'The owned process must own exactly one gateway listener.' }
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$($script:trayPort)/health" -Headers @{ Authorization = "Bearer $($script:trayToken)" } -NoProxy -TimeoutSec 2 -ErrorAction Stop
    if ([int]$response.StatusCode -ne 204) { throw 'Owned gateway health must return its exact successful 204 contract.' }
    return [ordered]@{ pid = $OwnedProcessId; port = $script:trayPort; healthStatus = [int]$response.StatusCode }
}
function Get-TrayElements($parent, $controlType, [string[]]$names) {
    $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, $controlType)
    $matches = [Collections.Generic.List[object]]::new()
    foreach ($element in $parent.FindAll([Windows.Automation.TreeScope]::Descendants, $condition)) {
        if ($names -ccontains $element.Current.Name) { $matches.Add($element) }
    }
    return $matches.ToArray()
}
function Get-TrayShellRoots {
    $roots = [Collections.Generic.List[object]]::new()
    foreach ($handle in [AEOwnedTray]::ShellWindows()) {
        if (-not [AEOwnedTray]::IsWindowVisible($handle)) { continue }
        $roots.Add([Windows.Automation.AutomationElement]::FromHandle($handle))
    }
    return $roots.ToArray()
}
function Test-TrayTooltip([string]$value) {
    return $null -ne $value -and $value.Trim() -ceq $script:trayTooltip
}
function Get-TrayElementEvidence($element) {
    $current = $element.Current
    $rectangle = $current.BoundingRectangle
    return [ordered]@{
        name = $current.Name
        helpText = $current.HelpText
        className = $current.ClassName
        automationId = $current.AutomationId
        controlType = $current.ControlType.ProgrammaticName
        shellProcessId = $current.ProcessId
        isOffscreen = $current.IsOffscreen
        isEnabled = $current.IsEnabled
        bounds = @($rectangle.X, $rectangle.Y, $rectangle.Width, $rectangle.Height)
        runtimeId = @($element.GetRuntimeId())
    }
}
function Test-TrayIconReady($evidence) {
    if (-not ((Test-TrayTooltip $evidence.name) -or (Test-TrayTooltip $evidence.helpText)) -or $evidence.isOffscreen -or -not $evidence.isEnabled) { return $false }
    $bounds = @($evidence.bounds)
    if ($bounds.Count -ne 4) { return $false }
    foreach ($value in $bounds) {
        if ([double]::IsNaN([double]$value) -or [double]::IsInfinity([double]$value)) { return $false }
    }
    if ($bounds[2] -le 0 -or $bounds[3] -le 0) { return $false }
    $x = $bounds[0] + $bounds[2] / 2
    $y = $bounds[1] + $bounds[3] / 2
    return -not [double]::IsNaN($x) -and -not [double]::IsInfinity($x) -and -not [double]::IsNaN($y) -and -not [double]::IsInfinity($y) -and $x -ge [int]::MinValue -and $x -le [int]::MaxValue -and $y -ge [int]::MinValue -and $y -le [int]::MaxValue
}
function Get-TrayOwnIcon {
    Assert-TrayProcess
    $icons = [Collections.Generic.List[object]]::new()
    $roots = @()
    foreach ($handle in [AEOwnedTray]::ShellWindows()) {
        $rootEvidence = [ordered]@{ className = [AEOwnedTray]::WindowClass($handle); visible = [AEOwnedTray]::IsWindowVisible($handle); buttonCount = 0; unnamedButtonCount = 0; uuidCandidates = @() }
        $roots += $rootEvidence
        if (-not $rootEvidence.visible) { continue }
        try {
            $shell = [Windows.Automation.AutomationElement]::FromHandle($handle)
            $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Button)
            foreach ($icon in $shell.FindAll([Windows.Automation.TreeScope]::Descendants, $condition)) {
                $candidate = Get-TrayElementEvidence $icon
                $rootEvidence.buttonCount++
                if ([string]::IsNullOrWhiteSpace($candidate.name)) { $rootEvidence.unnamedButtonCount++ }
                $exact = (Test-TrayTooltip $candidate.name) -or (Test-TrayTooltip $candidate.helpText)
                $candidate.exactUuidTooltip = $exact
                if ($exact -or ([string]$candidate.name).Contains($script:trayId, [StringComparison]::Ordinal) -or ([string]$candidate.helpText).Contains($script:trayId, [StringComparison]::Ordinal)) { $rootEvidence.uuidCandidates += $candidate }
                if ($exact) { $icons.Add([pscustomobject]@{ element = $icon; shellHandle = $handle; shellProcessId = $shell.Current.ProcessId; evidence = $candidate }) }
            }
        } catch [Windows.Automation.ElementNotAvailableException] {
            $rootEvidence.transientUiaUnavailable = $true
        }
    }
    $readyIcons = @($icons | Where-Object { Test-TrayIconReady $_.evidence })
    $script:trayReport.lastIconLookup = [ordered]@{ recordedAt = [DateTime]::UtcNow.ToString('o'); exactUuidMatches = $icons.Count; exactVisibleMatches = $readyIcons.Count; roots = $roots }
    if ($icons.Count -gt 1) { throw 'The exact UUID tray icon is ambiguous.' }
    if ($icons.Count -eq 1 -and $readyIcons.Count -eq 1) { $script:trayIconHost = $icons[0]; return $icons[0].element }
    return $null
}
function Get-TrayChevron {
    $buttons = [Collections.Generic.List[object]]::new()
    foreach ($shell in Get-TrayShellRoots) {
        if ($shell.Current.ClassName -cne 'Shell_TrayWnd') { continue }
        foreach ($button in @(Get-TrayElements $shell ([Windows.Automation.ControlType]::Button) @('显示隐藏的图标', 'Show hidden icons'))) {
            if (-not $button.Current.IsOffscreen -and $button.Current.ClassName -ceq 'SystemTray.NormalButton' -and $button.Current.AutomationId -ceq 'SystemTrayIcon') { $buttons.Add($button) }
        }
    }
    if ($buttons.Count -ne 1) { throw 'A unique exact hidden-icons toggle is required.' }
    return $buttons[0]
}
function Invoke-TrayElement($element) {
    if ($element.Current.IsOffscreen -or -not $element.Current.IsEnabled) { throw 'The exact native UI element must be visible and enabled.' }
    $pattern = $null
    if (-not $element.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { throw 'The exact native UI element has no Invoke pattern.' }
    $pattern.Invoke()
}
function Get-TrayVisibleIcon([DateTime]$deadline = ([DateTime]::UtcNow.AddSeconds(10))) {
    $attempts = 0
    $overflowChecked = $false
    do {
        $attempts++
        $icon = Get-TrayOwnIcon
        if ($null -ne $icon) {
            $script:trayReport.iconVisibilityAttempts = $attempts
            return $icon
        }
        if (-not $overflowChecked) {
            $script:trayReport.beforeOverflowLookup = $script:trayReport.lastIconLookup
            Assert-TrayProcess
            if (-not [AEOwnedTray]::OverflowVisible()) {
                Invoke-TrayElement (Get-TrayChevron)
                $script:trayOverflowOpened = $true
            }
            $script:trayReport.overflowOpenedByDriver = $script:trayOverflowOpened
            $overflowChecked = $true
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    $script:trayReport.iconVisibilityAttempts = $attempts
    throw 'The unique own UUID icon could not be made visible.'
}
function Get-TrayIconHitMethod($icon, [int]$x, [int]$y, [switch]$AllowNotReady) {
    $point = [Windows.Point]::new($x, $y)
    $hit = [Windows.Automation.AutomationElement]::FromPoint($point)
    $directHitRuntimeId = $hit.GetRuntimeId() -join ','
    $hitOwnIcon = $false
    $hitTestMethod = 'exact-uia-runtime-id'
    for ($depth = 0; $null -ne $hit -and $depth -lt 12; $depth++) {
        if (($hit.GetRuntimeId() -join ',') -ceq ($icon.GetRuntimeId() -join ',')) { $hitOwnIcon = $true; break }
        $hit = [Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($hit)
    }
    if (-not $hitOwnIcon) {
        $shell = [Windows.Automation.AutomationElement]::FromHandle($script:trayIconHost.shellHandle)
        # Windows 11 XAML can return only its host from UIA FromPoint.
        if ($directHitRuntimeId -ceq ($shell.GetRuntimeId() -join ',') -and [AEOwnedTray]::IsShellHit($x, $y, $script:trayIconHost.shellHandle, $script:trayIconHost.shellProcessId)) {
            $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Button)
            $buttonsAtPoint = @($shell.FindAll([Windows.Automation.TreeScope]::Descendants, $condition) | Where-Object { -not $_.Current.IsOffscreen -and $_.Current.BoundingRectangle.Contains($point) })
            if ($buttonsAtPoint.Count -eq 1 -and ($buttonsAtPoint[0].GetRuntimeId() -join ',') -ceq ($icon.GetRuntimeId() -join ',')) {
                $hitOwnIcon = $true
                $hitTestMethod = 'exact-uuid-button-bounds-and-native-shell-hit'
            }
        }
    }
    if (-not $hitOwnIcon -or -not [AEOwnedTray]::IsShellHit($x, $y, $script:trayIconHost.shellHandle, $script:trayIconHost.shellProcessId)) {
        if ($AllowNotReady) { return $null }
        throw 'The exact owned tray icon center is obscured; no mouse input was sent.'
    }
    return $hitTestMethod
}
function Get-TrayIconInputSample($icon) {
    if ($null -eq $icon) { return $null }
    $evidence = Get-TrayElementEvidence $icon
    if (-not (Test-TrayIconReady $evidence) -or @($evidence.runtimeId).Count -eq 0 -or $script:trayIconHost.shellHandle -eq [IntPtr]::Zero -or $script:trayIconHost.shellProcessId -le 0 -or $evidence.shellProcessId -ne $script:trayIconHost.shellProcessId) { return $null }
    return [ordered]@{ icon = $evidence; shellHandle = $script:trayIconHost.shellHandle.ToInt64(); shellProcessId = $script:trayIconHost.shellProcessId }
}
function Test-TraySameIconLayout($first, $second) {
    if ($null -eq $first -or $null -eq $second) { return $false }
    return $first.shellHandle -eq $second.shellHandle -and $first.shellProcessId -eq $second.shellProcessId -and ($first.icon.runtimeId -join ',') -ceq ($second.icon.runtimeId -join ',') -and ($first.icon.bounds -join ',') -ceq ($second.icon.bounds -join ',')
}
function Click-TrayOwnIcon([bool]$doubleClick, [DateTime]$deadline = ([DateTime]::UtcNow.AddSeconds(10))) {
    $previous = $null
    $stableSamples = 0
    $diagnostic = [ordered]@{ recordedAt = [DateTime]::UtcNow.ToString('o'); doubleClick = $doubleClick; phase = 'stable-layout'; samples = 0; stableSamples = 0; moves = 0; actualInputCompleted = $false; beforeMove = $null; afterMove = $null; cursorAfterMove = $null; foregroundProcessIdAfterMove = $null; failure = $null }
    $script:trayReport.iconPreparationDiagnostics += $diagnostic
    do {
        if ([DateTime]::UtcNow -ge $deadline) { break }
        Assert-TrayProcess
        $diagnostic.phase = 'stable-layout'
        try {
            $icon = Get-TrayVisibleIcon $deadline
            $sample = Get-TrayIconInputSample $icon
        } catch [Windows.Automation.ElementNotAvailableException] { $sample = $null }
        $diagnostic.samples++
        $stableSamples = if (Test-TraySameIconLayout $previous $sample) { $stableSamples + 1 } elseif ($null -ne $sample) { 1 } else { 0 }
        $diagnostic.stableSamples = $stableSamples
        $previous = $sample
        if ($stableSamples -ge 2 -and [DateTime]::UtcNow -lt $deadline) {
            $x = [int]($sample.icon.bounds[0] + $sample.icon.bounds[2] / 2)
            $y = [int]($sample.icon.bounds[1] + $sample.icon.bounds[3] / 2)
            $diagnostic.beforeMove = $sample
            Assert-TrayProcess
            if ([DateTime]::UtcNow -ge $deadline) { break }
            $diagnostic.phase = 'move'
            [AEOwnedTray]::MoveTrayCursor($x, $y)
            $diagnostic.moves++
            Start-Sleep -Milliseconds 25
            Assert-TrayProcess
            $diagnostic.phase = 'fresh-after-move'
            $fresh = $null
            $hitTestMethod = $null
            try {
                $freshIcon = Get-TrayOwnIcon
                $fresh = Get-TrayIconInputSample $freshIcon
                if (Test-TraySameIconLayout $sample $fresh) { $hitTestMethod = Get-TrayIconHitMethod $freshIcon $x $y -AllowNotReady }
            } catch [Windows.Automation.ElementNotAvailableException] { $fresh = $null }
            $cursor = [AEOwnedTray]::Cursor()
            $diagnostic.afterMove = $fresh
            $diagnostic.cursorAfterMove = @($cursor.X, $cursor.Y)
            $diagnostic.foregroundProcessIdAfterMove = [AEOwnedTray]::ForegroundProcessId()
            if ((Test-TraySameIconLayout $sample $fresh) -and $cursor.X -eq $x -and $cursor.Y -eq $y -and $hitTestMethod -and [DateTime]::UtcNow -lt $deadline) {
                Assert-TrayProcess
                if ([DateTime]::UtcNow -ge $deadline) { break }
                $diagnostic.phase = 'actual-input'
                $input = [ordered]@{ doubleClick = $doubleClick; center = @($x, $y); exactUuidHitTest = $true; hitTestMethod = $hitTestMethod; icon = $fresh.icon; shellHandle = $fresh.shellHandle; shellProcessId = $fresh.shellProcessId; stableSamples = $stableSamples; cursorBeforeInput = @($cursor.X, $cursor.Y); buttonPairsCompleted = 0; actualInputCompleted = $false }
                $script:trayReport.iconInputs += $input
                # The native method observes again and sends only button events;
                # it cannot move away from the freshly checked exact target.
                $revalidateTarget = [Action]{
                    Assert-TrayProcess
                    if ([DateTime]::UtcNow -ge $deadline) { throw 'The retained owned tray input deadline elapsed before its next button pair.' }
                    $buttonIcon = Get-TrayOwnIcon
                    $buttonSample = Get-TrayIconInputSample $buttonIcon
                    if (-not (Test-TraySameIconLayout $fresh $buttonSample)) { throw 'The exact owned UUID tray icon identity or layout changed before its next button pair.' }
                    $null = Get-TrayIconHitMethod $buttonIcon $x $y
                    Assert-TrayProcess
                    if ([DateTime]::UtcNow -ge $deadline) { throw 'The retained owned tray input deadline elapsed during its fresh button-pair observations.' }
                }
                $buttonReceipt = [AEOwnedTray+TrayIconInputReceipt]::new()
                try { [AEOwnedTray]::ClickTrayIconAtCursor($x, $y, $doubleClick, [IntPtr]$fresh.shellHandle, $fresh.shellProcessId, $revalidateTarget, $buttonReceipt) }
                finally { $input.buttonPairsCompleted = $buttonReceipt.ButtonPairsCompleted; $diagnostic.buttonPairsCompleted = $buttonReceipt.ButtonPairsCompleted }
                $input.actualInputCompleted = $true
                $diagnostic.actualInputCompleted = $true
                $diagnostic.failure = $null
                $diagnostic.phase = 'input-completed'
                return
            }
            $diagnostic.failure = 'cursor-layout-or-native-hit-not-ready'
            $previous = $null
            $stableSamples = 0
        }
        Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $deadline)
    $diagnostic.phase = 'pre-input-deadline'
    throw 'The unique own UUID icon did not retain stable layout, exact cursor and native hit before the deadline; no button input was sent.'
}
function Get-TrayOwnedWindow {
    Assert-TrayProcess
    return [AEOwnedTray]::OwnedWindow($OwnedProcessId, 'AE Switch', 'Tauri Window')
}
function Wait-TrayVisible([IntPtr]$expectedWindow = (Get-TrayOwnedWindow)) {
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $diagnostic = [ordered]@{ startedAtUtc = [DateTime]::UtcNow.ToString('o'); expectedMainHwnd = $expectedWindow.ToInt64(); budgetMs = 5000; status = 'waiting'; sampleCount = 0; samplesTruncated = $false; samples = @(); elapsedMs = 0 }
    $script:trayReport.windowVisibilityDiagnostics += $diagnostic
    try {
        do {
            $window = Get-TrayOwnedWindow
            $sample = [ordered]@{ observedAtUtc = [DateTime]::UtcNow.ToString('o'); elapsedMs = $clock.ElapsedMilliseconds; hwnd = $window.ToInt64(); visible = [AEOwnedTray]::IsWindowVisible($window); iconic = [AEOwnedTray]::IsIconic($window); enabled = [AEOwnedTray]::IsWindowEnabled($window) }
            $diagnostic.sampleCount++
            if ($diagnostic.samples.Count -lt 64) { $diagnostic.samples += $sample } else { $diagnostic.samplesTruncated = $true }
            if ($window -ne $expectedWindow) {
                $diagnostic.status = 'hwnd-changed'
                throw 'The exact owned main HWND changed while awaiting visibility.'
            }
            if ($sample.visible -and -not $sample.iconic) { $diagnostic.status = 'visible'; return $window }
            Start-Sleep -Milliseconds 100
        } while ([DateTime]::UtcNow -lt $deadline)
        $diagnostic.status = 'timeout'
        throw 'The owned application window did not become visible.'
    } catch {
        if ($diagnostic.status -ceq 'waiting') { $diagnostic.status = 'error' }
        throw
    } finally { $clock.Stop(); $diagnostic.elapsedMs = $clock.ElapsedMilliseconds }
}
function Wait-TrayCancelReady([IntPtr]$dialog, [IntPtr]$expectedWindow, [DateTime]$deadline = ([DateTime]::UtcNow.AddSeconds(3))) {
    $diagnostic = [ordered]@{ recordedAt = [DateTime]::UtcNow.ToString('o'); expectedMainHwnd = $expectedWindow.ToInt64(); cancelledDialogHwnd = $dialog.ToInt64(); attempts = 0; ready = $false }
    $script:trayReport.cancelReadiness = $diagnostic
    do {
        Assert-TrayProcess
        $window = Get-TrayOwnedWindow
        if ($window -ne $expectedWindow) { throw 'The exact owned main HWND changed after cancelling exit.' }
        $dialogs = @([AEOwnedTray]::OwnedDialogs($OwnedProcessId, '退出 AE Switch？'))
        if ($dialogs.Count -gt 1) { throw 'The exact owned exit dialog is ambiguous after cancellation.' }
        $diagnostic.attempts++
        $diagnostic.ownedDialogCount = $dialogs.Count
        $diagnostic.cancelledDialogVisible = [AEOwnedTray]::IsOwnedVisible($dialog, $OwnedProcessId)
        $diagnostic.mainVisible = [AEOwnedTray]::IsWindowVisible($window)
        $diagnostic.mainMinimized = [AEOwnedTray]::IsIconic($window)
        $diagnostic.mainEnabled = [AEOwnedTray]::IsWindowEnabled($window)
        $diagnostic.foregroundProcessId = [AEOwnedTray]::ForegroundProcessId()
        if ($dialogs.Count -eq 0 -and -not $diagnostic.cancelledDialogVisible -and $diagnostic.mainVisible -and -not $diagnostic.mainMinimized -and $diagnostic.mainEnabled -and [DateTime]::UtcNow -lt $deadline) {
            $diagnostic.ready = $true
            return $window
        }
        Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'The cancelled owned exit dialog did not disappear with its retained main window visible, restored and enabled before the deadline.'
}
function Hide-TrayOwnedSetup {
    $window = Get-TrayOwnedWindow
    Assert-TrayProcess
    if ((Get-TrayOwnedWindow) -ne $window) { throw 'The exact owned setup HWND changed before its native close request.' }
    $setup = [ordered]@{ message = 'WM_CLOSE'; nativeProcessId = $OwnedProcessId; nativeWindowHandle = $window.ToInt64(); requestPosted = $false; hiddenConfirmed = $false; healthConfirmed = $false; productCloseButtonAsserted = $false }
    $script:trayReport.ownedCloseRequestSetups += $setup
    [AEOwnedTray]::RequestCloseOwned($window, $OwnedProcessId, 'AE Switch', 'Tauri Window')
    $setup.requestPosted = $true
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        $current = Get-TrayOwnedWindow
        if ($current -ne $window) { throw 'The exact owned setup HWND changed while awaiting its close-request hide.' }
        if (-not [AEOwnedTray]::IsWindowVisible($window)) {
            $setup.hiddenConfirmed = $true
            $null = Assert-TrayHealth
            $setup.healthConfirmed = $true
            return
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'The product did not hide the exact owned setup window after its native close request.'
}
function Invoke-TrayMenu([string]$name) {
    $lookup = [ordered]@{ invocation = @($script:trayReport.menuLookupDiagnostics).Count + 1; startedAt = [DateTime]::UtcNow.ToString('o'); requestedName = $name; attempt = 0; phase = 'icon-preparation'; popupCount = $null; zeroPopupAttempts = 0; notReadyPopupAttempts = 0; nativeWindowHandle = $null; nativeMenuHandle = $null; nativeProcessId = $null; nativeClassName = $null; nativeVisible = $false; nativeReady = $false; nativeItems = @(); uia = $null; cursor = $null; foregroundProcessId = $null }
    $script:trayReport.menuLookupDiagnostics += $lookup
    $script:trayReport.lastMenuLookup = $lookup
    $script:trayReport.lastMenuInput = $null
    Click-TrayOwnIcon $false
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    $attempts = 0
    do {
        $attempts++
        Assert-TrayProcess
        $handles = @([AEOwnedTray]::OwnedMenus($OwnedProcessId))
        $lookup.attempt = $attempts
        $lookup.recordedAt = [DateTime]::UtcNow.ToString('o')
        $lookup.phase = 'popup-observation'
        $lookup.popupCount = $handles.Count
        $lookup.nativeWindowHandle = $null
        $lookup.nativeMenuHandle = $null
        $lookup.nativeProcessId = $null
        $lookup.nativeClassName = $null
        $lookup.nativeVisible = $false
        $lookup.nativeReady = $false
        $lookup.nativeItems = @()
        $lookup.uia = $null
        $cursor = [AEOwnedTray]::Cursor()
        $lookup.cursor = @($cursor.X, $cursor.Y)
        $lookup.foregroundProcessId = [AEOwnedTray]::ForegroundProcessId()
        if ($handles.Count -eq 0) { $lookup.zeroPopupAttempts++ }
        if ($handles.Count -gt 1) { throw 'More than one owned native tray menu is visible.' }
        if ($handles.Count -eq 1) {
            $snapshot = [AEOwnedTray]::ReadOwnedPopupMenu($handles[0], $OwnedProcessId)
            $uia = [ordered]@{ available = $false; items = @() }
            try {
                $menu = [Windows.Automation.AutomationElement]::FromHandle($handles[0])
                $uia.rootProcessId = $menu.Current.ProcessId
                $uia.rootName = $menu.Current.Name
                $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::MenuItem)
                foreach ($item in $menu.FindAll([Windows.Automation.TreeScope]::Descendants, $condition)) {
                    $uia.items += [ordered]@{ name = $item.Current.Name; processId = $item.Current.ProcessId; nativeWindowHandle = $item.Current.NativeWindowHandle; isOffscreen = $item.Current.IsOffscreen; isEnabled = $item.Current.IsEnabled; runtimeId = @($item.GetRuntimeId()) }
                }
                $uia.available = $true
            } catch [Windows.Automation.ElementNotAvailableException] { $uia.transientUnavailable = $true }
            catch { $uia.diagnosticUnavailable = $_.Exception.GetType().FullName }
            $lookup.nativeWindowHandle = $snapshot.Window.ToInt64()
            $lookup.nativeMenuHandle = $snapshot.Menu.ToInt64()
            $lookup.nativeProcessId = $snapshot.ProcessId
            $lookup.nativeClassName = $snapshot.ClassName
            $lookup.nativeVisible = $snapshot.Visible
            $lookup.nativeReady = $snapshot.Ready
            $lookup.nativeItems = @($snapshot.Items | ForEach-Object { [ordered]@{ name = $_.Name; position = $_.Position; state = $_.State; bounds = @($_.Bounds.Left, $_.Bounds.Top, $_.Bounds.Right, $_.Bounds.Bottom); boundsReady = $_.BoundsReady } })
            $lookup.uia = $uia
            if (-not $snapshot.Ready) { $lookup.notReadyPopupAttempts++ }
            # Win32 may expose the menu window before its contents/bounds are
            # ready. UIA child PID is diagnostic; actual HWND/HMENU owns input.
            if ($snapshot.Ready) {
                $lookup.phase = 'exact-menu-selection'
                $selected = [AEOwnedTray]::SelectOwnedMenuItem($snapshot, $name, $OwnedProcessId)
                Assert-TrayProcess
                $trayMenuReceipt = [AEOwnedTray]::ClickOwnedMenuItem($snapshot, $selected, $OwnedProcessId)
                $script:trayReport.lastMenuInput = [ordered]@{
                    requestedName = $name; nativeProcessId = $snapshot.ProcessId; nativeWindowHandle = $snapshot.Window.ToInt64(); nativeMenuHandle = $snapshot.Menu.ToInt64(); position = $selected.Position
                    moveSent = $trayMenuReceipt.MoveSent; highlighted = $trayMenuReceipt.Highlighted; clickSent = $trayMenuReceipt.ClickSent; menuDismissed = $trayMenuReceipt.MenuDismissed
                    center = @($trayMenuReceipt.X, $trayMenuReceipt.Y); hoverAttempts = $trayMenuReceipt.HoverAttempts; hoverDurationMs = $trayMenuReceipt.HoverDurationMs; stateBeforeHover = $trayMenuReceipt.StateBeforeHover; stateBeforeClick = $trayMenuReceipt.StateBeforeClick
                    foregroundProcessIdBeforeHover = $trayMenuReceipt.ForegroundProcessIdBeforeHover; foregroundProcessIdBeforeClick = $trayMenuReceipt.ForegroundProcessIdBeforeClick; foregroundProcessIdAfterClick = $trayMenuReceipt.ForegroundProcessIdAfterClick
                    phase = $trayMenuReceipt.Phase; failure = $trayMenuReceipt.Failure; nativeErrorCode = $trayMenuReceipt.NativeErrorCode
                }
                if ($trayMenuReceipt.ClickSent) { $script:trayReport.menuInputs += [ordered]@{ requestedName = $name; nativeProcessId = $snapshot.ProcessId; nativeWindowHandle = $snapshot.Window.ToInt64(); nativeMenuHandle = $snapshot.Menu.ToInt64(); position = $selected.Position; name = $selected.Name; exactOwnedMenuHit = $true; input = 'actual-left-mouse'; attempts = $attempts; hoverHighlighted = $trayMenuReceipt.Highlighted; menuDismissed = $trayMenuReceipt.MenuDismissed } }
                if (-not $trayMenuReceipt.ClickSent) { throw "The exact owned menu item was not ready for left input ($($trayMenuReceipt.Failure)); no left click was sent." }
                if (-not $trayMenuReceipt.MenuDismissed) { throw 'The exact owned native tray menu did not disappear after actual left input.' }
                $lookup.phase = 'menu-input-completed'
                return
            }
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    $lookup.phase = 'popup-deadline'
    throw 'The owned native tray menu did not expose its exact ready items before the deadline.'
}
function Wait-TrayExitDialog {
    $deadline = [DateTime]::UtcNow.AddSeconds(3)
    do {
        $script:trayProcess.Refresh()
        if ($script:trayProcess.HasExited) { return [IntPtr]::Zero }
        Assert-TrayProcess
        $handles = @([AEOwnedTray]::OwnedDialogs($OwnedProcessId, '退出 AE Switch？'))
        if ($handles.Count -gt 1) { throw 'The exact owned exit dialog is ambiguous.' }
        if ($handles.Count -eq 1) { return $handles[0] }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'The owned process neither exited nor showed its exact exit confirmation.'
}
function Select-TrayDialogButtonIdentity([object[]]$candidates, [string]$name, [int]$processId) {
    if ($name -cnotin @('确定', '取消') -or $candidates.Count -gt 16) { throw 'Only an exact owned confirmation or cancellation button is permitted.' }
    $matches = @($candidates | Where-Object { $_.name -ceq $name })
    if ($matches.Count -ne 1) { throw 'The exact owned UIA dialog button name is missing or ambiguous.' }
    $selected = $matches[0]
    $representationMatches = ($selected.className -ceq 'Button' -and $selected.controlType -ceq 'ControlType.Button') -or ($selected.className -ceq 'CCPushButton' -and $selected.controlType -ceq 'ControlType.Pane')
    if ($selected.nativeHwnd -le 0 -or $selected.shellProcessId -ne $processId -or -not $representationMatches -or $selected.isOffscreen -ne $false -or $selected.isEnabled -ne $true -or $selected.automationId -isnot [string]) { throw 'The exact owned UIA button HWND, process, class, type or readiness was rejected.' }
    return $selected
}
function Invoke-TrayDialogButton([IntPtr]$handle, [int]$buttonId) {
    if ($buttonId -notin @(1, 2)) { throw 'Only the owned confirmation or cancellation action is permitted.' }
    $buttonName = if ($buttonId -eq 1) { '确定' } else { '取消' }
    Assert-TrayProcess
    if (-not [AEOwnedTray]::IsOwnedVisible($handle, $OwnedProcessId)) { throw 'The retained owned dialog is no longer visible.' }
    $dialog = [Windows.Automation.AutomationElement]::FromHandle($handle)
    if ($dialog.Current.Name -cne '退出 AE Switch？' -or $dialog.Current.ProcessId -ne $OwnedProcessId) { throw 'Exit dialog title/process identity mismatch.' }
    $diagnostic = [ordered]@{ dialogHwnd = $handle.ToInt64(); requestedName = $buttonName; selector = 'unique-native-and-uia-name-hwnd'; phase = 'native-read'; nativeCandidates = @(); uiaCandidates = @(); actualInputCompleted = $false; actualInvokeCompleted = $false }
    $script:trayReport.dialogButtonDiagnostics += $diagnostic
    $snapshot = [AEOwnedTray]::ReadOwnedDialog($handle, $OwnedProcessId)
    $diagnostic.dialogClass = $snapshot.ClassName
    $diagnostic.dialogCount = $snapshot.DialogCount
    foreach ($candidate in $snapshot.Buttons) {
        $diagnostic.nativeCandidates += [ordered]@{ hwnd = $candidate.Window.ToInt64(); rootHwnd = $candidate.Root.ToInt64(); controlId = $candidate.ControlId; pid = $candidate.ProcessId; className = $candidate.ClassName; name = $candidate.Name; visible = $candidate.Visible; enabled = $candidate.Enabled; hitHwnd = $candidate.HitWindow.ToInt64(); hitRootHwnd = $candidate.HitRoot.ToInt64(); hitPid = $candidate.HitProcessId; boundsReady = $candidate.BoundsReady }
    }
    foreach ($candidate in $snapshot.Buttons) {
        if ($candidate.ClassName -cne 'Button') { continue }
        if ($diagnostic.uiaCandidates.Count -ge 16) { throw 'The owned dialog UIA button inventory exceeds its bound.' }
        $candidateElement = [Windows.Automation.AutomationElement]::FromHandle($candidate.Window)
        $candidateEvidence = Get-TrayElementEvidence $candidateElement
        $candidateEvidence.nativeHwnd = [long]$candidateElement.Current.NativeWindowHandle
        $diagnostic.uiaCandidates += $candidateEvidence
    }
    $identity = Select-TrayDialogButtonIdentity $diagnostic.uiaCandidates $buttonName $OwnedProcessId
    $diagnostic.phase = 'native-select'
    $button = [AEOwnedTray]::SelectOwnedDialogButton($snapshot, $buttonName, [IntPtr][long]$identity.nativeHwnd, $OwnedProcessId)
    $diagnostic.selectedHwnd = $button.Window.ToInt64()
    $diagnostic.selectedName = $identity.name
    $diagnostic.selectedAutomationId = $identity.automationId
    $diagnostic.phase = 'uia-from-native-hwnd'
    $element = [Windows.Automation.AutomationElement]::FromHandle($button.Window)
    $elementEvidence = Get-TrayElementEvidence $element
    $elementEvidence.nativeHwnd = [long]$element.Current.NativeWindowHandle
    $null = Select-TrayDialogButtonIdentity @($elementEvidence) $buttonName $OwnedProcessId
    if ($elementEvidence.nativeHwnd -ne $button.Window.ToInt64()) { throw 'The UIA element does not match the exact owned native button HWND.' }
    $pattern = $null
    $invokeAvailable = $element.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)
    $diagnostic.invokePatternAvailable = $invokeAvailable
    Assert-TrayProcess
    $diagnostic.phase = 'native-recheck-and-hit'
    $current = [AEOwnedTray]::SelectOwnedDialogButton([AEOwnedTray]::ReadOwnedDialog($handle, $OwnedProcessId), $buttonName, $button.Window, $OwnedProcessId)
    if ($current.Window -ne $button.Window -or $current.Bounds.Left -ne $button.Bounds.Left -or $current.Bounds.Top -ne $button.Bounds.Top -or $current.Bounds.Right -ne $button.Bounds.Right -or $current.Bounds.Bottom -ne $button.Bounds.Bottom) { throw 'The exact owned native dialog button changed before invocation.' }
    $currentEvidence = Get-TrayElementEvidence $element
    $currentEvidence.nativeHwnd = [long]$element.Current.NativeWindowHandle
    $currentIdentity = Select-TrayDialogButtonIdentity @($currentEvidence) $buttonName $OwnedProcessId
    if ($currentIdentity.nativeHwnd -ne $button.Window.ToInt64() -or $currentIdentity.automationId -cne $identity.automationId -or $currentIdentity.className -cne $identity.className -or $currentIdentity.controlType -cne $identity.controlType) { throw 'The exact owned UIA button identity changed before invocation.' }
    Assert-TrayProcess
    if ($invokeAvailable) {
        $diagnostic.phase = 'actual-invoke'
        $diagnostic.inputMethod = 'UIA.InvokePattern'
        $pattern.Invoke()
        $diagnostic.actualInvokeCompleted = $true
    } else {
        $diagnostic.phase = 'actual-owned-left-click'
        $diagnostic.inputMethod = 'SendInput-left-click'
        $point = [AEOwnedTray]::ClickOwnedDialogButton($snapshot, $current, $OwnedProcessId)
        $diagnostic.center = @($point.X, $point.Y)
    }
    $diagnostic.actualInputCompleted = $true
    $diagnostic.phase = 'input-completed'
}

try {
    Assert-TrayOwner
    if ([IO.Path]::GetFullPath($ReportPath) -cne $trayReportPath) { throw 'The tray receipt must match the exact eligible full-suite or owned restore-only path.' }
    Assert-TrayAncestors ([IO.Path]::GetDirectoryName($trayReportPath))
    if ([IO.File]::Exists($trayReportPath) -or [IO.Directory]::Exists($trayReportPath)) { Assert-TrayOrdinary $trayReportPath $false }
    # Restore receipts live inside the UUID and become writable only after its
    # marker, executable and retained process have all been verified.
    if (-not $RestoreOwnedOnly) { $trayReportEligible = $true }
    $trayExe = Join-Path $trayRoot 'AE-Switch-QA.exe'
    Assert-TrayOrdinary $trayExe $false
    if ($ExpectedSha256 -cnotmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $trayExe -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedSha256) { throw 'Owned tray executable hash mismatch.' }
    $trayProcess = [Diagnostics.Process]::GetProcessById($OwnedProcessId)
    $null = $trayProcess.Handle
    $trayCreation = [DateTimeOffset]::Parse($ExpectedStartedAt).UtcDateTime
    $trayTooltip = "AE Switch QA · $trayId"
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Import-Module (Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell/v1.0/Modules/NetTCPIP/NetTCPIP.psd1') -ErrorAction Stop
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class AEOwnedTray {
    public delegate bool Callback(IntPtr h, IntPtr p);
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct MenuBarInfo { public uint Size; public Rect Bounds; public IntPtr Menu, MenuWindow; public uint FocusFlags; }
    public sealed class NativeMenuItem { public string Name; public int Position; public uint State; public Rect Bounds; public bool BoundsReady; }
    public sealed class NativeMenuSnapshot { public IntPtr Window, Menu; public int ProcessId; public string ClassName; public bool Visible, Ready; public NativeMenuItem[] Items; }
    public sealed class NativeDialogButton { public IntPtr Window, Root, HitWindow, HitRoot; public int ControlId, ProcessId, HitProcessId; public string Name, ClassName; public bool Visible, Enabled, BoundsReady; public Rect Bounds; }
    public sealed class NativeDialogSnapshot { public IntPtr Window, Root; public int ProcessId, DialogCount; public string Name, ClassName; public bool Visible, Enabled; public NativeDialogButton[] Buttons; }
    public sealed class TrayIconInputReceipt { public int ButtonPairsCompleted; }
    public sealed class NativeMenuInputReceipt {
        public bool MoveSent, Highlighted, ClickSent, MenuDismissed;
        public int X, Y, HoverAttempts, HoverDurationMs, ForegroundProcessIdBeforeHover, ForegroundProcessIdBeforeClick, ForegroundProcessIdAfterClick;
        public uint StateBeforeHover, StateBeforeClick; public int? NativeErrorCode; public string Phase, Failure;
    }
    [StructLayout(LayoutKind.Sequential)] struct MouseInput { public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] struct Input { public uint Type; public MouseInput Mouse; }
    [DllImport("user32.dll")] static extern bool EnumWindows(Callback cb, IntPtr p);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h, Callback cb, IntPtr p);
    [DllImport("user32.dll", ExactSpelling=true)] static extern int GetDlgCtrlID(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Rect rectangle);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder text, int size);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder text, int size);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll",SetLastError=true)] static extern bool GetMenuBarInfo(IntPtr h,int objectId,int item,ref MenuBarInfo info);
    [DllImport("user32.dll")] static extern int GetMenuItemCount(IntPtr menu);
    [DllImport("user32.dll",EntryPoint="GetMenuStringW",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern int GetMenuString(IntPtr menu,uint item,StringBuilder text,int count,uint flags);
    [DllImport("user32.dll")] static extern uint GetMenuState(IntPtr menu,uint item,uint flags);
    [DllImport("user32.dll",SetLastError=true)] static extern bool GetMenuItemRect(IntPtr window,IntPtr menu,uint item,out Rect rectangle);
    [DllImport("user32.dll", EntryPoint="PostMessageW", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] static extern bool PostMessage(IntPtr h, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", SetLastError=true)] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll", SetLastError=true)] static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, Input[] input, int size);
    [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("kernel32.dll", EntryPoint="QueryFullProcessImageNameW", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] static extern bool QueryImage(IntPtr process, uint flags, StringBuilder name, ref uint size);
    public static string ProcessPath(IntPtr handle) { var path=new StringBuilder(32768); uint size=32768; if(!QueryImage(handle,0,path,ref size)) throw new Win32Exception(Marshal.GetLastWin32Error()); return path.ToString(); }
    static string Text(IntPtr h, bool cls) { var text=new StringBuilder(1024); if(cls) GetClassName(h,text,text.Capacity); else GetWindowText(h,text,text.Capacity); return text.ToString(); }
    static IntPtr[] Find(int pid, string title, string cls, bool visible, bool shell) {
        var matches=new List<IntPtr>();
        EnumWindows((h,p)=> { uint found; GetWindowThreadProcessId(h,out found); string name=Text(h,true);
            if(shell ? name!="Shell_TrayWnd" && !IsOverflowClass(name) : found!=(uint)pid || (cls!=null && name!=cls) || (title!=null && Text(h,false)!=title)) return true;
            if(!visible || IsWindowVisible(h)) matches.Add(h); return true;
        },IntPtr.Zero); return matches.ToArray();
    }
    public static IntPtr[] ShellWindows() { return Find(0,null,null,false,true); }
    public static string WindowClass(IntPtr h) { return Text(h,true); }
    public static bool IsOverflowClass(string name) { return name=="NotifyIconOverflowWindow" || name=="TopLevelWindowForOverflowXamlIsland"; }
    public static bool IsShellHit(int x,int y,IntPtr root,int pid) { var hit=WindowFromPoint(new Point{X=x,Y=y}); uint found; GetWindowThreadProcessId(hit,out found); return hit!=IntPtr.Zero && found==(uint)pid && GetAncestor(hit,2)==root && (Text(root,true)=="Shell_TrayWnd" || IsOverflowClass(Text(root,true))); }
    public static IntPtr OwnedWindow(int pid,string title,string cls) { var all=Find(pid,title,cls,false,false); if(all.Length!=1) throw new Exception("Expected one exact owned application window."); return all[0]; }
    public static IntPtr[] OwnedMenus(int pid) { return Find(pid,null,"#32768",true,false); }
    public static IntPtr[] OwnedDialogs(int pid,string title) { return Find(pid,title,null,true,false); }
    public static bool IsOwnedVisible(IntPtr h,int pid) { uint found; GetWindowThreadProcessId(h,out found); return found==(uint)pid && IsWindowVisible(h); }
    public static NativeDialogSnapshot ReadOwnedDialog(IntPtr window,int pid) {
        uint found; GetWindowThreadProcessId(window,out found);
        if(window==IntPtr.Zero || found!=(uint)pid || GetAncestor(window,2)!=window || Text(window,true)!="#32770" || Text(window,false)!="退出 AE Switch？" || !IsWindowVisible(window)) throw new Exception("The exact native dialog HWND no longer belongs to the retained owned process.");
        var snapshot=new NativeDialogSnapshot{Window=window,Root=GetAncestor(window,2),ProcessId=(int)found,Name=Text(window,false),ClassName=Text(window,true),Visible=IsWindowVisible(window),Enabled=IsWindowEnabled(window),DialogCount=OwnedDialogs(pid,"退出 AE Switch？").Length};
        var buttons=new List<NativeDialogButton>();
        EnumChildWindows(window,(h,p)=> {
            int id=GetDlgCtrlID(h); string cls=Text(h,true);
            if(cls!="Button" && id!=1 && id!=2) return true;
            if(buttons.Count>=17) return false;
            uint buttonPid; GetWindowThreadProcessId(h,out buttonPid); Rect bounds;
            bool ready=GetWindowRect(h,out bounds) && bounds.Right>bounds.Left && bounds.Bottom>bounds.Top;
            var hit=ready ? WindowFromPoint(new Point{X=(int)((long)bounds.Left+((long)bounds.Right-bounds.Left)/2),Y=(int)((long)bounds.Top+((long)bounds.Bottom-bounds.Top)/2)}) : IntPtr.Zero;
            uint hitPid; GetWindowThreadProcessId(hit,out hitPid);
            buttons.Add(new NativeDialogButton{Window=h,Root=GetAncestor(h,2),ControlId=id,ProcessId=(int)buttonPid,Name=Text(h,false),ClassName=cls,Visible=IsWindowVisible(h),Enabled=IsWindowEnabled(h),BoundsReady=ready,Bounds=bounds,HitWindow=hit,HitRoot=GetAncestor(hit,2),HitProcessId=(int)hitPid});
            return true;
        },IntPtr.Zero);
        if(buttons.Count>16) throw new Exception("The owned dialog native button inventory exceeds its bound.");
        snapshot.Buttons=buttons.ToArray(); return snapshot;
    }
    public static NativeDialogButton SelectOwnedDialogButton(NativeDialogSnapshot dialog,string name,IntPtr expected,int pid) {
        if(name!="确定" && name!="取消") throw new Exception("Only the exact owned confirmation or cancellation name is permitted.");
        if(dialog==null || dialog.Window==IntPtr.Zero || dialog.Root!=dialog.Window || dialog.ProcessId!=pid || dialog.Name!="退出 AE Switch？" || dialog.ClassName!="#32770" || !dialog.Visible || !dialog.Enabled || dialog.DialogCount!=1 || dialog.Buttons==null || dialog.Buttons.Length>16) throw new Exception("One exact owned visible enabled native exit dialog is required.");
        NativeDialogButton selected=null;
        foreach(var button in dialog.Buttons) {
            if(button.Name!=name) continue;
            if(selected!=null) throw new Exception("The exact native dialog button name is ambiguous.");
            selected=button;
        }
        if(selected==null || expected==IntPtr.Zero || selected.Window!=expected || selected.Root!=dialog.Window || selected.ProcessId!=pid || selected.ClassName!="Button" || !selected.Visible || !selected.Enabled || !selected.BoundsReady || selected.Bounds.Right<=selected.Bounds.Left || selected.Bounds.Bottom<=selected.Bounds.Top) throw new Exception("The exact owned native dialog button HWND, name, class or readiness was rejected.");
        if(selected.HitWindow!=selected.Window || selected.HitRoot!=dialog.Window || selected.HitProcessId!=pid) throw new Exception("The exact owned native button center is obscured; no invocation was sent.");
        return selected;
    }
    public static Point ClickOwnedDialogButton(NativeDialogSnapshot expected,NativeDialogButton button,int pid) {
        if(expected==null || button==null) throw new Exception("An exact retained owned dialog and button are required.");
        SelectOwnedDialogButton(expected,button.Name,button.Window,pid);
        var current=SelectOwnedDialogButton(ReadOwnedDialog(expected.Window,pid),button.Name,button.Window,pid);
        if(current.Bounds.Left!=button.Bounds.Left || current.Bounds.Top!=button.Bounds.Top || current.Bounds.Right!=button.Bounds.Right || current.Bounds.Bottom!=button.Bounds.Bottom) throw new Exception("The owned dialog button bounds changed before mouse movement.");
        int x=(int)((long)current.Bounds.Left+((long)current.Bounds.Right-current.Bounds.Left)/2),y=(int)((long)current.Bounds.Top+((long)current.Bounds.Bottom-current.Bounds.Top)/2);
        MoveOwnedMenuCursor(x,y);
        current=SelectOwnedDialogButton(ReadOwnedDialog(expected.Window,pid),button.Name,button.Window,pid);
        var cursor=Cursor();
        if(current.Bounds.Left!=button.Bounds.Left || current.Bounds.Top!=button.Bounds.Top || current.Bounds.Right!=button.Bounds.Right || current.Bounds.Bottom!=button.Bounds.Bottom || cursor.X!=x || cursor.Y!=y) throw new Exception("The exact owned dialog button or cursor changed before left input.");
        Send(0x0002,0x0004);
        return new Point{X=x,Y=y};
    }
    public static NativeMenuSnapshot ReadOwnedPopupMenu(IntPtr window,int pid) {
        uint found; GetWindowThreadProcessId(window,out found);
        if(found!=(uint)pid || Text(window,true)!="#32768" || !IsWindowVisible(window)) throw new Exception("The actual popup HWND no longer belongs to the retained owned process.");
        var snapshot=new NativeMenuSnapshot{Window=window,ProcessId=(int)found,ClassName=Text(window,true),Visible=true,Items=new NativeMenuItem[0]};
        var info=new MenuBarInfo{Size=(uint)Marshal.SizeOf(typeof(MenuBarInfo))};
        // OBJID_CLIENT identifies the actual popup associated with this HWND.
        if(!GetMenuBarInfo(window,-4,0,ref info) || info.Menu==IntPtr.Zero) return snapshot;
        snapshot.Menu=info.Menu;
        int count=GetMenuItemCount(info.Menu); if(count<0) return snapshot;
        if(count>8) throw new Exception("Owned native menu exceeds the bounded item inventory.");
        var items=new List<NativeMenuItem>(); bool ready=count>0;
        for(int position=0;position<count;position++) {
            var text=new StringBuilder(1024); int length=GetMenuString(info.Menu,(uint)position,text,text.Capacity,0x400);
            uint state=GetMenuState(info.Menu,(uint)position,0x400); Rect rectangle;
            bool bounds=GetMenuItemRect(IntPtr.Zero,info.Menu,(uint)position,out rectangle) && rectangle.Right>rectangle.Left && rectangle.Bottom>rectangle.Top;
            if(length==0 || length>=text.Capacity-1 || state==0xffffffff || !bounds) ready=false;
            items.Add(new NativeMenuItem{Name=text.ToString(),Position=position,State=state,Bounds=rectangle,BoundsReady=bounds});
        }
        snapshot.Items=items.ToArray(); snapshot.Ready=ready; return snapshot;
    }
    public static NativeMenuItem SelectOwnedMenuItem(NativeMenuSnapshot menu,string name,int pid) {
        if(menu==null || menu.Window==IntPtr.Zero || menu.Menu==IntPtr.Zero || menu.ProcessId!=pid || menu.ClassName!="#32768" || !menu.Visible || !menu.Ready || menu.Items==null || menu.Items.Length!=2) throw new Exception("Exact owned native popup identity and two ready entries are required.");
        if(name!="打开 AE Switch" && name!="退出应用…") throw new Exception("Only an exact product tray menu action is permitted.");
        NativeMenuItem selected=null; int open=0,exit=0;
        foreach(var item in menu.Items) {
            if(item.Name=="打开 AE Switch") open++; if(item.Name=="退出应用…") exit++;
            if(item.Position<0 || item.Position>=menu.Items.Length || !item.BoundsReady || item.Bounds.Right<=item.Bounds.Left || item.Bounds.Bottom<=item.Bounds.Top || item.State==0xffffffff || (item.State & (0x3u|0x10u|0x800u))!=0) throw new Exception("Exact tray entries must be enabled ordinary visible items.");
            if(item.Name==name) { if(selected!=null) throw new Exception("Requested native menu label is ambiguous."); selected=item; }
        }
        if(open!=1 || exit!=1 || selected==null || menu.Items[0].Position==menu.Items[1].Position) throw new Exception("Both exact product tray labels must be unique native entries.");
        return selected;
    }
    static NativeMenuItem RecheckOwnedMenuItem(NativeMenuSnapshot expected,NativeMenuItem item,int pid) {
        var current=ReadOwnedPopupMenu(expected.Window,pid); var actual=SelectOwnedMenuItem(current,item.Name,pid);
        if(current.Window!=expected.Window || current.Menu!=expected.Menu || actual.Position!=item.Position || actual.Name!=item.Name || actual.Bounds.Left!=item.Bounds.Left || actual.Bounds.Top!=item.Bounds.Top || actual.Bounds.Right!=item.Bounds.Right || actual.Bounds.Bottom!=item.Bounds.Bottom) throw new Exception("Exact owned menu item changed before actual input.");
        int x=(int)((long)actual.Bounds.Left+((long)actual.Bounds.Right-actual.Bounds.Left)/2),y=(int)((long)actual.Bounds.Top+((long)actual.Bounds.Bottom-actual.Bounds.Top)/2);
        var hit=WindowFromPoint(new Point{X=x,Y=y}); uint found; GetWindowThreadProcessId(hit,out found);
        if(hit!=current.Window || found!=(uint)pid || !IsOwnedVisible(hit,pid) || Text(hit,true)!="#32768") throw new Exception("The exact owned menu item center is obscured; no input was sent.");
        return actual;
    }
    public static int ForegroundProcessId() { uint found; GetWindowThreadProcessId(GetForegroundWindow(),out found); return (int)found; }
    static void MoveOwnedMenuCursor(int x,int y) {
        int left=GetSystemMetrics(76),top=GetSystemMetrics(77),width=GetSystemMetrics(78),height=GetSystemMetrics(79);
        if(width<=1 || height<=1 || x<left || y<top || (long)x>=(long)left+width || (long)y>=(long)top+height) throw new Exception("Exact owned menu coordinates are outside the screen.");
        var input=new[]{new Input{Mouse=new MouseInput{X=(int)((((long)x-left)*65536+32768)/width),Y=(int)((((long)y-top)*65536+32768)/height),Flags=0x0001|0x4000|0x8000}}};
        if(SendInput(1,input,Marshal.SizeOf(typeof(Input)))!=1) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    public static NativeMenuInputReceipt ClickOwnedMenuItem(NativeMenuSnapshot expected,NativeMenuItem item,int pid) {
        var receipt=new NativeMenuInputReceipt{Phase="identity"};
        try {
            var actual=RecheckOwnedMenuItem(expected,item,pid);
            receipt.X=(int)((long)actual.Bounds.Left+((long)actual.Bounds.Right-actual.Bounds.Left)/2); receipt.Y=(int)((long)actual.Bounds.Top+((long)actual.Bounds.Bottom-actual.Bounds.Top)/2);
            receipt.StateBeforeHover=actual.State; receipt.ForegroundProcessIdBeforeHover=ForegroundProcessId();
            receipt.Phase="move"; MoveOwnedMenuCursor(receipt.X,receipt.Y); receipt.MoveSent=true;
            receipt.Phase="hover"; var hover=System.Diagnostics.Stopwatch.StartNew();
            do {
                receipt.HoverAttempts++; actual=RecheckOwnedMenuItem(expected,item,pid);
                receipt.StateBeforeClick=actual.State; var cursor=Cursor();
                if(cursor.X==receipt.X && cursor.Y==receipt.Y && (actual.State & 0x80u)!=0) { receipt.Highlighted=true; break; }
                Thread.Sleep(25);
            } while(hover.ElapsedMilliseconds<1000);
            receipt.HoverDurationMs=(int)hover.ElapsedMilliseconds;
            if(!receipt.Highlighted) { receipt.Failure="hover-not-highlighted"; return receipt; }
            receipt.Phase="click"; actual=RecheckOwnedMenuItem(expected,item,pid); var beforeClick=Cursor();
            receipt.StateBeforeClick=actual.State;
            if(beforeClick.X!=receipt.X || beforeClick.Y!=receipt.Y || (actual.State & 0x80u)==0) { receipt.Failure="hover-changed-before-click"; return receipt; }
            receipt.ForegroundProcessIdBeforeClick=ForegroundProcessId(); Send(0x0002,0x0004); receipt.ClickSent=true;
            receipt.Phase="dismiss"; var dismiss=System.Diagnostics.Stopwatch.StartNew();
            while(IsWindowVisible(expected.Window) && dismiss.ElapsedMilliseconds<1000) Thread.Sleep(25);
            receipt.MenuDismissed=!IsWindowVisible(expected.Window); receipt.ForegroundProcessIdAfterClick=ForegroundProcessId();
            receipt.Failure=receipt.MenuDismissed ? null : "menu-not-dismissed"; return receipt;
        } catch(Win32Exception failure) { receipt.NativeErrorCode=failure.NativeErrorCode; receipt.Failure=receipt.Phase+"-win32-error"; return receipt; }
        catch { receipt.Failure=receipt.Phase+"-ownership-or-readiness-rejected"; return receipt; }
    }
    public static void RequestCloseOwned(IntPtr h,int pid,string title,string cls) {
        uint found; GetWindowThreadProcessId(h,out found);
        if(h==IntPtr.Zero || found!=(uint)pid || Text(h,false)!=title || Text(h,true)!=cls || OwnedWindow(pid,title,cls)!=h) throw new Exception("The exact owned setup HWND identity changed before its native close request.");
        if(!PostMessage(h,0x0010,UIntPtr.Zero,IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    public static Point Cursor() { Point p; if(!GetCursorPos(out p)) throw new Win32Exception(Marshal.GetLastWin32Error()); return p; }
    public static void Cursor(Point point) { if(!SetCursorPos(point.X,point.Y)) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    public static bool OverflowVisible() { foreach(var h in ShellWindows()) if(IsOverflowClass(Text(h,true)) && IsWindowVisible(h)) return true; return false; }
    static void Send(uint down,uint up) { var input=new[]{new Input{Mouse=new MouseInput{Flags=down}},new Input{Mouse=new MouseInput{Flags=up}}}; if(SendInput(2,input,Marshal.SizeOf(typeof(Input)))!=2) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    public static void MoveTrayCursor(int x,int y) {
        int left=GetSystemMetrics(76),top=GetSystemMetrics(77),width=GetSystemMetrics(78),height=GetSystemMetrics(79);
        if(x<left || y<top || x>=left+width || y>=top+height) throw new Exception("Exact owned icon coordinates are outside the screen.");
        if(!SetCursorPos(x,y)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    public static void SendTrayIconButtonPairsAtCursor(int x,int y,bool twice,Action revalidate,Func<Point> readCursor,Func<bool> nativeHit,Action sendPair,Action betweenPairs) {
        if(revalidate==null || readCursor==null || nativeHit==null || sendPair==null || betweenPairs==null) throw new ArgumentException("Every exact owned tray button-pair observation and input delegate is required.");
        int pairs=twice?2:1;
        for(int pair=0;pair<pairs;pair++) {
            if(pair>0) betweenPairs();
            revalidate();
            var cursor=readCursor();
            if(cursor.X!=x || cursor.Y!=y || !nativeHit()) throw new Exception("The exact owned tray cursor or native shell hit changed before button input.");
            sendPair();
        }
    }
    public static void ClickTrayIconAtCursor(int x,int y,bool twice,IntPtr host,int shellPid,Action revalidate,TrayIconInputReceipt receipt) {
        if(receipt==null || receipt.ButtonPairsCompleted!=0) throw new ArgumentException("A fresh owned tray button receipt is required.");
        SendTrayIconButtonPairsAtCursor(x,y,twice,revalidate,Cursor,()=>IsShellHit(x,y,host,shellPid),()=> { if(twice) Send(0x0002,0x0004); else Send(0x0008,0x0010); receipt.ButtonPairsCompleted++; },()=>Thread.Sleep(60));
    }
}
'@
    Assert-TrayProcess
    if ($RestoreOwnedOnly) { $trayReportEligible = $true }
    $trayGatewayPath = Join-Path $trayRoot 'data/protocol-bridge.json'
    Assert-TrayAncestors ([IO.Path]::GetDirectoryName($trayGatewayPath))
    Assert-TrayOrdinary $trayGatewayPath $false
    $trayGateway = [IO.File]::ReadAllText($trayGatewayPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $trayPort = [int]$trayGateway.port
    $trayToken = [string]$trayGateway.token
    if ($trayPort -lt 1 -or $trayPort -gt 65535 -or $trayToken -cnotmatch '^[a-f0-9]{64}$') { throw 'Owned gateway metadata is invalid.' }
    $trayReport.verifiedOwnedIdentity = $true
    $trayReport.tooltip = $trayTooltip
    $trayReport.gatewayPort = $trayPort
    if ($RestoreOwnedOnly) { $trayReport.healthBefore = Assert-TrayHealth }
    else { Add-TrayGate 'initial-owned-health' 'passed' (Assert-TrayHealth) }
    $trayOriginalCursor = [AEOwnedTray]::Cursor()
    $trayCursorSaved = $true
    $trayOriginalDpi = [AEOwnedTray]::SetThreadDpiAwarenessContext([IntPtr](-4))
    if ($trayOriginalDpi -eq [IntPtr]::Zero) { throw 'Could not establish physical-coordinate DPI context.' }
    $trayDpiSaved = $true
    $trayOriginalOverflowVisible = [AEOwnedTray]::OverflowVisible()
    $trayOverflowStateSaved = $true
    $trayReport.originalOverflowVisible = $trayOriginalOverflowVisible
    $trayReport.iconInputs = @()
    $trayReport.iconPreparationDiagnostics = @()
    $trayReport.menuInputs = @()
    $trayReport.menuLookupDiagnostics = @()
    $trayReport.ownedCloseRequestSetups = @()
    $trayReport.windowVisibilityDiagnostics = @()

    if ($RestoreOwnedOnly) {
        $trayRestoreWindow = Get-TrayOwnedWindow
        $trayReport.nativeStateBefore = [ordered]@{ hwnd = $trayRestoreWindow.ToInt64(); visible = [AEOwnedTray]::IsWindowVisible($trayRestoreWindow); minimized = [AEOwnedTray]::IsIconic($trayRestoreWindow) }
        $trayRestoreBefore = Get-TrayDispatchDiagnostics
        if ($trayRestoreBefore.status -cne 'available' -or $trayRestoreBefore.limitReached) { throw 'The owned QA callback trace must be available before actual tray restoration.' }
        $trayReport.doubleClickEntryCountBefore = $trayRestoreBefore.doubleClickEntryCount
        Click-TrayOwnIcon $true
        $trayReport.actualDoubleClickSent = $true
        $trayRestoredWindow = Wait-TrayVisible $trayRestoreWindow
        if ($trayRestoredWindow -ne $trayRestoreWindow) { throw 'The exact owned main HWND changed during actual tray restoration.' }
        $trayRestoreDeadline = [DateTime]::UtcNow.AddSeconds(3)
        do {
            $trayRestoreAfter = Get-TrayDispatchDiagnostics
            if ($trayRestoreAfter.status -ceq 'available' -and $trayRestoreAfter.doubleClickEntryCount -gt $trayRestoreBefore.doubleClickEntryCount) { break }
            Start-Sleep -Milliseconds 50
        } while ([DateTime]::UtcNow -lt $trayRestoreDeadline)
        if ($trayRestoreAfter.status -cne 'available' -or $trayRestoreAfter.doubleClickEntryCount -le $trayRestoreBefore.doubleClickEntryCount) { throw 'The actual own tray double-click did not reach the product callback.' }
        $trayReport.doubleClickEntryCountAfter = $trayRestoreAfter.doubleClickEntryCount
        $trayReport.nativeStateAfter = [ordered]@{ hwnd = $trayRestoredWindow.ToInt64(); visible = [AEOwnedTray]::IsWindowVisible($trayRestoredWindow); minimized = [AEOwnedTray]::IsIconic($trayRestoredWindow) }
        $trayReport.healthAfter = Assert-TrayHealth
        $trayReport.restored = $trayReport.nativeStateAfter.visible -and -not $trayReport.nativeStateAfter.minimized
    } else {
    Hide-TrayOwnedSetup
    $trayDoubleClickWindow = Get-TrayOwnedWindow
    Click-TrayOwnIcon $true
    $null = Wait-TrayVisible $trayDoubleClickWindow
    Add-TrayGate 'actual-own-icon-double-click' 'passed' (Assert-TrayHealth)
    Hide-TrayOwnedSetup
    $trayMenuOpenWindow = Get-TrayOwnedWindow
    try {
        Invoke-TrayMenu '打开 AE Switch'
        $null = Wait-TrayVisible $trayMenuOpenWindow
        Add-TrayGate 'actual-own-menu-open' 'passed' (Assert-TrayHealth)
    } finally {
        $trayReport.menuDispatchDiagnostics = Get-TrayDispatchDiagnostics
    }

    Invoke-TrayMenu '退出应用…'
    $trayDialog = Wait-TrayExitDialog
    if ($trayDialog -ne [IntPtr]::Zero) {
        $trayCancelWindow = Get-TrayOwnedWindow
        Invoke-TrayDialogButton $trayDialog 2
        $null = Wait-TrayCancelReady $trayDialog $trayCancelWindow
        Add-TrayGate 'actual-owned-exit-cancel' 'passed' (Assert-TrayHealth)
        Invoke-TrayMenu '退出应用…'
        $trayDialog = Wait-TrayExitDialog
        if ($trayDialog -eq [IntPtr]::Zero) { throw 'The second owned exit unexpectedly omitted its confirmation.' }
        Invoke-TrayDialogButton $trayDialog 1
        $confirmationInput = $trayReport.dialogButtonDiagnostics[-1]
        Add-TrayGate 'actual-owned-exit-confirm-input' 'passed' @{ dialogTitle = '退出 AE Switch？'; nativeName = '确定'; selector = 'unique-native-and-uia-name-hwnd'; inputMethod = $confirmationInput.inputMethod; actualInputCompleted = $confirmationInput.actualInputCompleted; actualInvokeCompleted = $confirmationInput.actualInvokeCompleted }
    } else {
        Add-TrayGate 'actual-owned-exit-cancel' 'skipped' @{ reason = 'The application exited directly without a confirmation dialog; cancellation was not exercised.' }
        Add-TrayGate 'actual-owned-exit-confirm-input' 'skipped' @{ reason = 'Direct tray menu exit; no confirmation dialog was present.' }
    }
    $trayDeadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $trayProcess.Refresh()
        $trayGatewayListeners = @(Get-TrayListeners $trayPort)
        $trayCdpListeners = @(Get-TrayListeners 9223)
        if ($trayProcess.HasExited -and -not $trayGatewayListeners.Count -and -not $trayCdpListeners.Count) { break }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $trayDeadline)
    if (-not $trayProcess.HasExited -or $trayGatewayListeners.Count -or $trayCdpListeners.Count) { throw 'Owned exit did not stop the retained PID, gateway listener and CDP 9223.' }
    Add-TrayGate 'owned-exit-stops-process-and-ports' 'passed' @{ processExited = $true; gatewayPort = $trayPort; gatewayStopped = $true; cdpPort = 9223; cdpStopped = $true }
    $trayReport.passed = Test-TrayRequiredGates $trayReport.gates
    if (-not $trayReport.passed) { throw 'The tray suite requires all six exact product gates to pass; skipped cancellation or confirmation is incomplete.' }
    }
} catch {
    $trayError = $_.Exception.Message
    if ($trayToken) { $trayError = $trayError.Replace($trayToken, '<redacted>') }
    $trayReport.error = $trayError
} finally {
    # Capture pre-menu failures while the retained process and UUID log still
    # exist. A later failed read must not replace an available menu snapshot.
    if ($trayReportEligible -and ($null -eq $trayReport.menuDispatchDiagnostics -or $trayReport.menuDispatchDiagnostics.status -cne 'available')) {
        $trayFinalDispatchDiagnostics = Get-TrayDispatchDiagnostics
        if ($null -eq $trayReport.menuDispatchDiagnostics -or $trayFinalDispatchDiagnostics.status -ceq 'available') {
            $trayReport.menuDispatchDiagnostics = $trayFinalDispatchDiagnostics
        }
    }
    if ($trayOverflowStateSaved -and ('AEOwnedTray' -as [type])) {
        try {
            if ([AEOwnedTray]::OverflowVisible() -ne $trayOriginalOverflowVisible) { Invoke-TrayElement (Get-TrayChevron) }
            $trayOverflowDeadline = [DateTime]::UtcNow.AddSeconds(3)
            while ([AEOwnedTray]::OverflowVisible() -ne $trayOriginalOverflowVisible -and [DateTime]::UtcNow -lt $trayOverflowDeadline) { Start-Sleep -Milliseconds 100 }
            if ([AEOwnedTray]::OverflowVisible() -ne $trayOriginalOverflowVisible) { throw 'The shell overflow did not return to its original visibility.' }
            $trayReport.overflowRestored = $true
        }
        catch { $trayReport.overflowRestoreError = 'The exact shell overflow toggle could not be restored.'; $trayReport.passed = $false }
    }
    if ($trayCursorSaved) { try { [AEOwnedTray]::Cursor($trayOriginalCursor); $trayReport.cursorRestored = $true } catch { $trayReport.cursorRestored = $false; $trayReport.passed = $false } }
    if ($trayDpiSaved) {
        $trayRestoredDpi = [AEOwnedTray]::SetThreadDpiAwarenessContext($trayOriginalDpi)
        if ($RestoreOwnedOnly) { $trayReport.dpiContextRestored = $trayRestoredDpi -ne [IntPtr]::Zero }
    }
    if ($RestoreOwnedOnly -and ($trayReport.error -or $trayReport.overflowRestoreError -or $trayReport.cursorRestored -ne $true -or $trayReport.dpiContextRestored -ne $true)) { $trayReport.restored = $false }
    if ($null -ne $trayProcess) { $trayProcess.Dispose() }
    if ($trayReportEligible) {
        Assert-TrayAncestors ([IO.Path]::GetDirectoryName($trayReportPath))
        if ([IO.File]::Exists($trayReportPath) -or [IO.Directory]::Exists($trayReportPath)) { Assert-TrayOrdinary $trayReportPath $false }
        $trayJson = $trayReport | ConvertTo-Json -Depth 12
        if ($trayToken -and $trayJson.Contains($trayToken)) { throw 'Tray receipt secret redaction failed.' }
        [IO.File]::WriteAllText($trayReportPath, $trayJson, [Text.UTF8Encoding]::new($false))
    }
    $trayReport | ConvertTo-Json -Depth 12 -Compress
}
if ($RestoreOwnedOnly) { if (-not $trayReport.restored) { exit 1 } }
elseif (-not $trayReport.passed) { exit 1 }
