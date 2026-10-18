# Production UI eight-client acceptance migration

Scope: preserve the existing production single-page acceptance workflow in
`tests/acceptance/` with stable names. Do not change application source, widen the
legacy native suite, run clients or network requests, or clean existing sandboxes.

1. Before migrating, run the existing synthetic request/input/tool-proof/privacy
   contract checks and bounded existing-WebView selection checks.
2. Move the runner, preparation, supervision and small supporting contracts into
   durable acceptance files. Keep the temporary originals as historical evidence.
   Reuse the existing configuration/history readback helper and the exact,
   hash-bound fixture/process/cleanup functions from `scripts/verify-portable-e2e.ps1`.
3. Change only names, import locations, invocation paths and helper hash coverage
   in the existing execution workflow. Preserve production build/source/package
   bindings, native IPC observation, profile auto-selection, official tool
   write/read, shared-runtime and preserved-file comparisons, process ownership,
   G-drive/reparse guards, cleanup gates and private-output handling.
4. Replace the one-run evidence checker assumptions (exactly eight upstream
   failures and a separate post-exit cleanup receipt) with reusable verification
   of complete passes or recorded failures. Never turn evidence integrity into a
   tool-acceptance claim, and never assert unperformed screenshot visual review.
5. Add focused synthetic regressions for preserved safety contracts, evidence
   tampering/failure boundaries and path relocation. Parse PowerShell and syntax
   check JavaScript. Document the prepare/supervise/evidence commands and remaining
   limits; real production/client acceptance remains a separate live run.

Stop condition: local synthetic safety regressions pass and durable scripts parse;
no live-client or release-readiness claim is made by this migration.
