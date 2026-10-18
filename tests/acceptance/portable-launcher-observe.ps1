param(
    [Parameter(Mandatory)][string]$Launcher,
    [Parameter(Mandatory)][string]$ObservationPath
)
$ErrorActionPreference = 'Stop'
$launcherExit = 1
& $Launcher --version
if ($null -ne $LASTEXITCODE) { $launcherExit = $LASTEXITCODE }
$paths = [ordered]@{}
foreach ($name in @('AE_AGENT_ROOT', 'AE_SWITCH_PORTABLE_ROOT', 'AE_AGENT_ALLOWED_ROOT', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'HERMES_HOME', 'DSH_HOME', 'AE_DSH_RUNTIME', 'AE_DSH_ENTRY', 'AE_DSH_PWSH', 'PI_CODING_AGENT_DIR', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'ZCODE_DATA_BASE_DIR', 'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE', 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE', 'WORKBUDDY_CONFIG_DIR', 'CODEBUDDY_CONFIG_DIR', 'AE_WORKBUDDY_RUNTIME', 'AE_WORKBUDDY_ENTRY', 'GIT_CONFIG_GLOBAL', 'CLAUDE_CODE_GIT_BASH_PATH', 'CODEBUDDY_CODE_GIT_BASH_PATH', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME')) {
    $value = [Environment]::GetEnvironmentVariable($name, 'Process')
    $paths[$name] = if ($value) { $value } else { $null }
}
$observation = [ordered]@{
    exitCode = $launcherExit
    cwd = (Get-Location).Path
    paths = $paths
    binDirectories = @(([string]$env:AE_AGENT_BIN_PATH).Split([IO.Path]::PathSeparator) | Where-Object { $_ })
    credentialValuesRecorded = $false
}
[IO.File]::WriteAllText($ObservationPath, ($observation | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
exit $launcherExit
