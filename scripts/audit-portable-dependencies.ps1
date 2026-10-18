[CmdletBinding()]
param(
    [string]$DesktopExecutable = '.cache/cargo-target/release/ae-switch.exe',
    [string]$CoreExecutable = '.cache/cargo-target/release/ae-switch-cli.exe',
    [string]$Loader = '.cache/cargo-target/release/WebView2Loader.dll',
    [string]$WebViewDirectory = '.tools/webview2',
    [string]$ReportPath = 'artifacts/acceptance/portable-dependencies.json'
)
$ErrorActionPreference = 'Stop'
$auditWorkspace = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
function LocalFile([string]$Path, [switch]$Directory) {
    $absolute = [IO.Path]::GetFullPath($(if ([IO.Path]::IsPathRooted($Path)) { $Path } else { Join-Path $auditWorkspace $Path }))
    if ($absolute -match '^[Cc]:[\\/]' -or -not $absolute.StartsWith($auditWorkspace + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Dependency evidence paths must remain in the G workspace.' }
    $cursor = $absolute
    while ($cursor -and $cursor.Length -ge $auditWorkspace.Length) {
        if (Test-Path -LiteralPath $cursor) {
            $entry = Get-Item -LiteralPath $cursor -Force
            if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Dependency audit refuses linked paths.' }
        }
        $cursor = Split-Path -Parent $cursor
    }
    if ($Directory) { if (-not (Test-Path -LiteralPath $absolute -PathType Container)) { throw 'Dependency runtime directory is missing.' } }
    elseif (-not (Test-Path -LiteralPath $absolute -PathType Leaf)) { throw 'Dependency input file is missing.' }
    return $absolute
}
$objdump = LocalFile '.tools/llvm-mingw-20261006-msvcrt-x86_64/bin/llvm-objdump.exe'
$runtime = LocalFile $WebViewDirectory -Directory
$systemLibraries = @('kernel32.dll','bcryptprimitives.dll','ntdll.dll','user32.dll','oleaut32.dll','gdi32.dll','advapi32.dll','dwmapi.dll','ole32.dll','combase.dll','comctl32.dll','imm32.dll','shlwapi.dll','shell32.dll','ws2_32.dll','rstrtmgr.dll','bcrypt.dll','msvcrt.dll','winmm.dll','crypt32.dll','version.dll','dwrite.dll')
$inputs = @(
    @{ role = 'desktop'; path = LocalFile $DesktopExecutable; allowed = @('webview2loader.dll') },
    @{ role = 'core'; path = LocalFile $CoreExecutable; allowed = @() },
    @{ role = 'loader'; path = LocalFile $Loader; allowed = @() },
    @{ role = 'fixed-webview-browser'; path = LocalFile (Join-Path $runtime 'msedgewebview2.exe'); allowed = @('msedge_elf.dll') },
    @{ role = 'fixed-webview-main'; path = LocalFile (Join-Path $runtime 'msedge.dll'); allowed = @('msedge_elf.dll') }
)
$proof = [Collections.Generic.List[object]]::new()
$passed = $true
foreach ($inputFile in $inputs) {
    $before = (Get-FileHash -LiteralPath $inputFile.path -Algorithm SHA256).Hash.ToLowerInvariant()
    $text = & $objdump -p $inputFile.path 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'LLVM could not parse an audited PE file.' }
    # LLVM's export table uses "DLL name" for the module itself; imports use
    # "DLL Name". Keep the match case-sensitive to avoid inventing dependencies.
    $imports = @($text | ForEach-Object { if ($_ -cmatch '^\s*DLL Name:\s*([^\s]+)\s*$') { $Matches[1].ToLowerInvariant() } } | Sort-Object -Unique)
    if (-not $imports.Count) { throw 'An audited PE input has no parsed import table.' }
    $nonSystem = @($imports | Where-Object { $_ -notin $systemLibraries -and $_ -notmatch '^(?:api-ms-win-|ext-ms-win-)[a-z0-9-]+\.dll$' })
    $unexpected = @($nonSystem | Where-Object { $_ -notin $inputFile.allowed })
    if ($unexpected.Count) { $passed = $false }
    if ((Get-FileHash -LiteralPath $inputFile.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $before) { throw 'An audited PE file changed while reading its imports.' }
    $proof.Add(@{ role = $inputFile.role; path = $inputFile.path; sha256 = $before; imports = $imports; nonSystemImports = $nonSystem; unexpectedImports = $unexpected })
}
$edgeLibrary = LocalFile (Join-Path $runtime 'msedge_elf.dll')
$report = [IO.Path]::GetFullPath($(if ([IO.Path]::IsPathRooted($ReportPath)) { $ReportPath } else { Join-Path $auditWorkspace $ReportPath }))
if (-not $report.StartsWith((Join-Path $auditWorkspace 'artifacts/acceptance') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Dependency receipt must stay in the acceptance directory.' }
New-Item -ItemType Directory -Path (Split-Path -Parent $report) -Force | Out-Null
$null = LocalFile (Split-Path -Parent $report) -Directory
[IO.File]::WriteAllText($report, (@{
    recordedAt = [DateTime]::UtcNow.ToString('o'); passed = $passed
    scope = 'Static PE imports only; excludes dynamic-load behavior and fresh-machine startup acceptance'
    tool = @{ path = $objdump; sha256 = (Get-FileHash -LiteralPath $objdump -Algorithm SHA256).Hash.ToLowerInvariant(); origin = 'Workspace LLVM-MinGW 20261006 distribution; llvm-objdump' }
    binaries = @($proof.ToArray()); packagedWebViewDependency = @{ path = $edgeLibrary; sha256 = (Get-FileHash -LiteralPath $edgeLibrary -Algorithm SHA256).Hash.ToLowerInvariant() }
    unrelatedOnnxOrPythonRuntimeRequiredByStaticImports = $false
} | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
Write-Host "Static portable dependency audit passed=$passed; receipt=$report"
if (-not $passed) { throw 'A portable PE binary has an unexpected non-system DLL import.' }
