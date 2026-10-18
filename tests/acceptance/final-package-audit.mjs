// Read-only package audit. This script never installs, deletes, or launches processes.
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

process.on("uncaughtException", () => {
  // Parsing/read errors can quote file contents. Keep failures credential-safe.
  console.error(
    "Final package audit could not complete; no raw diagnostic content was printed.",
  );
  process.exitCode = 1;
});

const workspace = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const packageDirectory = path.resolve(
  process.argv[2] ??
    path.join(workspace, "artifacts/AE-Switch-portable-win-x64"),
);
const reportDirectory = path.join(workspace, "artifacts/acceptance");
const slash = (value) => value.split(path.sep).join("/");
const childOf = (parent, target) => {
  const relative = path.relative(parent, target);
  return (
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
};
const samePath = (left, right) =>
  path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
if (
  !/^G:/iu.test(workspace) ||
  !childOf(workspace, packageDirectory) ||
  samePath(workspace, packageDirectory)
)
  throw new Error("The final package must be inside this G: workspace.");

async function assertOrdinaryAncestors(target, allowMissing = false) {
  for (let current = target; ; current = path.dirname(current)) {
    try {
      const metadata = await fs.lstat(current);
      if (
        metadata.isSymbolicLink() ||
        !samePath(await fs.realpath(current), current)
      )
        throw new Error(
          "Audit paths cannot use symbolic links, junctions, or redirected ancestors.",
        );
    } catch (error) {
      if (!allowMissing || error.code !== "ENOENT") throw error;
    }
    if (path.dirname(current) === current) break;
  }
}
await assertOrdinaryAncestors(workspace);
await assertOrdinaryAncestors(packageDirectory);
await assertOrdinaryAncestors(reportDirectory, true);
const credentialFile = path.join(workspace, "端点测试用.txt");
await assertOrdinaryAncestors(credentialFile);
const credentialText = await fs.readFile(credentialFile, "utf8");
const key = credentialText
  .split(/\r?\n/u)
  .map((line) =>
    line
      .trim()
      .match(/^api-key[:：](.*)$/u)?.[1]
      ?.trim(),
  )
  .filter((value) => value !== undefined)
  .at(-1);
if (!key)
  throw new Error("The designated credential file has no current API key.");
const suppliedKeys = [
  ...credentialText.matchAll(/api[-_ ]?key\s*[:：]\s*(.+)/giu),
].map((match) => match[1].trim());
const escaped = (value) => JSON.stringify(value).slice(1, -1);
const unicodeEscape = (value, upper = false) =>
  value
    .split("")
    .map((character) => {
      const hex = character.charCodeAt(0).toString(16).padStart(4, "0");
      return `\\u${upper ? hex.toUpperCase() : hex}`;
    })
    .join("");
const variants = new Map([
  ["literal", key],
  ["json", escaped(key)],
  ["double_json", escaped(escaped(key))],
  ["json_slashes", escaped(key).replaceAll("/", "\\/")],
  ["unicode_lower", unicodeEscape(key)],
  ["unicode_upper", unicodeEscape(key, true)],
]);
const privateStrings = [...new Set([...suppliedKeys, ...variants.values()])]
  .filter(Boolean)
  .sort((a, b) => b.length - a.length);
const sanitize = (value) =>
  privateStrings.reduce(
    (text, secret) => text.split(secret).join("<redacted>"),
    String(value),
  );
const safeJson = (value) =>
  JSON.stringify(
    value,
    (_name, item) => (typeof item === "string" ? sanitize(item) : item),
    2,
  );
const digestCache = new Map();
async function digest(filename) {
  if (!digestCache.has(filename)) {
    const hash = crypto.createHash("sha256");
    for await (const chunk of createReadStream(filename)) hash.update(chunk);
    digestCache.set(filename, hash.digest("hex"));
  }
  return digestCache.get(filename);
}

// Reuse the packager's exclusions rather than inventing a different source scope.
const commonDirectories = new Set([
  ".git",
  ".cache",
  "__pycache__",
  ".pytest_cache",
  ".ruff_cache",
  ".mypy_cache",
  ".turbo",
  "coverage",
]);
const appDirectories = new Set([
  "node_modules",
  "dist",
  "target",
  ".omx",
  "data",
]);
const excludedFiles = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".env.vault",
  "端点测试用.txt",
  "direct_url.json",
]);
const excludedSource = (relative, directory) => {
  const parts = slash(relative).toLowerCase().split("/");
  const name = parts.at(-1);
  return directory
    ? commonDirectories.has(name) ||
        (parts[0] === "app" && appDirectories.has(name))
    : excludedFiles.has(name) ||
        /\.(?:pyc|pyo|log)$/u.test(name) ||
        (parts[0] === "app" && name.endsWith(".pdb"));
};
async function walk(root, { source = false, prefix = "" } = {}) {
  const files = new Map();
  const unsafePaths = [];
  let directoryCount = 0;
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    const relative = slash(path.relative(root, current));
    const metadata = await fs.lstat(current);
    const scoped = prefix ? `${prefix}/${relative}` : relative;
    if (
      source &&
      relative &&
      excludedSource(
        scoped,
        metadata.isDirectory() || metadata.isSymbolicLink(),
      )
    )
      continue;
    if (
      metadata.isSymbolicLink() ||
      !samePath(await fs.realpath(current), current)
    ) {
      unsafePaths.push(relative || ".");
      continue; // Never follow an unsafe directory.
    }
    if (metadata.isDirectory()) {
      directoryCount++;
      for (const entry of await fs.readdir(current))
        pending.push(path.join(current, entry));
    } else if (metadata.isFile())
      files.set(relative, { filename: current, bytes: metadata.size });
    else unsafePaths.push(relative);
  }
  return { files, unsafePaths, directoryCount };
}

