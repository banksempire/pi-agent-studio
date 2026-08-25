const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PRODUCT_ROOT = path.join(__dirname, '..');
const NEST = path.join(PRODUCT_ROOT, 'src', 'pi-nest', 'src');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-'));

let failed = false;
const report = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗ FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let nextCronTime, countCronMatches, cronError, cronMatches, openJournal, Scheduler, _computeNextDue;

async function loadModules() {
  ({ nextCronTime, countCronMatches, cronError, cronMatches } = await import(
    pathToFileURL(path.join(NEST, 'cron.mjs')).href
  ));
  ({ openJournal } = await import(pathToFileURL(path.join(NEST, 'journal.mjs')).href));
  ({ Scheduler, _computeNextDue } = await import(pathToFileURL(path.join(NEST, 'scheduler.mjs')).href));
}

function ts(str) {
  return Date.parse(str);
}

async function cronTests() {
  console.log('cron parser');
  const T = (name, a, b) => report(name, a === b, `${a} !== ${b}`);

  T('daily midnight', nextCronTime('0 0 * * *', ts('2026-01-15T10:07:30Z')), ts('2026-01-16T00:00:00Z'));
  T(
    'exact minute boundary is exclusive',
    nextCronTime('*/15 * * * *', ts('2026-01-15T10:00:00Z')),
    ts('2026-01-15T10:15:00Z'),
  );
  T('step list', nextCronTime('*/15 * * * *', ts('2026-01-15T10:07:30Z')), ts('2026-01-15T10:15:00Z'));
  T('range', nextCronTime('0 9-17 * * *', ts('2026-01-15T18:00:00Z')), ts('2026-01-16T09:00:00Z'));
  T('list', nextCronTime('5,35 * * * *', ts('2026-01-15T10:06:00Z')), ts('2026-01-15T10:35:00Z'));
  T('dow names', nextCronTime('0 3 * * mon-fri', ts('2026-01-16T18:00:00Z')), ts('2026-01-19T03:00:00Z'));
  T('month name', nextCronTime('0 0 1 jan *', ts('2026-06-01T00:00:00Z')), ts('2027-01-01T00:00:00Z'));
  T('dow 7 = sunday', cronMatches('0 0 * * 7', new Date('2026-01-18T00:00:00')), true);
  T('feb 29 never (within a year)', nextCronTime('0 0 29 2 *', ts('2026-03-01T00:00:00Z')), null);
  report('rejects 61 minutes', cronError('61 * * * *') !== null);
  report('rejects 4 fields', cronError('0 0 * *') !== null);
  report('accepts valid', cronError('*/5 1-6 1,15 * mon,wed,fri') === null);
  T(
    'count daily over 3d',
    countCronMatches('0 0 * * *', ts('2026-01-15T00:00:00Z'), ts('2026-01-18T00:00:00Z')),
    3,
  );
  T(
    'vixie dom/dow OR: 13th or friday',
    nextCronTime('0 0 13 * 5', ts('2026-01-01T00:00:00Z')),
    ts('2026-01-02T00:00:00Z'),
  );

  const localMidnight = new Date();
  localMidnight.setHours(0, 0, 0, 0);
  const inAYear = new Date(localMidnight.getTime() + 365 * 864e5);
  let t = nextCronTime('0 0 * * *', Date.now());
  let guard = 0;
  while (t !== null && t < inAYear.getTime() && guard++ < 400) {
    const d = new Date(t);
    if (d.getHours() !== 0 || d.getMinutes() !== 0) {
      report('every occurrence is midnight local', false, String(t));
      t = null;
      break;
    }
    t = nextCronTime('0 0 * * *', t);
  }
  report('daily chain all midnight local (1y)', t !== null);
}

function fakeRegistry({ failPrompt = false } = {}) {
  const prompts = [];
  const prefs = [];
  let seq = 0;
  const byCwd = new Map();
  return {
    prompts,
    prefs,
    createSession(_cwd) {
      const file = path.join(TMP, `sess-${++seq}.jsonl`);
      fs.writeFileSync(file, '');
      return { file };
    },
    reuseOrCreateSession(cwd) {
      if (!byCwd.has(cwd)) {
        const file = path.join(TMP, `reuse-${byCwd.size + 1}.jsonl`);
        fs.writeFileSync(file, '');
        byCwd.set(cwd, file);
      }
      return { file: byCwd.get(cwd) };
    },
    setPendingModel(file, model, thinkLevel) {
      prefs.push({ file, model, thinkLevel });
    },
    async prompt(file, message, opts = {}) {
      prompts.push({ file, message, opts });
      if (failPrompt) throw new Error('prompt exploded');
      return undefined;
    },
  };
}

function makeJournal(name) {
  return openJournal(path.join(TMP, `${name}.db`));
}

