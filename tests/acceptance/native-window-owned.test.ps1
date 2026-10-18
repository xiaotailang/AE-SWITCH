[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../scripts/workspace-env.ps1')
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

# Compile the actual driver type without executing its ownership setup or any
# P/Invoke. Only the pure observation helper is called with offline delegates.
$driverPath = Join-Path $PSScriptRoot 'native-window-owned.ps1'
$sourceText = [IO.File]::ReadAllText($driverPath)
$definitions = [regex]::Matches($sourceText, "(?s)Add-Type -TypeDefinition @'\r?\n(?<source>.*?)\r?\n'@")
if ($definitions.Count -ne 1) { throw 'Expected the exact owned-window driver type definition.' }
$driverHashBefore = (Get-FileHash -LiteralPath $driverPath -Algorithm SHA256).Hash.ToLowerInvariant()
$testHashBefore = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
Add-Type -TypeDefinition ($definitions[0].Groups['source'].Value + @'

public static class AEOwnedWindowOfflineTests {
    public sealed class Gate { public string Name; public bool Passed; }
    static void Check(bool condition, string message) { if(!condition) throw new System.Exception(message); }
    static Gate Pass(string name) { return new Gate{Name=name,Passed=true}; }
    static bool Same(AEOwnedWindow.Point first,AEOwnedWindow.Point second) { return first.X==second.X && first.Y==second.Y; }
    public static Gate[] Run() {
        var gates=new System.Collections.Generic.List<Gate>();
        var target=new AEOwnedWindow.Point{X=786,Y=44};
        var other=new AEOwnedWindow.Point{X=785,Y=44};

        var immediate=new AEOwnedWindow.CursorObservation{Target=target};
        var events=new System.Collections.Generic.List<string>();
        AEOwnedWindow.ObserveCursor(immediate,()=>{events.Add("read"); return target;},()=>events.Add("guard"),500);
        Check(immediate.Reached && immediate.Samples==1 && Same(immediate.Observed,target),"An exact observed cursor must succeed on its first sample.");
        Check(events.Count==2 && events[0]=="guard" && events[1]=="read","Ownership must be revalidated before reading a cursor sample.");
        gates.Add(Pass("exact-target-revalidated-before-observation"));

        int reads=0,guards=0;
        var delayed=new AEOwnedWindow.CursorObservation{Target=target};
        AEOwnedWindow.ObserveCursor(delayed,()=>{reads++; return reads<3?other:target;},()=>guards++,500);
        Check(delayed.Reached && delayed.Samples==3 && reads==3 && guards==3 && delayed.DurationMs>=25,"Queued movement must be observable later, with a guard before every sample.");
        gates.Add(Pass("delayed-exact-target-with-no-additional-input"));

        var wrongX=new AEOwnedWindow.CursorObservation{Target=target};
        AEOwnedWindow.ObserveCursor(wrongX,()=>other,()=>{},0);
        Check(!wrongX.Reached && wrongX.Samples==1 && Same(wrongX.Observed,other),"A one-pixel X mismatch must not pass.");
        gates.Add(Pass("one-pixel-x-mismatch-rejected"));

        var wrongY=new AEOwnedWindow.CursorObservation{Target=target};
        var yMismatch=new AEOwnedWindow.Point{X=786,Y=43};
        AEOwnedWindow.ObserveCursor(wrongY,()=>yMismatch,()=>{},75);
        Check(!wrongY.Reached && wrongY.Samples>=2 && wrongY.DurationMs>=75 && Same(wrongY.Observed,yMismatch),"A permanent Y mismatch must terminate as failure after bounded observation.");
        gates.Add(Pass("permanent-y-mismatch-bounded-and-rejected"));

        reads=0;
        var initiallyLost=new AEOwnedWindow.CursorObservation{Target=target};
        bool threw=false;
        try { AEOwnedWindow.ObserveCursor(initiallyLost,()=>{reads++; return target;},()=>{throw new System.InvalidOperationException("offline-owned-identity-lost");},500); }
        catch(System.InvalidOperationException error) { threw=error.Message=="offline-owned-identity-lost"; }
        Check(threw && reads==0 && initiallyLost.Samples==0 && !initiallyLost.Reached,"Ownership loss must abort before a matching read can pass.");
        gates.Add(Pass("initial-ownership-loss-prevents-read"));

        reads=0; guards=0;
        var subsequentlyLost=new AEOwnedWindow.CursorObservation{Target=target};
        threw=false;
        try { AEOwnedWindow.ObserveCursor(subsequentlyLost,()=>{reads++; return reads==1?other:target;},()=>{guards++; if(guards==2) throw new System.InvalidOperationException("offline-foreground-lost");},500); }
        catch(System.InvalidOperationException error) { threw=error.Message=="offline-foreground-lost"; }
        Check(threw && reads==1 && subsequentlyLost.Samples==1 && !subsequentlyLost.Reached && Same(subsequentlyLost.Observed,other),"Later focus or ownership loss must retain failed observation evidence and prevent a subsequent match.");
        gates.Add(Pass("later-ownership-loss-prevents-subsequent-match"));

        var readFailed=new AEOwnedWindow.CursorObservation{Target=target};
        threw=false;
        try { AEOwnedWindow.ObserveCursor(readFailed,()=>{throw new System.InvalidOperationException("offline-cursor-read-failed");},()=>{},500); }
        catch(System.InvalidOperationException error) { threw=error.Message=="offline-cursor-read-failed"; }
        Check(threw && readFailed.Samples==0 && !readFailed.Reached,"A failed cursor read must not produce a successful observation.");
        gates.Add(Pass("cursor-read-failure-propagates"));

        foreach(int timeout in new[]{-1,501}) {
            guards=0; reads=0; threw=false;
            try { AEOwnedWindow.ObserveCursor(new AEOwnedWindow.CursorObservation{Target=target},()=>{reads++; return target;},()=>guards++,timeout); }
            catch(System.ArgumentException) { threw=true; }
            Check(threw && guards==0 && reads==0,"A timeout outside the strict 0..500 ms bound must fail before observation.");
        }
        gates.Add(Pass("invalid-observation-bound-rejected"));

        guards=0; reads=0;
        var lateGuard=new AEOwnedWindow.CursorObservation{Target=target};
        AEOwnedWindow.ObserveCursor(lateGuard,()=>{reads++; return target;},()=>{guards++; System.Threading.Thread.Sleep(600);},500);
        Check(!lateGuard.Reached && lateGuard.Samples==1 && lateGuard.DurationMs>=600 && guards==1 && reads==1 && Same(lateGuard.Observed,target),"An exact sample after a delayed guard and the 500 ms deadline must retain evidence without establishing success.");
        gates.Add(Pass("guard600ms-timeout500ms-late-exact-rejected"));

        guards=0; reads=0;
        var lateRead=new AEOwnedWindow.CursorObservation{Target=target};
        AEOwnedWindow.ObserveCursor(lateRead,()=>{reads++; System.Threading.Thread.Sleep(600); return target;},()=>guards++,500);
        Check(!lateRead.Reached && lateRead.Samples==1 && lateRead.DurationMs>=600 && guards==1 && reads==1 && Same(lateRead.Observed,target),"An exact sample after a delayed cursor read and the 500 ms deadline must retain evidence without establishing success.");
        gates.Add(Pass("cursor600ms-timeout500ms-late-exact-rejected"));

        guards=0; reads=0;
        var early=new AEOwnedWindow.CursorObservation{Target=target};
        AEOwnedWindow.ObserveCursor(early,()=>{reads++; return target;},()=>{guards++; System.Threading.Thread.Sleep(20);},500);
        Check(early.Reached && early.Samples==1 && early.DurationMs>=20 && early.DurationMs<=500 && guards==1 && reads==1 && Same(early.Observed,target),"A revalidated exact sample before the deadline must continue to succeed.");
        gates.Add(Pass("early-exact-success-before-deadline"));
        return gates.ToArray();
    }
}
'@)

$gates = @([AEOwnedWindowOfflineTests]::Run())
$driverHashAfter = (Get-FileHash -LiteralPath $driverPath -Algorithm SHA256).Hash.ToLowerInvariant()
$testHashAfter = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($driverHashAfter -cne $driverHashBefore -or $testHashAfter -cne $testHashBefore) { throw 'Offline test sources changed while running.' }
if ($gates.Count -ne 11 -or @($gates | Where-Object { -not $_.Passed }).Count) { throw 'The offline cursor observation gates did not all pass.' }
[ordered]@{
    recordedAt = [DateTimeOffset]::UtcNow.ToString('o')
    scope = 'Offline real-driver C# compilation and pure cursor observation; no Win32 call or physical input.'
    passed = $true
    physicalInputExecuted = $false
    guiExecuted = $false
    nativeWindowPassed = $false
    driverSha256 = $driverHashAfter
    testSha256 = $testHashAfter
    gates = $gates
} | ConvertTo-Json -Depth 5
