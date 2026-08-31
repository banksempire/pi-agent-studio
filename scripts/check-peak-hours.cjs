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
const PEAK_HOURS_PATH = path.join(RUN_ROOT, 'api-peak-hours.json');
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

  const r1 = store.create({ api: 'anthropic', start: '09:00', end: '17:00', utcOffset: 120 });
  report(
    'unit: create stores canonical UTC and renders both clocks',
    !!r1.entry &&
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

  const r3 = store.create({ api: 'openai-completions', start: '22:00', end: '02:00', utcOffset: 0 });
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
  report(
    'unit: disabled entries never peak',
    store.list().length === 2 &&
      store.update(r3.entry.id, { enabled: false }) &&
      !store.list().find((e) => e.id === r3.entry.id).enabled,
  );

  const bad = [
    [{ api: 'x', start: '09:00', end: '09:00', utcOffset: 0 }, 'start and end must differ'],
    [{ api: 'x', start: '09:00', end: '17:00', utcOffset: 900 }, 'utcOffset'],
    [{ api: '   ', start: '09:00', end: '17:00', utcOffset: 0 }, 'api is required'],
    [{ api: 'x', start: '9pm', end: '17:00', utcOffset: 0 }, 'start must be'],
    [{ api: 'x', start: '09:00', end: '17:00', utcOffset: 0, note: 'n'.repeat(201) }, 'note must be'],
  ];
  report(
    'unit: create rejects invalid input',
    bad.every(([input, want]) => {
      const r = store.create(input);
      return !!r.error && r.error.includes(want);
    }),
    JSON.stringify(bad.map(([input, want]) => store.create(input).error ?? `accepted:${want}`)),
  );

  const dup = store.create({ api: 'anthropic', start: '07:00', end: '15:00', utcOffset: 0 });
  report(
    'unit: identical window for the same api is rejected',
    !!dup.error && /identical/.test(dup.error),
    JSON.stringify(dup),
  );

  const again = mod.createPeakHoursStore({ persistPath: unitPath });
  report(
    'unit: store reloads persisted entries from disk',
    again.list().length === 2 && again.list().every((e) => e.id && e.api),
    JSON.stringify(again.list().map((e) => e.api)),
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
          api: 'ok-api',
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
          api: '',
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
          api: 'x',
          startUtc: 90,
          endUtc: 90,
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
  report(
    'unit: hand-edited invalid entries are skipped on load',
    hand.list().length === 1 && hand.list()[0].id === 'good1',
    JSON.stringify(hand.list()),
  );

  report(
    'unit: remove deletes and persists',
    hand.remove('good1') &&
      hand.list().length === 0 &&
      mod.createPeakHoursStore({ persistPath: handPath }).list().length === 0,
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
    const peakDef = catalogSubs.find((s) => s.id === 'api-peak-hours');
    report(
      'layout: api-peak-hours subsection is variable-height with a minHeight',
      peakDef?.height === 'variable' &&
        peakDef?.minHeight === 80 &&
        peakDef?.components?.[0]?.key === 'api-peak-hours',
      JSON.stringify(peakDef ?? null),
    );

    await page.waitForSelector('.aph', { timeout: 10000 });
    const emptyHint = await page.locator('.aph-empty').count();
    report('panel starts with the empty hint', emptyHint === 1, `hint=${emptyHint}`);

    await page.locator('.model-catalog-row', { hasText: 'Stub Pro' }).first().click();
    await delay(300);

    await page.locator('.aph-add').click();
    await page.waitForSelector('.aph-editor', { timeout: 5000 });
    const prefill = await page.locator('#aph-api').inputValue();
    report(
      'add form prefills the API of the selected catalog model',
      prefill === 'stub-api-a',
      `prefill=${prefill}`,
    );
    const optionVals = await page
      .locator('#aph-api-options option')
      .evaluateAll((els) => els.map((e) => e.value));
    report(
      'API datalist offers the catalog APIs',
      optionVals.includes('stub-api-a') && optionVals.includes('stub-api-b'),
      JSON.stringify(optionVals),
    );

    await page.fill('#aph-api', 'stub-api-a');
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
    await page.locator('.aph-row').waitFor({ timeout: 10000 });

    let row = await page.locator('.aph-row').first().textContent();
    report(
      'created row shows the window in its timezone plus the UTC equivalent',
      row.includes('stub-api-a') &&
        row.includes('09:00–17:00') &&
        row.includes('UTC+02:00') &&
        row.includes('07:00–15:00 UTC'),
      `row=${row}`,
    );

    let r = await jfetch('/api/peak-hours');
    const disk1 = JSON.parse(fs.readFileSync(PEAK_HOURS_PATH, 'utf8'));
    report(
      'create persists canonical UTC minutes to disk',
      r.status === 200 &&
        r.body.entries.length === 1 &&
        r.body.entries[0].api === 'stub-api-a' &&
        r.body.entries[0].startUtc === '07:00' &&
        r.body.entries[0].endUtc === '15:00' &&
        disk1.version === 1 &&
        disk1.entries[0].startUtc === 420 &&
        disk1.entries[0].endUtc === 900 &&
        disk1.entries[0].utcOffset === 120,
      JSON.stringify({ api: r.body.entries[0], disk: disk1.entries[0] }),
    );
    const entryId = r.body.entries[0].id;

    await page
      .locator('.aph-row', { hasText: 'stub-api-a' })
      .locator('.aph-actions button', { hasText: '✎' })
      .click();
    await page.waitForSelector('.aph-editor', { timeout: 5000 });
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
    await page.locator('.aph-row').waitFor({ timeout: 10000 });
    r = await jfetch('/api/peak-hours');
    report(
      'saving after a timezone switch keeps the stored UTC window',
      r.body.entries[0].startUtc === '07:00' &&
        r.body.entries[0].endUtc === '15:00' &&
        r.body.entries[0].utcOffset === 0,
      JSON.stringify(r.body.entries[0]),
    );
    row = await page.locator('.aph-row', { hasText: 'stub-api-a' }).textContent();
    report(
      'row re-renders in the new timezone',
      row.includes('07:00–15:00') && row.includes('UTC'),
      `row=${row}`,
    );

    await page.locator('.aph-add').click();
    await page.waitForSelector('.aph-editor', { timeout: 5000 });
    await page.fill('#aph-api', 'ghost-api');
    await page.fill('#aph-start', '22:00');
    await page.fill('#aph-end', '02:00');
    await page.selectOption('#aph-tz', '0');
    await page.locator('.aph-save').click();
    await page.locator('.aph-row', { hasText: 'ghost-api' }).waitFor({ timeout: 10000 });
    const ghostRow = await page.locator('.aph-row', { hasText: 'ghost-api' }).textContent();
    const ghostChip = await page.locator('.aph-unknown').count();
    report(
      'entries for APIs absent from the catalog are kept and flagged',
      ghostRow.includes('22:00–02:00') && ghostRow.includes('↻') && ghostChip === 1,
      `row=${ghostRow} chips=${ghostChip}`,
    );

    await page.locator('.aph-row .aph-actions button', { hasText: '✎' }).first().click();
    await page.waitForSelector('.aph-editor', { timeout: 5000 });
    await page.fill('#aph-start', '09:00');
    await page.fill('#aph-end', '09:00');
    const saveDisabled = await page.locator('.aph-save').isDisabled();
    const needs = (await page.locator('.aph-live--warn').textContent()) ?? '';
    report(
      'a zero-length window is rejected client-side',
      saveDisabled && needs.includes('window'),
      `disabled=${saveDisabled} needs=${needs}`,
    );
    await page.locator('.aph-editor button', { hasText: 'Cancel' }).click();
    await delay(300);
    const rowsAfterCancel = await page.locator('.aph-row').count();
    report('cancel leaves the list untouched', rowsAfterCancel === 2, `rows=${rowsAfterCancel}`);

    await page.locator('.aph-row', { hasText: 'stub-api-a' }).locator('.aph-switch').click();
    await delay(600);
    const offRow = await page.locator('.aph-row', { hasText: 'stub-api-a' }).getAttribute('class');
    r = await jfetch('/api/peak-hours');
    report(
      'the switch toggles enabled via PATCH',
      offRow.includes('aph-row--off') && r.body.entries.find((e) => e.id === entryId).enabled === false,
      `cls=${offRow}`,
    );

    await page
      .locator('.aph-row', { hasText: 'stub-api-a' })
      .locator('.aph-actions button', { hasText: '✕' })
      .click();
    await delay(800);
    const rowsAfterDelete = await page.locator('.aph-row').count();
    r = await jfetch('/api/peak-hours');
    report(
      'delete removes the row and persists',
      rowsAfterDelete === 1 &&
        r.body.entries.length === 1 &&
        r.body.entries[0].api === 'ghost-api' &&
        JSON.parse(fs.readFileSync(PEAK_HOURS_PATH, 'utf8')).entries.length === 1,
      `rows=${rowsAfterDelete}`,
    );

    const badPosts = [
      [{ api: 'stub-api-a', start: '08:00', end: '08:00', utcOffset: 0 }, 400],
      [{ api: 'stub-api-a', start: '08:00', end: '09:00', utcOffset: 1080 }, 400],
      [{ api: '', start: '08:00', end: '09:00', utcOffset: 0 }, 400],
      [{ api: 'stub-api-a', start: '25:00', end: '09:00', utcOffset: 0 }, 400],
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
      body: JSON.stringify({ api: 'ghost-api', start: '22:00', end: '02:00', utcOffset: 0 }),
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

    const ghostId = (await jfetch('/api/peak-hours')).body.entries[0].id;
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
      r.entries.length === 1 &&
        r.entries[0].api === 'ghost-api' &&
        r.entries[0].note === 'nightly rate window',
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
