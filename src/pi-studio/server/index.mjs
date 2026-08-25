import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getHeapStatistics } from 'node:v8';
import { cronError } from '../../pi-nest/src/cron.mjs';
import { openJournal } from '../../pi-nest/src/journal.mjs';
import { createLocalClient } from '../../pi-nest/src/local-client.mjs';
import { AgentRegistry, WATCHDOG_INTERVAL_MS } from '../../pi-nest/src/registry.mjs';
import { computeNextDue, Scheduler } from '../../pi-nest/src/scheduler.mjs';
import { createSessionStates } from './session-states.mjs';

const PORT = Number(process.env.PI_STUDIO_PORT ?? 7494);
const HOST = process.env.PI_STUDIO_HOST ?? '127.0.0.1';
const NEW_CHAT_CWD = process.env.PI_STUDIO_CWD ?? '/workspace/sf';
const SESSIONS_ROOT = process.env.PI_STUDIO_SESSIONS ?? path.join(os.homedir(), '.pi', 'agent', 'sessions');
const DRAIN_MS = Number(process.env.PI_STUDIO_DRAIN_MS ?? 45_000);
const STATE_FALLBACK_DIR = path.join(os.homedir(), '.pi', 'agent');
const DB_PATH =
  process.env.PI_STUDIO_DB_PATH ??
  path.join(
    process.env.PI_STUDIO_SPILL_PATH ? path.dirname(process.env.PI_STUDIO_SPILL_PATH) : STATE_FALLBACK_DIR,
    'studio.db',
  );
const LEGACY_STATES_PATH =
  process.env.PI_STUDIO_STATES_PATH ?? path.join(STATE_FALLBACK_DIR, 'studio-session-states.json');
const RESUME_MODE =
  (process.env.PI_STUDIO_RESUME ?? 'on') === 'off' ? 'skip' : (process.env.PI_STUDIO_RESUME_MODE ?? 'nudge');

let registry = null;
let journal = null;
let client;
if (process.env.PI_STUDIO_CLIENT_MODULE) {
  const mod = await import(pathToFileURL(process.env.PI_STUDIO_CLIENT_MODULE).href);
  client = await mod.createClient();
} else {
  journal = openJournal(DB_PATH, {
    spillPath: process.env.PI_STUDIO_SPILL_PATH ?? null,
    legacyStatesPath: LEGACY_STATES_PATH,
  });
  registry = new AgentRegistry({ journal });
  client = createLocalClient(registry);
}

function parseEntries(content) {
  const out = [];
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {}
  }
  return out;
}

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

function imagesOf(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const block of content) {
    if (block?.type !== 'image') continue;
    const data = block.data ?? block.source?.data;
    const mimeType = block.mimeType ?? block.source?.mediaType;
    if (typeof data === 'string' && data && typeof mimeType === 'string') out.push({ data, mimeType });
  }
  return out;
}

function plainTextOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block.type === 'text' ? block.text : block.type === 'input_text' ? (block.text ?? '') : '',
      )
      .join('\n')
      .trim();
  }
  return '';
}

const IMAGE_CHARS = 4800;

function usageTokensOf(usage) {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function estimateEntryTokens(entry) {
  if (entry.type === 'compaction') return Math.ceil((entry.summary ?? '').length / 4);
  if (entry.type !== 'message') return 0;
  const msg = entry.message;
  if (!msg) return 0;
  let chars = 0;
  const content = msg.content;
  if (msg.role === 'assistant' && Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text') chars += block.text.length;
      else if (block.type === 'thinking') chars += block.thinking.length;
      else if (block.type === 'toolCall') chars += block.name.length + JSON.stringify(block.arguments).length;
    }
  } else if (typeof content === 'string') {
    chars = content.length;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text' || block.type === 'input_text') chars += block.text.length;
      else if (block.type === 'image') chars += IMAGE_CHARS;
    }
  }
  return Math.ceil(chars / 4);
}

function validAssistantUsage(entry) {
  if (entry.type !== 'message') return null;
  const m = entry.message;
  if (m?.role !== 'assistant' || m.stopReason === 'aborted' || m.stopReason === 'error') return null;
  return m.usage && usageTokensOf(m.usage) > 0 ? m.usage : null;
}

function addUsage(totals, usage) {
  totals.input += usage.input ?? 0;
  totals.output += usage.output ?? 0;
  totals.cacheRead += usage.cacheRead ?? 0;
  totals.cacheWrite += usage.cacheWrite ?? 0;
  totals.cost += usage.cost?.total ?? 0;
}

function deriveSessionStats(entries) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const breakdown = new Map();
  let totalMessages = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let prev = null;
  const waste = { missedTokens: 0, missedCost: 0, missCount: 0 };

  for (const entry of entries) {
    if (entry.type === 'compaction' || entry.type === 'branch_summary') {
      if (entry.usage) {
        addUsage(totals, entry.usage);
        addUsage(bucket(breakdown, 'Tools/summaries'), entry.usage);
      }
      prev = null;
      continue;
    }
    if (entry.type !== 'message') continue;
    const msg = entry.message;
    if (!msg) continue;
    totalMessages += 1;
    if (msg.role === 'user') {
      userMessages += 1;
    } else if (msg.role === 'toolResult') {
      toolResults += 1;
      if (msg.usage) {
        addUsage(totals, msg.usage);
        addUsage(bucket(breakdown, 'Tools/summaries'), msg.usage);
      }
    } else if (msg.role === 'assistant') {
      assistantMessages += 1;
      if (Array.isArray(msg.content)) {
        toolCalls += msg.content.filter((b) => b.type === 'toolCall').length;
      }
      if (msg.usage) {
        addUsage(totals, msg.usage);
        addUsage(bucket(breakdown, `${msg.provider}/${msg.responseModel ?? msg.model}`), msg.usage);
        const promptTokens = msg.usage.input + msg.usage.cacheRead + msg.usage.cacheWrite;
        if (
          prev &&
          promptTokens > 0 &&
          (msg.usage.cacheRead + msg.usage.cacheWrite > 0 || prev.reportedCache)
        ) {
          const missedTokens = Math.min(prev.promptTokens, promptTokens) - msg.usage.cacheRead;
          if (missedTokens > 1024) {
            const paidTokens = msg.usage.input + msg.usage.cacheWrite;
            const paidPerToken =
              paidTokens > 0
                ? ((msg.usage.cost?.input ?? 0) + (msg.usage.cost?.cacheWrite ?? 0)) / paidTokens
                : 0;
            const rate = modelCostRates.get(`${msg.provider}/${msg.model}`);
            const readPerToken =
              msg.usage.cacheRead > 0
                ? (msg.usage.cost?.cacheRead ?? 0) / msg.usage.cacheRead
                : (rate?.cacheRead ?? 0) / 1_000_000;
            waste.missedTokens += missedTokens;
            waste.missedCost += missedTokens * Math.max(0, paidPerToken - readPerToken);
            waste.missCount += 1;
          }
        }
        if (promptTokens > 0) {
          prev = {
            promptTokens,
            modelKey: `${msg.provider}/${msg.model}`,
            timestamp: entry.timestamp,
            reportedCache: (prev?.reportedCache ?? false) || msg.usage.cacheRead + msg.usage.cacheWrite > 0,
          };
        }
      }
    }
  }
  const prompt = totals.input + totals.cacheRead + totals.cacheWrite;
  const costBreakdown = Array.from(breakdown, ([key, t]) => ({
    key,
    cost: t.cost,
    tokens: t.input + t.output + t.cacheRead + t.cacheWrite,
  }))
    .filter((b) => b.cost > 0 || b.tokens > 0)
    .sort((a, b) => b.cost - a.cost);
  return {
    totalMessages,
    userMessages,
    assistantMessages,
    toolCalls,
    toolResults,
    tokens: {
      input: totals.input,
      output: totals.output,
      cacheRead: totals.cacheRead,
      cacheWrite: totals.cacheWrite,
      prompt,
      total: prompt + totals.output,
    },
    cost: totals.cost,
    costBreakdown,
    cacheWaste: waste,
  };
}

