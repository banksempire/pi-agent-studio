const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { chromium } = createRequire(path.join(__dirname, '..', 'package.json'))('playwright');
const {
  assertMemoryHeadroom,
  installStackCleanup,
  spawnStackProc,
  sweepStaleStackProcesses,
} = require('./lib/suite-stack.cjs');

const PRODUCT_ROOT = path.join(__dirname, '..');
const STUB_SDK = path.join(PRODUCT_ROOT, 'scripts', 'lib', 'stub-sdk');
const RUN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'composer-height-'));
const SESSIONS_ROOT = path.join(RUN_ROOT, 'sessions');
const STUB_STATE_DIR = path.join(RUN_ROOT, 'stub-state');
const BACKEND_LOG = '/tmp/composer-height-backend.log';
const VITE_LOG = '/tmp/composer-height-vite.log';
const STAMP = `composer-height-suite-${Date.now()}`;
const TEST_CWD = '/tmp/composer-height-check';

const MARK_A = 'CHT-A composer height probe';
const MARK_B = 'CHT-B composer height probe';
const MIN_ONE_LINE = 30;
const MAX_ONE_LINE = 60;
const DESKTOP_CAP = 320;

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

function makeReporter() {
  let failed = false;
  const report = (name, ok, extra = '') => {
    console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
    if (!ok) failed = true;
  };
  return { report, isFailed: () => failed };
}

async function waitHttp(url, label, tries = 60) {
  for (let i = 0; i < tries; i++) {
    await delay(500);
    try {
      const code = await new Promise((resolve, reject) => {
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
      if (code === 200) return;
    } catch {}
  }
  throw new Error(`${label} did not come up`);
}

async function getJson(port, p) {
  const res = await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p }, (r) => {
      let raw = '';
      r.on('data', (c) => {
        raw += c;
      });
      r.on('end', () => resolve(JSON.parse(raw)));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
  return res;
}

function writeRelease() {
  fs.writeFileSync(path.join(STUB_STATE_DIR, 'release'), '1');
}

function removeRelease() {
  fs.rmSync(path.join(STUB_STATE_DIR, 'release'), { force: true });
}

async function waitIdle(port, file) {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await getJson(port, '/api/agent-states');
      const st = (r?.states ?? []).find((s) => s.agentId === file);
      if (st && st.status === 'idle') return true;
    } catch {}
    await delay(250);
  }
  return false;
}

function seedSession(dir, stamp, marker, reply) {
  const id = `019f${Math.random().toString(16).slice(2, 14)}`;
  const ts = 1786342000000 + stamp;
  const lines = [
    JSON.stringify({
      type: 'session',
      version: 3,
      id,
      parentId: null,
      timestamp: new Date(ts).toISOString(),
      cwd: TEST_CWD,
    }),
    JSON.stringify({
      type: 'message',
      id: `u${stamp}`,
      parentId: id,
      timestamp: new Date(ts + 60000).toISOString(),
      message: {
        role: 'user',
        content: [{ type: 'text', text: `${marker}: question` }],
        timestamp: ts + 60000,
      },
    }),
    JSON.stringify({
      type: 'message',
      id: `a${stamp}`,
      parentId: `u${stamp}`,
      timestamp: new Date(ts + 61000).toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `${marker}: ${reply}` }],
        timestamp: ts + 61000,
        stopReason: 'stop',
      },
    }),
  ];
  const file = `${new Date(ts).toISOString().replace(/[:.]/g, '-')}_cht-${stamp}-${id}.jsonl`;
  fs.writeFileSync(path.join(dir, file), `${lines.join('\n')}\n`);
}

