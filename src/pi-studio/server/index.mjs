/**
 * pi-agent-studio backend — HTTP/SSE gateway to pi-nest.
 *
 * This process does NOT own any pi agent. It:
 *   - parses session files (~/.pi/agent/sessions) for the list + messages
 *   - relays pi-nest's agent event stream to browsers over Server-Sent Events
 *   - proxies chat / abort / slash / new-chat / catalog to pi-nest over gRPC
 *
 * Because the agents and their per-agent queues live in pi-nest (a separate
 * daemon), restarting this server never interrupts a running agent: a prompt
 * keeps streaming, queued messages keep executing, and the frontend simply
 * reconnects (SSE re-open + file tail re-sync).
 *
 * No SDK import here — pi-nest owns the SDK. The only SDK-derived logic that
 * survives is the (stateless) session-file parser below.
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient, waitForNest } from '../../pi-nest/src/client.mjs';

const PORT = Number(process.env.PI_STUDIO_PORT ?? 7493);
/** Working directory for newly created chats. */
const NEW_CHAT_CWD = process.env.PI_STUDIO_CWD ?? '/workspace/sf';
const SESSIONS_ROOT = path.join(os.homedir(), '.pi', 'agent', 'sessions');

const client = createClient();

// ── Session file parsing (stateless; pi-nest owns the live agents) ────────

/** Split a session file's lines into entries (mirrors the SDK's parser:
 *  malformed lines are skipped, so a torn write never breaks the list). */
function parseEntries(content) {
  const out = [];
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip malformed line */ }
  }
  return out;
}

/** Stable id for compaction/branch summaries: derived from the text, so the
 *  live SSE copy and the file-parse copy upsert to the same message. */
function hashId(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

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

/** Convert an entry's message into the wire/display shape (file-parse side). */
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
  // Root → tail along parentId links (the active branch).
  const chain = [];
  const seen = new Set();
  let cur = entries[entries.length - 1];
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  chain.reverse();
  // Compaction entries are appended as SIBLINGS of the messages that follow
  // them (both share the same parentId), so the parent walk above never
  // reaches them. Merge each one back, chronologically, right before the
  // first chain entry that shares its parentId.
  const compactions = entries
    .filter((e) => e.type === 'compaction' && e.parentId !== undefined && !seen.has(e.id))
    .sort((a, b) => (Date.parse(a.timestamp) || 0) - (Date.parse(b.timestamp) || 0));
  for (const c of compactions) {
    const pos = chain.findIndex((e) => e.type !== 'compaction' && e.parentId === c.parentId);
    if (pos >= 0) chain.splice(pos, 0, c);
  }
  return chain;
}

/** Parsed session cache. Session files are append-only (the SDK appends
 *  whole JSON lines; a torn write leaves a partial final line), so once a
 *  file has been read we reuse its parsed entries and on growth read + parse
 *  ONLY the appended bytes — a busy run that appends entries no longer
 *  re-JSON-parses the whole file (the dominant backend cost). Shrinks,
 *  rewrites, and vanished files fall back to a full re-parse. Invalidated by
 *  (mtime, size). */
const sessionParseCache = new Map();