function bucket(map, key) {
  let t = map.get(key);
  if (!t) {
    t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    map.set(key, t);
  }
  return t;
}

function estimateContextTokens(chain) {
  let compIdx = -1;
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i].type === 'compaction') {
      compIdx = i;
      break;
    }
  }
  let ctx = chain;
  if (compIdx >= 0) {
    const comp = chain[compIdx];
    const kept = [];
    let found = false;
    for (let i = 0; i < compIdx; i++) {
      if (chain[i].id === comp.firstKeptEntryId) found = true;
      if (found) kept.push(chain[i]);
    }
    ctx = [comp, ...kept, ...chain.slice(compIdx + 1)];
  }
  if (compIdx >= 0) {
    let hasPost = false;
    for (let i = compIdx + 1; i < chain.length; i++) {
      if (validAssistantUsage(chain[i])) {
        hasPost = true;
        break;
      }
    }
    if (!hasPost) return null;
  }
  let anchor = -1;
  let anchorTokens = 0;
  for (let i = ctx.length - 1; i >= 0; i--) {
    const usage = validAssistantUsage(ctx[i]);
    if (usage) {
      anchor = i;
      anchorTokens = usageTokensOf(usage);
      break;
    }
  }
  let trailing = 0;
  for (let i = anchor + 1; i < ctx.length; i++) trailing += estimateEntryTokens(ctx[i]);
  return anchor >= 0 ? anchorTokens + trailing : trailing;
}

