const { spawn } = require('node:child_process');
const fs = require('node:fs');
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
const RUN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-resources-'));
const SESSIONS_ROOT = path.join(RUN_ROOT, 'sessions');
const STUB_STATE_DIR = path.join(RUN_ROOT, 'stub-state');
const BACKEND_LOG = '/tmp/tab-resources-backend.log';
const VITE_LOG = '/tmp/tab-resources-vite.log';
const STAMP = `tab-resources-suite-${Date.now()}`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = require('node:net').createServer();
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
        const req = require('node:http').get(url, (r) => {
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

(async () => {
  assertMemoryHeadroom({ label: 'tab-resources' });
  sweepStaleStackProcesses(STAMP, { label: 'tab-resources' });
  const { report, isFailed } = makeReporter();
  const procs = [];
  const browserRef = { current: null };
  installStackCleanup({ procs, stamp: STAMP, browserRef, label: 'tab-resources' });
  let browser;
  try {
    fs.mkdirSync(SESSIONS_ROOT, { recursive: true });
    fs.mkdirSync(path.join(SESSIONS_ROOT, '--workspace-sf--'), { recursive: true });
    fs.mkdirSync(STUB_STATE_DIR, { recursive: true });
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
          PI_STUDIO_CWD: RUN_ROOT,
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

    const signals = { open: [], close: [] };
    page.on('request', (req) => {
      if (req.method() !== 'POST') return;
      const url = req.url();
      const kind = url.includes('/api/events/open')
        ? 'open'
        : url.includes('/api/events/close')
          ? 'close'
          : null;
      if (!kind) return;
      try {
        const body = JSON.parse(req.postData() ?? '{}');
        for (const file of body.files ?? []) signals[kind].push(file);
      } catch {}
    });

    await page.goto(`http://127.0.0.1:${vitePort}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.welcome-d-cta', { timeout: 60000 });
    report('no view stream subscriptions before any tab opens', signals.open.length === 0);

    await page.click('.welcome-d-cta');
    await page.waitForSelector('.chat-window', { timeout: 20000 });

    let openedFile = null;
    for (let i = 0; i < 40 && openedFile === null; i++) {
      if (signals.open.length > 0) openedFile = signals.open[0];
      else await delay(250);
    }
    report(
      'opening a chat tab subscribes its session stream exactly once',
      signals.open.length === 1 && openedFile !== null,
      JSON.stringify(signals.open),
    );

    await page.waitForTimeout(1500);
    await page.locator('.sf-tab-label').first().click();
    await page.waitForTimeout(500);
    report(
      'activating tabs does not re-subscribe the stream',
      signals.open.length === 1,
      JSON.stringify(signals.open),
    );

    await page.locator('.sf-tab', { hasText: 'New Chat' }).first().click({ button: 'middle' });
    await page.waitForTimeout(400);

    let closed = false;
    for (let i = 0; i < 40 && !closed; i++) {
      closed = signals.close.includes(openedFile);
      if (!closed) await delay(250);
    }
    report(
      'closing the tab unsubscribes its session stream exactly once',
      signals.close.length === 1 && closed,
      JSON.stringify(signals.close),
    );
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
