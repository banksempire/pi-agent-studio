const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const PRODUCT_ROOT = path.join(__dirname, '..');
const REGISTRY = path.join(PRODUCT_ROOT, 'src', 'pi-nest', 'src', 'registry.mjs');
const JOURNAL = path.join(PRODUCT_ROOT, 'src', 'pi-nest', 'src', 'journal.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-journal-'));

let failed = false;
const report = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗ FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};
const tick = () => new Promise((r) => setImmediate(r));
const ticks = async (n = 5) => {
  for (let i = 0; i < n; i++) await tick();
};

function fakeSession() {
  return {
    thinkingLevel: null,
    resolvePrompt: null,
    prompts: [],
    disposed: false,
    subscribe() {},
    dispose() {
      this.disposed = true;
    },
    prompt(message) {
      this.prompts.push(message);
      return new Promise((resolve) => {
        this.resolvePrompt = resolve;
      });
    },
    abort() {
      this.resolvePrompt?.();
    },
  };
}

function sessionFile(name) {
  const file = path.join(TMP, `${name}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'session', id: name })}\n`);
  return file;
}

function entry(id, role, text, ts, extra = {}) {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: new Date(ts).toISOString(),
    message: { role, content: [{ type: 'text', text }], timestamp: ts, ...extra },
  };
}

function writeTranscript(file, entries) {
  fs.writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
}

