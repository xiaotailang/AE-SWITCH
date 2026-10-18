[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7 -or -not $IsWindows) { throw 'This owned junction regression requires Windows PowerShell 7.' }
$testWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$testId = [Guid]::NewGuid().ToString('N')
$testRoot = Join-Path $testWorkspace ('.cache/native-cleanup-regression/' + $testId)
$testMarker = Join-Path $testRoot '.ae-native-cleanup-test-owner.json'
$testReportPath = Join-Path $testWorkspace 'artifacts/acceptance/owned-native-cleanup-regression.json'
$testUtf8 = [Text.UTF8Encoding]::new($false)
$testCaseOwners = @{}
$testLinks = @{}
$testResults = [Collections.Generic.List[object]]::new()
$testReport = @{ recordedAt = [DateTime]::UtcNow.ToString('o'); ownedFixtureRoot = $testRoot; ownerId = $testId;
    scope = 'Real cleanup functions extracted from wrapper AST; wrapper main and actual acceptance sandboxes are never executed or touched.';
    wrapperMainExecuted = $false; childProcessesLaunched = $false; passed = $false; cleanup = @{ removed = $false } }

function Assert-TestPath([string]$Location, [switch]$AllowMissing) {
    $absolute = [IO.Path]::GetFullPath($Location)
    if ($absolute -notmatch '^[Gg]:[\\/]' -or -not $absolute.StartsWith($testWorkspace + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Regression paths must stay inside the G: workspace.'
    }
    $ancestor = $absolute
    while ($ancestor) {
        try {
            if ([IO.File]::GetAttributes($ancestor) -band [IO.FileAttributes]::ReparsePoint) { throw 'Regression path has a reparse ancestor.' }
        } catch [IO.FileNotFoundException] { if (-not $AllowMissing) { throw } }
        catch [IO.DirectoryNotFoundException] { if (-not $AllowMissing) { throw } }
        if ($ancestor -eq [IO.Path]::GetPathRoot($testWorkspace)) { break }
        $ancestor = [IO.Path]::GetDirectoryName($ancestor)
    }
    $absolute
}
function Assert-FixtureLocation([string]$Location) {
    $absolute = [IO.Path]::GetFullPath($Location)
    if ($absolute -ne $testRoot -and -not $absolute.StartsWith($testRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Regression operation escaped its fresh owned GUID root.'
    }
    $absolute
}
function Assert-TestOwner {
    $null = Assert-TestPath $testRoot
    $null = Assert-TestPath $testMarker
    $owner = [IO.File]::ReadAllText($testMarker) | ConvertFrom-Json
    if ($owner.id -ne $testId -or $owner.workspace -ne $testWorkspace -or $owner.root -ne $testRoot -or
        $owner.purpose -ne 'Owned native cleanup function boundary regression') { throw 'Fresh regression ownership marker mismatch.' }
}
function New-TestCase([string]$Name, [bool]$Native) {
    Assert-TestOwner
    $caseId = [Guid]::NewGuid().ToString('N')
    $location = Assert-FixtureLocation (Join-Path $testRoot $caseId)
    $null = Assert-TestPath $location -AllowMissing
    [IO.Directory]::CreateDirectory($location) | Out-Null
    $marker = Join-Path $location $(if ($Native) { '.ae-native-e2e-owner.json' } else { '.ae-switch-e2e-owner.json' })
    $purpose = if ($Native) { 'AE Switch owned native UI and real tool acceptance' } else { 'AE Switch owned E2E tool installation' }
    [IO.File]::WriteAllText($marker, (@{ id = $caseId; workspace = $testWorkspace; purpose = $purpose } | ConvertTo-Json), $testUtf8)
    $cache = Join-Path $location 'portable/data/home/AppData/Local/Microsoft/Windows/INetCache'
    $target = Join-Path $cache 'IE'
    [IO.Directory]::CreateDirectory($target) | Out-Null
    [IO.File]::WriteAllText((Join-Path $target 'target-sentinel.txt'), 'KEEP_TARGET', $testUtf8)
    [IO.File]::WriteAllText((Join-Path $location 'ordinary-sentinel.txt'), 'KEEP_ORDINARY', $testUtf8)
    $case = @{ name = $Name; id = $caseId; root = $location; marker = $marker; native = $Native; purpose = $purpose;
        cache = $cache; alias = (Join-Path $cache 'Content.IE5'); target = $target }
    $testCaseOwners[$location] = $case
    return $case
}
function New-TestLink([string]$Link, [string]$Target) {
    Assert-TestOwner
    $null = Assert-FixtureLocation $Link
    $null = Assert-FixtureLocation $Target
    $null = Assert-TestPath ([IO.Path]::GetDirectoryName($Link))
    $null = Assert-TestPath $Target
    if (Test-Path -LiteralPath $Link) { throw 'A regression junction must be newly created.' }
    New-Item -ItemType Junction -Path $Link -Target $Target | Out-Null
    $testLinks[[IO.Path]::GetFullPath($Link)] = [IO.Path]::GetFullPath($Target)
}
function Get-TestSnapshot([string]$Location) {
    $null = Assert-FixtureLocation $Location
    $pending = [Collections.Generic.Stack[string]]::new()
    $items = [Collections.Generic.List[string]]::new()
    $pending.Push($Location)
    while ($pending.Count) {
        $current = $pending.Pop()
        $null = Assert-TestPath $current
        foreach ($entry in Get-ChildItem -LiteralPath $current -Force) {
            $null = Assert-FixtureLocation $entry.FullName
            $relative = [IO.Path]::GetRelativePath($Location, $entry.FullName)
            if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                $items.Add("$relative|junction|$($entry.LinkType)|$(@($entry.Target) -join '|')")
            } elseif ($entry.PSIsContainer) { $items.Add("$relative|directory"); $pending.Push($entry.FullName) }
            else {
                $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($entry.FullName)))
                $items.Add("$relative|file|$hash")
            }
        }
    }
    return (@($items | Sort-Object) -join "`n")
}
function Invoke-TestCase($Case, [bool]$ExpectedReject, [string]$ExternalSentinel) {
    Assert-TestOwner
    if (-not $testCaseOwners.ContainsKey($Case.root)) { throw 'Unknown regression case ownership.' }
    $null = Assert-FixtureLocation $Case.root
    $null = Assert-TestPath $Case.root
    $null = Assert-TestPath $Case.marker
    $owner = [IO.File]::ReadAllText($Case.marker) | ConvertFrom-Json
    if ($owner.id -ne $Case.id -or $owner.workspace -ne $testWorkspace -or $owner.purpose -ne $Case.purpose) { throw 'Case ownership marker mismatch.' }
    $before = Get-TestSnapshot $Case.root
    $externalBefore = [IO.File]::ReadAllText($ExternalSentinel)
    $script:NativeUi = $Case.native
    $script:e2eWorkspace = $testWorkspace
    $script:e2eMarker = $Case.marker
    $script:e2eBase = $testRoot
    $script:e2eSandbox = $Case.root
    $script:e2eIdentifier = $Case.id
    $script:e2ePurpose = $Case.purpose
    $script:e2eNativeMarkerHash = (Get-FileHash -LiteralPath $Case.marker -Algorithm SHA256).Hash.ToLowerInvariant()
    $script:e2eOwnedNativeProcesses = @{}
    $script:e2eReport = Join-Path $testRoot 'missing-wrapper-report.json'
    $script:e2eUtf8 = $testUtf8
    $rejected = $false
    try { Remove-E2eOwnedTree $Case.root } catch { $rejected = $true }
    if ($rejected -ne $ExpectedReject) { throw "Unexpected cleanup disposition for $($Case.name)." }
    if ([IO.File]::ReadAllText($ExternalSentinel) -ne $externalBefore) { throw 'Cleanup changed a sentinel outside its case sandbox.' }
    if ($ExpectedReject) {
        if (-not [IO.Directory]::Exists($Case.root) -or (Get-TestSnapshot $Case.root) -ne $before) {
            throw 'Rejected cleanup mutated its tree before the complete audit passed.'
        }
    } elseif ([IO.Directory]::Exists($Case.root)) { throw 'Allowed owned cache junction cleanup did not remove its sandbox.' }
    $testResults.Add(@{ name = $Case.name; expectedRejected = $ExpectedReject; actualRejected = $rejected;
        noPreAuditMutation = if ($ExpectedReject) { $true } else { $null }; outsideCaseSentinelPreserved = $true; passed = $true })
}
function Remove-TestFixture {
    Assert-TestOwner
    $pending = [Collections.Generic.Stack[string]]::new()
    $directories = [Collections.Generic.List[string]]::new()
    $files = [Collections.Generic.List[string]]::new()
    $links = [Collections.Generic.List[string]]::new()
    $pending.Push($testRoot)
    # Audit every ordinary entry and each exact junction created by this script before any deletion.
    while ($pending.Count) {
        $current = Assert-TestPath $pending.Pop()
        $null = Assert-FixtureLocation $current
        $directories.Add($current)
        foreach ($entry in Get-ChildItem -LiteralPath $current -Force) {
            $null = Assert-FixtureLocation $entry.FullName
            if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                if (-not $testLinks.ContainsKey($entry.FullName) -or $entry.LinkType -ne 'Junction' -or @($entry.Target).Count -ne 1 -or
                    [IO.Path]::GetFullPath(@($entry.Target)[0]) -ne $testLinks[$entry.FullName]) { throw 'Fixture cleanup found an unowned reparse entry.' }
                $null = Assert-FixtureLocation $testLinks[$entry.FullName]
                $null = Assert-TestPath $testLinks[$entry.FullName]
                $links.Add($entry.FullName)
            } elseif ($entry.PSIsContainer) { $pending.Push($entry.FullName) }
            elseif ($entry.FullName -ne $testMarker) { $null = Assert-TestPath $entry.FullName; $files.Add($entry.FullName) }
        }
    }
    foreach ($link in $links) {
        $null = Assert-TestPath ([IO.Path]::GetDirectoryName($link))
        $metadata = Get-Item -LiteralPath $link -Force
        if ($metadata.LinkType -ne 'Junction' -or @($metadata.Target).Count -ne 1 -or
            [IO.Path]::GetFullPath(@($metadata.Target)[0]) -ne $testLinks[$link]) { throw 'Owned fixture junction changed after audit.' }
        [IO.Directory]::Delete($link, $false)
    }
    foreach ($file in $files) { $null = Assert-TestPath $file; Remove-Item -LiteralPath $file -Force }
    for ($index = $directories.Count - 1; $index -gt 0; $index--) {
        $null = Assert-TestPath $directories[$index]
        [IO.Directory]::Delete($directories[$index], $false)
    }
    $null = Assert-TestPath $testMarker
    Remove-Item -LiteralPath $testMarker -Force
    $null = Assert-TestPath $testRoot
    [IO.Directory]::Delete($testRoot, $false)
    $testReport.cleanup = @{ removed = -not [IO.Directory]::Exists($testRoot); ownerValidated = $true;
        wholeTreeAuditedBeforeDeletion = $true; junctionsUnlinkedWithoutTraversal = $true; recursiveDeletionUsed = $false }
}

