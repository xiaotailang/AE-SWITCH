[CmdletBinding()]
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'Closed fixture cleanup requires PowerShell 7.' }
. (Join-Path $PSScriptRoot 'workspace-env.ps1')
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
Import-Module (Join-Path $PSHOME 'Modules/CimCmdlets/CimCmdlets.psd1') -ErrorAction Stop
$workspace = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$fixtureBase = Join-Path $workspace '.cache/desktop-runtime-lock-static'
$auditPath = Join-Path $workspace 'artifacts/acceptance/static-unmarked-fixture-audit.json'
$auditHash = '28c782dab79183ac91dcc33718de6a01c91a5e3c1760be8a5b8ce84c6ab8a067'
$sourcePath = Join-Path $workspace 'tests/acceptance/native-desktop-runtime-owned-static.ps1'
$sourceHash = 'ee1ebfb8fb066ca15d13c3bd4f4d43a0ac9718f751f863dd970e9f64cc9ca3bd'
$fullInventoryHash = '9851d99d7a3444e9313113a7dd7daf7274fed10d5ef84c07005e329bd17f96eb'
$driverPath = Join-Path $workspace 'scripts/verify-owned-desktop-runtime.ps1'
$driverHash = '485a3f33aa279918d83ee6cc90950647969ebd7930882db3468976e08bcc9ae9'
$receiptPath = Join-Path $workspace "artifacts/acceptance/static-unmarked-fixture-cleanup-$([Guid]::NewGuid().ToString('N')).json"
$receipt = [ordered]@{
    recordedAt = [DateTime]::UtcNow.ToString('o'); passed = $false; apply = [bool]$Apply
    scope = 'Only the 84 exact unmarked authored fixture UUIDs in the anchored closed audit, explicitly authorized by the root. No production/runtime alias policy changes or other sandbox adoption.'
    auditSha256 = $auditHash; fullInventorySha256 = $fullInventoryHash; sourceSha256 = $sourceHash
    ownershipBasis = 'exactTestOnlyBaseAndClosedAuthoredFixturePathsAndBytes'
    retrospectiveMarkersWritten = 0; creationTimeUsed = $false; linksTraversed = 0
    realEndpointKeysRead = 0; externalProcessesStopped = 0; recursiveDirectoryDeletes = 0
    policyDeniedDirectoriesTouched = 0; rootsRemoved = 0; filesRemoved = 0; junctionsUnlinked = 0; ordinaryDirectoriesRemoved = 0
    originalAuditUnchanged = $false; productionDriverUnchanged = $false
}
function Assert-OrdinaryPath([string]$path) {
    $absolute = [IO.Path]::GetFullPath($path)
    if ($absolute -cnotmatch '^G:\\' -or -not $absolute.StartsWith($workspace+'\',[StringComparison]::Ordinal)) { throw 'Fixture cleanup paths must stay in this exact G workspace.' }
    $cursor = $absolute
    while ($cursor) {
        if ([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) { throw 'Ordinary fixture path or ancestor became a reparse point.' }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
    return $absolute
}
function Assert-Anchors {
    foreach ($anchor in @(@($auditPath,$auditHash),@($sourcePath,$sourceHash),@($driverPath,$driverHash))) {
        $null = Assert-OrdinaryPath $anchor[0]
        if ((Get-FileHash -LiteralPath $anchor[0] -Algorithm SHA256).Hash.ToLowerInvariant() -cne $anchor[1]) { throw 'An approved fixture cleanup anchor changed.' }
    }
    $null = Assert-OrdinaryPath $fixtureBase
}
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;
public static class AEClosedFixtureNative {
    [StructLayout(LayoutKind.Sequential)] struct Info {
        public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation;
        public System.Runtime.InteropServices.ComTypes.FILETIME Access;
        public System.Runtime.InteropServices.ComTypes.FILETIME Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    public sealed class Proof { public long Length; public uint Links; public string Sha256; }
    [DllImport("kernel32.dll",EntryPoint="CreateFileW",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] static extern IntPtr Open(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll",ExactSpelling=true,SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle,out Info info);
    public static int DeleteAccess(string path) {
        using(var handle=new SafeFileHandle(Open(path,0x00010000,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero),true)) {
            return handle.IsInvalid ? Marshal.GetLastWin32Error() : 0;
        }
    }
    public static Proof HashSynthetic(string path,long expectedLength) {
        using(var handle=new SafeFileHandle(Open(path,0x80000000,7,IntPtr.Zero,3,0x00200000,IntPtr.Zero),true)) {
            if(handle.IsInvalid)throw new IOException("Synthetic metadata handle failed: "+Marshal.GetLastWin32Error());
            Info info;if(!GetFileInformationByHandle(handle,out info))throw new IOException("Synthetic metadata query failed.");
            long length=((long)info.SizeHigh<<32)|info.SizeLow;
            if((info.Attributes&0x410)!=0 || info.Links!=1 || expectedLength<0 || expectedLength>64 || length!=expectedLength)
                throw new IOException("Synthetic file type, link count or bounded length changed before any content read.");
            using(var stream=new FileStream(handle,FileAccess.Read)) {
                return new Proof{Length=length,Links=info.Links,Sha256=Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant()};
            }
        }
    }
}
'@
function Assert-FixtureJunction([string]$root, [object]$record) {
    $path = [IO.Path]::GetFullPath((Join-Path $root $record.path))
    if ($record.absolutePath -cne $path -or -not $path.StartsWith($root+'\',[StringComparison]::Ordinal) -or $record.kind -cne 'junction' -or $record.traversed) { throw 'Junction record escaped its exact authored UUID.' }
    $null = Assert-OrdinaryPath ([IO.Path]::GetDirectoryName($path))
    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    $targets = @($item.Target)
    $target = [IO.Path]::GetFullPath($record.absoluteTarget)
    if (-not $item.PSIsContainer -or -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.LinkType -cne 'Junction' -or $targets.Count -ne 1 -or $targets[0] -cne $target -or $record.absoluteTarget -cne $target -or -not $target.StartsWith($root+'\',[StringComparison]::Ordinal)) { throw 'A recorded authored junction type or target changed.' }
    $null = Assert-OrdinaryPath $target
    if (-not ([IO.File]::GetAttributes($target) -band [IO.FileAttributes]::Directory)) { throw 'Authored junction target must remain an ordinary same-UUID directory.' }
    $null = Assert-OrdinaryPath ([IO.Path]::GetDirectoryName($path))
    return $path
}
function Assert-NoLiveFixtureReferences {
    $references = [Collections.Generic.List[object]]::new()
    foreach ($entry in CimCmdlets\Get-CimInstance Win32_Process -ErrorAction Stop) {
        $matches = ($entry.ExecutablePath -and $entry.ExecutablePath.StartsWith($fixtureBase+'\',[StringComparison]::OrdinalIgnoreCase)) -or ($entry.CommandLine -and $entry.CommandLine.Replace('/','\').Contains($fixtureBase,[StringComparison]::OrdinalIgnoreCase))
        if (-not $matches -and $entry.CommandLine) { foreach ($id in $audit.candidateRootIds) { if ($entry.CommandLine.Contains($id,[StringComparison]::OrdinalIgnoreCase)) { $matches=$true; break } } }
        if (-not $matches) { continue }
        $observed = $null
        try {
            $observed = [Diagnostics.Process]::GetProcessById([int]$entry.ProcessId)
            $null = $observed.Handle; $observed.Refresh()
            if (-not $observed.HasExited) { $references.Add([ordered]@{pid=[int]$entry.ProcessId;commandLineRecorded=$false}) }
        } catch [ArgumentException] { }
        finally { if ($null -ne $observed) { $observed.Dispose() } }
    }
    $receipt.freshLiveReferenceCount = $references.Count
    if ($references.Count) { throw 'A fresh possible fixture process reference remains; all roots are retained.' }
}
function Get-FreshClosedTree([object]$rootRecord) {
    $root = [IO.Path]::GetFullPath((Join-Path $fixtureBase $rootRecord.id))
    if ($rootRecord.id -cnotmatch '^[a-f0-9]{32}$' -or $rootRecord.root -cne $root -or -not $rootRecord.exactClosedAuthoredMatch -or $rootRecord.problems.Count) { throw 'An authored root record is inconsistent.' }
    $null = Assert-OrdinaryPath $root
    $expected = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
    foreach ($record in $rootRecord.inventory) {
        $absolute = [IO.Path]::GetFullPath((Join-Path $root $record.path))
        if ($record.path -cne [IO.Path]::GetRelativePath($root,$absolute).Replace('\','/') -or -not $absolute.StartsWith($root+'\',[StringComparison]::Ordinal) -or $record.kind -cnotin @('directory','file','junction')) { throw 'Anchored inventory path or type is invalid.' }
        $expected.Add($record.path,$record)
    }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $pending = [Collections.Generic.Stack[string]]::new(); $pending.Push($root)
    $directories = [Collections.Generic.List[string]]::new(); $files = [Collections.Generic.List[object]]::new(); $junctions = [Collections.Generic.List[object]]::new()
    while ($pending.Count) {
        $current = Assert-OrdinaryPath $pending.Pop(); $directories.Add($current)
        foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($current)) {
            $path = [IO.Path]::GetFullPath($entry)
            if (-not $path.StartsWith($root+'\',[StringComparison]::Ordinal)) { throw 'Fresh tree entry escaped its exact UUID.' }
            $relative = [IO.Path]::GetRelativePath($root,$path).Replace('\','/')
            if (-not $expected.ContainsKey($relative) -or -not $seen.Add($relative)) { throw 'Fresh tree contains an unrecognized or duplicate authored path.' }
            $record = $expected[$relative]; $attributes = [IO.File]::GetAttributes($path)
            if ($attributes -band [IO.FileAttributes]::ReparsePoint) {
                if ($record.kind -cne 'junction') { throw 'Fresh tree contains an unrecorded reparse point.' }
                $null = Assert-FixtureJunction $root $record
                $junctions.Add([ordered]@{root=$root;record=$record;path=$path})
            } elseif ($attributes -band [IO.FileAttributes]::Directory) {
                if ($record.kind -cne 'directory') { throw 'An authored entry type changed.' }
                $null = Assert-OrdinaryPath $path; $pending.Push($path)
            } else {
                if ($record.kind -cne 'file' -or -not $record.exactAuthoredBytes -or $record.hardlinks -ne 1 -or $record.sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'An authored ordinary file record changed.' }
                $null = Assert-OrdinaryPath $path
                $proof = [AEClosedFixtureNative]::HashSynthetic($path,[long]$record.length)
                if ($proof.Sha256 -cne $record.sha256 -or $proof.Links -ne 1) { throw 'Fresh synthetic fixture bytes or link count differ from the closed audit.' }
                $null = Assert-OrdinaryPath $path
                $files.Add([ordered]@{path=$path;record=$record})
            }
            if ($seen.Count + $pending.Count + $directories.Count -gt 40000) { throw 'Fixture tree exceeds its bounded entry limit.' }
        }
    }
    if ($seen.Count -ne $expected.Count -or $files.Count -ne $rootRecord.files -or $directories.Count -ne $rootRecord.directories -or $junctions.Count -ne $rootRecord.junctions) { throw 'A recorded authored fixture entry is missing.' }
    $expectedDirs = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($dir in $rootRecord.ordinaryDirectoryPaths) { if (-not $expectedDirs.Add($dir)) { throw 'Duplicate ordinary directory record.' } }
    if (-not $expectedDirs.SetEquals($directories)) { throw 'Fresh ordinary directory inventory differs from the closed audit.' }
    return [pscustomobject]@{id=$rootRecord.id;root=$root;files=$files.ToArray();directories=$directories.ToArray();junctions=$junctions.ToArray()}
}
function Get-AllFreshClosedTrees {
    Assert-Anchors
    Assert-NoLiveFixtureReferences
    $knownIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($id in $audit.candidateRootIds) { if ($id -cnotmatch '^[a-f0-9]{32}$' -or -not $knownIds.Add($id)) { throw 'Invalid or duplicate approved fixture UUID.' } }
    $recordIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($rootRecord in $audit.roots) { if (-not $recordIds.Add($rootRecord.id)) { throw 'Duplicate closed fixture root record.' } }
    if (-not $knownIds.SetEquals($recordIds)) { throw 'Closed fixture root records differ from the approved UUID set.' }
    $actualIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($fixtureBase)) {
        $null = Assert-OrdinaryPath $entry
        if (-not ([IO.File]::GetAttributes($entry) -band [IO.FileAttributes]::Directory) -or -not $actualIds.Add([IO.Path]::GetFileName($entry))) { throw 'The exact test-only base contains an unrecognized entry.' }
    }
    if ($knownIds.Count -ne 84 -or -not $knownIds.SetEquals($actualIds)) { throw 'The exact 84-root base membership differs from the anchored audit.' }
    $trees = [Collections.Generic.List[object]]::new(); $allCount = 0; $files = 0; $dirs = 0; $links = 0
    foreach ($root in $audit.roots) {
        $tree = Get-FreshClosedTree $root; $trees.Add($tree)
        $files += $tree.files.Count; $dirs += $tree.directories.Count; $links += $tree.junctions.Count
        $allCount += $tree.files.Count + $tree.directories.Count + $tree.junctions.Count
        if ($allCount -gt 40000) { throw 'Aggregate fresh fixture tree exceeds its bounded entry limit.' }
    }
    if ($trees.Count -ne 84 -or $files -ne 84 -or $dirs -ne 483 -or $links -ne 42) { throw 'Aggregate closed authored fixture counts differ.' }
    $blocked = [Collections.Generic.List[object]]::new()
    foreach ($tree in $trees) {
        foreach ($path in @($tree.directories) + @($tree.files|ForEach-Object{$_.path}) + @($tree.junctions|ForEach-Object{$_.path})) {
            $errorCode = [AEClosedFixtureNative]::DeleteAccess($path)
            if ($errorCode) { $blocked.Add([ordered]@{id=$tree.id;path=[IO.Path]::GetRelativePath($tree.root,$path).Replace('\','/');errorCode=$errorCode}) }
        }
    }
    $receipt.freshFullNonFollowingTree = [ordered]@{roots=84;ordinaryFiles=$files;ordinaryDirectoriesIncludingRoots=$dirs;junctions=$links;totalEntries=$allCount;entryLimit=40000;linksTraversed=0;exactStructuralManifestMatch=$true;allSyntheticHashesMatched=$true;allOrdinaryFilesSingleLinked=$true}
    $receipt.deleteSharingPreflight = [ordered]@{passed=(-not $blocked.Count);blocked=$blocked.ToArray();markedForDeletion=0;bytesRead=0}
    if ($blocked.Count) { throw 'DELETE access/sharing preflight failed; no fixture deletion begins.' }
    Assert-Anchors
    Assert-NoLiveFixtureReferences
    return $trees.ToArray()
}
try {
    Assert-Anchors
    $audit = [IO.File]::ReadAllText($auditPath,[Text.Encoding]::UTF8)|ConvertFrom-Json
    if (-not $audit.passed -or -not $audit.readOnly -or $audit.exactBase -cne $fixtureBase -or $audit.sourcePath -cne $sourcePath -or $audit.sourceSha256 -cne $sourceHash -or $audit.fullInventorySha256 -cne $fullInventoryHash -or $audit.ownershipBasis -cne 'exactTestOnlyBaseAndClosedAuthoredFixturePathsAndBytes' -or $audit.candidateCount -ne 84 -or $audit.roots.Count -ne 84 -or $audit.retainedCount -ne 0 -or $audit.cleanupPerformed -or $audit.linksTraversed -or $audit.realEndpointKeysRead -or -not $audit.allOrdinaryFilesSingleLinked -or -not $audit.junctionTargetsAndAncestorsOrdinary) { throw 'The anchored closed authored fixture audit is inconsistent.' }
    $trees = @(Get-AllFreshClosedTrees)
    $receipt.completeFreshAudits = 1
    if ($Apply) {
        # Repeat the complete byte/tree/link/reference/sharing audit immediately
        # before mutation. No marker is added to any old fixture.
        $trees = @(Get-AllFreshClosedTrees); $receipt.completeFreshAudits = 2
        foreach ($tree in $trees) { foreach ($junction in $tree.junctions) {
            $path = Assert-FixtureJunction $tree.root $junction.record
            if ([AEClosedFixtureNative]::DeleteAccess($path)) { throw 'A junction sharing state changed before unlink.' }
            [IO.Directory]::Delete($path,$false); $receipt.junctionsUnlinked++
        } }
        foreach ($tree in $trees) { foreach ($file in $tree.files) {
            $null = Assert-OrdinaryPath $file.path
            $proof = [AEClosedFixtureNative]::HashSynthetic($file.path,[long]$file.record.length)
            if ($proof.Sha256 -cne $file.record.sha256 -or [AEClosedFixtureNative]::DeleteAccess($file.path)) { throw 'An authored file changed before deletion.' }
            $null = Assert-OrdinaryPath $file.path
            [IO.File]::Delete($file.path); $receipt.filesRemoved++
        } }
        foreach ($tree in $trees) {
            for ($index=$tree.directories.Count-1;$index -ge 0;$index--) {
                $path = Assert-OrdinaryPath $tree.directories[$index]
                if ([AEClosedFixtureNative]::DeleteAccess($path)) { throw 'An ordinary directory sharing state changed before deletion.' }
                [IO.Directory]::Delete($path,$false); $receipt.ordinaryDirectoriesRemoved++
            }
            if ([IO.Directory]::Exists($tree.root) -or [IO.File]::Exists($tree.root)) { throw 'An authorized fixture UUID still exists.' }
            $receipt.rootsRemoved++
        }
        $receipt.remainingBaseEntries = @([IO.Directory]::EnumerateFileSystemEntries($fixtureBase)).Count
        if ($receipt.remainingBaseEntries -ne 0 -or $receipt.rootsRemoved -ne 84 -or $receipt.filesRemoved -ne 84 -or $receipt.junctionsUnlinked -ne 42 -or $receipt.ordinaryDirectoriesRemoved -ne 483) { throw 'Final exact fixture absence/count verification failed.' }
    }
    $receipt.passed = $true
} catch { $receipt.error='Closed authored fixture cleanup failed closed.'; $receipt.detail=$_.Exception.Message }
finally {
    $receipt.originalAuditUnchanged = ([IO.File]::Exists($auditPath) -and (Get-FileHash -LiteralPath $auditPath).Hash.ToLowerInvariant() -ceq $auditHash)
    $receipt.productionDriverUnchanged = ([IO.File]::Exists($driverPath) -and (Get-FileHash -LiteralPath $driverPath).Hash.ToLowerInvariant() -ceq $driverHash)
    $receipt.finishedAt = [DateTime]::UtcNow.ToString('o')
    $null = Assert-OrdinaryPath ([IO.Path]::GetDirectoryName($receiptPath))
    if ([IO.File]::Exists($receiptPath) -or [IO.Directory]::Exists($receiptPath)) { throw 'A fresh independent receipt must not overwrite evidence.' }
    [IO.File]::WriteAllText($receiptPath,($receipt|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
    [ordered]@{passed=$receipt.passed;apply=[bool]$Apply;rootsRemoved=$receipt.rootsRemoved;originalAuditUnchanged=$receipt.originalAuditUnchanged;receipt=$receiptPath}|ConvertTo-Json -Compress
}
if (-not $receipt.passed) { exit 1 }