async function main() {
  const { AgentRegistry } = await import(pathToFileURL(REGISTRY).href);
  const { openJournal } = await import(pathToFileURL(JOURNAL).href);
  const db = (name) => path.join(TMP, `${name}.db`);

  {
    const j = openJournal(db('basic'));
    const A = sessionFile('basic-a');
    const id = j.enqueue(A, { message: 'm1', images: [{ data: 'x', mimeType: 'image/png' }] });
    report('enqueue inserts a queued row', id !== null && j.pendingCount() === 1);
    j.markInflight(id, 123);
    j.snapshotPartial(id, 'AB');
    const rows = j.pendingItems();
    report(
      'markInflight + snapshotPartial persist status and partial text',
      rows.length === 1 &&
        rows[0].status === 'inflight' &&
        rows[0].startedAt === 123 &&
        rows[0].partialText === 'AB' &&
        rows[0].images.length === 1 &&
        rows[0].message === 'm1',
    );
    j.remove(id);
    report('settle removes the row', j.pendingCount() === 0);
    j.close();
  }

  {
    const A1 = sessionFile('cls-embed');
    const A2 = sessionFile('cls-short');
    const A3 = sessionFile('cls-none');
    const A4 = sessionFile('cls-replay');
    const A5 = sessionFile('cls-advanced');
    const A6 = sessionFile('cls-queued');
    const j = openJournal(db('cls'));
    const now = Date.now();
    const seed = (file, status, message, extra = {}) => {
      const id = j.enqueue(file, { message });
      if (status === 'inflight') j.markInflight(id, extra.startedAt ?? now);
      if (extra.partial) j.snapshotPartial(id, extra.partial);
      return id;
    };
    writeTranscript(A1, [entry('u1', 'user', 'task', now)]);
    seed(A1, 'inflight', 'embed-orig', { partial: 'EMBED-PARTIAL' });
    writeTranscript(A2, [
      entry('u1', 'user', 'task', now),
      entry('a1', 'assistant', 'SHORT-ON-DISK', now + 1000, { stopReason: 'aborted' }),
    ]);
    seed(A2, 'inflight', 'short-orig', { partial: 'SHORT-PARTIAL' });
    writeTranscript(A3, [entry('u1', 'user', 'task', now)]);
    seed(A3, 'inflight', 'none-orig');
    writeTranscript(A4, [entry('u1', 'user', 'old task', now - 120_000)]);
    seed(A4, 'inflight', 'replay-me');
    writeTranscript(A5, [
      entry('u1', 'user', 'task', now),
      entry('u2', 'user', 'someone typed later', now + 60_000),
    ]);
    seed(A5, 'inflight', 'adv-orig');
    seed(A6, 'queued', 'queued-msg');
    j.close();

    const j2 = openJournal(db('cls'));
    report('journal rows survive a close/reopen crash-sim', j2.pendingCount() === 6);
    const r = new AgentRegistry({ journal: j2 });
    const f1 = fakeSession();
    const f2 = fakeSession();
    const f3 = fakeSession();
    const f4 = fakeSession();
    const f6 = fakeSession();
    r.attach(A1, f1);
    r.attach(A2, f2);
    r.attach(A3, f3);
    r.attach(A4, f4);
    r.attach(A6, f6);
    const counts = await r.recover();
    await ticks();
    report(
      'recovery classifies the resume matrix',
      counts.resumed === 3 && counts.replayed === 2 && counts.skipped === 1,
      JSON.stringify(counts),
    );
    report(
      'partial text not on disk is embedded in the nudge',
      f1.prompts[0]?.includes('EMBED-PARTIAL') && f1.prompts[0]?.includes('gateway restart'),
      f1.prompts[0] ?? 'no prompt',
    );
    report(
      'aborted assistant on disk gets the short nudge without the partial',
      f2.prompts[0]?.includes('Continue exactly where it stopped') &&
        !f2.prompts[0]?.includes('SHORT-PARTIAL'),
      f2.prompts[0] ?? 'no prompt',
    );
    report(
      'no output yet gets the respond nudge',
      f3.prompts[0]?.includes('restarted before you produced any reply'),
      f3.prompts[0] ?? 'no prompt',
    );
    report(
      'user entry never reached the transcript: verbatim replay',
      f4.prompts[0] === 'replay-me',
      f4.prompts[0] ?? 'no prompt',
    );
    report('session advanced while down: prompt skipped', r.state(A5).queueDepth === 0);
    report('queued rows replay verbatim', f6.prompts[0] === 'queued-msg', f6.prompts[0] ?? 'no prompt');
    const stillPending = j2.pendingItems();
    report(
      'skipped rows are dropped, resumed rows go back to inflight',
      stillPending.length === 5 && stillPending.every((x) => x.status === 'inflight'),
      JSON.stringify(stillPending.map((x) => [x.sessionFile.split('/').pop(), x.status])),
    );
    for (const f of [f1, f2, f3, f4, f6]) f.abort();
    await ticks();
    report('settled prompts remove their journal rows', j2.pendingCount() === 0);
    j2.close();
  }

  {
    const A = sessionFile('drain-a');
    const j = openJournal(db('drain'));
    const r = new AgentRegistry({ journal: j });
    const f = fakeSession();
    r.attach(A, f);
    const p1 = r.prompt(A, 'm1');
    r.prompt(A, 'm2');
    r.prompt(A, 'm3');
    await ticks();
    report('prompt flows mark inflight in the journal', j.pendingItems()[0]?.status === 'inflight');
    const drained = await r.drain({ timeoutMs: 100 });
    await ticks();
    report(
      'drain leaves queued + interrupted prompts durable',
      drained.queued === 2 && drained.interrupted === 1,
      JSON.stringify(drained),
    );
    const rows = j.pendingItems();
    report(
      'journal holds interrupted run and queued messages after drain abort',
      rows.find((x) => x.message === 'm1')?.status === 'inflight' &&
        rows.filter((x) => x.status === 'queued').length === 2,
    );
    await p1;
    await ticks();
    report('drained rows stay durable for the next boot', j.pendingCount() === 3);
    j.close();
  }

  {
    const A = sessionFile('spill-a');
    const spillPath = path.join(TMP, 'backend-spill.json');
    fs.writeFileSync(
      spillPath,
      JSON.stringify({
        spilledAt: Date.now(),
        entries: [
          { agentId: A, items: [{ message: 's1' }, { message: 's2' }] },
          { agentId: path.join(TMP, 'gone.jsonl'), items: [{ message: 's3' }] },
        ],
      }),
    );
    const j = openJournal(db('spill'), { spillPath });
    report(
      'legacy spill file imported as queued rows and consumed',
      !fs.existsSync(spillPath) && j.pendingCount() === 3,
    );
    const r = new AgentRegistry({ journal: j });
    const f = fakeSession();
    r.attach(A, f);
    const counts = await r.recover();
    await ticks();
    report(
      'spill import replays and prunes missing sessions',
      counts.replayed === 2 && counts.skipped === 1 && j.pendingCount() === 2,
      JSON.stringify(counts),
    );
    f.abort();
    await ticks();
    f.abort();
    await ticks();
    report('replayed spill rows settle out of the journal', j.pendingCount() === 0);
    j.close();
  }

  {
    const A = sessionFile('prefs-a');
    const j = openJournal(db('prefs'));
    j.ensureSession(A, '/tmp/prefs-cwd');
    j.setSessionPrefs(A, { model: 'mini', thinkLevel: 'high' });
    j.close();
    const j2 = openJournal(db('prefs'));
    const r = new AgentRegistry({ journal: j2 });
    await r.recover();
    const p = r.pendingInfo(A);
    report(
      'pending model/think prefs survive a restart',
      p?.model === 'mini' && p?.thinkLevel === 'high' && p?.cwd === '/tmp/prefs-cwd',
      JSON.stringify(p),
    );
    j2.close();
  }

  {
    const A = sessionFile('ui-a');
    const B = sessionFile('ui-b');
    const j = openJournal(db('ui'));
    j.saveUiStates([
      { file: A, state: 'working', error: '' },
      { file: B, state: 'unread', error: '' },
    ]);
    report(
      'ui states round-trip through the journal',
      j.loadUiStates().length === 2 && j.loadUiStates().some((e) => e.file === A && e.state === 'working'),
    );
    j.saveUiStates([{ file: B, state: 'error', error: 'boom' }]);
    const ui = j.loadUiStates();
    report(
      'ui states keep only the latest list',
      ui.length === 1 && ui[0].file === B && ui[0].state === 'error' && ui[0].error === 'boom',
    );
    j.close();

    const legacy = path.join(TMP, 'studio-session-states.json');
    fs.writeFileSync(
      legacy,
      JSON.stringify({ version: 1, entries: [{ file: A, state: 'error', error: 'legacy boom' }] }),
    );
    const j2 = openJournal(db('ui2'), { legacyStatesPath: legacy });
    const imported = j2.loadUiStates();
    report(
      'legacy states file imported once',
      imported.length === 1 && imported[0].file === A && imported[0].error === 'legacy boom',
    );
    j2.saveUiStates([]);
    report('clearing ui states empties the table', j2.loadUiStates().length === 0);
    j2.close();
  }

  {
    const A = sessionFile('mode-replay');
    const j = openJournal(db('mode'));
    const now = Date.now();
    writeTranscript(A, [entry('u1', 'user', 'task', now)]);
    const id = j.enqueue(A, { message: 'mode-orig' });
    j.markInflight(id, now);
    j.snapshotPartial(id, 'MODE-PARTIAL');
    j.close();
    const j2 = openJournal(db('mode'));
    const r = new AgentRegistry({ journal: j2 });
    const f = fakeSession();
    r.attach(A, f);
    await r.recover({ resumeMode: 'replay' });
    await ticks();
    report(
      'resume mode replay resubmits verbatim even with partial text',
      f.prompts[0] === 'mode-orig' && !f.prompts[0]?.includes('MODE-PARTIAL'),
      f.prompts[0] ?? 'no prompt',
    );
    const j3 = openJournal(db('mode2'));
    const B = sessionFile('mode-skip');
    writeTranscript(B, [entry('u1', 'user', 'task', Date.now())]);
    const id2 = j3.enqueue(B, { message: 'skip-orig' });
    j3.markInflight(id2, Date.now());
    const r2 = new AgentRegistry({ journal: j3 });
    const f2 = fakeSession();
    r2.attach(B, f2);
    const counts2 = await r2.recover({ resumeMode: 'skip' });
    await ticks();
    report(
      'resume mode skip drops interrupted rows without prompting',
      counts2.skipped === 1 && f2.prompts.length === 0 && j3.pendingCount() === 0,
      JSON.stringify(counts2),
    );
    j2.close();
    j3.close();
  }

  {
    const A = sessionFile('nojournal-a');
    const r = new AgentRegistry();
    const f = fakeSession();
    r.attach(A, f);
    const p = r.prompt(A, 'm1');
    await ticks();
    const drained = await r.drain({ timeoutMs: 50 });
    await p;
    report(
      'journal-less registry still prompts and drains',
      f.prompts[0] === 'm1' && drained.queued === 0 && drained.interrupted === 0,
    );
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(failed ? 'registry journal check: FAIL' : 'registry journal check: OK');
  return failed ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
