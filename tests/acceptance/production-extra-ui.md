This separate lane runs against an exact owned production build. The parent prepares a fresh setup with the existing preparation helper, then adds the synthetic Hermes `config.yaml` before launch and binds it in `setup.fixtures.payload.preservedFiles`. Existing history/preferences sentinels remain bound. Hermes `profiles/work` must be absent before the profile module creates its owned second directory.

Run with workspace PowerShell 7:

```powershell
.tools/pwsh/pwsh.exe -NoProfile -File tests/acceptance/verify-production-extra-ui.ps1 -SetupFile <exact-owned-setup.json>
```

The runner attaches only to the supervisor's retained production WebView, verifies the fresh empty native configuration, exercises the profile module first, and then exercises the tray module. Only GUI actions trigger discovery; direct native calls are limited to overview and background readbacks. The application invoke function is not replaced. No credentials, official clients, startup registry changes, or confirmed application exit are involved.

Source manifests, executable, shared runtime files, dispatch entries, original fixture files and helper bytes are bound before and after the run. The supervisor retains exact process identity and applies the existing strict owner/reparse cleanup functions without weakening them. The 600-second run deadline is fixed; process cleanup uses exact retained handles and records its own result. A failed original run remains failed even if a later cleanup succeeds.

Public evidence is written to `artifacts/acceptance/production-extra-ui-<ownerId>/`. Raw production logs are hashed without reading or retaining their content. Failure messages omit raw inputs. `passed` describes only this bounded lane; `complete`, `fullAcceptancePassed`, actual login, actual exit, official-client and public-release claims remain false. A fresh native bridge that cannot safely open exit confirmation records cancellation as `unvalidated` and does not click exit.

The synthetic contract tests prove guard behavior only. They do not constitute real GUI or tray acceptance.