const packageTree = await walk(packageDirectory);
const manifestFile = packageTree.files.get("package-manifest.json");
if (!manifestFile) throw new Error("An ordinary package manifest is required.");
const manifest = JSON.parse(await fs.readFile(manifestFile.filename, "utf8"));
const hashes = {};
for (const [name, manifestField] of [
  ["AE-Switch.exe", "desktopSha256"],
  ["AE-Switch-core.exe", "cliSha256"],
]) {
  const file = packageTree.files.get(name);
  const actual = file ? await digest(file.filename) : null;
  hashes[manifestField] = {
    manifest: manifest[manifestField] ?? null,
    actual,
    matches:
      typeof manifest[manifestField] === "string" &&
      /^[a-f\d]{64}$/iu.test(manifest[manifestField]) &&
      manifest[manifestField].toLowerCase() === actual,
  };
}
const recordedAt = new Date().toISOString();
const base = {
  recordedAt,
  packageDirectory,
  desktopSha256: hashes.desktopSha256.actual,
  cliSha256: hashes.cliSha256.actual,
};
const comparisons = [];
const sourceProblems = [];
let sourceFileCount = 0;
const sourcePrefix = "source/ae-switch/";
const expectedSource = new Set();
for (const rootName of ["app", "scripts", "docs", "tests"]) {
  const root = path.join(workspace, rootName);
  await assertOrdinaryAncestors(root);
  // Relative paths begin with their root name, matching app-specific exclusions.
  const tree = await walk(root, { source: true, prefix: rootName });
  sourceProblems.push(...tree.unsafePaths.map((name) => `${rootName}/${name}`));
  for (const [name, file] of tree.files) {
    const relative = `${rootName}/${name}`;
    expectedSource.add(relative);
    const packaged = packageTree.files.get(sourcePrefix + relative);
    sourceFileCount++;
    if (
      !packaged ||
      file.bytes !== packaged.bytes ||
      (await digest(file.filename)) !== (await digest(packaged.filename))
    )
      sourceProblems.push(relative);
  }
}
const readme = path.join(workspace, "README.md");
await assertOrdinaryAncestors(readme);
expectedSource.add("README.md");
sourceFileCount++;
const packagedReadme = packageTree.files.get(sourcePrefix + "README.md");
if (
  !packagedReadme ||
  (await digest(readme)) !== (await digest(packagedReadme.filename))
)
  sourceProblems.push("README.md");
