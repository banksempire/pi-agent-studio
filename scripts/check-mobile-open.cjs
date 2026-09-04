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
const RUN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mobopen-check-'));
const SESSIONS_ROOT = path.join(RUN_ROOT, 'sessions');
const TEST_DIR_NAME = '--tmp-mobopen-check--';
const TEST_SESSIONS_DIR = path.join(SESSIONS_ROOT, TEST_DIR_NAME);
const TEST_CWD = RUN_ROOT;
const STACK_STAMP = 'check-mobile-open:stack';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function pickPorts() {
  const backend = Number(process.env.MOBOPEN_BACKEND_PORT) || (await freePort());
  const vite = Number(process.env.MOBOPEN_VITE_PORT) || (await freePort());
  return { backend, vite };
}

function writeSessions() {
  fs.mkdirSync(TEST_SESSIONS_DIR, { recursive: true });
  const uid = () => `019f${Math.random().toString(16).slice(2, 14)}`;
  const sessionFile = (name, turns, ageMs) => {
    const lines = [];
    const id = uid();
    const base = 1786342000000;
    lines.push(
      JSON.stringify({
        type: 'session',
        version: 3,
        id,
        parentId: null,
        timestamp: new Date(base).toISOString(),
        cwd: TEST_CWD,
      }),
    );
    let prev = id;
    let n = 0;
    for (let t = 0; t < turns; t++) {
      n += 1;
      const umid = `u${n}`;
      lines.push(
        JSON.stringify({
          type: 'message',
          id: umid,
          parentId: prev,
          timestamp: new Date(base + n * 60000).toISOString(),
          message: {
            role: 'user',
            content: [{ type: 'text', text: `${name}: question ${t + 1}` }],
            timestamp: base + n * 60000,
          },
        }),
      );
      prev = umid;
      n += 1;
      const amid = `a${n}`;
      lines.push(
        JSON.stringify({
          type: 'message',
          id: amid,
          parentId: umid,
          timestamp: new Date(base + n * 60000 + 1000).toISOString(),
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: `Answer ${t + 1} for ${name}` }],
            timestamp: base + n * 60000 + 1000,
            ...(t === turns - 1 ? { stopReason: 'stop' } : {}),
          },
        }),
      );
      prev = amid;
    }
    const fn = path.join(
      TEST_SESSIONS_DIR,
      `2026-08-10T00-00-00-${String(turns).padStart(3, '0')}Z_${name.toLowerCase()}-${uid()}.jsonl`,
    );
    fs.writeFileSync(fn, `${lines.join('\n')}\n`);
    const old = new Date(Date.now() - ageMs);
    fs.utimesSync(fn, old, old);
  };
  sessionFile('Mob-A', 3, 10_000);
  sessionFile('Mob-B', 2, 120_000);
}

function killProc(child) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {}
}

async function waitHttp(url, label, tries = 40) {
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
}

function makeReporter() {
  let failed = false;
  const report = (name, ok, extra = '') => {
    console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
    if (!ok) failed = true;
  };
  return { report, isFailed: () => failed };
}

const composerIsFocused = (page) =>
  page.evaluate(
    () =>
      document.activeElement instanceof HTMLElement &&
      document.activeElement.classList.contains('chat-input'),
  );

