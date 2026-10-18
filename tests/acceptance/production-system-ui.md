# Separate production system UI acceptance

This lane runs only startup-setting and window controls using a fresh prepared production sandbox. It reads no credentials, launches no official clients, and has a dedicated `production-system-ui-<owner UUID>` output. It does not rerun or claim the eight-client acceptance.

```powershell
.tools/pwsh/pwsh.exe -NoProfile -File tests/acceptance/verify-production-system-ui.ps1 -SetupFile '<fresh owned setup.json>'
```

The supervisor reuses the existing preparation's exact UUID marker, current build/source/package hashes, parsed fixture functions and parsed retained-process cleanup functions. It refuses an occupied CDP port, retains the real production process and the exact owned WebView2 listener, and binds helper hashes through cleanup. Its whole run has a fixed ten-minute deadline. Start it after any other production GUI run has finished and released port 9223.

`production-system-ui.mjs` calls the frozen `verifyProductionBackground` interface. Real quickstart-checkbox clicks enable and then disable the production HKCU startup value. Independent registry readback must match the exact owned quoted executable command, preserve every other startup entry, and restore an absent target baseline. A pre-existing target is a conflict and is retained; it cannot be deleted by this lane. Any emergency registry removal makes the run fail even if cleanup succeeds.

The driver then clicks the real minimize and close-to-background UI controls. The independent `production-owned-window-state.ps1` helper opens a retained production process handle, verifies exact PID/creation time/image/hash and root/marker/setup/launch bindings, and finds exactly one main HWND with the production title. It reads real Win32 visible/minimized state and the driver checks the Rust bridge while the window is minimized or hidden. Each action recovers with `ShowWindow(SW_RESTORE)` on that same exact HWND, explicitly as test setup. The helper is read-only by default; only `-RestoreForSetup` performs this setup action.

Finally, the supervisor quiesces a still-running exact retained Node driver so it cannot schedule another startup transition during recovery. Before stopping the production process or removing the sandbox, it independently rechecks the persisted registry baseline. If the exact owned startup value remains, it invokes the frozen `restore-production-background.ps1 -EmergencyCleanup`, retaining a process identity for that helper. It rechecks complete baseline preservation, checks it again after owned process exit, and keeps the sandbox/recovery binding if preservation fails. The restore helper deliberately refuses deletion when the target is already absent, so no emergency deletion is invoked on an already restored baseline. Product logs remain private and only their hashes are retained.

Receipt `passed` covers this scope only, and `complete`/`fullAcceptancePassed` remain false. A tray icon menu/restore/exit is not exercised or claimed. A real Windows login is not executed. Official clients, inference, account/default-model/history and other platforms use separate receipts. The Win32 setup recovery is not evidence of tray restoration.

Local regression tests use synthetic safety receipts only. Parser/native-interop compilation checks do not execute registry or GUI actions. Root owns the actual production run, credentials and final release claims.
