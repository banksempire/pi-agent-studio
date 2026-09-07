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
const RUN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-check-'));
const SESSIONS_ROOT = path.join(RUN_ROOT, 'sessions');
const TEST_DIR_NAME = '--tmp-pinned-check--';
const TEST_SESSIONS_DIR = path.join(SESSIONS_ROOT, TEST_DIR_NAME);
const TEST_CWD = RUN_ROOT;
const STACK_STAMP = 'check-pinned:stack';

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
      `2026-08-10T00-00-00-${String(turns).padStart(3, '0')}Z_${name}-${uid()}.jsonl`,
    );
    fs.writeFileSync(fn, `${lines.join('\n')}\n`);
    const old = new Date(Date.now() - ageMs);
    fs.utimesSync(fn, old, old);
  };
  sessionFile('Pin-A', 3, 10_000);
  sessionFile('Pin-B', 2, 120_000);
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

const pinnedBody = '[data-sub-body="pinned"]';
const historyBody = '[data-sub-body="history"]';
const pinnedItems = (page) => page.locator(`${pinnedBody} .chat-list-item`);
const historyItems = (page) => page.locator(`${historyBody} .chat-list-item`);

async function menuRow(page, label) {
  return page.locator('.sf-sm-menu-row', { hasText: label }).first();
}

async function openRowMenu(page, scopeSel, label) {
  await page.locator(`${scopeSel} .chat-list-item`, { hasText: label }).first().click({ button: 'right' });
  await page.waitForSelector('.sf-sm-menu', { timeout: 5000 });
}

