[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$e2eWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
. (Join-Path $e2eWorkspace 'scripts/workspace-env.ps1')
$e2eIdentifier = [Guid]::NewGuid().ToString('N')
$testRoot = Join-Path $e2eWorkspace ('.cache/tmp/native-installation-mapping-' + $e2eIdentifier)
$e2eSandbox = Join-Path $testRoot 'owned'
$checks = 0
$utf8 = [Text.UTF8Encoding]::new($false)
$tokens = $null; $parseErrors = $null
$tree = [Management.Automation.Language.Parser]::ParseFile((Join-Path $e2eWorkspace 'scripts/verify-portable-e2e.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Fixture wrapper syntax failed.' }
foreach ($name in @('Assert-E2eLocalPath','Get-E2ePortableInstallationRoot','New-E2eNativeLaunchWaitScript','Initialize-E2eInstalledClientFixtures')) {
    $definitions = @($tree.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true) | Where-Object Name -CEQ $name)
    if ($definitions.Count -ne 1) { throw 'Exact fixture definition required.' }
    . ([ScriptBlock]::Create($definitions[0].Extent.Text))
}
function Check([bool]$Value) { if (-not $Value) { throw 'Installation mapping regression failed.' }; $script:checks++ }
function Save-Json($Value) { [IO.File]::WriteAllText($manifestFile, ($Value | ConvertTo-Json -Depth 8), $utf8) }
function Reject($Value) {
    Save-Json $Value
    $rejected = $false
    try { $null = Initialize-E2eInstalledClientFixtures -InstallationsManifest $manifestFile } catch { $rejected = $true }
    Check $rejected
    Check (-not (Test-Path -LiteralPath $e2eSandbox))
}
$null = Assert-E2eLocalPath $testRoot
if (Test-Path -LiteralPath $testRoot) { throw 'Fresh mapping test root required.' }
$null = New-Item -ItemType Directory -Path $testRoot
$marker = Join-Path $testRoot '.owner'
[IO.File]::WriteAllText($marker, $e2eIdentifier, $utf8)
$manifestFile = Join-Path $testRoot 'installations.json'
try {
    # Placeholder files only test mapping and rejection; no official process is
    # started, and this script supplies no real-client acceptance evidence.
    $files = @('hosts/python.exe','hosts/node.exe','claude/claude.exe','codex/bin/codex.exe','omp/omp.exe','opencode/opencode.exe','workbuddy/WorkBuddy.exe','hermes/source/hermes_cli/main.py','hermes/site-packages/ruamel/yaml/__init__.py','zcode/zcode.cjs','dsh/bin.js','workbuddy/cli.mjs','zcode/provider.json')
    foreach ($relative in $files) {
        $file = Join-Path $testRoot $relative
        $null = New-Item -ItemType Directory -Path (Split-Path -Parent $file) -Force
        [IO.File]::WriteAllText($file, '{}', $utf8)
    }
    $manifest = @{
        schemaVersion = 1
        python = Join-Path $testRoot 'hosts/python.exe'; node = Join-Path $testRoot 'hosts/node.exe'
        hermesSource = Join-Path $testRoot 'hermes/source'; hermesSitePackages = Join-Path $testRoot 'hermes/site-packages'
        zcodeBuiltin = Join-Path $testRoot 'zcode/provider.json'
        runtimes = @{
            claude_code = Join-Path $testRoot 'claude/claude.exe'; codex = Join-Path $testRoot 'codex/bin/codex.exe'
            oh_my_pi = Join-Path $testRoot 'omp/omp.exe'; opencode = Join-Path $testRoot 'opencode/opencode.exe'
            workbuddy = Join-Path $testRoot 'workbuddy/WorkBuddy.exe'; hermes = Join-Path $testRoot 'hosts/python.exe'
            zcode = Join-Path $testRoot 'hosts/node.exe'; deepseek_harness = Join-Path $testRoot 'hosts/node.exe'
        }
        entries = @{ zcode = Join-Path $testRoot 'zcode/zcode.cjs'; deepseek_harness = Join-Path $testRoot 'dsh/bin.js'; workbuddy = Join-Path $testRoot 'workbuddy/cli.mjs' }
    }
    $bad = $manifest.Clone(); $bad.Remove('python'); Reject $bad
    $bad = $manifest.Clone(); $bad.extra = 'unexpected'; Reject $bad
    $bad = $manifest.Clone(); $bad.runtimes = $manifest.runtimes.Clone(); $bad.runtimes.Remove('codex'); Reject $bad
    $bad = $manifest.Clone(); $bad.entries = $manifest.entries.Clone(); $bad.entries.extra = $manifest.entries.zcode; Reject $bad
    $bad = $manifest.Clone(); $bad.python = 'C:\unowned\python.exe'; Reject $bad
    $bad = $manifest.Clone(); $bad.python = 'relative-python.exe'; Reject $bad
    $bad = $manifest.Clone(); $bad.python = Join-Path $e2eWorkspace '../foreign/python.exe'; Reject $bad
    $bad = $manifest.Clone(); $bad.runtimes = $manifest.runtimes.Clone(); $bad.runtimes.hermes = $manifest.node; Reject $bad
    $bad = $manifest.Clone(); $bad.entries = $manifest.entries.Clone(); $bad.entries.workbuddy = Join-Path $testRoot 'missing.mjs'; Reject $bad
    $junction = Join-Path $testRoot 'redirected'
    $null = New-Item -ItemType Junction -Path $junction -Target (Join-Path $testRoot 'hosts')
    try { $bad = $manifest.Clone(); $bad.node = Join-Path $junction 'node.exe'; Reject $bad } finally { Remove-Item -LiteralPath $junction -Force }
    Save-Json $manifest
    $result = Initialize-E2eInstalledClientFixtures -InstallationsManifest $manifestFile
    Check ($result.payload.profiles.Count -eq 8)
    Check (@($result.payload.preservedFiles | Where-Object path -IEQ $manifestFile).Count -eq 1)
    Check ($result.sharedRuntimeFiles.ContainsKey($manifest.entries.workbuddy))
    Check ($result.sharedRuntimeFiles.ContainsKey((Join-Path $manifest.hermesSitePackages 'ruamel/yaml/__init__.py')))
    $dispatch = [IO.File]::ReadAllText($result.payload.profiles.hermes.executablePath)
    Check ($dispatch.Contains($manifest.hermesSitePackages) -and $dispatch.Contains('@args'))
    Check ($dispatch -notmatch '(?i)env:(?:.*API_KEY|.*AUTH_TOKEN|.*BASE_URL|.*MODEL)\s*=')
    foreach ($file in $result.payload.preservedFiles) { Check ((Get-FileHash -LiteralPath $file.path -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $file.sha256) }
    $e2eSandbox = Join-Path $testRoot 'native-owned'
    $native = Initialize-E2eInstalledClientFixtures -InstallationsManifest $manifestFile -UseNativeCodexEntry
    Check ($native.payload.nativeCodexEntry -eq $true)
    Check ($native.payload.profiles.codex.executablePath -ceq $manifest.runtimes.codex)
    Check ($native.payload.discoveredProfiles.codex.executablePath -ceq $manifest.runtimes.codex)
    Check (-not (Test-Path -LiteralPath (Join-Path $e2eSandbox 'installed-clients/bin/codex.ps1')))
    Check ($native.environment.PATH.Split(';')[0] -ceq (Split-Path -Parent $manifest.runtimes.codex))
    Check ($native.sharedRuntimeFiles[$manifest.runtimes.codex] -ceq (Get-FileHash -LiteralPath $manifest.runtimes.codex).Hash.ToLowerInvariant())
    [ordered]@{ passed=$true; checks=$checks; scope='Offline installation mapping and path guards only'; officialClientsLaunched=$false; inferenceExecuted=$false } | ConvertTo-Json -Compress
} finally {
    $expected = [IO.Path]::GetFullPath((Join-Path $e2eWorkspace ('.cache/tmp/native-installation-mapping-' + $e2eIdentifier)))
    if ([IO.Path]::GetFullPath($testRoot) -cne $expected -or [IO.File]::ReadAllText($marker) -cne $e2eIdentifier) { throw 'Mapping fixture cleanup identity changed.' }
    foreach ($item in @(Get-ChildItem -LiteralPath $testRoot -Recurse -Force)) { if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Mapping fixture cleanup encountered a redirected entry.' } }
    Remove-Item -LiteralPath $expected -Recurse -Force
    if (Test-Path -LiteralPath $expected) { throw 'Mapping fixture cleanup failed.' }
}
