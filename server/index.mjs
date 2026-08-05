/**
 * pi-agent-studio backend — a small HTTP/SSE server that exposes the real
 * pi agent to the browser.
 *
 * - Session listing/messages are read from ~/.pi/agent/sessions (real files)
 * - Chatting runs the real agent in-process via the pi SDK
 *   (@earendil-works/pi-coding-agent: createAgentSession + SessionManager)
 * - Live streaming is pushed to browsers over Server-Sent Events
 *
 * The SDK is imported from the global pi install (no local copy needed).
 * Override with PI_SDK_DIR. The server is dependency-free Node (ESM).
 */
import { createServer } from 'node:http';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.env.PI_STUDIO_PORT ?? 7493);
/** Working directory for newly created chats. */
const NEW_CHAT_CWD = process.env.PI_STUDIO_CWD ?? '/workspace/sf';
/** Session file of a pi TUI session that is live right now (never prompt it). */
const LIVE_TUI_FILE = process.env.PI_SESSION_FILE ?? null;

const SESSIONS_ROOT = path.join(os.homedir(), '.pi', 'agent', 'sessions');

// ── SDK discovery (global pi install) ─────────────────────────────────────

function findSdkDir() {
  if (process.env.PI_SDK_DIR && existsSync(process.env.PI_SDK_DIR)) return process.env.PI_SDK_DIR;
  try {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const p = path.join(root, '@earendil-works', 'pi-coding-agent');
    if (existsSync(path.join(p, 'dist', 'index.js'))) return p;
  } catch { /* fall through */ }
  return null;
}

const sdkDir = findSdkDir();
if (!sdkDir) {
  console.error('pi SDK not found (set PI_SDK_DIR)');
  process.exit(1);
}
const sdk = await import(pathToFileURL(path.join(sdkDir, 'dist', 'index.js')).href);

// ── Live agent sessions (one per session file, in-process) ────────────────

/** file → { session: AgentSession, status: 'idle' | 'running' } */
const liveSessions = new Map();

/** SSE clients: Set<http.ServerResponse> */
const clients = new Set();

function emit(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try { res.write(data); } catch { /* client gone */ }
  }
}

// ── Session file parsing (real pi session files) ──────────────────────────

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    let images = 0;
    for (const block of content) {
      if (block.type === 'text') parts.push(block.text);
      else if (block.type === 'image') images += 1;
      else if (block.type === 'input_text') parts.push(block.text ?? '');
    }
    const base = parts.join('\n');
    return images > 0 ? (base ? `${base}\n[📷 ${images} image]` : `[📷 ${images} image]`) : base;
  }
  return '';
}

/** Convert an AgentMessage into the wire/display shape. */
function toDisplayMessage(message) {
  const d = { role: message.role, text: '', ts: message.timestamp ?? Date.now() };
  if (message.role === 'assistant') {
    d.text = textOf(message.content);
    d.model = message.model ?? null;
    d.stopReason = message.stopReason ?? null;
    d.error = message.errorMessage ?? null;
    const thinking = [];
    const toolCalls = [];
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === 'thinking') thinking.push(block.thinking);
      else if (block.type === 'toolCall') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          args: block.arguments === undefined ? '' : JSON.stringify(block.arguments, null, 1),
          result: undefined,
          isError: undefined,
        });
      }
    }
    d.thinking = thinking.length ? thinking.join('\n') : undefined;
    d.toolCalls = toolCalls.length ? toolCalls : undefined;
  } else if (message.role === 'user') {
    d.text = textOf(message.content);
  } else if (message.role === 'toolResult') {
    d.text = textOf(message.content);
    d.toolCallId = message.toolCallId ?? null;
    d.toolName = message.toolName ?? null;
    d.isError = !!message.isError;
  } else if (message.role === 'bashExecution') {
    d.role = 'bash';
    d.text = message.output ?? '';
    d.command = message.command ?? '';
    d.exitCode = message.exitCode;
  } else if (message.role === 'compactionSummary' || message.role === 'branchSummary') {
    d.role = 'summary';
    d.text = message.summary ?? '';
  } else if (message.role === 'custom') {
    d.role = 'custom';
    d.text = textOf(message.content);
    d.customType = message.customType ?? null;
  }
  return d;
}

