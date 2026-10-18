import assert from "node:assert/strict";
import test from "node:test";
import { assertCodexContextOverrides } from "./native-business-extra.mjs";

const preserved = {
  contextWindow: 64000,
  compactTokenLimit: 48000,
  perModelContext: false,
};
const edited = { ...preserved, perModelContext: true };
const globals =
  "model_context_window = 64000\nmodel_auto_compact_token_limit = 48000\n";

test("ordinary connection operations require both original root overrides", () => {
  assertCodexContextOverrides(
    `${globals}[features]\nfast_mode = true\n`,
    preserved,
  );
});

test("explicit model context requires removing only the root context override", () => {
  assertCodexContextOverrides(
    "model_auto_compact_token_limit = 48000\n[model_providers.other]\nmodel_context_window = 64000\n",
    edited,
  );
});

test("retained global context cannot pass the explicit edit gate", () => {
  assert.throws(() => assertCodexContextOverrides(globals, edited));
});

test("removed or modified compact cannot pass either operation gate", () => {
  for (const options of [preserved, edited]) {
    for (const compact of ["", "model_auto_compact_token_limit = 47000\n"]) {
      const context = options.perModelContext
        ? ""
        : "model_context_window = 64000\n";
      assert.throws(() =>
        assertCodexContextOverrides(context + compact, options),
      );
    }
  }
});

test("provider keys cannot stand in for missing root overrides", () => {
  assert.throws(() =>
    assertCodexContextOverrides(
      `[model_providers.other]\n${globals}`,
      preserved,
    ),
  );
});

test("an ordinary save must fail if only global context is removed", () => {
  assert.throws(() =>
    assertCodexContextOverrides(
      "model_auto_compact_token_limit = 48000\n",
      preserved,
    ),
  );
});
