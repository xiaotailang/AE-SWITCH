import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { verifyBusinessExtras } from "./native-business-extra.mjs";
import {
  verifyManagementExtras,
  verifyOwnedConflict,
} from "./native-management-extra.mjs";
import { verifyConfigurationExtras } from "./native-configuration-extra.mjs";
import { verifyFormExtras } from "./native-form-extra.mjs";
import { verifyOptionsExtras } from "./native-options-extra.mjs";
import {
  verifyExternalRoutes,
  assertExternalAgentProfile,
} from "./native-external-extra.mjs";
import {
  createNativeUpdateFixture,
  verifyUpdateExtras,
} from "./native-update-extra.mjs";
import { verifySyncRetry } from "./native-sync-extra.mjs";
import { verifyGatewayRecovery } from "./native-gateway-extra.mjs";
import { verifyOwnedWindow } from "./native-window-extra.mjs";
import { validateSurfaceOwnedRoot } from "./native-surface-extra.mjs";

test("external-route checks bind configured clients to the parent-validated original profile", () => {
  const root = "G:\\owned\\portable";
  const profile = {
    directory: "G:\\owned\\installed-clients\\zcode\\configuration",
    homeDirectory: "G:\\owned\\installed-clients\\zcode\\home",
    executablePath: "G:\\official-test-tools\\zcode.cmd",
    workspaceDirectory: "G:\\owned\\installed-clients\\zcode\\workspace",
    stateFile: "G:\\owned\\installed-clients\\zcode\\configuration\\state.json",
  };
  const fixture = { profiles: { zcode: profile } };
  const selected = {
    id: "zcode",
    configured: true,
    profile: structuredClone(profile),
    directory: profile.directory,
  };
  assert.equal(assertExternalAgentProfile(selected, root, fixture), "existing");
  if (process.platform === "win32")
    assert.equal(
      assertExternalAgentProfile(
        {
          ...selected,
          directory: selected.directory.replaceAll("\\", "/"),
          profile: {
            ...profile,
            stateFile: profile.stateFile.replaceAll("\\", "/").toUpperCase(),
          },
        },
        root,
        fixture,
      ),
      "existing",
    );
  assert.throws(() =>
    assertExternalAgentProfile(
      { ...selected, profile: { ...profile, injectedField: true } },
      root,
      fixture,
    ),
  );
  for (const field of Object.keys(profile))
    assert.throws(() =>
      assertExternalAgentProfile(
        {
          ...selected,
          profile: { ...profile, [field]: "G:\\foreign\\wrong-profile" },
        },
        root,
        fixture,
      ),
    );
  assert.throws(() =>
    assertExternalAgentProfile(
      { ...selected, directory: "G:\\foreign\\wrong-directory" },
      root,
      fixture,
    ),
  );
  assert.throws(() =>
    assertExternalAgentProfile(selected, root, { profiles: {} }),
  );
  const privateAgent = {
    ...selected,
    directory: path.join(root, "data/agents/zcode"),
    profile: null,
  };
  assert.throws(() => assertExternalAgentProfile(privateAgent, root, fixture));
  assert.equal(
    assertExternalAgentProfile(
      { ...privateAgent, configured: false },
      root,
      fixture,
    ),
    "legacy-or-unconfigured",
  );
  assert.equal(
    assertExternalAgentProfile(privateAgent, root),
    "legacy-or-unconfigured",
  );
});

