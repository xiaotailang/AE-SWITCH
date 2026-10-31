import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Exercise the driver's verbatim selection function without executing its
// production process/credential setup. No copy of the implementation is tested.
const workspace = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const require = createRequire(path.join(workspace, "app/package.json"));
const ts = require("typescript");
const filename = path.join(
  workspace,
  "tests/acceptance/production-ui-eight.mjs",
);
const text = fs.readFileSync(filename, "utf8");
const source = ts.createSourceFile(
  filename,
  text,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const declaration = source.statements.filter(
  (node) =>
    ts.isFunctionDeclaration(node) &&
    node.name?.text === "explicitlySelectOwnedProfile",
);
assert.equal(declaration.length, 1);
const selectOwned = new Function(
  "assert",
  `return (${declaration[0].getText(source)});`,
)(assert);
const owned = {
  directory: "G:/synthetic-owned/zcode",
  executablePath: "G:/synthetic-owned/zcode.ps1",
  homeDirectory: "G:/synthetic-owned/home",
  workspaceDirectory: "G:/synthetic-owned/workspace",
};
const other = { ...owned, directory: "G:/synthetic-other/zcode" };
const ownedValue = JSON.stringify(owned);
const otherValue = JSON.stringify(other);
function field(previous, options = ["", otherValue, ownedValue]) {
  let value = previous;
  const selections = [];
  return {
    selections,
    locator: () => ({
      evaluateAll: async (callback) =>
        callback(options.map((value) => ({ value }))),
    }),
    inputValue: async () => value,
    selectOption: async (selected) => {
      selections.push(selected);
      value = selected;
    },
  };
}
test("a surface-preselected owned profile is explicitly selected again and exactly verified", async () => {
  const target = field(ownedValue);
  assert.deepEqual(await selectOwned(target, owned), {
    explicitOwnedProfileSelected: true,
    previousSelection: "owned",
    candidateCount: 2,
  });
  assert.deepEqual(target.selections, [ownedValue]);
});
test("an unselected ambiguous list receives one exact explicit owned choice", async () => {
  const target = field("");
  assert.equal((await selectOwned(target, owned)).previousSelection, "empty");
  assert.deepEqual(target.selections, [ownedValue]);
});
test("a retained different discovered profile is recognized before explicit owned selection", async () => {
  const target = field(otherValue);
  assert.equal(
    (await selectOwned(target, owned)).previousSelection,
    "another-discovered-profile",
  );
  assert.deepEqual(target.selections, [ownedValue]);
});
test("unknown retained selection, missing or duplicate owned target never trigger selection", async () => {
  for (const target of [
    field("foreign-retained-value"),
    field("", ["", otherValue]),
    field(ownedValue, [ownedValue, ownedValue]),
  ]) {
    await assert.rejects(() => selectOwned(target, owned));
    assert.deepEqual(target.selections, []);
  }
});
