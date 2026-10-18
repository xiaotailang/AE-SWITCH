[CmdletBinding()]
param([string]$PackageDirectory, [switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

# Deliberately do not load workspace-env.ps1: CheckOnly creates no directories.
$syncWorkspace = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$syncPackage = if ($PackageDirectory) { [IO.Path]::GetFullPath($PackageDirectory) } else { '' }
$syncReceiptPath = Join-Path $syncWorkspace 'artifacts/final-package-sync-receipt.json'
$syncAcceptance = Join-Path $syncWorkspace 'artifacts/acceptance'
# Preserve the reviewed historical nested-path policy for its safety regressions.
# Historical/raw receipts are not selected for the current installed-client package.
$syncNestedReceiptWhitelist = @(
    'retest-history/portable-tenth-seven-of-seven-cleaned.json'
    'retest-history/native-twenty-third-ui.json'
    'retest-history/native-twenty-third-wrapper.json'
    'retest-history/native-twenty-third-tray.json'
    'retest-history/native-twenty-fifth-ui.json'
    'retest-history/native-twenty-fifth-wrapper.json'
    'retest-history/native-twenty-fifth-tray.json'
    'retest-history/native-twenty-fifth-wrapper-cleaned.json'
    'retest-history/native-twenty-sixth-ui.json'
    'retest-history/native-twenty-sixth-wrapper.json'
    'retest-history/native-twenty-sixth-tray.json'
    'retest-history/native-twenty-sixth-wrapper-cleaned.json'
    'retest-history/native-twenty-seventh-ui.json'
    'retest-history/native-twenty-seventh-wrapper.json'
    'retest-history/native-twenty-seventh-tray.json'
    'retest-history/native-twenty-seventh-wrapper-cleaned.json'
    'retest-history/native-twenty-eighth-ui.json'
    'retest-history/native-twenty-eighth-wrapper.json'
    'retest-history/native-twenty-eighth-tray.json'
    'retest-history/native-twenty-eighth-wrapper-cleaned.json'
    'retest-history/native-twenty-ninth-ui.json'
    'retest-history/native-twenty-ninth-wrapper.json'
    'retest-history/native-twenty-ninth-tray.json'
    'retest-history/native-twenty-ninth-wrapper-cleaned.json'
    'retest-history/native-thirtieth-ui.json'
    'retest-history/native-thirtieth-wrapper.json'
    'retest-history/native-thirtieth-tray.json'
    'retest-history/native-thirty-first-ui.json'
    'retest-history/native-thirty-first-wrapper.json'
    'retest-history/native-thirty-first-tray.json'
    'retest-history/native-thirty-first-wrapper-cleaned.json'
    'retest-history/native-thirty-second-ui.json'
    'retest-history/native-thirty-second-wrapper.json'
    'retest-history/native-thirty-second-tray.json'
    'retest-history/native-thirty-third-ui.json'
    'retest-history/native-thirty-third-wrapper.json'
    'retest-history/native-thirty-third-tray.json'
    'retest-history/native-thirty-third-owner.json'
    'retest-history/native-thirty-third-cleanup-lock-audit.json'
    'retest-history/native-thirty-third-cleanup.json'
    'retest-history/native-thirty-fourth-ui.json'
    'retest-history/native-thirty-fourth-wrapper.json'
    'retest-history/native-thirty-fourth-tray.json'
    'retest-history/native-thirty-fourth-cleanup.json'
    'retest-history/native-thirty-fifth-ui.json'
    'retest-history/native-thirty-fifth-wrapper.json'
    'retest-history/native-thirty-fifth-tray.json'
    'retest-history/native-thirty-sixth-ui.json'
    'retest-history/native-thirty-sixth-wrapper.json'
    'retest-history/native-thirty-sixth-tray.json'
    'retest-history/native-thirty-seventh-ui.json'
    'retest-history/native-thirty-seventh-wrapper.json'
    'retest-history/native-thirty-seventh-wrapper-cleaned.json'
    'retest-history/native-thirty-seventh-tray.json'
    'retest-history/native-thirty-eighth-ui.json'
    'retest-history/native-thirty-eighth-wrapper.json'
    'retest-history/native-thirty-eighth-tray.json'
    'native-gateway/e57773924d2141e281d539b3ae429e61/native-gateway-results.json'
    'native-gateway/e57773924d2141e281d539b3ae429e61/native-gateway-wrapper.json'
    'native-gateway/62996dc9a3894402bc85d069e5c9a5be/native-gateway-results.json'
    'native-gateway/62996dc9a3894402bc85d069e5c9a5be/native-gateway-wrapper.json'
    'history-preservation-2044c9555f3b402dad90856a14c73534/retained-evidence-audit.json'
    'history-preservation-ac903b1f2fab4c67911973bfa9923136/retained-evidence-audit.json'
)
$syncReleaseReceiptWhitelist = @(
    'krill-current-validation-summary-da709301727647a68a1c652dc6cfcd84.json'
    'validation-status.json'
    'final-package-boundaries.json'
    'final-package-correspondence.json'
)
$syncScopes = [ordered]@{
    'source/ae-switch' = Join-Path $syncPackage 'source/ae-switch'
    'ui' = Join-Path $syncPackage 'ui'
    'verification' = Join-Path $syncPackage 'verification'
}
$syncUtf8 = [Text.UTF8Encoding]::new($false)
$syncPrivateStrings = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$syncMappings = [Collections.Generic.List[object]]::new()
$syncPlan = [Collections.Generic.List[object]]::new()
$syncDestinationTrees = [Collections.Generic.List[object]]::new()
$syncExpected = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$syncSafetyPassed = $false
$syncReceipt = [ordered]@{
    recordedAt = [DateTime]::UtcNow.ToString('o')
    checkOnly = [bool]$CheckOnly
    packageDirectory = $syncPackage
    receiptOutsideAcceptance = $true
    sourceScope = 'Packager app/scripts/docs/tests roots plus README.md and .gitignore, excluding development caches, databases and logs.'
    verificationScope = "$($syncReleaseReceiptWhitelist.Count) exact reviewed small JSON receipts for the installed-client package and two current verification documents; excludes raw native reports, screenshots, logs, profiles and historical receipts."
    receiptPaths = @($syncReleaseReceiptWhitelist)
    receiptMaximumBytes = 131072
    nestedReceiptPaths = @()
    excludedDirectoriesVisited = $false
    destinationAuditHasExclusions = $false
    recursiveDeletionUsed = $false
    packageDataAbsent = $false
    exactRootsVerified = $false
    ordinaryAncestorsVerified = $false
    sourceReparseAuditPassed = $false
    destinationReparseAuditPassed = $false
    sourceCredentialScanPassed = $false
    plannedPathsWithinAllowedSubtrees = $false
    safetyPassed = $false
    mutationStarted = $false
    copiedFiles = 0
    removedFiles = 0
    scopes = @()
    passed = $false
    error = $null
}

function Get-SyncAttributes([string]$Location, [bool]$AllowMissing = $false) {
    try { return [IO.File]::GetAttributes($Location) }
    catch {
        $syncCause = $_.Exception
        while ($syncCause.InnerException) { $syncCause = $syncCause.InnerException }
        if ($AllowMissing -and ($syncCause -is [IO.FileNotFoundException] -or $syncCause -is [IO.DirectoryNotFoundException])) { return $null }
        throw
    }
}

function Assert-SyncChild([string]$Root, [string]$Location, [bool]$AllowRoot = $false) {
    $syncAbsolute = [IO.Path]::GetFullPath($Location)
    if (($AllowRoot -and $syncAbsolute.Equals($Root, [StringComparison]::OrdinalIgnoreCase)) -or
        $syncAbsolute.StartsWith($Root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { return $syncAbsolute }
    throw 'A planned path escaped its exact synchronization scope.'
}

function Assert-SyncAncestors([string]$Location, [bool]$AllowMissing = $false, [bool]$LeafIsFile = $false) {
    $syncLeaf = [IO.Path]::GetFullPath($Location)
    for ($syncCurrent = $syncLeaf; $syncCurrent; $syncCurrent = [IO.Path]::GetDirectoryName($syncCurrent)) {
        $syncAttributes = Get-SyncAttributes $syncCurrent $AllowMissing
        if ($null -eq $syncAttributes) { continue }
        if (($syncAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Synchronization refuses a redirected path or ancestor.' }
        $syncIsDirectory = ($syncAttributes -band [IO.FileAttributes]::Directory) -ne 0
        if ($syncCurrent.Equals($syncLeaf, [StringComparison]::OrdinalIgnoreCase) -and $LeafIsFile) {
            if ($syncIsDirectory) { throw 'An expected ordinary file is a directory.' }
        } elseif (-not $syncIsDirectory) { throw 'An expected ordinary directory is a file.' }
    }
}

function Assert-SyncNestedReceiptPath([string]$Relative) {
    if ($Relative -cnotmatch '\A(?:retest-history/(?:portable|native)-[a-z0-9]+(?:-[a-z0-9]+)*\.json|native-gateway/[a-f0-9]{32}/native-gateway-(?:results|wrapper)\.json|history-preservation-[a-f0-9]{32}/retained-evidence-audit\.json)\z') {
        throw 'A nested receipt path is outside the exact allowed report shapes.'
    }
    return Assert-SyncChild $syncAcceptance (Join-Path $syncAcceptance $Relative)
}

function Assert-SyncReleaseReceiptPath([string]$Relative) {
    if ($Relative -cnotmatch '\A[A-Za-z0-9][A-Za-z0-9.-]*\.json\z' -or
        $syncReleaseReceiptWhitelist -cnotcontains $Relative) {
        throw 'A receipt is outside the exact current-release allowlist.'
    }
    return Assert-SyncChild $syncAcceptance (Join-Path $syncAcceptance $Relative)
}

function Read-SyncReleaseReceipts {
    $syncReleaseSelected = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($syncRelative in $syncReleaseReceiptWhitelist) {
        $syncFile = Assert-SyncReleaseReceiptPath $syncRelative
        Assert-SyncAncestors $syncFile $false $true
        if (-not $syncReleaseSelected.Add($syncFile)) { throw 'The exact current-release allowlist contains a duplicate.' }
        if ([IO.FileInfo]::new($syncFile).Length -gt 131072) { throw 'A current-release receipt exceeds the reviewed small-evidence size limit.' }
        $syncReleaseJson = [IO.File]::ReadAllText($syncFile, $syncUtf8) | ConvertFrom-Json -AsHashtable -NoEnumerate
        if ($syncReleaseJson -isnot [Collections.IDictionary]) { throw 'A current-release receipt must be a JSON object.' }
        [pscustomobject]@{ Relative = $syncRelative; Source = $syncFile; Hash = Get-SyncFingerprint $syncFile $true }
    }
}

function Assert-SyncNoData {
    if ($null -ne (Get-SyncAttributes (Join-Path $syncPackage 'data') $true)) { throw 'Synchronization refuses a package containing data.' }
}

function Assert-SyncPackageTarget([string]$Location) {
    if (-not $Location -or $Location -match '[\x00-\x1f]') { throw 'Specify a fresh AE-only package directory.' }
    $absolute = [IO.Path]::GetFullPath($Location)
    $artifacts = Join-Path $syncWorkspace 'artifacts'
    if ($syncWorkspace -notmatch '^[Gg]:[\\/]' -or
        -not ([IO.Path]::GetDirectoryName($absolute)).Equals($artifacts, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($absolute) -cnotmatch '\AAE-Switch-portable-win-x64-[A-Za-z0-9-]+\z') {
        throw 'Only an explicitly selected fresh package directly under this G: workspace artifacts directory is allowed.'
    }
    return $absolute
}

function Test-SyncExcluded([string]$Relative, [bool]$Directory) {
    # Exact final-package-audit.mjs/package-portable.ps1 source rules.
    $syncParts = $Relative.Replace('\', '/').ToLowerInvariant().Split('/')
    $syncName = $syncParts[-1]
    if ($Directory) {
        return $syncName -in @('.git', '.cache', 'rtk', '.rtk', '__pycache__', '.pytest_cache', '.ruff_cache', '.mypy_cache', '.turbo', 'coverage') -or
            ($syncParts[0] -eq 'app' -and $syncName -in @('node_modules', 'dist', 'target', '.omx', 'data'))
    }
    return $syncName -in @('.env', '.env.local', '.env.production', '.env.development', '.env.vault', '端点测试用.txt', 'direct_url.json') -or
        $syncName -match '\.(?:pyc|pyo|log)$' -or $syncName -match '\.(?:db|sqlite|sqlite3)(?:-(?:shm|wal|journal))?$' -or
        ($syncParts[0] -eq 'app' -and $syncName.EndsWith('.pdb'))
}

function Read-SyncTree([string]$Root, [string]$SourcePrefix = '', [bool]$AllowMissing = $false) {
    Assert-SyncAncestors $Root $AllowMissing
    $syncFiles = [Collections.Generic.List[string]]::new()
    $syncPending = [Collections.Generic.Stack[string]]::new()
    if ($null -ne (Get-SyncAttributes $Root $AllowMissing)) { $syncPending.Push($Root) }
    $syncDirectories = 0
    while ($syncPending.Count) {
        $syncCurrent = Assert-SyncChild $Root ($syncPending.Pop()) $true
        $syncRelative = [IO.Path]::GetRelativePath($Root, $syncCurrent).Replace('\', '/')
        $syncAttributes = Get-SyncAttributes $syncCurrent
        $syncIsDirectory = ($syncAttributes -band [IO.FileAttributes]::Directory) -ne 0
        $syncIsReparse = ($syncAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
        # Like the source audit, excluded links count as directories and are
        # skipped before rejection/enumeration. Destination trees have no prefix.
        if ($SourcePrefix -and $syncRelative -ne '.' -and
            (Test-SyncExcluded ($SourcePrefix + '/' + $syncRelative) ($syncIsDirectory -or $syncIsReparse))) { continue }
        if ($syncIsReparse) { throw 'An included synchronization tree contains a reparse point.' }
        if ($syncIsDirectory) {
            $syncDirectories++
            foreach ($syncEntry in [IO.Directory]::GetFileSystemEntries($syncCurrent)) { $syncPending.Push($syncEntry) }
        } else { $syncFiles.Add($syncCurrent) }
    }
    return [pscustomobject]@{ Root = $Root; Files = $syncFiles; Directories = $syncDirectories }
}

function Add-SyncMapping([string]$Source, [string]$Scope, [string]$Relative) {
    $syncDestination = Assert-SyncChild $syncScopes[$Scope] (Join-Path $syncScopes[$Scope] $Relative)
    Assert-SyncAncestors $Source $false $true
    Assert-SyncAncestors $syncDestination $true $true
    if (-not $syncExpected.Add($syncDestination)) { throw 'Two source files map to one package file.' }
    $syncMappings.Add([pscustomobject]@{ Source = $Source; Destination = $syncDestination; Scope = $Scope })
}

function Get-SyncFingerprint([string]$Location, [bool]$CheckPrivate = $false) {
    Assert-SyncAncestors $Location $false $true
    $syncBytes = [IO.File]::ReadAllBytes($Location)
    if ($CheckPrivate) {
        $syncText = $syncUtf8.GetString($syncBytes)
        foreach ($syncSecret in $syncPrivateStrings) {
            if ($syncText.Contains($syncSecret, [StringComparison]::Ordinal)) { throw 'An included source file contains a private credential.' }
        }
    }
    $syncHasher = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($syncHasher.ComputeHash($syncBytes))).Replace('-', '').ToLowerInvariant() }
    finally { $syncHasher.Dispose() }
}

function Initialize-SyncPrivateStrings {
    $syncCredentialFile = Join-Path $syncWorkspace '端点测试用.txt'
    Assert-SyncAncestors $syncCredentialFile $false $true
    $syncCredentialText = [IO.File]::ReadAllText($syncCredentialFile)
    foreach ($syncMatch in [regex]::Matches($syncCredentialText, '(?im)api[-_ ]?key\s*[:：]\s*(.+)')) {
        $syncSecret = $syncMatch.Groups[1].Value.Trim()
        if (-not $syncSecret) { continue }
        $null = $syncPrivateStrings.Add($syncSecret)
        $syncJson = ConvertTo-Json -InputObject $syncSecret -Compress
        $syncJson = $syncJson.Substring(1, $syncJson.Length - 2)
        $null = $syncPrivateStrings.Add($syncJson)
        $null = $syncPrivateStrings.Add($syncJson.Replace('/', '\/'))
        $syncDouble = ConvertTo-Json -InputObject $syncJson -Compress
        $null = $syncPrivateStrings.Add($syncDouble.Substring(1, $syncDouble.Length - 2))
        $syncUnicode = -join @($syncSecret.ToCharArray() | ForEach-Object { '\u' + ([int]$_).ToString('x4') })
        $null = $syncPrivateStrings.Add($syncUnicode)
        $null = $syncPrivateStrings.Add($syncUnicode.ToUpperInvariant().Replace('\U', '\u'))
    }
    if (-not $syncPrivateStrings.Count) { throw 'The designated credential input has no key for the safety scan.' }
}

function Assert-SyncPlannedFile($Entry) {
    $null = Assert-SyncChild $syncScopes[$Entry.Scope] $Entry.Destination
    Assert-SyncAncestors $Entry.Destination $true $true
    Assert-SyncNoData
    $syncCurrentHash = if ($null -ne (Get-SyncAttributes $Entry.Destination $true)) { Get-SyncFingerprint $Entry.Destination } else { $null }
    if ($syncCurrentHash -cne $Entry.BeforeHash) { throw 'A planned destination changed after inspection.' }
}

function Copy-SyncPlannedFile($Entry) {
    Assert-SyncPlannedFile $Entry
    if ((Get-SyncFingerprint $Entry.Source $true) -cne $Entry.SourceHash) { throw 'A planned source changed after inspection.' }
    $syncParent = [IO.Path]::GetDirectoryName($Entry.Destination)
    $null = Assert-SyncChild $syncScopes[$Entry.Scope] $syncParent $true
    Assert-SyncAncestors $syncParent $true
    [IO.Directory]::CreateDirectory($syncParent) | Out-Null
    Assert-SyncAncestors $syncParent
    $syncTemporary = Assert-SyncChild $syncScopes[$Entry.Scope] (Join-Path $syncParent ('.ae-final-sync-' + [Guid]::NewGuid().ToString('N') + '.tmp'))
    $syncTemporaryOwned = $false
    try {
        $syncSourceStream = [IO.File]::OpenRead($Entry.Source)
        try {
            $syncDestinationStream = [IO.FileStream]::new($syncTemporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            $syncTemporaryOwned = $true
            try {
                $syncSourceStream.CopyTo($syncDestinationStream)
                $syncDestinationStream.Flush($true)
            } finally { $syncDestinationStream.Dispose() }
        } finally { $syncSourceStream.Dispose() }
        if ((Get-SyncFingerprint $syncTemporary $true) -cne $Entry.SourceHash) { throw 'The staged copy does not match the planned source.' }
        Assert-SyncPlannedFile $Entry
        # Replace the directory entry, rather than overwriting an existing hard
        # link's contents. Other links therefore retain their original bytes.
        [IO.File]::Move($syncTemporary, $Entry.Destination, $true)
        $syncTemporaryOwned = $false
        $syncReceipt.copiedFiles++
    } finally {
        if ($syncTemporaryOwned) {
            $null = Assert-SyncChild $syncScopes[$Entry.Scope] $syncTemporary
            Assert-SyncAncestors $syncTemporary $false $true
            [IO.File]::Delete($syncTemporary)
        }
    }
}

function Assert-SyncSourceSnapshot {
    foreach ($syncSource in $syncSourceTrees) {
        $syncCurrentTree = Read-SyncTree $syncSource.Tree.Root $syncSource.Name
        $syncOriginalFiles = [Collections.Generic.HashSet[string]]::new($syncSource.Tree.Files, [StringComparer]::OrdinalIgnoreCase)
        if (-not $syncOriginalFiles.SetEquals($syncCurrentTree.Files)) { throw 'The included source inventory changed after inspection.' }
    }
    foreach ($syncOriginalTree in @($syncUiTree)) {
        $syncCurrentTree = Read-SyncTree $syncOriginalTree.Root
        $syncOriginalFiles = [Collections.Generic.HashSet[string]]::new($syncOriginalTree.Files, [StringComparer]::OrdinalIgnoreCase)
        if (-not $syncOriginalFiles.SetEquals($syncCurrentTree.Files)) { throw 'The UI inventory changed after inspection.' }
    }
    $syncCurrentReceipts = @(Read-SyncReleaseReceipts)
    if ($syncCurrentReceipts.Count -ne $syncReleaseReceipts.Count) { throw 'The selected current-release receipt inventory changed after inspection.' }
    foreach ($syncOriginalReceipt in $syncReleaseReceipts) {
        $syncCurrentReceipt = @($syncCurrentReceipts | Where-Object { $_.Relative -ceq $syncOriginalReceipt.Relative })
        if ($syncCurrentReceipt.Count -ne 1 -or $syncCurrentReceipt[0].Source -cne $syncOriginalReceipt.Source -or
            $syncCurrentReceipt[0].Hash -cne $syncOriginalReceipt.Hash) {
            throw 'A selected current-release receipt changed after inspection.'
        }
    }
    foreach ($syncNestedReceipt in $syncNestedReceipts) {
        if ((Assert-SyncNestedReceiptPath $syncNestedReceipt.Relative) -cne $syncNestedReceipt.Source -or
            (Get-SyncFingerprint $syncNestedReceipt.Source $true) -cne $syncNestedReceipt.Hash) {
            throw 'A selected nested receipt changed after inspection.'
        }
    }
}

try {
    if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 is required.' }
    $syncPackage = Assert-SyncPackageTarget $syncPackage
    Assert-SyncAncestors $syncWorkspace
    Assert-SyncAncestors $syncPackage
    Assert-SyncAncestors $syncAcceptance
    Assert-SyncAncestors $syncReceiptPath $true $true
    Assert-SyncNoData
    $syncReceipt.exactRootsVerified = $true
    $syncReceipt.packageDataAbsent = $true

    # Complete every included source/target attribute audit before making the
    # concrete copy/delete plan. The full target trees have no exclusions.
    $syncSourceTrees = foreach ($syncName in @('app', 'scripts', 'docs', 'tests')) {
        [pscustomobject]@{ Name = $syncName; Tree = Read-SyncTree (Join-Path $syncWorkspace $syncName) $syncName }
    }
    $syncUiTree = Read-SyncTree (Join-Path $syncWorkspace 'app/dist')
    foreach ($syncScope in $syncScopes.Keys) {
        $syncDestinationTrees.Add([pscustomobject]@{ Scope = $syncScope; Tree = Read-SyncTree $syncScopes[$syncScope] '' $true })
    }
    Initialize-SyncPrivateStrings
    $syncReleaseReceipts = @(Read-SyncReleaseReceipts)
    $syncNestedReceipts = @()
    Assert-SyncAncestors (Join-Path $syncWorkspace 'README.md') $false $true
    Assert-SyncAncestors (Join-Path $syncWorkspace '.gitignore') $false $true
    foreach ($syncDocument in @('current-validation.md', 'ui-test-matrix.md')) {
        Assert-SyncAncestors (Join-Path $syncWorkspace ('docs/' + $syncDocument)) $false $true
    }
    $syncReceipt.ordinaryAncestorsVerified = $true
    $syncReceipt.sourceReparseAuditPassed = $true
    $syncReceipt.destinationReparseAuditPassed = $true

    foreach ($syncSource in $syncSourceTrees) {
        foreach ($syncFile in $syncSource.Tree.Files) {
            Add-SyncMapping $syncFile 'source/ae-switch' ($syncSource.Name + '/' + [IO.Path]::GetRelativePath($syncSource.Tree.Root, $syncFile))
        }
    }
    Add-SyncMapping (Join-Path $syncWorkspace 'README.md') 'source/ae-switch' 'README.md'
    Add-SyncMapping (Join-Path $syncWorkspace '.gitignore') 'source/ae-switch' '.gitignore'
    foreach ($syncFile in $syncUiTree.Files) { Add-SyncMapping $syncFile 'ui' ([IO.Path]::GetRelativePath($syncUiTree.Root, $syncFile)) }
    foreach ($syncReleaseReceipt in $syncReleaseReceipts) {
        Add-SyncMapping $syncReleaseReceipt.Source 'verification' $syncReleaseReceipt.Relative
    }
    foreach ($syncDocument in @('current-validation.md', 'ui-test-matrix.md')) {
        Add-SyncMapping (Join-Path $syncWorkspace ('docs/' + $syncDocument)) 'verification' $syncDocument
    }
    foreach ($syncMapping in $syncMappings) {
        $syncSourceHash = Get-SyncFingerprint $syncMapping.Source $true
        $syncBeforeHash = if ($null -ne (Get-SyncAttributes $syncMapping.Destination $true)) { Get-SyncFingerprint $syncMapping.Destination } else { $null }
        $syncPlan.Add([pscustomobject]@{
            Source = $syncMapping.Source; Destination = $syncMapping.Destination; Scope = $syncMapping.Scope
            SourceHash = $syncSourceHash; BeforeHash = $syncBeforeHash
            Action = if ($syncSourceHash -ceq $syncBeforeHash) { 'unchanged' } else { 'copy' }
        })
    }
    foreach ($syncDestination in $syncDestinationTrees) {
        foreach ($syncFile in $syncDestination.Tree.Files) {
            if ($syncExpected.Contains($syncFile)) { continue }
            $null = Assert-SyncChild $syncScopes[$syncDestination.Scope] $syncFile
            $syncPlan.Add([pscustomobject]@{
                Source = $null; Destination = $syncFile; Scope = $syncDestination.Scope
                SourceHash = $null; BeforeHash = Get-SyncFingerprint $syncFile; Action = 'delete'
            })
        }
    }
    $syncReceipt.scopes = @(foreach ($syncScope in $syncScopes.Keys) {
        $syncEntries = @($syncPlan | Where-Object { $_.Scope -ceq $syncScope })
        [ordered]@{
            scope = $syncScope
            copyFiles = @($syncEntries | Where-Object { $_.Action -ceq 'copy' }).Count
            unchangedFiles = @($syncEntries | Where-Object { $_.Action -ceq 'unchanged' }).Count
            obsoleteFiles = @($syncEntries | Where-Object { $_.Action -ceq 'delete' }).Count
        }
    })
    $syncReceipt.sourceCredentialScanPassed = $true
    $syncReceipt.plannedPathsWithinAllowedSubtrees = $true
    $syncReceipt.safetyPassed = $true
    $syncSafetyPassed = $true

    if (-not $CheckOnly) {
        Assert-SyncNoData
        Assert-SyncSourceSnapshot
        foreach ($syncDestination in $syncDestinationTrees) {
            $syncCurrentTree = Read-SyncTree $syncDestination.Tree.Root '' $true
            $syncOriginalFiles = [Collections.Generic.HashSet[string]]::new($syncDestination.Tree.Files, [StringComparer]::OrdinalIgnoreCase)
            if (-not $syncOriginalFiles.SetEquals($syncCurrentTree.Files)) { throw 'A destination inventory changed after inspection.' }
        }
        foreach ($syncEntry in $syncPlan) { Assert-SyncPlannedFile $syncEntry }
        $syncReceipt.mutationStarted = $true
        foreach ($syncEntry in $syncPlan) {
            if ($syncEntry.Action -ceq 'copy') { Copy-SyncPlannedFile $syncEntry }
        }
        foreach ($syncEntry in $syncPlan) {
            if ($syncEntry.Action -cne 'delete') { continue }
            Assert-SyncPlannedFile $syncEntry
            [IO.File]::Delete($syncEntry.Destination)
            $syncReceipt.removedFiles++
        }
        # Check the resulting trees and exact bytes before recording success.
        Assert-SyncNoData
        Assert-SyncSourceSnapshot
        foreach ($syncScope in $syncScopes.Keys) {
            $syncFinalTree = Read-SyncTree $syncScopes[$syncScope]
            foreach ($syncFile in $syncFinalTree.Files) {
                if (-not $syncExpected.Contains($syncFile)) { throw 'An unexpected file remains in a synchronized subtree.' }
            }
        }
        foreach ($syncEntry in $syncPlan) {
            if ($syncEntry.Action -ceq 'delete') {
                if ($null -ne (Get-SyncAttributes $syncEntry.Destination $true)) { throw 'An obsolete file remains after synchronization.' }
            } elseif ((Get-SyncFingerprint $syncEntry.Source $true) -cne $syncEntry.SourceHash -or
                (Get-SyncFingerprint $syncEntry.Destination $true) -cne $syncEntry.SourceHash) { throw 'A synchronized source/package pair changed or differs.' }
        }
    }
    $syncReceipt.passed = $true
} catch {
    # Never echo exception messages, input contents, keys, or unrestricted paths.
    $syncReceipt.error = [ordered]@{ errorType = $_.Exception.GetType().FullName; hresult = $_.Exception.HResult }
}

if (-not $CheckOnly -and $syncSafetyPassed) {
    $syncReceiptTemporaryOwned = $false
    try {
        Assert-SyncAncestors $syncReceiptPath $true $true
        $syncReceiptTemporary = Join-Path ([IO.Path]::GetDirectoryName($syncReceiptPath)) ('.ae-final-sync-receipt-' + [Guid]::NewGuid().ToString('N') + '.tmp')
        $syncReceiptStream = [IO.FileStream]::new($syncReceiptTemporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $syncReceiptTemporaryOwned = $true
        try {
            $syncReceiptBytes = $syncUtf8.GetBytes(($syncReceipt | ConvertTo-Json -Depth 8))
            $syncReceiptStream.Write($syncReceiptBytes, 0, $syncReceiptBytes.Length)
            $syncReceiptStream.Flush($true)
        } finally { $syncReceiptStream.Dispose() }
        Assert-SyncAncestors $syncReceiptTemporary $false $true
        Assert-SyncAncestors $syncReceiptPath $true $true
        [IO.File]::Move($syncReceiptTemporary, $syncReceiptPath, $true)
        $syncReceiptTemporaryOwned = $false
    } catch {
        $syncReceipt.passed = $false
        $syncReceipt.error = [ordered]@{ errorType = $_.Exception.GetType().FullName; hresult = $_.Exception.HResult }
    } finally {
        if ($syncReceiptTemporaryOwned) {
            try {
                $null = Assert-SyncChild (Join-Path $syncWorkspace 'artifacts') $syncReceiptTemporary
                Assert-SyncAncestors $syncReceiptTemporary $false $true
                [IO.File]::Delete($syncReceiptTemporary)
            } catch {
                $syncReceipt.passed = $false
                $syncReceipt.error = [ordered]@{ errorType = $_.Exception.GetType().FullName; hresult = $_.Exception.HResult }
            }
        }
    }
}
$syncReceipt | ConvertTo-Json -Depth 8
if (-not $syncReceipt.passed) { exit 1 }
