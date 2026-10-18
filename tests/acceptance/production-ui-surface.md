# Production GUI surface checks

`production-ui-surface.mjs` runs the current production Tauri page through safe GUI controls around the eight-client connection and inference acceptance. It uses the existing production page and native IPC. It does not replace invoke, intercept requests, supply mock models, invoke configuration writes directly, or start an external client.

```js
import { verifyProductionSurface } from "./production-ui-surface.mjs";

report.surfaceBefore = await verifyProductionSurface({
  page,
  setup,
  readonlyNative,
  phase: "before",
});
// The owner runs its actual eight-client GUI connection, inference and revalidation.
report.surfaceAfter = await verifyProductionSurface({
  page,
  setup,
  readonlyNative,
  phase: "after",
  provider,
});
```

The caller owns production-binary/source binding, isolated ordinary client profiles, global deadline, CDP connection, process ownership and cleanup. Call with cleared and masked API-key input, closed help/dialog, and an automatic installed profile. `provider` is the real saved provider returned by the preceding GUI acceptance, with `id`, `name`, `baseUrl` and `model`. Direct `readonlyNative` calls remain limited to `get_overview` and `agent_hub_overview`. Window state uses the explicitly read-only `plugin:window|is_maximized` getter for the `main` window.

The before phase has 11 required GUI checks; the after phase has 16 when a saved provider exists. They cover eight-agent navigation, four-step presentation, launch-disabled state before configuration, quickstart focus/Escape/close, the actual startup-settings read, all built-in tutorial topics and focus restoration, theme persistence and restoration, API-key masking, actual maximize/restore with native state confirmation, saved-connection drafts/folds, required manual-profile fields, optional draft restoration, real read-only discovery retry, new supplier draft clearing and runtime candidate availability.

The failure/retry check uses `http://127.0.0.1:9/v1` and a synthetic invalid key only on that loopback endpoint. Both automatic discovery and one explicit sync retry must return the real Rust `network` error, leave the error visible, expose no model options, disable confirmation/model selection and enable retry. The helper then clears the synthetic key and restores the saved provider through the UI. Failure summaries omit raw input values.

All observed IPC commands must match the bounded read/window allowlist. Reversible page choices and the native maximized state are restored on success or failure. Public native provider/configuration hashes must match after restoration. Errors carry `error.surfaceReceipt`; the caller must preserve that receipt as failed evidence before rethrowing. Missing providers and unavailable supported-startup states are explicit unvalidated entries.

`passed: true` means this bounded surface passed. `complete: false` is mandatory. Actual Windows login/startup changes, ambiguous multi-profile discovery, external browser/Explorer opening, minimize/tray ownership/hide/restore/exit, official client launch/restart, and WorkBuddy account/default desktop task/history require separate current-production evidence. Do not count this helper or its synthetic regression tests as proof for those scopes.

Focused local verification:

```powershell
.tools/node/node.exe --check tests/acceptance/production-ui-surface.mjs
.tools/node/node.exe --test tests/acceptance/production-ui-surface.test.mjs
.tools/node/node.exe app/node_modules/prettier/bin/prettier.cjs --check tests/acceptance/production-ui-surface.mjs tests/acceptance/production-ui-surface.test.mjs tests/acceptance/production-ui-surface.md
```
