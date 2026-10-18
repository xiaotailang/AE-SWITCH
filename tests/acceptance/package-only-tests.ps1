#requires -Version 7.0
[CmdletBinding()]
param([switch]$ExpectLegacyFailure)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$packageTestWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
. (Join-Path $packageTestWorkspace 'scripts/workspace-env.ps1')
$packageTestId = [Guid]::NewGuid().ToString('N')
$packageTestRoot = Join-Path $packageTestWorkspace ".cache/package-only-$packageTestId"
if ($packageTestRoot -notmatch '^G:\\' -or (Test-Path -LiteralPath $packageTestRoot)) { throw 'Expected a new G-drive packaging fixture.' }
$packageTestUtf8 = [Text.UTF8Encoding]::new($false)
$packageTestPassed = 0
$packageTestLegacyRejected = $false
$packageTestReceipt = [ordered]@{
    scope = 'Packaging mechanics and inventory only; no application, WebView or official client was launched.'
    ownerId = $packageTestId; root = $packageTestRoot; passed = $false
    syntheticWebViewFixture = $true; binariesArePreexistingBuilds = $true
    productionReleaseAcceptance = $false; officialAgentsExecuted = $false
    cleanupCompleted = $false; checks = 0; packageBytes = 0
}

function Write-PackageTestFile([string]$Relative, [string]$Content) {
    $packageTestLocation = Join-Path $packageTestRoot $Relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $packageTestLocation) -Force | Out-Null
    [IO.File]::WriteAllText($packageTestLocation, $Content, $packageTestUtf8)
}

function Assert-PackageTest([bool]$Condition, [string]$Label) {
    if (-not $Condition) { throw "Packaging regression failed: $Label" }
    $script:packageTestPassed++
}