/** Walk the active branch (leaf → root via parentId) of parsed entries. */
function leafChain(entries) {
  if (entries.length === 0) return [];
  const byId = new Map();
  for (const e of entries) {
    if (e.id !== undefined) byId.set(e.id, e);
  }
  const chain = [];
  let cur = entries[entries.length - 1];
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return chain.reverse();
}

/** Parse a session file: header, name, stats, and display messages. */
async function analyzeSession(file, opts = {}) {
  const content = await readFile(file, 'utf8').catch(() => null);
  if (content === null) return null;
  const entries = sdk.parseSessionEntries(content);
  const chain = leafChain(entries);
  const header = entries.find((e) => e.type === 'session');
  let name;
  let model = null;
  let tokensIn = 0, tokensOut = 0, cost = 0;
  let firstMessage = '';
  let lastText = '';
  let userMessages = 0;
  const messages = [];

  const toolCallIndex = new Map(); // toolCallId → display message index
  for (const entry of chain) {
    if (entry.type === 'session') continue;
    if (entry.type === 'session_info' && entry.name !== undefined) name = entry.name;
    if (entry.type === 'model_change') {
      if (!model) model = entry.modelId ?? null;
      continue;
    }
    if (entry.type !== 'message') continue;
    const msg = entry.message;
    if (!msg) continue;
    if (msg.usage) {
      tokensIn += msg.usage.input ?? 0;
      tokensOut += msg.usage.output ?? 0;
      if (msg.usage.cost?.total) cost += msg.usage.cost.total;
    }
    if (msg.role === 'user') {
      userMessages += 1;
      if (!firstMessage) firstMessage = textOf(msg.content);
      lastText = textOf(msg.content);
    }
    if (msg.role === 'assistant') {
      if (msg.model) model = msg.model;
      const t = textOf(msg.content);
      if (t) lastText = t;
    }
    const dm = toDisplayMessage(msg);
    dm.id = entry.id;
    messages.push(dm);
    if (dm.role === 'assistant' && dm.toolCalls) {
      for (const tc of dm.toolCalls) toolCallIndex.set(tc.id, messages.length - 1);
    }
  }
  // Merge tool results into their assistant tool call.
  for (const dm of messages) {
    if (dm.role === 'toolResult' && dm.toolCallId) {
      const idx = toolCallIndex.get(dm.toolCallId);
      if (idx !== undefined) {
        const tc = messages[idx].toolCalls?.find((t) => t.id === dm.toolCallId);
        if (tc) { tc.result = dm.text; tc.isError = dm.isError; }
        dm.merged = true;
      }
    }
  }
  const merged = messages.filter((m) => m.role !== 'toolResult' || !m.merged);

  // Pagination: by default (or with `before`) only the newest slice is
  // converted/returned; `oldestId` + `hasMore` let the client page upward.
  let oldestId = null;
  let hasMore = false;
  if (opts.limit || opts.before) {
    let end = merged.length;
    if (opts.before) {
      const idx = merged.findIndex((m) => m.id === opts.before);
      if (idx >= 0) end = idx; // unknown cursor → serve the newest slice
    }
    const start = Math.max(0, end - (opts.limit ?? merged.length));
    oldestId = start < merged.length ? merged[start].id : null;
    hasMore = start > 0;
    merged.splice(0, start); // keep only [start, end)…
    merged.splice(end - start); // …then trim the tail above `end`
  }

  const st = await stat(file).catch(() => null);
  const modified = st ? st.mtimeMs : Date.now();
  const created = header?.timestamp ? new Date(header.timestamp).getTime() : modified;
  const running = liveSessions.get(file)?.status === 'running';

  const info = {
    file,
    name: name ?? null,
    cwd: header?.cwd ?? '',
    created,
    modified,
    messageCount: chain.filter((e) => e.type === 'message').length,
    userMessages,
    firstMessage: firstMessage.slice(0, 200),
    preview: lastText.slice(0, 200),
    model,
    tokens: { input: tokensIn, output: tokensOut, total: tokensIn + tokensOut },
    cost,
    running,
    tuiActive: file === LIVE_TUI_FILE,
  };
  if (opts.withMessages) {
    info.messages = merged;
    info.oldestId = oldestId;
    info.hasMore = hasMore;
  }
  return info;
}