(async () => {
  const { report, isFailed } = makeReporter();
  assertMemoryHeadroom({ label: 'check-pinned' });
  sweepStaleStackProcesses(STACK_STAMP);
  const procs = [];
  const browserRef = { current: null };
  installStackCleanup({ procs, stamp: STACK_STAMP, browserRef, label: 'check-pinned' });

  let browser;
  try {
    const backend = await freePort();
    const vite = await freePort();
    console.log(`stack: backend :${backend} vite :${vite}`);
    const stub = writeStubClient(RUN_ROOT);
    writeSessions();

    procs.push(
      spawnStackProc(spawn, STACK_STAMP, 'node', ['src/pi-studio/server/index.mjs'], {
        cwd: PRODUCT_ROOT,
        env: {
          ...process.env,
          PI_STUDIO_PORT: String(backend),
          PI_STUDIO_CLIENT_MODULE: stub.stubPath,
          STUB_CONTROL_FILE: stub.controlPath,
          PI_STUDIO_SESSIONS: SESSIONS_ROOT,
          PI_STUDIO_DB_PATH: path.join(RUN_ROOT, 'studio.db'),
          PI_STUDIO_STATES_PATH: path.join(RUN_ROOT, 'states.json'),
          PI_STUDIO_CWD: TEST_CWD,
        },
        stdio: [
          'ignore',
          fs.openSync('/tmp/pinned-check-backend.log', 'a'),
          fs.openSync('/tmp/pinned-check-backend.log', 'a'),
        ],
      }),
    );
    await waitHttp(`http://127.0.0.1:${backend}/api/health`, 'backend');
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
          String(vite),
        ],
        {
          cwd: PRODUCT_ROOT,
          env: { ...process.env, PI_API_PROXY: `http://127.0.0.1:${backend}` },
          stdio: [
            'ignore',
            fs.openSync('/tmp/pinned-check-vite.log', 'a'),
            fs.openSync('/tmp/pinned-check-vite.log', 'a'),
          ],
        },
      ),
    );
    await waitHttp(`http://127.0.0.1:${vite}/`, 'vite');

    browser = await chromium.launch();
    browserRef.current = browser;
    const page = await browser.newPage({ viewport: { width: 1440, height: 844 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text()}`);
    });
    await page.goto(`http://127.0.0.1:${vite}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(`${historyBody} .chat-list-item`, { timeout: 60000 });
    await delay(500);

    const order = await page.evaluate(
      ([pinSel, histSel]) => {
        const pin = document.querySelector(pinSel);
        const hist = document.querySelector(histSel);
        if (!pin || !hist) return 'missing';
        return !!(pin.compareDocumentPosition(hist) & Node.DOCUMENT_POSITION_FOLLOWING);
      },
      [pinnedBody, historyBody],
    );
    report('P1 Pinned sub-section exists and sits above Chat History', order === true, `order=${order}`);

    const emptyText = await page
      .locator(`${pinnedBody} .chat-list-empty`)
      .textContent()
      .catch(() => '');
    report(
      'P2 empty Pinned section shows a hint, both chats stay in history',
      /No pinned chats/.test(String(emptyText)) &&
        (await historyItems(page).count()) === 2 &&
        (await pinnedItems(page).count()) === 0,
      `empty="${String(emptyText).trim()}" history=${await historyItems(page).count()} pinned=${await pinnedItems(page).count()}`,
    );

    await openRowMenu(page, historyBody, 'Pin-A');
    const pinRow = await menuRow(page, 'Pin');
    const pinRowText = (await pinRow.textContent().catch(() => '')) ?? '';
    const pinRowSvg = await pinRow
      .locator('svg.sf-icon--svg')
      .count()
      .catch(() => 0);
    report(
      'P3 right-click a history item opens a menu whose Pin entry carries the SVG pin icon',
      pinRowText.trim() === 'Pin' && pinRowSvg === 1,
      `row="${pinRowText.trim()}" svg=${pinRowSvg}`,
    );
    await pinRow.click();
    await page.waitForSelector(`${pinnedBody} .chat-list-item`, { timeout: 5000 });
    await delay(300);
    report(
      'P4 Pin moves the chat into the Pinned section and out of Chat History',
      (await pinnedItems(page).count()) === 1 &&
        (await pinnedItems(page).first().textContent()).includes('Pin-A') &&
        (await historyItems(page).count()) === 1 &&
        !((await historyItems(page).first().textContent()) ?? '').includes('Pin-A'),
      `pinned=${await pinnedItems(page).count()} history=${await historyItems(page).count()}`,
    );

    await openRowMenu(page, pinnedBody, 'Pin-A');
    const unpinRow = await menuRow(page, 'Unpin');
    const unpinText = ((await unpinRow.textContent().catch(() => '')) ?? '').trim();
    const unpinSvg = await unpinRow
      .locator('svg.sf-icon--svg')
      .count()
      .catch(() => 0);
    report(
      'P5 right-click a pinned chat offers Unpin with the SVG unpin icon',
      unpinText === 'Unpin' && unpinSvg === 1,
      `row="${unpinText}" svg=${unpinSvg}`,
    );
    await unpinRow.click();
    await page.waitForSelector(`${historyBody} .chat-list-item:has-text("Pin-A")`, { timeout: 5000 });
    await delay(300);
    report(
      'P6 Unpin moves the chat back into Chat History',
      (await pinnedItems(page).count()) === 0 && (await historyItems(page).count()) === 2,
      `pinned=${await pinnedItems(page).count()} history=${await historyItems(page).count()}`,
    );

    await openRowMenu(page, historyBody, 'Pin-A');
    await (await menuRow(page, 'Pin')).click();
    await page.waitForSelector(`${pinnedBody} .chat-list-item:has-text("Pin-A")`, { timeout: 5000 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector(`${historyBody} .chat-list-item`, { timeout: 60000 });
    await delay(500);
    report(
      'P7 pinning survives a full page reload (persisted)',
      (await pinnedItems(page).count()) === 1 &&
        ((await pinnedItems(page).first().textContent()) ?? '').includes('Pin-A') &&
        (await historyItems(page).count()) === 1,
      `pinned=${await pinnedItems(page).count()} history=${await historyItems(page).count()}`,
    );

    await openRowMenu(page, historyBody, 'Pin-B');
    await (await menuRow(page, 'Pin')).click();
    await page.waitForSelector(`${pinnedBody} .chat-list-item:has-text("Pin-B")`, { timeout: 5000 });
    await delay(400);
    const historyEmptyText = await page
      .locator(`${historyBody} .chat-list-empty`)
      .textContent()
      .catch(() => '');
    const firstPinned = ((await pinnedItems(page).first().textContent()) ?? '').includes('Pin-A');
    report(
      'P8 pinning every chat empties history with an all-pinned note; pinned order is most recent first',
      /All chats are pinned/.test(String(historyEmptyText)) &&
        (await pinnedItems(page).count()) === 2 &&
        firstPinned,
      `historyEmpty="${String(historyEmptyText).trim()}" pinned=${await pinnedItems(page).count()} firstIsA=${firstPinned}`,
    );

    await openRowMenu(page, pinnedBody, 'Pin-B');
    await (await menuRow(page, 'Unpin')).click();
    await page.waitForSelector(`${historyBody} .chat-list-item:has-text("Pin-B")`, { timeout: 5000 });
    await delay(300);
    report(
      'P9 unpinning from the Pinned section restores the other chat in history',
      (await pinnedItems(page).count()) === 1 && (await historyItems(page).count()) === 1,
      `pinned=${await pinnedItems(page).count()} history=${await historyItems(page).count()}`,
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
