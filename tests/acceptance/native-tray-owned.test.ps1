[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../scripts/workspace-env.ps1')
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

# Parse only selected functions. Never execute the driver, ownership setup,
# UIAutomation, HTTP, physical input, or any native P/Invoke in this harness.
$driverPath = Join-Path $PSScriptRoot 'native-tray-owned.ps1'
$source = [IO.File]::ReadAllText($driverPath, [Text.Encoding]::UTF8)
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'The owned tray driver must parse without errors.' }
$typeCommand = $ast.Find({ param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Add-Type' -and $node.CommandElements.Count -ge 3 -and $node.CommandElements[1].Extent.Text -eq '-TypeDefinition' }, $true)
if ($null -eq $typeCommand) { throw 'The exact tray native type definition is required.' }
$native = $typeCommand.CommandElements[2].Value
$compiledNative = $native.Replace('public static class AEOwnedTray {', 'public static class AEOwnedTraySyntaxOnly {')
Add-Type -TypeDefinition ($compiledNative + @'

namespace Windows.Automation { public class ElementNotAvailableException : System.Exception { } }
public static class AEOwnedTray {
    public struct Point { public int X,Y; }
    public sealed class TrayIconInputReceipt { public int ButtonPairsCompleted; }
    public static int Moves,Clicks,DoubleClicks,ButtonPairs,MenuClicks,MenuReads,StopMenusAfter,DialogReads,ReadyAfter,Foreground;
    public static bool CursorMismatch,NativeHit,WindowEnabled,WindowVisible,WindowMinimized,DialogVisible;
    public static Point CurrentCursor;
    public static int[] PopupCounts=new int[0];
    public static AEOwnedTraySyntaxOnly.NativeMenuSnapshot Popup;
    public static void Reset() {
        Moves=Clicks=DoubleClicks=ButtonPairs=MenuClicks=MenuReads=DialogReads=0; StopMenusAfter=3; ReadyAfter=0; Foreground=42;
        CursorMismatch=false; NativeHit=true; WindowEnabled=WindowVisible=true; WindowMinimized=DialogVisible=false;
        CurrentCursor=new Point(); PopupCounts=new int[0]; Popup=null;
    }
    public static void MoveTrayCursor(int x,int y) { Moves++; CurrentCursor=new Point{X=CursorMismatch?x+1:x,Y=y}; }
    public static Point Cursor() { return CurrentCursor; }
    public static int ForegroundProcessId() { return Foreground; }
    public static bool IsShellHit(int x,int y,System.IntPtr host,int pid) { return NativeHit; }
    public static void ClickTrayIconAtCursor(int x,int y,bool twice,System.IntPtr host,int shellPid,System.Action revalidate,TrayIconInputReceipt receipt) {
        AEOwnedTraySyntaxOnly.SendTrayIconButtonPairsAtCursor(x,y,twice,revalidate,()=>new AEOwnedTraySyntaxOnly.Point{X=CurrentCursor.X,Y=CurrentCursor.Y},()=>NativeHit,()=>{ButtonPairs++; receipt.ButtonPairsCompleted++;},()=>{});
        if(twice) DoubleClicks++; else Clicks++;
    }
    // The legacy fake exists only to expose the baseline's missing movement
    // observation and layout checks without ever sending real input.
    public static void Click(int x,int y,bool twice) { if(twice) DoubleClicks++; else Clicks++; }
    public static System.IntPtr[] OwnedMenus(int pid) {
        MenuReads++;
        if(MenuReads>StopMenusAfter) throw new System.Exception("offline-poll-stop");
        int count=PopupCounts.Length==0?0:PopupCounts[System.Math.Min(MenuReads-1,PopupCounts.Length-1)];
        var result=new System.IntPtr[count]; for(int i=0;i<count;i++) result[i]=new System.IntPtr(900+i); return result;
    }
    public static AEOwnedTraySyntaxOnly.NativeMenuSnapshot ReadOwnedPopupMenu(System.IntPtr h,int pid) { return Popup; }
    public static AEOwnedTraySyntaxOnly.NativeMenuItem SelectOwnedMenuItem(AEOwnedTraySyntaxOnly.NativeMenuSnapshot s,string name,int pid) { return AEOwnedTraySyntaxOnly.SelectOwnedMenuItem(s,name,pid); }
    public static AEOwnedTraySyntaxOnly.NativeMenuInputReceipt ClickOwnedMenuItem(AEOwnedTraySyntaxOnly.NativeMenuSnapshot s,AEOwnedTraySyntaxOnly.NativeMenuItem item,int pid) {
        MenuClicks++; return new AEOwnedTraySyntaxOnly.NativeMenuInputReceipt{ClickSent=true,Highlighted=true,MenuDismissed=true,MoveSent=true};
    }
    public static System.IntPtr[] OwnedDialogs(int pid,string name) { DialogReads++; return DialogVisible && DialogReads<=ReadyAfter?new[]{new System.IntPtr(456)}:new System.IntPtr[0]; }
    public static bool IsOwnedVisible(System.IntPtr h,int pid) { return DialogVisible && DialogReads<=ReadyAfter; }
    public static bool IsWindowEnabled(System.IntPtr h) { return WindowEnabled && DialogReads>ReadyAfter; }
    public static bool IsWindowVisible(System.IntPtr h) { return WindowVisible; }
    public static bool IsIconic(System.IntPtr h) { return WindowMinimized; }
}
'@)

$functionNames = @('Test-TrayTooltip', 'Test-TrayIconReady', 'Get-TrayIconInputSample', 'Test-TraySameIconLayout', 'Click-TrayOwnIcon', 'Invoke-TrayMenu', 'Wait-TrayVisible', 'Wait-TrayCancelReady', 'Test-TrayRequiredGates')
foreach ($name in $functionNames) {
    $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name }, $true)
    if ($null -ne $definition) { Invoke-Expression $definition.Extent.Text }
}
$OwnedProcessId = 42
$script:trayTooltip = 'AE Switch QA · 0123456789abcdef0123456789abcdef'
$script:results = [Collections.Generic.List[object]]::new()
function Check([bool]$value, [string]$message) { if (-not $value) { throw $message } }
function Case([string]$name, [scriptblock]$body) {
    try { & $body; $script:results.Add([ordered]@{ name = $name; passed = $true }) }
    catch { $script:results.Add([ordered]@{ name = $name; passed = $false; error = $_.Exception.Message }) }
}
function Expect-Throw([scriptblock]$body, [string]$message) {
    $thrown = $false
    try { & $body } catch { $thrown = $true }
    Check $thrown $message
}
function New-Icon([int]$top = 898) {
    return [pscustomobject]@{ evidence = [ordered]@{ name = $script:trayTooltip; helpText = ''; isOffscreen = $false; isEnabled = $true; bounds = @(1562, $top, 50, 50); runtimeId = @(42, 132394, 4, 3514); shellProcessId = 7 }; shellHandle = [IntPtr]1234; shellProcessId = 7 }
}
function Reset-Fixture {
    [AEOwnedTray]::Reset()
    $script:trayReport = [ordered]@{ iconInputs = @(); iconPreparationDiagnostics = @(); menuInputs = @(); menuLookupDiagnostics = @(); windowVisibilityDiagnostics = @(); gates = @() }
    $script:icons = @((New-Icon), (New-Icon), (New-Icon))
    $script:iconReads = 0
    $script:delayIconRead = 0
    $script:guards = 0
    $script:throwGuard = 0
    $script:delayGuard = 0
    $script:hitReads = 0
    $script:hitFailures = 0
    $script:ownedMain = [IntPtr]123
    $script:requestedSleeps = @()
}
function Assert-TrayProcess {
    $script:guards++
    if ($script:throwGuard -and $script:guards -ge $script:throwGuard) { throw 'offline-owned-generation-changed' }
    if ($script:delayGuard -and $script:guards -eq $script:delayGuard) { [Threading.Thread]::Sleep(75) }
}
function Read-FixtureIcon {
    $index = [Math]::Min($script:iconReads, $script:icons.Count - 1)
    $script:iconReads++
    if ($script:delayIconRead -and $script:iconReads -eq $script:delayIconRead) { [Threading.Thread]::Sleep(75) }
    $icon = $script:icons[$index]
    if ($icon.unavailable) { throw [Windows.Automation.ElementNotAvailableException]::new() }
    $script:trayIconHost = $icon
    return $icon
}
function Get-TrayVisibleIcon([DateTime]$deadline) { return Read-FixtureIcon }
function Get-TrayOwnIcon { return Read-FixtureIcon }
function Get-TrayElementEvidence($icon) { return $icon.evidence }
function Get-TrayIconHitMethod($icon, [int]$x, [int]$y, [switch]$AllowNotReady) {
    $script:hitReads++
    if ($script:hitReads -le $script:hitFailures -or -not [AEOwnedTray]::NativeHit) {
        if ($AllowNotReady) { return $null }
        throw 'offline-icon-obscured'
    }
    return 'exact-uia-runtime-id'
}
function Get-TrayOwnedWindow { Assert-TrayProcess; return $script:ownedMain }
function Start-Sleep([int]$Milliseconds) {
    $script:requestedSleeps += $Milliseconds
    [Threading.Thread]::Sleep([Math]::Min($Milliseconds, 5))
}
function Sample($icon) { $script:trayIconHost = $icon; return Get-TrayIconInputSample $icon }
function Gate-Fixture {
    return @('initial-owned-health', 'actual-own-icon-double-click', 'actual-own-menu-open', 'actual-owned-exit-cancel', 'actual-owned-exit-confirm-input', 'owned-exit-stops-process-and-ports') | ForEach-Object { [ordered]@{ name = $_; status = 'passed' } }
}

Case 'two-stable-samples-and-fresh-after-move-send-once' {
    Reset-Fixture
    Click-TrayOwnIcon $false ([DateTime]::UtcNow.AddMilliseconds(200))
    Check ($script:iconReads -ge 3 -and [AEOwnedTray]::Moves -eq 1 -and [AEOwnedTray]::Clicks -eq 1) 'One right click requires two stable reads and a fresh post-move read.'
    Check ($script:trayReport.iconInputs.Count -eq 1 -and $script:trayReport.iconInputs[0].actualInputCompleted) 'An icon receipt must distinguish completed physical input.'
}
Case 'native34-overflow-shift-settles-before-input' {
    Reset-Fixture
    $script:icons = @((New-Icon 898), (New-Icon 932), (New-Icon 932), (New-Icon 932))
    Click-TrayOwnIcon $false ([DateTime]::UtcNow.AddMilliseconds(200))
    Check ([AEOwnedTray]::Moves -eq 1 -and [AEOwnedTray]::Clicks -eq 1 -and $script:iconReads -ge 4 -and $script:trayReport.iconInputs[0].center[1] -eq 957) 'A changing overflow layout must settle before its one input.'
}
Case 'post-move-shift-reacquires-without-button-down' {
    Reset-Fixture
    $script:icons = @((New-Icon 898), (New-Icon 898), (New-Icon 932), (New-Icon 932), (New-Icon 932), (New-Icon 932))
    Click-TrayOwnIcon $false ([DateTime]::UtcNow.AddMilliseconds(250))
    Check ([AEOwnedTray]::Moves -eq 2 -and [AEOwnedTray]::Clicks -eq 1 -and $script:trayReport.iconInputs.Count -eq 1) 'A post-move shift may resample and move again, but sends only the final right click.'
}
Case 'permanent-cursor-mismatch-sends-no-down' {
    Reset-Fixture
    [AEOwnedTray]::CursorMismatch = $true
    Expect-Throw { Click-TrayOwnIcon $false ([DateTime]::UtcNow.AddMilliseconds(35)) } 'A permanently wrong cursor must fail within the preparation deadline.'
    Check ([AEOwnedTray]::Clicks -eq 0 -and $script:trayReport.iconInputs.Count -eq 0) 'No button-down may precede exact cursor observation.'
}
Case 'native-hit-mismatch-sends-no-down' {
    Reset-Fixture
    [AEOwnedTray]::NativeHit = $false
    Expect-Throw { Click-TrayOwnIcon $false ([DateTime]::UtcNow.AddMilliseconds(35)) } 'An obscured native host must fail boundedly.'
    Check ([AEOwnedTray]::Clicks -eq 0) 'A native hit mismatch must not send a right click.'
}
Case 'temporary-hit-mismatch-reacquires-before-one-click' {
    Reset-Fixture
    $script:hitFailures = 1
    Click-TrayOwnIcon $false ([DateTime]::UtcNow.AddMilliseconds(200))
    Check ([AEOwnedTray]::Clicks -eq 1 -and $script:hitReads -eq 3 -and [AEOwnedTray]::Moves -eq 2) 'A transient hit mismatch permits new observation, never blind repeated clicks.'
}
Case 'generation-loss-stops-before-down' {
    Reset-Fixture
    $script:throwGuard = 2
    Expect-Throw { Click-TrayOwnIcon $false ([DateTime]::UtcNow.AddMilliseconds(100)) } 'Process generation loss must abort preparation.'
    Check ([AEOwnedTray]::Clicks -eq 0) 'Identity loss must prohibit physical input.'
}
Case 'double-click-path-keeps-exact-fresh-target' {
    Reset-Fixture
    Click-TrayOwnIcon $true ([DateTime]::UtcNow.AddMilliseconds(200))
    Check ([AEOwnedTray]::DoubleClicks -eq 1 -and [AEOwnedTray]::Clicks -eq 0 -and $script:iconReads -ge 3) 'Restoration keeps its one double-click at a fresh stable target.'
}
Case 'final-delayed-owner-guard-cannot-send-after-deadline' {
    Reset-Fixture
    $script:delayGuard = 5
    Expect-Throw { Click-TrayOwnIcon $false ([DateTime]::UtcNow.AddMilliseconds(60)) } 'A delayed final identity read may not exceed the input deadline.'
    Check ([AEOwnedTray]::Clicks -eq 0 -and $script:trayReport.iconInputs.Count -eq 0) 'The preparation deadline applies after the final owner guard.'
}
Case 'uia-recreation-restarts-consecutive-stability' {
    Reset-Fixture
    $script:icons = @((New-Icon), [pscustomobject]@{ unavailable = $true }, (New-Icon), (New-Icon), (New-Icon))
    Click-TrayOwnIcon $false ([DateTime]::UtcNow.AddMilliseconds(200))
    Check ([AEOwnedTray]::Clicks -eq 1 -and $script:iconReads -ge 5) 'A transient UIA recreation must break stability and require new consecutive samples.'
}
Case 'second-pair-late-fresh-read-rejected-after-first-pair' {
    Reset-Fixture
    $script:delayIconRead = 5
    Expect-Throw { Click-TrayOwnIcon $true ([DateTime]::UtcNow.AddMilliseconds(60)) } 'A second-pair fresh UIA read after the deadline must stop the double click.'
    Check ([AEOwnedTray]::ButtonPairs -eq 1 -and [AEOwnedTray]::Moves -eq 1 -and $script:trayReport.iconInputs.Count -eq 1 -and $script:trayReport.iconInputs[0].buttonPairsCompleted -eq 1 -and -not $script:trayReport.iconInputs[0].actualInputCompleted) 'A late second pair retains the one completed pair, sends no second pair and never retries input.'
}
Case 'second-pair-fresh-layout-change-rejected-after-first-pair' {
    Reset-Fixture
    $script:icons = @((New-Icon), (New-Icon), (New-Icon), (New-Icon), (New-Icon 932))
    Expect-Throw { Click-TrayOwnIcon $true ([DateTime]::UtcNow.AddMilliseconds(150)) } 'The second-pair fresh layout must match the exact retained target.'
    Check ([AEOwnedTray]::ButtonPairs -eq 1 -and [AEOwnedTray]::Moves -eq 1 -and $script:trayReport.iconInputs[0].buttonPairsCompleted -eq 1) 'A between-pair layout change stops input instead of resampling after a sent pair.'
}
Case 'second-pair-fresh-owner-generation-loss-rejected-after-first-pair' {
    Reset-Fixture
    $script:throwGuard = 8
    Expect-Throw { Click-TrayOwnIcon $true ([DateTime]::UtcNow.AddMilliseconds(150)) } 'The second-pair owner generation must still match.'
    Check ([AEOwnedTray]::ButtonPairs -eq 1 -and [AEOwnedTray]::Moves -eq 1 -and $script:trayReport.iconInputs[0].buttonPairsCompleted -eq 1) 'Owner loss after one pair prohibits another pair and any blind retry.'
}
foreach ($drift in @('none', 'cursor-x', 'cursor-y', 'native-hit', 'owner', 'layout', 'deadline', 'fresh-read-failed')) {
    Case "pure-double-click-between-pair-$drift" {
        $script:pairWaited = $false
        $script:pairCount = 0
        $script:pairEvents = [Collections.Generic.List[string]]::new()
        $pairGuard = [Action]{
            $script:pairEvents.Add('guard')
            if ($script:pairWaited -and $drift -cin @('owner', 'layout', 'deadline', 'fresh-read-failed')) { throw "offline-between-pair-$drift" }
        }
        $pairCursor = [Func[AEOwnedTraySyntaxOnly+Point]]{
            $script:pairEvents.Add('cursor')
            $point = [AEOwnedTraySyntaxOnly+Point]::new()
            $point.X = if ($script:pairWaited -and $drift -ceq 'cursor-x') { 1588 } else { 1587 }
            $point.Y = if ($script:pairWaited -and $drift -ceq 'cursor-y') { 924 } else { 923 }
            return $point
        }
        $pairHit = [Func[bool]]{ $script:pairEvents.Add('hit'); return -not ($script:pairWaited -and $drift -ceq 'native-hit') }
        $pairSend = [Action]{ $script:pairEvents.Add('pair'); $script:pairCount++ }
        $pairWait = [Action]{ $script:pairEvents.Add('wait'); $script:pairWaited = $true }
        if ($drift -ceq 'none') {
            [AEOwnedTraySyntaxOnly]::SendTrayIconButtonPairsAtCursor(1587, 923, $true, $pairGuard, $pairCursor, $pairHit, $pairSend, $pairWait)
            Check ($script:pairCount -eq 2 -and ($script:pairEvents -join ',') -ceq 'guard,cursor,hit,pair,wait,guard,cursor,hit,pair') 'Each real double-click pair must revalidate identity, exact cursor and native hit immediately before its input.'
        } else {
            Expect-Throw { [AEOwnedTraySyntaxOnly]::SendTrayIconButtonPairsAtCursor(1587, 923, $true, $pairGuard, $pairCursor, $pairHit, $pairSend, $pairWait) } 'Between-pair drift must reject the second button pair.'
            Check ($script:pairCount -eq 1 -and $script:pairWaited) 'A failed second-pair check must stop after one pair, with no retry or extra pair.'
        }
    }
}
Case 'pure-right-click-sends-one-revalidated-pair-only' {
    $script:pairCount = 0
    $script:pairGuards = 0
    $script:pairWaits = 0
    [AEOwnedTraySyntaxOnly]::SendTrayIconButtonPairsAtCursor(1, 2, $false, [Action]{ $script:pairGuards++ }, [Func[AEOwnedTraySyntaxOnly+Point]]{ $p = [AEOwnedTraySyntaxOnly+Point]::new(); $p.X = 1; $p.Y = 2; return $p }, [Func[bool]]{ return $true }, [Action]{ $script:pairCount++ }, [Action]{ $script:pairWaits++ })
    Check ($script:pairCount -eq 1 -and $script:pairGuards -eq 1 -and $script:pairWaits -eq 0) 'A right-click invocation sends one guarded pair with no between-pair wait or retry.'
}

foreach ($change in @('runtimeId', 'shellHandle', 'shellProcessId', 'bounds', 'tooltip', 'offscreen', 'disabled', 'nonfinite', 'empty-runtime')) {
    Case "layout-comparison-rejects-$change" {
        Reset-Fixture
        $first = New-Icon
        $second = New-Icon
        switch ($change) {
            'runtimeId' { $second.evidence.runtimeId = @(42, 132394, 4, 3515) }
            'shellHandle' { $second.shellHandle = [IntPtr]1235 }
            'shellProcessId' { $second.shellProcessId = 8; $second.evidence.shellProcessId = 8 }
            'bounds' { $second.evidence.bounds[1] = 932 }
            'tooltip' { $second.evidence.name = 'AE Switch QA · ffffffffffffffffffffffffffffffff' }
            'offscreen' { $second.evidence.isOffscreen = $true }
            'disabled' { $second.evidence.isEnabled = $false }
            'nonfinite' { $second.evidence.bounds[0] = [double]::NaN }
            'empty-runtime' { $second.evidence.runtimeId = @() }
        }
        Check (-not (Test-TraySameIconLayout (Sample $first) (Sample $second))) 'Identity or readiness changes must break consecutive layout stability.'
    }
}
Case 'layout-comparison-accepts-identical-exact-samples' {
    Reset-Fixture
    Check (Test-TraySameIconLayout (Sample (New-Icon)) (Sample (New-Icon))) 'Identical owned layout samples must be accepted.'
}
Case 'diagnostic-layout-native-handle-round-trips-as-number' {
    Reset-Fixture
    $sample = Sample (New-Icon)
    $roundTrip = ($sample | ConvertTo-Json -Depth 12) | ConvertFrom-Json
    Check ($roundTrip.shellHandle -is [long] -and $roundTrip.shellHandle -eq 1234 -and $roundTrip.icon.runtimeId.Count -eq 4) 'Fresh layout evidence must serialize its exact shell HWND as a number.'
}
Case 'second-menu-zero-popup-replaces-prior-success-diagnostic' {
    Reset-Fixture
    $script:trayReport.lastMenuLookup = [ordered]@{ requestedName = '退出应用…'; nativeReady = $true; nativeItems = @('stale-success'); nativeWindowHandle = 777 }
    Expect-Throw { Invoke-TrayMenu '退出应用…' } 'The offline stop proves a menu wait occurred.'
    Check ([AEOwnedTray]::Clicks -eq 1 -and [AEOwnedTray]::MenuClicks -eq 0) 'An absent popup never triggers another right click or menu input.'
    $lookup = $script:trayReport.lastMenuLookup
    Check ($lookup.popupCount -eq 0 -and -not $lookup.nativeReady -and $lookup.nativeItems.Count -eq 0 -and $null -eq $lookup.nativeWindowHandle -and $lookup.zeroPopupAttempts -ge 1) 'The failing invocation must contain its own fresh zero-popup evidence.'
}
Case 'not-ready-then-missing-menu-clears-native-snapshot' {
    Reset-Fixture
    [AEOwnedTray]::PopupCounts = @(1, 0, 0)
    [AEOwnedTray]::Popup = [AEOwnedTraySyntaxOnly+NativeMenuSnapshot]::new()
    [AEOwnedTray]::Popup.Window = [IntPtr]900
    [AEOwnedTray]::Popup.ProcessId = 42
    [AEOwnedTray]::Popup.Items = @()
    Expect-Throw { Invoke-TrayMenu '退出应用…' } 'The offline stop terminates not-ready observation.'
    $lookup = $script:trayReport.lastMenuLookup
    Check ($lookup.popupCount -eq 0 -and $lookup.notReadyPopupAttempts -eq 1 -and $lookup.nativeItems.Count -eq 0 -and $null -eq $lookup.nativeWindowHandle) 'Fresh absence must supersede a transient not-ready snapshot.'
    Check ([AEOwnedTray]::Clicks -eq 1 -and [AEOwnedTray]::MenuClicks -eq 0) 'Not-ready observation must send no menu click.'
}
Case 'ambiguous-owned-popup-sends-no-menu-input' {
    Reset-Fixture
    [AEOwnedTray]::PopupCounts = @(2)
    Expect-Throw { Invoke-TrayMenu '退出应用…' } 'Two owned native menus are ambiguous.'
    Check ([AEOwnedTray]::Clicks -eq 1 -and [AEOwnedTray]::MenuClicks -eq 0 -and $script:trayReport.lastMenuLookup.popupCount -eq 2) 'Ambiguous menus must retain their fresh count and never receive left input.'
}
Case 'ready-popup-still-rejects-wrong-exact-label' {
    Reset-Fixture
    [AEOwnedTray]::PopupCounts = @(1)
    $popup = [AEOwnedTraySyntaxOnly+NativeMenuSnapshot]::new()
    $popup.Window = [IntPtr]900
    $popup.Menu = [IntPtr]901
    $popup.ProcessId = 42
    $popup.ClassName = '#32768'
    $popup.Visible = $popup.Ready = $true
    $popup.Items = foreach ($position in 0..1) {
        $item = [AEOwnedTraySyntaxOnly+NativeMenuItem]::new()
        $item.Position = $position
        $item.Name = if ($position -eq 0) { '打开 AE Switch' } else { '退出应用' }
        $item.BoundsReady = $true
        $item.Bounds.Right = $item.Bounds.Bottom = 10
        $item
    }
    [AEOwnedTray]::Popup = $popup
    Expect-Throw { Invoke-TrayMenu '退出应用…' } 'Ready menu coordinates do not replace exact menu labels.'
    Check ([AEOwnedTray]::Clicks -eq 1 -and [AEOwnedTray]::MenuClicks -eq 0 -and $script:trayReport.lastMenuLookup.nativeReady) 'The exact-two-label selector still guards native menu input.'
}
Case 'visible-wait-records-native-state-without-changing-enabled-acceptance' {
    Reset-Fixture
    [AEOwnedTray]::WindowEnabled = $false
    $window = Wait-TrayVisible ([IntPtr]123)
    $diagnostic = $script:trayReport.windowVisibilityDiagnostics[-1]
    $sample = $diagnostic.samples[-1]
    Check ($window -eq [IntPtr]123 -and $diagnostic.status -ceq 'visible' -and $diagnostic.expectedMainHwnd -eq 123) 'A fresh visible restored retained HWND must pass the existing visibility condition.'
    Check ($sample.hwnd -eq 123 -and $sample.visible -and -not $sample.iconic -and -not $sample.enabled -and $sample.elapsedMs -ge 0 -and [DateTimeOffset]::Parse($sample.observedAtUtc).Offset -eq [TimeSpan]::Zero) 'Diagnostic samples must contain UTC time, elapsed time, HWND and all three native states; enabled is diagnostic only.'
    Check ([AEOwnedTray]::Clicks -eq 0 -and [AEOwnedTray]::DoubleClicks -eq 0 -and $script:trayReport.gates.Count -eq 0) 'Visibility diagnostics must not send input or add successful gates.'
}
Case 'visible-wait-rejects-replaced-retained-hwnd-with-diagnostics' {
    Reset-Fixture
    $script:ownedMain = [IntPtr]124
    Expect-Throw { Wait-TrayVisible ([IntPtr]123) } 'A visible replacement HWND cannot pass the retained-window check.'
    $diagnostic = $script:trayReport.windowVisibilityDiagnostics[-1]
    Check ($diagnostic.status -ceq 'hwnd-changed' -and $diagnostic.expectedMainHwnd -eq 123 -and $diagnostic.samples[-1].hwnd -eq 124) 'A changed HWND must retain the expected and observed identities.'
    Check ([AEOwnedTray]::Clicks -eq 0 -and $script:trayReport.gates.Count -eq 0) 'A changed HWND must not trigger a retry or pass a gate.'
}
Case 'visible-wait-keeps-five-second-timeout-and-bounded-minimized-samples' {
    Reset-Fixture
    [AEOwnedTray]::WindowMinimized = $true
    $failure = $null
    $clock = [Diagnostics.Stopwatch]::StartNew()
    try { $null = Wait-TrayVisible ([IntPtr]123) } catch { $failure = $_.Exception.Message }
    $clock.Stop()
    $diagnostic = $script:trayReport.windowVisibilityDiagnostics[-1]
    Check ($failure -ceq 'The owned application window did not become visible.' -and $diagnostic.status -ceq 'timeout' -and $clock.ElapsedMilliseconds -ge 5000) 'A still-minimized window must keep the original error and five-second budget.'
    Check ($diagnostic.samples.Count -eq 64 -and $diagnostic.sampleCount -gt 64 -and $diagnostic.samplesTruncated -and $diagnostic.samples[-1].visible -and $diagnostic.samples[-1].iconic) 'Fast offline polling must retain at most 64 detailed samples and explicitly count truncation.'
    Check ([AEOwnedTray]::Clicks -eq 0 -and [AEOwnedTray]::DoubleClicks -eq 0 -and $script:trayReport.gates.Count -eq 0) 'A visibility timeout must not resend input or manufacture success.'
}
Case 'cancel-waits-for-dialog-gone-and-main-enabled' {
    Reset-Fixture
    [AEOwnedTray]::DialogVisible = $true
    [AEOwnedTray]::ReadyAfter = 2
    $window = Wait-TrayCancelReady ([IntPtr]456) ([IntPtr]123) ([DateTime]::UtcNow.AddMilliseconds(100))
    Check ($window -eq [IntPtr]123 -and [AEOwnedTray]::DialogReads -ge 3 -and $script:trayReport.cancelReadiness.ready) 'Cancellation needs a fresh absent dialog and enabled restored main window.'
}
Case 'cancel-disabled-main-does-not-pass-readiness' {
    Reset-Fixture
    [AEOwnedTray]::WindowEnabled = $false
    Expect-Throw { Wait-TrayCancelReady ([IntPtr]456) ([IntPtr]123) ([DateTime]::UtcNow.AddMilliseconds(30)) } 'A disabled main window cannot pass cancellation readiness.'
    Check ($null -ne $script:trayReport.cancelReadiness -and [AEOwnedTray]::Clicks -eq 0 -and -not $script:trayReport.cancelReadiness.ready) 'Cancellation readiness sends no mouse input.'
}
Case 'cancel-main-hwnd-change-fails-closed' {
    Reset-Fixture
    $script:ownedMain = [IntPtr]124
    Expect-Throw { Wait-TrayCancelReady ([IntPtr]456) ([IntPtr]123) ([DateTime]::UtcNow.AddMilliseconds(50)) } 'An owned main HWND replacement must fail closed.'
    Check ($null -ne $script:trayReport.cancelReadiness -and -not $script:trayReport.cancelReadiness.ready) 'A changed HWND must retain failed readiness evidence.'
}
Case 'cancel-dialog-still-visible-does-not-pass-readiness' {
    Reset-Fixture
    [AEOwnedTray]::DialogVisible = $true
    [AEOwnedTray]::ReadyAfter = [int]::MaxValue
    Expect-Throw { Wait-TrayCancelReady ([IntPtr]456) ([IntPtr]123) ([DateTime]::UtcNow.AddMilliseconds(30)) } 'A remaining owned confirmation dialog cannot pass cancellation readiness.'
    Check ($script:trayReport.cancelReadiness.ownedDialogCount -eq 1 -and -not $script:trayReport.cancelReadiness.ready) 'Dialog visibility must remain explicit in readiness failure.'
}
Case 'all-six-exact-passed-gates-accepted' { Check (Test-TrayRequiredGates @(Gate-Fixture)) 'All six unique exact passed gates should pass.' }
foreach ($failure in @('skipped', 'missing', 'duplicate', 'extra', 'wrong-name', 'wrong-status')) {
    Case "six-gate-total-rejects-$failure" {
        $gates = @(Gate-Fixture)
        switch ($failure) {
            'skipped' { $gates[3].status = 'skipped'; $gates[4].status = 'skipped' }
            'missing' { $gates = $gates[0..4] }
            'duplicate' { $gates[4].name = $gates[3].name }
            'extra' { $gates += [ordered]@{ name = 'extra'; status = 'passed' } }
            'wrong-name' { $gates[0].name = 'Initial-owned-health' }
            'wrong-status' { $gates[0].status = 'Passed' }
        }
        Check (-not (Test-TrayRequiredGates $gates)) 'Total success must require exactly the six passed product gates.'
    }
}
Case 'driver-ownership-and-exact-menu-guards-remain' {
    Check ($source.Contains('StartTime.ToUniversalTime().Ticks -ne $script:trayCreation.Ticks') -and $source.Contains('ProcessPath($script:trayProcess.Handle) -cne $script:trayExe') -and $source.Contains('Owned tray executable hash mismatch.') -and $source.Contains('Owned tray marker mismatch.')) 'Retained generation, path, SHA and UUID-marker checks must remain.'
    Check ($native.Contains('menu.Items.Length!=2') -and $native.Contains('open!=1 || exit!=1') -and $native.Contains('Both exact product tray labels must be unique native entries.')) 'The native popup must still contain exactly both exact enabled labels.'
}
Case 'final-input-method-observes-cursor-without-moving-it' {
    Check ($native -match '(?s)public static void SendTrayIconButtonPairsAtCursor\(.*?revalidate\(\);.*?var cursor=readCursor\(\);.*?cursor.X!=x.*?sendPair\(\)') 'Every final button pair must observe the exact cursor after identity revalidation.'
    $method = [regex]::Match($native, '(?s)public static void ClickTrayIconAtCursor\([^\n]+\).*?\n    \}').Value
    Check ($method.Length -gt 0 -and $method -notmatch 'SetCursorPos|MoveOwnedMenuCursor|MoveTrayCursor' -and $method.Contains('SendTrayIconButtonPairsAtCursor') -and $method.Contains('()=>IsShellHit(x,y,host,shellPid)')) 'The final input method must never move after fresh PowerShell layout validation.'
}
Case 'post-move-hit-requires-native-shell-ownership' {
    $hit = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Get-TrayIconHitMethod' }, $true).Extent.Text
    Check ($hit -match 'if \(-not \$hitOwnIcon -or -not \[AEOwnedTray\]::IsShellHit') 'Even direct UIA matches must receive the native host hit check.'
}
Case 'main-chain-uses-cancel-readiness-and-six-gate-total' {
    Check ($source.Contains('Wait-TrayCancelReady $trayDialog $trayCancelWindow') -and $source.Contains('$trayReport.passed = Test-TrayRequiredGates $trayReport.gates')) 'The actual driver must use the tested cancellation and total predicates.'
    Check ($source -notmatch '\$trayReport\.passed\s*=\s*\$true') 'No unconditional total-success assignment is allowed.'
}

$passed = @($script:results | Where-Object { $_.passed }).Count
[ordered]@{ offlineOnly = $true; physicalInput = $false; gui = $false; http = $false; passed = $passed -eq $script:results.Count; passedCount = $passed; totalCount = $script:results.Count; driverSha256 = (Get-FileHash -LiteralPath $driverPath -Algorithm SHA256).Hash.ToLowerInvariant(); testSha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant(); gates = $script:results } | ConvertTo-Json -Depth 8
if ($passed -ne $script:results.Count) { exit 1 }
