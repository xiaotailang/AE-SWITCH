[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$SetupFile,
    [Parameter(Mandatory)][string]$LaunchFile,
    [switch]$RestoreForSetup
)
$ErrorActionPreference = 'Stop'

function Assert-SystemWindowPath([string]$File, [string]$Root) {
    $full = [IO.Path]::GetFullPath($File)
    $boundary = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    if ($full -notmatch '^[Gg]:[\\/]' -or (-not $full.Equals($boundary, [StringComparison]::OrdinalIgnoreCase) -and -not $full.StartsWith($boundary + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase))) { throw 'Window path escaped exact G owner root' }
    for ($cursor = $full; $cursor; $cursor = [IO.Path]::GetDirectoryName($cursor)) {
        if (-not (Test-Path -LiteralPath $cursor)) { throw 'Required ordinary window owner path absent' }
        if (((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Window owner reparse path refused' }
    }
    $full
}

function Get-SystemWindowHash([string]$File) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { ([BitConverter]::ToString($algorithm.ComputeHash([IO.File]::ReadAllBytes($File)))).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}

$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$setupFull = Assert-SystemWindowPath $SetupFile (Join-Path $workspace '.cache/native-e2e-sandbox')
$setup = Get-Content -LiteralPath $setupFull -Raw -Encoding UTF8 | ConvertFrom-Json
if ($setup.schemaVersion -ne 2 -or $setup.ownerId -cnotmatch '^[a-f0-9]{32}$' -or $setup.productionSha256 -cnotmatch '^[a-f0-9]{64}$' -or $setup.sourceDigest -cnotmatch '^[a-f0-9]{64}$' -or $setup.buildAuditId -cnotmatch '^[a-f0-9]{32}$') { throw 'Current production setup identity required' }
$root = Join-Path $workspace ('.cache/native-e2e-sandbox/' + $setup.ownerId)
if ($setup.workspace -ine $workspace -or $setup.root -ine $root -or $setupFull -ine (Join-Path $root 'setup.json')) { throw 'Exact current owned window setup required' }
$launchFull = Assert-SystemWindowPath $LaunchFile $root
if ($launchFull -ine (Join-Path $root 'production-launch-receipt.json')) { throw 'Exact production launch receipt required' }
$launch = Get-Content -LiteralPath $launchFull -Raw -Encoding UTF8 | ConvertFrom-Json
$marker = Assert-SystemWindowPath (Join-Path $root '.ae-production-ui-eight-owner.json') $root
$owner = Get-Content -LiteralPath $marker -Raw -Encoding UTF8 | ConvertFrom-Json
if ($owner.schemaVersion -ne 2 -or $owner.workspace -ine $workspace) { throw 'Exact production marker required' }
foreach ($field in @('ownerId', 'productionSha256', 'sourceDigest', 'buildAuditId')) { if ($owner.$field -cne $setup.$field) { throw 'Production marker binding changed' } }
if ($launch.ownerId -cne $setup.ownerId -or $launch.productionSha256 -cne $setup.productionSha256 -or $launch.productionProgram -ine $setup.productionProgram -or $launch.retainedHandleValidated -ne $true -or $launch.cdpListener.retainedDescendantValidated -ne $true) { throw 'Retained production launch binding required' }
foreach ($record in @($setup, $launch)) { if ($record.qaHooksUsed -ne $false -or $record.discoveryContextInjected -ne $false) { throw 'Production window refuses QA hooks' } }
$program = Assert-SystemWindowPath $setup.productionProgram $root
if ([IO.Path]::GetFileName($program) -cne 'AE-Switch.exe' -or (Get-SystemWindowHash $program) -cne $setup.productionSha256) { throw 'Exact owned production executable hash required' }
$markerHash = Get-SystemWindowHash $marker
$setupHash = Get-SystemWindowHash $setupFull
$launchHash = Get-SystemWindowHash $launchFull
$expectedPid = [int]$launch.pid
if ($expectedPid -le 0) { throw 'Positive retained production PID required' }
$expectedStarted = [DateTimeOffset]::Parse($launch.startedAt).UtcDateTime

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class AEProductionOwnedWindow {
    public delegate bool EnumWindowsCallback(IntPtr hwnd, IntPtr arg);
    [DllImport("user32.dll", SetLastError=true)] static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr arg);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="GetWindowTextW", ExactSpelling=true)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="GetClassNameW", ExactSpelling=true)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("kernel32.dll", EntryPoint="QueryFullProcessImageNameW", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] static extern bool QueryImage(IntPtr process, uint flags, StringBuilder path, ref uint count);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    public static string Image(IntPtr process) {
        var text=new StringBuilder(32768); uint count=(uint)text.Capacity;
        if(!QueryImage(process,0,text,ref count)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return text.ToString();
    }
    public static long StartedTicks(IntPtr process) {
        long created,exit,kernel,user;
        if(!GetProcessTimes(process,out created,out exit,out kernel,out user)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return DateTime.FromFileTimeUtc(created).Ticks;
    }
    public static bool Alive(IntPtr process) {
        uint code; if(!GetExitCodeProcess(process,out code)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return code==259;
    }
    public static IntPtr[] MainWindows(int expectedPid) {
        var found=new List<IntPtr>();
        if(!EnumWindows((hwnd,arg)=>{
            uint pid; GetWindowThreadProcessId(hwnd,out pid);
            if(pid==(uint)expectedPid) {
                var text=new StringBuilder(256); GetWindowText(hwnd,text,text.Capacity);
                if(text.ToString()=="AE Switch") found.Add(hwnd);
            }
            return true;
        },IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return found.ToArray();
    }
    public static bool Matches(IntPtr hwnd,int expectedPid) {
        uint pid; GetWindowThreadProcessId(hwnd,out pid);
        var title=new StringBuilder(256); GetWindowText(hwnd,title,title.Capacity);
        return IsWindow(hwnd) && pid==(uint)expectedPid && title.ToString()=="AE Switch";
    }
    public static string Class(IntPtr hwnd) {
        var text=new StringBuilder(256); GetClassName(hwnd,text,text.Capacity); return text.ToString();
    }
    public static void RestoreForSetup(IntPtr hwnd,int expectedPid) {
        if(!Matches(hwnd,expectedPid)) throw new InvalidOperationException("Exact retained HWND/PID/title changed before setup restore");
        ShowWindow(hwnd,9);
    }
}
'@
$process = [Diagnostics.Process]::GetProcessById($expectedPid)
try {
    $handle = $process.Handle # Opening the retained process handle precedes every state or setup action.
    function Assert-SystemWindowProcess {
        if (-not [AEProductionOwnedWindow]::Alive($handle) -or [AEProductionOwnedWindow]::StartedTicks($handle) -ne $expectedStarted.Ticks -or [AEProductionOwnedWindow]::Image($handle) -ine $program) { throw 'Retained window process handle, creation time or image changed' }
        if ((Get-SystemWindowHash $program) -cne $setup.productionSha256 -or (Get-SystemWindowHash $marker) -cne $markerHash -or (Get-SystemWindowHash $setupFull) -cne $setupHash -or (Get-SystemWindowHash $launchFull) -cne $launchHash) { throw 'Window proof inputs changed during observation' }
    }
    Assert-SystemWindowProcess
    $windows = @([AEProductionOwnedWindow]::MainWindows($expectedPid))
    if ($windows.Count -ne 1) { throw 'One exact owned production main HWND required' }
    $hwnd = $windows[0]
    $before = @{ visible = [AEProductionOwnedWindow]::IsWindowVisible($hwnd); minimized = [AEProductionOwnedWindow]::IsIconic($hwnd); maximized = [AEProductionOwnedWindow]::IsZoomed($hwnd) }
    if ($RestoreForSetup) {
        Assert-SystemWindowProcess
        [AEProductionOwnedWindow]::RestoreForSetup($hwnd, $expectedPid)
        $deadline = [DateTime]::UtcNow.AddSeconds(5)
        while (-not [AEProductionOwnedWindow]::IsWindowVisible($hwnd) -or [AEProductionOwnedWindow]::IsIconic($hwnd)) {
            if ([DateTime]::UtcNow -ge $deadline) { throw 'Owned ShowWindow setup restore did not settle' }
            Start-Sleep -Milliseconds 30
        }
    }
    Assert-SystemWindowProcess
    if (-not [AEProductionOwnedWindow]::Matches($hwnd, $expectedPid)) { throw 'Exact owned HWND changed after state observation' }
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    [ordered]@{
        schemaVersion = 1; ownerId = $setup.ownerId; pid = $expectedPid; startedAt = $expectedStarted.ToString('o')
        productionSha256 = $setup.productionSha256; retainedHandleValidated = $true; exactHwndValidated = $true
        hwnd = $hwnd.ToInt64().ToString(); windowClass = [AEProductionOwnedWindow]::Class($hwnd)
        visible = [AEProductionOwnedWindow]::IsWindowVisible($hwnd); minimized = [AEProductionOwnedWindow]::IsIconic($hwnd); maximized = [AEProductionOwnedWindow]::IsZoomed($hwnd)
        before = $before; setupRestoreUsed = [bool]$RestoreForSetup; restoreMethod = $(if ($RestoreForSetup) { 'owned Win32 ShowWindow(SW_RESTORE) setup' } else { $null })
        trayInteraction = $false; trayRestoreClaimed = $false; processStopped = $false; recordedAt = [DateTimeOffset]::UtcNow.ToString('o')
    } | ConvertTo-Json -Depth 5 -Compress
} finally { $process.Dispose() }
