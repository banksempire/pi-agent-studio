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
const RUN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'job-editor-font-'));
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
  const dir = path.join(SESSIONS_ROOT, '--tmp-job-font--');
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
    writeSessionFile('job-font-check');

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
          fs.openSync('/tmp/job-editor-font-backend.log', 'a'),
          fs.openSync('/tmp/job-editor-font-backend.log', 'a'),
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
            fs.openSync('/tmp/job-editor-font-vite.log', 'a'),
            fs.openSync('/tmp/job-editor-font-vite.log', 'a'),
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
    await page.goto(`http://127.0.0.1:${vitePort}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sf-docker', { timeout: 60000 });

    const itemSel = '.chat-list-item:has-text("job-font-check")';
    await page.waitForSelector(itemSel, { timeout: 60000 });
    await delay(1000);
    await page.locator(itemSel).first().click({ force: true });
    await page.waitForSelector('.chat-msg', { timeout: 20000 });
    report('chat window opens with message content', true);

    const chatRef = await page.evaluate(() => {
      const px = (sel) => {
        const el = document.querySelector(sel);
        return el ? Number.parseFloat(getComputedStyle(el).fontSize) : null;
      };
      return { msg: px('.chat-msg'), input: px('.chat-input') };
    });

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
      createdAt: Date.now() - 60_000,
      updatedAt: Date.now() - 60_000,
      lastRun: null,
    };
    const jobPosts = [];
    await page.route('**/api/jobs', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            jobs: [CUSTOM_JOB, NONPEAK_JOB],
            scheduler: { running: 1, waiting: 2, limits: { globalMax: 2, providerMax: 2, modelMax: 1 } },
          }),
        });
        return;
      }
      jobPosts.push(route.request().postDataJSON());
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ job: { ...NONPEAK_JOB, id: 'posted1', name: 'posted job' } }),
      });
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

    await page.locator('.sf-docker-app[title="Scheduler"]').click();
    await page.waitForSelector('.sf-subsection-util[title="New Job"]', { timeout: 10000 });
    await page.locator('.sf-subsection-util[title="New Job"]').click();
    await page.waitForSelector('.job-editor', { timeout: 20000 });
    report('job editor opens in a workspace window', true);

    const modeBtn = (t) => page.locator('.je-sched-seg .sf-pill-item', { hasText: t });

    const onceDefaults = await page.evaluate(() => {
      const seg = document.querySelector('.je-sched-seg');
      const on = seg?.querySelector('.sf-pill-item--on');
      return {
        modes: seg?.querySelectorAll('.sf-pill-item').length ?? 0,
        selected: on?.textContent ?? '',
        previewVisible: !!document.querySelector('.je-cron-preview'),
        rawInputVisible: !!document.querySelector('input[placeholder="0 9 * * *"]'),
        runAtVisible: !!document.querySelector('input[type="datetime-local"]'),
      };
    });
    report(
      'schedule selector opens on Once with all seven modes and no cron UI',
      onceDefaults.modes === 7 &&
        onceDefaults.selected === 'Once' &&
        !onceDefaults.previewVisible &&
        !onceDefaults.rawInputVisible &&
        onceDefaults.runAtVisible,
      JSON.stringify(onceDefaults),
    );
    report(
      'advanced sub-type selector stays hidden for once jobs',
      (await page.locator('.je-adv-seg').count()) === 0,
    );
    await page.waitForSelector('.jobs-sched-line', { timeout: 10000 });
    const schedLineText = await page.locator('.jobs-sched-line').textContent();
    report(
      'jobs panel surfaces the scheduler concurrency line',
      schedLineText.includes('1 running') &&
        schedLineText.includes('2 waiting for a slot') &&
        schedLineText.includes('1 per model'),
      String(schedLineText),
    );
    const npRowText = await page
      .locator('.jobs-item', { hasText: 'off-peak job' })
      .first()
      .locator('.jobs-item-sched')
      .textContent();
    report(
      'non-peak jobs render an off-peak schedule in the list',
      npRowText.includes('off-peak daily') && npRowText.includes('stub/stub-pro'),
      String(npRowText),
    );

    const modelBtn = page.locator('.je-model-btn');
    await modelBtn.waitFor({ timeout: 10000 });
    await page.locator('.je-model-btn-text', { hasText: 'Session default' }).waitFor({ timeout: 10000 });
    const modelDefaultText = await page.locator('.je-model-btn-text').textContent();
    await modelBtn.click();
    await page.waitForSelector('.sf-menu-pop', { timeout: 5000 });
    await page.locator('.sf-menu-row', { hasText: 'stub' }).hover();
    await page.locator('.sf-menu-row', { hasText: 'Stub Pro' }).waitFor({ timeout: 5000 });
    await page.locator('.sf-menu-row', { hasText: 'Stub Pro' }).hover();
    await page.locator('.sf-menu-row', { hasText: 'high' }).waitFor({ timeout: 5000 });
    await page.locator('.sf-menu-row', { hasText: 'high' }).click();
    await delay(300);
    const modelAfter = await page.locator('.je-model-btn-text').textContent();
    const clearVisible = await page.locator('.je-model-clear').isVisible();
    await page.locator('.je-model-clear').click();
    await delay(150);
    const modelCleared = await page.locator('.je-model-btn-text').textContent();
    report(
      'model override uses the multi-level menu and shows provider/name·level',
      modelDefaultText === 'Session default' &&
        modelAfter === 'stub/Stub Pro·high' &&
        clearVisible &&
        modelCleared === 'Session default',
      `${modelDefaultText} → ${modelAfter} → ${modelCleared}`,
    );

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.job-editor', { timeout: 20000 });
    const restoredTitle = await page.locator('.job-editor-title-main').textContent();
    await page.locator('.je-model-btn').waitFor({ timeout: 10000 });
    const restoredModelBtn = await page.locator('.je-model-btn-text').textContent();
    const restoredModelDisabled = await page.locator('.je-model-btn').isDisabled();
    report(
      'refresh restores the open job editor tab with a loaded model catalog',
      restoredTitle === 'New Job' && restoredModelBtn === 'Session default' && !restoredModelDisabled,
      `title=${restoredTitle} btn=${restoredModelBtn} disabled=${restoredModelDisabled}`,
    );

    const expandRight = page.locator('.sf-tab-panel-toggle[title="Expand Right Panel"]');
    if ((await expandRight.count()) > 0) await expandRight.first().click();
    await page.locator('.sf-tab-label', { hasText: 'job-font-check' }).first().click();
    await delay(1200);
    const pickerAfterRefresh = await page.evaluate(() => {
      const el = document.querySelector('.model-menu');
      return {
        text: el ? el.textContent : '',
        err: document.querySelector('.model-menu-note--err')?.textContent ?? '',
      };
    });
    report(
      'refresh restores chat tabs and the model picker loads the active session model',
      pickerAfterRefresh.text.includes('stub') &&
        pickerAfterRefresh.text.includes('Stub Pro') &&
        pickerAfterRefresh.text.includes('low') &&
        !pickerAfterRefresh.text.includes('Open a chat window') &&
        !pickerAfterRefresh.err,
      JSON.stringify(pickerAfterRefresh),
    );
    await page.locator('.sf-tab-label', { hasText: 'New Job' }).first().click();
    await delay(400);

    const pickerStyle = await page.evaluate(() => {
      const el = document.querySelector('input[type="datetime-local"]');
      if (!el) return null;
      const cs = getComputedStyle(el);
      let nativeHidden = false;
      for (const sheet of document.styleSheets) {
        let rules;
        try {
          rules = sheet.cssRules;
        } catch {
          continue;
        }
        for (const r of rules) {
          if (r.selectorText?.includes('calendar-picker-indicator') && r.style?.display === 'none')
            nativeHidden = true;
        }
      }
      return {
        appearance: cs.appearance,
        colorScheme: cs.colorScheme,
        icon: cs.backgroundImage.includes('svg'),
        padRight: cs.paddingRight,
        stroke: cs.backgroundImage.includes('%23cccccc'),
        nativeHidden,
      };
    });
    await page.evaluate(() => {
      window.__pickerCalls = 0;
      HTMLInputElement.prototype.showPicker = () => {
        window.__pickerCalls += 1;
      };
    });
    const dtBox = await page.locator('input[type="datetime-local"]').boundingBox();
    await page.mouse.click(dtBox.x + 12, dtBox.y + dtBox.height / 2);
    const callsAfterText = await page.evaluate(() => window.__pickerCalls);
    await page.mouse.click(dtBox.x + dtBox.width - 12, dtBox.y + dtBox.height / 2);
    const callsAfterIcon = await page.evaluate(() => window.__pickerCalls);
    await page.evaluate(() => {
      window.__pickerCalls = 0;
      delete HTMLInputElement.prototype.showPicker;
    });
    report(
      'run-at uses a light themed calendar icon that opens the picker',
      !!pickerStyle &&
        pickerStyle.appearance === 'none' &&
        pickerStyle.icon &&
        pickerStyle.stroke &&
        pickerStyle.padRight === '36px' &&
        pickerStyle.nativeHidden &&
        callsAfterText === 0 &&
        callsAfterIcon >= 1,
      JSON.stringify({ pickerStyle, callsAfterText, callsAfterIcon }),
    );

    await modeBtn('Daily').click();
    await delay(150);
    const builderHasAdvSeg = await page.locator('.je-adv-seg').count();
    report(
      'builder modes carry no schedule sub-type — off-peak lives under Advanced only',
      builderHasAdvSeg === 0,
      `advSeg=${builderHasAdvSeg}`,
    );
    let cronRef = await page.locator('.je-cron-ref code').textContent();
    let wdDesc = await page.locator('.je-cron-desc').textContent();
    report(
      'daily mode builds a daily expression with synced reference',
      cronRef === '0 9 * * *' && !!wdDesc && wdDesc.includes('At 09:00'),
      `${cronRef} | ${wdDesc}`,
    );

    await modeBtn('Weekly').click();
    await delay(150);
    cronRef = await page.locator('.je-cron-ref code').textContent();
    wdDesc = await page.locator('.je-cron-desc').textContent();
    report(
      'weekly pattern starts on weekdays',
      cronRef === '0 9 * * mon-fri' && !!wdDesc && wdDesc.includes('Mon–Fri'),
      `${cronRef} | ${wdDesc}`,
    );

    const runGeometry = await page.evaluate(() => {
      const items = [...document.querySelectorAll('.sf-ms-item')];
      const pick = (t) => items.find((b) => b.textContent === t);
      const geo = (el) => {
        const und = getComputedStyle(el, '::before');
        return {
          on: el.classList.contains('sf-ms-item--on'),
          start: el.classList.contains('sf-ms-item--start'),
          cont: el.classList.contains('sf-ms-item--cont'),
          left: und.borderTopLeftRadius,
          right: und.borderTopRightRadius,
          borderLeft: und.borderLeftWidth,
          borderRight: und.borderRightWidth,
          rightEdge: und.right,
        };
      };
      const ts = document.querySelector('.sf-ms-track')
        ? getComputedStyle(document.querySelector('.sf-ms-track'))
        : null;
      const inset = ts ? Number.parseFloat(ts.paddingTop) + Number.parseFloat(ts.borderTopWidth) : NaN;
      const gap = ts ? Number.parseFloat(ts.gap) : NaN;
      return {
        trackBorder: ts?.borderTopWidth ?? '',
        trackRadius: ts?.borderTopLeftRadius ?? '',
        expectedRadius: ts ? Number.parseFloat(ts.borderTopLeftRadius) - inset : NaN,
        gap,
        mon: geo(pick('Mon')),
        wed: geo(pick('Wed')),
        fri: geo(pick('Fri')),
        sun: geo(pick('Sun')),
      };
    });
    report(
      'consecutive weekdays merge into one rounded box inside the track',
      runGeometry.trackBorder === '1px' &&
        runGeometry.trackRadius === '8px' &&
        runGeometry.mon.on &&
        runGeometry.mon.start &&
        runGeometry.mon.right === '0px' &&
        runGeometry.wed.on &&
        runGeometry.wed.left === '0px' &&
        runGeometry.wed.right === '0px' &&
        runGeometry.wed.borderLeft === '0px' &&
        Number.isNaN(runGeometry.wed.rightEdge) === false &&
        runGeometry.fri.on &&
        !runGeometry.fri.cont &&
        runGeometry.fri.left === '0px' &&
        Number.parseFloat(runGeometry.fri.right) === runGeometry.expectedRadius &&
        !runGeometry.sun.on &&
        runGeometry.sun.left === '0px' &&
        runGeometry.sun.right === '0px' &&
        runGeometry.sun.rightEdge === 'auto',
      JSON.stringify(runGeometry),
    );

    const seamless = await page.evaluate(() => {
      const items = [...document.querySelectorAll('.sf-ms-item')];
      const pick = (t) => items.find((b) => b.textContent === t);
      const m = getComputedStyle(pick('Mon'));
      const mb = getComputedStyle(pick('Mon'), '::before');
      const w = getComputedStyle(pick('Wed'), '::before');
      const midJoin = Math.abs(
        pick('Mon').getBoundingClientRect().bottom - pick('Wed').getBoundingClientRect().bottom,
      );
      const junctions = [];
      for (let k = 0; k < items.length - 1; k++) {
        const a = items[k];
        const b = items[k + 1];
        const ca = getComputedStyle(a, '::before');
        const cb = getComputedStyle(b, '::before');
        if (ca.content === 'none' || cb.content === 'none') continue;
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const aRight = ra.right - Number.parseFloat(ca.right);
        const bLeft = rb.left + Number.parseFloat(cb.left);
        junctions.push({ pair: `${a.textContent}|${b.textContent}`, overlap: aRight - bLeft });
      }
      return {
        monTop: mb.borderTopWidth,
        wedTop: w.borderTopWidth,
        wedExtendsRight: w.right.startsWith('calc') || w.right.includes('-'),
        sameRow: midJoin === 0,
        underlayBehindItem: mb.zIndex === '-1',
        itemIsolated: m.isolation === 'isolate',
        junctions,
      };
    });
    report(
      'merged box has a single continuous border with no inner seams',
      seamless.monTop === '1px' &&
        seamless.wedTop === '1px' &&
        seamless.wedExtendsRight &&
        seamless.sameRow &&
        seamless.underlayBehindItem &&
        seamless.itemIsolated &&
        seamless.junctions.length === 4 &&
        seamless.junctions.every((j) => Math.abs(j.overlap) < 0.05),
      JSON.stringify(seamless),
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
    await page.locator('.sf-ms-item', { hasText: 'Wed' }).click();
    await delay(150);

    const rectsBefore = await page.evaluate(() => {
      const track = document.querySelector('.sf-ms-track');
      const items = [...track.querySelectorAll('.sf-ms-item')];
      const snap = (el) => {
        const r = el.getBoundingClientRect();
        return [Math.round(r.left * 10), Math.round(r.width * 10)];
      };
      return { track: snap(track), items: items.map(snap) };
    });
    await page.locator('.sf-ms-item', { hasText: 'Sat' }).click();
    await delay(150);
    const rectsAfter = await page.evaluate(() => {
      const track = document.querySelector('.sf-ms-track');
      const items = [...track.querySelectorAll('.sf-ms-item')];
      const snap = (el) => {
        const r = el.getBoundingClientRect();
        return [Math.round(r.left * 10), Math.round(r.width * 10)];
      };
      return { track: snap(track), items: items.map(snap) };
    });
    report(
      'selecting an item never shifts positions or changes box lengths',
      JSON.stringify(rectsBefore) === JSON.stringify(rectsAfter),
      `${JSON.stringify(rectsBefore.items)} vs ${JSON.stringify(rectsAfter.items)}`,
    );
    cronRef = await page.locator('.je-cron-ref code').textContent();
    report('day boxes extend the expression', cronRef === '0 9 * * mon-sat', String(cronRef));

    await page.locator('.sf-ms-item', { hasText: 'Sun' }).click();
    await page.locator('select.je-time[title="Hour"]').selectOption('3');
    await delay(150);
    cronRef = await page.locator('.je-cron-ref code').textContent();
    report('time selectors rewrite the expression', cronRef === '0 3 * * sun-sat', String(cronRef));

    const selectStyle = await page.evaluate(() => {
      const sel = document.querySelector('select.je-select');
      const ss = sel ? getComputedStyle(sel) : null;
      const opt = sel?.querySelector('option');
      const os = opt ? getComputedStyle(opt) : null;
      return {
        found: !!sel,
        appearance: ss?.appearance ?? '',
        arrow: ss?.backgroundImage?.includes('svg') ?? false,
        padRight: ss?.paddingRight ?? '',
        optionBg: os?.backgroundColor ?? '',
      };
    });
    report(
      'selects drop native chrome for a themed chevron and dark options',
      selectStyle.found &&
        selectStyle.appearance === 'none' &&
        selectStyle.arrow &&
        selectStyle.padRight === '32px' &&
        selectStyle.optionBg === 'rgb(37, 37, 38)',
      JSON.stringify(selectStyle),
    );

    const sizes = await page.evaluate(() => {
      const px = (sel) => {
        const el = document.querySelector(sel);
        return el ? Number.parseFloat(getComputedStyle(el).fontSize) : null;
      };
      return {
        titleMain: px('.job-editor-title-main'),
        label: px('.job-editor-field label'),
        input: px('.job-editor-input'),
        segBtn: px('.sf-pill-item'),
        schedSegBtn: px('.je-sched-seg .sf-pill-item'),
        chip: px('.sf-ms-item'),
        save: px('.job-editor-save'),
      };
    });
    const ref = chatRef.msg;
    report('chat message content renders at 16px', ref === 16, `${ref}px`);
    report(
      'chat input also matches (same window convention)',
      chatRef.input !== null && Math.abs(chatRef.input - ref) < 0.5,
      `${chatRef.input}px`,
    );
    for (const [name, val] of Object.entries(sizes)) {
      report(
        `job editor ${name} matches chat content size (${ref}px)`,
        val !== null && Math.abs(val - ref) < 0.5,
        `${val}px`,
      );
    }

    await modeBtn('Minutes').click();
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
    wdDesc = await page.locator('.je-cron-desc').textContent();
    report(
      'minutes mode builds a step expression',
      cronRef === '*/30 * * * *' && !!wdDesc && wdDesc.includes('Every 30 min'),
      `${cronRef} | ${wdDesc}`,
    );

    await modeBtn('Hourly').click();
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
    wdDesc = await page.locator('.je-cron-desc').textContent();
    report(
      'hourly mode builds a minute-of-hour expression',
      cronRef === '15 * * * *' && !!wdDesc && wdDesc.includes('Hourly at :15'),
      `${cronRef} | ${wdDesc}`,
    );

    await modeBtn('Advanced').click();
    await delay(150);
    const themedControls = await page.evaluate(() => {
      const cancel = [...document.querySelectorAll('.je-footer-actions button')].find((b) =>
        b.textContent?.includes('Cancel'),
      );
      const cs = cancel ? getComputedStyle(cancel) : null;
      return {
        cancelFound: !!cancel,
        cancelBg: cs?.backgroundColor ?? '',
        cancelBorder: cs?.borderTopColor ?? '',
      };
    });
    report(
      'footer buttons use the themed style, not the system default',
      themedControls.cancelFound &&
        themedControls.cancelBg === 'rgb(41, 41, 41)' &&
        themedControls.cancelBorder === 'rgb(58, 58, 58)',
      JSON.stringify(themedControls),
    );
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

    const cardCount = await page.locator('.je-card').count();
    await page.locator('.je-card').first().click();
    await delay(150);
    const targetState = {
      cards: cardCount,
      selected: await page.locator('.je-card--on').count(),
      sessionSelectVisible: await page.locator('select.job-editor-input').first().isVisible(),
    };
    report(
      'target cards switch modes and reveal the session picker',
      targetState.cards === 3 && targetState.selected === 1 && targetState.sessionSelectVisible,
      JSON.stringify(targetState),
    );

    const saveBtn = page.locator('.job-editor-save');
    const disabledAtStart = await saveBtn.isDisabled();
    await page.locator('.job-editor-body input[placeholder="nightly maintenance"]').fill('check-suite job');
    const disabledAfterName = await saveBtn.isDisabled();
    await page.locator('.job-editor-textarea').fill('run checks');
    const enabledAfterAll = await saveBtn.isEnabled();
    report(
      'save stays disabled until required fields are filled',
      disabledAtStart && disabledAfterName && enabledAfterAll,
      `empty=${disabledAtStart} nameOnly=${disabledAfterName} allFilled=${enabledAfterAll}`,
    );

    await modeBtn('Advanced').click();
    await delay(150);
    const advDefaults = await page.evaluate(() => {
      const seg = document.querySelector('.je-adv-seg');
      return {
        visible: !!seg,
        selected: seg?.querySelector('.sf-pill-item--on')?.textContent ?? '',
        options: seg ? [...seg.querySelectorAll('.sf-pill-item')].map((b) => b.textContent) : [],
        cronInputVisible: !!document.querySelector('input[placeholder="0 9 * * *"]'),
        offpeakBox: !!document.querySelector('.je-offpeak-box'),
      };
    });
    report(
      'advanced opens with cron and off peak sub-types, cron selected',
      advDefaults.visible &&
        advDefaults.selected === 'cron' &&
        JSON.stringify(advDefaults.options) === JSON.stringify(['cron', 'off peak']) &&
        advDefaults.cronInputVisible &&
        !advDefaults.offpeakBox,
      JSON.stringify(advDefaults),
    );

    await page.locator('.je-adv-seg .sf-pill-item', { hasText: 'off peak' }).click();
    await delay(200);
    const offPeakBlocked = {
      disabled: await saveBtn.isDisabled(),
      hint: await page.locator('.je-footer-hint').textContent(),
      cronInputGone: (await page.locator('input[placeholder="0 9 * * *"]').count()) === 0,
      boxModel: await page.locator('.je-offpeak-box .je-mono').textContent(),
      boxHint: await page.evaluate(() =>
        [...document.querySelectorAll('.je-hint')]
          .map((h) => h.textContent ?? '')
          .some((t) => t.includes('pick the model under Agent')),
      ),
    };
    report(
      'off peak hides the cron field and blocks save without a model',
      offPeakBlocked.disabled &&
        /a model/.test(offPeakBlocked.hint) &&
        offPeakBlocked.cronInputGone &&
        offPeakBlocked.boxModel.includes('no model picked') &&
        offPeakBlocked.boxHint,
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
      boxHint: await page.evaluate(() =>
        [...document.querySelectorAll('.je-hint')]
          .map((h) => h.textContent ?? '')
          .some((t) => t.includes('the scheduler decides')),
      ),
    };
    report(
      'picking a model unblocks the off-peak save and shows the picked model',
      !offPeakReady.disabled &&
        /stub\/Stub Mini/.test(offPeakReady.model) &&
        offPeakReady.boxModel.includes('stub/stub-mini') &&
        offPeakReady.boxHint,
      JSON.stringify(offPeakReady),
    );

    await saveBtn.click();
    await delay(300);
    const posted = jobPosts[0];
    report(
      'saving an off-peak job posts nonpeak with no cron and the picked model',
      jobPosts.length === 1 &&
        posted.scheduleType === 'nonpeak' &&
        posted.cron === undefined &&
        posted.model === 'stub/stub-mini' &&
        posted.missedPolicy === 'coalesce',
      JSON.stringify(posted),
    );

    const customItem = page.locator('.jobs-item', { hasText: 'custom-cron job' });
    await customItem.first().waitFor({ timeout: 10000 });
    await customItem.first().locator('.jobs-item-row').first().click();
    await page.waitForSelector('.job-editor-title-main:has-text("custom-cron job")', { timeout: 10000 });
    await delay(400);
    const customState = await page.evaluate(() => {
      const editors = [...document.querySelectorAll('.job-editor')];
      const ed = editors.find((e) => e.textContent?.includes('custom-cron job')) ?? null;
      const seg = ed?.querySelector('.je-sched-seg') ?? null;
      const on = seg?.querySelector('.sf-pill-item--on');
      return {
        created: ed !== null,
        patterns: seg?.querySelectorAll('.sf-pill-item').length ?? 0,
        selected: on?.textContent ?? '',
        ref: ed?.querySelector('.je-cron-ref code')?.textContent ?? '',
      };
    });
    report(
      'unrepresentable cron opens in Advanced with the expression preserved',
      customState.created &&
        customState.patterns === 7 &&
        customState.selected === 'Advanced' &&
        customState.ref === '15 9,17 * * mon-fri',
      JSON.stringify(customState),
    );

    await modeBtn('Daily').click();
    await delay(150);
    const rebuilt = await page.evaluate(() => {
      const editors = [...document.querySelectorAll('.job-editor')];
      const ed = editors.find((e) => e.textContent?.includes('custom-cron job')) ?? null;
      const seg = ed?.querySelector('.je-sched-seg');
      return {
        patterns: seg?.querySelectorAll('.sf-pill-item').length ?? 0,
        selected: seg?.querySelector('.sf-pill-item--on')?.textContent ?? '',
        ref: ed?.querySelector('.je-cron-ref code')?.textContent ?? '',
      };
    });
    report(
      'picking a builder mode from Advanced rewrites the expression',
      rebuilt.patterns === 7 && rebuilt.selected === 'Daily' && /^0 \d{1,2} \* \* \*$/.test(rebuilt.ref),
      JSON.stringify(rebuilt),
    );

    const npItem = page.locator('.jobs-item', { hasText: 'off-peak job' });
    await npItem.first().locator('.jobs-item-row').first().click();
    await page.waitForSelector('.job-editor-title-main:has-text("off-peak job")', { timeout: 10000 });
    await delay(400);
    const npState = await page.evaluate(() => {
      const editors = [...document.querySelectorAll('.job-editor')];
      const ed = editors.find((e) => e.textContent?.includes('off-peak job')) ?? null;
      const seg = ed?.querySelector('.je-adv-seg') ?? null;
      return {
        created: ed !== null,
        kind: seg?.querySelector('.sf-pill-item--on')?.textContent ?? '',
        schedMode: ed?.querySelector('.je-sched-seg .sf-pill-item--on')?.textContent ?? '',
        cronRef: ed?.querySelector('.je-cron-ref code')?.textContent ?? '',
        offpeakBox: !!ed?.querySelector('.je-offpeak-box'),
        model: ed?.querySelector('.je-model-btn-text')?.textContent ?? '',
      };
    });
    report(
      'a non-peak job round-trips into the editor on the off-peak sub-type',
      npState.created &&
        npState.kind === 'off peak' &&
        npState.schedMode === 'Advanced' &&
        npState.cronRef === '' &&
        npState.offpeakBox &&
        /stub/.test(npState.model),
      JSON.stringify(npState),
    );

    const injectWide = () =>
      page.evaluate(() => {
        const body = document.querySelector('.job-editor-body');
        if (!body) return null;
        const wide = document.createElement('div');
        wide.style.width = '9999px';
        wide.style.height = '4px';
        body.appendChild(wide);
        const ed = document.querySelector('.job-editor');
        const ox = getComputedStyle(ed).overflowX;
        const tile = ed.closest('.sf-tile-content');
        const root = document.scrollingElement;
        return {
          ox,
          editorUserPannable: ox === 'auto' || ox === 'scroll',
          tilePannable: !!tile && tile.scrollWidth > tile.clientWidth,
          rootPannable: root.scrollWidth > root.clientWidth,
        };
      });

    const wideDesktop = await injectWide();
    report(
      'desktop: editor is never user-pannable horizontally (even with overflowing content)',
      !!wideDesktop &&
        !wideDesktop.editorUserPannable &&
        !wideDesktop.tilePannable &&
        !wideDesktop.rootPannable,
      JSON.stringify(wideDesktop),
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(600);
    const segSingleLine = await page.evaluate(() => {
      const seg = document.querySelector('.je-sched-seg');
      if (!seg) return null;
      const pills = [...seg.querySelectorAll('.sf-pill-item')];
      const rows = new Set(pills.map((b) => Math.round(b.getBoundingClientRect().top)));
      return { pills: pills.length, rows: rows.size };
    });
    report(
      'mobile: schedule selector stays on a single line',
      segSingleLine?.pills === 7 && segSingleLine.rows === 1,
      JSON.stringify(segSingleLine),
    );

    await page.locator('.je-sched-seg .sf-pill-item', { hasText: 'Weekly' }).click();
    await delay(400);
    const msSingleLine = await page.evaluate(() => {
      const track = document.querySelector('.sf-ms-track');
      if (!track) return null;
      const items = [...track.querySelectorAll('.sf-ms-item')];
      const rows = new Set(items.map((b) => Math.round(b.getBoundingClientRect().top)));
      return { items: items.length, rows: rows.size, wrap: getComputedStyle(track).flexWrap };
    });
    report(
      'mobile: day selector stays on a single line',
      msSingleLine?.items === 7 && msSingleLine.rows === 1 && msSingleLine.wrap === 'nowrap',
      JSON.stringify(msSingleLine),
    );

    await page.evaluate(() => {
      const s = document.createElement('style');
      s.id = 'force-ms-wrap';
      s.textContent = '.sf-ms-track{flex-wrap:wrap!important;max-width:150px!important}';
      document.head.appendChild(s);
    });
    await page.locator('.sf-ms-item', { hasText: 'Sun' }).click();
    await page.locator('.sf-ms-item', { hasText: 'Sat' }).click();
    await delay(300);
    const wrapped = await page.evaluate(() => {
      const track = document.querySelector('.sf-ms-track');
      const items = [...track.querySelectorAll('.sf-ms-item')];
      const rows = new Set(items.map((b) => Math.round(b.getBoundingClientRect().top))).size;
      let boundary = -1;
      for (let i = 1; i < items.length; i++) {
        if (Math.abs(items[i].getBoundingClientRect().top - items[i - 1].getBoundingClientRect().top) > 1) {
          boundary = i - 1;
          break;
        }
      }
      if (boundary === -1) return { rows, boundary };
      const trackStyle = getComputedStyle(track);
      const trackRadius = Number.parseFloat(trackStyle.borderTopLeftRadius);
      const inset = Number.parseFloat(trackStyle.paddingTop) + Number.parseFloat(trackStyle.borderTopWidth);
      const last = getComputedStyle(items[boundary], '::before');
      const lead = getComputedStyle(items[boundary + 1], '::before');
      return {
        rows,
        boundary: `${items[boundary].textContent}|${items[boundary + 1].textContent}`,
        lastRight: last.right,
        lastBorderRight: last.borderRightWidth,
        lastRadius: last.borderTopRightRadius,
        leadBorderLeft: lead.borderLeftWidth,
        leadRadius: lead.borderTopLeftRadius,
        expectedRadius: trackRadius - inset,
      };
    });
    report(
      'a run crossing a wrapped row closes on the row end and reopens on the next',
      wrapped.rows >= 2 &&
        wrapped.lastRight === '0px' &&
        wrapped.lastBorderRight === '1px' &&
        Number.parseFloat(wrapped.lastRadius) === wrapped.expectedRadius &&
        wrapped.leadBorderLeft === '1px' &&
        Number.parseFloat(wrapped.leadRadius) === wrapped.expectedRadius,
      JSON.stringify(wrapped),
    );
    await page.evaluate(() => document.getElementById('force-ms-wrap')?.remove());
    const wideMobile = await injectWide();
    report(
      'mobile: editor is never user-pannable horizontally (even with overflowing content)',
      !!wideMobile && !wideMobile.editorUserPannable && !wideMobile.tilePannable && !wideMobile.rootPannable,
      JSON.stringify(wideMobile),
    );

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