function toDisplayMessage(message) {
  const d = { role: message.role, text: '', ts: message.timestamp ?? Date.now() };
  if (message.role === 'assistant') {
    d.text = textOf(message.content);
    d.model = message.model ?? null;
    d.provider = message.provider ?? null;
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
    d.text = plainTextOf(message.content);
    const imgs = imagesOf(message.content);
    if (imgs.length) d.images = imgs;
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

function leafChain(entries) {
  if (entries.length === 0) return [];
  const byId = new Map();
  for (const e of entries) {
    if (e.id !== undefined) byId.set(e.id, e);
  }
  const chain = [];
  const seen = new Set();
  let cur = entries[entries.length - 1];
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  chain.reverse();
  const compactions = entries
    .filter((e) => e.type === 'compaction' && e.parentId !== undefined && !seen.has(e.id))
    .sort((a, b) => (Date.parse(a.timestamp) || 0) - (Date.parse(b.timestamp) || 0));
  for (const c of compactions) {
    const pos = chain.findIndex((e) => e.type !== 'compaction' && e.parentId === c.parentId);
    if (pos >= 0) chain.splice(pos, 0, c);
  }
  return chain;
}

const sessionParseCache = new Map();
const CACHE_MAX_BYTES = Number(process.env.PI_STUDIO_CACHE_MAX_BYTES ?? 128 * 1024 * 1024);

function cacheTotalBytes() {
  let total = 0;
  for (const c of sessionParseCache.values()) total += c.bytes ?? 0;
  return total;
}

function cacheTrim() {
  let total = cacheTotalBytes();
  while (total > CACHE_MAX_BYTES && sessionParseCache.size > 1) {
    const oldest = sessionParseCache.keys().next().value;
    const c = sessionParseCache.get(oldest);
    sessionParseCache.delete(oldest);
    total -= c?.bytes ?? 0;
  }
}

function deriveSession(entries, st) {
  const chain = leafChain(entries);
  const header = entries.find((e) => e.type === 'session');
  let name;
  let model = null;
  let thinkingLevel = null;
  let firstMessage = '';
  let lastText = '';
  const messages = [];

  const toolCallIndex = new Map();
  for (const entry of chain) {
    if (entry.type === 'session') continue;
    if (entry.type === 'session_info' && entry.name !== undefined) name = entry.name;
    if (entry.type === 'model_change') {
      if (!model) model = entry.modelId ?? null;
      continue;
    }
    if (entry.type === 'thinking_level_change') {
      thinkingLevel = entry.thinkingLevel ?? null;
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
    if (msg.role === 'user') {
      if (!firstMessage) firstMessage = plainTextOf(msg.content);
      lastText = plainTextOf(msg.content);
    }
    if (msg.role === 'assistant') {
      if (msg.model) model = msg.model;
      const t = textOf(msg.content);
      if (t) lastText = t;
    }
    const dm = toDisplayMessage(msg);
    dm.id = entry.id;
    if (msg.role === 'assistant') dm.thinkingLevel = thinkingLevel;
    messages.push(dm);
    if (dm.role === 'assistant' && dm.toolCalls) {
      for (const tc of dm.toolCalls) toolCallIndex.set(tc.id, messages.length - 1);
    }
  }
  for (const dm of messages) {
    if (dm.role === 'toolResult' && dm.toolCallId) {
      const idx = toolCallIndex.get(dm.toolCallId);
      if (idx !== undefined) {
        const tc = messages[idx].toolCalls?.find((t) => t.id === dm.toolCallId);
        if (tc) {
          tc.result = dm.text;
          tc.isError = dm.isError;
        }
        dm.merged = true;
      }
    }
  }
  const stats = deriveSessionStats(entries);
  return {
    base: {
      header,
      name,
      cwd: header?.cwd ?? '',
      created: header?.timestamp ? new Date(header.timestamp).getTime() : st.mtimeMs,
      messageCount: stats.totalMessages,
      userMessages: stats.userMessages,
      assistantMessages: stats.assistantMessages,
      toolCalls: stats.toolCalls,
      toolResults: stats.toolResults,
      firstMessage: firstMessage.slice(0, 200),
      preview: lastText.slice(0, 200),
      model,
      tokens: stats.tokens,
      cost: stats.cost,
      costBreakdown: stats.costBreakdown,
      cacheWaste: stats.cacheWaste,
      contextTokens: estimateContextTokens(chain),
    },
    merged: messages.filter((m) => m.role !== 'toolResult' || !m.merged),
  };
}

function readTail(file, start) {
  return new Promise((resolve, reject) => {
    let data = '';
    const rs = createReadStream(file, { start, encoding: 'utf8' });
    rs.on('data', (c) => {
      data += c;
    });
    rs.on('end', () => resolve(data));
    rs.on('error', reject);
  });
}

async function reloadSessionCache(file, st, cached) {
  if (cached && st.size > cached.size) {
    const appended = await readTail(file, cached.size).catch(() => null);
    if (appended !== null) {
      let chunk = (cached.pendingRaw ?? '') + appended;
      let pendingRaw = '';
      if (chunk && !chunk.endsWith('\n')) {
        const nl = chunk.lastIndexOf('\n');
        if (nl < 0) {
          pendingRaw = chunk;
          chunk = '';
        } else {
          pendingRaw = chunk.slice(nl + 1);
          chunk = chunk.slice(0, nl + 1);
        }
      }
      const newEntries = [];
      let boundaryOk = true;
      for (const line of chunk.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          newEntries.push(JSON.parse(t));
        } catch {
          boundaryOk = false;
          break;
        }
      }
      if (!boundaryOk) {
        const content = await readFile(file, 'utf8').catch(() => null);
        if (content === null) return null;
        const entries = parseEntries(content);
        return {
          mtime: st.mtimeMs,
          size: st.size,
          pendingRaw: '',
          bytes: Buffer.byteLength(content),
          entries,
          ...deriveSession(entries, st),
        };
      }
      const plausible = pendingRaw !== '' || newEntries.length > 0 || chunk.trim() === '';
      if (plausible) {
        const entries = [...cached.entries, ...newEntries];
        return {
          mtime: st.mtimeMs,
          size: st.size,
          pendingRaw,
          bytes: (cached.bytes ?? 0) + Buffer.byteLength(appended),
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
    bytes: Buffer.byteLength(content),
    entries,
    ...deriveSession(entries, st),
  };
}

async function analyzeSession(file, opts = {}) {
  const st = await stat(file).catch(() => null);
  if (!st) {
    sessionParseCache.delete(file);
    return null;
  }
  let cached = sessionParseCache.get(file);
  if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) {
    sessionParseCache.delete(file);
    sessionParseCache.set(file, cached);
  } else {
    cached = await reloadSessionCache(file, st, cached);
    if (!cached) return null;
    sessionParseCache.set(file, cached);
    cacheTrim();
  }
  const { base, merged: baseMerged } = cached;

  let merged = baseMerged;
  let oldestId = null;
  let hasMore = false;
  if (opts.after) {
    const idx = merged.findIndex((m) => m.id === opts.after);
    if (idx >= 0) merged = merged.slice(idx + 1);
    else if (/^(asst|user|pending|toolresult|msg)-/.test(opts.after)) merged = [];
  } else if (opts.limit || opts.before) {
    let end = merged.length;
    if (opts.before) {
      const idx = merged.findIndex((m) => m.id === opts.before);
      if (idx >= 0) end = idx;
    }
    let start = Math.max(0, end - (opts.limit ?? merged.length));
    while (start > 0 && (merged[start].role === 'assistant' || merged[start].role === 'bash')) {
      start--;
    }
    oldestId = start < merged.length ? merged[start].id : null;
    hasMore = start > 0;
    merged = merged.slice(start, end);
  }

  const modified = st ? st.mtimeMs : Date.now();
  const live = opts.states?.get(file);
  const running = live?.status === 'running';
  const runningSince = live?.runningSinceMs ?? null;

  const info = {
    file,
    id: base.header?.id ?? null,
    name: base.name ?? null,
    cwd: base.cwd,
    created: base.created,
    modified,
    messageCount: base.messageCount,
    userMessages: base.userMessages,
    assistantMessages: base.assistantMessages,
    toolCalls: base.toolCalls,
    toolResults: base.toolResults,
    firstMessage: base.firstMessage,
    preview: base.preview,
    model: base.model,
    tokens: base.tokens,
    cost: base.cost,
    costBreakdown: base.costBreakdown,
    cacheWaste: base.cacheWaste,
    running,
    runningSince,
    contextTokens: base.contextTokens,
  };
  if (opts.withMessages) {
    info.messages = merged;
    info.oldestId = oldestId;
    info.hasMore = hasMore;
  }
  return info;
}

let modelWindows = new Map();
let modelCostRates = new Map();
let modelCatalogAt = 0;
let modelCatalogBackoff = 0;
const MODEL_CATALOG_TTL_MS = 60 * 1000;

async function ensureModelCatalog() {
  if (Date.now() - modelCatalogAt <= MODEL_CATALOG_TTL_MS) return;
  if (modelCatalogAt === 0 && modelCatalogBackoff !== 0 && Date.now() - modelCatalogBackoff <= 5_000) return;
  try {
    const r = await client.slash({ agentId: '', command: '_models' });
    const data = r.dataJson ? JSON.parse(r.dataJson) : {};
    modelWindows = new Map();
    modelCostRates = new Map();
    for (const m of data.models ?? []) {
      modelWindows.set(m.id, m.contextWindow ?? 0);
      modelCostRates.set(`${m.provider}/${m.id}`, m.cost ?? {});
    }
    modelCatalogAt = Date.now();
  } catch {
    modelCatalogBackoff = Date.now();
  }
}

async function contextWindowOf(modelId) {
  if (!modelId) return 0;
  await ensureModelCatalog();
  return modelWindows.get(modelId) ?? 0;
}

async function withContext(info) {
  const tokens = info.contextTokens ?? null;
  const window = await contextWindowOf(info.model);
  info.context = {
    tokens,
    window,
    percent: tokens !== null && window > 0 ? (tokens / window) * 100 : null,
  };
  delete info.contextTokens;
  return info;
}

const TREE_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.cache',
  '.venv',
  '__pycache__',
  'coverage',
  'target',
]);
const TREE_MAX_DEPTH = 6;

async function sessionCwdCounts() {
  const counts = new Map();
  let dirs = [];
  try {
    dirs = await readdir(SESSIONS_ROOT, { withFileTypes: true });
  } catch {
    return counts;
  }
  for (const dirEntry of dirs) {
    if (!dirEntry.isDirectory()) continue;
    const dir = path.join(SESSIONS_ROOT, dirEntry.name);
    let files = [];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const info = await analyzeSession(path.join(dir, f));
      if (info?.cwd) counts.set(info.cwd, (counts.get(info.cwd) ?? 0) + 1);
    }
  }
  return counts;
}

async function buildTree(dir, depth, counts) {
  const node = { name: path.basename(dir), path: dir, count: 0, children: [] };
  if (depth < TREE_MAX_DEPTH) {
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {}
    for (const e of entries) {
      if (!e.isDirectory() || TREE_SKIP_DIRS.has(e.name)) continue;
      node.children.push(await buildTree(path.join(dir, e.name), depth + 1, counts));
    }
  }
  node.count = (counts.get(dir) ?? 0) + node.children.reduce((t, c) => t + c.count, 0);
  return node;
}

async function buildSessionTree() {
  return buildTree(NEW_CHAT_CWD, 0, await sessionCwdCounts());
}

const sessionStates = createSessionStates({
  persistPath:
    process.env.PI_STUDIO_STATES_PATH ?? path.join(STATE_FALLBACK_DIR, 'studio-session-states.json'),
  store: journal ? { load: () => journal.loadUiStates(), save: (list) => journal.saveUiStates(list) } : null,
  fileExists: existsSync,
  onSync: (ev) => emit(ev),
});
sessionStates.load();

async function resolveFileOutcome(file) {
  if (!existsSync(file)) return 'gone';
  try {
    const content = await readFile(file, 'utf8');
    const chain = leafChain(parseEntries(content));
    for (let i = chain.length - 1; i >= 0; i--) {
      const en = chain[i];
      if (en.type === 'message' && en.message?.role === 'assistant') {
        return en.message.stopReason === 'error' ? 'error' : 'ok';
      }
    }
    return 'ok';
  } catch {
    return 'gone';
  }
}

function syncViewState(file) {
  const viewers = viewersOf(file).length;
  sessionStates.noteViews(file, viewers);
  if (viewers === 0 && registry && !existsSync(file) && registry.pendingInfo(file)) {
    registry.close(file);
  }
}

const conns = new Map();
const sessionQueues = new Map();
const SSE_MAX_QUEUED_BYTES = Number(process.env.PI_STUDIO_SSE_MAX_QUEUED ?? 16 * 1024 * 1024);
const HEARTBEAT_INTERVAL_MS = Number(process.env.PI_STUDIO_HEARTBEAT_INTERVAL_MS ?? 5000);
const HEARTBEAT_MISSED_LIMIT = Number(process.env.PI_STUDIO_HEARTBEAT_MISSED_LIMIT ?? 12);
let connSeq = 0;
let nestOnline = false;
let draining = false;

function viewersOf(file) {
  const out = [];
  for (const conn of conns.values()) if (conn.views.has(file)) out.push(conn);
  return out;
}

function sessionKeyOf(event) {
  if (event.type === 'message') return event.message?.id ? `m\u0000${event.message.id}` : null;
  if (event.type === 'tool_partial' || event.type === 'tool_result')
    return event.toolCallId ? `tr\u0000${event.toolCallId}` : null;
  return null;
}

function globalKeyOf(event) {
  if (event.type === 'refresh') return `r\u0000${event.file}`;
  if (event.type === 'tree') return 'tree';
  if (event.type === 'session_status') return `s\u0000${event.file}`;
  if (event.type === 'session_state') return `st\u0000${event.file}`;
  return null;
}

function sessionQueueOf(file) {
  let q = sessionQueues.get(file);
  if (!q) {
    q = { items: [], folded: new Map(), bytes: 0 };
    sessionQueues.set(file, q);
  }
  return q;
}

function unlinkSessionItem(q, i) {
  const item = q.items[i];
  q.items.splice(i, 1);
  if (item.key) q.folded.delete(item.key);
  q.bytes -= item.data.length;
}

function maybeFreeSessionQueue(file) {
  const q = sessionQueues.get(file);
  if (q && q.items.length === 0) sessionQueues.delete(file);
}

function detachView(conn, file) {
  const q = sessionQueues.get(file);
  if (!q) return;
  for (let i = q.items.length - 1; i >= 0; i--) {
    q.items[i].pending.delete(conn.id);
    if (q.items[i].pending.size === 0) unlinkSessionItem(q, i);
  }
  maybeFreeSessionQueue(file);
}

function dropConn(id, reason, quiet = false) {
  const conn = conns.get(id);
  if (!conn) return;
  conns.delete(id);
  const views = [...conn.views];
  for (const file of views) detachView(conn, file);
  for (const file of views) syncViewState(file);
  try {
    conn.res.destroy();
  } catch {}
  if (!quiet) {
    console.error(`[gateway] SSE client ${id} dropped (${reason}) — EventSource reconnects and resyncs`);
  }
}

function makeConn(id, res) {
  const conn = {
    id,
    res,
    views: new Set(),
    missed: 0,
    flowing: true,
    queue: { items: [], folded: new Map(), bytes: 0 },
  };
  conn.send = (data) => {
    try {
      conn.flowing = res.write(data);
    } catch {
      dropConn(id, 'socket write failed');
      return false;
    }
    return conn.flowing;
  };
  conn.pump = () => {
    if (!conns.has(id) || !conn.flowing) return;
    while (conn.queue.items.length > 0) {
      const item = conn.queue.items.shift();
      conn.queue.bytes -= item.data.length;
      if (item.key) conn.queue.folded.delete(item.key);
      if (!conn.send(item.data)) return;
    }
    for (const file of conn.views) {
      const q = sessionQueues.get(file);
      if (!q) continue;
      for (let i = 0; i < q.items.length; i++) {
        const item = q.items[i];
        if (!item.pending.has(id)) continue;
        const ok = conn.send(item.data);
        item.pending.delete(id);
        if (item.pending.size === 0) {
          unlinkSessionItem(q, i);
          i--;
        }
        if (!ok) return;
      }
      maybeFreeSessionQueue(file);
    }
  };
  res.on('drain', () => {
    conn.flowing = true;
    conn.pump();
  });
  return conn;
}

function enqueue(q, key, data, pending) {
  const queued = key ? q.folded.get(key) : undefined;
  if (queued) {
    q.bytes += data.length - queued.data.length;
    queued.data = data;
    if (pending) queued.pending = pending;
  } else {
    const item = { key, data, pending };
    q.items.push(item);
    if (key) q.folded.set(key, item);
    q.bytes += data.length;
  }
}

function trimLaggards(q, file) {
  let guard = 0;
  while (q.bytes > SSE_MAX_QUEUED_BYTES && q.items.length > 0 && guard++ < 1000) {
    const item = q.items.find((it) => it.pending.size > 0);
    if (!item) return;
    const label = path.basename(file);
    for (const id of [...item.pending]) {
      dropConn(id, `lagging on ${label} — session queue at ${Math.round(q.bytes / 1048576)}MB`);
    }
  }
}

function emit(event) {
  if (conns.size === 0) return;
  const data = `data: ${JSON.stringify(event)}\n\n`;
  if (
    event.type === 'message' ||
    event.type === 'tool_start' ||
    event.type === 'tool_partial' ||
    event.type === 'tool_result'
  ) {
    const viewers = viewersOf(event.file);
    if (viewers.length === 0) return;
    const q = sessionQueueOf(event.file);
    enqueue(q, sessionKeyOf(event), data, new Set(viewers.map((c) => c.id)));
    if (q.bytes > SSE_MAX_QUEUED_BYTES) trimLaggards(q, event.file);
    for (const c of viewers) c.pump();
    return;
  }
  const key = globalKeyOf(event);
  for (const conn of conns.values()) {
    enqueue(conn.queue, key, data);
    if (conn.queue.bytes > SSE_MAX_QUEUED_BYTES) {
      dropConn(conn.id, `${Math.round(conn.queue.bytes / 1048576)}MB global queue not draining`);
      continue;
    }
    conn.pump();
  }
}

setInterval(() => {
  for (const conn of [...conns.values()]) {
    conn.missed += 1;
    if (conn.missed >= HEARTBEAT_MISSED_LIMIT) {
      dropConn(conn.id, `heartbeat stale — ${HEARTBEAT_MISSED_LIMIT} consecutive missed`);
    }
  }
}, HEARTBEAT_INTERVAL_MS);

const refreshTimers = new Map();
function emitRefresh(file) {
  const existing = refreshTimers.get(file);
  if (existing) clearTimeout(existing);
  refreshTimers.set(
    file,
    setTimeout(() => {
      refreshTimers.delete(file);
      emit({ type: 'refresh', file });
      scheduleTreePush();
    }, 250),
  );
}

let treeTimer = null;
function scheduleTreePush() {
  if (treeTimer) return;
  treeTimer = setTimeout(async () => {
    treeTimer = null;
    try {
      emit({ type: 'tree', tree: await buildSessionTree() });
    } catch {}
  }, 500);
}

function handleClientEvent(ev) {
  let payload = {};
  try {
    payload = ev.json ? JSON.parse(ev.json) : {};
  } catch {}
  if (ev.type === 'session_status') {
    if (payload.status === 'running') sessionStates.noteAgentRunning(ev.file);
    else if (payload.status === 'idle') sessionStates.noteAgentSettled(ev.file, { stale: !!payload.stale });
  } else if (ev.type === 'message' && payload?.role === 'assistant' && payload.stopReason) {
    sessionStates.noteAssistantOutcome(ev.file, payload.stopReason, payload.error ?? '');
  }
  if (ev.type === 'message') emit({ type: 'message', file: ev.file, message: payload });
  else if (ev.type === 'refresh') emitRefresh(ev.file);
  else emit({ type: ev.type, file: ev.file, ...payload });
}

function wireClientEvents() {
  const stream = client.subscribe('');
  stream.on('data', handleClientEvent);
  nestOnline = true;
  console.log('[backend] agent event stream wired');
}

async function bootReconcile() {
  try {
    const { states } = await client.listStates();
    for (const s of states) emitRefresh(s.agentId);
    scheduleTreePush();
  } catch {}
  await sessionStates.probeNest(() => client.listStates(), resolveFileOutcome);
  try {
    const { states } = await client.listStates();
    await sessionStates.reconcileNest(states, resolveFileOutcome, FILE_STALE_RUN_MS);
  } catch {}
}

let lastRecovery = null;
async function bootRecover() {
  if (!registry) return;
  try {
    lastRecovery = await registry.recover({ resumeMode: RESUME_MODE });
    const r = lastRecovery;
    if (r && (r.prefs || r.replayed || r.resumed || r.skipped)) {
      console.log(
        `[backend] journal recovery: prefs=${r.prefs} replayed=${r.replayed} resumed=${r.resumed} skipped=${r.skipped}`,
      );
    }
  } catch (e) {
    console.error('[backend] journal recovery failed:', e?.message ?? e);
  }
}

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
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function normalizeJobInput(body) {
  const out = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name || name.length > 200) return { error: 'name must be 1-200 characters' };
    out.name = name;
  }
  if (body.enabled !== undefined) out.enabled = !!body.enabled;
  if (body.scheduleType !== undefined) {
    if (body.scheduleType !== 'once' && body.scheduleType !== 'cron') {
      return { error: "scheduleType must be 'once' or 'cron'" };
    }
    out.scheduleType = body.scheduleType;
  }
  if (body.runAt !== undefined) {
    const runAt = Number(body.runAt);
    if (!Number.isFinite(runAt) || runAt <= 0)
      return { error: 'runAt must be a positive epoch-ms timestamp' };
    out.runAt = Math.round(runAt);
  }
  if (body.cron !== undefined) {
    const cron = String(body.cron).trim();
    const err = cronError(cron);
    if (err) return { error: `invalid cron expression: ${err}` };
    out.cron = cron;
  }
  if (body.message !== undefined) {
    const message = String(body.message);
    if (!message.trim() || message.length > 100_000) return { error: 'message must be 1-100000 characters' };
    out.message = message;
  }
  if (body.targetMode !== undefined) {
    if (!['file', 'new', 'reuse'].includes(body.targetMode)) {
      return { error: "targetMode must be 'file', 'new' or 'reuse'" };
    }
    out.targetMode = body.targetMode;
  }
  if (body.sessionFile !== undefined) {
    if (typeof body.sessionFile !== 'string' || !body.sessionFile)
      return { error: 'sessionFile must be a path' };
    out.sessionFile = body.sessionFile;
  }
  if (body.cwd !== undefined) {
    if (typeof body.cwd !== 'string' || !body.cwd) return { error: 'cwd must be a path' };
    out.cwd = body.cwd;
  }
  if (body.model !== undefined) out.model = body.model === null ? null : String(body.model);
  if (body.thinkLevel !== undefined)
    out.thinkLevel = body.thinkLevel === null ? null : String(body.thinkLevel);
  if (body.missedPolicy !== undefined) {
    if (body.missedPolicy !== 'coalesce' && body.missedPolicy !== 'skip') {
      return { error: "missedPolicy must be 'coalesce' or 'skip'" };
    }
    out.missedPolicy = body.missedPolicy;
  }
  if (body.createdBy !== undefined) out.createdBy = String(body.createdBy).slice(0, 100);
  return { value: out };
}

