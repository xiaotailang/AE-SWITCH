import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packageDirectory = path.resolve(process.argv[2] || path.join(workspace, 'artifacts/AE Switch Portable Move QA'));
const evidenceDirectory = path.join(workspace, 'artifacts/acceptance');
const smokeDirectory = path.join(workspace, '.cache/packaging-move-smoke');
const windowsDirectory = process.env.SystemRoot || 'C:\\Windows';
const powershell = path.join(windowsDirectory, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const restrictedPath = [
  path.join(packageDirectory, 'tools/node'),
  path.join(packageDirectory, 'tools/pwsh'),
  path.join(packageDirectory, 'tools/python'),
  path.join(packageDirectory, 'tools/git/cmd'),
  path.join(packageDirectory, 'tools/git/bin'),
  path.join(windowsDirectory, 'System32'),
  windowsDirectory,
  path.dirname(powershell),
].join(path.delimiter);

function requireWorkspacePath(target) {
  const relative = path.relative(workspace, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Expected a child directory inside the current workspace: ${target}`);
  }
}

requireWorkspacePath(packageDirectory);
requireWorkspacePath(smokeDirectory);
await mkdir(evidenceDirectory, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(packageDirectory, 'package-manifest.json'), 'utf8'));
if (manifest.product !== 'AE Switch' || manifest.platform !== 'windows-x64') {
  throw new Error('The target directory is not the generated Windows AE Switch package.');
}

const definitions = [
  ['claude_code', 'tools/agents/claude/node_modules/.bin/claude.cmd'],
  ['codex', 'tools/agents/codex/node_modules/.bin/codex.cmd'],
  ['hermes', 'tools/agents/hermes/hermes.ps1'],
  ['oh_my_pi', 'tools/agents/oh_my_pi/omp.exe'],
  ['opencode', 'tools/agents/opencode/node_modules/.bin/opencode.cmd'],
  ['zcode', 'tools/agents/zcode/zcode.cmd'],
  ['workbuddy', 'tools/agents/workbuddy/WorkBuddy.exe'],
  ['deepseek_harness', 'tools/agents/deepseek_harness/node_modules/@deepseek-ai/dsh/lib/bin.js'],
];

async function runVersion([id, relativeEntry]) {
  const entry = path.join(packageDirectory, relativeEntry);
  const home = path.join(smokeDirectory, id);
  const directories = ['home', 'appdata', 'localappdata', 'tmp', 'config', 'data', 'cache', 'state'];
  await Promise.all(directories.map((directory) => mkdir(path.join(home, directory), { recursive: true })));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION|^PATH$|PYTHONPATH|PYTHONHOME|VIRTUAL_ENV|NODE_PATH|NODE_OPTIONS/i.test(key)));
  Object.assign(env, {
    PATH: restrictedPath,
    HOME: path.join(home, 'home'),
    USERPROFILE: path.join(home, 'home'),
    APPDATA: path.join(home, 'appdata'),
    LOCALAPPDATA: path.join(home, 'localappdata'),
    TEMP: path.join(home, 'tmp'),
    TMP: path.join(home, 'tmp'),
    XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_DATA_HOME: path.join(home, 'data'),
    XDG_CACHE_HOME: path.join(home, 'cache'),
    XDG_STATE_HOME: path.join(home, 'state'),
    CODEX_HOME: path.join(home, 'data/codex'),
    CLAUDE_CONFIG_DIR: path.join(home, 'data/claude'),
    CLAUDE_CODE_GIT_BASH_PATH: path.join(packageDirectory, 'tools/git/bin/bash.exe'),
    HERMES_HOME: path.join(home, 'data/hermes'),
    PI_CODING_AGENT_DIR: path.join(home, 'data/pi'),
    ZCODE_DATA_BASE_DIR: path.join(home, 'data/zcode'),
    npm_config_cache: path.join(home, 'cache/npm'),
    npm_config_prefix: path.join(home, 'data/npm'),
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONPYCACHEPREFIX: path.join(home, 'cache/pycache'),
    GIT_CONFIG_GLOBAL: path.join(home, 'config/gitconfig'),
    AE_SMOKE_ENTRY: entry,
    WORKBUDDY_CONFIG_DIR: path.join(home, 'data/workbuddy'),
    CODEBUDDY_CONFIG_DIR: path.join(home, 'data/workbuddy'),
    DSH_HOME: path.join(home, 'home/.dsh'),
    DSH_TELEMETRY_MODE: 'DISABLED',
    AE_SMOKE_NODE: path.join(packageDirectory, 'tools/node/node.exe'),
  });
  for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'HERMES_HOME', 'PI_CODING_AGENT_DIR', 'ZCODE_DATA_BASE_DIR', 'DSH_HOME']) {
    await mkdir(env[key], { recursive: true });
  }
  if (id === 'workbuddy') {
    Object.assign(env, {
      ELECTRON_RUN_AS_NODE: '1',
      CODEBUDDY_HOST: 'workbuddy-desktop',
      CODEBUDDY_FORCE_LITE_WB_BUNDLE: '1',
      DISABLE_AUTOUPDATER: '1',
      AE_SMOKE_HOST: path.join(packageDirectory, 'tools/agents/workbuddy/resources/app.asar.unpacked/cli/bin/codebuddy'),
    });
    await mkdir(env.WORKBUDDY_CONFIG_DIR, { recursive: true });
  }
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
  if (id === 'hermes') {
    args.push('-File', entry, '--version');
  } else if (id === 'workbuddy') {
    args.push('-Command', '& $env:AE_SMOKE_ENTRY $env:AE_SMOKE_HOST --version; exit $LASTEXITCODE');
  } else if (id === 'deepseek_harness') {
    args.push('-Command', '& $env:AE_SMOKE_NODE $env:AE_SMOKE_ENTRY --version; exit $LASTEXITCODE');
  } else {
    args.push('-Command', '& $env:AE_SMOKE_ENTRY --version; exit $LASTEXITCODE');
  }
  const startedAt = Date.now();
  return await new Promise((resolve) => {
    const child = spawn(powershell, args, { cwd: env.HOME, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 120_000);
    child.stdout?.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr?.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { stderr += `${error}\n`; });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      const passed = exitCode === 0 && !timedOut && stdout.trim().length > 0;
      const result = { id, entry, arguments: ['--version'], passed, exitCode, signal, timedOut, durationMs: Date.now() - startedAt, stdout: stdout.trim(), stderr: stderr.trim() };
      console.log(`${id}: ${passed ? 'PASS' : 'FAIL'} (${result.durationMs} ms) ${result.stdout.split(/\r?\n/)[0] || result.stderr.split(/\r?\n/)[0] || ''}`);
      resolve(result);
    });
  });
}

const results = await Promise.all(definitions.map(runVersion));
const report = {
  createdAt: new Date().toISOString(),
  packageDirectory,
  movedDirectoryContainsSpaces: packageDirectory.includes(' '),
  restrictedPath,
  isolatedDataDirectory: smokeDirectory,
  passCriteria: 'The actual bundled entry returns exit code 0 and nonempty version output within 120 seconds using only bundled tools and Windows system PATH directories.',
  localToolPassedCount: results.filter((result) => result.passed).length,
  localToolCount: results.length,
  realInferenceVerified: false,
  realInferencePassedAgents: 0,
  realInferenceAgentCount: definitions.length,
  realInferenceNote: 'Version smoke checks do not establish actual inference. See the independent portable-e2e.json report for real endpoint acceptance.',
  results,
};
await writeFile(path.join(evidenceDirectory, 'portable-tool-smoke.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
if (results.some((result) => !result.passed)) process.exitCode = 1;
