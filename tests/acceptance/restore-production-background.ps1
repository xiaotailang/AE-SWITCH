[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BindingFile,
    [switch]$ValidateOnly,
    [switch]$EmergencyCleanup
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'production-background-registry.ps1')

function Get-ProductionBackgroundFileSha256([string]$File) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { ([BitConverter]::ToString($algorithm.ComputeHash([IO.File]::ReadAllBytes($File)))).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}

function Assert-ProductionBackgroundOrdinaryPath([string]$File, [string]$Root) {
    $full = [IO.Path]::GetFullPath($File)
    $expectedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    if ($full -notmatch '^[Gg]:[\\/]' -or (-not $full.Equals($expectedRoot, [StringComparison]::OrdinalIgnoreCase) -and -not $full.StartsWith($expectedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase))) { throw 'Background recovery path escaped its exact G owner root' }
    $cursor = $full
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if (((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Background recovery reparse path refused' }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if (-not $parent -or $parent -eq $cursor) { break }
        $cursor = $parent
    }
    if (-not (Test-Path -LiteralPath $full)) { throw 'Required background recovery path absent' }
    $full
}

function Assert-ProductionBackgroundEmergencyBinding([string]$File) {
    $workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
    $full = Assert-ProductionBackgroundOrdinaryPath $File (Join-Path $workspace '.cache/native-e2e-sandbox')
    $binding = Get-Content -LiteralPath $full -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($binding.schemaVersion -ne 1 -or $binding.ownerId -cnotmatch '^[a-f0-9]{32}$' -or $binding.productionSha256 -cnotmatch '^[a-f0-9]{64}$' -or $binding.sourceDigest -cnotmatch '^[a-f0-9]{64}$' -or $binding.buildAuditId -cnotmatch '^[a-f0-9]{32}$') { throw 'Explicit production background identity required' }
    $root = Join-Path $workspace ('.cache/native-e2e-sandbox/' + $binding.ownerId)
    if ($binding.workspace -ine $workspace -or $binding.root -ine $root -or $full -ine (Join-Path $root 'background-emergency-binding.json')) { throw 'Exact background recovery owner path required' }
    $marker = Assert-ProductionBackgroundOrdinaryPath (Join-Path $root '.ae-production-ui-eight-owner.json') $root
    $owner = Get-Content -LiteralPath $marker -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($owner.schemaVersion -ne 2) { throw 'Current production owner schema required' }
    foreach ($field in @('ownerId', 'productionSha256', 'sourceDigest', 'buildAuditId')) {
        if ($owner.$field -cne $binding.$field) { throw ('Background owner identity changed: ' + $field) }
    }
    if ($owner.workspace -ine $workspace) { throw 'Background owner workspace changed' }
    $exe = Assert-ProductionBackgroundOrdinaryPath $binding.productionProgram $root
    if ([IO.Path]::GetFileName($exe) -cne 'AE-Switch.exe' -or $exe.Contains('"') -or $exe.Contains("`r") -or $exe.Contains("`n") -or (Get-ProductionBackgroundFileSha256 $exe) -cne $binding.productionSha256) { throw 'Exact owned production executable bytes required' }
    $command = '"' + $exe + '" --background'
    if ((Get-ProductionBackgroundSha256 $command) -cne $binding.expectedCommandSha256) { throw 'Background recovery command changed' }
    $baselineFile = Assert-ProductionBackgroundOrdinaryPath $binding.baselineFile $root
    if ($baselineFile -ine (Join-Path $root 'background-registry-baseline.json') -or (Get-ProductionBackgroundFileSha256 $baselineFile) -cne $binding.baselineSha256) { throw 'Independent baseline receipt bytes changed' }
    $baseline = Get-Content -LiteralPath $baselineFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($baseline.schemaVersion -ne 1 -or $baseline.hive -cne 'HKEY_CURRENT_USER' -or $baseline.registryView -cne 'Registry64' -or $baseline.subkey -cne 'Software\Microsoft\Windows\CurrentVersion\Run' -or $baseline.valueName -cne 'AE Switch' -or $baseline.keyPresent -ne $true -or $baseline.target.present -ne $false) { throw 'An independently recorded absent target baseline is required' }
    @{ binding = $binding; command = $command; baseline = $baseline }
}

if ($ValidateOnly -eq $EmergencyCleanup) { throw 'Choose exactly one explicit validation or emergency-cleanup mode' }
$validated = Assert-ProductionBackgroundEmergencyBinding $BindingFile
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($ValidateOnly) {
    @{ bindingValidated = $true; registryAccessed = $false; registryModified = $false } | ConvertTo-Json -Compress
    exit 0
}

# Recovery deletes this one value only, after rechecking its exact type and bytes on the writable handle.
$base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
$key = $null
try {
    $key = $base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run', $true)
    if ($null -eq $key -or -not @($key.GetValueNames()).Contains('AE Switch')) { throw 'Exact owned startup value absent; emergency deletion refused' }
    if ($key.GetValueKind('AE Switch') -ne [Microsoft.Win32.RegistryValueKind]::String -or $key.GetValue('AE Switch', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) -cne $validated.command) { throw 'Foreign or changed startup value; emergency deletion refused' }
    $key.DeleteValue('AE Switch', $true)
} finally {
    if ($null -ne $key) { $key.Dispose() }
    $base.Dispose()
}
$after = Get-ProductionBackgroundRegistry
if ($after.target.present) { throw 'Emergency startup removal readback failed' }
@{ removed = $true; exactOwnedValueOnly = $true; registryAccessed = $true; registryModified = $true; nativeUiRecovery = $false; otherValuesSha256 = $after.otherValuesSha256 } | ConvertTo-Json -Compress