(async () => {
  assertMemoryHeadroom({ label: 'composer-height' });
  sweepStaleStackProcesses(STAMP, { label: 'composer-height' });
  const { report, isFailed } = makeReporter();
  const procs = [];
  const browserRef = { current: null };
  installStackCleanup({ procs, stamp: STAMP, browserRef, label: 'composer-height' });
  let browser;
  try {
    const chatDir = path.join(SESSIONS_ROOT, '--composer-height--');
    fs.mkdirSync(chatDir, { recursive: true });
    fs.mkdirSync(STUB_STATE_DIR, { recursive: true });
    seedSession(chatDir, 1000, MARK_A, 'answer A');
    seedSession(chatDir, 2000, MARK_B, 'answer B');
    removeRelease();
    const backendPort = await freePort();
    const vitePort = await freePort();
    console.log(`stack: backend :${backendPort} vite :${vitePort} root ${RUN_ROOT}`);

    procs.push(
      spawnStackProc(spawn, STAMP, 'node', ['src/pi-studio/server/index.mjs'], {
        cwd: PRODUCT_ROOT,
        env: {
          ...process.env,
          PI_STUDIO_PORT: String(backendPort),
          PI_STUDIO_HOST: '127.0.0.1',
          PI_STUDIO_SESSIONS: SESSIONS_ROOT,
          PI_STUDIO_CWD: TEST_CWD,
          PI_STUDIO_DB_PATH: path.join(RUN_ROOT, 'studio.db'),
          PI_STUDIO_SPILL_PATH: path.join(RUN_ROOT, 'spill.json'),
          PI_STUDIO_STATES_PATH: path.join(RUN_ROOT, 'states.json'),
          PI_STUDIO_DRAIN_MS: '3000',
          PI_SDK_DIR: STUB_SDK,
          STUB_STATE_DIR,
        },
        stdio: ['ignore', fs.openSync(BACKEND_LOG, 'a'), fs.openSync(BACKEND_LOG, 'a')],
      }),
    );
    await waitHttp(`http://127.0.0.1:${backendPort}/api/health`, 'backend');
    procs.push(
      spawnStackProc(
        spawn,
        STAMP,
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
          stdio: ['ignore', fs.openSync(VITE_LOG, 'a'), fs.openSync(VITE_LOG, 'a')],
        },
      ),
    );
    await waitHttp(`http://127.0.0.1:${vitePort}/`, 'vite');

    browser = await chromium.launch();
    browserRef.current = browser;
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await page.goto(`http://127.0.0.1:${vitePort}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sf-pl-item', { timeout: 60000 });
    await delay(1200);

    const measure = () =>
      page.evaluate(() => {
        const inputs = [...document.querySelectorAll('.chat-input')].filter((el) => el.offsetParent !== null);
        const el = inputs[0];
        if (!el) return null;
        return {
          count: inputs.length,
          h: Math.round(el.getBoundingClientRect().height * 10) / 10,
          inline: el.style.height,
          overflowY: el.style.overflowY,
        };
      });
    const waitFor = async (fn, ms = 4000) => {
      const deadline = Date.now() + ms;
      let cur = null;
      while (Date.now() < deadline) {
        cur = await measure();
        if (cur && fn(cur)) return cur;
        await delay(150);
      }
      return cur;
    };

    await page.locator(`.sf-pl-item:has-text("${MARK_A}")`).first().click({ force: true });
    await page.waitForSelector('.chat-window', { timeout: 20000 });
    const base = await waitFor((s) => s.h >= MIN_ONE_LINE && s.h <= MAX_ONE_LINE);
    report(
      'one-line base height (CSS rule)',
      !!base && base.count === 1 && base.h >= MIN_ONE_LINE && base.h <= MAX_ONE_LINE,
      JSON.stringify(base),
    );

    const LINES_40 = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
    await page.locator('.chat-input:visible').fill(LINES_40);
    const grown = await waitFor((s) => s.h > 200);
    report(
      'desktop auto-grow caps at 320px',
      !!grown && grown.h > 200 && grown.h <= DESKTOP_CAP + 2,
      JSON.stringify(grown),
    );
    report(
      'capped box scrolls (overflow-y auto)',
      grown?.overflowY === 'auto',
      `overflowY=${grown?.overflowY}`,
    );

    await page.locator('.chat-input:visible').fill('');
    const shrunk = await waitFor((s) => s.h <= MAX_ONE_LINE);
    report(
      'clearing input shrinks back to one line',
      !!shrunk && shrunk.h >= 0 && shrunk.h <= MAX_ONE_LINE,
      JSON.stringify(shrunk),
    );

    await page.locator(`.sf-pl-item:has-text("${MARK_B}")`).first().click({ force: true });
    await page
      .waitForSelector(`.sf-tab-label:has-text("${MARK_B.slice(0, 5)}")`, { timeout: 20000 })
      .catch(() => {});
    await delay(800);
    const tabLabels = await page.locator('.sf-tab-label').allInnerTexts();
    report('two chat tabs exist (first is parked)', tabLabels.length >= 2, JSON.stringify(tabLabels));

    await page.setViewportSize({ width: 1000, height: 800 });
    await delay(800);
    await page.setViewportSize({ width: 1440, height: 900 });
    await delay(400);

    const aTab = page.locator('.sf-tab-label', { hasText: MARK_A.slice(0, 5) }).first();
    await aTab.click({ force: true });
    await delay(600);
    const revived = await waitFor((s) => s.h > 0, 4000);
    report(
      'parked tab keeps composer height across background resizes (regression)',
      !!revived && revived.h >= MIN_ONE_LINE && revived.h <= MAX_ONE_LINE,
      JSON.stringify(revived),
    );

    const handleBox = async () => {
      const b = await page.locator('.chat-composer-handle:visible').first().boundingBox();
      if (!b) throw new Error('composer handle not visible');
      return b;
    };
    let hb = await handleBox();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 - 400, { steps: 12 });
    await page.mouse.up();
    await delay(300);
    const draggedUp = await measure();
    report(
      'drag up clamps at the 320px max',
      !!draggedUp && draggedUp.h > 100 && draggedUp.h <= DESKTOP_CAP + 2,
      JSON.stringify(draggedUp),
    );

    hb = await handleBox();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + 600, { steps: 12 });
    await page.mouse.up();
    await delay(300);
    const draggedDown = await measure();
    report(
      'drag down clamps at the one-line min',
      !!draggedDown && draggedDown.h >= MIN_ONE_LINE - 4 && draggedDown.h <= MAX_ONE_LINE,
      JSON.stringify(draggedDown),
    );

    await handleBox().then(async (b) => {
      await page.mouse.dblclick(b.x + b.width / 2, b.y + b.height / 2, { force: true });
    });
    await delay(300);
    const reset = await waitFor((s) => s.h <= MAX_ONE_LINE, 3000);
    report(
      'double-click resets the dragged height',
      !!reset && reset.h <= MAX_ONE_LINE,
      JSON.stringify(reset),
    );

    const LINES_3 = 'height probe send line1\nline2\nline3';
    await page.locator('.chat-input:visible').fill(LINES_3);
    const mid = await waitFor((s) => s.h > MAX_ONE_LINE && s.h < DESKTOP_CAP);
    report(
      'typing grows the box with content',
      !!mid && mid.h >= 70 && mid.h < DESKTOP_CAP,
      JSON.stringify(mid),
    );

    await page.locator('.chat-input:visible').press('Enter');
    const afterSend = await waitFor((s) => s.h <= MAX_ONE_LINE, 6000);
    report(
      'sending clears and shrinks the composer',
      !!afterSend && afterSend.h >= 0 && afterSend.h <= MAX_ONE_LINE,
      JSON.stringify(afterSend),
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await delay(600);
    const LINES_20 = Array.from({ length: 20 }, (_, i) => `m ${i + 1}`).join('\n');
    await page.locator('.chat-input:visible').fill(LINES_20);
    const mob = await waitFor((s) => s.h > 60, 4000);
    report('mobile auto-grow caps at 120px', !!mob && mob.h > 60 && mob.h <= 122, JSON.stringify(mob));

    await page.setViewportSize({ width: 1440, height: 900 });
    await delay(600);
    const bTab = page.locator('.sf-tab-label', { hasText: MARK_B.slice(0, 5) }).first();
    await bTab.click({ force: true });
    await delay(600);
    const revivedB = await waitFor((s) => s.h > 0, 4000);
    report(
      'second parked tab keeps composer height across resizes (regression)',
      !!revivedB && revivedB.h >= MIN_ONE_LINE && revivedB.h <= MAX_ONE_LINE,
      JSON.stringify(revivedB),
    );

    writeRelease();
    let idleA = false;
    for (let i = 0; i < 40 && !idleA; i++) {
      const r = await getJson(backendPort, '/api/sessions?limit=50').catch(() => null);
      const hit = (r?.sessions ?? []).find((x) => x.firstMessage.includes('height probe send'));
      if (hit) idleA = await waitIdle(backendPort, hit.file);
      else await delay(250);
    }
    report('sent probe settles after release', idleA);

    report('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
  } catch (e) {
    report('suite completed', false, String(e?.message ?? e));
  } finally {
    try {
      await browser?.close();
    } catch {}
    for (const p of procs) {
      if (!p || p.exitCode !== null) continue;
      try {
        p.kill('SIGTERM');
      } catch {}
    }
    fs.rmSync(RUN_ROOT, { recursive: true, force: true });
  }
  process.exit(isFailed() ? 1 : 0);
})().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
