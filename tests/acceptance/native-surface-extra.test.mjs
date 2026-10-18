import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateSurfaceOwnedRoot } from "./native-surface-extra.mjs";

test("owned surface requires the exact UUID/portable tree and both markers", async (t) => {
  const workspace = path.resolve(
    fileURLToPath(new URL("../../", import.meta.url)),
  );
  assert.match(workspace, /^G:[\\/]/iu);
  const id = randomUUID().replaceAll("-", "");
  const uuidRoot = path.join(workspace, ".cache/native-e2e-sandbox", id);
  const root = path.join(uuidRoot, "portable");
  const marker = path.join(uuidRoot, ".ae-native-e2e-owner.json");
  const copy = path.join(root, ".ae-native-e2e-owner.json");
  const owner = {
    id,
    workspace,
    purpose: "AE Switch owned native UI and real tool acceptance",
  };
  const bytes = Buffer.from(JSON.stringify(owner));
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(marker, bytes, { flag: "wx" });
  await fs.writeFile(copy, bytes, { flag: "wx" });
  try {
    await t.test("exact portable path validates UUID identity", async () => {
      assert.deepEqual(await validateSurfaceOwnedRoot(root), {
        root,
        uuidRoot,
        id,
        workspace,
      });
    });
    await t.test(
      "UUID itself, arbitrary nesting, and non-G input fail",
      async () => {
        for (const candidate of [
          uuidRoot,
          path.join(root, "portable"),
          path.join(uuidRoot, "nested/portable"),
          "C:\\portable",
        ])
          await assert.rejects(validateSurfaceOwnedRoot(candidate));
      },
    );
    await t.test("lexical parent alias fails", async () => {
      await assert.rejects(
        validateSurfaceOwnedRoot(`${root}${path.sep}..${path.sep}portable`),
      );
    });
    for (const location of [marker, copy]) {
      await t.test(
        `${location === marker ? "top" : "portable"} marker is required`,
        async () => {
          await fs.unlink(location);
          try {
            await assert.rejects(validateSurfaceOwnedRoot(root));
          } finally {
            await fs.writeFile(location, bytes, { flag: "wx" });
          }
        },
      );
      for (const [field, value] of [
        ["id", "0".repeat(32)],
        ["workspace", path.dirname(workspace)],
        ["purpose", "unowned"],
      ]) {
        await t.test(
          `${location === marker ? "top" : "portable"} marker rejects wrong ${field}`,
          async () => {
            await fs.writeFile(
              location,
              JSON.stringify({ ...owner, [field]: value }),
            );
            try {
              await assert.rejects(validateSurfaceOwnedRoot(root));
            } finally {
              await fs.writeFile(location, bytes);
            }
          },
        );
      }
      await t.test(
        `${location === marker ? "top" : "portable"} hardlink marker fails`,
        async () => {
          const link = path.join(
            uuidRoot,
            `marker-link-${location === marker ? "top" : "copy"}`,
          );
          await fs.link(location, link);
          try {
            await assert.rejects(validateSurfaceOwnedRoot(root));
          } finally {
            await fs.unlink(link);
          }
        },
      );
    }
    await t.test(
      "equal identity with different marker bytes fails",
      async () => {
        await fs.writeFile(copy, JSON.stringify(owner, null, 2));
        try {
          await assert.rejects(validateSurfaceOwnedRoot(root));
        } finally {
          await fs.writeFile(copy, bytes);
        }
      },
    );
    await t.test("oversize marker fails before parsing", async () => {
      await fs.writeFile(copy, " ".repeat(8193));
      try {
        await assert.rejects(validateSurfaceOwnedRoot(root));
      } finally {
        await fs.writeFile(copy, bytes);
      }
    });
    await t.test("junction portable directory fails", async () => {
      const retained = path.join(uuidRoot, "retained-portable");
      await fs.rename(root, retained);
      await fs.symlink(retained, root, "junction");
      try {
        await assert.rejects(validateSurfaceOwnedRoot(root));
      } finally {
        await fs.unlink(root);
        await fs.rename(retained, root);
      }
    });
    assert.deepEqual(await validateSurfaceOwnedRoot(root), {
      root,
      uuidRoot,
      id,
      workspace,
    });
  } finally {
    assert.equal(
      path.dirname(uuidRoot),
      path.join(workspace, ".cache/native-e2e-sandbox"),
    );
    assert.deepEqual(await fs.readFile(marker), bytes);
    await fs.rm(uuidRoot, { recursive: true });
    assert.equal(
      await fs.stat(uuidRoot).then(
        () => true,
        () => false,
      ),
      false,
    );
  }
});
