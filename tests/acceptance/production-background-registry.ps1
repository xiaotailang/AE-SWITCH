[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'

function Get-ProductionBackgroundSha256([string]$Text) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { ([BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}

# Deliberately read-only: no value data or names from other startup entries are emitted.
function Get-ProductionBackgroundRegistry {
    $subkey = 'Software\Microsoft\Windows\CurrentVersion\Run'
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
    $key = $null
    try {
        $key = $base.OpenSubKey($subkey, $false)
        $target = [ordered]@{ present = $false }
        $others = @()
        if ($null -ne $key) {
            foreach ($name in $key.GetValueNames()) {
                $kind = $key.GetValueKind($name).ToString()
                $value = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                if ($name.Equals('AE Switch', [StringComparison]::OrdinalIgnoreCase)) {
                    $target = [ordered]@{ present = $true; kind = $kind; registryType = $(if ($kind -ceq 'String') { 'REG_SZ' } else { $kind }); commandSha256 = $(if ($value -is [string]) { Get-ProductionBackgroundSha256 $value } else { $null }) }
                } else {
                    $data = ConvertTo-Json -InputObject $value -Compress -Depth 8
                    $others += [ordered]@{ nameSha256 = (Get-ProductionBackgroundSha256 $name); kind = $kind; dataSha256 = (Get-ProductionBackgroundSha256 $data) }
                }
            }
        }
        $others = @($others | Sort-Object { $_.nameSha256 })
        [ordered]@{
            schemaVersion = 1
            hive = 'HKEY_CURRENT_USER'
            registryView = 'Registry64'
            subkey = $subkey
            valueName = 'AE Switch'
            keyPresent = $null -ne $key
            target = $target
            otherValues = $others
            otherEntryCount = $others.Count
            otherValuesSha256 = Get-ProductionBackgroundSha256 (ConvertTo-Json -InputObject $others -Compress -Depth 8)
        }
    } finally {
        if ($null -ne $key) { $key.Dispose() }
        $base.Dispose()
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    Get-ProductionBackgroundRegistry | ConvertTo-Json -Depth 10 -Compress
}
