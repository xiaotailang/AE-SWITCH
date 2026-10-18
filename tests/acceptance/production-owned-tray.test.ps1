[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
# AST extraction and synthetic delegates only: the driver, GUI and P/Invokes are never executed.
$source=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'production-owned-tray.ps1'),[Text.Encoding]::UTF8)
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
if($errors.Count) { throw ($errors | Out-String) }
$type=$ast.Find({param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Add-Type' -and $n.CommandElements.Count -ge 3 -and $n.CommandElements[1].Extent.Text -eq '-TypeDefinition'},$true)
if($null -eq $type) { throw 'Native type missing' }
$native=$type.CommandElements[2].Value.Replace('public static class AEProductionOwnedTray {','public static class AEProductionOwnedTraySyntaxOnly {')
Add-Type -TypeDefinition ($native+@'
namespace Windows.Automation {
    public class ElementNotAvailableException:System.Exception {}
    public enum TreeScope { Descendants }
    public class PropertyCondition { public PropertyCondition(object property,object value) {} }
    public static class ControlType { public static object Button="Button"; }
    public static class AutomationElement {
        public static object Shell,ControlTypeProperty="ControlType";
        public static object FromHandle(System.IntPtr handle) { return Shell; }
    }
}
public static class AEProductionOwnedTray {
    public struct Point { public int X,Y; }
    public struct Rect { public int Left,Top,Right,Bottom; }
    public sealed class TrayIconInputReceipt { public int ButtonPairsCompleted; public uint DoubleClickLimitMs; public long PairIntervalMs=-1,ValidationDurationMs,InputElapsedMs; public bool DoubleClickDeadlineExceeded; }
    public static int Pairs,Moves; public static bool CursorMismatch,Hit=true; public static Point Current;
    public static long ClockMs,ValidationCostMs; public static uint DoubleClickLimitMs=500;
    public static bool Overflow; public static Rect Bounds=new Rect{Left=100,Top=100,Right=120,Bottom=120};
    public static System.IntPtr[] Notifications=new[]{new System.IntPtr(200)}; public static int NotificationPid=42;
    public static System.IntPtr[] NotificationWindows(int pid) { return Notifications; }
    public static int WindowProcessId(System.IntPtr hwnd) { return NotificationPid; }
    public static System.IntPtr[] ShellWindows() { return new[]{new System.IntPtr(500)}; }
    public static bool IsWindowVisible(System.IntPtr hwnd) { return true; }
    public static bool OverflowVisible() { return Overflow; }
    public static Rect NotificationBounds(System.IntPtr hwnd,uint uid) { return Bounds; }
    public static void MoveTrayCursor(int x,int y) { Moves++; Current=new Point{X=x,Y=y}; }
    public static Point Cursor() { return new Point{X=Current.X+(CursorMismatch?1:0),Y=Current.Y}; }
    public static int ForegroundProcessId() { return 42; }
    public static void ClickTrayIconAtCursor(int x,int y,bool twice,System.IntPtr host,int pid,System.Action verify,TrayIconInputReceipt receipt) {
        var nativeReceipt=new AEProductionOwnedTraySyntaxOnly.TrayIconInputReceipt();
        try { AEProductionOwnedTraySyntaxOnly.SendTrayIconButtonPairsAtCursor(x,y,twice,()=>{ClockMs+=ValidationCostMs;verify();},()=>new AEProductionOwnedTraySyntaxOnly.Point{X=Cursor().X,Y=Cursor().Y},()=>Hit,()=>{Pairs++;},()=>{ClockMs+=60;},()=>ClockMs,DoubleClickLimitMs,nativeReceipt); }
        finally { receipt.ButtonPairsCompleted=nativeReceipt.ButtonPairsCompleted; receipt.DoubleClickLimitMs=nativeReceipt.DoubleClickLimitMs; receipt.PairIntervalMs=nativeReceipt.PairIntervalMs; receipt.ValidationDurationMs=nativeReceipt.ValidationDurationMs; receipt.InputElapsedMs=nativeReceipt.InputElapsedMs; receipt.DoubleClickDeadlineExceeded=nativeReceipt.DoubleClickDeadlineExceeded; }
    }
}
'@)
foreach($name in @('Test-TraySameIconLayout','Click-TrayOwnIcon','Get-TrayNotificationIdentity')) {
    $f=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true)
    if($null -eq $f) { throw "Required guard function missing: $name" }
    Invoke-Expression $f.Extent.Text
}
foreach($name in @('Test-TrayTooltip','Test-TrayIconReady','Get-TrayOwnIcon','Get-TrayVisibleIcon')) {
    $f=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true)
    if($null -eq $f) { throw "Required candidate guard missing: $name" }
    $definition=$f.Extent.Text
    if($name -eq 'Get-TrayOwnIcon') { $definition=$definition.Replace('function Get-TrayOwnIcon {','function Get-TrayOwnIconCandidate {') }
    if($name -eq 'Get-TrayVisibleIcon') { $definition=$definition.Replace('function Get-TrayVisibleIcon(','function Get-TrayVisibleIconCandidate(') }
    Invoke-Expression $definition
}
$script:results=@()
function Check([bool]$ok,[string]$message) { if(-not $ok) { throw $message } }
function Case([string]$name,[scriptblock]$body) {
    try { & $body; $script:results+=@{name=$name;passed=$true} }
    catch { $script:results+=@{name=$name;passed=$false;error=$_.Exception.Message} }
}
function Throws([scriptblock]$body) { $thrown=$false; try { & $body } catch { $thrown=$true }; Check $thrown 'Expected pre-input rejection' }
function Sample([int]$ownerHwnd=200,[int]$uid=2,[int]$x=100) {
    @{ shellHandle=500; shellProcessId=7; icon=@{ runtimeId=@(1,2,3); bounds=@($x,100,20,20); notificationOwnerHwnd=$ownerHwnd; notificationUid=$uid; notificationBounds=@(100,100,120,120) } }
}
function Reset {
    [AEProductionOwnedTray]::Pairs=0; [AEProductionOwnedTray]::Moves=0
    [AEProductionOwnedTray]::CursorMismatch=$false; [AEProductionOwnedTray]::Hit=$true
    [AEProductionOwnedTray]::ClockMs=0; [AEProductionOwnedTray]::ValidationCostMs=0; [AEProductionOwnedTray]::DoubleClickLimitMs=500
    $script:trayReport=@{iconInputs=@();iconPreparationDiagnostics=@()}
    $script:samples=@((Sample),(Sample),(Sample),(Sample),(Sample),(Sample))
    $script:reads=0; $script:guards=0; $script:rejectGuard=0; $script:badHit=$false
    $script:callbackHwnd=$null; $script:OwnedProcessId=42
    $script:trayTooltip='AE Switch'; $script:useCandidateProof=$false; $script:overflowInvokes=0
    [AEProductionOwnedTray]::Overflow=$false
    [AEProductionOwnedTray]::Notifications=@([IntPtr]200); [AEProductionOwnedTray]::NotificationPid=42
}
function Assert-TrayProcess { $script:guards++; if($script:rejectGuard -and $script:guards -ge $script:rejectGuard) { throw 'synthetic process generation changed' } }
function Get-TrayVisibleIcon {param($deadline) if($script:useCandidateProof) { return Get-TrayVisibleIconCandidate $deadline }; Get-TrayOwnIcon}
function Get-TrayOwnIcon { if($script:useCandidateProof) { return Get-TrayOwnIconCandidate }; $script:reads++; return $script:samples[[Math]::Min($script:reads-1,$script:samples.Count-1)] }
function Get-TrayIconInputSample($icon) { if($script:useCandidateProof) { return @{icon=$icon;shellHandle=500;shellProcessId=7} }; $icon }
function Get-TrayElementEvidence($element) { $element }
function Get-TrayChevron { 'exact-chevron' }
function Invoke-TrayElement($element) {
    Check ($element -ceq 'exact-chevron') 'Only the exact overflow toggle may be invoked'
    $script:overflowInvokes++; [AEProductionOwnedTray]::Overflow=$true
    $script:candidateIcons=@((Candidate))
}
function Get-TrayIconHitMethod {param($icon,$x,$y,[switch]$AllowNotReady) if($script:badHit) { if($AllowNotReady) { return $null }; throw 'synthetic native hit differs' }; 'exact-uia-runtime-id' }
function Start-Sleep {param($Milliseconds)}
function Candidate([string]$name='AE Switch',[int]$x=100,[int]$width=20) {
    @{name=$name;helpText='';className='synthetic-button';automationId='synthetic';controlType='ControlType.Button';shellProcessId=7;isOffscreen=$false;isEnabled=$true;bounds=@($x,100,$width,20);runtimeId=@(1,2,3)}
}
function Prepare-CandidateProof($candidate) {
    $script:useCandidateProof=$true; $script:candidateIcons=@($candidate)
    $shell=[pscustomobject]@{Current=[pscustomobject]@{ProcessId=7;ClassName='Shell_TrayWnd'}}
    $shell|Add-Member -MemberType ScriptMethod -Name FindAll -Value {param($scope,$condition) $script:candidateIcons}
    [Windows.Automation.AutomationElement]::Shell=$shell
}

foreach($name in @('New-TrayProofFreeze','Assert-TrayProofFreeze','Assert-TrayProofFreezeHashes','Close-TrayProofFreeze')) {
    $f=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true)
    if($null -eq $f) { throw "Required retained proof guard missing: $name" }
    Invoke-Expression $f.Extent.Text
}
function Assert-TrayPath([string]$file,[string]$boundary) {
    $full=[IO.Path]::GetFullPath($file)
    Check ($full.StartsWith([IO.Path]::GetFullPath($boundary)+'\',[StringComparison]::OrdinalIgnoreCase)) 'Synthetic proof path escaped its UUID'
    $cursor=$full
    while($cursor) {
        $attributes=[IO.File]::GetAttributes($cursor)
        Check (($attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'Proof reparse path refused'
        $cursor=[IO.Path]::GetDirectoryName($cursor)
    }
    $full
}
function ProofHash([string]$file) {
    $hash=[Security.Cryptography.SHA256]::Create();$stream=[IO.File]::OpenRead($file)
    try { ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-','').ToLowerInvariant() } finally { $stream.Dispose();$hash.Dispose() }
}
Case 'retained ordinary proof stream denies write delete and rename until final verification and release' {
    $root=[IO.Path]::GetFullPath((Join-Path (Join-Path $PSScriptRoot '../../.cache/tmp') ('tray-proof-fixture-'+[Guid]::NewGuid().ToString('N'))))
    $null=[IO.Directory]::CreateDirectory($root);$file=Join-Path $root 'proof.txt';$renamed=Join-Path $root 'renamed.txt';$freeze=$null
    try {
        [IO.File]::WriteAllText($file,'bound proof bytes');$hash=ProofHash $file
        $freeze=New-TrayProofFreeze @($file) @{$file=$hash} $root
        Assert-TrayProofFreeze $freeze @($file)
        Throws { Assert-TrayProofFreeze $freeze @($file,$renamed) }
        Throws { Assert-TrayProofFreezeHashes $freeze @($file) @{$file=('0'*64)} $root }
        Throws { [IO.File]::WriteAllText($file,'drift') }
        Throws { [IO.File]::Delete($file) }
        Throws { [IO.File]::Move($file,$renamed) }
        Check ((ProofHash $file) -ceq $hash) 'Locked proof bytes changed'
        Assert-TrayProofFreezeHashes $freeze @($file) @{$file=$hash} $root
        Close-TrayProofFreeze $freeze;$freeze=$null
        [IO.File]::Move($file,$renamed);[IO.File]::WriteAllText($renamed,'released');[IO.File]::Delete($renamed)
        Check (-not [IO.File]::Exists($file) -and -not [IO.File]::Exists($renamed)) 'Released proof still blocks ordinary operations'
    } finally {
        if($null -ne $freeze) { Close-TrayProofFreeze $freeze }
        foreach($leaf in @($file,$renamed)) { if([IO.File]::Exists($leaf)) { [IO.File]::Delete($leaf) } }
        [IO.Directory]::Delete($root,$false)
    }
}
Case 'proof hash drift and later open failure fail closed and release every acquired stream' {
    $root=[IO.Path]::GetFullPath((Join-Path (Join-Path $PSScriptRoot '../../.cache/tmp') ('tray-proof-fixture-'+[Guid]::NewGuid().ToString('N'))))
    $null=[IO.Directory]::CreateDirectory($root);$file=Join-Path $root 'proof.txt';$missing=Join-Path $root 'missing.txt'
    try {
        [IO.File]::WriteAllText($file,'bound proof bytes');$hash=ProofHash $file
        Throws { New-TrayProofFreeze @($file) @{$file=('0'*64)} $root }
        [IO.File]::WriteAllText($file,'bound proof bytes')
        Throws { New-TrayProofFreeze @($file,$missing) @{$file=$hash;$missing=$hash} $root }
        [IO.File]::WriteAllText($file,'released after failure')
    } finally { [IO.File]::Delete($file);[IO.Directory]::Delete($root,$false) }
}
Case 'second pair after the OS double-click interval is refused with exact completed count' {
    $script:pairClock=0L;$script:sentPairs=0;$script:pairChecks=0
    $receipt=[AEProductionOwnedTraySyntaxOnly+TrayIconInputReceipt]::new()
    Throws { [AEProductionOwnedTraySyntaxOnly]::SendTrayIconButtonPairsAtCursor(110,110,$true,[Action]{$script:pairChecks++;if($script:pairChecks -eq 2){$script:pairClock+=501}},[Func[AEProductionOwnedTraySyntaxOnly+Point]]{[AEProductionOwnedTraySyntaxOnly+Point]@{X=110;Y=110}},[Func[bool]]{$true},[Action]{$script:sentPairs++},[Action]{},[Func[long]]{$script:pairClock},[uint32]500,$receipt) }
    Check ($script:sentPairs -eq 1 -and $receipt.ButtonPairsCompleted -eq 1) 'Late second pair was sent or first pair count was lost'
    Check ($receipt.PairIntervalMs -gt $receipt.DoubleClickLimitMs) 'Late double-click timing was not retained'
    Check $receipt.DoubleClickDeadlineExceeded 'Late native double-click rejection was not recorded'
}
Case 'two guarded pairs within the OS double-click interval retain real interval evidence' {
    $script:pairClock=0L;$script:sentPairs=0;$script:pairChecks=0
    $receipt=[AEProductionOwnedTraySyntaxOnly+TrayIconInputReceipt]::new()
    [AEProductionOwnedTraySyntaxOnly]::SendTrayIconButtonPairsAtCursor(110,110,$true,[Action]{$script:pairChecks++;$script:pairClock+=20},[Func[AEProductionOwnedTraySyntaxOnly+Point]]{[AEProductionOwnedTraySyntaxOnly+Point]@{X=110;Y=110}},[Func[bool]]{$true},[Action]{$script:sentPairs++},[Action]{$script:pairClock+=60},[Func[long]]{$script:pairClock},[uint32]500,$receipt)
    Check ($script:sentPairs -eq 2 -and $receipt.ButtonPairsCompleted -eq 2) 'Exact double-click pair count differs'
    Check ($receipt.PairIntervalMs -eq 80 -and $receipt.ValidationDurationMs -eq 40) 'Monotonic input timing evidence differs'
}
Case 'fresh pair observation failure before first input retains zero count and elapsed timing' {
    $script:pairClock=0L;$script:sentPairs=0
    $receipt=[AEProductionOwnedTraySyntaxOnly+TrayIconInputReceipt]::new()
    Throws { [AEProductionOwnedTraySyntaxOnly]::SendTrayIconButtonPairsAtCursor(110,110,$true,[Action]{$script:pairClock+=25;throw 'synthetic fresh deadline elapsed'},[Func[AEProductionOwnedTraySyntaxOnly+Point]]{[AEProductionOwnedTraySyntaxOnly+Point]@{X=110;Y=110}},[Func[bool]]{$true},[Action]{$script:sentPairs++},[Action]{},[Func[long]]{$script:pairClock},[uint32]500,$receipt) }
    Check ($script:sentPairs -eq 0 -and $receipt.ButtonPairsCompleted -eq 0 -and $receipt.ValidationDurationMs -eq 25 -and $receipt.InputElapsedMs -eq 25 -and $receipt.PairIntervalMs -eq -1) 'Pre-input failure lost exact timing or completed count'
}

Case 'API-center foreign tooltip is not an owned icon and receives no button input' {
    Reset; Prepare-CandidateProof (Candidate 'Show hidden icons')
    Check ($null -eq (Get-TrayOwnIconCandidate)) 'Non-owned tooltip must be treated as not found'
    Check ([AEProductionOwnedTray]::Pairs -eq 0 -and [AEProductionOwnedTray]::Moves -eq 0) 'Non-owned candidate received input'
    Check ($script:trayReport.lastIconLookup.tooltipMatches -eq $false) 'Failed lookup geometry/tooltip evidence missing'
}
Case 'owned tooltip with strict rectangle-center mismatch still refuses all input' {
    Reset; Prepare-CandidateProof (Candidate 'AE Switch' 90 60)
    Throws { Get-TrayOwnIconCandidate }
    Check ([AEProductionOwnedTray]::Pairs -eq 0 -and [AEProductionOwnedTray]::Moves -eq 0) 'Mismatched owned rectangle received input'
    Check ($script:trayReport.lastIconLookup.tooltipMatches -eq $true -and $script:trayReport.lastIconLookup.uiaCenterInsideNotification -eq $false) 'Rectangle rejection evidence missing'
}
Case 'overflow opens after a non-owned candidate and fresh exact ownership precedes input' {
    Reset; Prepare-CandidateProof (Candidate 'Show hidden icons')
    Click-TrayOwnIcon $true ([DateTime]::UtcNow.AddSeconds(1))
    Check ($script:overflowInvokes -eq 1) 'The existing exact overflow path was skipped'
    Check ([AEProductionOwnedTray]::Pairs -eq 2) 'Fresh owned candidate did not receive the guarded double-click'
    Check ($script:trayReport.lastIconLookup.tooltipMatches -eq $true -and $script:trayReport.lastIconLookup.uiaCenterInsideNotification -eq $true) 'Fresh ownership proof missing'
}
Case 'fresh exact owned API/UIA candidate permits input without opening overflow' {
    Reset; Prepare-CandidateProof (Candidate)
    Click-TrayOwnIcon $true ([DateTime]::UtcNow.AddSeconds(1))
    Check ($script:overflowInvokes -eq 0 -and [AEProductionOwnedTray]::Pairs -eq 2) 'Fresh exact target unnecessarily opened overflow or missed input'
}

Case 'stable exact callback/API/UIA layout permits two guarded button pairs' { Reset; Click-TrayOwnIcon $true ([DateTime]::UtcNow.AddSeconds(1)); Check ([AEProductionOwnedTray]::Pairs -eq 2) 'Exact double-click should have two pairs'; Check ($script:trayReport.iconInputs[0].exactOwnerHitTest -eq $true) 'Owner hit evidence missing' }
Case 'wrong notification uID never sends button input' { Reset; $script:samples=@((Sample 200 1)); Throws {Click-TrayOwnIcon $true ([DateTime]::UtcNow.AddMilliseconds(30))}; Check ([AEProductionOwnedTray]::Pairs -eq 0) 'Unknown icon clicked' }
Case 'different callback HWND after stable samples never sends button input' { Reset; $script:samples=@((Sample),(Sample),(Sample 201),(Sample 201 1)); Throws {Click-TrayOwnIcon $true ([DateTime]::UtcNow.AddMilliseconds(30))}; Check ([AEProductionOwnedTray]::Pairs -eq 0) 'Foreign callback clicked' }
Case 'changed layout between movement and click rejects input' { Reset; $script:samples=@((Sample),(Sample),(Sample 200 2 101),(Sample 200 1)); Throws {Click-TrayOwnIcon $true ([DateTime]::UtcNow.AddMilliseconds(30))}; Check ([AEProductionOwnedTray]::Pairs -eq 0) 'Changed layout clicked' }
Case 'cursor mismatch rejects button input' { Reset; [AEProductionOwnedTray]::CursorMismatch=$true; Throws {Click-TrayOwnIcon $true ([DateTime]::UtcNow.AddMilliseconds(30))}; Check ([AEProductionOwnedTray]::Pairs -eq 0) 'Wrong cursor clicked' }
Case 'native hit mismatch rejects button input' { Reset; $script:badHit=$true; Throws {Click-TrayOwnIcon $true ([DateTime]::UtcNow.AddMilliseconds(30))}; Check ([AEProductionOwnedTray]::Pairs -eq 0) 'Obscured icon clicked' }
Case 'process generation change before first pair rejects input' { Reset; $script:rejectGuard=5; Throws {Click-TrayOwnIcon $true ([DateTime]::UtcNow.AddSeconds(1))}; Check ([AEProductionOwnedTray]::Pairs -eq 0) 'Stale process clicked' }
Case 'second pair rechecks process and target' { Reset; $script:rejectGuard=8; Throws {Click-TrayOwnIcon $true ([DateTime]::UtcNow.AddSeconds(1))}; Check ([AEProductionOwnedTray]::Pairs -eq 1) 'Second pair was not individually guarded' }
Case 'expired deadline rejects even exact target' { Reset; Throws {Click-TrayOwnIcon $true ([DateTime]::UtcNow.AddMilliseconds(-1))}; Check ([AEProductionOwnedTray]::Moves -eq 0 -and [AEProductionOwnedTray]::Pairs -eq 0) 'Expired target received input' }
Case 'callback lookup rejects missing owned notification HWND' { Reset; [AEProductionOwnedTray]::Notifications=@(); Throws {Get-TrayNotificationIdentity}; Check ([AEProductionOwnedTray]::Pairs -eq 0) 'Missing owner clicked' }
Case 'callback lookup rejects multiple owned notification HWNDs' { Reset; [AEProductionOwnedTray]::Notifications=@([IntPtr]200,[IntPtr]201); Throws {Get-TrayNotificationIdentity}; Check ([AEProductionOwnedTray]::Pairs -eq 0) 'Ambiguous owner clicked' }
Case 'callback lookup rejects foreign PID before API rectangle or input' { Reset; [AEProductionOwnedTray]::NotificationPid=43; Throws {Get-TrayNotificationIdentity}; Check ([AEProductionOwnedTray]::Pairs -eq 0) 'Foreign callback clicked' }
Case 'callback lookup rejects a replaced HWND after initial proof' { Reset; $null=Get-TrayNotificationIdentity; [AEProductionOwnedTray]::Notifications=@([IntPtr]201); Throws {Get-TrayNotificationIdentity}; Check ([AEProductionOwnedTray]::Pairs -eq 0) 'Replaced callback clicked' }

function Menu([int]$process=42) {
    $m=[AEProductionOwnedTraySyntaxOnly+NativeMenuSnapshot]::new(); $m.Window=[IntPtr]900; $m.Menu=[IntPtr]901; $m.ProcessId=$process; $m.ClassName='#32768'; $m.Visible=$true; $m.Ready=$true
    $items=@(); $i=0
    foreach($name in @('打开 AE Switch','退出应用…')) { $v=[AEProductionOwnedTraySyntaxOnly+NativeMenuItem]::new(); $v.Name=$name; $v.Position=$i++; $v.State=0; $v.BoundsReady=$true; $v.Bounds=[AEProductionOwnedTraySyntaxOnly+Rect]@{Left=100;Top=100;Right=200;Bottom=120}; $items+=$v }
    $m.Items=$items; $m
}
Case 'native menu rejects other application PID' { Throws { [AEProductionOwnedTraySyntaxOnly]::SelectOwnedMenuItem((Menu 43),'打开 AE Switch',42) } }
Case 'native menu rejects duplicate or altered labels' { $m=Menu; $m.Items[1].Name='打开 AE Switch'; Throws { [AEProductionOwnedTraySyntaxOnly]::SelectOwnedMenuItem($m,'打开 AE Switch',42) } }
Case 'native menu rejects disabled exit' { $m=Menu; $m.Items[1].State=1; Throws { [AEProductionOwnedTraySyntaxOnly]::SelectOwnedMenuItem($m,'退出应用…',42) } }
Case 'native menu rejects zero bounds' { $m=Menu; $m.Items[0].BoundsReady=$false; Throws { [AEProductionOwnedTraySyntaxOnly]::SelectOwnedMenuItem($m,'打开 AE Switch',42) } }
Case 'native menu accepts exact owned pair without native input' { $m=Menu; $selected=[AEProductionOwnedTraySyntaxOnly]::SelectOwnedMenuItem($m,'打开 AE Switch',42); Check ($selected.Position -eq 0) 'Exact menu selection failed' }
Case 'dialog native selector forbids confirmation' { Throws { [AEProductionOwnedTraySyntaxOnly]::SelectOwnedDialogButton($null,'确定',[IntPtr]3,42) } }
Case 'dialog PowerShell guard forbids confirmation before reading GUI' {
    $f=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Invoke-TrayDialogButton'},$true)
    Invoke-Expression $f.Extent.Text
    Throws { Invoke-TrayDialogButton ([IntPtr]3) 1 }
}
[ordered]@{syntheticOnly=$false;realLocalFileFixtureExecuted=$true;guiExecuted=$false;nativePInvokeExecuted=$false;passed=@($results|Where-Object {-not $_.passed}).Count -eq 0;tests=$results}|ConvertTo-Json -Depth 5 -Compress
if(@($results|Where-Object {-not $_.passed}).Count) { exit 1 }
