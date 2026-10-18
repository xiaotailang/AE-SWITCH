import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';

const root = process.env.AE_WORKSPACE ?? process.cwd();
const executable = path.resolve(process.env.AE_SWITCH_CLI ?? path.join(root, '.cache/cargo-target/debug/ae-switch-cli.exe'));
const portableRoot = path.join(root, '.cache/acceptance/generated-app');
const artifacts = path.join(root, 'artifacts/acceptance/generated-app');
const credentialText = await fs.readFile(path.join(root, '端点测试用.txt'), 'utf8');
const endpoint = credentialText.match(/https?:\/\/[^\s]+/u)?.[0]?.replace(/\/+$/, '');
const key = credentialText.match(/api[-_ ]?key\s*[:：]\s*(.+)/iu)?.[1]?.trim();
const model = process.env.AE_TEST_MODEL ?? 'claude-opus-4-6';
if (!endpoint || !key) throw new Error('The endpoint credentials file is malformed.');
if (!executable.startsWith(root + path.sep)) throw new Error('The Rust CLI must be inside the current workspace.');
await fs.access(executable);
await fs.mkdir(portableRoot, { recursive: true });
await fs.mkdir(artifacts, { recursive: true });

const secrets = new Set([key]);
const sanitize = value => {
  let result = String(value);
  for (const secret of secrets) if (secret) result = result.split(secret).join('<redacted>');
  return result;
};
const recordJson = async (filename, value) => fs.writeFile(path.join(artifacts, filename), sanitize(JSON.stringify(value, null, 2)));
const toolDirectories = [
  'claude/node_modules/.bin', 'codex/node_modules/.bin', 'hermes/.venv/Scripts',
  'oh_my_pi', 'opencode/node_modules/.bin', 'zcode',
].map(relative => path.join(root, '.tools/agents', relative));
const environment = {
  ...process.env,
  AE_SWITCH_PORTABLE_ROOT: portableRoot,
  AE_SWITCH_TOOLS_DIR: path.join(root, '.tools/agents'),
  PATH: [...toolDirectories, path.dirname(process.execPath), process.env.PATH ?? ''].join(path.delimiter),
  NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1',
  NODE_USE_ENV_PROXY: '1', PYTHONUTF8: '1',
  CLAUDE_CODE_MAX_RETRIES: '0', API_TIMEOUT_MS: '20000',
  CLAUDE_CODE_GIT_BASH_PATH: path.join(root, '.tools/git/bin/bash.exe'),
};
const report = {
  recordedAt: new Date().toISOString(), executable, portableRoot, endpoint, model,
  modelSource: process.env.AE_TEST_MODEL ? 'Explicit acceptance model override; successful model discovery has not been established.' : 'Known public fallback model for authentication diagnostics; availability at this endpoint is not established.',
  scope: 'Real Rust save-provider/configure-all/serve and app-generated launch.ps1 with actual official CLI processes. Full E2E requires a real assistant reply and verified tool file creation/readback.',
  setup: {}, agents: [], passed: false,
};

function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const terminator = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { env: environment, windowsHide: true, stdio: 'ignore' });
    terminator.on('error', () => child.kill());
  } else child.kill('SIGTERM');
}

async function execute(command, args, { stdin, timeout = 120000, cwd = portableRoot } = {}) {
  const started = performance.now();
  return await new Promise(resolve => {
    const child = spawn(command, args, { cwd, env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeout);
    child.stdout.on('data', data => { stdout += data.toString(); });
    child.stderr.on('data', data => { stderr += data.toString(); });
    child.once('error', error => { clearTimeout(timer); resolve({ exitCode: null, timedOut, milliseconds: Math.round(performance.now() - started), stdout, stderr, error: sanitize(error.message) }); });
    child.once('close', exitCode => { clearTimeout(timer); resolve({ exitCode, timedOut, milliseconds: Math.round(performance.now() - started), stdout, stderr }); });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin ?? '');
  });
}