function validateJob(job) {
  if (!job.name) return 'name is required';
  if (job.scheduleType === 'once') {
    if (!job.runAt) return 'runAt is required for once jobs';
  } else if (job.scheduleType === 'cron') {
    if (!job.cron) return 'cron is required for cron jobs';
  } else {
    return 'scheduleType is required';
  }
  const payload = job.payload ?? {};
  if (!payload.message || !String(payload.message).trim()) return 'message is required';
  const target = payload.target ?? {};
  if (target.mode === 'file') {
    if (!target.sessionFile || !existsSync(target.sessionFile)) {
      return 'target session file not found';
    }
  } else if (target.mode === 'new' || target.mode === 'reuse') {
    if (!target.cwd) return 'target cwd is required';
    let st = null;
    try {
      st = statSync(target.cwd);
    } catch {}
    if (!st?.isDirectory()) return 'target cwd is not a directory';
  } else {
    return 'target mode is required';
  }
  return null;
}

function payloadFromInput(input) {
  const payload = {};
  if (input.message !== undefined) payload.message = input.message;
  if (input.targetMode !== undefined || input.sessionFile !== undefined || input.cwd !== undefined) {
    const target = {};
    if (input.targetMode !== undefined) target.mode = input.targetMode;
    if (input.sessionFile !== undefined) target.sessionFile = input.sessionFile;
    if (input.cwd !== undefined) target.cwd = input.cwd;
    payload.target = target;
  }
  if (input.model !== undefined) payload.model = input.model;
  if (input.thinkLevel !== undefined) payload.thinkLevel = input.thinkLevel;
  return payload;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (draining && req.method === 'POST' && p !== '/api/events/heartbeat') {
      return sendJson(res, 503, { ok: false, error: 'backend is draining for restart' });
    }
    if (p === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      const id = `sse-${++connSeq}`;
      const conn = makeConn(id, res);
      conns.set(id, conn);
      res.write(`event: ready\ndata: ${JSON.stringify({ clientId: id })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'session_states', states: sessionStates.snapshot() })}\n\n`);
      req.on('close', () => dropConn(id, 'connection closed', true));
      return;
    }

    if (p.startsWith('/api/events/') && req.method === 'POST') {
      const action = p.slice('/api/events/'.length);
      if (action !== 'heartbeat' && action !== 'open' && action !== 'close' && action !== 'visit') {
        return sendJson(res, 404, { ok: false, error: 'not found' });
      }
      const body = await readBody(req);
      const conn = conns.get(String(body.clientId ?? ''));
      if (!conn) return sendJson(res, 404, { ok: false, error: 'unknown clientId' });
      conn.missed = 0;
      const files = Array.isArray(body.files)
        ? body.files.filter((f) => typeof f === 'string').slice(0, 64)
        : [];
      if (action === 'heartbeat') {
        const next = new Set(files);
        const changed = [];
        for (const prev of conn.views) {
          if (!next.has(prev)) {
            conn.views.delete(prev);
            detachView(conn, prev);
            changed.push(prev);
          }
        }
        for (const file of next) {
          if (!conn.views.has(file)) changed.push(file);
          conn.views.add(file);
        }
        for (const file of changed) syncViewState(file);
        conn.pump();
        sendJson(res, 200, { ok: true, nest: nestOnline });
        return;
      }
      if (action === 'visit') {
        const file = typeof body.file === 'string' ? body.file : '';
        if (file) sessionStates.noteVisit(file);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (action === 'open') {
        for (const file of files) {
          conn.views.add(file);
          syncViewState(file);
        }
        conn.pump();
        sendJson(res, 200, { ok: true });
        return;
      }
      for (const file of files) {
        conn.views.delete(file);
        detachView(conn, file);
        syncViewState(file);
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (p === '/api/sessions' && req.method === 'GET') {
      const files = [];
      for (const dirEntry of await readdir(SESSIONS_ROOT, { withFileTypes: true })) {
        if (!dirEntry.isDirectory()) continue;
        const dir = path.join(SESSIONS_ROOT, dirEntry.name);
        for (const f of await readdir(dir)) {
          if (f.endsWith('.jsonl')) files.push(path.join(dir, f));
        }
      }
      const nestStates = (await client.listStates().catch(() => ({ states: [] }))).states ?? [];
      await sessionStates.reconcileNest(nestStates, resolveFileOutcome, FILE_STALE_RUN_MS);
      const states = new Map(nestStates.map((s) => [s.agentId, s]));
      await ensureModelCatalog();
      const sessions = (await Promise.all(files.map((f) => analyzeSession(f, { states })))).filter(Boolean);
      sessions.sort((a, b) => b.modified - a.modified);
      for (const s of sessions) {
        s.state = sessionStates.stateOf(s.file);
        s.stateError = sessionStates.errorOf(s.file);
      }
      sendJson(res, 200, { sessions: await Promise.all(sessions.map(withContext)) });
      return;
    }

    if (p === '/api/sessions/messages' && req.method === 'GET') {
      const file = url.searchParams.get('file');
      if (!file) return sendJson(res, 400, { error: 'missing file' });
      const limit = Number(url.searchParams.get('limit')) || undefined;
      const before = url.searchParams.get('before') || undefined;
      const after = url.searchParams.get('after') || undefined;
      if (!existsSync(file)) {
        const st = await client.getAgentState({ agentId: file }).catch(() => null);
        if (st?.state?.status) {
          sendJson(res, 200, {
            file,
            name: null,
            cwd: NEW_CHAT_CWD,
            created: Date.now(),
            modified: Date.now(),
            messageCount: 0,
            userMessages: 0,
            assistantMessages: 0,
            toolCalls: 0,
            toolResults: 0,
            firstMessage: '',
            preview: '',
            model: null,
            tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, prompt: 0, total: 0 },
            cost: 0,
            costBreakdown: [],
            cacheWaste: { missedTokens: 0, missedCost: 0, missCount: 0 },
            running: st.state.status === 'running',
            state: sessionStates.stateOf(file),
            stateError: sessionStates.errorOf(file),
            context: { tokens: null, window: 0, percent: null },
            messages: [],
            oldestId: null,
            hasMore: false,
          });
          return;
        }
        return sendJson(res, 404, { error: 'session file not found' });
      }
      const info = await analyzeSession(file, { withMessages: true, limit, before, after });
      if (!info) return sendJson(res, 404, { error: 'session file not found' });
      info.state = sessionStates.stateOf(file);
      info.stateError = sessionStates.errorOf(file);
      sendJson(res, 200, await withContext(info));
      return;
    }

    if (p === '/api/chat' && req.method === 'POST') {
      const { file, message, wait, reqId, images } = await readBody(req);
      if (!file || typeof message !== 'string') {
        return sendJson(res, 400, { error: 'file and message required' });
      }
      let attachments = [];
      if (images !== undefined) {
        if (!Array.isArray(images) || images.length > 4) {
          return sendJson(res, 400, { error: 'images must be an array of at most 4 attachments' });
        }
        let totalBytes = 0;
        for (const im of images) {
          if (!im || typeof im.data !== 'string' || typeof im.mimeType !== 'string') {
            return sendJson(res, 400, { error: 'each image needs { mimeType, data }' });
          }
          if (!/^image\//.test(im.mimeType)) {
            return sendJson(res, 400, { error: 'only image/* attachments are allowed' });
          }
          totalBytes += im.data.length;
        }
        if (totalBytes > 8 * 1024 * 1024) {
          return sendJson(res, 400, { error: 'attached images exceed 8 MB (base64)' });
        }
        attachments = images;
      }
      if (!message.trim() && !attachments.length) {
        return sendJson(res, 400, { error: 'file and message required' });
      }
      const st = await client.getAgentState({ agentId: file }).catch(() => null);
      if (!st?.state?.status && !existsSync(file)) {
        return sendJson(res, 404, { error: 'session file not found' });
      }
      let interrupt = !wait;
      let text = message;
      const waitMatch = message.match(/^\/wait\b\s*([\s\S]*)$/);
      if (waitMatch) {
        interrupt = false;
        text = (waitMatch[1] ?? '').trim();
        if (!text) return sendJson(res, 400, { error: '/wait needs a message: /wait <message>' });
      }
      sessionStates.notePrompt(file);
      await client.prompt({
        agentId: file,
        message: text,
        interrupt,
        reqId: reqId ?? '',
        images: attachments,
      });
      sendJson(res, 200, { ok: true });
      return;
    }

    if (p === '/api/slash-commands' && req.method === 'GET') {
      const r = await client.getSlashCatalog({});
      const commands = r.commandsJson ? JSON.parse(r.commandsJson) : [];
      const skills = r.skillsJson ? JSON.parse(r.skillsJson) : [];
      sendJson(res, 200, { commands, skills });
      return;
    }

    if (p === '/api/slash' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.command === 'delete' && body.file && !sessionStates.canDelete(body.file)) {
        return sendJson(res, 400, {
          ok: false,
          error: 'Session is open in a window — close its window everywhere before deleting',
        });
      }
      try {
        const r = await client.slash({
          agentId: body.file ?? '',
          command: body.command,
          args: body.args ?? '',
          extra: body.extra ?? {},
          reqId: body.reqId ?? '',
        });
        if (body.command === 'delete' && body.file && r.ok) sessionStates.remove(body.file);
        const out = { ok: r.ok, notice: r.notice || undefined, error: r.error || undefined };
        if (r.dataJson) out.data = JSON.parse(r.dataJson);
        sendJson(res, r.ok ? 200 : 400, out);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
      }
      return;
    }

    if (p === '/api/new-chat' && req.method === 'POST') {
      const { cwd } = await readBody(req);
      const targetCwd = cwd || NEW_CHAT_CWD;
      const { file } = await client.createSession({ cwd: targetCwd });
      sendJson(res, 200, { file, cwd: targetCwd, virtual: true });
      return;
    }

    if (p === '/api/abort' && req.method === 'POST') {
      const { file } = await readBody(req);
      await client.abort({ agentId: file });
      sendJson(res, 200, { ok: true });
      return;
    }

    if (p === '/api/jobs' && req.method === 'GET') {
      if (!journal) return sendJson(res, 503, { error: 'scheduler unavailable (stub client mode)' });
      sendJson(res, 200, { jobs: journal.listJobs().map((j) => ({ ...j, lastRun: journal.lastRun(j.id) })) });
      return;
    }

    if (p === '/api/jobs' && req.method === 'POST') {
      if (!journal || !scheduler)
        return sendJson(res, 503, { error: 'scheduler unavailable (stub client mode)' });
      const body = await readBody(req);
      const { value: input, error: normErr } = normalizeJobInput(body);
      if (normErr) return sendJson(res, 400, { error: normErr });
      const now = Date.now();
      const payload = payloadFromInput(input);
      const job = {
        id: randomUUID().slice(0, 8),
        name: input.name,
        enabled: input.enabled ?? true,
        kind: 'message',
        scheduleType: input.scheduleType,
        runAt: input.runAt ?? null,
        cron: input.cron ?? null,
        payload,
        nextDue: 0,
        missedPolicy: input.missedPolicy ?? 'coalesce',
        createdBy: input.createdBy ?? '',
        createdAt: now,
        updatedAt: now,
      };
      const invalid = validateJob(job);
      if (invalid) return sendJson(res, 400, { error: invalid });
      const nextDue = computeNextDue(job, now);
      if (nextDue === null) return sendJson(res, 400, { error: 'schedule never matches within a year' });
      job.nextDue = nextDue;
      const stored = journal.insertJob(job);
      if (!stored) return sendJson(res, 500, { error: 'failed to persist job' });
      scheduler.reschedule();
      emit({
        type: 'job_event',
        action: 'created',
        jobId: stored.id,
        runId: null,
        error: '',
        sessionFile: '',
      });
      sendJson(res, 201, { job: { ...stored, lastRun: null } });
      return;
    }

    if (p.startsWith('/api/jobs/') && req.method === 'PATCH') {
      if (!journal || !scheduler)
        return sendJson(res, 503, { error: 'scheduler unavailable (stub client mode)' });
      const jobId = decodeURIComponent(p.slice('/api/jobs/'.length));
      const existing = journal.getJob(jobId);
      if (!existing) return sendJson(res, 404, { error: 'job not found' });
      const body = await readBody(req);
      const { value: input, error: normErr } = normalizeJobInput(body);
      if (normErr) return sendJson(res, 400, { error: normErr });
      const mergedPayload = payloadFromInput(input);
      const payload = { ...existing.payload };
      if (mergedPayload.target) payload.target = { ...existing.payload?.target, ...mergedPayload.target };
      for (const key of ['message', 'model', 'thinkLevel']) {
        if (mergedPayload[key] !== undefined) payload[key] = mergedPayload[key];
      }
      const job = {
        ...existing,
        name: input.name ?? existing.name,
        enabled: input.enabled ?? existing.enabled,
        scheduleType: input.scheduleType ?? existing.scheduleType,
        runAt: input.runAt ?? existing.runAt,
        cron: input.cron ?? existing.cron,
        payload,
        missedPolicy: input.missedPolicy ?? existing.missedPolicy,
      };
      const invalid = validateJob(job);
      if (invalid) return sendJson(res, 400, { error: invalid });
      const scheduleChanged =
        job.scheduleType !== existing.scheduleType ||
        job.runAt !== existing.runAt ||
        job.cron !== existing.cron ||
        job.enabled !== existing.enabled;
      if (scheduleChanged) {
        const nextDue = computeNextDue(job, Date.now());
        if (nextDue === null) return sendJson(res, 400, { error: 'schedule never matches within a year' });
        job.nextDue = nextDue;
      }
      const stored = journal.updateJob(job);
      if (!stored) return sendJson(res, 500, { error: 'failed to persist job' });
      scheduler.reschedule();
      emit({
        type: 'job_event',
        action: 'updated',
        jobId: stored.id,
        runId: null,
        error: '',
        sessionFile: '',
      });
      sendJson(res, 200, { job: { ...stored, lastRun: journal.lastRun(stored.id) } });
      return;
    }

    if (p.startsWith('/api/jobs/') && req.method === 'DELETE') {
      if (!journal) return sendJson(res, 503, { error: 'scheduler unavailable (stub client mode)' });
      const jobId = decodeURIComponent(p.slice('/api/jobs/'.length));
      const existing = journal.getJob(jobId);
      if (!existing) return sendJson(res, 404, { error: 'job not found' });
      journal.deleteJob(jobId);
      scheduler?.reschedule();
      emit({ type: 'job_event', action: 'deleted', jobId, runId: null, error: '', sessionFile: '' });
      sendJson(res, 200, { ok: true });
      return;
    }

    if (p.startsWith('/api/jobs/') && p.endsWith('/run') && req.method === 'POST') {
      if (!journal || !scheduler)
        return sendJson(res, 503, { error: 'scheduler unavailable (stub client mode)' });
      const jobId = decodeURIComponent(p.slice('/api/jobs/'.length, p.length - '/run'.length));
      const existing = journal.getJob(jobId);
      if (!existing) return sendJson(res, 404, { error: 'job not found' });
      const target = existing.payload?.target ?? {};
      if (target.mode === 'file' && !existsSync(target.sessionFile)) {
        return sendJson(res, 400, { error: 'target session file not found' });
      }
      const result = await scheduler.runNow(jobId);
      sendJson(
        res,
        result.ok ? 200 : 500,
        result.ok ? { ok: true, runId: result.runId } : { error: result.error },
      );
      return;
    }

    if (p.startsWith('/api/jobs/') && p.endsWith('/runs') && req.method === 'GET') {
      if (!journal) return sendJson(res, 503, { error: 'scheduler unavailable (stub client mode)' });
      const jobId = decodeURIComponent(p.slice('/api/jobs/'.length, p.length - '/runs'.length));
      if (!journal.getJob(jobId)) return sendJson(res, 404, { error: 'job not found' });
      const n = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50));
      sendJson(res, 200, { runs: journal.listRuns(jobId, n) });
      return;
    }

    if (p === '/api/agent-states' && req.method === 'GET') {
      const { states } = await client.listStates();
      sendJson(res, 200, { states });
      return;
    }

    if (p === '/api/health') {
      const s = memorySnapshot();
      sendJson(res, 200, {
        ok: true,
        nest: true,
        draining,
        journal: { pending: journal?.pendingCount() ?? 0, recovery: lastRecovery },
        mem: {
          rss: s.rss,
          heapUsed: s.heapUsed,
          heapLimit: s.heapLimit,
          external: s.external,
          arrayBuffers: s.arrayBuffers,
        },
        cache: {
          files: s.cacheFileCount,
          entries: s.cacheEntryCount,
          bytes: s.cacheBytes,
          heaviest: s.heaviestFiles,
        },
        sseClients: s.sseClients,
        sseQueued: s.sseQueued,
        sseViews: s.sseViews,
        refreshTimers: s.refreshTimers,
      });
      return;
    }

    if (p === '/api/tree' && req.method === 'GET') {
      sendJson(res, 200, await buildSessionTree());
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('handler error:', e);
    sendJson(res, 500, { error: String(e?.message ?? e) });
  }
});

