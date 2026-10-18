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
$runtimeBase = Join-Path $runtimeWorkspace '.cache/native-e2e-sandbox'
$runtimeId = '0e5c91d246b341cda49babb5bbec6386'
$runtimeRoot = Join-Path $runtimeBase $runtimeId
$approvedLongPath = [IO.Path]::GetFullPath((Join-Path $runtimeRoot 'tools/agents/workbuddy/resources/app.asar.unpacked/node_modules/@tencent/qimei-node/src/mac/QimeiSDKMac.xcframework/macos-arm64_x86_64/QimeiSDKMac.framework/_CodeSignature'))
$runtimeMarker = Join-Path $runtimeRoot '.ae-native-e2e-owner.json'
$runtimePurpose = 'AE Switch owned native UI and real tool acceptance'
$ExpectedDesktopSha256 = 'f2a5e20dc5c96e15e77d66e6070a23a6a82a04a3b20032232105cbb8ae0ec9fb'
$runtimeMarkerHash = '6a9c1fbaa8ea8e1aefeb648078d2f2b13f99c6606a7a10c0150b75b78d762060'
$runtimeCreated = $true; $runtimeContainmentRejected = $false; $runtimeToken = ''
$runtimeOwned = @{}; $runtimeExited = [Collections.Generic.List[object]]::new()
$runtimeReport = [ordered]@{ cleanup = [ordered]@{} }
$driverPath = Join-Path $runtimeWorkspace 'scripts/verify-owned-desktop-runtime.ps1'
$driverHash = '485a3f33aa279918d83ee6cc90950647969ebd7930882db3468976e08bcc9ae9'
$originalReportPath = Join-Path $runtimeWorkspace "artifacts/acceptance/retest-history/native-twenty-first-wrapper.json"
$originalReportHash = '62dbd3e8130a90f82b0a1541c8c0340db42cf62f7b4a37ce9a41702fd960093d'
$archivedUiPath = Join-Path $runtimeWorkspace 'artifacts/acceptance/retest-history/native-twenty-first-ui.json'
$archivedUiHash = '00a80f0a8145987c60d0116ae7e070db949ecce09e742da89f7af13fbbf51469'
$archivedTrayPath = Join-Path $runtimeWorkspace 'artifacts/acceptance/retest-history/native-twenty-first-tray.json'
$archivedTrayHash = 'd9f9ccc97830c2119607437f8a653654a3447e19a130de83a3416ebb28dbb0b7'
$wrapperSourcePath = Join-Path $runtimeWorkspace 'scripts/verify-portable-e2e.ps1'
$wrapperSourceHash = 'e5de4f46216411bd8b8da883b5439e0d179209a49a88bf1312e558a4f0ad5a52'
$qaSourcePath = [IO.Path]::GetFullPath((Join-Path $env:CARGO_TARGET_DIR 'debug/ae-switch.exe'))
$receiptPath = Join-Path $runtimeWorkspace "artifacts/acceptance/native-e2e-$runtimeId-cleanup-$([Guid]::NewGuid().ToString('N')).json"
$receipt = [ordered]@{
    recordedAt = [DateTime]::UtcNow.ToString('o'); apply = [bool]$Apply; passed = $false
    scope = 'Only native21 exact UUID cleanup; old fixtures are not inspected. No GUI/product launch, input, process stop, recursive delete, credential bytes, global settings or policy-denied directory changes.'
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
    # The native UI owner schema has id/purpose/workspace, rather than a
    # desktopSha256 field. Preserve the driver's strict path/tree functions.
    function Assert-RuntimeOwner {
        $root = Assert-RuntimePath $runtimeRoot
        if ([IO.Path]::GetDirectoryName($root) -cne [IO.Path]::GetFullPath($runtimeBase) -or [IO.Path]::GetFileName($root) -cne $runtimeId -or $runtimeId -cnotmatch '^[a-f0-9]{32}$') { throw 'Native21 cleanup requires its exact UUID leaf.' }
        if ((Get-RuntimeHash $runtimeMarker) -cne $runtimeMarkerHash) { throw 'Native21 existing owner marker bytes changed.' }
        $owner = [IO.File]::ReadAllText($runtimeMarker,[Text.Encoding]::UTF8) | ConvertFrom-Json
        if ($owner.id -cne $runtimeId -or $owner.workspace -cne $runtimeWorkspace -or $owner.purpose -cne $runtimePurpose) { throw 'Native21 marker identity/purpose changed.' }
        foreach ($anchor in @(@($originalReportPath,$originalReportHash),@($archivedUiPath,$archivedUiHash),@($archivedTrayPath,$archivedTrayHash),@($wrapperSourcePath,$wrapperSourceHash),@($qaSourcePath,$ExpectedDesktopSha256))) {
            if ((Get-RuntimeHash $anchor[0]) -cne $anchor[1]) { throw 'An archived native21/source QA anchor changed.' }
        }
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
    if ((Get-RuntimeHash $originalReportPath) -cne $originalReportHash) { throw 'The original native21 failed receipt changed.' }
    $original = [IO.File]::ReadAllText($originalReportPath,[Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($original.sandbox -cne $runtimeRoot -or $original.passed -or $original.qaSha256 -cne $ExpectedDesktopSha256 -or $original.qaPid -ne 22144 -or $original.nativeProcessSafety.identityFailure -or $original.nativeProcessSafety.recursiveTerminationUsed -or $original.nativeProcessSafety.retainedIdentityCount -ne 7) { throw 'Native21 archived failed wrapper identity/safety proof is inconsistent.' }
    Assert-RuntimeOwner
    $ui = [IO.File]::ReadAllText($archivedUiPath,[Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($ui.passed -or $ui.verifiedRoot -cne $runtimeRoot -or $ui.qaSha256 -cne $ExpectedDesktopSha256 -or $ui.ownedNativeSandbox.root -cne $runtimeRoot -or $ui.ownedNativeSandbox.ownerId -cne $runtimeId -or $ui.ownedNativeSandbox.executableHash -cne $ExpectedDesktopSha256) { throw 'Archived native21 UI ownership does not match the wrapper/marker.' }
    $receipt.archivedWrapperPassed = $false; $receipt.archivedUiPassed = $false
    $receipt.archivedUiSha256 = $archivedUiHash; $receipt.archivedTraySha256 = $archivedTrayHash
    $receipt.wrapperSourceSha256 = $wrapperSourceHash; $receipt.qaSourceSha256 = $ExpectedDesktopSha256
    $receipt.wrapperSourceAnchorRole = 'Current source integrity only; not the wrapper version executed by native21.'
    $receipt.executedWrapperSourceSha256ReportedByRoot = 'c594926fb2d83daf910a343d90f552c1a6108becd5cc31b7d547535ffeace9e9'
    $receipt.existingMarkerPurposeAndSourceHashVerified = $true; $receipt.markerSha256 = $runtimeMarkerHash
    $originalQa = $null
    try {
        $originalQa = Get-RuntimeObservedProcess 22144
        if (-not (Test-RuntimeObservedProcessExited $originalQa)) { throw 'The original native21 QA PID has not been proved exited.' }
    } catch [ArgumentException] { }
    finally { if ($null -ne $originalQa) { $originalQa.Dispose() } }
    $receipt.originalQaPidGone = $true
    $lockClock = [Diagnostics.Stopwatch]::StartNew(); $lockAttempts = 0; $initialBlocked = @()
    do {
        Assert-RuntimeOwner
        # Do not compete with the standard cleanup command or use its current
        # report, which may already belong to native21.
        $concurrentCleanup = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine -match '(?i)-CleanupNativeSandboxId\s+\W*0e5c91d246b341cda49babb5bbec6386' })
        if ($concurrentCleanup.Count) { throw 'The exact native21 standard cleanup is still running; independent cleanup is deferred.' }
        if ((Get-RuntimeHash $originalReportPath) -cne $originalReportHash) { throw 'The original native21 failed receipt changed during the bounded wait.' }
        $references = @(Get-RuntimeLiveRootReferences)
        $receipt.freshLiveRootReferenceCount = $references.Count
        if ($references.Count) { throw 'Fresh live UUID references remain; native21 is retained.' }
        $tree = Get-RuntimeTree $runtimeRoot $true
        $receipt.fullNonFollowingTreeAudit = [ordered]@{ files = $tree.files.Count; directories = $tree.directories.Count; acceptedAliases = $tree.aliases.Count; entryLimit = 40000; traversedAliases = 0 }
        $receipt.acceptedAliases = @($tree.aliases | ForEach-Object { [ordered]@{ path = [IO.Path]::GetRelativePath($runtimeRoot,$_.path).Replace('\','/'); target = [IO.Path]::GetRelativePath($runtimeRoot,$_.target).Replace('\','/'); recursiveDeletion = $false } })
        $blocked = [Collections.Generic.List[object]]::new()
        $longPathRechecks = [Collections.Generic.List[object]]::new()
        foreach ($path in @($tree.files) + @($tree.directories)) {
            $null = Assert-RuntimePath $path
            $errorCode = [AEReleaseCleanupProbe]::DeleteAccess($path)
            if ($errorCode -eq 3 -and $path -ceq $approvedLongPath -and $path.Length -ge 260) {
                # Only this freshly audited ordinary exact-UUID path may use
                # the equivalent extended Win32 spelling. Missing entries still
                # fail: attributes/existence are checked before the second probe.
                $attributes = [IO.File]::GetAttributes($path)
                if (($attributes -band [IO.FileAttributes]::ReparsePoint) -or -not ($attributes -band [IO.FileAttributes]::Directory) -or -not [IO.Directory]::Exists($path)) { throw 'The approved native21 long directory changed or disappeared.' }
                if ([IO.Path]::GetFullPath($path) -cne $path -or $path -cnotmatch '^G:\\' -or -not $path.StartsWith($runtimeRoot+'\',[StringComparison]::Ordinal)) { throw 'The approved native21 long path is not canonical.' }
                $plainError = $errorCode
                $errorCode = [AEReleaseCleanupProbe]::DeleteAccess('\\?\'+$path)
                $longPathRechecks.Add([ordered]@{ path = [IO.Path]::GetRelativePath($runtimeRoot,$path).Replace('\','/'); pathLength = $path.Length; ordinaryExists = $true; ordinaryWin32Error = $plainError; extendedWin32Error = $errorCode; bytesRead = 0; markedForDeletion = 0 })
            }
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
    $receipt.win32LongPathRechecks = $longPathRechecks.ToArray()
    if ($blocked.Count) { throw 'Delete access/sharing is blocked; the entire native21 root is retained and external processes are untouched.' }
    if ($Apply) {
        # The audited driver repeats identity/live-reference/full-tree/alias
        # checks, deletes each ordinary entry nonrecursively and marker last.
        Remove-RuntimeTree
        $receipt.runtimeRemoved = -not [IO.Directory]::Exists($runtimeRoot)
        $receipt.cleanup = $runtimeReport.cleanup
        if (-not $receipt.runtimeRemoved) { throw 'Native21 root was not completely removed.' }
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
