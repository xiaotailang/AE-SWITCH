# Production profile selection surface

`verifyProductionProfiles({ page, setup, launch, readonlyNative })` verifies a bounded Hermes multi-directory selection workflow in the current production AE desktop. It returns a structured receipt. A failure throws an error with `error.profileReceipt`; the caller must retain that failed receipt and continue its own retained-process cleanup.

The caller owns the fresh UUID preparation, current build/source/binary binding, real native CDP page, retained production/process identities, whole-run deadline and final sandbox deletion. This module launches no client and changes no provider or agent configuration. It does not open help, touch startup settings, minimize/close the window or alter shared runners.

## Prelaunch fixture contract

Use the existing fresh known setup layout: `setup.root` is exactly `<workspace>/.cache/native-e2e-sandbox/<ownerId>`, with the unchanged `.ae-production-ui-eight-owner.json`, `setup.json` and `production-launch-receipt.json`. Production and CDP descendant proof must be present in `launch`. QA hooks and discovery-context injection must be false.

The original Hermes directory A must be exactly `<root>/installed-clients/home/.hermes`; its launch file is `<root>/installed-clients/bin/hermes.ps1`, and its ordinary launch cwd is `<root>/installed-clients/workspace`. `setup.fixtures.environment.HERMES_HOME` and `setup.fixtures.payload.profiles.hermes` must describe these same paths.

Before product launch, preparation adds A's synthetic `config.yaml` without overwriting an existing file, using UTF-8 without BOM and the exact string exported by `hermesProfileConfig(ownerId)`:

```js
import { hermesProfileConfig } from "./production-profile-surface.mjs";
// The caller performs its exact fresh-owner/path checks first.
fs.writeFileSync(configFile, hermesProfileConfig(setup.ownerId), {
  flag: "wx",
});
```

The bytes are:

```text
# AE owned Hermes profile fixture <ownerId>
model: fixture-original
user_preference: keep-<ownerId>
```

Append the config file's SHA256 binding to `setup.fixtures.payload.preservedFiles`, alongside the existing bound `user-history.keep` and `user-preferences.keep`. Persist the updated setup before launch. A may contain only these three known synthetic files and, optionally, an empty ordinary `profiles` directory. Unbound files, other directories, noncanonical config, missing/duplicate SHA bindings, symlinks/junctions and hard-linked fixture files cause refusal before copying. No credentials input is required or read.

The module revalidates the owner, setup/launch receipt bytes and production image, then creates only A's previously absent `profiles/work` directory B. It copies the three verified files with exclusive-create semantics and adds `.ae-production-profile-copy.json`. It preserves A's bytes and inventories, audits B's copies, and leaves B for the caller's exact owned-tree cleanup. The module never patches missing A files or overwrites an existing B. A failed partially prepared B also belongs to that exact owner root and must be retained for supervisor cleanup.

## GUI checks and model gate

Start with a fresh native provider store and all agents unconfigured. The current connection draft must have empty provider, endpoint, supplier name, key and model; the key is password-masked, automatic mode is active, and help/dialogs are closed. `readonlyNative` is called directly only for `get_overview` and `agent_hub_overview`.

The six required GUI checks are exported as `PROFILE_CHECKS`:

1. Create and audit the fresh B copy without modifying A.
2. Select Hermes and click its discovery retry. Observe the actual Rust `agent_hub_discover` response with exactly A and B, matching original home/launcher/cwd and `limited:false`. Both directories remain unselected initially, and the multiple-candidate guidance is visible.
3. Start an owned Node HTTP listener on `127.0.0.1` with a random port. Fill its endpoint and a generated synthetic key in the real GUI. The actual Rust `discover_provider_connection` reads `/v1/models` and returns the synthetic `gpt-5.4` catalog; an unselected profile keeps confirmation disabled while “仅保存” is enabled.
4. Select A and then B explicitly. Both selections enable confirmation; confirmation is never clicked.
5. Enter manual mode seeded from B. Clear each of the four required fields individually, also testing whitespace-only input, and observe confirmation disabled; restore the field and observe confirmation enabled. No save/configure/probe is issued.
6. Return to automatic B and click discovery retry. B remains selected and confirmation remains enabled.

The local listener authenticates only the generated synthetic key, accepts only `GET /v1/models`, records counters without raw keys and rejects all other requests. Finally, the module clears its unsaved key/endpoint, restores the public page state, closes all owned server sockets/listener and verifies the A/B hashes and native provider/agent configuration baseline. Native mutation, external-opening and client commands are rejected by the receipt contract.

## Receipt and acceptance boundary

Successful output includes `passed`, `pageRestored`, `nativeStateUnchanged`/`nativeStoreUnchanged`, `originalFilesUnchanged`/`fixtureOriginalsUnchanged`, `copiedFilesUnchanged`, `serverClosed`, exact native before/after hashes, the six check records, two discovery responses, four manual-field records, synthetic catalog request counters and the bounded A/B manifests. `fixture.namedProfileRetainedForSupervisorCleanup` is true. The caller separately proves process exit and whole-root cleanup.

`complete`, `fullAcceptancePassed`, `credentialsRead`, `upstreamSupplierVerified`, `inferenceExecuted`, `configurationApplied`, `officialClientsLaunched`, `qaHooksUsed` and `applicationInvokeReplaced` are false. The explicit scope says this is a localhost synthetic model catalog. It does not verify a real supplier, inference, client execution, profile changes after configuration or historical-session acceptance. Local regression tests also do not prove current-production GUI behavior.

## Local verification

```powershell
.tools/node/node.exe --test tests/acceptance/production-profile-surface.test.mjs
.tools/node/node.exe --check tests/acceptance/production-profile-surface.mjs
```

The focused Windows/G: regression creates only fresh marked fixture roots, exercises actual filesystem junction/hardlink refusal and copy preservation, tests actual localhost HTTP authentication and listener closure, and checks receipt/command gates. Its teardown audits known fixture entries, unlinks only its registered links, and removes files/directories without recursive traversal. It never starts AE, executes a fixture launcher or reads user configurations.
