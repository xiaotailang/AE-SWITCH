import assert from "node:assert/strict";
import test from "node:test";
import { waitExistingTauriPage } from "./wait-existing-tauri-page.mjs";

const browser = (pages) => ({ contexts: () => [{ pages }] });
const options = { timeoutMs: 100, pollMs: 2, evaluationTimeoutMs: 10 };

test("existing Tauri page can become ready after startup", async () => {
  let polls = 0;
  const starting = { evaluate: async () => ++polls > 2 };
  assert.equal(
    await waitExistingTauriPage(
      browser(() => [starting]),
      options,
    ),
    starting,
  );
});

test("existing browser can gain its real page after an empty enumeration", async () => {
  let enumerations = 0;
  const ready = { evaluate: async () => true };
  assert.equal(
    await waitExistingTauriPage(
      browser(() => (++enumerations > 2 ? [ready] : [])),
      options,
    ),
    ready,
  );
});

test("unrelated pages are skipped and multiple real Tauri pages are rejected", async () => {
  const ready = { evaluate: async () => true };
  assert.equal(
    await waitExistingTauriPage(
      browser(() => [{ evaluate: async () => false }, ready]),
      options,
    ),
    ready,
  );
  await assert.rejects(
    waitExistingTauriPage(
      browser(() => [ready, ready]),
      options,
    ),
    /Multiple real/,
  );
});

test("navigation exceptions and stalled evaluations remain bounded failures", async () => {
  await assert.rejects(
    waitExistingTauriPage(
      browser(() => [
        {
          evaluate: async () => {
            throw new Error("navigation");
          },
        },
      ]),
      options,
    ),
    /bounded startup/,
  );
  const started = Date.now();
  await assert.rejects(
    waitExistingTauriPage(
      browser(() => [{ evaluate: () => new Promise(() => {}) }]),
      options,
    ),
    /bounded startup/,
  );
  assert.ok(Date.now() - started < 500);
});