const MB = 1024 * 1024;
function fmtBytes(n) {
  return n >= MB ? `${(n / MB).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`;
}

function memorySnapshot() {
  const mu = process.memoryUsage();
  const hs = getHeapStatistics();
  let cacheFileCount = 0;
  let cacheEntryCount = 0;
  let cacheBytes = 0;
  const files = [];
  for (const [file, c] of sessionParseCache) {
    cacheFileCount++;
    cacheEntryCount += c.entries.length;
    cacheBytes += c.bytes ?? 0;
    files.push({ file, bytes: c.bytes ?? 0, entries: c.entries.length });
  }
  files.sort((a, b) => b.bytes - a.bytes);
  let sseQueued = 0;
  let sseViews = 0;
  for (const conn of conns.values()) {
    sseQueued += conn.queue.bytes;
    sseViews += conn.views.size;
  }
  for (const q of sessionQueues.values()) sseQueued += q.bytes;
  return {
    rss: mu.rss,
    heapUsed: mu.heapUsed,
    heapLimit: hs.heap_size_limit,
    external: mu.external,
    arrayBuffers: mu.arrayBuffers,
    cacheFileCount,
    cacheEntryCount,
    cacheBytes,
    sseClients: conns.size,
    sseQueued,
    sseViews,
    refreshTimers: refreshTimers.size,
    modelWindows: modelWindows.size,
    heaviestFiles: files.slice(0, 5).map((f) => ({
      file: `${path.basename(path.dirname(f.file))}/${path.basename(f.file)}`,
      bytes: f.bytes,
      entries: f.entries,
    })),
  };
}

