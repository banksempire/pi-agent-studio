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
    await page.route('**/api/jobs', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jobs: [CUSTOM_JOB] }),
      }),
    );

    await page.locator('.sf-docker-app[title="Scheduler"]').click();
    await page.waitForSelector('.sf-subsection-util[title="New Job"]', { timeout: 10000 });
    await page.locator('.sf-subsection-util[title="New Job"]').click();
    await page.waitForSelector('.job-editor', { timeout: 20000 });
    report('job editor opens in a workspace window', true);

    const modeBtn = (t) => page.locator('.je-sched-seg .job-editor-seg-btn', { hasText: t });

    const onceDefaults = await page.evaluate(() => {
      const seg = document.querySelector('.je-sched-seg');
      const on = seg?.querySelector('.job-editor-seg-btn--on');
      return {
        modes: seg?.querySelectorAll('.job-editor-seg-btn').length ?? 0,
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

    await modeBtn('Daily').click();
    await delay(150);
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

    await page.locator('.je-chip', { hasText: 'Sat' }).click();
    await delay(150);
    cronRef = await page.locator('.je-cron-ref code').textContent();
    report('day chips extend the expression', cronRef === '0 9 * * mon-sat', String(cronRef));

    await page.locator('.je-chip', { hasText: 'Sun' }).click();
    await page.locator('select.je-time[title="Hour"]').selectOption('3');
    await delay(150);
    cronRef = await page.locator('.je-cron-ref code').textContent();
    report('time selectors rewrite the expression', cronRef === '0 3 * * sun-sat', String(cronRef));

    const sizes = await page.evaluate(() => {
      const px = (sel) => {
        const el = document.querySelector(sel);
        return el ? Number.parseFloat(getComputedStyle(el).fontSize) : null;
      };
      return {
        titleMain: px('.job-editor-title-main'),
        label: px('.job-editor-field label'),
        input: px('.job-editor-input'),
        segBtn: px('.job-editor-seg-btn'),
        schedSegBtn: px('.je-sched-seg .job-editor-seg-btn'),
        chip: px('.je-chip'),
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
      [...document.querySelectorAll('.je-every-seg .job-editor-seg-btn')].map((b) => b.textContent),
    );
    report(
      'minutes mode offers the requested interval options in a selector',
      JSON.stringify(minutesOptions) === JSON.stringify(['1', '2', '3', '4', '5', '10', '15', '20', '30']),
      JSON.stringify(minutesOptions),
    );
    await page.locator('.je-every-seg .job-editor-seg-btn', { hasText: '30' }).click();
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
      [...document.querySelectorAll('.je-atmin-seg .job-editor-seg-btn')].map((b) => b.textContent),
    );
    report(
      'hourly mode offers minute options in a selector',
      hourlyOptions.length === 12 && hourlyOptions[0] === '00' && hourlyOptions[11] === '55',
      JSON.stringify(hourlyOptions),
    );
    await page.locator('.je-atmin-seg .job-editor-seg-btn', { hasText: '15' }).click();
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

    const customItem = page.locator('.jobs-item', { hasText: 'custom-cron job' });
    await customItem.first().waitFor({ timeout: 10000 });
    await customItem.first().locator('.jobs-item-row').first().click();
    await page.waitForSelector('.job-editor-title-main:has-text("custom-cron job")', { timeout: 10000 });
    await delay(400);
    const customState = await page.evaluate(() => {
      const editors = [...document.querySelectorAll('.job-editor')];
      const ed = editors.find((e) => e.textContent?.includes('custom-cron job')) ?? null;
      const seg = ed?.querySelector('.je-sched-seg') ?? null;
      const on = seg?.querySelector('.job-editor-seg-btn--on');
      return {
        created: ed !== null,
        patterns: seg?.querySelectorAll('.job-editor-seg-btn').length ?? 0,
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
        patterns: seg?.querySelectorAll('.job-editor-seg-btn').length ?? 0,
        selected: seg?.querySelector('.job-editor-seg-btn--on')?.textContent ?? '',
        ref: ed?.querySelector('.je-cron-ref code')?.textContent ?? '',
      };
    });
    report(
      'picking a builder mode from Advanced rewrites the expression',
      rebuilt.patterns === 7 && rebuilt.selected === 'Daily' && /^0 \d{1,2} \* \* \*$/.test(rebuilt.ref),
      JSON.stringify(rebuilt),
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
