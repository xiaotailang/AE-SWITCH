# WorkBuddy official runtime evidence

Runtime researched on 2026-10-08; archive and desktop bootstrap rechecked on 2026-10-10. WorkBuddy is the Tencent desktop product, separate from the independently distributed CodeBuddy CLI. AE Switch uses the runtime included in the official WorkBuddy Windows package. The four runtime files listed below match the original installer; this audit does not claim a whole-distribution comparison.

## Official references

- Product: <https://www.workbuddy.cn/>
- Custom models: <https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model>
- Windows installation and account login: <https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Installation-Win-Guide>
- Latest release API, used by the official download page: <https://www.codebuddy.cn/v2/update?platform=workbuddy-win32-x64-user>

The model documentation explicitly permits a custom URL, API Key and model name, with an OpenAI-compatible `/chat/completions` URL by default. The advanced custom-protocol setting uses the supplied URL directly. The Windows installation documentation describes a desktop application and browser account login; it does not document an independent WorkBuddy CLI installation.

## Download provenance and extraction

The release API returned version `5.7.6.40409493` and this official package:

<https://download.codebuddy.cn/workbuddy/saas/win32-x64-user/WorkBuddy-win32-x64-user-5.7.6.40409493-306add2a.exe>

The downloaded file is 435,534,672 bytes. SHA-256:

`044B17B87A55282E79E67595485EE3046CF4B9B6A2F0429B37C55925A3D22354`

Windows Authenticode verification succeeded for Tencent Technology (Shenzhen) Company Limited. The installer was never run. Its NSIS archive was extracted with 7-Zip, then the embedded `$PLUGINSDIR/app-64.7z` was extracted into `.tools/workbuddy`. The complete distribution is copied into `tools/agents/workbuddy` when packaging AE Switch.

`resources/app.asar/package.json` identifies `@genie/workbuddy-desktop`, version `5.7.6`, product `WorkBuddy`. The bundled host's `cli/product.json` identifies `productName` and `applicationName` as `WorkBuddy`, account identity `workbuddy-desktop`, and data folder `.workbuddy`.

## Original distribution comparison

The [2026-10-10 read-only receipt](../artifacts/acceptance/workbuddy-gui-static-audit-20261010.json) records a fresh installer SHA-256 and valid Tencent Authenticode signature. `7z x -so` streamed the installer's `$PLUGINSDIR/app-64.7z` directly into SHA-256 without writing extracted output. Its 434,768,460 bytes and SHA-256 `64feccaeb416c8a0d404fd57801fe5eac94669c19b3e2f98175d0fcf94fdf012` match the retained nested archive. Four entries were then streamed and compared with `.tools/workbuddy`:

| Official archive entry | Bytes       | SHA-256                                                            | Local match |
| ---------------------- | ----------- | ------------------------------------------------------------------ | ----------- |
| `ffmpeg.dll`           | 3,040,768   | `b603963d6cf944f5379df56856261f9bb951bedd74d273c5058a91e4ae7ef2cc` | Exact       |
| `ffmpeg.dll.bak`       | 3,040,768   | `b603963d6cf944f5379df56856261f9bb951bedd74d273c5058a91e4ae7ef2cc` | Exact       |
| `WorkBuddy.exe`        | 204,585,008 | `55d08c35528023489f16b48bb23fad752eef6fe4ffd8032e1bbe82223d99aee3` | Exact       |
| `resources/app.asar`   | 211,193,422 | `a0df3628a73d65afbcc6750b8fe5d98a19dfe7f0811687dbc6c1b9c4521b893a` | Exact       |

`ffmpeg.dll.bak` is present in the original official distribution. Its presence is not evidence that AE Switch patched the DLL. The comparison covers these four files in the retained local runtime, not every file or a later packaged copy. No installer or desktop GUI was launched for this audit.

## Real configuration and runtime

The official desktop settings UI writes an array of custom model records to `%USERPROFILE%/.workbuddy/models.json`. `WORKBUDDY_CONFIG_DIR`, or `CODEBUDDY_CONFIG_DIR`, overrides that directory. The official bundled `CustomModelsProductProvider` reads this same file and accepts either an array or an object containing `models`.

The AE Switch configuration uses the verified array schema:

```json
[
  {
    "id": "selected-model-id",
    "name": "selected-model-id",
    "url": "http://127.0.0.1:PORT/agents/AGENT/v1",
    "apiKey": "local-gateway-token",
    "supportsToolCall": true,
    "supportsImages": false,
    "supportsReasoning": false,
    "useCustomProtocol": false
  }
]
```

