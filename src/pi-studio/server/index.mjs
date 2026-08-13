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

import { createReadStream, existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
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
    try {
      out.push(JSON.parse(t));
    } catch {
      /* skip malformed line */
    }
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

// ── Context-window usage (mirror of the SDK's estimate) ───────────────────
// The pi TUI footer's "12.3%/1M" comes from session.getContextUsage(): the
// compaction-aware message set (latest compaction summary + its kept tail +
// everything after) is anchored on the LAST valid assistant usage, with
// char-estimates for whatever follows it. After a compaction with no
// post-compaction assistant usage yet, the count is UNKNOWN (the TUI shows
// "?/1M") until the next LLM response. Same math here, over the file.

const IMAGE_CHARS = 4800;

function usageTokensOf(usage) {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** Char-based token estimate of one session entry (SDK estimateTokens). */
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

/** The assistant usage the SDK trusts (skip aborted/error/all-zero). */
function validAssistantUsage(entry) {
  if (entry.type !== 'message') return null;
  const m = entry.message;
  if (m?.role !== 'assistant' || m.stopReason === 'aborted' || m.stopReason === 'error') return null;
  return m.usage && usageTokensOf(m.usage) > 0 ? m.usage : null;
}

// ── Session stats (TUI /session parity) ───────────────────────────────────
// Mirrors agent-session.getSessionStats() + usage-totals.getUsageCostBreakdown()
// + cache-stats.computeCacheWaste() over the parsed chain, so the right panel
// shows exactly what the TUI's /session prints.

/** Per-message usage sums (SDK createUsageTotals/addUsageToTotals). */
function addUsage(totals, usage) {
  totals.input += usage.input ?? 0;
  totals.output += usage.output ?? 0;
  totals.cacheRead += usage.cacheRead ?? 0;
  totals.cacheWrite += usage.cacheWrite ?? 0;
  totals.cost += usage.cost?.total ?? 0;
}

/**
 * Full stat derivation over ALL parsed entries in file order (TUI /session
 * parity): the SDK's getSessionStats + getUsageCostBreakdown scan
 * getEntries() — every line of the file, not just the active branch — so
 * entries outside the leaf chain (retry siblings, ...) still count.
 *
 *  - message counts (total/user/assistant/tool calls/tool results)
 *  - token + cost totals incl. cache buckets and compaction usage
 *  - per-model cost breakdown ("provider/model" vs "Tools/summaries")
 *  - cache waste (prompt tokens re-billed as fresh after a miss)
 */
function deriveSessionStats(entries) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const breakdown = new Map(); // key → totals
  let totalMessages = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let toolResults = 0;
  // cache-stats scan state (detectMiss/asPreviousRequest replica).
  let prev = null;
  const waste = { missedTokens: 0, missedCost: 0, missCount: 0 };

  for (const entry of entries) {
    if (entry.type === 'compaction' || entry.type === 'branch_summary') {
      if (entry.usage) {
        addUsage(totals, entry.usage);
        addUsage(bucket(breakdown, 'Tools/summaries'), entry.usage);
      }
      // The context legitimately changed; the next turn's prompt is new
      // content, not re-billed content.
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
        // Cache-miss detection for this turn (cache-stats.detectMiss).
        const promptTokens = msg.usage.input + msg.usage.cacheRead + msg.usage.cacheWrite;
        if (
          prev &&
          promptTokens > 0 &&
          (msg.usage.cacheRead + msg.usage.cacheWrite > 0 || prev.reportedCache)
        ) {
          const missedTokens = Math.min(prev.promptTokens, promptTokens) - msg.usage.cacheRead;
          if (missedTokens > 1024) {
            // NOISE_FLOOR_TOKENS
            // Extra cost = missed tokens billed at the paid rate (input/cacheWrite)
            // instead of the cache-read rate.
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

/** Get (or create) the cost-breakdown bucket for a model key. */
function bucket(map, key) {
  let t = map.get(key);
  if (!t) {
    t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    map.set(key, t);
  }
  return t;
}

/** Context-token estimate over a leaf chain, or null when unknown (the
 *  "?" state right after a compaction). */
function estimateContextTokens(chain) {
  let compIdx = -1;
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i].type === 'compaction') {
      compIdx = i;
      break;
    }
  }
  // The message set the SDK would feed the LLM (buildContextEntries):
  // compaction summary + kept tail (firstKeptEntryId … compaction) + every
  // entry after it. Without a compaction: the whole chain.
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
    // No assistant usage after the compaction yet → unknown until the
    // next response (TUI "?/window" state).
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

/** Convert an entry's message into the wire/display shape (file-parse side). */
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
  let thinkingLevel = null;
  let firstMessage = '';
  let lastText = '';
  const messages = [];

  const toolCallIndex = new Map(); // toolCallId → display message index
  for (const entry of chain) {
    if (entry.type === 'session') continue;
    if (entry.type === 'session_info' && entry.name !== undefined) name = entry.name;
    if (entry.type === 'model_change') {
      if (!model) model = entry.modelId ?? null;
      continue;
    }
    // The level applies from this point on — stamp it on the assistant
    // messages that follow so each turn header shows its own level.
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
    if (msg.role === 'assistant') dm.thinkingLevel = thinkingLevel;
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
        if (tc) {
          tc.result = dm.text;
          tc.isError = dm.isError;
        }
        dm.merged = true;
      }
    }
  }
  // TUI /session parity: message breakdown, token/cost totals incl. cache
  // buckets + compaction usage, per-model cost breakdown, cache waste.
  // Counts EVERY file entry (like the SDK's getEntries), not just the
  // active leaf chain.
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
      // Compaction-aware context-token estimate (null = unknown, the "?"
      // state right after a compaction) — see estimateContextTokens.
      contextTokens: estimateContextTokens(chain),
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
    rs.on('data', (c) => {
      data += c;
    });
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
      // A malformed line means cached.size no longer sits at a line start —
      // the file was rewritten under us (e.g. the TUI resumed/reloaded it).
      // Merging stale + partial entries would drop the newest ones and break
      // the parent chain, silently freezing open chat windows until a full
      // re-parse — fall back to one instead.
      if (!boundaryOk) {
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
    // A live-stream cursor (asst-/user-/pending-/toolresult-/msg-) is NEVER
    // in the file — the entry for the streamed message hasn't landed yet.
    // Returning everything here would hand the client the WHOLE history and
    // its dedupe (loaded-window only) would append thousands of old rows
    // after the live tail: the chat "flicks" to a previous message and the
    // bottom stops showing the latest. Return nothing; the client re-syncs
    // once its cursor is file-backed (next refresh).
    else if (/^(asst|user|pending|toolresult|msg)-/.test(opts.after)) merged = [];
    // An unknown FILE cursor (e.g. pre-compaction entry dropped from the
    // active chain) serves the whole chain — post-compaction that list is
    // short and the client dedupes by id.
  } else if (opts.limit || opts.before) {
    let end = merged.length;
    if (opts.before) {
      const idx = merged.findIndex((m) => m.id === opts.before);
      if (idx >= 0) end = idx; // unknown cursor → serve the newest slice
    }
    let start = Math.max(0, end - (opts.limit ?? merged.length));
    // Round-based pagination: a page never splits a round (one user
    // message + all of its replies). Walk the start back while the slice's
    // oldest entry is itself a reply, so the page opens with the round's
    // head message (user/system/summary/custom/standalone toolResult) and
    // the client never renders a round's replies without their head — the
    // same grouping the client renders turns with.
    while (start > 0 && (merged[start].role === 'assistant' || merged[start].role === 'bash')) {
      start--;
    }
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

/**
 * Model id → contextWindow, resolved through pi-nest's (internally cached)
 * model catalog. The gateway keeps its own TTL so the catalog round-trip
 * happens at most once a minute even though /api/sessions is polled every
 * 15s. pi-nest down → keep the last catalog (or empty) and the indicator
 * simply hides.
 */
let modelWindows = new Map();
/** `${provider}/${model}` → per-1M-token cost rates (cache-waste fallback
 *  for full misses, where the message itself carries no cacheRead cost). */
let modelCostRates = new Map();
let modelCatalogAt = 0;
let modelCatalogBackoff = 0;
const MODEL_CATALOG_TTL_MS = 60 * 1000;

async function ensureModelCatalog() {
  if (Date.now() - modelCatalogAt <= MODEL_CATALOG_TTL_MS) return;
  // A failed fetch must NOT be cached for the full TTL (an empty catalog
  // skews the cache-waste fallback rates for every parse in the window) —
  // retry after a short backoff instead (the first attempt always runs).
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
    // pi-nest down or no catalog — keep the last known one, retry shortly.
    modelCatalogBackoff = Date.now();
  }
}

async function contextWindowOf(modelId) {
  if (!modelId) return 0;
  await ensureModelCatalog();
  return modelWindows.get(modelId) ?? 0;
}

/** Overlay the context gauge onto a parsed session info. */
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

// ── Directory tree (left panel "Directory" section) ───────────────────────
// A folder tree under NEW_CHAT_CWD pruned to directories that actually
// hold sessions (a session's cwd must equal the dir path). Node counts are
// RECURSIVE — how many chats live under that folder — matching the filter
// semantics (a click filters to every session under the path).

/** A real folder tree under NEW_CHAT_CWD (junk skipped, depth-bounded) —
 *  directories with no sessions stay visible (count 0). Node counts are
 *  RECURSIVE — how many chats live under that folder — matching the filter
 *  semantics (a click filters to every session under the path). */

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

/** cwd → number of session files started there (cached parses). */
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
    } catch {
      /* unreadable */
    }
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

// ── SSE hub ───────────────────────────────────────────────────────────────

/** SSE clients: Set<http.ServerResponse> */
const clients = new Set();

function emit(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try {
      res.write(data);
    } catch {
      /* client gone */
    }
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
  refreshTimers.set(
    file,
    setTimeout(() => {
      refreshTimers.delete(file);
      emit({ type: 'refresh', file });
      // The folder tree's session counts changed — push the rebuilt tree so
      // clients don't refetch on every section flip.
      scheduleTreePush();
    }, 250),
  );
}

/** Coalesced tree push: rebuild + broadcast the Directory tree shortly after
 *  session-file changes. Once a push is pending it is NOT reset by further
 *  refreshes (a busy turn streams refreshes faster than any debounce —
 *  resetting would starve the push forever). */
let treeTimer = null;
function scheduleTreePush() {
  if (treeTimer) return;
  treeTimer = setTimeout(async () => {
    treeTimer = null;
    try {
      emit({ type: 'tree', tree: await buildSessionTree() });
    } catch {
      /* ignore */
    }
  }, 500);
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
          try {
            payload = ev.json ? JSON.parse(ev.json) : {};
          } catch {
            /* ignore */
          }
          // Preserve the SSE vocabulary the frontend expects: message events
          // carry the display message under `message`; everything else is
          // spread at top level (status, tool info, ...).
          if (ev.type === 'message') emit({ type: 'message', file: ev.file, message: payload });
          else if (ev.type === 'refresh') emitRefresh(ev.file);
          else emit({ type: ev.type, file: ev.file, ...payload });
        });
        stream.once('error', () => {
          console.log('[gateway] relay stream dropped — reconnecting');
          resolve();
        });
        stream.once('end', () => {
          console.log('[gateway] relay stream ended — reconnecting');
          resolve();
        });
      });
    } catch {
      /* keepalive retry */
    }
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
        (await client.listStates().catch(() => ({ states: [] }))).states.map((s) => [s.agentId, s]),
      );
      // Parallel parse (cache makes re-reads cheap; cold starts split across cores).
      // The catalog is ensured BEFORE parsing so deriveSessionStats' cache-waste
      // fallback rates are present on the first parse.
      await ensureModelCatalog();
      const sessions = (await Promise.all(files.map((f) => analyzeSession(f, { states })))).filter(Boolean);
      sessions.sort((a, b) => b.modified - a.modified);
      sendJson(res, 200, { sessions: await Promise.all(sessions.map(withContext)) });
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
      sendJson(res, 200, await withContext(info));
      return;
    }

    // ── Send a message to a session ──
    if (p === '/api/chat' && req.method === 'POST') {
      const { file, message, wait, reqId } = await readBody(req);
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
      // server mid-run leaves the agent untouched. pi-nest broadcasts an
      // 'ack' event (echoing reqId) the moment it accepts the message, so the
      // frontend doesn't wait on this response to light its pending UI.
      await client.prompt({ agentId: file, message: text, interrupt, reqId: reqId ?? '' });
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
          reqId: body.reqId ?? '',
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
      try {
        nest = (await client.ping()).ok;
      } catch {
        /* nest down */
      }
      sendJson(res, 200, { ok: true, nest });
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

// Heartbeat keeps SSE connections alive through proxies.
const _heartbeat = setInterval(() => {
  for (const res of clients) {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }
}, 15000);

// ── External session file watcher ─────────────────────────────────────────
// Sessions written by OTHER processes (e.g. the pi TUI) produce no agent
// events through pi-nest — poll file mtimes and emit refresh so open chat
// windows auto-update as entries land on disk.

const fileMtimes = new Map();

async function watchSessionFiles() {
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
    } // one bad dir must not abort the pass
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(dir, f);
      const st = await stat(file).catch(() => null);
      if (!st) continue;
      const m = st.mtimeMs;
      if (fileMtimes.get(file) !== m) {
        const _known = fileMtimes.has(file);
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
