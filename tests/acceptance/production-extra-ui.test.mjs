// Synthetic contracts only; imports perform no network, native GUI or process actions.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assertExtraCommands,
  assertExtraReceipt,
  extraNativeCommand,
  extraUiScope,
} from "./production-extra-ui.mjs";

function receipt() {
  return {
    schemaVersion: 1,
    ownerId: "a".repeat(32),
    scope: extraUiScope,
    complete: false,
    fullAcceptancePassed: false,
    officialClientsLaunched: false,
    credentialsRead: false,
    qaHooksUsed: false,
    applicationInvokeReplaced: false,
    windowsLoginExecuted: false,
    backgroundSettingsMutated: false,
    actualExitConfirmed: false,
    observedNativeCommands: [
      "get_overview",
      "agent_hub_overview",
      "agent_hub_discover",
      "discover_provider_connection",
      "get_background_settings",
      "plugin:window|close",
    ],
    profile: {
      passed: true,
      pageRestored: true,
      nativeStoreUnchanged: true,
      fixtureOriginalsUnchanged: true,
      copiedFilesUnchanged: true,
      serverClosed: true,
    },
    tray: {
      passed: true,
      pageRestored: true,
      win32ShowWindowUsed: false,
      processStopped: false,
      actualExitConfirmed: false,
      fullAcceptancePassed: false,
      uiCloseRequests: [0, 1].map(() => ({
        command: "plugin:window|close",
        nativeRequestCount: 1,
        nativeResponse: "ok",
        actualUiRequestObserved: true,
      })),
      restorations: ["DoubleClick", "OpenMenu"].map((action) => ({
        action,
        hidden: { after: { visible: false, hwnd: "1234" } },
        restoration: {
          after: { visible: true, minimized: false, hwnd: "1234" },
        },
        bridgeHealthyAfterRestore: true,
      })),
      exitCancel: {
        status: "unvalidated",
        reason: "A fresh bridge cannot safely open exit confirmation.",
      },
    },
    pageRestored: true,
    productionIdentityUnchanged: true,
    helperBindingsUnchanged: true,
    nativeStoreUnchanged: true,
    backgroundSettingsUnchanged: true,
    fixtureOriginalsUnchanged: true,
    sourceInputsUnchanged: true,
    sharedRuntimeInputsUnchanged: true,
    nativeStateBeforeSha256: "b".repeat(64),
    nativeStateAfterSha256: "b".repeat(64),
    backgroundBeforeSha256: "c".repeat(64),
    backgroundAfterSha256: "c".repeat(64),
    pageErrors: [],
  };
}

test("bounded extra UI receipt accepts explicit unvalidated exit cancellation", () =>
  assertExtraReceipt(receipt()));