/** Derive stats + display messages from parsed entries (the cacheable part). */
function deriveSession(entries, st) {
  const chain = leafChain(entries);
  const header = entries.find((e) => e.type === 'session');
  let name;
  let model = null;
  let tokensIn = 0, tokensOut = 0, cost = 0;
  let firstMessage = '';
  let lastText = '';
  let userMessages = 0;
  let messageCount = 0;
  const messages = [];

  const toolCallIndex = new Map(); // toolCallId → display message index
  for (const entry of chain) {
    if (entry.type === 'session') continue;
    if (entry.type === 'session_info' && entry.name !== undefined) name = entry.name;
    if (entry.type === 'model_change') {
      if (!model) model = entry.modelId ?? null;
      continue;
    }
    if (entry.type === 'compaction') {
      messages.push({
        role: 'summary',
        text: entry.summary ?? '',
        ts: Date.parse(entry.timestamp) || Date.now(),
        id: `summary-${hashId(entry.summary ?? '')}`,
      });
      continue;
    }
    if (entry.type !== 'message') continue;
    const msg = entry.message;
    if (!msg) continue;
    messageCount += 1;
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
  return {
    base: {
      header,
      name,
      cwd: header?.cwd ?? '',
      created: header?.timestamp ? new Date(header.timestamp).getTime() : st.mtimeMs,
      messageCount,
      userMessages,
      firstMessage: firstMessage.slice(0, 200),
      preview: lastText.slice(0, 200),
      model,
      tokens: { input: tokensIn, output: tokensOut, total: tokensIn + tokensOut },
      cost,
    },
    merged: messages.filter((m) => m.role !== 'toolResult' || !m.merged),
  };
}

/** Read exactly [start, EOF) — readFile's `start` option is silently
 *  ignored by node, so a tail read must use a stream. */
function readTail(file, start) {
  return new Promise((resolve, reject) => {
    let data = '';
    const rs = createReadStream(file, { start, encoding: 'utf8' });
    rs.on('data', (c) => { data += c; });
    rs.on('end', () => resolve(data));
    rs.on('error', reject);
  });
}

/** (Re)load a session file into the cache. On append-only growth reads just
 *  the appended bytes and reuses the parsed entries; `pendingRaw` carries a
 *  torn/partial final line across reads so no complete line is ever lost. */
async function reloadSessionCache(file, st, cached) {
  if (cached && st.size > cached.size) {
    const appended = await readTail(file, cached.size).catch(() => null);
    if (appended !== null) {
      let chunk = (cached.pendingRaw ?? '') + appended;
      let pendingRaw = '';
      if (chunk && !chunk.endsWith('\n')) {
        const nl = chunk.lastIndexOf('\n');
        if (nl < 0) { pendingRaw = chunk; chunk = ''; }
        else { pendingRaw = chunk.slice(nl + 1); chunk = chunk.slice(0, nl + 1); }
      }
      const newEntries = [];
      for (const line of chunk.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { newEntries.push(JSON.parse(t)); } catch { /* skip malformed */ }
      }
      // Boundary sanity: with no pending line the appended chunk starts at a
      // fresh entry, so it must contain one. A weird boundary (rewrite) →
      // full re-parse.
      const plausible = pendingRaw !== '' || newEntries.length > 0 || chunk.trim() === '';
      if (plausible) {
        const entries = [...cached.entries, ...newEntries];
        return {
          mtime: st.mtimeMs,
          size: st.size, // partial-line bytes are held in pendingRaw, not re-read
          pendingRaw,
          entries,
          ...deriveSession(entries, st),
        };
      }
    }
  }
  const content = await readFile(file, 'utf8').catch(() => null);
  if (content === null) return null;
  const entries = parseEntries(content);
  return {
    mtime: st.mtimeMs,
    size: st.size,
    pendingRaw: '',
    entries,
    ...deriveSession(entries, st),
  };
}

/**
 * Parse a session file: header, name, stats, and display messages. The
 * expensive parse is cached (incrementally, see reloadSessionCache);
 * `running` (overlaid from the pi-nest state map passed in opts.states) and
 * the requested message slice are overlaid fresh on every call.
 */
async function analyzeSession(file, opts = {}) {
  const st = await stat(file).catch(() => null);
  if (!st) {
    sessionParseCache.delete(file);
    return null; // file vanished
  }
  let cached = sessionParseCache.get(file);
  if (!cached || cached.mtime !== st.mtimeMs || cached.size !== st.size) {
    cached = await reloadSessionCache(file, st, cached);
    if (!cached) return null;
    sessionParseCache.set(file, cached);
  }
  const { base, merged: baseMerged } = cached;

  // Per-request overlay: pagination slices the cached message list.
  // By default (or with `before`) only the newest slice is returned;
  // `oldestId` + `hasMore` let the client page upward. With `after`,
  // return the unbounded tail newer than that entry (used by clients to
  // sync live appends without re-reading what they have).
  let merged = baseMerged;
  let oldestId = null;
  let hasMore = false;
  if (opts.after) {
    const idx = merged.findIndex((m) => m.id === opts.after);
    if (idx >= 0) merged = merged.slice(idx + 1);
    // unknown cursor → return everything; the client dedupes by id
  } else if (opts.limit || opts.before) {
    let end = merged.length;
    if (opts.before) {
      const idx = merged.findIndex((m) => m.id === opts.before);
      if (idx >= 0) end = idx; // unknown cursor → serve the newest slice
    }
    const start = Math.max(0, end - (opts.limit ?? merged.length));
    oldestId = start < merged.length ? merged[start].id : null;
    hasMore = start > 0;
    // Keep only [start, end) — the requested slice.
    merged = merged.slice(start, end);
  }

  const modified = st ? st.mtimeMs : Date.now();
  const live = opts.states?.get(file);
  const running = live?.status === 'running';
  const runningSince = live?.runningSinceMs ?? null;

  const info = {
    file,
    name: base.name ?? null,
    cwd: base.cwd,
    created: base.created,
    modified,
    messageCount: base.messageCount,
    userMessages: base.userMessages,
    firstMessage: base.firstMessage,
    preview: base.preview,
    model: base.model,
    tokens: base.tokens,
    cost: base.cost,
    running,
    runningSince,
  };
  if (opts.withMessages) {
    info.messages = merged;
    info.oldestId = oldestId;
    info.hasMore = hasMore;
  }
  return info;
}

// ── SSE hub ───────────────────────────────────────────────────────────────

/** SSE clients: Set<http.ServerResponse> */
const clients = new Set();

function emit(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try { res.write(data); } catch { /* client gone */ }
  }
}

