The independent production tray module exports `verifyProductionTray({ page, setup, launch, readonlyNative })`. It uses the existing setup schema 2 and retained production launch receipt. It reads no credentials, launches no client and changes no configuration or registry value.

The module clicks the real UI close button twice. For each hide it independently checks the same retained main HWND and healthy gateway. One restore uses a real tray double-click; the other uses the actual native tray menu's “打开 AE Switch” item. It records actual input and same-HWND visibility, and restores cursor position, overflow visibility and the helper thread's DPI context. It never substitutes ShowWindow or a notification callback message.

Icon identity is established before input through the current owned process handle, image path, creation time, executable hash, marker and source manifest, the unique `tray_icon_app` callback HWND owned by that PID, and `Shell_NotifyIconGetRect` with that exact HWND, `uID=2`, `GUID_NULL`. The locked tray-icon 0.25.1 implementation consumes counter 1 for its logical ID and counter 2 for this application's sole notification icon. The lock's exact version/checksum and single production builder are checked. If this assumption changes or the Windows API cannot locate that exact icon, the driver rejects the action. The API rectangle, unique visible UIA button, fixed production tooltip, runtime ID, fresh layout, cursor and native shell hit must agree before each button pair. Static tooltip alone never authorizes input.

Native menu identity uses the exact owned `#32768` HWND/HMENU, two unique enabled product labels, fresh bounds, highlighted item and native hit test. Exit cancellation additionally requires the exact ordinary owned `data/agent-selection.json`, because a fresh store's exit action terminates immediately. Without it the module returns `exitCancel.status=unvalidated` and does not enter exit. With it the module checks the exact owned dialog and cancels using its unique native/UIA button. Confirmation and actual exit are forbidden. Source/owner/process guards run again before input. The configured run must remain otherwise idle while cancellation is tested.

`passed` covers the executed restoration gates and cleanup. Missing cancellation remains explicit; `fullAcceptancePassed`, `actualExitConfirmed` and `processStopped` remain false. This module supplies no claim about Windows login, actual tray exit, desktop-client defaults, history or upstream tool acceptance.

Focused local checks:

```powershell
node --test tests/acceptance/production-tray-surface.test.mjs
powershell.exe -NoProfile -File tests/acceptance/production-owned-tray.test.ps1
```

The PowerShell harness parses the driver and compiles its C# but calls only pure selectors and synthetic input delegates. It does not execute the driver, P/Invokes or GUI input. Actual production GUI acceptance must be run separately against the frozen current build.

API references: [Shell_NotifyIconGetRect](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shell_notifyicongetrect), [NOTIFYICONIDENTIFIER](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/ns-shellapi-notifyiconidentifier).
