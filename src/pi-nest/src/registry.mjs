/**
 * AgentRegistry — the heart of pi-nest. Owns every live agent (today one per
 * session file; later sub-agents too) plus its work queue, so a front-end
 * service restart never interrupts running agents.
 *
 * Extensibility: the registry keys on `agentId` and each LiveAgent record is
 * a plain object. The future sub-agent work (agent definitions, spawning,
 * task execution) plugs in here: DefineAgent → a record with a spec;
 * SpawnAgent/RunTask → the same ensure()/enqueue() machinery below.
 */
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { extractText, hashId, messageId, newSessionPath, sdk, toDisplayMessage } from './sdk-bridge.mjs';

export const STALE_RUN_MS = 20 * 60 * 1000; // no agent events for 20 min → force-settle
/** Idle agents are disposed after this (memory bound; reopening is seamless
 *  and file-backed). Env PI_NEST_IDLE_EVICT_MS, 0 disables. */
export const IDLE_EVICT_MS = Number(process.env.PI_NEST_IDLE_EVICT_MS ?? 60 * 60 * 1000);
export const WATCHDOG_INTERVAL_MS = 30 * 1000;

export class AgentRegistry extends EventEmitter {
  /** agentId → { session, status, runningSince, lastEventAt, opChain, pendingOps } */
  #live = new Map();
  /** Lazy new-session reservations: agentId → { cwd, dir, model, thinkLevel }
   *  (materialized on first Prompt; the model pref is applied then). */
  #pending = new Map();

  // ── lifecycle ──────────────────────────────────────────────────────────

  /** Reserve a future session path (the SDK materializes it on first chat). */
  createSession(cwd) {
    const file = newSessionPath(cwd);
    this.#pending.set(file, { cwd, dir: path.dirname(file), model: null, thinkLevel: null });
    return { file };
  }

  /** The lazy reservation for agentId, or null if the agent isn't pending
   *  (already live or unknown). Never materializes. */
  pendingInfo(agentId) {
    return this.#pending.get(agentId) ?? null;
  }

  /** Store the model preference of a lazy reservation WITHOUT materializing
   *  it — the model picker works on new chats, but the session stays
   *  virtual until the first prompt. Returns the reservation, or null if
   *  the agent isn't pending anymore. */
  setPendingModel(agentId, model, thinkLevel) {
    const p = this.#pending.get(agentId);
    if (!p) return null;
    p.model = model;
    p.thinkLevel = thinkLevel ?? null;
    return p;
  }

  /** True if the agent is known (pending, open, or running) — i.e. a client
   *  may prompt it even though no file exists on disk yet. */
  has(agentId) {
    return this.#live.has(agentId) || this.#pending.has(agentId);
  }

  /** Idempotent open: return the live agent, or materialize one. */
  async open(agentId) {
    const live = this.#live.get(agentId);
    if (live) return live;
    if (this.#pending.has(agentId)) {
      // Lazy start: the reserved virtual new-chat becomes real here, pinned
      // to the exact file path the frontend already holds as its session id.
      const { cwd, dir, model, thinkLevel } = this.#pending.get(agentId);
      this.#pending.delete(agentId);
      const sessionManager = new sdk.SessionManager(cwd, dir, agentId, true);
      const { session } = await sdk.createAgentSession({ sessionManager });
      // A model chosen in the UI while the chat was still lazy applies now,
      // before the first message runs.
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

  /** Dispose + evict an agent. No-op if unknown. */
  async close(agentId) {
    const live = this.#live.get(agentId);
    if (live) {
      this.#live.delete(agentId);
      try {
        live.session.dispose();
      } catch {
        /* ignore */
      }
    }
    this.#pending.delete(agentId);
    return { ok: true };
  }

  /** Attach an already-created AgentSession (used by forks). */
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
      // Per-agent FIFO: concurrent prompts (e.g. two chat windows on the same
      // session) run strictly one after another instead of racing the SDK.
      opChain: Promise.resolve(),
      pendingOps: 0,
    };
    this.#live.set(agentId, live);
    this.#attach(agentId, live);
    return live;
  }

  // ── execution ──────────────────────────────────────────────────────────

  /** Queue an async op so it runs only after all previously queued ops. */
  enqueue(live, op) {
    live.pendingOps += 1;
    const next = live.opChain.then(async () => {
      live.pendingOps -= 1;
      return op();
    });
    live.opChain = next.catch(() => {}); // chain survives a rejected op
    return next;
  }

