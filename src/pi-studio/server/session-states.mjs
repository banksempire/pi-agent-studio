import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const PERSIST_VERSION = 1;
const PERSIST_DEBOUNCE_MS = 250;

export function createSessionStates({
  persistPath = path.join(homedir(), '.pi', 'agent', 'studio-session-states.json'),
  fileExists = existsSync,
  onSync = () => {},
  now = () => Date.now(),
} = {}) {
  const entries = new Map();
  let persistTimer = null;
  let lastPersistedJson = null;
  let persistWrites = 0;

  function ensure(file) {
    let e = entries.get(file);
    if (!e) {
      e = {
        state: 'open',
        error: '',
        views: 0,
        runStartedAt: 0,
        lastVisitAt: 0,
        lastGrowAt: 0,
        pendingStop: '',
        pendingProbe: false,
      };
      entries.set(file, e);
    }
    return e;
  }

  function persistedJson() {
    return JSON.stringify(persistedShape());
  }

  function schedulePersist() {
    if (persistTimer) return;
    if (persistedJson() === lastPersistedJson) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      flush();
    }, PERSIST_DEBOUNCE_MS);
  }

  function persistedShape() {
    const list = [];
    for (const [file, e] of entries) {
      if (e.state === 'working' || e.state === 'unread' || e.state === 'error') {
        list.push({ file, state: e.state, error: e.error });
      }
    }
    return { version: PERSIST_VERSION, entries: list };
  }

  function flush() {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    const json = persistedJson();
    if (json === lastPersistedJson) return;
    try {
      mkdirSync(path.dirname(persistPath), { recursive: true });
      writeFileSync(persistPath, json);
      lastPersistedJson = json;
      persistWrites += 1;
    } catch {}
  }

  function load() {
    let raw = null;
    try {
      raw = JSON.parse(readFileSync(persistPath, 'utf8'));
    } catch {
      return;
    }
    if (!raw || raw.version !== PERSIST_VERSION || !Array.isArray(raw.entries)) return;
    for (const item of raw.entries) {
      if (!item || typeof item.file !== 'string') continue;
      if (item.state !== 'working' && item.state !== 'unread' && item.state !== 'error') continue;
      if (!fileExists(item.file)) continue;
      entries.set(item.file, {
        state: item.state,
        error: typeof item.error === 'string' ? item.error : '',
        views: 0,
        runStartedAt: 0,
        lastVisitAt: 0,
        lastGrowAt: 0,
        pendingStop: '',
        pendingProbe: item.state === 'working',
      });
    }
    lastPersistedJson = persistedJson();
  }

  function sync(file) {
    const e = entries.get(file);
    if (e) onSync({ type: 'session_state', file, state: e.state, error: e.error });
    else onSync({ type: 'session_state', file, state: 'close', error: '' });
    schedulePersist();
  }

  function setState(file, e, state, error = '') {
    e.state = state;
    e.error = error;
    if (state !== 'working') e.pendingStop = '';
    if (state === 'close') entries.delete(file);
    sync(file);
  }

  function notePrompt(file) {
    const e = ensure(file);
    e.runStartedAt = now();
    e.lastVisitAt = 0;
    e.pendingStop = '';
    e.pendingProbe = false;
    if (e.state !== 'working') setState(file, e, 'working');
    else sync(file);
  }

  function noteAgentRunning(file) {
    const e = ensure(file);
    if (e.state !== 'working') {
      e.runStartedAt = now();
      e.lastVisitAt = 0;
      e.pendingStop = '';
      e.error = '';
      e.pendingProbe = false;
      setState(file, e, 'working');
    }
  }

  function noteAssistantOutcome(file, stopReason, errorMessage = '') {
    const e = entries.get(file);
    if (!e) return;
    e.pendingStop = stopReason === 'error' ? errorMessage || 'agent error' : '';
  }

  function noteAgentSettled(file, { stale = false, error = '' } = {}) {
    const e = entries.get(file);
    if (e?.state !== 'working') return;
    const visited = e.lastVisitAt > 0 && e.runStartedAt > 0 && e.lastVisitAt >= e.runStartedAt;
    if (visited) {
      setState(file, e, 'open');
      return;
    }
    if (stale) {
      setState(file, e, 'error', 'run stalled — force-settled by watchdog');
      return;
    }
    if (error || e.pendingStop) {
      setState(file, e, 'error', error || e.pendingStop);
      return;
    }
    setState(file, e, 'unread');
  }

  function noteFileRunStart(file, at) {
    const e = ensure(file);
    if (e.state !== 'working') {
      e.runStartedAt = at ?? now();
      e.lastVisitAt = 0;
      e.pendingStop = '';
      e.error = '';
      e.pendingProbe = false;
      setState(file, e, 'working');
    }
    e.lastGrowAt = now();
  }

  function noteFileActivity(file) {
    const e = entries.get(file);
    if (e?.state === 'working') e.lastGrowAt = now();
  }

  function noteFileTerminal(file, isError, errorMessage) {
    noteAgentSettled(file, isError ? { error: errorMessage || 'agent error' } : {});
    noteFileActivity(file);
  }

  function sweepStaleFileRuns(staleMs) {
    const t = now();
    for (const [file, e] of [...entries]) {
      if (e.state !== 'working' || e.lastGrowAt === 0) continue;
      if (t - e.lastGrowAt <= staleMs) continue;
      setState(
        file,
        e,
        'error',
        `run stalled — no session updates for ${Math.round((t - e.lastGrowAt) / 60000)}m`,
      );
    }
  }

  function noteVisit(file) {
    const e = entries.get(file);
    if (!e) return;
    e.lastVisitAt = now();
    if (e.state === 'unread' || e.state === 'error') setState(file, e, 'open');
  }

  function noteViews(file, count) {
    if (count > 0) {
      const existed = entries.has(file);
      const e = ensure(file);
      e.views = count;
      if (!existed) sync(file);
      return;
    }
    const e = entries.get(file);
    if (!e) return;
    e.views = 0;
    if (e.state === 'open') setState(file, e, 'close');
  }

  async function probeNest(listStates, resolveOutcome) {
    let res;
    try {
      res = await listStates();
    } catch {
      return;
    }
    const byId = new Map((res?.states ?? []).map((s) => [s.agentId, s]));
    for (const [file, e] of [...entries]) {
      if (!e.pendingProbe) continue;
      e.pendingProbe = false;
      const live = byId.get(file);
      if (live?.status === 'running') {
        sync(file);
        continue;
      }
      const outcome = await resolveOutcome(file);
      if (outcome === 'gone') {
        entries.delete(file);
        sync(file);
      } else if (outcome === 'error') {
        setState(file, e, 'error', e.error || 'run ended while the gateway was down');
      } else {
        setState(file, e, 'unread');
      }
    }
  }

  function remove(file) {
    if (!entries.has(file)) return;
    entries.delete(file);
    sync(file);
  }

  return {
    load,
    flush,
    notePrompt,
    noteAgentRunning,
    noteAssistantOutcome,
    noteAgentSettled,
    noteVisit,
    noteViews,
    noteFileRunStart,
    noteFileActivity,
    noteFileTerminal,
    sweepStaleFileRuns,
    probeNest,
    remove,
    canDelete: (file) => (entries.get(file)?.views ?? 0) === 0,
    stateOf: (file) => entries.get(file)?.state ?? 'close',
    errorOf: (file) => entries.get(file)?.error ?? '',
    writeCount: () => persistWrites,
    snapshot: () => [...entries].map(([file, e]) => ({ file, state: e.state, error: e.error })),
    files: () => [...entries.keys()],
  };
}