function logMemoryState(label) {
  const s = memorySnapshot();
  const heapPct = Math.round((s.heapUsed / s.heapLimit) * 100);
  const rssPct = Math.round((s.rss / os.totalmem()) * 100);
  const line =
    `[mem:${label}] rss=${fmtBytes(s.rss)} (${rssPct}%) ` +
    `heap=${fmtBytes(s.heapUsed)}/${fmtBytes(s.heapLimit)} (${heapPct}%) ` +
    `ext=${fmtBytes(s.external)} arrBuf=${fmtBytes(s.arrayBuffers)} ` +
    `cacheFiles=${s.cacheFileCount} cacheEntries=${s.cacheEntryCount} ` +
    `cacheBytes=${fmtBytes(s.cacheBytes)} sse=${s.sseClients}/${s.sseViews}v sseQ=${fmtBytes(s.sseQueued)} ` +
    `refreshTimers=${s.refreshTimers} catalog=${s.modelWindows}`;
  if (heapPct >= 85 || rssPct >= 80) {
    console.error(
      `${line}\n  WARNING: heap/RSS near ceiling — heaviest cached sessions:` +
        s.heaviestFiles.map((f) => `\n    ${f.file} ${fmtBytes(f.bytes)} (${f.entries} entries)`).join(''),
    );
  } else {
    console.log(line);
  }
}

