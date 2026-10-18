[CmdletBinding()]
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'Owned cleanup requires PowerShell 7.' }
. (Join-Path $PSScriptRoot 'workspace-env.ps1')
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
$runtimeWorkspace = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
function Assert-CleanupLocalPath([string]$path, [bool]$allowMissing = $false) {
    $absolute = [IO.Path]::GetFullPath($path)
    if ($absolute -notmatch '^[Gg]:[\\/]' -or -not $absolute.StartsWith($runtimeWorkspace+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Cleanup paths must remain in the exact G workspace.' }
    $cursor = $absolute
    while ($cursor) {
        try { if ([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) { throw 'Cleanup anchor ancestors must be ordinary.' } }
        catch [IO.FileNotFoundException] { if (-not $allowMissing) { throw } }
        catch [IO.DirectoryNotFoundException] { if (-not $allowMissing) { throw } }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
    return $absolute
}
$runtimeBase = Join-Path $runtimeWorkspace '.cache/desktop-runtime-sandbox'
$runtimeId = '8f8778b381b044c598a55f40a933c34e'
$runtimeRoot = Join-Path $runtimeBase $runtimeId
$runtimeMarker = Join-Path $runtimeRoot '.ae-desktop-runtime-owner.json'
$runtimePurpose = 'AE Switch owned release background and single-instance acceptance'
$ExpectedDesktopSha256 = 'a66c799d6658c3c2c2e28c092aa5933a2371e49c6464e24aab27fc90f8a000f8'
$runtimeMarkerHash = '43ec1ba38dcd413c074c75c370f7136ffea7e9e4ac4d513ced2d18069ca41b06'
$runtimeCreated = $true; $runtimeContainmentRejected = $false; $runtimeToken = ''
$runtimeOwned = @{}; $runtimeExited = [Collections.Generic.List[object]]::new()
$runtimeReport = [ordered]@{ cleanup = [ordered]@{} }
$driverPath = Join-Path $runtimeWorkspace 'scripts/verify-owned-desktop-runtime.ps1'
$driverHash = '485a3f33aa279918d83ee6cc90950647969ebd7930882db3468976e08bcc9ae9'
$originalReportPath = Join-Path $runtimeWorkspace "artifacts/acceptance/desktop-runtime-$runtimeId.json"
$originalReportHash = 'bdfbfce2c9aa0d592fc47d04a53b34645348ea7ca76f5a5d3c4234b05b8f7e93'
$receiptPath = Join-Path $runtimeWorkspace "artifacts/acceptance/desktop-runtime-$runtimeId-cleanup-$([Guid]::NewGuid().ToString('N')).json"
$receipt = [ordered]@{
    recordedAt = [DateTime]::UtcNow.ToString('o'); apply = [bool]$Apply; passed = $false
    scope = 'Only runtime6 exact UUID cleanup; old fixtures are not inspected. No GUI/product launch, input, process stop, recursive delete, credential bytes, global settings or policy-denied directory changes.'
    id = $runtimeId; driverSha256 = $driverHash; originalReportSha256 = $originalReportHash
    runtimeRemoved = $false; originalFailedReportUnchanged = $false
    externalProcessesStopped = 0; directoriesRecursivelyDeleted = 0
}
try {
    $null = Assert-CleanupLocalPath $driverPath
    $null = Assert-CleanupLocalPath $originalReportPath
    if ((Get-FileHash -LiteralPath $driverPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $driverHash) { throw 'The approved runtime driver hash changed.' }
    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($driverPath,[ref]$tokens,[ref]$errors)
    if ($errors.Count) { throw 'The approved runtime driver does not parse.' }
    $native = $ast.Find({ param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Add-Type' },$true)
    Add-Type -TypeDefinition $native.CommandElements[2].Value
    foreach ($name in @('Assert-RuntimePath','Get-RuntimeHash','Assert-RuntimeOwner','Assert-RuntimeCacheAlias','Get-RuntimeTree','Get-RuntimeDiagnosticPath','Get-RuntimeObservedProcess','Test-RuntimeObservedProcessExited','Get-RuntimeLiveRootReferences','Remove-RuntimeTree')) {
        $function = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name },$true)
        Invoke-Expression $function.Extent.Text
    }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AEReleaseCleanupProbe {
    [DllImport("kernel32.dll",EntryPoint="CreateFileW",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] static extern IntPtr Open(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll",ExactSpelling=true)] static extern bool CloseHandle(IntPtr handle);
    public static int DeleteAccess(string path){
        // Probe DELETE sharing without marking for deletion; open the link itself.
        var handle=Open(path,0x00010000,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
        if(handle==new IntPtr(-1))return Marshal.GetLastWin32Error();
        try{return 0;}finally{CloseHandle(handle);}
    }
}
'@
    $null = Assert-RuntimePath $originalReportPath
    if ((Get-RuntimeHash $originalReportPath) -cne $originalReportHash) { throw 'The original runtime6 failed receipt changed.' }
    $original = [IO.File]::ReadAllText($originalReportPath,[Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($original.id -cne $runtimeId -or $original.root -cne $runtimeRoot -or $original.passed -or $original.containmentRejected -or $original.primaryIdentity.sha256 -cne $ExpectedDesktopSha256 -or $original.secondaryIdentity.sha256 -cne $ExpectedDesktopSha256) { throw 'The exact runtime6 failed receipt identity does not match.' }
    $expectedGates = @('release-no-existing-instance-preflight','release-background-hidden-healthy-empty','release-secondary-shows-owned-primary','release-secondary-preserves-root-state')
    if (@($original.gates).Count -ne 4 -or (@($original.gates.name) | ConvertTo-Json -Compress) -cne ($expectedGates | ConvertTo-Json -Compress) -or @($original.gates | Where-Object { $_.status -cne 'passed' }).Count) { throw 'The four original runtime6 product gates are not all passed.' }
    $receipt.originalRuntimePassed = $false
    $receipt.productGateEvidence = 'Four passed gates referenced only from the unchanged original failed runtime6 receipt; no product execution or gate rerun.'
    $receipt.productGates = @($original.gates | ForEach-Object { [ordered]@{ name = $_.name; status = $_.status } })
    Assert-RuntimeOwner
    $desktopPath = Join-Path $runtimeRoot 'AE-Switch.exe'
    if ($original.primaryIdentity.path -cne $desktopPath -or $original.secondaryIdentity.path -cne $desktopPath -or -not $original.primaryIdentity.retainedHandle -or -not $original.secondaryIdentity.retainedHandle) { throw 'Original runtime6 retained desktop handle/path proof is inconsistent.' }
    if ([IO.File]::Exists($desktopPath)) {
        if ((Get-RuntimeHash $desktopPath) -cne $ExpectedDesktopSha256) { throw 'Runtime6 actual desktop bytes changed.' }
        $receipt.rootDesktopHashStatus = 'existing-root-image-hash-verified'
    } else {
        $receipt.rootDesktopHashStatus = 'image-already-absent-after-original-partial-cleanup; original-retained-hash-and-owner-marker-preserved'
    }
    if ((Get-RuntimeHash (Join-Path $runtimeWorkspace 'artifacts/AE-Switch-portable-win-x64/AE-Switch.exe')) -cne $ExpectedDesktopSha256) { throw 'Current canonical release desktop hash changed.' }
    $receipt.currentCanonicalReleaseSha256 = $ExpectedDesktopSha256
    $receipt.markerPurposeAndDesktopHashVerified = $true; $receipt.markerSha256 = $runtimeMarkerHash
    $knownIdentities = @($original.cleanup.exitedRetainedProcesses)
    if ($knownIdentities.Count -ne 11) { throw 'The expected runtime6 retained identity list changed.' }
    foreach ($identity in $knownIdentities) {
        if (-not $identity.exited -or -not $identity.path.StartsWith($runtimeRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or $identity.sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'An original retained runtime6 identity lacks its owned exit/hash proof.' }
        $observed = $null
        try {
            $observed = Get-RuntimeObservedProcess ([int]$identity.pid)
            if (Test-RuntimeObservedProcessExited $observed) { continue }
            if ($observed.StartTime.ToUniversalTime().Ticks -eq [DateTime]::Parse($identity.startedAt).ToUniversalTime().Ticks) { throw 'An original runtime6 retained process generation is still alive.' }
            # A reused PID is external and is never stopped; live root references
            # are checked independently across the fresh complete CIM snapshot.
        } catch [ArgumentException] { continue }
        finally { if ($null -ne $observed) { $observed.Dispose() } }
    }
    $receipt.originalRetainedGenerationsNoLongerLive = $true
    $lockClock = [Diagnostics.Stopwatch]::StartNew(); $lockAttempts = 0; $initialBlocked = @()
    do {
        Assert-RuntimeOwner
        if ((Get-RuntimeHash $originalReportPath) -cne $originalReportHash) { throw 'The original runtime6 failed receipt changed during the bounded wait.' }
        $references = @(Get-RuntimeLiveRootReferences)
        $receipt.freshLiveRootReferenceCount = $references.Count
        if ($references.Count) { throw 'Fresh live UUID references remain; runtime6 is retained.' }
        $tree = Get-RuntimeTree $runtimeRoot $true
        $receipt.fullNonFollowingTreeAudit = [ordered]@{ files = $tree.files.Count; directories = $tree.directories.Count; acceptedAliases = $tree.aliases.Count; entryLimit = 40000; traversedAliases = 0 }
        $receipt.acceptedAliases = @($tree.aliases | ForEach-Object { [ordered]@{ path = [IO.Path]::GetRelativePath($runtimeRoot,$_.path).Replace('\','/'); target = [IO.Path]::GetRelativePath($runtimeRoot,$_.target).Replace('\','/'); recursiveDeletion = $false } })
        $blocked = [Collections.Generic.List[object]]::new()
        foreach ($path in @($tree.files) + @($tree.directories)) {
            $null = Assert-RuntimePath $path
            $errorCode = [AEReleaseCleanupProbe]::DeleteAccess($path)
            if ($errorCode) { $blocked.Add([ordered]@{ path = [IO.Path]::GetRelativePath($runtimeRoot,$path).Replace('\','/'); errorCode = $errorCode }) }
        }
        foreach ($alias in $tree.aliases) {
            $null = Assert-RuntimeCacheAlias $alias.path
            $errorCode = [AEReleaseCleanupProbe]::DeleteAccess($alias.path)
            if ($errorCode) { $blocked.Add([ordered]@{ path = [IO.Path]::GetRelativePath($runtimeRoot,$alias.path).Replace('\','/'); errorCode = $errorCode }) }
        }
        if ($lockAttempts++ -eq 0) { $initialBlocked = $blocked.ToArray() }
        if (-not $blocked.Count -or $lockClock.Elapsed.TotalSeconds -ge 30) { break }
        Start-Sleep -Milliseconds ([Math]::Min(500,[Math]::Max(1,30000-[int]$lockClock.Elapsed.TotalMilliseconds)))
    } while ($true)
    $receipt.deleteSharingPreflight = [ordered]@{ passed = -not $blocked.Count; blocked = $blocked.ToArray(); initiallyBlocked = $initialBlocked; attempts = $lockAttempts; sharedWaitBudgetMs = 30000; elapsedMs = [Math]::Round($lockClock.Elapsed.TotalMilliseconds); bytesRead = 0; markedForDeletion = 0 }
    if ($blocked.Count) { throw 'Delete access/sharing is blocked; the entire runtime6 root is retained and external processes are untouched.' }
    if ($Apply) {
        # The audited driver repeats identity/live-reference/full-tree/alias
        # checks, deletes each ordinary entry nonrecursively and marker last.
        Remove-RuntimeTree
        $receipt.runtimeRemoved = -not [IO.Directory]::Exists($runtimeRoot)
        $receipt.cleanup = $runtimeReport.cleanup
        if (-not $receipt.runtimeRemoved) { throw 'Runtime6 root was not completely removed.' }
    }
    $receipt.passed = $true
} catch { $receipt.error = 'Owned cleanup failed closed. No GUI, product launch or external process stop was attempted.'; $receipt.detail = $_.Exception.Message }
finally {
    $receipt.originalFailedReportUnchanged = ([IO.File]::Exists($originalReportPath) -and (Get-FileHash -LiteralPath $originalReportPath -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $originalReportHash)
    $receipt.finishedAt = [DateTime]::UtcNow.ToString('o')
    if ([IO.File]::Exists($receiptPath) -or [IO.Directory]::Exists($receiptPath)) { throw 'A fresh cleanup receipt must not overwrite another artifact.' }
    $receiptParent = [IO.Path]::GetDirectoryName($receiptPath)
    if (-not $receiptParent.Equals((Join-Path $runtimeWorkspace 'artifacts/acceptance'),[StringComparison]::OrdinalIgnoreCase)) { throw 'Cleanup receipt escaped its explicit artifact directory.' }
    $null = Assert-CleanupLocalPath $receiptPath $true
    [IO.File]::WriteAllText($receiptPath,($receipt | ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
    [ordered]@{ passed = $receipt.passed; apply = [bool]$Apply; runtimeRemoved = $receipt.runtimeRemoved; originalReportUnchanged = $receipt.originalFailedReportUnchanged; receipt = $receiptPath } | ConvertTo-Json -Compress
}
if (-not $receipt.passed) { exit 1 }
