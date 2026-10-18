import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packageDirectory = path.resolve(process.argv[2] || path.join(workspace, 'artifacts/AE Switch Portable Move QA'));
const expectedCliSha256 = process.argv[3];
if (!/^[a-f\d]{64}$/i.test(expectedCliSha256 || '')) {
  throw new Error('Pass the final built CLI SHA256 as the third command argument; an old development CLI must not be tested.');
}
const executable = path.join(packageDirectory, 'AE-Switch-core.exe');
const dataDirectory = path.join(packageDirectory, 'data');
const evidenceDirectory = path.join(workspace, 'artifacts/acceptance');
const qaDirectory = path.resolve(process.env.AE_LAUNCHER_SMOKE_RUNTIME || path.join(workspace, '.cache/packaging-launcher-smoke', randomUUID()));
const expectedAgents = ['claude_code', 'codex', 'hermes', 'oh_my_pi', 'opencode', 'zcode', 'workbuddy', 'deepseek_harness'];
const markerName = `.ae-synthetic-launcher-qa-${randomUUID()}.json`;
const markerPath = path.join(dataDirectory, markerName);
const windowsDirectory = process.env.SystemRoot || 'C:\\Windows';
const powershell = path.join(windowsDirectory, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const systemPath = [path.join(windowsDirectory, 'System32'), windowsDirectory, path.dirname(powershell)].join(path.delimiter);
const fakeKey = 'AE_SWITCH_SYNTHETIC_INVALID_KEY_FOR_LOCAL_VERSION_SMOKE';
const secrets = new Set([fakeKey]);

function requireChild(parent, child) {
  const relative = path.relative(parent, child);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Path is outside its expected parent: ${child}`);
}
requireChild(workspace, packageDirectory);
requireChild(packageDirectory, dataDirectory);
requireChild(workspace, qaDirectory);
requireChild(await realpath(workspace), await realpath(packageDirectory));
const cliSha256 = createHash('sha256').update(await readFile(executable)).digest('hex');
if (cliSha256 !== expectedCliSha256.toLowerCase()) throw new Error('The bundled CLI does not match the specified final-build SHA256.');
try {
  await access(dataDirectory);
  throw new Error('The package already contains data. Refusing to change or remove existing data.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await mkdir(evidenceDirectory, { recursive: true });
await mkdir(qaDirectory, { recursive: true });
for (const directory of ['home', 'appdata', 'localappdata', 'tmp', 'config', 'cache', 'state']) {
  await mkdir(path.join(qaDirectory, directory), { recursive: true });
}
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION|^PATH$|PYTHONPATH|PYTHONHOME|VIRTUAL_ENV|NODE_PATH|NODE_OPTIONS|^AE_SWITCH_|^AE_AGENT_|^UNI_SWITCH_DATA_DIR$|^CLAUDE_CODE_GIT_BASH_PATH$/i.test(name)));
Object.assign(environment, {
  PATH: systemPath,
  HOME: path.join(qaDirectory, 'home'), USERPROFILE: path.join(qaDirectory, 'home'),
  APPDATA: path.join(qaDirectory, 'appdata'), LOCALAPPDATA: path.join(qaDirectory, 'localappdata'),
  TEMP: path.join(qaDirectory, 'tmp'), TMP: path.join(qaDirectory, 'tmp'),
  XDG_CONFIG_HOME: path.join(qaDirectory, 'config'), XDG_DATA_HOME: path.join(qaDirectory, 'home'),
  XDG_CACHE_HOME: path.join(qaDirectory, 'cache'), XDG_STATE_HOME: path.join(qaDirectory, 'state'),
  PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1',
});

function sanitize(value) {
  let sanitized = String(value);
  for (const secret of secrets) if (secret) sanitized = sanitized.split(secret).join('<redacted>');
  return sanitized;
}

async function execute(command, args, { stdin = '', timeout = 120_000, env = environment } = {}) {
  const startedAt = Date.now();
  return await new Promise((resolve) => {
    const child = spawn(command, args, { cwd: qaDirectory, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError = null;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        const terminator = spawn(path.join(windowsDirectory, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { env, windowsHide: true, stdio: 'ignore' });
        terminator.on('error', () => child.kill());
      } else child.kill();
    }, timeout);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { spawnError = sanitize(error.message); });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, timedOut, durationMs: Date.now() - startedAt, stdout: sanitize(stdout.trim()), stderr: sanitize(stderr.trim()), spawnError });
    });
  });
}

const report = {
  createdAt: new Date().toISOString(), packageDirectory, executable, cliSha256, qaDirectory, expectedAgents,
  inheritedPath: systemPath,
  manuallyInjectedBundledToolPaths: false,
  scope: 'Final bundled Rust CLI save-provider/configure-all with synthetic invalid credentials, followed by eight actual generated launch.ps1 --version entries using Windows system PATH only.',
  realInferenceVerified: false, realInferencePassedAgents: 0, realInferenceAgentCount: expectedAgents.length,
  realInferenceNote: 'No inference was attempted in this version smoke. See the independent portable-e2e.json report for real endpoint acceptance.',
  setup: {}, results: [], cleanup: { ownedFreshData: false, removed: false },
};

try {
  await mkdir(dataDirectory);
  report.cleanup.ownedFreshData = true;
  await writeFile(markerPath, JSON.stringify({ purpose: 'synthetic launcher QA', packageDirectory, cliSha256 }), { flag: 'wx' });
  const saved = await execute(executable, ['save-provider'], {
    stdin: JSON.stringify({
      id: null, family: 'codex', name: 'Synthetic portable launcher version smoke',
      baseUrl: 'https://invalid.example/api', apiKey: fakeKey, model: 'synthetic-model',
      authMode: 'bearer', reasoningEffort: null,
      codexOptions: { upstreamProtocol: 'openai', protocol: 'openai', models: [{ id: 'synthetic-model', enabled: true, contextWindow: 128000, reasoningEfforts: [] }] },
    }), timeout: 30_000,
  });
  if (saved.exitCode !== 0 || saved.timedOut) throw new Error(`save-provider failed: ${saved.stderr || saved.spawnError}`);
  const provider = JSON.parse(saved.stdout);
  report.setup.provider = { id: provider.id, hasKey: provider.hasKey, syntheticCredentials: true };
  const configured = await execute(executable, ['configure-all', provider.id, 'synthetic-model'], { timeout: 30_000 });
  if (configured.exitCode !== 0 || configured.timedOut) throw new Error(`configure-all failed: ${configured.stderr || configured.spawnError}`);
  const agents = JSON.parse(configured.stdout).agents;
  if (!Array.isArray(agents) || JSON.stringify(agents.map((agent) => agent.id).sort()) !== JSON.stringify([...expectedAgents].sort())) throw new Error('configure-all did not return exactly the eight supported agents.');
  report.setup.configuredAgentCount = agents.length;
  for (const agent of agents) {
    requireChild(dataDirectory, agent.directory);
    requireChild(await realpath(dataDirectory), await realpath(agent.directory));
    const generatedEnvironment = JSON.parse(await readFile(path.join(agent.directory, 'configuration/environment.json'), 'utf8'));
    const generatedBinDirectories = String(generatedEnvironment.AE_AGENT_BIN_PATH || '').split(path.delimiter).filter(Boolean);
    if (!generatedBinDirectories.length) throw new Error(`No bundled dependency PATH was generated for ${agent.id}.`);
    for (const directory of generatedBinDirectories) requireChild(packageDirectory, directory);
    for (const name of ['AE_GATEWAY_TOKEN', 'AE_SWITCH_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
      if (generatedEnvironment[name]) secrets.add(generatedEnvironment[name]);
    }
    const launcher = path.join(agent.directory, 'launch.ps1');
    const result = await execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcher, '--version']);
    const passed = result.exitCode === 0 && !result.timedOut && Boolean(result.stdout.trim());
    report.results.push({ id: agent.id, launcher, arguments: ['--version'], appGeneratedConfiguration: true, generatedBinPath: generatedEnvironment.AE_AGENT_BIN_PATH, generatedBinDirectoriesAllInsidePackage: true, passed, ...result });
    console.log(`${agent.id}: ${passed ? 'PASS' : 'FAIL'} ${result.stdout.split(/\r?\n/)[0] || result.stderr.split(/\r?\n/)[0] || ''}`);
  }
} catch (error) {
  report.error = sanitize(error.message);
  console.error(report.error);
} finally {
  if (report.cleanup.ownedFreshData) {
    const cleanupEnvironment = { ...environment, AE_QA_WORKSPACE: workspace, AE_QA_PACKAGE: packageDirectory, AE_QA_DATA: dataDirectory, AE_QA_MARKER: markerPath };
    const cleanupCommand = [
      "$ErrorActionPreference = 'Stop'",
      "$qaWorkspace = [IO.Path]::GetFullPath($env:AE_QA_WORKSPACE).TrimEnd('\\')",
      "$qaPackage = [IO.Path]::GetFullPath($env:AE_QA_PACKAGE).TrimEnd('\\')",
      "$qaData = [IO.Path]::GetFullPath($env:AE_QA_DATA)",
      "$qaMarker = [IO.Path]::GetFullPath($env:AE_QA_MARKER)",
      "if (-not $qaPackage.StartsWith($qaWorkspace + '\\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Package cleanup escaped workspace.' }",
      "if ($qaData -ne (Join-Path $qaPackage 'data')) { throw 'Unexpected data cleanup path.' }",
      "if (-not $qaMarker.StartsWith($qaData + '\\', [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $qaMarker -PathType Leaf)) { throw 'Synthetic QA ownership marker missing.' }",
      "if ((Get-Item -LiteralPath $qaData -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing to delete a reparse data directory.' }",
      "Remove-Item -LiteralPath $qaData -Recurse -Force",
      "if (Test-Path -LiteralPath $qaData) { throw 'Synthetic QA data remains.' }",
      "Write-Output 'Removed only newly owned synthetic QA data.'",
    ].join('\n');
    const cleanup = await execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cleanupCommand], { env: cleanupEnvironment, timeout: 30_000 });
    report.cleanup = { ...report.cleanup, removed: cleanup.exitCode === 0 && !cleanup.timedOut, ...cleanup };
  }
  report.localLauncherPassedCount = report.results.filter((result) => result.passed).length;
  report.localLauncherCount = expectedAgents.length;
  report.passed = !report.error && report.results.length === expectedAgents.length && report.results.every((result) => result.passed) && report.cleanup.removed;
  await writeFile(path.join(evidenceDirectory, 'portable-launcher-smoke.json'), `${sanitize(JSON.stringify(report, null, 2))}\n`, 'utf8');
  process.exitCode = report.passed ? 0 : 1;
}
