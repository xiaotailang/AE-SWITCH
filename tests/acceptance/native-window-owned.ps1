[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][int]$OwnedProcessId,
    [Parameter(Mandatory = $true)][string]$OwnedRoot,
    [Parameter(Mandatory = $true)][string]$ExpectedSha256,
    [Parameter(Mandatory = $true)][string]$ExpectedStartedAt,
    [ValidateSet('state', 'restore', 'resize', 'bounds', 'activate', 'drag')][string]$Action = 'state',
    [ValidateRange(760, 1600)][int]$ClientWidth = 1120,
    [ValidateRange(600, 1000)][int]$ClientHeight = 780,
    [ValidateRange(760, 1800)][int]$OuterWidth = 1120,
    [ValidateRange(600, 1400)][int]$OuterHeight = 780,
    [double]$CssX = 0,
    [double]$CssY = 0,
    [double]$CssViewportWidth = 0,
    [double]$CssViewportHeight = 0
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../scripts/workspace-env.ps1')
# The parent can be PowerShell 7, whose inherited module path omits Windows
# PowerShell's own modules. Load only this system-supplied module by exact path.
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$windowRoot = [IO.Path]::GetFullPath($OwnedRoot)
$windowBase = [IO.Path]::GetFullPath((Join-Path $env:AE_WORKSPACE '.cache/native-e2e-sandbox'))
$windowSandbox = [IO.Path]::GetDirectoryName($windowRoot)
$windowId = [IO.Path]::GetFileName($windowSandbox)
function Assert-WindowOwner {
    if ($script:windowRoot -cne $OwnedRoot.Replace('/', '\') -or [IO.Path]::GetPathRoot($script:windowRoot) -cne 'G:\' -or [IO.Path]::GetFileName($script:windowRoot) -cne 'portable' -or $script:windowId -cnotmatch '^[a-f0-9]{32}$' -or [IO.Path]::GetDirectoryName($script:windowSandbox) -cne $script:windowBase) { throw 'An exact owned native UUID/portable root is required.' }
    for ($ancestor = $script:windowRoot; $ancestor; $ancestor = [IO.Path]::GetDirectoryName($ancestor)) {
        $metadata = Get-Item -LiteralPath $ancestor -Force
        if (-not $metadata.PSIsContainer -or ($metadata.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Window ownership paths cannot be redirected.' }
    }
    $texts = @()
    foreach ($directory in @($script:windowSandbox, $script:windowRoot)) {
        $markerPath = Join-Path $directory '.ae-native-e2e-owner.json'
        $metadata = Get-Item -LiteralPath $markerPath -Force
        if ($metadata.PSIsContainer -or ($metadata.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $metadata.LinkType -or $metadata.Length -le 0 -or $metadata.Length -gt 8192) { throw 'Window ownership marker must be a bounded ordinary file without aliases.' }
        $text = [IO.File]::ReadAllText($markerPath)
        $marker = $text | ConvertFrom-Json
        if ($marker.id -cne $script:windowId -or $marker.workspace -cne $env:AE_WORKSPACE -or $marker.purpose -cne 'AE Switch owned native UI and real tool acceptance') { throw 'Window ownership marker mismatch.' }
        $texts += $text
    }
    if ($texts[0] -cne $texts[1]) { throw 'The portable window marker must copy its UUID owner exactly.' }
    return $texts[1]
}
$windowMarkerText = Assert-WindowOwner
$windowMarkerPath = Join-Path $windowRoot '.ae-native-e2e-owner.json'
$windowExe = Join-Path $windowRoot 'AE-Switch-QA.exe'
$windowFile = Get-Item -LiteralPath $windowExe -Force
if ($windowFile.PSIsContainer -or ($windowFile.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $windowFile.LinkType -or (Get-FileHash -LiteralPath $windowExe -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedSha256) { throw 'Window executable identity mismatch.' }
$windowProcess = Get-Process -Id $OwnedProcessId -ErrorAction Stop
$windowCreation = [DateTimeOffset]::Parse($ExpectedStartedAt).UtcDateTime
if ($windowProcess.Path -cne $windowExe -or $windowProcess.StartTime.ToUniversalTime().Ticks -ne $windowCreation.Ticks) { throw 'Owned process identity changed.' }

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
public static class AEOwnedWindow {
    public delegate bool Callback(IntPtr h, IntPtr p);
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct MouseInput { public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] struct Input { public uint Type; public MouseInput Mouse; }
    [StructLayout(LayoutKind.Sequential)] struct MonitorInfo { public uint Size; public Rect Monitor, Work; public uint Flags; }
    public sealed class MoveReceipt { public Point Target, Normalized; public Rect VirtualDesktop; }
    public sealed class CursorObservation { public Point Target, Observed; public int DurationMs, Samples; public bool Reached; }
    public sealed class DragReceipt {
        public string InputSource="SendInput", CoordinateSpace="physical", MainHwnd, Phase="identity", Failure, CleanupFailure;
        public Rect Before, AfterInput, RestoredBounds, PhysicalClientScreen;
        public Point StartPoint, EndPoint;
        public int RequestedDeltaX, RequestedDeltaY, ActualDeltaX, ActualDeltaY, InputCount;
        public uint Dpi;
        public bool MovedByInput, Restored, MouseReleased, ForegroundVerified, PerInputOwnershipVerified;
        public MoveReceipt LastMove;
        public CursorObservation CursorAfterMove;
    }
    public sealed class ActivationReceipt {
        public string ActualSource="owned-SendInput-click", CoordinateSpace="physical", MainHwnd, ForegroundBefore, ForegroundAfter, Phase="identity", Failure, CleanupFailure;
        public bool SetupOnly=true, DragPassed=false, AlreadyForeground, ClickSent, MouseReleased, ObservedForeground, OwnershipVerified, PerInputOwnershipVerified, DpiContextRestored;
        public int InputCount=0, PollDurationMs, DoubleClickIntervalMs;
        public Rect Before, AfterClick, PhysicalClientScreen;
        public Point ClickPoint;
        public MoveReceipt Move;
        public CursorObservation CursorAfterMove;
    }
    [DllImport("user32.dll")] static extern bool EnumWindows(Callback cb, IntPtr p);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder text, int size);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder text, int size);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Rect r);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out Rect r);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int height, uint flags);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern uint GetDoubleClickTime();
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll",SetLastError=true)] static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll",SetLastError=true)] static extern bool ClientToScreen(IntPtr h, ref Point point);
    [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count, Input[] input, int size);
    [DllImport("user32.dll",SetLastError=true)] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("kernel32.dll",EntryPoint="QueryFullProcessImageNameW",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] static extern bool QueryImage(IntPtr process, uint flags, StringBuilder name, ref uint size);
    public static IntPtr Find(int pid) {
        var windows=new List<IntPtr>();
        EnumWindows((h,p)=> {
            uint found; GetWindowThreadProcessId(h,out found);
            if(found!=pid) return true;
            var title=new StringBuilder(256); var cls=new StringBuilder(256);
            GetWindowText(h,title,256); GetClassName(h,cls,256);
            if(title.ToString()=="AE Switch" && cls.ToString()=="Tauri Window") windows.Add(h);
            return true;
        },IntPtr.Zero);
        if(windows.Count!=1) throw new Exception("Expected one exact owned Tauri window.");
        return windows[0];
    }
    public static Rect Bounds(IntPtr h) { Rect r; if(!GetWindowRect(h,out r)) throw new Exception("Window bounds failed."); return r; }
    public static Rect Client(IntPtr h) { Rect r; if(!GetClientRect(h,out r)) throw new Exception("Client bounds failed."); return r; }
    public static void Restore(IntPtr h) { ShowWindow(h,9); }
    public static void Resize(IntPtr h,int width,int height) {
        if(!IsWindowVisible(h)||IsIconic(h)||IsZoomed(h)) throw new Exception("Resize requires a visible restored owned window.");
        // PowerShell's DPI-unaware Win32 caller receives virtualized logical
        // coordinates. Applying the window DPI again would scale twice.
        var r=Bounds(h);var c=Client(h);
        int w=width+r.Right-r.Left-c.Right+c.Left;
        int ht=height+r.Bottom-r.Top-c.Bottom+c.Top;
        if(!SetWindowPos(h,IntPtr.Zero,r.Left,r.Top,w,ht,0x0014)) throw new Exception("Owned resize failed.");
    }
    public static void ResizeBounds(IntPtr h,int width,int height) {
        if(!IsWindowVisible(h)||IsIconic(h)||IsZoomed(h)) throw new Exception("Bounds restore requires a visible restored owned window.");
        var r=Bounds(h);
        if(!SetWindowPos(h,IntPtr.Zero,r.Left,r.Top,width,height,0x0014)) throw new Exception("Owned bounds restore failed.");
    }
    static void OrdinaryPath(string path, bool directory) {
        var attributes=File.GetAttributes(path);
        if((attributes & FileAttributes.ReparsePoint)!=0 || ((attributes & FileAttributes.Directory)!=0)!=directory) throw new Exception("Owned drag paths changed or were redirected.");
    }
    static void Guard(Process process, IntPtr retainedHandle, long startedTicks, string exe, string marker, IntPtr window) {
        process.Refresh();
        if(process.HasExited || process.StartTime.ToUniversalTime().Ticks!=startedTicks) throw new Exception("Retained drag process exited or changed generation.");
        var name=new StringBuilder(32768); uint length=32768;
        if(!QueryImage(retainedHandle,0,name,ref length) || name.ToString()!=exe) throw new Exception("Retained drag executable identity changed.");
        OrdinaryPath(exe,false); OrdinaryPath(marker,false);
        string uuidMarker=Path.Combine(Path.GetDirectoryName(Path.GetDirectoryName(marker)),".ae-native-e2e-owner.json");
        OrdinaryPath(uuidMarker,false);
        if(new FileInfo(uuidMarker).Length>8192 || File.ReadAllText(uuidMarker)!=File.ReadAllText(marker)) throw new Exception("Retained UUID and portable owner markers changed or diverged.");
        for(string ancestor=Path.GetDirectoryName(exe); !String.IsNullOrEmpty(ancestor); ancestor=Path.GetDirectoryName(ancestor)) OrdinaryPath(ancestor,true);
        uint found; GetWindowThreadProcessId(window,out found);
        if(found!=(uint)process.Id || Find(process.Id)!=window || GetAncestor(window,2)!=window) throw new Exception("The retained main drag HWND changed.");
    }
    static void Ready(IntPtr window) {
        if(!IsWindowVisible(window) || IsIconic(window) || IsZoomed(window) || GetForegroundWindow()!=window) throw new Exception("Drag requires the visible restored owned foreground window.");
    }
    static void Hit(IntPtr window, Point point) {
        var hit=WindowFromPoint(point);
        // WebView child HWNDs can belong to a browser subprocess. Their exact
        // top-level ancestor must still be the retained owned Tauri HWND.
        if(hit==IntPtr.Zero || GetAncestor(hit,2)!=window) throw new Exception("The owned drag point is obscured or belongs to a different window.");
    }
    static Point Cursor() { Point p; if(!GetCursorPos(out p)) throw new Win32Exception(Marshal.GetLastWin32Error()); return p; }
    static bool OtherButtonDown() { return (GetAsyncKeyState(2)&0x8000)!=0 || (GetAsyncKeyState(4)&0x8000)!=0 || (GetAsyncKeyState(5)&0x8000)!=0 || (GetAsyncKeyState(6)&0x8000)!=0; }
    // Observe the one queued movement without sending another input. Every
    // sample revalidates the retained owned target; success still requires
    // the exact physical pixel, and focus/geometry/input changes fail closed.
    public static void ObserveCursor(CursorObservation result, Func<Point> readCursor, Action revalidate, int timeoutMs) {
        if(result==null || readCursor==null || revalidate==null || timeoutMs<0 || timeoutMs>500) throw new ArgumentException("A bounded cursor observation is required.");
        var wait=Stopwatch.StartNew();
        while(true) {
            revalidate(); result.Observed=readCursor(); result.Samples++; result.DurationMs=(int)wait.ElapsedMilliseconds;
            result.Reached=wait.Elapsed.TotalMilliseconds<=timeoutMs && result.Observed.X==result.Target.X && result.Observed.Y==result.Target.Y;
            if(result.Reached || result.DurationMs>=timeoutMs) return;
            Thread.Sleep(Math.Min(25,timeoutMs-result.DurationMs));
        }
    }
    static MoveReceipt Send(uint flags, Point point) {
        var mouse=new MouseInput{Flags=flags};
        MoveReceipt receipt=null;
        if((flags&0x0001)!=0) {
            int left=GetSystemMetrics(76),top=GetSystemMetrics(77),width=GetSystemMetrics(78),height=GetSystemMetrics(79);
            if(width<=1 || height<=1 || point.X<left || point.Y<top || (long)point.X>=(long)left+width || (long)point.Y>=(long)top+height) throw new Exception("Owned drag input is outside the virtual desktop.");
            mouse.X=(int)((((long)point.X-left)*65536+32768)/width);
            mouse.Y=(int)((((long)point.Y-top)*65536+32768)/height);
            mouse.Flags|=0x4000|0x8000;
            receipt=new MoveReceipt{Target=point,Normalized=new Point{X=mouse.X,Y=mouse.Y},VirtualDesktop=new Rect{Left=left,Top=top,Right=left+width,Bottom=top+height}};
        }
        if(SendInput(1,new[]{new Input{Mouse=mouse}},Marshal.SizeOf(typeof(Input)))!=1) throw new Win32Exception(Marshal.GetLastWin32Error());
        return receipt;
    }
    static bool Same(Rect a, Rect b) { return a.Left==b.Left && a.Top==b.Top && a.Right==b.Right && a.Bottom==b.Bottom; }
    static int Delta(int first, int last, int lower, int upper, int distance) {
        if(first>=lower+12 && (long)last+distance<=upper-12) return distance;
        if((long)first-distance>=lower+12 && last<=upper-12) return -distance;
        throw new Exception("The owned window has no safe bounded drag room inside its monitor work area.");
    }
    public static ActivationReceipt Activate(Process process, long startedTicks, string exe, string sha256, string marker, string markerText, IntPtr window, double cssX, double cssY, double viewportWidth, double viewportHeight) {
        var result=new ActivationReceipt{MainHwnd=window.ToInt64().ToString("x")};
        IntPtr retainedHandle=process.Handle,previousDpi=IntPtr.Zero; bool down=false; FileStream image=null,owner=null;
        try {
            previousDpi=SetThreadDpiAwarenessContext(new IntPtr(-4));
            if(previousDpi==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            // The actual click uses the same physical DOM/client mapping and
            // image/marker locks as drag, without requiring foreground first.
            image=new FileStream(exe,FileMode.Open,FileAccess.Read,FileShare.Read);
            owner=new FileStream(marker,FileMode.Open,FileAccess.Read,FileShare.Read);
            using(var hash=SHA256.Create()) if(BitConverter.ToString(hash.ComputeHash(image)).Replace("-","").ToLowerInvariant()!=sha256) throw new Exception("Locked activation executable hash mismatch.");
            using(var reader=new StreamReader(owner,Encoding.UTF8,true,4096,true)) if(reader.ReadToEnd()!=markerText) throw new Exception("Locked activation marker changed after verification.");
            Action ownedVisible=()=> {
                Guard(process,retainedHandle,startedTicks,exe,marker,window);
                if(!IsWindowVisible(window) || IsIconic(window) || IsZoomed(window)) throw new Exception("Activation setup requires a visible restored owned main window.");
            };
            ownedVisible();
            if(Double.IsNaN(cssX) || Double.IsNaN(cssY) || Double.IsNaN(viewportWidth) || Double.IsNaN(viewportHeight) || Double.IsInfinity(cssX) || Double.IsInfinity(cssY) || Double.IsInfinity(viewportWidth) || Double.IsInfinity(viewportHeight) || viewportWidth<1 || viewportHeight<1 || cssX<=0 || cssY<=0 || cssX>=viewportWidth || cssY>=viewportHeight) throw new Exception("An actual interior DOM activation point and viewport are required.");
            result.Before=Bounds(window); var client=Client(window); var origin=new Point{X=client.Left,Y=client.Top};
            if(!ClientToScreen(window,ref origin)) throw new Win32Exception(Marshal.GetLastWin32Error());
            result.PhysicalClientScreen=new Rect{Left=origin.X,Top=origin.Y,Right=origin.X+client.Right-client.Left,Bottom=origin.Y+client.Bottom-client.Top};
            result.ClickPoint=new Point{X=origin.X+(int)Math.Round(cssX*(client.Right-client.Left)/viewportWidth),Y=origin.Y+(int)Math.Round(cssY*(client.Bottom-client.Top)/viewportHeight)};
            if(result.ClickPoint.X<=result.PhysicalClientScreen.Left || result.ClickPoint.X>=result.PhysicalClientScreen.Right-1 || result.ClickPoint.Y<=result.PhysicalClientScreen.Top || result.ClickPoint.Y>=result.PhysicalClientScreen.Bottom-1) throw new Exception("The DOM activation point mapped outside the owned physical client.");
            result.ForegroundBefore=GetForegroundWindow().ToInt64().ToString("x"); result.AlreadyForeground=GetForegroundWindow()==window;
            Action<bool,bool> beforeInput=(expectDown,requireCursor)=> {
                ownedVisible(); Hit(window,result.ClickPoint);
                if(!Same(Bounds(window),result.Before)) throw new Exception("Owned activation bounds changed before input.");
                if(OtherButtonDown() || ((GetAsyncKeyState(1)&0x8000)!=0)!=expectDown) throw new Exception("Physical mouse state changed during owned activation setup.");
                if(requireCursor) { var cursor=Cursor(); if(cursor.X!=result.ClickPoint.X || cursor.Y!=result.ClickPoint.Y) throw new Exception("The owned activation cursor changed before button input."); Hit(window,cursor); }
            };
            result.Phase="activation-move-to-dom-region"; beforeInput(false,false); result.Move=Send(0x0001,result.ClickPoint); result.InputCount++;
            result.CursorAfterMove=new CursorObservation{Target=result.ClickPoint};
            Thread.Sleep(40);
            ObserveCursor(result.CursorAfterMove,Cursor,()=>beforeInput(false,false),500);
            if(!result.CursorAfterMove.Reached) throw new Exception("The actual cursor did not reach the owned activation point within the bounded observation.");
            result.Phase="activation-left-down"; beforeInput(false,true); Send(0x0002,result.ClickPoint); down=true; result.InputCount++;
            Thread.Sleep(60);
            result.Phase="activation-left-up"; beforeInput(true,true); Send(0x0004,result.ClickPoint); down=false; result.InputCount++; result.MouseReleased=true; result.ClickSent=true; result.PerInputOwnershipVerified=true;
            // The later drag starts at this same region center. Let the
            // actual system double-click interval expire so its LEFTDOWN
            // cannot accidentally toggle the product title bar maximize.
            result.DoubleClickIntervalMs=(int)GetDoubleClickTime();
            if(result.DoubleClickIntervalMs<1 || result.DoubleClickIntervalMs>5000) throw new Exception("The actual system double-click interval is outside its documented bound.");
            Thread.Sleep(result.DoubleClickIntervalMs+50);
            result.Phase="observe-owned-foreground"; var wait=Stopwatch.StartNew();
            do {
                ownedVisible(); var foreground=GetForegroundWindow(); result.ForegroundAfter=foreground.ToInt64().ToString("x"); result.ObservedForeground=foreground==window;
                if(result.ObservedForeground) break;
                Thread.Sleep(25);
            } while(wait.ElapsedMilliseconds<1000);
            result.PollDurationMs=(int)wait.ElapsedMilliseconds;
            if(!result.ObservedForeground) throw new Exception("The actual owned click did not activate the exact owned main HWND.");
            result.AfterClick=Bounds(window);
            if(!Same(result.Before,result.AfterClick)) throw new Exception("Activation must be an in-place click without native window displacement.");
            // Activation is setup evidence only. Drag retains all of its own
            // strict foreground and hit checks before every subsequent input.
            Ready(window); result.OwnershipVerified=true; result.Phase="setup-observed";
        } catch(Exception error) { result.ForegroundAfter=GetForegroundWindow().ToInt64().ToString("x"); result.Failure=result.Phase+": "+error.Message; }
        finally {
            if(down) {
                try { Guard(process,retainedHandle,startedTicks,exe,marker,window); Hit(window,Cursor()); }
                catch(Exception error) { result.CleanupFailure="release-revalidation: "+error.Message; }
                // Release only the outstanding button down from this helper;
                // cleanup never starts a gesture or moves to another window.
                try { Send(0x0004,new Point()); result.InputCount++; result.MouseReleased=true; }
                catch(Exception error) { result.CleanupFailure=(result.CleanupFailure??"")+" release: "+error.Message; }
            }
            if(owner!=null) owner.Dispose(); if(image!=null) image.Dispose();
            if(previousDpi!=IntPtr.Zero) {
                result.DpiContextRestored=SetThreadDpiAwarenessContext(previousDpi)!=IntPtr.Zero;
                if(!result.DpiContextRestored) result.CleanupFailure=(result.CleanupFailure??"")+" DPI context restoration failed.";
            }
        }
        return result;
    }
    public static DragReceipt Drag(Process process, long startedTicks, string exe, string sha256, string marker, string markerText, IntPtr window, double cssX, double cssY, double viewportWidth, double viewportHeight) {
        var result=new DragReceipt{MainHwnd=window.ToInt64().ToString("x")};
        IntPtr previousDpi=IntPtr.Zero; bool down=false,captured=false; FileStream image=null,owner=null;
        // Retain the kernel process handle throughout the gesture so PID reuse
        // cannot supply a replacement process to any ownership check.
        IntPtr retainedHandle=process.Handle;
        try {
            previousDpi=SetThreadDpiAwarenessContext(new IntPtr(-4));
            if(previousDpi==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            image=new FileStream(exe,FileMode.Open,FileAccess.Read,FileShare.Read);
            using(var hash=SHA256.Create()) if(BitConverter.ToString(hash.ComputeHash(image)).Replace("-","").ToLowerInvariant()!=sha256) throw new Exception("Locked drag executable hash mismatch.");
            owner=new FileStream(marker,FileMode.Open,FileAccess.Read,FileShare.Read);
            using(var reader=new StreamReader(owner,Encoding.UTF8,true,4096,true)) if(reader.ReadToEnd()!=markerText) throw new Exception("Locked drag marker changed after verification.");
            Action identity=()=>Guard(process,retainedHandle,startedTicks,exe,marker,window);
            identity(); Ready(window); result.ForegroundVerified=true;
            if(OtherButtonDown() || (GetAsyncKeyState(1)&0x8000)!=0) throw new Exception("An existing physical mouse gesture prevents owned drag input.");
            if(Double.IsNaN(cssX) || Double.IsNaN(cssY) || Double.IsNaN(viewportWidth) || Double.IsNaN(viewportHeight) || Double.IsInfinity(cssX) || Double.IsInfinity(cssY) || Double.IsInfinity(viewportWidth) || Double.IsInfinity(viewportHeight) || viewportWidth<1 || viewportHeight<1 || cssX<=0 || cssY<=0 || cssX>=viewportWidth || cssY>=viewportHeight) throw new Exception("An actual interior DOM drag point and viewport are required.");
            result.Before=Bounds(window); captured=true; result.Dpi=GetDpiForWindow(window);
            var client=Client(window); var origin=new Point{X=client.Left,Y=client.Top};
            if(!ClientToScreen(window,ref origin)) throw new Win32Exception(Marshal.GetLastWin32Error());
            result.PhysicalClientScreen=new Rect{Left=origin.X,Top=origin.Y,Right=origin.X+client.Right-client.Left,Bottom=origin.Y+client.Bottom-client.Top};
            result.StartPoint=new Point{X=origin.X+(int)Math.Round(cssX*(client.Right-client.Left)/viewportWidth),Y=origin.Y+(int)Math.Round(cssY*(client.Bottom-client.Top)/viewportHeight)};
            if(result.StartPoint.X<=result.PhysicalClientScreen.Left || result.StartPoint.X>=result.PhysicalClientScreen.Right-1 || result.StartPoint.Y<=result.PhysicalClientScreen.Top || result.StartPoint.Y>=result.PhysicalClientScreen.Bottom-1) throw new Exception("The DOM drag point mapped outside the owned physical client.");
            var monitor=new MonitorInfo{Size=(uint)Marshal.SizeOf(typeof(MonitorInfo))};
            if(!GetMonitorInfo(MonitorFromWindow(window,2),ref monitor)) throw new Win32Exception(Marshal.GetLastWin32Error());
            result.RequestedDeltaX=Delta(result.Before.Left,result.Before.Right,monitor.Work.Left,monitor.Work.Right,48);
            result.RequestedDeltaY=Delta(result.Before.Top,result.Before.Bottom,monitor.Work.Top,monitor.Work.Bottom,36);
            Action<Point,bool> beforeInput=(point,expectDown)=> {
                identity(); Ready(window); Hit(window,point);
                if(OtherButtonDown() || ((GetAsyncKeyState(1)&0x8000)!=0)!=expectDown) throw new Exception("Physical mouse state changed during the owned gesture.");
                if(expectDown) { var current=Cursor(); Hit(window,current); }
            };
            result.Phase="move-to-dom-region"; beforeInput(result.StartPoint,false); result.LastMove=Send(0x0001,result.StartPoint); result.InputCount++;
            result.CursorAfterMove=new CursorObservation{Target=result.StartPoint};
            Thread.Sleep(40);
            ObserveCursor(result.CursorAfterMove,Cursor,()=>{ beforeInput(result.StartPoint,false); if(!Same(Bounds(window),result.Before)) throw new Exception("Owned drag start geometry changed."); },500);
            if(!result.CursorAfterMove.Reached) throw new Exception("The actual cursor did not reach the owned drag start within the bounded observation.");
            result.Phase="left-down"; beforeInput(result.StartPoint,false); Send(0x0002,result.StartPoint); down=true; result.InputCount++;
            Thread.Sleep(80);
            for(int step=1;step<=8;step++) {
                result.Phase="drag-step-"+step;
                var point=new Point{X=result.StartPoint.X+result.RequestedDeltaX*step/8,Y=result.StartPoint.Y+result.RequestedDeltaY*step/8};
                beforeInput(point,true); result.LastMove=Send(0x0001,point); result.InputCount++; result.EndPoint=point;
                result.CursorAfterMove=new CursorObservation{Target=point};
                Thread.Sleep(35);
                ObserveCursor(result.CursorAfterMove,Cursor,()=>beforeInput(point,true),500);
                if(!result.CursorAfterMove.Reached) throw new Exception("The physical cursor did not reach the owned drag step within the bounded observation.");
            }
            result.Phase="left-up"; beforeInput(result.EndPoint,true); Send(0x0004,result.EndPoint); down=false; result.InputCount++; result.MouseReleased=true;
            result.PerInputOwnershipVerified=true; result.Phase="observe-actual-window-displacement";
            var wait=Stopwatch.StartNew();
            do {
                identity(); Ready(window); result.AfterInput=Bounds(window);
                result.ActualDeltaX=result.AfterInput.Left-result.Before.Left; result.ActualDeltaY=result.AfterInput.Top-result.Before.Top;
                if(Math.Abs(result.ActualDeltaX-result.RequestedDeltaX)<=2 && Math.Abs(result.ActualDeltaY-result.RequestedDeltaY)<=2) break;
                Thread.Sleep(25);
            } while(wait.ElapsedMilliseconds<750);
            if(Math.Abs(result.ActualDeltaX-result.RequestedDeltaX)>2 || Math.Abs(result.ActualDeltaY-result.RequestedDeltaY)>2 || result.AfterInput.Right-result.AfterInput.Left!=result.Before.Right-result.Before.Left || result.AfterInput.Bottom-result.AfterInput.Top!=result.Before.Bottom-result.Before.Top) throw new Exception("SendInput did not produce the expected actual owned window displacement.");
            // This observation precedes every SetWindowPos call; restoration
            // can never manufacture a passing drag receipt.
            result.MovedByInput=true; result.Phase="observed";
        } catch(Exception error) { result.Failure=result.Phase+": "+error.Message; }
        finally {
            if(down) {
                // Revalidate before releasing our outstanding gesture. Even
                // on ownership/focus loss, LEFTUP is mandatory cleanup; it
                // never introduces a new click, cursor move or button down.
                try { Guard(process,retainedHandle,startedTicks,exe,marker,window); Ready(window); Hit(window,Cursor()); }
                catch(Exception error) { result.CleanupFailure="release-revalidation: "+error.Message; }
                try { Send(0x0004,new Point()); result.InputCount++; result.MouseReleased=true; }
                catch(Exception error) { result.CleanupFailure=(result.CleanupFailure??"")+" release: "+error.Message; }
            }
            if(captured) {
                try {
                    Guard(process,retainedHandle,startedTicks,exe,marker,window);
                    if(!IsWindowVisible(window) || IsIconic(window) || IsZoomed(window)) throw new Exception("Owned window state changed before position restoration.");
                    if(!SetWindowPos(window,IntPtr.Zero,result.Before.Left,result.Before.Top,result.Before.Right-result.Before.Left,result.Before.Bottom-result.Before.Top,0x0014)) throw new Win32Exception(Marshal.GetLastWin32Error());
                    result.RestoredBounds=Bounds(window); result.Restored=Same(result.Before,result.RestoredBounds);
                    if(!result.Restored) throw new Exception("Owned window did not return to its original physical bounds.");
                } catch(Exception error) { result.CleanupFailure=(result.CleanupFailure??"")+" restore: "+error.Message; }
            }
            if(owner!=null) owner.Dispose(); if(image!=null) image.Dispose();
            if(previousDpi!=IntPtr.Zero && SetThreadDpiAwarenessContext(previousDpi)==IntPtr.Zero) result.CleanupFailure=(result.CleanupFailure??"")+" DPI context restoration failed.";
        }
        return result;
    }
}
'@
$windowHandle = [AEOwnedWindow]::Find($OwnedProcessId)
# Recheck the retained identity immediately before any window mutation.
$windowProcess.Refresh()
if ($windowProcess.HasExited -or $windowProcess.StartTime.ToUniversalTime().Ticks -ne $windowCreation.Ticks) { throw 'Owned process exited or was replaced.' }
switch ($Action) {
    'restore' { [AEOwnedWindow]::Restore($windowHandle) }
    'resize' { [AEOwnedWindow]::Resize($windowHandle, $ClientWidth, $ClientHeight) }
    'bounds' { [AEOwnedWindow]::ResizeBounds($windowHandle, $OuterWidth, $OuterHeight) }
    'activate' {
        $windowActivation = [AEOwnedWindow]::Activate($windowProcess, $windowCreation.Ticks, $windowExe, $ExpectedSha256, $windowMarkerPath, $windowMarkerText, $windowHandle, $CssX, $CssY, $CssViewportWidth, $CssViewportHeight)
        [ordered]@{
            pid = $OwnedProcessId
            ownedId = $windowId
            startedAt = $ExpectedStartedAt
            sha256 = $ExpectedSha256
            verifiedOwnedIdentity = $true
            action = $Action
            activation = $windowActivation
        } | ConvertTo-Json -Compress -Depth 6
        return
    }
    'drag' {
        $windowActivation = [AEOwnedWindow]::Activate($windowProcess, $windowCreation.Ticks, $windowExe, $ExpectedSha256, $windowMarkerPath, $windowMarkerText, $windowHandle, $CssX, $CssY, $CssViewportWidth, $CssViewportHeight)
        $windowDrag = $null
        if ($null -eq $windowActivation.Failure -and $null -eq $windowActivation.CleanupFailure -and $windowActivation.ObservedForeground) {
            $windowDrag = [AEOwnedWindow]::Drag($windowProcess, $windowCreation.Ticks, $windowExe, $ExpectedSha256, $windowMarkerPath, $windowMarkerText, $windowHandle, $CssX, $CssY, $CssViewportWidth, $CssViewportHeight)
        }
        [ordered]@{
            pid = $OwnedProcessId
            ownedId = $windowId
            startedAt = $ExpectedStartedAt
            sha256 = $ExpectedSha256
            verifiedOwnedIdentity = $true
            action = $Action
            activation = $windowActivation
            drag = $windowDrag
        } | ConvertTo-Json -Compress -Depth 6
        return
    }
}
$windowBounds = [AEOwnedWindow]::Bounds($windowHandle)
$windowClient = [AEOwnedWindow]::Client($windowHandle)
[ordered]@{
    pid = $OwnedProcessId
    visible = [AEOwnedWindow]::IsWindowVisible($windowHandle)
    minimized = [AEOwnedWindow]::IsIconic($windowHandle)
    maximized = [AEOwnedWindow]::IsZoomed($windowHandle)
    left = $windowBounds.Left
    top = $windowBounds.Top
    width = $windowBounds.Right - $windowBounds.Left
    height = $windowBounds.Bottom - $windowBounds.Top
    clientWidth = $windowClient.Right - $windowClient.Left
    clientHeight = $windowClient.Bottom - $windowClient.Top
    dpi = [AEOwnedWindow]::GetDpiForWindow($windowHandle)
    action = $Action
    verifiedOwnedIdentity = $true
} | ConvertTo-Json -Compress
