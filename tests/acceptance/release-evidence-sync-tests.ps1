#requires -Version 7.0
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$evidenceWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$evidenceScript = Join-Path $evidenceWorkspace 'scripts/sync-final-package.ps1'
$evidenceTokens = $null
$evidenceErrors = $null
$evidenceAst = [Management.Automation.Language.Parser]::ParseFile($evidenceScript, [ref]$evidenceTokens, [ref]$evidenceErrors)
if ($evidenceErrors.Count) { throw 'Synchronization source must parse.' }
function Import-EvidenceFunction([string]$Name) {
    $definition = $evidenceAst.Find({ param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $Name
    }, $false)
    if (-not $definition) { throw ('Missing current-release evidence boundary: ' + $Name) }
    return [scriptblock]::Create($definition.Extent.Text)
}
foreach ($name in @('Get-SyncAttributes', 'Assert-SyncChild', 'Assert-SyncAncestors',
    'Get-SyncFingerprint', 'Assert-SyncReleaseReceiptPath', 'Read-SyncReleaseReceipts', 'Assert-SyncSourceSnapshot')) {
    . (Import-EvidenceFunction $name)
}
$evidenceWhitelist = $evidenceAst.Find({ param($node)
    $node -is [Management.Automation.Language.AssignmentStatementAst] -and
    $node.Left -is [Management.Automation.Language.VariableExpressionAst] -and
    $node.Left.VariablePath.UserPath -ceq 'syncReleaseReceiptWhitelist'
}, $false)
if (-not $evidenceWhitelist) { throw 'Missing exact current-release evidence allowlist.' }
. ([scriptblock]::Create($evidenceWhitelist.Extent.Text))

$evidencePassed = 0
function Assert-Evidence([bool]$Condition, [string]$Label) {
    if (-not $Condition) { throw ('Release evidence regression failed: ' + $Label) }
    $script:evidencePassed++
}
function Assert-EvidenceRejected([scriptblock]$Action, [string]$Label) {
    $rejected = $false
    try { $null = & $Action } catch { $rejected = $true }
    Assert-Evidence $rejected $Label
}
$evidenceExpected = @(
    'krill-current-validation-summary-da709301727647a68a1c652dc6cfcd84.json'
    'validation-status.json'
    'final-package-boundaries.json'
    'final-package-correspondence.json'
)
Assert-Evidence ($syncReleaseReceiptWhitelist.Count -eq $evidenceExpected.Count) 'release receipt selection has no implicit files'
foreach ($name in $evidenceExpected) { Assert-Evidence ($syncReleaseReceiptWhitelist -ccontains $name) 'reviewed small receipt is explicitly selected' }
$evidenceScope = $evidenceAst.Find({ param($node)
    ($node -is [Management.Automation.Language.StringConstantExpressionAst] -or
        $node -is [Management.Automation.Language.ExpandableStringExpressionAst]) -and
    $node.Value -like '*exact reviewed small JSON receipts*'
}, $false)
if (-not $evidenceScope) { throw 'Missing reviewed evidence scope description.' }
$evidenceScopeText = & ([scriptblock]::Create($evidenceScope.Extent.Text))
Assert-Evidence ($evidenceScopeText.StartsWith("$($evidenceExpected.Count) exact reviewed small JSON receipts", [StringComparison]::Ordinal)) 'scope description derives its receipt count from the exact allowlist'
foreach ($name in @('native-e2e-wrapper.json', 'native-tray.json', 'native-ui-results.json',
    'native-ui-retest/native-ui-results.json', 'native-ui-retest/failure.png',
    'retest-history/native-thirty-ninth-ui.json', 'unreviewed-new-report.json',
    'installed-client-release-summary-cb77bcd193cb4de89cb6295454597b74.json',
    'existing-readback-independent-20261010.json',
    'official-test-installations-cleanup-20261010.json',
    'workbuddy-default-model-offline-path-review-20261010.json',
    'workbuddy-gui-default-selection-review-20261010.json',
    'windows-write-restricted-surrogate-9cb091d175c94356af499c79fadb0da7.json',
    'official-cleanup-hardlink-fix-review-20261010.log',
    'auth.json', 'providers.json', 'credentials.json', '../validation-status.json',
    'validation-status.json:stream', 'validation-status.json/child', '/validation-status.json',
    'G:/validation-status.json', 'C:/validation-status.json', 'VALIDATION-STATUS.JSON',
    "validation-status.json`n")) {
    Assert-EvidenceRejected { Assert-SyncReleaseReceiptPath $name } 'raw/unreviewed/unsafe evidence remains excluded'
}
foreach ($name in $evidenceExpected | Select-Object -Last 4) {
    foreach ($relative in @(('../' + $name), ('nested/' + $name), ($name + ':stream'),
        ($name + '/child'), $name.ToUpperInvariant())) {
        Assert-EvidenceRejected { Assert-SyncReleaseReceiptPath $relative } 'new receipts retain exact case and path boundaries'
    }
}

