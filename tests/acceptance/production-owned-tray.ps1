[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$SetupFile,
    [Parameter(Mandatory)][string]$LaunchFile,
    [Parameter(Mandatory)][string]$ExpectedHelperSha256,
    [Parameter(Mandatory)][ValidateSet('Observe','DoubleClick','OpenMenu','CancelExit')][string]$Action
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
# No process termination, ShowWindow, notification callback injection, registry writes or config mutation.
# The shell rectangle is identified by the owned callback HWND/uID before any actual input.
function Get-TrayHash([string]$File) {
    $algorithm=[Security.Cryptography.SHA256]::Create()
    try { ([BitConverter]::ToString($algorithm.ComputeHash([IO.File]::ReadAllBytes($File)))).Replace('-','').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}
function Assert-TrayPath([string]$File,[string]$Boundary) {
    $full=[IO.Path]::GetFullPath($File); $base=[IO.Path]::GetFullPath($Boundary).TrimEnd('\','/')
    if ($full -notmatch '^[Gg]:[\\/]' -or (-not $full.Equals($base,[StringComparison]::OrdinalIgnoreCase) -and -not $full.StartsWith($base+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase))) { throw 'Tray path escaped its exact G boundary' }
    for($cursor=$full;$cursor;$cursor=[IO.Path]::GetDirectoryName($cursor)) {
        $entry=Get-Item -LiteralPath $cursor -Force
        if(($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or ($entry -is [IO.FileInfo] -and $entry.LinkType)) { throw 'Tray alias/reparse path refused' }
    }
    return $full
}
$trayWorkspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$setupFull=Assert-TrayPath $SetupFile (Join-Path $trayWorkspace '.cache/native-e2e-sandbox')
$setup=Get-Content -LiteralPath $setupFull -Raw -Encoding UTF8 | ConvertFrom-Json
if($setup.schemaVersion -ne 2 -or $setup.ownerId -cnotmatch '^[a-f0-9]{32}$' -or $setup.productionSha256 -cnotmatch '^[a-f0-9]{64}$' -or $setup.sourceDigest -cnotmatch '^[a-f0-9]{64}$' -or $setup.buildAuditId -cnotmatch '^[a-f0-9]{32}$') { throw 'Exact production setup identity required' }
$trayRoot=Join-Path $trayWorkspace ('.cache/native-e2e-sandbox/'+$setup.ownerId)
if($setup.workspace -ine $trayWorkspace -or $setup.root -ine $trayRoot -or $setupFull -ine (Join-Path $trayRoot 'setup.json')) { throw 'Exact production setup path required' }
if($setup.portableRoot -ine (Join-Path $trayRoot 'portable') -or $setup.productionProgram -ine (Join-Path $setup.portableRoot 'AE-Switch.exe')) { throw 'Exact owned portable production program required' }
$launchFull=Assert-TrayPath $LaunchFile $trayRoot
if($launchFull -ine (Join-Path $trayRoot 'production-launch-receipt.json')) { throw 'Exact retained launch receipt required' }
$launch=Get-Content -LiteralPath $launchFull -Raw -Encoding UTF8 | ConvertFrom-Json
$marker=Assert-TrayPath (Join-Path $trayRoot '.ae-production-ui-eight-owner.json') $trayRoot
$owner=Get-Content -LiteralPath $marker -Raw -Encoding UTF8 | ConvertFrom-Json
if($owner.schemaVersion -ne 2 -or $owner.workspace -ine $trayWorkspace) { throw 'Exact production owner marker required' }
foreach($field in @('ownerId','productionSha256','sourceDigest','buildAuditId')) { if($owner.$field -cne $setup.$field) { throw 'Production tray marker mismatch' } }
if($launch.ownerId -cne $setup.ownerId -or $launch.productionSha256 -cne $setup.productionSha256 -or $launch.productionProgram -ine $setup.productionProgram -or $launch.retainedHandleValidated -ne $true -or $launch.cdpListener.retainedDescendantValidated -ne $true) { throw 'Retained production launch binding required' }
foreach($record in @($setup,$launch)) { if($record.qaHooksUsed -ne $false -or $record.discoveryContextInjected -ne $false) { throw 'Production tray refuses QA or discovery hooks' } }
$trayExe=Assert-TrayPath $setup.productionProgram $trayRoot
if([IO.Path]::GetFileName($trayExe) -cne 'AE-Switch.exe' -or (Get-TrayHash $trayExe) -cne $setup.productionSha256) { throw 'Exact production executable hash required' }
if($ExpectedHelperSha256 -cnotmatch '^[a-f0-9]{64}$' -or (Get-TrayHash $PSCommandPath) -cne $ExpectedHelperSha256) { throw 'Exact tray helper hash required' }
$manifestFull=Assert-TrayPath $setup.sourceManifest $trayWorkspace
$manifest=Get-Content -LiteralPath $manifestFull -Raw -Encoding UTF8 | ConvertFrom-Json
if($manifest.digest -cne $setup.sourceDigest) { throw 'Current source manifest required' }
$sourceLines=[Text.StringBuilder]::new()
$sourceFiles=@()
foreach($row in $manifest.files) {
    $source=Assert-TrayPath (Join-Path $trayWorkspace $row.path) $trayWorkspace
    if((Get-TrayHash $source) -cne $row.sha256) { throw 'Current source manifest file changed' }
    $sourceFiles+=$source
    $null=$sourceLines.Append($row.path).Append([char]0).Append($row.sha256).Append([char]10)
}
$algorithm=[Security.Cryptography.SHA256]::Create()
try { $digest=([BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($sourceLines.ToString())))).Replace('-','').ToLowerInvariant() } finally { $algorithm.Dispose() }
if($digest -cne $setup.sourceDigest) { throw 'Source manifest digest mismatch' }
$lock=Assert-TrayPath (Join-Path $trayWorkspace 'app/src-tauri/Cargo.lock') $trayWorkspace
$lib=Assert-TrayPath (Join-Path $trayWorkspace 'app/src-tauri/src/lib.rs') $trayWorkspace
$lockText=[IO.File]::ReadAllText($lock)
$libText=[IO.File]::ReadAllText($lib)
if($lockText -notmatch '(?ms)\[\[package\]\]\r?\nname = "tray-icon"\r?\nversion = "0\.25\.1"\r?\nsource = "registry\+https://github\.com/rust-lang/crates\.io-index"\r?\nchecksum = "b2b9c52859a94554803ccd4a24b98f74148ebc73b90676d783f3490b1bff9d72"' -or ([regex]::Matches($libText,'TrayIconBuilder::new\(\)')).Count -ne 1 -or $libText.Contains('.with_guid(')) { throw 'Locked single production tray implementation required; never guess notification uID' }
$proofFiles=@($setupFull,$launchFull,$marker,$trayExe,$manifestFull,$lock,$lib,$PSCommandPath)+$sourceFiles
$proofHashes=@{}
foreach($file in $proofFiles) { $proofHashes[$file]=Get-TrayHash $file }
$OwnedProcessId=[int]$launch.pid
if($OwnedProcessId -le 0) { throw 'Positive retained PID required' }
$trayCreation=[DateTimeOffset]::Parse($launch.startedAt).UtcDateTime
$trayTooltip='AE Switch · Rust 接入服务'
$trayProcess=$null
$trayProofFreeze=$null
$trayCursorSaved=$false; $trayDpiSaved=$false; $trayOverflowStateSaved=$false
$trayReport=[ordered]@{ schemaVersion=1; ownerId=$setup.ownerId; pid=$OwnedProcessId; startedAt=$launch.startedAt; productionSha256=$setup.productionSha256; sourceDigest=$setup.sourceDigest; buildAuditId=$setup.buildAuditId; action=$Action; passed=$false; retainedHandleValidated=$false; processStopped=$false; actualExitConfirmed=$false; win32ShowWindowUsed=$false; callbackInjectionUsed=$false; qaHooksUsed=$false; iconInputs=@(); iconPreparationDiagnostics=@(); menuInputs=@(); menuLookupDiagnostics=@(); windowVisibilityDiagnostics=@(); dialogButtonDiagnostics=@(); helperSha256=$ExpectedHelperSha256; sourceInputsValidated=$true }
function New-TrayProofFreeze([string[]]$Files,[hashtable]$Hashes,[string]$Boundary) {
    $entries=[Collections.Generic.List[object]]::new()
    $paths=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $freeze=[pscustomobject]@{ Entries=$entries; Closed=$false }
    try {
        foreach($file in $Files) {
            $full=Assert-TrayPath $file $Boundary
            if(-not $paths.Add($full)) { continue }
            if(-not $Hashes.ContainsKey($full) -or $Hashes[$full] -cnotmatch '^[a-f0-9]{64}$') { throw 'A bound hash is required for every retained tray proof.' }
            $stream=[IO.FileStream]::new($full,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
            $entries.Add([pscustomobject]@{ Path=$full; Hash=$Hashes[$full]; Stream=$stream; Handle=$stream.SafeFileHandle })
            $null=Assert-TrayPath $full $Boundary
        }
        if($entries.Count -eq 0) { throw 'An exact nonempty retained tray proof set is required.' }
        $freeze.Entries=$entries.AsReadOnly()
        Assert-TrayProofFreezeHashes $freeze $Files $Hashes $Boundary
        return $freeze
    } catch { Close-TrayProofFreeze $freeze; throw }
}
function Assert-TrayProofFreeze($Freeze,[string[]]$Files) {
    if($null -eq $Freeze -or $Freeze.Closed) { throw 'Retained tray proof streams are not active.' }
    $paths=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach($file in $Files) { $null=$paths.Add([IO.Path]::GetFullPath($file)) }
    if($paths.Count -ne $Freeze.Entries.Count) { throw 'The fixed retained tray proof path set changed.' }
    foreach($entry in $Freeze.Entries) {
        if(-not $paths.Remove($entry.Path) -or -not $entry.Stream.CanRead -or $entry.Handle.IsClosed -or $entry.Handle.IsInvalid -or -not [object]::ReferenceEquals($entry.Handle,$entry.Stream.SafeFileHandle) -or $entry.Stream.Name -ine $entry.Path) { throw 'A fixed retained tray proof stream or path identity changed.' }
    }
    if($paths.Count -ne 0) { throw 'The fixed retained tray proof path set changed.' }
}
function Assert-TrayProofFreezeHashes($Freeze,[string[]]$Files,[hashtable]$Hashes,[string]$Boundary) {
    Assert-TrayProofFreeze $Freeze $Files
    foreach($entry in $Freeze.Entries) {
        $null=Assert-TrayPath $entry.Path $Boundary
        if(-not $Hashes.ContainsKey($entry.Path) -or $Hashes[$entry.Path] -cne $entry.Hash) { throw 'A fixed retained tray proof hash binding changed.' }
        $algorithm=[Security.Cryptography.SHA256]::Create()
        try {
            $entry.Stream.Position=0
            $actual=([BitConverter]::ToString($algorithm.ComputeHash($entry.Stream))).Replace('-','').ToLowerInvariant()
            if($actual -cne $entry.Hash) { throw 'Production tray retained proof bytes changed.' }
        } finally { $entry.Stream.Position=0; $algorithm.Dispose() }
    }
}
function Close-TrayProofFreeze($Freeze) {
    if($null -eq $Freeze -or $Freeze.Closed) { return }
    $failure=$null
    try { foreach($entry in $Freeze.Entries) { try { $entry.Stream.Dispose() } catch { if($null -eq $failure) { $failure=$_ } } } }
    finally { $Freeze.Closed=$true }
    if($null -ne $failure) { throw $failure }
}
function Assert-TrayProcess {
    if(-not [AEProductionOwnedTray]::Alive($script:trayProcess.Handle) -or [AEProductionOwnedTray]::StartedTicks($script:trayProcess.Handle) -ne $script:trayCreation.Ticks -or [AEProductionOwnedTray]::ProcessPath($script:trayProcess.Handle) -ine $script:trayExe) { throw 'Retained tray process handle, creation or image changed' }
    Assert-TrayProofFreeze $script:trayProofFreeze $script:proofFiles
}
function Get-TrayNotificationIdentity {
    Assert-TrayProcess
    $windows=@([AEProductionOwnedTray]::NotificationWindows($OwnedProcessId))
    if($windows.Count -ne 1 -or [AEProductionOwnedTray]::WindowProcessId($windows[0]) -ne $OwnedProcessId) { throw 'Unique retained PID tray_icon_app callback HWND required' }
    if($script:callbackHwnd -and $windows[0] -ne $script:callbackHwnd) { throw 'Exact notification callback HWND changed' }
    $script:callbackHwnd=$windows[0]
    return @{ hwnd=$windows[0].ToInt64(); pid=$OwnedProcessId; uid=2 }
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
    foreach ($handle in [AEProductionOwnedTray]::ShellWindows()) {
        if (-not [AEProductionOwnedTray]::IsWindowVisible($handle)) { continue }
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
    $owner = Get-TrayNotificationIdentity
    $rectangle = [AEProductionOwnedTray]::NotificationBounds([IntPtr]$owner.hwnd, 2)
    $cx = ([double]$rectangle.Left + $rectangle.Right) / 2
    $cy = ([double]$rectangle.Top + $rectangle.Bottom) / 2
    $matches = [Collections.Generic.List[object]]::new()
    foreach ($handle in [AEProductionOwnedTray]::ShellWindows()) {
        if (-not [AEProductionOwnedTray]::IsWindowVisible($handle)) { continue }
        $shell = [Windows.Automation.AutomationElement]::FromHandle($handle)
        $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Button)
        foreach ($icon in $shell.FindAll([Windows.Automation.TreeScope]::Descendants, $condition)) {
            $evidence = Get-TrayElementEvidence $icon
            if ($evidence.isOffscreen -or -not $evidence.isEnabled) { continue }
            $b = $evidence.bounds
            if ($b[2] -le 0 -or $b[3] -le 0 -or $cx -lt $b[0] -or $cx -ge ($b[0]+$b[2]) -or $cy -lt $b[1] -or $cy -ge ($b[1]+$b[3])) { continue }
            $matches.Add([pscustomobject]@{ element = $icon; shellHandle = $handle; shellProcessId = $shell.Current.ProcessId; evidence = $evidence })
        }
    }
    $script:trayReport.lastIconLookup = [ordered]@{ ownerPid=$OwnedProcessId; callbackHwnd=[string]$owner.hwnd; internalUid=2; guidNull=$true; identityMethod='retained-PID-callback-HWND-uID-Shell_NotifyIconGetRect'; exactVisibleMatches=$matches.Count; bounds=@($rectangle.Left,$rectangle.Top,$rectangle.Right,$rectangle.Bottom) }
    if ($matches.Count -gt 1) { throw 'Notification API rectangle intersects ambiguous visible shell buttons; no input allowed.' }
    if ($matches.Count -ne 1) { return $null }
    $candidate = $matches[0]
    $b = $candidate.evidence.bounds
    $x = $b[0]+$b[2]/2; $y = $b[1]+$b[3]/2
    $tooltipMatches = (Test-TrayTooltip $candidate.evidence.name) -or (Test-TrayTooltip $candidate.evidence.helpText)
    $script:trayReport.lastIconLookup.uiaBounds = @($b)
    $script:trayReport.lastIconLookup.tooltipMatches = $tooltipMatches
    $script:trayReport.lastIconLookup.uiaCenterInsideNotification = $x -ge $rectangle.Left -and $x -lt $rectangle.Right -and $y -ge $rectangle.Top -and $y -lt $rectangle.Bottom
    if (-not $tooltipMatches) {
        $script:trayReport.iconPreparationDiagnostics += @(@{stage='notification-lookup';reason='non-owned-tooltip';lookup=$script:trayReport.lastIconLookup})
        return $null
    }
    if (-not (Test-TrayIconReady $candidate.evidence) -or $x -lt $rectangle.Left -or $x -ge $rectangle.Right -or $y -lt $rectangle.Top -or $y -ge $rectangle.Bottom) { throw 'Exact API-owned icon and UIA tooltip/center disagree; no input allowed.' }
    $candidate.evidence.notificationOwnerHwnd = [long]$owner.hwnd
    $candidate.evidence.notificationUid = 2
    $candidate.evidence.notificationBounds = @($rectangle.Left,$rectangle.Top,$rectangle.Right,$rectangle.Bottom)
    $script:trayIconHost = $candidate
    return $candidate.element
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
            if (-not [AEProductionOwnedTray]::OverflowVisible()) {
                Invoke-TrayElement (Get-TrayChevron)
                $script:trayOverflowOpened = $true
            }
            $script:trayReport.overflowOpenedByDriver = $script:trayOverflowOpened
            $overflowChecked = $true
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    $script:trayReport.iconVisibilityAttempts = $attempts
    throw 'The unique own owned production icon could not be made visible.'
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
        if ($directHitRuntimeId -ceq ($shell.GetRuntimeId() -join ',') -and [AEProductionOwnedTray]::IsShellHit($x, $y, $script:trayIconHost.shellHandle, $script:trayIconHost.shellProcessId)) {
            $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Button)
            $buttonsAtPoint = @($shell.FindAll([Windows.Automation.TreeScope]::Descendants, $condition) | Where-Object { -not $_.Current.IsOffscreen -and $_.Current.BoundingRectangle.Contains($point) })
            if ($buttonsAtPoint.Count -eq 1 -and ($buttonsAtPoint[0].GetRuntimeId() -join ',') -ceq ($icon.GetRuntimeId() -join ',')) {
                $hitOwnIcon = $true
                $hitTestMethod = 'exact-owner-button-bounds-and-native-shell-hit'
            }
        }
    }
    if (-not $hitOwnIcon -or -not [AEProductionOwnedTray]::IsShellHit($x, $y, $script:trayIconHost.shellHandle, $script:trayIconHost.shellProcessId)) {
        if ($AllowNotReady) { return $null }
        throw 'The exact owned tray icon center is obscured; no mouse input was sent.'
    }
    return $hitTestMethod
}
function Get-TrayIconInputSample($icon) {
    if ($null -eq $icon) { return $null }
    $evidence = Get-TrayElementEvidence $icon
    if (-not (Test-TrayIconReady $evidence) -or @($evidence.runtimeId).Count -eq 0 -or $script:trayIconHost.shellHandle -eq [IntPtr]::Zero -or $script:trayIconHost.shellProcessId -le 0 -or $evidence.shellProcessId -ne $script:trayIconHost.shellProcessId) { return $null }
    foreach ($key in @('notificationOwnerHwnd','notificationUid','notificationBounds')) { $evidence[$key] = $script:trayIconHost.evidence[$key] }
    return [ordered]@{ icon = $evidence; shellHandle = $script:trayIconHost.shellHandle.ToInt64(); shellProcessId = $script:trayIconHost.shellProcessId }
}
function Test-TraySameIconLayout($first, $second) {
    if ($null -eq $first -or $null -eq $second) { return $false }
    return $first.icon.notificationOwnerHwnd -eq $second.icon.notificationOwnerHwnd -and $first.icon.notificationUid -eq 2 -and $second.icon.notificationUid -eq 2 -and ($first.icon.notificationBounds -join ',') -ceq ($second.icon.notificationBounds -join ',') -and $first.shellHandle -eq $second.shellHandle -and $first.shellProcessId -eq $second.shellProcessId -and ($first.icon.runtimeId -join ',') -ceq ($second.icon.runtimeId -join ',') -and ($first.icon.bounds -join ',') -ceq ($second.icon.bounds -join ',')
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
            [AEProductionOwnedTray]::MoveTrayCursor($x, $y)
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
            $cursor = [AEProductionOwnedTray]::Cursor()
            $diagnostic.afterMove = $fresh
            $diagnostic.cursorAfterMove = @($cursor.X, $cursor.Y)
            $diagnostic.foregroundProcessIdAfterMove = [AEProductionOwnedTray]::ForegroundProcessId()
            if ((Test-TraySameIconLayout $sample $fresh) -and $cursor.X -eq $x -and $cursor.Y -eq $y -and $hitTestMethod -and [DateTime]::UtcNow -lt $deadline) {
                Assert-TrayProcess
                if ([DateTime]::UtcNow -ge $deadline) { break }
                $diagnostic.phase = 'actual-input'
                $input = [ordered]@{ doubleClick = $doubleClick; center = @($x, $y); exactOwnerHitTest = $true; hitTestMethod = $hitTestMethod; icon = $fresh.icon; shellHandle = $fresh.shellHandle; shellProcessId = $fresh.shellProcessId; stableSamples = $stableSamples; cursorBeforeInput = @($cursor.X, $cursor.Y); buttonPairsCompleted = 0; actualInputCompleted = $false }
                $script:trayReport.iconInputs += $input
                # The native method observes again and sends only button events;
                # it cannot move away from the freshly checked exact target.
                $revalidateTarget = [Action]{
                    Assert-TrayProcess
                    if ([DateTime]::UtcNow -ge $deadline) { throw 'The retained owned tray input deadline elapsed before its next button pair.' }
                    $buttonIcon = Get-TrayOwnIcon
                    $buttonSample = Get-TrayIconInputSample $buttonIcon
                    if (-not (Test-TraySameIconLayout $fresh $buttonSample)) { throw 'The exact owned owned production tray icon identity or layout changed before its next button pair.' }
                    $null = Get-TrayIconHitMethod $buttonIcon $x $y
                    Assert-TrayProcess
                    if ([DateTime]::UtcNow -ge $deadline) { throw 'The retained owned tray input deadline elapsed during its fresh button-pair observations.' }
                }
                $buttonReceipt = [AEProductionOwnedTray+TrayIconInputReceipt]::new()
                try { [AEProductionOwnedTray]::ClickTrayIconAtCursor($x, $y, $doubleClick, [IntPtr]$fresh.shellHandle, $fresh.shellProcessId, $revalidateTarget, $buttonReceipt) }
                finally {
                    foreach($target in @($input,$diagnostic)) {
                        $target.buttonPairsCompleted = $buttonReceipt.ButtonPairsCompleted
                        $target.doubleClickLimitMs = $buttonReceipt.DoubleClickLimitMs
                        $target.pairIntervalMs = $buttonReceipt.PairIntervalMs
                        $target.validationDurationMs = $buttonReceipt.ValidationDurationMs
                        $target.inputElapsedMs = $buttonReceipt.InputElapsedMs
                        $target.doubleClickDeadlineExceeded = $buttonReceipt.DoubleClickDeadlineExceeded
                    }
                }
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
    throw 'The unique own owned production icon did not retain stable layout, exact cursor and native hit before the deadline; no button input was sent.'
}
function Get-TrayOwnedWindow {
    Assert-TrayProcess
    return [AEProductionOwnedTray]::OwnedWindow($OwnedProcessId, 'AE Switch', 'Tauri Window')
}
function Wait-TrayVisible([IntPtr]$expectedWindow = (Get-TrayOwnedWindow)) {
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $diagnostic = [ordered]@{ startedAtUtc = [DateTime]::UtcNow.ToString('o'); expectedMainHwnd = $expectedWindow.ToInt64(); budgetMs = 5000; status = 'waiting'; sampleCount = 0; samplesTruncated = $false; samples = @(); elapsedMs = 0 }
    $script:trayReport.windowVisibilityDiagnostics += $diagnostic
    try {
        do {
            $window = Get-TrayOwnedWindow
            $sample = [ordered]@{ observedAtUtc = [DateTime]::UtcNow.ToString('o'); elapsedMs = $clock.ElapsedMilliseconds; hwnd = $window.ToInt64(); visible = [AEProductionOwnedTray]::IsWindowVisible($window); iconic = [AEProductionOwnedTray]::IsIconic($window); enabled = [AEProductionOwnedTray]::IsWindowEnabled($window) }
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
        $dialogs = @([AEProductionOwnedTray]::OwnedDialogs($OwnedProcessId, '退出 AE Switch？'))
        if ($dialogs.Count -gt 1) { throw 'The exact owned exit dialog is ambiguous after cancellation.' }
        $diagnostic.attempts++
        $diagnostic.ownedDialogCount = $dialogs.Count
        $diagnostic.cancelledDialogVisible = [AEProductionOwnedTray]::IsOwnedVisible($dialog, $OwnedProcessId)
        $diagnostic.mainVisible = [AEProductionOwnedTray]::IsWindowVisible($window)
        $diagnostic.mainMinimized = [AEProductionOwnedTray]::IsIconic($window)
        $diagnostic.mainEnabled = [AEProductionOwnedTray]::IsWindowEnabled($window)
        $diagnostic.foregroundProcessId = [AEProductionOwnedTray]::ForegroundProcessId()
        if ($dialogs.Count -eq 0 -and -not $diagnostic.cancelledDialogVisible -and $diagnostic.mainVisible -and -not $diagnostic.mainMinimized -and $diagnostic.mainEnabled -and [DateTime]::UtcNow -lt $deadline) {
            $diagnostic.ready = $true
            return $window
        }
        Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'The cancelled owned exit dialog did not disappear with its retained main window visible, restored and enabled before the deadline.'
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
        $handles = @([AEProductionOwnedTray]::OwnedMenus($OwnedProcessId))
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
        $cursor = [AEProductionOwnedTray]::Cursor()
        $lookup.cursor = @($cursor.X, $cursor.Y)
        $lookup.foregroundProcessId = [AEProductionOwnedTray]::ForegroundProcessId()
        if ($handles.Count -eq 0) { $lookup.zeroPopupAttempts++ }
        if ($handles.Count -gt 1) { throw 'More than one owned native tray menu is visible.' }
        if ($handles.Count -eq 1) {
            $snapshot = [AEProductionOwnedTray]::ReadOwnedPopupMenu($handles[0], $OwnedProcessId)
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
                $selected = [AEProductionOwnedTray]::SelectOwnedMenuItem($snapshot, $name, $OwnedProcessId)
                Assert-TrayProcess
                $trayMenuReceipt = [AEProductionOwnedTray]::ClickOwnedMenuItem($snapshot, $selected, $OwnedProcessId, [Action]{ Assert-TrayProcess })
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
        $handles = @([AEProductionOwnedTray]::OwnedDialogs($OwnedProcessId, '退出 AE Switch？'))
        if ($handles.Count -gt 1) { throw 'The exact owned exit dialog is ambiguous.' }
        if ($handles.Count -eq 1) { return $handles[0] }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'The owned process neither exited nor showed its exact exit confirmation.'
}
function Select-TrayDialogButtonIdentity([object[]]$candidates, [string]$name, [int]$processId) {
    if ($name -cne '取消' -or $candidates.Count -gt 16) { throw 'Only an exact owned cancellation button is permitted.' }
    $matches = @($candidates | Where-Object { $_.name -ceq $name })
    if ($matches.Count -ne 1) { throw 'The exact owned UIA dialog button name is missing or ambiguous.' }
    $selected = $matches[0]
    $representationMatches = ($selected.className -ceq 'Button' -and $selected.controlType -ceq 'ControlType.Button') -or ($selected.className -ceq 'CCPushButton' -and $selected.controlType -ceq 'ControlType.Pane')
    if ($selected.nativeHwnd -le 0 -or $selected.shellProcessId -ne $processId -or -not $representationMatches -or $selected.isOffscreen -ne $false -or $selected.isEnabled -ne $true -or $selected.automationId -isnot [string]) { throw 'The exact owned UIA button HWND, process, class, type or readiness was rejected.' }
    return $selected
}
function Invoke-TrayDialogButton([IntPtr]$handle, [int]$buttonId) {
    if ($buttonId -ne 2) { throw 'Only the owned cancellation action is permitted.' }
    $buttonName = if ($buttonId -eq 1) { '确定' } else { '取消' }
    Assert-TrayProcess
    if (-not [AEProductionOwnedTray]::IsOwnedVisible($handle, $OwnedProcessId)) { throw 'The retained owned dialog is no longer visible.' }
    $dialog = [Windows.Automation.AutomationElement]::FromHandle($handle)
    if ($dialog.Current.Name -cne '退出 AE Switch？' -or $dialog.Current.ProcessId -ne $OwnedProcessId) { throw 'Exit dialog title/process identity mismatch.' }
    $diagnostic = [ordered]@{ dialogHwnd = $handle.ToInt64(); requestedName = $buttonName; selector = 'unique-native-and-uia-name-hwnd'; phase = 'native-read'; nativeCandidates = @(); uiaCandidates = @(); actualInputCompleted = $false; actualInvokeCompleted = $false }
    $script:trayReport.dialogButtonDiagnostics += $diagnostic
    $snapshot = [AEProductionOwnedTray]::ReadOwnedDialog($handle, $OwnedProcessId)
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
    $button = [AEProductionOwnedTray]::SelectOwnedDialogButton($snapshot, $buttonName, [IntPtr][long]$identity.nativeHwnd, $OwnedProcessId)
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
    $current = [AEProductionOwnedTray]::SelectOwnedDialogButton([AEProductionOwnedTray]::ReadOwnedDialog($handle, $OwnedProcessId), $buttonName, $button.Window, $OwnedProcessId)
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
        $point = [AEProductionOwnedTray]::ClickOwnedDialogButton($snapshot, $current, $OwnedProcessId, [Action]{ Assert-TrayProcess })
        $diagnostic.center = @($point.X, $point.Y)
    }
    $diagnostic.actualInputCompleted = $true
    $diagnostic.phase = 'input-completed'
}
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class AEProductionOwnedTray {
    public delegate bool Callback(IntPtr h, IntPtr p);
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct MenuBarInfo { public uint Size; public Rect Bounds; public IntPtr Menu, MenuWindow; public uint FocusFlags; }
    public sealed class NativeMenuItem { public string Name; public int Position; public uint State; public Rect Bounds; public bool BoundsReady; }
    public sealed class NativeMenuSnapshot { public IntPtr Window, Menu; public int ProcessId; public string ClassName; public bool Visible, Ready; public NativeMenuItem[] Items; }
    public sealed class NativeDialogButton { public IntPtr Window, Root, HitWindow, HitRoot; public int ControlId, ProcessId, HitProcessId; public string Name, ClassName; public bool Visible, Enabled, BoundsReady; public Rect Bounds; }
    public sealed class NativeDialogSnapshot { public IntPtr Window, Root; public int ProcessId, DialogCount; public string Name, ClassName; public bool Visible, Enabled; public NativeDialogButton[] Buttons; }
    public sealed class TrayIconInputReceipt { public int ButtonPairsCompleted; public uint DoubleClickLimitMs; public long PairIntervalMs=-1,ValidationDurationMs,InputElapsedMs; public bool DoubleClickDeadlineExceeded; }
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
    [DllImport("user32.dll", SetLastError=true)] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll", SetLastError=true)] static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern uint GetDoubleClickTime();
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
        if(name!="取消") throw new Exception("Only the exact owned cancellation name is permitted.");
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
    public static Point ClickOwnedDialogButton(NativeDialogSnapshot expected,NativeDialogButton button,int pid,Action revalidate) {
        if(expected==null || button==null) throw new Exception("An exact retained owned dialog and button are required.");
        if(revalidate==null) throw new ArgumentException("Fresh retained process observation required");
        revalidate();
        SelectOwnedDialogButton(expected,button.Name,button.Window,pid);
        var current=SelectOwnedDialogButton(ReadOwnedDialog(expected.Window,pid),button.Name,button.Window,pid);
        if(current.Bounds.Left!=button.Bounds.Left || current.Bounds.Top!=button.Bounds.Top || current.Bounds.Right!=button.Bounds.Right || current.Bounds.Bottom!=button.Bounds.Bottom) throw new Exception("The owned dialog button bounds changed before mouse movement.");
        int x=(int)((long)current.Bounds.Left+((long)current.Bounds.Right-current.Bounds.Left)/2),y=(int)((long)current.Bounds.Top+((long)current.Bounds.Bottom-current.Bounds.Top)/2);
        MoveOwnedMenuCursor(x,y);
        current=SelectOwnedDialogButton(ReadOwnedDialog(expected.Window,pid),button.Name,button.Window,pid);
        var cursor=Cursor();
        if(current.Bounds.Left!=button.Bounds.Left || current.Bounds.Top!=button.Bounds.Top || current.Bounds.Right!=button.Bounds.Right || current.Bounds.Bottom!=button.Bounds.Bottom || cursor.X!=x || cursor.Y!=y) throw new Exception("The exact owned dialog button or cursor changed before left input.");
        revalidate(); Send(0x0002,0x0004);
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
    public static NativeMenuInputReceipt ClickOwnedMenuItem(NativeMenuSnapshot expected,NativeMenuItem item,int pid,Action revalidate) {
        if(revalidate==null) throw new ArgumentException("Fresh retained process observation required");
        var receipt=new NativeMenuInputReceipt{Phase="identity"};
        try {
            revalidate(); var actual=RecheckOwnedMenuItem(expected,item,pid);
            receipt.X=(int)((long)actual.Bounds.Left+((long)actual.Bounds.Right-actual.Bounds.Left)/2); receipt.Y=(int)((long)actual.Bounds.Top+((long)actual.Bounds.Bottom-actual.Bounds.Top)/2);
            receipt.StateBeforeHover=actual.State; receipt.ForegroundProcessIdBeforeHover=ForegroundProcessId();
            receipt.Phase="move"; MoveOwnedMenuCursor(receipt.X,receipt.Y); receipt.MoveSent=true;
            receipt.Phase="hover"; var hover=System.Diagnostics.Stopwatch.StartNew();
            do {
                revalidate(); receipt.HoverAttempts++; actual=RecheckOwnedMenuItem(expected,item,pid);
                receipt.StateBeforeClick=actual.State; var cursor=Cursor();
                if(cursor.X==receipt.X && cursor.Y==receipt.Y && (actual.State & 0x80u)!=0) { receipt.Highlighted=true; break; }
                Thread.Sleep(25);
            } while(hover.ElapsedMilliseconds<1000);
            receipt.HoverDurationMs=(int)hover.ElapsedMilliseconds;
            if(!receipt.Highlighted) { receipt.Failure="hover-not-highlighted"; return receipt; }
            receipt.Phase="click"; actual=RecheckOwnedMenuItem(expected,item,pid); var beforeClick=Cursor();
            receipt.StateBeforeClick=actual.State;
            if(beforeClick.X!=receipt.X || beforeClick.Y!=receipt.Y || (actual.State & 0x80u)==0) { receipt.Failure="hover-changed-before-click"; return receipt; }
            revalidate(); receipt.ForegroundProcessIdBeforeClick=ForegroundProcessId(); Send(0x0002,0x0004); receipt.ClickSent=true;
            receipt.Phase="dismiss"; var dismiss=System.Diagnostics.Stopwatch.StartNew();
            while(IsWindowVisible(expected.Window) && dismiss.ElapsedMilliseconds<1000) Thread.Sleep(25);
            receipt.MenuDismissed=!IsWindowVisible(expected.Window); receipt.ForegroundProcessIdAfterClick=ForegroundProcessId();
            receipt.Failure=receipt.MenuDismissed ? null : "menu-not-dismissed"; return receipt;
        } catch(Win32Exception failure) { receipt.NativeErrorCode=failure.NativeErrorCode; receipt.Failure=receipt.Phase+"-win32-error"; return receipt; }
        catch { receipt.Failure=receipt.Phase+"-ownership-or-readiness-rejected"; return receipt; }
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
    public static void SendTrayIconButtonPairsAtCursor(int x,int y,bool twice,Action revalidate,Func<Point> readCursor,Func<bool> nativeHit,Action sendPair,Action betweenPairs,Func<long> readMilliseconds,uint doubleClickLimitMs,TrayIconInputReceipt receipt) {
        if(revalidate==null || readCursor==null || nativeHit==null || sendPair==null || betweenPairs==null || readMilliseconds==null || receipt==null || receipt.ButtonPairsCompleted!=0 || doubleClickLimitMs==0) throw new ArgumentException("Every exact owned tray button-pair observation, clock, OS interval and fresh input receipt is required.");
        long started=readMilliseconds(),firstPair=-1;
        receipt.DoubleClickLimitMs=doubleClickLimitMs;
        try {
            int pairs=twice?2:1;
            for(int pair=0;pair<pairs;pair++) {
                if(pair>0) betweenPairs();
                long validationStarted=readMilliseconds();
                try {
                    revalidate();
                    var cursor=readCursor();
                    if(cursor.X!=x || cursor.Y!=y || !nativeHit()) throw new Exception("The exact owned tray cursor or native shell hit changed before button input.");
                } finally {
                    long observed=readMilliseconds();
                    receipt.ValidationDurationMs+=observed-validationStarted;
                    if(pair>0) receipt.PairIntervalMs=observed-firstPair;
                }
                long beforePair=readMilliseconds();
                if(pair>0) {
                    receipt.PairIntervalMs=beforePair-firstPair;
                    if(receipt.PairIntervalMs>=doubleClickLimitMs) {
                        receipt.DoubleClickDeadlineExceeded=true;
                        throw new Exception("Fresh owned tray observations exceeded the Windows double-click interval; no second button pair was sent.");
                    }
                } else { firstPair=beforePair; }
                sendPair();
                receipt.ButtonPairsCompleted++;
            }
        } finally { receipt.InputElapsedMs=readMilliseconds()-started; }
    }
    public static void ClickTrayIconAtCursor(int x,int y,bool twice,IntPtr host,int shellPid,Action revalidate,TrayIconInputReceipt receipt) {
        if(receipt==null || receipt.ButtonPairsCompleted!=0) throw new ArgumentException("A fresh owned tray button receipt is required.");
        var clock=System.Diagnostics.Stopwatch.StartNew();
        SendTrayIconButtonPairsAtCursor(x,y,twice,revalidate,Cursor,()=>IsShellHit(x,y,host,shellPid),()=> { if(twice) Send(0x0002,0x0004); else Send(0x0008,0x0010); },()=>Thread.Sleep(60),()=>clock.ElapsedMilliseconds,GetDoubleClickTime(),receipt);
    }

    [StructLayout(LayoutKind.Sequential)] public struct NotifyIdentifier { public uint Size; public IntPtr Window; public uint Id; public Guid GuidItem; }
    [DllImport("shell32.dll", ExactSpelling=true)] static extern int Shell_NotifyIconGetRect(ref NotifyIdentifier identity,out Rect bounds);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long creation,out long exit,out long kernel,out long user);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    public static long StartedTicks(IntPtr process) { long a,b,c,d; if(!GetProcessTimes(process,out a,out b,out c,out d)) throw new Win32Exception(Marshal.GetLastWin32Error()); return DateTime.FromFileTimeUtc(a).Ticks; }
    public static bool Alive(IntPtr process) { uint code; if(!GetExitCodeProcess(process,out code)) throw new Win32Exception(Marshal.GetLastWin32Error()); return code==259; }
    public static int WindowProcessId(IntPtr hwnd) { uint pid; GetWindowThreadProcessId(hwnd,out pid); return (int)pid; }
    public static IntPtr[] NotificationWindows(int pid) { return Find(pid,null,"tray_icon_app",false,false); }
    public static Rect NotificationBounds(IntPtr hwnd,uint id) {
        if(hwnd==IntPtr.Zero || Text(hwnd,true)!="tray_icon_app" || id!=2) throw new Exception("Exact production tray callback HWND and locked internal uID required");
        var identity=new NotifyIdentifier{Size=(uint)Marshal.SizeOf(typeof(NotifyIdentifier)),Window=hwnd,Id=id,GuidItem=Guid.Empty}; Rect bounds;
        int result=Shell_NotifyIconGetRect(ref identity,out bounds);
        if(result!=0 || bounds.Right<=bounds.Left || bounds.Bottom<=bounds.Top) throw new Exception("Exact owned notification rectangle unavailable; no input allowed");
        return bounds;
    }
}

'@

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
try {
    if($Action -eq 'CancelExit') {
        $selection=Assert-TrayPath (Join-Path $setup.portableRoot 'data/agent-selection.json') $trayRoot
        $selectionHash=Get-TrayHash $selection
        $proofFiles+=@($selection)
        $proofHashes[$selection]=$selectionHash
    }
    $trayProcess=[Diagnostics.Process]::GetProcessById($OwnedProcessId)
    $null=$trayProcess.Handle
    $trayProofFreeze=New-TrayProofFreeze $proofFiles $proofHashes $trayWorkspace
    Assert-TrayProcess
    $trayReport.retainedHandleValidated=$true
    $identity=Get-TrayNotificationIdentity
    $trayReport.notificationIdentity=$identity
    $window=Get-TrayOwnedWindow
    $trayReport.before=@{ hwnd=$window.ToInt64().ToString(); visible=[AEProductionOwnedTray]::IsWindowVisible($window); minimized=[AEProductionOwnedTray]::IsIconic($window); enabled=[AEProductionOwnedTray]::IsWindowEnabled($window) }
    if($Action -ne 'Observe') {
        $trayOriginalCursor=[AEProductionOwnedTray]::Cursor(); $trayCursorSaved=$true
        $trayOriginalDpi=[AEProductionOwnedTray]::SetThreadDpiAwarenessContext([IntPtr](-4))
        if($trayOriginalDpi -eq [IntPtr]::Zero) { throw 'Physical DPI context required' }
        $trayDpiSaved=$true
        $trayOriginalOverflowVisible=[AEProductionOwnedTray]::OverflowVisible(); $trayOverflowStateSaved=$true
        if($Action -eq 'DoubleClick' -or $Action -eq 'OpenMenu') {
            if($trayReport.before.visible) { throw 'Actual close-to-background must leave the retained main HWND hidden before tray restoration' }
            if($Action -eq 'DoubleClick') { Click-TrayOwnIcon $true } else { Invoke-TrayMenu '打开 AE Switch' }
            $null=Wait-TrayVisible $window
        } elseif($Action -eq 'CancelExit') {
            # bridge_required() returns true for this exact ordinary selection file.
            # In a fresh store the menu exits immediately, so never click it without this guard.
            if(-not $trayReport.before.visible -or -not $trayReport.before.enabled) { throw 'Visible enabled owned main window required before exit-cancel' }
            Assert-TrayProcess
            Invoke-TrayMenu '退出应用…'
            $dialog=Wait-TrayExitDialog
            if($dialog -eq [IntPtr]::Zero) { throw 'Owned process exited unexpectedly instead of showing cancellation dialog' }
            $trayReport.exitDialogHwnd=$dialog.ToInt64().ToString()
            $trayReport.exitDialogObserved=$true
            Invoke-TrayDialogButton $dialog 2
            $null=Wait-TrayCancelReady $dialog $window
            $trayReport.exitCancelled=$true
        }
    }
    Assert-TrayProcess
    if((Get-TrayOwnedWindow) -ne $window) { throw 'Main HWND changed during real tray input' }
    $trayReport.after=@{ hwnd=$window.ToInt64().ToString(); visible=[AEProductionOwnedTray]::IsWindowVisible($window); minimized=[AEProductionOwnedTray]::IsIconic($window); enabled=[AEProductionOwnedTray]::IsWindowEnabled($window) }
    $trayReport.passed=$true
} catch { $trayReport.error=$_.Exception.Message }
finally {
    if($trayOverflowStateSaved) {
        try {
            if([AEProductionOwnedTray]::OverflowVisible() -ne $trayOriginalOverflowVisible) { Assert-TrayProcess; Invoke-TrayElement (Get-TrayChevron) }
            $deadline=[DateTime]::UtcNow.AddSeconds(3)
            while([AEProductionOwnedTray]::OverflowVisible() -ne $trayOriginalOverflowVisible -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
            if([AEProductionOwnedTray]::OverflowVisible() -ne $trayOriginalOverflowVisible) { throw 'Shell overflow original visibility could not be restored' }
            $trayReport.overflowRestored=$true
        } catch { $trayReport.overflowRestoreError=$_.Exception.Message; $trayReport.passed=$false }
    }
    if($trayCursorSaved) { try { [AEProductionOwnedTray]::Cursor($trayOriginalCursor); $trayReport.cursorRestored=$true } catch { $trayReport.cursorRestored=$false; $trayReport.passed=$false } }
    if($trayDpiSaved) { $trayReport.dpiContextRestored=[AEProductionOwnedTray]::SetThreadDpiAwarenessContext($trayOriginalDpi) -ne [IntPtr]::Zero; if(-not $trayReport.dpiContextRestored) { $trayReport.passed=$false } }
    if($null -ne $trayProofFreeze) {
        try { Assert-TrayProofFreezeHashes $trayProofFreeze $proofFiles $proofHashes $trayWorkspace; $trayReport.sourceProofHashesRevalidated=$true }
        catch { $trayReport.sourceProofHashesRevalidated=$false; $trayReport.sourceProofRevalidationError=$_.Exception.Message; $trayReport.passed=$false }
        finally { try { Close-TrayProofFreeze $trayProofFreeze } catch { $trayReport.sourceProofReleaseError=$_.Exception.Message; $trayReport.passed=$false } }
    }
    if($null -ne $trayProcess) { $trayProcess.Dispose() }
    $trayReport.recordedAt=[DateTimeOffset]::UtcNow.ToString('o')
    $trayReport | ConvertTo-Json -Depth 15 -Compress
}
if(-not $trayReport.passed) { exit 1 }
