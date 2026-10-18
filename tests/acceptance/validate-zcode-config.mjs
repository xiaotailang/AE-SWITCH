import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.AE_WORKSPACE ?? process.cwd();
const sourceRoot = path.join(root, '.tools/agents/zcode/source');
const { decodeZCodeBuiltinRelease } = await import(pathToFileURL(path.join(sourceRoot, 'packages/provider-node/dist/zcode-builtin-release.js')));
const { decodeProviderConfigFile } = await import(pathToFileURL(path.join(sourceRoot, 'packages/provider-node/dist/provider-config-file-codec.js')));
let builtin, origin;
if (process.argv[2]) {
  origin = path.resolve(process.argv[2]);
  builtin = JSON.parse(await fs.readFile(origin, 'utf8'));
} else {
  origin = path.join(root, 'app/src-tauri/src/agent_configs.rs');
  const rust = await fs.readFile(origin, 'utf8');
  const declaration = rust.match(/let builtin = serde_json::json!\(([\s\S]*?)\);\s*write_json/u)?.[1];
  if (!declaration) throw new Error('The Rust ZCode builtin declaration is missing.');
  builtin = JSON.parse(declaration);
}
const decoded = decodeZCodeBuiltinRelease(builtin);
const generated = path.join(root, '.cache/acceptance/rust-zcode-builtin.json');
await fs.mkdir(path.dirname(generated), { recursive: true });
await fs.writeFile(generated, JSON.stringify(builtin, null, 2));
const personalPath = process.argv[3] ?? path.join(root, '.cache/acceptance/real-agents/zcode/config/provider_config.json');
const personal = decodeProviderConfigFile(JSON.parse(await fs.readFile(personalPath, 'utf8')));
const result = { recordedAt: new Date().toISOString(), officialCliVersion: '0.16.9', origin, builtinSchemaValid: true, personalSchemaValid: true, revision: decoded.revision, selectedProvider: personal.defaultModelSelection?.providerId, generatedBuiltin: generated, scope: 'Official ZCode codecs parse the actual Rust builtin declaration or supplied generated config. This does not prove model inference succeeds.' };
await fs.writeFile(path.join(root, 'artifacts/acceptance/zcode-config-validation.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
