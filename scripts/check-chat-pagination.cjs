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
const RUN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pagination-check-'));
const SESSIONS_ROOT = path.join(RUN_ROOT, 'sessions');
const TEST_DIR_NAME = '--tmp-pagination-check--';
const TEST_SESSIONS_DIR = path.join(SESSIONS_ROOT, TEST_DIR_NAME);
const TEST_CWD = RUN_ROOT;
const STACK_STAMP = 'check-pagination:stack';

const TOTAL_SESSIONS = 60;
const PAGE_SIZE = 50;

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
  const base = 1786342000000;
  const files = [];
  for (let i = 0; i < TOTAL_SESSIONS; i++) {
    const name = `Pag-${String(i).padStart(2, '0')}`;
    const id = uid();
    const lines = [
      JSON.stringify({
        type: 'session',
        version: 3,
        id,
        parentId: null,
        timestamp: new Date(base).toISOString(),
        cwd: TEST_CWD,
      }),
      JSON.stringify({
        type: 'message',
        id: 'u1',
        parentId: id,
        timestamp: new Date(base + 60000).toISOString(),
        message: {
          role: 'user',
          content: [{ type: 'text', text: `${name} history probe` }],
          timestamp: base + 60000,
        },
      }),
      JSON.stringify({
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: new Date(base + 61000).toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `Answer from ${name}` }],
          timestamp: base + 61000,
          stopReason: 'stop',
        },
      }),
    ];
    const fn = path.join(
      TEST_SESSIONS_DIR,
      `2026-08-11T00-00-${String(i).padStart(2, '0')}-00Z_${name}-${uid()}.jsonl`,
    );
    fs.writeFileSync(fn, `${lines.join('\n')}\n`);
    const ageMs = 10_000 + i * 60_000;
    const old = new Date(Date.now() - ageMs);
    fs.utimesSync(fn, old, old);
    files.push(fn);
  }
  return files;
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

async function getJson(base, p) {
  const res = await fetch(`${base}${p}`);
  if (!res.ok) throw new Error(`GET ${p} → ${res.status}`);
  return res.json();
}

function makeReporter() {
  let failed = false;
  const report = (name, ok, extra = '') => {
    console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
    if (!ok) failed = true;
  };
  return { report, isFailed: () => failed };
}

const historyBody = '[data-sub-body="history"]';
const pinnedBody = '[data-sub-body="pinned"]';
const LOAD_MORE_SEL = '.sf-pl-item[data-id="sf-load-more-chats"]';
const sessionRows = (page) => page.locator(`${historyBody} .sf-pl-item:not([data-id="sf-load-more-chats"])`);
const loadMoreRow = (page) => page.locator(`${historyBody} ${LOAD_MORE_SEL}`);

