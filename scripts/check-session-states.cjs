const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function makeReporter() {
  let failed = false;
  const report = (name, ok, extra = '') => {
    console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
    if (!ok) failed = true;
  };
  return { report, isFailed: () => failed };
}

async function loadModule() {
  return import('../src/pi-studio/server/session-states.mjs');
}

function freshHarness(mod, { files = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-states-'));
  const persistPath = path.join(dir, 'states.json');
  const existing = new Set(files);
  const events = [];
  const { createSessionStates } = mod;
  const make = () =>
    createSessionStates({
      persistPath,
      fileExists: (f) => existing.has(f),
      onSync: (ev) => events.push(ev),
    });
  return { dir, persistPath, existing, events, make, createSessionStates };
}

async function main() {
  const { report, isFailed } = makeReporter();
  const mod = await loadModule();
  const F1 = '/sessions/a.jsonl';
  const F2 = '/sessions/b.jsonl';

  const t1 = await (async () => {
    const h = freshHarness(mod, { files: [F1] });
    const s = h.make();
    s.notePrompt(F1);
    const working = s.stateOf(F1) === 'working';
    s.noteViews(F1, 1);
    s.noteAgentRunning(F1);
    s.noteVisit(F1);
    s.noteAgentSettled(F1);
    const settledWhileWatched = s.stateOf(F1);
    s.noteViews(F1, 0);
    const afterClose = s.stateOf(F1);
    return {
      ok: working && settledWhileWatched === 'open' && afterClose === 'close',
      why: `prompt:${s.stateOf(F1)} watched:${settledWhileWatched} closed:${afterClose}`,
    };
  })();
  report('T1 prompt→working, watched run settles to open, window close→close', t1.ok, t1.why);

  const t2 = await (async () => {
    const h = freshHarness(mod, { files: [F1] });
    const s = h.make();
    s.notePrompt(F1);
    s.noteAgentRunning(F1);
    s.noteAgentSettled(F1);
    const unread = s.stateOf(F1);
    const unreadError = s.errorOf(F1);
    s.noteViews(F1, 1);
    const stillUnreadWithWindow = s.stateOf(F1);
    s.noteVisit(F1);
    const visited = s.stateOf(F1);
    return {
      ok:
        unread === 'unread' && unreadError === '' && stillUnreadWithWindow === 'unread' && visited === 'open',
      why: `settled:${unread} window-open:${stillUnreadWithWindow} visit:${visited}`,
    };
  })();
  report('T2 unvisited run settles to unread; opening a window keeps unread; visit clears', t2.ok, t2.why);

  const t3 = await (async () => {
    const h = freshHarness(mod, { files: [F1] });
    const s = h.make();
    s.notePrompt(F1);
    s.noteAgentRunning(F1);
    s.noteAssistantOutcome(F1, 'error', 'API quota reached');
    s.noteAgentSettled(F1);
    const state = s.stateOf(F1);
    const error = s.errorOf(F1);
    s.noteViews(F1, 1);
    const beforeVisit = s.stateOf(F1);
    s.noteVisit(F1);
    const afterVisit = s.stateOf(F1);
    return {
      ok: state === 'error' && /quota/.test(error) && beforeVisit === 'error' && afterVisit === 'open',
      why: `${state}/${error} visit:${beforeVisit}→${afterVisit}`,
    };
  })();
  report('T3 unrecoverable error → error state with message; visit clears', t3.ok, t3.why);

  const t4 = await (async () => {
    const h = freshHarness(mod, { files: [F1] });
    const s = h.make();
    s.notePrompt(F1);
    s.noteAgentRunning(F1);
    s.noteAgentSettled(F1, { stale: true });
    const state = s.stateOf(F1);
    const error = s.errorOf(F1);
    return { ok: state === 'error' && error.length > 0, why: `${state}/${error}` };
  })();
  report('T4 watchdog force-settle → error', t4.ok, t4.why);

  const t5 = await (async () => {
    const h = freshHarness(mod, { files: [F1] });
    const s = h.make();
    s.notePrompt(F1);
    s.noteViews(F1, 1);
    s.noteAgentRunning(F1);
    s.noteAssistantOutcome(F1, 'error', 'boom');
    s.noteVisit(F1);
    s.noteAgentSettled(F1);
    const state = s.stateOf(F1);
    return { ok: state === 'open', why: state };
  })();
  report('T5 visit during a failing run → open at settle (error seen live)', t5.ok, t5.why);

  const t6 = await (async () => {
    const h = freshHarness(mod, { files: [F1, F2] });
    const s = h.make();
    s.notePrompt(F1);
    s.noteAgentRunning(F1);
    s.noteAgentSettled(F1);
    s.notePrompt(F2);
    s.noteAgentRunning(F2);
    s.flush();
    const disk = JSON.parse(fs.readFileSync(h.persistPath, 'utf8'));
    const onDisk = disk.entries.map((e) => `${path.basename(e.file)}:${e.state}`).sort();
    s.noteViews(F1, 1);
    s.noteVisit(F1);
    s.flush();
    const diskAfterVisit = JSON.parse(fs.readFileSync(h.persistPath, 'utf8'));
    const visitedPersisted = diskAfterVisit.entries.some((e) => e.file === F1);
    return {
      ok: onDisk.join(',') === 'a.jsonl:unread,b.jsonl:working' && disk.version === 1 && !visitedPersisted,
      why: `disk=[${onDisk}] visitedPersisted:${visitedPersisted}`,
    };
  })();
  report('T6 persistence keeps working/unread/error, never open/close', t6.ok, t6.why);

  const t7 = await (async () => {
    const F3 = '/sessions/c.jsonl';
    const h = freshHarness(mod, { files: [F1, F2, F3] });
    const s1 = h.make();
    s1.notePrompt(F1);
    s1.noteAgentRunning(F1);
    s1.noteAgentSettled(F1);
    s1.notePrompt(F2);
    s1.noteAgentRunning(F2);
    s1.noteViews(F3, 1);
    s1.flush();
    const s2 = h.make();
    s2.load();
    const f1 = s2.stateOf(F1);
    const f2 = s2.stateOf(F2);
    const f3 = s2.stateOf(F3);
    await s2.probeNest(
      async () => ({ states: [] }),
      async (f) => (f === F2 ? 'error' : 'ok'),
    );
    const f2After = s2.stateOf(F2);
    return {
      ok: f1 === 'unread' && f2 === 'working' && f3 === 'close' && f2After === 'error',
      why: `boot unread:${f1} working:${f2} open:${f3} probe→ error:${f2After}`,
    };
  })();
  report('T7 restart: open hard-resets to close, unread stays, working resolves via probe', t7.ok, t7.why);

  const t8 = await (async () => {
    const h = freshHarness(mod, { files: [F1] });
    const s = h.make();
    s.noteViews(F1, 1);
    const blocked = s.canDelete(F1);
    s.noteViews(F1, 0);
    const allowed = s.canDelete(F1);
    const untracked = s.canDelete(F2);
    return {
      ok: !blocked && allowed && untracked,
      why: `open:${blocked} closed:${allowed} untracked:${untracked}`,
    };
  })();
  report('T8 delete only allowed at refcount zero', t8.ok, t8.why);

  const t9 = await (async () => {
    const h = freshHarness(mod, { files: [F1] });
    const s = h.make();
    s.notePrompt(F1);
    s.noteAgentRunning(F1);
    s.noteViews(F1, 2);
    s.noteVisit(F1);
    s.noteAgentSettled(F1);
    const twoViewers = s.stateOf(F1);
    s.noteViews(F1, 1);
    const oneViewer = s.stateOf(F1);
    s.noteViews(F1, 0);
    const zero = s.stateOf(F1);
    return {
      ok: twoViewers === 'open' && oneViewer === 'open' && zero === 'close',
      why: `${twoViewers}/${oneViewer}/${zero}`,
    };
  })();
  report('T9 refcount: close only when the last window closes', t9.ok, t9.why);

  const t10 = await (async () => {
    const h = freshHarness(mod, { files: [F1] });
    const s = h.make();
    s.notePrompt(F1);
    s.noteAgentSettled(F1);
    s.remove(F1);
    const afterRemove = s.stateOf(F1);
    const removedEvent = h.events[h.events.length - 1];
    return {
      ok: afterRemove === 'close' && removedEvent.state === 'close',
      why: `${afterRemove} event:${JSON.stringify(removedEvent)}`,
    };
  })();
  report('T10 remove broadcasts close', t10.ok, t10.why);

  const t11 = await (async () => {
    const h = freshHarness(mod, { files: [F1, F2] });
    const s = h.make();
    s.notePrompt(F1);
    s.noteViews(F1, 1);
    s.flush();
    h.existing.delete(F2);
    const s2 = h.make();
    s2.load();
    const missing = s2.stateOf(F2);
    const kept = s2.stateOf(F1);
    return { ok: missing === 'close' && kept === 'working', why: `missing:${missing} kept:${kept}` };
  })();
  report('T11 restart drops entries whose session file vanished', t11.ok, t11.why);

  const t12 = await (async () => {
    const h = freshHarness(mod, { files: [F1] });
    const s = h.make();
    s.notePrompt(F1);
    s.noteAgentRunning(F1);
    await s.probeNest(
      async () => ({ states: [{ agentId: F1, status: 'running' }] }),
      async () => 'ok',
    );
    const stillWorking = s.stateOf(F1);
    s.noteAgentSettled(F1);
    const settled = s.stateOf(F1);
    return { ok: stillWorking === 'working' && settled === 'unread', why: `${stillWorking}→${settled}` };
  })();
  report('T12 probe keeps live runs working, later settle still applies', t12.ok, t12.why);

  const t13 = await (async () => {
    const h = freshHarness(mod, { files: [F1] });
    const s = h.make();
    s.notePrompt(F1);
    s.noteAgentRunning(F1);
    s.noteAgentSettled(F1);
    s.noteVisit(F1);
    const state = s.stateOf(F1);
    s.noteViews(F1, 1);
    const withView = s.stateOf(F1);
    s.noteViews(F1, 0);
    const afterClose = s.stateOf(F1);
    return {
      ok: state === 'open' && withView === 'open' && afterClose === 'close',
      why: `${state}/${withView}/${afterClose}`,
    };
  })();
  report('T13 visit arriving before the view-open signal still clears to open', t13.ok, t13.why);

  const t14 = await (async () => {
    const h = freshHarness(mod, { files: [F1] });
    const s = h.make();
    s.notePrompt(F1);
    s.flush();
    const w1 = s.writeCount();
    s.notePrompt(F1);
    s.noteViews(F1, 1);
    s.noteViews(F1, 0);
    s.flush();
    const w2 = s.writeCount();
    s.noteAgentRunning(F1);
    s.flush();
    const w3 = s.writeCount();
    s.noteAgentSettled(F1);
    s.flush();
    const w4 = s.writeCount();
    return {
      ok: w1 === 1 && w2 === 1 && w3 === 1 && w4 === 2,
      why: `writes ${w1}/${w2}/${w3}/${w4} (want 1/1/1/2)`,
    };
  })();
  report('T14 persistence writes only when the persisted shape changes', t14.ok, t14.why);

  console.log(isFailed() ? 'session-states checks FAILED' : 'session-states checks passed');
  process.exitCode = isFailed() ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
