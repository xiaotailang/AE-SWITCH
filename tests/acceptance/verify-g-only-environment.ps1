[CmdletBinding()]
param([string]$ReportFile)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'Use the workspace PowerShell 7 runtime.' }
$storageWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if ($storageWorkspace -notmatch '^[Gg]:[\\/]') { throw 'This audit requires the current G: workspace.' }
. (Join-Path $storageWorkspace 'scripts/workspace-env.ps1')
$storageId = [Guid]::NewGuid().ToString('N')
if (-not $ReportFile) { $ReportFile = Join-Path $storageWorkspace ('artifacts/acceptance/storage-boundaries-' + $storageId + '.json') }

function Assert-StoragePath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or -not [IO.Path]::IsPathFullyQualified($Value)) { throw 'A configured cache/profile path is missing or relative.' }
    $absolute = [IO.Path]::GetFullPath($Value)
    if ($absolute -notmatch '^[Gg]:[\\/]' -or -not $absolute.StartsWith($storageWorkspace + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'A configured path escaped the G: workspace.' }
    for ($cursor = $absolute; $cursor; $cursor = [IO.Path]::GetDirectoryName($cursor)) {
        if (Test-Path -LiteralPath $cursor) {
            $metadata = Get-Item -LiteralPath $cursor -Force
            if ($metadata.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'A configured path uses a redirected ancestor.' }
            if (-not [IO.Path]::GetFullPath($metadata.FullName).Equals($cursor, [StringComparison]::OrdinalIgnoreCase)) { throw 'A configured path did not resolve to its expected ordinary location.' }
        }
    }
    return $absolute
}
$ReportFile = Assert-StoragePath $ReportFile
if (Test-Path -LiteralPath $ReportFile) { throw 'Refusing to overwrite an existing storage audit.' }
$storageVariables = @(
    'TEMP','TMP','TMPDIR','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','PSModuleAnalysisCachePath',
    'XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME',
    'CARGO_HOME','RUSTUP_HOME','CARGO_TARGET_DIR','npm_config_cache','npm_config_prefix','npm_config_store_dir',
    'PNPM_HOME','COREPACK_HOME','UV_CACHE_DIR','UV_PYTHON_INSTALL_DIR','PIP_CACHE_DIR',
    'PLAYWRIGHT_BROWSERS_PATH','PYTHONPYCACHEPREFIX','DOTNET_CLI_HOME','NUGET_PACKAGES','GIT_CONFIG_GLOBAL',
    'RTK_DB_PATH','RTK_TEE_DIR','RTK_AUDIT_DIR','NODE_COMPILE_CACHE'
)
$storageExpected = [ordered]@{}
$storageChecks = @()
foreach ($name in $storageVariables) {
    $value = [Environment]::GetEnvironmentVariable($name, 'Process')
    $absolute = Assert-StoragePath $value
    $storageExpected[$name] = $value
    $storageChecks += [ordered]@{ name = $name; workspaceRelativePath = [IO.Path]::GetRelativePath($storageWorkspace, $absolute).Replace('\','/'); ordinaryAncestors = $true; insideGWorkspace = $true }
}
$storageNamesJson = ConvertTo-Json -InputObject $storageVariables -Compress
$storageChildSpecs = @(
    @{ kind = 'node'; executable = Join-Path $storageWorkspace '.tools/node/node.exe'; arguments = @('-e', 'const fs=require("node:fs"),path=require("node:path");const names=JSON.parse(process.env.AE_STORAGE_AUDIT_NAMES);fs.writeFileSync(path.join(process.env.TEMP,process.env.AE_STORAGE_AUDIT_SENTINEL),"owned storage inheritance audit");process.stdout.write(JSON.stringify(Object.fromEntries(names.map(n=>[n,process.env[n]]))));') },
    @{ kind = 'python'; executable = Join-Path $storageWorkspace '.tools/python/cpython-3.14.6-windows-x86_64-none/python.exe'; arguments = @('-B', '-c', 'import os,json,pathlib; names=json.loads(os.environ["AE_STORAGE_AUDIT_NAMES"]); pathlib.Path(os.environ["TEMP"],os.environ["AE_STORAGE_AUDIT_SENTINEL"]).write_text("owned storage inheritance audit",encoding="utf-8"); print(json.dumps({n:os.environ.get(n) for n in names}))') },
    @{ kind = 'pwsh'; executable = Join-Path $storageWorkspace '.tools/pwsh/pwsh.exe'; arguments = @('-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$names=ConvertFrom-Json $env:AE_STORAGE_AUDIT_NAMES; [IO.File]::WriteAllText((Join-Path $env:TEMP $env:AE_STORAGE_AUDIT_SENTINEL),"owned storage inheritance audit");$map=[ordered]@{};foreach($name in $names){$map[$name]=[Environment]::GetEnvironmentVariable($name,"Process")};ConvertTo-Json -InputObject $map -Compress') }
)
$storageChildren = @()
foreach ($specification in $storageChildSpecs) {
    $executable = Assert-StoragePath $specification.executable
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'An explicitly bound child runtime is missing.' }
    $sentinelName = 'ae-storage-' + $storageId + '-' + $specification.kind + '.txt'
    $sentinelPath = Assert-StoragePath (Join-Path $env:TEMP $sentinelName)
    if (Test-Path -LiteralPath $sentinelPath) { throw 'Owned sentinel already exists.' }
    $startInfo = [Diagnostics.ProcessStartInfo]::new($executable)
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WorkingDirectory = $storageWorkspace
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $startInfo.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    $startInfo.Environment['AE_STORAGE_AUDIT_NAMES'] = $storageNamesJson
    $startInfo.Environment['AE_STORAGE_AUDIT_SENTINEL'] = $sentinelName
    foreach ($argument in $specification.arguments) { $startInfo.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) { throw 'An owned inheritance child did not start.' }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(30000)) { $process.Kill(); $process.WaitForExit(); throw 'An owned inheritance child exceeded its time budget.' }
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $null = $stderrTask.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw 'An owned inheritance child failed; raw diagnostics were not retained.' }
        try { $actual = $stdout | ConvertFrom-Json -AsHashtable } catch { throw 'An owned child returned invalid inheritance evidence.' }
        if ($actual.Count -ne $storageVariables.Count) { throw 'Child inheritance evidence is incomplete.' }
        foreach ($name in $storageVariables) {
            if (-not $actual.ContainsKey($name) -or $actual[$name] -cne $storageExpected[$name]) { throw ('An owned child did not inherit the required path variable: ' + $specification.kind + '/' + $name) }
            $null = Assert-StoragePath $actual[$name]
        }
        $null = Assert-StoragePath $sentinelPath
        if (-not (Test-Path -LiteralPath $sentinelPath -PathType Leaf) -or [IO.File]::ReadAllText($sentinelPath) -cne 'owned storage inheritance audit') { throw 'The owned child did not write its sentinel into G: TEMP.' }
        $storageChildren += [ordered]@{kind=$specification.kind; executable=[IO.Path]::GetRelativePath($storageWorkspace,$executable).Replace('\','/');sha256=(Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant();exitCode=$process.ExitCode; inheritedPathCount=$storageVariables.Count; allPathValuesMatch=$true; sentinelWorkspaceRelativePath=[IO.Path]::GetRelativePath($storageWorkspace,$sentinelPath).Replace('\','/');sentinelSha256=(Get-FileHash -LiteralPath $sentinelPath -Algorithm SHA256).Hash.ToLowerInvariant();sentinelRetained=$true}
    } finally { $process.Dispose() }
}
$storageReport = [ordered]@{
    schemaVersion=1;ownerId=$storageId;recordedAt=[DateTimeOffset]::UtcNow.ToString('o');passed=$true
    auditScriptSha256=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant();environmentScriptSha256=(Get-FileHash -LiteralPath (Join-Path $storageWorkspace 'scripts/workspace-env.ps1') -Algorithm SHA256).Hash.ToLowerInvariant()
    scope='Fresh process workspace-env path validation plus Node/Python/PowerShell inheritance and G: TEMP sentinel writes'
    variables=$storageChecks;children=$storageChildren;secretsRead=$false;externalProcessStopped=$false;deletedFiles=0
    limitations=@('Checks configured ordinary paths and actual child sentinel writes. It does not attribute arbitrary Windows, antivirus, input-method, driver or remote-service writes.','No raw environment dump or child stderr is retained.','Three exact-owner harmless G: sentinel files remain listed for separately guarded cleanup.')
}
$null = New-Item -ItemType Directory -Path (Split-Path -Parent $ReportFile) -Force
[IO.File]::WriteAllText($ReportFile, ($storageReport | ConvertTo-Json -Depth 12)+"`n", [Text.UTF8Encoding]::new($false))
Write-Output (@{passed=$true;ownerId=$storageId;configuredPathCount=$storageVariables.Count;verifiedChildKinds=@($storageChildren.kind);report=[IO.Path]::GetRelativePath($storageWorkspace,$ReportFile).Replace('\','/')} | ConvertTo-Json -Compress)
