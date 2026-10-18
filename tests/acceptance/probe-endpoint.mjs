import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.env.AE_WORKSPACE ?? process.cwd();
const text = await fs.readFile(path.join(root, '端点测试用.txt'), 'utf8');
const endpoint = text.match(/https?:\/\/[^\s]+/u)?.[0]?.replace(/\/+$/, '');
const key = text.match(/api[-_ ]?key\s*[:：]\s*(.+)/iu)?.[1]?.trim();
if (!endpoint || !key) throw new Error('The endpoint credentials file is malformed.');
const destination = path.join(root, 'artifacts', 'acceptance');
await fs.mkdir(destination, { recursive: true });
const evidence = { recordedAt: new Date().toISOString(), endpoint, probes: [] };
const sanitize = value => String(value).split(key).join('<redacted>');
async function probe(route, body, additionalHeaders = {}) {
  const started = performance.now();
  let record;
  try {
    const response = await fetch(`${endpoint}${route}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${key}`, 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', ...additionalHeaders },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(90000),
    });
    const raw = await response.text();
    let result;
    try { result = JSON.parse(raw); } catch { result = { raw: sanitize(raw).slice(0, 1000) }; }
    record = { route, model: body?.model, status: response.status, milliseconds: Math.round(performance.now() - started), result };
  } catch (error) {
    record = { route, model: body?.model, milliseconds: Math.round(performance.now() - started), error: sanitize(error.message) };
  }
  evidence.probes.push(record);
  await fs.writeFile(path.join(destination, 'endpoint-protocols.json'), sanitize(JSON.stringify(evidence, null, 2)));
  const resultText = JSON.stringify(record.result ?? {});
  console.log(JSON.stringify({ route, model: record.model, status: record.status, milliseconds: record.milliseconds, error: record.error, preview: sanitize(resultText).slice(0, 2500) }));
  return record;
}
const catalog = await probe('/v1/models');
const ids = catalog.result?.data?.map(model => model.id) ?? [];
await fs.writeFile(path.join(destination, 'models.json'), JSON.stringify({ endpoint, recordedAt: new Date().toISOString(), ids }, null, 2));
const candidate = process.env.AE_TEST_MODEL ?? ids.find(id => /claude-opus/i.test(id)) ?? ids[0] ?? 'claude-opus-4-6';
console.log(sanitize(JSON.stringify({ catalogModelCount: ids.length, selectedModel: candidate, allModels: ids })));
await Promise.all([
  probe('/v1/chat/completions', { model: candidate, messages: [{ role: 'user', content: 'Reply exactly with AE_SWITCH_CHAT_OK.' }], max_tokens: 64, stream: false }),
  probe('/v1/responses', { model: candidate, input: 'Reply exactly with AE_SWITCH_RESPONSES_OK.', max_output_tokens: 128, stream: false }),
  probe('/v1/messages', { model: candidate, messages: [{ role: 'user', content: 'Reply exactly with AE_SWITCH_MESSAGES_OK.' }], max_tokens: 64, stream: false }),
]);