setInterval(() => logMemoryState('tick'), 60_000);

async function shutdownGracefully(sig) {
  if (draining) return;
  draining = true;
  const t0 = Date.now();
  console.log(`[backend] received ${sig} — draining (grace ${DRAIN_MS}ms)`);
  server.close(() => {});
  try {
    if (registry) {
      const r = await registry.drain({ timeoutMs: DRAIN_MS });
      if (r && (r.queued || r.interrupted)) {
        console.log(
          `[backend] ${r.queued} queued + ${r.interrupted} interrupted prompt(s) durable in the journal`,
        );
      }
    }
    sessionStates.flush();
    journal?.close();
  } catch (e) {
    console.error('[backend] drain error:', e?.message ?? e);
  }
  console.log(`[backend] drain complete in ${Date.now() - t0}ms — exiting`);
  process.exit(0);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => void shutdownGracefully(sig));
}

const _ssePing = setInterval(() => {
  for (const conn of conns.values()) {
    try {
      conn.res.write(': ping\n\n');
    } catch {}
  }
}, 15000);

const fileMtimes = new Map();
const fileParsedBytes = new Map();
const FILE_FRESH_MS = 15_000;
const FILE_STALE_RUN_MS = 30 * 60_000;
const TERMINAL_STOP_REASONS = new Set(['stop', 'length', 'error', 'aborted']);