function parseJsonOutput(stdout) {
  try { return JSON.parse(stdout); } catch { throw new Error('The Rust CLI did not produce the expected JSON response.'); }
}

function events(stdout) {
  try { return [JSON.parse(stdout)]; } catch {}
  return stdout.split(/\r?\n/u).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}

function assistantText(id, eventList) {
  const texts = [];
  const contentText = content => Array.isArray(content) ? content.filter(part => part?.type === 'text').map(part => part.text ?? '').join('\n') : typeof content === 'string' ? content : '';
  for (const event of eventList) {
    if (id === 'claude_code' && event.type === 'result' && !event.is_error) texts.push(event.result ?? '');
    if (id === 'codex' && event.type === 'item.completed' && event.item?.type === 'agent_message') texts.push(event.item.text ?? '');
    if (id === 'hermes' && event.type === 'result' && !event.error && event.exit_code === 0) texts.push(event.text ?? '');
    if (id === 'oh_my_pi' && event.type === 'message_end' && event.message?.role === 'assistant') texts.push(contentText(event.message.content));
    if (id === 'opencode' && event.type === 'text' && event.part?.type === 'text') texts.push(event.part.text ?? '');
    if (id === 'zcode' && event.type === 'result') texts.push(event.response ?? '');
  }
  return texts.join('\n');
}

function toolEvidence(eventList, filename, marker) {
  const observed = [];
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    const type = String(value.type ?? value.kind ?? '');
    if (/tool|command_execution|file_change/iu.test(type)) observed.push(value);
    if (value.part?.type === 'tool') observed.push(value.part);
    for (const item of Object.values(value)) visit(item);
  }
  for (const event of eventList) visit(event);
  const related = observed.filter(item => JSON.stringify(item).includes(filename));
  const text = related.map(item => JSON.stringify(item)).join('\n');
  return {
    eventCount: observed.length,
    relatedEventCount: related.length,
    writeObserved: /"(?:name|tool|toolName|tool_name)"\s*:\s*"(?:Write|Edit|write|edit|write_file|patch|apply_patch)"|file_change|Set-Content|WriteAllText|Out-File|write_text|writeFile|cat\s+.*>|printf\s+.*>/iu.test(text),
    readObserved: /"(?:name|tool|toolName|tool_name)"\s*:\s*"(?:Read|read|read_file)"|Get-Content|read_text|readFile|cat\s|type\s/iu.test(text),
    readbackMarkerObserved: observed.some(item => {
      const type = String(item.type ?? item.kind ?? '');
      const returned = [item.output, item.result, item.aggregated_output, item.state?.output, /tool.*(?:result|end|completed)/iu.test(type) ? item.content : undefined];
      return returned.some(value => value !== undefined && JSON.stringify(value).includes(marker));
    }),
  };
}

function argumentsFor(id, prompt, phase) {
  const tooling = phase === 'tools';
  switch (id) {
    case 'claude_code': return ['--bare', '-p', prompt, '--output-format', 'stream-json', '--verbose', '--max-turns', tooling ? '8' : '1', '--tools', tooling ? 'Read,Write,Edit' : 'Read', '--allowedTools', 'Read,Write,Edit', '--permission-mode', 'acceptEdits'];
    case 'codex': return ['exec', '--skip-git-repo-check', '--ephemeral', '--json', '--sandbox', tooling ? 'workspace-write' : 'read-only', prompt];
    case 'hermes': return ['chat', '--query', prompt, '--oneshot', '-Q', '--ignore-rules', '--max-turns', tooling ? '8' : '1', '--run-budget', '90', '--format', 'stream-json'];
    case 'oh_my_pi': return ['-p', prompt, '--mode', 'json', '--no-lsp', '--no-title', '--no-session', '--thinking', 'off', '--max-time', '90', ...(tooling ? ['--tools', 'read,write,edit', '--auto-approve'] : ['--no-tools'])];
    case 'opencode': return ['run', prompt, '--format', 'json', '--pure', ...(tooling ? ['--auto'] : [])];
    case 'zcode': return ['-p', prompt, '--output-format', 'stream-json', '--mode', tooling ? 'yolo' : 'plan'];
    default: throw new Error(`Unknown configured agent: ${id}`);
  }
}

