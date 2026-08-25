import { EventEmitter } from 'node:events';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { extractText, hashId, messageId, newSessionPath, sdk, toDisplayMessage } from './sdk-bridge.mjs';

export const STALE_RUN_MS = 20 * 60 * 1000;
export const IDLE_EVICT_MS = Number(process.env.PI_NEST_IDLE_EVICT_MS ?? 60 * 60 * 1000);
export const WATCHDOG_INTERVAL_MS = 30 * 1000;
export const PARTIAL_SNAPSHOT_MS = 500;
export const RESUME_SLACK_MS = 10 * 1000;
export const TAIL_BYTES = 64 * 1024;

const NUDGE_SHORT =
  '[gateway restart] Your previous reply was cut off mid-generation. Continue exactly where it stopped.';
const NUDGE_NONE =
  '[gateway restart] The gateway restarted before you produced any reply. Respond to the request above.';

function nudgeEmbedded(partial) {
  return `[gateway restart] Your previous reply was cut off mid-generation. Its last generated state was:\n\n<<<\n${partial}\n>>>\n\nContinue from that point without repeating yourself.`;
}

function readTranscriptTail(file) {
  let fd = null;
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - TAIL_BYTES);
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf
      .toString('utf8')
      .split('\n')
      .filter((l) => l.trim());
    const from = start === 0 ? 0 : 1;
    let lastTs = 0;
    let lastUserTs = 0;
    let lastAssistant = null;
    for (const line of lines.slice(from)) {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = Date.parse(e?.timestamp ?? '');
      if (Number.isFinite(ts) && ts > lastTs) lastTs = ts;
      if (e?.type !== 'message' || !e.message) continue;
      if (e.message.role === 'user' && Number.isFinite(ts)) lastUserTs = Math.max(lastUserTs, ts);
      if (e.message.role === 'assistant' && Number.isFinite(ts)) {
        lastAssistant = { ts, stopReason: e.message.stopReason ?? '' };
      }
    }
    return { lastTs, lastUserTs, lastAssistant };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

