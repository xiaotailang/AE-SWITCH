#requires -Version 7.0
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$syncTestWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$syncTestScript = Join-Path $syncTestWorkspace 'scripts/sync-final-package.ps1'
$syncTestTokens = $null
$syncTestErrors = $null
$syncTestAst = [Management.Automation.Language.Parser]::ParseFile($syncTestScript, [ref]$syncTestTokens, [ref]$syncTestErrors)
if ($syncTestErrors.Count) { throw 'The synchronization script must parse before safety regression checks.' }

# Load only the isolated safety functions and constant whitelist. The script's
# top-level planning/mutation body is never invoked by these unit regressions.
function Import-SyncTestFunction([string]$Name) {
    $syncTestFunction = $syncTestAst.Find({
        param($Node)
        $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -ceq $Name
    }, $false)
    if (-not $syncTestFunction) { throw ('Required safety function is missing: ' + $Name) }
    return [scriptblock]::Create($syncTestFunction.Extent.Text)
}
foreach ($syncTestName in @('Get-SyncAttributes', 'Assert-SyncChild', 'Assert-SyncAncestors', 'Assert-SyncNestedReceiptPath', 'Assert-SyncSourceSnapshot', 'Assert-SyncPackageTarget')) {
    . (Import-SyncTestFunction $syncTestName)
}
$syncTestWhitelistAssignment = $syncTestAst.Find({
    param($Node)
    $Node -is [Management.Automation.Language.AssignmentStatementAst] -and
        $Node.Left -is [Management.Automation.Language.VariableExpressionAst] -and
        $Node.Left.VariablePath.UserPath -ceq 'syncNestedReceiptWhitelist'
}, $false)
if (-not $syncTestWhitelistAssignment) { throw 'The exact nested receipt whitelist is missing.' }
. ([scriptblock]::Create($syncTestWhitelistAssignment.Extent.Text))

$syncAcceptance = Join-Path $syncTestWorkspace 'artifacts/acceptance'
$syncTestPassed = 0
function Assert-SyncTest([bool]$Condition, [string]$Label) {
    if (-not $Condition) { throw ('Regression failed: ' + $Label) }
    $script:syncTestPassed++
}
function Assert-SyncTestRejected([scriptblock]$Action, [string]$Label, [string]$ExpectedReason = '') {
    $syncTestRejected = $false
    try { $null = & $Action } catch {
        if ($ExpectedReason -and $_.Exception.Message -cne $ExpectedReason) {
            throw ('Unexpected rejection branch: ' + $Label + ' (' + $_.Exception.GetType().Name + ', line ' + $_.InvocationInfo.ScriptLineNumber + ')')
        }
        $syncTestRejected = -not $ExpectedReason -or $_.Exception.Message -ceq $ExpectedReason
    }
    Assert-SyncTest $syncTestRejected $Label
}

$syncWorkspace = $syncTestWorkspace
$syncTestFreshPackage = Join-Path $syncTestWorkspace 'artifacts/AE-Switch-portable-win-x64-existing-0123456789abcdef0123456789abcdef'
Assert-SyncTest ((Assert-SyncPackageTarget $syncTestFreshPackage) -ceq $syncTestFreshPackage) 'explicit fresh AE-only package is selectable without touching old distribution'
foreach ($syncTestInvalidPackage in @('', $syncTestWorkspace,
    (Join-Path $syncTestWorkspace 'artifacts/AE-Switch-portable-win-x64'),
    (Join-Path $syncTestWorkspace 'artifacts/AE-Switch-portable-win-x64-existing-safe/child'),
    (Join-Path $syncTestWorkspace '.cache/AE-Switch-portable-win-x64-existing-safe'),
    'C:/AE-Switch-portable-win-x64-existing-safe',
    (Join-Path $syncTestWorkspace 'artifacts/AE-Switch-portable-win-x64-existing-safe:stream'))) {
    Assert-SyncTestRejected { Assert-SyncPackageTarget $syncTestInvalidPackage } 'unsafe, unspecified or superseded package target is rejected before filesystem access'
}

