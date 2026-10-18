# Load before release Cargo commands. Keep workspace-native linker/library
# flags while replacing source-path provenance with a relative prefix.
. (Join-Path $PSScriptRoot 'workspace-env.ps1')

$releaseWorkspace = [IO.Path]::GetFullPath($env:AE_WORKSPACE).TrimEnd('\', '/')
if ($releaseWorkspace.StartsWith('\\?\', [StringComparison]::Ordinal)) {
    $releaseWorkspace = $releaseWorkspace.Substring(4)
}
$releasePrefixes = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$null = $releasePrefixes.Add($releaseWorkspace)
$null = $releasePrefixes.Add($releaseWorkspace.Replace('\', '/'))
if ($releaseWorkspace -match '^[A-Za-z]:[\\/]') {
    $null = $releasePrefixes.Add('\\?\' + $releaseWorkspace.Replace('/', '\'))
    $null = $releasePrefixes.Add('//?/' + $releaseWorkspace.Replace('\', '/'))
}
$releaseRustFlags = [Collections.Generic.List[string]]::new()
if ($env:CARGO_ENCODED_RUSTFLAGS) {
    foreach ($releaseFlag in $env:CARGO_ENCODED_RUSTFLAGS.Split([char]31)) {
        $releaseRustFlags.Add($releaseFlag)
    }
}
foreach ($releasePrefix in $releasePrefixes) {
    $releaseRustFlags.Add('--remap-path-prefix=' + $releasePrefix + '=.')
}
$env:CARGO_ENCODED_RUSTFLAGS = $releaseRustFlags -join [char]31