/** Trailing-edge coalescing for refresh events. A busy turn appends many
 *  entries (each broadcast as a refresh), and every refresh makes the
 *  frontend re-sync list + open tails — which re-parses session files on
 *  the backend. One refresh per file per quiet window carries the same
 *  final state at a fraction of the churn. */
const refreshTimers = new Map();
function emitRefresh(file) {
  const existing = refreshTimers.get(file);
  if (existing) clearTimeout(existing);
  refreshTimers.set(file, setTimeout(() => {
    refreshTimers.delete(file);
    emit({ type: 'refresh', file });
  }, 250));
}

/**
 * Relay pi-nest's event stream to SSE, reconnecting forever. While this
 * server is down, pi-nest keeps running the agents; on reconnect the relay
 * resumes and the frontend re-syncs via the file-based messages endpoint.
 */
async function relayNestEvents() {
  for (;;) {
    try {
      await waitForNest(client, { timeoutMs: 5000, log: () => {} });
      const stream = client.subscribe('');
      await new Promise((resolve) => {
        stream.on('data', (ev) => {
          let payload = {};
          try { payload = ev.json ? JSON.parse(ev.json) : {}; } catch { /* ignore */ }
          // Preserve the SSE vocabulary the frontend expects: message events
          // carry the display message under `message`; everything else is
          // spread at top level (status, tool info, ...).
          if (ev.type === 'message') emit({ type: 'message', file: ev.file, message: payload });
          else if (ev.type === 'refresh') emitRefresh(ev.file);
          else emit({ type: ev.type, file: ev.file, ...payload });
        });
        stream.once('error', () => { console.log('[gateway] relay stream dropped — reconnecting'); resolve(); });
        stream.once('end', () => { console.log('[gateway] relay stream ended — reconnecting'); resolve(); });
      });
    } catch { /* keepalive retry */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
relayNestEvents();

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
      const files = [];
      for (const dirEntry of await readdir(SESSIONS_ROOT, { withFileTypes: true })) {
        if (!dirEntry.isDirectory()) continue;
        const dir = path.join(SESSIONS_ROOT, dirEntry.name);
        for (const f of await readdir(dir)) {
          if (f.endsWith('.jsonl')) files.push(path.join(dir, f));
        }
      }
      // Live-state overlay comes from pi-nest (the agent owner), not from this
      // process — so `running` survives any restart of this server.
      const states = new Map(
        (await client.listStates().catch(() => ({ states: [] }))).states.map((s) => [s.agentId, s])
      );
      // Parallel parse (cache makes re-reads cheap; cold starts split across cores).
      const sessions = (await Promise.all(files.map((f) => analyzeSession(f, { states })))).filter(Boolean);
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
      const after = url.searchParams.get('after') || undefined;
      // Brand-new sessions (created via /api/new-chat) have no file until
      // their first message is appended — pi-nest knows them as pending/open
      // agents, so serve them as empty.
      if (!existsSync(file)) {
        const st = await client.getAgentState({ agentId: file }).catch(() => null);
        if (st?.state?.status) {
          sendJson(res, 200, { file, name: null, cwd: NEW_CHAT_CWD, created: Date.now(), modified: Date.now(), messageCount: 0, userMessages: 0, firstMessage: '', preview: '', model: null, tokens: { input: 0, output: 0, total: 0 }, cost: 0, running: st.state.status === 'running', messages: [], oldestId: null, hasMore: false });
          return;
        }
        return sendJson(res, 404, { error: 'session file not found' });
      }
      const info = await analyzeSession(file, { withMessages: true, limit, before, after });
      if (!info) return sendJson(res, 404, { error: 'session file not found' });
      sendJson(res, 200, info);
      return;
    }

    // ── Send a message to a session ──
    if (p === '/api/chat' && req.method === 'POST') {
      const { file, message, wait } = await readBody(req);
      if (!file || typeof message !== 'string' || !message.trim()) {
        return sendJson(res, 400, { error: 'file and message required' });
      }
      // Files we created/opened ourselves may not exist on disk yet (session
      // files are written on the first appended entry; lazy new-chats don't
      // exist until their first message). pi-nest knows them as agents.
      const st = await client.getAgentState({ agentId: file }).catch(() => null);
      if (!st?.state?.status && !existsSync(file)) {
        return sendJson(res, 404, { error: 'session file not found' });
      }
      // Default: the message INTERRUPTS a busy session (cut the current turn,
      // then run). `/wait <message>` (or `wait: true`) queues instead — the
      // message runs after the current turn finishes naturally.
      let interrupt = !wait;
      let text = message;
      const waitMatch = message.match(/^\/wait\b\s*([\s\S]*)$/);
      if (waitMatch) {
        interrupt = false;
        text = (waitMatch[1] ?? '').trim();
        if (!text) return sendJson(res, 400, { error: '/wait needs a message: /wait <message>' });
      }
      // pi-nest serializes concurrent sends per agent (interrupt or queue);
      // this call resolves when the queued turn completes — a restart of THIS
      // server mid-run leaves the agent untouched.
      await client.prompt({ agentId: file, message: text, interrupt });
      sendJson(res, 200, { ok: true });
      return;
    }

    // ── Slash command catalog (builtins + skills for autocomplete) ──
    if (p === '/api/slash-commands' && req.method === 'GET') {
      const r = await client.getSlashCatalog({});
      const commands = r.commandsJson ? JSON.parse(r.commandsJson) : [];
      const skills = r.skillsJson ? JSON.parse(r.skillsJson) : [];
      sendJson(res, 200, { commands, skills });
      return;
    }

    // ── Execute a slash command (pi-nest owns the agents) ──
    if (p === '/api/slash' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const r = await client.slash({
          agentId: body.file ?? '',
          command: body.command,
          args: body.args ?? '',
          extra: body.extra ?? {},
        });
        const out = { ok: r.ok, notice: r.notice || undefined, error: r.error || undefined };
        if (r.dataJson) out.data = JSON.parse(r.dataJson);
        sendJson(res, r.ok ? 200 : 400, out);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
      }
      return;
    }

    // ── New chat (pi-nest reserves the future session file lazily) ──
    if (p === '/api/new-chat' && req.method === 'POST') {
      const { cwd } = await readBody(req);
      const targetCwd = cwd || NEW_CHAT_CWD;
      const { file } = await client.createSession({ cwd: targetCwd });
      sendJson(res, 200, { file, cwd: targetCwd, virtual: true });
      return;
    }

    // ── Abort a running session (pi-nest) ──
    if (p === '/api/abort' && req.method === 'POST') {
      const { file } = await readBody(req);
      await client.abort({ agentId: file });
      sendJson(res, 200, { ok: true });
      return;
    }

    if (p === '/api/health') {
      let nest = false;
      try { nest = (await client.ping()).ok; } catch { /* nest down */ }
      sendJson(res, 200, { ok: true, nest });
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

// ── External session file watcher ─────────────────────────────────────────
// Sessions written by OTHER processes (e.g. the pi TUI) produce no agent
// events through pi-nest — poll file mtimes and emit refresh so open chat
// windows auto-update as entries land on disk.

const fileMtimes = new Map();

async function watchSessionFiles() {
  let dirs = [];
  try { dirs = await readdir(SESSIONS_ROOT, { withFileTypes: true }); } catch { return; }
  for (const dirEntry of dirs) {
    if (!dirEntry.isDirectory()) continue;
    const dir = path.join(SESSIONS_ROOT, dirEntry.name);
    let files = [];
    try { files = await readdir(dir); } catch { continue; } // one bad dir must not abort the pass
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(dir, f);
      const st = await stat(file).catch(() => null);
      if (!st) continue;
      const m = st.mtimeMs;
      if (fileMtimes.get(file) !== m) {
        const known = fileMtimes.has(file);
        fileMtimes.set(file, m);
        emitRefresh(file);
      }
    }
  }
}

// First pass primes the map; afterwards every mtime change emits refresh.
void watchSessionFiles().then(() => {
  setInterval(watchSessionFiles, 2000);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`pi-agent-studio backend on 0.0.0.0:${PORT} (gateway → pi-nest)`);
  console.log(`sessions: ${SESSIONS_ROOT}`);
  console.log(`new chats cwd: ${NEW_CHAT_CWD}`);
});