test("all extra native flows reject an unowned portable root before product interaction", async (t) => {
  const workspace = path.resolve(
    fileURLToPath(new URL("../../", import.meta.url)),
  );
  assert.match(workspace, /^G:[\\/]/iu);
  const id = randomUUID().replaceAll("-", "");
  const uuidRoot = path.join(workspace, ".cache/native-e2e-sandbox", id);
  const root = path.join(uuidRoot, "portable");
  const fixture = path.join(root, "data/native-ui-fixtures", randomUUID());
  const marker = path.join(uuidRoot, ".ae-native-e2e-owner.json");
  const copy = path.join(root, ".ae-native-e2e-owner.json");
  const ownerBytes = Buffer.from(
    JSON.stringify({
      id,
      workspace,
      purpose: "AE Switch owned native UI and real tool acceptance",
    }),
  );
  await fs.mkdir(fixture, { recursive: true });
  // Keep the portable copy but omit the UUID authority marker. A leaf-only
  // validator used to accept this ownership gap before entering native flows.
  await fs.writeFile(copy, ownerBytes, { flag: "wx" });
  const previousRoot = process.env.AE_NATIVE_EXPECTED_ROOT;
  process.env.AE_NATIVE_EXPECTED_ROOT = root;
  let productInteractions = 0;
  const forbidden = () => {
    productInteractions++;
    throw new Error("Product interaction before ownership validation");
  };
  const page = new Proxy({}, { get: () => forbidden });
  const options = {
    page,
    native: forbidden,
    invoke: forbidden,
    record: async () => {},
    addSecret: forbidden,
    assertPhysicalWorkspacePath: forbidden,
    nativeRoot: root,
    expectedRoot: root,
    fixtureDirectory: fixture,
    fixtureKey: "ae-switch-synthetic-root-guard",
    target: "codex",
  };
  const flows = {
    business: verifyBusinessExtras,
    management: verifyManagementExtras,
    conflict: verifyOwnedConflict,
    configuration: verifyConfigurationExtras,
    form: verifyFormExtras,
    options: verifyOptionsExtras,
    external: verifyExternalRoutes,
    update: verifyUpdateExtras,
    sync: verifySyncRetry,
    gateway: verifyGatewayRecovery,
    window: verifyOwnedWindow,
  };
  try {
    for (const [name, verify] of Object.entries(flows)) {
      await t.test(`${name} requires both root markers`, async () => {
        productInteractions = 0;
        await assert.rejects(verify(options));
        assert.equal(productInteractions, 0);
        assert.deepEqual(await fs.readFile(copy), ownerBytes);
        assert.deepEqual(await fs.readdir(fixture), []);
        await assert.rejects(fs.lstat(marker), { code: "ENOENT" });
      });
    }
    await t.test(
      "update fixture selects only exact UUID/portable shape without starting a server",
      () => {
        const port = "19019";
        const env = {
          AE_NATIVE_QA_LOCAL_FIXTURE_PORT: port,
          UNI_SWITCH_QA_UPDATE_REPOSITORY: "ae-switch-native-qa/repo",
          UNI_SWITCH_QA_UPDATE_ENDPOINT: `http://127.0.0.1:${port}/latest`,
          UNI_SWITCH_QA_UPDATE_OPEN_MARKER: path.join(
            root,
            "data/qa-update-open-marker",
          ),
        };
        const fixtureSpec = createNativeUpdateFixture({
          version: "1.0.0",
          nativeRoot: root,
          env,
        });
        assert.equal(fixtureSpec.marker, env.UNI_SWITCH_QA_UPDATE_OPEN_MARKER);
        for (const nativeRoot of [
          uuidRoot,
          path.join(root, "portable"),
          "C:\\portable",
        ])
          assert.throws(() =>
            createNativeUpdateFixture({ version: "1.0.0", nativeRoot, env }),
          );
      },
    );
  } finally {
    if (previousRoot === undefined) delete process.env.AE_NATIVE_EXPECTED_ROOT;
    else process.env.AE_NATIVE_EXPECTED_ROOT = previousRoot;
    assert.equal(
      path.dirname(uuidRoot),
      path.join(workspace, ".cache/native-e2e-sandbox"),
    );
    assert.deepEqual(await fs.readFile(copy), ownerBytes);
    assert.deepEqual(await fs.readdir(fixture), []);
    // This exact UUID was created above; add the absent authority only after
    // the rejection checks, bind cleanup to its exact bytes, then remove it.
    await fs.writeFile(marker, ownerBytes, { flag: "wx" });
    assert.deepEqual(await fs.readFile(marker), ownerBytes);
    assert.equal((await validateSurfaceOwnedRoot(root)).uuidRoot, uuidRoot);
    await fs.rm(uuidRoot, { recursive: true });
    await assert.rejects(fs.lstat(uuidRoot), { code: "ENOENT" });
  }
});