test("bounded extra UI receipt accepts separately proven cancellation without exit", () => {
  const report = receipt();
  report.tray.exitCancel = { status: "passed" };
  assertExtraReceipt(report);
});
for (const field of [
  "complete",
  "fullAcceptancePassed",
  "officialClientsLaunched",
  "credentialsRead",
  "qaHooksUsed",
  "applicationInvokeReplaced",
  "windowsLoginExecuted",
  "backgroundSettingsMutated",
  "actualExitConfirmed",
]) {
  test(`reject broader acceptance or mutation: ${field}`, () => {
    const report = receipt();
    report[field] = true;
    assert.throws(() => assertExtraReceipt(report));
  });
}
for (const field of [
  "pageRestored",
  "productionIdentityUnchanged",
  "helperBindingsUnchanged",
  "nativeStoreUnchanged",
  "backgroundSettingsUnchanged",
  "fixtureOriginalsUnchanged",
  "sourceInputsUnchanged",
  "sharedRuntimeInputsUnchanged",
]) {
  test(`reject missing restoration/binding: ${field}`, () => {
    const report = receipt();
    report[field] = false;
    assert.throws(() => assertExtraReceipt(report));
  });
}
for (const [name, mutate] of [
  [
    "profile failure",
    (r) => {
      r.profile.passed = false;
    },
  ],
  [
    "profile native mutation",
    (r) => {
      r.profile.nativeStoreUnchanged = false;
    },
  ],
  [
    "original config overwrite",
    (r) => {
      r.profile.fixtureOriginalsUnchanged = false;
    },
  ],
  [
    "synthetic discovery server leak",
    (r) => {
      r.profile.serverClosed = false;
    },
  ],
  [
    "tray failure",
    (r) => {
      r.tray.passed = false;
    },
  ],
  [
    "tray restoration skipped",
    (r) => {
      r.tray.restorations.pop();
    },
  ],
  [
    "tray restore substituted with ShowWindow",
    (r) => {
      r.tray.win32ShowWindowUsed = true;
    },
  ],
  [
    "tray page left hidden",
    (r) => {
      r.tray.pageRestored = false;
    },
  ],
  [
    "tray without real close IPC",
    (r) => {
      r.tray.uiCloseRequests[0].actualUiRequestObserved = false;
    },
  ],
  [
    "tray different native HWND",
    (r) => {
      r.tray.restorations[0].restoration.after.hwnd = "4567";
    },
  ],
  [
    "tray hidden window never restored",
    (r) => {
      r.tray.restorations[0].restoration.after.visible = false;
    },
  ],
  [
    "named profile copied files changed",
    (r) => {
      r.profile.copiedFilesUnchanged = false;
    },
  ],
  [
    "tray process stop",
    (r) => {
      r.tray.processStopped = true;
    },
  ],
  [
    "tray exit claim",
    (r) => {
      r.tray.actualExitConfirmed = true;
    },
  ],
  [
    "tray full acceptance",
    (r) => {
      r.tray.fullAcceptancePassed = true;
    },
  ],
  [
    "unvalidated without explanation",
    (r) => {
      r.tray.exitCancel.reason = "";
    },
  ],
  [
    "unknown exit status",
    (r) => {
      r.tray.exitCancel.status = "skipped";
    },
  ],
  [
    "changed native readback",
    (r) => {
      r.nativeStateAfterSha256 = "d".repeat(64);
    },
  ],
  [
    "changed background readback",
    (r) => {
      r.backgroundAfterSha256 = "d".repeat(64);
    },
  ],
  [
    "page error",
    (r) => {
      r.pageErrors = [{ name: "Error" }];
    },
  ],
]) {
  test(`reject incomplete extra evidence: ${name}`, () => {
    const report = receipt();
    mutate(report);
    assert.throws(() => assertExtraReceipt(report));
  });
}
for (const command of [
  "save_provider",
  "agent_hub_configure",
  "agent_hub_launch",
  "agent_hub_restart",
  "agent_hub_probe",
  "set_background_start",
  "open_project_page",
  "agent_hub_open_directory",
  "plugin:window|toggle_maximize",
]) {
  test(`reject unauthorized native action: ${command}`, () =>
    assert.throws(() => assertExtraCommands([command])));
}
for (const origin of [
  "http://ipc.localhost",
  "https://ipc.localhost",
  "ipc://localhost",
]) {
  test(`exact native origin accepted: ${origin}`, () =>
    assert.equal(
      extraNativeCommand({
        method: () => "POST",
        url: () => origin + "/plugin%3Awindow%7Cclose",
      }),
      "plugin:window|close",
    ));
}
for (const url of [
  "http://ipc.localhost.evil.invalid/save_provider",
  "http://localhost/save_provider",
  "http://ipc.localhost:9223/save_provider",
  "http://ipc.localhost/save_provider?x=1",
  "http://ipc.localhost/a%2Fb",
  "http://u:p@ipc.localhost/save_provider",
]) {
  test(`forged origin refused: ${url}`, () =>
    assert.equal(
      extraNativeCommand({ method: () => "POST", url: () => url }),
      null,
    ));
}