(async () => {
  const { report, isFailed } = makeReporter();
  assertMemoryHeadroom({ label: 'check-pagination' });
  sweepStaleStackProcesses(STACK_STAMP);
  const procs = [];
  const browserRef = { current: null };
  installStackCleanup({ procs, stamp: STACK_STAMP, browserRef, label: 'check-pagination' });

  let browser;
  try {
    const backend = await freePort();
    const vite = await freePort();
    console.log(`stack: backend :${backend} vite :${vite}`);
    const stub = writeStubClient(RUN_ROOT);
    const sessionFiles = writeSessions();

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
          fs.openSync('/tmp/pagination-check-backend.log', 'a'),
          fs.openSync('/tmp/pagination-check-backend.log', 'a'),
        ],
      }),
    );
    const apiBase = `http://127.0.0.1:${backend}`;
    await waitHttp(`${apiBase}/api/health`, 'backend');
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
            fs.openSync('/tmp/pagination-check-vite.log', 'a'),
            fs.openSync('/tmp/pagination-check-vite.log', 'a'),
          ],
        },
      ),
    );
    const webBase = `http://127.0.0.1:${vite}`;
    await waitHttp(`${webBase}/`, 'vite');

    const legacy = await getJson(apiBase, '/api/sessions');
    report(
      'A1 legacy GET returns every session plus total',
      legacy.sessions.length === TOTAL_SESSIONS && legacy.total === TOTAL_SESSIONS,
      `sessions=${legacy.sessions.length} total=${legacy.total}`,
    );

    const page1 = await getJson(apiBase, '/api/sessions?limit=5&offset=0');
    const mtimesOk = page1.sessions.every((s, i, a) => i === 0 || a[i - 1].modified >= s.modified);
    const legacyById = new Map(legacy.sessions.map((s) => [s.file, s]));
    report(
      'A2 limit/offset page returns newest slice with total, mtime-desc order',
      page1.sessions.length === 5 &&
        page1.total === TOTAL_SESSIONS &&
        mtimesOk &&
        page1.sessions.every((s) => legacyById.has(s.file)) &&
        page1.sessions[0].modified === legacy.sessions[0].modified,
      `rows=${page1.sessions.length} total=${page1.total} ordered=${mtimesOk}`,
    );

    const walked = [];
    let pagesConsistent = true;
    for (let offset = 0; offset < TOTAL_SESSIONS; offset += 5) {
      const pg = await getJson(apiBase, `/api/sessions?limit=5&offset=${offset}`);
      if (pg.sessions.length !== Math.min(5, TOTAL_SESSIONS - offset)) pagesConsistent = false;
      walked.push(...pg.sessions.map((s) => s.file));
    }
    const noDup = new Set(walked).size === walked.length;
    const sameSet = walked.length === legacy.sessions.length && walked.every((f) => legacyById.has(f));
    report(
      'A3 walking pages covers all sessions exactly once',
      pagesConsistent && noDup && sameSet,
      `walked=${walked.length} unique=${new Set(walked).size}`,
    );

    const beyond = await getJson(apiBase, '/api/sessions?limit=5&offset=60');
    report(
      'A4 offset past the end yields an empty page with total intact',
      beyond.sessions.length === 0 && beyond.total === TOTAL_SESSIONS,
      `rows=${beyond.sessions.length} total=${beyond.total}`,
    );

    const deep = [...sessionFiles].sort((a, b) => {
      const ma = legacy.sessions.find((s) => s.file === a)?.modified ?? 0;
      const mb = legacy.sessions.find((s) => s.file === b)?.modified ?? 0;
      return mb - ma;
    });
    const pick = [deep[TOTAL_SESSIONS - 1], deep[TOTAL_SESSIONS - 2]];
    const byFiles = await getJson(apiBase, `/api/sessions?files=${encodeURIComponent(pick.join(','))}`);
    const gotSet = new Set(byFiles.sessions.map((s) => s.file));
    report(
      'A5 files= fetches specific deep sessions without a page scan limit',
      byFiles.sessions.length === 2 && byFiles.total === 2 && pick.every((f) => gotSet.has(f)),
      `rows=${byFiles.sessions.length} total=${byFiles.total}`,
    );

    browser = await chromium.launch();
    browserRef.current = browser;
    const pinnedFile = deep[TOTAL_SESSIONS - 1];
    const pinnedId = encodeURIComponent(pinnedFile);
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(
      ([key, val]) => {
        window.localStorage.setItem(key, val);
      },
      ['sf-chat:pinned', JSON.stringify({ [pinnedId]: true })],
    );
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text()}`);
    });
    await page.goto(webBase, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(`${historyBody} .sf-pl-item`, { timeout: 60000 });
    await page.waitForFunction(
      ([sel]) => document.querySelectorAll(`${sel} .sf-pl-item`).length >= 50,
      [historyBody],
      { timeout: 30000 },
    );
    await delay(800);

    const initialRows = await sessionRows(page).count();
    const initialMore = await loadMoreRow(page).count();
    const moreText =
      (await loadMoreRow(page)
        .textContent()
        .catch(() => '')) ?? '';
    report(
      'U1 initial Chat History shows one page plus a Load older chats row',
      initialRows === PAGE_SIZE && initialMore === 1 && /10\s*more/.test(moreText),
      `rows=${initialRows} moreRow=${initialMore} text="${moreText.trim().slice(0, 60)}"`,
    );

    const pinnedCount = await page.locator(`${pinnedBody} .sf-pl-item`).count();
    const pinnedText =
      (await page
        .locator(`${pinnedBody} .sf-pl-item`)
        .first()
        .textContent()
        .catch(() => '')) ?? '';
    report(
      'U2 pinned chat beyond the first page is fetched and listed under Pinned',
      pinnedCount === 1 && pinnedText.includes('Pag-59'),
      `pinned=${pinnedCount} text="${pinnedText.trim().slice(0, 60)}"`,
    );

    await loadMoreRow(page).first().click();
    await page.waitForFunction(([sel]) => !document.querySelector(sel), [LOAD_MORE_SEL], { timeout: 15000 });
    const afterRows = await sessionRows(page).count();
    const afterPinned = await page.locator(`${pinnedBody} .sf-pl-item`).count();
    report(
      'U3 clicking Load older chats appends the remaining sessions (pinned one stays under Pinned)',
      afterRows === TOTAL_SESSIONS - 1 && afterPinned === 1,
      `rows=${afterRows} pinned=${afterPinned}`,
    );

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      ([sel]) => document.querySelectorAll(`${sel} .sf-pl-item`).length >= 50,
      [historyBody],
      { timeout: 30000 },
    );
    await delay(800);
    const reloadRows = await sessionRows(page).count();
    const reloadMore = await loadMoreRow(page).count();
    const reloadPinned = await page.locator(`${pinnedBody} .sf-pl-item`).count();
    const rowIds = await page.evaluate(
      ([histSel, pinSel]) => ({
        history: [...document.querySelectorAll(`${histSel} .sf-pl-item`)].map((el) =>
          el.getAttribute('data-id'),
        ),
        pinned: [...document.querySelectorAll(`${pinSel} .sf-pl-item`)].map((el) =>
          el.getAttribute('data-id'),
        ),
      }),
      [historyBody, pinnedBody],
    );
    const pag59InHistory = rowIds.history.filter((id) => id?.includes('Pag-59'));
    const uniqueIds = new Set(rowIds.history);
    report(
      'U4 after a reload pagination restarts from the first page, pins survive, no duplicate rows',
      reloadRows === PAGE_SIZE &&
        reloadMore === 1 &&
        reloadPinned === 1 &&
        pag59InHistory.length === 0 &&
        uniqueIds.size === rowIds.history.length,
      `rows=${reloadRows} moreRow=${reloadMore} pinned=${reloadPinned} pag59hist=${pag59InHistory.length} total=${rowIds.history.length} unique=${uniqueIds.size}`,
    );

    report('U5 no page errors during the run', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (e) {
    report('suite completed', false, String(e?.message ? e.message : e));
  } finally {
    if (browser) await browser.close().catch(() => {});
    for (const child of procs) killProc(child);
    await delay(500);
    for (const child of procs) killProc(child);
  }
  process.exit(isFailed() ? 1 : 0);
})();
