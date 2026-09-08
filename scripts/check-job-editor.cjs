const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { chromium } = createRequire(path.join(__dirname, '..', 'package.json'))('playwright');
const { writeStubClient } = require('./lib/stub-backend.cjs');
const {
  assertMemoryHeadroom,
  installStackCleanup,
  spawnStackProc,
  sweepStaleStackProcesses,
} = require('./lib/suite-stack.cjs');

const PRODUCT_ROOT = path.join(__dirname, '..');
const RUN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'job-editor-dialog-'));
const SESSIONS_ROOT = path.join(RUN_ROOT, 'sessions');
const STATES_PATH = path.join(RUN_ROOT, 'states.json');
fs.mkdirSync(SESSIONS_ROOT, { recursive: true });

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function makeReporter() {
  let failed = false;
  const report = (name, ok, extra = '') => {
    console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
    if (!ok) failed = true;
  };
  return { report, isFailed: () => failed };
}

function killProc(child) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {}
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function waitHttp(url, label, tries = 40) {
  return (async () => {
    for (let i = 0; i < tries; i++) {
      await delay(500);
      try {
        const res = await new Promise((resolve, reject) => {
          const req = http.get(url, (r) => {
            r.resume();
            resolve(r.statusCode);
          });
          req.on('error', reject);
          req.setTimeout(1500, () => {
            req.destroy();
            reject(new Error('timeout'));
          });
        });
        if (res === 200) return true;
      } catch {}
    }
    throw new Error(`${label} did not come up`);
  })();
}

function writeSessionFile(name) {
  const dir = path.join(SESSIONS_ROOT, '--tmp-job-dialog--');
  fs.mkdirSync(dir, { recursive: true });
  const id = `019f${Math.random().toString(16).slice(2, 14)}`;
  const lines = [
    JSON.stringify({
      type: 'session',
      version: 3,
      id,
      parentId: null,
      timestamp: new Date().toISOString(),
      cwd: RUN_ROOT,
    }),
    JSON.stringify({
      type: 'message',
      id: `${name}-u0`,
      parentId: id,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: `${name} q0` }], timestamp: Date.now() },
    }),
    JSON.stringify({
      type: 'message',
      id: `${name}-a0`,
      parentId: `${name}-u0`,
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `${name} answer text` }],
        timestamp: Date.now(),
        stopReason: 'stop',
      },
    }),
  ];
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

