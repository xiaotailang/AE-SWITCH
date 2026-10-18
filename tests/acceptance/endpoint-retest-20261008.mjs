import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
const workspace = path.resolve(path.dirname(script), '../..');
const credentialFile = path.join(workspace, '端点测试用.txt');
const destination = path.join(workspace, 'artifacts/acceptance/endpoint-retest-20261008.json');
const credentialText = await fs.readFile(credentialFile, 'utf8');
const endpoint = credentialText.match(/https?:\/\/[^\s]+/u)?.[0]?.replace(/\/+$/u, '');
const keys = [...credentialText.matchAll(/api[-_ ]?key\s*[:：]\s*(.+)/giu)].map((match) => match[1].trim());
const key = credentialText.split(/\r?\n/u).map((line) => line.trim().match(/^api-key[:：](.*)$/u)?.[1]?.trim()).filter((value) => value !== undefined).at(-1);
if (!endpoint || !key) throw new Error('The current endpoint credential file is incomplete.');
const secrets = [...new Set([...keys, key])].filter(Boolean).sort((a, b) => b.length - a.length);
const sanitize = (text) => secrets.reduce((value, secret) => value.split(secret).join('<redacted>'), String(text));
const safeJson = (value) => JSON.stringify(value, (_name, item) => typeof item === 'string' ? sanitize(item) : item, 2);
const baseIncludesV1 = new URL(endpoint).pathname.replace(/\/+$/u, '').endsWith('/v1');
const marker = 'AE_ENDPOINT_RETEST_OK';
const mode = process.argv[3];
const phase = process.argv[4];

function classification(status, payload) {
  const text = JSON.stringify(payload).toLowerCase();
  if (status >= 200 && status < 300) return 'http_success';
  if (status === 401) return 'authentication_denied';
  if (status === 403) return /region|country|territory|地区|地域|区域/u.test(text) ? 'region_restricted' : 'permission_or_policy_denied';
  if (status === 404 || status === 405) return 'unsupported_route';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'upstream_error';
  return 'request_rejected';
}

async function request(route, body, protocol) {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${endpoint}${route}`, {
      method: body ? 'POST' : 'GET',
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${key}`, 'x-api-key': key,
        'anthropic-version': '2023-06-01', 'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 1024 * 1024) { controller.abort(); throw new Error('Response exceeded one MiB.'); }
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    let payload;
    try { payload = JSON.parse(raw); } catch { payload = { message: raw.match(/<title>([^<]*)<\/title>/iu)?.[1] ?? raw.slice(0, 800) }; }
    const ids = [...new Set((payload.data ?? payload.models ?? []).map?.((item) => typeof item === 'string' ? item : item.id).filter?.((item) => typeof item === 'string') ?? [])];
    const text = protocol === 'chat'
      ? payload.choices?.map((item) => item.message?.content ?? '').join('')
      : protocol === 'responses'
        ? payload.output?.flatMap((item) => item.content ?? []).filter((item) => item.type === 'output_text').map((item) => item.text).join('')
        : protocol === 'messages'
          ? payload.content?.filter((item) => item.type === 'text').map((item) => item.text).join('')
          : undefined;
    const failure = payload.error ?? (!response.ok ? payload : undefined);
    return {
      mode, route, protocol, model: body?.model, status: response.status,
      milliseconds: Math.round(performance.now() - started),
      classification: classification(response.status, payload),
      ...(protocol === 'models' ? { models: ids, modelCount: ids.length } : {
        inferenceVerified: response.ok && typeof text === 'string' && text.trim() === marker,
        reply: typeof text === 'string' ? sanitize(text).slice(0, 400) : undefined,
        finishReason: payload.choices?.[0]?.finish_reason,
        stopReason: payload.stop_reason, responseStatus: payload.status,
      }),
      ...(failure ? { error: (typeof failure === 'string' ? sanitize(failure) : safeJson(failure)).slice(0, 1200) } : {}),
    };
  } catch (error) {
    return {
      mode, route, protocol, model: body?.model,
      milliseconds: Math.round(performance.now() - started),
      classification: controller.signal.aborted ? 'request_timeout_or_output_limit' : 'transport_failure',
      error: sanitize(error.message), causeCode: error.cause?.code,
      causeMessage: error.cause?.message ? sanitize(error.cause.message).slice(0, 800) : undefined,
    };
  } finally { clearTimeout(timer); }
}

