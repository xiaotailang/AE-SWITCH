[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
. (Join-Path $workspace 'scripts/workspace-env.ps1')
$utf8 = [Text.UTF8Encoding]::new($false)
$results = @()
foreach ($file in @('verify-production-ui-eight.ps1','verify-production-system-ui.ps1','verify-production-extra-ui.ps1')) {
    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $file), [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw 'Production supervisor syntax failed.' }
    # Execute the actual prelaunch clearing statements in a separate pwsh host;
    # then inspect a real native child's environment instead of text matching.
    $loops = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.ForEachStatementAst] -and $node.Body.Extent.Text.Contains("'Env:'") }, $true))
    if ($loops.Count -ne 2) { throw 'Exactly two prelaunch clear statements are required.' }
    $node = Join-Path $workspace '.tools/node/node.exe'
    $program = 'const names=["ZCODE_STORAGE_DIR","OPENAI_API_KEY","WORKBUDDY_USER_DATA_DIR","CODEX_HOME","UNI_SWITCH_QA_TEST","AE_NATIVE_TEST","WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS","PYTHONPATH","NODE_OPTIONS","HOME","APPDATA","LOCALAPPDATA","TEMP","TMP","PATH"];if(names.some(n=>Object.hasOwn(process.env,n)))process.exit(4);if(process.env.AE_TEST_PRESERVED!=="keep")process.exit(5);console.log(JSON.stringify({passed:true,absent:names.length,preserved:true}));'
    $command = "`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(`$false);`n" + (($loops | ForEach-Object { $_.Extent.Text }) -join "`n") + "`n& '" + $node.Replace("'","''") + "' -e '" + $program.Replace("'","''") + "'; if(`$LASTEXITCODE){exit `$LASTEXITCODE}"
    $info = [Diagnostics.ProcessStartInfo]::new((Join-Path $workspace '.tools/pwsh/pwsh.exe'))
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = $utf8; $info.StandardErrorEncoding = $utf8
    foreach ($argument in @('-NoProfile','-EncodedCommand',[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command)))) { $info.ArgumentList.Add($argument) }
    foreach ($name in @('ZCODE_STORAGE_DIR','OPENAI_API_KEY','WORKBUDDY_USER_DATA_DIR','CODEX_HOME','UNI_SWITCH_QA_TEST','AE_NATIVE_TEST','WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS','PYTHONPATH','NODE_OPTIONS')) { $info.Environment[$name] = 'synthetic-inherited-value' }
    $info.Environment['AE_TEST_PRESERVED'] = 'keep'
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $info
    try {
        $null = $process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(15000)) { $process.Kill(); throw 'Owned environment test host exceeded its bounded deadline.' }
        if ($process.ExitCode -ne 0) { throw 'Actual child process inherited a cleared variable.' }
        $value = $stdout.GetAwaiter().GetResult() | ConvertFrom-Json
        $null = $stderr.GetAwaiter().GetResult()
        if ($value.passed -ne $true -or $value.absent -ne 15 -or $value.preserved -ne $true) { throw 'Actual environment test receipt mismatch.' }
        $results += @{ supervisor=$file; passed=$true; absentVariables=$value.absent }
    } finally { $process.Dispose() }
}
[ordered]@{ passed=$true; supervisors=$results; actualNativeChildChecked=$true; inferenceExecuted=$false; filesCreated=0 } | ConvertTo-Json -Compress -Depth 5
