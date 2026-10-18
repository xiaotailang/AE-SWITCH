[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$e2eWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
. (Join-Path $e2eWorkspace 'scripts/workspace-env.ps1')
$e2eIdentifier = [Guid]::NewGuid().ToString('N')
$e2eSandbox = Join-Path $e2eWorkspace ('.cache/native-driver-fixture-' + $e2eIdentifier)
$marker = Join-Path $e2eSandbox '.owner.json'
$receipt = Join-Path $e2eWorkspace ('artifacts/acceptance/native-driver-fixture-' + $e2eIdentifier + '.json')
$encoding = [Text.UTF8Encoding]::new($false)
$checks = [Collections.Generic.List[string]]::new()
$passed = $false
$cleanup = $false
$failure = $null
function Check([bool]$Condition, [string]$Label) {
    if (-not $Condition) { throw "Fixture regression failed: $Label" }
    $checks.Add($Label)
}
# Import only reviewed function definitions; never invoke the GUI driver.
$source = Join-Path $e2eWorkspace 'scripts/verify-portable-e2e.ps1'
$tokens = $null; $parseErrors = $null
$tree = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$parseErrors)
Check ($parseErrors.Count -eq 0) 'driver PowerShell syntax'
foreach ($name in @('Assert-E2eLocalPath', 'Get-E2ePortableInstallationRoot', 'Test-E2eDshEmptyLaunchReceipt', 'Initialize-E2eInstalledClientFixtures', 'Assert-E2eNativeOrdinaryFile', 'Get-E2eNativeProcessScope')) {
    $definition = @($tree.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name }, $true))
    Check ($definition.Count -eq 1) "exact imported helper $name"
    Invoke-Expression $definition[0].Extent.Text
}
# Scope checks below involve metadata only, no process start/stop or OS argv API.
function Assert-E2eNativeOwner {
    $value = [IO.File]::ReadAllText($marker) | ConvertFrom-Json
    if ($value.id -cne $e2eIdentifier -or $value.workspace -ine $e2eWorkspace) { throw 'Fixture owner mismatch.' }
}
$null = Assert-E2eLocalPath $e2eSandbox
New-Item -ItemType Directory -Path $e2eSandbox -ErrorAction Stop | Out-Null
[IO.File]::WriteAllText($marker, (@{ id = $e2eIdentifier; workspace = $e2eWorkspace } | ConvertTo-Json), $encoding)
try {
    $e2eInstalledClientFixtures = Initialize-E2eInstalledClientFixtures
    $e2eSharedRuntimeFiles = $e2eInstalledClientFixtures.sharedRuntimeFiles
    $payload = [IO.File]::ReadAllText($e2eInstalledClientFixtures.payloadFile) | ConvertFrom-Json -AsHashtable
    $context = [IO.File]::ReadAllText($e2eInstalledClientFixtures.contextFile) | ConvertFrom-Json -AsHashtable
    $agents = @('claude_code','codex','hermes','oh_my_pi','opencode','zcode','workbuddy','deepseek_harness')
    Check ((($payload.profiles.Keys | Sort-Object) -join ',') -ceq (($agents | Sort-Object) -join ',')) 'exact eight existing native profiles'
    Check ((($payload.discoveredProfiles.Keys | Sort-Object) -join ',') -ceq (($agents | Sort-Object) -join ',')) 'exact eight metadata discovery profiles'
    Check (@(Get-ChildItem -LiteralPath (Join-Path $e2eSandbox 'installed-clients/bin') -File).Count -eq 8) 'one discovery entry per official client'
    foreach ($id in $agents) {
        $profile = $payload.profiles[$id]
        $discovered = $payload.discoveredProfiles[$id]
        foreach ($name in @('directory','homeDirectory','executablePath','workspaceDirectory','xdgConfigDirectory','xdgDataDirectory','xdgStateDirectory','xdgCacheDirectory')) {
            $location = $profile[$name]
            Check ($location.StartsWith($e2eSandbox + '\', [StringComparison]::OrdinalIgnoreCase)) "$id $name is inside owned G sandbox"
            $null = Assert-E2eLocalPath $location
            Check ($discovered[$name] -ceq $location) "$id discovered $name equals native target"
        }
        Check (@($profile.Values | Where-Object { $null -eq $_ }).Count -eq 0) "$id omitted null optional fields match Rust serialization"
        $shim = $profile.executablePath
        $bytes = [IO.File]::ReadAllBytes($shim)
        Check ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) "$id shim UTF8 BOM supports Windows PowerShell paths"
        $shimTokens = $null; $shimErrors = $null
        $null = [Management.Automation.Language.Parser]::ParseFile($shim, [ref]$shimTokens, [ref]$shimErrors)
        Check ($shimErrors.Count -eq 0) "$id shim parses without execution"
        $text = [IO.File]::ReadAllText($shim)
        Check ($text.Contains('@args') -and $text -notmatch '(?i)env:(?:.*API_KEY|.*AUTH_TOKEN|.*BASE_URL|.*MODEL|AE_GATEWAY_TOKEN|AE_SWITCH_API_KEY)\s*=') "$id entry dispatches original arguments without injecting credentials or route"
        Check (-not (Test-Path -LiteralPath (Join-Path $e2eSandbox ('data/agents/' + $id)))) "$id no AE private native profile"
        Check (-not $profile.directory.StartsWith($payload.portableRoot + '\', [StringComparison]::OrdinalIgnoreCase)) "$id existing native profile is outside AE portable root"
        Check (-not $profile.homeDirectory.StartsWith($payload.portableRoot + '\', [StringComparison]::OrdinalIgnoreCase)) "$id original HOME is outside AE portable root"
    }
    Check (-not $payload.discoveredProfiles.zcode.ContainsKey('stateFile')) 'ZCode metadata discovery does not claim resolved native state'
    Check ($payload.profiles.zcode.stateFile -ceq (Join-Path $e2eSandbox 'installed-clients/home/.zcode/native-storage/v2/agents-state.json')) 'ZCode configuration target uses actual native storage state'
    $zcodeConfig = [IO.File]::ReadAllText((Join-Path $e2eSandbox 'installed-clients/home/.zcode/cli/config.json')) | ConvertFrom-Json
    Check ((Join-Path $zcodeConfig.storage.dir 'v2/agents-state.json') -ceq $payload.profiles.zcode.stateFile) 'ZCode original storage.dir resolves to expected stateFile'
    Check ($payload.profiles.deepseek_harness.profileName -ceq 'user-existing') 'DSH uses an explicit existing native profile'
    $dshPackage = [IO.File]::ReadAllText((Join-Path $payload.profiles.deepseek_harness.directory 'package.json')) | ConvertFrom-Json
    Check (($dshPackage.dsh.profile.bundles -join ',') -ceq '@deepseek-ai/dsh-base,@deepseek-ai/dsh-headless') 'DSH fixture preserves official base-backed composition'
    Check ($payload.profiles.workbuddy.executablePath.EndsWith('\WorkBuddy.ps1', [StringComparison]::Ordinal)) 'WorkBuddy entry matches unique discovery capitalization'
    Check ($context.homeDirectory -ceq $payload.profiles.codex.homeDirectory) 'QA discovery uses original native HOME'
    Check ($context.workspaceDirectory -ceq $payload.profiles.codex.workspaceDirectory) 'QA discovery uses original native workspace'
    foreach ($directory in $context.environment.PATH.Split(';')) {
        $null = Assert-E2eLocalPath $directory
        Check ($directory -notmatch '^[Cc]:') 'discovery PATH entry stays on G'
    }
    Check (-not $context.environment.ContainsKey('ProgramFiles') -and -not $context.environment.ContainsKey('ProgramFiles(x86)')) 'QA discovery has no system installation directory'
    foreach ($file in $payload.preservedFiles) {
        $null = Assert-E2eLocalPath $file.path
        Check ((Get-FileHash -LiteralPath $file.path -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $file.sha256) 'original history preference and composition hash preserved'
    }
    foreach ($file in @($e2eSharedRuntimeFiles.Keys)) {
        $scope = Get-E2eNativeProcessScope $file '' @{ kind = 'official-powershell-launcher' }
        Check ($scope.kind -ceq 'shared-official-runtime') 'exact shared official runtime accepted by metadata scope'
        Check ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $e2eSharedRuntimeFiles[$file]) 'shared runtime bytes unchanged'
    }
    $selectedRuntime = @($e2eSharedRuntimeFiles.Keys)[0]
    $realHash = $e2eSharedRuntimeFiles[$selectedRuntime]
    $e2eSharedRuntimeFiles[$selectedRuntime] = '0' * 64
    Check ($null -eq (Get-E2eNativeProcessScope $selectedRuntime '' @{ kind = 'official-powershell-launcher' })) 'shared runtime with changed expected identity is rejected'
    $e2eSharedRuntimeFiles[$selectedRuntime] = $realHash
    Check ($null -eq (Get-E2eNativeProcessScope (Join-Path $e2eWorkspace '.tools/unlisted-user-app.exe') '' @{})) 'unlisted outside client executable rejected'
    Check (-not (Test-Path -LiteralPath (Join-Path $e2eSandbox 'tools/agents'))) 'fixture does not add agents to formal package tools'
    $dshReceipt = @{ id = 'deepseek_harness'; uiLaunchSucceeded = $false; launchUnsupported = $true; taskRequired = $true; processNotStarted = $true }
    $dshEntry = $payload.profiles.deepseek_harness.executablePath
    Check (Test-E2eDshEmptyLaunchReceipt @($dshReceipt) @{} 123 $dshEntry) 'DSH requires explicit task-required empty-launch rejection receipt'
    Check (-not (Test-E2eDshEmptyLaunchReceipt @() @{} 123 $dshEntry)) 'missing DSH empty-launch rejection fails acceptance'
    Check (-not (Test-E2eDshEmptyLaunchReceipt @($dshReceipt,$dshReceipt) @{} 123 $dshEntry)) 'duplicated DSH rejection receipts fail acceptance'
    foreach ($flag in @('launchUnsupported','taskRequired','processNotStarted')) {
        $bad = $dshReceipt.Clone(); $bad.Remove($flag)
        Check (-not (Test-E2eDshEmptyLaunchReceipt @($bad) @{} 123 $dshEntry)) "DSH rejection requires $flag evidence"
    }
    $bad = $dshReceipt.Clone(); $bad.uiLaunchSucceeded = $true
    Check (-not (Test-E2eDshEmptyLaunchReceipt @($bad) @{} 123 $dshEntry)) 'DSH empty launch cannot masquerade as successful interaction'
    $process = @{ kind = 'official-powershell-launcher'; nativeLaunch = $true; launcher = $dshEntry; parentId = 123 }
    Check (-not (Test-E2eDshEmptyLaunchReceipt @($dshReceipt) @{ child = $process } 123 $dshEntry)) 'DSH observed empty native launch rejects no-process receipt'
    $process.nativeLaunch = $false
    Check (Test-E2eDshEmptyLaunchReceipt @($dshReceipt) @{ child = $process } 123 $dshEntry) 'DSH real task probe remains required and is allowed'
    $passed = $true
} catch {
    $failure = $_.Exception.Message
} finally {
    $target = Assert-E2eLocalPath $e2eSandbox
    if ($target -ine (Join-Path $e2eWorkspace ('.cache/native-driver-fixture-' + $e2eIdentifier))) { throw 'Fixture cleanup target mismatch.' }
    Assert-E2eNativeOwner
    foreach ($entry in Get-ChildItem -LiteralPath $target -Recurse -Force) {
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Fixture cleanup refuses linked entries.' }
    }
    Remove-Item -LiteralPath $target -Recurse -Force
    $cleanup = -not (Test-Path -LiteralPath $target)
    New-Item -ItemType Directory -Path (Split-Path -Parent $receipt) -Force | Out-Null
    [IO.File]::WriteAllText($receipt, (@{ passed = $passed; checks = @($checks.ToArray()); count = $checks.Count; sandboxId = $e2eIdentifier; cleanupCompleted = $cleanup; failure = $failure; officialToolLaunchAttempted = $false; nativeUiAttempted = $false; scope = 'Owned existing-client fixture generation and static process identity boundaries only' } | ConvertTo-Json -Depth 10), $encoding)
}
Write-Host "Native installed-client fixture regression: $($checks.Count) checks; passed=$passed; cleanup=$cleanup"
Write-Host $receipt
if (-not $passed -or -not $cleanup) { throw $failure }
