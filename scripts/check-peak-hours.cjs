const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
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
const RUN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'peak-hours-check-'));
const SESSIONS_ROOT = path.join(RUN_ROOT, 'sessions');
const STATES_PATH = path.join(RUN_ROOT, 'states.json');
const PEAK_HOURS_PATH = path.join(RUN_ROOT, 'peak-hours.json');
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
  const dir = path.join(SESSIONS_ROOT, '--tmp-peak-hours--');
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

const STUB_MODELS = [
  {
    id: 'stub-pro',
    provider: 'stub',
    name: 'Stub Pro',
    reasoning: true,
    contextWindow: 1048576,
    maxTokens: 8192,
    api: 'stub-api-a',
    baseUrl: 'https://stub.example/v1',
    input: ['text', 'image'],
    thinkingLevels: ['off', 'low', 'high'],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    id: 'stub-mini',
    provider: 'stub',
    name: 'Stub Mini',
    reasoning: false,
    contextWindow: 100000,
    maxTokens: 4096,
    api: 'stub-api-b',
    baseUrl: 'https://stub.example/v1',
    input: ['text'],
    thinkingLevels: ['off'],
  },
];

async function unitChecks({ report }) {
  const mod = await import(
    pathToFileURL(path.join(PRODUCT_ROOT, 'src/pi-studio/server/peak-hours.mjs')).href
  );
  const unitPath = path.join(RUN_ROOT, 'unit-peak.json');
  const store = mod.createPeakHoursStore({ persistPath: unitPath });

  const r1 = store.create({
    provider: 'anthropic',
    model: 'claude-opus-4',
    start: '09:00',
    end: '17:00',
    utcOffset: 120,
  });
  report(
    'unit: create stores canonical UTC, key and both clocks',
    !!r1.entry &&
      r1.entry.provider === 'anthropic' &&
      r1.entry.model === 'claude-opus-4' &&
      r1.entry.key === 'anthropic/claude-opus-4' &&
      r1.entry.startUtc === '07:00' &&
      r1.entry.endUtc === '15:00' &&
      r1.entry.start === '09:00' &&
      r1.entry.end === '17:00' &&
      r1.entry.enabled === true &&
      r1.entry.wrapsMidnightUtc === false,
    JSON.stringify(r1.entry ?? r1),
  );

  const r2 = store.update(r1.entry.id, { utcOffset: 360 });
  report(
    'unit: offset-only update keeps the UTC window fixed',
    !!r2.entry &&
      r2.entry.startUtc === '07:00' &&
      r2.entry.endUtc === '15:00' &&
      r2.entry.start === '13:00' &&
      r2.entry.end === '21:00',
    JSON.stringify(r2.entry ?? r2),
  );

  const r3 = store.create({
    provider: 'openai',
    model: 'gpt-x',
    start: '22:00',
    end: '02:00',
    utcOffset: 0,
  });
  report(
    'unit: wrap-midnight window stores end < start and flags it',
    !!r3.entry && r3.entry.startUtc === '22:00' && r3.entry.endUtc === '02:00' && r3.entry.wrapsMidnightUtc,
    JSON.stringify(r3.entry ?? r3),
  );

  const at = (h, m) => Date.UTC(2026, 0, 14, h, m);
  const wrapPeaks = [
    [23, 30, true],
    [21, 59, false],
    [22, 0, true],
    [1, 59, true],
    [2, 0, false],
    [12, 0, false],
  ];
  report(
    'unit: isPeakAt matches the wrap window with inclusive start and exclusive end',
    wrapPeaks.every(([h, m, want]) => mod.windowIsPeakAt(1320, 120, at(h, m)) === want),
  );
  const oneWindow = [{ provider: 'openai', model: 'gpt-x', enabled: true, startUtc: 1320, endUtc: 120 }];
  report(
    'unit: isPeakAt matches provider/model, not neighbors',
    mod.isPeakAt(oneWindow, 'openai', 'gpt-x', at(23, 30)) === true &&
      mod.isPeakAt(oneWindow, 'openai', 'gpt-other', at(23, 30)) === false &&
      mod.isPeakAt(oneWindow, 'anthropic', 'gpt-x', at(23, 30)) === false,
  );
  report(
    'unit: disabled entries never peak',
    store.list().length === 2 &&
      store.update(r3.entry.id, { enabled: false }) &&
      !store.list().find((e) => e.id === r3.entry.id).enabled,
  );

  const wdPath = path.join(RUN_ROOT, 'wd-peak.json');
  const wdStore = mod.createPeakHoursStore({ persistPath: wdPath });
  const wdEntry = wdStore.create({
    provider: 'openai',
    model: 'gpt-x',
    start: '09:00',
    end: '17:00',
    utcOffset: 0,
    weekdays: [5, 1, 3, 1],
  });
  report(
    'unit: weekdays are normalized to sorted unique day numbers',
    wdEntry.entry?.weekdays?.join() === '1,3,5' && wdStore.list().length === 1,
    JSON.stringify(wdEntry.entry ?? wdEntry),
  );
  const badWd = wdStore.create({
    provider: 'openai',
    model: 'gpt-x2',
    start: '09:00',
    end: '17:00',
    utcOffset: 0,
    weekdays: [1, 9],
  });
  const emptyWd = wdStore.create({
    provider: 'openai',
    model: 'gpt-x2',
    start: '09:00',
    end: '17:00',
    utcOffset: 0,
    weekdays: [],
  });
  report(
    'unit: out-of-range or empty weekday sets are rejected',
    !!badWd.error && /weekdays/.test(badWd.error) && !!emptyWd.error,
    `bad=${JSON.stringify(badWd)} empty=${JSON.stringify(emptyWd)}`,
  );
  const wedOnly = [{ provider: 'o', model: 'm', enabled: true, startUtc: 540, endUtc: 1020, weekdays: [3] }];
  report(
    'unit: isPeakAt gates on the window weekday (Jan 14 2026 is a Wednesday)',
    mod.isPeakAt(wedOnly, 'o', 'm', at(10, 0)) === true &&
      mod.isPeakAt(wedOnly, 'o', 'm', Date.UTC(2026, 0, 15, 10, 0)) === false,
  );
  const tzTail = [
    { provider: 'o', model: 'm', enabled: true, startUtc: 840, endUtc: 1080, utcOffset: 480, weekdays: [3] },
  ];
  report(
    'unit: the weekday is evaluated on the window clock, not UTC',
    mod.isPeakAt(tzTail, 'o', 'm', Date.UTC(2026, 0, 13, 17, 0)) === true &&
      mod.isPeakAt(tzTail, 'o', 'm', Date.UTC(2026, 0, 14, 17, 0)) === false,
  );

  const bad = [
    [{ provider: 'x', model: 'y', start: '09:00', end: '09:00', utcOffset: 0 }, 'start and end must differ'],
    [{ provider: 'x', model: 'y', start: '09:00', end: '17:00', utcOffset: 780 }, 'utcOffset'],
    [{ provider: '   ', model: 'y', start: '09:00', end: '17:00', utcOffset: 0 }, 'provider is required'],
    [{ provider: 'x', model: '', start: '09:00', end: '17:00', utcOffset: 0 }, 'model is required'],
    [
      { provider: 'x/y', model: 'z', start: '09:00', end: '17:00', utcOffset: 0 },
      'provider must not contain',
    ],
    [{ provider: 'x', model: 'y', start: '9pm', end: '17:00', utcOffset: 0 }, 'start must be'],
    [
      { provider: 'x', model: 'y', start: '09:00', end: '17:00', utcOffset: 0, note: 'n'.repeat(201) },
      'note must be',
    ],
  ];
  report(
    'unit: create rejects invalid input',
    bad.every(([input, want]) => {
      const r = store.create(input);
      return !!r.error && r.error.includes(want);
    }),
    JSON.stringify(bad.map(([input, want]) => store.create(input).error ?? `accepted:${want}`)),
  );

  const dup = store.create({
    provider: 'anthropic',
    model: 'claude-opus-4',
    start: '07:00',
    end: '15:00',
    utcOffset: 0,
  });
  report(
    'unit: identical window for the same model is rejected',
    !!dup.error && /identical/.test(dup.error),
    JSON.stringify(dup),
  );

  const again = mod.createPeakHoursStore({ persistPath: unitPath });
  report(
    'unit: store reloads persisted entries from disk',
    again.list().length === 2 && again.list().every((e) => e.id && e.key),
    JSON.stringify(again.list().map((e) => e.key)),
  );

  fs.writeFileSync(unitPath, '{not json');
  const corrupt = mod.createPeakHoursStore({ persistPath: unitPath });
  report('unit: a corrupt file loads as empty, not a crash', corrupt.list().length === 0);

  const handPath = path.join(RUN_ROOT, 'hand-peak.json');
  fs.writeFileSync(
    handPath,
    JSON.stringify({
      version: 1,
      entries: [
        {
          id: 'good1',
          provider: 'ok',
          model: 'model-1',
          startUtc: 480,
          endUtc: 1020,
          utcOffset: 0,
          note: '',
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'bad1',
          provider: '',
          model: 'm',
          startUtc: 0,
          endUtc: 10,
          utcOffset: 0,
          note: '',
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'bad2',
          provider: 'x',
          model: 'y',
          startUtc: 90,
          endUtc: 90,
          utcOffset: 0,
          note: '',
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'legacy1',
          provider: 'ok',
          model: 'model-2',
          startUtc: 480,
          endUtc: 1020,
          utcOffset: 0,
          note: '',
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }),
  );
  const hand = mod.createPeakHoursStore({ persistPath: handPath });
  const handLegacy = hand.list().find((e) => e.id === 'legacy1');
  report(
    'unit: hand-edited invalid entries are skipped on load',
    hand.list().length === 2 && hand.list()[0].id === 'good1',
    JSON.stringify(hand.list()),
  );
  report(
    'unit: entries written before weekdays load as daily',
    handLegacy?.weekdays?.join() === '0,1,2,3,4,5,6',
    JSON.stringify(handLegacy ?? null),
  );

  report(
    'unit: remove deletes and persists',
    hand.remove('good1') &&
      hand.list().length === 1 &&
      mod.createPeakHoursStore({ persistPath: handPath }).list().length === 1,
  );
  report('unit: removing an unknown id reports false', hand.remove('nope') === false);
}

(async () => {
  const { report, isFailed } = makeReporter();
  assertMemoryHeadroom({ label: 'check-peak-hours' });
  sweepStaleStackProcesses('check-peak-hours:stack');
  const procs = [];
  const browserRef = { current: null };
  installStackCleanup({ procs, stamp: 'check-peak-hours:stack', browserRef, label: 'check-peak-hours' });
  let browser;
  try {
    await unitChecks({ report });

    const backendPort = await freePort();
    const vitePort = await freePort();
    console.log(`stack: backend :${backendPort} vite :${vitePort}`);
    const stub = writeStubClient(RUN_ROOT);
    writeSessionFile('peak-hours-check');

    procs.push(
      spawnStackProc(spawn, 'check-peak-hours:stack', 'node', ['src/pi-studio/server/index.mjs'], {
        cwd: PRODUCT_ROOT,
        env: {
          ...process.env,
          PI_STUDIO_PORT: String(backendPort),
          PI_STUDIO_HOST: '127.0.0.1',
          PI_STUDIO_CLIENT_MODULE: stub.stubPath,
          STUB_CONTROL_FILE: stub.controlPath,
          PI_STUDIO_SESSIONS: SESSIONS_ROOT,
          PI_STUDIO_STATES_PATH: STATES_PATH,
          PI_STUDIO_DB_PATH: path.join(RUN_ROOT, 'studio.db'),
          PI_STUDIO_PEAK_HOURS_PATH: PEAK_HOURS_PATH,
          PI_STUDIO_CWD: RUN_ROOT,
        },
        stdio: [
          'ignore',
          fs.openSync('/tmp/peak-hours-check-backend.log', 'a'),
          fs.openSync('/tmp/peak-hours-check-backend.log', 'a'),
        ],
      }),
    );
    await waitHttp(`http://127.0.0.1:${backendPort}/api/health`, 'backend');
    const jfetch = async (p, opts) => {
      const r = await fetch(`http://127.0.0.1:${backendPort}${p}`, opts);
      return { status: r.status, body: await r.json() };
    };

    procs.push(
      spawnStackProc(
        spawn,
        'check-peak-hours:stack',
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
            fs.openSync('/tmp/peak-hours-check-vite.log', 'a'),
            fs.openSync('/tmp/peak-hours-check-vite.log', 'a'),
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
    page.on('dialog', (d) => d.accept().catch(() => {}));

    await page.route('**/api/models*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          models: STUB_MODELS,
          default: STUB_MODELS[0],
          defaultSource: 'settings',
          defaultThinkingLevel: null,
          current: null,
          currentThinkingLevel: null,
        }),
      });
    });

    await page.goto(`http://127.0.0.1:${vitePort}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sf-docker', { timeout: 60000 });

    const itemSel = '.chat-list-item:has-text("peak-hours-check")';
    await page.waitForSelector(itemSel, { timeout: 60000 });
    await delay(1000);
    await page.locator(itemSel).first().click({ force: true });
    await page.waitForSelector('.chat-msg', { timeout: 20000 });

    await page.locator('.sf-menu-item', { hasText: 'Model' }).click();
    await page.locator('.sf-menu-row', { hasText: 'Model Catalog…' }).waitFor({ timeout: 5000 });
    await page.locator('.sf-menu-row', { hasText: 'Model Catalog…' }).click();
    await page.waitForSelector('.model-catalog', { timeout: 10000 });
    await page.locator('.model-catalog-row', { hasText: 'Stub Pro' }).first().waitFor({ timeout: 5000 });

    const peakLabel = await page.locator('.sf-subsection-label', { hasText: 'Peak Hours' }).count();
    report(
      'Peak Hours subsection renders in the model catalog right panel',
      peakLabel === 1,
      `labels=${peakLabel}`,
    );

    const layoutDefs = JSON.parse(
      fs.readFileSync(path.join(PRODUCT_ROOT, 'src/pi-studio/layout/app.layout.json'), 'utf8'),
    );
    const catalogSubs = layoutDefs.rightPanels?.['model-catalog']?.sections?.[0]?.subSections ?? [];
    const peakDef = catalogSubs.find((s) => s.id === 'peak-hours');
    report(
      'layout: peak-hours subsection is variable-height with a minHeight',
      peakDef?.height === 'variable' &&
        peakDef?.minHeight === 80 &&
        peakDef?.components?.[0]?.key === 'peak-hours',
      JSON.stringify(peakDef ?? null),
    );

    await page.waitForSelector('.aph', { timeout: 10000 });
    const emptyHint = await page.locator('.aph-empty').count();
    const emptyRows = await page.locator('.aph-row').count();
    const idleHint = (await page.locator('.aph-hint').textContent()) ?? '';
    report(
      'panel starts scoped and empty with no hint text',
      emptyHint === 0 && emptyRows === 0 && idleHint.includes('select a model'),
      `hint=${emptyHint} rows=${emptyRows} idle=${idleHint.trim()}`,
    );

    const addBeforeSelect = await page.locator('.aph-add').isDisabled();
    report(
      'add is disabled until a model is selected in the catalog',
      addBeforeSelect,
      `disabled=${addBeforeSelect}`,
    );

    await page.locator('.model-catalog-row', { hasText: 'Stub Pro' }).first().click();
    await delay(300);
    const scopedHint = (await page.locator('.aph-hint').textContent()) ?? '';
    report(
      'the subsection head shows the selected model key',
      scopedHint.includes('stub/stub-pro'),
      `hint=${scopedHint.trim()}`,
    );

    await page.locator('.aph-add').click();
    await page.waitForSelector('.sf-dialog', { timeout: 5000 });
    await delay(150);
    const desktopFocus = await page.evaluate(() => ({
      focused: document.activeElement?.id ?? '',
      tag: document.activeElement?.tagName ?? '',
    }));
    report(
      'desktop: opening the dialog does not focus the time input',
      desktopFocus.focused !== 'aph-start' && desktopFocus.tag !== 'INPUT',
      JSON.stringify(desktopFocus),
    );
    const dialogInfo = await page.locator('.sf-dialog').evaluate((el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const back = el.parentElement;
      const bcs = back ? getComputedStyle(back) : null;
      return {
        bg: cs.backgroundColor,
        border: cs.borderTopStyle === 'solid' && cs.borderTopWidth !== '0px',
        radius: cs.borderTopLeftRadius,
        shadow: cs.boxShadow !== 'none',
        inSubsection: !!el.closest('.sf-subsection'),
        centeredX: r.left > 0 && r.right < window.innerWidth,
        centeredY: r.top > 0 && r.bottom < window.innerHeight,
        backdropFixed: bcs ? bcs.position === 'fixed' && bcs.inset === '0px' : null,
      };
    });
    report(
      'editing opens as a centered themed popup, not inside the subsection',
      dialogInfo.bg === 'rgb(45, 45, 45)' &&
        dialogInfo.bg === 'rgb(45, 45, 45)' &&
        dialogInfo.border &&
        dialogInfo.radius === '6px' &&
        dialogInfo.shadow &&
        dialogInfo.inSubsection === false &&
        dialogInfo.centeredX &&
        dialogInfo.centeredY &&
        dialogInfo.backdropFixed === true,
      JSON.stringify(dialogInfo),
    );

    await page.keyboard.press('Escape');
    await delay(200);
    const closedByEscape = (await page.locator('.sf-dialog').count()) === 0;
    await page.locator('.aph-add').click();
    await page.waitForSelector('.sf-dialog', { timeout: 5000 });
    report('Escape closes the popup', closedByEscape, `closed=${closedByEscape}`);

    const closeInfo = await page.locator('.sf-dialog-close').evaluate((el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        w: Math.round(r.width),
        h: Math.round(r.height),
        radius: cs.borderTopLeftRadius,
        bg: cs.backgroundColor,
        color: cs.color,
      };
    });
    report(
      'the popup close button is a red rounded square',
      closeInfo.w === closeInfo.h &&
        closeInfo.w >= 20 &&
        closeInfo.radius !== '0px' &&
        closeInfo.bg === 'rgb(244, 135, 113)' &&
        closeInfo.color === 'rgb(255, 255, 255)',
      JSON.stringify(closeInfo),
    );

    const timeInfo = await page.locator('#aph-start').evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        type: el.getAttribute('type'),
        icon: cs.backgroundImage.includes('svg'),
        stroke: cs.backgroundImage.includes('%23cccccc'),
        cursor: cs.cursor,
      };
    });
    report(
      'desktop time boxes are plain text inputs with a light clock glyph',
      timeInfo.type === 'text' && timeInfo.icon && timeInfo.stroke && timeInfo.cursor === 'text',
      JSON.stringify(timeInfo),
    );

    await page.locator('.sf-dialog-close').click();
    await delay(200);
    const closedByButton = (await page.locator('.sf-dialog').count()) === 0;
    report('the close button closes the popup', closedByButton, `closed=${closedByButton}`);

    await page.locator('.aph-add').click();
    await page.waitForSelector('.sf-dialog', { timeout: 5000 });
    const modelSelectCount = await page.locator('#aph-model').count();
    const boundModel = (await page.locator('.aph-model-bound').textContent()) ?? '';
    report(
      'form is bound to the selected catalog model — no provider/model selector',
      modelSelectCount === 0 && boundModel.trim() === 'stub/stub-pro',
      `select=${modelSelectCount} bound=${boundModel.trim()}`,
    );

    const tzOptions = await page
      .locator('#aph-tz option')
      .evaluateAll((els) =>
        els.map((e) => ({ value: Number(e.value), label: (e.textContent || '').trim() })),
      );
    report(
      'timezone selector offers whole-hour offsets only (UTC-12..UTC+12)',
      tzOptions.length === 25 &&
        tzOptions.every((o) => Number.isInteger(o.value) && o.value % 60 === 0) &&
        tzOptions[0].value === -720 &&
        tzOptions[tzOptions.length - 1].value === 720 &&
        !tzOptions.some((o) => Math.abs(o.value) > 720) &&
        tzOptions.every((o) => !o.label.includes(':')) &&
        tzOptions.some((o) => o.label === 'UTC+12') &&
        tzOptions.some((o) => o.label === 'UTC-12'),
      JSON.stringify({
        n: tzOptions.length,
        first: tzOptions[0],
        last: tzOptions[tzOptions.length - 1],
      }),
    );

    const addBtnTheme = await page.evaluate(() => {
      const el = document.querySelector('.aph-add');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, color: cs.color, border: cs.borderTopStyle === 'solid' };
    });
    report(
      'add button is a themed accent button',
      !!addBtnTheme &&
        addBtnTheme.bg === 'rgb(0, 122, 204)' &&
        addBtnTheme.color === 'rgb(255, 255, 255)' &&
        addBtnTheme.border,
      JSON.stringify(addBtnTheme),
    );

    await page.evaluate(() => {
      window.__pickerCalls = 0;
      HTMLInputElement.prototype.showPicker = () => {
        window.__pickerCalls += 1;
      };
    });
    const startBox = await page.locator('#aph-start').boundingBox();
    await page.mouse.click(startBox.x + 10, startBox.y + startBox.height / 2);
    await delay(200);
    const desktopClick = await page.evaluate(() => ({
      focused: document.activeElement?.id,
      popups: document.querySelectorAll('.tf-pop').length,
      calls: window.__pickerCalls,
    }));
    report(
      'desktop disables select-to-input — a click only focuses the box for typing',
      desktopClick.focused === 'aph-start' && desktopClick.popups === 0 && desktopClick.calls === 0,
      JSON.stringify(desktopClick),
    );

    await page.fill('#aph-start', '12:59');
    await delay(200);
    const typedWhole = await page.locator('#aph-start').inputValue();
    report('typing a whole time works directly', typedWhole === '12:59', `value=${typedWhole}`);

    await page.fill('#aph-start', '1259');
    await page.locator('#aph-note').click();
    await delay(300);
    const normalized = await page.locator('#aph-start').inputValue();
    report('loose input normalizes on blur', normalized === '12:59', `value=${normalized}`);

    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForSelector('.sf-root--mobile', { timeout: 5000 });
    await delay(400);
    await page.locator('.sf-mobile-rp-btn').first().click();
    await page.waitForSelector('.aph-add', { timeout: 5000 });
    const callsPreOpen = await page.evaluate(() => window.__pickerCalls);
    await page.locator('.aph-add').click();
    await page.waitForSelector('.sf-dialog', { timeout: 5000 });
    await delay(150);
    const mountState = await page.evaluate(() => ({
      focused: document.activeElement?.id ?? '',
      calls: window.__pickerCalls,
    }));
    report(
      'mobile: opening the dialog leaves the time picker closed',
      mountState.focused !== 'aph-start' && mountState.calls === callsPreOpen,
      JSON.stringify({ pre: callsPreOpen, ...mountState }),
    );
    const mInfo = await page.locator('#aph-start').evaluate((el) => ({
      type: el.getAttribute('type'),
      readOnly: el.readOnly,
    }));
    const callsBefore = await page.evaluate(() => window.__pickerCalls);
    const mobileBox = await page.locator('#aph-start').boundingBox();
    await page.mouse.click(mobileBox.x + 10, mobileBox.y + mobileBox.height / 2);
    await delay(200);
    const callsAfter = await page.evaluate(() => window.__pickerCalls);
    report(
      'mobile selects via the native system dual time selector',
      mInfo.type === 'time' && mInfo.readOnly === false && callsAfter === callsBefore + 1,
      JSON.stringify({ ...mInfo, calls: callsAfter - callsBefore }),
    );

    const pickerTap = await (async () => {
      const card = await page.locator('.sf-dialog').boundingBox();
      const vh = 812;
      const pt =
        card && card.y + card.height + 20 <= vh
          ? { x: Math.round(card.x + card.width / 2), y: Math.round(card.y + card.height + 15) }
          : { x: 5, y: Math.round(vh / 2) };
      await page.mouse.click(pt.x, pt.y);
      await delay(250);
      const stayedOpen = (await page.locator('.sf-dialog').count()) === 1;
      await page.mouse.click(pt.x, pt.y);
      await delay(250);
      const closedBySecondTap = (await page.locator('.sf-dialog').count()) === 0;
      return { stayedOpen, closedBySecondTap, pt };
    })();
    report(
      'an outside tap while the time picker is open dismisses the picker only; the next tap closes the window',
      pickerTap.stayedOpen && pickerTap.closedBySecondTap,
      JSON.stringify(pickerTap),
    );
    await page.locator('.aph-add').click();
    await page.waitForSelector('.sf-dialog', { timeout: 5000 });
    const mobileDayBtns = await page.locator('.aph-days .sf-ms-item').count();
    report('mobile dialog shows the weekday selector', mobileDayBtns === 7, `buttons=${mobileDayBtns}`);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForSelector('.sf-root:not(.sf-root--mobile)', { timeout: 5000 });
    await delay(400);
    await page.locator('.aph-add').click();
    await page.waitForSelector('.sf-dialog', { timeout: 5000 });

    const dayCount = await page.locator('.aph-days .sf-ms-item').count();
    const pressedDefault = await page.locator('.aph-days .sf-ms-item[aria-pressed="true"]').count();
    report(
      'the dialog offers a weekday selector defaulting to every day',
      dayCount === 7 && pressedDefault === 7,
      `buttons=${dayCount} pressed=${pressedDefault}`,
    );
    await page.locator('.aph-days .sf-ms-item', { hasText: 'Sun' }).click();
    await page.locator('.aph-days .sf-ms-item', { hasText: 'Sat' }).click();
    const pressedMonFri = await page.locator('.aph-days .sf-ms-item[aria-pressed="true"]').count();
    report(
      'weekday chips toggle; Sun/Sat off leaves Mon–Fri',
      pressedMonFri === 5,
      `pressed=${pressedMonFri}`,
    );
    const daysTrack = await page.locator('.aph-days .sf-ms-track').boundingBox();
    const daysField = await page.locator('.aph-days').boundingBox();
    const daysChip = await page.locator('.aph-days .sf-ms-item').first().boundingBox();
    report(
      'the weekday selector fills the row left to right with taller chips',
      !!daysTrack &&
        !!daysField &&
        !!daysChip &&
        Math.abs(daysTrack.width - daysField.width) < 4 &&
        daysChip.height >= 27 &&
        daysChip.y - daysTrack.y >= 3.5,
      JSON.stringify({
        track: daysTrack?.width,
        field: daysField?.width,
        chip: daysChip?.height,
        inset: daysChip && daysTrack ? Math.round((daysChip.y - daysTrack.y) * 10) / 10 : null,
      }),
    );
    const ctlHeights = await page.evaluate(() => {
      const h = (sel) => {
        const el = document.querySelector(sel);
        return el ? Math.round(el.getBoundingClientRect().height * 10) / 10 : null;
      };
      return {
        tz: h('#aph-tz'),
        start: h('#aph-start'),
        note: h('#aph-note'),
        days: h('.aph-days .sf-ms-track'),
      };
    });
    const noteFont = await page.evaluate(
      () => getComputedStyle(document.querySelector('#aph-note')).fontSize,
    );
    const hs = Object.values(ctlHeights);
    report(
      'all dialog controls share one height; the note box uses chat input text size',
      hs.every((x) => x !== null) && Math.max(...hs) - Math.min(...hs) < 1 && noteFont === '16px',
      JSON.stringify({ ...ctlHeights, noteFont }),
    );

    await page.selectOption('#aph-tz', '120');
    await page.fill('#aph-start', '09:00');
    await page.fill('#aph-end', '17:00');
    const liveHint = (await page.locator('.aph-live').first().textContent()) ?? '';
    report(
      'live hint shows the UTC equivalent while editing',
      liveHint.includes('07:00–15:00 UTC'),
      `hint=${liveHint}`,
    );
    await page.locator('.aph-save').click();
    await page.waitForSelector('.sf-dialog', { state: 'detached', timeout: 10000 });
    await page.locator('.aph-row').waitFor({ timeout: 10000 });

    let row = await page.locator('.aph-row').first().textContent();
    report(
      'created row shows the window in its timezone plus the UTC equivalent',
      row.includes('09:00–17:00') &&
        row.includes('UTC+2') &&
        row.includes('07:00–15:00 UTC') &&
        row.includes('Mon–Fri'),
      `row=${row}`,
    );

    let r = await jfetch('/api/peak-hours');
    const disk1 = JSON.parse(fs.readFileSync(PEAK_HOURS_PATH, 'utf8'));
    report(
      'create persists canonical UTC minutes to disk',
      r.status === 200 &&
        r.body.entries.length === 1 &&
        r.body.entries[0].key === 'stub/stub-pro' &&
        r.body.entries[0].provider === 'stub' &&
        r.body.entries[0].model === 'stub-pro' &&
        r.body.entries[0].startUtc === '07:00' &&
        r.body.entries[0].endUtc === '15:00' &&
        r.body.entries[0].weekdays?.join() === '1,2,3,4,5' &&
        disk1.version === 1 &&
        disk1.entries[0].provider === 'stub' &&
        disk1.entries[0].model === 'stub-pro' &&
        disk1.entries[0].startUtc === 420 &&
        disk1.entries[0].endUtc === 900 &&
        disk1.entries[0].utcOffset === 120 &&
        disk1.entries[0].weekdays?.join() === '1,2,3,4,5',
      JSON.stringify({ entry: r.body.entries[0], disk: disk1.entries[0] }),
    );
    const entryId = r.body.entries[0].id;

    await page.locator('.aph-row .aph-actions button[title="Edit window"]').first().click();
    await page.waitForSelector('.sf-dialog', { timeout: 5000 });
    const editPressed = await page.locator('.aph-days .sf-ms-item[aria-pressed="true"]').count();
    const editSun =
      (await page.locator('.aph-days .sf-ms-item', { hasText: 'Sun' }).getAttribute('aria-pressed')) ?? '';
    report(
      'editing preselects the stored days',
      editPressed === 5 && editSun === 'false',
      `pressed=${editPressed} sun=${editSun}`,
    );
    await page.selectOption('#aph-tz', '0');
    const editStart = await page.locator('#aph-start').inputValue();
    const editEnd = await page.locator('#aph-end').inputValue();
    const editHint = (await page.locator('.aph-live').first().textContent()) ?? '';
    report(
      'changing the timezone re-derives the fields, keeping the absolute window',
      editStart === '07:00' && editEnd === '15:00' && editHint.includes('07:00–15:00 UTC'),
      `start=${editStart} end=${editEnd} hint=${editHint}`,
    );
    await page.locator('.aph-save').click();
    await page.waitForSelector('.sf-dialog', { state: 'detached', timeout: 10000 });
    await page.locator('.aph-row').waitFor({ timeout: 10000 });
    r = await jfetch('/api/peak-hours');
    report(
      'saving after a timezone switch keeps the stored UTC window',
      r.body.entries[0].startUtc === '07:00' &&
        r.body.entries[0].endUtc === '15:00' &&
        r.body.entries[0].utcOffset === 0,
      JSON.stringify(r.body.entries[0]),
    );
    row = await page.locator('.aph-row').first().textContent();
    report(
      'row re-renders in the new timezone',
      row.includes('07:00–15:00') && row.includes('UTC'),
      `row=${row}`,
    );

    await page.locator('.aph-row .aph-actions button[title="Edit window"]').first().click();
    await page.waitForSelector('.sf-dialog', { timeout: 5000 });
    for (let i = 0; i < 5; i++) {
      await page.locator('.aph-days .sf-ms-item[aria-pressed="true"]').first().click();
    }
    const noDaysSave = await page.locator('.aph-save').isDisabled();
    const noDaysNeeds = (await page.locator('.aph-live--warn').textContent()) ?? '';
    report(
      'saving with no weekday selected is blocked',
      noDaysSave && noDaysNeeds.includes('at least one weekday'),
      `disabled=${noDaysSave} needs=${noDaysNeeds}`,
    );
    for (const d of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']) {
      await page.locator('.aph-days .sf-ms-item', { hasText: d }).click();
    }
    await page.fill('#aph-start', '09:00');
    await page.fill('#aph-end', '09:00');
    const saveDisabled = await page.locator('.aph-save').isDisabled();
    const needs = (await page.locator('.aph-live--warn').textContent()) ?? '';
    report(
      'a zero-length window is rejected client-side',
      saveDisabled && needs.includes('window'),
      `disabled=${saveDisabled} needs=${needs}`,
    );
    await page.locator('.aph-cancel').click();
    await delay(300);
    const rowsAfterCancel = await page.locator('.aph-row').count();
    report('cancel leaves the list untouched', rowsAfterCancel === 1, `rows=${rowsAfterCancel}`);

    r = await jfetch('/api/peak-hours', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'ghost',
        model: 'ghost-model',
        start: '22:00',
        end: '02:00',
        utcOffset: 0,
      }),
    });
    report(
      'a model absent from the catalog can still receive a window via the API',
      r.status === 201 && r.body.entry?.wrapsMidnightUtc === true,
      JSON.stringify(r.body),
    );

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sf-docker', { timeout: 60000 });
    await page.locator('.sf-menu-item', { hasText: 'Model' }).click();
    await page.locator('.sf-menu-row', { hasText: 'Model Catalog…' }).waitFor({ timeout: 5000 });
    await page.locator('.sf-menu-row', { hasText: 'Model Catalog…' }).click();
    await page.waitForSelector('.model-catalog-row', { timeout: 10000 });
    await page.locator('.model-catalog-row', { hasText: 'Stub Pro' }).first().click();
    await page.waitForSelector('.aph-row', { timeout: 10000 });
    await delay(300);
    const scopedRows = await page.locator('.aph-row').count();
    const scopedGhostRows = await page.locator('.aph-row', { hasText: 'ghost' }).count();
    report(
      "the subsection lists only the selected model's windows",
      scopedRows === 1 && scopedGhostRows === 0,
      `rows=${scopedRows} ghostRows=${scopedGhostRows}`,
    );

    await page.locator('.sf-menu-item', { hasText: 'Model' }).click();
    await page.locator('.sf-menu-row', { hasText: 'Peak Hours…' }).waitFor({ timeout: 5000 });
    await page.locator('.sf-menu-row', { hasText: 'Peak Hours…' }).click();
    await page.waitForSelector('.pht', { timeout: 10000 });
    await page.locator('.pht-row').first().waitFor({ timeout: 10000 });
    const peakTab = await page.locator('.sf-tab-label', { hasText: 'Peak Hours' }).count();
    report('the Model menu Peak Hours… item opens a workspace tab', peakTab === 1, `tab=${peakTab}`);

    await page.locator('.pht-row', { hasText: 'ghost/ghost-model' }).waitFor({ timeout: 5000 });
    const ghostRow = await page.locator('.pht-row', { hasText: 'ghost/ghost-model' }).textContent();
    const ghostChip = await page.locator('.pht-unknown').count();
    const ghostWindowTitle =
      (await page
        .locator('.pht-row', { hasText: 'ghost/ghost-model' })
        .locator('.pht-col--window')
        .getAttribute('title')) ?? '';
    report(
      'the tab lists every window and flags models absent from the catalog',
      (await page.locator('.pht-row').count()) === 2 &&
        ghostRow.includes('22:00 - 02:00 UTC') &&
        !ghostRow.includes('↻') &&
        ghostChip === 1 &&
        ghostWindowTitle.includes('crosses midnight UTC'),
      `row=${ghostRow} chips=${ghostChip} title=${ghostWindowTitle}`,
    );

    const headText = (await page.locator('.pht-head-row').textContent()) ?? '';
    report('the tab table has no UTC column', !headText.includes('UTC'), `head=${headText}`);

    const peakTabPanelDef = layoutDefs.rightPanels?.['peak-hours'];
    const peakTabPanelSubs = peakTabPanelDef?.sections?.[0]?.subSections ?? [];
    report(
      'layout: the peak-hours tab right panel shows the model detail',
      peakTabPanelSubs.length === 1 && peakTabPanelSubs[0]?.components?.[0]?.key === 'model-detail',
      JSON.stringify(peakTabPanelDef ?? null),
    );

    await page.locator('.pht-add').click();
    await page.waitForSelector('.sf-dialog', { timeout: 5000 });
    await page.selectOption('#aph-model', 'stub/stub-mini');
    await page.selectOption('#aph-tz', '0');
    await page.fill('#aph-start', '03:00');
    await page.fill('#aph-end', '06:00');
    await page.locator('.aph-save').click();
    await page.waitForSelector('.sf-dialog', { state: 'detached', timeout: 10000 });
    await delay(500);
    report(
      'adding from the tab goes through a model selector',
      (await page.locator('.pht-row').count()) === 3,
      `rows=${await page.locator('.pht-row').count()}`,
    );
    r = await jfetch('/api/peak-hours');
    const miniEntry = r.body.entries.find((e) => e.key === 'stub/stub-mini');
    report(
      'the tab-created window persists with canonical UTC',
      !!miniEntry && miniEntry.startUtc === '03:00' && miniEntry.endUtc === '06:00',
      JSON.stringify(miniEntry ?? null),
    );

    const miniRowText = (await page.locator('.pht-row', { hasText: 'stub/stub-mini' }).textContent()) ?? '';
    report(
      'window text uses the hh:mm - hh:mm UTC±n layout',
      miniRowText.includes('03:00 - 06:00 UTC'),
      `row=${miniRowText}`,
    );

    const proRowText = (await page.locator('.pht-row', { hasText: 'stub/stub-pro' }).textContent()) ?? '';
    report(
      'tab window text carries the weekday label only when not daily',
      proRowText.includes('Mon–Fri') && !miniRowText.includes('·') && !ghostRow.includes('·'),
      `pro=${proRowText} mini=${miniRowText} ghost=${ghostRow}`,
    );

    await page.locator('.pht-row', { hasText: 'stub/stub-pro' }).click();
    await delay(300);
    const selRowCls =
      (await page.locator('.pht-row', { hasText: 'stub/stub-pro' }).getAttribute('class')) ?? '';
    const detailText = (await page.locator('.model-detail').textContent()) ?? '';
    report(
      'clicking a tab entry shows its model details in the right panel',
      selRowCls.includes('pht-row--selected') &&
        detailText.includes('Stub Pro') &&
        detailText.includes('stub-pro'),
      `cls=${selRowCls} detail=${detailText.slice(0, 120)}`,
    );

    await page.locator('.pht-row', { hasText: 'ghost/ghost-model' }).click();
    await delay(300);
    const ghostSelCls =
      (await page.locator('.pht-row', { hasText: 'ghost/ghost-model' }).getAttribute('class')) ?? '';
    report(
      'entries absent from the catalog are not selectable',
      !ghostSelCls.includes('pht-row--selected') && !ghostSelCls.includes('pht-row--clickable'),
      `cls=${ghostSelCls}`,
    );

    await page.locator('.pht-row', { hasText: 'stub/stub-pro' }).locator('.pht-switch').click();
    await delay(600);
    const offRow = await page.locator('.pht-row', { hasText: 'stub/stub-pro' }).getAttribute('class');
    r = await jfetch('/api/peak-hours');
    report(
      'the switch toggles enabled via PATCH',
      offRow.includes('pht-row--off') && r.body.entries.find((e) => e.id === entryId).enabled === false,
      `cls=${offRow}`,
    );

    await page
      .locator('.pht-row', { hasText: 'stub/stub-pro' })
      .locator('button[title="Delete window"]')
      .click();
    await delay(800);
    const rowsAfterDelete = await page.locator('.pht-row').count();
    r = await jfetch('/api/peak-hours');
    report(
      'delete removes the row and persists',
      rowsAfterDelete === 2 &&
        r.body.entries.length === 2 &&
        r.body.entries.every((e) => e.key !== 'stub/stub-pro') &&
        JSON.parse(fs.readFileSync(PEAK_HOURS_PATH, 'utf8')).entries.length === 2,
      `rows=${rowsAfterDelete}`,
    );

    const badPosts = [
      [{ provider: 'stub', model: 'stub-pro', start: '08:00', end: '08:00', utcOffset: 0 }, 400],
      [{ provider: 'stub', model: 'stub-pro', start: '08:00', end: '09:00', utcOffset: 1080 }, 400],
      [{ provider: '', model: 'x', start: '08:00', end: '09:00', utcOffset: 0 }, 400],
      [{ provider: 'stub', model: 'stub-pro', start: '25:00', end: '09:00', utcOffset: 0 }, 400],
    ];
    report(
      'server rejects invalid creates with 400',
      (
        await Promise.all(
          badPosts.map(([body]) =>
            jfetch('/api/peak-hours', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }).then((x) => x.status),
          ),
        )
      ).every((s, i) => s === badPosts[i][1]),
    );
    r = await jfetch('/api/peak-hours', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'ghost',
        model: 'ghost-model',
        start: '22:00',
        end: '02:00',
        utcOffset: 0,
      }),
    });
    report(
      'duplicate windows are rejected with 400',
      r.status === 400 && /identical/.test(r.body.error ?? ''),
      JSON.stringify(r.body),
    );

    r = await jfetch('/api/peak-hours/nope', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    const rDel = await jfetch('/api/peak-hours/nope', { method: 'DELETE' });
    report('unknown ids give 404 on PATCH and DELETE', r.status === 404 && rDel.status === 404);

    const ghostId = (await jfetch('/api/peak-hours')).body.entries.find(
      (e) => e.key === 'ghost/ghost-model',
    ).id;
    r = await jfetch(`/api/peak-hours/${ghostId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: '  nightly rate window  ' }),
    });
    report(
      'PATCH updates scalar fields and trims',
      r.status === 200 && r.body.entry.note === 'nightly rate window',
      JSON.stringify(r.body.entry ?? r.body),
    );

    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForSelector('.sf-root--mobile', { timeout: 5000 });
    await delay(400);
    const mobCards = await page.locator('.pht-row').evaluateAll((rows) =>
      rows.map((row) => {
        const rect = (el) => {
          const b = el.getBoundingClientRect();
          return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height };
        };
        const note = row.querySelector('.pht-col--note');
        const win = row.querySelector('.pht-col--window');
        const btns = Array.from(row.querySelectorAll('.pht-col--actions button'));
        return {
          card: rect(row),
          switch: rect(row.querySelector('.pht-switch')),
          model: rect(row.querySelector('.pht-col--model')),
          window: rect(win),
          windowAlign: getComputedStyle(win).textAlign,
          noteDisplay: note ? getComputedStyle(note).display : null,
          actions: rect(row.querySelector('.pht-col--actions')),
          buttons: btns.map(rect),
          btnColors: btns.map((b) => getComputedStyle(b).color),
          btnBgs: btns.map((b) => getComputedStyle(b).backgroundColor),
          text: row.textContent ?? '',
        };
      }),
    );
    report(
      'mobile card: switch | name / left-aligned window | no note line',
      mobCards.length === 2 &&
        mobCards.every(
          (c) =>
            c.switch.r <= c.model.l + 1 &&
            c.window.t >= c.model.b - 2 &&
            c.windowAlign === 'left' &&
            c.noteDisplay === 'none' &&
            c.buttons.length === 2 &&
            c.btnBgs[0] !== 'rgb(244, 135, 113)' &&
            c.btnBgs[1] === 'rgb(244, 135, 113)' &&
            c.btnColors[0] !== 'rgb(244, 135, 113)' &&
            c.btnColors[1] === 'rgb(255, 255, 255)' &&
            c.text.includes(' UTC') &&
            !c.text.includes('↻'),
        ),
      JSON.stringify(mobCards),
    );
    report(
      'mobile card: edit and close are squares spanning the content block',
      mobCards.every((c) => {
        const blockH = c.window.b - c.model.t;
        return c.buttons.every((b) => Math.abs(b.w - b.h) <= 1 && Math.abs(b.h - blockH) <= 2);
      }) && Math.abs(mobCards[0].card.h - mobCards[1].card.h) < 2,
      JSON.stringify(mobCards.map((c) => ({ card: c.card, buttons: c.buttons }))),
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForSelector('.sf-root:not(.sf-root--mobile)', { timeout: 5000 });
    await delay(400);

    const secondPort = await freePort();
    procs.push(
      spawnStackProc(spawn, 'check-peak-hours:stack', 'node', ['src/pi-studio/server/index.mjs'], {
        cwd: PRODUCT_ROOT,
        env: {
          ...process.env,
          PI_STUDIO_PORT: String(secondPort),
          PI_STUDIO_HOST: '127.0.0.1',
          PI_STUDIO_CLIENT_MODULE: stub.stubPath,
          STUB_CONTROL_FILE: stub.controlPath,
          PI_STUDIO_SESSIONS: SESSIONS_ROOT,
          PI_STUDIO_STATES_PATH: path.join(RUN_ROOT, 'states2.json'),
          PI_STUDIO_DB_PATH: path.join(RUN_ROOT, 'studio2.db'),
          PI_STUDIO_PEAK_HOURS_PATH: PEAK_HOURS_PATH,
          PI_STUDIO_CWD: RUN_ROOT,
        },
        stdio: [
          'ignore',
          fs.openSync('/tmp/peak-hours-check-backend2.log', 'a'),
          fs.openSync('/tmp/peak-hours-check-backend2.log', 'a'),
        ],
      }),
    );
    await waitHttp(`http://127.0.0.1:${secondPort}/api/health`, 'second backend');
    r = await fetch(`http://127.0.0.1:${secondPort}/api/peak-hours`).then((x) => x.json());
    report(
      'a fresh backend process loads the persisted entries',
      r.entries.length === 2 &&
        r.entries.find((e) => e.key === 'ghost/ghost-model')?.note === 'nightly rate window' &&
        r.entries.some((e) => e.key === 'stub/stub-mini'),
      JSON.stringify(r.entries),
    );

    report('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  } catch (e) {
    console.error('check-peak-hours crashed:', e);
    process.exitCode = 1;
  } finally {
    if (browserRef.current) {
      await Promise.race([browserRef.current.close().catch(() => {}), delay(3000)]);
    }
    for (const p of procs) {
      try {
        if (p.exitCode === null) p.kill('SIGTERM');
      } catch {}
    }
    await delay(1500);
    for (const p of procs) {
      try {
        if (p.exitCode === null) p.kill('SIGKILL');
      } catch {}
    }
  }
  if (isFailed() || process.exitCode) process.exitCode = 1;
  process.exit(process.exitCode ?? 0);
})();
