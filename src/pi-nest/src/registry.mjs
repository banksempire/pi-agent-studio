import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { extractText, hashId, messageId, newSessionPath, sdk, toDisplayMessage } from './sdk-bridge.mjs';

export const STALE_RUN_MS = 20 * 60 * 1000;
export const IDLE_EVICT_MS = Number(process.env.PI_NEST_IDLE_EVICT_MS ?? 60 * 60 * 1000);
export const WATCHDOG_INTERVAL_MS = 30 * 1000;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export class AgentRegistry extends EventEmitter {
  #live = new Map();
  #pending = new Map();

  createSession(cwd) {
    const file = newSessionPath(cwd);
    this.#pending.set(file, { cwd, dir: path.dirname(file), model: null, thinkLevel: null });
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
          item.done?.();
        }
      }
      live.pumping = false;
    })();
  }

  async prompt(agentId, message, { interrupt = true, images = [] } = {}) {
    const live = await this.open(agentId);
    if (interrupt && live.status === 'running') {
      try {
        await live.session.abort();
      } catch {}
    }
    return this.#submit(live, agentId, { message, images });
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
    const spilled = [];
    for (const [agentId, live] of this.#live) {
      live.drained = true;
      if (live.pumping) {
        const deadline = Date.now() + timeoutMs;
        while (live.pumping && Date.now() < deadline) await delay(200);
        if (live.pumping) {
          console.log(`[pi-nest][drain] aborting still-running ${agentId.split('/').pop()}`);
          try {
            await live.session.abort();
          } catch {}
          const hardDeadline = Date.now() + 10000;
          while (live.pumping && Date.now() < hardDeadline) await delay(100);
        }
      }
      if (live.queue.length > 0) {
        const items = live.queue.splice(0);
        for (const item of items) item.done?.();
        spilled.push({ agentId, items: items.map(({ message, images }) => ({ message, images })) });
        console.log(
          `[pi-nest][drain] spilled ${items.length} queued message(s) for ${agentId.split('/').pop()}`,
        );
      }
    }
    return spilled;
  }

  async restore(entries) {
    let restored = 0;
    for (const { agentId, items } of entries ?? []) {
      if (typeof agentId !== 'string' || !existsSync(agentId)) continue;
      try {
        const live = await this.open(agentId);
        live.drained = false;
        for (const item of items ?? []) {
          if (typeof item?.message !== 'string') continue;
          live.queue.push({ message: item.message, images: Array.isArray(item.images) ? item.images : [] });
          restored += 1;
        }
        this.#pump(agentId, live);
      } catch (e) {
        console.error(`[pi-nest][restore] failed for ${String(agentId).split('/').pop()}:`, e?.message ?? e);
      }
    }
    return restored;
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
            break;
          }
          case 'turn_end': {
            const dm = toDisplayMessage(ev.message);
            dm.id = messageId(ev.message);
            dm.thinkingLevel = live.session.thinkingLevel ?? null;
            this.broadcast('message', agentId, dm);
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
