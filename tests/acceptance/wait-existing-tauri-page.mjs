import assert from "node:assert/strict";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitExistingTauriPage(
  browser,
  { timeoutMs = 30000, pollMs = 200, evaluationTimeoutMs = 1000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matches = [];
    for (const candidate of browser
      .contexts()
      .flatMap((context) => context.pages())) {
      let timer;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const ready = await Promise.race([
        candidate
          .evaluate(
            () => typeof window.__TAURI_INTERNALS__?.invoke === "function",
          )
          .catch(() => false),
        new Promise((resolve) => {
          timer = setTimeout(
            () => resolve(false),
            Math.min(evaluationTimeoutMs, remaining),
          );
        }),
      ]).finally(() => clearTimeout(timer));
      if (ready === true) matches.push(candidate);
    }
    assert.ok(matches.length <= 1, "Multiple real Tauri pages rejected");
    if (matches.length === 1) return matches[0];
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
  throw new Error(
    "Existing real Tauri WebView did not become ready within bounded startup deadline",
  );
}