// ── Agent session lifecycle ───────────────────────────────────────────────

function emitMsg(file, message) {
  const dm = toDisplayMessage(message);
  // Stable identity across streaming updates: the assistant partial keeps
  // one timestamp for its whole life; user messages get their own too.
  if (message.role === 'assistant') dm.id = `asst-${message.timestamp ?? Date.now()}`;
  else if (message.role === 'user') dm.id = `user-${message.timestamp ?? Date.now()}`;
  else if (message.role === 'toolResult') dm.id = `toolresult-${message.toolCallId ?? message.timestamp ?? Date.now()}`;
  else dm.id = `msg-${message.timestamp ?? Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  emit({ type: 'message', file, message: dm });
}

function extractText(result) {
  if (!result) return '';
  const content = result.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  return '';
}

async function ensureSession(file) {
  let live = liveSessions.get(file);
  if (live) return live;
  const { session } = await sdk.createAgentSession({
    sessionManager: sdk.SessionManager.open(file),
  });
  live = { session, status: 'idle' };
  liveSessions.set(file, live);
  attachSession(file, live);
  return live;
}

/** Subscribe an AgentSession's events to the SSE hub. */
function attachSession(file, live) {
  live.session.subscribe((ev) => {
    switch (ev.type) {
      case 'agent_start':
        live.status = 'running';
        emit({ type: 'session_status', file, status: 'running' });
        break;
      case 'agent_settled':
        live.status = 'idle';
        emit({ type: 'session_status', file, status: 'idle' });
        emit({ type: 'refresh', file });
        break;
      case 'message_start':
      case 'message_update':
      case 'message_end':
        emitMsg(file, ev.message);
        break;
      case 'turn_end': {
        emitMsg(file, ev.message);
        for (const tr of ev.toolResults ?? []) {
          emit({
            type: 'tool_result',
            file,
            toolCallId: tr.toolCallId,
            toolName: tr.toolName,
            text: extractText(tr),
            isError: !!tr.isError,
          });
        }
        break;
      }
      case 'tool_execution_start':
        emit({ type: 'tool_start', file, toolCallId: ev.toolCallId, toolName: ev.toolName, args: ev.args });
        break;
      case 'tool_execution_update':
        emit({ type: 'tool_partial', file, toolCallId: ev.toolCallId, text: extractText(ev.partialResult) });
        break;
      case 'tool_execution_end':
        emit({ type: 'tool_result', file, toolCallId: ev.toolCallId, toolName: ev.toolName, text: extractText(ev.result), isError: !!ev.isError });
        break;
      case 'entry_appended':
        emit({ type: 'refresh', file });
        break;
      default:
        break;
    }
  });
}

// ── HTTP handlers ──────────────────────────────────────────────────────────

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    // ── SSE event stream ──
    if (p === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(`event: ready\ndata: {}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    // ── Session list ──
    if (p === '/api/sessions' && req.method === 'GET') {
      const sessions = [];
      for (const dirEntry of await readdir(SESSIONS_ROOT, { withFileTypes: true })) {
        if (!dirEntry.isDirectory()) continue;
        const dir = path.join(SESSIONS_ROOT, dirEntry.name);
        for (const f of await readdir(dir)) {
          if (!f.endsWith('.jsonl')) continue;
          const info = await analyzeSession(path.join(dir, f));
          if (info) sessions.push(info);
        }
      }
      sessions.sort((a, b) => b.modified - a.modified);
      sendJson(res, 200, { sessions });
      return;
    }

    // ── Messages of one session (paginated: newest first, cursor `before`) ──
    if (p === '/api/sessions/messages' && req.method === 'GET') {
      const file = url.searchParams.get('file');
      if (!file) return sendJson(res, 400, { error: 'missing file' });
      const limit = Number(url.searchParams.get('limit')) || undefined;
      const before = url.searchParams.get('before') || undefined;
      // Brand-new sessions (created via /api/new-chat) have no file until
      // their first message is appended — serve them as empty.
      if (!existsSync(file) && liveSessions.has(file)) {
        sendJson(res, 200, { file, name: null, cwd: NEW_CHAT_CWD, created: Date.now(), modified: Date.now(), messageCount: 0, userMessages: 0, firstMessage: '', preview: '', model: null, tokens: { input: 0, output: 0, total: 0 }, cost: 0, running: false, tuiActive: false, messages: [], oldestId: null, hasMore: false });
        return;
      }
      const info = await analyzeSession(file, { withMessages: true, limit, before });
      if (!info) return sendJson(res, 404, { error: 'session file not found' });
      sendJson(res, 200, info);
      return;
    }

    // ── Send a message to a session ──
    if (p === '/api/chat' && req.method === 'POST') {
      const { file, message } = await readBody(req);
      if (!file || typeof message !== 'string' || !message.trim()) {
        return sendJson(res, 400, { error: 'file and message required' });
      }
      if (file === LIVE_TUI_FILE) {
        return sendJson(res, 409, { error: 'This session is live in the pi TUI — open another chat.' });
      }
      // Files we created/opened ourselves may not exist on disk yet
      // (session files are written on the first appended entry).
      if (!liveSessions.has(file) && !existsSync(file)) {
        return sendJson(res, 404, { error: 'session file not found' });
      }
      const live = await ensureSession(file);
      if (live.status === 'running') {
        return sendJson(res, 409, { error: 'Session is already generating' });
      }
      // Fire the user message immediately (snappy UI), then prompt.
      const ts = Date.now();
      emit({
        type: 'message',
        file,
        message: { id: `pending-${ts}`, role: 'user', text: message, ts },
      });
      await live.session.prompt(message);
      sendJson(res, 200, { ok: true });
      return;
    }

    // ── New chat ──
    if (p === '/api/new-chat' && req.method === 'POST') {
      const { cwd } = await readBody(req);
      const targetCwd = cwd || NEW_CHAT_CWD;
      const sessionManager = sdk.SessionManager.create(targetCwd);
      const { session } = await sdk.createAgentSession({ sessionManager });
      const file = session.sessionFile;
      const live = { session, status: 'idle' };
      liveSessions.set(file, live);
      attachSession(file, live);
      sendJson(res, 200, { file, cwd: targetCwd });
      return;
    }

    // ── Abort a running session ──
    if (p === '/api/abort' && req.method === 'POST') {
      const { file } = await readBody(req);
      const live = liveSessions.get(file);
      if (live) await live.session.abort();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (p === '/api/health') {
      sendJson(res, 200, { ok: true, sdkDir });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('handler error:', e);
    sendJson(res, 500, { error: String(e?.message ?? e) });
  }
});

// Heartbeat keeps SSE connections alive through proxies.
const heartbeat = setInterval(() => {
  for (const res of clients) {
    try { res.write(': ping\n\n'); } catch { /* ignore */ }
  }
}, 15000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`pi-agent-studio backend on 0.0.0.0:${PORT} (sdk: ${sdkDir})`);
  console.log(`sessions: ${SESSIONS_ROOT}`);
  console.log(`new chats cwd: ${NEW_CHAT_CWD}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    clearInterval(heartbeat);
    for (const { session } of liveSessions.values()) {
      try { session.dispose(); } catch { /* ignore */ }
    }
    process.exit(0);
  });
}