let server;
try {
  const saved = await execute(executable, ['save-provider'], { stdin: JSON.stringify({
    id: null, family: 'codex', name: 'Generated app real-endpoint acceptance',
    baseUrl: endpoint, apiKey: key, model, authMode: 'bearer', reasoningEffort: null,
    codexOptions: { upstreamProtocol: 'openai', protocol: 'openai', models: [{ id: model, enabled: true, contextWindow: 128000, reasoningEfforts: [] }] },
  }), timeout: 30000 });
  if (saved.exitCode !== 0) throw new Error(`Rust save-provider failed: ${sanitize(saved.stderr)}`);
  const provider = parseJsonOutput(saved.stdout);
  report.setup.provider = { id: provider.id, hasKey: provider.hasKey, source: 'Rust save-provider JSON on stdin; no key in process arguments.' };
  const configured = await execute(executable, ['configure-all', provider.id, model], { timeout: 30000 });
  if (configured.exitCode !== 0) throw new Error(`Rust configure-all failed: ${sanitize(configured.stderr)}`);
  const agents = parseJsonOutput(configured.stdout).agents;
  if (!Array.isArray(agents) || agents.length !== 6) throw new Error('Rust configure-all must return six generated agent configurations.');
  report.setup.configuredAgentCount = agents.length;
  const generatedEnvironments = new Map();
  for (const agent of agents) {
    if (!agent.directory.startsWith(portableRoot + path.sep)) throw new Error('Generated runtime escaped the acceptance portable root.');
    const environmentPath = path.join(agent.directory, 'configuration/environment.json');
    const raw = await fs.readFile(environmentPath, 'utf8');
    const config = JSON.parse(raw);
    if (config.AE_GATEWAY_TOKEN) secrets.add(config.AE_GATEWAY_TOKEN);
    if (config.AE_SWITCH_API_KEY) secrets.add(config.AE_SWITCH_API_KEY);
    generatedEnvironments.set(agent.id, { config, environmentHash: createHash('sha256').update(raw).digest('hex') });
  }
  const claudeEnvironment = generatedEnvironments.get('claude_code').config;
  const gatewayOrigin = new URL(claudeEnvironment.ANTHROPIC_BASE_URL).origin;
  if (!gatewayOrigin.startsWith('http://127.0.0.1:')) throw new Error('The app-generated endpoint must use the Rust localhost gateway.');
  report.setup.gatewayOrigin = gatewayOrigin;
  let serverStdout = '', serverStderr = '';
  server = spawn(executable, ['serve'], { cwd: portableRoot, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', data => { serverStdout += data.toString(); });
  server.stderr.on('data', data => { serverStderr += data.toString(); });
  server.on('error', error => { serverStderr += error.message; });
  const readinessStarted = performance.now();
  let healthy = false;
  while (performance.now() - readinessStarted < 15000) {
    if (server.exitCode !== null) throw new Error(`Rust serve exited before health verification: ${sanitize(serverStderr)}`);
    try {
      const response = await fetch(`${gatewayOrigin}/health`, { headers: { Authorization: `Bearer ${claudeEnvironment.AE_GATEWAY_TOKEN}` }, signal: AbortSignal.timeout(1000) });
      if (response.ok) { healthy = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!healthy) throw new Error(`Rust localhost gateway did not pass authenticated /health: ${sanitize(serverStderr)}`);
  report.setup.gatewayHealthy = true;
  await recordJson('setup.json', report.setup);

  for (const agent of agents) {
    const marker = `AE_GENERATED_CONNECTION_${agent.id}_${randomUUID().replaceAll('-', '')}`;
    const launcher = path.join(agent.directory, 'launch.ps1');
    await fs.access(launcher);
    const prompt = `Do not call tools. Reply exactly with ${marker}.`;
    const result = await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher, ...argumentsFor(agent.id, prompt, 'connection')]);
    const parsed = events(result.stdout);
    const text = assistantText(agent.id, parsed);
    const passed = result.exitCode === 0 && !result.timedOut && text.includes(marker);
    const record = { id: agent.id, launcher, appGeneratedConfiguration: true, environmentHash: generatedEnvironments.get(agent.id).environmentHash, gatewayOrigin,
      connection: { ...result, stdout: sanitize(result.stdout), stderr: sanitize(result.stderr), marker, assistantText: sanitize(text), passed },
      tools: { status: 'not_run', passed: false, reason: passed ? 'Pending controlled tool-round execution.' : 'Connection inference failed; running file tools cannot establish upstream success.' }, passed: false,
    };
    if (passed) {
      const toolMarker = `AE_GENERATED_FILE_${agent.id}_${randomUUID().replaceAll('-', '')}`;
      const filename = `acceptance-${agent.id}-${randomUUID()}.txt`;
      const artifact = path.join(agent.directory, 'workspace', filename);
      try { await fs.access(artifact); throw new Error('The generated acceptance file unexpectedly already exists.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const toolPrompt = `Only operate in your current workspace. Use your file write/edit tool to create the file ${filename} with the exact UTF-8 contents ${toolMarker} and no other text. Then use your file read tool to read that file back. Your final answer must be the exact content returned by the read tool. Do not use network tools or delegate work.`;
      const toolResult = await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher, ...argumentsFor(agent.id, toolPrompt, 'tools')], { timeout: 180000 });
      const toolEvents = events(toolResult.stdout);
      let content, exists = false;
      try { content = await fs.readFile(artifact, 'utf8'); exists = true; } catch {}
      const actualText = assistantText(agent.id, toolEvents);
      const observations = toolEvidence(toolEvents, filename, toolMarker);
      const toolPassed = toolResult.exitCode === 0 && !toolResult.timedOut && exists && content === toolMarker && actualText.includes(toolMarker) && observations.writeObserved && observations.readObserved && observations.readbackMarkerObserved;
      record.tools = { ...toolResult, stdout: sanitize(toolResult.stdout), stderr: sanitize(toolResult.stderr), status: 'executed', artifact, marker: toolMarker, fileExists: exists, fileMatchesMarker: content === toolMarker, assistantText: sanitize(actualText), observations, passed: toolPassed };
      record.passed = toolPassed;
    }
    report.agents.push(record);
    await recordJson(`${agent.id}.json`, record);
    await recordJson('results.json', report);
    console.log(JSON.stringify({ id: agent.id, connectionPassed: passed, connectionExitCode: result.exitCode, upstream401: /401/u.test(result.stdout + result.stderr), toolStage: record.tools.status, endToEndPassed: record.passed, milliseconds: result.milliseconds }));
  }
  report.passed = report.agents.length === 6 && report.agents.every(agent => agent.passed);
  report.summary = { configured: report.agents.length, connectionPassed: report.agents.filter(agent => agent.connection.passed).length, controlledToolRoundsPassed: report.agents.filter(agent => agent.tools.passed).length, endToEndPassed: report.agents.filter(agent => agent.passed).length };
  await recordJson('results.json', report);
  await recordJson('gateway.json', { stdout: serverStdout, stderr: serverStderr, authenticatedHealthPassed: healthy, stoppedByAcceptanceRunner: true });
  console.log(JSON.stringify(report.summary));
  process.exitCode = report.passed ? 0 : 1;
} catch (error) {
  report.error = sanitize(error.message);
  await recordJson('results.json', report);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  if (server && server.exitCode === null) {
    killTree(server);
    await Promise.race([once(server, 'close'), new Promise(resolve => setTimeout(resolve, 5000))]);
  }
}
