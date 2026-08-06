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
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.env.PI_STUDIO_PORT ?? 7493);
/** Working directory for newly created chats. */
const NEW_CHAT_CWD = process.env.PI_STUDIO_CWD ?? '/workspace/sf';
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
const slashCommandsModule = await import(pathToFileURL(path.join(sdkDir, 'dist', 'core', 'slash-commands.js')).href);
const { BUILTIN_SLASH_COMMANDS } = slashCommandsModule;

// ── Live agent sessions (one per session file, in-process) ────────────────

/** file → { session: AgentSession, status: 'idle' | 'running' } */
const liveSessions = new Map();

/**
 * Lazy-start new chats: /api/new-chat only RESERVES a future session file
 * path (matching the SDK's naming) and remembers it here — the real SDK
 * agent session is created on the first message (/api/chat → ensureSession),
 * pinned to that exact path. Nothing is created until the user actually
 * chats: no AgentSession instance, no file on disk.
 */
const pendingSessions = new Map(); // file → { cwd, dir }

/** Mirror the SDK's session-file naming so a lazy session lands on its path. */
function newSessionPath(cwd) {
  const resolved = path.resolve(cwd);
  const safe = `--${resolved.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  const dir = path.join(SESSIONS_ROOT, safe);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, `${ts}_${randomUUID()}.jsonl`);
}

/** Stable id for compaction/branch summaries: derived from the text, so the
 *  live SSE copy and the file-parse copy upsert to the same message. */
function hashId(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

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

/** Cache of parsed session bases, invalidated by (mtime, size). Re-parsing
 *  every session file on each /api/sessions call (15s frontend poll + every
 *  SSE refresh event) is the dominant backend cost — this keeps repeated
 *  reads near-free while staying correct on any actual file change. */
const sessionParseCache = new Map();

/**
 * Parse a session file: header, name, stats, and display messages. The
 * expensive parse is cached per (mtime, size); `running` and the requested
 * message slice are overlaid fresh on every call.
 */
async function analyzeSession(file, opts = {}) {
  const st = await stat(file).catch(() => null);
  let base = null;
  if (st) {
    const hit = sessionParseCache.get(file);
    if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) base = hit.base;
  }
  if (!base) {
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
    let merged = messages.filter((m) => m.role !== 'toolResult' || !m.merged);
    if (st) {
      sessionParseCache.set(file, {
        mtime: st.mtimeMs,
        size: st.size,
        base: {
          header,
          name,
          cwd: header?.cwd ?? '',
          created: header?.timestamp ? new Date(header.timestamp).getTime() : st.mtimeMs,
          messageCount: chain.filter((e) => e.type === 'message').length,
          userMessages,
          firstMessage: firstMessage.slice(0, 200),
          preview: lastText.slice(0, 200),
          model,
          tokens: { input: tokensIn, output: tokensOut, total: tokensIn + tokensOut },
          cost,
          merged,
        },
      });
      base = sessionParseCache.get(file).base;
    }
  }
  if (!base) return null;  // file vanished between stat and read

  // Per-request overlay: pagination slices the cached message list.
  // By default (or with `before`) only the newest slice is returned;
  // `oldestId` + `hasMore` let the client page upward. With `after`,
  // return the unbounded tail newer than that entry (used by clients to
  // sync live appends without re-reading what they have).
  let merged = base.merged;
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
  const running = liveSessions.get(file)?.status === 'running';

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
  else if (message.role === 'compactionSummary' || message.role === 'branchSummary') dm.id = `summary-${hashId(message.summary ?? '')}`;
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
  if (pendingSessions.has(file)) {
    // Lazy start: the reserved virtual new-chat becomes real here, pinned
    // to the exact file path the frontend already holds as its session id.
    const { cwd, dir } = pendingSessions.get(file);
    pendingSessions.delete(file);
    const sessionManager = new sdk.SessionManager(cwd, dir, file, true);
    const { session } = await sdk.createAgentSession({ sessionManager });
    live = { session, status: 'idle' };
    liveSessions.set(file, live);
    attachSession(file, live);
    return live;
  }
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
      case 'compaction_start':
        emit({ type: 'compaction_status', file, status: 'started' });
        break;
      case 'compaction_end':
        emit({ type: 'compaction_status', file, status: ev.errorMessage ? 'failed' : 'done' });
        if (!ev.errorMessage && ev.result?.summary) {
          emitMsg(file, { role: 'compactionSummary', summary: ev.result.summary, timestamp: Date.now() });
        }
        break;
      default:
        break;
    }
  });
}

// ── Slash commands (the pi TUI command set, web-adapted) ───────────────────

/** Builtin commands that only make sense in the pi TUI — answered with a reason. */
const NA_COMMANDS = {
  settings: 'Settings are configured in the pi TUI (/settings there).',
  login: 'Provider authentication requires the pi TUI (opens OAuth in the terminal).',
  logout: 'Provider logout requires the pi TUI.',
  trust: 'Project trust decisions are made in the pi TUI.',
  share: 'Gist sharing requires GitHub auth in the pi TUI.',
  quit: 'Nothing to quit in a browser tab — close the tab instead.',
};

function serializeModel(m) {
  if (!m) return null;
  return {
    id: m.id,
    provider: m.provider,
    name: m.name,
    reasoning: !!m.reasoning,
    contextWindow: m.contextWindow ?? 0,
  };
}

function treeToJson(nodes) {
  return (nodes ?? []).map((n) => ({
    id: n.entry?.id,
    type: n.entry?.type,
    label: n.label ?? n.entry?.id,
    children: treeToJson(n.children),
  }));
}

/**
 * Execute one slash command against a session (or globally). Returns
 * { ok, notice?, error?, data? } — the frontend renders the outcome.
 */
async function handleSlashCommand({ file, command, args, extra }) {
  const name = String(command ?? '').replace(/^\/+/, '').trim();
  if (!name) return { ok: false, error: 'empty slash command' };
  if (NA_COMMANDS[name]) return { ok: true, notice: NA_COMMANDS[name] };

  switch (name) {
    case 'new': {
      // Same as the ➕ New Chat button: fresh session + window (frontend opens it).
      const cwd = args?.trim() || NEW_CHAT_CWD;
      const sessionManager = sdk.SessionManager.create(cwd);
      const { session } = await sdk.createAgentSession({ sessionManager });
      const f = session.sessionFile;
      const live = { session, status: 'idle' };
      liveSessions.set(f, live);
      attachSession(f, live);
      return { ok: true, data: { file: f } };
    }

    case 'session': {
      const live = await ensureSession(file);
      const stats = live.session.getSessionStats();
      const sm = live.session.sessionManager;
      const t = stats.tokens;
      const lines = [
        'Session Info',
        ...(sm.getSessionName() ? [`Name: ${sm.getSessionName()}`] : []),
        `File: ${stats.sessionFile ?? 'In-memory'}`,
        `ID: ${stats.sessionId}`,
        '',
        'Messages',
        `Total: ${stats.totalMessages}`,
        `User: ${stats.userMessages}`,
        `Assistant: ${stats.assistantMessages}`,
        `Tools: ${stats.toolCalls} calls, ${stats.toolResults} results`,
        '',
        'Tokens',
        `Input: ${(t.input + t.cacheRead + t.cacheWrite).toLocaleString()}`,
        `Output: ${t.output.toLocaleString()}`,
        `Cache: ${t.cacheRead.toLocaleString()} read, ${t.cacheWrite.toLocaleString()} written`,
        `Total: ${t.total.toLocaleString()}`,
        `Cost: $${(stats.cost ?? 0).toFixed(4)}`,
      ];
      const model = live.session.model;
      if (model) lines.push('', `Model: ${model.provider}/${model.id}`);
      lines.push('', 'The right panel shows live session stats at all times.');
      return { ok: true, data: { text: lines.join('\n') } };
    }

    case 'name': {
      const live = await ensureSession(file);
      const requested = args?.trim() ?? '';
      if (!requested) {
        const current = live.session.sessionManager.getSessionName();
        return { ok: true, notice: current ? `Session name: ${current}` : 'Usage: /name <name>' };
      }
      live.session.setSessionName(requested);
      const normalized = live.session.sessionManager.getSessionName();
      emit({ type: 'refresh', file });
      return { ok: true, notice: normalized ? `Session name set: ${normalized}` : `Session name set: ${requested}` };
    }

    case 'compact': {
      const live = await ensureSession(file);
      if (live.status === 'running') {
        return { ok: false, error: 'Wait for the current response to finish before compacting.' };
      }
      await live.session.compact(args?.trim() || undefined);
      return { ok: true, notice: 'Compaction complete — the conversation was summarized.' };
    }

    case 'copy': {
      const live = await ensureSession(file);
      const text = live.session.getLastAssistantText();
      if (!text) return { ok: true, notice: 'No agent messages to copy yet.' };
      return { ok: true, data: { text } };
    }

    case 'model': {
      const live = await ensureSession(file);
      const rt = live.session.modelRuntime;
      const current = live.session.model;
      const requested = args?.trim() ?? '';
      if (requested) {
        const models = await rt.getAvailable().catch(() => []);
        const term = requested.toLowerCase();
        const hit = models.find((m) =>
          m.id.toLowerCase() === term || `${m.provider}/${m.id}`.toLowerCase() === term || m.name.toLowerCase() === term,
        );
        if (!hit) return { ok: false, error: `No model matches "${requested}"` };
        await live.session.setModel(hit);
        emit({ type: 'refresh', file });
        return { ok: true, notice: `Model: ${hit.provider}/${hit.id}` };
      }
      const models = await rt.getAvailable().catch(() => []);
      return { ok: true, data: { models: models.map(serializeModel), current: serializeModel(current) } };
    }

    case 'scoped-models': {
      const live = await ensureSession(file);
      const rt = live.session.modelRuntime;
      const models = await rt.getAvailable().catch(() => []);
      const scoped = live.session.scopedModels;
      if (extra?.modelIds) {
        const ids = new Set(extra.modelIds);
        const picked = models.filter((m) => ids.has(`${m.provider}/${m.id}`));
        live.session.setScopedModels(picked.map((m) => ({ model: m })));
        return { ok: true, notice: picked.length > 0
          ? `Scoped models: ${picked.map((m) => m.id).join(', ')}`
          : 'Scoped models cleared (all models available)' };
      }
      return {
        ok: true,
        data: {
          models: models.map(serializeModel),
          scoped: scoped.map((s) => `${s.model.provider}/${s.model.id}`),
        },
      };
    }

    case 'tree': {
      const live = await ensureSession(file);
      const sm = live.session.sessionManager;
      if (extra?.entryId) {
        const target = sm.getEntry(extra.entryId);
        if (!target) return { ok: false, error: 'Entry not found in this session.' };
        await live.session.navigateTree(extra.entryId);
        emit({ type: 'refresh', file });
        return { ok: true, notice: `Switched to ${target.type === 'message' ? target.message?.role ?? 'entry' : target.type} at ${extra.entryId.slice(0, 8)}…` };
      }
      return {
        ok: true,
        data: {
          tree: treeToJson(sm.getTree()),
          leafId: sm.getLeafId(),
          currentLabel: sm.getLeafEntry()?.id,
        },
      };
    }

    case 'fork': {
      const live = await ensureSession(file);
      if (extra?.entryId) {
        const entry = live.session.sessionManager.getEntry(extra.entryId);
        if (!entry || entry.type !== 'message' || entry.message?.role !== 'user') {
          return { ok: false, error: 'Pick a user message to fork from.' };
        }
        if (!entry.parentId) return { ok: false, error: 'Cannot fork from the first message.' };
        const forked = await forkSession(live, entry.parentId);
        return { ok: true, data: { file: forked } };
      }
      return { ok: true, data: { userMessages: live.session.getUserMessagesForForking() } };
    }

    case 'clone': {
      const live = await ensureSession(file);
      const leafId = live.session.sessionManager.getLeafId();
      if (!leafId) return { ok: false, error: 'Nothing to clone yet.' };
      const forked = await forkSession(live, leafId);
      return { ok: true, data: { file: forked } };
    }

    case 'export': {
      const live = await ensureSession(file);
      const outPath = args?.trim() || undefined;
      let filePath, mime, filename;
      if (outPath?.endsWith('.jsonl')) {
        filePath = live.session.exportToJsonl(outPath);
        mime = 'application/x-ndjson';
      } else {
        filePath = await live.session.exportToHtml(outPath);
        mime = 'text/html';
      }
      filename = path.basename(filePath);
      const content = await readFile(filePath, 'utf8');
      return { ok: true, data: { content, filename, mime, path: filePath } };
    }

    case 'import': {
      const inputPath = args?.trim();
      if (!inputPath) return { ok: false, error: 'Usage: /import <path.jsonl>' };
      const abs = path.resolve(inputPath);
      const raw = await readFile(abs, 'utf8').catch(() => null);
      if (raw === null) return { ok: false, error: `Cannot read ${abs}` };
      const entries = sdk.parseSessionEntries(raw);
      if (!entries.some((e) => e.type === 'session')) {
        return { ok: false, error: `${abs} is not a valid pi session file` };
      }
      const header = entries.find((e) => e.type === 'session');
      const cwd = header?.cwd || NEW_CHAT_CWD;
      const dir = path.join(SESSIONS_ROOT, '--' + cwd.replace(/^\//, '').replaceAll('/', '-') + '--');
      const id = header?.id ?? `imported-${Date.now().toString(36)}`;
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = path.join(dir, `${ts}_${id}.jsonl`);
      await mkdir(dir, { recursive: true });
      await writeFile(dest, raw, 'utf8');
      emit({ type: 'refresh', file: dest });
      return { ok: true, data: { file: dest } };
    }

    case 'reload': {
      const live = await ensureSession(file);
      await live.session.reload().catch(() => {});
      emit({ type: 'refresh', file });
      return { ok: true, notice: 'Reloaded resources (skills, prompts, context files).' };
    }

    case 'changelog': {
      const changelogPath = path.join(sdkDir, 'CHANGELOG.md');
      const text = await readFile(changelogPath, 'utf8').catch(() => 'No CHANGELOG.md found.');
      return { ok: true, data: { text: text.slice(0, 12000) } };
    }

    default:
      return { ok: false, error: `Unknown slash command /${name}` };
  }
}

/** Create a new session file branched from `targetLeafId` and register it live. */
async function forkSession(live, targetLeafId) {
  const sm = live.session.sessionManager;
  const file = live.session.sessionFile;
  if (!file || !existsSync(file)) {
    throw new Error('This session has not been saved yet — send a message first.');
  }
  const forkedPath = sm.createBranchedSession(targetLeafId);
  if (!forkedPath) throw new Error('Failed to create forked session');
  const { session } = await sdk.createAgentSession({ sessionManager: sdk.SessionManager.open(forkedPath) });
  const forkedLive = { session, status: 'idle' };
  liveSessions.set(forkedPath, forkedLive);
  attachSession(forkedPath, forkedLive);
  return forkedPath;
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
      const files = [];
      for (const dirEntry of await readdir(SESSIONS_ROOT, { withFileTypes: true })) {
        if (!dirEntry.isDirectory()) continue;
        const dir = path.join(SESSIONS_ROOT, dirEntry.name);
        for (const f of await readdir(dir)) {
          if (f.endsWith('.jsonl')) files.push(path.join(dir, f));
        }
      }
      // Parallel parse (cache makes re-reads cheap; cold starts split across cores).
      const sessions = (await Promise.all(files.map((f) => analyzeSession(f)))).filter(Boolean);
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
      // their first message is appended — serve them as empty (live AND
      // still-pending lazy sessions).
      if (!existsSync(file) && (liveSessions.has(file) || pendingSessions.has(file))) {
        sendJson(res, 200, { file, name: null, cwd: NEW_CHAT_CWD, created: Date.now(), modified: Date.now(), messageCount: 0, userMessages: 0, firstMessage: '', preview: '', model: null, tokens: { input: 0, output: 0, total: 0 }, cost: 0, running: false, messages: [], oldestId: null, hasMore: false });
        return;
      }
      const info = await analyzeSession(file, { withMessages: true, limit, before, after });
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
      // Files we created/opened ourselves may not exist on disk yet
      // (session files are written on the first appended entry); pending
      // lazy new-chats don't exist until their first message arrives.
      if (!liveSessions.has(file) && !existsSync(file) && !pendingSessions.has(file)) {
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

    // ── Slash command catalog (builtins + skills for autocomplete) ──
    if (p === '/api/slash-commands' && req.method === 'GET') {
      const commands = BUILTIN_SLASH_COMMANDS.map((c) => ({
        name: c.name,
        description: c.description,
        argumentHint: c.argumentHint,
        available: !NA_COMMANDS[c.name],
        naReason: NA_COMMANDS[c.name],
      }));
      let skills = [];
      try {
        const result = sdk.loadSkills({
          cwd: NEW_CHAT_CWD,
          agentDir: sdk.getAgentDir(),
          skillPaths: [],
          includeDefaults: true,
        });
        skills = (result.skills ?? []).map((s) => ({ name: s.name, description: s.description ?? '' }));
      } catch { /* skills unavailable — autocomplete just omits them */ }
      sendJson(res, 200, { commands, skills });
      return;
    }

    // ── Execute a slash command ──
    if (p === '/api/slash' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const result = await handleSlashCommand(body);
        sendJson(res, result.ok ? 200 : 400, result);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
      }
      return;
    }

    // ── New chat ──
    if (p === '/api/new-chat' && req.method === 'POST') {
      const { cwd } = await readBody(req);
      const targetCwd = cwd || NEW_CHAT_CWD;
      // Lazy start: only reserve the future session file path. The real
      // agent session is created on the first message (see ensureSession).
      const file = newSessionPath(targetCwd);
      pendingSessions.set(file, { cwd: targetCwd, dir: path.dirname(file) });
      sendJson(res, 200, { file, cwd: targetCwd, virtual: true });
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

// ── External session file watcher ─────────────────────────────────────────
// Sessions written by OTHER processes (e.g. the pi TUI) produce no agent
// events here — poll file mtimes and emit refresh so open chat windows
// auto-update as entries land on disk.

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
        emit({ type: 'refresh', file });
      }
    }
  }
}

// First pass primes the map; afterwards every mtime change emits refresh.
void watchSessionFiles().then(() => {
  setInterval(watchSessionFiles, 2000);
});

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