$null = Assert-TestPath $testRoot -AllowMissing
$null = Assert-TestPath $testReportPath -AllowMissing
if (Test-Path -LiteralPath $testRoot) { throw 'The regression GUID root must be fresh.' }
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
[IO.File]::WriteAllText($testMarker, (@{ id = $testId; workspace = $testWorkspace; root = $testRoot;
    purpose = 'Owned native cleanup function boundary regression' } | ConvertTo-Json), $testUtf8)
try {
    $wrapper = Join-Path $testWorkspace 'scripts/verify-portable-e2e.ps1'
    $null = Assert-TestPath $wrapper
    $tokens = $null
    $errors = $null
    $wrapperBytes = [IO.File]::ReadAllBytes($wrapper)
    $ast = [Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::UTF8.GetString($wrapperBytes), $wrapper, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw 'The wrapper AST has parse errors.' }
    $testReport.wrapperSha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($wrapperBytes)).ToLowerInvariant()
    $testReport.extractedFunctions = @('Assert-E2eLocalPath', 'Remove-E2eOwnedTree',
        'Test-E2eCleanupSharingViolation', 'Assert-E2eNativeCleanupRetryScope', 'Remove-E2eOwnedLockedFile',
        'Test-E2eCleanupDirectoryNotEmpty', 'Wait-E2eOwnedDirectoryRetry',
        'Assert-E2eNativeOwner', 'Initialize-E2eNativeProcessInterop', 'Assert-E2eNativeProcessesExited',
        'Get-E2eNativeProcessById', 'Get-E2eNativeProcessPath', 'Test-E2eNativeCreationTime')
    foreach ($name in $testReport.extractedFunctions) {
        $definitions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $false))
        if ($definitions.Count -ne 1) { throw 'Exactly one actual top-level cleanup function is required.' }
        . ([ScriptBlock]::Create($definitions[0].Extent.Text))
    }
    $external = Join-Path $testRoot 'outside-case-owned-target'
    [IO.Directory]::CreateDirectory($external) | Out-Null
    $sentinel = Join-Path $external 'sentinel.txt'
    [IO.File]::WriteAllText($sentinel, 'KEEP_OUTSIDE_CASE', $testUtf8)

    $case = New-TestCase 'native_exact_internal_junction_allowed' $true
    New-TestLink $case.alias $case.target
    Invoke-TestCase $case $false $sentinel

    $case = New-TestCase 'same_alias_other_owned_target_rejected' $true
    $otherTarget = Join-Path $case.root 'other-owned-target'
    [IO.Directory]::CreateDirectory($otherTarget) | Out-Null
    [IO.File]::WriteAllText((Join-Path $otherTarget 'sentinel.txt'), 'KEEP_OTHER_TARGET', $testUtf8)
    New-TestLink $case.alias $otherTarget
    Invoke-TestCase $case $true $sentinel

    $case = New-TestCase 'same_alias_outside_case_target_rejected' $true
    New-TestLink $case.alias $external
    Invoke-TestCase $case $true $sentinel

    $case = New-TestCase 'non_native_correct_junction_rejected' $false
    New-TestLink $case.alias $case.target
    Invoke-TestCase $case $true $sentinel

    $case = New-TestCase 'other_alias_internal_junction_rejected' $true
    New-TestLink (Join-Path $case.cache 'OtherAlias') $case.target
    Invoke-TestCase $case $true $sentinel

    $case = New-TestCase 'allowed_then_unexpected_link_preserves_entire_tree' $true
    New-TestLink $case.alias $case.target
    New-TestLink (Join-Path $case.root 'unexpected-alias') $external
    Invoke-TestCase $case $true $sentinel

    Remove-TestFixture
    if (-not $testReport.cleanup.removed) { throw 'Fresh owned regression fixture root remains.' }
    $testReport.passed = $testResults.Count -eq 6
} catch {
    # Stop at the first unexpected failure; retain the entire owned fixture as evidence.
    $testReport.failure = $_.Exception.Message
    $testReport.passed = $false
} finally {
    $testReport.cases = $testResults.ToArray()
    $null = Assert-TestPath $testReportPath -AllowMissing
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($testReportPath)) | Out-Null
    [IO.File]::WriteAllText($testReportPath, ($testReport | ConvertTo-Json -Depth 30), $testUtf8)
}
@{ passed = $testReport.passed; casesPassed = $testResults.Count; fixtureRemoved = $testReport.cleanup.removed;
    report = $testReportPath; failure = $testReport.failure } | ConvertTo-Json -Compress
if (-not $testReport.passed) { exit 1 }