const unexpectedSource = [...packageTree.files.keys()].filter(
  (name) =>
    name.startsWith(sourcePrefix) &&
    !expectedSource.has(name.slice(sourcePrefix.length)),
);
const criticalFiles = [
  "app/src-tauri/src/agent_verification.rs",
  "app/src-tauri/src/agent_hub.rs",
  "app/src-tauri/src/agent_configs.rs",
  "app/src-tauri/src/agent_discovery.rs",
  "app/src-tauri/src/portable.rs",
  "app/src-tauri/src/cli.rs",
  "app/src-tauri/src/bridge/mod.rs",
  "app/src-tauri/src/bridge/agent_http.rs",
  "app/src/AgentHub.tsx",
  "app/src/lib/agentApi.ts",
  "app/package.json",
  "app/pnpm-lock.yaml",
  "app/vite.config.ts",
  "app/tsconfig.json",
  "app/index.html",
  "app/postcss.config.js",
  "app/tailwind.config.js",
  "app/src-tauri/Cargo.toml",
  "app/src-tauri/Cargo.lock",
  "app/src-tauri/build.rs",
  "app/src-tauri/tauri.conf.json",
  "scripts/workspace-env.ps1",
  "scripts/package-portable.ps1",
  "scripts/verify-portable-e2e.ps1",
  "scripts/test-rust-desktop.ps1",
  "tests/acceptance/native-ui.mjs",
  "tests/acceptance/verify-portable-e2e.mjs",
  "tests/acceptance/portable-launcher-smoke.mjs",
  "tests/acceptance/final-package-audit.mjs",
];
for (const relative of criticalFiles) {
  const packaged = packageTree.files.get(sourcePrefix + relative);
  comparisons.push({
    path: relative,
    matches:
      expectedSource.has(relative) &&
      Boolean(packaged) &&
      !sourceProblems.includes(relative),
    packageSha256: packaged ? await digest(packaged.filename) : null,
  });
}
const uiRoot = path.join(workspace, "app/dist");
await assertOrdinaryAncestors(uiRoot);
const uiTree = await walk(uiRoot);
const uiProblems = [...uiTree.unsafePaths];
for (const [relative, file] of uiTree.files) {
  const packaged = packageTree.files.get(`ui/${relative}`);
  if (
    !packaged ||
    file.bytes !== packaged.bytes ||
    (await digest(file.filename)) !== (await digest(packaged.filename))
  )
    uiProblems.push(relative);
}
const unexpectedUi = [...packageTree.files.keys()].filter(
  (name) => name.startsWith("ui/") && !uiTree.files.has(name.slice(3)),
);
const uiEntryMatches =
  uiTree.files.has("index.html") &&
  packageTree.files.has("ui/index.html") &&
  !uiProblems.includes("index.html");
const correspondence = {
  ...base,
  hashes,
  sourceFileCount,
  sourceScope:
    "Packager app/scripts/docs/tests roots plus README.md; same directory/file exclusions.",
  sourceMismatchPaths: sourceProblems,
  unexpectedSourcePaths: unexpectedSource,
  files: comparisons,
  uiFileCount: uiTree.files.size,
  uiEntryMatches,
  uiMismatchPaths: uiProblems,
  unexpectedUiPaths: unexpectedUi,
  passed:
    packageTree.unsafePaths.length === 0 &&
    Object.values(hashes).every((value) => value.matches) &&
    !sourceProblems.length &&
    !unexpectedSource.length &&
    comparisons.every((value) => value.matches) &&
    uiEntryMatches &&
    !uiProblems.length &&
    !unexpectedUi.length,
};

const privateConfigurationPaths = [];
const topLevelForbidden =
  /^(?:data|\.cache|\.tools|\.git|\.omx|\.codex|\.claude|\.aws|\.ssh|\.env(?:\..*)?|端点测试用\.txt|acceptance-credentials\.txt|credentials?(?:\..*)?|auth\.json|providers\.json|protocol-bridge\.json)$/iu;
const exactPrivateNames = new Set([
  "端点测试用.txt",
  "acceptance-credentials.txt",
  "auth.json",
  "providers.json",
  "protocol-bridge.json",
]);
for (const entry of await fs.readdir(packageDirectory)) {
  if (
    topLevelForbidden.test(entry) ||
    (/\.log$/iu.test(entry) && entry.toLowerCase() !== "packaging.log") ||
    /\.(?:raw|sqlite|sqlite3|db)$/iu.test(entry)
  )
    privateConfigurationPaths.push(entry);
}
const keyMatches = [];
let scannedTextFileCount = 0;
const textual =
  /\.(?:md|txt|json|jsonl|ndjson|ya?ml|toml|rs|tsx?|jsx?|mjs|cjs|ps1|py|html?|css|cmd|bat|sh|xml|svg|log|lock|cfg|conf|ini|rst|c|h|cpp)$/iu;
