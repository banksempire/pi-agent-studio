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

    await page.locator('.sf-docker-app[title="Scheduler"]').click();
    await page.waitForSelector('.sf-subsection-util[title="New Job"]', { timeout: 10000 });
    await page.locator('.sf-subsection-util[title="New Job"]').click();
    await page.waitForSelector('.job-editor', { timeout: 20000 });
    report('job editor opens in a workspace window', true);

    await page.locator('.job-editor-seg-btn', { hasText: 'Periodic' }).click();
    await page.waitForSelector('.je-pattern-btn', { timeout: 5000 });

    const builderDefaults = await page.evaluate(() => {
      const on = document.querySelector('.je-pattern-btn--on');
      const ref = document.querySelector('.je-cron-ref code');
      const desc = document.querySelector('.je-cron-desc');
      return {
        patterns: document.querySelectorAll('.je-pattern-btn').length,
        selected: on?.textContent ?? '',
        ref: ref?.textContent ?? '',
        desc: desc?.textContent ?? '',
        rawInputVisible: !!document.querySelector('input[placeholder="0 3 * * *"]'),
      };
    });
    report(
      'periodic builder opens with Daily selected and a synced cron reference',
      builderDefaults.patterns === 5 &&
        builderDefaults.selected === 'Daily' &&
        builderDefaults.ref === '0 9 * * *' &&
        builderDefaults.desc.includes('At 09:00') &&
        !builderDefaults.rawInputVisible,
      JSON.stringify(builderDefaults),
    );

    await page.locator('.je-pattern-btn', { hasText: 'Weekly' }).click();
    await delay(150);
    let cronRef = await page.locator('.je-cron-ref code').textContent();
    let wdDesc = await page.locator('.je-cron-desc').textContent();
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

    await page.locator('.je-pattern-btn', { hasText: 'Minutes' }).click();
    await page.locator('.je-chip', { hasText: '30 min' }).click();
    await delay(150);
    cronRef = await page.locator('.je-cron-ref code').textContent();
    wdDesc = await page.locator('.je-cron-desc').textContent();
    report(
      'minutes pattern builds a step expression',
      cronRef === '*/30 * * * *' && !!wdDesc && wdDesc.includes('Every 30 min'),
      `${cronRef} | ${wdDesc}`,
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
        segBtn: px('.job-editor-seg-btn'),
        patternBtn: px('.je-pattern-btn'),
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

    await page.locator('.je-mode-btn', { hasText: 'raw expression' }).click();
    await page.waitForSelector('input[placeholder="0 3 * * *"]', { timeout: 5000 });
    await page.locator('input[placeholder="0 3 * * *"]').fill('99 * * * *');
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
      'invalid raw cron surfaces an inline error instead of a silent preview',
      !!previewBad && previewBad.bad && /not a valid/.test(previewBad.err),
      JSON.stringify(previewBad),
    );

    await page.locator('.je-mode-btn', { hasText: 'use builder' }).click();
    await delay(150);
    const backToBuilder = await page.evaluate(() => ({
      ref: document.querySelector('.je-cron-ref code')?.textContent ?? '',
      desc: document.querySelector('.je-cron-desc')?.textContent ?? '',
    }));
    report(
      'returning to the builder restores its expression',
      backToBuilder.ref === '*/30 * * * *' && backToBuilder.desc.includes('Every 30 min'),
      JSON.stringify(backToBuilder),
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
