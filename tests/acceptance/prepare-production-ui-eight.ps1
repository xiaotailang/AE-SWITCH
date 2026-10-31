[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{32}$')][string]$OwnerId,
    [Parameter(Mandatory)][string]$AuditDirectory,
    [Parameter(Mandatory)][string]$PackageDirectory,
    [string]$CredentialsFile,
    [string]$InstallationsManifest,
    [switch]$UseNativeCodexEntry
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$e2eWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if ($PSVersionTable.PSVersion.Major -lt 7 -or $e2eWorkspace -notmatch '^[Gg]:[\\/]') { throw 'Workspace PowerShell 7 on G: is required.' }
. (Join-Path $e2eWorkspace 'scripts/workspace-env.ps1')
$e2eIdentifier = $OwnerId
$e2eSandbox = Join-Path $e2eWorkspace ('.cache/native-e2e-sandbox/' + $OwnerId)
$productionWrapper = Join-Path $e2eWorkspace 'scripts/verify-portable-e2e.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($productionWrapper, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Current wrapper parser errors.' }
$imports = [Collections.Generic.List[object]]::new()
foreach ($name in @('Get-E2ePortableInstallationRoot', 'Assert-E2eLocalPath', 'New-E2eNativeLaunchWaitScript', 'Initialize-E2eInstalledClientFixtures')) {
    $definitions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true) | Where-Object Name -CEQ $name)
    if ($definitions.Count -ne 1) { throw ('Exact fixture function required: ' + $name) }
    $body = $definitions[0].Extent.Text
    $imports.Add(@{name=$name;sha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($body))).ToLowerInvariant()})
    . ([ScriptBlock]::Create($body))
}
function Get-ProductionHash([string]$File) {
    (Get-FileHash -LiteralPath (Assert-E2eLocalPath $File) -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Protect-ProductionPrivateRoot {
    $expectedRoot = [IO.Path]::GetFullPath((Join-Path $e2eWorkspace ('.cache/native-e2e-sandbox/' + $OwnerId)))
    $privateRoot = Assert-E2eLocalPath $e2eSandbox
    if ($OwnerId -cnotmatch '^[a-f0-9]{32}$' -or $privateRoot -ine $expectedRoot) { throw 'Exact fresh production UUID root required for private permissions.' }
    $marker = Assert-E2eLocalPath (Join-Path $privateRoot '.ae-production-ui-eight-owner.json')
    $entries = @(Get-ChildItem -LiteralPath $privateRoot -Force)
    $owner = [IO.File]::ReadAllText($marker, [Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($entries.Count -ne 1 -or $entries[0].Name -cne '.ae-production-ui-eight-owner.json' -or $entries[0].PSIsContainer -or $owner.schemaVersion -ne 2 -or $owner.ownerId -cne $OwnerId -or $owner.workspace -ine $e2eWorkspace -or $owner.purpose -cne 'Independent single-page production GUI eight-tool acceptance') { throw 'Only this fresh production owner marker may exist before private permissions.' }
    $markerHash = (Get-FileHash -LiteralPath $marker -Algorithm SHA256).Hash
    try {
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
        $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
        $permissions = [Security.AccessControl.DirectorySecurity]::new()
        $permissions.SetAccessRuleProtection($true, $false)
        $permissions.SetOwner($sid)
        $permissions.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
        Set-Acl -LiteralPath $privateRoot -AclObject $permissions -ErrorAction Stop
        $applied = Get-Acl -LiteralPath $privateRoot -ErrorAction Stop
        $rules = @($applied.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
        $verified = $applied.AreAccessRulesProtected -and $rules.Count -eq 1 -and $rules[0].IdentityReference -eq $sid -and -not $rules[0].IsInherited -and $rules[0].AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $rules[0].FileSystemRights -eq [Security.AccessControl.FileSystemRights]::FullControl -and $rules[0].InheritanceFlags -eq $inheritance -and $rules[0].PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None
    } catch { throw 'Private production root permissions could not be applied or verified; no credentials were copied.' }
    $null = Assert-E2eLocalPath $privateRoot
    if (-not $verified -or (Get-FileHash -LiteralPath $marker -Algorithm SHA256).Hash -cne $markerHash) { throw 'Private production root permission or owner verification failed; no credentials were copied.' }
}
$null = Assert-E2eLocalPath $e2eSandbox
if (Test-Path -LiteralPath $e2eSandbox) { throw 'Fresh independently owned production root required.' }
$buildRoot = Assert-E2eLocalPath $AuditDirectory
$package = Assert-E2eLocalPath $PackageDirectory
$buildReceiptFile = Join-Path $buildRoot 'build-receipt.json'
$sourceFile = Join-Path $buildRoot 'build-source-after.json'
$outputsFile = Join-Path $buildRoot 'build-release-audit-outputs.json'
$build = Get-Content -LiteralPath (Assert-E2eLocalPath $buildReceiptFile) -Raw -Encoding UTF8 | ConvertFrom-Json
$source = Get-Content -LiteralPath (Assert-E2eLocalPath $sourceFile) -Raw -Encoding UTF8 | ConvertFrom-Json
$outputs = @(Get-Content -LiteralPath (Assert-E2eLocalPath $outputsFile) -Raw -Encoding UTF8 | ConvertFrom-Json)
$auditOwner = Get-Content -LiteralPath (Assert-E2eLocalPath (Join-Path $buildRoot '.ae-release-audit-owner.json')) -Raw -Encoding UTF8 | ConvertFrom-Json
if ($build.id -cnotmatch '^[a-f0-9]{32}$' -or $auditOwner.id -cne $build.id -or $auditOwner.workspace -ine $e2eWorkspace -or $build.phase -cne 'build' -or $build.passed -ne $true -or $build.sourceUnchanged -ne $true -or $build.targetLinkPassed -ne $true) { throw 'Passed owned build receipt required.' }
if ($build.sourceDigest -cnotmatch '^[a-f0-9]{64}$' -or $source.digest -cne $build.sourceDigest -or $source.fileCount -ne $build.sourceFiles -or @($source.files).Count -ne $build.sourceFiles -or $build.sourceFiles -lt 1) { throw 'Build/source receipt binding mismatch.' }
if ((Get-ProductionHash $sourceFile) -cne $build.sourceAfterSha256) { throw 'Build source receipt bytes changed.' }
# Reconstruct the same input set as the release verifier, including new or removed files.
$currentInputs = @()
foreach ($relative in @('app/src-tauri/src','app/src-tauri/resources','app/src-tauri/icons','app/src-tauri/capabilities','app/src','app/dist','app/public')) {
    $directory = Assert-E2eLocalPath (Join-Path $e2eWorkspace $relative)
    if (Test-Path -LiteralPath $directory) { $currentInputs += @(Get-ChildItem -LiteralPath $directory -File -Recurse | ForEach-Object { [IO.Path]::GetRelativePath($e2eWorkspace, $_.FullName).Replace('\','/') }) }
}
$currentInputs += @('app/src-tauri/Cargo.toml','app/src-tauri/Cargo.lock','app/src-tauri/build.rs','app/package.json','app/pnpm-lock.yaml','app/tsconfig.json','app/vite.config.ts','app/index.html','app/postcss.config.js','app/tailwind.config.js','app/release-config.json','app/src-tauri/tauri.conf.json')
$expectedInputs = @($source.files | ForEach-Object path)
if (@($expectedInputs | Select-Object -Unique).Count -ne $expectedInputs.Count -or @(Compare-Object @($currentInputs | Sort-Object -Unique) @($expectedInputs | Sort-Object -Unique)).Count) { throw 'Current production input set differs from the built input set.' }
$sourceLines = foreach ($file in $source.files) {
    $hash = Get-ProductionHash (Join-Path $e2eWorkspace $file.path)
    if ($hash -cne $file.sha256) { throw ('Production input changed: ' + $file.path) }
    $file.path + [char]0 + $hash + "`n"
}
$sourceDigest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes(($sourceLines -join '')))).ToLowerInvariant()
if ($sourceDigest -cne $build.sourceDigest) { throw 'Built source digest differs from current bytes.' }
$desktopOutput = @($outputs | Where-Object name -CEQ 'desktop')
$coreOutput = @($outputs | Where-Object name -CEQ 'core')
if ($desktopOutput.Count -ne 1 -or $coreOutput.Count -ne 1 -or $desktopOutput[0].filename -cne 'AE-Switch.exe' -or $coreOutput[0].filename -cne 'AE-Switch-core.exe') { throw 'Unique production desktop/core output bindings required.' }
$desktopRun = @($build.runs | Where-Object name -CEQ 'build-release-audit-desktop')
if ($desktopRun.Count -ne 1 -or $desktopRun[0].exitCode -ne 0 -or $desktopRun[0].sourceDigest -cne $sourceDigest -or (($desktopRun[0].arguments -join ' ') -match 'qa-webview')) { throw 'Production desktop build must exclude QA features.' }
$binaries = @{'AE-Switch.exe'=$desktopOutput[0].sha256; 'AE-Switch-core.exe'=$coreOutput[0].sha256; 'WebView2Loader.dll'=(Get-ProductionHash (Join-Path $buildRoot 'WebView2Loader.dll'))}
foreach ($name in $binaries.Keys) {
    if ($binaries[$name] -cnotmatch '^[a-f0-9]{64}$' -or (Get-ProductionHash (Join-Path $buildRoot $name)) -cne $binaries[$name] -or (Get-ProductionHash (Join-Path $package $name)) -cne $binaries[$name]) { throw ('Audit/package binary mismatch: '+$name) }
}
if (@(Get-ChildItem -LiteralPath $package -Filter '*QA*.exe' -File).Count -or (Test-Path -LiteralPath (Join-Path $package 'data'))) { throw 'Production package must exclude QA executables and existing runtime data.' }
$null = Get-ProductionHash (Join-Path $package 'tools/webview2/msedgewebview2.exe')
$credentials = Assert-E2eLocalPath $(if ($CredentialsFile) { $CredentialsFile } else { Join-Path $e2eWorkspace '端点测试用.txt' })
if (-not (Test-Path -LiteralPath $credentials -PathType Leaf)) { throw 'Owned credentials input missing.' }
$bindings = @($buildReceiptFile,$sourceFile,$outputsFile,(Join-Path $buildRoot '.ae-release-audit-owner.json')) | ForEach-Object { @{path=$_;sha256=(Get-ProductionHash $_)} }
$null = New-Item -ItemType Directory -Path $e2eSandbox
$utf8 = [Text.UTF8Encoding]::new($false)
function Write-ProductionJson([string]$Name, $Value) {
    $destination = Assert-E2eLocalPath (Join-Path $e2eSandbox $Name)
    if (Test-Path -LiteralPath $destination) { throw ('Output already exists: '+$Name) }
    [IO.File]::WriteAllText($destination, ($Value | ConvertTo-Json -Depth 40)+"`n", $utf8)
}
Write-ProductionJson '.ae-production-ui-eight-owner.json' ([ordered]@{schemaVersion=2;ownerId=$OwnerId;workspace=$e2eWorkspace;createdAt=[DateTimeOffset]::UtcNow.ToString('o');purpose='Independent single-page production GUI eight-tool acceptance';sourceDigest=$sourceDigest;buildAuditId=$build.id;productionSha256=$binaries['AE-Switch.exe']})
Protect-ProductionPrivateRoot
$portable = Assert-E2eLocalPath (Get-E2ePortableInstallationRoot)
& robocopy.exe $package $portable /E /XJ /R:1 /W:1 /COPY:DAT /DCOPY:DAT /NFL /NDL /NJH /NJS /NP *> (Join-Path $e2eSandbox 'package-copy.log')
if ($LASTEXITCODE -ge 8) { throw 'Owned production package copy failed.' }
foreach ($name in $binaries.Keys) { if ((Get-ProductionHash (Join-Path $portable $name)) -cne $binaries[$name]) { throw ('Copied production binary mismatch: '+$name) } }
Copy-Item -LiteralPath $credentials -Destination (Join-Path $portable 'acceptance-credentials.txt')
$fixtureArguments = @{ UseNativeCodexEntry = $UseNativeCodexEntry }
if ($PSBoundParameters.ContainsKey('InstallationsManifest')) { $fixtureArguments.InstallationsManifest = $InstallationsManifest }
$fixtures = Initialize-E2eInstalledClientFixtures @fixtureArguments
$setup = [ordered]@{schemaVersion=2;ownerId=$OwnerId;workspace=$e2eWorkspace;root=$e2eSandbox;privateDataAclVerified=$true;portableRoot=$portable;productionProgram=(Join-Path $portable 'AE-Switch.exe');productionSha256=$binaries['AE-Switch.exe'];binaries=$binaries;buildAuditId=$build.id;sourceDigest=$sourceDigest;sourceFiles=[int]$build.sourceFiles;auditDirectory=$buildRoot;sourceManifest=$sourceFile;buildBindings=@($bindings);package=$package;fixtures=$fixtures;wrapper=$productionWrapper;wrapperSha256=(Get-ProductionHash $productionWrapper);importedFixtureFunctions=$imports.ToArray();prepareHelper=$PSCommandPath;prepareHelperSha256=(Get-ProductionHash $PSCommandPath);officialClientCodeModified=$false;productionStarted=$false;inferenceExecuted=$false;qaHooksUsed=$false;discoveryContextInjected=$false;canonicalReportsModified=$false}
Write-ProductionJson 'setup.json' $setup
Write-Output (@{prepared=$true;ownerId=$OwnerId;setup=(Join-Path $e2eSandbox 'setup.json');buildAuditId=$build.id;sourceFiles=$build.sourceFiles;productionStarted=$false;qaHooksUsed=$false;canonicalReportsModified=$false}|ConvertTo-Json -Compress)