function classifyResume(row, tail, resumeMode) {
  if (resumeMode === 'skip') return { kind: 'skip', reason: 'resume disabled' };
  if (row.status === 'queued') return { kind: 'replay' };
  const startedAt = row.startedAt ?? 0;
  if (!startedAt) return { kind: 'replay' };
  if (resumeMode === 'replay') return { kind: 'replay' };
  if (!tail) return { kind: 'replay' };
  if (tail.lastUserTs > startedAt + RESUME_SLACK_MS) {
    return { kind: 'skip', reason: 'session advanced while the gateway was down' };
  }
  const userPresent = tail.lastUserTs >= startedAt - RESUME_SLACK_MS;
  if (!userPresent) return { kind: 'replay' };
  const assistantOnDisk = !!tail.lastAssistant && tail.lastAssistant.ts >= startedAt - RESUME_SLACK_MS;
  if (row.partialText && !assistantOnDisk) return { kind: 'nudge', text: nudgeEmbedded(row.partialText) };
  if (assistantOnDisk) return { kind: 'nudge', text: NUDGE_SHORT };
  return { kind: 'nudge', text: NUDGE_NONE };
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export class AgentRegistry extends EventEmitter {
  #live = new Map();
  #pending = new Map();
  #journal;

  constructor({ journal = null } = {}) {
    super();
    this.#journal = journal;
  }

  createSession(cwd) {
    const file = newSessionPath(cwd);
    this.#pending.set(file, { cwd, dir: path.dirname(file), model: null, thinkLevel: null });
    this.#journal?.ensureSession(file, cwd);
    return { file };
  }

  reuseOrCreateSession(cwd) {
    const resolved = path.resolve(cwd);
    for (const [file, p] of this.#pending) {
      if (path.resolve(p.cwd) === resolved) return { file };
    }
    return this.createSession(cwd);
  }

  pendingInfo(agentId) {
    return this.#pending.get(agentId) ?? null;
  }

  setPendingModel(agentId, model, thinkLevel) {
    const p = this.#pending.get(agentId);
    if (!p) return null;
    p.model = model;
    p.thinkLevel = thinkLevel ?? null;
    this.#journal?.setSessionPrefs(agentId, { model, thinkLevel: thinkLevel ?? null });
    return p;
  }

  has(agentId) {
    return this.#live.has(agentId) || this.#pending.has(agentId);
  }

  async open(agentId) {
    const live = this.#live.get(agentId);
    if (live) return live;
    if (this.#pending.has(agentId)) {
      const { cwd, dir, model, thinkLevel } = this.#pending.get(agentId);
      this.#pending.delete(agentId);
      const sessionManager = new sdk.SessionManager(cwd, dir, agentId, true);
      const { session } = await sdk.createAgentSession({ sessionManager });
      if (model) {
        try {
          await session.setModel(model);
        } catch (e) {
          console.error(`[pi-nest] applying pending model pref failed (${agentId.split('/').pop()}):`, e);
        }
      }
      if (thinkLevel) {
        try {
          session.setThinkingLevel(thinkLevel);
        } catch (e) {
          console.error(
            `[pi-nest] applying pending think-level pref failed (${agentId.split('/').pop()}):`,
            e,
          );
        }
      }
      this.#journal?.clearSessionPrefs(agentId);
      return this.#register(agentId, session);
    }
    const { session } = await sdk.createAgentSession({
      sessionManager: sdk.SessionManager.open(agentId),
    });
    return this.#register(agentId, session);
  }

  async close(agentId) {
    const live = this.#live.get(agentId);
    if (live) {
      this.#live.delete(agentId);
      try {
        live.session.dispose();
      } catch {}
    }
    this.#pending.delete(agentId);
    this.#journal?.clearSessionPrefs(agentId);
    return { ok: true };
  }

  attach(agentId, session) {
    return this.#register(agentId, session);
  }

  #register(agentId, session) {
    const live = {
      session,
      status: 'idle',
      runningSince: null,
      compacting: false,
      lastEventAt: Date.now(),
      queue: [],
      pumping: false,
      drained: false,
      current: null,
    };
    this.#live.set(agentId, live);
    this.#attach(agentId, live);
    return live;
  }

  #submit(live, agentId, item) {
    let done = null;
    const completion = new Promise((resolve) => {
      done = resolve;
    });
    item.done = done;
    if (item.id === undefined) {
      item.id = this.#journal?.enqueue(agentId, item) ?? null;
    }
    if (item.onQueued) {
      try {
        item.onQueued(item.id);
      } catch {}
    }
    live.queue.push(item);
    this.#pump(agentId, live);
    return completion;
  }

  #pump(agentId, live) {
    if (live.pumping || live.drained) return;
    live.pumping = true;
    (async () => {
      while (!live.drained) {
        const item = live.queue.shift();
        if (!item) break;
        live.current = item;
        item.startedAt = Date.now();
        this.#journal?.markInflight(item.id, item.startedAt);
        try {
          const ts = Date.now();
          const row = { id: `pending-${ts}`, role: 'user', text: item.message, ts };
          if (item.images?.length) row.images = item.images;
          this.broadcast('message', agentId, row);
          await live.session.prompt(
            item.message,
            item.images?.length
              ? {
                  images: item.images.map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType })),
                }
              : undefined,
          );
        } catch (e) {
          console.error(`[pi-nest] prompt failed (${agentId.split('/').pop()}):`, e?.message ?? e);
        } finally {
          if (!item.keepRow) this.#journal?.remove(item.id);
          live.current = null;
          item.done?.();
        }
      }
      live.pumping = false;
    })();
  }

  #maybeSnapshot(live, dm, force) {
    const cur = live.current;
    if (!cur || cur.id === null || dm.role !== 'assistant' || !dm.text) return;
    cur.partialText = dm.text;
    const now = Date.now();
    if (!force && now - (cur.partialAt ?? 0) < PARTIAL_SNAPSHOT_MS) return;
    cur.partialAt = now;
    this.#journal?.snapshotPartial(cur.id, dm.text);
  }

  async prompt(agentId, message, { interrupt = true, images = [], onQueued = null } = {}) {
    const live = await this.open(agentId);
    if (interrupt && live.status === 'running') {
      try {
        await live.session.abort();
      } catch {}
    }
    return this.#submit(live, agentId, { message, images, onQueued });
  }

  async abort(agentId) {
    const live = this.#live.get(agentId);
    if (live) {
      try {
        await live.session.abort();
      } catch {}
    }
    return { ok: true };
  }

  async drain({ timeoutMs = 45000 } = {}) {
    let aborted = 0;
    for (const [agentId, live] of this.#live) {
      live.drained = true;
      if (live.pumping) {
        const deadline = Date.now() + timeoutMs;
        while (live.pumping && Date.now() < deadline) await delay(200);
        if (live.pumping) {
          console.log(`[pi-nest][drain] aborting still-running ${agentId.split('/').pop()}`);
          if (live.current) live.current.keepRow = true;
          try {
            await live.session.abort();
          } catch {}
          const hardDeadline = Date.now() + 10000;
          while (live.pumping && Date.now() < hardDeadline) await delay(100);
          if (live.pumping) aborted += 1;
        }
      }
    }
    let queued = 0;
    let interrupted = 0;
    if (this.#journal) {
      for (const r of this.#journal.pendingItems()) {
        if (r.status === 'queued') queued += 1;
        else interrupted += 1;
      }
    } else {
      for (const live of this.#live.values()) {
        queued += live.queue.length;
        if (live.pumping) interrupted += 1;
      }
    }
    if (queued + interrupted > 0) {
      console.log(
        `[pi-nest][drain] ${queued} queued + ${interrupted} interrupted prompt(s) left durable in the journal`,
      );
    }
    return { aborted, queued, interrupted };
  }

  async recover({ resumeMode = 'nudge' } = {}) {
    const journal = this.#journal;
    if (!journal) return null;
    const counts = { prefs: 0, replayed: 0, resumed: 0, skipped: 0 };
    for (const p of journal.sessionsWithPrefs()) {
      if (!existsSync(p.file)) {
        journal.removeSession(p.file);
        continue;
      }
      this.#pending.set(p.file, {
        cwd: p.cwd || path.dirname(p.file),
        dir: path.dirname(p.file),
        model: p.model,
        thinkLevel: p.thinkLevel,
      });
      counts.prefs += 1;
    }
    const bySession = new Map();
    for (const r of journal.pendingItems()) {
      if (!bySession.has(r.sessionFile)) bySession.set(r.sessionFile, []);
      bySession.get(r.sessionFile).push(r);
    }
    for (const [file, rows] of bySession) {
      if (!existsSync(file)) {
        journal.removeSession(file);
        counts.skipped += rows.length;
        console.log(`[pi-nest][recover] session gone — dropped ${rows.length} journal row(s)`);
        continue;
      }
      let live = this.#live.get(file);
      const tail = readTranscriptTail(file);
      const planned = rows.map((r) => ({ r, plan: classifyResume(r, tail, resumeMode) }));
      const actionable = planned.filter((p) => p.plan.kind !== 'skip');
      for (const p of planned) {
        if (p.plan.kind === 'skip') {
          journal.remove(p.r.id);
          counts.skipped += 1;
          console.log(`[pi-nest][recover] skipping prompt for ${path.basename(file)}: ${p.plan.reason}`);
        }
      }
      if (actionable.length === 0) continue;
      if (!live) {
        try {
          live = await this.open(file);
        } catch (e) {
          console.error(`[pi-nest][recover] open failed (${path.basename(file)}):`, e?.message ?? e);
          counts.skipped += actionable.length;
          continue;
        }
      }
      for (const { r, plan } of actionable) {
        const message = plan.kind === 'replay' ? r.message : plan.text;
        const images = plan.kind === 'replay' ? r.images : [];
        journal.requeue(r.id, { message, images });
        this.#submit(live, file, { message, images, id: r.id });
        if (plan.kind === 'replay') counts.replayed += 1;
        else counts.resumed += 1;
      }
    }
    journal.checkpoint();
    return counts;
  }

  state(agentId) {
    const live = this.#live.get(agentId);
    if (live) {
      return {
        agentId,
        status: live.status,
        runningSinceMs: live.runningSince ?? 0,
        lastEventAtMs: live.lastEventAt,
        queueDepth: live.queue.length,
        lastError: '',
      };
    }
    if (this.#pending.has(agentId)) {
      return {
        agentId,
        status: 'pending',
        runningSinceMs: 0,
        lastEventAtMs: 0,
        queueDepth: 0,
        lastError: '',
      };
    }
    return { agentId, status: '', runningSinceMs: 0, lastEventAtMs: 0, queueDepth: 0, lastError: '' };
  }

  states() {
    const out = [];
    for (const id of this.#live.keys()) out.push(this.state(id));
    for (const id of this.#pending.keys()) out.push(this.state(id));
    return out;
  }

  scanStaleRuns() {
    const now = Date.now();
    for (const [agentId, live] of this.#live) {
      if (live.status === 'running') {
        if (now - live.lastEventAt <= STALE_RUN_MS) continue;
        console.log(
          `[pi-nest][watchdog] force-settling stale run ${agentId.split('/').pop()} (no events for ${Math.round((now - live.lastEventAt) / 60000)}m)`,
        );
        live.status = 'idle';
        live.runningSince = null;
        this.broadcast('session_status', agentId, { status: 'idle', stale: true });
        this.broadcast('refresh', agentId, {});
        continue;
      }
      if (
        IDLE_EVICT_MS > 0 &&
        live.queue.length === 0 &&
        !live.pumping &&
        now - live.lastEventAt > IDLE_EVICT_MS
      ) {
        this.#live.delete(agentId);
        try {
          live.session.dispose();
        } catch {}
        console.log(`[pi-nest][watchdog] evicted idle agent ${agentId.split('/').pop()}`);
      }
    }
  }

  shutdown() {
    for (const live of this.#live.values()) {
      try {
        live.session.dispose();
      } catch {}
    }
    this.#live.clear();
    this.#pending.clear();
  }

  broadcast(type, file, payload) {
    const n = this.listenerCount('event');
    if (n === 0) return;
    let json = '{}';
    try {
      json = JSON.stringify(payload ?? {});
    } catch {}
    try {
      this.emit('event', { type, file, json });
    } catch (e) {
      console.error('[pi-nest] subscriber error:', e);
    }
  }

  snapshot(agentId) {
    const out = [];
    for (const [id, live] of this.#live) {
      if (agentId && id !== agentId) continue;
      out.push({
        type: 'session_status',
        file: id,
        json: JSON.stringify({ status: live.status, runningSince: live.runningSince ?? 0 }),
      });
      if (live.compacting) {
        out.push({
          type: 'compaction_status',
          file: id,
          json: JSON.stringify({ status: 'started' }),
        });
      }
    }
    return out;
  }

  #attach(agentId, live) {
    live.session.subscribe((ev) => {
      live.lastEventAt = Date.now();
      try {
        switch (ev.type) {
          case 'agent_start':
            live.status = 'running';
            live.runningSince = Date.now();
            this.broadcast('session_status', agentId, { status: 'running', runningSince: live.runningSince });
            break;
          case 'agent_settled':
            live.status = 'idle';
            live.runningSince = null;
            this.broadcast('session_status', agentId, { status: 'idle' });
            this.broadcast('refresh', agentId, {});
            break;
          case 'message_start':
          case 'message_update':
          case 'message_end': {
            const dm = toDisplayMessage(ev.message);
            dm.id = messageId(ev.message);
            dm.thinkingLevel = live.session.thinkingLevel ?? null;
            this.broadcast('message', agentId, dm);
            this.#maybeSnapshot(live, dm, ev.type !== 'message_update');
            break;
          }
          case 'turn_end': {
            const dm = toDisplayMessage(ev.message);
            dm.id = messageId(ev.message);
            dm.thinkingLevel = live.session.thinkingLevel ?? null;
            this.broadcast('message', agentId, dm);
            this.#maybeSnapshot(live, dm, true);
            for (const tr of ev.toolResults ?? []) {
              this.broadcast('tool_result', agentId, {
                toolCallId: tr.toolCallId,
                toolName: tr.toolName,
                text: extractText(tr),
                isError: !!tr.isError,
              });
            }
            break;
          }
          case 'tool_execution_start':
            this.broadcast('tool_start', agentId, {
              toolCallId: ev.toolCallId,
              toolName: ev.toolName,
              args: ev.args,
            });
            break;
          case 'tool_execution_update':
            this.broadcast('tool_partial', agentId, {
              toolCallId: ev.toolCallId,
              text: extractText(ev.partialResult),
            });
            break;
          case 'tool_execution_end':
            this.broadcast('tool_result', agentId, {
              toolCallId: ev.toolCallId,
              toolName: ev.toolName,
              text: extractText(ev.result),
              isError: !!ev.isError,
            });
            break;
          case 'entry_appended':
            this.broadcast('refresh', agentId, {});
            break;
          case 'compaction_start':
            live.compacting = true;
            this.broadcast('compaction_status', agentId, { status: 'started' });
            break;
          case 'compaction_end': {
            live.compacting = false;
            const already = !!ev.errorMessage && /already compacted/i.test(ev.errorMessage);
            this.broadcast('compaction_status', agentId, {
              status: !ev.errorMessage || already ? 'done' : 'failed',
              error: !ev.errorMessage || already ? '' : ev.errorMessage,
            });
            if (!ev.errorMessage && ev.result?.summary) {
              this.broadcast('message', agentId, {
                id: `summary-${hashId(ev.result.summary)}`,
                role: 'summary',
                text: ev.result.summary,
                ts: Date.now(),
              });
            }
            break;
          }
          default:
            break;
        }
      } catch (e) {
        console.error(`[pi-nest] event handling error (${ev?.type}):`, e);
      }
    });
  }
}