(async () => {
  const { report, isFailed } = makeReporter();
  assertMemoryHeadroom({ label: 'check-job-editor' });
  sweepStaleStackProcesses('check-job-editor:stack');
  const procs = [];
  const browserRef = { current: null };
  installStackCleanup({ procs, stamp: 'check-job-editor:stack', browserRef, label: 'check-job-editor' });
  let browser;
  try {
    const backendPort = await freePort();
    const vitePort = await freePort();
    console.log(`stack: backend :${backendPort} vite :${vitePort}`);
    const stub = writeStubClient(RUN_ROOT);
    writeSessionFile('job-dialog-check');

    procs.push(
      spawnStackProc(spawn, 'check-job-editor:stack', 'node', ['src/pi-studio/server/index.mjs'], {
        cwd: PRODUCT_ROOT,
        env: {
          ...process.env,
          PI_STUDIO_PORT: String(backendPort),
          PI_STUDIO_CLIENT_MODULE: stub.stubPath,
          STUB_CONTROL_FILE: stub.controlPath,
          PI_STUDIO_SESSIONS: SESSIONS_ROOT,
          PI_STUDIO_STATES_PATH: STATES_PATH,
          PI_STUDIO_CWD: RUN_ROOT,
        },
        stdio: [
          'ignore',
          fs.openSync('/tmp/job-editor-dialog-backend.log', 'a'),
          fs.openSync('/tmp/job-editor-dialog-backend.log', 'a'),
        ],
      }),
    );
    await waitHttp(`http://127.0.0.1:${backendPort}/api/health`, 'backend');
    procs.push(
      spawnStackProc(
        spawn,
        'check-job-editor:stack',
        'node',
        [
          'node_modules/.bin/vite',
          '--config',
          'vite.config.ts',
          '--host',
          '127.0.0.1',
          '--port',
          String(vitePort),
        ],
        {
          cwd: PRODUCT_ROOT,
          env: { ...process.env, PI_API_PROXY: `http://127.0.0.1:${backendPort}` },
          stdio: [
            'ignore',
            fs.openSync('/tmp/job-editor-dialog-vite.log', 'a'),
            fs.openSync('/tmp/job-editor-dialog-vite.log', 'a'),
          ],
        },
      ),
    );
    await waitHttp(`http://127.0.0.1:${vitePort}/`, 'vite');

    browser = await chromium.launch();
    browserRef.current = browser;
    const errors = [];
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('503')) errors.push(`console: ${m.text()}`);
    });
    page.on('dialog', (d) => void d.accept());
    await page.goto(`http://127.0.0.1:${vitePort}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sf-docker', { timeout: 60000 });

    const itemSel = '.chat-list-item:has-text("job-dialog-check")';
    await page.waitForSelector(itemSel, { timeout: 60000 });
    await delay(1000);
    await page.locator(itemSel).first().click({ force: true });
    await page.waitForSelector('.chat-msg', { timeout: 20000 });
    report('chat window opens with message content', true);

    const CUSTOM_JOB = {
      id: 'deadbeef',
      name: 'custom-cron job',
      enabled: true,
      kind: 'message',
      scheduleType: 'cron',
      runAt: null,
      cron: '15 9,17 * * mon-fri',
      payload: { message: 'probe', target: { mode: 'new', cwd: '/tmp' } },
      nextDue: Date.now() + 3_600_000,
      missedPolicy: 'coalesce',
      createdBy: 'web',
      createdAt: Date.now() - 60_000,
      updatedAt: Date.now() - 60_000,
      lastRun: null,
    };
    const NONPEAK_JOB = {
      id: 'cafe0bad',
      name: 'off-peak job',
      enabled: true,
      kind: 'message',
      scheduleType: 'nonpeak',
      runAt: null,
      cron: null,
      payload: {
        message: 'offpeak probe',
        target: { mode: 'new', cwd: '/tmp' },
        model: 'stub/stub-pro',
      },
      nextDue: Date.now() + 3_600_000,
      missedPolicy: 'coalesce',
      createdBy: 'web',
      createdAt: Date.now() - 120_000,
      updatedAt: Date.now() - 120_000,
      lastRun: null,
    };
    const STUB_RUNS = {
      runs: [
        {
          id: 2,
          jobId: 'deadbeef',
          queuedAt: Date.now() - 60_000,
          startedAt: Date.now() - 59_000,
          finishedAt: Date.now() - 50_000,
          status: 'ok',
          error: '',
          sessionFile: '/tmp/sessions/run-two.jsonl',
          queueItemId: null,
        },
        {
          id: 1,
          jobId: 'deadbeef',
          queuedAt: Date.now() - 300_000,
          startedAt: Date.now() - 299_000,
          finishedAt: Date.now() - 290_000,
          status: 'error',
          error: 'provider exploded',
          sessionFile: '/tmp/sessions/run-one.jsonl',
          queueItemId: null,
        },
      ],
    };

    const jobPosts = [];
    const jobPatches = [];
    const jobDeletes = [];
    const jobRuns = [];
    const schedulerInfo = {
      running: 1,
      waiting: 2,
      limits: { globalMax: 2, providerMax: 2, modelMax: 1 },
    };
    const jobConfigPatches = [];
    await page.route('**/api/scheduler/config', async (route) => {
      if (route.request().method() !== 'PATCH') {
        await route.continue();
        return;
      }
      const body = route.request().postDataJSON();
      jobConfigPatches.push(body);
      Object.assign(schedulerInfo.limits, body);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ config: schedulerInfo.limits }),
      });
    });
    await page.route('**/api/jobs', async (route) => {
      const method = route.request().method();
      if (method === 'POST') {
        jobPosts.push(route.request().postDataJSON());
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ job: { ...NONPEAK_JOB, id: 'posted1', name: 'posted job' } }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jobs: [CUSTOM_JOB, NONPEAK_JOB], scheduler: schedulerInfo }),
      });
    });
    await page.route('**/api/jobs/**', async (route) => {
      const url = new URL(route.request().url());
      const parts = url.pathname.split('/').filter(Boolean);
      const method = route.request().method();
      const jobId = decodeURIComponent(parts[2] ?? '');
      if (parts[3] === 'runs') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(STUB_RUNS),
        });
        return;
      }
      if (parts[3] === 'run' && method === 'POST') {
        jobRuns.push(jobId);
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
        return;
      }
      if (method === 'PATCH') {
        jobPatches.push({ id: jobId, body: route.request().postDataJSON() });
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ job: CUSTOM_JOB }),
        });
        return;
      }
      if (method === 'DELETE') {
        jobDeletes.push(jobId);
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
        return;
      }
      await route.continue();
    });
    const STUB_MODELS = [
      {
        id: 'stub-pro',
        provider: 'stub',
        name: 'Stub Pro',
        reasoning: true,
        contextWindow: 200000,
        thinkingLevels: ['off', 'low', 'high'],
      },
      {
        id: 'stub-mini',
        provider: 'stub',
        name: 'Stub Mini',
        reasoning: false,
        contextWindow: 100000,
        thinkingLevels: ['off'],
      },
    ];
    await page.route('**/api/models*', async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      const withFile = url.searchParams.get('file');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          models: STUB_MODELS,
          default: null,
          current: withFile ? STUB_MODELS[0] : null,
          currentThinkingLevel: withFile ? 'low' : null,
        }),
      });
    });

    const noDialog = () => page.evaluate(() => !document.querySelector('.sf-dialog'));

    await page.locator('.sf-menu-item', { hasText: 'Chat' }).click();
    await page.locator('.sf-menu-row', { hasText: 'Scheduled Jobs…' }).waitFor({ timeout: 5000 });
    await page.locator('.sf-menu-row', { hasText: 'Scheduled Jobs…' }).click();
    await page.locator('.sf-tab-label', { hasText: 'Scheduler' }).waitFor({ timeout: 10000 });
    await page.locator('.jobs-tab').waitFor({ timeout: 10000 });
    report('the Chat menu Scheduled Jobs… item opens a Scheduler workspace tab', true);

    const rows = page.locator('.jobs-tab .sf-tbl-row');
    await rows.first().waitFor({ timeout: 10000 });
    report(
      'the jobs table lists the scheduled jobs',
      (await page.locator('.jobs-tab .sf-tbl-row', { hasText: 'custom-cron job' }).count()) === 1 &&
        (await page.locator('.jobs-tab .sf-tbl-row', { hasText: 'off-peak job' }).count()) === 1,
    );

    const schedNote = await page.locator('.jobs-note').textContent();
    report(
      'the tab surfaces the scheduler concurrency line',
      schedNote.includes('1 running') &&
        schedNote.includes('2 waiting for a slot') &&
        schedNote.includes('1 per model'),
      String(schedNote),
    );

    const npRowText = await page
      .locator('.jobs-tab .sf-tbl-row', { hasText: 'off-peak job' })
      .first()
      .locator('.jobs-sched')
      .textContent();
    report(
      'non-peak jobs render an off-peak schedule in the table',
      npRowText.includes('off-peak daily') && npRowText.includes('stub/stub-pro'),
      String(npRowText),
    );

    await page
      .locator('.jobs-tab .sf-tbl-row', { hasText: 'off-peak job' })
      .first()
      .locator('.jobs-switch')
      .click();
    await delay(300);
    report(
      'the table switch patches the job enabled state',
      jobPatches.length === 1 && jobPatches[0].id === 'cafe0bad' && jobPatches[0].body.enabled === false,
      JSON.stringify(jobPatches),
    );

    await page
      .locator('.jobs-tab .sf-tbl-row', { hasText: 'custom-cron job' })
      .first()
      .locator('.sf-tbl-btn[title="Run now (schedule untouched)"]')
      .click();
    await delay(300);
    report(
      'run-now hits the job run endpoint',
      jobRuns.length === 1 && jobRuns[0] === 'deadbeef',
      JSON.stringify(jobRuns),
    );

    report(
      'the run history button is removed from the table actions',
      (await page.locator('.jobs-tab .sf-tbl-btn[title="Run history"]').count()) === 0,
    );

    await page.locator('.jobs-add').click();
    await page.locator('.sf-dialog-title', { hasText: 'New job' }).waitFor({ timeout: 10000 });
    report('the add button opens the job form in a popup', true);

    const onceDefaults = await page.evaluate(() => {
      const seg = document.querySelector('.je-sched-seg');
      const on = seg?.querySelector('.sf-pill-item--on');
      return {
        modes: seg?.querySelectorAll('.sf-pill-item').length ?? 0,
        selected: on?.textContent ?? '',
        periodicSeg: !!document.querySelector('.je-periodic-seg'),
        previewVisible: !!document.querySelector('.je-cron-preview'),
        rawInputVisible: !!document.querySelector('input[placeholder="0 9 * * *"]'),
        runAtVisible: !!document.querySelector('input[type="datetime-local"]'),
      };
    });
    report(
      'the popup opens on Once with Once/Periodic/Advanced and no periodic picker',
      onceDefaults.modes === 3 &&
        onceDefaults.selected === 'Once' &&
        !onceDefaults.periodicSeg &&
        !onceDefaults.previewVisible &&
        !onceDefaults.rawInputVisible &&
        onceDefaults.runAtVisible,
      JSON.stringify(onceDefaults),
    );
    report(
      'advanced sub-type selector stays hidden for once jobs',
      (await page.locator('.je-adv-seg').count()) === 0,
    );

    const saveBtn = page.locator('.je-save');
    const disabledAtStart = await saveBtn.isDisabled();
    await page.locator('.je-input[placeholder="nightly maintenance"]').fill('check-suite job');
    const disabledAfterName = await saveBtn.isDisabled();
    await page.locator('.je-textarea').fill('run checks');
    const enabledAfterAll = await saveBtn.isEnabled();
    report(
      'save stays disabled until required fields are filled',
      disabledAtStart && disabledAfterName && enabledAfterAll,
      `empty=${disabledAtStart} nameOnly=${disabledAfterName} allFilled=${enabledAfterAll}`,
    );

    await page.locator('input[type="datetime-local"]').fill('2020-01-01T00:00');
    await delay(150);
    const pastHint = await page.evaluate(() =>
      [...document.querySelectorAll('.je-hint--warn')].some((h) =>
        (h.textContent ?? '').includes('run immediately'),
      ),
    );
    report('a past run-at warns and says the job fires immediately', pastHint);
    const soon = new Date(Date.now() + 3600_000);
    const pad = (n) => String(n).padStart(2, '0');
    await page
      .locator('input[type="datetime-local"]')
      .fill(
        `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}T${pad(soon.getHours())}:${pad(soon.getMinutes())}`,
      );
    await delay(150);

    await saveBtn.click();
    await delay(400);
    const posted = jobPosts[0];
    report(
      'saving posts a once job with runAt, target and createdBy',
      jobPosts.length === 1 &&
        posted.scheduleType === 'once' &&
        typeof posted.runAt === 'number' &&
        posted.name === 'check-suite job' &&
        posted.targetMode === 'new' &&
        posted.createdBy === 'web',
      JSON.stringify(posted),
    );
    report('the popup closes after saving', await noDialog());

    await page.keyboard.press('Escape');
    await delay(150);

    await page.locator('.jobs-add').click();
    await page.locator('.sf-dialog-title', { hasText: 'New job' }).waitFor({ timeout: 10000 });
    await page.locator('.je-input[placeholder="nightly maintenance"]').fill('builder probe');
    await page.locator('.je-textarea').fill('probe message');
    await delay(150);

    const modeBtn = (t) => page.locator('.je-sched-seg .sf-pill-item', { hasText: t });
    const periodicBtn = (t) => page.locator('.je-periodic-seg .sf-pill-item', { hasText: t });

    await modeBtn('Periodic').click();
    await delay(150);
    const periodicDefaults = await page.evaluate(() => {
      const seg = document.querySelector('.je-periodic-seg');
      return {
        visible: !!seg,
        options: seg ? [...seg.querySelectorAll('.sf-pill-item')].map((b) => b.textContent) : [],
        selected: seg?.querySelector('.sf-pill-item--on')?.textContent ?? '',
      };
    });
    report(
      'Periodic reveals the cadence selector with the five builders, Daily first',
      periodicDefaults.visible &&
        JSON.stringify(periodicDefaults.options) ===
          JSON.stringify(['Minutes', 'Hourly', 'Daily', 'Weekly', 'Monthly']) &&
        periodicDefaults.selected === 'Daily',
      JSON.stringify(periodicDefaults),
    );
    let cronRef = await page.locator('.je-cron-ref code').textContent();
    let cronDesc = await page.locator('.je-cron-desc').textContent();
    report(
      'daily mode builds a daily expression with synced reference',
      cronRef === '0 9 * * *' && !!cronDesc && cronDesc.includes('At 09:00'),
      `${cronRef} | ${cronDesc}`,
    );

    await periodicBtn('Weekly').click();
    await delay(150);
    cronRef = await page.locator('.je-cron-ref code').textContent();
    cronDesc = await page.locator('.je-cron-desc').textContent();
    report(
      'weekly pattern starts on weekdays',
      cronRef === '0 9 * * mon-fri' && !!cronDesc && cronDesc.includes('Mon–Fri'),
      `${cronRef} | ${cronDesc}`,
    );

    const mergeSplit = await page.evaluate(() => {
      const items = [...document.querySelectorAll('.sf-ms-item')];
      const pick = (t) => items.find((b) => b.textContent === t);
      const mon = pick('Mon');
      const sun = pick('Sun');
      const monBefore = getComputedStyle(mon, '::before');
      return {
        monOn: mon.classList.contains('sf-ms-item--on'),
        monStart: mon.classList.contains('sf-ms-item--start'),
        sunOff: !sun.classList.contains('sf-ms-item--on'),
        monBorder: monBefore.borderTopWidth,
        count: items.length,
      };
    });
    report(
      'the weekday selector renders a merged mon-fri run',
      mergeSplit.monOn &&
        mergeSplit.monStart &&
        mergeSplit.sunOff &&
        mergeSplit.monBorder === '1px' &&
        mergeSplit.count === 7,
      JSON.stringify(mergeSplit),
    );

    await page.locator('.sf-ms-item', { hasText: 'Wed' }).click();
    await delay(150);
    const splitRuns = await page.evaluate(() => {
      const items = [...document.querySelectorAll('.sf-ms-item')];
      const pick = (t) => items.find((b) => b.textContent === t);
      return {
        wedOn: pick('Wed').classList.contains('sf-ms-item--on'),
        tueIsEnd: pick('Tue').classList.contains('sf-ms-item--end'),
        thuIsStart: pick('Thu').classList.contains('sf-ms-item--start'),
      };
    });
    report(
      'deselecting a middle day splits the run into two boxes',
      !splitRuns.wedOn && splitRuns.tueIsEnd && splitRuns.thuIsStart,
      JSON.stringify(splitRuns),
    );
    const rectsBefore = await page.evaluate(() => {
      const track = document.querySelector('.sf-ms-track');
      const items = [...track.querySelectorAll('.sf-ms-item')];
      const snap = (el) => [
        Math.round(el.getBoundingClientRect().left * 10),
        Math.round(el.getBoundingClientRect().width * 10),
      ];
      return { track: snap(track), items: items.map(snap) };
    });
    await page.locator('.sf-ms-item', { hasText: 'Wed' }).click();
    await delay(150);
    cronRef = await page.locator('.je-cron-ref code').textContent();
    report('re-selecting the day rebuilds mon-fri', cronRef === '0 9 * * mon-fri', String(cronRef));
    const rectsAfter = await page.evaluate(() => {
      const track = document.querySelector('.sf-ms-track');
      const items = [...track.querySelectorAll('.sf-ms-item')];
      const snap = (el) => [
        Math.round(el.getBoundingClientRect().left * 10),
        Math.round(el.getBoundingClientRect().width * 10),
      ];
      return { track: snap(track), items: items.map(snap) };
    });
    report(
      'toggling day boxes never shifts positions or changes box lengths',
      JSON.stringify(rectsBefore) === JSON.stringify(rectsAfter),
      `${JSON.stringify(rectsBefore.items)} vs ${JSON.stringify(rectsAfter.items)}`,
    );

    await periodicBtn('Minutes').click();
    await delay(150);
    const minutesOptions = await page.evaluate(() =>
      [...document.querySelectorAll('.je-every-seg .sf-pill-item')].map((b) => b.textContent),
    );
    report(
      'minutes mode offers the requested interval options in a selector',
      JSON.stringify(minutesOptions) ===
        JSON.stringify(['1', '2', '3', '4', '5', '10', '15', '20', '30', '40', '50']),
      JSON.stringify(minutesOptions),
    );
    await page.locator('.je-every-seg .sf-pill-item', { hasText: '30' }).click();
    await delay(150);
    cronRef = await page.locator('.je-cron-ref code').textContent();
    cronDesc = await page.locator('.je-cron-desc').textContent();
    report(
      'minutes mode builds a step expression',
      cronRef === '*/30 * * * *' && !!cronDesc && cronDesc.includes('Every 30 min'),
      `${cronRef} | ${cronDesc}`,
    );

    await periodicBtn('Hourly').click();
    await delay(150);
    const hourlyOptions = await page.evaluate(() =>
      [...document.querySelectorAll('.je-atmin-seg .sf-pill-item')].map((b) => b.textContent),
    );
    report(
      'hourly mode offers minute options in a selector',
      hourlyOptions.length === 12 && hourlyOptions[0] === '00' && hourlyOptions[11] === '55',
      JSON.stringify(hourlyOptions),
    );
    await page.locator('.je-atmin-seg .sf-pill-item', { hasText: '15' }).click();
    await delay(150);
    cronRef = await page.locator('.je-cron-ref code').textContent();
    report('hourly mode builds a minute-of-hour expression', cronRef === '15 * * * *', String(cronRef));

    await modeBtn('Advanced').click();
    await delay(150);
    const advancedPrefill = await page.evaluate(() => ({
      visible: !!document.querySelector('input[placeholder="0 9 * * *"]'),
      value: document.querySelector('input[placeholder="0 9 * * *"]')?.value ?? '',
    }));
    report(
      'advanced mode prefills the raw input from the builder expression',
      advancedPrefill.visible && advancedPrefill.value === '15 * * * *',
      JSON.stringify(advancedPrefill),
    );

    await page.locator('input[placeholder="0 9 * * *"]').fill('99 * * * *');
    await delay(150);
    const previewBad = await page.evaluate(() => {
      const el = document.querySelector('.je-cron-preview');
      if (!el) return null;
      return {
        bad: el.classList.contains('je-cron-preview--bad'),
        err: el.querySelector('.je-cron-error')?.textContent ?? '',
      };
    });
    report(
      'invalid cron in advanced mode surfaces an inline error',
      !!previewBad && previewBad.bad && /not a valid/.test(previewBad.err),
      JSON.stringify(previewBad),
    );
    await page.locator('input[placeholder="0 9 * * *"]').fill('15 9,17 * * mon-fri');
    await delay(150);
    cronRef = await page.locator('.je-cron-ref code').textContent();
    report(
      'valid advanced expression updates the reference',
      cronRef === '15 9,17 * * mon-fri',
      String(cronRef),
    );

    const advDefaults = await page.evaluate(() => {
      const seg = document.querySelector('.je-adv-seg');
      const label = seg?.closest('.je-ctrl')?.querySelector('.je-label')?.textContent ?? '';
      return {
        visible: !!seg,
        label,
        selected: seg?.querySelector('.sf-pill-item--on')?.textContent ?? '',
        options: seg ? [...seg.querySelectorAll('.sf-pill-item')].map((b) => b.textContent) : [],
      };
    });
    report(
      'advanced opens with a labeled cron/off-peak sub-type, cron selected',
      advDefaults.visible &&
        advDefaults.label === 'Type' &&
        advDefaults.selected === 'cron' &&
        JSON.stringify(advDefaults.options) === JSON.stringify(['cron', 'off peak']),
      JSON.stringify(advDefaults),
    );

    await page.locator('.je-adv-seg .sf-pill-item', { hasText: 'off peak' }).click();
    await delay(200);
    const offPeakBlocked = {
      disabled: await saveBtn.isDisabled(),
      hint: await page.locator('.je-form-hint').textContent(),
      cronInputGone: (await page.locator('input[placeholder="0 9 * * *"]').count()) === 0,
      boxModel: await page.locator('.je-offpeak-box .je-mono').textContent(),
    };
    report(
      'off peak hides the cron field and blocks save without a model',
      offPeakBlocked.disabled &&
        /a model/.test(offPeakBlocked.hint ?? '') &&
        offPeakBlocked.cronInputGone &&
        offPeakBlocked.boxModel.includes('no model picked'),
      JSON.stringify(offPeakBlocked),
    );
    await page.locator('.je-model-btn').click();
    await page.waitForSelector('.sf-menu-pop', { timeout: 5000 });
    await page.locator('.sf-menu-row', { hasText: 'stub' }).hover();
    await page.locator('.sf-menu-row', { hasText: 'Stub Mini' }).hover();
    await page.locator('.sf-menu-row', { hasText: '(None)' }).waitFor({ timeout: 5000 });
    await page.locator('.sf-menu-row', { hasText: '(None)' }).click();
    await delay(300);
    const offPeakReady = {
      disabled: await saveBtn.isDisabled(),
      model: await page.locator('.je-model-btn-text').textContent(),
      boxModel: await page.locator('.je-offpeak-box .je-mono').textContent(),
    };
    report(
      'picking a model unblocks the off-peak save and shows the picked model',
      !offPeakReady.disabled &&
        /stub\/Stub Mini/.test(offPeakReady.model ?? '') &&
        offPeakReady.boxModel.includes('stub/stub-mini'),
      JSON.stringify(offPeakReady),
    );

    await saveBtn.click();
    await delay(400);
    const postedNonpeak = jobPosts[1];
    report(
      'saving an off-peak job posts nonpeak with no cron and the picked model',
      jobPosts.length === 2 &&
        postedNonpeak.scheduleType === 'nonpeak' &&
        postedNonpeak.cron === undefined &&
        postedNonpeak.model === 'stub/stub-mini' &&
        postedNonpeak.missedPolicy === 'coalesce',
      JSON.stringify(postedNonpeak),
    );
    report('the popup closes after the off-peak save', await noDialog());

    await page
      .locator('.jobs-tab .sf-tbl-row', { hasText: 'custom-cron job' })
      .first()
      .locator('.jobs-name')
      .click();
    await page.locator('.job-detail').waitFor({ timeout: 5000 });
    await delay(200);
    report('clicking a row selects it without opening any popup', await noDialog());
    const detailState = await page.evaluate(() => {
      const panel = document.querySelector('.job-detail');
      return {
        text: panel?.textContent ?? '',
        rowSelected: !!document.querySelector('.sf-tbl-row.jobs-row--sel'),
      };
    });
    report(
      'the SCHEDULER panel Detail subsection shows the job form content via KeyValueList',
      detailState.rowSelected &&
        detailState.text.includes('custom-cron job') &&
        detailState.text.includes('15 9,17 * * mon-fri') &&
        !detailState.text.includes('Status'),
      JSON.stringify(detailState).slice(0, 220),
    );
    report(
      'the Detail subsection is fixed-height and the History subsection is variable',
      await page.evaluate(() => {
        const detail = document.querySelector('[data-sub-body="job-detail"]');
        const history = document.querySelector('[data-sub-body="job-history"]');
        return (
          !!detail && detail.style.height === '' && !!history && /^\d+(\.\d+)?px$/.test(history.style.height)
        );
      }),
    );

    await page.locator('.jobs-run').first().waitFor({ timeout: 5000 });
    const historyRows = await page.locator('.jobs-run').count();
    const historyErr = await page.locator('.jobs-run-error').first().textContent();
    report(
      'the History subsection lists the selected job runs with status and errors',
      historyRows === 2 && (historyErr ?? '').includes('provider exploded'),
      `rows=${historyRows}`,
    );

    await page.locator('.sf-panel-tab', { hasText: 'Preference' }).click();
    await delay(200);
    const capVals = await page.evaluate(() =>
      [...document.querySelectorAll('.scheduler-prefs input[type="number"]')].map((i) => i.value),
    );
    report(
      'the Preference section hosts the concurrency cap config from the scheduler state',
      JSON.stringify(capVals) === JSON.stringify(['2', '2', '1']),
      JSON.stringify(capVals),
    );
    await page.locator('.scheduler-prefs input[type="number"]').first().fill('4');
    await page.locator('.sp-save').click();
    await delay(400);
    report(
      'saving the caps PATCHes the scheduler config endpoint',
      jobConfigPatches.length === 1 &&
        jobConfigPatches[0].globalMax === 4 &&
        jobConfigPatches[0].providerMax === 2 &&
        jobConfigPatches[0].modelMax === 1,
      JSON.stringify(jobConfigPatches),
    );
    const capAfter = await page.evaluate(() =>
      [...document.querySelectorAll('.scheduler-prefs input[type="number"]')].map((i) => i.value),
    );
    report(
      'the caps re-sync from the refreshed scheduler state after save',
      JSON.stringify(capAfter) === JSON.stringify(['4', '2', '1']),
      JSON.stringify(capAfter),
    );
    await page.locator('.sf-panel-tab', { hasText: 'Detail' }).click();
    await delay(200);

    await page
      .locator('.jobs-tab .sf-tbl-row', { hasText: 'custom-cron job' })
      .first()
      .locator('.jobs-name')
      .click();
    await delay(200);
    await page.locator('.job-detail-empty').waitFor({ timeout: 5000 });
    report(
      'clicking the selected row again deselects it back to the empty hint',
      (await page.locator('.job-detail-empty').count()) === 1 &&
        (await page.locator('.job-detail').count()) === 0,
    );
    await page
      .locator('.jobs-tab .sf-tbl-row', { hasText: 'custom-cron job' })
      .first()
      .locator('.jobs-name')
      .click();
    await page.locator('.job-detail').waitFor({ timeout: 5000 });

    await page
      .locator('.jobs-tab .sf-tbl-row', { hasText: 'custom-cron job' })
      .first()
      .locator('.sf-tbl-btn[title="Edit job"]')
      .click();
    await page
      .locator('.sf-dialog-title', { hasText: 'Edit job — custom-cron job' })
      .waitFor({ timeout: 10000 });
    await delay(400);
    const customState = await page.evaluate(() => {
      const seg = document.querySelector('.je-sched-seg');
      const on = seg?.querySelector('.sf-pill-item--on');
      return {
        patterns: seg?.querySelectorAll('.sf-pill-item').length ?? 0,
        selected: on?.textContent ?? '',
        ref: document.querySelector('.je-cron-ref code')?.textContent ?? '',
      };
    });
    report(
      'the row edit button opens the popup with an unrepresentable cron in Advanced, expression preserved',
      customState.patterns === 3 &&
        customState.selected === 'Advanced' &&
        customState.ref === '15 9,17 * * mon-fri',
      JSON.stringify(customState),
    );
    await modeBtn('Periodic').click();
    await delay(150);
    const rebuilt = await page.evaluate(() => {
      const seg = document.querySelector('.je-periodic-seg');
      return {
        patterns: seg?.querySelectorAll('.sf-pill-item').length ?? 0,
        selected: seg?.querySelector('.sf-pill-item--on')?.textContent ?? '',
        ref: document.querySelector('.je-cron-ref code')?.textContent ?? '',
      };
    });
    report(
      'switching Advanced to Periodic rebuilds the expression from the cadence picker',
      rebuilt.patterns === 5 && rebuilt.selected === 'Daily' && /^0 \d{1,2} \* \* \*$/.test(rebuilt.ref),
      JSON.stringify(rebuilt),
    );
    const metaVisible = await page.locator('.je-meta').isVisible();
    report('the edit popup shows the job meta line', metaVisible);
    await page.locator('.je-cancel').click();
    await delay(200);
    report(
      'cancel closes the edit popup, the selection and detail panel persist',
      (await noDialog()) &&
        ((await page.locator('.job-detail').textContent()) ?? '').includes('custom-cron job'),
    );

    await page
      .locator('.jobs-tab .sf-tbl-row', { hasText: 'off-peak job' })
      .first()
      .locator('.jobs-name')
      .click();
    await delay(300);
    report(
      'selecting another row retargets the panel with no popup',
      (await noDialog()) &&
        ((await page.locator('.job-detail').textContent()) ?? '').includes('off-peak job'),
    );
    await page.locator('.sf-subsection-util[title="Edit job"]').click();
    await page
      .locator('.sf-dialog-title', { hasText: 'Edit job — off-peak job' })
      .waitFor({ timeout: 10000 });
    await delay(400);
    const npState = await page.evaluate(() => {
      const seg = document.querySelector('.je-adv-seg');
      return {
        kind: seg?.querySelector('.sf-pill-item--on')?.textContent ?? '',
        schedMode: document.querySelector('.je-sched-seg .sf-pill-item--on')?.textContent ?? '',
        cronRef: document.querySelector('.je-cron-ref code')?.textContent ?? '',
        offpeakBox: !!document.querySelector('.je-offpeak-box'),
        model: document.querySelector('.je-model-btn-text')?.textContent ?? '',
      };
    });
    report(
      'a non-peak job round-trips into the popup from the panel edit button on the off-peak sub-type',
      npState.kind === 'off peak' &&
        npState.schedMode === 'Advanced' &&
        npState.cronRef === '' &&
        npState.offpeakBox &&
        /stub/.test(npState.model),
      JSON.stringify(npState),
    );
    await page.locator('.je-cancel').click();
    await delay(200);
    await page
      .locator('.jobs-tab .sf-tbl-row', { hasText: 'custom-cron job' })
      .first()
      .locator('.jobs-name')
      .click();
    await delay(200);

    await page
      .locator('.jobs-tab .sf-tbl-row', { hasText: 'custom-cron job' })
      .first()
      .locator('.sf-tbl-btn[title="Delete job"]')
      .click();
    await delay(400);
    report(
      'delete asks for confirmation and calls the delete endpoint',
      jobDeletes.length === 1 && jobDeletes[0] === 'deadbeef',
      JSON.stringify(jobDeletes),
    );
    await page.locator('.job-detail-empty').waitFor({ timeout: 5000 });
    report(
      'deleting the selected job clears the selection back to the empty hint',
      (await page.locator('.job-detail-empty').count()) === 1 &&
        (await page.locator('.job-detail').count()) === 0,
    );

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.jobs-tab', { timeout: 20000 });
    await page
      .locator('.jobs-tab .sf-tbl-row', { hasText: 'custom-cron job' })
      .first()
      .waitFor({ timeout: 10000 });
    report('refresh restores the open Scheduler tab with the jobs table', true);

    await page.setViewportSize({ width: 390, height: 844 });
    await delay(600);
    await page.locator('.jobs-add').click();
    await page.locator('.sf-dialog-title', { hasText: 'New job' }).waitFor({ timeout: 10000 });
    await delay(300);
    const mobileDialog = await page.evaluate(() => {
      const d = document.querySelector('.sf-dialog');
      const r = d?.getBoundingClientRect();
      const root = document.scrollingElement;
      return {
        w: Math.round(r?.width ?? 0),
        fits: !!r && r.left >= 0 && r.right <= window.innerWidth + 1,
        noPageOverflow: root.scrollWidth <= root.clientWidth + 1,
      };
    });
    report(
      'mobile: the job popup fits the viewport without page overflow',
      mobileDialog.w >= 300 && mobileDialog.w <= 392 && mobileDialog.fits && mobileDialog.noPageOverflow,
      JSON.stringify(mobileDialog),
    );
    const jobNoPan = await page.evaluate(() => {
      const card = document.querySelector('.sf-dialog');
      const body = card.querySelector('.sf-dialog-body');
      const wide = document.createElement('div');
      wide.style.width = '9999px';
      wide.style.height = '2px';
      body.appendChild(wide);
      const r = body.getBoundingClientRect();
      const track = card.querySelector('.sf-pill-track');
      let trackAfter = null;
      if (track) {
        track.scrollLeft = 40;
        trackAfter = track.scrollLeft;
        track.scrollLeft = 0;
      }
      const fonts = [
        ...new Set(
          [...card.querySelectorAll('input, select, textarea')].map((i) => getComputedStyle(i).fontSize),
        ),
      ];
      return {
        ox: getComputedStyle(body).overflowX,
        overflowReal: body.scrollWidth > body.clientWidth + 1,
        wheelX: Math.round(r.left + Math.min(140, r.width / 2)),
        wheelY: Math.round(r.top + r.height / 2),
        trackAfter,
        fonts,
      };
    });
    await page.mouse.move(jobNoPan.wheelX, jobNoPan.wheelY);
    await page.mouse.wheel(180, 0);
    await delay(200);
    const jobBodyAfter = await page.evaluate(() => {
      const body = document.querySelector('.sf-dialog-body');
      const v = body.scrollLeft;
      body.querySelector('div[style*="9999px"]')?.remove();
      return v;
    });
    report(
      'mobile: the job form dialog never pans horizontally, even with overflowing content',
      jobNoPan.ox === 'hidden' && jobNoPan.overflowReal && jobBodyAfter === 0,
      JSON.stringify({ ...jobNoPan, jobBodyAfter }),
    );
    report(
      'mobile: pill selectors inside the job dialog never swipe-scroll',
      jobNoPan.trackAfter === 0,
      JSON.stringify(jobNoPan),
    );
    report(
      'mobile: every job-form input renders at 16px so iOS never zooms on focus',
      jobNoPan.fonts.length === 1 && jobNoPan.fonts[0] === '16px',
      JSON.stringify(jobNoPan),
    );
    const segSingleLine = await page.evaluate(() => {
      const measure = (sel) => {
        const seg = document.querySelector(sel);
        if (!seg) return null;
        const pills = [...seg.querySelectorAll('.sf-pill-item')];
        const rowsSet = new Set(pills.map((b) => Math.round(b.getBoundingClientRect().top)));
        return { pills: pills.length, rows: rowsSet.size };
      };
      return { kind: measure('.je-sched-seg') };
    });
    report(
      'mobile: schedule selector stays on a single line',
      segSingleLine?.kind?.pills === 3 && segSingleLine.kind.rows === 1,
      JSON.stringify(segSingleLine),
    );
    await page.locator('.je-sched-seg .sf-pill-item', { hasText: 'Periodic' }).click();
    await delay(400);
    const cadenceSingleLine = await page.evaluate(() => {
      const seg = document.querySelector('.je-periodic-seg');
      if (!seg) return null;
      const pills = [...seg.querySelectorAll('.sf-pill-item')];
      const rowsSet = new Set(pills.map((b) => Math.round(b.getBoundingClientRect().top)));
      return { pills: pills.length, rows: rowsSet.size };
    });
    report(
      'mobile: cadence selector stays on a single line',
      cadenceSingleLine?.pills === 5 && cadenceSingleLine.rows === 1,
      JSON.stringify(cadenceSingleLine),
    );
    await page.locator('.je-periodic-seg .sf-pill-item', { hasText: 'Weekly' }).click();
    await delay(400);
    const msSingleLine = await page.evaluate(() => {
      const track = document.querySelector('.sf-ms-track');
      if (!track) return null;
      const items = [...track.querySelectorAll('.sf-ms-item')];
      const rowsSet = new Set(items.map((b) => Math.round(b.getBoundingClientRect().top)));
      return { items: items.length, rows: rowsSet.size, wrap: getComputedStyle(track).flexWrap };
    });
    report(
      'mobile: day selector stays on a single line',
      msSingleLine?.items === 7 && msSingleLine.rows === 1,
      JSON.stringify(msSingleLine),
    );
    await page.locator('.je-cancel').click();
    await delay(200);

    report('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (e) {
    report('suite crashed', false, e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    for (const p of procs) killProc(p);
    fs.rmSync(RUN_ROOT, { recursive: true, force: true });
  }
  process.exit(isFailed() ? 1 : 0);
})();
