param(
    [string]$PackageDirectory,
    [string]$DesktopSha256,
    [string]$CliSha256,
    [switch]$ApplicationOnly,
    [switch]$SelfTest,
    [switch]$Run
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'workspace-env.ps1')
$migrationWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$migrationAgents = @('claude_code', 'codex', 'hermes', 'oh_my_pi', 'opencode', 'zcode', 'workbuddy', 'deepseek_harness')
$migrationSystemVariables = @('SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'USERNAME', 'USERDOMAIN')
$migrationSecrets = [Collections.Generic.HashSet[string]]::new()
$migrationProcesses = [Collections.Generic.List[object]]::new()
$migrationFakeKey = 'AE_SWITCH_SYNTHETIC_INVALID_DIRECTORY_MIGRATION_KEY'
$migrationSyntheticBaseUrl = if ($ApplicationOnly) { 'http://127.0.0.1:9/api' } else { 'https://invalid.example/api' }
$null = $migrationSecrets.Add($migrationFakeKey)

function Assert-MigrationGPath([string]$Value) {
    if ($Value -notmatch '^[Gg]:[\\/]' -or $Value -match '(^|[\\/])\.\.([\\/]|$)' -or $Value.IndexOfAny([char[]]@('"', "`r", "`n", [char]0)) -ge 0) { throw 'Expected an ordinary absolute G path without traversal.' }
    [IO.Path]::GetFullPath($Value).TrimEnd('\')
}

function Assert-MigrationChild([string]$Parent, [string]$Child) {
    $migrationParent = Assert-MigrationGPath $Parent
    $migrationChild = Assert-MigrationGPath $Child
    if (-not $migrationChild.StartsWith($migrationParent + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'A path escaped its exact expected parent.' }
}

function Assert-MigrationOrdinaryAncestors([string]$Value) {
    $migrationAncestor = Assert-MigrationGPath $Value
    while ($migrationAncestor) {
        if ([IO.File]::Exists($migrationAncestor) -or [IO.Directory]::Exists($migrationAncestor)) {
            if (([IO.File]::GetAttributes($migrationAncestor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'A path uses a reparse point.' }
        }
        $migrationAncestor = [IO.Path]::GetDirectoryName($migrationAncestor)
    }
}

function Get-MigrationTree([string]$Root) {
    Assert-MigrationOrdinaryAncestors $Root
    $migrationEntries = [Collections.Generic.List[object]]::new()
    $migrationPending = [Collections.Generic.Stack[string]]::new()
    $migrationPending.Push($Root)
    while ($migrationPending.Count) {
        $migrationCurrent = $migrationPending.Pop()
        foreach ($migrationEntry in [IO.Directory]::EnumerateFileSystemEntries($migrationCurrent)) {
            Assert-MigrationChild $Root $migrationEntry
            $migrationAttributes = [IO.File]::GetAttributes($migrationEntry)
            if (($migrationAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'A tree entry uses a reparse point.' }
            $migrationIsDirectory = ($migrationAttributes -band [IO.FileAttributes]::Directory) -ne 0
            $migrationEntries.Add([pscustomobject]@{ path = $migrationEntry; directory = $migrationIsDirectory })
            if ($migrationIsDirectory) { $migrationPending.Push($migrationEntry) }
        }
    }
    $migrationEntries.ToArray()
}

function Get-MigrationHash([string]$File) {
    $migrationHasher = [Security.Cryptography.SHA256]::Create()
    $migrationStream = [IO.File]::OpenRead($File)
    try { [Convert]::ToHexString($migrationHasher.ComputeHash($migrationStream)).ToLowerInvariant() }
    finally { $migrationStream.Dispose(); $migrationHasher.Dispose() }
}

function Assert-MigrationAgents($Ids) {
    if (@($Ids).Count -ne $migrationAgents.Count -or (@($Ids | Sort-Object -Unique).Count -ne $migrationAgents.Count) -or (Compare-Object @($Ids | Sort-Object) @($migrationAgents | Sort-Object))) { throw 'Expected exactly the eight distinct supported agents.' }
}

function Get-MigrationSnapshotDiff($Before, $After) {
    $migrationBeforeMap = @{}; $migrationAfterMap = @{}
    foreach ($migrationEntry in $Before) { $migrationBeforeMap[$migrationEntry.path] = $migrationEntry }
    foreach ($migrationEntry in $After) { $migrationAfterMap[$migrationEntry.path] = $migrationEntry }
    foreach ($migrationPath in @(@($migrationBeforeMap.Keys) + @($migrationAfterMap.Keys) | Sort-Object -Unique)) {
        $migrationOld = $migrationBeforeMap[$migrationPath]; $migrationNew = $migrationAfterMap[$migrationPath]
        $migrationReason = if (-not $migrationOld) { 'added' } elseif (-not $migrationNew) { 'removed' } elseif ($migrationOld.sha256 -cne $migrationNew.sha256 -or $migrationOld.length -ne $migrationNew.length -or $migrationOld.directory -ne $migrationNew.directory) { 'changed' } else { $null }
        if ($migrationReason) { [pscustomobject]@{ path = $migrationPath; reason = $migrationReason; before = $migrationOld; after = $migrationNew } }
    }
}

function Assert-MigrationSnapshot($Before, $After, [string]$Phase = 'persisted-data') {
    if (@(Get-MigrationSnapshotDiff $Before $After).Count) { throw "${Phase}: persisted data path/type/length/SHA256 changed." }
}

function Get-MigrationSqliteHeader([byte[]]$Header) {
    if ($Header.Length -lt 100 -or [Text.Encoding]::ASCII.GetString($Header, 0, 16) -cne "SQLite format 3`0") { throw 'The provider database did not have a valid SQLite signature/header.' }
    $migrationCounter = [uint64]0; $migrationValidFor = [uint64]0
    foreach ($migrationByte in $Header[24..27]) { $migrationCounter = ($migrationCounter -shl 8) -bor $migrationByte }
    foreach ($migrationByte in $Header[92..95]) { $migrationValidFor = ($migrationValidFor -shl 8) -bor $migrationByte }
    [ordered]@{ signatureVerified = $true; changeCounter = $migrationCounter; versionValidFor = $migrationValidFor }
}

function Get-MigrationSqliteMetadata([string]$File) {
    $migrationSqliteStream = [IO.File]::OpenRead($File)
    $migrationPayloadHasher = [Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256)
    try {
        $migrationHeaderBytes = [byte[]]::new(100)
        $migrationSqliteStream.ReadExactly($migrationHeaderBytes)
        $migrationSqliteMetadata = Get-MigrationSqliteHeader $migrationHeaderBytes
        foreach ($migrationOffset in @(24, 25, 26, 27, 92, 93, 94, 95)) { $migrationHeaderBytes[$migrationOffset] = 0 }
        $migrationPayloadHasher.AppendData($migrationHeaderBytes)
        $migrationSqliteBuffer = [byte[]]::new(65536)
        while (($migrationReadCount = $migrationSqliteStream.Read($migrationSqliteBuffer, 0, $migrationSqliteBuffer.Length)) -gt 0) { $migrationPayloadHasher.AppendData($migrationSqliteBuffer, 0, $migrationReadCount) }
        $migrationSqliteMetadata.headerCountersExcludedSha256 = [Convert]::ToHexString($migrationPayloadHasher.GetHashAndReset()).ToLowerInvariant()
        $migrationSqliteMetadata
    } finally { $migrationPayloadHasher.Dispose(); $migrationSqliteStream.Dispose() }
}

function Test-MigrationSqliteCounterChange($Difference) {
    if ($Difference.path -cne 'uni-switch.db' -or $Difference.reason -cne 'changed' -or -not $Difference.before -or -not $Difference.after -or $Difference.before.directory -or $Difference.after.directory -or $Difference.before.length -ne $Difference.after.length) { return $false }
    $migrationSqliteBefore = $Difference.before.sqliteMetadata; $migrationSqliteAfter = $Difference.after.sqliteMetadata
    if (-not $migrationSqliteBefore -or -not $migrationSqliteAfter -or $migrationSqliteBefore.signatureVerified -ne $true -or $migrationSqliteAfter.signatureVerified -ne $true) { return $false }
    if ($migrationSqliteBefore.changeCounter -ne $migrationSqliteBefore.versionValidFor -or $migrationSqliteAfter.changeCounter -ne $migrationSqliteAfter.versionValidFor -or $migrationSqliteBefore.changeCounter -ge [uint32]::MaxValue -or $migrationSqliteBefore.changeCounter -lt 0) { return $false }
    if ($migrationSqliteAfter.changeCounter -ne ($migrationSqliteBefore.changeCounter + 1) -or $migrationSqliteAfter.changeCounter -gt [uint32]::MaxValue) { return $false }
    $migrationPayloadBefore = [string]$migrationSqliteBefore.headerCountersExcludedSha256
    $migrationPayloadAfter = [string]$migrationSqliteAfter.headerCountersExcludedSha256
    $migrationPayloadBefore -cmatch '^[a-f0-9]{64}$' -and $migrationPayloadAfter -ceq $migrationPayloadBefore
}

function Assert-MigrationPostLaunchSnapshot($Before, $After) {
    foreach ($migrationDifference in @(Get-MigrationSnapshotDiff $Before $After)) {
        if (-not (Test-MigrationSqliteCounterChange $migrationDifference)) { throw 'post-launch-persisted-configuration: persisted provider/config/auth data changed beyond the expected SQLite header counters.' }
    }
}

function Get-MigrationExpectedDatabaseChange($Differences) {
    $migrationExpectedDatabaseChanges = @($Differences | Where-Object { Test-MigrationSqliteCounterChange $_ })
    if ($migrationExpectedDatabaseChanges.Count -ne 1) { throw 'post-launch-provider-database: the single overview did not produce exactly the expected paired SQLite header increment.' }
    $migrationExpectedDatabaseChanges[0]
}

function Select-MigrationPersistedSnapshot($Snapshot) {
    @($Snapshot | Where-Object {
        ($_.path -in @('agent-selection.json', 'uni-switch.db', 'uni-switch.db-wal', 'protocol-bridge.json') -or $_.path -match '^config(?:/|$)' -or $_.path -match '^agents/[^/]+/(launch\.(ps1|cmd)$|configuration(?:/|$)|home/\.(claude|codex|hermes|omp|workbuddy|dsh)(?:/|$))') -and
        $_.path -notmatch '^agents/codex/home/\.codex/tmp(?:/|$)'
    })
}

function Write-MigrationCheckpoint {
    Assert-MigrationOrdinaryAncestors $migrationProgressFile
    if ($migrationProgressExpectedText) {
        Assert-MigrationMarker ([IO.File]::ReadAllText($migrationProgressFile)) $migrationProgressExpectedText
    } elseif ([IO.File]::Exists($migrationProgressFile) -or [IO.Directory]::Exists($migrationProgressFile)) {
        throw 'A fresh migration progress receipt cannot overwrite another receipt.'
    }
    $migrationProgressExpectedText = ($migrationReport | ConvertTo-Json -Depth 18) + "`n"
    [IO.File]::WriteAllText($migrationProgressFile, $migrationProgressExpectedText, [Text.UTF8Encoding]::new($false))
    $script:migrationProgressExpectedText = $migrationProgressExpectedText
}

function Get-MigrationSnapshot([string]$Data) {
    @(Get-MigrationTree $Data | ForEach-Object {
        $migrationRelative = [IO.Path]::GetRelativePath($Data, $_.path).Replace('\', '/')
        $migrationSnapshotEntry = [pscustomobject]@{ path = $migrationRelative; directory = $_.directory; length = if ($_.directory) { 0 } else { ([IO.FileInfo]::new($_.path)).Length }; sha256 = if ($_.directory) { $null } else { Get-MigrationHash $_.path } }
        if (-not $_.directory -and $migrationRelative -ceq 'uni-switch.db') { $migrationSnapshotEntry | Add-Member -NotePropertyName sqliteMetadata -NotePropertyValue (Get-MigrationSqliteMetadata $_.path) }
        $migrationSnapshotEntry
    } | Sort-Object path)
}

function Assert-MigrationMarker([string]$Actual, [string]$Expected) {
    if ($Actual -cne $Expected) { throw 'The exact UUID owner marker changed; mutation refused.' }
}

function Assert-MigrationQuiescent {
    foreach ($migrationIdentity in $migrationProcesses) {
        if (-not $migrationIdentity.process.HasExited) { throw 'A directly created process is still active; movement and deletion refused.' }
    }
    $migrationReferenced = @(Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%$migrationId%' OR ExecutablePath LIKE '%$migrationId%'" | Where-Object { $_.ProcessId -ne $PID })
    if ($migrationReferenced.Count) { throw 'A process still references this exact UUID root; no process was terminated.' }
}

function Get-MigrationSystemEnvironment([scriptblock]$ReadVariable) {
    $migrationEnvironment = @{}
    foreach ($migrationName in $migrationSystemVariables) {
        $migrationValue = & $ReadVariable $migrationName
        if ($migrationValue) { $migrationEnvironment[$migrationName] = $migrationValue }
    }
    if ([string]::IsNullOrWhiteSpace([string]$migrationEnvironment.USERNAME)) { throw 'Windows file permissions require the inherited user identity; no directories were created.' }
    $migrationEnvironment
}

function New-MigrationEnvironment([string]$Runtime) {
    $migrationEnvironment = Get-MigrationSystemEnvironment { param($migrationName) [Environment]::GetEnvironmentVariable($migrationName, 'Process') }
    foreach ($migrationRelative in @('home', 'appdata', 'localappdata', 'tmp', 'config', 'cache', 'state')) { $null = [IO.Directory]::CreateDirectory((Join-Path $Runtime $migrationRelative)) }
    $migrationEnvironment.PATH = $migrationSystemPath
    foreach ($migrationPair in @(@('HOME', 'home'), @('USERPROFILE', 'home'), @('APPDATA', 'appdata'), @('LOCALAPPDATA', 'localappdata'), @('TEMP', 'tmp'), @('TMP', 'tmp'), @('XDG_CONFIG_HOME', 'config'), @('XDG_DATA_HOME', 'home'), @('XDG_CACHE_HOME', 'cache'), @('XDG_STATE_HOME', 'state'))) { $migrationEnvironment[$migrationPair[0]] = Join-Path $Runtime $migrationPair[1] }
    $migrationEnvironment.AE_SWITCH_SYSTEM_INTEGRATION_ISOLATED = '1'
    $migrationEnvironment.PYTHONDONTWRITEBYTECODE = '1'
    $migrationEnvironment.PYTHONUTF8 = '1'
    $migrationEnvironment.CI = '1'
    $migrationEnvironment.npm_config_update_notifier = 'false'
    $migrationEnvironment.HTTPS_PROXY = 'http://127.0.0.1:9'
    $migrationEnvironment.HTTP_PROXY = 'http://127.0.0.1:9'
    $migrationEnvironment.NO_PROXY = '127.0.0.1,localhost,::1'
    $migrationEnvironment
}

function Initialize-MigrationOutputCapture {
    if ('AePortableMigrationCapture' -as [type]) { return }
    Add-Type -TypeDefinition @'
public sealed class AePortableMigrationCapture {
    public string Text { get; private set; } = "";
    private volatile bool exceeded;
    public bool Exceeded { get { return exceeded; } }
    public async System.Threading.Tasks.Task ReadAsync(System.IO.StreamReader reader, int limit) {
        var text = new System.Text.StringBuilder();
        var buffer = new char[4096];
        int storedBytes = 0;
        int count;
        while ((count = await reader.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) != 0) {
            int remaining = limit - storedBytes;
            int low = 0, high = remaining == 0 ? 0 : count;
            while (low < high) {
                int middle = (low + high + 1) / 2;
                if (System.Text.Encoding.UTF8.GetByteCount(buffer, 0, middle) <= remaining) low = middle;
                else high = middle - 1;
            }
            if (low != 0) {
                storedBytes += System.Text.Encoding.UTF8.GetByteCount(buffer, 0, low);
                text.Append(buffer, 0, low);
            }
            if (low < count) { exceeded = true; storedBytes = limit; }
        }
        Text = text.ToString();
    }
}
'@
}

function Invoke-MigrationProcess([string]$Executable, [string[]]$Arguments, [hashtable]$Environment, [string]$WorkingDirectory, [string]$InputText = '', [int]$TimeoutSeconds = 120) {
    Initialize-MigrationOutputCapture
    $migrationStart = [Diagnostics.ProcessStartInfo]::new($Executable)
    $migrationStart.UseShellExecute = $false
    $migrationStart.CreateNoWindow = $true
    $migrationStart.WorkingDirectory = $WorkingDirectory
    $migrationStart.RedirectStandardInput = $true
    $migrationStart.RedirectStandardOutput = $true
    $migrationStart.RedirectStandardError = $true
    $migrationStart.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $migrationStart.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    $migrationStart.Environment.Clear()
    foreach ($migrationPair in $Environment.GetEnumerator()) { $migrationStart.Environment[$migrationPair.Key] = [string]$migrationPair.Value }
    foreach ($migrationArgument in $Arguments) { $migrationStart.ArgumentList.Add($migrationArgument) }
    $migrationProcess = [Diagnostics.Process]::new()
    $migrationProcess.StartInfo = $migrationStart
    if (-not $migrationProcess.Start()) { throw 'A directly owned child process did not start.' }
    $migrationIdentity = [pscustomobject]@{ process = $migrationProcess; pid = $migrationProcess.Id; startedAt = $migrationProcess.StartTime.ToUniversalTime().ToString('o'); executable = $Executable }
    $migrationProcesses.Add($migrationIdentity)
    $migrationOutputCapture = [AePortableMigrationCapture]::new()
    $migrationErrorCapture = [AePortableMigrationCapture]::new()
    $migrationStdout = $migrationOutputCapture.ReadAsync($migrationProcess.StandardOutput, 1048576)
    $migrationStderr = $migrationErrorCapture.ReadAsync($migrationProcess.StandardError, 1048576)
    $migrationProcess.StandardInput.Write($InputText)
    $migrationProcess.StandardInput.Close()
    if (-not $migrationProcess.WaitForExit($TimeoutSeconds * 1000)) { throw 'An owned process timed out. No recursive termination or cleanup was attempted.' }
    if (-not $migrationStdout.Wait(5000) -or -not $migrationStderr.Wait(5000)) { throw 'Owned output pipes remain open; directory movement and cleanup refused.' }
    if ($migrationOutputCapture.Exceeded -or $migrationErrorCapture.Exceeded) { throw 'Owned process output exceeded the live bounded evidence capture; the root is retained without process termination.' }
    $migrationOutput = $migrationOutputCapture.Text
    $migrationError = $migrationErrorCapture.Text
    [pscustomobject]@{ exitCode = $migrationProcess.ExitCode; stdout = $migrationOutput; stderr = $migrationError; pid = $migrationIdentity.pid; startedAt = $migrationIdentity.startedAt; exited = $migrationProcess.HasExited }
}

function Assert-MigrationHashBinding($Manifest, [string]$DesktopExpected, [string]$CliExpected, [string]$DesktopActual, [string]$CliActual) {
    foreach ($migrationTriple in @(@($Manifest.desktopSha256, $DesktopExpected, $DesktopActual), @($Manifest.cliSha256, $CliExpected, $CliActual))) {
        foreach ($migrationDigest in $migrationTriple) { if ([string]$migrationDigest -notmatch '^[a-fA-F0-9]{64}$') { throw 'Manifest, parameters and actual executable hashes must each be valid SHA256 values.' } }
        if ($migrationTriple[0] -ine $migrationTriple[1] -or $migrationTriple[1] -ine $migrationTriple[2]) { throw 'Package manifest, frozen parameters and actual root executable hashes did not agree.' }
    }
}

function Assert-MigrationExecutables([string]$Package) {
    $migrationManifestPath = Join-Path $Package 'package-manifest.json'
    Assert-MigrationOrdinaryAncestors $migrationManifestPath
    $migrationManifest = [IO.File]::ReadAllText($migrationManifestPath) | ConvertFrom-Json
    $migrationExecutableHashes = @{}
    foreach ($migrationPair in @(@('AE-Switch.exe', $DesktopSha256), @('AE-Switch-core.exe', $CliSha256))) {
        $migrationExe = Join-Path $Package $migrationPair[0]
        Assert-MigrationOrdinaryAncestors $migrationExe
        $migrationExecutableHashes[$migrationPair[0]] = Get-MigrationHash $migrationExe
    }
    Assert-MigrationHashBinding $migrationManifest $DesktopSha256 $CliSha256 $migrationExecutableHashes['AE-Switch.exe'] $migrationExecutableHashes['AE-Switch-core.exe']
}

function Assert-MigrationApplicationManifest($Manifest) {
    if ($Manifest.agentProgramsBundled -ne $false -or @($Manifest.tools).Count -ne 0 -or $Manifest.buildAuditId -cnotmatch '^[a-f0-9]{32}$' -or $Manifest.sourceDigest -cnotmatch '^[a-f0-9]{64}$') { throw 'Application-only migration requires an AE-only package with an exact build/source binding.' }
}

function Get-MigrationBuildBinding($Manifest) {
    Assert-MigrationApplicationManifest $Manifest
    # Prefer the immutable installed-client acceptance archive. Fresh release
    # audits are retained under .cache until their current-build evidence is
    # promoted, so allow that exact audit directory as a provenance-equivalent
    # fallback while keeping the same receipt and source-hash checks below.
    $migrationAuditCandidates = @(
        (Join-Path $migrationWorkspace "artifacts/acceptance/installed-client-checks-$($Manifest.buildAuditId)")
        (Join-Path $migrationWorkspace ".cache/release-audit-current-$($Manifest.buildAuditId)")
    )
    $migrationAudit = $null
    foreach ($migrationCandidate in $migrationAuditCandidates) {
        Assert-MigrationChild $migrationWorkspace $migrationCandidate
        Assert-MigrationOrdinaryAncestors $migrationCandidate
        if ((Test-Path -LiteralPath (Join-Path $migrationCandidate 'build-receipt.json') -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $migrationCandidate 'build-source-before.json') -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $migrationCandidate 'build-release-audit-outputs.json') -PathType Leaf)) {
            $migrationAudit = $migrationCandidate
            break
        }
    }
    if (-not $migrationAudit) { throw 'No complete current build binding receipts were found for the package audit ID.' }
    $migrationBuildFile = Join-Path $migrationAudit 'build-receipt.json'
    $migrationSnapshotFile = Join-Path $migrationAudit 'build-source-before.json'
    $migrationOutputsFile = Join-Path $migrationAudit 'build-release-audit-outputs.json'
    $migrationBuild = [IO.File]::ReadAllText($migrationBuildFile) | ConvertFrom-Json
    $migrationBuildSnapshot = [IO.File]::ReadAllText($migrationSnapshotFile) | ConvertFrom-Json
    $migrationBuildOutputs = @([IO.File]::ReadAllText($migrationOutputsFile) | ConvertFrom-Json)
    if ($migrationBuild.passed -ne $true -or $migrationBuild.sourceUnchanged -ne $true -or $migrationBuild.id -cne $Manifest.buildAuditId -or $migrationBuild.sourceDigest -cne $Manifest.sourceDigest -or $migrationBuildSnapshot.digest -cne $Manifest.sourceDigest) { throw 'The current application source and package did not bind to a passing build receipt.' }
    foreach ($migrationBinary in @(@('desktop', $DesktopSha256), @('core', $CliSha256))) {
        $migrationOutput = @($migrationBuildOutputs | Where-Object name -CEQ $migrationBinary[0])
        if ($migrationOutput.Count -ne 1 -or $migrationOutput[0].sha256 -cne $migrationBinary[1]) { throw 'A frozen application executable did not match the audited build output.' }
    }
    $migrationProductionFiles = @($migrationBuildSnapshot.files)
    if (-not $migrationProductionFiles.Count) { throw 'The build snapshot contains no production source files.' }
    foreach ($migrationEntry in $migrationProductionFiles) {
        $migrationCurrentFile = Join-Path $migrationWorkspace $migrationEntry.path
        Assert-MigrationChild $migrationWorkspace $migrationCurrentFile
        Assert-MigrationOrdinaryAncestors $migrationCurrentFile
        if ((Get-MigrationHash $migrationCurrentFile) -cne $migrationEntry.sha256) { throw 'A production source file differs from the exact executable build snapshot.' }
    }
    [ordered]@{ buildAuditId = $Manifest.buildAuditId; sourceDigest = $Manifest.sourceDigest; buildAuditPath = $migrationAudit; buildReceiptSha256 = Get-MigrationHash $migrationBuildFile; buildSourceSnapshotSha256 = Get-MigrationHash $migrationSnapshotFile; buildOutputsSha256 = Get-MigrationHash $migrationOutputsFile; productionFilesChecked = $migrationProductionFiles.Count; productionSourceMatchesBuild = $true }
}

function Assert-MigrationApplicationOverview($Overview, [string]$Package, [string]$ProviderId) {
    if ($Overview.hub.dataDirectory -ine (Join-Path $Package 'data')) { throw 'Application data did not follow the executable directory.' }
    Assert-MigrationAgents @($Overview.hub.agents.id)
    foreach ($migrationAgent in $Overview.hub.agents) {
        if ($migrationAgent.configured -ne $false -or $migrationAgent.profile -or $migrationAgent.launcher -or $migrationAgent.providerId -or $migrationAgent.directory -ine (Join-Path $Package "data/agents/$($migrationAgent.id)")) { throw 'An application-only migration must not configure or select a client profile.' }
    }
    $migrationProviders = @($Overview.providers)
    if ($migrationProviders.Count -ne 1 -or $migrationProviders[0].id -cne $ProviderId -or $migrationProviders[0].model -cne 'synthetic-model' -or $migrationProviders[0].baseUrl -cne $migrationSyntheticBaseUrl -or $migrationProviders[0].hasKey -ne $true) { throw 'The same synthetic provider ID, endpoint, model and saved-key presence were not reopened.' }
}

function Invoke-MigrationApplicationOverview([string]$Package, [string]$Stage, $Environment, [string]$Runtime, [string]$ProviderId) {
    $migrationOverviewRun = Invoke-MigrationProcess (Join-Path $Package 'AE-Switch-core.exe') @('overview') $Environment $Runtime '' 30
    if ($migrationOverviewRun.exitCode -ne 0) { throw 'The application-only CLI overview failed.' }
    Assert-MigrationApplicationOverview ($migrationOverviewRun.stdout | ConvertFrom-Json) $Package $ProviderId
    $migrationEntry = [ordered]@{ stage = $Stage; command = 'overview'; pid = $migrationOverviewRun.pid; startedAt = $migrationOverviewRun.startedAt; exitCode = $migrationOverviewRun.exitCode; exited = $migrationOverviewRun.exited; passed = $true; dataRootFollowsExecutable = $true; providerId = $ProviderId; providerModelReopened = $true; savedKeyPresenceReopened = $true; unconfiguredAgentCount = $migrationAgents.Count; clientDiscoveryInvoked = $false; clientProgramsExecuted = $false }
    $migrationReport.actualCoreExecutions += $migrationEntry
    Write-MigrationCheckpoint
    $migrationEntry
}

function Assert-MigrationObservation($Observation, [string]$Package, [string]$Agent, [string]$PreviousPackage = '') {
    $migrationAgentRoot = Join-Path $Package "data/agents/$Agent"
    if ($Observation.exitCode -ne 0 -or $Observation.credentialValuesRecorded -ne $false -or $Observation.cwd -ine (Join-Path $migrationAgentRoot 'workspace')) { throw 'The actual launcher observation was invalid.' }
    if ($Observation.paths.AE_AGENT_ROOT -ine $migrationAgentRoot -or $Observation.paths.AE_SWITCH_PORTABLE_ROOT -ine $Package) { throw 'The actual launcher did not rebase its agent/package roots.' }
    if ($Agent -ceq 'deepseek_harness') {
        foreach ($migrationDshPair in @(@('DSH_HOME', (Join-Path $migrationAgentRoot 'home/.dsh')), @('AE_DSH_RUNTIME', (Join-Path $Package 'tools/node/node.exe')), @('AE_DSH_ENTRY', (Join-Path $Package 'tools/agents/deepseek_harness/node_modules/@deepseek-ai/dsh/lib/bin.js')), @('AE_DSH_PWSH', (Join-Path $Package 'tools/pwsh/pwsh.exe')))) {
            $migrationDshActual = [string]$Observation.paths.($migrationDshPair[0])
            if ([string]::IsNullOrWhiteSpace($migrationDshActual) -or [IO.Path]::GetFullPath($migrationDshActual) -ine [IO.Path]::GetFullPath($migrationDshPair[1])) { throw 'The actual Harness launcher did not bind its required home/runtime/entry/PowerShell paths to the current package.' }
        }
    }
    foreach ($migrationProperty in $Observation.paths.PSObject.Properties | Where-Object { $null -ne $_.Value -and [string]$_.Value -ne '' }) {
        if ([string]$migrationProperty.Value -ine $Package) { Assert-MigrationChild $Package ([string]$migrationProperty.Value) }
    }
    if (-not @($Observation.binDirectories).Count) { throw 'The actual launcher omitted its bundled dependency paths.' }
    foreach ($migrationBin in $Observation.binDirectories) { Assert-MigrationChild $Package $migrationBin }
    if ($PreviousPackage) {
        foreach ($migrationValue in @($Observation.paths.PSObject.Properties.Value) + @($Observation.binDirectories) | Where-Object { $null -ne $_ }) {
            if ([string]$migrationValue -ieq $PreviousPackage -or ([string]$migrationValue).StartsWith($PreviousPackage + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'A launcher still used the original package directory.' }
        }
    }
}

function Invoke-MigrationVersions([string]$Package, [string]$Stage, [hashtable]$Environment, [string]$Runtime, [string]$PreviousPackage = '') {
    $migrationResults = @()
    foreach ($migrationAgent in $migrationAgents) {
        if ((Get-MigrationHash $migrationObserver) -cne $migrationObserverFrozenSha256) { throw 'The staged observer no longer matches the frozen source hash.' }
        $migrationLauncher = Join-Path $Package "data/agents/$migrationAgent/launch.ps1"
        $migrationEnvFile = Join-Path $Package "data/agents/$migrationAgent/configuration/environment.json"
        $migrationGeneratedEnvironment = [IO.File]::ReadAllText($migrationEnvFile) | ConvertFrom-Json
        foreach ($migrationProperty in $migrationGeneratedEnvironment.PSObject.Properties) {
            if ($migrationProperty.Name -match 'KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION' -and $migrationProperty.Value) { $null = $migrationSecrets.Add([string]$migrationProperty.Value) }
        }
        $migrationObservationPath = Join-Path $migrationRoot "observations/$Stage-$migrationAgent.json"
        $migrationVersion = Invoke-MigrationProcess $migrationPowerShell @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $migrationObserver, '-Launcher', $migrationLauncher, '-ObservationPath', $migrationObservationPath) $Environment $Runtime
        if ((Get-MigrationHash $migrationObserver) -cne $migrationObserverFrozenSha256) { throw 'The actual observer script changed during launcher execution.' }
        if ($migrationVersion.exitCode -ne 0 -or -not $migrationVersion.stdout.Trim()) { throw "An actual generated $migrationAgent --version entry failed in $Stage." }
        $migrationObservation = [IO.File]::ReadAllText($migrationObservationPath) | ConvertFrom-Json
        Assert-MigrationObservation $migrationObservation $Package $migrationAgent $PreviousPackage
        $migrationVersionLine = @($migrationVersion.stdout.Trim() -split '\r?\n')[0]
        foreach ($migrationSecret in $migrationSecrets) { $migrationVersionLine = $migrationVersionLine.Replace($migrationSecret, '<redacted>') }
        $migrationEntryResult = [ordered]@{ id = $migrationAgent; passed = $true; arguments = @('--version'); versionFirstLine = $migrationVersionLine; pid = $migrationVersion.pid; startedAt = $migrationVersion.startedAt; exited = $migrationVersion.exited; actualEffectivePaths = $migrationObservation; configurationSha256 = Get-MigrationHash $migrationEnvFile }
        $migrationResults += $migrationEntryResult
        $migrationReport.actualVersionExecutions += [ordered]@{ stage = $Stage; result = $migrationEntryResult }
        Write-MigrationCheckpoint
        [Console]::WriteLine(([ordered]@{ phase = 'actual-version-entry'; stage = $Stage; id = $migrationAgent; passed = $true } | ConvertTo-Json -Compress))
    }
    Assert-MigrationQuiescent
    $migrationResults
}

function Invoke-MigrationFresh([string]$Package, [string]$Stage) {
    Assert-MigrationExecutables $Package
    $migrationData = Join-Path $Package 'data'
    if ([IO.Directory]::Exists($migrationData) -or [IO.File]::Exists($migrationData)) { throw 'Fresh configuration refuses existing data.' }
    $migrationRuntime = Join-Path $migrationRoot "runtime/$Stage"
    $migrationEnvironment = New-MigrationEnvironment $migrationRuntime
    $migrationCli = Join-Path $Package 'AE-Switch-core.exe'
    if ($ApplicationOnly) {
        $migrationHelp = Invoke-MigrationProcess $migrationCli @('help') $migrationEnvironment $migrationRuntime '' 30
        if ($migrationHelp.exitCode -ne 0 -or $migrationHelp.stdout -notmatch 'Client programs are not bundled\.') { throw 'The AE-only CLI help failed.' }
        $migrationReport.actualCoreExecutions += [ordered]@{ stage = $Stage; command = 'help'; pid = $migrationHelp.pid; startedAt = $migrationHelp.startedAt; exitCode = 0; exited = $migrationHelp.exited; passed = $true }
    }
    $migrationInput = @{ id = $null; family = 'codex'; name = 'Synthetic directory migration acceptance'; baseUrl = $migrationSyntheticBaseUrl; apiKey = $migrationFakeKey; model = 'synthetic-model'; authMode = 'bearer'; reasoningEffort = $null; codexOptions = @{ upstreamProtocol = 'openai'; protocol = 'openai'; models = @(@{ id = 'synthetic-model'; enabled = $true; contextWindow = 128000; reasoningEfforts = @() }) } } | ConvertTo-Json -Depth 8 -Compress
    $migrationSaved = Invoke-MigrationProcess $migrationCli @('save-provider') $migrationEnvironment $migrationRuntime $migrationInput 30
    if ($migrationSaved.exitCode -ne 0) { throw 'Synthetic save-provider failed.' }
    $migrationProvider = $migrationSaved.stdout | ConvertFrom-Json
    if ($ApplicationOnly) {
        $migrationReport.actualCoreExecutions += [ordered]@{ stage = $Stage; command = 'save-provider'; pid = $migrationSaved.pid; startedAt = $migrationSaved.startedAt; exitCode = 0; exited = $migrationSaved.exited; passed = $true; providerId = $migrationProvider.id; endpointScope = 'localhost synthetic only'; networkInferenceInvoked = $false }
        return [ordered]@{ stage = $Stage; packageDirectory = $Package; providerId = $migrationProvider.id; syntheticCredentialsOnly = $true; saveProviderCalls = 1; configureAllCalls = 0; clientDiscoveryInvoked = $false; clientProgramsExecuted = $false; results = @(Invoke-MigrationApplicationOverview $Package $Stage $migrationEnvironment $migrationRuntime $migrationProvider.id); passed = $true }
    }
    $migrationConfigured = Invoke-MigrationProcess $migrationCli @('configure-all', $migrationProvider.id, 'synthetic-model') $migrationEnvironment $migrationRuntime '' 30
    if ($migrationConfigured.exitCode -ne 0) { throw 'Synthetic configure-all failed.' }
    $migrationConfiguredAgents = ($migrationConfigured.stdout | ConvertFrom-Json).agents
    Assert-MigrationAgents @($migrationConfiguredAgents.id)
    foreach ($migrationAgent in $migrationConfiguredAgents) {
        if ($migrationAgent.directory -ine (Join-Path $Package "data/agents/$($migrationAgent.id)")) { throw 'A generated agent directory escaped the package.' }
    }
    [ordered]@{ stage = $Stage; packageDirectory = $Package; providerId = $migrationProvider.id; syntheticCredentialsOnly = $true; saveProviderCalls = 1; configureAllCalls = 1; results = @(Invoke-MigrationVersions $Package $Stage $migrationEnvironment $migrationRuntime); passed = $true }
}

function Remove-MigrationOwnedTree([string]$Target, [switch]$WholeRoot) {
    Assert-MigrationQuiescent
    Assert-MigrationOrdinaryAncestors $migrationRoot
    Assert-MigrationMarker ([IO.File]::ReadAllText($migrationOwnerFile)) $migrationOwnerText
    if ($WholeRoot) { if ($Target -ine $migrationRoot) { throw 'Whole-root deletion target differed from the exact UUID root.' } }
    else { Assert-MigrationChild $migrationRoot $Target; if ($Target -ine (Join-Path $migrationSecondPackage 'data')) { throw 'Only this newly owned package data may be reset.' } }
    $migrationEntries = @(Get-MigrationTree $Target)
    foreach ($migrationEntry in @($migrationEntries | Where-Object { -not $_.directory -and $_.path -ine $migrationOwnerFile })) {
        Assert-MigrationOrdinaryAncestors $migrationEntry.path
        $migrationDeleteAttributes = [IO.File]::GetAttributes($migrationEntry.path)
        if (($migrationDeleteAttributes -band [IO.FileAttributes]::ReadOnly) -ne 0) { [IO.File]::SetAttributes($migrationEntry.path, ($migrationDeleteAttributes -band (-bnot [IO.FileAttributes]::ReadOnly))) }
        [IO.File]::Delete($migrationEntry.path)
    }
    foreach ($migrationEntry in @($migrationEntries | Where-Object directory | Sort-Object { $_.path.Length } -Descending)) {
        Assert-MigrationOrdinaryAncestors $migrationEntry.path
        [IO.Directory]::Delete($migrationEntry.path, $false)
    }
    if ($WholeRoot) { Assert-MigrationMarker ([IO.File]::ReadAllText($migrationOwnerFile)) $migrationOwnerText; [IO.File]::Delete($migrationOwnerFile) }
    [IO.Directory]::Delete($Target, $false)
    if ([IO.Directory]::Exists($Target) -or [IO.File]::Exists($Target)) { throw 'The newly owned deletion target remains.' }
    [ordered]@{ target = $Target; uuidMarkerVerified = $true; processQuiescencePassed = $true; ordinaryTreeAuditPassed = $true; recursiveDeletionUsed = $false; recursiveTerminationUsed = $false; removed = $true }
}

if ($SelfTest -and $Run) { throw 'Self-test and package execution are separate modes.' }
if ($SelfTest) {
    $migrationAssertions = 0
    $migrationTestRoot = 'G:\workspace\.cache\migration\11111111111111111111111111111111'
    Assert-MigrationChild $migrationTestRoot ($migrationTestRoot + '\中文 空格\data'); $migrationAssertions++
    foreach ($migrationBad in @('C:\outside', '\\server\share\a', 'G:\workspace\..\outside', $migrationTestRoot + '-other\data', $migrationTestRoot)) {
        $migrationRejected = $false; try { Assert-MigrationChild $migrationTestRoot $migrationBad } catch { $migrationRejected = $true }
        if (-not $migrationRejected) { throw 'Self-test accepted an escaping path.' }; $migrationAssertions++
    }
    Assert-MigrationAgents $migrationAgents; $migrationAssertions++
    foreach ($migrationBadIds in @(@('codex'), @('claude_code', 'codex', 'hermes', 'oh_my_pi', 'opencode', 'zcode', 'workbuddy'), @('claude_code', 'codex', 'hermes', 'oh_my_pi', 'opencode', 'zcode', 'workbuddy', 'codex'))) {
        $migrationRejected = $false; try { Assert-MigrationAgents $migrationBadIds } catch { $migrationRejected = $true }
        if (-not $migrationRejected) { throw 'Self-test accepted missing/duplicate agents.' }; $migrationAssertions++
    }
    Assert-MigrationMarker 'owned-exact-uuid' 'owned-exact-uuid'; $migrationAssertions++
    $migrationRejected = $false; try { Assert-MigrationMarker 'foreign' 'owned-exact-uuid' } catch { $migrationRejected = $true }
    if (-not $migrationRejected) { throw 'Self-test accepted a foreign marker.' }; $migrationAssertions++
    $migrationFixture = @([pscustomobject]@{ path = 'agents/codex/configuration/environment.json'; directory = $false; length = 7; sha256 = 'aaaa' })
    Assert-MigrationSnapshot $migrationFixture $migrationFixture; $migrationAssertions++
    foreach ($migrationChanged in @(@(), @([pscustomobject]@{ path = 'agents/codex/configuration/environment.json'; directory = $false; length = 7; sha256 = 'bbbb' }))) {
        $migrationRejected = $false; try { Assert-MigrationSnapshot $migrationFixture $migrationChanged } catch { $migrationRejected = $true }
        if (-not $migrationRejected) { throw 'Self-test accepted changed persisted data.' }; $migrationAssertions++
    }
    $migrationProtectedPaths = @('agent-selection.json', 'uni-switch.db', 'uni-switch.db-wal', 'protocol-bridge.json', 'config/settings.json', 'agents/codex/launch.ps1', 'agents/codex/launch.cmd', 'agents/codex/configuration/environment.json', 'agents/codex/home/.codex/config.toml', 'agents/codex/home/.codex/auth.json', 'agents/claude_code/home/.claude/settings.json', 'agents/workbuddy/home/.workbuddy/models.json', 'agents/deepseek_harness/home/.dsh/profiles/headless/cordis.patch.yml', 'agents/deepseek_harness/home/.dsh/profiles/headless/package.json', 'agents/deepseek_harness/home/.dsh/settings.json')
    foreach ($migrationProtectedPath in $migrationProtectedPaths) {
        $migrationProtectedBefore = @([pscustomobject]@{ path = $migrationProtectedPath; directory = $false; length = 7; sha256 = 'aaaa' })
        $migrationProtectedAfter = @([pscustomobject]@{ path = $migrationProtectedPath; directory = $false; length = 7; sha256 = 'bbbb' })
        $migrationRejected = $false; try { Assert-MigrationSnapshot (Select-MigrationPersistedSnapshot $migrationProtectedBefore) (Select-MigrationPersistedSnapshot $migrationProtectedAfter) 'post-launch-persisted-configuration' } catch { $migrationRejected = $_.Exception.Message.StartsWith('post-launch-persisted-configuration:') }
        if (-not $migrationRejected) { throw 'Self-test accepted changed provider/config/auth/selection/launcher data.' }; $migrationAssertions++
    }
    $migrationTmpBefore = @($migrationFixture; [pscustomobject]@{ path = 'agents/codex/home/.codex/tmp'; directory = $true; length = 0; sha256 = $null }; [pscustomobject]@{ path = 'agents/codex/home/.codex/tmp/arg0/codex-arg0Before/apply_patch.bat'; directory = $false; length = 171; sha256 = 'aaaa' })
    $migrationTmpAfter = @($migrationFixture; [pscustomobject]@{ path = 'agents/codex/home/.codex/tmp'; directory = $true; length = 0; sha256 = $null }; [pscustomobject]@{ path = 'agents/codex/home/.codex/tmp/arg0/codex-arg0After/apply_patch.bat'; directory = $false; length = 171; sha256 = 'bbbb' })
    Assert-MigrationSnapshot (Select-MigrationPersistedSnapshot $migrationTmpBefore) (Select-MigrationPersistedSnapshot $migrationTmpAfter) 'post-launch-persisted-configuration'; $migrationAssertions++
    if (@(Get-MigrationSnapshotDiff $migrationTmpBefore $migrationTmpAfter).Count -ne 2) { throw 'Self-test did not retain exact temporary added/removed path metadata.' }; $migrationAssertions++
    $migrationRejected = $false; try { Assert-MigrationSnapshot $migrationTmpBefore $migrationTmpAfter 'immediate-whole-data-move' } catch { $migrationRejected = $_.Exception.Message.StartsWith('immediate-whole-data-move:') }
    if (-not $migrationRejected) { throw 'Self-test relaxed the whole-data immediate-move assertion.' }; $migrationAssertions++
    function New-MigrationSqliteFixture([uint32]$Counter, [uint32]$ValidFor, [int]$MutationOffset = -1, [string]$Path = 'uni-switch.db') {
        $migrationFixtureBytes = [byte[]]::new(4096)
        [Array]::Copy([Text.Encoding]::ASCII.GetBytes("SQLite format 3`0"), $migrationFixtureBytes, 16)
        for ($migrationIndex = 0; $migrationIndex -lt 4; $migrationIndex++) {
            $migrationFixtureBytes[24 + $migrationIndex] = [byte](($Counter -shr ((3 - $migrationIndex) * 8)) -band 255)
            $migrationFixtureBytes[92 + $migrationIndex] = [byte](($ValidFor -shr ((3 - $migrationIndex) * 8)) -band 255)
        }
        if ($MutationOffset -ge 0) { $migrationFixtureBytes[$MutationOffset] = 1 }
        $migrationFixtureMetadata = Get-MigrationSqliteHeader $migrationFixtureBytes
        $migrationFixtureHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($migrationFixtureBytes)).ToLowerInvariant()
        foreach ($migrationOffset in @(24, 25, 26, 27, 92, 93, 94, 95)) { $migrationFixtureBytes[$migrationOffset] = 0 }
        $migrationFixtureMetadata.headerCountersExcludedSha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($migrationFixtureBytes)).ToLowerInvariant()
        [pscustomobject]@{ path = $Path; directory = $false; length = 4096; sha256 = $migrationFixtureHash; sqliteMetadata = $migrationFixtureMetadata }
    }
    $migrationSqliteBefore = @(New-MigrationSqliteFixture 3 3)
    $migrationSqliteExpectedAfter = @(New-MigrationSqliteFixture 4 4)
    Assert-MigrationPostLaunchSnapshot $migrationSqliteBefore $migrationSqliteExpectedAfter; $migrationAssertions++
    $null = Get-MigrationExpectedDatabaseChange @(Get-MigrationSnapshotDiff $migrationSqliteBefore $migrationSqliteExpectedAfter); $migrationAssertions++
    $migrationRejected = $false; try { $null = Get-MigrationExpectedDatabaseChange @(Get-MigrationSnapshotDiff $migrationSqliteBefore $migrationSqliteBefore) } catch { $migrationRejected = $true }
    if (-not $migrationRejected) { throw 'Self-test accepted zero overview counter increment.' }; $migrationAssertions++
    $migrationRejected = $false; try { Assert-MigrationSnapshot $migrationSqliteBefore $migrationSqliteExpectedAfter 'immediate-whole-data-move' } catch { $migrationRejected = $true }
    if (-not $migrationRejected) { throw 'Self-test allowed SQLite metadata changes during the immediate move.' }; $migrationAssertions++
    foreach ($migrationSqliteBadAfter in @((New-MigrationSqliteFixture 4 4 120), (New-MigrationSqliteFixture 4 4 60), (New-MigrationSqliteFixture 4 3), (New-MigrationSqliteFixture 5 5), (New-MigrationSqliteFixture 2 2))) {
        $migrationRejected = $false; try { Assert-MigrationPostLaunchSnapshot $migrationSqliteBefore @($migrationSqliteBadAfter) } catch { $migrationRejected = $true }
        if (-not $migrationRejected) { throw 'Self-test accepted changed SQLite payload/schema or incorrect header counters.' }; $migrationAssertions++
    }
    foreach ($migrationSqliteBadBefore in @((New-MigrationSqliteFixture 3 2), (New-MigrationSqliteFixture ([uint32]::MaxValue) ([uint32]::MaxValue)))) {
        $migrationRejected = $false; try { Assert-MigrationPostLaunchSnapshot @($migrationSqliteBadBefore) $migrationSqliteExpectedAfter } catch { $migrationRejected = $true }
        if (-not $migrationRejected) { throw 'Self-test accepted mismatched or overflowing initial SQLite counters.' }; $migrationAssertions++
    }
    foreach ($migrationSqliteWrongProperty in @('signatureVerified', 'length', 'directory')) {
        $migrationSqliteWrongAfter = New-MigrationSqliteFixture 4 4
        if ($migrationSqliteWrongProperty -eq 'signatureVerified') { $migrationSqliteWrongAfter.sqliteMetadata.signatureVerified = $false }
        elseif ($migrationSqliteWrongProperty -eq 'length') { $migrationSqliteWrongAfter.length++ }
        else { $migrationSqliteWrongAfter.directory = $true }
        $migrationRejected = $false; try { Assert-MigrationPostLaunchSnapshot $migrationSqliteBefore @($migrationSqliteWrongAfter) } catch { $migrationRejected = $true }
        if (-not $migrationRejected) { throw 'Self-test accepted SQLite signature/length/type changes.' }; $migrationAssertions++
    }
    $migrationRejected = $false; try { Assert-MigrationPostLaunchSnapshot @((New-MigrationSqliteFixture 3 3 -1 'config/provider.db')) @((New-MigrationSqliteFixture 4 4 -1 'config/provider.db')) } catch { $migrationRejected = $true }
    if (-not $migrationRejected) { throw 'Self-test allowed SQLite counter exceptions for another path.' }; $migrationAssertions++
    $migrationInvalidHeader = [byte[]]::new(100)
    $migrationRejected = $false; try { $null = Get-MigrationSqliteHeader $migrationInvalidHeader } catch { $migrationRejected = $true }
    if (-not $migrationRejected) { throw 'Self-test accepted an invalid SQLite signature.' }; $migrationAssertions++
    foreach ($migrationProtectedPath in $migrationProtectedPaths) {
        $migrationProtectedBefore = @([pscustomobject]@{ path = $migrationProtectedPath; directory = $false; length = 7; sha256 = 'aaaa' })
        $migrationProtectedAfter = @([pscustomobject]@{ path = $migrationProtectedPath; directory = $false; length = 7; sha256 = 'bbbb' })
        $migrationRejected = $false; try { Assert-MigrationPostLaunchSnapshot (Select-MigrationPersistedSnapshot $migrationProtectedBefore) (Select-MigrationPersistedSnapshot $migrationProtectedAfter) } catch { $migrationRejected = $true }
        if (-not $migrationRejected) { throw 'Self-test weakened provider/config/auth/selection/launcher protection with the database exception.' }; $migrationAssertions++
    }
    $migrationTestPackage = $migrationTestRoot + '\迁移以后 空格\AE Switch 便携包'
    $migrationTestAgent = $migrationTestPackage + '\data\agents\codex'
    $migrationTestObservation = [pscustomobject]@{ exitCode = 0; credentialValuesRecorded = $false; cwd = $migrationTestAgent + '\workspace'; paths = [pscustomobject]@{ AE_AGENT_ROOT = $migrationTestAgent; AE_SWITCH_PORTABLE_ROOT = $migrationTestPackage; HOME = $migrationTestAgent + '\home' }; binDirectories = @($migrationTestPackage + '\tools\node') }
    Assert-MigrationObservation $migrationTestObservation $migrationTestPackage 'codex' ($migrationTestRoot + '\旧目录'); $migrationAssertions++
    foreach ($migrationForeignPath in @('C:\client', $migrationTestRoot + '\旧目录\tools\node')) {
        $migrationTestObservation.binDirectories = @($migrationForeignPath)
        $migrationRejected = $false; try { Assert-MigrationObservation $migrationTestObservation $migrationTestPackage 'codex' ($migrationTestRoot + '\旧目录') } catch { $migrationRejected = $true }
        if (-not $migrationRejected) { throw 'Self-test accepted stale/foreign effective runtime paths.' }; $migrationAssertions++
    }
    $migrationDshAgentRoot = Join-Path $migrationTestPackage 'data/agents/deepseek_harness'
    $migrationDshObservation = [pscustomobject]@{ exitCode = 0; credentialValuesRecorded = $false; cwd = Join-Path $migrationDshAgentRoot 'workspace'; paths = [pscustomobject]@{ AE_AGENT_ROOT = $migrationDshAgentRoot; AE_SWITCH_PORTABLE_ROOT = $migrationTestPackage; DSH_HOME = Join-Path $migrationDshAgentRoot 'home/.dsh'; AE_DSH_RUNTIME = Join-Path $migrationTestPackage 'tools/node/node.exe'; AE_DSH_ENTRY = Join-Path $migrationTestPackage 'tools/agents/deepseek_harness/node_modules/@deepseek-ai/dsh/lib/bin.js'; AE_DSH_PWSH = Join-Path $migrationTestPackage 'tools/pwsh/pwsh.exe' }; binDirectories = @((Join-Path $migrationTestPackage 'tools/node'), (Join-Path $migrationTestPackage 'tools/pwsh')) }
    Assert-MigrationObservation $migrationDshObservation $migrationTestPackage 'deepseek_harness'; $migrationAssertions++
    foreach ($migrationDshVariable in @('DSH_HOME', 'AE_DSH_RUNTIME', 'AE_DSH_ENTRY', 'AE_DSH_PWSH')) {
        $migrationDshOriginal = $migrationDshObservation.paths.$migrationDshVariable
        foreach ($migrationDshBadValue in @($null, (Join-Path $migrationTestRoot '旧目录/foreign.exe'))) {
            $migrationDshObservation.paths.$migrationDshVariable = $migrationDshBadValue
            $migrationRejected = $false; try { Assert-MigrationObservation $migrationDshObservation $migrationTestPackage 'deepseek_harness' } catch { $migrationRejected = $true }
            if (-not $migrationRejected) { throw 'Self-test accepted a missing or stale Harness runtime path.' }; $migrationAssertions++
        }
        $migrationDshObservation.paths.$migrationDshVariable = $migrationDshOriginal
    }
    $migrationMockIdentity = Get-MigrationSystemEnvironment { param($migrationName) if ($migrationName -eq 'USERNAME') { 'synthetic-user' } elseif ($migrationName -eq 'USERDOMAIN') { 'synthetic-domain' } }
    if ($migrationMockIdentity.USERNAME -cne 'synthetic-user' -or $migrationMockIdentity.USERDOMAIN -cne 'synthetic-domain') { throw 'Self-test lost Windows permission identity.' }; $migrationAssertions++
    foreach ($migrationMissingIdentity in @({ param($migrationName) if ($migrationName -eq 'USERDOMAIN') { 'synthetic-domain' } }, { param($migrationName) if ($migrationName -eq 'USERNAME') { ' ' } })) {
        $migrationRejected = $false; try { $null = Get-MigrationSystemEnvironment $migrationMissingIdentity } catch { $migrationRejected = $true }
        if (-not $migrationRejected) { throw 'Self-test accepted a missing Windows permission identity.' }; $migrationAssertions++
    }
    $migrationApplicationManifest = [pscustomobject]@{ agentProgramsBundled = $false; tools = @(); buildAuditId = 'a' * 32; sourceDigest = 'b' * 64 }
    Assert-MigrationApplicationManifest $migrationApplicationManifest; $migrationAssertions++
    foreach ($migrationInvalidManifest in @(
        [pscustomobject]@{ agentProgramsBundled = $true; tools = @(); buildAuditId = 'a' * 32; sourceDigest = 'b' * 64 },
        [pscustomobject]@{ agentProgramsBundled = $false; tools = @('client'); buildAuditId = 'a' * 32; sourceDigest = 'b' * 64 },
        [pscustomobject]@{ tools = @(); buildAuditId = 'a' * 32; sourceDigest = 'b' * 64 },
        [pscustomobject]@{ agentProgramsBundled = $false; tools = @(); buildAuditId = '../audit'; sourceDigest = 'b' * 64 },
        [pscustomobject]@{ agentProgramsBundled = $false; tools = @(); buildAuditId = 'a' * 32; sourceDigest = 'short' }
    )) {
        $migrationRejected = $false; try { Assert-MigrationApplicationManifest $migrationInvalidManifest } catch { $migrationRejected = $true }
        if (-not $migrationRejected) { throw 'Self-test accepted an unbound or bundled application-only manifest.' }; $migrationAssertions++
    }
    $migrationApplicationOverview = [pscustomobject]@{
        hub = [pscustomobject]@{ dataDirectory = Join-Path $migrationTestPackage 'data'; agents = @($migrationAgents | ForEach-Object { [pscustomobject]@{ id = $_; configured = $false; profile = $null; launcher = $null; providerId = $null; directory = Join-Path $migrationTestPackage "data/agents/$_" } }) }
        providers = @([pscustomobject]@{ id = 'synthetic-provider'; model = 'synthetic-model'; baseUrl = $migrationSyntheticBaseUrl; hasKey = $true })
    }
    Assert-MigrationApplicationOverview $migrationApplicationOverview $migrationTestPackage 'synthetic-provider'; $migrationAssertions++
    foreach ($migrationOverviewMutation in @(
        { param($value) $value.hub.dataDirectory = 'G:\foreign\data' },
        { param($value) $value.hub.agents[0].configured = $true },
        { param($value) $value.hub.agents[0].profile = 'foreign-profile' },
        { param($value) $value.hub.agents[0].directory = 'G:\foreign\profile' },
        { param($value) $value.providers[0].id = 'another-provider' },
        { param($value) $value.providers[0].model = 'another-model' },
        { param($value) $value.providers[0].baseUrl = 'https://foreign.example/api' },
        { param($value) $value.providers[0].hasKey = $false },
        { param($value) $value.providers = @() }
    )) {
        $migrationInvalidOverview = $migrationApplicationOverview | ConvertTo-Json -Depth 8 | ConvertFrom-Json
        & $migrationOverviewMutation $migrationInvalidOverview
        $migrationRejected = $false; try { Assert-MigrationApplicationOverview $migrationInvalidOverview $migrationTestPackage 'synthetic-provider' } catch { $migrationRejected = $true }
        if (-not $migrationRejected) { throw 'Self-test accepted lost provider data or a selected/foreign client profile.' }; $migrationAssertions++
    }
    $migrationHashA = 'a' * 64; $migrationHashB = 'b' * 64; $migrationHashC = 'c' * 64
    $migrationManifestFixture = [pscustomobject]@{ desktopSha256 = $migrationHashA; cliSha256 = $migrationHashB }
    Assert-MigrationHashBinding $migrationManifestFixture $migrationHashA $migrationHashB $migrationHashA $migrationHashB; $migrationAssertions++
    Assert-MigrationHashBinding $migrationManifestFixture $migrationHashA.ToUpperInvariant() $migrationHashB.ToUpperInvariant() $migrationHashA $migrationHashB; $migrationAssertions++
    foreach ($migrationHashCase in @(
        @([pscustomobject]@{ desktopSha256 = $migrationHashC; cliSha256 = $migrationHashB }, $migrationHashA, $migrationHashB, $migrationHashA, $migrationHashB),
        @($migrationManifestFixture, $migrationHashA, $migrationHashC, $migrationHashA, $migrationHashB),
        @($migrationManifestFixture, $migrationHashA, $migrationHashB, $migrationHashC, $migrationHashB),
        @([pscustomobject]@{ desktopSha256 = 'short'; cliSha256 = $migrationHashB }, $migrationHashA, $migrationHashB, $migrationHashA, $migrationHashB),
        @([pscustomobject]@{ desktopSha256 = $migrationHashA }, $migrationHashA, $migrationHashB, $migrationHashA, $migrationHashB)
    )) {
        $migrationRejected = $false; try { Assert-MigrationHashBinding $migrationHashCase[0] $migrationHashCase[1] $migrationHashCase[2] $migrationHashCase[3] $migrationHashCase[4] } catch { $migrationRejected = $true }
        if (-not $migrationRejected) { throw 'Self-test accepted an inconsistent or missing package hash binding.' }; $migrationAssertions++
    }
    Initialize-MigrationOutputCapture
    foreach ($migrationCaptureCase in @(@(('a' * 64), 64, $false), @(('a' * 65), 64, $true), @(('汉' * 65), 64, $true))) {
        $migrationCaptureBytes = [Text.Encoding]::UTF8.GetBytes($migrationCaptureCase[0])
        $migrationCaptureStream = [IO.MemoryStream]::new($migrationCaptureBytes, $false)
        $migrationCaptureReader = [IO.StreamReader]::new($migrationCaptureStream, [Text.Encoding]::UTF8)
        try {
            $migrationCapture = [AePortableMigrationCapture]::new()
            $migrationCaptureTask = $migrationCapture.ReadAsync($migrationCaptureReader, $migrationCaptureCase[1])
            $null = $migrationCaptureTask.GetAwaiter().GetResult()
            if ($migrationCapture.Exceeded -ne $migrationCaptureCase[2] -or [Text.Encoding]::UTF8.GetByteCount($migrationCapture.Text) -gt $migrationCaptureCase[1]) { throw 'Self-test capture did not enforce its live byte limit.' }
            $migrationAssertions++
        } finally { $migrationCaptureReader.Dispose(); $migrationCaptureStream.Dispose() }
    }
    [ordered]@{ passed = $true; assertions = $migrationAssertions; packageCopied = $false; toolProgramsLaunched = $false; filesDeleted = 0; hostSettingsChanged = $false } | ConvertTo-Json -Compress
    exit 0
}

if (-not $Run) { throw 'Use -SelfTest while waiting for frozen hashes; -Run requires the newly frozen package hashes.' }
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'The migration driver requires PowerShell 7; agent launchers use Windows PowerShell.' }
if ($DesktopSha256 -notmatch '^[a-fA-F0-9]{64}$' -or $CliSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Both newly frozen root executable SHA256 values are required.' }
$migrationSource = Assert-MigrationGPath $PackageDirectory
Assert-MigrationChild $migrationWorkspace $migrationSource
Assert-MigrationOrdinaryAncestors $migrationSource
if ([IO.Directory]::Exists((Join-Path $migrationSource 'data')) -or [IO.File]::Exists((Join-Path $migrationSource 'data'))) { throw 'The source package contains data and will not be copied.' }
Assert-MigrationExecutables $migrationSource
$migrationSourceManifest = [IO.File]::ReadAllText((Join-Path $migrationSource 'package-manifest.json')) | ConvertFrom-Json
if (-not $ApplicationOnly -and $migrationSourceManifest.agentProgramsBundled -eq $false) { throw 'The current AE-only package requires -ApplicationOnly; bundled launcher acceptance is historical.' }
$migrationBuildBinding = if ($ApplicationOnly) { Get-MigrationBuildBinding $migrationSourceManifest } else { $null }
$migrationSourceEntries = @(Get-MigrationTree $migrationSource)
if ($ApplicationOnly -and @($migrationSourceEntries | Where-Object { [IO.Path]::GetRelativePath($migrationSource, $_.path).Replace('\', '/') -match '^tools/(agents|node|python|git|pwsh)(?:/|$)' }).Count) { throw 'The application-only source package contains a client or non-UI runtime.' }
$migrationId = [Guid]::NewGuid().ToString('N')
$migrationRoot = Assert-MigrationGPath (Join-Path $migrationWorkspace ".cache/portable-directory-migration/$migrationId")
Assert-MigrationChild $migrationWorkspace $migrationRoot
Assert-MigrationOrdinaryAncestors $migrationRoot
if ([IO.Directory]::Exists($migrationRoot) -or [IO.File]::Exists($migrationRoot)) { throw 'The UUID ownership root already exists.' }
$migrationFirstPackage = Join-Path $migrationRoot '初始位置 空格/AE Switch 便携包'
$migrationSecondPackage = Join-Path $migrationRoot '迁移以后 空格/AE Switch 便携包'
$migrationOwnerFile = Join-Path $migrationRoot '.ae-portable-directory-owner.json'
$migrationObserverSource = Join-Path $migrationWorkspace 'tests/acceptance/portable-launcher-observe.ps1'
$migrationObserver = Join-Path $migrationRoot 'portable-launcher-observe.ps1'
$migrationObserverFrozenSha256 = Get-MigrationHash $migrationObserverSource
$migrationWindows = [Environment]::GetEnvironmentVariable('SystemRoot')
$migrationPowerShell = Join-Path $migrationWindows 'System32/WindowsPowerShell/v1.0/powershell.exe'
$migrationSystemPath = @((Join-Path $migrationWindows 'System32'), $migrationWindows, (Split-Path -Parent $migrationPowerShell)) -join [IO.Path]::PathSeparator
$migrationReportFile = Join-Path $migrationWorkspace "artifacts/acceptance/portable-directory-migration-$migrationId.json"
$migrationProgressFile = Join-Path $migrationWorkspace "artifacts/acceptance/portable-directory-migration-$migrationId-progress.json"
$migrationProgressExpectedText = $null
$migrationReport = [ordered]@{ recordedAt = [DateTime]::UtcNow.ToString('o'); uuid = $migrationId; passed = $false; scope = 'Two local G directories with Chinese/spaces, synthetic configuration, eight actual bundled --version launchers, and retained-data byte-preserving move. No real inference or second-machine verification.'; sourcePackage = $migrationSource; desktopSha256 = $DesktopSha256; cliSha256 = $CliSha256; sourceManifestSha256 = Get-MigrationHash (Join-Path $migrationSource 'package-manifest.json'); manifestParameterExecutableBindingPassed = $true; sourceEntryCount = $migrationSourceEntries.Count; systemPathOnly = $true; noManuallyInjectedToolPaths = $true; productionCodeChanged = $false; realInferenceVerified = $false; differentComputerVerified = $false; stages = [ordered]@{}; cleanup = [ordered]@{ removed = $false; recursiveDeletionUsed = $false; recursiveTerminationUsed = $false } }
$migrationOwnerText = [ordered]@{ purpose = 'owned synthetic portable directory migration'; uuid = $migrationId; workspace = $migrationWorkspace; root = $migrationRoot; source = $migrationSource; desktopSha256 = $DesktopSha256; cliSha256 = $CliSha256 } | ConvertTo-Json -Compress
$migrationReport.actualVersionExecutions = @()
$migrationReport.applicationOnly = [bool]$ApplicationOnly
$migrationReport.actualCoreExecutions = @()
if ($ApplicationOnly) {
    $migrationReport.scope = 'AE-only package moved between two local G directories with Chinese/spaces. Synthetic localhost provider storage/reopen, complete retained-data move and fresh initialization; no client discovery, client configuration, client launch, inference, native GUI or second-machine verification.'
    $migrationReport.buildBinding = $migrationBuildBinding
    $migrationReport.expectedActualCoreCommandCount = 7
    $migrationReport.clientDiscoveryInvoked = $false
    $migrationReport.clientProgramsExecuted = $false
    $migrationReport.clientConfigurationInvoked = $false
    $migrationReport.syntheticEndpointScope = 'http://127.0.0.1:9/api only; no network command invoked'
}
$migrationReport.expectedAgentIds = $migrationAgents
$migrationReport.expectedActualVersionCount = if ($ApplicationOnly) { 0 } else { $migrationAgents.Count * 3 }
$migrationReport.progressReceipt = $migrationProgressFile
$migrationReport.driverSha256 = Get-MigrationHash $PSCommandPath
$migrationDriverFrozenSha256 = $migrationReport.driverSha256
$migrationReport.observerSha256 = $migrationObserverFrozenSha256
$null = [IO.Directory]::CreateDirectory($migrationRoot)
[IO.File]::WriteAllText($migrationOwnerFile, $migrationOwnerText, [Text.UTF8Encoding]::new($false))
try {
    foreach ($migrationDirectory in @($migrationFirstPackage, (Split-Path -Parent $migrationSecondPackage), (Join-Path $migrationRoot 'observations'))) { Assert-MigrationChild $migrationRoot $migrationDirectory; $null = [IO.Directory]::CreateDirectory($migrationDirectory) }
    if (-not $ApplicationOnly) {
        [IO.File]::Copy($migrationObserverSource, $migrationObserver, $false)
        if ((Get-MigrationHash $migrationObserver) -cne $migrationObserverFrozenSha256) { throw 'The copied observer did not match its frozen source hash.' }
        $migrationReport.executedObserverSha256 = $migrationObserverFrozenSha256
        $migrationReport.observerSourceCopyExecutionBindingPassed = $true
    }
    $migrationReport.outputCaptureLimitBytesPerStream = 1048576
    $migrationReport.outputCaptureBoundEnforcedWhileReading = $true
    $migrationCopyRuntime = Join-Path $migrationRoot 'runtime/copy'
    $migrationCopyEnvironment = New-MigrationEnvironment $migrationCopyRuntime
    [Console]::WriteLine(([ordered]@{ phase = 'complete-package-copy-started'; uuid = $migrationId } | ConvertTo-Json -Compress))
    $migrationCopy = Invoke-MigrationProcess (Join-Path $migrationWindows 'System32/robocopy.exe') @($migrationSource, $migrationFirstPackage, '/E', '/XJ', '/R:0', '/W:0', '/COPY:DAT', '/DCOPY:DAT', '/NFL', '/NDL', '/NJH', '/NJS', '/NP') $migrationCopyEnvironment $migrationCopyRuntime '' 1800
    if ($migrationCopy.exitCode -ge 8) { throw 'The complete package copy failed.' }
    $migrationCopiedEntries = @(Get-MigrationTree $migrationFirstPackage)
    if ($migrationCopiedEntries.Count -ne $migrationSourceEntries.Count) { throw 'The complete copied package entry count differed.' }
    $migrationReport.completePackageCopiedOnce = $true
    [Console]::WriteLine(([ordered]@{ phase = 'complete-package-copy-finished'; uuid = $migrationId; entries = $migrationCopiedEntries.Count } | ConvertTo-Json -Compress))
    $migrationReport.stages.freshBeforeMove = Invoke-MigrationFresh $migrationFirstPackage 'fresh-before-move'
    $migrationBefore = Get-MigrationSnapshot (Join-Path $migrationFirstPackage 'data')
    $migrationReport.dataMove = [ordered]@{ passed = $false; beforeSnapshot = $migrationBefore; afterSnapshot = @(); differences = @() }
    Write-MigrationCheckpoint
    Assert-MigrationQuiescent
    Assert-MigrationMarker ([IO.File]::ReadAllText($migrationOwnerFile)) $migrationOwnerText
    Assert-MigrationChild $migrationRoot $migrationFirstPackage
    Assert-MigrationChild $migrationRoot $migrationSecondPackage
    Assert-MigrationOrdinaryAncestors $migrationSecondPackage
    $null = @(Get-MigrationTree $migrationFirstPackage)
    if ([IO.Directory]::Exists($migrationSecondPackage) -or [IO.File]::Exists($migrationSecondPackage)) { throw 'The move destination already exists.' }
    [IO.Directory]::Move($migrationFirstPackage, $migrationSecondPackage)
    if ([IO.Directory]::Exists($migrationFirstPackage)) { throw 'The previous package directory still exists.' }
    Assert-MigrationExecutables $migrationSecondPackage
    $migrationAfter = Get-MigrationSnapshot (Join-Path $migrationSecondPackage 'data')
    $migrationReport.dataMove.afterSnapshot = $migrationAfter
    $migrationReport.dataMove.differences = @(Get-MigrationSnapshotDiff $migrationBefore $migrationAfter)
    Write-MigrationCheckpoint
    Assert-MigrationSnapshot $migrationBefore $migrationAfter 'immediate-whole-data-move'
    $migrationReport.dataMove.passed = $true
    [Console]::WriteLine(([ordered]@{ phase = 'retained-data-move-byte-verification'; uuid = $migrationId; entries = @($migrationBefore).Count; passed = $true } | ConvertTo-Json -Compress))
    $migrationMoveRuntime = Join-Path $migrationRoot 'runtime/preserved-after-move'
    $migrationMoveEnvironment = New-MigrationEnvironment $migrationMoveRuntime
    $migrationPersistedConfigBefore = @(Select-MigrationPersistedSnapshot $migrationBefore)
    $migrationReport.stages.preservedAfterMove = [ordered]@{ passed = $false; packageDirectory = $migrationSecondPackage; originalDirectoryAbsent = $true; saveProviderCalls = 0; configureAllCalls = 0; completeDataImmediatelyByteIdentical = $true; dataEntryCount = @($migrationBefore).Count; dataSnapshot = $migrationBefore; nonDatabaseConfigurationByteIdentical = $false; databasePayloadUnchanged = $false; expectedHeaderCounterIncrement = 1; rawDatabaseByteIdentical = $null; databaseHeaderCounterProof = $null; persistedConfigurationEntryCount = $migrationPersistedConfigBefore.Count; persistedConfigurationBeforeSnapshot = $migrationPersistedConfigBefore; persistedConfigurationAfterSnapshot = @(); persistedConfigurationDifferences = @(); runtimeDataDifferences = @(); excludedPostLaunchRuntimeSubtree = 'agents/codex/home/.codex/tmp'; originalSelectionsReopened = $false; results = @() }
    Write-MigrationCheckpoint
    if ($ApplicationOnly) {
        $migrationMovedResults = @(Invoke-MigrationApplicationOverview $migrationSecondPackage 'preserved-after-move' $migrationMoveEnvironment $migrationMoveRuntime $migrationReport.stages.freshBeforeMove.providerId)
        $migrationReport.stages.preservedAfterMove.originalProviderReopened = $true
        $migrationReport.stages.preservedAfterMove.savedKeyPresenceReopened = $true
        $migrationReport.stages.preservedAfterMove.clientDiscoveryInvoked = $false
        $migrationReport.stages.preservedAfterMove.clientConfigurationInvoked = $false
        $migrationReport.stages.preservedAfterMove.clientProgramsExecuted = $false
    } else {
        $migrationOverviewResult = Invoke-MigrationProcess (Join-Path $migrationSecondPackage 'AE-Switch-core.exe') @('overview') $migrationMoveEnvironment $migrationMoveRuntime '' 30
        if ($migrationOverviewResult.exitCode -ne 0) { throw 'The moved CLI could not reopen the existing data store.' }
        $migrationOverview = $migrationOverviewResult.stdout | ConvertFrom-Json
        Assert-MigrationAgents @($migrationOverview.hub.agents.id)
        foreach ($migrationAgent in $migrationOverview.hub.agents) {
            if (-not $migrationAgent.configured -or $migrationAgent.providerId -cne $migrationReport.stages.freshBeforeMove.providerId -or $migrationAgent.model -cne 'synthetic-model') { throw 'An existing agent selection was lost after the move.' }
        }
        $migrationReport.stages.preservedAfterMove.originalSelectionsReopened = $true
        $migrationMovedResults = @(Invoke-MigrationVersions $migrationSecondPackage 'preserved-after-move' $migrationMoveEnvironment $migrationMoveRuntime $migrationFirstPackage)
    }
    $migrationPostLaunchData = Get-MigrationSnapshot (Join-Path $migrationSecondPackage 'data')
    $migrationPersistedConfigAfter = @(Select-MigrationPersistedSnapshot $migrationPostLaunchData)
    $migrationReport.stages.preservedAfterMove.results = $migrationMovedResults
    $migrationReport.stages.preservedAfterMove.persistedConfigurationAfterSnapshot = $migrationPersistedConfigAfter
    $migrationReport.stages.preservedAfterMove.persistedConfigurationDifferences = @(Get-MigrationSnapshotDiff $migrationPersistedConfigBefore $migrationPersistedConfigAfter)
    $migrationReport.stages.preservedAfterMove.runtimeDataDifferences = @(Get-MigrationSnapshotDiff $migrationBefore $migrationPostLaunchData)
    Write-MigrationCheckpoint
    Assert-MigrationPostLaunchSnapshot $migrationPersistedConfigBefore $migrationPersistedConfigAfter
    $migrationDatabaseChange = Get-MigrationExpectedDatabaseChange $migrationReport.stages.preservedAfterMove.persistedConfigurationDifferences
    $migrationReport.stages.preservedAfterMove.nonDatabaseConfigurationByteIdentical = $true
    $migrationReport.stages.preservedAfterMove.databasePayloadUnchanged = $true
    $migrationReport.stages.preservedAfterMove.rawDatabaseByteIdentical = $false
    $migrationReport.stages.preservedAfterMove.databaseHeaderCounterProof = [ordered]@{ file = 'uni-switch.db'; beforeSha256 = $migrationDatabaseChange.before.sha256; afterSha256 = $migrationDatabaseChange.after.sha256; before = $migrationDatabaseChange.before.sqliteMetadata; after = $migrationDatabaseChange.after.sqliteMetadata; permittedHeaderFieldOffsets = @(24, 25, 26, 27, 92, 93, 94, 95); observedCounterIncrement = 1; allOtherFileBytesSha256Matched = $true }
    $migrationReport.stages.preservedAfterMove.passed = $true
    $migrationReport.preservedDataReset = Remove-MigrationOwnedTree (Join-Path $migrationSecondPackage 'data')
    $migrationReport.stages.freshAfterMove = Invoke-MigrationFresh $migrationSecondPackage 'fresh-after-move'
    Assert-MigrationExecutables $migrationSource
    $migrationReport.sourcePackageExecutablesUnchanged = $true
    if ((Get-MigrationHash (Join-Path $migrationSource 'package-manifest.json')) -cne $migrationReport.sourceManifestSha256 -or (Get-MigrationHash (Join-Path $migrationSecondPackage 'package-manifest.json')) -cne $migrationReport.sourceManifestSha256) { throw 'The source or moved package manifest changed during migration.' }
    $migrationReport.sourceAndMovedManifestUnchanged = $true
    if ((Get-MigrationHash $PSCommandPath) -cne $migrationDriverFrozenSha256) { throw 'The migration driver changed during this run.' }
    $migrationReport.driverUnchangedDuringRun = $true
    if ($ApplicationOnly) {
        $migrationReport.buildBindingAfter = Get-MigrationBuildBinding $migrationSourceManifest
        if (($migrationReport.buildBinding | ConvertTo-Json -Compress) -cne ($migrationReport.buildBindingAfter | ConvertTo-Json -Compress)) { throw 'The source/build binding changed during migration.' }
        if ($migrationReport.actualCoreExecutions.Count -ne $migrationReport.expectedActualCoreCommandCount -or $migrationReport.actualVersionExecutions.Count) { throw 'Application-only migration did not execute exactly the declared core commands.' }
    }
    $migrationReport.cleanup = Remove-MigrationOwnedTree $migrationRoot -WholeRoot
    $migrationReport.passed = $true
} catch {
    $migrationDetail = $_.Exception.Message
    foreach ($migrationSecret in $migrationSecrets) { $migrationDetail = $migrationDetail.Replace($migrationSecret, '<redacted>') }
    $migrationReport.error = $migrationDetail
    $migrationReport.cleanup.retainedOnFailure = $true
} finally {
    $migrationReport.completedAt = [DateTime]::UtcNow.ToString('o')
    $migrationReport.ownedRoot = $migrationRoot
    $migrationReport.driverSha256 = Get-MigrationHash $PSCommandPath
    $migrationReport.driverFrozenSha256 = $migrationDriverFrozenSha256
    $migrationReport.driverUnchangedDuringRun = $migrationReport.driverSha256 -ceq $migrationDriverFrozenSha256
    $migrationReport.observerSha256 = $migrationObserverFrozenSha256
    $migrationReport.observerSourceStillMatchesFrozenSha256 = (Get-MigrationHash $migrationObserverSource) -ceq $migrationObserverFrozenSha256
    $migrationReport.allDirectProcessesExited = @($migrationProcesses | Where-Object { -not $_.process.HasExited }).Count -eq 0
    if ([IO.File]::Exists($migrationReportFile) -or [IO.Directory]::Exists($migrationReportFile)) { throw 'A fresh migration report cannot overwrite another receipt.' }
    [IO.File]::WriteAllText($migrationReportFile, ($migrationReport | ConvertTo-Json -Depth 18) + "`n", [Text.UTF8Encoding]::new($false))
    [ordered]@{ passed = $migrationReport.passed; uuid = $migrationId; report = $migrationReportFile; ownedRootRemoved = $migrationReport.cleanup.removed; realInferenceVerified = $false; differentComputerVerified = $false } | ConvertTo-Json -Compress
}
if (-not $migrationReport.passed) { exit 1 }