$evidenceId = [Guid]::NewGuid().ToString('N')
$evidenceRoot = [IO.Path]::GetFullPath((Join-Path $evidenceWorkspace ('.cache/release-evidence-sync-' + $evidenceId)))
if ($evidenceRoot -notlike 'G:\*' -or -not $evidenceRoot.StartsWith($evidenceWorkspace + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture must remain in this G: workspace.' }
Assert-SyncAncestors $evidenceRoot $true
if (Test-Path -LiteralPath $evidenceRoot) { throw 'Owned evidence fixture must be fresh.' }
$syncAcceptance = $evidenceRoot
$syncUtf8 = [Text.UTF8Encoding]::new($false)
$syncPrivateStrings = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$null = $syncPrivateStrings.Add('owned-fixture-secret-only-4c2d2ea9')
try {
    [IO.Directory]::CreateDirectory($evidenceRoot) | Out-Null
    [IO.File]::WriteAllText((Join-Path $evidenceRoot '.ae-evidence-owner'), $evidenceId, $syncUtf8)
    foreach ($name in $evidenceExpected) {
        [IO.File]::WriteAllText((Join-Path $evidenceRoot $name), '{"passed":false,"scope":"Synthetic receipt only"}', $syncUtf8)
        Assert-Evidence ((Assert-SyncReleaseReceiptPath $name) -ceq [IO.Path]::GetFullPath((Join-Path $evidenceRoot $name))) 'each exact selected receipt resolves under the acceptance root'
    }
    [IO.File]::WriteAllText((Join-Path $evidenceRoot 'native-e2e-wrapper.json'), 'owned-fixture-secret-only-4c2d2ea9', $syncUtf8)
    [IO.File]::WriteAllText((Join-Path $evidenceRoot 'workbuddy-default-model-offline-path-review-20261010.json'), 'owned-fixture-secret-only-4c2d2ea9', $syncUtf8)
    $receipts = @(Read-SyncReleaseReceipts)
    Assert-Evidence ($receipts.Count -eq $evidenceExpected.Count) 'raw reports are not read or selected even when they contain a secret'
    foreach ($receipt in $receipts) {
        Assert-Evidence ($receipt.Hash -cmatch '\A[a-f0-9]{64}\z') 'selected receipt binds exact source bytes'
        Assert-Evidence ($receipt.Source -ceq [IO.Path]::GetFullPath((Join-Path $evidenceRoot $receipt.Relative))) 'selected source resolves under exact acceptance root'
    }
    foreach ($name in $evidenceExpected | Select-Object -Last 4) {
        $missing = Join-Path $evidenceRoot $name
        [IO.File]::Delete($missing)
        Assert-EvidenceRejected { Read-SyncReleaseReceipts } 'each new reviewed receipt is required rather than silently omitted'
        [IO.File]::WriteAllText($missing, '{"passed":false,"scope":"Synthetic receipt only"}', $syncUtf8)
    }
    $selected = Join-Path $evidenceRoot 'validation-status.json'
    foreach ($invalid in @('not-json', '[]', '[{}]', '[{"passed":true}]', 'null', ('{"padding":"' + ('x' * 131072) + '"}'), '{"apiKey":"owned-fixture-secret-only-4c2d2ea9"}')) {
        [IO.File]::WriteAllText($selected, $invalid, $syncUtf8)
        Assert-EvidenceRejected { Read-SyncReleaseReceipts } 'selected evidence must be a small credential-free JSON object'
    }
    [IO.File]::Delete($selected)
    Assert-EvidenceRejected { Read-SyncReleaseReceipts } 'missing reviewed receipt does not silently omit its evidence'
    [IO.Directory]::CreateDirectory($selected) | Out-Null
    Assert-EvidenceRejected { Read-SyncReleaseReceipts } 'directory cannot stand in for a reviewed receipt'
    [IO.Directory]::Delete($selected)
    [IO.File]::WriteAllText($selected, '{}', $syncUtf8)
    $syncReleaseReceipts = @(Read-SyncReleaseReceipts)
    $before = @($syncReleaseReceipts | Where-Object Relative -CEQ 'validation-status.json')[0].Hash
    $syncSourceTrees = @()
    $syncUiTree = [pscustomobject]@{ Root = $evidenceRoot; Files = [Collections.Generic.List[string]]::new() }
    $syncNestedReceipts = @()
    function Read-SyncTree([string]$Root) { return [pscustomobject]@{ Root = $Root; Files = [Collections.Generic.List[string]]::new() } }
    Assert-SyncSourceSnapshot
    Assert-Evidence $true 'selected receipt snapshot accepts unchanged reviewed files'
    [IO.File]::WriteAllText((Join-Path $evidenceRoot 'unreviewed-new-report.json'), 'raw output remains outside release scope', $syncUtf8)
    Assert-SyncSourceSnapshot
    Assert-Evidence $true 'unselected raw inventory never becomes a release input'
    [IO.File]::WriteAllText($selected, '{"changed":true}', $syncUtf8)
    $after = @(Read-SyncReleaseReceipts | Where-Object Relative -CEQ 'validation-status.json')[0].Hash
    Assert-Evidence ($before -cne $after) 'selected changes alter the source snapshot identity'
    Assert-EvidenceRejected { Assert-SyncSourceSnapshot } 'selected receipt change is rejected before mutation'
} finally {
    Assert-SyncAncestors $evidenceRoot
    if ([IO.File]::ReadAllText((Join-Path $evidenceRoot '.ae-evidence-owner')) -cne $evidenceId) { throw 'Evidence fixture ownership changed; cleanup refused.' }
    foreach ($entry in [IO.Directory]::GetFileSystemEntries($evidenceRoot)) {
        Assert-SyncAncestors $entry $false $true
        [IO.File]::Delete($entry)
    }
    [IO.Directory]::Delete($evidenceRoot)
    if (Test-Path -LiteralPath $evidenceRoot) { throw 'Owned evidence fixture cleanup incomplete.' }
}
[ordered]@{
    passed = $true; testsPassed = $evidencePassed
    ownedFixtureRemoved = $true; realCredentialsRead = $false
    synchronizationBodyExecuted = $false; externalActionsPerformed = $false
} | ConvertTo-Json
