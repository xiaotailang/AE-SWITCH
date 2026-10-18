import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.env.AE_WORKSPACE ?? process.cwd();
const credentialText = await fs.readFile(path.join(root, '端点测试用.txt'), 'utf8');
const endpoint = (process.env.AE_TEST_ENDPOINT ?? credentialText.match(/https?:\/\/[^\s]+/u)?.[0])?.replace(/\/+$/, '');
const key = process.env.AE_TEST_API_KEY ?? credentialText.match(/api[-_ ]?key\s*[:：]\s*(.+)/iu)?.[1]?.trim();
const model = process.env.AE_TEST_MODEL ?? 'claude-opus-4-6';
if (!endpoint || !key) throw new Error('Missing endpoint or key.');
const output = path.join(root, 'artifacts', 'acceptance');
const state = path.join(root, '.cache', 'acceptance', 'real-agents');
const tools = path.join(root, '.tools', 'agents');
await fs.mkdir(output, { recursive: true });
await fs.mkdir(state, { recursive: true });
const chosen = new Set((process.env.AE_TEST_AGENTS ?? 'claude,codex,hermes,oh_my_pi,opencode,zcode').split(','));
const marker = 'AE_SWITCH_AGENT_OK';
const prompt = `Do not run tools or access files. Reply exactly with ${marker}.`;
const sanitize = value => String(value).split(key).join('<redacted>');
const common = { ...process.env, AE_TEST_API_KEY: key, AE_SWITCH_API_KEY: key, OPENAI_API_KEY: key, PYTHONUTF8: '1', NODE_USE_ENV_PROXY: '1', NO_PROXY: 'localhost,127.0.0.1', HTTPS_PROXY: process.env.HTTPS_PROXY ?? 'http://127.0.0.1:7897', HTTP_PROXY: process.env.HTTP_PROXY ?? 'http://127.0.0.1:7897' };
const evidence = { recordedAt: new Date().toISOString(), endpoint, model, marker, scope: 'Actual official CLI processes against the supplied endpoint; success requires the reply marker and exit code 0.', tools: [] };
const write = async (location, value) => { await fs.mkdir(path.dirname(location), { recursive: true }); await fs.writeFile(location, value); };
const json = async (location, value) => write(location, JSON.stringify(value, null, 2));
const jsonEvidence = async (location, value) => write(location, sanitize(JSON.stringify(value, null, 2)));
const yamlString = JSON.stringify;