(async () => {
  const { report, isFailed } = makeReporter();
  assertMemoryHeadroom({ label: 'check-mobile-open' });
  sweepStaleStackProcesses(STACK_STAMP);
  const procs = [];
  const browserRef = { current: null };
  installStackCleanup({ procs, stamp: STACK_STAMP, browserRef, label: 'check-mobile-open' });

  let browser;
  try {
    const ports = await pickPorts();
    console.log(`stack: backend :${ports.backend} vite :${ports.vite}`);
    const stub = writeStubClient(RUN_ROOT);
    writeSessions();

    procs.push(
      spawnStackProc(spawn, STACK_STAMP, 'node', ['src/pi-studio/server/index.mjs'], {
        cwd: PRODUCT_ROOT,
        env: {
          ...process.env,
          PI_STUDIO_PORT: String(ports.backend),
          PI_STUDIO_CLIENT_MODULE: stub.stubPath,
          STUB_CONTROL_FILE: stub.controlPath,
          PI_STUDIO_SESSIONS: SESSIONS_ROOT,
          PI_STUDIO_DB_PATH: path.join(RUN_ROOT, 'studio.db'),
          PI_STUDIO_STATES_PATH: path.join(RUN_ROOT, 'states.json'),
          PI_STUDIO_CWD: TEST_CWD,
        },
        stdio: [
          'ignore',
          fs.openSync('/tmp/mobopen-check-backend.log', 'a'),
          fs.openSync('/tmp/mobopen-check-backend.log', 'a'),
        ],
      }),
    );
    await waitHttp(`http://127.0.0.1:${ports.backend}/api/health`, 'backend');
    procs.push(
      spawnStackProc(
        spawn,
        STACK_STAMP,
        'node',
        [
          'node_modules/.bin/vite',
          '--config',
          'vite.config.ts',
          '--host',
          '127.0.0.1',
          '--port',
          String(ports.vite),
        ],
        {
          cwd: PRODUCT_ROOT,
          env: { ...process.env, PI_API_PROXY: `http://127.0.0.1:${ports.backend}` },
          stdio: [
            'ignore',
            fs.openSync('/tmp/mobopen-check-vite.log', 'a'),
            fs.openSync('/tmp/mobopen-check-vite.log', 'a'),
          ],
        },
      ),
    );
    await waitHttp(`http://127.0.0.1:${ports.vite}/`, 'vite');

    browser = await chromium.launch();
    browserRef.current = browser;
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text()}`);
    });
    await page.goto(`http://127.0.0.1:${ports.vite}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sf-root--mobile', { timeout: 60000 });
    await delay(800);
    const bootFocus = await page.evaluate(() => ({
      hasComposer: !!document.querySelector('.chat-input'),
      focused:
        document.activeElement instanceof HTMLElement &&
        document.activeElement.classList.contains('chat-input'),
    }));
    report(
      'boot: the composer is not auto-focused on load',
      !bootFocus.focused,
      `composer=${bootFocus.hasComposer}`,
    );

    const mobilePanel = page.locator('.sf-mobile-panel');
    const historyItems = page.locator('[data-sub-body="history"] .chat-list-item');
    const mobileBarLabel = () => page.locator('.sf-mobile-tab-label').textContent();

    report(
      'mobile mode: menu bar hidden, bottom docker shown',
      (await page.locator('.sf-menu-bar').count()) === 0 &&
        (await page.locator('.sf-docker--bottom').count()) === 1,
    );

    await page.locator('.sf-docker-app[title="Chat"]').click();
    await page.waitForSelector('[data-sub-body="history"] .chat-list-item', { timeout: 60000 });
    report(
      'chat panel opens fullscreen with the history list',
      (await mobilePanel.isVisible()) && (await historyItems.count()) >= 2,
    );

    await historyItems.first().click();
    await page.waitForSelector('.sf-root .chat-messages', { timeout: 30000 });
    await delay(500);
    report(
      'tapping a chat history item opens the chat window',
      (await page.locator('.chat-messages').count()) === 1,
    );
    report('…and the panel closes at once', (await mobilePanel.count()) === 0);
    const label1 = String(await mobileBarLabel());
    report('…and the opened chat becomes the active tab', label1.includes('Mob-A'), `label=${label1}`);
    report('mobile: opening a chat does not focus the composer', !(await composerIsFocused(page)));

    await page.locator('.chat-input:visible').fill('focus check from mobile');
    await page.locator('.chat-send-btn:visible').click();
    await delay(400);
    report(
      'mobile: tapping Send does not refocus the composer (keyboard stays closed)',
      !(await composerIsFocused(page)),
    );
    report(
      '…and the sent message lands in the transcript',
      await page.locator('.chat-user-bubble', { hasText: 'focus check from mobile' }).first().isVisible(),
    );

    await page.locator('.sf-docker-app[title="Chat"]').click();
    await page.waitForSelector('[data-sub-body="history"] .chat-list-item', { timeout: 30000 });
    await page.locator('.sf-subsection-util[title="New Chat (Ctrl+N)"]').click();
    await page.waitForSelector('.sf-root .chat-messages', { timeout: 30000 });
    await delay(500);
    report('tapping New Chat creates a chat window', String(await mobileBarLabel()).includes('New Chat'));
    report('…and the panel closes at once', (await mobilePanel.count()) === 0);
    report('mobile: a fresh chat does not focus the composer', !(await composerIsFocused(page)));

    await page.setViewportSize({ width: 1440, height: 844 });
    await page.waitForSelector('.sf-menu-bar', { timeout: 15000 });
    await delay(600);
    report('desktop: switching shell mode does not focus the composer', !(await composerIsFocused(page)));
    await delay(400);
    const desktopItem = page.locator('[data-sub-body="history"] .chat-list-item:has-text("Mob-B")');
    await desktopItem.first().click();
    await delay(600);
    report(
      'desktop: tapping a history item opens it but keeps the left panel open',
      (await page.locator('.sf-left-group').isVisible()) &&
        (await page.locator('[data-sub-body="history"]').isVisible()),
    );
    report('desktop: opening a chat does not focus the composer', !(await composerIsFocused(page)));

    await page.locator('.chat-input:visible').fill('focus check from desktop');
    await page.locator('.chat-send-btn:visible').click();
    await delay(400);
    report('desktop: clicking Send does not refocus the composer', !(await composerIsFocused(page)));
    report(
      '…and the sent message lands in the transcript',
      await page.locator('.chat-user-bubble', { hasText: 'focus check from desktop' }).first().isVisible(),
    );

    await page.locator('.chat-input:visible').fill('enter focus check from desktop');
    await page.locator('.chat-input:visible').press('Enter');
    await delay(400);
    report('desktop: sending via Enter keeps focus in the composer', await composerIsFocused(page));
    report(
      '…and the enter-sent message lands in the transcript',
      await page
        .locator('.chat-user-bubble', { hasText: 'enter focus check from desktop' })
        .first()
        .isVisible(),
    );

    report('no console/page errors', errors.length === 0, errors.join('; '));
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    for (const p of procs) killProc(p);
    fs.rmSync(RUN_ROOT, { recursive: true, force: true });
  }
  process.exit(isFailed() || process.exitCode === 1 ? 1 : 0);
})();
