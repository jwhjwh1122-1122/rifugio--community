// claude-relay: OpenAI-compatible /v1/chat/completions backed by `claude -p`
// using a Claude subscription token (CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`).
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 8080;
const RELAY_KEY = process.env.RELAY_KEY || '';
const TIMEOUT_MS = Number(process.env.RELAY_TIMEOUT_MS) || 140000;
const MAX_CONCURRENT = Number(process.env.RELAY_MAX_CONCURRENT) || 3;
const DEFAULT_MODEL = process.env.RELAY_DEFAULT_MODEL || 'sonnet';
const LOCAL_BIN = path.join(__dirname, 'node_modules', '.bin', 'claude');
const CLAUDE_BIN = process.env.CLAUDE_BIN || (fs.existsSync(LOCAL_BIN) ? LOCAL_BIN : 'claude');
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
let running = 0;

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  });
  res.end(body);
}

function fail(res, status, message) {
  send(res, status, { error: { message, type: 'relay_error' } });
}

function text(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(p => (typeof p === 'string' ? p : p && (p.text || p.content) || '')).join('');
  }
  return content == null ? '' : String(content);
}

function buildPrompt(messages) {
  const system = [];
  const turns = [];
  for (const m of messages) {
    const role = String(m && m.role || 'user');
    const body = text(m && m.content).trim();
    if (!body) continue;
    if (role === 'system' || role === 'developer') system.push(body);
    else turns.push({ role: role === 'assistant' ? 'assistant' : 'user', body });
  }
  let lastUser = -1;
  for (let i = turns.length - 1; i >= 0; i -= 1) if (turns[i].role === 'user') { lastUser = i; break; }
  if (lastUser === -1) throw new Error('messages must include a user message');
  const history = turns.slice(0, lastUser);
  const current = turns.slice(lastUser).map(t => t.body).join('\n\n');
  let prompt = current;
  if (history.length) {
    const lines = history.map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.body}`).join('\n\n');
    prompt = `<conversation_history>\n${lines}\n</conversation_history>\n\nContinue the conversation. Reply to the user's latest message:\n\n${current}`;
  }
  return { system: system.join('\n\n'), prompt };
}

function mapModel(model) {
  const m = String(model || '').trim().toLowerCase();
  if (!m) return DEFAULT_MODEL;
  if (/opus/.test(m)) return 'opus';
  if (/haiku/.test(m)) return 'haiku';
  if (/sonnet/.test(m)) return 'sonnet';
  return /^[a-z0-9.\-]+$/.test(m) ? m : DEFAULT_MODEL;
}

function runClaude({ system, prompt, model }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY; // would override the subscription token
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.RELAY_KEY;
    const args = ['-p', '--output-format', 'json', '--model', model, '--tools', '', '--no-session-persistence'];
    if (system) args.push('--system-prompt', system);
    const child = spawn(CLAUDE_BIN, args, { cwd: WORKDIR, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('claude timed out')); }, TIMEOUT_MS);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      let data = null;
      try { data = JSON.parse(out.trim().split('\n').pop()); } catch (_) {}
      if (data && !data.is_error && typeof data.result === 'string') return resolve(data);
      const detail = (data && (data.result || data.subtype)) || err.trim() || out.trim() || `exit ${code}`;
      reject(new Error(String(detail).slice(0, 500)));
    });
    child.stdin.end(prompt);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 2 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/\/+$/, '');
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method === 'GET' && (p === '' || p === '/health')) {
    return send(res, 200, { ok: true, token: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN), running });
  }
  if (RELAY_KEY) {
    const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (auth !== RELAY_KEY) return fail(res, 401, 'invalid api key');
  }
  if (req.method === 'GET' && p === '/v1/models') {
    const now = Math.floor(Date.now() / 1000);
    return send(res, 200, {
      object: 'list',
      data: ['sonnet', 'opus', 'haiku'].map(id => ({ id, object: 'model', created: now, owned_by: 'claude-relay' })),
    });
  }
  if (req.method !== 'POST' || p !== '/v1/chat/completions') return fail(res, 404, 'not found');
  if (running >= MAX_CONCURRENT) return fail(res, 429, 'relay busy, try again');
  running += 1;
  const started = Date.now();
  try {
    const body = JSON.parse(await readBody(req) || '{}');
    if (!Array.isArray(body.messages) || !body.messages.length) throw Object.assign(new Error('messages required'), { status: 400 });
    const model = mapModel(body.model);
    const { system, prompt } = buildPrompt(body.messages);
    const data = await runClaude({ system, prompt, model });
    const content = data.result.trim();
    const usage = data.usage || {};
    const completion = {
      id: `chatcmpl-relay-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: usage.input_tokens || 0,
        completion_tokens: usage.output_tokens || 0,
        total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
      },
    };
    console.log(`[relay] ok model=${model} ms=${Date.now() - started} chars=${content.length}`);
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
      const chunk = { ...completion, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: 'stop' }] };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    send(res, 200, completion);
  } catch (e) {
    console.error(`[relay] error ms=${Date.now() - started}: ${e.message}`);
    fail(res, e.status || 502, e.message);
  } finally {
    running -= 1;
  }
});

if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) console.warn('[relay] WARNING: CLAUDE_CODE_OAUTH_TOKEN is not set');
if (!RELAY_KEY) console.warn('[relay] WARNING: RELAY_KEY is not set, anyone can use this relay');
server.listen(PORT, () => console.log(`[relay] listening on ${PORT}, claude=${CLAUDE_BIN}`));
