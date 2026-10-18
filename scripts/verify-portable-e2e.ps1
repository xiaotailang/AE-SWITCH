[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PackageDirectory,
    [string]$CredentialsFile,
    [switch]$NativeUi,
    [switch]$NativeUpdateFixture,
    [switch]$NativeGatewayFixture,
    [string]$QaExecutablePath,
    [string]$CleanupNativeSandboxId
)

$ErrorActionPreference = 'Stop'
if ($NativeUpdateFixture -and (-not $NativeUi -or $CleanupNativeSandboxId)) { throw 'The local update fixture requires a fresh -NativeUi run.' }
if ($NativeGatewayFixture -and (-not $NativeUi -or $NativeUpdateFixture)) { throw 'The gateway fixture requires -NativeUi and is mutually exclusive with the update fixture.' }
$e2eWorkspace = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
# Validate before workspace-env.ps1 creates any cache or tool directories.
$e2eDriveRoot = [IO.Path]::GetPathRoot($e2eWorkspace)
if ($e2eWorkspace -notmatch '^[A-Za-z]:[\\/]' -or $e2eDriveRoot -match '^[Cc]:[\\/]' -or
    ([IO.DriveInfo]::new($e2eDriveRoot)).DriveType -notin @([IO.DriveType]::Fixed, [IO.DriveType]::Removable, [IO.DriveType]::Ram)) {
    throw 'The E2E workspace must be on a local drive outside C:.'
}
$e2eAncestor = $e2eWorkspace
while ($e2eAncestor) {
    $e2eMetadata = Get-Item -LiteralPath $e2eAncestor -Force -ErrorAction Stop
    if (-not $e2eMetadata.PSIsContainer -or ($e2eMetadata.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'The E2E workspace and all its ancestors must be ordinary local directories.'
    }
    if ($e2eAncestor -eq $e2eDriveRoot) { break }
    $e2eAncestor = Split-Path -Parent $e2eAncestor
}
$e2eBase = Join-Path $e2eWorkspace $(if ($NativeUi) { '.cache/native-e2e-sandbox' } else { '.cache/e2e-sandbox' })
if ($CleanupNativeSandboxId -and (-not $NativeUi -or $CleanupNativeSandboxId -cnotmatch '^[a-f0-9]{32}$')) { throw 'Native cleanup requires an owned UUID in the native acceptance directory.' }
$e2eIdentifier = if ($CleanupNativeSandboxId) { $CleanupNativeSandboxId } else { [Guid]::NewGuid().ToString('N') }
$e2eSandbox = Join-Path $e2eBase $e2eIdentifier
$e2eMarker = Join-Path $e2eSandbox $(if ($NativeUi) { '.ae-native-e2e-owner.json' } else { '.ae-switch-e2e-owner.json' })
$e2ePurpose = if ($NativeUi) { 'AE Switch owned native UI and real tool acceptance' } else { 'AE Switch owned E2E tool installation' }
$e2eReport = Join-Path $e2eWorkspace $(if ($NativeGatewayFixture) { "artifacts/acceptance/native-gateway/$e2eIdentifier/native-gateway-wrapper.json" } elseif ($NativeUi) { 'artifacts/acceptance/native-e2e-wrapper.json' } else { 'artifacts/acceptance/portable-e2e.json' })
$e2eUtf8 = [Text.UTF8Encoding]::new($false)
$e2eOutcome = 1
$e2eQaProcess = $null
$e2eOwnedNativeProcesses = @{}
$e2eNativeChildDiagnostics = [Collections.Generic.List[object]]::new()
$e2eNativeMarkerHash = $null
$e2eNativeExternalGitObservation = $null
$e2eNativeIdentityFailure = $false
$e2eNativeUpdateEnvironment = @{}
$e2eNativeGatewayEnvironment = @{}
$e2eGatewayFixture = $null
$e2eInstalledClientFixtures = $null
$e2eSharedRuntimeFiles = @{}
$e2eNativeClientEnvironment = @{}

function Get-E2ePortableInstallationRoot { return Join-Path $e2eSandbox 'portable' }

function Test-E2eDshEmptyLaunchReceipt([object[]]$Receipts, $Processes, [int]$QaProcessId, [string]$Entry) {
    $dsh = @($Receipts | Where-Object { $_.id -ceq 'deepseek_harness' })
    if ($dsh.Count -ne 1 -or $dsh[0].uiLaunchSucceeded -ne $false) { return $false }
    foreach ($flag in @('launchUnsupported', 'taskRequired', 'processNotStarted')) {
        if ($dsh[0].$flag -ne $true) { return $false }
    }
    # A task probe is still allowed. Reject evidence of an empty native launch.
    $empty = @($Processes.Values | Where-Object {
        $_.kind -eq 'official-powershell-launcher' -and $_.nativeLaunch -eq $true -and $_.launcher -ieq $Entry -and $_.parentId -eq $QaProcessId
    })
    return $empty.Count -eq 0
}

function New-E2eNativeLaunchWaitScript([string]$AgentId, [string]$Directory, [string]$OwnerId) {
    if ($AgentId -cnotin @('claude_code','codex','hermes','oh_my_pi','opencode','zcode','workbuddy')) { throw 'Only seven interactive fixture entries can wait for launch proof.' }
    $script = @'
# Keep a zero-argument UI fixture entry alive until the owner proves its handle.
# Task/version arguments bypass this wait and retain their original dispatch.
if ($args.Count -eq 0) {
    $launchProofDirectory = '__DIRECTORY__'
    $launchProofOwner = '__OWNER__'
    $launchProofAgent = '__AGENT__'
    $launchProofClock = [Diagnostics.Stopwatch]::StartNew()
    $launchProofAccepted = $false
    $launchProofProcess = [Diagnostics.Process]::GetCurrentProcess()
    while ($launchProofClock.ElapsedMilliseconds -lt 20000) {
        $active = Join-Path $launchProofDirectory 'active-request.json'
        if ([IO.File]::Exists($active)) {
            if ([IO.File]::GetAttributes($active) -band [IO.FileAttributes]::ReparsePoint) { throw 'Redirected launch request refused.' }
            $request = [IO.File]::ReadAllText($active) | ConvertFrom-Json
            if ($request.id -ceq $launchProofAgent -and $request.ownerId -ceq $launchProofOwner -and $request.requestId -cmatch '^[a-f0-9]{32}$') {
                $proofFile = Join-Path $launchProofDirectory ('proof-' + $launchProofAgent + '-' + $request.requestId + '.json')
                if ([IO.File]::Exists($proofFile)) {
                    if ([IO.File]::GetAttributes($proofFile) -band [IO.FileAttributes]::ReparsePoint) { throw 'Redirected launch proof refused.' }
                    $proof = [IO.File]::ReadAllText($proofFile) | ConvertFrom-Json
                    if ($proof.ownerId -ceq $launchProofOwner -and $proof.id -ceq $launchProofAgent -and $proof.requestId -ceq $request.requestId -and $proof.pid -eq $PID -and ([datetime]$proof.startedAt).ToUniversalTime().Ticks -eq $launchProofProcess.StartTime.ToUniversalTime().Ticks -and $proof.parentPid -eq $request.qaPid -and $proof.nativeLaunch -eq $true -and $proof.retainedIdentityProofPassed -eq $true) {
                        $launchProofAccepted = $true
                        break
                    }
                }
            }
        }
        Start-Sleep -Milliseconds 25
    }
    $launchProofProcess.Dispose()
    if (-not $launchProofAccepted) { throw 'Owned UI launch proof timed out; official runtime was not dispatched.' }
}
'@
    return $script.Replace('__DIRECTORY__', $Directory.Replace("'", "''")).Replace('__OWNER__', $OwnerId).Replace('__AGENT__', $AgentId)
}

function Get-E2eNativeLaunchRequest {
    if (-not $e2eInstalledClientFixtures -or -not $e2eInstalledClientFixtures.payload.ContainsKey('launchProofDirectory') -or -not $e2eQaProcess) { return $null }
    Assert-E2eNativeOwner
    $directory = Assert-E2eLocalPath $e2eInstalledClientFixtures.payload.launchProofDirectory
    if ($directory -ine (Join-Path $e2eSandbox 'installed-clients/ui-launch-proof')) { throw 'Launch proof directory does not match this owner.' }
    if (([IO.File]::GetAttributes($directory) -band [IO.FileAttributes]::Directory) -eq 0) { throw 'Launch proof root is not a directory.' }
    for ($cursor = $directory; $cursor; $cursor = [IO.Path]::GetDirectoryName($cursor)) {
        if ([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) { throw 'Redirected launch proof directory refused.' }
    }
    $active = Join-Path $directory 'active-request.json'
    if (-not [IO.File]::Exists($active)) { return $null }
    $null = Assert-E2eNativeOrdinaryFile $active
    $request = if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { [IO.File]::ReadAllText($active) | ConvertFrom-Json -DateKind String } else { [IO.File]::ReadAllText($active) | ConvertFrom-Json }
    if ($request.ownerId -cne $e2eIdentifier -or $request.id -cnotin @('claude_code','codex','hermes','oh_my_pi','opencode','zcode','workbuddy') -or $request.requestId -cnotmatch '^[a-f0-9]{32}$') { throw 'Invalid owned launch request.' }
    $qa = $e2eOwnedNativeProcesses[$e2eQaProcess.Id]
    if (-not $qa) { return $null }
    $qa.process.Refresh()
    if ($qa.process.HasExited) { return $null }
    Assert-E2eNativeProcessIdentity $qa -VerifyHash
    if ($request.qaPid -ne $e2eQaProcess.Id -or ([datetime]$request.qaStartedAt).ToUniversalTime().Ticks -ne $qa.started.Ticks -or $request.qaSha256 -cne $qa.sha256 -or $request.launcher -ine $e2eInstalledClientFixtures.payload.profiles[$request.id].executablePath) { throw 'Launch request QA or entry identity changed.' }
    $requested = ([datetime]$request.requestedAt).ToUniversalTime()
    $deadline = ([datetime]$request.deadlineAt).ToUniversalTime()
    if ($deadline -le $requested -or ($deadline - $requested).TotalSeconds -gt 21 -or $requested -gt [datetime]::UtcNow.AddSeconds(1)) { throw 'Invalid bounded launch request time.' }
    if ([datetime]::UtcNow -gt $deadline) { return $null }
    return @{ request = $request; qa = $qa; directory = $directory; requested = $requested }
}

function Write-E2eNativeLaunchAcknowledgment($Context, [string]$Stage, $Identity = $null) {
    $request = $Context.request
    $file = Assert-E2eLocalPath (Join-Path $Context.directory ($Stage + '-' + $request.id + '-' + $request.requestId + '.json'))
    if ([IO.File]::Exists($file)) { $null = Assert-E2eNativeOrdinaryFile $file; return }
    Assert-E2eNativeOwner
    $receipt = @{ stage = $Stage; id = $request.id; requestId = $request.requestId; ownerId = $e2eIdentifier; qaPid = $e2eQaProcess.Id; qaStartedAt = $Context.qa.started.ToString('o'); qaSha256 = $Context.qa.sha256; launcher = $request.launcher; ownedQaIdentityVerified = $true; recordedAt = [datetime]::UtcNow.ToString('o') }
    if ($Stage -ceq 'proof') {
        $receipt.pid = $Identity.process.Id; $receipt.parentPid = $Identity.parentId; $receipt.startedAt = $Identity.started.ToString('o'); $receipt.imageSha256 = $Identity.sha256
        $receipt.kind = $Identity.kind; $receipt.nativeLaunch = $true; $receipt.retainedIdentityProofPassed = $true
    }
    $data = [Text.UTF8Encoding]::new($false).GetBytes(($receipt | ConvertTo-Json -Depth 5))
    # Readers must never observe a partially written or sharing-locked ACK.
    # Publish only after the owned same-directory temporary file is closed.
    $temporary = Assert-E2eLocalPath (Join-Path $Context.directory ([IO.Path]::GetFileName($file) + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'))
    $temporaryCreated = $false
    try {
        $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $temporaryCreated = $true
        try { $stream.Write($data, 0, $data.Length); $stream.Flush($true) } finally { $stream.Dispose() }
        Assert-E2eNativeOwner
        $null = Assert-E2eNativeOrdinaryFile $temporary
        $null = Assert-E2eLocalPath $file
        [IO.File]::Move($temporary, $file)
    } finally {
        if ($temporaryCreated -and [IO.File]::Exists($temporary)) {
            Assert-E2eNativeOwner
            $null = Assert-E2eNativeOrdinaryFile $temporary
            [IO.File]::Delete($temporary)
        }
    }
}

function Publish-E2eNativeLaunchProof($Identity) {
    if ($Identity.kind -cne 'official-powershell-launcher' -or $Identity.nativeLaunch -ne $true) { return }
    $context = Get-E2eNativeLaunchRequest
    if (-not $context -or $Identity.parentId -ne $e2eQaProcess.Id -or $Identity.launcher -ine $context.request.launcher -or $Identity.started -lt $context.requested) { return }
    $expectedPowerShell = Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell/v1.0/powershell.exe'
    if ($Identity.path -ine $expectedPowerShell) { return }
    Assert-E2eNativeProcessIdentity $context.qa -VerifyHash
    Assert-E2eNativeProcessIdentity $Identity -VerifyHash
    Write-E2eNativeLaunchAcknowledgment $context 'proof' $Identity
}

function Restore-E2eNativeClientEnvironment {
    foreach ($name in $e2eNativeClientEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $e2eNativeClientEnvironment[$name], [EnvironmentVariableTarget]::Process)
    }
}

function Initialize-E2eInstalledClientFixtures {
    param([string]$InstallationsManifest, [switch]$UseNativeCodexEntry)
    # The distribution contains AE only. Reuse exact, unmodified official
    # test runtimes read-only; all native user profiles remain in this UUID.
    $root = Assert-E2eLocalPath (Join-Path $e2eSandbox 'installed-clients')
    $clientHome = Join-Path $root 'home'
    $workspace = Join-Path $root 'workspace'
    $bin = Join-Path $root 'bin'
    $launchProofDirectory = Join-Path $root 'ui-launch-proof'
    $python = Assert-E2eLocalPath (Join-Path $e2eWorkspace '.tools/python/cpython-3.14.6-windows-x86_64-none/python.exe')
    $node = Assert-E2eLocalPath (Join-Path $e2eWorkspace '.tools/node/node.exe')
    $yamlLibrary = Assert-E2eLocalPath (Join-Path $e2eWorkspace '.tools/agents/hermes/.venv/Lib/site-packages')
    $hermesSource = Assert-E2eLocalPath (Join-Path $e2eWorkspace '.tools/agents/hermes/source')
    $runtimePaths = @{
        claude_code = '.tools/agents/claude/node_modules/@anthropic-ai/claude-code-win32-x64/claude.exe'
        codex = '.tools/agents/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe'
        oh_my_pi = '.tools/agents/oh_my_pi/omp.exe'
        opencode = '.tools/agents/opencode/node_modules/opencode-windows-x64/bin/opencode.exe'
        workbuddy = '.tools/workbuddy/WorkBuddy.exe'
        hermes = '.tools/python/cpython-3.14.6-windows-x86_64-none/python.exe'
        zcode = '.tools/node/node.exe'
        deepseek_harness = '.tools/node/node.exe'
    }
    $entryPaths = @{
        zcode = Join-Path $e2eWorkspace '.tools/agents/zcode/source/apps/zcode-cli/packages/cli/dist/zcode.cjs'
        deepseek_harness = Join-Path $e2eWorkspace '.tools/agents/deepseek_harness/node_modules/@deepseek-ai/dsh/lib/bin.js'
        workbuddy = Join-Path $e2eWorkspace '.tools/workbuddy/resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs'
    }
    $builtinSource = Join-Path $e2eWorkspace '.tools/agents/zcode/source/apps/zcode-cli/packages/cli/dist/provider/zcode-builtin.json'
    $installationBinding = $null
    if ($PSBoundParameters.ContainsKey('InstallationsManifest')) {
        # Reuse explicitly located official installations without copying client
        # trees. These are read-only test inputs, never discovery injection.
        if (-not [IO.Path]::IsPathFullyQualified($InstallationsManifest)) { throw 'An absolute owned installations manifest is required.' }
        $manifestFile = Assert-E2eLocalPath $InstallationsManifest
        if (-not (Test-Path -LiteralPath $manifestFile -PathType Leaf)) { throw 'The owned installations manifest is missing.' }
        $installationBinding = @{ path = $manifestFile; sha256 = (Get-FileHash -LiteralPath $manifestFile -Algorithm SHA256).Hash.ToLowerInvariant() }
        try { $installation = [IO.File]::ReadAllText($manifestFile, [Text.Encoding]::UTF8) | ConvertFrom-Json -AsHashtable } catch { throw 'Invalid owned installations manifest JSON.' }
        $manifestKeys = @('schemaVersion','python','node','hermesSource','hermesSitePackages','zcodeBuiltin','runtimes','entries')
        if ($installation -isnot [Collections.IDictionary] -or $installation.schemaVersion -ne 1 -or
            @(Compare-Object @($manifestKeys | Sort-Object) @($installation.Keys | Sort-Object)).Count -or
            $installation.runtimes -isnot [Collections.IDictionary] -or $installation.entries -isnot [Collections.IDictionary] -or
            @(Compare-Object @($runtimePaths.Keys | Sort-Object) @($installation.runtimes.Keys | Sort-Object)).Count -or
            @(Compare-Object @($entryPaths.Keys | Sort-Object) @($installation.entries.Keys | Sort-Object)).Count) {
            throw 'The installations manifest must bind exactly eight runtimes and three official entries.'
        }
        foreach ($value in @($installation.python,$installation.node,$installation.hermesSource,$installation.hermesSitePackages,$installation.zcodeBuiltin) + @($installation.runtimes.Values) + @($installation.entries.Values)) {
            if ($value -isnot [string] -or -not [IO.Path]::IsPathFullyQualified($value)) { throw 'Every installation input must be an absolute owned path.' }
            $null = Assert-E2eLocalPath $value
        }
        $python = Assert-E2eLocalPath $installation.python
        $node = Assert-E2eLocalPath $installation.node
        $hermesSource = Assert-E2eLocalPath $installation.hermesSource
        $yamlLibrary = Assert-E2eLocalPath $installation.hermesSitePackages
        $builtinSource = Assert-E2eLocalPath $installation.zcodeBuiltin
        $runtimePaths = $installation.runtimes
        $entryPaths = $installation.entries
        if ($runtimePaths.hermes -ine $python -or $runtimePaths.zcode -ine $node -or $runtimePaths.deepseek_harness -ine $node) { throw 'Official interpreted client entries must use the bound Python and Node hosts.' }
    }
    $runtimes = @{}
    $shared = @{}
    foreach ($id in $runtimePaths.Keys) {
        $file = Assert-E2eLocalPath $(if ([IO.Path]::IsPathFullyQualified($runtimePaths[$id])) { $runtimePaths[$id] } else { Join-Path $e2eWorkspace $runtimePaths[$id] })
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "The official $id test runtime is missing." }
        $runtimes[$id] = $file
        $shared[$file] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    foreach ($relative in @('.tools/git/bin/bash.exe', '.tools/git/usr/bin/bash.exe', '.tools/git/cmd/git.exe', '.tools/git/bin/git.exe', '.tools/git/mingw64/bin/git.exe', '.tools/pwsh/pwsh.exe', '.tools/agents/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/codex-path/rg.exe')) {
        $file = Assert-E2eLocalPath (Join-Path $e2eWorkspace $relative)
        if (Test-Path -LiteralPath $file -PathType Leaf) { $shared[$file] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
    $entries = @{}
    foreach ($id in $entryPaths.Keys) { $entries[$id] = Assert-E2eLocalPath $entryPaths[$id] }
    $builtinSource = Assert-E2eLocalPath $builtinSource
    foreach ($file in @($entries.Values) + @($builtinSource, $python, $node, (Join-Path $hermesSource 'hermes_cli/main.py'), (Join-Path $yamlLibrary 'ruamel/yaml/__init__.py'))) {
        $file = Assert-E2eLocalPath $file
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'An official client entry or independent readback parser is missing.' }
        $shared[$file] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $codexSearch = Assert-E2eLocalPath (Join-Path (Split-Path -Parent (Split-Path -Parent $runtimes.codex)) 'codex-path/rg.exe')
    if (Test-Path -LiteralPath $codexSearch -PathType Leaf) { $shared[$codexSearch] = (Get-FileHash -LiteralPath $codexSearch -Algorithm SHA256).Hash.ToLowerInvariant() }
    foreach ($directory in @($root, $clientHome, $workspace, $bin, $launchProofDirectory, (Join-Path $clientHome 'AppData/Roaming'), (Join-Path $clientHome 'AppData/Local'), (Join-Path $root 'tmp'), (Join-Path $clientHome '.config'), (Join-Path $clientHome '.local/share'), (Join-Path $clientHome '.local/state'), (Join-Path $clientHome '.cache'))) {
        $null = Assert-E2eLocalPath $directory
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    $directories = @{
        claude_code = Join-Path $clientHome '.claude'
        codex = Join-Path $clientHome '.codex'
        hermes = Join-Path $clientHome '.hermes'
        oh_my_pi = Join-Path $clientHome '.omp/agent'
        opencode = Join-Path $clientHome '.config/opencode'
        zcode = Join-Path $clientHome '.zcode/v2'
        workbuddy = Join-Path $clientHome '.workbuddy'
        deepseek_harness = Join-Path $clientHome '.dsh/profiles/user-existing'
    }
    $environment = @{
        HOME = $clientHome; USERPROFILE = $clientHome
        APPDATA = Join-Path $clientHome 'AppData/Roaming'; LOCALAPPDATA = Join-Path $clientHome 'AppData/Local'
        TEMP = Join-Path $root 'tmp'; TMP = Join-Path $root 'tmp'; TMPDIR = Join-Path $root 'tmp'
        XDG_CONFIG_HOME = Join-Path $clientHome '.config'; XDG_DATA_HOME = Join-Path $clientHome '.local/share'
        XDG_STATE_HOME = Join-Path $clientHome '.local/state'; XDG_CACHE_HOME = Join-Path $clientHome '.cache'
        CODEX_HOME = $directories.codex; CLAUDE_CONFIG_DIR = $directories.claude_code; HERMES_HOME = $directories.hermes
        WORKBUDDY_CONFIG_DIR = $directories.workbuddy; DSH_HOME = Join-Path $clientHome '.dsh'
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = Join-Path $directories.zcode 'provider_config.json'
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = Join-Path $directories.zcode 'builtin-providers.json'
        PATH = (@($bin, (Split-Path -Parent $node), (Split-Path -Parent $python), (Join-Path $e2eWorkspace '.tools/git/cmd'), (Join-Path $e2eWorkspace '.tools/git/bin'), (Join-Path $e2eWorkspace '.tools/pwsh')) -join ';')
        PATHEXT = '.COM;.EXE;.BAT;.CMD;.PS1'
    }
    if ($UseNativeCodexEntry) {
        $environment.PATH = (Split-Path -Parent $runtimes.codex) + ';' + $environment.PATH
    }
    $profiles = @{}
    $discoveredProfiles = @{}
    $preserved = [Collections.Generic.List[object]]::new()
    if ($installationBinding) {
        if ((Get-FileHash -LiteralPath (Assert-E2eLocalPath $installationBinding.path) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $installationBinding.sha256) { throw 'The installations manifest changed while preparing fixtures.' }
        $preserved.Add($installationBinding)
    }
    $encoding = [Text.UTF8Encoding]::new($false)
    $shimEncoding = [Text.UTF8Encoding]::new($true)
    foreach ($id in $directories.Keys) {
        $directory = Assert-E2eLocalPath $directories[$id]
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
        $entryName = switch ($id) { 'claude_code' { 'claude' }; 'oh_my_pi' { 'omp' }; 'deepseek_harness' { 'dsh' }; 'workbuddy' { 'WorkBuddy' }; default { $id } }
        $shim = Join-Path $bin ($entryName + '.ps1')
        $literalRuntime = "'" + $runtimes[$id].Replace("'", "''") + "'"
        $lines = [Collections.Generic.List[string]]::new()
        # @args preserves original CLI arguments without shell interpolation.
        $lines.Add('# Owned test installation entry: dispatch only, no model or credential injection.')
        $lines.Add('$ErrorActionPreference = ''Stop''')
        if ($id -cne 'deepseek_harness') { $lines.Add((New-E2eNativeLaunchWaitScript $id $launchProofDirectory $e2eIdentifier)) }
        if ($id -eq 'hermes') {
            $pythonPath = @($hermesSource, $yamlLibrary, (Join-Path $yamlLibrary 'win32'), (Join-Path $yamlLibrary 'win32/lib'), (Join-Path $yamlLibrary 'Pythonwin')) -join ';'
            $lines.Add('$env:PYTHONPATH = ' + "'" + $pythonPath.Replace("'", "''") + "'")
            $lines.Add('$env:HERMES_SKIP_VENV = ''1''')
            $lines.Add('$env:PYTHONDONTWRITEBYTECODE = ''1''')
            $lines.Add('$env:PYTHONUTF8 = ''1''')
            $lines.Add('& ' + $literalRuntime + ' -m hermes_cli.main @args')
        } elseif ($id -eq 'workbuddy') {
            $lines.Add('$env:ELECTRON_RUN_AS_NODE = ''1''')
            $lines.Add('$env:CODEBUDDY_FORCE_LITE_WB_BUNDLE = ''1''')
            $lines.Add('& ' + $literalRuntime + " '" + $entries[$id].Replace("'", "''") + "' @args")
        } elseif ($id -in @('zcode', 'deepseek_harness')) {
            $lines.Add('& ' + $literalRuntime + " '" + $entries[$id].Replace("'", "''") + "' @args")
        } else {
            if ($id -eq 'claude_code') { $lines.Add('$env:CLAUDE_CODE_GIT_BASH_PATH = ' + "'" + (Join-Path $e2eWorkspace '.tools/git/bin/bash.exe').Replace("'", "''") + "'") }
            if ($id -eq 'codex') { $lines.Add('$env:PATH = ' + "'" + (Join-Path (Split-Path -Parent (Split-Path -Parent $runtimes[$id])) 'codex-path').Replace("'", "''") + ";' + `$env:PATH") }
            $lines.Add('& ' + $literalRuntime + ' @args')
        }
        $lines.Add('exit $LASTEXITCODE')
        $profileEntry = $shim
        if ($UseNativeCodexEntry -and $id -ceq 'codex') {
            $profileEntry = $runtimes.codex
        } else {
            [IO.File]::WriteAllText($shim, ($lines -join "`r`n") + "`r`n", $shimEncoding)
        }
        $profile = @{
            directory = $directory; homeDirectory = $clientHome; executablePath = $profileEntry; workspaceDirectory = $workspace
            dataDirectory = $null; xdgConfigDirectory = $environment.XDG_CONFIG_HOME; xdgDataDirectory = $environment.XDG_DATA_HOME
            xdgStateDirectory = $environment.XDG_STATE_HOME; xdgCacheDirectory = $environment.XDG_CACHE_HOME
            profileName = $null; configFile = $null; secondaryConfigFile = $null; builtinConfigFile = $null; stateFile = $null
        }
        if ($id -eq 'zcode') {
            $profile.configFile = $environment.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE
            $profile.builtinConfigFile = $environment.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE
            $profile.dataDirectory = Join-Path $clientHome '.zcode'
            Copy-Item -LiteralPath $builtinSource -Destination $profile.builtinConfigFile
        } elseif ($id -eq 'deepseek_harness') {
            $profile.dataDirectory = $environment.DSH_HOME
            $profile.profileName = 'user-existing'
            $package = @{ name = 'ae-owned-existing-profile'; private = $true; type = 'module'; dsh = @{ profile = @{ bundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless') } } }
            $packageFile = Join-Path $directory 'package.json'
            [IO.File]::WriteAllText($packageFile, ($package | ConvertTo-Json -Depth 10), $encoding)
            $preserved.Add(@{ path = $packageFile; sha256 = (Get-FileHash -LiteralPath $packageFile -Algorithm SHA256).Hash.ToLowerInvariant() })
        }
        foreach ($key in @($profile.Keys)) { if ($null -eq $profile[$key]) { $profile.Remove($key) } }
        $discoveredProfiles[$id] = $profile.Clone()
        if ($id -eq 'zcode') { $profile.stateFile = Join-Path $clientHome '.zcode/native-storage/v2/agents-state.json' }
        $profiles[$id] = $profile
        foreach ($filename in @('user-history.keep', 'user-preferences.keep')) {
            $sentinel = Join-Path $directory $filename
            [IO.File]::WriteAllText($sentinel, "$id original user data $e2eIdentifier", $encoding)
            $preserved.Add(@{ path = $sentinel; sha256 = (Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash.ToLowerInvariant() })
        }
    }
    # Exercise actual ZCode storage.dir resolution without editing this preference.
    $zcodeConfig = Join-Path $clientHome '.zcode/cli/config.json'
    $null = New-Item -ItemType Directory -Path (Split-Path -Parent $zcodeConfig) -Force
    [IO.File]::WriteAllText($zcodeConfig, (@{ storage = @{ dir = Join-Path $clientHome '.zcode/native-storage' }; userPreference = 'keep' } | ConvertTo-Json -Depth 5), $encoding)
    $preserved.Add(@{ path = $zcodeConfig; sha256 = (Get-FileHash -LiteralPath $zcodeConfig -Algorithm SHA256).Hash.ToLowerInvariant() })
    $state = $profiles.zcode.stateFile
    $null = New-Item -ItemType Directory -Path (Split-Path -Parent $state) -Force
    [IO.File]::WriteAllText($state, '{"disabledAgentIds":["user-disabled"],"builtInModelSelectionOverrides":{"Explore":{"providerId":"original","modelId":"original","options":{"reasoningLevel":"disabled"}}},"userPreference":"keep"}', $encoding)
    $payload = @{ portableRoot = Get-E2ePortableInstallationRoot; profiles = $profiles; discoveredProfiles = $discoveredProfiles; preservedFiles = @($preserved.ToArray()); pythonDirectory = Split-Path -Parent $python; yamlLibraryDirectory = $yamlLibrary; launchProofDirectory = $launchProofDirectory; nativeCodexEntry = [bool]$UseNativeCodexEntry }
    $payloadFile = Join-Path $root 'existing-profiles.json'
    $contextFile = Join-Path $root 'discovery-context.json'
    $payload.discoveryContextFile = $contextFile
    [IO.File]::WriteAllText($payloadFile, ($payload | ConvertTo-Json -Depth 20), $encoding)
    [IO.File]::WriteAllText($contextFile, (@{ environment = $environment; homeDirectory = $clientHome; workspaceDirectory = $workspace } | ConvertTo-Json -Depth 10), $encoding)
    return @{ payload = $payload; payloadFile = $payloadFile; contextFile = $contextFile; environment = $environment; sharedRuntimeFiles = $shared }
}

function Restore-E2eNativeUpdateEnvironment {
    foreach ($name in $e2eNativeUpdateEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $e2eNativeUpdateEnvironment[$name], [EnvironmentVariableTarget]::Process)
    }
}

function Restore-E2eNativeGatewayEnvironment {
    foreach ($name in $e2eNativeGatewayEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $e2eNativeGatewayEnvironment[$name], [EnvironmentVariableTarget]::Process)
    }
}

function Initialize-E2eGatewayFixture {
    if ('AEGatewayStartupFixture' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
public sealed class AEGatewayStartupFixture {
    private readonly TcpListener listener;
    private readonly Thread thread;
    private readonly string fixtureId;
    private readonly string controlToken;
    private readonly int ownerPid;
    private readonly object gate = new object();
    private volatile bool stopping;
    public int Port { get; private set; }
    public bool Released { get; private set; }
    public bool ThreadJoined { get; private set; }
    public string Fault { get; private set; }
    private AEGatewayStartupFixture(string id, string token, int pid) {
        if (!System.Text.RegularExpressions.Regex.IsMatch(id, "^[a-f0-9]{32}$") || !System.Text.RegularExpressions.Regex.IsMatch(token, "^[a-f0-9]{64}$") || pid <= 0) throw new ArgumentException("Invalid owned gateway fixture identity.");
        fixtureId = id; controlToken = token; ownerPid = pid;
        listener = new TcpListener(IPAddress.Loopback, 0);
        listener.ExclusiveAddressUse = true;
        listener.Start();
        Port = ((IPEndPoint)listener.LocalEndpoint).Port;
        thread = new Thread(Serve); thread.IsBackground = true; thread.Name = "AE-owned-gateway-fixture";
        try { thread.Start(); } catch { listener.Stop(); throw; }
    }
    public static AEGatewayStartupFixture Start(string id, string token, int pid) { return new AEGatewayStartupFixture(id, token, pid); }
    private bool TokenMatches(string supplied) {
        if (supplied == null || supplied.Length != controlToken.Length) return false;
        int difference = 0;
        for (int index = 0; index < controlToken.Length; index++) difference |= supplied[index] ^ controlToken[index];
        return difference == 0;
    }
    private void Respond(NetworkStream stream, int status, string body) {
        byte[] content = Encoding.UTF8.GetBytes(body);
        byte[] header = Encoding.ASCII.GetBytes("HTTP/1.1 " + status + " " + (status == 200 ? "OK" : status == 401 ? "Unauthorized" : "Service Unavailable") + "\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: " + content.Length + "\r\n\r\n");
        stream.WriteTimeout = 1500;
        stream.Write(header, 0, header.Length); stream.Write(content, 0, content.Length);
        // Content-Length lets our bounded no-keepalive callers close first.
        // Observe their EOF before disposing the accepted socket, so fixture
        // responses do not leave the exclusive server port in TIME_WAIT.
        DateTime closeDeadline = DateTime.UtcNow.AddSeconds(1);
        while (DateTime.UtcNow < closeDeadline) {
            stream.ReadTimeout = Math.Max(1, (int)(closeDeadline - DateTime.UtcNow).TotalMilliseconds);
            if (stream.ReadByte() < 0) break;
        }
    }
    private void ServeClient(TcpClient client) {
        IPEndPoint remote = client.Client.RemoteEndPoint as IPEndPoint;
        if (remote == null || !IPAddress.IsLoopback(remote.Address)) return;
        using (NetworkStream stream = client.GetStream()) {
            StringBuilder text = new StringBuilder();
            DateTime deadline = DateTime.UtcNow.AddSeconds(2);
            while (text.Length < 8192) {
                int remaining = (int)(deadline - DateTime.UtcNow).TotalMilliseconds;
                if (remaining <= 0) return;
                stream.ReadTimeout = Math.Max(1, Math.Min(1500, remaining));
                int value = stream.ReadByte();
                if (value < 0) return;
                text.Append((char)value);
                if (text.Length >= 4 && text.ToString(text.Length - 4, 4) == "\r\n\r\n") break;
            }
            if (text.Length >= 8192) return;
            string[] lines = text.ToString().Split(new string[] { "\r\n" }, StringSplitOptions.None);
            string[] request = lines[0].Split(' ');
            Dictionary<string, string> headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (int index = 1; index < lines.Length && lines[index].Length > 0; index++) {
                int colon = lines[index].IndexOf(':');
                if (colon <= 0) return;
                string name = lines[index].Substring(0, colon).Trim();
                if (headers.ContainsKey(name)) return;
                headers[name] = lines[index].Substring(colon + 1).Trim();
            }
            bool release = request.Length == 3 && request[0] == "POST" && request[1] == "/__ae_native_gateway_fixture/" + fixtureId + "/release";
            if (release) {
                string supplied;
                headers.TryGetValue("X-AE-Native-Fixture-Control", out supplied);
                if (headers.ContainsKey("Origin") || !TokenMatches(supplied)) { Respond(stream, 401, "{\"error\":\"fixture_control_required\"}"); return; }
                lock (gate) { Released = true; stopping = true; listener.Stop(); }
                Respond(stream, 200, "{\"fixtureId\":\"" + fixtureId + "\",\"ownerPid\":" + ownerPid + ",\"released\":true,\"controlTokenValidated\":true}");
            } else { Respond(stream, 503, "{\"error\":\"owned_gateway_startup_fixture\"}"); }
        }
    }
    private void Serve() {
        while (!stopping) {
            try { using (TcpClient client = listener.AcceptTcpClient()) { ServeClient(client); } }
            catch (SocketException) { if (!stopping) Fault = "Owned fixture socket operation failed."; }
            catch (ObjectDisposedException) { if (!stopping) Fault = "Owned fixture listener was unexpectedly disposed."; }
            catch (IOException) { /* A bounded caller may disconnect or time out. */ }
            catch { Fault = "Owned fixture request failed."; }
        }
    }
    public void StopAndJoin() {
        lock (gate) { stopping = true; listener.Stop(); }
        ThreadJoined = thread.Join(5000);
        if (!ThreadJoined) throw new InvalidOperationException("The owned gateway fixture thread did not stop within its bound.");
    }
}
'@
}

function Assert-E2eLocalPath([string]$Location) {
    $absolute = [IO.Path]::GetFullPath($Location)
    if (-not $absolute.StartsWith($e2eWorkspace + '\', [StringComparison]::OrdinalIgnoreCase) -or $absolute -match '^[Cc]:[\\/]') {
        throw "E2E paths must stay inside the current workspace: $absolute"
    }
    $ancestor = $absolute
    while ($ancestor.Length -ge $e2eWorkspace.Length) {
        try {
            if ([IO.File]::GetAttributes($ancestor) -band [IO.FileAttributes]::ReparsePoint) {
                throw "E2E path must not use a junction or symbolic link: $ancestor"
            }
        } catch [IO.FileNotFoundException] {
            # A not-yet-created path is allowed; its existing ancestors are checked.
        } catch [IO.DirectoryNotFoundException] {
            # Continue through a missing child to validate the existing parent.
        } catch { throw }
        if ($ancestor -eq $e2eWorkspace) { break }
        $ancestor = [IO.Path]::GetDirectoryName($ancestor)
    }
    $absolute
}

function Test-E2eCleanupSharingViolation([Exception]$Failure) {
    for ($cause = $Failure; $cause; $cause = $cause.InnerException) {
        if ($cause -is [IO.IOException] -and
            $cause.HResult -in @(-2147024864, -2147024863)) { return $true }
    }
    return $false
}

function Assert-E2eNativeCleanupRetryScope([string]$Location, [string]$File) {
    if (-not $NativeUi -or ([IO.Path]::GetFullPath($Location)) -ine ([IO.Path]::GetFullPath($e2eSandbox))) {
        throw 'Sharing retries require the exact owned native UUID tree.'
    }
    Assert-E2eNativeOwner
    Initialize-E2eNativeProcessInterop
    Assert-E2eNativeProcessesExited
    # The one allowed cache junction has already been unlinked before file
    # deletion starts. Any new reparse entry must stop this retry without traversal.
    $null = Assert-E2eLocalPath $Location
    $null = [AEE2eNativeProcess]::OrdinaryTreeEntries($Location, $e2eWorkspace)
    $filePath = Assert-E2eLocalPath $File
    if ($filePath -ieq $e2eMarker -or -not $filePath.StartsWith($Location + '\', [StringComparison]::OrdinalIgnoreCase) -or
        (Get-Item -LiteralPath $filePath -Force -ErrorAction Stop).PSIsContainer) {
        throw 'A native cleanup retry requires an ordinary owned data file.'
    }
}

function Remove-E2eOwnedLockedFile([string]$Location, [string]$File, [Diagnostics.Stopwatch]$Timer,
    [int]$TimeoutMs, [ref]$RetryCount) {
    Assert-E2eNativeCleanupRetryScope $Location $File
    while ($true) {
        $remaining = $TimeoutMs - $Timer.ElapsedMilliseconds
        if ($remaining -le 0) { throw [TimeoutException]::new('The bounded owned-file sharing retry deadline expired; sandbox retained.') }
        Start-Sleep -Milliseconds ([int][Math]::Min(500, $remaining))
        Assert-E2eNativeCleanupRetryScope $Location $File
        if ($Timer.ElapsedMilliseconds -ge $TimeoutMs) { throw [TimeoutException]::new('The bounded owned-file sharing retry deadline expired; sandbox retained.') }
        $RetryCount.Value++
        try { Remove-Item -LiteralPath $File -Force -ErrorAction Stop; return }
        catch { if (-not (Test-E2eCleanupSharingViolation $_.Exception)) { throw } }
    }
}

function Test-E2eCleanupDirectoryNotEmpty([Exception]$Failure) {
    for ($cause=$Failure; $cause; $cause=$cause.InnerException) {
        if ($cause -is [IO.IOException] -and $cause.HResult -eq -2147024751) { return $true } # Win32 145 only.
    }
    return $false
}

function Wait-E2eOwnedDirectoryRetry([string]$Location, [Diagnostics.Stopwatch]$Timer, [int]$TimeoutMs) {
    if (-not $NativeUi -or ([IO.Path]::GetFullPath($Location)) -ine ([IO.Path]::GetFullPath($e2eSandbox))) {
        throw 'Directory retries require the exact owned native UUID tree.'
    }
    # First-pass allowed cache junctions have already been removed. Never allow
    # a new alias, changed owner or live root reference through the retry.
    for ($phase=0; $phase -lt 2; $phase++) {
        Assert-E2eNativeOwner
        Initialize-E2eNativeProcessInterop
        Assert-E2eNativeProcessesExited
        $null=Assert-E2eLocalPath $Location
        $null=[AEE2eNativeProcess]::OrdinaryTreeEntries($Location,$e2eWorkspace)
        $remaining=$TimeoutMs-$Timer.ElapsedMilliseconds
        if ($remaining -le 0) { throw [TimeoutException]::new('The aggregate owned-directory retry deadline expired; owner marker retained.') }
        if ($phase -eq 0) { Start-Sleep -Milliseconds ([int][Math]::Min(100,$remaining)) }
    }
}

function Remove-E2eOwnedTree([string]$Location, [ValidateRange(0, 180000)][int]$LockRetryTimeoutMs = 180000) {
    $cleanupTimer = [Diagnostics.Stopwatch]::StartNew()
    $sharingRetryCount = 0
    $directoryRetryCount = 0
    try {
    while ($true) {
    # Inspect the entire tree before deleting anything. Enumerate each ordinary
    # directory directly so junctions are never traversed, including on PS 5.1.
    $pending = [Collections.Generic.Stack[string]]::new()
    $directories = [Collections.Generic.List[string]]::new()
    $files = [Collections.Generic.List[string]]::new()
    $nativeCacheLinks = [Collections.Generic.List[string]]::new()
    $pending.Push($Location)
    while ($pending.Count -gt 0) {
        $current = Assert-E2eLocalPath $pending.Pop()
        $directories.Add($current)
        foreach ($entry in Get-ChildItem -LiteralPath $current -Force -ErrorAction Stop) {
            if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                # Windows' native WebView creates this legacy cache junction.
                # Accept only this exact owned internal alias, never traverse it.
                $cacheAlias = Join-Path $Location 'portable/data/home/AppData/Local/Microsoft/Windows/INetCache/Content.IE5'
                $cacheTarget = Join-Path $Location 'portable/data/home/AppData/Local/Microsoft/Windows/INetCache/IE'
                $null = Assert-E2eLocalPath $current
                if (-not $NativeUi -or $entry.FullName -ne $cacheAlias -or $entry.LinkType -ne 'Junction' -or @($entry.Target).Count -ne 1 -or @($entry.Target)[0] -notmatch '^[A-Za-z]:[\\/]' -or [IO.Path]::GetFullPath(@($entry.Target)[0]) -ne [IO.Path]::GetFullPath($cacheTarget)) { throw 'Owned sandbox cleanup refuses an unexpected reparse point.' }
                $null = Assert-E2eLocalPath $cacheTarget
                if (-not (Test-Path -LiteralPath $cacheTarget -PathType Container)) { throw 'The native cache alias target must be an ordinary owned directory.' }
                $nativeCacheLinks.Add($entry.FullName)
                continue
            }
            $entryPath = Assert-E2eLocalPath $entry.FullName
            if (-not $entryPath.StartsWith($Location + '\', [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Owned sandbox cleanup encountered a path outside its tree.'
            }
            if ($entry.PSIsContainer) { $pending.Push($entryPath) }
            elseif ($entryPath -ne $e2eMarker) { $files.Add($entryPath) }
        }
    }
    foreach ($cacheLink in $nativeCacheLinks) {
        $null = Assert-E2eLocalPath ([IO.Path]::GetDirectoryName($cacheLink))
        $null = Assert-E2eLocalPath (Join-Path $Location 'portable/data/home/AppData/Local/Microsoft/Windows/INetCache/IE')
        $cacheMetadata = Get-Item -LiteralPath $cacheLink -Force
        if (-not $cacheMetadata.PSIsContainer -or -not ($cacheMetadata.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $cacheMetadata.LinkType -ne 'Junction' -or @($cacheMetadata.Target).Count -ne 1 -or @($cacheMetadata.Target)[0] -notmatch '^[A-Za-z]:[\\/]' -or [IO.Path]::GetFullPath(@($cacheMetadata.Target)[0]) -ne [IO.Path]::GetFullPath((Join-Path $Location 'portable/data/home/AppData/Local/Microsoft/Windows/INetCache/IE'))) { throw 'The owned cache junction changed before removal.' }
        # Nonrecursive deletion removes only the junction, not its target.
        [IO.Directory]::Delete($cacheLink, $false)
    }
    foreach ($file in $files) {
        $null = Assert-E2eLocalPath $file
        if ((Get-Item -LiteralPath $file -Force).PSIsContainer) { throw 'An owned cleanup file changed into a directory.' }
        try { Remove-Item -LiteralPath $file -Force -ErrorAction Stop }
        catch {
            if (-not (Test-E2eCleanupSharingViolation $_.Exception)) { throw }
            Remove-E2eOwnedLockedFile $Location $file $cleanupTimer $LockRetryTimeoutMs ([ref]$sharingRetryCount)
        }
    }
    $restartAudit=$false
    for ($index = $directories.Count - 1; $index -gt 0; $index--) {
        $null = Assert-E2eLocalPath $directories[$index]
        try { [IO.Directory]::Delete($directories[$index], $false) }
        catch {
            if (-not (Test-E2eCleanupDirectoryNotEmpty $_.Exception)) { throw }
            Wait-E2eOwnedDirectoryRetry $Location $cleanupTimer $LockRetryTimeoutMs
            $directoryRetryCount++; $restartAudit=$true; break
        }
    }
    if ($restartAudit) { continue }
    $null=Assert-E2eLocalPath $Location
    $rootEntries=@(Get-ChildItem -LiteralPath $Location -Force -ErrorAction Stop)
    if ($rootEntries.Count -ne 1 -or $rootEntries[0].FullName -ine $e2eMarker) {
        Wait-E2eOwnedDirectoryRetry $Location $cleanupTimer $LockRetryTimeoutMs
        $directoryRetryCount++; continue
    }
    # Preserve original owner bytes until every currently observed data entry is gone.
    if ($NativeUi) { Assert-E2eNativeOwner }
    $null = Assert-E2eLocalPath $e2eMarker
    Remove-Item -LiteralPath $e2eMarker -Force
    $null = Assert-E2eLocalPath $Location
    # Nonrecursive final removal still fails closed on an entry created after marker removal.
    [IO.Directory]::Delete($Location, $false)
    break
    }
    } catch {
        # Record held files without stopping an unproved external process.
        $cleanupError = $_
        $cleanupOwnerVerified = $true
        if ($NativeUi) {
            try { Assert-E2eNativeOwner }
            catch { $cleanupOwnerVerified = $false }
        }
        if (Test-Path -LiteralPath $e2eReport -PathType Leaf) {
            $cleanupFailure = [IO.File]::ReadAllText($e2eReport) | ConvertFrom-Json
            if ($cleanupFailure.sandbox -eq $Location) {
                $cleanupFailure.cleanup = @{
                    removed = $false; ownerMarkerVerified = $cleanupOwnerVerified
                    installationAndRuntimeDataRemoved = $false
                    failure = $cleanupError.Exception.Message; unprovedExternalProcessStopped = $false
                    sharingViolationRetryTimeoutMs = $LockRetryTimeoutMs
                    sharingViolationRetryCount = $sharingRetryCount
                    directoryNotEmptyRetryCount = $directoryRetryCount
                }
                $cleanupFailure.passed = $false
                [IO.File]::WriteAllText($e2eReport, ($cleanupFailure | ConvertTo-Json -Depth 60), $e2eUtf8)
            }
        }
        throw
    }
}

function Initialize-E2eNativeProcessInterop {
    if ('AEE2eNativeProcess' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
public static class AEE2eNativeProcess {
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct ProcessEntry {
        public uint size, usage, processId; public UIntPtr defaultHeap; public uint moduleId, threads, parentId;
        public int priority; public uint flags; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string image;
    }
    [StructLayout(LayoutKind.Sequential)] struct BasicInformation {
        public IntPtr reserved1, peb, reserved2a, reserved2b, processId, parentId;
    }
    [StructLayout(LayoutKind.Sequential)] struct UnicodeString { public ushort length, maximumLength; public IntPtr buffer; }
    public sealed class Candidate { public int ProcessId; public int ParentProcessId; public string Name; }
    public sealed class LiveDetails { public int ParentProcessId; public string CommandLine; }
    private static void OrdinaryAncestors(string entry,string boundary) {
        for(string cursor=entry;cursor!=null && cursor.Length>=boundary.Length;cursor=Path.GetDirectoryName(cursor)) {
            var attributes=File.GetAttributes(cursor);
            if((attributes&FileAttributes.ReparsePoint)!=0 || (cursor!=entry && (attributes&FileAttributes.Directory)==0))
                throw new InvalidOperationException("Native cleanup entry or ancestor changed or is redirected.");
            if(string.Equals(cursor,boundary,StringComparison.OrdinalIgnoreCase)) return;
        }
        throw new InvalidOperationException("Native cleanup ancestors escaped the workspace boundary.");
    }
    public static int OrdinaryTreeEntries(string root,string workspace) {
        root=Path.GetFullPath(root); workspace=Path.GetFullPath(workspace);
        if(root.Length<4 || root[1]!=':' || root[2]!='\\') throw new ArgumentException("An absolute owned tree is required.");
        if(!root.StartsWith(workspace.TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("An exact workspace child is required.");
        string prefix=root.TrimEnd('\\')+"\\";
        var pending=new Stack<string>(); pending.Push(root); int count=0;
        while(pending.Count>0) {
            string directory=pending.Pop();
            OrdinaryAncestors(directory,workspace);
            var directoryAttributes=File.GetAttributes(directory);
            if((directoryAttributes&FileAttributes.ReparsePoint)!=0 || (directoryAttributes&FileAttributes.Directory)==0)
                throw new InvalidOperationException("Native cleanup directory changed or is redirected.");
            foreach(string entry in Directory.EnumerateFileSystemEntries(directory)) {
                if(++count>1000000) throw new InvalidOperationException("Native cleanup tree exceeds its bound.");
                string full=Path.GetFullPath(entry);
                if(!full.StartsWith(prefix,StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Native cleanup entry escaped its owned tree.");
                OrdinaryAncestors(full,workspace);
                var attributes=File.GetAttributes(full);
                if((attributes&FileAttributes.ReparsePoint)!=0) throw new InvalidOperationException("A native cleanup retry refuses a new reparse entry.");
                if((attributes&FileAttributes.Directory)!=0) pending.Push(full);
            }
        }
        return count;
    }
    [DllImport("kernel32.dll",ExactSpelling=true,SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint processId);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] static extern bool Process32FirstW(IntPtr snapshot,ref ProcessEntry entry);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] static extern bool Process32NextW(IntPtr snapshot,ref ProcessEntry entry);
    [DllImport("kernel32.dll",ExactSpelling=true,SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("ntdll.dll",ExactSpelling=true)] static extern int NtQueryInformationProcess(IntPtr process,int information,IntPtr buffer,int length,out int returned);
    [DllImport("ntdll.dll",ExactSpelling=true)] static extern uint RtlNtStatusToDosError(int status);
    [DllImport("kernel32.dll", EntryPoint="QueryFullProcessImageNameW", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
    [return:MarshalAs(UnmanagedType.Bool)] static extern bool QueryImage(IntPtr handle, uint flags, StringBuilder path, ref uint size);
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] static extern IntPtr CommandLineToArgvW(string commandLine, out int count);
    [DllImport("kernel32.dll", ExactSpelling=true)] static extern IntPtr LocalFree(IntPtr memory);
    public static Candidate[] Snapshot() {
        var snapshot=CreateToolhelp32Snapshot(2,0);
        if(snapshot==new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            var result=new List<Candidate>(); var entry=new ProcessEntry(); entry.size=(uint)Marshal.SizeOf(typeof(ProcessEntry));
            bool found=Process32FirstW(snapshot,ref entry);
            if(!found && Marshal.GetLastWin32Error()!=18) throw new Win32Exception(Marshal.GetLastWin32Error());
            while(found) {
                if(result.Count>=32768) throw new InvalidOperationException("Process candidate snapshot exceeds its bound.");
                if(entry.processId>0 && entry.processId<=int.MaxValue && entry.parentId<=int.MaxValue)
                    result.Add(new Candidate { ProcessId=(int)entry.processId, ParentProcessId=(int)entry.parentId, Name=entry.image });
                found=Process32NextW(snapshot,ref entry);
            }
            if(Marshal.GetLastWin32Error()!=18) throw new Win32Exception(Marshal.GetLastWin32Error());
            return result.ToArray();
        } finally { CloseHandle(snapshot); }
    }
    public static LiveDetails Details(IntPtr process) {
        if(process==IntPtr.Zero || process==new IntPtr(-1)) throw new ArgumentException("A retained actual process handle is required.");
        int returned; int basicSize=Marshal.SizeOf(typeof(BasicInformation)); var basicMemory=Marshal.AllocHGlobal(basicSize);
        long parent;
        try {
            int status=NtQueryInformationProcess(process,0,basicMemory,basicSize,out returned);
            if(status<0) throw new Win32Exception((int)RtlNtStatusToDosError(status));
            if(returned!=basicSize) throw new InvalidOperationException("Unexpected actual process identity size.");
            parent=Marshal.PtrToStructure<BasicInformation>(basicMemory).parentId.ToInt64();
            if(parent<0 || parent>int.MaxValue) throw new InvalidOperationException("Actual parent process identifier is invalid.");
        } finally { Marshal.FreeHGlobal(basicMemory); }
        int required; NtQueryInformationProcess(process,60,IntPtr.Zero,0,out required);
        if(required<Marshal.SizeOf(typeof(UnicodeString)) || required>131072) throw new InvalidOperationException("Actual process command line exceeds its bound.");
        var memory=Marshal.AllocHGlobal(required);
        try {
            int status=NtQueryInformationProcess(process,60,memory,required,out returned);
            if(status<0) throw new Win32Exception((int)RtlNtStatusToDosError(status));
            var value=Marshal.PtrToStructure<UnicodeString>(memory);
            long start=memory.ToInt64(), text=value.buffer.ToInt64();
            if(returned<Marshal.SizeOf(typeof(UnicodeString)) || returned>required || value.length%2!=0 || value.length>65534 || value.maximumLength<value.length || text<start || text+value.length>start+returned)
                throw new InvalidOperationException("Actual process command line buffer is invalid.");
            string command=Marshal.PtrToStringUni(value.buffer,value.length/2);
            if(string.IsNullOrWhiteSpace(command) || command.IndexOf('\0')>=0) throw new InvalidOperationException("Actual process command line is invalid.");
            return new LiveDetails { ParentProcessId=(int)parent, CommandLine=command };
        } finally { Marshal.FreeHGlobal(memory); }
    }
    public static string ProcessPath(IntPtr handle) {
        var path=new StringBuilder(32768); uint size=32768;
        if(!QueryImage(handle,0,path,ref size)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return path.ToString();
    }
    public static string[] Arguments(string commandLine) {
        if(string.IsNullOrWhiteSpace(commandLine) || commandLine.Length>32767 || commandLine.IndexOf('\0')>=0) throw new ArgumentException("A bounded Windows command line is required.");
        int count; var memory=CommandLineToArgvW(commandLine,out count);
        if(memory==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            if(count<1 || count>4096) throw new ArgumentException("Windows argument count exceeds its bound.");
            var result=new string[count];
            for(int i=0;i<count;i++) result[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory,i*IntPtr.Size));
            return result;
        } finally { LocalFree(memory); }
    }
}
'@
}

function Assert-E2eNativeOwner {
    $root = Assert-E2eLocalPath $e2eSandbox
    if ($e2eIdentifier -cnotmatch '^[a-f0-9]{32}$' -or [IO.Path]::GetDirectoryName($root) -ine [IO.Path]::GetFullPath($e2eBase) -or [IO.Path]::GetFileName($root) -cne $e2eIdentifier) { throw 'Native process ownership requires this exact UUID root.' }
    $null = Assert-E2eLocalPath $e2eMarker
    if (-not $e2eNativeMarkerHash -or (Get-FileHash -LiteralPath $e2eMarker -Algorithm SHA256).Hash.ToLowerInvariant() -cne $e2eNativeMarkerHash) { throw 'Native process ownership marker bytes changed.' }
    $owner = [IO.File]::ReadAllText($e2eMarker) | ConvertFrom-Json
    if ($owner.id -cne $e2eIdentifier -or $owner.workspace -ine $e2eWorkspace -or $owner.purpose -cne $e2ePurpose) { throw 'Native process ownership marker identity changed.' }
}

function Assert-E2eNativeOrdinaryFile([string]$Location) {
    if ($Location -notmatch '^[A-Za-z]:[\\/]') { throw 'Native executable paths must be absolute.' }
    $absolute = [IO.Path]::GetFullPath($Location)
    $cursor = $absolute
    while ($cursor) {
        $attributes = [IO.File]::GetAttributes($cursor)
        if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Native process paths must have ordinary ancestors.' }
        if ($cursor -eq $absolute -and ($attributes -band [IO.FileAttributes]::Directory)) { throw 'Native process executable must be an ordinary file.' }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
    return $absolute
}

function Get-E2eNativeProcessById([int]$ProcessId) { [Diagnostics.Process]::GetProcessById($ProcessId) }
function Get-E2eNativeProcessPath($Process) { [AEE2eNativeProcess]::ProcessPath($Process.Handle) }
function Get-E2eNativeProcessSnapshot { [AEE2eNativeProcess]::Snapshot() }
function Get-E2eNativeProcessDetails($Process) { [AEE2eNativeProcess]::Details($Process.Handle) }
function Test-E2eNativeCreationTime([datetime]$Actual, [datetime]$Observed) {
    # CIM timestamps have microsecond precision; compare at that resolution.
    $actualTicks = $Actual.ToUniversalTime().Ticks
    $observedTicks = $Observed.ToUniversalTime().Ticks
    return ($actualTicks - $actualTicks % 10) -eq ($observedTicks - $observedTicks % 10)
}

function Get-E2eNativeProcessScope([string]$ActualPath, [string]$CommandLine, $Parent) {
    Assert-E2eNativeOwner
    if ($ActualPath -notmatch '^[A-Za-z]:[\\/]') { return $null }
    $path = [IO.Path]::GetFullPath($ActualPath)
    if ($path.StartsWith($e2eSandbox + '\', [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetExtension($path) -ieq '.exe') {
        $null = Assert-E2eNativeOrdinaryFile $path
        return @{ kind = 'owned-executable'; launcher = '' }
    }
    if ($e2eSharedRuntimeFiles.ContainsKey($path)) {
        $null = Assert-E2eLocalPath $path
        $null = Assert-E2eNativeOrdinaryFile $path
        if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $e2eSharedRuntimeFiles[$path]) { return $null }
        return @{ kind = 'shared-official-runtime'; launcher = '' }
    }
    $system = [Environment]::GetFolderPath('System')
    $powershell = [IO.Path]::GetFullPath((Join-Path $system 'WindowsPowerShell/v1.0/powershell.exe'))
    $cmd = Join-Path $system 'cmd.exe'
    $conhost = Join-Path $system 'conhost.exe'
    if ($path -ine $powershell -and $path -ine $cmd -and $path -ine $conhost) { return $null }
    $null = Assert-E2eNativeOrdinaryFile $path
    $arguments = @([AEE2eNativeProcess]::Arguments($CommandLine))
    if ($arguments.Count -lt 2) { return $null }
    $argvExecutable = $arguments[0]
    if ($argvExecutable.StartsWith('\??\') -or $argvExecutable.StartsWith('\\?\')) {
        $argvExecutable = $argvExecutable.Substring(4)
        if ($argvExecutable -notmatch '^[A-Za-z]:[\\/]') { return $null }
    }
    if ($argvExecutable -match '^[A-Za-z]:[\\/]') {
        $argvExecutable = [IO.Path]::GetFullPath($argvExecutable)
    }
    if ($argvExecutable -ine $path -and $argvExecutable -ine [IO.Path]::GetFileName($path)) { return $null }
    if ($path -ieq $powershell) {
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        $fileIndex = -1
        for ($index = 1; $index -lt $arguments.Count; $index++) {
            $option = $arguments[$index]
            if ($option -ieq '-File') { $fileIndex = $index; break }
            if (-not $seen.Add($option)) { return $null }
            if ($option -ieq '-ExecutionPolicy') {
                $index++
                if ($index -ge $arguments.Count -or $arguments[$index] -ine 'Bypass') { return $null }
            } elseif ($option -inotmatch '^-(?:NoLogo|NoProfile|NoExit|NonInteractive)$') { return $null }
        }
        if ($fileIndex -lt 1 -or $fileIndex + 1 -ge $arguments.Count -or @($arguments | Where-Object { $_ -ieq '-File' }).Count -ne 1) { return $null }
        $scriptPath = $arguments[$fileIndex + 1]
        foreach ($agentId in @('claude_code','codex','hermes','oh_my_pi','opencode','zcode','workbuddy','deepseek_harness')) {
            if (-not $e2eInstalledClientFixtures) { continue }
            $expected = $e2eInstalledClientFixtures.payload.profiles[$agentId].executablePath
            if ($scriptPath -ieq $expected) {
                $null = Assert-E2eNativeOrdinaryFile $expected
                $tail = @($arguments | Select-Object -Skip ($fileIndex + 2))
                $nativeLaunch = if ($agentId -eq 'deepseek_harness') {
                    $tail.Count -eq 2 -and $tail[0] -ceq '--profile' -and $tail[1] -ceq $e2eInstalledClientFixtures.payload.profiles[$agentId].profileName
                } else { $tail.Count -eq 0 }
                return @{ kind = 'official-powershell-launcher'; launcher = $expected; nativeLaunch = $nativeLaunch }
            }
        }
        return $null
    }
    if ($path -ieq $cmd) {
        # CommandLineToArgvW is not cmd's language parser. Refuse its operators,
        # expansion and command concatenation before accepting a single script.
        if ($CommandLine -match '[&|<>^%!\r\n]') { return $null }
        $index = 1
        if ($arguments[$index] -ieq '/d') { $index++ }
        if ($index -lt $arguments.Count -and $arguments[$index] -ieq '/s') { $index++ }
        if ($index + 1 -ge $arguments.Count -or $arguments[$index] -ine '/c') { return $null }
        # cmd /s /c uses an outer quote pair around its command. Strip only
        # that pair, then parse the remaining single script and its arguments.
        if ($CommandLine -notmatch '(?i)^(?:"[^"]+"|\S+)\s+(?:(?:/d|/s)\s+){0,2}/c\s+(?<command>.+)$') { return $null }
        $commandText = $Matches.command.Trim()
        if ($commandText.StartsWith('""')) {
            if (-not $commandText.EndsWith('"')) { return $null }
            $commandText = $commandText.Substring(1, $commandText.Length - 2)
        }
        $commandArguments = @([AEE2eNativeProcess]::Arguments('cmd.exe ' + $commandText))
        if ($commandArguments.Count -lt 2) { return $null }
        $scriptPath = $commandArguments[1]
        if ($scriptPath -notmatch '^[A-Za-z]:[\\/]') { return $null }
        $scriptPath = [IO.Path]::GetFullPath($scriptPath)
        if (-not $scriptPath.StartsWith($e2eSandbox + '\', [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetExtension($scriptPath) -inotmatch '^\.(?:cmd|bat)$') { return $null }
        $null = Assert-E2eNativeOrdinaryFile $scriptPath
        return @{ kind = 'owned-command-shell'; launcher = $scriptPath }
    }
    if ($Parent.kind -notin @('official-powershell-launcher','owned-command-shell') -or $arguments.Count -notin @(2,3) -or $arguments[1] -notmatch '^0x[0-9a-fA-F]{1,16}$' -or ($arguments.Count -eq 3 -and $arguments[2] -ine '-ForceV1')) { return $null }
    return @{ kind = 'owned-console-host'; launcher = $Parent.launcher }
}

function New-E2eNativeProcessIdentity($Process, $Scope, [int]$ParentId = 0) {
    $null = $Process.Handle
    $path = Get-E2eNativeProcessPath $Process
    $null = Assert-E2eNativeOrdinaryFile $path
    return @{ process = $Process; started = $Process.StartTime.ToUniversalTime(); path = $path; sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant(); kind = $Scope.kind; launcher = $Scope.launcher; nativeLaunch = $Scope.nativeLaunch -eq $true; parentId = $ParentId }
}

function Assert-E2eNativeProcessIdentity($Identity, [switch]$VerifyHash) {
    Assert-E2eNativeOwner
    $Identity.process.Refresh()
    if ($Identity.process.HasExited -or $Identity.process.StartTime.ToUniversalTime().Ticks -ne $Identity.started.Ticks -or (Get-E2eNativeProcessPath $Identity.process) -ine $Identity.path) { throw 'Retained native handle, creation time or actual image changed.' }
    $null = Assert-E2eNativeOrdinaryFile $Identity.path
    if ($VerifyHash -and (Get-FileHash -LiteralPath $Identity.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Identity.sha256) { throw 'Retained native executable bytes changed.' }
}

function Add-E2eNativeChildDiagnostic($Child, [string]$Disposition, $Scope = $null) {
    $diagnosticKey = $e2eIdentifier + ':' + $Child.ProcessId + ':' + $Child.ParentProcessId + ':' + $Disposition
    if ($e2eQaProcess -and [int]$Child.ParentProcessId -eq $e2eQaProcess.Id) {
        if (-not (Get-Variable e2eNativeQaChildDiagnostics -Scope Script -ErrorAction SilentlyContinue)) {
            $script:e2eNativeQaChildDiagnostics = [Collections.Generic.List[object]]::new()
            $script:e2eNativeQaDiagnosticKeys = [Collections.Generic.HashSet[string]]::new()
            $script:e2eNativeQaDiagnosticsDropped = 0
        }
        if (-not $script:e2eNativeQaDiagnosticKeys.Contains($diagnosticKey)) {
            if ($script:e2eNativeQaChildDiagnostics.Count -lt 64) {
                $null = $script:e2eNativeQaDiagnosticKeys.Add($diagnosticKey)
                $agentId = $null
                if ($Scope -and $Scope.launcher -and $e2eInstalledClientFixtures) {
                    foreach ($id in @('claude_code','codex','hermes','oh_my_pi','opencode','zcode','workbuddy','deepseek_harness')) {
                        if ($Scope.launcher -ieq $e2eInstalledClientFixtures.payload.profiles[$id].executablePath) { $agentId = $id; break }
                    }
                }
                $script:e2eNativeQaChildDiagnostics.Add(@{
                    pid = [int]$Child.ProcessId; parentPid = [int]$Child.ParentProcessId; agentId = $agentId
                    recordedAt = [DateTime]::UtcNow.ToString('o'); disposition = $Disposition
                    owned = $Disposition -ceq 'retained-launcher-identity'; nativeLaunch = $Scope -and $Scope.nativeLaunch -eq $true
                    commandLineRecorded = $false
                })
            } else { $script:e2eNativeQaDiagnosticsDropped++ }
        }
    }
    if ($Disposition -ceq 'retained-launcher-identity') { return }
    if (-not (Get-Variable e2eNativeDiagnosticKeys -Scope Script -ErrorAction SilentlyContinue)) { $script:e2eNativeDiagnosticKeys = [Collections.Generic.HashSet[string]]::new() }
    if (-not $script:e2eNativeDiagnosticKeys.Add($diagnosticKey)) { return }
    if ($e2eNativeChildDiagnostics.Count -ge 64) { return }
    # Never retain raw command lines, external paths, credentials or profiles.
    $name = if ($Child.Name -in @('powershell.exe','cmd.exe','conhost.exe','SogouCloud.exe','msedgewebview2.exe')) { $Child.Name } else { 'other' }
    $e2eNativeChildDiagnostics.Add(@{ pid = [int]$Child.ProcessId; parentPid = [int]$Child.ParentProcessId; name = $name; disposition = $Disposition; owned = $false; commandLineRecorded = $false })
}

function Record-E2eNativeChildren {
    if (-not (Get-Variable e2eNativeObservationCalls -Scope Script -ErrorAction SilentlyContinue)) {
        $script:e2eNativeObservationCalls = 0; $script:e2eNativeObservationTotalMs = 0; $script:e2eNativeObservationMaxMs = 0
    }
    $observationTimer = [Diagnostics.Stopwatch]::StartNew()
    $qaCandidateHandles = @{}
    try {
    Initialize-E2eNativeProcessInterop
    Assert-E2eNativeOwner
    $launchContext = Get-E2eNativeLaunchRequest
    if ($launchContext) { Write-E2eNativeLaunchAcknowledgment $launchContext 'ready' }
    # The snapshot discovers candidates only. Actual parent, image, start time,
    # command line and scope still come from a retained live process handle.
    # One native snapshot avoids serial WMI calls for every previously seen parent.
    $processSnapshot = @(Get-E2eNativeProcessSnapshot)
    $childrenByParent = @{}
    foreach ($candidate in $processSnapshot) {
        $candidateParent = [int]$candidate.ParentProcessId
        if (-not $childrenByParent.ContainsKey($candidateParent)) { $childrenByParent[$candidateParent] = [Collections.Generic.List[object]]::new() }
        $childrenByParent[$candidateParent].Add($candidate)
    }
    $pendingProcesses = [Collections.Generic.Queue[int]]::new()
    $visitedProcesses = [Collections.Generic.HashSet[int]]::new()
    $qaProcessId = if ($e2eQaProcess -and $e2eOwnedNativeProcesses.ContainsKey($e2eQaProcess.Id)) { $e2eQaProcess.Id } else { 0 }
    $qaAttemptedCandidates = [Collections.Generic.HashSet[int]]::new()
    $qaLastSnapshotMs = $observationTimer.ElapsedMilliseconds
    $qaReplayCount = 0
    # Candidate handles confer no ownership. Open direct QA children before
    # slower whole-tree proof work; the unchanged live proof below must succeed.
    $openQaCandidates = {
        param([object[]]$Candidates)
        foreach ($candidate in $Candidates) {
            $candidateId = [int]$candidate.ProcessId
            if ($e2eOwnedNativeProcesses.ContainsKey($candidateId) -or -not $qaAttemptedCandidates.Add($candidateId)) { continue }
            if ($qaCandidateHandles.Count -ge 256) { Add-E2eNativeChildDiagnostic $candidate 'qa-candidate-handle-bound'; continue }
            $candidateProcess = $null
            try {
                $candidateProcess = Get-E2eNativeProcessById $candidateId
                $null = $candidateProcess.Handle
                $qaCandidateHandles[$candidateId] = $candidateProcess
            } catch {
                if ($candidateProcess) { $candidateProcess.Dispose() }
                Add-E2eNativeChildDiagnostic $candidate 'child-handle-or-proof-unavailable'
            }
        }
    }
    if ($qaProcessId -and $childrenByParent.ContainsKey($qaProcessId)) {
        & $openQaCandidates -Candidates @($childrenByParent[$qaProcessId])
        $pendingProcesses.Enqueue($qaProcessId)
    }
    foreach ($knownId in @($e2eOwnedNativeProcesses.Keys)) {
        # A parent with no candidate children makes no ownership decision.
        # Each candidate still undergoes the unchanged live-handle proof below.
        if ([int]$knownId -ne $qaProcessId -and $childrenByParent.ContainsKey([int]$knownId)) { $pendingProcesses.Enqueue([int]$knownId) }
    }
    while ($pendingProcesses.Count -gt 0) {
        $parentId = $pendingProcesses.Dequeue()
        # New UI requests can arrive while existing CLI descendants are being
        # audited. Revisit fresh QA candidates first, without retrying the same
        # unproved candidate indefinitely or replacing any identity check.
        if ($qaProcessId -and $parentId -ne $qaProcessId -and $qaReplayCount -lt 256 -and $observationTimer.ElapsedMilliseconds - $qaLastSnapshotMs -ge 50) {
            $newQaCandidates = @(Get-E2eNativeProcessSnapshot | Where-Object {
                [int]$_.ParentProcessId -eq $qaProcessId -and -not $e2eOwnedNativeProcesses.ContainsKey([int]$_.ProcessId) -and -not $qaAttemptedCandidates.Contains([int]$_.ProcessId)
            })
            $qaLastSnapshotMs = $observationTimer.ElapsedMilliseconds
            $qaReplayCount++
            if ($newQaCandidates.Count -gt 0) {
                & $openQaCandidates -Candidates $newQaCandidates
                $childrenByParent[$qaProcessId] = $newQaCandidates
                $null = $visitedProcesses.Remove($qaProcessId)
                $priorityQueue = [Collections.Generic.Queue[int]]::new()
                $priorityQueue.Enqueue($qaProcessId)
                $priorityQueue.Enqueue($parentId)
                foreach ($remainingParent in $pendingProcesses) { $priorityQueue.Enqueue($remainingParent) }
                $pendingProcesses = $priorityQueue
                continue
            }
        }
        if (-not $visitedProcesses.Add($parentId)) { continue }
        $knownParent = $e2eOwnedNativeProcesses[$parentId]
        if (-not $knownParent) { continue }
        $knownParent.process.Refresh()
        if ($knownParent.process.HasExited) { continue }
        try { Assert-E2eNativeProcessIdentity $knownParent } catch {
            # A retained parent may exit between the two live checks. Confirm
            # its exit with the same handle and unchanged owner before skipping
            # it; no child ownership decision is made for an exited parent.
            try {
                $knownParent.process.Refresh()
                if ($knownParent.process.HasExited) { Assert-E2eNativeOwner; continue }
            } catch { }
            $script:e2eNativeIdentityFailure = $true
            continue
        }
        foreach ($childInfo in $childrenByParent[$parentId]) {
            if ($e2eOwnedNativeProcesses.ContainsKey([int]$childInfo.ProcessId)) {
                $knownChild = $e2eOwnedNativeProcesses[[int]$childInfo.ProcessId]
                $knownChild.process.Refresh()
                if (-not $knownChild.process.HasExited) { $pendingProcesses.Enqueue([int]$childInfo.ProcessId) }
                continue
            }
            $childProcess = $null
            $retained = $false
            $scope = $null
            try {
                Assert-E2eNativeProcessIdentity $knownParent
                if ($qaCandidateHandles.ContainsKey([int]$childInfo.ProcessId)) {
                    $childProcess = $qaCandidateHandles[[int]$childInfo.ProcessId]
                    $qaCandidateHandles.Remove([int]$childInfo.ProcessId)
                } else { $childProcess = Get-E2eNativeProcessById ([int]$childInfo.ProcessId) }
                $null = $childProcess.Handle
                $childStarted = $childProcess.StartTime.ToUniversalTime()
                $actualPath = Get-E2eNativeProcessPath $childProcess
                $childDetails = Get-E2eNativeProcessDetails $childProcess
                if ($childProcess.HasExited -or $childStarted -lt $knownParent.started -or $childDetails.ParentProcessId -ne $parentId) {
                    Add-E2eNativeChildDiagnostic $childInfo 'stale-or-unproved-child-identity'
                    continue
                }
                $scope = Get-E2eNativeProcessScope $actualPath $childDetails.CommandLine $knownParent
                if (-not $scope) { Add-E2eNativeChildDiagnostic $childInfo 'outside-or-unproved-child-scope'; continue }
                if ($e2eOwnedNativeProcesses.ContainsKey($childProcess.Id)) {
                    $existing = $e2eOwnedNativeProcesses[$childProcess.Id]
                    if ($existing.started.Ticks -ne $childStarted.Ticks -or $existing.path -ine $actualPath) { Add-E2eNativeChildDiagnostic $childInfo 'retained-pid-reuse-rejected'; continue }
                } else {
                    if ($e2eOwnedNativeProcesses.Count -ge 256) { throw 'Owned native process count exceeds its bound.' }
                    $identity = New-E2eNativeProcessIdentity $childProcess $scope $parentId
                    Assert-E2eNativeProcessIdentity $knownParent
                    Assert-E2eNativeProcessIdentity $identity
                    $e2eOwnedNativeProcesses[$childProcess.Id] = $identity
                    $retained = $true
                    if ($scope.kind -eq 'official-powershell-launcher') {
                        Add-E2eNativeChildDiagnostic $childInfo 'retained-launcher-identity' $scope
                        Publish-E2eNativeLaunchProof $identity
                    }
                }
                $pendingProcesses.Enqueue($childProcess.Id)
            } catch { Add-E2eNativeChildDiagnostic $childInfo 'child-handle-or-proof-unavailable' $scope }
            finally { if ($childProcess -and -not $retained) { $childProcess.Dispose() } }
        }
    }
    } finally {
        foreach ($candidateHandle in $qaCandidateHandles.Values) { $candidateHandle.Dispose() }
        $observationTimer.Stop()
        $script:e2eNativeObservationCalls++
        $script:e2eNativeObservationTotalMs += $observationTimer.ElapsedMilliseconds
        $script:e2eNativeObservationMaxMs = [Math]::Max($script:e2eNativeObservationMaxMs, $observationTimer.ElapsedMilliseconds)
    }
}

function Assert-E2eNativeProcessesExited {
    foreach ($identity in $e2eOwnedNativeProcesses.Values) {
        $identity.process.Refresh()
        if (-not $identity.process.HasExited) { throw 'A retained native handle is still live; directory cleanup refused.' }
    }
    foreach ($info in Get-CimInstance Win32_Process -ErrorAction Stop) {
        if (-not (($info.ExecutablePath -and $info.ExecutablePath.StartsWith($e2eSandbox + '\', [StringComparison]::OrdinalIgnoreCase)) -or ($info.CommandLine -and $info.CommandLine.Replace('/', '\').Contains($e2eSandbox, [StringComparison]::OrdinalIgnoreCase)))) { continue }
        $process = $null
        try {
            $process = Get-E2eNativeProcessById ([int]$info.ProcessId)
            $null = $process.Handle
            $process.Refresh()
            if ($process.HasExited) { continue }
            $actualPath = Get-E2eNativeProcessPath $process
            if ($actualPath.StartsWith($e2eSandbox + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'An actual live executable still references the native UUID; cleanup refused.' }
            $current = @(Get-CimInstance Win32_Process -Filter "ProcessId = $($info.ProcessId)" -ErrorAction Stop)
            if ($current.Count -ne 1 -or -not $current[0].CreationDate -or -not (Test-E2eNativeCreationTime $process.StartTime $current[0].CreationDate) -or ($current[0].CommandLine -and $current[0].CommandLine.Replace('/', '\').Contains($e2eSandbox, [StringComparison]::OrdinalIgnoreCase))) { throw 'A live UUID reference could not be disproved; cleanup refused.' }
        } catch [ArgumentException] {
            # A stale CIM row is not a live process handle.
        } finally { if ($process) { $process.Dispose() } }
    }
}

function Test-E2eNativeExternalRootReference([string]$CommandLine, [string]$Root) {
    if ([string]::IsNullOrWhiteSpace($CommandLine) -or $CommandLine.Length -gt 65534 -or $CommandLine.IndexOf([char]0) -ge 0) { return $false }
    $normalized = $CommandLine.Replace('/', '\')
    $offset = 0
    while ($offset -lt $normalized.Length) {
        $index = $normalized.IndexOf($Root, $offset, [StringComparison]::OrdinalIgnoreCase)
        if ($index -lt 0) { return $false }
        $end = $index + $Root.Length
        if ($end -eq $normalized.Length -or $normalized[$end] -eq '\' -or $normalized[$end] -eq '"' -or $normalized[$end] -eq "'" -or [char]::IsWhiteSpace($normalized[$end])) { return $true }
        $offset = $end
    }
    return $false
}

function Get-E2eNativeExternalGitImages {
    # An observation allowlist is not an ownership or termination allowlist.
    $images = @{}
    foreach ($base in @('C:\Program Files\Git', (Join-Path $e2eWorkspace '.tools/git'))) {
        foreach ($relative in @('cmd/git.exe', 'bin/git.exe', 'mingw64/bin/git.exe', 'mingw64/libexec/git-core/git.exe')) {
            $path = [IO.Path]::GetFullPath((Join-Path $base $relative))
            if (-not [IO.File]::Exists($path)) { continue }
            $path = Assert-E2eNativeOrdinaryFile $path
            $images[$path] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    return $images
}

function Assert-E2eNativeExternalObservationContext($Context) {
    Assert-E2eNativeOwner
    if ($e2eIdentifier -cne $Context.ownerId -or [IO.Path]::GetFullPath($e2eSandbox) -ine $Context.root -or
        [IO.Path]::GetFullPath($e2eMarker) -ine $Context.marker -or $e2eNativeMarkerHash -cne $Context.markerSha256) {
        throw 'External observation owner context changed; cleanup refused.'
    }
    if ($Context.deadline -ne [DateTimeOffset]::Parse($Context.receipt.deadlineUtc) -or
        $Context.deadline -ne [DateTimeOffset]::Parse($Context.receipt.startedAt).AddSeconds($Context.receipt.budgetSeconds) -or
        $Context.receipt.budgetSeconds -lt 1 -or $Context.receipt.budgetSeconds -gt 1200) { throw 'External observation fixed deadline changed; cleanup refused.' }
    $wrapper = Assert-E2eNativeOrdinaryFile $Context.wrapper
    if ((Get-FileHash -LiteralPath $wrapper -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Context.wrapperSha256) { throw 'External observation wrapper bytes changed; cleanup refused.' }
    foreach ($entry in $Context.gitImages.GetEnumerator()) {
        $path = Assert-E2eNativeOrdinaryFile $entry.Key
        if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.Value) { throw 'External observation Git image bytes changed; cleanup refused.' }
    }
}

function Write-E2eNativeExternalObservation($Context) {
    $null = Assert-E2eLocalPath $Context.reportPath
    $mode = [IO.FileMode]::CreateNew
    if ($Context.reportSha256) {
        $null = Assert-E2eNativeOrdinaryFile $Context.reportPath
        $mode = [IO.FileMode]::Open
    } elseif ([IO.File]::Exists($Context.reportPath) -or [IO.Directory]::Exists($Context.reportPath)) {
        throw 'External observation output must be fresh.'
    }
    $stream = [IO.FileStream]::new($Context.reportPath, $mode, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
    try {
        if ($Context.reportSha256 -and [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant() -cne $Context.reportSha256) { throw 'External observation receipt bytes changed; cleanup refused.' }
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Context.receipt | ConvertTo-Json -Depth 15) + "`n")
        $stream.Position = 0; $stream.SetLength($bytes.Length); $stream.Write($bytes); $stream.Flush($true)
        $Context.reportSha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
    } finally { $stream.Dispose() }
}

function Wait-E2eNativeExternalGitNaturalExit {
    [CmdletBinding()]
    param([ValidateRange(1,1200)][int]$BudgetSeconds = 1200, [ValidateRange(20,1000)][int]$PollMilliseconds = 250)
    Assert-E2eNativeOwner
    foreach ($identity in $e2eOwnedNativeProcesses.Values) {
        $identity.process.Refresh()
        if (-not $identity.process.HasExited) { throw 'External observation requires every retained owned process to have exited.' }
    }
    $state = Get-Variable -Name e2eNativeExternalGitObservation -Scope Script -ErrorAction SilentlyContinue
    if (-not $state -or -not $state.Value) {
        $started = [DateTimeOffset]::UtcNow
        $wrapper = Assert-E2eNativeOrdinaryFile (Join-Path $e2eWorkspace 'scripts/verify-portable-e2e.ps1')
        $root = [IO.Path]::GetFullPath($e2eSandbox)
        $reportPath = Assert-E2eLocalPath (Join-Path $e2eWorkspace ('artifacts/acceptance/native-external-git-observation-' + $e2eIdentifier + '.json'))
        $script:e2eNativeExternalGitObservation = @{
            ownerId = $e2eIdentifier; root = $root; marker = [IO.Path]::GetFullPath($e2eMarker); markerSha256 = $e2eNativeMarkerHash
            wrapper = $wrapper; wrapperSha256 = (Get-FileHash -LiteralPath $wrapper -Algorithm SHA256).Hash.ToLowerInvariant()
            gitImages = Get-E2eNativeExternalGitImages; deadline = $started.AddSeconds($BudgetSeconds); reportPath = $reportPath; reportSha256 = $null
            receipt = [ordered]@{schemaVersion=1; ownerId=$e2eIdentifier; root=$root; scope='Readonly exact Git retained handles and bounded natural exit after strict owned process stop'; startedAt=$started.ToString('o'); deadlineUtc=$started.AddSeconds($BudgetSeconds).ToString('o'); budgetSeconds=$BudgetSeconds; deadlineNeverReset=$true; wrapperSha256=(Get-FileHash -LiteralPath $wrapper -Algorithm SHA256).Hash.ToLowerInvariant(); markerSha256=$e2eNativeMarkerHash; gitImages=@(); retainedReadonlyIdentities=@(); observationCalls=0; processesStopped=0; ownershipClaimed=$false; rawCommandLinesArchived=$false; allObservedNaturalExit=$false; finalStrictUuidAssertionReplaced=$false; passed=$false}
        }
        $script:e2eNativeExternalGitObservation.receipt.gitImages = @($script:e2eNativeExternalGitObservation.gitImages.GetEnumerator() | Sort-Object Key | ForEach-Object { @{path=$_.Key; sha256=$_.Value} })
    }
    $context = $script:e2eNativeExternalGitObservation
    Assert-E2eNativeExternalObservationContext $context
    $context.receipt.allObservedNaturalExit = $false
    $context.receipt.passed = $false
    $retained = @{}
    $lastProgress = [DateTimeOffset]::MinValue
    $emptyScans = 0
    try {
        Write-E2eNativeExternalObservation $context
        Initialize-E2eNativeProcessInterop
        while ($true) {
            Assert-E2eNativeExternalObservationContext $context
            $context.receipt.observationCalls++
            $candidates = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -ieq 'git.exe' -and (Test-E2eNativeExternalRootReference $_.CommandLine $context.root) })
            foreach ($candidate in $candidates) {
                if ($e2eOwnedNativeProcesses.ContainsKey([int]$candidate.ProcessId)) { throw 'An owned process remained live at the external observation boundary.' }
                if (-not $candidate.CreationDate) { throw 'External Git candidate has no creation identity.' }
                $key = [string]$candidate.ProcessId + ':' + $candidate.CreationDate.ToUniversalTime().Ticks
                if ($retained.ContainsKey($key)) { continue }
                if ($retained.Count -ge 128) { throw 'External Git observation identity bound exceeded.' }
                $process = $null
                $accepted = $false
                try {
                    $process = Get-E2eNativeProcessById ([int]$candidate.ProcessId)
                    $null = $process.Handle
                    $process.Refresh()
                    if ($process.HasExited) { continue }
                    $started = $process.StartTime.ToUniversalTime()
                    if (-not (Test-E2eNativeCreationTime $started $candidate.CreationDate)) { throw 'External Git native creation identity changed.' }
                    $image = Get-E2eNativeProcessPath $process
                    if (-not $context.gitImages.ContainsKey($image)) { throw 'External Git actual image is outside the exact readonly allowlist.' }
                    $null = Assert-E2eNativeOrdinaryFile $image
                    $imageHash = (Get-FileHash -LiteralPath $image -Algorithm SHA256).Hash.ToLowerInvariant()
                    if ($imageHash -cne $context.gitImages[$image]) { throw 'External Git actual image hash changed.' }
                    $details = Get-E2eNativeProcessDetails $process
                    if (-not (Test-E2eNativeExternalRootReference $details.CommandLine $context.root)) { throw 'External Git actual command line does not reference this exact UUID root.' }
                    $commandHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($details.CommandLine))).ToLowerInvariant()
                    $identity = [ordered]@{pid=$process.Id; parentPid=$details.ParentProcessId; startedAt=$started.ToString('o'); image=$image; sha256=$imageHash; commandLineSha256=$commandHash; exactRootReference=$true; retainedNativeHandle=$true; owned=$false; naturalExitObserved=$false}
                    $retained[$key] = @{process=$process; started=$started; image=$image; sha256=$imageHash; commandHash=$commandHash; parentId=$details.ParentProcessId; identity=$identity}
                    $context.receipt.retainedReadonlyIdentities += $identity
                    $accepted = $true
                } catch [ArgumentException] {
                    # A stale CIM row does not establish a live process.
                    if ($process) { $process.Refresh(); if (-not $process.HasExited) { throw 'External Git retained handle proof failed while live.' } }
                } catch {
                    if ($process) {
                        $process.Refresh()
                        if ($process.HasExited) { Assert-E2eNativeExternalObservationContext $context; continue }
                    }
                    throw 'External Git retained identity acquisition failed; cleanup refused.'
                } finally { if ($process -and -not $accepted) { $process.Dispose() } }
            }
            $live = 0
            foreach ($entry in $retained.Values) {
                $entry.process.Refresh()
                if ($entry.process.HasExited) {
                    Assert-E2eNativeExternalObservationContext $context
                    $entry.identity.naturalExitObserved = $true
                    $entry.identity.exitCode = $entry.process.ExitCode
                    continue
                }
                try {
                    if ($entry.process.StartTime.ToUniversalTime() -ne $entry.started -or (Get-E2eNativeProcessPath $entry.process) -ine $entry.image) { throw 'External Git retained native identity changed.' }
                    $details = Get-E2eNativeProcessDetails $entry.process
                    $commandHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($details.CommandLine))).ToLowerInvariant()
                    if ($details.ParentProcessId -ne $entry.parentId -or $commandHash -cne $entry.commandHash -or -not (Test-E2eNativeExternalRootReference $details.CommandLine $context.root)) { throw 'External Git retained command identity changed.' }
                    $live++
                } catch {
                    $entry.process.Refresh()
                    if ($entry.process.HasExited) {
                        Assert-E2eNativeExternalObservationContext $context
                        $entry.identity.naturalExitObserved = $true
                        $entry.identity.exitCode = $entry.process.ExitCode
                    } else { throw 'External Git retained identity changed while live; cleanup refused.' }
                }
            }
            $context.receipt.latestCheckedAt = [DateTimeOffset]::UtcNow.ToString('o')
            $context.receipt.liveGitCandidates = $candidates.Count
            $context.receipt.liveRetainedHandles = $live
            if ($candidates.Count -eq 0 -and $live -eq 0) { $emptyScans++ } else { $emptyScans = 0 }
            $context.receipt.consecutiveEmptyScans = $emptyScans
            Write-E2eNativeExternalObservation $context
            if ($emptyScans -ge 2) { $context.receipt.allObservedNaturalExit = $true; $context.receipt.passed = $true; break }
            if ([DateTimeOffset]::UtcNow -ge $context.deadline) { throw 'External Git natural exit observation deadline exceeded; cleanup refused.' }
            if (([DateTimeOffset]::UtcNow - $lastProgress).TotalSeconds -ge 15) {
                Write-Host ('Readonly Git natural exit: candidates=' + $candidates.Count + ', retainedLive=' + $live + ', remainingSeconds=' + [Math]::Max(0,[int]($context.deadline - [DateTimeOffset]::UtcNow).TotalSeconds))
                $lastProgress = [DateTimeOffset]::UtcNow
            }
            $remaining = [Math]::Max(1, [int]($context.deadline - [DateTimeOffset]::UtcNow).TotalMilliseconds)
            Start-Sleep -Milliseconds ([Math]::Min($PollMilliseconds, $remaining))
        }
    } catch {
        $context.receipt.passed = $false
        $context.receipt.failure = 'External readonly Git observation failed; strict cleanup remains refused.'
        throw
    } finally {
        $context.receipt.finishedAt = [DateTimeOffset]::UtcNow.ToString('o')
        $context.receipt.observationElapsedMilliseconds = [long]([DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse($context.receipt.startedAt)).TotalMilliseconds
        try { Write-E2eNativeExternalObservation $context }
        finally { foreach ($entry in $retained.Values) { $entry.process.Dispose() } }
    }
}

function Wait-E2eNativeRootReferenceNaturalExit {
    [CmdletBinding()]
    param([ValidateRange(1,180)][int]$BudgetSeconds=120,[ValidateRange(20,1000)][int]$PollMilliseconds=100)
    Assert-E2eNativeOwner
    $root=[IO.Path]::GetFullPath($e2eSandbox)
    if(-not $NativeUi -or $e2eIdentifier -cnotmatch '^[a-f0-9]{32}$' -or $root -ine (Join-Path $e2eWorkspace ('.cache/native-e2e-sandbox/'+$e2eIdentifier))) { throw 'Readonly wait requires the exact owned native UUID root.' }
    foreach($owned in $e2eOwnedNativeProcesses.Values) { $owned.process.Refresh(); if(-not $owned.process.HasExited) { throw 'Readonly wait requires all retained owned processes already exited.' } }
    $wrapper=Assert-E2eNativeOrdinaryFile (Join-Path $e2eWorkspace 'scripts/verify-portable-e2e.ps1')
    $wrapperHash=(Get-FileHash -LiteralPath $wrapper -Algorithm SHA256).Hash.ToLowerInvariant()
    $state=Get-Variable -Name e2eNativeRootReferenceObservation -Scope Script -ErrorAction SilentlyContinue
    if(-not $state -or -not $state.Value) {
        $startedAt=[DateTimeOffset]::UtcNow;$deadline=$startedAt.AddSeconds($BudgetSeconds)
        $script:e2eNativeRootReferenceObservation=@{ownerId=$e2eIdentifier;root=$root;markerHash=$e2eNativeMarkerHash;wrapperHash=$wrapperHash;deadline=$deadline;receipt=@{scope='Read-only exact UUID references after retained owned handles exit; original strict exit assertion required';ownerId=$e2eIdentifier;wrapperSha256=$wrapperHash;startedAt=$startedAt.ToString('o');deadlineUtc=$deadline.ToString('o');budgetSeconds=$BudgetSeconds;pollMilliseconds=$PollMilliseconds;queryCallsNotInterruptible=$true;strictWallClockLimitClaimed=$false;passed=$false;deadlineNeverReset=$true;observationCalls=0;readonlyHandlesRetained=0;naturalExitsObserved=0;strictAssertionPassed=$false;strictAssertionReplaced=$false;processesStopped=0;ownershipClaimed=$false;rawCommandLinesArchived=$false}}
    }
    $context=$script:e2eNativeRootReferenceObservation
    $context.receipt.passed=$false;$context.receipt.strictAssertionPassed=$false
    $retained=@{};$empty=0
    try {
        while($true) {
            Assert-E2eNativeOwner
            if($context.ownerId -cne $e2eIdentifier -or $context.root -ine $root -or $context.markerHash -cne $e2eNativeMarkerHash -or $context.wrapperHash -cne (Get-FileHash -LiteralPath $wrapper -Algorithm SHA256).Hash.ToLowerInvariant()) { throw 'Readonly wait owner or wrapper binding changed.' }
            if([DateTimeOffset]::UtcNow -ge $context.deadline) { throw 'Readonly UUID natural-exit deadline expired; strict cleanup remains refused.' }
            foreach($owned in $e2eOwnedNativeProcesses.Values) { $owned.process.Refresh(); if(-not $owned.process.HasExited) { throw 'Retained owned process became live during readonly wait.' } }
            $context.receipt.observationCalls++
            $candidates=@(Get-CimInstance Win32_Process -ErrorAction Stop|Where-Object { ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)) -or (Test-E2eNativeExternalRootReference $_.CommandLine $root) })
            foreach($candidate in $candidates) {
                if($e2eOwnedNativeProcesses.ContainsKey([int]$candidate.ProcessId) -or -not $candidate.CreationDate) { throw 'Readonly reference has owned or missing creation identity.' }
                $key=[string]$candidate.ProcessId+':'+$candidate.CreationDate.ToUniversalTime().Ticks
                if($retained.ContainsKey($key)) { continue }
                if($retained.Count -ge 128) { throw 'Readonly reference identity bound exceeded.' }
                $process=$null;$accepted=$false
                try {
                    $process=Get-E2eNativeProcessById ([int]$candidate.ProcessId)
                    $null=$process.Handle;$process.Refresh()
                    if($process.HasExited) { continue }
                    $started=$process.StartTime.ToUniversalTime();$image=Get-E2eNativeProcessPath $process
                    if(-not (Test-E2eNativeCreationTime $started $candidate.CreationDate) -or $image.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Readonly candidate identity is changed or is an unproved in-root executable.' }
                    $details=Get-E2eNativeProcessDetails $process
                    if(-not (Test-E2eNativeExternalRootReference $details.CommandLine $root)) { throw 'Readonly handle does not prove this exact UUID reference.' }
                    $commandHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($details.CommandLine))).ToLowerInvariant()
                    $retained[$key]=@{process=$process;started=$started;image=$image;parent=$details.ParentProcessId;commandHash=$commandHash;exitObserved=$false}
                    $context.receipt.readonlyHandlesRetained++;$accepted=$true
                } catch [ArgumentException] { if($process) { $process.Refresh(); if(-not $process.HasExited) { throw } } }
                catch { if($process) { $process.Refresh(); if($process.HasExited) { continue } };throw }
                finally { if($process -and -not $accepted) { $process.Dispose() } }
            }
            $live=0
            foreach($entry in $retained.Values) {
                $entry.process.Refresh()
                if($entry.process.HasExited) { if(-not $entry.exitObserved) { $entry.exitObserved=$true;$context.receipt.naturalExitsObserved++ };continue }
                try {
                    $details=Get-E2eNativeProcessDetails $entry.process
                    $commandHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($details.CommandLine))).ToLowerInvariant()
                    if($entry.process.StartTime.ToUniversalTime() -ne $entry.started -or (Get-E2eNativeProcessPath $entry.process) -ine $entry.image -or $details.ParentProcessId -ne $entry.parent -or $commandHash -cne $entry.commandHash -or -not (Test-E2eNativeExternalRootReference $details.CommandLine $root)) { throw 'Readonly retained reference identity changed while live.' }
                    $live++
                } catch { $entry.process.Refresh();if($entry.process.HasExited) { if(-not $entry.exitObserved) { $entry.exitObserved=$true;$context.receipt.naturalExitsObserved++ };continue };throw }
            }
            if($candidates.Count -eq 0 -and $live -eq 0) { $empty++ } else { $empty=0 }
            $context.receipt.consecutiveEmptyScans=$empty
            if($empty -ge 2) {
                Assert-E2eNativeOwner
                Assert-E2eNativeProcessesExited
                $context.receipt.strictAssertionPassed=$true;$context.receipt.passed=$true
                return
            }
            $remaining=[int]($context.deadline-[DateTimeOffset]::UtcNow).TotalMilliseconds
            if($remaining -le 0) { throw 'Readonly UUID natural-exit deadline expired; strict cleanup remains refused.' }
            Start-Sleep -Milliseconds ([Math]::Min($PollMilliseconds,$remaining))
        }
    } catch { $context.receipt.passed=$false;throw }
    finally { $context.receipt.finishedAt=[DateTimeOffset]::UtcNow.ToString('o');foreach($entry in $retained.Values) { $entry.process.Dispose() } }
}

function Stop-E2eNativeProcesses {
    $failures = [Collections.Generic.List[string]]::new()
    try { Record-E2eNativeChildren } catch { $failures.Add('child-audit-failed') }
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    foreach ($identity in @($e2eOwnedNativeProcesses.Values | Sort-Object started -Descending)) {
        try {
            $identity.process.Refresh()
            if ($identity.process.HasExited) { continue }
            Assert-E2eNativeProcessIdentity $identity -VerifyHash
            $remaining = [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds
            if ($remaining -le 0) { throw 'Owned process stop deadline exceeded.' }
            $identity.process.Kill()
            if (-not $identity.process.WaitForExit([Math]::Min(5000, $remaining)) -or -not $identity.process.HasExited) { throw 'A retained native handle did not exit.' }
        } catch {
            # Natural exit during the proof needs no termination. Every proof
            # error on a still-live handle, or changed owner, remains a failure.
            try {
                $identity.process.Refresh()
                if ($identity.process.HasExited) { Assert-E2eNativeOwner; continue }
            } catch { }
            $failures.Add('retained-identity-or-stop-failed')
        }
    }
    if ($e2eNativeIdentityFailure -or $failures.Count) { throw 'Owned native process proof or stop failed; sandbox retained.' }
    Wait-E2eNativeExternalGitNaturalExit
    Wait-E2eNativeRootReferenceNaturalExit
    Assert-E2eNativeProcessesExited
}

foreach ($environmentDirectory in @('.cache', '.tools', '.cache/tmp', '.cache/home', '.cache/appdata', '.cache/localappdata')) {
    $null = Assert-E2eLocalPath (Join-Path $e2eWorkspace $environmentDirectory)
}
. (Join-Path $PSScriptRoot 'workspace-env.ps1')

if ($CleanupNativeSandboxId) {
    if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'Native cleanup requires PowerShell 7.' }
    $e2eResolved = Assert-E2eLocalPath $e2eSandbox
    $null = Assert-E2eLocalPath $e2eMarker
    $e2eOwner = [IO.File]::ReadAllText($e2eMarker) | ConvertFrom-Json
    if ($e2eOwner.id -ne $e2eIdentifier -or $e2eOwner.workspace -ne $e2eWorkspace -or $e2eOwner.purpose -ne $e2ePurpose) { throw 'Native cleanup ownership marker did not match.' }
    $e2eNativeMarkerHash = (Get-FileHash -LiteralPath $e2eMarker -Algorithm SHA256).Hash.ToLowerInvariant()
    $e2eRunning = @(Get-CimInstance Win32_Process | Where-Object {
        ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($e2eResolved + '\', [StringComparison]::OrdinalIgnoreCase)) -or
        ($_.CommandLine -and $_.CommandLine.Replace('/', '\').Contains($e2eResolved, [StringComparison]::OrdinalIgnoreCase))
    })
    if ($e2eRunning.Count) { throw 'Owned native processes are still running; cleanup is refused.' }
    $e2eReport = Assert-E2eLocalPath $e2eReport
    $e2eCleanupReport = [IO.File]::ReadAllText($e2eReport) | ConvertFrom-Json
    if ($e2eCleanupReport.sandbox -ne $e2eSandbox) { throw 'The retained native report does not belong to this sandbox.' }
    if ($NativeGatewayFixture -and ($e2eCleanupReport.scope -cne 'gateway-startup-recovery' -or $e2eCleanupReport.nativeGatewayFixtureCleanup.ownThreadJoined -ne $true -or $e2eCleanupReport.nativeGatewayFixtureCleanup.ownRetainedListenerStopped -ne $true)) { throw 'Gateway cleanup requires its exact retained report and a confirmed stopped fixture thread; sandbox retained.' }
    Remove-E2eOwnedTree $e2eResolved
    if (Test-Path -LiteralPath $e2eResolved) { throw 'Owned native sandbox still exists after cleanup.' }
    $e2eCleanupReport.cleanup = @{ removed = $true; ownerMarkerVerified = $true; installationAndRuntimeDataRemoved = $true; internalWebViewCacheJunctionRemovedWithoutTraversal = $true }
    [IO.File]::WriteAllText($e2eReport, ($e2eCleanupReport | ConvertTo-Json -Depth 60), $e2eUtf8)
    Write-Host 'Owned native installation and runtime sandbox removed; failed acceptance evidence retained.'
    exit 0
}

$e2ePackage = Assert-E2eLocalPath $PackageDirectory
$e2eCredentials = $null
if (-not $NativeGatewayFixture) {
    if (-not $CredentialsFile) { $CredentialsFile = Join-Path $e2eWorkspace '端点测试用.txt' }
    $e2eCredentials = Assert-E2eLocalPath $CredentialsFile
}
$e2eReport = Assert-E2eLocalPath $e2eReport
if (-not $NativeUi) { throw 'The AE-only distribution is accepted through -NativeUi using existing installed profiles; the obsolete private bundled-client runner is unsupported.' }
$e2eTestNode = Assert-E2eLocalPath (Join-Path $e2eWorkspace '.tools/node/node.exe')
if (-not (Test-Path -LiteralPath $e2eTestNode -PathType Leaf)) { throw 'The workspace test Node runtime is missing; it is not part of the distribution.' }
foreach ($required in @('AE-Switch-core.exe', 'package-manifest.json', 'tools/webview2/msedgewebview2.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $e2ePackage $required) -PathType Leaf)) { throw "Portable package is missing $required" }
}
if (-not $NativeGatewayFixture -and -not (Test-Path -LiteralPath $e2eCredentials -PathType Leaf)) { throw 'The current-directory credentials file is missing.' }
$null = Assert-E2eLocalPath $e2eSandbox
New-Item -ItemType Directory -Path $e2eSandbox -ErrorAction Stop | Out-Null
$e2ePortableRoot = Assert-E2eLocalPath (Get-E2ePortableInstallationRoot)
New-Item -ItemType Directory -Path $e2ePortableRoot -ErrorAction Stop | Out-Null
[IO.File]::WriteAllText($e2eMarker, (@{ id = $e2eIdentifier; purpose = $e2ePurpose; workspace = $e2eWorkspace } | ConvertTo-Json), $e2eUtf8)
# The child marker binds native UI receipts to the AE installation while the
# top marker remains the sole cleanup authority for the entire UUID tree.
Copy-Item -LiteralPath $e2eMarker -Destination (Join-Path $e2ePortableRoot '.ae-native-e2e-owner.json')
if ($NativeUi) { $e2eNativeMarkerHash = (Get-FileHash -LiteralPath $e2eMarker -Algorithm SHA256).Hash.ToLowerInvariant() }
New-Item -ItemType Directory -Path (Split-Path -Parent $e2eReport) -Force | Out-Null
$e2eInitialEvidence = @{ recordedAt = [DateTime]::UtcNow.ToString('o'); sandbox = $e2eSandbox; wrapperSha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant(); stage = 'sandbox_installation'; launcherVersionSmoke = $null; modelDiscovery = $null; toolFlowPassed = $false; passed = $false; cleanup = @{ removed = $false } }
if ($NativeGatewayFixture) {
    $e2eInitialEvidence.scope = 'gateway-startup-recovery'
    $e2eInitialEvidence.gatewayScopedPassed = $false
    $e2eInitialEvidence.fullAcceptancePassed = $false
    $e2eInitialEvidence.eightToolFlowNotAttempted = $true
}
[IO.File]::WriteAllText($e2eReport, ($e2eInitialEvidence | ConvertTo-Json -Depth 10), $e2eUtf8)

try {
    # Copy the distribution into the owned installation sandbox. Do not launch
    # vendor installers, register products, change PATH globally, or reuse data.
    & robocopy.exe $e2ePackage $e2ePortableRoot /E /XJ /R:1 /W:1 /COPY:DAT /DCOPY:DAT /NFL /NDL /NJH /NJS /NP /XD (Join-Path $e2ePackage 'data') (Join-Path $e2ePackage '.git') /XF '端点测试用.txt' '*.log' '.ae-switch-e2e-owner.json' '.ae-native-e2e-owner.json' | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Sandbox tool installation failed (robocopy $LASTEXITCODE)." }
    $env:AE_SWITCH_PORTABLE_ROOT = $e2ePortableRoot
    Remove-Item Env:\AE_SWITCH_TOOLS_DIR -ErrorAction SilentlyContinue
    $env:AE_E2E_SANDBOX = $e2ePortableRoot
    if ($NativeUi) {
        if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'Native acceptance requires PowerShell 7 for owned process-tree cleanup.' }
        $e2eBeforeLaunchOwner = [IO.File]::ReadAllText($e2eMarker) | ConvertFrom-Json
        if ($e2eBeforeLaunchOwner.id -ne $e2eIdentifier -or $e2eBeforeLaunchOwner.workspace -ne $e2eWorkspace -or $e2eBeforeLaunchOwner.purpose -ne $e2ePurpose) { throw 'The native ownership marker changed during installation.' }
        if (@([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -eq 9223 }).Count) { throw 'The native QA debugging port is already occupied; refusing to attach to another process.' }
        # A fresh AE installation supplies its fixed UI WebView runtime.
        # The QA executable is our workspace-built binary; its hash and root are
        # recorded before the only GUI process is launched. No vendor GUI runs.
        if (-not $QaExecutablePath) { $QaExecutablePath = Join-Path $env:CARGO_TARGET_DIR 'debug/ae-switch.exe' }
        $e2eQaSource = Assert-E2eLocalPath $QaExecutablePath
        if (-not (Test-Path -LiteralPath $e2eQaSource -PathType Leaf)) { throw 'The built QA executable is missing.' }
        $e2eQaHash = (Get-FileHash -LiteralPath $e2eQaSource -Algorithm SHA256).Hash.ToLowerInvariant()
        $e2eQaProgram = Assert-E2eLocalPath (Join-Path $e2ePortableRoot 'AE-Switch-QA.exe')
        Copy-Item -LiteralPath $e2eQaSource -Destination $e2eQaProgram
        if ((Get-FileHash -LiteralPath $e2eQaProgram -Algorithm SHA256).Hash.ToLowerInvariant() -ne $e2eQaHash) { throw 'The copied QA executable hash did not match.' }
        $e2eInstalledClientFixtures = Initialize-E2eInstalledClientFixtures
        $e2eSharedRuntimeFiles = $e2eInstalledClientFixtures.sharedRuntimeFiles
        $e2eClientEnvironmentNames = @('HOME','USERPROFILE','APPDATA','LOCALAPPDATA','PATH','PATHEXT','ProgramFiles','ProgramFiles(x86)','TEMP','TMP','TMPDIR','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME','CODEX_HOME','CLAUDE_CONFIG_DIR','HERMES_HOME','HERMES_DATA_DIR_SUFFIX','PI_CODING_AGENT_DIR','PI_CONFIG_DIR','OMP_PROFILE','PI_PROFILE','OPENCODE_CONFIG','OPENCODE_CONFIG_DIR','ZCODE_DATA_BASE_DIR','ZCODE_STORAGE_DIR','ZCODE_SESSION_DB_PATH','ZCODE_SESSION_DB','ZCODE_PERSONAL_PROVIDER_CONFIG_FILE','ZCODE_BUILTIN_PROVIDER_CONFIG_FILE','ZCODE_BETA','ZCODE_ENV','WORKBUDDY_CONFIG_DIR','CODEBUDDY_CONFIG_DIR','DSH_HOME','AE_NATIVE_EXISTING_PROFILES','UNI_SWITCH_QA_AGENT_DISCOVERY_CONTEXT')
        foreach ($name in $e2eClientEnvironmentNames) {
            $e2eNativeClientEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, [EnvironmentVariableTarget]::Process)
            [Environment]::SetEnvironmentVariable($name, $null, [EnvironmentVariableTarget]::Process)
        }
        foreach ($name in $e2eInstalledClientFixtures.environment.Keys) {
            [Environment]::SetEnvironmentVariable($name, $e2eInstalledClientFixtures.environment[$name], [EnvironmentVariableTarget]::Process)
        }
        $env:AE_NATIVE_EXISTING_PROFILES = $e2eInstalledClientFixtures.payloadFile
        $env:UNI_SWITCH_QA_AGENT_DISCOVERY_CONTEXT = $e2eInstalledClientFixtures.contextFile
        $e2eInitialEvidence.installedClientMode = @{ portableRoot = $e2ePortableRoot; profileRoot = Join-Path $e2eSandbox 'installed-clients'; configurationOnly = $true; profilesOutsidePortableRoot = $true; clientsBundledInDistribution = $false; sharedOfficialRuntimeFiles = @($e2eSharedRuntimeFiles.Keys); discoveryFixture = $e2eInstalledClientFixtures.contextFile }
        if (-not $NativeGatewayFixture) { Copy-Item -LiteralPath $e2eCredentials -Destination (Join-Path $e2ePortableRoot 'acceptance-credentials.txt') }
        $env:AE_NATIVE_EXPECTED_ROOT = $e2ePortableRoot
        $env:AE_NATIVE_CDP_URL = 'http://127.0.0.1:9223'
        $env:AE_NATIVE_QA_SHA256 = $e2eQaHash
        $env:AE_NATIVE_CREDENTIAL_FILE = Join-Path $e2ePortableRoot 'acceptance-credentials.txt'
        $env:AE_NATIVE_UI_OUT = if ($NativeGatewayFixture) { Split-Path -Parent $e2eReport } else { Join-Path $e2eWorkspace 'artifacts/acceptance/native-ui-retest' }
        $env:WEBVIEW2_BROWSER_EXECUTABLE_FOLDER = Join-Path $e2ePortableRoot 'tools/webview2'
        $env:UNI_SWITCH_QA_PROJECT_OPEN_MARKER = Join-Path $e2ePortableRoot 'data/qa-project-open.txt'
        foreach ($name in @('AE_NATIVE_GATEWAY_FIXTURE_PORT', 'AE_NATIVE_GATEWAY_FIXTURE_OWNER_PID', 'AE_NATIVE_GATEWAY_FIXTURE_OWNER_STARTED_AT', 'AE_NATIVE_GATEWAY_FIXTURE_CONTROL_TOKEN', 'AE_NATIVE_GATEWAY_FIXTURE_RELEASE_PATH')) {
            $e2eNativeGatewayEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, [EnvironmentVariableTarget]::Process)
            Remove-Item -LiteralPath "Env:\$name" -ErrorAction SilentlyContinue
        }
        if ($NativeUpdateFixture) {
            foreach ($name in @('UNI_SWITCH_QA_UPDATE_OPEN_MARKER', 'UNI_SWITCH_QA_UPDATE_REPOSITORY', 'UNI_SWITCH_QA_UPDATE_ENDPOINT', 'AE_NATIVE_QA_LOCAL_FIXTURE_PORT')) {
                $e2eNativeUpdateEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, [EnvironmentVariableTarget]::Process)
            }
        }
        if ($NativeGatewayFixture) {
            Assert-E2eNativeOwner
            Initialize-E2eGatewayFixture
            $e2eGatewayControlToken = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')
            $e2eGatewayRouteToken = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')
            $e2eGatewayFixture = [AEGatewayStartupFixture]::Start($e2eIdentifier, $e2eGatewayControlToken, $PID)
            $e2eGatewayPort = $e2eGatewayFixture.Port
            if ($e2eGatewayPort -lt 1024 -or $e2eGatewayPort -gt 65535 -or $e2eGatewayPort -in @(9018,9223)) { throw 'The retained gateway fixture port is invalid.' }
            $e2eGatewayData = Assert-E2eLocalPath (Join-Path $e2ePortableRoot 'data')
            $e2eGatewayMetadata = Assert-E2eLocalPath (Join-Path $e2eGatewayData 'protocol-bridge.json')
            if (Test-Path -LiteralPath $e2eGatewayMetadata) { throw 'The fresh gateway fixture metadata must start absent.' }
            New-Item -ItemType Directory -Path $e2eGatewayData -Force | Out-Null
            [IO.File]::WriteAllText($e2eGatewayMetadata, (@{ port = $e2eGatewayPort; token = $e2eGatewayRouteToken } | ConvertTo-Json -Compress), $e2eUtf8)
            $e2eGatewayParent = [Diagnostics.Process]::GetCurrentProcess()
            try {
                $env:AE_NATIVE_GATEWAY_FIXTURE_OWNER_PID = [string]$e2eGatewayParent.Id
                $env:AE_NATIVE_GATEWAY_FIXTURE_OWNER_STARTED_AT = $e2eGatewayParent.StartTime.ToUniversalTime().ToString('o')
            } finally { $e2eGatewayParent.Dispose() }
            $env:AE_NATIVE_GATEWAY_FIXTURE_PORT = [string]$e2eGatewayPort
            $env:AE_NATIVE_GATEWAY_FIXTURE_CONTROL_TOKEN = $e2eGatewayControlToken
            $env:AE_NATIVE_GATEWAY_FIXTURE_RELEASE_PATH = "/__ae_native_gateway_fixture/$e2eIdentifier/release"
            $e2eInitialEvidence.nativeGatewayFixture = @{
                fixtureId = $e2eIdentifier; port = $e2eGatewayPort; listenerOwnerPid = $PID
                listenerOwnerStartedAt = $env:AE_NATIVE_GATEWAY_FIXTURE_OWNER_STARTED_AT
                metadataSha256 = (Get-FileHash -LiteralPath $e2eGatewayMetadata -Algorithm SHA256).Hash.ToLowerInvariant()
                ownParentThreadOnly = $true; syntheticUpstreamOnly = $true; eightToolFlowNotAttempted = $true
            }
        }
        $env:UNI_SWITCH_QA_UPDATE_OPEN_MARKER = Join-Path $e2ePortableRoot 'data/qa-update-open.txt'
        Remove-Item Env:\UNI_SWITCH_QA_UPDATE_REPOSITORY -ErrorAction SilentlyContinue
        Remove-Item Env:\UNI_SWITCH_QA_UPDATE_ENDPOINT -ErrorAction SilentlyContinue
        Remove-Item Env:\AE_NATIVE_QA_LOCAL_FIXTURE_PORT -ErrorAction SilentlyContinue
        if ($NativeUpdateFixture) {
            $e2eUpdatePortSelector = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
            try {
                $e2eUpdatePortSelector.Start()
                $e2eUpdatePort = [int]$e2eUpdatePortSelector.LocalEndpoint.Port
            } finally { $e2eUpdatePortSelector.Stop() }
            if ($e2eUpdatePort -lt 1024 -or $e2eUpdatePort -gt 65535 -or $e2eUpdatePort -in @(9018,9223)) { throw 'The isolated local update fixture port is invalid.' }
            $e2eUpdateMarker = Assert-E2eLocalPath (Join-Path $e2ePortableRoot 'data/qa-update-open-marker')
            if (Test-Path -LiteralPath $e2eUpdateMarker) { throw 'The dedicated owned update marker must start absent.' }
            $env:UNI_SWITCH_QA_UPDATE_REPOSITORY = 'ae-switch-native-qa/repo'
            $env:UNI_SWITCH_QA_UPDATE_ENDPOINT = "http://127.0.0.1:$e2eUpdatePort/latest"
            $env:UNI_SWITCH_QA_UPDATE_OPEN_MARKER = $e2eUpdateMarker
            $env:AE_NATIVE_QA_LOCAL_FIXTURE_PORT = [string]$e2eUpdatePort
            $e2eInitialEvidence.nativeUpdateFixture = @{
                enabled = $true; repository = $env:UNI_SWITCH_QA_UPDATE_REPOSITORY; endpoint = $env:UNI_SWITCH_QA_UPDATE_ENDPOINT
                ownedOpenMarker = $e2eUpdateMarker; syntheticReleaseDataOnly = $true; osBrowserVerification = $false; eightRealToolGateRequired = $true
            }
        }
        $e2eInitialEvidence.stage = 'native_ui_launch'
        $e2eInitialEvidence.qaSha256 = $e2eQaHash
        [IO.File]::WriteAllText($e2eReport, ($e2eInitialEvidence | ConvertTo-Json -Depth 60), $e2eUtf8)
        $e2eQaProcess = Start-Process -FilePath $e2eQaProgram -WorkingDirectory $e2ePortableRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $e2eSandbox 'qa-stdout.log') -RedirectStandardError (Join-Path $e2eSandbox 'qa-stderr.log') -PassThru
        Initialize-E2eNativeProcessInterop
        Assert-E2eNativeOwner
        $e2eQaIdentity = New-E2eNativeProcessIdentity $e2eQaProcess @{ kind = 'owned-executable'; launcher = '' }
        if ($e2eQaIdentity.path -ine $e2eQaProgram -or $e2eQaIdentity.sha256 -cne $e2eQaHash) { throw 'The actual QA process image did not match its owned executable.' }
        Assert-E2eNativeProcessIdentity $e2eQaIdentity -VerifyHash
        $e2eOwnedNativeProcesses[$e2eQaProcess.Id] = $e2eQaIdentity
        $env:AE_NATIVE_QA_PID = [string]$e2eQaProcess.Id
        $env:AE_NATIVE_QA_STARTED_AT = $e2eQaProcess.StartTime.ToUniversalTime().ToString('o')
        $env:AE_NATIVE_PWSH_EXE = Join-Path $PSHOME 'pwsh.exe'
        $e2eInitialEvidence.qaPid = $e2eQaProcess.Id
        $e2eReady = $false
        for ($e2eAttempt = 0; $e2eAttempt -lt 30; $e2eAttempt++) {
            $e2eQaProcess.Refresh()
            if ($e2eQaProcess.HasExited) { throw 'The isolated QA application exited before its WebView became ready.' }
            try {
                $e2eTargets = (Invoke-WebRequest -Uri 'http://127.0.0.1:9223/json/list' -TimeoutSec 2).Content | ConvertFrom-Json
                if (@($e2eTargets | Where-Object { $_.type -eq 'page' }).Count -gt 0) { $e2eReady = $true; break }
            } catch { }
            Start-Sleep -Milliseconds 500
        }
        if (-not $e2eReady) { throw 'The native WebView did not become ready.' }
        Record-E2eNativeChildren
        $e2eDebugOwners = @(Get-NetTCPConnection -LocalPort 9223 -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique)
        if (-not $e2eDebugOwners.Count -or @($e2eDebugOwners | Where-Object { -not $e2eOwnedNativeProcesses.ContainsKey([int]$_) }).Count) { throw 'The native debug listener is outside this owned QA process tree.' }
        # Observe launches while the UI workflow runs, including official CLIs
        # that legitimately finish before the remaining seven launches do.
        $e2eNodeRunner = Start-Process -FilePath $e2eTestNode -ArgumentList @('"' + (Join-Path $e2eWorkspace 'tests/acceptance/native-ui.mjs') + '"') -WorkingDirectory $e2eWorkspace -WindowStyle Hidden -RedirectStandardOutput (Join-Path $e2eSandbox 'native-runner-stdout.log') -RedirectStandardError (Join-Path $e2eSandbox 'native-runner-stderr.log') -PassThru
        $e2eNodeIdentity = New-E2eNativeProcessIdentity $e2eNodeRunner @{ kind = 'shared-official-runtime'; launcher = '' } $PID
        $e2eNodeObservation = @(Get-CimInstance Win32_Process -Filter "ProcessId = $($e2eNodeRunner.Id)" -ErrorAction Stop)
        if ($e2eNodeIdentity.path -ine $e2eTestNode -or $e2eNodeIdentity.sha256 -cne $e2eSharedRuntimeFiles[$e2eTestNode] -or $e2eNodeObservation.Count -ne 1 -or $e2eNodeObservation[0].ParentProcessId -ne $PID -or -not $e2eNodeObservation[0].CreationDate -or -not (Test-E2eNativeCreationTime $e2eNodeIdentity.started $e2eNodeObservation[0].CreationDate)) { throw 'The owned UI test runner identity or direct parent did not match.' }
        Assert-E2eNativeProcessIdentity $e2eNodeIdentity -VerifyHash
        # Keep the runner and its bounded parser helpers under the same retained
        # handle proof, including cleanup if an intermediate UI step throws.
        $e2eOwnedNativeProcesses[$e2eNodeRunner.Id] = $e2eNodeIdentity
        while (-not $e2eNodeRunner.WaitForExit(20)) { Record-E2eNativeChildren }
        Record-E2eNativeChildren
        $e2eOutcome = $e2eNodeRunner.ExitCode
        $e2eNativeReport = Assert-E2eLocalPath (Join-Path $env:AE_NATIVE_UI_OUT $(if ($NativeGatewayFixture) { 'native-gateway-results.json' } else { 'native-ui-results.json' }))
        if ($NativeGatewayFixture) {
            if (Test-Path -LiteralPath $e2eNativeReport -PathType Leaf) {
                $e2eGatewayResult = if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) {
                    [IO.File]::ReadAllText($e2eNativeReport) | ConvertFrom-Json -DateKind String
                } else {
                    [IO.File]::ReadAllText($e2eNativeReport) | ConvertFrom-Json
                }
                $e2eGatewayReceipt = $e2eGatewayResult.gatewayStartupRecovery
                $e2eGatewaySteps = @($e2eGatewayResult.steps | Where-Object { $_.step -ceq 'native-gateway-startup-recovery' -and $_.passed -eq $true })
                $e2eInitialEvidence.gatewayScopedPassed = $e2eOutcome -eq 0 -and $e2eGatewayResult.gatewayScopedPassed -eq $true -and $e2eGatewayResult.passed -eq $false -and $e2eGatewayResult.fullAcceptancePassed -eq $false -and $e2eGatewayResult.eightToolFlowNotAttempted -eq $true -and $e2eGatewayResult.realToolFlowPassed -eq $false -and $e2eGatewayResult.verifiedRoot -eq $e2ePortableRoot -and $e2eGatewayResult.qaSha256 -eq $e2eQaHash -and $e2eGatewayResult.ownedNativeSandbox.ownerId -eq $e2eIdentifier -and $e2eGatewaySteps.Count -eq 1 -and $e2eGatewayReceipt.passed -eq $true -and $e2eGatewayReceipt.root -eq $e2ePortableRoot -and $e2eGatewayReceipt.fixtureId -eq $e2eIdentifier -and $e2eGatewayReceipt.qaPid -eq $e2eQaProcess.Id -and $e2eGatewayReceipt.qaStartedAt -ceq $env:AE_NATIVE_QA_STARTED_AT -and $e2eGatewayReceipt.qaSha256 -eq $e2eQaHash -and $e2eGatewayReceipt.fixtureOwnerPid -eq $PID -and $e2eGatewayReceipt.fixtureOwnerStartedAt -ceq $env:AE_NATIVE_GATEWAY_FIXTURE_OWNER_STARTED_AT -and $e2eGatewayReceipt.port -eq $e2eGatewayPort -and $e2eGatewayReceipt.baseline.metadataSha256 -eq $e2eInitialEvidence.nativeGatewayFixture.metadataSha256
                foreach ($e2eGatewayFlag in @('actualUiUse', 'actualUiRetry', 'fixtureListenerReleased', 'unauthorizedReleaseRejected', 'controlTokenValidated', 'failedApplyPreservedProviderAndTargets', 'automaticRecoveryPreservedProviderAndTargets', 'sameQaProcessReboundSamePort', 'metadataUnchanged', 'addressAndTokenUnchanged')) {
                    if ($e2eGatewayReceipt.$e2eGatewayFlag -ne $true) { $e2eInitialEvidence.gatewayScopedPassed = $false }
                }
                if ($e2eGatewayReceipt.cleanup.succeeded -ne $true -or $e2eGatewayReceipt.cleanup.originalFilesRestored -ne $true -or $e2eGatewayReceipt.cleanup.providerDeleted -ne $true -or $e2eGatewayReceipt.gatewayHealth.authenticated -ne 204 -or $e2eGatewayReceipt.gatewayHealth.unauthenticated -ne 401 -or $e2eGatewayReceipt.gatewayHealth.browserOrigin -ne 401 -or $e2eGatewayReceipt.gatewayProcessKilled -ne $false) { $e2eInitialEvidence.gatewayScopedPassed = $false }
                $e2eInitialEvidence.gatewayStartupRecovery = $e2eGatewayReceipt
                $e2eInitialEvidence.nativeGatewayResultPath = $e2eNativeReport
            }
            $e2eOutcome = if ($e2eInitialEvidence.gatewayScopedPassed) { 0 } else { 1 }
        } elseif (Test-Path -LiteralPath $e2eNativeReport -PathType Leaf) {
            $e2eNativeResult = if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) {
                [IO.File]::ReadAllText($e2eNativeReport) | ConvertFrom-Json -DateKind String
            } else { [IO.File]::ReadAllText($e2eNativeReport) | ConvertFrom-Json }
            $e2eInitialEvidence.nativeReport = $e2eNativeReport
            Record-E2eNativeChildren
            $e2eRequiredAgentIds = @('claude_code', 'codex', 'hermes', 'oh_my_pi', 'opencode', 'zcode', 'workbuddy', 'deepseek_harness')
            $e2eLaunchRequiredIds = @($e2eRequiredAgentIds | Where-Object { $_ -cne 'deepseek_harness' })
            $e2eLaunchRequests = @($e2eNativeResult.agentLaunches | Where-Object { $null -ne $_ })
            $e2eObservedLaunchers = @()
            $e2eDshLaunchReceipts = @($e2eLaunchRequests | Where-Object { $_.id -ceq 'deepseek_harness' })
            $e2eDshLaunchRejected = Test-E2eDshEmptyLaunchReceipt $e2eLaunchRequests $e2eOwnedNativeProcesses $e2eQaProcess.Id $e2eInstalledClientFixtures.payload.profiles.deepseek_harness.executablePath
            foreach ($launchRequest in $e2eLaunchRequests) {
                if ($launchRequest.id -cnotin $e2eRequiredAgentIds) { throw 'A launcher receipt has an unexpected Agent ID.' }
                if ($launchRequest.id -ceq 'deepseek_harness') {
                    # Its official headless profile needs a task. An empty
                    # process that exits is not successful interactive launch.
                    continue
                }
                $expectedLauncher = Assert-E2eLocalPath $e2eInstalledClientFixtures.payload.profiles[$launchRequest.id].executablePath
                if ((Assert-E2eLocalPath $launchRequest.launcher) -ine $expectedLauncher) { throw 'A launch receipt does not match the selected existing client entry.' }
                if (-not (Test-Path -LiteralPath $expectedLauncher -PathType Leaf)) { throw 'The selected existing client entry is missing.' }
                $expectedPowerShell = Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell/v1.0/powershell.exe'
                $launchProof = $launchRequest.processProof
                if (-not $launchProof -or $launchProof.stage -cne 'proof' -or $launchProof.requestId -cne $launchRequest.launchRequestId -or $launchProof.ownerId -cne $e2eIdentifier -or $launchProof.id -cne $launchRequest.id -or $launchProof.parentPid -ne $e2eQaProcess.Id -or $launchProof.nativeLaunch -ne $true -or $launchProof.retainedIdentityProofPassed -ne $true) { throw 'A UI launch has no matching current retained-process acknowledgment.' }
                $launchProcesses = @($e2eOwnedNativeProcesses.Values | Where-Object {
                    $_.kind -eq 'official-powershell-launcher' -and $_.nativeLaunch -eq $true -and $_.path -ieq $expectedPowerShell -and $_.launcher -ieq $expectedLauncher -and $_.parentId -eq $e2eQaProcess.Id -and $_.process.Id -eq $launchProof.pid -and $_.started.ToString('o') -ceq $launchProof.startedAt -and $_.sha256 -ceq $launchProof.imageSha256
                })
                if ($launchRequest.uiLaunchSucceeded -eq $true -and $launchProcesses.Count -ge 1) {
                    $actualLauncher = $launchProcesses | Sort-Object started -Descending | Select-Object -First 1
                    $actualLauncher.process.Refresh()
                    if (-not $actualLauncher.process.HasExited) { Assert-E2eNativeProcessIdentity $actualLauncher -VerifyHash }
                    else {
                        # The retained handle was proved while live. Preserve
                        # its receipt after a normal exit without reopening PID.
                        $null = $actualLauncher.process.Handle
                        $null = Assert-E2eNativeOrdinaryFile $actualLauncher.path
                        if ((Get-FileHash -LiteralPath $actualLauncher.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $actualLauncher.sha256) { throw 'The retained launch receipt executable changed.' }
                    }
                    $e2eObservedLaunchers += @{ id = $launchRequest.id; pid = $actualLauncher.process.Id; startedAt = $actualLauncher.started.ToString('o'); ownedParentPid = $e2eQaProcess.Id; launcher = $expectedLauncher; actualProcessObserved = $true; configurationOnly = $true; launchRequestId = $launchRequest.launchRequestId; requestedAt = $launchRequest.requestedAt; acknowledgedAt = $launchProof.recordedAt }
                }
            }
            $e2eInitialEvidence.uiLaunchers = $e2eObservedLaunchers
            $e2eInitialEvidence.dshEmptyLaunch = @{ rejected = $e2eDshLaunchRejected; receipt = @($e2eDshLaunchReceipts); officialHeadlessTaskProbeStillRequired = $true }
            $e2eRealAgents = @($e2eNativeResult.realAgentHub.agents)
            $e2eAgentIds = @($e2eRealAgents | ForEach-Object { $_.id } | Sort-Object)
            $e2eAllReceipts = $e2eRealAgents.Count -eq $e2eRequiredAgentIds.Count -and (($e2eAgentIds -join ',') -eq (($e2eRequiredAgentIds | Sort-Object) -join ','))
            $e2eAllLaunches = $e2eDshLaunchRejected -and $e2eObservedLaunchers.Count -eq $e2eLaunchRequiredIds.Count -and (($e2eObservedLaunchers.id | Sort-Object) -join ',') -eq (($e2eLaunchRequiredIds | Sort-Object) -join ',')
            foreach ($agentReceipt in $e2eRealAgents) {
                $probe = $agentReceipt.probe
                if ($agentReceipt.passed -ne $true -or $probe.ok -ne $true -or $probe.toolVerified -ne $true -or $probe.validationScope -ne 'tool' -or $probe.stage -ne 'verified' -or $probe.cleanup.succeeded -ne $true -or $probe.cleanup.removed -ne $true) { $e2eAllReceipts = $false }
                foreach ($flag in @('writeObserved', 'readObserved', 'readbackMarkerObserved', 'assistantMarkerObserved', 'fileMatchesMarker', 'processSucceeded')) {
                    if ($probe.evidence.$flag -ne $true) { $e2eAllReceipts = $false }
                }
                if ($agentReceipt.id -eq 'deepseek_harness' -and ($probe.evidence.terminalCompletionRequired -ne $true -or $probe.evidence.terminalCompletedObserved -ne $true)) { $e2eAllReceipts = $false }
            }
            $e2eInitialEvidence.toolFlowPassed = $e2eOutcome -eq 0 -and $e2eAllLaunches -and $e2eAllReceipts -and $e2eNativeResult.passed -eq $true -and $e2eNativeResult.nativeIntegrationPassed -eq $true -and $e2eNativeResult.realToolFlowPassed -eq $true -and $e2eNativeResult.verifiedRoot -eq $e2ePortableRoot -and $e2eNativeResult.qaSha256 -eq $e2eQaHash -and $e2eNativeResult.ownedNativeSandbox.ownerId -eq $e2eIdentifier
            # Capture launcher identities before the real tray exit test ends
            # the QA parent. Tray actions use its unique UUID tooltip and OS UI.
            $e2eTrayReportPath = Assert-E2eLocalPath (Join-Path $e2eWorkspace 'artifacts/acceptance/native-tray.json')
            & (Join-Path $PSHOME 'pwsh.exe') -NoLogo -NoProfile -File (Join-Path $e2eWorkspace 'tests/acceptance/native-tray-owned.ps1') -OwnedProcessId $e2eQaProcess.Id -OwnedRoot $e2ePortableRoot -ExpectedSha256 $e2eQaHash -ExpectedStartedAt $env:AE_NATIVE_QA_STARTED_AT -ReportPath $e2eTrayReportPath
            $e2eTrayOutcome = $LASTEXITCODE
            $e2eTrayPassed = $false
            if (Test-Path -LiteralPath $e2eTrayReportPath -PathType Leaf) {
                $e2eTrayReceipt = [IO.File]::ReadAllText($e2eTrayReportPath) | ConvertFrom-Json
                if ($e2eTrayReceipt.root -eq $e2ePortableRoot -and $e2eTrayReceipt.pid -eq $e2eQaProcess.Id) {
                    $e2eInitialEvidence.tray = $e2eTrayReceipt
                    $e2eTrayPassed = $e2eTrayOutcome -eq 0 -and $e2eTrayReceipt.passed -eq $true
                    foreach ($e2eTrayGate in @('actual-own-icon-double-click', 'actual-own-menu-open', 'actual-owned-exit-cancel', 'actual-owned-exit-confirm-input', 'owned-exit-stops-process-and-ports')) {
                        if (@($e2eTrayReceipt.gates | Where-Object { $_.name -ceq $e2eTrayGate -and $_.status -ceq 'passed' }).Count -ne 1) { $e2eTrayPassed = $false }
                    }
                }
            }
            $e2eInitialEvidence.toolFlowPassed = $e2eInitialEvidence.toolFlowPassed -and $e2eTrayPassed
        }
        if (-not $NativeGatewayFixture -and -not $e2eInitialEvidence.toolFlowPassed) { $e2eOutcome = 1 }
        $e2eInitialEvidence.stage = if ($NativeGatewayFixture) { 'native_gateway_scoped_finished' } else { 'native_ui_finished' }
        [IO.File]::WriteAllText($e2eReport, ($e2eInitialEvidence | ConvertTo-Json -Depth 60), $e2eUtf8)
    }
} finally {
    try {
        if ($e2eGatewayFixture) {
            $e2eGatewayFixture.StopAndJoin()
            $e2eGatewayFixtureCleanup = @{
                ownRetainedListenerStopped = $true; ownThreadJoined = $e2eGatewayFixture.ThreadJoined
                authenticatedReleaseObserved = $e2eGatewayFixture.Released; ownerPid = $PID
                fault = $e2eGatewayFixture.Fault; noExternalProcessAction = $true
            }
            if (Test-Path -LiteralPath $e2eReport -PathType Leaf) {
                $e2eGatewaySafetyEvidence = [IO.File]::ReadAllText($e2eReport) | ConvertFrom-Json
                if ($e2eGatewaySafetyEvidence.sandbox -eq $e2eSandbox) {
                    $e2eGatewaySafetyEvidence | Add-Member -NotePropertyName nativeGatewayFixtureCleanup -NotePropertyValue $e2eGatewayFixtureCleanup -Force
                    if (-not $e2eGatewayFixture.Released -or -not $e2eGatewayFixture.ThreadJoined -or $e2eGatewayFixture.Fault) {
                        $e2eGatewaySafetyEvidence.gatewayScopedPassed = $false
                        $e2eOutcome = 1
                    }
                    [IO.File]::WriteAllText($e2eReport, ($e2eGatewaySafetyEvidence | ConvertTo-Json -Depth 60), $e2eUtf8)
                }
            }
        }
    } catch {
        $e2eOutcome = 1
        Write-Warning 'Owned gateway fixture cleanup failed; continuing verified QA process cleanup.'
    } finally { Restore-E2eNativeGatewayEnvironment }
    if ($e2eQaProcess) {
        try { Stop-E2eNativeProcesses } finally {
            Restore-E2eNativeUpdateEnvironment
            Restore-E2eNativeClientEnvironment
            if (Test-Path -LiteralPath $e2eReport -PathType Leaf) {
                $e2eSafetyEvidence = [IO.File]::ReadAllText($e2eReport) | ConvertFrom-Json
                if ($e2eSafetyEvidence.sandbox -eq $e2eSandbox) {
                    $e2eSafetyEvidence | Add-Member -NotePropertyName nativeProcessSafety -NotePropertyValue @{
                        childDiagnostics = @($e2eNativeChildDiagnostics.ToArray()); retainedIdentityCount = $e2eOwnedNativeProcesses.Count
                        qaDirectChildDiagnostics = $(if (Get-Variable e2eNativeQaChildDiagnostics -Scope Script -ErrorAction SilentlyContinue) { @($script:e2eNativeQaChildDiagnostics.ToArray()) } else { @() })
                        qaDirectChildDiagnosticsDropped = $(if (Get-Variable e2eNativeQaDiagnosticsDropped -Scope Script -ErrorAction SilentlyContinue) { $script:e2eNativeQaDiagnosticsDropped } else { 0 })
                        snapshotObservation = @{ calls = $e2eNativeObservationCalls; totalMilliseconds = $e2eNativeObservationTotalMs; maxMilliseconds = $e2eNativeObservationMaxMs; parentIndexed = $true }
                        recursiveTerminationUsed = $false; argvParser = 'CommandLineToArgvW'; identityFailure = $e2eNativeIdentityFailure
                        externalObservation = $(if ($e2eNativeExternalGitObservation) { @{invoked=$true; report=$e2eNativeExternalGitObservation.reportPath; sha256=$e2eNativeExternalGitObservation.reportSha256; passed=$e2eNativeExternalGitObservation.receipt.passed; budgetSeconds=$e2eNativeExternalGitObservation.receipt.budgetSeconds; deadlineNeverReset=$true; processesStopped=0; ownershipClaimed=$false} } else { @{invoked=$false; processesStopped=0; ownershipClaimed=$false} })
                    } -Force
                    [IO.File]::WriteAllText($e2eReport, ($e2eSafetyEvidence | ConvertTo-Json -Depth 60), $e2eUtf8)
                }
            }
        }
    } else { Restore-E2eNativeUpdateEnvironment }
    Restore-E2eNativeClientEnvironment
    if ($e2eGatewayFixture -and -not $e2eGatewayFixture.ThreadJoined) {
        $e2eOutcome = 1
        throw 'The owned gateway fixture thread is not confirmed stopped; sandbox retained.'
    }
    # Re-resolve and verify the exact owned target before recursive removal.
    $e2eResolved = Assert-E2eLocalPath $e2eSandbox
    if (-not $e2eResolved.StartsWith(([IO.Path]::GetFullPath($e2eBase) + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Sandbox cleanup escaped its designated directory.' }
    if ((Split-Path -Leaf $e2eResolved) -ne $e2eIdentifier) { throw 'Sandbox cleanup ownership mismatch.' }
    $null = Assert-E2eLocalPath $e2eMarker
    $e2eOwner = [IO.File]::ReadAllText($e2eMarker) | ConvertFrom-Json
    if ($e2eOwner.id -ne $e2eIdentifier -or $e2eOwner.workspace -ne $e2eWorkspace -or $e2eOwner.purpose -ne $e2ePurpose) { throw 'Sandbox ownership marker did not match.' }
    Remove-E2eOwnedTree $e2eResolved
    if (Test-Path -LiteralPath $e2eResolved) { throw 'The E2E installation sandbox was not fully removed.' }
    if (Test-Path -LiteralPath $e2eReport -PathType Leaf) {
        $null = Assert-E2eLocalPath $e2eReport
        $e2eEvidence = [IO.File]::ReadAllText($e2eReport) | ConvertFrom-Json
        if ($e2eEvidence.sandbox -eq $e2eSandbox) {
            $e2eEvidence.cleanup = @{ removed = $true; ownerMarkerVerified = $true; installationAndRuntimeDataRemoved = $true }
            $e2eEvidence.passed = [bool]$e2eEvidence.toolFlowPassed
            [IO.File]::WriteAllText($e2eReport, ($e2eEvidence | ConvertTo-Json -Depth 60), $e2eUtf8)
        }
    }
    Write-Host ('Owned tool installation and runtime sandbox removed; evidence retained in ' + $e2eReport)
}
exit $e2eOutcome
