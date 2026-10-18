$ErrorActionPreference = 'Stop'
# Cargo emits UTF-8 JSON even when a hidden PowerShell host inherited the
# Windows legacy console code page. Decode native stdout before JSON parsing.
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'workspace-env.ps1')
$desktopTestRoot = [IO.Path]::GetFullPath($env:CARGO_TARGET_DIR)
$desktopTestWorkspace = [IO.Path]::GetFullPath($env:AE_WORKSPACE)
if (-not $desktopTestRoot.StartsWith($desktopTestWorkspace + '\', [StringComparison]::OrdinalIgnoreCase) -or $desktopTestRoot -match '^[Cc]:') { throw 'Desktop test artifacts must stay inside the workspace.' }

# GNU Rust's test harness does not receive Tauri's binary manifest. Its native
# dialog imports require Common Controls v6, just like the actual desktop app.
# Embed that loader manifest in our freshly compiled, unsigned test executables.
$desktopTestBuild = & cargo test --manifest-path (Join-Path $desktopTestWorkspace 'app/src-tauri/Cargo.toml') --all-features -j 1 --no-run --message-format=json
if ($LASTEXITCODE -ne 0) { throw 'Desktop test compilation failed.' }
$desktopTestExecutables = @($desktopTestBuild | ForEach-Object {
    $artifact = $_ | ConvertFrom-Json
    if ($artifact.reason -eq 'compiler-artifact' -and $artifact.profile.test -and $artifact.executable) { $artifact.executable }
})
if ($desktopTestExecutables.Count -ne 3) { throw 'Expected the library and both binary test harnesses.' }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AeDesktopTestManifest {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr BeginUpdateResource(string file, bool deleteExisting);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool UpdateResource(IntPtr handle, IntPtr type, IntPtr name, ushort language, byte[] data, uint length);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool EndUpdateResource(IntPtr handle, bool discard);
}
'@
$desktopTestManifest = [Text.Encoding]::UTF8.GetBytes(@'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
<assemblyIdentity version="1.0.0.0" processorArchitecture="amd64" name="AE.Switch.Rust.Tests" type="win32"/>
<dependency><dependentAssembly><assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="amd64" publicKeyToken="6595b64144ccf1df" language="*"/></dependentAssembly></dependency>
</assembly>
'@)
foreach ($desktopTestExecutable in $desktopTestExecutables) {
    $desktopTestExecutable = [IO.Path]::GetFullPath($desktopTestExecutable)
    if (-not $desktopTestExecutable.StartsWith((Join-Path $desktopTestRoot 'debug/deps') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected desktop test executable path.' }
    $desktopTestAncestor = $desktopTestExecutable
    while ($desktopTestAncestor.Length -gt $desktopTestWorkspace.Length) {
        if ((Get-Item -LiteralPath $desktopTestAncestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Desktop test artifact uses a junction or link.' }
        $desktopTestAncestor = Split-Path -Parent $desktopTestAncestor
    }
    $desktopTestHandle = [AeDesktopTestManifest]::BeginUpdateResource($desktopTestExecutable, $false)
    if ($desktopTestHandle -eq [IntPtr]::Zero) { throw 'Cannot prepare the test executable manifest.' }
    $desktopTestUpdated = [AeDesktopTestManifest]::UpdateResource($desktopTestHandle, [IntPtr]24, [IntPtr]1, 0, $desktopTestManifest, $desktopTestManifest.Length)
    $desktopTestCommitted = [AeDesktopTestManifest]::EndUpdateResource($desktopTestHandle, -not $desktopTestUpdated)
    if (-not $desktopTestUpdated -or -not $desktopTestCommitted) { throw 'The desktop test loader manifest was not installed.' }
}
Copy-Item -LiteralPath (Join-Path $desktopTestRoot 'debug/WebView2Loader.dll') -Destination (Join-Path $desktopTestRoot 'debug/deps/WebView2Loader.dll') -Force
if (Test-Path -LiteralPath (Join-Path $desktopTestRoot 'release') -PathType Container) {
    foreach ($desktopTestDll in Get-ChildItem -LiteralPath (Join-Path $desktopTestRoot 'release') -Filter 'vcruntime*.dll' -File) {
        Copy-Item -LiteralPath $desktopTestDll.FullName -Destination (Join-Path $desktopTestRoot 'debug/deps') -Force
    }
}
# Process-discovery fixtures copy their harness into an isolated temporary
# directory. Let those helpers resolve the same workspace-owned native DLLs.
$env:PATH = (Join-Path $desktopTestRoot 'debug/deps') + ';' + (Join-Path $desktopTestRoot 'debug') + ';' + $env:PATH
foreach ($desktopTestExecutable in $desktopTestExecutables) {
    & $desktopTestExecutable --quiet
    if ($LASTEXITCODE -ne 0) { throw "Desktop Rust tests failed: $desktopTestExecutable" }
}
Write-Output 'All desktop Rust library and binary test harnesses passed with the application-compatible loader manifest.'
