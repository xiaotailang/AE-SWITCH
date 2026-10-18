[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PackageDirectory,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedDesktopSha256
)

# Prepared release-only acceptance. This script does not exercise ordinary UI
# buttons, tools, registry persistence, browser links or client restarts.
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'Owned desktop runtime acceptance requires PowerShell 7.' }
. (Join-Path $PSScriptRoot 'workspace-env.ps1')
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
Import-Module (Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell/v1.0/Modules/NetTCPIP/NetTCPIP.psd1') -ErrorAction Stop
$runtimeWorkspace = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$runtimeBase = Join-Path $runtimeWorkspace '.cache/desktop-runtime-sandbox'
$runtimeId = [Guid]::NewGuid().ToString('N')
$runtimeRoot = Join-Path $runtimeBase $runtimeId
$runtimeMarker = Join-Path $runtimeRoot '.ae-desktop-runtime-owner.json'
$runtimeReportPath = Join-Path $runtimeWorkspace "artifacts/acceptance/desktop-runtime-$runtimeId.json"
$runtimePurpose = 'AE Switch owned release background and single-instance acceptance'
$runtimeUtf8 = [Text.UTF8Encoding]::new($false)
$runtimeIdentifier = 'io.ae-switch.portable'
$runtimeMutex = "$runtimeIdentifier-sim"
$runtimeClass = "$runtimeIdentifier-sic"
$runtimeReceiverTitle = "$runtimeIdentifier-siw"
$runtimeOwned = @{}
$runtimeExited = [Collections.Generic.List[object]]::new()
$runtimeContainmentRejected = $false
$runtimeToken = ''
$runtimePrimary = $null
$runtimeCreated = $false
$runtimeMarkerHash = ''
$runtimeReport = [ordered]@{
    recordedAt = [DateTime]::UtcNow.ToString('o'); passed = $false
    id = $runtimeId; root = $runtimeRoot
    scope = 'Exactly four release product gates: no-existing-instance preflight, hidden healthy empty background startup, owned-primary secondary wakeup, and unchanged protected root state. Ownership covers only actual retained images in this fresh UUID; external descendants are read-only observations.'
    allDescendantsProvenOwned = $false
    unownedObservations = @(); unownedObservationsTruncated = $false
    externalProcessPolicy = 'External or proven-exited unproved descendants are never retained, recursed into or stopped. A live candidate with unavailable actual identity still fails closed.'
    writeAttribution = 'Executable location and parent PID do not prove data-write attribution. No claim of zero system C-drive writes or zero external processes is made.'
    singleInstanceScope = 'Fixed identifier in the current Windows session; fresh UUID does not isolate the production mutex.'
    uuidIsolatedMutex = $false
    gates = @(); cleanup = [ordered]@{ removed = $false }
    runtimeByteChangesAllowed = @('data/webview/**', 'data/tmp/**', 'data/cache/**', 'data/home/AppData/Local/Microsoft/Windows/INetCache/**', 'data/uni-switch.db', 'data/uni-switch.db-wal', 'data/uni-switch.db-shm')
    externalVolatileProfileCaches = @('data/home/AppData/LocalLow/SogouPY/**')
    externalVolatileProfileCachePolicy = 'Only the ordinary directory at this exact UUID data/home/AppData/LocalLow/SogouPY is outside protected file byte/path inventory as an external volatile profile cache. Its writes are not attributed to the product; cleanup still audits its full ordinary tree.'
    runtimeCacheAliasPolicy = 'Cleanup may accept only this exact UUID INetCache/Content.IE5 junction to its ordinary INetCache/IE directory. It is never traversed, is revalidated before nonrecursive link removal, and every other reparse point is refused.'
    sourcePackageReparsePointsAccepted = 0
    metadataProtectedFiles = @('data/app.lock')
    appLockPolicy = 'Only this fresh UUID canonical data/app.lock is protected by ordinary-file length, attributes, creation and last-write metadata without reading its exclusively locked bytes; its path and metadata must remain unchanged.'
    databaseRequirement = 'Zero providers/operations/active targets; three owned target directories; logical snapshot unchanged after secondary startup.'
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class AEReleaseRuntime {
    delegate bool Callback(IntPtr h,IntPtr p);
    [DllImport("user32.dll")] static extern bool EnumWindows(Callback cb,IntPtr p);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder s,int n);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr FindWindowW(string cls,string title);
    [DllImport("kernel32.dll",EntryPoint="QueryFullProcessImageNameW",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] static extern bool QueryImage(IntPtr h,uint f,StringBuilder s,ref uint n);
    [DllImport("kernel32.dll",EntryPoint="OpenMutexW",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] static extern IntPtr OpenMutex(uint access,bool inherit,string name);
    [DllImport("kernel32.dll",ExactSpelling=true,SetLastError=true)] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll",ExactSpelling=true,SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
    [DllImport("kernel32.dll",ExactSpelling=true,SetLastError=true)] static extern bool GetProcessTimes(IntPtr h,out long created,out long exited,out long kernel,out long user);
    [DllImport("kernel32.dll",ExactSpelling=true,SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h,uint milliseconds);
    [DllImport("kernel32.dll",EntryPoint="CreateDirectoryW",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] static extern bool CreateDirectory(string path,IntPtr security);
    [DllImport("kernel32.dll",EntryPoint="CreateFileW",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] static extern IntPtr ProbeDeleteAccess(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("shell32.dll",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] static extern IntPtr CommandLineToArgvW(string commandLine,out int count);
    [DllImport("kernel32.dll",ExactSpelling=true)] static extern IntPtr LocalFree(IntPtr memory);
    static string Text(IntPtr h,bool cls){var s=new StringBuilder(1024);if(cls)GetClassName(h,s,s.Capacity);else GetWindowText(h,s,s.Capacity);return s.ToString();}
    public static string ProcessPath(IntPtr h){var s=new StringBuilder(32768);uint n=32768;if(!QueryImage(h,0,s,ref n))throw new Win32Exception(Marshal.GetLastWin32Error());return s.ToString();}
    public static string ObserveProcessExit(int pid,long expectedCreationTicks,long earliestCreationTicks,int timeoutMs){
        if(pid<=0 || expectedCreationTicks<0 || earliestCreationTicks<0 || timeoutMs<0 || timeoutMs>750)throw new ArgumentException("A bounded read-only process exit observation is required.");
        var clock=System.Diagnostics.Stopwatch.StartNew();
        while(true){
            // SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION; no stopping rights.
            var handle=OpenProcess(0x00101000,false,pid);
            if(handle!=IntPtr.Zero){
                try{
                    long created,exited,kernel,user;
                    if(!GetProcessTimes(handle,out created,out exited,out kernel,out user))return "creation-unavailable";
                    long ticks;try{ticks=DateTime.FromFileTimeUtc(created).Ticks;}catch{return "creation-unavailable";}
                    if(ticks<earliestCreationTicks || (expectedCreationTicks!=0 && Math.Abs(ticks-expectedCreationTicks)>TimeSpan.TicksPerMillisecond))return "generation-mismatch";
                    int remaining=Math.Max(0,timeoutMs-(int)Math.Ceiling(clock.Elapsed.TotalMilliseconds));
                    uint status=WaitForSingleObject(handle,(uint)remaining);
                    if(status==0)return "native-limited-handle-signaled";
                    return status==258?"live-or-unavailable":"exit-status-unavailable";
                } finally{CloseHandle(handle);}
            }
            // OpenProcess failure alone does not prove exit or permit ownership.
            try{using(var process=System.Diagnostics.Process.GetProcessById(pid)) { }}
            catch(ArgumentException){return "pid-absent";}
            catch{ }
            int retryRemaining=timeoutMs-(int)Math.Ceiling(clock.Elapsed.TotalMilliseconds);
            if(retryRemaining<=0)return "live-or-unavailable";
            System.Threading.Thread.Sleep(Math.Min(25,retryRemaining));
        }
    }
    public static void CreateFreshDirectory(string path){if(!CreateDirectory(path,IntPtr.Zero))throw new Win32Exception(Marshal.GetLastWin32Error(),"Fresh UUID directory creation failed; existing leaves are never reused.");}
    public static int DeleteAccess(string path){
        // DELETE access, all sharing, OPEN_EXISTING, BACKUP_SEMANTICS and
        // OPEN_REPARSE_POINT only. This probe never marks a path for deletion.
        var handle=ProbeDeleteAccess(path,0x00010000,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
        if(handle==new IntPtr(-1))return Marshal.GetLastWin32Error();
        try{return 0;}finally{if(!CloseHandle(handle))throw new Win32Exception(Marshal.GetLastWin32Error(),"Read-only DELETE-access probe handle could not be closed.");}
    }
    public static string[] CommandLineArguments(string commandLine){
        if(string.IsNullOrWhiteSpace(commandLine) || commandLine.Length>32767 || commandLine.IndexOf('\0')>=0)throw new ArgumentException("A bounded nonempty Windows command line is required.");
        int count;var memory=CommandLineToArgvW(commandLine,out count);
        if(memory==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error(),"Windows command-line parsing failed.");
        try{if(count<1 || count>4096)throw new ArgumentException("Windows argument count exceeds the bounded limit.");var arguments=new string[count];for(int i=0;i<count;i++)arguments[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory,i*IntPtr.Size));return arguments;}
        finally{LocalFree(memory);}
    }
    public static int WindowPid(IntPtr h){uint p;GetWindowThreadProcessId(h,out p);return (int)p;}
    public static int ReceiverPid(string cls,string title){var h=FindWindowW(cls,title);return h==IntPtr.Zero?0:WindowPid(h);}
    public static bool MutexExists(string name){var h=OpenMutex(0x00100000,false,name);if(h!=IntPtr.Zero){CloseHandle(h);return true;}int e=Marshal.GetLastWin32Error();if(e==2)return false;throw new Win32Exception(e,"Production mutex absence cannot be proved; startup refused.");}
    public static int[] PossibleApplicationWindowPids(){var result=new HashSet<int>();EnumWindows((h,p)=>{if(Text(h,false)=="AE Switch")result.Add(WindowPid(h));return true;},IntPtr.Zero);var a=new int[result.Count];result.CopyTo(a);return a;}
    public static IntPtr TryOwnedMainWindow(int pid){var result=new List<IntPtr>();EnumWindows((h,p)=>{if(WindowPid(h)==pid && Text(h,false)=="AE Switch" && Text(h,true)=="Tauri Window")result.Add(h);return true;},IntPtr.Zero);if(result.Count>1)throw new Exception("Owned Tauri main window is ambiguous.");return result.Count==1?result[0]:IntPtr.Zero;}
    public static IntPtr OwnedMainWindow(int pid){var h=TryOwnedMainWindow(pid);if(h==IntPtr.Zero)throw new Exception("Exactly one retained owned Tauri main window is required.");return h;}
}
'@

function Assert-RuntimePath([string]$location, [bool]$allowMissing = $false) {
    $absolute = [IO.Path]::GetFullPath($location)
    if ($absolute -notmatch '^[Gg]:[\\/]' -or -not ($absolute.Equals($runtimeWorkspace, [StringComparison]::OrdinalIgnoreCase) -or $absolute.StartsWith($runtimeWorkspace + '\', [StringComparison]::OrdinalIgnoreCase))) { throw 'Runtime paths must remain in this G workspace.' }
    $cursor = $absolute
    while ($cursor) {
        try {
            $attributes = [IO.File]::GetAttributes($cursor)
            if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Runtime acceptance refuses every reparse point.' }
        } catch [IO.FileNotFoundException] { if (-not $allowMissing) { throw } }
        catch [IO.DirectoryNotFoundException] { if (-not $allowMissing) { throw } }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
    return $absolute
}
function Get-RuntimeHash([string]$location) { $null = Assert-RuntimePath $location; return (Get-FileHash -LiteralPath $location -Algorithm SHA256).Hash.ToLowerInvariant() }
function Add-RuntimeGate([string]$name, $evidence) { $script:runtimeReport.gates += [ordered]@{ name = $name; status = 'passed'; evidence = $evidence } }
function Assert-NoExistingApplication {
    # CIM is read-only; no existing application is hidden, activated or stopped.
    $windowPids = @([AEReleaseRuntime]::PossibleApplicationWindowPids())
    $possible = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
        $_.ProcessId -notin @($runtimeOwned.Keys) -and ($_.ProcessId -in $windowPids -or $_.Name -match '(?i)^(?:ae[-_ ]?switch|uni[-_ ]?switch)(?:[-_ ].*)?\.exe$')
    })
    if ($possible.Count) {
        $script:runtimeReport.refusedExistingProcesses = @($possible | ForEach-Object { [ordered]@{ pid = [int]$_.ProcessId; name = $_.Name } })
        throw 'A possible existing release, QA or legacy AE Switch process exists; startup refused.'
    }
    if ([AEReleaseRuntime]::MutexExists($runtimeMutex) -or [AEReleaseRuntime]::ReceiverPid($runtimeClass, $runtimeReceiverTitle)) { throw 'The production single-instance mutex/receiver is already occupied; startup refused.' }
}
function Assert-RuntimeCacheAlias([string]$location) {
    Assert-RuntimeOwner
    $expectedAlias = [IO.Path]::GetFullPath((Join-Path $runtimeRoot 'data/home/AppData/Local/Microsoft/Windows/INetCache/Content.IE5'))
    $expectedTarget = [IO.Path]::GetFullPath((Join-Path $runtimeRoot 'data/home/AppData/Local/Microsoft/Windows/INetCache/IE'))
    $actual = [IO.Path]::GetFullPath($location)
    if (-not $actual.Equals($expectedAlias, [StringComparison]::OrdinalIgnoreCase)) { throw 'Only this exact UUID native INetCache alias is permitted.' }
    $null = Assert-RuntimePath ([IO.Path]::GetDirectoryName($actual))
    $metadata = Get-Item -LiteralPath $actual -Force -ErrorAction Stop
    $targets = @($metadata.Target)
    if (-not $metadata.PSIsContainer -or -not ($metadata.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $metadata.LinkType -cne 'Junction' -or $targets.Count -ne 1 -or $targets[0] -notmatch '^[Gg]:[\\/]' -or -not [IO.Path]::GetFullPath($targets[0]).Equals($expectedTarget, [StringComparison]::OrdinalIgnoreCase)) { throw 'The native cache alias type or exact owned target changed.' }
    $null = Assert-RuntimePath $expectedTarget
    if (-not ([IO.File]::GetAttributes($expectedTarget) -band [IO.FileAttributes]::Directory)) { throw 'The native cache alias target must be an existing ordinary owned directory.' }
    $null = Assert-RuntimePath ([IO.Path]::GetDirectoryName($actual))
    return [ordered]@{ path = $actual; target = $expectedTarget; traversed = $false; recursiveDeletion = $false }
}
function Get-RuntimeTree([string]$directory, [bool]$allowRuntimeCacheAlias = $false) {
    $directory = Assert-RuntimePath $directory
    if ($allowRuntimeCacheAlias) {
        Assert-RuntimeOwner
        if (-not $directory.Equals([IO.Path]::GetFullPath($runtimeRoot), [StringComparison]::OrdinalIgnoreCase)) { throw 'Native cache alias acceptance is restricted to the current exact UUID tree.' }
    }
    $pending = [Collections.Generic.Stack[string]]::new(); $pending.Push($directory)
    $directories = [Collections.Generic.List[string]]::new(); $files = [Collections.Generic.List[string]]::new()
    $aliases = [Collections.Generic.List[object]]::new()
    while ($pending.Count) {
        $current = Assert-RuntimePath $pending.Pop(); $directories.Add($current)
        foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($current)) {
            $path = [IO.Path]::GetFullPath($entry)
            if (-not $path.StartsWith($directory + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Tree entry escaped its exact root.' }
            $attributes = [IO.File]::GetAttributes($path)
            if ($attributes -band [IO.FileAttributes]::ReparsePoint) {
                if (-not $allowRuntimeCacheAlias) { throw 'Source and ordinary runtime tree auditing refuse every reparse point.' }
                $aliases.Add((Assert-RuntimeCacheAlias $path))
            } else {
                $null = Assert-RuntimePath $path
                if ($attributes -band [IO.FileAttributes]::Directory) { $pending.Push($path) } else { $files.Add($path) }
            }
            if ($directories.Count + $files.Count + $pending.Count + $aliases.Count -gt 40000) { throw 'Desktop runtime tree exceeds the bounded 40000-entry limit.' }
        }
    }
    return [pscustomobject]@{ directories = $directories.ToArray(); files = $files.ToArray(); aliases = $aliases.ToArray() }
}
function Copy-RuntimeTree([string]$source, [string]$destination) {
    $tree = Get-RuntimeTree $source
    foreach ($directory in $tree.directories) { $target = Assert-RuntimePath (Join-Path $destination ([IO.Path]::GetRelativePath($source, $directory))) $true; $null = [IO.Directory]::CreateDirectory($target) }
    foreach ($file in $tree.files) {
        $target = Assert-RuntimePath (Join-Path $destination ([IO.Path]::GetRelativePath($source, $file))) $true
        $null = Assert-RuntimePath $file; [IO.File]::Copy($file, $target, $false)
    }
}
function Assert-RuntimeOwner {
    if (-not $runtimeCreated -or [IO.Path]::GetDirectoryName($runtimeRoot) -cne $runtimeBase -or [IO.Path]::GetFileName($runtimeRoot) -cne $runtimeId -or $runtimeId -cnotmatch '^[a-f0-9]{32}$') { throw 'An exact fresh runtime UUID leaf is required.' }
    if ((Get-RuntimeHash $runtimeMarker) -cne $runtimeMarkerHash) { throw 'Runtime ownership marker bytes changed.' }
    $owner = [IO.File]::ReadAllText($runtimeMarker, [Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($owner.id -cne $runtimeId -or $owner.workspace -cne $runtimeWorkspace -or $owner.purpose -cne $runtimePurpose -or $owner.desktopSha256 -cne $ExpectedDesktopSha256) { throw 'Runtime ownership marker identity mismatch.' }
}
function Retain-RuntimeProcess($process) {
    $null = $process.Handle
    $path = [AEReleaseRuntime]::ProcessPath($process.Handle)
    if (-not $path.StartsWith($runtimeRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Only an executable in this exact fresh owned root may be retained.' }
    $null = Assert-RuntimePath $path
    $identity = [pscustomobject]@{ process = $process; path = $path; started = $process.StartTime.ToUniversalTime(); hash = (Get-RuntimeHash $path) }
    $script:runtimeOwned[$process.Id] = $identity
    return $identity
}
function Assert-RuntimeProcess($identity, [bool]$verifyHash = $false) {
    Assert-RuntimeOwner
    $identity.process.Refresh()
    if ($identity.process.HasExited -or $identity.process.StartTime.ToUniversalTime().Ticks -ne $identity.started.Ticks -or [AEReleaseRuntime]::ProcessPath($identity.process.Handle) -cne $identity.path -or ($verifyHash -and (Get-RuntimeHash $identity.path) -cne $identity.hash)) { throw 'Retained PID, creation time, executable path or hash changed.' }
}
function Stop-RuntimeRetainedProcess($identity) {
    Assert-RuntimeOwner
    $identity.process.Refresh()
    if ($identity.process.HasExited) { return }
    try { Assert-RuntimeProcess $identity $true }
    catch {
        $identity.process.Refresh()
        if ($identity.process.HasExited) { Assert-RuntimeOwner; return }
        throw
    }
    try {
        $identity.process.Kill()
        if (-not $identity.process.WaitForExit(10000)) { throw 'The retained owned process did not stop.' }
    } catch {
        $identity.process.Refresh()
        if ($identity.process.HasExited) { Assert-RuntimeOwner; return }
        throw
    }
}
function Start-RuntimeProcess([string]$file, [string[]]$arguments) {
    Assert-RuntimeOwner
    $null = Assert-RuntimePath $file
    $info = [Diagnostics.ProcessStartInfo]::new($file); $info.UseShellExecute = $false; $info.CreateNoWindow = $true; $info.WorkingDirectory = $runtimeRoot
    foreach ($argument in $arguments) { $info.ArgumentList.Add($argument) }
    foreach ($key in @($info.Environment.Keys)) { if ($key -like 'AE_NATIVE_*' -or $key -like 'AE_QA_*' -or $key -in @('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS','NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE')) { $null = $info.Environment.Remove($key) } }
    $info.Environment['NODE_NO_WARNINGS'] = '1'
    $info.Environment['AE_SWITCH_SYSTEM_INTEGRATION_ISOLATED'] = '1'
    foreach ($pair in @(@('AE_SWITCH_PORTABLE_ROOT',''), @('UNI_SWITCH_DATA_DIR','data'), @('HOME','data/home'), @('USERPROFILE','data/home'), @('APPDATA','data/home/AppData/Roaming'), @('LOCALAPPDATA','data/home/AppData/Local'), @('TEMP','data/tmp'), @('TMP','data/tmp'), @('WEBVIEW2_USER_DATA_FOLDER','data/webview'), @('WEBVIEW2_BROWSER_EXECUTABLE_FOLDER','tools/webview2'))) { $info.Environment[$pair[0]] = if ($pair[1]) { Join-Path $runtimeRoot $pair[1] } else { $runtimeRoot } }
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $info
    if (-not $process.Start()) { throw 'Owned executable did not start.' }
    return Retain-RuntimeProcess $process
}
function Get-RuntimeDiagnosticPath([string]$path) {
    if ([string]::IsNullOrEmpty($path)) { return $null }
    # File identity is useful; command lines and user profile names are not.
    $redacted = [regex]::Replace($path, '(?i)([a-z]:[\\/]Users[\\/])[^\\/]+', '$1<redacted-profile>')
    if ($runtimeToken) { $redacted = $redacted.Replace($runtimeToken, '<redacted>') }
    return $redacted
}
function Get-RuntimeChildDiagnostic($child, $parent, [string]$disposition, [string]$actualPath = '', $actualStarted = $null) {
    return [ordered]@{
        pid = [int]$child.ProcessId; parentPid = [int]$child.ParentProcessId; name = (Get-RuntimeDiagnosticPath ([string]$child.Name))
        disposition = $disposition; cimExecutablePath = (Get-RuntimeDiagnosticPath $child.ExecutablePath); actualExecutablePath = (Get-RuntimeDiagnosticPath $actualPath)
        cimImageAvailable = -not [string]::IsNullOrEmpty($child.ExecutablePath); actualImageAvailable = -not [string]::IsNullOrEmpty($actualPath)
        cimCreatedAt = if ($child.CreationDate) { $child.CreationDate.ToUniversalTime().ToString('o') } else { $null }
        actualStartedAt = if ($actualStarted) { $actualStarted.ToString('o') } else { $null }
        retainedParentStartedAt = $parent.started.ToString('o'); retainedParentExecutablePath = (Get-RuntimeDiagnosticPath $parent.path)
        commandLineRecorded = $false; commandLinePresent = -not [string]::IsNullOrEmpty($child.CommandLine)
        commandLineMentionsOwnedRoot = [bool]($child.CommandLine -and $child.CommandLine.Contains($runtimeRoot, [StringComparison]::OrdinalIgnoreCase))
    }
}
function Add-RuntimeChildDiagnostic($child, $parent, [string]$disposition, [string]$actualPath = '', $actualStarted = $null) {
    if (-not $script:runtimeReport.Contains('childDiagnostics')) { $script:runtimeReport.childDiagnostics = @() }
    if ($script:runtimeReport.childDiagnostics.Count -ge 32) { return }
    $script:runtimeReport.childDiagnostics += Get-RuntimeChildDiagnostic $child $parent $disposition $actualPath $actualStarted
}
function Add-RuntimeUnownedObservation($child, $parent, [string]$disposition, [string]$actualPath = '', $actualStarted = $null, [string]$exitProof = '') {
    $script:runtimeReport.allDescendantsProvenOwned = $false
    $observation = Get-RuntimeChildDiagnostic $child $parent $disposition $actualPath $actualStarted
    $observation.retained = $false; $observation.recursed = $false; $observation.stopped = $false
    $observation.dataWritesAttributedToProduct = $false
    if ($exitProof) { $observation.exitProof = $exitProof }
    foreach ($prior in $script:runtimeReport.unownedObservations) {
        if ($prior.pid -eq $observation.pid -and $prior.cimCreatedAt -eq $observation.cimCreatedAt -and $prior.actualStartedAt -eq $observation.actualStartedAt -and $prior.disposition -eq $disposition) { return }
    }
    if ($script:runtimeReport.unownedObservations.Count -ge 32) { $script:runtimeReport.unownedObservationsTruncated = $true; return }
    $script:runtimeReport.unownedObservations += $observation
}
function Get-RuntimeObservedProcess([int]$processId) { return [Diagnostics.Process]::GetProcessById($processId) }
function Test-RuntimeObservedProcessExited($process) {
    if ($null -eq $process) { return $false }
    try { $process.Refresh(); return [bool]$process.HasExited } catch { return $false }
}
function Update-ExitedRuntimeEntries {
    foreach ($processId in @($runtimeOwned.Keys)) {
        $identity = $runtimeOwned[$processId]; $identity.process.Refresh()
        if (-not $identity.process.HasExited) { continue }
        $runtimeExited.Add($identity)
        $runtimeOwned.Remove($processId)
    }
}
function Capture-RuntimeChildren {
    Update-ExitedRuntimeEntries
    $snapshot = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    $exitObservationClock = $null
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($child in $snapshot) {
            if ($runtimeOwned.ContainsKey([int]$child.ProcessId) -or -not $runtimeOwned.ContainsKey([int]$child.ParentProcessId)) { continue }
            $parent = $runtimeOwned[[int]$child.ParentProcessId]; $parent.process.Refresh()
            if ($parent.process.HasExited) { continue }
            Assert-RuntimeProcess $parent
            $process = $null; $retained = $false; $ownedCandidate = $false; $identityRejected = $false
            $actualPath = ''; $started = $null
            try {
                $process = Get-RuntimeObservedProcess ([int]$child.ProcessId)
                $null = $process.Handle
                $started = $process.StartTime.ToUniversalTime()
                $actualPath = [AEReleaseRuntime]::ProcessPath($process.Handle)
                $ownedCandidate = $actualPath.StartsWith($runtimeRoot + '\', [StringComparison]::OrdinalIgnoreCase)
                $rootCandidateHint = ($child.ExecutablePath -and $child.ExecutablePath.StartsWith($runtimeRoot + '\', [StringComparison]::OrdinalIgnoreCase)) -or ($child.CommandLine -and $child.CommandLine.Contains($runtimeRoot, [StringComparison]::OrdinalIgnoreCase))
                $generationMismatch = $started -lt $parent.started -or ($child.CreationDate -and [Math]::Abs(($child.CreationDate.ToUniversalTime() - $started).TotalMilliseconds) -gt 1)
                if ($generationMismatch) {
                    if ($ownedCandidate -or $rootCandidateHint) { $identityRejected = $true; throw 'An owned-root candidate has a reused or inconsistent PID generation.' }
                    Add-RuntimeUnownedObservation $child $parent 'external-parent-or-child-generation-does-not-match' $actualPath $started
                    continue
                }
                if (-not $ownedCandidate) { Add-RuntimeUnownedObservation $child $parent 'external-actual-image-observed' $actualPath $started; continue }
                if (-not $child.ExecutablePath -or $child.ExecutablePath -ine $actualPath) { Add-RuntimeChildDiagnostic $child $parent 'owned-actual-handle-image-cim-missing-or-stale' $actualPath $started }
                $null = Retain-RuntimeProcess $process; $retained = $true; $changed = $true
            } catch {
                $absentBeforeCapture = $null -eq $process -and $_.Exception -is [ArgumentException]
                if (($child.CreationDate -and $child.CreationDate.ToUniversalTime() -lt $parent.started) -or ($started -and ($started -lt $parent.started -or ($child.CreationDate -and [Math]::Abs(($child.CreationDate.ToUniversalTime() - $started).TotalMilliseconds) -gt 1)))) { $identityRejected = $true }
                if (-not $ownedCandidate -and -not $identityRejected -and ($absentBeforeCapture -or (Test-RuntimeObservedProcessExited $process))) {
                    Add-RuntimeUnownedObservation $child $parent 'exited-unproved-descendant-observed' $actualPath $started
                    continue
                }
                if (-not $ownedCandidate -and -not $identityRejected) {
                    if ($null -eq $exitObservationClock) { $exitObservationClock = [Diagnostics.Stopwatch]::StartNew() }
                    $remainingMs = [Math]::Max(0, 750 - [int][Math]::Ceiling($exitObservationClock.Elapsed.TotalMilliseconds))
                    $expectedCreatedTicks = if ($started) { $started.Ticks } elseif ($child.CreationDate) { $child.CreationDate.ToUniversalTime().Ticks } else { [long]0 }
                    try { $exitProof = [AEReleaseRuntime]::ObserveProcessExit([int]$child.ProcessId, $expectedCreatedTicks, $parent.started.Ticks, $remainingMs) }
                    catch { $exitProof = 'exit-status-unavailable' }
                    if ($exitProof -in @('native-limited-handle-signaled','pid-absent')) {
                        Add-RuntimeUnownedObservation $child $parent 'exited-unproved-descendant-observed' $actualPath $started $exitProof
                        continue
                    }
                }
                Add-RuntimeChildDiagnostic $child $parent 'live-or-owned-candidate-identity-rejected' $actualPath $started
                $script:runtimeContainmentRejected = $true
                throw 'A live or owned-root descendant identity could not be proved; sanitized evidence was recorded and cleanup remains closed.'
            }
            finally { if ($null -ne $process -and -not $retained) { $process.Dispose() } }
        }
    }
}
function Get-RuntimeDatabase {
    $database = Assert-RuntimePath (Join-Path $runtimeRoot 'data/uni-switch.db')
    $program = @'
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.argv[1],{readOnly:true});
const value={providers:db.prepare('SELECT COUNT(*) AS n FROM providers').get().n,operations:db.prepare('SELECT COUNT(*) AS n FROM operations').get().n,schemaVersion:db.prepare('PRAGMA user_version').get().user_version,targets:db.prepare('SELECT * FROM targets ORDER BY id').all()};
db.close();process.stdout.write(JSON.stringify(value));
'@
    $info = [Diagnostics.ProcessStartInfo]::new((Join-Path $runtimeRoot 'tools/node/node.exe')); $info.UseShellExecute = $false; $info.CreateNoWindow = $true; $info.WorkingDirectory = $runtimeRoot; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true; $info.StandardOutputEncoding = $runtimeUtf8; $info.StandardErrorEncoding = $runtimeUtf8; $info.Environment['NODE_NO_WARNINGS'] = '1'
    foreach ($key in @('NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE')) { $null = $info.Environment.Remove($key) }
    $info.ArgumentList.Add('-e'); $info.ArgumentList.Add($program); $info.ArgumentList.Add($database)
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $info
    if (-not $process.Start()) { throw 'Owned read-only SQLite verifier did not start.' }
    $identity = Retain-RuntimeProcess $process
    $output = $process.StandardOutput.ReadToEndAsync(); $errorOutput = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(10000)) { throw 'Owned read-only SQLite verifier timed out.' }
    $text = $output.GetAwaiter().GetResult(); $null = $errorOutput.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) { throw 'Owned read-only SQLite verifier failed.' }
    $value = $text | ConvertFrom-Json
    if ($value.providers -ne 0 -or $value.operations -ne 0 -or $value.targets.Count -ne 3) { throw 'The fresh native database must have zero providers/operations and three targets.' }
    foreach ($target in $value.targets) {
        if ($target.active -or $target.baseline) { throw 'No fresh target may be managed or restored.' }
        $directory = Assert-RuntimePath $target.directory $true
        if (-not $directory.StartsWith($runtimeRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Every fresh target directory must remain in the owned runtime.' }
    }
    if ([IO.File]::Exists((Join-Path $runtimeRoot 'data/agent-selection.json'))) { throw 'Fresh runtime must have no saved Agent selection.' }
    return $value
}
function Get-RuntimeAppLockMetadata([string]$location) {
    $expected = [IO.Path]::GetFullPath((Join-Path $runtimeRoot 'data/app.lock'))
    $actual = Assert-RuntimePath $location
    if (-not $actual.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) { throw 'Metadata protection is restricted to this exact UUID data/app.lock.' }
    $info = [IO.FileInfo]::new($actual); $info.Refresh()
    if (-not $info.Exists -or ($info.Attributes -band ([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint))) { throw 'The canonical app lock must be an existing ordinary file.' }
    $null = Assert-RuntimePath $actual
    return [ordered]@{
        kind = 'ordinary-file-metadata'; contentHashRecorded = $false
        length = $info.Length; attributes = [int]$info.Attributes
        createdAt = $info.CreationTimeUtc.ToString('o'); lastWrittenAt = $info.LastWriteTimeUtc.ToString('o')
    }
}
function Get-RuntimeStableFiles {
    $files = [ordered]@{}
    $externalVolatileCache = [IO.Path]::GetFullPath((Join-Path $runtimeRoot 'data/home/AppData/LocalLow/SogouPY'))
    $pending = [Collections.Generic.Stack[string]]::new(); $pending.Push((Assert-RuntimePath $runtimeRoot))
    $visited = 0
    while ($pending.Count) {
        foreach ($entry in ([IO.Directory]::EnumerateFileSystemEntries($pending.Pop()) | Sort-Object)) {
            $file = Assert-RuntimePath $entry
            $relative = [IO.Path]::GetRelativePath($runtimeRoot, $file).Replace('\','/')
            if (++$visited -gt 40000) { throw 'Protected runtime inventory exceeds its bound.' }
            # Do not enumerate volatile cache bytes. Cleanup separately audits
            # the full tree, with only its exact nontraversed native alias allowed.
            if ($relative -match '^data/(?:webview|tmp|cache|home/AppData/Local/Microsoft/Windows/INetCache)(?:/|$)' -or $relative -match '^data/uni-switch\.db(?:-wal|-shm)?$') { continue }
            if ($file.Equals($externalVolatileCache, [StringComparison]::OrdinalIgnoreCase) -and ([IO.File]::GetAttributes($file) -band [IO.FileAttributes]::Directory)) { continue }
            if ([IO.File]::GetAttributes($file) -band [IO.FileAttributes]::Directory) { $pending.Push($file) }
            elseif ($file.Equals([IO.Path]::GetFullPath((Join-Path $runtimeRoot 'data/app.lock')), [StringComparison]::OrdinalIgnoreCase)) { $files[$relative] = Get-RuntimeAppLockMetadata $file }
            else { $files[$relative] = Get-RuntimeHash $file }
        }
    }
    return $files
}
function Get-RuntimeWebviewDataCheck([int]$processId, [string]$commandLine) {
    $expectedData = [IO.Path]::GetFullPath((Join-Path $runtimeRoot 'data/webview'))
    $expectedChild = Join-Path $expectedData 'EBWebView'
    $check = [ordered]@{
        pid = $processId; parser = 'CommandLineToArgvW'; commandLineRecorded = $false
        commandLinePresent = -not [string]::IsNullOrWhiteSpace($commandLine)
        expectedDataDirectory = $expectedData; acceptedDirectChild = $expectedChild
        argumentCount = 0; actualDataDirectory = $null; normalizedDataDirectory = $null; observedDataDirectories = @()
        matched = $false; disposition = 'command-line-unavailable-or-invalid'; ordinaryAncestorsVerified = $false
    }
    try { $arguments = @([AEReleaseRuntime]::CommandLineArguments($commandLine)) } catch { return $check }
    $values = [Collections.Generic.List[string]]::new(); $malformed = $false
    for ($index = 1; $index -lt $arguments.Length; $index++) {
        $argument = $arguments[$index]
        if ($argument.Equals('--user-data-dir', [StringComparison]::OrdinalIgnoreCase)) {
            $check.argumentCount++
            if ($index + 1 -ge $arguments.Length -or [string]::IsNullOrWhiteSpace($arguments[$index + 1]) -or $arguments[$index + 1].StartsWith('--', [StringComparison]::Ordinal)) { $malformed = $true; continue }
            $values.Add($arguments[++$index])
        } elseif ($argument.StartsWith('--user-data-dir=', [StringComparison]::OrdinalIgnoreCase)) {
            $check.argumentCount++; $value = $argument.Substring('--user-data-dir='.Length)
            if ([string]::IsNullOrWhiteSpace($value)) { $malformed = $true } else { $values.Add($value) }
        }
    }
    $check.observedDataDirectories = @($values | Select-Object -First 4 | ForEach-Object { Get-RuntimeDiagnosticPath $_ })
    if ($values.Count -eq 1) { $check.actualDataDirectory = Get-RuntimeDiagnosticPath $values[0] }
    if ($check.argumentCount -gt 1) { $check.disposition = 'duplicate-user-data-argument'; return $check }
    if ($malformed) { $check.disposition = 'malformed-user-data-argument'; return $check }
    if ($check.argumentCount -eq 0) { $check.disposition = 'user-data-argument-absent'; return $check }
    try {
        if (-not [IO.Path]::IsPathFullyQualified($values[0])) { $check.disposition = 'user-data-path-not-absolute'; return $check }
        $actualData = [IO.Path]::GetFullPath($values[0]).TrimEnd([char[]]@('\','/'))
        $check.normalizedDataDirectory = Get-RuntimeDiagnosticPath $actualData
    } catch { $check.disposition = 'user-data-path-invalid'; return $check }
    # Microsoft documents browser data in a UDF subfolder. Read-only inspection
    # of fresh 5a11362b713b458d9edf53eed66d0654 / eb8ed3b880e347d58b91f856679f96e1
    # on 2026-10-08 observed only the fixed direct EBWebView child. No other
    # child or descendant is accepted by this engine-specific check.
    if ($actualData.Equals($expectedData, [StringComparison]::OrdinalIgnoreCase)) { $check.matched = $true; $check.disposition = 'exact-owned-udf' }
    elseif ($actualData.Equals($expectedChild, [StringComparison]::OrdinalIgnoreCase)) { $check.matched = $true; $check.disposition = 'exact-owned-ebwebview-direct-child' }
    else { $check.disposition = 'outside-exact-owned-data-paths' }
    return $check
}
function Get-OwnedWebviewEvidence {
    $expectedData = Join-Path $runtimeRoot 'data/webview'
    $script:runtimeReport.lastWebviewDataDiagnostics = @()
    $browserCount = 0; $dataArgumentObserved = $false
    foreach ($entry in Get-CimInstance Win32_Process -ErrorAction Stop) {
        if (-not $runtimeOwned.ContainsKey([int]$entry.ProcessId) -or [IO.Path]::GetFileName($entry.ExecutablePath) -ine 'msedgewebview2.exe') { continue }
        $identity = $runtimeOwned[[int]$entry.ProcessId]; $identity.process.Refresh()
        if ($identity.process.HasExited) { continue }
        Assert-RuntimeProcess $identity
        if ($entry.ExecutablePath -ine $identity.path) { throw 'WebView CIM identity does not match its retained actual executable.' }
        $browserCount++
        $check = Get-RuntimeWebviewDataCheck ([int]$entry.ProcessId) ([string]$entry.CommandLine)
        if ($script:runtimeReport.lastWebviewDataDiagnostics.Count -ge 32) { throw 'Owned WebView diagnostic count exceeds its bound.' }
        $script:runtimeReport.lastWebviewDataDiagnostics += $check
        if ($check.disposition -eq 'user-data-argument-absent') { continue }
        if (-not $check.matched) { $script:runtimeContainmentRejected = $true; throw 'Owned WebView user data could not be proved within the exact current UUID paths; sanitized argument evidence was recorded.' }
        $pathToVerify = if ($check.disposition -eq 'exact-owned-udf') { $expectedData } else { Join-Path $expectedData 'EBWebView' }
        try { $null = Assert-RuntimePath $pathToVerify; $check.ordinaryAncestorsVerified = $true }
        catch { $check.matched = $false; $check.disposition = 'accepted-data-path-has-unproved-ancestors'; $script:runtimeContainmentRejected = $true; throw }
        $dataArgumentObserved = $true
    }
    return [ordered]@{
        browserCount = $browserCount; ownedExecutablePaths = $true; exactOwnedUserDataArgumentObserved = $dataArgumentObserved
        dataDirectory = $expectedData; acceptedDirectChild = (Join-Path $expectedData 'EBWebView'); parser = 'CommandLineToArgvW'
        dataArgumentDiagnostics = $script:runtimeReport.lastWebviewDataDiagnostics
        udfSubfolderReference = 'https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/user-data-folder'
        argvReference = 'https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-commandlinetoargvw'
        directChildEvidence = 'Read-only folder-name inspection of fresh UUID runs 5a11362b713b458d9edf53eed66d0654 and eb8ed3b880e347d58b91f856679f96e1 on 2026-10-08 observed only direct EBWebView.'
    }
}
function Assert-RuntimeHealth {
    Assert-RuntimeProcess $runtimePrimary
    $metadata = Assert-RuntimePath (Join-Path $runtimeRoot 'data/protocol-bridge.json')
    $bridge = [IO.File]::ReadAllText($metadata, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $script:runtimeToken = [string]$bridge.token; $port = [int]$bridge.port
    if ($runtimeToken -cnotmatch '^[a-f0-9]{64}$' -or $port -lt 1 -or $port -gt 65535) { throw 'Fresh owned gateway metadata is invalid.' }
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop)
    if ($listeners.Count -ne 1 -or $listeners[0].OwningProcess -ne $runtimePrimary.process.Id) { throw 'The gateway listener must belong uniquely to the retained primary.' }
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -Headers @{ Authorization = "Bearer $runtimeToken" } -NoProxy -TimeoutSec 3
    if ([int]$response.StatusCode -ne 204) { throw 'Owned gateway health must return exact 204.' }
    return [ordered]@{ port = $port; pid = $runtimePrimary.process.Id; healthStatus = 204 }
}
function Assert-OwnedReceiver {
    Assert-RuntimeProcess $runtimePrimary $true
    if (-not [AEReleaseRuntime]::MutexExists($runtimeMutex) -or [AEReleaseRuntime]::ReceiverPid($runtimeClass, $runtimeReceiverTitle) -ne $runtimePrimary.process.Id) { throw 'Production mutex/receiver independence cannot be proved for this retained primary; secondary startup refused.' }
}
function Get-RuntimeLiveRootReferences {
    $references = @()
    foreach ($entry in Get-CimInstance Win32_Process -ErrorAction Stop) {
        if (-not (($entry.ExecutablePath -and $entry.ExecutablePath.StartsWith($runtimeRoot + '\', [StringComparison]::OrdinalIgnoreCase)) -or ($entry.CommandLine -and $entry.CommandLine.Replace('/','\').Contains($runtimeRoot, [StringComparison]::OrdinalIgnoreCase)))) { continue }
        $observed = $null
        try {
            $observed = Get-RuntimeObservedProcess ([int]$entry.ProcessId); $null = $observed.Handle; $observed.Refresh()
            if ($observed.HasExited) { continue }
            $references += [ordered]@{ pid = [int]$entry.ProcessId; name = (Get-RuntimeDiagnosticPath ([string]$entry.Name)); cimExecutablePath = (Get-RuntimeDiagnosticPath $entry.ExecutablePath); commandLineRecorded = $false }
        } catch {
            if (($null -eq $observed -and $_.Exception -is [ArgumentException]) -or (Test-RuntimeObservedProcessExited $observed)) { continue }
            # PowerShell wraps Process.GetProcessById's missing-PID exception.
            # Require independent native absence/signaled proof, rather than
            # interpreting a wrapper or unavailable handle as process exit.
            $expectedCreatedTicks = if ($entry.CreationDate) { $entry.CreationDate.ToUniversalTime().Ticks } else { [long]0 }
            try { $exitProof = [AEReleaseRuntime]::ObserveProcessExit([int]$entry.ProcessId, $expectedCreatedTicks, 0, 0) }
            catch { $exitProof = 'exit-status-unavailable' }
            if ($exitProof -in @('native-limited-handle-signaled','pid-absent')) { continue }
            throw 'A possible live UUID reference could not be proved exited; tree cleanup refused.'
        }
        finally { if ($null -ne $observed) { $observed.Dispose() } }
    }
    return $references
}
function Get-RuntimeCleanupDeleteTree {
    Assert-RuntimeOwner
    if ($runtimeContainmentRejected) { throw 'A live or owned-root identity was rejected; the fresh runtime root is preserved for evidence.' }
    foreach ($identity in @($runtimeOwned.Values) + $runtimeExited.ToArray()) {
        $identity.process.Refresh()
        if (-not $identity.process.HasExited) { throw 'An actual retained owned process is still alive; tree cleanup refused.' }
    }
    $references = @(Get-RuntimeLiveRootReferences)
    $script:runtimeReport.cleanup.liveReferenceCount = $references.Count
    $script:runtimeReport.cleanup.liveReferences = $references
    if ($references.Count) { throw 'Actual live runtime process references appeared during DELETE-access validation; tree cleanup refused.' }
    return Get-RuntimeTree $runtimeRoot $true
}
function Wait-RuntimeDeleteAccess([ValidateRange(0, 180000)][int]$timeoutMilliseconds = 180000) {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $diagnostics = [ordered]@{
        startedAt = [DateTime]::UtcNow.ToString('o'); timeoutMilliseconds = $timeoutMilliseconds
        probe = 'CreateFileW DELETE access with all sharing, OPEN_EXISTING, OPEN_REPARSE_POINT and BACKUP_SEMANTICS; no deletion.'
        retryableWin32Errors = @(32, 33); pollIntervalMilliseconds = 100
        attempts = 0; waitedForSharingOrLock = $false; lastBlockedCount = 0; lastBlockedPaths = @()
        completed = $false; elapsedMilliseconds = 0
    }
    $script:runtimeReport.cleanup.deleteAccess = $diagnostics
    try {
        while ($true) {
            if ($diagnostics.waitedForSharingOrLock -and $clock.Elapsed.TotalMilliseconds -ge $timeoutMilliseconds) { throw 'Sharing/lock DELETE access remained unavailable after the bounded natural-release wait; tree cleanup refused before deletion.' }
            $diagnostics.attempts++
            $tree = Get-RuntimeCleanupDeleteTree
            $blocked = [Collections.Generic.List[object]]::new()
            $blockedCount = 0
            $paths = @($tree.files) + @($tree.directories) + @($tree.aliases | ForEach-Object { $_.path })
            foreach ($path in $paths) {
                if (@($tree.aliases | Where-Object { $_.path -ceq $path }).Count) { $null = Assert-RuntimeCacheAlias $path }
                else { $null = Assert-RuntimePath $path }
                $errorCode = [AEReleaseRuntime]::DeleteAccess($path)
                if ($errorCode -eq 0) { continue }
                $failure = [ordered]@{ path = [IO.Path]::GetRelativePath($runtimeRoot, $path).Replace('\','/'); win32Error = $errorCode }
                if ($errorCode -notin @(32, 33)) {
                    $diagnostics.failure = $failure
                    throw "DELETE-access probe failed with nonretryable Win32 error $errorCode; tree cleanup refused."
                }
                $blockedCount++
                if ($blocked.Count -lt 16) { $blocked.Add($failure) }
            }
            $diagnostics.lastBlockedCount = $blockedCount
            $diagnostics.lastBlockedPaths = $blocked.ToArray()
            if (-not $blockedCount) {
                # Probes do not reserve DELETE access. Recheck every guard and
                # the full tree before handing it to the unchanged deletion tail.
                $readyTree = Get-RuntimeCleanupDeleteTree
                foreach ($kind in @('files', 'directories')) {
                    $expected = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
                    foreach ($path in $tree.$kind) { $null = $expected.Add($path) }
                    if (-not $expected.SetEquals([string[]]$readyTree.$kind)) { throw 'The ordinary runtime tree changed during DELETE-access validation; tree cleanup refused.' }
                }
                $expectedAliases = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
                foreach ($alias in $tree.aliases) { $null = $expectedAliases.Add($alias.path) }
                if (-not $expectedAliases.SetEquals([string[]]@($readyTree.aliases | ForEach-Object { $_.path }))) { throw 'The runtime cache alias set changed during DELETE-access validation; tree cleanup refused.' }
                if ($diagnostics.waitedForSharingOrLock -and $clock.Elapsed.TotalMilliseconds -ge $timeoutMilliseconds) { throw 'Natural-release DELETE-access validation exceeded its bounded deadline; tree cleanup refused before deletion.' }
                $script:runtimeReport.cleanup.reparsePointsAccepted = $readyTree.aliases.Count
                $script:runtimeReport.cleanup.acceptedInternalCacheAliases = @($readyTree.aliases | ForEach-Object { [ordered]@{ path = [IO.Path]::GetRelativePath($runtimeRoot, $_.path).Replace('\','/'); target = [IO.Path]::GetRelativePath($runtimeRoot, $_.target).Replace('\','/'); traversed = $false; recursiveDeletion = $false } })
                $diagnostics.completed = $true
                return $readyTree
            }
            $diagnostics.waitedForSharingOrLock = $true
            $remaining = $timeoutMilliseconds - [int][Math]::Ceiling($clock.Elapsed.TotalMilliseconds)
            if ($remaining -le 0) { throw 'Sharing/lock DELETE access remained unavailable after the bounded natural-release wait; tree cleanup refused before deletion.' }
            Start-Sleep -Milliseconds ([Math]::Min(100, $remaining))
        }
    } finally { $diagnostics.elapsedMilliseconds = [int][Math]::Ceiling($clock.Elapsed.TotalMilliseconds) }
}
function Remove-RuntimeTree([ValidateRange(0, 180000)][int]$deleteAccessTimeoutMilliseconds = 180000) {
    Assert-RuntimeOwner
    if ($runtimeContainmentRejected) { throw 'A live or owned-root identity was rejected; the fresh runtime root is preserved for evidence.' }
    foreach ($identity in @($runtimeOwned.Values) + $runtimeExited.ToArray()) {
        $identity.process.Refresh()
        if (-not $identity.process.HasExited) { throw 'An actual retained owned process is still alive; tree cleanup refused.' }
    }
    $script:runtimeReport.cleanup.retainedOwnedProcessesAllExited = $true
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        $references = @(Get-RuntimeLiveRootReferences)
        $script:runtimeReport.cleanup.liveReferenceCount = $references.Count
        $script:runtimeReport.cleanup.liveReferences = $references
        if (-not $references.Count) { break }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($references.Count) { throw 'Actual live runtime process references remain after the bounded wait; tree cleanup refused.' }
    $tree = Get-RuntimeTree $runtimeRoot $true
    $script:runtimeReport.cleanup.reparsePointsAccepted = $tree.aliases.Count
    $script:runtimeReport.cleanup.acceptedInternalCacheAliases = @($tree.aliases | ForEach-Object { [ordered]@{ path = [IO.Path]::GetRelativePath($runtimeRoot, $_.path).Replace('\','/'); target = [IO.Path]::GetRelativePath($runtimeRoot, $_.target).Replace('\','/'); traversed = $false; recursiveDeletion = $false } })
    $tree = Wait-RuntimeDeleteAccess $deleteAccessTimeoutMilliseconds
    foreach ($alias in $tree.aliases) {
        $null = Assert-RuntimeCacheAlias $alias.path
        [IO.Directory]::Delete($alias.path, $false)
    }
    foreach ($file in $tree.files) { if ($file -cne $runtimeMarker) { $null = Assert-RuntimePath $file; [IO.File]::Delete($file) } }
    for ($index = $tree.directories.Count - 1; $index -gt 0; $index--) { $null = Assert-RuntimePath $tree.directories[$index]; [IO.Directory]::Delete($tree.directories[$index], $false) }
    Assert-RuntimeOwner
    [IO.File]::Delete($runtimeMarker)
    $null = Assert-RuntimePath $runtimeRoot; [IO.Directory]::Delete($runtimeRoot, $false)
}

try {
    $null = Assert-RuntimePath $runtimeWorkspace
    $package = Assert-RuntimePath $PackageDirectory
    $sourceExecutable = Assert-RuntimePath (Join-Path $package 'AE-Switch.exe')
    # Node is a test-only SQLite verifier, not a production-package dependency.
    $sourceNode = Assert-RuntimePath (Join-Path $runtimeWorkspace '.tools/node/node.exe')
    $sourceWebview = Assert-RuntimePath (Join-Path $package 'tools/webview2')
    $null = Assert-RuntimePath (Join-Path $sourceWebview 'msedgewebview2.exe')
    $manifestPath = Assert-RuntimePath (Join-Path $package 'package-manifest.json')
    $manifest = [IO.File]::ReadAllText($manifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($manifest.desktopSha256 -cne $ExpectedDesktopSha256 -or (Get-RuntimeHash $sourceExecutable) -cne $ExpectedDesktopSha256) { throw 'Release package manifest and expected desktop hash must agree.' }
    $script:runtimeReport.testOnlyVerifier = [ordered]@{ source = '.tools/node/node.exe'; sha256 = (Get-RuntimeHash $sourceNode); copiedIntoOwnedFixtureOnly = $true; includedInDistribution = $false }
    $configPath = Assert-RuntimePath (Join-Path $runtimeWorkspace 'app/src-tauri/tauri.conf.json')
    $config = [IO.File]::ReadAllText($configPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($config.identifier -cne $runtimeIdentifier) { throw 'Production identifier changed; mutex evidence must be reviewed before startup.' }
    $pluginPath = Assert-RuntimePath (Join-Path $runtimeWorkspace '.tools/cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tauri-plugin-single-instance-2.5.2/src/platform_impl/windows.rs')
    $plugin = [IO.File]::ReadAllText($pluginPath, [Text.Encoding]::UTF8)
    foreach ($contract in @('format!("{id}-sim")', 'format!("{id}-sic")', 'format!("{id}-siw")', 'id = app.config().identifier.clone()', 'CreateMutexW', 'FindWindowW')) { if (-not $plugin.Contains($contract, [StringComparison]::Ordinal)) { throw 'Pinned production mutex naming evidence changed; startup refused.' } }
    $libPath = Assert-RuntimePath (Join-Path $runtimeWorkspace 'app/src-tauri/src/lib.rs')
    $lib = [IO.File]::ReadAllText($libPath, [Text.Encoding]::UTF8)
    if (-not $lib.Contains('if !args.iter().any(|a| a == "--background")', [StringComparison]::Ordinal)) { throw 'Background secondary non-activation source contract changed; startup refused.' }
    $script:runtimeReport.mutexEvidence = [ordered]@{ name = $runtimeMutex; receiverClass = $runtimeClass; receiverTitle = $runtimeReceiverTitle; pluginVersion = '2.5.2'; sourceSha256 = (Get-RuntimeHash $pluginPath); configSha256 = (Get-RuntimeHash $configPath); callbackSourceSha256 = (Get-RuntimeHash $libPath); backgroundSecondaryDoesNotActivate = $true }
    Assert-NoExistingApplication
    Add-RuntimeGate 'release-no-existing-instance-preflight' @{ cimReadOnly = $true; namedMutexAbsent = $true; receiverAbsent = $true }
    $null = Assert-RuntimePath $runtimeBase $true; $null = [IO.Directory]::CreateDirectory($runtimeBase)
    if ([IO.Directory]::Exists($runtimeRoot) -or [IO.File]::Exists($runtimeRoot)) { throw 'The generated fresh UUID already exists; it will never be reused.' }
    [AEReleaseRuntime]::CreateFreshDirectory($runtimeRoot); $runtimeCreated = $true
    $markerBytes = $runtimeUtf8.GetBytes(([ordered]@{ id = $runtimeId; purpose = $runtimePurpose; workspace = $runtimeWorkspace; desktopSha256 = $ExpectedDesktopSha256; createdAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json))
    $markerStream = [IO.File]::Open($runtimeMarker, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $markerStream.Write($markerBytes, 0, $markerBytes.Length) } finally { $markerStream.Dispose() }
    $runtimeMarkerHash = Get-RuntimeHash $runtimeMarker
    [IO.File]::Copy($sourceExecutable, (Join-Path $runtimeRoot 'AE-Switch.exe'), $false)
    [IO.File]::Copy($manifestPath, (Join-Path $runtimeRoot 'package-manifest.json'), $false)
    foreach ($dll in [IO.Directory]::EnumerateFiles($package, '*.dll', [IO.SearchOption]::TopDirectoryOnly)) { $null = Assert-RuntimePath $dll; [IO.File]::Copy($dll, (Join-Path $runtimeRoot ([IO.Path]::GetFileName($dll))), $false) }
    Copy-RuntimeTree $sourceWebview (Join-Path $runtimeRoot 'tools/webview2')
    $null = [IO.Directory]::CreateDirectory((Join-Path $runtimeRoot 'tools/node')); [IO.File]::Copy($sourceNode, (Join-Path $runtimeRoot 'tools/node/node.exe'), $false)
    foreach ($relative in @('data/home/AppData/Local','data/home/AppData/Roaming','data/tmp','data/webview')) { $null = [IO.Directory]::CreateDirectory((Join-Path $runtimeRoot $relative)) }
    $nodeProbe = Start-RuntimeProcess (Join-Path $runtimeRoot 'tools/node/node.exe') @('-e', "require('node:sqlite')")
    if (-not $nodeProbe.process.WaitForExit(10000) -or $nodeProbe.process.ExitCode -ne 0) { throw 'Owned test-only Node must support the read-only built-in SQLite verifier before desktop startup.' }
    Assert-NoExistingApplication
    $runtimePrimary = Start-RuntimeProcess (Join-Path $runtimeRoot 'AE-Switch.exe') @('--background')
    if ($runtimePrimary.hash -cne $ExpectedDesktopSha256) { throw 'Retained release primary hash mismatch.' }
    $script:runtimeReport.primaryIdentity = [ordered]@{ pid = $runtimePrimary.process.Id; path = $runtimePrimary.path; startedAt = $runtimePrimary.started.ToString('o'); sha256 = $runtimePrimary.hash; retainedHandle = $true }
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    do {
        Assert-RuntimeProcess $runtimePrimary; Capture-RuntimeChildren
        $window = [AEReleaseRuntime]::TryOwnedMainWindow($runtimePrimary.process.Id)
        if ($window -ne [IntPtr]::Zero -and [AEReleaseRuntime]::IsWindowVisible($window)) { throw 'Actual --background main window became visible during startup.' }
        $webviewEvidence = Get-OwnedWebviewEvidence
        if ($window -ne [IntPtr]::Zero -and $webviewEvidence.exactOwnedUserDataArgumentObserved -and [IO.File]::Exists((Join-Path $runtimeRoot 'data/protocol-bridge.json')) -and [IO.File]::Exists((Join-Path $runtimeRoot 'data/uni-switch.db')) -and [AEReleaseRuntime]::ReceiverPid($runtimeClass, $runtimeReceiverTitle) -eq $runtimePrimary.process.Id) { break }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    Assert-OwnedReceiver
    $window = [AEReleaseRuntime]::OwnedMainWindow($runtimePrimary.process.Id)
    if ([AEReleaseRuntime]::IsWindowVisible($window)) { throw 'Actual --background startup unexpectedly shows its main window.' }
    if (-not $webviewEvidence.exactOwnedUserDataArgumentObserved) { throw 'Actual owned WebView data argument was not observed before the startup deadline.' }
    $health = Assert-RuntimeHealth; $initialDatabase = Get-RuntimeDatabase
    $beforeFiles = Get-RuntimeStableFiles
    Add-RuntimeGate 'release-background-hidden-healthy-empty' @{ actualOsVisible = $false; backgroundArgument = $true; health = $health; database = $initialDatabase; webview = $webviewEvidence }
    Assert-OwnedReceiver
    if ([AEReleaseRuntime]::IsWindowVisible([AEReleaseRuntime]::OwnedMainWindow($runtimePrimary.process.Id))) { throw 'The primary was already visible before the secondary launch; wakeup causality cannot be proved.' }
    # The retained primary owns the production receiver before any ordinary
    # secondary launch. A QA build or unrelated mutex owner cannot reach here.
    $secondary = Start-RuntimeProcess (Join-Path $runtimeRoot 'AE-Switch.exe') @()
    if ($secondary.hash -cne $ExpectedDesktopSha256) { throw 'Retained release secondary hash mismatch.' }
    $script:runtimeReport.secondaryIdentity = [ordered]@{ pid = $secondary.process.Id; path = $secondary.path; startedAt = $secondary.started.ToString('o'); sha256 = $secondary.hash; retainedHandle = $true }
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        Assert-RuntimeProcess $runtimePrimary; Capture-RuntimeChildren; $secondary.process.Refresh()
        $window = [AEReleaseRuntime]::OwnedMainWindow($runtimePrimary.process.Id)
        if ($secondary.process.HasExited -and [AEReleaseRuntime]::IsWindowVisible($window) -and -not [AEReleaseRuntime]::IsIconic($window)) { break }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $secondary.process.HasExited -or $secondary.process.ExitCode -ne 0 -or -not [AEReleaseRuntime]::IsWindowVisible($window) -or [AEReleaseRuntime]::IsIconic($window)) { throw 'Actual secondary launch did not exit0 and reveal the retained primary window.' }
    Assert-OwnedReceiver; $null = Assert-RuntimeHealth
    $afterDatabase = Get-RuntimeDatabase
    if (($initialDatabase | ConvertTo-Json -Depth 8 -Compress) -cne ($afterDatabase | ConvertTo-Json -Depth 8 -Compress)) { throw 'Secondary launch changed the logical fresh database.' }
    $afterFiles = Get-RuntimeStableFiles
    if (($beforeFiles | ConvertTo-Json -Compress) -cne ($afterFiles | ConvertTo-Json -Compress)) { throw 'Secondary launch changed protected root files outside the explicit runtime byte allowlist.' }
    Add-RuntimeGate 'release-secondary-shows-owned-primary' @{ primaryPidUnchanged = $true; secondaryExitCode = $secondary.process.ExitCode; actualOsVisible = $true; actualOsMinimized = $false; ownedReceiverStillBound = $true }
    Add-RuntimeGate 'release-secondary-preserves-root-state' @{ stableFilesUnchanged = $true; stableFileCount = $afterFiles.Count; databaseUnchanged = $true; providers = 0; operations = 0; unmanagedTargets = 3 }
    $script:runtimeReport.passed = $true
} catch {
    $message = $_.Exception.Message
    if ($runtimeToken) { $message = $message.Replace($runtimeToken, '<redacted>') }
    $script:runtimeReport.error = $message
} finally {
    if ($runtimeCreated) {
        try {
            try { Capture-RuntimeChildren }
            catch { $script:runtimeReport.cleanup.childCaptureError = $_.Exception.Message }
            # Stop the retained primary before its browser children, so it
            # cannot respawn a browser after the retained tree is captured.
            if ($null -ne $runtimePrimary) { Stop-RuntimeRetainedProcess $runtimePrimary }
            foreach ($identity in @($runtimeOwned.Values | Sort-Object { $_.started } -Descending)) {
                Stop-RuntimeRetainedProcess $identity
            }
            Update-ExitedRuntimeEntries
            $script:runtimeReport.cleanup.exitedRetainedProcesses = @($runtimeExited | ForEach-Object { [ordered]@{ pid = $_.process.Id; path = (Get-RuntimeDiagnosticPath $_.path); startedAt = $_.started.ToString('o'); sha256 = $_.hash; exited = $_.process.HasExited } })
            Remove-RuntimeTree
            $script:runtimeReport.cleanup.removed = -not [IO.Directory]::Exists($runtimeRoot)
            $script:runtimeReport.cleanup.exactUuidAndOwnerVerified = $true
            $script:runtimeReport.cleanup.retainedOwnedProcessesStopped = $true
            $script:runtimeReport.cleanup.productExitButtonExercised = $false
        } catch {
            $script:runtimeReport.passed = $false
            $script:runtimeReport.cleanup.error = 'Owned cleanup failed closed; fresh root retained. No foreign process or reparse point was removed.'
            $script:runtimeReport.cleanup.detail = $_.Exception.Message
        }
    }
    foreach ($identity in @($runtimeOwned.Values) + $runtimeExited.ToArray()) { $identity.process.Dispose() }
    $script:runtimeReport.containmentRejected = $runtimeContainmentRejected
    $null = Assert-RuntimePath ([IO.Path]::GetDirectoryName($runtimeReportPath)) $true
    $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($runtimeReportPath))
    $null = Assert-RuntimePath $runtimeReportPath $true
    if ([IO.File]::Exists($runtimeReportPath) -or [IO.Directory]::Exists($runtimeReportPath)) { throw 'A fresh runtime receipt path must never overwrite a prior report.' }
    $json = $runtimeReport | ConvertTo-Json -Depth 16
    if ($runtimeToken -and $json.Contains($runtimeToken, [StringComparison]::Ordinal)) { throw 'Runtime receipt secret redaction failed.' }
    [IO.File]::WriteAllText($runtimeReportPath, $json, $runtimeUtf8)
    Write-Output $runtimeReportPath
}
if (-not $runtimeReport.passed) { exit 1 }