$syncTestCurrentReceipts = @(
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
Assert-SyncTest ($syncNestedReceiptWhitelist.Count -eq $syncTestCurrentReceipts.Count) 'selected receipts match the exact reviewed set size'
foreach ($syncTestRelative in $syncTestCurrentReceipts) {
    Assert-SyncTest ($syncNestedReceiptWhitelist -ccontains $syncTestRelative) 'current receipt remains explicitly selected'
}
Assert-SyncTest ($syncNestedReceiptWhitelist -cnotcontains 'retest-history/native-first-ui.json') 'unselected historical reports remain excluded'
Assert-SyncTest ($syncNestedReceiptWhitelist -cnotcontains 'retest-history/native-thirty-third-ui-failure.png') 'native screenshots are not nested JSON receipts'
Assert-SyncTest ($syncNestedReceiptWhitelist -cnotcontains 'retest-history/native-thirty-ninth-ui.json') 'unreviewed later native reports remain excluded'
Assert-SyncTest ($syncNestedReceiptWhitelist -cnotcontains 'history-preservation-0123456789abcdef0123456789abcdef/retained-evidence-audit.json') 'history syntax support does not select an unreviewed audit'
foreach ($syncTestRelative in $syncNestedReceiptWhitelist) {
    $syncTestResolved = Assert-SyncNestedReceiptPath $syncTestRelative
    Assert-SyncTest ($syncTestResolved -ceq [IO.Path]::GetFullPath((Join-Path $syncAcceptance $syncTestRelative))) 'whitelisted receipt resolves inside acceptance'
}
foreach ($syncTestRelative in @(
    'native-gateway/0123456789abcdef0123456789abcdef/native-gateway-results.json'
    'native-gateway/0123456789abcdef0123456789abcdef/native-gateway-wrapper.json'
    'history-preservation-0123456789abcdef0123456789abcdef/retained-evidence-audit.json'
)) {
    $syncTestResolved = Assert-SyncNestedReceiptPath $syncTestRelative
    Assert-SyncTest ($syncTestResolved -ceq [IO.Path]::GetFullPath((Join-Path $syncAcceptance $syncTestRelative))) 'reviewable nested receipt syntax is supported without enumeration'
}
foreach ($syncTestRelative in @(
    '../outside.json'
    'retest-history/../outside.json'
    'retest-history/nested/native-third-ui.json'
    'retest-history/native-third-ui.json:stream'
    'retest-history/native-third-ui.json/child'
    'retest-history\native-third-ui.json'
    '/retest-history/native-third-ui.json'
    'G:/retest-history/native-third-ui.json'
    'retest-history/auth.json'
    'retest-history/providers.json'
    'retest-history/protocol-bridge.json'
    'retest-history/*.json'
    'native-gateway/../native-gateway-results.json'
    'native-gateway/not-a-uuid/native-gateway-results.json'
    'native-gateway/0123456789abcdef0123456789abcdef/credentials.json'
    'native-gateway/0123456789abcdef0123456789abcdef/child/native-gateway-results.json'
    'native-gateway/0123456789abcdef0123456789abcdef/native-gateway-results.json:stream'
    'history-preservation-/retained-evidence-audit.json'
    'history-preservation-not-a-uuid/retained-evidence-audit.json'
    'history-preservation-0123456789abcdef0123456789abcde/retained-evidence-audit.json'
    'history-preservation-0123456789abcdef0123456789abcdef0/retained-evidence-audit.json'
    'history-preservation-0123456789abcdef0123456789abcdeg/retained-evidence-audit.json'
    'history-preservation-0123456789ABCDEF0123456789ABCDEF/retained-evidence-audit.json'
    'history-preservation-01234567-89ab-cdef-0123-456789abcdef/retained-evidence-audit.json'
    'history-preservation-0123456789abcdef0123456789abcdef/credentials.json'
    'history-preservation-0123456789abcdef0123456789abcdef/providers.json'
    'history-preservation-0123456789abcdef0123456789abcdef/auth.json'
    'history-preservation-0123456789abcdef0123456789abcdef/arbitrary.json'
    'history-preservation-0123456789abcdef0123456789abcdef/retained-evidence-audit.png'
    'history-preservation-0123456789abcdef0123456789abcdef/*.json'
    'history-preservation-0123456789abcdef0123456789abcdef/child/retained-evidence-audit.json'
    'history-preservation-0123456789abcdef0123456789abcdef/retained-evidence-audit.json/child'
    'history-preservation-0123456789abcdef0123456789abcdef/retained-evidence-audit.json:stream'
    'history-preservation-0123456789abcdef0123456789abcdef/../retained-evidence-audit.json'
    'history-preservation-../retained-evidence-audit.json'
    '../history-preservation-0123456789abcdef0123456789abcdef/retained-evidence-audit.json'
    'history-preservation-0123456789abcdef0123456789abcdef\retained-evidence-audit.json'
    '/history-preservation-0123456789abcdef0123456789abcdef/retained-evidence-audit.json'
    'G:/history-preservation-0123456789abcdef0123456789abcdef/retained-evidence-audit.json'
    'C:/history-preservation-0123456789abcdef0123456789abcdef/retained-evidence-audit.json'
    "history-preservation-0123456789abcdef0123456789abcdef/retained-evidence-audit.json`n"
    "retest-history/native-third-ui.json`n"
)) {
    Assert-SyncTestRejected { Assert-SyncNestedReceiptPath $syncTestRelative } 'unsafe or non-receipt relative path is rejected'
}
Assert-SyncTestRejected { Assert-SyncChild $syncAcceptance (Join-Path $syncTestWorkspace 'outside.json') } 'ordinary child scope rejects escape'

# Attribute and fingerprint doubles exercise rejection branches only. They do
# not create links/files or produce acceptance evidence for OS/runtime behavior.
$syncTestRedirected = Join-Path $syncAcceptance 'retest-history'
$syncTestLeaf = Join-Path $syncTestRedirected 'native-third-ui.json'
function Get-SyncAttributes([string]$Location, [bool]$AllowMissing = $false) {
    if ($Location -ceq $syncTestRedirected) { return [IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint }
    if ($Location -ceq $syncTestLeaf) { return [IO.FileAttributes]::Normal }
    return [IO.FileAttributes]::Directory
}
Assert-SyncTestRejected { Assert-SyncAncestors $syncTestLeaf $false $true } 'redirected selected receipt ancestor is rejected' 'Synchronization refuses a redirected path or ancestor.'
$syncTestRedirected = Join-Path $syncAcceptance 'history-preservation-2044c9555f3b402dad90856a14c73534'
$syncTestLeaf = Join-Path $syncTestRedirected 'retained-evidence-audit.json'
Assert-SyncTestRejected { Assert-SyncAncestors $syncTestLeaf $false $true } 'redirected selected history audit ancestor is rejected' 'Synchronization refuses a redirected path or ancestor.'
. (Import-SyncTestFunction 'Get-SyncAttributes')

$syncSourceTrees = @()
$syncUiTree = [pscustomobject]@{ Root = $syncTestWorkspace; Files = [Collections.Generic.List[string]]::new() }
$syncReleaseReceipts = @()
function Read-SyncReleaseReceipts { return @() }
$syncNestedReceipts = @([pscustomobject]@{
    Relative = $syncTestCurrentReceipts[0]
    Source = Join-Path $syncAcceptance $syncTestCurrentReceipts[0]
    Hash = 'before'
})
function Read-SyncTree([string]$Root) { return [pscustomobject]@{ Root = $Root; Files = [Collections.Generic.List[string]]::new() } }
function Get-SyncFingerprint([string]$Location, [bool]$CheckPrivate = $false) { return 'after' }
Assert-SyncTestRejected { Assert-SyncSourceSnapshot } 'changed selected receipt fingerprint is rejected before synchronization' 'A selected nested receipt changed after inspection.'

[ordered]@{
    passed = $true
    testsPassed = $syncTestPassed
    synchronizationBodyExecuted = $false
    filesystemMutationPerformed = $false
    scope = 'Exact reviewed JSON whitelist, history audit syntax, unsafe-path refusal, redirected-ancestor, and selected-receipt snapshot regressions.'
} | ConvertTo-Json
