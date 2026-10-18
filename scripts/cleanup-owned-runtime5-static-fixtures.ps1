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
$runtimeId = '51b0daeefa6d46699c42f3f0232bee82'
$runtimeRoot = Join-Path $runtimeBase $runtimeId
$runtimeMarker = Join-Path $runtimeRoot '.ae-desktop-runtime-owner.json'
$runtimePurpose = 'AE Switch owned release background and single-instance acceptance'
$ExpectedDesktopSha256 = '957c505802fc8dd6ad03e0fb383bc9b087ffbeff24295e37801ea7c053343cca'
$runtimeMarkerHash = 'ba1b6c078240c2cbd561f20dc616ab04cea80f30555e146f814432a1262be812'
$runtimeCreated = $true; $runtimeContainmentRejected = $false; $runtimeToken = ''
$runtimeOwned = @{}; $runtimeExited = [Collections.Generic.List[object]]::new()
$runtimeReport = [ordered]@{ cleanup = [ordered]@{} }
$driverPath = Join-Path $runtimeWorkspace 'scripts/verify-owned-desktop-runtime.ps1'
$driverHash = '485a3f33aa279918d83ee6cc90950647969ebd7930882db3468976e08bcc9ae9'
$originalReportPath = Join-Path $runtimeWorkspace "artifacts/acceptance/desktop-runtime-$runtimeId.json"
$originalReportHash = '56310ec6a3c19a32fad21476846abc6887ac0df99f22d7f838e5a07200be41c8'
$receiptPath = Join-Path $runtimeWorkspace "artifacts/acceptance/desktop-runtime-$runtimeId-cleanup-$([Guid]::NewGuid().ToString('N')).json"
$receipt = [ordered]@{
    recordedAt = [DateTime]::UtcNow.ToString('o'); apply = [bool]$Apply; passed = $false
    scope = 'Only runtime5 exact UUID and read-only fixture retention inventory. No GUI/product launch, input, process stop, recursive delete, credential bytes, global settings or policy-denied directory changes.'
    id = $runtimeId; driverSha256 = $driverHash; originalReportSha256 = $originalReportHash
    runtimeRemoved = $false; originalFailedReportUnchanged = $false
    externalProcessesStopped = 0; directoriesRecursivelyDeleted = 0
    fixturePolicy = 'The previous static harness did not create an ownership marker or root manifest. Unmarked fixtures are retained; creation time does not establish ownership. No retrospective marker is written.'
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
    if ((Get-RuntimeHash $originalReportPath) -cne $originalReportHash) { throw 'The original runtime5 failed receipt changed.' }
    $original = [IO.File]::ReadAllText($originalReportPath,[Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($original.id -cne $runtimeId -or $original.root -cne $runtimeRoot -or $original.passed -or $original.primaryIdentity.sha256 -cne $ExpectedDesktopSha256) { throw 'The exact runtime5 failed receipt identity does not match.' }
    $fixtureBase = Assert-RuntimePath (Join-Path $runtimeWorkspace '.cache/desktop-runtime-lock-static')
    $fixtureLeaves = [Collections.Generic.List[object]]::new()
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($fixtureBase)) {
        $path = [IO.Path]::GetFullPath($entry)
        if ([IO.Path]::GetDirectoryName($path) -cne $fixtureBase) { throw 'Fixture inventory escaped its explicit base.' }
        $attributes = [IO.File]::GetAttributes($path)
        if (-not ($attributes -band [IO.FileAttributes]::Directory) -or ($attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'A fixture leaf is not an ordinary directory.' }
        $null = Assert-RuntimePath $path
        if ([IO.Path]::GetFileName($path) -cnotmatch '^[a-f0-9]{32}$') { throw 'Fixture inventory contains an unexpected non-UUID leaf.' }
        $fixtureLeaves.Add([ordered]@{ id = [IO.Path]::GetFileName($path); removed = $false; disposition = 'retained-no-existing-owner-marker-or-exact-root-manifest' })
    }
    $staticReceipt = [IO.File]::ReadAllText((Assert-RuntimePath (Join-Path $runtimeWorkspace 'artifacts/acceptance/desktop-runtime-owned-static.json')),[Text.Encoding]::UTF8) | ConvertFrom-Json
    $receipt.staticReceiptHasRootManifest = [bool]($staticReceipt.PSObject.Properties.Name -contains 'fixtureRoots')
    $receipt.retainedFixtureCount = $fixtureLeaves.Count; $receipt.fixtures = $fixtureLeaves.ToArray()
    Assert-RuntimeOwner
    if ((Get-RuntimeHash (Join-Path $runtimeRoot 'AE-Switch.exe')) -cne $ExpectedDesktopSha256) { throw 'Runtime5 actual desktop bytes changed.' }
    $receipt.markerPurposeAndDesktopHashVerified = $true; $receipt.markerSha256 = $runtimeMarkerHash
    $knownIdentities = @($original.cleanup.exitedRetainedProcesses)
    if ($knownIdentities.Count -ne 10) { throw 'The expected runtime5 retained identity list changed.' }
    foreach ($identity in $knownIdentities) {
        $observed = $null
        try {
            $observed = Get-RuntimeObservedProcess ([int]$identity.pid)
            if (Test-RuntimeObservedProcessExited $observed) { continue }
            if ($observed.StartTime.ToUniversalTime().Ticks -eq [DateTime]::Parse($identity.startedAt).ToUniversalTime().Ticks) { throw 'An original runtime5 retained process generation is still alive.' }
            # A reused PID is external and is never stopped; live root references
            # are checked independently across the fresh complete CIM snapshot.
        } catch [ArgumentException] { continue }
        finally { if ($null -ne $observed) { $observed.Dispose() } }
    }
    $receipt.originalRetainedGenerationsNoLongerLive = $true
    $references = @(Get-RuntimeLiveRootReferences)
    $receipt.freshLiveRootReferenceCount = $references.Count
    if ($references.Count) { throw 'Fresh live UUID references remain; runtime5 is retained.' }
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
    $receipt.deleteSharingPreflight = [ordered]@{ passed = -not $blocked.Count; blocked = $blocked.ToArray(); bytesRead = 0; markedForDeletion = 0 }
    if ($blocked.Count) { throw 'Delete access/sharing is blocked; the entire runtime5 root is retained and external processes are untouched.' }
    if ($Apply) {
        # The audited driver repeats identity/live-reference/full-tree/alias
        # checks, deletes each ordinary entry nonrecursively and marker last.
        Remove-RuntimeTree
        $receipt.runtimeRemoved = -not [IO.Directory]::Exists($runtimeRoot)
        $receipt.cleanup = $runtimeReport.cleanup
        if (-not $receipt.runtimeRemoved) { throw 'Runtime5 root was not completely removed.' }
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
    [ordered]@{ passed = $receipt.passed; apply = [bool]$Apply; runtimeRemoved = $receipt.runtimeRemoved; retainedFixtures = $receipt.retainedFixtureCount; originalReportUnchanged = $receipt.originalFailedReportUnchanged; receipt = $receiptPath } | ConvertTo-Json -Compress
}
if (-not $receipt.passed) { exit 1 }
