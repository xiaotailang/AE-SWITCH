$ErrorActionPreference = 'Stop'
$taskWorkspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../../../..')).Path
$taskSource = Get-Content -LiteralPath (Join-Path $taskWorkspace 'app/src-tauri/src/agent_configs.rs') -Raw -Encoding UTF8
$taskTemplate = [regex]::Match($taskSource, 'format!\(\s*r#"(.*?)"#', [Text.RegularExpressions.RegexOptions]::Singleline)
if (-not $taskTemplate.Success) { throw 'Rust launcher template was not found' }
$taskLauncher = $taskTemplate.Groups[1].Value.Replace('{{', '{').Replace('}}', '}').Replace('{command}', 'codex').Replace('{name}', 'Codex')
$taskRoot = Join-Path $env:TEMP ('launcher-diagnostic-' + [guid]::NewGuid().ToString('N'))
if (-not [IO.Path]::GetFullPath($taskRoot).StartsWith([IO.Path]::GetFullPath($taskWorkspace) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Diagnostic TEMP escaped the workspace' }
$taskOriginal = Join-Path $taskRoot 'agents/codex'
foreach ($taskRelative in @('home/.codex', 'tmp', 'cache', 'configuration', 'workspace', 'bin-one', 'bin two')) { New-Item -ItemType Directory -Path (Join-Path $taskOriginal $taskRelative) -Force | Out-Null }
$taskEnvironment = [ordered]@{
    AE_AGENT_ROOT = $taskOriginal
    AE_SWITCH_PORTABLE_ROOT = $taskRoot
    AE_AGENT_PORTABLE_RELATIVE_ROOT = '../..'
    AE_AGENT_BIN_PATH = (Join-Path $taskOriginal 'bin-one') + ';' + (Join-Path $taskOriginal 'bin two')
    HOME = Join-Path $taskOriginal 'home'
    USERPROFILE = Join-Path $taskOriginal 'home'
    TEMP = Join-Path $taskOriginal 'tmp'
    TMP = Join-Path $taskOriginal 'tmp'
    CODEX_HOME = Join-Path $taskOriginal 'home/.codex'
    NO_PROXY = 'localhost,127.0.0.1,::1'
    AE_GATEWAY_TOKEN = 'diagnostic-local-token'
}
$taskEnvironment | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskOriginal 'configuration/environment.json') -Encoding UTF8
$taskLauncher | Set-Content -LiteralPath (Join-Path $taskOriginal 'launch.ps1') -Encoding UTF8
'@{ arguments = @($args); home = $env:HOME; temp = $env:TEMP; config = $env:CODEX_HOME; bins = $env:AE_AGENT_BIN_PATH; bypass = $env:NO_PROXY; lowerBypass = $env:no_proxy; cwd = (Get-Location).Path } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $env:AE_ARGUMENT_CAPTURE -Encoding UTF8; exit 17' | Set-Content -LiteralPath (Join-Path $taskOriginal 'bin-one/codex.ps1') -Encoding UTF8
$taskMoved = Join-Path $taskRoot 'moved agent with spaces'
foreach ($taskMovePath in @($taskOriginal, $taskMoved)) {
    if (-not [IO.Path]::GetFullPath($taskMovePath).StartsWith([IO.Path]::GetFullPath($taskRoot) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Diagnostic move escaped its workspace TEMP directory' }
}
Move-Item -LiteralPath $taskOriginal -Destination $taskMoved
$taskExpected = @('exec', 'contains spaces', 'embedded"quote', 'literal$()', 'semi;colon', '--json')
foreach ($taskShell in @('pwsh.exe', 'powershell.exe')) {
    $taskCaptured = Join-Path $taskRoot ($taskShell + '.json')
    $taskStart = [Diagnostics.ProcessStartInfo]::new($taskShell)
    $taskStart.UseShellExecute = $false
    $taskStart.CreateNoWindow = $true
    $taskStart.RedirectStandardOutput = $true
    $taskStart.RedirectStandardError = $true
    foreach ($taskArgument in @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $taskMoved 'launch.ps1')) + $taskExpected) { $taskStart.ArgumentList.Add($taskArgument) }
    $taskStart.Environment['AE_ARGUMENT_CAPTURE'] = $taskCaptured
    $taskProcess = [Diagnostics.Process]::Start($taskStart)
    $taskStdout = $taskProcess.StandardOutput.ReadToEnd()
    $taskStderr = $taskProcess.StandardError.ReadToEnd()
    $taskProcess.WaitForExit()
    if ($taskProcess.ExitCode -ne 17) { throw "$taskShell failed ($($taskProcess.ExitCode)): $taskStderr $taskStdout" }
    $taskCapture = Get-Content -LiteralPath $taskCaptured -Raw -Encoding UTF8 | ConvertFrom-Json
    if (($taskCapture.arguments | ConvertTo-Json -Compress) -ne ($taskExpected | ConvertTo-Json -Compress)) { throw "$taskShell changed argument values" }
    foreach ($taskField in @('home', 'temp', 'config', 'cwd')) { if (-not ([string]$taskCapture.$taskField).StartsWith($taskMoved + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "$taskShell did not rebase $taskField" } }
    foreach ($taskBin in $taskCapture.bins.Split(';')) { if (-not $taskBin.StartsWith($taskMoved + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "$taskShell did not rebase all PATH segments" } }
    if ($taskCapture.bypass -ne 'localhost,127.0.0.1,::1' -or $taskCapture.lowerBypass -ne $taskCapture.bypass) { throw "$taskShell lost local proxy bypass" }
    Write-Output ("{0}: PASS arguments, relocation, both PATH segments, proxy bypass and exit code" -f $taskShell)
}