test("runner direct invocation is limited to protected readbacks", () => {
  const code = fs.readFileSync(
    new URL("./production-extra-ui.mjs", import.meta.url),
    "utf8",
  );
  assert.match(code, /Only approved read-only direct invocation is allowed/u);
  assert.ok(
    code.indexOf("report.profile = await verifyProductionProfiles") <
      code.indexOf("report.tray = await verifyProductionTray"),
  );
  assert.doesNotMatch(
    code,
    /acceptance-credentials|\.route\(|\.addInitScript\(|__TAURI_INTERNALS__\s*=|console\.error\(error/u,
  );
});
test("supervisor keeps exact process ownership and fixed cleanup budget", () => {
  const code = fs.readFileSync(
    new URL("./verify-production-extra-ui.ps1", import.meta.url),
    "utf8",
  );
  for (const required of [
    "[ValidateRange(600,600)]",
    "Assert-E2eNativeProcessIdentity",
    "retainedDescendantValidated",
    "Remove-E2eOwnedTree $e2eSandbox",
    "Assert-ExtraPreservedFiles",
    "Assert-ExtraDispatchEntries",
    "sharedRuntimeInputsUnchangedThroughCleanup",
    "helperBindingsUnchangedThroughCleanup",
    "wholeRunDeadlineNeverReset=$true",
  ])
    assert.ok(code.includes(required), `Missing supervisor guard: ${required}`);
  assert.doesNotMatch(
    code,
    /set_background_start|restore-production-background|Get-ProductionBackgroundRegistry|acceptance-credentials|Stop-Process/u,
  );
});

test("both runner and supervisor bind the profile module's actual surface parser dependency", () => {
  for (const name of [
    "production-extra-ui.mjs",
    "verify-production-extra-ui.ps1",
  ]) {
    const code = fs.readFileSync(new URL("./" + name, import.meta.url), "utf8");
    assert.ok(
      code.includes("production-ui-surface.mjs"),
      `${name} omits the actual imported dependency`,
    );
  }
});

test("cleanup diagnostics retain native failure codes and bounded disk evidence without private text", { skip: process.platform !== "win32" }, () => {
  const workspace = fileURLToPath(new URL("../../", import.meta.url));
  const fixture = fs.mkdtempSync(path.join(workspace, ".cache/tmp/extra-cleanup-diagnostic-test-"));
  assert.ok(path.resolve(fixture).startsWith(path.resolve(workspace) + path.sep));
  const script = path.join(fixture, "fixture.ps1");
  fs.writeFileSync(script, String.raw`
param([string]$Supervisor,[string]$FixtureRoot)
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$tree=[Management.Automation.Language.Parser]::ParseFile($Supervisor,[ref]$tokens,[ref]$errors)
if($errors.Count) { throw 'Supervisor parser failed' }
$catches=@($tree.FindAll({param($n) $n -is [Management.Automation.Language.CatchClauseAst] -and $n.Extent.Text.Contains("Exact owned process/tree cleanup or original binding check failed")},$true))
if($catches.Count -ne 1) { throw 'Exact cleanup catch required' }
$e2eIdentifier='11111111111111111111111111111111'
$e2eSandbox=Join-Path $FixtureRoot 'synthetic-root'
$e2eReport=Join-Path $FixtureRoot 'receipt.json'
$privateSentinel='fake-private-path-and-key-MUST-NOT-ARCHIVE'
function Check([bool]$Value,[string]$Label) { if(-not $Value) { throw $Label } }
function Run-Case($Disk) {
    if($null -eq $Disk) { [IO.File]::Delete($e2eReport) }
    elseif($Disk -is [string]) { [IO.File]::WriteAllText($e2eReport,$Disk) }
    else { [IO.File]::WriteAllText($e2eReport,($Disk|ConvertTo-Json -Depth 8)) }
    $receipt=@{passed=$true;cleanup=@{removed=$false;processesExited=$true}}
    $failure=[Exception]::new($privateSentinel,[IO.IOException]::new($privateSentinel,-2147024864))
    . ([ScriptBlock]::Create('try { throw $failure } '+$catches[0].Extent.Text))
    Check (-not $receipt.passed -and -not $receipt.cleanup.removed -and $receipt.cleanup.processesExited) 'Original failed cleanup state must remain failed'
    Check ($receipt.cleanup.failureType -ceq 'IOException' -and $receipt.cleanup.failureHResult -eq -2147024864 -and $receipt.cleanup.failureWin32 -eq 32) 'Innermost native error type and HResult required'
    Check (($receipt|ConvertTo-Json -Depth 8) -notmatch [regex]::Escape($privateSentinel)) 'Raw error text or disk private data escaped into diagnostic receipt'
    return $receipt
}
$disk=@{schemaVersion=2;ownerId=$e2eIdentifier;sandbox=$e2eSandbox;cleanup=@{ownerMarkerVerified=$false;sharingViolationRetryTimeoutMs=30000;sharingViolationRetryCount=5;directoryNotEmptyRetryCount=3;failure=$privateSentinel;rawPath=$privateSentinel}}
$actual=Run-Case $disk
Check ($actual.cleanup.removalDiagnostics.ownerMarkerVerified -eq $false -and $actual.cleanup.removalDiagnostics.sharingViolationRetryTimeoutMs -eq 30000 -and $actual.cleanup.removalDiagnostics.sharingViolationRetryCount -eq 5 -and $actual.cleanup.removalDiagnostics.directoryNotEmptyRetryCount -eq 3) 'Exact disk retry counts and false owner result must be retained'
Check ($actual.cleanup.removalDiagnostics.Count -eq 4) 'Only four safe disk fields may be retained'
$disk.ownerId='22222222222222222222222222222222'
$actual=Run-Case $disk
Check (-not $actual.cleanup.ContainsKey('removalDiagnostics')) 'Foreign owner disk evidence must be ignored'
$disk.ownerId=$e2eIdentifier;$disk.sandbox=Join-Path $FixtureRoot 'foreign-root'
$actual=Run-Case $disk
Check (-not $actual.cleanup.ContainsKey('removalDiagnostics')) 'Foreign root disk evidence must be ignored'
$disk.sandbox=$e2eSandbox;$disk.cleanup=@{ownerMarkerVerified='true';sharingViolationRetryTimeoutMs='30000';sharingViolationRetryCount=-1;directoryNotEmptyRetryCount=2147483648;failure=$privateSentinel}
$actual=Run-Case $disk
Check ($actual.cleanup.removalDiagnostics.Count -eq 0) 'Invalid retry types, ranges and owner types must be ignored'
$actual=Run-Case $null
Check ($actual.cleanup.removalDiagnosticsReadFailed) 'Missing disk receipt must retain original native failure'
$actual=Run-Case '{invalid-json'
Check ($actual.cleanup.removalDiagnosticsReadFailed) 'Malformed disk receipt must retain original native failure'
Write-Output 'Six synthetic cleanup diagnostic cases passed; no supervisor main, GUI or actual sandbox action.'
`);
  try {
    const result = spawnSync(path.join(workspace, ".tools/pwsh/pwsh.exe"), [
      "-NoProfile", "-NonInteractive", "-File", script,
      "-Supervisor", fileURLToPath(new URL("./verify-production-extra-ui.ps1", import.meta.url)),
      "-FixtureRoot", fixture,
    ], {
      cwd: workspace,
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
      env: { ...process.env, TEMP: fixture, TMP: fixture, PSModuleAnalysisCachePath: path.join(fixture, "module-analysis") },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Six synthetic cleanup diagnostic cases passed/u);
  } finally {
    for (const name of ["fixture.ps1", "receipt.json", "module-analysis"]) {
      const file = path.join(fixture, name);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    fs.rmdirSync(fixture);
  }
});

test("actual supervisor setup proof survives owned setup removal only after the verified cleanup boundary", { skip: process.platform !== "win32" }, () => {
  const workspace = fileURLToPath(new URL("../../", import.meta.url));
  const fixture = fs.mkdtempSync(path.join(workspace, ".cache/tmp/extra-setup-lifecycle-test-"));
  assert.ok(path.resolve(fixture).startsWith(path.resolve(workspace) + path.sep));
  const owner = "1".repeat(32);
  const sandbox = path.join(fixture, ".cache/native-e2e-sandbox", owner);
  const output = path.join(fixture, "artifacts/acceptance/production-extra-ui-" + owner);
  fs.mkdirSync(sandbox, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  const script = path.join(fixture, "fixture.ps1");
  fs.writeFileSync(script, String.raw`
param([string]$Supervisor,[string]$Wrapper,[string]$FixtureRoot)
$ErrorActionPreference='Stop'
function Read-Ast([string]$File) {
    $tokens=$null;$errors=$null
    $tree=[Management.Automation.Language.Parser]::ParseFile($File,[ref]$tokens,[ref]$errors)
    if($errors.Count) { throw 'Actual script parser failed' }
    return $tree
}
$tree=Read-Ast $Supervisor
$wrapperTree=Read-Ast $Wrapper
foreach($name in @('Assert-E2eLocalPath','Assert-E2eNativeOrdinaryFile')) {
    $definitions=@($wrapperTree.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)|Where-Object Name -CEQ $name)
    if($definitions.Count -ne 1) { throw 'Exact ordinary path guard required' }
    . ([ScriptBlock]::Create($definitions[0].Extent.Text))
}
foreach($name in @('Assert-E2eNativeOwner','Use-ExtraArchivedSetupProof')) {
    $definitions=@($tree.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)|Where-Object Name -CEQ $name)
    if($name -ceq 'Assert-E2eNativeOwner' -and $definitions.Count -ne 1) { throw 'Exact actual owner guard required' }
    if($definitions.Count -eq 1) { . ([ScriptBlock]::Create($definitions[0].Extent.Text)) }
}
$copies=@($tree.FindAll({param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.Extent.Text -ceq 'Copy-Item -LiteralPath $SetupFile -Destination (Join-Path $productionOutput ''setup.json'')'},$true))
if($copies.Count -ne 1) { throw 'Exact actual archive copy boundary required' }
$switches=@($tree.FindAll({param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -ceq 'Use-ExtraArchivedSetupProof'},$true))
if($switches.Count -gt 1) { throw 'Only one actual cleanup proof transition may exist' }
if($switches.Count -eq 1) {
    $removals=@($tree.FindAll({param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.Extent.Text -ceq 'Remove-E2eOwnedTree $e2eSandbox'},$true))
    if($removals.Count -ne 1 -or $switches[0].Parent.Parent -ne $copies[0].Parent.Parent -or $switches[0].Parent.Parent -ne $removals[0].Parent.Parent -or $switches[0].Extent.StartOffset -le $copies[0].Extent.EndOffset -or $switches[0].Extent.EndOffset -ge $removals[0].Extent.StartOffset) { throw 'Actual switch must be in the copy-to-removal cleanup boundary' }
}
$e2eWorkspace=$FixtureRoot
$e2eIdentifier='11111111111111111111111111111111'
$e2eSandbox=Join-Path $FixtureRoot ('.cache/native-e2e-sandbox/'+$e2eIdentifier)
$e2eMarker=Join-Path $e2eSandbox '.ae-production-ui-eight-owner.json'
$productionOutput=Join-Path $FixtureRoot ('artifacts/acceptance/production-extra-ui-'+$e2eIdentifier)
$SetupFile=Join-Path $e2eSandbox 'setup.json'
$extraSetupPath=[IO.Path]::GetFullPath($SetupFile)
$extraSetupProofPath=$extraSetupPath
$setup=@{schemaVersion=2;ownerId=$e2eIdentifier;root=$e2eSandbox;workspace=$e2eWorkspace;productionSha256=('a'*64);sourceDigest=('b'*64);buildAuditId=('c'*32);qaHooksUsed=$false;discoveryContextInjected=$false}
$setupBytes=$setup|ConvertTo-Json
[IO.File]::WriteAllText($SetupFile,$setupBytes)
$extraSetupSha256=(Get-FileHash -LiteralPath $SetupFile -Algorithm SHA256).Hash.ToLowerInvariant()
$marker=@{schemaVersion=2;ownerId=$e2eIdentifier;workspace=$e2eWorkspace;productionSha256=$setup.productionSha256;sourceDigest=$setup.sourceDigest;buildAuditId=$setup.buildAuditId}|ConvertTo-Json
[IO.File]::WriteAllText($e2eMarker,$marker)
$e2eNativeMarkerHash=(Get-FileHash -LiteralPath $e2eMarker -Algorithm SHA256).Hash.ToLowerInvariant()
$fields=@('processesExited','sharedRuntimeBindingsUnchangedBeforeRemoval','originalFixturesUnchangedBeforeRemoval','dispatchOnlyEntriesUnchangedBeforeRemoval','helpersUnchangedBeforeRemoval')
$receipt=@{cleanup=@{}}
foreach($field in $fields) { $receipt.cleanup[$field]=$true }
$syntheticStrictExitPassed=$true
$strictExitChecks=0
# Only process observation is synthetic. Owner, archive copy, proof transition,
# fixed-path and ordinary-file guards execute their actual current AST bodies.
function Assert-E2eNativeProcessesExited { if(-not $syntheticStrictExitPassed) { throw 'Synthetic live reference remains' };$script:strictExitChecks++ }
function Check([bool]$Value,[string]$Label) { if(-not $Value) { throw $Label } }
function Check-Refused([scriptblock]$Action,[string]$Label) { $refused=$false;try { & $Action } catch { $refused=$true };Check $refused $Label }
Assert-E2eNativeOwner
[IO.File]::WriteAllText($SetupFile,'altered root setup')
Check-Refused { Assert-E2eNativeOwner } 'Changed original root setup must fail before cleanup'
[IO.File]::WriteAllText($SetupFile,$setupBytes)
Assert-E2eNativeOwner
. ([ScriptBlock]::Create($copies[0].Extent.Text))
if($switches.Count -eq 1) { . ([ScriptBlock]::Create($switches[0].Extent.Text)) }
[IO.File]::Delete($SetupFile)
Assert-E2eNativeOwner
Check ($extraSetupProofPath -ieq (Join-Path $productionOutput 'setup.json') -and $strictExitChecks -gt 0) 'Actual boundary must switch to the fixed independently verified archive'
$archive=Join-Path $productionOutput 'setup.json'
[IO.File]::WriteAllText($archive,'altered archive')
Check-Refused { Assert-E2eNativeOwner } 'Changed archive must still fail with original root setup absent'
[IO.File]::Delete($archive)
Check-Refused { Assert-E2eNativeOwner } 'Missing archive must still fail with original root setup absent'
[IO.Directory]::CreateDirectory($archive)|Out-Null
Check-Refused { Assert-E2eNativeOwner } 'A directory cannot replace the ordinary archived setup'
[IO.Directory]::Delete($archive,$false)
[IO.File]::WriteAllText($archive,$setupBytes)
[IO.File]::WriteAllText($SetupFile,$setupBytes)
foreach($field in $fields) {
    $extraSetupProofPath=$extraSetupPath;$receipt.cleanup.setupProofArchived=$false;$receipt.cleanup[$field]=$false
    Check-Refused { Use-ExtraArchivedSetupProof } ('Proof switch outside validated cleanup gate must fail: '+$field)
    Check ($extraSetupProofPath -ieq $extraSetupPath) 'Refused proof transition must preserve original root proof'
    $receipt.cleanup[$field]=$true
}
$receipt.cleanup.processesExited='true'
Check-Refused { Use-ExtraArchivedSetupProof } 'Cleanup gates require actual booleans'
$receipt.cleanup.processesExited=$true
$syntheticStrictExitPassed=$false
Check-Refused { Use-ExtraArchivedSetupProof } 'Receipt booleans cannot replace current strict process exit validation'
$syntheticStrictExitPassed=$true
$selectedOutput=$productionOutput;$productionOutput=Join-Path $FixtureRoot 'foreign-output'
Check-Refused { Use-ExtraArchivedSetupProof } 'Proof transition cannot select an arbitrary output archive'
$productionOutput=$selectedOutput
Use-ExtraArchivedSetupProof
[IO.File]::Delete($SetupFile)
$extraSetupProofPath=$e2eMarker
Check-Refused { Assert-E2eNativeOwner } 'Owner cannot use an arbitrary selected proof path'
$extraSetupProofPath=$archive
$receipt.cleanup.setupProofArchived=$false
Check-Refused { Assert-E2eNativeOwner } 'Archive selection alone cannot bypass the verified cleanup transition'
$receipt.cleanup.setupProofArchived=$true
[IO.File]::WriteAllText($e2eMarker,'changed marker')
Check-Refused { Assert-E2eNativeOwner } 'Archived setup cannot bypass the original marker hash'
[IO.File]::WriteAllText($e2eMarker,$marker)
Assert-E2eNativeOwner
Check ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $extraSetupSha256) 'Original setup SHA must remain bound throughout cleanup'
Write-Output 'Setup lifecycle AST cases passed; no supervisor main, GUI or actual sandbox action.'
`);
  try {
    const result = spawnSync(path.join(workspace, ".tools/pwsh/pwsh.exe"), [
      "-NoProfile", "-NonInteractive", "-File", script,
      "-Supervisor", fileURLToPath(new URL("./verify-production-extra-ui.ps1", import.meta.url)),
      "-Wrapper", path.join(workspace, "scripts/verify-portable-e2e.ps1"),
      "-FixtureRoot", fixture,
    ], {
      cwd: workspace,
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
      env: { ...process.env, TEMP: fixture, TMP: fixture, PSModuleAnalysisCachePath: path.join(fixture, "module-analysis") },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Setup lifecycle AST cases passed/u);
  } finally {
    for (const file of [script, path.join(fixture, "module-analysis"), path.join(sandbox, "setup.json"), path.join(sandbox, ".ae-production-ui-eight-owner.json"), path.join(output, "setup.json")]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    for (const directory of [sandbox, path.dirname(sandbox), path.join(fixture, ".cache"), output, path.dirname(output), path.join(fixture, "artifacts"), fixture]) {
      fs.rmdirSync(directory);
    }
  }
});
