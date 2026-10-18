[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../scripts/workspace-env.ps1')
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$sourcePath = Join-Path $workspace 'tests/acceptance/native-desktop-runtime-owned-static.ps1'
$existingReceiptPath = Join-Path $workspace 'artifacts/acceptance/desktop-runtime-owned-static.json'
$existingReceiptHash = (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $existingReceiptPath -Algorithm SHA256).Hash.ToLowerInvariant()
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($sourcePath,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Future fixture lifecycle source does not parse.' }
function Get-LifecycleSource([string]$Name) { return $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $Name },$true).Extent.Text }
$rootText = Get-LifecycleSource 'New-StaticFixtureRoot'
$junctionText = Get-LifecycleSource 'New-StaticFixtureJunction'
$cleanupText = Get-LifecycleSource 'Invoke-StaticFixtureCleanup'
if ($rootText.IndexOf('::CreateFreshDirectory($root)') -lt 0 -or $rootText.IndexOf('[IO.FileMode]::CreateNew') -lt 0 -or $rootText.IndexOf('[IO.FileMode]::CreateNew') -gt $rootText.IndexOf('$fixtureOwnedRoots.Add') -or $rootText.IndexOf('$fixtureOwnedRoots.Add') -gt $rootText.IndexOf('Save-StaticFixtureManifest')) { throw 'Fresh UUID ownership must be recorded before fixture data is created.' }
if ($junctionText.IndexOf('$fixtureOwnedLinks.Add') -gt $junctionText.IndexOf('New-Item -ItemType Junction') -or $junctionText.IndexOf('$record.created = $true') -lt $junctionText.IndexOf('New-Item -ItemType Junction')) { throw 'Exact link creation records must precede creation and completion.' }
if ($cleanupText -notmatch 'CimCmdlets\\Get-CimInstance' -or $cleanupText -notmatch 'AEStaticFixtureDeleteProbe' -or $cleanupText -notmatch '\$fixtureManifestHash' -or $cleanupText -notmatch '\+\+\$visited -gt 40000' -or $cleanupText -match 'Kill\(|Stop-Process|Remove-Item|\$true\)' -or $cleanupText.IndexOf('[IO.File]::Delete($plan.owner.marker)') -lt $cleanupText.IndexOf('for ($index=')) { throw 'Future cleanup lost its manifest, live-reference, sharing, bounds, nonrecursive or marker-last safeguards.' }
$deletes = [regex]::Matches($cleanupText,'\[IO.Directory\]::Delete\([^\r\n;]+\)')
if ($deletes.Count -ne 3 -or @($deletes | Where-Object { $_.Value -notmatch ',\$false\)$' }).Count) { throw 'Fixture directory and link deletion must be nonrecursive.' }
$mockLiteral = $ast.Find({ param($n) $n -is [Management.Automation.Language.StringConstantExpressionAst] -and $n.Value.Contains('public static class AEStaticFixtureDeleteProbe') },$true).Value
$driverPath = Join-Path $workspace 'scripts/verify-owned-desktop-runtime.ps1'
$driverAst = [Management.Automation.Language.Parser]::ParseFile($driverPath,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Runtime driver native source does not parse.' }
$driverNative = $driverAst.Find({ param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Add-Type' },$true).CommandElements[2].Value.Replace('public static class AEReleaseRuntime {','public static class AEReleaseRuntimeStaticNativeValidated {')
$compiledMocks = $mockLiteral.Replace('public static class AEReleaseRuntime {','public static class AEReleaseRuntimeLifecycleMockValidated {').Replace('AEReleaseRuntimeStaticNative','AEReleaseRuntimeStaticNativeValidated').Replace('AEStaticFixtureDeleteProbe','AEStaticFixtureDeleteProbeValidated')
Add-Type -TypeDefinition ($driverNative+"`n"+$compiledMocks)
$ownerText = (Get-LifecycleSource 'Assert-StaticFixtureOwner').Replace('[IO.File]::ReadAllText($owner.marker,[Text.Encoding]::UTF8)','(Get-LifecycleMockMarker $owner.marker)')
$linkText = (Get-LifecycleSource 'Assert-StaticFixtureLink').Replace('Microsoft.PowerShell.Management\Get-Item -LiteralPath $path -Force -ErrorAction Stop','Get-LifecycleMockItem $path').Replace('[IO.File]::GetAttributes($record.target)','(Get-LifecycleMockAttributes $record.target)')
Invoke-Expression $ownerText; Invoke-Expression $linkText
$fixtureRunId = 'f'*32; $fixturePurpose = 'AE Switch owned static desktop-runtime fixture'; $fixtureHarnessHash = 'a'*64
$results = [Collections.Generic.List[object]]::new()
function Reset-LifecycleMock {
    $script:owner = [pscustomobject]@{ id = 'e'*32; root = [IO.Path]::GetFullPath((Join-Path $workspace ('.cache/desktop-runtime-lock-static/'+('e'*32)))); marker = ''; markerSha256 = 'b'*64 }
    $owner.marker = Join-Path $owner.root '.ae-desktop-runtime-static-owner.json'
    $script:mockMarker = [ordered]@{ id = $owner.id; runId = $fixtureRunId; purpose = $fixturePurpose; workspace = $workspace; harnessSha256 = $fixtureHarnessHash }
    $script:mockHash = 'b'*64; $script:blockedPaths = @()
    $script:link = [pscustomobject]@{ ownerId = $owner.id; path = Join-Path $owner.root 'data/created-link'; target = Join-Path $owner.root 'data/ordinary-target'; created = $true; removed = $false }
    $script:fixtureOwnedLinks = [Collections.Generic.List[object]]::new(); $fixtureOwnedLinks.Add($link)
    $script:mockMetadata = [pscustomobject]@{ PSIsContainer = $true; Attributes = ([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint); LinkType = 'Junction'; Target = @($link.target) }
    $script:mockAttributes = [IO.FileAttributes]::Directory
}
function Assert-StaticRealRuntimePath([string]$Path) { if ($Path -in $blockedPaths) { throw 'Synthetic reparse ancestor rejected.' }; return $Path }
function Get-FileHash { param($LiteralPath,$Algorithm) return [pscustomobject]@{ Hash = $mockHash } }
function Get-LifecycleMockMarker($Path) { return $mockMarker | ConvertTo-Json -Compress }
function Get-LifecycleMockItem($Path) { return $mockMetadata }
function Get-LifecycleMockAttributes($Path) { return $mockAttributes }
function Invoke-LifecycleCase([string]$Name,[scriptblock]$Body,[bool]$Reject) {
    Reset-LifecycleMock; $failed = $false
    try { & $Body } catch { $failed = $true }
    if ($failed -ne $Reject) { throw "Lifecycle guard outcome changed: $Name." }
    $results.Add([ordered]@{ name = $Name; passed = $true })
}
Invoke-LifecycleCase 'matching-owned-marker-and-recorded-link-accept' { Assert-StaticFixtureOwner $owner; $null = Assert-StaticFixtureLink $owner $link.path } $false
foreach ($field in @('id','runId','purpose','workspace','harnessSha256')) {
    Invoke-LifecycleCase "marker-$field-mismatch-rejects" { $mockMarker[$field]='synthetic-mismatch'; Assert-StaticFixtureOwner $owner } $true
}
Invoke-LifecycleCase 'marker-byte-hash-change-rejects' { $script:mockHash='c'*64; Assert-StaticFixtureOwner $owner } $true
Invoke-LifecycleCase 'root-outside-exact-uuid-rejects' { $owner.root=$owner.root+'-sibling'; Assert-StaticFixtureOwner $owner } $true
Invoke-LifecycleCase 'unknown-link-without-creation-record-rejects' { $fixtureOwnedLinks.Clear(); $null=Assert-StaticFixtureLink $owner $link.path } $true
Invoke-LifecycleCase 'pending-unproved-link-creation-rejects' { $link.created=$false; $null=Assert-StaticFixtureLink $owner $link.path } $true
Invoke-LifecycleCase 'different-owner-link-record-rejects' { $link.ownerId='d'*32; $null=Assert-StaticFixtureLink $owner $link.path } $true
Invoke-LifecycleCase 'symbolic-link-type-rejects' { $mockMetadata.LinkType='SymbolicLink'; $null=Assert-StaticFixtureLink $owner $link.path } $true
Invoke-LifecycleCase 'link-target-change-rejects' { $mockMetadata.Target=@($link.target+'-sibling'); $null=Assert-StaticFixtureLink $owner $link.path } $true
Invoke-LifecycleCase 'multiple-link-targets-reject' { $mockMetadata.Target=@($link.target,$link.target); $null=Assert-StaticFixtureLink $owner $link.path } $true
Invoke-LifecycleCase 'link-target-outside-same-uuid-rejects' { $link.target='G:\SyntheticOutside'; $mockMetadata.Target=@($link.target); $null=Assert-StaticFixtureLink $owner $link.path } $true
Invoke-LifecycleCase 'link-ancestor-reparse-rejects' { $script:blockedPaths=@([IO.Path]::GetDirectoryName($link.path)); $null=Assert-StaticFixtureLink $owner $link.path } $true
Invoke-LifecycleCase 'link-target-reparse-rejects' { $script:blockedPaths=@($link.target); $null=Assert-StaticFixtureLink $owner $link.path } $true
Invoke-LifecycleCase 'link-target-ordinary-file-rejects' { $script:mockAttributes=[IO.FileAttributes]::Normal; $null=Assert-StaticFixtureLink $owner $link.path } $true
if ((Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $existingReceiptPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $existingReceiptHash) { throw 'The existing 70-case receipt changed.' }
$receipt = [ordered]@{ passed = $true; recordedAt = [DateTime]::UtcNow.ToString('o'); sourceSha256 = (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant(); cases = $results.ToArray(); caseCount = $results.Count; fullNativeAndMocksCompiled = $true; fixtureRootsCreated = 0; processesStopped = 0; directoriesDeleted = 0; existing70CaseReceiptUnchanged = $true; scope = 'AST order/safety invariants, full native/mock C# compilation, and isolated ownership/link mocks only. The full fixture suite was not rerun.' }
$receiptPath = Join-Path $workspace 'artifacts/acceptance/desktop-runtime-static-fixture-lifecycle-static.json'
[IO.File]::WriteAllText($receiptPath,($receipt | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
[ordered]@{ passed = $true; caseCount = $results.Count; sourceSha256 = $receipt.sourceSha256; fixtureRootsCreated = 0; receipt = $receiptPath } | ConvertTo-Json -Compress