  /**
   * Queue a user message: emit the pending row immediately, then run the
   * turn. Resolves when that turn completes (queued behind earlier ones).
   *
   * `interrupt` (default true) is the default UX: a message sent while the
   * agent is busy CUTS the current turn short (abort), so the new message
   * runs promptly. `/wait` messages pass interrupt:false — they queue and
   * run after the current turn finishes naturally.
   *
   * `images` (optional) rides along as [{ mediaType, data }] (base64) and
   * is handed to the SDK as ImageContent attachments.
   */
  async prompt(agentId, message, { interrupt = true, images = [] } = {}) {
    const live = await this.open(agentId);
    if (interrupt && live.status === 'running') {
      // Abort before enqueueing: this is the running op's own turn, so it
      // settles quickly and our queued op runs next instead of waiting for
      // the run to finish naturally.
      await live.session.abort().catch(() => {});
    }
    await this.enqueue(live, async () => {
      const ts = Date.now();
      const row = { id: `pending-${ts}`, role: 'user', text: message, ts };
      if (images.length) row.images = images;
      this.broadcast('message', agentId, row);
      await live.session.prompt(
        message,
        images.length
          ? {
              // The SDK's own file/CLI image shape ({ type:'image', data,
              // mimeType }) — provider APIs read block.mimeType directly
              // (the source:{…} prompt shape would lose the media type).
              images: images.map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType })),
            }
          : undefined,
      );
    });
    return { ok: true };
  }

  async abort(agentId) {
    const live = this.#live.get(agentId);
    if (live) await live.session.abort().catch(() => {});
    return { ok: true };
  }

  // ── state ──────────────────────────────────────────────────────────────

  state(agentId) {
    const live = this.#live.get(agentId);
    if (live) {
      return {
        agentId,
        status: live.status,
        runningSinceMs: live.runningSince ?? 0,
        lastEventAtMs: live.lastEventAt,
        queueDepth: live.pendingOps,
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

  /** Force-settle any 'running' agent that has emitted no events for
   *  STALE_RUN_MS, then evict agents idle long enough (IDLE_EVICT_MS) so the
   *  daemon's memory stays bounded — sessions re-open from their file on the
   *  next prompt, so eviction is invisible except for the SDK startup cost. */
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
        this.broadcast('session_status', agentId, { status: 'idle' });
        this.broadcast('refresh', agentId, {});
        continue;
      }
      if (IDLE_EVICT_MS > 0 && live.pendingOps === 0 && now - live.lastEventAt > IDLE_EVICT_MS) {
        this.#live.delete(agentId);
        try {
          live.session.dispose();
        } catch {
          /* ignore */
        }
        console.log(`[pi-nest][watchdog] evicted idle agent ${agentId.split('/').pop()}`);
      }
    }
  }

  /** Dispose every live agent (pi-nest shutdown only — never on app restarts). */
  shutdown() {
    for (const live of this.#live.values()) {
      try {
        live.session.dispose();
      } catch {
        /* ignore */
      }
    }
    this.#live.clear();
    this.#pending.clear();
  }

  // ── SDK event wiring ───────────────────────────────────────────────────

  /** Broadcast an agent event to subscribers. The payload is JSON-stringified
   *  ONCE here (not per subscriber) and the emit is exception-safe: a slow or
   *  broken subscriber must never crash the SDK event pipeline. */
  broadcast(type, file, payload) {
    const n = this.listenerCount('event');
    if (n === 0) return; // nobody connected — skip the stringify entirely
    let json = '{}';
    try {
      json = JSON.stringify(payload ?? {});
    } catch {
      /* unstringifiable payload */
    }
    try {
      this.emit('event', { type, file, json });
    } catch (e) {
      console.error('[pi-nest] subscriber error:', e);
    }
  }

  /** Current per-agent state, replayed to a (re)connecting subscriber.
   *  Transient events (compaction WIP, run status) are lost when a relay
   *  stream drops mid-run — the snapshot reconstructs them so the frontend
   *  re-syncs instead of silently missing the in-flight state. */
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
            // The SDK message carries provider/model; the thinking level is
            // session state, so stamp it from the live session here.
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
            // The SDK reports "Already compacted" as an error, but for the user
            // the outcome is positive — the summary exists in the conversation,
            // so show the done box (click-to-audit) instead of a failed one.
            const already = !!ev.errorMessage && /already compacted/i.test(ev.errorMessage);
            this.broadcast('compaction_status', agentId, {
              status: !ev.errorMessage || already ? 'done' : 'failed',
              // the reason the summarizer failed — the frontend shows it in
              // the transient failed bubble's body (failures were silent).
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
        // A malformed SDK event must never kill the daemon.
        console.error(`[pi-nest] event handling error (${ev?.type}):`, e);
      }
    });
  }
}