The optional vendor field is omitted. The official host successfully loaded this shape and sent a request to the configured endpoint using its API key and model ID. WorkBuddy internally prefixes custom model IDs with `custom-local:` and retains the original ID as an alias; the original ID works with `--model` and is sent to the model service.

AE Switch invokes `WorkBuddy.exe` with `ELECTRON_RUN_AS_NODE=1`, executing the package's own `resources/app.asar.unpacked/cli/bin/codebuddy`. The official entry routes `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1` to `dist/codebuddy-lite-wb.mjs`, the WorkBuddy-specific host bundle. The retained internal filename and help text refer to shared CodeBuddy code; no standalone CodeBuddy package is installed or substituted.

Required launcher settings are `CODEBUDDY_HOST=workbuddy-desktop`, matching `WORKBUDDY_CONFIG_DIR` and `CODEBUDDY_CONFIG_DIR`, and disabled automatic updates and telemetry. The launcher always supplies `--model` from the saved selection. With no user arguments it starts the bundled host's local `--serve` endpoint; it does not automatically open a system browser. Print and tool verification use the host's real `-p`, `--output-format stream-json`, `--verbose`, `--tools Read,Write,Edit`, `--permission-mode acceptEdits`, and `--no-session-persistence` flags.

The launcher restricts executable sources to the portable workspace and rejects C-drive paths and reparse-point ancestors. WorkBuddy's graphical desktop startup registers its deep-link scheme; AE Switch therefore does not invoke desktop GUI startup or protocol registration in this portable workflow.

## Desktop GUI isolation boundary

Static inspection of the original application confirms `WORKBUDDY_CONFIG_DIR`, then `CODEBUDDY_CONFIG_DIR`, then the product data folder under `homedir` as the configuration-directory priority. `WORKBUDDY_USER_DATA_DIR` overrides `configDir/app`; the session directory is `userDataDir/session`, and application logs use `configDir/logs`. These process variables and G-drive `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `PROGRAMDATA`, `TMP` and `TEMP` would have to be set before process creation. Inherited `WORKBUDDY_ORIGINAL_USERPROFILE`, `WORKBUDDY_FALLBACK_HOME`, `WORKBUDDY_FALLBACK_HASH` and `WORKBUDDY_STALE_FALLBACK_CONFIG_DIR` can otherwise trigger recovery into an original profile and must be cleared. Legacy migration and startup repair also need separate isolation checks.

This controls data paths but does not establish system isolation. `main/index.js` calls `registerDeepLinkSchemes()` during startup (byte offset 1,375,130), and the implementation calls `electron.app.setAsDefaultProtocolClient` (1,378,773). Empty `WORKBUDDY_DEEPLINK_SCHEMES` or `WORKBUDDY_DEEPLINK_SCHEME` falls back to the default schemes in `main/code-cache.js` (1,496,857); no supported disable-registration option was established. Auto-launch reconciliation (1,104,381) may call `setLoginItemSettings` to enable startup on first packaged Windows launch when no saved preference or applied marker exists (884,906). Redirecting `PROGRAMDATA` also does not redirect the hardcoded `C:\WorkBuddy-env` fallback discovery; that directory was absent at this audit.

The official installation guide describes a separate WorkBuddy account login. A custom model API Key authenticates the model service and does not prove that the desktop application can run without its account authentication. The desktop account gate, model-selection workflow and history UI have not been run. An independent disposable Windows VM, or an officially supported startup mode that avoids protocol registration and other system changes, is needed before claiming desktop GUI acceptance under the current isolation requirement. The headless host evidence remains separate, with `desktopGuiVerified:false`.

## Verification scope

The initial configuration-consumption probe observed `POST /v1/chat/completions`, exact selected model ID, and exact matching Bearer API key. Its local observation server deliberately returned HTTP 400 before inference. This proves configuration consumption only and is not a model-inference or tool-execution acceptance result.

Actual inference and file write/read acceptance belong to AE Switch's independent per-agent verification report. A successful `--help`, generated configuration, zero process exit code, or packaging run does not establish tool execution. WorkBuddy desktop GUI login and graphical interaction have not been verified by this host workflow.

## Brand and license provenance

The official website's WorkBuddy favicon supplies the original SVG:

<https://download.codebuddy.cn/web/workbuddy/788eb1c5ba3681efa98cf7b58ae688e293c1bb34/assets/logo.svg>

The website SVG and desktop product metadata do not grant an open-source license for Tencent's WorkBuddy application or brand assets. They remain Tencent's property and are not covered by AE Switch's license. The original Electron license and Chromium notices are retained in `LICENSE.electron.txt` and `LICENSES.chromium.html`; Tencent's service terms remain applicable. AE Switch records the product source and runtime boundary in its packaged WorkBuddy provenance notice.