async function run(id, command, args, environment) {
  if (!chosen.has(id)) return;
  const started = performance.now();
  const working = path.join(state, id, 'workspace');
  await fs.mkdir(working, { recursive: true });
  const record = await new Promise(resolve => {
    const child = spawn(command, args, { cwd: working, env: { ...common, ...environment }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 90000);
    child.stdout.on('data', data => { stdout += data.toString(); });
    child.stderr.on('data', data => { stderr += data.toString(); });
    child.once('error', error => { clearTimeout(timer); resolve({ id, error: sanitize(error.message), milliseconds: Math.round(performance.now() - started), passed: false }); });
    child.once('close', code => { clearTimeout(timer); resolve({ id, exitCode: code, timedOut, milliseconds: Math.round(performance.now() - started), passed: code === 0 && stdout.includes(marker), stdout: sanitize(stdout), stderr: sanitize(stderr) }); });
  });
  evidence.tools.push(record);
  await jsonEvidence(path.join(output, `real-agent-${id}.json`), record);
  await jsonEvidence(path.join(output, 'real-agent-results.json'), evidence);
  console.log(JSON.stringify({ id, exitCode: record.exitCode, timedOut: record.timedOut, passed: record.passed, milliseconds: record.milliseconds, error: record.error, stdoutPreview: record.stdout?.slice(-1200), stderrPreview: record.stderr?.slice(-1200) }));
}

const claudeHome = path.join(state, 'claude', 'config');
await fs.mkdir(claudeHome, { recursive: true });
const codexHome = path.join(state, 'codex', 'config');
await write(path.join(codexHome, 'config.toml'), `model = ${JSON.stringify(model)}\nmodel_provider = "ae_switch"\napproval_policy = "never"\nsandbox_mode = "read-only"\ncheck_for_update_on_startup = false\n[history]\npersistence = "none"\n[analytics]\nenabled = false\n[model_providers.ae_switch]\nname = "AE Switch acceptance"\nbase_url = ${JSON.stringify(`${endpoint}/v1`)}\nenv_key = "AE_TEST_API_KEY"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`);
const hermesHome = path.join(state, 'hermes', 'config');
await write(path.join(hermesHome, 'config.yaml'), `model:\n  default: ${yamlString(model)}\n  provider: custom\n  base_url: ${yamlString(`${endpoint}/v1`)}\n  key_env: AE_TEST_API_KEY\n  api_mode: chat_completions\n  context_length: 128000\nagent:\n  max_turns: 1\n  reasoning_effort: none\ndisplay:\n  interface: cli\n`);
const ompHome = path.join(state, 'oh_my_pi', 'config');
await write(path.join(ompHome, 'models.yml'), `providers:\n  ae_switch:\n    baseUrl: ${yamlString(`${endpoint}/v1`)}\n    api: openai-completions\n    apiKey: AE_TEST_API_KEY\n    models:\n      - id: ${yamlString(model)}\n        name: ${yamlString(model)}\n        contextWindow: 128000\n        maxTokens: 4096\n`);
await write(path.join(ompHome, 'config.yml'), `modelRoles:\n  default: ${yamlString(`ae_switch/${model}`)}\nstartup:\n  quiet: true\n`);
const opencodeFile = path.join(state, 'opencode', 'opencode.json');
await json(opencodeFile, { $schema: 'https://opencode.ai/config.json', model: `ae_switch/${model}`, small_model: `ae_switch/${model}`, share: 'disabled', autoupdate: false, permission: { '*': 'deny' }, provider: { ae_switch: { npm: '@ai-sdk/openai-compatible', name: 'AE Switch acceptance', options: { baseURL: `${endpoint}/v1`, apiKey: '{env:AE_TEST_API_KEY}' }, models: { [model]: { name: model, limit: { context: 128000, output: 4096 } } } } } });
const zcodeHome = path.join(state, 'zcode', 'config');
const zcodePersonal = path.join(zcodeHome, 'provider_config.json');
await json(zcodePersonal, { schemaVersion: 1, config: { providerConfigRules: { providerRules: [{ providerId: 'ae_switch', providerName: 'AE Switch acceptance', enabled: true, config: { group: 'standard-personal', access: { type: 'api-key', apiKey: key }, api: { type: 'openai-chat-completions', baseUrl: `${endpoint}/v1` }, personalModelIds: [model] } }] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] }, defaultModelSelection: { providerId: 'ae_switch', modelId: model, ...(process.env.AE_ZCODE_BUILTIN_FILE ? { options: { reasoningLevel: 'disabled' } } : {}) } } });
const zcodeBuiltin = process.env.AE_ZCODE_BUILTIN_FILE ? path.resolve(process.env.AE_ZCODE_BUILTIN_FILE) : path.join(tools, 'zcode', 'source', 'config', 'provider', 'zcode-builtin.json');
const tasks = [
  run('claude', path.join(tools, 'claude/node_modules/@anthropic-ai/claude-code/bin/claude.exe'), ['--bare', '-p', prompt, '--model', model, '--output-format', 'json', '--max-turns', '1', '--tools', ''], { CLAUDE_CONFIG_DIR: claudeHome, ANTHROPIC_BASE_URL: endpoint, ANTHROPIC_API_KEY: key, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1', CLAUDE_CODE_GIT_BASH_PATH: path.join(root, '.tools/git/bin/bash.exe'), API_TIMEOUT_MS: '15000', CLAUDE_CODE_MAX_RETRIES: '0', CLAUDE_CODE_CONNECT_TIMEOUT_MS: '10000' }),
  run('codex', process.execPath, [path.join(tools, 'codex/node_modules/@openai/codex/bin/codex.js'), 'exec', '--skip-git-repo-check', '--ephemeral', '--json', prompt], { CODEX_HOME: codexHome }),
  run('hermes', path.join(tools, 'hermes/.venv/Scripts/hermes.exe'), ['chat', '--query', prompt, '--oneshot', '-Q', '--ignore-rules', '--max-turns', '1', '--run-budget', '45', '--format', 'stream-json'], { HERMES_HOME: hermesHome, HERMES_SKIP_VENV: '1' }),
  run('oh_my_pi', path.join(tools, 'oh_my_pi/omp.exe'), ['-p', prompt, '--model', `ae_switch/${model}`, '--no-tools', '--no-lsp', '--no-title', '--no-session', '--thinking', 'off', '--max-time', '45'], { PI_CODING_AGENT_DIR: ompHome }),
  run('opencode', path.join(tools, 'opencode/node_modules/opencode-windows-x64/bin/opencode.exe'), ['run', prompt, '--model', `ae_switch/${model}`, '--format', 'json', '--pure'], { OPENCODE_CONFIG: opencodeFile, OPENCODE_DISABLE_PROJECT_CONFIG: 'true' }),
  run('zcode', process.execPath, [path.join(tools, 'zcode/source/apps/zcode-cli/packages/cli/dist/zcode.cjs'), '-p', prompt, '--output-format', 'json'], { ZCODE_DATA_BASE_DIR: zcodeHome, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: zcodeBuiltin, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: zcodePersonal }),
];
await Promise.all(tasks);
const priorRecords = await Promise.all(['claude', 'codex', 'hermes', 'oh_my_pi', 'opencode', 'zcode'].map(async id => {
  try { return JSON.parse(await fs.readFile(path.join(output, `real-agent-${id}.json`), 'utf8')); } catch { return undefined; }
}));
evidence.tools = priorRecords.filter(Boolean);
await jsonEvidence(path.join(output, 'real-agent-results.json'), evidence);
console.log(JSON.stringify({ total: evidence.tools.length, passed: evidence.tools.filter(tool => tool.passed).length, failed: evidence.tools.filter(tool => !tool.passed).map(tool => tool.id) }));
process.exitCode = evidence.tools.some(tool => !tool.passed) ? 1 : 0;