function Invoke-PackageTest([string]$Output) {
    & (Join-Path $packageTestRoot 'scripts/package-portable.ps1') `
        -ExecutablePath (Join-Path $packageTestRoot 'input/ae-switch.exe') `
        -CliExecutablePath (Join-Path $packageTestRoot 'input/ae-switch-cli.exe') `
        -OutputDirectory $Output
}

# Execute the production guard against virtual C paths without touching C.
$packageGuardTokens = $null; $packageGuardErrors = $null
$packageGuardAst = [Management.Automation.Language.Parser]::ParseFile((Join-Path $packageTestWorkspace 'scripts/package-portable.ps1'), [ref]$packageGuardTokens, [ref]$packageGuardErrors)
Assert-PackageTest ($packageGuardErrors.Count -eq 0) 'production packager parses'
$packageGuardDefinition = $packageGuardAst.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Assert-PackagePath' }, $false)
Assert-PackageTest ($null -ne $packageGuardDefinition) 'production output guard is available'
. ([scriptblock]::Create($packageGuardDefinition.Extent.Text))
& {
    $packageWorkspace = 'C:\AE-Switch-virtual-workspace'
    function Test-Path { param([string]$LiteralPath) return $false }
    Assert-PackageTest ((Assert-PackagePath 'C:\AE-Switch-virtual-workspace\artifacts\package') -ceq 'C:\AE-Switch-virtual-workspace\artifacts\package') 'C workspace output accepted by production guard without C filesystem access'
    foreach ($outside in @('C:\AE-Switch-virtual-workspace-sibling\package', 'C:\AE-Switch-virtual-workspace\..\escape')) {
        $rejected = $false
        try { $null = Assert-PackagePath $outside } catch { $rejected = $_.Exception.Message -match 'within the current workspace' }
        Assert-PackageTest $rejected 'virtual C workspace boundary escape is rejected'
    }
}

New-Item -ItemType Directory -Path $packageTestRoot | Out-Null
Write-PackageTestFile 'owner.json' (@{ id = $packageTestId; root = $packageTestRoot; purpose = 'package-only-regression' } | ConvertTo-Json)
try {
    foreach ($packageTestName in @('package-portable.ps1', 'workspace-env.ps1')) {
        New-Item -ItemType Directory -Path (Join-Path $packageTestRoot 'scripts') -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $packageTestWorkspace "scripts/$packageTestName") -Destination (Join-Path $packageTestRoot "scripts/$packageTestName")
    }
    New-Item -ItemType Directory -Path (Join-Path $packageTestRoot 'input') -Force | Out-Null
    foreach ($packageTestName in @('ae-switch.exe', 'ae-switch-cli.exe', 'WebView2Loader.dll')) {
        Copy-Item -LiteralPath (Join-Path $packageTestWorkspace ".cache/cargo-target/release/$packageTestName") -Destination (Join-Path $packageTestRoot "input/$packageTestName")
    }
    Write-PackageTestFile 'input/unrelated-client.dll' 'MZ-this unrelated input must never enter the package'
    Write-PackageTestFile 'app/dist/index.html' '<!doctype html><title>Packaging fixture only</title>'
    Write-PackageTestFile 'app/LICENSE' 'AE test license fixture'
    Write-PackageTestFile 'app/NOTICE' 'AE test notice fixture'
    Write-PackageTestFile 'app/third-party/dependency-licenses.txt' 'Application license inventory fixture'
    Write-PackageTestFile 'app/third-party/codex/LICENSE' 'Embedded Codex instructions license fixture'
    Write-PackageTestFile 'app/src/retained-source.rs' '// retain source'
    Write-PackageTestFile 'docs/fixture.md' 'Packaging fixture'
    Write-PackageTestFile 'README.md' 'Packaging fixture'
    Write-PackageTestFile 'tests/retained-fixture.txt' 'Public test source fixture'
    foreach ($packageTestRelative in @('app/.env', 'app/.env.local', 'app/端点测试用.txt', 'app/.cache/private.txt', 'app/node_modules/private.txt', 'app/data/private.txt', 'app/target/private.txt', 'scripts/fixture.log')) {
        Write-PackageTestFile $packageTestRelative 'private exclusion sentinel'
    }
    # A deliberately small runtime-shaped fixture tests the copier, not WebView
    # startup. Production runtime acceptance is owned by the independent run.
    foreach ($packageTestRelative in @('msedgewebview2.exe', 'msedge.dll', 'icudtl.dat', 'resources.pak', 'v8_context_snapshot.bin')) {
        Write-PackageTestFile ".tools/webview2/$packageTestRelative" 'MZ-packaging-only fixture'
    }
    Write-PackageTestFile '.tools/webview2/WidevineCdm/LICENSE' 'WebView fixture license'
    Write-PackageTestFile '.tools/webview2/show_third_party_software_licenses.bat' 'echo fixture'
    $packageTestOutput = Join-Path $packageTestRoot 'output/AE-Switch'
    Write-PackageTestFile 'output/AE-Switch/data/history.bin' 'existing-user-history-must-be-preserved'
    $packageTestHistory = Join-Path $packageTestOutput 'data/history.bin'
    $packageTestOriginalHash = (Get-FileHash -LiteralPath $packageTestHistory -Algorithm SHA256).Hash
    if ($ExpectLegacyFailure) {
        try { $null = Invoke-PackageTest $packageTestOutput } catch {
            $packageTestLegacyRejected = $_.Exception.Message -match 'Missing official agent tools|Node.js runtime|node.exe'
        }
        Assert-PackageTest $packageTestLegacyRejected 'legacy packager requires unrelated client/runtime installations'
        $packageTestReceipt.legacyExpectedFailureObserved = $true
    } else {
        $packageTestResult = @(Invoke-PackageTest $packageTestOutput)
        $packageTestDestination = [string]$packageTestResult[-1]
        Assert-PackageTest ($packageTestDestination -ne $packageTestOutput -and $packageTestDestination.StartsWith($packageTestOutput + '-', [StringComparison]::Ordinal)) 'existing package produces a fresh sibling'
        Assert-PackageTest (((Get-FileHash -LiteralPath $packageTestHistory -Algorithm SHA256).Hash) -eq $packageTestOriginalHash) 'existing package history remains byte-identical'
        $packageTestManifest = Get-Content -LiteralPath (Join-Path $packageTestDestination 'package-manifest.json') -Raw | ConvertFrom-Json
        Assert-PackageTest ($packageTestManifest.installedApplicationRequired -eq $true) 'users supply existing client installations'
        Assert-PackageTest ($packageTestManifest.agentProgramsBundled -eq $false) 'manifest excludes bundled clients'
        Assert-PackageTest ($packageTestManifest.realInferenceVerified -eq $false -and $packageTestManifest.releaseAcceptanceVerified -eq $false) 'packaging does not certify inference or release acceptance'
        Assert-PackageTest ($packageTestManifest.portableRuntimesComplete -eq $true) 'UI runtime-shaped fixture copied completely'
        foreach ($packageTestRelative in @('AE-Switch.exe', 'AE-Switch-core.exe', 'WebView2Loader.dll', 'ui/index.html', 'LICENSE', 'NOTICE', 'licenses/dependency-licenses.txt', 'licenses/codex-LICENSE', 'source/ae-switch/app/src/retained-source.rs', 'tools/webview2/msedgewebview2.exe', 'tools/webview2/msedge.dll', 'tools/webview2/icudtl.dat', 'tools/webview2/resources.pak', 'tools/webview2/v8_context_snapshot.bin', 'tools/webview2/WidevineCdm/LICENSE', 'Start-AE-Switch.cmd')) {
            Assert-PackageTest (Test-Path -LiteralPath (Join-Path $packageTestDestination $packageTestRelative) -PathType Leaf) "required AE file $packageTestRelative"
        }
        foreach ($packageTestRelative in @('tools/agents', 'tools/node', 'tools/python', 'tools/pwsh', 'tools/git', 'unrelated-client.dll', 'source/ae-switch/app/.env', 'source/ae-switch/app/.env.local', 'source/ae-switch/app/端点测试用.txt', 'source/ae-switch/app/.cache', 'source/ae-switch/app/node_modules', 'source/ae-switch/app/data', 'source/ae-switch/app/target', 'source/ae-switch/scripts/fixture.log')) {
            Assert-PackageTest (-not (Test-Path -LiteralPath (Join-Path $packageTestDestination $packageTestRelative))) "excluded dependency or private file $packageTestRelative"
        }
        # Even an installed vendor tree must never be selected for packaging.
        foreach ($packageTestRelative in @('.tools/agents/codex/vendor-sentinel', '.tools/workbuddy/WorkBuddy.exe', '.tools/node/node.exe', '.tools/python/python.exe', '.tools/pwsh/pwsh.exe', '.tools/git/bin/git.exe')) {
            Write-PackageTestFile $packageTestRelative 'MZ-vendor exclusion sentinel'
        }
        $packageTestSecond = @(Invoke-PackageTest (Join-Path $packageTestRoot 'output/AE-Switch-second'))[-1]
        Assert-PackageTest (@(Get-ChildItem -LiteralPath (Join-Path $packageTestSecond 'tools') -Directory).Count -eq 1) 'installed vendor sentinels do not add tool directories'
        Assert-PackageTest ((Get-ChildItem -LiteralPath (Join-Path $packageTestSecond 'tools') -Directory).Name -ceq 'webview2') 'only the AE UI runtime is present'
        Assert-PackageTest (-not (Get-ChildItem -LiteralPath $packageTestSecond -Recurse -File | Where-Object { $_.Name -eq 'vendor-sentinel' })) 'vendor inventory never enters the package'
        foreach ($packageTestMissing in @('input/WebView2Loader.dll', '.tools/webview2/resources.pak')) {
            $packageTestMissingPath = Join-Path $packageTestRoot $packageTestMissing
            $packageTestMissingOutput = Join-Path $packageTestRoot 'output/missing-runtime-never-create'
            Move-Item -LiteralPath $packageTestMissingPath -Destination ($packageTestMissingPath + '.disabled')
            try {
                $packageTestMissingRejected = $false
                try { $null = Invoke-PackageTest $packageTestMissingOutput } catch { $packageTestMissingRejected = $_.Exception.Message -match 'Missing AE WebView2 loader|Missing WebView2 runtime resources.pak' }
                Assert-PackageTest $packageTestMissingRejected "missing UI runtime rejected: $packageTestMissing"
                Assert-PackageTest (-not (Test-Path -LiteralPath $packageTestMissingOutput)) 'missing runtime creates no package output'
            } finally {
                Move-Item -LiteralPath ($packageTestMissingPath + '.disabled') -Destination $packageTestMissingPath
            }
        }
        $packageTestJunctionTarget = Join-Path $packageTestRoot 'output/junction-target'
        $packageTestJunction = Join-Path $packageTestRoot 'output/junction'
        New-Item -ItemType Directory -Path $packageTestJunctionTarget | Out-Null
        New-Item -ItemType Junction -Path $packageTestJunction -Target $packageTestJunctionTarget | Out-Null
        try {
            $packageTestJunctionRejected = $false
            try { $null = Invoke-PackageTest (Join-Path $packageTestJunction 'never-create') } catch { $packageTestJunctionRejected = $_.Exception.Message -match 'junction or symbolic link' }
            Assert-PackageTest $packageTestJunctionRejected 'output junction ancestor rejected before writes'
            Assert-PackageTest (-not (Test-Path -LiteralPath (Join-Path $packageTestJunctionTarget 'never-create'))) 'junction target remains empty'
        } finally {
            # Removing the owned junction itself does not recursively remove
            # its target; the entire fixture is checked again before cleanup.
            Remove-Item -LiteralPath $packageTestJunction -Force
        }
        $packageTestOutsideRejected = $false
        try { $null = Invoke-PackageTest (Join-Path $packageTestWorkspace 'outside-package-fixture') } catch { $packageTestOutsideRejected = $_.Exception.Message -match 'within the current workspace' }
        Assert-PackageTest $packageTestOutsideRejected 'outside-fixture output rejected before writes'
        $packageTestCRejected = $false
        try { $null = Invoke-PackageTest 'C:\AE-Switch-package-fixture-never-create' } catch { $packageTestCRejected = $_.Exception.Message -match 'within the current workspace' }
        Assert-PackageTest $packageTestCRejected 'C output outside the fixture workspace rejected before writes'
        $packageTestReceipt.packageBytes = [long](Get-ChildItem -LiteralPath $packageTestDestination -Recurse -File | Measure-Object -Property Length -Sum).Sum
        $packageTestReceipt.manifest = $packageTestManifest
    }
    $packageTestReceipt.passed = $true
} catch {
    $packageTestReceipt.failure = $_.Exception.Message
    throw
} finally {
    $packageTestReceipt.checks = $packageTestPassed
    $packageTestOwner = Get-Content -LiteralPath (Join-Path $packageTestRoot 'owner.json') -Raw | ConvertFrom-Json
    $packageTestResolved = (Resolve-Path -LiteralPath $packageTestRoot).Path
    if ($packageTestOwner.id -cne $packageTestId -or $packageTestOwner.root -cne $packageTestRoot -or $packageTestResolved -cne $packageTestRoot -or -not $packageTestResolved.StartsWith($packageTestWorkspace + '\.cache\package-only-', [StringComparison]::Ordinal)) { throw 'Refusing to clean a fixture with mismatched ownership.' }
    $packageTestAncestors = $packageTestResolved
    while ($packageTestAncestors) {
        if ([IO.File]::GetAttributes($packageTestAncestors) -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing fixture cleanup through reparse ancestry.' }
        $packageTestAncestors = [IO.Path]::GetDirectoryName($packageTestAncestors)
    }
    if (Get-ChildItem -LiteralPath $packageTestRoot -Force -Recurse | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'Refusing fixture cleanup with reparse entries.' }
    Remove-Item -LiteralPath $packageTestResolved -Recurse -Force
    $packageTestReceipt.cleanupCompleted = -not (Test-Path -LiteralPath $packageTestResolved)
    $packageTestReceiptPath = Join-Path $packageTestWorkspace "artifacts/acceptance/package-only-$packageTestId.json"
    New-Item -ItemType Directory -Path (Split-Path -Parent $packageTestReceiptPath) -Force | Out-Null
    [IO.File]::WriteAllText($packageTestReceiptPath, ($packageTestReceipt | ConvertTo-Json -Depth 12), $packageTestUtf8)
    Write-Output ($packageTestReceipt | ConvertTo-Json -Depth 12)
}
