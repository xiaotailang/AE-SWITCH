# Production single-page eight-client acceptance

This workflow launches the production desktop executable from a fresh owned
G-drive sandbox, attaches to its retained WebView2 descendant, and clicks
**确认连接** in the single-page Agent Hub for all eight installed official clients.
It observes real native IPC, checks profile auto-selection, reads configuration
back from disk, verifies tool file write/read evidence, and compares preserved
history, unrelated files, shared runtimes, source inputs and helper hashes.

The production package and current source bytes must match a passed release-audit
build receipt. The package needs fixed WebView2 and the official client runtimes
used by `Initialize-E2eInstalledClientFixtures` in
`scripts/verify-portable-e2e.ps1`. No QA executable, injected discovery context,
mock supplier or product QA hook is accepted. No dependencies are installed by
these scripts.

From the workspace root, prepare a fresh run with PowerShell 7:

```powershell
$productionOwnerId = [Guid]::NewGuid().ToString('N')
& .\.tools\pwsh\pwsh.exe -NoProfile -File .\tests\acceptance\prepare-production-ui-eight.ps1 `
  -OwnerId $productionOwnerId `
  -AuditDirectory 'G:\path\to\workspace\artifacts\release-audit-current-build' `
  -PackageDirectory 'G:\path\to\workspace\artifacts\AE-Switch-portable-win-x64' `
  -CredentialsFile 'G:\path\to\workspace\端点测试用.txt'
```

If the existing official test installations live elsewhere in this workspace,
pass `-InstallationsManifest '<absolute G-workspace installations.json>'` to the
preparation helper. This reuses the program files read-only instead of copying
client trees. It does not change ordinary discovery or the fresh owned profiles.
The version 1 JSON object must have exactly these keys:

```json
{
  "schemaVersion": 1,
  "python": "<absolute Python host>",
  "node": "<absolute Node host>",
  "hermesSource": "<absolute Hermes source directory>",
  "hermesSitePackages": "<absolute Hermes site-packages directory>",
  "zcodeBuiltin": "<absolute official zcode-builtin.json>",
  "runtimes": {
    "claude_code": "<official executable>",
    "codex": "<official executable>",
    "hermes": "<same Python host>",
    "oh_my_pi": "<official executable>",
    "opencode": "<official executable>",
    "zcode": "<same Node host>",
    "workbuddy": "<official WorkBuddy.exe>",
    "deepseek_harness": "<same Node host>"
  },
  "entries": {
    "zcode": "<official zcode.cjs>",
    "deepseek_harness": "<official dsh/lib/bin.js>",
    "workbuddy": "<official codebuddy-lite-wb.mjs>"
  }
}
```

Every input must be an absolute ordinary path inside the current workspace;
linked paths, missing entries and interpreted-host mismatches are rejected before
fixture creation. The manifest and official entry/parser bytes remain hash-bound
inputs to preservation checks. This mapping is a test-harness option and does
not configure the product's client discovery.

For a run that selects the original native Codex executable, also pass
`-UseNativeCodexEntry`. That test lane adds the approved executable's directory
to its isolated PATH and creates no Codex PowerShell dispatch entry. The saved
profile and ordinary discovery must select the same official executable; both
the supervisor and evidence checker require its exact hash and a retained owned
parent process. The other seven entries retain their existing dispatch proof.
This mode proves the native Codex entry without claiming equivalent PowerShell
wrapper behavior.

Both supplied directories and the credentials file must be ordinary paths inside
the current G-drive workspace. The credentials file uses `端点: ...` and
`api-key: ...` lines. Its bytes are copied only into the private owned sandbox.
Preparation copies the package and creates installed-client fixtures without
starting the desktop application or running inference.

Run through the supervisor so process ownership and cleanup gates remain active:

```powershell
& .\.tools\pwsh\pwsh.exe -NoProfile -File .\tests\acceptance\verify-production-ui-eight.ps1 `
  -SetupFile ".cache/native-e2e-sandbox/$productionOwnerId/setup.json"
```

The supervisor launches the production app, observes exact process handles and
the owned CDP listener, invokes `production-ui-eight.mjs`, and attempts bounded
owned-process shutdown and sandbox removal. Port 9223 must be free; an existing
external listener is rejected. The Node runner is an internal entry point and
should be launched by this supervisor. Evidence goes to
`artifacts/acceptance/production-ui-eight-<ownerId>/`. A failed upstream query
remains a failed client; cached models and connection-only probes cannot satisfy
the acceptance contract.

After the supervisor exits and cleanup is proved, validate retained evidence:

```powershell
& .\.tools\node\node.exe .\tests\acceptance\verify-production-ui-eight-evidence.mjs `
  $productionOwnerId 'G:\path\to\workspace\端点测试用.txt'
```

The evidence checker reads existing artifacts and the same private-value input,
scans every non-PNG artifact as private-free UTF-8 text, validates PNG signatures,
checks credentials and endpoint forms, validates native
proof and receipt bindings, hashes screenshots, and independently checks sandbox
absence. It does not run clients or clean anything. It accepts a separately bound
post-exit cleanup receipt when initial cleanup was refused, while preserving the
original supervisor failure. Its exit success means evidence integrity passed;
`productionUiEightPassed` separately reports production tool acceptance. It
refuses to overwrite an existing `evidence-validation.json`.

Screenshots retain the runner's private-region masks. The checker does not
perform visual review or certify image privacy; inspect images separately before
sharing. This workflow proves official headless tool write/read, including
WorkBuddy's explicit model argument. It does not prove desktop GUI login/default
selection, a foreign machine, or the larger native QA suite. Interrupted runs
without complete receipts remain explicit verification gaps; do not bypass the
process or deletion guards to make them pass.

Run the local synthetic regressions without network, GUI, clients or cleanup:

```powershell
& .\.tools\node\node.exe --test `
  .\tests\acceptance\production-ui-eight-contract.test.mjs `
  .\tests\acceptance\production-ui-eight-evidence.test.mjs `
  .\tests\acceptance\wait-existing-tauri-page.test.mjs
```

The dated `.cache/tmp` originals remain historical evidence. The durable scripts
reuse the existing native readback and exact hash-bound fixture/process/cleanup
functions rather than maintaining another copy of those implementations.