function onceJob(over = {}) {
  const now = Date.now();
  return {
    id: `j${Math.random().toString(36).slice(2, 8)}`,
    name: 'test job',
    enabled: true,
    kind: 'message',
    scheduleType: 'once',
    runAt: now - 1000,
    cron: null,
    payload: { message: 'hello job', target: { mode: 'new', cwd: TMP } },
    nextDue: now - 1000,
    missedPolicy: 'coalesce',
    createdBy: 'test',
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function cronJob(expr, over = {}) {
  return onceJob({
    scheduleType: 'cron',
    cron: expr,
    runAt: null,
    nextDue: nextCronTime(expr, Date.now() - 86400000 * 3),
    ...over,
  });
}

async function schedulerTests() {
  console.log('scheduler core');

  {
    const jr = makeJournal('fire-once');
    const reg = fakeRegistry();
    const jr_job = jr.insertJob(onceJob());
    const s = new Scheduler({ journal: jr, registry: reg });
    await s.tick();
    report('due once job fires exactly one prompt', reg.prompts.length === 1);
    report('prompt carries the message', reg.prompts[0]?.message === 'hello job');
    report('run recorded ok', jr.listRuns(jr_job.id)[0].status === 'ok');
    const after = jr.getJob(jr_job.id);
    report('once job disabled after firing', after.enabled === false);
    await s.tick();
    report('no refire on next tick', reg.prompts.length === 1);
    s.stop();
  }

  {
    const jr = makeJournal('not-due');
    const reg = fakeRegistry();
    jr.insertJob(onceJob({ runAt: Date.now() + 3600_000, nextDue: Date.now() + 3600_000 }));
    const s = new Scheduler({ journal: jr, registry: reg });
    await s.tick();
    report('future job does not fire', reg.prompts.length === 0);
    s.stop();
  }

  {
    const jr = makeJournal('disabled');
    const reg = fakeRegistry();
    jr.insertJob(onceJob({ enabled: false }));
    const s = new Scheduler({ journal: jr, registry: reg });
    await s.tick();
    report('disabled job does not fire', reg.prompts.length === 0);
    s.stop();
  }

  {
    const jr = makeJournal('cron-advance');
    const reg = fakeRegistry();
    const job = jr.insertJob(cronJob('0 3 * * *'));
    const s = new Scheduler({ journal: jr, registry: reg });
    await s.tick();
    const after = jr.getJob(job.id);
    const expect = nextCronTime('0 3 * * *', Date.now() - 60000);
    report(
      'cron next_due advanced past now',
      after.nextDue > Date.now() - 60000 && after.nextDue >= expect - 60000,
    );
    report('cron job stays enabled', after.enabled === true);
    await s.tick();
    report('cron job not refired within same period', reg.prompts.length === 1);
    s.stop();
  }

  {
    const jr = makeJournal('missed-skip');
    const reg = fakeRegistry();
    const job = jr.insertJob(cronJob('0 3 * * *', { missedPolicy: 'skip' }));
    const s = new Scheduler({ journal: jr, registry: reg });
    await s.tick();
    report('skip policy: missed run not fired', reg.prompts.length === 0);
    const runs = jr.listRuns(job.id);
    report('skip policy: run recorded as skipped', runs[0]?.status === 'skipped');
    report('skip policy: next_due advanced', jr.getJob(job.id).nextDue > Date.now());
    s.stop();
  }

  {
    const jr = makeJournal('missed-coalesce');
    const reg = fakeRegistry();
    jr.insertJob(cronJob('0 3 * * *', { missedPolicy: 'coalesce' }));
    const s = new Scheduler({ journal: jr, registry: reg });
    await s.tick();
    report('coalesce policy: fires exactly once', reg.prompts.length === 1);
    report('coalesce policy: next_due advanced', jr.getJob(jr.listJobs()[0].id).nextDue > Date.now());
    s.stop();
  }

  {
    const jr = makeJournal('slightly-late-skip');
    const reg = fakeRegistry();
    const expr = '0 3 1 6 *';
    const prev = nextCronTime(expr, Date.now() - 120 * 86400000);
    jr.insertJob(cronJob(expr, { missedPolicy: 'skip', nextDue: prev }));
    const s = new Scheduler({ journal: jr, registry: reg });
    await s.tick();
    report('skip policy still fires the just-due occurrence', reg.prompts.length === 1);
    s.stop();
  }

  {
    const jr = makeJournal('run-now');
    const reg = fakeRegistry();
    const job = jr.insertJob(onceJob({ runAt: Date.now() + 3600_000, nextDue: Date.now() + 3600_000 }));
    const s = new Scheduler({ journal: jr, registry: reg });
    const r = await s.runNow(job.id);
    report('run-now fires', r.ok === true && reg.prompts.length === 1);
    const after = jr.getJob(job.id);
    report('run-now leaves schedule untouched', after.enabled === true && after.nextDue === job.nextDue);
    report('run-now run recorded ok', jr.lastRun(job.id)?.status === 'ok');
    s.stop();
  }

  {
    const jr = makeJournal('target-modes');
    const reg = fakeRegistry();
    const sessFile = path.join(TMP, 'existing.jsonl');
    fs.writeFileSync(sessFile, '');
    const a = jr.insertJob(
      onceJob({ payload: { message: 'a', target: { mode: 'file', sessionFile: sessFile } } }),
    );
    const b = jr.insertJob(onceJob({ payload: { message: 'b', target: { mode: 'reuse', cwd: TMP } } }));
    const s = new Scheduler({ journal: jr, registry: reg });
    await s.tick();
    report(
      'file target prompts the exact session',
      reg.prompts.some((p) => p.file === sessFile),
    );
    const reusePrompts = reg.prompts.filter((p) => p.message === 'b');
    report('reuse target reuses one session', reusePrompts.length === 1 && !!reusePrompts[0].file);
    const runA = jr.lastRun(a.id);
    const runB = jr.lastRun(b.id);
    report(
      'runs record their session file',
      runA.sessionFile === sessFile && runB.sessionFile === reusePrompts[0].file,
    );
    s.stop();
  }

  {
    const jr = makeJournal('model-prefs');
    const reg = fakeRegistry();
    jr.insertJob(
      onceJob({
        payload: { message: 'm', target: { mode: 'new', cwd: TMP }, model: 'my-model', thinkLevel: 'high' },
      }),
    );
    const s = new Scheduler({ journal: jr, registry: reg });
    await s.tick();
    report(
      'model pref applied to new session',
      reg.prefs[0]?.model === 'my-model' && reg.prefs[0]?.thinkLevel === 'high',
    );
    s.stop();
  }

  {
    const jr = makeJournal('queue-item-id');
    const reg = {
      createSession: fakeRegistry().createSession,
      reuseOrCreateSession: fakeRegistry().reuseOrCreateSession,
      setPendingModel() {},
      async prompt(_file, _message, opts = {}) {
        opts.onQueued?.(4242);
      },
    };
    const job = jr.insertJob(onceJob());
    const s = new Scheduler({ journal: jr, registry: reg });
    await s.tick();
    report('onQueued queue item id recorded in run', jr.lastRun(job.id)?.queueItemId === 4242);
    s.stop();
  }

  {
    const jr = makeJournal('prompt-failure');
    const reg = fakeRegistry({ failPrompt: true });
    const job = jr.insertJob(cronJob('0 3 * * *'));
    const s = new Scheduler({ journal: jr, registry: reg });
    await s.tick();
    report('failed delivery records error run', jr.lastRun(job.id)?.status === 'error');
    report('failed cron still advances next_due', jr.getJob(job.id).nextDue > Date.now());
    s.stop();
  }

  {
    const jr = makeJournal('events');
    const reg = fakeRegistry();
    const events = [];
    const job = jr.insertJob(onceJob());
    const s = new Scheduler({ journal: jr, registry: reg, onEvent: (e) => events.push(e) });
    await s.tick();
    const actions = events.map((e) => e.action);
    report('fired + finished events emitted', actions.includes('fired') && actions.includes('finished'));
    report('event carries job snapshot', events[0]?.job?.id === job.id);
    s.stop();
  }
}

async function restartTests() {
  console.log('restart durability');

  {
    const jr = makeJournal('restart-catchup');
    const reg1 = fakeRegistry();
    const job = jr.insertJob(onceJob());
    const s1 = new Scheduler({ journal: jr, registry: reg1 });
    s1.stop();
    report('due job survives stop (no tick ran)', reg1.prompts.length === 0);
    const reg2 = fakeRegistry();
    const s2 = new Scheduler({ journal: jr, registry: reg2 });
    await s2.tick();
    report(
      'post-restart tick fires the due job once',
      reg2.prompts.length === 1 && reg1.prompts.length === 0,
    );
    report('no duplicate run rows', jr.listRuns(job.id).length === 1);
    await s2.tick();
    report('still no refire after second tick', reg2.prompts.length === 1);
    s2.stop();
  }

  {
    const jr = makeJournal('interrupted-sweep');
    const job = jr.insertJob(onceJob({ runAt: Date.now() + 3600_000, nextDue: Date.now() + 3600_000 }));
    const _runId = jr.insertRun(job.id);
    const s = new Scheduler({ journal: fakeRegistry() && jr, registry: fakeRegistry() });
    const swept = jr.sweepInterruptedRuns('backend restarted before delivery');
    report(
      'boot sweep marks queued run interrupted',
      swept === 1 && jr.listRuns(job.id)[0].status === 'interrupted',
    );
    s.stop();
  }

  {
    const jr = makeJournal('timer');
    const reg = fakeRegistry();
    const s = new Scheduler({ journal: jr, registry: reg, tickMs: 50 });
    jr.insertJob(onceJob({ runAt: Date.now() + 150, nextDue: Date.now() + 150 }));
    s.start();
    await delay(600);
    report('armed timer fires without waiting for full tick', reg.prompts.length === 1);
    s.stop();
  }
}

async function main() {
  await loadModules();
  await cronTests();
  await schedulerTests();
  await restartTests();

  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}

  if (failed) {
    console.error('\nFAILURES — scheduler check');
    return 1;
  }
  console.log('\nscheduler check passed');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