if (process.argv[2] === '--child') {
  const routes = baseIncludesV1 ? ['/models'] : ['/models', '/v1/models'];
  const results = phase === 'models'
    ? await Promise.all(routes.map((route) => request(route, undefined, 'models')))
    : await Promise.all([
      request(`${baseIncludesV1 ? '' : '/v1'}/chat/completions`, { model: process.argv[5], messages: [{ role: 'user', content: `Reply exactly ${marker}.` }], max_tokens: 64, stream: false }, 'chat'),
      request(`${baseIncludesV1 ? '' : '/v1'}/responses`, { model: process.argv[5], input: `Reply exactly ${marker}.`, max_output_tokens: 64, stream: false }, 'responses'),
      request(`${baseIncludesV1 ? '' : '/v1'}/messages`, { model: process.argv[5], messages: [{ role: 'user', content: `Reply exactly ${marker}.` }], max_tokens: 64, stream: false }, 'messages'),
    ]);
  console.log(safeJson(results));
} else {
  const candidates = [];
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    if (process.env[name]) candidates.push({ source: name, value: process.env[name] });
  }
  const argument = process.argv.indexOf('--system-proxy');
  if (argument >= 0 && process.argv[argument + 1]) candidates.push({ source: 'current-read-only-WinINet-settings', value: process.argv[argument + 1] });
  const unique = candidates.filter((candidate, index) => candidates.findIndex((other) => other.value === candidate.value) === index);
  const modes = [{ name: 'direct', proxy: null }, ...unique.map((candidate, index) => ({ name: `proxy-${index + 1}`, proxy: candidate }))];
  const stat = await fs.stat(credentialFile);
  const endpointUrl = new URL(endpoint);
  const report = {
    recordedAt: new Date().toISOString(),
    scope: 'Real model-directory and three API-protocol diagnostics only; independent of seven-agent tool E2E.',
    credentialSource: { file: path.basename(credentialFile), bytes: stat.size, lastWriteTime: stat.mtime.toISOString() },
    endpoint: endpointUrl.origin + endpointUrl.pathname,
    keyRetained: false, requestTimeoutMs: 30_000,
    networkModes: modes.map((item) => ({ mode: item.name, ...(item.proxy ? {
      proxySource: item.proxy.source, proxyHost: new URL(item.proxy.value).hostname, proxyPort: new URL(item.proxy.value).port,
    } : { proxyDisabledForDiagnosticChild: true }) })),
    models: [], selectedModel: null, modelDiscovery: [], protocols: [],
    sevenAgentToolE2eVerified: false,
  };
  const writeReport = async () => { await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, safeJson(report)); };
  async function child(network, requestedPhase, model) {
    const environment = { ...process.env, NODE_USE_ENV_PROXY: network.proxy ? '1' : '0' };
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NODE_OPTIONS']) delete environment[name];
    if (network.proxy) environment.HTTP_PROXY = environment.HTTPS_PROXY = network.proxy.value;
    return await new Promise((resolve) => {
      const started = performance.now();
      const processChild = spawn(process.execPath, [...(network.proxy ? ['--use-env-proxy'] : []), script, '--child', network.name, requestedPhase, ...(model ? [model] : [])], { cwd: workspace, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      processChild.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      processChild.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      processChild.on('error', (error) => resolve([{ mode: network.name, phase: requestedPhase, classification: 'diagnostic_spawn_failure', error: sanitize(error.message) }]));
      processChild.on('close', (code) => {
        try { resolve(JSON.parse(stdout)); } catch { resolve([{ mode: network.name, phase: requestedPhase, milliseconds: Math.round(performance.now() - started), exitCode: code, classification: 'diagnostic_child_failure', error: sanitize(stderr).slice(0, 1200) }]); }
      });
    });
  }
  report.modelDiscovery = (await Promise.all(modes.map((network) => child(network, 'models')))).flat();
  report.models = [...new Set(report.modelDiscovery.filter((item) => item.status === 200).flatMap((item) => item.models ?? []))];
  const requestedModel = process.env.AE_TEST_MODEL;
  report.selectedModel = requestedModel && report.models.includes(requestedModel) ? requestedModel : report.models[0] ?? null;
  report.selectedModelSource = report.selectedModel ? 'Actual successful live model directory; no fallback model.' : 'No model directory succeeded; inference was not attempted.';
  await writeReport();
  console.log(safeJson({ phase: 'models', modelCount: report.models.length, selectedModel: report.selectedModel, results: report.modelDiscovery.map(({ models, ...item }) => item) }));
  if (report.selectedModel) report.protocols = (await Promise.all(modes.map((network) => child(network, 'protocols', report.selectedModel)))).flat();
  report.usableNetworkModes = [...new Set(report.protocols.filter((item) => item.inferenceVerified).map((item) => item.mode))];
  report.usableProtocols = report.protocols.filter((item) => item.inferenceVerified).map((item) => ({ mode: item.mode, protocol: item.protocol, model: item.model }));
  await writeReport();
  console.log(safeJson({ phase: 'protocols', usableNetworkModes: report.usableNetworkModes, results: report.protocols }));
}