function applyFileEntries(file, newEntries) {
  let lastMessage = null;
  for (const en of newEntries) {
    if (en.type !== 'message' || !en.message) continue;
    const role = en.message.role;
    const at = Date.parse(en.timestamp);
    if (role === 'assistant') {
      if (TERMINAL_STOP_REASONS.has(en.message.stopReason)) {
        lastMessage = { terminal: true, isError: en.message.stopReason === 'error', message: en.message };
      } else {
        lastMessage = { terminal: false };
        sessionStates.noteFileRunStart(file, Number.isNaN(at) ? undefined : at);
      }
    } else if (role === 'user' || role === 'toolResult') {
      lastMessage = { terminal: false };
      sessionStates.noteFileRunStart(file, Number.isNaN(at) ? undefined : at);
    }
  }
  if (lastMessage?.terminal) {
    sessionStates.noteFileTerminal(file, lastMessage.isError, lastMessage.message.errorMessage ?? '');
  } else if (lastMessage) {
    sessionStates.noteFileActivity(file);
  }
}

async function trackFileGrowth(file, st, known) {
  if (!known) {
    if (st.mtimeMs > Date.now() - FILE_FRESH_MS) fileParsedBytes.set(file, 0);
    else {
      fileParsedBytes.set(file, st.size);
      return;
    }
  }
  const prev = fileParsedBytes.get(file) ?? 0;
  if (st.size <= prev) {
    fileParsedBytes.set(file, st.size);
    return;
  }
  const appended = await readTail(file, prev).catch(() => null);
  if (appended === null) {
    fileParsedBytes.set(file, st.size);
    return;
  }
  const nl = appended.lastIndexOf('\n');
  if (nl < 0) return;
  const complete = appended.slice(0, nl + 1);
  fileParsedBytes.set(file, prev + Buffer.byteLength(complete));
  const newEntries = parseEntries(complete);
  if (newEntries.length > 0) applyFileEntries(file, newEntries);
}

async function watchSessionFiles() {
  for (const file of sessionStates.files()) {
    if (!existsSync(file)) sessionStates.remove(file);
  }
  sessionStates.sweepStaleFileRuns(FILE_STALE_RUN_MS);
  let dirs = [];
  try {
    dirs = await readdir(SESSIONS_ROOT, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dirEntry of dirs) {
    if (!dirEntry.isDirectory()) continue;
    const dir = path.join(SESSIONS_ROOT, dirEntry.name);
    let files = [];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
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
        await trackFileGrowth(file, st, known);
      } else if (!fileParsedBytes.has(file)) {
        fileParsedBytes.set(file, st.size);
      }
    }
  }
}

if (registry) setInterval(() => registry.scanStaleRuns(), WATCHDOG_INTERVAL_MS).unref();

let scheduler = null;
if (journal && registry) {
  scheduler = new Scheduler({
    journal,
    registry,
    onEvent: ({ action, job, runId, error, sessionFile }) => {
      emit({ type: 'job_event', action, jobId: job?.id ?? '', runId: runId ?? null, error, sessionFile });
    },
  });
  scheduler.start();
}

void watchSessionFiles().then(() => {
  setInterval(watchSessionFiles, 2000);
});

server.listen(PORT, HOST, () => {
  logMemoryState('boot');
  wireClientEvents();
  void bootReconcile();
  void bootRecover();
  console.log(`pi-agent-studio backend on ${HOST}:${PORT}`);
  console.log(`sessions: ${SESSIONS_ROOT}`);
  console.log(`new chats cwd: ${NEW_CHAT_CWD}`);
});