function decodedKeyInJson(text) {
  const pending = [];
  try {
    pending.push(JSON.parse(text));
  } catch {
    for (const line of text.split(/\r?\n/u)) {
      try {
        pending.push(JSON.parse(line));
      } catch {
        /* Text and source are checked by exact encoded variants. */
      }
    }
  }
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === "string" && value.includes(key)) return true;
    if (value && typeof value === "object") {
      if (Object.keys(value).some((name) => name.includes(key))) return true;
      pending.push(...Object.values(value));
    }
  }
  return false;
}
for (const [relative, file] of packageTree.files) {
  const filename = path.posix.basename(relative).toLowerCase();
  if (
    (relative.startsWith(sourcePrefix) ||
      relative.startsWith("verification/") ||
      relative.startsWith("docs/")) &&
    (exactPrivateNames.has(filename) ||
      /^\.env(?:\.|$)/u.test(filename) ||
      /\.(?:raw|log)$/u.test(filename))
  )
    privateConfigurationPaths.push(relative);
  if (!textual.test(relative) && !/^(?:license|notice)$/iu.test(filename))
    continue;
  const text = await fs.readFile(file.filename, "utf8");
  scannedTextFileCount++;
  const encodings = [...variants]
    .filter(([_label, value]) => value && text.includes(value))
    .map(([label]) => label);
  if (decodedKeyInJson(text)) encodings.push("decoded_json");
  if (encodings.length)
    keyMatches.push({ path: relative, encodings: [...new Set(encodings)] });
}
const bundledClientPaths = [...packageTree.files.keys()].filter((relative) =>
  /^tools\/(?:agents|node|python|pwsh|git)(?:\/|$)/iu.test(relative),
);
const installedClientDistribution =
  manifest.agentProgramsBundled === false &&
  manifest.installedApplicationRequired === true &&
  Array.isArray(manifest.tools) &&
  manifest.tools.length === 0 &&
  bundledClientPaths.length === 0;
const boundaries = {
  ...base,
  totalFiles: packageTree.files.size,
  ordinaryDirectoryCount: packageTree.directoryCount,
  reparsePaths: packageTree.unsafePaths,
  reparseDetection:
    "Node lstat symbolic-link/junction checks plus realpath redirection checks; Node does not expose all Win32 reparse attribute tags.",
  rootDataAbsent: !(await fs.readdir(packageDirectory)).some(
    (name) => name.toLowerCase() === "data",
  ),
  privateConfigurationPaths: [...new Set(privateConfigurationPaths)],
  installedClientDistribution,
  bundledClientPaths,
  allowedBuildLogs: packageTree.files.has("packaging.log")
    ? ["packaging.log"]
    : [],
  buildLogPolicy:
    "packaging.log is retained build provenance and receives the same exact current-key scan; runtime/private logs are forbidden.",
  secretScan: {
    scannedRoots:
      "All AE package directories, runtime and licenses; supported text extensions and LICENSE/NOTICE files",
    credentialSource: "Only designated workspace credential file, memory only",
    scannedTextFileCount,
    matchPolicy:
      "Exact current key literal, common JSON escaping, and decoded JSON string values; no keyword heuristics.",
    matches: keyMatches,
    currentKeyAbsent: keyMatches.length === 0,
  },
  passed:
    packageTree.unsafePaths.length === 0 &&
    privateConfigurationPaths.length === 0 &&
    keyMatches.length === 0 &&
    installedClientDistribution &&
    Object.values(hashes).every((value) => value.matches),
};
await fs.mkdir(reportDirectory, { recursive: true });
for (const [name, report] of [
  ["final-package-correspondence.json", correspondence],
  ["final-package-boundaries.json", boundaries],
]) {
  const output = path.join(reportDirectory, name);
  await assertOrdinaryAncestors(output, true);
  await fs.writeFile(output, `${safeJson(report)}\n`, "utf8");
}
console.log(
  safeJson({
    packageDirectory,
    desktopSha256: base.desktopSha256,
    cliSha256: base.cliSha256,
    correspondencePassed: correspondence.passed,
    boundariesPassed: boundaries.passed,
    sourceFileCount,
    totalFiles: packageTree.files.size,
    scannedTextFileCount,
  }),
);
process.exitCode = correspondence.passed && boundaries.passed ? 0 : 1;
